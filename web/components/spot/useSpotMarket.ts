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
  type SpotMarketConnectionStatus,
  type SpotMarketRealtimeMessage,
} from '@/services/marketRealtime';
import {
  getRealtimePriceDirection,
  type RealtimePriceDirection,
} from './spotTickerColor';
import {
  selectSpotDisplayPrice,
  type SpotDisplayPrice,
  type SpotDisplayPriceCandidate,
  type SpotNativeCandleDisplayPrice,
} from './spotDisplayPrice';
import {
  extractSpotDepthEventTimeMs,
  extractSpotTickerEventTimeMs,
  extractSpotTradeEventTimeMs,
  extractSpotTradesEventTimeMs,
  getPresentSpotMarketDomains,
  type NormalizedSpotMarketDomainEvent,
  type SpotMarketDomain,
  type SpotMarketDomainEvent,
  type SpotMarketDomainTransport,
} from './spotMarketDomainSequencer';
import {
  applySpotTradeReceivedAtMs,
  getLatestSpotTradeRow,
  getSpotTradeReceivedAtMs,
  limitSpotTradeRows,
  resolveSpotTradeBatchReceivedAtMs,
} from './spotTradeRows';
import { resolveSpotMarketHydration } from './spotMarketHydration';
import {
  createSpotTickerStoreSnapshot,
  tickerSnapshotToDomainEvent,
  useSpotTickerStoreSlot,
} from './spotTickerStoreAdapter';
import {
  createSpotDepthStoreSnapshot,
  depthSnapshotToDomainEvent,
  useSpotDepthStoreSlot,
} from './spotDepthStoreAdapter';
import {
  getSpotTradesCollectionMetadata,
  ingestSpotTradesStoreEvent,
  tradesSnapshotToDomainEvent,
  useSpotTradesStoreSlot,
} from './spotTradesStoreAdapter';
import { spotPublicMarketStore } from '@/lib/realtime/spotMarketStore';

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
  displayPrice: SpotDisplayPrice;
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
  isHydrating: boolean;
  error: string | null;
  refresh: () => Promise<void>;
};

type UseSpotMarketOptions = {
  nativeCandle?: SpotNativeCandleDisplayPrice | null;
};

const SPOT_VIEW_FOREGROUND_POLL_MS = 10000;
const SPOT_VIEW_HIDDEN_POLL_MS = 30000;
const SPOT_VIEW_MIN_REFRESH_INTERVAL_MS = 2000;
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
  symbol = '',
  fallbackProvider?: string | null,
  fallbackProviderSymbol?: string | null,
): SpotMarketTradeItem[] {
  if (!trades) return [];
  return limitSpotTradeRows(normalizeSpotTrades({
    symbol: trades.symbol || '',
    items: trades.items,
    trades: trades.trades,
  }), {
    symbol: symbol || trades.symbol || '',
    provider: fallbackProvider || getRecordText(trades, 'provider'),
    providerSymbol: fallbackProviderSymbol || getRecordText(trades, 'provider_symbol'),
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

function normalizeSpotMarketIdentity(value: unknown): string {
  return normalizeSpotSymbol(String(value || '')).replace(/[^A-Z0-9]/g, '');
}

function sameSymbol(value: unknown, symbol: string): boolean {
  const eventIdentity = normalizeSpotMarketIdentity(value);
  const activeIdentity = normalizeSpotMarketIdentity(symbol);
  return Boolean(eventIdentity && activeIdentity && eventIdentity === activeIdentity);
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

function getLatestTrade(
  trades: SpotMarketTradeItem[],
  symbol = '',
  provider?: string | null,
): SpotMarketTradeItem | null {
  return getLatestSpotTradeRow(trades, { symbol, provider });
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
    const provider = getRecordText(view.trades, 'provider') || getViewSummaryText(view, 'trades_provider');
    const providerSymbol = getRecordText(view.trades, 'provider_symbol');
    const normalizedTrades = normalizeTrades(view.trades, symbol, provider, providerSymbol);
    const tradeReceivedAtMs = resolveSpotTradeBatchReceivedAtMs(
      view.trades,
      normalizedTrades,
      receivedAtMs,
    );
    const nextTrades = applySpotTradeReceivedAtMs(normalizedTrades, tradeReceivedAtMs);
    return {
      symbol,
      domain,
      provider,
      eventTimeMs: extractSpotTradesEventTimeMs(nextTrades),
      receivedAtMs: tradeReceivedAtMs,
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
    const latestTrade = getLatestTrade(nextTrades, event.symbol, event.provider);
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

function protectAuthoritativeTrade(
  view: SpotMarketView,
  trade: SpotMarketTradeItem | null,
): SpotMarketView {
  if (!trade || !hasValue(trade.price)) return view;
  return {
    ...view,
    display_price: trade.price,
    display_price_source: 'last_trade',
    last_price: trade.price,
    last_trade_price: trade.price,
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

export function useSpotMarket(
  symbol: string,
  { nativeCandle = null }: UseSpotMarketOptions = {},
): UseSpotMarketResult {
  const normalizedSymbol = useMemo(() => normalizeSpotSymbol(symbol), [symbol]);
  const tickerStoreSlot = useSpotTickerStoreSlot(normalizedSymbol);
  const tickerStoreEvent = useMemo(
    () => tickerSnapshotToDomainEvent(tickerStoreSlot?.snapshot),
    [tickerStoreSlot?.snapshot],
  );
  const depthStoreSlot = useSpotDepthStoreSlot(normalizedSymbol);
  const depthStoreEvent = useMemo(() => {
    const event = depthSnapshotToDomainEvent(depthStoreSlot?.snapshot);
    if (!event) return null;
    return {
      ...event,
      data: normalizeDepthForDisplay(event.data, {
        source: event.source,
        freshness: event.freshness,
      }),
    };
  }, [depthStoreSlot?.snapshot]);
  const tradesStoreSlot = useSpotTradesStoreSlot(normalizedSymbol);
  const tradesStoreEvent = useMemo(
    () => tradesSnapshotToDomainEvent(tradesStoreSlot?.snapshot),
    [tradesStoreSlot?.snapshot],
  );
  const [marketView, setMarketView] = useState<SpotMarketView | null>(null);
  const [lastPrice, setLastPrice] = useState<string | number | null>(null);
  const [priceDirection, setPriceDirection] = useState<RealtimePriceDirection>('flat');
  const [lastTradeState, setLastTradeState] = useState<SpotLastTradeState>(EMPTY_LAST_TRADE_STATE);
  const [isConnected, setIsConnected] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<SpotMarketConnectionStatus>('connecting');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const lastPriceRef = useRef<string | number | null>(null);
  const priceDirectionRef = useRef<RealtimePriceDirection>('flat');
  const lastTradeStateRef = useRef<SpotLastTradeState>(EMPTY_LAST_TRADE_STATE);
  const requestSeqRef = useRef(0);
  const activeSymbolRef = useRef(normalizedSymbol);
  const refreshInFlightRef = useRef(false);
  const refreshInFlightSeqRef = useRef(0);
  const refreshInFlightSymbolRef = useRef<string | null>(null);
  const lastRefreshStartedAtBySymbolRef = useRef<Record<string, number>>({});
  const mountedRef = useRef(false);

  const updateLastTradeState = useCallback((nextState: SpotLastTradeState) => {
    lastTradeStateRef.current = nextState;
    setLastTradeState(nextState);
  }, []);

  const applyView = useCallback((
    view: SpotMarketView,
    transport: Extract<SpotMarketDomainTransport, 'rest' | 'ws_snapshot'>,
  ) => {
    const presentDomains = getPresentSpotMarketDomains(view);
    const receivedAtMs = Date.now();
    const storeSymbol = normalizeSpotMarketIdentity(normalizedSymbol);
    let tickerAccepted = !presentDomains.includes('ticker');
    let depthAccepted = !presentDomains.includes('depth');
    let tradesAccepted = !presentDomains.includes('trades');

    if (presentDomains.includes('ticker')) {
      const tickerEvent = createViewDomainEvent(
        view,
        normalizedSymbol,
        'ticker',
        transport,
        receivedAtMs,
      ) as SpotMarketDomainEvent<SpotMarketTickerItem | null>;
      const tickerSnapshot = createSpotTickerStoreSnapshot(tickerEvent);
      spotPublicMarketStore.ingestTicker(tickerSnapshot);
      const authoritativeTickerSnapshot = spotPublicMarketStore
        .getState()
        .symbols[storeSymbol]
        ?.ticker.snapshot;
      tickerAccepted = (
        authoritativeTickerSnapshot?.snapshot_id === tickerSnapshot.snapshot_id
        || authoritativeTickerSnapshot?.data === tickerSnapshot.data
      );
    }

    if (presentDomains.includes('depth')) {
      const depthEvent = createViewDomainEvent(
        view,
        normalizedSymbol,
        'depth',
        transport,
        receivedAtMs,
      ) as SpotMarketDomainEvent<SpotDepthResponse | null>;
      const depthSnapshot = createSpotDepthStoreSnapshot(depthEvent);
      spotPublicMarketStore.ingestDepth(depthSnapshot);
      const authoritativeDepthSnapshot = spotPublicMarketStore
        .getState()
        .symbols[storeSymbol]
        ?.depth.snapshot;
      depthAccepted = (
        authoritativeDepthSnapshot?.snapshot_id === depthSnapshot.snapshot_id
        || authoritativeDepthSnapshot?.data === depthSnapshot.data
      );
    }

    if (presentDomains.includes('trades')) {
      const tradesEvent = createViewDomainEvent(
        view,
        normalizedSymbol,
        'trades',
        transport,
        receivedAtMs,
      ) as SpotMarketDomainEvent<SpotMarketTradeItem[]>;
      const result = ingestSpotTradesStoreEvent(
        spotPublicMarketStore,
        tradesEvent,
        { providerSymbol: getRecordText(view.trades, 'provider_symbol') },
      );
      tradesAccepted = result.authorityAccepted;
    }

    const currentDomainEvents = {
      ticker: tickerSnapshotToDomainEvent(
        spotPublicMarketStore.getState().symbols[storeSymbol]?.ticker.snapshot,
      ),
      depth: depthSnapshotToDomainEvent(
        spotPublicMarketStore.getState().symbols[storeSymbol]?.depth.snapshot,
      ),
      trades: tradesSnapshotToDomainEvent(
        spotPublicMarketStore.getState().symbols[storeSymbol]?.trades.snapshot,
      ),
    };
    const currentEvents: NormalizedSpotMarketDomainEvent<SpotMarketDomainPayload>[] = [];
    for (const domain of ['ticker', 'depth', 'trades'] as const) {
      const event = currentDomainEvents[domain];
      if (event) {
        currentEvents.push(event as NormalizedSpotMarketDomainEvent<SpotMarketDomainPayload>);
      }
    }
    const currentTradesMetadata = getSpotTradesCollectionMetadata(
      spotPublicMarketStore.getState().symbols[storeSymbol]?.trades.snapshot,
    );
    const buildNextView = (previousView: SpotMarketView | null) => {
      let nextView = mergeIncomingMarketViewBase(previousView, view, presentDomains);
      for (const event of currentEvents) {
        nextView = applySpotMarketDomainEventToView(nextView, event);
      }
      const currentTrades = currentDomainEvents.trades?.data ?? [];
      nextView = protectAuthoritativeTrade(
        nextView,
        currentTradesMetadata?.authorityTrade
          ?? getLatestSpotTradeRow(currentTrades, {
            symbol: normalizedSymbol,
            provider: currentDomainEvents.trades?.provider,
          }),
      );
      return protectActiveLastTrade(nextView, lastTradeStateRef.current, normalizedSymbol);
    };
    const mergedView = buildNextView(null);

    setMarketView((previousView) => buildNextView(previousView));

    const activeLastTrade = lastTradeStateRef.current;
    const hasActiveTrade = isActiveLastTrade(activeLastTrade, normalizedSymbol);
    const shouldUpdatePrice = (
      hasActiveTrade ||
      tradesAccepted ||
      tickerAccepted ||
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

    const allPresentDomainsAccepted = presentDomains.every((domain) => (
      domain === 'ticker'
        ? tickerAccepted
        : domain === 'depth'
          ? depthAccepted
          : tradesAccepted
    ));
    const currentTradeRows = currentDomainEvents.trades?.data ?? [];
    if (
      presentDomains.length === 3 &&
      allPresentDomainsAccepted &&
      hasUsableMarketState(
        mergedView,
        mergedView.depth || null,
        currentTradeRows,
      )
    ) {
      writeMarketCache<SpotMarketCache>('spot', normalizedSymbol, {
        symbol: normalizedSymbol,
        marketView: mergedView,
        depth: mergedView.depth || null,
        trades: currentTradeRows,
        lastPrice: getViewLastTradePrice(mergedView) ?? getViewDisplayPrice(mergedView),
        priceDirection: getViewDirection(mergedView),
        updatedAt: receivedAtMs,
      });
    }
  }, [normalizedSymbol]);

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
    setLastPrice(null);
    setPriceDirection('flat');
    updateLastTradeState(EMPTY_LAST_TRADE_STATE);
    lastPriceRef.current = null;
    priceDirectionRef.current = 'flat';
    setError(null);
    setConnectionStatus('connecting');
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
    let connectionAttemptStarted = false;
    const unsubscribeStatus = spotMarketRealtime.subscribeStatus((status) => {
      if (status === 'connecting' || status === 'open') {
        connectionAttemptStarted = true;
      }
      if (status === 'closed' && !connectionAttemptStarted) {
        setIsConnected(false);
        setConnectionStatus('connecting');
        return;
      }
      setIsConnected(status === 'open');
      setConnectionStatus(status);
    });

    const handleSnapshot = (message: SpotMarketRealtimeMessage) => {
      const snapshot = message as SpotMarketSnapshotMessage;
      const msgSymbol = normalizeSpotSymbol(snapshot.symbol || snapshot.market_view?.symbol || '');
      if (!sameSymbol(msgSymbol, normalizedSymbol)) return;

      if (snapshot.market_view) {
        applyView(snapshot.market_view, 'ws_snapshot');
        setIsLoading(false);
        return;
      }

      setIsLoading(false);
    };

    const unsubscribeSnapshot = spotMarketRealtime.subscribe('snapshot', handleSnapshot);

    return () => {
      unsubscribeSnapshot();
      unsubscribeStatus();
      spotMarketRealtime.releaseSubscription(subscriptionId);
    };
  }, [
    applyView,
    normalizedSymbol,
  ]);

  useEffect(() => {
    if (!tickerStoreEvent || !sameSymbol(tickerStoreEvent.symbol, normalizedSymbol)) return;

    const ticker = tickerStoreEvent.data;
    const tickerLastPrice = getTickerLastPrice(ticker);
    const hasActiveTrade = isActiveLastTrade(lastTradeStateRef.current, normalizedSymbol);
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

    setMarketView((previousView) => {
      if (!previousView) return previousView;
      const nextView = applySpotMarketDomainEventToView(previousView, tickerStoreEvent);
      return protectActiveLastTrade(
        !hasActiveTrade && tickerLastPrice !== null
          ? { ...nextView, price_direction: nextDirection }
          : nextView,
        lastTradeStateRef.current,
        normalizedSymbol,
      );
    });
  }, [normalizedSymbol, tickerStoreEvent]);

  useEffect(() => {
    if (!depthStoreEvent || !sameSymbol(depthStoreEvent.symbol, normalizedSymbol)) return;

    setMarketView((previousView) => {
      if (!previousView) return previousView;
      return protectActiveLastTrade(
        applySpotMarketDomainEventToView(previousView, depthStoreEvent),
        lastTradeStateRef.current,
        normalizedSymbol,
      );
    });
  }, [depthStoreEvent, normalizedSymbol]);

  useEffect(() => {
    if (!tradesStoreEvent || !sameSymbol(tradesStoreEvent.symbol, normalizedSymbol)) return;

    const collectionMetadata = getSpotTradesCollectionMetadata(tradesStoreSlot?.snapshot);
    const authorityTrade = collectionMetadata?.authorityTrade;
    let activeTradeState = lastTradeStateRef.current;

    if (collectionMetadata?.action === 'replace') {
      lastPriceRef.current = null;
      priceDirectionRef.current = 'flat';
      activeTradeState = EMPTY_LAST_TRADE_STATE;
      updateLastTradeState(activeTradeState);
      setLastPrice(null);
      setPriceDirection('flat');
    }

    if (collectionMetadata?.applyAuthoritySideEffects && authorityTrade) {
      const eventTimeMs = extractSpotTradeEventTimeMs(authorityTrade);
      const nextDirection = getRealtimePriceDirection(
        authorityTrade.price,
        lastPriceRef.current,
        priceDirectionRef.current,
      );
      const { tradeId, providerTradeId } = getTradeIdentity(authorityTrade);
      activeTradeState = {
        price: authorityTrade.price,
        at: eventTimeMs,
        direction: nextDirection,
        symbol: normalizedSymbol,
        tradeId,
        providerTradeId,
      };
      lastPriceRef.current = authorityTrade.price;
      priceDirectionRef.current = nextDirection;
      updateLastTradeState(activeTradeState);
      setLastPrice(authorityTrade.price);
      setPriceDirection(nextDirection);
    }

    const latestTrade = collectionMetadata?.authorityTrade ?? getLatestSpotTradeRow(tradesStoreEvent.data, {
      symbol: normalizedSymbol,
      provider: tradesStoreEvent.provider,
    });
    setMarketView((previousView) => {
      if (!previousView) return previousView;
      const nextView = protectAuthoritativeTrade(
        applySpotMarketDomainEventToView(previousView, tradesStoreEvent),
        latestTrade,
      );
      return protectActiveLastTrade(nextView, activeTradeState, normalizedSymbol);
    });
  }, [normalizedSymbol, tradesStoreEvent, tradesStoreSlot?.snapshot, updateLastTradeState]);

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

  const depth = depthStoreEvent?.data ?? null;
  const hasUsableDepth = hasDepthLevels(depth) && !isDepthDomainUnavailable(depth, {
    source: depthStoreEvent?.source ?? marketView?.depth_source,
    freshness: depthStoreEvent?.freshness ?? marketView?.depth_freshness,
    status: marketView?.depth_status,
  });
  const bestBid = hasUsableDepth ? marketView?.best_bid ?? firstPrice(depth?.bids) : null;
  const bestAsk = hasUsableDepth ? marketView?.best_ask ?? firstPrice(depth?.asks) : null;
  const orderbookMidPrice = hasUsableDepth ? getViewOrderbookMidPrice(marketView, depth) : null;
  const hasActiveTrade = isActiveLastTrade(lastTradeState, normalizedSymbol);
  const viewLastTradePrice = getViewLastTradePrice(marketView);
  const lastTradePrice = hasActiveTrade ? lastTradeState.price : viewLastTradePrice;
  const outputPriceDirection = hasActiveTrade ? lastTradeState.direction : priceDirection;
  const ticker = tickerStoreEvent?.data ?? null;
  const trades = tradesStoreEvent?.data ?? [];
  const currentTradesEvent = sameSymbol(tradesStoreEvent?.symbol, normalizedSymbol)
    ? tradesStoreEvent
    : null;
  const currentTickerEvent = sameSymbol(tickerStoreEvent?.symbol, normalizedSymbol)
    ? tickerStoreEvent
    : null;
  const latestTrade = getSpotTradesCollectionMetadata(tradesStoreSlot?.snapshot)?.authorityTrade
    ?? getLatestTrade(trades, normalizedSymbol, currentTradesEvent?.provider);
  const tradeDisplayCandidate: SpotDisplayPriceCandidate | null = latestTrade && currentTradesEvent
    ? {
        symbol: normalizedSymbol,
        price: latestTrade.price,
        eventTimeMs: extractSpotTradeEventTimeMs(latestTrade) ?? currentTradesEvent.eventTimeMs,
        receivedAtMs: getSpotTradeReceivedAtMs(latestTrade) ?? currentTradesEvent.receivedAtMs,
        source: latestTrade.source || currentTradesEvent.source,
        provider: latestTrade.provider || currentTradesEvent.provider,
        freshness: latestTrade.freshness || currentTradesEvent.freshness,
      }
    : null;
  const tickerDisplayCandidate: SpotDisplayPriceCandidate | null = ticker && currentTickerEvent
    ? {
        symbol: normalizedSymbol,
        price: getTickerLastPrice(ticker),
        eventTimeMs: extractSpotTickerEventTimeMs(ticker) ?? currentTickerEvent.eventTimeMs,
        receivedAtMs: currentTickerEvent.receivedAtMs,
        source: getRecordText(ticker, 'source') || currentTickerEvent.source,
        provider: getRecordText(ticker, 'provider') || currentTickerEvent.provider,
        freshness: getRecordText(ticker, 'freshness') || getRecordText(ticker, 'quote_freshness') || currentTickerEvent.freshness,
      }
    : null;
  const displayPrice = selectSpotDisplayPrice({
    symbol: normalizedSymbol,
    trade: tradeDisplayCandidate,
    ticker: tickerDisplayCandidate,
    kline: nativeCandle,
  });
  const hydration = resolveSpotMarketHydration({
    price: displayPrice.price,
    source: displayPrice.source,
    restLoading: isLoading,
    connectionStatus,
  });
  const freshness: SpotMarketFreshnessMap = {
    depth: normalizeDomainValue(depthStoreSlot?.snapshot?.metadata.freshness)
      || normalizeDomainValue(marketView?.depth_freshness)
      || depthFreshness(depth),
    trades: normalizeDomainValue(tradesStoreSlot?.snapshot?.metadata.freshness)
      || normalizeDomainValue(marketView?.trades_freshness)
      || tradeFreshness(trades),
    ticker: normalizeDomainValue(tickerStoreSlot?.snapshot?.metadata.freshness)
      || normalizeDomainValue(marketView?.ticker_freshness || marketView?.quote_freshness),
    kline: normalizeDomainValue(marketView?.kline_freshness),
  };
  const sources: SpotMarketSourceMap = {
    depth: normalizeDomainValue(depthStoreSlot?.snapshot?.metadata.source)
      || normalizeDomainValue(marketView?.depth_source)
      || sourceFromDepth(depth),
    trades: normalizeDomainValue(tradesStoreSlot?.snapshot?.metadata.source)
      || normalizeDomainValue(marketView?.trades_source),
    ticker: normalizeDomainValue(tickerStoreSlot?.snapshot?.metadata.source)
      || normalizeDomainValue(marketView?.ticker_source),
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
    isHydrating: hydration.isHydrating,
    error,
    refresh,
  };
}
