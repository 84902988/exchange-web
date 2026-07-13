import type { Query, QueryClient } from '@tanstack/react-query';

const PRIVATE_QUERY_ROOTS = new Set([
  'assetAccountBalances',
  'assetAccountBalancesForWithdraw',
  'assetContractAccountSummary',
  'assetContractDetail',
  'assetContractOrders',
  'assetContractPositions',
  'assetContractTrades',
  'assetDeposits',
  'assetSpotBalances',
  'assetSpotCurrentOrders',
  'assetSpotHistoryOrders',
  'assetSpotTrades',
  'assetTransferRecords',
  'kycResult',
  'kycStatus',
  'meForWithdrawLock',
  'userTransferRecords',
  'withdraws',
]);

type PrivateQueryCacheClient = Pick<QueryClient, 'cancelQueries' | 'removeQueries'>;

export function isPrivateAccountQuery(query: Pick<Query, 'queryKey'>) {
  const root = query.queryKey[0];
  return typeof root === 'string' && PRIVATE_QUERY_ROOTS.has(root);
}

export function clearPrivateAccountQueries(queryClient: PrivateQueryCacheClient) {
  const filters = { predicate: isPrivateAccountQuery };

  // Remove synchronously so anonymous UI cannot reuse stale account data, then
  // remove once more after cancellation to close the in-flight request race.
  queryClient.removeQueries(filters);
  void queryClient.cancelQueries(filters).finally(() => queryClient.removeQueries(filters));
}
