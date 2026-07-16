import { describe, expect, it } from '@jest/globals';
import type { SpotMarketTradeItem } from '@/lib/api/modules/spot';
import {
  SPOT_DISPLAY_TRADE_ACTIVE_WINDOW_MS,
  selectSpotDisplayPrice,
  shouldShowSpotDisplayPriceOverlay,
  sortSpotTradesLatestFirst,
  type SpotDisplayPriceCandidate,
} from './spotDisplayPrice';

const NOW_MS = 10_000;

function candidate(
  price: string,
  overrides: Partial<SpotDisplayPriceCandidate> = {},
): SpotDisplayPriceCandidate {
  return {
    symbol: 'BTCUSDT',
    price,
    eventTimeMs: 9_000,
    receivedAtMs: 9_100,
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
      trade: candidate('101', { eventTimeMs: 9_500, receivedAtMs: 9_900 }),
      ticker: candidate('100', { eventTimeMs: 9_400, receivedAtMs: 9_950 }),
      kline: candidate('99'),
      nowMs: NOW_MS,
    });

    expect(result.price).toBe('101');
    expect(result.sourceDomain).toBe('trades');
    expect(result.isRealTrade).toBe(true);
    expect(result.eventTimeMs).toBe(9_500);
    expect(result.receivedAtMs).toBe(9_900);
  });

  it('lets ticker take over when the trade exceeds the active window', () => {
    const result = selectSpotDisplayPrice({
      symbol: 'BTCUSDT',
      trade: candidate('101', {
        eventTimeMs: NOW_MS - SPOT_DISPLAY_TRADE_ACTIVE_WINDOW_MS - 100,
        receivedAtMs: NOW_MS - SPOT_DISPLAY_TRADE_ACTIVE_WINDOW_MS - 1,
      }),
      ticker: candidate('102', { eventTimeMs: 9_900, receivedAtMs: 9_950 }),
      nowMs: NOW_MS,
    });

    expect(result.price).toBe('102');
    expect(result.sourceDomain).toBe('ticker');
  });

  it('does not let a newer ticker receive time stay blocked by a fresh untimed trade', () => {
    const result = selectSpotDisplayPrice({
      symbol: 'BTCUSDT',
      trade: candidate('101', { eventTimeMs: null, receivedAtMs: 9_800 }),
      ticker: candidate('102', { eventTimeMs: null, receivedAtMs: 9_900 }),
      nowMs: NOW_MS,
    });

    expect(result.price).toBe('102');
    expect(result.sourceDomain).toBe('ticker');
  });

  it('rejects an older provider trade event even when it was received later', () => {
    const result = selectSpotDisplayPrice({
      symbol: 'BTCUSDT',
      trade: candidate('101', { eventTimeMs: 9_700, receivedAtMs: 9_990 }),
      ticker: candidate('102', { eventTimeMs: 9_800, receivedAtMs: 9_900 }),
      nowMs: NOW_MS,
    });

    expect(result.price).toBe('102');
    expect(result.sourceDomain).toBe('ticker');
  });

  it('uses ticker without marking it as a trade or inserting a trade row', () => {
    const trades: SpotMarketTradeItem[] = [];
    const result = selectSpotDisplayPrice({
      symbol: 'BTCUSDT',
      ticker: candidate('100'),
      nowMs: NOW_MS,
    });

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
      nowMs: NOW_MS,
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
      nowMs: NOW_MS,
    });

    expect(result.sourceDomain).toBe('unavailable');
    expect(result.price).toBeNull();
    expect(result.freshness).toBe('MISSING');
    expect(shouldShowSpotDisplayPriceOverlay(result)).toBe(false);
  });

  it('keeps trade and ticker selection isolated to the requested symbol', () => {
    const result = selectSpotDisplayPrice({
      symbol: 'ETHUSDT',
      trade: candidate('101'),
      ticker: candidate('102', { symbol: 'ETHUSDT' }),
      nowMs: NOW_MS,
    });

    expect(result.price).toBe('102');
    expect(result.symbol).toBe('ETHUSDT');
    expect(result.sourceDomain).toBe('ticker');
  });

  it('keeps provider event time separate from local receive time', () => {
    const result = selectSpotDisplayPrice({
      symbol: 'BTCUSDT',
      trade: candidate('101', { eventTimeMs: null, receivedAtMs: 9_000 }),
      nowMs: NOW_MS,
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
