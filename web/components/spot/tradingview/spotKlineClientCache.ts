'use client';

import {
  getSpotKlines,
  normalizeSpotSymbol,
  type SpotMarketKlineItem,
} from '@/lib/api/modules/spot';
import { normalizeTimeToSeconds } from '../chart/chart.utils';
import { markSpotKlinePerf } from './spotKlinePerf';

export type SpotTradingViewBar = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
};

export type SpotKlineRevisionMetadata = {
  revisionEpoch: number | null;
  revisionSeq: number | null;
  isClosed: boolean | null;
  closeStateSource: string | null;
};

export type SpotKlineRevisionCandidate = {
  symbol: string;
  interval: string;
  openTime: number;
  bar: SpotTradingViewBar;
  provider?: unknown;
  source?: unknown;
  revision: SpotKlineRevisionMetadata;
};

export type SpotKlineRevisionMergeResult = {
  decision: 'ACCEPT' | 'REJECT' | 'NO_CHANGE';
  reason:
    | 'NEW_BUCKET'
    | 'NEW_EPOCH'
    | 'STALE_EPOCH'
    | 'NEWER_REVISION'
    | 'STALE_REVISION'
    | 'CLOSE_UPGRADE'
    | 'CLOSED_DOWNGRADE'
    | 'DUPLICATE'
    | 'REVISION_CONFLICT'
    | 'VERSIONED_OVER_LEGACY'
    | 'LEGACY_BELOW_VERSIONED'
    | 'LEGACY_UPDATE';
  winner: SpotKlineRevisionCandidate;
};

export type SpotKlineRevisionCache = {
  merge: (candidate: SpotKlineRevisionCandidate) => SpotKlineRevisionMergeResult;
  mergeMany: (candidates: SpotKlineRevisionCandidate[]) => SpotKlineRevisionCandidate[];
  get: (symbol: string, interval: string, openTime: number) => SpotKlineRevisionCandidate | null;
  clearScope: (symbol: string, interval: string) => void;
  clearSymbol: (symbol: string) => void;
  clear: () => void;
  size: () => number;
};

export type SpotKlineContinuityStats = {
  duplicateCount: number;
  gapCount: number;
  maxGap: number;
  outOfOrderCount: number;
  invalidOhlcCount: number;
};

export type SpotKlineCacheEntry = {
  key: string;
  symbol: string;
  interval: string;
  limit: number;
  requestedLimit: number;
  returnedCount: number;
  terminalComplete: boolean;
  historyTerminal: boolean;
  terminalReason: string | null;
  earliestBoundary: number | null;
  bars: SpotTradingViewBar[];
  revisionCandidates?: SpotKlineRevisionCandidate[];
  provider?: unknown;
  source?: unknown;
  cachedAt: number;
  updatedAt: number;
  firstTime: number | null;
  lastTime: number | null;
};

export type SpotKlineCacheLookup = SpotKlineCacheEntry & {
  bars: SpotTradingViewBar[];
};

export type SpotKlineCacheLookupResult = {
  hit: SpotKlineCacheLookup | null;
  reason:
    | 'hit'
    | 'miss'
    | 'empty'
    | 'expired'
    | 'insufficient_bars'
    | 'live_ws_source'
    | 'reject_continuity';
  candidate?: SpotKlineCacheEntry;
  cacheAgeMs?: number | null;
  continuityStats?: SpotKlineContinuityStats | null;
  minBars: number;
  requestedLimit: number;
};

export type SpotKlineStaleHistoryEligibilityReason =
  | 'ELIGIBLE'
  | 'MISSING_ENTRY'
  | 'CACHE_METADATA_INVALID'
  | 'FRESH'
  | 'SOURCE_NOT_ALLOWED'
  | 'INSUFFICIENT_BARS'
  | 'CONTINUITY_INVALID'
  | 'FORMING_CANDLE'
  | 'REVISION_METADATA_INVALID'
  | 'REVISION_CONFLICT'
  | 'PROVIDER_EPOCH_MISMATCH';

export type SpotKlineStaleHistoryEligibility = {
  eligible: boolean;
  reason: SpotKlineStaleHistoryEligibilityReason;
  requiredBars: number;
  bars: SpotTradingViewBar[];
  revisionCandidates: SpotKlineRevisionCandidate[];
  provider: string | null;
  revisionEpoch: number | null;
};

export type SpotKlineLoadPolicy = {
  current: number;
  preload: number;
  history: number;
};

const SPOT_INTERVAL_MS: Record<string, number> = {
  '1m': 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '4h': 4 * 60 * 60_000,
  '1d': 24 * 60 * 60_000,
  '1Dutc': 24 * 60 * 60_000,
  '1w': 7 * 24 * 60 * 60_000,
  '1Wutc': 7 * 24 * 60 * 60_000,
  '1M': 30 * 24 * 60 * 60_000,
  '1Mutc': 30 * 24 * 60 * 60_000,
};
const ASIA_SHANGHAI_OFFSET_MS = 8 * 60 * 60_000;
const CURRENT_KLINE_CACHE_MAX_KEYS = 64;
const STALE_HISTORY_SNAPSHOT_SOURCES = new Set([
  'REST',
  'REST_SNAPSHOT',
  'REST_HISTORY',
  'DB_CACHE',
  'STALE_CACHE',
]);
const SPOT_MONTHLY_STALE_HISTORY_FORMING_ALLOWANCE = 1;
const CURRENT_KLINE_CACHE_TTL_MS: Record<string, number> = {
  '1m': 30_000,
  '5m': 30_000,
  '15m': 60_000,
  '1h': 60_000,
  '4h': 60_000,
  '1d': 120_000,
  '1Dutc': 120_000,
  '1w': 120_000,
  '1Wutc': 120_000,
  '1M': 120_000,
  '1Mutc': 120_000,
};
const SPOT_KLINE_LOAD_POLICY: Record<string, SpotKlineLoadPolicy> = {
  '1m': { current: 150, preload: 150, history: 200 },
  '5m': { current: 140, preload: 140, history: 200 },
  '15m': { current: 130, preload: 130, history: 180 },
  '1h': { current: 150, preload: 150, history: 180 },
  '4h': { current: 130, preload: 130, history: 160 },
  '1d': { current: 120, preload: 110, history: 120 },
  '1Dutc': { current: 120, preload: 110, history: 120 },
  '1w': { current: 80, preload: 80, history: 100 },
  '1Wutc': { current: 80, preload: 80, history: 100 },
  '1M': { current: 60, preload: 48, history: 60 },
  '1Mutc': { current: 60, preload: 48, history: 60 },
};
const SPOT_KLINE_CONTRACT_PRELOAD_LIMIT = 360;

const currentKlineCache = new Map<string, SpotKlineCacheEntry>();

type SpotKlineScopeAuthority = {
  revisionEpoch: number;
  provider: string;
};

function normalizeRevisionNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

function normalizeClosedState(value: unknown): boolean | null {
  if (value === true || value === false) return value;
  if (value === 1 || value === '1' || String(value).trim().toLowerCase() === 'true') return true;
  if (value === 0 || value === '0' || String(value).trim().toLowerCase() === 'false') return false;
  return null;
}

export function extractSpotKlineRevisionMetadata(payload: unknown): SpotKlineRevisionMetadata {
  const item = payload && typeof payload === 'object'
    ? payload as Record<string, unknown>
    : {};
  const closeStateSource = String(item.close_state_source || '').trim().toUpperCase();
  return {
    revisionEpoch: normalizeRevisionNumber(item.revision_epoch),
    revisionSeq: normalizeRevisionNumber(item.revision_seq),
    isClosed: normalizeClosedState(item.is_closed),
    closeStateSource: closeStateSource || null,
  };
}

function hasRevisionEvidence(revision: SpotKlineRevisionMetadata): boolean {
  return revision.revisionEpoch !== null && revision.revisionSeq !== null;
}

function getCloseStateRank(revision: SpotKlineRevisionMetadata): number {
  if (revision.isClosed === null) return 0;
  if (!revision.isClosed) return 1;
  return revision.closeStateSource === 'PROVIDER_CONFIRMED' ? 3 : 2;
}

function sameTradingViewBar(left: SpotTradingViewBar, right: SpotTradingViewBar): boolean {
  return (
    left.time === right.time
    && left.open === right.open
    && left.high === right.high
    && left.low === right.low
    && left.close === right.close
    && Number(left.volume || 0) === Number(right.volume || 0)
  );
}

function sameCloseState(left: SpotKlineRevisionMetadata, right: SpotKlineRevisionMetadata): boolean {
  return (
    left.isClosed === right.isClosed
    && left.closeStateSource === right.closeStateSource
  );
}

function cloneRevisionCandidate(candidate: SpotKlineRevisionCandidate): SpotKlineRevisionCandidate {
  return {
    ...candidate,
    bar: { ...candidate.bar },
    revision: { ...candidate.revision },
  };
}

function buildRevisionScopeKey(symbol: string, interval: string): string {
  return `${normalizeSpotSymbol(symbol)}:${normalizeSpotInterval(interval)}`;
}

export function buildSpotKlineRevisionKey(symbol: string, interval: string, openTime: number): string {
  return `${buildRevisionScopeKey(symbol, interval)}:${Math.floor(openTime)}`;
}

export function createSpotKlineRevisionCache(): SpotKlineRevisionCache {
  const winners = new Map<string, SpotKlineRevisionCandidate>();
  const scopeAuthorities = new Map<string, SpotKlineScopeAuthority>();

  const clearScope = (symbol: string, interval: string) => {
    const scopeKey = buildRevisionScopeKey(symbol, interval);
    for (const [key, candidate] of Array.from(winners.entries())) {
      if (buildRevisionScopeKey(candidate.symbol, candidate.interval) === scopeKey) {
        winners.delete(key);
      }
    }
    scopeAuthorities.delete(scopeKey);
  };

  const merge = (rawCandidate: SpotKlineRevisionCandidate): SpotKlineRevisionMergeResult => {
    const candidate = cloneRevisionCandidate({
      ...rawCandidate,
      symbol: normalizeSpotSymbol(rawCandidate.symbol),
      interval: normalizeSpotInterval(rawCandidate.interval),
      openTime: Math.floor(rawCandidate.openTime),
    });
    const key = buildSpotKlineRevisionKey(candidate.symbol, candidate.interval, candidate.openTime);
    const scopeKey = buildRevisionScopeKey(candidate.symbol, candidate.interval);
    const incomingHasRevision = hasRevisionEvidence(candidate.revision);
    const incomingEpoch = candidate.revision.revisionEpoch;
    const incomingProvider = normalizeProvider(candidate.provider);
    const scopeAuthority = scopeAuthorities.get(scopeKey);

    if (incomingHasRevision && incomingEpoch !== null) {
      if (scopeAuthority && incomingEpoch < scopeAuthority.revisionEpoch) {
        const winner = winners.get(key) || candidate;
        return { decision: 'REJECT', reason: 'STALE_EPOCH', winner: cloneRevisionCandidate(winner) };
      }
      if (scopeAuthority && incomingEpoch === scopeAuthority.revisionEpoch) {
        if (scopeAuthority.provider && incomingProvider && scopeAuthority.provider !== incomingProvider) {
          const winner = winners.get(key) || candidate;
          return { decision: 'REJECT', reason: 'STALE_EPOCH', winner: cloneRevisionCandidate(winner) };
        }
      }
      if (!scopeAuthority || incomingEpoch > scopeAuthority.revisionEpoch) {
        clearScope(candidate.symbol, candidate.interval);
        scopeAuthorities.set(scopeKey, {
          revisionEpoch: incomingEpoch,
          provider: incomingProvider,
        });
      }
    }

    const existing = winners.get(key);
    if (!existing) {
      winners.set(key, candidate);
      return { decision: 'ACCEPT', reason: 'NEW_BUCKET', winner: cloneRevisionCandidate(candidate) };
    }

    const existingHasRevision = hasRevisionEvidence(existing.revision);
    if (incomingHasRevision && !existingHasRevision) {
      winners.set(key, candidate);
      return { decision: 'ACCEPT', reason: 'VERSIONED_OVER_LEGACY', winner: cloneRevisionCandidate(candidate) };
    }
    if (!incomingHasRevision && existingHasRevision) {
      return { decision: 'REJECT', reason: 'LEGACY_BELOW_VERSIONED', winner: cloneRevisionCandidate(existing) };
    }

    if (incomingHasRevision && existingHasRevision) {
      const existingEpoch = existing.revision.revisionEpoch as number;
      const nextEpoch = candidate.revision.revisionEpoch as number;
      if (nextEpoch < existingEpoch) {
        return { decision: 'REJECT', reason: 'STALE_EPOCH', winner: cloneRevisionCandidate(existing) };
      }
      if (nextEpoch > existingEpoch) {
        winners.set(key, candidate);
        return { decision: 'ACCEPT', reason: 'NEW_EPOCH', winner: cloneRevisionCandidate(candidate) };
      }

      const existingCloseRank = getCloseStateRank(existing.revision);
      const incomingCloseRank = getCloseStateRank(candidate.revision);
      if (incomingCloseRank < existingCloseRank) {
        return { decision: 'REJECT', reason: 'CLOSED_DOWNGRADE', winner: cloneRevisionCandidate(existing) };
      }
      if (incomingCloseRank > existingCloseRank) {
        winners.set(key, candidate);
        return { decision: 'ACCEPT', reason: 'CLOSE_UPGRADE', winner: cloneRevisionCandidate(candidate) };
      }

      const existingSeq = existing.revision.revisionSeq as number;
      const incomingSeq = candidate.revision.revisionSeq as number;
      if (incomingSeq < existingSeq) {
        return { decision: 'REJECT', reason: 'STALE_REVISION', winner: cloneRevisionCandidate(existing) };
      }
      if (incomingSeq > existingSeq) {
        winners.set(key, candidate);
        return { decision: 'ACCEPT', reason: 'NEWER_REVISION', winner: cloneRevisionCandidate(candidate) };
      }
      if (sameTradingViewBar(existing.bar, candidate.bar) && sameCloseState(existing.revision, candidate.revision)) {
        return { decision: 'NO_CHANGE', reason: 'DUPLICATE', winner: cloneRevisionCandidate(existing) };
      }
      return { decision: 'REJECT', reason: 'REVISION_CONFLICT', winner: cloneRevisionCandidate(existing) };
    }

    if (sameTradingViewBar(existing.bar, candidate.bar) && sameCloseState(existing.revision, candidate.revision)) {
      return { decision: 'NO_CHANGE', reason: 'DUPLICATE', winner: cloneRevisionCandidate(existing) };
    }
    if (getCloseStateRank(candidate.revision) < getCloseStateRank(existing.revision)) {
      return { decision: 'REJECT', reason: 'CLOSED_DOWNGRADE', winner: cloneRevisionCandidate(existing) };
    }
    winners.set(key, candidate);
    return { decision: 'ACCEPT', reason: 'LEGACY_UPDATE', winner: cloneRevisionCandidate(candidate) };
  };

  return {
    merge,
    mergeMany(candidates) {
      const candidateKeys = new Set<string>();
      for (const candidate of candidates) {
        candidateKeys.add(buildSpotKlineRevisionKey(candidate.symbol, candidate.interval, candidate.openTime));
        merge(candidate);
      }
      return Array.from(candidateKeys)
        .map((key) => winners.get(key))
        .filter((candidate): candidate is SpotKlineRevisionCandidate => Boolean(candidate))
        .map(cloneRevisionCandidate)
        .sort((left, right) => left.bar.time - right.bar.time);
    },
    get(symbol, interval, openTime) {
      const winner = winners.get(buildSpotKlineRevisionKey(symbol, interval, openTime));
      return winner ? cloneRevisionCandidate(winner) : null;
    },
    clearScope,
    clearSymbol(symbol) {
      const normalizedSymbol = normalizeSpotSymbol(symbol);
      for (const candidate of Array.from(winners.values())) {
        if (candidate.symbol === normalizedSymbol) clearScope(candidate.symbol, candidate.interval);
      }
    },
    clear() {
      winners.clear();
      scopeAuthorities.clear();
    },
    size: () => winners.size,
  };
}

function normalizeProvider(value: unknown): string {
  return String(value || '').trim().toUpperCase();
}

function normalizeSource(value: unknown): string {
  return String(value || '').trim().toUpperCase();
}

function toPositiveNumber(value: unknown): number | null {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : null;
}

export function normalizeSpotInterval(interval: string): string {
  const raw = String(interval || '').trim();
  const utcInterval = ({
    '1dutc': '1Dutc',
    '1wutc': '1Wutc',
    '1mutc': '1Mutc',
  } as Record<string, string>)[raw.toLowerCase()];
  if (utcInterval) return utcInterval;
  return raw === '1M' ? raw : raw.toLowerCase();
}

export function getBackendKlineIntervalForSpotInterval(interval: string): string {
  const normalized = normalizeSpotInterval(interval);
  if (normalized === '1d') return '1Dutc';
  if (normalized === '1w') return '1Wutc';
  if (normalized === '1M') return '1Mutc';
  return normalized;
}

export function getSpotIntervalMs(interval: string): number {
  return SPOT_INTERVAL_MS[normalizeSpotInterval(interval)] || SPOT_INTERVAL_MS['1m'];
}

export function isProviderCandleOnlyInterval(interval: string): boolean {
  return ['1d', '1Dutc', '1w', '1Wutc', '1M', '1Mutc'].includes(normalizeSpotInterval(interval));
}

export function isUtcProviderCandleInterval(interval: string): boolean {
  return ['1Dutc', '1Wutc', '1Mutc'].includes(normalizeSpotInterval(interval));
}

export function isInternalSparseKlineInterval(interval: string): boolean {
  return ['1Dutc', '1Wutc', '1Mutc'].includes(normalizeSpotInterval(interval));
}

export function getSpotKlineLoadPolicy(interval: string): SpotKlineLoadPolicy {
  return SPOT_KLINE_LOAD_POLICY[normalizeSpotInterval(interval)] || SPOT_KLINE_LOAD_POLICY['1m'];
}

export function getPreloadKlineLimit(interval: string) {
  return Math.max(getSpotKlineLoadPolicy(interval).current, SPOT_KLINE_CONTRACT_PRELOAD_LIMIT);
}

export function getL1CurrentKlineCacheMinBars(interval: string, requiredBars: number) {
  const policy = getSpotKlineLoadPolicy(interval);
  const normalizedRequiredBars = Math.max(1, Math.floor(requiredBars || policy.current));
  return Math.min(normalizedRequiredBars, policy.current);
}

export function isLiveWsKlineSource(source: unknown) {
  return normalizeSource(source) === 'LIVE_WS';
}

export function cloneBars(bars: SpotTradingViewBar[]) {
  return bars.map((bar) => ({ ...bar }));
}

export function mergeTradingViewBars(bars: SpotTradingViewBar[]): SpotTradingViewBar[] {
  const byTime = new Map<number, SpotTradingViewBar>();
  for (const bar of bars) {
    if (!Number.isFinite(bar.time) || bar.time <= 0) continue;
    byTime.set(bar.time, { ...bar });
  }
  return Array.from(byTime.values()).sort((a, b) => a.time - b.time);
}

function getNextMonthlyBarTimeMs(timeMs: number) {
  const date = new Date(timeMs);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
}

function getExpectedNextBarTimeMs(interval: string, timeMs: number) {
  const normalizedInterval = normalizeSpotInterval(interval);
  if (normalizedInterval === '1M' || normalizedInterval === '1Mutc') {
    return getNextMonthlyBarTimeMs(timeMs);
  }
  return timeMs + getSpotIntervalMs(normalizedInterval);
}

function isValidOhlcBar(bar: SpotTradingViewBar): boolean {
  return (
    Number.isFinite(bar.open) &&
    Number.isFinite(bar.high) &&
    Number.isFinite(bar.low) &&
    Number.isFinite(bar.close) &&
    bar.high >= bar.open &&
    bar.high >= bar.close &&
    bar.low <= bar.open &&
    bar.low <= bar.close &&
    bar.high >= bar.low
  );
}

export function getBarsContinuityStats(
  bars: SpotTradingViewBar[],
  interval: string,
): SpotKlineContinuityStats {
  const sorted = mergeTradingViewBars(bars);
  const seenTimes = new Set<number>();
  let duplicateCount = 0;
  let outOfOrderCount = 0;
  let invalidOhlcCount = 0;
  let gapCount = 0;
  let maxGap = 0;

  for (let index = 0; index < bars.length; index += 1) {
    const bar = bars[index];
    if (!isValidOhlcBar(bar)) {
      invalidOhlcCount += 1;
    }
    if (Number.isFinite(bar.time) && bar.time > 0) {
      if (seenTimes.has(bar.time)) {
        duplicateCount += 1;
      } else {
        seenTimes.add(bar.time);
      }
    }
    if (index > 0 && bar.time <= bars[index - 1].time) {
      outOfOrderCount += 1;
    }
  }

  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    const expected = getExpectedNextBarTimeMs(interval, previous.time);
    const delta = current.time - previous.time;
    if (current.time !== expected) {
      gapCount += 1;
      maxGap = Math.max(maxGap, Math.abs(delta));
    }
  }

  return {
    duplicateCount,
    gapCount,
    maxGap,
    outOfOrderCount,
    invalidOhlcCount,
  };
}

export function hasHardKlineContinuityViolation(stats: SpotKlineContinuityStats): boolean {
  return stats.duplicateCount > 0 || stats.outOfOrderCount > 0 || stats.invalidOhlcCount > 0;
}

export function isSparseRealKlineSeries(params: {
  interval: string;
  source?: unknown;
  bars?: SpotTradingViewBar[];
  continuityStats?: SpotKlineContinuityStats | null;
}): boolean {
  if (!isInternalSparseKlineInterval(params.interval)) return false;
  if (normalizeSource(params.source) !== 'INTERNAL') return false;
  if (params.bars && !params.bars.length) return false;
  if (params.continuityStats && hasHardKlineContinuityViolation(params.continuityStats)) {
    return false;
  }
  return true;
}

export function shouldRejectKlineContinuity(params: {
  interval: string;
  source?: unknown;
  bars: SpotTradingViewBar[];
  continuityStats?: SpotKlineContinuityStats | null;
}): boolean {
  if (!params.bars.length) return false;
  const stats = params.continuityStats || getBarsContinuityStats(params.bars, params.interval);
  if (hasHardKlineContinuityViolation(stats)) return true;
  if (stats.gapCount > 0 && !isSparseRealKlineSeries({ ...params, continuityStats: stats })) {
    return true;
  }
  return false;
}

function getCurrentKlineCacheTtlMs(interval: string) {
  return CURRENT_KLINE_CACHE_TTL_MS[normalizeSpotInterval(interval)] || 30_000;
}

export function buildCurrentKlineCacheKey(symbol: string, interval: string, limit: number) {
  return `spot:kline:${normalizeSpotSymbol(symbol)}:${normalizeSpotInterval(interval)}:${Math.max(1, limit)}:current`;
}

function isFreshKlineCacheEntry(entry: SpotKlineCacheEntry, now = Date.now()) {
  return now - entry.updatedAt <= getCurrentKlineCacheTtlMs(entry.interval);
}

function getStaleHistoryMinimumClosedBars(interval: string, requiredBars: number) {
  if (normalizeSpotInterval(interval) !== '1Mutc') return requiredBars;
  return Math.max(1, requiredBars - SPOT_MONTHLY_STALE_HISTORY_FORMING_ALLOWANCE);
}

function staleHistoryEligibilityResult(
  reason: SpotKlineStaleHistoryEligibilityReason,
  requiredBars: number,
  overrides: Partial<SpotKlineStaleHistoryEligibility> = {},
): SpotKlineStaleHistoryEligibility {
  return {
    eligible: reason === 'ELIGIBLE',
    reason,
    requiredBars,
    bars: [],
    revisionCandidates: [],
    provider: null,
    revisionEpoch: null,
    ...overrides,
  };
}

function hasValidRevisionMetadataShape(revision: unknown): revision is SpotKlineRevisionMetadata {
  if (!revision || typeof revision !== 'object') return false;
  const value = revision as Partial<SpotKlineRevisionMetadata>;
  const hasEpoch = value.revisionEpoch !== null && value.revisionEpoch !== undefined;
  const hasSequence = value.revisionSeq !== null && value.revisionSeq !== undefined;
  if (hasEpoch !== hasSequence) return false;
  if (
    hasEpoch
    && (!Number.isInteger(value.revisionEpoch) || Number(value.revisionEpoch) < 0
      || !Number.isInteger(value.revisionSeq) || Number(value.revisionSeq) < 0)
  ) {
    return false;
  }
  if (value.isClosed !== null && value.isClosed !== undefined && typeof value.isClosed !== 'boolean') {
    return false;
  }
  if (
    value.closeStateSource !== null
    && value.closeStateSource !== undefined
    && typeof value.closeStateSource !== 'string'
  ) {
    return false;
  }
  return true;
}

function sameRevisionMetadata(left: SpotKlineRevisionMetadata, right: SpotKlineRevisionMetadata) {
  return (
    left.revisionEpoch === right.revisionEpoch
    && left.revisionSeq === right.revisionSeq
    && left.isClosed === right.isClosed
    && left.closeStateSource === right.closeStateSource
  );
}

function isClosedHistoricalBar(
  bar: SpotTradingViewBar,
  interval: string,
  revision: SpotKlineRevisionMetadata | null,
  now: number,
) {
  if (revision?.isClosed === true) return true;
  if (revision?.isClosed === false) return false;
  return getExpectedNextBarTimeMs(interval, bar.time) <= now;
}

export function inspectStaleHistoryEligibility(
  entry: SpotKlineCacheEntry | null | undefined,
  options: { requiredBars: number; now?: number },
): SpotKlineStaleHistoryEligibility {
  const requiredBars = Math.max(1, Math.floor(Number(options.requiredBars) || 1));
  if (!entry) return staleHistoryEligibilityResult('MISSING_ENTRY', requiredBars);

  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const normalizedSymbol = normalizeSpotSymbol(entry.symbol);
  const normalizedInterval = normalizeSpotInterval(entry.interval);
  const minimumClosedBars = getStaleHistoryMinimumClosedBars(
    normalizedInterval,
    requiredBars,
  );
  const entryProvider = normalizeProvider(entry.provider);
  const normalizedSource = normalizeSource(entry.source);
  if (
    !normalizedSymbol
    || !normalizedInterval
    || !Number.isFinite(entry.updatedAt)
    || entry.updatedAt <= 0
  ) {
    return staleHistoryEligibilityResult('CACHE_METADATA_INVALID', requiredBars);
  }
  if (isFreshKlineCacheEntry(entry, now)) {
    return staleHistoryEligibilityResult('FRESH', requiredBars, {
      provider: entryProvider || null,
    });
  }
  if (!STALE_HISTORY_SNAPSHOT_SOURCES.has(normalizedSource)) {
    return staleHistoryEligibilityResult('SOURCE_NOT_ALLOWED', requiredBars, {
      provider: entryProvider || null,
    });
  }
  if (entry.bars.length < minimumClosedBars) {
    return staleHistoryEligibilityResult('INSUFFICIENT_BARS', requiredBars, {
      provider: entryProvider || null,
    });
  }

  const continuityStats = getBarsContinuityStats(entry.bars, normalizedInterval);
  if (shouldRejectKlineContinuity({
    interval: normalizedInterval,
    source: entry.source,
    bars: entry.bars,
    continuityStats,
  })) {
    return staleHistoryEligibilityResult('CONTINUITY_INVALID', requiredBars, {
      provider: entryProvider || null,
    });
  }

  const barsByTime = new Map(entry.bars.map((bar) => [bar.time, bar]));
  const candidatesByOpenTime = new Map<number, SpotKlineRevisionCandidate>();
  let authorityProvider = entryProvider;
  let authorityEpoch: number | null = null;
  let hasVersionedCandidate = false;
  let hasLegacyCandidate = false;

  for (const rawCandidate of entry.revisionCandidates || []) {
    const candidate = cloneRevisionCandidate(rawCandidate);
    const candidateProvider = normalizeProvider(candidate.provider || entry.provider);
    const candidateSymbol = normalizeSpotSymbol(candidate.symbol);
    const candidateInterval = normalizeSpotInterval(candidate.interval);
    const openTime = Number(candidate.openTime);
    const entryBar = barsByTime.get(openTime);
    if (
      candidateSymbol !== normalizedSymbol
      || candidateInterval !== normalizedInterval
      || !Number.isFinite(openTime)
      || openTime <= 0
      || candidate.bar.time !== openTime
      || !entryBar
      || !hasValidRevisionMetadataShape(candidate.revision)
    ) {
      return staleHistoryEligibilityResult('REVISION_METADATA_INVALID', requiredBars, {
        provider: entryProvider || null,
      });
    }
    if (!sameTradingViewBar(entryBar, candidate.bar)) {
      return staleHistoryEligibilityResult('REVISION_CONFLICT', requiredBars, {
        provider: entryProvider || null,
      });
    }

    const existing = candidatesByOpenTime.get(openTime);
    if (existing) {
      if (
        !sameTradingViewBar(existing.bar, candidate.bar)
        || !sameRevisionMetadata(existing.revision, candidate.revision)
        || normalizeProvider(existing.provider || entry.provider) !== candidateProvider
      ) {
        return staleHistoryEligibilityResult('REVISION_CONFLICT', requiredBars, {
          provider: entryProvider || null,
        });
      }
      continue;
    }

    const candidateHasRevision = hasRevisionEvidence(candidate.revision);
    hasVersionedCandidate = hasVersionedCandidate || candidateHasRevision;
    hasLegacyCandidate = hasLegacyCandidate || !candidateHasRevision;
    if (candidateProvider) {
      if (authorityProvider && authorityProvider !== candidateProvider) {
        return staleHistoryEligibilityResult('PROVIDER_EPOCH_MISMATCH', requiredBars, {
          provider: entryProvider || null,
        });
      }
      authorityProvider = candidateProvider;
    }
    if (candidateHasRevision) {
      const candidateEpoch = candidate.revision.revisionEpoch as number;
      if (authorityEpoch !== null && authorityEpoch !== candidateEpoch) {
        return staleHistoryEligibilityResult('PROVIDER_EPOCH_MISMATCH', requiredBars, {
          provider: authorityProvider || null,
        });
      }
      authorityEpoch = candidateEpoch;
    }
    candidatesByOpenTime.set(openTime, candidate);
  }

  if (hasVersionedCandidate && hasLegacyCandidate) {
    return staleHistoryEligibilityResult('REVISION_METADATA_INVALID', requiredBars, {
      provider: authorityProvider || null,
      revisionEpoch: authorityEpoch,
    });
  }

  const closedBars: SpotTradingViewBar[] = [];
  let excludedFormingCandle = false;
  for (const bar of entry.bars) {
    const candidate = candidatesByOpenTime.get(bar.time) || null;
    if (hasVersionedCandidate && !candidate) {
      return staleHistoryEligibilityResult('REVISION_METADATA_INVALID', requiredBars, {
        provider: authorityProvider || null,
        revisionEpoch: authorityEpoch,
      });
    }
    if (isClosedHistoricalBar(bar, normalizedInterval, candidate?.revision || null, now)) {
      closedBars.push({ ...bar });
    } else {
      excludedFormingCandle = true;
    }
  }

  if (closedBars.length < minimumClosedBars) {
    return staleHistoryEligibilityResult(
      excludedFormingCandle ? 'FORMING_CANDLE' : 'INSUFFICIENT_BARS',
      requiredBars,
      {
        provider: authorityProvider || null,
        revisionEpoch: authorityEpoch,
      },
    );
  }

  const selectedBars = closedBars.slice(-requiredBars);
  const selectedTimes = new Set(selectedBars.map((bar) => bar.time));
  const selectedCandidates = Array.from(candidatesByOpenTime.values())
    .filter((candidate) => selectedTimes.has(candidate.openTime))
    .sort((left, right) => left.openTime - right.openTime)
    .map(cloneRevisionCandidate);

  return staleHistoryEligibilityResult('ELIGIBLE', requiredBars, {
    bars: selectedBars,
    revisionCandidates: selectedCandidates,
    provider: authorityProvider || null,
    revisionEpoch: authorityEpoch,
  });
}

function isTerminalCompleteKlineCacheEntry(interval: string, requestedLimit: number, returnedCount: number) {
  const normalizedInterval = normalizeSpotInterval(interval);
  return normalizedInterval === '1Mutc' && returnedCount > 0 && returnedCount < requestedLimit;
}

function doesEntryCoverRequestedLimit(entry: SpotKlineCacheEntry, requestedLimit: number) {
  return (
    entry.bars.length >= requestedLimit ||
    (entry.terminalComplete && entry.requestedLimit >= requestedLimit)
  );
}

export function buildKlineCachePerfPayload(
  entry: SpotKlineCacheEntry | null | undefined,
  fallback: {
    symbol: string;
    interval: string;
    limit: number;
  },
) {
  const now = Date.now();
  return {
    symbol: entry?.symbol || normalizeSpotSymbol(fallback.symbol),
    interval: entry?.interval || normalizeSpotInterval(fallback.interval),
    backendInterval: entry?.interval || normalizeSpotInterval(fallback.interval),
    limit: entry?.limit || Math.max(1, fallback.limit),
    requestedLimit: entry?.requestedLimit || Math.max(1, fallback.limit),
    returnedCount: entry?.returnedCount || 0,
    terminalComplete: Boolean(entry?.terminalComplete),
    historyTerminal: Boolean(entry?.historyTerminal),
    terminalReason: entry?.terminalReason ?? null,
    earliestBoundary: entry?.earliestBoundary ?? null,
    bars_count: entry?.bars.length || 0,
    cache_age_ms: entry ? Math.max(0, now - entry.updatedAt) : null,
    cached_at: entry?.cachedAt || null,
    first_time: entry?.firstTime ?? null,
    last_time: entry?.lastTime ?? null,
    source: entry?.source,
  };
}

export function inspectCurrentKlineCache(
  symbol: string,
  interval: string,
  limit: number,
  options: { allowStale?: boolean; minBars?: number } = {},
): SpotKlineCacheLookupResult {
  const normalizedSymbol = normalizeSpotSymbol(symbol);
  const normalizedInterval = normalizeSpotInterval(interval);
  const requestedLimit = Math.max(1, limit);
  const minBars = Math.max(1, Math.min(requestedLimit, Math.floor(options.minBars || requestedLimit)));
  const now = Date.now();
  const allowStale = Boolean(options.allowStale);
  const candidates = Array.from(currentKlineCache.values())
    .filter((entry) => entry.symbol === normalizedSymbol && entry.interval === normalizedInterval)
    .sort((a, b) => {
      const aCoversRequest = doesEntryCoverRequestedLimit(a, requestedLimit) ? 0 : 1;
      const bCoversRequest = doesEntryCoverRequestedLimit(b, requestedLimit) ? 0 : 1;
      return aCoversRequest - bCoversRequest || b.bars.length - a.bars.length || b.updatedAt - a.updatedAt;
    });

  if (!candidates.length) {
    return { hit: null, reason: 'miss', minBars, requestedLimit };
  }

  let firstRejected: SpotKlineCacheLookupResult | null = null;
  for (const entry of candidates) {
    const cacheAgeMs = Math.max(0, now - entry.updatedAt);
    const baseResult = {
      hit: null,
      candidate: entry,
      cacheAgeMs,
      minBars,
      requestedLimit,
    };
    if (!entry.bars.length) {
      firstRejected = firstRejected || { ...baseResult, reason: 'empty', continuityStats: null };
      continue;
    }
    if (isLiveWsKlineSource(entry.source)) {
      firstRejected = firstRejected || { ...baseResult, reason: 'live_ws_source', continuityStats: null };
      continue;
    }
    if (!allowStale && !isFreshKlineCacheEntry(entry, now)) {
      firstRejected = firstRejected || { ...baseResult, reason: 'expired', continuityStats: null };
      continue;
    }
    if (entry.bars.length < minBars && !doesEntryCoverRequestedLimit(entry, requestedLimit)) {
      firstRejected = firstRejected || { ...baseResult, reason: 'insufficient_bars', continuityStats: null };
      continue;
    }

    const continuityStats = getBarsContinuityStats(entry.bars, normalizedInterval);
    if (shouldRejectKlineContinuity({
      interval: normalizedInterval,
      source: entry.source,
      bars: entry.bars,
      continuityStats,
    })) {
      firstRejected = firstRejected || { ...baseResult, reason: 'reject_continuity', continuityStats };
      continue;
    }

    const returnedLimit = Math.min(requestedLimit, entry.bars.length);
    return {
      hit: {
        ...entry,
        bars: cloneBars(entry.bars.slice(-returnedLimit)),
        revisionCandidates: entry.revisionCandidates
          ?.slice(-returnedLimit)
          .map(cloneRevisionCandidate),
      },
      reason: 'hit',
      candidate: entry,
      cacheAgeMs,
      continuityStats,
      minBars,
      requestedLimit,
    };
  }

  return firstRejected || { hit: null, reason: 'miss', minBars, requestedLimit };
}

export function readCurrentKlineCache(
  symbol: string,
  interval: string,
  limit: number,
  options: { allowStale?: boolean; minBars?: number } = {},
): SpotKlineCacheLookup | null {
  return inspectCurrentKlineCache(symbol, interval, limit, options).hit;
}

export function writeCurrentKlineCache(params: {
  symbol: string;
  interval: string;
  limit: number;
  bars: SpotTradingViewBar[];
  revisionCandidates?: SpotKlineRevisionCandidate[];
  provider?: unknown;
  source?: unknown;
  historyTerminal?: unknown;
  terminalReason?: unknown;
  earliestBoundary?: unknown;
}) {
  if (!params.bars.length) return null;

  const normalizedSymbol = normalizeSpotSymbol(params.symbol);
  const normalizedInterval = normalizeSpotInterval(params.interval);
  const normalizedLimit = Math.max(1, params.limit);
  const key = buildCurrentKlineCacheKey(normalizedSymbol, normalizedInterval, normalizedLimit);
  const incomingTerminalReason = String(params.terminalReason || '').trim() || null;
  const incomingEarliestBoundary = Number(params.earliestBoundary);
  const hasIncomingTerminalBoundary = Boolean(
    params.historyTerminal === true
    && incomingTerminalReason
    && Number.isFinite(incomingEarliestBoundary)
    && incomingEarliestBoundary > 0
  );
  const existingTerminalBoundary = Array.from(currentKlineCache.values())
    .filter((entry) => (
      entry.symbol === normalizedSymbol
      && entry.interval === normalizedInterval
      && entry.historyTerminal
      && entry.terminalReason
      && entry.earliestBoundary !== null
      && Number.isFinite(entry.earliestBoundary)
      && entry.earliestBoundary > 0
    ))
    .sort((left, right) => right.updatedAt - left.updatedAt)[0] || null;
  const historyTerminal = hasIncomingTerminalBoundary || Boolean(existingTerminalBoundary);
  const terminalReason = hasIncomingTerminalBoundary
    ? incomingTerminalReason
    : existingTerminalBoundary?.terminalReason || null;
  const earliestBoundary = hasIncomingTerminalBoundary
    ? incomingEarliestBoundary
    : existingTerminalBoundary?.earliestBoundary ?? null;
  const revisionCache = createSpotKlineRevisionCache();
  const existingScopeCandidates = Array.from(currentKlineCache.values())
    .filter((entry) => entry.symbol === normalizedSymbol && entry.interval === normalizedInterval)
    .flatMap((entry) => entry.revisionCandidates?.length
      ? entry.revisionCandidates
      : entry.bars.map((bar) => ({
        symbol: normalizedSymbol,
        interval: normalizedInterval,
        openTime: bar.time,
        bar,
        provider: entry.provider,
        source: entry.source,
        revision: extractSpotKlineRevisionMetadata(null),
      })));
  revisionCache.mergeMany(existingScopeCandidates);
  const incomingRevisionCandidates = params.revisionCandidates?.length
    ? params.revisionCandidates
    : params.bars.map((bar) => ({
      symbol: normalizedSymbol,
      interval: normalizedInterval,
      openTime: bar.time,
      bar,
      provider: params.provider,
      source: params.source,
      revision: extractSpotKlineRevisionMetadata(null),
    }));
  const storedRevisionCandidates = revisionCache.mergeMany(incomingRevisionCandidates)
    .slice(-normalizedLimit);
  const storedBars = storedRevisionCandidates.map((candidate) => ({ ...candidate.bar }));
  if (shouldRejectKlineContinuity({
    interval: normalizedInterval,
    source: params.source,
    bars: storedBars,
  })) {
    return null;
  }
  const terminalComplete = historyTerminal || isTerminalCompleteKlineCacheEntry(
    normalizedInterval,
    normalizedLimit,
    storedBars.length,
  );
  const cachedAt = Date.now();
  const entry: SpotKlineCacheEntry = {
    key,
    symbol: normalizedSymbol,
    interval: normalizedInterval,
    limit: normalizedLimit,
    requestedLimit: normalizedLimit,
    returnedCount: storedBars.length,
    terminalComplete,
    historyTerminal,
    terminalReason,
    earliestBoundary,
    bars: storedBars,
    revisionCandidates: storedRevisionCandidates,
    provider: params.provider,
    source: params.source,
    cachedAt,
    updatedAt: cachedAt,
    firstTime: storedBars[0]?.time ?? null,
    lastTime: storedBars[storedBars.length - 1]?.time ?? null,
  };
  currentKlineCache.set(key, entry);
  markSpotKlinePerf('kline_l1_cache_store', {
    ...buildKlineCachePerfPayload(entry, {
      symbol: normalizedSymbol,
      interval: normalizedInterval,
      limit: normalizedLimit,
    }),
    reason: 'store current kline bars',
  });
  if (terminalComplete) {
    markSpotKlinePerf('kline_l1_cache_terminal_complete', {
      ...buildKlineCachePerfPayload(entry, {
        symbol: normalizedSymbol,
        interval: normalizedInterval,
        limit: normalizedLimit,
      }),
      reason: 'current response returned complete available monthly history',
    });
  }

  if (currentKlineCache.size > CURRENT_KLINE_CACHE_MAX_KEYS) {
    const overflow = currentKlineCache.size - CURRENT_KLINE_CACHE_MAX_KEYS;
    Array.from(currentKlineCache.values())
      .sort((a, b) => a.updatedAt - b.updatedAt)
      .slice(0, overflow)
      .forEach((item) => currentKlineCache.delete(item.key));
  }

  return {
    ...entry,
    bars: cloneBars(entry.bars),
    revisionCandidates: entry.revisionCandidates?.map(cloneRevisionCandidate),
  };
}

function normalizeKlineTimeMs(item: SpotMarketKlineItem): number {
  const seconds =
    normalizeTimeToSeconds(item.open_time) ||
    normalizeTimeToSeconds(item.time) ||
    normalizeTimeToSeconds(item.timestamp);
  return seconds > 0 ? seconds * 1000 : 0;
}

function shouldUseOkxDwmTradingViewTime(
  interval: string,
  provider?: unknown,
  source?: unknown,
): boolean {
  if (!isProviderCandleOnlyInterval(interval)) return false;
  if (isUtcProviderCandleInterval(interval)) return false;

  const normalizedProvider = normalizeProvider(provider);
  const normalizedSource = normalizeSource(source);
  return (
    normalizedProvider === 'OKX_SPOT' ||
    normalizedProvider === 'EXTERNAL_SPOT' ||
    normalizedSource === 'EXTERNAL_SPOT' ||
    normalizedSource === 'DB_CACHE' ||
    normalizedSource === 'STALE_CACHE' ||
    normalizedSource === 'REST_SNAPSHOT' ||
    normalizedSource === 'REST_HISTORY' ||
    normalizedSource === 'LIVE_WS'
  );
}

function providerOpenTimeToTradingViewTimeMs(
  timeMs: number,
  interval: string,
  provider?: unknown,
  source?: unknown,
): number {
  if (!timeMs) return 0;
  if (isUtcProviderCandleInterval(interval)) return timeMs;
  if (!shouldUseOkxDwmTradingViewTime(interval, provider, source)) return timeMs;

  const shanghaiTradingDate = new Date(timeMs + ASIA_SHANGHAI_OFFSET_MS);
  return Date.UTC(
    shanghaiTradingDate.getUTCFullYear(),
    shanghaiTradingDate.getUTCMonth(),
    shanghaiTradingDate.getUTCDate(),
  );
}

function klineToBar(
  item: SpotMarketKlineItem,
  interval: string,
  provider?: unknown,
  source?: unknown,
): SpotTradingViewBar | null {
  const time = providerOpenTimeToTradingViewTimeMs(
    normalizeKlineTimeMs(item),
    interval,
    provider,
    source,
  );
  const open = toPositiveNumber(item.open);
  const high = toPositiveNumber(item.high);
  const low = toPositiveNumber(item.low);
  const close = toPositiveNumber(item.close);
  const volume = Number(item.volume);

  if (!time || open === null || high === null || low === null || close === null) {
    return null;
  }

  return {
    time,
    open,
    high,
    low,
    close,
    volume: Number.isFinite(volume) && volume > 0 ? volume : 0,
  };
}

export function normalizeKlineItemsToTradingViewBars(
  items: SpotMarketKlineItem[] | undefined,
  interval: string,
  provider?: unknown,
  source?: unknown,
): SpotTradingViewBar[] {
  const byTime = new Map<number, SpotTradingViewBar>();
  for (const item of items || []) {
    const bar = klineToBar(item, interval, provider, source);
    if (!bar) continue;
    byTime.set(bar.time, bar);
  }
  return Array.from(byTime.values()).sort((a, b) => a.time - b.time);
}

export function normalizeKlineItemsToRevisionCandidates(
  symbol: string,
  items: SpotMarketKlineItem[] | undefined,
  interval: string,
  provider?: unknown,
  source?: unknown,
): SpotKlineRevisionCandidate[] {
  const byOpenTime = new Map<number, SpotKlineRevisionCandidate>();
  for (const item of items || []) {
    const openTime = normalizeKlineTimeMs(item);
    const bar = klineToBar(item, interval, provider, source);
    if (!openTime || !bar) continue;
    byOpenTime.set(openTime, {
      symbol,
      interval,
      openTime,
      bar,
      provider,
      source,
      revision: extractSpotKlineRevisionMetadata(item),
    });
  }
  return Array.from(byOpenTime.values()).sort((left, right) => left.bar.time - right.bar.time);
}

export async function fetchAndCacheCurrentKlineBars(params: {
  symbol: string;
  interval: string;
  limit: number;
  shouldStore?: () => boolean;
}) {
  const payload = await getSpotKlines({
    symbol: params.symbol,
    interval: params.interval,
    limit: params.limit,
    forceRest: true,
  });
  const revisionCandidates = normalizeKlineItemsToRevisionCandidates(
    params.symbol,
    payload.items,
    params.interval,
    payload.provider,
    payload.source,
  );
  const bars = revisionCandidates.map((candidate) => ({ ...candidate.bar }));
  if (!bars.length || (params.shouldStore && !params.shouldStore())) return null;
  return writeCurrentKlineCache({
    symbol: params.symbol,
    interval: params.interval,
    limit: params.limit,
    bars,
    revisionCandidates,
    provider: payload.provider,
    source: payload.source,
    historyTerminal: payload.history_terminal,
    terminalReason: payload.terminal_reason,
    earliestBoundary: payload.earliest_available_time,
  });
}

export function hasFreshCurrentKlineCache(symbol: string, interval: string, limit?: number) {
  const backendInterval = getBackendKlineIntervalForSpotInterval(interval);
  const preloadLimit = limit || getPreloadKlineLimit(backendInterval);
  return Boolean(readCurrentKlineCache(symbol, backendInterval, preloadLimit, { minBars: preloadLimit }));
}
