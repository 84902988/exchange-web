import {
  useCallback,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from 'react';
import {getContractMarketRealtimeStore} from '../realtime/contractMarketRealtime';

export function useContractMarketRealtime(
  symbol: string,
  owner: string,
  active: boolean,
) {
  const store = useMemo(
    () => getContractMarketRealtimeStore(symbol),
    [symbol],
  );
  const subscribe = useCallback(
    (listener: () => void) =>
      active ? store.subscribe(listener) : () => undefined,
    [active, store],
  );
  const state = useSyncExternalStore(
    subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );

  useEffect(() => {
    if (!active) return;
    return store.acquire(owner);
  }, [active, owner, store]);

  return state;
}
