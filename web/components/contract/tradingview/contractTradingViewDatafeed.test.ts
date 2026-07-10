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
const realtimeSessionCalls: any[] = [];
let realtimeDisconnectCalls = 0;
const realtimeStub = {
  setSession(session: unknown) {
    realtimeSessionCalls.push(session);
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

const currentCacheModule = loadTypeScriptModule(
  fileURLToPath(new URL('./contractKlineCurrentCache.ts', import.meta.url)),
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
    './contractKlineCurrentCache': currentCacheModule,
  },
);

test.beforeEach(() => {
  currentCacheModule.contractKlineCurrentCache.clear();
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
const pageEndingAt = (endTime: number, count: number, close: string, stepMs = 60_000) => (
  Array.from({ length: count }, (_, index) => (
    row(endTime - ((count - index - 1) * stepMs), close)
  ))
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

  assert.equal(buildKey(base), 'BTCUSDT_PERP|1h|CURRENT|300');
  assert.equal(buildKey({ ...base, endTimeMs: undefined }), buildKey(base));
  assert.equal(buildKey({ ...base, endTimeMs: null }), buildKey(base));
  assert.equal(
    buildKey({ ...base, endTimeMs: 1_780_000_000_000 }),
    'BTCUSDT_PERP|1h|1780000000000|300',
  );
  assert.equal(
    buildKey({ ...base, interval: '1M' }),
    'BTCUSDT_PERP|1M|CURRENT|300',
  );
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
  assert.ok(restToBar(basePayload), 'source-less provider REST rows remain compatible');
});


test('normal current request calls onHistory exactly once and never calls onError', async () => {
  requestKlines = async () => metadata([row(1_717_000_000_000, '101')]);
  const historyCalls: HistoryCall[] = [];
  const historyEvents: any[] = [];
  let errorCalls = 0;
  const latest: Array<string | null> = [];
  const datafeed = datafeedModule.createContractTradingViewDatafeed({
    symbol: 'BTCUSDT_PERP',
    onLatestBar: (close: string | null) => latest.push(close),
    onHistoryBars: (event: unknown) => historyEvents.push(event),
  });

  await datafeed.getBars(
    symbolInfo('BTCUSDT_PERP'),
    '1',
    period,
    (bars: any[], meta: { noData?: boolean }) => historyCalls.push({ bars, meta }),
    () => { errorCalls += 1; },
  );

  assert.equal(historyCalls.length, 1);
  assert.equal(historyCalls[0].bars.length, 1);
  assert.equal(historyCalls[0].meta.noData, false);
  assert.equal(errorCalls, 0);
  assert.deepEqual(latest, ['101']);
  assert.deepEqual(historyEvents, [{
    symbol: 'BTCUSDT_PERP',
    interval: '1m',
    resolution: '1',
    firstDataRequest: true,
    barCount: 1,
    requestSeq: 1,
  }]);
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


test('ordinary provider empty history settles once with noData false', async () => {
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

  assert.equal(historyCalls.length, 1);
  assert.deepEqual(historyCalls[0].bars, []);
  assert.equal(historyCalls[0].meta.noData, false);
  assert.equal(errorCalls, 0);
});


test('transient metadata errors settle exactly once with noData false', async () => {
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

    assert.equal(historyCalls.length, 1, providerErrorCode);
    assert.deepEqual(historyCalls[0].bars, [], providerErrorCode);
    assert.equal(historyCalls[0].meta.noData, false, providerErrorCode);
    assert.equal(errorCalls, 0, providerErrorCode);
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


test('empty current metadata never reports history noData', async () => {
  requestKlines = async () => metadata([], {
    history_complete: null,
    has_more_before: null,
    history_incomplete: false,
    retryable: true,
  });
  const historyCalls: HistoryCall[] = [];
  const datafeed = datafeedModule.createContractTradingViewDatafeed({ symbol: 'CURRENT_EMPTY_PERP' });

  await datafeed.getBars(
    symbolInfo('CURRENT_EMPTY_PERP'),
    '1',
    period,
    (bars: any[], meta: { noData?: boolean }) => historyCalls.push({ bars, meta }),
    assert.fail,
  );

  assert.equal(historyCalls.length, 1);
  assert.deepEqual(historyCalls[0].bars, []);
  assert.equal(historyCalls[0].meta.noData, false);
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


test('API failure safely settles empty history exactly once without noData or onError', async () => {
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

  assert.equal(historyCalls.length, 1);
  assert.deepEqual(historyCalls[0].bars, []);
  assert.equal(historyCalls[0].meta.noData, false);
  assert.deepEqual(errors, []);
  assert.deepEqual(historyEvents, [{
    symbol: 'BTCUSDT_PERP',
    interval: '1m',
    resolution: '1',
    firstDataRequest: true,
    barCount: 0,
    requestSeq: 1,
  }]);
  assert.deepEqual(historyErrors, []);
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
    onLatestBar: (close: string | null) => firstLatest.push(close),
    onHistoryBars: (event: unknown) => firstLoadingEvents.push(event),
  });
  const second = datafeedModule.createContractTradingViewDatafeed({
    symbol: 'DEDUPE_CURRENT_PERP',
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
    limit: 300,
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
    limit: 200,
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


test('completed history in-flight request is removed and does not become a result cache', async () => {
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

  const secondRequest = datafeed.getBars(
    symbolInfo('NO_RESULT_CACHE_PERP'),
    '1',
    { ...period, firstDataRequest: false },
    () => undefined,
    assert.fail,
  );
  assert.equal(apiCalls.length, 2);
  pending[1].resolve(metadata(pageEndingAt(1_717_000_060_000, 100, '102')));
  await secondRequest;
  assert.deepEqual(apiCalls[0], apiCalls[1]);
  datafeed.destroy();
});


test('history request with an invalid cursor still bypasses current L1', async () => {
  const symbol = 'NO_HISTORY_CURRENT_CACHE_PERP';
  currentCacheModule.contractKlineCurrentCache.set(
    { symbol, interval: '1m', limit: 100 },
    metadata(pageEndingAt(1_717_005_000_000, 100, '109')),
  );
  let apiCalls = 0;
  requestKlines = async () => {
    apiCalls += 1;
    return metadata(pageEndingAt(1_717_006_000_000, 100, '110'));
  };
  const historyCalls: HistoryCall[] = [];
  const datafeed = datafeedModule.createContractTradingViewDatafeed({ symbol });

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
  const first = datafeedModule.createContractTradingViewDatafeed({ symbol: 'L1_SEQUENTIAL_PERP' });
  const second = datafeedModule.createContractTradingViewDatafeed({ symbol: 'L1_SEQUENTIAL_PERP' });

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


test('current L1 key keeps symbol interval and exact limit isolated', async () => {
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

  assert.equal(apiCalls.length, 4);
  assert.deepEqual(apiCalls.map((call) => [call.symbol, call.interval, call.limit]), [
    ['L1_KEY_A_PERP', '1m', 100],
    ['L1_KEY_B_PERP', '1m', 100],
    ['L1_KEY_A_PERP', '5m', 100],
    ['L1_KEY_A_PERP', '1m', 200],
  ]);
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
        assert.fail,
      );
    }

    assert.equal(apiCalls, 2, `${invalid.name} unexpectedly hit L1`);
    assert.equal(historyCalls.length, 2, `${invalid.name} callback count`);
    assert.equal(historyCalls[0].meta.noData, false, `${invalid.name} first noData`);
    assert.equal(historyCalls[1].meta.noData, false, `${invalid.name} second noData`);
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
  );
  currentCacheModule.contractKlineCurrentCache.set(
    { symbol: newSymbol, interval: '1m', limit: 100 },
    metadata(pageEndingAt(1_717_060_000_000, 100, '117')),
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


test('older current L1 bars cannot roll back high-water mark and newer realtime still enters', async () => {
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
  ), true);
  const latest: Array<string | null> = [];
  const realtimeBars: any[] = [];
  const rebuilt = datafeedModule.createContractTradingViewDatafeed({
    symbol,
    onLatestBar: (close: string | null) => latest.push(close),
  });
  await rebuilt.getBars(symbolInfo(symbol), '1', period, () => undefined, assert.fail);

  assert.equal(apiCalls, 1);
  assert.deepEqual(latest, []);
  rebuilt.subscribeBars(
    symbolInfo(symbol),
    '1',
    (bar: any) => realtimeBars.push(bar),
    'l1-high-water',
  );
  emitRealtime(realtimeCandle(symbol, '1m', newerRestTime - 30_000, '129.5'));
  emitRealtime(realtimeCandle(symbol, '1m', newerRestTime + 60_000, '131'));

  assert.equal(realtimeBars.length, 1);
  assert.equal(realtimeBars[0].time, newerRestTime + 60_000);
  assert.deepEqual(latest, ['131']);
  rebuilt.unsubscribeBars('l1-high-water');
  rebuilt.destroy();
});


test('shared rejected request settles every live caller once without noData', async () => {
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

  for (const calls of [firstHistory, secondHistory]) {
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].bars, []);
    assert.equal(calls[0].meta.noData, false);
  }
  assert.equal(firstErrors, 0);
  assert.equal(secondErrors, 0);
  assert.equal(firstLoadingEvents.length, 1);
  assert.equal(secondLoadingEvents.length, 1);
  const retryHistory: HistoryCall[] = [];
  const retry = datafeedModule.createContractTradingViewDatafeed({ symbol: 'DEDUPE_REJECT_PERP' });
  await retry.getBars(
    symbolInfo('DEDUPE_REJECT_PERP'),
    '1',
    period,
    (bars: any[], meta: { noData?: boolean }) => retryHistory.push({ bars, meta }),
    assert.fail,
  );
  assert.equal(apiCalls, 2, 'rejected Promise must be removed instead of becoming a negative cache');
  assert.equal(retryHistory.length, 1);
  assert.deepEqual(retryHistory[0].bars, []);
  assert.equal(retryHistory[0].meta.noData, false);
  retry.destroy();
  first.destroy();
  second.destroy();
});


test('same-interval newer request supersedes the older callback while sharing HTTP', async () => {
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

  assert.equal(oldHistoryCalls.length, 0, 'superseded settlement must be asynchronous');
  await Promise.resolve();
  assert.equal(oldHistoryCalls.length, 1);
  assert.deepEqual(oldHistoryCalls[0].bars, []);
  assert.equal(oldHistoryCalls[0].meta.noData, false);
  assert.equal(oldErrorCalls, 0);
  assert.deepEqual(latest, []);
  assert.equal(historyEvents.length, 0, 'superseded empty settle is not a history completion event');

  assert.equal(pending.length, 1, 'identical requests must share one HTTP promise');
  pending[0].resolve(metadata(pageEndingAt(1_717_000_060_000, 100, '102')));
  await Promise.all([oldRequest, newRequest]);
  assert.equal(oldHistoryCalls.length, 1, 'shared late response must not settle superseded callback twice');
  assert.equal(newHistoryCalls.length, 1);
  assert.equal(newHistoryCalls[0].bars[0].close, 102);
  assert.equal(oldErrorCalls, 0);
  assert.equal(newErrorCalls, 0);
  assert.deepEqual(latest, ['102']);
  assert.equal(historyEvents.length, 1);
  assert.equal(historyEvents[0].requestSeq, 2);
  assert.equal(historyEvents[0].barCount, 100);
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


test('symbol interval history cursor and limit differences never share HTTP', async () => {
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

    assert.equal(apiCalls.length, 2, item.name);
    assert.equal(pending.length, 2, item.name);
    pending[0].resolve(metadata(pageEndingAt(
      1_717_000_000_000,
      apiCalls[0].limit || 100,
      '101',
    )));
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


test('current L1 hit is page one and leaves only two C2 history pages', async () => {
  const symbol = 'L1_PAGED_CURRENT_PERP';
  const step = 60_000;
  const currentEnd = 1_800_000_000_000;
  const currentRows = pageEndingAt(currentEnd, 200, '120', step);
  const currentEarliest = currentRows[0].open_time;
  assert.equal(currentCacheModule.contractKlineCurrentCache.set(
    { symbol, interval: '1m', limit: 500 },
    metadata(currentRows),
  ), true);
  const apiCalls: KlineRequest[] = [];
  requestKlines = async (params) => {
    apiCalls.push(params);
    if (apiCalls.length === 1) {
      return metadata(pageEndingAt(currentEarliest - step, 200, '119', step));
    }
    const secondPageEarliest = currentEarliest - (200 * step);
    return metadata(pageEndingAt(secondPageEarliest - step, 100, '118', step));
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

  assert.equal(apiCalls.length, 2);
  assert.deepEqual(apiCalls, [
    { symbol, interval: '1m', limit: 300, endTimeMs: currentEarliest },
    {
      symbol,
      interval: '1m',
      limit: 100,
      endTimeMs: currentEarliest - (200 * step),
    },
  ]);
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


test('current countBack is filled across three bounded pages', async () => {
  const pending: Array<Deferred<KlineMetadata>> = [];
  const calls: KlineRequest[] = [];
  requestKlines = async (params) => {
    calls.push(params);
    const request = deferred<KlineMetadata>();
    pending.push(request);
    return request.promise;
  };
  const oldest = 1_800_000_000_000;
  const step = 60_000;
  const historyCalls: HistoryCall[] = [];
  const loadingEvents: any[] = [];
  const latest: Array<string | null> = [];
  const datafeed = datafeedModule.createContractTradingViewDatafeed({
    symbol: 'PAGED_CURRENT_PERP',
    onLatestBar: (close: string | null) => latest.push(close),
    onHistoryBars: (event: unknown) => loadingEvents.push(event),
  });

  const request = datafeed.getBars(
    symbolInfo('PAGED_CURRENT_PERP'),
    '1',
    { ...period, countBack: 500 },
    (bars: any[], meta: { noData?: boolean }) => historyCalls.push({ bars, meta }),
    assert.fail,
  );
  assert.deepEqual(calls[0], {
    symbol: 'PAGED_CURRENT_PERP',
    interval: '1m',
    limit: 500,
    endTimeMs: undefined,
  });

  pending[0].resolve(metadata(pageEndingAt(oldest + (499 * step), 200, '3')));
  await waitFor(() => pending.length === 2, 'current second page was not requested');
  assert.equal(calls[1].endTimeMs, oldest + (300 * step));
  assert.equal(calls[1].limit, 300);

  pending[1].resolve(metadata(pageEndingAt(oldest + (299 * step), 200, '2')));
  await waitFor(() => pending.length === 3, 'current third page was not requested');
  assert.equal(calls[2].endTimeMs, oldest + (100 * step));
  assert.equal(calls[2].limit, 100);

  pending[2].resolve(metadata(pageEndingAt(oldest + (99 * step), 100, '1')));
  await request;

  assert.equal(calls.length, 3);
  assert.equal(historyCalls.length, 1);
  assert.equal(historyCalls[0].bars.length, 500);
  assert.equal(new Set(historyCalls[0].bars.map((bar) => bar.time)).size, 500);
  assert.deepEqual(
    historyCalls[0].bars.map((bar) => bar.time),
    [...historyCalls[0].bars.map((bar) => bar.time)].sort((left, right) => left - right),
  );
  assert.equal(historyCalls[0].meta.noData, false);
  assert.deepEqual(latest, ['3']);
  assert.equal(loadingEvents.length, 1);
  assert.equal(loadingEvents[0].barCount, 500);
  datafeed.destroy();
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
  assert.equal(calls[0].limit, 250);
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
    { ...period, countBack: 500 },
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
  assert.deepEqual(calls.map((item) => item.limit), [500, 300, 300]);
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
    { ...period, countBack: 5000 },
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
  assert.deepEqual(calls.map((item) => item.limit), [1000, 300, 300]);
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
    { ...period, countBack: 300 },
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


test('terminal metadata remains local to one getBars flow and one datafeed', async () => {
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
    assert.fail,
  );

  assert.equal(apiCalls, 3);
  assert.deepEqual(firstHistory.map((call) => call.meta.noData), [true, false]);
  assert.deepEqual(secondHistory.map((call) => call.meta.noData), [false]);
  first.destroy();
  second.destroy();
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
    { ...period, countBack: 500 },
    () => { destroyedHistoryCalls += 1; },
    assert.fail,
  );
  const liveRequest = live.getBars(
    symbolInfo('DESTROY_PAGING_PERP'),
    '1',
    { ...period, countBack: 500 },
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
    { ...period, countBack: 500 },
    (bars: any[], meta: { noData?: boolean }) => firstHistory.push({ bars, meta }),
    assert.fail,
  );
  const secondRequest = second.getBars(
    symbolInfo('SHARED_PAGES_PERP'),
    '1',
    { ...period, countBack: 500 },
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


test('REST high-water mark rejects older realtime bars and accepts equal or newer candles', async () => {
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


test('module high-water mark survives datafeed destroy and rebuild', async () => {
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
  rebuilt.subscribeBars(
    symbolInfo('REBUILD_MONO_PERP'),
    '1',
    (bar: any) => rebuiltRealtime.push(bar),
    'rebuilt-subscription',
  );
  emitRealtime(realtimeCandle('REBUILD_MONO_PERP', '1m', restTime - 60_000, '199'));

  assert.deepEqual(rebuiltRealtime, []);
  assert.deepEqual(rebuiltLatest, []);
  rebuilt.destroy();
});


test('high-water marks isolate symbol and interval while preserving 1M case', async () => {
  const highTime = Date.parse('2026-07-10T08:02:00.000Z');
  const lowerTime = highTime - 60_000;
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
  seeded.subscribeBars(
    symbolInfo('ISOLATION_A_PERP'),
    '1M',
    (bar: any) => monthlyBars.push(bar),
    'monthly',
  );

  emitRealtime(realtimeCandle('ISOLATION_B_PERP', '1m', lowerTime, '301'));
  emitRealtime(realtimeCandle('ISOLATION_A_PERP', '5m', lowerTime, '302'));
  emitRealtime(realtimeCandle('ISOLATION_A_PERP', '1M', lowerTime, '303'));

  assert.deepEqual(otherSymbolBars.map((bar) => bar.time), [lowerTime]);
  assert.deepEqual(fiveMinuteBars.map((bar) => bar.time), [lowerTime]);
  assert.deepEqual(monthlyBars.map((bar) => bar.time), [lowerTime]);
  otherSymbol.destroy();
  seeded.destroy();
});


test('datafeed subscribers never take ownership of the public realtime session', () => {
  realtimeSessionCalls.length = 0;
  realtimeDisconnectCalls = 0;
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

  assert.deepEqual(realtimeSessionCalls, []);
  assert.equal(realtimeDisconnectCalls, 0);
});


test('realtime subscribe and snapshot retain the monthly interval', () => {
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
