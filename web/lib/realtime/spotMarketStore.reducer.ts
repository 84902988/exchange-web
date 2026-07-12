import type { DomainSnapshot } from '@/components/spot/spotDomainSnapshot';
import type {
  SpotDepthResponse,
  SpotMarketKlineItem,
  SpotMarketTickerItem,
  SpotMarketTradeItem,
} from '@/lib/api/modules/spot';
import type {
  SpotDepthSnapshot,
  SpotDomainLifecycle,
  SpotDomainSlot,
  SpotKlineCurrentSlot,
  SpotKlineCurrentSnapshot,
  SpotMarketSnapshotInput,
  SpotPublicMarketStoreState,
  SpotSymbolMarketState,
  SpotTickerSnapshot,
  SpotTradesSnapshot,
  TransportState,
  TransportStatePatch,
} from './spotMarketStore.types';

const EMPTY_TRANSPORT_STATE: TransportState = {
  status: 'idle',
  generation: 0,
  connectedAtMs: null,
  disconnectedAtMs: null,
  lastMessageAtMs: null,
  reconnectAttempt: 0,
  error: null,
};

function normalizeSymbol(value: unknown): string {
  return String(value ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function normalizeInterval(value: unknown): string {
  return String(value ?? '').trim();
}

function normalizeTimestamp(value: unknown): number | null {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null;
}

function getSnapshotLifecycle<TData>(snapshot: DomainSnapshot<TData>): SpotDomainLifecycle {
  const freshness = snapshot.metadata.freshness;
  const completeness = snapshot.metadata.completeness.status;

  if (completeness === 'INVALID') return 'error';
  if (
    freshness === 'MISSING'
    || completeness === 'EMPTY'
    || snapshot.data === null
  ) {
    return 'missing';
  }
  if (snapshot.metadata.stale || freshness === 'STALE' || freshness === 'LAST_GOOD') {
    return 'stale';
  }
  return 'ready';
}

function createEmptyDomainSlot<TData>(): SpotDomainSlot<TData> {
  return {
    snapshot: null,
    lifecycle: 'idle',
    generation: 0,
    acceptedEventTimeMs: null,
    acceptedReceivedAtMs: null,
    retiredProviders: [],
    error: null,
  };
}

function createEmptySymbolState(symbol: string): SpotSymbolMarketState {
  return {
    symbol,
    ticker: createEmptyDomainSlot<SpotMarketTickerItem>(),
    depth: createEmptyDomainSlot<SpotDepthResponse>(),
    trades: createEmptyDomainSlot<SpotMarketTradeItem[]>(),
    klineByInterval: {},
    lastAccessedAtMs: 0,
  };
}

function createDomainSlot<TData>(
  current: SpotDomainSlot<TData>,
  snapshot: DomainSnapshot<TData>,
  retiredProviders: readonly string[] = current.retiredProviders,
): SpotDomainSlot<TData> {
  return {
    snapshot,
    lifecycle: getSnapshotLifecycle(snapshot),
    generation: current.generation + 1,
    acceptedEventTimeMs: normalizeTimestamp(snapshot.metadata.provider_event_time_ms),
    acceptedReceivedAtMs: normalizeTimestamp(snapshot.metadata.received_at_ms),
    retiredProviders,
    error: snapshot.metadata.completeness.status === 'INVALID' ? 'INVALID_DATA' : null,
  };
}

function normalizeMetadataText(value: unknown, fallback: string): string {
  const normalized = String(value ?? '').trim().toUpperCase();
  return normalized || fallback;
}

function freshnessRank(value: unknown): number {
  switch (normalizeMetadataText(value, 'MISSING')) {
    case 'LIVE':
      return 4;
    case 'RECENT':
      return 3;
    case 'STALE':
    case 'LAST_GOOD':
      return 2;
    case 'MISSING':
    default:
      return 1;
  }
}

function transportRank(value: DomainSnapshot<unknown>['metadata']['transport']): number {
  switch (value) {
    case 'PROVIDER_WS':
    case 'INTERNAL_EVENT':
      return 3;
    case 'PROVIDER_REST':
      return 2;
    case 'CACHE_READ':
    case 'DB_READ':
      return 1;
    case 'NONE':
    default:
      return 0;
  }
}

function isWeakSnapshot<TData>(snapshot: DomainSnapshot<TData>): boolean {
  return (
    freshnessRank(snapshot.metadata.freshness) <= 2
    || ['MISSING', 'LAST_GOOD', 'DB_CACHE'].includes(snapshot.metadata.source)
  );
}

function isLiveSnapshot<TData>(snapshot: DomainSnapshot<TData>): boolean {
  return (
    snapshot.metadata.transport === 'PROVIDER_WS'
    && snapshot.metadata.source === 'LIVE_WS'
    && snapshot.metadata.freshness === 'LIVE'
  );
}

function getOrderedSnapshotAcceptance<TData>(
  current: SpotDomainSlot<TData>,
  incoming: DomainSnapshot<TData>,
): { accepted: boolean; retiredProviders: readonly string[] } {
  const currentSnapshot = current.snapshot;
  if (!currentSnapshot) return { accepted: true, retiredProviders: current.retiredProviders };

  const currentProvider = normalizeMetadataText(currentSnapshot.metadata.provider, 'UNKNOWN');
  const incomingProvider = normalizeMetadataText(incoming.metadata.provider, 'UNKNOWN');
  if (currentProvider !== incomingProvider) {
    if (current.retiredProviders.includes(incomingProvider)) {
      return { accepted: false, retiredProviders: current.retiredProviders };
    }
    const maySwitch = (
      isLiveSnapshot(incoming)
      || (
        isWeakSnapshot(currentSnapshot)
        && freshnessRank(incoming.metadata.freshness) > freshnessRank(currentSnapshot.metadata.freshness)
      )
    );
    if (!maySwitch) return { accepted: false, retiredProviders: current.retiredProviders };

    const retiredProviders = currentProvider === 'UNKNOWN'
      ? current.retiredProviders
      : Array.from(new Set([...current.retiredProviders, currentProvider]));
    return { accepted: true, retiredProviders };
  }

  const currentEventTime = normalizeTimestamp(currentSnapshot.metadata.provider_event_time_ms);
  const incomingEventTime = normalizeTimestamp(incoming.metadata.provider_event_time_ms);
  if (currentEventTime !== null && incomingEventTime === null) {
    return { accepted: false, retiredProviders: current.retiredProviders };
  }
  if (
    currentEventTime !== null
    && incomingEventTime !== null
    && incomingEventTime < currentEventTime
  ) {
    return { accepted: false, retiredProviders: current.retiredProviders };
  }
  if (
    currentEventTime === incomingEventTime
    && transportRank(incoming.metadata.transport) < transportRank(currentSnapshot.metadata.transport)
  ) {
    return { accepted: false, retiredProviders: current.retiredProviders };
  }
  if (freshnessRank(incoming.metadata.freshness) < freshnessRank(currentSnapshot.metadata.freshness)) {
    return { accepted: false, retiredProviders: current.retiredProviders };
  }
  return { accepted: true, retiredProviders: current.retiredProviders };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function normalizeAuthorityNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const normalized = Number(value);
  return Number.isFinite(normalized) && normalized >= 0 ? normalized : null;
}

function getDepthAuthority(snapshot: SpotDepthSnapshot): {
  generation: number | null;
  sequence: number | null;
} {
  const depth = asRecord(snapshot.data);
  return {
    generation: normalizeAuthorityNumber(snapshot.metadata.provider_generation)
      ?? normalizeAuthorityNumber(depth?.provider_generation)
      ?? normalizeAuthorityNumber(depth?.generation),
    sequence: normalizeAuthorityNumber(snapshot.metadata.revision?.sequence)
      ?? normalizeAuthorityNumber(depth?.sequence),
  };
}

function getDepthSnapshotAcceptance(
  current: SpotDomainSlot<SpotDepthResponse>,
  incoming: SpotDepthSnapshot,
): { accepted: boolean; retiredProviders: readonly string[] } {
  const currentSnapshot = current.snapshot;
  if (!currentSnapshot) return { accepted: true, retiredProviders: current.retiredProviders };

  const currentProvider = normalizeMetadataText(currentSnapshot.metadata.provider, 'UNKNOWN');
  const incomingProvider = normalizeMetadataText(incoming.metadata.provider, 'UNKNOWN');
  if (currentProvider === incomingProvider) {
    const currentAuthority = getDepthAuthority(currentSnapshot);
    const incomingAuthority = getDepthAuthority(incoming);
    if (
      currentAuthority.generation !== null
      && incomingAuthority.generation !== null
      && incomingAuthority.generation !== currentAuthority.generation
    ) {
      return {
        accepted: incomingAuthority.generation > currentAuthority.generation,
        retiredProviders: current.retiredProviders,
      };
    }
    if (
      currentAuthority.sequence !== null
      && incomingAuthority.sequence !== null
      && incomingAuthority.sequence !== currentAuthority.sequence
    ) {
      return {
        accepted: incomingAuthority.sequence > currentAuthority.sequence,
        retiredProviders: current.retiredProviders,
      };
    }
  }

  return getOrderedSnapshotAcceptance(current, incoming);
}

function shouldIgnoreSnapshot<TData>(
  current: SpotDomainSlot<TData>,
  snapshot: DomainSnapshot<TData>,
  expectedDomain: DomainSnapshot<TData>['metadata']['domain'],
): boolean {
  return (
    snapshot.metadata.domain !== expectedDomain
    || !normalizeSymbol(snapshot.metadata.symbol)
    || current.snapshot?.snapshot_id === snapshot.snapshot_id
    || current.snapshot?.data === snapshot.data
  );
}

function replaceSymbolState(
  state: SpotPublicMarketStoreState,
  symbol: string,
  nextSymbolState: SpotSymbolMarketState,
): SpotPublicMarketStoreState {
  return {
    ...state,
    symbols: {
      ...state.symbols,
      [symbol]: nextSymbolState,
    },
    version: state.version + 1,
  };
}

function getSnapshotAccessTime<TData>(snapshot: DomainSnapshot<TData>): number {
  return normalizeTimestamp(snapshot.metadata.received_at_ms)
    ?? normalizeTimestamp(snapshot.emitted_at_ms)
    ?? 0;
}

export function createInitialSpotPublicMarketStoreState(): SpotPublicMarketStoreState {
  return {
    transport: { ...EMPTY_TRANSPORT_STATE },
    symbols: {},
    interests: {},
    interestRefCounts: {},
    version: 0,
  };
}

export function updateTransportState(
  state: SpotPublicMarketStoreState,
  patch: TransportStatePatch,
): SpotPublicMarketStoreState {
  const nextTransport = {
    ...state.transport,
    ...patch,
  };
  const unchanged = Object.keys(nextTransport).every((key) => (
    nextTransport[key as keyof TransportState] === state.transport[key as keyof TransportState]
  ));
  if (unchanged) return state;

  return {
    ...state,
    transport: nextTransport,
    version: state.version + 1,
  };
}

export function ingestTicker(
  state: SpotPublicMarketStoreState,
  snapshot: SpotTickerSnapshot,
): SpotPublicMarketStoreState {
  const symbol = normalizeSymbol(snapshot.metadata.symbol);
  const currentSymbolState = state.symbols[symbol] ?? createEmptySymbolState(symbol);
  if (shouldIgnoreSnapshot(currentSymbolState.ticker, snapshot, 'ticker')) return state;
  const acceptance = getOrderedSnapshotAcceptance(currentSymbolState.ticker, snapshot);
  if (!acceptance.accepted) return state;

  return replaceSymbolState(state, symbol, {
    ...currentSymbolState,
    ticker: createDomainSlot(
      currentSymbolState.ticker,
      snapshot,
      acceptance.retiredProviders,
    ),
    lastAccessedAtMs: getSnapshotAccessTime(snapshot),
  });
}

export function ingestDepth(
  state: SpotPublicMarketStoreState,
  snapshot: SpotDepthSnapshot,
): SpotPublicMarketStoreState {
  const symbol = normalizeSymbol(snapshot.metadata.symbol);
  const currentSymbolState = state.symbols[symbol] ?? createEmptySymbolState(symbol);
  if (shouldIgnoreSnapshot(currentSymbolState.depth, snapshot, 'depth')) return state;
  const acceptance = getDepthSnapshotAcceptance(currentSymbolState.depth, snapshot);
  if (!acceptance.accepted) return state;

  return replaceSymbolState(state, symbol, {
    ...currentSymbolState,
    depth: createDomainSlot(
      currentSymbolState.depth,
      snapshot,
      acceptance.retiredProviders,
    ),
    lastAccessedAtMs: getSnapshotAccessTime(snapshot),
  });
}

export function ingestTrade(
  state: SpotPublicMarketStoreState,
  snapshot: SpotTradesSnapshot,
): SpotPublicMarketStoreState {
  const symbol = normalizeSymbol(snapshot.metadata.symbol);
  const currentSymbolState = state.symbols[symbol] ?? createEmptySymbolState(symbol);
  if (shouldIgnoreSnapshot(currentSymbolState.trades, snapshot, 'trades')) return state;

  return replaceSymbolState(state, symbol, {
    ...currentSymbolState,
    trades: createDomainSlot(currentSymbolState.trades, snapshot),
    lastAccessedAtMs: getSnapshotAccessTime(snapshot),
  });
}

export function ingestKlineCurrent(
  state: SpotPublicMarketStoreState,
  snapshot: SpotKlineCurrentSnapshot,
): SpotPublicMarketStoreState {
  const symbol = normalizeSymbol(snapshot.metadata.symbol);
  const interval = normalizeInterval(snapshot.metadata.interval);
  if (snapshot.metadata.domain !== 'kline' || !symbol || !interval) return state;

  const currentSymbolState = state.symbols[symbol] ?? createEmptySymbolState(symbol);
  const currentSlot = currentSymbolState.klineByInterval[interval];
  if (currentSlot?.snapshot?.snapshot_id === snapshot.snapshot_id) return state;

  const baseSlot = createDomainSlot<SpotMarketKlineItem>(
    currentSlot ?? createEmptyDomainSlot<SpotMarketKlineItem>(),
    snapshot,
  );
  const data = snapshot.data;
  const revision = snapshot.metadata.revision;
  const nextSlot: SpotKlineCurrentSlot = {
    ...baseSlot,
    interval,
    lastOpenTime: normalizeTimestamp(data?.open_time ?? data?.time ?? data?.timestamp),
    revisionEpoch: revision?.epoch ?? null,
    revisionSequence: revision?.sequence ?? null,
    sequence: revision?.sequence ?? null,
    isClosed: revision?.is_closed ?? null,
  };

  return replaceSymbolState(state, symbol, {
    ...currentSymbolState,
    klineByInterval: {
      ...currentSymbolState.klineByInterval,
      [interval]: nextSlot,
    },
    lastAccessedAtMs: getSnapshotAccessTime(snapshot),
  });
}

export function ingestSnapshot(
  state: SpotPublicMarketStoreState,
  input: SpotMarketSnapshotInput,
): SpotPublicMarketStoreState {
  let nextState = state;
  if (input.ticker) nextState = ingestTicker(nextState, input.ticker);
  if (input.depth) nextState = ingestDepth(nextState, input.depth);
  if (input.trades) nextState = ingestTrade(nextState, input.trades);
  if (input.klineCurrent) nextState = ingestKlineCurrent(nextState, input.klineCurrent);
  return nextState;
}
