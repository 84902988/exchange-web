import {
  ContractKlineRealtimeStore,
  parseContractNativeKlineMessage,
  type ContractKlineHub,
} from '../src/realtime/contractKlineRealtime';
import type {
  ContractKline,
  ContractKlineHistoryResult,
} from '../src/api/contract';
import type {
  ContractKlineDomainHandlers,
} from '../src/realtime/contractMarketRealtime';
import type {PublicWebSocketStatus} from '../src/realtime/managedPublicWebSocket';

const SYMBOL = 'BTCUSDT_PERP';
const MINUTE = 60_000;
const BASE_OPEN_TIME = 1_800_000_000_000;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return {promise, reject, resolve};
}

function bar(
  openTime: number,
  close = 100,
): ContractKline {
  return {
    openTime,
    open: 100,
    high: Math.max(102, close),
    low: Math.min(98, close),
    close,
    volume: 10,
  };
}

function history(
  items: ContractKline[],
  overrides: Partial<ContractKlineHistoryResult> = {},
): ContractKlineHistoryResult {
  return {
    items,
    stale: false,
    freshness: 'RECENT',
    historyIncomplete: false,
    historyComplete: null,
    hasMoreBefore: null,
    historyTerminal: null,
    coverageComplete: null,
    providerErrorCode: null,
    retryable: false,
    ...overrides,
  };
}

function nativeFrame({
  openTime = BASE_OPEN_TIME,
  close = 101,
  generation = 10,
  sequence = 1,
  isClosed = false,
  symbol = SYMBOL,
  interval = '1m',
  stale = false,
  source = 'LIVE_WS',
  transport = 'PROVIDER_WS',
  provider = 'OKX_SWAP',
  receivedAtMs = openTime + 30_000,
}: {
  openTime?: number;
  close?: number;
  generation?: number;
  sequence?: number;
  isClosed?: boolean;
  symbol?: string;
  interval?: string;
  stale?: boolean;
  source?: string;
  transport?: string;
  provider?: string;
  receivedAtMs?: number;
} = {}) {
  const payload = {
    symbol,
    interval,
    open_time: openTime,
    open: '100',
    high: String(Math.max(102, close)),
    low: String(Math.min(98, close)),
    close: String(close),
    volume: '10',
    source,
    transport,
    freshness: stale ? 'STALE' : 'LIVE',
    stale,
    provider,
    provider_generation: generation,
    revision_epoch: generation,
    revision_sequence: sequence,
    received_at_ms: receivedAtMs,
    is_closed: isClosed,
    is_final: isClosed,
  };
  return {
    type: 'contract_kline_update',
    domain: 'kline',
    symbol,
    interval,
    source,
    transport,
    freshness: stale ? 'STALE' : 'LIVE',
    stale,
    provider,
    provider_generation: generation,
    revision_epoch: generation,
    revision_sequence: sequence,
    received_at_ms: receivedAtMs,
    data: payload,
    kline: payload,
  };
}

class FakeHub implements ContractKlineHub {
  status: PublicWebSocketStatus = 'idle';
  handlers: ContractKlineDomainHandlers | null = null;
  acquireKlineDomain = jest.fn(
    (
      _owner: string,
      _interval: string,
      handlers: ContractKlineDomainHandlers,
    ) => {
      this.handlers = handlers;
      handlers.onActiveChange(true);
      handlers.onStatusChange(this.status);
      return () => {
        handlers.onActiveChange(false);
        if (this.handlers === handlers) this.handlers = null;
      };
    },
  );
  resubscribeKlineDomain = jest.fn(() => true);

  setStatus(status: PublicWebSocketStatus) {
    this.status = status;
    this.handlers?.onStatusChange(status);
  }

  send(message: Record<string, unknown>) {
    this.handlers?.onMessage(message);
  }
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function createHarness({
  fetchHistory,
  historyLimit = 80,
  domainReadyTimeoutMs = 1_000,
  domainSilenceTimeoutMs = 20_000,
  restDisplayRefreshMs = 1_000,
  renderThrottleMs = 0,
  interval = '1m',
}: {
  fetchHistory?: jest.Mock;
  historyLimit?: number;
  domainReadyTimeoutMs?: number;
  domainSilenceTimeoutMs?: number;
  restDisplayRefreshMs?: number;
  renderThrottleMs?: number;
  interval?: string;
} = {}) {
  const hub = new FakeHub();
  const fetch =
    fetchHistory ||
    jest.fn(() =>
      Promise.resolve(
        history([
          bar(BASE_OPEN_TIME - 2 * MINUTE),
          bar(BASE_OPEN_TIME - MINUTE),
          bar(BASE_OPEN_TIME),
        ]),
      ),
    );
  const store = new ContractKlineRealtimeStore(SYMBOL, interval, {
    fetchHistory: fetch,
    hub,
    historyLimit,
    domainReadyTimeoutMs,
    domainSilenceTimeoutMs,
    historyRetryBaseMs: 1_000,
    historyRetryMaxMs: 4_000,
    restDisplayRefreshMs,
    renderThrottleMs,
  });
  return {fetchHistory: fetch, hub, store};
}

describe('ContractKlineRealtimeStore', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('strictly validates native authority and interval boundaries', () => {
    expect(
      parseContractNativeKlineMessage(
        nativeFrame(),
        SYMBOL,
        '1m',
      ).kind,
    ).toBe('frame');
    expect(
      parseContractNativeKlineMessage(
        nativeFrame({symbol: 'ETHUSDT_PERP'}),
        SYMBOL,
        '1m',
      ).kind,
    ).toBe('ignored');
    expect(
      parseContractNativeKlineMessage(
        nativeFrame({interval: '5m'}),
        SYMBOL,
        '1m',
      ).kind,
    ).toBe('ignored');
    expect(
      parseContractNativeKlineMessage(
        nativeFrame({interval: '1M'}),
        SYMBOL,
        '1m',
      ).kind,
    ).toBe('ignored');
    expect(
      parseContractNativeKlineMessage(
        nativeFrame({stale: true}),
        SYMBOL,
        '1m',
      ).kind,
    ).toBe('ignored');
    expect(
      parseContractNativeKlineMessage(
        nativeFrame({source: 'PROVIDER_REST'}),
        SYMBOL,
        '1m',
      ).kind,
    ).toBe('ignored');
    expect(
      parseContractNativeKlineMessage(
        nativeFrame({transport: 'REST'}),
        SYMBOL,
        '1m',
      ).kind,
    ).toBe('ignored');
    expect(
      parseContractNativeKlineMessage(
        nativeFrame({openTime: BASE_OPEN_TIME + 1}),
        SYMBOL,
        '1m',
      ).kind,
    ).toBe('ignored');
    expect(
      parseContractNativeKlineMessage(
        nativeFrame({
          interval: '1d',
          openTime: BASE_OPEN_TIME - 8 * 60 * MINUTE,
        }),
        SYMBOL,
        '1d',
      ).kind,
    ).toBe('ignored');

    const missingFinality = nativeFrame();
    (missingFinality.data as Record<string, unknown>).is_closed =
      undefined;
    (missingFinality.data as Record<string, unknown>).is_final =
      undefined;
    expect(
      parseContractNativeKlineMessage(
        missingFinality,
        SYMBOL,
        '1m',
      ).kind,
    ).toBe('ignored');

    expect(
      parseContractNativeKlineMessage(
        {...nativeFrame(), is_closed: true},
        SYMBOL,
        '1m',
      ).kind,
    ).toBe('ignored');

    expect(
      parseContractNativeKlineMessage(
        {
          ...nativeFrame({stale: true}),
          type: 'contract_kline_snapshot',
          status: 'ok',
        },
        SYMBOL,
        '1m',
      ).kind,
    ).toBe('ack');

    expect(
      parseContractNativeKlineMessage(
        {
          ...nativeFrame({
            source: 'PROVIDER_REST',
            transport: 'REST',
          }),
          type: 'contract_kline_snapshot',
          status: 'ok',
        },
        SYMBOL,
        '1m',
      ).kind,
    ).toBe('ack');

    const conflictingNestedRevision = nativeFrame();
    (
      conflictingNestedRevision.data as Record<string, unknown>
    ).revision = {
      epoch: 10,
      sequence: 1,
      is_closed: false,
    };
    (
      conflictingNestedRevision as Record<string, unknown>
    ).revision = {
      epoch: 10,
      sequence: 2,
      is_closed: false,
    };
    expect(
      parseContractNativeKlineMessage(
        conflictingNestedRevision,
        SYMBOL,
        '1m',
      ).kind,
    ).toBe('ignored');

    const conflictingNestedFinality = nativeFrame();
    (
      conflictingNestedFinality.data as Record<string, unknown>
    ).revision = {
      epoch: 10,
      sequence: 1,
      is_closed: false,
    };
    (
      conflictingNestedFinality as Record<string, unknown>
    ).revision = {
      epoch: 10,
      sequence: 1,
      is_closed: true,
    };
    expect(
      parseContractNativeKlineMessage(
        conflictingNestedFinality,
        SYMBOL,
        '1m',
      ).kind,
    ).toBe('ignored');
  });

  it('shares one logical Kline lease and aborts history after the last owner releases', () => {
    const pending = deferred<ContractKlineHistoryResult>();
    const fetchHistory = jest.fn(
      (
        _symbol: string,
        _interval: string,
        _limit: number,
        _options: {signal?: AbortSignal},
      ) => pending.promise,
    );
    const {hub, store} = createHarness({fetchHistory});
    const releaseA = store.acquire('inline');
    const releaseB = store.acquire('inline');

    expect(hub.acquireKlineDomain).toHaveBeenCalledTimes(1);
    expect(fetchHistory).toHaveBeenCalledTimes(1);
    const signal = fetchHistory.mock.calls[0][3].signal;
    expect(signal?.aborted).toBe(false);

    releaseA();
    expect(signal?.aborted).toBe(false);
    releaseB();
    expect(signal?.aborted).toBe(true);
    expect(store.getSnapshot().phase).toBe('paused');
  });

  it('merges late REST history without rolling back an earlier WS current bucket', async () => {
    const pending = deferred<ContractKlineHistoryResult>();
    const {hub, store} = createHarness({
      fetchHistory: jest.fn(() => pending.promise),
    });
    const release = store.acquire('screen');
    hub.setStatus('open');
    hub.send(nativeFrame({close: 105, sequence: 2}));

    expect(store.getSnapshot().items.at(-1)?.close).toBe(105);

    pending.resolve(
      history([
        bar(BASE_OPEN_TIME - 2 * MINUTE, 90),
        bar(BASE_OPEN_TIME - MINUTE, 91),
        bar(BASE_OPEN_TIME, 92),
      ]),
    );
    await flushPromises();

    expect(store.getSnapshot().items.map(item => item.openTime)).toEqual([
      BASE_OPEN_TIME - 2 * MINUTE,
      BASE_OPEN_TIME - MINUTE,
      BASE_OPEN_TIME,
    ]);
    expect(store.getSnapshot().items.at(-1)?.close).toBe(105);
    expect(store.getSnapshot().source).toBe('REST+WS_NATIVE');
    release();
  });

  it('drops duplicates, revision rollback, generation rollback, conflicts, and closed-to-open rollback', async () => {
    const {hub, store} = createHarness();
    const release = store.acquire('screen');
    hub.setStatus('open');
    hub.send({
      type: 'contract_kline_snapshot',
      domain: 'kline',
      symbol: SYMBOL,
      interval: '1m',
      status: 'unavailable',
      data: null,
      kline: null,
    });
    await flushPromises();

    hub.send(nativeFrame({close: 101, sequence: 1}));
    const acceptedRevision = store.getSnapshot().revision;
    hub.send(nativeFrame({close: 101, sequence: 1}));
    expect(store.getSnapshot().revision).toBe(acceptedRevision);

    hub.send(nativeFrame({close: 99, sequence: 0}));
    expect(store.getSnapshot().items.at(-1)?.close).toBe(101);

    hub.send(nativeFrame({close: 110, sequence: 1}));
    expect(store.getSnapshot().items.at(-1)?.close).toBe(101);

    hub.send(
      nativeFrame({
        close: 102,
        sequence: 2,
        isClosed: true,
      }),
    );
    expect(store.getSnapshot().items.at(-1)?.close).toBe(102);

    hub.send(
      nativeFrame({
        close: 103,
        sequence: 3,
        isClosed: false,
      }),
    );
    expect(store.getSnapshot().items.at(-1)?.close).toBe(102);

    hub.send(
      nativeFrame({
        close: 80,
        generation: 9,
        sequence: 100,
      }),
    );
    expect(store.getSnapshot().items.at(-1)?.close).toBe(102);
    release();
  });

  it('buffers a bucket gap, reconciles REST, and then releases the newest bounded frame', async () => {
    const first = deferred<ContractKlineHistoryResult>();
    const second = deferred<ContractKlineHistoryResult>();
    const fetchHistory = jest
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const {hub, store} = createHarness({fetchHistory});
    const release = store.acquire('screen');
    hub.setStatus('open');
    first.resolve(
      history([
        bar(BASE_OPEN_TIME - MINUTE),
        bar(BASE_OPEN_TIME),
      ]),
    );
    await flushPromises();

    hub.send(
      nativeFrame({
        openTime: BASE_OPEN_TIME + 2 * MINUTE,
        close: 104,
        sequence: 2,
      }),
    );
    expect(store.getSnapshot().gapDetected).toBe(true);
    expect(
      store
        .getSnapshot()
        .items.some(
          item => item.openTime === BASE_OPEN_TIME + 2 * MINUTE,
        ),
    ).toBe(false);
    expect(fetchHistory).toHaveBeenCalledTimes(2);

    second.resolve(
      history([
        bar(BASE_OPEN_TIME - MINUTE),
        bar(BASE_OPEN_TIME),
        bar(BASE_OPEN_TIME + MINUTE),
        bar(BASE_OPEN_TIME + 2 * MINUTE, 90),
      ]),
    );
    await flushPromises();
    expect(store.getSnapshot().items.at(-1)).toMatchObject({
      openTime: BASE_OPEN_TIME + 2 * MINUTE,
      close: 104,
    });
    release();
  });

  it('treats unavailable snapshot as subscription-only ack and keeps REST display refresh alive', async () => {
    const {fetchHistory, hub, store} = createHarness({
      domainReadyTimeoutMs: 1_000,
      restDisplayRefreshMs: 2_000,
    });
    const release = store.acquire('screen');
    hub.setStatus('open');
    await flushPromises();

    hub.send({
      type: 'contract_market_state',
      domain: 'market',
      symbol: SYMBOL,
      data: {},
    });
    jest.advanceTimersByTime(1_000);
    expect(hub.resubscribeKlineDomain).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().domainReady).toBe(false);
    await flushPromises();

    hub.send({
      type: 'contract_kline_snapshot',
      domain: 'kline',
      symbol: SYMBOL,
      interval: '1m',
      status: 'unavailable',
      data: null,
      kline: null,
    });
    expect(store.getSnapshot()).toMatchObject({
      subscriptionReady: true,
      domainReady: false,
      phase: 'degraded',
    });
    const fetchCountAfterAck = fetchHistory.mock.calls.length;
    jest.advanceTimersByTime(1_999);
    expect(fetchHistory).toHaveBeenCalledTimes(fetchCountAfterAck);
    jest.advanceTimersByTime(1);
    expect(fetchHistory).toHaveBeenCalledTimes(
      fetchCountAfterAck + 1,
    );
    expect(hub.resubscribeKlineDomain).toHaveBeenCalledTimes(2);
    release();
  });

  it('treats a non-native REST snapshot as handled but never as native readiness', async () => {
    const {fetchHistory, hub, store} = createHarness({
      domainReadyTimeoutMs: 1_000,
      restDisplayRefreshMs: 2_000,
    });
    const release = store.acquire('screen');
    hub.setStatus('open');
    await flushPromises();

    hub.send({
      ...nativeFrame({
        source: 'PROVIDER_REST',
        transport: 'REST',
      }),
      type: 'contract_kline_snapshot',
      status: 'ok',
    });

    expect(store.getSnapshot()).toMatchObject({
      subscriptionReady: true,
      domainReady: false,
      phase: 'degraded',
      source: 'REST',
    });
    const resubscribeCount =
      hub.resubscribeKlineDomain.mock.calls.length;
    const fetchCount = fetchHistory.mock.calls.length;
    jest.advanceTimersByTime(1_000);
    expect(hub.resubscribeKlineDomain).toHaveBeenCalledTimes(
      resubscribeCount + 1,
    );
    jest.advanceTimersByTime(1_000);
    expect(fetchHistory).toHaveBeenCalledTimes(fetchCount + 1);
    release();
  });

  it('retains version high-water across reconnect and rejects a rollback frame', async () => {
    const {hub, store} = createHarness();
    const release = store.acquire('screen');
    hub.setStatus('open');
    await flushPromises();
    hub.send(nativeFrame({close: 106, sequence: 5}));
    const items = store.getSnapshot().items;

    hub.setStatus('reconnecting');
    expect(store.getSnapshot()).toMatchObject({
      domainReady: false,
      phase: 'reconnecting',
    });
    expect(store.getSnapshot().items).toEqual(items);

    hub.setStatus('open');
    hub.send(nativeFrame({close: 99, sequence: 4}));
    expect(store.getSnapshot().items).toEqual(items);
    expect(store.getSnapshot()).toMatchObject({
      subscriptionReady: true,
      domainReady: false,
      phase: 'degraded',
    });

    hub.send(nativeFrame({close: 106, sequence: 5}));
    expect(store.getSnapshot()).toMatchObject({
      subscriptionReady: true,
      domainReady: true,
      phase: 'live',
    });
    expect(store.getSnapshot().items).toEqual(items);
    release();
  });

  it('keeps REST display fallback active while the physical transport reconnects', async () => {
    const {fetchHistory, hub, store} = createHarness({
      domainReadyTimeoutMs: 10_000,
      restDisplayRefreshMs: 1_000,
    });
    const release = store.acquire('screen');
    hub.setStatus('open');
    await flushPromises();
    hub.send(nativeFrame({close: 106, sequence: 5}));
    const retainedItems = store.getSnapshot().items;
    const fetchCountBeforeReconnect = fetchHistory.mock.calls.length;

    hub.setStatus('reconnecting');
    expect(store.getSnapshot()).toMatchObject({
      phase: 'reconnecting',
      domainReady: false,
      subscriptionReady: false,
      items: retainedItems,
    });
    expect(fetchHistory).toHaveBeenCalledTimes(
      fetchCountBeforeReconnect + 1,
    );
    await flushPromises();

    const fetchCountAfterImmediateFallback =
      fetchHistory.mock.calls.length;
    jest.advanceTimersByTime(1_000);
    expect(fetchHistory).toHaveBeenCalledTimes(
      fetchCountAfterImmediateFallback + 1,
    );
    expect(store.getSnapshot()).toMatchObject({
      phase: 'reconnecting',
      items: retainedItems,
    });
    release();
  });

  it.each(['retryable-result', 'request-error'] as const)(
    'keeps polling REST while reconnect fallback reports %s',
    async failureKind => {
      const stableItems = [
        bar(BASE_OPEN_TIME - MINUTE, 99),
        bar(BASE_OPEN_TIME, 100),
      ];
      const fetchHistory = jest
        .fn()
        .mockResolvedValueOnce(history(stableItems));
      if (failureKind === 'retryable-result') {
        fetchHistory.mockResolvedValueOnce(
          history([bar(BASE_OPEN_TIME, 80)], {
            stale: true,
            freshness: 'STALE',
            historyIncomplete: true,
            providerErrorCode: 'TIMEOUT',
            retryable: true,
          }),
        );
      } else {
        fetchHistory.mockRejectedValueOnce(
          new Error('history offline'),
        );
      }
      fetchHistory.mockResolvedValue(history(stableItems));
      const {hub, store} = createHarness({
        fetchHistory,
        domainReadyTimeoutMs: 10_000,
        restDisplayRefreshMs: 1_000,
      });
      const release = store.acquire('screen');
      hub.setStatus('open');
      await flushPromises();
      hub.send(nativeFrame({close: 106, sequence: 5}));
      const retainedItems = store.getSnapshot().items;

      hub.setStatus('reconnecting');
      await flushPromises();
      expect(fetchHistory).toHaveBeenCalledTimes(2);
      expect(store.getSnapshot()).toMatchObject({
        phase: 'reconnecting',
        domainReady: false,
        subscriptionReady: false,
        items: retainedItems,
      });

      jest.advanceTimersByTime(1_000);
      await flushPromises();
      expect(fetchHistory).toHaveBeenCalledTimes(3);
      expect(store.getSnapshot().phase).toBe('reconnecting');

      jest.advanceTimersByTime(1_000);
      await flushPromises();
      expect(fetchHistory).toHaveBeenCalledTimes(4);
      expect(store.getSnapshot().phase).toBe('reconnecting');
      release();
    },
  );

  it('keeps REST errors visible after an unavailable subscription acknowledgement', async () => {
    const fetchHistory = jest.fn(() =>
      Promise.reject(new Error('history offline')),
    );
    const {hub, store} = createHarness({fetchHistory});
    const release = store.acquire('screen');
    hub.setStatus('open');
    await flushPromises();

    hub.send({
      type: 'contract_kline_snapshot',
      domain: 'kline',
      symbol: SYMBOL,
      interval: '1m',
      status: 'unavailable',
      data: null,
      kline: null,
    });

    expect(store.getSnapshot()).toMatchObject({
      subscriptionReady: true,
      domainReady: false,
      phase: 'degraded',
      error: 'history offline',
    });
    release();
  });

  it('stops routine REST fallback after the first accepted native frame', async () => {
    const {fetchHistory, hub, store} = createHarness({
      restDisplayRefreshMs: 1_000,
    });
    const release = store.acquire('screen');
    hub.setStatus('open');
    await flushPromises();
    hub.send({
      type: 'contract_kline_snapshot',
      domain: 'kline',
      symbol: SYMBOL,
      interval: '1m',
      status: 'unavailable',
      data: null,
      kline: null,
    });
    const fetchCount = fetchHistory.mock.calls.length;

    hub.send(nativeFrame({close: 107, sequence: 2}));
    expect(store.getSnapshot()).toMatchObject({
      domainReady: true,
      phase: 'live',
    });
    jest.advanceTimersByTime(10_000);
    expect(fetchHistory).toHaveBeenCalledTimes(fetchCount);
    release();
  });

  it('degrades on Kline-domain silence despite Market traffic and recovers on a confirmed replay', async () => {
    const {fetchHistory, hub, store} = createHarness({
      domainReadyTimeoutMs: 10_000,
      domainSilenceTimeoutMs: 1_000,
      restDisplayRefreshMs: 2_000,
    });
    const release = store.acquire('screen');
    hub.setStatus('open');
    await flushPromises();
    hub.send(nativeFrame({close: 107, sequence: 2}));
    expect(store.getSnapshot()).toMatchObject({
      domainReady: true,
      phase: 'live',
    });
    const itemsBeforeSilence = store.getSnapshot().items;
    const sourceBeforeSilence = store.getSnapshot().source;
    const fetchCountBeforeSilence = fetchHistory.mock.calls.length;

    jest.advanceTimersByTime(900);
    hub.send({
      type: 'contract_market_state',
      domain: 'market',
      symbol: SYMBOL,
      data: {},
    });
    hub.send(nativeFrame({close: 90, sequence: 1}));
    jest.advanceTimersByTime(100);

    expect(store.getSnapshot()).toMatchObject({
      domainReady: false,
      subscriptionReady: true,
      phase: 'degraded',
      items: itemsBeforeSilence,
      source: sourceBeforeSilence,
    });
    expect(hub.resubscribeKlineDomain).toHaveBeenCalledTimes(1);
    expect(fetchHistory).toHaveBeenCalledTimes(
      fetchCountBeforeSilence + 1,
    );
    await flushPromises();

    hub.send(nativeFrame({close: 107, sequence: 2}));
    expect(store.getSnapshot()).toMatchObject({
      domainReady: true,
      subscriptionReady: true,
      phase: 'live',
    });
    jest.advanceTimersByTime(999);
    expect(store.getSnapshot().phase).toBe('live');
    jest.advanceTimersByTime(1);
    expect(store.getSnapshot()).toMatchObject({
      domainReady: false,
      phase: 'degraded',
    });
    expect(hub.resubscribeKlineDomain).toHaveBeenCalledTimes(2);
    release();
  });

  it('refreshes the Kline silence deadline on each accepted native frame', async () => {
    const {hub, store} = createHarness({
      domainReadyTimeoutMs: 10_000,
      domainSilenceTimeoutMs: 1_000,
    });
    const release = store.acquire('screen');
    hub.setStatus('open');
    await flushPromises();
    hub.send(nativeFrame({close: 101, sequence: 1}));

    jest.advanceTimersByTime(900);
    hub.send(nativeFrame({close: 102, sequence: 2}));
    jest.advanceTimersByTime(999);
    expect(store.getSnapshot().phase).toBe('live');
    expect(hub.resubscribeKlineDomain).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    expect(store.getSnapshot().phase).toBe('degraded');
    expect(hub.resubscribeKlineDomain).toHaveBeenCalledTimes(1);
    release();
  });

  it('clears the Kline silence watchdog across reconnect and release', async () => {
    const {hub, store} = createHarness({
      domainReadyTimeoutMs: 10_000,
      domainSilenceTimeoutMs: 1_000,
    });
    const release = store.acquire('screen');
    hub.setStatus('open');
    await flushPromises();
    hub.send(nativeFrame({close: 101, sequence: 1}));
    jest.advanceTimersByTime(900);

    hub.setStatus('reconnecting');
    jest.advanceTimersByTime(5_000);
    expect(hub.resubscribeKlineDomain).not.toHaveBeenCalled();
    expect(store.getSnapshot().phase).toBe('reconnecting');

    hub.setStatus('open');
    release();
    const revisionAfterRelease = store.getSnapshot().revision;
    jest.advanceTimersByTime(30_000);
    expect(hub.resubscribeKlineDomain).not.toHaveBeenCalled();
    expect(store.getSnapshot()).toMatchObject({
      phase: 'paused',
      revision: revisionAfterRelease,
    });
  });

  it('degrades a live stream on explicit unavailable and resumes REST display fallback', async () => {
    const {fetchHistory, hub, store} = createHarness({
      domainReadyTimeoutMs: 10_000,
      domainSilenceTimeoutMs: 10_000,
      restDisplayRefreshMs: 1_000,
    });
    const release = store.acquire('screen');
    hub.setStatus('open');
    await flushPromises();
    hub.send(nativeFrame({close: 105, sequence: 2}));
    const fetchCount = fetchHistory.mock.calls.length;

    hub.send({
      type: 'contract_kline_snapshot',
      domain: 'kline',
      symbol: SYMBOL,
      interval: '1m',
      status: 'unavailable',
      data: null,
      kline: null,
    });
    expect(store.getSnapshot()).toMatchObject({
      subscriptionReady: true,
      domainReady: false,
      phase: 'degraded',
      source: 'REST+WS_NATIVE',
    });
    jest.advanceTimersByTime(1_000);
    expect(fetchHistory).toHaveBeenCalledTimes(fetchCount + 1);
    release();
  });

  it('retains the stable REST baseline when a retryable stale fallback is shorter', async () => {
    const stableItems = [
      bar(BASE_OPEN_TIME - 2 * MINUTE, 98),
      bar(BASE_OPEN_TIME - MINUTE, 99),
      bar(BASE_OPEN_TIME, 100),
    ];
    const fetchHistory = jest
      .fn()
      .mockResolvedValueOnce(history(stableItems))
      .mockResolvedValueOnce(
        history([bar(BASE_OPEN_TIME, 80)], {
          stale: true,
          freshness: 'STALE',
          historyIncomplete: true,
          providerErrorCode: 'TIMEOUT',
          retryable: true,
        }),
      );
    const {hub, store} = createHarness({
      fetchHistory,
      restDisplayRefreshMs: 1_000,
    });
    const release = store.acquire('screen');
    hub.setStatus('open');
    await flushPromises();
    hub.send({
      type: 'contract_kline_snapshot',
      domain: 'kline',
      symbol: SYMBOL,
      interval: '1m',
      status: 'unavailable',
      data: null,
      kline: null,
    });

    jest.advanceTimersByTime(1_000);
    await flushPromises();

    expect(store.getSnapshot().items).toEqual(stableItems);
    expect(store.getSnapshot()).toMatchObject({
      domainReady: false,
      gapDetected: false,
      phase: 'degraded',
      source: 'REST',
    });
    release();
  });

  it('uses explicit polling REST-only mode for 1d until backend bucket authority is unified', async () => {
    const {fetchHistory, hub, store} = createHarness({
      interval: '1d',
      restDisplayRefreshMs: 1_000,
    });
    const release = store.acquire('screen');
    await flushPromises();

    expect(hub.acquireKlineDomain).not.toHaveBeenCalled();
    expect(store.getSnapshot()).toMatchObject({
      mode: 'REST_ONLY',
      source: 'REST',
      phase: 'degraded',
      subscriptionReady: false,
      domainReady: false,
    });
    jest.advanceTimersByTime(1_000);
    expect(fetchHistory).toHaveBeenCalledTimes(2);
    release();
  });

  it.each(['ack-first', 'history-first'] as const)(
    'stops retrying a permanent provider failure regardless of ack order (%s)',
    async order => {
      const first = deferred<ContractKlineHistoryResult>();
      const fetchHistory = jest
        .fn()
        .mockImplementationOnce(() => first.promise)
        .mockResolvedValue(
          history([], {
            historyTerminal: false,
            providerErrorCode: 'UNSUPPORTED',
            retryable: false,
          }),
        );
      const {hub, store} = createHarness({fetchHistory});
      const release = store.acquire('screen');
      hub.setStatus('open');
      const ack = () =>
        hub.send({
          type: 'contract_kline_snapshot',
          domain: 'kline',
          symbol: SYMBOL,
          interval: '1m',
          status: 'unavailable',
          data: null,
          kline: null,
        });

      if (order === 'ack-first') ack();
      first.resolve(
        history([], {
          historyTerminal: false,
          providerErrorCode: 'UNSUPPORTED',
          retryable: false,
        }),
      );
      await flushPromises();
      if (order === 'history-first') ack();

      jest.advanceTimersByTime(30_000);
      expect(fetchHistory).toHaveBeenCalledTimes(1);
      expect(store.getSnapshot()).toMatchObject({
        phase: 'degraded',
        error: '合约 K线历史暂不可用',
      });
      release();
    },
  );

  it.each(['ack-first', 'history-first'] as const)(
    'keeps polling a legitimate definitive empty current window (%s)',
    async order => {
      const first = deferred<ContractKlineHistoryResult>();
      const fetchHistory = jest
        .fn()
        .mockImplementationOnce(() => first.promise)
        .mockResolvedValue(history([bar(BASE_OPEN_TIME)]));
      const {hub, store} = createHarness({
        fetchHistory,
        restDisplayRefreshMs: 1_000,
      });
      const release = store.acquire('screen');
      hub.setStatus('open');
      const ack = () =>
        hub.send({
          type: 'contract_kline_snapshot',
          domain: 'kline',
          symbol: SYMBOL,
          interval: '1m',
          status: 'unavailable',
          data: null,
          kline: null,
        });

      if (order === 'ack-first') ack();
      first.resolve(
        history([], {
          historyTerminal: true,
          historyComplete: true,
          hasMoreBefore: false,
          coverageComplete: true,
        }),
      );
      await flushPromises();
      if (order === 'history-first') ack();
      const fetchCount = fetchHistory.mock.calls.length;

      jest.advanceTimersByTime(1_000);
      expect(fetchHistory).toHaveBeenCalledTimes(fetchCount + 1);
      release();
    },
  );

  it('rejects a delayed former provider and only accepts data-stable same-revision finality', async () => {
    const {hub, store} = createHarness();
    const release = store.acquire('screen');
    hub.setStatus('open');
    await flushPromises();

    hub.send(
      nativeFrame({
        close: 101,
        provider: 'PROVIDER_A',
        generation: 10,
        sequence: 1,
        receivedAtMs: BASE_OPEN_TIME + 40_000,
      }),
    );
    hub.send(
      nativeFrame({
        close: 102,
        provider: 'PROVIDER_B',
        generation: 20,
        sequence: 1,
        receivedAtMs: BASE_OPEN_TIME + 50_000,
      }),
    );
    hub.send(
      nativeFrame({
        close: 90,
        provider: 'PROVIDER_A',
        generation: 10,
        sequence: 2,
        receivedAtMs: BASE_OPEN_TIME + 45_000,
      }),
    );
    expect(store.getSnapshot().items.at(-1)?.close).toBe(102);

    hub.send(
      nativeFrame({
        close: 103,
        provider: 'PROVIDER_B',
        generation: 20,
        sequence: 1,
        isClosed: true,
        receivedAtMs: BASE_OPEN_TIME + 55_000,
      }),
    );
    expect(store.getSnapshot().items.at(-1)?.close).toBe(102);

    hub.send(
      nativeFrame({
        close: 102,
        provider: 'PROVIDER_B',
        generation: 20,
        sequence: 1,
        isClosed: true,
        receivedAtMs: BASE_OPEN_TIME + 56_000,
      }),
    );
    expect(store.getSnapshot().items.at(-1)?.close).toBe(102);
    expect(store.getSnapshot().phase).toBe('live');
    release();
  });

  it('coalesces rapid current-bucket renders and cancels a pending render on release', async () => {
    const {hub, store} = createHarness({renderThrottleMs: 100});
    const release = store.acquire('screen');
    hub.setStatus('open');
    await flushPromises();
    hub.send(nativeFrame({close: 101, sequence: 1}));
    const listener = jest.fn();
    const unsubscribe = store.subscribe(listener);
    listener.mockClear();

    hub.send(nativeFrame({close: 102, sequence: 2}));
    hub.send(nativeFrame({close: 103, sequence: 3}));
    expect(store.getSnapshot().items.at(-1)?.close).toBe(101);
    expect(listener).not.toHaveBeenCalled();
    jest.advanceTimersByTime(100);
    expect(store.getSnapshot().items.at(-1)?.close).toBe(103);
    expect(listener).toHaveBeenCalledTimes(1);

    listener.mockClear();
    hub.send(nativeFrame({close: 104, sequence: 4}));
    release();
    const revisionAfterRelease = store.getSnapshot().revision;
    listener.mockClear();
    jest.advanceTimersByTime(100);
    expect(store.getSnapshot().revision).toBe(revisionAfterRelease);
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('flushes a throttled latest frame when reconnect replay confirms it', async () => {
    const {hub, store} = createHarness({
      domainReadyTimeoutMs: 10_000,
      domainSilenceTimeoutMs: 10_000,
      renderThrottleMs: 100,
    });
    const release = store.acquire('screen');
    hub.setStatus('open');
    await flushPromises();
    hub.send(nativeFrame({close: 101, sequence: 1}));
    hub.send(nativeFrame({close: 102, sequence: 2}));
    expect(store.getSnapshot().items.at(-1)?.close).toBe(101);

    hub.setStatus('reconnecting');
    hub.setStatus('open');
    hub.send(nativeFrame({close: 102, sequence: 2}));

    expect(store.getSnapshot()).toMatchObject({
      domainReady: true,
      phase: 'live',
    });
    expect(store.getSnapshot().items.at(-1)?.close).toBe(102);
    release();
  });

  it('enforces the configured in-memory bar bound under sustained updates', async () => {
    const {hub, store} = createHarness({historyLimit: 5});
    const release = store.acquire('screen');
    hub.setStatus('open');
    await flushPromises();

    for (let index = 0; index < 20; index += 1) {
      hub.send(
        nativeFrame({
          openTime: BASE_OPEN_TIME + index * MINUTE,
          close: 100 + index,
          sequence: index + 1,
        }),
      );
    }
    expect(store.getSnapshot().items).toHaveLength(5);
    expect(store.getSnapshot().items[0].openTime).toBe(
      BASE_OPEN_TIME + 15 * MINUTE,
    );
    release();
  });
});
