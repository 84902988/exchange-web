'use client';

import {
  getContractMarketKlinesMetadata,
  type ContractMarketKlineItem,
  type ContractMarketKlineMetadataResponse,
} from '@/lib/api/modules/contract';
import {
  contractMarketRealtime,
  type ContractMarketRealtimeMessage,
} from '@/lib/realtime/contractMarketRealtime';
import { contractKlineCurrentCache } from './contractKlineCurrentCache';
import {
  getContractKlineCurrentCacheTtlMs,
  normalizeContractKlineAssetClass,
  type ContractKlineAssetClass,
} from './contractKlineCachePolicy';

export type ContractTradingViewResolution = '1' | '5' | '15' | '60' | '240' | '1D' | '1W' | '1M';

export type ContractTradingViewBar = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
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
  supported_resolutions: ContractTradingViewResolution[];
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

type ContractKlinePayload = ContractMarketKlineItem & {
  source?: unknown;
  quote_source?: unknown;
  kline_mode?: unknown;
  price_source?: unknown;
};

type TradingViewDatafeedConfiguration = {
  supports_search: boolean;
  supports_group_request: boolean;
  supports_marks: boolean;
  supports_timescale_marks: boolean;
  supports_time: boolean;
  exchanges: Array<{ value: string; name: string; desc: string }>;
  symbols_types: Array<{ name: string; value: string }>;
  supported_resolutions: ContractTradingViewResolution[];
};

type DatafeedCallbacks = {
  onReady: (configuration: TradingViewDatafeedConfiguration) => void;
  onSearchReady: (items: TradingViewSearchSymbolResult[]) => void;
  onSymbolResolved: (symbolInfo: TradingViewLibrarySymbolInfo) => void;
  onResolveError: (reason: string) => void;
  onHistory: (bars: ContractTradingViewBar[], meta: { noData?: boolean }) => void;
  onHistoryError: (reason: string) => void;
  onRealtime: (bar: ContractTradingViewBar) => void;
};

export type ContractTradingViewDatafeed = {
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
    resolution: string,
    periodParams: TradingViewPeriodParams,
    onHistory: DatafeedCallbacks['onHistory'],
    onError: DatafeedCallbacks['onHistoryError'],
  ) => void;
  subscribeBars: (
    symbolInfo: TradingViewLibrarySymbolInfo,
    resolution: string,
    onRealtime: DatafeedCallbacks['onRealtime'],
    subscriberUid: string,
  ) => void;
  unsubscribeBars: (subscriberUid: string) => void;
  destroy: () => void;
};

type CreateContractTradingViewDatafeedOptions = {
  symbol: string;
  category?: ContractKlineAssetClass | string | null;
  displaySymbol?: string | null;
  pricePrecision?: number | null;
  amountPrecision?: number | null;
  onLatestBar?: (close: string | null) => void;
  onHistoryBars?: (event: ContractHistoryBarsEvent) => void;
  onHistoryError?: (event: ContractHistoryErrorEvent) => void;
};

export type ContractHistoryBarsEvent = {
  symbol: string;
  interval: string;
  resolution: string;
  firstDataRequest: boolean;
  barCount: number;
  requestSeq: number;
};

export type ContractHistoryErrorEvent = Omit<ContractHistoryBarsEvent, 'barCount'> & {
  error: string;
};

type SubscriptionEntry = {
  latestBarKey: string;
  lastEmittedBarTime: number;
  unsubscribe: () => void;
};

const SUPPORTED_RESOLUTIONS: ContractTradingViewResolution[] = ['1', '5', '15', '60', '240', '1D', '1W', '1M'];
const RESOLUTION_TO_CONTRACT_INTERVAL: Record<ContractTradingViewResolution, string> = {
  '1': '1m',
  '5': '5m',
  '15': '15m',
  '60': '1h',
  '240': '4h',
  '1D': '1d',
  '1W': '1w',
  '1M': '1M',
};
const CONTRACT_INTERVAL_TO_RESOLUTION: Record<string, ContractTradingViewResolution> = {
  '1m': '1',
  '5m': '5',
  '15m': '15',
  '1h': '60',
  '4h': '240',
  '1d': '1D',
  '1w': '1W',
  '1M': '1M',
};
const DATAFEED_CONFIGURATION: TradingViewDatafeedConfiguration = {
  supports_search: true,
  supports_group_request: false,
  supports_marks: false,
  supports_timescale_marks: false,
  supports_time: true,
  exchanges: [{ value: 'CONTRACT', name: 'Contract', desc: 'Contract market' }],
  symbols_types: [{ name: 'Futures', value: 'futures' }],
  supported_resolutions: SUPPORTED_RESOLUTIONS,
};
const NON_PROVIDER_KLINE_SOURCE_TOKENS = new Set([
  'BBO',
  'DEPTH',
  'DISPLAY_PRICE',
  'LIVE_MID',
  'QUOTE_DRIVEN',
  'SYNTHETIC_FROM_QUOTE',
  'TRADE_TICK',
]);

function normalizeContractSymbol(symbol: string) {
  return String(symbol || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
}

function normalizeContractInterval(interval: string) {
  const normalized = String(interval || '').trim();
  if (normalized === '1M') return '1M';
  return normalized.toLowerCase();
}

type ContractKlineInFlightRequest = {
  symbol: string;
  interval: string;
  limit: number;
  endTimeMs?: number | null;
};

const CONTRACT_KLINE_CURRENT_REQUEST_KEY = 'CURRENT';
export const CONTRACT_KLINE_MAX_HISTORY_PAGES = 3;
export const CONTRACT_KLINE_MAX_ACCUMULATED_BARS = 1000;
export const CONTRACT_KLINE_HISTORY_PAGE_LIMIT = 300;
const contractKlineMetadataInFlight = new Map<
  string,
  Promise<ContractMarketKlineMetadataResponse>
>();

export function buildContractKlineInFlightKey(params: ContractKlineInFlightRequest) {
  const requestSymbol = normalizeContractSymbol(params.symbol);
  const requestInterval = normalizeContractInterval(params.interval);
  const requestEndTime = params.endTimeMs === undefined || params.endTimeMs === null
    ? CONTRACT_KLINE_CURRENT_REQUEST_KEY
    : String(params.endTimeMs);
  return `${requestSymbol}|${requestInterval}|${requestEndTime}|${params.limit}`;
}

function getContractMarketKlinesMetadataInFlight(
  params: Omit<ContractKlineInFlightRequest, 'endTimeMs'> & { endTimeMs?: number },
) {
  const key = buildContractKlineInFlightKey(params);
  const existing = contractKlineMetadataInFlight.get(key);
  if (existing) return existing;

  let request: Promise<ContractMarketKlineMetadataResponse>;
  try {
    request = getContractMarketKlinesMetadata(params);
  } catch (error) {
    request = Promise.reject(error);
  }
  contractKlineMetadataInFlight.set(key, request);

  const cleanup = () => {
    if (contractKlineMetadataInFlight.get(key) === request) {
      contractKlineMetadataInFlight.delete(key);
    }
  };
  void request.then(cleanup, cleanup);
  return request;
}

async function getContractMarketKlinesMetadataCurrentCacheFirst(
  params: Omit<ContractKlineInFlightRequest, 'endTimeMs'>,
  category: ContractKlineAssetClass,
) {
  const cacheParams = { ...params, category };
  const cached = contractKlineCurrentCache.get(cacheParams);
  if (cached) return cached;
  const result = await getContractMarketKlinesMetadataInFlight({
    ...params,
    endTimeMs: undefined,
  });
  contractKlineCurrentCache.set(
    cacheParams,
    result,
    getContractKlineCurrentCacheTtlMs({ category, interval: params.interval }),
  );
  return result;
}

function normalizeResolution(resolution: string): ContractTradingViewResolution {
  const normalized = String(resolution || '').trim().toUpperCase();
  if (normalized === 'D') return '1D';
  if (normalized === 'W') return '1W';
  if (normalized === 'M') return '1M';
  if (SUPPORTED_RESOLUTIONS.includes(normalized as ContractTradingViewResolution)) {
    return normalized as ContractTradingViewResolution;
  }
  return '1';
}

export function contractIntervalToTradingViewResolution(interval: string): ContractTradingViewResolution {
  return CONTRACT_INTERVAL_TO_RESOLUTION[normalizeContractInterval(interval)] || '1';
}

function tradingViewResolutionToContractInterval(resolution: string) {
  return RESOLUTION_TO_CONTRACT_INTERVAL[normalizeResolution(resolution)] || '1m';
}

function getPriceScale(precision?: number | null) {
  const nextPrecision = Number(precision);
  if (!Number.isInteger(nextPrecision) || nextPrecision < 0 || nextPrecision > 12) {
    return 100;
  }
  return Math.max(1, 10 ** nextPrecision);
}

function clampKlineLimit(value: unknown) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 300;
  return Math.min(1000, Math.max(50, Math.ceil(numeric)));
}

function normalizeTimeMs(value: unknown) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return numeric < 1_000_000_000_000 ? Math.floor(numeric * 1000) : Math.floor(numeric);
}

function normalizeNumber(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function isProviderKlinePayload(value: unknown) {
  const record = toRecord(value);
  if (!record) return false;

  return ['kline_mode', 'price_source', 'source', 'quote_source'].every((key) => {
    const rawValue = record[key];
    if (rawValue === undefined || rawValue === null || rawValue === '') return true;
    const normalized = String(rawValue).trim().toUpperCase();
    return !NON_PROVIDER_KLINE_SOURCE_TOKENS.has(normalized) && !normalized.includes('QUOTE');
  });
}

export function klineToBar(item: ContractKlinePayload): ContractTradingViewBar | null {
  if (!isProviderKlinePayload(item)) return null;

  const time = normalizeTimeMs(item.open_time ?? item.time ?? item.timestamp);
  const open = normalizeNumber(item.open);
  const high = normalizeNumber(item.high);
  const low = normalizeNumber(item.low);
  const close = normalizeNumber(item.close);
  const volume = normalizeNumber(item.volume) ?? 0;

  if (!time || open === null || high === null || low === null || close === null) return null;

  return { time, open, high, low, close, volume };
}

export function realtimeMessageToBar(
  message: ContractMarketRealtimeMessage,
  expectedSymbol: string,
  expectedInterval: string,
): ContractTradingViewBar | null {
  const type = String(message.type || '').toLowerCase();
  if (type !== 'contract_kline_update') return null;

  const payload = toRecord(message.kline) || toRecord(message.data);
  if (!payload) return null;
  if (!isProviderKlinePayload(message) || !isProviderKlinePayload(payload)) return null;

  const symbol = normalizeContractSymbol(String(message.symbol || payload.symbol || ''));
  if (symbol && symbol !== expectedSymbol) return null;

  const interval = normalizeContractInterval(String(message.interval || payload.interval || ''));
  if (interval && interval !== normalizeContractInterval(expectedInterval)) return null;

  return klineToBar({
    open_time: (payload.open_time ?? payload.time ?? payload.timestamp) as string | number | undefined,
    open: payload.open as string | number,
    high: payload.high as string | number,
    low: payload.low as string | number,
    close: payload.close as string | number,
    volume: (payload.volume ?? 0) as string | number,
    source: payload.source ?? message.source,
    quote_source: payload.quote_source ?? message.quote_source,
    kline_mode: payload.kline_mode ?? message.kline_mode,
    price_source: payload.price_source ?? message.price_source,
  });
}

export function resolveContractHistoryEndTimeMs(periodParams: TradingViewPeriodParams) {
  if (periodParams.firstDataRequest !== false) return undefined;
  const to = Number(periodParams.to);
  if (!Number.isFinite(to) || to <= 0) return undefined;
  return Math.floor(to * 1000);
}

export function shouldReportContractHistoryNoData(result: unknown) {
  const record = toRecord(result);
  return Boolean(
    record
    && Array.isArray(record.items)
    && record.items.length === 0
    && record.history_complete === true
    && record.has_more_before === false
    && record.history_incomplete === false
    && record.retryable === false
  );
}

function sortAndDedupeBars(bars: ContractTradingViewBar[]) {
  const byTime = new Map<number, ContractTradingViewBar>();
  bars.forEach((bar) => {
    if (Number.isFinite(bar.time) && bar.time > 0) {
      byTime.set(bar.time, bar);
    }
  });
  return Array.from(byTime.values()).sort((left, right) => left.time - right.time);
}

type LoadContractKlineBarsForCountBackOptions = {
  symbol: string;
  category: ContractKlineAssetClass;
  interval: string;
  initialLimit: number;
  initialEndTimeMs?: number;
  useCurrentCache: boolean;
  requiredBars: number;
  toTimeMs: number;
  isActive: () => boolean;
};

type LoadContractKlineBarsForCountBackResult = {
  bars: ContractTradingViewBar[];
  terminalMetadata: ContractMarketKlineMetadataResponse | null;
  pageCount: number;
};

async function loadContractKlineBarsForCountBack({
  symbol,
  category,
  interval,
  initialLimit,
  initialEndTimeMs,
  useCurrentCache,
  requiredBars,
  toTimeMs,
  isActive,
}: LoadContractKlineBarsForCountBackOptions): Promise<LoadContractKlineBarsForCountBackResult> {
  const barsByTime = new Map<number, ContractTradingViewBar>();
  let pageCount = 0;
  let pageEndTimeMs = initialEndTimeMs;
  let terminalMetadata: ContractMarketKlineMetadataResponse | null = null;

  while (
    pageCount < CONTRACT_KLINE_MAX_HISTORY_PAGES
    && barsByTime.size < requiredBars
    && barsByTime.size < CONTRACT_KLINE_MAX_ACCUMULATED_BARS
    && isActive()
  ) {
    const remainingBars = Math.min(
      requiredBars - barsByTime.size,
      CONTRACT_KLINE_MAX_ACCUMULATED_BARS - barsByTime.size,
    );
    const limit = pageCount === 0
      ? initialLimit
      : Math.min(remainingBars, CONTRACT_KLINE_HISTORY_PAGE_LIMIT);
    const isCurrentFirstPage = (
      useCurrentCache
      && pageCount === 0
      && pageEndTimeMs === undefined
    );
    pageCount += 1;

    let result: ContractMarketKlineMetadataResponse;
    try {
      result = isCurrentFirstPage
        ? await getContractMarketKlinesMetadataCurrentCacheFirst({
          symbol,
          interval,
          limit,
        }, category)
        : await getContractMarketKlinesMetadataInFlight({
          symbol,
          interval,
          limit,
          endTimeMs: pageEndTimeMs,
        });
    } catch (error) {
      if (pageCount === 1) throw error;
      break;
    }

    if (!isActive()) break;
    if (!result || !Array.isArray(result.items)) break;
    if (shouldReportContractHistoryNoData(result)) {
      terminalMetadata = result;
    }

    const pageBars = sortAndDedupeBars(
      result.items
        .map(klineToBar)
        .filter((bar): bar is ContractTradingViewBar => Boolean(bar))
        .filter((bar) => (
          bar.time < toTimeMs
          && (pageEndTimeMs === undefined || bar.time < pageEndTimeMs)
        )),
    );
    if (pageBars.length === 0) break;

    const newTimestampCount = pageBars.reduce(
      (count, bar) => count + (barsByTime.has(bar.time) ? 0 : 1),
      0,
    );
    const cappedBars = sortAndDedupeBars([
      ...barsByTime.values(),
      ...pageBars,
    ]).slice(-CONTRACT_KLINE_MAX_ACCUMULATED_BARS);
    barsByTime.clear();
    cappedBars.forEach((bar) => barsByTime.set(bar.time, bar));

    if (terminalMetadata || newTimestampCount === 0) break;
    if (
      barsByTime.size >= requiredBars
      || barsByTime.size >= CONTRACT_KLINE_MAX_ACCUMULATED_BARS
      || pageCount >= CONTRACT_KLINE_MAX_HISTORY_PAGES
    ) {
      break;
    }

    const earliestBarTime = Math.min(...barsByTime.keys());
    if (
      !Number.isFinite(earliestBarTime)
      || earliestBarTime <= 0
      || (pageEndTimeMs !== undefined && earliestBarTime >= pageEndTimeMs)
    ) {
      break;
    }
    pageEndTimeMs = earliestBarTime;
  }

  return {
    bars: sortAndDedupeBars(Array.from(barsByTime.values())).slice(-requiredBars),
    terminalMetadata,
    pageCount,
  };
}

function buildLatestBarKey(symbol: string, interval: string) {
  return `${normalizeContractSymbol(symbol)}:${normalizeContractInterval(interval)}`;
}

const CONTRACT_KLINE_HIGH_WATER_MARK_CAPACITY = 128;
const contractKlineHighWaterMarks = new Map<string, number>();

function getContractKlineHighWaterMark(key: string) {
  return contractKlineHighWaterMarks.get(key) || 0;
}

function advanceContractKlineHighWaterMark(key: string, time: number) {
  if (!Number.isFinite(time) || time <= 0) return getContractKlineHighWaterMark(key);
  const nextTime = Math.max(getContractKlineHighWaterMark(key), time);
  contractKlineHighWaterMarks.delete(key);
  contractKlineHighWaterMarks.set(key, nextTime);
  while (contractKlineHighWaterMarks.size > CONTRACT_KLINE_HIGH_WATER_MARK_CAPACITY) {
    const oldestKey = contractKlineHighWaterMarks.keys().next().value;
    if (!oldestKey) break;
    contractKlineHighWaterMarks.delete(oldestKey);
  }
  return nextTime;
}

type ContractKlineRequestToken = {
  sequence: number;
  key: string;
  settled: boolean;
  supersededSettlementScheduled: boolean;
  onSuperseded: () => void;
};

export class ContractKlineRequestGuard {
  private sequence = 0;
  private activeKey = '';
  private activeToken: ContractKlineRequestToken | null = null;
  private destroyed = false;

  private scheduleSupersededSettlement(token: ContractKlineRequestToken) {
    if (token.settled || token.supersededSettlementScheduled) return;
    token.supersededSettlementScheduled = true;
    queueMicrotask(() => {
      token.supersededSettlementScheduled = false;
      if (token.settled) return;
      token.settled = true;
      if (this.destroyed) return;
      token.onSuperseded();
    });
  }

  begin(symbol: string, interval: string, onSuperseded: () => void): ContractKlineRequestToken {
    if (this.activeToken) {
      this.scheduleSupersededSettlement(this.activeToken);
    }
    this.sequence += 1;
    this.activeKey = buildLatestBarKey(symbol, interval);
    const token = {
      sequence: this.sequence,
      key: this.activeKey,
      settled: false,
      supersededSettlementScheduled: false,
      onSuperseded,
    };
    this.activeToken = token;
    return token;
  }

  complete(token: ContractKlineRequestToken, callback: () => void) {
    if (this.destroyed || token.settled) {
      return false;
    }
    if (
      token !== this.activeToken
      || token.sequence !== this.sequence
      || token.key !== this.activeKey
    ) {
      this.scheduleSupersededSettlement(token);
      return false;
    }

    token.settled = true;
    this.activeToken = null;
    callback();
    return true;
  }

  isActive(token: ContractKlineRequestToken) {
    return Boolean(
      !this.destroyed
      && !token.settled
      && token === this.activeToken
      && token.sequence === this.sequence
      && token.key === this.activeKey
    );
  }

  destroy() {
    this.destroyed = true;
    this.sequence += 1;
    this.activeKey = '';
    this.activeToken = null;
  }
}

function buildSymbolInfo(params: {
  symbol: string;
  displaySymbol: string;
  pricePrecision?: number | null;
  amountPrecision?: number | null;
}): TradingViewLibrarySymbolInfo {
  return {
    name: params.displaySymbol || params.symbol,
    ticker: params.symbol,
    description: params.displaySymbol || params.symbol,
    type: 'futures',
    session: '24x7',
    timezone: 'Asia/Shanghai',
    exchange: 'CONTRACT',
    listed_exchange: 'CONTRACT',
    minmov: 1,
    pricescale: getPriceScale(params.pricePrecision),
    has_intraday: true,
    has_daily: true,
    has_weekly_and_monthly: true,
    supported_resolutions: SUPPORTED_RESOLUTIONS,
    intraday_multipliers: ['1', '5', '15', '60', '240'],
    daily_multipliers: ['1'],
    weekly_multipliers: ['1'],
    monthly_multipliers: ['1'],
    volume_precision: params.amountPrecision ?? 4,
    data_status: 'streaming',
    format: 'price',
  };
}

export function createContractTradingViewDatafeed({
  symbol,
  category,
  displaySymbol,
  pricePrecision,
  amountPrecision,
  onLatestBar,
  onHistoryBars,
}: CreateContractTradingViewDatafeedOptions): ContractTradingViewDatafeed {
  const apiSymbol = normalizeContractSymbol(symbol);
  const assetClass = normalizeContractKlineAssetClass(category);
  const displayName = displaySymbol || apiSymbol;
  const latestBars = new Map<string, ContractTradingViewBar>();
  const subscriptions = new Map<string, SubscriptionEntry>();
  const requestGuard = new ContractKlineRequestGuard();

  const notifyLatestBar = (bar: ContractTradingViewBar | null) => {
    onLatestBar?.(bar ? String(bar.close) : null);
  };

  const notifyHistoryBars = (event: ContractHistoryBarsEvent) => {
    try {
      onHistoryBars?.(event);
    } catch {
      // Observability callbacks must not change TradingView callback semantics.
    }
  };

  return {
    onReady(callback) {
      window.setTimeout(() => callback(DATAFEED_CONFIGURATION), 0);
    },

    searchSymbols(userInput, _exchange, _symbolType, callback) {
      const query = String(userInput || '').trim().toUpperCase();
      if (!query || apiSymbol.includes(query) || displayName.toUpperCase().includes(query)) {
        callback([{
          symbol: apiSymbol,
          full_name: apiSymbol,
          description: displayName,
          exchange: 'CONTRACT',
          ticker: apiSymbol,
          type: 'futures',
        }]);
        return;
      }
      callback([]);
    },

    resolveSymbol(_symbolName, onResolve, onError) {
      if (!apiSymbol) {
        window.setTimeout(() => onError('Invalid contract symbol'), 0);
        return;
      }

      window.setTimeout(() => {
        onResolve(buildSymbolInfo({
          symbol: apiSymbol,
          displaySymbol: displayName,
          pricePrecision,
          amountPrecision,
        }));
      }, 0);
    },

    async getBars(symbolInfo, resolution, periodParams, onHistory) {
      const requestSymbol = normalizeContractSymbol(symbolInfo.ticker || apiSymbol) || apiSymbol;
      const requestResolution = normalizeResolution(resolution);
      const interval = tradingViewResolutionToContractInterval(resolution);
      const requestToken = requestGuard.begin(requestSymbol, interval, () => {
        onHistory([], { noData: false });
      });
      const latestBarKey = buildLatestBarKey(requestSymbol, interval);
      const requiredBars = Math.min(
        clampKlineLimit(periodParams.countBack),
        CONTRACT_KLINE_MAX_ACCUMULATED_BARS,
      );
      const limit = requiredBars;
      const endTimeMs = resolveContractHistoryEndTimeMs(periodParams);
      const to = Number(periodParams.to);
      const toTimeMs = Number.isFinite(to) && to > 0
        ? Math.floor(to * 1000)
        : Number.MAX_SAFE_INTEGER;

      try {
        const result = await loadContractKlineBarsForCountBack({
          symbol: requestSymbol,
          category: assetClass,
          interval,
          initialLimit: limit,
          initialEndTimeMs: endTimeMs,
          useCurrentCache: periodParams.firstDataRequest !== false && endTimeMs === undefined,
          requiredBars,
          toTimeMs,
          isActive: () => requestGuard.isActive(requestToken),
        });
        const bars = result.bars;

        requestGuard.complete(requestToken, () => {
          const latestBar = bars[bars.length - 1] || null;
          if (periodParams.firstDataRequest !== false) {
            const highWaterMark = getContractKlineHighWaterMark(latestBarKey);
            if (latestBar && latestBar.time >= highWaterMark) {
              advanceContractKlineHighWaterMark(latestBarKey, latestBar.time);
              latestBars.set(latestBarKey, latestBar);
              notifyLatestBar(latestBar);
            } else if (!latestBar && highWaterMark === 0) {
              notifyLatestBar(null);
            }
          }
          notifyHistoryBars({
            symbol: requestSymbol,
            interval,
            resolution: requestResolution,
            firstDataRequest: periodParams.firstDataRequest === true,
            barCount: bars.length,
            requestSeq: requestToken.sequence,
          });
          onHistory(bars, {
            noData: Boolean(
              bars.length === 0
              && result.terminalMetadata
              && shouldReportContractHistoryNoData(result.terminalMetadata)
            ),
          });
        });
      } catch {
        requestGuard.complete(requestToken, () => {
          notifyHistoryBars({
            symbol: requestSymbol,
            interval,
            resolution: requestResolution,
            firstDataRequest: periodParams.firstDataRequest === true,
            barCount: 0,
            requestSeq: requestToken.sequence,
          });
          onHistory([], { noData: false });
        });
      }
    },

    subscribeBars(symbolInfo, resolution, onRealtime, subscriberUid) {
      const subscriptionSymbol = normalizeContractSymbol(symbolInfo.ticker || apiSymbol) || apiSymbol;
      const interval = tradingViewResolutionToContractInterval(resolution);
      const latestBarKey = buildLatestBarKey(subscriptionSymbol, interval);
      const subscription: SubscriptionEntry = {
        latestBarKey,
        lastEmittedBarTime: 0,
        unsubscribe: () => undefined,
      };

      const unsubscribe = contractMarketRealtime.subscribe('kline', (message) => {
        const nextBar = realtimeMessageToBar(message, subscriptionSymbol, interval);
        if (!nextBar) return;

        const previousBar = latestBars.get(latestBarKey);
        const effectiveHighWaterMark = Math.max(
          getContractKlineHighWaterMark(latestBarKey),
          previousBar?.time || 0,
          subscription.lastEmittedBarTime,
        );
        if (nextBar.time < effectiveHighWaterMark) return;

        advanceContractKlineHighWaterMark(latestBarKey, nextBar.time);
        subscription.lastEmittedBarTime = Math.max(subscription.lastEmittedBarTime, nextBar.time);
        latestBars.set(latestBarKey, nextBar);
        notifyLatestBar(nextBar);
        onRealtime(nextBar);
      });

      subscription.unsubscribe = unsubscribe;
      subscriptions.set(subscriberUid, subscription);
    },

    unsubscribeBars(subscriberUid) {
      const entry = subscriptions.get(subscriberUid);
      if (!entry) return;
      entry.unsubscribe();
      subscriptions.delete(subscriberUid);
    },

    destroy() {
      requestGuard.destroy();
      subscriptions.forEach((entry) => entry.unsubscribe());
      subscriptions.clear();
      latestBars.clear();
    },
  };
}
