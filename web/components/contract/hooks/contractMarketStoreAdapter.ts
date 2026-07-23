'use client';

import { useCallback, useSyncExternalStore } from 'react';
import {
  buildContractMarketStoreKey,
  contractMarketStore,
  type ContractMarketStoreDomain,
  type ContractMarketStoreEntry,
  type ContractMarketStoreIngestResult,
  type ContractMarketStoreRevision,
  type ContractMarketStoreState,
  type ContractMarketStoreTransport,
} from '../../../lib/realtime/contractMarketStore';
import type { ContractMarketRealtimeMessage } from '../../../lib/realtime/contractMarketRealtime';
import { normalizeContractTimestampMs } from '../../../lib/contractTimestamp';
import type { ContractMarketViewDetail } from '../../../lib/api/modules/contract';
import { orderContractTradesNewestFirst } from '../contractTradeOrdering';

type UnknownRecord = Record<string, unknown>;

type ContractMarketShadowDomainInput = {
  symbol: string;
  domain: ContractMarketStoreDomain;
  interval?: string | null;
  data: unknown;
  transport: ContractMarketStoreTransport;
  metadata?: unknown;
  envelope?: unknown;
};

type ContractMarketViewShadowPayload = UnknownRecord & {
  symbol?: unknown;
  snapshot_metadata?: unknown;
  ticker?: unknown;
  depth?: unknown;
  trades?: unknown;
  kline?: unknown;
  kline_current_candle?: unknown;
};

export type ContractHeaderStoreSnapshot = {
  symbol: string;
  displayPrice: string | null;
  displayPriceSource: 'KLINE_CLOSE' | 'LIVE_MID' | 'TRADE_TICK' | null;
  markPrice: string | null;
  indexPrice: string | null;
  fundingRate: string | null;
  bestBid: string | null;
  bestAsk: string | null;
  spread: string | null;
  priceChange24h: string | null;
  priceChangePercent24h: string | null;
  high24h: string | null;
  low24h: string | null;
  baseVolume24h: string | null;
  quoteVolume24h: string | null;
  displayState: string | null;
  marketStatus: string | null;
  marketSessionType: string | null;
  executable: boolean | null;
  source: string | null;
  freshness: string | null;
  provider: string | null;
  providerGeneration: number | null;
  revision: ContractMarketStoreRevision | null;
  stale: boolean;
  observedAtMs: number;
};

export type ContractMarketViewStoreAuthoritySnapshot = {
  symbol: string;
  displayPrice: string | null;
  displayPriceSource: 'KLINE_CLOSE' | 'LIVE_MID' | 'TRADE_TICK' | null;
  displayState: string | null;
  marketStatus: string | null;
  marketSessionType?: string | null;
  bestBid: string | null;
  bestAsk: string | null;
  spread: string | null;
  executionBid: string | null;
  executionAsk: string | null;
  executionMode: string | null;
  executable: boolean | null;
  reasonCode: string | null;
  tickerSource: string | null;
  tickerFreshness: string | null;
  depthSource: string | null;
  depthFreshness: string | null;
  hasRealtimeAuthority: boolean;
  hasRealtimeBboAuthority: boolean;
  stale: boolean;
  tickerObservedAtMs: number;
  bboObservedAtMs: number;
  observedAtMs: number;
};

export const CONTRACT_MARKET_STORE_RECOVERY_MAX_AGE_MS = 5_000;

export type ContractTradingFormStoreSnapshot = {
  symbol: string;
  displayPrice: string | null;
  displayPriceSource: string | null;
  markPrice: string | null;
  indexPrice: string | null;
  marketStatus: string | null;
  displayState: string | null;
  executable: boolean | null;
  reasonCode: string | null;
  source: string | null;
  freshness: string | null;
  provider: string | null;
  providerGeneration: number | null;
  revision: ContractMarketStoreRevision | null;
  stale: boolean;
  observedAtMs: number;
};

export type ContractOrderBookStoreLevel = {
  price: string;
  amount: string;
};

export type ContractOrderBookStoreSnapshot = {
  symbol: string;
  bids: ContractOrderBookStoreLevel[];
  asks: ContractOrderBookStoreLevel[];
  bestBid: string | null;
  bestAsk: string | null;
  spread: string | null;
  midpoint: string | null;
  depthMode: string | null;
  marketStatus: string | null;
  executable: boolean | null;
  source: string | null;
  freshness: string | null;
  provider: string | null;
  providerGeneration: number | null;
  revision: ContractMarketStoreRevision | null;
  stale: boolean;
  observedAtMs: number;
};

export type ContractTradesStoreTrade = {
  id: string;
  price: string;
  qty: string;
  time: number;
  last_price?: string;
  amount?: string;
  volume?: string;
  quoteQty?: string;
  side?: string | null;
  source?: string | null;
  quote_source?: string | null;
  quote_freshness?: string | null;
  price_source?: string | null;
  synthetic?: false;
  isBuyerMaker?: boolean;
};

export type ContractTradesStoreSnapshot = {
  symbol: string;
  trades: ContractTradesStoreTrade[];
  source: string | null;
  freshness: string | null;
  provider: string | null;
  providerGeneration: number | null;
  revision: ContractMarketStoreRevision | null;
  stale: boolean;
  observedAtMs: number;
};

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function firstRecord(value: unknown): UnknownRecord | null {
  if (Array.isArray(value)) return asRecord(value[0]);
  return asRecord(value);
}

function readFirst(candidates: readonly (UnknownRecord | null)[], ...keys: string[]): unknown {
  for (const candidate of candidates) {
    if (!candidate) continue;
    for (const key of keys) {
      const value = candidate[key];
      if (value !== undefined && value !== null && value !== '') return value;
    }
  }
  return null;
}

function readText(candidates: readonly (UnknownRecord | null)[], ...keys: string[]): string | null {
  const value = readFirst(candidates, ...keys);
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

function readNumber(candidates: readonly (UnknownRecord | null)[], ...keys: string[]): number | null {
  const value = readFirst(candidates, ...keys);
  if (value === null || value === undefined || value === '') return null;
  const normalized = Number(value);
  return Number.isFinite(normalized) && normalized >= 0 ? normalized : null;
}

function readBoolean(candidates: readonly (UnknownRecord | null)[], ...keys: string[]): boolean | null {
  const value = readFirst(candidates, ...keys);
  return typeof value === 'boolean' ? value : null;
}

function readTimestamp(candidates: readonly (UnknownRecord | null)[], ...keys: string[]): number | null {
  return normalizeContractTimestampMs(readFirst(candidates, ...keys));
}

function readRevision(candidates: readonly (UnknownRecord | null)[]): ContractMarketStoreRevision | null {
  const revisionRecord = asRecord(readFirst(candidates, 'revision'));
  const revisionCandidates = [revisionRecord, ...candidates];
  const revision: ContractMarketStoreRevision = {
    epoch: readNumber(revisionCandidates, 'epoch', 'revision_epoch'),
    sequence: readNumber(
      revisionCandidates,
      'sequence',
      'revision_sequence',
      'revision_seq',
    ),
    isClosed: readBoolean(revisionCandidates, 'is_closed', 'isClosed'),
    checksum: readText(revisionCandidates, 'checksum'),
  };
  return Object.values(revision).some((value) => value !== null) ? revision : null;
}

function mergeRealtimeTrades(symbol: string, incoming: unknown): unknown {
  if (!Array.isArray(incoming)) return incoming;
  const state = contractMarketStore.getState();
  const entry = contractMarketStore.getEntry<unknown[]>(symbol, 'trades');
  const current = entry?.sessionGeneration === state.sessionGeneration
    ? entry.data
    : null;
  return orderContractTradesNewestFirst(
    Array.isArray(current) ? [...incoming, ...current] : incoming,
    100,
  );
}

const CONTRACT_TICKER_STRUCTURAL_AUTHORITY_FIELDS = [
  'display_price',
  'display_price_source',
  'current_price_source',
  'display_state',
  'executable',
  'reason_code',
  'execution_mode',
  'last_good_bbo_valid',
  'market_type',
  'category',
  'raw_source_summary',
  'warnings',
] as const;

const CONTRACT_TICKER_SNAPSHOT_EVIDENCE_FIELDS = [
  'open_24h',
  'price_change_24h',
  'price_change_percent_24h',
  'high_24h',
  'low_24h',
  'base_volume_24h',
  'quote_volume_24h',
] as const;

function isMissingTickerSnapshotValue(value: unknown) {
  return value === undefined || value === null || value === '';
}

function mergeTickerStructuralAuthority(
  symbol: string,
  incoming: unknown,
  transport: ContractMarketStoreTransport,
): unknown {
  const incomingRecord = asRecord(incoming);
  if (!incomingRecord || transport !== 'WS') return incoming;
  const state = contractMarketStore.getState();
  const entry = contractMarketStore.getEntry<unknown>(symbol, 'ticker');
  const currentSnapshot = entry?.sessionGeneration === state.sessionGeneration
    && !entry.stale
    ? asRecord(entry.data)
    : null;
  const currentStructuralAuthority = entry?.sessionGeneration === state.sessionGeneration
    && entry.transport === 'WS'
    && !entry.stale
    ? asRecord(entry.data)
    : null;
  if (!currentSnapshot) return incoming;

  const merged = { ...incomingRecord };
  for (const field of CONTRACT_TICKER_SNAPSHOT_EVIDENCE_FIELDS) {
    if (
      isMissingTickerSnapshotValue(merged[field])
      && !isMissingTickerSnapshotValue(currentSnapshot[field])
    ) {
      merged[field] = currentSnapshot[field];
    }
  }
  if (!currentStructuralAuthority) return merged;
  const incomingSource = String(
    incomingRecord.source ?? incomingRecord.quote_source ?? '',
  ).trim().toUpperCase();
  const incomingFreshness = String(
    incomingRecord.freshness ?? incomingRecord.quote_freshness ?? '',
  ).trim().toUpperCase();
  const incomingPriceSource = String(
    incomingRecord.price_source ?? '',
  ).trim().toUpperCase();
  const incomingLastPrice = readPrice(
    incomingRecord,
    'last_price',
    'price',
    'last',
  );
  const isTrustedLivePrice = incomingFreshness === 'LIVE'
    && Boolean(incomingLastPrice)
    && (
      incomingPriceSource === 'TRADE_TICK'
      || incomingSource === 'LIVE_WS'
      || incomingSource === 'PROVIDER_WS'
      || incomingSource === 'ITICK_LIVE_WS_DERIVED_BBO'
    );
  if (isTrustedLivePrice) {
    merged.display_price = incomingLastPrice;
    merged.display_price_source = incomingPriceSource === 'KLINE_CLOSE'
      ? 'KLINE_CLOSE'
      : 'TRADE_TICK';
    merged.current_price_source = merged.display_price_source;
  }
  for (const field of CONTRACT_TICKER_STRUCTURAL_AUTHORITY_FIELDS) {
    if (merged[field] === undefined && currentStructuralAuthority[field] !== undefined) {
      merged[field] = currentStructuralAuthority[field];
    }
  }
  return merged;
}

function normalizeSymbol(value: unknown): string {
  return String(value ?? '').trim().toUpperCase();
}

function readPrice(record: UnknownRecord | null, ...keys: string[]): string | null {
  if (!record) return null;
  for (const key of keys) {
    const value = record[key];
    if (value === null || value === undefined || value === '') continue;
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return String(value);
  }
  return null;
}

function readValue(record: UnknownRecord | null, ...keys: string[]): string | null {
  if (!record) return null;
  for (const key of keys) {
    const value = record[key];
    if (value !== null && value !== undefined && value !== '') return String(value);
  }
  return null;
}

function readLevelPrice(value: unknown): number | null {
  if (Array.isArray(value)) {
    const price = Number(value[0]);
    return Number.isFinite(price) && price > 0 ? price : null;
  }
  const level = asRecord(value);
  const price = Number(level?.price);
  return Number.isFinite(price) && price > 0 ? price : null;
}

function readBookBest(record: UnknownRecord | null, side: 'bid' | 'ask'): string | null {
  const direct = side === 'bid'
    ? readPrice(record, 'best_bid', 'bid', 'bid_price')
    : readPrice(record, 'best_ask', 'ask', 'ask_price');
  if (direct) return direct;
  const levels = record?.[side === 'bid' ? 'bids' : 'asks'];
  if (!Array.isArray(levels)) return null;
  const prices = levels
    .map(readLevelPrice)
    .filter((price): price is number => price !== null);
  if (!prices.length) return null;
  return String(side === 'bid' ? Math.max(...prices) : Math.min(...prices));
}

function normalizeDisplayPriceSource(
  value: unknown,
): ContractHeaderStoreSnapshot['displayPriceSource'] {
  const source = String(value ?? '').trim().toUpperCase();
  if (source === 'KLINE_CLOSE' || source === 'LIVE_MID' || source === 'TRADE_TICK') {
    return source;
  }
  return null;
}

function resolveDisplayPrice(
  ticker: UnknownRecord | null,
  bestBid: string | null,
  bestAsk: string | null,
): Pick<ContractHeaderStoreSnapshot, 'displayPrice' | 'displayPriceSource'> {
  const explicitPrice = readPrice(ticker, 'display_price');
  const explicitSource = normalizeDisplayPriceSource(
    ticker?.display_price_source ?? ticker?.current_price_source ?? ticker?.price_source,
  );
  const hasExplicitDisplayAuthority = Boolean(ticker) && (
    Object.prototype.hasOwnProperty.call(ticker, 'display_price')
    || Object.prototype.hasOwnProperty.call(ticker, 'display_price_source')
    || Object.prototype.hasOwnProperty.call(ticker, 'current_price_source')
  );
  if (hasExplicitDisplayAuthority) {
    return { displayPrice: explicitPrice, displayPriceSource: explicitSource };
  }

  const lastPrice = readPrice(ticker, 'last_price', 'price', 'last');
  if (explicitSource === 'TRADE_TICK' && lastPrice) {
    return { displayPrice: lastPrice, displayPriceSource: explicitSource };
  }

  const bid = Number(bestBid);
  const ask = Number(bestAsk);
  if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0 && ask >= bid) {
    return {
      displayPrice: String((bid + ask) / 2),
      displayPriceSource: 'LIVE_MID',
    };
  }
  return {
    displayPrice: lastPrice,
    displayPriceSource: explicitSource,
  };
}

function projectMarketViewTicker(
  view: ContractMarketViewShadowPayload,
  value: unknown,
): UnknownRecord {
  const projected = { ...(asRecord(value) || {}) };
  const fields = [
    'display_price',
    'display_price_source',
    'current_price_source',
    'mark_price',
    'mark_price_source',
    'index_price',
    'index_price_source',
    'ticker_source',
    'ticker_freshness',
    'display_state',
    'market_status',
    'market_session_type',
    'executable',
    'reason_code',
    'execution_mode',
    'last_good_bbo_valid',
    'market_type',
    'category',
    'raw_source_summary',
    'warnings',
  ];
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(view, field)) continue;
    projected[field] = view[field];
  }
  return projected;
}

type HeaderSnapshotCacheEntry = {
  tickerEntry: ContractMarketStoreEntry | undefined;
  depthEntry: ContractMarketStoreEntry | undefined;
  snapshot: ContractHeaderStoreSnapshot | null;
};

const headerSnapshotCache = new Map<string, HeaderSnapshotCacheEntry>();

function createSafeEmptyHeaderSnapshot(symbol: string): ContractHeaderStoreSnapshot {
  return {
    symbol,
    displayPrice: null,
    displayPriceSource: null,
    markPrice: null,
    indexPrice: null,
    fundingRate: null,
    bestBid: null,
    bestAsk: null,
    spread: null,
    priceChange24h: null,
    priceChangePercent24h: null,
    high24h: null,
    low24h: null,
    baseVolume24h: null,
    quoteVolume24h: null,
    displayState: null,
    marketStatus: null,
    marketSessionType: null,
    executable: null,
    source: null,
    freshness: null,
    provider: null,
    providerGeneration: null,
    revision: null,
    stale: false,
    observedAtMs: 0,
  };
}

export function selectContractHeaderStoreSnapshot(
  state: ContractMarketStoreState,
  symbolValue: string,
): ContractHeaderStoreSnapshot | null {
  const symbol = normalizeSymbol(symbolValue);
  if (!symbol) return null;
  const activeSymbol = normalizeSymbol(state.activeSymbol);
  const tickerCandidate = activeSymbol === symbol
    ? state.entries[buildContractMarketStoreKey(symbol, 'ticker')]
    : undefined;
  const depthCandidate = activeSymbol === symbol
    ? state.entries[buildContractMarketStoreKey(symbol, 'depth')]
    : undefined;
  const tickerEntry = tickerCandidate?.sessionGeneration === state.sessionGeneration
    ? tickerCandidate
    : undefined;
  const depthEntry = depthCandidate?.sessionGeneration === state.sessionGeneration
    ? depthCandidate
    : undefined;
  const cached = headerSnapshotCache.get(symbol);
  if (
    cached
    && cached.tickerEntry === tickerEntry
    && cached.depthEntry === depthEntry
  ) {
    return cached.snapshot;
  }
  if (!tickerEntry && !depthEntry) {
    const snapshot = createSafeEmptyHeaderSnapshot(symbol);
    headerSnapshotCache.set(symbol, { tickerEntry, depthEntry, snapshot });
    return snapshot;
  }

  const ticker = asRecord(tickerEntry?.data);
  const depth = asRecord(depthEntry?.data);
  const depthBid = readBookBest(depth, 'bid');
  const depthAsk = readBookBest(depth, 'ask');
  const explicitDepthExecutionBid = readPrice(depth, 'execution_bid');
  const explicitDepthExecutionAsk = readPrice(depth, 'execution_ask');
  const explicitTickerExecutionBid = readPrice(ticker, 'execution_bid');
  const explicitTickerExecutionAsk = readPrice(ticker, 'execution_ask');
  const tickerProvider = String(tickerEntry?.provider || readValue(ticker, 'provider') || '')
    .trim()
    .toUpperCase();
  const allowGenericTickerBbo = tickerProvider !== 'ITICK';
  const tickerBid = explicitTickerExecutionBid
    ?? (allowGenericTickerBbo ? readBookBest(ticker, 'bid') : null);
  const tickerAsk = explicitTickerExecutionAsk
    ?? (allowGenericTickerBbo ? readBookBest(ticker, 'ask') : null);
  const hasDepthBbo = depthBid !== null && depthAsk !== null;
  const hasDepthExecutionBbo = explicitDepthExecutionBid !== null
    && explicitDepthExecutionAsk !== null;
  const bestBid = hasDepthBbo
    ? depthBid
    : hasDepthExecutionBbo
      ? explicitDepthExecutionBid
      : tickerBid;
  const bestAsk = hasDepthBbo
    ? depthAsk
    : hasDepthExecutionBbo
      ? explicitDepthExecutionAsk
      : tickerAsk;
  const tickerExecutable = typeof ticker?.executable === 'boolean'
    ? ticker.executable
    : null;
  const depthExecutable = typeof depth?.executable === 'boolean'
    ? depth.executable
    : null;
  const bboAuthorityEntry = hasDepthBbo || hasDepthExecutionBbo
    ? depthEntry
    : tickerEntry ?? depthEntry;
  const executable = bboAuthorityEntry === depthEntry
    ? depthExecutable ?? tickerExecutable
    : tickerExecutable ?? depthExecutable;
  const tickerDisplayState = readValue(ticker, 'display_state');
  const depthDisplayState = readValue(depth, 'display_state');
  const tickerHasLiveStructure = ['LIVE_TRADABLE', 'REGULAR_OPEN']
    .includes(String(tickerDisplayState || '').trim().toUpperCase());
  const depthProvidesLiveStructure = bboAuthorityEntry === depthEntry
    && executable === true
    && !depthEntry?.stale;
  const recoverStructureFromDepth = depthProvidesLiveStructure
    && (!tickerHasLiveStructure || tickerExecutable !== true || tickerEntry?.stale === true);
  const structureEntry = recoverStructureFromDepth ? depthEntry : tickerEntry ?? depthEntry;
  const display = resolveDisplayPrice(ticker, bestBid, bestAsk);
  const bid = Number(bestBid);
  const ask = Number(bestAsk);
  const explicitSpread = readValue(ticker, 'spread') ?? readValue(depth, 'spread');
  const spread = explicitSpread ?? (
    Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask >= bid
      ? String(ask - bid)
      : null
  );
  const authorityEntry = structureEntry ?? bboAuthorityEntry;
  const snapshot: ContractHeaderStoreSnapshot = {
    symbol,
    ...display,
    markPrice: readPrice(ticker, 'mark_price') ?? readPrice(depth, 'mark_price'),
    indexPrice: readPrice(ticker, 'index_price') ?? readPrice(depth, 'index_price'),
    fundingRate: readValue(ticker, 'funding_rate'),
    bestBid,
    bestAsk,
    spread,
    priceChange24h: readValue(ticker, 'price_change_24h', 'change_24h'),
    priceChangePercent24h: readValue(
      ticker,
      'price_change_percent_24h',
      'priceChangePercent',
    ),
    high24h: readPrice(ticker, 'high_24h'),
    low24h: readPrice(ticker, 'low_24h'),
    baseVolume24h: readValue(ticker, 'base_volume_24h'),
    quoteVolume24h: readValue(ticker, 'quote_volume_24h'),
    displayState: recoverStructureFromDepth
      ? depthDisplayState ?? 'LIVE_TRADABLE'
      : tickerDisplayState ?? depthDisplayState,
    marketStatus: recoverStructureFromDepth
      ? readValue(depth, 'market_status') ?? readValue(ticker, 'market_status')
      : readValue(ticker, 'market_status') ?? readValue(depth, 'market_status'),
    marketSessionType: recoverStructureFromDepth
      ? readValue(depth, 'market_session_type') ?? readValue(ticker, 'market_session_type')
      : readValue(ticker, 'market_session_type') ?? readValue(depth, 'market_session_type'),
    executable,
    source: structureEntry?.source
      ?? (recoverStructureFromDepth
        ? readValue(depth, 'depth_source', 'source', 'quote_source')
        : readValue(ticker, 'ticker_source', 'source', 'quote_source'))
      ?? authorityEntry?.source
      ?? null,
    freshness: structureEntry?.freshness
      ?? (recoverStructureFromDepth
        ? readValue(depth, 'depth_freshness', 'freshness', 'quote_freshness')
        : readValue(ticker, 'ticker_freshness', 'freshness', 'quote_freshness'))
      ?? authorityEntry?.freshness
      ?? null,
    provider: tickerEntry?.provider ?? depthEntry?.provider ?? null,
    providerGeneration: tickerEntry?.providerGeneration ?? depthEntry?.providerGeneration ?? null,
    revision: tickerEntry?.revision ?? depthEntry?.revision ?? null,
    stale: authorityEntry?.stale ?? false,
    observedAtMs: Math.max(
      tickerEntry?.observedAtMs ?? 0,
      depthEntry?.observedAtMs ?? 0,
    ),
  };
  headerSnapshotCache.set(symbol, { tickerEntry, depthEntry, snapshot });
  return snapshot;
}

export function useContractHeaderStoreSnapshot(
  symbolValue: string,
): ContractHeaderStoreSnapshot | null {
  const symbol = normalizeSymbol(symbolValue);
  const subscribe = useCallback((onStoreChange: () => void) => (
    contractMarketStore.subscribe(() => onStoreChange())
  ), []);
  const getSnapshot = useCallback(
    () => selectContractHeaderStoreSnapshot(contractMarketStore.getState(), symbol),
    [symbol],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

type MarketViewAuthoritySnapshotCacheEntry = {
  tickerEntry: ContractMarketStoreEntry | undefined;
  depthEntry: ContractMarketStoreEntry | undefined;
  snapshot: ContractMarketViewStoreAuthoritySnapshot | null;
};

const marketViewAuthoritySnapshotCache = new Map<string, MarketViewAuthoritySnapshotCacheEntry>();

export function selectContractMarketViewStoreAuthoritySnapshot(
  state: ContractMarketStoreState,
  symbolValue: string,
): ContractMarketViewStoreAuthoritySnapshot | null {
  const symbol = normalizeSymbol(symbolValue);
  const activeSymbol = normalizeSymbol(state.activeSymbol);
  if (!symbol || activeSymbol !== symbol) return null;
  const tickerCandidate = state.entries[buildContractMarketStoreKey(symbol, 'ticker')];
  const depthCandidate = state.entries[buildContractMarketStoreKey(symbol, 'depth')];
  const tickerEntry = tickerCandidate?.sessionGeneration === state.sessionGeneration
    ? tickerCandidate
    : undefined;
  const depthEntry = depthCandidate?.sessionGeneration === state.sessionGeneration
    ? depthCandidate
    : undefined;
  const cached = marketViewAuthoritySnapshotCache.get(symbol);
  if (
    cached
    && cached.tickerEntry === tickerEntry
    && cached.depthEntry === depthEntry
  ) {
    return cached.snapshot;
  }
  if (!tickerEntry && !depthEntry) {
    marketViewAuthoritySnapshotCache.set(symbol, { tickerEntry, depthEntry, snapshot: null });
    return null;
  }

  const realtimeTickerEntry = tickerEntry?.transport === 'WS' ? tickerEntry : undefined;
  const realtimeDepthEntry = depthEntry?.transport === 'WS' ? depthEntry : undefined;
  const ticker = asRecord(realtimeTickerEntry?.data);
  const depth = asRecord(realtimeDepthEntry?.data);
  const depthBid = readBookBest(depth, 'bid');
  const depthAsk = readBookBest(depth, 'ask');
  const tickerBid = readBookBest(ticker, 'bid');
  const tickerAsk = readBookBest(ticker, 'ask');
  const hasDepthBbo = depthBid !== null && depthAsk !== null;
  const explicitDepthExecutionBid = readPrice(depth, 'execution_bid');
  const explicitDepthExecutionAsk = readPrice(depth, 'execution_ask');
  const explicitTickerExecutionBid = readPrice(ticker, 'execution_bid');
  const explicitTickerExecutionAsk = readPrice(ticker, 'execution_ask');
  const hasDepthExecutionBbo = explicitDepthExecutionBid !== null
    && explicitDepthExecutionAsk !== null;
  const hasTickerExecutionBbo = explicitTickerExecutionBid !== null
    && explicitTickerExecutionAsk !== null;
  const tickerProvider = String(
    realtimeTickerEntry?.provider || readValue(ticker, 'provider') || '',
  ).trim().toUpperCase();
  const hasGenericTickerBbo = tickerProvider !== 'ITICK'
    && tickerBid !== null
    && tickerAsk !== null;
  const hasTickerBbo = hasTickerExecutionBbo || hasGenericTickerBbo;
  const bestBid = hasDepthBbo
    ? depthBid
    : hasTickerExecutionBbo
      ? explicitTickerExecutionBid
      : hasGenericTickerBbo
        ? tickerBid
        : null;
  const bestAsk = hasDepthBbo
    ? depthAsk
    : hasTickerExecutionBbo
      ? explicitTickerExecutionAsk
      : hasGenericTickerBbo
        ? tickerAsk
        : null;
  const display = resolveDisplayPrice(ticker, bestBid, bestAsk);
  const bboAuthorityEntry = hasDepthExecutionBbo
    ? realtimeDepthEntry
    : hasTickerExecutionBbo
      ? realtimeTickerEntry
      : hasDepthBbo
        ? realtimeDepthEntry
        : hasTickerBbo
        ? realtimeTickerEntry
        : undefined;
  const tickerExecutable = typeof ticker?.executable === 'boolean'
    ? ticker.executable
    : null;
  const depthExecutable = typeof depth?.executable === 'boolean'
    ? depth.executable
    : null;
  // Execution follows the domain that supplied the selected BBO. A stale
  // ticker guard must not disable a newer executable depth snapshot.
  const executable = bboAuthorityEntry === realtimeDepthEntry
    ? depthExecutable ?? tickerExecutable
    : tickerExecutable ?? depthExecutable;
  const executionMode = bboAuthorityEntry === realtimeDepthEntry
    ? readValue(depth, 'execution_mode') ?? readValue(ticker, 'execution_mode')
    : readValue(ticker, 'execution_mode') ?? readValue(depth, 'execution_mode');
  const executionReasonCode = bboAuthorityEntry === realtimeDepthEntry
    ? readValue(depth, 'reason_code') ?? readValue(ticker, 'reason_code')
    : readValue(ticker, 'reason_code') ?? readValue(depth, 'reason_code');
  const executionBid = hasDepthExecutionBbo
    ? explicitDepthExecutionBid
    : hasTickerExecutionBbo
      ? explicitTickerExecutionBid
      : executable === true
        ? bestBid
        : null;
  const executionAsk = hasDepthExecutionBbo
    ? explicitDepthExecutionAsk
    : hasTickerExecutionBbo
      ? explicitTickerExecutionAsk
      : executable === true
        ? bestAsk
        : null;
  const hasRealtimeBboAuthority = Boolean(bboAuthorityEntry);
  const bboObservedAtMs = bboAuthorityEntry?.observedAtMs ?? 0;
  const bid = Number(bestBid);
  const ask = Number(bestAsk);
  const spread = readValue(ticker, 'spread')
    ?? readValue(depth, 'spread')
    ?? (
      Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask >= bid
        ? String(ask - bid)
        : null
    );
  const snapshot: ContractMarketViewStoreAuthoritySnapshot = {
    symbol,
    ...display,
    displayState: readValue(ticker, 'display_state') ?? readValue(depth, 'display_state'),
    marketStatus: readValue(ticker, 'market_status') ?? readValue(depth, 'market_status'),
    marketSessionType: readValue(ticker, 'market_session_type')
      ?? readValue(depth, 'market_session_type'),
    bestBid,
    bestAsk,
    spread,
    executionBid,
    executionAsk,
    executionMode,
    executable,
    reasonCode: executionReasonCode,
    tickerSource: realtimeTickerEntry?.source
      ?? readValue(ticker, 'ticker_source', 'source', 'quote_source'),
    tickerFreshness: realtimeTickerEntry?.freshness
      ?? readValue(ticker, 'ticker_freshness', 'freshness', 'quote_freshness'),
    depthSource: bboAuthorityEntry === realtimeDepthEntry
      ? realtimeDepthEntry?.source ?? readValue(depth, 'depth_source', 'source', 'quote_source')
      : realtimeTickerEntry?.source ?? readValue(ticker, 'ticker_source', 'source', 'quote_source'),
    depthFreshness: bboAuthorityEntry === realtimeDepthEntry
      ? realtimeDepthEntry?.freshness
        ?? readValue(depth, 'depth_freshness', 'freshness', 'quote_freshness')
      : realtimeTickerEntry?.freshness
        ?? readValue(ticker, 'ticker_freshness', 'freshness', 'quote_freshness'),
    hasRealtimeAuthority: Boolean(realtimeTickerEntry),
    hasRealtimeBboAuthority,
    stale: Boolean(
      realtimeTickerEntry?.stale
      || (executable === true && bboAuthorityEntry?.stale),
    ),
    tickerObservedAtMs: realtimeTickerEntry?.observedAtMs ?? 0,
    bboObservedAtMs,
    observedAtMs: Math.max(
      realtimeTickerEntry?.observedAtMs ?? 0,
      bboObservedAtMs,
    ),
  };
  marketViewAuthoritySnapshotCache.set(symbol, { tickerEntry, depthEntry, snapshot });
  return snapshot;
}

export function useContractMarketViewStoreAuthoritySnapshot(
  symbolValue: string,
): ContractMarketViewStoreAuthoritySnapshot | null {
  const symbol = normalizeSymbol(symbolValue);
  const subscribe = useCallback((onStoreChange: () => void) => (
    contractMarketStore.subscribe(() => onStoreChange())
  ), []);
  const getSnapshot = useCallback(
    () => selectContractMarketViewStoreAuthoritySnapshot(contractMarketStore.getState(), symbol),
    [symbol],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function projectContractMarketViewStoreAuthority(
  snapshot: ContractMarketViewStoreAuthoritySnapshot | null,
  baseView: ContractMarketViewDetail | null = null,
  nowMs = Date.now(),
): ContractMarketViewDetail | null {
  const sameSymbolBase = snapshot && normalizeSymbol(baseView?.symbol) === snapshot.symbol
    ? baseView
    : null;
  const snapshotDisplayState = String(snapshot?.displayState || '').trim().toUpperCase();
  const snapshotMarketStatus = String(snapshot?.marketStatus || '').trim().toUpperCase();
  const snapshotSessionType = String(snapshot?.marketSessionType || '').trim().toUpperCase();
  const baseDisplayState = String(sameSymbolBase?.display_state || '').trim().toUpperCase();
  const baseExecutionBid = Number(sameSymbolBase?.execution_bid);
  const baseExecutionAsk = Number(sameSymbolBase?.execution_ask);
  const baseHasExecutableBbo = Number.isFinite(baseExecutionBid)
    && Number.isFinite(baseExecutionAsk)
    && baseExecutionBid > 0
    && baseExecutionAsk >= baseExecutionBid;
  const baseConfirmsLiveAuthority = (
    baseDisplayState === 'LIVE_TRADABLE'
    || baseDisplayState === 'REGULAR_OPEN'
  ) && sameSymbolBase?.executable === true && baseHasExecutableBbo;
  const snapshotHasLiveState = snapshotDisplayState === 'LIVE_TRADABLE'
    || snapshotDisplayState === 'REGULAR_OPEN';
  const nonTradingSessionTokens = [
    'PRE_MARKET',
    'AFTER_HOURS',
    'CLOSED',
    'MARKET_CLOSED',
    'HOLIDAY',
  ];
  const snapshotIsNonTradingSession = nonTradingSessionTokens.includes(snapshotMarketStatus)
    || nonTradingSessionTokens.includes(snapshotSessionType);
  const tickerAgeMs = snapshot
    ? Math.max(0, nowMs - snapshot.tickerObservedAtMs)
    : Number.POSITIVE_INFINITY;
  const bboAgeMs = snapshot
    ? Math.max(0, nowMs - snapshot.bboObservedAtMs)
    : Number.POSITIVE_INFINITY;
  const executionBid = Number(snapshot?.executionBid);
  const executionAsk = Number(snapshot?.executionAsk);
  const hasExecutableBbo = Number.isFinite(executionBid)
    && Number.isFinite(executionAsk)
    && executionBid > 0
    && executionAsk >= executionBid;
  const hasFreshRealtimeBbo = snapshot?.executable === true
    && snapshot.hasRealtimeBboAuthority
    && snapshot.bboObservedAtMs > 0
    && bboAgeMs <= CONTRACT_MARKET_STORE_RECOVERY_MAX_AGE_MS
    && hasExecutableBbo;
  const recoverStructureFromBase = Boolean(
    sameSymbolBase
    && baseConfirmsLiveAuthority
    && !snapshotHasLiveState
    && !snapshotIsNonTradingSession,
  );
  // A partial ticker revision can temporarily retain UNAVAILABLE structure
  // after a newer depth domain has proved a complete executable BBO. Promote
  // only that fresh realtime execution authority; closed sessions and stale or
  // incomplete BBOs remain fail-closed.
  const recoverStructureFromBbo = Boolean(
    !recoverStructureFromBase
    && !snapshotHasLiveState
    && !snapshotIsNonTradingSession
    && hasFreshRealtimeBbo,
  );
  const effectiveDisplayPrice = recoverStructureFromBase
    ? String(sameSymbolBase?.display_price || '') || null
    : snapshot?.displayPrice || null;
  const effectiveDisplayState = recoverStructureFromBase
    ? baseDisplayState
    : recoverStructureFromBbo
      ? 'LIVE_TRADABLE'
      : snapshot?.displayState || null;
  if (
    !snapshot
    || !snapshot.hasRealtimeAuthority
    || snapshot.stale
    || snapshot.tickerObservedAtMs <= 0
    || tickerAgeMs > CONTRACT_MARKET_STORE_RECOVERY_MAX_AGE_MS
    || !effectiveDisplayPrice
    || !effectiveDisplayState
  ) {
    return null;
  }
  if (
    snapshot.executable === true
    && (
      !snapshot.hasRealtimeBboAuthority
      || snapshot.bboObservedAtMs <= 0
      || bboAgeMs > CONTRACT_MARKET_STORE_RECOVERY_MAX_AGE_MS
      || !hasExecutableBbo
    )
  ) return null;

  const executable = (
    recoverStructureFromBase
      ? baseConfirmsLiveAuthority
      : snapshot.executable === true
  ) && hasExecutableBbo && !snapshotIsNonTradingSession;
  const observedAtMs = snapshot.observedAtMs > 0 ? snapshot.observedAtMs : nowMs;
  return {
    ...(sameSymbolBase || {}),
    symbol: snapshot.symbol,
    display_symbol: sameSymbolBase?.display_symbol || snapshot.symbol,
    market_type: sameSymbolBase?.market_type || 'CONTRACT',
    category: sameSymbolBase?.category || 'UNKNOWN',
    market_status: snapshot.marketStatus || sameSymbolBase?.market_status || 'UNKNOWN',
    market_session_type: snapshot.marketSessionType || sameSymbolBase?.market_session_type || null,
    display_state: effectiveDisplayState,
    display_price: effectiveDisplayPrice,
    display_price_source: (recoverStructureFromBase ? sameSymbolBase?.display_price_source : snapshot.displayPriceSource)
      || sameSymbolBase?.display_price_source
      || 'LIVE_MID',
    current_price_source: (recoverStructureFromBase ? sameSymbolBase?.current_price_source : snapshot.displayPriceSource)
      || sameSymbolBase?.current_price_source
      || null,
    ticker_source: snapshot.tickerSource,
    ticker_freshness: snapshot.tickerFreshness,
    depth_source: snapshot.depthSource,
    // Store freshness/staleness and the selected BBO entry already prove the
    // realtime execution authority above. Project that result back into the
    // canonical MarketView vocabulary consumed by PriceAuthority instead of
    // leaking provider/domain-specific mode names into the execution gate.
    depth_freshness: executable ? 'LIVE' : snapshot.depthFreshness,
    best_bid: snapshot.bestBid,
    best_ask: snapshot.bestAsk,
    spread: snapshot.spread,
    executable,
    execution_bid: executable ? snapshot.executionBid : null,
    execution_ask: executable ? snapshot.executionAsk : null,
    execution_mode: executable ? 'LIVE_BBO' : 'UNAVAILABLE',
    last_good_bbo_valid: executable,
    price_age_ms: Math.max(0, nowMs - observedAtMs),
    quote_time: new Date(observedAtMs).toISOString(),
    last_good_at: sameSymbolBase?.last_good_at ?? null,
    reason_code: executable
      ? 'LIVE_BBO'
      : (recoverStructureFromBase ? sameSymbolBase?.reason_code : snapshot.reasonCode)
        || 'STORE_MARKET_NOT_EXECUTABLE',
    warnings: sameSymbolBase?.warnings || [],
    raw_source_summary: {
      ...(sameSymbolBase?.raw_source_summary || {}),
      authority_source: recoverStructureFromBase
        ? 'CONTRACT_MARKET_STORE_WITH_REST_STRUCTURE'
        : recoverStructureFromBbo
          ? 'CONTRACT_MARKET_STORE_WITH_BBO_STRUCTURE'
          : 'CONTRACT_MARKET_STORE',
      store_execution_mode: snapshot.executionMode,
      store_depth_freshness: snapshot.depthFreshness,
      store_observed_at_ms: observedAtMs,
    },
  };
}

type TradingFormSnapshotCacheEntry = {
  tickerEntry: ContractMarketStoreEntry | undefined;
  snapshot: ContractTradingFormStoreSnapshot | null;
};

const tradingFormSnapshotCache = new Map<string, TradingFormSnapshotCacheEntry>();

export function selectContractTradingFormStoreSnapshot(
  state: ContractMarketStoreState,
  symbolValue: string,
): ContractTradingFormStoreSnapshot | null {
  const symbol = normalizeSymbol(symbolValue);
  const activeSymbol = normalizeSymbol(state.activeSymbol);
  const candidate = symbol && activeSymbol === symbol
    ? state.entries[buildContractMarketStoreKey(symbol, 'ticker')]
    : undefined;
  const tickerEntry = candidate?.sessionGeneration === state.sessionGeneration
    ? candidate
    : undefined;
  const cached = tradingFormSnapshotCache.get(symbol);
  if (cached && cached.tickerEntry === tickerEntry) return cached.snapshot;
  if (!symbol || !tickerEntry) {
    tradingFormSnapshotCache.set(symbol, { tickerEntry, snapshot: null });
    return null;
  }

  const ticker = asRecord(tickerEntry.data);
  const snapshot: ContractTradingFormStoreSnapshot = {
    symbol,
    displayPrice: readPrice(ticker, 'display_price', 'last_price', 'price', 'last'),
    displayPriceSource: readValue(
      ticker,
      'display_price_source',
      'current_price_source',
      'price_source',
    ),
    markPrice: readPrice(ticker, 'mark_price'),
    indexPrice: readPrice(ticker, 'index_price'),
    marketStatus: readValue(ticker, 'market_status'),
    displayState: readValue(ticker, 'display_state'),
    executable: typeof ticker?.executable === 'boolean' ? ticker.executable : null,
    reasonCode: readValue(ticker, 'reason_code'),
    source: tickerEntry.source
      ?? readValue(ticker, 'ticker_source', 'source', 'quote_source'),
    freshness: tickerEntry.freshness
      ?? readValue(ticker, 'ticker_freshness', 'freshness', 'quote_freshness'),
    provider: tickerEntry.provider ?? readValue(ticker, 'provider'),
    providerGeneration: tickerEntry.providerGeneration,
    revision: tickerEntry.revision,
    stale: tickerEntry.stale,
    observedAtMs: tickerEntry.observedAtMs,
  };
  tradingFormSnapshotCache.set(symbol, { tickerEntry, snapshot });
  return snapshot;
}

export function subscribeContractTradingFormStore(
  symbolValue: string,
  onStoreChange: () => void,
): () => void {
  const symbol = normalizeSymbol(symbolValue);
  let previousSnapshot = selectContractTradingFormStoreSnapshot(
    contractMarketStore.getState(),
    symbol,
  );
  return contractMarketStore.subscribe(() => {
    const nextSnapshot = selectContractTradingFormStoreSnapshot(
      contractMarketStore.getState(),
      symbol,
    );
    if (Object.is(previousSnapshot, nextSnapshot)) return;
    previousSnapshot = nextSnapshot;
    onStoreChange();
  });
}

export function useContractTradingFormStoreSnapshot(
  symbolValue: string,
): ContractTradingFormStoreSnapshot | null {
  const symbol = normalizeSymbol(symbolValue);
  const subscribe = useCallback(
    (onStoreChange: () => void) => subscribeContractTradingFormStore(symbol, onStoreChange),
    [symbol],
  );
  const getSnapshot = useCallback(
    () => selectContractTradingFormStoreSnapshot(contractMarketStore.getState(), symbol),
    [symbol],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function normalizeOrderBookLevels(value: unknown): ContractOrderBookStoreLevel[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((level) => {
    const record = asRecord(level);
    const priceValue = Array.isArray(level) ? level[0] : record?.price;
    const amountValue = Array.isArray(level)
      ? level[1]
      : record?.amount ?? record?.qty ?? record?.quantity;
    const price = Number(priceValue);
    const amount = Number(amountValue);
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(amount) || amount < 0) {
      return [];
    }
    return [{ price: String(priceValue), amount: String(amountValue) }];
  });
}

function bestLevelPrice(
  levels: ContractOrderBookStoreLevel[],
  side: 'bid' | 'ask',
): string | null {
  if (!levels.length) return null;
  let best = Number(levels[0].price);
  for (const level of levels.slice(1)) {
    const price = Number(level.price);
    best = side === 'bid' ? Math.max(best, price) : Math.min(best, price);
  }
  return Number.isFinite(best) && best > 0 ? String(best) : null;
}

type OrderBookSnapshotCache = {
  activeSymbol: string | null;
  depthEntry: ContractMarketStoreEntry | undefined;
  snapshot: ContractOrderBookStoreSnapshot | null;
};

let orderBookSnapshotCache: OrderBookSnapshotCache = {
  activeSymbol: null,
  depthEntry: undefined,
  snapshot: null,
};

export function selectContractOrderBookStoreSnapshot(
  state: ContractMarketStoreState,
): ContractOrderBookStoreSnapshot | null {
  const symbol = normalizeSymbol(state.activeSymbol);
  const depthCandidate = symbol
    ? state.entries[buildContractMarketStoreKey(symbol, 'depth')]
    : undefined;
  const depthEntry = depthCandidate?.sessionGeneration === state.sessionGeneration
    ? depthCandidate
    : undefined;
  if (
    orderBookSnapshotCache.activeSymbol === (symbol || null)
    && orderBookSnapshotCache.depthEntry === depthEntry
  ) {
    return orderBookSnapshotCache.snapshot;
  }
  if (!symbol || !depthEntry) {
    orderBookSnapshotCache = {
      activeSymbol: symbol || null,
      depthEntry,
      snapshot: null,
    };
    return null;
  }

  const depth = asRecord(depthEntry.data);
  const bids = normalizeOrderBookLevels(depth?.bids);
  const asks = normalizeOrderBookLevels(depth?.asks);
  const bestBid = bestLevelPrice(bids, 'bid') ?? readBookBest(depth, 'bid');
  const bestAsk = bestLevelPrice(asks, 'ask') ?? readBookBest(depth, 'ask');
  const bid = Number(bestBid);
  const ask = Number(bestAsk);
  const spread = Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask >= bid
    ? String(ask - bid)
    : null;
  const midpoint = Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0 && ask >= bid
    ? String((bid + ask) / 2)
    : null;
  const snapshot: ContractOrderBookStoreSnapshot = {
    symbol,
    bids,
    asks,
    bestBid,
    bestAsk,
    spread,
    midpoint,
    depthMode: readValue(depth, 'depth_mode', 'depthMode'),
    marketStatus: readValue(depth, 'market_status'),
    executable: typeof depth?.executable === 'boolean' ? depth.executable : null,
    source: depthEntry.source ?? readValue(depth, 'source', 'quote_source'),
    freshness: depthEntry.freshness ?? readValue(depth, 'freshness', 'quote_freshness'),
    provider: depthEntry.provider ?? readValue(depth, 'provider'),
    providerGeneration: depthEntry.providerGeneration,
    revision: depthEntry.revision,
    stale: depthEntry.stale,
    observedAtMs: depthEntry.observedAtMs,
  };
  orderBookSnapshotCache = { activeSymbol: symbol, depthEntry, snapshot };
  return snapshot;
}

export function subscribeContractOrderBookStore(onStoreChange: () => void): () => void {
  let previousSnapshot = selectContractOrderBookStoreSnapshot(contractMarketStore.getState());
  return contractMarketStore.subscribe(() => {
    const nextSnapshot = selectContractOrderBookStoreSnapshot(contractMarketStore.getState());
    if (Object.is(previousSnapshot, nextSnapshot)) return;
    previousSnapshot = nextSnapshot;
    onStoreChange();
  });
}

export function useContractOrderBookStoreSnapshot(): ContractOrderBookStoreSnapshot | null {
  const subscribe = useCallback(
    (onStoreChange: () => void) => subscribeContractOrderBookStore(onStoreChange),
    [],
  );
  const getSnapshot = useCallback(
    () => selectContractOrderBookStoreSnapshot(contractMarketStore.getState()),
    [],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function readTradesPayload(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const record = asRecord(value);
  if (!record) return [];
  for (const key of ['trades', 'items', 'rows']) {
    if (Array.isArray(record[key])) return record[key];
  }
  return record.price !== undefined && record.price !== null ? [record] : [];
}

function isSyntheticTrade(record: UnknownRecord): boolean {
  if (record.synthetic === true) return true;
  return ['price_source', 'source', 'quote_source'].some((key) => (
    String(record[key] ?? '').trim().toUpperCase().includes('SYNTHETIC')
  ));
}

const CONTRACT_TRADES_DISPLAY_LIMIT = 30;

function normalizeTrades(value: unknown): ContractTradesStoreTrade[] {
  const normalized = readTradesPayload(value).flatMap((valueAtIndex, index) => {
    const record = asRecord(valueAtIndex);
    if (!record || isSyntheticTrade(record)) return [];
    const id = readText([record], 'id', 'trade_id');
    const priceValue = readFirst([record], 'price', 'last_price');
    const qtyValue = readFirst([record], 'qty', 'amount', 'quantity', 'volume');
    const time = readTimestamp(
      [record],
      'time',
      'ts',
      'timestamp',
      'provider_event_time_ms',
      'event_time_ms',
    );
    const price = Number(priceValue);
    const qty = Number(qtyValue);
    if (
      !id
      || !Number.isFinite(price)
      || price <= 0
      || !Number.isFinite(qty)
      || qty <= 0
      || time === null
    ) {
      return [];
    }

    const trade: ContractTradesStoreTrade = {
      id,
      price: String(priceValue),
      qty: String(qtyValue),
      time,
    };
    const optionalTextFields = [
      'last_price',
      'amount',
      'volume',
      'quoteQty',
      'side',
      'source',
      'quote_source',
      'quote_freshness',
      'price_source',
    ] as const;
    for (const field of optionalTextFields) {
      const fieldValue = record[field];
      if (fieldValue !== undefined && fieldValue !== null && fieldValue !== '') {
        trade[field] = String(fieldValue);
      }
    }
    if (typeof record.isBuyerMaker === 'boolean') {
      trade.isBuyerMaker = record.isBuyerMaker;
    } else if (typeof record.is_buyer_maker === 'boolean') {
      trade.isBuyerMaker = record.is_buyer_maker;
    }
    return [{ trade, inputIndex: index }];
  });

  return orderContractTradesNewestFirst(
    normalized.map(({ trade }) => trade),
    CONTRACT_TRADES_DISPLAY_LIMIT,
  );
}

type TradesSnapshotCache = {
  activeSymbol: string | null;
  tradesEntry: ContractMarketStoreEntry | undefined;
  snapshot: ContractTradesStoreSnapshot | null;
};

let tradesSnapshotCache: TradesSnapshotCache = {
  activeSymbol: null,
  tradesEntry: undefined,
  snapshot: null,
};

export function selectContractTradesStoreSnapshot(
  state: ContractMarketStoreState,
): ContractTradesStoreSnapshot | null {
  const symbol = normalizeSymbol(state.activeSymbol);
  const tradesCandidate = symbol
    ? state.entries[buildContractMarketStoreKey(symbol, 'trades')]
    : undefined;
  const tradesEntry = tradesCandidate?.sessionGeneration === state.sessionGeneration
    ? tradesCandidate
    : undefined;
  if (
    tradesSnapshotCache.activeSymbol === (symbol || null)
    && tradesSnapshotCache.tradesEntry === tradesEntry
  ) {
    return tradesSnapshotCache.snapshot;
  }
  if (!symbol || !tradesEntry) {
    tradesSnapshotCache = {
      activeSymbol: symbol || null,
      tradesEntry,
      snapshot: null,
    };
    return null;
  }

  const trades = normalizeTrades(tradesEntry.data);
  const latest = trades[0];
  const snapshot: ContractTradesStoreSnapshot = {
    symbol,
    trades,
    source: tradesEntry.source ?? latest?.source ?? latest?.quote_source ?? null,
    freshness: tradesEntry.freshness ?? latest?.quote_freshness ?? null,
    provider: tradesEntry.provider,
    providerGeneration: tradesEntry.providerGeneration,
    revision: tradesEntry.revision,
    stale: tradesEntry.stale,
    observedAtMs: tradesEntry.observedAtMs,
  };
  tradesSnapshotCache = { activeSymbol: symbol, tradesEntry, snapshot };
  return snapshot;
}

export function subscribeContractTradesStore(onStoreChange: () => void): () => void {
  let previousSnapshot = selectContractTradesStoreSnapshot(contractMarketStore.getState());
  return contractMarketStore.subscribe(() => {
    const nextSnapshot = selectContractTradesStoreSnapshot(contractMarketStore.getState());
    if (Object.is(previousSnapshot, nextSnapshot)) return;
    previousSnapshot = nextSnapshot;
    onStoreChange();
  });
}

export function useContractTradesStoreSnapshot(): ContractTradesStoreSnapshot | null {
  const subscribe = useCallback(
    (onStoreChange: () => void) => subscribeContractTradesStore(onStoreChange),
    [],
  );
  const getSnapshot = useCallback(
    () => selectContractTradesStoreSnapshot(contractMarketStore.getState()),
    [],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function activateContractMarketShadowSymbol(symbol: string): number {
  return contractMarketStore.activateSymbol(symbol);
}

export function restartContractMarketShadowSession(symbol: string): number {
  return contractMarketStore.restartSession(symbol);
}

export function writeContractMarketShadowDomain({
  symbol,
  domain,
  interval,
  data,
  transport,
  metadata,
  envelope,
}: ContractMarketShadowDomainInput): ContractMarketStoreIngestResult {
  const metadataRecord = asRecord(metadata);
  const dataRecord = firstRecord(data);
  const envelopeRecord = asRecord(envelope);
  const candidates = [metadataRecord, dataRecord, envelopeRecord];
  const revision = readRevision(candidates);
  const resolvedInterval = interval
    || readText(candidates, 'interval', 'resolution')
    || (domain === 'kline' ? '1m' : null);
  const resolvedData = domain === 'ticker'
    ? mergeTickerStructuralAuthority(symbol, data, transport)
    : transport === 'WS' && domain === 'trades'
      ? mergeRealtimeTrades(symbol, data)
      : data;

  return contractMarketStore.ingest({
    symbol,
    domain,
    interval: resolvedInterval,
    data: resolvedData,
    transport,
    source: readText(candidates, 'source', 'quote_source', 'price_source'),
    provider: readText(candidates, 'provider'),
    freshness: readText(candidates, 'freshness', 'quote_freshness'),
    providerGeneration: readNumber(candidates, 'provider_generation', 'providerGeneration', 'generation'),
    revision,
    eventTimeMs: readTimestamp(
      candidates,
      'provider_event_time_ms',
      'event_time_ms',
      'updated_at_ms',
      'ts',
      'time',
      'timestamp',
      'open_time',
    ),
    receivedAtMs: readTimestamp(
      candidates,
      'received_at_ms',
      'cache_updated_at_ms',
      'db_updated_at_ms',
    ) ?? Date.now(),
    stale: readBoolean(candidates, 'stale'),
  });
}

export function hydrateContractMarketRestDomain(
  input: Omit<ContractMarketShadowDomainInput, 'transport' | 'envelope'>,
): ContractMarketStoreIngestResult {
  return writeContractMarketShadowDomain({ ...input, transport: 'REST' });
}

export function ingestContractMarketWsDomain(params: {
  domain: ContractMarketStoreDomain;
  message: ContractMarketRealtimeMessage;
  data?: unknown;
  interval?: string | null;
}): ContractMarketStoreIngestResult {
  const messageRecord = params.message as UnknownRecord;
  const data = params.data
    ?? messageRecord[params.domain === 'trades' ? 'trades' : params.domain]
    ?? params.message.data;
  const dataRecord = firstRecord(data);
  const symbol = String(params.message.symbol || dataRecord?.symbol || '').trim().toUpperCase();
  return writeContractMarketShadowDomain({
    symbol,
    domain: params.domain,
    interval: params.interval || params.message.interval || null,
    data,
    transport: 'WS',
    metadata: dataRecord,
    envelope: messageRecord,
  });
}

export function hydrateContractMarketViewShadow(
  value: unknown,
  transport: Extract<ContractMarketStoreTransport, 'REST' | 'WS'>,
  domains: readonly ContractMarketStoreDomain[] = ['ticker', 'depth', 'trades', 'kline'],
): ContractMarketStoreIngestResult[] {
  const view = asRecord(value) as ContractMarketViewShadowPayload | null;
  const symbol = String(view?.symbol ?? '').trim().toUpperCase();
  if (!view || !symbol) return [];
  const snapshotMetadata = asRecord(view.snapshot_metadata);
  const results: ContractMarketStoreIngestResult[] = [];
  for (const domain of domains) {
    const metadata = snapshotMetadata ? snapshotMetadata[domain] : null;
    const domainData = domain === 'kline'
      ? view.kline ?? view.kline_current_candle
      : view[domain];
    if (domainData === undefined || domainData === null) {
      if (!metadata) continue;
    }
    const data = domain === 'ticker'
      ? projectMarketViewTicker(view, domainData)
      : domainData;
    results.push(writeContractMarketShadowDomain({
      symbol,
      domain,
      interval: domain === 'kline'
        ? readText([asRecord(metadata), firstRecord(data)], 'interval') || '1m'
        : null,
      data: data ?? null,
      transport,
      metadata,
      envelope: view,
    }));
  }
  return results;
}
