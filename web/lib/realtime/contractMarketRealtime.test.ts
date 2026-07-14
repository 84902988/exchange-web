/* eslint-disable @typescript-eslint/no-explicit-any -- Dynamic test harness loads compiled module exports. */
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


function installRealtimeHarness() {
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

  const realtimeModule = loadTypeScriptModule(
    fileURLToPath(new URL('./contractMarketRealtime.ts', import.meta.url)),
    {
      '@/lib/api/core/baseUrl': {
        getRuntimeApiBaseUrl: () => 'http://127.0.0.1:8000',
      },
    },
  );

  return {
    MockWebSocket,
    realtimeModule,
    sockets,
    restore() {
      Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
      Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: originalWebSocket });
    },
  };
}


function klineSnapshot(interval: string) {
  return {
    data: JSON.stringify({
      type: 'contract_kline_snapshot',
      domain: 'kline',
      symbol: 'BTCUSDT_PERP',
      interval,
      kline: {
        symbol: 'BTCUSDT_PERP',
        interval,
        open_time: 1_717_000_000_000,
        open: '100',
        high: '101',
        low: '99',
        close: '100.5',
        volume: '10',
      },
    }),
  };
}


test('replacing a monthly owner retires its handler and never falls back after five-minute release', () => {
  const harness = installRealtimeHarness();

  try {
    const client = new harness.realtimeModule.ContractMarketRealtimeClient();
    const releaseMarket = client.setMarketSession('BTCUSDT_PERP');
    const socket = harness.sockets[0];
    socket.readyState = harness.MockWebSocket.OPEN;
    socket.onopen?.();

    const monthlyEvents: unknown[] = [];
    const fiveMinuteEvents: unknown[] = [];
    const releaseMonthly = client.subscribeKline(
      { symbol: 'BTCUSDT_PERP', interval: '1M' },
      (message: unknown) => monthlyEvents.push(message),
    );
    const releaseFiveMinute = client.subscribeKline(
      { symbol: 'BTCUSDT_PERP', interval: '5m' },
      (message: unknown) => fiveMinuteEvents.push(message),
    );

    socket.onmessage?.(klineSnapshot('5m'));
    assert.deepEqual(monthlyEvents, []);
    assert.equal(fiveMinuteEvents.length, 1);

    assert.deepEqual(
      socket.sent
        .map((item) => JSON.parse(item))
        .filter((item) => item.domain === 'kline')
        .map((item) => `${item.op}:${item.interval}`),
      ['subscribe:1M', 'unsubscribe:1M', 'subscribe:5m'],
    );

    releaseFiveMinute();
    releaseMonthly();
    assert.deepEqual(
      socket.sent
        .map((item) => JSON.parse(item))
        .filter((item) => item.domain === 'kline')
        .map((item) => `${item.op}:${item.interval}`),
      ['subscribe:1M', 'unsubscribe:1M', 'subscribe:5m', 'unsubscribe:5m'],
      'retired monthly owner must not be subscribed again',
    );
    releaseMarket();
  } finally {
    harness.restore();
  }
});


test('disconnect retires every kline event owner before stale socket delivery', () => {
  const harness = installRealtimeHarness();

  try {
    const client = new harness.realtimeModule.ContractMarketRealtimeClient();
    const releaseMarket = client.setMarketSession('BTCUSDT_PERP');
    const socket = harness.sockets[0];
    socket.readyState = harness.MockWebSocket.OPEN;
    socket.onopen?.();

    const received: unknown[] = [];
    const releaseKline = client.subscribeKline(
      { symbol: 'BTCUSDT_PERP', interval: '5m' },
      (message: unknown) => received.push(message),
    );
    const staleDelivery = socket.onmessage;

    client.disconnect();
    staleDelivery?.(klineSnapshot('5m'));
    releaseKline();
    releaseMarket();

    assert.deepEqual(received, []);
  } finally {
    harness.restore();
  }
});
