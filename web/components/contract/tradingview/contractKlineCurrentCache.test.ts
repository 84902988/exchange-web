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

const cacheModule = loadTypeScriptModule(
  fileURLToPath(new URL('./contractKlineCurrentCache.ts', import.meta.url)),
);

function response(overrides: Record<string, unknown> = {}) {
  return {
    items: [{
      open_time: 1_717_000_000_000,
      open: '100',
      high: '110',
      low: '90',
      close: '105',
      volume: '5',
    }],
    cache_status: 'MISS',
    freshness: 'RECENT',
    stale: false,
    history_incomplete: false,
    history_complete: null,
    has_more_before: null,
    provider_error_code: null,
    retryable: false,
    ...overrides,
  };
}


test('current cache key normalizes symbol and interval while keeping exact limit', () => {
  const buildKey = cacheModule.buildContractKlineCurrentCacheKey;

  assert.equal(
    buildKey({ symbol: ' btcusdt_perp ', interval: '1H', limit: 300 }),
    'BTCUSDT_PERP|1h|300',
  );
  assert.equal(
    buildKey({ symbol: 'aapl_usdt_perp', interval: '1M', limit: 200 }),
    'AAPL_USDT_PERP|1M|200',
  );
  assert.notEqual(
    buildKey({ symbol: 'BTCUSDT_PERP', interval: '1h', limit: 300 }),
    buildKey({ symbol: 'BTCUSDT_PERP', interval: '1h', limit: 200 }),
  );
});


test('only complete non-stale provider current metadata is cacheable', () => {
  const isCacheable = cacheModule.isContractKlineCurrentResponseCacheable;

  assert.equal(isCacheable(response()), true);
  assert.equal(isCacheable(response({ freshness: 'CACHED', cache_status: 'HIT' })), true);
  for (const invalid of [
    response({ items: [] }),
    response({ stale: true, freshness: 'STALE' }),
    response({ history_incomplete: true }),
    response({ provider_error_code: 'TIMEOUT', retryable: true }),
    response({ provider_error_code: 'COOLDOWN', retryable: true }),
    response({ provider_error_code: 'HTTP_ERROR', retryable: true }),
    response({ provider_error_code: 'UNKNOWN', retryable: true }),
    response({ retryable: true }),
    response({ history_complete: false }),
    response({ has_more_before: true }),
    response({ freshness: 'MISSING' }),
    response({ cache_status: 'PROVIDER_EMPTY' }),
    response({ freshness: 'CACHED', cache_status: 'MISS' }),
    response({ freshness: 'RECENT', cache_status: 'HIT' }),
    response({ items: [{ ...response().items[0], source: 'LIVE_MID' }] }),
    response({ items: [{ ...response().items[0], source: 'SYNTHETIC' }] }),
    response({ items: [{ ...response().items[0], price_source: 'TRADE_TICK' }] }),
    response({ items: [
      { ...response().items[0], source: 'LIVE_MID' },
      { ...response().items[0], source: 'QUOTE_DRIVEN' },
    ] }),
    response({ items: [{ ...response().items[0], open_time: 0 }] }),
    response({ items: [{ ...response().items[0], close: 'not-a-number' }] }),
    response({ items: [
      response().items[0],
      { ...response().items[0], source: 'BBO' },
    ] }),
    { items: response().items },
    null,
  ]) {
    assert.equal(isCacheable(invalid), false);
  }
});


test('TTL starts on write does not extend on hit and copies values on read and write', () => {
  let now = 1_000;
  const cache = new cacheModule.ContractKlineCurrentCache({
    ttlMs: 15_000,
    now: () => now,
  });
  const key = { symbol: 'BTCUSDT_PERP', interval: '1m', limit: 100 };
  const source = response();

  assert.equal(cache.set(key, source), true);
  source.items[0].close = '999';
  source.items.push({ ...source.items[0], open_time: 1_717_000_060_000 });
  const first = cache.get(key);
  assert.equal(first.items.length, 1);
  assert.equal(first.items[0].close, '105');

  first.items[0].close = '777';
  first.items.push({ ...first.items[0], open_time: 1_717_000_120_000 });
  const second = cache.get(key);
  assert.equal(second.items.length, 1);
  assert.equal(second.items[0].close, '105');

  now = 15_999;
  assert.ok(cache.get(key));
  now = 16_000;
  assert.equal(cache.get(key), null);
  assert.equal(cache.size, 0);

  assert.equal(cache.set(key, response({
    items: [{ ...response().items[0], close: '106' }],
  })), true);
  assert.equal(cache.get(key).items[0].close, '106');
});


test('FIFO capacity stays at 64 and evicts the earliest written key', () => {
  const cache = new cacheModule.ContractKlineCurrentCache({ maxEntries: 64 });

  for (let index = 0; index < 65; index += 1) {
    assert.equal(cache.set({
      symbol: `FIFO_${index}_PERP`,
      interval: '1m',
      limit: 100,
    }, response()), true);
  }

  assert.equal(cache.size, 64);
  assert.equal(cache.get({ symbol: 'FIFO_0_PERP', interval: '1m', limit: 100 }), null);
  assert.ok(cache.get({ symbol: 'FIFO_1_PERP', interval: '1m', limit: 100 }));
  assert.ok(cache.get({ symbol: 'FIFO_64_PERP', interval: '1m', limit: 100 }));

  cache.set({ symbol: 'FIFO_64_PERP', interval: '1m', limit: 100 }, response({
    items: [{ ...response().items[0], close: '106' }],
  }));
  assert.equal(cache.size, 64);
  assert.equal(
    cache.get({ symbol: 'FIFO_64_PERP', interval: '1m', limit: 100 }).items[0].close,
    '106',
  );
  cache.clear();
  assert.equal(cache.size, 0);
});
