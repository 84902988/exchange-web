import type {
  KlineLifecycleProtocolState,
  KlineLifecycleReducerResult,
  KlineLifecycleResetSource,
  KlineLifecycleRetireReason,
  KlineLifecycleSession,
  KlineLifecycleSessionIdentity,
  KlineLifecycleSubscriberEvidence,
  KlineLifecycleTerminalType,
} from './klineLifecycleProtocol';

export const KLINE_LIFECYCLE_OBSERVATION_SCHEMA_VERSION = 1 as const;
export const KLINE_LIFECYCLE_OBSERVATION_CAPACITY = 512;
export const KLINE_LIFECYCLE_SNAPSHOT_CAPACITY = 8;

export type KlineLifecycleObservationEventName =
  | 'REGISTER_INTENT'
  | 'RESOLUTION_APPLIED'
  | 'SUBSCRIBER_READY'
  | 'COMMITTED'
  | 'RETIRED'
  | 'REARM_REQUESTED'
  | 'RESET_EXECUTED';

export type KlineLifecycleObservationSource =
  | 'RUNTIME_COORDINATOR'
  | 'CHART_RESET_EXECUTOR';

export type KlineLifecycleObservationIdentity = Readonly<{
  terminalType: KlineLifecycleTerminalType;
  sessionId: string;
  widgetGeneration: number;
  datafeedInstanceId: number;
  intentId: number;
  symbol: string;
  tradingViewResolution: string;
  backendInterval: string;
  subscriberUid: string | null;
  subscriptionGeneration: number | null;
  ownerId: string | null;
}>;

export type KlineLifecycleObservationMetadata = Readonly<{
  timestamp: number;
  accepted: boolean;
  reason: string;
  retireReason: KlineLifecycleRetireReason | null;
  resetSource: KlineLifecycleResetSource | null;
}>;

export type KlineLifecycleObservationEvent = Readonly<{
  schemaVersion: typeof KLINE_LIFECYCLE_OBSERVATION_SCHEMA_VERSION;
  sequence: number;
  event: KlineLifecycleObservationEventName;
  source: KlineLifecycleObservationSource;
  identity: KlineLifecycleObservationIdentity;
  metadata: KlineLifecycleObservationMetadata;
}>;

export type KlineLifecycleObservationSnapshot = Readonly<{
  widgetIdentity: string;
  sequence: number;
  state: KlineLifecycleProtocolState;
}>;

export type KlineLifecycleObservationStats = Readonly<{
  capacity: number;
  eventCount: number;
  droppedEventCount: number;
  snapshotCount: number;
  oldestSequence: number | null;
  latestSequence: number | null;
}>;

export type KlineLifecycleObservationQuery = Readonly<{
  terminalType?: KlineLifecycleTerminalType;
  widgetGeneration?: number;
  datafeedInstanceId?: number;
  sessionId?: string;
  symbol?: string;
  event?: KlineLifecycleObservationEventName;
  afterSequence?: number;
  limit?: number;
}>;

export type KlineLifecycleDebugAccessor = Readonly<{
  version: typeof KLINE_LIFECYCLE_OBSERVATION_SCHEMA_VERSION;
  enabled: true;
  getEvents: (
    query?: KlineLifecycleObservationQuery,
  ) => readonly KlineLifecycleObservationEvent[];
  getSnapshots: () => readonly KlineLifecycleObservationSnapshot[];
  getStats: () => KlineLifecycleObservationStats;
}>;

export type KlineLifecycleResetSubscriberIdentity = Readonly<{
  subscriberUid: string;
  subscriptionGeneration: number;
  ownerId: string;
}>;

type ObservationIdentityInput =
  | KlineLifecycleSession
  | KlineLifecycleSessionIdentity
  | KlineLifecycleSubscriberEvidence;

type MutableObservationState = {
  events: Array<KlineLifecycleObservationEvent | undefined>;
  writeIndex: number;
  eventCount: number;
  nextSequence: number;
  droppedEventCount: number;
  snapshots: Map<string, KlineLifecycleObservationSnapshot>;
};

declare global {
  interface Window {
    readonly KLINE_LIFECYCLE_DEBUG?: KlineLifecycleDebugAccessor;
    readonly __KLINE_LIFECYCLE_DEBUG__?: KlineLifecycleDebugAccessor;
  }
}

let observationState: MutableObservationState | null = null;

function isDevelopmentQueryEnabled() {
  return Boolean(
    process.env.NODE_ENV === 'development'
    && typeof window !== 'undefined'
    && new URLSearchParams(window.location.search).get('klineLifecycleDebug') === '1',
  );
}

function cloneSession(session: KlineLifecycleSession): KlineLifecycleSession {
  return { ...session };
}

function cloneProtocolState(
  state: KlineLifecycleProtocolState,
): KlineLifecycleProtocolState {
  return {
    latestIntentId: state.latestIntentId,
    candidate: state.candidate ? cloneSession(state.candidate) : null,
    committed: state.committed ? cloneSession(state.committed) : null,
    candidateRearmUsed: state.candidateRearmUsed,
  };
}

function cloneIdentity(
  identity: KlineLifecycleObservationIdentity,
): KlineLifecycleObservationIdentity {
  return { ...identity };
}

function cloneObservationEvent(
  event: KlineLifecycleObservationEvent,
): KlineLifecycleObservationEvent {
  return {
    ...event,
    identity: cloneIdentity(event.identity),
    metadata: { ...event.metadata },
  };
}

function cloneSnapshot(
  snapshot: KlineLifecycleObservationSnapshot,
): KlineLifecycleObservationSnapshot {
  return {
    widgetIdentity: snapshot.widgetIdentity,
    sequence: snapshot.sequence,
    state: cloneProtocolState(snapshot.state),
  };
}

function orderedEvents(state: MutableObservationState) {
  const events: KlineLifecycleObservationEvent[] = [];
  const start = state.eventCount === KLINE_LIFECYCLE_OBSERVATION_CAPACITY
    ? state.writeIndex
    : 0;
  for (let offset = 0; offset < state.eventCount; offset += 1) {
    const event = state.events[
      (start + offset) % KLINE_LIFECYCLE_OBSERVATION_CAPACITY
    ];
    if (event) events.push(event);
  }
  return events;
}

function getEvents(
  state: MutableObservationState,
  query: KlineLifecycleObservationQuery = {},
) {
  const filtered = orderedEvents(state).filter((entry) => (
    (query.terminalType === undefined || entry.identity.terminalType === query.terminalType)
    && (query.widgetGeneration === undefined
      || entry.identity.widgetGeneration === query.widgetGeneration)
    && (query.datafeedInstanceId === undefined
      || entry.identity.datafeedInstanceId === query.datafeedInstanceId)
    && (query.sessionId === undefined || entry.identity.sessionId === query.sessionId)
    && (query.symbol === undefined || entry.identity.symbol === query.symbol)
    && (query.event === undefined || entry.event === query.event)
    && (query.afterSequence === undefined || entry.sequence > query.afterSequence)
  ));
  const requestedLimit = Number.isInteger(query.limit) && Number(query.limit) > 0
    ? Math.min(Number(query.limit), KLINE_LIFECYCLE_OBSERVATION_CAPACITY)
    : filtered.length;
  return filtered.slice(-requestedLimit).map(cloneObservationEvent);
}

function getSnapshots(state: MutableObservationState) {
  return Array.from(state.snapshots.values(), cloneSnapshot);
}

function getStats(state: MutableObservationState): KlineLifecycleObservationStats {
  const events = orderedEvents(state);
  return {
    capacity: KLINE_LIFECYCLE_OBSERVATION_CAPACITY,
    eventCount: state.eventCount,
    droppedEventCount: state.droppedEventCount,
    snapshotCount: state.snapshots.size,
    oldestSequence: events[0]?.sequence ?? null,
    latestSequence: events.at(-1)?.sequence ?? null,
  };
}

function installReadonlyAccessor(state: MutableObservationState) {
  const accessor: KlineLifecycleDebugAccessor = Object.freeze({
    version: KLINE_LIFECYCLE_OBSERVATION_SCHEMA_VERSION,
    enabled: true as const,
    getEvents: (query?: KlineLifecycleObservationQuery) => getEvents(state, query),
    getSnapshots: () => getSnapshots(state),
    getStats: () => getStats(state),
  });
  for (const property of ['KLINE_LIFECYCLE_DEBUG', '__KLINE_LIFECYCLE_DEBUG__'] as const) {
    Object.defineProperty(window, property, {
      configurable: false,
      enumerable: false,
      writable: false,
      value: accessor,
    });
  }
}

function getOrCreateObservationState() {
  if (observationState) return observationState;
  if (!isDevelopmentQueryEnabled()) return null;
  const state: MutableObservationState = {
    events: new Array<KlineLifecycleObservationEvent | undefined>(
      KLINE_LIFECYCLE_OBSERVATION_CAPACITY,
    ),
    writeIndex: 0,
    eventCount: 0,
    nextSequence: 1,
    droppedEventCount: 0,
    snapshots: new Map(),
  };
  installReadonlyAccessor(state);
  observationState = state;
  return state;
}

export function bootstrapKlineLifecycleObservability() {
  try {
    getOrCreateObservationState();
  } catch {
    // Development evidence is optional and cannot block document initialization.
  }
}

function widgetIdentity(identity: KlineLifecycleObservationIdentity) {
  return [
    identity.terminalType,
    identity.widgetGeneration,
    identity.datafeedInstanceId,
  ].join(':');
}

function updateSnapshot(
  state: MutableObservationState,
  identity: KlineLifecycleObservationIdentity,
  sequence: number,
  protocolState?: KlineLifecycleProtocolState,
) {
  if (!protocolState) return;
  const key = widgetIdentity(identity);
  if (state.snapshots.has(key)) state.snapshots.delete(key);
  state.snapshots.set(key, {
    widgetIdentity: key,
    sequence,
    state: cloneProtocolState(protocolState),
  });
  while (state.snapshots.size > KLINE_LIFECYCLE_SNAPSHOT_CAPACITY) {
    const oldestKey = state.snapshots.keys().next().value as string | undefined;
    if (oldestKey === undefined) break;
    state.snapshots.delete(oldestKey);
  }
}

function appendEvent(
  state: MutableObservationState,
  event: KlineLifecycleObservationEventName,
  source: KlineLifecycleObservationSource,
  identity: KlineLifecycleObservationIdentity,
  accepted: boolean,
  reason: string,
  retireReason: KlineLifecycleRetireReason | null,
  resetSource: KlineLifecycleResetSource | null,
  protocolState?: KlineLifecycleProtocolState,
) {
  const sequence = state.nextSequence;
  state.nextSequence += 1;
  const entry: KlineLifecycleObservationEvent = {
    schemaVersion: KLINE_LIFECYCLE_OBSERVATION_SCHEMA_VERSION,
    sequence,
    event,
    source,
    identity,
    metadata: {
      timestamp: Date.now(),
      accepted,
      reason,
      retireReason,
      resetSource,
    },
  };
  state.events[state.writeIndex] = entry;
  state.writeIndex = (
    state.writeIndex + 1
  ) % KLINE_LIFECYCLE_OBSERVATION_CAPACITY;
  if (state.eventCount < KLINE_LIFECYCLE_OBSERVATION_CAPACITY) {
    state.eventCount += 1;
  } else {
    state.droppedEventCount += 1;
  }
  updateSnapshot(state, identity, sequence, protocolState);
}

function findSession(
  input: ObservationIdentityInput,
  decision: KlineLifecycleReducerResult,
) {
  const matches = (session: KlineLifecycleSession | null) => (
    session?.sessionId === input.sessionId ? session : null
  );
  return matches(decision.state.candidate)
    ?? matches(decision.state.committed)
    ?? decision.retired.find((session) => session.sessionId === input.sessionId)
    ?? null;
}

function createObservationIdentity(
  input: ObservationIdentityInput,
  decision?: KlineLifecycleReducerResult,
  subscriber?: KlineLifecycleResetSubscriberIdentity,
): KlineLifecycleObservationIdentity {
  const session = decision ? findSession(input, decision) : null;
  const evidence = 'subscriberUid' in input ? input : null;
  return {
    terminalType: input.terminalType,
    sessionId: input.sessionId,
    widgetGeneration: input.widgetGeneration,
    datafeedInstanceId: input.datafeedInstanceId,
    intentId: input.intentId,
    symbol: input.symbol,
    tradingViewResolution: input.tradingViewResolution,
    backendInterval: input.backendInterval,
    subscriberUid: subscriber?.subscriberUid
      ?? evidence?.subscriberUid
      ?? session?.subscriberUid
      ?? null,
    subscriptionGeneration: subscriber?.subscriptionGeneration
      ?? evidence?.subscriptionGeneration
      ?? session?.subscriptionGeneration
      ?? null,
    ownerId: subscriber?.ownerId ?? evidence?.ownerId ?? session?.ownerId ?? null,
  };
}

function recordRetiredSessions(
  state: MutableObservationState,
  decision: KlineLifecycleReducerResult,
) {
  decision.retired.forEach((session) => {
    appendEvent(
      state,
      'RETIRED',
      'RUNTIME_COORDINATOR',
      createObservationIdentity(session, decision),
      true,
      decision.reason,
      decision.retireReason,
      null,
      decision.state,
    );
  });
}

export function recordKlineLifecycleDecision(
  event: Exclude<KlineLifecycleObservationEventName, 'RESET_EXECUTED'>,
  input: ObservationIdentityInput | null,
  decision: KlineLifecycleReducerResult,
  resetSource: KlineLifecycleResetSource | null = null,
) {
  try {
    const state = getOrCreateObservationState();
    if (!state) return;
    if (event === 'RETIRED') {
      if (decision.retired.length > 0) {
        recordRetiredSessions(state, decision);
      } else if (input) {
        appendEvent(
          state,
          event,
          'RUNTIME_COORDINATOR',
          createObservationIdentity(input, decision),
          decision.accepted,
          decision.reason,
          decision.retireReason,
          resetSource,
          decision.state,
        );
      }
      return;
    }
    if (!input) return;
    appendEvent(
      state,
      event,
      'RUNTIME_COORDINATOR',
      createObservationIdentity(input, decision),
      decision.accepted,
      decision.reason,
      decision.retireReason,
      resetSource,
      decision.state,
    );
    recordRetiredSessions(state, decision);
  } catch {
    // Debug evidence is observational only and must never alter lifecycle timing or decisions.
  }
}

export function recordKlineLifecycleResetExecution(
  identity: KlineLifecycleSessionIdentity,
  resetSource: KlineLifecycleResetSource,
  accepted: boolean,
  reason: string,
  subscriber?: KlineLifecycleResetSubscriberIdentity,
) {
  try {
    const state = getOrCreateObservationState();
    if (!state) return;
    appendEvent(
      state,
      'RESET_EXECUTED',
      'CHART_RESET_EXECUTOR',
      createObservationIdentity(identity, undefined, subscriber),
      accepted,
      reason,
      null,
      resetSource,
    );
  } catch {
    // Reset execution is already complete; debug evidence cannot affect its outcome.
  }
}

bootstrapKlineLifecycleObservability();
