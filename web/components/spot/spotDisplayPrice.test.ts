import { describe, expect, it } from '@jest/globals';
import type { SpotMarketTradeItem } from '@/lib/api/modules/spot';
import {
  selectSpotDisplayPrice,
  shouldShowSpotDisplayPriceOverlay,
  sortSpotTradesLatestFirst,
  type SpotDisplayPriceCandidate,
} from './spotDisplayPrice';

function candidate(
  price: string,
  overrides: Partial<SpotDisplayPriceCandidate> = {},
): SpotDisplayPriceCandidate {
  return {
    symbol: 'BTCUSDT',
    price,
    eventTimeMs: 2_000,
    receivedAtMs: 2_100,
    source: 'LIVE_WS',
    provider: 'OKX_SPOT',
    freshness: 'LIVE',
    ...overrides,
  };
}

describe('spot display price', () => {
  it('prefers a fresh real trade over ticker and native candle close', () => {
    const result = selectSpotDisplayPrice({
      symbol: 'BTCUSDT',
      trade: candidate('101'),
      ticker: candidate('100'),
      kline: candidate('99'),
    });

    expect(result.price).toBe('101');
    expect(result.sourceDomain).toBe('trades');
    expect(result.isRealTrade).toBe(true);
    expect(result.eventTimeMs).toBe(2_000);
    expect(result.receivedAtMs).toBe(2_100);
  });

  it('does not let a newer ticker replace an accepted fresh trade', () => {
    const result = selectSpotDisplayPrice({
      symbol: 'BTCUSDT',
      trade: candidate('101', { eventTimeMs: 2_000 }),
      ticker: candidate('102', { eventTimeMs: 3_000 }),
    });

    expect(result.price).toBe('101');
    expect(result.sourceDomain).toBe('trades');
  });

  it('uses ticker without marking it as a trade or inserting a trade row', () => {
    const trades: SpotMarketTradeItem[] = [];
    const result = selectSpotDisplayPrice({ symbol: 'BTCUSDT', ticker: candidate('100') });

    expect(result.price).toBe('100');
    expect(result.sourceDomain).toBe('ticker');
    expect(result.isRealTrade).toBe(false);
    expect(trades).toEqual([]);
  });

  it('uses native candle close only after trade and ticker are unavailable', () => {
    const result = selectSpotDisplayPrice({
      symbol: 'BTCUSDT',
      trade: candidate('101', { freshness: 'STALE' }),
      ticker: candidate('100', { freshness: 'MISSING' }),
      kline: candidate('99', { source: 'LIVE_WS', freshness: 'LIVE' }),
    });

    expect(result.price).toBe('99');
    expect(result.sourceDomain).toBe('kline');
    expect(result.isRealTrade).toBe(false);
  });

  it('does not use a stale or wrong-symbol candidate', () => {
    const result = selectSpotDisplayPrice({
      symbol: 'ETHUSDT',
      trade: candidate('101'),
      ticker: candidate('100', { symbol: 'ETHUSDT', freshness: 'STALE' }),
    });

    expect(result.sourceDomain).toBe('unavailable');
    expect(result.price).toBeNull();
    expect(result.freshness).toBe('MISSING');
    expect(shouldShowSpotDisplayPriceOverlay(result)).toBe(false);
  });

  it('keeps provider event time separate from local receive time', () => {
    const result = selectSpotDisplayPrice({
      symbol: 'BTCUSDT',
      trade: candidate('101', { eventTimeMs: null, receivedAtMs: 9_000 }),
    });

    expect(result.eventTimeMs).toBeNull();
    expect(result.receivedAtMs).toBe(9_000);
  });

  it('keeps the newest real trade at the first recent-trades position', () => {
    const rows: SpotMarketTradeItem[] = [
      { price: '100', amount: '1', side: 'BUY', ts: 10 },
      { price: '102', amount: '1', side: 'SELL', ts: 12 },
      { price: '101', amount: '1', side: 'BUY', ts: 11 },
    ];
    const sorted = sortSpotTradesLatestFirst(rows, (trade) => Number(trade.ts) * 1000);

    expect(sorted.map((trade) => trade.price)).toEqual(['102', '101', '100']);
    expect(rows.map((trade) => trade.price)).toEqual(['100', '102', '101']);
  });
});
