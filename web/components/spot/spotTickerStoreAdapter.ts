'use client';

import { useCallback, useEffect, useId, useSyncExternalStore } from 'react';
import type {
  DomainFreshness,
  DomainSource,
  DomainSnapshot,
} from './spotDomainSnapshot';
import type { SpotMarketTickerItem } from '../../lib/api/modules/spot';
import {
  spotPublicMarketStore,
  type SpotDomainSlot,
  type SpotPublicMarketStoreState,
} from '../../lib/realtime/spotMarketStore';
import type {
  NormalizedSpotMarketDomainEvent,
  SpotMarketDomainEvent,
  SpotMarketDomainTransport,
} from './spotMarketDomainSequencer';

let tickerSnapshotSequence = 0;

function normalizeSymbol(value: unknown): string {
  return String(value ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function normalizeSource(
  value: unknown,
  transport: SpotMarketDomainTransport,
): DomainSource {
  const source = String(value ?? '').trim().toUpperCase();
  if (source === 'LIVE_WS') return 'LIVE_WS';
  if (source === 'REST_SNAPSHOT' || source === 'REST') return 'REST_SNAPSHOT';
  if (source === 'DB_CACHE') return 'DB_CACHE';
  if (source === 'INTERNAL') return 'INTERNAL';
  if (source === 'LAST_GOOD') return 'LAST_GOOD';
  if (source === 'MISSING') return 'MISSING';
  return transport === 'rest' ? 'REST_SNAPSHOT' : 'MISSING';
}

function normalizeFreshness(value: unknown): DomainFreshness {
  const freshness = String(value ?? '').trim().toUpperCase();
  if (freshness === 'LIVE') return 'LIVE';
  if (freshness === 'RECENT' || freshness === 'CACHED') return 'RECENT';
  if (freshness === 'STALE') return 'STALE';
  if (freshness === 'LAST_GOOD' || freshness === 'LAST_VALID') return 'LAST_GOOD';
  return 'MISSING';
}

function getTickerProviderSymbol(ticker: SpotMarketTickerItem | null): string | null {
  if (!ticker || typeof ticker !== 'object') return null;
  const value = String((ticker as Record<string, unknown>).provider_symbol ?? '').trim();
  return value || null;
}

export function createSpotTickerStoreSnapshot(
  event: SpotMarketDomainEvent<SpotMarketTickerItem | null>,
): DomainSnapshot<SpotMarketTickerItem> {
  const symbol = normalizeSymbol(event.symbol);
  const receivedAtMs = Number(event.receivedAtMs) || Date.now();
  const providerEventTimeMs = Number(event.eventTimeMs);
  const source = normalizeSource(event.source, event.transport);
  const freshness = normalizeFreshness(event.freshness);
  const hasData = Boolean(event.data);
  const snapshotId = [
    'spot-ticker-adapter',
    symbol,
    event.transport,
    Number.isFinite(providerEventTimeMs) && providerEventTimeMs > 0
      ? providerEventTimeMs
      : receivedAtMs,
    ++tickerSnapshotSequence,
  ].join('-');

  return {
    schema_version: 'spot-domain-snapshot/v1',
    snapshot_id: snapshotId,
    emitted_at_ms: receivedAtMs,
    data: event.data,
    metadata: {
      domain: 'ticker',
      symbol,
      interval: null,
      provider: String(event.provider ?? '').trim() || null,
      provider_symbol: getTickerProviderSymbol(event.data),
      transport: event.transport === 'rest' ? 'PROVIDER_REST' : 'PROVIDER_WS',
      cache_origin: 'NONE',
      source,
      freshness,
      fallback_reason: null,
      provider_event_time_ms: Number.isFinite(providerEventTimeMs) && providerEventTimeMs > 0
        ? providerEventTimeMs
        : null,
      received_at_ms: receivedAtMs,
      cache_updated_at_ms: null,
      age_ms: 0,
      ttl_ms: null,
      stale: freshness === 'STALE' || freshness === 'LAST_GOOD',
      provider_generation: null,
      revision: null,
      completeness: {
        status: hasData ? 'COMPLETE' : 'EMPTY',
        has_data: hasData,
        item_count: hasData ? 1 : 0,
        missing_fields: [],
        details: {},
      },
      freshness_basis: 'RECEIVED_AT',
    },
  };
}

export function selectSpotTickerStoreSlot(
  state: SpotPublicMarketStoreState,
  symbol: string,
): SpotDomainSlot<SpotMarketTickerItem> | null {
  return state.symbols[normalizeSymbol(symbol)]?.ticker ?? null;
}

export function tickerSnapshotToDomainEvent(
  snapshot: DomainSnapshot<SpotMarketTickerItem> | null | undefined,
): NormalizedSpotMarketDomainEvent<SpotMarketTickerItem | null> | null {
  if (!snapshot) return null;
  return {
    symbol: normalizeSymbol(snapshot.metadata.symbol),
    domain: 'ticker',
    provider: String(snapshot.metadata.provider || 'UNKNOWN').trim().toUpperCase(),
    eventTimeMs: snapshot.metadata.provider_event_time_ms,
    receivedAtMs: snapshot.metadata.received_at_ms ?? snapshot.emitted_at_ms,
    transport: snapshot.metadata.transport === 'PROVIDER_REST' ? 'rest' : 'ws_incremental',
    source: snapshot.metadata.source,
    freshness: snapshot.metadata.freshness,
    data: snapshot.data,
  };
}

export function useSpotTickerStoreSlot(
  symbol: string,
): SpotDomainSlot<SpotMarketTickerItem> | null {
  const ownerId = useId();
  const normalizedSymbol = normalizeSymbol(symbol);
  const subscribe = useCallback((onStoreChange: () => void) => (
    spotPublicMarketStore.subscribe(() => onStoreChange())
  ), []);
  const getSnapshot = useCallback(
    () => selectSpotTickerStoreSlot(spotPublicMarketStore.getState(), normalizedSymbol),
    [normalizedSymbol],
  );

  useEffect(() => {
    if (!normalizedSymbol) return undefined;
    const interest = spotPublicMarketStore.acquireInterest({
      owner: `useSpotMarket:ticker:${ownerId}`,
      symbol: normalizedSymbol,
      domains: ['ticker'],
    });
    return () => {
      interest.release();
    };
  }, [normalizedSymbol, ownerId]);

  return useSyncExternalStore(subscribe, getSnapshot, () => null);
}
