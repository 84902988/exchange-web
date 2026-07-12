'use client';

import { useCallback, useEffect, useId, useSyncExternalStore } from 'react';
import type {
  DomainFreshness,
  DomainSource,
  DomainSnapshot,
} from './spotDomainSnapshot';
import type { SpotDepthResponse } from '../../lib/api/modules/spot';
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

let depthSnapshotSequence = 0;

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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readText(record: Record<string, unknown> | null, key: string): string | null {
  const value = String(record?.[key] ?? '').trim();
  return value || null;
}

function readNumber(record: Record<string, unknown> | null, key: string): number | null {
  const rawValue = record?.[key];
  if (rawValue === null || rawValue === undefined || rawValue === '') return null;
  const value = Number(rawValue);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export function createSpotDepthStoreSnapshot(
  event: SpotMarketDomainEvent<SpotDepthResponse | null>,
): DomainSnapshot<SpotDepthResponse> {
  const symbol = normalizeSymbol(event.symbol);
  const receivedAtMs = Number(event.receivedAtMs) || Date.now();
  const providerEventTimeMs = Number(event.eventTimeMs);
  const source = normalizeSource(event.source, event.transport);
  const freshness = normalizeFreshness(event.freshness);
  const depth = event.data;
  const depthRecord = asRecord(depth);
  const bidCount = Array.isArray(depth?.bids) ? depth.bids.length : 0;
  const askCount = Array.isArray(depth?.asks) ? depth.asks.length : 0;
  const itemCount = bidCount + askCount;
  const providerGeneration = readNumber(depthRecord, 'provider_generation')
    ?? readNumber(depthRecord, 'generation');
  const sequence = readNumber(depthRecord, 'sequence');
  const stale = Boolean(depth?.stale) || freshness === 'STALE' || freshness === 'LAST_GOOD';
  const snapshotId = [
    'spot-depth-adapter',
    symbol,
    event.transport,
    Number.isFinite(providerEventTimeMs) && providerEventTimeMs > 0
      ? providerEventTimeMs
      : receivedAtMs,
    ++depthSnapshotSequence,
  ].join('-');

  return {
    schema_version: 'spot-domain-snapshot/v1',
    snapshot_id: snapshotId,
    emitted_at_ms: receivedAtMs,
    data: depth,
    metadata: {
      domain: 'depth',
      symbol,
      interval: null,
      provider: String(event.provider ?? '').trim() || null,
      provider_symbol: readText(depthRecord, 'provider_symbol'),
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
      stale,
      provider_generation: providerGeneration,
      revision: sequence === null
        ? null
        : {
            epoch: providerGeneration,
            sequence,
            is_closed: null,
            close_state_source: null,
          },
      completeness: {
        status: bidCount && askCount ? 'COMPLETE' : itemCount ? 'PARTIAL' : 'EMPTY',
        has_data: itemCount > 0,
        item_count: itemCount,
        missing_fields: [],
        details: {
          bid_count: bidCount,
          ask_count: askCount,
          ...(readText(depthRecord, 'checksum')
            ? { checksum: readText(depthRecord, 'checksum') }
            : {}),
        },
      },
      freshness_basis: 'RECEIVED_AT',
    },
  };
}

export function selectSpotDepthStoreSlot(
  state: SpotPublicMarketStoreState,
  symbol: string,
): SpotDomainSlot<SpotDepthResponse> | null {
  return state.symbols[normalizeSymbol(symbol)]?.depth ?? null;
}

export function depthSnapshotToDomainEvent(
  snapshot: DomainSnapshot<SpotDepthResponse> | null | undefined,
): NormalizedSpotMarketDomainEvent<SpotDepthResponse | null> | null {
  if (!snapshot) return null;
  return {
    symbol: normalizeSymbol(snapshot.metadata.symbol),
    domain: 'depth',
    provider: String(snapshot.metadata.provider || 'UNKNOWN').trim().toUpperCase(),
    eventTimeMs: snapshot.metadata.provider_event_time_ms,
    receivedAtMs: snapshot.metadata.received_at_ms ?? snapshot.emitted_at_ms,
    transport: snapshot.metadata.transport === 'PROVIDER_REST' ? 'rest' : 'ws_incremental',
    source: snapshot.metadata.source,
    freshness: snapshot.metadata.freshness,
    data: snapshot.data,
  };
}

export function useSpotDepthStoreSlot(
  symbol: string,
): SpotDomainSlot<SpotDepthResponse> | null {
  const ownerId = useId();
  const normalizedSymbol = normalizeSymbol(symbol);
  const subscribe = useCallback((onStoreChange: () => void) => (
    spotPublicMarketStore.subscribe(() => onStoreChange())
  ), []);
  const getSnapshot = useCallback(
    () => selectSpotDepthStoreSlot(spotPublicMarketStore.getState(), normalizedSymbol),
    [normalizedSymbol],
  );

  useEffect(() => {
    if (!normalizedSymbol) return undefined;
    const interest = spotPublicMarketStore.acquireInterest({
      owner: `useSpotMarket:depth:${ownerId}`,
      symbol: normalizedSymbol,
      domains: ['depth'],
    });
    return () => {
      interest.release();
    };
  }, [normalizedSymbol, ownerId]);

  return useSyncExternalStore(subscribe, getSnapshot, () => null);
}
