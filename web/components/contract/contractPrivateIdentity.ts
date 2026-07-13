export function normalizePrivateIdentity(identity: string | null) {
  return String(identity || '').trim();
}

export function hasPrivateIdentityChanged(previous: string | null, next: string | null) {
  return normalizePrivateIdentity(previous) !== normalizePrivateIdentity(next);
}

export function scopeContractPrivateCacheKey(identity: string | null, key: string) {
  return `${normalizePrivateIdentity(identity)}:${key}`;
}

export function canAcceptContractPrivateResult(
  requestedIdentity: string | null,
  currentIdentity: string | null,
) {
  const requested = normalizePrivateIdentity(requestedIdentity);
  return requested.length > 0 && requested === normalizePrivateIdentity(currentIdentity);
}

export function emptyContractPrivateCollections() {
  return {
    account: null,
    positions: [],
    positionSummaries: [],
    activeOrders: [],
    orders: [],
    trades: [],
  } as const;
}
