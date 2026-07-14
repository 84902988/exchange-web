import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  createInitialKlineLifecycleProtocolState,
  createKlineLifecycleSession,
  getKlineLifecycleSessionIdentity,
  reduceKlineLifecycle,
  type CreateKlineLifecycleSessionInput,
  type KlineLifecycleProtocolState,
  type KlineLifecycleSession,
  type KlineLifecycleSubscriberEvidence,
} from './klineLifecycleProtocol.ts';

function createSession(
  overrides: Partial<CreateKlineLifecycleSessionInput> = {},
): KlineLifecycleSession {
  return createKlineLifecycleSession({
    terminalType: 'SPOT',
    widgetGeneration: 1,
    datafeedInstanceId: 10,
    intentId: 1,
    symbol: 'BTCUSDT',
    tradingViewResolution: '1',
    backendInterval: '1m',
    ...overrides,
  });
}

function subscriberEvidence(
  session: KlineLifecycleSession,
  overrides: Partial<KlineLifecycleSubscriberEvidence> = {},
): KlineLifecycleSubscriberEvidence {
  return {
    ...getKlineLifecycleSessionIdentity(session),
    subscriberUid: `subscriber-${session.intentId}`,
    subscriptionGeneration: session.intentId,
    ownerId: `owner-${session.intentId}`,
    ...overrides,
  };
}

function register(
  state: KlineLifecycleProtocolState,
  session: KlineLifecycleSession,
) {
  const decision = reduceKlineLifecycle(state, { type: 'REGISTER_INTENT', session });
  assert.equal(decision.accepted, true);
  return decision.state;
}

function applyResolution(
  state: KlineLifecycleProtocolState,
  session: KlineLifecycleSession,
) {
  const decision = reduceKlineLifecycle(state, {
    type: 'RESOLUTION_APPLIED',
    identity: getKlineLifecycleSessionIdentity(session),
  });
  assert.equal(decision.accepted, true);
  return decision.state;
}

function applySubscriber(
  state: KlineLifecycleProtocolState,
  evidence: KlineLifecycleSubscriberEvidence,
) {
  const decision = reduceKlineLifecycle(state, { type: 'SUBSCRIBER_READY', evidence });
  assert.equal(decision.accepted, true);
  return decision.state;
}

function commitCandidate(
  state: KlineLifecycleProtocolState,
  evidence: KlineLifecycleSubscriberEvidence,
) {
  const decision = reduceKlineLifecycle(state, { type: 'COMMIT', evidence });
  assert.equal(decision.accepted, true);
  return decision;
}

function createCommitted(
  session: KlineLifecycleSession = createSession(),
) {
  const evidence = subscriberEvidence(session);
  let state = createInitialKlineLifecycleProtocolState();
  state = register(state, session);
  state = applyResolution(state, session);
  state = applySubscriber(state, evidence);
  const decision = commitCandidate(state, evidence);
  return { state: decision.state, session, evidence };
}

function activeSessionCount(state: KlineLifecycleProtocolState) {
  return Number(Boolean(state.candidate)) + Number(Boolean(state.committed));
}

test('protocol source has no runtime owner, timer, websocket, or reset side effects', () => {
  const filePath = fileURLToPath(new URL('./klineLifecycleProtocol.ts', import.meta.url));
  const source = readFileSync(filePath, 'utf8');
  assert.doesNotMatch(source, /^\s*import\s/m);
  assert.doesNotMatch(
    source,
    /\b(React|setTimeout|setInterval|WebSocket|subscribeBars|unsubscribeBars|resetData|onRealtimeCallback)\b/,
  );
});

test('latest interval intent wins and superseded candidates are returned but not stored', () => {
  const oneMinute = createSession({ intentId: 1 });
  const fiveMinutes = createSession({
    intentId: 2,
    tradingViewResolution: '5',
    backendInterval: '5m',
  });
  const oneDay = createSession({
    intentId: 3,
    tradingViewResolution: '1D',
    backendInterval: '1d',
  });
  let state = createInitialKlineLifecycleProtocolState();
  state = register(state, oneMinute);

  const second = reduceKlineLifecycle(state, { type: 'REGISTER_INTENT', session: fiveMinutes });
  assert.equal(second.accepted, true);
  assert.equal(second.retired[0]?.sessionId, oneMinute.sessionId);
  assert.equal(second.retired[0]?.state, 'RETIRED');
  state = second.state;

  const third = reduceKlineLifecycle(state, { type: 'REGISTER_INTENT', session: oneDay });
  assert.equal(third.accepted, true);
  assert.equal(third.retired[0]?.sessionId, fiveMinutes.sessionId);
  assert.equal(third.state.latestIntentId, 3);
  assert.equal(third.state.candidate?.sessionId, oneDay.sessionId);
  assert.equal(activeSessionCount(third.state), 1);
  assert.equal('retired' in third.state, false);
});

test('stale intent is ignored without changing the latest candidate', () => {
  const latest = createSession({ intentId: 3 });
  const stale = createSession({ intentId: 2 });
  const state = register(createInitialKlineLifecycleProtocolState(), latest);
  const decision = reduceKlineLifecycle(state, { type: 'REGISTER_INTENT', session: stale });
  assert.equal(decision.accepted, false);
  assert.equal(decision.reason, 'STALE_INTENT');
  assert.deepEqual(decision.state, state);
  assert.equal(decision.retired.length, 0);
});

test('resolution before subscriber reaches subscriber ready only after valid evidence', () => {
  const session = createSession();
  const evidence = subscriberEvidence(session);
  let state = register(createInitialKlineLifecycleProtocolState(), session);
  state = applyResolution(state, session);
  assert.equal(state.candidate?.state, 'RESOLUTION_APPLIED');
  state = applySubscriber(state, evidence);
  assert.equal(state.candidate?.state, 'SUBSCRIBER_READY');
  assert.equal(state.candidate?.subscriberUid, evidence.subscriberUid);
  assert.equal(state.candidate?.ownerId, evidence.ownerId);
});

test('subscriber before resolution is recorded but cannot advance state until resolution applies', () => {
  const session = createSession();
  const evidence = subscriberEvidence(session);
  let state = register(createInitialKlineLifecycleProtocolState(), session);
  state = applySubscriber(state, evidence);
  assert.equal(state.candidate?.state, 'INTENT_PENDING');
  assert.equal(state.candidate?.subscriptionGeneration, evidence.subscriptionGeneration);
  state = applyResolution(state, session);
  assert.equal(state.candidate?.state, 'SUBSCRIBER_READY');
});

test('stale resolution cannot advance or retire the current candidate', () => {
  const oldSession = createSession({ intentId: 1, widgetGeneration: 1 });
  const currentSession = createSession({ intentId: 2, widgetGeneration: 2 });
  let state = register(createInitialKlineLifecycleProtocolState(), oldSession);
  state = register(state, currentSession);
  const decision = reduceKlineLifecycle(state, {
    type: 'RESOLUTION_APPLIED',
    identity: getKlineLifecycleSessionIdentity(oldSession),
  });
  assert.equal(decision.accepted, false);
  assert.equal(decision.reason, 'STALE_SESSION');
  assert.deepEqual(decision.state, state);
  assert.equal(decision.state.candidate?.state, 'INTENT_PENDING');
});

test('resolution failure retires only the candidate and preserves committed state', () => {
  const committed = createCommitted();
  const candidate = createSession({
    intentId: 2,
    tradingViewResolution: '5',
    backendInterval: '5m',
  });
  const state = register(committed.state, candidate);
  const decision = reduceKlineLifecycle(state, {
    type: 'RESOLUTION_FAILED',
    identity: getKlineLifecycleSessionIdentity(candidate),
  });
  assert.equal(decision.accepted, true);
  assert.equal(decision.reason, 'RESOLUTION_FAILED');
  assert.equal(decision.state.candidate, null);
  assert.equal(decision.state.committed?.sessionId, committed.session.sessionId);
  assert.equal(decision.retired[0]?.sessionId, candidate.sessionId);
});

test('subscriber timeout retires an unresolved candidate and keeps the old commit', () => {
  const committed = createCommitted();
  const candidate = createSession({ intentId: 2 });
  let state = register(committed.state, candidate);
  state = applyResolution(state, candidate);
  const decision = reduceKlineLifecycle(state, {
    type: 'SUBSCRIBER_TIMEOUT',
    identity: getKlineLifecycleSessionIdentity(candidate),
  });
  assert.equal(decision.accepted, true);
  assert.equal(decision.reason, 'SUBSCRIBER_TIMEOUT');
  assert.equal(decision.state.candidate, null);
  assert.equal(decision.state.committed?.sessionId, committed.session.sessionId);
  assert.equal(decision.retired[0]?.state, 'RETIRED');
});

test('invalid and rollback subscription generations are rejected', () => {
  const session = createSession();
  let state = register(createInitialKlineLifecycleProtocolState(), session);
  state = applyResolution(state, session);
  const invalid = reduceKlineLifecycle(state, {
    type: 'SUBSCRIBER_READY',
    evidence: subscriberEvidence(session, { subscriptionGeneration: 0 }),
  });
  assert.equal(invalid.accepted, false);
  assert.equal(invalid.reason, 'INVALID_SUBSCRIBER');
  assert.deepEqual(invalid.state, state);

  const generationTwo = subscriberEvidence(session, { subscriptionGeneration: 2 });
  state = applySubscriber(state, generationTwo);
  const rollback = reduceKlineLifecycle(state, {
    type: 'SUBSCRIBER_READY',
    evidence: subscriberEvidence(session, { subscriptionGeneration: 1 }),
  });
  assert.equal(rollback.accepted, false);
  assert.equal(rollback.reason, 'STALE_SUBSCRIBER');
  assert.equal(rollback.state.candidate?.subscriptionGeneration, 2);
});

test('only subscriber-ready candidate can commit', () => {
  const session = createSession();
  const evidence = subscriberEvidence(session);
  let state = register(createInitialKlineLifecycleProtocolState(), session);
  const pendingCommit = reduceKlineLifecycle(state, { type: 'COMMIT', evidence });
  assert.equal(pendingCommit.accepted, false);
  assert.equal(pendingCommit.reason, 'COMMIT_NOT_READY');

  state = applyResolution(state, session);
  const resolutionOnlyCommit = reduceKlineLifecycle(state, { type: 'COMMIT', evidence });
  assert.equal(resolutionOnlyCommit.accepted, false);
  assert.equal(resolutionOnlyCommit.reason, 'COMMIT_NOT_READY');

  state = applySubscriber(state, evidence);
  const committed = reduceKlineLifecycle(state, { type: 'COMMIT', evidence });
  assert.equal(committed.accepted, true);
  assert.equal(committed.state.candidate, null);
  assert.equal(committed.state.committed?.state, 'COMMITTED');
});

test('new commit atomically retires the old committed session', () => {
  const first = createCommitted();
  const secondSession = createSession({
    intentId: 2,
    tradingViewResolution: '5',
    backendInterval: '5m',
  });
  const secondEvidence = subscriberEvidence(secondSession, { subscriptionGeneration: 2 });
  let state = register(first.state, secondSession);
  state = applyResolution(state, secondSession);
  state = applySubscriber(state, secondEvidence);
  const decision = commitCandidate(state, secondEvidence);
  assert.equal(decision.retired.length, 1);
  assert.equal(decision.retired[0]?.sessionId, first.session.sessionId);
  assert.equal(decision.retired[0]?.state, 'RETIRED');
  assert.equal(decision.state.committed?.sessionId, secondSession.sessionId);
  assert.equal(activeSessionCount(decision.state), 1);
});

test('commit rejects mismatched symbol resolution subscriber and owner identity', () => {
  const session = createSession();
  const evidence = subscriberEvidence(session);
  let state = register(createInitialKlineLifecycleProtocolState(), session);
  state = applyResolution(state, session);
  state = applySubscriber(state, evidence);

  const invalidEvidence: KlineLifecycleSubscriberEvidence[] = [
    { ...evidence, symbol: 'ETHUSDT' },
    { ...evidence, tradingViewResolution: '5' },
    { ...evidence, subscriberUid: 'wrong-subscriber' },
    { ...evidence, ownerId: 'wrong-owner' },
    { ...evidence, subscriptionGeneration: evidence.subscriptionGeneration + 1 },
  ];
  for (const invalid of invalidEvidence) {
    const decision = reduceKlineLifecycle(state, { type: 'COMMIT', evidence: invalid });
    assert.equal(decision.accepted, false);
    assert.equal(decision.reason, 'COMMIT_IDENTITY_MISMATCH');
    assert.deepEqual(decision.state, state);
  }
});

test('symbol switch retires candidate and committed without storing retired sessions', () => {
  const committed = createCommitted();
  const candidate = createSession({ intentId: 2 });
  const state = register(committed.state, candidate);
  assert.equal(activeSessionCount(state), 2);
  const decision = reduceKlineLifecycle(state, {
    type: 'RETIRE_ALL',
    reason: 'SYMBOL_SWITCH',
  });
  assert.equal(decision.accepted, true);
  assert.equal(decision.retired.length, 2);
  assert.deepEqual(decision.state, createInitialKlineLifecycleProtocolState());
  assert.equal('retired' in decision.state, false);
});

test('retire session removes only the matching lifecycle slot', () => {
  const committed = createCommitted();
  const candidate = createSession({ intentId: 2 });
  let state = register(committed.state, candidate);
  const retireCandidate = reduceKlineLifecycle(state, {
    type: 'RETIRE_SESSION',
    identity: getKlineLifecycleSessionIdentity(candidate),
    reason: 'SUBSCRIBER_RETIRED',
  });
  assert.equal(retireCandidate.accepted, true);
  assert.equal(retireCandidate.state.candidate, null);
  assert.equal(retireCandidate.state.committed?.sessionId, committed.session.sessionId);
  assert.equal(retireCandidate.retired[0]?.sessionId, candidate.sessionId);
  state = retireCandidate.state;

  const retireCommitted = reduceKlineLifecycle(state, {
    type: 'RETIRE_SESSION',
    identity: getKlineLifecycleSessionIdentity(committed.session),
    reason: 'DATAFEED_DESTROY',
  });
  assert.equal(retireCommitted.accepted, true);
  assert.equal(retireCommitted.state.committed, null);
  assert.equal(activeSessionCount(retireCommitted.state), 0);
});

test('widget destroy makes every late callback harmless', () => {
  const session = createSession();
  const evidence = subscriberEvidence(session);
  const state = register(createInitialKlineLifecycleProtocolState(), session);
  const destroyed = reduceKlineLifecycle(state, {
    type: 'RETIRE_ALL',
    reason: 'WIDGET_DESTROY',
  });
  assert.equal(destroyed.accepted, true);
  const lateResolution = reduceKlineLifecycle(destroyed.state, {
    type: 'RESOLUTION_APPLIED',
    identity: getKlineLifecycleSessionIdentity(session),
  });
  const lateSubscriber = reduceKlineLifecycle(destroyed.state, {
    type: 'SUBSCRIBER_READY',
    evidence,
  });
  const lateCommit = reduceKlineLifecycle(destroyed.state, { type: 'COMMIT', evidence });
  assert.equal(lateResolution.accepted, false);
  assert.equal(lateSubscriber.accepted, false);
  assert.equal(lateCommit.accepted, false);
  assert.deepEqual(lateCommit.state, destroyed.state);
});

test('old widget generation callback cannot affect the replacement generation', () => {
  const oldSession = createSession({ widgetGeneration: 1, datafeedInstanceId: 10 });
  let state = register(createInitialKlineLifecycleProtocolState(), oldSession);
  state = reduceKlineLifecycle(state, {
    type: 'RETIRE_ALL',
    reason: 'WIDGET_DESTROY',
  }).state;
  const replacement = createSession({ widgetGeneration: 2, datafeedInstanceId: 11 });
  state = register(state, replacement);
  const before = state;
  const lateResolution = reduceKlineLifecycle(state, {
    type: 'RESOLUTION_APPLIED',
    identity: getKlineLifecycleSessionIdentity(oldSession),
  });
  const lateSubscriber = reduceKlineLifecycle(state, {
    type: 'SUBSCRIBER_READY',
    evidence: subscriberEvidence(oldSession),
  });
  assert.equal(lateResolution.accepted, false);
  assert.equal(lateSubscriber.accepted, false);
  assert.deepEqual(lateResolution.state, before);
  assert.deepEqual(lateSubscriber.state, before);
  assert.equal(before.candidate?.sessionId, replacement.sessionId);
});

test('rearm is one-shot and repeated requests cannot create a reset loop', () => {
  const session = createSession();
  let state = register(createInitialKlineLifecycleProtocolState(), session);
  state = applyResolution(state, session);
  const identity = getKlineLifecycleSessionIdentity(session);
  const first = reduceKlineLifecycle(state, { type: 'REQUEST_REARM', identity });
  assert.equal(first.accepted, true);
  assert.equal(first.rearmAllowed, true);
  assert.equal(first.state.candidateRearmUsed, true);
  state = first.state;

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const repeated = reduceKlineLifecycle(state, { type: 'REQUEST_REARM', identity });
    assert.equal(repeated.accepted, false);
    assert.equal(repeated.reason, 'REARM_ALREADY_USED');
    assert.equal(repeated.rearmAllowed, false);
    assert.deepEqual(repeated.state, state);
  }

  const nextSession = createSession({ intentId: 2 });
  const nextState = register(state, nextSession);
  assert.equal(nextState.candidateRearmUsed, false);
});

test('reducer keeps at most candidate and committed, never mutates input, and has no bar fields', () => {
  const committed = createCommitted();
  const candidate = createSession({ intentId: 2 });
  const state = register(committed.state, candidate);
  const before = JSON.stringify(state);
  if (state.candidate) Object.freeze(state.candidate);
  if (state.committed) Object.freeze(state.committed);
  Object.freeze(state);

  const nextSession = createSession({ intentId: 3 });
  const decision = reduceKlineLifecycle(state, {
    type: 'REGISTER_INTENT',
    session: nextSession,
  });
  assert.equal(JSON.stringify(state), before);
  assert.ok(activeSessionCount(state) <= 2);
  assert.ok(activeSessionCount(decision.state) <= 2);
  assert.deepEqual(Object.keys(decision.state).sort(), [
    'candidate',
    'candidateRearmUsed',
    'committed',
    'latestIntentId',
  ]);

  const keys = Object.keys(nextSession).sort();
  assert.deepEqual(keys, [
    'backendInterval',
    'datafeedInstanceId',
    'intentId',
    'ownerId',
    'sessionId',
    'state',
    'subscriberUid',
    'subscriptionGeneration',
    'symbol',
    'terminalType',
    'tradingViewResolution',
    'widgetGeneration',
  ]);
  for (const forbidden of ['bar', 'ohlcv', 'open', 'high', 'low', 'close', 'volume']) {
    assert.equal(keys.includes(forbidden), false);
  }
});
