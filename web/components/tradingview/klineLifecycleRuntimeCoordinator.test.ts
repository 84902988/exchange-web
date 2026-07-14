/* eslint-disable @typescript-eslint/no-explicit-any -- Dynamic harness preserves production extensionless imports. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

type RuntimeContext = Readonly<{
  terminalType: 'SPOT' | 'CONTRACT';
  widgetGeneration: number;
  datafeedInstanceId: number;
  symbol: string;
}>;

type SessionIdentity = Readonly<{
  sessionId: string;
  terminalType: 'SPOT' | 'CONTRACT';
  widgetGeneration: number;
  datafeedInstanceId: number;
  intentId: number;
  symbol: string;
  tradingViewResolution: string;
  backendInterval: string;
}>;

type RuntimeCoordinator = {
  beginIntent: (input: {
    tradingViewResolution: string;
    backendInterval: string;
  }) => any;
  applyResolution: (identity: SessionIdentity) => any;
  recordSubscriber: (evidence: Record<string, unknown>) => any;
  tryCommit: (identity: SessionIdentity) => any;
  requestRearm: (identity: SessionIdentity, source: string) => any;
  retireSession: (identity: SessionIdentity, reason: string) => any;
  retireAll: (reason: string) => any;
  snapshot: () => any;
};

type RuntimeCoordinatorConstructor = new (context: RuntimeContext) => RuntimeCoordinator;

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

function createCoordinator(
  overrides: Partial<RuntimeContext> = {},
): RuntimeCoordinator {
  return new KlineLifecycleRuntimeCoordinator({
    terminalType: 'SPOT',
    widgetGeneration: 1,
    datafeedInstanceId: 10,
    symbol: 'BTCUSDT',
    ...overrides,
  });
}

function begin(
  coordinator: RuntimeCoordinator,
  tradingViewResolution = '1',
  backendInterval = '1m',
) {
  return coordinator.beginIntent({ tradingViewResolution, backendInterval });
}

function subscriberEvidence(
  identity: SessionIdentity,
  subscriptionGeneration = identity.intentId,
) {
  return {
    ...identity,
    subscriberUid: `subscriber-${identity.intentId}`,
    subscriptionGeneration,
    ownerId: `owner-${identity.intentId}`,
  };
}

function commit(
  coordinator: RuntimeCoordinator,
  identity: SessionIdentity,
) {
  assert.equal(coordinator.applyResolution(identity).accepted, true);
  assert.equal(
    coordinator.recordSubscriber(subscriberEvidence(identity)).accepted,
    true,
  );
  const decision = coordinator.tryCommit(identity);
  assert.equal(decision.accepted, true);
  return decision;
}

function activeSessionCount(state: any) {
  return Number(Boolean(state.candidate)) + Number(Boolean(state.committed));
}

test('runtime coordinator source has no chart, datafeed, timer, websocket, or mutable global owner', () => {
  const source = readFileSync(runtimePath, 'utf8');
  assert.match(source, /from '\.\/klineLifecycleProtocol'/);
  assert.match(source, /recordKlineLifecycleDecision/);
  assert.doesNotMatch(source, /require\('\.\/klineLifecycleObservability'\)/);
  assert.match(source, /recordRuntimeDecision\('COMMITTED'/);
  assert.doesNotMatch(
    source,
    /\b(React|setTimeout|setInterval|WebSocket|resetData|unsubscribeBars|onRealtimeCallback)\b/,
  );
  assert.doesNotMatch(source, /^\s*(let|var)\s+\w+/m);
});

test('widget context is normalized and intent sequence is monotonic', () => {
  const coordinator = createCoordinator({ symbol: 'btcusdt' });
  const first = begin(coordinator);
  const second = begin(coordinator, '5', '5m');

  assert.equal(first.decision.accepted, true);
  assert.equal(first.identity.sessionId, 'SPOT:1:10:1');
  assert.equal(first.identity.symbol, 'BTCUSDT');
  assert.equal(second.identity.intentId, 2);
  assert.equal(second.identity.sessionId, 'SPOT:1:10:2');
  assert.equal(second.decision.retired[0]?.sessionId, first.identity.sessionId);
  assert.equal(coordinator.snapshot().candidate?.sessionId, second.identity.sessionId);
});

test('invalid widget context is rejected before an intent can be created', () => {
  assert.throws(
    () => createCoordinator({ widgetGeneration: 0 }),
    /widgetGeneration must be positive/,
  );
  assert.throws(
    () => createCoordinator({ symbol: '' }),
    /symbol is required/,
  );
});

test('resolution first cannot commit until subscriber readiness is complete', () => {
  const coordinator = createCoordinator();
  const { identity } = begin(coordinator);

  const resolution = coordinator.applyResolution(identity);
  assert.equal(resolution.accepted, true);
  assert.equal(resolution.state.candidate?.state, 'RESOLUTION_APPLIED');

  const earlyCommit = coordinator.tryCommit(identity);
  assert.equal(earlyCommit.accepted, false);
  assert.equal(earlyCommit.reason, 'COMMIT_NOT_READY');

  const subscriber = coordinator.recordSubscriber(subscriberEvidence(identity));
  assert.equal(subscriber.accepted, true);
  assert.equal(subscriber.state.candidate?.state, 'SUBSCRIBER_READY');

  const committed = coordinator.tryCommit(identity);
  assert.equal(committed.accepted, true);
  assert.equal(committed.state.committed?.sessionId, identity.sessionId);
  assert.equal(committed.state.candidate, null);
});

test('subscriber first is recorded but waits for resolution before commit', () => {
  const coordinator = createCoordinator();
  const { identity } = begin(coordinator);

  const subscriber = coordinator.recordSubscriber(subscriberEvidence(identity));
  assert.equal(subscriber.accepted, true);
  assert.equal(subscriber.reason, 'SUBSCRIBER_RECORDED');
  assert.equal(subscriber.state.candidate?.state, 'INTENT_PENDING');
  assert.equal(coordinator.tryCommit(identity).accepted, false);

  const resolution = coordinator.applyResolution(identity);
  assert.equal(resolution.accepted, true);
  assert.equal(resolution.state.candidate?.state, 'SUBSCRIBER_READY');
  assert.equal(coordinator.tryCommit(identity).accepted, true);
});

test('retire session removes only the matching lifecycle slot', () => {
  const coordinator = createCoordinator();
  const { identity } = begin(coordinator);
  const decision = coordinator.retireSession(identity, 'SUBSCRIBER_RETIRED');

  assert.equal(decision.accepted, true);
  assert.equal(decision.reason, 'SESSION_RETIRED');
  assert.equal(decision.retired[0]?.sessionId, identity.sessionId);
  assert.equal(decision.retired[0]?.state, 'RETIRED');
  assert.equal(coordinator.snapshot().candidate, null);
});

test('retire all clears candidate and committed without storing retired sessions', () => {
  const coordinator = createCoordinator();
  const committedIdentity = begin(coordinator).identity;
  commit(coordinator, committedIdentity);
  const candidateIdentity = begin(coordinator, '5', '5m').identity;

  const decision = coordinator.retireAll('WIDGET_DESTROY');
  assert.equal(decision.accepted, true);
  assert.equal(decision.reason, 'ALL_RETIRED');
  assert.deepEqual(
    decision.retired.map((session: any) => session.sessionId).sort(),
    [candidateIdentity.sessionId, committedIdentity.sessionId].sort(),
  );
  assert.deepEqual(coordinator.snapshot(), {
    latestIntentId: null,
    candidate: null,
    committed: null,
    candidateRearmUsed: false,
  });
});

test('rearm returns one deterministic permit and rejects a second request', () => {
  const coordinator = createCoordinator();
  const { identity } = begin(coordinator);
  coordinator.applyResolution(identity);

  const first = coordinator.requestRearm(identity, 'SUBSCRIBER_MISSING');
  assert.equal(first.allowed, true);
  assert.equal(first.reason, 'REARM_ALLOWED');
  assert.equal(first.permit?.permitId, `${identity.sessionId}:SUBSCRIBER_MISSING`);
  assert.equal(first.permit?.identity.sessionId, identity.sessionId);
  assert.equal(first.permit?.source, 'SUBSCRIBER_MISSING');

  const second = coordinator.requestRearm(identity, 'SUBSCRIBER_MISSING');
  assert.equal(second.allowed, false);
  assert.equal(second.reason, 'REARM_ALREADY_USED');
  assert.equal(second.permit, null);
});

test('Spot and Contract coordinator instances are fully isolated', () => {
  const spot = createCoordinator();
  const contract = createCoordinator({
    terminalType: 'CONTRACT',
    widgetGeneration: 7,
    datafeedInstanceId: 70,
    symbol: 'ETHUSDT',
  });
  const spotIdentity = begin(spot).identity;
  const contractIdentity = begin(contract, '1D', '1d').identity;

  spot.applyResolution(spotIdentity);
  contract.recordSubscriber(subscriberEvidence(contractIdentity));

  assert.equal(spot.snapshot().candidate?.state, 'RESOLUTION_APPLIED');
  assert.equal(contract.snapshot().candidate?.state, 'INTENT_PENDING');
  assert.equal(spot.snapshot().latestIntentId, 1);
  assert.equal(contract.snapshot().latestIntentId, 1);
  assert.equal(contractIdentity.sessionId, 'CONTRACT:7:70:1');

  const contractBefore = contract.snapshot();
  begin(spot, '5', '5m');
  assert.deepEqual(contract.snapshot(), contractBefore);
});

test('1000 intents keep memory bounded and do not expose internal mutable state', () => {
  const coordinator = createCoordinator();
  let latestIdentity: SessionIdentity | null = null;

  for (let index = 1; index <= 1000; index += 1) {
    const result = begin(coordinator, String(index), `${index}m`);
    latestIdentity = result.identity;
    assert.ok(activeSessionCount(result.decision.state) <= 2);
    assert.ok(activeSessionCount(coordinator.snapshot()) <= 2);
    assert.equal('retired' in coordinator.snapshot(), false);
  }

  const snapshot = coordinator.snapshot();
  assert.equal(snapshot.latestIntentId, 1000);
  assert.equal(snapshot.candidate?.sessionId, latestIdentity?.sessionId);
  assert.equal(snapshot.committed, null);

  snapshot.candidate!.symbol = 'MUTATED';
  assert.equal(coordinator.snapshot().candidate?.symbol, 'BTCUSDT');

  const independent = createCoordinator();
  assert.equal(begin(independent).identity.intentId, 1);
});
