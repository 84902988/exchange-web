/* eslint-disable @typescript-eslint/no-explicit-any -- Dynamic test harness loads compiled TSX exports. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';


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
  fileURLToPath(new URL('./tradingview/contractKlineCachePolicy.ts', import.meta.url)),
  {},
);
const loadPolicyModule = loadTypeScriptModule(
  fileURLToPath(new URL('./tradingview/contractKlineLoadPolicy.ts', import.meta.url)),
  {},
);
const chartModule = loadTypeScriptModule(
  fileURLToPath(new URL('./ContractTradingViewChart.tsx', import.meta.url)),
  {
    react: {
      useCallback: (callback: unknown) => callback,
      useEffect() {},
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
    '@/components/spot/tradingview/spotTradingViewResolutionState': {
      setSpotToolbarLoadingState: () => undefined,
    },
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


test('TIME uses yellow line and area overrides while Loading remains click-through', () => {
  assert.deepEqual(chartModule.CONTRACT_TIME_SERIES_OVERRIDES, {
    'mainSeriesProperties.lineStyle.colorType': 'solid',
    'mainSeriesProperties.lineStyle.gradientStartColor': '#f0b90b',
    'mainSeriesProperties.lineStyle.gradientEndColor': '#f0b90b',
    'mainSeriesProperties.lineStyle.color': '#f0b90b',
    'mainSeriesProperties.lineStyle.linewidth': 2,
    'mainSeriesProperties.lineStyle.linestyle': 0,
    'mainSeriesProperties.lineStyle.priceSource': 'close',
    'mainSeriesProperties.areaStyle.color1': 'rgba(240,185,11,0.24)',
    'mainSeriesProperties.areaStyle.color2': 'rgba(240,185,11,0.02)',
    'mainSeriesProperties.areaStyle.linecolor': '#f0b90b',
    'mainSeriesProperties.areaStyle.linewidth': 2,
  });
  assert.deepEqual(chartModule.CONTRACT_TIME_LINE_STYLE_PREFERENCES, {
    colorType: 'solid',
    gradientStartColor: '#f0b90b',
    gradientEndColor: '#f0b90b',
    color: '#f0b90b',
    linestyle: 0,
    linewidth: 2,
  });
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


test('5m to 1M to 5m requests the second 5m while 1M is still in flight', () => {
  const committedFiveMinute = {
    requestedResolution: '5',
    committedResolution: '5',
    activeTradingViewResolution: '5',
    inFlightResolution: '',
  };
  assert.equal(chartModule.shouldRequestContractResolution(committedFiveMinute, '1M'), true);

  const monthlyInFlight = {
    requestedResolution: '1M',
    committedResolution: '5',
    activeTradingViewResolution: '1M',
    inFlightResolution: '2:1M',
  };
  assert.equal(
    chartModule.shouldRequestContractResolution(monthlyInFlight, '1M'),
    false,
    'the same in-flight target must remain deduplicated',
  );
  assert.equal(
    chartModule.shouldRequestContractResolution(monthlyInFlight, '5'),
    true,
    'the old committed 5m value must not suppress the return setResolution request',
  );
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
  clock.advanceBy(220);
  assert.deepEqual(changes, ['set-resolution']);
  if (chartModule.isContractHistoryEventCurrent(currentEvent, expected)) coordinator.finish(sequence);
  clock.advanceBy(0);
  assert.deepEqual(changes, ['set-resolution', '']);
});


test('Loading starts immediately, respects minimum visibility, and settles once', () => {
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
  clock.advanceBy(219);
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
  clock.advanceBy(500);
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
  clock.advanceBy(220);
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

test('initial visible range uses the Contract policy and keeps four right-padding bars', () => {
  const latestBarTimeMs = 1_800_000_000_000;
  const monthly = chartModule.resolveContractInitialVisibleRange('1M', latestBarTimeMs);
  assert.equal(monthly.targetVisibleBars, 36);
  assert.equal(monthly.rightPaddingBars, 4);
  assert.equal(
    monthly.range.to - monthly.range.from,
    36 * 30 * 24 * 60 * 60,
  );

  const fifteenMinutes = chartModule.resolveContractInitialVisibleRange('15m', latestBarTimeMs);
  assert.equal(fifteenMinutes.targetVisibleBars, 85);
  assert.equal(fifteenMinutes.intervalSeconds, 15 * 60);
});

test('native TradingView last value and main price line are disabled', () => {
  assert.deepEqual(chartModule.CONTRACT_TV_PRICE_LABEL_OVERRIDES, {
    'mainSeriesProperties.showPriceLine': false,
    'scalesProperties.showSeriesLastValue': false,
  });
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
