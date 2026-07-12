import { describe, expect, it } from '@jest/globals';
import type {
  DomainName,
  DomainSnapshot,
  DomainSnapshotMetadata,
} from '@/components/spot/spotDomainSnapshot';
import type {
  SpotDepthResponse,
  SpotMarketKlineItem,
  SpotMarketTickerItem,
  SpotMarketTradeItem,
} from '@/lib/api/modules/spot';
import { createSpotPublicMarketStore } from './spotMarketStore';

function makeSnapshot<TData>(params: {
  id: string;
  domain: DomainName;
  symbol?: string;
  interval?: string | null;
  data: TData;
  metadata?: Partial<DomainSnapshotMetadata>;
  revision?: {
    epoch: number | null;
    sequence: number | null;
    is_closed: boolean | null;
    close_state_source: string | null;
  } | null;
}): DomainSnapshot<TData> {
  return {
    schema_version: 'spot-domain-snapshot/v1',
    snapshot_id: params.id,
    emitted_at_ms: 1_720_000_000_100,
    data: params.data,
    metadata: {
      domain: params.domain,
      symbol: params.symbol ?? 'BTCUSDT',
      interval: params.interval ?? null,
      provider: 'BINANCE',
      provider_symbol: 'BTCUSDT',
      transport: 'PROVIDER_WS',
      cache_origin: 'PROVIDER_MEMORY',
      source: 'LIVE_WS',
      freshness: 'LIVE',
      fallback_reason: null,
      provider_event_time_ms: 1_720_000_000_000,
      received_at_ms: 1_720_000_000_050,
      cache_updated_at_ms: 1_720_000_000_050,
      age_ms: 50,
      ttl_ms: 5_000,
      stale: false,
      provider_generation: 1,
      revision: params.revision ?? null,
      completeness: {
        status: 'COMPLETE',
        has_data: true,
        item_count: 1,
        missing_fields: [],
        details: {},
      },
      freshness_basis: 'RECEIVED_AT',
      ...params.metadata,
    },
  };
}

describe('SpotPublicMarketStore', () => {
  it('tracks interest ref-counts and releases each handle once', () => {
    const store = createSpotPublicMarketStore();
    const first = store.acquireInterest({
      owner: 'header',
      symbol: 'btcusdt',
      domains: ['ticker', 'depth'],
    });
    const second = store.acquireInterest({
      owner: 'orderbook',
      symbol: 'BTC-USDT',
      domains: ['depth'],
    });

    expect(store.getState().interestRefCounts).toEqual({
      'BTCUSDT:ticker': 1,
      'BTCUSDT:depth': 2,
    });
    expect(first.release()).toBe(true);
    expect(first.release()).toBe(false);
    expect(store.getState().interestRefCounts).toEqual({
      'BTCUSDT:depth': 1,
    });
    expect(second.release()).toBe(true);
    expect(store.getState().interestRefCounts).toEqual({});
  });

  it('ingests ticker, depth, and trades snapshots without changing their payloads', () => {
    const store = createSpotPublicMarketStore();
    const ticker = makeSnapshot<SpotMarketTickerItem>({
      id: 'ticker-1',
      domain: 'ticker',
      data: { symbol: 'BTCUSDT', last_price: '64000' },
    });
    const depth = makeSnapshot<SpotDepthResponse>({
      id: 'depth-1',
      domain: 'depth',
      data: {
        symbol: 'BTCUSDT',
        bids: [{ price: '63999', amount: '1' }],
        asks: [{ price: '64001', amount: '2' }],
      },
    });
    const trades = makeSnapshot<SpotMarketTradeItem[]>({
      id: 'trades-1',
      domain: 'trades',
      data: [{ id: 'trade-1', price: '64000', amount: '0.1', side: 'BUY' }],
    });

    store.ingestSnapshot({ ticker, depth, trades });
    const symbolState = store.select((state) => state.symbols.BTCUSDT);

    expect(symbolState.ticker.snapshot).toBe(ticker);
    expect(symbolState.depth.snapshot).toBe(depth);
    expect(symbolState.trades.snapshot).toBe(trades);
    expect(symbolState.ticker.lifecycle).toBe('ready');
  });

  it('keeps the latest depth authority and preserves sequence and checksum payloads', () => {
    const store = createSpotPublicMarketStore();
    const currentData = {
      symbol: 'BTCUSDT',
      bids: [{ price: '64000', amount: '1' }],
      asks: [{ price: '64001', amount: '2' }],
      sequence: 12,
      checksum: 'current-checksum',
    } as SpotDepthResponse & { sequence: number; checksum: string };
    const olderData = {
      ...currentData,
      bids: [{ price: '63990', amount: '1' }],
      sequence: 11,
      checksum: 'older-checksum',
    };
    const current = makeSnapshot<SpotDepthResponse>({
      id: 'depth-current',
      domain: 'depth',
      data: currentData,
      metadata: {
        provider_generation: 3,
        revision: {
          epoch: 3,
          sequence: 12,
          is_closed: null,
          close_state_source: null,
        },
      },
    });
    const older = makeSnapshot<SpotDepthResponse>({
      id: 'depth-older',
      domain: 'depth',
      data: olderData,
      metadata: {
        provider_generation: 3,
        provider_event_time_ms: 1_720_000_000_100,
        revision: {
          epoch: 3,
          sequence: 11,
          is_closed: null,
          close_state_source: null,
        },
      },
    });

    store.ingestDepth(current);
    store.ingestDepth(older);

    const data = store.getState().symbols.BTCUSDT.depth.snapshot?.data as typeof currentData;
    expect(data.sequence).toBe(12);
    expect(data.checksum).toBe('current-checksum');
    expect(data.bids[0].price).toBe('64000');
  });

  it('stores only the current kline snapshot for its symbol and interval', () => {
    const store = createSpotPublicMarketStore();
    const kline = makeSnapshot<SpotMarketKlineItem>({
      id: 'kline-1',
      domain: 'kline',
      interval: '1Mutc',
      data: {
        open_time: 1_719_792_000_000,
        open: '60000',
        high: '65000',
        low: '59000',
        close: '64000',
        volume: '100',
      },
      revision: {
        epoch: 3,
        sequence: 9,
        is_closed: false,
        close_state_source: 'PROVIDER',
      },
    });

    store.ingestKlineCurrent(kline);
    const slot = store.getState().symbols.BTCUSDT.klineByInterval['1Mutc'];

    expect(slot.snapshot).toBe(kline);
    expect(slot.lastOpenTime).toBe(1_719_792_000_000);
    expect(slot.revisionEpoch).toBe(3);
    expect(slot.revisionSequence).toBe(9);
    expect(slot.isClosed).toBe(false);
  });

  it('stores the latest delivered current candle without taking over revision authority', () => {
    const store = createSpotPublicMarketStore();
    const newerRevision = makeSnapshot<SpotMarketKlineItem>({
      id: 'kline-revision-5',
      domain: 'kline',
      interval: '1m',
      data: {
        open_time: 1_719_792_000_000,
        open: '100',
        high: '110',
        low: '90',
        close: '105',
        volume: '10',
      },
      revision: {
        epoch: 1,
        sequence: 5,
        is_closed: false,
        close_state_source: 'PROVIDER',
      },
    });
    const laterDeliveredOlderRevision = makeSnapshot<SpotMarketKlineItem>({
      id: 'kline-revision-4',
      domain: 'kline',
      interval: '1m',
      data: {
        open_time: 1_719_792_000_000,
        open: '100',
        high: '110',
        low: '90',
        close: '104',
        volume: '10',
      },
      revision: {
        epoch: 1,
        sequence: 4,
        is_closed: false,
        close_state_source: 'PROVIDER',
      },
    });

    store.ingestKlineCurrent(newerRevision);
    store.ingestKlineCurrent(laterDeliveredOlderRevision);

    const slot = store.getState().symbols.BTCUSDT.klineByInterval['1m'];
    expect(slot.snapshot).toBe(laterDeliveredOlderRevision);
    expect(slot.sequence).toBe(4);
  });

  it('keeps a newer LIVE_WS ticker authoritative over older REST or stale ticker data', () => {
    const store = createSpotPublicMarketStore();
    const live = makeSnapshot<SpotMarketTickerItem>({
      id: 'ticker-live',
      domain: 'ticker',
      data: { symbol: 'BTCUSDT', last_price: '64001' },
      metadata: {
        provider_event_time_ms: 1_720_000_000_200,
      },
    });
    const olderRest = makeSnapshot<SpotMarketTickerItem>({
      id: 'ticker-rest-older',
      domain: 'ticker',
      data: { symbol: 'BTCUSDT', last_price: '63999' },
      metadata: {
        transport: 'PROVIDER_REST',
        source: 'REST_SNAPSHOT',
        freshness: 'RECENT',
        provider_event_time_ms: 1_720_000_000_100,
      },
    });
    const stale = makeSnapshot<SpotMarketTickerItem>({
      id: 'ticker-stale',
      domain: 'ticker',
      data: { symbol: 'BTCUSDT', last_price: '64000' },
      metadata: {
        source: 'LAST_GOOD',
        freshness: 'STALE',
        stale: true,
        provider_event_time_ms: 1_720_000_000_200,
      },
    });

    store.ingestTicker(live);
    store.ingestTicker(olderRest);
    store.ingestTicker(stale);

    expect(store.getState().symbols.BTCUSDT.ticker.snapshot).toBe(live);
  });

  it('accepts a fresh provider switch and rejects a retired ticker provider', () => {
    const store = createSpotPublicMarketStore();
    const binance = makeSnapshot<SpotMarketTickerItem>({
      id: 'ticker-binance',
      domain: 'ticker',
      data: { symbol: 'BTCUSDT', last_price: '64000' },
      metadata: { provider: 'BINANCE' },
    });
    const okx = makeSnapshot<SpotMarketTickerItem>({
      id: 'ticker-okx',
      domain: 'ticker',
      data: { symbol: 'BTCUSDT', last_price: '64001' },
      metadata: {
        provider: 'OKX',
        provider_event_time_ms: 1_720_000_000_100,
      },
    });
    const retiredBinance = makeSnapshot<SpotMarketTickerItem>({
      id: 'ticker-binance-retired',
      domain: 'ticker',
      data: { symbol: 'BTCUSDT', last_price: '64002' },
      metadata: {
        provider: 'BINANCE',
        provider_event_time_ms: 1_720_000_000_200,
      },
    });

    store.ingestTicker(binance);
    store.ingestTicker(okx);
    store.ingestTicker(retiredBinance);

    const slot = store.getState().symbols.BTCUSDT.ticker;
    expect(slot.snapshot).toBe(okx);
    expect(slot.retiredProviders).toContain('BINANCE');
  });
});
