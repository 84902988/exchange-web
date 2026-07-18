export type ContractSymbolUrlSyncOwnership = {
  shouldApplyUrlSymbol: boolean;
  pendingNavigationSymbol: string | null;
};

export function resolveContractSymbolUrlSyncOwnership(params: {
  pendingNavigationSymbol: string | null;
  urlContractSymbol: string;
}): ContractSymbolUrlSyncOwnership {
  const pendingNavigationSymbol = String(params.pendingNavigationSymbol || '').trim().toUpperCase();
  if (!pendingNavigationSymbol) {
    return {
      shouldApplyUrlSymbol: true,
      pendingNavigationSymbol: null,
    };
  }

  const urlContractSymbol = String(params.urlContractSymbol || '').trim().toUpperCase();
  if (urlContractSymbol === pendingNavigationSymbol) {
    return {
      shouldApplyUrlSymbol: true,
      pendingNavigationSymbol: null,
    };
  }

  return {
    shouldApplyUrlSymbol: false,
    pendingNavigationSymbol,
  };
}
