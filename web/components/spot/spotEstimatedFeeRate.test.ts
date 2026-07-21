import { describe, expect, it } from '@jest/globals';
import type { SpotExecutableDepthState } from './spotExecutableDepth';
import { resolveSpotEstimatedFeeRate } from './spotEstimatedFeeRate';

function depth(overrides: Partial<SpotExecutableDepthState> = {}): SpotExecutableDepthState {
  return {
    currentSymbol: 'MFCUSDT',
    depthSymbol: 'MFCUSDT',
    isCurrentSymbol: true,
    freshnessKind: 'fresh',
    hasFreshBid: true,
    hasFreshAsk: true,
    hasFreshTwoSidedBook: true,
    buyMarketExecutable: true,
    sellMarketExecutable: true,
    buyBboAvailable: true,
    sellBboAvailable: true,
    buyReferencePrice: '0.109',
    sellReferencePrice: '0.108',
    marketTradable: true,
    rejectReason: null,
    buyRejectReason: null,
    sellRejectReason: null,
    depthSource: 'ORDER_BOOK',
    depthFreshness: 'LIVE',
    depthStatus: 'LIVE',
    depthStale: false,
    dataSource: 'INTERNAL',
    isLoading: false,
    marketStatus: 'OPEN',
    pairMarketStatus: 'OPEN',
    pairEnabled: true,
    pairStatus: 1,
    ...overrides,
  };
}

const rates = {
  makerFeeRate: '0.0004',
  takerFeeRate: '0.004',
};

describe('spot estimated fee rate', () => {
  it('uses the taker rate for market orders', () => {
    expect(resolveSpotEstimatedFeeRate({
      ...rates,
      orderType: 'market',
      side: 'buy',
      limitPrice: null,
      marketMode: 'INTERNAL',
      executableDepth: depth(),
    })).toMatchObject({ rate: 0.004, role: 'TAKER', reason: 'MARKET_ORDER' });
  });

  it('uses the taker rate when an internal limit buy crosses the best ask', () => {
    const resolution = resolveSpotEstimatedFeeRate({
      ...rates,
      orderType: 'limit',
      side: 'buy',
      limitPrice: '0.109',
      marketMode: 'INTERNAL',
      executableDepth: depth(),
    });

    expect(resolution).toMatchObject({ rate: 0.004, role: 'TAKER', reason: 'CROSSING_LIMIT' });
    expect(3.27 * (resolution.rate || 0)).toBeCloseTo(0.01308, 10);
  });

  it('uses the taker rate when an internal limit sell crosses the best bid', () => {
    expect(resolveSpotEstimatedFeeRate({
      ...rates,
      orderType: 'limit',
      side: 'sell',
      limitPrice: '0.108',
      marketMode: 'INTERNAL',
      executableDepth: depth(),
    })).toMatchObject({ rate: 0.004, role: 'TAKER', reason: 'CROSSING_LIMIT' });
  });

  it('uses the maker rate for a resting internal limit order', () => {
    expect(resolveSpotEstimatedFeeRate({
      ...rates,
      orderType: 'limit',
      side: 'buy',
      limitPrice: '0.108',
      marketMode: 'INTERNAL',
      executableDepth: depth(),
    })).toMatchObject({ rate: 0.0004, role: 'MAKER', reason: 'RESTING_LIMIT' });
  });

  it('preserves the backend maker rule for dealer limit orders', () => {
    expect(resolveSpotEstimatedFeeRate({
      ...rates,
      orderType: 'limit',
      side: 'buy',
      limitPrice: '0.109',
      marketMode: 'DEALER',
      executableDepth: depth({ dataSource: 'ITICK' }),
    })).toMatchObject({ rate: 0.0004, role: 'MAKER', reason: 'DEALER_LIMIT' });
  });

  it('uses the higher rate when current, fresh execution evidence is unavailable', () => {
    expect(resolveSpotEstimatedFeeRate({
      ...rates,
      orderType: 'limit',
      side: 'buy',
      limitPrice: '0.108',
      marketMode: 'INTERNAL',
      executableDepth: depth({ freshnessKind: 'stale', hasFreshAsk: false }),
    })).toMatchObject({
      rate: 0.004,
      role: 'CONSERVATIVE',
      reason: 'UNRELIABLE_EXECUTION_EVIDENCE',
    });
  });

  it('falls back to the available rate instead of dropping the estimate', () => {
    expect(resolveSpotEstimatedFeeRate({
      makerFeeRate: null,
      takerFeeRate: '0.004',
      orderType: 'limit',
      side: 'buy',
      limitPrice: '0.108',
      marketMode: 'DEALER',
      executableDepth: depth(),
    })).toMatchObject({ rate: 0.004, role: 'MAKER', reason: 'DEALER_LIMIT' });
  });
});
