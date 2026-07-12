import { describe, expect, it } from '@jest/globals';
import type { DomainSnapshot } from '../spotDomainSnapshot';
import type { SpotMarketKlineItem } from '../../../lib/api/modules/spot';
import { createSpotPublicMarketStore } from '../../../lib/realtime/spotMarketStore';
import {
  klineSnapshotToRealtimeEvent,
  selectSpotKlineCurrentSlot,
  subscribeSpotKlineCurrent,
} from './spotKlineStoreAdapter';

function snapshot(options: {
  id: string;
  symbol?: string;
  interval?: string;
  close?: string;
  sequence?: number;
  closed?: boolean;
}): DomainSnapshot<SpotMarketKlineItem> {
  const sequence = options.sequence ?? 1;
  return {
    schema_version: 'spot-domain-snapshot/v1',
    snapshot_id: options.id,
    emitted_at_ms: 1_720_000_000_100 + sequence,
    data: {
      interval: options.interval ?? '1m',
      open_time: 1_720_000_000_000,
      open: '100',
      high: '110',
      low: '90',
      close: options.close ?? '105',
      volume: '7',
      revision_epoch: 2,
      revision_seq: sequence,
      is_closed: options.closed ?? false,
      close_state_source: 'PROVIDER_CONFIRMED',
    } as SpotMarketKlineItem,
    metadata: {
      domain: 'kline',
      symbol: options.symbol ?? 'BTCUSDT',
      interval: options.interval ?? '1m',
      provider: 'OKX_SPOT',
      provider_symbol: 'BTC-USDT',
      transport: 'PROVIDER_WS',
      cache_origin: 'NONE',
      source: 'LIVE_WS',
      freshness: 'LIVE',
      fallback_reason: null,
      provider_event_time_ms: 1_720_000_000_000,
      received_at_ms: 1_720_000_000_100 + sequence,
      cache_updated_at_ms: null,
      age_ms: 0,
      ttl_ms: null,
      stale: false,
      provider_generation: 3,
      revision: {
        epoch: 2,
        sequence,
        is_closed: options.closed ?? false,
        close_state_source: 'PROVIDER_CONFIRMED',
      },
      completeness: {
        status: 'COMPLETE',
        has_data: true,
        item_count: 1,
        missing_fields: [],
        details: {},
      },
      freshness_basis: 'RECEIVED_AT',
    },
  };
}

describe('spot kline store adapter', () => {
  it('preserves current candle OHLCV, revision, sequence, and closed state', () => {
    const store = createSpotPublicMarketStore();
    const current = snapshot({ id: 'kline-1', sequence: 8, closed: true });
    store.ingestKlineCurrent(current);

    const slot = selectSpotKlineCurrentSlot(store.getState(), 'btc-usdt', '1m');
    const event = klineSnapshotToRealtimeEvent(slot?.snapshot, slot);

    expect(event?.kline).toBe(current.data);
    expect(event?.kline.close).toBe('105');
    expect(event?.kline.volume).toBe('7');
    expect(event?.revision?.epoch).toBe(2);
    expect(event?.revision?.sequence).toBe(8);
    expect(event?.sequence).toBe(8);
    expect(event?.closed).toBe(true);
  });

  it('subscribes only to the selected symbol and interval and releases its interest', () => {
    const store = createSpotPublicMarketStore();
    store.ingestKlineCurrent(snapshot({ id: 'current', close: '101' }));
    const events: string[] = [];
    const unsubscribe = subscribeSpotKlineCurrent({
      store,
      symbol: 'BTCUSDT',
      interval: '1m',
      owner: 'adapter-test',
      onSnapshot: (event) => events.push(String(event.kline.close)),
    });

    store.ingestKlineCurrent(snapshot({ id: 'other-interval', interval: '5m', close: '999' }));
    store.ingestKlineCurrent(snapshot({ id: 'other-symbol', symbol: 'ETHUSDT', close: '888' }));
    store.ingestKlineCurrent(snapshot({ id: 'next', close: '102', sequence: 2 }));

    expect(events).toEqual(['101', '102']);
    expect(store.getState().interestRefCounts['BTCUSDT:kline:1m']).toBe(1);
    unsubscribe();
    expect(store.getState().interestRefCounts['BTCUSDT:kline:1m']).toBeUndefined();

    store.ingestKlineCurrent(snapshot({ id: 'retired', close: '103', sequence: 3 }));
    expect(events).toEqual(['101', '102']);
  });
});
