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
  trades?: {
    symbol?: string;
    items?: SpotMarketTradeItem[];
    trades?: SpotMarketTradeItem[];
  };
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

function parseTradeTimeMs(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;

  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    return value < 1e12 ? value * 1000 : value;
  }

  const text = String(value).trim();
  if (!text) return null;

  const numericValue = Number(text);
  if (Number.isFinite(numericValue) && numericValue > 0) {
    return numericValue < 1e12 ? numericValue * 1000 : numericValue;
  }

  const parsed = Date.parse(text);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function getTradeTimeMs(trade?: SpotMarketTradeItem | null): number | null {
  return (
    parseTradeTimeMs(trade?.ts) ||
    parseTradeTimeMs(trade?.time) ||
    parseTradeTimeMs(trade?.updated_at_ms) ||
    parseTradeTimeMs(trade?.created_at)
  );
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

  const applyView = useCallback((view: SpotMarketView) => {
    const mergedView = normalizeSpotMarketViewDepthDomain(view);
    const nextDepth = normalizeDepthForDisplay(mergedView.depth, {
      source: mergedView.depth_source,
      freshness: mergedView.depth_freshness,
      status: mergedView.depth_status,
    });
    const nextTrades = normalizeTrades(mergedView.trades);
    const activeLastTrade = lastTradeStateRef.current;
    const hasActiveTrade = isActiveLastTrade(activeLastTrade, normalizedSymbol);
    const nextLastPrice = hasActiveTrade
      ? activeLastTrade.price
      : getViewLastTradePrice(mergedView) ?? getViewDisplayPrice(mergedView);
    const nextDirection = hasActiveTrade
      ? activeLastTrade.direction
      : getViewDirection(mergedView);

    setMarketView(mergedView);
    setDepth(nextDepth);
    setTrades(nextTrades);
    setLastPrice(nextLastPrice);
    setPriceDirection(nextDirection);
    lastPriceRef.current = nextLastPrice;
    priceDirectionRef.current = nextDirection;

    const nextCache = {
      symbol: normalizedSymbol,
      marketView: mergedView,
      depth: nextDepth,
      trades: nextTrades,
      lastPrice: nextLastPrice,
      priceDirection: nextDirection,
      updatedAt: Date.now(),
    };
    if (hasUsableMarketState(mergedView, nextDepth, nextTrades)) {
      writeMarketCache<SpotMarketCache>('spot', normalizedSymbol, nextCache);
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
        applyView(view);
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
        applyView(snapshot.market_view);
        setIsLoading(false);
        return;
      }

      const hasDepthPayload = Object.prototype.hasOwnProperty.call(snapshot, 'depth');
      const hasTradesPayload = Object.prototype.hasOwnProperty.call(snapshot, 'trades');
      const hasTickerPayload = Object.prototype.hasOwnProperty.call(snapshot, 'ticker');

      if (hasDepthPayload) {
        const nextDepth = normalizeDepthForDisplay(snapshot.depth);
        const nextHasDepth = hasDepthLevels(nextDepth);
        const nextDepthSource = sourceFromDepth(nextDepth) ?? (nextHasDepth ? null : 'MISSING');
        const nextDepthFreshness = depthFreshness(nextDepth) ?? (nextHasDepth ? null : 'MISSING');
        setDepth(nextDepth);
        setMarketView((prev) => prev ? normalizeSpotMarketViewDepthDomain({
            ...prev,
            depth: nextDepth,
            best_bid: nextHasDepth ? firstPrice(nextDepth?.bids) : null,
            best_ask: nextHasDepth ? firstPrice(nextDepth?.asks) : null,
            orderbook_mid_price: nextHasDepth ? getDepthMidPrice(nextDepth) : null,
            spread: nextHasDepth ? prev.spread : null,
            depth_status: nextHasDepth ? 'ok' : 'missing',
            depth_source: nextDepthSource,
            depth_freshness: nextDepthFreshness,
          }) : prev);
      }

      if (hasTradesPayload) {
        const nextTrades = normalizeTrades(snapshot.trades);
        setTrades(nextTrades);
        setMarketView((prev) => prev ? {
            ...prev,
            trades: buildTradesPayload(normalizedSymbol, nextTrades),
            trades_status: nextTrades.length ? 'ok' : 'missing',
          } : prev);
      }

      if (hasTickerPayload && snapshot.ticker) {
        const tickerLastPrice = getTickerLastPrice(snapshot.ticker);
        const hasActiveTrade = isActiveLastTrade(lastTradeStateRef.current, normalizedSymbol);
        setMarketView((prev) => prev ? {
          ...prev,
          ticker: snapshot.ticker,
          ticker_last_price: tickerLastPrice ?? prev.ticker_last_price,
          display_price: hasActiveTrade ? prev.display_price : tickerLastPrice ?? prev.display_price,
          display_price_source: !hasActiveTrade && tickerLastPrice !== null ? 'ticker' : prev.display_price_source,
          last_price: hasActiveTrade ? prev.last_price : tickerLastPrice ?? prev.last_price,
        } : prev);
        if (tickerLastPrice !== null && !hasActiveTrade) {
          setLastPrice(tickerLastPrice);
          lastPriceRef.current = tickerLastPrice;
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
      const nextBestBid = firstPrice(nextDepth?.bids);
      const nextBestAsk = firstPrice(nextDepth?.asks);
      const nextMidPrice = getDepthMidPrice(nextDepth);
      const nextDepthFreshness = depthFreshness(nextDepth);
      const nextDepthSource = sourceFromDepth(nextDepth);
      setDepth(nextDepth);
      setMarketView((prev) => prev ? normalizeSpotMarketViewDepthDomain({
        ...prev,
        depth: nextDepth,
        best_bid: nextHasDepth ? nextBestBid : null,
        best_ask: nextHasDepth ? nextBestAsk : null,
        orderbook_mid_price: nextHasDepth ? nextMidPrice : null,
        spread: nextHasDepth ? prev.spread : null,
        depth_status: nextHasDepth ? 'ok' : 'missing',
        depth_source: nextDepthSource ?? (nextHasDepth ? prev.depth_source : 'MISSING'),
        depth_freshness: nextDepthFreshness ?? (nextHasDepth ? prev.depth_freshness : 'MISSING'),
      }) : prev);
    };

    const handleTrade = (message: SpotMarketRealtimeMessage) => {
      const data = message as SpotTradeMessage;
      const msgSymbol = normalizeSpotSymbol(data.symbol || '');
      if (msgSymbol !== normalizedSymbol || !data.trade) return;

      const trade = data.trade;
      const tradeProvider = trade.provider || data.provider;
      const tradeKey = getTradeDedupKey(normalizedSymbol, trade, tradeProvider);
      if (rememberTradeKey(tradeKey)) return;

      setTrades((prev) => {
        const nextRows = tradeKey
          ? [
              trade,
              ...prev.filter((item) => getTradeDedupKey(normalizedSymbol, item, item.provider || tradeProvider) !== tradeKey),
            ]
          : [trade, ...prev];
        return nextRows.slice(0, 30);
      });
      const nextDirection = getRealtimePriceDirection(
        trade.price,
        lastPriceRef.current,
        priceDirectionRef.current,
      );
      const { tradeId, providerTradeId } = getTradeIdentity(trade);
      const nextLastTradeState: SpotLastTradeState = {
        price: trade.price,
        at: getTradeTimeMs(trade) || Date.now(),
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
      const tradeSource = normalizeDomainValue(trade.source || data.source) || 'LIVE_WS';
      const tradeFreshness = normalizeDomainValue(trade.freshness || data.freshness) || 'LIVE';
      setMarketView((prev) => prev ? {
        ...prev,
        display_price: trade.price,
        display_price_source: 'last_trade',
        last_price: trade.price,
        last_trade_price: trade.price,
        price_direction: nextDirection,
        trades_status: 'ok',
        trades_source: tradeSource,
        trades_freshness: tradeFreshness,
        raw_source_summary: {
          ...(prev.raw_source_summary || {}),
          trades_source: tradeSource,
          trades_provider: tradeProvider,
          trades_freshness: tradeFreshness,
        },
      } : prev);
    };

    const handleTicker = (message: SpotMarketRealtimeMessage) => {
      const data = message as SpotTickerMessage;
      const msgSymbol = normalizeSpotSymbol(data.symbol || data.ticker?.symbol || '');
      if (msgSymbol !== normalizedSymbol || !data.ticker) return;

      const ticker = data.ticker;
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
      const tickerSource = normalizeDomainValue(ticker.source) || 'LIVE_WS';
      const tickerFreshness = normalizeDomainValue(ticker.freshness || ticker.quote_freshness) || 'LIVE';
      setMarketView((prev) => prev ? {
        ...prev,
        ticker,
        ticker_last_price: tickerLastPrice ?? prev.ticker_last_price,
        ticker_24h_change: ticker.price_change_24h ?? prev.ticker_24h_change,
        ticker_24h_change_percent: (
          ticker.price_change_percent_24h ??
          ticker.price_change_percent ??
          ticker.change_24h ??
          prev.ticker_24h_change_percent
        ),
        ticker_24h_high: ticker.high_24h ?? prev.ticker_24h_high,
        ticker_24h_low: ticker.low_24h ?? prev.ticker_24h_low,
        ticker_volume: ticker.base_volume_24h ?? ticker.volume_24h ?? prev.ticker_volume,
        ticker_quote_volume: ticker.quote_volume_24h ?? prev.ticker_quote_volume,
        display_price: hasActiveTrade ? prev.display_price : tickerLastPrice ?? prev.display_price,
        display_price_source: !hasActiveTrade && tickerLastPrice !== null ? 'ticker' : prev.display_price_source,
        last_price: hasActiveTrade ? prev.last_price : tickerLastPrice ?? prev.last_price,
        price_direction: !hasActiveTrade && tickerLastPrice !== null ? nextDirection : prev.price_direction,
        market_status: ticker.market_status ?? prev.market_status,
        ticker_source: tickerSource,
        ticker_freshness: tickerFreshness,
        quote_freshness: tickerFreshness,
        data_source: ticker.data_source ?? prev.data_source,
        raw_source_summary: {
          ...(prev.raw_source_summary || {}),
          ticker_source: ticker.source ?? tickerSource,
          ticker_provider: ticker.provider,
          ticker_stale: ticker.stale,
          ticker_freshness: tickerFreshness,
        },
      } : prev);
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
  }, [applyView, normalizedSymbol, rememberTradeKey, updateLastTradeState]);

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
