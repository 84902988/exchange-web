import {
  normalizeDepthForDisplay,
  normalizeSpotMarketViewDepthDomain,
} from '../useSpotMarket'
import { parseSpotPrivateWsMessage } from '../spotPrivateWs'
import {
  pairMatchesSpotSelectorCategory,
  pairMatchesSpotSelectorSearch,
  type GlobalMarketSelectorPair,
} from '../GlobalMarketSelector'
import {
  getBarsContinuityStats,
  inspectCurrentKlineCache,
  shouldRejectKlineContinuity,
  writeCurrentKlineCache,
  type SpotTradingViewBar,
} from '../tradingview/spotKlineClientCache'

describe('spot standard exchange semantics', () => {
  const internalCryptoSpotPair: GlobalMarketSelectorPair = {
    symbol: 'MFCUSDT',
    displaySymbol: 'MFC/USDT',
    baseAsset: 'MFC',
    quoteAsset: 'USDT',
    assetType: 'CRYPTO',
    dataSource: 'INTERNAL',
    marketCategory: 'CRYPTO',
    displayCategory: null,
  }

  const rwaSpotPair: GlobalMarketSelectorPair = {
    symbol: 'BON-2USDT',
    displaySymbol: 'BON-2/USDT',
    baseAsset: 'BON-2',
    quoteAsset: 'USDT',
    assetType: 'CRYPTO',
    dataSource: 'INTERNAL',
    marketCategory: 'CRYPTO',
    displayCategory: 'RWA',
  }

  it('keeps RWA spot pairs isolated from the regular spot selector category', () => {
    expect(pairMatchesSpotSelectorCategory(rwaSpotPair, 'spot')).toBe(false)
    expect(pairMatchesSpotSelectorCategory(rwaSpotPair, 'rwa')).toBe(true)
    expect(pairMatchesSpotSelectorCategory(
      {
        ...rwaSpotPair,
        assetType: 'RWA',
        displayCategory: null,
      },
      'rwa',
    )).toBe(true)
  })

  it('keeps enabled internal crypto spot pairs visible in the regular spot selector category', () => {
    expect(pairMatchesSpotSelectorCategory(internalCryptoSpotPair, 'spot')).toBe(true)
  })

  it('searches spot selector pairs by compact and slash display symbols', () => {
    expect(pairMatchesSpotSelectorSearch(internalCryptoSpotPair, 'MFCUSDT')).toBe(true)
    expect(pairMatchesSpotSelectorSearch(internalCryptoSpotPair, 'MFC/USDT')).toBe(true)
    expect(pairMatchesSpotSelectorSearch(internalCryptoSpotPair, 'mfc')).toBe(true)
    expect(pairMatchesSpotSelectorSearch(internalCryptoSpotPair, 'usdt')).toBe(true)
    expect(pairMatchesSpotSelectorSearch(rwaSpotPair, 'BON')).toBe(true)
  })

  it('clears old depth levels when backend marks depth missing', () => {
    const depth = normalizeDepthForDisplay(
      {
        symbol: 'MFCUSDT',
        bids: [{ price: '10.000', amount: '2.000' }],
        asks: [],
        source: 'LAST_GOOD',
        freshness: 'LAST_GOOD',
      },
      {
        status: 'missing',
      },
    )

    expect(depth?.bids).toEqual([])
    expect(depth?.asks).toEqual([])
    expect(depth?.source).toBe('LAST_GOOD')
    expect(depth?.freshness).toBe('LAST_GOOD')
  })

  it('normalizes empty market view depth without executable BBO prices', () => {
    const view = normalizeSpotMarketViewDepthDomain({
      symbol: 'MFCUSDT',
      best_bid: '10.000',
      best_ask: '10.000',
      orderbook_mid_price: '10.000',
      depth_status: 'missing',
      depth_source: 'MISSING',
      depth_freshness: 'MISSING',
      depth: {
        symbol: 'MFCUSDT',
        bids: [],
        asks: [],
        source: 'MISSING',
        freshness: 'MISSING',
      },
    })

    expect(view.depth?.bids).toEqual([])
    expect(view.depth?.asks).toEqual([])
    expect(view.best_bid).toBeNull()
    expect(view.best_ask).toBeNull()
    expect(view.orderbook_mid_price).toBeNull()
    expect(view.depth_status).toBe('missing')
  })

  it('handles private websocket ping without JSON parsing', () => {
    const sendPong = jest.fn()

    expect(parseSpotPrivateWsMessage('ping', { sendPong })).toBeNull()
    expect(sendPong).toHaveBeenCalledTimes(1)
  })

  it('keeps parsing private websocket JSON messages', () => {
    expect(parseSpotPrivateWsMessage('{"type":"spot_user_orders_snapshot","items":[]}')).toEqual({
      type: 'spot_user_orders_snapshot',
      items: [],
    })
  })

  const buildBar = (time: number, close = 1): SpotTradingViewBar => ({
    time,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1,
  })

  it('allows internal sparse 1Dutc bars without treating natural gaps as kline errors', () => {
    const bars = [
      buildBar(Date.UTC(2026, 0, 1), 1),
      buildBar(Date.UTC(2026, 0, 3), 1.2),
    ]
    const continuityStats = getBarsContinuityStats(bars, '1Dutc')

    expect(continuityStats.gapCount).toBe(1)
    expect(continuityStats.duplicateCount).toBe(0)
    expect(continuityStats.outOfOrderCount).toBe(0)
    expect(continuityStats.invalidOhlcCount).toBe(0)
    expect(shouldRejectKlineContinuity({
      interval: '1Dutc',
      source: 'INTERNAL',
      bars,
      continuityStats,
    })).toBe(false)
  })

  it('allows internal sparse 1Wutc bars without treating natural gaps as kline errors', () => {
    const bars = [
      buildBar(Date.UTC(2026, 0, 5), 1),
      buildBar(Date.UTC(2026, 0, 19), 1.2),
    ]
    const continuityStats = getBarsContinuityStats(bars, '1Wutc')

    expect(continuityStats.gapCount).toBe(1)
    expect(shouldRejectKlineContinuity({
      interval: '1Wutc',
      source: 'INTERNAL',
      bars,
      continuityStats,
    })).toBe(false)
  })

  it('keeps rejecting external 1Dutc bars with continuity gaps', () => {
    const bars = [
      buildBar(Date.UTC(2026, 0, 1), 1),
      buildBar(Date.UTC(2026, 0, 3), 1.2),
    ]

    expect(shouldRejectKlineContinuity({
      interval: '1Dutc',
      source: 'REST_SNAPSHOT',
      bars,
      continuityStats: getBarsContinuityStats(bars, '1Dutc'),
    })).toBe(true)
  })

  it('keeps rejecting duplicate sparse bars instead of hiding hard data errors', () => {
    const bars = [
      buildBar(Date.UTC(2026, 0, 1), 1),
      buildBar(Date.UTC(2026, 0, 1), 1.2),
    ]

    expect(shouldRejectKlineContinuity({
      interval: '1Dutc',
      source: 'INTERNAL',
      bars,
      continuityStats: getBarsContinuityStats(bars, '1Dutc'),
    })).toBe(true)
  })

  it('keeps rejecting invalid OHLC sparse bars instead of hiding hard data errors', () => {
    const bars = [
      {
        time: Date.UTC(2026, 0, 1),
        open: 10,
        high: 9,
        low: 8,
        close: 10,
        volume: 1,
      },
      buildBar(Date.UTC(2026, 0, 3), 1.2),
    ]

    expect(shouldRejectKlineContinuity({
      interval: '1Dutc',
      source: 'INTERNAL',
      bars,
      continuityStats: getBarsContinuityStats(bars, '1Dutc'),
    })).toBe(true)
  })

  it('allows L1 cache hits for valid internal sparse D/W/M bars', () => {
    const symbol = `SPARSE${Date.now()}USDT`
    const bars = [
      buildBar(Date.UTC(2026, 0, 1), 1),
      buildBar(Date.UTC(2026, 0, 3), 1.2),
    ]

    expect(writeCurrentKlineCache({
      symbol,
      interval: '1Dutc',
      limit: 2,
      bars,
      source: 'INTERNAL',
    })).not.toBeNull()
    expect(inspectCurrentKlineCache(symbol, '1Dutc', 2).reason).toBe('hit')
  })
})
