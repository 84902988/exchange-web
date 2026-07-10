/* eslint-disable @typescript-eslint/no-explicit-any -- Dynamic test harness validates API compatibility. */
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
      esModuleInterop: true,
    },
    fileName: filePath,
  }).outputText;
  const loadedModule: { exports: Record<string, any> } = { exports: {} };
  const localRequire = (specifier: string) => {
    if (Object.prototype.hasOwnProperty.call(mocks, specifier)) {
      return mocks[specifier];
    }
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


test('legacy array and opt-in metadata Contract Kline APIs remain distinct', async () => {
  const calls: string[] = [];
  const row = {
    open_time: 1_700_000_000_000,
    open: '100',
    high: '110',
    low: '90',
    close: '105',
    volume: '5',
  };
  const metadata = {
    items: [row],
    cache_status: 'HIT',
    freshness: 'CACHED',
    stale: false,
    history_incomplete: false,
    history_complete: false,
    has_more_before: null,
    provider_error_code: null,
    retryable: false,
  };
  const contractModule = loadTypeScriptModule(
    fileURLToPath(new URL('./contract.ts', import.meta.url)),
    {
      '../core/request': {
        request: async (path: string) => {
          calls.push(path);
          return path.includes('include_metadata=1') ? metadata : [row];
        },
      },
    },
  );

  const legacy = await contractModule.getContractMarketKlines({
    symbol: 'BTCUSDT_PERP',
    interval: '1m',
    limit: 200,
  });
  const structured = await contractModule.getContractMarketKlinesMetadata({
    symbol: 'BTCUSDT_PERP',
    interval: '1m',
    limit: 200,
    endTimeMs: 1_700_000_060_000,
  });

  assert.deepEqual(legacy, [row]);
  assert.deepEqual(structured, metadata);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].includes('include_metadata'), false);
  assert.equal(calls[1].includes('include_metadata=1'), true);
  assert.equal(calls[1].includes('end_time_ms=1700000060000'), true);
});
