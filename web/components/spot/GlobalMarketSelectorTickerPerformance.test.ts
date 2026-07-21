import { describe, expect, it } from '@jest/globals';
import {
  getContractTickerPrefetchSymbols,
  type GlobalMarketSelectorPair,
} from './GlobalMarketSelector';

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
