import {
  useCallback,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from 'react';
import {getSpotMarketRealtimeStore} from '../realtime/spotMarketRealtime';

export function useSpotMarketRealtime(
  symbol: string,
  owner: string,
  active: boolean,
) {
  const store = useMemo(
    () => getSpotMarketRealtimeStore(symbol),
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
