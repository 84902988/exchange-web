'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  getSpotMarketView,
  normalizeSpotSymbol,
  normalizeSpotTrades,
  type SpotDepthLevel,
  type SpotDepthResponse,
  type SpotMarketTradeItem,
  type SpotMarketTickerItem,
  type SpotMarketView,
} from '@/lib/api/modules/spot';
import { writeMarketCache } from '@/lib/marketCache';
import {
  spotMarketRealtime,
  type SpotMarketRealtimeMessage,
} from '@/services/marketRealtime';
import {
  getRealtimePriceDirection,
  type RealtimePriceDirection,
} from './spotTickerColor';
import {
  extractSpotDepthEventTimeMs,
  extractSpotTickerEventTimeMs,
  extractSpotTradeEventTimeMs,
  extractSpotTradesEventTimeMs,
  getPresentSpotMarketDomains,
  getSpotMarketDomainHighWaterKey,
  sequenceSpotMarketDomainEvent,
  type NormalizedSpotMarketDomainEvent,
  type SpotMarketDomain,
  type SpotMarketDomainEvent,
  type SpotMarketDomainSequenceDecision,
  type SpotMarketDomainSequenceState,
  type SpotMarketDomainTransport,
} from './spotMarketDomainSequencer';

type SpotMarketCache = {
  symbol?: string;
  marketView?: SpotMarketView | null;
  depth?: SpotDepthResponse | null;
  trades?: SpotMarketTradeItem[];
  lastPrice?: string | number | null;
  priceDirection?: RealtimePriceDirection;
  updatedAt?: number;
};

type SpotLastTradeState = {
  price: string | number | null;
  at: number | null;
  direction: RealtimePriceDirection;
  symbol: string | null;
  tradeId: string | null;
  providerTradeId: string | null;
};

type SpotMarketSnapshotMessage = SpotMarketRealtimeMessage & {
  type: 'spot_market_snapshot';
  symbol?: string;
  market_view?: SpotMarketView;
  depth?: SpotDepthResponse;
  trades?: SpotMarketView['trades'];
  ticker?: SpotMarketTickerItem;
};

type SpotTradeMessage = SpotMarketRealtimeMessage & {
  type: 'spot_trade';
  symbol?: string;
  provider?: string | null;
  provider_symbol?: string | null;
  source?: string | null;
  freshness?: string | null;
  trade?: SpotMarketTradeItem & { id?: string | number };
};

type SpotDepthMessage = SpotMarketRealtimeMessage & {
  type: 'spot_depth_update';
  symbol?: string;
  depth?: SpotDepthResponse;
};

type SpotTickerMessage = SpotMarketRealtimeMessage & {
  type: 'spot_ticker_update';
  symbol?: string;
  ticker?: SpotMarketTickerItem & {
    source?: string | null;
    freshness?: string | null;
  };
};

type SpotMarketFreshnessMap = {
  depth: string | null;
  trades: string | null;
  ticker: string | null;
  kline: string | null;
};

type SpotMarketSourceMap = {
  depth: string | null;
  trades: string | null;
  ticker: string | null;
  kline: string | null;
};

type SpotMarketRefreshOptions = {
  force?: boolean;
};

export type UseSpotMarketResult = {
  symbol: string;
  marketView: SpotMarketView | null;
  depth: SpotDepthResponse | null;
  trades: SpotMarketTradeItem[];
  ticker: SpotMarketTickerItem | null;
  klineStatus: string | null;
  displayPrice: string | number | null;
  displayPriceSource: string | null;
  lastTradePrice: string | number | null;
  lastTradeAt: number | null;
  lastTradeDirection: RealtimePriceDirection;
  lastTradeSymbol: string | null;
  lastTradeId: string | null;
  providerTradeId: string | null;
  orderbookMidPrice: string | number | null;
  lastPrice: string | number | null;
  priceDirection: RealtimePriceDirection;
  bestBid: string | number | null;
  bestAsk: string | number | null;
  freshness: SpotMarketFreshnessMap;
  sources: SpotMarketSourceMap;
  isConnected: boolean;
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
};

const SPOT_VIEW_FOREGROUND_POLL_MS = 10000;
const SPOT_VIEW_HIDDEN_POLL_MS = 30000;
const SPOT_VIEW_MIN_REFRESH_INTERVAL_MS = 2000;
const MAX_SEEN_TRADE_KEYS = 240;
const EMPTY_LAST_TRADE_STATE: SpotLastTradeState = {
  price: null,
  at: null,
  direction: 'flat',
  symbol: null,
  tradeId: null,
  providerTradeId: null,
};

function normalizeDepth(depth?: SpotDepthResponse | null): SpotDepthResponse | null {
  if (!depth) return null;
  return {
    ...depth,
    bids: Array.isArray(depth.bids) ? depth.bids : [],
    asks: Array.isArray(depth.asks) ? depth.asks : [],
  };
}

function normalizeTrades(
  trades?: SpotMarketSnapshotMessage['trades'] | null,
): SpotMarketTradeItem[] {
  if (!trades) return [];
  return normalizeSpotTrades({
    symbol: trades.symbol || '',
    items: trades.items,
    trades: trades.trades,
  });
}

function hasValue(value: unknown): boolean {
  return value !== null && value !== undefined && String(value).trim() !== '';
}

function hasDepthLevels(depth?: SpotDepthResponse | null): boolean {
  return Boolean(depth && ((depth.bids?.length || 0) > 0 || (depth.asks?.length || 0) > 0));
}

function isUnavailableDomainValue(value?: string | null): boolean {
  const normalized = normalizeDomainValue(value);
  return (
    normalized === 'MISSING' ||
    normalized === 'EMPTY' ||
    normalized === 'STALE' ||
    normalized === 'LAST_GOOD' ||
    normalized === 'LAST_VALID'
  );
}

function isDepthDomainUnavailable(
  depth?: SpotDepthResponse | null,
  fallback?: {
    source?: string | null;
    freshness?: string | null;
    status?: string | null;
  },
): boolean {
  return Boolean(
    depth?.stale ||
    isUnavailableDomainValue(depth?.source) ||
    isUnavailableDomainValue(depth?.freshness) ||
    isUnavailableDomainValue(fallback?.source) ||
    isUnavailableDomainValue(fallback?.freshness) ||
    isUnavailableDomainValue(fallback?.status),
  );
}

export function normalizeDepthForDisplay(
  depth?: SpotDepthResponse | null,
  fallback?: {
    source?: string | null;
    freshness?: string | null;
    status?: string | null;
  },
): SpotDepthResponse | null {
  const normalizedDepth = normalizeDepth(depth);
  if (!normalizedDepth) return null;

  const hasLevels = hasDepthLevels(normalizedDepth);
  const shouldClear = !hasLevels || isDepthDomainUnavailable(normalizedDepth, fallback);
  if (!shouldClear) {
    return normalizedDepth;
  }

  return {
    ...normalizedDepth,
    bids: [],
    asks: [],
    source: !hasLevels
      ? 'MISSING'
      : normalizeDomainValue(normalizedDepth.source || fallback?.source) || (normalizedDepth.stale ? 'STALE' : 'MISSING'),
    freshness: !hasLevels
      ? 'MISSING'
      : normalizeDomainValue(normalizedDepth.freshness || fallback?.freshness) || (normalizedDepth.stale ? 'STALE' : 'MISSING'),
    stale: Boolean(normalizedDepth.stale),
  };
}

function hasTickerData(view?: SpotMarketView | null): boolean {
  return Boolean(
    view?.ticker ||
    hasValue(view?.ticker_last_price) ||
    hasValue(view?.ticker_24h_change) ||
    hasValue(view?.ticker_24h_change_percent) ||
    hasValue(view?.ticker_24h_high) ||
    hasValue(view?.ticker_24h_low) ||
    hasValue(view?.ticker_volume) ||
    hasValue(view?.ticker_quote_volume),
  );
}

function sameSymbol(value: unknown, symbol: string): boolean {
  return normalizeSpotSymbol(String(value || '')) === symbol;
}

function buildTradesPayload(symbol: string, trades: SpotMarketTradeItem[]) {
  return {
    symbol,
    items: trades,
    trades,
  };
}

function firstPrice(levels?: SpotDepthLevel[] | null): string | number | null {
  const level = Array.isArray(levels)
    ? levels.find((item) => Number(item.price) > 0)
    : null;
  return level?.price ?? null;
}

function midpointPrice(
  bid?: string | number | null,
  ask?: string | number | null,
): string | number | null {
  const bidNumber = Number(bid);
  const askNumber = Number(ask);
  if (!Number.isFinite(bidNumber) || !Number.isFinite(askNumber) || bidNumber <= 0 || askNumber <= 0) {
    return null;
  }
  return (bidNumber + askNumber) / 2;
}

function spreadPrice(
  bid?: string | number | null,
  ask?: string | number | null,
): number | null {
  const bidNumber = Number(bid);
  const askNumber = Number(ask);
  if (!Number.isFinite(bidNumber) || !Number.isFinite(askNumber) || bidNumber <= 0 || askNumber <= 0) {
    return null;
  }
  return Math.max(0, askNumber - bidNumber);
}

function getDepthMidPrice(depth?: SpotDepthResponse | null): string | number | null {
  return depth?.mid_price ?? midpointPrice(firstPrice(depth?.bids), firstPrice(depth?.asks));
}

function getViewDisplayPrice(view?: SpotMarketView | null): string | number | null {
  return view?.display_price ?? view?.last_price ?? view?.ticker_last_price ?? view?.ticker?.last_price ?? null;
}

function getViewOrderbookMidPrice(
  view?: SpotMarketView | null,
  depth?: SpotDepthResponse | null,
): string | number | null {
  return view?.orderbook_mid_price ?? getDepthMidPrice(depth ?? view?.depth);
}

function normalizeDomainValue(value?: string | null): string | null {
  const text = String(value || '').trim();
  return text ? text.toUpperCase() : null;
}

function depthFreshness(depth?: SpotDepthResponse | null, fallback?: string | null): string | null {
  const explicit = normalizeDomainValue(depth?.freshness);
  if (explicit) return explicit;
  if (!depth) return normalizeDomainValue(fallback);
  if (depth.stale) return 'LAST_GOOD';
  if (normalizeDomainValue(depth.source) === 'LIVE_WS') return 'LIVE';
  return normalizeDomainValue(fallback) || 'RECENT';
}

function tradeFreshness(trades: SpotMarketTradeItem[], fallback?: string | null): string | null {
  if (fallback) return normalizeDomainValue(fallback);
  return trades.length > 0 ? 'RECENT' : 'MISSING';
}

function sourceFromDepth(depth?: SpotDepthResponse | null, fallback?: string | null): string | null {
  return normalizeDomainValue(depth?.source) || normalizeDomainValue(fallback);
}

function getViewLastTradePrice(view?: SpotMarketView | null): string | number | null {
  return view?.last_trade_price ?? null;
}

function getViewDirection(view?: SpotMarketView | null): RealtimePriceDirection {
  const direction = String(view?.price_direction || '').toLowerCase();
  if (direction === 'up' || direction === 'down') return direction;
  return 'flat';
}

function getTickerLastPrice(ticker?: SpotMarketTickerItem | null): string | number | null {
  return ticker?.last_price ?? ticker?.price ?? ticker?.last ?? ticker?.close ?? null;
}

function getNonEmptyText(value: unknown): string | null {
  const text = String(value ?? '').trim();
  return text ? text : null;
}

function getTradeIdentity(trade?: SpotMarketTradeItem | null): {
  tradeId: string | null;
  providerTradeId: string | null;
} {
  return {
    tradeId: getNonEmptyText(trade?.trade_id ?? trade?.id),
    providerTradeId: getNonEmptyText(trade?.provider_trade_id),
  };
}

function getTradeDedupKey(
  symbol: string,
  trade?: SpotMarketTradeItem | null,
  provider?: string | null,
): string | null {
  const { tradeId, providerTradeId } = getTradeIdentity(trade);
  const id = providerTradeId || tradeId;
  if (!id) return null;
  return `${symbol}:${String(provider || trade?.provider || '').trim().toUpperCase() || 'UNKNOWN'}:${id}`;
}

function isActiveLastTrade(state: SpotLastTradeState, symbol: string): boolean {
  return sameSymbol(state.symbol, symbol) && hasValue(state.price);
}

export function normalizeSpotMarketViewDepthDomain(view: SpotMarketView): SpotMarketView {
  const nextDepth = normalizeDepthForDisplay(view.depth, {
    source: view.depth_source,
    freshness: view.depth_freshness,
    status: view.depth_status,
  });
  const hasUsableDepth = hasDepthLevels(nextDepth) && !isDepthDomainUnavailable(nextDepth, {
    source: view.depth_source,
    freshness: view.depth_freshness,
    status: view.depth_status,
  });

  return {
    ...view,
    depth: nextDepth,
    best_bid: hasUsableDepth ? view.best_bid ?? firstPrice(nextDepth?.bids) : null,
    best_ask: hasUsableDepth ? view.best_ask ?? firstPrice(nextDepth?.asks) : null,
    orderbook_mid_price: hasUsableDepth ? view.orderbook_mid_price ?? getDepthMidPrice(nextDepth) : null,
    spread: hasUsableDepth ? view.spread : null,
    depth_status: hasUsableDepth ? 'ok' : 'missing',
    depth_source: sourceFromDepth(nextDepth, view.depth_source) || (hasUsableDepth ? view.depth_source : 'MISSING'),
    depth_freshness: depthFreshness(nextDepth, view.depth_freshness) || (hasUsableDepth ? view.depth_freshness : 'MISSING'),
  };
}

function hasUsableMarketState(
  view: SpotMarketView,
  depth: SpotDepthResponse | null,
  trades: SpotMarketTradeItem[],
): boolean {
  return Boolean(
    hasValue(getViewDisplayPrice(view)) ||
    hasDepthLevels(depth) ||
    trades.length > 0 ||
    hasTickerData(view),
  );
}

type SpotMarketDomainPayload = SpotDepthResponse | SpotMarketTickerItem | SpotMarketTradeItem[] | null;

const SPOT_MARKET_VIEW_DOMAIN_FIELDS: Record<SpotMarketDomain, readonly (keyof SpotMarketView)[]> = {
  depth: [
    'depth',
    'best_bid',
    'best_ask',
    'orderbook_mid_price',
    'spread',
    'depth_status',
    'depth_source',
    'depth_freshness',
    'executable',
  ],
  trades: [
    'trades',
    'last_trade_price',
    'trades_status',
    'trades_source',
    'trades_freshness',
  ],
  ticker: [
    'ticker',
    'ticker_last_price',
    'ticker_24h_change',
    'ticker_24h_change_percent',
    'ticker_24h_high',
    'ticker_24h_low',
    'ticker_volume',
    'ticker_quote_volume',
    'market_status',
    'data_source',
    'ticker_source',
    'ticker_freshness',
    'quote_freshness',
  ],
};

function getRecordText(value: unknown, key: string): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return getNonEmptyText((value as Record<string, unknown>)[key]);
}

function getViewSummaryText(view: SpotMarketView, key: string): string | null {
  return getRecordText(view.raw_source_summary, key);
}

function getLatestTrade(trades: SpotMarketTradeItem[]): SpotMarketTradeItem | null {
  let latestTrade: SpotMarketTradeItem | null = null;
  let latestTimeMs: number | null = null;

  for (const trade of trades) {
    const eventTimeMs = extractSpotTradeEventTimeMs(trade);
    if (!latestTrade || (eventTimeMs !== null && (latestTimeMs === null || eventTimeMs > latestTimeMs))) {
      latestTrade = trade;
      latestTimeMs = eventTimeMs;
    }
  }
  return latestTrade;
}

function createViewDomainEvent(
  view: SpotMarketView,
  symbol: string,
  domain: SpotMarketDomain,
  transport: SpotMarketDomainTransport,
  receivedAtMs: number,
): SpotMarketDomainEvent<SpotMarketDomainPayload> {
  if (domain === 'depth') {
    const nextDepth = normalizeDepthForDisplay(view.depth, {
      source: view.depth_source,
      freshness: view.depth_freshness,
      status: view.depth_status,
    });
    const hasDepth = hasDepthLevels(nextDepth);
    return {
      symbol,
      domain,
      provider: getRecordText(view.depth, 'provider') || getViewSummaryText(view, 'depth_provider'),
      eventTimeMs: extractSpotDepthEventTimeMs(view.depth),
      receivedAtMs,
      transport,
      source: sourceFromDepth(nextDepth, view.depth_source) || (hasDepth ? 'UNKNOWN' : 'MISSING'),
      freshness: depthFreshness(nextDepth, view.depth_freshness) || (hasDepth ? 'UNKNOWN' : 'MISSING'),
      data: nextDepth,
    };
  }

  if (domain === 'trades') {
    const nextTrades = normalizeTrades(view.trades);
    return {
      symbol,
      domain,
      provider: getRecordText(view.trades, 'provider') || getViewSummaryText(view, 'trades_provider'),
      eventTimeMs: extractSpotTradesEventTimeMs(nextTrades),
      receivedAtMs,
      transport,
      source: getRecordText(view.trades, 'source') || view.trades_source || (nextTrades.length ? 'UNKNOWN' : 'MISSING'),
      freshness: getRecordText(view.trades, 'freshness') || view.trades_freshness || (nextTrades.length ? 'RECENT' : 'MISSING'),
      data: nextTrades,
    };
  }

  const ticker = view.ticker || null;
  return {
    symbol,
    domain,
    provider: getRecordText(ticker, 'provider') || getViewSummaryText(view, 'ticker_provider'),
    eventTimeMs: extractSpotTickerEventTimeMs(ticker),
    receivedAtMs,
    transport,
    source: getRecordText(ticker, 'source') || view.ticker_source || (ticker ? 'UNKNOWN' : 'MISSING'),
    freshness: getRecordText(ticker, 'freshness') || view.ticker_freshness || view.quote_freshness || (ticker ? 'RECENT' : 'MISSING'),
    data: ticker,
  };
}

function updateRawSourceSummary(
  view: SpotMarketView,
  event: NormalizedSpotMarketDomainEvent<SpotMarketDomainPayload>,
): Record<string, unknown> {
  return {
    ...(view.raw_source_summary || {}),
    [`${event.domain}_source`]: event.source,
    [`${event.domain}_provider`]: event.provider,
    [`${event.domain}_freshness`]: event.freshness,
  };
}

export function applySpotMarketDomainEventToView(
  view: SpotMarketView,
  event: NormalizedSpotMarketDomainEvent<SpotMarketDomainPayload>,
): SpotMarketView {
  if (event.domain === 'depth') {
    const nextDepth = event.data as SpotDepthResponse | null;
    const nextHasDepth = hasDepthLevels(nextDepth);
    const nextBestBid = nextHasDepth ? firstPrice(nextDepth?.bids) : null;
    const nextBestAsk = nextHasDepth ? firstPrice(nextDepth?.asks) : null;
    return normalizeSpotMarketViewDepthDomain({
      ...view,
      depth: nextDepth,
      best_bid: nextBestBid,
      best_ask: nextBestAsk,
      orderbook_mid_price: nextHasDepth ? getDepthMidPrice(nextDepth) : null,
      spread: nextHasDepth ? spreadPrice(nextBestBid, nextBestAsk) : null,
      depth_status: nextHasDepth ? 'ok' : 'missing',
      depth_source: event.source,
      depth_freshness: event.freshness,
      executable: normalizeDomainValue(view.market_status) === 'OPEN' && nextHasDepth,
      raw_source_summary: updateRawSourceSummary(view, event),
    });
  }

  if (event.domain === 'trades') {
    const nextTrades = Array.isArray(event.data) ? event.data as SpotMarketTradeItem[] : [];
    const latestTrade = getLatestTrade(nextTrades);
    return {
      ...view,
      trades: buildTradesPayload(event.symbol, nextTrades),
      trades_status: nextTrades.length ? 'ok' : 'missing',
      trades_source: event.source,
      trades_freshness: event.freshness,
      ...(latestTrade ? {
        display_price: latestTrade.price,
        display_price_source: 'last_trade',
        last_price: latestTrade.price,
        last_trade_price: latestTrade.price,
      } : {}),
      raw_source_summary: updateRawSourceSummary(view, event),
    };
  }

  const ticker = event.data && !Array.isArray(event.data)
    ? event.data as SpotMarketTickerItem
    : null;
  const tickerLastPrice = getTickerLastPrice(ticker);
  return {
    ...view,
    ticker,
    ticker_last_price: tickerLastPrice ?? view.ticker_last_price,
    ticker_24h_change: ticker?.price_change_24h ?? view.ticker_24h_change,
    ticker_24h_change_percent: (
      ticker?.price_change_percent_24h ??
      ticker?.price_change_percent ??
      ticker?.change_24h ??
      view.ticker_24h_change_percent
    ),
    ticker_24h_high: ticker?.high_24h ?? view.ticker_24h_high,
    ticker_24h_low: ticker?.low_24h ?? view.ticker_24h_low,
    ticker_volume: ticker?.base_volume_24h ?? ticker?.volume_24h ?? view.ticker_volume,
    ticker_quote_volume: ticker?.quote_volume_24h ?? view.ticker_quote_volume,
    ...(tickerLastPrice !== null ? {
      display_price: tickerLastPrice,
      display_price_source: 'ticker',
      last_price: tickerLastPrice,
    } : {}),
    market_status: ticker?.market_status ?? view.market_status,
    ticker_source: event.source,
    ticker_freshness: event.freshness,
    quote_freshness: event.freshness,
    data_source: ticker?.data_source ?? view.data_source,
    raw_source_summary: updateRawSourceSummary(view, event),
  };
}

function protectActiveLastTrade(
  view: SpotMarketView,
  activeLastTrade: SpotLastTradeState,
  symbol: string,
): SpotMarketView {
  if (!isActiveLastTrade(activeLastTrade, symbol)) return view;

  return {
    ...view,
    display_price: activeLastTrade.price,
    display_price_source: 'last_trade',
    last_price: activeLastTrade.price,
    last_trade_price: activeLastTrade.price,
    price_direction: activeLastTrade.direction,
  };
}

function mergeIncomingMarketViewBase(
  previousView: SpotMarketView | null,
  incomingView: SpotMarketView,
  presentDomains: readonly SpotMarketDomain[],
): SpotMarketView {
  const nextView: SpotMarketView = {
    ...(previousView || { symbol: incomingView.symbol }),
    ...incomingView,
    raw_source_summary: {
      ...(previousView?.raw_source_summary || {}),
      ...(incomingView.raw_source_summary || {}),
    },
  };
  if (!previousView) return nextView;

  const mutableNextView = nextView as unknown as Record<string, unknown>;
  const previousRecord = previousView as unknown as Record<string, unknown>;
  for (const domain of ['ticker', 'depth', 'trades'] as const) {
    if (presentDomains.includes(domain)) continue;
    for (const field of SPOT_MARKET_VIEW_DOMAIN_FIELDS[domain]) {
      mutableNextView[field] = previousRecord[field];
    }

    const nextSummary = { ...(nextView.raw_source_summary || {}) };
    for (const key of Object.keys(nextSummary)) {
      if (key.startsWith(`${domain}_`)) delete nextSummary[key];
    }
    for (const [key, value] of Object.entries(previousView.raw_source_summary || {})) {
      if (key.startsWith(`${domain}_`)) nextSummary[key] = value;
    }
    nextView.raw_source_summary = nextSummary;
  }
  return nextView;
}

export function useSpotMarket(symbol: string): UseSpotMarketResult {
  const normalizedSymbol = useMemo(() => normalizeSpotSymbol(symbol), [symbol]);
  const [marketView, setMarketView] = useState<SpotMarketView | null>(null);
  const [depth, setDepth] = useState<SpotDepthResponse | null>(null);
  const [trades, setTrades] = useState<SpotMarketTradeItem[]>([]);
  const [lastPrice, setLastPrice] = useState<string | number | null>(null);
  const [priceDirection, setPriceDirection] = useState<RealtimePriceDirection>('flat');
  const [lastTradeState, setLastTradeState] = useState<SpotLastTradeState>(EMPTY_LAST_TRADE_STATE);
  const [isConnected, setIsConnected] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const lastPriceRef = useRef<string | number | null>(null);
  const priceDirectionRef = useRef<RealtimePriceDirection>('flat');
  const lastTradeStateRef = useRef<SpotLastTradeState>(EMPTY_LAST_TRADE_STATE);
  const seenTradeKeysRef = useRef<Set<string>>(new Set());
  const seenTradeKeyQueueRef = useRef<string[]>([]);
  const requestSeqRef = useRef(0);
  const activeSymbolRef = useRef(normalizedSymbol);
  const refreshInFlightRef = useRef(false);
  const refreshInFlightSeqRef = useRef(0);
  const refreshInFlightSymbolRef = useRef<string | null>(null);
  const lastRefreshStartedAtBySymbolRef = useRef<Record<string, number>>({});
  const domainSequenceStateRef = useRef<Map<
    string,
    SpotMarketDomainSequenceState<SpotMarketDomainPayload>
  >>(new Map());
  const mountedRef = useRef(false);

  const updateLastTradeState = useCallback((nextState: SpotLastTradeState) => {
    lastTradeStateRef.current = nextState;
    setLastTradeState(nextState);
  }, []);

  const rememberTradeKey = useCallback((key: string | null): boolean => {
    if (!key) return false;
    const seenKeys = seenTradeKeysRef.current;
    if (seenKeys.has(key)) return true;

    seenKeys.add(key);
    seenTradeKeyQueueRef.current.push(key);

    while (seenTradeKeyQueueRef.current.length > MAX_SEEN_TRADE_KEYS) {
      const staleKey = seenTradeKeyQueueRef.current.shift();
      if (staleKey) seenKeys.delete(staleKey);
    }

    return false;
  }, []);

  const sequenceDomainEvent = useCallback((
    incoming: SpotMarketDomainEvent<SpotMarketDomainPayload>,
  ): SpotMarketDomainSequenceDecision<SpotMarketDomainPayload> => {
    const key = getSpotMarketDomainHighWaterKey(incoming.symbol, incoming.domain);
    const decision = sequenceSpotMarketDomainEvent(
      domainSequenceStateRef.current.get(key),
      incoming,
    );
    if (decision.accepted) {
      domainSequenceStateRef.current.set(key, decision.state);
    }
    return decision;
  }, []);

  const getCurrentDomainEvent = useCallback((
    domain: SpotMarketDomain,
  ): NormalizedSpotMarketDomainEvent<SpotMarketDomainPayload> | null => {
    return domainSequenceStateRef.current.get(
      getSpotMarketDomainHighWaterKey(normalizedSymbol, domain),
    )?.current || null;
  }, [normalizedSymbol]);

  const applyView = useCallback((
    view: SpotMarketView,
    transport: Extract<SpotMarketDomainTransport, 'rest' | 'ws_snapshot'>,
  ) => {
    const presentDomains = getPresentSpotMarketDomains(view);
    const receivedAtMs = Date.now();
    const decisions = new Map<SpotMarketDomain, SpotMarketDomainSequenceDecision<SpotMarketDomainPayload>>();

    for (const domain of presentDomains) {
      decisions.set(domain, sequenceDomainEvent(createViewDomainEvent(
        view,
        normalizedSymbol,
        domain,
        transport,
        receivedAtMs,
      )));
    }

    const currentDomainEvents = {
      ticker: getCurrentDomainEvent('ticker'),
      depth: getCurrentDomainEvent('depth'),
      trades: getCurrentDomainEvent('trades'),
    };
    const currentEvents = (['ticker', 'depth', 'trades'] as const)
      .map((domain) => currentDomainEvents[domain])
      .filter((event): event is NormalizedSpotMarketDomainEvent<SpotMarketDomainPayload> => Boolean(event));
    const buildNextView = (previousView: SpotMarketView | null) => {
      let nextView = mergeIncomingMarketViewBase(previousView, view, presentDomains);
      for (const event of currentEvents) {
        nextView = applySpotMarketDomainEventToView(nextView, event);
      }
      return protectActiveLastTrade(nextView, lastTradeStateRef.current, normalizedSymbol);
    };
    const mergedView = buildNextView(null);

    if (currentDomainEvents.depth) {
      setDepth(currentDomainEvents.depth.data as SpotDepthResponse | null);
    }
    if (currentDomainEvents.trades) {
      setTrades(Array.isArray(currentDomainEvents.trades.data)
        ? currentDomainEvents.trades.data as SpotMarketTradeItem[]
        : []);
    }
    setMarketView((previousView) => buildNextView(previousView));

    const activeLastTrade = lastTradeStateRef.current;
    const hasActiveTrade = isActiveLastTrade(activeLastTrade, normalizedSymbol);
    const shouldUpdatePrice = (
      hasActiveTrade ||
      Boolean(decisions.get('trades')?.accepted) ||
      Boolean(decisions.get('ticker')?.accepted) ||
      lastPriceRef.current === null
    );
    if (shouldUpdatePrice) {
      const nextLastPrice = hasActiveTrade
        ? activeLastTrade.price
        : getViewLastTradePrice(mergedView) ?? getViewDisplayPrice(mergedView);
      const nextDirection = hasActiveTrade
        ? activeLastTrade.direction
        : getViewDirection(mergedView);
      setLastPrice(nextLastPrice);
      setPriceDirection(nextDirection);
      lastPriceRef.current = nextLastPrice;
      priceDirectionRef.current = nextDirection;
    }

    const allPresentDomainsAccepted = presentDomains.every((domain) => decisions.get(domain)?.accepted);
    if (
      presentDomains.length === 3 &&
      allPresentDomainsAccepted &&
      hasUsableMarketState(
        mergedView,
        mergedView.depth || null,
        normalizeTrades(mergedView.trades),
      )
    ) {
      writeMarketCache<SpotMarketCache>('spot', normalizedSymbol, {
        symbol: normalizedSymbol,
        marketView: mergedView,
        depth: mergedView.depth || null,
        trades: normalizeTrades(mergedView.trades),
        lastPrice: getViewLastTradePrice(mergedView) ?? getViewDisplayPrice(mergedView),
        priceDirection: getViewDirection(mergedView),
        updatedAt: receivedAtMs,
      });
    }
  }, [getCurrentDomainEvent, normalizedSymbol, sequenceDomainEvent]);

  const refresh = useCallback(async (options?: SpotMarketRefreshOptions) => {
    const requestSymbol = normalizedSymbol;
    if (!requestSymbol) return;
    if (activeSymbolRef.current !== requestSymbol) return;
    const forceRefresh = Boolean(options?.force);
    if (
      refreshInFlightRef.current &&
      refreshInFlightSymbolRef.current === requestSymbol
    ) {
      return;
    }
    const now = Date.now();
    const lastRefreshStartedAt = lastRefreshStartedAtBySymbolRef.current[requestSymbol] || 0;
    if (
      !forceRefresh &&
      lastRefreshStartedAt > 0 &&
      now - lastRefreshStartedAt < SPOT_VIEW_MIN_REFRESH_INTERVAL_MS
    ) {
      return;
    }

    const requestSeq = ++requestSeqRef.current;
    refreshInFlightRef.current = true;
    refreshInFlightSeqRef.current = requestSeq;
    refreshInFlightSymbolRef.current = requestSymbol;
    lastRefreshStartedAtBySymbolRef.current[requestSymbol] = now;
    const isLatestRequest = () =>
      mountedRef.current &&
      requestSeqRef.current === requestSeq &&
      activeSymbolRef.current === requestSymbol;

    try {
      setError(null);
      const view = await getSpotMarketView(requestSymbol);
      if (
        isLatestRequest() &&
        normalizeSpotSymbol(view.symbol || '') === requestSymbol
      ) {
        applyView(view, 'rest');
      }
    } catch (err) {
      if (!isLatestRequest()) return;

      const message = err instanceof Error ? err.message : 'Failed to load spot market view';
      setError(message);
    } finally {
      if (refreshInFlightSeqRef.current === requestSeq) {
        refreshInFlightRef.current = false;
        refreshInFlightSeqRef.current = 0;
        refreshInFlightSymbolRef.current = null;
      }

      if (isLatestRequest()) {
        setIsLoading(false);
      }
    }
  }, [applyView, normalizedSymbol]);

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    requestSeqRef.current += 1;
    refreshInFlightRef.current = false;
    refreshInFlightSeqRef.current = 0;
    refreshInFlightSymbolRef.current = null;
    activeSymbolRef.current = normalizedSymbol;
    setMarketView(null);
    setDepth(null);
    setTrades([]);
    setLastPrice(null);
    setPriceDirection('flat');
    updateLastTradeState(EMPTY_LAST_TRADE_STATE);
    seenTradeKeysRef.current.clear();
    seenTradeKeyQueueRef.current = [];
    lastPriceRef.current = null;
    priceDirectionRef.current = 'flat';
    setError(null);
    setIsLoading(true);
  }, [normalizedSymbol, updateLastTradeState]);

  useEffect(() => {
    void refresh({ force: true });
  }, [refresh]);

  useEffect(() => {
    if (!normalizedSymbol) {
      setIsConnected(false);
      return undefined;
    }

    const subscriptionId = spotMarketRealtime.acquireSubscription({
      symbol: normalizedSymbol,
      domains: ['snapshot', 'depth', 'trades', 'ticker'],
      owner: 'useSpotMarket',
    });
    const unsubscribeStatus = spotMarketRealtime.subscribeStatus((status) => {
      setIsConnected(status === 'open');
    });

    const handleSnapshot = (message: SpotMarketRealtimeMessage) => {
      const snapshot = message as SpotMarketSnapshotMessage;
      const msgSymbol = normalizeSpotSymbol(snapshot.symbol || snapshot.market_view?.symbol || '');
      if (msgSymbol !== normalizedSymbol) return;

      if (snapshot.market_view) {
        applyView(snapshot.market_view, 'ws_snapshot');
        setIsLoading(false);
        return;
      }

      const presentDomains = getPresentSpotMarketDomains(snapshot);
      const hasDepthPayload = presentDomains.includes('depth');
      const hasTradesPayload = presentDomains.includes('trades');
      const hasTickerPayload = presentDomains.includes('ticker');
      const receivedAtMs = Date.now();

      if (hasDepthPayload) {
        const nextDepth = normalizeDepthForDisplay(snapshot.depth);
        const nextHasDepth = hasDepthLevels(nextDepth);
        const nextDepthSource = sourceFromDepth(nextDepth) ?? (nextHasDepth ? null : 'MISSING');
        const nextDepthFreshness = depthFreshness(nextDepth) ?? (nextHasDepth ? null : 'MISSING');
        const decision = sequenceDomainEvent({
          symbol: normalizedSymbol,
          domain: 'depth',
          provider: getRecordText(snapshot.depth, 'provider'),
          eventTimeMs: extractSpotDepthEventTimeMs(snapshot.depth),
          receivedAtMs,
          transport: 'ws_snapshot',
          source: nextDepthSource,
          freshness: nextDepthFreshness,
          data: nextDepth,
        });
        if (decision.accepted && decision.state.current) {
          setDepth(nextDepth);
          const acceptedEvent = decision.state.current;
          setMarketView((prev) => prev
            ? protectActiveLastTrade(
                applySpotMarketDomainEventToView(prev, acceptedEvent),
                lastTradeStateRef.current,
                normalizedSymbol,
              )
            : prev);
        }
      }

      if (hasTradesPayload) {
        const nextTrades = normalizeTrades(snapshot.trades);
        const decision = sequenceDomainEvent({
          symbol: normalizedSymbol,
          domain: 'trades',
          provider: getRecordText(snapshot.trades, 'provider'),
          eventTimeMs: extractSpotTradesEventTimeMs(nextTrades),
          receivedAtMs,
          transport: 'ws_snapshot',
          source: getRecordText(snapshot.trades, 'source') || (nextTrades.length ? 'UNKNOWN' : 'MISSING'),
          freshness: getRecordText(snapshot.trades, 'freshness') || (nextTrades.length ? 'RECENT' : 'MISSING'),
          data: nextTrades,
        });
        if (decision.accepted && decision.state.current) {
          setTrades(nextTrades);
          const acceptedEvent = decision.state.current;
          setMarketView((prev) => prev
            ? protectActiveLastTrade(
                applySpotMarketDomainEventToView(prev, acceptedEvent),
                lastTradeStateRef.current,
                normalizedSymbol,
              )
            : prev);
        }
      }

      if (hasTickerPayload) {
        const ticker = snapshot.ticker || null;
        const tickerLastPrice = getTickerLastPrice(ticker);
        const hasActiveTrade = isActiveLastTrade(lastTradeStateRef.current, normalizedSymbol);
        const decision = sequenceDomainEvent({
          symbol: normalizedSymbol,
          domain: 'ticker',
          provider: getRecordText(ticker, 'provider'),
          eventTimeMs: extractSpotTickerEventTimeMs(ticker),
          receivedAtMs,
          transport: 'ws_snapshot',
          source: getRecordText(ticker, 'source') || (ticker ? 'UNKNOWN' : 'MISSING'),
          freshness: getRecordText(ticker, 'freshness') || getRecordText(ticker, 'quote_freshness') || (ticker ? 'RECENT' : 'MISSING'),
          data: ticker,
        });
        if (decision.accepted && decision.state.current) {
          const acceptedEvent = decision.state.current;
          setMarketView((prev) => prev
            ? protectActiveLastTrade(
                applySpotMarketDomainEventToView(prev, acceptedEvent),
                lastTradeStateRef.current,
                normalizedSymbol,
              )
            : prev);
          if (tickerLastPrice !== null && !hasActiveTrade) {
            setLastPrice(tickerLastPrice);
            lastPriceRef.current = tickerLastPrice;
          }
        }
      }
      setIsLoading(false);
    };

    const handleDepth = (message: SpotMarketRealtimeMessage) => {
      const data = message as SpotDepthMessage;
      const msgSymbol = normalizeSpotSymbol(data.symbol || data.depth?.symbol || '');
      if (msgSymbol !== normalizedSymbol) return;

      const nextDepth = normalizeDepthForDisplay(data.depth);
      const nextHasDepth = hasDepthLevels(nextDepth);
      const nextDepthFreshness = depthFreshness(nextDepth);
      const nextDepthSource = sourceFromDepth(nextDepth);
      const decision = sequenceDomainEvent({
        symbol: normalizedSymbol,
        domain: 'depth',
        provider: getRecordText(data.depth, 'provider'),
        eventTimeMs: extractSpotDepthEventTimeMs(data.depth),
        receivedAtMs: Date.now(),
        transport: 'ws_incremental',
        source: nextDepthSource || (nextHasDepth ? 'LIVE_WS' : 'MISSING'),
        freshness: nextDepthFreshness || (nextHasDepth ? 'LIVE' : 'MISSING'),
        data: nextDepth,
      });
      if (!decision.accepted || !decision.state.current) return;

      setDepth(nextDepth);
      const acceptedEvent = decision.state.current;
      setMarketView((prev) => prev
        ? protectActiveLastTrade(
            applySpotMarketDomainEventToView(prev, acceptedEvent),
            lastTradeStateRef.current,
            normalizedSymbol,
          )
        : prev);
    };

    const handleTrade = (message: SpotMarketRealtimeMessage) => {
      const data = message as SpotTradeMessage;
      const msgSymbol = normalizeSpotSymbol(data.symbol || '');
      if (msgSymbol !== normalizedSymbol || !data.trade) return;

      const trade = data.trade;
      const tradeProvider = trade.provider || data.provider;
      const tradeKey = getTradeDedupKey(normalizedSymbol, trade, tradeProvider);
      if (tradeKey && seenTradeKeysRef.current.has(tradeKey)) return;

      const currentTradesEvent = getCurrentDomainEvent('trades');
      const normalizedTradeProvider = normalizeDomainValue(tradeProvider) || 'UNKNOWN';
      const currentRows = (
        currentTradesEvent &&
        (
          currentTradesEvent.provider === normalizedTradeProvider ||
          currentTradesEvent.provider === 'UNKNOWN' ||
          normalizedTradeProvider === 'UNKNOWN'
        ) &&
        Array.isArray(currentTradesEvent.data)
      )
        ? currentTradesEvent.data as SpotMarketTradeItem[]
        : [];
      const nextRows = (tradeKey
        ? [
            trade,
            ...currentRows.filter((item) => (
              getTradeDedupKey(normalizedSymbol, item, item.provider || tradeProvider) !== tradeKey
            )),
          ]
        : [trade, ...currentRows]).slice(0, 30);
      const eventTimeMs = extractSpotTradeEventTimeMs(trade);
      const tradeSource = normalizeDomainValue(trade.source || data.source) || 'LIVE_WS';
      const nextTradeFreshness = normalizeDomainValue(trade.freshness || data.freshness) || 'LIVE';
      const decision = sequenceDomainEvent({
        symbol: normalizedSymbol,
        domain: 'trades',
        provider: tradeProvider,
        eventTimeMs,
        receivedAtMs: Date.now(),
        transport: 'ws_incremental',
        source: tradeSource,
        freshness: nextTradeFreshness,
        data: nextRows,
      });
      if (!decision.accepted || !decision.state.current) return;
      rememberTradeKey(tradeKey);
      setTrades(nextRows);

      const nextDirection = getRealtimePriceDirection(
        trade.price,
        lastPriceRef.current,
        priceDirectionRef.current,
      );
      const { tradeId, providerTradeId } = getTradeIdentity(trade);
      const nextLastTradeState: SpotLastTradeState = {
        price: trade.price,
        at: eventTimeMs,
        direction: nextDirection,
        symbol: normalizedSymbol,
        tradeId,
        providerTradeId,
      };
      lastPriceRef.current = trade.price;
      priceDirectionRef.current = nextDirection;
      updateLastTradeState(nextLastTradeState);
      setLastPrice(trade.price);
      setPriceDirection(nextDirection);
      const acceptedEvent = decision.state.current;
      setMarketView((prev) => {
        if (!prev) return prev;
        const nextView = applySpotMarketDomainEventToView(prev, acceptedEvent);
        return protectActiveLastTrade(
          { ...nextView, price_direction: nextDirection },
          nextLastTradeState,
          normalizedSymbol,
        );
      });
    };

    const handleTicker = (message: SpotMarketRealtimeMessage) => {
      const data = message as SpotTickerMessage;
      const msgSymbol = normalizeSpotSymbol(data.symbol || data.ticker?.symbol || '');
      if (msgSymbol !== normalizedSymbol || !data.ticker) return;

      const ticker = data.ticker;
      const tickerLastPrice = getTickerLastPrice(ticker);
      const hasActiveTrade = isActiveLastTrade(lastTradeStateRef.current, normalizedSymbol);
      const tickerSource = normalizeDomainValue(ticker.source) || 'LIVE_WS';
      const tickerFreshness = normalizeDomainValue(ticker.freshness || ticker.quote_freshness) || 'LIVE';
      const decision = sequenceDomainEvent({
        symbol: normalizedSymbol,
        domain: 'ticker',
        provider: getRecordText(ticker, 'provider'),
        eventTimeMs: extractSpotTickerEventTimeMs(ticker),
        receivedAtMs: Date.now(),
        transport: 'ws_incremental',
        source: tickerSource,
        freshness: tickerFreshness,
        data: ticker,
      });
      if (!decision.accepted || !decision.state.current) return;

      const nextDirection = tickerLastPrice !== null
        ? getRealtimePriceDirection(
            tickerLastPrice,
            lastPriceRef.current,
            priceDirectionRef.current,
          )
        : priceDirectionRef.current;
      if (tickerLastPrice !== null && !hasActiveTrade) {
        lastPriceRef.current = tickerLastPrice;
        priceDirectionRef.current = nextDirection;
        setLastPrice(tickerLastPrice);
        setPriceDirection(nextDirection);
      }
      const acceptedEvent = decision.state.current;
      setMarketView((prev) => {
        if (!prev) return prev;
        const nextView = applySpotMarketDomainEventToView(prev, acceptedEvent);
        return protectActiveLastTrade(
          !hasActiveTrade && tickerLastPrice !== null
            ? { ...nextView, price_direction: nextDirection }
            : nextView,
          lastTradeStateRef.current,
          normalizedSymbol,
        );
      });
    };

    const unsubscribeSnapshot = spotMarketRealtime.subscribe('snapshot', handleSnapshot);
    const unsubscribeDepth = spotMarketRealtime.subscribe('depth', handleDepth);
    const unsubscribeTrade = spotMarketRealtime.subscribe('trade', handleTrade);
    const unsubscribeTicker = spotMarketRealtime.subscribe('ticker', handleTicker);

    return () => {
      unsubscribeSnapshot();
      unsubscribeDepth();
      unsubscribeTrade();
      unsubscribeTicker();
      unsubscribeStatus();
      spotMarketRealtime.releaseSubscription(subscriptionId);
    };
  }, [
    applyView,
    getCurrentDomainEvent,
    normalizedSymbol,
    rememberTradeKey,
    sequenceDomainEvent,
    updateLastTradeState,
  ]);

  useEffect(() => {
    if (!normalizedSymbol) {
      return undefined;
    }

    let stopped = false;
    let timer: number | null = null;

    const getPollDelayMs = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        return SPOT_VIEW_HIDDEN_POLL_MS;
      }
      return SPOT_VIEW_FOREGROUND_POLL_MS;
    };

    const clearTimer = () => {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
    };

    const scheduleNextRefresh = () => {
      clearTimer();
      timer = window.setTimeout(() => {
        if (stopped) return;
        void refresh();
        scheduleNextRefresh();
      }, getPollDelayMs());
    };

    const handleVisibilityChange = () => {
      if (stopped) return;
      clearTimer();
      if (document.visibilityState === 'visible') {
        void refresh({ force: true });
      }
      scheduleNextRefresh();
    };

    scheduleNextRefresh();
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      stopped = true;
      clearTimer();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [normalizedSymbol, refresh]);

  const hasUsableDepth = hasDepthLevels(depth) && !isDepthDomainUnavailable(depth, {
    source: marketView?.depth_source,
    freshness: marketView?.depth_freshness,
    status: marketView?.depth_status,
  });
  const bestBid = hasUsableDepth ? marketView?.best_bid ?? firstPrice(depth?.bids) : null;
  const bestAsk = hasUsableDepth ? marketView?.best_ask ?? firstPrice(depth?.asks) : null;
  const orderbookMidPrice = hasUsableDepth ? getViewOrderbookMidPrice(marketView, depth) : null;
  const hasActiveTrade = isActiveLastTrade(lastTradeState, normalizedSymbol);
  const viewLastTradePrice = getViewLastTradePrice(marketView);
  const displayPrice = hasActiveTrade
    ? lastTradeState.price
    : viewLastTradePrice ?? getViewDisplayPrice(marketView) ?? lastPrice;
  const lastTradePrice = hasActiveTrade ? lastTradeState.price : viewLastTradePrice;
  const outputPriceDirection = hasActiveTrade ? lastTradeState.direction : priceDirection;
  const ticker = marketView?.ticker ?? null;
  const freshness: SpotMarketFreshnessMap = {
    depth: normalizeDomainValue(marketView?.depth_freshness) || depthFreshness(depth),
    trades: normalizeDomainValue(marketView?.trades_freshness) || tradeFreshness(trades),
    ticker: normalizeDomainValue(marketView?.ticker_freshness || marketView?.quote_freshness),
    kline: normalizeDomainValue(marketView?.kline_freshness),
  };
  const sources: SpotMarketSourceMap = {
    depth: normalizeDomainValue(marketView?.depth_source) || sourceFromDepth(depth),
    trades: normalizeDomainValue(marketView?.trades_source),
    ticker: normalizeDomainValue(marketView?.ticker_source),
    kline: normalizeDomainValue(marketView?.kline_source),
  };

  return {
    symbol: normalizedSymbol,
    marketView,
    depth,
    trades,
    ticker,
    klineStatus: marketView?.kline_status ?? null,
    displayPrice,
    displayPriceSource: marketView?.display_price_source ?? null,
    lastTradePrice,
    lastTradeAt: hasActiveTrade ? lastTradeState.at : null,
    lastTradeDirection: hasActiveTrade ? lastTradeState.direction : outputPriceDirection,
    lastTradeSymbol: hasActiveTrade ? lastTradeState.symbol : null,
    lastTradeId: hasActiveTrade ? lastTradeState.tradeId : null,
    providerTradeId: hasActiveTrade ? lastTradeState.providerTradeId : null,
    orderbookMidPrice,
    lastPrice,
    priceDirection: outputPriceDirection,
    bestBid,
    bestAsk,
    freshness,
    sources,
    isConnected,
    isLoading,
    error,
    refresh,
  };
}
