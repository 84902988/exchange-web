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

let requestKlines: (params: KlineRequest) => Promise<any[]> = async () => [];
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

const datafeedModule = loadTypeScriptModule(
  fileURLToPath(new URL('./contractTradingViewDatafeed.ts', import.meta.url)),
  {
    '@/lib/api/modules/contract': {
      getContractMarketKlines: (params: KlineRequest) => requestKlines(params),
    },
    '@/lib/realtime/contractMarketRealtime': {
      contractMarketRealtime: realtimeStub,
    },
  },
);

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
  requestKlines = async () => [row(1_717_000_000_000, '101')];
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


test('normal failed request calls onError exactly once and never calls onHistory', async () => {
  requestKlines = async () => {
    throw new Error('provider unavailable');
  };
  let historyCalls = 0;
  const errors: string[] = [];
  const historyErrors: any[] = [];
  const datafeed = datafeedModule.createContractTradingViewDatafeed({
    symbol: 'BTCUSDT_PERP',
    onHistoryError: (event: unknown) => historyErrors.push(event),
  });

  await datafeed.getBars(
    symbolInfo('BTCUSDT_PERP'),
    '1',
    period,
    () => { historyCalls += 1; },
    (reason: string) => errors.push(reason),
  );

  assert.equal(historyCalls, 0);
  assert.deepEqual(errors, ['Failed to load contract kline']);
  assert.deepEqual(historyErrors, [{
    symbol: 'BTCUSDT_PERP',
    interval: '1m',
    resolution: '1',
    firstDataRequest: true,
    requestSeq: 1,
    error: 'Failed to load contract kline',
  }]);
});


test('same-interval newer request supersedes the older response exactly once', async () => {
  const pending: Array<Deferred<any[]>> = [];
  requestKlines = async () => {
    const request = deferred<any[]>();
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

  pending[0].resolve([row(1_717_000_000_000, '101')]);
  await oldRequest;
  assert.equal(oldHistoryCalls.length, 1, 'late response must not settle twice');
  assert.deepEqual(latest, []);

  pending[1].resolve([row(1_717_000_060_000, '102')]);
  await newRequest;
  assert.equal(newHistoryCalls.length, 1);
  assert.equal(newHistoryCalls[0].bars[0].close, 102);
  assert.equal(oldErrorCalls, 0);
  assert.equal(newErrorCalls, 0);
  assert.deepEqual(latest, ['102']);
  assert.equal(historyEvents.length, 1);
  assert.equal(historyEvents[0].requestSeq, 2);
  assert.equal(historyEvents[0].barCount, 1);
});


test('interval switch drops the late response from the previous interval', async () => {
  const pending: Array<Deferred<any[]>> = [];
  const calls: KlineRequest[] = [];
  requestKlines = async (params) => {
    calls.push(params);
    const request = deferred<any[]>();
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

  pending[1].resolve([row(1_717_000_300_000, '105')]);
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
  const pending: Array<Deferred<any[]>> = [];
  const calls: KlineRequest[] = [];
  requestKlines = async (params) => {
    calls.push(params);
    const request = deferred<any[]>();
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

  pending[1].resolve([row(1_717_000_060_000, '202')]);
  await newSymbolRequest;
  pending[0].resolve([row(1_717_000_000_000, '101')]);
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
  const pending: Array<Deferred<any[]>> = [];
  requestKlines = async () => {
    const request = deferred<any[]>();
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
  pending[0].resolve([row(1_717_000_000_000, '101')]);
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
  requestKlines = async () => [row(restTime, '1.14411')];
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
  requestKlines = async () => [row(restTime, '200')];
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
  requestKlines = async () => [row(highTime, '300')];
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
