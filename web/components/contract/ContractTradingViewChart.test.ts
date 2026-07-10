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
    './tradingview/contractTradingViewDatafeed': {
      contractIntervalToTradingViewResolution: intervalToResolution,
      createContractTradingViewDatafeed: () => ({ destroy() {} }),
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


test('rapid real toolbar intent keeps the last 1H selection and resolution request', () => {
  let chartMode = 'candle';
  let interval = '1m';
  const requested: string[] = [];
  const dataReadyCallbacks: Array<() => void> = [];
  const committed: string[] = [];
  let currentRequest = 0;

  for (const key of ['1m', '5m', '15m', '1h']) {
    const selection = chartModule.resolveContractToolbarSelection(key, interval);
    chartMode = selection.chartMode;
    interval = selection.interval;
    const resolution = intervalToResolution(
      chartModule.resolveContractEffectiveKlineInterval(chartMode, interval),
    );
    const request = ++currentRequest;
    chartModule.requestContractSetResolution({
      chart: {
        setResolution(nextResolution: string, options: { dataReady: () => void }) {
          requested.push(nextResolution);
          dataReadyCallbacks.push(options.dataReady);
        },
      },
      resolution,
      isCurrent: () => request === currentRequest,
      onSettled: () => committed.push(resolution),
      onFallback: assert.fail,
    });
  }

  dataReadyCallbacks.forEach((callback) => callback());
  assert.equal(chartMode, 'candle');
  assert.equal(interval, '1h');
  assert.equal(requested.at(-1), '60');
  assert.equal(chartModule.isContractToolbarButtonActive('1h', chartMode, interval), true);
  assert.deepEqual(committed, ['60']);
});


test('candle interval changes keep widget identity and invoke setResolution', () => {
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
  chartModule.requestContractSetResolution({
    chart: {
      setResolution(resolution: string, options: { dataReady: () => void }) {
        requestedResolution = resolution;
        options.dataReady();
      },
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


test('setResolution dataReady and Promise completion settle exactly once', async () => {
  let settled = 0;
  chartModule.requestContractSetResolution({
    chart: {
      setResolution(_resolution: string, options: { dataReady: () => void }) {
        options.dataReady();
        return Promise.resolve(true);
      },
    },
    resolution: '15',
    isCurrent: () => true,
    onSettled: () => { settled += 1; },
    onFallback: assert.fail,
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(settled, 1);
});


test('setResolution false requests one fallback rebuild', () => {
  let settled = 0;
  const fallbackReasons: string[] = [];
  chartModule.requestContractSetResolution({
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
  chartModule.requestContractSetResolution({
    chart: { setResolution: () => Promise.reject(new Error('reject')) },
    resolution: '5',
    isCurrent: () => true,
    onSettled: assert.fail,
    onFallback: (reason: string) => reasons.push(reason),
  });
  await Promise.resolve();
  await Promise.resolve();

  chartModule.requestContractSetResolution({
    chart: { setResolution: () => { throw new Error('throw'); } },
    resolution: '15',
    isCurrent: () => true,
    onSettled: assert.fail,
    onFallback: (reason: string) => reasons.push(reason),
  });
  assert.deepEqual(reasons, ['setResolution rejected', 'setResolution threw']);
});


test('rapid resolution changes ignore the old callback and keep the latest resolution', () => {
  let currentRequest = 1;
  let firstDataReady: (() => void) | null = null;
  let secondDataReady: (() => void) | null = null;
  const committed: string[] = [];

  chartModule.requestContractSetResolution({
    chart: {
      setResolution(_resolution: string, options: { dataReady: () => void }) {
        firstDataReady = options.dataReady;
      },
    },
    resolution: '5',
    isCurrent: () => currentRequest === 1,
    onSettled: () => committed.push('5'),
    onFallback: assert.fail,
  });

  currentRequest = 2;
  chartModule.requestContractSetResolution({
    chart: {
      setResolution(_resolution: string, options: { dataReady: () => void }) {
        secondDataReady = options.dataReady;
      },
    },
    resolution: '15',
    isCurrent: () => currentRequest === 2,
    onSettled: () => committed.push('15'),
    onFallback: assert.fail,
  });

  assert.ok(firstDataReady);
  assert.ok(secondDataReady);
  (firstDataReady as () => void)();
  (secondDataReady as () => void)();
  assert.deepEqual(committed, ['15']);
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
