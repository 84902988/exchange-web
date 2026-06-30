'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  getContractQuoteDisplayStatus,
  getContractDepth,
  isExpiredLastGoodBboQuote,
  type ContractQuoteDisplayStatus,
  type ContractQuoteAvailability,
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
  lastPrice?: string;
  priceDirection?: 'up' | 'down' | 'flat';
  pricePrecision: number;
  marketStatus?: string | null;
  marketRealtimeStatus?: ContractMarketRealtimeStatus;
  quote?: ContractQuoteAvailability | null;
  quoteLoading?: boolean;
  onPriceSelect?: (price: string) => void;
  onBestPricesChange?: (best: {
    bestBid: string | null;
    bestAsk: string | null;
    source?: string | null;
    ts?: string | number | null;
    bidsCount?: number;
    asksCount?: number;
  }) => void;
  initialDepth?: {
    symbol?: string | null;
    asks: ContractDepthLevel[];
    bids: ContractDepthLevel[];
    source?: string | null;
    quote_freshness?: string | null;
    quote_source?: string | null;
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

function getQuoteStatusLabel(status: ContractQuoteDisplayStatus, t: (key: string, namespace?: 'contracts') => string) {
  if (status === 'LOADING') return t('marketDataLoadingLabel', 'contracts');
  if (status === 'LIVE') return t('realtimeQuoteLabel', 'contracts');
  if (status === 'LAST_QUOTE') return t('lastQuoteLabel', 'contracts');
  if (status === 'EXPIRED_LAST_QUOTE') return t('lastQuoteExpiredLabel', 'contracts');
  return t('quoteTemporarilyUnavailableLabel', 'contracts');
}

function quoteStatusBadgeClass(status: ContractQuoteDisplayStatus) {
  if (status === 'LOADING') return 'border-white/10 bg-white/[0.05] text-white/58';
  if (status === 'LIVE') return 'border-[#00c087]/20 bg-[#00c087]/10 text-[#00c087]';
  if (status === 'EXPIRED_LAST_QUOTE' || status === 'UNAVAILABLE') {
    return 'border-[#f6465d]/20 bg-[#f6465d]/10 text-[#f6465d]';
  }
  return 'border-[#f0b90b]/20 bg-[#f0b90b]/10 text-[#f0b90b]';
}

function toNumber(value?: string | number | null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
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
  lastPrice = '--',
  priceDirection = 'flat',
  pricePrecision,
  marketStatus,
  marketRealtimeStatus = 'idle',
  quote,
  quoteLoading = false,
  onPriceSelect,
  onBestPricesChange,
  initialDepth,
  onDepthDataChange,
}: ContractFuturesOrderBookProps) {
  const { t } = useLocaleContext();
  const normalizedSymbol = normalizeContractSymbol(symbol);
  const [depthSymbol, setDepthSymbol] = useState(() => normalizedSymbol);
  const [asks, setAsks] = useState<ContractDepthLevel[]>([]);
  const [bids, setBids] = useState<ContractDepthLevel[]>([]);
  const [source, setSource] = useState<string | null>(null);
  const [depthMarketStatus, setDepthMarketStatus] = useState<string | null>(null);
  const [depthExecutable, setDepthExecutable] = useState<boolean | null>(null);
  const [depthQuoteSource, setDepthQuoteSource] = useState<string | null>(null);
  const [depthQuoteFreshness, setDepthQuoteFreshness] = useState<string | null>(null);
  const [depthTs, setDepthTs] = useState<string | number | null>(null);
  const [depthClosedMarketExecutionMode, setDepthClosedMarketExecutionMode] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
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

  useEffect(() => {
    initialDepthRef.current = initialDepth;
  }, [initialDepth]);

  useEffect(() => {
    onDepthDataChangeRef.current = onDepthDataChange;
  }, [onDepthDataChange]);

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
  }, [marketRealtimeStatus, normalizedSymbol, symbol]);

  useEffect(() => {
    const handleDepthMessage = (message: ContractMarketRealtimeMessage) => {
      if (effectiveMarketStatus === 'CLOSED') return;

      const depth = extractRealtimeDepth(message, symbol);
      if (!depth) return;

      setDepthSymbol(normalizedSymbol);
      setAsks(depth.asks);
      setBids(depth.bids);
      setSource(depth.source);
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
      bidsCount: activeBids.length,
      asksCount: activeAsks.length,
    }),
    [activeAsks, activeBids, activeDepthTs, activeSource],
  );
  const lastBestPricesRef = useRef<{
    bestBid: string | null;
    bestAsk: string | null;
    source?: string | null;
    ts?: string | number | null;
    bidsCount?: number;
    asksCount?: number;
  }>({
    bestBid: null,
    bestAsk: null,
    source: null,
    ts: null,
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
      previous.bidsCount === bestPrices.bidsCount &&
      previous.asksCount === bestPrices.asksCount
    ) return;
    lastBestPricesRef.current = bestPrices;
    onBestPricesChange?.(bestPrices);
  }, [bestPrices, onBestPricesChange]);

  const askRows = useMemo(() => {
    const visibleAsks = sortLevelsByPrice(activeAsks, 'asc').slice(0, UI_DISPLAY_LIMIT);
    return buildRows(visibleAsks).reverse();
  }, [activeAsks]);
  const bidRows = useMemo(() => {
    const visibleBids = sortLevelsByPrice(activeBids, 'desc').slice(0, UI_DISPLAY_LIMIT);
    return buildRows(visibleBids);
  }, [activeBids]);
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
  const depthDisplayStatus = shouldUseQuoteFallbackStatus
    ? quoteFallbackDisplayStatus
    : ownDepthDisplayStatus;
  const hasDepthQuoteStatus = depthDisplayStatus === 'LOADING'
    || hasConfirmedDepthStatus
    || shouldUseQuoteFallbackStatus;
  const depthStatusLabel = getQuoteStatusLabel(depthDisplayStatus, t);
  const titleLabel = depthDisplayStatus === 'LAST_QUOTE' || depthDisplayStatus === 'EXPIRED_LAST_QUOTE'
    ? t('lastQuoteLabel', 'contracts')
    : t('orderBook', 'contracts');

  return (
    <div className="tabular-nums flex h-full min-h-0 min-w-0 flex-col bg-[#11161d] px-2.5 py-2">
      <div className="mb-2 flex min-w-0 items-center justify-between gap-2">
        <div className="flex min-w-0 flex-nowrap items-center gap-2">
          <div className="shrink-0 whitespace-nowrap text-[13px] font-medium text-white/88">
            {titleLabel}
          </div>
          {hasDepthQuoteStatus ? (
            <div className={`shrink-0 whitespace-nowrap rounded-full border px-2 py-0.5 text-[10px] font-semibold ${quoteStatusBadgeClass(depthDisplayStatus)}`}>
              {isExpiredLastGoodBbo ? t('lastQuoteExpiredLabel', 'contracts') : depthStatusLabel}
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

      {activeLoading && askRows.length === 0 && bidRows.length === 0 ? (
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
            disabled={!onPriceSelect || lastPrice === '--'}
            onClick={() => onPriceSelect?.(String(lastPrice).replace(/,/g, ''))}
            className={`rounded-md border border-white/[0.05] bg-white/[0.02] px-2 py-1.5 text-center text-[17px] font-semibold leading-none transition-colors hover:bg-white/[0.05] disabled:cursor-default disabled:hover:bg-white/[0.02] ${priceClass}`}
          >
            {lastPrice}
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
