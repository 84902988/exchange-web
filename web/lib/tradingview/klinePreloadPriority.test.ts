import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const sourcePath = fileURLToPath(new URL('./klinePreloadPriority.ts', import.meta.url));
const output = ts.transpileModule(readFileSync(sourcePath, 'utf8'), {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: sourcePath,
}).outputText;
type PreloadPriorityModule = {
  normalizeKlinePreloadInterval: (value: string) => string;
  promoteKlinePreloadInterval: (queue: readonly string[], interval: string) => string[];
  rankKlinePreloadIntervals: (active: string, available: readonly string[]) => string[];
};
const loadedModule: { exports: Partial<PreloadPriorityModule> } = { exports: {} };
new Function('module', 'exports', output)(loadedModule, loadedModule.exports);
const {
  normalizeKlinePreloadInterval,
  promoteKlinePreloadInterval,
  rankKlinePreloadIntervals,
} = loadedModule.exports as PreloadPriorityModule;

test('ranks likely adjacent intervals first for minute and daily workflows', () => {
  const intervals = ['1m', '5m', '15m', '1h', '4h', '1d', '1w', '1M'];
  assert.deepEqual(rankKlinePreloadIntervals('1m', intervals), [
    '5m', '15m', '1h', '4h', '1d', '1w', '1M',
  ]);
  assert.deepEqual(rankKlinePreloadIntervals('1d', intervals), [
    '1w', '1M', '4h', '1h', '15m', '5m', '1m',
  ]);
});

test('keeps provider capability filtering and UTC interval identity', () => {
  assert.deepEqual(
    rankKlinePreloadIntervals('1Dutc', ['1m', '1h', '1Dutc', '1Wutc', '1Mutc']),
    ['1Wutc', '1Mutc', '1h', '1m'],
  );
  assert.equal(normalizeKlinePreloadInterval('1Mutc'), '1M');
});

test('promotes pointer intent without duplicating a queued interval', () => {
  assert.deepEqual(
    promoteKlinePreloadInterval(['5m', '15m', '1h'], '1h'),
    ['1h', '5m', '15m'],
  );
  assert.deepEqual(
    promoteKlinePreloadInterval(['1Wutc', '1Mutc'], '1M'),
    ['1Mutc', '1Wutc'],
  );
});
