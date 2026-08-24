import type {SpotMarketView} from '../src/api/spot';
import {
  isSpotExecutionAuthorityUsable,
  SpotMarketRealtimeStore,
  type SpotRealtimeTransport,
  type SpotRealtimeTransportHandlers,
} from '../src/realtime/spotMarketRealtime';
import type {PublicWebSocketStatus} from '../src/realtime/managedPublicWebSocket';

const BASE_SERVER_TIME_MS = 1_700_000_000_000;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return {promise, reject, resolve};
}

function makeMarketView({
  executable = true,
  marketStatus = 'OPEN',
  price = 100,
  observedAtMs = 1_000,
  depthFreshness = 'LIVE',
  quoteFreshness = 'LIVE',
}: {
  executable?: boolean;
  marketStatus?: string;
  price?: number;
  observedAtMs?: number | null;
  depthFreshness?: string;
  quoteFreshness?: string;
} = {}): SpotMarketView {
  return {
    symbol: 'BTCUSDT',
    ticker: {
      symbol: 'BTCUSDT',
      lastPrice: price,
      changePercent: 0,
      high24h: null,
      low24h: null,
      baseVolume24h: null,
      quoteVolume24h: null,
      pricePrecision: 2,
      amountPrecision: 6,
      minAmount: 0.001,
      minNotional: 5,
      marketStatus,
      freshness: quoteFreshness,
      stale: quoteFreshness === 'STALE',
    },
    depth: {
      symbol: 'BTCUSDT',
      bids: [{price: price - 1, amount: 2}],
      asks: [{price: price + 1, amount: 3}],
      freshness: depthFreshness,
      stale: depthFreshness === 'STALE',
    },
    trades: [
      {
        id: `rest-${price}`,
        price,
        amount: 0.1,
        side: 'BUY',
        ts: observedAtMs,
      },
    ],
    displayPrice: price,
    bestBid: price - 1,
    bestAsk: price + 1,
    executionBid: executable ? price - 1 : null,
    executionAsk: executable ? price + 1 : null,
    executable,
    marketStatus,
    quoteFreshness,
    depthFreshness,
    tradesFreshness: 'RECENT',
    updatedAt: null,
    tickerObservedAtMs: observedAtMs,
    depthObservedAtMs: observedAtMs,
    tradesObservedAtMs: observedAtMs,
    warnings: [],
  };
}

function tickerFrame({
  price = 101,
  ts = 2_000,
  receivedAtMs = BASE_SERVER_TIME_MS,
  serverTimeMs = receivedAtMs,
  freshness = 'LIVE',
  stale = false,
  marketStatus = 'OPEN',
}: {
  price?: number;
  ts?: number;
  receivedAtMs?: number | null;
  serverTimeMs?: number | null;
  freshness?: string;
  stale?: boolean;
  marketStatus?: string;
} = {}) {
  return {
    type: 'spot_ticker_update',
    symbol: 'BTCUSDT',
    ...(serverTimeMs === null ? {} : {server_time_ms: serverTimeMs}),
    ticker: {
      symbol: 'BTCUSDT',
      last_price: price,
      event_time_ms: ts,
      ...(receivedAtMs === null
        ? {}
        : {received_at_ms: receivedAtMs}),
      freshness,
      quote_freshness: freshness,
      stale,
      market_status: marketStatus,
    },
  };
}

function depthFrame({
  bid = 100,
  ask = 102,
  ts = 2_001,
  receivedAtMs = null,
  fetchedAtMs = BASE_SERVER_TIME_MS,
  serverTimeMs = fetchedAtMs,
  freshness = 'LIVE',
  stale = false,
  bids,
  asks,
}: {
  bid?: number;
  ask?: number;
  ts?: number;
  receivedAtMs?: number | null;
  fetchedAtMs?: number | null;
  serverTimeMs?: number | null;
  freshness?: string;
  stale?: boolean;
  bids?: Array<{price: number; amount: number}>;
  asks?: Array<{price: number; amount: number}>;
} = {}) {
  return {
    type: 'spot_depth_update',
    symbol: 'BTCUSDT',
    ...(serverTimeMs === null ? {} : {server_time_ms: serverTimeMs}),
    depth: {
      symbol: 'BTCUSDT',
      bids: bids ?? [{price: bid, amount: 2}],
      asks: asks ?? [{price: ask, amount: 3}],
      ts,
      ...(receivedAtMs === null
        ? {}
        : {received_at_ms: receivedAtMs}),
      ...(fetchedAtMs === null ? {} : {fetched_at: fetchedAtMs}),
      freshness,
      stale,
    },
  };
}

function marketSnapshotFrame({
  executable = false,
  receivedAtMs = BASE_SERVER_TIME_MS,
  tickerTs = receivedAtMs,
  depthTs = receivedAtMs,
}: {
  executable?: boolean;
  receivedAtMs?: number;
  tickerTs?: number;
  depthTs?: number;
} = {}) {
  return {
    type: 'spot_market_snapshot',
    symbol: 'BTCUSDT',
    market_view: {
      symbol: 'BTCUSDT',
      ticker: {
        symbol: 'BTCUSDT',
        last_price: 101,
        event_time_ms: tickerTs,
        received_at_ms: receivedAtMs,
      },
      depth: {
        symbol: 'BTCUSDT',
        bids: [{price: 100, amount: 2}],
        asks: [{price: 102, amount: 3}],
        freshness: 'LIVE',
        ts: depthTs,
        fetched_at: receivedAtMs,
      },
      trades: {symbol: 'BTCUSDT', items: []},
      display_price: 101,
      best_bid: 100,
      best_ask: 102,
      executable,
      market_status: 'OPEN',
      quote_freshness: 'LIVE',
      depth_freshness: 'LIVE',
      depth_status: 'ok',
      trades_freshness: 'RECENT',
    },
  };
}

function createHarness({
  marketViewPromise = Promise.resolve(makeMarketView()),
  executionTtlMs = 1_250,
}: {
  marketViewPromise?: Promise<SpotMarketView>;
  executionTtlMs?: number;
} = {}) {
  let handlers!: SpotRealtimeTransportHandlers;
  let status: PublicWebSocketStatus = 'idle';
  let nowMs = BASE_SERVER_TIME_MS;
  const start = jest.fn(() => {
    status = 'connecting';
    handlers.onStatusChange(status);
  });
  const stop = jest.fn(() => {
    status = 'stopped';
    handlers.onStatusChange(status);
  });
  const transport: SpotRealtimeTransport = {
    start,
    stop,
    getStatus: () => status,
  };
  const fetchMarketView = jest.fn(() => marketViewPromise);
  const store = new SpotMarketRealtimeStore('BTCUSDT', {
    batchWindowMs: 80,
    createTransport: nextHandlers => {
      handlers = nextHandlers;
      return transport;
    },
    executionTtlMs,
    fetchMarketView,
    now: () => nowMs,
  });

  return {
    emit(message: unknown) {
      handlers.onMessage(JSON.stringify(message));
    },
    fetchMarketView,
    open() {
      status = 'open';
      handlers.onStatusChange(status);
    },
    reconnecting() {
      status = 'reconnecting';
      handlers.onStatusChange(status);
    },
    setNow(value: number) {
      nowMs = value;
    },
    start,
    stop,
    store,
  };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

describe('SpotMarketRealtimeStore', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('reference-counts owners and runs REST plus WebSocket in parallel', async () => {
    const bootstrap = deferred<SpotMarketView>();
    const harness = createHarness({marketViewPromise: bootstrap.promise});

    const releaseA = harness.store.acquire('screen-a');
    const releaseB = harness.store.acquire('screen-b');

    expect(harness.start).toHaveBeenCalledTimes(1);
    expect(harness.fetchMarketView).toHaveBeenCalledTimes(1);
    expect(harness.store.getSnapshot().phase).toBe('connecting');

    releaseA();
    expect(harness.stop).not.toHaveBeenCalled();
    releaseB();
    expect(harness.stop).toHaveBeenCalledTimes(1);
    expect(harness.store.getSnapshot()).toMatchObject({
      executable: false,
      phase: 'paused',
    });

    bootstrap.resolve(makeMarketView({price: 90}));
    await flushPromises();
    expect(harness.store.getSnapshot().ticker).toBeNull();
  });

  it('keeps REST bootstrap display-only until current socket ticker and depth arrive', async () => {
    const harness = createHarness();
    harness.store.acquire('screen');
    await flushPromises();

    expect(harness.store.getSnapshot()).toMatchObject({
      executable: false,
      source: 'REST',
    });
    expect(harness.store.getSnapshot().ticker?.lastPrice).toBe(100);

    harness.open();
    harness.emit(tickerFrame());
    jest.advanceTimersByTime(80);
    expect(harness.store.getSnapshot().executable).toBe(false);

    harness.emit(depthFrame());
    jest.advanceTimersByTime(80);
    expect(harness.store.getSnapshot()).toMatchObject({
      executable: true,
      executionBid: 100,
      executionAsk: 102,
      executionExpiresAtMs:
        BASE_SERVER_TIME_MS + 1_250,
      source: 'WS',
    });
  });

  it('calibrates a stable device clock offset before enabling spot execution', async () => {
    const harness = createHarness();
    harness.store.acquire('screen');
    await flushPromises();
    harness.open();

    harness.setNow(BASE_SERVER_TIME_MS + 2_200);
    harness.emit(
      tickerFrame({
        receivedAtMs: BASE_SERVER_TIME_MS,
        serverTimeMs: null,
        ts: 2_000,
      }),
    );
    jest.advanceTimersByTime(80);
    expect(harness.store.getSnapshot().executable).toBe(false);

    harness.setNow(BASE_SERVER_TIME_MS + 2_210);
    harness.emit(
      depthFrame({
        fetchedAtMs: BASE_SERVER_TIME_MS + 10,
        serverTimeMs: null,
        ts: 2_001,
      }),
    );
    jest.advanceTimersByTime(80);

    expect(harness.store.getSnapshot()).toMatchObject({
      executable: true,
      executionBid: 100,
      executionAsk: 102,
      executionExpiresAtMs: BASE_SERVER_TIME_MS + 3_450,
    });
  });

  it('preserves REST display precision when WS only carries trading precision', async () => {
    const marketView = makeMarketView({price: 62_567.4});
    marketView.ticker = {
      ...marketView.ticker,
      displayPricePrecision: 1,
      displayPricePrecisionSource: 'display_price_precision',
      priceTickSize: 0.1,
    };
    const harness = createHarness({marketViewPromise: Promise.resolve(marketView)});
    harness.store.acquire('screen');
    await flushPromises();
    expect(harness.store.getSnapshot().ticker).toMatchObject({
      displayPricePrecision: 1,
      pricePrecision: 2,
      priceTickSize: 0.1,
    });

    harness.open();
    const frame = tickerFrame({price: 62_568, ts: 2_000});
    harness.emit({
      ...frame,
      ticker: {
        ...frame.ticker,
        price_precision: 2,
      },
    });
    jest.advanceTimersByTime(80);

    expect(harness.store.getSnapshot().ticker).toMatchObject({
      lastPrice: 62_568,
      displayPricePrecision: 1,
      pricePrecision: 2,
      displayPricePrecisionSource: 'display_price_precision',
      priceTickSize: 0.1,
    });
  });

  it('accepts late REST display metadata without replacing newer WS prices', async () => {
    const bootstrap = deferred<SpotMarketView>();
    const harness = createHarness({marketViewPromise: bootstrap.promise});
    harness.store.acquire('screen');
    harness.open();
    const frame = tickerFrame({price: 62_568, ts: 2_000});
    harness.emit({
      ...frame,
      ticker: {...frame.ticker, price_precision: 2},
    });
    jest.advanceTimersByTime(80);
    expect(harness.store.getSnapshot().ticker).toMatchObject({
      lastPrice: 62_568,
      pricePrecision: 2,
    });

    const marketView = makeMarketView({
      observedAtMs: 1_000,
      price: 62_567.4,
    });
    marketView.ticker = {
      ...marketView.ticker,
      displayPricePrecision: 1,
      displayPricePrecisionSource: 'display_price_precision',
      priceTickSize: 0.1,
    };
    bootstrap.resolve(marketView);
    await flushPromises();

    expect(harness.store.getSnapshot().ticker).toMatchObject({
      lastPrice: 62_568,
      displayPricePrecision: 1,
      pricePrecision: 2,
      displayPricePrecisionSource: 'display_price_precision',
      minAmount: 0.001,
      minNotional: 5,
    });
  });

  it('keeps real 24h metrics from provider ticker aliases, including zero values', async () => {
    const harness = createHarness();
    harness.store.acquire('screen');
    await flushPromises();
    harness.open();
    const frame = tickerFrame();
    harness.emit({
      ...frame,
      ticker: {
        ...frame.ticker,
        high24h: '65400.5',
        lowPrice: '63000.25',
        vol24h: 0,
        volCcy24h: '0.0',
      },
    });
    jest.advanceTimersByTime(80);

    expect(harness.store.getSnapshot().ticker).toMatchObject({
      high24h: 65400.5,
      low24h: 63000.25,
      baseVolume24h: 0,
      quoteVolume24h: 0,
      minAmount: 0.001,
      minNotional: 5,
    });

    const partialFrame = tickerFrame({price: 101, ts: 2_000});
    harness.emit(partialFrame);
    jest.advanceTimersByTime(80);
    expect(harness.store.getSnapshot().ticker).toMatchObject({
      lastPrice: 101,
      high24h: 65400.5,
      low24h: 63000.25,
      baseVolume24h: 0,
      quoteVolume24h: 0,
      minAmount: 0.001,
      minNotional: 5,
    });
  });

  it('does not let a late older REST bootstrap overwrite increments', async () => {
    const bootstrap = deferred<SpotMarketView>();
    const harness = createHarness({marketViewPromise: bootstrap.promise});
    harness.store.acquire('screen');
    harness.open();
    harness.emit(tickerFrame({price: 111, ts: 3_000}));
    harness.emit(depthFrame({bid: 110, ask: 112, ts: 3_001}));
    jest.advanceTimersByTime(80);

    bootstrap.resolve(
      makeMarketView({price: 90, observedAtMs: 1_000}),
    );
    await flushPromises();
    jest.advanceTimersByTime(80);

    expect(harness.store.getSnapshot()).toMatchObject({
      executionBid: 110,
      executionAsk: 112,
      executable: true,
      source: 'WS',
    });
    expect(harness.store.getSnapshot().ticker?.lastPrice).toBe(111);
  });

  it('serializes pending increments before a newer fail-closed REST result', async () => {
    const bootstrap = deferred<SpotMarketView>();
    const harness = createHarness({marketViewPromise: bootstrap.promise});
    harness.store.acquire('screen');
    harness.open();
    harness.emit(tickerFrame({price: 101, ts: 2_000}));
    harness.emit(depthFrame({ts: 2_001}));

    bootstrap.resolve(
      makeMarketView({
        executable: false,
        marketStatus: 'CLOSED',
        observedAtMs: 3_000_000,
      }),
    );
    await flushPromises();
    jest.advanceTimersByTime(80);

    expect(harness.store.getSnapshot()).toMatchObject({
      executable: false,
      executionBid: null,
      executionAsk: null,
      source: 'REST',
    });
  });

  it.each([
    ['stale', depthFrame({ts: 3_000, freshness: 'STALE', stale: true})],
    [
      'empty',
      depthFrame({ts: 3_000, bids: [], asks: []}),
    ],
  ])(
    'preserves last-good display but immediately revokes execution on a newer %s depth',
    async (_label, frame) => {
      const harness = createHarness();
      harness.store.acquire('screen');
      harness.open();
      harness.emit(tickerFrame());
      harness.emit(depthFrame());
      jest.advanceTimersByTime(80);
      const displayedBid = harness.store.getSnapshot().depth.bids[0];
      expect(harness.store.getSnapshot().executable).toBe(true);

      harness.emit(frame);

      expect(harness.store.getSnapshot()).toMatchObject({
        executable: false,
        executionBid: null,
        executionAsk: null,
      });
      expect(harness.store.getSnapshot().depth.bids[0]).toEqual(
        displayedBid,
      );
    },
  );

  it.each([
    ['single-sided', depthFrame({ts: 3_000, asks: []})],
    ['crossed', depthFrame({ts: 3_000, bid: 103, ask: 102})],
    ['zero', depthFrame({ts: 3_000, bid: 0, ask: 102})],
  ])('fails closed for a newer %s order book', async (_label, frame) => {
    const harness = createHarness();
    harness.store.acquire('screen');
    harness.open();
    harness.emit(tickerFrame());
    harness.emit(depthFrame());
    jest.advanceTimersByTime(80);
    expect(harness.store.getSnapshot().executable).toBe(true);

    harness.emit(frame);
    jest.advanceTimersByTime(80);

    expect(harness.store.getSnapshot()).toMatchObject({
      executable: false,
      executionBid: null,
      executionAsk: null,
    });
  });

  it('requires both domains from the new socket generation after reconnect', async () => {
    const harness = createHarness();
    harness.store.acquire('screen');
    harness.open();
    harness.emit(tickerFrame());
    harness.emit(depthFrame());
    jest.advanceTimersByTime(80);
    expect(harness.store.getSnapshot().executable).toBe(true);
    const lastGoodDepth = harness.store.getSnapshot().depth;

    harness.reconnecting();
    expect(harness.store.getSnapshot()).toMatchObject({
      executable: false,
      phase: 'reconnecting',
    });
    expect(harness.store.getSnapshot().depth).toBe(lastGoodDepth);

    harness.open();
    harness.emit(depthFrame({ts: 4_000}));
    jest.advanceTimersByTime(80);
    expect(harness.store.getSnapshot().executable).toBe(false);

    harness.emit(tickerFrame({ts: 4_001}));
    jest.advanceTimersByTime(80);
    expect(harness.store.getSnapshot().executable).toBe(true);
  });

  it('expires execution after the 1.25s client safety lease', async () => {
    const harness = createHarness();
    harness.store.acquire('screen');
    harness.open();
    harness.emit(tickerFrame());
    harness.emit(depthFrame());
    jest.advanceTimersByTime(80);
    expect(harness.store.getSnapshot().executable).toBe(true);

    harness.setNow(BASE_SERVER_TIME_MS + 1_249);
    jest.advanceTimersByTime(1_249);
    expect(harness.store.getSnapshot().executable).toBe(true);
    harness.setNow(BASE_SERVER_TIME_MS + 1_250);
    jest.advanceTimersByTime(1);

    expect(harness.store.getSnapshot()).toMatchObject({
      executable: false,
      executionExpiresAtMs: null,
    });
  });

  it('deducts delivery delay and uses depth fetched_at as receipt evidence', async () => {
    const harness = createHarness();
    harness.setNow(BASE_SERVER_TIME_MS + 500);
    harness.store.acquire('screen');
    harness.open();
    harness.emit(
      tickerFrame({
        receivedAtMs: BASE_SERVER_TIME_MS,
      }),
    );
    harness.emit(
      depthFrame({
        fetchedAtMs: BASE_SERVER_TIME_MS,
        receivedAtMs: null,
      }),
    );
    jest.advanceTimersByTime(80);

    expect(harness.store.getSnapshot()).toMatchObject({
      executable: true,
      executionExpiresAtMs:
        BASE_SERVER_TIME_MS + 1_250,
    });
  });

  it('requires fresh ticker and depth increments after a display-only snapshot', async () => {
    const harness = createHarness();
    harness.store.acquire('screen');
    harness.open();
    harness.emit(marketSnapshotFrame({executable: false}));
    jest.advanceTimersByTime(80);

    expect(harness.store.getSnapshot()).toMatchObject({
      executable: false,
      executionBid: null,
      executionAsk: null,
    });
    expect(harness.store.getSnapshot().ticker?.lastPrice).toBe(101);
    expect(harness.store.getSnapshot().depth.bids[0]?.price).toBe(100);

    harness.setNow(BASE_SERVER_TIME_MS + 10);
    harness.emit(
      depthFrame({
        ts: BASE_SERVER_TIME_MS + 10,
        fetchedAtMs: BASE_SERVER_TIME_MS + 10,
      }),
    );
    jest.advanceTimersByTime(80);
    expect(harness.store.getSnapshot().executable).toBe(false);

    harness.emit(
      tickerFrame({
        ts: BASE_SERVER_TIME_MS + 11,
        receivedAtMs: BASE_SERVER_TIME_MS + 10,
      }),
    );
    jest.advanceTimersByTime(80);
    expect(harness.store.getSnapshot().executable).toBe(true);
  });

  it('unconditionally revokes live execution on a same-time display-only snapshot', async () => {
    const harness = createHarness();
    harness.store.acquire('screen');
    harness.open();
    harness.emit(tickerFrame({ts: 2_000}));
    harness.emit(depthFrame({ts: 2_001}));
    jest.advanceTimersByTime(80);
    expect(harness.store.getSnapshot().executable).toBe(true);
    const lastGoodDepth = harness.store.getSnapshot().depth;

    harness.emit(
      marketSnapshotFrame({
        executable: false,
        tickerTs: 2_000,
        depthTs: 2_001,
      }),
    );
    jest.advanceTimersByTime(80);
    expect(harness.store.getSnapshot()).toMatchObject({
      executable: false,
      executionBid: null,
      executionAsk: null,
    });
    expect(harness.store.getSnapshot().depth).toBe(lastGoodDepth);

    harness.emit(tickerFrame({ts: 2_000}));
    harness.emit(depthFrame({ts: 2_001}));
    jest.advanceTimersByTime(80);
    expect(harness.store.getSnapshot().executable).toBe(false);

    harness.setNow(BASE_SERVER_TIME_MS + 10);
    harness.emit(
      tickerFrame({
        ts: 3_000,
        receivedAtMs: BASE_SERVER_TIME_MS + 10,
      }),
    );
    harness.emit(
      depthFrame({
        ts: 3_001,
        fetchedAtMs: BASE_SERVER_TIME_MS + 10,
      }),
    );
    jest.advanceTimersByTime(80);
    expect(harness.store.getSnapshot().executable).toBe(true);
  });

  it.each([
    [
      'missing ticker received_at_ms',
      BASE_SERVER_TIME_MS,
      null,
      BASE_SERVER_TIME_MS,
    ],
    [
      'future ticker received_at_ms',
      BASE_SERVER_TIME_MS,
      BASE_SERVER_TIME_MS + 1,
      BASE_SERVER_TIME_MS,
    ],
    [
      'missing depth received_at_ms and fetched_at',
      BASE_SERVER_TIME_MS,
      BASE_SERVER_TIME_MS,
      null,
    ],
    [
      'future depth fetched_at',
      BASE_SERVER_TIME_MS,
      BASE_SERVER_TIME_MS,
      BASE_SERVER_TIME_MS + 1,
    ],
    [
      'already expired receipt evidence',
      BASE_SERVER_TIME_MS + 1_250,
      BASE_SERVER_TIME_MS,
      BASE_SERVER_TIME_MS,
    ],
  ])(
    'keeps display data but fails closed for %s',
    async (
      _label,
      nowMs,
      tickerReceivedAtMs,
      depthFetchedAtMs,
    ) => {
      const harness = createHarness();
      harness.setNow(nowMs as number);
      harness.store.acquire('screen');
      harness.open();
      harness.emit(
        tickerFrame({
          price: 111,
          receivedAtMs: tickerReceivedAtMs as number | null,
          serverTimeMs: nowMs as number,
        }),
      );
      harness.emit(
        depthFrame({
          bid: 110,
          ask: 112,
          fetchedAtMs: depthFetchedAtMs as number | null,
          receivedAtMs: null,
          serverTimeMs: nowMs as number,
        }),
      );
      jest.advanceTimersByTime(80);

      expect(harness.store.getSnapshot()).toMatchObject({
        executable: false,
        executionBid: null,
        executionAsk: null,
      });
      expect(harness.store.getSnapshot().ticker?.lastPrice).toBe(
        111,
      );
      expect(harness.store.getSnapshot().depth.bids[0]?.price).toBe(
        110,
      );
    },
  );

  it('requires strictly newer live depth after a degraded high-water', async () => {
    const harness = createHarness();
    harness.store.acquire('screen');
    harness.open();
    harness.emit(tickerFrame({ts: 2_000}));
    harness.emit(depthFrame({ts: 2_000}));
    jest.advanceTimersByTime(80);
    expect(harness.store.getSnapshot().executable).toBe(true);
    const lastGoodDepth = harness.store.getSnapshot().depth;

    harness.setNow(BASE_SERVER_TIME_MS + 10);
    harness.emit(
      depthFrame({
        ts: 3_000,
        fetchedAtMs: BASE_SERVER_TIME_MS + 10,
        freshness: 'STALE',
        stale: true,
      }),
    );
    expect(harness.store.getSnapshot().executable).toBe(false);

    harness.setNow(BASE_SERVER_TIME_MS + 20);
    harness.emit(
      depthFrame({
        bid: 105,
        ask: 107,
        ts: 2_500,
        fetchedAtMs: BASE_SERVER_TIME_MS + 20,
      }),
    );
    harness.emit(
      tickerFrame({
        price: 106,
        ts: 4_000,
        receivedAtMs: BASE_SERVER_TIME_MS + 20,
      }),
    );
    jest.advanceTimersByTime(80);

    expect(harness.store.getSnapshot()).toMatchObject({
      executable: false,
      executionBid: null,
      executionAsk: null,
    });
    expect(harness.store.getSnapshot().depth).toBe(lastGoodDepth);

    harness.emit(
      depthFrame({
        bid: 105,
        ask: 107,
        ts: 3_000,
        fetchedAtMs: BASE_SERVER_TIME_MS + 20,
      }),
    );
    jest.advanceTimersByTime(80);
    expect(harness.store.getSnapshot().executable).toBe(false);
    expect(harness.store.getSnapshot().depth).toBe(lastGoodDepth);

    harness.emit(
      depthFrame({
        bid: 105,
        ask: 107,
        ts: 3_001,
        fetchedAtMs: BASE_SERVER_TIME_MS + 20,
      }),
    );
    jest.advanceTimersByTime(80);
    expect(harness.store.getSnapshot().executable).toBe(true);
  });

  it('keeps last-good display across consecutive degraded depth frames', async () => {
    const harness = createHarness();
    harness.store.acquire('screen');
    harness.open();
    harness.emit(tickerFrame({ts: 2_000}));
    harness.emit(depthFrame({ts: 2_000}));
    jest.advanceTimersByTime(80);
    const lastGoodDepth = harness.store.getSnapshot().depth;

    harness.emit(
      depthFrame({
        bid: 90,
        ask: 92,
        ts: 3_000,
        freshness: 'STALE',
        stale: true,
      }),
    );
    harness.emit(
      depthFrame({
        bid: 80,
        ask: 82,
        ts: 4_000,
        freshness: 'STALE',
        stale: true,
      }),
    );
    jest.advanceTimersByTime(80);

    expect(harness.store.getSnapshot()).toMatchObject({
      executable: false,
      executionBid: null,
      executionAsk: null,
    });
    expect(harness.store.getSnapshot().depth).toBe(lastGoodDepth);
  });

  it('batches trades, de-duplicates ids, and ignores wrong-symbol frames', async () => {
    const harness = createHarness();
    harness.store.acquire('screen');
    harness.open();
    await flushPromises();
    const revision = harness.store.getSnapshot().revision;

    harness.emit({
      ...tickerFrame({price: 999}),
      symbol: 'ETHUSDT',
    });
    harness.emit({
      type: 'spot_trade',
      symbol: 'BTCUSDT',
      trade: {
        trade_id: 'trade-1',
        price: 105,
        amount: 1,
        side: 'BUY',
        event_time_ms: 3_000,
        freshness: 'LIVE',
      },
    });
    harness.emit({
      type: 'spot_trade',
      symbol: 'BTCUSDT',
      trade: {
        trade_id: 'trade-1',
        price: 106,
        amount: 1,
        side: 'BUY',
        event_time_ms: 3_001,
        freshness: 'LIVE',
      },
    });

    expect(harness.store.getSnapshot().revision).toBe(revision);
    jest.advanceTimersByTime(80);
    const matching = harness.store
      .getSnapshot()
      .trades.filter(item => item.id === 'trade-1');
    expect(matching).toHaveLength(1);
    expect(matching[0].price).toBe(106);
    expect(harness.store.getSnapshot().ticker?.lastPrice).not.toBe(999);
  });
});

describe('Spot execution confirmation authority', () => {
  const authority = {
    active: true,
    executable: true,
    bid: 100,
    ask: 101,
    expiresAtMs: 2_000,
  };

  it('requires an active, unexpired, complete and non-crossed BBO', () => {
    expect(isSpotExecutionAuthorityUsable(authority, 1_999)).toBe(true);
    expect(
      isSpotExecutionAuthorityUsable(
        {...authority, active: false},
        1_999,
      ),
    ).toBe(false);
    expect(isSpotExecutionAuthorityUsable(authority, 2_000)).toBe(
      false,
    );
    expect(
      isSpotExecutionAuthorityUsable(
        {...authority, ask: 99},
        1_999,
      ),
    ).toBe(false);
    expect(
      isSpotExecutionAuthorityUsable(
        {...authority, bid: null},
        1_999,
      ),
    ).toBe(false);
  });
});
