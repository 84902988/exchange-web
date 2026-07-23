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
  const intervals = new Map<number, () => void>();
  const windowListeners = new Map<string, Set<() => void>>();
  const documentListeners = new Map<string, Set<() => void>>();
  const timeoutDelays: number[] = [];
  let timerSequence = 0;

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
  const originalDocument = globalThis.document;
  const originalWebSocket = globalThis.WebSocket;
  const originalRandom = Math.random;
  Math.random = () => 0.5;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      setTimeout(callback: () => void, delay = 0) {
        timeoutDelays.push(delay);
        callback();
        return ++timerSequence;
      },
      clearTimeout() {},
      setInterval(callback: () => void) {
        const id = ++timerSequence;
        intervals.set(id, callback);
        return id;
      },
      clearInterval(id: number) {
        intervals.delete(id);
      },
      addEventListener(type: string, callback: () => void) {
        const bucket = windowListeners.get(type) ?? new Set();
        bucket.add(callback);
        windowListeners.set(type, bucket);
      },
      removeEventListener(type: string, callback: () => void) {
        windowListeners.get(type)?.delete(callback);
      },
    },
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      visibilityState: 'visible',
      addEventListener(type: string, callback: () => void) {
        const bucket = documentListeners.get(type) ?? new Set();
        bucket.add(callback);
        documentListeners.set(type, bucket);
      },
      removeEventListener(type: string, callback: () => void) {
        documentListeners.get(type)?.delete(callback);
      },
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
    timeoutDelays,
    runHeartbeat() {
      for (const callback of Array.from(intervals.values())) callback();
    },
    intervalCount() {
      return intervals.size;
    },
    emitWindow(type: string) {
      for (const callback of windowListeners.get(type) ?? []) callback();
    },
    emitDocument(type: string) {
      for (const callback of documentListeners.get(type) ?? []) callback();
    },
    restore() {
      Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
      Object.defineProperty(globalThis, 'document', { configurable: true, value: originalDocument });
      Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: originalWebSocket });
      Math.random = originalRandom;
    },
  };
}


function klineSnapshot(interval: string, symbol = 'BTCUSDT_PERP') {
  return {
    data: JSON.stringify({
      type: 'contract_kline_snapshot',
      domain: 'kline',
      symbol,
      interval,
      kline: {
        symbol,
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


function klineCommands(socket: { sent: string[] }) {
  return socket.sent
    .map((item) => JSON.parse(item))
    .filter((item) => item.domain === 'kline')
    .map((item) => `${item.op}:${item.symbol}:${item.interval}`);
}


test('domain mode routes candle preview only through the kline preview channel', () => {
  const harness = installRealtimeHarness();

  try {
    const client = new harness.realtimeModule.ContractMarketRealtimeClient();
    const releaseMarket = client.setMarketSession('BTCUSDT_PERP');
    const socket = harness.sockets[0];
    socket.readyState = harness.MockWebSocket.OPEN;
    socket.onopen?.();
    const previewEvents: unknown[] = [];
    const klineEvents: unknown[] = [];
    const tradeEvents: unknown[] = [];
    const releasePreview = client.subscribe('preview', (message: unknown) => previewEvents.push(message));
    const releaseKline = client.subscribe('kline', (message: unknown) => klineEvents.push(message));
    const releaseTrade = client.subscribe('trade', (message: unknown) => tradeEvents.push(message));
    const message = {
      type: 'contract_candle_preview_update',
      domain: 'kline',
      symbol: 'BTCUSDT_PERP',
      interval: '1m',
      preview: { close: '100', volume: '5' },
    };

    socket.onmessage?.({ data: JSON.stringify(message) });
    socket.onmessage?.({ data: JSON.stringify({ ...message, domain: 'market' }) });

    assert.deepEqual(previewEvents, [message]);
    assert.deepEqual(klineEvents, []);
    assert.deepEqual(tradeEvents, []);
    releaseTrade();
    releaseKline();
    releasePreview();
    releaseMarket();
  } finally {
    harness.restore();
  }
});

test('latest preview replay is scoped by symbol and interval and cleared at a socket boundary', () => {
  const harness = installRealtimeHarness();

  try {
    const client = new harness.realtimeModule.ContractMarketRealtimeClient();
    const releaseMarket = client.setMarketSession('BTCUSDT_PERP');
    const socket = harness.sockets[0];
    socket.readyState = harness.MockWebSocket.OPEN;
    socket.onopen?.();
    const preview = {
      type: 'contract_candle_preview_update',
      domain: 'kline',
      symbol: 'BTCUSDT_PERP',
      interval: '1m',
      preview: { close: '100', volume: '5' },
    };

    socket.onmessage?.({ data: JSON.stringify(preview) });

    assert.deepEqual(
      client.getLatestPreview({ symbol: 'btcusdt_perp', interval: '1m' }),
      preview,
    );
    assert.equal(
      client.getLatestPreview({ symbol: 'BTCUSDT_PERP', interval: '5m' }),
      null,
    );
    assert.equal(
      client.getLatestPreview({ symbol: 'ETHUSDT_PERP', interval: '1m' }),
      null,
    );

    client.disconnect();
    assert.equal(
      client.getLatestPreview({ symbol: 'BTCUSDT_PERP', interval: '1m' }),
      null,
    );
    releaseMarket();
  } finally {
    harness.restore();
  }
});


test('trade settlement emits embedded preview before trade in one websocket task', () => {
  const harness = installRealtimeHarness();

  try {
    const client = new harness.realtimeModule.ContractMarketRealtimeClient();
    const releaseMarket = client.setMarketSession('BTCUSDT_PERP');
    const socket = harness.sockets[0];
    socket.readyState = harness.MockWebSocket.OPEN;
    socket.onopen?.();
    const events: string[] = [];
    const previews: unknown[] = [];
    const trades: unknown[] = [];
    const releasePreview = client.subscribe('preview', (message: unknown) => {
      events.push('preview');
      previews.push(message);
    });
    const releaseTrade = client.subscribe('trade', (message: unknown) => {
      events.push('trade');
      trades.push(message);
    });
    const preview = {
      type: 'contract_candle_preview_update',
      domain: 'kline',
      symbol: 'BTCUSDT_PERP',
      interval: '1m',
      settlement_revision: 'contract:BTCUSDT_PERP:1m:3:1:3:8:1',
      preview: { close: '101', volume: '11' },
    };
    const trade = {
      type: 'contract_trade',
      domain: 'market',
      symbol: 'BTCUSDT_PERP',
      settlement_revision: preview.settlement_revision,
      trades: [{ id: 'trade-1', price: '101', qty: '1' }],
      candle_previews: [preview],
    };

    socket.onmessage?.({ data: JSON.stringify(trade) });

    assert.deepEqual(events, ['preview', 'trade']);
    assert.deepEqual(previews, [preview]);
    assert.deepEqual(trades, [trade]);
    releaseTrade();
    releasePreview();
    releaseMarket();
  } finally {
    harness.restore();
  }
});


test('domain socket subscribes to K-line before market bootstrap', () => {
  const harness = installRealtimeHarness();

  try {
    const client = new harness.realtimeModule.ContractMarketRealtimeClient();
    const releaseMarket = client.setMarketSession('BTCUSDT_PERP');
    const releaseKline = client.subscribeKline(
      { symbol: 'BTCUSDT_PERP', interval: '1m' },
      () => undefined,
    );
    const socket = harness.sockets[0];
    socket.readyState = harness.MockWebSocket.OPEN;
    socket.onopen?.();

    assert.deepEqual(
      socket.sent
        .map((item) => JSON.parse(item))
        .filter((item) => item.op === 'subscribe')
        .map((item) => item.domain),
      ['kline', 'market'],
    );

    releaseKline();
    releaseMarket();
  } finally {
    harness.restore();
  }
});


test('bootstrap snapshot settles K-line then preview before exposing Header trade', () => {
  const harness = installRealtimeHarness();

  try {
    const client = new harness.realtimeModule.ContractMarketRealtimeClient();
    const releaseMarket = client.setMarketSession('BTCUSDT_PERP');
    const events: string[] = [];
    const releaseKline = client.subscribeKline(
      { symbol: 'BTCUSDT_PERP', interval: '1m' },
      () => events.push('kline'),
    );
    const releasePreview = client.subscribe('preview', () => events.push('preview'));
    const releaseTrade = client.subscribe('trade', () => events.push('trade'));
    const socket = harness.sockets[0];
    socket.readyState = harness.MockWebSocket.OPEN;
    socket.onopen?.();
    const preview = {
      type: 'contract_candle_preview_update',
      domain: 'kline',
      symbol: 'BTCUSDT_PERP',
      interval: '1m',
      preview: { close: '101', volume: '11' },
    };

    socket.onmessage?.({
      data: JSON.stringify({
        type: 'contract_market_snapshot',
        symbol: 'BTCUSDT_PERP',
        interval: '1m',
        data: {
          klines: {
            '1m': {
              symbol: 'BTCUSDT_PERP',
              interval: '1m',
              open_time: 1_717_000_000_000,
              open: '100',
              high: '101',
              low: '99',
              close: '100.5',
              volume: '10',
            },
          },
          candle_previews: [preview],
          trades: [{ id: 'trade-1', price: '101', qty: '1' }],
        },
      }),
    });

    assert.deepEqual(events, ['kline', 'preview', 'trade']);

    releaseTrade();
    releasePreview();
    releaseKline();
    releaseMarket();
  } finally {
    harness.restore();
  }
});


test('failed 1m to 1H resolution candidate rolls back only to the explicitly committed minute owner', () => {
  const harness = installRealtimeHarness();

  try {
    const client = new harness.realtimeModule.ContractMarketRealtimeClient();
    const releaseMarket = client.setMarketSession('BTCUSDT_PERP');
    const socket = harness.sockets[0];
    socket.readyState = harness.MockWebSocket.OPEN;
    socket.onopen?.();

    const minuteEvents: unknown[] = [];
    const hourlyEvents: unknown[] = [];
    const minuteIdentity = {
      symbol: 'BTCUSDT_PERP',
      interval: '1m',
      ownerId: 'minute-owner',
      transitionGeneration: 1,
    };
    assert.equal(client.beginKlineResolutionTransition(minuteIdentity), true);
    const releaseMinute = client.subscribeKline(
      { symbol: 'BTCUSDT_PERP', interval: '1m', transitionGeneration: 1 },
      (message: unknown) => minuteEvents.push(message),
    );
    assert.equal(client.commitKlineResolutionTransition(minuteIdentity), true);
    const hourlyIdentity = {
      symbol: 'BTCUSDT_PERP',
      interval: '1h',
      ownerId: 'hourly-owner',
      transitionGeneration: 2,
    };
    assert.equal(client.beginKlineResolutionTransition(hourlyIdentity), true);
    const releaseHourly = client.subscribeKline(
      { symbol: 'BTCUSDT_PERP', interval: '1H', transitionGeneration: 2 },
      (message: unknown) => hourlyEvents.push(message),
    );

    socket.onmessage?.(klineSnapshot('1h'));
    assert.deepEqual(minuteEvents, []);
    assert.equal(hourlyEvents.length, 1);

    assert.deepEqual(
      klineCommands(socket),
      [
        'subscribe:BTCUSDT_PERP:1m',
        'unsubscribe:BTCUSDT_PERP:1m',
        'subscribe:BTCUSDT_PERP:1h',
      ],
    );

    assert.equal(client.rollbackKlineResolutionTransition(hourlyIdentity), true);
    socket.onmessage?.(klineSnapshot('1m'));
    assert.equal(minuteEvents.length, 1);
    assert.equal(hourlyEvents.length, 1);
    assert.deepEqual(
      klineCommands(socket),
      [
        'subscribe:BTCUSDT_PERP:1m',
        'unsubscribe:BTCUSDT_PERP:1m',
        'subscribe:BTCUSDT_PERP:1h',
        'unsubscribe:BTCUSDT_PERP:1h',
        'subscribe:BTCUSDT_PERP:1m',
      ],
    );

    releaseHourly();
    releaseMinute();
    assert.equal(client.releaseKlineResolutionOwner(minuteIdentity), true);
    assert.equal(klineCommands(socket).at(-1), 'unsubscribe:BTCUSDT_PERP:1m');
    releaseMarket();
  } finally {
    harness.restore();
  }
});


test('successful 1W to 1m commit permanently rejects the old callback even after a delayed delivery', () => {
  const harness = installRealtimeHarness();

  try {
    const client = new harness.realtimeModule.ContractMarketRealtimeClient();
    const releaseMarket = client.setMarketSession('BTCUSDT_PERP');
    const socket = harness.sockets[0];
    socket.readyState = harness.MockWebSocket.OPEN;
    socket.onopen?.();

    const weeklyEvents: unknown[] = [];
    const minuteEvents: unknown[] = [];
    const weeklyIdentity = {
      symbol: 'BTCUSDT_PERP',
      interval: '1w',
      ownerId: 'weekly-owner',
      transitionGeneration: 1,
    };
    client.beginKlineResolutionTransition(weeklyIdentity);
    const releaseWeekly = client.subscribeKline(
      { symbol: 'BTCUSDT_PERP', interval: '1w', transitionGeneration: 1 },
      (message: unknown) => weeklyEvents.push(message),
    );
    client.commitKlineResolutionTransition(weeklyIdentity);
    const minuteIdentity = {
      symbol: 'BTCUSDT_PERP',
      interval: '1m',
      ownerId: 'minute-owner',
      transitionGeneration: 2,
    };
    client.beginKlineResolutionTransition(minuteIdentity);
    const releaseMinute = client.subscribeKline(
      { symbol: 'BTCUSDT_PERP', interval: '1m', transitionGeneration: 2 },
      (message: unknown) => minuteEvents.push(message),
    );
    client.commitKlineResolutionTransition(minuteIdentity);

    socket.onmessage?.(klineSnapshot('1w'));
    socket.onmessage?.(klineSnapshot('1m'));
    assert.equal(weeklyEvents.length, 0);
    assert.equal(minuteEvents.length, 1);

    const releaseStaleWeekly = client.subscribeKline(
      { symbol: 'BTCUSDT_PERP', interval: '1w', transitionGeneration: 1 },
      (message: unknown) => weeklyEvents.push(message),
    );
    socket.onmessage?.(klineSnapshot('1w'));
    socket.onmessage?.(klineSnapshot('1m'));
    assert.equal(minuteEvents.length, 2);
    assert.deepEqual(weeklyEvents, []);
    assert.deepEqual(
      klineCommands(socket),
      [
        'subscribe:BTCUSDT_PERP:1w',
        'unsubscribe:BTCUSDT_PERP:1w',
        'subscribe:BTCUSDT_PERP:1m',
      ],
    );

    releaseStaleWeekly();
    releaseWeekly();
    releaseMinute();
    assert.equal(client.releaseKlineResolutionOwner(minuteIdentity), true);
    releaseMarket();
  } finally {
    harness.restore();
  }
});


test('1M transition keeps exact monthly identity through subscribe and unsubscribe', () => {
  const harness = installRealtimeHarness();

  try {
    const client = new harness.realtimeModule.ContractMarketRealtimeClient();
    const releaseMarket = client.setMarketSession('BTCUSDT_PERP');
    const socket = harness.sockets[0];
    socket.readyState = harness.MockWebSocket.OPEN;
    socket.onopen?.();
    const monthlyIdentity = {
      symbol: 'BTCUSDT_PERP',
      interval: '1M',
      ownerId: 'monthly-owner',
      transitionGeneration: 7,
    };

    assert.equal(client.beginKlineResolutionTransition(monthlyIdentity), true);
    const releaseMonthly = client.subscribeKline(
      { symbol: 'BTCUSDT_PERP', interval: '1M', transitionGeneration: 7 },
      () => undefined,
    );
    assert.equal(client.commitKlineResolutionTransition(monthlyIdentity), true);
    releaseMonthly();
    assert.equal(client.releaseKlineResolutionOwner(monthlyIdentity), true);

    assert.deepEqual(klineCommands(socket), [
      'subscribe:BTCUSDT_PERP:1M',
      'unsubscribe:BTCUSDT_PERP:1M',
    ]);
    releaseMarket();
  } finally {
    harness.restore();
  }
});


test('BTC to ETH destroys every prior-symbol owner without changing market-domain ownership', () => {
  const harness = installRealtimeHarness();

  try {
    const client = new harness.realtimeModule.ContractMarketRealtimeClient();
    const releaseBtcMarket = client.setMarketSession('BTCUSDT_PERP');
    const socket = harness.sockets[0];
    socket.readyState = harness.MockWebSocket.OPEN;
    socket.onopen?.();

    const btcEvents: unknown[] = [];
    const ethEvents: unknown[] = [];
    const releaseBtcMinute = client.subscribeKline(
      { symbol: 'BTCUSDT_PERP', interval: '1m' },
      (message: unknown) => btcEvents.push(message),
    );
    const releaseBtcDaily = client.subscribeKline(
      { symbol: 'BTCUSDT_PERP', interval: '1d' },
      (message: unknown) => btcEvents.push(message),
    );

    const releaseEthMarket = client.setMarketSession('ETHUSDT_PERP');
    const releaseEthMinute = client.subscribeKline(
      { symbol: 'ETHUSDT_PERP', interval: '1m' },
      (message: unknown) => ethEvents.push(message),
    );
    releaseBtcDaily();
    releaseBtcMinute();
    releaseBtcMarket();

    socket.onmessage?.(klineSnapshot('1m', 'BTCUSDT_PERP'));
    socket.onmessage?.(klineSnapshot('1m', 'ETHUSDT_PERP'));
    assert.deepEqual(btcEvents, []);
    assert.equal(ethEvents.length, 1);
    assert.deepEqual(
      socket.sent
        .map((item) => JSON.parse(item))
        .filter((item) => item.domain === 'market')
        .map((item) => `${item.op}:${item.symbol}`),
      [
        'subscribe:BTCUSDT_PERP',
        'unsubscribe:BTCUSDT_PERP',
        'subscribe:ETHUSDT_PERP',
      ],
    );
    assert.deepEqual(
      klineCommands(socket),
      [
        'subscribe:BTCUSDT_PERP:1m',
        'unsubscribe:BTCUSDT_PERP:1m',
        'subscribe:BTCUSDT_PERP:1d',
        'unsubscribe:BTCUSDT_PERP:1d',
        'subscribe:ETHUSDT_PERP:1m',
      ],
    );

    releaseEthMinute();
    releaseEthMarket();
  } finally {
    harness.restore();
  }
});


test('disconnect destroys every kline owner and later releases cannot restore one', () => {
  const harness = installRealtimeHarness();

  try {
    const client = new harness.realtimeModule.ContractMarketRealtimeClient();
    const releaseMarket = client.setMarketSession('BTCUSDT_PERP');
    const socket = harness.sockets[0];
    socket.readyState = harness.MockWebSocket.OPEN;
    socket.onopen?.();

    const minuteEvents: unknown[] = [];
    const dailyEvents: unknown[] = [];
    const releaseMinute = client.subscribeKline(
      { symbol: 'BTCUSDT_PERP', interval: '1m' },
      (message: unknown) => minuteEvents.push(message),
    );
    const releaseDaily = client.subscribeKline(
      { symbol: 'BTCUSDT_PERP', interval: '1d' },
      (message: unknown) => dailyEvents.push(message),
    );
    const staleDelivery = socket.onmessage;
    const commandsBeforeDisconnect = [...socket.sent];

    client.disconnect();
    staleDelivery?.(klineSnapshot('1m'));
    releaseDaily();
    releaseMinute();
    releaseMarket();

    assert.deepEqual(minuteEvents, []);
    assert.deepEqual(dailyEvents, []);
    assert.deepEqual(socket.sent, commandsBeforeDisconnect);
  } finally {
    harness.restore();
  }
});


test('destroyed client generation cannot deliver into a recreated owner', () => {
  const harness = installRealtimeHarness();

  try {
    const retiredEvents: unknown[] = [];
    const firstClient = new harness.realtimeModule.ContractMarketRealtimeClient();
    const releaseFirstMarket = firstClient.setMarketSession('BTCUSDT_PERP');
    const firstSocket = harness.sockets[0];
    firstSocket.readyState = harness.MockWebSocket.OPEN;
    firstSocket.onopen?.();
    const releaseFirstKline = firstClient.subscribeKline(
      { symbol: 'BTCUSDT_PERP', interval: '1m' },
      (message: unknown) => retiredEvents.push(message),
    );
    const staleDelivery = firstSocket.onmessage;
    firstClient.disconnect();

    const recreatedEvents: unknown[] = [];
    const recreatedClient = new harness.realtimeModule.ContractMarketRealtimeClient();
    const releaseRecreatedMarket = recreatedClient.setMarketSession('BTCUSDT_PERP');
    const recreatedSocket = harness.sockets[1];
    recreatedSocket.readyState = harness.MockWebSocket.OPEN;
    recreatedSocket.onopen?.();
    const releaseRecreatedKline = recreatedClient.subscribeKline(
      { symbol: 'BTCUSDT_PERP', interval: '1m' },
      (message: unknown) => recreatedEvents.push(message),
    );

    staleDelivery?.(klineSnapshot('1m'));
    recreatedSocket.onmessage?.(klineSnapshot('1m'));

    assert.deepEqual(retiredEvents, []);
    assert.equal(recreatedEvents.length, 1);
    releaseFirstKline();
    releaseFirstMarket();
    releaseRecreatedKline();
    releaseRecreatedMarket();
  } finally {
    harness.restore();
  }
});

test('heartbeat accepts JSON pong as activity and reconnects only after all traffic is stale', () => {
  const harness = installRealtimeHarness();
  const originalNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;

  try {
    const client = new harness.realtimeModule.ContractMarketRealtimeClient();
    const releaseMarket = client.setMarketSession('AAPL_USD');
    const socket = harness.sockets[0];
    socket.readyState = harness.MockWebSocket.OPEN;
    socket.onopen?.();

    now += 18_000;
    harness.runHeartbeat();
    assert.equal(socket.sent.at(-1), 'ping');

    socket.onmessage?.({ data: JSON.stringify({ type: 'pong' }) });
    now += 35_000;
    harness.runHeartbeat();
    assert.equal(socket.readyState, harness.MockWebSocket.OPEN);

    now += 1_001;
    harness.runHeartbeat();
    assert.equal(socket.readyState, harness.MockWebSocket.CLOSED);
    assert.equal(client.getStatus(), 'reconnecting');

    socket.onclose?.();
    assert.equal(harness.sockets.length, 2);
    assert.equal(harness.timeoutDelays.at(-1), 1_500);
    releaseMarket();
  } finally {
    Date.now = originalNow;
    harness.restore();
  }
});

test('visible and online checks probe one existing socket without creating another connection', () => {
  const harness = installRealtimeHarness();

  try {
    const client = new harness.realtimeModule.ContractMarketRealtimeClient();
    const releaseMarket = client.setMarketSession('BTCUSDT_PERP');
    const socket = harness.sockets[0];
    socket.readyState = harness.MockWebSocket.OPEN;
    socket.onopen?.();

    harness.emitDocument('visibilitychange');
    harness.emitWindow('online');

    assert.equal(harness.sockets.length, 1);
    assert.deepEqual(socket.sent.slice(-2), ['ping', 'ping']);
    releaseMarket();
  } finally {
    harness.restore();
  }
});

test('reconnect delay backs off across failures until a message proves recovery', () => {
  const harness = installRealtimeHarness();

  try {
    const client = new harness.realtimeModule.ContractMarketRealtimeClient();
    const releaseMarket = client.setMarketSession('EURUSD');
    const first = harness.sockets[0];
    first.readyState = harness.MockWebSocket.OPEN;
    first.onopen?.();
    first.onclose?.();

    const second = harness.sockets[1];
    second.readyState = harness.MockWebSocket.OPEN;
    second.onopen?.();
    second.onclose?.();

    assert.deepEqual(harness.timeoutDelays.slice(-2), [1_500, 3_000]);

    const third = harness.sockets[2];
    third.readyState = harness.MockWebSocket.OPEN;
    third.onopen?.();
    third.onmessage?.({ data: JSON.stringify({ type: 'pong' }) });
    third.onclose?.();
    assert.equal(harness.timeoutDelays.at(-1), 1_500);
    releaseMarket();
  } finally {
    harness.restore();
  }
});

test('a retired socket close cannot stop the replacement heartbeat', () => {
  const harness = installRealtimeHarness();

  try {
    const client = new harness.realtimeModule.ContractMarketRealtimeClient();
    const releaseMarket = client.setMarketSession('BTCUSDT_PERP');
    const first = harness.sockets[0];
    first.readyState = harness.MockWebSocket.OPEN;
    first.onopen?.();
    const retiredClose = first.onclose;
    retiredClose?.();

    const replacement = harness.sockets[1];
    replacement.readyState = harness.MockWebSocket.OPEN;
    replacement.onopen?.();
    assert.equal(harness.intervalCount(), 1);

    retiredClose?.();
    assert.equal(harness.intervalCount(), 1);
    harness.runHeartbeat();
    assert.equal(replacement.sent.at(-1), 'ping');
    assert.equal(harness.sockets.length, 2);
    releaseMarket();
  } finally {
    harness.restore();
  }
});
