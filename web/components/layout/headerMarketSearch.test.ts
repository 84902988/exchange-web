import { describe, expect, test } from '@jest/globals';

import type { ContractSymbolItem } from '@/lib/api/modules/contract';
import type { SpotMarketPairItem } from '@/lib/api/modules/spot';
import {
  buildContractHeaderSearchResult,
  buildSpotHeaderSearchResult,
  mergeHeaderMarketSearchResults,
} from './headerMarketSearchModel';

function contractItem(overrides: Partial<ContractSymbolItem>): ContractSymbolItem {
  return {
    symbol: 'BTCUSDT_PERP',
    display_name: 'BTC/USDT',
    category: 'CRYPTO',
    provider: 'BINANCE',
    provider_symbol: 'BTCUSDT',
    quote_asset: 'USDT',
    price_precision: 2,
    quantity_precision: 4,
    max_leverage: 100,
    status: 1,
    ...overrides,
  };
}

describe('header market search result mapping', () => {
  test('routes regular spot pairs to spot trading', () => {
    const result = buildSpotHeaderSearchResult({
      symbol: 'BTCUSDT',
      display_symbol: 'BTC/USDT',
      base_asset: 'BTC',
      quote_asset: 'USDT',
      market_category: 'CRYPTO',
    });

    expect(result).toMatchObject({
      group: 'SPOT',
      kind: 'SPOT',
      href: '/trade/spot?symbol=BTCUSDT',
    });
  });

  test('routes stock quotes to their stock market page', () => {
    const result = buildSpotHeaderSearchResult({
      symbol: 'AAPLUSDT',
      base_asset: 'AAPL',
      quote_asset: 'USDT',
      market_category: 'STOCK',
      market_sub_category: 'STOCK_QUOTE',
    });

    expect(result).toMatchObject({
      symbol: 'AAPL',
      group: 'STOCK',
      kind: 'STOCK_QUOTE',
      href: '/markets/stocks/AAPL',
    });
  });

  test.each([
    ['CRYPTO', 'CONTRACT', 'CONTRACT'],
    ['STOCK', 'STOCK', 'STOCK_CONTRACT'],
    ['FOREX', 'CFD', 'CFD'],
    ['METAL', 'CFD', 'CFD'],
  ])('classifies %s contract symbols', (category, group, kind) => {
    const result = buildContractHeaderSearchResult(contractItem({ category }));
    expect(result).toMatchObject({ group, kind, href: '/contract?symbol=BTCUSDT_PERP' });
  });

  test('deduplicates repeated source rows without collapsing distinct markets', () => {
    const spot: SpotMarketPairItem = {
      symbol: 'BTCUSDT',
      base_asset: 'BTC',
      quote_asset: 'USDT',
    };
    const contract = contractItem({ symbol: 'BTCUSDT' });

    const results = mergeHeaderMarketSearchResults([spot, spot], [contract, contract]);
    expect(results.map((item) => item.id)).toEqual(['SPOT:BTCUSDT', 'CONTRACT:BTCUSDT']);
  });
});
