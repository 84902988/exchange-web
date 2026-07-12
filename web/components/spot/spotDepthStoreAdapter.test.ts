import { describe, expect, it } from '@jest/globals';
import type { SpotDepthResponse } from '../../lib/api/modules/spot';
import { createSpotPublicMarketStore } from '../../lib/realtime/spotMarketStore';
import {
  createSpotDepthStoreSnapshot,
  depthSnapshotToDomainEvent,
  selectSpotDepthStoreSlot,
} from './spotDepthStoreAdapter';

describe('spot depth store adapter', () => {
  it('maps REST depth metadata without changing bids, asks, or authority fields', () => {
    const store = createSpotPublicMarketStore();
    const depth = {
      symbol: 'BTCUSDT',
      provider: 'BINANCE',
      provider_symbol: 'BTCUSDT',
      source: 'REST_SNAPSHOT',
      freshness: 'RECENT',
      bids: [{ price: '63999', amount: '1' }],
      asks: [{ price: '64001', amount: '2' }],
      generation: 4,
      sequence: 81,
      checksum: 'depth-checksum',
    } as SpotDepthResponse & {
      provider_symbol: string;
      generation: number;
      sequence: number;
      checksum: string;
    };
    const snapshot = createSpotDepthStoreSnapshot({
      symbol: 'BTCUSDT',
      domain: 'depth',
      provider: 'BINANCE',
      eventTimeMs: 1_720_000_000_000,
      receivedAtMs: 1_720_000_000_100,
      transport: 'rest',
      source: 'REST_SNAPSHOT',
      freshness: 'RECENT',
      data: depth,
    });

    store.ingestDepth(snapshot);
    const slot = selectSpotDepthStoreSlot(store.getState(), 'btc-usdt');
    const event = depthSnapshotToDomainEvent(slot?.snapshot);

    expect(slot?.snapshot?.data).toBe(depth);
    expect(slot?.snapshot?.metadata.transport).toBe('PROVIDER_REST');
    expect(slot?.snapshot?.metadata.source).toBe('REST_SNAPSHOT');
    expect(slot?.snapshot?.metadata.freshness).toBe('RECENT');
    expect(slot?.snapshot?.metadata.provider_generation).toBe(4);
    expect(slot?.snapshot?.metadata.revision?.sequence).toBe(81);
    expect(slot?.snapshot?.metadata.completeness.details.checksum).toBe('depth-checksum');
    expect(event?.data).toBe(depth);
    expect(event?.data?.bids).toBe(depth.bids);
    expect(event?.data?.asks).toBe(depth.asks);
  });

  it('preserves stale depth semantics for the consumer', () => {
    const depth: SpotDepthResponse = {
      symbol: 'BTCUSDT',
      source: 'LAST_GOOD',
      freshness: 'STALE',
      stale: true,
      bids: [{ price: '63999', amount: '1' }],
      asks: [{ price: '64001', amount: '2' }],
    };
    const snapshot = createSpotDepthStoreSnapshot({
      symbol: 'BTCUSDT',
      domain: 'depth',
      provider: 'BINANCE',
      eventTimeMs: 1_720_000_000_000,
      receivedAtMs: 1_720_000_000_100,
      transport: 'rest',
      source: 'LAST_GOOD',
      freshness: 'STALE',
      data: depth,
    });

    expect(snapshot.metadata.stale).toBe(true);
    expect(snapshot.metadata.source).toBe('LAST_GOOD');
    expect(snapshot.metadata.freshness).toBe('STALE');
    expect(snapshot.data?.stale).toBe(true);
  });
});
