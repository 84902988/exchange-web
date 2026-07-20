'use client';

import {
  getContractMarketKlinesMetadata,
  type ContractMarketKlineItem,
  type ContractMarketKlineMetadataResponse,
} from '@/lib/api/modules/contract';
import {
  contractMarketRealtime,
  type ContractKlineResolutionIdentity,
  type ContractMarketRealtimeMessage,
} from '@/lib/realtime/contractMarketRealtime';
import {
  contractMarketStore,
  selectContractMarketKlineEntry,
  subscribeContractMarketKlineEntry,
  type ContractMarketStoreEntry,
} from '@/lib/realtime/contractMarketStore';
import { contractKlineCurrentCache } from './contractKlineCurrentCache';
import {
  ContractTradingViewPreviewCompositor,
  type ContractPreviewInput,
  type ContractPreviewNativeInput,
} from './contractTradingViewPreviewCompositor';
import {
  ContractTradingViewRealtimeBarFrameCoalescer,
  type ContractTradingViewRealtimeBarAuthority,
  type ContractTradingViewRealtimeBarFrameSource,
} from './contractTradingViewRealtimeBarFrameCoalescer';
import {
  getContractKlineCurrentCacheTtlMs,
  normalizeContractKlineAssetClass,
  type ContractKlineAssetClass,
} from './contractKlineCachePolicy';
import {
  buildContractKlineRangeKey,
  CONTRACT_KLINE_HISTORY_CHAIN_PAGE_LIMIT,
  getContractKlineLoadPolicy,
  resolveContractKlineRequestPlan,
} from './contractKlineLoadPolicy';
import {
  ContractKlineLeaseTimeoutError,
  contractKlineRequestLeaseRegistry,
} from './contractKlinePreloadManager';
import type { KlineLifecycleRearmPermit } from '@/components/tradingview/klineLifecycleRuntimeCoordinator';

export type ContractTradingViewResolution = '1' | '5' | '15' | '30' | '60' | '240' | '1D' | '1W' | '1M';

const CONTRACT_CANDLE_PREVIEW_PROVIDERS = new Set(['OKX_SWAP', 'ITICK']);

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
    onResetCacheNeededCallback?: () => void,
  ) => void;
  unsubscribeBars: (subscriberUid: string) => void;
  getRealtimeSubscriptionReadiness: (
    symbol: string,
    interval: string,
  ) => ContractRealtimeSubscriptionReadiness | null;
  getDatafeedInstanceId: () => number;
  beginResolutionTransition: (
    transition: ContractResolutionTransitionInput,
  ) => ContractActiveResolutionIdentity | null;
  commitResolutionTransition: (transitionGeneration: number) => boolean;
  rollbackResolutionTransition: (transitionGeneration: number) => boolean;
  executeResetPermit: (
    requirement: ContractRealtimeResetRequirement,
    permit: KlineLifecycleRearmPermit,
  ) => boolean;
  destroy: () => void;
};

export type ContractRealtimeSubscriptionReadiness = Readonly<{
  datafeedInstanceId: number;
  symbol: string;
  interval: string;
  subscriberUid: string;
  ownerId: string;
  subscriptionGeneration: number;
  transitionGeneration: number;
  generation: number;
}>;

export type ContractResolutionTransitionInput = Readonly<{
  symbol: string;
  interval: string;
  transitionGeneration: number;
}>;

export type ContractActiveResolutionIdentity = ContractRealtimeSubscriptionReadiness;

export type ContractRealtimeResetRequirement = ContractRealtimeSubscriptionReadiness & Readonly<{
  source: 'RESTORED_BASELINE';
}>;

type CreateContractTradingViewDatafeedOptions = {
  symbol: string;
  category?: ContractKlineAssetClass | string | null;
  displaySymbol?: string | null;
  pricePrecision?: number | null;
  amountPrecision?: number | null;
  onLatestBar?: (close: string | null) => void;
  onHistoryBars?: (event: ContractHistoryBarsEvent) => void;
  onHistoryError?: (event: ContractHistoryErrorEvent) => void;
  onRealtimeSubscriptionReady?: (evidence: ContractRealtimeSubscriptionReadiness) => void;
  onRealtimeResetRequired?: (requirement: ContractRealtimeResetRequirement) => void;
};

export type ContractHistoryBarsEvent = {
  symbol: string;
  interval: string;
  resolution: string;
  firstDataRequest: boolean;
  barCount: number;
  firstBarTime: number | null;
  lastBarTime: number | null;
  requestSeq: number;
};

export type ContractHistoryErrorEvent = Omit<ContractHistoryBarsEvent, 'barCount'> & {
  error: string;
};

type SubscriptionEntry = {
  subscriberUid: string;
  symbol: string;
  interval: string;
  ownerId: string;
  generation: number;
  leaseGeneration: number;
  transitionGeneration: number;
  latestBarKey: string;
  lastEmittedBarTime: number;
  lastEmittedBarFingerprint: string;
  lastStoreBarTime: number;
  legacyVersionCursor: KlineVersionCursor | null;
  readinessBlocked: boolean;
  executedResetPermitId: string | null;
  releaseKlineSubscription: () => void;
  replayReadyStore: () => void;
  callback: DatafeedCallbacks['onRealtime'];
  resetCallback: (() => void) | null;
};

type ResetUnsubscribeGuard = {
  subscriberUid: string;
  symbol: string;
  interval: string;
  ownerId: string;
  generation: number;
  transitionGeneration: number;
  latestBarKey: string;
};

type ResolutionTransitionRecord = Readonly<{
  candidate: ContractActiveResolutionIdentity;
  rollbackTarget: ContractActiveResolutionIdentity | null;
  explicit: boolean;
}>;

const SUPPORTED_RESOLUTIONS: ContractTradingViewResolution[] = ['1', '5', '15', '30', '60', '240', '1D', '1W', '1M'];
const RESOLUTION_TO_CONTRACT_INTERVAL: Record<ContractTradingViewResolution, string> = {
  '1': '1m',
  '5': '5m',
  '15': '15m',
  '30': '30m',
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
  '30m': '30',
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

export const CONTRACT_KLINE_MAX_HISTORY_PAGES = 3;
export const CONTRACT_KLINE_MAX_ACCUMULATED_BARS = 1000;
export const CONTRACT_KLINE_HISTORY_PAGE_LIMIT = CONTRACT_KLINE_HISTORY_CHAIN_PAGE_LIMIT;

export function buildContractKlineInFlightKey(params: ContractKlineInFlightRequest) {
  return buildContractKlineRangeKey(params);
}

function getContractMarketKlinesMetadataInFlight(
  params: Omit<ContractKlineInFlightRequest, 'endTimeMs'> & { endTimeMs?: number },
  deadlineAt?: number,
  ownerId?: string,
) {
  const key = buildContractKlineInFlightKey(params);
  const policy = getContractKlineLoadPolicy(params.interval);
  return contractKlineRequestLeaseRegistry.request({
    key,
    coverage: params.limit,
    role: 'active',
    ownerId,
    deadlineMs: policy.requestDeadlineMs,
    deadlineAt,
    request: (coverage, lease) => getContractMarketKlinesMetadata({
      ...params,
      limit: coverage,
    }, { signal: lease.signal }),
  });
}

async function getContractMarketKlinesMetadataCurrentCacheFirst(
  params: Omit<ContractKlineInFlightRequest, 'endTimeMs'>,
  category: ContractKlineAssetClass,
  deadlineAt?: number,
  ownerId?: string,
) {
  const cacheParams = { ...params, category };
  const cached = contractKlineCurrentCache.getAtLeast(cacheParams);
  if (cached) return cached;
  const result = await getContractMarketKlinesMetadataInFlight({
    ...params,
    endTimeMs: undefined,
  }, deadlineAt, ownerId);
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

export function tradingViewResolutionToContractInterval(resolution: string) {
  return RESOLUTION_TO_CONTRACT_INTERVAL[normalizeResolution(resolution)] || '1m';
}

function isContractDwmInterval(interval?: string) {
  const normalized = normalizeContractInterval(String(interval || ''));
  return normalized === '1d' || normalized === '1w' || normalized === '1M';
}

export function isContractDwmUtcBoundary(time: number, interval?: string) {
  const normalizedInterval = normalizeContractInterval(String(interval || ''));
  if (!isContractDwmInterval(normalizedInterval)) return true;
  if (!Number.isFinite(time) || time <= 0) return false;
  const instant = new Date(time);
  const atUtcMidnight = (
    instant.getUTCHours() === 0
    && instant.getUTCMinutes() === 0
    && instant.getUTCSeconds() === 0
    && instant.getUTCMilliseconds() === 0
  );
  if (!atUtcMidnight) return false;
  if (normalizedInterval === '1w') return instant.getUTCDay() === 1;
  if (normalizedInterval === '1M') return instant.getUTCDate() === 1;
  return normalizedInterval === '1d';
}

function getPriceScale(precision?: number | null) {
  const nextPrecision = Number(precision);
  if (!Number.isInteger(nextPrecision) || nextPrecision < 0 || nextPrecision > 12) {
    return 100;
  }
  return Math.max(1, 10 ** nextPrecision);
}

function normalizeTimeMs(value: unknown) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return numeric < 1_000_000_000_000 ? Math.floor(numeric * 1000) : Math.floor(numeric);
}

function normalizeNumber(value: unknown) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function positiveInteger(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

function nonNegativeInteger(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric >= 0 ? numeric : null;
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

export function klineToBar(
  item: ContractKlinePayload,
  interval?: string,
): ContractTradingViewBar | null {
  if (!isProviderKlinePayload(item)) return null;

  const time = normalizeTimeMs(item.open_time ?? item.time ?? item.timestamp);
  const open = normalizeNumber(item.open);
  const high = normalizeNumber(item.high);
  const low = normalizeNumber(item.low);
  const close = normalizeNumber(item.close);
  const volume = normalizeNumber(item.volume);

  if (
    !time
    || open === null
    || high === null
    || low === null
    || close === null
    || volume === null
    || volume < 0
    || !isContractDwmUtcBoundary(time, interval)
  ) return null;

  return { time, open, high, low, close, volume };
}

export function realtimeMessageToBar(
  message: ContractMarketRealtimeMessage,
  expectedSymbol: string,
  expectedInterval: string,
): ContractTradingViewBar | null {
  const type = String(message.type || '').toLowerCase();
  if (type !== 'contract_kline_update') return null;
  if (message.domain && String(message.domain).trim().toLowerCase() !== 'kline') return null;

  const payload = toRecord(message.kline) || toRecord(message.data);
  if (!payload) return null;
  if (!isProviderKlinePayload(message) || !isProviderKlinePayload(payload)) return null;
  if (!isFreshKlineEvidence(message) || !isFreshKlineEvidence(payload)) return null;

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
    volume: payload.volume as string | number,
    source: payload.source ?? message.source,
    quote_source: payload.quote_source ?? message.quote_source,
    kline_mode: payload.kline_mode ?? message.kline_mode,
    price_source: payload.price_source ?? message.price_source,
  }, expectedInterval);
}

export function realtimePreviewMessageToInput(
  message: ContractMarketRealtimeMessage,
  expectedSymbol: string,
  expectedInterval: string,
): ContractPreviewInput | null {
  if (String(message.type || '').toLowerCase() !== 'contract_candle_preview_update') {
    return null;
  }
  if (message.domain && String(message.domain).trim().toLowerCase() !== 'kline') return null;
  const payload = toRecord(message.preview) || toRecord(message.data);
  const baseRevision = toRecord(message.base_native_revision);
  if (!payload || !baseRevision) return null;
  const symbol = normalizeContractSymbol(String(message.symbol || payload.symbol || ''));
  const interval = normalizeContractInterval(String(message.interval || payload.interval || ''));
  if (symbol !== normalizeContractSymbol(expectedSymbol)) return null;
  if (interval !== normalizeContractInterval(expectedInterval)) return null;
  if (!CONTRACT_CANDLE_PREVIEW_PROVIDERS.has(
    String(message.provider || payload.provider || '').trim().toUpperCase(),
  )) {
    return null;
  }
  if (String(message.source || payload.source || '').trim().toUpperCase() !== 'TRADE_PREVIEW') {
    return null;
  }
  if (String(payload.freshness || message.freshness || '').trim().toUpperCase() !== 'LIVE') {
    return null;
  }
  const openTime = normalizeTimeMs(payload.open_time ?? payload.open_time_ms ?? payload.time);
  const generation = positiveInteger(
    payload.provider_generation ?? message.provider_generation,
  );
  const receivedAtMs = positiveInteger(
    payload.received_at_ms ?? message.received_at_ms,
  );
  const previewSequence = positiveInteger(
    payload.preview_sequence ?? message.preview_sequence,
  );
  const epoch = nonNegativeInteger(payload.revision_epoch ?? baseRevision.epoch);
  const sequence = nonNegativeInteger(
    payload.revision_sequence ?? payload.revision_seq ?? baseRevision.sequence,
  );
  const open = normalizeNumber(payload.open);
  const high = normalizeNumber(payload.high);
  const low = normalizeNumber(payload.low);
  const close = normalizeNumber(payload.close);
  const volume = normalizeNumber(payload.volume);
  if (
    !openTime
    || generation === null
    || receivedAtMs === null
    || previewSequence === null
    || epoch === null
    || sequence === null
    || open === null
    || high === null
    || low === null
    || close === null
    || volume === null
    || volume < 0
    || high < Math.max(open, low, close)
    || low > Math.min(open, high, close)
  ) return null;
  return {
    symbol,
    interval,
    openTime,
    generation,
    receivedAtMs,
    previewSequence,
    baseNativeRevision: { epoch, sequence },
    bar: { time: openTime, open, high, low, close, volume },
  };
}

function isFreshKlineEvidence(value: unknown) {
  const record = toRecord(value);
  if (!record) return true;
  if (record.stale === true) return false;
  const freshness = String(record.freshness || '').trim().toUpperCase();
  return !['STALE', 'LAST_GOOD', 'MISSING', 'UNAVAILABLE', 'INVALID'].includes(freshness);
}

function readStoreKlinePayload(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) {
    for (let index = value.length - 1; index >= 0; index -= 1) {
      const item = toRecord(value[index]);
      if (item) return item;
    }
    return null;
  }
  const record = toRecord(value);
  if (!record) return null;
  if (
    record.open !== undefined
    && record.high !== undefined
    && record.low !== undefined
    && record.close !== undefined
  ) return record;
  for (const key of ['kline', 'candle', 'kline_current_candle', 'data']) {
    const nested = toRecord(record[key]);
    if (nested) return nested;
  }
  for (const key of ['items', 'klines', 'rows']) {
    const items = record[key];
    if (!Array.isArray(items)) continue;
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = toRecord(items[index]);
      if (item) return item;
    }
  }
  return null;
}

export function storeKlineEntryToBar(
  entry: ContractMarketStoreEntry | null,
  expectedSymbol: string,
  expectedInterval: string,
): ContractTradingViewBar | null {
  if (!entry || entry.domain !== 'kline' || entry.stale) return null;
  const symbol = normalizeContractSymbol(entry.symbol);
  const interval = normalizeContractInterval(entry.interval || '');
  if (symbol !== normalizeContractSymbol(expectedSymbol)) return null;
  if (interval !== normalizeContractInterval(expectedInterval)) return null;
  const payload = readStoreKlinePayload(entry.data);
  if (!payload || payload.stale === true) return null;
  const payloadSymbol = normalizeContractSymbol(String(payload.symbol || ''));
  if (payloadSymbol && payloadSymbol !== symbol) return null;
  const payloadInterval = normalizeContractInterval(String(payload.interval || ''));
  if (payloadInterval && payloadInterval !== interval) return null;

  return klineToBar({
    open_time: (payload.open_time ?? payload.time ?? payload.timestamp) as string | number | undefined,
    open: payload.open as string | number,
    high: payload.high as string | number,
    low: payload.low as string | number,
    close: payload.close as string | number,
    volume: payload.volume as string | number,
    source: payload.source ?? entry.source,
    quote_source: payload.quote_source,
    kline_mode: payload.kline_mode,
    price_source: payload.price_source,
  }, expectedInterval);
}

function realtimeBarFingerprint(bar: ContractTradingViewBar) {
  return [bar.time, bar.open, bar.high, bar.low, bar.close, String(bar.volume)].join('|');
}

export type KlineVersionCursor = {
  bucketTimeMs: number | null;
  providerGeneration: number | null;
  revisionEpoch: number | null;
  revisionSequence: number | null;
  observedAtMs: number;
};

function readVersionNumber(records: Array<Record<string, unknown> | null>, ...keys: string[]) {
  for (const record of records) {
    if (!record) continue;
    for (const key of keys) {
      const value = record[key];
      if (value === null || value === undefined || value === '') continue;
      const numeric = Number(value);
      if (Number.isFinite(numeric) && numeric >= 0) return numeric;
    }
  }
  return null;
}

function realtimeMessageVersion(
  message: ContractMarketRealtimeMessage,
  bar: ContractTradingViewBar,
): KlineVersionCursor {
  const messageRecord = message as Record<string, unknown>;
  const payload = toRecord(message.kline) || toRecord(message.data);
  const revision = toRecord(payload?.revision) || toRecord(messageRecord.revision);
  const records = [payload, messageRecord];
  return {
    bucketTimeMs: normalizeTimeMs(bar.time) || null,
    providerGeneration: readVersionNumber(
      records,
      'provider_generation',
      'providerGeneration',
      'generation',
    ),
    revisionEpoch: readVersionNumber(
      [revision, ...records],
      'epoch',
      'revision_epoch',
    ),
    revisionSequence: readVersionNumber(
      [revision, ...records],
      'sequence',
      'revision_sequence',
      'revision_seq',
    ),
    observedAtMs: readVersionNumber(
      records,
      'provider_event_time_ms',
      'event_time_ms',
      'updated_at_ms',
      'received_at_ms',
    ) ?? bar.time,
  };
}

function storeEntryVersion(entry: ContractMarketStoreEntry): KlineVersionCursor {
  const payload = readStoreKlinePayload(entry.data);
  return {
    bucketTimeMs: normalizeTimeMs(
      payload?.open_time ?? payload?.time ?? payload?.timestamp,
    ) || null,
    providerGeneration: entry.providerGeneration,
    revisionEpoch: entry.revision?.epoch ?? null,
    revisionSequence: entry.revision?.sequence ?? null,
    observedAtMs: entry.observedAtMs,
  };
}

export function acceptsKlineVersion(
  current: KlineVersionCursor | null,
  incoming: KlineVersionCursor,
): boolean {
  if (!current) return true;
  let generationAdvanced = false;
  if (current.providerGeneration !== null) {
    if (incoming.providerGeneration === null) return false;
    if (incoming.providerGeneration < current.providerGeneration) return false;
    generationAdvanced = incoming.providerGeneration > current.providerGeneration;
  } else if (incoming.providerGeneration !== null) {
    generationAdvanced = true;
  }

  if (
    current.bucketTimeMs !== null
    && incoming.bucketTimeMs !== null
  ) {
    if (incoming.bucketTimeMs < current.bucketTimeMs) return false;
    if (incoming.bucketTimeMs > current.bucketTimeMs) return true;
  }

  // A missing bucket identity cannot prove a candle rollover. Keep the legacy
  // generation/revision ordering instead of substituting an arrival timestamp.
  if (generationAdvanced) return true;

  let revisionAdvanced = false;
  if (current.revisionEpoch !== null) {
    if (incoming.revisionEpoch === null) return false;
    if (incoming.revisionEpoch < current.revisionEpoch) return false;
    revisionAdvanced = incoming.revisionEpoch > current.revisionEpoch;
  }
  if (!revisionAdvanced && current.revisionSequence !== null) {
    if (incoming.revisionSequence === null) return false;
    if (incoming.revisionSequence < current.revisionSequence) return false;
    revisionAdvanced = incoming.revisionSequence > current.revisionSequence;
  }
  return revisionAdvanced || incoming.observedAtMs >= current.observedAtMs;
}

export function resolveContractHistoryEndTimeMs(periodParams: TradingViewPeriodParams) {
  if (periodParams.firstDataRequest !== false) return undefined;
  const to = Number(periodParams.to);
  if (!Number.isFinite(to) || to <= 0) return undefined;
  return Math.floor(to * 1000);
}

function isContractHistoryMetaTrue(value: unknown) {
  return value === true || value === 1 || String(value ?? '').trim().toLowerCase() === 'true';
}

export function hasExplicitContractHistoryTerminalEvidence(result: unknown) {
  const record = toRecord(result);
  if (!record || !Array.isArray(record.items)) return false;
  const explicitTerminal = (
    isContractHistoryMetaTrue(record.history_terminal)
    || (record.history_complete === true && record.has_more_before === false)
  );
  if (!explicitTerminal) return false;
  if (record.stale !== false || record.history_incomplete !== false || record.retryable !== false) {
    return false;
  }
  if (
    record.provider_error_code !== null
    && record.provider_error_code !== undefined
    && String(record.provider_error_code).trim() !== ''
  ) return false;
  const cacheStatus = String(record.cache_status || '').trim().toUpperCase();
  return ![
    'PROVIDER_EMPTY',
    'TIMEOUT',
    'ERROR',
    'STALE',
    'SHORT',
    'CONTINUITY_INVALID',
    'COVERAGE_INVALID',
  ].includes(cacheStatus);
}

export function shouldReportContractHistoryNoData(result: unknown) {
  const record = toRecord(result);
  return Boolean(
    record
    && Array.isArray(record.items)
    && record.items.length === 0
    && hasExplicitContractHistoryTerminalEvidence(record)
  );
}

function getContractHistoryTerminalBoundaryMs(
  result: ContractMarketKlineMetadataResponse | null,
) {
  const record = toRecord(result);
  return normalizeTimeMs(record?.earliest_available_time);
}

function getContractHistoryTerminalReason(
  result: ContractMarketKlineMetadataResponse | null,
) {
  const record = toRecord(result);
  const reason = String(record?.terminal_reason || '').trim();
  if (reason) return reason;
  return hasExplicitContractHistoryTerminalEvidence(result) ? 'HISTORY_TERMINAL' : null;
}

function getContractHistoryErrorReason(
  result: ContractMarketKlineMetadataResponse | null,
  fallback = 'Kline history returned no terminal evidence',
) {
  const record = toRecord(result);
  const providerErrorCode = String(record?.provider_error_code || '').trim();
  return providerErrorCode ? `Kline history unavailable: ${providerErrorCode}` : fallback;
}

function isContractProviderEmptyHistory(
  result: ContractMarketKlineMetadataResponse | null,
) {
  const record = toRecord(result);
  return Boolean(
    record
    && Array.isArray(record.items)
    && record.items.length === 0
    && String(record.provider_error_code || '').trim().toUpperCase() === 'EMPTY'
  );
}

function shouldRetainContractHistoryCoverage(result: unknown) {
  const record = toRecord(result);
  return Boolean(
    record
    && Array.isArray(record.items)
    && record.stale === false
    && record.history_incomplete === false
    && record.provider_error_code === null
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
  initialBars?: ContractTradingViewBar[];
  useCurrentCache: boolean;
  requiredBars: number;
  pageLimit: number;
  toTimeMs: number;
  deadlineAt: number;
  ownerId: string;
  isActive: () => boolean;
};

type LoadContractKlineBarsForCountBackResult = {
  bars: ContractTradingViewBar[];
  lastMetadata: ContractMarketKlineMetadataResponse | null;
  terminalMetadata: ContractMarketKlineMetadataResponse | null;
  pageCount: number;
  coverageReusable: boolean;
  coverageComplete: boolean;
  nextEndTimeMs: number | null;
  terminalComplete: boolean;
  terminalBoundary: number | null;
  terminalReason: string | null;
};

export type HistoryCoverageState = {
  symbol: string;
  interval: string;
  generation: string;
  currentCacheLimit: number | null;
  requestedBars: number;
  returnedBars: ContractTradingViewBar[];
  coverageComplete: boolean;
  nextEndTimeMs: number | null;
  terminalComplete: boolean;
  terminalBoundary: number | null;
  terminalReason: string | null;
};

type MonthlyHistoryTerminalCandidate = {
  datafeedInstanceId: number;
  symbol: string;
  interval: '1M';
  hasValidBars: true;
  earliestBarTime: number;
  terminalBoundary: number | null;
};

async function loadContractKlineBarsForCountBack({
  symbol,
  category,
  interval,
  initialLimit,
  initialEndTimeMs,
  initialBars = [],
  useCurrentCache,
  requiredBars,
  pageLimit,
  toTimeMs,
  deadlineAt,
  ownerId,
  isActive,
}: LoadContractKlineBarsForCountBackOptions): Promise<LoadContractKlineBarsForCountBackResult> {
  const barsByTime = new Map<number, ContractTradingViewBar>();
  sortAndDedupeBars(initialBars)
    .slice(-CONTRACT_KLINE_MAX_ACCUMULATED_BARS)
    .forEach((bar) => barsByTime.set(bar.time, bar));
  let pageCount = 0;
  let pageEndTimeMs = initialEndTimeMs;
  let lastRequestedEndTimeMs = initialEndTimeMs;
  let terminalMetadata: ContractMarketKlineMetadataResponse | null = null;
  let lastMetadata: ContractMarketKlineMetadataResponse | null = null;
  let stalled = false;
  let coverageReusable = true;

  while (
    pageCount < CONTRACT_KLINE_MAX_HISTORY_PAGES
    && barsByTime.size < requiredBars
    && barsByTime.size < CONTRACT_KLINE_MAX_ACCUMULATED_BARS
    && isActive()
  ) {
    if (Date.now() >= deadlineAt) {
      if (barsByTime.size === 0) throw new Error('Contract kline history chain timed out');
      break;
    }
    const remainingBars = Math.min(
      requiredBars - barsByTime.size,
      CONTRACT_KLINE_MAX_ACCUMULATED_BARS - barsByTime.size,
    );
    const limit = pageCount === 0
      ? initialLimit
      : Math.min(remainingBars, pageLimit, CONTRACT_KLINE_HISTORY_PAGE_LIMIT);
    const isCurrentFirstPage = (
      useCurrentCache
      && pageCount === 0
      && pageEndTimeMs === undefined
    );
    lastRequestedEndTimeMs = pageEndTimeMs;
    pageCount += 1;

    let result: ContractMarketKlineMetadataResponse;
    try {
      result = isCurrentFirstPage
        ? await getContractMarketKlinesMetadataCurrentCacheFirst({
          symbol,
          interval,
          limit,
        }, category, deadlineAt, ownerId)
        : await getContractMarketKlinesMetadataInFlight({
          symbol,
          interval,
          limit,
          endTimeMs: pageEndTimeMs,
        }, deadlineAt, ownerId);
    } catch (error) {
      if (barsByTime.size === 0) throw error;
      break;
    }

    if (!isActive()) break;
    if (!result || !Array.isArray(result.items)) break;
    lastMetadata = result;
    const pageCoverageReusable = shouldRetainContractHistoryCoverage(result);
    if (hasExplicitContractHistoryTerminalEvidence(result)) {
      terminalMetadata = result;
    }

    const pageBars = sortAndDedupeBars(
      result.items
        .map((item) => klineToBar(item, interval))
        .filter((bar): bar is ContractTradingViewBar => Boolean(bar))
        .filter((bar) => (
          bar.time < toTimeMs
          && (pageEndTimeMs === undefined || bar.time < pageEndTimeMs)
        )),
    );
    if (!pageCoverageReusable && pageBars.length > 0) {
      coverageReusable = false;
    }
    if (pageBars.length === 0) {
      stalled = !terminalMetadata;
      break;
    }

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

    if (terminalMetadata || newTimestampCount === 0) {
      stalled = !terminalMetadata && newTimestampCount === 0;
      break;
    }
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

  const accumulatedBars = sortAndDedupeBars(Array.from(barsByTime.values()))
    .slice(-CONTRACT_KLINE_MAX_ACCUMULATED_BARS);
  const bars = accumulatedBars.slice(-requiredBars);
  const terminalComplete = Boolean(terminalMetadata);
  const coverageComplete = terminalComplete || bars.length >= requiredBars;
  const earliestBarTime = accumulatedBars[0]?.time ?? null;
  const explicitTerminalBoundary = getContractHistoryTerminalBoundaryMs(terminalMetadata);
  const terminalBoundary = terminalComplete
    ? explicitTerminalBoundary || earliestBarTime || lastRequestedEndTimeMs || initialEndTimeMs || null
    : null;
  const nextEndTimeMs = !terminalComplete && !stalled && earliestBarTime
    ? earliestBarTime
    : null;

  return {
    bars,
    lastMetadata,
    terminalMetadata,
    pageCount,
    coverageReusable,
    coverageComplete,
    nextEndTimeMs,
    terminalComplete,
    terminalBoundary,
    terminalReason: getContractHistoryTerminalReason(terminalMetadata),
  };
}

function buildLatestBarKey(symbol: string, interval: string) {
  return `${normalizeContractSymbol(symbol)}:${normalizeContractInterval(interval)}`;
}

const CONTRACT_KLINE_HIGH_WATER_MARK_CAPACITY = 128;

type ContractKlineRequestToken = {
  sequence: number;
  generation: string;
  settled: boolean;
  supersededSettlementScheduled: boolean;
  onSuperseded: () => void;
};

export class ContractKlineRequestGuard {
  private sequence = 0;
  private activeGeneration = '';
  private activeTokens = new Set<ContractKlineRequestToken>();
  private destroyed = false;

  private scheduleSupersededSettlement(token: ContractKlineRequestToken) {
    if (token.settled || token.supersededSettlementScheduled) return;
    token.supersededSettlementScheduled = true;
    queueMicrotask(() => {
      token.supersededSettlementScheduled = false;
      if (token.settled) return;
      token.settled = true;
      this.activeTokens.delete(token);
      if (this.destroyed) return;
      token.onSuperseded();
    });
  }

  begin(generation: string, onSuperseded: () => void): ContractKlineRequestToken {
    if (this.activeGeneration && this.activeGeneration !== generation) {
      for (const token of Array.from(this.activeTokens)) {
        this.scheduleSupersededSettlement(token);
      }
    }
    this.sequence += 1;
    this.activeGeneration = generation;
    const token = {
      sequence: this.sequence,
      generation,
      settled: false,
      supersededSettlementScheduled: false,
      onSuperseded,
    };
    this.activeTokens.add(token);
    return token;
  }

  complete(token: ContractKlineRequestToken, callback: () => void) {
    if (this.destroyed || token.settled) {
      return false;
    }
    if (token.generation !== this.activeGeneration || !this.activeTokens.has(token)) {
      this.scheduleSupersededSettlement(token);
      return false;
    }

    token.settled = true;
    this.activeTokens.delete(token);
    callback();
    return true;
  }

  isActive(token: ContractKlineRequestToken) {
    return Boolean(
      !this.destroyed
      && !token.settled
      && token.generation === this.activeGeneration
      && this.activeTokens.has(token)
    );
  }

  destroy() {
    this.destroyed = true;
    this.sequence += 1;
    this.activeGeneration = '';
    for (const token of this.activeTokens) {
      token.settled = true;
    }
    this.activeTokens.clear();
  }
}

let contractKlineDatafeedInstanceSequence = 0;

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
  onHistoryError,
  onRealtimeSubscriptionReady,
  onRealtimeResetRequired,
}: CreateContractTradingViewDatafeedOptions): ContractTradingViewDatafeed {
  const apiSymbol = normalizeContractSymbol(symbol);
  const assetClass = normalizeContractKlineAssetClass(category);
  const displayName = displaySymbol || apiSymbol;
  const latestBars = new Map<string, ContractTradingViewBar>();
  const klineHighWaterMarks = new Map<string, number>();
  const subscriptions = new Map<string, SubscriptionEntry>();
  const historyReadyByLatestBarKey = new Map<string, boolean>();
  const lastSubscriptionKeyBySymbol = new Map<string, string>();
  const latestSubscriptionGenerationByKey = new Map<string, number>();
  const restoreResetCandidates = new Set<string>();
  const resetUnsubscribeGuards = new Map<string, ResetUnsubscribeGuard>();
  const activeResolutionIdentityBySymbol = new Map<string, ContractActiveResolutionIdentity>();
  const committedResolutionIdentityBySymbol = new Map<string, ContractActiveResolutionIdentity>();
  const resolutionTransitions = new Map<number, ResolutionTransitionRecord>();
  const requestGuard = new ContractKlineRequestGuard();
  const datafeedInstanceId = ++contractKlineDatafeedInstanceSequence;
  const historyCoverageByScope = new Map<string, HistoryCoverageState>();
  const monthlyHistoryTerminalCandidates = new Map<string, MonthlyHistoryTerminalCandidate>();
  let subscriptionGeneration = 0;
  let subscriptionLeaseGeneration = 0;
  let transitionGenerationSequence = 0;
  let explicitResolutionAuthorityEnabled = false;
  let destroyed = false;

  const scheduleLifecycleCallback = (callback: () => void) => {
    if (typeof queueMicrotask === 'function') {
      queueMicrotask(callback);
      return;
    }
    void Promise.resolve().then(callback);
  };

  const toRealtimeResolutionIdentity = (
    identity: ContractActiveResolutionIdentity,
  ): ContractKlineResolutionIdentity => ({
    symbol: identity.symbol,
    interval: identity.interval,
    ownerId: identity.ownerId,
    transitionGeneration: identity.transitionGeneration,
  });

  const findLatestSubscription = (symbolValue: string, intervalValue: string) => {
    let latest: SubscriptionEntry | null = null;
    for (const entry of subscriptions.values()) {
      if (
        entry.symbol !== symbolValue
        || entry.interval !== intervalValue
        || (latest && entry.leaseGeneration <= latest.leaseGeneration)
      ) continue;
      latest = entry;
    }
    return latest;
  };

  const bindSubscriptionToIdentity = (
    entry: SubscriptionEntry,
    identity: ContractActiveResolutionIdentity,
  ): ContractActiveResolutionIdentity => {
    entry.ownerId = identity.ownerId;
    entry.generation = identity.subscriptionGeneration;
    entry.transitionGeneration = identity.transitionGeneration;
    entry.readinessBlocked = false;
    return {
      ...identity,
      subscriberUid: entry.subscriberUid,
    };
  };

  const activateResolutionIdentity = (identity: ContractActiveResolutionIdentity) => {
    const key = buildLatestBarKey(identity.symbol, identity.interval);
    activeResolutionIdentityBySymbol.set(identity.symbol, identity);
    lastSubscriptionKeyBySymbol.set(identity.symbol, key);
    latestSubscriptionGenerationByKey.set(key, identity.subscriptionGeneration);
  };

  const beginResolutionTransitionInternal = (
    input: ContractResolutionTransitionInput,
    explicit: boolean,
  ): ContractActiveResolutionIdentity | null => {
    if (destroyed) return null;
    const transitionGeneration = Math.floor(Number(input.transitionGeneration));
    const symbolValue = normalizeContractSymbol(input.symbol);
    const intervalValue = normalizeContractInterval(input.interval);
    if (!symbolValue || !intervalValue || !Number.isInteger(transitionGeneration) || transitionGeneration <= 0) {
      return null;
    }
    if (explicit) explicitResolutionAuthorityEnabled = true;
    const current = activeResolutionIdentityBySymbol.get(symbolValue) ?? null;
    if (
      current
      && current.transitionGeneration === transitionGeneration
      && current.interval === intervalValue
    ) {
      const record = resolutionTransitions.get(transitionGeneration);
      if (record && explicit && !record.explicit) {
        resolutionTransitions.set(transitionGeneration, { ...record, explicit: true });
      }
      return current;
    }
    if (current && transitionGeneration <= current.transitionGeneration) return null;

    transitionGenerationSequence = Math.max(transitionGenerationSequence, transitionGeneration);
    const generation = ++subscriptionGeneration;
    const ownerId = [
      datafeedInstanceId,
      symbolValue,
      intervalValue,
      'resolution',
      transitionGeneration,
      generation,
    ].join(':');
    let candidate: ContractActiveResolutionIdentity = {
      datafeedInstanceId,
      symbol: symbolValue,
      interval: intervalValue,
      subscriberUid: `${ownerId}:pending`,
      ownerId,
      subscriptionGeneration: generation,
      transitionGeneration,
      generation,
    };
    const cachedSubscription = findLatestSubscription(symbolValue, intervalValue);
    if (cachedSubscription) {
      candidate = bindSubscriptionToIdentity(cachedSubscription, candidate);
    }
    const rollbackTarget = committedResolutionIdentityBySymbol.get(symbolValue) ?? null;
    resolutionTransitions.set(transitionGeneration, { candidate, rollbackTarget, explicit });
    activateResolutionIdentity(candidate);
    contractMarketRealtime.beginKlineResolutionTransition(
      toRealtimeResolutionIdentity(candidate),
    );
    scheduleLifecycleCallback(() => {
      const active = activeResolutionIdentityBySymbol.get(symbolValue);
      if (
        !active
        || active.transitionGeneration !== transitionGeneration
        || active.subscriberUid !== candidate.subscriberUid
      ) return;
      try {
        onRealtimeSubscriptionReady?.(active);
      } catch {
        // Resolution-owner readiness is observational and must not change lifecycle state.
      }
    });
    return candidate;
  };

  const getRealtimeSubscriptionReadiness = (
    requestedSymbol: string,
    requestedInterval: string,
  ): ContractRealtimeSubscriptionReadiness | null => {
    if (destroyed) return null;
    const normalizedSymbol = normalizeContractSymbol(requestedSymbol);
    const normalizedInterval = normalizeContractInterval(requestedInterval);
    const latestBarKey = buildLatestBarKey(normalizedSymbol, normalizedInterval);
    if (lastSubscriptionKeyBySymbol.get(normalizedSymbol) !== latestBarKey) return null;
    const activeIdentity = activeResolutionIdentityBySymbol.get(normalizedSymbol) ?? null;
    if (!activeIdentity || activeIdentity.interval !== normalizedInterval) return null;
    const activeSubscription = subscriptions.get(activeIdentity.subscriberUid);
    if (
      !activeSubscription
      && activeIdentity.subscriberUid !== `${activeIdentity.ownerId}:pending`
    ) return null;
    if (
      activeSubscription
      && (
        activeSubscription.readinessBlocked
        || activeSubscription.ownerId !== activeIdentity.ownerId
        || activeSubscription.generation !== activeIdentity.subscriptionGeneration
        || activeSubscription.transitionGeneration !== activeIdentity.transitionGeneration
      )
    ) return null;
    return activeIdentity;
  };

  const commitResolutionTransition = (transitionGenerationValue: number) => {
    if (destroyed) return false;
    const transitionGeneration = Math.floor(Number(transitionGenerationValue));
    const transition = resolutionTransitions.get(transitionGeneration);
    if (!transition) return false;
    const activeIdentity = activeResolutionIdentityBySymbol.get(transition.candidate.symbol) ?? null;
    if (
      !activeIdentity
      || activeIdentity.transitionGeneration !== transitionGeneration
      || activeIdentity.interval !== transition.candidate.interval
    ) return false;

    if (!contractMarketRealtime.commitKlineResolutionTransition(
      toRealtimeResolutionIdentity(activeIdentity),
    )) return false;
    committedResolutionIdentityBySymbol.set(activeIdentity.symbol, activeIdentity);

    for (const entry of Array.from(subscriptions.values())) {
      if (
        entry.symbol !== activeIdentity.symbol
        || (
          entry.interval === activeIdentity.interval
          && entry.transitionGeneration === transitionGeneration
        )
      ) continue;
      subscriptions.delete(entry.subscriberUid);
      resetUnsubscribeGuards.delete(entry.subscriberUid);
      entry.releaseKlineSubscription();
    }
    for (const [generation, record] of resolutionTransitions) {
      if (
        record.candidate.symbol === activeIdentity.symbol
        && generation <= transitionGeneration
      ) resolutionTransitions.delete(generation);
    }
    return true;
  };

  const rollbackResolutionTransition = (transitionGenerationValue: number) => {
    if (destroyed) return false;
    const transitionGeneration = Math.floor(Number(transitionGenerationValue));
    const transition = resolutionTransitions.get(transitionGeneration);
    if (!transition) return false;
    const activeIdentity = activeResolutionIdentityBySymbol.get(transition.candidate.symbol) ?? null;
    if (
      !activeIdentity
      || activeIdentity.transitionGeneration !== transitionGeneration
      || activeIdentity.interval !== transition.candidate.interval
    ) return false;

    if (!contractMarketRealtime.rollbackKlineResolutionTransition(
      toRealtimeResolutionIdentity(activeIdentity),
    )) return false;
    for (const entry of Array.from(subscriptions.values())) {
      if (
        entry.symbol !== activeIdentity.symbol
        || entry.transitionGeneration !== transitionGeneration
      ) continue;
      subscriptions.delete(entry.subscriberUid);
      resetUnsubscribeGuards.delete(entry.subscriberUid);
      entry.releaseKlineSubscription();
    }
    resolutionTransitions.delete(transitionGeneration);
    const rollbackTarget = transition.rollbackTarget;
    if (rollbackTarget) {
      activateResolutionIdentity(rollbackTarget);
      committedResolutionIdentityBySymbol.set(rollbackTarget.symbol, rollbackTarget);
      scheduleLifecycleCallback(() => {
        if (destroyed) return;
        const active = activeResolutionIdentityBySymbol.get(rollbackTarget.symbol);
        if (active?.transitionGeneration !== rollbackTarget.transitionGeneration) return;
        try {
          onRealtimeSubscriptionReady?.(active);
        } catch {
          // Rollback readiness is observational and must not change lifecycle state.
        }
      });
    } else {
      activeResolutionIdentityBySymbol.delete(activeIdentity.symbol);
      committedResolutionIdentityBySymbol.delete(activeIdentity.symbol);
      lastSubscriptionKeyBySymbol.delete(activeIdentity.symbol);
    }
    return true;
  };

  const getContractKlineHighWaterMark = (key: string) => (
    klineHighWaterMarks.get(key) || 0
  );

  const advanceContractKlineHighWaterMark = (key: string, time: number) => {
    if (!Number.isFinite(time) || time <= 0) return getContractKlineHighWaterMark(key);
    const nextTime = Math.max(getContractKlineHighWaterMark(key), time);
    klineHighWaterMarks.delete(key);
    klineHighWaterMarks.set(key, nextTime);
    while (klineHighWaterMarks.size > CONTRACT_KLINE_HIGH_WATER_MARK_CAPACITY) {
      const oldestKey = klineHighWaterMarks.keys().next().value;
      if (!oldestKey) break;
      klineHighWaterMarks.delete(oldestKey);
    }
    return nextTime;
  };

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

  const notifyHistoryError = (event: ContractHistoryErrorEvent) => {
    try {
      onHistoryError?.(event);
    } catch {
      // Observability callbacks must not change TradingView callback semantics.
    }
  };

  return {
    beginResolutionTransition: (transition) => (
      beginResolutionTransitionInternal(transition, true)
    ),
    commitResolutionTransition,
    rollbackResolutionTransition,

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

    async getBars(symbolInfo, resolution, periodParams, onHistory, onError) {
      const requestSymbol = normalizeContractSymbol(symbolInfo.ticker || apiSymbol) || apiSymbol;
      const requestResolution = normalizeResolution(resolution);
      const interval = tradingViewResolutionToContractInterval(resolution);
      const requestGeneration = [datafeedInstanceId, requestSymbol, interval].join('|');
      const requestToken = requestGuard.begin(requestGeneration, () => {
        // A superseded request is lifecycle cancellation, not an empty provider result.
        onHistory([], { noData: false });
      });
      const latestBarKey = buildLatestBarKey(requestSymbol, interval);
      const firstDataRequest = periodParams.firstDataRequest !== false;
      if (firstDataRequest) {
        historyReadyByLatestBarKey.set(latestBarKey, false);
      }
      const requestPlan = resolveContractKlineRequestPlan({
        interval,
        countBack: periodParams.countBack,
        firstDataRequest,
        maxBars: CONTRACT_KLINE_MAX_ACCUMULATED_BARS,
      });
      const {
        requiredBars,
        initialLimit: limit,
        pageLimit,
        policy,
      } = requestPlan;
      const historyChainDeadlineAt = Date.now() + policy.historyChainDeadlineMs;
      const endTimeMs = resolveContractHistoryEndTimeMs(periodParams);
      const to = Number(periodParams.to);
      const toTimeMs = Number.isFinite(to) && to > 0
        ? Math.floor(to * 1000)
        : Number.MAX_SAFE_INTEGER;
      const canCoordinateCoverage = firstDataRequest || endTimeMs !== undefined;
      const retainedCoverage = canCoordinateCoverage
        ? historyCoverageByScope.get(requestGeneration) ?? null
        : null;
      const currentCoverageIsFresh = Boolean(
        !retainedCoverage
        || !firstDataRequest
        || (
          retainedCoverage.currentCacheLimit !== null
          && (
            retainedCoverage.terminalComplete
            || contractKlineCurrentCache.getAtLeast({
              category: assetClass,
              symbol: requestSymbol,
              interval,
              limit: retainedCoverage.currentCacheLimit,
            })
          )
        )
      );
      const existingCoverage = currentCoverageIsFresh ? retainedCoverage : null;
      if (retainedCoverage && !currentCoverageIsFresh) {
        historyCoverageByScope.delete(requestGeneration);
      }
      const existingBarsForRange = existingCoverage
        ? existingCoverage.returnedBars
          .filter((bar) => bar.time < toTimeMs)
          .slice(-requiredBars)
        : [];

      const completeHistoryRequest = (
        bars: ContractTradingViewBar[],
        noData: boolean,
        nextCoverageState: HistoryCoverageState | null = null,
      ) => requestGuard.complete(requestToken, () => {
        if (
          nextCoverageState
        ) {
          historyCoverageByScope.set(requestGeneration, nextCoverageState);
        }
        const latestBar = bars[bars.length - 1] || null;
        if (firstDataRequest) {
          const highWaterMark = getContractKlineHighWaterMark(latestBarKey);
          if (latestBar && latestBar.time >= highWaterMark) {
            advanceContractKlineHighWaterMark(latestBarKey, latestBar.time);
            latestBars.set(latestBarKey, latestBar);
            notifyLatestBar(latestBar);
          } else if (!latestBar && highWaterMark === 0) {
            notifyLatestBar(null);
          }
        }
        onHistory(bars, { noData });
        notifyHistoryBars({
          symbol: requestSymbol,
          interval,
          resolution: requestResolution,
          firstDataRequest,
          barCount: bars.length,
          firstBarTime: bars[0]?.time ?? null,
          lastBarTime: latestBar?.time ?? null,
          requestSeq: requestToken.sequence,
        });
        if (firstDataRequest) {
          historyReadyByLatestBarKey.set(latestBarKey, true);
          for (const entry of subscriptions.values()) {
            if (entry.latestBarKey === latestBarKey) entry.replayReadyStore();
          }
        }
      });

      const completeHistoryError = (reason: string) => requestGuard.complete(requestToken, () => {
        onError(reason);
        notifyHistoryError({
          symbol: requestSymbol,
          interval,
          resolution: requestResolution,
          firstDataRequest,
          firstBarTime: null,
          lastBarTime: null,
          requestSeq: requestToken.sequence,
          error: reason,
        });
      });

      const requestedRangeEndTimeMs = endTimeMs ?? (
        toTimeMs === Number.MAX_SAFE_INTEGER ? null : toTimeMs
      );
      const monthlyTerminalCandidateKey = interval === '1M'
        ? [datafeedInstanceId, requestSymbol, interval].join('|')
        : null;
      const monthlyTerminalCandidate = monthlyTerminalCandidateKey
        ? monthlyHistoryTerminalCandidates.get(monthlyTerminalCandidateKey) ?? null
        : null;
      if (
        monthlyTerminalCandidate
        && monthlyTerminalCandidate.terminalBoundary !== null
        && requestedRangeEndTimeMs !== null
        && requestedRangeEndTimeMs <= monthlyTerminalCandidate.terminalBoundary
      ) {
        completeHistoryRequest([], true);
        return;
      }

      const requestBeyondTerminalBoundary = Boolean(
        existingCoverage?.terminalComplete
        && (
          existingCoverage.returnedBars.length === 0
          || (
            existingCoverage.terminalBoundary !== null
            && (endTimeMs ?? toTimeMs) <= existingCoverage.terminalBoundary
          )
        )
      );
      const canReuseSettledCoverage = Boolean(
        existingCoverage
        && (
          existingBarsForRange.length >= requiredBars
          || existingCoverage.terminalComplete
        )
      );

      if (existingCoverage && (requestBeyondTerminalBoundary || canReuseSettledCoverage)) {
        completeHistoryRequest(
          requestBeyondTerminalBoundary ? [] : existingBarsForRange,
          requestBeyondTerminalBoundary || (
            existingCoverage.terminalComplete
            && existingBarsForRange.length === 0
          ),
        );
        return;
      }

      const existingNextEndTimeMs = existingCoverage
        ? existingCoverage.nextEndTimeMs ?? existingCoverage.returnedBars[0]?.time ?? null
        : null;
      const continuationEndTimeMs = existingCoverage
        ? [existingNextEndTimeMs, requestedRangeEndTimeMs]
          .filter((value): value is number => value !== null && value > 0)
          .reduce<number | null>((minimum, value) => (
            minimum === null ? value : Math.min(minimum, value)
          ), null)
        : endTimeMs ?? null;
      const targetRequiredBars = Math.max(
        requiredBars,
        existingCoverage?.requestedBars ?? 0,
      );

      try {
        const loadBars = (deadlineAt: number) => loadContractKlineBarsForCountBack({
          symbol: requestSymbol,
          category: assetClass,
          interval,
          initialLimit: limit,
          initialEndTimeMs: continuationEndTimeMs ?? undefined,
          initialBars: existingBarsForRange,
          useCurrentCache: (
            !existingCoverage
            && firstDataRequest
            && endTimeMs === undefined
          ),
          requiredBars: targetRequiredBars,
          pageLimit,
          toTimeMs,
          deadlineAt,
          ownerId: String(datafeedInstanceId),
          isActive: () => requestGuard.isActive(requestToken),
        });
        let result;
        try {
          result = await loadBars(historyChainDeadlineAt);
        } catch (error) {
          if (
            !(error instanceof ContractKlineLeaseTimeoutError)
            || !requestGuard.isActive(requestToken)
          ) {
            throw error;
          }
          result = await loadBars(Date.now() + policy.historyChainDeadlineMs);
        }
        const bars = result.bars
          .filter((bar) => bar.time < toTimeMs)
          .slice(-requiredBars);
        if (monthlyTerminalCandidateKey && bars.length > 0) {
          const earliestReturnedBarTime = bars[0].time;
          const previousCandidate = monthlyHistoryTerminalCandidates.get(
            monthlyTerminalCandidateKey,
          ) ?? null;
          const earliestBarTime = Math.min(
            previousCandidate?.earliestBarTime ?? earliestReturnedBarTime,
            earliestReturnedBarTime,
          );
          monthlyHistoryTerminalCandidates.set(monthlyTerminalCandidateKey, {
            datafeedInstanceId,
            symbol: requestSymbol,
            interval: '1M',
            hasValidBars: true,
            earliestBarTime,
            terminalBoundary: previousCandidate
              && earliestBarTime === previousCandidate.earliestBarTime
              ? previousCandidate.terminalBoundary
              : null,
          });
        }
        const scopedCoverage = historyCoverageByScope.get(requestGeneration) ?? null;
        const previousCoverage = scopedCoverage?.generation === requestGeneration
          ? scopedCoverage
          : existingCoverage;
        const mergedCoverageBars = sortAndDedupeBars([
          ...(previousCoverage?.returnedBars ?? []),
          ...result.bars,
        ]).slice(-CONTRACT_KLINE_MAX_ACCUMULATED_BARS);
        const mergedRequestedBars = Math.max(
          targetRequiredBars,
          previousCoverage?.requestedBars ?? 0,
        );
        const terminalComplete = Boolean(
          previousCoverage?.terminalComplete || result.terminalComplete
        );
        const terminalBoundary = result.terminalBoundary !== null
          ? Math.min(
            previousCoverage?.terminalBoundary ?? result.terminalBoundary,
            result.terminalBoundary,
          )
          : previousCoverage?.terminalBoundary ?? null;
        const terminalReason = result.terminalReason
          ?? previousCoverage?.terminalReason
          ?? null;
        const nextEndTimeMs = terminalComplete
          ? null
          : [previousCoverage?.nextEndTimeMs ?? null, result.nextEndTimeMs]
            .filter((value): value is number => value !== null && value > 0)
            .reduce<number | null>((minimum, value) => (
              minimum === null ? value : Math.min(minimum, value)
            ), null);
        const nextCoverageState = canCoordinateCoverage
          && result.coverageReusable
          && (mergedCoverageBars.length > 0 || terminalComplete)
          ? {
            symbol: requestSymbol,
            interval,
            generation: requestGeneration,
            currentCacheLimit: previousCoverage?.currentCacheLimit ?? (
              firstDataRequest && endTimeMs === undefined ? limit : null
            ),
            requestedBars: mergedRequestedBars,
            returnedBars: mergedCoverageBars,
            coverageComplete: terminalComplete
              || mergedCoverageBars.length >= mergedRequestedBars,
            nextEndTimeMs,
            terminalComplete,
            terminalBoundary,
            terminalReason,
          } satisfies HistoryCoverageState
          : null;

        const terminalCandidateAfterLoad = monthlyTerminalCandidateKey
          ? monthlyHistoryTerminalCandidates.get(monthlyTerminalCandidateKey) ?? null
          : null;
        const confirmsMonthlyHistoryTerminal = Boolean(
          bars.length === 0
          && terminalCandidateAfterLoad
          && terminalCandidateAfterLoad.hasValidBars
          && requestedRangeEndTimeMs !== null
          && requestedRangeEndTimeMs <= terminalCandidateAfterLoad.earliestBarTime
          && isContractProviderEmptyHistory(result.lastMetadata)
        );
        if (
          confirmsMonthlyHistoryTerminal
          && monthlyTerminalCandidateKey
          && terminalCandidateAfterLoad
        ) {
          monthlyHistoryTerminalCandidates.set(monthlyTerminalCandidateKey, {
            ...terminalCandidateAfterLoad,
            terminalBoundary: terminalCandidateAfterLoad.earliestBarTime,
          });
          completeHistoryRequest([], true);
          return;
        }

        if (bars.length === 0 && !terminalComplete) {
          completeHistoryError(getContractHistoryErrorReason(result.lastMetadata));
          return;
        }

        completeHistoryRequest(
          bars,
          bars.length === 0 && terminalComplete,
          nextCoverageState,
        );
      } catch (error) {
        completeHistoryError(
          error instanceof Error && error.message
            ? error.message
            : 'Kline history request failed',
        );
      }
    },

    subscribeBars(
      symbolInfo,
      resolution,
      onRealtime,
      subscriberUid,
      onResetCacheNeededCallback,
    ) {
      const normalizedSubscriberUid = String(subscriberUid || '');
      const subscriptionSymbol = normalizeContractSymbol(symbolInfo.ticker || apiSymbol) || apiSymbol;
      const interval = tradingViewResolutionToContractInterval(resolution);
      const latestBarKey = buildLatestBarKey(subscriptionSymbol, interval);
      const previousKeyForSymbol = lastSubscriptionKeyBySymbol.get(subscriptionSymbol) || '';
      let resolutionIdentity = activeResolutionIdentityBySymbol.get(subscriptionSymbol) ?? null;
      const activeTransition = resolutionIdentity
        ? resolutionTransitions.get(resolutionIdentity.transitionGeneration) ?? null
        : null;
      if (
        !resolutionIdentity
        || (
          resolutionIdentity.interval !== interval
          && !explicitResolutionAuthorityEnabled
          && !activeTransition?.explicit
        )
      ) {
        resolutionIdentity = beginResolutionTransitionInternal({
          symbol: subscriptionSymbol,
          interval,
          transitionGeneration: ++transitionGenerationSequence,
        }, false);
      }
      const belongsToActiveResolution = Boolean(
        resolutionIdentity
        && resolutionIdentity.interval === interval
      );
      const pendingResolutionIdentity = Boolean(
        belongsToActiveResolution
        && resolutionIdentity
        && resolutionIdentity.subscriberUid === `${resolutionIdentity.ownerId}:pending`
      );
      const generation = pendingResolutionIdentity && resolutionIdentity
        ? resolutionIdentity.subscriptionGeneration
        : ++subscriptionGeneration;
      const ownerId = belongsToActiveResolution && resolutionIdentity
        ? pendingResolutionIdentity
          ? resolutionIdentity.ownerId
          : [
            datafeedInstanceId,
            normalizedSubscriberUid,
            resolutionIdentity.transitionGeneration,
            generation,
          ].join(':')
        : [datafeedInstanceId, normalizedSubscriberUid, 'stale', generation].join(':');
      const transitionGeneration = belongsToActiveResolution && resolutionIdentity
        ? resolutionIdentity.transitionGeneration
        : 0;
      if (belongsToActiveResolution && resolutionIdentity) {
        resolutionIdentity = {
          ...resolutionIdentity,
          subscriberUid: normalizedSubscriberUid,
          ownerId,
          subscriptionGeneration: generation,
          generation,
        };
        activateResolutionIdentity(resolutionIdentity);
        const transition = resolutionTransitions.get(transitionGeneration);
        if (transition) {
          resolutionTransitions.set(transitionGeneration, {
            ...transition,
            candidate: resolutionIdentity,
          });
        }
        if (
          committedResolutionIdentityBySymbol.get(subscriptionSymbol)?.transitionGeneration
            === transitionGeneration
        ) {
          committedResolutionIdentityBySymbol.set(subscriptionSymbol, resolutionIdentity);
        }
        contractMarketRealtime.beginKlineResolutionTransition(
          toRealtimeResolutionIdentity(resolutionIdentity),
        );
      }
      if (belongsToActiveResolution && previousKeyForSymbol && previousKeyForSymbol !== latestBarKey) {
        restoreResetCandidates.add(previousKeyForSymbol);
      }
      const shouldResetRestoredBaseline = (
        belongsToActiveResolution
        && !activeTransition?.explicit
        && typeof onResetCacheNeededCallback === 'function'
        && restoreResetCandidates.delete(latestBarKey)
      );
      if (!historyReadyByLatestBarKey.has(latestBarKey) || shouldResetRestoredBaseline) {
        historyReadyByLatestBarKey.set(latestBarKey, false);
      }
      resetUnsubscribeGuards.delete(normalizedSubscriberUid);

      const previousSubscription = subscriptions.get(normalizedSubscriberUid);
      if (previousSubscription) {
        subscriptions.delete(normalizedSubscriberUid);
        previousSubscription.releaseKlineSubscription();
      }

      const subscription: SubscriptionEntry = {
        subscriberUid: normalizedSubscriberUid,
        symbol: subscriptionSymbol,
        interval,
        ownerId,
        generation,
        leaseGeneration: ++subscriptionLeaseGeneration,
        transitionGeneration,
        latestBarKey,
        lastEmittedBarTime: 0,
        lastEmittedBarFingerprint: '',
        lastStoreBarTime: 0,
        legacyVersionCursor: null,
        readinessBlocked: shouldResetRestoredBaseline,
        executedResetPermitId: null,
        releaseKlineSubscription: () => undefined,
        replayReadyStore: () => undefined,
        callback: onRealtime,
        resetCallback: typeof onResetCacheNeededCallback === 'function'
          ? onResetCacheNeededCallback
          : null,
      };

      subscriptions.set(normalizedSubscriberUid, subscription);

      const getActiveSubscription = () => {
        const activeSubscription = subscriptions.get(normalizedSubscriberUid);
        if (
          !activeSubscription
          || activeSubscription.subscriberUid !== normalizedSubscriberUid
          || activeSubscription.ownerId !== ownerId
          || activeSubscription.generation !== generation
          || activeSubscription.leaseGeneration !== subscription.leaseGeneration
          || activeSubscription.transitionGeneration !== transitionGeneration
          || activeSubscription.symbol !== subscriptionSymbol
          || activeSubscription.interval !== interval
        ) return null;
        const activeIdentity = activeResolutionIdentityBySymbol.get(subscriptionSymbol);
        if (
          !activeIdentity
          || activeIdentity.interval !== interval
          || activeIdentity.subscriberUid !== normalizedSubscriberUid
          || activeIdentity.ownerId !== ownerId
          || activeIdentity.subscriptionGeneration !== generation
          || activeIdentity.transitionGeneration !== transitionGeneration
          || lastSubscriptionKeyBySymbol.get(subscriptionSymbol) !== latestBarKey
          || latestSubscriptionGenerationByKey.get(latestBarKey) !== generation
        ) return null;
        return activeSubscription;
      };

      const commitRealtimeBar = (
        nextBar: ContractTradingViewBar,
        authority: ContractTradingViewRealtimeBarAuthority,
      ): boolean => {
        const activeSubscription = getActiveSubscription();
        if (!activeSubscription) return false;
        if (historyReadyByLatestBarKey.get(latestBarKey) !== true) return false;
        if (
          authority === 'LEGACY_FALLBACK'
          && nextBar.time <= activeSubscription.lastStoreBarTime
        ) return false;

        const previousBar = latestBars.get(latestBarKey);
        const effectiveHighWaterMark = Math.max(
          getContractKlineHighWaterMark(latestBarKey),
          previousBar?.time || 0,
          activeSubscription.lastEmittedBarTime,
        );
        if (nextBar.time < effectiveHighWaterMark) return false;
        const fingerprint = realtimeBarFingerprint(nextBar);
        if (
          nextBar.time === activeSubscription.lastEmittedBarTime
          && fingerprint === activeSubscription.lastEmittedBarFingerprint
        ) return false;

        advanceContractKlineHighWaterMark(latestBarKey, nextBar.time);
        activeSubscription.lastEmittedBarTime = Math.max(
          activeSubscription.lastEmittedBarTime,
          nextBar.time,
        );
        activeSubscription.lastEmittedBarFingerprint = fingerprint;
        latestBars.set(latestBarKey, nextBar);
        notifyLatestBar(nextBar);
        activeSubscription.callback(nextBar);
        return true;
      };

      const previewCompositor = new ContractTradingViewPreviewCompositor({
        symbol: subscriptionSymbol,
        interval,
      });
      const realtimeBarFrameCoalescer = new ContractTradingViewRealtimeBarFrameCoalescer({
        windowMs: 12,
        onFlush: (candidate) => {
          commitRealtimeBar(candidate.bar, candidate.authority);
        },
      });
      const emitRealtimeBar = (
        nextBar: ContractTradingViewBar,
        authority: ContractTradingViewRealtimeBarAuthority,
        source?: ContractTradingViewRealtimeBarFrameSource,
      ): boolean => {
        if (!previewCompositor.supported || !source) {
          return commitRealtimeBar(nextBar, authority);
        }
        if (!getActiveSubscription()) return false;
        if (historyReadyByLatestBarKey.get(latestBarKey) !== true) return false;
        return realtimeBarFrameCoalescer.enqueue({
          symbol: subscriptionSymbol,
          interval,
          source,
          authority,
          bar: {
            time: nextBar.time,
            open: nextBar.open,
            high: nextBar.high,
            low: nextBar.low,
            close: nextBar.close,
            volume: Number(nextBar.volume ?? 0),
          },
        });
      };

      const emitNativeBar = (
        nextBar: ContractTradingViewBar,
        version: KlineVersionCursor,
        isClosed: boolean,
        authority: 'STORE' | 'LEGACY_FALLBACK',
      ): boolean => {
        if (!previewCompositor.supported) return emitRealtimeBar(nextBar, authority);
        const generation = positiveInteger(version.providerGeneration);
        const epoch = nonNegativeInteger(version.revisionEpoch);
        const sequence = nonNegativeInteger(version.revisionSequence);
        const receivedAtMs = positiveInteger(version.observedAtMs);
        if (
          generation === null
          || epoch === null
          || sequence === null
          || receivedAtMs === null
        ) return emitRealtimeBar(nextBar, authority);
        const nativeInput: ContractPreviewNativeInput = {
          symbol: subscriptionSymbol,
          interval,
          openTime: nextBar.time,
          generation,
          receivedAtMs,
          revision: { epoch, sequence },
          isClosed,
          bar: {
            ...nextBar,
            volume: Number(nextBar.volume ?? 0),
          },
        };
        const result = previewCompositor.acceptNative(nativeInput);
        if (!result.accepted || !result.bar) return false;
        if (result.reason === 'NATIVE_OPEN_DEFERRED_TO_PREVIEW') return true;
        const source: ContractTradingViewRealtimeBarFrameSource = isClosed
          ? 'native-closed'
          : result.source === 'preview'
            ? 'preview'
            : 'native-open';
        return emitRealtimeBar(result.bar, authority, source);
      };

      const handleStoreEntry = (entry: ContractMarketStoreEntry | null) => {
        const activeSubscription = getActiveSubscription();
        if (!activeSubscription) return;
        if (!entry) return;
        const nextBar = storeKlineEntryToBar(entry, subscriptionSymbol, interval);
        if (!nextBar) return;
        activeSubscription.lastStoreBarTime = Math.max(
          activeSubscription.lastStoreBarTime,
          nextBar.time,
        );
        emitNativeBar(
          nextBar,
          storeEntryVersion(entry),
          entry.revision?.isClosed === true,
          'STORE',
        );
      };

      const releaseLegacyKlineSubscription = contractMarketRealtime.subscribeKline({
        symbol: subscriptionSymbol,
        interval,
        transitionGeneration,
      }, (message) => {
        if (!getActiveSubscription()) return;
        const activeStoreSymbol = normalizeContractSymbol(
          contractMarketStore.getState().activeSymbol || '',
        );
        if (activeStoreSymbol && activeStoreSymbol !== subscriptionSymbol) return;
        const nextBar = realtimeMessageToBar(message, subscriptionSymbol, interval);
        if (!nextBar) return;
        const activeSubscription = getActiveSubscription();
        if (!activeSubscription) return;
        const version = realtimeMessageVersion(message, nextBar);
        const storeEntry = selectContractMarketKlineEntry(
          contractMarketStore.getState(),
          subscriptionSymbol,
          interval,
        );
        if (storeEntry && !acceptsKlineVersion(storeEntryVersion(storeEntry), version)) return;
        if (!acceptsKlineVersion(activeSubscription.legacyVersionCursor, version)) return;
        const messageRecord = message as Record<string, unknown>;
        const payload = toRecord(message.kline) || toRecord(message.data);
        const revision = toRecord(payload?.revision) || toRecord(messageRecord.revision);
        const isClosed = (
          payload?.is_closed === true
          || revision?.is_closed === true
          || messageRecord.is_closed === true
        );
        if (emitNativeBar(nextBar, version, isClosed, 'LEGACY_FALLBACK')) {
          activeSubscription.legacyVersionCursor = version;
        }
      });
      const releasePreviewSubscription = previewCompositor.supported
        ? contractMarketRealtime.subscribe('preview', (message) => {
            if (!getActiveSubscription()) return;
            const input = realtimePreviewMessageToInput(
              message,
              subscriptionSymbol,
              interval,
            );
            if (!input) return;
            const result = previewCompositor.acceptPreview(input);
            if (!result.accepted || !result.bar) return;
            emitRealtimeBar(result.bar, 'PREVIEW', 'preview');
          })
        : () => undefined;
      const releaseStoreKlineSubscription = subscribeContractMarketKlineEntry(
        subscriptionSymbol,
        interval,
        handleStoreEntry,
      );

      subscription.releaseKlineSubscription = () => {
        realtimeBarFrameCoalescer.cancel();
        releasePreviewSubscription();
        releaseStoreKlineSubscription();
        releaseLegacyKlineSubscription();
        previewCompositor.reset();
      };
      subscription.replayReadyStore = () => {
        handleStoreEntry(selectContractMarketKlineEntry(
          contractMarketStore.getState(),
          subscriptionSymbol,
          interval,
        ));
      };
      handleStoreEntry(selectContractMarketKlineEntry(
        contractMarketStore.getState(),
        subscriptionSymbol,
        interval,
      ));

      const readiness = getRealtimeSubscriptionReadiness(subscriptionSymbol, interval);
      if (!shouldResetRestoredBaseline && readiness?.ownerId === ownerId) {
        scheduleLifecycleCallback(() => {
          if (destroyed) return;
          const activeReadiness = getRealtimeSubscriptionReadiness(
            subscriptionSymbol,
            interval,
          );
          if (activeReadiness?.ownerId !== ownerId) return;
          try {
            onRealtimeSubscriptionReady?.(activeReadiness);
          } catch {
            // Readiness observation must not change TradingView subscription semantics.
          }
        });
      }

      if (shouldResetRestoredBaseline) {
        scheduleLifecycleCallback(() => {
          if (destroyed) return;
          const activeSubscription = getActiveSubscription();
          if (!activeSubscription || !activeSubscription.resetCallback) return;
          try {
            onRealtimeResetRequired?.({
              datafeedInstanceId,
              symbol: activeSubscription.symbol,
              interval: activeSubscription.interval,
              subscriberUid: activeSubscription.subscriberUid,
              ownerId: activeSubscription.ownerId,
              subscriptionGeneration: activeSubscription.generation,
              transitionGeneration: activeSubscription.transitionGeneration,
              generation: activeSubscription.generation,
              source: 'RESTORED_BASELINE',
            });
          } catch {
            // Reset evidence observation must not change subscription semantics.
          }
        });
      }
    },

    unsubscribeBars(subscriberUid) {
      const normalizedSubscriberUid = String(subscriberUid || '');
      const entry = subscriptions.get(normalizedSubscriberUid);
      if (!entry) return;
      const resetGuard = resetUnsubscribeGuards.get(normalizedSubscriberUid);
      const isResetLifecycleUnsubscribe = Boolean(
        resetGuard
        && resetGuard.subscriberUid === entry.subscriberUid
        && resetGuard.symbol === entry.symbol
        && resetGuard.interval === entry.interval
        && resetGuard.ownerId === entry.ownerId
        && resetGuard.generation === entry.generation
        && resetGuard.transitionGeneration === entry.transitionGeneration
        && resetGuard.latestBarKey === entry.latestBarKey
        && lastSubscriptionKeyBySymbol.get(entry.symbol) === entry.latestBarKey
      );
      resetUnsubscribeGuards.delete(normalizedSubscriberUid);
      if (isResetLifecycleUnsubscribe) return;
      subscriptions.delete(normalizedSubscriberUid);
      entry.releaseKlineSubscription();
    },

    getRealtimeSubscriptionReadiness,
    getDatafeedInstanceId: () => datafeedInstanceId,

    executeResetPermit(requirement, permit) {
      if (destroyed || !permit || permit.source !== requirement.source) return false;
      const normalizedSubscriberUid = String(requirement.subscriberUid || '');
      const entry = subscriptions.get(normalizedSubscriberUid);
      if (
        !entry
        || !entry.readinessBlocked
        || !entry.resetCallback
        || entry.executedResetPermitId
        || requirement.datafeedInstanceId !== datafeedInstanceId
        || entry.symbol !== normalizeContractSymbol(requirement.symbol)
        || entry.interval !== normalizeContractInterval(requirement.interval)
        || entry.ownerId !== requirement.ownerId
        || entry.generation !== requirement.subscriptionGeneration
        || entry.transitionGeneration !== requirement.transitionGeneration
        || permit.identity.terminalType !== 'CONTRACT'
        || permit.identity.datafeedInstanceId !== datafeedInstanceId
        || permit.identity.symbol !== entry.symbol
        || permit.identity.backendInterval !== entry.interval
        || permit.identity.intentId !== entry.transitionGeneration
      ) return false;

      entry.executedResetPermitId = permit.permitId;
      const resetGuard: ResetUnsubscribeGuard = {
        subscriberUid: entry.subscriberUid,
        symbol: entry.symbol,
        interval: entry.interval,
        ownerId: entry.ownerId,
        generation: entry.generation,
        transitionGeneration: entry.transitionGeneration,
        latestBarKey: entry.latestBarKey,
      };
      resetUnsubscribeGuards.set(normalizedSubscriberUid, resetGuard);
      try {
        entry.resetCallback();
      } catch {
        // A permitted TradingView reset remains best-effort.
      } finally {
        scheduleLifecycleCallback(() => {
          if (resetUnsubscribeGuards.get(normalizedSubscriberUid) === resetGuard) {
            resetUnsubscribeGuards.delete(normalizedSubscriberUid);
          }
        });
      }
      return true;
    },

    destroy() {
      const activeResolutionIdentities = Array.from(activeResolutionIdentityBySymbol.values());
      destroyed = true;
      requestGuard.destroy();
      contractKlineRequestLeaseRegistry.releaseOwner(String(datafeedInstanceId));
      historyCoverageByScope.clear();
      monthlyHistoryTerminalCandidates.clear();
      historyReadyByLatestBarKey.clear();
      const activeSubscriptions = Array.from(subscriptions.values());
      subscriptions.clear();
      activeSubscriptions.forEach((entry) => entry.releaseKlineSubscription());
      activeResolutionIdentities.forEach((identity) => {
        contractMarketRealtime.releaseKlineResolutionOwner(
          toRealtimeResolutionIdentity(identity),
        );
      });
      latestBars.clear();
      klineHighWaterMarks.clear();
      lastSubscriptionKeyBySymbol.clear();
      latestSubscriptionGenerationByKey.clear();
      restoreResetCandidates.clear();
      resetUnsubscribeGuards.clear();
      activeResolutionIdentityBySymbol.clear();
      committedResolutionIdentityBySymbol.clear();
      resolutionTransitions.clear();
    },
  };
}
