import { describe, expect, it } from '@jest/globals';
import { QueryClient } from '@tanstack/react-query';
import { clearPrivateAccountQueries } from './authPrivateQueries';

describe('clearPrivateAccountQueries', () => {
  it('removes cached private account data before anonymous rendering', async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(['assetAccountBalances'], [{ coin_symbol: 'USDT', available: '999' }]);
    queryClient.setQueryData(['assetContractPositions'], [{ symbol: 'BTCUSDT_PERP', quantity: '1' }]);
    queryClient.setQueryData(['assetSpotCurrentOrders', 'BTCUSDT'], [{ id: 123 }]);

    clearPrivateAccountQueries(queryClient);
    await Promise.resolve();

    expect(queryClient.getQueryData(['assetAccountBalances'])).toBeUndefined();
    expect(queryClient.getQueryData(['assetContractPositions'])).toBeUndefined();
    expect(queryClient.getQueryData(['assetSpotCurrentOrders', 'BTCUSDT'])).toBeUndefined();
  });

  it('preserves public market and asset configuration caches', async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(['spotTicker', 'BTCUSDT'], { price: '50000' });
    queryClient.setQueryData(['assetCoins'], [{ symbol: 'USDT' }]);
    queryClient.setQueryData(['assetDepositOptions'], [{ symbol: 'USDT' }]);

    clearPrivateAccountQueries(queryClient);
    await Promise.resolve();

    expect(queryClient.getQueryData(['spotTicker', 'BTCUSDT'])).toEqual({ price: '50000' });
    expect(queryClient.getQueryData(['assetCoins'])).toEqual([{ symbol: 'USDT' }]);
    expect(queryClient.getQueryData(['assetDepositOptions'])).toEqual([{ symbol: 'USDT' }]);
  });
});
