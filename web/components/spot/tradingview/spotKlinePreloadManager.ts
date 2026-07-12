'use client';

import { normalizeSpotSymbol } from '@/lib/api/modules/spot';
import {
  buildKlineCachePerfPayload,
  fetchAndCacheCurrentKlineBars,
  getBackendKlineIntervalForSpotInterval,
  inspectCurrentKlineCache,
  normalizeSpotInterval,
  writeCurrentKlineCache,
  type SpotKlineRevisionCandidate,
  type SpotTradingViewBar,
} from './spotKlineClientCache';
import { markSpotKlinePerf } from './spotKlinePerf';

export const SPOT_KLINE_PRELOAD_COMMON_INTERVALS = ['4h', '1h', '15m', '5m', '1m'];
export const SPOT_KLINE_PRELOAD_COARSE_INTERVALS = ['1d', '1w', '1M'];
export const SPOT_KLINE_PRELOAD_DELAY_MS = 1800;

const SPOT_KLINE_PRELOAD_LIMIT_BY_INTERVAL: Readonly<Record<string, number>> = {
  '1m': 360,
  '5m': 360,
  '15m': 360,
  '1h': 360,
  '4h': 360,
  '1Dutc': 120,
  '1Wutc': 80,
  '1Mutc': 360,
};

const SPOT_PRELOAD_ALLOWED_INTERVALS = new Set([
  ...SPOT_KLINE_PRELOAD_COMMON_INTERVALS,
  ...SPOT_KLINE_PRELOAD_COARSE_INTERVALS,
  '1Mutc',
  '1Wutc',
  '1Dutc',
]);
const SPOT_KLINE_PRELOAD_GAP_MS = 300;

export function getSpotKlinePreloadLimit(interval: string): number {
  const backendInterval = getBackendKlineIntervalForSpotInterval(
    normalizeSpotInterval(interval),
  );
  return SPOT_KLINE_PRELOAD_LIMIT_BY_INTERVAL[backendInterval] ?? 360;
}

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
  setForegroundState: (state: SpotKlinePreloadForegroundState) => void;
};

export type SpotKlinePreloadForegroundState = {
  loading: boolean;
  symbol: string;
  interval: string;
  generation: number;
};

type PreloadSpotTradingViewKlineCacheOptions = {
  symbol: string;
  intervals: string[];
  activeInterval?: string;
  concurrency?: number;
  shouldContinue?: () => boolean;
};

export type SpotKlineInFlightRole = 'active' | 'revalidate' | 'preload';

const SPOT_KLINE_INFLIGHT_DEADLINE_MS: Record<SpotKlineInFlightRole, number> = {
  active: 15_000,
  revalidate: 15_000,
  preload: 15_000,
};

export type SpotKlineInFlightResult = {
  bars: SpotTradingViewBar[];
  revisionCandidates: SpotKlineRevisionCandidate[];
  provider?: unknown;
  source?: unknown;
  coverageKey?: string;
  coverageComplete?: boolean;
  terminalComplete?: boolean;
  historyTerminal?: boolean;
  terminalReason?: string | null;
  earliestBoundary?: number | null;
  history_terminal?: unknown;
  terminal_reason?: unknown;
  earliest_available_time?: unknown;
};

function getSpotKlineInFlightTerminalMetadata(result: SpotKlineInFlightResult | null | undefined) {
  const historyTerminal = result?.historyTerminal === true || result?.history_terminal === true;
  const terminalReason = String(result?.terminalReason || result?.terminal_reason || '').trim() || null;
  const earliestBoundary = Number(result?.earliestBoundary || result?.earliest_available_time);
  const valid = Boolean(
    historyTerminal
    && terminalReason
    && Number.isFinite(earliestBoundary)
    && earliestBoundary > 0
  );
  return {
    historyTerminal: valid,
    terminalReason: valid ? terminalReason : null,
    earliestBoundary: valid ? earliestBoundary : null,
  };
}

type SpotKlineInFlightReuseContext = {
  requestedBars: number;
  existingRequestedBars: number;
  existingRole: SpotKlineInFlightRole;
};

type SpotKlineInFlightEntry = {
  symbol: string;
  interval: string;
  requestedBars: number;
  promise: Promise<SpotKlineInFlightResult>;
  startedAt: number;
  deadlineAt: number;
  role: SpotKlineInFlightRole;
  leaseId: number;
  waiterCount: number;
  settled: boolean;
  timeoutHandle: ReturnType<typeof setTimeout> | null;
  reject: (reason: unknown) => void;
};

type SpotKlineInFlightMetrics = {
  inflightHitCount: number;
  inflightJoinCount: number;
  duplicateRequestAvoidedCount: number;
  preloadSkippedCount: number;
  preloadJoinedCount: number;
  inflightTimeoutCount: number;
  inflightEvictionCount: number;
  inflightLateResultDropCount: number;
};

const spotKlineInFlightByKey = new Map<string, SpotKlineInFlightEntry>();
const spotKlineInFlightMetrics: SpotKlineInFlightMetrics = {
  inflightHitCount: 0,
  inflightJoinCount: 0,
  duplicateRequestAvoidedCount: 0,
  preloadSkippedCount: 0,
  preloadJoinedCount: 0,
  inflightTimeoutCount: 0,
  inflightEvictionCount: 0,
  inflightLateResultDropCount: 0,
};
let spotKlineInFlightLeaseSequence = 0;

class SpotKlineInFlightTimeoutError extends Error {
  constructor(symbol: string, interval: string, role: SpotKlineInFlightRole) {
    super(`Spot Kline ${role} request timed out for ${symbol} ${interval}`);
    this.name = 'SpotKlineInFlightTimeoutError';
  }
}

type SpotKlineInFlightLease = {
  leaseId: number;
  deadlineAt: number;
  isCurrent: () => boolean;
};

function getSpotKlineInFlightKey(symbol: string, interval: string) {
  return `${normalizeSpotSymbol(symbol)}:${normalizeSpotInterval(interval)}`;
}

function markSpotKlineInFlightMetric(
  event: string,
  params: {
    symbol: string;
    interval: string;
    requestedBars: number;
    existing?: SpotKlineInFlightEntry;
    role: SpotKlineInFlightRole;
    reason: string;
  },
) {
  markSpotKlinePerf(event, {
    symbol: normalizeSpotSymbol(params.symbol),
    interval: normalizeSpotInterval(params.interval),
    requested_bars: params.requestedBars,
    inflight_requested_bars: params.existing?.requestedBars ?? null,
    inflight_role: params.existing?.role ?? null,
    role: params.role,
    started_at: params.existing?.startedAt ?? null,
    reason: params.reason,
  });
}

export function getSpotKlineInFlightMetricsSnapshot() {
  const now = getSpotKlinePreloadPerfNow();
  const active = Array.from(spotKlineInFlightByKey.values()).map((entry) => ({
    symbol: entry.symbol,
    interval: entry.interval,
    requestedBars: entry.requestedBars,
    startedAt: entry.startedAt,
    deadlineAt: entry.deadlineAt,
    role: entry.role,
    leaseId: entry.leaseId,
    waiterCount: entry.waiterCount,
    currentAgeMs: Math.max(0, now - entry.startedAt),
  }));
  const inflightCurrentAgeMs = active.reduce(
    (maximum, entry) => Math.max(maximum, entry.currentAgeMs),
    0,
  );
  return {
    ...spotKlineInFlightMetrics,
    inflight_timeout_count: spotKlineInFlightMetrics.inflightTimeoutCount,
    inflight_eviction_count: spotKlineInFlightMetrics.inflightEvictionCount,
    inflight_late_result_drop_count: spotKlineInFlightMetrics.inflightLateResultDropCount,
    inflightCurrentAgeMs,
    inflight_current_age_ms: inflightCurrentAgeMs,
    activeCount: active.length,
    active,
  };
}

export function resetSpotKlineInFlightRegistryForTests() {
  for (const entry of spotKlineInFlightByKey.values()) {
    entry.settled = true;
    if (entry.timeoutHandle !== null) clearTimeout(entry.timeoutHandle);
    entry.timeoutHandle = null;
    entry.reject(new Error('Spot Kline in-flight registry reset'));
  }
  spotKlineInFlightByKey.clear();
  Object.keys(spotKlineInFlightMetrics).forEach((key) => {
    spotKlineInFlightMetrics[key as keyof SpotKlineInFlightMetrics] = 0;
  });
}

function getSpotKlineInFlightDeadlineMs(
  role: SpotKlineInFlightRole,
  deadlineMs?: number,
) {
  if (Number.isFinite(deadlineMs) && Number(deadlineMs) > 0) {
    return Math.max(1, Math.floor(Number(deadlineMs)));
  }
  return SPOT_KLINE_INFLIGHT_DEADLINE_MS[role];
}

function isSpotKlineInFlightEntryCurrent(key: string, entry: SpotKlineInFlightEntry) {
  return spotKlineInFlightByKey.get(key) === entry && !entry.settled;
}

function clearSpotKlineInFlightDeadline(entry: SpotKlineInFlightEntry) {
  if (entry.timeoutHandle === null) return;
  clearTimeout(entry.timeoutHandle);
  entry.timeoutHandle = null;
}

function markSpotKlineLateResultDrop(entry: SpotKlineInFlightEntry, reason: string) {
  spotKlineInFlightMetrics.inflightLateResultDropCount += 1;
  markSpotKlinePerf('kline_inflight_late_result_drop', {
    symbol: entry.symbol,
    interval: entry.interval,
    requested_bars: entry.requestedBars,
    role: entry.role,
    lease_id: entry.leaseId,
    waiter_count: entry.waiterCount,
    current_age_ms: Math.max(0, getSpotKlinePreloadPerfNow() - entry.startedAt),
    reason,
  });
}

function scheduleSpotKlineInFlightDeadline(
  key: string,
  entry: SpotKlineInFlightEntry,
  deadlineAt: number,
) {
  if (!isSpotKlineInFlightEntryCurrent(key, entry)) return;
  if (deadlineAt >= entry.deadlineAt && entry.timeoutHandle !== null) return;
  clearSpotKlineInFlightDeadline(entry);
  entry.deadlineAt = deadlineAt;
  const remainingMs = Math.max(1, deadlineAt - getSpotKlinePreloadPerfNow());
  entry.timeoutHandle = setTimeout(() => {
    entry.timeoutHandle = null;
    if (!isSpotKlineInFlightEntryCurrent(key, entry)) return;
    entry.settled = true;
    spotKlineInFlightByKey.delete(key);
    spotKlineInFlightMetrics.inflightTimeoutCount += 1;
    spotKlineInFlightMetrics.inflightEvictionCount += 1;
    markSpotKlinePerf('kline_inflight_timeout', {
      symbol: entry.symbol,
      interval: entry.interval,
      requested_bars: entry.requestedBars,
      role: entry.role,
      lease_id: entry.leaseId,
      waiter_count: entry.waiterCount,
      deadline_at: entry.deadlineAt,
      current_age_ms: Math.max(0, getSpotKlinePreloadPerfNow() - entry.startedAt),
      reason: 'in-flight deadline exceeded',
    });
    entry.reject(new SpotKlineInFlightTimeoutError(entry.symbol, entry.interval, entry.role));
  }, remainingMs);
}

export async function requestSpotKlineInFlight<T extends SpotKlineInFlightResult>(params: {
  symbol: string;
  interval: string;
  requestedBars: number;
  role: SpotKlineInFlightRole;
  deadlineMs?: number;
  request: (lease: SpotKlineInFlightLease) => Promise<T>;
  getCoveredResult?: () => T | null;
  canReuseResult?: (
    result: SpotKlineInFlightResult,
    context: SpotKlineInFlightReuseContext,
  ) => boolean;
}) {
  const symbol = normalizeSpotSymbol(params.symbol);
  const interval = normalizeSpotInterval(params.interval);
  const requestedBars = Math.max(1, Math.floor(params.requestedBars || 1));
  const key = getSpotKlineInFlightKey(symbol, interval);
  let joined = false;

  while (true) {
    const existing = spotKlineInFlightByKey.get(key);
    if (existing) {
      joined = true;
      const joinedDeadlineAt = getSpotKlinePreloadPerfNow()
        + getSpotKlineInFlightDeadlineMs(params.role, params.deadlineMs);
      scheduleSpotKlineInFlightDeadline(
        key,
        existing,
        Math.min(existing.deadlineAt, joinedDeadlineAt),
      );
      existing.waiterCount += 1;
      spotKlineInFlightMetrics.inflightHitCount += 1;
      spotKlineInFlightMetrics.inflightJoinCount += 1;
      if (params.role === 'preload') spotKlineInFlightMetrics.preloadJoinedCount += 1;
      markSpotKlineInFlightMetric('kline_inflight_join', {
        symbol,
        interval,
        requestedBars,
        existing,
        role: params.role,
        reason: existing.requestedBars >= requestedBars
          ? 'existing request covers requested bars'
          : 'wait for smaller request before coverage check',
      });
      let result: SpotKlineInFlightResult;
      try {
        result = await existing.promise;
      } finally {
        existing.waiterCount = Math.max(0, existing.waiterCount - 1);
      }
      const reuseContext: SpotKlineInFlightReuseContext = {
        requestedBars,
        existingRequestedBars: existing.requestedBars,
        existingRole: existing.role,
      };
      const canReuseResult = params.canReuseResult
        ? params.canReuseResult(result, reuseContext)
        : Boolean(
          result.coverageComplete
          || existing.requestedBars >= requestedBars
          || result.bars.length >= requestedBars
        );
      if (canReuseResult) {
        spotKlineInFlightMetrics.duplicateRequestAvoidedCount += 1;
        markSpotKlineInFlightMetric('kline_inflight_duplicate_avoided', {
          symbol,
          interval,
          requestedBars,
          existing,
          role: params.role,
          reason: 'existing request coverage reused',
        });
        return { result: result as T, joined, startedRequest: false };
      }
      const coveredResult = params.getCoveredResult?.() || null;
      const canReuseCoveredResult = Boolean(
        coveredResult
        && (
          coveredResult.coverageComplete
          || coveredResult.bars.length >= requestedBars
        )
      );
      if (coveredResult && canReuseCoveredResult) {
        spotKlineInFlightMetrics.duplicateRequestAvoidedCount += 1;
        markSpotKlineInFlightMetric('kline_inflight_duplicate_avoided', {
          symbol,
          interval,
          requestedBars,
          existing,
          role: params.role,
          reason: 'cache coverage satisfied after join',
        });
        return { result: coveredResult, joined, startedRequest: false };
      }
      continue;
    }

    const startedAt = getSpotKlinePreloadPerfNow();
    const deadlineAt = startedAt + getSpotKlineInFlightDeadlineMs(params.role, params.deadlineMs);
    const leaseId = ++spotKlineInFlightLeaseSequence;
    let resolveEntry!: (result: SpotKlineInFlightResult) => void;
    let rejectEntry!: (reason: unknown) => void;
    const request = new Promise<SpotKlineInFlightResult>((resolve, reject) => {
      resolveEntry = resolve;
      rejectEntry = reject;
    });
    const entry: SpotKlineInFlightEntry = {
      symbol,
      interval,
      requestedBars,
      promise: request,
      startedAt,
      deadlineAt,
      role: params.role,
      leaseId,
      waiterCount: 1,
      settled: false,
      timeoutHandle: null,
      reject: rejectEntry,
    };
    spotKlineInFlightByKey.set(key, entry);
    scheduleSpotKlineInFlightDeadline(key, entry, deadlineAt);
    const lease: SpotKlineInFlightLease = {
      leaseId,
      deadlineAt,
      isCurrent: () => isSpotKlineInFlightEntryCurrent(key, entry),
    };
    let producer: Promise<T>;
    try {
      producer = Promise.resolve(params.request(lease));
    } catch (error) {
      producer = Promise.reject(error);
    }
    void producer.then(
      (result) => {
        if (!isSpotKlineInFlightEntryCurrent(key, entry)) {
          markSpotKlineLateResultDrop(entry, 'producer resolved after lease retired');
          return;
        }
        entry.settled = true;
        clearSpotKlineInFlightDeadline(entry);
        spotKlineInFlightByKey.delete(key);
        resolveEntry(result);
      },
      (error) => {
        if (!isSpotKlineInFlightEntryCurrent(key, entry)) {
          markSpotKlineLateResultDrop(entry, 'producer rejected after lease retired');
          return;
        }
        entry.settled = true;
        clearSpotKlineInFlightDeadline(entry);
        spotKlineInFlightByKey.delete(key);
        rejectEntry(error);
      },
    );
    try {
      const result = await request;
      return { result: result as T, joined, startedRequest: true };
    } finally {
      entry.waiterCount = Math.max(0, entry.waiterCount - 1);
    }
  }
}

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
  spotKlineInFlightMetrics.preloadSkippedCount += 1;
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
  activeInterval,
  concurrency = 1,
  shouldContinue,
}: PreloadSpotTradingViewKlineCacheOptions) {
  const normalizedSymbol = normalizeSpotSymbol(symbol);
  if (!normalizedSymbol) return;

  const queue: Array<{ interval: string; limit: number }> = [];
  const seenIntervals = new Set<string>();

  const normalizedActiveInterval = activeInterval
    ? getBackendKlineIntervalForSpotInterval(normalizeSpotInterval(activeInterval))
    : '';
  const orderedIntervals = normalizedActiveInterval
    ? [
      normalizedActiveInterval,
      ...intervals.filter((interval) => (
        getBackendKlineIntervalForSpotInterval(normalizeSpotInterval(interval))
        !== normalizedActiveInterval
      )),
    ]
    : intervals;
  for (const requestedInterval of orderedIntervals) {
    const interval = getBackendKlineIntervalForSpotInterval(normalizeSpotInterval(requestedInterval));
    if (!interval || seenIntervals.has(interval)) continue;
    seenIntervals.add(interval);
    const limit = getSpotKlinePreloadLimit(interval);
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
        const outcome = await requestSpotKlineInFlight({
          symbol: normalizedSymbol,
          interval: item.interval,
          requestedBars: item.limit,
          role: 'preload',
          getCoveredResult: () => {
            const covered = inspectCurrentKlineCache(normalizedSymbol, item.interval, item.limit, {
              minBars: item.limit,
            }).hit;
            if (!covered) return null;
            const terminalMetadata = getSpotKlineInFlightTerminalMetadata(covered);
            return {
              bars: covered.bars,
              revisionCandidates: covered.revisionCandidates || [],
              provider: covered.provider,
              source: covered.source,
              coverageKey: 'current',
              coverageComplete: covered.terminalComplete || covered.bars.length >= item.limit,
              terminalComplete: covered.terminalComplete,
              ...terminalMetadata,
              history_terminal: terminalMetadata.historyTerminal,
              terminal_reason: terminalMetadata.terminalReason,
              earliest_available_time: terminalMetadata.earliestBoundary,
            };
          },
          request: async (lease) => {
            const cached = await fetchAndCacheCurrentKlineBars({
              symbol: normalizedSymbol,
              interval: item.interval,
              limit: item.limit,
              shouldStore: () => shouldRun() && lease.isCurrent(),
            });
            const terminalMetadata = getSpotKlineInFlightTerminalMetadata(cached);
            return {
              bars: cached?.bars || [],
              revisionCandidates: cached?.revisionCandidates || [],
              provider: cached?.provider,
              source: cached?.source,
              coverageKey: 'current',
              coverageComplete: Boolean(
                cached?.terminalComplete
                || (cached?.bars.length || 0) >= item.limit
              ),
              terminalComplete: cached?.terminalComplete,
              ...terminalMetadata,
              history_terminal: terminalMetadata.historyTerminal,
              terminal_reason: terminalMetadata.terminalReason,
              earliest_available_time: terminalMetadata.earliestBoundary,
            };
          },
        });
        const outcomeTerminalMetadata = getSpotKlineInFlightTerminalMetadata(outcome.result);
        if (
          outcome.joined
          && !outcome.startedRequest
          && shouldRun()
          && outcome.result.bars.length
        ) {
          writeCurrentKlineCache({
            symbol: normalizedSymbol,
            interval: item.interval,
            limit: item.limit,
            bars: outcome.result.bars,
            revisionCandidates: outcome.result.revisionCandidates,
            provider: outcome.result.provider,
            source: outcome.result.source,
            ...outcomeTerminalMetadata,
          });
        }
        const cached = inspectCurrentKlineCache(normalizedSymbol, item.interval, item.limit, {
          minBars: item.limit,
        }).hit;
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
  let foregroundState: SpotKlinePreloadForegroundState | null = null;
  let deferredSchedule: { event: SpotKlinePreloadHistoryEvent; reason: string } | null = null;

  const stopActiveSequence = (reason: string) => {
    const hadPendingWork = preloadTimer !== null || preloadIdle !== null || preloadRunning;
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

  const cancel = (reason: string) => {
    stopActiveSequence(reason);
    foregroundState = null;
    deferredSchedule = null;
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
    deferredSchedule = { event, reason };

    if (foregroundState?.loading) {
      markSpotKlinePerf('kline_preload_foreground_pause', {
        symbol: activeSymbol,
        interval: eventBackendInterval,
        foreground_interval: foregroundState.interval,
        foreground_generation: foregroundState.generation,
        reason,
      });
      return;
    }

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
          activeInterval: eventBackendInterval,
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

  const setForegroundState = (state: SpotKlinePreloadForegroundState) => {
    const normalizedState: SpotKlinePreloadForegroundState = {
      loading: Boolean(state.loading),
      symbol: normalizeSpotSymbol(state.symbol),
      interval: getBackendKlineIntervalForSpotInterval(normalizeSpotInterval(state.interval)),
      generation: Math.max(0, Math.floor(Number(state.generation) || 0)),
    };

    if (normalizedState.loading) {
      if (
        foregroundState
        && normalizedState.generation < foregroundState.generation
      ) return;
      const changedGeneration = foregroundState?.generation !== normalizedState.generation;
      foregroundState = normalizedState;
      if (changedGeneration || preloadTimer !== null || preloadIdle !== null || preloadRunning) {
        stopActiveSequence('foreground resolution loading');
      }
      markSpotKlinePerf('kline_preload_foreground_pause', {
        symbol: normalizedState.symbol,
        interval: normalizedState.interval,
        foreground_interval: normalizedState.interval,
        foreground_generation: normalizedState.generation,
        reason: 'foreground resolution loading',
      });
      return;
    }

    if (
      !foregroundState
      || foregroundState.generation !== normalizedState.generation
      || foregroundState.symbol !== normalizedState.symbol
    ) {
      markSpotKlinePerf('kline_preload_foreground_resume_ignored', {
        symbol: normalizedState.symbol,
        interval: normalizedState.interval,
        foreground_generation: normalizedState.generation,
        active_foreground_generation: foregroundState?.generation ?? null,
        reason: 'stale foreground completion',
      });
      return;
    }

    foregroundState = null;
    markSpotKlinePerf('kline_preload_foreground_resume', {
      symbol: normalizedState.symbol,
      interval: normalizedState.interval,
      foreground_generation: normalizedState.generation,
      delay_ms: SPOT_KLINE_PRELOAD_DELAY_MS,
      reason: 'foreground resolution committed',
    });
    const deferred = deferredSchedule;
    if (deferred) {
      schedule(deferred.event, `${deferred.reason}; foreground resolution committed`);
    }
  };

  return {
    schedule,
    cancel,
    setForegroundState,
  };
}
