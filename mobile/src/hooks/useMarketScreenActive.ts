import {useEffect, useState} from 'react';
import type {AppStateStatus} from 'react-native';
import {useIsFocused} from '@react-navigation/native';
import {useApplicationActive} from './useApplicationState';

const ACTIVATION_IDLE_TIMEOUT_MS = 100;

type IdleCallbackGlobal = typeof globalThis & {
  requestIdleCallback?: (
    callback: () => void,
    options?: {timeout?: number},
  ) => number;
  cancelIdleCallback?: (handle: number) => void;
};

function scheduleAfterFocusedPaint(callback: () => void) {
  const idleGlobal = globalThis as IdleCallbackGlobal;
  if (typeof idleGlobal.requestIdleCallback === 'function') {
    const handle = idleGlobal.requestIdleCallback(callback, {
      timeout: ACTIVATION_IDLE_TIMEOUT_MS,
    });
    return () => idleGlobal.cancelIdleCallback?.(handle);
  }

  const handle = setTimeout(callback, 0);
  return () => clearTimeout(handle);
}

export function isMarketScreenActive(
  focused: boolean,
  appState: AppStateStatus,
) {
  return focused && appState === 'active';
}

export function useMarketScreenActive() {
  const focused = useIsFocused();
  const applicationActive = useApplicationActive();
  const shouldActivate = focused && applicationActive;
  const [active, setActive] = useState(false);

  useEffect(() => {
    if (!shouldActivate) {
      setActive(false);
      return undefined;
    }

    return scheduleAfterFocusedPaint(() => setActive(true));
  }, [shouldActivate]);

  return shouldActivate && active;
}
