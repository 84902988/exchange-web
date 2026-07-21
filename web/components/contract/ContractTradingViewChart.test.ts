/* eslint-disable @typescript-eslint/no-explicit-any -- Dynamic test harness loads compiled TSX exports. */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test as nodeTest } from 'node:test';
import ts from 'typescript';

const test = (
  globalThis as typeof globalThis & { test?: typeof nodeTest }
).test || nodeTest;

function resolveWebTestFile(...relativePath: string[]) {
  const webRoot = existsSync(resolve(process.cwd(), 'components', 'contract'))
    ? process.cwd()
    : resolve(process.cwd(), 'web');
  return resolve(webRoot, ...relativePath);
}

function resolveContractTestFile(relativePath: string) {
  return resolveWebTestFile('components', 'contract', relativePath);
}

const contractChartSource = readFileSync(
  resolveContractTestFile('ContractTradingViewChart.tsx'),
  'utf8',
);

test('keeps the chart mounted for early script loading but fences widget creation on metadata', () => {
  assert.match(contractChartSource, /bootstrapReady\?: boolean;/);
  assert.match(
    contractChartSource,
    /if \(!bootstrapReady \|\| !scriptReady \|\| !normalizedSymbol \|\| !containerRef\.current\)/,
  );
  assert.match(contractChartSource, /data-contract-chart-bootstrap=\{bootstrapReady \? 'ready' : 'pending'\}/);
  assert.match(contractChartSource, /!bootstrapReady[\s\S]*shouldShowContractChartLoading/);
  assert.match(contractChartSource, /useState\('bootstrap'\)/);
});

function loadTypeScriptModule(
  filePath: string,
  mocks: Record<string, unknown>,
): Record<string, any> {
  const source = readFileSync(filePath, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
    fileName: filePath,
  }).outputText;
  const loadedModule: { exports: Record<string, any> } = { exports: {} };
  const localRequire = (specifier: string) => {
    if (Object.prototype.hasOwnProperty.call(mocks, specifier)) return mocks[specifier];
    throw new Error(`Unexpected test import: ${specifier}`);
  };
  const execute = new Function(
    'require',
    'module',
    'exports',
    '__filename',
    '__dirname',
    output,
  );
  execute(
    localRequire,
    loadedModule,
    loadedModule.exports,
    filePath,
    filePath.slice(0, Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))),
  );
  return loadedModule.exports;
}

const intervalToResolution = (interval: string) => ({
  '1m': '1',
  '5m': '5',
  '15m': '15',
  '1h': '60',
  '4h': '240',
  '1d': '1D',
  '1w': '1W',
  '1M': '1M',
}[interval] || '1');

const policyModule = loadTypeScriptModule(
  resolveContractTestFile('tradingview/contractKlineCachePolicy.ts'),
  {},
);
const loadPolicyModule = loadTypeScriptModule(
  resolveContractTestFile('tradingview/contractKlineLoadPolicy.ts'),
  {},
);
const lifecycleProtocolModule = loadTypeScriptModule(
  resolveWebTestFile('components/tradingview/klineLifecycleProtocol.ts'),
  {},
);
const lifecycleRuntimeModule = loadTypeScriptModule(
  resolveWebTestFile('components/tradingview/klineLifecycleRuntimeCoordinator.ts'),
  {
    './klineLifecycleProtocol': lifecycleProtocolModule,
    './klineLifecycleObservability': {
      recordKlineLifecycleDecision: () => undefined,
      recordKlineLifecycleResetExecution: () => undefined,
    },
  },
);
const chartModule = loadTypeScriptModule(
  resolveContractTestFile('ContractTradingViewChart.tsx'),
  {
    react: {
      useCallback: (callback: unknown) => callback,
      useEffect() {},
      useLayoutEffect() {},
      useId: () => 'test-id',
      useMemo: (factory: () => unknown) => factory(),
      useRef: (value: unknown) => ({ current: value }),
      useState: (value: unknown) => [typeof value === 'function' ? (value as () => unknown)() : value, () => {}],
    },
    'react/jsx-runtime': {
      jsx: () => null,
      jsxs: () => null,
      Fragment: Symbol('Fragment'),
    },
    'next/script': { __esModule: true, default: () => null },
    '@/contexts/LocaleContext': {
      useLocaleContext: () => ({ locale: 'en', t: (key: string) => key }),
    },
    '@/lib/displayTimeZone': {
      getDisplayTimeZone: () => 'Etc/UTC',
    },
    '@/lib/tradingview/displayTimeZoneSync': {
      bindTradingViewDisplayTimeZone: () => () => undefined,
    },
    '@/components/spot/tradingview/spotTradingViewResolutionState': {
      setSpotToolbarLoadingState: () => undefined,
    },
    '@/components/tradingview/klineLifecycleProtocol': lifecycleProtocolModule,
    '@/components/tradingview/klineLifecycleRuntimeCoordinator': lifecycleRuntimeModule,
    '@/components/tradingview/tradingViewViewportLifecycle': {
      applyTradingViewViewport: async () => ({
        applied: true,
        attempts: 1,
        reason: 'applied',
        visibleRange: null,
      }),
    },
    './tradingview/contractTradingViewDatafeed': {
      contractIntervalToTradingViewResolution: intervalToResolution,
      createContractTradingViewDatafeed: () => ({ destroy() {} }),
    },
    './tradingview/contractKlineCachePolicy': policyModule,
    './tradingview/contractKlineLoadPolicy': loadPolicyModule,
    './tradingview/contractKlinePreloadManager': {
      createContractKlinePreloadManager: () => ({
        schedule() {},
        prewarmInterval() { return true; },
        cancel() {},
        setForegroundState() {},
        destroy() {},
      }),
    },
    './tradingview/contractTradingViewPriceOverlay': {
      ContractTradingViewPriceOverlayController: class {
        update() {}
        reset() {}
        destroy() {}
      },
    },
    './tradingview/contractTradingViewPositionLines': {
      buildContractTradingViewPositionLines: () => [],
      ContractTradingViewPositionLinesController: class {
        update() {}
        clear() {}
        destroy() {}
      },
    },
  },
);

class FakeClock {
  nowValue = 0;
  nextId = 1;
  tasks = new Map<number, { at: number; callback: () => void }>();

  now = () => this.nowValue;

  setTimeout = (callback: () => void, delayMs: number) => {
    const id = this.nextId;
    this.nextId += 1;
    this.tasks.set(id, { at: this.nowValue + Math.max(0, delayMs), callback });
    return id;
  };

  clearTimeout = (handle: unknown) => {
    this.tasks.delete(Number(handle));
  };

  advanceBy(milliseconds: number) {
    const target = this.nowValue + milliseconds;
    while (true) {
      const next = Array.from(this.tasks.entries())
        .filter(([, task]) => task.at <= target)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
      if (!next) break;
      const [id, task] = next;
      this.tasks.delete(id);
      this.nowValue = task.at;
      task.callback();
    }
    this.nowValue = target;
  }
}


test('Chart wires resolution intent commit and failed-candidate rollback to the datafeed authority', () => {
  assert.match(contractChartSource, /datafeed\.beginResolutionTransition\(\{/);
  assert.match(contractChartSource, /transitionGeneration:\s*result\.identity\.intentId/);
  assert.match(
    contractChartSource,
    /datafeedRef\.current\?\.commitResolutionTransition\(committed\.intentId\)/,
  );
  assert.match(
    contractChartSource,
    /datafeedRef\.current\?\.rollbackResolutionTransition\(identity\.intentId\)/,
  );
  assert.match(contractChartSource, /transitionGeneration:\s*initialIntent\.identity\.intentId/);
});


test('TIME keeps the candle interval while using real 1m line mode', () => {
  assert.equal(chartModule.resolveContractEffectiveKlineInterval('candle', '1m'), '1m');
  assert.equal(chartModule.resolveContractWidgetStyle('candle'), 1);

  const timeSelection = chartModule.resolveContractToolbarSelection('time', '1h');
  assert.deepEqual(timeSelection, { chartMode: 'time', interval: '1h' });
  assert.equal(chartModule.resolveContractEffectiveKlineInterval('time', timeSelection.interval), '1m');
  assert.equal(chartModule.resolveContractWidgetStyle(timeSelection.chartMode), 2);

  const candleSelection = chartModule.resolveContractToolbarSelection('5m', timeSelection.interval);
  assert.deepEqual(candleSelection, { chartMode: 'candle', interval: '5m' });
  assert.equal(chartModule.resolveContractEffectiveKlineInterval(candleSelection.chartMode, candleSelection.interval), '5m');
  assert.equal(chartModule.resolveContractWidgetStyle(candleSelection.chartMode), 1);
});


test('TIME and candle toolbar highlights are mutually exclusive', () => {
  assert.equal(chartModule.isContractToolbarButtonActive('time', 'time', '1h'), true);
  assert.equal(chartModule.isContractToolbarButtonActive('1h', 'time', '1h'), false);
  assert.equal(chartModule.isContractToolbarButtonActive('time', 'candle', '1h'), false);
  assert.equal(chartModule.isContractToolbarButtonActive('1h', 'candle', '1h'), true);
});


test('TIME keeps the native Spot gradient without changing candle or volume colors', () => {
  assert.deepEqual(chartModule.CONTRACT_TIME_SERIES_OVERRIDES, {
    'mainSeriesProperties.areaStyle.color1': 'rgba(240,185,11,0.24)',
    'mainSeriesProperties.areaStyle.color2': 'rgba(240,185,11,0.02)',
    'mainSeriesProperties.areaStyle.linecolor': '#f0b90b',
    'mainSeriesProperties.areaStyle.linewidth': 2,
  });
  assert.equal(
    Object.keys(chartModule.CONTRACT_TIME_SERIES_OVERRIDES).some((key) => key.includes('lineStyle')),
    false,
  );
  assert.match(chartModule.CONTRACT_CHART_LOADING_OVERLAY_CLASS_NAME, /pointer-events-none/);
  assert.doesNotMatch(chartModule.CONTRACT_CHART_LOADING_OVERLAY_CLASS_NAME, /pointer-events-auto/);
});


test('rapid real toolbar intent keeps the last 1H selection and resolution request', async () => {
  let chartMode = 'candle';
  let interval = '1m';
  const requested: string[] = [];
  const committed: string[] = [];
  let currentRequest = 0;
  let activeResolution = '1';
  const requests: Array<Promise<void>> = [];

  for (const key of ['1m', '5m', '15m', '1h']) {
    const selection = chartModule.resolveContractToolbarSelection(key, interval);
    chartMode = selection.chartMode;
    interval = selection.interval;
    const resolution = intervalToResolution(
      chartModule.resolveContractEffectiveKlineInterval(chartMode, interval),
    );
    const request = ++currentRequest;
    requests.push(chartModule.requestContractSetResolution({
      chart: {
        setResolution(nextResolution: string) {
          requested.push(nextResolution);
          activeResolution = nextResolution;
        },
        dataReady: async () => true,
        resolution: () => activeResolution,
      },
      resolution,
      isCurrent: () => request === currentRequest,
      onSettled: () => committed.push(resolution),
      onFallback: assert.fail,
    }));
  }

  await Promise.all(requests);
  assert.equal(chartMode, 'candle');
  assert.equal(interval, '1h');
  assert.equal(requested.at(-1), '60');
  assert.equal(chartModule.isContractToolbarButtonActive('1h', chartMode, interval), true);
  assert.deepEqual(committed, ['60']);
});


test('candle interval changes keep widget identity and invoke setResolution', async () => {
  const base = {
    symbol: 'BTCUSDT_PERP',
    locale: 'en',
    pricePrecision: 1,
    amountPrecision: 4,
    chartMode: 'candle',
    fallbackNonce: 0,
  };
  const oneMinuteKey = chartModule.buildContractWidgetIdentityKey(base);
  const fiveMinuteKey = chartModule.buildContractWidgetIdentityKey({ ...base });
  assert.equal(oneMinuteKey, fiveMinuteKey);

  let requestedResolution = '';
  let settled = 0;
  let fallback = 0;
  await chartModule.requestContractSetResolution({
    chart: {
      setResolution(resolution: string) {
        requestedResolution = resolution;
      },
      dataReady: async () => true,
      resolution: () => requestedResolution,
    },
    resolution: '5',
    isCurrent: () => true,
    onSettled: () => { settled += 1; },
    onFallback: () => { fallback += 1; },
  });

  assert.equal(requestedResolution, '5');
  assert.equal(settled, 1);
  assert.equal(fallback, 0);
});

test('canonical category is part of widget identity while interval remains excluded', () => {
  const base = {
    symbol: 'SHARED_PERP',
    category: 'UNKNOWN',
    locale: 'en',
    pricePrecision: 1,
    amountPrecision: 4,
    chartMode: 'candle',
    fallbackNonce: 0,
  };

  const unknownKey = chartModule.buildContractWidgetIdentityKey(base);
  const stockKey = chartModule.buildContractWidgetIdentityKey({ ...base, category: 'STOCK' });
  const normalizedStockKey = chartModule.buildContractWidgetIdentityKey({
    ...base,
    category: ' stock ',
  });
  assert.notEqual(unknownKey, stockKey);
  assert.equal(stockKey, normalizedStockKey);
  assert.equal(
    chartModule.buildContractWidgetIdentityKey({ ...base }),
    chartModule.buildContractWidgetIdentityKey({ ...base, category: 'UNKNOWN' }),
  );

  const categoryIdentitySequence = ['UNKNOWN', ' stock ', 'STOCK'].map((category) => (
    chartModule.buildContractWidgetIdentityKey({ ...base, category })
  ));
  const replacementCount = categoryIdentitySequence.slice(1).reduce(
    (count, key, index) => count + (key === categoryIdentitySequence[index] ? 0 : 1),
    0,
  );
  assert.equal(replacementCount, 1, 'UNKNOWN to STOCK must cause one stable widget replacement');
});


test('setResolution waits for dataReady and verifies the active resolution before commit', async () => {
  let settled = 0;
  let resolveDataReady!: (value: boolean) => void;
  const dataReady = new Promise<boolean>((resolve) => {
    resolveDataReady = resolve;
  });
  let activeResolution = '5';
  const request = chartModule.requestContractSetResolution({
    chart: {
      setResolution(nextResolution: string) {
        activeResolution = nextResolution;
        return Promise.resolve(true);
      },
      dataReady: () => dataReady,
      resolution: () => activeResolution,
    },
    resolution: '15',
    isCurrent: () => true,
    onSettled: () => { settled += 1; },
    onFallback: assert.fail,
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(settled, 0, 'setResolution completion alone must not commit the resolution');
  resolveDataReady(true);
  await request;
  assert.equal(settled, 1);
});


test('setResolution false requests one fallback rebuild', async () => {
  let settled = 0;
  const fallbackReasons: string[] = [];
  await chartModule.requestContractSetResolution({
    chart: { setResolution: () => false },
    resolution: '5',
    isCurrent: () => true,
    onSettled: () => { settled += 1; },
    onFallback: (reason: string) => fallbackReasons.push(reason),
  });
  assert.equal(settled, 0);
  assert.deepEqual(fallbackReasons, ['setResolution returned false']);
  const identity = {
    symbol: 'BTCUSDT_PERP',
    locale: 'en',
    chartMode: 'candle',
    fallbackNonce: 0,
  };
  assert.notEqual(
    chartModule.buildContractWidgetIdentityKey(identity),
    chartModule.buildContractWidgetIdentityKey({ ...identity, fallbackNonce: 1 }),
  );
});


test('setResolution rejection and throw each request fallback', async () => {
  const reasons: string[] = [];
  await chartModule.requestContractSetResolution({
    chart: { setResolution: () => Promise.reject(new Error('reject')) },
    resolution: '5',
    isCurrent: () => true,
    onSettled: assert.fail,
    onFallback: (reason: string) => reasons.push(reason),
  });
  await chartModule.requestContractSetResolution({
    chart: { setResolution: () => { throw new Error('throw'); } },
    resolution: '15',
    isCurrent: () => true,
    onSettled: assert.fail,
    onFallback: (reason: string) => reasons.push(reason),
  });
  assert.deepEqual(reasons, ['setResolution rejected', 'setResolution threw']);
});


test('rapid resolution changes ignore stale dataReady completion and keep the latest resolution', async () => {
  let currentRequest = 1;
  let resolveFirstReady!: (value: boolean) => void;
  let resolveSecondReady!: (value: boolean) => void;
  const firstReady = new Promise<boolean>((resolve) => { resolveFirstReady = resolve; });
  const secondReady = new Promise<boolean>((resolve) => { resolveSecondReady = resolve; });
  const committed: string[] = [];
  let activeResolution = '5';

  const firstRequest = chartModule.requestContractSetResolution({
    chart: {
      setResolution(nextResolution: string) {
        activeResolution = nextResolution;
      },
      dataReady: () => firstReady,
      resolution: () => activeResolution,
    },
    resolution: '5',
    isCurrent: () => currentRequest === 1,
    onSettled: () => committed.push('5'),
    onFallback: assert.fail,
  });
  await Promise.resolve();

  currentRequest = 2;
  const secondRequest = chartModule.requestContractSetResolution({
    chart: {
      setResolution(nextResolution: string) {
        activeResolution = nextResolution;
      },
      dataReady: () => secondReady,
      resolution: () => activeResolution,
    },
    resolution: '15',
    isCurrent: () => currentRequest === 2,
    onSettled: () => committed.push('15'),
    onFallback: assert.fail,
  });
  await Promise.resolve();
  resolveFirstReady(true);
  resolveSecondReady(true);
  await Promise.all([firstRequest, secondRequest]);
  assert.deepEqual(committed, ['15']);
});


function createContractRuntime(overrides: Record<string, unknown> = {}) {
  return new lifecycleRuntimeModule.KlineLifecycleRuntimeCoordinator({
    terminalType: 'CONTRACT',
    widgetGeneration: 7,
    datafeedInstanceId: 41,
    symbol: 'BTCUSDT_PERP',
    ...overrides,
  });
}

function beginContractRuntime(
  coordinator: any,
  resolution = '1',
  interval = '1m',
) {
  return coordinator.beginIntent({ tradingViewResolution: resolution, backendInterval: interval });
}

function runtimeEvidence(identity: any, generation = identity.intentId) {
  return {
    ...identity,
    subscriberUid: `subscriber-${generation}`,
    subscriptionGeneration: generation,
    ownerId: `owner-${generation}`,
  };
}

test('5m to 1M to 5m transport defers the latest session while one request is active', () => {
  const runtime = createContractRuntime();
  const transport = new chartModule.ContractResolutionIntentCoordinator();
  const monthly = beginContractRuntime(runtime, '1M', '1M').identity;
  const monthlyRequest = transport.request({
    sessionId: monthly.sessionId,
    resolution: monthly.tradingViewResolution,
    intentId: monthly.intentId,
  }, { canStart: true, isLatest: true });
  assert.equal(monthlyRequest.action, 'start');

  const finalFive = beginContractRuntime(runtime, '5', '5m').identity;
  const pending = transport.request({
    sessionId: finalFive.sessionId,
    resolution: finalFive.tradingViewResolution,
    intentId: finalFive.intentId,
  }, { canStart: true, isLatest: true });
  assert.equal(pending.action, 'pending');
  assert.equal(runtime.snapshot().candidate?.sessionId, finalFive.sessionId);
  assert.equal(transport.snapshot().activeToken?.sessionId, monthly.sessionId);
});

test('settling old transport lets the Runtime latest session start without legacy commit', () => {
  const runtime = createContractRuntime();
  const transport = new chartModule.ContractResolutionIntentCoordinator();
  const first = beginContractRuntime(runtime, '1D', '1d').identity;
  const firstRequest = transport.request({
    sessionId: first.sessionId,
    resolution: first.tradingViewResolution,
    intentId: first.intentId,
  }, { canStart: true, isLatest: true });
  const latest = beginContractRuntime(runtime, '1', '1m').identity;

  assert.equal(transport.settle(firstRequest.token).accepted, true);
  assert.equal(runtime.applyResolution(first).accepted, false, 'retired session cannot resolve');
  const latestRequest = transport.request({
    sessionId: latest.sessionId,
    resolution: latest.tradingViewResolution,
    intentId: latest.intentId,
  }, { canStart: true, isLatest: true });
  assert.equal(latestRequest.action, 'start');
  assert.equal(runtime.snapshot().committed, null);
});

test('transport coordinator snapshot contains scheduling state and no lifecycle truth', () => {
  const transport = new chartModule.ContractResolutionIntentCoordinator();
  const decision = transport.request({ sessionId: 'session-1', resolution: '1', intentId: 1 }, {
    canStart: true,
    isLatest: true,
  });
  assert.equal(decision.action, 'start');
  assert.deepEqual(Object.keys(transport.snapshot()).sort(), ['activeToken', 'requestSequence']);
  assert.equal('committedResolution' in transport.snapshot(), false);
  assert.equal('lifecycleState' in transport.snapshot(), false);
  const source = readFileSync(resolveContractTestFile('ContractTradingViewChart.tsx'), 'utf8');
  assert.match(source, /new KlineLifecycleRuntimeCoordinator\(/);
  assert.doesNotMatch(
    source,
    /committedResolutionRef|commitLifecycle|registerLifecycleSession|markLifecycleResolutionApplied|markLifecycleSubscriberReady/,
  );
});

test('transport reset invalidates the active request token without committing lifecycle state', () => {
  const transport = new chartModule.ContractResolutionIntentCoordinator();
  const decision = transport.request({ sessionId: 'session-1', resolution: '1', intentId: 1 }, {
    canStart: true,
    isLatest: true,
  });
  assert.equal(transport.isCurrent(decision.token), true);
  transport.reset();
  assert.equal(transport.isCurrent(decision.token), false);
  assert.equal(transport.settle(decision.token).accepted, false);
});


test('resolution commit recheck is bounded and exhausts exactly once', () => {
  const clock = new FakeClock();
  let retryCalls = 0;
  let exhaustedCalls = 0;
  const retryController: any = new chartModule.ContractResolutionCommitRetryController({
    clock,
    delayMs: 10,
    maxAttempts: 2,
    onRetry: () => {
      retryCalls += 1;
      retryController.requestRetry();
    },
    onExhausted: () => { exhaustedCalls += 1; },
  });

  assert.equal(retryController.requestRetry(), true);
  clock.advanceBy(20);
  assert.equal(retryCalls, 2);
  assert.equal(exhaustedCalls, 1);
  assert.deepEqual(retryController.snapshot(), {
    attempts: 2,
    pending: false,
    finished: true,
  });
  assert.equal(retryController.requestRetry(), false);
  assert.equal(exhaustedCalls, 1);
});


test('deferred resolution continuation revalidates token widget generation and target', () => {
  const token = { resolution: '1', intentId: 2, requestSequence: 3 };
  const guardNames = ['token', 'widget', 'generation', 'target'] as const;

  for (const rejectedGuard of guardNames) {
    const scheduledMicrotasks: Array<() => void> = [];
    const guards = {
      token: true,
      widget: true,
      generation: true,
      target: true,
    };
    let readyCalls = 0;
    let rejectedCalls = 0;
    chartModule.scheduleContractResolutionContinuation({
      token,
      isTokenCurrent: () => guards.token,
      isWidgetCurrent: () => guards.widget,
      isGenerationCurrent: () => guards.generation,
      isTargetResolutionCurrent: () => guards.target,
      onReady: () => { readyCalls += 1; },
      onRejected: () => { rejectedCalls += 1; },
      schedule: (callback: () => void) => scheduledMicrotasks.push(callback),
    });

    guards[rejectedGuard] = false;
    scheduledMicrotasks.shift()?.();
    assert.equal(readyCalls, 0, `${rejectedGuard} must be checked at execution time`);
    assert.equal(rejectedCalls, 1);
  }
});


function lifecycleEvidence(session: any, generation = 1) {
  return {
    ...lifecycleProtocolModule.getKlineLifecycleSessionIdentity(session),
    subscriberUid: `subscriber-${session.backendInterval}-${generation}`,
    subscriptionGeneration: generation,
    ownerId: `owner-${session.backendInterval}-${generation}`,
  };
}

test('Contract initial resolution follows REGISTER then RESOLUTION then SUBSCRIBER then COMMIT', () => {
  const runtime = createContractRuntime();
  const initial = beginContractRuntime(runtime, '1', '1m');
  assert.equal(initial.decision.state.candidate?.state, 'INTENT_PENDING');
  assert.equal(runtime.tryCommit(initial.identity).accepted, false);
  assert.equal(runtime.applyResolution(initial.identity).state.candidate?.state, 'RESOLUTION_APPLIED');
  assert.equal(runtime.tryCommit(initial.identity).accepted, false);
  assert.equal(
    runtime.recordSubscriber(runtimeEvidence(initial.identity, 1)).state.candidate?.state,
    'SUBSCRIBER_READY',
  );
  assert.equal(runtime.tryCommit(initial.identity).state.committed?.state, 'COMMITTED');
});

test('resolution ready without realtime subscription evidence cannot commit', () => {
  const runtime = createContractRuntime();
  const { identity } = beginContractRuntime(runtime);
  runtime.applyResolution(identity);
  assert.equal(runtime.tryCommit(identity).accepted, false);
  assert.equal(runtime.snapshot().candidate?.state, 'RESOLUTION_APPLIED');
});

test('subscriber readiness before resolution cannot commit', () => {
  const runtime = createContractRuntime();
  const { identity } = beginContractRuntime(runtime);
  runtime.recordSubscriber(runtimeEvidence(identity, 2));
  assert.equal(runtime.tryCommit(identity).accepted, false);
  assert.equal(runtime.snapshot().candidate?.state, 'INTENT_PENDING');
});

test('matching resolution and subscriber evidence is the only Contract commit path', () => {
  const runtime = createContractRuntime();
  const { identity } = beginContractRuntime(runtime);
  runtime.recordSubscriber(runtimeEvidence(identity, 3));
  runtime.applyResolution(identity);
  assert.equal(runtime.snapshot().candidate?.state, 'SUBSCRIBER_READY');
  assert.equal(runtime.tryCommit(identity).accepted, true);
  assert.equal(runtime.snapshot().committed?.sessionId, identity.sessionId);
});

test('rapid 1m to 5m to 1D to 1M commits only the final Contract intent', () => {
  const runtime = createContractRuntime();
  const identities = [
    beginContractRuntime(runtime, '1', '1m').identity,
    beginContractRuntime(runtime, '5', '5m').identity,
    beginContractRuntime(runtime, '1D', '1d').identity,
    beginContractRuntime(runtime, '1M', '1M').identity,
  ];
  for (const identity of identities.slice(0, -1)) {
    assert.equal(runtime.applyResolution(identity).accepted, false);
    assert.equal(runtime.recordSubscriber(runtimeEvidence(identity)).accepted, false);
    assert.equal(runtime.tryCommit(identity).accepted, false);
  }
  const latest = identities.at(-1);
  runtime.applyResolution(latest);
  runtime.recordSubscriber(runtimeEvidence(latest, 9));
  assert.equal(runtime.tryCommit(latest).accepted, true);
  assert.equal(runtime.snapshot().committed?.backendInterval, '1M');
});

test('old resolution subscriber and commit callbacks are rejected after a newer intent', () => {
  const runtime = createContractRuntime();
  const oldIdentity = beginContractRuntime(runtime, '1', '1m').identity;
  const latest = beginContractRuntime(runtime, '5', '5m').identity;
  assert.equal(runtime.applyResolution(oldIdentity).reason, 'STALE_SESSION');
  assert.equal(runtime.recordSubscriber(runtimeEvidence(oldIdentity, 1)).reason, 'STALE_SESSION');
  assert.equal(runtime.tryCommit(oldIdentity).accepted, false);
  assert.equal(runtime.snapshot().candidate?.sessionId, latest.sessionId);
});

test('Spot and Contract produce the same final state for one lifecycle event sequence', () => {
  const run = (terminalType: 'SPOT' | 'CONTRACT') => {
    const session = lifecycleProtocolModule.createKlineLifecycleSession({
      terminalType,
      widgetGeneration: 4,
      datafeedInstanceId: 8,
      intentId: 12,
      symbol: 'BTCUSDT',
      tradingViewResolution: '5',
      backendInterval: '5m',
    });
    const identity = lifecycleProtocolModule.getKlineLifecycleSessionIdentity(session);
    const evidence = lifecycleEvidence(session, 6);
    let state = lifecycleProtocolModule.createInitialKlineLifecycleProtocolState();
    state = lifecycleProtocolModule.reduceKlineLifecycle(
      state,
      { type: 'REGISTER_INTENT', session },
    ).state;
    state = lifecycleProtocolModule.reduceKlineLifecycle(
      state,
      { type: 'SUBSCRIBER_READY', evidence },
    ).state;
    state = lifecycleProtocolModule.reduceKlineLifecycle(
      state,
      { type: 'RESOLUTION_APPLIED', identity },
    ).state;
    state = lifecycleProtocolModule.reduceKlineLifecycle(
      state,
      { type: 'COMMIT', evidence },
    ).state;
    return {
      latestIntentId: state.latestIntentId,
      candidateState: state.candidate?.state || null,
      committedState: state.committed?.state || null,
      rearmUsed: state.candidateRearmUsed,
    };
  };

  assert.deepEqual(run('CONTRACT'), run('SPOT'));
});

test('BTC to ETH to BTC supersedes old Contract sessions and rejects their late evidence', () => {
  const firstBtc = createContractRuntime({ widgetGeneration: 1, datafeedInstanceId: 11 });
  const firstIdentity = beginContractRuntime(firstBtc).identity;
  firstBtc.retireAll('SYMBOL_SWITCH');
  const eth = createContractRuntime({
    widgetGeneration: 2,
    datafeedInstanceId: 12,
    symbol: 'ETHUSDT_PERP',
  });
  eth.retireAll('SYMBOL_SWITCH');
  const secondBtc = createContractRuntime({ widgetGeneration: 3, datafeedInstanceId: 13 });
  const secondIdentity = beginContractRuntime(secondBtc).identity;

  assert.equal(firstBtc.recordSubscriber(runtimeEvidence(firstIdentity, 9)).accepted, false);
  assert.notEqual(secondIdentity.sessionId, firstIdentity.sessionId);
  assert.equal(secondBtc.snapshot().candidate?.symbol, 'BTCUSDT_PERP');
});

test('rapid 1m to 5m to 1D to 1M to 5m commits only the latest Contract intent', () => {
  const runtime = createContractRuntime();
  const sessions: any[] = [];
  for (const [resolution, interval] of [
    ['1', '1m'],
    ['5', '5m'],
    ['1D', '1d'],
    ['1M', '1M'],
    ['5', '5m'],
  ]) {
    sessions.push(beginContractRuntime(runtime, resolution, interval).identity);
  }
  const finalSession = sessions.at(-1);
  assert.equal(runtime.applyResolution(sessions[1]).accepted, false);
  runtime.applyResolution(finalSession);
  runtime.recordSubscriber(runtimeEvidence(finalSession, 11));
  assert.equal(runtime.tryCommit(finalSession).accepted, true);
  assert.equal(runtime.snapshot().committed?.intentId, finalSession.intentId);
  assert.equal(runtime.snapshot().committed?.backendInterval, '5m');
});

test('Contract widget destroy retires the generation and rejects late subscriber callbacks', () => {
  const runtime = createContractRuntime({ widgetGeneration: 18 });
  const { identity } = beginContractRuntime(runtime);
  runtime.applyResolution(identity);
  const retired = runtime.retireAll('WIDGET_DESTROY');

  assert.equal(retired.accepted, true);
  assert.equal(retired.retired[0]?.state, 'RETIRED');
  assert.equal(runtime.applyResolution(identity).accepted, false);
  assert.equal(runtime.recordSubscriber(runtimeEvidence(identity, 4)).accepted, false);
  assert.equal(runtime.tryCommit(identity).accepted, false);
});

test('missing subscriber and restored baseline share one Contract rearm budget', () => {
  const runtime = createContractRuntime();
  const { identity } = beginContractRuntime(runtime);
  runtime.applyResolution(identity);
  const first = runtime.requestRearm(identity, 'RESTORED_BASELINE');
  const second = runtime.requestRearm(identity, 'SUBSCRIBER_MISSING');
  assert.equal(first.allowed, true);
  assert.equal(first.permit?.source, 'RESTORED_BASELINE');
  assert.equal(second.allowed, false);
  assert.equal(second.reason, 'REARM_ALREADY_USED');
  const beforeObservation = runtime.snapshot();
  runtime.recordResetExecution(
    identity,
    'RESTORED_BASELINE',
    true,
    'RESET_EXECUTED',
    runtimeEvidence(identity, 1),
  );
  runtime.recordResetExecution(
    identity,
    'SUBSCRIBER_MISSING',
    false,
    'RESET_EXECUTION_FAILED',
  );
  assert.deepEqual(runtime.snapshot(), beforeObservation);
});

test('Contract Runtime keeps at most one candidate and one committed session', () => {
  const runtime = createContractRuntime();
  const committedIdentity = beginContractRuntime(runtime).identity;
  runtime.applyResolution(committedIdentity);
  runtime.recordSubscriber(runtimeEvidence(committedIdentity, 1));
  runtime.tryCommit(committedIdentity);
  const candidateIdentity = beginContractRuntime(runtime, '5', '5m').identity;
  const state = runtime.snapshot();
  assert.equal(state.committed?.sessionId, committedIdentity.sessionId);
  assert.equal(state.candidate?.sessionId, candidateIdentity.sessionId);
  assert.equal('retired' in state, false);
});


test('history completion validation rejects old symbol interval resolution and sequence', () => {
  const event = {
    symbol: 'BTCUSDT_PERP',
    interval: '5m',
    resolution: '5',
    requestSeq: 4,
  };
  const expected = {
    symbol: 'BTCUSDT_PERP',
    interval: '5m',
    resolution: '5',
    minimumRequestSeq: 4,
  };
  assert.equal(chartModule.isContractHistoryEventCurrent(event, expected), true);
  assert.equal(chartModule.isContractHistoryEventCurrent({ ...event, symbol: 'ETHUSDT_PERP' }, expected), false);
  assert.equal(chartModule.isContractHistoryEventCurrent({ ...event, interval: '1m' }, expected), false);
  assert.equal(chartModule.isContractHistoryEventCurrent({ ...event, resolution: '1' }, expected), false);
  assert.equal(chartModule.isContractHistoryEventCurrent({ ...event, requestSeq: 3 }, expected), false);
});


test('current history completion ends Loading while an old history event cannot', () => {
  const clock = new FakeClock();
  const changes: string[] = [];
  const coordinator = new chartModule.ContractChartLoadingCoordinator({
    onChange: (reason: string) => changes.push(reason),
    clock,
  });
  const sequence = coordinator.start('set-resolution');
  const expected = {
    symbol: 'BTCUSDT_PERP',
    interval: '5m',
    resolution: '5',
    minimumRequestSeq: 2,
  };
  const oldEvent = { ...expected, requestSeq: 1 };
  const currentEvent = { ...expected, requestSeq: 2, barCount: 0, firstDataRequest: true };
  if (chartModule.isContractHistoryEventCurrent(oldEvent, expected)) coordinator.finish(sequence);
  clock.advanceBy(chartModule.CONTRACT_CHART_LOADING_MIN_VISIBLE_MS);
  assert.deepEqual(changes, ['set-resolution']);
  if (chartModule.isContractHistoryEventCurrent(currentEvent, expected)) coordinator.finish(sequence);
  clock.advanceBy(0);
  assert.deepEqual(changes, ['set-resolution', '']);
});


test('Loading starts immediately, respects minimum visibility, and settles once', () => {
  assert.equal(chartModule.CONTRACT_CHART_LOADING_DOT_COUNT, 4);
  assert.equal(chartModule.CONTRACT_CHART_LOADING_MIN_VISIBLE_MS, 520);
  const clock = new FakeClock();
  const changes: string[] = [];
  const coordinator = new chartModule.ContractChartLoadingCoordinator({
    onChange: (reason: string) => changes.push(reason),
    clock,
  });

  const sequence = coordinator.start('interval-click');
  assert.deepEqual(changes, ['interval-click']);
  assert.equal(coordinator.finish(sequence), true);
  assert.equal(coordinator.finish(sequence), false);
  clock.advanceBy(chartModule.CONTRACT_CHART_LOADING_MIN_VISIBLE_MS - 1);
  assert.deepEqual(changes, ['interval-click']);
  clock.advanceBy(1);
  assert.deepEqual(changes, ['interval-click', '']);
});


test('old Loading completion cannot close the latest request', () => {
  const clock = new FakeClock();
  const changes: string[] = [];
  const coordinator = new chartModule.ContractChartLoadingCoordinator({
    onChange: (reason: string) => changes.push(reason),
    clock,
  });

  const oldSequence = coordinator.start('1m');
  const latestSequence = coordinator.start('15m');
  assert.equal(coordinator.finish(oldSequence), false);
  clock.advanceBy(chartModule.CONTRACT_CHART_LOADING_MIN_VISIBLE_MS);
  assert.deepEqual(changes, ['1m', '15m']);
  assert.equal(coordinator.finish(latestSequence), true);
  clock.advanceBy(0);
  assert.deepEqual(changes, ['1m', '15m', '']);
});


test('Loading safety timeout ends at 5 seconds and errors take display priority', () => {
  const clock = new FakeClock();
  const changes: string[] = [];
  const coordinator = new chartModule.ContractChartLoadingCoordinator({
    onChange: (reason: string) => changes.push(reason),
    clock,
  });
  coordinator.start('widget-build');
  clock.advanceBy(4999);
  assert.deepEqual(changes, ['widget-build']);
  clock.advanceBy(1);
  assert.deepEqual(changes, ['widget-build', '']);
  assert.equal(chartModule.shouldShowContractChartLoading('widget-build', ''), true);
  assert.equal(chartModule.shouldShowContractChartLoading('widget-build', 'load failed'), false);
});


test('load error hides and finishes Loading without duplicate completion', () => {
  const clock = new FakeClock();
  const changes: string[] = [];
  const coordinator = new chartModule.ContractChartLoadingCoordinator({
    onChange: (reason: string) => changes.push(reason),
    clock,
  });
  const sequence = coordinator.start('widget-build');
  assert.equal(chartModule.shouldShowContractChartLoading('widget-build', 'load failed'), false);
  assert.equal(coordinator.finish(sequence), true);
  assert.equal(coordinator.finish(sequence), false);
  clock.advanceBy(chartModule.CONTRACT_CHART_LOADING_MIN_VISIBLE_MS);
  assert.deepEqual(changes, ['widget-build', '']);
});


test('destroyed Loading coordinator clears timers without later side effects', () => {
  const clock = new FakeClock();
  const changes: string[] = [];
  const coordinator = new chartModule.ContractChartLoadingCoordinator({
    onChange: (reason: string) => changes.push(reason),
    clock,
  });
  coordinator.start('widget-build');
  coordinator.destroy();
  clock.advanceBy(6000);
  assert.deepEqual(changes, ['widget-build']);
  assert.equal(clock.tasks.size, 0);
});

test('initial visible range matches Spot at 50 bars and keeps four right-padding bars', () => {
  const latestBarTimeMs = 1_800_000_000_000;
  for (const interval of ['1m', '5m', '15m', '1h', '4h', '1d', '1w', '1M']) {
    const range = chartModule.resolveContractInitialVisibleRange(interval, latestBarTimeMs);
    assert.equal(range.targetVisibleBars, 50, interval);
    assert.equal(range.rightPaddingBars, 4, interval);
    assert.equal(range.range.to, Math.floor(latestBarTimeMs / 1000), interval);
  }

  const fifteenMinutes = chartModule.resolveContractInitialVisibleRange('15m', latestBarTimeMs);
  assert.equal(fifteenMinutes.intervalSeconds, 15 * 60);
  assert.equal(
    fifteenMinutes.range.to - fifteenMinutes.range.from,
    50 * 15 * 60,
  );
});

test('native TradingView last value and main price line are disabled', () => {
  assert.deepEqual(chartModule.CONTRACT_TV_PRICE_LABEL_OVERRIDES, {
    'mainSeriesProperties.showPriceLine': false,
    'scalesProperties.showSeriesLastValue': false,
  });
});

test('contract chart lookup contains destroyed widget access and rejects stale instances', () => {
  const chart = { resolution: () => '5' };
  assert.equal(chartModule.getCurrentContractTradingViewChart({
    widget: { activeChart: () => { throw new Error('destroyed widget'); } },
    chartReady: true,
    isCurrent: () => true,
  }), null);
  assert.equal(chartModule.getCurrentContractTradingViewChart({
    widget: { activeChart: () => chart },
    chartReady: true,
    isCurrent: () => false,
  }), null);
  assert.equal(chartModule.getCurrentContractTradingViewChart({
    widget: { activeChart: () => chart },
    chartReady: true,
    isCurrent: () => true,
  }), chart);
});

test('reference viewport expands once per symbol interval scope without following realtime ticks', () => {
  const appliedRanges: Array<{ from: number; to: number }> = [];
  const priceScale = {
    getVisiblePriceRange: () => ({ from: 334, to: 335 }),
    setVisiblePriceRange: (range: { from: number; to: number }) => appliedRanges.push(range),
  };
  const chart = {
    getPanes: () => [{
      hasMainSeries: () => true,
      getMainSourcePriceScale: () => priceScale,
    }],
  };
  const coordinator = new chartModule.ContractReferenceViewportCoordinator();

  assert.equal(coordinator.ensure({
    scope: '1|AAPLUSDT_PERP|1m',
    chart,
    referencePrice: 315,
    isCurrent: () => true,
  }), 'APPLIED');
  assert.equal(appliedRanges.length, 1);
  assert.ok(appliedRanges[0].from < 315);
  assert.ok(appliedRanges[0].to > 335);

  assert.equal(coordinator.ensure({
    scope: '1|AAPLUSDT_PERP|1m',
    chart,
    referencePrice: 314,
    isCurrent: () => true,
  }), 'ALREADY');
  assert.equal(appliedRanges.length, 1, 'realtime ticks must not keep rescaling the viewport');

  assert.equal(coordinator.ensure({
    scope: '1|AAPLUSDT_PERP|1d',
    chart,
    referencePrice: 315,
    isCurrent: () => true,
  }), 'APPLIED');
  assert.equal(appliedRanges.length, 2, 'resolution switch gets one new viewport fit');
});

function makeReferencePrice(
  value: number | null,
  overrides: Record<string, unknown> = {},
) {
  const usable = value !== null;
  return {
    value,
    domain: usable ? 'TRADES' : 'UNAVAILABLE',
    source: usable ? 'CONTRACT_TRADES' : null,
    provider: usable ? 'BINANCE_USDM' : null,
    freshness: usable ? 'LIVE' : null,
    eventTimeMs: usable ? 1_720_000_000_000 : null,
    receivedAtMs: usable ? 1_720_000_000_100 : null,
    generation: usable ? 9 : null,
    revision: usable ? { epoch: 9, sequence: 12, isClosed: false, checksum: null } : null,
    usable,
    rejectReason: usable ? null : 'REFERENCE_PRICE_UNAVAILABLE',
    symbol: 'BTCUSDT_PERP',
    interval: '1m',
    role: usable ? 'LAST_TRADE' : 'UNAVAILABLE',
    ...overrides,
  };
}

test('last trade reference 100 produces overlay 100', () => {
  const overlayPrice = chartModule.resolveContractTradingViewOverlayPrice(
    makeReferencePrice(100),
    'BTCUSDT_PERP',
  );

  assert.equal(overlayPrice, 100);
});

test('closed-market ticker reference produces the same TradingView overlay evidence', () => {
  const overlayPrice = chartModule.resolveContractTradingViewOverlayPrice(
    makeReferencePrice(327.5, {
      domain: 'TICKER',
      source: 'LAST_PRICE',
      provider: 'ITICK_QUOTE',
      freshness: 'LAST_VALID',
      role: 'LAST_PRICE',
    }),
    'BTCUSDT_PERP',
  );

  assert.equal(overlayPrice, 327.5);
});

test('Kline close remains 99 while last-trade overlay remains 100', () => {
  const candle = { open: 98, high: 101, low: 97, close: 99 };
  const overlayPrice = chartModule.resolveContractTradingViewOverlayPrice(
    makeReferencePrice(100),
    'BTCUSDT_PERP',
  );

  assert.equal(candle.close, 99);
  assert.equal(overlayPrice, 100);
});

test('tradfi current price line uses the Header price before the latest Kline catches up', () => {
  assert.equal(
    chartModule.resolveContractTradingViewActiveOverlayPrice(true, 4059.3, 4060.08),
    4060.08,
  );
});

test('tradfi current price line stays hidden until the symbol-scoped Header price is ready', () => {
  assert.equal(
    chartModule.resolveContractTradingViewActiveOverlayPrice(true, 4059.3, null),
    null,
  );
});

test('legacy crypto overlay keeps latest-Kline then Price Authority fallback precedence', () => {
  assert.equal(
    chartModule.resolveContractTradingViewActiveOverlayPrice(false, 99, 100),
    99,
  );
  assert.equal(
    chartModule.resolveContractTradingViewActiveOverlayPrice(false, null, 100),
    100,
  );
});

test('mark, index, book mid, and execution prices cannot influence overlay', () => {
  const authority = {
    reference_price: makeReferencePrice(100),
    mark_price: { value: 110 },
    index_price: { value: 111 },
    book_mid_price: { value: 112 },
    execution_bid: { value: 99 },
    execution_ask: { value: 101 },
  };
  const overlayPrice = chartModule.resolveContractTradingViewOverlayPrice(
    authority.reference_price,
    'BTCUSDT_PERP',
  );

  assert.equal(overlayPrice, 100);
  for (const domain of ['MARK', 'INDEX', 'DEPTH', 'EXECUTION']) {
    assert.equal(
      chartModule.resolveContractTradingViewOverlayPrice(
        makeReferencePrice(110, { domain }),
        'BTCUSDT_PERP',
      ),
      null,
    );
  }
});

test('unavailable or previous-symbol reference does not produce an overlay', () => {
  assert.equal(
    chartModule.resolveContractTradingViewOverlayPrice(
      makeReferencePrice(null),
      'BTCUSDT_PERP',
    ),
    null,
  );
  assert.equal(
    chartModule.resolveContractTradingViewOverlayPrice(
      makeReferencePrice(100, { symbol: 'BTCUSDT_PERP' }),
      'ETHUSDT_PERP',
    ),
    null,
  );
});

function createOverlayLifecycleHarness() {
  const updates: Array<Record<string, unknown>> = [];
  let exists = false;
  let destroyCalls = 0;
  const lifecycle = new chartModule.ContractPriceOverlayLifecycle(() => ({
    update(input: Record<string, unknown>) {
      exists = true;
      updates.push(input);
    },
    destroy() {
      exists = false;
      destroyCalls += 1;
    },
  }));
  return {
    lifecycle,
    updates,
    exists: () => exists,
    destroyCalls: () => destroyCalls,
  };
}

const overlayInput = (interval: string, symbol = 'BTCUSDT_PERP') => ({
  symbol,
  interval,
  displayPrice: 100,
  priceDirection: 'flat',
});

test('1M history error resumes the suspended price overlay without destroying it', () => {
  const harness = createOverlayLifecycleHarness();
  harness.lifecycle.resume(overlayInput('5m'));
  harness.lifecycle.suspend();

  harness.lifecycle.resume(overlayInput('1M'));

  assert.equal(harness.lifecycle.state(), 'active');
  assert.equal(harness.exists(), true, 'price line must still exist after monthly history error');
  assert.equal(harness.destroyCalls(), 0);
  assert.equal(harness.updates.at(-1)?.interval, '1M');
});

test('resolution timeout restores the stable price overlay', async () => {
  const harness = createOverlayLifecycleHarness();
  const clock = new FakeClock();
  harness.lifecycle.resume(overlayInput('5m'));
  harness.lifecycle.suspend();
  const activeResolution = '5';

  const request = chartModule.requestContractSetResolution({
    chart: {
      setResolution() {},
      dataReady: () => new Promise<boolean>(() => undefined),
      resolution: () => activeResolution,
    },
    resolution: '1M',
    isCurrent: () => true,
    onCommitted: assert.fail,
    onFailed: () => harness.lifecycle.resume(overlayInput('5m')),
    clock,
    timeoutMs: 100,
  });
  clock.advanceBy(100);
  await request;

  assert.equal(activeResolution, '5');
  assert.equal(harness.lifecycle.state(), 'active');
  assert.equal(harness.exists(), true);
  assert.equal(harness.destroyCalls(), 0);
  assert.equal(harness.updates.at(-1)?.interval, '5m');
});

test('resolution rollback restores the overlay after rollback commit', async () => {
  const harness = createOverlayLifecycleHarness();
  harness.lifecycle.resume(overlayInput('5m'));
  harness.lifecycle.suspend();
  let activeResolution = '1M';

  await chartModule.requestContractSetResolution({
    chart: {
      setResolution(nextResolution: string) {
        activeResolution = nextResolution;
      },
      dataReady: async () => true,
      resolution: () => activeResolution,
    },
    resolution: '5',
    isCurrent: () => true,
    onCommitted: () => harness.lifecycle.resume(overlayInput('5m')),
    onFailed: assert.fail,
  });

  assert.equal(activeResolution, '5');
  assert.equal(harness.lifecycle.state(), 'active');
  assert.equal(harness.exists(), true);
  assert.equal(harness.destroyCalls(), 0);
});

test('symbol switch cleanup is the terminal overlay destroy boundary', () => {
  const harness = createOverlayLifecycleHarness();
  harness.lifecycle.resume(overlayInput('5m'));

  harness.lifecycle.destroy();
  harness.lifecycle.resume(overlayInput('5m', 'ETHUSDT_PERP'));
  harness.lifecycle.destroy();

  assert.equal(harness.lifecycle.state(), 'destroyed');
  assert.equal(harness.exists(), false);
  assert.equal(harness.destroyCalls(), 1);
  assert.equal(harness.updates.length, 1, 'destroyed symbol lifecycle must reject late resume');
});
