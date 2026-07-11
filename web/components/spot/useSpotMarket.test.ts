import { beforeEach, describe, expect, it, jest } from '@jest/globals'
import { act, renderHook, waitFor } from '@testing-library/react'
import {
  getSpotMarketView,
  type SpotMarketTradeItem,
  type SpotMarketView,
} from '@/lib/api/modules/spot'
import { spotMarketRealtime } from '@/services/marketRealtime'
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
  subscribeStatus: jest.Mock
  subscribe: jest.Mock
}
const mockRealtimeListeners = mockSpotMarketRealtime.__listeners

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
  mockRealtimeListeners.clear()
  mockedGetSpotMarketView.mockReset()
  mockSpotMarketRealtime.acquireSubscription.mockClear()
  mockSpotMarketRealtime.releaseSubscription.mockClear()
  mockSpotMarketRealtime.subscribe.mockClear()
  mockSpotMarketRealtime.subscribeStatus.mockClear()
})

describe('useSpotMarket trade collection', () => {
  it('keeps WS authority while merging late REST history and ignores duplicate price side effects', async () => {
    const pendingView = deferred<SpotMarketView>()
    mockedGetSpotMarketView.mockReturnValueOnce(pendingView.promise)
    const { result } = renderHook(() => useSpotMarket('BTCUSDT'))

    await waitFor(() => expect(mockSpotMarketRealtime.acquireSubscription).toHaveBeenCalled())
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
