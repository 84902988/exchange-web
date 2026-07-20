export type SpotTradingViewRealtimeSyncState = Readonly<{
  symbol: string;
  interval: string;
  widgetGeneration: number;
  historyReady: boolean;
  subscriberReady: boolean;
  pending: boolean;
}>;

export type SpotTradingViewRealtimeSyncScope = Readonly<{
  symbol: string;
  interval: string;
  widgetGeneration: number;
}>;

export type SpotTradingViewHistorySettlement = SpotTradingViewRealtimeSyncScope & Readonly<{
  phase: 'current' | 'history';
  isHistoryRequest: boolean;
  barCount: number;
}>;

export type SpotTradingViewSubscriberSettlement = SpotTradingViewRealtimeSyncScope & Readonly<{
  subscriberUid: string;
  subscriptionGeneration: number;
  ownerId: string;
}>;

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
  const pending = Boolean(normalized.symbol && normalized.interval && normalized.widgetGeneration);
  return {
    ...normalized,
    historyReady: false,
    subscriberReady: false,
    pending,
  };
}

function matchesActiveScope(
  state: SpotTradingViewRealtimeSyncState,
  event: SpotTradingViewRealtimeSyncScope,
) {
  const normalizedEvent = normalizeScope(event);
  return (
    normalizedEvent.symbol !== state.symbol
    ? false
    : normalizedEvent.interval === state.interval
      && normalizedEvent.widgetGeneration === state.widgetGeneration
  );
}

function withSettlement(
  state: SpotTradingViewRealtimeSyncState,
  patch: Partial<Pick<SpotTradingViewRealtimeSyncState, 'historyReady' | 'subscriberReady'>>,
): SpotTradingViewRealtimeSyncState {
  const historyReady = patch.historyReady ?? state.historyReady;
  const subscriberReady = patch.subscriberReady ?? state.subscriberReady;
  if (
    historyReady === state.historyReady
    && subscriberReady === state.subscriberReady
  ) return state;
  return {
    ...state,
    historyReady,
    subscriberReady,
    pending: !(historyReady && subscriberReady),
  };
}

export function recordSpotTradingViewHistorySettlement(
  state: SpotTradingViewRealtimeSyncState,
  event: SpotTradingViewHistorySettlement,
): SpotTradingViewRealtimeSyncState {
  if (
    !state.pending
    || !matchesActiveScope(state, event)
    || event.phase !== 'current'
    || event.isHistoryRequest
    || !Number.isFinite(event.barCount)
    || event.barCount <= 0
  ) {
    return state;
  }
  return withSettlement(state, { historyReady: true });
}

export function recordSpotTradingViewSubscriberSettlement(
  state: SpotTradingViewRealtimeSyncState,
  event: SpotTradingViewSubscriberSettlement,
): SpotTradingViewRealtimeSyncState {
  if (
    !state.pending
    || !matchesActiveScope(state, event)
    || !String(event.subscriberUid || '').trim()
    || !String(event.ownerId || '').trim()
    || !Number.isInteger(event.subscriptionGeneration)
    || event.subscriptionGeneration <= 0
  ) {
    return state;
  }
  return withSettlement(state, { subscriberReady: true });
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
