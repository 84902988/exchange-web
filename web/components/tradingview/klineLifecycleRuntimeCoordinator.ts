import {
  createInitialKlineLifecycleProtocolState,
  createKlineLifecycleSession,
  getKlineLifecycleSessionIdentity,
  reduceKlineLifecycle,
  type KlineLifecycleDecisionReason,
  type KlineLifecycleEvent,
  type KlineLifecycleProtocolState,
  type KlineLifecycleReducerResult,
  type KlineLifecycleResetSource,
  type KlineLifecycleRetireReason,
  type KlineLifecycleSession,
  type KlineLifecycleSessionIdentity,
  type KlineLifecycleSubscriberEvidence,
  type KlineLifecycleTerminalType,
} from './klineLifecycleProtocol';
import {
  recordKlineLifecycleDecision,
  recordKlineLifecycleResetExecution,
  type KlineLifecycleObservationEventName,
  type KlineLifecycleResetSubscriberIdentity,
} from './klineLifecycleObservability';

export type KlineLifecycleRuntimeContext = Readonly<{
  terminalType: KlineLifecycleTerminalType;
  widgetGeneration: number;
  datafeedInstanceId: number;
  symbol: string;
}>;

export type KlineLifecycleBeginIntentInput = Readonly<{
  tradingViewResolution: string;
  backendInterval: string;
}>;

export type KlineLifecycleBeginIntentResult = Readonly<{
  identity: KlineLifecycleSessionIdentity;
  decision: KlineLifecycleReducerResult;
}>;

export type KlineLifecycleRearmPermit = Readonly<{
  permitId: string;
  identity: KlineLifecycleSessionIdentity;
  source: KlineLifecycleResetSource;
}>;

export type KlineLifecycleRequestRearmResult = Readonly<{
  allowed: boolean;
  reason: KlineLifecycleDecisionReason;
  permit: KlineLifecycleRearmPermit | null;
  decision: KlineLifecycleReducerResult;
}>;

type RuntimeObservationEvent = Exclude<
  KlineLifecycleObservationEventName,
  'RESET_EXECUTED'
>;

function recordRuntimeDecision(
  event: RuntimeObservationEvent,
  input:
    | KlineLifecycleSession
    | KlineLifecycleSessionIdentity
    | KlineLifecycleSubscriberEvidence
    | null,
  decision: KlineLifecycleReducerResult,
  resetSource: KlineLifecycleResetSource | null = null,
) {
  try {
    recordKlineLifecycleDecision(
      event,
      input,
      decision,
      resetSource,
    );
  } catch {
    // Observability is optional; loading or recording failures are lifecycle no-ops.
  }
}

function recordResetExecution(
  identity: KlineLifecycleSessionIdentity,
  source: KlineLifecycleResetSource,
  accepted: boolean,
  reason: string,
  subscriber?: KlineLifecycleResetSubscriberIdentity,
) {
  try {
    recordKlineLifecycleResetExecution(
      identity,
      source,
      accepted,
      reason,
      subscriber,
    );
  } catch {
    // Reset has already been decided/executed; evidence failure cannot change its result.
  }
}

function isPositiveInteger(value: number) {
  return Number.isInteger(value) && value > 0;
}

function createRuntimeContext(
  context: KlineLifecycleRuntimeContext,
): KlineLifecycleRuntimeContext {
  if (context.terminalType !== 'SPOT' && context.terminalType !== 'CONTRACT') {
    throw new Error('terminalType is invalid');
  }
  if (!isPositiveInteger(context.widgetGeneration)) {
    throw new Error('widgetGeneration must be positive');
  }
  if (!isPositiveInteger(context.datafeedInstanceId)) {
    throw new Error('datafeedInstanceId must be positive');
  }
  const symbol = String(context.symbol || '').trim().toUpperCase();
  if (!symbol) throw new Error('symbol is required');
  return {
    terminalType: context.terminalType,
    widgetGeneration: context.widgetGeneration,
    datafeedInstanceId: context.datafeedInstanceId,
    symbol,
  };
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

function cloneDecision(
  decision: KlineLifecycleReducerResult,
): KlineLifecycleReducerResult {
  return {
    state: cloneProtocolState(decision.state),
    accepted: decision.accepted,
    reason: decision.reason,
    rearmAllowed: decision.rearmAllowed,
    retireReason: decision.retireReason,
    retired: decision.retired.map(cloneSession),
  };
}

function sameSessionIdentity(
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

export class KlineLifecycleRuntimeCoordinator {
  private lifecycleState: KlineLifecycleProtocolState =
    createInitialKlineLifecycleProtocolState();

  private readonly runtimeContext: KlineLifecycleRuntimeContext;

  private intentSequence = 0;

  constructor(context: KlineLifecycleRuntimeContext) {
    this.runtimeContext = createRuntimeContext(context);
  }

  private dispatch(event: KlineLifecycleEvent): KlineLifecycleReducerResult {
    const decision = reduceKlineLifecycle(this.lifecycleState, event);
    this.lifecycleState = decision.state;
    return cloneDecision(decision);
  }

  private rejectedDecision(
    reason: Extract<
      KlineLifecycleDecisionReason,
      'COMMIT_NOT_READY' | 'COMMIT_IDENTITY_MISMATCH'
    >,
  ): KlineLifecycleReducerResult {
    return {
      state: this.snapshot(),
      accepted: false,
      reason,
      rearmAllowed: false,
      retireReason: null,
      retired: [],
    };
  }

  beginIntent(
    input: KlineLifecycleBeginIntentInput,
  ): KlineLifecycleBeginIntentResult {
    const intentId = this.intentSequence + 1;
    const session = createKlineLifecycleSession({
      ...this.runtimeContext,
      intentId,
      tradingViewResolution: input.tradingViewResolution,
      backendInterval: input.backendInterval,
    });
    const decision = this.dispatch({ type: 'REGISTER_INTENT', session });
    if (decision.accepted) this.intentSequence = intentId;
    recordRuntimeDecision('REGISTER_INTENT', session, decision);
    return {
      identity: getKlineLifecycleSessionIdentity(session),
      decision,
    };
  }

  applyResolution(
    identity: KlineLifecycleSessionIdentity,
  ): KlineLifecycleReducerResult {
    const decision = this.dispatch({ type: 'RESOLUTION_APPLIED', identity });
    recordRuntimeDecision('RESOLUTION_APPLIED', identity, decision);
    return decision;
  }

  recordSubscriber(
    evidence: KlineLifecycleSubscriberEvidence,
  ): KlineLifecycleReducerResult {
    const decision = this.dispatch({ type: 'SUBSCRIBER_READY', evidence });
    recordRuntimeDecision('SUBSCRIBER_READY', evidence, decision);
    return decision;
  }

  tryCommit(
    identity: KlineLifecycleSessionIdentity,
  ): KlineLifecycleReducerResult {
    const candidate = this.lifecycleState.candidate;
    if (!candidate) {
      const decision = this.rejectedDecision('COMMIT_NOT_READY');
      recordRuntimeDecision('COMMITTED', identity, decision);
      return decision;
    }
    if (!sameSessionIdentity(candidate, identity)) {
      const decision = this.rejectedDecision('COMMIT_IDENTITY_MISMATCH');
      recordRuntimeDecision('COMMITTED', identity, decision);
      return decision;
    }
    if (candidate.state !== 'SUBSCRIBER_READY' || !hasCompleteSubscriber(candidate)) {
      const decision = this.rejectedDecision('COMMIT_NOT_READY');
      recordRuntimeDecision('COMMITTED', identity, decision);
      return decision;
    }
    const decision = this.dispatch({
      type: 'COMMIT',
      evidence: {
        ...getKlineLifecycleSessionIdentity(candidate),
        subscriberUid: candidate.subscriberUid as string,
        subscriptionGeneration: candidate.subscriptionGeneration as number,
        ownerId: candidate.ownerId as string,
      },
    });
    recordRuntimeDecision('COMMITTED', identity, decision);
    return decision;
  }

  requestRearm(
    identity: KlineLifecycleSessionIdentity,
    source: KlineLifecycleResetSource,
  ): KlineLifecycleRequestRearmResult {
    const decision = this.dispatch({ type: 'REQUEST_REARM', identity, source });
    recordRuntimeDecision('REARM_REQUESTED', identity, decision, source);
    const permit = decision.rearmAllowed
      ? {
          permitId: `${identity.sessionId}:${source}`,
          identity: { ...identity },
          source,
        }
      : null;
    return {
      allowed: decision.rearmAllowed,
      reason: decision.reason,
      permit,
      decision,
    };
  }

  retireSession(
    identity: KlineLifecycleSessionIdentity,
    reason: KlineLifecycleRetireReason,
  ): KlineLifecycleReducerResult {
    const decision = this.dispatch({ type: 'RETIRE_SESSION', identity, reason });
    recordRuntimeDecision('RETIRED', identity, decision);
    return decision;
  }

  retireAll(reason: KlineLifecycleRetireReason): KlineLifecycleReducerResult {
    const decision = this.dispatch({ type: 'RETIRE_ALL', reason });
    recordRuntimeDecision('RETIRED', null, decision);
    return decision;
  }

  recordResetExecution(
    identity: KlineLifecycleSessionIdentity,
    source: KlineLifecycleResetSource,
    accepted: boolean,
    reason: string,
    subscriber?: KlineLifecycleResetSubscriberIdentity,
  ) {
    recordResetExecution(identity, source, accepted, reason, subscriber);
  }

  snapshot(): KlineLifecycleProtocolState {
    return cloneProtocolState(this.lifecycleState);
  }
}
