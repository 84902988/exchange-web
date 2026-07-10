/* eslint-disable @typescript-eslint/no-explicit-any -- Dynamic harness loads transpiled module exports. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

function loadTypeScriptModule(filePath: string): Record<string, any> {
  const source = readFileSync(filePath, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: filePath,
  }).outputText;
  const loadedModule: { exports: Record<string, any> } = { exports: {} };
  const execute = new Function('require', 'module', 'exports', output);
  execute(
    (specifier: string) => {
      throw new Error(`Unexpected test import: ${specifier}`);
    },
    loadedModule,
    loadedModule.exports,
  );
  return loadedModule.exports;
}

const policyModule = loadTypeScriptModule(
  fileURLToPath(new URL('./contractKlineCachePolicy.ts', import.meta.url)),
);

test('backend contract categories normalize to the canonical asset classes without symbol inference', () => {
  const normalize = policyModule.normalizeContractKlineAssetClass;

  for (const value of ['CRYPTO', 'crypto', '  CrYpTo  ']) {
    assert.equal(normalize(value), 'CRYPTO');
  }
  for (const value of ['STOCK', 'stock_contract', '  Stock  ']) {
    assert.equal(normalize(value), 'STOCK');
  }
  assert.equal(normalize('INDEX'), 'INDEX');
  for (const value of [
    'CFD',
    'FOREX',
    'FX',
    'METAL',
    'GOLD',
    'COMMODITY',
    'FUTURES',
    '  forex  ',
  ]) {
    assert.equal(normalize(value), 'CFD');
  }
  for (const value of [
    undefined,
    null,
    '',
    '   ',
    'BONDS',
    'BTCUSDT_PERP',
    'CORE',
    'USDT',
    '  usdt  ',
    'CONTRACT',
    'contract',
    'PERPETUAL',
    'FUTURE',
    'SILVER',
    'METALS',
    'OIL',
    'ENERGY',
  ]) {
    assert.equal(normalize(value), 'UNKNOWN');
  }
});

test('policy interval normalization preserves monthly 1M and normalizes other casing', () => {
  const normalize = policyModule.normalizeContractKlinePolicyInterval;

  assert.equal(normalize('1M'), '1M');
  assert.equal(normalize(' 1M '), '1M');
  assert.equal(normalize('1m'), '1m');
  assert.equal(normalize('1H'), '1h');
  assert.equal(normalize('1D'), '1d');
  assert.equal(normalize('UNKNOWN_INTERVAL'), 'unknown_interval');
});

test('D2A current cache policy remains 15 seconds for every category and interval', () => {
  const getTtl = policyModule.getContractKlineCurrentCacheTtlMs;
  const categories = ['CRYPTO', 'STOCK', 'CFD', 'INDEX', 'UNKNOWN'];
  const intervals = ['1m', '5m', '15m', '1h', '4h', '1d', '1w', '1M', 'UNKNOWN_INTERVAL'];

  for (const category of categories) {
    for (const interval of intervals) {
      assert.equal(getTtl({ category, interval }), 15_000, `${category}/${interval}`);
    }
  }
  assert.equal(getTtl({ category: 'not-loaded', interval: '' }), 15_000);
});
