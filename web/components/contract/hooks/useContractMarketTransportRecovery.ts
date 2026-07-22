'use client';

import { useEffect, useRef, useState } from 'react';
import type { ContractMarketRealtimeStatus } from '@/lib/realtime/contractMarketRealtime';

// The public market socket reconnects after 1.5s. Keep the last accepted Store
// snapshot across one reconnect cycle so a transport hand-off cannot masquerade
// as an authoritative market close or quote expiry.
export const CONTRACT_MARKET_TRANSPORT_RECOVERY_GRACE_MS = 2_500;

type ContractMarketTransportRecovery = {
  preserveRealtimeAuthority: boolean;
  recoveryExpired: boolean;
  reconnectGeneration: number;
};

export function useContractMarketTransportRecovery(
  symbol: string,
  realtimeStatus: ContractMarketRealtimeStatus,
): ContractMarketTransportRecovery {
  const [phase, setPhase] = useState<'idle' | 'recovering' | 'expired'>('idle');
  const [reconnectGeneration, setReconnectGeneration] = useState(0);
  const previousSymbolRef = useRef(symbol);
  const previousStatusRef = useRef<ContractMarketRealtimeStatus>(realtimeStatus);
  const recoveryPendingRef = useRef(false);
  const recoveryTimerRef = useRef<number | null>(null);
  const sameSymbol = previousSymbolRef.current === symbol;
  const justLostConnection = sameSymbol
    && previousStatusRef.current === 'connected'
    && realtimeStatus !== 'connected';

  useEffect(() => {
    const symbolChanged = previousSymbolRef.current !== symbol;
    const previousStatus = previousStatusRef.current;
    previousSymbolRef.current = symbol;
    previousStatusRef.current = realtimeStatus;

    if (symbolChanged) {
      if (recoveryTimerRef.current !== null) {
        window.clearTimeout(recoveryTimerRef.current);
        recoveryTimerRef.current = null;
      }
      recoveryPendingRef.current = false;
      setReconnectGeneration(0);
      setPhase('idle');
      return;
    }

    if (realtimeStatus === 'connected') {
      if (recoveryTimerRef.current !== null) {
        window.clearTimeout(recoveryTimerRef.current);
        recoveryTimerRef.current = null;
      }
      if (recoveryPendingRef.current) {
        recoveryPendingRef.current = false;
        setReconnectGeneration((value) => value + 1);
      }
      setPhase('idle');
      return;
    }

    if (previousStatus !== 'connected') return;

    recoveryPendingRef.current = true;
    setPhase('recovering');
    if (recoveryTimerRef.current !== null) {
      window.clearTimeout(recoveryTimerRef.current);
    }
    recoveryTimerRef.current = window.setTimeout(() => {
      recoveryTimerRef.current = null;
      setPhase('expired');
    }, CONTRACT_MARKET_TRANSPORT_RECOVERY_GRACE_MS);
  }, [realtimeStatus, symbol]);

  useEffect(() => () => {
    if (recoveryTimerRef.current !== null) {
      window.clearTimeout(recoveryTimerRef.current);
      recoveryTimerRef.current = null;
    }
  }, []);

  return {
    preserveRealtimeAuthority: realtimeStatus === 'connected'
      || justLostConnection
      || phase === 'recovering',
    recoveryExpired: sameSymbol
      && realtimeStatus !== 'connected'
      && phase === 'expired',
    reconnectGeneration: sameSymbol ? reconnectGeneration : 0,
  };
}
