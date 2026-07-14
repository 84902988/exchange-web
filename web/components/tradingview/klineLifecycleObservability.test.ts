/* eslint-disable @typescript-eslint/no-explicit-any -- Dynamic harness verifies browser-gated modules without a browser runtime. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

type LoadedModule = Record<string, any>;

type FakeWindow = {
  location: { search: string };
  KLINE_LIFECYCLE_DEBUG?: {
    version: number;
    enabled: boolean;
    getEvents: (query?: Record<string, unknown>) => any[];
    getSnapshots: () => any[];
    getStats: () => Record<string, number | null>;
  };
  __KLINE_LIFECYCLE_DEBUG__?: {
    version: number;
    enabled: boolean;
    getEvents: (query?: Record<string, unknown>) => any[];
    getSnapshots: () => any[];
    getStats: () => Record<string, number | null>;
  };
};

const observabilityPath = fileURLToPath(
  new URL('./klineLifecycleObservability.ts', import.meta.url),
);
const protocolPath = fileURLToPath(
  new URL('./klineLifecycleProtocol.ts', import.meta.url),
);
const runtimePath = fileURLToPath(
  new URL('./klineLifecycleRuntimeCoordinator.ts', import.meta.url),
);
const contractChartPath = fileURLToPath(
  new URL('../contract/ContractTradingViewChart.tsx', import.meta.url),
);

function transpileTypeScript(filePath: string) {
  return ts.transpileModule(readFileSync(filePath, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
      jsx: ts.JsxEmit.ReactJSX,
    },
    fileName: filePath,
  }).outputText;
}

function executeCommonJsModule(
  source: string,
  mocks: Record<string, unknown> = {},
): LoadedModule {
  const loadedModule: { exports: LoadedModule } = { exports: {} };
  const localRequire = (specifier: string) => {
    if (Object.prototype.hasOwnProperty.call(mocks, specifier)) return mocks[specifier];
    throw new Error(`Unexpected test import: ${specifier}`);
  };
  const execute = new Function('require', 'module', 'exports', source);
  execute(localRequire, loadedModule, loadedModule.exports);
  return loadedModule.exports;
}

function loadObservability() {
  return executeCommonJsModule(transpileTypeScript(observabilityPath));
}

function withBrowserEnvironment<T>(
  nodeEnv: string,
  search: string,
  callback: (observability: LoadedModule, fakeWindow: FakeWindow) => T,
): T {
  const previousNodeEnv = Object.getOwnPropertyDescriptor(process.env, 'NODE_ENV');
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const fakeWindow: FakeWindow = { location: { search } };
  try {
    Object.defineProperty(process.env, 'NODE_ENV', {
      configurable: true,
      enumerable: true,
      value: nodeEnv,
      writable: true,
    });
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: fakeWindow,
      writable: true,
    });
    return callback(loadObservability(), fakeWindow);
  } finally {
    if (previousNodeEnv) Object.defineProperty(process.env, 'NODE_ENV', previousNodeEnv);
    else Reflect.deleteProperty(process.env, 'NODE_ENV');
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else delete (globalThis as Record<string, unknown>).window;
  }
}

function session(
  intentId = 1,
  widgetGeneration = 1,
  terminalType: 'SPOT' | 'CONTRACT' = 'SPOT',
) {
  return {
    sessionId: `${terminalType}:${widgetGeneration}:${widgetGeneration * 10}:${intentId}`,
    terminalType,
    widgetGeneration,
    datafeedInstanceId: widgetGeneration * 10,
    intentId,
    symbol: `SYMBOL${widgetGeneration}`,
    tradingViewResolution: '1',
    backendInterval: '1m',
    subscriberUid: null,
    subscriptionGeneration: null,
    ownerId: null,
    state: 'INTENT_PENDING',
  };
}

function decision(candidate: any, overrides: Record<string, unknown> = {}) {
  return {
    state: {
      latestIntentId: candidate?.intentId ?? null,
      candidate,
      committed: null,
      candidateRearmUsed: false,
    },
    accepted: true,
    reason: 'REGISTERED',
    rearmAllowed: false,
    retireReason: null,
    retired: [],
    ...overrides,
  };
}

function recordRegister(observability: LoadedModule, value: any) {
  observability.recordKlineLifecycleDecision(
    'REGISTER_INTENT',
    value,
    decision(value),
  );
}

function enabledAccessor(fakeWindow: FakeWindow) {
  const accessor = fakeWindow.KLINE_LIFECYCLE_DEBUG;
  assert.ok(accessor, 'development query should install the debug accessor');
  assert.equal(fakeWindow.__KLINE_LIFECYCLE_DEBUG__, accessor);
  return accessor;
}

test('observability is closed by default and does not read a timestamp', () => {
  withBrowserEnvironment('test', '?klineLifecycleDebug=1', (observability, fakeWindow) => {
    const originalNow = Date.now;
    Date.now = () => { throw new Error('timestamp must not be read'); };
    try {
      recordRegister(observability, session());
    } finally {
      Date.now = originalNow;
    }
    assert.equal(fakeWindow.KLINE_LIFECYCLE_DEBUG, undefined);
    assert.equal(fakeWindow.__KLINE_LIFECYCLE_DEBUG__, undefined);
  });
});

test('production stays closed even when the URL query requests debugging', () => {
  withBrowserEnvironment('production', '?klineLifecycleDebug=1', (observability, fakeWindow) => {
    recordRegister(observability, session());
    assert.equal(fakeWindow.KLINE_LIFECYCLE_DEBUG, undefined);
    assert.equal(fakeWindow.__KLINE_LIFECYCLE_DEBUG__, undefined);
  });
});

test('development stays closed without the explicit URL query', () => {
  withBrowserEnvironment('development', '', (observability, fakeWindow) => {
    recordRegister(observability, session());
    assert.equal(fakeWindow.KLINE_LIFECYCLE_DEBUG, undefined);
    assert.equal(fakeWindow.__KLINE_LIFECYCLE_DEBUG__, undefined);
  });
});

test('development plus query installs the readonly accessor during document bootstrap', () => {
  withBrowserEnvironment(
    'development',
    '?klineLifecycleDebug=1',
    (observability, fakeWindow) => {
      const accessor = enabledAccessor(fakeWindow);
      assert.equal(accessor.version, 1);
      assert.equal(accessor.enabled, true);
      assert.equal(accessor.getEvents().length, 0);
      assert.deepEqual(Object.keys(accessor).sort(), [
        'enabled',
        'getEvents',
        'getSnapshots',
        'getStats',
        'version',
      ]);
      assert.deepEqual(
        Object.keys(accessor).filter((key) => (
          typeof (accessor as Record<string, unknown>)[key] === 'function'
          && /emit|dispatch|commit|retire|rearm|reset|clear|enable/i.test(key)
        )),
        [],
      );
      const descriptor = Object.getOwnPropertyDescriptor(
        fakeWindow,
        'KLINE_LIFECYCLE_DEBUG',
      );
      assert.equal(descriptor?.writable, false);
      assert.equal(descriptor?.configurable, false);
      assert.equal(
        Object.getOwnPropertyDescriptor(fakeWindow, '__KLINE_LIFECYCLE_DEBUG__')?.value,
        accessor,
      );

      recordRegister(observability, session());
      assert.equal(accessor.getEvents().length, 1);
    },
  );
});

test('fresh browser documents install independent accessors before lifecycle evidence', () => {
  const accessors: unknown[] = [];
  for (let documentIndex = 0; documentIndex < 2; documentIndex += 1) {
    withBrowserEnvironment(
      'development',
      '?klineLifecycleDebug=1',
      (_observability, fakeWindow) => {
        const accessor = enabledAccessor(fakeWindow);
        assert.equal(accessor.getEvents().length, 0);
        accessors.push(accessor);
      },
    );
  }
  assert.notEqual(accessors[0], accessors[1]);
});

test('a false query gate is not permanent for the current development document', () => {
  withBrowserEnvironment('development', '', (observability, fakeWindow) => {
    assert.equal(fakeWindow.KLINE_LIFECYCLE_DEBUG, undefined);
    assert.equal(fakeWindow.__KLINE_LIFECYCLE_DEBUG__, undefined);
    fakeWindow.location.search = '?klineLifecycleDebug=1';
    observability.bootstrapKlineLifecycleObservability();
    assert.equal(enabledAccessor(fakeWindow).getEvents().length, 0);
  });
});

test('SPA query removal keeps the same accessor and continues recording for the document', () => {
  withBrowserEnvironment(
    'development',
    '?klineLifecycleDebug=1',
    (observability, fakeWindow) => {
      const accessor = enabledAccessor(fakeWindow);
      fakeWindow.location.search = '';
      observability.bootstrapKlineLifecycleObservability();
      recordRegister(observability, session());
      assert.equal(fakeWindow.KLINE_LIFECYCLE_DEBUG, accessor);
      assert.equal(accessor.getEvents().length, 1);
      fakeWindow.location.search = '?symbol=ETHUSDT';
      recordRegister(observability, session(2));
      assert.equal(accessor.getEvents().length, 2);
    },
  );
});

test('ring buffer keeps 512 newest events with monotonic sequence and drop count', () => {
  withBrowserEnvironment(
    'development',
    '?klineLifecycleDebug=1',
    (observability, fakeWindow) => {
      for (let index = 1; index <= 515; index += 1) {
        recordRegister(observability, session(index));
      }
      const accessor = enabledAccessor(fakeWindow);
      const events = accessor.getEvents();
      const stats = accessor.getStats();
      assert.equal(events.length, 512);
      assert.equal(events[0].sequence, 4);
      assert.equal(events.at(-1).sequence, 515);
      assert.equal(stats.capacity, 512);
      assert.equal(stats.eventCount, 512);
      assert.equal(stats.droppedEventCount, 3);
      assert.equal(stats.oldestSequence, 4);
      assert.equal(stats.latestSequence, 515);
    },
  );
});

test('events, snapshots, and stats are copies rather than internal references', () => {
  withBrowserEnvironment(
    'development',
    '?klineLifecycleDebug=1',
    (observability, fakeWindow) => {
      recordRegister(observability, session());
      const accessor = enabledAccessor(fakeWindow);
      const returnedEvents = accessor.getEvents();
      returnedEvents[0].identity.symbol = 'MUTATED';
      returnedEvents[0].metadata.reason = 'MUTATED';
      returnedEvents.push({ sequence: 99 });
      const returnedSnapshots = accessor.getSnapshots();
      returnedSnapshots[0].state.candidate.symbol = 'MUTATED';
      returnedSnapshots.push({ widgetIdentity: 'MUTATED' });
      const returnedStats = accessor.getStats();
      returnedStats.eventCount = 99;

      assert.equal(accessor.getEvents().length, 1);
      assert.equal(accessor.getEvents()[0].identity.symbol, 'SYMBOL1');
      assert.equal(accessor.getEvents()[0].metadata.reason, 'REGISTERED');
      assert.equal(accessor.getSnapshots().length, 1);
      assert.equal(accessor.getSnapshots()[0].state.candidate.symbol, 'SYMBOL1');
      assert.equal(accessor.getStats().eventCount, 1);
    },
  );
});

test('snapshot registry isolates widgets and evicts the oldest beyond eight', () => {
  withBrowserEnvironment(
    'development',
    '?klineLifecycleDebug=1',
    (observability, fakeWindow) => {
      for (let widgetGeneration = 1; widgetGeneration <= 10; widgetGeneration += 1) {
        recordRegister(observability, session(1, widgetGeneration));
      }
      const replacementSymbol = {
        ...session(2, 10),
        symbol: 'REPLACEMENT',
      };
      recordRegister(observability, replacementSymbol);
      const accessor = enabledAccessor(fakeWindow);
      const snapshots = accessor.getSnapshots();
      assert.equal(snapshots.length, 8);
      assert.equal(accessor.getStats().snapshotCount, 8);
      assert.deepEqual(
        snapshots.map((entry) => entry.state.candidate.widgetGeneration),
        [3, 4, 5, 6, 7, 8, 9, 10],
      );
      assert.equal(snapshots.at(-1).state.candidate.symbol, 'REPLACEMENT');
      assert.notEqual(snapshots[0].state.candidate, snapshots[1].state.candidate);
    },
  );
});

test('Runtime emits accepted and rejected lifecycle evidence including stale callbacks', () => {
  withBrowserEnvironment(
    'development',
    '?klineLifecycleDebug=1',
    (observability, fakeWindow) => {
      const protocol = executeCommonJsModule(transpileTypeScript(protocolPath));
      const runtime = executeCommonJsModule(transpileTypeScript(runtimePath), {
        './klineLifecycleProtocol': protocol,
        './klineLifecycleObservability': observability,
      });
      const coordinator = new runtime.KlineLifecycleRuntimeCoordinator({
        terminalType: 'SPOT',
        widgetGeneration: 1,
        datafeedInstanceId: 10,
        symbol: 'BTCUSDT',
      });
      const first = coordinator.beginIntent({
        tradingViewResolution: '1',
        backendInterval: '1m',
      }).identity;
      assert.equal(coordinator.tryCommit(first).accepted, false);
      const latest = coordinator.beginIntent({
        tradingViewResolution: '5',
        backendInterval: '5m',
      }).identity;
      assert.equal(coordinator.applyResolution(first).accepted, false);
      assert.equal(coordinator.recordSubscriber({
        ...first,
        subscriberUid: 'stale-subscriber',
        subscriptionGeneration: 1,
        ownerId: 'stale-owner',
      }).accepted, false);
      assert.equal(coordinator.applyResolution(latest).accepted, true);
      assert.equal(coordinator.recordSubscriber({
        ...latest,
        subscriberUid: 'active-subscriber',
        subscriptionGeneration: 2,
        ownerId: 'active-owner',
      }).accepted, true);
      assert.equal(coordinator.tryCommit(latest).accepted, true);
      assert.equal(coordinator.retireAll('WIDGET_DESTROY').accepted, true);

      const events = enabledAccessor(fakeWindow).getEvents();
      assert.ok(events.some((entry) => (
        entry.event === 'COMMITTED'
        && entry.metadata.accepted
        && entry.identity.sessionId === latest.sessionId
      )));
      assert.ok(events.some((entry) => (
        entry.event === 'COMMITTED'
        && !entry.metadata.accepted
        && entry.metadata.reason === 'COMMIT_NOT_READY'
      )));
      assert.ok(events.some((entry) => (
        entry.event === 'RESOLUTION_APPLIED'
        && !entry.metadata.accepted
        && entry.identity.sessionId === first.sessionId
      )));
      assert.ok(events.some((entry) => (
        entry.event === 'SUBSCRIBER_READY'
        && !entry.metadata.accepted
        && entry.identity.subscriberUid === 'stale-subscriber'
      )));
      assert.ok(events.some((entry) => (
        entry.event === 'RETIRED'
        && entry.metadata.retireReason === 'SUPERSEDED'
        && entry.identity.sessionId === first.sessionId
      )));
      assert.ok(events.some((entry) => (
        entry.event === 'RETIRED'
        && entry.metadata.retireReason === 'WIDGET_DESTROY'
        && entry.identity.sessionId === latest.sessionId
      )));
    },
  );
});

test('rearm accepted/rejected and reset executed true/false use one evidence channel', () => {
  withBrowserEnvironment(
    'development',
    '?klineLifecycleDebug=1',
    (observability, fakeWindow) => {
      const protocol = executeCommonJsModule(transpileTypeScript(protocolPath));
      const runtime = executeCommonJsModule(transpileTypeScript(runtimePath), {
        './klineLifecycleProtocol': protocol,
        './klineLifecycleObservability': observability,
      });
      const coordinator = new runtime.KlineLifecycleRuntimeCoordinator({
        terminalType: 'CONTRACT',
        widgetGeneration: 7,
        datafeedInstanceId: 41,
        symbol: 'BTCUSDT_PERP',
      });
      const identity = coordinator.beginIntent({
        tradingViewResolution: '1',
        backendInterval: '1m',
      }).identity;
      coordinator.applyResolution(identity);
      assert.equal(coordinator.requestRearm(identity, 'RESTORED_BASELINE').allowed, true);
      assert.equal(coordinator.requestRearm(identity, 'RESTORED_BASELINE').allowed, false);
      const subscriber = {
        subscriberUid: 'contract-subscriber',
        subscriptionGeneration: 17,
        ownerId: 'contract-owner',
      };
      coordinator.recordResetExecution(
        identity,
        'RESTORED_BASELINE',
        true,
        'RESET_EXECUTED',
        subscriber,
      );
      coordinator.recordResetExecution(
        identity,
        'SUBSCRIBER_MISSING',
        false,
        'RESET_EXECUTION_FAILED',
      );

      const events = enabledAccessor(fakeWindow).getEvents();
      const rearm = events.filter((entry) => entry.event === 'REARM_REQUESTED');
      const reset = events.filter((entry) => entry.event === 'RESET_EXECUTED');
      assert.deepEqual(rearm.map((entry) => entry.metadata.accepted), [true, false]);
      assert.deepEqual(rearm.map((entry) => entry.metadata.reason), [
        'REARM_ALLOWED',
        'REARM_ALREADY_USED',
      ]);
      assert.deepEqual(reset.map((entry) => entry.metadata.accepted), [true, false]);
      assert.equal(reset[0].source, 'CHART_RESET_EXECUTOR');
      assert.equal(reset[0].metadata.resetSource, 'RESTORED_BASELINE');
      assert.equal(reset[0].identity.subscriptionGeneration, 17);
      assert.equal(reset[1].metadata.resetSource, 'SUBSCRIBER_MISSING');
    },
  );
});

test('event schema contains lifecycle identity only and no market payload fields', () => {
  withBrowserEnvironment(
    'development',
    '?klineLifecycleDebug=1',
    (observability, fakeWindow) => {
      recordRegister(observability, session());
      const event = enabledAccessor(fakeWindow).getEvents()[0];
      assert.deepEqual(Object.keys(event).sort(), [
        'event', 'identity', 'metadata', 'schemaVersion', 'sequence', 'source',
      ]);
      assert.deepEqual(Object.keys(event.identity).sort(), [
        'backendInterval',
        'datafeedInstanceId',
        'intentId',
        'ownerId',
        'sessionId',
        'subscriberUid',
        'subscriptionGeneration',
        'symbol',
        'terminalType',
        'tradingViewResolution',
        'widgetGeneration',
      ]);
      assert.deepEqual(Object.keys(event.metadata).sort(), [
        'accepted', 'reason', 'resetSource', 'retireReason', 'timestamp',
      ]);
      for (const forbidden of ['candle', 'bar', 'OHLCV', 'price', 'revision', 'providerPayload']) {
        assert.equal(Object.prototype.hasOwnProperty.call(event, forbidden), false);
        assert.equal(Object.prototype.hasOwnProperty.call(event.identity, forbidden), false);
        assert.equal(Object.prototype.hasOwnProperty.call(event.metadata, forbidden), false);
      }
    },
  );
});

test('recorder failures cannot change Runtime decisions or committed state', () => {
  const protocol = executeCommonJsModule(transpileTypeScript(protocolPath));
  const recorderFailure = {
    recordKlineLifecycleDecision() {
      throw new Error('recorder failed');
    },
    recordKlineLifecycleResetExecution() {
      throw new Error('recorder failed');
    },
  };
  const runtime = executeCommonJsModule(transpileTypeScript(runtimePath), {
    './klineLifecycleProtocol': protocol,
    './klineLifecycleObservability': recorderFailure,
  });
  const coordinator = new runtime.KlineLifecycleRuntimeCoordinator({
    terminalType: 'SPOT',
    widgetGeneration: 1,
    datafeedInstanceId: 10,
    symbol: 'BTCUSDT',
  });
  const identity = coordinator.beginIntent({
    tradingViewResolution: '1',
    backendInterval: '1m',
  }).identity;
  assert.equal(coordinator.applyResolution(identity).accepted, true);
  assert.equal(coordinator.recordSubscriber({
    ...identity,
    subscriberUid: 'subscriber',
    subscriptionGeneration: 1,
    ownerId: 'owner',
  }).accepted, true);
  assert.equal(coordinator.tryCommit(identity).accepted, true);
  coordinator.recordResetExecution(
    identity,
    'SUBSCRIBER_MISSING',
    false,
    'RESET_EXECUTION_FAILED',
  );
  assert.equal(coordinator.snapshot().committed?.sessionId, identity.sessionId);
});

test('Protocol stays pure and Contract reset evidence follows executor completion', () => {
  const protocolSource = readFileSync(protocolPath, 'utf8');
  const contractSource = readFileSync(contractChartPath, 'utf8');
  assert.doesNotMatch(
    protocolSource,
    /klineLifecycleObservability|__KLINE_LIFECYCLE_DEBUG__|\bwindow\b|Date\.now/,
  );

  const permitExecution = contractSource.indexOf(
    'executeResetPermit(requirement, result.permit)',
  );
  const permitEvidence = contractSource.indexOf(
    'runtimeCoordinator.recordResetExecution(',
    permitExecution,
  );
  const resetExecution = contractSource.indexOf('chart.resetData();');
  const resetEvidence = contractSource.indexOf(
    'runtimeCoordinator.recordResetExecution(',
    resetExecution,
  );
  assert.ok(permitExecution >= 0 && permitEvidence > permitExecution);
  assert.ok(resetExecution >= 0 && resetEvidence > resetExecution);
  assert.doesNotMatch(contractSource, /recordResetExecution[\s\S]{0,100}requestRearm\(/);
});
