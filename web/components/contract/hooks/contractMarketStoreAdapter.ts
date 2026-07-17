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
  const value = readFirst(candidates, ...keys);
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string' && !Number.isFinite(Number(value))) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized <= 0) return null;
  return normalized < 1_000_000_000_000 ? normalized * 1000 : normalized;
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

function tradeIdentity(value: unknown): string {
  const trade = asRecord(value);
  if (!trade) return String(value);
  return String(
    trade.id
    ?? trade.trade_id
    ?? `${trade.time ?? trade.ts ?? trade.timestamp ?? ''}:${trade.price ?? trade.last_price ?? ''}:${trade.qty ?? trade.amount ?? ''}`,
  );
}

function mergeRealtimeTrades(symbol: string, incoming: unknown): unknown {
  if (!Array.isArray(incoming)) return incoming;
  const state = contractMarketStore.getState();
  const entry = contractMarketStore.getEntry<unknown[]>(symbol, 'trades');
  const current = entry?.sessionGeneration === state.sessionGeneration
    ? entry.data
    : null;
  if (!Array.isArray(current)) return incoming;
  const seen = new Set<string>();
  return [...incoming, ...current]
    .filter((trade) => {
      const key = tradeIdentity(trade);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 100);
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
  if (explicitPrice) {
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
  ];
  for (const field of fields) {
    const fieldValue = view[field];
    if (fieldValue !== undefined && fieldValue !== null) projected[field] = fieldValue;
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
  const bestBid = readBookBest(depth, 'bid') ?? readBookBest(ticker, 'bid');
  const bestAsk = readBookBest(depth, 'ask') ?? readBookBest(ticker, 'ask');
  const display = resolveDisplayPrice(ticker, bestBid, bestAsk);
  const bid = Number(bestBid);
  const ask = Number(bestAsk);
  const explicitSpread = readValue(ticker, 'spread') ?? readValue(depth, 'spread');
  const spread = explicitSpread ?? (
    Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask >= bid
      ? String(ask - bid)
      : null
  );
  const authorityEntry = tickerEntry ?? depthEntry;
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
    displayState: readValue(ticker, 'display_state') ?? readValue(depth, 'display_state'),
    marketStatus: readValue(ticker, 'market_status') ?? readValue(depth, 'market_status'),
    marketSessionType: readValue(ticker, 'market_session_type')
      ?? readValue(depth, 'market_session_type'),
    executable: typeof ticker?.executable === 'boolean'
      ? ticker.executable
      : typeof depth?.executable === 'boolean'
        ? depth.executable
        : null,
    source: tickerEntry?.source
      ?? readValue(ticker, 'ticker_source', 'source', 'quote_source')
      ?? authorityEntry?.source
      ?? null,
    freshness: tickerEntry?.freshness
      ?? readValue(ticker, 'ticker_freshness', 'freshness', 'quote_freshness')
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

  normalized.sort((left, right) => (
    right.trade.time - left.trade.time || left.inputIndex - right.inputIndex
  ));
  const seen = new Set<string>();
  return normalized.flatMap(({ trade }) => {
    if (seen.has(trade.id)) return [];
    seen.add(trade.id);
    return [trade];
  }).slice(0, CONTRACT_TRADES_DISPLAY_LIMIT);
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
  const resolvedData = transport === 'WS' && domain === 'trades'
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
): ContractMarketStoreIngestResult[] {
  const view = asRecord(value) as ContractMarketViewShadowPayload | null;
  const symbol = String(view?.symbol ?? '').trim().toUpperCase();
  if (!view || !symbol) return [];
  const snapshotMetadata = asRecord(view.snapshot_metadata);
  const results: ContractMarketStoreIngestResult[] = [];
  const domains: ContractMarketStoreDomain[] = ['ticker', 'depth', 'trades', 'kline'];

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
