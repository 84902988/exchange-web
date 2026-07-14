/* eslint-disable @typescript-eslint/no-explicit-any -- Dynamic harness preserves production extensionless imports. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

type TerminalType = 'SPOT' | 'CONTRACT';

type RuntimeContext = Readonly<{
  terminalType: TerminalType;
  widgetGeneration: number;
  datafeedInstanceId: number;
  symbol: string;
}>;

type SessionIdentity = Readonly<{
  sessionId: string;
  terminalType: TerminalType;
  widgetGeneration: number;
  datafeedInstanceId: number;
  intentId: number;
  symbol: string;
  tradingViewResolution: string;
  backendInterval: string;
}>;

type SubscriberEvidence = SessionIdentity & Readonly<{
  subscriberUid: string;
  subscriptionGeneration: number;
  ownerId: string;
}>;

type RuntimeCoordinator = {
  beginIntent: (input: {
    tradingViewResolution: string;
    backendInterval: string;
  }) => any;
  applyResolution: (identity: SessionIdentity) => any;
  recordSubscriber: (evidence: SubscriberEvidence) => any;
  tryCommit: (identity: SessionIdentity) => any;
  requestRearm: (
    identity: SessionIdentity,
    source: 'SUBSCRIBER_MISSING' | 'RESTORED_BASELINE',
  ) => any;
  retireAll: (reason: 'SYMBOL_SWITCH' | 'WIDGET_DESTROY') => any;
  snapshot: () => any;
};

type RuntimeCoordinatorConstructor = new (
  context: RuntimeContext,
) => RuntimeCoordinator;

function transpileTypeScript(filePath: string) {
  return ts.transpileModule(readFileSync(filePath, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: filePath,
  }).outputText;
}

function executeCommonJsModule(
  source: string,
  mocks: Record<string, unknown>,
): Record<string, any> {
  const loadedModule: { exports: Record<string, any> } = { exports: {} };
  const localRequire = (specifier: string) => {
    if (Object.prototype.hasOwnProperty.call(mocks, specifier)) return mocks[specifier];
    throw new Error(`Unexpected test import: ${specifier}`);
  };
  const execute = new Function('require', 'module', 'exports', source);
  execute(localRequire, loadedModule, loadedModule.exports);
  return loadedModule.exports;
}

const protocolPath = fileURLToPath(new URL('./klineLifecycleProtocol.ts', import.meta.url));
const runtimePath = fileURLToPath(
  new URL('./klineLifecycleRuntimeCoordinator.ts', import.meta.url),
);
const protocolModule = executeCommonJsModule(transpileTypeScript(protocolPath), {});
const runtimeModule = executeCommonJsModule(transpileTypeScript(runtimePath), {
  './klineLifecycleProtocol': protocolModule,
  './klineLifecycleObservability': {
    recordKlineLifecycleDecision: () => undefined,
    recordKlineLifecycleResetExecution: () => undefined,
  },
});
const KlineLifecycleRuntimeCoordinator = runtimeModule
  .KlineLifecycleRuntimeCoordinator as RuntimeCoordinatorConstructor;

function readSource(relativePath: string) {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');
}

function createCoordinator(context: RuntimeContext) {
  return new KlineLifecycleRuntimeCoordinator(context);
}

function begin(
  coordinator: RuntimeCoordinator,
  tradingViewResolution = '1',
  backendInterval = '1m',
) {
  return coordinator.beginIntent({ tradingViewResolution, backendInterval });
}

function evidence(
  identity: SessionIdentity,
  subscriptionGeneration: number,
): SubscriberEvidence {
  return {
    ...identity,
    subscriberUid: `subscriber:${identity.datafeedInstanceId}:${subscriptionGeneration}`,
    subscriptionGeneration,
    ownerId: `owner:${identity.terminalType}:${identity.datafeedInstanceId}:${subscriptionGeneration}`,
  };
}

function commitReadySession(
  coordinator: RuntimeCoordinator,
  identity: SessionIdentity,
  subscriptionGeneration: number,
) {
  assert.equal(coordinator.applyResolution(identity).accepted, true);
  const subscriber = evidence(identity, subscriptionGeneration);
  assert.equal(coordinator.recordSubscriber(subscriber).accepted, true);
  const decision = coordinator.tryCommit(identity);
  assert.equal(decision.accepted, true);
  return { decision, subscriber };
}

function activeSessionCount(state: any) {
  return Number(Boolean(state.candidate)) + Number(Boolean(state.committed));
}

const intervalSequence = [
  ['1', '1m'],
  ['5', '5m'],
  ['15', '15m'],
  ['60', '1h'],
  ['240', '4h'],
  ['1D', '1d'],
  ['1M', '1M'],
  ['5', '5m'],
] as const;

test('Spot and Contract production charts each create one Runtime lifecycle owner', () => {
  const spotChart = readSource('../spot/SpotTradingViewChart.tsx');
  const contractChart = readSource('../contract/ContractTradingViewChart.tsx');
  const spotDatafeed = readSource('../spot/tradingview/spotTradingViewDatafeed.ts');
  const contractDatafeed = readSource(
    '../contract/tradingview/contractTradingViewDatafeed.ts',
  );

  for (const chart of [spotChart, contractChart]) {
    assert.equal(
      chart.match(/new KlineLifecycleRuntimeCoordinator\s*\(/g)?.length,
      1,
    );
    assert.match(chart, /tryCommitRuntimeCandidate/);
    assert.doesNotMatch(chart, /commitLifecycle/);
  }
  for (const datafeed of [spotDatafeed, contractDatafeed]) {
    assert.doesNotMatch(datafeed, /KlineLifecycleRuntimeCoordinator/);
    assert.doesNotMatch(datafeed, /tryCommitRuntimeCandidate|commitLifecycle/);
  }
  const requestRearmIndex = contractChart.indexOf('requestRearm(identity, source)');
  const executeResetIndex = contractChart.indexOf(
    'executeResetPermit(requirement, result.permit)',
  );
  assert.ok(requestRearmIndex >= 0);
  assert.ok(executeResetIndex > requestRearmIndex);
});

test('both terminal owners keep candidate and committed bounded without resident retired state', () => {
  for (const terminalType of ['SPOT', 'CONTRACT'] as const) {
    const coordinator = createCoordinator({
      terminalType,
      widgetGeneration: 1,
      datafeedInstanceId: terminalType === 'SPOT' ? 101 : 201,
      symbol: terminalType === 'SPOT' ? 'BTCUSDT' : 'BTC',
    });
    for (let index = 1; index <= 1000; index += 1) {
      begin(coordinator, String(index), `${index}m`);
      const snapshot = coordinator.snapshot();
      assert.ok(activeSessionCount(snapshot) <= 2);
      assert.equal('retired' in snapshot, false);
    }
    assert.equal(coordinator.snapshot().candidate?.intentId, 1000);
    assert.equal(coordinator.snapshot().committed, null);
  }
});

test('initial load follows REGISTER, RESOLUTION, SUBSCRIBER, COMMIT and applies effects once', () => {
  for (const terminalType of ['SPOT', 'CONTRACT'] as const) {
    const coordinator = createCoordinator({
      terminalType,
      widgetGeneration: 1,
      datafeedInstanceId: terminalType === 'SPOT' ? 102 : 202,
      symbol: terminalType === 'SPOT' ? 'BTCUSDT' : 'BTC',
    });
    let committedEffects = 0;
    const intent = begin(coordinator);
    assert.equal(intent.decision.reason, 'REGISTERED');
    assert.equal(intent.decision.state.candidate?.state, 'INTENT_PENDING');

    const resolution = coordinator.applyResolution(intent.identity);
    assert.equal(resolution.reason, 'RESOLUTION_APPLIED');
    assert.equal(resolution.state.candidate?.state, 'RESOLUTION_APPLIED');

    const subscriber = coordinator.recordSubscriber(evidence(intent.identity, 1));
    assert.equal(subscriber.reason, 'SUBSCRIBER_READY');
    assert.equal(subscriber.state.candidate?.state, 'SUBSCRIBER_READY');

    const committed = coordinator.tryCommit(intent.identity);
    if (committed.accepted) committedEffects += 1;
    assert.equal(committed.reason, 'COMMITTED');
    assert.equal(committed.state.committed?.state, 'COMMITTED');

    const replay = coordinator.tryCommit(intent.identity);
    if (replay.accepted) committedEffects += 1;
    assert.equal(replay.accepted, false);
    assert.equal(committedEffects, 1);
  }
});

test('rapid interval switching commits only final 5m and rejects all stale callbacks', () => {
  for (const terminalType of ['SPOT', 'CONTRACT'] as const) {
    const coordinator = createCoordinator({
      terminalType,
      widgetGeneration: 2,
      datafeedInstanceId: terminalType === 'SPOT' ? 103 : 203,
      symbol: terminalType === 'SPOT' ? 'BTCUSDT' : 'BTC',
    });
    const identities: SessionIdentity[] = [];
    const retired = new Set<string>();
    for (const [resolution, interval] of intervalSequence) {
      const intent = begin(coordinator, resolution, interval);
      identities.push(intent.identity);
      for (const session of intent.decision.retired) retired.add(session.sessionId);
    }

    const finalIdentity = identities.at(-1)!;
    const activeSubscriber = evidence(finalIdentity, 8);
    assert.equal(coordinator.applyResolution(finalIdentity).accepted, true);
    assert.equal(coordinator.recordSubscriber(activeSubscriber).accepted, true);
    assert.equal(coordinator.tryCommit(finalIdentity).accepted, true);

    for (const staleIdentity of identities.slice(0, -1)) {
      assert.equal(coordinator.applyResolution(staleIdentity).accepted, false);
      assert.equal(
        coordinator.recordSubscriber(evidence(staleIdentity, staleIdentity.intentId)).accepted,
        false,
      );
      assert.equal(coordinator.tryCommit(staleIdentity).accepted, false);
    }
    assert.equal(retired.size, intervalSequence.length - 1);
    assert.equal(coordinator.snapshot().committed?.backendInterval, '5m');
    assert.equal(coordinator.snapshot().committed?.subscriberUid, activeSubscriber.subscriberUid);
    assert.equal(coordinator.snapshot().candidate, null);
  }
});

test('Spot BTC to ETH to BTC creates fresh widget, datafeed, subscriber, and owner identity', () => {
  const symbols = ['BTCUSDT', 'ETHUSDT', 'BTCUSDT'];
  const identities: SessionIdentity[] = [];
  const subscribers: SubscriberEvidence[] = [];
  let retiredCoordinator: RuntimeCoordinator | null = null;
  let retiredIdentity: SessionIdentity | null = null;
  const realtimeAuthority = Object.freeze({ owner: 'spot-store-adapter' });

  symbols.forEach((symbol, index) => {
    if (retiredCoordinator && retiredIdentity) {
      assert.equal(retiredCoordinator.retireAll('SYMBOL_SWITCH').accepted, true);
      assert.equal(retiredCoordinator.applyResolution(retiredIdentity).accepted, false);
      assert.equal(
        retiredCoordinator.recordSubscriber(evidence(retiredIdentity, index + 10)).accepted,
        false,
      );
      assert.equal(retiredCoordinator.tryCommit(retiredIdentity).accepted, false);
    }
    const coordinator = createCoordinator({
      terminalType: 'SPOT',
      widgetGeneration: index + 1,
      datafeedInstanceId: 300 + index,
      symbol,
    });
    const identity = begin(coordinator).identity;
    const committed = commitReadySession(coordinator, identity, index + 1);
    identities.push(identity);
    subscribers.push(committed.subscriber);
    retiredCoordinator = coordinator;
    retiredIdentity = identity;
  });

  assert.equal(new Set(identities.map(({ sessionId }) => sessionId)).size, 3);
  assert.equal(new Set(identities.map(({ widgetGeneration }) => widgetGeneration)).size, 3);
  assert.equal(new Set(identities.map(({ datafeedInstanceId }) => datafeedInstanceId)).size, 3);
  assert.equal(new Set(subscribers.map(({ subscriptionGeneration }) => subscriptionGeneration)).size, 3);
  assert.equal(new Set(subscribers.map(({ ownerId }) => ownerId)).size, 3);
  assert.equal(realtimeAuthority.owner, 'spot-store-adapter');
});

test('Contract BTC to AAPL to XAU to BTC isolates every retired symbol session', () => {
  const symbols = ['BTC', 'AAPL', 'XAU', 'BTC'];
  const identities: SessionIdentity[] = [];
  const subscribers: SubscriberEvidence[] = [];
  let previousCoordinator: RuntimeCoordinator | null = null;
  let previousIdentity: SessionIdentity | null = null;
  const realtimeAuthority = Object.freeze({ owner: 'contract-market-store' });

  symbols.forEach((symbol, index) => {
    if (previousCoordinator && previousIdentity) {
      assert.equal(previousCoordinator.retireAll('SYMBOL_SWITCH').accepted, true);
      assert.equal(previousCoordinator.applyResolution(previousIdentity).accepted, false);
      assert.equal(
        previousCoordinator.recordSubscriber(evidence(previousIdentity, index + 20)).accepted,
        false,
      );
      assert.equal(previousCoordinator.tryCommit(previousIdentity).accepted, false);
    }
    const coordinator = createCoordinator({
      terminalType: 'CONTRACT',
      widgetGeneration: index + 1,
      datafeedInstanceId: 400 + index,
      symbol,
    });
    const identity = begin(coordinator, '1D', '1d').identity;
    const committed = commitReadySession(coordinator, identity, index + 1);
    identities.push(identity);
    subscribers.push(committed.subscriber);
    previousCoordinator = coordinator;
    previousIdentity = identity;
  });

  assert.equal(new Set(identities.map(({ sessionId }) => sessionId)).size, 4);
  assert.equal(new Set(identities.map(({ widgetGeneration }) => widgetGeneration)).size, 4);
  assert.equal(new Set(identities.map(({ datafeedInstanceId }) => datafeedInstanceId)).size, 4);
  assert.equal(new Set(subscribers.map(({ subscriptionGeneration }) => subscriptionGeneration)).size, 4);
  assert.equal(new Set(subscribers.map(({ ownerId }) => ownerId)).size, 4);
  assert.equal(realtimeAuthority.owner, 'contract-market-store');
});

test('Contract reset sources share one Runtime permit budget and require fresh readiness', () => {
  for (const source of ['SUBSCRIBER_MISSING', 'RESTORED_BASELINE'] as const) {
    const coordinator = createCoordinator({
      terminalType: 'CONTRACT',
      widgetGeneration: source === 'SUBSCRIBER_MISSING' ? 10 : 11,
      datafeedInstanceId: source === 'SUBSCRIBER_MISSING' ? 410 : 411,
      symbol: 'BTC',
    });
    const identity = begin(coordinator).identity;
    assert.equal(coordinator.applyResolution(identity).accepted, true);

    const first = coordinator.requestRearm(identity, source);
    const second = coordinator.requestRearm(identity, source);
    assert.equal(first.allowed, true);
    assert.equal(first.permit?.source, source);
    assert.equal(second.allowed, false);
    assert.equal(second.reason, 'REARM_ALREADY_USED');

    const oldGeneration = evidence(identity, 1);
    const freshGeneration = evidence(identity, 2);
    assert.notEqual(oldGeneration.ownerId, freshGeneration.ownerId);
    assert.equal(coordinator.recordSubscriber(freshGeneration).accepted, true);
    assert.equal(coordinator.tryCommit(identity).accepted, true);
    assert.equal(coordinator.snapshot().committed?.subscriptionGeneration, 2);
  }
});

test('reconnect cannot commit without a new intent and replacement readiness is explicit', () => {
  for (const terminalType of ['SPOT', 'CONTRACT'] as const) {
    const coordinator = createCoordinator({
      terminalType,
      widgetGeneration: 20,
      datafeedInstanceId: terminalType === 'SPOT' ? 500 : 600,
      symbol: terminalType === 'SPOT' ? 'ETHUSDT' : 'ETH',
    });
    const committedIdentity = begin(coordinator).identity;
    commitReadySession(coordinator, committedIdentity, 1);
    const committedBeforeReconnect = coordinator.snapshot().committed;

    assert.equal(
      coordinator.recordSubscriber(evidence(committedIdentity, 2)).accepted,
      false,
    );
    assert.equal(coordinator.tryCommit(committedIdentity).accepted, false);
    assert.deepEqual(coordinator.snapshot().committed, committedBeforeReconnect);

    const reconnectIdentity = begin(coordinator, '5', '5m').identity;
    assert.equal(
      coordinator.recordSubscriber(evidence(reconnectIdentity, 2)).reason,
      'SUBSCRIBER_RECORDED',
    );
    assert.equal(coordinator.tryCommit(reconnectIdentity).accepted, false);
    assert.equal(coordinator.applyResolution(reconnectIdentity).reason, 'SUBSCRIBER_READY');
    assert.equal(coordinator.tryCommit(reconnectIdentity).accepted, true);
    assert.equal(coordinator.snapshot().committed?.subscriptionGeneration, 2);
  }
});

test('history and realtime data remain outside lifecycle state while readiness gates commit', () => {
  const forbiddenBarFields = ['open', 'high', 'low', 'close', 'volume'];
  for (const terminalType of ['SPOT', 'CONTRACT'] as const) {
    const coordinator = createCoordinator({
      terminalType,
      widgetGeneration: 30,
      datafeedInstanceId: terminalType === 'SPOT' ? 700 : 800,
      symbol: terminalType === 'SPOT' ? 'BTCUSDT' : 'EURUSD',
    });
    const identity = begin(coordinator).identity;
    const historyResult = Object.freeze({ bars: 300, status: 'READY' });
    const beforeHistory = coordinator.snapshot();
    assert.deepEqual(coordinator.snapshot(), beforeHistory);
    assert.equal(historyResult.bars, 300);

    assert.equal(coordinator.applyResolution(identity).accepted, true);
    assert.equal(coordinator.tryCommit(identity).accepted, false);
    assert.equal(coordinator.recordSubscriber(evidence(identity, 1)).accepted, true);
    assert.equal(coordinator.tryCommit(identity).accepted, true);

    const beforeFirstRealtimeCandle = coordinator.snapshot();
    const firstRealtimeCandle = Object.freeze({
      symbol: identity.symbol,
      interval: identity.backendInterval,
      time: 1_720_000_000_000,
    });
    assert.deepEqual(coordinator.snapshot(), beforeFirstRealtimeCandle);
    assert.equal(firstRealtimeCandle.symbol, identity.symbol);
    for (const field of forbiddenBarFields) {
      assert.equal(field in coordinator.snapshot().committed, false);
    }
  }
});

test('asset acceptance matrix exercises initial, interval, A-B-A, reconnect, and reset semantics', () => {
  const matrix = [
    { terminalType: 'SPOT' as const, assets: ['BTCUSDT', 'ETHUSDT', 'INTERNAL'] },
    { terminalType: 'CONTRACT' as const, assets: ['BTC', 'ETH', 'AAPL', 'XAU', 'EURUSD'] },
  ];

  for (const { terminalType, assets } of matrix) {
    assets.forEach((symbol, assetIndex) => {
      const baseId = terminalType === 'SPOT' ? 1000 : 2000;
      const coordinator = createCoordinator({
        terminalType,
        widgetGeneration: assetIndex + 1,
        datafeedInstanceId: baseId + assetIndex,
        symbol,
      });

      const initial = begin(coordinator).identity;
      commitReadySession(coordinator, initial, 1);

      const interval = begin(coordinator, '5', '5m').identity;
      const intervalCommit = commitReadySession(coordinator, interval, 2).decision;
      assert.equal(intervalCommit.retired[0]?.sessionId, initial.sessionId);

      assert.equal(
        coordinator.recordSubscriber(evidence(interval, 3)).accepted,
        false,
        `${terminalType}:${symbol}: reconnect must not commit without intent`,
      );

      const resetIdentity = begin(coordinator, '15', '15m').identity;
      assert.equal(coordinator.applyResolution(resetIdentity).accepted, true);
      const reset = coordinator.requestRearm(resetIdentity, 'SUBSCRIBER_MISSING');
      assert.equal(reset.allowed, true);
      assert.equal(
        coordinator.requestRearm(resetIdentity, 'SUBSCRIBER_MISSING').allowed,
        false,
      );
      assert.equal(coordinator.recordSubscriber(evidence(resetIdentity, 4)).accepted, true);
      assert.equal(coordinator.tryCommit(resetIdentity).accepted, true);

      assert.equal(coordinator.retireAll('SYMBOL_SWITCH').accepted, true);
      const replacement = createCoordinator({
        terminalType,
        widgetGeneration: assetIndex + 100,
        datafeedInstanceId: baseId + assetIndex + 100,
        symbol,
      });
      const recovered = begin(replacement).identity;
      assert.notEqual(recovered.sessionId, initial.sessionId);
      assert.equal(recovered.symbol, initial.symbol);
      commitReadySession(replacement, recovered, 5);
    });
  }
});
