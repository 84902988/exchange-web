import {API_BASE_URL} from '../config/env';
import {
  fetchContractMarketView,
  isContractExecutionReady,
  normalizeContractMarketViewPayload,
  type ContractMarketRevision,
  type ContractMarketSnapshotDomainMetadata,
  type ContractMarketView,
} from '../api/contract';
import {
  CONTRACT_EXECUTION_LEASE_SAFETY_MARGIN_MS,
  createContractExecutionLease,
  isContractExecutionLeaseActive,
  type ContractExecutionLease,
} from './contractExecutionLease';
import {
  ManagedPublicWebSocket,
  type PublicWebSocketStatus,
} from './managedPublicWebSocket';
import {BoundedStoreCache} from './boundedStoreCache';
import {shouldYieldRealtimeForMainTabTransition} from '../performance/mainTabTransitionBudget';

const CONTRACT_REST_FALLBACK_INTERVAL_MS = 5_000;
const CONTRACT_EXECUTION_REST_FALLBACK_GRACE_MS = 500;
// Atomic market-state frames can legitimately pause for several seconds while
// the public socket remains open. Keep the visible action stable through that
// bounded renewal gap; confirmation still requires a newly minted strict lease.
const CONTRACT_EXECUTION_RECOVERY_WINDOW_MS = 6_000;
const CONTRACT_MARKET_STATE_TIMEOUT_MS = 5_000;
const CONTRACT_UI_NOTIFICATION_WINDOW_MS = 250;
const CONTRACT_MARKET_INTERVAL = '1m';
const CONTRACT_CLOCK_CALIBRATION_SAMPLES = 2;
const CONTRACT_CLOCK_OFFSET_STABILITY_MS = 100;
const CONTRACT_CLOCK_OFFSET_JUMP_MS = 150;
// Device wall clocks can stay consistently offset from the API clock by more
// than the execution safety margin (Android emulators commonly drift by 1s+).
// A stable offset is safe to calibrate because authority age is measured on
// the server timeline; only transport jitter is added on the device timeline.
const CONTRACT_MAX_ABSOLUTE_CLOCK_SKEW_MS = 5 * 60 * 1_000;
const CONTRACT_CLOCK_UNCERTAINTY_MS =
  CONTRACT_EXECUTION_LEASE_SAFETY_MARGIN_MS;
const CONTRACT_MARKET_STATE_TIMEOUT_MAX_MS = 30_000;
const STALE_FRESHNESS = new Set([
  'MISSING',
  'STALE',
  'LAST_GOOD',
]);

export type ContractMarketRealtimePhase =
  | 'idle'
  | 'bootstrapping'
  | 'connecting'
  | 'live'
  | 'reconnecting'
  | 'paused';

export type ContractMarketRealtimeState = {
  symbol: string;
  marketView: ContractMarketView | null;
  lease: ContractExecutionLease | null;
  executionRecovering: boolean;
  loading: boolean;
  error: string | null;
  phase: ContractMarketRealtimePhase;
  source: 'REST' | 'WS' | null;
  sessionGeneration: number;
  executionGeneration: number;
  revision: number;
};

export type ContractExecutionLeaseGrant = {
  lease: ContractExecutionLease;
  executionGeneration: number;
  sessionGeneration: number;
};

export type ContractRealtimeTransport = {
  start: () => void;
  stop: (reason?: string) => void;
  restart: (reason?: string) => void;
  send: (data: string) => boolean;
  getStatus: () => PublicWebSocketStatus;
};

export type ContractRealtimeTransportHandlers = {
  onMessage: (data: string) => void;
  onStatusChange: (status: PublicWebSocketStatus) => void;
};

export type ContractKlineDomainHandlers = {
  onMessage: (message: Record<string, unknown>) => void;
  onStatusChange: (status: PublicWebSocketStatus) => void;
  onActiveChange: (active: boolean) => void;
};

export type ContractMarketRealtimeDependencies = {
  fetchMarketView?: (
    symbol: string,
    options: {signal?: AbortSignal},
  ) => Promise<ContractMarketView>;
  createTransport?: (
    handlers: ContractRealtimeTransportHandlers,
  ) => ContractRealtimeTransport;
  now?: () => number;
  fallbackIntervalMs?: number;
  marketStateTimeoutMs?: number;
  uiNotificationWindowMs?: number;
};

type ContractRealtimeMessage = {
  type?: unknown;
  domain?: unknown;
  symbol?: unknown;
  ts?: unknown;
  provider?: unknown;
  provider_generation?: unknown;
  freshness?: unknown;
  stale?: unknown;
  data?: unknown;
  market_state?: unknown;
};

type ContractKlineDomainOwner = {
  id: number;
  owner: string;
  interval: string;
  handlers: ContractKlineDomainHandlers;
};

type ContractAuthorityCursor = {
  provider: string | null;
  providerGeneration: number | null;
  revision: ContractMarketRevision | null;
  receivedAtMs: number | null;
};

type CursorDecision = {
  accepted: boolean;
  transitioned: boolean;
  cursor: ContractAuthorityCursor;
};

function normalizeSymbol(value: unknown) {
  return String(value || '').trim().toUpperCase();
}

function normalizeText(value: unknown) {
  const normalized = String(value || '').trim().toUpperCase();
  return normalized || null;
}

function readFiniteNumber(value: unknown) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const normalized = Number(value);
  return Number.isFinite(normalized) ? normalized : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function authorityCursor(
  metadata: ContractMarketSnapshotDomainMetadata,
): ContractAuthorityCursor {
  return {
    provider: metadata.provider,
    providerGeneration: metadata.providerGeneration,
    revision: metadata.revision,
    receivedAtMs: metadata.receivedAtMs,
  };
}

function compareRevision(
  current: ContractMarketRevision,
  incoming: ContractMarketRevision,
) {
  if (
    current.epoch !== null &&
    incoming.epoch !== null &&
    incoming.epoch !== current.epoch
  ) {
    return incoming.epoch > current.epoch ? 1 : -1;
  }
  if (
    current.sequence !== null &&
    incoming.sequence !== null &&
    incoming.sequence !== current.sequence
  ) {
    return incoming.sequence > current.sequence ? 1 : -1;
  }
  if (
    current.isClosed === true &&
    incoming.isClosed === false
  ) {
    return -1;
  }
  if (
    current.sequence !== null &&
    incoming.sequence === current.sequence &&
    current.checksum &&
    incoming.checksum &&
    current.checksum !== incoming.checksum
  ) {
    return -1;
  }
  return 0;
}

function decideCursor(
  current: ContractAuthorityCursor | null,
  incomingMetadata: ContractMarketSnapshotDomainMetadata,
  claimsExecution: boolean,
): CursorDecision {
  const incoming = authorityCursor(incomingMetadata);
  if (!current) {
    return {accepted: true, transitioned: false, cursor: incoming};
  }
  if (claimsExecution && current.provider && !incoming.provider) {
    return {accepted: false, transitioned: false, cursor: current};
  }

  const sameProvider =
    current.provider === incoming.provider ||
    !current.provider ||
    !incoming.provider;
  if (!sameProvider) {
    return {accepted: true, transitioned: true, cursor: incoming};
  }

  if (
    current.providerGeneration !== null &&
    incoming.providerGeneration !== null
  ) {
    if (
      incoming.providerGeneration < current.providerGeneration
    ) {
      return {accepted: false, transitioned: false, cursor: current};
    }
    if (
      incoming.providerGeneration > current.providerGeneration
    ) {
      return {accepted: true, transitioned: true, cursor: incoming};
    }
  } else if (
    current.providerGeneration !== incoming.providerGeneration
  ) {
    if (
      current.providerGeneration !== null &&
      incoming.providerGeneration === null
    ) {
      return claimsExecution
        ? {accepted: false, transitioned: false, cursor: current}
        : {accepted: true, transitioned: false, cursor: current};
    }
    return {accepted: true, transitioned: true, cursor: incoming};
  }

  if (current.revision && !incoming.revision) {
    return claimsExecution
      ? {accepted: false, transitioned: false, cursor: current}
      : {accepted: true, transitioned: false, cursor: current};
  }
  let revisionAdvanced = false;
  if (current.revision && incoming.revision) {
    if (
      claimsExecution &&
      ((current.revision.epoch !== null &&
        incoming.revision.epoch === null) ||
        (current.revision.sequence !== null &&
          incoming.revision.sequence === null))
    ) {
      return {accepted: false, transitioned: false, cursor: current};
    }
    const revisionOrder = compareRevision(
      current.revision,
      incoming.revision,
    );
    if (revisionOrder < 0) {
      return {accepted: false, transitioned: false, cursor: current};
    }
    revisionAdvanced = revisionOrder > 0;
  }

  if (
    !revisionAdvanced &&
    current.receivedAtMs !== null &&
    incoming.receivedAtMs !== null &&
    incoming.receivedAtMs < current.receivedAtMs
  ) {
    return {accepted: false, transitioned: false, cursor: current};
  }
  return {accepted: true, transitioned: false, cursor: incoming};
}

function authorityAgeAtFrame(
  metadata: ContractMarketSnapshotDomainMetadata | null,
  expectedDomain: 'ticker' | 'depth',
  expectedSymbol: string,
  envelopeTimeMs: number,
) {
  if (
    !metadata ||
    metadata.domain !== expectedDomain ||
    metadata.symbol !== expectedSymbol ||
    metadata.completenessStatus !== 'COMPLETE' ||
    metadata.stale !== false ||
    metadata.freshness !== 'LIVE' ||
    !metadata.source ||
    !metadata.provider ||
    !metadata.transport ||
    metadata.providerGeneration === null ||
    metadata.revision?.epoch === null ||
    metadata.revision?.epoch === undefined ||
    metadata.revision.sequence === null ||
    metadata.receivedAtMs === null ||
    metadata.ttlMs === null ||
    metadata.receivedAtMs <= 0 ||
    metadata.ttlMs <= 0
  ) {
    return null;
  }
  const ageMs = envelopeTimeMs - metadata.receivedAtMs;
  if (
    !Number.isFinite(ageMs) ||
    ageMs < 0 ||
    ageMs >= metadata.ttlMs
  ) {
    return null;
  }
  return ageMs;
}

function normalizeInterval(value: unknown) {
  const normalized = String(value || '1m').trim();
  return normalized === '1M'
    ? '1M'
    : normalized.toLowerCase() || '1m';
}

export function buildContractMarketWsUrl(
  symbol: string,
  interval = CONTRACT_MARKET_INTERVAL,
) {
  const base = API_BASE_URL.replace(/\/+$/, '');
  const websocketBase = base.startsWith('https:')
    ? `wss:${base.slice('https:'.length)}`
    : base.startsWith('http:')
      ? `ws:${base.slice('http:'.length)}`
      : base;
  return `${websocketBase}/contract/market/ws?symbol=${encodeURIComponent(
    normalizeSymbol(symbol),
  )}&interval=${encodeURIComponent(normalizeInterval(interval))}`;
}

export function buildContractMarketSubscribeMessage(symbol: string) {
  return JSON.stringify({
    op: 'subscribe',
    domain: 'market',
    symbol: normalizeSymbol(symbol),
  });
}

export function buildContractKlineDomainMessage(
  op: 'subscribe' | 'unsubscribe',
  symbol: string,
  interval: string,
) {
  return JSON.stringify({
    op,
    domain: 'kline',
    symbol: normalizeSymbol(symbol),
    interval: normalizeInterval(interval),
  });
}

function buildContractMarketUnsubscribeMessage(symbol: string) {
  return JSON.stringify({
    op: 'unsubscribe',
    domain: 'market',
    symbol: normalizeSymbol(symbol),
  });
}

export class ContractMarketRealtimeStore {
  private readonly symbol: string;
  private readonly fetchMarketView: (
    symbol: string,
    options: {signal?: AbortSignal},
  ) => Promise<ContractMarketView>;
  private readonly now: () => number;
  private readonly fallbackIntervalMs: number;
  private readonly marketStateTimeoutMs: number;
  private readonly uiNotificationWindowMs: number;
  private readonly transport: ContractRealtimeTransport;
  private readonly listeners = new Set<() => void>();
  private readonly ownerCounts = new Map<string, number>();
  private readonly klineOwners = new Map<
    number,
    ContractKlineDomainOwner
  >();

  private state: ContractMarketRealtimeState;
  private lastUiNotifiedState: ContractMarketRealtimeState;
  private generation = 0;
  private klineOwnerSequence = 0;
  private marketDomainActive = false;
  private marketSubscriptionReady = false;
  private transportStatus: PublicWebSocketStatus = 'idle';
  private fallbackTimer: ReturnType<typeof setTimeout> | null = null;
  private marketStateWatchdogTimer: ReturnType<typeof setTimeout> | null =
    null;
  private executionExpiryTimer: ReturnType<typeof setTimeout> | null =
    null;
  private executionRecoveryTimer: ReturnType<typeof setTimeout> | null =
    null;
  private uiNotificationTimer: ReturnType<typeof setTimeout> | null =
    null;
  private restController: AbortController | null = null;
  private lastWsStateAppliedAtMs: number | null = null;
  private lastWsViewAppliedAtMs: number | null = null;
  private serverClockOffsetMs: number | null = null;
  private serverClockStableSamples = 0;
  private serverClockCandidateOffsetMs: number | null = null;
  private serverClockCandidateSamples = 0;
  private marketStateWatchdogAttempt = 0;
  private marketStateRecoverySamples = 0;
  private authorityCursors: {
    ticker: ContractAuthorityCursor | null;
    depth: ContractAuthorityCursor | null;
  } = {ticker: null, depth: null};

  constructor(
    symbol: string,
    dependencies: ContractMarketRealtimeDependencies = {},
  ) {
    this.symbol = normalizeSymbol(symbol);
    this.fetchMarketView =
      dependencies.fetchMarketView || fetchContractMarketView;
    this.now = dependencies.now || Date.now;
    this.fallbackIntervalMs =
      dependencies.fallbackIntervalMs ??
      CONTRACT_REST_FALLBACK_INTERVAL_MS;
    this.marketStateTimeoutMs =
      dependencies.marketStateTimeoutMs ??
      CONTRACT_MARKET_STATE_TIMEOUT_MS;
    this.uiNotificationWindowMs =
      dependencies.uiNotificationWindowMs ??
      CONTRACT_UI_NOTIFICATION_WINDOW_MS;
    this.state = {
      symbol: this.symbol,
      marketView: null,
      lease: null,
      executionRecovering: false,
      loading: false,
      error: null,
      phase: 'idle',
      source: null,
      sessionGeneration: 0,
      executionGeneration: 0,
      revision: 0,
    };
    this.lastUiNotifiedState = this.state;

    const handlers: ContractRealtimeTransportHandlers = {
      onMessage: data => this.handleTransportMessage(data),
      onStatusChange: status =>
        this.handleTransportStatusChange(status),
    };
    this.transport = dependencies.createTransport
      ? dependencies.createTransport(handlers)
      : new ManagedPublicWebSocket({
          url: () =>
            buildContractMarketWsUrl(
              this.symbol,
              this.activeKlineInterval() ||
                CONTRACT_MARKET_INTERVAL,
            ),
          onMessage: handlers.onMessage,
          onStatusChange: handlers.onStatusChange,
          openMessages: () => this.buildOpenMessages(),
        });
  }

  getSnapshot = () => this.state;

  subscribe = (listener: () => void) => {
    if (this.listeners.size === 0) {
      this.lastUiNotifiedState = this.state;
    }
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        this.clearUiNotification();
      }
    };
  };

  waitForExecutionLease(
    timeoutMs = CONTRACT_EXECUTION_RECOVERY_WINDOW_MS,
  ) {
    const readGrant = (): ContractExecutionLeaseGrant | null => {
      const snapshot = this.state;
      const lease = snapshot.lease;
      if (
        lease === null ||
        !isContractExecutionLeaseActive(lease, this.now()) ||
        !snapshot.marketView ||
        !isContractExecutionReady(snapshot.marketView.quote, this.symbol)
      ) {
        return null;
      }
      return {
        lease,
        executionGeneration: snapshot.executionGeneration,
        sessionGeneration: snapshot.sessionGeneration,
      };
    };
    const currentGrant = readGrant();
    if (currentGrant) return Promise.resolve(currentGrant);
    if (this.activeMarketOwnerCount() === 0) return Promise.resolve(null);

    return new Promise<ContractExecutionLeaseGrant | null>(resolve => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let unsubscribe: () => void = () => undefined;
      const finish = (grant: ContractExecutionLeaseGrant | null) => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        unsubscribe();
        resolve(grant);
      };
      const check = () => {
        const grant = readGrant();
        if (grant) finish(grant);
      };
      unsubscribe = this.subscribe(check);
      timer = setTimeout(() => finish(null), Math.max(0, timeoutMs));
      if (this.transportStatus === 'open') {
        this.transport.send(buildContractMarketSubscribeMessage(this.symbol));
      }
      check();
    });
  }

  acquire(owner: string) {
    const normalizedOwner = String(owner || '').trim();
    if (!normalizedOwner) {
      throw new Error('Contract realtime owner is required');
    }
    const transportWasInactive =
      this.activeTransportOwnerCount() === 0;
    const marketWasInactive =
      this.activeMarketOwnerCount() === 0;
    this.ownerCounts.set(
      normalizedOwner,
      (this.ownerCounts.get(normalizedOwner) || 0) + 1,
    );
    if (transportWasInactive) {
      this.activateTransport();
    } else if (marketWasInactive) {
      this.activateMarketDomain();
      if (this.transportStatus === 'open') {
        this.transport.send(
          buildContractMarketSubscribeMessage(this.symbol),
        );
      }
      this.handleMarketTransportStatus(this.transportStatus);
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
      if (this.activeMarketOwnerCount() > 0) return;
      if (this.activeTransportOwnerCount() === 0) {
        this.deactivateTransport();
      } else {
        this.deactivateMarketDomain(true);
      }
    };
  }

  acquireKlineDomain(
    owner: string,
    interval: string,
    handlers: ContractKlineDomainHandlers,
  ) {
    const normalizedOwner = String(owner || '').trim();
    const normalizedInterval = normalizeInterval(interval);
    if (!normalizedOwner) {
      throw new Error('Contract Kline realtime owner is required');
    }
    const previous = this.activeKlineOwner();
    const transportWasInactive =
      this.activeTransportOwnerCount() === 0;
    const id = ++this.klineOwnerSequence;
    this.klineOwners.set(id, {
      id,
      owner: normalizedOwner,
      interval: normalizedInterval,
      handlers,
    });
    if (transportWasInactive) {
      this.activateTransport();
    } else {
      this.reconcileKlineOwner(previous, this.activeKlineOwner());
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      const activeBeforeRelease = this.activeKlineOwner();
      if (!this.klineOwners.delete(id)) return;
      const activeAfterRelease = this.activeKlineOwner();
      if (this.activeTransportOwnerCount() === 0) {
        handlers.onActiveChange(false);
        this.deactivateTransport();
        return;
      }
      this.reconcileKlineOwner(
        activeBeforeRelease,
        activeAfterRelease,
      );
    };
  }

  resubscribeKlineDomain(interval: string) {
    const normalizedInterval = normalizeInterval(interval);
    if (
      this.transportStatus !== 'open' ||
      this.activeKlineInterval() !== normalizedInterval
    ) {
      return false;
    }
    return this.transport.send(
      buildContractKlineDomainMessage(
        'subscribe',
        this.symbol,
        normalizedInterval,
      ),
    );
  }

  destroy() {
    this.ownerCounts.clear();
    for (const item of this.klineOwners.values()) {
      item.handlers.onActiveChange(false);
    }
    this.klineOwners.clear();
    this.deactivateTransport();
    this.clearUiNotification();
    this.listeners.clear();
  }

  isRetained() {
    return this.activeTransportOwnerCount() > 0 || this.listeners.size > 0;
  }

  private activeMarketOwnerCount() {
    let count = 0;
    for (const ownerCount of this.ownerCounts.values()) {
      count += ownerCount;
    }
    return count;
  }

  private activeTransportOwnerCount() {
    return (
      this.activeMarketOwnerCount() + this.klineOwners.size
    );
  }

  private activeKlineOwner() {
    let active: ContractKlineDomainOwner | null = null;
    for (const item of this.klineOwners.values()) {
      if (!active || item.id > active.id) active = item;
    }
    return active;
  }

  private activeKlineInterval() {
    return this.activeKlineOwner()?.interval || null;
  }

  private buildOpenMessages() {
    const messages: string[] = [];
    if (this.activeMarketOwnerCount() > 0) {
      messages.push(
        buildContractMarketSubscribeMessage(this.symbol),
      );
    }
    const activeKline = this.activeKlineOwner();
    if (activeKline) {
      messages.push(
        buildContractKlineDomainMessage(
          'subscribe',
          this.symbol,
          activeKline.interval,
        ),
      );
    }
    return messages;
  }

  private reconcileKlineOwner(
    previous: ContractKlineDomainOwner | null,
    next: ContractKlineDomainOwner | null,
  ) {
    const previousInterval = previous?.interval || null;
    const nextInterval = next?.interval || null;
    if (
      this.transportStatus === 'open' &&
      previousInterval !== nextInterval
    ) {
      if (previousInterval) {
        this.transport.send(
          buildContractKlineDomainMessage(
            'unsubscribe',
            this.symbol,
            previousInterval,
          ),
        );
      }
      if (nextInterval) {
        this.transport.send(
          buildContractKlineDomainMessage(
            'subscribe',
            this.symbol,
            nextInterval,
          ),
        );
      }
    }
    for (const item of this.klineOwners.values()) {
      const active =
        nextInterval !== null && item.interval === nextInterval;
      item.handlers.onActiveChange(active);
      if (active) {
        item.handlers.onStatusChange(this.transportStatus);
      }
    }
    if (previous && !this.klineOwners.has(previous.id)) {
      previous.handlers.onActiveChange(false);
    }
  }

  private activateTransport() {
    const generation = ++this.generation;
    if (this.activeMarketOwnerCount() > 0) {
      this.activateMarketDomain(generation);
    }
    this.reconcileKlineOwner(null, this.activeKlineOwner());
    this.transport.start();
  }

  private activateMarketDomain(generation = this.generation) {
    this.marketDomainActive = true;
    this.marketSubscriptionReady = false;
    this.lastWsStateAppliedAtMs = null;
    this.lastWsViewAppliedAtMs = null;
    this.marketStateWatchdogAttempt = 0;
    this.marketStateRecoverySamples = 0;
    this.resetServerClockCalibration();
    this.authorityCursors = {ticker: null, depth: null};
    this.commit({
      ...this.state,
      lease: null,
      executionRecovering: false,
      loading: this.state.marketView === null,
      error: null,
      phase: 'bootstrapping',
      sessionGeneration: generation,
      executionGeneration: this.state.executionGeneration + 1,
    });
    this.refreshRest(generation).catch(() => undefined);
  }

  private deactivateMarketDomain(sendUnsubscribe: boolean) {
    if (!this.marketDomainActive) return;
    this.marketDomainActive = false;
    this.marketSubscriptionReady = false;
    if (sendUnsubscribe && this.transportStatus === 'open') {
      this.transport.send(
        buildContractMarketUnsubscribeMessage(this.symbol),
      );
    }
    this.clearFallbackTimer();
    this.clearMarketStateWatchdog();
    this.clearExecutionExpiry();
    this.abortRestRequest();
    this.lastWsStateAppliedAtMs = null;
    this.lastWsViewAppliedAtMs = null;
    this.marketStateRecoverySamples = 0;
    this.resetServerClockCalibration();
    if (
      this.state.phase === 'paused' &&
      this.state.lease === null &&
      !this.state.executionRecovering &&
      !this.state.loading
    ) {
      return;
    }
    this.commit({
      ...this.state,
      lease: null,
      executionRecovering: false,
      loading: false,
      phase: 'paused',
      executionGeneration: this.state.executionGeneration + 1,
    });
  }

  private deactivateTransport() {
    this.generation += 1;
    this.deactivateMarketDomain(false);
    this.transport.stop('contract public realtime owners released');
  }

  private isActiveGeneration(generation: number) {
    return (
      generation === this.generation &&
      this.activeMarketOwnerCount() > 0
    );
  }

  private handleTransportStatusChange(
    status: PublicWebSocketStatus,
  ) {
    this.transportStatus = status;
    const activeKlineInterval = this.activeKlineInterval();
    if (activeKlineInterval) {
      for (const item of this.klineOwners.values()) {
        if (item.interval === activeKlineInterval) {
          item.handlers.onStatusChange(status);
        }
      }
    }
    this.handleMarketTransportStatus(status);
  }

  private handleMarketTransportStatus(
    status: PublicWebSocketStatus,
  ) {
    if (this.activeMarketOwnerCount() === 0) return;
    if (status === 'open') {
      this.marketSubscriptionReady = false;
      this.invalidateExecution(
        this.state.phase === 'bootstrapping'
          ? 'connecting'
          : this.state.phase,
      );
      if (this.lastWsStateAppliedAtMs === null) {
        this.ensureRestFallback(0);
      }
      this.scheduleMarketStateWatchdog();
      return;
    }
    if (status === 'connecting') {
      this.marketSubscriptionReady = false;
      this.lastWsStateAppliedAtMs = null;
      this.marketStateRecoverySamples = 0;
      this.clearMarketStateWatchdog();
      this.resetServerClockCalibration();
      this.invalidateExecution('connecting');
      this.ensureRestFallback(0);
      return;
    }
    if (status === 'reconnecting') {
      this.marketSubscriptionReady = false;
      this.lastWsStateAppliedAtMs = null;
      this.marketStateRecoverySamples = 0;
      this.clearMarketStateWatchdog();
      this.resetServerClockCalibration();
      this.invalidateExecution('reconnecting');
      this.ensureRestFallback(0);
      return;
    }
    if (status === 'stopped') {
      this.marketSubscriptionReady = false;
      this.marketStateRecoverySamples = 0;
      this.clearMarketStateWatchdog();
      this.resetServerClockCalibration();
      this.invalidateExecution('paused');
    }
  }

  private invalidateExecution(phase = this.state.phase) {
    this.clearExecutionExpiry();
    if (
      this.state.lease === null &&
      !this.state.executionRecovering &&
      this.state.phase === phase
    ) {
      return;
    }
    this.commit({
      ...this.state,
      lease: null,
      executionRecovering: false,
      phase,
      executionGeneration:
        this.state.executionGeneration +
        (this.state.lease !== null ? 1 : 0),
    });
  }

  private ensureRestFallback(delayMs: number) {
    if (
      this.activeMarketOwnerCount() === 0 ||
      this.fallbackTimer !== null ||
      this.restController !== null
    ) {
      return;
    }
    const generation = this.generation;
    this.fallbackTimer = setTimeout(() => {
      this.fallbackTimer = null;
      this.refreshRest(generation).catch(() => undefined);
    }, Math.max(0, delayMs));
  }

  private async refreshRest(generation: number) {
    if (
      !this.isActiveGeneration(generation) ||
      this.restController !== null
    ) {
      return;
    }
    const controller = new AbortController();
    const requestStartedAtMs = this.now();
    this.restController = controller;
    try {
      const view = await this.fetchMarketView(this.symbol, {
        signal: controller.signal,
      });
      if (
        !this.isActiveGeneration(generation) ||
        controller.signal.aborted ||
        view.symbol !== this.symbol ||
        (this.lastWsViewAppliedAtMs !== null &&
          this.lastWsViewAppliedAtMs >= requestStartedAtMs)
      ) {
        return;
      }
      const cursorResult = this.acceptAuthorityCursors(view, false);
      if (!cursorResult.accepted) return;
      this.commit({
        ...this.state,
        marketView: view,
        lease: null,
        executionRecovering:
          this.state.executionRecovering &&
          this.transportStatus === 'open' &&
          this.state.phase === 'live',
        loading: false,
        error: null,
        source: 'REST',
      });
    } catch (error) {
      if (
        !this.isActiveGeneration(generation) ||
        controller.signal.aborted
      ) {
        return;
      }
      this.invalidateExecution();
      if (!this.state.marketView) {
        this.commit({
          ...this.state,
          loading: false,
          error:
            error instanceof Error
              ? error.message
              : '合约行情加载失败',
        });
      }
    } finally {
      if (this.restController === controller) {
        this.restController = null;
      }
      if (
        this.isActiveGeneration(generation) &&
        this.shouldUseRestFallback()
      ) {
        this.ensureRestFallback(this.fallbackIntervalMs);
      }
    }
  }

  private handleTransportMessage(data: string) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    if (!isRecord(parsed)) return;
    const message = parsed as ContractRealtimeMessage;
    const type = String(message.type || '').trim().toLowerCase();
    if (type === 'pong') return;
    if (normalizeSymbol(message.symbol) !== this.symbol) return;
    if (
      shouldYieldRealtimeForMainTabTransition() &&
      (type === 'contract_market_state' ||
        type === 'contract_quote' ||
        type === 'contract_depth' ||
        type === 'contract_trade' ||
        type === 'contract_kline_update')
    ) {
      return;
    }
    const domain = String(message.domain || '')
      .trim()
      .toLowerCase();

    if (
      (type === 'contract_kline_snapshot' ||
        type === 'contract_kline_update') &&
      domain === 'kline'
    ) {
      this.dispatchKlineMessage(
        message as unknown as Record<string, unknown>,
      );
      return;
    }
    if (
      type === 'contract_market_snapshot' &&
      !domain &&
      this.activeKlineInterval()
    ) {
      this.dispatchKlineMessage(
        message as unknown as Record<string, unknown>,
      );
    }
    if (this.activeMarketOwnerCount() === 0) return;

    if (type === 'contract_market_status') {
      if (domain === 'market') {
        this.markMarketSubscriptionReady();
      }
      const status = isRecord(message.data)
        ? normalizeText(message.data.status)
        : null;
      if (status && status !== 'OK') {
        this.markWsStateUnready();
        this.invalidateExecution();
      }
      return;
    }

    if (
      type === 'contract_quote' ||
      type === 'contract_depth' ||
      type === 'contract_trade'
    ) {
      if (domain === 'market') {
        this.markMarketSubscriptionReady();
      }
      this.handleDomainSafetySignal(message, type);
      return;
    }

    const isSnapshot = type === 'contract_market_snapshot';
    const isState = type === 'contract_market_state';
    if (!isSnapshot && !isState) return;
    if (
      message.domain &&
      String(message.domain).trim().toLowerCase() !== 'market'
    ) {
      return;
    }
    if (domain === 'market') {
      this.markMarketSubscriptionReady();
    }
    const payload = isSnapshot
      ? isRecord(message.data) &&
        isRecord(message.data.market_state)
        ? message.data.market_state
        : null
      : isRecord(message.market_state)
        ? message.market_state
        : message.data;
    if (!isRecord(payload)) {
      this.markWsStateUnready();
      this.invalidateExecution();
      return;
    }
    this.applyWsMarketState(
      payload,
      readFiniteNumber(message.ts),
      isState,
    );
  }

  private dispatchKlineMessage(
    message: Record<string, unknown>,
  ) {
    const activeInterval = this.activeKlineInterval();
    if (!activeInterval) return;
    for (const item of this.klineOwners.values()) {
      if (item.interval === activeInterval) {
        item.handlers.onMessage(message);
      }
    }
  }

  private handleDomainSafetySignal(
    message: ContractRealtimeMessage,
    type: string,
  ) {
    const stale =
      message.stale === true ||
      STALE_FRESHNESS.has(normalizeText(message.freshness) || '');
    const domain =
      type === 'contract_depth'
        ? 'depth'
        : type === 'contract_quote'
          ? 'ticker'
          : null;
    const cursor = domain ? this.authorityCursors[domain] : null;
    const incomingProvider = normalizeText(message.provider);
    const incomingGeneration = readFiniteNumber(
      message.provider_generation,
    );
    const generationChanged =
      cursor !== null &&
      (Boolean(
        cursor.provider &&
          incomingProvider &&
          cursor.provider !== incomingProvider,
      ) ||
        (incomingGeneration !== null &&
          cursor.providerGeneration !== null &&
          incomingGeneration !== cursor.providerGeneration));
    if (stale || generationChanged) {
      this.markWsStateUnready();
      this.invalidateExecution();
    }
  }

  private applyWsMarketState(
    payload: Record<string, unknown>,
    envelopeTimeMs: number | null,
    mayMintLease: boolean,
  ) {
    if (!mayMintLease && this.lastWsStateAppliedAtMs !== null) {
      // The combined snapshot is bootstrap/display-only authority. Once an
      // atomic market_state has been accepted for this session, a late
      // snapshot must not roll the UI or execution gate back to older cache
      // contents. A reconnect/expiry clears lastWsStateAppliedAtMs and allows
      // the next snapshot to bootstrap display data again.
      return;
    }
    let view: ContractMarketView;
    try {
      view = normalizeContractMarketViewPayload(
        payload,
        this.symbol,
      );
    } catch {
      this.markWsStateUnready();
      this.invalidateExecution();
      return;
    }

    const cursorResult = this.acceptAuthorityCursors(view);
    if (!cursorResult.accepted) {
      this.markWsStateUnready();
      this.invalidateExecution();
      return;
    }
    const receivedAtMs = this.now();
    const transitAgeMs = this.observeWsClock(
      envelopeTimeMs,
      receivedAtMs,
    );
    const mintedLease =
      mayMintLease &&
      !cursorResult.transitioned &&
      this.transportStatus === 'open'
        ? this.createWsExecutionLease(
            view,
            payload,
            envelopeTimeMs,
            receivedAtMs,
            transitAgeMs,
          )
        : null;
    const lease =
      mintedLease ??
      this.retainExecutionLeaseDuringClockCalibration({
        view,
        payload,
        envelopeTimeMs,
        receivedAtMs,
        transitAgeMs,
        mayMintLease,
        cursorTransitioned: cursorResult.transitioned,
      });
    const freshAtomicState =
      mayMintLease &&
      envelopeTimeMs !== null &&
      this.isFreshWsDisplaySnapshot(view, envelopeTimeMs);

    if (mayMintLease) {
      this.lastWsStateAppliedAtMs = receivedAtMs;
      this.lastWsViewAppliedAtMs = receivedAtMs;
      this.clearFallbackTimer();
      this.marketStateRecoverySamples = freshAtomicState
        ? this.marketStateRecoverySamples + 1
        : 0;
      if (
        lease !== null ||
        (freshAtomicState && this.marketStateRecoverySamples >= 2)
      ) {
        this.marketStateWatchdogAttempt = 0;
      }
    } else if (
      envelopeTimeMs !== null &&
      this.isFreshWsDisplaySnapshot(view, envelopeTimeMs)
    ) {
      this.lastWsViewAppliedAtMs = receivedAtMs;
    }
    const executionWasRevoked =
      this.state.lease !== null && lease === null;
    const executionFrameSourceAgeMs = this.wsExecutionFrameSourceAgeMs(
      view,
      payload,
      envelopeTimeMs,
    );
    this.commit(
      {
        ...this.state,
        marketView: view,
        lease,
        executionRecovering:
          lease === null &&
          (this.state.executionRecovering || this.state.lease !== null) &&
          mayMintLease &&
          !cursorResult.transitioned &&
          this.transportStatus === 'open' &&
          executionFrameSourceAgeMs !== null,
        loading: false,
        error: null,
        phase:
          mayMintLease && this.transportStatus === 'open'
            ? 'live'
            : this.state.phase,
        source: 'WS',
        executionGeneration:
          this.state.executionGeneration +
          (executionWasRevoked ? 1 : 0),
      },
      {deferUiNotification: true},
    );
  }

  private acceptAuthorityCursors(
    view: ContractMarketView,
    claimsExecution = view.executable,
  ) {
    const next = {...this.authorityCursors};
    let transitioned = false;
    for (const domain of ['ticker', 'depth'] as const) {
      const metadata = view.snapshotMetadata[domain];
      if (!metadata) continue;
      if (metadata.symbol !== this.symbol) {
        return {accepted: false, transitioned: false};
      }
      const decision = decideCursor(
        this.authorityCursors[domain],
        metadata,
        claimsExecution,
      );
      if (!decision.accepted) {
        return {accepted: false, transitioned: false};
      }
      next[domain] = decision.cursor;
      transitioned = transitioned || decision.transitioned;
    }
    this.authorityCursors = next;
    return {accepted: true, transitioned};
  }

  private createWsExecutionLease(
    view: ContractMarketView,
    payload: Record<string, unknown>,
    envelopeTimeMs: number | null,
    receivedAtMs: number,
    transitAgeMs: number | null,
  ) {
    if (transitAgeMs === null) {
      return null;
    }
    const sourceAgeMs = this.wsExecutionFrameSourceAgeMs(
      view,
      payload,
      envelopeTimeMs,
    );
    if (sourceAgeMs === null) {
      return null;
    }
    const priceAgeMs = sourceAgeMs + transitAgeMs;
    return createContractExecutionLease({
      executable: view.executable,
      executionBid: view.quote.executionBid,
      executionAsk: view.quote.executionAsk,
      priceAgeMs,
      executionTtlMs: view.executionTtlMs,
      receivedAtMs,
    });
  }

  private wsExecutionFrameSourceAgeMs(
    view: ContractMarketView,
    payload: Record<string, unknown>,
    envelopeTimeMs: number | null,
  ) {
    if (
      envelopeTimeMs === null ||
      envelopeTimeMs <= 0 ||
      normalizeText(payload.view_version) !== '2' ||
      normalizeText(payload.authority_source) !==
        'SNAPSHOT_AUTHORITY' ||
      !isContractExecutionReady(view.quote, this.symbol)
    ) {
      return null;
    }
    const tickerAgeMs = authorityAgeAtFrame(
      view.snapshotMetadata.ticker,
      'ticker',
      this.symbol,
      envelopeTimeMs,
    );
    const depthAgeMs = authorityAgeAtFrame(
      view.snapshotMetadata.depth,
      'depth',
      this.symbol,
      envelopeTimeMs,
    );
    if (
      tickerAgeMs === null ||
      depthAgeMs === null ||
      view.priceAgeMs === null
    ) {
      return null;
    }
    return Math.max(view.priceAgeMs, tickerAgeMs, depthAgeMs);
  }

  private retainExecutionLeaseDuringClockCalibration({
    view,
    payload,
    envelopeTimeMs,
    receivedAtMs,
    transitAgeMs,
    mayMintLease,
    cursorTransitioned,
  }: {
    view: ContractMarketView;
    payload: Record<string, unknown>;
    envelopeTimeMs: number | null;
    receivedAtMs: number;
    transitAgeMs: number | null;
    mayMintLease: boolean;
    cursorTransitioned: boolean;
  }) {
    const currentLease = this.state.lease;
    if (
      transitAgeMs !== null ||
      !mayMintLease ||
      cursorTransitioned ||
      this.transportStatus !== 'open' ||
      !isContractExecutionLeaseActive(currentLease, receivedAtMs) ||
      this.wsExecutionFrameSourceAgeMs(
        view,
        payload,
        envelopeTimeMs,
      ) === null
    ) {
      return null;
    }

    // A single wall-clock calibration sample must not make the order button
    // flash. Keep only the already-issued lease and its original strict
    // expiry; never extend it or mint authority from an uncalibrated frame.
    return currentLease;
  }

  private observeWsClock(
    envelopeTimeMs: number | null,
    receivedAtMs: number,
  ) {
    if (envelopeTimeMs === null || envelopeTimeMs <= 0) {
      this.resetServerClockCalibration();
      return null;
    }
    const observedOffsetMs = receivedAtMs - envelopeTimeMs;
    if (
      !Number.isFinite(observedOffsetMs) ||
      Math.abs(observedOffsetMs) >
        CONTRACT_MAX_ABSOLUTE_CLOCK_SKEW_MS
    ) {
      this.resetServerClockCalibration();
      return null;
    }

    if (this.serverClockOffsetMs === null) {
      this.serverClockOffsetMs = observedOffsetMs;
      this.serverClockStableSamples = 1;
      return null;
    }

    const deltaMs = observedOffsetMs - this.serverClockOffsetMs;
    if (deltaMs < -CONTRACT_CLOCK_OFFSET_STABILITY_MS) {
      this.serverClockOffsetMs = observedOffsetMs;
      this.serverClockStableSamples = 1;
      this.serverClockCandidateOffsetMs = null;
      this.serverClockCandidateSamples = 0;
      return null;
    }

    if (
      deltaMs > CONTRACT_CLOCK_OFFSET_JUMP_MS
    ) {
      if (
        this.serverClockCandidateOffsetMs === null ||
        Math.abs(
          observedOffsetMs - this.serverClockCandidateOffsetMs,
        ) > CONTRACT_CLOCK_OFFSET_STABILITY_MS
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
        CONTRACT_CLOCK_CALIBRATION_SAMPLES
      ) {
        this.serverClockOffsetMs =
          this.serverClockCandidateOffsetMs;
        this.serverClockStableSamples = 1;
        this.serverClockCandidateOffsetMs = null;
        this.serverClockCandidateSamples = 0;
      }
      return null;
    }

    this.serverClockCandidateOffsetMs = null;
    this.serverClockCandidateSamples = 0;
    if (Math.abs(deltaMs) <= CONTRACT_CLOCK_OFFSET_STABILITY_MS) {
      this.serverClockOffsetMs = Math.min(
        this.serverClockOffsetMs,
        observedOffsetMs,
      );
      this.serverClockStableSamples = Math.min(
        CONTRACT_CLOCK_CALIBRATION_SAMPLES,
        this.serverClockStableSamples + 1,
      );
    }
    if (
      this.serverClockStableSamples <
      CONTRACT_CLOCK_CALIBRATION_SAMPLES
    ) {
      return null;
    }
    return (
      CONTRACT_CLOCK_UNCERTAINTY_MS +
      Math.max(0, observedOffsetMs - this.serverClockOffsetMs)
    );
  }

  private resetServerClockCalibration() {
    this.serverClockOffsetMs = null;
    this.serverClockStableSamples = 0;
    this.serverClockCandidateOffsetMs = null;
    this.serverClockCandidateSamples = 0;
  }

  private isFreshWsDisplaySnapshot(
    view: ContractMarketView,
    envelopeTimeMs: number,
  ) {
    return (
      authorityAgeAtFrame(
        view.snapshotMetadata.ticker,
        'ticker',
        this.symbol,
        envelopeTimeMs,
      ) !== null &&
      authorityAgeAtFrame(
        view.snapshotMetadata.depth,
        'depth',
        this.symbol,
        envelopeTimeMs,
      ) !== null
    );
  }

  private shouldUseRestFallback() {
    return (
      this.activeMarketOwnerCount() > 0 &&
      (this.transportStatus !== 'open' ||
        this.lastWsStateAppliedAtMs === null)
    );
  }

  private markWsStateUnready() {
    this.lastWsStateAppliedAtMs = null;
    this.marketStateRecoverySamples = 0;
    this.ensureRestFallback(0);
  }

  private markMarketSubscriptionReady() {
    if (this.marketSubscriptionReady) return;
    this.marketSubscriptionReady = true;
    this.marketStateWatchdogAttempt = 0;
    this.clearMarketStateWatchdog();
  }

  private abortRestRequest() {
    this.restController?.abort();
    this.restController = null;
  }

  private clearFallbackTimer() {
    if (this.fallbackTimer === null) return;
    clearTimeout(this.fallbackTimer);
    this.fallbackTimer = null;
  }

  private scheduleMarketStateWatchdog() {
    this.clearMarketStateWatchdog();
    if (
      this.activeMarketOwnerCount() === 0 ||
      this.transportStatus !== 'open' ||
      this.marketSubscriptionReady
    ) {
      return;
    }
    const generation = this.generation;
    const timeoutMs = Math.min(
      CONTRACT_MARKET_STATE_TIMEOUT_MAX_MS,
      this.marketStateTimeoutMs *
        2 ** this.marketStateWatchdogAttempt,
    );
    this.marketStateWatchdogTimer = setTimeout(() => {
      this.marketStateWatchdogTimer = null;
      if (
        !this.isActiveGeneration(generation) ||
        this.transportStatus !== 'open' ||
        this.marketSubscriptionReady
      ) {
        return;
      }
      this.lastWsStateAppliedAtMs = null;
      this.marketStateRecoverySamples = 0;
      this.marketStateWatchdogAttempt = Math.min(
        this.marketStateWatchdogAttempt + 1,
        30,
      );
      this.resetServerClockCalibration();
      this.invalidateExecution('connecting');
      this.ensureRestFallback(0);
      this.transport.send(
        buildContractMarketSubscribeMessage(this.symbol),
      );
      this.scheduleMarketStateWatchdog();
    }, timeoutMs);
  }

  private clearMarketStateWatchdog() {
    if (this.marketStateWatchdogTimer === null) return;
    clearTimeout(this.marketStateWatchdogTimer);
    this.marketStateWatchdogTimer = null;
  }

  private clearExecutionExpiry() {
    if (this.executionExpiryTimer === null) return;
    clearTimeout(this.executionExpiryTimer);
    this.executionExpiryTimer = null;
  }

  private reconcileExecutionRecoveryExpiry() {
    if (!this.state.executionRecovering) {
      if (this.executionRecoveryTimer !== null) {
        clearTimeout(this.executionRecoveryTimer);
        this.executionRecoveryTimer = null;
      }
      return;
    }
    if (this.executionRecoveryTimer !== null) return;
    this.executionRecoveryTimer = setTimeout(() => {
      this.executionRecoveryTimer = null;
      if (
        this.state.executionRecovering &&
        this.state.lease === null
      ) {
        this.commit({
          ...this.state,
          executionRecovering: false,
        });
      }
    }, CONTRACT_EXECUTION_RECOVERY_WINDOW_MS);
  }

  private scheduleExecutionExpiry() {
    this.clearExecutionExpiry();
    const lease = this.state.lease;
    if (!lease) return;
    const delayMs = Math.max(0, lease.expiresAtMs - this.now());
    this.executionExpiryTimer = setTimeout(() => {
      this.executionExpiryTimer = null;
      if (
        this.state.lease?.expiresAtMs === lease.expiresAtMs &&
        this.state.lease.receivedAtMs === lease.receivedAtMs
      ) {
        this.lastWsStateAppliedAtMs = null;
        this.marketStateRecoverySamples = 0;
        this.ensureRestFallback(
          CONTRACT_EXECUTION_REST_FALLBACK_GRACE_MS,
        );
        this.commit({
          ...this.state,
          lease: null,
          executionRecovering:
            this.transportStatus === 'open' && this.state.phase === 'live',
          executionGeneration: this.state.executionGeneration + 1,
        });
      }
    }, delayMs);
  }

  private clearUiNotification() {
    if (this.uiNotificationTimer === null) return;
    clearTimeout(this.uiNotificationTimer);
    this.uiNotificationTimer = null;
  }

  private notifyUiNow() {
    this.clearUiNotification();
    this.lastUiNotifiedState = this.state;
    for (const listener of this.listeners) listener();
  }

  private scheduleUiNotification() {
    if (
      this.listeners.size === 0 ||
      this.uiNotificationTimer !== null
    ) {
      return;
    }
    this.uiNotificationTimer = setTimeout(() => {
      this.uiNotificationTimer = null;
      this.lastUiNotifiedState = this.state;
      for (const listener of this.listeners) listener();
    }, this.uiNotificationWindowMs);
  }

  private commit(
    nextState: ContractMarketRealtimeState,
    options: {deferUiNotification?: boolean} = {},
  ) {
    this.state = {
      ...nextState,
      revision: this.state.revision + 1,
    };
    this.scheduleExecutionExpiry();
    this.reconcileExecutionRecoveryExpiry();
    const executionRevoked =
      this.lastUiNotifiedState.lease !== null &&
      this.state.lease === null;
    const executionLifecycleChanged =
      this.lastUiNotifiedState.sessionGeneration !==
        this.state.sessionGeneration ||
      (this.lastUiNotifiedState.lease !== null &&
        this.lastUiNotifiedState.executionGeneration !==
          this.state.executionGeneration);
    const connectionStateChanged =
      this.lastUiNotifiedState.phase !== this.state.phase ||
      this.lastUiNotifiedState.error !== this.state.error;

    if (
      !options.deferUiNotification ||
      executionRevoked ||
      executionLifecycleChanged ||
      connectionStateChanged
    ) {
      this.notifyUiNow();
      return;
    }
    this.scheduleUiNotification();
  }
}

export const CONTRACT_MARKET_REALTIME_STORE_CACHE_LIMIT = 16;

const contractStores = new BoundedStoreCache<
  string,
  ContractMarketRealtimeStore
>(CONTRACT_MARKET_REALTIME_STORE_CACHE_LIMIT);

export function getContractMarketRealtimeStore(symbol: string) {
  const normalized = normalizeSymbol(symbol);
  return contractStores.getOrCreate(
    normalized,
    () => new ContractMarketRealtimeStore(normalized),
  );
}

export function __resetContractMarketRealtimeStoresForTests() {
  contractStores.clear();
}
