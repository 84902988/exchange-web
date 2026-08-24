import {API_BASE_URL} from '../config/env';
import {
  fetchSpotMarketView,
  hasUsableSpotExecutionDepth,
  normalizeSpotDepthPayload,
  normalizeSpotMarketViewPayload,
  normalizeSpotTickerPayload,
  normalizeSpotTradesPayload,
  type SpotMarketView,
  type SpotOrderBook,
  type SpotDisplayPricePrecisionSource,
  type SpotTicker,
  type SpotTrade,
} from '../api/spot';
import {
  ManagedPublicWebSocket,
  type PublicWebSocketStatus,
} from './managedPublicWebSocket';
import {BoundedStoreCache} from './boundedStoreCache';
import {shouldYieldRealtimeForMainTabTransition} from '../performance/mainTabTransitionBudget';

export type SpotMarketRealtimePhase =
  | 'idle'
  | 'bootstrapping'
  | 'connecting'
  | 'live'
  | 'reconnecting'
  | 'paused';

export type SpotMarketRealtimeState = {
  symbol: string;
  ticker: SpotTicker | null;
  depth: SpotOrderBook;
  trades: SpotTrade[];
  executable: boolean;
  executionBid: number | null;
  executionAsk: number | null;
  phase: SpotMarketRealtimePhase;
  source: 'REST' | 'WS' | null;
  error: string | null;
  updatedAtMs: number | null;
  executionObservedAtMs: number | null;
  executionExpiresAtMs: number | null;
  revision: number;
};

export type SpotExecutionAuthoritySnapshot = {
  active: boolean;
  executable: boolean;
  bid: number | null;
  ask: number | null;
  expiresAtMs: number | null;
};

export function isSpotExecutionAuthorityUsable(
  authority: SpotExecutionAuthoritySnapshot,
  nowMs = Date.now(),
) {
  return (
    authority.active &&
    authority.executable &&
    authority.expiresAtMs !== null &&
    authority.expiresAtMs > nowMs &&
    authority.bid !== null &&
    authority.ask !== null &&
    Number.isFinite(authority.bid) &&
    Number.isFinite(authority.ask) &&
    authority.bid > 0 &&
    authority.ask > 0 &&
    authority.ask >= authority.bid
  );
}

export type SpotRealtimeTransport = {
  start: () => void;
  stop: (reason?: string) => void;
  getStatus: () => PublicWebSocketStatus;
};

export type SpotRealtimeTransportHandlers = {
  onMessage: (data: string) => void;
  onStatusChange: (status: PublicWebSocketStatus) => void;
};

export type SpotMarketRealtimeDependencies = {
  fetchMarketView?: (symbol: string) => Promise<SpotMarketView>;
  createTransport?: (
    handlers: SpotRealtimeTransportHandlers,
  ) => SpotRealtimeTransport;
  now?: () => number;
  batchWindowMs?: number;
  executionTtlMs?: number;
};

type SpotRealtimeMessage = {
  type?: unknown;
  symbol?: unknown;
  server_time_ms?: unknown;
  market_view?: unknown;
  depth?: unknown;
  ticker?: unknown;
  trade?: unknown;
  freshness?: unknown;
};

type SpotDomainName = 'ticker' | 'depth' | 'trades';

type SpotDomainAuthority = {
  seen: boolean;
  observedAtMs: number | null;
  priority: number;
  freshnessRank: number;
  hasData: boolean;
};

type SpotDomainIncoming = Omit<SpotDomainAuthority, 'seen'>;

type SpotDomainDecision = {
  accepted: boolean;
  invalidateExecution: boolean;
};

type SpotExecutionReceiptEvidence = {
  tickerReceivedAtMs: number | null;
  depthReceivedAtMs: number | null;
};

type SpotExecutionDomainEvidence = {
  serverReceivedAtMs: number;
  clientReceivedAtMs: number;
};

type SpotDisplayPrecisionAuthority = {
  precision: number;
  source: SpotDisplayPricePrecisionSource;
  tickSize: number | null;
  rank: number;
};

const DEFAULT_BATCH_WINDOW_MS = 80;
// The backend currently guards Spot execution at 1.5s. Until the protocol
// exposes an age/TTL lease, keep a 250ms client safety margin.
const DEFAULT_EXECUTION_TTL_MS = 1_250;
const SPOT_CLOCK_CALIBRATION_SAMPLES = 2;
const SPOT_CLOCK_OFFSET_STABILITY_MS = 100;
const SPOT_CLOCK_OFFSET_JUMP_MS = 150;
// Android and physical-device clocks can stay consistently offset from the
// API clock. Calibrate that stable offset while keeping delayed/jumped frames
// fail-closed; execution age still comes from the server receipt timeline.
const SPOT_MAX_ABSOLUTE_CLOCK_SKEW_MS = 5 * 60 * 1_000;

function emptyDepth(symbol: string): SpotOrderBook {
  return {
    symbol,
    bids: [],
    asks: [],
    freshness: null,
    stale: false,
  };
}

function normalizeSymbol(value: unknown) {
  return String(value || '').trim().toUpperCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isCurrentRealtimeFreshness(value: unknown) {
  const freshness = String(value || '').trim().toUpperCase();
  return freshness !== 'STALE' &&
    freshness !== 'LAST_GOOD' &&
    freshness !== 'LAST_VALID' &&
    freshness !== 'MISSING';
}

function freshnessRank(value: unknown) {
  const freshness = String(value || '').trim().toUpperCase();
  if (freshness === 'LIVE') return 4;
  if (freshness === 'RECENT' || freshness === 'FRESH') return 3;
  if (!freshness || freshness === 'UNKNOWN') return 2;
  if (freshness === 'LAST_GOOD' || freshness === 'LAST_VALID') {
    return 1;
  }
  return 0;
}

function displayPrecisionSourceRank(source: SpotDisplayPricePrecisionSource) {
  if (source === 'display_price_precision') return 3;
  if (source === 'price_tick_size') return 2;
  if (source === 'price_precision') return 1;
  return 0;
}

function readObservedAtMs(payload: unknown) {
  if (!isRecord(payload)) return null;
  for (const key of [
    'event_time_ms',
    'received_at_ms',
    'updated_at_ms',
    'ts',
    'time',
    'updated_at',
    'created_at',
    'fetched_at',
  ]) {
    const value = payload[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      if (value <= 0) continue;
      return value < 10_000_000_000 ? value * 1000 : value;
    }
    if (typeof value === 'string' && value.trim()) {
      const numeric = Number(value);
      if (Number.isFinite(numeric) && numeric > 0) {
        return numeric < 10_000_000_000
          ? numeric * 1000
          : numeric;
      }
      const text = value.trim();
      const normalizedText = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)
        ? text
        : `${text}Z`;
      const parsed = Date.parse(normalizedText);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
  }
  return null;
}

function readTimestampField(payload: unknown, key: string) {
  if (!isRecord(payload)) return null;
  const value = payload[key];
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value <= 0) return null;
    return value < 10_000_000_000 ? value * 1000 : value;
  }
  if (typeof value !== 'string' || !value.trim()) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    if (numeric <= 0) return null;
    return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  }
  const text = value.trim();
  const normalizedText = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)
    ? text
    : `${text}Z`;
  const parsed = Date.parse(normalizedText);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function readExecutionReceivedAtMs(
  payload: unknown,
  domain: 'ticker' | 'depth',
) {
  const receivedAtMs = readTimestampField(payload, 'received_at_ms');
  if (receivedAtMs !== null || domain === 'ticker') {
    return receivedAtMs;
  }
  return readTimestampField(payload, 'fetched_at');
}

function readMarketViewExecutionReceiptEvidence(
  payload: unknown,
): SpotExecutionReceiptEvidence {
  const root = isRecord(payload) ? payload : {};
  return {
    tickerReceivedAtMs: readExecutionReceivedAtMs(
      root.ticker,
      'ticker',
    ),
    depthReceivedAtMs: readExecutionReceivedAtMs(
      root.depth,
      'depth',
    ),
  };
}

function tradeTimeMs(trade: SpotTrade) {
  const value = trade.ts;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 0 && value < 10_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return numeric > 0 && numeric < 10_000_000_000
        ? numeric * 1000
        : numeric;
    }
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function hasUsableSpotExecutionTicker(ticker: SpotTicker | null) {
  const freshness = String(ticker?.freshness || '').toUpperCase();
  return (
    ticker !== null &&
    ticker.stale !== true &&
    ticker.marketStatus === 'OPEN' &&
    (freshness === 'LIVE' || freshness === 'RECENT')
  );
}

function mergeSpotTrades(
  current: SpotTrade[],
  incoming: SpotTrade[],
) {
  const byId = new Map<string, SpotTrade>();
  for (const trade of [...current, ...incoming]) {
    const existing = byId.get(trade.id);
    if (!existing || tradeTimeMs(trade) >= tradeTimeMs(existing)) {
      byId.set(trade.id, trade);
    }
  }
  return Array.from(byId.values())
    .sort((left, right) => tradeTimeMs(right) - tradeTimeMs(left))
    .slice(0, 30);
}

export function buildSpotMarketWsUrl(symbol: string) {
  const base = API_BASE_URL.replace(/\/+$/, '');
  const websocketBase = base.startsWith('https:')
    ? `wss:${base.slice('https:'.length)}`
    : base.startsWith('http:')
      ? `ws:${base.slice('http:'.length)}`
      : base;
  return `${websocketBase}/market/ws/spot?symbol=${encodeURIComponent(
    normalizeSymbol(symbol),
  )}`;
}

export class SpotMarketRealtimeStore {
  private readonly symbol: string;
  private readonly fetchMarketView: (
    symbol: string,
  ) => Promise<SpotMarketView>;
  private readonly now: () => number;
  private readonly batchWindowMs: number;
  private readonly executionTtlMs: number;
  private readonly transport: SpotRealtimeTransport;
  private readonly listeners = new Set<() => void>();
  private readonly ownerCounts = new Map<string, number>();

  private state: SpotMarketRealtimeState;
  private pendingState: SpotMarketRealtimeState | null = null;
  private batchTimer: ReturnType<typeof setTimeout> | null = null;
  private executionExpiryTimer: ReturnType<typeof setTimeout> | null =
    null;
  private displayPrecisionAuthority: SpotDisplayPrecisionAuthority | null =
    null;
  private generation = 0;
  private hasCurrentTransportDepth = false;
  private executionDomainReceivedAtMs: {
    ticker: number | null;
    depth: number | null;
  } = {
    ticker: null,
    depth: null,
  };
  private executionDomainEvidence: Record<
    'ticker' | 'depth',
    SpotExecutionDomainEvidence | null
  > = {
    ticker: null,
    depth: null,
  };
  private serverClockOffsetMs: number | null = null;
  private serverClockStableSamples = 0;
  private serverClockLastSampleTimeMs: number | null = null;
  private serverClockCandidateOffsetMs: number | null = null;
  private serverClockCandidateSamples = 0;
  private readonly domainAuthority: Record<
    SpotDomainName,
    SpotDomainAuthority
  > = {
    ticker: {
      seen: false,
      observedAtMs: null,
      priority: 0,
      freshnessRank: 0,
      hasData: false,
    },
    depth: {
      seen: false,
      observedAtMs: null,
      priority: 0,
      freshnessRank: 0,
      hasData: false,
    },
    trades: {
      seen: false,
      observedAtMs: null,
      priority: 0,
      freshnessRank: 0,
      hasData: false,
    },
  };

  constructor(
    symbol: string,
    dependencies: SpotMarketRealtimeDependencies = {},
  ) {
    this.symbol = normalizeSymbol(symbol);
    this.fetchMarketView =
      dependencies.fetchMarketView || fetchSpotMarketView;
    this.now = dependencies.now || Date.now;
    this.batchWindowMs =
      dependencies.batchWindowMs ?? DEFAULT_BATCH_WINDOW_MS;
    this.executionTtlMs =
      dependencies.executionTtlMs ?? DEFAULT_EXECUTION_TTL_MS;
    this.state = {
      symbol: this.symbol,
      ticker: null,
      depth: emptyDepth(this.symbol),
      trades: [],
      executable: false,
      executionBid: null,
      executionAsk: null,
      phase: 'idle',
      source: null,
      error: null,
      updatedAtMs: null,
      executionObservedAtMs: null,
      executionExpiresAtMs: null,
      revision: 0,
    };

    const handlers: SpotRealtimeTransportHandlers = {
      onMessage: data => this.handleTransportMessage(data),
      onStatusChange: status =>
        this.handleTransportStatusChange(status),
    };
    this.transport = dependencies.createTransport
      ? dependencies.createTransport(handlers)
      : new ManagedPublicWebSocket({
          url: buildSpotMarketWsUrl(this.symbol),
          onMessage: handlers.onMessage,
          onStatusChange: handlers.onStatusChange,
        });
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
      throw new Error('Spot realtime owner is required');
    }
    const wasInactive = this.activeOwnerCount() === 0;
    this.ownerCounts.set(
      normalizedOwner,
      (this.ownerCounts.get(normalizedOwner) || 0) + 1,
    );
    if (wasInactive) {
      this.activate();
    }

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
      if (this.activeOwnerCount() === 0) {
        this.deactivate();
      }
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
    for (const ownerCount of this.ownerCounts.values()) {
      count += ownerCount;
    }
    return count;
  }

  private activate() {
    const generation = ++this.generation;
    this.resetExecutionAuthority();
    this.commit({
      ...this.state,
      phase: 'bootstrapping',
      executable: false,
      executionBid: null,
      executionAsk: null,
      executionObservedAtMs: null,
      executionExpiresAtMs: null,
      error: null,
    });
    this.transport.start();
    this.bootstrap(generation);
  }

  private async bootstrap(generation: number) {
    try {
      const view = await this.fetchMarketView(this.symbol);
      if (!this.isActiveGeneration(generation)) return;
      this.applyMarketView(view, 'REST');
    } catch (error) {
      if (!this.isActiveGeneration(generation)) return;
      this.commit({
        ...this.state,
        error:
          error instanceof Error
            ? error.message
            : '现货行情快照加载失败',
      });
    }
  }

  private deactivate() {
    this.generation += 1;
    this.resetExecutionAuthority();
    this.transport.stop('spot market screen inactive');
    this.clearBatch();
    this.clearExecutionExpiry();
    this.commit({
      ...this.state,
      phase: 'paused',
      executable: false,
      executionBid: null,
      executionAsk: null,
      executionObservedAtMs: null,
      executionExpiresAtMs: null,
    });
  }

  private isActiveGeneration(generation: number) {
    return (
      generation === this.generation && this.activeOwnerCount() > 0
    );
  }

  private acceptDomain(
    domain: SpotDomainName,
    incoming: SpotDomainIncoming,
  ): SpotDomainDecision {
    const current = this.domainAuthority[domain];
    const rejected = (
      invalidateExecution = false,
    ): SpotDomainDecision => ({
      accepted: false,
      invalidateExecution,
    });
    const advance = () => {
      this.domainAuthority[domain] = {
        ...incoming,
        seen: true,
      };
    };
    const accepted = (): SpotDomainDecision => {
      advance();
      return {accepted: true, invalidateExecution: false};
    };
    const degraded = (
      invalidateExecution = true,
    ): SpotDomainDecision => {
      advance();
      return {accepted: false, invalidateExecution};
    };

    if (!current.seen) {
      if (!incoming.hasData || incoming.freshnessRank < 3) {
        return degraded();
      }
      return accepted();
    }
    if (
      current.observedAtMs !== null &&
      incoming.observedAtMs === null
    ) {
      return rejected(
        !incoming.hasData || incoming.freshnessRank < 3,
      );
    }
    let incomingIsNewer = false;
    if (
      current.observedAtMs !== null &&
      incoming.observedAtMs !== null
    ) {
      if (incoming.observedAtMs < current.observedAtMs) {
        return rejected();
      }
      incomingIsNewer =
        incoming.observedAtMs > current.observedAtMs;
    } else if (
      current.observedAtMs === null &&
      incoming.observedAtMs !== null
    ) {
      incomingIsNewer = true;
    }

    if (!incomingIsNewer && incoming.priority < current.priority) {
      return rejected();
    }

    if (
      !incomingIsNewer &&
      (!current.hasData || current.freshnessRank < 3) &&
      incoming.hasData &&
      incoming.freshnessRank >= 3
    ) {
      // A degraded authority is sticky at the same high-water. Recovery
      // requires newer evidence, not a reordered duplicate of the revoked
      // event.
      return rejected();
    }

    if (
      !incoming.hasData ||
      incoming.freshnessRank < 3
    ) {
      return degraded();
    }
    if (
      !incomingIsNewer &&
      incoming.freshnessRank < current.freshnessRank
    ) {
      return rejected();
    }
    return accepted();
  }

  private revokeExecutionAtDomainHighWater(
    domain: 'ticker' | 'depth',
    observedAtMs: number | null,
    priority: number,
  ) {
    const current = this.domainAuthority[domain];
    const revocationObservedAtMs =
      observedAtMs !== null &&
      (current.observedAtMs === null ||
        observedAtMs > current.observedAtMs)
        ? observedAtMs
        : current.observedAtMs;
    this.domainAuthority[domain] = {
      seen: true,
      observedAtMs: revocationObservedAtMs,
      priority: Math.max(current.priority, priority),
      freshnessRank: 0,
      hasData: false,
    };
  }

  private handleTransportStatusChange(status: PublicWebSocketStatus) {
    if (this.activeOwnerCount() === 0) return;
    this.flushPending();
    if (status === 'open') {
      this.commit({...this.state, phase: 'live'});
      return;
    }
    if (status === 'connecting') {
      this.invalidateExecution('connecting');
      return;
    }
    if (status === 'reconnecting') {
      this.invalidateExecution('reconnecting');
      return;
    }
    if (status === 'stopped') {
      this.invalidateExecution('paused');
    }
  }

  private invalidateExecution(phase: SpotMarketRealtimePhase) {
    this.flushPending();
    this.resetExecutionAuthority();
    this.clearExecutionExpiry();
    this.commit({
      ...this.state,
      phase,
      executable: false,
      executionBid: null,
      executionAsk: null,
      executionObservedAtMs: null,
      executionExpiresAtMs: null,
    });
  }

  private resetExecutionAuthority() {
    this.hasCurrentTransportDepth = false;
    this.executionDomainEvidence.ticker = null;
    this.executionDomainEvidence.depth = null;
    this.executionDomainReceivedAtMs.ticker = null;
    this.executionDomainReceivedAtMs.depth = null;
    this.resetServerClockCalibration();
  }

  private clearExecutionDomain(domain: 'ticker' | 'depth') {
    this.executionDomainEvidence[domain] = null;
    this.executionDomainReceivedAtMs[domain] = null;
    if (domain === 'depth') {
      this.hasCurrentTransportDepth = false;
    }
  }

  private recordExecutionReceipt(
    domain: 'ticker' | 'depth',
    serverReceivedAtMs: number | null,
    serverEnvelopeTimeMs: number | null,
    clientReceivedAtMs: number,
  ) {
    if (
      serverReceivedAtMs === null ||
      !Number.isFinite(serverReceivedAtMs) ||
      serverReceivedAtMs <= 0 ||
      (serverEnvelopeTimeMs !== null &&
        (serverReceivedAtMs > serverEnvelopeTimeMs ||
          serverEnvelopeTimeMs - serverReceivedAtMs >=
            this.executionTtlMs))
    ) {
      this.clearExecutionDomain(domain);
      return;
    }
    this.executionDomainEvidence[domain] = {
      serverReceivedAtMs,
      clientReceivedAtMs,
    };
    if (
      serverEnvelopeTimeMs !== null &&
      !this.observeServerClock(
        serverEnvelopeTimeMs,
        clientReceivedAtMs,
      )
    ) {
      this.clearExecutionDomain(domain);
      return;
    }
    this.refreshExecutionReceiptTimeline();
  }

  private observeServerClock(
    serverReceivedAtMs: number,
    clientReceivedAtMs: number,
  ) {
    const observedOffsetMs = clientReceivedAtMs - serverReceivedAtMs;
    if (
      !Number.isFinite(observedOffsetMs) ||
      Math.abs(observedOffsetMs) > SPOT_MAX_ABSOLUTE_CLOCK_SKEW_MS
    ) {
      this.resetServerClockCalibration();
      return false;
    }

    if (
      this.serverClockLastSampleTimeMs !== null &&
      serverReceivedAtMs <= this.serverClockLastSampleTimeMs
    ) {
      return true;
    }
    this.serverClockLastSampleTimeMs = serverReceivedAtMs;

    if (this.serverClockOffsetMs === null) {
      this.serverClockOffsetMs = observedOffsetMs;
      this.serverClockStableSamples = 1;
      this.refreshExecutionReceiptTimeline();
      return true;
    }

    const deltaMs = observedOffsetMs - this.serverClockOffsetMs;
    if (deltaMs < -SPOT_CLOCK_OFFSET_STABILITY_MS) {
      this.serverClockOffsetMs = observedOffsetMs;
      this.serverClockStableSamples = 1;
      this.serverClockCandidateOffsetMs = null;
      this.serverClockCandidateSamples = 0;
      this.refreshExecutionReceiptTimeline();
      return true;
    }

    if (deltaMs > SPOT_CLOCK_OFFSET_JUMP_MS) {
      if (
        this.serverClockCandidateOffsetMs === null ||
        Math.abs(observedOffsetMs - this.serverClockCandidateOffsetMs) >
          SPOT_CLOCK_OFFSET_STABILITY_MS
      ) {
        this.serverClockCandidateOffsetMs = observedOffsetMs;
        this.serverClockCandidateSamples = 1;
      } else {
        this.serverClockCandidateOffsetMs = Math.min(
          this.serverClockCandidateOffsetMs,
          observedOffsetMs,
        );
        this.serverClockCandidateSamples += 1;
      }
      if (
        this.serverClockCandidateSamples >=
        SPOT_CLOCK_CALIBRATION_SAMPLES
      ) {
        this.serverClockOffsetMs = this.serverClockCandidateOffsetMs;
        this.serverClockStableSamples = 1;
        this.serverClockCandidateOffsetMs = null;
        this.serverClockCandidateSamples = 0;
      }
      this.refreshExecutionReceiptTimeline();
      return true;
    }

    this.serverClockCandidateOffsetMs = null;
    this.serverClockCandidateSamples = 0;
    if (Math.abs(deltaMs) <= SPOT_CLOCK_OFFSET_STABILITY_MS) {
      this.serverClockOffsetMs = Math.min(
        this.serverClockOffsetMs,
        observedOffsetMs,
      );
      this.serverClockStableSamples = Math.min(
        SPOT_CLOCK_CALIBRATION_SAMPLES,
        this.serverClockStableSamples + 1,
      );
    }
    this.refreshExecutionReceiptTimeline();
    return true;
  }

  private refreshExecutionReceiptTimeline() {
    const calibrated =
      this.serverClockOffsetMs !== null &&
      this.serverClockStableSamples >= SPOT_CLOCK_CALIBRATION_SAMPLES &&
      this.serverClockCandidateOffsetMs === null;
    for (const domain of ['ticker', 'depth'] as const) {
      const evidence = this.executionDomainEvidence[domain];
      if (!calibrated || !evidence) {
        this.executionDomainReceivedAtMs[domain] =
          evidence &&
          this.isExecutionReceiptCurrent(
            evidence.serverReceivedAtMs,
            evidence.clientReceivedAtMs,
          )
            ? evidence.serverReceivedAtMs
            : null;
        continue;
      }
      this.executionDomainReceivedAtMs[domain] = Math.min(
        evidence.serverReceivedAtMs + this.serverClockOffsetMs!,
        evidence.clientReceivedAtMs,
      );
    }
  }

  private resetServerClockCalibration() {
    this.serverClockOffsetMs = null;
    this.serverClockStableSamples = 0;
    this.serverClockLastSampleTimeMs = null;
    this.serverClockCandidateOffsetMs = null;
    this.serverClockCandidateSamples = 0;
    this.executionDomainReceivedAtMs.ticker = null;
    this.executionDomainReceivedAtMs.depth = null;
  }

  private getExecutionAuthority(
    ticker: SpotTicker | null,
    depth: SpotOrderBook,
    requireOpenTransport = true,
  ) {
    const now = this.now();
    const tickerAt = this.executionDomainReceivedAtMs.ticker;
    const depthAt = this.executionDomainReceivedAtMs.depth;
    const observedAt =
      tickerAt !== null && depthAt !== null
        ? Math.min(tickerAt, depthAt)
        : null;
    const domainsCurrent =
      this.isExecutionReceiptCurrent(tickerAt, now) &&
      this.isExecutionReceiptCurrent(depthAt, now);
    const executable =
      domainsCurrent &&
      (!requireOpenTransport ||
        this.transport.getStatus() === 'open') &&
      this.hasCurrentTransportDepth &&
      hasUsableSpotExecutionTicker(ticker) &&
      hasUsableSpotExecutionDepth(
        depth,
        ticker?.marketStatus,
      );
    return {
      executable,
      observedAt: executable ? observedAt : null,
      expiresAt:
        executable && observedAt !== null
          ? observedAt + this.executionTtlMs
          : null,
    };
  }

  private isExecutionReceiptCurrent(
    receivedAtMs: number | null,
    nowMs = this.now(),
  ) {
    return (
      receivedAtMs !== null &&
      receivedAtMs > 0 &&
      receivedAtMs <= nowMs &&
      nowMs < receivedAtMs + this.executionTtlMs
    );
  }

  private handleTransportMessage(data: string) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    if (!isRecord(parsed)) return;
    const message = parsed as SpotRealtimeMessage;
    if (normalizeSymbol(message.symbol) !== this.symbol) return;

    const type = String(message.type || '').trim();
    if (
      shouldYieldRealtimeForMainTabTransition() &&
      (type === 'spot_depth_update' ||
        type === 'spot_ticker_update' ||
        type === 'spot_trade')
    ) {
      return;
    }
    try {
      const stampedServerTimeMs = readTimestampField(
        message,
        'server_time_ms',
      );
      if (type === 'spot_market_snapshot') {
        const view = normalizeSpotMarketViewPayload(
          message.market_view,
          this.symbol,
        );
        const receiptEvidence =
          readMarketViewExecutionReceiptEvidence(
            message.market_view,
          );
        this.flushPending();
        this.applyMarketView(
          view,
          'WS',
          receiptEvidence,
          stampedServerTimeMs ??
            readTimestampField(message.market_view, 'updated_at'),
        );
        return;
      }
      if (type === 'spot_depth_update') {
        this.applyDepthUpdate(
          message.depth,
          stampedServerTimeMs ??
            readExecutionReceivedAtMs(message.depth, 'depth'),
        );
        return;
      }
      if (type === 'spot_ticker_update') {
        this.applyTickerUpdate(
          message.ticker,
          stampedServerTimeMs ??
            readExecutionReceivedAtMs(message.ticker, 'ticker'),
        );
        return;
      }
      if (type === 'spot_trade') {
        this.applyTradeUpdate(message);
      }
    } catch {
      // A malformed or cross-symbol frame must not replace last-good state.
    }
  }

  private stabilizeTickerDisplayPrecision(ticker: SpotTicker) {
    const source =
      ticker.displayPricePrecisionSource ?? 'price_precision';
    const rank = displayPrecisionSourceRank(source);
    const incomingPrecision =
      ticker.displayPricePrecision ?? ticker.pricePrecision;
    if (
      Number.isInteger(incomingPrecision) &&
      incomingPrecision >= 0 &&
      incomingPrecision <= 18 &&
      (this.displayPrecisionAuthority === null ||
        rank >= this.displayPrecisionAuthority.rank)
    ) {
      this.displayPrecisionAuthority = {
        precision: incomingPrecision,
        rank,
        source,
        tickSize:
          ticker.priceTickSize !== null &&
          ticker.priceTickSize !== undefined &&
          Number.isFinite(ticker.priceTickSize) &&
          ticker.priceTickSize > 0
            ? ticker.priceTickSize
            : null,
      };
    }
    const authority = this.displayPrecisionAuthority;
    if (!authority) return ticker;
    return {
      ...ticker,
      displayPricePrecision: authority.precision,
      displayPricePrecisionSource: authority.source,
      priceTickSize: authority.tickSize,
    };
  }

  private applyMarketView(
    view: SpotMarketView,
    source: 'REST' | 'WS',
    receiptEvidence?: SpotExecutionReceiptEvidence,
    serverEnvelopeTimeMs: number | null = null,
  ) {
    if (view.symbol !== this.symbol) return;
    this.flushPending();
    const stableViewTicker = this.stabilizeTickerDisplayPrecision(view.ticker);
    const now = this.now();
    const priority = source === 'WS' ? 2 : 1;
    const tickerDecision = this.acceptDomain('ticker', {
      observedAtMs: view.tickerObservedAtMs,
      priority,
      freshnessRank: freshnessRank(view.ticker.freshness),
      hasData: stableViewTicker.lastPrice !== null,
    });
    const depthDecision = this.acceptDomain('depth', {
      observedAtMs: view.depthObservedAtMs,
      priority,
      freshnessRank: freshnessRank(view.depth.freshness),
      hasData:
        view.depth.bids.length > 0 || view.depth.asks.length > 0,
    });
    const tradesDecision = this.acceptDomain('trades', {
      observedAtMs: view.tradesObservedAtMs,
      priority,
      freshnessRank: freshnessRank(view.tradesFreshness),
      hasData: view.trades.length > 0,
    });
    const snapshotRevokesExecution =
      source === 'WS' && !view.executable;
    if (snapshotRevokesExecution) {
      this.resetExecutionAuthority();
      this.revokeExecutionAtDomainHighWater(
        'ticker',
        view.tickerObservedAtMs,
        priority,
      );
      this.revokeExecutionAtDomainHighWater(
        'depth',
        view.depthObservedAtMs,
        priority,
      );
    }

    const acceptedTicker = tickerDecision.accepted
      ? stableViewTicker
      : this.state.ticker
      ? {
          ...this.state.ticker,
          // Execution limits are instrument configuration, not
          // time-series quote data. A socket ticker can legitimately win
          // the quote high-water before the REST bootstrap returns, but
          // socket increments do not carry these limits. Merge the
          // validated, symbol-matched snapshot rules without letting an
          // older snapshot replace the newer price.
          minAmount:
            stableViewTicker.minAmount ??
            this.state.ticker.minAmount ??
            null,
          minNotional:
            stableViewTicker.minNotional ??
            this.state.ticker.minNotional ??
            null,
        }
      : this.state.ticker;
    const nextTicker = acceptedTicker
      ? this.stabilizeTickerDisplayPrecision(acceptedTicker)
      : null;
    const nextDepth = depthDecision.accepted
      ? view.depth
      : this.state.depth;

    if (tickerDecision.invalidateExecution) {
      this.clearExecutionDomain('ticker');
    }
    if (depthDecision.invalidateExecution) {
      this.clearExecutionDomain('depth');
    }
    if (tickerDecision.accepted) {
      const receivedAtMs =
        receiptEvidence?.tickerReceivedAtMs ?? null;
      if (
        source === 'WS' &&
        view.executable &&
        hasUsableSpotExecutionTicker(stableViewTicker)
      ) {
        this.recordExecutionReceipt(
          'ticker',
          receivedAtMs,
          serverEnvelopeTimeMs,
          now,
        );
      } else {
        this.clearExecutionDomain('ticker');
      }
    }
    if (depthDecision.accepted) {
      const receivedAtMs =
        receiptEvidence?.depthReceivedAtMs ?? null;
      if (
        source === 'WS' &&
        view.executable &&
        hasUsableSpotExecutionDepth(
          view.depth,
          nextTicker?.marketStatus,
        )
      ) {
        this.recordExecutionReceipt(
          'depth',
          receivedAtMs,
          serverEnvelopeTimeMs,
          now,
        );
        this.hasCurrentTransportDepth = true;
      } else {
        this.clearExecutionDomain('depth');
      }
    }

    const marketDomainChanged =
      tickerDecision.accepted ||
      depthDecision.accepted ||
      tickerDecision.invalidateExecution ||
      depthDecision.invalidateExecution ||
      snapshotRevokesExecution;
    let executable = this.state.executable;
    let authority = this.getExecutionAuthority(
      nextTicker,
      nextDepth,
    );
    if (snapshotRevokesExecution) {
      executable = false;
    } else if (marketDomainChanged) {
      executable =
        source === 'WS' &&
        view.executable &&
        authority.executable;
    }
    if (!executable) {
      authority = {
        executable: false,
        observedAt: null,
        expiresAt: null,
      };
    }

    const marketDisplayChanged =
      tickerDecision.accepted || depthDecision.accepted;
    this.commit({
      ...this.state,
      ticker: nextTicker,
      depth: nextDepth,
      trades: tradesDecision.accepted
        ? mergeSpotTrades(this.state.trades, view.trades)
        : this.state.trades,
      executable,
      executionBid: executable
        ? nextDepth.bids[0]?.price ?? null
        : null,
      executionAsk: executable
        ? nextDepth.asks[0]?.price ?? null
        : null,
      source: marketDisplayChanged ? source : this.state.source,
      error: null,
      updatedAtMs:
        marketDisplayChanged || tradesDecision.accepted
        ? now
        : this.state.updatedAtMs,
      executionObservedAtMs: authority.observedAt,
      executionExpiresAtMs: authority.expiresAt,
    });
  }

  private applyDepthUpdate(
    payload: unknown,
    serverEnvelopeTimeMs: number | null,
  ) {
    const depth = normalizeSpotDepthPayload(payload, this.symbol);
    if (depth.symbol !== this.symbol) return;
    const observedAt = readObservedAtMs(payload);
    const decision = this.acceptDomain('depth', {
      observedAtMs: observedAt,
      priority: 3,
      freshnessRank: freshnessRank(depth.freshness),
      hasData: depth.bids.length > 0 || depth.asks.length > 0,
    });
    if (!decision.accepted) {
      if (decision.invalidateExecution) {
        this.invalidateExecution(this.state.phase);
      }
      return;
    }
    const base = this.pendingState || this.state;
    const now = this.now();
    const receivedAtMs = readExecutionReceivedAtMs(
      payload,
      'depth',
    );
    if (
      hasUsableSpotExecutionDepth(
        depth,
        base.ticker?.marketStatus,
      )
    ) {
      this.recordExecutionReceipt(
        'depth',
        receivedAtMs,
        serverEnvelopeTimeMs,
        now,
      );
      this.hasCurrentTransportDepth = true;
    } else {
      this.clearExecutionDomain('depth');
    }
    const authority = this.getExecutionAuthority(
      base.ticker,
      depth,
    );
    this.queueState({
      ...base,
      depth,
      executable: authority.executable,
      executionBid: authority.executable
        ? depth.bids[0]?.price ?? null
        : null,
      executionAsk: authority.executable
        ? depth.asks[0]?.price ?? null
        : null,
      source: 'WS',
      updatedAtMs: now,
      executionObservedAtMs: authority.observedAt,
      executionExpiresAtMs: authority.expiresAt,
    });
  }

  private applyTickerUpdate(
    payload: unknown,
    serverEnvelopeTimeMs: number | null,
  ) {
    const normalizedTicker = normalizeSpotTickerPayload(payload, this.symbol);
    if (!normalizedTicker || normalizedTicker.symbol !== this.symbol) return;
    const ticker = this.stabilizeTickerDisplayPrecision(normalizedTicker);
    const observedAt = readObservedAtMs(payload);
    const decision = this.acceptDomain('ticker', {
      observedAtMs: observedAt,
      priority: 3,
      freshnessRank: freshnessRank(ticker.freshness),
      hasData: ticker.lastPrice !== null,
    });
    if (!decision.accepted) {
      if (decision.invalidateExecution) {
        this.invalidateExecution(this.state.phase);
      }
      return;
    }
    const base = this.pendingState || this.state;
    const mergedTicker: SpotTicker = {
      ...base.ticker,
      ...ticker,
      high24h: ticker.high24h ?? base.ticker?.high24h ?? null,
      low24h: ticker.low24h ?? base.ticker?.low24h ?? null,
      baseVolume24h:
        ticker.baseVolume24h ?? base.ticker?.baseVolume24h ?? null,
      quoteVolume24h:
        ticker.quoteVolume24h ?? base.ticker?.quoteVolume24h ?? null,
      minAmount: ticker.minAmount ?? base.ticker?.minAmount ?? null,
      minNotional: ticker.minNotional ?? base.ticker?.minNotional ?? null,
      marketStatus:
        ticker.marketStatus || base.ticker?.marketStatus || null,
    };
    const now = this.now();
    const receivedAtMs = readExecutionReceivedAtMs(
      payload,
      'ticker',
    );
    if (
      hasUsableSpotExecutionTicker(mergedTicker)
    ) {
      this.recordExecutionReceipt(
        'ticker',
        receivedAtMs,
        serverEnvelopeTimeMs,
        now,
      );
    } else {
      this.clearExecutionDomain('ticker');
    }
    const authority = this.getExecutionAuthority(
      mergedTicker,
      base.depth,
    );
    this.queueState({
      ...base,
      ticker: mergedTicker,
      executable: authority.executable,
      executionBid: authority.executable
        ? base.depth.bids[0]?.price ?? null
        : null,
      executionAsk: authority.executable
        ? base.depth.asks[0]?.price ?? null
        : null,
      source: 'WS',
      updatedAtMs: now,
      executionObservedAtMs: authority.observedAt,
      executionExpiresAtMs: authority.expiresAt,
    });
  }

  private applyTradeUpdate(message: SpotRealtimeMessage) {
    if (
      !isCurrentRealtimeFreshness(
        message.freshness ||
          (isRecord(message.trade)
            ? message.trade.freshness
            : null),
      )
    ) {
      return;
    }
    const nextTrade = normalizeSpotTradesPayload(
      {symbol: this.symbol, items: [message.trade]},
      this.symbol,
    )[0];
    if (!nextTrade) return;
    const observedAt =
      readObservedAtMs(message.trade) ??
      readObservedAtMs(message);
    const tradesDecision = this.acceptDomain('trades', {
      observedAtMs: observedAt,
      priority: 3,
      freshnessRank: freshnessRank(
        message.freshness ||
          (isRecord(message.trade)
            ? message.trade.freshness
            : null),
      ),
      hasData: true,
    });
    if (!tradesDecision.accepted) return;
    const base = this.pendingState || this.state;
    const trades = mergeSpotTrades(base.trades, [nextTrade]);
    const ticker =
      base.ticker && nextTrade.price !== null
        ? {...base.ticker, lastPrice: nextTrade.price}
        : base.ticker;
    this.queueState({
      ...base,
      ticker,
      trades,
      source: 'WS',
      updatedAtMs: this.now(),
    });
  }

  private queueState(nextState: SpotMarketRealtimeState) {
    this.pendingState = nextState;
    if (this.batchTimer !== null) return;
    this.batchTimer = setTimeout(() => {
      this.batchTimer = null;
      this.flushPending();
    }, this.batchWindowMs);
  }

  private flushPending() {
    if (!this.pendingState) return;
    const nextState = this.pendingState;
    this.pendingState = null;
    if (this.batchTimer !== null) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
    this.commit(nextState);
  }

  private clearBatch() {
    if (this.batchTimer !== null) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
    this.pendingState = null;
  }

  private commit(nextState: SpotMarketRealtimeState) {
    this.state = {
      ...nextState,
      revision: this.state.revision + 1,
    };
    this.scheduleExecutionExpiry();
    for (const listener of this.listeners) {
      listener();
    }
  }

  private scheduleExecutionExpiry() {
    this.clearExecutionExpiry();
    if (
      !this.state.executable ||
      this.state.executionObservedAtMs === null
    ) {
      return;
    }
    const remaining = Math.max(
      0,
      this.state.executionObservedAtMs +
        this.executionTtlMs -
        this.now(),
    );
    this.executionExpiryTimer = setTimeout(() => {
      this.executionExpiryTimer = null;
      this.flushPending();
      const observedAt = this.state.executionObservedAtMs;
      if (
        observedAt !== null &&
        this.now() - observedAt >= this.executionTtlMs
      ) {
        const now = this.now();
        if (
          this.executionDomainReceivedAtMs.ticker !== null &&
          now - this.executionDomainReceivedAtMs.ticker >=
            this.executionTtlMs
        ) {
          this.clearExecutionDomain('ticker');
        }
        if (
          this.executionDomainReceivedAtMs.depth !== null &&
          now - this.executionDomainReceivedAtMs.depth >=
            this.executionTtlMs
        ) {
          this.clearExecutionDomain('depth');
        }
        this.commit({
          ...this.state,
          executable: false,
          executionBid: null,
          executionAsk: null,
          executionObservedAtMs: null,
          executionExpiresAtMs: null,
        });
      } else {
        this.scheduleExecutionExpiry();
      }
    }, remaining);
  }

  private clearExecutionExpiry() {
    if (this.executionExpiryTimer === null) return;
    clearTimeout(this.executionExpiryTimer);
    this.executionExpiryTimer = null;
  }
}

export const SPOT_REALTIME_STORE_CACHE_LIMIT = 16;

const spotStores = new BoundedStoreCache<
  string,
  SpotMarketRealtimeStore
>(SPOT_REALTIME_STORE_CACHE_LIMIT);

export function getSpotMarketRealtimeStore(symbol: string) {
  const normalized = normalizeSymbol(symbol);
  return spotStores.getOrCreate(
    normalized,
    () => new SpotMarketRealtimeStore(normalized),
  );
}

export function __resetSpotMarketRealtimeStoresForTests() {
  spotStores.clear();
}
