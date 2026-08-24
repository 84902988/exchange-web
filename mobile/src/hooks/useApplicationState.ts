import {useSyncExternalStore} from 'react';
import {AppState, type AppStateStatus} from 'react-native';

type Listener = () => void;

let currentState: AppStateStatus = AppState.currentState;
let nativeSubscription: {remove: () => void} | null = null;
const listeners = new Set<Listener>();

function emitIfChanged(nextState: AppStateStatus) {
  if (nextState === currentState) return;
  currentState = nextState;
  for (const listener of Array.from(listeners)) {
    listener();
  }
}

function ensureNativeSubscription() {
  if (nativeSubscription) return;
  currentState = AppState.currentState;
  nativeSubscription = AppState.addEventListener('change', emitIfChanged);
}

function subscribe(listener: Listener) {
  listeners.add(listener);
  ensureNativeSubscription();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && nativeSubscription) {
      nativeSubscription.remove();
      nativeSubscription = null;
    }
  };
}

function getSnapshot() {
  return currentState;
}

/**
 * Shares one native AppState subscription across every mounted tab. This keeps
 * background work authoritative without multiplying native listeners as the
 * five-tab shell becomes resident.
 */
export function useApplicationState() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function useApplicationActive() {
  return useApplicationState() === 'active';
}
