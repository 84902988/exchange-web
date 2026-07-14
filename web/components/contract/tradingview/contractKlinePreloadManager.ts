import {
  getContractMarketKlinesMetadata,
  type ContractMarketKlineMetadataResponse,
} from '@/lib/api/modules/contract';
import {
  getContractKlineCurrentCacheTtlMs,
  normalizeContractKlineAssetClass,
  type ContractKlineAssetClass,
} from './contractKlineCachePolicy';
import {
  contractKlineCurrentCache,
  type ContractKlineCurrentCacheKeyParams,
} from './contractKlineCurrentCache';
import {
  buildContractKlineRangeKey,
  getContractKlineLoadPolicy,
  normalizeContractKlineLoadInterval,
  normalizeContractKlineLoadSymbol,
} from './contractKlineLoadPolicy';

export type ContractKlineRequestRole = 'active' | 'preload';

type ContractKlineLeaseClock = {
  now: () => number;
  setTimeout: (callback: () => void, delayMs: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

type ContractKlineLeaseEntry = {
  leaseId: number;
  key: string;
  role: ContractKlineRequestRole;
  revision: number;
  coverage: number;
  requestedCoverage: number;
  deadlineAt: number;
  retired: boolean;
  timeoutHandle: unknown;
  promise: Promise<ContractMarketKlineMetadataResponse>;
  resolve: (value: ContractMarketKlineMetadataResponse) => void;
  reject: (reason: unknown) => void;
};

export type ContractKlineRequestLease = {
  leaseId: number;
  role: ContractKlineRequestRole;
  revision: number;
  isCurrent: () => boolean;
};

export type ContractKlineLeaseRequest = {
  key: string;
  coverage: number;
  role: ContractKlineRequestRole;
  deadlineMs: number;
  deadlineAt?: number;
  request: (
    coverage: number,
    lease: ContractKlineRequestLease,
  ) => Promise<ContractMarketKlineMetadataResponse>;
};

const defaultLeaseClock: ContractKlineLeaseClock = {
  now: Date.now,
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function normalizeCoverage(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.max(1, Math.ceil(numeric)) : 1;
}

function resolveLeaseDeadlineAt(
  clock: ContractKlineLeaseClock,
  deadlineMs: unknown,
  absoluteDeadlineAt?: unknown,
) {
  const now = clock.now();
  const relativeDeadlineAt = now + Math.max(1, Math.floor(Number(deadlineMs) || 1));
  const normalizedAbsolute = Number(absoluteDeadlineAt);
  if (!Number.isFinite(normalizedAbsolute) || normalizedAbsolute <= 0) {
    return relativeDeadlineAt;
  }
  return Math.max(now + 1, Math.min(relativeDeadlineAt, Math.floor(normalizedAbsolute)));
}

function isDefinitiveHistoryEnd(response: ContractMarketKlineMetadataResponse) {
  const metadata = response as ContractMarketKlineMetadataResponse & {
    history_terminal?: unknown;
  };
  const explicitTerminal = (
    metadata.history_terminal === true
    || (response.history_complete === true && response.has_more_before === false)
  );
  return Boolean(
    explicitTerminal
    && response.stale === false
    && response.history_incomplete === false
    && response.provider_error_code === null
    && response.retryable === false
  );
}

function responseCovers(
  response: ContractMarketKlineMetadataResponse,
  coverage: number,
) {
  return response.items.length >= coverage || isDefinitiveHistoryEnd(response);
}

function getRangeKeyIdentity(key: string) {
  const [symbol = '', interval = ''] = String(key || '').split('|');
  return { symbol, interval };
}

export class ContractKlineLeaseTimeoutError extends Error {
  constructor(readonly key: string, readonly leaseId: number) {
    super(`Contract kline request lease timed out: ${key}`);
    this.name = 'ContractKlineLeaseTimeoutError';
  }
}

export class ContractKlineChainDeadlineError extends Error {
  constructor(readonly key: string) {
    super(`Contract kline history chain deadline exceeded: ${key}`);
    this.name = 'ContractKlineChainDeadlineError';
  }
}

export class ContractKlinePreloadDeferredError extends Error {
  constructor(readonly key: string) {
    super(`Contract kline preload deferred while active history is running: ${key}`);
    this.name = 'ContractKlinePreloadDeferredError';
  }
}

export class ContractKlineLeaseRetiredError extends Error {
  constructor(readonly key: string, readonly leaseId: number, reason: string) {
    super(`Contract kline request lease retired: ${key}; ${reason}`);
    this.name = 'ContractKlineLeaseRetiredError';
  }
}

export class ContractKlineRequestLeaseRegistry {
  private readonly entries = new Map<string, ContractKlineLeaseEntry>();
  private readonly revisions = new Map<string, number>();
  private leaseSequence = 0;

  constructor(private readonly clock: ContractKlineLeaseClock = defaultLeaseClock) {}

  request(params: ContractKlineLeaseRequest): Promise<ContractMarketKlineMetadataResponse> {
    const key = String(params.key || '').trim();
    const coverage = normalizeCoverage(params.coverage);
    const absoluteDeadlineAt = Number(params.deadlineAt);
    if (
      Number.isFinite(absoluteDeadlineAt)
      && absoluteDeadlineAt > 0
      && absoluteDeadlineAt <= this.clock.now()
    ) {
      return Promise.reject(new ContractKlineChainDeadlineError(key));
    }
    if (params.role === 'preload' && this.hasActiveRequest) {
      const identity = getRangeKeyIdentity(key);
      recordContractKlineLifecycleEvent({
        event: 'lease_deferred',
        role: 'preload',
        generation: this.getRevision(key),
        ...identity,
        reason: 'active history lease',
      });
      return Promise.reject(new ContractKlinePreloadDeferredError(key));
    }
    if (params.role === 'active') {
      this.retirePreloads('active history acquired priority');
    }
    const existing = this.entries.get(key);
    if (existing && !existing.retired) {
      existing.requestedCoverage = Math.max(existing.requestedCoverage, coverage);
      this.tightenDeadline(existing, params.deadlineMs, params.deadlineAt);
      return existing.promise.then((response) => {
        if (existing.coverage >= coverage || responseCovers(response, coverage)) {
          return response;
        }
        return this.request({
          ...params,
          coverage: existing.requestedCoverage,
        });
      });
    }

    return this.start({ ...params, key, coverage });
  }

  retireAll(reason = 'request registry retired') {
    Array.from(this.entries.values()).forEach((entry) => {
      this.retire(entry, reason);
    });
  }

  get hasActiveRequest() {
    return Array.from(this.entries.values()).some((entry) => (
      !entry.retired && entry.role === 'active'
    ));
  }

  getRevision(key: string) {
    return this.revisions.get(String(key || '').trim()) || 0;
  }

  getSnapshot() {
    return Array.from(this.entries.values()).map((entry) => ({
      leaseId: entry.leaseId,
      key: entry.key,
      role: entry.role,
      revision: entry.revision,
      coverage: entry.coverage,
      requestedCoverage: entry.requestedCoverage,
      deadlineAt: entry.deadlineAt,
    }));
  }

  get size() {
    return this.entries.size;
  }

  private start(
    params: ContractKlineLeaseRequest & { key: string; coverage: number },
  ): Promise<ContractMarketKlineMetadataResponse> {
    const leaseId = ++this.leaseSequence;
    const revision = this.getRevision(params.key) + 1;
    this.revisions.set(params.key, revision);
    const deadlineAt = resolveLeaseDeadlineAt(
      this.clock,
      params.deadlineMs,
      params.deadlineAt,
    );
    let resolve!: (value: ContractMarketKlineMetadataResponse) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<ContractMarketKlineMetadataResponse>((nextResolve, nextReject) => {
      resolve = nextResolve;
      reject = nextReject;
    });
    const entry: ContractKlineLeaseEntry = {
      leaseId,
      key: params.key,
      role: params.role,
      revision,
      coverage: params.coverage,
      requestedCoverage: params.coverage,
      deadlineAt,
      retired: false,
      timeoutHandle: null,
      promise,
      resolve,
      reject,
    };
    this.entries.set(params.key, entry);
    const identity = getRangeKeyIdentity(params.key);
    recordContractKlineLifecycleEvent({
      event: 'lease_started',
      role: params.role,
      generation: revision,
      ...identity,
      revision,
    });

    this.scheduleDeadline(entry, entry.deadlineAt);

    let producer: Promise<ContractMarketKlineMetadataResponse>;
    const lease: ContractKlineRequestLease = {
      leaseId,
      role: params.role,
      revision,
      isCurrent: () => !entry.retired && this.entries.get(entry.key) === entry,
    };
    try {
      producer = Promise.resolve(params.request(params.coverage, lease));
    } catch (error) {
      producer = Promise.reject(error);
    }
    void producer.then(
      (response) => this.settle(entry, () => entry.resolve(response)),
      (error) => this.settle(entry, () => entry.reject(error)),
    );
    return promise;
  }

  private tightenDeadline(
    entry: ContractKlineLeaseEntry,
    deadlineMs: number,
    absoluteDeadlineAt?: number,
  ) {
    const nextDeadlineAt = resolveLeaseDeadlineAt(
      this.clock,
      deadlineMs,
      absoluteDeadlineAt,
    );
    if (nextDeadlineAt >= entry.deadlineAt) return;
    this.clock.clearTimeout(entry.timeoutHandle);
    this.scheduleDeadline(entry, nextDeadlineAt);
  }

  private scheduleDeadline(entry: ContractKlineLeaseEntry, deadlineAt: number) {
    entry.deadlineAt = deadlineAt;
    const remainingMs = Math.max(1, deadlineAt - this.clock.now());
    entry.timeoutHandle = this.clock.setTimeout(() => {
      if (entry.retired || this.entries.get(entry.key) !== entry) return;
      entry.retired = true;
      this.entries.delete(entry.key);
      entry.reject(new ContractKlineLeaseTimeoutError(entry.key, entry.leaseId));
    }, remainingMs);
  }

  private settle(entry: ContractKlineLeaseEntry, callback: () => void) {
    if (entry.retired || this.entries.get(entry.key) !== entry) return false;
    entry.retired = true;
    this.clock.clearTimeout(entry.timeoutHandle);
    this.entries.delete(entry.key);
    callback();
    return true;
  }

  retirePreloads(reason = 'preload leases retired') {
    for (const entry of Array.from(this.entries.values())) {
      if (entry.role === 'preload') this.retire(entry, reason);
    }
  }

  private retire(entry: ContractKlineLeaseEntry, reason: string) {
    if (entry.retired || this.entries.get(entry.key) !== entry) return false;
    entry.retired = true;
    this.clock.clearTimeout(entry.timeoutHandle);
    this.entries.delete(entry.key);
    const identity = getRangeKeyIdentity(entry.key);
    recordContractKlineLifecycleEvent({
      event: 'lease_retired',
      role: entry.role,
      generation: entry.revision,
      ...identity,
      revision: entry.revision,
      reason,
    });
    entry.reject(new ContractKlineLeaseRetiredError(entry.key, entry.leaseId, reason));
    return true;
  }
}

export const contractKlineRequestLeaseRegistry = new ContractKlineRequestLeaseRegistry();

export type ContractKlinePreloadState = {
  symbol: string;
  category: ContractKlineAssetClass | string | null | undefined;
  interval: string;
};

export type ContractKlinePreloadForegroundState = {
  loading: boolean;
  symbol: string;
  interval: string;
  generation: number;
};

export type ContractKlinePreloadHistoryEvent = {
  symbol: string;
  interval: string;
  firstDataRequest: boolean;
  barCount: number;
};

type ContractKlinePreloadCache = {
  get: (params: ContractKlineCurrentCacheKeyParams) => ContractMarketKlineMetadataResponse | null;
  getAtLeast?: (
    params: ContractKlineCurrentCacheKeyParams,
  ) => ContractMarketKlineMetadataResponse | null;
  set: (
    params: ContractKlineCurrentCacheKeyParams,
    response: ContractMarketKlineMetadataResponse,
    ttlMs: number,
  ) => boolean;
};

type ContractKlineIdleScheduler = {
  schedule: (callback: () => void) => unknown;
  cancel: (handle: unknown) => void;
};

type ContractKlinePreloadManagerOptions = {
  getState: () => ContractKlinePreloadState;
  cache?: ContractKlinePreloadCache;
  leaseRegistry?: ContractKlineRequestLeaseRegistry;
  request?: typeof getContractMarketKlinesMetadata;
  idleScheduler?: ContractKlineIdleScheduler;
};

export type ContractKlineLifecycleEvent = {
  event: string;
  role: ContractKlineRequestRole;
  generation: number;
  symbol: string;
  interval: string;
  revision?: number;
  reason?: string;
};

const CONTRACT_KLINE_LIFECYCLE_EVENT_LIMIT = 100;
const contractKlineLifecycleEvents: ContractKlineLifecycleEvent[] = [];

function recordContractKlineLifecycleEvent(event: ContractKlineLifecycleEvent) {
  contractKlineLifecycleEvents.push({ ...event });
  if (contractKlineLifecycleEvents.length > CONTRACT_KLINE_LIFECYCLE_EVENT_LIMIT) {
    contractKlineLifecycleEvents.splice(
      0,
      contractKlineLifecycleEvents.length - CONTRACT_KLINE_LIFECYCLE_EVENT_LIMIT,
    );
  }
  if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
    console.debug('[ContractKlineLifecycle]', event);
  }
}

export function getContractKlineLifecycleEventsSnapshot() {
  return contractKlineLifecycleEvents.map((event) => ({ ...event }));
}

export function resetContractKlineLifecycleEventsForTests() {
  contractKlineLifecycleEvents.length = 0;
}

type ContractIdleWindow = Window & {
  requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
};

function createDefaultIdleScheduler(): ContractKlineIdleScheduler {
  return {
    schedule(callback) {
      const browserWindow = window as ContractIdleWindow;
      if (typeof browserWindow.requestIdleCallback === 'function') {
        return {
          kind: 'idle',
          handle: browserWindow.requestIdleCallback(callback, { timeout: 1_500 }),
        };
      }
      return { kind: 'timer', handle: window.setTimeout(callback, 250) };
    },
    cancel(value) {
      const handle = value as { kind?: string; handle?: number } | null;
      if (!handle || typeof handle.handle !== 'number') return;
      const browserWindow = window as ContractIdleWindow;
      if (handle.kind === 'idle' && typeof browserWindow.cancelIdleCallback === 'function') {
        browserWindow.cancelIdleCallback(handle.handle);
        return;
      }
      window.clearTimeout(handle.handle);
    },
  };
}

function buildPreloadStateKey(state: ContractKlinePreloadState) {
  return [
    normalizeContractKlineLoadSymbol(state.symbol),
    normalizeContractKlineAssetClass(state.category),
    normalizeContractKlineLoadInterval(state.interval),
  ].join('|');
}

export class ContractKlinePreloadManager {
  private readonly cache: ContractKlinePreloadCache;
  private readonly leaseRegistry: ContractKlineRequestLeaseRegistry;
  private readonly requestKlines: typeof getContractMarketKlinesMetadata;
  private readonly idleScheduler: ContractKlineIdleScheduler;
  private idleHandle: unknown = null;
  private generation = 0;
  private preloadRunning = false;
  private ownerStateKey = '';
  private foregroundState: ContractKlinePreloadForegroundState | null = null;
  private deferredEvent: ContractKlinePreloadHistoryEvent | null = null;
  private destroyed = false;

  constructor(private readonly options: ContractKlinePreloadManagerOptions) {
    this.cache = options.cache ?? contractKlineCurrentCache;
    this.leaseRegistry = options.leaseRegistry ?? contractKlineRequestLeaseRegistry;
    this.requestKlines = options.request ?? getContractMarketKlinesMetadata;
    this.idleScheduler = options.idleScheduler ?? createDefaultIdleScheduler();
  }

  schedule(event: ContractKlinePreloadHistoryEvent) {
    if (this.destroyed || !event.firstDataRequest || event.barCount <= 0) return false;
    const state = this.options.getState();
    const stateKey = buildPreloadStateKey(state);
    const eventKey = buildPreloadStateKey({ ...state, symbol: event.symbol, interval: event.interval });
    if (!stateKey || stateKey !== eventKey) return false;

    this.deferredEvent = { ...event };
    const symbol = normalizeContractKlineLoadSymbol(state.symbol);
    const interval = normalizeContractKlineLoadInterval(state.interval);
    if (this.foregroundState?.loading || this.leaseRegistry.hasActiveRequest) {
      recordContractKlineLifecycleEvent({
        event: 'preload_deferred',
        role: 'preload',
        generation: this.generation,
        symbol,
        interval,
        reason: this.foregroundState?.loading ? 'foreground active' : 'active history lease',
      });
      return true;
    }
    if (this.ownerStateKey === stateKey && (this.idleHandle !== null || this.preloadRunning)) {
      recordContractKlineLifecycleEvent({
        event: 'preload_duplicate_ignored',
        role: 'preload',
        generation: this.generation,
        symbol,
        interval,
        reason: this.preloadRunning ? 'preload running' : 'idle schedule pending',
      });
      return true;
    }

    this.stopActiveSequence('preload state changed');
    this.deferredEvent = { ...event };
    this.ownerStateKey = stateKey;

    const generation = this.generation;
    recordContractKlineLifecycleEvent({
      event: 'preload_scheduled',
      role: 'preload',
      generation,
      symbol,
      interval,
    });
    this.idleHandle = this.idleScheduler.schedule(() => {
      this.idleHandle = null;
      void this.run(state, stateKey, generation);
    });
    return true;
  }

  cancel(reason = 'preload cancelled') {
    this.deferredEvent = null;
    this.foregroundState = null;
    this.stopActiveSequence(reason);
  }

  setForegroundState(state: ContractKlinePreloadForegroundState) {
    if (this.destroyed) return;
    const normalizedState: ContractKlinePreloadForegroundState = {
      loading: Boolean(state.loading),
      symbol: normalizeContractKlineLoadSymbol(state.symbol),
      interval: normalizeContractKlineLoadInterval(state.interval),
      generation: Math.max(0, Math.floor(Number(state.generation) || 0)),
    };

    if (normalizedState.loading) {
      if (
        this.foregroundState
        && normalizedState.generation < this.foregroundState.generation
      ) return;
      if (
        this.foregroundState?.loading
        && this.foregroundState.generation === normalizedState.generation
        && this.foregroundState.symbol === normalizedState.symbol
        && this.foregroundState.interval === normalizedState.interval
      ) return;
      this.foregroundState = normalizedState;
      this.deferredEvent = null;
      this.stopActiveSequence('foreground lifecycle started');
      recordContractKlineLifecycleEvent({
        event: 'preload_foreground_pause',
        role: 'active',
        generation: normalizedState.generation,
        symbol: normalizedState.symbol,
        interval: normalizedState.interval,
      });
      return;
    }

    if (
      !this.foregroundState
      || this.foregroundState.generation !== normalizedState.generation
      || this.foregroundState.symbol !== normalizedState.symbol
      || this.foregroundState.interval !== normalizedState.interval
    ) {
      recordContractKlineLifecycleEvent({
        event: 'preload_foreground_resume_ignored',
        role: 'active',
        generation: normalizedState.generation,
        symbol: normalizedState.symbol,
        interval: normalizedState.interval,
        reason: 'stale foreground completion',
      });
      return;
    }

    this.foregroundState = null;
    recordContractKlineLifecycleEvent({
      event: 'preload_foreground_resume',
      role: 'active',
      generation: normalizedState.generation,
      symbol: normalizedState.symbol,
      interval: normalizedState.interval,
    });
    const deferredEvent = this.deferredEvent;
    if (deferredEvent) this.schedule(deferredEvent);
  }

  getSnapshot() {
    return {
      generation: this.generation,
      preloadRunning: this.preloadRunning,
      ownerStateKey: this.ownerStateKey,
      foregroundState: this.foregroundState ? { ...this.foregroundState } : null,
      deferredEvent: this.deferredEvent ? { ...this.deferredEvent } : null,
    };
  }

  private stopActiveSequence(reason: string) {
    const state = this.options.getState();
    const hadWork = this.idleHandle !== null || this.preloadRunning || Boolean(this.ownerStateKey);
    if (this.preloadRunning) {
      this.leaseRegistry.retirePreloads(reason);
    }
    this.generation += 1;
    if (this.idleHandle !== null) {
      this.idleScheduler.cancel(this.idleHandle);
      this.idleHandle = null;
    }
    this.preloadRunning = false;
    this.ownerStateKey = '';
    if (hadWork) {
      recordContractKlineLifecycleEvent({
        event: 'preload_cancelled',
        role: 'preload',
        generation: this.generation,
        symbol: normalizeContractKlineLoadSymbol(state.symbol),
        interval: normalizeContractKlineLoadInterval(state.interval),
        reason,
      });
    }
  }

  destroy() {
    if (this.destroyed) return;
    this.cancel('preload manager destroyed');
    this.destroyed = true;
  }

  private async run(state: ContractKlinePreloadState, stateKey: string, generation: number) {
    if (
      !this.isCurrent(stateKey, generation)
      || this.foregroundState?.loading
      || this.leaseRegistry.hasActiveRequest
    ) return;
    const symbol = normalizeContractKlineLoadSymbol(state.symbol);
    const interval = normalizeContractKlineLoadInterval(state.interval);
    const category = normalizeContractKlineAssetClass(state.category);
    const policy = getContractKlineLoadPolicy(interval);
    const cacheParams = { category, symbol, interval, limit: policy.preloadLimit };
    this.preloadRunning = true;
    recordContractKlineLifecycleEvent({
      event: 'preload_started',
      role: 'preload',
      generation,
      symbol,
      interval,
    });

    try {
      const cached = this.cache.getAtLeast?.(cacheParams) ?? this.cache.get(cacheParams);
      if (cached) return;
      const rangeKey = buildContractKlineRangeKey({ symbol, interval });
      let leaseRevision = 0;
      const response = await this.leaseRegistry.request({
        key: rangeKey,
        coverage: policy.preloadLimit,
        role: 'preload',
        deadlineMs: policy.preloadDeadlineMs,
        request: (coverage, lease) => {
          leaseRevision = lease.revision;
          return this.requestKlines({ symbol, interval, limit: coverage });
        },
      });
      if (
        !this.isCurrent(stateKey, generation)
        || leaseRevision <= 0
        || this.leaseRegistry.getRevision(rangeKey) !== leaseRevision
      ) {
        recordContractKlineLifecycleEvent({
          event: 'preload_late_result_dropped',
          role: 'preload',
          generation,
          symbol,
          interval,
          revision: leaseRevision,
          reason: 'state generation or lease revision changed',
        });
        return;
      }
      this.cache.set(
        cacheParams,
        response,
        getContractKlineCurrentCacheTtlMs({ category, interval }),
      );
      recordContractKlineLifecycleEvent({
        event: 'preload_cache_written',
        role: 'preload',
        generation,
        symbol,
        interval,
        revision: leaseRevision,
      });
    } catch {
      // Idle preload is best-effort and must never change the active chart request path.
    } finally {
      if (this.generation === generation && this.ownerStateKey === stateKey) {
        this.preloadRunning = false;
        this.ownerStateKey = '';
        this.deferredEvent = null;
      }
    }
  }

  private isCurrent(stateKey: string, generation: number) {
    return (
      !this.destroyed
      && this.generation === generation
      && this.ownerStateKey === stateKey
      && buildPreloadStateKey(this.options.getState()) === stateKey
    );
  }
}

export function createContractKlinePreloadManager(options: ContractKlinePreloadManagerOptions) {
  return new ContractKlinePreloadManager(options);
}
