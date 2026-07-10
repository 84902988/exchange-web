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

test('D2B current cache policy applies the exact conservative category and interval matrix', () => {
  const getTtl = policyModule.getContractKlineCurrentCacheTtlMs;
  const matrix = {
    CRYPTO: {
      '1m': 5_000,
      '5m': 10_000,
      '15m': 10_000,
      '1h': 15_000,
      '4h': 15_000,
      '1d': 15_000,
      '1w': 15_000,
      '1M': 15_000,
      UNKNOWN_INTERVAL: 15_000,
    },
    STOCK: {
      '1m': 10_000,
      '5m': 10_000,
      '15m': 15_000,
      '1h': 15_000,
      '4h': 15_000,
      '1d': 15_000,
      '1w': 15_000,
      '1M': 15_000,
      UNKNOWN_INTERVAL: 15_000,
    },
    CFD: {
      '1m': 10_000,
      '5m': 10_000,
      '15m': 15_000,
      '1h': 15_000,
      '4h': 15_000,
      '1d': 15_000,
      '1w': 15_000,
      '1M': 15_000,
      UNKNOWN_INTERVAL: 15_000,
    },
    INDEX: {
      '1m': 10_000,
      '5m': 10_000,
      '15m': 15_000,
      '1h': 15_000,
      '4h': 15_000,
      '1d': 15_000,
      '1w': 15_000,
      '1M': 15_000,
      UNKNOWN_INTERVAL: 15_000,
    },
    UNKNOWN: {
      '1m': 15_000,
      '5m': 15_000,
      '15m': 15_000,
      '1h': 15_000,
      '4h': 15_000,
      '1d': 15_000,
      '1w': 15_000,
      '1M': 15_000,
      UNKNOWN_INTERVAL: 15_000,
    },
  };

  for (const [category, intervals] of Object.entries(matrix)) {
    for (const [interval, ttlMs] of Object.entries(intervals)) {
      assert.equal(getTtl({ category, interval }), ttlMs, `${category}/${interval}`);
    }
  }
});

test('minute and monthly intervals stay distinct while unknown inputs remain conservative', () => {
  const getTtl = policyModule.getContractKlineCurrentCacheTtlMs;

  assert.equal(getTtl({ category: 'CRYPTO', interval: '1m' }), 5_000);
  assert.equal(getTtl({ category: 'CRYPTO', interval: '1M' }), 15_000);
  assert.equal(getTtl({ category: 'CRYPTO', interval: '1D' }), 15_000);
  assert.equal(getTtl({ category: 'CRYPTO', interval: '1W' }), 15_000);
  assert.equal(getTtl({ category: 'CRYPTO', interval: '' }), 15_000);
  assert.equal(getTtl({ category: 'CRYPTO', interval: '2m' }), 15_000);
  assert.equal(getTtl({ category: 'UNKNOWN', interval: '1m' }), 15_000);
  assert.equal(getTtl({ category: 'not-loaded', interval: '1m' }), 15_000);
  assert.equal(getTtl({ category: 'USDT', interval: '1m' }), 15_000);
});
