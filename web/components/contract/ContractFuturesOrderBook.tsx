'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  getContractDepth,
  isExpiredLastGoodBboQuote,
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
  onPriceSelect?: (price: string) => void;
  onBestPricesChange?: (best: {
    bestBid: string | null;
    bestAsk: string | null;
    source?: string | null;
    bidsCount?: number;
    asksCount?: number;
  }) => void;
  initialDepth?: {
    asks: ContractDepthLevel[];
    bids: ContractDepthLevel[];
    source?: string | null;
  };
  onDepthDataChange?: (depth: {
    asks: ContractDepthLevel[];
    bids: ContractDepthLevel[];
    source?: string | null;
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

function toNumber(value?: string | number | null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
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
    asks: normalizeSide(asks, 'asks', FUTURES_DEPTH_LIMIT),
    bids: normalizeSide(bids, 'bids', FUTURES_DEPTH_LIMIT),
    source: typeof payload.source === 'string' ? payload.source : null,
    quoteSource: typeof payload.quote_source === 'string' ? payload.quote_source : null,
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
  onPriceSelect,
  onBestPricesChange,
  initialDepth,
  onDepthDataChange,
}: ContractFuturesOrderBookProps) {
  const { t } = useLocaleContext();
  const [asks, setAsks] = useState<ContractDepthLevel[]>([]);
  const [bids, setBids] = useState<ContractDepthLevel[]>([]);
  const [source, setSource] = useState<string | null>(null);
  const [depthMarketStatus, setDepthMarketStatus] = useState<string | null>(null);
  const [depthExecutable, setDepthExecutable] = useState<boolean | null>(null);
  const [depthQuoteSource, setDepthQuoteSource] = useState<string | null>(null);
  const [depthClosedMarketExecutionMode, setDepthClosedMarketExecutionMode] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const initialDepthRef = useRef(initialDepth);
  const onDepthDataChangeRef = useRef(onDepthDataChange);
  const isClosedMarketStatus = marketStatus === 'CLOSED' || marketStatus === 'HOLIDAY'
    || depthMarketStatus === 'CLOSED' || depthMarketStatus === 'HOLIDAY';
  const effectiveMarketStatus = isClosedMarketStatus
    ? 'CLOSED'
    : marketStatus || depthMarketStatus || null;

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
        setAsks(nextAsks);
        setBids(nextBids);
        setSource(depth.source);
        setDepthMarketStatus(depth.market_status || null);
        setDepthExecutable(depth.executable ?? null);
        setDepthQuoteSource(depth.quote_source || depth.source || null);
        setDepthClosedMarketExecutionMode(depth.closed_market_execution_mode || null);
        onDepthDataChangeRef.current?.({
          asks: nextAsks,
          bids: nextBids,
          source: depth.source,
        });
      } catch {
        if (!alive) return;
      } finally {
        if (alive) setLoading(false);
        polling = false;
      }
    }

    const cachedDepth = initialDepthRef.current;
    const cachedAsks = cachedDepth?.asks || [];
    const cachedBids = cachedDepth?.bids || [];
    if (cachedAsks.length > 0 || cachedBids.length > 0) {
      setAsks(cachedAsks);
      setBids(cachedBids);
      setSource(cachedDepth?.source || null);
      setDepthMarketStatus(null);
      setDepthExecutable(null);
      setDepthQuoteSource(null);
      setDepthClosedMarketExecutionMode(null);
      setLoading(false);
    } else {
      setAsks([]);
      setBids([]);
      setSource(null);
      setDepthMarketStatus(null);
      setDepthExecutable(null);
      setDepthQuoteSource(null);
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
  }, [marketRealtimeStatus, symbol]);

  useEffect(() => {
    const handleDepthMessage = (message: ContractMarketRealtimeMessage) => {
      if (effectiveMarketStatus === 'CLOSED') return;

      const depth = extractRealtimeDepth(message, symbol);
      if (!depth) return;

      setAsks(depth.asks);
      setBids(depth.bids);
      setSource(depth.source);
      setDepthMarketStatus(depth.marketStatus);
      setDepthExecutable(depth.executable);
      setDepthQuoteSource(depth.quoteSource || depth.source);
      setDepthClosedMarketExecutionMode(depth.closedMarketExecutionMode);
      setLoading(false);
      onDepthDataChangeRef.current?.(depth);
    };

    return contractMarketRealtime.subscribe('depth', handleDepthMessage);
  }, [effectiveMarketStatus, symbol]);

  const bestPrices = useMemo(
    () => ({
      // Best prices are derived by price, not by array or display order.
      bestAsk: minPrice(asks),
      bestBid: maxPrice(bids),
      source,
      bidsCount: bids.length,
      asksCount: asks.length,
    }),
    [asks, bids, source],
  );
  const lastBestPricesRef = useRef<{
    bestBid: string | null;
    bestAsk: string | null;
    source?: string | null;
    bidsCount?: number;
    asksCount?: number;
  }>({
    bestBid: null,
    bestAsk: null,
    source: null,
    bidsCount: 0,
    asksCount: 0,
  });

  useEffect(() => {
    const previous = lastBestPricesRef.current;
    if (
      previous.bestBid === bestPrices.bestBid &&
      previous.bestAsk === bestPrices.bestAsk &&
      previous.source === bestPrices.source &&
      previous.bidsCount === bestPrices.bidsCount &&
      previous.asksCount === bestPrices.asksCount
    ) return;
    lastBestPricesRef.current = bestPrices;
    onBestPricesChange?.(bestPrices);
  }, [bestPrices, onBestPricesChange]);

  const askRows = useMemo(() => {
    const visibleAsks = sortLevelsByPrice(asks, 'asc').slice(0, UI_DISPLAY_LIMIT);
    return buildRows(visibleAsks).reverse();
  }, [asks]);
  const bidRows = useMemo(() => {
    const visibleBids = sortLevelsByPrice(bids, 'desc').slice(0, UI_DISPLAY_LIMIT);
    return buildRows(visibleBids);
  }, [bids]);
  const priceClass =
    priceDirection === 'up'
      ? 'text-[#00c087]'
      : priceDirection === 'down'
        ? 'text-[#f6465d]'
        : 'text-white';
  const isExpiredLastGoodBbo = isExpiredLastGoodBboQuote({
    executable: depthExecutable ?? undefined,
    market_status: depthMarketStatus || effectiveMarketStatus || undefined,
    closed_market_execution_mode: depthClosedMarketExecutionMode || undefined,
    quote_source: depthQuoteSource || undefined,
    source,
  });

  return (
    <div className="tabular-nums flex h-full min-h-0 min-w-0 flex-col bg-[#11161d] px-2.5 py-2">
      <div className="mb-2 flex min-w-0 items-center justify-between gap-2">
        <div className="flex min-w-0 flex-nowrap items-center gap-2">
          <div className="shrink-0 whitespace-nowrap text-[13px] font-medium text-white/88">{t('orderBook', 'contracts')}</div>
          {effectiveMarketStatus === 'CLOSED' && depthExecutable !== false ? (
            <div className="shrink-0 whitespace-nowrap rounded-full border border-[#f0b90b]/20 bg-[#f0b90b]/10 px-2 py-0.5 text-[10px] font-semibold text-[#f0b90b]">
              {t('platformQuote', 'contracts')}
            </div>
          ) : null}
          {depthExecutable === false ? (
            <div className="shrink-0 whitespace-nowrap rounded-full border border-[#f6465d]/20 bg-[#f6465d]/10 px-2 py-0.5 text-[10px] font-semibold text-[#f6465d]">
              {t(isExpiredLastGoodBbo ? 'lastGoodBboExpiredBadge' : 'quoteUnavailableShort', 'contracts')}
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

      {loading && askRows.length === 0 && bidRows.length === 0 ? (
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
