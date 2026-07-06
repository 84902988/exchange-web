'use client';

import {
  getSpotKlines,
  normalizeSpotSymbol,
  type SpotMarketKlineItem,
} from '@/lib/api/modules/spot';
import {
  spotMarketRealtime,
  type SpotMarketKlineMessage,
  type SpotMarketRealtimeMessage,
} from '@/services/marketRealtime';
import { normalizeTimeToSeconds } from '../chart/chart.utils';
import type { SpotChartProps, SpotKlineLoadState } from '../chart/chart.types';

type TradingViewResolution = '1' | '5' | '15' | '60' | '240' | '1D' | '1W' | '1M';

type TradingViewBar = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
};

type SpotTradingViewRealtimeEvent = {
  symbol: string;
  interval: string;
  reason: 'kline';
  barTime: number;
  updatedAtMs: number;
};

type TradingViewLibrarySymbolInfo = {
  name: string;
  ticker: string;
  description: string;
  type: string;
  session: string;
  timezone: string;
  exchange: string;
  listed_exchange: string;
  minmov: number;
  pricescale: number;
  has_intraday: boolean;
  has_daily: boolean;
  has_weekly_and_monthly: boolean;
  supported_resolutions: TradingViewResolution[];
  intraday_multipliers: string[];
  daily_multipliers: string[];
  weekly_multipliers: string[];
  monthly_multipliers: string[];
  volume_precision: number;
  data_status: string;
  format: string;
};

type TradingViewSearchSymbolResult = {
  symbol: string;
  full_name: string;
  description: string;
  exchange: string;
  ticker: string;
  type: string;
};

type TradingViewPeriodParams = {
  from: number;
  to: number;
  firstDataRequest?: boolean;
  countBack?: number;
};

type TradingViewDatafeedConfiguration = {
  supports_search: boolean;
  supports_group_request: boolean;
  supports_marks: boolean;
  supports_timescale_marks: boolean;
  supports_time: boolean;
  exchanges: Array<{ value: string; name: string; desc: string }>;
  symbols_types: Array<{ name: string; value: string }>;
  supported_resolutions: TradingViewResolution[];
};

type DatafeedCallbacks = {
  onReady: (configuration: TradingViewDatafeedConfiguration) => void;
  onSearchReady: (items: TradingViewSearchSymbolResult[]) => void;
  onSymbolResolved: (symbolInfo: TradingViewLibrarySymbolInfo) => void;
  onResolveError: (reason: string) => void;
  onHistory: (bars: TradingViewBar[], meta: { noData?: boolean }) => void;
  onHistoryError: (reason: string) => void;
  onRealtime: (bar: TradingViewBar) => void;
};

type SpotTradingViewDatafeed = {
  onReady: (callback: DatafeedCallbacks['onReady']) => void;
  searchSymbols: (
    userInput: string,
    exchange: string,
    symbolType: string,
    callback: DatafeedCallbacks['onSearchReady'],
  ) => void;
  resolveSymbol: (
    symbolName: string,
    onResolve: DatafeedCallbacks['onSymbolResolved'],
    onError: DatafeedCallbacks['onResolveError'],
  ) => void;
  getBars: (
    symbolInfo: TradingViewLibrarySymbolInfo,
    resolution: TradingViewResolution | string,
    periodParams: TradingViewPeriodParams,
    onHistory: DatafeedCallbacks['onHistory'],
    onError: DatafeedCallbacks['onHistoryError'],
  ) => void;
  subscribeBars: (
    symbolInfo: TradingViewLibrarySymbolInfo,
    resolution: TradingViewResolution | string,
    onRealtime: DatafeedCallbacks['onRealtime'],
    subscriberUid: string,
    onResetCacheNeeded?: () => void,
  ) => void;
  unsubscribeBars: (subscriberUid: string) => void;
  destroy: () => void;
};

type SpotTradingViewDatafeedOptions = Pick<
  SpotChartProps,
  'symbol' | 'displaySymbol' | 'pricePrecision' | 'amountPrecision'
> & {
  debugEnabled?: boolean;
  onKlineLoadStateChange?: (state: SpotKlineLoadState) => void;
  onKlineRealtime?: (event: SpotTradingViewRealtimeEvent) => void;
};

type EmitRealtimeBar = (bar: TradingViewBar, reason: string) => boolean;
type KlineCacheEntry = {
  key: string;
  symbol: string;
  interval: string;
  limit: number;
  bars: TradingViewBar[];
  provider?: unknown;
  source?: unknown;
  updatedAt: number;
};

type KlineCacheLookup = KlineCacheEntry & {
  bars: TradingViewBar[];
};

type PreloadSpotTradingViewKlineCacheOptions = {
  symbol: string;
  intervals: string[];
  skipInterval?: string;
  concurrency?: number;
  shouldContinue?: () => boolean;
};

type SpotKlineLoadPolicy = {
  current: number;
  preload: number;
  history: number;
};

type HistoryKlineRequestResult = {
  bars: TradingViewBar[];
  provider?: unknown;
  source?: unknown;
};

const SPOT_EXCHANGE_NAME = 'EXCHANGE';
const SUPPORTED_RESOLUTIONS: TradingViewResolution[] = ['1', '5', '15', '60', '240', '1D', '1W', '1M'];
const RESOLUTION_TO_SPOT_INTERVAL: Record<string, string> = {
  '1': '1m',
  '5': '5m',
  '15': '15m',
  '60': '1h',
  '240': '4h',
  D: '1d',
  '1D': '1d',
  W: '1w',
  '1W': '1w',
  '1M': '1M',
};

const SPOT_INTERVAL_TO_RESOLUTION: Record<string, TradingViewResolution> = {
  '1m': '1',
  '5m': '5',
  '15m': '15',
  '1h': '60',
  '4h': '240',
  '1d': '1D',
  '1Dutc': '1D',
  '1w': '1W',
  '1Wutc': '1W',
  '1M': '1M',
  '1Mutc': '1M',
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
const TRADINGVIEW_TIMEZONE = 'Asia/Shanghai';
const realtimeHighWaterMarkByKey = new Map<string, number>();
const currentKlineCache = new Map<string, KlineCacheEntry>();
const historyKlineRequestInFlightByKey = new Map<string, Promise<HistoryKlineRequestResult>>();
let forcedSpotTradingViewDebugEnabled = false;
const CURRENT_KLINE_CACHE_MAX_KEYS = 64;
const CURRENT_KLINE_CACHE_TTL_MS: Record<string, number> = {
  '1m': 10_000,
  '5m': 20_000,
  '15m': 20_000,
  '1h': 60_000,
  '4h': 60_000,
  '1d': 180_000,
  '1Dutc': 180_000,
  '1w': 300_000,
  '1Wutc': 300_000,
  '1M': 300_000,
  '1Mutc': 300_000,
};
const SPOT_KLINE_LOAD_POLICY: Record<string, SpotKlineLoadPolicy> = {
  '1m': { current: 150, preload: 150, history: 200 },
  '5m': { current: 140, preload: 140, history: 200 },
  '15m': { current: 130, preload: 130, history: 180 },
  '1h': { current: 150, preload: 150, history: 180 },
  '4h': { current: 130, preload: 130, history: 160 },
  '1d': { current: 110, preload: 110, history: 120 },
  '1Dutc': { current: 110, preload: 110, history: 120 },
  '1w': { current: 80, preload: 80, history: 100 },
  '1Wutc': { current: 80, preload: 80, history: 100 },
  '1M': { current: 48, preload: 48, history: 60 },
  '1Mutc': { current: 48, preload: 48, history: 60 },
};

const DATAFEED_CONFIGURATION: TradingViewDatafeedConfiguration = {
  supports_search: true,
  supports_group_request: false,
  supports_marks: false,
  supports_timescale_marks: false,
  supports_time: false,
  exchanges: [{ value: SPOT_EXCHANGE_NAME, name: SPOT_EXCHANGE_NAME, desc: SPOT_EXCHANGE_NAME }],
  symbols_types: [{ name: 'spot', value: 'spot' }],
  supported_resolutions: SUPPORTED_RESOLUTIONS,
};

function getSpotTvDebugWindows() {
  if (typeof window === 'undefined') return [];
  const candidates: Window[] = [window];

  try {
    if (window.parent && !candidates.includes(window.parent)) {
      candidates.push(window.parent);
    }
  } catch {
    // Parent access is best-effort only for diagnostics.
  }

  try {
    if (window.top && !candidates.includes(window.top)) {
      candidates.push(window.top);
    }
  } catch {
    // Top access is best-effort only for diagnostics.
  }

  return candidates;
}

function isSpotTradingViewDebugEnabled() {
  if (forcedSpotTradingViewDebugEnabled) return true;

  for (const candidate of getSpotTvDebugWindows()) {
    try {
      if (candidate.localStorage?.getItem('SPOT_TV_DEBUG') === '1') return true;
    } catch {
      // Storage access is best-effort only for diagnostics.
    }
  }
  return false;
}

function spotTradingViewDebug(event: string, payload: Record<string, unknown>) {
  if (!isSpotTradingViewDebugEnabled()) return;
  console.debug(`[SpotTradingViewDatafeed] ${event}`, payload);
}

function getTradingDateFromNormalizedTime(normalizedTime: number) {
  if (!Number.isFinite(normalizedTime) || normalizedTime <= 0) return '';
  return new Date(normalizedTime).toISOString().slice(0, 10);
}

function getBarsDebugStats(bars: TradingViewBar[], interval: string) {
  const seen = new Set<number>();
  let duplicateCount = 0;
  let gapCount = 0;
  const intervalMs = getSpotIntervalMs(interval);
  const normalizedInterval = normalizeSpotInterval(interval);
  const gapThreshold = normalizedInterval === '1M'
    ? 32 * 24 * 60 * 60_000
    : Math.floor(intervalMs * 1.5);

  for (let index = 0; index < bars.length; index += 1) {
    const current = bars[index];
    if (seen.has(current.time)) {
      duplicateCount += 1;
    }
    seen.add(current.time);

    const previous = bars[index - 1];
    if (!previous) continue;
    const delta = current.time - previous.time;
    if (delta > gapThreshold) {
      gapCount += 1;
    }
  }

  return {
    count: bars.length,
    firstTime: bars[0]?.time || null,
    lastTime: bars[bars.length - 1]?.time || null,
    gapCount,
    duplicateCount,
  };
}

function buildBarDebugRows(bars: TradingViewBar[]) {
  return bars.slice(-5).map((bar) => ({
    originalTime: null,
    normalizedTime: bar.time,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume || 0,
  }));
}

function buildKlineItemDebugRows(
  items: SpotMarketKlineItem[] | undefined,
  interval: string,
  provider?: unknown,
  source?: unknown,
) {
  return (items || []).slice(-5).map((item) => {
    const originalTime = normalizeKlineTimeMs(item);
    return {
      interval: normalizeSpotInterval(interval),
      originalTime,
      normalizedTime: providerOpenTimeToTradingViewTimeMs(originalTime, interval, provider, source),
      open: item.open,
      high: item.high,
      low: item.low,
      close: item.close,
      volume: item.volume ?? 0,
    };
  });
}

function toPositiveNumber(value: unknown): number | null {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : null;
}

function normalizeProvider(value: unknown): string {
  return String(value || '').trim().toUpperCase();
}

function normalizeSource(value: unknown): string {
  return String(value || '').trim().toUpperCase();
}

function isLiveWsKlineSource(source: unknown) {
  return normalizeSource(source) === 'LIVE_WS';
}

function normalizeResolution(resolution: string): TradingViewResolution {
  const normalized = String(resolution || '').trim().toUpperCase();
  if (normalized === 'D') return '1D';
  if (normalized === 'W') return '1W';
  if (normalized === '1M' || normalized === 'M') return '1M';
  if (SUPPORTED_RESOLUTIONS.includes(normalized as TradingViewResolution)) {
    return normalized as TradingViewResolution;
  }
  return '1';
}

function normalizeSpotInterval(interval: string): string {
  const raw = String(interval || '').trim();
  const utcInterval = ({
    '1dutc': '1Dutc',
    '1wutc': '1Wutc',
    '1mutc': '1Mutc',
  } as Record<string, string>)[raw.toLowerCase()];
  if (utcInterval) return utcInterval;
  return raw === '1M' ? raw : raw.toLowerCase();
}

export function spotIntervalToTradingViewResolution(interval: string): TradingViewResolution {
  const normalized = normalizeSpotInterval(interval);
  return SPOT_INTERVAL_TO_RESOLUTION[normalized] || '1';
}

function tradingViewResolutionToSpotInterval(resolution: string): string {
  return RESOLUTION_TO_SPOT_INTERVAL[normalizeResolution(resolution)] || '1m';
}

function getBackendKlineIntervalForSpotInterval(interval: string): string {
  const normalized = normalizeSpotInterval(interval);
  if (normalized === '1d') return '1Dutc';
  if (normalized === '1w') return '1Wutc';
  if (normalized === '1M') return '1Mutc';
  return normalized;
}

function getBackendKlineIntervalForTradingView(resolution: string): string {
  return getBackendKlineIntervalForSpotInterval(tradingViewResolutionToSpotInterval(resolution));
}

function getSpotIntervalMs(interval: string): number {
  return SPOT_INTERVAL_MS[normalizeSpotInterval(interval)] || SPOT_INTERVAL_MS['1m'];
}

function isProviderCandleOnlyInterval(interval: string): boolean {
  return ['1d', '1Dutc', '1w', '1Wutc', '1M', '1Mutc'].includes(normalizeSpotInterval(interval));
}

function isUtcProviderCandleInterval(interval: string): boolean {
  return ['1Dutc', '1Wutc', '1Mutc'].includes(normalizeSpotInterval(interval));
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
  if (isUtcProviderCandleInterval(interval)) {
    spotTradingViewDebug('D/W/M time normalize', {
      interval: normalizeSpotInterval(interval),
      originalTime: timeMs,
      normalizedTime: timeMs,
      provider,
      source,
    });
    return timeMs;
  }
  if (!shouldUseOkxDwmTradingViewTime(interval, provider, source)) return timeMs;

  const shanghaiTradingDate = new Date(timeMs + ASIA_SHANGHAI_OFFSET_MS);
  const normalizedTime = Date.UTC(
    shanghaiTradingDate.getUTCFullYear(),
    shanghaiTradingDate.getUTCMonth(),
    shanghaiTradingDate.getUTCDate(),
  );

  spotTradingViewDebug('D/W/M time normalize', {
    interval: normalizeSpotInterval(interval),
    originalTime: timeMs,
    normalizedTime,
    provider,
    source,
  });

  return normalizedTime;
}

function getRealtimeHighWaterMark(latestBarKey: string): number {
  return realtimeHighWaterMarkByKey.get(latestBarKey) || 0;
}

function rememberRealtimeHighWaterMark(latestBarKey: string, time: number) {
  if (!Number.isFinite(time) || time <= 0) return;
  const previous = getRealtimeHighWaterMark(latestBarKey);
  if (time > previous) {
    realtimeHighWaterMarkByKey.set(latestBarKey, time);
  }
}

function getPriceScale(precision?: number | null): number {
  const nextPrecision = Number(precision);
  if (!Number.isInteger(nextPrecision) || nextPrecision < 0 || nextPrecision > 12) {
    return 100;
  }
  return Math.max(1, 10 ** nextPrecision);
}

function normalizeKlineTimeMs(item: SpotMarketKlineItem): number {
  const seconds =
    normalizeTimeToSeconds(item.open_time) ||
    normalizeTimeToSeconds(item.time) ||
    normalizeTimeToSeconds(item.timestamp);
  return seconds > 0 ? seconds * 1000 : 0;
}

function klineToBar(
  item: SpotMarketKlineItem,
  interval: string,
  provider?: unknown,
  source?: unknown,
): TradingViewBar | null {
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

function klinePayloadToBar(
  payload: unknown,
  interval: string,
  provider?: unknown,
  source?: unknown,
): TradingViewBar | null {
  if (!payload || typeof payload !== 'object') return null;
  return klineToBar(payload as SpotMarketKlineItem, interval, provider, source);
}

function normalizeHistoryBars(
  items: SpotMarketKlineItem[] | undefined,
  interval: string,
  provider?: unknown,
  source?: unknown,
): TradingViewBar[] {
  const byTime = new Map<number, TradingViewBar>();
  for (const item of items || []) {
    const bar = klineToBar(item, interval, provider, source);
    if (!bar) continue;
    byTime.set(bar.time, bar);
  }
  return Array.from(byTime.values()).sort((a, b) => a.time - b.time);
}

function cloneBars(bars: TradingViewBar[]) {
  return bars.map((bar) => ({ ...bar }));
}

function getCurrentKlineCacheTtlMs(interval: string) {
  return CURRENT_KLINE_CACHE_TTL_MS[normalizeSpotInterval(interval)] || 30_000;
}

function getSpotKlineLoadPolicy(interval: string): SpotKlineLoadPolicy {
  return SPOT_KLINE_LOAD_POLICY[normalizeSpotInterval(interval)] || SPOT_KLINE_LOAD_POLICY['1m'];
}

function normalizeRequestedKlineLimit(countBack: number, fallback: number) {
  const requested = Number(countBack);
  if (!Number.isFinite(requested) || requested <= 0) return fallback;
  return Math.max(50, Math.floor(requested));
}

function getCurrentKlineLimit(interval: string) {
  return getSpotKlineLoadPolicy(interval).current;
}

function getPreloadKlineLimit(interval: string) {
  return getSpotKlineLoadPolicy(interval).preload;
}

function getHistoryKlineLimit(interval: string, countBack: number) {
  const policy = getSpotKlineLoadPolicy(interval);
  const requested = normalizeRequestedKlineLimit(countBack, policy.history);
  return Math.min(requested, policy.history);
}

function buildCurrentKlineCacheKey(symbol: string, interval: string, limit: number) {
  return `${normalizeSpotSymbol(symbol)}:${normalizeSpotInterval(interval)}:${Math.max(1, limit)}:current`;
}

function buildHistoryKlineInFlightKey(
  symbol: string,
  interval: string,
  periodParams: TradingViewPeriodParams,
  limit: number,
  endTime?: number,
) {
  const from = Number(periodParams.from || 0);
  const to = Number(periodParams.to || 0);
  return [
    normalizeSpotSymbol(symbol),
    normalizeSpotInterval(interval),
    Number.isFinite(from) ? from : 0,
    Number.isFinite(to) ? to : 0,
    Math.max(1, limit),
    endTime || 0,
  ].join(':');
}

function classifyKlineRequest(periodParams: TradingViewPeriodParams) {
  const requestedEndTime = Number(periodParams.to) > 0 ? Number(periodParams.to) * 1000 : 0;
  const isHistoryRequest = periodParams.firstDataRequest === false;

  return {
    requestedEndTime,
    isHistoryRequest,
  };
}

function isFreshKlineCacheEntry(entry: KlineCacheEntry, now = Date.now()) {
  return now - entry.updatedAt <= getCurrentKlineCacheTtlMs(entry.interval);
}

function readCurrentKlineCache(
  symbol: string,
  interval: string,
  limit: number,
  options: { allowStale?: boolean } = {},
): KlineCacheLookup | null {
  const normalizedSymbol = normalizeSpotSymbol(symbol);
  const normalizedInterval = normalizeSpotInterval(interval);
  const normalizedLimit = Math.max(1, limit);
  const exact = currentKlineCache.get(buildCurrentKlineCacheKey(normalizedSymbol, normalizedInterval, normalizedLimit));
  const now = Date.now();
  const allowStale = Boolean(options.allowStale);

  const canUse = (entry: KlineCacheEntry) =>
    entry.bars.length > 0 &&
    !isLiveWsKlineSource(entry.source) &&
    (allowStale || isFreshKlineCacheEntry(entry, now));

  if (exact && canUse(exact)) {
    return { ...exact, bars: cloneBars(exact.bars.slice(-normalizedLimit)) };
  }

  const compatible = Array.from(currentKlineCache.values())
    .filter((entry) => (
      entry.symbol === normalizedSymbol &&
      entry.interval === normalizedInterval &&
      entry.limit >= normalizedLimit &&
      canUse(entry)
    ))
    .sort((a, b) => a.limit - b.limit || b.updatedAt - a.updatedAt)[0];

  return compatible ? { ...compatible, bars: cloneBars(compatible.bars.slice(-normalizedLimit)) } : null;
}

function writeCurrentKlineCache(params: {
  symbol: string;
  interval: string;
  limit: number;
  bars: TradingViewBar[];
  provider?: unknown;
  source?: unknown;
}) {
  if (!params.bars.length) return null;

  const normalizedSymbol = normalizeSpotSymbol(params.symbol);
  const normalizedInterval = normalizeSpotInterval(params.interval);
  const normalizedLimit = Math.max(1, params.limit);
  const key = buildCurrentKlineCacheKey(normalizedSymbol, normalizedInterval, normalizedLimit);
  const entry: KlineCacheEntry = {
    key,
    symbol: normalizedSymbol,
    interval: normalizedInterval,
    limit: normalizedLimit,
    bars: cloneBars(params.bars.slice(-normalizedLimit)),
    provider: params.provider,
    source: params.source,
    updatedAt: Date.now(),
  };
  currentKlineCache.set(key, entry);

  if (currentKlineCache.size > CURRENT_KLINE_CACHE_MAX_KEYS) {
    const overflow = currentKlineCache.size - CURRENT_KLINE_CACHE_MAX_KEYS;
    Array.from(currentKlineCache.values())
      .sort((a, b) => a.updatedAt - b.updatedAt)
      .slice(0, overflow)
      .forEach((item) => currentKlineCache.delete(item.key));
  }

  return { ...entry, bars: cloneBars(entry.bars) };
}

async function fetchAndCacheCurrentKlineBars(params: {
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
  const bars = normalizeHistoryBars(payload.items, params.interval, payload.provider, payload.source);
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

async function fetchKlineRequestBars(params: {
  symbol: string;
  interval: string;
  limit: number;
  endTime?: number;
  forceRest?: boolean;
}): Promise<HistoryKlineRequestResult> {
  const payload = await getSpotKlines({
    symbol: params.symbol,
    interval: params.interval,
    limit: params.limit,
    endTime: params.endTime,
    forceRest: params.forceRest,
  });
  spotTradingViewDebug('getBars last bars', {
    symbol: params.symbol,
    interval: normalizeSpotInterval(params.interval),
    provider: payload.provider,
    source: payload.source,
    endTime: params.endTime || null,
    rows: buildKlineItemDebugRows(payload.items, params.interval, payload.provider, payload.source),
  });
  const bars = normalizeHistoryBars(payload.items, params.interval, payload.provider, payload.source);
  return {
    bars,
    provider: payload.provider,
    source: payload.source,
  };
}

function getHistoryKlineRequestPromise(params: {
  key: string;
  symbol: string;
  interval: string;
  limit: number;
  endTime?: number;
}) {
  const existing = historyKlineRequestInFlightByKey.get(params.key);
  if (existing) {
    spotTradingViewDebug('history in-flight dedupe key', {
      key: params.key,
      symbol: params.symbol,
      interval: normalizeSpotInterval(params.interval),
      limit: params.limit,
      endTime: params.endTime || null,
      deduped: true,
    });
    return existing;
  }

  spotTradingViewDebug('history in-flight dedupe key', {
    key: params.key,
    symbol: params.symbol,
    interval: normalizeSpotInterval(params.interval),
    limit: params.limit,
    endTime: params.endTime || null,
    deduped: false,
  });

  const request = fetchKlineRequestBars({
    symbol: params.symbol,
    interval: params.interval,
    limit: params.limit,
    endTime: params.endTime,
    forceRest: true,
  }).finally(() => {
    historyKlineRequestInFlightByKey.delete(params.key);
  });
  historyKlineRequestInFlightByKey.set(params.key, request);
  return request;
}

export function hasFreshSpotTradingViewKlineCache(symbol: string, interval: string, limit?: number) {
  const backendInterval = getBackendKlineIntervalForSpotInterval(interval);
  return Boolean(readCurrentKlineCache(symbol, backendInterval, limit || getPreloadKlineLimit(backendInterval)));
}

export async function preloadSpotTradingViewKlineCache({
  symbol,
  intervals,
  skipInterval,
  concurrency = 2,
  shouldContinue,
}: PreloadSpotTradingViewKlineCacheOptions) {
  const normalizedSymbol = normalizeSpotSymbol(symbol);
  if (!normalizedSymbol) return;

  const normalizedSkipInterval = skipInterval ? getBackendKlineIntervalForSpotInterval(skipInterval) : '';
  const queue = Array.from(new Set(intervals.map((interval) => (
    getBackendKlineIntervalForSpotInterval(normalizeSpotInterval(interval))
  ))))
    .filter((interval) => interval && interval !== normalizedSkipInterval)
    .map((interval) => ({ interval, limit: getPreloadKlineLimit(interval) }))
    .filter(({ interval, limit }) => !hasFreshSpotTradingViewKlineCache(normalizedSymbol, interval, limit));

  if (!queue.length) return;

  const workerCount = Math.max(1, Math.min(Math.floor(concurrency || 1), 1, queue.length));
  let cursor = 0;
  const shouldRun = () => !shouldContinue || shouldContinue();

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (shouldRun()) {
      const item = queue[cursor++];
      if (!item) return;
      try {
        await fetchAndCacheCurrentKlineBars({
          symbol: normalizedSymbol,
          interval: item.interval,
          limit: item.limit,
          shouldStore: shouldRun,
        });
      } catch (err) {
        if (process.env.NODE_ENV !== 'production') {
          console.debug('[SpotTradingViewDatafeed] preload kline cache failed', {
            symbol: normalizedSymbol,
            interval: item.interval,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }));
}

function buildSymbolInfo(options: SpotTradingViewDatafeedOptions): TradingViewLibrarySymbolInfo {
  const symbol = normalizeSpotSymbol(options.symbol);
  const description = String(options.displaySymbol || '').trim() || symbol;
  const volumePrecision = Number(options.amountPrecision);

  return {
    name: symbol,
    ticker: symbol,
    description,
    type: 'spot',
    session: '24x7',
    timezone: TRADINGVIEW_TIMEZONE,
    exchange: SPOT_EXCHANGE_NAME,
    listed_exchange: SPOT_EXCHANGE_NAME,
    minmov: 1,
    pricescale: getPriceScale(options.pricePrecision),
    has_intraday: true,
    has_daily: true,
    has_weekly_and_monthly: true,
    supported_resolutions: SUPPORTED_RESOLUTIONS,
    intraday_multipliers: ['1', '5', '15', '60', '240'],
    daily_multipliers: ['1'],
    weekly_multipliers: ['1'],
    monthly_multipliers: ['1'],
    volume_precision: Number.isInteger(volumePrecision) && volumePrecision >= 0 && volumePrecision <= 12
      ? volumePrecision
      : 8,
    data_status: 'streaming',
    format: 'price',
  };
}

function buildSearchResult(symbolInfo: TradingViewLibrarySymbolInfo): TradingViewSearchSymbolResult {
  return {
    symbol: symbolInfo.name,
    full_name: `${symbolInfo.exchange}:${symbolInfo.name}`,
    description: symbolInfo.description,
    exchange: symbolInfo.exchange,
    ticker: symbolInfo.ticker,
    type: symbolInfo.type,
  };
}

export function createSpotTradingViewDatafeed(
  options: SpotTradingViewDatafeedOptions,
): SpotTradingViewDatafeed {
  forcedSpotTradingViewDebugEnabled = Boolean(options.debugEnabled);
  const symbolInfo = buildSymbolInfo(options);
  const apiSymbol = normalizeSpotSymbol(symbolInfo.ticker || symbolInfo.name);
  let destroyed = false;
  const latestBars = new Map<string, TradingViewBar>();
  const latestBarKeyByUid = new Map<string, string>();
  const lastEmittedBarTimeByUid = new Map<string, number>();
  const lastDroppedRealtimeBarByUid = new Map<string, string>();
  const activeSubscriptionKeyByUid = new Map<string, string>();
  const historyReadyByLatestBarKey = new Map<string, boolean>();
  const historyRequestSeqByLatestBarKey = new Map<string, number>();
  const unsubscribeByUid = new Map<string, () => void>();

  const getLatestBarKey = (resolution: TradingViewResolution | string) =>
    `${apiSymbol}:${normalizeResolution(resolution)}`;

  const getSubscriptionKey = (interval: string, subscriberUid: string) =>
    `${apiSymbol}:${interval}:${subscriberUid}`;

  const syncLastEmittedAfterHistory = (latestBarKey: string, latestBarTime: number) => {
    if (!latestBarTime) return;

    for (const [subscriberUid, subscriberLatestBarKey] of Array.from(latestBarKeyByUid.entries())) {
      if (subscriberLatestBarKey !== latestBarKey) continue;

      const previous = lastEmittedBarTimeByUid.get(subscriberUid) || 0;
      if (latestBarTime > previous) {
        lastEmittedBarTimeByUid.set(subscriberUid, latestBarTime);
      }
    }
  };

  return {
    onReady(callback) {
      window.setTimeout(() => callback(DATAFEED_CONFIGURATION), 0);
    },

    searchSymbols(userInput, _exchange, _symbolType, callback) {
      const normalizedInput = normalizeSpotSymbol(userInput);
      const result = buildSearchResult(symbolInfo);
      window.setTimeout(() => {
        callback(!normalizedInput || symbolInfo.name.includes(normalizedInput) ? [result] : []);
      }, 0);
    },

    resolveSymbol(symbolName, onResolve, onError) {
      const requested = normalizeSpotSymbol(symbolName);
      if (requested && requested !== apiSymbol) {
        window.setTimeout(() => onError('Unknown symbol'), 0);
        return;
      }
      window.setTimeout(() => onResolve(symbolInfo), 0);
    },

    getBars(_symbolInfo, resolution, periodParams, onHistory, onError) {
      const requestResolution = normalizeResolution(resolution);
      const chartInterval = tradingViewResolutionToSpotInterval(requestResolution);
      const interval = getBackendKlineIntervalForTradingView(requestResolution);
      const countBack = Number(periodParams.countBack || 0);
      const { isHistoryRequest, requestedEndTime } = classifyKlineRequest(periodParams);
      const limit = isHistoryRequest
        ? getHistoryKlineLimit(interval, countBack)
        : getCurrentKlineLimit(interval);
      const endTime = isHistoryRequest && requestedEndTime > 0 ? requestedEndTime : undefined;
      const requestKind = isHistoryRequest ? 'history' : 'current';
      const latestBarKey = getLatestBarKey(requestResolution);
      const historyRequestSeq = (historyRequestSeqByLatestBarKey.get(latestBarKey) || 0) + 1;
      historyRequestSeqByLatestBarKey.set(latestBarKey, historyRequestSeq);
      const requestDebugPayload = {
        symbol: apiSymbol,
        interval,
        chartInterval,
        backendInterval: interval,
        resolution: requestResolution,
        firstDataRequest: periodParams.firstDataRequest !== false,
        from: periodParams.from,
        to: periodParams.to,
        countBack,
        limit,
        requestKind,
        endTime: endTime || null,
      };
      spotTradingViewDebug('getBars request', requestDebugPayload);
      const canUpdateActiveHistoryState = () => (
        !destroyed &&
        historyRequestSeqByLatestBarKey.get(latestBarKey) === historyRequestSeq
      );
      let didCompleteHistory = false;
      const safeHistoryCallback = (
        bars: TradingViewBar[],
        meta: { noData: boolean },
        emptyReason?: string,
      ) => {
        if (destroyed || didCompleteHistory) return;
        didCompleteHistory = true;
        if (!bars.length) {
          spotTradingViewDebug('callback empty reason', {
            symbol: apiSymbol,
            interval,
            chartInterval,
            backendInterval: interval,
            requestKind,
            noData: meta.noData,
            reason: emptyReason || 'empty bars',
          });
        }
        onHistory(bars, meta);
      };
      const safeErrorCallback = (reason: string) => {
        if (destroyed || didCompleteHistory) return;
        didCompleteHistory = true;
        onError(reason);
      };
      const rememberHistoryBars = (bars: TradingViewBar[]) => {
        const latestBar = bars[bars.length - 1] || null;
        if (latestBar) {
          latestBars.set(latestBarKey, latestBar);
          rememberRealtimeHighWaterMark(latestBarKey, latestBar.time);
          syncLastEmittedAfterHistory(latestBarKey, latestBar.time);
        }
      };
      if (periodParams.firstDataRequest !== false) {
        historyReadyByLatestBarKey.set(latestBarKey, false);
      }
      if (periodParams.firstDataRequest === false && Number(periodParams.to || 0) <= 0) {
        historyReadyByLatestBarKey.set(latestBarKey, true);
        spotTradingViewDebug('getBars response', {
          symbol: apiSymbol,
          interval,
          chartInterval,
          backendInterval: interval,
          requestKind,
          noData: false,
          emptyReason: 'history request missing positive to cursor',
          ...getBarsDebugStats([], interval),
        });
        safeHistoryCallback([], { noData: false }, 'history request missing positive to cursor');
        return;
      }

      const historyInFlightKey = isHistoryRequest && endTime
        ? buildHistoryKlineInFlightKey(apiSymbol, interval, periodParams, limit, endTime)
        : '';

      if (!isHistoryRequest) {
        const cached = readCurrentKlineCache(apiSymbol, interval, limit);
        if (cached?.bars.length) {
          if (canUpdateActiveHistoryState()) {
            rememberHistoryBars(cached.bars);
            options.onKlineLoadStateChange?.('loaded');
            historyReadyByLatestBarKey.set(latestBarKey, true);
          }
          const responseDebugPayload = {
            symbol: apiSymbol,
            interval,
            chartInterval,
            backendInterval: interval,
            requestKind,
            provider: cached.provider,
            source: cached.source,
            cacheHit: true,
            noData: false,
            ...getBarsDebugStats(cached.bars, interval),
            lastBars: buildBarDebugRows(cached.bars),
          };
          spotTradingViewDebug('getBars response', responseDebugPayload);
          safeHistoryCallback(cloneBars(cached.bars), { noData: false });

          void fetchAndCacheCurrentKlineBars({
            symbol: apiSymbol,
            interval,
            limit,
          }).catch((err: unknown) => {
            if (process.env.NODE_ENV !== 'production') {
              console.debug('[SpotTradingViewDatafeed] refresh kline cache failed', {
                symbol: apiSymbol,
                interval,
                chartInterval,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          });
          return;
        }
      }

      const request = historyInFlightKey
        ? getHistoryKlineRequestPromise({
          key: historyInFlightKey,
          symbol: apiSymbol,
          interval,
          limit,
          endTime,
        })
        : fetchKlineRequestBars({
          symbol: apiSymbol,
          interval,
          limit,
          endTime,
          forceRest: true,
        });

      void request
        .then(({ bars, provider, source }) => {
          if (!isHistoryRequest && bars.length) {
            writeCurrentKlineCache({
              symbol: apiSymbol,
              interval,
              limit,
              bars,
              provider,
              source,
            });
          }

          const noData = isHistoryRequest && bars.length === 0;
          const responseDebugPayload = {
            symbol: apiSymbol,
            interval,
            chartInterval,
            backendInterval: interval,
            requestKind,
            provider,
            source,
            noData,
            ...getBarsDebugStats(bars, interval),
            lastBars: buildBarDebugRows(bars),
          };
          spotTradingViewDebug('getBars response', responseDebugPayload);

          if (!isHistoryRequest && canUpdateActiveHistoryState()) {
            rememberHistoryBars(bars);

            options.onKlineLoadStateChange?.(bars.length > 0 ? 'loaded' : 'empty');
            historyReadyByLatestBarKey.set(latestBarKey, true);
          }
          safeHistoryCallback(
            bars,
            { noData },
            bars.length ? undefined : (isHistoryRequest ? 'backend returned empty history' : 'backend returned empty current'),
          );
        })
        .catch((err: unknown) => {
          if (!isHistoryRequest) {
            const cached = readCurrentKlineCache(apiSymbol, interval, limit, { allowStale: true });
            if (cached?.bars.length) {
              if (canUpdateActiveHistoryState()) {
                console.warn('[SpotTradingViewDatafeed] using cached kline bars after request failed', {
                  symbol: apiSymbol,
                  interval,
                  chartInterval,
                  error: err instanceof Error ? err.message : String(err),
                });
                rememberHistoryBars(cached.bars);
                options.onKlineLoadStateChange?.('loaded');
                historyReadyByLatestBarKey.set(latestBarKey, true);
              }
              spotTradingViewDebug('getBars response', {
                symbol: apiSymbol,
                interval,
                chartInterval,
                backendInterval: interval,
                requestKind,
                provider: cached.provider,
                source: cached.source,
                cacheHit: true,
                staleFallback: true,
                noData: false,
                ...getBarsDebugStats(cached.bars, interval),
                lastBars: buildBarDebugRows(cached.bars),
              });
              safeHistoryCallback(cloneBars(cached.bars), { noData: false });
              return;
            }
          }
          if (!isHistoryRequest && canUpdateActiveHistoryState()) {
            options.onKlineLoadStateChange?.('error');
            historyReadyByLatestBarKey.set(latestBarKey, true);
          }
          safeErrorCallback(err instanceof Error ? err.message : 'Failed to load spot history');
        });
    },

    subscribeBars(_symbolInfo, resolution, onRealtime, subscriberUid) {
      const existingUnsubscribe = unsubscribeByUid.get(subscriberUid);
      existingUnsubscribe?.();

      const requestResolution = normalizeResolution(resolution);
      const chartInterval = tradingViewResolutionToSpotInterval(requestResolution);
      const interval = getBackendKlineIntervalForTradingView(requestResolution);
      const latestBarKey = getLatestBarKey(requestResolution);
      const subscriptionKey = getSubscriptionKey(interval, subscriberUid);
      const isCurrentSubscription = () =>
        activeSubscriptionKeyByUid.get(subscriberUid) === subscriptionKey &&
        latestBarKeyByUid.get(subscriberUid) === latestBarKey;

      if (!historyReadyByLatestBarKey.has(latestBarKey)) {
        historyReadyByLatestBarKey.set(latestBarKey, false);
      }
      activeSubscriptionKeyByUid.set(subscriberUid, subscriptionKey);
      lastEmittedBarTimeByUid.set(
        subscriberUid,
        Math.max(latestBars.get(latestBarKey)?.time || 0, getRealtimeHighWaterMark(latestBarKey)),
      );
      latestBarKeyByUid.set(subscriberUid, latestBarKey);

      const emitRealtimeBar: EmitRealtimeBar = (bar, reason) => {
        if (!isCurrentSubscription()) return false;
        if (historyReadyByLatestBarKey.get(latestBarKey) === false) return false;
        if (!Number.isFinite(bar.time) || bar.time <= 0) return false;

        const lastEmittedTime = Math.max(
          lastEmittedBarTimeByUid.get(subscriberUid) || 0,
          latestBars.get(latestBarKey)?.time || 0,
          getRealtimeHighWaterMark(latestBarKey),
        );
        if (bar.time < lastEmittedTime) {
          if (process.env.NODE_ENV !== 'production') {
            const dropKey = `${reason}:${bar.time}:${lastEmittedTime}`;
            if (lastDroppedRealtimeBarByUid.get(subscriberUid) !== dropKey) {
              lastDroppedRealtimeBarByUid.set(subscriberUid, dropKey);
              console.debug('[SpotTradingViewDatafeed] drop stale realtime bar', {
                symbol: apiSymbol,
                interval,
                chartInterval,
                backendInterval: interval,
                subscriberUid,
                reason,
                barTime: bar.time,
                lastEmittedBarTime: lastEmittedTime,
              });
            }
          }
          return false;
        }

        const nextBar = { ...bar };
        latestBars.set(latestBarKey, nextBar);
        rememberRealtimeHighWaterMark(latestBarKey, nextBar.time);
        lastEmittedBarTimeByUid.set(subscriberUid, nextBar.time);
        onRealtime(nextBar);
        return true;
      };

      const handleKline = (realtimeMessage: SpotMarketRealtimeMessage) => {
        if (!isCurrentSubscription()) return;

        const message = realtimeMessage as SpotMarketKlineMessage;
        if (message.type !== 'spot_kline_update') return;

        const msgSymbol = normalizeSpotSymbol(message.symbol || '');
        if (msgSymbol !== apiSymbol) return;

        const msgInterval = normalizeSpotInterval(String(message.interval || ''));
        if (msgInterval !== interval) return;

        const klinePayload = message.kline && typeof message.kline === 'object'
          ? message.kline as Record<string, unknown>
          : null;
        const klineProvider = normalizeProvider(klinePayload?.provider || (message as { provider?: unknown }).provider);
        const klineSource = normalizeSource(klinePayload?.source || message.source);
        const bar = klinePayloadToBar(message.kline, interval, klineProvider, klineSource);
        if (!bar) return;

        const latestBar = latestBars.get(latestBarKey);
        const originalTime = klinePayload
          ? normalizeKlineTimeMs(klinePayload as SpotMarketKlineItem)
          : 0;
        const realtimeDebugPayload = {
          eventType: message.type,
          interval,
          chartInterval,
          backendInterval: interval,
          originalTime,
          normalizedTime: bar.time,
          tradingDate: getTradingDateFromNormalizedTime(bar.time),
          open: bar.open,
          high: bar.high,
          low: bar.low,
          close: bar.close,
          volume: bar.volume || 0,
          isDwm: isProviderCandleOnlyInterval(interval),
          matchedLastBarTime: Boolean(latestBar && latestBar.time === bar.time),
          provider: klineProvider || null,
          source: klineSource || null,
        };
        spotTradingViewDebug('subscribeBars update', realtimeDebugPayload);

        if (latestBar && bar.time < latestBar.time) return;

        const didEmit = emitRealtimeBar(bar, 'kline');
        if (!didEmit) return;
        options.onKlineRealtime?.({
          symbol: apiSymbol,
          interval,
          reason: 'kline',
          barTime: bar.time,
          updatedAtMs: Date.now(),
        });
      };

      const subscriptionId = spotMarketRealtime.acquireSubscription({
        symbol: apiSymbol,
        interval,
        domains: ['kline'],
        owner: `tradingview:${subscriberUid}`,
      });
      const unsubscribeKline = spotMarketRealtime.subscribe('kline', handleKline);
      const unsubscribe = () => {
        unsubscribeKline();
        spotMarketRealtime.releaseSubscription(subscriptionId);
      };
      unsubscribeByUid.set(subscriberUid, unsubscribe);
    },

    unsubscribeBars(subscriberUid) {
      const unsubscribe = unsubscribeByUid.get(subscriberUid);
      unsubscribe?.();
      unsubscribeByUid.delete(subscriberUid);
      const latestBarKey = latestBarKeyByUid.get(subscriberUid);
      if (latestBarKey) {
        latestBars.delete(latestBarKey);
        historyReadyByLatestBarKey.delete(latestBarKey);
        historyRequestSeqByLatestBarKey.delete(latestBarKey);
      }
      lastEmittedBarTimeByUid.delete(subscriberUid);
      lastDroppedRealtimeBarByUid.delete(subscriberUid);
      latestBarKeyByUid.delete(subscriberUid);
      activeSubscriptionKeyByUid.delete(subscriberUid);
    },

    destroy() {
      destroyed = true;
      for (const unsubscribe of Array.from(unsubscribeByUid.values())) {
        unsubscribe();
      }
      unsubscribeByUid.clear();
      latestBarKeyByUid.clear();
      latestBars.clear();
      historyReadyByLatestBarKey.clear();
      historyRequestSeqByLatestBarKey.clear();
      lastEmittedBarTimeByUid.clear();
      lastDroppedRealtimeBarByUid.clear();
      activeSubscriptionKeyByUid.clear();
    },
  };
}
