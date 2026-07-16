export const SPOT_REALTIME_SYNC_MAX_EVENT_AGE_MS = 10_000;

export type SpotTradingViewRealtimeSyncState = Readonly<{
  symbol: string;
  interval: string;
  widgetGeneration: number;
  pending: boolean;
}>;

export type SpotTradingViewRealtimeSyncScope = Readonly<{
  symbol: string;
  interval: string;
  widgetGeneration: number;
}>;

export type SpotTradingViewRealtimeSyncEvent = SpotTradingViewRealtimeSyncScope & Readonly<{
  source: string;
  freshness: string;
  receivedAtMs: number;
}>;

const NON_REALTIME_SOURCES = new Set([
  'REST_HISTORY',
  'REST_SNAPSHOT',
  'DB_CACHE',
  'LAST_GOOD',
  'MISSING',
]);

const NON_REALTIME_FRESHNESS = new Set([
  'CACHED',
  'STALE',
  'LAST_GOOD',
  'MISSING',
]);

function normalizeSymbol(value: unknown): string {
  return String(value ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function normalizeInterval(value: unknown): string {
  return String(value ?? '').trim();
}

function normalizeScope(scope: SpotTradingViewRealtimeSyncScope): SpotTradingViewRealtimeSyncScope {
  return {
    symbol: normalizeSymbol(scope.symbol),
    interval: normalizeInterval(scope.interval),
    widgetGeneration: Number.isInteger(scope.widgetGeneration) && scope.widgetGeneration > 0
      ? scope.widgetGeneration
      : 0,
  };
}

export function beginSpotTradingViewRealtimeSync(
  scope: SpotTradingViewRealtimeSyncScope,
): SpotTradingViewRealtimeSyncState {
  const normalized = normalizeScope(scope);
  return {
    ...normalized,
    pending: Boolean(normalized.symbol && normalized.interval && normalized.widgetGeneration),
  };
}

export function settleSpotTradingViewRealtimeSync(
  state: SpotTradingViewRealtimeSyncState,
  event: SpotTradingViewRealtimeSyncEvent,
  nowMs = Date.now(),
): SpotTradingViewRealtimeSyncState {
  if (!state.pending) return state;

  const normalizedEvent = normalizeScope(event);
  if (
    normalizedEvent.symbol !== state.symbol
    || normalizedEvent.interval !== state.interval
    || normalizedEvent.widgetGeneration !== state.widgetGeneration
  ) {
    return state;
  }

  const source = String(event.source || '').trim().toUpperCase();
  const freshness = String(event.freshness || '').trim().toUpperCase();
  if (NON_REALTIME_SOURCES.has(source) || NON_REALTIME_FRESHNESS.has(freshness)) {
    return state;
  }

  const receivedAtMs = Number(event.receivedAtMs);
  const eventAgeMs = Number(nowMs) - receivedAtMs;
  if (
    !Number.isFinite(receivedAtMs)
    || receivedAtMs <= 0
    || !Number.isFinite(eventAgeMs)
    || eventAgeMs > SPOT_REALTIME_SYNC_MAX_EVENT_AGE_MS
  ) {
    return state;
  }

  return { ...state, pending: false };
}

export function isSpotTradingViewRealtimeSyncPending(
  state: SpotTradingViewRealtimeSyncState,
  scope: SpotTradingViewRealtimeSyncScope,
): boolean {
  if (!state.pending) return false;
  const normalized = normalizeScope(scope);
  return (
    state.symbol === normalized.symbol
    && state.interval === normalized.interval
    && state.widgetGeneration === normalized.widgetGeneration
  );
}
