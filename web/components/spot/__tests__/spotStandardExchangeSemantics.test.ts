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

describe('spot standard exchange semantics', () => {
  const internalSpotPair: GlobalMarketSelectorPair = {
    symbol: 'MFCUSDT',
    displaySymbol: 'MFC/USDT',
    baseAsset: 'MFC',
    quoteAsset: 'USDT',
    assetType: 'RWA',
    dataSource: 'INTERNAL',
    marketCategory: 'CRYPTO',
    displayCategory: 'RWA',
  }

  it('keeps enabled internal spot pairs visible in the spot selector category', () => {
    expect(pairMatchesSpotSelectorCategory(internalSpotPair, 'spot')).toBe(true)
    expect(pairMatchesSpotSelectorCategory(internalSpotPair, 'rwa')).toBe(true)
    expect(pairMatchesSpotSelectorCategory(
      {
        ...internalSpotPair,
        displayCategory: null,
      },
      'rwa',
    )).toBe(true)
  })

  it('searches spot selector pairs by compact and slash display symbols', () => {
    expect(pairMatchesSpotSelectorSearch(internalSpotPair, 'MFCUSDT')).toBe(true)
    expect(pairMatchesSpotSelectorSearch(internalSpotPair, 'MFC/USDT')).toBe(true)
    expect(pairMatchesSpotSelectorSearch(internalSpotPair, 'mfc')).toBe(true)
    expect(pairMatchesSpotSelectorSearch(internalSpotPair, 'usdt')).toBe(true)
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
})
