import { describe, expect, it } from '@jest/globals';

import { ContractPrivateRefreshCoordinator } from './contractPrivateRefreshCoordinator';

describe('ContractPrivateRefreshCoordinator', () => {
  it('coalesces repeated structural refreshes into one trailing replay', () => {
    const coordinator = new ContractPrivateRefreshCoordinator();

    expect(coordinator.request('user:current:BTC')).toBe('START');
    expect(coordinator.request('user:current:BTC')).toBe('COALESCED');
    expect(coordinator.request('user:current:BTC')).toBe('COALESCED');
    expect(coordinator.settle('user:current:BTC')).toBe(true);
    expect(coordinator.request('user:current:BTC')).toBe('START');
    expect(coordinator.settle('user:current:BTC')).toBe(false);
  });

  it('does not serialize independent user or scope keys behind each other', () => {
    const coordinator = new ContractPrivateRefreshCoordinator();

    expect(coordinator.request('user-a:current:BTC')).toBe('START');
    expect(coordinator.request('user-a:all:BTC')).toBe('START');
    expect(coordinator.request('user-b:current:BTC')).toBe('START');
  });

  it('replays every active scope once after a structural event invalidates it', () => {
    const coordinator = new ContractPrivateRefreshCoordinator();

    expect(coordinator.request('user:current:BTC')).toBe('START');
    expect(coordinator.request('user:orders:BTC')).toBe('START');

    coordinator.replayActive();
    coordinator.replayActive();

    expect(coordinator.settle('user:current:BTC')).toBe(true);
    expect(coordinator.settle('user:orders:BTC')).toBe(true);
    expect(coordinator.settle('user:current:BTC')).toBe(false);
  });

  it('does not create replay work when no refresh is active', () => {
    const coordinator = new ContractPrivateRefreshCoordinator();

    coordinator.replayActive();

    expect(coordinator.request('user:current:BTC')).toBe('START');
    expect(coordinator.settle('user:current:BTC')).toBe(false);
  });

  it('drops pending ownership when identity state is reset', () => {
    const coordinator = new ContractPrivateRefreshCoordinator();

    expect(coordinator.request('old-user:current:BTC')).toBe('START');
    expect(coordinator.request('old-user:current:BTC')).toBe('COALESCED');
    coordinator.reset();

    expect(coordinator.request('old-user:current:BTC')).toBe('START');
    expect(coordinator.settle('old-user:current:BTC')).toBe(false);
  });
});
