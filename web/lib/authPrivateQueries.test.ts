import { describe, expect, it, jest } from '@jest/globals';
import { QueryClient } from '@tanstack/react-query';
import { clearPrivateAccountQueries, privateQueryKey } from './authPrivateQueries';

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

  it('isolates the same private domain by immutable user identity', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(privateQueryKey('user-a', 'contractPositions'), [{ id: 1 }]);

    expect(queryClient.getQueryData(privateQueryKey('user-b', 'contractPositions'))).toBeUndefined();
    expect(queryClient.getQueryData(privateQueryKey('user-a', 'contractPositions'))).toEqual([{ id: 1 }]);
  });

  it('removes user-scoped private keys while preserving public queries', async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(privateQueryKey('user-a', 'balances'), [{ available: '9' }]);
    queryClient.setQueryData(['contractMarketView', 'BTCUSDT_PERP'], { price: '50000' });

    clearPrivateAccountQueries(queryClient);
    await Promise.resolve();

    expect(queryClient.getQueryData(privateQueryKey('user-a', 'balances'))).toBeUndefined();
    expect(queryClient.getQueryData(['contractMarketView', 'BTCUSDT_PERP'])).toEqual({ price: '50000' });
  });

  it('starts private cancellation before synchronous removal', async () => {
    const calls: string[] = [];
    const queryClient = {
      cancelQueries: jest.fn(() => {
        calls.push('cancel');
        return Promise.resolve();
      }),
      removeQueries: jest.fn(() => {
        calls.push('remove');
      }),
    };

    clearPrivateAccountQueries(queryClient as never);
    expect(calls.slice(0, 2)).toEqual(['cancel', 'remove']);
    await Promise.resolve();
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
