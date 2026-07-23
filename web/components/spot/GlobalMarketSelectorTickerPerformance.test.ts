import { describe, expect, it } from '@jest/globals';
import {
  getContractTickerPrefetchSymbols,
  isTransientContractTickerStartupError,
  resolveContractSelectorTickerAuthority,
  resolveSelectorPricePrecision,
  type GlobalMarketSelectorPair,
} from './GlobalMarketSelector';

describe('contract selector ticker startup retry policy', () => {
  it.each([502, 503, 504])('retries transient HTTP %s proxy failures', (status) => {
    expect(isTransientContractTickerStartupError(new Error(`HTTP Error ${status}:`))).toBe(true);
  });

  it('retries network failures but not ordinary client errors or aborts', () => {
    expect(isTransientContractTickerStartupError(Object.assign(new Error('Network error'), { code: 'NETWORK_ERROR' }))).toBe(true);
    expect(isTransientContractTickerStartupError(new Error('HTTP Error 404: Not Found'))).toBe(false);
    expect(isTransientContractTickerStartupError(new DOMException('Aborted', 'AbortError'))).toBe(false);
  });
});

const pairs: GlobalMarketSelectorPair[] = [
  {
    symbol: 'BTCUSDT_PERP',
    assetType: 'CRYPTO',
    marketCategory: 'CONTRACT',
    marketSubCategory: 'CONTRACT',
  },
  {
    symbol: 'EURUSD_PERP',
    assetType: 'FOREX',
    marketCategory: 'FOREX',
    marketSubCategory: 'FOREX',
  },
  {
    symbol: 'AAPLUSDT_PERP',
    assetType: 'STOCK',
    marketCategory: 'STOCK',
    marketSubCategory: 'STOCK_CONTRACT',
  },
  {
    symbol: 'ABBVUSDT_PERP',
    assetType: 'STOCK',
    marketCategory: 'STOCK',
    marketSubCategory: 'STOCK_CONTRACT',
  },
  {
    symbol: 'MOCKUSDT_PERP',
    assetType: 'STOCK',
    marketMode: 'MOCK_STOCK_CONTRACT',
    marketCategory: 'STOCK',
    marketSubCategory: 'STOCK_CONTRACT',
  },
];

describe('contract selector ticker prewarm priority', () => {
  it('warms the current stock cohort before unrelated assets', () => {
    expect(getContractTickerPrefetchSymbols(pairs, 'AAPLUSDT_PERP', 4)).toEqual([
      'AAPLUSDT_PERP',
      'ABBVUSDT_PERP',
      'BTCUSDT_PERP',
      'EURUSD_PERP',
    ]);
  });

  it('excludes mock contracts that use the spot ticker path', () => {
    expect(getContractTickerPrefetchSymbols(pairs, 'MOCKUSDT_PERP', 10)).not.toContain('MOCKUSDT_PERP');
  });
});

describe('contract selector ticker authority', () => {
  it.each([
    ['SPXUSDT_PERP', 'INDEX'],
    ['EURUSD_PERP', 'FOREX'],
    ['XAUUSDT_PERP', 'GOLD'],
    ['BRENTUSDT_PERP', 'FUTURES'],
    ['AAPLUSDT_PERP', 'STOCK'],
  ])('keeps a fresh batch ticker over a stale local quote for %s (%s)', (symbol) => {
    const resolved = resolveContractSelectorTickerAuthority({
      batchTicker: {
        symbol,
        price: '7489.95',
        change24h: '0.34',
        quoteFreshness: 'LIVE',
      },
      batchUpdatedAt: 20_000,
      quoteTicker: {
        symbol,
        price: '0.35',
        change24h: '-0.61',
        quoteFreshness: 'LAST_VALID',
      },
      quoteUpdatedAt: 30_000,
    });

    expect(resolved).toMatchObject({
      symbol,
      price: '7489.95',
      change24h: '0.34',
      quoteFreshness: 'LIVE',
    });
  });

  it('uses the newer local quote when both sources have equal freshness', () => {
    const resolved = resolveContractSelectorTickerAuthority({
      batchTicker: {
        symbol: 'BTCUSDT_PERP',
        price: '66200.0',
        quoteFreshness: 'LIVE',
      },
      batchUpdatedAt: 20_000,
      quoteTicker: {
        symbol: 'BTCUSDT_PERP',
        price: '66201.5',
        quoteFreshness: 'LIVE',
      },
      quoteUpdatedAt: 21_000,
    });

    expect(resolved?.price).toBe('66201.5');
  });

  it('keeps authoritative contract precision beside the winning ticker price', () => {
    const resolved = resolveContractSelectorTickerAuthority({
      batchTicker: {
        symbol: 'EURUSD_PERP',
        price: '1.14080',
        displayPricePrecision: 5,
        pricePrecision: 5,
        quoteFreshness: 'LIVE',
      },
      batchUpdatedAt: 20_000,
      quoteTicker: {
        symbol: 'EURUSD_PERP',
        price: '1.14079',
        quoteFreshness: 'LIVE',
      },
      quoteUpdatedAt: 19_000,
    });

    expect(resolved).toMatchObject({
      price: '1.14080',
      displayPricePrecision: 5,
      pricePrecision: 5,
    });
  });
});

describe('contract selector price precision fallback', () => {
  it.each([
    ['EURUSD_PERP', '1.14080', 5],
    ['GBPUSD_PERP', '1.33811', 5],
    ['USDJPY_PERP', '163.009', 3],
  ])('does not collapse %s to an integer during cache warmup', (symbol, price, expected) => {
    expect(resolveSelectorPricePrecision(price, {
      symbol,
      assetType: 'FOREX',
      marketCategory: 'FOREX',
      marketSubCategory: 'FOREX',
      pricePrecision: 0,
    })).toBe(expected);
  });
});
