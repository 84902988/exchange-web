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

export type SpotKlineContinuityStats = {
  duplicateCount: number;
  gapCount: number;
  maxGap: number;
};

export type SpotKlineCacheEntry = {
  key: string;
  symbol: string;
  interval: string;
  limit: number;
  bars: SpotTradingViewBar[];
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

const currentKlineCache = new Map<string, SpotKlineCacheEntry>();

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

export function getSpotKlineLoadPolicy(interval: string): SpotKlineLoadPolicy {
  return SPOT_KLINE_LOAD_POLICY[normalizeSpotInterval(interval)] || SPOT_KLINE_LOAD_POLICY['1m'];
}

export function getPreloadKlineLimit(interval: string) {
  return getSpotKlineLoadPolicy(interval).current;
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

export function getBarsContinuityStats(
  bars: SpotTradingViewBar[],
  interval: string,
): SpotKlineContinuityStats {
  const sorted = mergeTradingViewBars(bars);
  const duplicateCount = Math.max(0, bars.length - sorted.length);
  let gapCount = 0;
  let maxGap = 0;

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
  };
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
      const aCoversRequest = a.bars.length >= requestedLimit ? 0 : 1;
      const bCoversRequest = b.bars.length >= requestedLimit ? 0 : 1;
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
    if (entry.bars.length < minBars) {
      firstRejected = firstRejected || { ...baseResult, reason: 'insufficient_bars', continuityStats: null };
      continue;
    }

    const continuityStats = getBarsContinuityStats(entry.bars, normalizedInterval);
    if (continuityStats.gapCount > 0 || continuityStats.duplicateCount > 0) {
      firstRejected = firstRejected || { ...baseResult, reason: 'reject_continuity', continuityStats };
      continue;
    }

    const returnedLimit = Math.min(requestedLimit, entry.bars.length);
    return {
      hit: { ...entry, bars: cloneBars(entry.bars.slice(-returnedLimit)) },
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
  provider?: unknown;
  source?: unknown;
}) {
  if (!params.bars.length) return null;

  const normalizedSymbol = normalizeSpotSymbol(params.symbol);
  const normalizedInterval = normalizeSpotInterval(params.interval);
  const normalizedLimit = Math.max(1, params.limit);
  const key = buildCurrentKlineCacheKey(normalizedSymbol, normalizedInterval, normalizedLimit);
  const storedBars = cloneBars(params.bars.slice(-normalizedLimit));
  const cachedAt = Date.now();
  const entry: SpotKlineCacheEntry = {
    key,
    symbol: normalizedSymbol,
    interval: normalizedInterval,
    limit: normalizedLimit,
    bars: storedBars,
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

  if (currentKlineCache.size > CURRENT_KLINE_CACHE_MAX_KEYS) {
    const overflow = currentKlineCache.size - CURRENT_KLINE_CACHE_MAX_KEYS;
    Array.from(currentKlineCache.values())
      .sort((a, b) => a.updatedAt - b.updatedAt)
      .slice(0, overflow)
      .forEach((item) => currentKlineCache.delete(item.key));
  }

  return { ...entry, bars: cloneBars(entry.bars) };
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
  const bars = normalizeKlineItemsToTradingViewBars(
    payload.items,
    params.interval,
    payload.provider,
    payload.source,
  );
  if (!bars.length || (params.shouldStore && !params.shouldStore())) return null;
  return writeCurrentKlineCache({
    symbol: params.symbol,
    interval: params.interval,
    limit: params.limit,
    bars,
    provider: payload.provider,
    source: payload.source,
  });
}

export function hasFreshCurrentKlineCache(symbol: string, interval: string, limit?: number) {
  const backendInterval = getBackendKlineIntervalForSpotInterval(interval);
  const preloadLimit = limit || getPreloadKlineLimit(backendInterval);
  return Boolean(readCurrentKlineCache(symbol, backendInterval, preloadLimit, { minBars: preloadLimit }));
}
