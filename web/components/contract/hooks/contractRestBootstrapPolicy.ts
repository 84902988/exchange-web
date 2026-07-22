export type ContractRestBootstrapCursor = {
  key: string | null;
  realtimeStatus: string;
};

export type ContractRestBootstrapDecision = {
  shouldRefresh: boolean;
  next: ContractRestBootstrapCursor;
};

export type ContractRestBootstrapOptions = {
  hasUsableSnapshot?: boolean;
  refreshIfConnectedWithoutSnapshot?: boolean;
};

export function resolveContractRestBootstrap(
  previous: ContractRestBootstrapCursor,
  key: string,
  realtimeStatus: string,
  options: ContractRestBootstrapOptions = {},
): ContractRestBootstrapDecision {
  const lostRealtime = previous.realtimeStatus === 'connected'
    && realtimeStatus !== 'connected';
  const connectedWithoutSnapshot = options.refreshIfConnectedWithoutSnapshot === true
    && options.hasUsableSnapshot !== true
    && previous.realtimeStatus !== 'connected'
    && realtimeStatus === 'connected';
  return {
    shouldRefresh: previous.key !== key || lostRealtime || connectedWithoutSnapshot,
    next: { key, realtimeStatus },
  };
}
