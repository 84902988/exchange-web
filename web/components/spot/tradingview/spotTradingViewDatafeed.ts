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
import {
  createSpotKlinePerfId,
  markSpotKlinePerf,
} from './spotKlinePerf';
import {
  buildKlineCachePerfPayload,
  cloneBars,
  fetchAndCacheCurrentKlineBars,
  getBackendKlineIntervalForSpotInterval,
  getBarsContinuityStats,
  getL1CurrentKlineCacheMinBars,
  getSpotIntervalMs,
  getSpotKlineLoadPolicy,
  inspectCurrentKlineCache,
  isProviderCandleOnlyInterval,
  isUtcProviderCandleInterval,
  mergeTradingViewBars,
  normalizeSpotInterval,
  readCurrentKlineCache,
  writeCurrentKlineCache,
  type SpotTradingViewBar,
} from './spotKlineClientCache';

type TradingViewResolution = '1' | '5' | '15' | '60' | '240' | '1D' | '1W' | '1M';

type TradingViewBar = SpotTradingViewBar;

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
  getActiveRealtimeIntervals: () => string[];
  syncRealtimeKlineSubscription: (interval: string, reason?: string) => {
    previousIntervals: string[];
    activeIntervals: string[];
    droppedIntervals: string[];
    changed: boolean;
  };
  destroy: () => void;
};

type SpotTradingViewDatafeedOptions = Pick<
  SpotChartProps,
  'symbol' | 'displaySymbol' | 'pricePrecision' | 'amountPrecision'
> & {
  debugEnabled?: boolean;
  onKlineLoadStateChange?: (state: SpotKlineLoadState) => void;
  onKlineRealtime?: (event: SpotTradingViewRealtimeEvent) => void;
  onHistoryBars?: (event: SpotTradingViewHistoryBarsEvent) => void;
};

export type SpotTradingViewHistoryBarsEvent = {
  requestSeq: number;
  phase: 'current' | 'history';
  isHistoryRequest: boolean;
  symbol: string;
  resolution: string;
  interval: string;
  chartInterval: string;
  backendInterval: string;
  requiredBars: number;
  barCount: number;
  firstBarTime: number | null;
  lastBarTime: number | null;
  noData: boolean;
};

type EmitRealtimeBar = (bar: TradingViewBar, reason: string) => boolean;

type HistoryKlineRequestResult = {
  bars: TradingViewBar[];
  provider?: unknown;
  source?: unknown;
  freshness?: unknown;
  stale?: unknown;
  cache_status?: unknown;
  history_incomplete?: unknown;
  provider_error_code?: unknown;
  provider_error_provider?: unknown;
  pageCount?: number;
  requestedBars?: number;
  reachedRequiredBars?: boolean;
  terminalNoData?: boolean;
  pages?: Array<{
    page: number;
    limit: number;
    endTime?: number;
    count: number;
    firstTime?: number | null;
    lastTime?: number | null;
    source?: unknown;
    freshness?: unknown;
    cache_status?: unknown;
    provider_error_code?: unknown;
    terminalEmpty?: boolean;
  }>;
};

type HistoryNoDataPolicy = {
  noData: boolean;
  shouldError: boolean;
  reason: string;
  hasMetadata: boolean;
  terminalEmpty: boolean;
  transientEmpty: boolean;
};

type SpotTvDebugEvent = {
  event: string;
  timestamp: number;
  time: string;
  [key: string]: unknown;
};

type SpotTvDebugWindow = Window & {
  __SPOT_TV_DEBUG_EVENTS__?: SpotTvDebugEvent[];
  __dumpSpotTvDebug?: () => SpotTvDebugEvent[];
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
const ASIA_SHANGHAI_OFFSET_MS = 8 * 60 * 60_000;
const TRADINGVIEW_TIMEZONE = 'Asia/Shanghai';
const realtimeHighWaterMarkByKey = new Map<string, number>();
const historyKlineRequestInFlightByKey = new Map<string, Promise<HistoryKlineRequestResult>>();
let forcedSpotTradingViewDebugEnabled = false;
let spotTradingViewGetBarsRequestSeq = 0;
let spotTradingViewDatafeedInstanceSeq = 0;
const SPOT_TV_DEBUG_EVENT_LIMIT = 500;
const SPOT_TV_GETBARS_API_PAGE_LIMIT = 500;
const SPOT_TV_GETBARS_MAX_INTERNAL_BARS = 1000;
const SPOT_TV_GETBARS_MAX_INTERNAL_PAGES = 3;

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

function getSpotTvDebugWindows(): SpotTvDebugWindow[] {
  if (typeof window === 'undefined') return [];
  const candidates: SpotTvDebugWindow[] = [window as SpotTvDebugWindow];

  try {
    if (window.parent && !candidates.includes(window.parent)) {
      candidates.push(window.parent as SpotTvDebugWindow);
    }
  } catch {
    // Parent access is best-effort only for diagnostics.
  }

  try {
    if (window.top && !candidates.includes(window.top)) {
      candidates.push(window.top as SpotTvDebugWindow);
    }
  } catch {
    // Top access is best-effort only for diagnostics.
  }

  return candidates;
}

function hasSpotTvDebugQuery(candidate: Window) {
  try {
    const search = candidate.location?.search || '';
    const href = candidate.location?.href || '';
    if (new URLSearchParams(search).get('tvdebug') === '1') return true;
    if (/[?&]tvdebug=1(?:&|$)/.test(href)) return true;
    const referrer = candidate.document?.referrer || '';
    if (referrer) {
      if (/[?&]tvdebug=1(?:&|$)/.test(referrer)) return true;
      return new URL(referrer, href || undefined).searchParams.get('tvdebug') === '1';
    }
  } catch {
    // Location access is best-effort only for diagnostics.
  }
  return false;
}

function hasSpotTvDebugUrlFlag() {
  for (const candidate of getSpotTvDebugWindows()) {
    if (hasSpotTvDebugQuery(candidate)) return true;
  }
  return false;
}

function ensureSpotTradingViewDebugBuffer() {
  for (const candidate of getSpotTvDebugWindows()) {
    try {
      candidate.__SPOT_TV_DEBUG_EVENTS__ = candidate.__SPOT_TV_DEBUG_EVENTS__ || [];
      candidate.__dumpSpotTvDebug = () => (candidate.__SPOT_TV_DEBUG_EVENTS__ || []).slice(-100);
    } catch {
      // Debug buffer is best-effort only.
    }
  }
}

function isSpotTradingViewDebugEnabled() {
  if (forcedSpotTradingViewDebugEnabled) return true;

  for (const candidate of getSpotTvDebugWindows()) {
    if (hasSpotTvDebugQuery(candidate)) {
      ensureSpotTradingViewDebugBuffer();
      return true;
    }
    try {
      if (candidate.localStorage?.getItem('SPOT_TV_DEBUG') === '1') {
        ensureSpotTradingViewDebugBuffer();
        return true;
      }
    } catch {
      // Storage access is best-effort only for diagnostics.
    }
  }
  return false;
}

function appendSpotTradingViewDebugEvent(entry: SpotTvDebugEvent) {
  for (const candidate of getSpotTvDebugWindows()) {
    try {
      const events = candidate.__SPOT_TV_DEBUG_EVENTS__ || [];
      events.push(entry);
      if (events.length > SPOT_TV_DEBUG_EVENT_LIMIT) {
        events.splice(0, events.length - SPOT_TV_DEBUG_EVENT_LIMIT);
      }
      candidate.__SPOT_TV_DEBUG_EVENTS__ = events;
      candidate.__dumpSpotTvDebug = () => (candidate.__SPOT_TV_DEBUG_EVENTS__ || []).slice(-100);
    } catch {
      // Debug buffer is best-effort only.
    }
  }
}

function spotTradingViewDebug(event: string, payload: Record<string, unknown>) {
  if (!isSpotTradingViewDebugEnabled()) return;
  ensureSpotTradingViewDebugBuffer();
  const timestamp = Date.now();
  const entry: SpotTvDebugEvent = {
    event,
    timestamp,
    time: new Date(timestamp).toISOString(),
    ...payload,
  };
  appendSpotTradingViewDebugEvent(entry);
  console.info(`[SpotTradingViewDatafeed] ${event}`, entry);
}

function getSpotDatafeedPerfNow() {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

function initializeSpotTvDebugTelemetry() {
  if (!hasSpotTvDebugUrlFlag()) return;
  forcedSpotTradingViewDebugEnabled = true;
  spotTradingViewDebug('datafeed module loaded', {
    href: typeof window !== 'undefined' ? window.location.href : null,
  });
}

initializeSpotTvDebugTelemetry();

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
    timeIso: bar.time ? new Date(bar.time).toISOString() : null,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume || 0,
  }));
}

function buildSpotTvDebugBarRow(bar: TradingViewBar) {
  return {
    time: bar.time,
    timeIso: bar.time ? new Date(bar.time).toISOString() : null,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume || 0,
  };
}

function buildSpotTvDebugBarsSummary(bars: TradingViewBar[]) {
  return {
    count: bars.length,
    firstTime: bars[0]?.time || null,
    firstTimeIso: bars[0]?.time ? new Date(bars[0].time).toISOString() : null,
    lastTime: bars[bars.length - 1]?.time || null,
    lastTimeIso: bars[bars.length - 1]?.time ? new Date(bars[bars.length - 1].time).toISOString() : null,
    firstBars: bars.slice(0, 3).map(buildSpotTvDebugBarRow),
    lastBars: bars.slice(-3).map(buildSpotTvDebugBarRow),
  };
}

function buildKlineItemDebugRows(
  items: SpotMarketKlineItem[] | undefined,
  interval: string,
  provider?: unknown,
  source?: unknown,
) {
  return (items || []).slice(-5).map((item) => {
    const originalTime = normalizeKlineTimeMs(item);
    const normalizedTime = providerOpenTimeToTradingViewTimeMs(originalTime, interval, provider, source);
    return {
      interval: normalizeSpotInterval(interval),
      originalTime,
      originalTimeIso: originalTime ? new Date(originalTime).toISOString() : null,
      normalizedTime,
      normalizedTimeIso: normalizedTime ? new Date(normalizedTime).toISOString() : null,
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

function normalizeKlineMetaValue(value: unknown): string {
  return String(value || '').trim().toUpperCase();
}

function getKlineErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error || '');
}

function getKlineErrorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return normalizeKlineMetaValue(code);
}

function isInvalidKlineRequestError(error: unknown): boolean {
  const code = getKlineErrorCode(error);
  if (code === 'INVALID_SYMBOL' || code === 'INVALID_INTERVAL' || code === 'SYMBOL_NOT_FOUND') {
    return true;
  }

  const message = getKlineErrorMessage(error).toLowerCase();
  return (
    message.includes('invalid symbol') ||
    message.includes('unknown symbol') ||
    message.includes('symbol not found') ||
    message.includes('trading pair not found') ||
    message.includes('pair not found') ||
    message.includes('invalid interval')
  );
}

function isUnparseableKlineResponseError(error: unknown): boolean {
  if (error instanceof SyntaxError) return true;
  const message = getKlineErrorMessage(error).toLowerCase();
  return (
    message.includes('unexpected token') ||
    message.includes('unexpected end of json') ||
    message.includes('failed to parse') ||
    message.includes('invalid json')
  );
}

function isTruthyKlineMeta(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === 'number') return value === 1;
  if (typeof value === 'string') return value.trim().toLowerCase() === 'true';
  return false;
}

function isTransientKlineProviderErrorCode(value: unknown): boolean {
  const providerErrorCode = normalizeKlineMetaValue(value);
  return (
    providerErrorCode === 'TIMEOUT' ||
    providerErrorCode === 'HTTP_ERROR' ||
    providerErrorCode === 'COOLDOWN' ||
    providerErrorCode === 'PROVIDER_UNAVAILABLE' ||
    providerErrorCode === 'TRANSIENT' ||
    providerErrorCode === 'UNKNOWN'
  );
}

function hasKlineHistoryMetadata(result: HistoryKlineRequestResult): boolean {
  return (
    result.freshness !== undefined ||
    result.stale !== undefined ||
    result.cache_status !== undefined ||
    result.history_incomplete !== undefined ||
    result.provider_error_code !== undefined ||
    result.provider_error_provider !== undefined
  );
}

function isTerminalEmptyKlineResult(result: HistoryKlineRequestResult): boolean {
  return (
    result.bars.length === 0 &&
    normalizeSource(result.source) === 'EMPTY' &&
    normalizeKlineMetaValue(result.freshness) === 'MISSING' &&
    normalizeKlineMetaValue(result.provider_error_code) === 'EMPTY'
  );
}

function resolveHistoryNoDataPolicy(params: {
  isHistoryRequest: boolean;
  result: HistoryKlineRequestResult;
}): HistoryNoDataPolicy {
  const { isHistoryRequest, result } = params;
  if (!isHistoryRequest) {
    return {
      noData: false,
      shouldError: false,
      reason: 'current request',
      hasMetadata: hasKlineHistoryMetadata(result),
      terminalEmpty: false,
      transientEmpty: false,
    };
  }

  if (result.bars.length > 0) {
    return {
      noData: false,
      shouldError: false,
      reason: 'history bars returned',
      hasMetadata: hasKlineHistoryMetadata(result),
      terminalEmpty: false,
      transientEmpty: false,
    };
  }

  const hasMetadata = hasKlineHistoryMetadata(result);
  if (!hasMetadata) {
    return {
      noData: true,
      shouldError: false,
      reason: 'legacy empty history',
      hasMetadata,
      terminalEmpty: true,
      transientEmpty: false,
    };
  }

  const source = normalizeSource(result.source);
  const freshness = normalizeKlineMetaValue(result.freshness);
  const providerErrorCode = normalizeKlineMetaValue(result.provider_error_code);
  const stale = isTruthyKlineMeta(result.stale);
  const historyIncomplete = isTruthyKlineMeta(result.history_incomplete);
  const terminalEmpty = isTerminalEmptyKlineResult(result);

  if (terminalEmpty) {
    return {
      noData: true,
      shouldError: false,
      reason: 'terminal empty history',
      hasMetadata,
      terminalEmpty: true,
      transientEmpty: false,
    };
  }

  const transientProviderEmpty = isTransientKlineProviderErrorCode(providerErrorCode);
  const transientEmpty = (
    transientProviderEmpty ||
    (historyIncomplete && providerErrorCode !== 'EMPTY') ||
    stale ||
    freshness === 'STALE' ||
    source === 'STALE_CACHE'
  );

  return {
    noData: false,
    shouldError: false,
    reason: transientEmpty ? 'transient empty history' : 'non-terminal empty history',
    hasMetadata,
    terminalEmpty: false,
    transientEmpty,
  };
}

function shouldStopInitialOlderProviderHistory(params: {
  interval: string;
  isHistoryRequest: boolean;
  isFirstDataRequest: boolean;
  bars: TradingViewBar[];
}) {
  const { interval, isHistoryRequest, isFirstDataRequest, bars } = params;
  return (
    !isHistoryRequest &&
    isFirstDataRequest &&
    bars.length > 0 &&
    normalizeSpotInterval(interval) === '1Mutc'
  );
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

export function spotIntervalToTradingViewResolution(interval: string): TradingViewResolution {
  const normalized = normalizeSpotInterval(interval);
  return SPOT_INTERVAL_TO_RESOLUTION[normalized] || '1';
}

function tradingViewResolutionToSpotInterval(resolution: string): string {
  return RESOLUTION_TO_SPOT_INTERVAL[normalizeResolution(resolution)] || '1m';
}

function getBackendKlineIntervalForTradingView(resolution: string): string {
  return getBackendKlineIntervalForSpotInterval(tradingViewResolutionToSpotInterval(resolution));
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

function normalizeRequiredKlineBars(countBack: number, fallback: number) {
  const requested = Number(countBack);
  if (!Number.isFinite(requested) || requested <= 0) return fallback;
  return Math.min(SPOT_TV_GETBARS_MAX_INTERNAL_BARS, Math.max(1, Math.floor(requested)));
}

function getCurrentKlineRequiredBars(interval: string, countBack?: number) {
  const policy = getSpotKlineLoadPolicy(interval);
  return normalizeRequiredKlineBars(Number(countBack || 0), policy.current);
}

function getHistoryKlineLimit(interval: string, countBack: number) {
  const policy = getSpotKlineLoadPolicy(interval);
  return normalizeRequiredKlineBars(countBack, policy.history);
}

function getCurrentKlineInitialLimit(interval: string, requiredBars: number) {
  const policy = getSpotKlineLoadPolicy(interval);
  const normalizedRequiredBars = Math.max(1, Math.floor(requiredBars || policy.current));
  if (isProviderCandleOnlyInterval(interval)) {
    return Math.min(normalizedRequiredBars, policy.current);
  }
  return getKlineRequestPageLimit(normalizedRequiredBars);
}

function getKlineRequestPageLimit(requiredBars: number, loadedBars = 0) {
  const remaining = Math.max(1, requiredBars - loadedBars);
  const remainingInternalCapacity = Math.max(1, SPOT_TV_GETBARS_MAX_INTERNAL_BARS - loadedBars);
  return Math.min(remaining, remainingInternalCapacity, SPOT_TV_GETBARS_API_PAGE_LIMIT);
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
    freshness: payload.freshness,
    stale: payload.stale,
    cache_status: payload.cache_status,
    history_incomplete: payload.history_incomplete,
    provider_error_code: payload.provider_error_code,
    provider_error_provider: payload.provider_error_provider,
    endTime: params.endTime || null,
    rows: buildKlineItemDebugRows(payload.items, params.interval, payload.provider, payload.source),
  });
  const bars = normalizeHistoryBars(payload.items, params.interval, payload.provider, payload.source);
  return {
    bars,
    provider: payload.provider,
    source: payload.source,
    freshness: payload.freshness,
    stale: payload.stale,
    cache_status: payload.cache_status,
    history_incomplete: payload.history_incomplete,
    provider_error_code: payload.provider_error_code,
    provider_error_provider: payload.provider_error_provider,
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

async function fetchCountBackKlineRequestBars(params: {
  symbol: string;
  interval: string;
  requiredBars: number;
  initialLimit: number;
  endTime?: number;
  isHistoryRequest: boolean;
  periodParams: TradingViewPeriodParams;
  requestSeq: number;
  phase: string;
}): Promise<HistoryKlineRequestResult> {
  const pages: NonNullable<HistoryKlineRequestResult['pages']> = [];
  let combinedBars: TradingViewBar[] = [];
  let firstResult: HistoryKlineRequestResult | null = null;
  let cursorEndTime = params.endTime;
  let terminalNoData = false;

  for (let page = 1; page <= SPOT_TV_GETBARS_MAX_INTERNAL_PAGES; page += 1) {
    const loadedBars = combinedBars.length;
    const limit = page === 1
      ? params.initialLimit
      : getKlineRequestPageLimit(params.requiredBars, loadedBars);
    const key = params.isHistoryRequest && cursorEndTime
      ? buildHistoryKlineInFlightKey(params.symbol, params.interval, params.periodParams, limit, cursorEndTime)
      : '';
    const result = key
      ? await getHistoryKlineRequestPromise({
        key,
        symbol: params.symbol,
        interval: params.interval,
        limit,
        endTime: cursorEndTime,
      })
      : await fetchKlineRequestBars({
        symbol: params.symbol,
        interval: params.interval,
        limit,
        endTime: cursorEndTime,
        forceRest: true,
      });

    if (!firstResult) firstResult = result;

    const terminalEmpty = isTerminalEmptyKlineResult(result);
    pages.push({
      page,
      limit,
      endTime: cursorEndTime,
      count: result.bars.length,
      firstTime: result.bars[0]?.time || null,
      lastTime: result.bars[result.bars.length - 1]?.time || null,
      source: result.source,
      freshness: result.freshness,
      cache_status: result.cache_status,
      provider_error_code: result.provider_error_code,
      terminalEmpty,
    });
    spotTradingViewDebug('getBars backfill page', {
      requestSeq: params.requestSeq,
      phase: params.phase,
      symbol: params.symbol,
      interval: normalizeSpotInterval(params.interval),
      page,
      limit,
      end_time: cursorEndTime || null,
      end_time_ms: cursorEndTime || null,
      requiredBars: params.requiredBars,
      terminalEmpty,
      source: result.source,
      freshness: result.freshness,
      cache_status: result.cache_status,
      provider_error_code: result.provider_error_code,
      ...getBarsDebugStats(result.bars, params.interval),
      barsSummary: buildSpotTvDebugBarsSummary(result.bars),
    });

    if (!result.bars.length) {
      terminalNoData = terminalEmpty;
      if (terminalEmpty) break;
      return {
        ...result,
        bars: [],
        pageCount: pages.length,
        requestedBars: params.requiredBars,
        reachedRequiredBars: false,
        terminalNoData,
        pages,
      };
    }

    const beforeCount = combinedBars.length;
    combinedBars = mergeTradingViewBars([...combinedBars, ...result.bars]);
    const earliestBar = combinedBars[0];

    if (combinedBars.length >= params.requiredBars || !earliestBar) break;
    if (combinedBars.length <= beforeCount) {
      break;
    }
    cursorEndTime = earliestBar.time;
  }

  const finalBars = mergeTradingViewBars(combinedBars)
    .slice(-Math.min(params.requiredBars, SPOT_TV_GETBARS_MAX_INTERNAL_BARS));
  const reachedRequiredBars = finalBars.length >= params.requiredBars;
  const baseResult = firstResult || {
    bars: [],
  };

  return {
    ...baseResult,
    bars: finalBars,
    pageCount: pages.length,
    requestedBars: params.requiredBars,
    reachedRequiredBars,
    terminalNoData,
    pages,
  };
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
  forcedSpotTradingViewDebugEnabled = (
    Boolean(options.debugEnabled) ||
    hasSpotTvDebugUrlFlag() ||
    (typeof window !== 'undefined' && /[?&]tvdebug=1(?:&|$)/.test(window.location.href))
  );
  const symbolInfo = buildSymbolInfo(options);
  const apiSymbol = normalizeSpotSymbol(symbolInfo.ticker || symbolInfo.name);
  spotTradingViewDebug('datafeed created', {
    symbol: apiSymbol,
    symbolInfoName: symbolInfo.name,
    supportedResolutions: SUPPORTED_RESOLUTIONS,
  });
  let destroyed = false;
  let activeGetBarsLatestBarKey = '';
  const realtimeOwner = `tradingview:${apiSymbol}:${++spotTradingViewDatafeedInstanceSeq}`;
  const latestBars = new Map<string, TradingViewBar>();
  const latestBarKeyByUid = new Map<string, string>();
  const activeRealtimeIntervalByUid = new Map<string, string>();
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

  const clearRealtimeSubscriberState = (subscriberUid: string) => {
    const latestBarKey = latestBarKeyByUid.get(subscriberUid);
    if (latestBarKey) {
      latestBars.delete(latestBarKey);
      historyReadyByLatestBarKey.delete(latestBarKey);
      historyRequestSeqByLatestBarKey.delete(latestBarKey);
    }
    lastEmittedBarTimeByUid.delete(subscriberUid);
    lastDroppedRealtimeBarByUid.delete(subscriberUid);
    latestBarKeyByUid.delete(subscriberUid);
    activeRealtimeIntervalByUid.delete(subscriberUid);
    activeSubscriptionKeyByUid.delete(subscriberUid);
  };

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
      const requestSeq = spotTradingViewGetBarsRequestSeq + 1;
      spotTradingViewGetBarsRequestSeq = requestSeq;
      const requestResolution = normalizeResolution(resolution);
      const chartInterval = tradingViewResolutionToSpotInterval(requestResolution);
      const interval = getBackendKlineIntervalForTradingView(requestResolution);
      const countBack = Number(periodParams.countBack || 0);
      const { isHistoryRequest, requestedEndTime } = classifyKlineRequest(periodParams);
      const requiredBars = isHistoryRequest
        ? getHistoryKlineLimit(interval, countBack)
        : getCurrentKlineRequiredBars(interval, countBack);
      const limit = isHistoryRequest
        ? getKlineRequestPageLimit(requiredBars)
        : getCurrentKlineInitialLimit(interval, requiredBars);
      const endTime = isHistoryRequest && requestedEndTime > 0 ? requestedEndTime : undefined;
      const requestKind = isHistoryRequest ? 'history' : 'current';
      const latestBarKey = getLatestBarKey(requestResolution);
      const historyRequestSeq = (historyRequestSeqByLatestBarKey.get(latestBarKey) || 0) + 1;
      historyRequestSeqByLatestBarKey.set(latestBarKey, historyRequestSeq);
      activeGetBarsLatestBarKey = latestBarKey;
      const isFirstDataRequest = periodParams.firstDataRequest !== false;
      const periodDebugPayload = {
        from: periodParams.from,
        to: periodParams.to,
        countBack,
        firstDataRequest: isFirstDataRequest,
      };
      const requestDebugPayload = {
        requestSeq,
        phase: requestKind,
        symbol: apiSymbol,
        symbolInfoName: _symbolInfo.name,
        interval,
        chartInterval,
        backendInterval: interval,
        resolution: requestResolution,
        periodParams: periodDebugPayload,
        firstDataRequest: isFirstDataRequest,
        from: periodParams.from,
        to: periodParams.to,
        countBack,
        requiredBars,
        apiLimit: limit,
        limit,
        requestKind,
        endTime: endTime || null,
        end_time: endTime || null,
        end_time_ms: endTime || null,
        forceRest: true,
      };
      const getBarsRequestId = createSpotKlinePerfId('getBars');
      const getBarsStartedAt = getSpotDatafeedPerfNow();
      const getBarsPerfPayload = {
        requestId: getBarsRequestId,
        requestSeq,
        phase: requestKind,
        symbol: apiSymbol,
        symbolInfoName: _symbolInfo.name,
        interval,
        chartInterval,
        backendInterval: interval,
        resolution: requestResolution,
        countBack,
        from: periodParams.from,
        to: periodParams.to,
        limit,
        apiLimit: limit,
        requiredBars,
        force_rest: true,
        firstDataRequest: isFirstDataRequest,
        end_time: endTime || null,
        end_time_ms: endTime || null,
      };
      markSpotKlinePerf('getBars_start', getBarsPerfPayload);
      spotTradingViewDebug('getBars request', requestDebugPayload);
      const getHistoryCallbackGuardState = () => {
        const isLatestRequest = historyRequestSeqByLatestBarKey.get(latestBarKey) === historyRequestSeq;
        const activeSubscriptionCount = latestBarKeyByUid.size;
        const hasMatchingActiveSubscription = Array.from(latestBarKeyByUid.values()).some((subscriberLatestBarKey) => (
          subscriberLatestBarKey === latestBarKey
        ));
        const isActiveRequestResolution = activeGetBarsLatestBarKey === latestBarKey;
        const hasActiveSubscription = hasMatchingActiveSubscription || isActiveRequestResolution;

        return {
          destroyed,
          isLatestRequest,
          activeSubscriptionCount,
          hasMatchingActiveSubscription,
          isActiveRequestResolution,
          hasActiveSubscription,
          canUse: !destroyed && isLatestRequest && hasActiveSubscription,
        };
      };
      const canUpdateActiveHistoryState = () => getHistoryCallbackGuardState().canUse;
      let didCompleteHistory = false;
      const safeHistoryCallback = (
        bars: TradingViewBar[],
        meta: { noData: boolean },
        emptyReason?: string,
      ) => {
        const guardState = getHistoryCallbackGuardState();
        if (didCompleteHistory || !guardState.canUse) {
          markSpotKlinePerf('getBars_guard_drop', {
            ...getBarsPerfPayload,
            duration_ms: Math.max(0, getSpotDatafeedPerfNow() - getBarsStartedAt),
            bars_count: bars.length,
            noData: meta.noData,
            note: emptyReason || 'history callback guard blocked',
            didCompleteHistory,
            ...guardState,
          });
          spotTradingViewDebug('getBars callback skipped', {
            requestSeq,
            phase: requestKind,
            symbol: apiSymbol,
            symbolInfoName: _symbolInfo.name,
            resolution: requestResolution,
            backendInterval: interval,
            didCompleteHistory,
            ...guardState,
            noData: meta.noData,
            emptyReason: emptyReason || null,
            barsSummary: buildSpotTvDebugBarsSummary(bars),
          });
          return;
        }
        didCompleteHistory = true;
        if (!bars.length) {
          spotTradingViewDebug('callback empty reason', {
            requestSeq,
            phase: requestKind,
            symbol: apiSymbol,
            symbolInfoName: _symbolInfo.name,
            resolution: requestResolution,
            interval,
            chartInterval,
            backendInterval: interval,
            requestKind,
            noData: meta.noData,
            reason: emptyReason || 'empty bars',
          });
        }
        if (meta.noData || bars.length === 0) {
          markSpotKlinePerf('getBars_noData', {
            ...getBarsPerfPayload,
            duration_ms: Math.max(0, getSpotDatafeedPerfNow() - getBarsStartedAt),
            bars_count: bars.length,
            noData: meta.noData,
            note: emptyReason || (meta.noData ? 'noData callback' : 'empty bars callback'),
          });
        }
        spotTradingViewDebug('getBars callback', {
          requestSeq,
          phase: requestKind,
          symbol: apiSymbol,
          symbolInfoName: _symbolInfo.name,
          resolution: requestResolution,
          backendInterval: interval,
          periodParams: periodDebugPayload,
          apiLimit: limit,
          limit,
          requiredBars,
          end_time: endTime || null,
          end_time_ms: endTime || null,
          forceRest: true,
          noData: meta.noData,
          emptyReason: emptyReason || null,
          callbackTime: Date.now(),
          callbackTimeIso: new Date().toISOString(),
          barsSummary: buildSpotTvDebugBarsSummary(bars),
        });
        markSpotKlinePerf('getBars_onHistory', {
          ...getBarsPerfPayload,
          duration_ms: Math.max(0, getSpotDatafeedPerfNow() - getBarsStartedAt),
          bars_count: bars.length,
          noData: meta.noData,
          note: emptyReason,
        });
        onHistory(bars, meta);
        try {
          const firstBar = bars[0] || null;
          const lastBar = bars[bars.length - 1] || null;
          options.onHistoryBars?.({
            requestSeq,
            phase: requestKind,
            isHistoryRequest,
            symbol: apiSymbol,
            resolution: requestResolution,
            interval,
            chartInterval,
            backendInterval: interval,
            requiredBars,
            barCount: bars.length,
            firstBarTime: firstBar?.time ?? null,
            lastBarTime: lastBar?.time ?? null,
            noData: meta.noData,
          });
        } catch (error) {
          if (process.env.NODE_ENV !== 'production') {
            console.debug('[SpotTradingViewDatafeed] onHistoryBars callback failed', {
              symbol: apiSymbol,
              resolution: requestResolution,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      };
      const safeErrorCallback = (reason: string) => {
        const guardState = getHistoryCallbackGuardState();
        if (didCompleteHistory || !guardState.canUse) {
          markSpotKlinePerf('getBars_guard_drop', {
            ...getBarsPerfPayload,
            duration_ms: Math.max(0, getSpotDatafeedPerfNow() - getBarsStartedAt),
            note: reason,
            didCompleteHistory,
            ...guardState,
          });
          spotTradingViewDebug('getBars error callback skipped', {
            requestSeq,
            phase: requestKind,
            symbol: apiSymbol,
            symbolInfoName: _symbolInfo.name,
            resolution: requestResolution,
            backendInterval: interval,
            didCompleteHistory,
            ...guardState,
            reason,
          });
          return;
        }
        didCompleteHistory = true;
        markSpotKlinePerf('getBars_error', {
          ...getBarsPerfPayload,
          duration_ms: Math.max(0, getSpotDatafeedPerfNow() - getBarsStartedAt),
          error: reason,
        });
        spotTradingViewDebug('getBars error callback', {
          requestSeq,
          phase: requestKind,
          symbol: apiSymbol,
          symbolInfoName: _symbolInfo.name,
          resolution: requestResolution,
          backendInterval: interval,
          periodParams: periodDebugPayload,
          apiLimit: limit,
          limit,
          requiredBars,
          end_time: endTime || null,
          end_time_ms: endTime || null,
          forceRest: true,
          reason,
          callbackTime: Date.now(),
          callbackTimeIso: new Date().toISOString(),
        });
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
          requestSeq,
          phase: requestKind,
          symbol: apiSymbol,
          symbolInfoName: _symbolInfo.name,
          interval,
          chartInterval,
          backendInterval: interval,
          resolution: requestResolution,
          periodParams: periodDebugPayload,
          apiLimit: limit,
          requiredBars,
          requestKind,
          end_time: endTime || null,
          end_time_ms: endTime || null,
          forceRest: true,
          noData: false,
          emptyReason: 'history request missing positive to cursor',
          ...getBarsDebugStats([], interval),
          barsSummary: buildSpotTvDebugBarsSummary([]),
        });
        safeHistoryCallback([], { noData: false }, 'history request missing positive to cursor');
        return;
      }

      if (!isHistoryRequest && !endTime) {
        const l1MinBars = getL1CurrentKlineCacheMinBars(interval, requiredBars);
        const cacheLookup = inspectCurrentKlineCache(apiSymbol, interval, requiredBars, { minBars: l1MinBars });
        const cached = cacheLookup.hit;
        const cachedContinuityStats = cached ? getBarsContinuityStats(cached.bars, interval) : null;
        const cachePerfPayload = {
          ...getBarsPerfPayload,
          ...buildKlineCachePerfPayload(cacheLookup.candidate || cached, {
            symbol: apiSymbol,
            interval,
            limit: requiredBars,
          }),
          minBars: cacheLookup.minBars,
          requestedLimit: cacheLookup.requestedLimit,
          cache_age_ms: cacheLookup.cacheAgeMs ?? null,
          continuityGapCount: cacheLookup.continuityStats?.gapCount ?? cachedContinuityStats?.gapCount ?? null,
          continuityDuplicateCount:
            cacheLookup.continuityStats?.duplicateCount ?? cachedContinuityStats?.duplicateCount ?? null,
          continuityMaxGap: cacheLookup.continuityStats?.maxGap ?? cachedContinuityStats?.maxGap ?? null,
        };
        if (
          cached?.bars.length &&
          cached.bars.length >= requiredBars &&
          cached.bars.length >= l1MinBars &&
          cachedContinuityStats?.gapCount === 0 &&
          cachedContinuityStats.duplicateCount === 0
        ) {
          const stopInitialOlderHistory = shouldStopInitialOlderProviderHistory({
            interval,
            isHistoryRequest,
            isFirstDataRequest,
            bars: cached.bars,
          });
          if (canUpdateActiveHistoryState()) {
            rememberHistoryBars(cached.bars);
            options.onKlineLoadStateChange?.('loaded');
            historyReadyByLatestBarKey.set(latestBarKey, true);
          }
          const responseDebugPayload = {
            requestSeq,
            phase: requestKind,
            symbol: apiSymbol,
            symbolInfoName: _symbolInfo.name,
            interval,
            chartInterval,
            backendInterval: interval,
            resolution: requestResolution,
            periodParams: periodDebugPayload,
            apiLimit: limit,
            limit,
            requiredBars,
            end_time: endTime || null,
            end_time_ms: endTime || null,
            forceRest: false,
            requestKind,
            provider: cached.provider,
            source: cached.source,
            cacheHit: true,
            noData: stopInitialOlderHistory,
            noDataDecision: stopInitialOlderHistory ? 'current provider visible window complete' : 'current cache hit',
            ...getBarsDebugStats(cached.bars, interval),
            continuityGapCount: cachedContinuityStats.gapCount,
            continuityDuplicateCount: cachedContinuityStats.duplicateCount,
            continuityMaxGap: cachedContinuityStats.maxGap,
            barsSummary: buildSpotTvDebugBarsSummary(cached.bars),
            lastBars: buildBarDebugRows(cached.bars),
          };
          spotTradingViewDebug('getBars response', responseDebugPayload);
          markSpotKlinePerf('kline_l1_cache_hit', {
            ...cachePerfPayload,
            duration_ms: Math.max(0, getSpotDatafeedPerfNow() - getBarsStartedAt),
            bars_count: cached.bars.length,
            reason: cached.bars.length >= requiredBars ? 'full current cache hit' : 'partial current cache hit',
          });
          markSpotKlinePerf('getBars_cache_hit', {
            ...getBarsPerfPayload,
            duration_ms: Math.max(0, getSpotDatafeedPerfNow() - getBarsStartedAt),
            force_rest: false,
            bars_count: cached.bars.length,
            source: cached.source,
            provider: cached.provider,
            noData: stopInitialOlderHistory,
            note: stopInitialOlderHistory ? 'current provider visible window complete' : 'current cache hit',
          });
          safeHistoryCallback(cloneBars(cached.bars), { noData: stopInitialOlderHistory });

          void fetchAndCacheCurrentKlineBars({
            symbol: apiSymbol,
            interval,
            limit: l1MinBars,
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
        const cacheInsufficientForCountBack = Boolean(cached?.bars.length && cached.bars.length < requiredBars);
        const l1Reason = cacheInsufficientForCountBack ? 'insufficient_bars_for_countBack' : cacheLookup.reason;
        const l1Event = l1Reason === 'expired'
          ? 'kline_l1_cache_expired'
          : l1Reason === 'reject_continuity'
            ? 'kline_l1_cache_reject_continuity'
            : 'kline_l1_cache_miss';
        markSpotKlinePerf(l1Event, {
          ...cachePerfPayload,
          duration_ms: Math.max(0, getSpotDatafeedPerfNow() - getBarsStartedAt),
          reason: l1Reason,
        });
        if (cached?.bars.length) {
          spotTradingViewDebug('getBars cache skipped', {
            requestSeq,
            phase: requestKind,
            symbol: apiSymbol,
            symbolInfoName: _symbolInfo.name,
            interval,
            chartInterval,
            backendInterval: interval,
            resolution: requestResolution,
            cacheCount: cached.bars.length,
            requiredBars,
            continuityGapCount: cachedContinuityStats?.gapCount ?? null,
            continuityDuplicateCount: cachedContinuityStats?.duplicateCount ?? null,
            continuityMaxGap: cachedContinuityStats?.maxGap ?? null,
          });
        }
        markSpotKlinePerf('getBars_cache_miss', {
          ...getBarsPerfPayload,
          duration_ms: Math.max(0, getSpotDatafeedPerfNow() - getBarsStartedAt),
          cached_bars_count: cached?.bars.length || 0,
          continuityGapCount: cachedContinuityStats?.gapCount ?? null,
          continuityDuplicateCount: cachedContinuityStats?.duplicateCount ?? null,
          note: cached?.bars.length ? 'current cache insufficient or discontinuous' : 'current cache empty',
        });
      }

      const restRequestStartedAt = getSpotDatafeedPerfNow();
      markSpotKlinePerf('getBars_request_start', {
        ...getBarsPerfPayload,
        duration_ms: Math.max(0, restRequestStartedAt - getBarsStartedAt),
      });
      const request = fetchCountBackKlineRequestBars({
        symbol: apiSymbol,
        interval,
        requiredBars,
        initialLimit: limit,
        endTime,
        isHistoryRequest,
        periodParams,
        requestSeq,
        phase: requestKind,
      });

      void request
        .then((result) => {
          const { bars, provider, source } = result;
          markSpotKlinePerf('getBars_request_end', {
            ...getBarsPerfPayload,
            duration_ms: Math.max(0, getSpotDatafeedPerfNow() - restRequestStartedAt),
            bars_count: bars.length,
            source,
            provider,
            freshness: result.freshness,
            cache_status: result.cache_status,
            pageCount: result.pageCount,
            requestedBars: result.requestedBars,
            reachedRequiredBars: result.reachedRequiredBars,
            history_incomplete: result.history_incomplete,
            provider_error_code: result.provider_error_code,
            provider_error_provider: result.provider_error_provider,
          });
          if (!isHistoryRequest && bars.length) {
            writeCurrentKlineCache({
              symbol: apiSymbol,
              interval,
              limit: Math.max(requiredBars, bars.length),
              bars,
              provider,
              source,
            });
          }

          const noDataPolicy = resolveHistoryNoDataPolicy({ isHistoryRequest, result });
          const stopInitialOlderHistory = shouldStopInitialOlderProviderHistory({
            interval,
            isHistoryRequest,
            isFirstDataRequest,
            bars,
          });
          const callbackNoData = stopInitialOlderHistory ? true : noDataPolicy.noData;
          const noDataDecision = stopInitialOlderHistory
            ? 'current provider visible window complete'
            : noDataPolicy.reason;
          const continuityStats = getBarsContinuityStats(bars, interval);
          const terminalNoData = Boolean(result.terminalNoData || isTerminalEmptyKlineResult(result));
          const reachedRequiredBars = result.reachedRequiredBars ?? bars.length >= requiredBars;
          const responseDebugPayload = {
            requestSeq,
            phase: requestKind,
            symbol: apiSymbol,
            symbolInfoName: _symbolInfo.name,
            interval,
            chartInterval,
            backendInterval: interval,
            resolution: requestResolution,
            periodParams: periodDebugPayload,
            apiLimit: limit,
            limit,
            requiredBars,
            end_time: endTime || null,
            end_time_ms: endTime || null,
            forceRest: true,
            requestKind,
            pageCount: result.pageCount,
            pages: result.pages,
            requestedBars: result.requestedBars,
            reachedRequiredBars,
            terminalNoData,
            provider,
            source,
            freshness: result.freshness,
            stale: result.stale,
            cache_status: result.cache_status,
            history_incomplete: result.history_incomplete,
            provider_error_code: result.provider_error_code,
            provider_error_provider: result.provider_error_provider,
            noData: callbackNoData,
            noDataDecision,
            terminalEmpty: noDataPolicy.terminalEmpty,
            transientEmpty: noDataPolicy.transientEmpty,
            metadataPresent: noDataPolicy.hasMetadata,
            ...getBarsDebugStats(bars, interval),
            continuityGapCount: continuityStats.gapCount,
            continuityDuplicateCount: continuityStats.duplicateCount,
            continuityMaxGap: continuityStats.maxGap,
            barsSummary: buildSpotTvDebugBarsSummary(bars),
            lastBars: buildBarDebugRows(bars),
          };
          spotTradingViewDebug('getBars response', responseDebugPayload);

          if (!isHistoryRequest && canUpdateActiveHistoryState()) {
            rememberHistoryBars(bars);

            options.onKlineLoadStateChange?.(bars.length > 0 ? 'loaded' : 'empty');
            historyReadyByLatestBarKey.set(latestBarKey, true);
          }
          if (noDataPolicy.shouldError) {
            safeHistoryCallback([], { noData: callbackNoData }, noDataDecision);
            return;
          }
          if (bars.length && (continuityStats.gapCount > 0 || continuityStats.duplicateCount > 0)) {
            safeErrorCallback('Kline history temporarily unavailable');
            return;
          }
          safeHistoryCallback(
            bars,
            { noData: callbackNoData },
            bars.length
              ? (stopInitialOlderHistory ? noDataDecision : (reachedRequiredBars ? undefined : 'partial bars returned'))
              : noDataDecision,
          );
        })
        .catch((err: unknown) => {
          markSpotKlinePerf('getBars_request_end', {
            ...getBarsPerfPayload,
            duration_ms: Math.max(0, getSpotDatafeedPerfNow() - restRequestStartedAt),
            bars_count: 0,
            error: err instanceof Error ? err.message : String(err),
          });
          if (!isHistoryRequest) {
            const cached = readCurrentKlineCache(apiSymbol, interval, requiredBars, { allowStale: true });
            const cachedContinuityStats = cached ? getBarsContinuityStats(cached.bars, interval) : null;
            if (
              cached?.bars.length &&
              cachedContinuityStats?.gapCount === 0 &&
              cachedContinuityStats.duplicateCount === 0
            ) {
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
                requestSeq,
                phase: requestKind,
                symbol: apiSymbol,
                symbolInfoName: _symbolInfo.name,
                interval,
                chartInterval,
                backendInterval: interval,
                resolution: requestResolution,
                periodParams: periodDebugPayload,
                apiLimit: limit,
                limit,
                requiredBars,
                end_time: endTime || null,
                end_time_ms: endTime || null,
                forceRest: false,
                requestKind,
                provider: cached.provider,
                source: cached.source,
                cacheHit: true,
                staleFallback: true,
                noData: false,
                ...getBarsDebugStats(cached.bars, interval),
                continuityGapCount: cachedContinuityStats.gapCount,
                continuityDuplicateCount: cachedContinuityStats.duplicateCount,
                continuityMaxGap: cachedContinuityStats.maxGap,
                barsSummary: buildSpotTvDebugBarsSummary(cached.bars),
                lastBars: buildBarDebugRows(cached.bars),
              });
              markSpotKlinePerf('getBars_cache_hit', {
                ...getBarsPerfPayload,
                duration_ms: Math.max(0, getSpotDatafeedPerfNow() - getBarsStartedAt),
                force_rest: false,
                bars_count: cached.bars.length,
                source: cached.source,
                provider: cached.provider,
                note: 'stale fallback after request failed',
                error: err instanceof Error ? err.message : String(err),
              });
              safeHistoryCallback(cloneBars(cached.bars), { noData: false });
              return;
            }
          }
          const shouldEmitFatalError = isInvalidKlineRequestError(err) || isUnparseableKlineResponseError(err);
          markSpotKlinePerf('getBars_error', {
            ...getBarsPerfPayload,
            duration_ms: Math.max(0, getSpotDatafeedPerfNow() - getBarsStartedAt),
            fatal: shouldEmitFatalError,
            error: getKlineErrorMessage(err) || 'Failed to load spot history',
          });
          if (!isHistoryRequest && canUpdateActiveHistoryState()) {
            options.onKlineLoadStateChange?.(shouldEmitFatalError ? 'error' : 'empty');
            historyReadyByLatestBarKey.set(latestBarKey, true);
          }
          if (shouldEmitFatalError) {
            safeErrorCallback(getKlineErrorMessage(err) || 'Failed to load spot history');
            return;
          }
          spotTradingViewDebug('getBars request soft empty after transient error', {
            requestSeq,
            phase: requestKind,
            symbol: apiSymbol,
            symbolInfoName: _symbolInfo.name,
            interval,
            chartInterval,
            backendInterval: interval,
            resolution: requestResolution,
            periodParams: periodDebugPayload,
            apiLimit: limit,
            limit,
            requiredBars,
            end_time: endTime || null,
            end_time_ms: endTime || null,
            forceRest: true,
            requestKind,
            reason: getKlineErrorMessage(err) || 'Failed to load spot history',
          });
          safeHistoryCallback([], { noData: false }, 'transient kline request failed');
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
      activeRealtimeIntervalByUid.set(subscriberUid, interval);
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
          symbol: apiSymbol,
          msgSymbol,
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
        owner: realtimeOwner,
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
      clearRealtimeSubscriberState(subscriberUid);
    },

    getActiveRealtimeIntervals() {
      return Array.from(new Set(activeRealtimeIntervalByUid.values()));
    },

    syncRealtimeKlineSubscription(interval, reason = 'external realtime owner sync') {
      const normalizedInterval = normalizeSpotInterval(interval);
      const previousIntervals = Array.from(new Set(activeRealtimeIntervalByUid.values()));
      const droppedIntervals: string[] = [];

      for (const [subscriberUid, activeInterval] of Array.from(activeRealtimeIntervalByUid.entries())) {
        if (activeInterval === normalizedInterval) continue;

        const unsubscribe = unsubscribeByUid.get(subscriberUid);
        unsubscribe?.();
        unsubscribeByUid.delete(subscriberUid);
        clearRealtimeSubscriberState(subscriberUid);
        if (!droppedIntervals.includes(activeInterval)) {
          droppedIntervals.push(activeInterval);
        }
      }

      const activeIntervals = Array.from(new Set(activeRealtimeIntervalByUid.values()));
      if (activeIntervals.includes(normalizedInterval)) {
        spotMarketRealtime.syncKlineInterval({
          symbol: apiSymbol,
          interval: normalizedInterval,
          owner: realtimeOwner,
        });
      } else {
        spotMarketRealtime.releaseKlineIntervalOwner({
          symbol: apiSymbol,
          owner: realtimeOwner,
        });
      }

      markSpotKlinePerf('kline_interval_datafeed_owner_sync', {
        symbol: apiSymbol,
        interval: normalizedInterval,
        previousIntervals,
        activeIntervals,
        droppedIntervals,
        changed: droppedIntervals.length > 0,
        owner: realtimeOwner,
        source: 'spotTradingViewDatafeed',
        reason,
      });
      return {
        previousIntervals,
        activeIntervals,
        droppedIntervals,
        changed: droppedIntervals.length > 0,
      };
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
      activeRealtimeIntervalByUid.clear();
      activeSubscriptionKeyByUid.clear();
    },
  };
}
