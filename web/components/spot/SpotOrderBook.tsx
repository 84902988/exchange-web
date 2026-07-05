'use client';

import React, { useMemo } from 'react';
import { useLocaleContext } from '@/contexts/LocaleContext';
import {
  type SpotDepthLevel,
} from '@/lib/api/modules/spot';
import { normalizeSide } from './orderbook/orderbook.utils';
import { formatSpotDisplaySymbol } from './spotFormat';
import { formatSpotPrice } from './spotPricePrecision';
import {
  getTickerDirectionTextClass,
  type PriceDirection,
} from './spotTickerColor';
import {
  resolveSpotMarketStatus,
  spotMarketStatusBadgeClass,
} from './spotMarketStatus';

type SpotOrderBookProps = {
  symbol: string;
  displaySymbol?: string | null;
  referencePrice?: string;
  priceDirection?: PriceDirection;
  pricePrecision: number;
  asks?: SpotDepthLevel[];
  bids?: SpotDepthLevel[];
  bestAsk?: string | number | null;
  bestBid?: string | number | null;
  depthSource?: string | null;
  depthFreshness?: string | null;
  dataSource?: string | null;
  isLoading?: boolean;
  onPriceClick?: (price: string) => void;
};

type OrderRow = {
  rawPrice: string;
  price: number;
  amount: number;
  total: number;
  widthPercent: number;
};

const ORDERBOOK_LEVEL_LIMIT = 9;
type OrderRowSlot = OrderRow | null;

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

function padRows(rows: OrderRow[], align: 'top' | 'bottom'): OrderRowSlot[] {
  const nextRows = rows.slice(0, ORDERBOOK_LEVEL_LIMIT);
  const emptyRows = Array<OrderRowSlot>(Math.max(ORDERBOOK_LEVEL_LIMIT - nextRows.length, 0)).fill(null);
  return align === 'bottom' ? [...emptyRows, ...nextRows] : [...nextRows, ...emptyRows];
}

export default function SpotOrderBook({
  symbol,
  displaySymbol,
  referencePrice = '--',
  priceDirection = 'flat',
  pricePrecision,
  asks: propAsks = [],
  bids: propBids = [],
  depthSource,
  depthFreshness,
  dataSource,
  isLoading = false,
  onPriceClick,
}: SpotOrderBookProps) {
  const { t } = useLocaleContext();
  const asks = useMemo(
    () => normalizeSide(propAsks, 'asks', ORDERBOOK_LEVEL_LIMIT),
    [propAsks],
  );
  const bids = useMemo(
    () => normalizeSide(propBids, 'bids', ORDERBOOK_LEVEL_LIMIT),
    [propBids],
  );

  const askRows = useMemo(() => buildRows(asks).reverse(), [asks]);
  const bidRows = useMemo(() => buildRows(bids), [bids]);
  const askSlots = useMemo(() => padRows(askRows, 'bottom'), [askRows]);
  const bidSlots = useMemo(() => padRows(bidRows, 'top'), [bidRows]);

  const hasDepth = askRows.length > 0 || bidRows.length > 0;
  const referencePriceClass = getTickerDirectionTextClass(priceDirection);
  const depthStatus = useMemo(
    () => resolveSpotMarketStatus({
      source: depthSource,
      freshness: depthFreshness,
      dataSource,
      isLoading,
    }),
    [dataSource, depthFreshness, depthSource, isLoading],
  );

  return (
    <div className="tabular-nums flex h-full min-h-0 min-w-0 flex-col bg-[#11161d] px-2.5 py-2">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="min-w-0 text-[13px] font-medium text-white/88">{t('spotOrderBook', 'asset')}</div>
        <div className="flex min-w-0 items-center gap-1.5">
          <span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${spotMarketStatusBadgeClass(depthStatus.kind)}`}>
            {depthStatus.label}
          </span>
          <span className="rounded-full bg-white/[0.03] px-2 py-0.5 text-[13px] font-medium text-white/42">
            {displaySymbol || formatSpotDisplaySymbol(symbol)}
          </span>
        </div>
      </div>

      <div className="mb-1.5 grid grid-cols-3 px-1 text-[11px] font-medium text-gray-400">
        <div>{t('spotPrice', 'asset')}</div>
        <div className="text-center">{t('spotQuantity', 'asset')}</div>
        <div className="text-right">{t('spotTotal', 'asset')}</div>
      </div>

      {isLoading && !hasDepth ? (
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
            {askSlots.map((row, index) => (
              row ? (
                <BookRow
                  key={`ask-${row.rawPrice}`}
                  row={row}
                  side="ask"
                  pricePrecision={pricePrecision}
                  onPriceClick={onPriceClick}
                />
              ) : (
                <EmptyBookRow key={`ask-empty-${index}`} />
              )
            ))}
          </div>

          <button
            type="button"
            disabled={!onPriceClick || referencePrice === '--'}
            onClick={() => onPriceClick?.(String(referencePrice).replace(/,/g, ''))}
            title="Latest Price"
            aria-label="Latest Price"
            className={`rounded-md border border-white/[0.05] bg-white/[0.02] px-2 py-1.5 text-center text-[17px] font-semibold leading-none transition-colors hover:bg-white/[0.05] disabled:cursor-default disabled:hover:bg-white/[0.02] ${referencePriceClass}`}
          >
            {referencePrice}
          </button>

          <div className="grid min-h-0 grid-rows-9 gap-px overflow-hidden">
            {bidSlots.map((row, index) => (
              row ? (
                <BookRow
                  key={`bid-${row.rawPrice}`}
                  row={row}
                  side="bid"
                  pricePrecision={pricePrecision}
                  onPriceClick={onPriceClick}
                />
              ) : (
                <EmptyBookRow key={`bid-empty-${index}`} />
              )
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function EmptyBookRow() {
  return (
    <div className="grid h-full min-h-0 grid-cols-3 items-center rounded-[6px] px-1.5 text-[12px] leading-4">
      <span className="px-0.5 text-left text-white/12">--</span>
      <span className="px-0.5 text-center text-white/12">--</span>
      <span className="text-right text-white/12">--</span>
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
        {formatSpotPrice(row.price, pricePrecision)}
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
