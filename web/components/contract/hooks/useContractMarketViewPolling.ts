'use client';

import { useEffect, useRef, useState } from 'react';
import type { ContractMarketRealtimeStatus } from '@/lib/realtime/contractMarketRealtime';

export const CONTRACT_MARKET_VIEW_FALLBACK_POLL_MS = 2_000;

function readDocumentVisibility() {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden';
}

export function useContractPageVisibility() {
  const [isPageVisible, setIsPageVisible] = useState(readDocumentVisibility);

  useEffect(() => {
    const handleVisibilityChange = () => {
      setIsPageVisible(readDocumentVisibility());
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, []);

  return isPageVisible;
}

export function getContractMarketViewPollInterval(
  realtimeStatus: ContractMarketRealtimeStatus,
  isPageVisible: boolean,
  recoveryRequired = false,
) {
  if (!isPageVisible) return null;
  return realtimeStatus === 'connected' && !recoveryRequired
    ? null
    : CONTRACT_MARKET_VIEW_FALLBACK_POLL_MS;
}

export function useContractMarketViewPolling({
  symbol,
  realtimeStatus,
  recoveryRequired = false,
  refresh,
}: {
  symbol: string;
  realtimeStatus: ContractMarketRealtimeStatus;
  recoveryRequired?: boolean;
  refresh: () => void | Promise<void>;
}) {
  const isPageVisible = useContractPageVisibility();
  const refreshRef = useRef(refresh);
  const previousVisibilityRef = useRef(isPageVisible);
  const previousRealtimeStatusRef = useRef(realtimeStatus);

  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  useEffect(() => {
    void refreshRef.current();
  }, [symbol]);

  useEffect(() => {
    const wasPageVisible = previousVisibilityRef.current;
    previousVisibilityRef.current = isPageVisible;
    if (isPageVisible && !wasPageVisible && realtimeStatus !== 'connected') {
      void refreshRef.current();
    }
  }, [isPageVisible, realtimeStatus]);

  useEffect(() => {
    const previousStatus = previousRealtimeStatusRef.current;
    previousRealtimeStatusRef.current = realtimeStatus;
    if (
      isPageVisible
      && realtimeStatus === 'connected'
      && (previousStatus === 'disconnected' || previousStatus === 'reconnecting')
    ) {
      void refreshRef.current();
    }
  }, [isPageVisible, realtimeStatus]);

  useEffect(() => {
    const intervalMs = getContractMarketViewPollInterval(
      realtimeStatus,
      isPageVisible,
      recoveryRequired,
    );
    if (intervalMs === null) return undefined;

    const timer = window.setInterval(() => {
      void refreshRef.current();
    }, intervalMs);

    return () => window.clearInterval(timer);
  }, [isPageVisible, realtimeStatus, recoveryRequired, symbol]);

  return isPageVisible;
}
