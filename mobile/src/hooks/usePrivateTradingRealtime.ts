import {useEffect, useRef, useState} from 'react';
import {
  getApiAccessTokenSnapshot,
  subscribeApiAccessToken,
} from '../api/client';
import {
  ManagedPrivateTradingWebSocket,
  type PrivateTradingMarket,
  type PrivateTradingRealtimeEvent,
  type PrivateTradingRealtimeStatus,
} from '../realtime/privateTradingRealtime';

type UsePrivateTradingRealtimeOptions = {
  market: PrivateTradingMarket;
  symbol: string;
  enabled: boolean;
  onInvalidate: (event: PrivateTradingRealtimeEvent) => void;
};

export function usePrivateTradingRealtime({
  market,
  symbol,
  enabled,
  onInvalidate,
}: UsePrivateTradingRealtimeOptions) {
  const onInvalidateRef = useRef(onInvalidate);
  onInvalidateRef.current = onInvalidate;
  const [authSnapshot, setAuthSnapshot] = useState(
    getApiAccessTokenSnapshot,
  );
  const [status, setStatus] = useState<PrivateTradingRealtimeStatus>('idle');

  useEffect(() => subscribeApiAccessToken(setAuthSnapshot), []);

  useEffect(() => {
    if (
      !enabled ||
      !authSnapshot.accessToken
    ) {
      setStatus('idle');
      return;
    }
    if (typeof WebSocket === 'undefined') {
      setStatus('stopped');
      return;
    }

    let released = false;
    const client = new ManagedPrivateTradingWebSocket({
      market,
      symbol,
      accessToken: authSnapshot.accessToken,
      onInvalidate: event => onInvalidateRef.current(event),
      onStatusChange: nextStatus => {
        if (!released) setStatus(nextStatus);
      },
    });
    client.start();
    return () => {
      released = true;
      client.stop('private trading screen released');
    };
  }, [
    authSnapshot.accessToken,
    authSnapshot.sessionEpoch,
    enabled,
    market,
    symbol,
  ]);

  return status;
}
