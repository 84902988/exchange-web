import { describe, expect, it } from '@jest/globals';
import {
  canAcceptContractPrivateResult,
  emptyContractPrivateCollections,
  hasPrivateIdentityChanged,
  scopeContractPrivateCacheKey,
} from './contractPrivateIdentity';

describe('contract private identity state', () => {
  it('scopes local caches by user identity', () => {
    expect(scopeContractPrivateCacheKey('user-a', 'positions:all'))
      .not.toBe(scopeContractPrivateCacheKey('user-b', 'positions:all'));
  });

  it('rejects anonymous and stale identity results', () => {
    expect(canAcceptContractPrivateResult(null, null)).toBe(false);
    expect(canAcceptContractPrivateResult('user-a', 'user-b')).toBe(false);
    expect(canAcceptContractPrivateResult('user-b', 'user-b')).toBe(true);
  });

  it('clears account, positions, orders, and private trades together', () => {
    expect(emptyContractPrivateCollections()).toEqual({
      account: null,
      positions: [],
      positionSummaries: [],
      activeOrders: [],
      orders: [],
      trades: [],
    });
  });

  it('does not reset the same identity twice', () => {
    expect(hasPrivateIdentityChanged('user-a', 'user-a')).toBe(false);
    expect(hasPrivateIdentityChanged('user-a', 'user-b')).toBe(true);
  });
});
