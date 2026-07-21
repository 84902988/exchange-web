import { afterEach, describe, expect, it, jest } from '@jest/globals';
import {
  CONTRACT_SELECTOR_TICKER_MAX_STALE_MS,
  clearContractSelectorTickerCache,
  readContractSelectorTickerCache,
  writeContractSelectorTickerCache,
} from './contractSelectorTickerCache';

describe('contract selector ticker cache', () => {
  afterEach(() => {
    clearContractSelectorTickerCache();
    jest.restoreAllMocks();
  });

  it('reuses complete ticker fields across selector mounts', () => {
    jest.spyOn(Date, 'now').mockReturnValue(10_000);
    writeContractSelectorTickerCache([
      {
        symbol: 'aaplusdt_perp',
        price: '333.74',
        change24h: '0.07',
        high24h: '335',
      },
    ]);

    expect(readContractSelectorTickerCache()).toEqual([
      expect.objectContaining({
        symbol: 'AAPLUSDT_PERP',
        price: '333.74',
        change24h: '0.07',
        high24h: '335',
        updatedAt: 10_000,
      }),
    ]);
  });

  it('drops ticker snapshots after the bounded stale-while-revalidate window', () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(20_000);
    writeContractSelectorTickerCache([{ symbol: 'EURUSD_PERP', price: '1.12', change24h: '0.1' }]);

    nowSpy.mockReturnValue(20_000 + CONTRACT_SELECTOR_TICKER_MAX_STALE_MS + 1);
    expect(readContractSelectorTickerCache()).toEqual([]);
  });
});
