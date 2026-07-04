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
import { readMarketCache, writeMarketCache } from '@/lib/marketCache';
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
};

type SpotTradeMessage = SpotMarketRealtimeMessage & {
  type: 'spot_trade';
  symbol?: string;
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

const SPOT_VIEW_POLL_MS = 1500;

function readSpotMarketCache(symbol: string): SpotMarketCache | null {
  const normalizedSymbol = normalizeSpotSymbol(symbol);
  const cache = readMarketCache<SpotMarketCache>('spot', normalizedSymbol);
  if (!cache) return null;
  if (normalizeSpotSymbol(cache.symbol || '') !== normalizedSymbol) return null;
  return cache;
}

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

export function useSpotMarket(symbol: string): UseSpotMarketResult {
  const normalizedSymbol = useMemo(() => normalizeSpotSymbol(symbol), [symbol]);
  const [marketView, setMarketView] = useState<SpotMarketView | null>(null);
  const [depth, setDepth] = useState<SpotDepthResponse | null>(null);
  const [trades, setTrades] = useState<SpotMarketTradeItem[]>([]);
  const [lastPrice, setLastPrice] = useState<string | number | null>(null);
  const [priceDirection, setPriceDirection] = useState<RealtimePriceDirection>('flat');
  const [isConnected, setIsConnected] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const lastPriceRef = useRef<string | number | null>(null);
  const priceDirectionRef = useRef<RealtimePriceDirection>('flat');
  const requestSeqRef = useRef(0);
  const activeSymbolRef = useRef(normalizedSymbol);
  const refreshInFlightRef = useRef(false);
  const refreshInFlightSeqRef = useRef(0);
  const mountedRef = useRef(false);

  const applyView = useCallback((view: SpotMarketView) => {
    const nextDepth = normalizeDepth(view.depth);
    const nextTrades = normalizeTrades(view.trades);
    const nextLastPrice = getViewDisplayPrice(view);
    const nextDirection = getViewDirection(view);

    setMarketView(view);
    setDepth(nextDepth);
    setTrades(nextTrades);
    setLastPrice(nextLastPrice);
    setPriceDirection(nextDirection);
    lastPriceRef.current = nextLastPrice;
    priceDirectionRef.current = nextDirection;

    writeMarketCache<SpotMarketCache>('spot', normalizedSymbol, {
      symbol: normalizedSymbol,
      marketView: view,
      depth: nextDepth,
      trades: nextTrades,
      lastPrice: nextLastPrice,
      priceDirection: nextDirection,
      updatedAt: Date.now(),
    });
  }, [normalizedSymbol]);

  const refresh = useCallback(async () => {
    const requestSymbol = normalizedSymbol;
    if (!requestSymbol) return;
    if (activeSymbolRef.current !== requestSymbol) return;
    if (
      refreshInFlightRef.current &&
      activeSymbolRef.current === requestSymbol
    ) {
      return;
    }

    const requestSeq = ++requestSeqRef.current;
    refreshInFlightRef.current = true;
    refreshInFlightSeqRef.current = requestSeq;
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
    activeSymbolRef.current = normalizedSymbol;
    const cache = readSpotMarketCache(normalizedSymbol);
    setMarketView(cache?.marketView || null);
    setDepth(normalizeDepth(cache?.depth));
    setTrades(cache?.trades || []);
    setLastPrice(cache?.lastPrice ?? null);
    setPriceDirection(cache?.priceDirection || 'flat');
    lastPriceRef.current = cache?.lastPrice ?? null;
    priceDirectionRef.current = cache?.priceDirection || 'flat';
    setError(null);
    setIsLoading(!cache);
  }, [normalizedSymbol]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!normalizedSymbol) {
      spotMarketRealtime.disconnect();
      return undefined;
    }

    spotMarketRealtime.setSymbol(normalizedSymbol);
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

      setDepth(normalizeDepth(snapshot.depth));
      setTrades(normalizeTrades(snapshot.trades));
      setIsLoading(false);
    };

    const handleDepth = (message: SpotMarketRealtimeMessage) => {
      const data = message as SpotDepthMessage;
      const msgSymbol = normalizeSpotSymbol(data.symbol || data.depth?.symbol || '');
      if (msgSymbol !== normalizedSymbol) return;

      const nextDepth = normalizeDepth(data.depth);
      const nextBestBid = firstPrice(nextDepth?.bids);
      const nextBestAsk = firstPrice(nextDepth?.asks);
      const nextMidPrice = getDepthMidPrice(nextDepth);
      const nextDepthFreshness = depthFreshness(nextDepth);
      const nextDepthSource = sourceFromDepth(nextDepth);
      setDepth(nextDepth);
      setMarketView((prev) => prev ? {
        ...prev,
        depth: nextDepth,
        best_bid: nextBestBid,
        best_ask: nextBestAsk,
        orderbook_mid_price: nextMidPrice,
        depth_status: nextDepth?.bids?.length || nextDepth?.asks?.length ? 'ok' : 'missing',
        depth_source: nextDepthSource ?? prev.depth_source,
        depth_freshness: nextDepthFreshness ?? prev.depth_freshness,
        display_price: !prev.display_price || prev.display_price_source === 'orderbook_mid' || prev.display_price_source === 'missing'
          ? nextMidPrice ?? prev.display_price
          : prev.display_price,
        display_price_source: !prev.display_price || prev.display_price_source === 'orderbook_mid' || prev.display_price_source === 'missing'
          ? nextMidPrice ? 'orderbook_mid' : prev.display_price_source
          : prev.display_price_source,
      } : prev);
    };

    const handleTrade = (message: SpotMarketRealtimeMessage) => {
      const data = message as SpotTradeMessage;
      const msgSymbol = normalizeSpotSymbol(data.symbol || '');
      if (msgSymbol !== normalizedSymbol || !data.trade) return;

      const trade = data.trade;
      setTrades((prev) => [trade, ...prev].slice(0, 30));
      const nextDirection = getRealtimePriceDirection(
        trade.price,
        lastPriceRef.current,
        priceDirectionRef.current,
      );
      lastPriceRef.current = trade.price;
      priceDirectionRef.current = nextDirection;
      setLastPrice(trade.price);
      setPriceDirection(nextDirection);
      setMarketView((prev) => prev ? {
        ...prev,
        display_price: trade.price,
        display_price_source: 'last_trade',
        last_price: trade.price,
        last_trade_price: trade.price,
        price_direction: nextDirection,
        trades_status: 'ok',
        trades_source: 'LIVE_WS',
        trades_freshness: 'LIVE',
      } : prev);
    };

    const handleTicker = (message: SpotMarketRealtimeMessage) => {
      const data = message as SpotTickerMessage;
      const msgSymbol = normalizeSpotSymbol(data.symbol || data.ticker?.symbol || '');
      if (msgSymbol !== normalizedSymbol || !data.ticker) return;

      const ticker = data.ticker;
      const tickerLastPrice = getTickerLastPrice(ticker);
      const nextDirection = tickerLastPrice !== null
        ? getRealtimePriceDirection(
            tickerLastPrice,
            lastPriceRef.current,
            priceDirectionRef.current,
          )
        : priceDirectionRef.current;
      if (tickerLastPrice !== null) {
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
        display_price: tickerLastPrice ?? prev.display_price,
        display_price_source: tickerLastPrice !== null ? 'ticker' : prev.display_price_source,
        last_price: tickerLastPrice ?? prev.last_price,
        price_direction: tickerLastPrice !== null ? nextDirection : prev.price_direction,
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
    };
  }, [applyView, normalizedSymbol]);

  useEffect(() => {
    if (!normalizedSymbol) {
      return undefined;
    }

    const timer = window.setInterval(() => {
      void refresh();
    }, SPOT_VIEW_POLL_MS);

    return () => {
      window.clearInterval(timer);
    };
  }, [normalizedSymbol, refresh]);

  useEffect(() => {
    return () => {
      spotMarketRealtime.disconnect();
    };
  }, []);

  const bestBid = marketView?.best_bid ?? firstPrice(depth?.bids);
  const bestAsk = marketView?.best_ask ?? firstPrice(depth?.asks);
  const orderbookMidPrice = getViewOrderbookMidPrice(marketView, depth);
  const displayPrice = getViewDisplayPrice(marketView) ?? lastPrice;
  const lastTradePrice = getViewLastTradePrice(marketView);
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
    orderbookMidPrice,
    lastPrice,
    priceDirection,
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
