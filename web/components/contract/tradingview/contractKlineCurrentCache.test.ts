/* eslint-disable @typescript-eslint/no-explicit-any -- Dynamic harness loads transpiled module exports. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';


function loadTypeScriptModule(
  filePath: string,
  mocks: Record<string, unknown> = {},
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
  const execute = new Function('require', 'module', 'exports', output);
  execute(
    (specifier: string) => {
      if (Object.prototype.hasOwnProperty.call(mocks, specifier)) return mocks[specifier];
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
const cacheModule = loadTypeScriptModule(
  fileURLToPath(new URL('./contractKlineCurrentCache.ts', import.meta.url)),
  { './contractKlineCachePolicy': policyModule },
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
    buildKey({ category: 'crypto', symbol: ' btcusdt_perp ', interval: '1H', limit: 300 }),
    'CRYPTO|BTCUSDT_PERP|1h|300',
  );
  assert.equal(
    buildKey({ category: 'stock', symbol: 'aapl_usdt_perp', interval: '1M', limit: 200 }),
    'STOCK|AAPL_USDT_PERP|1M|200',
  );
  assert.equal(
    buildKey({ symbol: 'aapl_usdt_perp', interval: '1M', limit: 200 }),
    'UNKNOWN|AAPL_USDT_PERP|1M|200',
  );
  assert.notEqual(
    buildKey({ symbol: 'BTCUSDT_PERP', interval: '1h', limit: 300 }),
    buildKey({ symbol: 'BTCUSDT_PERP', interval: '1h', limit: 200 }),
  );
});

test('current cache keeps canonical category namespaces isolated', () => {
  const cache = new cacheModule.ContractKlineCurrentCache();
  const baseKey = { symbol: 'SHARED_PERP', interval: '1m', limit: 100 };

  assert.equal(cache.set({ ...baseKey, category: 'CRYPTO' }, response(), 15_000), true);
  assert.ok(cache.get({ ...baseKey, category: 'CRYPTO' }));
  assert.equal(cache.get({ ...baseKey, category: 'STOCK' }), null);

  cache.clear();
  assert.equal(cache.set({ ...baseKey, category: 'UNKNOWN' }, response(), 15_000), true);
  assert.ok(cache.get({ ...baseKey, category: 'UNKNOWN' }));
  assert.equal(cache.get({ ...baseKey, category: 'INDEX' }), null);
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
    now: () => now,
  });
  const key = { category: 'CRYPTO', symbol: 'BTCUSDT_PERP', interval: '1m', limit: 100 };
  const source = response();

  assert.equal(cache.set(key, source, 15_000), true);
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
  }), 2_000), true);
  assert.equal(cache.get(key).items[0].close, '106');
  now = 17_999;
  assert.ok(cache.get(key));
  now = 18_000;
  assert.equal(cache.get(key), null);
});

test('entry expiry is fixed at write time and replacement gets its own TTL', () => {
  let now = 0;
  const cache = new cacheModule.ContractKlineCurrentCache({ now: () => now });
  const key = { category: 'INDEX', symbol: 'INDEX_PERP', interval: '1h', limit: 100 };

  assert.equal(cache.set(key, response(), 1_000), true);
  now = 500;
  assert.ok(cache.get(key), 'a hit must not extend the original expiry');
  now = 999;
  assert.ok(cache.get(key));

  assert.equal(cache.set(key, response({
    items: [{ ...response().items[0], close: '106' }],
  }), 4_000), true);
  now = 1_000;
  assert.equal(cache.get(key).items[0].close, '106');
  now = 4_998;
  assert.ok(cache.get(key));
  now = 4_999;
  assert.equal(cache.get(key), null);
});

test('category and interval policy creates independent fixed entry expiry boundaries', () => {
  let now = 0;
  const cache = new cacheModule.ContractKlineCurrentCache({ now: () => now });
  const getTtl = policyModule.getContractKlineCurrentCacheTtlMs;
  const entries = [
    { category: 'CRYPTO', symbol: 'CRYPTO_1M_PERP', interval: '1m', expiresAt: 5_000 },
    { category: 'CRYPTO', symbol: 'CRYPTO_5M_PERP', interval: '5m', expiresAt: 10_000 },
    { category: 'CRYPTO', symbol: 'CRYPTO_15M_PERP', interval: '15m', expiresAt: 10_000 },
    { category: 'STOCK', symbol: 'STOCK_1M_PERP', interval: '1m', expiresAt: 10_000 },
    { category: 'CFD', symbol: 'CFD_5M_PERP', interval: '5m', expiresAt: 10_000 },
    { category: 'INDEX', symbol: 'INDEX_1M_PERP', interval: '1m', expiresAt: 10_000 },
    { category: 'CRYPTO', symbol: 'CRYPTO_1H_PERP', interval: '1h', expiresAt: 15_000 },
    { category: 'CRYPTO', symbol: 'CRYPTO_MONTH_PERP', interval: '1M', expiresAt: 15_000 },
    { category: 'UNKNOWN', symbol: 'UNKNOWN_1M_PERP', interval: '1m', expiresAt: 15_000 },
  ].map((entry) => ({ ...entry, limit: 100 }));

  for (const entry of entries) {
    const ttlMs = getTtl({ category: entry.category, interval: entry.interval });
    assert.equal(ttlMs, entry.expiresAt);
    assert.equal(cache.set(entry, response(), ttlMs), true);
  }

  now = 4_999;
  entries.forEach((entry) => assert.ok(cache.get(entry), `${entry.symbol} expired before 5 seconds`));
  now = 5_000;
  assert.equal(cache.get(entries[0]), null);
  entries.slice(1).forEach((entry) => assert.ok(cache.get(entry), `${entry.symbol} expired at 5 seconds`));

  now = 9_999;
  entries.slice(1).forEach((entry) => assert.ok(cache.get(entry), `${entry.symbol} expired before 10 seconds`));
  now = 10_000;
  entries.slice(1, 6).forEach((entry) => assert.equal(cache.get(entry), null, entry.symbol));
  entries.slice(6).forEach((entry) => assert.ok(cache.get(entry), `${entry.symbol} expired at 10 seconds`));

  assert.equal(getTtl({ category: 'UNKNOWN', interval: '1m' }), 15_000);
  now = 14_999;
  entries.slice(6).forEach((entry) => assert.ok(cache.get(entry), `${entry.symbol} expired before 15 seconds`));
  now = 15_000;
  entries.slice(6).forEach((entry) => assert.equal(cache.get(entry), null, entry.symbol));
  assert.equal(cache.size, 0);
});

test('later policy calls do not reinterpret an existing entry expiry', () => {
  let now = 0;
  const cache = new cacheModule.ContractKlineCurrentCache({ now: () => now });
  const getTtl = policyModule.getContractKlineCurrentCacheTtlMs;
  const key = { category: 'CRYPTO', symbol: 'FIXED_TTL_PERP', interval: '1m', limit: 100 };

  assert.equal(cache.set(key, response(), getTtl(key)), true);
  assert.equal(getTtl({ category: 'UNKNOWN', interval: '1m' }), 15_000);
  now = 4_999;
  assert.ok(cache.get(key));
  now = 5_000;
  assert.equal(cache.get(key), null);
});

test('invalid per-entry TTL values safely fall back to 15 seconds', () => {
  for (const [index, ttlMs] of [0, -1, Number.NaN, Number.POSITIVE_INFINITY].entries()) {
    let now = 0;
    const cache = new cacheModule.ContractKlineCurrentCache({ now: () => now });
    const key = { category: 'CFD', symbol: `TTL_${index}_PERP`, interval: '1m', limit: 100 };
    assert.equal(cache.set(key, response(), ttlMs), true);
    now = 14_999;
    assert.ok(cache.get(key));
    now = 15_000;
    assert.equal(cache.get(key), null);
  }
});


test('FIFO capacity stays at 64 and evicts the earliest written key', () => {
  const cache = new cacheModule.ContractKlineCurrentCache({ maxEntries: 64 });

  for (let index = 0; index < 65; index += 1) {
    assert.equal(cache.set({
      symbol: `FIFO_${index}_PERP`,
      interval: '1m',
      limit: 100,
    }, response(), 15_000), true);
  }

  assert.equal(cache.size, 64);
  assert.equal(cache.get({ symbol: 'FIFO_0_PERP', interval: '1m', limit: 100 }), null);
  assert.ok(cache.get({ symbol: 'FIFO_1_PERP', interval: '1m', limit: 100 }));
  assert.ok(cache.get({ symbol: 'FIFO_64_PERP', interval: '1m', limit: 100 }));

  cache.set({ symbol: 'FIFO_64_PERP', interval: '1m', limit: 100 }, response({
    items: [{ ...response().items[0], close: '106' }],
  }), 15_000);
  assert.equal(cache.size, 64);
  assert.equal(
    cache.get({ symbol: 'FIFO_64_PERP', interval: '1m', limit: 100 }).items[0].close,
    '106',
  );
  cache.clear();
  assert.equal(cache.size, 0);
});
