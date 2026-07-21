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
};

export function useContractMarketTransportRecovery(
  symbol: string,
  realtimeStatus: ContractMarketRealtimeStatus,
): ContractMarketTransportRecovery {
  const [phase, setPhase] = useState<'idle' | 'recovering' | 'expired'>('idle');
  const previousSymbolRef = useRef(symbol);
  const previousStatusRef = useRef<ContractMarketRealtimeStatus>(realtimeStatus);
  const sameSymbol = previousSymbolRef.current === symbol;
  const justLostConnection = sameSymbol
    && previousStatusRef.current === 'connected'
    && realtimeStatus !== 'connected';

  useEffect(() => {
    const symbolChanged = previousSymbolRef.current !== symbol;
    const previousStatus = previousStatusRef.current;
    previousSymbolRef.current = symbol;
    previousStatusRef.current = realtimeStatus;

    if (symbolChanged || realtimeStatus === 'connected') {
      setPhase('idle');
      return undefined;
    }
    if (previousStatus !== 'connected') return undefined;

    setPhase('recovering');
    const timer = window.setTimeout(() => {
      setPhase('expired');
    }, CONTRACT_MARKET_TRANSPORT_RECOVERY_GRACE_MS);
    return () => window.clearTimeout(timer);
  }, [realtimeStatus, symbol]);

  return {
    preserveRealtimeAuthority: realtimeStatus === 'connected'
      || justLostConnection
      || phase === 'recovering',
    recoveryExpired: sameSymbol
      && realtimeStatus !== 'connected'
      && phase === 'expired',
  };
}
