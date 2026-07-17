import { describe, expect, test } from '@jest/globals';
import {
  resolveContractRestBootstrap,
  type ContractRestBootstrapCursor,
} from './contractRestBootstrapPolicy';

describe('Contract REST bootstrap policy', () => {
  test('one symbol bootstrap is not repeated while realtime connects', () => {
    let cursor: ContractRestBootstrapCursor = { key: null, realtimeStatus: 'idle' };
    const decisions = ['idle', 'connecting', 'connected', 'connected'].map((status) => {
      const decision = resolveContractRestBootstrap(cursor, 'BTCUSDT_PERP|0', status);
      cursor = decision.next;
      return decision.shouldRefresh;
    });

    expect(decisions).toEqual([true, false, false, false]);
  });

  test('symbol/session changes and realtime loss each trigger exactly one refresh', () => {
    let cursor: ContractRestBootstrapCursor = { key: null, realtimeStatus: 'idle' };
    const step = (key: string, status: string) => {
      const decision = resolveContractRestBootstrap(cursor, key, status);
      cursor = decision.next;
      return decision.shouldRefresh;
    };

    expect(step('BTCUSDT_PERP|0', 'connected')).toBe(true);
    expect(step('ETHUSDT_PERP|0', 'connected')).toBe(true);
    expect(step('ETHUSDT_PERP|0', 'connected')).toBe(false);
    expect(step('ETHUSDT_PERP|0', 'reconnecting')).toBe(true);
    expect(step('ETHUSDT_PERP|0', 'idle')).toBe(false);
    expect(step('ETHUSDT_PERP|1', 'idle')).toBe(true);
  });
});
