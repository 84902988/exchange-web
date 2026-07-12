import { beforeEach, describe, expect, it } from '@jest/globals';
import type { SpotMarketTradeItem } from '../../lib/api/modules/spot';
import { createSpotPublicMarketStore } from '../../lib/realtime/spotMarketStore';
import {
  getSpotTradesCollectionMetadata,
  ingestSpotTradesStoreEvent,
  resetSpotTradesStoreAdapterForTests,
  selectSpotTradesStoreSlot,
  tradesSnapshotToDomainEvent,
} from './spotTradesStoreAdapter';

const BASE = 1_720_000_000_000;
const store = createSpotPublicMarketStore();

function trade(options: {
  id?: string | null;
  provider?: string;
  price?: string;
  eventTimeMs?: number;
  receivedAtMs?: number;
} = {}): SpotMarketTradeItem {
  const id = options.id === undefined ? 'trade-1' : options.id;
  return {
    id,
    trade_id: id,
    provider_trade_id: id,
    provider: options.provider ?? 'OKX_SPOT',
    provider_symbol: options.provider === 'BITGET_SPOT' ? 'BTCUSDT' : 'BTC-USDT',
    price: options.price ?? '100',
    amount: '1',
    side: 'BUY',
    event_time_ms: options.eventTimeMs ?? BASE,
    received_at_ms: options.receivedAtMs ?? BASE + 100,
    source: 'LIVE_WS',
    freshness: 'LIVE',
  };
}

function ingestIncremental(item: SpotMarketTradeItem) {
  return ingestSpotTradesStoreEvent(store, {
    symbol: 'BTCUSDT',
    domain: 'trades',
    provider: item.provider,
    eventTimeMs: item.event_time_ms,
    receivedAtMs: item.received_at_ms ?? 0,
    transport: 'ws_incremental',
    source: item.source,
    freshness: item.freshness,
    data: [item],
  }, {
    providerSymbol: item.provider_symbol,
    incrementalTrade: item,
  });
}

beforeEach(() => {
  store.resetForTests();
  resetSpotTradesStoreAdapterForTests(store);
});

describe('spot trades store adapter', () => {
  it('keeps FIFO ordering and last trade identity in the store snapshot', () => {
    const history = trade({ id: 'history', eventTimeMs: BASE, price: '100' });
    ingestSpotTradesStoreEvent(store, {
      symbol: 'BTCUSDT',
      domain: 'trades',
      provider: 'OKX_SPOT',
      eventTimeMs: BASE,
      receivedAtMs: BASE + 100,
      transport: 'rest',
      source: 'REST_SNAPSHOT',
      freshness: 'RECENT',
      data: [history],
    }, { providerSymbol: 'BTC-USDT' });

    const live = trade({ id: 'live', eventTimeMs: BASE + 1_000, price: '200' });
    ingestIncremental(live);

    const slot = selectSpotTradesStoreSlot(store.getState(), 'btc-usdt');
    const event = tradesSnapshotToDomainEvent(slot?.snapshot);
    const metadata = getSpotTradesCollectionMetadata(slot?.snapshot);
    expect(event?.data.map((row) => row.provider_trade_id)).toEqual(['live', 'history']);
    expect(slot?.snapshot?.metadata.source).toBe('LIVE_WS');
    expect(slot?.snapshot?.metadata.freshness).toBe('LIVE');
    expect(slot?.snapshot?.metadata.completeness.details.last_trade_id).toBe('live');
    expect(metadata?.authorityTrade?.provider_trade_id).toBe('live');
  });

  it('preserves weak occurrences and does not promote a strong duplicate', () => {
    const weak = trade({ id: null, eventTimeMs: BASE + 1_000, receivedAtMs: BASE + 500 });
    ingestIncremental(weak);
    ingestIncremental({ ...weak });

    const duplicateBase = trade({ id: 'strong', eventTimeMs: BASE + 2_000, price: '200' });
    ingestIncremental(duplicateBase);
    const duplicate = ingestIncremental({
      ...duplicateBase,
      price: '777',
      received_at_ms: BASE + 20_000,
    });

    const rows = store.getState().symbols.BTCUSDT.trades.snapshot?.data ?? [];
    expect(rows.filter((row) => row.provider_trade_id === null)).toHaveLength(2);
    expect(duplicate.addedOccurrence).toBe(false);
    expect(duplicate.applyAuthoritySideEffects).toBe(false);
    expect(duplicate.authorityTrade?.price).toBe('200');
  });

  it('replaces prior rows on a fresh provider switch', () => {
    ingestIncremental(trade({ id: 'okx', provider: 'OKX_SPOT', eventTimeMs: BASE }));
    ingestIncremental(trade({
      id: 'bitget',
      provider: 'BITGET_SPOT',
      eventTimeMs: BASE + 1_000,
    }));

    const rows = store.getState().symbols.BTCUSDT.trades.snapshot?.data ?? [];
    expect(rows.map((row) => row.provider_trade_id)).toEqual(['bitget']);
  });
});
