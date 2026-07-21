import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { ContractMarketRealtimeStatus } from '@/lib/realtime/contractMarketRealtime';
import {
  CONTRACT_MARKET_TRANSPORT_RECOVERY_GRACE_MS,
  useContractMarketTransportRecovery,
} from './useContractMarketTransportRecovery';

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('contract market transport recovery window', () => {
  it('preserves accepted realtime authority across one short reconnect', () => {
    type Props = { status: ContractMarketRealtimeStatus };
    const { result, rerender } = renderHook(
      ({ status }: Props) => useContractMarketTransportRecovery('EURUSD_PERP', status),
      { initialProps: { status: 'connected' } as Props },
    );

    expect(result.current).toEqual({
      preserveRealtimeAuthority: true,
      recoveryExpired: false,
    });

    rerender({ status: 'disconnected' });
    expect(result.current).toEqual({
      preserveRealtimeAuthority: true,
      recoveryExpired: false,
    });

    act(() => jest.advanceTimersByTime(CONTRACT_MARKET_TRANSPORT_RECOVERY_GRACE_MS - 1));
    expect(result.current.preserveRealtimeAuthority).toBe(true);

    rerender({ status: 'connected' });
    act(() => jest.advanceTimersByTime(CONTRACT_MARKET_TRANSPORT_RECOVERY_GRACE_MS));
    expect(result.current).toEqual({
      preserveRealtimeAuthority: true,
      recoveryExpired: false,
    });
  });

  it('expires the snapshot after a sustained disconnect and resets per symbol', () => {
    type Props = { symbol: string; status: ContractMarketRealtimeStatus };
    const { result, rerender } = renderHook(
      ({ symbol, status }: Props) => useContractMarketTransportRecovery(symbol, status),
      { initialProps: { symbol: 'XAUUSDT_PERP', status: 'connected' } as Props },
    );

    rerender({ symbol: 'XAUUSDT_PERP', status: 'reconnecting' });
    act(() => jest.advanceTimersByTime(CONTRACT_MARKET_TRANSPORT_RECOVERY_GRACE_MS));
    expect(result.current).toEqual({
      preserveRealtimeAuthority: false,
      recoveryExpired: true,
    });

    rerender({ symbol: 'AAPLUSDT_PERP', status: 'reconnecting' });
    expect(result.current).toEqual({
      preserveRealtimeAuthority: false,
      recoveryExpired: false,
    });
  });
});
