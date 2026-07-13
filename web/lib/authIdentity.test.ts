import { describe, expect, it } from '@jest/globals';
import { getUserIdentityKey, hasAuthIdentityChanged } from './authIdentity';

describe('auth identity lifecycle', () => {
  it('maps anonymous to null and authenticated users to the immutable /me id', () => {
    expect(getUserIdentityKey(null)).toBeNull();
    expect(getUserIdentityKey({ id: 42 })).toBe('42');
    expect(getUserIdentityKey({ id: 'user-a' })).toBe('user-a');
  });

  it.each([
    [null, 'user-a', true],
    ['user-a', null, true],
    ['user-a', 'user-b', true],
    ['user-a', 'user-a', false],
  ])('detects %s -> %s as changed=%s', (previous, next, changed) => {
    expect(hasAuthIdentityChanged(previous, next)).toBe(changed);
  });
});
