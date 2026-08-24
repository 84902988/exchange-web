import {
  fetchContractKlineHistory,
  normalizeContractKlineRows,
  type ContractKline,
  type ContractKlineHistoryResult,
} from '../api/contract';
import {
  getContractMarketRealtimeStore,
  type ContractKlineDomainHandlers,
} from './contractMarketRealtime';
import {BoundedStoreCache} from './boundedStoreCache';
import type {PublicWebSocketStatus} from './managedPublicWebSocket';

const CONTRACT_KLINE_HISTORY_LIMIT = 80;
const CONTRACT_KLINE_DOMAIN_READY_TIMEOUT_MS = 12_000;
const CONTRACT_KLINE_DOMAIN_READY_TIMEOUT_MAX_MS = 30_000;
const CONTRACT_KLINE_DOMAIN_SILENCE_TIMEOUT_MS = 20_000;
const CONTRACT_KLINE_HISTORY_RETRY_BASE_MS = 2_000;
const CONTRACT_KLINE_HISTORY_RETRY_MAX_MS = 30_000;
const CONTRACT_KLINE_REST_DISPLAY_REFRESH_MS = 15_000;
// A 1m+ candle does not benefit from rebuilding the full SVG on every market
// frame. One visual update per second keeps the candle live while leaving the
// JS thread available for navigation and order-entry gestures.
const CONTRACT_KLINE_RENDER_THROTTLE_MS = 1_000;
const CONTRACT_KLINE_PENDING_FRAME_LIMIT = 2;

const CONTRACT_KLINE_INTERVALS = [
  '1m',
  '5m',
  '15m',
  '1h',
  '4h',
  '1d',
] as const;

export type ContractKlineInterval =
  (typeof CONTRACT_KLINE_INTERVALS)[number];

const INTERVAL_MS: Record<ContractKlineInterval, number> = {
  '1m': 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '4h': 4 * 60 * 60_000,
  '1d': 24 * 60 * 60_000,
};

const NATIVE_KLINE_INTERVALS = new Set<ContractKlineInterval>([
  '1m',
  '5m',
  '15m',
  '1h',
  '4h',
]);

const NATIVE_KLINE_SOURCES = new Set([
  'LIVE_WS',
  'PROVIDER_WS',
]);

export type ContractKlineRealtimePhase =
  | 'idle'
  | 'bootstrapping'
  | 'connecting'
  | 'live'
  | 'reconnecting'
  | 'degraded'
  | 'suspended'
  | 'paused';

export type ContractKlineRealtimeState = {
  symbol: string;
  interval: ContractKlineInterval;
  items: ContractKline[];
  loading: boolean;
  error: string | null;
  phase: ContractKlineRealtimePhase;
  source: 'REST' | 'WS_NATIVE' | 'REST+WS_NATIVE' | null;
  mode: 'NATIVE' | 'REST_ONLY';
  subscriptionReady: boolean;
  domainReady: boolean;
  gapDetected: boolean;
  sessionGeneration: number;
  revision: number;
};

type NativeKlineRevision = {
  epoch: number;
  sequence: number;
  isClosed: boolean;
  checksum: string | null;
};

type NativeKlineFrame = {
  bar: ContractKline;
  provider: string;
  providerGeneration: number;
  revision: NativeKlineRevision;
  receivedAtMs: number;
  fingerprint: string;
};

type NativeKlineCursor = {
  provider: string;
  providerGeneration: number;
  revisionEpoch: number;
  revisionSequence: number;
  receivedAtMs: number;
  openTime: number;
  fingerprint: string;
  isClosed: boolean;
};

export type ContractKlineHub = {
  acquireKlineDomain: (
    owner: string,
    interval: string,
    handlers: ContractKlineDomainHandlers,
  ) => () => void;
  resubscribeKlineDomain: (interval: string) => boolean;
};

export type ContractKlineRealtimeDependencies = {
  fetchHistory?: (
    symbol: string,
    interval: string,
    limit: number,
    options: {signal?: AbortSignal},
  ) => Promise<ContractKlineHistoryResult>;
  hub?: ContractKlineHub;
  now?: () => number;
  historyLimit?: number;
  domainReadyTimeoutMs?: number;
  domainSilenceTimeoutMs?: number;
  historyRetryBaseMs?: number;
  historyRetryMaxMs?: number;
  restDisplayRefreshMs?: number;
  renderThrottleMs?: number;
};

type ParsedKlineMessage =
  | {kind: 'ignored'}
  | {kind: 'ack'}
  | {
      kind: 'frame';
      frame: NativeKlineFrame;
      subscriptionReady: boolean;
    };

type NativeFrameAcceptance =
  | 'accepted'
  | 'confirmed'
  | 'buffered'
  | 'ignored';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeSymbol(value: unknown) {
  return String(value || '').trim().toUpperCase();
}

function normalizeText(value: unknown) {
  return String(value || '').trim().toUpperCase();
}

function readNumber(
  records: Array<Record<string, unknown> | null>,
  ...keys: string[]
) {
  for (const record of records) {
    if (!record) continue;
    for (const key of keys) {
      const raw = record[key];
      if (raw === null || raw === undefined || raw === '') continue;
      const numeric = Number(raw);
      if (Number.isFinite(numeric)) return numeric;
    }
  }
  return null;
}

function readSafeInteger(
  records: Array<Record<string, unknown> | null>,
  ...keys: string[]
) {
  const value = readNumber(records, ...keys);
  return value !== null &&
    Number.isSafeInteger(value) &&
    value >= 0
    ? value
    : null;
}

function readConsistentSafeInteger(
  records: Array<Record<string, unknown> | null>,
  ...keys: string[]
) {
  let resolved: number | null = null;
  for (const record of records) {
    if (!record) continue;
    for (const key of keys) {
      const raw = record[key];
      if (raw === null || raw === undefined || raw === '') continue;
      const numeric = Number(raw);
      if (
        !Number.isSafeInteger(numeric) ||
        numeric < 0 ||
        (resolved !== null && resolved !== numeric)
      ) {
        return null;
      }
      resolved = numeric;
    }
  }
  return resolved;
}

function readText(
  records: Array<Record<string, unknown> | null>,
  ...keys: string[]
) {
  for (const record of records) {
    if (!record) continue;
    for (const key of keys) {
      const value = record[key];
      if (
        (typeof value === 'string' ||
          typeof value === 'number') &&
        String(value).trim()
      ) {
        return String(value).trim();
      }
    }
  }
  return '';
}

function readConsistentBoolean(
  records: Array<Record<string, unknown> | null>,
  ...keys: string[]
) {
  let resolved: boolean | null = null;
  for (const record of records) {
    if (!record) continue;
    for (const key of keys) {
      const value = record[key];
      if (typeof value !== 'boolean') continue;
      if (resolved !== null && resolved !== value) return null;
      resolved = value;
    }
  }
  return resolved;
}

export function normalizeContractKlineInterval(
  value: unknown,
): ContractKlineInterval | null {
  const normalized = String(value || '').trim();
  return (
    CONTRACT_KLINE_INTERVALS as readonly string[]
  ).includes(normalized)
    ? (normalized as ContractKlineInterval)
    : null;
}

function frameFingerprint(
  bar: ContractKline,
  isClosed: boolean,
) {
  return [
    bar.openTime,
    bar.open,
    bar.high,
    bar.low,
    bar.close,
    bar.volume,
    isClosed ? 1 : 0,
  ].join('|');
}

function parseFrame(
  message: Record<string, unknown>,
  payload: Record<string, unknown>,
  expectedSymbol: string,
  expectedInterval: ContractKlineInterval,
) {
  const payloadRevision = isRecord(payload.revision)
    ? payload.revision
    : null;
  const messageRevision = isRecord(message.revision)
    ? message.revision
    : null;
  const revisionRecords = [
    payloadRevision,
    messageRevision,
    payload,
    message,
  ];
  const records = [payload, message];
  const symbol = normalizeSymbol(
    readText(records, 'symbol') || expectedSymbol,
  );
  const interval = normalizeContractKlineInterval(
    readText(records, 'interval') || expectedInterval,
  );
  const source = normalizeText(
    readText(records, 'source', 'kline_source'),
  );
  const transport = normalizeText(
    readText(records, 'transport'),
  );
  const freshness = normalizeText(
    readText(records, 'freshness', 'kline_freshness'),
  );
  const stale = readConsistentBoolean(records, 'stale');
  const provider = normalizeText(readText(records, 'provider'));
  const providerGeneration = readSafeInteger(
    records,
    'provider_generation',
    'providerGeneration',
  );
  const revisionEpoch = readConsistentSafeInteger(
    revisionRecords,
    'epoch',
    'revision_epoch',
  );
  const revisionSequence = readConsistentSafeInteger(
    revisionRecords,
    'sequence',
    'revision_sequence',
    'revision_seq',
  );
  const receivedAtMs = readSafeInteger(
    records,
    'received_at_ms',
    'receivedAtMs',
  );
  const isClosed = readConsistentBoolean(
    revisionRecords,
    'is_closed',
    'is_final',
    'isClosed',
  );
  const checksum =
    readText(
      revisionRecords,
      'checksum',
    ) || null;
  const bar = normalizeContractKlineRows([payload], 1)[0];
  if (
    !bar ||
    symbol !== expectedSymbol ||
    interval !== expectedInterval ||
    !NATIVE_KLINE_SOURCES.has(source) ||
    transport !== 'PROVIDER_WS' ||
    freshness !== 'LIVE' ||
    stale !== false ||
    !provider ||
    providerGeneration === null ||
    providerGeneration <= 0 ||
    revisionEpoch === null ||
    revisionSequence === null ||
    receivedAtMs === null ||
    receivedAtMs <= 0 ||
    isClosed === null ||
    bar.openTime % INTERVAL_MS[expectedInterval] !== 0 ||
    bar.openTime > receivedAtMs + 5_000
  ) {
    return null;
  }
  return {
    bar,
    provider,
    providerGeneration,
    revision: {
      epoch: revisionEpoch,
      sequence: revisionSequence,
      isClosed,
      checksum,
    },
    receivedAtMs,
    fingerprint: frameFingerprint(bar, isClosed),
  } satisfies NativeKlineFrame;
}

export function parseContractNativeKlineMessage(
  message: unknown,
  expectedSymbol: string,
  expectedInterval: ContractKlineInterval,
): ParsedKlineMessage {
  if (!isRecord(message)) return {kind: 'ignored'};
  const type = String(message.type || '').trim().toLowerCase();
  const normalizedSymbol = normalizeSymbol(expectedSymbol);
  if (!NATIVE_KLINE_INTERVALS.has(expectedInterval)) {
    return {kind: 'ignored'};
  }
  if (normalizeSymbol(message.symbol) !== normalizedSymbol) {
    return {kind: 'ignored'};
  }

  if (type === 'contract_market_snapshot') {
    if (message.domain) return {kind: 'ignored'};
    const data = isRecord(message.data) ? message.data : null;
    const klines = data && isRecord(data.klines)
      ? data.klines
      : null;
    const payload =
      klines && isRecord(klines[expectedInterval])
        ? klines[expectedInterval]
        : null;
    if (!payload) return {kind: 'ignored'};
    const frame = parseFrame(
      message,
      payload,
      normalizedSymbol,
      expectedInterval,
    );
    return frame
      ? {kind: 'frame', frame, subscriptionReady: false}
      : {kind: 'ignored'};
  }

  if (
    type !== 'contract_kline_snapshot' &&
    type !== 'contract_kline_update'
  ) {
    return {kind: 'ignored'};
  }
  if (
    String(message.domain || '').trim().toLowerCase() !==
      'kline' ||
    normalizeContractKlineInterval(message.interval) !==
      expectedInterval
  ) {
    return {kind: 'ignored'};
  }
  const payload = isRecord(message.kline)
    ? message.kline
    : isRecord(message.data)
      ? message.data
      : null;
  if (!payload) {
    return type === 'contract_kline_snapshot'
      ? {kind: 'ack'}
      : {kind: 'ignored'};
  }
  const frame = parseFrame(
    message,
    payload,
    normalizedSymbol,
    expectedInterval,
  );
  if (!frame) {
    return type === 'contract_kline_snapshot'
      ? {kind: 'ack'}
      : {kind: 'ignored'};
  }
  return {kind: 'frame', frame, subscriptionReady: true};
}

function sameBars(
  left: readonly ContractKline[],
  right: readonly ContractKline[],
) {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (
      a.openTime !== b.openTime ||
      a.open !== b.open ||
      a.high !== b.high ||
      a.low !== b.low ||
      a.close !== b.close ||
      a.volume !== b.volume
    ) {
      return false;
    }
  }
  return true;
}

function sameBar(
  left: ContractKline,
  right: ContractKline,
) {
  return (
    left.openTime === right.openTime &&
    left.open === right.open &&
    left.high === right.high &&
    left.low === right.low &&
    left.close === right.close &&
    left.volume === right.volume
  );
}

function mergeKlineHistoryRetainingCurrent(
  current: readonly ContractKline[],
  incoming: readonly ContractKline[],
  limit: number,
) {
  const byOpenTime = new Map<number, ContractKline>();
  for (const item of incoming) byOpenTime.set(item.openTime, item);
  for (const item of current) byOpenTime.set(item.openTime, item);
  return Array.from(byOpenTime.values())
    .sort((left, right) => left.openTime - right.openTime)
    .slice(-limit);
}

function compareFrameVersion(
  current: NativeKlineFrame,
  incoming: NativeKlineFrame,
) {
  if (current.provider !== incoming.provider) return 1;
  if (
    current.providerGeneration !== incoming.providerGeneration
  ) {
    return incoming.providerGeneration >
      current.providerGeneration
      ? 1
      : -1;
  }
  if (current.revision.epoch !== incoming.revision.epoch) {
    return incoming.revision.epoch > current.revision.epoch
      ? 1
      : -1;
  }
  if (
    current.revision.sequence !== incoming.revision.sequence
  ) {
    return incoming.revision.sequence >
      current.revision.sequence
      ? 1
      : -1;
  }
  if (
    current.revision.isClosed &&
    !incoming.revision.isClosed
  ) {
    return -1;
  }
  if (
    !current.revision.isClosed &&
    incoming.revision.isClosed
  ) {
    return 1;
  }
  return 0;
}

function historyNeedsRetry(result: ContractKlineHistoryResult) {
  return (
    result.retryable ||
    result.stale === true ||
    result.historyIncomplete
  );
}

function isDefinitiveEmptyHistory(
  result: ContractKlineHistoryResult,
) {
  return (
    result.items.length === 0 &&
    result.stale === false &&
    !result.historyIncomplete &&
    !result.retryable &&
    !result.providerErrorCode &&
    (result.historyTerminal === true ||
      (result.historyComplete === true &&
        result.hasMoreBefore === false))
  );
}

function isPermanentHistoryFailure(
  result: ContractKlineHistoryResult,
) {
  return (
    result.items.length === 0 &&
    Boolean(result.providerErrorCode) &&
    result.retryable === false
  );
}

export class ContractKlineRealtimeStore {
  private readonly symbol: string;
  private readonly interval: ContractKlineInterval;
  private readonly fetchHistory: NonNullable<
    ContractKlineRealtimeDependencies['fetchHistory']
  >;
  private readonly hub: ContractKlineHub;
  private readonly now: () => number;
  private readonly historyLimit: number;
  private readonly domainReadyTimeoutMs: number;
  private readonly domainSilenceTimeoutMs: number;
  private readonly historyRetryBaseMs: number;
  private readonly historyRetryMaxMs: number;
  private readonly restDisplayRefreshMs: number;
  private readonly renderThrottleMs: number;
  private readonly nativeRealtimeEnabled: boolean;
  private readonly listeners = new Set<() => void>();
  private readonly ownerCounts = new Map<string, number>();

  private state: ContractKlineRealtimeState;
  private generation = 0;
  private hubActive = false;
  private transportStatus: PublicWebSocketStatus = 'idle';
  private hubRelease: (() => void) | null = null;
  private historyController: AbortController | null = null;
  private historyRetryTimer: ReturnType<typeof setTimeout> | null =
    null;
  private domainReadyTimer: ReturnType<typeof setTimeout> | null =
    null;
  private domainSilenceTimer: ReturnType<typeof setTimeout> | null =
    null;
  private renderTimer: ReturnType<typeof setTimeout> | null = null;
  private historyRetryAttempt = 0;
  private domainReadyAttempt = 0;
  private domainSilenceEpoch = 0;
  private historyLoaded = false;
  private historyStable = false;
  private historyPermanentFailure = false;
  private reconcileRequested = false;
  private restItems: ContractKline[] = [];
  private readonly wsFrames = new Map<number, NativeKlineFrame>();
  private readonly pendingFrames = new Map<number, NativeKlineFrame>();
  private readonly versionsByTime = new Map<number, NativeKlineFrame>();
  private cursor: NativeKlineCursor | null = null;
  private lastRenderAtMs = 0;

  constructor(
    symbol: string,
    interval: string,
    dependencies: ContractKlineRealtimeDependencies = {},
  ) {
    const normalizedInterval =
      normalizeContractKlineInterval(interval);
    if (!normalizedInterval) {
      throw new Error(`Unsupported Contract Kline interval: ${interval}`);
    }
    this.symbol = normalizeSymbol(symbol);
    this.interval = normalizedInterval;
    this.fetchHistory =
      dependencies.fetchHistory || fetchContractKlineHistory;
    this.hub =
      dependencies.hub ||
      getContractMarketRealtimeStore(this.symbol);
    this.now = dependencies.now || Date.now;
    this.historyLimit = Math.max(
      1,
      Math.min(
        200,
        Math.floor(
          dependencies.historyLimit ??
            CONTRACT_KLINE_HISTORY_LIMIT,
        ),
      ),
    );
    this.domainReadyTimeoutMs =
      dependencies.domainReadyTimeoutMs ??
      CONTRACT_KLINE_DOMAIN_READY_TIMEOUT_MS;
    this.domainSilenceTimeoutMs =
      dependencies.domainSilenceTimeoutMs ??
      CONTRACT_KLINE_DOMAIN_SILENCE_TIMEOUT_MS;
    this.historyRetryBaseMs =
      dependencies.historyRetryBaseMs ??
      CONTRACT_KLINE_HISTORY_RETRY_BASE_MS;
    this.historyRetryMaxMs =
      dependencies.historyRetryMaxMs ??
      CONTRACT_KLINE_HISTORY_RETRY_MAX_MS;
    this.restDisplayRefreshMs =
      dependencies.restDisplayRefreshMs ??
      CONTRACT_KLINE_REST_DISPLAY_REFRESH_MS;
    this.renderThrottleMs =
      dependencies.renderThrottleMs ??
      CONTRACT_KLINE_RENDER_THROTTLE_MS;
    this.nativeRealtimeEnabled =
      NATIVE_KLINE_INTERVALS.has(this.interval);
    this.state = {
      symbol: this.symbol,
      interval: this.interval,
      items: [],
      loading: false,
      error: null,
      phase: 'idle',
      source: null,
      mode: this.nativeRealtimeEnabled ? 'NATIVE' : 'REST_ONLY',
      subscriptionReady: false,
      domainReady: false,
      gapDetected: false,
      sessionGeneration: 0,
      revision: 0,
    };
  }

  getSnapshot = () => this.state;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  acquire(owner: string) {
    const normalizedOwner = String(owner || '').trim();
    if (!normalizedOwner) {
      throw new Error('Contract Kline owner is required');
    }
    const wasInactive = this.activeOwnerCount() === 0;
    this.ownerCounts.set(
      normalizedOwner,
      (this.ownerCounts.get(normalizedOwner) || 0) + 1,
    );
    if (wasInactive) this.activate();

    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = this.ownerCounts.get(normalizedOwner) || 0;
      if (count <= 1) {
        this.ownerCounts.delete(normalizedOwner);
      } else {
        this.ownerCounts.set(normalizedOwner, count - 1);
      }
      if (this.activeOwnerCount() === 0) this.deactivate();
    };
  }

  destroy() {
    this.ownerCounts.clear();
    this.deactivate();
    this.listeners.clear();
  }

  isRetained() {
    return this.activeOwnerCount() > 0 || this.listeners.size > 0;
  }

  private activeOwnerCount() {
    let count = 0;
    for (const item of this.ownerCounts.values()) count += item;
    return count;
  }

  private activate() {
    const generation = ++this.generation;
    this.clearTimers();
    this.abortHistory();
    this.historyRetryAttempt = 0;
    this.domainReadyAttempt = 0;
    this.historyLoaded = false;
    this.historyStable = false;
    this.historyPermanentFailure = false;
    this.reconcileRequested = false;
    this.restItems = [...this.state.items];
    this.wsFrames.clear();
    this.pendingFrames.clear();
    this.hubActive = false;
    this.commit({
      ...this.state,
      loading: true,
      error: null,
      phase: 'bootstrapping',
      subscriptionReady: false,
      domainReady: false,
      gapDetected: false,
      sessionGeneration: generation,
    });
    if (!this.nativeRealtimeEnabled) {
      this.hubActive = true;
      this.requestHistory(generation);
      return;
    }
    const handlers: ContractKlineDomainHandlers = {
      onMessage: message => this.handleHubMessage(message),
      onStatusChange: status =>
        this.handleTransportStatus(status),
      onActiveChange: active =>
        this.handleHubActiveChange(active),
    };
    this.hubRelease = this.hub.acquireKlineDomain(
      `contract-kline:${this.symbol}:${this.interval}`,
      this.interval,
      handlers,
    );
    if (this.hubActive && !this.historyController) {
      this.requestHistory(generation);
    }
  }

  private deactivate() {
    this.generation += 1;
    const release = this.hubRelease;
    this.hubRelease = null;
    this.hubActive = false;
    release?.();
    this.clearTimers();
    this.abortHistory();
    if (
      this.state.phase !== 'paused' ||
      this.state.loading ||
      this.state.domainReady ||
      this.state.subscriptionReady
    ) {
      this.commit({
        ...this.state,
        loading: false,
        error: null,
        phase: 'paused',
        subscriptionReady: false,
        domainReady: false,
        sessionGeneration: this.generation,
      });
    }
  }

  private handleHubActiveChange(active: boolean) {
    if (this.activeOwnerCount() === 0) return;
    this.hubActive = active;
    if (!active) {
      this.clearHistoryRetryTimer();
      this.clearDomainReadyTimer();
      this.clearDomainSilenceTimer();
      this.clearRenderTimer();
      this.abortHistory();
      this.reconcileRequested = false;
      this.commit({
        ...this.state,
        loading: false,
        phase: 'suspended',
        subscriptionReady: false,
        domainReady: false,
      });
      return;
    }
    this.commit({
      ...this.state,
      loading: !this.historyLoaded,
      error: null,
      phase:
        this.transportStatus === 'reconnecting'
          ? 'reconnecting'
          : 'connecting',
      subscriptionReady: false,
      domainReady: false,
    });
    this.requestHistory(this.generation);
    if (this.transportStatus === 'open') {
      this.scheduleDomainReadyTimeout();
    }
  }

  private handleTransportStatus(status: PublicWebSocketStatus) {
    this.transportStatus = status;
    if (
      this.activeOwnerCount() === 0 ||
      !this.hubActive
    ) {
      return;
    }
    if (status === 'open') {
      this.domainReadyAttempt = 0;
      this.clearDomainSilenceTimer();
      this.commit({
        ...this.state,
        phase: 'connecting',
        subscriptionReady: false,
        domainReady: false,
      });
      this.scheduleDomainReadyTimeout();
      return;
    }
    if (status === 'connecting' || status === 'reconnecting') {
      this.clearDomainReadyTimer();
      this.clearDomainSilenceTimer();
      this.clearRenderTimer();
      this.commit({
        ...this.state,
        phase:
          status === 'reconnecting'
            ? 'reconnecting'
            : 'connecting',
        subscriptionReady: false,
        domainReady: false,
      });
      if (this.historyLoaded || status === 'reconnecting') {
        this.requestHistory(this.generation);
      }
      return;
    }
    if (status === 'stopped') {
      this.clearDomainReadyTimer();
      this.clearDomainSilenceTimer();
      this.clearRenderTimer();
      this.commit({
        ...this.state,
        phase: 'paused',
        subscriptionReady: false,
        domainReady: false,
      });
    }
  }

  private handleHubMessage(message: Record<string, unknown>) {
    if (
      this.activeOwnerCount() === 0 ||
      !this.hubActive
    ) {
      return;
    }
    const parsed = parseContractNativeKlineMessage(
      message,
      this.symbol,
      this.interval,
    );
    if (parsed.kind === 'ignored') return;
    if (parsed.kind === 'ack') {
      this.markSubscriptionUnavailable(true);
      return;
    }
    const acceptance = this.acceptNativeFrame(parsed.frame);
    if (!parsed.subscriptionReady) return;
    if (
      acceptance === 'accepted' ||
      acceptance === 'confirmed'
    ) {
      this.markNativeReady();
    } else {
      this.markSubscriptionUnavailable();
    }
  }

  private markSubscriptionUnavailable(forceDegrade = false) {
    if (this.state.domainReady && !forceDegrade) return;
    this.clearDomainReadyTimer();
    this.clearDomainSilenceTimer();
    if (
      !this.state.subscriptionReady ||
      this.state.phase !== 'degraded'
    ) {
      this.commit({
        ...this.state,
        phase: 'degraded',
        subscriptionReady: true,
        domainReady: false,
      });
    }
    if (!this.historyController) {
      this.scheduleRestDisplayRefresh();
    }
    this.scheduleDomainReadyTimeout();
  }

  private markNativeReady() {
    this.clearDomainReadyTimer();
    this.domainReadyAttempt = 0;
    this.scheduleDomainSilenceTimeout();
    if (this.historyStable && this.pendingFrames.size === 0) {
      this.clearHistoryRetryTimer();
    }
    if (
      this.state.subscriptionReady &&
      this.state.domainReady &&
      this.state.phase === 'live'
    ) {
      return;
    }
    this.commit({
      ...this.state,
      phase: 'live',
      subscriptionReady: true,
      domainReady: true,
      error: null,
    });
  }

  private acceptNativeFrame(
    frame: NativeKlineFrame,
    allowGap = false,
  ): NativeFrameAcceptance {
    const latestTime = this.latestVisibleOpenTime();
    const visibleAtFrameTime = this.mergedItems().some(
      item => item.openTime === frame.bar.openTime,
    );
    if (
      latestTime !== null &&
      frame.bar.openTime < latestTime &&
      !visibleAtFrameTime
    ) {
      return 'ignored';
    }
    const existing = this.versionsByTime.get(frame.bar.openTime);
    if (existing) {
      const order = compareFrameVersion(existing, frame);
      if (order < 0) return 'ignored';
      if (order === 0) {
        if (existing.fingerprint === frame.fingerprint) {
          if (!sameBars(this.state.items, this.mergedItems())) {
            this.queueRender(true);
          }
          return 'confirmed';
        }
        this.requestReconcile();
        return 'ignored';
      }
      if (
        existing.provider === frame.provider &&
        existing.providerGeneration === frame.providerGeneration &&
        existing.revision.epoch === frame.revision.epoch &&
        existing.revision.sequence === frame.revision.sequence &&
        !existing.revision.isClosed &&
        frame.revision.isClosed &&
        !sameBar(existing.bar, frame.bar)
      ) {
        this.requestReconcile();
        return 'ignored';
      }
      if (
        existing.revision.isClosed &&
        !frame.revision.isClosed
      ) {
        return 'ignored';
      }
    }
    if (!this.acceptsCursor(frame)) return 'ignored';

    const intervalMs = INTERVAL_MS[this.interval];
    if (
      !allowGap &&
      latestTime !== null &&
      frame.bar.openTime > latestTime + intervalMs
    ) {
      const pending = this.pendingFrames.get(frame.bar.openTime);
      if (
        !pending ||
        compareFrameVersion(pending, frame) > 0
      ) {
        this.pendingFrames.set(frame.bar.openTime, frame);
      }
      while (
        this.pendingFrames.size >
        CONTRACT_KLINE_PENDING_FRAME_LIMIT
      ) {
        const oldest = Array.from(this.pendingFrames.keys()).sort(
          (left, right) => left - right,
        )[0];
        this.pendingFrames.delete(oldest);
      }
      if (!this.state.gapDetected) {
        this.commit({...this.state, gapDetected: true});
      }
      this.requestReconcile();
      return 'buffered';
    }

    this.cursor = {
      provider: frame.provider,
      providerGeneration: frame.providerGeneration,
      revisionEpoch: frame.revision.epoch,
      revisionSequence: frame.revision.sequence,
      receivedAtMs: frame.receivedAtMs,
      openTime: frame.bar.openTime,
      fingerprint: frame.fingerprint,
      isClosed: frame.revision.isClosed,
    };
    this.versionsByTime.set(frame.bar.openTime, frame);
    this.wsFrames.set(frame.bar.openTime, frame);
    const immediate =
      latestTime === null ||
      frame.bar.openTime !== latestTime ||
      frame.revision.isClosed;
    this.queueRender(immediate);
    return 'accepted';
  }

  private acceptsCursor(frame: NativeKlineFrame) {
    const current = this.cursor;
    if (!current) return true;
    if (current.provider !== frame.provider) {
      return frame.receivedAtMs > current.receivedAtMs;
    }
    if (
      frame.providerGeneration !== current.providerGeneration
    ) {
      return (
        frame.providerGeneration > current.providerGeneration
      );
    }
    if (frame.revision.epoch !== current.revisionEpoch) {
      return frame.revision.epoch > current.revisionEpoch;
    }
    if (
      frame.revision.sequence !== current.revisionSequence
    ) {
      return (
        frame.revision.sequence >
        current.revisionSequence
      );
    }
    if (
      frame.receivedAtMs < current.receivedAtMs ||
      frame.bar.openTime !== current.openTime
    ) {
      return false;
    }
    return (
      frame.fingerprint === current.fingerprint ||
      (!current.isClosed &&
        frame.revision.isClosed &&
        frameFingerprint(frame.bar, false) === current.fingerprint)
    );
  }

  private latestVisibleOpenTime() {
    const items = this.mergedItems();
    return items.length
      ? items[items.length - 1].openTime
      : null;
  }

  private mergedItems() {
    const items = new Map<number, ContractKline>();
    for (const item of this.restItems) {
      items.set(item.openTime, item);
    }
    for (const frame of this.wsFrames.values()) {
      items.set(frame.bar.openTime, frame.bar);
    }
    return Array.from(items.values())
      .sort((left, right) => left.openTime - right.openTime)
      .slice(-this.historyLimit);
  }

  private queueRender(immediate: boolean) {
    if (immediate || this.renderThrottleMs <= 0) {
      this.clearRenderTimer();
      this.flushRender();
      return;
    }
    const elapsed = this.now() - this.lastRenderAtMs;
    if (elapsed >= this.renderThrottleMs) {
      this.flushRender();
      return;
    }
    if (this.renderTimer !== null) return;
    this.renderTimer = setTimeout(() => {
      this.renderTimer = null;
      this.flushRender();
    }, Math.max(0, this.renderThrottleMs - elapsed));
  }

  private flushRender() {
    if (
      this.activeOwnerCount() === 0 ||
      !this.hubActive
    ) {
      return;
    }
    this.lastRenderAtMs = this.now();
    const items = this.mergedItems();
    const minimumOpenTime = items[0]?.openTime ?? null;
    if (minimumOpenTime !== null) {
      for (const time of this.wsFrames.keys()) {
        if (time < minimumOpenTime) this.wsFrames.delete(time);
      }
      for (const time of this.versionsByTime.keys()) {
        if (time < minimumOpenTime) {
          this.versionsByTime.delete(time);
        }
      }
    }
    const hasWs = this.wsFrames.size > 0;
    const source = hasWs
      ? this.historyLoaded
        ? 'REST+WS_NATIVE'
        : 'WS_NATIVE'
      : this.historyLoaded
        ? 'REST'
        : null;
    const nextState: ContractKlineRealtimeState = {
      ...this.state,
      items,
      loading: false,
      error: null,
      phase: this.state.domainReady ? 'live' : this.state.phase,
      source,
      domainReady: this.state.domainReady,
    };
    if (
      sameBars(this.state.items, items) &&
      this.state.loading === nextState.loading &&
      this.state.error === nextState.error &&
      this.state.phase === nextState.phase &&
      this.state.source === nextState.source &&
      this.state.domainReady === nextState.domainReady
    ) {
      return;
    }
    this.commit(nextState);
  }

  private requestHistory(generation: number) {
    if (
      generation !== this.generation ||
      this.activeOwnerCount() === 0 ||
      !this.hubActive
    ) {
      return;
    }
    if (this.historyPermanentFailure) return;
    if (this.historyController) {
      this.reconcileRequested = true;
      return;
    }
    this.clearHistoryRetryTimer();
    const controller = new AbortController();
    this.historyController = controller;
    this.fetchHistory(
      this.symbol,
      this.interval,
      this.historyLimit,
      {signal: controller.signal},
    )
      .then(result => {
        if (
          generation !== this.generation ||
          controller.signal.aborted ||
          !this.hubActive
        ) {
          return;
        }
        const retry = historyNeedsRetry(result);
        const definitiveEmpty =
          isDefinitiveEmptyHistory(result);
        const permanentFailure =
          isPermanentHistoryFailure(result);
        this.historyPermanentFailure = permanentFailure;
        if (result.items.length > 0 || definitiveEmpty) {
          if (result.items.length > 0) {
            this.restItems = retry
              ? mergeKlineHistoryRetainingCurrent(
                  this.restItems,
                  result.items,
                  this.historyLimit,
                )
              : [...result.items];
          }
          this.historyLoaded = true;
          if (!retry) {
            this.historyStable = true;
            this.historyRetryAttempt = 0;
          }
          if (!retry) this.flushPendingFrames(true);
          const items = this.mergedItems();
          const hasWs = this.wsFrames.size > 0;
          this.commit({
            ...this.state,
            items,
            loading: false,
            error: null,
            phase: this.state.domainReady
              ? 'live'
              : this.phaseWhileRealtimeUnavailable(
                  retry || !this.nativeRealtimeEnabled
                    ? 'degraded'
                    : this.state.phase,
                ),
            source: hasWs ? 'REST+WS_NATIVE' : 'REST',
            gapDetected:
              this.pendingFrames.size > 0 ||
              (retry && this.state.gapDetected),
          });
        } else if (!this.state.items.length) {
          this.commit({
            ...this.state,
            loading: false,
            error: '合约 K线历史暂不可用',
            phase: this.phaseWhileRealtimeUnavailable('degraded'),
          });
        }
        if (
          !permanentFailure &&
          (retry || (!result.items.length && !definitiveEmpty))
        ) {
          this.scheduleHistoryRetry();
        } else if (
          !permanentFailure &&
          this.shouldUseRestDisplayFallback()
        ) {
          this.scheduleRestDisplayRefresh();
        } else {
          this.clearHistoryRetryTimer();
        }
      })
      .catch(error => {
        if (
          generation !== this.generation ||
          controller.signal.aborted ||
          !this.hubActive
        ) {
          return;
        }
        this.historyPermanentFailure = false;
        this.commit({
          ...this.state,
          loading: false,
          error: this.state.items.length
            ? null
            : error instanceof Error
              ? error.message
              : '合约 K线历史加载失败',
          phase: this.state.domainReady
            ? 'live'
            : this.phaseWhileRealtimeUnavailable('degraded'),
        });
        this.scheduleHistoryRetry();
      })
      .finally(() => {
        if (this.historyController === controller) {
          this.historyController = null;
        }
        if (
          this.reconcileRequested &&
          generation === this.generation &&
          this.hubActive
        ) {
          this.reconcileRequested = false;
          this.requestHistory(generation);
        }
      });
  }

  private requestReconcile() {
    if (
      this.activeOwnerCount() === 0 ||
      !this.hubActive
    ) {
      return;
    }
    this.requestHistory(this.generation);
  }

  private flushPendingFrames(allowGap: boolean) {
    if (!this.pendingFrames.size) return;
    const pending = Array.from(this.pendingFrames.values()).sort(
      (left, right) =>
        left.bar.openTime - right.bar.openTime ||
        left.revision.sequence - right.revision.sequence,
    );
    this.pendingFrames.clear();
    for (const frame of pending) {
      this.acceptNativeFrame(frame, allowGap);
    }
  }

  private scheduleHistoryRetry() {
    if (
      this.historyRetryTimer !== null ||
      this.historyPermanentFailure ||
      this.activeOwnerCount() === 0 ||
      !this.hubActive
    ) {
      return;
    }
    const delay = Math.min(
      this.historyRetryMaxMs,
      this.historyRetryBaseMs *
        2 ** this.historyRetryAttempt,
    );
    this.historyRetryAttempt = Math.min(
      this.historyRetryAttempt + 1,
      30,
    );
    const generation = this.generation;
    this.historyRetryTimer = setTimeout(() => {
      this.historyRetryTimer = null;
      this.requestHistory(generation);
    }, delay);
  }

  private shouldUseRestDisplayFallback() {
    return (
      !this.nativeRealtimeEnabled ||
      (!this.state.domainReady &&
        (this.state.subscriptionReady ||
          ((this.transportStatus === 'connecting' ||
            this.transportStatus === 'reconnecting') &&
            this.historyLoaded)))
    );
  }

  private phaseWhileRealtimeUnavailable(
    fallback: ContractKlineRealtimePhase,
  ): ContractKlineRealtimePhase {
    if (!this.nativeRealtimeEnabled) return fallback;
    if (this.transportStatus === 'reconnecting') {
      return 'reconnecting';
    }
    if (this.transportStatus === 'connecting') {
      return 'connecting';
    }
    return fallback;
  }

  private scheduleRestDisplayRefresh() {
    if (
      this.historyRetryTimer !== null ||
      this.historyPermanentFailure ||
      this.activeOwnerCount() === 0 ||
      !this.hubActive ||
      !this.shouldUseRestDisplayFallback()
    ) {
      return;
    }
    const generation = this.generation;
    this.historyRetryTimer = setTimeout(() => {
      this.historyRetryTimer = null;
      if (!this.shouldUseRestDisplayFallback()) return;
      this.requestHistory(generation);
    }, this.restDisplayRefreshMs);
  }

  private scheduleDomainReadyTimeout() {
    this.clearDomainReadyTimer();
    if (
      this.activeOwnerCount() === 0 ||
      !this.hubActive ||
      this.transportStatus !== 'open'
    ) {
      return;
    }
    const delay = Math.min(
      CONTRACT_KLINE_DOMAIN_READY_TIMEOUT_MAX_MS,
      this.domainReadyTimeoutMs *
        2 ** this.domainReadyAttempt,
    );
    const generation = this.generation;
    this.domainReadyTimer = setTimeout(() => {
      this.domainReadyTimer = null;
      if (
        generation !== this.generation ||
        this.activeOwnerCount() === 0 ||
        !this.hubActive ||
        this.transportStatus !== 'open' ||
        this.state.domainReady
      ) {
        return;
      }
      this.domainReadyAttempt = Math.min(
        this.domainReadyAttempt + 1,
        30,
      );
      this.commit({
        ...this.state,
        phase: 'degraded',
        subscriptionReady: this.state.subscriptionReady,
        domainReady: false,
      });
      this.hub.resubscribeKlineDomain(this.interval);
      // A REST fallback request that is already in flight is itself a fresh
      // reconciliation. Do not queue an immediate duplicate when the domain
      // timeout and fallback refresh expire in the same timer turn.
      if (!this.historyController) {
        this.requestReconcile();
      }
      this.scheduleDomainReadyTimeout();
    }, delay);
  }

  private scheduleDomainSilenceTimeout() {
    this.clearDomainSilenceTimer();
    if (
      !this.nativeRealtimeEnabled ||
      this.activeOwnerCount() === 0 ||
      !this.hubActive ||
      this.transportStatus !== 'open'
    ) {
      return;
    }
    const generation = this.generation;
    const silenceEpoch = this.domainSilenceEpoch;
    this.domainSilenceTimer = setTimeout(() => {
      this.domainSilenceTimer = null;
      if (
        generation !== this.generation ||
        silenceEpoch !== this.domainSilenceEpoch ||
        this.activeOwnerCount() === 0 ||
        !this.hubActive ||
        this.transportStatus !== 'open' ||
        !this.state.domainReady
      ) {
        return;
      }
      this.commit({
        ...this.state,
        phase: 'degraded',
        subscriptionReady: true,
        domainReady: false,
      });
      this.hub.resubscribeKlineDomain(this.interval);
      this.requestReconcile();
      if (!this.historyController) {
        this.scheduleRestDisplayRefresh();
      }
      this.scheduleDomainReadyTimeout();
    }, this.domainSilenceTimeoutMs);
  }

  private abortHistory() {
    this.historyController?.abort();
    this.historyController = null;
  }

  private clearTimers() {
    this.clearHistoryRetryTimer();
    this.clearDomainReadyTimer();
    this.clearDomainSilenceTimer();
    this.clearRenderTimer();
  }

  private clearHistoryRetryTimer() {
    if (this.historyRetryTimer === null) return;
    clearTimeout(this.historyRetryTimer);
    this.historyRetryTimer = null;
  }

  private clearDomainReadyTimer() {
    if (this.domainReadyTimer === null) return;
    clearTimeout(this.domainReadyTimer);
    this.domainReadyTimer = null;
  }

  private clearDomainSilenceTimer() {
    this.domainSilenceEpoch += 1;
    if (this.domainSilenceTimer === null) return;
    clearTimeout(this.domainSilenceTimer);
    this.domainSilenceTimer = null;
  }

  private clearRenderTimer() {
    if (this.renderTimer === null) return;
    clearTimeout(this.renderTimer);
    this.renderTimer = null;
  }

  private commit(nextState: ContractKlineRealtimeState) {
    this.state = {
      ...nextState,
      revision: this.state.revision + 1,
    };
    for (const listener of this.listeners) listener();
  }
}

export const CONTRACT_KLINE_REALTIME_STORE_CACHE_LIMIT = 24;

const contractKlineStores = new BoundedStoreCache<
  string,
  ContractKlineRealtimeStore
>(CONTRACT_KLINE_REALTIME_STORE_CACHE_LIMIT);

function contractKlineStoreKey(
  symbol: string,
  interval: ContractKlineInterval,
) {
  return `${normalizeSymbol(symbol)}:${interval}`;
}

export function getContractKlineRealtimeStore(
  symbol: string,
  interval: string,
) {
  const normalizedInterval =
    normalizeContractKlineInterval(interval);
  if (!normalizedInterval) {
    throw new Error(`Unsupported Contract Kline interval: ${interval}`);
  }
  const key = contractKlineStoreKey(symbol, normalizedInterval);
  return contractKlineStores.getOrCreate(
    key,
    () => new ContractKlineRealtimeStore(
      symbol,
      normalizedInterval,
    ),
  );
}

export function __resetContractKlineRealtimeStoresForTests() {
  contractKlineStores.clear();
}
