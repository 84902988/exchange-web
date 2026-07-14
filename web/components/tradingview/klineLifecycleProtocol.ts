export type KlineLifecycleState =
  | 'INTENT_PENDING'
  | 'RESOLUTION_APPLIED'
  | 'SUBSCRIBER_READY'
  | 'COMMITTED'
  | 'RETIRED';

export type KlineLifecycleTerminalType = 'SPOT' | 'CONTRACT';

export type KlineLifecycleSession = Readonly<{
  sessionId: string;
  terminalType: KlineLifecycleTerminalType;
  widgetGeneration: number;
  datafeedInstanceId: number;
  intentId: number;
  symbol: string;
  tradingViewResolution: string;
  backendInterval: string;
  subscriberUid: string | null;
  subscriptionGeneration: number | null;
  ownerId: string | null;
  state: KlineLifecycleState;
}>;

export type KlineLifecycleSessionIdentity = Readonly<Pick<
  KlineLifecycleSession,
  | 'sessionId'
  | 'terminalType'
  | 'widgetGeneration'
  | 'datafeedInstanceId'
  | 'intentId'
  | 'symbol'
  | 'tradingViewResolution'
  | 'backendInterval'
>>;

export type KlineLifecycleSubscriberEvidence = KlineLifecycleSessionIdentity & Readonly<{
  subscriberUid: string;
  subscriptionGeneration: number;
  ownerId: string;
}>;

export type CreateKlineLifecycleSessionInput = Readonly<{
  terminalType: KlineLifecycleTerminalType;
  widgetGeneration: number;
  datafeedInstanceId: number;
  intentId: number;
  symbol: string;
  tradingViewResolution: string;
  backendInterval: string;
}>;

export type KlineLifecycleProtocolState = Readonly<{
  latestIntentId: number | null;
  candidate: KlineLifecycleSession | null;
  committed: KlineLifecycleSession | null;
  candidateRearmUsed: boolean;
}>;

export type KlineLifecycleRetireReason =
  | 'SUPERSEDED'
  | 'RESOLUTION_FAILED'
  | 'SUBSCRIBER_TIMEOUT'
  | 'SUBSCRIBER_RETIRED'
  | 'SYMBOL_SWITCH'
  | 'WIDGET_DESTROY'
  | 'DATAFEED_DESTROY';

export type KlineLifecycleResetSource =
  | 'SUBSCRIBER_MISSING'
  | 'RESTORED_BASELINE';

export type KlineLifecycleEvent =
  | Readonly<{ type: 'REGISTER_INTENT'; session: KlineLifecycleSession }>
  | Readonly<{ type: 'RESOLUTION_APPLIED'; identity: KlineLifecycleSessionIdentity }>
  | Readonly<{ type: 'RESOLUTION_FAILED'; identity: KlineLifecycleSessionIdentity }>
  | Readonly<{ type: 'SUBSCRIBER_READY'; evidence: KlineLifecycleSubscriberEvidence }>
  | Readonly<{ type: 'SUBSCRIBER_TIMEOUT'; identity: KlineLifecycleSessionIdentity }>
  | Readonly<{
      type: 'REQUEST_REARM';
      identity: KlineLifecycleSessionIdentity;
      source?: KlineLifecycleResetSource;
    }>
  | Readonly<{ type: 'COMMIT'; evidence: KlineLifecycleSubscriberEvidence }>
  | Readonly<{
      type: 'RETIRE_SESSION';
      identity: KlineLifecycleSessionIdentity;
      reason: KlineLifecycleRetireReason;
    }>
  | Readonly<{ type: 'RETIRE_ALL'; reason: KlineLifecycleRetireReason }>;

export type KlineLifecycleDecisionReason =
  | 'REGISTERED'
  | 'STALE_INTENT'
  | 'INVALID_SESSION'
  | 'STALE_SESSION'
  | 'RESOLUTION_APPLIED'
  | 'RESOLUTION_ALREADY_APPLIED'
  | 'RESOLUTION_FAILED'
  | 'SUBSCRIBER_RECORDED'
  | 'SUBSCRIBER_READY'
  | 'SUBSCRIBER_ALREADY_READY'
  | 'INVALID_SUBSCRIBER'
  | 'STALE_SUBSCRIBER'
  | 'SUBSCRIBER_TIMEOUT'
  | 'REARM_ALLOWED'
  | 'REARM_ALREADY_USED'
  | 'REARM_NOT_ALLOWED'
  | 'COMMITTED'
  | 'COMMIT_NOT_READY'
  | 'COMMIT_IDENTITY_MISMATCH'
  | 'SESSION_RETIRED'
  | 'ALL_RETIRED'
  | 'NO_ACTIVE_SESSION';

export type KlineLifecycleReducerResult = Readonly<{
  state: KlineLifecycleProtocolState;
  accepted: boolean;
  reason: KlineLifecycleDecisionReason;
  rearmAllowed: boolean;
  retireReason: KlineLifecycleRetireReason | null;
  retired: readonly KlineLifecycleSession[];
}>;

function isPositiveInteger(value: number) {
  return Number.isInteger(value) && value > 0;
}

function normalizeRequiredText(value: string, label: string) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function normalizeSymbol(value: string) {
  return normalizeRequiredText(value, 'symbol').toUpperCase();
}

function isTerminalType(value: unknown): value is KlineLifecycleTerminalType {
  return value === 'SPOT' || value === 'CONTRACT';
}

export function buildKlineLifecycleSessionId({
  terminalType,
  widgetGeneration,
  datafeedInstanceId,
  intentId,
}: Pick<
  CreateKlineLifecycleSessionInput,
  'terminalType' | 'widgetGeneration' | 'datafeedInstanceId' | 'intentId'
>) {
  if (!isTerminalType(terminalType)) throw new Error('terminalType is invalid');
  if (!isPositiveInteger(widgetGeneration)) throw new Error('widgetGeneration must be positive');
  if (!isPositiveInteger(datafeedInstanceId)) throw new Error('datafeedInstanceId must be positive');
  if (!isPositiveInteger(intentId)) throw new Error('intentId must be positive');
  return `${terminalType}:${widgetGeneration}:${datafeedInstanceId}:${intentId}`;
}

export function createKlineLifecycleSession(
  input: CreateKlineLifecycleSessionInput,
): KlineLifecycleSession {
  const terminalType = input.terminalType;
  const widgetGeneration = input.widgetGeneration;
  const datafeedInstanceId = input.datafeedInstanceId;
  const intentId = input.intentId;
  return {
    sessionId: buildKlineLifecycleSessionId({
      terminalType,
      widgetGeneration,
      datafeedInstanceId,
      intentId,
    }),
    terminalType,
    widgetGeneration,
    datafeedInstanceId,
    intentId,
    symbol: normalizeSymbol(input.symbol),
    tradingViewResolution: normalizeRequiredText(
      input.tradingViewResolution,
      'tradingViewResolution',
    ),
    backendInterval: normalizeRequiredText(input.backendInterval, 'backendInterval'),
    subscriberUid: null,
    subscriptionGeneration: null,
    ownerId: null,
    state: 'INTENT_PENDING',
  };
}

export function createInitialKlineLifecycleProtocolState(): KlineLifecycleProtocolState {
  return {
    latestIntentId: null,
    candidate: null,
    committed: null,
    candidateRearmUsed: false,
  };
}

export function getKlineLifecycleSessionIdentity(
  session: KlineLifecycleSession,
): KlineLifecycleSessionIdentity {
  return {
    sessionId: session.sessionId,
    terminalType: session.terminalType,
    widgetGeneration: session.widgetGeneration,
    datafeedInstanceId: session.datafeedInstanceId,
    intentId: session.intentId,
    symbol: session.symbol,
    tradingViewResolution: session.tradingViewResolution,
    backendInterval: session.backendInterval,
  };
}

function cloneSession(
  session: KlineLifecycleSession,
  state: KlineLifecycleState = session.state,
): KlineLifecycleSession {
  return {
    sessionId: session.sessionId,
    terminalType: session.terminalType,
    widgetGeneration: session.widgetGeneration,
    datafeedInstanceId: session.datafeedInstanceId,
    intentId: session.intentId,
    symbol: session.symbol,
    tradingViewResolution: session.tradingViewResolution,
    backendInterval: session.backendInterval,
    subscriberUid: session.subscriberUid,
    subscriptionGeneration: session.subscriptionGeneration,
    ownerId: session.ownerId,
    state,
  };
}

function retireSession(session: KlineLifecycleSession) {
  return cloneSession(session, 'RETIRED');
}

function matchesSessionIdentity(
  session: KlineLifecycleSession,
  identity: KlineLifecycleSessionIdentity,
) {
  return (
    session.sessionId === identity.sessionId
    && session.terminalType === identity.terminalType
    && session.widgetGeneration === identity.widgetGeneration
    && session.datafeedInstanceId === identity.datafeedInstanceId
    && session.intentId === identity.intentId
    && session.symbol === identity.symbol
    && session.tradingViewResolution === identity.tradingViewResolution
    && session.backendInterval === identity.backendInterval
  );
}

function hasCompleteSubscriber(session: KlineLifecycleSession) {
  return Boolean(
    session.subscriberUid
    && session.ownerId
    && session.subscriptionGeneration !== null
    && isPositiveInteger(session.subscriptionGeneration),
  );
}

function isValidSubscriberEvidence(evidence: KlineLifecycleSubscriberEvidence) {
  return Boolean(
    String(evidence.subscriberUid || '').trim()
    && String(evidence.ownerId || '').trim()
    && isPositiveInteger(evidence.subscriptionGeneration),
  );
}

function matchesSubscriberEvidence(
  session: KlineLifecycleSession,
  evidence: KlineLifecycleSubscriberEvidence,
) {
  return (
    matchesSessionIdentity(session, evidence)
    && session.subscriberUid === evidence.subscriberUid
    && session.subscriptionGeneration === evidence.subscriptionGeneration
    && session.ownerId === evidence.ownerId
  );
}

function isValidRegisteredSession(session: KlineLifecycleSession) {
  if (!isTerminalType(session.terminalType)) return false;
  if (
    !isPositiveInteger(session.widgetGeneration)
    || !isPositiveInteger(session.datafeedInstanceId)
    || !isPositiveInteger(session.intentId)
  ) return false;
  if (
    !String(session.symbol || '').trim()
    || !String(session.tradingViewResolution || '').trim()
    || !String(session.backendInterval || '').trim()
  ) return false;
  if (
    session.state !== 'INTENT_PENDING'
    || session.subscriberUid !== null
    || session.subscriptionGeneration !== null
    || session.ownerId !== null
  ) return false;
  try {
    return session.sessionId === buildKlineLifecycleSessionId(session);
  } catch {
    return false;
  }
}

function result(
  state: KlineLifecycleProtocolState,
  accepted: boolean,
  reason: KlineLifecycleDecisionReason,
  options: {
    rearmAllowed?: boolean;
    retireReason?: KlineLifecycleRetireReason | null;
    retired?: readonly KlineLifecycleSession[];
  } = {},
): KlineLifecycleReducerResult {
  return {
    state,
    accepted,
    reason,
    rearmAllowed: options.rearmAllowed ?? false,
    retireReason: options.retireReason ?? null,
    retired: options.retired ? [...options.retired] : [],
  };
}

function currentCandidate(
  state: KlineLifecycleProtocolState,
  identity: KlineLifecycleSessionIdentity,
) {
  const candidate = state.candidate;
  if (!candidate) return null;
  if (candidate.intentId !== state.latestIntentId) return null;
  return matchesSessionIdentity(candidate, identity) ? candidate : null;
}

export function reduceKlineLifecycle(
  state: KlineLifecycleProtocolState,
  event: KlineLifecycleEvent,
): KlineLifecycleReducerResult {
  switch (event.type) {
    case 'REGISTER_INTENT': {
      if (!isValidRegisteredSession(event.session)) {
        return result(state, false, 'INVALID_SESSION');
      }
      if (state.latestIntentId !== null && event.session.intentId <= state.latestIntentId) {
        return result(state, false, 'STALE_INTENT');
      }
      const retired = state.candidate ? [retireSession(state.candidate)] : [];
      return result({
        latestIntentId: event.session.intentId,
        candidate: cloneSession(event.session),
        committed: state.committed,
        candidateRearmUsed: false,
      }, true, 'REGISTERED', {
        retireReason: retired.length ? 'SUPERSEDED' : null,
        retired,
      });
    }

    case 'RESOLUTION_APPLIED': {
      const candidate = currentCandidate(state, event.identity);
      if (!candidate) return result(state, false, 'STALE_SESSION');
      if (candidate.state !== 'INTENT_PENDING') {
        return result(state, false, 'RESOLUTION_ALREADY_APPLIED');
      }
      const nextState: KlineLifecycleState = hasCompleteSubscriber(candidate)
        ? 'SUBSCRIBER_READY'
        : 'RESOLUTION_APPLIED';
      return result({
        ...state,
        candidate: cloneSession(candidate, nextState),
      }, true, nextState === 'SUBSCRIBER_READY' ? 'SUBSCRIBER_READY' : 'RESOLUTION_APPLIED');
    }

    case 'RESOLUTION_FAILED': {
      const candidate = currentCandidate(state, event.identity);
      if (!candidate) return result(state, false, 'STALE_SESSION');
      if (candidate.state !== 'INTENT_PENDING') {
        return result(state, false, 'RESOLUTION_ALREADY_APPLIED');
      }
      return result({
        ...state,
        candidate: null,
        candidateRearmUsed: false,
      }, true, 'RESOLUTION_FAILED', {
        retireReason: 'RESOLUTION_FAILED',
        retired: [retireSession(candidate)],
      });
    }

    case 'SUBSCRIBER_READY': {
      if (!isValidSubscriberEvidence(event.evidence)) {
        return result(state, false, 'INVALID_SUBSCRIBER');
      }
      const candidate = currentCandidate(state, event.evidence);
      if (!candidate) return result(state, false, 'STALE_SESSION');
      if (candidate.subscriptionGeneration !== null) {
        if (event.evidence.subscriptionGeneration < candidate.subscriptionGeneration) {
          return result(state, false, 'STALE_SUBSCRIBER');
        }
        if (event.evidence.subscriptionGeneration === candidate.subscriptionGeneration) {
          if (!matchesSubscriberEvidence(candidate, event.evidence)) {
            return result(state, false, 'INVALID_SUBSCRIBER');
          }
          return result(state, false, 'SUBSCRIBER_ALREADY_READY');
        }
      }
      const nextState: KlineLifecycleState = candidate.state === 'RESOLUTION_APPLIED'
        || candidate.state === 'SUBSCRIBER_READY'
        ? 'SUBSCRIBER_READY'
        : 'INTENT_PENDING';
      const nextCandidate: KlineLifecycleSession = {
        ...candidate,
        subscriberUid: event.evidence.subscriberUid,
        subscriptionGeneration: event.evidence.subscriptionGeneration,
        ownerId: event.evidence.ownerId,
        state: nextState,
      };
      return result({
        ...state,
        candidate: nextCandidate,
      }, true, nextState === 'SUBSCRIBER_READY' ? 'SUBSCRIBER_READY' : 'SUBSCRIBER_RECORDED');
    }

    case 'SUBSCRIBER_TIMEOUT': {
      const candidate = currentCandidate(state, event.identity);
      if (!candidate) return result(state, false, 'STALE_SESSION');
      if (hasCompleteSubscriber(candidate)) {
        return result(state, false, 'SUBSCRIBER_ALREADY_READY');
      }
      return result({
        ...state,
        candidate: null,
        candidateRearmUsed: false,
      }, true, 'SUBSCRIBER_TIMEOUT', {
        retireReason: 'SUBSCRIBER_TIMEOUT',
        retired: [retireSession(candidate)],
      });
    }

    case 'REQUEST_REARM': {
      const candidate = currentCandidate(state, event.identity);
      if (!candidate) return result(state, false, 'STALE_SESSION');
      if (candidate.state !== 'RESOLUTION_APPLIED' || hasCompleteSubscriber(candidate)) {
        return result(state, false, 'REARM_NOT_ALLOWED');
      }
      if (state.candidateRearmUsed) {
        return result(state, false, 'REARM_ALREADY_USED');
      }
      return result({
        ...state,
        candidate: cloneSession(candidate),
        candidateRearmUsed: true,
      }, true, 'REARM_ALLOWED', { rearmAllowed: true });
    }

    case 'COMMIT': {
      if (!isValidSubscriberEvidence(event.evidence)) {
        return result(state, false, 'INVALID_SUBSCRIBER');
      }
      const candidate = state.candidate;
      if (!candidate || candidate.intentId !== state.latestIntentId) {
        return result(state, false, 'COMMIT_NOT_READY');
      }
      if (!matchesSessionIdentity(candidate, event.evidence)) {
        return result(state, false, 'COMMIT_IDENTITY_MISMATCH');
      }
      if (candidate.state !== 'SUBSCRIBER_READY' || !hasCompleteSubscriber(candidate)) {
        return result(state, false, 'COMMIT_NOT_READY');
      }
      if (!matchesSubscriberEvidence(candidate, event.evidence)) {
        return result(state, false, 'COMMIT_IDENTITY_MISMATCH');
      }
      const retired = state.committed ? [retireSession(state.committed)] : [];
      return result({
        latestIntentId: state.latestIntentId,
        candidate: null,
        committed: cloneSession(candidate, 'COMMITTED'),
        candidateRearmUsed: false,
      }, true, 'COMMITTED', {
        retireReason: retired.length ? 'SUPERSEDED' : null,
        retired,
      });
    }

    case 'RETIRE_SESSION': {
      if (state.candidate && matchesSessionIdentity(state.candidate, event.identity)) {
        return result({
          ...state,
          candidate: null,
          candidateRearmUsed: false,
        }, true, 'SESSION_RETIRED', {
          retireReason: event.reason,
          retired: [retireSession(state.candidate)],
        });
      }
      if (state.committed && matchesSessionIdentity(state.committed, event.identity)) {
        return result({
          ...state,
          committed: null,
        }, true, 'SESSION_RETIRED', {
          retireReason: event.reason,
          retired: [retireSession(state.committed)],
        });
      }
      return result(state, false, 'STALE_SESSION');
    }

    case 'RETIRE_ALL': {
      const retired = [state.candidate, state.committed]
        .filter((session): session is KlineLifecycleSession => Boolean(session))
        .map(retireSession);
      const nextState = createInitialKlineLifecycleProtocolState();
      if (!retired.length && state.latestIntentId === null && !state.candidateRearmUsed) {
        return result(state, false, 'NO_ACTIVE_SESSION');
      }
      return result(nextState, true, 'ALL_RETIRED', {
        retireReason: event.reason,
        retired,
      });
    }
  }
}
