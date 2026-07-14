export type ContractMarketStoreDomain = 'ticker' | 'depth' | 'trades' | 'kline';

export type ContractMarketStoreTransport = 'REST' | 'WS' | 'CACHE';

export type ContractMarketStoreRevision = {
  epoch: number | null;
  sequence: number | null;
  isClosed: boolean | null;
  checksum: string | null;
};

export type ContractMarketStoreEntry<TData = unknown> = {
  key: string;
  symbol: string;
  domain: ContractMarketStoreDomain;
  interval: string | null;
  data: TData;
  transport: ContractMarketStoreTransport;
  source: string | null;
  provider: string | null;
  freshness: string | null;
  providerGeneration: number | null;
  revision: ContractMarketStoreRevision | null;
  eventTimeMs: number | null;
  receivedAtMs: number;
  observedAtMs: number;
  stale: boolean;
  sessionGeneration: number;
};

export type ContractMarketStoreState = {
  activeSymbol: string | null;
  sessionGeneration: number;
  entries: Record<string, ContractMarketStoreEntry>;
  version: number;
};

export type ContractMarketStoreInput<TData = unknown> = {
  symbol: string;
  domain: ContractMarketStoreDomain;
  interval?: string | null;
  data: TData;
  transport: ContractMarketStoreTransport;
  source?: string | null;
  provider?: string | null;
  freshness?: string | null;
  providerGeneration?: number | null;
  revision?: Partial<ContractMarketStoreRevision> | null;
  eventTimeMs?: number | null;
  receivedAtMs?: number | null;
  stale?: boolean | null;
};

export type ContractMarketStoreRejectReason =
  | 'BOOTSTRAP'
  | 'ACCEPTED'
  | 'NEW_GENERATION'
  | 'PROVIDER_SWITCH'
  | 'OLD_SYMBOL'
  | 'INVALID_IDENTITY'
  | 'INTERVAL_REQUIRED'
  | 'GENERATION_ROLLBACK'
  | 'REVISION_ROLLBACK'
  | 'REVISION_CONFLICT'
  | 'CLOSED_STATE_ROLLBACK'
  | 'STALE_EVENT';

export type ContractMarketStoreIngestResult = {
  accepted: boolean;
  reason: ContractMarketStoreRejectReason;
  key: string | null;
  entry: ContractMarketStoreEntry | null;
};

export type ContractMarketStoreListener = (
  state: ContractMarketStoreState,
  previousState: ContractMarketStoreState,
) => void;

const MARKET_INTERVAL_KEY = 'market';

function normalizeSymbol(value: unknown): string {
  return String(value ?? '').trim().toUpperCase();
}

export function normalizeContractMarketStoreInterval(value: unknown): string | null {
  const interval = String(value ?? '').trim();
  if (!interval) return null;
  return interval === '1M' ? interval : interval.toLowerCase();
}

function normalizeText(value: unknown): string | null {
  const normalized = String(value ?? '').trim().toUpperCase();
  return normalized || null;
}

function normalizeNonNegativeNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const normalized = Number(value);
  return Number.isFinite(normalized) && normalized >= 0 ? normalized : null;
}

function normalizeTimestamp(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string' && !Number.isFinite(Number(value))) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized <= 0) return null;
  return normalized < 1_000_000_000_000 ? normalized * 1000 : normalized;
}

function normalizeRevision(
  revision?: Partial<ContractMarketStoreRevision> | null,
): ContractMarketStoreRevision | null {
  if (!revision) return null;
  const normalized: ContractMarketStoreRevision = {
    epoch: normalizeNonNegativeNumber(revision.epoch),
    sequence: normalizeNonNegativeNumber(revision.sequence),
    isClosed: typeof revision.isClosed === 'boolean' ? revision.isClosed : null,
    checksum: revision.checksum ? String(revision.checksum) : null,
  };
  return Object.values(normalized).some((value) => value !== null) ? normalized : null;
}

function isStale(freshness: string | null, explicit: boolean | null | undefined): boolean {
  if (explicit === true) return true;
  return ['STALE', 'LAST_GOOD', 'MISSING'].includes(freshness || '');
}

function transportRank(transport: ContractMarketStoreTransport): number {
  if (transport === 'WS') return 3;
  if (transport === 'REST') return 2;
  return 1;
}

export function buildContractMarketStoreKey(
  symbolValue: unknown,
  domain: ContractMarketStoreDomain,
  intervalValue?: unknown,
): string {
  const symbol = normalizeSymbol(symbolValue);
  const interval = domain === 'kline'
    ? normalizeContractMarketStoreInterval(intervalValue) || ''
    : MARKET_INTERVAL_KEY;
  return `${symbol}:${domain}:${interval}`;
}

function initialState(): ContractMarketStoreState {
  return {
    activeSymbol: null,
    sessionGeneration: 0,
    entries: {},
    version: 0,
  };
}

function rejected(
  reason: ContractMarketStoreRejectReason,
  key: string | null,
  entry: ContractMarketStoreEntry | null,
): ContractMarketStoreIngestResult {
  return { accepted: false, reason, key, entry };
}

function accepted(
  reason: ContractMarketStoreRejectReason,
  key: string,
  entry: ContractMarketStoreEntry,
): ContractMarketStoreIngestResult {
  return { accepted: true, reason, key, entry };
}

export class ContractMarketStore {
  private state: ContractMarketStoreState;
  private listeners = new Set<ContractMarketStoreListener>();

  constructor(state: ContractMarketStoreState = initialState()) {
    this.state = state;
  }

  getState(): ContractMarketStoreState {
    return this.state;
  }

  subscribe(listener: ContractMarketStoreListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  activateSymbol(symbolValue: unknown): number {
    const symbol = normalizeSymbol(symbolValue);
    if (!symbol || this.state.activeSymbol === symbol) return this.state.sessionGeneration;
    this.replaceState({
      ...this.state,
      activeSymbol: symbol,
      sessionGeneration: this.state.sessionGeneration + 1,
      version: this.state.version + 1,
    });
    return this.state.sessionGeneration;
  }

  getEntry<TData = unknown>(
    symbol: unknown,
    domain: ContractMarketStoreDomain,
    interval?: unknown,
  ): ContractMarketStoreEntry<TData> | null {
    const entry = this.state.entries[buildContractMarketStoreKey(symbol, domain, interval)];
    return (entry as ContractMarketStoreEntry<TData> | undefined) ?? null;
  }

  ingest<TData>(input: ContractMarketStoreInput<TData>): ContractMarketStoreIngestResult {
    const symbol = normalizeSymbol(input.symbol);
    if (!symbol) return rejected('INVALID_IDENTITY', null, null);
    if (this.state.activeSymbol && symbol !== this.state.activeSymbol) {
      return rejected('OLD_SYMBOL', null, null);
    }

    const interval = input.domain === 'kline'
      ? normalizeContractMarketStoreInterval(input.interval)
      : null;
    if (input.domain === 'kline' && !interval) {
      return rejected('INTERVAL_REQUIRED', null, null);
    }

    const key = buildContractMarketStoreKey(symbol, input.domain, interval);
    const current = this.state.entries[key] ?? null;
    const provider = normalizeText(input.provider);
    const freshness = normalizeText(input.freshness);
    const providerGeneration = normalizeNonNegativeNumber(input.providerGeneration);
    const revision = normalizeRevision(input.revision);
    const eventTimeMs = normalizeTimestamp(input.eventTimeMs);
    const receivedAtMs = normalizeTimestamp(input.receivedAtMs) ?? Date.now();
    const observedAtMs = eventTimeMs ?? receivedAtMs;
    const incomingStale = isStale(freshness, input.stale);
    let reason: ContractMarketStoreRejectReason = current ? 'ACCEPTED' : 'BOOTSTRAP';

    if (current) {
      const sameProvider = current.provider === provider;
      if (
        sameProvider
        && current.providerGeneration !== null
        && providerGeneration !== null
      ) {
        if (providerGeneration < current.providerGeneration) {
          return rejected('GENERATION_ROLLBACK', key, current);
        }
        if (providerGeneration > current.providerGeneration) {
          reason = 'NEW_GENERATION';
        }
      }

      if (
        reason !== 'NEW_GENERATION'
        && sameProvider
        && current.providerGeneration !== null
        && providerGeneration === null
        && input.transport === 'WS'
      ) {
        return rejected('GENERATION_ROLLBACK', key, current);
      }

      if (reason !== 'NEW_GENERATION' && incomingStale && !current.stale) {
        return rejected('STALE_EVENT', key, current);
      }

      const sameRevisionLineage = sameProvider && (
        current.providerGeneration === providerGeneration
        || (current.providerGeneration === null && providerGeneration === null)
      );
      if (reason !== 'NEW_GENERATION' && sameRevisionLineage && current.revision) {
        if (!revision) return rejected('REVISION_ROLLBACK', key, current);
        if (
          current.revision.epoch !== null
          && revision.epoch !== null
          && revision.epoch !== current.revision.epoch
        ) {
          if (revision.epoch < current.revision.epoch) {
            return rejected('REVISION_ROLLBACK', key, current);
          }
          reason = 'ACCEPTED';
        } else if (
          current.revision.sequence !== null
          && revision.sequence !== null
          && revision.sequence !== current.revision.sequence
        ) {
          if (revision.sequence < current.revision.sequence) {
            return rejected('REVISION_ROLLBACK', key, current);
          }
          reason = 'ACCEPTED';
        } else {
          if (current.revision.sequence !== null && revision.sequence === null) {
            return rejected('REVISION_ROLLBACK', key, current);
          }
          if (current.revision.isClosed === true && revision.isClosed === false) {
            return rejected('CLOSED_STATE_ROLLBACK', key, current);
          }
          if (
            current.revision.sequence !== null
            && current.revision.sequence === revision.sequence
            && current.revision.checksum
            && revision.checksum
            && current.revision.checksum !== revision.checksum
          ) {
            return rejected('REVISION_CONFLICT', key, current);
          }
        }
      }

      const revisionAdvanced = reason === 'ACCEPTED' && Boolean(
        sameRevisionLineage
        && current.revision
        && revision
        && (
          (current.revision.epoch !== null && revision.epoch !== null && revision.epoch > current.revision.epoch)
          || (
            current.revision.epoch === revision.epoch
            && current.revision.sequence !== null
            && revision.sequence !== null
            && revision.sequence > current.revision.sequence
          )
        )
      );
      if (
        reason !== 'NEW_GENERATION'
        && !revisionAdvanced
        && observedAtMs < current.observedAtMs
      ) {
        return rejected('STALE_EVENT', key, current);
      }
      if (
        reason !== 'NEW_GENERATION'
        && !revisionAdvanced
        && observedAtMs === current.observedAtMs
        && transportRank(input.transport) < transportRank(current.transport)
      ) {
        return rejected('STALE_EVENT', key, current);
      }
      if (!sameProvider && reason !== 'NEW_GENERATION') reason = 'PROVIDER_SWITCH';
    }

    const entry: ContractMarketStoreEntry<TData> = {
      key,
      symbol,
      domain: input.domain,
      interval,
      data: input.data,
      transport: input.transport,
      source: normalizeText(input.source),
      provider,
      freshness,
      providerGeneration,
      revision,
      eventTimeMs,
      receivedAtMs,
      observedAtMs,
      stale: incomingStale,
      sessionGeneration: this.state.sessionGeneration,
    };
    this.replaceState({
      ...this.state,
      entries: {
        ...this.state.entries,
        [key]: entry,
      },
      version: this.state.version + 1,
    });
    return accepted(reason, key, entry);
  }

  /** @internal Test isolation only. */
  resetForTests(): void {
    this.replaceState(initialState());
  }

  private replaceState(nextState: ContractMarketStoreState): void {
    if (nextState === this.state) return;
    const previousState = this.state;
    this.state = nextState;
    for (const listener of this.listeners) listener(nextState, previousState);
  }
}

export function createContractMarketStore(
  state?: ContractMarketStoreState,
): ContractMarketStore {
  return new ContractMarketStore(state);
}

export const contractMarketStore = createContractMarketStore();

export function selectContractMarketKlineEntry(
  state: ContractMarketStoreState,
  symbolValue: unknown,
  intervalValue: unknown,
): ContractMarketStoreEntry | null {
  const symbol = normalizeSymbol(symbolValue);
  const interval = normalizeContractMarketStoreInterval(intervalValue);
  if (!symbol || !interval) return null;
  const activeSymbol = normalizeSymbol(state.activeSymbol);
  if (activeSymbol && activeSymbol !== symbol) return null;
  const entry = state.entries[buildContractMarketStoreKey(symbol, 'kline', interval)];
  if (!entry || entry.sessionGeneration !== state.sessionGeneration) return null;
  return entry;
}

export function subscribeContractMarketKlineEntry(
  symbolValue: unknown,
  intervalValue: unknown,
  listener: (entry: ContractMarketStoreEntry | null) => void,
): () => void {
  const symbol = normalizeSymbol(symbolValue);
  const interval = normalizeContractMarketStoreInterval(intervalValue);
  let previousEntry = selectContractMarketKlineEntry(
    contractMarketStore.getState(),
    symbol,
    interval,
  );
  return contractMarketStore.subscribe((state) => {
    const nextEntry = selectContractMarketKlineEntry(state, symbol, interval);
    if (Object.is(previousEntry, nextEntry)) return;
    previousEntry = nextEntry;
    listener(nextEntry);
  });
}
