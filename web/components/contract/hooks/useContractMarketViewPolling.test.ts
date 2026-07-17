import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  CONTRACT_MARKET_VIEW_FALLBACK_POLL_MS,
  getContractMarketViewPollInterval,
  useContractMarketViewPolling,
} from './useContractMarketViewPolling';
import type { ContractMarketRealtimeStatus } from '@/lib/realtime/contractMarketRealtime';

let visibilityState: DocumentVisibilityState;

function setVisibility(nextVisibility: DocumentVisibilityState) {
  visibilityState = nextVisibility;
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  jest.useFakeTimers();
  visibilityState = 'visible';
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibilityState,
  });
});

afterEach(() => {
  jest.useRealTimers();
});

describe('contract market view polling lifecycle', () => {
  it('disables REST polling while connected and uses it only as a visible fallback', () => {
    expect(getContractMarketViewPollInterval('connected', true)).toBeNull();
    expect(getContractMarketViewPollInterval('disconnected', true)).toBe(
      CONTRACT_MARKET_VIEW_FALLBACK_POLL_MS,
    );
    expect(getContractMarketViewPollInterval('connected', false)).toBeNull();
  });

  it('fetches on mount and symbol change without retaining the previous symbol timer', () => {
    const refresh = jest.fn<() => void>();
    const { rerender } = renderHook(
      ({ symbol }) => useContractMarketViewPolling({
        symbol,
        realtimeStatus: 'connected',
        refresh,
      }),
      { initialProps: { symbol: 'BTCUSDT_PERP' } },
    );

    expect(refresh).toHaveBeenCalledTimes(1);
    act(() => jest.advanceTimersByTime(CONTRACT_MARKET_VIEW_FALLBACK_POLL_MS * 20));
    expect(refresh).toHaveBeenCalledTimes(1);

    rerender({ symbol: 'ETHUSDT_PERP' });
    expect(refresh).toHaveBeenCalledTimes(2);
    act(() => jest.advanceTimersByTime(CONTRACT_MARKET_VIEW_FALLBACK_POLL_MS * 20));
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('restores fallback polling while disconnected and stops it after reconnect', () => {
    const refresh = jest.fn<() => void>();
    type HookProps = { realtimeStatus: ContractMarketRealtimeStatus };
    const { rerender } = renderHook(
      ({ realtimeStatus }: HookProps) => useContractMarketViewPolling({
        symbol: 'BTCUSDT_PERP',
        realtimeStatus,
        refresh,
      }),
      { initialProps: { realtimeStatus: 'connected' } as HookProps },
    );

    expect(refresh).toHaveBeenCalledTimes(1);
    rerender({ realtimeStatus: 'disconnected' });
    act(() => jest.advanceTimersByTime(CONTRACT_MARKET_VIEW_FALLBACK_POLL_MS * 3));
    expect(refresh).toHaveBeenCalledTimes(4);

    rerender({ realtimeStatus: 'connected' });
    expect(refresh).toHaveBeenCalledTimes(4);
    act(() => jest.advanceTimersByTime(CONTRACT_MARKET_VIEW_FALLBACK_POLL_MS * 3));
    expect(refresh).toHaveBeenCalledTimes(4);
  });

  it('stops hidden timers, refreshes once on visibility regain, and cleans up on unmount', () => {
    const refresh = jest.fn<() => void>();
    const removeEventListener = jest.spyOn(document, 'removeEventListener');
    const { unmount } = renderHook(() => useContractMarketViewPolling({
      symbol: 'BTCUSDT_PERP',
      realtimeStatus: 'disconnected',
      refresh,
    }));

    expect(refresh).toHaveBeenCalledTimes(1);
    act(() => setVisibility('hidden'));
    act(() => jest.advanceTimersByTime(CONTRACT_MARKET_VIEW_FALLBACK_POLL_MS * 3));
    expect(refresh).toHaveBeenCalledTimes(1);

    act(() => setVisibility('visible'));
    expect(refresh).toHaveBeenCalledTimes(2);
    act(() => jest.advanceTimersByTime(CONTRACT_MARKET_VIEW_FALLBACK_POLL_MS));
    expect(refresh).toHaveBeenCalledTimes(3);

    unmount();
    act(() => jest.advanceTimersByTime(CONTRACT_MARKET_VIEW_FALLBACK_POLL_MS * 2));
    expect(refresh).toHaveBeenCalledTimes(3);
    expect(removeEventListener).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
  });
});
