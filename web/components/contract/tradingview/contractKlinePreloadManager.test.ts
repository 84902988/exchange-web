/* eslint-disable @typescript-eslint/no-explicit-any -- Dynamic harness loads transpiled module exports. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

function loadTypeScriptModule(
  filePath: string,
  mocks: Record<string, unknown>,
): Record<string, any> {
  const output = ts.transpileModule(readFileSync(filePath, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: filePath,
  }).outputText;
  const loadedModule: { exports: Record<string, any> } = { exports: {} };
  new Function('require', 'module', 'exports', output)(
    (specifier: string) => {
      if (Object.prototype.hasOwnProperty.call(mocks, specifier)) return mocks[specifier];
      throw new Error(`Unexpected import: ${specifier}`);
    },
    loadedModule,
    loadedModule.exports,
  );
  return loadedModule.exports;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function metadata(count: number) {
  return {
    items: Array.from({ length: count }, (_, index) => ({
      open_time: 1_717_000_000_000 + index * 60_000,
      open: '100',
      high: '101',
      low: '99',
      close: '100',
      volume: '1',
    })),
    cache_status: 'MISS',
    freshness: count ? 'RECENT' : 'MISSING',
    stale: false,
    history_incomplete: false,
    history_complete: null,
    has_more_before: null,
    provider_error_code: null,
    retryable: false,
  };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

class FakeClock {
  nowValue = 0;
  nextId = 1;
  tasks = new Map<number, { at: number; callback: () => void }>();

  now = () => this.nowValue;

  setTimeout = (callback: () => void, delayMs: number) => {
    const id = this.nextId;
    this.nextId += 1;
    this.tasks.set(id, { at: this.nowValue + delayMs, callback });
    return id;
  };

  clearTimeout = (handle: unknown) => {
    this.tasks.delete(Number(handle));
  };

  advance(milliseconds: number) {
    this.nowValue += milliseconds;
    const due = Array.from(this.tasks.entries())
      .filter(([, task]) => task.at <= this.nowValue)
      .sort((left, right) => left[1].at - right[1].at);
    due.forEach(([id, task]) => {
      this.tasks.delete(id);
      task.callback();
    });
  }
}

const loadPolicyModule = loadTypeScriptModule(
  fileURLToPath(new URL('./contractKlineLoadPolicy.ts', import.meta.url)),
  {},
);
const preloadPriorityModule = loadTypeScriptModule(
  fileURLToPath(new URL('../../../lib/tradingview/klinePreloadPriority.ts', import.meta.url)),
  {},
);
const cachePolicyStub = {
  normalizeContractKlineAssetClass: (value: unknown) => String(value || 'UNKNOWN').toUpperCase(),
  getContractKlineCurrentCacheTtlMs: () => 15_000,
};
const defaultCacheStub = {
  get: () => null,
  getAtLeast: () => null,
  set: () => true,
};
const managerModule = loadTypeScriptModule(
  fileURLToPath(new URL('./contractKlinePreloadManager.ts', import.meta.url)),
  {
    '@/lib/api/modules/contract': {
      getContractMarketKlinesMetadata: async () => metadata(0),
    },
    './contractKlineCachePolicy': cachePolicyStub,
    './contractKlineCurrentCache': {
      contractKlineCurrentCache: defaultCacheStub,
    },
    './contractKlineLoadPolicy': loadPolicyModule,
    '@/lib/tradingview/klinePreloadPriority': preloadPriorityModule,
  },
);

test('range lease keeps one active request and upgrades larger coverage sequentially', async () => {
  const registry = new managerModule.ContractKlineRequestLeaseRegistry();
  const first = deferred<any>();
  const upgraded = deferred<any>();
  const coverages: number[] = [];
  let active = 0;
  let maximumActive = 0;
  const request = (coverage: number) => {
    coverages.push(coverage);
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    const source = coverage === 100 ? first : upgraded;
    return source.promise.finally(() => {
      active -= 1;
    });
  };
  const base = {
    key: 'BTCUSDT_PERP|1m|CURRENT',
    role: 'active',
    deadlineMs: 1_000,
    request,
  };

  const small = registry.request({ ...base, coverage: 100 });
  const large = registry.request({ ...base, coverage: 300 });
  assert.deepEqual(coverages, [100]);
  first.resolve(metadata(100));
  assert.equal((await small).items.length, 100);
  await flushPromises();
  assert.deepEqual(coverages, [100, 300]);
  upgraded.resolve(metadata(300));
  assert.equal((await large).items.length, 300);
  assert.equal(maximumActive, 1);
  assert.equal(registry.size, 0);
});

test('deadline retires a lease and ignores its late producer result', async () => {
  const clock = new FakeClock();
  const registry = new managerModule.ContractKlineRequestLeaseRegistry(clock);
  const late = deferred<any>();
  const timedOut = registry.request({
    key: 'BTCUSDT_PERP|1M|CURRENT',
    coverage: 60,
    role: 'active',
    deadlineMs: 10,
    request: () => late.promise,
  });
  clock.advance(10);
  await assert.rejects(timedOut, { name: 'ContractKlineLeaseTimeoutError' });
  late.resolve(metadata(60));
  await flushPromises();
  assert.equal(registry.size, 0);

  const current = await registry.request({
    key: 'BTCUSDT_PERP|1M|CURRENT',
    coverage: 60,
    role: 'active',
    deadlineMs: 10,
    request: async () => metadata(60),
  });
  assert.equal(current.items.length, 60);
});

test('new active datafeed owner replaces an abandoned lease for the same history range', async () => {
  const registry = new managerModule.ContractKlineRequestLeaseRegistry();
  const abandoned = deferred<any>();
  const replacement = deferred<any>();
  let requestCount = 0;
  const observed = { abandonedSignal: null as AbortSignal | null };
  const base = {
    key: 'BTCUSDT_PERP|1m|CURRENT',
    coverage: 150,
    role: 'active',
    deadlineMs: 1_000,
    request: (_coverage: number, lease: { signal: AbortSignal }) => {
      requestCount += 1;
      if (requestCount === 1) observed.abandonedSignal = lease.signal;
      return requestCount === 1 ? abandoned.promise : replacement.promise;
    },
  };

  const first = registry.request({ ...base, ownerId: 'datafeed-1' });
  registry.releaseOwner('datafeed-1');
  const second = registry.request({ ...base, ownerId: 'datafeed-2' });

  assert.equal(requestCount, 2);
  assert.equal(observed.abandonedSignal?.aborted, true);
  await assert.rejects(first, { name: 'ContractKlineLeaseRetiredError' });
  replacement.resolve(metadata(150));
  assert.equal((await second).items.length, 150);
  abandoned.resolve(metadata(150));
  await flushPromises();
  assert.equal(registry.size, 0);
});

test('absolute history-chain deadline caps every lease and blocks late page starts', async () => {
  const clock = new FakeClock();
  const registry = new managerModule.ContractKlineRequestLeaseRegistry(clock);
  const pending = deferred<any>();
  let producerCalls = 0;
  const active = registry.request({
    key: 'BTCUSDT_PERP|1M|CURRENT',
    coverage: 300,
    role: 'active',
    deadlineMs: 1_000,
    deadlineAt: 25,
    request: () => {
      producerCalls += 1;
      return pending.promise;
    },
  });

  clock.advance(24);
  assert.equal(registry.size, 1);
  clock.advance(1);
  await assert.rejects(active, { name: 'ContractKlineLeaseTimeoutError' });
  await assert.rejects(registry.request({
    key: 'BTCUSDT_PERP|1M|OLDER',
    coverage: 240,
    role: 'active',
    deadlineMs: 1_000,
    deadlineAt: 25,
    request: async () => {
      producerCalls += 1;
      return metadata(240);
    },
  }), { name: 'ContractKlineChainDeadlineError' });
  assert.equal(producerCalls, 1);
});

test('active request retires a preload lease and starts immediately without waiting', async () => {
  const registry = new managerModule.ContractKlineRequestLeaseRegistry();
  const preloadSource = deferred<any>();
  const activeSource = deferred<any>();
  let requestCount = 0;
  const base = {
    key: 'BTCUSDT_PERP|1m|CURRENT',
    coverage: 150,
    request: () => {
      requestCount += 1;
      return requestCount === 1 ? preloadSource.promise : activeSource.promise;
    },
  };
  const preload = registry.request({ ...base, role: 'preload', deadlineMs: 100 });
  const active = registry.request({ ...base, role: 'active', deadlineMs: 10 });
  assert.equal(requestCount, 2);
  await assert.rejects(preload, { name: 'ContractKlineLeaseRetiredError' });
  activeSource.resolve(metadata(150));
  assert.equal((await active).items.length, 150);
  preloadSource.resolve(metadata(150));
  await flushPromises();
  assert.equal(registry.size, 0);
});

test('idle preload reuses the range lease and writes the existing current cache only', async () => {
  let idleCallback: (() => void) | null = null;
  const requests: Array<{ symbol: string; interval: string; limit?: number }> = [];
  const writes: unknown[] = [];
  const cache = {
    get: () => null,
    getAtLeast: () => null,
    set: (...args: unknown[]) => {
      writes.push(args);
      return true;
    },
  };
  const manager = new managerModule.ContractKlinePreloadManager({
    getState: () => ({ symbol: 'BTCUSDT_PERP', category: 'CRYPTO', interval: '1M' }),
    cache,
    leaseRegistry: new managerModule.ContractKlineRequestLeaseRegistry(),
    request: async (params: { symbol: string; interval: string; limit?: number }) => {
      requests.push(params);
      return metadata(Number(params.limit));
    },
    idleScheduler: {
      schedule: (callback: () => void) => {
        idleCallback = callback;
        return 1;
      },
      cancel: () => undefined,
    },
  });

  assert.equal(manager.schedule({
    symbol: 'BTCUSDT_PERP',
    interval: '1M',
    firstDataRequest: true,
    barCount: 60,
  }), true);
  assert.ok(idleCallback);
  (idleCallback as () => void)();
  await flushPromises();

  assert.deepEqual(requests, [{ symbol: 'BTCUSDT_PERP', interval: '1M', limit: 360 }]);
  assert.equal(writes.length, 1);
  const [cacheKey, response] = writes[0] as [
    { symbol: string; interval: string; limit: number },
    ReturnType<typeof metadata>,
  ];
  assert.deepEqual(cacheKey, {
    category: 'CRYPTO',
    symbol: 'BTCUSDT_PERP',
    interval: '1M',
    limit: 360,
  });
  assert.equal(response.items.length, 360, 'preload cache must retain the full coverage');
  assert.equal(new Set(response.items.map((item) => item.open_time)).size, 360);
  assert.equal(
    response.items.every((item, index) => (
      index === 0 || item.open_time - response.items[index - 1].open_time === 60_000
    )),
    true,
    'preload cache must preserve candle continuity',
  );
  assert.equal(response.history_complete, null);
  assert.equal(response.has_more_before, null);
});

test('cancelled preload never stores a late response', async () => {
  let idleCallback: (() => void) | null = null;
  const response = deferred<any>();
  let writes = 0;
  const manager = new managerModule.ContractKlinePreloadManager({
    getState: () => ({ symbol: 'AAPLUSDT_PERP', category: 'STOCK', interval: '1m' }),
    cache: {
      get: () => null,
      getAtLeast: () => null,
      set: () => {
        writes += 1;
        return true;
      },
    },
    leaseRegistry: new managerModule.ContractKlineRequestLeaseRegistry(),
    request: () => response.promise,
    idleScheduler: {
      schedule: (callback: () => void) => {
        idleCallback = callback;
        return 1;
      },
      cancel: () => undefined,
    },
  });
  manager.schedule({
    symbol: 'AAPLUSDT_PERP',
    interval: '1m',
    firstDataRequest: true,
    barCount: 100,
  });
  (idleCallback as unknown as () => void)();
  manager.cancel('interval changed');
  response.resolve(metadata(150));
  await flushPromises();
  assert.equal(writes, 0);
});

test('active history blocks a new preload from entering the idle scheduler', async () => {
  const registry = new managerModule.ContractKlineRequestLeaseRegistry();
  const activeSource = deferred<any>();
  const active = registry.request({
    key: 'BTCUSDT_PERP|1m|CURRENT',
    coverage: 100,
    role: 'active',
    deadlineMs: 1_000,
    request: () => activeSource.promise,
  });
  let idleSchedules = 0;
  let preloadRequests = 0;
  const manager = new managerModule.ContractKlinePreloadManager({
    getState: () => ({ symbol: 'BTCUSDT_PERP', category: 'CRYPTO', interval: '1m' }),
    cache: defaultCacheStub,
    leaseRegistry: registry,
    request: async () => {
      preloadRequests += 1;
      return metadata(150);
    },
    idleScheduler: {
      schedule: () => {
        idleSchedules += 1;
        return idleSchedules;
      },
      cancel: () => undefined,
    },
  });

  assert.equal(manager.schedule({
    symbol: 'BTCUSDT_PERP',
    interval: '1m',
    firstDataRequest: true,
    barCount: 100,
  }), true);
  assert.equal(idleSchedules, 0);
  assert.equal(preloadRequests, 0);

  activeSource.resolve(metadata(100));
  await active;
  manager.destroy();
});


test('foreground completion resumes the deferred preload through idle scheduling', async () => {
  const registry = new managerModule.ContractKlineRequestLeaseRegistry();
  const activeSource = deferred<any>();
  const active = registry.request({
    key: 'BTCUSDT_PERP|5m|CURRENT',
    coverage: 100,
    role: 'active',
    deadlineMs: 1_000,
    request: () => activeSource.promise,
  });
  let idleCallback: (() => void) | null = null;
  let preloadRequests = 0;
  const manager = new managerModule.ContractKlinePreloadManager({
    getState: () => ({ symbol: 'BTCUSDT_PERP', category: 'CRYPTO', interval: '5m' }),
    cache: defaultCacheStub,
    leaseRegistry: registry,
    request: async (params: { limit?: number }) => {
      preloadRequests += 1;
      return metadata(Number(params.limit));
    },
    idleScheduler: {
      schedule: (callback: () => void) => {
        idleCallback = callback;
        return 1;
      },
      cancel: () => undefined,
    },
  });
  manager.setForegroundState({
    loading: true,
    symbol: 'BTCUSDT_PERP',
    interval: '5m',
    generation: 1,
  });
  manager.schedule({
    symbol: 'BTCUSDT_PERP',
    interval: '5m',
    firstDataRequest: true,
    barCount: 100,
  });
  assert.equal(idleCallback, null);

  activeSource.resolve(metadata(100));
  await active;
  manager.setForegroundState({
    loading: false,
    symbol: 'BTCUSDT_PERP',
    interval: '5m',
    generation: 1,
  });
  assert.ok(idleCallback);
  (idleCallback as unknown as () => void)();
  await flushPromises();
  assert.equal(preloadRequests, 1);
  manager.destroy();
});


test('rapid monthly to five-minute switch retires the old preload generation', async () => {
  let state = { symbol: 'BTCUSDT_PERP', category: 'CRYPTO', interval: '1M' };
  const monthlySource = deferred<any>();
  const idleCallbacks: Array<() => void> = [];
  const writes: string[] = [];
  const manager = new managerModule.ContractKlinePreloadManager({
    getState: () => state,
    cache: {
      get: () => null,
      getAtLeast: () => null,
      set: (params: { interval: string }) => {
        writes.push(params.interval);
        return true;
      },
    },
    leaseRegistry: new managerModule.ContractKlineRequestLeaseRegistry(),
    request: (params: { interval: string; limit?: number }) => (
      params.interval === '1M' ? monthlySource.promise : Promise.resolve(metadata(Number(params.limit)))
    ),
    idleScheduler: {
      schedule: (callback: () => void) => {
        idleCallbacks.push(callback);
        return idleCallbacks.length;
      },
      cancel: () => undefined,
    },
  });

  manager.schedule({
    symbol: 'BTCUSDT_PERP',
    interval: '1M',
    firstDataRequest: true,
    barCount: 60,
  });
  idleCallbacks.shift()?.();
  await flushPromises();

  state = { ...state, interval: '5m' };
  manager.setForegroundState({
    loading: true,
    symbol: 'BTCUSDT_PERP',
    interval: '5m',
    generation: 2,
  });
  manager.schedule({
    symbol: 'BTCUSDT_PERP',
    interval: '5m',
    firstDataRequest: true,
    barCount: 100,
  });
  manager.setForegroundState({
    loading: false,
    symbol: 'BTCUSDT_PERP',
    interval: '5m',
    generation: 2,
  });
  idleCallbacks.shift()?.();
  await flushPromises();
  monthlySource.resolve(metadata(60));
  await flushPromises();

  assert.deepEqual(writes, ['5m']);
  manager.destroy();
});


test('duplicate schedule keeps one idle owner and one preload request', async () => {
  const source = deferred<any>();
  let idleCallback: (() => void) | null = null;
  let idleSchedules = 0;
  let preloadRequests = 0;
  let writes = 0;
  const event = {
    symbol: 'ETHUSDT_PERP',
    interval: '1m',
    firstDataRequest: true,
    barCount: 150,
  };
  const manager = new managerModule.ContractKlinePreloadManager({
    getState: () => ({ symbol: 'ETHUSDT_PERP', category: 'CRYPTO', interval: '1m' }),
    cache: {
      get: () => null,
      getAtLeast: () => null,
      set: () => {
        writes += 1;
        return true;
      },
    },
    leaseRegistry: new managerModule.ContractKlineRequestLeaseRegistry(),
    request: () => {
      preloadRequests += 1;
      return source.promise;
    },
    idleScheduler: {
      schedule: (callback: () => void) => {
        idleSchedules += 1;
        idleCallback = callback;
        return idleSchedules;
      },
      cancel: () => undefined,
    },
  });

  manager.schedule(event);
  manager.schedule(event);
  assert.equal(idleSchedules, 1);
  (idleCallback as unknown as () => void)();
  await flushPromises();
  manager.schedule(event);
  assert.equal(preloadRequests, 1);
  assert.equal(idleSchedules, 1);

  source.resolve(metadata(150));
  await flushPromises();
  assert.equal(writes, 1);
  manager.destroy();
});


test('late preload result cannot overwrite a newer active cache revision', async () => {
  managerModule.resetContractKlineLifecycleEventsForTests();
  const registry = new managerModule.ContractKlineRequestLeaseRegistry();
  const preloadSource = deferred<any>();
  const cacheWrites: string[] = [];
  let idleCallback: (() => void) | null = null;
  const manager = new managerModule.ContractKlinePreloadManager({
    getState: () => ({ symbol: 'BTCUSDT_PERP', category: 'CRYPTO', interval: '1M' }),
    cache: {
      get: () => null,
      getAtLeast: () => null,
      set: () => {
        cacheWrites.push('preload');
        return true;
      },
    },
    leaseRegistry: registry,
    request: () => preloadSource.promise,
    idleScheduler: {
      schedule: (callback: () => void) => {
        idleCallback = callback;
        return 1;
      },
      cancel: () => undefined,
    },
  });
  manager.schedule({
    symbol: 'BTCUSDT_PERP',
    interval: '1M',
    firstDataRequest: true,
    barCount: 60,
  });
  (idleCallback as unknown as () => void)();
  await flushPromises();

  const activeResult = await registry.request({
    key: 'BTCUSDT_PERP|1M|CURRENT',
    coverage: 60,
    role: 'active',
    deadlineMs: 1_000,
    request: async () => metadata(60),
  });
  assert.equal(activeResult.items.length, 60);
  cacheWrites.push('active');
  preloadSource.resolve(metadata(60));
  await flushPromises();

  assert.deepEqual(cacheWrites, ['active']);
  const lifecycleEvents = managerModule.getContractKlineLifecycleEventsSnapshot();
  assert.ok(lifecycleEvents.some((event: any) => (
    event.role === 'preload'
    && event.symbol === 'BTCUSDT_PERP'
    && event.interval === '1M'
    && Number.isInteger(event.generation)
  )));
  assert.ok(lifecycleEvents.some((event: any) => event.role === 'active'));
  manager.destroy();
});

test('contract preloads capability-filtered adjacent intervals before expanding active coverage', async () => {
  const requests: string[] = [];
  let idleCallback: (() => void) | null = null;
  const manager = new managerModule.ContractKlinePreloadManager({
    getState: () => ({
      symbol: 'BTCUSDT_PERP',
      category: 'CRYPTO',
      interval: '1m',
      intervals: ['1m', '5m', '15m', '1h', '4h'],
    }),
    cache: defaultCacheStub,
    leaseRegistry: new managerModule.ContractKlineRequestLeaseRegistry(),
    request: async ({ interval }: { interval: string }) => {
      requests.push(interval);
      return metadata(360);
    },
    idleScheduler: {
      schedule: (callback: () => void) => {
        idleCallback = callback;
        return 1;
      },
      cancel: () => undefined,
    },
  });
  manager.schedule({
    symbol: 'BTCUSDT_PERP',
    interval: '1m',
    firstDataRequest: true,
    barCount: 150,
  });
  (idleCallback as unknown as () => void)();
  for (let index = 0; index < 8; index += 1) await flushPromises();

  assert.deepEqual(requests, ['5m', '15m', '1h', '1m']);
  manager.destroy();
});

test('contract toolbar intent promotes an available interval without adding unsupported capability', async () => {
  const requests: string[] = [];
  let idleCallback: (() => void) | null = null;
  const manager = new managerModule.ContractKlinePreloadManager({
    getState: () => ({
      symbol: 'AAPLUSDT_PERP',
      category: 'STOCK',
      interval: '1d',
      intervals: ['1d', '1w', '1M'],
    }),
    cache: defaultCacheStub,
    leaseRegistry: new managerModule.ContractKlineRequestLeaseRegistry(),
    request: async ({ interval }: { interval: string }) => {
      requests.push(interval);
      return metadata(120);
    },
    idleScheduler: {
      schedule: (callback: () => void) => {
        idleCallback = callback;
        return 1;
      },
      cancel: () => undefined,
    },
  });
  manager.schedule({
    symbol: 'AAPLUSDT_PERP',
    interval: '1d',
    firstDataRequest: true,
    barCount: 100,
  });
  assert.equal(manager.prewarmInterval('1M', 'toolbar-pointerenter'), true);
  assert.equal(manager.prewarmInterval('4h', 'unsupported-toolbar'), false);
  (idleCallback as unknown as () => void)();
  for (let index = 0; index < 6; index += 1) await flushPromises();

  assert.deepEqual(requests, ['1M', '1w', '1d']);
  manager.destroy();
});
