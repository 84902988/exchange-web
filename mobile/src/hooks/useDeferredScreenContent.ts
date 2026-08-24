import { useEffect, useState } from 'react';

const IDLE_TIMEOUT_MS = 500;

type IdleCallbackGlobal = typeof globalThis & {
  requestIdleCallback?: (
    callback: () => void,
    options?: {timeout?: number},
  ) => number;
  cancelIdleCallback?: (handle: number) => void;
};

function scheduleWhenIdle(callback: () => void) {
  const idleGlobal = globalThis as IdleCallbackGlobal;
  if (typeof idleGlobal.requestIdleCallback === 'function') {
    const handle = idleGlobal.requestIdleCallback(callback, {
      timeout: IDLE_TIMEOUT_MS,
    });
    return () => idleGlobal.cancelIdleCallback?.(handle);
  }

  const handle = setTimeout(callback, 0);
  return () => clearTimeout(handle);
}

/**
 * Lets the focused screen paint its trading controls before mounting the
 * below-the-fold chart and records tree. The heavy content is released while
 * the tab is inactive, then deferred again after the next focus transition.
 */
export function useDeferredScreenContent(active: boolean) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!active) {
      setReady(false);
      return undefined;
    }
    return scheduleWhenIdle(() => setReady(true));
  }, [active]);

  return active && ready;
}
