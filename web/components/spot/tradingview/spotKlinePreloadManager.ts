'use client';

import { normalizeSpotSymbol } from '@/lib/api/modules/spot';
import {
  buildKlineCachePerfPayload,
  fetchAndCacheCurrentKlineBars,
  getBackendKlineIntervalForSpotInterval,
  getPreloadKlineLimit,
  inspectCurrentKlineCache,
  normalizeSpotInterval,
} from './spotKlineClientCache';
import { markSpotKlinePerf } from './spotKlinePerf';

export const SPOT_KLINE_PRELOAD_COMMON_INTERVALS = ['4h', '1h', '15m', '5m', '1m'];
export const SPOT_KLINE_PRELOAD_COARSE_INTERVALS = ['1d', '1w', '1M'];
export const SPOT_KLINE_PRELOAD_DELAY_MS = 1800;

const SPOT_PRELOAD_ALLOWED_INTERVALS = new Set([
  ...SPOT_KLINE_PRELOAD_COMMON_INTERVALS,
  ...SPOT_KLINE_PRELOAD_COARSE_INTERVALS,
  '1Mutc',
  '1Wutc',
  '1Dutc',
]);
const SPOT_KLINE_PRELOAD_GAP_MS = 300;

type SpotKlinePreloadIdleHandle = {
  type: 'idle' | 'timeout';
  id: number;
};

type SpotKlinePreloadState = {
  symbol: string;
  interval: string;
  resolution: string;
};

export type SpotKlinePreloadHistoryEvent = {
  phase: 'current' | 'history';
  isHistoryRequest: boolean;
  symbol: string;
  resolution: string;
  interval: string;
  backendInterval: string;
  requiredBars: number;
  barCount: number;
};

export type SpotKlinePreloadManager = {
  schedule: (event: SpotKlinePreloadHistoryEvent, reason: string) => void;
  cancel: (reason: string) => void;
};

type PreloadSpotTradingViewKlineCacheOptions = {
  symbol: string;
  intervals: string[];
  concurrency?: number;
  shouldContinue?: () => boolean;
};

function getSpotKlinePreloadPerfNow() {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

function requestSpotKlinePreloadIdle(callback: () => void): SpotKlinePreloadIdleHandle {
  if (typeof window.requestIdleCallback === 'function') {
    return {
      type: 'idle',
      id: window.requestIdleCallback(callback, { timeout: 1200 }),
    };
  }

  return {
    type: 'timeout',
    id: window.setTimeout(callback, 0),
  };
}

function cancelSpotKlinePreloadIdle(handle: SpotKlinePreloadIdleHandle | null) {
  if (!handle) return;
  if (handle.type === 'idle' && typeof window.cancelIdleCallback === 'function') {
    window.cancelIdleCallback(handle.id);
    return;
  }
  window.clearTimeout(handle.id);
}

function waitForSpotKlinePreloadGap(shouldContinue?: () => boolean) {
  if (shouldContinue && !shouldContinue()) return Promise.resolve();
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, SPOT_KLINE_PRELOAD_GAP_MS);
  });
}

function isSpotPreloadAllowedInterval(interval: string) {
  return SPOT_PRELOAD_ALLOWED_INTERVALS.has(normalizeSpotInterval(interval));
}

function markSpotKlinePreloadSkipCached(params: {
  symbol: string;
  interval: string;
  limit: number;
  cacheLookup: ReturnType<typeof inspectCurrentKlineCache>;
  reason: string;
}) {
  const cached = params.cacheLookup.hit;
  if (!cached) return;
  markSpotKlinePerf(cached.terminalComplete
    ? 'kline_preload_skip_terminal_complete'
    : 'kline_preload_skip_cached', {
    ...buildKlineCachePerfPayload(cached, {
      symbol: params.symbol,
      interval: params.interval,
      limit: params.limit,
    }),
    reason: params.reason,
    cache_age_ms: params.cacheLookup.cacheAgeMs ?? null,
  });
}

export function getSpotPreloadIntervals() {
  return [
    ...SPOT_KLINE_PRELOAD_COMMON_INTERVALS,
    ...SPOT_KLINE_PRELOAD_COARSE_INTERVALS,
  ];
}

export async function preloadSpotTradingViewKlineCache({
  symbol,
  intervals,
  concurrency = 1,
  shouldContinue,
}: PreloadSpotTradingViewKlineCacheOptions) {
  const normalizedSymbol = normalizeSpotSymbol(symbol);
  if (!normalizedSymbol) return;

  const queue: Array<{ interval: string; limit: number }> = [];
  const seenIntervals = new Set<string>();

  for (const requestedInterval of intervals) {
    const interval = getBackendKlineIntervalForSpotInterval(normalizeSpotInterval(requestedInterval));
    if (!interval || seenIntervals.has(interval)) continue;
    seenIntervals.add(interval);
    const limit = getPreloadKlineLimit(interval);
    if (!isSpotPreloadAllowedInterval(interval)) {
      markSpotKlinePerf('kline_preload_cancel', {
        symbol: normalizedSymbol,
        interval,
        backendInterval: interval,
        limit,
        reason: 'interval not in common preload set',
      });
      continue;
    }
    const cacheLookup = inspectCurrentKlineCache(normalizedSymbol, interval, limit, { minBars: limit });
    if (cacheLookup.hit) {
      markSpotKlinePreloadSkipCached({
        symbol: normalizedSymbol,
        interval,
        limit,
        cacheLookup,
        reason: 'fresh cache already available',
      });
      continue;
    }
    queue.push({ interval, limit });
  }

  if (!queue.length) return;

  const workerCount = Math.max(1, Math.min(Math.floor(concurrency || 1), 1, queue.length));
  let cursor = 0;
  const shouldRun = () => !shouldContinue || shouldContinue();

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (shouldRun()) {
      const item = queue[cursor++];
      if (!item) return;
      const startedAt = getSpotKlinePreloadPerfNow();
      try {
        const cacheLookup = inspectCurrentKlineCache(normalizedSymbol, item.interval, item.limit, {
          minBars: item.limit,
        });
        if (cacheLookup.hit) {
          markSpotKlinePreloadSkipCached({
            symbol: normalizedSymbol,
            interval: item.interval,
            limit: item.limit,
            cacheLookup,
            reason: 'fresh cache already available before preload',
          });
          await waitForSpotKlinePreloadGap(shouldContinue);
          continue;
        }
        markSpotKlinePerf('kline_preload_start', {
          symbol: normalizedSymbol,
          interval: item.interval,
          backendInterval: item.interval,
          limit: item.limit,
          reason: 'idle preload',
        });
        const cached = await fetchAndCacheCurrentKlineBars({
          symbol: normalizedSymbol,
          interval: item.interval,
          limit: item.limit,
          shouldStore: shouldRun,
        });
        if (!shouldRun()) {
          markSpotKlinePerf('kline_preload_cancel', {
            symbol: normalizedSymbol,
            interval: item.interval,
            backendInterval: item.interval,
            limit: item.limit,
            duration_ms: Math.max(0, getSpotKlinePreloadPerfNow() - startedAt),
            bars_count: cached?.bars.length || 0,
            reason: 'preload cancelled before store',
          });
          return;
        }
        markSpotKlinePerf('kline_preload_success', {
          ...(cached
            ? buildKlineCachePerfPayload(cached, {
              symbol: normalizedSymbol,
              interval: item.interval,
              limit: item.limit,
            })
            : {
              symbol: normalizedSymbol,
              interval: item.interval,
              backendInterval: item.interval,
              limit: item.limit,
              bars_count: 0,
            }),
          duration_ms: Math.max(0, getSpotKlinePreloadPerfNow() - startedAt),
          reason: cached ? 'preload stored' : 'preload returned no bars',
        });
      } catch (err) {
        markSpotKlinePerf('kline_preload_error', {
          symbol: normalizedSymbol,
          interval: item.interval,
          backendInterval: item.interval,
          limit: item.limit,
          duration_ms: Math.max(0, getSpotKlinePreloadPerfNow() - startedAt),
          reason: 'preload request failed',
          error: err instanceof Error ? err.message : String(err),
        });
        if (process.env.NODE_ENV !== 'production') {
          console.debug('[SpotKlinePreloadManager] preload kline cache failed', {
            symbol: normalizedSymbol,
            interval: item.interval,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      await waitForSpotKlinePreloadGap(shouldContinue);
    }
    if (!shouldRun()) {
      markSpotKlinePerf('kline_preload_cancel', {
        symbol: normalizedSymbol,
        reason: 'preload sequence cancelled',
      });
    }
  }));
}

export function createSpotKlinePreloadManager(params: {
  getState: () => SpotKlinePreloadState;
}): SpotKlinePreloadManager {
  let preloadTimer: number | null = null;
  let preloadIdle: SpotKlinePreloadIdleHandle | null = null;
  let preloadOwnerSymbol = '';
  let preloadRunning = false;
  let preloadSeq = 0;

  const cancel = (reason: string) => {
    const hadPendingWork = preloadTimer !== null || preloadIdle !== null;
    preloadSeq += 1;
    if (preloadTimer !== null) {
      window.clearTimeout(preloadTimer);
      preloadTimer = null;
    }
    if (preloadIdle) {
      cancelSpotKlinePreloadIdle(preloadIdle);
      preloadIdle = null;
    }
    preloadOwnerSymbol = '';
    preloadRunning = false;
    if (hadPendingWork) {
      const state = params.getState();
      markSpotKlinePerf('kline_preload_cancel', {
        symbol: state.symbol,
        interval: state.interval,
        reason,
      });
    }
  };

  const schedule = (event: SpotKlinePreloadHistoryEvent, reason: string) => {
    if (event.isHistoryRequest || event.phase !== 'current' || !event.barCount) return;

    const state = params.getState();
    const activeSymbol = normalizeSpotSymbol(state.symbol);
    const activeInterval = state.interval || event.interval || '1m';
    const activeResolution = state.resolution;
    const eventSymbol = normalizeSpotSymbol(event.symbol);
    if (!activeSymbol || eventSymbol !== activeSymbol || event.resolution !== activeResolution) return;

    const eventInterval = event.interval || activeInterval;
    const eventBackendInterval = event.backendInterval || getBackendKlineIntervalForSpotInterval(eventInterval);
    const intervals = getSpotPreloadIntervals();
    if (!intervals.length) return;

    if (preloadOwnerSymbol && preloadOwnerSymbol !== activeSymbol) {
      cancel('symbol changed before preload schedule');
    }
    if (
      preloadOwnerSymbol === activeSymbol &&
      (preloadTimer !== null || preloadIdle !== null || preloadRunning)
    ) {
      return;
    }

    const scheduleSeq = ++preloadSeq;
    preloadOwnerSymbol = activeSymbol;
    markSpotKlinePerf('kline_preload_schedule', {
      symbol: activeSymbol,
      interval: eventInterval,
      backendInterval: eventBackendInterval,
      bars_count: event.barCount,
      limit: event.requiredBars,
      intervals,
      delay_ms: SPOT_KLINE_PRELOAD_DELAY_MS,
      reason,
    });
    preloadTimer = window.setTimeout(() => {
      preloadTimer = null;
      if (preloadSeq !== scheduleSeq) return;
      preloadIdle = requestSpotKlinePreloadIdle(() => {
        preloadIdle = null;
        if (preloadSeq !== scheduleSeq) return;
        preloadRunning = true;
        void preloadSpotTradingViewKlineCache({
          symbol: activeSymbol,
          intervals,
          concurrency: 1,
          shouldContinue: () => (
            preloadSeq === scheduleSeq &&
            normalizeSpotSymbol(params.getState().symbol) === activeSymbol
          ),
        }).catch((err: unknown) => {
          if (process.env.NODE_ENV !== 'production') {
            console.debug('[SpotKlinePreloadManager] preload kline cache failed', {
              symbol: activeSymbol,
              interval: activeInterval,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }).finally(() => {
          if (preloadSeq === scheduleSeq && preloadOwnerSymbol === activeSymbol) {
            preloadOwnerSymbol = '';
            preloadRunning = false;
          }
        });
      });
    }, SPOT_KLINE_PRELOAD_DELAY_MS);
  };

  return {
    schedule,
    cancel,
  };
}
