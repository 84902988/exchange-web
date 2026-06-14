'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useLocaleContext } from '@/contexts/LocaleContext';
import {
  getSpotDepth,
  isPollingSpotDataSource,
  type SpotMarketDataSource,
  type SpotDepthLevel,
  type SpotDepthResponse,
} from '@/lib/api/modules/spot';
import {
  normalizeSide,
  patchSide,
} from './orderbook/orderbook.utils';
import { formatPrice } from '@/lib/marketPrecision';
import {
  spotMarketRealtime,
  type SpotMarketRealtimeMessage,
} from '@/services/marketRealtime';
import { formatSpotDisplaySymbol } from './spotFormat';
import {
  getTickerDirectionTextClass,
  type PriceDirection,
} from './spotTickerColor';

type SpotOrderBookProps = {
  symbol: string;
  displaySymbol?: string | null;
  lastPrice?: string;
  priceDirection?: PriceDirection;
  pricePrecision: number;
  onPriceClick?: (price: string) => void;
  refreshNonce?: number;
  dataSource?: SpotMarketDataSource | string | null;
  onDepthStateChange?: (hasDepth: boolean) => void;
  onDepthDataChange?: (depth: {
    asks: SpotDepthLevel[];
    bids: SpotDepthLevel[];
    pricePrecision?: number;
    lastPrice?: string | number;
    midPrice?: string | number;
    source?: string;
    fetchedAt?: number;
  }) => void;
  initialDepth?: {
    asks: SpotDepthLevel[];
    bids: SpotDepthLevel[];
    pricePrecision?: number;
    lastPrice?: string | number;
    midPrice?: string | number;
    source?: string;
    fetchedAt?: number;
  };
};

type OrderRow = {
  rawPrice: string;
  price: number;
  amount: number;
  total: number;
  widthPercent: number;
};

type WsDepthMessage = {
  type: 'spot_depth_update';
  symbol: string;
  depth?: {
    symbol?: string;
    bids?: SpotDepthLevel[];
    asks?: SpotDepthLevel[];
    ts?: number;
  };
};

type WsSnapshotMessage = {
  type: 'spot_market_snapshot';
  symbol: string;
  depth?: {
    symbol?: string;
    bids?: SpotDepthLevel[];
    asks?: SpotDepthLevel[];
    ts?: number;
  };
};

const ORDERBOOK_LEVEL_LIMIT = 9;
const DEPTH_POLL_MS = 1500;

function toNum(v: string | number | undefined | null): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function formatBookAmount(value: number): string {
  if (!Number.isFinite(value)) return '--';
  if (value === 0) return '0';
  if (Math.abs(value) < 0.001) {
    return value.toFixed(6).replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1');
  }
  return value.toFixed(3);
}

function buildRows(levels: SpotDepthLevel[]): OrderRow[] {
  if (!levels?.length) return [];

  const maxAmount = Math.max(...levels.map((item) => toNum(item.amount)), 1);
  let total = 0;

  return levels.map((item) => {
    const amount = toNum(item.amount);
    total += amount;

    return {
      rawPrice: String(item.price),
      price: toNum(item.price),
      amount,
      total,
      widthPercent: Math.min((amount / maxAmount) * 100, 100),
    };
  });
}

export default function SpotOrderBook({
  symbol,
  displaySymbol,
  lastPrice = '--',
  priceDirection = 'flat',
  pricePrecision,
  dataSource,
  initialDepth,
  onPriceClick,
  onDepthStateChange,
  onDepthDataChange,
}: SpotOrderBookProps) {
  const { t } = useLocaleContext();
  const [asks, setAsks] = useState<SpotDepthLevel[]>([]);
  const [bids, setBids] = useState<SpotDepthLevel[]>([]);
  const [loading, setLoading] = useState(true);

  const snapshotReadyRef = useRef(false);
  const currentSymbolRef = useRef('');
  const asksRef = useRef<SpotDepthLevel[]>([]);
  const bidsRef = useRef<SpotDepthLevel[]>([]);
  const initialDepthRef = useRef(initialDepth);
  const onDepthStateChangeRef = useRef(onDepthStateChange);
  const onDepthDataChangeRef = useRef(onDepthDataChange);

  useEffect(() => {
    initialDepthRef.current = initialDepth;
  }, [initialDepth]);

  useEffect(() => {
    onDepthStateChangeRef.current = onDepthStateChange;
  }, [onDepthStateChange]);

  useEffect(() => {
    onDepthDataChangeRef.current = onDepthDataChange;
  }, [onDepthDataChange]);

  useEffect(() => {
    currentSymbolRef.current = String(symbol || '').toUpperCase();
  }, [symbol]);

  useEffect(() => {
    const normalizedSymbol = String(symbol || '').toUpperCase();
    const shouldPoll = isPollingSpotDataSource(dataSource);

    const cachedDepth = initialDepthRef.current;
    const cachedAsks = cachedDepth?.asks || [];
    const cachedBids = cachedDepth?.bids || [];
    if (cachedAsks.length > 0 || cachedBids.length > 0) {
      asksRef.current = cachedAsks;
      bidsRef.current = cachedBids;
      window.requestAnimationFrame(() => {
        if (!currentSymbolRef.current || currentSymbolRef.current !== normalizedSymbol) return;
        setAsks(cachedAsks);
        setBids(cachedBids);
      });
      onDepthDataChangeRef.current?.({
        asks: cachedAsks,
        bids: cachedBids,
        pricePrecision: cachedDepth?.pricePrecision,
        lastPrice: cachedDepth?.lastPrice,
        midPrice: cachedDepth?.midPrice,
        source: cachedDepth?.source,
        fetchedAt: cachedDepth?.fetchedAt,
      });
    }
    snapshotReadyRef.current = false;
    onDepthStateChangeRef.current?.(cachedAsks.length > 0 || cachedBids.length > 0);

    if (!normalizedSymbol) {
      return;
    }

    let alive = true;
    let pollTimer: number | null = null;

    const applyDepthSnapshot = (depth?: Partial<SpotDepthResponse> & {
      asks?: SpotDepthLevel[];
      bids?: SpotDepthLevel[];
      price_precision?: number;
    }) => {
      const nextAsks = normalizeSide(depth?.asks, 'asks', ORDERBOOK_LEVEL_LIMIT);
      const nextBids = normalizeSide(depth?.bids, 'bids', ORDERBOOK_LEVEL_LIMIT);
      const hasDepth = nextAsks.length > 0 || nextBids.length > 0;

      asksRef.current = nextAsks;
      bidsRef.current = nextBids;
      setAsks(nextAsks);
      setBids(nextBids);
      setLoading(false);
      onDepthStateChangeRef.current?.(hasDepth);
      onDepthDataChangeRef.current?.({
        asks: nextAsks,
        bids: nextBids,
        pricePrecision: depth?.price_precision,
        lastPrice: depth?.last_price,
        midPrice: depth?.mid_price,
        source: depth?.source,
        fetchedAt: depth?.fetched_at,
      });
      snapshotReadyRef.current = true;
    };

    const clearPollingTimer = () => {
      if (pollTimer !== null) {
        window.clearInterval(pollTimer);
        pollTimer = null;
      }
    };

    const loadDepthSnapshot = async () => {
      try {
        const depth = await getSpotDepth(normalizedSymbol, ORDERBOOK_LEVEL_LIMIT);

        if (!alive) return;

        applyDepthSnapshot(depth);
      } catch (err) {
        if (!alive) return;

        asksRef.current = [];
        bidsRef.current = [];
        setAsks([]);
        setBids([]);
        onDepthStateChangeRef.current?.(false);
        onDepthDataChangeRef.current?.({ asks: [], bids: [] });
        setLoading(false);
        console.error('[SpotOrderBook] depth load failed:', err);
      }
    };

    let unsubscribeSnapshot: (() => void) | null = null;
    let unsubscribeDepth: (() => void) | null = null;

    const handleRealtimeMessage = (message: SpotMarketRealtimeMessage) => {
      if (!alive) return;

      const data = message as WsDepthMessage | WsSnapshotMessage;
      const msgSymbol = String(data?.symbol || data?.depth?.symbol || '').toUpperCase();
      const currentSymbol = currentSymbolRef.current;

      if (!msgSymbol || msgSymbol !== currentSymbol) {
        return;
      }

      if (data.type === 'spot_market_snapshot') {
        applyDepthSnapshot(data.depth || {});
        return;
      }

      if (data.type === 'spot_depth_update') {
        if (!snapshotReadyRef.current) return;

        const depth = data.depth || {};
        const nextAsks = patchSide(
          asksRef.current,
          depth.asks,
          'asks',
          ORDERBOOK_LEVEL_LIMIT
        );
        const nextBids = patchSide(
          bidsRef.current,
          depth.bids,
          'bids',
          ORDERBOOK_LEVEL_LIMIT
        );
        const hasDepth = nextAsks.length > 0 || nextBids.length > 0;

        asksRef.current = nextAsks;
        bidsRef.current = nextBids;
        setAsks(nextAsks);
        setBids(nextBids);
        setLoading(false);
        onDepthStateChangeRef.current?.(hasDepth);
        onDepthDataChangeRef.current?.({ asks: nextAsks, bids: nextBids });
      }
    };

    const subscribeRealtime = () => {
      if (!alive) return;

      snapshotReadyRef.current = false;
      spotMarketRealtime.setSymbol(normalizedSymbol);
      spotMarketRealtime.subscribe('snapshot', handleRealtimeMessage);
      spotMarketRealtime.subscribe('depth', handleRealtimeMessage);
      unsubscribeSnapshot = () => spotMarketRealtime.unsubscribe('snapshot', handleRealtimeMessage);
      unsubscribeDepth = () => spotMarketRealtime.unsubscribe('depth', handleRealtimeMessage);
    };

    if (shouldPoll) {
      void loadDepthSnapshot();
      pollTimer = window.setInterval(() => {
        void loadDepthSnapshot();
      }, DEPTH_POLL_MS);
    } else {
      void loadDepthSnapshot();
      subscribeRealtime();
    }

    return () => {
      alive = false;
      clearPollingTimer();
      unsubscribeSnapshot?.();
      unsubscribeDepth?.();
    };
  }, [dataSource, symbol]);

  const askRows = useMemo(() => buildRows(asks).reverse(), [asks]);
  const bidRows = useMemo(() => buildRows(bids), [bids]);

  const hasDepth = askRows.length > 0 || bidRows.length > 0;
  const lastPriceClass = getTickerDirectionTextClass(priceDirection);

  return (
    <div className="tabular-nums flex h-full min-h-0 min-w-0 flex-col bg-[#11161d] px-2.5 py-2">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-[13px] font-medium text-white/88">{t('spotOrderBook', 'asset')}</div>
        <div className="rounded-full bg-white/[0.03] px-2 py-0.5 text-[13px] font-medium text-white/42">
          {displaySymbol || formatSpotDisplaySymbol(symbol)}
        </div>
      </div>

      <div className="mb-1.5 grid grid-cols-3 px-1 text-[11px] font-medium text-gray-400">
        <div>{t('spotPrice', 'asset')}</div>
        <div className="text-center">{t('spotQuantity', 'asset')}</div>
        <div className="text-right">{t('spotTotal', 'asset')}</div>
      </div>

      {loading && !hasDepth ? (
        <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-white/40">
          {t('spotLoadingOrderBook', 'asset')}
        </div>
      ) : !hasDepth ? (
        <div className="relative flex min-h-0 flex-1 items-center justify-center text-sm text-transparent">
          <span className="absolute inset-0 flex items-center justify-center px-3 text-center text-white/40">
            {t('spotNoOrderBookData', 'asset')}
          </span>
          {t('spotNoOrderBookData', 'asset')}
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_auto_minmax(0,1fr)] gap-1">
          <div className="grid min-h-0 grid-rows-9 gap-px overflow-hidden">
            {askRows.map((row) => (
              <BookRow
                key={`ask-${row.rawPrice}`}
                row={row}
                side="ask"
                pricePrecision={pricePrecision}
                onPriceClick={onPriceClick}
              />
            ))}
          </div>

          <button
            type="button"
            disabled={!onPriceClick || lastPrice === '--'}
            onClick={() => onPriceClick?.(String(lastPrice).replace(/,/g, ''))}
            className={`rounded-md border border-white/[0.05] bg-white/[0.02] px-2 py-1.5 text-center text-[17px] font-semibold leading-none transition-colors hover:bg-white/[0.05] disabled:cursor-default disabled:hover:bg-white/[0.02] ${lastPriceClass}`}
          >
            {lastPrice}
          </button>

          <div className="grid min-h-0 grid-rows-9 gap-px overflow-hidden">
            {bidRows.map((row) => (
              <BookRow
                key={`bid-${row.rawPrice}`}
                row={row}
                side="bid"
                pricePrecision={pricePrecision}
                onPriceClick={onPriceClick}
              />
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
  onPriceClick,
}: {
  row: OrderRow;
  side: 'ask' | 'bid';
  pricePrecision: number;
  onPriceClick?: (price: string) => void;
}) {
  const colorClass = side === 'ask' ? 'text-[#f6465d]' : 'text-[#00c087]';
  const bgClass = side === 'ask' ? 'bg-[#f6465d]/10' : 'bg-[#00c087]/10';

  return (
    <button
      type="button"
      onClick={() => onPriceClick?.(row.rawPrice)}
      className="relative grid h-full min-h-0 cursor-pointer grid-cols-3 items-center overflow-hidden rounded-[6px] px-1.5 text-left text-[12px] leading-4 tabular-nums transition-colors hover:bg-white/[0.035]"
    >
      <div
        className={`pointer-events-none absolute right-0 top-0 h-full ${bgClass}`}
        style={{ width: `${row.widthPercent}%` }}
      />
      <div className={`relative truncate px-0.5 text-left font-medium ${colorClass}`}>
        {formatPrice(row.price, pricePrecision)}
      </div>
      <div className="relative truncate px-0.5 text-center text-white/86">
        {formatBookAmount(row.amount)}
      </div>
      <div className="relative text-right text-white/50">
        {formatBookAmount(row.total)}
      </div>
    </button>
  );
}
