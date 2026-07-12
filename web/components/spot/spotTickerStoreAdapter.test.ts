import { describe, expect, it } from '@jest/globals';
import type { SpotMarketTickerItem } from '../../lib/api/modules/spot';
import {
  createSpotTickerStoreSnapshot,
  selectSpotTickerStoreSlot,
  tickerSnapshotToDomainEvent,
} from './spotTickerStoreAdapter';
import { createSpotPublicMarketStore } from '../../lib/realtime/spotMarketStore';

describe('spot ticker store adapter', () => {
  it('maps a legacy REST ticker event into the store without changing ticker data', () => {
    const store = createSpotPublicMarketStore();
    const ticker: SpotMarketTickerItem = {
      symbol: 'BTCUSDT',
      last_price: '64000',
      source: 'REST_SNAPSHOT',
      freshness: 'RECENT',
    };
    const snapshot = createSpotTickerStoreSnapshot({
      symbol: 'BTCUSDT',
      domain: 'ticker',
      provider: 'BINANCE',
      eventTimeMs: 1_720_000_000_000,
      receivedAtMs: 1_720_000_000_100,
      transport: 'rest',
      source: 'REST_SNAPSHOT',
      freshness: 'RECENT',
      data: ticker,
    });

    store.ingestTicker(snapshot);
    const slot = selectSpotTickerStoreSlot(store.getState(), 'btc-usdt');
    const event = tickerSnapshotToDomainEvent(slot?.snapshot);

    expect(slot?.snapshot?.data).toBe(ticker);
    expect(slot?.snapshot?.metadata.transport).toBe('PROVIDER_REST');
    expect(slot?.snapshot?.metadata.source).toBe('REST_SNAPSHOT');
    expect(event?.data).toBe(ticker);
    expect(event?.freshness).toBe('RECENT');
  });
});
