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
      reconnectGeneration: 0,
    });

    rerender({ status: 'disconnected' });
    expect(result.current).toEqual({
      preserveRealtimeAuthority: true,
      recoveryExpired: false,
      reconnectGeneration: 0,
    });

    act(() => jest.advanceTimersByTime(CONTRACT_MARKET_TRANSPORT_RECOVERY_GRACE_MS - 1));
    expect(result.current.preserveRealtimeAuthority).toBe(true);

    rerender({ status: 'connected' });
    act(() => jest.advanceTimersByTime(CONTRACT_MARKET_TRANSPORT_RECOVERY_GRACE_MS));
    expect(result.current).toEqual({
      preserveRealtimeAuthority: true,
      recoveryExpired: false,
      reconnectGeneration: 1,
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
      reconnectGeneration: 0,
    });

    rerender({ symbol: 'AAPLUSDT_PERP', status: 'reconnecting' });
    expect(result.current).toEqual({
      preserveRealtimeAuthority: false,
      recoveryExpired: false,
      reconnectGeneration: 0,
    });
  });

  it.each([
    'BTCUSDT_PERP',
    'AAPLUSDT_PERP',
    'XAUUSDT_PERP',
  ])('emits one recovery generation for %s across intermediate reconnect states', (symbol) => {
    type Props = { status: ContractMarketRealtimeStatus };
    const { result, rerender } = renderHook(
      ({ status }: Props) => useContractMarketTransportRecovery(symbol, status),
      { initialProps: { status: 'connected' } as Props },
    );

    rerender({ status: 'reconnecting' });
    rerender({ status: 'connecting' });
    act(() => jest.advanceTimersByTime(CONTRACT_MARKET_TRANSPORT_RECOVERY_GRACE_MS - 1));
    expect(result.current.preserveRealtimeAuthority).toBe(true);

    rerender({ status: 'connected' });
    expect(result.current.reconnectGeneration).toBe(1);

    rerender({ status: 'reconnecting' });
    rerender({ status: 'connected' });
    expect(result.current.reconnectGeneration).toBe(2);
  });

  it('does not leak a recovered session generation into a replacement symbol', () => {
    type Props = { symbol: string; status: ContractMarketRealtimeStatus };
    const { result, rerender } = renderHook(
      ({ symbol, status }: Props) => useContractMarketTransportRecovery(symbol, status),
      {
        initialProps: {
          symbol: 'BTCUSDT_PERP',
          status: 'connected',
        } as Props,
      },
    );

    rerender({ symbol: 'BTCUSDT_PERP', status: 'reconnecting' });
    rerender({ symbol: 'BTCUSDT_PERP', status: 'connected' });
    expect(result.current.reconnectGeneration).toBe(1);

    rerender({ symbol: 'AAPLUSDT_PERP', status: 'connected' });
    expect(result.current.reconnectGeneration).toBe(0);
  });
});
