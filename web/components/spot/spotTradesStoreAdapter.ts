'use client';

import { useCallback, useEffect, useId, useSyncExternalStore } from 'react';
import type {
  DomainFreshness,
  DomainSource,
  DomainSnapshot,
} from './spotDomainSnapshot';
import type { SpotMarketTradeItem } from '../../lib/api/modules/spot';
import {
  spotPublicMarketStore,
  type SpotDomainSlot,
  type SpotPublicMarketStore,
  type SpotPublicMarketStoreState,
} from '../../lib/realtime/spotMarketStore';
import {
  sequenceSpotMarketDomainEvent,
  type NormalizedSpotMarketDomainEvent,
  type SpotMarketDomainEvent,
  type SpotMarketDomainSequenceState,
} from './spotMarketDomainSequencer';
import {
  getLatestSpotTradeRow,
  getSpotTradeCollectionAction,
  mergeSpotTradeIncrementalRow,
  mergeSpotTradeSnapshotRows,
  shouldApplySpotTradeAuthoritySideEffects,
  type SpotTradeCollectionAction,
  type SpotWeakDeliveryCounts,
} from './spotTradeRows';

type TradesAdapterState = {
  sequenceState: SpotMarketDomainSequenceState<SpotMarketTradeItem[]> | null;
  rows: SpotMarketTradeItem[];
  weakDeliveryCounts: SpotWeakDeliveryCounts;
  providerSymbol: string | null;
  authorityTrade: SpotMarketTradeItem | null;
};

export type SpotTradesCollectionMetadata = {
  action: SpotTradeCollectionAction;
  authorityAccepted: boolean;
  addedOccurrence: boolean;
  applyAuthoritySideEffects: boolean;
  authorityTrade: SpotMarketTradeItem | null;
};

export type SpotTradesStoreIngestOptions = {
  providerSymbol?: string | null;
  incrementalTrade?: SpotMarketTradeItem | null;
};

export type SpotTradesStoreIngestResult = SpotTradesCollectionMetadata & {
  snapshot: DomainSnapshot<SpotMarketTradeItem[]>;
};

const adapterStates = new WeakMap<SpotPublicMarketStore, Map<string, TradesAdapterState>>();
let tradesSnapshotSequence = 0;

function normalizeSymbol(value: unknown): string {
  return String(value ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function normalizeText(value: unknown): string | null {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

function normalizeSource(value: unknown): DomainSource {
  const source = String(value ?? '').trim().toUpperCase();
  if (source === 'LIVE_WS') return 'LIVE_WS';
  if (source === 'REST_SNAPSHOT' || source === 'REST') return 'REST_SNAPSHOT';
  if (source === 'DB_CACHE') return 'DB_CACHE';
  if (source === 'INTERNAL') return 'INTERNAL';
  if (source === 'LAST_GOOD') return 'LAST_GOOD';
  return 'MISSING';
}

function normalizeFreshness(value: unknown): DomainFreshness {
  const freshness = String(value ?? '').trim().toUpperCase();
  if (freshness === 'LIVE') return 'LIVE';
  if (freshness === 'RECENT' || freshness === 'CACHED') return 'RECENT';
  if (freshness === 'STALE') return 'STALE';
  if (freshness === 'LAST_GOOD' || freshness === 'LAST_VALID') return 'LAST_GOOD';
  return 'MISSING';
}

function getStoreStates(store: SpotPublicMarketStore): Map<string, TradesAdapterState> {
  const current = adapterStates.get(store);
  if (current) return current;
  const created = new Map<string, TradesAdapterState>();
  adapterStates.set(store, created);
  return created;
}

function createInitialAdapterState(): TradesAdapterState {
  return {
    sequenceState: null,
    rows: [],
    weakDeliveryCounts: {},
    providerSymbol: null,
    authorityTrade: null,
  };
}

function createTradesSnapshot(
  event: NormalizedSpotMarketDomainEvent<SpotMarketTradeItem[]>,
  rows: SpotMarketTradeItem[],
  metadata: SpotTradesCollectionMetadata,
  providerSymbol: string | null,
): DomainSnapshot<SpotMarketTradeItem[]> {
  const receivedAtMs = Number(event.receivedAtMs) || Date.now();
  const source = normalizeSource(event.source);
  const freshness = normalizeFreshness(event.freshness);
  const authorityTrade = metadata.authorityTrade;
  const lastTradeId = normalizeText(
    authorityTrade?.provider_trade_id ?? authorityTrade?.trade_id ?? authorityTrade?.id,
  );
  return {
    schema_version: 'spot-domain-snapshot/v1',
    snapshot_id: [
      'spot-trades-consumer',
      event.symbol,
      event.transport,
      event.eventTimeMs ?? receivedAtMs,
      ++tradesSnapshotSequence,
    ].join('-'),
    emitted_at_ms: receivedAtMs,
    data: rows,
    metadata: {
      domain: 'trades',
      symbol: event.symbol,
      interval: null,
      provider: event.provider === 'UNKNOWN' ? null : event.provider,
      provider_symbol: providerSymbol,
      transport: event.transport === 'rest' ? 'PROVIDER_REST' : 'PROVIDER_WS',
      cache_origin: 'NONE',
      source,
      freshness,
      fallback_reason: null,
      provider_event_time_ms: event.eventTimeMs,
      received_at_ms: receivedAtMs,
      cache_updated_at_ms: null,
      age_ms: 0,
      ttl_ms: null,
      stale: freshness === 'STALE' || freshness === 'LAST_GOOD',
      provider_generation: null,
      revision: null,
      completeness: {
        status: rows.length ? 'COMPLETE' : 'EMPTY',
        has_data: rows.length > 0,
        item_count: rows.length,
        missing_fields: [],
        details: {
          collection_action: metadata.action,
          authority_accepted: metadata.authorityAccepted,
          added_occurrence: metadata.addedOccurrence,
          apply_authority_side_effects: metadata.applyAuthoritySideEffects,
          authority_trade: metadata.authorityTrade,
          last_trade_id: lastTradeId,
        },
      },
      freshness_basis: 'RECEIVED_AT',
    },
  };
}

export function ingestSpotTradesStoreEvent(
  store: SpotPublicMarketStore,
  event: SpotMarketDomainEvent<SpotMarketTradeItem[]>,
  options: SpotTradesStoreIngestOptions = {},
): SpotTradesStoreIngestResult {
  const symbol = normalizeSymbol(event.symbol);
  const states = getStoreStates(store);
  const current = states.get(symbol) ?? createInitialAdapterState();
  const decision = sequenceSpotMarketDomainEvent(current.sequenceState, {
    ...event,
    symbol,
    domain: 'trades',
  });
  const action = getSpotTradeCollectionAction({
    accepted: decision.accepted,
    reason: decision.reason,
    currentProvider: current.sequenceState?.current?.provider,
    incomingProvider: event.provider,
  });
  const currentRows = action === 'replace' ? [] : current.rows;
  const providerSymbol = normalizeText(options.providerSymbol) ?? current.providerSymbol;
  let rows = current.rows;
  let weakDeliveryCounts = action === 'replace' ? {} : current.weakDeliveryCounts;
  let addedOccurrence = false;

  if (action !== 'ignore') {
    if (options.incrementalTrade) {
      const merged = mergeSpotTradeIncrementalRow(
        currentRows,
        options.incrementalTrade,
        weakDeliveryCounts,
        {
          symbol,
          currentProvider: current.sequenceState?.current?.provider,
          incomingProvider: event.provider,
          currentProviderSymbol: current.providerSymbol,
          incomingProviderSymbol: providerSymbol,
        },
      );
      rows = merged.rows;
      weakDeliveryCounts = merged.deliveryCounts;
      addedOccurrence = merged.addedOccurrence;
    } else {
      rows = mergeSpotTradeSnapshotRows(currentRows, event.data, {
        symbol,
        currentProvider: current.sequenceState?.current?.provider,
        incomingProvider: event.provider,
        currentProviderSymbol: current.providerSymbol,
        incomingProviderSymbol: providerSymbol,
      });
    }
  }

  const incomingAuthorityTrade = decision.accepted
    ? getLatestSpotTradeRow(event.data, {
        symbol,
        provider: event.provider,
        providerSymbol,
      })
    : null;
  const applyAuthoritySideEffects = options.incrementalTrade
    ? shouldApplySpotTradeAuthoritySideEffects({
        accepted: decision.accepted,
        addedOccurrence,
      })
    : decision.accepted;
  const authorityTrade = applyAuthoritySideEffects
    ? incomingAuthorityTrade
    : action === 'replace'
      ? null
      : current.authorityTrade;
  const collectionMetadata: SpotTradesCollectionMetadata = {
    action,
    authorityAccepted: decision.accepted,
    addedOccurrence,
    applyAuthoritySideEffects,
    authorityTrade,
  };
  const normalizedEvent = decision.state.current ?? {
    ...event,
    symbol,
    provider: normalizeText(event.provider)?.toUpperCase() ?? 'UNKNOWN',
    eventTimeMs: Number(event.eventTimeMs) || null,
    source: normalizeText(event.source)?.toUpperCase() ?? 'MISSING',
    freshness: normalizeText(event.freshness)?.toUpperCase() ?? 'MISSING',
  };
  const snapshot = createTradesSnapshot(
    { ...normalizedEvent, data: rows },
    rows,
    collectionMetadata,
    providerSymbol,
  );

  states.set(symbol, {
    sequenceState: decision.accepted ? decision.state : current.sequenceState,
    rows,
    weakDeliveryCounts,
    providerSymbol,
    authorityTrade,
  });
  store.ingestTrade(snapshot);
  return { snapshot, ...collectionMetadata };
}

export function selectSpotTradesStoreSlot(
  state: SpotPublicMarketStoreState,
  symbol: string,
): SpotDomainSlot<SpotMarketTradeItem[]> | null {
  return state.symbols[normalizeSymbol(symbol)]?.trades ?? null;
}

export function tradesSnapshotToDomainEvent(
  snapshot: DomainSnapshot<SpotMarketTradeItem[]> | null | undefined,
): NormalizedSpotMarketDomainEvent<SpotMarketTradeItem[]> | null {
  if (!snapshot) return null;
  return {
    symbol: normalizeSymbol(snapshot.metadata.symbol),
    domain: 'trades',
    provider: String(snapshot.metadata.provider || 'UNKNOWN').trim().toUpperCase(),
    eventTimeMs: snapshot.metadata.provider_event_time_ms,
    receivedAtMs: snapshot.metadata.received_at_ms ?? snapshot.emitted_at_ms,
    transport: snapshot.metadata.transport === 'PROVIDER_REST' ? 'rest' : 'ws_incremental',
    source: snapshot.metadata.source,
    freshness: snapshot.metadata.freshness,
    data: snapshot.data ?? [],
  };
}

export function getSpotTradesCollectionMetadata(
  snapshot: DomainSnapshot<SpotMarketTradeItem[]> | null | undefined,
): SpotTradesCollectionMetadata | null {
  if (!snapshot) return null;
  const details = snapshot.metadata.completeness.details;
  const action = String(details.collection_action ?? 'ignore') as SpotTradeCollectionAction;
  const authorityTrade = details.authority_trade;
  return {
    action,
    authorityAccepted: details.authority_accepted === true,
    addedOccurrence: details.added_occurrence === true,
    applyAuthoritySideEffects: details.apply_authority_side_effects === true,
    authorityTrade: authorityTrade && typeof authorityTrade === 'object' && !Array.isArray(authorityTrade)
      ? authorityTrade as SpotMarketTradeItem
      : null,
  };
}

export function useSpotTradesStoreSlot(
  symbol: string,
): SpotDomainSlot<SpotMarketTradeItem[]> | null {
  const ownerId = useId();
  const normalizedSymbol = normalizeSymbol(symbol);
  const subscribe = useCallback((onStoreChange: () => void) => (
    spotPublicMarketStore.subscribe(() => onStoreChange())
  ), []);
  const getSnapshot = useCallback(
    () => selectSpotTradesStoreSlot(spotPublicMarketStore.getState(), normalizedSymbol),
    [normalizedSymbol],
  );

  useEffect(() => {
    if (!normalizedSymbol) return undefined;
    const interest = spotPublicMarketStore.acquireInterest({
      owner: `useSpotMarket:trades:${ownerId}`,
      symbol: normalizedSymbol,
      domains: ['trades'],
    });
    return () => {
      interest.release();
    };
  }, [normalizedSymbol, ownerId]);

  return useSyncExternalStore(subscribe, getSnapshot, () => null);
}

/** @internal Test isolation only. */
export function resetSpotTradesStoreAdapterForTests(store: SpotPublicMarketStore): void {
  adapterStates.delete(store);
}
