import { beforeEach, describe, expect, it, jest } from '@jest/globals'
import { act, renderHook, waitFor } from '@testing-library/react'
import {
  getSpotMarketView,
  type SpotDepthResponse,
  type SpotMarketTradeItem,
  type SpotMarketView,
} from '@/lib/api/modules/spot'
import { spotMarketRealtime } from '@/services/marketRealtime'
import { spotPublicMarketStore } from '@/lib/realtime/spotMarketStore'
import {
  attachSpotMarketStoreTransportMirror,
  type SpotMarketMirrorTransport,
} from '@/lib/realtime/spotMarketStore.transport'
import { resetSpotTradesStoreAdapterForTests } from './spotTradesStoreAdapter'
import { useSpotMarket } from './useSpotMarket'

type RealtimeHandler = (message: Record<string, unknown>) => void

jest.mock('@/services/marketRealtime', () => ({
  spotMarketRealtime: (() => {
    const listeners = new Map<string, Set<RealtimeHandler>>()
    return {
      __listeners: listeners,
      acquireSubscription: jest.fn(() => 'test-subscription'),
      releaseSubscription: jest.fn(),
      subscribeStatus: jest.fn((handler: (status: string) => void) => {
        handler('open')
        return () => undefined
      }),
      subscribe: jest.fn((domain: string, handler: RealtimeHandler) => {
        const domainListeners = listeners.get(domain) || new Set<RealtimeHandler>()
        domainListeners.add(handler)
        listeners.set(domain, domainListeners)
        return () => domainListeners.delete(handler)
      }),
    }
  })(),
}))

jest.mock('@/lib/marketCache', () => ({
  writeMarketCache: jest.fn(),
}))

jest.mock('@/lib/api/modules/spot', () => {
  const actual = jest.requireActual<typeof import('@/lib/api/modules/spot')>('@/lib/api/modules/spot')
  return {
    ...actual,
    getSpotMarketView: jest.fn(),
  }
})

const BASE = 1_720_000_000_000
const mockedGetSpotMarketView = getSpotMarketView as jest.MockedFunction<typeof getSpotMarketView>
const mockSpotMarketRealtime = spotMarketRealtime as unknown as {
  __listeners: Map<string, Set<RealtimeHandler>>
  acquireSubscription: jest.Mock
  releaseSubscription: jest.Mock
  subscribeStatus: jest.Mock<(handler: (status: string) => void) => () => void>
  subscribe: jest.Mock
}
const mockRealtimeListeners = mockSpotMarketRealtime.__listeners
let detachTickerStoreMirror: (() => void) | null = null

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function emit(domain: string, message: Record<string, unknown>) {
  for (const handler of mockRealtimeListeners.get(domain) || []) handler(message)
}

function providerTrade(options: {
  id?: string | null
  provider?: string
  providerSymbol?: string
  eventTimeMs?: number | null
  receivedAtMs?: number
  price?: string
  amount?: string
  side?: string
  ts?: number
}): SpotMarketTradeItem {
  const id = options.id === undefined ? 'trade' : options.id
  return {
    id,
    trade_id: id,
    provider_trade_id: id,
    provider: options.provider || 'OKX_SPOT',
    provider_symbol: options.providerSymbol || 'BTC-USDT',
    event_time_ms: options.eventTimeMs === undefined ? BASE : options.eventTimeMs,
    received_at_ms: options.receivedAtMs ?? BASE + 100,
    price: options.price || '100',
    amount: options.amount || '1',
    side: options.side || 'BUY',
    ts: options.ts ?? options.eventTimeMs ?? BASE,
    source: 'LIVE_WS',
    freshness: 'LIVE',
    time_origin: 'PROVIDER',
  }
}

function tradeMessage(trade: SpotMarketTradeItem) {
  return {
    type: 'spot_trade',
    symbol: 'BTCUSDT',
    provider: trade.provider,
    provider_symbol: trade.provider_symbol,
    source: trade.source,
    freshness: trade.freshness,
    received_at_ms: trade.received_at_ms,
    trade,
  }
}

function marketView(symbol: string, trades: SpotMarketTradeItem[]): SpotMarketView {
  return {
    symbol,
    trades: {
      symbol,
      provider: 'OKX_SPOT',
      provider_symbol: 'BTC-USDT',
      source: 'REST',
      freshness: 'RECENT',
      received_at_ms: BASE + 10_000,
      trades,
    },
    trades_source: 'REST',
    trades_freshness: 'RECENT',
  }
}

beforeEach(() => {
  detachTickerStoreMirror?.()
  detachTickerStoreMirror = null
  mockRealtimeListeners.clear()
  mockedGetSpotMarketView.mockReset()
  mockSpotMarketRealtime.acquireSubscription.mockClear()
  mockSpotMarketRealtime.releaseSubscription.mockClear()
  mockSpotMarketRealtime.subscribe.mockClear()
  mockSpotMarketRealtime.subscribeStatus.mockClear()
  spotPublicMarketStore.resetForTests()
  resetSpotTradesStoreAdapterForTests(spotPublicMarketStore)
  detachTickerStoreMirror = attachSpotMarketStoreTransportMirror(
    mockSpotMarketRealtime as unknown as SpotMarketMirrorTransport,
    spotPublicMarketStore,
  )
})

describe('useSpotMarket trade collection', () => {
  it('keeps WS authority while merging late REST history and ignores duplicate price side effects', async () => {
    const pendingView = deferred<SpotMarketView>()
    mockedGetSpotMarketView.mockReturnValueOnce(pendingView.promise)
    const { result } = renderHook(() => useSpotMarket('BTCUSDT'))

    await waitFor(() => expect(mockSpotMarketRealtime.acquireSubscription).toHaveBeenCalled())
    const tradeListenerCount = mockSpotMarketRealtime.subscribe.mock.calls
      .filter(([domain]) => domain === 'trade')
      .length
    expect(tradeListenerCount).toBe(1)
    const wsTrade = providerTrade({ id: 'ws', eventTimeMs: BASE + 2_000, price: '200' })
    act(() => emit('trade', tradeMessage(wsTrade)))
    await waitFor(() => expect(result.current.trades.map((row) => row.provider_trade_id)).toEqual(['ws']))
    expect(result.current.displayPrice.price).toBe('200')

    const history = providerTrade({ id: 'history', eventTimeMs: BASE + 1_000, price: '100' })
    const untimed = providerTrade({
      id: 'untimed',
      eventTimeMs: null,
      receivedAtMs: BASE + 99_999,
      price: '999',
      ts: BASE + 999_999,
    })
    await act(async () => pendingView.resolve(marketView('BTCUSDT', [history, untimed])))
    await waitFor(() => expect(result.current.trades.map((row) => row.provider_trade_id)).toEqual([
      'ws', 'history', 'untimed',
    ]))
    expect(result.current.displayPrice.price).toBe('200')
    expect(result.current.lastTradePrice).toBe('200')

    const duplicate = { ...wsTrade, price: '777', received_at_ms: BASE + 20_000 }
    act(() => emit('trade', tradeMessage(duplicate)))
    await waitFor(() => expect(result.current.trades).toHaveLength(3))
    expect(result.current.displayPrice.price).toBe('200')
    expect(result.current.lastTradePrice).toBe('200')
  })

  it('preserves weak occurrences and clears rows across provider and symbol switches', async () => {
    mockedGetSpotMarketView.mockImplementation(async (symbol) => ({ symbol } as SpotMarketView))
    const { result, rerender } = renderHook(
      ({ symbol }) => useSpotMarket(symbol),
      { initialProps: { symbol: 'BTCUSDT' } },
    )
    await waitFor(() => expect(mockSpotMarketRealtime.acquireSubscription).toHaveBeenCalled())

    const weak = providerTrade({ id: null, eventTimeMs: BASE + 1_000, receivedAtMs: BASE + 500 })
    act(() => {
      emit('trade', tradeMessage(weak))
      emit('trade', tradeMessage({ ...weak }))
    })
    await waitFor(() => expect(result.current.trades).toHaveLength(2))

    const bitget = providerTrade({
      id: 'bitget',
      provider: 'BITGET_SPOT',
      providerSymbol: 'BTCUSDT',
      eventTimeMs: BASE + 2_000,
      price: '300',
    })
    act(() => emit('trade', tradeMessage(bitget)))
    await waitFor(() => expect(result.current.trades.map((row) => row.provider_trade_id)).toEqual(['bitget']))

    rerender({ symbol: 'ETHUSDT' })
    await waitFor(() => expect(result.current.symbol).toBe('ETHUSDT'))
    expect(result.current.trades).toEqual([])
    expect(result.current.lastTradePrice).toBeNull()
  })
})

describe('useSpotMarket hydration', () => {
  it('keeps a REST snapshot in hydration until a LIVE_WS ticker arrives', async () => {
    mockedGetSpotMarketView.mockResolvedValueOnce({
      symbol: 'BTCUSDT',
      ticker: {
        symbol: 'BTCUSDT',
        last_price: '100',
        source: 'REST_SNAPSHOT',
        freshness: 'RECENT',
      },
      ticker_source: 'REST_SNAPSHOT',
      ticker_freshness: 'RECENT',
    } as SpotMarketView)

    const { result } = renderHook(() => useSpotMarket('BTCUSDT'))

    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.displayPrice.price).toBe('100')
    expect(result.current.isHydrating).toBe(true)

    act(() => emit('ticker', {
      type: 'spot_ticker_update',
      symbol: 'BTCUSDT',
      ticker: {
        symbol: 'BTCUSDT',
        last_price: '101',
        source: 'LIVE_WS',
        freshness: 'LIVE',
      },
    }))

    await waitFor(() => expect(result.current.isHydrating).toBe(false))
    expect(result.current.displayPrice.price).toBe('101')
  })

  it('keeps loading after REST failure until WS also closes', async () => {
    let emitStatus: ((status: string) => void) | null = null
    mockSpotMarketRealtime.subscribeStatus.mockImplementationOnce((handler: (status: string) => void) => {
      emitStatus = handler
      handler('connecting')
      return () => undefined
    })
    mockedGetSpotMarketView.mockRejectedValueOnce(new Error('REST unavailable'))

    const { result } = renderHook(() => useSpotMarket('BTCUSDT'))

    await waitFor(() => expect(result.current.error).toBe('REST unavailable'))
    expect(result.current.isHydrating).toBe(true)

    act(() => emitStatus?.('closed'))

    await waitFor(() => expect(result.current.isHydrating).toBe(false))
    expect(result.current.displayPrice.price).toBeNull()
  })
})

describe('useSpotMarket depth store migration', () => {
  it('consumes REST and LIVE_WS depth from the store without a direct depth listener', async () => {
    const restDepth = {
      symbol: 'BTCUSDT',
      provider: 'BINANCE',
      source: 'REST_SNAPSHOT',
      freshness: 'RECENT',
      event_time_ms: BASE + 1_000,
      provider_generation: 2,
      sequence: 10,
      checksum: 'rest-checksum',
      bids: [{ price: '99', amount: '1' }],
      asks: [{ price: '101', amount: '2' }],
    } as SpotDepthResponse & {
      provider_generation: number
      sequence: number
      checksum: string
    }
    mockedGetSpotMarketView.mockResolvedValueOnce({
      symbol: 'BTCUSDT',
      market_status: 'OPEN',
      depth: restDepth,
      depth_source: 'REST_SNAPSHOT',
      depth_freshness: 'RECENT',
    } as SpotMarketView)

    const { result } = renderHook(() => useSpotMarket('BTCUSDT'))

    await waitFor(() => expect(result.current.depth?.bids[0].price).toBe('99'))
    expect(result.current.freshness.depth).toBe('RECENT')
    expect(result.current.sources.depth).toBe('REST_SNAPSHOT')
    expect((result.current.depth as typeof restDepth).sequence).toBe(10)
    expect((result.current.depth as typeof restDepth).checksum).toBe('rest-checksum')
    expect(result.current.bestBid).toBe('99')
    expect(result.current.bestAsk).toBe('101')

    const depthListenerCount = mockSpotMarketRealtime.subscribe.mock.calls
      .filter(([domain]) => domain === 'depth')
      .length
    expect(depthListenerCount).toBe(1)

    const liveDepth = {
      ...restDepth,
      source: 'LIVE_WS',
      freshness: 'LIVE',
      event_time_ms: BASE + 2_000,
      sequence: 11,
      checksum: 'live-checksum',
      bids: [{ price: '100', amount: '3' }],
      asks: [{ price: '102', amount: '4' }],
    }
    act(() => emit('depth', {
      type: 'spot_depth_update',
      symbol: 'BTCUSDT',
      depth: liveDepth,
    }))

    await waitFor(() => expect(result.current.depth?.bids[0].price).toBe('100'))
    expect(result.current.freshness.depth).toBe('LIVE')
    expect(result.current.sources.depth).toBe('LIVE_WS')
    expect((result.current.depth as typeof liveDepth).sequence).toBe(11)
    expect((result.current.depth as typeof liveDepth).checksum).toBe('live-checksum')
    expect(result.current.bestBid).toBe('100')
    expect(result.current.bestAsk).toBe('102')
    expect(result.current.marketView?.executable).toBe(true)
  })

  it('keeps stale depth non-executable and clears display levels', async () => {
    mockedGetSpotMarketView.mockResolvedValueOnce({
      symbol: 'BTCUSDT',
      market_status: 'OPEN',
      depth: {
        symbol: 'BTCUSDT',
        provider: 'BINANCE',
        source: 'LAST_GOOD',
        freshness: 'STALE',
        stale: true,
        bids: [{ price: '99', amount: '1' }],
        asks: [{ price: '101', amount: '2' }],
      },
      depth_source: 'LAST_GOOD',
      depth_freshness: 'STALE',
    } as SpotMarketView)

    const { result } = renderHook(() => useSpotMarket('BTCUSDT'))

    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.depth?.bids).toEqual([])
    expect(result.current.depth?.asks).toEqual([])
    expect(result.current.freshness.depth).toBe('STALE')
    expect(result.current.sources.depth).toBe('LAST_GOOD')
    expect(result.current.bestBid).toBeNull()
    expect(result.current.bestAsk).toBeNull()
    expect(result.current.marketView?.executable).toBe(false)
  })
})
