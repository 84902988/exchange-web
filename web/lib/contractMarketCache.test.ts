/** @jest-environment jsdom */

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { ContractQuote } from './api/modules/contract';
import { getMarketCacheKey } from './marketCache';
import {
  readContractQuoteCache,
  readContractTradesCache,
  writeContractKlineCache,
  writeContractQuoteCache,
  writeContractTradesCache,
} from './contractMarketCache';

function contractQuote(patch: Partial<ContractQuote>): ContractQuote {
  return {
    symbol: 'SPXUSDT_PERP',
    provider: 'ITICK',
    provider_symbol: 'SPX',
    bid_price: '7443.28',
    ask_price: '7443.30',
    last_price: '7443.29',
    mark_price: '7443.29',
    source: 'TEST',
    ts: '1970-01-01T00:00:01.000Z',
    ...patch,
  };
}

describe('contract quote cache authority', () => {
  beforeEach(() => {
    window.localStorage.clear();
    jest.restoreAllMocks();
  });

  it('does not let a later kline cache write refresh an old closed quote', () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_000);
    writeContractQuoteCache('SPXUSDT_PERP', contractQuote({
      market_status: 'CLOSED',
      last_price: '7443.29',
    }));

    nowSpy.mockReturnValue(40_000);
    writeContractKlineCache('SPXUSDT_PERP', '1m', {
      candles: [{
        time: 40_000,
        open: 7490,
        high: 7491,
        low: 7489,
        close: 7490.98,
        volume: 10,
        isPlaceholder: false,
      }],
      volumes: [],
    });

    expect(readContractQuoteCache('SPXUSDT_PERP')).toMatchObject({
      quote: null,
      lastPrice: null,
      updatedAt: 1_000,
    });
  });

  it('persists a quote-specific timestamp alongside the shared cache timestamp', () => {
    jest.spyOn(Date, 'now').mockReturnValue(12_345);
    writeContractQuoteCache('BRENTUSDT_PERP', contractQuote({
      symbol: 'BRENTUSDT_PERP',
      provider_symbol: 'BRENT',
      market_status: 'OPEN',
      quote_freshness: 'LIVE',
      last_price: '89.15',
      mark_price: '89.15',
    }));

    const cached = JSON.parse(
      window.localStorage.getItem(getMarketCacheKey('contract', 'BRENTUSDT_PERP')) || '{}',
    ) as Record<string, unknown>;
    expect(cached).toMatchObject({ quoteUpdatedAt: 12_345, updatedAt: 12_345 });
  });

  it('expires a legacy closed quote whose shared timestamp was refreshed by another domain', () => {
    window.localStorage.setItem(
      getMarketCacheKey('contract', 'DJIUSDT_PERP'),
      JSON.stringify({
        quote: contractQuote({
          symbol: 'DJIUSDT_PERP',
          provider_symbol: 'DJI',
          market_status: 'CLOSED',
          last_price: '51844.20',
        }),
        lastPrice: '51844.20',
        updatedAt: Date.now(),
      }),
    );

    expect(readContractQuoteCache('DJIUSDT_PERP')).toMatchObject({
      quote: null,
      lastPrice: null,
      updatedAt: null,
    });
  });
});

describe('contract trades cache authority', () => {
  beforeEach(() => {
    window.localStorage.clear();
    jest.restoreAllMocks();
  });

  it('uses a domain timestamp and expires cached trades after five seconds', () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(10_000);
    writeContractTradesCache('NAS100USDT_PERP', {
      trades: [{
        id: 'trade-1',
        price: '29053.13',
        qty: '1',
        time: 10_000,
        source: 'LIVE_WS',
        quote_freshness: 'LIVE',
        price_source: 'TRADE_TICK',
      }],
      lastPrice: '29053.13',
    });

    nowSpy.mockReturnValue(14_999);
    expect(readContractTradesCache('NAS100USDT_PERP')).toMatchObject({
      lastPrice: '29053.13',
      updatedAt: 10_000,
    });

    nowSpy.mockReturnValue(15_001);
    expect(readContractTradesCache('NAS100USDT_PERP')).toBeNull();
  });

  it('does not revive legacy trades when another cache domain updates', () => {
    window.localStorage.setItem(
      getMarketCacheKey('contract', 'SPXUSDT_PERP'),
      JSON.stringify({
        trades: [{ id: 'legacy', price: '0.35', qty: '1', time: 1_000 }],
        tradesLastPrice: '0.35',
        updatedAt: Date.now(),
      }),
    );

    expect(readContractTradesCache('SPXUSDT_PERP')).toBeNull();
  });
});
