import {
  useCallback,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from 'react';
import {
  getContractKlineRealtimeStore,
  type ContractKlineInterval,
} from '../realtime/contractKlineRealtime';

export function useContractKlineRealtime(
  symbol: string,
  interval: ContractKlineInterval,
  owner: string,
  active: boolean,
) {
  const store = useMemo(
    () => getContractKlineRealtimeStore(symbol, interval),
    [interval, symbol],
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
