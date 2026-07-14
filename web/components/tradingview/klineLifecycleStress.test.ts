import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createInitialKlineLifecycleProtocolState,
  createKlineLifecycleSession,
  getKlineLifecycleSessionIdentity,
  reduceKlineLifecycle,
  type KlineLifecycleEvent,
  type KlineLifecycleProtocolState,
  type KlineLifecycleReducerResult,
  type KlineLifecycleSession,
  type KlineLifecycleSubscriberEvidence,
  type KlineLifecycleTerminalType,
} from './klineLifecycleProtocol.ts';

type ScheduledTask = Readonly<{
  step: number;
  order: number;
  label: string;
  run: () => void;
}>;

class DeterministicEventScheduler {
  private tasks: ScheduledTask[] = [];
  private nextOrder = 0;
  readonly executionOrder: string[] = [];

  schedule(step: number, label: string, run: () => void) {
    this.tasks.push({ step, order: this.nextOrder, label, run });
    this.nextOrder += 1;
  }

  runAll() {
    const tasks = [...this.tasks].sort((left, right) => (
      left.step - right.step || left.order - right.order
    ));
    this.tasks = [];
    for (const task of tasks) {
      this.executionOrder.push(task.label);
      task.run();
    }
  }
}

class FakeLifecycleSequence {
  private readonly terminalType: KlineLifecycleTerminalType;
  private intentId = 0;
  private subscriptionGeneration = 0;
  private widgetGeneration = 1;
  private datafeedInstanceId = 100;

  constructor(terminalType: KlineLifecycleTerminalType) {
    this.terminalType = terminalType;
  }

  advanceGeneration() {
    this.widgetGeneration += 1;
    this.datafeedInstanceId += 1;
  }

  session({
    symbol,
    resolution,
    interval,
  }: {
    symbol: string;
    resolution: string;
    interval: string;
  }) {
    this.intentId += 1;
    return createKlineLifecycleSession({
      terminalType: this.terminalType,
      widgetGeneration: this.widgetGeneration,
      datafeedInstanceId: this.datafeedInstanceId,
      intentId: this.intentId,
      symbol,
      tradingViewResolution: resolution,
      backendInterval: interval,
    });
  }

  evidence(
    session: KlineLifecycleSession,
    subscriptionGeneration?: number,
  ): KlineLifecycleSubscriberEvidence {
    const generation = subscriptionGeneration ?? ++this.subscriptionGeneration;
    return {
      ...getKlineLifecycleSessionIdentity(session),
      subscriberUid: `subscriber:${session.sessionId}:${generation}`,
      subscriptionGeneration: generation,
      ownerId: `owner:${session.sessionId}:${generation}`,
    };
  }
}

class ProtocolStressHarness {
  state: KlineLifecycleProtocolState = createInitialKlineLifecycleProtocolState();
  readonly decisions: Array<Readonly<{
    label: string;
    decision: KlineLifecycleReducerResult;
  }>> = [];
  readonly retiredSessionIds: string[] = [];

  dispatch(label: string, event: KlineLifecycleEvent) {
    const decision = reduceKlineLifecycle(this.state, event);
    this.state = decision.state;
    this.decisions.push({ label, decision });
    this.retiredSessionIds.push(...decision.retired.map((session) => session.sessionId));
    return decision;
  }

  decision(label: string) {
    const record = this.decisions.find((item) => item.label === label);
    assert.ok(record, `missing deterministic decision: ${label}`);
    return record.decision;
  }
}

function activeSessionCount(state: KlineLifecycleProtocolState) {
  return Number(Boolean(state.candidate)) + Number(Boolean(state.committed));
}

function registerEvent(session: KlineLifecycleSession): KlineLifecycleEvent {
  return { type: 'REGISTER_INTENT', session };
}

function resolutionEvent(session: KlineLifecycleSession): KlineLifecycleEvent {
  return {
    type: 'RESOLUTION_APPLIED',
    identity: getKlineLifecycleSessionIdentity(session),
  };
}

function subscriberEvent(evidence: KlineLifecycleSubscriberEvidence): KlineLifecycleEvent {
  return { type: 'SUBSCRIBER_READY', evidence };
}

function commitEvent(evidence: KlineLifecycleSubscriberEvidence): KlineLifecycleEvent {
  return { type: 'COMMIT', evidence };
}

function scheduleDispatch(
  scheduler: DeterministicEventScheduler,
  harness: ProtocolStressHarness,
  step: number,
  label: string,
  event: KlineLifecycleEvent,
) {
  scheduler.schedule(step, label, () => {
    harness.dispatch(label, event);
  });
}

const intervalSequence = [
  { interval: '1m', resolution: '1' },
  { interval: '5m', resolution: '5' },
  { interval: '15m', resolution: '15' },
  { interval: '1h', resolution: '60' },
  { interval: '4h', resolution: '240' },
  { interval: '1d', resolution: '1D' },
  { interval: '1M', resolution: '1M' },
  { interval: '5m', resolution: '5' },
] as const;

test('rapid interval switching commits only final 5m and rejects every old callback', () => {
  const scheduler = new DeterministicEventScheduler();
  const sequence = new FakeLifecycleSequence('SPOT');
  const harness = new ProtocolStressHarness();
  const sessions = intervalSequence.map(({ interval, resolution }) => sequence.session({
    symbol: 'BTCUSDT',
    interval,
    resolution,
  }));

  sessions.forEach((session, index) => {
    scheduleDispatch(scheduler, harness, index, `register-${index}`, registerEvent(session));
  });

  const finalSession = sessions.at(-1)!;
  const finalEvidence = sequence.evidence(finalSession);
  scheduleDispatch(scheduler, harness, 10, 'final-resolution', resolutionEvent(finalSession));
  scheduleDispatch(scheduler, harness, 11, 'final-subscriber', subscriberEvent(finalEvidence));
  scheduleDispatch(scheduler, harness, 12, 'final-commit', commitEvent(finalEvidence));

  sessions.slice(0, -1).forEach((session, index) => {
    const evidence = sequence.evidence(session);
    scheduleDispatch(scheduler, harness, 20 + index, `late-resolution-${index}`, resolutionEvent(session));
    scheduleDispatch(scheduler, harness, 20 + index, `late-subscriber-${index}`, subscriberEvent(evidence));
    scheduleDispatch(scheduler, harness, 20 + index, `late-commit-${index}`, commitEvent(evidence));
  });
  scheduler.runAll();

  assert.equal(harness.state.candidate, null);
  assert.equal(harness.state.committed?.backendInterval, '5m');
  assert.equal(harness.state.committed?.tradingViewResolution, '5');
  assert.equal(harness.state.committed?.intentId, finalSession.intentId);
  assert.deepEqual(
    new Set(harness.retiredSessionIds),
    new Set(sessions.slice(0, -1).map((session) => session.sessionId)),
  );
  for (const record of harness.decisions.filter(({ label }) => label.startsWith('late-'))) {
    assert.equal(record.decision.accepted, false, record.label);
  }
});

test('BTC to ETH to BTC symbol switching retires old generations and rejects old symbol events', () => {
  const scheduler = new DeterministicEventScheduler();
  const sequence = new FakeLifecycleSequence('CONTRACT');
  const harness = new ProtocolStressHarness();
  const firstBtc = sequence.session({ symbol: 'BTCUSDT', resolution: '1', interval: '1m' });
  sequence.advanceGeneration();
  const eth = sequence.session({ symbol: 'ETHUSDT', resolution: '1D', interval: '1d' });
  sequence.advanceGeneration();
  const finalBtc = sequence.session({ symbol: 'BTCUSDT', resolution: '5', interval: '5m' });
  const firstBtcEvidence = sequence.evidence(firstBtc);
  const ethEvidence = sequence.evidence(eth);
  const finalBtcEvidence = sequence.evidence(finalBtc);

  scheduleDispatch(scheduler, harness, 0, 'register-first-btc', registerEvent(firstBtc));
  scheduleDispatch(scheduler, harness, 1, 'retire-first-btc', {
    type: 'RETIRE_ALL',
    reason: 'SYMBOL_SWITCH',
  });
  scheduleDispatch(scheduler, harness, 2, 'register-eth', registerEvent(eth));
  scheduleDispatch(scheduler, harness, 3, 'retire-eth', {
    type: 'RETIRE_ALL',
    reason: 'SYMBOL_SWITCH',
  });
  scheduleDispatch(scheduler, harness, 4, 'register-final-btc', registerEvent(finalBtc));

  for (const [prefix, session, evidence] of [
    ['old-btc', firstBtc, firstBtcEvidence],
    ['old-eth', eth, ethEvidence],
  ] as const) {
    scheduleDispatch(scheduler, harness, 5, `${prefix}-resolution`, resolutionEvent(session));
    scheduleDispatch(scheduler, harness, 5, `${prefix}-subscriber`, subscriberEvent(evidence));
    scheduleDispatch(scheduler, harness, 5, `${prefix}-commit`, commitEvent(evidence));
  }
  scheduleDispatch(scheduler, harness, 6, 'final-btc-resolution', resolutionEvent(finalBtc));
  scheduleDispatch(scheduler, harness, 7, 'final-btc-subscriber', subscriberEvent(finalBtcEvidence));
  scheduleDispatch(scheduler, harness, 8, 'final-btc-commit', commitEvent(finalBtcEvidence));
  scheduler.runAll();

  assert.ok(harness.retiredSessionIds.includes(firstBtc.sessionId));
  assert.ok(harness.retiredSessionIds.includes(eth.sessionId));
  assert.notEqual(finalBtc.sessionId, firstBtc.sessionId);
  assert.notEqual(finalBtc.datafeedInstanceId, firstBtc.datafeedInstanceId);
  assert.equal(harness.state.committed?.sessionId, finalBtc.sessionId);
  for (const label of [
    'old-btc-resolution',
    'old-btc-subscriber',
    'old-btc-commit',
    'old-eth-resolution',
    'old-eth-subscriber',
    'old-eth-commit',
  ]) {
    assert.equal(harness.decision(label).accepted, false, label);
  }
});

test('resolution and subscriber races commit only after both readiness signals', () => {
  const runRace = (
    name: string,
    order: readonly ('resolution' | 'subscriber' | 'early-commit' | 'commit' | 'timeout')[],
    sameStep = false,
  ) => {
    const scheduler = new DeterministicEventScheduler();
    const sequence = new FakeLifecycleSequence('SPOT');
    const harness = new ProtocolStressHarness();
    const session = sequence.session({ symbol: 'BTCUSDT', resolution: '5', interval: '5m' });
    const evidence = sequence.evidence(session);
    scheduleDispatch(scheduler, harness, 0, `${name}-register`, registerEvent(session));
    order.forEach((eventName, index) => {
      const step = sameStep ? 1 : index + 1;
      const event: KlineLifecycleEvent = eventName === 'resolution'
        ? resolutionEvent(session)
        : eventName === 'subscriber'
          ? subscriberEvent(evidence)
          : eventName === 'timeout'
            ? {
                type: 'SUBSCRIBER_TIMEOUT',
                identity: getKlineLifecycleSessionIdentity(session),
              }
            : commitEvent(evidence);
      scheduleDispatch(scheduler, harness, step, `${name}-${eventName}`, event);
    });
    scheduler.runAll();
    return harness;
  };

  const resolutionFirst = runRace('resolution-first', [
    'resolution',
    'early-commit',
    'subscriber',
    'commit',
  ]);
  assert.equal(resolutionFirst.decision('resolution-first-early-commit').accepted, false);
  assert.equal(resolutionFirst.decision('resolution-first-commit').accepted, true);

  const subscriberFirst = runRace('subscriber-first', [
    'subscriber',
    'early-commit',
    'resolution',
    'commit',
  ]);
  assert.equal(subscriberFirst.decision('subscriber-first-early-commit').accepted, false);
  assert.equal(subscriberFirst.decision('subscriber-first-commit').accepted, true);

  const simultaneous = runRace('simultaneous', ['resolution', 'subscriber', 'commit'], true);
  assert.deepEqual(schedulerLabels(simultaneous, 'simultaneous'), [
    'simultaneous-register',
    'simultaneous-resolution',
    'simultaneous-subscriber',
    'simultaneous-commit',
  ]);
  assert.equal(simultaneous.decision('simultaneous-commit').accepted, true);

  const timeout = runRace('timeout', ['resolution', 'timeout', 'subscriber', 'commit']);
  assert.equal(timeout.decision('timeout-timeout').accepted, true);
  assert.equal(timeout.decision('timeout-subscriber').accepted, false);
  assert.equal(timeout.decision('timeout-commit').accepted, false);
  assert.equal(timeout.state.candidate, null);
  assert.equal(timeout.state.committed, null);
});

function schedulerLabels(harness: ProtocolStressHarness, prefix: string) {
  return harness.decisions
    .map(({ label }) => label)
    .filter((label) => label.startsWith(prefix));
}

test('late callback attack is a deterministic no-op after supersession', () => {
  const scheduler = new DeterministicEventScheduler();
  const sequence = new FakeLifecycleSequence('CONTRACT');
  const harness = new ProtocolStressHarness();
  const oldSession = sequence.session({ symbol: 'BTCUSDT', resolution: '1', interval: '1m' });
  const newSession = sequence.session({ symbol: 'BTCUSDT', resolution: '5', interval: '5m' });
  const oldEvidence = sequence.evidence(oldSession);
  const newEvidence = sequence.evidence(newSession);
  let committedSnapshot = '';

  scheduleDispatch(scheduler, harness, 0, 'attack-register-old', registerEvent(oldSession));
  scheduleDispatch(scheduler, harness, 1, 'attack-register-new', registerEvent(newSession));
  scheduleDispatch(scheduler, harness, 2, 'attack-new-resolution', resolutionEvent(newSession));
  scheduleDispatch(scheduler, harness, 3, 'attack-new-subscriber', subscriberEvent(newEvidence));
  scheduleDispatch(scheduler, harness, 4, 'attack-new-commit', commitEvent(newEvidence));
  scheduler.schedule(5, 'capture-committed-state', () => {
    committedSnapshot = JSON.stringify(harness.state);
  });
  scheduleDispatch(scheduler, harness, 6, 'attack-late-resolution', resolutionEvent(oldSession));
  scheduleDispatch(scheduler, harness, 6, 'attack-late-subscriber', subscriberEvent(oldEvidence));
  scheduleDispatch(scheduler, harness, 6, 'attack-late-commit', commitEvent(oldEvidence));
  scheduleDispatch(scheduler, harness, 6, 'attack-late-reset', {
    type: 'REQUEST_REARM',
    identity: getKlineLifecycleSessionIdentity(oldSession),
  });
  scheduler.runAll();

  for (const label of [
    'attack-late-resolution',
    'attack-late-subscriber',
    'attack-late-commit',
    'attack-late-reset',
  ]) {
    assert.equal(harness.decision(label).accepted, false, label);
  }
  assert.equal(JSON.stringify(harness.state), committedSnapshot);
  assert.equal(harness.state.committed?.sessionId, newSession.sessionId);
});

test('reset and rearm stress accepts exactly one request without a reset loop', () => {
  const scheduler = new DeterministicEventScheduler();
  const sequence = new FakeLifecycleSequence('SPOT');
  const harness = new ProtocolStressHarness();
  const session = sequence.session({ symbol: 'BTCUSDT', resolution: '15', interval: '15m' });
  const identity = getKlineLifecycleSessionIdentity(session);
  const evidence = sequence.evidence(session);

  scheduleDispatch(scheduler, harness, 0, 'rearm-register', registerEvent(session));
  scheduleDispatch(scheduler, harness, 1, 'rearm-resolution', resolutionEvent(session));
  for (let attempt = 1; attempt <= 25; attempt += 1) {
    scheduleDispatch(scheduler, harness, 2, `rearm-request-${attempt}`, {
      type: 'REQUEST_REARM',
      identity,
    });
  }
  scheduleDispatch(scheduler, harness, 3, 'rearm-subscriber', subscriberEvent(evidence));
  scheduleDispatch(scheduler, harness, 4, 'rearm-commit', commitEvent(evidence));
  scheduler.runAll();

  const rearmDecisions = harness.decisions
    .filter(({ label }) => label.startsWith('rearm-request-'))
    .map(({ decision }) => decision);
  assert.equal(rearmDecisions.filter((decision) => decision.accepted).length, 1);
  assert.equal(rearmDecisions[0]?.reason, 'REARM_ALLOWED');
  for (const decision of rearmDecisions.slice(1)) {
    assert.equal(decision.accepted, false);
    assert.equal(decision.reason, 'REARM_ALREADY_USED');
    assert.equal(decision.rearmAllowed, false);
  }
  assert.equal(harness.state.committed?.sessionId, session.sessionId);
  assert.equal(harness.state.candidateRearmUsed, false);
});

test('destroy retires the candidate and rejects every later lifecycle event', () => {
  const scheduler = new DeterministicEventScheduler();
  const sequence = new FakeLifecycleSequence('CONTRACT');
  const harness = new ProtocolStressHarness();
  const session = sequence.session({ symbol: 'BTCUSDT', resolution: '1D', interval: '1d' });
  const evidence = sequence.evidence(session);

  scheduleDispatch(scheduler, harness, 0, 'destroy-register', registerEvent(session));
  scheduleDispatch(scheduler, harness, 1, 'destroy-all', {
    type: 'RETIRE_ALL',
    reason: 'WIDGET_DESTROY',
  });
  scheduleDispatch(scheduler, harness, 2, 'destroy-late-resolution', resolutionEvent(session));
  scheduleDispatch(scheduler, harness, 3, 'destroy-late-subscriber', subscriberEvent(evidence));
  scheduleDispatch(scheduler, harness, 4, 'destroy-late-commit', commitEvent(evidence));
  scheduler.runAll();

  assert.equal(harness.decision('destroy-all').retired[0]?.state, 'RETIRED');
  assert.equal(harness.decision('destroy-late-resolution').accepted, false);
  assert.equal(harness.decision('destroy-late-subscriber').accepted, false);
  assert.equal(harness.decision('destroy-late-commit').accepted, false);
  assert.deepEqual(harness.state, createInitialKlineLifecycleProtocolState());
});

test('A to B to A creates a fresh identity and does not inherit retired lifecycle cursor state', () => {
  const scheduler = new DeterministicEventScheduler();
  const sequence = new FakeLifecycleSequence('SPOT');
  const harness = new ProtocolStressHarness();
  const firstBtc = sequence.session({ symbol: 'BTCUSDT', resolution: '1', interval: '1m' });
  const firstBtcEvidence = sequence.evidence(firstBtc, 77);
  sequence.advanceGeneration();
  const eth = sequence.session({ symbol: 'ETHUSDT', resolution: '1D', interval: '1d' });
  const ethEvidence = sequence.evidence(eth, 35);
  sequence.advanceGeneration();
  const recoveredBtc = sequence.session({ symbol: 'BTCUSDT', resolution: '1', interval: '1m' });
  const recoveredBtcEvidence = sequence.evidence(recoveredBtc, 1);

  let step = 0;
  for (const [prefix, session, evidence] of [
    ['first-btc', firstBtc, firstBtcEvidence],
    ['eth', eth, ethEvidence],
    ['recovered-btc', recoveredBtc, recoveredBtcEvidence],
  ] as const) {
    scheduleDispatch(scheduler, harness, step++, `${prefix}-register`, registerEvent(session));
    scheduleDispatch(scheduler, harness, step++, `${prefix}-resolution`, resolutionEvent(session));
    scheduleDispatch(scheduler, harness, step++, `${prefix}-subscriber`, subscriberEvent(evidence));
    scheduleDispatch(scheduler, harness, step++, `${prefix}-commit`, commitEvent(evidence));
    if (prefix !== 'recovered-btc') {
      scheduleDispatch(scheduler, harness, step++, `${prefix}-symbol-retire`, {
        type: 'RETIRE_ALL',
        reason: 'SYMBOL_SWITCH',
      });
    }
  }
  scheduleDispatch(scheduler, harness, step, 'recovery-old-btc-resolution', resolutionEvent(firstBtc));
  scheduleDispatch(scheduler, harness, step, 'recovery-old-btc-subscriber', subscriberEvent(firstBtcEvidence));
  scheduleDispatch(scheduler, harness, step, 'recovery-old-btc-commit', commitEvent(firstBtcEvidence));
  scheduler.runAll();

  assert.notEqual(recoveredBtc.sessionId, firstBtc.sessionId);
  assert.notEqual(recoveredBtc.widgetGeneration, firstBtc.widgetGeneration);
  assert.notEqual(recoveredBtc.datafeedInstanceId, firstBtc.datafeedInstanceId);
  assert.equal(harness.state.committed?.sessionId, recoveredBtc.sessionId);
  assert.equal(harness.state.committed?.subscriptionGeneration, 1);
  assert.equal(harness.decision('recovered-btc-subscriber').accepted, true);
  assert.equal(harness.decision('recovery-old-btc-resolution').accepted, false);
  assert.equal(harness.decision('recovery-old-btc-subscriber').accepted, false);
  assert.equal(harness.decision('recovery-old-btc-commit').accepted, false);
  assert.doesNotMatch(JSON.stringify(harness.state), /revision|highWater|candle|ohlcv/i);
});

test('1000 deterministic symbol and interval switches keep protocol memory bounded', () => {
  const scheduler = new DeterministicEventScheduler();
  const sequence = new FakeLifecycleSequence('CONTRACT');
  const harness = new ProtocolStressHarness();
  let maxActiveSessions = 0;
  let maxSerializedStateBytes = 0;
  let dispatchCount = 0;
  let finalSession: KlineLifecycleSession | null = null;

  const observeState = () => {
    dispatchCount += 1;
    maxActiveSessions = Math.max(maxActiveSessions, activeSessionCount(harness.state));
    maxSerializedStateBytes = Math.max(
      maxSerializedStateBytes,
      Buffer.byteLength(JSON.stringify(harness.state), 'utf8'),
    );
    assert.ok(Number(Boolean(harness.state.candidate)) <= 1);
    assert.ok(Number(Boolean(harness.state.committed)) <= 1);
    assert.ok(activeSessionCount(harness.state) <= 2);
    assert.equal('retired' in harness.state, false);
    assert.doesNotMatch(JSON.stringify(harness.state), /"state":"RETIRED"/);
  };

  for (let index = 0; index < 1000; index += 1) {
    sequence.advanceGeneration();
    const { interval, resolution } = intervalSequence[index % intervalSequence.length]!;
    const session = sequence.session({
      symbol: index % 2 === 0 ? 'BTCUSDT' : 'ETHUSDT',
      interval,
      resolution,
    });
    const evidence = sequence.evidence(session, 1);
    finalSession = session;
    const baseStep = index * 4;
    for (const [offset, label, event] of [
      [0, `long-register-${index}`, registerEvent(session)],
      [1, `long-resolution-${index}`, resolutionEvent(session)],
      [2, `long-subscriber-${index}`, subscriberEvent(evidence)],
      [3, `long-commit-${index}`, commitEvent(evidence)],
    ] as const) {
      scheduler.schedule(baseStep + offset, label, () => {
        const decision = harness.dispatch(label, event);
        assert.equal(decision.accepted, true, label);
        observeState();
      });
    }
  }
  scheduler.runAll();

  assert.equal(dispatchCount, 4000);
  assert.equal(maxActiveSessions, 2);
  assert.ok(maxSerializedStateBytes < 2048, `state grew to ${maxSerializedStateBytes} bytes`);
  assert.equal(new Set(harness.retiredSessionIds).size, 999);
  assert.equal(harness.retiredSessionIds.length, 999);
  assert.equal(harness.state.candidate, null);
  assert.equal(harness.state.committed?.sessionId, finalSession?.sessionId);
  assert.equal(activeSessionCount(harness.state), 1);
});

function runTerminalConsistencySequence(terminalType: KlineLifecycleTerminalType) {
  const scheduler = new DeterministicEventScheduler();
  const sequence = new FakeLifecycleSequence(terminalType);
  const harness = new ProtocolStressHarness();
  const first = sequence.session({ symbol: 'BTCUSDT', resolution: '1', interval: '1m' });
  const second = sequence.session({ symbol: 'BTCUSDT', resolution: '5', interval: '5m' });
  const firstEvidence = sequence.evidence(first, 1);
  const secondEvidence = sequence.evidence(second, 2);
  let committedSummary: Record<string, unknown> | null = null;

  scheduleDispatch(scheduler, harness, 0, 'terminal-first-register', registerEvent(first));
  scheduleDispatch(scheduler, harness, 1, 'terminal-first-subscriber', subscriberEvent(firstEvidence));
  scheduleDispatch(scheduler, harness, 2, 'terminal-first-resolution', resolutionEvent(first));
  scheduleDispatch(scheduler, harness, 3, 'terminal-first-commit', commitEvent(firstEvidence));
  scheduleDispatch(scheduler, harness, 4, 'terminal-second-register', registerEvent(second));
  scheduleDispatch(scheduler, harness, 5, 'terminal-second-resolution', resolutionEvent(second));
  scheduleDispatch(scheduler, harness, 5, 'terminal-second-subscriber', subscriberEvent(secondEvidence));
  scheduleDispatch(scheduler, harness, 5, 'terminal-second-commit', commitEvent(secondEvidence));
  scheduler.schedule(6, 'terminal-capture-commit', () => {
    const committed = harness.state.committed;
    committedSummary = {
      latestIntentId: harness.state.latestIntentId,
      candidate: harness.state.candidate?.state || null,
      committed: committed?.state || null,
      symbol: committed?.symbol || null,
      resolution: committed?.tradingViewResolution || null,
      interval: committed?.backendInterval || null,
      subscriptionGeneration: committed?.subscriptionGeneration || null,
      candidateRearmUsed: harness.state.candidateRearmUsed,
    };
  });
  scheduleDispatch(scheduler, harness, 7, 'terminal-retire', {
    type: 'RETIRE_ALL',
    reason: 'WIDGET_DESTROY',
  });
  scheduler.runAll();

  return {
    committedSummary,
    retiredStates: harness.decision('terminal-retire').retired.map((session) => session.state),
    finalState: harness.state,
  };
}

test('Spot and Contract adapters produce identical committed and retired lifecycle states', () => {
  const spot = runTerminalConsistencySequence('SPOT');
  const contract = runTerminalConsistencySequence('CONTRACT');

  assert.deepEqual(spot.committedSummary, contract.committedSummary);
  assert.equal(spot.committedSummary?.committed, 'COMMITTED');
  assert.deepEqual(spot.retiredStates, ['RETIRED']);
  assert.deepEqual(contract.retiredStates, ['RETIRED']);
  assert.deepEqual(spot.finalState, createInitialKlineLifecycleProtocolState());
  assert.deepEqual(contract.finalState, createInitialKlineLifecycleProtocolState());
});
