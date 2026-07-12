import type { DomainRevision, DomainSnapshot } from '../spotDomainSnapshot';
import type { SpotMarketKlineItem } from '../../../lib/api/modules/spot';
import {
  spotPublicMarketStore,
  type SpotPublicMarketStore,
  type SpotPublicMarketStoreState,
} from '../../../lib/realtime/spotMarketStore';
import type { SpotKlineCurrentSlot } from '../../../lib/realtime/spotMarketStore.types';

export type SpotKlineStoreRealtimeEvent = {
  snapshotId: string;
  symbol: string;
  interval: string;
  kline: SpotMarketKlineItem;
  provider: string | null;
  source: string;
  freshness: string;
  receivedAtMs: number;
  revision: DomainRevision | null;
  sequence: number | null;
  closed: boolean | null;
};

export type SubscribeSpotKlineCurrentOptions = {
  symbol: string;
  interval: string;
  owner: string;
  onSnapshot: (event: SpotKlineStoreRealtimeEvent) => void;
  store?: SpotPublicMarketStore;
  emitCurrent?: boolean;
};

function normalizeSymbol(value: unknown): string {
  return String(value ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function normalizeInterval(value: unknown): string {
  return String(value ?? '').trim();
}

export function selectSpotKlineCurrentSlot(
  state: SpotPublicMarketStoreState,
  symbol: string,
  interval: string,
): SpotKlineCurrentSlot | null {
  return state.symbols[normalizeSymbol(symbol)]
    ?.klineByInterval[normalizeInterval(interval)]
    ?? null;
}

export function klineSnapshotToRealtimeEvent(
  snapshot: DomainSnapshot<SpotMarketKlineItem> | null | undefined,
  slot?: SpotKlineCurrentSlot | null,
): SpotKlineStoreRealtimeEvent | null {
  if (!snapshot?.data) return null;
  const interval = normalizeInterval(snapshot.metadata.interval ?? slot?.interval);
  const symbol = normalizeSymbol(snapshot.metadata.symbol);
  if (!symbol || !interval) return null;
  return {
    snapshotId: snapshot.snapshot_id,
    symbol,
    interval,
    kline: snapshot.data,
    provider: snapshot.metadata.provider,
    source: snapshot.metadata.source,
    freshness: snapshot.metadata.freshness,
    receivedAtMs: snapshot.metadata.received_at_ms ?? snapshot.emitted_at_ms,
    revision: snapshot.metadata.revision,
    sequence: slot?.sequence ?? snapshot.metadata.revision?.sequence ?? null,
    closed: slot?.isClosed ?? snapshot.metadata.revision?.is_closed ?? null,
  };
}

export function subscribeSpotKlineCurrent({
  symbol,
  interval,
  owner,
  onSnapshot,
  store = spotPublicMarketStore,
  emitCurrent = true,
}: SubscribeSpotKlineCurrentOptions): () => void {
  const normalizedSymbol = normalizeSymbol(symbol);
  const normalizedInterval = normalizeInterval(interval);
  if (!normalizedSymbol || !normalizedInterval) return () => undefined;

  const interest = store.acquireInterest({
    owner,
    symbol: normalizedSymbol,
    interval: normalizedInterval,
    domains: ['kline'],
  });
  const selector = (state: SpotPublicMarketStoreState) => (
    selectSpotKlineCurrentSlot(state, normalizedSymbol, normalizedInterval)
  );
  const emitSlot = (slot: SpotKlineCurrentSlot | null) => {
    const event = klineSnapshotToRealtimeEvent(slot?.snapshot, slot);
    if (event) onSnapshot(event);
  };
  const unsubscribe = store.subscribeSelector(selector, (slot) => emitSlot(slot));

  if (emitCurrent) emitSlot(selector(store.getState()));

  let released = false;
  return () => {
    if (released) return;
    released = true;
    unsubscribe();
    interest.release();
  };
}
