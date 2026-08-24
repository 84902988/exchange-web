import {useEffect} from 'react';
import type {MainTabParamList} from '../navigation/types';

export type PreloadableMainTab = Exclude<keyof MainTabParamList, 'Home'>;

export const MAIN_TAB_PRELOAD_ORDER: PreloadableMainTab[] = [
  'Markets',
  'Trade',
  'Contract',
  'Assets',
];

const PRELOAD_IDLE_TIMEOUT_MS = 1_500;
const PRELOAD_GAP_MS = 200;

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
      timeout: PRELOAD_IDLE_TIMEOUT_MS,
    });
    return () => idleGlobal.cancelIdleCallback?.(handle);
  }

  const handle = setTimeout(callback, 0);
  return () => clearTimeout(handle);
}

/**
 * Prepares the four non-home tabs one at a time after the home screen has
 * painted. React Navigation keeps these routes detached until selected, so
 * first navigation avoids a cold screen mount without enabling background
 * realtime work on unfocused market screens.
 */
export function usePreloadMainTabs(
  preload: (route: PreloadableMainTab) => void,
) {
  useEffect(() => {
    let cancelled = false;
    let cancelIdle: (() => void) | null = null;
    let gapTimer: ReturnType<typeof setTimeout> | null = null;

    const scheduleRoute = (index: number) => {
      if (cancelled || index >= MAIN_TAB_PRELOAD_ORDER.length) return;
      cancelIdle = scheduleWhenIdle(() => {
        cancelIdle = null;
        if (cancelled) return;
        preload(MAIN_TAB_PRELOAD_ORDER[index]);
        if (index + 1 >= MAIN_TAB_PRELOAD_ORDER.length) return;
        gapTimer = setTimeout(() => {
          gapTimer = null;
          scheduleRoute(index + 1);
        }, PRELOAD_GAP_MS);
      });
    };

    scheduleRoute(0);
    return () => {
      cancelled = true;
      cancelIdle?.();
      if (gapTimer !== null) clearTimeout(gapTimer);
    };
  }, [preload]);
}
