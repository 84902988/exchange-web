export type ContractRestBootstrapCursor = {
  key: string | null;
  realtimeStatus: string;
};

export type ContractRestBootstrapDecision = {
  shouldRefresh: boolean;
  next: ContractRestBootstrapCursor;
};

export function resolveContractRestBootstrap(
  previous: ContractRestBootstrapCursor,
  key: string,
  realtimeStatus: string,
): ContractRestBootstrapDecision {
  const lostRealtime = previous.realtimeStatus === 'connected'
    && realtimeStatus !== 'connected';
  return {
    shouldRefresh: previous.key !== key || lostRealtime,
    next: { key, realtimeStatus },
  };
}
