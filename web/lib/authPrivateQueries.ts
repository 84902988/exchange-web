import type { Query, QueryClient } from '@tanstack/react-query';

export type PrivateQueryIdentity = string | null;

export function privateQueryKey(
  identity: PrivateQueryIdentity,
  domain: string,
  ...params: readonly unknown[]
) {
  return ['private', identity, domain, ...params] as const;
}

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
  return root === 'private' || (typeof root === 'string' && PRIVATE_QUERY_ROOTS.has(root));
}

export function clearPrivateAccountQueries(queryClient: PrivateQueryCacheClient) {
  const filters = { predicate: isPrivateAccountQuery };

  // Begin cancellation first, remove synchronously so the next render cannot
  // reuse stale data, then remove once more to close the in-flight race.
  const cancellation = queryClient.cancelQueries(filters);
  queryClient.removeQueries(filters);
  void cancellation.finally(() => queryClient.removeQueries(filters));
}
