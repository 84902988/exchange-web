/* eslint-disable @typescript-eslint/no-explicit-any -- Dynamic test harness loads compiled module exports. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';


type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

type KlineRequest = {
  symbol: string;
  interval: string;
  limit?: number;
  endTimeMs?: number;
};

type KlineMetadata = {
  items: any[];
  cache_status: string;
  freshness: string;
  stale: boolean;
  history_incomplete: boolean;
  history_complete: boolean | null;
  has_more_before: boolean | null;
  history_terminal?: boolean | null;
  terminal_reason?: string | null;
  earliest_available_time?: number | null;
  coverage_complete?: boolean | null;
  provider_error_code: string | null;
  retryable: boolean;
};

type HistoryCall = {
  bars: any[];
  meta: { noData?: boolean };
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

async function waitFor(condition: () => boolean, message: string) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (condition()) return;
    await Promise.resolve();
  }
  assert.ok(condition(), message);
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function metadata(items: any[], overrides: Partial<KlineMetadata> = {}): KlineMetadata {
  return {
    items,
    cache_status: 'MISS',
    freshness: items.length ? 'RECENT' : 'MISSING',
    stale: false,
    history_incomplete: false,
    history_complete: null,
    has_more_before: null,
    provider_error_code: null,
    retryable: false,
    ...overrides,
  };
}

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

let requestKlines: (params: KlineRequest) => Promise<KlineMetadata> = async () => metadata([]);
const realtimeHandlers = new Set<(message: any) => void>();
const realtimeMarketSessionCalls: string[] = [];
const realtimeKlineOwnerCalls: Array<{ op: 'subscribe' | 'unsubscribe'; symbol: string; interval: string }> = [];
const realtimeResolutionCalls: Array<{
  op: 'begin' | 'commit' | 'rollback' | 'release';
  symbol: string;
  interval: string;
  ownerId: string;
  transitionGeneration: number;
}> = [];
const realtimeKlineSubscriptions: Array<{
  symbol: string;
  interval: string;
  transitionGeneration?: number;
  handler: (message: any) => void;
  released: boolean;
}> = [];
let realtimeDisconnectCalls = 0;
const realtimeStub = {
  beginKlineResolutionTransition(identity: any) {
    realtimeResolutionCalls.push({ op: 'begin', ...identity });
    return true;
  },
  commitKlineResolutionTransition(identity: any) {
    realtimeResolutionCalls.push({ op: 'commit', ...identity });
    return true;
  },
  rollbackKlineResolutionTransition(identity: any) {
    realtimeResolutionCalls.push({ op: 'rollback', ...identity });
    return true;
  },
  releaseKlineResolutionOwner(identity: any) {
    realtimeResolutionCalls.push({ op: 'release', ...identity });
    return true;
  },
  setMarketSession(symbol: string) {
    realtimeMarketSessionCalls.push(symbol);
    return () => undefined;
  },
  subscribeKline(session: { symbol: string; interval: string }, handler: (message: any) => void) {
    realtimeKlineOwnerCalls.push({
      op: 'subscribe',
      symbol: session.symbol,
      interval: session.interval,
    });
    const subscription = { ...session, handler, released: false };
    realtimeKlineSubscriptions.push(subscription);
    realtimeHandlers.add(handler);
    return () => {
      if (subscription.released) return;
      subscription.released = true;
      realtimeHandlers.delete(handler);
      realtimeKlineOwnerCalls.push({
        op: 'unsubscribe',
        symbol: session.symbol,
        interval: session.interval,
      });
    };
  },
  subscribe(_event: string, handler: (message: any) => void) {
    realtimeHandlers.add(handler);
    return () => realtimeHandlers.delete(handler);
  },
  disconnect() {
    realtimeDisconnectCalls += 1;
  },
};

function emitRealtime(message: any) {
  realtimeHandlers.forEach((handler) => handler(message));
}

const policyModule = loadTypeScriptModule(
  fileURLToPath(new URL('./contractKlineCachePolicy.ts', import.meta.url)),
  {},
);

const currentCacheModule = loadTypeScriptModule(
  fileURLToPath(new URL('./contractKlineCurrentCache.ts', import.meta.url)),
  { './contractKlineCachePolicy': policyModule },
);

const loadPolicyModule = loadTypeScriptModule(
  fileURLToPath(new URL('./contractKlineLoadPolicy.ts', import.meta.url)),
  {},
);

const preloadManagerModule = loadTypeScriptModule(
  fileURLToPath(new URL('./contractKlinePreloadManager.ts', import.meta.url)),
  {
    '@/lib/api/modules/contract': {
      getContractMarketKlinesMetadata: (params: KlineRequest) => requestKlines(params),
    },
    './contractKlineCachePolicy': policyModule,
    './contractKlineCurrentCache': currentCacheModule,
    './contractKlineLoadPolicy': loadPolicyModule,
  },
);

const marketStoreModule = loadTypeScriptModule(
  fileURLToPath(new URL('../../../lib/realtime/contractMarketStore.ts', import.meta.url)),
  {},
);

const datafeedModule = loadTypeScriptModule(
  fileURLToPath(new URL('./contractTradingViewDatafeed.ts', import.meta.url)),
  {
    '@/lib/api/modules/contract': {
      getContractMarketKlinesMetadata: (params: KlineRequest) => requestKlines(params),
    },
    '@/lib/realtime/contractMarketRealtime': {
      contractMarketRealtime: realtimeStub,
    },
    '@/lib/realtime/contractMarketStore': marketStoreModule,
    './contractKlineCurrentCache': currentCacheModule,
    './contractKlineCachePolicy': policyModule,
    './contractKlineLoadPolicy': loadPolicyModule,
    './contractKlinePreloadManager': preloadManagerModule,
  },
);

const defaultCurrentCacheNow = currentCacheModule.contractKlineCurrentCache.now;

test.beforeEach(() => {
  marketStoreModule.contractMarketStore.resetForTests();
  currentCacheModule.contractKlineCurrentCache.clear();
  currentCacheModule.contractKlineCurrentCache.now = defaultCurrentCacheNow;
  realtimeHandlers.clear();
  realtimeMarketSessionCalls.length = 0;
  realtimeKlineOwnerCalls.length = 0;
  realtimeResolutionCalls.length = 0;
  realtimeKlineSubscriptions.length = 0;
  realtimeDisconnectCalls = 0;
});

test.afterEach(() => {
  currentCacheModule.contractKlineCurrentCache.now = defaultCurrentCacheNow;
});

const symbolInfo = (ticker: string) => ({ ticker });
const period = {
  from: 0,
  to: 2_000_000_000,
  firstDataRequest: true,
  countBack: 100,
};
const row = (openTime: number, close: string) => ({
  open_time: openTime,
  open: close,
  high: close,
  low: close,
  close,
  volume: '1',
});
const TEST_HISTORY_BASELINE_TIME = 1_600_000_000_000;

async function establishHistoryBaseline(
  datafeed: any,
  symbol: string,
  resolution = '1',
) {
  const previousRequestKlines = requestKlines;
  const baselineTime = resolution === '1M'
    ? Date.parse('2020-09-01T00:00:00.000Z')
    : resolution === '1W'
      ? Date.parse('2020-09-14T00:00:00.000Z')
      : resolution === '1D'
        ? Date.parse('2020-09-14T00:00:00.000Z')
        : TEST_HISTORY_BASELINE_TIME;
  requestKlines = async () => metadata([row(baselineTime, '1')]);
  try {
    await datafeed.getBars(
      symbolInfo(symbol),
      resolution,
      period,
      () => undefined,
      assert.fail,
    );
  } finally {
    requestKlines = previousRequestKlines;
  }
}
const pageEndingAt = (endTime: number, count: number, close: string, stepMs = 60_000) => (
  Array.from({ length: count }, (_, index) => (
    row(endTime - ((count - index - 1) * stepMs), close)
  ))
);

const previousUtcBoundary = (time: number, interval: '1d' | '1w' | '1M') => {
  if (interval === '1M') {
    const instant = new Date(time);
    return Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth() - 1, 1);
  }
  return time - (interval === '1w' ? 7 : 1) * 86_400_000;
};

const utcBoundaryPageEndingAt = (
  interval: '1d' | '1w' | '1M',
  endTime: number,
  count: number,
  close: string,
) => {
  const rows = [];
  let cursor = endTime;
  for (let index = 0; index < count; index += 1) {
    rows.push(row(cursor, close));
    cursor = previousUtcBoundary(cursor, interval);
  }
  return rows.reverse();
};

const utcBoundaryPageBefore = (
  interval: '1d' | '1w' | '1M',
  endExclusive: number,
  count: number,
  close: string,
) => utcBoundaryPageEndingAt(
  interval,
  previousUtcBoundary(endExclusive, interval),
  count,
  close,
);

const realtimeCandle = (symbol: string, interval: string, openTime: number, close: string) => ({
  type: 'contract_kline_update',
  symbol,
  interval,
  kline: {
    ...row(openTime, close),
    source: 'LIVE_WS',
  },
});

function klineVersionCursor(params: {
  bucketTimeMs: number | null;
  sequence: number | null;
  generation?: number | null;
  epoch?: number | null;
  observedAtMs?: number;
}) {
  return {
    bucketTimeMs: params.bucketTimeMs,
    providerGeneration: params.generation ?? null,
    revisionEpoch: params.epoch ?? null,
    revisionSequence: params.sequence,
    observedAtMs: params.observedAtMs ?? params.bucketTimeMs ?? 0,
  };
}

function ingestStoreKline(params: {
  symbol: string;
  interval: string;
  openTime: number;
  close: string;
  volume?: string;
  eventTimeMs?: number;
  generation?: number;
  sequence?: number;
}) {
  return marketStoreModule.contractMarketStore.ingest({
    symbol: params.symbol,
    domain: 'kline',
    interval: params.interval,
    data: {
      ...row(params.openTime, params.close),
      volume: params.volume ?? '1',
      symbol: params.symbol,
      interval: params.interval,
      source: 'PROVIDER_KLINE',
      kline_mode: 'PROVIDER_KLINE',
      price_source: 'KLINE_CLOSE',
    },
    transport: 'WS',
    provider: 'BINANCE_USDM',
    providerGeneration: params.generation,
    revision: params.sequence === undefined
      ? null
      : { epoch: params.generation ?? null, sequence: params.sequence },
    eventTimeMs: params.eventTimeMs ?? params.openTime,
  });
}


test('current and history cursor policy only uses to for non-first requests', () => {
  const resolveEndTime = datafeedModule.resolveContractHistoryEndTimeMs;

  assert.equal(resolveEndTime({ ...period, firstDataRequest: true, to: 123 }), undefined);
  assert.equal(resolveEndTime({ ...period, firstDataRequest: false, to: 123.456 }), 123_456);
  assert.equal(resolveEndTime({ ...period, firstDataRequest: false, to: Number.NaN }), undefined);
  assert.equal(resolveEndTime({ ...period, firstDataRequest: false, to: -1 }), undefined);
});


test('in-flight key normalizes symbol interval and equivalent current cursors', () => {
  const buildKey = datafeedModule.buildContractKlineInFlightKey;
  const base = {
    symbol: ' btcusdt_perp ',
    interval: '1H',
    limit: 300,
  };

  assert.equal(buildKey(base), 'BTCUSDT_PERP|1h|CURRENT');
  assert.equal(buildKey({ ...base, limit: 500 }), buildKey(base));
  assert.equal(buildKey({ ...base, endTimeMs: undefined }), buildKey(base));
  assert.equal(buildKey({ ...base, endTimeMs: null }), buildKey(base));
  assert.equal(
    buildKey({ ...base, endTimeMs: 1_780_000_000_000 }),
    'BTCUSDT_PERP|1h|1780000000000',
  );
  assert.equal(
    buildKey({ ...base, interval: '1M' }),
    'BTCUSDT_PERP|1M|CURRENT',
  );
});


test('all eight production resolutions map bidirectionally without fallback', () => {
  const expected = [
    ['1', '1m'],
    ['5', '5m'],
    ['15', '15m'],
    ['60', '1h'],
    ['240', '4h'],
    ['1D', '1d'],
    ['1W', '1w'],
    ['1M', '1M'],
  ];

  for (const [resolution, interval] of expected) {
    assert.equal(
      datafeedModule.tradingViewResolutionToContractInterval(resolution),
      interval,
    );
    assert.equal(
      datafeedModule.contractIntervalToTradingViewResolution(interval),
      resolution,
    );
  }
});


test('provider realtime candles are accepted while quote-derived sources are rejected', () => {
  const toBar = datafeedModule.realtimeMessageToBar;
  const restToBar = datafeedModule.klineToBar;
  const basePayload = {
    open_time: 1_717_000_000_000,
    open: '100',
    high: '110',
    low: '90',
    close: '105',
    volume: '5',
  };
  const message = (payload: Record<string, unknown>) => ({
    type: 'contract_kline_update',
    symbol: 'BTCUSDT_PERP',
    interval: '1m',
    kline: payload,
  });

  assert.ok(toBar(message({ ...basePayload, source: 'LIVE_WS' }), 'BTCUSDT_PERP', '1m'));
  assert.ok(toBar(message({ ...basePayload, source: 'LIVE_WS', quote_source: 'OKX_SWAP' }), 'BTCUSDT_PERP', '1m'));
  assert.ok(toBar(message({ ...basePayload, source: 'LIVE_WS', quote_source: 'ITICK' }), 'BTCUSDT_PERP', '1m'));

  for (const source of [
    'BBO',
    'DEPTH',
    'DISPLAY_PRICE',
    'LIVE_MID',
    'QUOTE_DRIVEN',
    'SYNTHETIC_FROM_QUOTE',
    'TRADE_TICK',
    'OKX_QUOTE_WS',
  ]) {
    assert.equal(
      toBar(message({ ...basePayload, source }), 'BTCUSDT_PERP', '1m'),
      null,
      source,
    );
  }

  assert.equal(
    toBar(message({ ...basePayload, price_source: 'TRADE_TICK' }), 'BTCUSDT_PERP', '1m'),
    null,
  );
  assert.equal(
    toBar(
      { ...message({ ...basePayload, source: 'LIVE_WS' }), source: 'LIVE_MID' },
      'BTCUSDT_PERP',
      '1m',
    ),
    null,
  );
  assert.equal(
    toBar(message({ ...basePayload, source: 'LIVE_WS', freshness: 'STALE' }), 'BTCUSDT_PERP', '1m'),
    null,
  );
  assert.equal(
    toBar(message({ ...basePayload, source: 'LIVE_WS', stale: true }), 'BTCUSDT_PERP', '1m'),
    null,
  );
  assert.ok(restToBar(basePayload), 'source-less provider REST rows remain compatible');
});


test('history and realtime bars fail closed without complete provider volume evidence', () => {
  const payload = {
    open_time: 1_717_000_000_000,
    open: '100',
    high: '110',
    low: '90',
    close: '105',
  };
  const realtime = (volume: unknown) => datafeedModule.realtimeMessageToBar({
    type: 'contract_kline_update',
    symbol: 'BTCUSDT_PERP',
    interval: '1m',
    kline: { ...payload, volume, source: 'LIVE_WS' },
  }, 'BTCUSDT_PERP', '1m');

  assert.equal(datafeedModule.klineToBar({ ...payload, volume: '0' })?.volume, 0);
  assert.equal(realtime('0')?.volume, 0);
  for (const invalidVolume of [undefined, null, '', 'not-a-number', '-1']) {
    assert.equal(
      datafeedModule.klineToBar({ ...payload, volume: invalidVolume }),
      null,
      `history volume ${String(invalidVolume)}`,
    );
    assert.equal(realtime(invalidVolume), null, `realtime volume ${String(invalidVolume)}`);
  }
});


test('DWM UTC boundary validator preserves valid provider times and rejects invalid times', () => {
  const validTimes = [
    ['1d', Date.parse('2026-07-01T00:00:00.000Z')],
    ['1w', Date.parse('2026-07-06T00:00:00.000Z')],
    ['1M', Date.parse('2026-08-01T00:00:00.000Z')],
  ] as const;

  for (const [interval, time] of validTimes) {
    const valid = datafeedModule.klineToBar(row(time, '101'), interval);
    const invalid = datafeedModule.klineToBar(row(time + 60_000, '101'), interval);
    assert.equal(valid?.time, time, interval);
    assert.equal(invalid, null, interval);
  }
  assert.equal(
    datafeedModule.klineToBar(row(Date.parse('2026-07-07T00:00:00.000Z'), '101'), '1w'),
    null,
  );
  assert.equal(
    datafeedModule.klineToBar(row(Date.parse('2026-08-03T00:00:00.000Z'), '101'), '1M'),
    null,
  );
});


test('DWM history and realtime conversion resolve the same UTC bucket', () => {
  const openTime = Date.parse('2026-07-06T00:00:00.000Z');
  const payload = { ...row(openTime, '101'), source: 'LIVE_WS' };
  const history = datafeedModule.klineToBar(payload, '1w');
  const realtime = datafeedModule.realtimeMessageToBar({
    type: 'contract_kline_update',
    domain: 'kline',
    symbol: 'BTCUSDT_PERP',
    interval: '1w',
    kline: payload,
  }, 'BTCUSDT_PERP', '1w');
  const invalidRealtime = datafeedModule.realtimeMessageToBar({
    type: 'contract_kline_update',
    domain: 'kline',
    symbol: 'BTCUSDT_PERP',
    interval: '1w',
    kline: { ...payload, open_time: openTime + 60_000 },
  }, 'BTCUSDT_PERP', '1w');

  assert.equal(history?.time, openTime);
  assert.equal(realtime?.time, openTime);
  assert.equal(invalidRealtime, null);
});


test('duplicate DWM history rows collapse to one TradingView bucket', async () => {
  const previousRequestKlines = requestKlines;
  const openTime = Date.parse('2026-07-01T00:00:00.000Z');
  const datafeed = datafeedModule.createContractTradingViewDatafeed({
    symbol: 'BTCUSDT_PERP',
  });
  requestKlines = async () => metadata([
    row(openTime, '100'),
    row(openTime, '101'),
  ]);

  try {
    const historyCalls: HistoryCall[] = [];
    await datafeed.getBars(
      symbolInfo('BTCUSDT_PERP'),
      '1D',
      { ...period, countBack: 1 },
      (bars: any[], meta: { noData?: boolean }) => historyCalls.push({ bars, meta }),
      assert.fail,
    );

    assert.equal(historyCalls.length, 1);
    assert.equal(historyCalls[0].bars.length, 1);
    assert.equal(historyCalls[0].bars[0].time, openTime);
  } finally {
    requestKlines = previousRequestKlines;
    datafeed.destroy();
  }
});


test('normal current request calls onHistory exactly once and never calls onError', async () => {
  requestKlines = async () => metadata([row(1_717_000_000_000, '101')]);
  const historyCalls: HistoryCall[] = [];
  const historyEvents: any[] = [];
  const callbackOrder: string[] = [];
  let errorCalls = 0;
  const latest: Array<string | null> = [];
  const datafeed = datafeedModule.createContractTradingViewDatafeed({
    symbol: 'BTCUSDT_PERP',
    onLatestBar: (close: string | null) => latest.push(close),
    onHistoryBars: (event: unknown) => {
      callbackOrder.push('onHistoryBars');
      historyEvents.push(event);
    },
  });

  await datafeed.getBars(
    symbolInfo('BTCUSDT_PERP'),
    '1',
    period,
    (bars: any[], meta: { noData?: boolean }) => {
      callbackOrder.push('onHistory');
      historyCalls.push({ bars, meta });
    },
    () => { errorCalls += 1; },
  );

  assert.equal(historyCalls.length, 1);
  assert.equal(historyCalls[0].bars.length, 1);
  assert.equal(historyCalls[0].meta.noData, false);
  assert.equal(errorCalls, 0);
  assert.deepEqual(latest, ['101']);
  assert.deepEqual(callbackOrder, ['onHistory', 'onHistoryBars']);
  assert.deepEqual(historyEvents, [{
    symbol: 'BTCUSDT_PERP',
    interval: '1m',
    resolution: '1',
    firstDataRequest: true,
    barCount: 1,
    firstBarTime: 1_717_000_000_000,
    lastBarTime: 1_717_000_000_000,
    requestSeq: 1,
  }]);
});


test('history barrier defers an early Store candle and replays it only after baseline completion', async () => {
  const symbol = 'HISTORY_BARRIER_PERP';
  const baselineTime = 1_717_000_000_000;
  const storeTime = baselineTime + 60_000;
  const pending = deferred<KlineMetadata>();
  const callbackOrder: string[] = [];
  const realtimeBars: any[] = [];
  requestKlines = () => pending.promise;
  marketStoreModule.contractMarketStore.activateSymbol(symbol);
  const datafeed = datafeedModule.createContractTradingViewDatafeed({ symbol });

  const historyRequest = datafeed.getBars(
    symbolInfo(symbol),
    '1',
    period,
    () => callbackOrder.push('history'),
    assert.fail,
  );
  datafeed.subscribeBars(
    symbolInfo(symbol),
    '1',
    (bar: any) => {
      callbackOrder.push(`realtime:${bar.close}`);
      realtimeBars.push(bar);
    },
    'history-barrier-subscriber',
  );

  ingestStoreKline({ symbol, interval: '1m', openTime: storeTime, close: '102' });
  assert.deepEqual(realtimeBars, [], 'Store hydrate must not bypass the pending history baseline');

  pending.resolve(metadata([row(baselineTime, '101')]));
  await historyRequest;

  assert.deepEqual(callbackOrder, ['history', 'realtime:102']);
  assert.deepEqual((realtimeBars as any[]).map((bar) => bar.close), [102]);

  emitRealtime(realtimeCandle(symbol, '1m', storeTime + 60_000, '103'));
  assert.deepEqual((realtimeBars as any[]).map((bar) => bar.close), [102, 103]);
  datafeed.destroy();
});


test('history failure keeps realtime closed until a replacement baseline succeeds', async () => {
  const symbol = 'HISTORY_FAILURE_BARRIER_PERP';
  const realtimeBars: any[] = [];
  let requestAttempt = 0;
  let errorCalls = 0;
  requestKlines = async () => {
    requestAttempt += 1;
    if (requestAttempt === 1) throw new Error('history unavailable');
    return metadata([row(1_717_000_000_000, '201')]);
  };
  const datafeed = datafeedModule.createContractTradingViewDatafeed({ symbol });

  await datafeed.getBars(
    symbolInfo(symbol),
    '1',
    period,
    assert.fail,
    () => { errorCalls += 1; },
  );
  datafeed.subscribeBars(
    symbolInfo(symbol),
    '1',
    (bar: any) => realtimeBars.push(bar),
    'history-failure-subscriber',
  );
  emitRealtime(realtimeCandle(symbol, '1m', 1_717_000_060_000, '202'));
  assert.equal(errorCalls, 1);
  assert.deepEqual(realtimeBars, []);

  await datafeed.getBars(
    symbolInfo(symbol),
    '1',
    period,
    () => undefined,
    assert.fail,
  );
  emitRealtime(realtimeCandle(symbol, '1m', 1_717_000_120_000, '203'));
  assert.deepEqual((realtimeBars as any[]).map((bar) => bar.close), [203]);
  datafeed.destroy();
});


test('noData helper accepts only a fully consistent explicit terminal result', () => {
  const shouldReportNoData = datafeedModule.shouldReportContractHistoryNoData;
  const terminal = metadata([], {
    history_complete: true,
    has_more_before: false,
    history_incomplete: false,
    retryable: false,
  });

  assert.equal(shouldReportNoData(terminal), true);
  assert.equal(shouldReportNoData({ ...terminal, history_complete: false }), false);
  assert.equal(shouldReportNoData({ ...terminal, has_more_before: null }), false);
  assert.equal(shouldReportNoData({ ...terminal, history_incomplete: true }), false);
  assert.equal(shouldReportNoData({ ...terminal, retryable: true }), false);
  assert.equal(shouldReportNoData({ ...terminal, items: [row(1_717_000_000_000, '101')] }), false);
  assert.equal(shouldReportNoData({ items: [] }), false);
  assert.equal(shouldReportNoData(null), false);
});


test('ordinary provider empty history settles once through the error callback', async () => {
  requestKlines = async () => metadata([], {
    cache_status: 'PROVIDER_EMPTY',
    history_complete: false,
    has_more_before: null,
    history_incomplete: true,
    provider_error_code: 'EMPTY',
    retryable: true,
  });
  const historyCalls: HistoryCall[] = [];
  let errorCalls = 0;
  const datafeed = datafeedModule.createContractTradingViewDatafeed({ symbol: 'EMPTY_PERP' });

  await datafeed.getBars(
    symbolInfo('EMPTY_PERP'),
    '1',
    { ...period, firstDataRequest: false },
    (bars: any[], meta: { noData?: boolean }) => historyCalls.push({ bars, meta }),
    () => { errorCalls += 1; },
  );

  assert.equal(historyCalls.length, 0);
  assert.equal(errorCalls, 1);
});


test('transient metadata errors settle exactly once through the error callback', async () => {
  for (const providerErrorCode of ['TIMEOUT', 'COOLDOWN', 'HTTP_ERROR', 'UNKNOWN']) {
    requestKlines = async () => metadata([], {
      history_complete: false,
      has_more_before: null,
      history_incomplete: true,
      provider_error_code: providerErrorCode,
      retryable: true,
    });
    const historyCalls: HistoryCall[] = [];
    let errorCalls = 0;
    const datafeed = datafeedModule.createContractTradingViewDatafeed({
      symbol: `${providerErrorCode}_PERP`,
    });

    await datafeed.getBars(
      symbolInfo(`${providerErrorCode}_PERP`),
      '1',
      { ...period, firstDataRequest: false },
      (bars: any[], meta: { noData?: boolean }) => historyCalls.push({ bars, meta }),
      () => { errorCalls += 1; },
    );

    assert.equal(historyCalls.length, 0, providerErrorCode);
    assert.equal(errorCalls, 1, providerErrorCode);
  }
});


test('stale partial metadata returns provider bars without ending history', async () => {
  requestKlines = async () => metadata([row(1_717_000_000_000, '103')], {
    cache_status: 'SHORT',
    freshness: 'STALE',
    stale: true,
    history_complete: false,
    has_more_before: null,
    history_incomplete: true,
    provider_error_code: 'TIMEOUT',
    retryable: true,
  });
  const historyCalls: HistoryCall[] = [];
  const datafeed = datafeedModule.createContractTradingViewDatafeed({ symbol: 'STALE_PERP' });

  await datafeed.getBars(
    symbolInfo('STALE_PERP'),
    '1',
    { ...period, firstDataRequest: false },
    (bars: any[], meta: { noData?: boolean }) => historyCalls.push({ bars, meta }),
    assert.fail,
  );

  assert.equal(historyCalls.length, 1);
  assert.equal(historyCalls[0].bars.length, 1);
  assert.equal(historyCalls[0].bars[0].close, 103);
  assert.equal(historyCalls[0].meta.noData, false);
});


test('unknown empty current metadata uses the error callback instead of noData', async () => {
  requestKlines = async () => metadata([], {
    history_complete: null,
    has_more_before: null,
    history_incomplete: false,
    retryable: true,
  });
  const historyCalls: HistoryCall[] = [];
  const errors: string[] = [];
  const datafeed = datafeedModule.createContractTradingViewDatafeed({ symbol: 'CURRENT_EMPTY_PERP' });

  await datafeed.getBars(
    symbolInfo('CURRENT_EMPTY_PERP'),
    '1',
    period,
    (bars: any[], meta: { noData?: boolean }) => historyCalls.push({ bars, meta }),
    (reason: string) => errors.push(reason),
  );

  assert.equal(historyCalls.length, 0);
  assert.equal(errors.length, 1);
});


test('explicit terminal metadata is the only empty result reported as noData', async () => {
  requestKlines = async () => metadata([], {
    history_complete: true,
    has_more_before: false,
    history_incomplete: false,
    retryable: false,
  });
  const historyCalls: HistoryCall[] = [];
  const datafeed = datafeedModule.createContractTradingViewDatafeed({ symbol: 'TERMINAL_PERP' });

  await datafeed.getBars(
    symbolInfo('TERMINAL_PERP'),
    '1',
    { ...period, firstDataRequest: false },
    (bars: any[], meta: { noData?: boolean }) => historyCalls.push({ bars, meta }),
    assert.fail,
  );

  assert.equal(historyCalls.length, 1);
  assert.deepEqual(historyCalls[0].bars, []);
  assert.equal(historyCalls[0].meta.noData, true);
});


test('contract monthly provider boundary reports noData without onError', async () => {
  requestKlines = async () => metadata([], {
    history_complete: true,
    has_more_before: false,
    history_terminal: true,
    terminal_reason: 'PROVIDER_HISTORY_BOUNDARY',
    earliest_available_time: null,
    coverage_complete: true,
    history_incomplete: false,
    provider_error_code: null,
    retryable: false,
  });
  const historyCalls: HistoryCall[] = [];
  const errors: string[] = [];
  const datafeed = datafeedModule.createContractTradingViewDatafeed({ symbol: 'BTCUSDT_PERP' });

  await datafeed.getBars(
    symbolInfo('BTCUSDT_PERP'),
    '1M',
    { ...period, firstDataRequest: false },
    (bars: any[], meta: { noData?: boolean }) => historyCalls.push({ bars, meta }),
    (reason: string) => errors.push(reason),
  );

  assert.deepEqual(historyCalls, [{ bars: [], meta: { noData: true } }]);
  assert.deepEqual(errors, []);
});


test('API failure settles exactly once through error and history-error callbacks', async () => {
  requestKlines = async () => {
    throw new Error('provider unavailable');
  };
  const historyCalls: HistoryCall[] = [];
  const errors: string[] = [];
  const historyEvents: any[] = [];
  const historyErrors: any[] = [];
  const datafeed = datafeedModule.createContractTradingViewDatafeed({
    symbol: 'BTCUSDT_PERP',
    onHistoryBars: (event: unknown) => historyEvents.push(event),
    onHistoryError: (event: unknown) => historyErrors.push(event),
  });

  await datafeed.getBars(
    symbolInfo('BTCUSDT_PERP'),
    '1',
    period,
    (bars: any[], meta: { noData?: boolean }) => historyCalls.push({ bars, meta }),
    (reason: string) => errors.push(reason),
  );

  assert.equal(historyCalls.length, 0);
  assert.deepEqual(errors, ['provider unavailable']);
  assert.deepEqual(historyEvents, []);
  assert.deepEqual(historyErrors, [{
    symbol: 'BTCUSDT_PERP',
    interval: '1m',
    resolution: '1',
    firstDataRequest: true,
    firstBarTime: null,
    lastBarTime: null,
    requestSeq: 1,
    error: 'provider unavailable',
  }]);
});


test('concurrent identical current requests across datafeeds share one HTTP request', async () => {
  const pending = deferred<KlineMetadata>();
  const apiCalls: KlineRequest[] = [];
  requestKlines = async (params) => {
    apiCalls.push(params);
    return pending.promise;
  };
  const firstHistory: HistoryCall[] = [];
  const secondHistory: HistoryCall[] = [];
  const firstLoadingEvents: any[] = [];
  const secondLoadingEvents: any[] = [];
  const firstLatest: Array<string | null> = [];
  const secondLatest: Array<string | null> = [];
  const first = datafeedModule.createContractTradingViewDatafeed({
    symbol: 'DEDUPE_CURRENT_PERP',
    category: 'CRYPTO',
    onLatestBar: (close: string | null) => firstLatest.push(close),
    onHistoryBars: (event: unknown) => firstLoadingEvents.push(event),
  });
  const second = datafeedModule.createContractTradingViewDatafeed({
    symbol: 'DEDUPE_CURRENT_PERP',
    category: 'CRYPTO',
    onLatestBar: (close: string | null) => secondLatest.push(close),
    onHistoryBars: (event: unknown) => secondLoadingEvents.push(event),
  });

  const firstRequest = first.getBars(
    symbolInfo('DEDUPE_CURRENT_PERP'),
    '60',
    { ...period, countBack: 300 },
    (bars: any[], meta: { noData?: boolean }) => firstHistory.push({ bars, meta }),
    assert.fail,
  );
  const secondRequest = second.getBars(
    symbolInfo('DEDUPE_CURRENT_PERP'),
    '60',
    { ...period, countBack: 300 },
    (bars: any[], meta: { noData?: boolean }) => secondHistory.push({ bars, meta }),
    assert.fail,
  );

  assert.deepEqual(apiCalls, [{
    symbol: 'DEDUPE_CURRENT_PERP',
    interval: '1h',
    limit: 150,
    endTimeMs: undefined,
  }]);
  pending.resolve(metadata(pageEndingAt(1_717_000_000_000, 300, '101')));
  await Promise.all([firstRequest, secondRequest]);

  assert.equal(firstHistory.length, 1);
  assert.equal(secondHistory.length, 1);
  assert.deepEqual(firstHistory[0].bars, secondHistory[0].bars);
  assert.equal(firstHistory[0].meta.noData, false);
  assert.equal(secondHistory[0].meta.noData, false);
  assert.deepEqual(firstLatest, ['101']);
  assert.deepEqual(secondLatest, ['101']);
  assert.equal(firstLoadingEvents.length, 1);
  assert.equal(secondLoadingEvents.length, 1);
  assert.equal(firstLoadingEvents[0].firstDataRequest, true);
  assert.equal(secondLoadingEvents[0].firstDataRequest, true);

  const thirdHistory: HistoryCall[] = [];
  const thirdLoadingEvents: any[] = [];
  const third = datafeedModule.createContractTradingViewDatafeed({
    symbol: 'DEDUPE_CURRENT_PERP',
    category: 'CRYPTO',
    onHistoryBars: (event: unknown) => thirdLoadingEvents.push(event),
  });
  await third.getBars(
    symbolInfo('DEDUPE_CURRENT_PERP'),
    '60',
    { ...period, countBack: 300 },
    (bars: any[], meta: { noData?: boolean }) => thirdHistory.push({ bars, meta }),
    assert.fail,
  );
  assert.equal(apiCalls.length, 1);
  assert.equal(thirdHistory.length, 1);
  assert.deepEqual(thirdHistory[0].bars, firstHistory[0].bars);
  assert.equal(thirdLoadingEvents.length, 1);

  first.destroy();
  second.destroy();
  third.destroy();
});


test('active datafeed history preempts preload and owns the current cache revision', async () => {
  const preloadSource = deferred<KlineMetadata>();
  const activeSource = deferred<KlineMetadata>();
  const requests: KlineRequest[] = [];
  let idleCallback: (() => void) | null = null;
  requestKlines = async (params) => {
    requests.push(params);
    return requests.length === 1 ? preloadSource.promise : activeSource.promise;
  };
  const manager = new preloadManagerModule.ContractKlinePreloadManager({
    getState: () => ({ symbol: 'PRIORITY_PERP', category: 'CRYPTO', interval: '1M' }),
    idleScheduler: {
      schedule: (callback: () => void) => {
        idleCallback = callback;
        return 1;
      },
      cancel: () => undefined,
    },
  });
  manager.schedule({
    symbol: 'PRIORITY_PERP',
    interval: '1M',
    firstDataRequest: true,
    barCount: 60,
  });
  (idleCallback as unknown as () => void)();
  await waitFor(() => requests.length === 1, 'preload request should start first');

  const historyCalls: HistoryCall[] = [];
  const datafeed = datafeedModule.createContractTradingViewDatafeed({
    symbol: 'PRIORITY_PERP',
    category: 'CRYPTO',
  });
  const activeHistory = datafeed.getBars(
    symbolInfo('PRIORITY_PERP'),
    '1M',
    { ...period, countBack: 60 },
    (bars: any[], meta: { noData?: boolean }) => historyCalls.push({ bars, meta }),
    assert.fail,
  );
  await waitFor(() => requests.length === 2, 'active request must not wait for preload');

  const activeRows = utcBoundaryPageEndingAt(
    '1M',
    Date.parse('2026-07-01T00:00:00.000Z'),
    60,
    '500',
  );
  activeSource.resolve(metadata(activeRows));
  await activeHistory;
  preloadSource.resolve(metadata(utcBoundaryPageEndingAt(
    '1M',
    Date.parse('2026-07-01T00:00:00.000Z'),
    60,
    '100',
  )));
  await flushPromises();

  assert.equal(historyCalls.length, 1);
  assert.equal(historyCalls[0].bars.at(-1)?.close, 500);
  const cached = currentCacheModule.contractKlineCurrentCache.getAtLeast({
    category: 'CRYPTO',
    symbol: 'PRIORITY_PERP',
    interval: '1M',
    limit: 60,
  });
  assert.equal(cached?.items.at(-1)?.close, '500');
  manager.destroy();
  datafeed.destroy();
});

test('different category namespaces share C1 HTTP and populate both L1 entries', async () => {
  let now = 0;
  currentCacheModule.contractKlineCurrentCache.now = () => now;
  const pending = deferred<KlineMetadata>();
  const apiCalls: KlineRequest[] = [];
  requestKlines = async (params) => {
    apiCalls.push(params);
    return pending.promise;
  };
  const symbol = 'CATEGORY_C1_SHARED_PERP';
  const cryptoHistory: HistoryCall[] = [];
  const stockHistory: HistoryCall[] = [];
  const crypto = datafeedModule.createContractTradingViewDatafeed({ symbol, category: 'CRYPTO' });
  const stock = datafeedModule.createContractTradingViewDatafeed({ symbol, category: 'STOCK' });

  const cryptoRequest = crypto.getBars(
    symbolInfo(symbol),
    '1',
    period,
    (bars: any[], meta: { noData?: boolean }) => cryptoHistory.push({ bars, meta }),
    assert.fail,
  );
  const stockRequest = stock.getBars(
    symbolInfo(symbol),
    '1',
    period,
    (bars: any[], meta: { noData?: boolean }) => stockHistory.push({ bars, meta }),
    assert.fail,
  );

  assert.equal(apiCalls.length, 1);
  assert.equal('category' in apiCalls[0], false);
  pending.resolve(metadata(pageEndingAt(1_717_000_000_000, 100, '102')));
  await Promise.all([cryptoRequest, stockRequest]);

  assert.equal(cryptoHistory.length, 1);
  assert.equal(stockHistory.length, 1);
  assert.deepEqual(cryptoHistory[0].bars, stockHistory[0].bars);
  assert.ok(currentCacheModule.contractKlineCurrentCache.get({
    category: 'CRYPTO',
    symbol,
    interval: '1m',
    limit: 100,
  }));
  assert.ok(currentCacheModule.contractKlineCurrentCache.get({
    category: 'STOCK',
    symbol,
    interval: '1m',
    limit: 100,
  }));

  const nextCrypto = datafeedModule.createContractTradingViewDatafeed({ symbol, category: 'CRYPTO' });
  const nextStock = datafeedModule.createContractTradingViewDatafeed({ symbol, category: 'STOCK' });
  await nextCrypto.getBars(symbolInfo(symbol), '1', period, () => undefined, assert.fail);
  await nextStock.getBars(symbolInfo(symbol), '1', period, () => undefined, assert.fail);
  assert.equal(apiCalls.length, 1, 'both category-specific L1 entries must be reusable');

  now = 4_999;
  assert.ok(currentCacheModule.contractKlineCurrentCache.get({
    category: 'CRYPTO', symbol, interval: '1m', limit: 100,
  }));
  assert.ok(currentCacheModule.contractKlineCurrentCache.get({
    category: 'STOCK', symbol, interval: '1m', limit: 100,
  }));
  now = 5_000;
  assert.equal(currentCacheModule.contractKlineCurrentCache.get({
    category: 'CRYPTO', symbol, interval: '1m', limit: 100,
  }), null);
  assert.ok(currentCacheModule.contractKlineCurrentCache.get({
    category: 'STOCK', symbol, interval: '1m', limit: 100,
  }));
  now = 9_999;
  assert.ok(currentCacheModule.contractKlineCurrentCache.get({
    category: 'STOCK', symbol, interval: '1m', limit: 100,
  }));
  now = 10_000;
  assert.equal(currentCacheModule.contractKlineCurrentCache.get({
    category: 'STOCK', symbol, interval: '1m', limit: 100,
  }), null);

  crypto.destroy();
  stock.destroy();
  nextCrypto.destroy();
  nextStock.destroy();
});

test('expired CRYPTO 1m current L1 entry refetches and writes a fresh five-second entry', async () => {
  let now = 0;
  currentCacheModule.contractKlineCurrentCache.now = () => now;
  let apiCalls = 0;
  requestKlines = async () => {
    apiCalls += 1;
    return metadata(pageEndingAt(1_717_050_000_000, 100, String(120 + apiCalls)));
  };
  const symbol = 'CRYPTO_TTL_REFRESH_PERP';
  const historyCalls: HistoryCall[] = [];
  const datafeed = datafeedModule.createContractTradingViewDatafeed({ symbol, category: 'CRYPTO' });
  const request = async () => datafeed.getBars(
    symbolInfo(symbol),
    '1',
    period,
    (bars: any[], meta: { noData?: boolean }) => historyCalls.push({ bars, meta }),
    assert.fail,
  );

  await request();
  assert.equal(apiCalls, 1);
  now = 4_999;
  await request();
  assert.equal(apiCalls, 1);
  now = 5_000;
  await request();
  assert.equal(apiCalls, 2);
  assert.equal(historyCalls.length, 3);
  assert.equal(historyCalls[2].bars.at(-1)?.close, 122);

  now = 9_999;
  assert.ok(currentCacheModule.contractKlineCurrentCache.get({
    category: 'CRYPTO', symbol, interval: '1m', limit: 100,
  }));
  now = 10_000;
  assert.equal(currentCacheModule.contractKlineCurrentCache.get({
    category: 'CRYPTO', symbol, interval: '1m', limit: 100,
  }), null);
  datafeed.destroy();
});

test('UNKNOWN to real category rebuild cancels old callbacks while sharing the same C1 request', async () => {
  const pending = deferred<KlineMetadata>();
  let apiCalls = 0;
  requestKlines = async () => {
    apiCalls += 1;
    return pending.promise;
  };
  const symbol = 'ASYNC_CATEGORY_PERP';
  const oldHistory: HistoryCall[] = [];
  const oldLatest: Array<string | null> = [];
  const newHistory: HistoryCall[] = [];
  const newLatest: Array<string | null> = [];
  const unknown = datafeedModule.createContractTradingViewDatafeed({
    symbol,
    category: 'UNKNOWN',
    onLatestBar: (close: string | null) => oldLatest.push(close),
  });
  const oldRequest = unknown.getBars(
    symbolInfo(symbol),
    '1',
    period,
    (bars: any[], meta: { noData?: boolean }) => oldHistory.push({ bars, meta }),
    assert.fail,
  );
  unknown.destroy();

  const stock = datafeedModule.createContractTradingViewDatafeed({
    symbol,
    category: 'STOCK',
    onLatestBar: (close: string | null) => newLatest.push(close),
  });
  const newRequest = stock.getBars(
    symbolInfo(symbol),
    '1',
    period,
    (bars: any[], meta: { noData?: boolean }) => newHistory.push({ bars, meta }),
    assert.fail,
  );
  assert.equal(apiCalls, 1);

  pending.resolve(metadata(pageEndingAt(1_717_100_000_000, 100, '103')));
  await Promise.all([oldRequest, newRequest]);
  await Promise.resolve();

  assert.deepEqual(oldHistory, []);
  assert.deepEqual(oldLatest, []);
  assert.equal(newHistory.length, 1);
  assert.deepEqual(newLatest, ['103']);
  assert.ok(currentCacheModule.contractKlineCurrentCache.get({
    category: 'UNKNOWN',
    symbol,
    interval: '1m',
    limit: 100,
  }));
  assert.ok(currentCacheModule.contractKlineCurrentCache.get({
    category: 'STOCK',
    symbol,
    interval: '1m',
    limit: 100,
  }));
  assert.equal(currentCacheModule.contractKlineCurrentCache.get({
    category: 'CRYPTO',
    symbol,
    interval: '1m',
    limit: 100,
  }), null);
  assert.equal(currentCacheModule.contractKlineCurrentCache.size, 2);
  stock.destroy();
});


test('concurrent identical history requests across datafeeds share one HTTP request', async () => {
  const pending = deferred<KlineMetadata>();
  const apiCalls: KlineRequest[] = [];
  requestKlines = async (params) => {
    apiCalls.push(params);
    return pending.promise;
  };
  const historyPeriod = { ...period, firstDataRequest: false, countBack: 200 };
  const firstHistory: HistoryCall[] = [];
  const secondHistory: HistoryCall[] = [];
  const firstLoadingEvents: any[] = [];
  const secondLoadingEvents: any[] = [];
  const first = datafeedModule.createContractTradingViewDatafeed({
    symbol: 'DEDUPE_HISTORY_PERP',
    onHistoryBars: (event: unknown) => firstLoadingEvents.push(event),
  });
  const second = datafeedModule.createContractTradingViewDatafeed({
    symbol: 'DEDUPE_HISTORY_PERP',
    onHistoryBars: (event: unknown) => secondLoadingEvents.push(event),
  });

  const firstRequest = first.getBars(
    symbolInfo('DEDUPE_HISTORY_PERP'),
    '15',
    historyPeriod,
    (bars: any[], meta: { noData?: boolean }) => firstHistory.push({ bars, meta }),
    assert.fail,
  );
  const secondRequest = second.getBars(
    symbolInfo('DEDUPE_HISTORY_PERP'),
    '15',
    historyPeriod,
    (bars: any[], meta: { noData?: boolean }) => secondHistory.push({ bars, meta }),
    assert.fail,
  );

  assert.deepEqual(apiCalls, [{
    symbol: 'DEDUPE_HISTORY_PERP',
    interval: '15m',
    limit: 180,
    endTimeMs: 2_000_000_000_000,
  }]);
  pending.resolve(metadata(pageEndingAt(1_717_000_000_000, 200, '103')));
  await Promise.all([firstRequest, secondRequest]);

  assert.equal(firstHistory.length, 1);
  assert.equal(secondHistory.length, 1);
  assert.deepEqual(firstHistory[0].bars, secondHistory[0].bars);
  assert.equal(firstHistory[0].meta.noData, false);
  assert.equal(secondHistory[0].meta.noData, false);
  assert.equal(firstLoadingEvents.length, 1);
  assert.equal(secondLoadingEvents.length, 1);
  assert.equal(firstLoadingEvents[0].firstDataRequest, false);
  assert.equal(secondLoadingEvents[0].firstDataRequest, false);
  first.destroy();
  second.destroy();
});


test('settled history coverage is local to one datafeed while the global lease is removed', async () => {
  const pending: Array<Deferred<KlineMetadata>> = [];
  const apiCalls: KlineRequest[] = [];
  requestKlines = async (params) => {
    apiCalls.push(params);
    const request = deferred<KlineMetadata>();
    pending.push(request);
    return request.promise;
  };
  const datafeed = datafeedModule.createContractTradingViewDatafeed({ symbol: 'NO_RESULT_CACHE_PERP' });

  const firstRequest = datafeed.getBars(
    symbolInfo('NO_RESULT_CACHE_PERP'),
    '1',
    { ...period, firstDataRequest: false },
    () => undefined,
    assert.fail,
  );
  assert.equal(apiCalls.length, 1);
  pending[0].resolve(metadata(pageEndingAt(1_717_000_000_000, 100, '101')));
  await firstRequest;

  const repeatedHistory: HistoryCall[] = [];
  await datafeed.getBars(
    symbolInfo('NO_RESULT_CACHE_PERP'),
    '1',
    { ...period, firstDataRequest: false },
    (bars: any[], meta: { noData?: boolean }) => repeatedHistory.push({ bars, meta }),
    assert.fail,
  );
  assert.equal(apiCalls.length, 1, 'the same datafeed generation should reuse settled coverage');
  assert.equal(repeatedHistory[0].bars.at(-1)?.close, 101);

  const nextDatafeed = datafeedModule.createContractTradingViewDatafeed({
    symbol: 'NO_RESULT_CACHE_PERP',
  });
  const secondRequest = nextDatafeed.getBars(
    symbolInfo('NO_RESULT_CACHE_PERP'),
    '1',
    { ...period, firstDataRequest: false },
    () => undefined,
    assert.fail,
  );
  assert.equal(apiCalls.length, 2, 'a new datafeed must not see another datafeed coverage state');
  pending[1].resolve(metadata(pageEndingAt(1_717_000_060_000, 100, '102')));
  await secondRequest;
  assert.deepEqual(apiCalls[0], apiCalls[1]);
  datafeed.destroy();
  nextDatafeed.destroy();
});


test('history request with an invalid cursor still bypasses current L1', async () => {
  const symbol = 'NO_HISTORY_CURRENT_CACHE_PERP';
  currentCacheModule.contractKlineCurrentCache.set(
    { category: 'STOCK', symbol, interval: '1m', limit: 100 },
    metadata(pageEndingAt(1_717_005_000_000, 100, '109')),
    15_000,
  );
  let apiCalls = 0;
  requestKlines = async () => {
    apiCalls += 1;
    return metadata(pageEndingAt(1_717_006_000_000, 100, '110'));
  };
  const historyCalls: HistoryCall[] = [];
  const datafeed = datafeedModule.createContractTradingViewDatafeed({ symbol, category: 'STOCK' });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await datafeed.getBars(
      symbolInfo(symbol),
      '1',
      { ...period, firstDataRequest: false, to: Number.NaN },
      (bars: any[], meta: { noData?: boolean }) => historyCalls.push({ bars, meta }),
      assert.fail,
    );
  }

  assert.equal(apiCalls, 2);
  assert.equal(historyCalls.length, 2);
  assert.equal(historyCalls[0].bars.at(-1)?.close, 110);
  assert.equal(historyCalls[1].bars.at(-1)?.close, 110);
  datafeed.destroy();
});


test('sequential current requests reuse L1 within one and across datafeed instances', async () => {
  let apiCalls = 0;
  requestKlines = async () => {
    apiCalls += 1;
    return metadata(pageEndingAt(1_717_010_000_000, 100, '111'));
  };
  const firstHistory: HistoryCall[] = [];
  const secondHistory: HistoryCall[] = [];
  const first = datafeedModule.createContractTradingViewDatafeed({
    symbol: 'L1_SEQUENTIAL_PERP',
    category: 'INDEX',
  });
  const second = datafeedModule.createContractTradingViewDatafeed({
    symbol: 'L1_SEQUENTIAL_PERP',
    category: 'INDEX',
  });

  await first.getBars(
    symbolInfo('L1_SEQUENTIAL_PERP'),
    '1',
    period,
    (bars: any[], meta: { noData?: boolean }) => firstHistory.push({ bars, meta }),
    assert.fail,
  );
  await first.getBars(
    symbolInfo('L1_SEQUENTIAL_PERP'),
    '1',
    period,
    (bars: any[], meta: { noData?: boolean }) => firstHistory.push({ bars, meta }),
    assert.fail,
  );
  await second.getBars(
    symbolInfo('L1_SEQUENTIAL_PERP'),
    '1',
    period,
    (bars: any[], meta: { noData?: boolean }) => secondHistory.push({ bars, meta }),
    assert.fail,
  );

  assert.equal(apiCalls, 1);
  assert.equal(firstHistory.length, 2);
  assert.equal(secondHistory.length, 1);
  assert.deepEqual(firstHistory[0].bars, firstHistory[1].bars);
  assert.deepEqual(firstHistory[0].bars, secondHistory[0].bars);
  first.destroy();
  second.destroy();
});


test('current L1 scope keeps symbol interval and full countBack coverage isolated', async () => {
  const apiCalls: KlineRequest[] = [];
  requestKlines = async (params) => {
    apiCalls.push(params);
    return metadata(pageEndingAt(1_717_020_000_000, params.limit || 100, '112'));
  };
  const cases = [
    { symbol: 'L1_KEY_A_PERP', resolution: '1', countBack: 100 },
    { symbol: 'L1_KEY_B_PERP', resolution: '1', countBack: 100 },
    { symbol: 'L1_KEY_A_PERP', resolution: '5', countBack: 100 },
    { symbol: 'L1_KEY_A_PERP', resolution: '1', countBack: 200 },
  ];

  for (const item of cases) {
    const datafeed = datafeedModule.createContractTradingViewDatafeed({ symbol: item.symbol });
    await datafeed.getBars(
      symbolInfo(item.symbol),
      item.resolution,
      { ...period, countBack: item.countBack },
      () => undefined,
      assert.fail,
    );
    datafeed.destroy();
  }

  assert.equal(apiCalls.length, 5);
  assert.deepEqual(apiCalls.map((call) => [call.symbol, call.interval, call.limit]), [
    ['L1_KEY_A_PERP', '1m', 100],
    ['L1_KEY_B_PERP', '1m', 100],
    ['L1_KEY_A_PERP', '5m', 100],
    ['L1_KEY_A_PERP', '1m', 150],
    ['L1_KEY_A_PERP', '1m', 50],
  ]);
  assert.equal(typeof apiCalls[4].endTimeMs, 'number');
});


test('empty error stale partial and rejected current responses never become L1 entries', async () => {
  const invalidCases: Array<{
    name: string;
    response?: KlineMetadata;
    reject?: boolean;
  }> = [
    {
      name: 'EMPTY',
      response: metadata([], {
        freshness: 'MISSING',
        history_incomplete: true,
        provider_error_code: 'EMPTY',
        retryable: true,
      }),
    },
    ...['TIMEOUT', 'COOLDOWN', 'HTTP_ERROR', 'UNKNOWN'].map((code) => ({
      name: code,
      response: metadata([], {
        freshness: 'MISSING',
        history_incomplete: true,
        provider_error_code: code,
        retryable: true,
      }),
    })),
    {
      name: 'STALE',
      response: metadata(pageEndingAt(1_717_030_000_000, 100, '113'), {
        cache_status: 'STALE_FALLBACK',
        freshness: 'STALE',
        stale: true,
        history_incomplete: true,
        retryable: true,
      }),
    },
    {
      name: 'PARTIAL',
      response: metadata(pageEndingAt(1_717_030_000_000, 100, '114'), {
        history_incomplete: true,
      }),
    },
    { name: 'REJECT', reject: true },
  ];

  for (const invalid of invalidCases) {
    currentCacheModule.contractKlineCurrentCache.clear();
    let apiCalls = 0;
    const historyCalls: HistoryCall[] = [];
    const errors: string[] = [];
    requestKlines = async () => {
      apiCalls += 1;
      if (invalid.reject) throw new Error(invalid.name);
      return invalid.response as KlineMetadata;
    };
    const symbol = `L1_INVALID_${invalid.name}_PERP`;
    const datafeed = datafeedModule.createContractTradingViewDatafeed({ symbol });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await datafeed.getBars(
        symbolInfo(symbol),
        '1',
        period,
        (bars: any[], meta: { noData?: boolean }) => historyCalls.push({ bars, meta }),
        (reason: string) => errors.push(reason),
      );
    }

    assert.equal(apiCalls, 2, `${invalid.name} unexpectedly hit L1`);
    if (invalid.response?.items.length) {
      assert.equal(historyCalls.length, 2, `${invalid.name} history callback count`);
      assert.equal(errors.length, 0, `${invalid.name} error callback count`);
      assert.ok(historyCalls.every((call) => call.meta.noData === false));
    } else {
      assert.equal(historyCalls.length, 0, `${invalid.name} history callback count`);
      assert.equal(errors.length, 2, `${invalid.name} error callback count`);
    }
    datafeed.destroy();
  }
});


test('fresh non-stale DB current metadata is eligible for L1 reuse', async () => {
  let apiCalls = 0;
  requestKlines = async () => {
    apiCalls += 1;
    return metadata(pageEndingAt(1_717_040_000_000, 100, '115'), {
      cache_status: 'HIT',
      freshness: 'CACHED',
    });
  };
  const historyCalls: HistoryCall[] = [];
  const datafeed = datafeedModule.createContractTradingViewDatafeed({ symbol: 'L1_DB_PERP' });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await datafeed.getBars(
      symbolInfo('L1_DB_PERP'),
      '1',
      period,
      (bars: any[], meta: { noData?: boolean }) => historyCalls.push({ bars, meta }),
      assert.fail,
    );
  }

  assert.equal(apiCalls, 1);
  assert.equal(historyCalls.length, 2);
  assert.deepEqual(historyCalls[0].bars, historyCalls[1].bars);
  datafeed.destroy();
});


test('cache-hit supersede settles the old callback and preserves the new result', async () => {
  const oldSymbol = 'L1_SUPERSEDED_OLD_PERP';
  const newSymbol = 'L1_SUPERSEDED_NEW_PERP';
  currentCacheModule.contractKlineCurrentCache.set(
    { symbol: oldSymbol, interval: '1m', limit: 100 },
    metadata(pageEndingAt(1_717_050_000_000, 100, '116')),
    15_000,
  );
  currentCacheModule.contractKlineCurrentCache.set(
    { symbol: newSymbol, interval: '1m', limit: 100 },
    metadata(pageEndingAt(1_717_060_000_000, 100, '117')),
    15_000,
  );
  let apiCalls = 0;
  requestKlines = async () => {
    apiCalls += 1;
    throw new Error('both requests should hit L1');
  };
  const oldHistory: HistoryCall[] = [];
  const newHistory: HistoryCall[] = [];
  const latest: Array<string | null> = [];
  const datafeed = datafeedModule.createContractTradingViewDatafeed({
    symbol: oldSymbol,
    onLatestBar: (close: string | null) => latest.push(close),
  });

  const oldRequest = datafeed.getBars(
    symbolInfo(oldSymbol),
    '1',
    period,
    (bars: any[], meta: { noData?: boolean }) => oldHistory.push({ bars, meta }),
    assert.fail,
  );
  const newRequest = datafeed.getBars(
    symbolInfo(newSymbol),
    '1',
    period,
    (bars: any[], meta: { noData?: boolean }) => newHistory.push({ bars, meta }),
    assert.fail,
  );
  await Promise.all([oldRequest, newRequest]);
  await Promise.resolve();

  assert.equal(apiCalls, 0);
  assert.equal(oldHistory.length, 1);
  assert.deepEqual(oldHistory[0], { bars: [], meta: { noData: false } });
  assert.equal(newHistory.length, 1);
  assert.equal(newHistory[0].bars.length, 100);
  assert.deepEqual(latest, ['117']);
  datafeed.destroy();
});


test('destroyed cache-hit caller has no side effects and does not affect another instance', async () => {
  const symbol = 'L1_DESTROY_HIT_PERP';
  currentCacheModule.contractKlineCurrentCache.set(
    { symbol, interval: '1m', limit: 100 },
    metadata(pageEndingAt(1_717_070_000_000, 100, '118')),
    15_000,
  );
  let apiCalls = 0;
  requestKlines = async () => {
    apiCalls += 1;
    throw new Error('both requests should hit L1');
  };
  const destroyedHistory: HistoryCall[] = [];
  const destroyedLatest: Array<string | null> = [];
  const liveHistory: HistoryCall[] = [];
  const destroyed = datafeedModule.createContractTradingViewDatafeed({
    symbol,
    onLatestBar: (close: string | null) => destroyedLatest.push(close),
  });
  const live = datafeedModule.createContractTradingViewDatafeed({ symbol });

  const destroyedRequest = destroyed.getBars(
    symbolInfo(symbol),
    '1',
    period,
    (bars: any[], meta: { noData?: boolean }) => destroyedHistory.push({ bars, meta }),
    assert.fail,
  );
  destroyed.destroy();
  const liveRequest = live.getBars(
    symbolInfo(symbol),
    '1',
    period,
    (bars: any[], meta: { noData?: boolean }) => liveHistory.push({ bars, meta }),
    assert.fail,
  );
  await Promise.all([destroyedRequest, liveRequest]);

  assert.equal(apiCalls, 0);
  assert.equal(destroyedHistory.length, 0);
  assert.deepEqual(destroyedLatest, []);
  assert.equal(liveHistory.length, 1);
  assert.equal(liveHistory[0].bars.length, 100);
  live.destroy();
});


test('valid API response writes L1 even when its original datafeed is destroyed', async () => {
  const symbol = 'L1_DESTROY_FETCH_PERP';
  const pending = deferred<KlineMetadata>();
  let apiCalls = 0;
  requestKlines = async () => {
    apiCalls += 1;
    return pending.promise;
  };
  const destroyedHistory: HistoryCall[] = [];
  const liveHistory: HistoryCall[] = [];
  const destroyed = datafeedModule.createContractTradingViewDatafeed({ symbol });
  const destroyedRequest = destroyed.getBars(
    symbolInfo(symbol),
    '1',
    period,
    (bars: any[], meta: { noData?: boolean }) => destroyedHistory.push({ bars, meta }),
    assert.fail,
  );
  destroyed.destroy();
  pending.resolve(metadata(pageEndingAt(1_717_080_000_000, 100, '119')));
  await destroyedRequest;

  const live = datafeedModule.createContractTradingViewDatafeed({ symbol });
  await live.getBars(
    symbolInfo(symbol),
    '1',
    period,
    (bars: any[], meta: { noData?: boolean }) => liveHistory.push({ bars, meta }),
    assert.fail,
  );

  assert.equal(apiCalls, 1);
  assert.equal(destroyedHistory.length, 0);
  assert.equal(liveHistory.length, 1);
  assert.equal(liveHistory[0].bars.length, 100);
  live.destroy();
});


test('rebuilt current L1 establishes a new instance high-water baseline', async () => {
  const symbol = 'L1_HIGH_WATER_PERP';
  const newerRestTime = 1_717_100_000_000;
  let apiCalls = 0;
  requestKlines = async () => {
    apiCalls += 1;
    return metadata(pageEndingAt(newerRestTime, 100, '130'));
  };
  const seed = datafeedModule.createContractTradingViewDatafeed({ symbol });
  await seed.getBars(symbolInfo(symbol), '1', period, () => undefined, assert.fail);
  seed.destroy();

  assert.equal(currentCacheModule.contractKlineCurrentCache.set(
    { symbol, interval: '1m', limit: 100 },
    metadata(pageEndingAt(newerRestTime - 60_000, 100, '129')),
    15_000,
  ), true);
  const latest: Array<string | null> = [];
  const realtimeBars: any[] = [];
  const rebuilt = datafeedModule.createContractTradingViewDatafeed({
    symbol,
    onLatestBar: (close: string | null) => latest.push(close),
  });
  await rebuilt.getBars(symbolInfo(symbol), '1', period, () => undefined, assert.fail);

  assert.equal(apiCalls, 1);
  assert.deepEqual(latest, ['129']);
  rebuilt.subscribeBars(
    symbolInfo(symbol),
    '1',
    (bar: any) => realtimeBars.push(bar),
    'l1-high-water',
  );
  emitRealtime(realtimeCandle(symbol, '1m', newerRestTime - 120_000, '128.5'));
  emitRealtime(realtimeCandle(symbol, '1m', newerRestTime - 30_000, '129.5'));

  assert.equal(realtimeBars.length, 1);
  assert.equal(realtimeBars[0].time, newerRestTime - 30_000);
  assert.deepEqual(latest, ['129', '129.5']);
  rebuilt.unsubscribeBars('l1-high-water');
  rebuilt.destroy();
});


test('shared rejected request settles every live caller once through error callbacks', async () => {
  const pending = deferred<KlineMetadata>();
  let apiCalls = 0;
  requestKlines = async () => {
    apiCalls += 1;
    return pending.promise;
  };
  const firstHistory: HistoryCall[] = [];
  const secondHistory: HistoryCall[] = [];
  const firstLoadingEvents: any[] = [];
  const secondLoadingEvents: any[] = [];
  let firstErrors = 0;
  let secondErrors = 0;
  const first = datafeedModule.createContractTradingViewDatafeed({
    symbol: 'DEDUPE_REJECT_PERP',
    onHistoryBars: (event: unknown) => firstLoadingEvents.push(event),
  });
  const second = datafeedModule.createContractTradingViewDatafeed({
    symbol: 'DEDUPE_REJECT_PERP',
    onHistoryBars: (event: unknown) => secondLoadingEvents.push(event),
  });

  const firstRequest = first.getBars(
    symbolInfo('DEDUPE_REJECT_PERP'),
    '1',
    period,
    (bars: any[], meta: { noData?: boolean }) => firstHistory.push({ bars, meta }),
    () => { firstErrors += 1; },
  );
  const secondRequest = second.getBars(
    symbolInfo('DEDUPE_REJECT_PERP'),
    '1',
    period,
    (bars: any[], meta: { noData?: boolean }) => secondHistory.push({ bars, meta }),
    () => { secondErrors += 1; },
  );

  assert.equal(apiCalls, 1);
  pending.reject(new Error('shared provider unavailable'));
  await Promise.all([firstRequest, secondRequest]);

  assert.equal(firstHistory.length, 0);
  assert.equal(secondHistory.length, 0);
  assert.equal(firstErrors, 1);
  assert.equal(secondErrors, 1);
  assert.equal(firstLoadingEvents.length, 0);
  assert.equal(secondLoadingEvents.length, 0);
  const retryHistory: HistoryCall[] = [];
  const retryErrors: string[] = [];
  const retry = datafeedModule.createContractTradingViewDatafeed({ symbol: 'DEDUPE_REJECT_PERP' });
  await retry.getBars(
    symbolInfo('DEDUPE_REJECT_PERP'),
    '1',
    period,
    (bars: any[], meta: { noData?: boolean }) => retryHistory.push({ bars, meta }),
    (reason: string) => retryErrors.push(reason),
  );
  assert.equal(apiCalls, 2, 'rejected Promise must be removed instead of becoming a negative cache');
  assert.equal(retryHistory.length, 0);
  assert.deepEqual(retryErrors, ['shared provider unavailable']);
  retry.destroy();
  first.destroy();
  second.destroy();
});


test('same-generation identical requests share HTTP and both receive normal bars', async () => {
  const pending: Array<Deferred<KlineMetadata>> = [];
  requestKlines = async () => {
    const request = deferred<KlineMetadata>();
    pending.push(request);
    return request.promise;
  };
  const latest: Array<string | null> = [];
  const oldHistoryCalls: HistoryCall[] = [];
  const newHistoryCalls: HistoryCall[] = [];
  let oldErrorCalls = 0;
  let newErrorCalls = 0;
  const historyEvents: any[] = [];
  const datafeed = datafeedModule.createContractTradingViewDatafeed({
    symbol: 'BTCUSDT_PERP',
    onLatestBar: (close: string | null) => latest.push(close),
    onHistoryBars: (event: unknown) => historyEvents.push(event),
  });

  const oldRequest = datafeed.getBars(
    symbolInfo('BTCUSDT_PERP'),
    '1',
    period,
    (bars: any[], meta: { noData?: boolean }) => oldHistoryCalls.push({ bars, meta }),
    () => { oldErrorCalls += 1; },
  );
  const newRequest = datafeed.getBars(
    symbolInfo('BTCUSDT_PERP'),
    '1',
    period,
    (bars: any[], meta: { noData?: boolean }) => newHistoryCalls.push({ bars, meta }),
    () => { newErrorCalls += 1; },
  );

  assert.equal(oldHistoryCalls.length, 0);
  await Promise.resolve();
  assert.equal(oldHistoryCalls.length, 0, 'same-generation requests must remain active');
  assert.equal(oldErrorCalls, 0);
  assert.deepEqual(latest, []);
  assert.equal(historyEvents.length, 0);

  assert.equal(pending.length, 1, 'identical requests must share one HTTP promise');
  pending[0].resolve(metadata(pageEndingAt(1_717_000_060_000, 100, '102')));
  await Promise.all([oldRequest, newRequest]);
  assert.equal(oldHistoryCalls.length, 1);
  assert.equal(oldHistoryCalls[0].bars[0].close, 102);
  assert.equal(newHistoryCalls.length, 1);
  assert.equal(newHistoryCalls[0].bars[0].close, 102);
  assert.equal(oldErrorCalls, 0);
  assert.equal(newErrorCalls, 0);
  assert.deepEqual(latest, ['102', '102']);
  assert.equal(historyEvents.length, 2);
  assert.deepEqual(historyEvents.map((event) => event.requestSeq), [1, 2]);
  assert.ok(historyEvents.every((event) => event.barCount === 100));
});


test('superseding one shared caller does not affect another live datafeed caller', async () => {
  const sharedCurrent = deferred<KlineMetadata>();
  const replacement = deferred<KlineMetadata>();
  const apiCalls: KlineRequest[] = [];
  requestKlines = async (params) => {
    apiCalls.push(params);
    return params.interval === '1m' ? sharedCurrent.promise : replacement.promise;
  };
  const oldHistory: HistoryCall[] = [];
  const replacementHistory: HistoryCall[] = [];
  const liveHistory: HistoryCall[] = [];
  const first = datafeedModule.createContractTradingViewDatafeed({ symbol: 'SHARED_SUPERSEDE_PERP' });
  const second = datafeedModule.createContractTradingViewDatafeed({ symbol: 'SHARED_SUPERSEDE_PERP' });

  const oldRequest = first.getBars(
    symbolInfo('SHARED_SUPERSEDE_PERP'),
    '1',
    period,
    (bars: any[], meta: { noData?: boolean }) => oldHistory.push({ bars, meta }),
    assert.fail,
  );
  const liveRequest = second.getBars(
    symbolInfo('SHARED_SUPERSEDE_PERP'),
    '1',
    period,
    (bars: any[], meta: { noData?: boolean }) => liveHistory.push({ bars, meta }),
    assert.fail,
  );
  const replacementRequest = first.getBars(
    symbolInfo('SHARED_SUPERSEDE_PERP'),
    '5',
    period,
    (bars: any[], meta: { noData?: boolean }) => replacementHistory.push({ bars, meta }),
    assert.fail,
  );

  assert.equal(apiCalls.length, 2);
  await Promise.resolve();
  assert.equal(oldHistory.length, 1);
  assert.deepEqual(oldHistory[0].bars, []);
  assert.equal(oldHistory[0].meta.noData, false);

  sharedCurrent.resolve(metadata(pageEndingAt(1_717_000_000_000, 100, '101')));
  await Promise.all([oldRequest, liveRequest]);
  assert.equal(oldHistory.length, 1, 'superseded shared caller must not settle twice');
  assert.equal(liveHistory.length, 1);
  assert.equal(liveHistory[0].bars[0].close, 101);

  replacement.resolve(metadata(pageEndingAt(1_717_000_300_000, 100, '105')));
  await replacementRequest;
  assert.equal(replacementHistory.length, 1);
  assert.equal(replacementHistory[0].bars[0].close, 105);
  first.destroy();
  second.destroy();
});


test('rapid 5m to 1M to 5m retires stale generations without contaminating the final 5m', async () => {
  const fiveMinute = deferred<KlineMetadata>();
  const monthly = deferred<KlineMetadata>();
  const apiCalls: KlineRequest[] = [];
  requestKlines = async (params) => {
    apiCalls.push(params);
    return params.interval === '1M' ? monthly.promise : fiveMinute.promise;
  };
  const oldFiveMinuteHistory: HistoryCall[] = [];
  const monthlyHistory: HistoryCall[] = [];
  const finalFiveMinuteHistory: HistoryCall[] = [];
  const latest: Array<string | null> = [];
  const datafeed = datafeedModule.createContractTradingViewDatafeed({
    symbol: 'RAPID_GENERATION_PERP',
    onLatestBar: (close: string | null) => latest.push(close),
  });

  const oldFiveMinuteRequest = datafeed.getBars(
    symbolInfo('RAPID_GENERATION_PERP'),
    '5',
    period,
    (bars: any[], meta: { noData?: boolean }) => oldFiveMinuteHistory.push({ bars, meta }),
    assert.fail,
  );
  const monthlyRequest = datafeed.getBars(
    symbolInfo('RAPID_GENERATION_PERP'),
    '1M',
    period,
    (bars: any[], meta: { noData?: boolean }) => monthlyHistory.push({ bars, meta }),
    assert.fail,
  );
  const finalFiveMinuteRequest = datafeed.getBars(
    symbolInfo('RAPID_GENERATION_PERP'),
    '5',
    period,
    (bars: any[], meta: { noData?: boolean }) => finalFiveMinuteHistory.push({ bars, meta }),
    assert.fail,
  );

  await Promise.resolve();
  assert.equal(apiCalls.length, 2, 'the final 5m request must reuse the active 5m range lease');
  assert.equal(oldFiveMinuteHistory.length, 1);
  assert.deepEqual(oldFiveMinuteHistory[0].bars, []);
  assert.equal(monthlyHistory.length, 1);
  assert.deepEqual(monthlyHistory[0].bars, []);

  fiveMinute.resolve(metadata(pageEndingAt(1_717_000_300_000, 140, '205')));
  monthly.resolve(metadata(pageEndingAt(1_717_000_000_000, 60, '999')));
  await Promise.all([oldFiveMinuteRequest, monthlyRequest, finalFiveMinuteRequest]);

  assert.equal(oldFiveMinuteHistory.length, 1);
  assert.equal(monthlyHistory.length, 1);
  assert.equal(finalFiveMinuteHistory.length, 1);
  assert.equal(finalFiveMinuteHistory[0].bars.at(-1)?.close, 205);
  assert.deepEqual(latest, ['205']);
  datafeed.destroy();
});


test('destroying one datafeed does not cancel another caller shared HTTP promise', async () => {
  const pending = deferred<KlineMetadata>();
  let apiCalls = 0;
  requestKlines = async () => {
    apiCalls += 1;
    return pending.promise;
  };
  let destroyedHistoryCalls = 0;
  let destroyedErrorCalls = 0;
  const liveHistory: HistoryCall[] = [];
  let liveErrorCalls = 0;
  const destroyed = datafeedModule.createContractTradingViewDatafeed({ symbol: 'SHARED_DESTROY_PERP' });
  const live = datafeedModule.createContractTradingViewDatafeed({ symbol: 'SHARED_DESTROY_PERP' });

  const destroyedRequest = destroyed.getBars(
    symbolInfo('SHARED_DESTROY_PERP'),
    '1',
    period,
    () => { destroyedHistoryCalls += 1; },
    () => { destroyedErrorCalls += 1; },
  );
  const liveRequest = live.getBars(
    symbolInfo('SHARED_DESTROY_PERP'),
    '1',
    period,
    (bars: any[], meta: { noData?: boolean }) => liveHistory.push({ bars, meta }),
    () => { liveErrorCalls += 1; },
  );

  assert.equal(apiCalls, 1);
  destroyed.destroy();
  pending.resolve(metadata(pageEndingAt(1_717_000_000_000, 100, '111')));
  await Promise.all([destroyedRequest, liveRequest]);

  assert.equal(destroyedHistoryCalls, 0);
  assert.equal(destroyedErrorCalls, 0);
  assert.equal(liveHistory.length, 1);
  assert.equal(liveHistory[0].bars[0].close, 111);
  assert.equal(liveErrorCalls, 0);
  live.destroy();
});


test('symbol interval and history cursor isolate HTTP while limit shares then upgrades', async () => {
  const cases = [
    {
      name: 'symbol',
      first: { ticker: 'KEY_SYMBOL_A_PERP', resolution: '1', period },
      second: { ticker: 'KEY_SYMBOL_B_PERP', resolution: '1', period },
    },
    {
      name: 'interval',
      first: { ticker: 'KEY_INTERVAL_PERP', resolution: '1', period },
      second: { ticker: 'KEY_INTERVAL_PERP', resolution: '5', period },
    },
    {
      name: 'endTimeMs',
      first: {
        ticker: 'KEY_END_PERP',
        resolution: '1',
        period: { ...period, firstDataRequest: false, to: 2_000_000_000 },
      },
      second: {
        ticker: 'KEY_END_PERP',
        resolution: '1',
        period: { ...period, firstDataRequest: false, to: 1_999_999_999 },
      },
    },
    {
      name: 'limit',
      first: {
        ticker: 'KEY_LIMIT_PERP',
        resolution: '1',
        period: { ...period, countBack: 100 },
      },
      second: {
        ticker: 'KEY_LIMIT_PERP',
        resolution: '1',
        period: { ...period, countBack: 200 },
      },
    },
  ];

  for (const item of cases) {
    const pending: Array<Deferred<KlineMetadata>> = [];
    const apiCalls: KlineRequest[] = [];
    requestKlines = async (params) => {
      apiCalls.push(params);
      const request = deferred<KlineMetadata>();
      pending.push(request);
      return request.promise;
    };
    const firstHistory: HistoryCall[] = [];
    const secondHistory: HistoryCall[] = [];
    const first = datafeedModule.createContractTradingViewDatafeed({ symbol: item.first.ticker });
    const second = datafeedModule.createContractTradingViewDatafeed({ symbol: item.second.ticker });

    const firstRequest = first.getBars(
      symbolInfo(item.first.ticker),
      item.first.resolution,
      item.first.period,
      (bars: any[], meta: { noData?: boolean }) => firstHistory.push({ bars, meta }),
      assert.fail,
    );
    const secondRequest = second.getBars(
      symbolInfo(item.second.ticker),
      item.second.resolution,
      item.second.period,
      (bars: any[], meta: { noData?: boolean }) => secondHistory.push({ bars, meta }),
      assert.fail,
    );

    const initialRequestCount = item.name === 'limit' ? 1 : 2;
    assert.equal(apiCalls.length, initialRequestCount, item.name);
    assert.equal(pending.length, initialRequestCount, item.name);
    pending[0].resolve(metadata(pageEndingAt(
      1_717_000_000_000,
      apiCalls[0].limit || 100,
      '101',
    )));
    if (item.name === 'limit') {
      await waitFor(() => pending.length === 2, 'larger countBack upgrade request missing');
    }
    pending[1].resolve(metadata(pageEndingAt(
      1_717_000_000_000,
      apiCalls[1].limit || 100,
      '102',
    )));
    await Promise.all([firstRequest, secondRequest]);
    assert.equal(firstHistory.length, 1, item.name);
    assert.equal(secondHistory.length, 1, item.name);
    first.destroy();
    second.destroy();
  }
});


test('larger current L1 coverage is reused before a countBack deficit continuation', async () => {
  const symbol = 'L1_PAGED_CURRENT_PERP';
  const currentEnd = 1_800_000_000_000;
  const currentRows = pageEndingAt(currentEnd, 200, '120');
  assert.equal(currentCacheModule.contractKlineCurrentCache.set(
    { symbol, interval: '1m', limit: 500 },
    metadata(currentRows),
    15_000,
  ), true);
  assert.ok(currentCacheModule.contractKlineCurrentCache.getAtLeast({
    symbol,
    interval: '1m',
    limit: 150,
  }));
  const apiCalls: KlineRequest[] = [];
  requestKlines = async (params) => {
    apiCalls.push(params);
    return metadata(pageEndingAt(currentRows[0].open_time - 60_000, params.limit || 300, '119'));
  };
  const historyCalls: HistoryCall[] = [];
  const loadingEvents: any[] = [];
  const datafeed = datafeedModule.createContractTradingViewDatafeed({
    symbol,
    onHistoryBars: (event: unknown) => loadingEvents.push(event),
  });

  await datafeed.getBars(
    symbolInfo(symbol),
    '1',
    { ...period, countBack: 500 },
    (bars: any[], meta: { noData?: boolean }) => historyCalls.push({ bars, meta }),
    assert.fail,
  );

  assert.equal(apiCalls.length, 1);
  assert.equal(apiCalls[0].limit, 300);
  assert.equal(apiCalls[0].endTimeMs, currentRows[0].open_time);
  assert.equal(historyCalls.length, 1);
  assert.equal(historyCalls[0].bars.length, 500);
  assert.equal(new Set(historyCalls[0].bars.map((bar) => bar.time)).size, 500);
  assert.equal(historyCalls[0].meta.noData, false);
  assert.equal(loadingEvents.length, 1);
  datafeed.destroy();
});


test('current L1 hit that satisfies countBack sends no HTTP and completes once', async () => {
  const symbol = 'L1_COMPLETE_CURRENT_PERP';
  const currentRows = pageEndingAt(1_800_100_000_000, 100, '121');
  assert.equal(currentCacheModule.contractKlineCurrentCache.set(
    { symbol, interval: '1m', limit: 100 },
    metadata(currentRows),
    15_000,
  ), true);
  let apiCalls = 0;
  requestKlines = async () => {
    apiCalls += 1;
    throw new Error('cache hit must not issue HTTP');
  };
  const historyCalls: HistoryCall[] = [];
  const loadingEvents: any[] = [];
  const datafeed = datafeedModule.createContractTradingViewDatafeed({
    symbol,
    onHistoryBars: (event: unknown) => loadingEvents.push(event),
  });

  await datafeed.getBars(
    symbolInfo(symbol),
    '1',
    period,
    (bars: any[], meta: { noData?: boolean }) => historyCalls.push({ bars, meta }),
    assert.fail,
  );

  assert.equal(apiCalls, 0);
  assert.equal(historyCalls.length, 1);
  assert.equal(historyCalls[0].bars.length, 100);
  assert.equal(loadingEvents.length, 1);
  datafeed.destroy();
});


test('evicted current L1 key requests HTTP again after the 65th write', async () => {
  for (let index = 0; index < 65; index += 1) {
    assert.equal(currentCacheModule.contractKlineCurrentCache.set(
      { symbol: `L1_FIFO_${index}_PERP`, interval: '1m', limit: 100 },
      metadata(pageEndingAt(1_800_200_000_000, 100, String(122 + index))),
      15_000,
    ), true);
  }
  assert.equal(currentCacheModule.contractKlineCurrentCache.size, 64);
  let apiCalls = 0;
  requestKlines = async () => {
    apiCalls += 1;
    return metadata(pageEndingAt(1_800_300_000_000, 100, '187'));
  };
  const datafeed = datafeedModule.createContractTradingViewDatafeed({ symbol: 'L1_FIFO_0_PERP' });

  await datafeed.getBars(
    symbolInfo('L1_FIFO_0_PERP'),
    '1',
    period,
    () => undefined,
    assert.fail,
  );

  assert.equal(apiCalls, 1);
  assert.equal(currentCacheModule.contractKlineCurrentCache.size, 64);
  datafeed.destroy();
});


test('1W and 1M current countBack 300 complete through one continuation page', async () => {
  const cases = [
    { resolution: '1W', interval: '1w', firstCoverage: 80, continuationCoverage: 220 },
    { resolution: '1M', interval: '1M', firstCoverage: 60, continuationCoverage: 240 },
  ];

  for (const item of cases) {
    currentCacheModule.contractKlineCurrentCache.clear();
    const calls: KlineRequest[] = [];
    const newestExclusive = item.interval === '1M'
      ? Date.parse('2031-08-01T00:00:00.000Z')
      : Date.parse('2026-07-20T00:00:00.000Z');
    requestKlines = async (params) => {
      calls.push(params);
      const endExclusive = params.endTimeMs ?? newestExclusive;
      return metadata(utcBoundaryPageBefore(
        item.interval as '1w' | '1M',
        endExclusive,
        params.limit || 1,
        String(300 - calls.length),
      ));
    };
    const historyCalls: HistoryCall[] = [];
    const loadingEvents: any[] = [];
    const datafeed = datafeedModule.createContractTradingViewDatafeed({
      symbol: `COUNTBACK_${item.interval}_PERP`,
      onHistoryBars: (event: unknown) => loadingEvents.push(event),
    });

    await datafeed.getBars(
      symbolInfo(`COUNTBACK_${item.interval}_PERP`),
      item.resolution,
      { ...period, countBack: 300 },
      (bars: any[], meta: { noData?: boolean }) => historyCalls.push({ bars, meta }),
      assert.fail,
    );

    assert.deepEqual(calls.map((call) => call.interval), [item.interval, item.interval]);
    assert.deepEqual(
      calls.map((call) => call.limit),
      [item.firstCoverage, item.continuationCoverage],
    );
    assert.equal(calls[0].endTimeMs, undefined);
    assert.equal(typeof calls[1].endTimeMs, 'number');
    assert.equal(historyCalls.length, 1);
    assert.equal(historyCalls[0].bars.length, 300);
    assert.equal(new Set(historyCalls[0].bars.map((bar) => bar.time)).size, 300);
    assert.equal(historyCalls[0].meta.noData, false);
    assert.equal(loadingEvents.length, 1);
    assert.equal(loadingEvents[0].barCount, 300);
    datafeed.destroy();
  }
});


test('history countBack stops after the second page reaches the target', async () => {
  const pending: Array<Deferred<KlineMetadata>> = [];
  const calls: KlineRequest[] = [];
  requestKlines = async (params) => {
    calls.push(params);
    const request = deferred<KlineMetadata>();
    pending.push(request);
    return request.promise;
  };
  const oldest = 1_700_000_000_000;
  const step = 60_000;
  const historyCalls: HistoryCall[] = [];
  const datafeed = datafeedModule.createContractTradingViewDatafeed({ symbol: 'PAGED_HISTORY_PERP' });

  const request = datafeed.getBars(
    symbolInfo('PAGED_HISTORY_PERP'),
    '1',
    { ...period, firstDataRequest: false, countBack: 250 },
    (bars: any[], meta: { noData?: boolean }) => historyCalls.push({ bars, meta }),
    assert.fail,
  );
  pending[0].resolve(metadata(pageEndingAt(oldest + (249 * step), 150, '2')));
  await waitFor(() => pending.length === 2, 'history second page was not requested');

  assert.equal(calls[0].endTimeMs, 2_000_000_000_000);
  assert.equal(calls[0].limit, 200);
  assert.equal(calls[1].endTimeMs, oldest + (100 * step));
  assert.equal(calls[1].limit, 100);
  pending[1].resolve(metadata(pageEndingAt(oldest + (99 * step), 100, '1')));
  await request;

  assert.equal(calls.length, 2);
  assert.equal(historyCalls.length, 1);
  assert.equal(historyCalls[0].bars.length, 250);
  assert.equal(historyCalls[0].meta.noData, false);
  datafeed.destroy();
});


test('three-page ceiling returns partial bars without claiming noData', async () => {
  const pending: Array<Deferred<KlineMetadata>> = [];
  const calls: KlineRequest[] = [];
  requestKlines = async (params) => {
    calls.push(params);
    const request = deferred<KlineMetadata>();
    pending.push(request);
    return request.promise;
  };
  const oldest = 1_700_000_000_000;
  const step = 60_000;
  const historyCalls: HistoryCall[] = [];
  const datafeed = datafeedModule.createContractTradingViewDatafeed({ symbol: 'PAGE_LIMIT_PERP' });
  const request = datafeed.getBars(
    symbolInfo('PAGE_LIMIT_PERP'),
    '1',
    { ...period, firstDataRequest: false, countBack: 500 },
    (bars: any[], meta: { noData?: boolean }) => historyCalls.push({ bars, meta }),
    assert.fail,
  );

  pending[0].resolve(metadata(pageEndingAt(oldest + (299 * step), 100, '3')));
  await waitFor(() => pending.length === 2, 'page limit second page missing');
  pending[1].resolve(metadata(pageEndingAt(oldest + (199 * step), 100, '2')));
  await waitFor(() => pending.length === 3, 'page limit third page missing');
  pending[2].resolve(metadata(pageEndingAt(oldest + (99 * step), 100, '1')));
  await request;

  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((item) => item.limit), [200, 400, 300]);
  assert.equal(historyCalls.length, 1);
  assert.equal(historyCalls[0].bars.length, 300);
  assert.equal(historyCalls[0].meta.noData, false);
  datafeed.destroy();
});


test('countBack above 1000 is capped across at most three pages', async () => {
  const pending: Array<Deferred<KlineMetadata>> = [];
  const calls: KlineRequest[] = [];
  requestKlines = async (params) => {
    calls.push(params);
    const request = deferred<KlineMetadata>();
    pending.push(request);
    return request.promise;
  };
  const oldest = 1_600_000_000_000;
  const step = 60_000;
  const historyCalls: HistoryCall[] = [];
  const datafeed = datafeedModule.createContractTradingViewDatafeed({ symbol: 'BAR_LIMIT_PERP' });
  const request = datafeed.getBars(
    symbolInfo('BAR_LIMIT_PERP'),
    '1',
    { ...period, firstDataRequest: false, countBack: 5000 },
    (bars: any[], meta: { noData?: boolean }) => historyCalls.push({ bars, meta }),
    assert.fail,
  );

  pending[0].resolve(metadata(pageEndingAt(oldest + (999 * step), 400, '3')));
  await waitFor(() => pending.length === 2, '1000 cap second page missing');
  pending[1].resolve(metadata(pageEndingAt(oldest + (599 * step), 300, '2')));
  await waitFor(() => pending.length === 3, '1000 cap third page missing');
  pending[2].resolve(metadata(pageEndingAt(oldest + (299 * step), 300, '1')));
  await request;

  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((item) => item.limit), [200, 500, 300]);
  assert.equal(historyCalls.length, 1);
  assert.equal(historyCalls[0].bars.length, 1000);
  assert.equal(historyCalls[0].meta.noData, false);
  datafeed.destroy();
});


test('overlapping and disordered pages merge into unique ascending bars', async () => {
  const pending: Array<Deferred<KlineMetadata>> = [];
  requestKlines = async () => {
    const request = deferred<KlineMetadata>();
    pending.push(request);
    return request.promise;
  };
  const oldest = 1_700_000_000_000;
  const step = 60_000;
  const firstPage = pageEndingAt(oldest + (299 * step), 200, '2');
  const secondPage = pageEndingAt(oldest + (99 * step), 100, '1');
  const historyCalls: HistoryCall[] = [];
  const datafeed = datafeedModule.createContractTradingViewDatafeed({ symbol: 'MERGE_PERP' });
  const request = datafeed.getBars(
    symbolInfo('MERGE_PERP'),
    '1',
    { ...period, firstDataRequest: false, countBack: 300 },
    (bars: any[], meta: { noData?: boolean }) => historyCalls.push({ bars, meta }),
    assert.fail,
  );

  pending[0].resolve(metadata([...firstPage.slice().reverse(), firstPage[50]]));
  await waitFor(() => pending.length === 2, 'merge second page missing');
  pending[1].resolve(metadata([
    ...secondPage.slice().reverse(),
    firstPage[0],
    firstPage[50],
  ]));
  await request;

  const bars = historyCalls[0].bars;
  assert.equal(bars.length, 300);
  assert.equal(new Set(bars.map((bar) => bar.time)).size, 300);
  assert.deepEqual(
    bars.map((bar) => bar.time),
    [...bars.map((bar) => bar.time)].sort((left, right) => left - right),
  );
  datafeed.destroy();
});


test('page without an earlier cursor stops pagination as no progress', async () => {
  const pending: Array<Deferred<KlineMetadata>> = [];
  const calls: KlineRequest[] = [];
  requestKlines = async (params) => {
    calls.push(params);
    const request = deferred<KlineMetadata>();
    pending.push(request);
    return request.promise;
  };
  const firstPage = pageEndingAt(1_700_010_000_000, 100, '1');
  const historyCalls: HistoryCall[] = [];
  const datafeed = datafeedModule.createContractTradingViewDatafeed({ symbol: 'NO_PROGRESS_PERP' });
  const request = datafeed.getBars(
    symbolInfo('NO_PROGRESS_PERP'),
    '1',
    { ...period, countBack: 300 },
    (bars: any[], meta: { noData?: boolean }) => historyCalls.push({ bars, meta }),
    assert.fail,
  );

  pending[0].resolve(metadata(firstPage));
  await waitFor(() => pending.length === 2, 'no-progress second page missing');
  const cursor = calls[1].endTimeMs as number;
  pending[1].resolve(metadata([
    row(cursor, '2'),
    row(cursor + 60_000, '2'),
    ...firstPage,
  ]));
  await request;

  assert.equal(calls.length, 2);
  assert.equal(historyCalls.length, 1);
  assert.equal(historyCalls[0].bars.length, 100);
  assert.equal(historyCalls[0].meta.noData, false);
  datafeed.destroy();
});


test('second-page transient empty returns first-page bars without a third request', async () => {
  const pending: Array<Deferred<KlineMetadata>> = [];
  requestKlines = async () => {
    const request = deferred<KlineMetadata>();
    pending.push(request);
    return request.promise;
  };
  const firstPage = pageEndingAt(1_700_010_000_000, 100, '1');
  const historyCalls: HistoryCall[] = [];
  const datafeed = datafeedModule.createContractTradingViewDatafeed({ symbol: 'SECOND_EMPTY_PERP' });
  const request = datafeed.getBars(
    symbolInfo('SECOND_EMPTY_PERP'),
    '1',
    { ...period, countBack: 300 },
    (bars: any[], meta: { noData?: boolean }) => historyCalls.push({ bars, meta }),
    assert.fail,
  );

  pending[0].resolve(metadata(firstPage));
  await waitFor(() => pending.length === 2, 'transient empty second page missing');
  pending[1].resolve(metadata([], {
    cache_status: 'PROVIDER_EMPTY',
    history_incomplete: true,
    history_complete: false,
    has_more_before: null,
    provider_error_code: 'EMPTY',
    retryable: true,
  }));
  await request;

  assert.equal(pending.length, 2);
  assert.equal(historyCalls.length, 1);
  assert.equal(historyCalls[0].bars.length, 100);
  assert.equal(historyCalls[0].meta.noData, false);
  datafeed.destroy();
});


test('second-page rejection preserves partial bars and completes Loading once', async () => {
  const pending: Array<Deferred<KlineMetadata>> = [];
  requestKlines = async () => {
    const request = deferred<KlineMetadata>();
    pending.push(request);
    return request.promise;
  };
  const historyCalls: HistoryCall[] = [];
  const loadingEvents: any[] = [];
  const datafeed = datafeedModule.createContractTradingViewDatafeed({
    symbol: 'SECOND_REJECT_PERP',
    onHistoryBars: (event: unknown) => loadingEvents.push(event),
  });
  const request = datafeed.getBars(
    symbolInfo('SECOND_REJECT_PERP'),
    '1',
    { ...period, countBack: 300 },
    (bars: any[], meta: { noData?: boolean }) => historyCalls.push({ bars, meta }),
    assert.fail,
  );

  pending[0].resolve(metadata(pageEndingAt(1_700_010_000_000, 100, '1')));
  await waitFor(() => pending.length === 2, 'rejected second page missing');
  pending[1].reject(new Error('second page unavailable'));
  await request;

  assert.equal(pending.length, 2);
  assert.equal(historyCalls.length, 1);
  assert.equal(historyCalls[0].bars.length, 100);
  assert.equal(historyCalls[0].meta.noData, false);
  assert.equal(loadingEvents.length, 1);
  assert.equal(loadingEvents[0].barCount, 100);
  datafeed.destroy();
});


test('terminal metadata after partial bars stops paging without reporting noData', async () => {
  const pending: Array<Deferred<KlineMetadata>> = [];
  requestKlines = async () => {
    const request = deferred<KlineMetadata>();
    pending.push(request);
    return request.promise;
  };
  const historyCalls: HistoryCall[] = [];
  const datafeed = datafeedModule.createContractTradingViewDatafeed({ symbol: 'PARTIAL_TERMINAL_PERP' });
  const request = datafeed.getBars(
    symbolInfo('PARTIAL_TERMINAL_PERP'),
    '1',
    { ...period, firstDataRequest: false, countBack: 300 },
    (bars: any[], meta: { noData?: boolean }) => historyCalls.push({ bars, meta }),
    assert.fail,
  );

  pending[0].resolve(metadata(pageEndingAt(1_700_010_000_000, 100, '1')));
  await waitFor(() => pending.length === 2, 'terminal second page missing');
  pending[1].resolve(metadata([], {
    history_complete: true,
    has_more_before: false,
    history_incomplete: false,
    retryable: false,
  }));
  await request;

  assert.equal(pending.length, 2);
  assert.equal(historyCalls.length, 1);
  assert.equal(historyCalls[0].bars.length, 100);
  assert.equal(historyCalls[0].meta.noData, false);
  datafeed.destroy();
});


test('history pagination does not initialize latestBars high-water mark or onLatestBar', async () => {
  const historyEnd = 1_700_010_000_000;
  requestKlines = async () => metadata(pageEndingAt(historyEnd, 100, '1'));
  const latest: Array<string | null> = [];
  const realtimeBars: any[] = [];
  const historyCalls: HistoryCall[] = [];
  const datafeed = datafeedModule.createContractTradingViewDatafeed({
    symbol: 'HISTORY_STATE_ISOLATION_PERP',
    onLatestBar: (close: string | null) => latest.push(close),
  });

  await datafeed.getBars(
    symbolInfo('HISTORY_STATE_ISOLATION_PERP'),
    '1',
    { ...period, firstDataRequest: false, countBack: 100 },
    (bars: any[], meta: { noData?: boolean }) => historyCalls.push({ bars, meta }),
    assert.fail,
  );
  assert.equal(historyCalls.length, 1);
  assert.equal(historyCalls[0].bars.length, 100);
  assert.deepEqual(latest, []);
  await establishHistoryBaseline(datafeed, 'HISTORY_STATE_ISOLATION_PERP');
  latest.length = 0;

  datafeed.subscribeBars(
    symbolInfo('HISTORY_STATE_ISOLATION_PERP'),
    '1',
    (bar: any) => realtimeBars.push(bar),
    'history-state-isolation',
  );
  emitRealtime(realtimeCandle(
    'HISTORY_STATE_ISOLATION_PERP',
    '1m',
    historyEnd - 60_000,
    '77',
  ));

  assert.equal(realtimeBars.length, 1, 'history bars must not seed realtime high-water state');
  assert.deepEqual(latest, ['77']);
  datafeed.destroy();
});


test('terminal metadata persists within one generation and remains isolated by datafeed', async () => {
  let apiCalls = 0;
  requestKlines = async () => {
    apiCalls += 1;
    if (apiCalls === 1) {
      return metadata([], {
        history_complete: true,
        has_more_before: false,
        history_incomplete: false,
        retryable: false,
      });
    }
    return metadata([], {
      cache_status: 'PROVIDER_EMPTY',
      history_complete: false,
      has_more_before: null,
      history_incomplete: true,
      provider_error_code: 'EMPTY',
      retryable: true,
    });
  };
  const firstHistory: HistoryCall[] = [];
  const secondHistory: HistoryCall[] = [];
  const secondErrors: string[] = [];
  const first = datafeedModule.createContractTradingViewDatafeed({ symbol: 'TERMINAL_LOCAL_PERP' });
  const second = datafeedModule.createContractTradingViewDatafeed({ symbol: 'TERMINAL_LOCAL_PERP' });

  await first.getBars(
    symbolInfo('TERMINAL_LOCAL_PERP'),
    '1',
    { ...period, firstDataRequest: false },
    (bars: any[], meta: { noData?: boolean }) => firstHistory.push({ bars, meta }),
    assert.fail,
  );
  await first.getBars(
    symbolInfo('TERMINAL_LOCAL_PERP'),
    '1',
    { ...period, firstDataRequest: false },
    (bars: any[], meta: { noData?: boolean }) => firstHistory.push({ bars, meta }),
    assert.fail,
  );
  await second.getBars(
    symbolInfo('TERMINAL_LOCAL_PERP'),
    '1',
    { ...period, firstDataRequest: false },
    (bars: any[], meta: { noData?: boolean }) => secondHistory.push({ bars, meta }),
    (reason: string) => secondErrors.push(reason),
  );

  assert.equal(apiCalls, 2);
  assert.deepEqual(firstHistory.map((call) => call.meta.noData), [true, true]);
  assert.deepEqual(secondHistory, []);
  assert.equal(secondErrors.length, 1);
  first.destroy();
  second.destroy();
});


test('monthly settled coverage bounds fifty repeated getBars calls and settles every callback once', async () => {
  const apiCalls: KlineRequest[] = [];
  const currentEnd = Date.parse('2026-07-01T00:00:00.000Z');
  const currentBars = utcBoundaryPageEndingAt('1M', currentEnd, 40, '140');
  const nextEndTimeMs = currentBars[0].open_time;
  requestKlines = async (params) => {
    apiCalls.push(params);
    if (apiCalls.length === 1) return metadata(currentBars);
    if (apiCalls.length === 2) throw new Error('older page temporarily unavailable');
    if (apiCalls.length === 3) {
      return metadata([], {
        history_complete: true,
        has_more_before: false,
      });
    }
    assert.fail(`unexpected monthly history request ${apiCalls.length}`);
  };
  const callbackCounts = Array.from({ length: 51 }, () => 0);
  const historyCalls: HistoryCall[] = [];
  const datafeed = datafeedModule.createContractTradingViewDatafeed({
    symbol: 'MONTHLY_SETTLED_STORM_PERP',
  });

  for (let attempt = 0; attempt < callbackCounts.length; attempt += 1) {
    await datafeed.getBars(
      symbolInfo('MONTHLY_SETTLED_STORM_PERP'),
      '1M',
      { ...period, firstDataRequest: false, countBack: 60 },
      (bars: any[], meta: { noData?: boolean }) => {
        callbackCounts[attempt] += 1;
        historyCalls.push({ bars, meta });
      },
      assert.fail,
    );
  }

  assert.equal(apiCalls.length, 3, '51 getBars calls must not become 51 HTTP calls');
  assert.equal(apiCalls[0].endTimeMs, period.to * 1000);
  assert.equal(apiCalls[1].endTimeMs, nextEndTimeMs);
  assert.equal(apiCalls[2].endTimeMs, nextEndTimeMs);
  assert.ok(callbackCounts.every((count) => count === 1));
  assert.equal(historyCalls.length, 51);
  assert.ok(historyCalls.every((call) => call.bars.length === 40));
  assert.ok(historyCalls.every((call) => call.meta.noData === false));
  datafeed.destroy();
});


test('partial monthly coverage upgrades from nextEndTime instead of requesting CURRENT again', async () => {
  const apiCalls: KlineRequest[] = [];
  const currentBars = utcBoundaryPageEndingAt(
    '1M',
    Date.parse('2026-07-01T00:00:00.000Z'),
    40,
    '180',
  );
  const nextEndTimeMs = currentBars[0].open_time;
  const olderBars = utcBoundaryPageBefore('1M', nextEndTimeMs, 20, '160');
  requestKlines = async (params) => {
    apiCalls.push(params);
    if (apiCalls.length === 1) return metadata(currentBars);
    if (apiCalls.length === 2) throw new Error('settle partial coverage');
    if (apiCalls.length === 3) return metadata(olderBars);
    assert.fail(`unexpected coverage upgrade request ${apiCalls.length}`);
  };
  const historyCalls: HistoryCall[] = [];
  const datafeed = datafeedModule.createContractTradingViewDatafeed({
    symbol: 'MONTHLY_COVERAGE_UPGRADE_PERP',
  });

  await datafeed.getBars(
    symbolInfo('MONTHLY_COVERAGE_UPGRADE_PERP'),
    '1M',
    { ...period, firstDataRequest: false, countBack: 60 },
    (bars: any[], meta: { noData?: boolean }) => historyCalls.push({ bars, meta }),
    assert.fail,
  );
  await datafeed.getBars(
    symbolInfo('MONTHLY_COVERAGE_UPGRADE_PERP'),
    '1M',
    { ...period, firstDataRequest: false, countBack: 60 },
    (bars: any[], meta: { noData?: boolean }) => historyCalls.push({ bars, meta }),
    assert.fail,
  );

  assert.equal(apiCalls.length, 3);
  assert.equal(apiCalls.filter((call) => call.endTimeMs === undefined).length, 0);
  assert.equal(apiCalls[0].endTimeMs, period.to * 1000);
  assert.equal(apiCalls[2].endTimeMs, nextEndTimeMs);
  assert.equal(historyCalls[0].bars.length, 40);
  assert.equal(historyCalls[1].bars.length, 60);
  assert.equal(historyCalls[1].bars[0].close, 160);
  assert.equal(historyCalls[1].bars.at(-1)?.close, 180);
  datafeed.destroy();
});


test('terminal monthly boundary answers older requests with noData and zero additional HTTP', async () => {
  const apiCalls: KlineRequest[] = [];
  const currentBars = utcBoundaryPageEndingAt(
    '1M',
    Date.parse('2026-07-01T00:00:00.000Z'),
    40,
    '185',
  );
  const terminalBoundary = currentBars[0].open_time;
  requestKlines = async (params) => {
    apiCalls.push(params);
    if (apiCalls.length === 1) return metadata(currentBars);
    if (apiCalls.length === 2) {
      return metadata([], {
        history_complete: true,
        has_more_before: false,
      });
    }
    assert.fail(`unexpected request past terminal boundary ${apiCalls.length}`);
  };
  const historyCalls: HistoryCall[] = [];
  const datafeed = datafeedModule.createContractTradingViewDatafeed({
    symbol: 'MONTHLY_TERMINAL_BOUNDARY_PERP',
  });

  await datafeed.getBars(
    symbolInfo('MONTHLY_TERMINAL_BOUNDARY_PERP'),
    '1M',
    { ...period, countBack: 60 },
    (bars: any[], meta: { noData?: boolean }) => historyCalls.push({ bars, meta }),
    assert.fail,
  );
  const httpCallsAtTerminal = apiCalls.length;
  await datafeed.getBars(
    symbolInfo('MONTHLY_TERMINAL_BOUNDARY_PERP'),
    '1M',
    {
      ...period,
      firstDataRequest: false,
      countBack: 60,
      to: terminalBoundary / 1000,
    },
    (bars: any[], meta: { noData?: boolean }) => historyCalls.push({ bars, meta }),
    assert.fail,
  );

  assert.equal(httpCallsAtTerminal, 2);
  assert.equal(apiCalls.length, httpCallsAtTerminal);
  assert.equal(historyCalls[0].bars.length, 40);
  assert.deepEqual(historyCalls[1], { bars: [], meta: { noData: true } });
  datafeed.destroy();
});


test('1M valid history converts later provider EMPTY into terminal noData per symbol', async () => {
  const symbols = ['BTCUSDT_PERP', 'ETHUSDT_PERP'];
  const currentBarsBySymbol = new Map([
    ['BTCUSDT_PERP', utcBoundaryPageEndingAt(
      '1M',
      Date.parse('2026-07-01T00:00:00.000Z'),
      3,
      '100',
    )],
    ['ETHUSDT_PERP', utcBoundaryPageEndingAt(
      '1M',
      Date.parse('2026-07-01T00:00:00.000Z'),
      2,
      '200',
    )],
  ]);
  const baselineServed = new Set<string>();
  const apiCalls: KlineRequest[] = [];
  requestKlines = async (params) => {
    apiCalls.push(params);
    if (!baselineServed.has(params.symbol)) {
      baselineServed.add(params.symbol);
      return metadata(currentBarsBySymbol.get(params.symbol) || []);
    }
    return metadata([], {
      history_incomplete: true,
      history_complete: false,
      provider_error_code: 'EMPTY',
      retryable: true,
    });
  };
  const historyBySymbol = new Map<string, HistoryCall[]>();
  const errors: string[] = [];
  const datafeed = datafeedModule.createContractTradingViewDatafeed({ symbol: symbols[0] });

  for (const symbol of symbols) {
    const calls: HistoryCall[] = [];
    historyBySymbol.set(symbol, calls);
    const earliestBarTime = currentBarsBySymbol.get(symbol)?.[0].open_time;
    assert.ok(earliestBarTime);
    await datafeed.getBars(
      symbolInfo(symbol),
      '1M',
      { ...period, countBack: 60 },
      (bars: any[], meta: { noData?: boolean }) => calls.push({ bars, meta }),
      (reason: string) => errors.push(reason),
    );
    await datafeed.getBars(
      symbolInfo(symbol),
      '1M',
      {
        ...period,
        firstDataRequest: false,
        countBack: 60,
        to: earliestBarTime / 1000,
      },
      (bars: any[], meta: { noData?: boolean }) => calls.push({ bars, meta }),
      (reason: string) => errors.push(reason),
    );
    const requestsAtConfirmedTerminal = apiCalls.filter((call) => call.symbol === symbol).length;
    await datafeed.getBars(
      symbolInfo(symbol),
      '1M',
      {
        ...period,
        firstDataRequest: false,
        countBack: 60,
        to: earliestBarTime / 1000,
      },
      (bars: any[], meta: { noData?: boolean }) => calls.push({ bars, meta }),
      (reason: string) => errors.push(reason),
    );
    assert.equal(
      apiCalls.filter((call) => call.symbol === symbol).length,
      requestsAtConfirmedTerminal,
      `${symbol} confirmed terminal must be cached only inside its own scope`,
    );
  }

  assert.deepEqual(errors, []);
  assert.deepEqual(historyBySymbol.get('BTCUSDT_PERP')?.map((call) => call.bars.length), [3, 0, 0]);
  assert.deepEqual(historyBySymbol.get('ETHUSDT_PERP')?.map((call) => call.bars.length), [2, 0, 0]);
  assert.deepEqual(
    historyBySymbol.get('BTCUSDT_PERP')?.slice(1).map((call) => call.meta.noData),
    [true, true],
  );
  assert.deepEqual(
    historyBySymbol.get('ETHUSDT_PERP')?.slice(1).map((call) => call.meta.noData),
    [true, true],
  );
  assert.equal(apiCalls.filter((call) => call.symbol === 'BTCUSDT_PERP').length, 3);
  assert.equal(apiCalls.filter((call) => call.symbol === 'ETHUSDT_PERP').length, 3);
  datafeed.destroy();
});


test('1M provider EMPTY terminal state does not authorize 1m noData', async () => {
  const symbol = 'MONTHLY_MINUTE_ISOLATION_PERP';
  const currentBars = utcBoundaryPageEndingAt(
    '1M',
    Date.parse('2026-07-01T00:00:00.000Z'),
    60,
    '300',
  );
  let monthlyCalls = 0;
  requestKlines = async (params) => {
    if (params.interval === '1M' && monthlyCalls++ === 0) return metadata(currentBars);
    return metadata([], {
      history_incomplete: true,
      history_complete: false,
      provider_error_code: 'EMPTY',
      retryable: true,
    });
  };
  const monthlyHistory: HistoryCall[] = [];
  const minuteHistory: HistoryCall[] = [];
  const minuteErrors: string[] = [];
  const datafeed = datafeedModule.createContractTradingViewDatafeed({ symbol });
  const earliestBarTime = currentBars[0].open_time;

  await datafeed.getBars(
    symbolInfo(symbol),
    '1M',
    { ...period, countBack: 60 },
    (bars: any[], meta: { noData?: boolean }) => monthlyHistory.push({ bars, meta }),
    assert.fail,
  );
  await datafeed.getBars(
    symbolInfo(symbol),
    '1M',
    { ...period, firstDataRequest: false, countBack: 60, to: earliestBarTime / 1000 },
    (bars: any[], meta: { noData?: boolean }) => monthlyHistory.push({ bars, meta }),
    assert.fail,
  );
  await datafeed.getBars(
    symbolInfo(symbol),
    '1',
    { ...period, firstDataRequest: false, countBack: 60, to: earliestBarTime / 1000 },
    (bars: any[], meta: { noData?: boolean }) => minuteHistory.push({ bars, meta }),
    (reason: string) => minuteErrors.push(reason),
  );

  assert.equal(monthlyHistory[0].bars.length, 60);
  assert.deepEqual(monthlyHistory[1], { bars: [], meta: { noData: true } });
  assert.deepEqual(minuteHistory, []);
  assert.equal(minuteErrors.length, 1);
  assert.match(minuteErrors[0], /EMPTY/);
  datafeed.destroy();
});


test('first 1M provider EMPTY remains a history error', async () => {
  requestKlines = async () => metadata([], {
    history_incomplete: true,
    history_complete: false,
    provider_error_code: 'EMPTY',
    retryable: true,
  });
  const historyCalls: HistoryCall[] = [];
  const errors: string[] = [];
  const datafeed = datafeedModule.createContractTradingViewDatafeed({ symbol: 'MONTHLY_FIRST_EMPTY_PERP' });

  await datafeed.getBars(
    symbolInfo('MONTHLY_FIRST_EMPTY_PERP'),
    '1M',
    { ...period, countBack: 60 },
    (bars: any[], meta: { noData?: boolean }) => historyCalls.push({ bars, meta }),
    (reason: string) => errors.push(reason),
  );

  assert.deepEqual(historyCalls, []);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /EMPTY/);
  datafeed.destroy();
});


test('1M terminal candidate keeps timeout 503 and non-EMPTY provider failures closed', async () => {
  const cases = [
    {
      name: 'timeout',
      fail: async () => { throw new Error('Contract kline history chain timed out'); },
      expected: /timed out/,
    },
    {
      name: '503',
      fail: async () => { throw new Error('HTTP 503 provider unavailable'); },
      expected: /503/,
    },
    {
      name: 'provider',
      fail: async () => metadata([], {
        history_incomplete: true,
        history_complete: false,
        provider_error_code: 'UPSTREAM_FAILURE',
        retryable: true,
      }),
      expected: /UPSTREAM_FAILURE/,
    },
  ];

  for (const item of cases) {
    const symbol = `MONTHLY_${item.name.toUpperCase()}_PERP`;
    const currentBars = utcBoundaryPageEndingAt(
      '1M',
      Date.parse('2026-07-01T00:00:00.000Z'),
      60,
      '400',
    );
    let baselinePending = true;
    requestKlines = async () => {
      if (baselinePending) {
        baselinePending = false;
        return metadata(currentBars);
      }
      return item.fail();
    };
    const errors: string[] = [];
    const failedHistory: HistoryCall[] = [];
    const datafeed = datafeedModule.createContractTradingViewDatafeed({ symbol });
    await datafeed.getBars(
      symbolInfo(symbol),
      '1M',
      { ...period, countBack: 60 },
      () => undefined,
      assert.fail,
    );
    await datafeed.getBars(
      symbolInfo(symbol),
      '1M',
      {
        ...period,
        firstDataRequest: false,
        countBack: 60,
        to: currentBars[0].open_time / 1000,
      },
      (bars: any[], meta: { noData?: boolean }) => failedHistory.push({ bars, meta }),
      (reason: string) => errors.push(reason),
    );

    assert.deepEqual(failedHistory, [], `${item.name} must not become noData`);
    assert.equal(errors.length, 1);
    assert.match(errors[0], item.expected);
    datafeed.destroy();
  }
});


test('1M realtime updates after valid history and EMPTY terminal confirmation', async () => {
  const symbol = 'MONTHLY_HISTORY_READY_REALTIME_PERP';
  const currentBars = utcBoundaryPageEndingAt(
    '1M',
    Date.parse('2026-07-01T00:00:00.000Z'),
    60,
    '500',
  );
  let baselinePending = true;
  requestKlines = async () => {
    if (baselinePending) {
      baselinePending = false;
      return metadata(currentBars);
    }
    return metadata([], {
      history_incomplete: true,
      history_complete: false,
      provider_error_code: 'EMPTY',
      retryable: true,
    });
  };
  const historyCalls: HistoryCall[] = [];
  const realtimeBars: any[] = [];
  const datafeed = datafeedModule.createContractTradingViewDatafeed({ symbol });

  await datafeed.getBars(
    symbolInfo(symbol),
    '1M',
    { ...period, countBack: 60 },
    (bars: any[], meta: { noData?: boolean }) => historyCalls.push({ bars, meta }),
    assert.fail,
  );
  await datafeed.getBars(
    symbolInfo(symbol),
    '1M',
    {
      ...period,
      firstDataRequest: false,
      countBack: 60,
      to: currentBars[0].open_time / 1000,
    },
    (bars: any[], meta: { noData?: boolean }) => historyCalls.push({ bars, meta }),
    assert.fail,
  );
  datafeed.subscribeBars(
    symbolInfo(symbol),
    '1M',
    (bar: any) => realtimeBars.push(bar),
    'monthly-history-ready',
  );
  emitRealtime(realtimeCandle(
    symbol,
    '1M',
    Date.parse('2026-08-01T00:00:00.000Z'),
    '501',
  ));

  assert.deepEqual(historyCalls.map((call) => call.bars.length), [60, 0]);
  assert.equal(historyCalls[1].meta.noData, true);
  assert.equal(realtimeBars.length, 1);
  assert.equal(realtimeBars[0].close, 501);
  assert.equal(realtimeKlineSubscriptions.at(-1)?.interval, '1M');
  datafeed.unsubscribeBars('monthly-history-ready');
  datafeed.destroy();
});


test('settled coverage remains isolated across sequential 5m to 1M to 5m generations', async () => {
  let now = 0;
  currentCacheModule.contractKlineCurrentCache.now = () => now;
  const apiCalls: KlineRequest[] = [];
  requestKlines = async (params) => {
    apiCalls.push(params);
    if (apiCalls.length === 1) {
      return metadata(pageEndingAt(1_719_000_000_000, 75, '105'));
    }
    if (apiCalls.length === 2) {
      return metadata(utcBoundaryPageEndingAt(
        '1M',
        Date.parse('2026-07-01T00:00:00.000Z'),
        60,
        '1000',
      ));
    }
    if (apiCalls.length === 3) {
      return metadata(pageEndingAt(1_719_200_000_000, 75, '155'));
    }
    assert.fail(`unexpected generation request ${apiCalls.length}`);
  };
  const historyCalls: HistoryCall[] = [];
  const datafeed = datafeedModule.createContractTradingViewDatafeed({
    symbol: 'COVERAGE_GENERATION_ISOLATION_PERP',
    category: 'CRYPTO',
  });
  const request = async (resolution: string) => datafeed.getBars(
    symbolInfo('COVERAGE_GENERATION_ISOLATION_PERP'),
    resolution,
    { ...period, countBack: 60 },
    (bars: any[], meta: { noData?: boolean }) => historyCalls.push({ bars, meta }),
    assert.fail,
  );

  await request('5');
  await request('1M');
  now = 10_000;
  await request('5');

  assert.deepEqual(apiCalls.map((call) => call.interval), ['5m', '1M', '5m']);
  assert.deepEqual(historyCalls.map((call) => call.bars.at(-1)?.close), [105, 1000, 155]);
  assert.ok(historyCalls.every((call) => call.meta.noData === false));
  datafeed.destroy();
});


test('countBack keeps bars before from while excluding candles at or after to', async () => {
  const pending = deferred<KlineMetadata>();
  let apiCalls = 0;
  requestKlines = async () => {
    apiCalls += 1;
    return pending.promise;
  };
  const validBars = pageEndingAt(1_800_000_000_000, 100, '1');
  const toTimeMs = 2_000_000_000_000;
  const historyCalls: HistoryCall[] = [];
  const datafeed = datafeedModule.createContractTradingViewDatafeed({ symbol: 'FROM_COUNTBACK_PERP' });
  const request = datafeed.getBars(
    symbolInfo('FROM_COUNTBACK_PERP'),
    '1',
    {
      from: 1_900_000_000,
      to: 2_000_000_000,
      firstDataRequest: true,
      countBack: 100,
    },
    (bars: any[], meta: { noData?: boolean }) => historyCalls.push({ bars, meta }),
    assert.fail,
  );

  pending.resolve(metadata([
    ...validBars,
    row(toTimeMs, '9'),
    row(toTimeMs + 60_000, '10'),
  ]));
  await request;

  assert.equal(apiCalls, 1);
  assert.equal(historyCalls[0].bars.length, 100);
  assert.ok(historyCalls[0].bars.every((bar) => bar.time < 1_900_000_000_000));
  assert.ok(historyCalls[0].bars.every((bar) => bar.time < toTimeMs));
  datafeed.destroy();
});


test('superseded first page does not schedule an old second page', async () => {
  const pending: Array<Deferred<KlineMetadata>> = [];
  const calls: KlineRequest[] = [];
  requestKlines = async (params) => {
    calls.push(params);
    const request = deferred<KlineMetadata>();
    pending.push(request);
    return request.promise;
  };
  const oldHistory: HistoryCall[] = [];
  const newHistory: HistoryCall[] = [];
  const latest: Array<string | null> = [];
  const datafeed = datafeedModule.createContractTradingViewDatafeed({
    symbol: 'SUPERSEDE_PAGE_PERP',
    onLatestBar: (close: string | null) => latest.push(close),
  });
  const oldRequest = datafeed.getBars(
    symbolInfo('SUPERSEDE_OLD_PERP'),
    '1',
    { ...period, countBack: 500 },
    (bars: any[], meta: { noData?: boolean }) => oldHistory.push({ bars, meta }),
    assert.fail,
  );
  const newRequest = datafeed.getBars(
    symbolInfo('SUPERSEDE_NEW_PERP'),
    '1',
    { ...period, countBack: 500 },
    (bars: any[], meta: { noData?: boolean }) => newHistory.push({ bars, meta }),
    assert.fail,
  );

  await Promise.resolve();
  assert.equal(oldHistory.length, 1);
  pending[0].resolve(metadata(pageEndingAt(1_700_000_000_000, 100, '1')));
  await oldRequest;
  assert.equal(calls.length, 2, 'superseded first page must not schedule page two');

  pending[1].resolve(metadata(pageEndingAt(1_800_000_000_000, 500, '9')));
  await newRequest;
  assert.equal(oldHistory.length, 1);
  assert.equal(newHistory.length, 1);
  assert.equal(newHistory[0].bars.length, 500);
  assert.deepEqual(latest, ['9']);
  datafeed.destroy();
});


test('superseding while page two waits prevents old state updates and page three', async () => {
  const pending: Array<Deferred<KlineMetadata>> = [];
  const calls: KlineRequest[] = [];
  requestKlines = async (params) => {
    calls.push(params);
    const request = deferred<KlineMetadata>();
    pending.push(request);
    return request.promise;
  };
  const oldHistory: HistoryCall[] = [];
  const newHistory: HistoryCall[] = [];
  const latest: Array<string | null> = [];
  const datafeed = datafeedModule.createContractTradingViewDatafeed({
    symbol: 'SUPERSEDE_SECOND_PAGE_PERP',
    onLatestBar: (close: string | null) => latest.push(close),
  });
  const oldRequest = datafeed.getBars(
    symbolInfo('SUPERSEDE_SECOND_PAGE_PERP'),
    '1',
    { ...period, countBack: 500 },
    (bars: any[], meta: { noData?: boolean }) => oldHistory.push({ bars, meta }),
    assert.fail,
  );
  pending[0].resolve(metadata(pageEndingAt(1_700_100_000_000, 100, '1')));
  await waitFor(() => pending.length === 2, 'old second page was not requested');

  const newRequest = datafeed.getBars(
    symbolInfo('SUPERSEDE_REPLACEMENT_PERP'),
    '1',
    { ...period, countBack: 500 },
    (bars: any[], meta: { noData?: boolean }) => newHistory.push({ bars, meta }),
    assert.fail,
  );
  await Promise.resolve();
  assert.equal(oldHistory.length, 1);
  assert.equal(pending.length, 3);

  pending[1].resolve(metadata(pageEndingAt(1_700_000_000_000, 100, '2')));
  await oldRequest;
  assert.equal(calls.length, 3, 'superseded page two must not schedule page three');
  assert.deepEqual(latest, []);

  pending[2].resolve(metadata(pageEndingAt(1_800_000_000_000, 500, '9')));
  await newRequest;
  assert.equal(oldHistory.length, 1);
  assert.equal(newHistory.length, 1);
  assert.deepEqual(latest, ['9']);
  datafeed.destroy();
});


test('destroy during shared pagination leaves the other datafeed flow intact', async () => {
  const pending: Array<Deferred<KlineMetadata>> = [];
  const calls: KlineRequest[] = [];
  requestKlines = async (params) => {
    calls.push(params);
    const request = deferred<KlineMetadata>();
    pending.push(request);
    return request.promise;
  };
  const oldest = 1_700_000_000_000;
  const step = 60_000;
  let destroyedHistoryCalls = 0;
  const liveHistory: HistoryCall[] = [];
  const destroyed = datafeedModule.createContractTradingViewDatafeed({ symbol: 'DESTROY_PAGING_PERP' });
  const live = datafeedModule.createContractTradingViewDatafeed({ symbol: 'DESTROY_PAGING_PERP' });

  const destroyedRequest = destroyed.getBars(
    symbolInfo('DESTROY_PAGING_PERP'),
    '1',
    { ...period, firstDataRequest: false, countBack: 500 },
    () => { destroyedHistoryCalls += 1; },
    assert.fail,
  );
  const liveRequest = live.getBars(
    symbolInfo('DESTROY_PAGING_PERP'),
    '1',
    { ...period, firstDataRequest: false, countBack: 500 },
    (bars: any[], meta: { noData?: boolean }) => liveHistory.push({ bars, meta }),
    assert.fail,
  );
  assert.equal(calls.length, 1);

  pending[0].resolve(metadata(pageEndingAt(oldest + (499 * step), 100, '3')));
  await waitFor(() => pending.length === 2, 'shared second page missing');
  destroyed.destroy();
  pending[1].resolve(metadata(pageEndingAt(oldest + (399 * step), 200, '2')));
  await waitFor(() => pending.length === 3, 'live third page missing after peer destroy');
  pending[2].resolve(metadata(pageEndingAt(oldest + (199 * step), 200, '1')));
  await Promise.all([destroyedRequest, liveRequest]);

  assert.equal(calls.length, 3);
  assert.equal(destroyedHistoryCalls, 0);
  assert.equal(liveHistory.length, 1);
  assert.equal(liveHistory[0].bars.length, 500);
  assert.equal(liveHistory[0].meta.noData, false);
  live.destroy();
});


test('concurrent identical multi-page flows share every HTTP page', async () => {
  const pending: Array<Deferred<KlineMetadata>> = [];
  const calls: KlineRequest[] = [];
  requestKlines = async (params) => {
    calls.push(params);
    const request = deferred<KlineMetadata>();
    pending.push(request);
    return request.promise;
  };
  const oldest = 1_700_000_000_000;
  const step = 60_000;
  const firstHistory: HistoryCall[] = [];
  const secondHistory: HistoryCall[] = [];
  const firstLoading: any[] = [];
  const secondLoading: any[] = [];
  const first = datafeedModule.createContractTradingViewDatafeed({
    symbol: 'SHARED_PAGES_PERP',
    onHistoryBars: (event: unknown) => firstLoading.push(event),
  });
  const second = datafeedModule.createContractTradingViewDatafeed({
    symbol: 'SHARED_PAGES_PERP',
    onHistoryBars: (event: unknown) => secondLoading.push(event),
  });
  const firstRequest = first.getBars(
    symbolInfo('SHARED_PAGES_PERP'),
    '1',
    { ...period, firstDataRequest: false, countBack: 500 },
    (bars: any[], meta: { noData?: boolean }) => firstHistory.push({ bars, meta }),
    assert.fail,
  );
  const secondRequest = second.getBars(
    symbolInfo('SHARED_PAGES_PERP'),
    '1',
    { ...period, firstDataRequest: false, countBack: 500 },
    (bars: any[], meta: { noData?: boolean }) => secondHistory.push({ bars, meta }),
    assert.fail,
  );
  assert.equal(calls.length, 1);

  pending[0].resolve(metadata(pageEndingAt(oldest + (499 * step), 200, '3')));
  await waitFor(() => pending.length === 2, 'concurrent shared second page missing');
  assert.equal(calls.length, 2);
  pending[1].resolve(metadata(pageEndingAt(oldest + (299 * step), 200, '2')));
  await waitFor(() => pending.length === 3, 'concurrent shared third page missing');
  assert.equal(calls.length, 3);
  pending[2].resolve(metadata(pageEndingAt(oldest + (99 * step), 100, '1')));
  await Promise.all([firstRequest, secondRequest]);

  assert.equal(calls.length, 3);
  assert.equal(firstHistory.length, 1);
  assert.equal(secondHistory.length, 1);
  assert.equal(firstHistory[0].bars.length, 500);
  assert.deepEqual(firstHistory[0].bars, secondHistory[0].bars);
  assert.equal(firstLoading.length, 1);
  assert.equal(secondLoading.length, 1);
  first.destroy();
  second.destroy();
});


test('interval switch drops the late response from the previous interval', async () => {
  const pending: Array<Deferred<KlineMetadata>> = [];
  const calls: KlineRequest[] = [];
  requestKlines = async (params) => {
    calls.push(params);
    const request = deferred<KlineMetadata>();
    pending.push(request);
    return request.promise;
  };
  const oneMinuteCalls: HistoryCall[] = [];
  const fiveMinuteCalls: HistoryCall[] = [];
  let oneMinuteErrors = 0;
  let fiveMinuteErrors = 0;
  const latest: Array<string | null> = [];
  const datafeed = datafeedModule.createContractTradingViewDatafeed({
    symbol: 'BTCUSDT_PERP',
    onLatestBar: (close: string | null) => latest.push(close),
  });

  const oneMinuteRequest = datafeed.getBars(
    symbolInfo('BTCUSDT_PERP'),
    '1',
    period,
    (bars: any[], meta: { noData?: boolean }) => oneMinuteCalls.push({ bars, meta }),
    () => { oneMinuteErrors += 1; },
  );
  const fiveMinuteRequest = datafeed.getBars(
    symbolInfo('BTCUSDT_PERP'),
    '5',
    period,
    (bars: any[], meta: { noData?: boolean }) => fiveMinuteCalls.push({ bars, meta }),
    () => { fiveMinuteErrors += 1; },
  );

  await Promise.resolve();
  assert.equal(oneMinuteCalls.length, 1);
  assert.deepEqual(oneMinuteCalls[0].bars, []);
  assert.equal(oneMinuteCalls[0].meta.noData, false);
  assert.deepEqual(latest, []);

  pending[1].resolve(metadata(pageEndingAt(1_717_000_300_000, 100, '105')));
  await fiveMinuteRequest;
  pending[0].reject(new Error('late 1m failure'));
  await oneMinuteRequest;

  assert.deepEqual(calls.map((item) => item.interval), ['1m', '5m']);
  assert.equal(oneMinuteCalls.length, 1, 'late failure must not settle twice');
  assert.equal(fiveMinuteCalls.length, 1);
  assert.equal(fiveMinuteCalls[0].bars[0].close, 105);
  assert.equal(oneMinuteErrors, 0);
  assert.equal(fiveMinuteErrors, 0);
  assert.deepEqual(latest, ['105']);
});


test('symbol switch drops the late response from the previous symbol', async () => {
  const pending: Array<Deferred<KlineMetadata>> = [];
  const calls: KlineRequest[] = [];
  requestKlines = async (params) => {
    calls.push(params);
    const request = deferred<KlineMetadata>();
    pending.push(request);
    return request.promise;
  };
  const oldSymbolCalls: HistoryCall[] = [];
  const newSymbolCalls: HistoryCall[] = [];
  let oldSymbolErrors = 0;
  let newSymbolErrors = 0;
  const latest: Array<string | null> = [];
  const datafeed = datafeedModule.createContractTradingViewDatafeed({
    symbol: 'BTCUSDT_PERP',
    onLatestBar: (close: string | null) => latest.push(close),
  });

  const oldSymbolRequest = datafeed.getBars(
    symbolInfo('BTCUSDT_PERP'),
    '1',
    period,
    (bars: any[], meta: { noData?: boolean }) => oldSymbolCalls.push({ bars, meta }),
    () => { oldSymbolErrors += 1; },
  );
  const newSymbolRequest = datafeed.getBars(
    symbolInfo('ETHUSDT_PERP'),
    '1',
    period,
    (bars: any[], meta: { noData?: boolean }) => newSymbolCalls.push({ bars, meta }),
    () => { newSymbolErrors += 1; },
  );

  await Promise.resolve();
  assert.equal(oldSymbolCalls.length, 1);
  assert.deepEqual(oldSymbolCalls[0].bars, []);
  assert.equal(oldSymbolCalls[0].meta.noData, false);
  assert.deepEqual(latest, []);

  pending[1].resolve(metadata(pageEndingAt(1_717_000_060_000, 100, '202')));
  await newSymbolRequest;
  pending[0].resolve(metadata([row(1_717_000_000_000, '101')]));
  await oldSymbolRequest;

  assert.deepEqual(calls.map((item) => item.symbol), ['BTCUSDT_PERP', 'ETHUSDT_PERP']);
  assert.equal(oldSymbolCalls.length, 1, 'late old-symbol response must not settle twice');
  assert.equal(newSymbolCalls.length, 1);
  assert.equal(newSymbolCalls[0].bars[0].close, 202);
  assert.equal(oldSymbolErrors, 0);
  assert.equal(newSymbolErrors, 0);
  assert.deepEqual(latest, ['202']);
});


test('destroyed datafeed cancels scheduled stale settlement and ignores late responses', async () => {
  const pending: Array<Deferred<KlineMetadata>> = [];
  requestKlines = async () => {
    const request = deferred<KlineMetadata>();
    pending.push(request);
    return request.promise;
  };
  let historyCalls = 0;
  let errorCalls = 0;
  const historyEvents: any[] = [];
  const historyErrors: any[] = [];
  const latest: Array<string | null> = [];
  const datafeed = datafeedModule.createContractTradingViewDatafeed({
    symbol: 'BTCUSDT_PERP',
    onLatestBar: (close: string | null) => latest.push(close),
    onHistoryBars: (event: unknown) => historyEvents.push(event),
    onHistoryError: (event: unknown) => historyErrors.push(event),
  });

  const oldRequest = datafeed.getBars(
    symbolInfo('BTCUSDT_PERP'),
    '1',
    period,
    () => { historyCalls += 1; },
    () => { errorCalls += 1; },
  );
  const newRequest = datafeed.getBars(
    symbolInfo('BTCUSDT_PERP'),
    '5',
    period,
    () => { historyCalls += 1; },
    () => { errorCalls += 1; },
  );
  datafeed.destroy();
  await Promise.resolve();
  pending[0].resolve(metadata([row(1_717_000_000_000, '101')]));
  pending[1].reject(new Error('late destroyed request'));
  await Promise.all([oldRequest, newRequest]);

  assert.equal(historyCalls, 0);
  assert.equal(errorCalls, 0);
  assert.deepEqual(latest, []);
  assert.deepEqual(historyEvents, []);
  assert.deepEqual(historyErrors, []);
});


test('same datafeed rejects stale realtime bar and accepts equal or newer candles', async () => {
  const restTime = Date.parse('2026-07-10T08:02:00.000Z');
  requestKlines = async () => metadata([row(restTime, '1.14411')]);
  const latest: Array<string | null> = [];
  const realtimeBars: any[] = [];
  const datafeed = datafeedModule.createContractTradingViewDatafeed({
    symbol: 'EURUSD_MONO_PERP',
    onLatestBar: (close: string | null) => latest.push(close),
  });

  await datafeed.getBars(
    symbolInfo('EURUSD_MONO_PERP'),
    '1',
    period,
    () => undefined,
    assert.fail,
  );
  datafeed.subscribeBars(
    symbolInfo('EURUSD_MONO_PERP'),
    '1',
    (bar: any) => realtimeBars.push(bar),
    'mono-subscription',
  );

  emitRealtime(realtimeCandle('EURUSD_MONO_PERP', '1m', restTime - 60_000, '1.14393'));
  assert.equal(realtimeBars.length, 0);
  assert.deepEqual(latest, ['1.14411']);

  emitRealtime(realtimeCandle('EURUSD_MONO_PERP', '1m', restTime, '1.14412'));
  emitRealtime(realtimeCandle('EURUSD_MONO_PERP', '1m', restTime + 60_000, '1.14420'));
  emitRealtime(realtimeCandle('EURUSD_MONO_PERP', '1m', restTime, '1.14400'));

  assert.deepEqual(realtimeBars.map((bar) => bar.time), [restTime, restTime + 60_000]);
  assert.deepEqual(latest, ['1.14411', '1.14412', '1.1442']);
  datafeed.destroy();
});


test('destroy and rebuild reset high-water for the replacement datafeed', async () => {
  const restTime = Date.parse('2026-07-10T08:02:00.000Z');
  requestKlines = async () => metadata([row(restTime, '200')]);
  const first = datafeedModule.createContractTradingViewDatafeed({ symbol: 'REBUILD_MONO_PERP' });
  await first.getBars(
    symbolInfo('REBUILD_MONO_PERP'),
    '1',
    period,
    () => undefined,
    assert.fail,
  );
  first.destroy();

  const rebuiltRealtime: any[] = [];
  const rebuiltLatest: Array<string | null> = [];
  const rebuilt = datafeedModule.createContractTradingViewDatafeed({
    symbol: 'REBUILD_MONO_PERP',
    onLatestBar: (close: string | null) => rebuiltLatest.push(close),
  });
  await establishHistoryBaseline(rebuilt, 'REBUILD_MONO_PERP');
  rebuiltLatest.length = 0;
  rebuilt.subscribeBars(
    symbolInfo('REBUILD_MONO_PERP'),
    '1',
    (bar: any) => rebuiltRealtime.push(bar),
    'rebuilt-subscription',
  );
  emitRealtime(realtimeCandle('REBUILD_MONO_PERP', '1m', restTime - 60_000, '199'));

  assert.deepEqual(rebuiltRealtime.map((bar) => bar.close), [199]);
  assert.deepEqual(rebuiltLatest, ['199']);
  rebuilt.destroy();
});


test('BTC to ETH to BTC rebuild accepts the replacement BTC realtime candle', async () => {
  const priorBtcTime = Date.parse('2026-07-10T08:02:00.000Z');
  requestKlines = async () => metadata([row(priorBtcTime, '200')]);
  const firstBtc = datafeedModule.createContractTradingViewDatafeed({ symbol: 'BTCUSDT_PERP' });
  await firstBtc.getBars(
    symbolInfo('BTCUSDT_PERP'),
    '1',
    period,
    () => undefined,
    assert.fail,
  );
  firstBtc.destroy();

  const ethBars: any[] = [];
  const eth = datafeedModule.createContractTradingViewDatafeed({ symbol: 'ETHUSDT_PERP' });
  await establishHistoryBaseline(eth, 'ETHUSDT_PERP');
  eth.subscribeBars(
    symbolInfo('ETHUSDT_PERP'),
    '1',
    (bar: any) => ethBars.push(bar),
    'eth-replacement',
  );
  emitRealtime(realtimeCandle('ETHUSDT_PERP', '1m', priorBtcTime - 120_000, '101'));
  eth.destroy();

  const replacementBtcBars: any[] = [];
  const replacementBtc = datafeedModule.createContractTradingViewDatafeed({ symbol: 'BTCUSDT_PERP' });
  await establishHistoryBaseline(replacementBtc, 'BTCUSDT_PERP');
  replacementBtc.subscribeBars(
    symbolInfo('BTCUSDT_PERP'),
    '1',
    (bar: any) => replacementBtcBars.push(bar),
    'btc-replacement',
  );
  emitRealtime(realtimeCandle('BTCUSDT_PERP', '1m', priorBtcTime - 60_000, '199'));

  assert.deepEqual(ethBars.map((bar) => bar.close), [101]);
  assert.deepEqual(replacementBtcBars.map((bar) => bar.close), [199]);
  replacementBtc.destroy();
});


test('restored baseline reset requires a Runtime permit and a new subscription generation', async () => {
  const symbol = 'INTERVAL_LIFECYCLE_PERP';
  const minuteTime = Date.parse('2026-07-10T08:02:00.000Z');
  const dailyTime = Date.parse('2026-07-10T00:00:00.000Z');
  const minuteBars: any[] = [];
  const dailyBars: any[] = [];
  const restoredMinuteBars: any[] = [];
  const replacementMinuteBars: any[] = [];
  const resetRequirements: any[] = [];
  let resetCalls = 0;
  const datafeed = datafeedModule.createContractTradingViewDatafeed({
    symbol,
    onRealtimeResetRequired: (requirement: any) => resetRequirements.push(requirement),
  });

  await establishHistoryBaseline(datafeed, symbol, '1');

  datafeed.subscribeBars(
    symbolInfo(symbol),
    '1',
    (bar: any) => minuteBars.push(bar),
    'minute-initial',
  );
  emitRealtime(realtimeCandle(symbol, '1m', minuteTime, '100'));
  datafeed.unsubscribeBars('minute-initial');

  await establishHistoryBaseline(datafeed, symbol, '1D');
  datafeed.subscribeBars(
    symbolInfo(symbol),
    '1D',
    (bar: any) => dailyBars.push(bar),
    'daily-active',
  );
  emitRealtime(realtimeCandle(symbol, '1m', minuteTime + 60_000, '101'));
  emitRealtime(realtimeCandle(symbol, '1d', dailyTime, '90'));
  datafeed.unsubscribeBars('daily-active');

  requestKlines = async () => metadata([row(minuteTime + 60_000, '101')]);
  await datafeed.getBars(
    symbolInfo(symbol),
    '1',
    period,
    () => undefined,
    assert.fail,
  );

  datafeed.subscribeBars(
    symbolInfo(symbol),
    '1',
    (bar: any) => restoredMinuteBars.push(bar),
    'minute-restored',
    () => {
      resetCalls += 1;
      datafeed.unsubscribeBars('minute-restored');
    },
  );
  await flushPromises();

  assert.equal(resetCalls, 0, 'Datafeed must not approve or execute its own reset');
  assert.equal(resetRequirements.length, 1);
  const requirement = resetRequirements[0];
  assert.equal(requirement.source, 'RESTORED_BASELINE');
  assert.equal(
    datafeed.getRealtimeSubscriptionReadiness(symbol, '1m'),
    null,
    'the restored generation cannot prove subscriber readiness before a Runtime permit',
  );
  const identity = {
    sessionId: `CONTRACT:7:${datafeed.getDatafeedInstanceId()}:3`,
    terminalType: 'CONTRACT',
    widgetGeneration: 7,
    datafeedInstanceId: datafeed.getDatafeedInstanceId(),
    intentId: 3,
    symbol,
    tradingViewResolution: '1',
    backendInterval: '1m',
  };
  const permit = {
    permitId: `${identity.sessionId}:RESTORED_BASELINE`,
    identity,
    source: 'RESTORED_BASELINE',
  };
  assert.equal(datafeed.executeResetPermit(requirement, permit), true);
  assert.equal(datafeed.executeResetPermit(requirement, permit), false, 'one permit executes once');
  assert.equal(resetCalls, 1, 'the permitted reset executes exactly once');
  assert.deepEqual(realtimeKlineOwnerCalls, [
    { op: 'subscribe', symbol, interval: '1m' },
    { op: 'unsubscribe', symbol, interval: '1m' },
    { op: 'subscribe', symbol, interval: '1d' },
    { op: 'unsubscribe', symbol, interval: '1d' },
    { op: 'subscribe', symbol, interval: '1m' },
  ], 'reset-triggered unsubscribe remains guarded until TradingView rearms');

  assert.equal(
    datafeed.getRealtimeSubscriptionReadiness(symbol, '1m'),
    null,
    'the reset generation remains blocked until subscribeBars creates a new generation',
  );
  await establishHistoryBaseline(datafeed, symbol, '1');
  datafeed.subscribeBars(
    symbolInfo(symbol),
    '1',
    (bar: any) => replacementMinuteBars.push(bar),
    'minute-restored',
    () => assert.fail('the replacement generation must not consume another reset'),
  );
  const replacementReadiness = datafeed.getRealtimeSubscriptionReadiness(symbol, '1m');
  assert.ok(
    replacementReadiness?.subscriptionGeneration > requirement.subscriptionGeneration,
    'commit evidence must come from the replacement subscription generation',
  );

  emitRealtime(realtimeCandle(symbol, '1d', dailyTime + 86_400_000, '91'));
  emitRealtime(realtimeCandle(symbol, '1m', minuteTime - 60_000, '99'));
  emitRealtime(realtimeCandle(symbol, '1m', minuteTime + 120_000, '102'));

  assert.deepEqual(minuteBars.map((bar) => bar.close), [100]);
  assert.deepEqual(dailyBars.map((bar) => bar.close), [90]);
  assert.deepEqual(restoredMinuteBars, []);
  assert.deepEqual(replacementMinuteBars.map((bar) => bar.close), [102]);

  datafeed.unsubscribeBars('minute-restored');
  assert.deepEqual(realtimeKlineOwnerCalls.at(-1), {
    op: 'unsubscribe',
    symbol,
    interval: '1m',
  }, 'a later lifecycle unsubscribe must still release the protected owner');
  datafeed.destroy();
});


test('realtime readiness identifies only the latest active symbol interval subscription', async () => {
  const symbol = 'BTCUSDT_PERP';
  const readinessEvents: any[] = [];
  const datafeed = datafeedModule.createContractTradingViewDatafeed({
    symbol,
    onRealtimeSubscriptionReady: (evidence: any) => readinessEvents.push(evidence),
  });

  assert.equal(datafeed.getRealtimeSubscriptionReadiness(symbol, '1m'), null);
  datafeed.subscribeBars(
    symbolInfo(symbol),
    '1',
    () => undefined,
    'minute-readiness',
  );
  const minuteReadiness = datafeed.getRealtimeSubscriptionReadiness(symbol, '1m');
  assert.equal(minuteReadiness?.datafeedInstanceId, datafeed.getDatafeedInstanceId());
  assert.equal(minuteReadiness?.symbol, symbol);
  assert.equal(minuteReadiness?.interval, '1m');
  assert.equal(minuteReadiness?.subscriberUid, 'minute-readiness');
  assert.ok(minuteReadiness?.ownerId);
  assert.equal(minuteReadiness?.subscriptionGeneration, 1);
  assert.equal(minuteReadiness?.generation, 1);

  datafeed.subscribeBars(
    symbolInfo(symbol),
    '1D',
    () => undefined,
    'daily-readiness',
  );
  assert.equal(
    datafeed.getRealtimeSubscriptionReadiness(symbol, '1m'),
    null,
    'a previous interval cannot prove readiness after the latest interval changes',
  );
  assert.equal(
    datafeed.getRealtimeSubscriptionReadiness(symbol, '1d')?.subscriberUid,
    'daily-readiness',
  );
  await flushPromises();
  assert.deepEqual(
    readinessEvents.map((event) => [
      event.datafeedInstanceId,
      event.interval,
      event.subscriberUid,
      event.subscriptionGeneration,
      event.generation,
    ]),
    [[datafeed.getDatafeedInstanceId(), '1d', 'daily-readiness', 2, 2]],
    'superseded readiness callbacks must not publish stale interval evidence',
  );

  datafeed.subscribeBars(
    symbolInfo(symbol),
    '1D',
    () => undefined,
    'daily-readiness-replacement',
  );
  assert.equal(
    datafeed.getRealtimeSubscriptionReadiness(symbol, '1d')?.generation,
    3,
  );
  datafeed.unsubscribeBars('daily-readiness-replacement');
  assert.equal(
    datafeed.getRealtimeSubscriptionReadiness(symbol, '1d'),
    null,
    'removing the latest generation must not expose an older callback as ready',
  );
  datafeed.destroy();
  assert.equal(datafeed.getRealtimeSubscriptionReadiness(symbol, '1d'), null);
});


test('BTC to ETH does not reset an unrelated symbol baseline', async () => {
  let resetCalls = 0;
  const datafeed = datafeedModule.createContractTradingViewDatafeed({ symbol: 'BTCUSDT_PERP' });

  datafeed.subscribeBars(
    symbolInfo('BTCUSDT_PERP'),
    '1',
    () => undefined,
    'btc-minute',
    () => { resetCalls += 1; },
  );
  datafeed.unsubscribeBars('btc-minute');
  datafeed.subscribeBars(
    symbolInfo('ETHUSDT_PERP'),
    '1',
    () => undefined,
    'eth-minute',
    () => { resetCalls += 1; },
  );
  await Promise.resolve();

  assert.equal(resetCalls, 0);
  datafeed.destroy();
});


test('high-water marks isolate symbol and interval while preserving 1M case', async () => {
  const highTime = Date.parse('2026-07-10T08:02:00.000Z');
  const lowerTime = highTime - 60_000;
  const monthlyTime = Date.parse('2026-07-01T00:00:00.000Z');
  requestKlines = async () => metadata([row(highTime, '300')]);
  const seeded = datafeedModule.createContractTradingViewDatafeed({ symbol: 'ISOLATION_A_PERP' });
  await seeded.getBars(
    symbolInfo('ISOLATION_A_PERP'),
    '1',
    period,
    () => undefined,
    assert.fail,
  );

  const otherSymbolBars: any[] = [];
  const fiveMinuteBars: any[] = [];
  const monthlyBars: any[] = [];
  const otherSymbol = datafeedModule.createContractTradingViewDatafeed({ symbol: 'ISOLATION_B_PERP' });
  await establishHistoryBaseline(otherSymbol, 'ISOLATION_B_PERP', '1');
  await establishHistoryBaseline(seeded, 'ISOLATION_A_PERP', '5');
  await establishHistoryBaseline(seeded, 'ISOLATION_A_PERP', '1M');
  otherSymbol.subscribeBars(
    symbolInfo('ISOLATION_B_PERP'),
    '1',
    (bar: any) => otherSymbolBars.push(bar),
    'other-symbol',
  );
  seeded.subscribeBars(
    symbolInfo('ISOLATION_A_PERP'),
    '5',
    (bar: any) => fiveMinuteBars.push(bar),
    'five-minute',
  );
  emitRealtime(realtimeCandle('ISOLATION_A_PERP', '5m', lowerTime, '302'));
  seeded.subscribeBars(
    symbolInfo('ISOLATION_A_PERP'),
    '1M',
    (bar: any) => monthlyBars.push(bar),
    'monthly',
  );

  emitRealtime(realtimeCandle('ISOLATION_B_PERP', '1m', lowerTime, '301'));
  emitRealtime(realtimeCandle('ISOLATION_A_PERP', '5m', highTime, '304'));
  emitRealtime(realtimeCandle('ISOLATION_A_PERP', '1M', monthlyTime, '303'));

  assert.deepEqual(otherSymbolBars.map((bar) => bar.time), [lowerTime]);
  assert.deepEqual(fiveMinuteBars.map((bar) => bar.time), [lowerTime]);
  assert.deepEqual(monthlyBars.map((bar) => bar.time), [monthlyTime]);
  otherSymbol.destroy();
  seeded.destroy();
});


test('Store kline is primary and non-kline domains or same-candle legacy fallback cannot overwrite it', async () => {
  const symbol = 'STORE_PRIMARY_PERP';
  const openTime = 1_717_100_000_000;
  const received: any[] = [];
  marketStoreModule.contractMarketStore.activateSymbol(symbol);
  const datafeed = datafeedModule.createContractTradingViewDatafeed({ symbol });
  await establishHistoryBaseline(datafeed, symbol);
  datafeed.subscribeBars(
    symbolInfo(symbol),
    '1',
    (bar: any) => received.push(bar),
    'store-primary-subscriber',
  );

  ingestStoreKline({ symbol, interval: '1m', openTime, close: '101' });
  marketStoreModule.contractMarketStore.ingest({
    symbol,
    domain: 'ticker',
    data: { display_price: '999', last_price: '999' },
    transport: 'WS',
    eventTimeMs: openTime + 1,
  });
  marketStoreModule.contractMarketStore.ingest({
    symbol,
    domain: 'depth',
    data: { bids: [['998', '1']], asks: [['1000', '1']] },
    transport: 'WS',
    eventTimeMs: openTime + 1,
  });
  emitRealtime(realtimeCandle(symbol, '1m', openTime, '999'));
  ingestStoreKline({
    symbol,
    interval: '1m',
    openTime,
    close: '102',
    eventTimeMs: openTime + 2,
  });

  assert.deepEqual(received.map((bar) => bar.close), [101, 102]);
  datafeed.destroy();
});


test('Store realtime revisions publish close and volume from the same candle evidence', async () => {
  const symbol = 'STORE_OHLCV_PERP';
  const openTime = 1_717_100_000_000;
  const received: any[] = [];
  marketStoreModule.contractMarketStore.activateSymbol(symbol);
  const datafeed = datafeedModule.createContractTradingViewDatafeed({ symbol });
  await establishHistoryBaseline(datafeed, symbol);
  datafeed.subscribeBars(
    symbolInfo(symbol),
    '1',
    (bar: any) => received.push(bar),
    'store-ohlcv-subscriber',
  );

  ingestStoreKline({
    symbol,
    interval: '1m',
    openTime,
    close: '101',
    volume: '5',
    eventTimeMs: openTime + 1,
  });
  ingestStoreKline({
    symbol,
    interval: '1m',
    openTime,
    close: '102',
    volume: '8',
    eventTimeMs: openTime + 2,
  });

  assert.deepEqual(
    received.map((bar) => ({ close: bar.close, volume: bar.volume })),
    [
      { close: 101, volume: 5 },
      { close: 102, volume: 8 },
    ],
  );
  datafeed.destroy();
});


test('new kline bucket accepts a reset revision sequence', () => {
  const accepts = datafeedModule.acceptsKlineVersion;
  const oldBucket = Date.parse('2026-07-14T14:35:00.000Z');
  const newBucket = Date.parse('2026-07-14T14:46:00.000Z');
  const current = klineVersionCursor({ bucketTimeMs: oldBucket, sequence: 1396 });

  assert.equal(
    accepts(current, klineVersionCursor({ bucketTimeMs: newBucket, sequence: 1 })),
    true,
  );
  assert.equal(
    accepts(current, klineVersionCursor({ bucketTimeMs: newBucket, sequence: 220 })),
    true,
  );
});


test('same kline bucket accepts a monotonic revision increase', () => {
  const bucket = Date.parse('2026-07-14T14:46:00.000Z');

  assert.equal(
    datafeedModule.acceptsKlineVersion(
      klineVersionCursor({ bucketTimeMs: bucket, sequence: 220 }),
      klineVersionCursor({ bucketTimeMs: bucket, sequence: 221 }),
    ),
    true,
  );
});


test('same kline bucket rejects revision rollback', () => {
  const bucket = Date.parse('2026-07-14T14:46:00.000Z');

  assert.equal(
    datafeedModule.acceptsKlineVersion(
      klineVersionCursor({ bucketTimeMs: bucket, sequence: 220 }),
      klineVersionCursor({ bucketTimeMs: bucket, sequence: 219, observedAtMs: bucket + 1_000 }),
    ),
    false,
  );
});


test('late old kline bucket cannot overwrite the current bucket with a higher revision', () => {
  const oldBucket = Date.parse('2026-07-14T14:35:00.000Z');
  const currentBucket = Date.parse('2026-07-14T14:46:00.000Z');

  assert.equal(
    datafeedModule.acceptsKlineVersion(
      klineVersionCursor({ bucketTimeMs: currentBucket, sequence: 5 }),
      klineVersionCursor({
        bucketTimeMs: oldBucket,
        sequence: 9999,
        observedAtMs: currentBucket + 1_000,
      }),
    ),
    false,
  );
});


test('missing bucket identity keeps conservative legacy revision ordering', () => {
  const oldBucket = Date.parse('2026-07-14T14:35:00.000Z');
  const newBucket = Date.parse('2026-07-14T14:46:00.000Z');

  assert.equal(
    datafeedModule.acceptsKlineVersion(
      klineVersionCursor({ bucketTimeMs: null, sequence: 1396, observedAtMs: oldBucket }),
      klineVersionCursor({ bucketTimeMs: newBucket, sequence: 220 }),
    ),
    false,
  );
});


test('runtime high-revision baseline accepts a lower revision from the next bucket', async () => {
  const symbol = 'BTCUSDT_PERP';
  const oldBucket = Date.parse('2026-07-14T14:35:00.000Z');
  const newBucket = Date.parse('2026-07-14T14:46:00.000Z');
  const received: any[] = [];
  const latest: Array<string | null> = [];
  const datafeed = datafeedModule.createContractTradingViewDatafeed({
    symbol,
    onLatestBar: (close: string | null) => latest.push(close),
  });
  marketStoreModule.contractMarketStore.activateSymbol(symbol);
  await establishHistoryBaseline(datafeed, symbol);
  latest.length = 0;
  datafeed.subscribeBars(
    symbolInfo(symbol),
    '1',
    (bar: any) => received.push(bar),
    'runtime-bucket-subscriber',
  );
  ingestStoreKline({
    symbol,
    interval: '1m',
    openTime: oldBucket,
    close: '63853.0',
    eventTimeMs: oldBucket + 59_000,
    sequence: 1396,
  });
  const versionedCandle = (openTime: number, close: string, sequence: number) => ({
    ...realtimeCandle(symbol, '1m', openTime, close),
    revision: { sequence },
    provider_event_time_ms: openTime + sequence,
  });

  emitRealtime(versionedCandle(newBucket, '63833.9', 220));
  emitRealtime(versionedCandle(newBucket, '63832.0', 219));
  const advanced = versionedCandle(newBucket, '63834.0', 221);
  emitRealtime(advanced);
  emitRealtime(advanced);
  emitRealtime(versionedCandle(oldBucket, '63999.0', 9999));

  assert.deepEqual(
    received.map((bar) => [bar.time, bar.close]),
    [
      [oldBucket, 63853],
      [newBucket, 63833.9],
      [newBucket, 63834],
    ],
  );
  assert.deepEqual(latest, ['63853', '63833.9', '63834']);
  datafeed.destroy();
});


test('new bucket from a retired subscription generation remains rejected', async () => {
  const symbol = 'RETIRED_BUCKET_PERP';
  const retiredBars: any[] = [];
  const activeBars: any[] = [];
  const datafeed = datafeedModule.createContractTradingViewDatafeed({ symbol });
  await establishHistoryBaseline(datafeed, symbol);
  datafeed.subscribeBars(
    symbolInfo(symbol),
    '1',
    (bar: any) => retiredBars.push(bar),
    'shared-bucket-subscriber',
  );
  const retiredHandler = realtimeKlineSubscriptions[0].handler;
  datafeed.subscribeBars(
    symbolInfo(symbol),
    '1',
    (bar: any) => activeBars.push(bar),
    'shared-bucket-subscriber',
  );
  const activeHandler = realtimeKlineSubscriptions[1].handler;
  const newBucket = Date.parse('2026-07-14T14:46:00.000Z');
  const message = {
    ...realtimeCandle(symbol, '1m', newBucket, '701'),
    revision: { sequence: 1 },
  };

  retiredHandler(message);
  activeHandler(message);

  assert.deepEqual(retiredBars, []);
  assert.deepEqual(activeBars.map((bar) => bar.close), [701]);
  datafeed.destroy();
});


test('legacy kline fallback rejects provider generation and revision rollback', async () => {
  const symbol = 'LEGACY_VERSION_PERP';
  const bucket = 1_717_100_000_000;
  const received: any[] = [];
  const datafeed = datafeedModule.createContractTradingViewDatafeed({ symbol });
  await establishHistoryBaseline(datafeed, symbol);
  datafeed.subscribeBars(
    symbolInfo(symbol),
    '1',
    (bar: any) => received.push(bar),
    'legacy-version-subscriber',
  );
  const versionedCandle = (
    openTime: number,
    close: string,
    generation: number,
    sequence: number,
  ) => ({
    ...realtimeCandle(symbol, '1m', openTime, close),
    provider_generation: generation,
    revision: { epoch: generation, sequence },
    provider_event_time_ms: openTime + sequence,
  });

  emitRealtime(versionedCandle(bucket, '111', 5, 10));
  emitRealtime(versionedCandle(bucket + 60_000, '112', 4, 99));
  emitRealtime(versionedCandle(bucket, '113', 5, 9));
  emitRealtime(versionedCandle(bucket, '114', 5, 11));

  assert.deepEqual(received.map((bar) => bar.close), [111, 114]);
  datafeed.destroy();
});


test('Store interval switch releases the old subscriber and keeps 1M distinct from 5m', async () => {
  const symbol = 'STORE_INTERVAL_PERP';
  const monthly: any[] = [];
  const fiveMinute: any[] = [];
  marketStoreModule.contractMarketStore.activateSymbol(symbol);
  const datafeed = datafeedModule.createContractTradingViewDatafeed({ symbol });

  await establishHistoryBaseline(datafeed, symbol, '1M');
  await establishHistoryBaseline(datafeed, symbol, '5');

  datafeed.subscribeBars(
    symbolInfo(symbol),
    '1M',
    (bar: any) => monthly.push(bar),
    'store-shared-subscriber',
  );
  datafeed.subscribeBars(
    symbolInfo(symbol),
    '5',
    (bar: any) => fiveMinute.push(bar),
    'store-shared-subscriber',
  );
  ingestStoreKline({
    symbol,
    interval: '1M',
    openTime: 1_716_000_000_000,
    close: '201',
  });
  ingestStoreKline({
    symbol,
    interval: '5m',
    openTime: 1_717_100_300_000,
    close: '202',
  });

  assert.deepEqual(monthly, []);
  assert.deepEqual(fiveMinute.map((bar) => bar.close), [202]);
  datafeed.destroy();
});


test('Store symbol switch rejects the retired symbol and only updates the replacement subscriber', async () => {
  const btcBars: any[] = [];
  const ethBars: any[] = [];
  const datafeed = datafeedModule.createContractTradingViewDatafeed({ symbol: 'STORE_BTC_PERP' });
  marketStoreModule.contractMarketStore.activateSymbol('STORE_BTC_PERP');
  await establishHistoryBaseline(datafeed, 'STORE_BTC_PERP');
  datafeed.subscribeBars(
    symbolInfo('STORE_BTC_PERP'),
    '1',
    (bar: any) => btcBars.push(bar),
    'store-symbol-subscriber',
  );

  marketStoreModule.contractMarketStore.activateSymbol('STORE_ETH_PERP');
  await establishHistoryBaseline(datafeed, 'STORE_ETH_PERP');
  datafeed.subscribeBars(
    symbolInfo('STORE_ETH_PERP'),
    '1',
    (bar: any) => ethBars.push(bar),
    'store-symbol-subscriber',
  );
  const retired = ingestStoreKline({
    symbol: 'STORE_BTC_PERP',
    interval: '1m',
    openTime: 1_717_100_000_000,
    close: '301',
  });
  ingestStoreKline({
    symbol: 'STORE_ETH_PERP',
    interval: '1m',
    openTime: 1_717_100_060_000,
    close: '302',
  });

  assert.deepEqual(retired, {
    accepted: false,
    reason: 'OLD_SYMBOL',
    key: null,
    entry: null,
  });
  assert.deepEqual(btcBars, []);
  assert.deepEqual(ethBars.map((bar) => bar.close), [302]);
  datafeed.destroy();
});


test('Store rejects a stale candle without notifying subscribeBars', async () => {
  const symbol = 'STORE_STALE_PERP';
  const openTime = 1_717_100_000_000;
  const received: any[] = [];
  marketStoreModule.contractMarketStore.activateSymbol(symbol);
  const datafeed = datafeedModule.createContractTradingViewDatafeed({ symbol });
  await establishHistoryBaseline(datafeed, symbol);
  datafeed.subscribeBars(
    symbolInfo(symbol),
    '1',
    (bar: any) => received.push(bar),
    'store-stale-subscriber',
  );

  ingestStoreKline({
    symbol,
    interval: '1m',
    openTime,
    close: '401',
    eventTimeMs: openTime + 200,
  });
  const stale = ingestStoreKline({
    symbol,
    interval: '1m',
    openTime,
    close: '400',
    eventTimeMs: openTime + 100,
  });

  assert.equal(stale.accepted, false);
  assert.equal(stale.reason, 'STALE_EVENT');
  assert.deepEqual(received.map((bar) => bar.close), [401]);
  datafeed.destroy();
});


test('Store rejects revision and generation rollback before realtime callback', async () => {
  const symbol = 'STORE_REVISION_PERP';
  const openTime = 1_717_100_000_000;
  const received: any[] = [];
  marketStoreModule.contractMarketStore.activateSymbol(symbol);
  const datafeed = datafeedModule.createContractTradingViewDatafeed({ symbol });
  await establishHistoryBaseline(datafeed, symbol);
  datafeed.subscribeBars(
    symbolInfo(symbol),
    '1',
    (bar: any) => received.push(bar),
    'store-revision-subscriber',
  );

  ingestStoreKline({
    symbol,
    interval: '1m',
    openTime,
    close: '501',
    eventTimeMs: openTime + 100,
    generation: 8,
    sequence: 20,
  });
  const revisionRollback = ingestStoreKline({
    symbol,
    interval: '1m',
    openTime,
    close: '500',
    eventTimeMs: openTime + 200,
    generation: 8,
    sequence: 19,
  });
  const generationRollback = ingestStoreKline({
    symbol,
    interval: '1m',
    openTime,
    close: '499',
    eventTimeMs: openTime + 300,
    generation: 7,
    sequence: 99,
  });
  ingestStoreKline({
    symbol,
    interval: '1m',
    openTime,
    close: '502',
    eventTimeMs: openTime + 400,
    generation: 8,
    sequence: 21,
  });

  assert.equal(revisionRollback.reason, 'REVISION_ROLLBACK');
  assert.equal(generationRollback.reason, 'GENERATION_ROLLBACK');
  assert.deepEqual(received.map((bar) => bar.close), [501, 502]);
  datafeed.destroy();
});


test('datafeed subscribers own only kline domains and never the market session', () => {
  const datafeed = datafeedModule.createContractTradingViewDatafeed({ symbol: 'SESSION_OWNER_PERP' });

  datafeed.subscribeBars(
    symbolInfo('SESSION_OWNER_PERP'),
    '5',
    () => undefined,
    'old-five-minute-subscriber',
  );
  datafeed.subscribeBars(
    symbolInfo('SESSION_OWNER_PERP'),
    '1D',
    () => undefined,
    'new-daily-subscriber',
  );
  datafeed.destroy();

  assert.deepEqual(realtimeMarketSessionCalls, []);
  assert.deepEqual(realtimeKlineOwnerCalls, [
    { op: 'subscribe', symbol: 'SESSION_OWNER_PERP', interval: '5m' },
    { op: 'subscribe', symbol: 'SESSION_OWNER_PERP', interval: '1d' },
    { op: 'unsubscribe', symbol: 'SESSION_OWNER_PERP', interval: '5m' },
    { op: 'unsubscribe', symbol: 'SESSION_OWNER_PERP', interval: '1d' },
  ]);
  assert.equal(realtimeDisconnectCalls, 0);
});


test('same subscriber UID releases the monthly owner before subscribing five minutes', () => {
  const datafeed = datafeedModule.createContractTradingViewDatafeed({ symbol: 'OWNER_SWITCH_PERP' });

  datafeed.subscribeBars(
    symbolInfo('OWNER_SWITCH_PERP'),
    '1M',
    () => undefined,
    'shared-subscriber',
  );
  datafeed.subscribeBars(
    symbolInfo('OWNER_SWITCH_PERP'),
    '5',
    () => undefined,
    'shared-subscriber',
  );

  assert.deepEqual(realtimeKlineOwnerCalls, [
    { op: 'subscribe', symbol: 'OWNER_SWITCH_PERP', interval: '1M' },
    { op: 'unsubscribe', symbol: 'OWNER_SWITCH_PERP', interval: '1M' },
    { op: 'subscribe', symbol: 'OWNER_SWITCH_PERP', interval: '5m' },
  ]);

  datafeed.unsubscribeBars('shared-subscriber');
  assert.deepEqual(realtimeKlineOwnerCalls.at(-1), {
    op: 'unsubscribe',
    symbol: 'OWNER_SWITCH_PERP',
    interval: '5m',
  });
});


test('late monthly callback cannot write into the replacement five-minute subscriber', async () => {
  const monthlyBars: any[] = [];
  const fiveMinuteBars: any[] = [];
  const datafeed = datafeedModule.createContractTradingViewDatafeed({ symbol: 'OWNER_DELAY_PERP' });

  await establishHistoryBaseline(datafeed, 'OWNER_DELAY_PERP', '1M');
  await establishHistoryBaseline(datafeed, 'OWNER_DELAY_PERP', '5');

  datafeed.subscribeBars(
    symbolInfo('OWNER_DELAY_PERP'),
    '1M',
    (bar: any) => monthlyBars.push(bar),
    'shared-delayed-subscriber',
  );
  const retiredMonthlyHandler = realtimeKlineSubscriptions[0].handler;

  datafeed.subscribeBars(
    symbolInfo('OWNER_DELAY_PERP'),
    '5',
    (bar: any) => fiveMinuteBars.push(bar),
    'shared-delayed-subscriber',
  );
  const activeFiveMinuteHandler = realtimeKlineSubscriptions[1].handler;

  retiredMonthlyHandler(realtimeCandle('OWNER_DELAY_PERP', '1M', 1_717_000_000_000, '101'));
  activeFiveMinuteHandler(realtimeCandle('OWNER_DELAY_PERP', '5m', 1_717_000_300_000, '102'));

  assert.deepEqual(monthlyBars, []);
  assert.deepEqual(fiveMinuteBars.map((bar) => bar.close), [102]);
  datafeed.destroy();
});


test('explicit 1W to 1m commit rejects the retired weekly callback after the new identity commits', async () => {
  const symbol = 'RESOLUTION_COMMIT_PERP';
  const weeklyBars: any[] = [];
  const minuteBars: any[] = [];
  const datafeed = datafeedModule.createContractTradingViewDatafeed({ symbol });
  await establishHistoryBaseline(datafeed, symbol, '1W');
  await establishHistoryBaseline(datafeed, symbol, '1');

  assert.ok(datafeed.beginResolutionTransition({ symbol, interval: '1w', transitionGeneration: 1 }));
  datafeed.subscribeBars(symbolInfo(symbol), '1W', (bar: any) => weeklyBars.push(bar), 'weekly-owner');
  assert.equal(datafeed.commitResolutionTransition(1), true);
  const retiredWeeklyHandler = realtimeKlineSubscriptions.at(-1)!.handler;

  assert.ok(datafeed.beginResolutionTransition({ symbol, interval: '1m', transitionGeneration: 2 }));
  retiredWeeklyHandler(realtimeCandle(
    symbol,
    '1w',
    Date.parse('2026-07-13T00:00:00.000Z'),
    '100',
  ));
  datafeed.subscribeBars(symbolInfo(symbol), '1', (bar: any) => minuteBars.push(bar), 'minute-owner');
  const activeMinuteHandler = realtimeKlineSubscriptions.at(-1)!.handler;
  assert.equal(datafeed.commitResolutionTransition(2), true);
  datafeed.subscribeBars(symbolInfo(symbol), '1W', (bar: any) => weeklyBars.push(bar), 'late-weekly-owner');
  const lateWeeklyHandler = realtimeKlineSubscriptions.at(-1)!.handler;

  retiredWeeklyHandler(realtimeCandle(
    symbol,
    '1w',
    Date.parse('2026-07-20T00:00:00.000Z'),
    '101',
  ));
  lateWeeklyHandler(realtimeCandle(
    symbol,
    '1w',
    Date.parse('2026-07-27T00:00:00.000Z'),
    '102',
  ));
  activeMinuteHandler(
    realtimeCandle(symbol, '1m', 1_721_000_060_000, '103'),
  );
  assert.deepEqual(weeklyBars, []);
  assert.deepEqual(minuteBars.map((bar) => bar.close), [103]);
  assert.equal(datafeed.getRealtimeSubscriptionReadiness(symbol, '1m')?.transitionGeneration, 2);
  assert.equal(
    realtimeKlineSubscriptions.find((subscription) => subscription.interval === '1w')?.released,
    true,
  );
  datafeed.destroy();
});


test('1m to 1M intent owns an exact monthly identity before TradingView cache reuse subscribes again', async () => {
  const symbol = 'MONTHLY_CACHE_REUSE_PERP';
  const minuteBars: any[] = [];
  const datafeed = datafeedModule.createContractTradingViewDatafeed({ symbol });
  await establishHistoryBaseline(datafeed, symbol, '1');
  datafeed.beginResolutionTransition({ symbol, interval: '1m', transitionGeneration: 10 });
  datafeed.subscribeBars(symbolInfo(symbol), '1', (bar: any) => minuteBars.push(bar), 'minute-cache-owner');
  assert.equal(datafeed.commitResolutionTransition(10), true);
  const retiredMinuteHandler = realtimeKlineSubscriptions.at(-1)!.handler;

  const monthlyIdentity = datafeed.beginResolutionTransition({
    symbol,
    interval: '1M',
    transitionGeneration: 11,
  });
  assert.equal(monthlyIdentity?.interval, '1M');
  assert.equal(monthlyIdentity?.transitionGeneration, 11);
  assert.equal(datafeed.getRealtimeSubscriptionReadiness(symbol, '1m'), null);
  assert.equal(datafeed.getRealtimeSubscriptionReadiness(symbol, '1M')?.interval, '1M');
  retiredMinuteHandler(realtimeCandle(symbol, '1m', 1_721_000_000_000, '201'));
  assert.deepEqual(minuteBars, []);

  datafeed.subscribeBars(symbolInfo(symbol), '1M', () => undefined, 'monthly-cache-owner');
  const monthlySubscription = realtimeKlineSubscriptions.at(-1)!;
  assert.equal(monthlySubscription.interval, '1M');
  assert.equal(monthlySubscription.transitionGeneration, 11);
  assert.equal(datafeed.commitResolutionTransition(11), true);
  datafeed.unsubscribeBars('monthly-cache-owner');
  assert.equal(monthlySubscription.released, true);
  assert.ok(realtimeResolutionCalls.some((call) => (
    call.op === 'begin'
    && call.interval === '1M'
    && call.transitionGeneration === 11
  )));
  datafeed.destroy();
});


test('failed candidate rollback restores only the explicit committed target identity', async () => {
  const symbol = 'RESOLUTION_ROLLBACK_PERP';
  const minuteBars: any[] = [];
  const datafeed = datafeedModule.createContractTradingViewDatafeed({ symbol });
  await establishHistoryBaseline(datafeed, symbol, '1');
  datafeed.beginResolutionTransition({ symbol, interval: '1m', transitionGeneration: 21 });
  datafeed.subscribeBars(symbolInfo(symbol), '1', (bar: any) => minuteBars.push(bar), 'rollback-minute');
  assert.equal(datafeed.commitResolutionTransition(21), true);
  const minuteHandler = realtimeKlineSubscriptions.at(-1)!.handler;

  datafeed.beginResolutionTransition({ symbol, interval: '1h', transitionGeneration: 22 });
  minuteHandler(realtimeCandle(symbol, '1m', 1_721_000_000_000, '301'));
  assert.equal(minuteBars.length, 0);
  assert.equal(datafeed.rollbackResolutionTransition(22), true);
  minuteHandler(realtimeCandle(symbol, '1m', 1_721_000_060_000, '302'));
  assert.deepEqual(minuteBars.map((bar) => bar.close), [302]);
  assert.equal(datafeed.getRealtimeSubscriptionReadiness(symbol, '1m')?.transitionGeneration, 21);
  assert.ok(realtimeResolutionCalls.some((call) => call.op === 'rollback' && call.transitionGeneration === 22));
  datafeed.destroy();
});


test('fast 1m to 5m to 1D to 1m chain leaves only the final minute callback active', async () => {
  const symbol = 'FAST_INTERVAL_CHAIN_PERP';
  const finalMinuteBars: any[] = [];
  const datafeed = datafeedModule.createContractTradingViewDatafeed({ symbol });
  await establishHistoryBaseline(datafeed, symbol, '1');
  await establishHistoryBaseline(datafeed, symbol, '5');
  await establishHistoryBaseline(datafeed, symbol, '1D');
  const subscribe = (resolution: string, callback: (bar: any) => void) => {
    datafeed.subscribeBars(
      symbolInfo(symbol),
      resolution,
      callback,
      'fast-chain-subscriber',
    );
  };

  subscribe('1', () => assert.fail('retired initial 1m callback must stay inactive'));
  subscribe('5', () => assert.fail('retired 5m callback must stay inactive'));
  subscribe('1D', () => assert.fail('retired 1D callback must stay inactive'));
  subscribe('1', (bar: any) => finalMinuteBars.push(bar));

  const retiredHandlers = realtimeKlineSubscriptions.slice(0, 3).map(({ handler }) => handler);
  retiredHandlers[0](realtimeCandle(symbol, '1m', 1_717_100_000_000, '801'));
  retiredHandlers[1](realtimeCandle(symbol, '5m', 1_717_100_300_000, '802'));
  retiredHandlers[2](realtimeCandle(symbol, '1d', 1_717_200_000_000, '803'));
  realtimeKlineSubscriptions[3].handler(
    realtimeCandle(symbol, '1m', 1_717_100_060_000, '804'),
  );

  assert.deepEqual(finalMinuteBars.map((bar) => bar.close), [804]);
  assert.deepEqual(realtimeKlineOwnerCalls, [
    { op: 'subscribe', symbol, interval: '1m' },
    { op: 'unsubscribe', symbol, interval: '1m' },
    { op: 'subscribe', symbol, interval: '5m' },
    { op: 'unsubscribe', symbol, interval: '5m' },
    { op: 'subscribe', symbol, interval: '1d' },
    { op: 'unsubscribe', symbol, interval: '1d' },
    { op: 'subscribe', symbol, interval: '1m' },
  ]);
  datafeed.destroy();
});


test('subscriber ownership remains isolated across symbols and intervals', async () => {
  const btcBars: any[] = [];
  const ethBars: any[] = [];
  const datafeed = datafeedModule.createContractTradingViewDatafeed({ symbol: 'BTC_OWNER_PERP' });

  await establishHistoryBaseline(datafeed, 'BTC_OWNER_PERP', '1M');
  await establishHistoryBaseline(datafeed, 'ETH_OWNER_PERP', '5');

  datafeed.subscribeBars(
    symbolInfo('BTC_OWNER_PERP'),
    '1M',
    (bar: any) => btcBars.push(bar),
    'btc-monthly-subscriber',
  );
  datafeed.subscribeBars(
    symbolInfo('ETH_OWNER_PERP'),
    '5',
    (bar: any) => ethBars.push(bar),
    'eth-five-minute-subscriber',
  );

  emitRealtime(realtimeCandle(
    'BTC_OWNER_PERP',
    '1M',
    Date.parse('2026-07-01T00:00:00.000Z'),
    '201',
  ));
  emitRealtime(realtimeCandle('ETH_OWNER_PERP', '5m', 1_717_000_300_000, '301'));

  assert.deepEqual(btcBars.map((bar) => bar.close), [201]);
  assert.deepEqual(ethBars.map((bar) => bar.close), [301]);
  datafeed.destroy();
});


test('destroy invalidates callbacks before releasing every kline owner', () => {
  const received: any[] = [];
  const datafeed = datafeedModule.createContractTradingViewDatafeed({ symbol: 'OWNER_DESTROY_PERP' });

  datafeed.subscribeBars(
    symbolInfo('OWNER_DESTROY_PERP'),
    '1M',
    (bar: any) => received.push(bar),
    'destroy-monthly-subscriber',
  );
  datafeed.subscribeBars(
    symbolInfo('OWNER_DESTROY_PERP'),
    '5',
    (bar: any) => received.push(bar),
    'destroy-five-minute-subscriber',
  );
  const retiredHandlers = realtimeKlineSubscriptions.map((subscription) => subscription.handler);

  datafeed.destroy();
  retiredHandlers[0](realtimeCandle('OWNER_DESTROY_PERP', '1M', 1_717_000_000_000, '401'));
  retiredHandlers[1](realtimeCandle('OWNER_DESTROY_PERP', '5m', 1_717_000_300_000, '402'));

  assert.deepEqual(received, []);
  assert.deepEqual(realtimeKlineOwnerCalls, [
    { op: 'subscribe', symbol: 'OWNER_DESTROY_PERP', interval: '1M' },
    { op: 'subscribe', symbol: 'OWNER_DESTROY_PERP', interval: '5m' },
    { op: 'unsubscribe', symbol: 'OWNER_DESTROY_PERP', interval: '1M' },
    { op: 'unsubscribe', symbol: 'OWNER_DESTROY_PERP', interval: '5m' },
  ]);
});


test('legacy realtime subscribe and snapshot retain the monthly interval', () => {
  const sockets: MockWebSocket[] = [];

  class MockWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;

    readyState = MockWebSocket.CONNECTING;
    sent: string[] = [];
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;
    readonly url: string;

    constructor(url: string) {
      this.url = url;
      sockets.push(this);
    }

    send(value: string) {
      this.sent.push(value);
    }

    close() {
      this.readyState = MockWebSocket.CLOSED;
    }
  }

  const originalWindow = globalThis.window;
  const originalWebSocket = globalThis.WebSocket;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      setTimeout(callback: () => void) {
        callback();
        return 1;
      },
      clearTimeout() {},
    },
  });
  Object.defineProperty(globalThis, 'WebSocket', {
    configurable: true,
    value: MockWebSocket,
  });

  try {
    const realtimeModule = loadTypeScriptModule(
      fileURLToPath(new URL('../../../lib/realtime/contractMarketRealtime.ts', import.meta.url)),
      {
        '@/lib/api/core/baseUrl': {
          getRuntimeApiBaseUrl: () => 'http://127.0.0.1:8000',
        },
      },
    );
    assert.equal(realtimeModule.normalizeContractMarketInterval('1m'), '1m');
    assert.equal(realtimeModule.normalizeContractMarketInterval('1M'), '1M');

    const client = new realtimeModule.ContractMarketRealtimeClient();
    client.setSession({ symbol: 'BTCUSDT_PERP', interval: '1m' });
    assert.equal(sockets.length, 1);
    const socket = sockets[0];
    socket.readyState = MockWebSocket.OPEN;
    socket.onopen?.();

    client.setSession({ symbol: 'BTCUSDT_PERP', interval: '1M' });
    assert.equal(JSON.parse(socket.sent.at(-1) || '{}').interval, '1M');

    const received: any[] = [];
    const unsubscribe = client.subscribe('kline', (message: unknown) => received.push(message));
    socket.onmessage?.({
      data: JSON.stringify({
        type: 'contract_market_snapshot',
        symbol: 'BTCUSDT_PERP',
        interval: '1M',
        data: {
          klines: {
            '1M': { open_time: 1_717_000_000_000, close: '105', source: 'LIVE_WS' },
          },
        },
      }),
    });

    assert.equal(received.length, 1);
    assert.equal(received[0].interval, '1M');
    assert.equal(received[0].kline.close, '105');
    unsubscribe();
    client.disconnect();
  } finally {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
    Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: originalWebSocket });
  }
});


test('domain-aware interval switches never resubscribe or overwrite the market domain', () => {
  const sockets: MockWebSocket[] = [];

  class MockWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;

    readyState = MockWebSocket.CONNECTING;
    sent: string[] = [];
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;
    readonly url: string;

    constructor(url: string) {
      this.url = url;
      sockets.push(this);
    }

    send(value: string) {
      this.sent.push(value);
    }

    close() {
      this.readyState = MockWebSocket.CLOSED;
    }
  }

  const originalWindow = globalThis.window;
  const originalWebSocket = globalThis.WebSocket;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      setTimeout(callback: () => void) {
        callback();
        return 1;
      },
      clearTimeout() {},
    },
  });
  Object.defineProperty(globalThis, 'WebSocket', {
    configurable: true,
    value: MockWebSocket,
  });

  try {
    const realtimeModule = loadTypeScriptModule(
      fileURLToPath(new URL('../../../lib/realtime/contractMarketRealtime.ts', import.meta.url)),
      {
        '@/lib/api/core/baseUrl': {
          getRuntimeApiBaseUrl: () => 'http://127.0.0.1:8000',
        },
      },
    );
    const client = new realtimeModule.ContractMarketRealtimeClient();
    const releaseMarket = client.setMarketSession('BTCUSDT_PERP');
    assert.equal(sockets.length, 1);
    const socket = sockets[0];
    socket.readyState = MockWebSocket.OPEN;
    socket.onopen?.();

    const marketEvents: string[] = [];
    const klineEvents: any[] = [];
    client.subscribe('quote', () => marketEvents.push('quote'));
    client.subscribe('depth', () => marketEvents.push('depth'));
    client.subscribe('trade', () => marketEvents.push('trade'));
    client.subscribe('state', () => marketEvents.push('state'));

    const releaseOneMinute = client.subscribeKline(
      { symbol: 'BTCUSDT_PERP', interval: '1m' },
      () => undefined,
    );
    const releaseMonthly = client.subscribeKline(
      { symbol: 'BTCUSDT_PERP', interval: '1M' },
      () => undefined,
    );
    const releaseFiveMinute = client.subscribeKline(
      { symbol: 'BTCUSDT_PERP', interval: '5m' },
      (message: unknown) => klineEvents.push(message),
    );

    const commands = socket.sent.map((item) => JSON.parse(item));
    assert.deepEqual(
      commands.filter((item) => item.op === 'subscribe' && item.domain === 'market'),
      [{ op: 'subscribe', domain: 'market', symbol: 'BTCUSDT_PERP' }],
    );
    assert.deepEqual(
      commands
        .filter((item) => item.op === 'subscribe' && item.domain === 'kline')
        .map((item) => item.interval),
      ['1m', '1M', '5m'],
    );
    assert.deepEqual(
      commands
        .filter((item) => item.op === 'unsubscribe' && item.domain === 'kline')
        .map((item) => item.interval),
      ['1m', '1M'],
    );

    socket.onmessage?.({
      data: JSON.stringify({
        type: 'contract_market_snapshot',
        symbol: 'BTCUSDT_PERP',
        interval: '1M',
        data: {
          quote: { symbol: 'BTCUSDT_PERP', last_price: '999' },
          depth: { symbol: 'BTCUSDT_PERP', bids: [], asks: [] },
          trades: [{ price: '999' }],
          market_state: { symbol: 'BTCUSDT_PERP', display_price: '999' },
        },
      }),
    });
    assert.deepEqual(marketEvents, [], 'legacy bootstrap must not enter domain-aware market handlers');

    socket.onmessage?.({
      data: JSON.stringify({
        type: 'contract_market_snapshot',
        domain: 'market',
        symbol: 'BTCUSDT_PERP',
        data: {
          quote: { symbol: 'BTCUSDT_PERP', last_price: '100' },
          depth: { symbol: 'BTCUSDT_PERP', bids: [], asks: [] },
          trades: [{ price: '100' }],
          market_state: { symbol: 'BTCUSDT_PERP', display_price: '100' },
        },
      }),
    });
    assert.deepEqual(marketEvents, ['state', 'quote', 'depth', 'trade']);

    socket.onmessage?.({
      data: JSON.stringify({
        type: 'contract_market_state',
        domain: 'kline',
        symbol: 'BTCUSDT_PERP',
        interval: '1M',
        data: { symbol: 'BTCUSDT_PERP', display_price: '777' },
      }),
    });
    assert.deepEqual(
      marketEvents,
      ['state', 'quote', 'depth', 'trade'],
      'kline-domain payloads must not enter market-state handlers',
    );

    socket.onmessage?.({
      data: JSON.stringify({
        type: 'contract_kline_snapshot',
        domain: 'kline',
        symbol: 'BTCUSDT_PERP',
        interval: '5m',
        kline: {
          symbol: 'BTCUSDT_PERP',
          interval: '5m',
          open_time: 1_717_000_000_000,
          open: '100',
          high: '101',
          low: '99',
          close: '100.5',
          volume: '10',
          source: 'LIVE_WS',
        },
      }),
    });
    assert.equal(klineEvents.length, 1);
    assert.deepEqual(marketEvents, ['state', 'quote', 'depth', 'trade']);

    client.disconnect();
    releaseFiveMinute();
    releaseMonthly();
    releaseOneMinute();
    releaseMarket();
  } finally {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
    Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: originalWebSocket });
  }
});
