'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  getContractQuoteDisplayStatus,
  getContractDepth,
  isExpiredLastGoodBboQuote,
  type ContractMarketViewDetail,
  type ContractQuoteDisplayStatus,
  type ContractQuoteAvailability,
  type ContractDepthMode,
  type ContractDepthLevel,
} from '@/lib/api/modules/contract';
import { normalizeSide } from '@/components/spot/orderbook/orderbook.utils';
import { formatPrice } from '@/lib/marketPrecision';
import {
  contractMarketRealtime,
  type ContractMarketRealtimeMessage,
  type ContractMarketRealtimeStatus,
} from '@/lib/realtime/contractMarketRealtime';
import { useLocaleContext } from '@/contexts/LocaleContext';

type ContractFuturesOrderBookProps = {
  symbol: string;
  priceDirection?: 'up' | 'down' | 'flat';
  pricePrecision: number;
  marketStatus?: string | null;
  marketRealtimeStatus?: ContractMarketRealtimeStatus;
  refreshKey?: number;
  currentPrice?: string | number | null;
  currentPriceReady?: boolean;
  currentPriceSource?: 'KLINE_CLOSE' | 'LIVE_MID' | 'TRADE_TICK';
  currentPriceLabel?: string | null;
  marketUiState?: {
    label: string;
    isLoading: boolean;
    isTradable: boolean;
    isRealtime: boolean;
    reason: string;
    status: ContractQuoteDisplayStatus;
  };
  marketView?: ContractMarketViewDetail | null;
  quote?: ContractQuoteAvailability | null;
  quoteLoading?: boolean;
  onPriceSelect?: (price: string) => void;
  onBestPricesChange?: (best: {
    bestBid: string | null;
    bestAsk: string | null;
    source?: string | null;
    depthMode?: ContractDepthMode | null;
    ts?: string | number | null;
    bidsCount?: number;
    asksCount?: number;
  }) => void;
  onLiveBboChange?: (payload: {
    bid: number | null;
    ask: number | null;
    mid: number | null;
    source: 'LIVE_MID' | null;
    updatedAt: number;
  }) => void;
  initialDepth?: {
    symbol?: string | null;
    asks: ContractDepthLevel[];
    bids: ContractDepthLevel[];
    source?: string | null;
    quote_freshness?: string | null;
    quote_source?: string | null;
    depth_mode?: ContractDepthMode | null;
    market_status?: string | null;
    executable?: boolean | null;
    closed_market_execution_mode?: string | null;
    ts?: string | number | null;
  };
  onDepthDataChange?: (depth: {
    symbol?: string | null;
    asks: ContractDepthLevel[];
    bids: ContractDepthLevel[];
    source?: string | null;
    quote_freshness?: string | null;
    quote_source?: string | null;
    depth_mode?: ContractDepthMode | null;
    market_status?: string | null;
    executable?: boolean | null;
    closed_market_execution_mode?: string | null;
    ts?: string | number | null;
  }) => void;
};

type Row = {
  rawPrice: string;
  price: number;
  amount: number;
  total: number;
  width: number;
};

const FUTURES_DEPTH_LIMIT = 20;
const UI_DISPLAY_LIMIT = 9;
const DEPTH_INITIAL_GRACE_MS = 1800;
const DEPTH_FULL_DEGRADE_GRACE_MS = 3000;

type DepthSnapshot = {
  asks: ContractDepthLevel[];
  bids: ContractDepthLevel[];
};

function getQuoteStatusLabel(status: ContractQuoteDisplayStatus, t: (key: string, namespace?: 'contracts') => string) {
  if (status === 'LOADING') return t('marketDataLoadingLabel', 'contracts');
  if (status === 'LIVE') return t('realtimeQuoteLabel', 'contracts');
  return t('quoteTemporarilyUnavailableLabel', 'contracts');
}

function getDepthModeLabel(mode?: string | null) {
  const normalized = String(mode || '').trim().toUpperCase();
  if (normalized === 'FULL_DEPTH') return null;
  if (normalized === 'SYNTHETIC_FROM_BBO') return '\u6a21\u62df\u76d8\u53e3';
  if (normalized === 'BBO_ONLY') return '\u4ec5\u6700\u4f73\u4e70\u5356\u4ef7';
  return null;
}

function normalizeDepthMode(mode?: string | null) {
  return String(mode || '').trim().toUpperCase();
}

function normalizeCurrentPriceSource(value?: string | null) {
  const normalized = String(value || '').trim().toUpperCase();
  if (normalized === 'TRADE_TICK') return 'TRADE_TICK';
  if (normalized === 'LIVE_MID') return 'LIVE_MID';
  if (normalized === 'KLINE_CLOSE') return 'KLINE_CLOSE';
  return null;
}

function quoteStatusBadgeClass(status: ContractQuoteDisplayStatus) {
  if (status === 'LOADING') return 'border-white/10 bg-white/[0.05] text-white/58';
  if (status === 'LIVE') return 'border-[#00c087]/20 bg-[#00c087]/10 text-[#00c087]';
  if (status === 'EXPIRED_LAST_QUOTE' || status === 'UNAVAILABLE') {
    return 'border-[#f6465d]/20 bg-[#f6465d]/10 text-[#f6465d]';
  }
  return 'border-[#f0b90b]/20 bg-[#f0b90b]/10 text-[#f0b90b]';
}

function normalizeMarketViewDisplayState(value?: string | null) {
  const normalized = String(value || '').trim().toUpperCase();
  return normalized || null;
}

function marketViewStateToQuoteStatus(value?: string | null): ContractQuoteDisplayStatus | null {
  const state = normalizeMarketViewDisplayState(value);
  if (!state) return null;
  if (state === 'LOADING') return 'LOADING';
  if (state === 'LIVE_TRADABLE') return 'LIVE';
  if (
    state === 'PRE_MARKET'
    || state === 'AFTER_HOURS'
    || state === 'CLOSED'
    || state === 'MARKET_CLOSED'
    || state === 'HOLIDAY'
    || state === 'CLOSED_LAST_GOOD_TRADABLE'
    || state === 'CLOSED_LAST_GOOD_DISPLAY_ONLY'
    || state === 'EXPIRED'
    || state === 'UNAVAILABLE'
  ) return 'UNAVAILABLE';
  return null;
}

function getNonTradingMarketViewStatusLabel(value: string) {
  const state = normalizeMarketViewDisplayState(value);
  if (state === 'PRE_MARKET') return '盘前';
  if (state === 'AFTER_HOURS') return '盘后';
  if (state === 'CLOSED' || state === 'MARKET_CLOSED') return '闭市中';
  if (state === 'HOLIDAY') return '休市中';
  return null;
}

function getMarketViewStatusLabel(value: string, t: (key: string, namespace?: 'contracts') => string) {
  const state = normalizeMarketViewDisplayState(value);
  if (state === 'LOADING') return t('marketDataLoadingLabel', 'contracts');
  if (state === 'LIVE_TRADABLE') return t('realtimeQuoteLabel', 'contracts');
  const nonTradingLabel = getNonTradingMarketViewStatusLabel(value);
  if (nonTradingLabel) return nonTradingLabel;
  return t('quoteTemporarilyUnavailableLabel', 'contracts');
}

function toNumber(value?: string | number | null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function toPositivePrice(value?: string | number | null) {
  if (value === undefined || value === null || value === '') return null;
  const normalized = typeof value === 'string' ? value.replace(/,/g, '').trim() : value;
  const price = Number(normalized);
  return Number.isFinite(price) && price > 0 ? price : null;
}

function normalizeContractSymbol(value?: string | null) {
  return String(value || '').trim().toUpperCase();
}

function formatAmount(value: number) {
  return Number.isFinite(value) ? value.toFixed(3) : '--';
}

function buildRows(levels: ContractDepthLevel[]): Row[] {
  const maxAmount = Math.max(...levels.map((item) => toNumber(item.amount)), 1);
  let total = 0;

  return levels.map((item) => {
    const amount = toNumber(item.amount);
    total += amount;
    return {
      rawPrice: String(item.price),
      price: toNumber(item.price),
      amount,
      total,
      width: Math.min((amount / maxAmount) * 100, 100),
    };
  });
}

function sortLevelsByPrice(levels: ContractDepthLevel[], direction: 'asc' | 'desc') {
  return [...levels].sort((a, b) => {
    const diff = toNumber(a.price) - toNumber(b.price);
    return direction === 'asc' ? diff : -diff;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function getMessagePayload(message: ContractMarketRealtimeMessage) {
  if (isRecord(message.depth)) return message.depth;
  if (isRecord(message.data)) return message.data;
  return message as Record<string, unknown>;
}

function normalizeRealtimeLevels(value: unknown): ContractDepthLevel[] {
  if (!Array.isArray(value)) return [];

  return value
    .map((level) => {
      if (Array.isArray(level)) {
        return {
          price: String(level[0] ?? ''),
          amount: String(level[1] ?? ''),
        };
      }
      if (isRecord(level)) {
        return {
          price: String(level.price ?? ''),
          amount: String(level.amount ?? level.qty ?? level.quantity ?? ''),
        };
      }
      return null;
    })
    .filter((level): level is ContractDepthLevel => (
      !!level && toNumber(level.price) > 0 && toNumber(level.amount) > 0
    ));
}

function extractRealtimeDepth(
  message: ContractMarketRealtimeMessage,
  currentSymbol: string,
) {
  const payload = getMessagePayload(message);
  const msgSymbol = String(message.symbol || payload.symbol || '').trim().toUpperCase();
  if (msgSymbol && msgSymbol !== currentSymbol.toUpperCase()) return null;

  const asks = normalizeRealtimeLevels(payload.asks);
  const bids = normalizeRealtimeLevels(payload.bids);
  if (asks.length === 0 && bids.length === 0) return null;

  return {
    symbol: msgSymbol || currentSymbol,
    asks: normalizeSide(asks, 'asks', FUTURES_DEPTH_LIMIT),
    bids: normalizeSide(bids, 'bids', FUTURES_DEPTH_LIMIT),
    source: typeof payload.source === 'string' ? payload.source : null,
    depthMode: typeof payload.depth_mode === 'string'
      ? payload.depth_mode
      : typeof payload.depthMode === 'string'
        ? payload.depthMode
        : null,
    quoteSource: typeof payload.quote_source === 'string' ? payload.quote_source : null,
    quoteFreshness: typeof payload.quote_freshness === 'string'
      ? payload.quote_freshness
      : typeof payload.quoteFreshness === 'string'
        ? payload.quoteFreshness
        : null,
    ts: typeof payload.ts === 'string' || typeof payload.ts === 'number'
      ? payload.ts
      : typeof payload.time === 'string' || typeof payload.time === 'number'
        ? payload.time
        : typeof payload.timestamp === 'string' || typeof payload.timestamp === 'number'
          ? payload.timestamp
          : null,
    closedMarketExecutionMode: typeof payload.closed_market_execution_mode === 'string'
      ? payload.closed_market_execution_mode
      : null,
    executable: typeof payload.executable === 'boolean' ? payload.executable : null,
    marketStatus: typeof payload.market_status === 'string' ? payload.market_status : null,
  };
}

function minPrice(levels: ContractDepthLevel[]) {
  let best: ContractDepthLevel | null = null;
  for (const level of levels) {
    const price = toNumber(level.price);
    if (price <= 0) continue;
    if (!best || price < toNumber(best.price)) best = level;
  }
  return best?.price ? String(best.price) : null;
}

function maxPrice(levels: ContractDepthLevel[]) {
  let best: ContractDepthLevel | null = null;
  for (const level of levels) {
    const price = toNumber(level.price);
    if (price <= 0) continue;
    if (!best || price > toNumber(best.price)) best = level;
  }
  return best?.price ? String(best.price) : null;
}

export default function ContractFuturesOrderBook({
  symbol,
  priceDirection = 'flat',
  pricePrecision,
  marketStatus,
  marketRealtimeStatus = 'idle',
  refreshKey = 0,
  currentPrice,
  currentPriceReady = false,
  currentPriceSource = 'KLINE_CLOSE',
  currentPriceLabel,
  marketUiState,
  marketView,
  quote,
  quoteLoading = false,
  onPriceSelect,
  onBestPricesChange,
  onLiveBboChange,
  initialDepth,
  onDepthDataChange,
}: ContractFuturesOrderBookProps) {
  const { t } = useLocaleContext();
  const normalizedSymbol = normalizeContractSymbol(symbol);
  const [depthSymbol, setDepthSymbol] = useState(() => normalizedSymbol);
  const [asks, setAsks] = useState<ContractDepthLevel[]>([]);
  const [bids, setBids] = useState<ContractDepthLevel[]>([]);
  const [source, setSource] = useState<string | null>(null);
  const [depthMode, setDepthMode] = useState<ContractDepthMode | null>(null);
  const [depthMarketStatus, setDepthMarketStatus] = useState<string | null>(null);
  const [depthExecutable, setDepthExecutable] = useState<boolean | null>(null);
  const [depthQuoteSource, setDepthQuoteSource] = useState<string | null>(null);
  const [depthQuoteFreshness, setDepthQuoteFreshness] = useState<string | null>(null);
  const [depthTs, setDepthTs] = useState<string | number | null>(null);
  const [depthClosedMarketExecutionMode, setDepthClosedMarketExecutionMode] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [fallbackDepthAllowed, setFallbackDepthAllowed] = useState(false);
  const [lastFullDepthSnapshot, setLastFullDepthSnapshot] = useState<DepthSnapshot | null>(null);
  const initialDepthRef = useRef(initialDepth);
  const onDepthDataChangeRef = useRef(onDepthDataChange);
  const depthBelongsToCurrentSymbol = depthSymbol === normalizedSymbol;
  const activeAsks = useMemo(
    () => (depthBelongsToCurrentSymbol ? asks : []),
    [asks, depthBelongsToCurrentSymbol],
  );
  const activeBids = useMemo(
    () => (depthBelongsToCurrentSymbol ? bids : []),
    [bids, depthBelongsToCurrentSymbol],
  );
  const activeSource = depthBelongsToCurrentSymbol ? source : null;
  const activeDepthMode = depthBelongsToCurrentSymbol ? depthMode : null;
  const activeDepthMarketStatus = depthBelongsToCurrentSymbol ? depthMarketStatus : null;
  const activeDepthExecutable = depthBelongsToCurrentSymbol ? depthExecutable : null;
  const activeDepthQuoteSource = depthBelongsToCurrentSymbol ? depthQuoteSource : null;
  const activeDepthQuoteFreshness = depthBelongsToCurrentSymbol ? depthQuoteFreshness : null;
  const activeDepthTs = depthBelongsToCurrentSymbol ? depthTs : null;
  const activeDepthClosedMarketExecutionMode = depthBelongsToCurrentSymbol
    ? depthClosedMarketExecutionMode
    : null;
  const activeLoading = loading || !depthBelongsToCurrentSymbol;
  const isClosedMarketStatus = marketStatus === 'CLOSED' || marketStatus === 'HOLIDAY'
    || activeDepthMarketStatus === 'CLOSED' || activeDepthMarketStatus === 'HOLIDAY';
  const effectiveMarketStatus = isClosedMarketStatus
    ? 'CLOSED'
    : marketStatus || activeDepthMarketStatus || null;
  const normalizedActiveDepthMode = normalizeDepthMode(activeDepthMode);

  useEffect(() => {
    initialDepthRef.current = initialDepth;
  }, [initialDepth]);

  useEffect(() => {
    onDepthDataChangeRef.current = onDepthDataChange;
  }, [onDepthDataChange]);

  useEffect(() => {
    setFallbackDepthAllowed(false);
    setLastFullDepthSnapshot(null);
    const timer = window.setTimeout(() => {
      setFallbackDepthAllowed(true);
    }, DEPTH_INITIAL_GRACE_MS);
    return () => window.clearTimeout(timer);
  }, [normalizedSymbol, refreshKey]);

  useEffect(() => {
    if (normalizedActiveDepthMode !== 'FULL_DEPTH') return;
    if (!activeAsks.length || !activeBids.length) return;
    setLastFullDepthSnapshot({
      asks: activeAsks,
      bids: activeBids,
    });
  }, [activeAsks, activeBids, normalizedActiveDepthMode]);

  useEffect(() => {
    if (normalizedActiveDepthMode === 'FULL_DEPTH' || !lastFullDepthSnapshot) return undefined;
    const timer = window.setTimeout(() => {
      setLastFullDepthSnapshot(null);
    }, DEPTH_FULL_DEGRADE_GRACE_MS);
    return () => window.clearTimeout(timer);
  }, [lastFullDepthSnapshot, normalizedActiveDepthMode]);

  useEffect(() => {
    let alive = true;
    let polling = false;

    async function loadDepth() {
      if (polling) return;
      polling = true;
      try {
        const depth = await getContractDepth(symbol, FUTURES_DEPTH_LIMIT);
        if (!alive) return;
        const nextAsks = normalizeSide(depth.asks, 'asks', FUTURES_DEPTH_LIMIT);
        const nextBids = normalizeSide(depth.bids, 'bids', FUTURES_DEPTH_LIMIT);
        setDepthSymbol(normalizedSymbol);
        setAsks(nextAsks);
        setBids(nextBids);
        setSource(depth.source);
        setDepthMode(depth.depth_mode || null);
        setDepthMarketStatus(depth.market_status || null);
        setDepthExecutable(depth.executable ?? null);
        setDepthQuoteSource(depth.quote_source || depth.source || null);
        setDepthQuoteFreshness(depth.quote_freshness || null);
        setDepthTs(depth.ts || null);
        setDepthClosedMarketExecutionMode(depth.closed_market_execution_mode || null);
        onDepthDataChangeRef.current?.({
          symbol: depth.symbol || normalizedSymbol,
          asks: nextAsks,
          bids: nextBids,
          source: depth.source,
          depth_mode: depth.depth_mode || null,
          quote_freshness: depth.quote_freshness || null,
          quote_source: depth.quote_source || depth.source || null,
          market_status: depth.market_status || null,
          executable: depth.executable ?? null,
          closed_market_execution_mode: depth.closed_market_execution_mode || null,
          ts: depth.ts || null,
        });
      } catch {
        if (!alive) return;
      } finally {
        if (alive) setLoading(false);
        polling = false;
      }
    }

    const cachedDepth = initialDepthRef.current;
    const cachedDepthSymbol = normalizeContractSymbol(cachedDepth?.symbol) || normalizedSymbol;
    const cachedDepthBelongsToCurrentSymbol = cachedDepthSymbol === normalizedSymbol;
    const cachedAsks = cachedDepthBelongsToCurrentSymbol ? cachedDepth?.asks || [] : [];
    const cachedBids = cachedDepthBelongsToCurrentSymbol ? cachedDepth?.bids || [] : [];
    if (cachedAsks.length > 0 || cachedBids.length > 0) {
      const cachedDepthHasConfirmedStatus = cachedDepth?.executable !== undefined
        && cachedDepth?.executable !== null;
      setDepthSymbol(normalizedSymbol);
      setAsks(cachedAsks);
      setBids(cachedBids);
      setSource(cachedDepth?.source || null);
      setDepthMode(cachedDepth?.depth_mode || null);
      setDepthMarketStatus(cachedDepth?.market_status || null);
      setDepthExecutable(cachedDepth?.executable ?? null);
      setDepthQuoteSource(cachedDepth?.quote_source || cachedDepth?.source || null);
      setDepthQuoteFreshness(cachedDepth?.quote_freshness || null);
      setDepthTs(cachedDepth?.ts || null);
      setDepthClosedMarketExecutionMode(cachedDepth?.closed_market_execution_mode || null);
      setLoading(!cachedDepthHasConfirmedStatus);
    } else {
      setDepthSymbol(normalizedSymbol);
      setAsks([]);
      setBids([]);
      setSource(null);
      setDepthMode(null);
      setDepthMarketStatus(null);
      setDepthExecutable(null);
      setDepthQuoteSource(null);
      setDepthQuoteFreshness(null);
      setDepthTs(null);
      setDepthClosedMarketExecutionMode(null);
      setLoading(true);
    }
    void loadDepth();
    if (marketRealtimeStatus === 'connected') {
      return () => {
        alive = false;
      };
    }
    const timer = window.setInterval(() => {
      void loadDepth();
    }, 1500);

    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [marketRealtimeStatus, normalizedSymbol, refreshKey, symbol]);

  useEffect(() => {
    const handleDepthMessage = (message: ContractMarketRealtimeMessage) => {
      if (effectiveMarketStatus === 'CLOSED') return;

      const depth = extractRealtimeDepth(message, symbol);
      if (!depth) return;

      setDepthSymbol(normalizedSymbol);
      setAsks(depth.asks);
      setBids(depth.bids);
      setSource(depth.source);
      setDepthMode(depth.depthMode || null);
      setDepthMarketStatus(depth.marketStatus);
      setDepthExecutable(depth.executable);
      setDepthQuoteSource(depth.quoteSource || depth.source);
      setDepthQuoteFreshness(depth.quoteFreshness);
      setDepthTs(depth.ts);
      setDepthClosedMarketExecutionMode(depth.closedMarketExecutionMode);
      setLoading(false);
      onDepthDataChangeRef.current?.({
        symbol: depth.symbol || normalizedSymbol,
        asks: depth.asks,
        bids: depth.bids,
        source: depth.source,
        depth_mode: depth.depthMode || null,
        quote_freshness: depth.quoteFreshness,
        quote_source: depth.quoteSource || depth.source,
        market_status: depth.marketStatus,
        executable: depth.executable,
        closed_market_execution_mode: depth.closedMarketExecutionMode,
        ts: depth.ts,
      });
    };

    return contractMarketRealtime.subscribe('depth', handleDepthMessage);
  }, [effectiveMarketStatus, normalizedSymbol, symbol]);

  const bestPrices = useMemo(
    () => ({
      // Best prices are derived by price, not by array or display order.
      bestAsk: minPrice(activeAsks),
      bestBid: maxPrice(activeBids),
      source: activeSource,
      ts: activeDepthTs,
      depthMode: activeDepthMode,
      bidsCount: activeBids.length,
      asksCount: activeAsks.length,
    }),
    [activeAsks, activeBids, activeDepthMode, activeDepthTs, activeSource],
  );
  const lastBestPricesRef = useRef<{
    bestBid: string | null;
    bestAsk: string | null;
    source?: string | null;
    ts?: string | number | null;
    depthMode?: ContractDepthMode | null;
    bidsCount?: number;
    asksCount?: number;
  }>({
    bestBid: null,
    bestAsk: null,
    source: null,
    ts: null,
    depthMode: null,
    bidsCount: 0,
    asksCount: 0,
  });

  useEffect(() => {
    const previous = lastBestPricesRef.current;
    if (
      previous.bestBid === bestPrices.bestBid &&
      previous.bestAsk === bestPrices.bestAsk &&
      previous.source === bestPrices.source &&
      previous.ts === bestPrices.ts &&
      previous.depthMode === bestPrices.depthMode &&
      previous.bidsCount === bestPrices.bidsCount &&
      previous.asksCount === bestPrices.asksCount
    ) return;
    lastBestPricesRef.current = bestPrices;
    onBestPricesChange?.(bestPrices);
  }, [bestPrices, onBestPricesChange]);

  const hasRawDepthRows = activeAsks.length > 0 || activeBids.length > 0;
  const hasFullDepth = normalizedActiveDepthMode === 'FULL_DEPTH';
  const shouldHoldPreviousFullDepth = !hasFullDepth && !!lastFullDepthSnapshot;
  const shouldDelayFallbackDepth = hasRawDepthRows
    && !hasFullDepth
    && !fallbackDepthAllowed
    && !shouldHoldPreviousFullDepth;
  const displayAsks = useMemo(() => {
    if (hasFullDepth) return activeAsks;
    if (shouldHoldPreviousFullDepth) return lastFullDepthSnapshot?.asks || [];
    if (fallbackDepthAllowed) return activeAsks;
    return [];
  }, [activeAsks, fallbackDepthAllowed, hasFullDepth, lastFullDepthSnapshot, shouldHoldPreviousFullDepth]);
  const displayBids = useMemo(() => {
    if (hasFullDepth) return activeBids;
    if (shouldHoldPreviousFullDepth) return lastFullDepthSnapshot?.bids || [];
    if (fallbackDepthAllowed) return activeBids;
    return [];
  }, [activeBids, fallbackDepthAllowed, hasFullDepth, lastFullDepthSnapshot, shouldHoldPreviousFullDepth]);
  const displayDepthMode = hasFullDepth
    ? activeDepthMode
    : shouldHoldPreviousFullDepth
      ? 'FULL_DEPTH'
      : fallbackDepthAllowed
        ? activeDepthMode
        : null;
  const normalizedDisplayDepthMode = normalizeDepthMode(displayDepthMode);
  const orderBookLoading = activeLoading || shouldDelayFallbackDepth;

  const askRows = useMemo(() => {
    const limit = normalizedDisplayDepthMode === 'BBO_ONLY' ? 1 : UI_DISPLAY_LIMIT;
    const visibleAsks = sortLevelsByPrice(displayAsks, 'asc').slice(0, limit);
    return buildRows(visibleAsks).reverse();
  }, [displayAsks, normalizedDisplayDepthMode]);
  const bidRows = useMemo(() => {
    const limit = normalizedDisplayDepthMode === 'BBO_ONLY' ? 1 : UI_DISPLAY_LIMIT;
    const visibleBids = sortLevelsByPrice(displayBids, 'desc').slice(0, limit);
    return buildRows(visibleBids);
  }, [displayBids, normalizedDisplayDepthMode]);
  const currentPriceNumber = toPositivePrice(currentPrice);
  const hasCurrentPrice = currentPriceReady && currentPriceNumber !== null;
  const normalizedCurrentPriceSource = normalizeCurrentPriceSource(currentPriceSource) || 'KLINE_CLOSE';
  const bestBidNumber = toPositivePrice(bestPrices.bestBid);
  const bestAskNumber = toPositivePrice(bestPrices.bestAsk);
  const bboMidPrice = bestBidNumber !== null && bestAskNumber !== null && bestAskNumber >= bestBidNumber
    ? (bestBidNumber + bestAskNumber) / 2
    : null;
  useEffect(() => {
    if (!onLiveBboChange) return;
    if (bestBidNumber !== null && bestAskNumber !== null && bboMidPrice !== null) {
      onLiveBboChange({
        bid: bestBidNumber,
        ask: bestAskNumber,
        mid: bboMidPrice,
        source: 'LIVE_MID',
        updatedAt: Date.now(),
      });
      return;
    }
    onLiveBboChange({
      bid: null,
      ask: null,
      mid: null,
      source: null,
      updatedAt: Date.now(),
    });
  }, [bestAskNumber, bestBidNumber, bboMidPrice, onLiveBboChange]);
  const marketViewDisplayPrice = toPositivePrice(marketView?.display_price);
  const marketViewDisplaySource = marketViewDisplayPrice !== null
    ? normalizeCurrentPriceSource(marketView?.current_price_source || marketView?.display_price_source)
    : null;
  const centerPriceNumber = normalizedCurrentPriceSource === 'TRADE_TICK' && hasCurrentPrice
    ? currentPriceNumber
    : bboMidPrice ?? marketViewDisplayPrice ?? currentPriceNumber;
  const normalizedCenterPriceSource = normalizedCurrentPriceSource === 'TRADE_TICK' && hasCurrentPrice
    ? 'TRADE_TICK'
    : bboMidPrice !== null
      ? 'LIVE_MID'
      : marketViewDisplaySource || normalizedCurrentPriceSource;
  const hasCenterPrice = centerPriceNumber !== null;
  const priceClass =
    priceDirection === 'up'
      ? 'text-[#00c087]'
      : priceDirection === 'down'
        ? 'text-[#f6465d]'
        : 'text-white';
  const isExpiredLastGoodBbo = isExpiredLastGoodBboQuote({
    executable: activeDepthExecutable ?? undefined,
    market_status: activeDepthMarketStatus || effectiveMarketStatus || undefined,
    closed_market_execution_mode: activeDepthClosedMarketExecutionMode || undefined,
    quote_freshness: activeDepthQuoteFreshness || undefined,
    quote_source: activeDepthQuoteSource || undefined,
    source: activeSource,
  });
  const hasConfirmedDepthStatus = activeDepthExecutable !== null || isExpiredLastGoodBbo;
  const depthStatusLoading = activeLoading && !hasConfirmedDepthStatus;
  const ownDepthDisplayStatus = getContractQuoteDisplayStatus({
    executable: activeDepthExecutable ?? undefined,
    market_status: activeDepthMarketStatus || effectiveMarketStatus || undefined,
    closed_market_execution_mode: activeDepthClosedMarketExecutionMode || undefined,
    quote_freshness: activeDepthQuoteFreshness || undefined,
    quote_source: activeDepthQuoteSource || undefined,
    source: activeSource,
  }, {
    loading: depthStatusLoading,
  });
  const quoteFallbackDisplayStatus = getContractQuoteDisplayStatus(quote, {
    loading: quoteLoading && !quote,
  });
  const shouldUseQuoteFallbackStatus = !hasConfirmedDepthStatus
    && quoteFallbackDisplayStatus !== 'UNAVAILABLE';
  const fallbackDepthDisplayStatus = shouldUseQuoteFallbackStatus
    ? quoteFallbackDisplayStatus
    : ownDepthDisplayStatus;
  const marketViewDisplayState = normalizeMarketViewDisplayState(marketView?.display_state);
  const marketViewDisplayStatus = marketViewStateToQuoteStatus(marketViewDisplayState);
  const depthDisplayStatus = marketUiState?.status || (
    hasCenterPrice
      ? (marketViewDisplayStatus || fallbackDepthDisplayStatus)
      : 'LOADING'
  );
  const hasDepthQuoteStatus = !!marketUiState || !hasCenterPrice || !!marketViewDisplayStatus || depthDisplayStatus === 'LOADING'
    || hasConfirmedDepthStatus
    || shouldUseQuoteFallbackStatus;
  const depthStatusLabel = marketUiState?.label || (!hasCenterPrice
    ? t('marketDataLoadingLabel', 'contracts')
    : marketViewDisplayState && marketViewDisplayStatus
    ? getMarketViewStatusLabel(marketViewDisplayState, t)
    : getQuoteStatusLabel(depthDisplayStatus, t));
  const titleLabel = t('orderBook', 'contracts');
  const depthModeLabel = getDepthModeLabel(displayDepthMode);
  const centerDisplayPrice = !hasCenterPrice || centerPriceNumber === null
    ? '--'
    : formatPrice(centerPriceNumber, pricePrecision);
  const centerSelectPrice = !hasCenterPrice || centerPriceNumber === null
    ? null
    : String(centerPriceNumber);
  const centerLabel = normalizedCenterPriceSource === 'TRADE_TICK'
    ? currentPriceLabel || t('latestPrice', 'contracts')
    : normalizedCenterPriceSource === 'LIVE_MID'
      ? t('midPrice', 'contracts')
      : t('klineLatestPrice', 'contracts');

  return (
    <div className="tabular-nums flex h-full min-h-0 min-w-0 flex-col bg-[#11161d] px-2.5 py-2">
      <div className="mb-2 flex min-w-0 items-center justify-between gap-2">
        <div className="flex min-w-0 flex-nowrap items-center gap-2">
          <div className="shrink-0 whitespace-nowrap text-[13px] font-medium text-white/88">
            {titleLabel}
          </div>
          {hasDepthQuoteStatus ? (
            <div className={`shrink-0 whitespace-nowrap rounded-full border px-2 py-0.5 text-[10px] font-semibold ${quoteStatusBadgeClass(depthDisplayStatus)}`}>
              {depthStatusLabel}
            </div>
          ) : null}
          {depthModeLabel ? (
            <div className="shrink-0 whitespace-nowrap rounded-full border border-[#f0b90b]/25 bg-[#f0b90b]/10 px-2 py-0.5 text-[10px] font-semibold text-[#f0b90b]">
              {depthModeLabel}
            </div>
          ) : null}
        </div>
        <div className="shrink-0 whitespace-nowrap rounded-full bg-white/[0.03] px-2 py-0.5 text-[13px] font-medium text-white/42">
          {displaySymbol(symbol)}
        </div>
      </div>

      <div className="mb-1.5 grid grid-cols-3 px-1 text-[11px] font-medium text-gray-400">
        <div>{t('price', 'contracts')}</div>
        <div className="text-center">{t('amount', 'contracts')}</div>
        <div className="text-right">{t('total', 'contracts')}</div>
      </div>

      {orderBookLoading && askRows.length === 0 && bidRows.length === 0 ? (
        <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-white/40">
          {t('loading', 'common')}
        </div>
      ) : askRows.length === 0 && bidRows.length === 0 ? (
        <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-white/40">
          {t('noOrderBookData', 'contracts')}
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_auto_minmax(0,1fr)] gap-1">
          <div className="grid min-h-0 grid-rows-9 gap-px overflow-hidden">
            {askRows.map((row) => (
              <BookRow key={`ask-${row.rawPrice}`} row={row} side="ask" pricePrecision={pricePrecision} onPriceSelect={onPriceSelect} />
            ))}
          </div>

          <button
            type="button"
            aria-label={centerLabel}
            title={centerLabel}
            disabled={!onPriceSelect || centerDisplayPrice === '--' || !centerSelectPrice}
            onClick={() => {
              if (centerSelectPrice) onPriceSelect?.(centerSelectPrice);
            }}
            data-price-source={normalizedCenterPriceSource}
            className={`rounded-md border border-white/[0.05] bg-white/[0.02] px-2 py-1.5 text-center font-semibold leading-none transition-colors hover:bg-white/[0.05] disabled:cursor-default disabled:hover:bg-white/[0.02] ${priceClass}`}
          >
            <span className="mb-1 block text-[10px] font-medium leading-none text-white/42">{centerLabel}</span>
            <span className="block text-[17px] leading-none">{centerDisplayPrice}</span>
          </button>

          <div className="grid min-h-0 grid-rows-9 gap-px overflow-hidden">
            {bidRows.map((row) => (
              <BookRow key={`bid-${row.rawPrice}`} row={row} side="bid" pricePrecision={pricePrecision} onPriceSelect={onPriceSelect} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function BookRow({
  row,
  side,
  pricePrecision,
  onPriceSelect,
}: {
  row: Row;
  side: 'ask' | 'bid';
  pricePrecision: number;
  onPriceSelect?: (price: string) => void;
}) {
  const colorClass = side === 'ask' ? 'text-[#f6465d]' : 'text-[#00c087]';
  const bgClass = side === 'ask' ? 'bg-[#f6465d]/10' : 'bg-[#00c087]/10';

  return (
    <button
      type="button"
      onClick={() => onPriceSelect?.(row.rawPrice)}
      className="relative grid h-full min-h-0 grid-cols-3 items-center overflow-hidden rounded-[6px] px-1.5 text-left text-[12px] leading-4 tabular-nums transition-colors hover:bg-white/[0.035]"
    >
      <div
        className={`absolute right-0 top-0 h-full ${bgClass}`}
        style={{ width: `${row.width}%` }}
      />
      <div className={`relative truncate px-0.5 text-left font-medium ${colorClass}`}>{formatPrice(row.price, pricePrecision)}</div>
      <div className="relative truncate px-0.5 text-center text-white/86">{formatAmount(row.amount)}</div>
      <div className="relative text-right text-white/50">{formatAmount(row.total)}</div>
    </button>
  );
}

function displaySymbol(symbol: string) {
  return symbol.replace(/_PERP$/, '');
}
