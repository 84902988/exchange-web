'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

type UseSpotPollingOptions = {
  normalInterval?: number;
  fastInterval?: number;
  fastDuration?: number;
};

export function useSpotPolling(options?: UseSpotPollingOptions) {
  const {
    normalInterval = 1500,
    fastInterval = 600,
    fastDuration = 6000,
  } = options || {};

  const [refreshNonce, setRefreshNonce] = useState(0);
  const [isFastMode, setIsFastMode] = useState(false);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fastModeUntilRef = useRef<number>(0);

  const tick = useCallback(() => {
    setRefreshNonce((prev) => prev + 1);
  }, []);

  const triggerImmediateRefresh = useCallback(
    (fast = false) => {
      tick();

      if (fast) {
        setIsFastMode(true);
        fastModeUntilRef.current = Date.now() + fastDuration;
      }
    },
    [tick, fastDuration]
  );

  useEffect(() => {
    let destroyed = false;

    const schedule = () => {
      if (destroyed) return;

      const now = Date.now();
      const inFastMode = fastModeUntilRef.current > now;

      if (!inFastMode && isFastMode) {
        setIsFastMode(false);
      }

      const nextInterval = inFastMode ? fastInterval : normalInterval;

      timerRef.current = setTimeout(() => {
        tick();
        schedule();
      }, nextInterval);
    };

    schedule();

    return () => {
      destroyed = true;
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, [normalInterval, fastInterval, isFastMode, tick]);

  return {
    refreshNonce,
    isFastMode,
    triggerImmediateRefresh,
  };
}