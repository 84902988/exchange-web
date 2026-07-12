import { describe, expect, it } from '@jest/globals';
import {
  createSpotPublicMarketStore,
  getSpotMarketStoreDebugState,
} from './spotMarketStore';
import {
  attachSpotMarketStoreTransportMirror,
  type SpotMarketMirrorTransport,
} from './spotMarketStore.transport';
import { subscribeSpotKlineCurrent } from '@/components/spot/tradingview/spotKlineStoreAdapter';

type TestEventType = 'snapshot' | 'trade' | 'depth' | 'ticker' | 'kline';
type TestStatus = 'connecting' | 'open' | 'closed';

class TestTransport implements SpotMarketMirrorTransport {
  readonly handlers = new Map<TestEventType, Set<(message: unknown) => void>>();
  readonly statusHandlers = new Set<(status: TestStatus) => void>();

  subscribe(type: TestEventType, handler: (message: unknown) => void): () => void {
    const bucket = this.handlers.get(type) ?? new Set<(message: unknown) => void>();
    bucket.add(handler);
    this.handlers.set(type, bucket);
    return () => {
      bucket.delete(handler);
      if (!bucket.size) this.handlers.delete(type);
    };
  }

  subscribeStatus(handler: (status: TestStatus) => void): () => void {
    this.statusHandlers.add(handler);
    handler('closed');
    return () => this.statusHandlers.delete(handler);
  }

  emit(type: TestEventType, message: Record<string, unknown>): void {
    for (const handler of this.handlers.get(type) ?? []) handler(message);
  }

  emitStatus(status: TestStatus): void {
    for (const handler of this.statusHandlers) handler(status);
  }
}

describe('Spot market transport mirror', () => {
  it('mirrors snapshot and incremental domains without acquiring a transport subscription', () => {
    const transport = new TestTransport();
    const store = createSpotPublicMarketStore();
    const interest = store.acquireInterest({
      owner: 'mirror-test',
      symbol: 'BTCUSDT',
      domains: ['ticker', 'depth', 'trades', 'kline'],
      interval: '1m',
    });
    const detach = attachSpotMarketStoreTransportMirror(transport, store);

    transport.emit('snapshot', {
      type: 'spot_market_snapshot',
      symbol: 'BTCUSDT',
      ticker: {
        symbol: 'BTCUSDT',
        last_price: '64000',
        provider: 'BINANCE',
        source: 'LIVE_WS',
        freshness: 'LIVE',
        event_time_ms: 1_720_000_000_000,
      },
      depth: {
        symbol: 'BTCUSDT',
        bids: [{ price: '63999', amount: '1' }],
        asks: [{ price: '64001', amount: '1' }],
        provider: 'BINANCE',
        source: 'LIVE_WS',
        freshness: 'LIVE',
        event_time_ms: 1_720_000_000_010,
      },
      trades: {
        symbol: 'BTCUSDT',
        provider: 'BINANCE',
        source: 'LIVE_WS',
        freshness: 'LIVE',
        items: [{ id: 'snapshot-trade', price: '64000', amount: '0.1', side: 'BUY' }],
      },
    });
    transport.emit('ticker', {
      type: 'spot_ticker_update',
      symbol: 'BTCUSDT',
      ticker: {
        symbol: 'BTCUSDT',
        last_price: '64001',
        provider: 'BINANCE',
        source: 'LIVE_WS',
        freshness: 'LIVE',
        event_time_ms: 1_720_000_000_020,
      },
    });
    transport.emit('depth', {
      type: 'spot_depth_update',
      symbol: 'BTCUSDT',
      depth: {
        symbol: 'BTCUSDT',
        bids: [{ price: '64000', amount: '2' }],
        asks: [{ price: '64002', amount: '1' }],
        provider: 'BINANCE',
        source: 'LIVE_WS',
        freshness: 'LIVE',
        event_time_ms: 1_720_000_000_030,
      },
    });
    transport.emit('trade', {
      type: 'spot_trade',
      symbol: 'BTCUSDT',
      provider: 'BINANCE',
      source: 'LIVE_WS',
      freshness: 'LIVE',
      trade: {
        id: 'incremental-trade',
        price: '64001',
        amount: '0.2',
        side: 'BUY',
        event_time_ms: 1_720_000_000_040,
      },
    });
    transport.emit('kline', {
      type: 'spot_kline_update',
      symbol: 'BTCUSDT',
      interval: '1m',
      kline: {
        interval: '1m',
        open_time: 1_720_000_000_000,
        open: '64000',
        high: '64002',
        low: '63999',
        close: '64001',
        volume: '10',
        provider: 'BINANCE',
        source: 'LIVE_WS',
        freshness: 'LIVE',
        revision_epoch: 2,
        revision_seq: 4,
        is_closed: false,
      },
    });
    transport.emitStatus('open');

    const debug = getSpotMarketStoreDebugState(store);
    const btc = debug.domainSnapshots.BTCUSDT;
    expect(debug.currentSymbol).toBe('BTCUSDT');
    expect(debug.subscriptionCount).toBe(1);
    expect(debug.lastEventTimeMs).toBeGreaterThanOrEqual(1_720_000_000_040);
    expect(debug.transport.status).toBe('open');
    expect(debug.transport.generation).toBe(1);
    expect(btc.ticker?.data?.last_price).toBe('64001');
    expect(btc.depth?.data?.bids[0].price).toBe('64000');
    expect(btc.trades?.data?.map((trade) => trade.id)).toEqual([
      'incremental-trade',
      'snapshot-trade',
    ]);
    expect(btc.klineCurrentByInterval['1m']?.data?.close).toBe('64001');

    interest.release();
    detach();
    expect(transport.handlers.size).toBe(0);
    expect(transport.statusHandlers.size).toBe(0);
  });

  it('attaches at most one listener set for the same transport and store', () => {
    const transport = new TestTransport();
    const store = createSpotPublicMarketStore();

    const firstDetach = attachSpotMarketStoreTransportMirror(transport, store);
    const secondDetach = attachSpotMarketStoreTransportMirror(transport, store);

    expect(secondDetach).toBe(firstDetach);
    expect(transport.handlers.size).toBe(5);
    expect(transport.statusHandlers.size).toBe(1);

    firstDetach();
    expect(transport.handlers.size).toBe(0);
    expect(transport.statusHandlers.size).toBe(0);
  });

  it('fans a realtime current candle through the store kline selector adapter', () => {
    const transport = new TestTransport();
    const store = createSpotPublicMarketStore();
    const detach = attachSpotMarketStoreTransportMirror(transport, store);
    const received: Array<{ close: string | number; sequence: number | null; closed: boolean | null }> = [];
    const unsubscribe = subscribeSpotKlineCurrent({
      store,
      symbol: 'BTCUSDT',
      interval: '1m',
      owner: 'transport-kline-test',
      emitCurrent: false,
      onSnapshot: (event) => received.push({
        close: event.kline.close,
        sequence: event.sequence,
        closed: event.closed,
      }),
    });

    transport.emit('kline', {
      type: 'spot_kline_update',
      symbol: 'BTCUSDT',
      interval: '1m',
      kline: {
        interval: '1m',
        open_time: 1_720_000_000_000,
        open: '100',
        high: '106',
        low: '99',
        close: '105',
        volume: '7',
        provider: 'OKX_SPOT',
        source: 'LIVE_WS',
        freshness: 'LIVE',
        revision_epoch: 2,
        revision_seq: 9,
        is_closed: true,
        close_state_source: 'PROVIDER_CONFIRMED',
      },
    });

    expect(received).toEqual([{ close: '105', sequence: 9, closed: true }]);
    unsubscribe();
    detach();
  });
});
