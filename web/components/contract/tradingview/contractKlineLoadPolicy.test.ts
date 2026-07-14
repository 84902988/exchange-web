/* eslint-disable @typescript-eslint/no-explicit-any -- Dynamic harness loads transpiled module exports. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

function loadModule(): Record<string, any> {
  const filePath = fileURLToPath(new URL('./contractKlineLoadPolicy.ts', import.meta.url));
  const output = ts.transpileModule(readFileSync(filePath, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: filePath,
  }).outputText;
  const loadedModule: { exports: Record<string, any> } = { exports: {} };
  new Function('require', 'module', 'exports', output)(
    () => { throw new Error('Unexpected import'); },
    loadedModule,
    loadedModule.exports,
  );
  return loadedModule.exports;
}

const policy = loadModule();

test('visible range policy matches the Contract Chart final targets', () => {
  assert.deepEqual(
    Object.fromEntries(
      ['1m', '5m', '15m', '1h', '4h', '1d', '1w', '1M']
        .map((interval) => [interval, policy.getContractKlineVisibleBars(interval)]),
    ),
    {
      '1m': 75,
      '5m': 75,
      '15m': 85,
      '1h': 75,
      '4h': 65,
      '1d': 60,
      '1w': 45,
      '1M': 36,
    },
  );
});
test('first request preserves countBack while bounding only the first page', () => {
  const current = policy.resolveContractKlineRequestPlan({
    interval: '1m',
    countBack: 5_000,
    firstDataRequest: true,
  });
  assert.equal(current.requiredBars, 1_000);
  assert.equal(current.initialLimit, 150);
  assert.equal(current.pageLimit, 500);

  const history = policy.resolveContractKlineRequestPlan({
    interval: '1m',
    countBack: 500,
    firstDataRequest: false,
  });
  assert.equal(history.requiredBars, 500);
  assert.equal(history.initialLimit, 200);
  assert.equal(history.pageLimit, 500);
});

test('1W and 1M keep countBack 300 with Spot-compatible coverage and preload', () => {
  const weekly = policy.resolveContractKlineRequestPlan({
    interval: '1w',
    countBack: 300,
    firstDataRequest: true,
  });
  const monthly = policy.resolveContractKlineRequestPlan({
    interval: '1M',
    countBack: 300,
    firstDataRequest: true,
  });

  assert.deepEqual(
    { requiredBars: weekly.requiredBars, initialLimit: weekly.initialLimit },
    { requiredBars: 300, initialLimit: 80 },
  );
  assert.deepEqual(
    { requiredBars: monthly.requiredBars, initialLimit: monthly.initialLimit },
    { requiredBars: 300, initialLimit: 60 },
  );
  assert.equal(weekly.policy.preloadLimit, 360);
  assert.equal(monthly.policy.preloadLimit, 360);
});

test('1M stays case-sensitive and range identity excludes request coverage', () => {
  assert.equal(policy.normalizeContractKlineLoadInterval('1M'), '1M');
  assert.equal(
    policy.buildContractKlineRangeKey({
      symbol: ' btcusdt_perp ',
      interval: '1M',
      endTimeMs: null,
    }),
    'BTCUSDT_PERP|1M|CURRENT',
  );
});
