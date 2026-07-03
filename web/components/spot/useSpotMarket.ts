'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  getSpotMarketView,
  normalizeSpotSymbol,
  normalizeSpotTrades,
  type SpotDepthLevel,
  type SpotDepthResponse,
  type SpotMarketTradeItem,
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

export type UseSpotMarketResult = {
  symbol: string;
  marketView: SpotMarketView | null;
  depth: SpotDepthResponse | null;
  trades: SpotMarketTradeItem[];
  lastPrice: string | number | null;
  priceDirection: RealtimePriceDirection;
  bestBid: string | number | null;
  bestAsk: string | number | null;
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
  return normalizeSpotTrades(trades || undefined);
}

function firstPrice(levels?: SpotDepthLevel[] | null): string | number | null {
  const level = Array.isArray(levels)
    ? levels.find((item) => Number(item.price) > 0)
    : null;
  return level?.price ?? null;
}

function getViewLastPrice(view?: SpotMarketView | null): string | number | null {
  return view?.last_price ?? view?.display_price ?? view?.ticker?.last_price ?? null;
}

function getViewDirection(view?: SpotMarketView | null): RealtimePriceDirection {
  const direction = String(view?.price_direction || '').toLowerCase();
  if (direction === 'up' || direction === 'down') return direction;
  return 'flat';
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
    const nextLastPrice = getViewLastPrice(view);
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
      setDepth(nextDepth);
      setMarketView((prev) => prev ? {
        ...prev,
        depth: nextDepth,
        best_bid: firstPrice(nextDepth?.bids),
        best_ask: firstPrice(nextDepth?.asks),
        depth_status: nextDepth?.bids?.length || nextDepth?.asks?.length ? 'ok' : 'missing',
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
        display_price_source: 'latest_trade',
        last_price: trade.price,
        price_direction: nextDirection,
        trades_status: 'ok',
      } : prev);
    };

    const unsubscribeSnapshot = spotMarketRealtime.subscribe('snapshot', handleSnapshot);
    const unsubscribeDepth = spotMarketRealtime.subscribe('depth', handleDepth);
    const unsubscribeTrade = spotMarketRealtime.subscribe('trade', handleTrade);

    return () => {
      unsubscribeSnapshot();
      unsubscribeDepth();
      unsubscribeTrade();
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

  return {
    symbol: normalizedSymbol,
    marketView,
    depth,
    trades,
    lastPrice,
    priceDirection,
    bestBid,
    bestAsk,
    isConnected,
    isLoading,
    error,
    refresh,
  };
}
