import {
  normalizeContractMarketViewPayload,
  type ContractMarketView,
} from '../src/api/contract';
import {
  ContractMarketRealtimeStore,
  buildContractKlineDomainMessage,
  buildContractMarketSubscribeMessage,
  buildContractMarketWsUrl,
  type ContractRealtimeTransportHandlers,
} from '../src/realtime/contractMarketRealtime';
import type {
  PublicWebSocketLike,
  PublicWebSocketStatus,
} from '../src/realtime/managedPublicWebSocket';

const SYMBOL = 'BTCUSDT_PERP';

class WiringSocket implements PublicWebSocketLike {
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: {data: unknown}) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  send = jest.fn((_data: string) => undefined);
  close = jest.fn((_code?: number, _reason?: string) => {
    this.readyState = 3;
  });

  open() {
    this.readyState = 1;
    this.onopen?.({});
  }

  serverClose() {
    this.readyState = 3;
    this.onclose?.({});
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return {promise, reject, resolve};
}

function marketPayload({
  bid = 100,
  ask = 101,
  envelopeTimeMs = 10_000,
  receivedAtMs = 9_900,
  ttlMs = 1_500,
  generation = 1,
  sequence = 1,
  stale = false,
  executable = true,
  symbol = SYMBOL,
}: {
  bid?: number;
  ask?: number;
  envelopeTimeMs?: number;
  receivedAtMs?: number;
  ttlMs?: number;
  generation?: number | null;
  sequence?: number;
  stale?: boolean;
  executable?: boolean;
  symbol?: string;
} = {}) {
  const metadata = (domain: 'ticker' | 'depth') => ({
    domain,
    symbol,
    source: stale ? 'STALE_CACHE' : 'LIVE_WS',
    provider: 'TEST_PROVIDER',
    provider_symbol: 'BTC-USDT-SWAP',
    transport: stale ? 'CACHE_READ' : 'PROVIDER_WS',
    freshness: stale ? 'STALE' : 'LIVE',
    provider_generation: generation,
    revision: {
      epoch: generation,
      sequence,
      is_closed: null,
      checksum: `${sequence}`,
    },
    received_at_ms: receivedAtMs,
    age_ms: envelopeTimeMs - receivedAtMs,
    ttl_ms: ttlMs,
    stale,
    completeness: {
      status: 'COMPLETE',
      has_data: true,
      item_count: domain === 'depth' ? 2 : 7,
      missing_fields: [],
    },
  });
  return {
    symbol,
    view_version: '2',
    authority_source: 'SNAPSHOT_AUTHORITY',
    snapshot_authority: true,
    market_status: 'OPEN',
    display_state: executable ? 'LIVE_TRADABLE' : 'DISPLAY_ONLY',
    display_price: ask,
    mark_price: (bid + ask) / 2,
    index_price: bid,
    best_bid: bid,
    best_ask: ask,
    executable,
    execution_bid: executable ? bid : null,
    execution_ask: executable ? ask : null,
    execution_mode: executable ? 'LIVE_BBO' : 'DISABLED',
    reason_code: executable ? 'LIVE_BBO' : 'NOT_LIVE',
    price_age_ms: Math.max(0, envelopeTimeMs - receivedAtMs),
    ticker_freshness: stale ? 'STALE' : 'LIVE',
    depth_freshness: stale ? 'STALE' : 'LIVE',
    trades_freshness: 'RECENT',
    ticker: {
      symbol,
      last_price: ask,
      mark_price: (bid + ask) / 2,
      index_price: bid,
      bid_price: bid,
      ask_price: ask,
      price_precision: 2,
    },
    depth: {
      symbol,
      bids: [[bid, 2]],
      asks: [[ask, 3]],
      price_precision: 2,
    },
    trades: [],
    snapshot_metadata: {
      ticker: metadata('ticker'),
      depth: metadata('depth'),
      trades: null,
      kline: null,
    },
    warnings: [],
  };
}

function marketView(
  overrides: Parameters<typeof marketPayload>[0] = {},
): ContractMarketView {
  return normalizeContractMarketViewPayload(
    marketPayload(overrides),
    overrides.symbol || SYMBOL,
  );
}

function createHarness({
  initialFetch,
  marketStateTimeoutMs = 60_000,
}: {
  initialFetch?: Promise<ContractMarketView>;
  marketStateTimeoutMs?: number;
} = {}) {
  let handlers!: ContractRealtimeTransportHandlers;
  let status: PublicWebSocketStatus = 'idle';
  let nowMs = 10_020;
  const pending =
    initialFetch === undefined
      ? deferred<ContractMarketView>()
      : null;
  const fetchMarketView = jest.fn(
    (_symbol: string, _options: {signal?: AbortSignal}) =>
      initialFetch || pending!.promise,
  );
  const transport = {
    start: jest.fn(() => {
      status = 'connecting';
      handlers.onStatusChange(status);
    }),
    stop: jest.fn(() => {
      status = 'stopped';
      handlers.onStatusChange(status);
    }),
    restart: jest.fn(() => {
      status = 'reconnecting';
      handlers.onStatusChange(status);
    }),
    send: jest.fn(() => true),
    getStatus: jest.fn(() => status),
  };
  const store = new ContractMarketRealtimeStore(SYMBOL, {
    fetchMarketView,
    createTransport: nextHandlers => {
      handlers = nextHandlers;
      return transport;
    },
    now: () => nowMs,
    fallbackIntervalMs: 5_000,
    marketStateTimeoutMs,
  });

  return {
    fetchMarketView,
    handlers,
    open: () => {
      status = 'open';
      handlers.onStatusChange(status);
    },
    pending,
    reconnecting: () => {
      status = 'reconnecting';
      handlers.onStatusChange(status);
    },
    sendMarketState: (
      payload: ReturnType<typeof marketPayload>,
      ts = 10_000,
    ) => {
      handlers.onMessage(
        JSON.stringify({
          type: 'contract_market_state',
          domain: 'market',
          symbol: payload.symbol,
          ts,
          data: payload,
          market_state: payload,
        }),
      );
    },
    sendSnapshot: (
      payload: ReturnType<typeof marketPayload>,
      ts = 10_000,
    ) => {
      handlers.onMessage(
        JSON.stringify({
          type: 'contract_market_snapshot',
          symbol: payload.symbol,
          ts,
          data: {market_state: payload},
        }),
      );
    },
    setNow: (value: number) => {
      nowMs = value;
    },
    store,
    transport,
  };
}

describe('ContractMarketRealtimeStore', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('builds the Contract market-domain URL and replay message', () => {
    expect(buildContractMarketWsUrl('btcusdt_perp')).toContain(
      '/contract/market/ws?symbol=BTCUSDT_PERP&interval=1m',
    );
    expect(
      JSON.parse(buildContractMarketSubscribeMessage('btcusdt_perp')),
    ).toEqual({
      op: 'subscribe',
      domain: 'market',
      symbol: SYMBOL,
    });
  });

  it('wires the default managed transport to replay market subscription after reconnect', () => {
    const originalWebSocket = globalThis.WebSocket;
    const sockets: WiringSocket[] = [];
    const webSocketConstructor = jest.fn((_url: string) => {
      const socket = new WiringSocket();
      sockets.push(socket);
      return socket;
    });
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      writable: true,
      value: webSocketConstructor,
    });
    const pending = deferred<ContractMarketView>();
    const store = new ContractMarketRealtimeStore(SYMBOL, {
      fetchMarketView: () => pending.promise,
      now: () => 10_020,
    });

    try {
      const release = store.acquire('screen');
      expect(webSocketConstructor).toHaveBeenCalledTimes(1);
      sockets[0].open();
      expect(sockets[0].send).toHaveBeenCalledWith(
        buildContractMarketSubscribeMessage(SYMBOL),
      );

      sockets[0].serverClose();
      jest.advanceTimersByTime(2_000);
      expect(webSocketConstructor).toHaveBeenCalledTimes(2);
      sockets[1].open();
      expect(sockets[1].send).toHaveBeenCalledWith(
        buildContractMarketSubscribeMessage(SYMBOL),
      );
      release();
    } finally {
      Object.defineProperty(globalThis, 'WebSocket', {
        configurable: true,
        writable: true,
        value: originalWebSocket,
      });
    }
  });

  it('multiplexes Market before Kline on one socket and keeps their owner lifecycles independent', () => {
    const originalWebSocket = globalThis.WebSocket;
    const sockets: WiringSocket[] = [];
    const webSocketConstructor = jest.fn((_url: string) => {
      const socket = new WiringSocket();
      sockets.push(socket);
      return socket;
    });
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      writable: true,
      value: webSocketConstructor,
    });
    const pending = deferred<ContractMarketView>();
    const store = new ContractMarketRealtimeStore(SYMBOL, {
      fetchMarketView: () => pending.promise,
    });
    const klineHandlers = {
      onMessage: jest.fn(),
      onStatusChange: jest.fn(),
      onActiveChange: jest.fn(),
    };

    try {
      const releaseKline = store.acquireKlineDomain(
        'chart',
        '5m',
        klineHandlers,
      );
      const releaseMarket = store.acquire('screen');
      expect(webSocketConstructor).toHaveBeenCalledTimes(1);
      expect(webSocketConstructor.mock.calls[0][0]).toContain(
        'interval=5m',
      );

      sockets[0].open();
      expect(sockets[0].send.mock.calls.map(call => call[0])).toEqual([
        buildContractMarketSubscribeMessage(SYMBOL),
        buildContractKlineDomainMessage(
          'subscribe',
          SYMBOL,
          '5m',
        ),
      ]);

      releaseMarket();
      expect(sockets[0].send).toHaveBeenLastCalledWith(
        JSON.stringify({
          op: 'unsubscribe',
          domain: 'market',
          symbol: SYMBOL,
        }),
      );
      expect(sockets[0].close).not.toHaveBeenCalled();

      releaseKline();
      expect(sockets[0].close).toHaveBeenCalledTimes(1);
    } finally {
      store.destroy();
      Object.defineProperty(globalThis, 'WebSocket', {
        configurable: true,
        writable: true,
        value: originalWebSocket,
      });
    }
  });

  it('rotates only the active Kline interval and ignores a stale suspended-owner release', () => {
    const originalWebSocket = globalThis.WebSocket;
    const sockets: WiringSocket[] = [];
    const webSocketConstructor = jest.fn((_url: string) => {
      const socket = new WiringSocket();
      sockets.push(socket);
      return socket;
    });
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      writable: true,
      value: webSocketConstructor,
    });
    const pending = deferred<ContractMarketView>();
    const store = new ContractMarketRealtimeStore(SYMBOL, {
      fetchMarketView: () => pending.promise,
    });
    const handlers = () => ({
      onMessage: jest.fn(),
      onStatusChange: jest.fn(),
      onActiveChange: jest.fn(),
    });

    try {
      const releaseMarket = store.acquire('screen');
      sockets[0].open();
      sockets[0].send.mockClear();

      const release1m = store.acquireKlineDomain(
        'chart-1m',
        '1m',
        handlers(),
      );
      const release5m = store.acquireKlineDomain(
        'chart-5m',
        '5m',
        handlers(),
      );
      expect(sockets[0].send.mock.calls.map(call => call[0])).toEqual([
        buildContractKlineDomainMessage(
          'subscribe',
          SYMBOL,
          '1m',
        ),
        buildContractKlineDomainMessage(
          'unsubscribe',
          SYMBOL,
          '1m',
        ),
        buildContractKlineDomainMessage(
          'subscribe',
          SYMBOL,
          '5m',
        ),
      ]);

      sockets[0].send.mockClear();
      release1m();
      expect(sockets[0].send).not.toHaveBeenCalled();
      expect(store.resubscribeKlineDomain('1m')).toBe(false);
      expect(store.resubscribeKlineDomain('5m')).toBe(true);
      expect(sockets[0].send).toHaveBeenCalledWith(
        buildContractKlineDomainMessage(
          'subscribe',
          SYMBOL,
          '5m',
        ),
      );

      sockets[0].send.mockClear();
      release5m();
      expect(sockets[0].send).toHaveBeenCalledTimes(1);
      expect(sockets[0].send).toHaveBeenCalledWith(
        buildContractKlineDomainMessage(
          'unsubscribe',
          SYMBOL,
          '5m',
        ),
      );
      expect(sockets[0].close).not.toHaveBeenCalled();
      releaseMarket();
    } finally {
      store.destroy();
      Object.defineProperty(globalThis, 'WebSocket', {
        configurable: true,
        writable: true,
        value: originalWebSocket,
      });
    }
  });

  it('never mutates Market execution lifecycle for a Kline-only transport owner', () => {
    const harness = createHarness();
    const initialState = harness.store.getSnapshot();
    const handlers = {
      onMessage: jest.fn(),
      onStatusChange: jest.fn(),
      onActiveChange: jest.fn(),
    };

    const release = harness.store.acquireKlineDomain(
      'chart-only',
      '1m',
      handlers,
    );
    harness.open();
    release();

    expect(harness.store.getSnapshot()).toMatchObject({
      phase: initialState.phase,
      lease: initialState.lease,
      executionGeneration: initialState.executionGeneration,
      revision: initialState.revision,
    });
  });

  it('shares one transport and aborts bootstrap after the last owner releases', () => {
    const harness = createHarness();
    const releaseA = harness.store.acquire('screen');
    const releaseB = harness.store.acquire('screen');

    expect(harness.transport.start).toHaveBeenCalledTimes(1);
    expect(harness.fetchMarketView).toHaveBeenCalledTimes(1);
    const signal = harness.fetchMarketView.mock.calls[0][1].signal;
    expect(signal?.aborted).toBe(false);

    releaseA();
    expect(harness.transport.stop).not.toHaveBeenCalled();
    releaseB();

    expect(harness.transport.stop).toHaveBeenCalledTimes(1);
    expect(signal?.aborted).toBe(true);
    expect(harness.store.getSnapshot().phase).toBe('paused');
    expect(harness.store.getSnapshot().lease).toBeNull();
  });

  it('uses a combined snapshot for display but only a fresh state can mint a lease', () => {
    const harness = createHarness();
    harness.store.acquire('screen');
    harness.open();

    harness.sendSnapshot(
      marketPayload({
        receivedAtMs: 5_000,
        sequence: 1,
      }),
    );
    expect(harness.store.getSnapshot().marketView).not.toBeNull();
    expect(harness.store.getSnapshot().lease).toBeNull();

    harness.sendMarketState(
      marketPayload({receivedAtMs: 9_900, sequence: 2}),
    );
    expect(harness.store.getSnapshot().lease).toMatchObject({
      executionBid: 100,
      executionAsk: 101,
      priceAgeMs: 350,
      expiresAtMs: 10_920,
    });

    harness.setNow(5_000);
    jest.advanceTimersByTime(899);
    expect(harness.store.getSnapshot().lease).not.toBeNull();
    harness.setNow(4_000);
    jest.advanceTimersByTime(1);
    expect(harness.store.getSnapshot().lease).toBeNull();
    expect(harness.store.getSnapshot().executionRecovering).toBe(true);
  });

  it('keeps an expired live lease recoverable and resolves an execution wait only after a fresh lease arrives', async () => {
    const harness = createHarness();
    harness.store.acquire('screen');
    harness.open();
    harness.sendSnapshot(marketPayload({sequence: 0}));
    harness.sendMarketState(marketPayload({sequence: 1}));

    harness.setNow(10_921);
    jest.advanceTimersByTime(900);
    expect(harness.store.getSnapshot().lease).toBeNull();
    expect(harness.store.getSnapshot().executionRecovering).toBe(true);

    const grantPromise = harness.store.waitForExecutionLease();
    expect(harness.transport.send).toHaveBeenLastCalledWith(
      buildContractMarketSubscribeMessage(SYMBOL),
    );
    harness.setNow(10_930);
    harness.sendMarketState(
      marketPayload({
        envelopeTimeMs: 10_910,
        receivedAtMs: 10_800,
        sequence: 2,
      }),
      10_910,
    );
    jest.advanceTimersByTime(250);

    await expect(grantPromise).resolves.toMatchObject({
      lease: {executionBid: 100, executionAsk: 101},
    });
    expect(harness.store.getSnapshot().executionRecovering).toBe(false);
  });

  it('does not let REST display fallback interrupt a bounded live execution renewal', async () => {
    const harness = createHarness({
      initialFetch: Promise.resolve(marketView({sequence: 0})),
    });
    harness.store.acquire('screen');
    await Promise.resolve();
    await Promise.resolve();
    harness.open();
    harness.sendSnapshot(marketPayload({sequence: 1}));
    harness.sendMarketState(marketPayload({sequence: 2}));

    harness.setNow(10_921);
    jest.advanceTimersByTime(900);
    expect(harness.store.getSnapshot().lease).toBeNull();
    expect(harness.store.getSnapshot().executionRecovering).toBe(true);

    harness.fetchMarketView.mockResolvedValueOnce(
      marketView({receivedAtMs: 10_800, sequence: 3}),
    );
    jest.advanceTimersByTime(500);
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.store.getSnapshot()).toMatchObject({
      source: 'REST',
      lease: null,
      executionRecovering: true,
    });

    jest.advanceTimersByTime(5_499);
    expect(harness.store.getSnapshot().executionRecovering).toBe(true);
    jest.advanceTimersByTime(1);
    expect(harness.store.getSnapshot().executionRecovering).toBe(false);
  });

  it('does not let a late combined snapshot roll back accepted state authority', () => {
    const harness = createHarness();
    harness.store.acquire('screen');
    harness.open();

    harness.sendMarketState(
      marketPayload({receivedAtMs: 9_900, sequence: 1}),
    );
    harness.sendMarketState(
      marketPayload({receivedAtMs: 9_900, sequence: 2}),
    );
    const acceptedState = harness.store.getSnapshot();
    expect(acceptedState.lease).not.toBeNull();

    harness.sendSnapshot(
      marketPayload({
        receivedAtMs: 10_000,
        sequence: 3,
        executable: false,
      }),
    );

    expect(harness.store.getSnapshot()).toBe(acceptedState);
    expect(harness.store.getSnapshot().lease).toBe(acceptedState.lease);
  });

  it('coalesces display notifications while keeping the latest market state immediately readable', () => {
    const harness = createHarness();
    const listener = jest.fn();
    harness.store.subscribe(listener);
    harness.store.acquire('screen');
    harness.open();
    listener.mockClear();

    harness.sendSnapshot(
      marketPayload({sequence: 1, ask: 101}),
    );
    harness.sendSnapshot(
      marketPayload({sequence: 2, ask: 102}),
    );

    expect(harness.store.getSnapshot().marketView?.quote.lastPrice).toBe(102);
    expect(listener).not.toHaveBeenCalled();
    jest.advanceTimersByTime(249);
    expect(listener).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('notifies immediately when an executable lease is revoked', () => {
    const harness = createHarness();
    const listener = jest.fn();
    harness.store.subscribe(listener);
    harness.store.acquire('screen');
    harness.open();

    harness.sendMarketState(
      marketPayload({sequence: 1, receivedAtMs: 9_900}),
    );
    harness.sendMarketState(
      marketPayload({sequence: 2, receivedAtMs: 9_900}),
    );
    expect(harness.store.getSnapshot().lease).not.toBeNull();
    jest.advanceTimersByTime(250);
    listener.mockClear();

    harness.sendMarketState(
      marketPayload({
        sequence: 3,
        receivedAtMs: 9_900,
        executable: false,
      }),
    );

    expect(harness.store.getSnapshot().lease).toBeNull();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('does not surface invisible lease churn before the batched display state is published', () => {
    const harness = createHarness();
    const listener = jest.fn();
    harness.store.subscribe(listener);
    harness.store.acquire('screen');
    harness.open();

    harness.sendMarketState(
      marketPayload({sequence: 1, receivedAtMs: 9_900}),
    );
    listener.mockClear();
    harness.sendMarketState(
      marketPayload({sequence: 2, receivedAtMs: 9_900}),
    );
    expect(harness.store.getSnapshot().lease).not.toBeNull();
    expect(listener).not.toHaveBeenCalled();

    harness.sendMarketState(
      marketPayload({
        sequence: 3,
        receivedAtMs: 9_900,
        executable: false,
      }),
    );
    expect(harness.store.getSnapshot().lease).toBeNull();
    expect(listener).not.toHaveBeenCalled();

    jest.advanceTimersByTime(250);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(harness.store.getSnapshot().lease).toBeNull();
  });

  it('fails closed on stale lineage while tolerating a stable device/server clock offset', () => {
    const harness = createHarness();
    harness.store.acquire('screen');
    harness.open();

    harness.sendMarketState(
      marketPayload({stale: true, receivedAtMs: 9_900}),
    );
    expect(harness.store.getSnapshot().marketView).not.toBeNull();
    expect(harness.store.getSnapshot().lease).toBeNull();
    expect(harness.store.getSnapshot().executionRecovering).toBe(false);

    harness.sendMarketState(
      marketPayload({sequence: 2, receivedAtMs: 10_050}),
      10_100,
    );
    expect(harness.store.getSnapshot().lease).not.toBeNull();
  });

  it('calibrates a stable device clock offset larger than the transport safety margin', () => {
    const harness = createHarness();
    harness.store.acquire('screen');
    harness.open();
    harness.setNow(11_220);

    harness.sendMarketState(
      marketPayload({sequence: 1, receivedAtMs: 9_900}),
      10_000,
    );
    expect(harness.store.getSnapshot().lease).toBeNull();
    expect(harness.store.getSnapshot().executionRecovering).toBe(false);

    harness.setNow(11_230);
    harness.sendMarketState(
      marketPayload({sequence: 2, receivedAtMs: 9_900}),
      10_010,
    );
    expect(harness.store.getSnapshot().lease).toMatchObject({
      executionBid: 100,
      executionAsk: 101,
    });
  });

  it('fails closed when executable lineage omits generation/revision or LIVE freshness', () => {
    const harness = createHarness();
    harness.store.acquire('screen');
    harness.open();

    harness.sendMarketState(
      marketPayload({generation: null, sequence: 1}),
    );
    expect(harness.store.getSnapshot().lease).toBeNull();
    expect(harness.store.getSnapshot().executionRecovering).toBe(false);

    const freshnessHarness = createHarness();
    freshnessHarness.store.acquire('screen');
    freshnessHarness.open();
    freshnessHarness.sendSnapshot(
      marketPayload({generation: 2, sequence: 1}),
    );
    const unknownFreshness = marketPayload({
      generation: 2,
      sequence: 2,
    });
    unknownFreshness.snapshot_metadata.ticker.freshness = 'UNKNOWN';
    freshnessHarness.sendMarketState(unknownFreshness);
    expect(freshnessHarness.store.getSnapshot().lease).toBeNull();
  });

  it('requires one stable state after a provider generation transition and rejects rollback', () => {
    const harness = createHarness();
    harness.store.acquire('screen');
    harness.open();
    harness.sendSnapshot(
      marketPayload({generation: 1, sequence: 0}),
    );
    harness.sendMarketState(marketPayload({generation: 1, sequence: 1}));
    expect(harness.store.getSnapshot().lease).not.toBeNull();

    harness.sendMarketState(
      marketPayload({
        bid: 102,
        ask: 103,
        generation: 2,
        sequence: 1,
      }),
    );
    expect(harness.store.getSnapshot().lease).toBeNull();

    harness.sendMarketState(
      marketPayload({
        bid: 103,
        ask: 104,
        generation: 2,
        sequence: 2,
      }),
    );
    expect(harness.store.getSnapshot().lease).toMatchObject({
      executionBid: 103,
      executionAsk: 104,
    });
    const acceptedView = harness.store.getSnapshot().marketView;

    harness.sendMarketState(
      marketPayload({
        bid: 90,
        ask: 91,
        generation: 2,
        sequence: 1,
      }),
    );
    expect(harness.store.getSnapshot().lease).toBeNull();
    expect(harness.store.getSnapshot().marketView).toBe(
      acceptedView,
    );
  });

  it('clears execution immediately on reconnect while retaining display and using REST only as display fallback', async () => {
    const fallback = deferred<ContractMarketView>();
    const harness = createHarness({
      initialFetch: Promise.resolve(marketView()),
    });
    harness.store.acquire('screen');
    await Promise.resolve();
    await Promise.resolve();
    harness.open();
    harness.sendSnapshot(marketPayload({sequence: 1}));
    harness.sendMarketState(marketPayload({sequence: 2}));
    const retainedView = harness.store.getSnapshot().marketView;
    expect(harness.store.getSnapshot().lease).not.toBeNull();

    harness.fetchMarketView.mockImplementationOnce(
      () => fallback.promise,
    );
    harness.setNow(10_030);
    harness.reconnecting();
    jest.advanceTimersByTime(0);
    expect(harness.store.getSnapshot().lease).toBeNull();
    expect(harness.store.getSnapshot().marketView).toBe(retainedView);

    fallback.resolve(marketView({bid: 98, ask: 99, sequence: 2}));
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.store.getSnapshot().source).toBe('REST');
    expect(harness.store.getSnapshot().marketView?.quote.lastPrice).toBe(
      99,
    );
    expect(harness.store.getSnapshot().lease).toBeNull();
  });

  it('rejects a delayed first clock sample and warms up again before minting execution', () => {
    const harness = createHarness();
    harness.store.acquire('screen');
    harness.open();

    harness.setNow(20_000);
    harness.sendMarketState(
      marketPayload({sequence: 1, receivedAtMs: 9_900}),
      10_000,
    );
    expect(harness.store.getSnapshot().lease).toBeNull();

    harness.setNow(10_100);
    harness.sendMarketState(
      marketPayload({sequence: 2, receivedAtMs: 9_900}),
      10_000,
    );
    expect(harness.store.getSnapshot().lease).toBeNull();

    harness.setNow(10_110);
    harness.sendMarketState(
      marketPayload({sequence: 3, receivedAtMs: 9_900}),
      10_000,
    );
    expect(harness.store.getSnapshot().lease).toMatchObject({
      executionBid: 100,
      executionAsk: 101,
      priceAgeMs: 360,
    });
  });

  it('keeps the existing strict lease during clock recalibration and mints again after a stable rebaseline', () => {
    const harness = createHarness();
    harness.store.acquire('screen');
    harness.open();
    harness.sendSnapshot(marketPayload({sequence: 0}));
    harness.sendMarketState(marketPayload({sequence: 1}));
    const initialLease = harness.store.getSnapshot().lease;
    expect(initialLease).not.toBeNull();

    harness.setNow(10_200);
    harness.sendMarketState(
      marketPayload({sequence: 2}),
      10_000,
    );
    expect(harness.store.getSnapshot().lease).toBe(initialLease);

    harness.setNow(10_220);
    harness.sendMarketState(
      marketPayload({
        envelopeTimeMs: 10_020,
        receivedAtMs: 9_920,
        sequence: 3,
      }),
      10_020,
    );
    expect(harness.store.getSnapshot().lease).toBe(initialLease);

    harness.setNow(10_240);
    harness.sendMarketState(
      marketPayload({
        envelopeTimeMs: 10_040,
        receivedAtMs: 9_940,
        sequence: 4,
      }),
      10_040,
    );
    expect(harness.store.getSnapshot().lease).not.toBeNull();
    expect(harness.store.getSnapshot().lease).not.toBe(initialLease);
  });

  it('does not allow a late REST bootstrap to overwrite a newer WS state', async () => {
    const bootstrap = deferred<ContractMarketView>();
    const harness = createHarness({initialFetch: bootstrap.promise});
    harness.store.acquire('screen');
    harness.open();
    harness.sendMarketState(marketPayload({bid: 105, ask: 106}));
    expect(harness.store.getSnapshot().source).toBe('WS');

    bootstrap.resolve(marketView({bid: 90, ask: 91}));
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.store.getSnapshot().source).toBe('WS');
    expect(harness.store.getSnapshot().marketView?.quote.lastPrice).toBe(
      106,
    );
  });

  it('keeps REST fallback alive until an atomic market state is accepted', async () => {
    const harness = createHarness({
      initialFetch: Promise.reject(new Error('bootstrap failed')),
    });
    harness.store.acquire('screen');
    harness.open();
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.store.getSnapshot().phase).toBe('connecting');
    expect(harness.fetchMarketView).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(4_999);
    expect(harness.fetchMarketView).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(harness.fetchMarketView).toHaveBeenCalledTimes(2);

    harness.sendMarketState(marketPayload());
    harness.sendMarketState(marketPayload({sequence: 2}));
    expect(harness.store.getSnapshot().phase).toBe('live');
    jest.advanceTimersByTime(500);
    expect(harness.fetchMarketView).toHaveBeenCalledTimes(2);
    jest.advanceTimersByTime(650);
    expect(harness.store.getSnapshot().lease).toBeNull();
    jest.advanceTimersByTime(249);
    expect(harness.fetchMarketView).toHaveBeenCalledTimes(2);
    jest.advanceTimersByTime(1);
    expect(harness.fetchMarketView).toHaveBeenCalledTimes(3);
  });

  it('cancels delayed REST fallback when a fresh state closes the execution gap', async () => {
    const harness = createHarness({
      initialFetch: Promise.resolve(marketView()),
    });
    harness.store.acquire('screen');
    await Promise.resolve();
    await Promise.resolve();
    harness.open();
    harness.sendSnapshot(marketPayload({sequence: 1}));
    harness.sendMarketState(marketPayload({sequence: 2}));
    expect(harness.store.getSnapshot().lease).not.toBeNull();

    jest.advanceTimersByTime(900);
    expect(harness.store.getSnapshot().lease).toBeNull();
    jest.advanceTimersByTime(250);
    harness.sendMarketState(marketPayload({sequence: 3}));
    expect(harness.store.getSnapshot().lease).not.toBeNull();

    jest.advanceTimersByTime(300);
    expect(harness.fetchMarketView).toHaveBeenCalledTimes(1);
  });

  it('resubscribes only Market and restores REST fallback when the first domain frame is missing', async () => {
    const harness = createHarness({
      initialFetch: Promise.reject(new Error('bootstrap failed')),
      marketStateTimeoutMs: 1_000,
    });
    harness.store.acquire('screen');
    harness.open();
    await Promise.resolve();
    await Promise.resolve();

    harness.handlers.onMessage(JSON.stringify({type: 'pong'}));
    jest.advanceTimersByTime(999);
    expect(harness.transport.restart).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    expect(harness.transport.restart).not.toHaveBeenCalled();
    expect(harness.transport.send).toHaveBeenCalledWith(
      buildContractMarketSubscribeMessage(SYMBOL),
    );
    expect(harness.store.getSnapshot().phase).toBe('connecting');
    expect(harness.store.getSnapshot().lease).toBeNull();

    jest.advanceTimersByTime(5_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(harness.fetchMarketView).toHaveBeenCalledTimes(2);
  });

  it('backs off first-frame resubscribe and stops after an unavailable Market acknowledgement', async () => {
    const harness = createHarness({
      initialFetch: Promise.reject(new Error('bootstrap failed')),
      marketStateTimeoutMs: 1_000,
    });
    harness.store.acquire('screen');
    harness.open();
    await Promise.resolve();
    await Promise.resolve();

    jest.advanceTimersByTime(1_000);
    expect(harness.transport.send).toHaveBeenCalledTimes(1);
    expect(harness.transport.restart).not.toHaveBeenCalled();

    harness.handlers.onMessage(JSON.stringify({type: 'pong'}));
    jest.advanceTimersByTime(1_999);
    expect(harness.transport.send).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(1);
    expect(harness.transport.send).toHaveBeenCalledTimes(2);

    harness.handlers.onMessage(
      JSON.stringify({
        type: 'contract_market_status',
        domain: 'market',
        symbol: SYMBOL,
        data: {status: 'unavailable'},
      }),
    );
    jest.advanceTimersByTime(30_000);
    expect(harness.transport.send).toHaveBeenCalledTimes(2);
    expect(harness.transport.restart).not.toHaveBeenCalled();
  });

  it('protects a fresh WS snapshot from a late REST bootstrap', async () => {
    const bootstrap = deferred<ContractMarketView>();
    const harness = createHarness({initialFetch: bootstrap.promise});
    harness.store.acquire('screen');
    harness.open();
    harness.sendSnapshot(
      marketPayload({bid: 108, ask: 109, sequence: 1}),
    );
    expect(harness.store.getSnapshot().source).toBe('WS');

    bootstrap.resolve(marketView({bid: 80, ask: 81}));
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.store.getSnapshot().source).toBe('WS');
    expect(harness.store.getSnapshot().marketView?.quote.lastPrice).toBe(
      109,
    );
  });

  it('rejects a REST fallback that rolls back retained WS revision', async () => {
    const harness = createHarness({
      initialFetch: Promise.resolve(
        marketView({generation: 1, sequence: 1}),
      ),
    });
    harness.store.acquire('screen');
    await Promise.resolve();
    await Promise.resolve();
    harness.open();
    harness.sendMarketState(
      marketPayload({
        bid: 110,
        ask: 111,
        generation: 1,
        sequence: 10,
      }),
    );
    const acceptedView = harness.store.getSnapshot().marketView;

    harness.fetchMarketView.mockImplementationOnce(() =>
      Promise.resolve(
        marketView({
          bid: 70,
          ask: 71,
          generation: 1,
          sequence: 9,
        }),
      ),
    );
    harness.setNow(10_030);
    harness.reconnecting();
    jest.advanceTimersByTime(0);
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.store.getSnapshot().marketView).toBe(
      acceptedView,
    );
    expect(harness.store.getSnapshot().lease).toBeNull();
  });

  it('ignores malformed and cross-symbol frames without replacing last-good state', () => {
    const harness = createHarness();
    harness.store.acquire('screen');
    harness.open();
    harness.sendMarketState(marketPayload());
    const accepted = harness.store.getSnapshot();

    harness.handlers.onMessage('{"broken":');
    harness.sendMarketState(
      marketPayload({symbol: 'ETHUSDT_PERP', bid: 50, ask: 51}),
    );

    expect(harness.store.getSnapshot()).toBe(accepted);
  });
});
