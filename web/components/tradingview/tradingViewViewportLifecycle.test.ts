import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

type TradingViewViewportRange = {
  from: number;
  to?: number;
};

function loadModule() {
  const filePath = fileURLToPath(new URL('./tradingViewViewportLifecycle.ts', import.meta.url));
  const output = ts.transpileModule(readFileSync(filePath, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: filePath,
  }).outputText;
  const loadedModule: { exports: Record<string, unknown> } = { exports: {} };
  new Function('require', 'module', 'exports', output)(
    () => { throw new Error('Unexpected import'); },
    loadedModule,
    loadedModule.exports,
  );
  return loadedModule.exports as {
    applyTradingViewViewport: (options: Record<string, unknown>) => Promise<{
      applied: boolean;
      attempts: number;
      reason: string;
    }>;
  };
}

const { applyTradingViewViewport } = loadModule();

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

const targetRange = { from: 1_000, to: 2_000 };
const fallbackRange = { from: 1_000, to: 2_040 };

function createChart(options?: {
  dataReady?: () => Promise<boolean> | boolean;
  setVisibleRange?: (range: TradingViewViewportRange) => Promise<void> | void;
  getVisibleRange?: () => TradingViewViewportRange;
}) {
  let visibleRange: TradingViewViewportRange = { from: 0, to: 2_000 };
  return {
    dataReady: options?.dataReady ?? (() => Promise.resolve(true)),
    setVisibleRange: options?.setVisibleRange ?? ((range: TradingViewViewportRange) => {
      visibleRange = range;
      return Promise.resolve();
    }),
    getVisibleRange: options?.getVisibleRange ?? (() => visibleRange),
  };
}

test('history first waits for delayed dataReady before applying viewport', async () => {
  const ready = deferred<boolean>();
  let applyCalls = 0;
  const chart = createChart({
    dataReady: () => ready.promise,
    setVisibleRange(range) {
      applyCalls += 1;
      Object.assign(chart, { getVisibleRange: () => range });
    },
  });

  const resultPromise = applyTradingViewViewport({
    chart,
    range: targetRange,
    fallbackRange,
    intervalSeconds: 10,
    rightPaddingBars: 4,
    isCurrent: () => true,
  });
  await Promise.resolve();
  assert.equal(applyCalls, 0);
  ready.resolve(true);
  const result = await resultPromise;
  assert.equal(result.applied, true);
  assert.equal(applyCalls, 1);
});

test('dataReady first remains idle until history starts the viewport intent', async () => {
  let applyCalls = 0;
  const chart = createChart({
    dataReady: () => Promise.resolve(true),
    setVisibleRange(range) {
      applyCalls += 1;
      Object.assign(chart, { getVisibleRange: () => range });
    },
  });
  await chart.dataReady();
  assert.equal(applyCalls, 0);

  const result = await applyTradingViewViewport({
    chart,
    range: targetRange,
    fallbackRange,
    intervalSeconds: 10,
    rightPaddingBars: 4,
    isCurrent: () => true,
  });
  assert.equal(result.applied, true);
  assert.equal(applyCalls, 1);
});

test('rapid resolution changes prevent an old viewport intent from applying', async () => {
  const oldReady = deferred<boolean>();
  let activeResolution = '5';
  let oldApplyCalls = 0;
  let latestApplyCalls = 0;
  const oldChart = createChart({
    dataReady: () => oldReady.promise,
    setVisibleRange() {
      oldApplyCalls += 1;
    },
  });
  const oldResultPromise = applyTradingViewViewport({
    chart: oldChart,
    range: targetRange,
    fallbackRange,
    intervalSeconds: 10,
    rightPaddingBars: 4,
    isCurrent: () => activeResolution === '5',
  });

  activeResolution = '1M';
  activeResolution = '60';
  const latestChart = createChart({
    setVisibleRange(range) {
      latestApplyCalls += 1;
      Object.assign(latestChart, { getVisibleRange: () => range });
    },
  });
  const latestResult = await applyTradingViewViewport({
    chart: latestChart,
    range: targetRange,
    fallbackRange,
    intervalSeconds: 10,
    rightPaddingBars: 4,
    isCurrent: () => activeResolution === '60',
  });
  oldReady.resolve(true);
  const oldResult = await oldResultPromise;

  assert.equal(oldResult.reason, 'stale');
  assert.equal(oldApplyCalls, 0);
  assert.equal(latestResult.applied, true);
  assert.equal(latestApplyCalls, 1);
});

test('setVisibleRange failure retries once and commits only the verified result', async () => {
  let applyCalls = 0;
  let visibleRange: TradingViewViewportRange = { from: 0, to: 2_000 };
  const chart = createChart({
    setVisibleRange(range) {
      applyCalls += 1;
      if (applyCalls === 1) return Promise.reject(new Error('series rebuilding'));
      visibleRange = range;
      return Promise.resolve();
    },
    getVisibleRange: () => visibleRange,
  });

  const result = await applyTradingViewViewport({
    chart,
    range: targetRange,
    fallbackRange,
    intervalSeconds: 10,
    rightPaddingBars: 4,
    isCurrent: () => true,
  });
  assert.equal(result.applied, true);
  assert.equal(result.attempts, 2);
  assert.equal(applyCalls, 2);
});

test('post-apply verification failure retries exactly once', async () => {
  let applyCalls = 0;
  const chart = createChart({
    setVisibleRange() {
      applyCalls += 1;
    },
    getVisibleRange: () => ({ from: 0, to: 2_000 }),
  });

  const result = await applyTradingViewViewport({
    chart,
    range: targetRange,
    fallbackRange,
    intervalSeconds: 10,
    rightPaddingBars: 4,
    isCurrent: () => true,
  });
  assert.equal(result.applied, false);
  assert.equal(result.reason, 'verify-failed');
  assert.equal(result.attempts, 2);
  assert.equal(applyCalls, 2);
});
