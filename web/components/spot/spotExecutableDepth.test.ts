import { describe, expect, it } from '@jest/globals';
import { sequenceSpotMarketDomainEvent } from './spotMarketDomainSequencer';
import {
  resolveSpotExecutableDepth,
  resolveSpotOrderDepthInteraction,
  type SpotExecutableDepthInput,
} from './spotExecutableDepth';

function depthInput(
  overrides: Partial<SpotExecutableDepthInput> = {},
): SpotExecutableDepthInput {
  return {
    currentSymbol: 'BTCUSDT',
    depthSymbol: 'BTCUSDT',
    bestBid: '100',
    bestAsk: '101',
    depthSource: 'LIVE_WS',
    depthFreshness: 'LIVE',
    depthStatus: 'LIVE',
    depthStale: false,
    dataSource: 'OKX_SPOT',
    isLoading: false,
    isSwitchingSymbol: false,
    marketStatus: 'OPEN',
    pairMarketStatus: 'OPEN',
    pairEnabled: true,
    pairStatus: 1,
    ...overrides,
  };
}

describe('spot executable depth', () => {
  it('enables both market directions and BBO controls for a fresh two-sided book', () => {
    const state = resolveSpotExecutableDepth(depthInput());

    expect(state).toMatchObject({
      isCurrentSymbol: true,
      freshnessKind: 'fresh',
      hasFreshBid: true,
      hasFreshAsk: true,
      hasFreshTwoSidedBook: true,
      buyMarketExecutable: true,
      sellMarketExecutable: true,
      buyBboAvailable: true,
      sellBboAvailable: true,
      buyReferencePrice: '101',
      sellReferencePrice: '100',
      rejectReason: null,
    });
  });

  it('keeps only MARKET BUY and buy-side BBO available for a fresh ask-only book', () => {
    const state = resolveSpotExecutableDepth(depthInput({ bestBid: null }));

    expect(state.buyMarketExecutable).toBe(true);
    expect(state.buyReferencePrice).toBe('101');
    expect(state.sellMarketExecutable).toBe(false);
    expect(state.sellBboAvailable).toBe(false);
    expect(state.sellReferencePrice).toBeNull();
    expect(state.sellRejectReason).toBe('MISSING_BID');
  });

  it('keeps only MARKET SELL and sell-side BBO available for a fresh bid-only book', () => {
    const state = resolveSpotExecutableDepth(depthInput({ bestAsk: null }));

    expect(state.sellMarketExecutable).toBe(true);
    expect(state.sellReferencePrice).toBe('100');
    expect(state.buyMarketExecutable).toBe(false);
    expect(state.buyBboAvailable).toBe(false);
    expect(state.buyReferencePrice).toBeNull();
    expect(state.buyRejectReason).toBe('MISSING_ASK');
  });

  it('rejects stale two-sided depth and removes both old BBO references', () => {
    const state = resolveSpotExecutableDepth(depthInput({
      depthFreshness: 'STALE',
      depthStale: true,
    }));

    expect(state.freshnessKind).toBe('stale');
    expect(state.buyMarketExecutable).toBe(false);
    expect(state.sellMarketExecutable).toBe(false);
    expect(state.buyReferencePrice).toBeNull();
    expect(state.sellReferencePrice).toBeNull();
    expect(state.rejectReason).toBe('DEPTH_STALE');
  });

  it.each(['LIVE', 'RECENT'])(
    'lets depth stale=true override %s freshness for MARKET and BBO',
    (depthFreshness) => {
      const state = resolveSpotExecutableDepth(depthInput({
        depthFreshness,
        depthStale: true,
      }));

      expect(state.freshnessKind).toBe('stale');
      expect(state.buyMarketExecutable).toBe(false);
      expect(state.sellMarketExecutable).toBe(false);
      expect(state.buyBboAvailable).toBe(false);
      expect(state.sellBboAvailable).toBe(false);
      expect(state.buyReferencePrice).toBeNull();
      expect(state.sellReferencePrice).toBeNull();
      expect(state.rejectReason).toBe('DEPTH_STALE');
    },
  );

  it('classifies an empty or missing depth domain as missing', () => {
    const state = resolveSpotExecutableDepth(depthInput({
      depthSymbol: null,
      bestBid: null,
      bestAsk: null,
      depthSource: 'MISSING',
      depthFreshness: 'MISSING',
      depthStatus: 'MISSING',
    }));

    expect(state.isCurrentSymbol).toBe(false);
    expect(state.freshnessKind).toBe('missing');
    expect(state.rejectReason).toBe('DEPTH_MISSING');
    expect(state.hasFreshTwoSidedBook).toBe(false);
  });

  it('rejects unknown freshness even when numeric bid and ask values exist', () => {
    const state = resolveSpotExecutableDepth(depthInput({ depthFreshness: 'UNKNOWN' }));

    expect(state.freshnessKind).toBe('unknown');
    expect(state.buyMarketExecutable).toBe(false);
    expect(state.sellMarketExecutable).toBe(false);
    expect(state.rejectReason).toBe('DEPTH_UNKNOWN');
  });

  it.each(['CACHED', 'FALLBACK', 'LAST_GOOD', 'LAST_VALID', 'DELAYED'])(
    'rejects unsafe %s depth source even when freshness claims LIVE',
    (depthSource) => {
      const state = resolveSpotExecutableDepth(depthInput({ depthSource }));

      expect(state.freshnessKind).toBe('delayed');
      expect(state.buyReferencePrice).toBeNull();
      expect(state.sellReferencePrice).toBeNull();
      expect(state.rejectReason).toBe('DEPTH_DELAYED');
    },
  );

  it('does not accept a display price when the depth domain is missing', () => {
    const state = resolveSpotExecutableDepth(depthInput({
      depthSymbol: null,
      bestBid: null,
      bestAsk: null,
      depthSource: 'MISSING',
      depthFreshness: 'MISSING',
    }));

    expect(state).not.toHaveProperty('displayPrice');
    expect(state.buyMarketExecutable).toBe(false);
    expect(state.sellMarketExecutable).toBe(false);
  });

  it('does not let page-level display data source downgrade fresh depth evidence', () => {
    const state = resolveSpotExecutableDepth(depthInput({
      depthSource: 'LIVE_WS',
      depthFreshness: 'LIVE',
      dataSource: 'FALLBACK',
    }));

    expect(state.freshnessKind).toBe('fresh');
    expect(state.buyMarketExecutable).toBe(true);
    expect(state.sellMarketExecutable).toBe(true);
  });

  it('invalidates old BBO immediately while switching symbols or on a symbol mismatch', () => {
    const switching = resolveSpotExecutableDepth(depthInput({
      currentSymbol: 'ETHUSDT',
      isSwitchingSymbol: true,
    }));
    const mismatched = resolveSpotExecutableDepth(depthInput({ currentSymbol: 'ETHUSDT' }));

    expect(switching.isCurrentSymbol).toBe(false);
    expect(switching.rejectReason).toBe('SYMBOL_SWITCHING');
    expect(switching.buyReferencePrice).toBeNull();
    expect(mismatched.rejectReason).toBe('SYMBOL_MISMATCH');
    expect(mismatched.sellReferencePrice).toBeNull();
    expect(resolveSpotOrderDepthInteraction(switching, 'buy', 'limit')).toMatchObject({
      depthAllowsSubmit: true,
      orderExecutable: false,
      rejectReason: 'SYMBOL_SWITCHING',
    });
    expect(resolveSpotOrderDepthInteraction(mismatched, 'sell', 'limit')).toMatchObject({
      depthAllowsSubmit: true,
      orderExecutable: false,
      rejectReason: 'SYMBOL_MISMATCH',
    });
  });

  it('makes MARKET BUY depend only on the fresh ask', () => {
    const state = resolveSpotExecutableDepth(depthInput({ bestBid: null }));
    const buy = resolveSpotOrderDepthInteraction(state, 'buy', 'market');
    const sell = resolveSpotOrderDepthInteraction(state, 'sell', 'market');

    expect(buy).toMatchObject({
      depthAllowsSubmit: true,
      orderExecutable: true,
      bboAvailable: true,
      referencePrice: '101',
      rejectReason: null,
    });
    expect(sell).toMatchObject({
      depthAllowsSubmit: false,
      orderExecutable: false,
      bboAvailable: false,
      referencePrice: null,
      rejectReason: 'MISSING_BID',
    });
  });

  it('makes MARKET SELL depend only on the fresh bid', () => {
    const state = resolveSpotExecutableDepth(depthInput({ bestAsk: null }));
    const buy = resolveSpotOrderDepthInteraction(state, 'buy', 'market');
    const sell = resolveSpotOrderDepthInteraction(state, 'sell', 'market');

    expect(buy.orderExecutable).toBe(false);
    expect(buy.rejectReason).toBe('MISSING_ASK');
    expect(sell.orderExecutable).toBe(true);
    expect(sell.referencePrice).toBe('100');
  });

  it('keeps manual LIMIT submission depth-independent when depth is missing', () => {
    const state = resolveSpotExecutableDepth(depthInput({
      depthSymbol: null,
      bestBid: null,
      bestAsk: null,
      depthSource: 'MISSING',
      depthFreshness: 'MISSING',
    }));
    const buyLimit = resolveSpotOrderDepthInteraction(state, 'buy', 'limit');
    const sellLimit = resolveSpotOrderDepthInteraction(state, 'sell', 'limit');

    expect(buyLimit).toMatchObject({
      depthAllowsSubmit: true,
      orderExecutable: true,
      bboAvailable: false,
      referencePrice: null,
      rejectReason: null,
    });
    expect(sellLimit.orderExecutable).toBe(true);
    expect(sellLimit.bboAvailable).toBe(false);
  });

  it.each([
    { depthSource: 'LIVE_WS', depthFreshness: 'STALE' },
    { depthSource: 'MISSING', depthFreshness: 'MISSING' },
    { depthSource: 'LIVE_WS', depthFreshness: 'UNKNOWN' },
  ])('keeps manual LIMIT submission available for non-fresh depth: %o', (override) => {
    const state = resolveSpotExecutableDepth(depthInput(override));
    const limit = resolveSpotOrderDepthInteraction(state, 'buy', 'limit');

    expect(limit.depthAllowsSubmit).toBe(true);
    expect(limit.orderExecutable).toBe(true);
    expect(limit.bboAvailable).toBe(false);
    expect(limit.referencePrice).toBeNull();
    expect(limit.rejectReason).toBeNull();
  });

  it('disables only the missing-side LIMIT BBO autofill on a one-sided book', () => {
    const state = resolveSpotExecutableDepth(depthInput({ bestBid: null }));
    const buyLimit = resolveSpotOrderDepthInteraction(state, 'buy', 'limit');
    const sellLimit = resolveSpotOrderDepthInteraction(state, 'sell', 'limit');

    expect(buyLimit.orderExecutable).toBe(true);
    expect(buyLimit.bboAvailable).toBe(true);
    expect(buyLimit.referencePrice).toBe('101');
    expect(sellLimit.orderExecutable).toBe(true);
    expect(sellLimit.bboAvailable).toBe(false);
    expect(sellLimit.referencePrice).toBeNull();
  });

  it('supports an internal fresh one-sided book without synthesizing its missing side', () => {
    const state = resolveSpotExecutableDepth(depthInput({
      bestAsk: null,
      depthSource: 'INTERNAL',
      depthFreshness: 'RECENT',
      dataSource: 'INTERNAL',
    }));

    expect(state.freshnessKind).toBe('fresh');
    expect(state.hasFreshBid).toBe(true);
    expect(state.hasFreshAsk).toBe(false);
    expect(state.sellMarketExecutable).toBe(true);
    expect(state.buyMarketExecutable).toBe(false);
    expect(state.buyReferencePrice).toBeNull();
  });

  it.each([
    { pairEnabled: false },
    { pairStatus: 0 },
    { marketStatus: 'CLOSED' },
    { pairMarketStatus: 'CLOSED' },
  ])('blocks MARKET and LIMIT when market or pair is explicitly non-tradable: %o', (override) => {
    const state = resolveSpotExecutableDepth(depthInput(override));
    const market = resolveSpotOrderDepthInteraction(state, 'buy', 'market');
    const limit = resolveSpotOrderDepthInteraction(state, 'buy', 'limit');

    expect(state.marketTradable).toBe(false);
    expect(state.buyBboAvailable).toBe(false);
    expect(market.orderExecutable).toBe(false);
    expect(limit.depthAllowsSubmit).toBe(true);
    expect(limit.orderExecutable).toBe(false);
    expect(limit.rejectReason).toBe('MARKET_NOT_TRADABLE');
  });

  it('keeps the newer WS depth when a late REST snapshot is rejected by the existing sequencer', () => {
    type SequencedDepth = Pick<
      SpotExecutableDepthInput,
      'depthSymbol' | 'bestBid' | 'bestAsk' | 'depthSource' | 'depthFreshness'
    >;
    const wsDepth: SequencedDepth = {
      depthSymbol: 'BTCUSDT',
      bestBid: '100',
      bestAsk: '101',
      depthSource: 'LIVE_WS',
      depthFreshness: 'LIVE',
    };
    const restDepth: SequencedDepth = {
      depthSymbol: 'BTCUSDT',
      bestBid: '90',
      bestAsk: '91',
      depthSource: 'REST',
      depthFreshness: 'RECENT',
    };
    const wsDecision = sequenceSpotMarketDomainEvent<SequencedDepth>(null, {
      symbol: 'BTCUSDT',
      domain: 'depth',
      provider: 'OKX_SPOT',
      eventTimeMs: 2_000,
      receivedAtMs: 2_100,
      transport: 'ws_incremental',
      source: 'LIVE_WS',
      freshness: 'LIVE',
      data: wsDepth,
    });
    const lateRestDecision = sequenceSpotMarketDomainEvent(wsDecision.state, {
      symbol: 'BTCUSDT',
      domain: 'depth',
      provider: 'OKX_SPOT',
      eventTimeMs: 1_000,
      receivedAtMs: 3_000,
      transport: 'rest',
      source: 'REST',
      freshness: 'RECENT',
      data: restDepth,
    });
    const state = resolveSpotExecutableDepth(depthInput(lateRestDecision.state.current?.data));

    expect(lateRestDecision.accepted).toBe(false);
    expect(lateRestDecision.reason).toBe('older_event_time');
    expect(state.buyReferencePrice).toBe('101');
    expect(state.sellReferencePrice).toBe('100');
  });
});
