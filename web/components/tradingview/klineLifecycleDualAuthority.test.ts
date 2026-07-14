/* eslint-disable @typescript-eslint/no-explicit-any -- Dynamic harness preserves production extensionless imports. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

function readSource(relativeUrl: string) {
  return readFileSync(fileURLToPath(new URL(relativeUrl, import.meta.url)), 'utf8');
}

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
const RuntimeCoordinator = runtimeModule.KlineLifecycleRuntimeCoordinator;

function createRuntime(terminalType: 'SPOT' | 'CONTRACT' = 'SPOT') {
  return new RuntimeCoordinator({
    terminalType,
    widgetGeneration: 7,
    datafeedInstanceId: terminalType === 'SPOT' ? 41 : 42,
    symbol: 'BTCUSDT',
  });
}

function evidence(identity: Record<string, unknown>, generation: number) {
  return {
    ...identity,
    subscriberUid: `subscriber-${generation}`,
    subscriptionGeneration: generation,
    ownerId: `owner-${generation}`,
  };
}

function commit(
  runtime: any,
  tradingViewResolution: string,
  backendInterval: string,
  generation: number,
) {
  const intent = runtime.beginIntent({ tradingViewResolution, backendInterval });
  assert.equal(runtime.applyResolution(intent.identity).accepted, true);
  assert.equal(runtime.recordSubscriber(evidence(intent.identity, generation)).accepted, true);
  assert.equal(runtime.tryCommit(intent.identity).accepted, true);
  return intent.identity;
}

test('Protocol commit has no legacy Chart commit gate or second commit authority', () => {
  const spotChart = readSource('../spot/SpotTradingViewChart.tsx');
  const contractChart = readSource('../contract/ContractTradingViewChart.tsx');

  for (const source of [spotChart, contractChart]) {
    assert.match(source, /new KlineLifecycleRuntimeCoordinator\(/);
    assert.match(source, /runtimeCoordinator\.tryCommit\(identity\)/);
    assert.match(source, /applyCommittedLifecycleEffects/);
    assert.doesNotMatch(
      source,
      /commitLifecycle|committedResolutionRef|candidate\.state\s*!==\s*'SUBSCRIBER_READY'/,
    );
    assert.doesNotMatch(source, /reduceKlineLifecycle\(/);
  }
});

test('reset policy has one Runtime permit source before Chart or Datafeed executes reset', () => {
  const runtime = createRuntime('CONTRACT');
  const intent = runtime.beginIntent({ tradingViewResolution: '1', backendInterval: '1m' });
  runtime.applyResolution(intent.identity);
  const first = runtime.requestRearm(intent.identity, 'RESTORED_BASELINE');
  const second = runtime.requestRearm(intent.identity, 'SUBSCRIBER_MISSING');
  assert.equal(first.allowed, true);
  assert.equal(second.allowed, false);
  assert.equal(second.reason, 'REARM_ALREADY_USED');

  const spotChart = readSource('../spot/SpotTradingViewChart.tsx');
  const contractChart = readSource('../contract/ContractTradingViewChart.tsx');
  const contractDatafeed = readSource(
    '../contract/tradingview/contractTradingViewDatafeed.ts',
  );
  const spotRequestRearm = spotChart.indexOf(
    "runtimeCoordinator.requestRearm(identity, 'SUBSCRIBER_MISSING')",
  );
  const spotResetData = spotChart.indexOf('chart.resetData();');
  assert.ok(spotRequestRearm >= 0);
  assert.ok(spotResetData > spotRequestRearm);
  assert.match(contractChart, /runtimeCoordinator\.requestRearm\(identity, source\)/);
  assert.match(contractChart, /chart\.resetData\(\)/);
  assert.match(contractChart, /datafeedRef\.current\?\.executeResetPermit/);
  assert.equal(contractDatafeed.match(/entry\.resetCallback\(\)/g)?.length, 1);
  assert.ok(
    contractDatafeed.indexOf('executeResetPermit(requirement, permit)')
      < contractDatafeed.indexOf('entry.resetCallback()'),
  );
});

test('stale resolution subscriber and commit callbacks cannot change committed state', () => {
  const runtime = createRuntime();
  const retiredIdentity = commit(runtime, '1', '1m', 1);
  const currentIdentity = commit(runtime, '5', '5m', 2);
  const committedBeforeAttack = runtime.snapshot().committed;

  assert.equal(runtime.applyResolution(retiredIdentity).accepted, false);
  assert.equal(runtime.recordSubscriber(evidence(retiredIdentity, 3)).accepted, false);
  assert.equal(runtime.tryCommit(retiredIdentity).accepted, false);
  assert.deepEqual(runtime.snapshot().committed, committedBeforeAttack);
  assert.equal(runtime.snapshot().committed?.sessionId, currentIdentity.sessionId);
});

test('render and transport refs are not lifecycle truth', () => {
  const spotChart = readSource('../spot/SpotTradingViewChart.tsx');
  const spotTransport = readSource('../spot/tradingview/spotTradingViewResolutionState.ts');
  const contractChart = readSource('../contract/ContractTradingViewChart.tsx');
  const combinedCharts = `${spotChart}\n${contractChart}`;

  assert.doesNotMatch(
    combinedCharts,
    /committedResolutionRef|currentResolutionRef|latestIntentRef|lifecycleTokenRef/,
  );
  assert.match(contractChart, /activeTradingViewResolutionRef/);
  assert.match(contractChart, /requestedResolutionRef/);
  assert.doesNotMatch(
    `${spotTransport}\n${contractChart}`,
    /private\s+(latestIntent|pendingResolution|currentResolution|committedResolution)/,
  );

  const runtime = createRuntime();
  const identity = commit(runtime, '1D', '1Dutc', 1);
  const stateBeforeRenderMutation = runtime.snapshot();
  const renderOnlyRef = { current: '1' };
  renderOnlyRef.current = '1M';
  assert.deepEqual(runtime.snapshot(), stateBeforeRenderMutation);
  assert.equal(runtime.snapshot().committed?.sessionId, identity.sessionId);
});
