'use client';

import React, { useMemo, useState } from 'react';
import { useLocaleContext } from '@/contexts/LocaleContext';
import {
  type SpotDepthLevel,
} from '@/lib/api/modules/spot';
import { normalizeSide } from './orderbook/orderbook.utils';
import { formatSpotPrice } from './spotPricePrecision';
import {
  getTickerDirectionTextClass,
  type PriceDirection,
} from './spotTickerColor';

type SpotOrderBookProps = {
  symbol: string;
  displaySymbol?: string | null;
  referencePrice?: string;
  priceDirection?: PriceDirection;
  tradeDirection?: PriceDirection;
  hasTradeDirection?: boolean;
  pricePrecision: number;
  asks?: SpotDepthLevel[];
  bids?: SpotDepthLevel[];
  bestAsk?: string | number | null;
  bestBid?: string | number | null;
  depthSource?: string | null;
  depthFreshness?: string | null;
  displayPriceSource?: string | null;
  displayPriceFreshness?: string | null;
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

type OrderBookMode = 'ALL' | 'BUY_ONLY' | 'SELL_ONLY';

const ORDERBOOK_LEVEL_LIMIT = 9;
const ORDERBOOK_SINGLE_SIDE_LEVEL_LIMIT = ORDERBOOK_LEVEL_LIMIT * 2;
type OrderRowSlot = OrderRow | null;

type OrderBookDepthRatio = {
  buy: number;
  sell: number;
};

const ORDERBOOK_MODE_LABELS: Record<string, Record<OrderBookMode, string>> = {
  en: { ALL: 'All', BUY_ONLY: 'Bids', SELL_ONLY: 'Asks' },
  zh: { ALL: '全部', BUY_ONLY: '买盘', SELL_ONLY: '卖盘' },
  'zh-TW': { ALL: '全部', BUY_ONLY: '買盤', SELL_ONLY: '賣盤' },
  ja: { ALL: 'すべて', BUY_ONLY: '買い板', SELL_ONLY: '売り板' },
};

function OrderBookModeIcon({ mode, active }: { mode: OrderBookMode; active: boolean }) {
  const askBars = mode === 'ALL' || mode === 'SELL_ONLY';
  const bidBars = mode === 'ALL' || mode === 'BUY_ONLY';

  return (
    <svg
      aria-hidden="true"
      className={`h-4 w-4 transition-[opacity,filter] ${
        active
          ? 'opacity-100 brightness-125 drop-shadow-[0_0_3px_rgba(255,255,255,0.18)]'
          : 'opacity-35 saturate-50'
      }`}
      data-testid={`spot-orderbook-mode-icon-${mode}`}
      focusable="false"
      viewBox="0 0 14 14"
    >
      {askBars ? (
        <>
          <rect fill="#f6465d" height="1.5" opacity="0.9" rx="0.5" width="12" x="1" y="1.5" />
          <rect fill="#f6465d" height="1.5" opacity="0.7" rx="0.5" width="9" x="4" y="4.25" />
        </>
      ) : null}
      {bidBars ? (
        <>
          <rect fill="#00c087" height="1.5" opacity="0.7" rx="0.5" width="9" x="1" y="8.25" />
          <rect fill="#00c087" height="1.5" opacity="0.9" rx="0.5" width="12" x="1" y="11" />
        </>
      ) : null}
    </svg>
  );
}

const UNAVAILABLE_DEPTH_RATIO_VALUES = new Set([
  'MISSING',
  'UNAVAILABLE',
  'ERROR',
  'FAILED',
  'STALE',
  'FALLBACK',
  'LAST_GOOD',
  'LAST_VALID',
]);

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

function sumValidDepthAmount(levels: SpotDepthLevel[]): number {
  return levels.reduce((sum, level) => {
    const amount = Number(level.amount);
    return Number.isFinite(amount) && amount > 0 ? sum + amount : sum;
  }, 0);
}

function calculateDepthRatio(
  bids: SpotDepthLevel[],
  asks: SpotDepthLevel[],
  depthSource?: string | null,
  depthFreshness?: string | null,
): OrderBookDepthRatio | null {
  const source = String(depthSource || '').trim().toUpperCase();
  const freshness = String(depthFreshness || '').trim().toUpperCase();
  if (UNAVAILABLE_DEPTH_RATIO_VALUES.has(source) || UNAVAILABLE_DEPTH_RATIO_VALUES.has(freshness)) {
    return null;
  }

  const bidVolume = sumValidDepthAmount(bids);
  const askVolume = sumValidDepthAmount(asks);
  const totalVolume = bidVolume + askVolume;
  if (!Number.isFinite(totalVolume) || totalVolume <= 0) return null;

  return {
    buy: (bidVolume / totalVolume) * 100,
    sell: (askVolume / totalVolume) * 100,
  };
}

function padRows(rows: OrderRow[], align: 'top' | 'bottom', limit: number): OrderRowSlot[] {
  const nextRows = rows.slice(0, limit);
  const emptyRows = Array<OrderRowSlot>(Math.max(limit - nextRows.length, 0)).fill(null);
  return align === 'bottom' ? [...emptyRows, ...nextRows] : [...nextRows, ...emptyRows];
}

export default function SpotOrderBook({
  referencePrice = '--',
  priceDirection = 'flat',
  tradeDirection = 'flat',
  hasTradeDirection = false,
  pricePrecision,
  asks: propAsks = [],
  bids: propBids = [],
  depthSource,
  depthFreshness,
  displayPriceSource,
  displayPriceFreshness,
  isLoading = false,
  onPriceClick,
}: SpotOrderBookProps) {
  const { locale, t } = useLocaleContext();
  const [mode, setMode] = useState<OrderBookMode>('ALL');
  const levelLimit = mode === 'ALL' ? ORDERBOOK_LEVEL_LIMIT : ORDERBOOK_SINGLE_SIDE_LEVEL_LIMIT;
  const modeLabels = ORDERBOOK_MODE_LABELS[locale] || ORDERBOOK_MODE_LABELS.en;
  const normalizedAsks = useMemo(
    () => normalizeSide(propAsks, 'asks', ORDERBOOK_SINGLE_SIDE_LEVEL_LIMIT),
    [propAsks],
  );
  const normalizedBids = useMemo(
    () => normalizeSide(propBids, 'bids', ORDERBOOK_SINGLE_SIDE_LEVEL_LIMIT),
    [propBids],
  );
  const asks = useMemo(() => normalizedAsks.slice(0, levelLimit), [levelLimit, normalizedAsks]);
  const bids = useMemo(() => normalizedBids.slice(0, levelLimit), [levelLimit, normalizedBids]);
  const depthRatio = useMemo(
    () => calculateDepthRatio(
      normalizedBids.slice(0, ORDERBOOK_LEVEL_LIMIT),
      normalizedAsks.slice(0, ORDERBOOK_LEVEL_LIMIT),
      depthSource,
      depthFreshness,
    ),
    [depthFreshness, depthSource, normalizedAsks, normalizedBids],
  );

  const askRows = useMemo(() => buildRows(asks).reverse(), [asks]);
  const bidRows = useMemo(() => buildRows(bids), [bids]);
  const askSlots = useMemo(() => padRows(askRows, 'bottom', levelLimit), [askRows, levelLimit]);
  const bidSlots = useMemo(() => padRows(bidRows, 'top', levelLimit), [bidRows, levelLimit]);

  const showAsks = mode !== 'BUY_ONLY';
  const showBids = mode !== 'SELL_ONLY';
  const hasDepth = (showAsks && askRows.length > 0) || (showBids && bidRows.length > 0);
  const referencePriceClass = getTickerDirectionTextClass(priceDirection);
  const directionArrow = hasTradeDirection && tradeDirection === 'up'
    ? { symbol: '↑', colorClass: 'text-[#00c087]' }
    : hasTradeDirection && tradeDirection === 'down'
      ? { symbol: '↓', colorClass: 'text-[#f6465d]' }
      : null;
  const contentGridClass = mode === 'ALL'
    ? 'grid-rows-[minmax(0,1fr)_auto_minmax(0,1fr)]'
    : mode === 'BUY_ONLY'
      ? 'grid-rows-[auto_minmax(0,1fr)]'
      : 'grid-rows-[minmax(0,1fr)_auto]';

  return (
    <div className="tabular-nums flex h-full min-h-0 min-w-0 flex-col bg-[#11161d] px-2.5 pb-1 pt-2.5">
      <div
        className="mb-1.5 flex min-h-6 items-center justify-start"
        data-testid="spot-orderbook-mode-toolbar"
      >
        <div
          className="inline-flex h-6 shrink-0 items-center gap-1.5"
          role="group"
          aria-label={t('spotOrderBook', 'asset')}
        >
          {(Object.keys(modeLabels) as OrderBookMode[]).map((item) => (
            <button
              key={item}
              type="button"
              aria-pressed={mode === item}
              aria-label={modeLabels[item]}
              onClick={() => setMode(item)}
              title={modeLabels[item]}
              className="inline-flex h-6 w-6 items-center justify-center rounded-sm border-0 bg-transparent transition-colors hover:bg-white/[0.035]"
            >
              <OrderBookModeIcon mode={item} active={mode === item} />
            </button>
          ))}
        </div>
      </div>

      <div className="mb-1 grid grid-cols-3 px-1.5 text-[11px] font-medium leading-4 text-gray-400">
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
        <div className={`grid min-h-0 flex-1 gap-1 ${contentGridClass}`}>
          {showAsks ? (
            <div
              className="grid min-h-0 gap-px overflow-hidden"
              style={{ gridTemplateRows: `repeat(${levelLimit}, minmax(0, 1fr))` }}
            >
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
          ) : null}

          <button
            type="button"
            disabled={!onPriceClick || referencePrice === '--'}
            onClick={() => onPriceClick?.(String(referencePrice).replace(/,/g, ''))}
            title={t('spotLatestPrice', 'asset')}
            aria-label={t('spotLatestPrice', 'asset')}
            data-testid="spot-orderbook-display-price"
            data-display-source={displayPriceSource || ''}
            data-display-freshness={displayPriceFreshness || ''}
            className={`flex items-center justify-center rounded-md border border-white/[0.05] bg-white/[0.02] px-2 py-1.5 text-center text-[17px] font-semibold leading-none transition-colors hover:bg-white/[0.05] disabled:cursor-default disabled:hover:bg-white/[0.02] ${referencePriceClass}`}
          >
            <span>{referencePrice}</span>
            {directionArrow ? (
              <span
                aria-hidden="true"
                className={`ml-1.5 text-[15px] font-black leading-none ${directionArrow.colorClass}`}
                data-testid="spot-orderbook-price-direction"
              >
                {directionArrow.symbol}
              </span>
            ) : null}
          </button>

          {showBids ? (
            <div
              className="grid min-h-0 gap-px overflow-hidden"
              style={{ gridTemplateRows: `repeat(${levelLimit}, minmax(0, 1fr))` }}
            >
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
          ) : null}
        </div>
      )}

      <div
        className="mt-0.5 shrink-0 border-t border-white/[0.05] pt-1"
        data-testid="spot-orderbook-depth-ratio"
      >
        <div
          className="relative h-6 overflow-hidden rounded-sm border border-white/[0.06] bg-[#090d12]"
          data-testid="spot-orderbook-depth-ratio-bar"
        >
          {depthRatio ? (
            <>
              <span
                className="absolute inset-y-0 left-0"
                data-testid="spot-orderbook-buy-ratio-bar"
                style={{
                  width: `${depthRatio.buy}%`,
                  backgroundColor: 'rgba(0, 192, 135, 0.10)',
                }}
              />
              <span
                className="absolute inset-y-0 right-0"
                data-testid="spot-orderbook-sell-ratio-bar"
                style={{
                  width: `${depthRatio.sell}%`,
                  backgroundColor: 'rgba(246, 70, 93, 0.11)',
                }}
              />
              <span
                aria-hidden="true"
                className="absolute inset-y-0 z-[1] w-2 -translate-x-1/2 bg-[#11161d]/85"
                style={{ left: `${depthRatio.buy}%`, transform: 'translateX(-50%) skewX(-18deg)' }}
              />
            </>
          ) : null}
          <div className="relative z-[2] flex h-full items-center justify-between px-1 text-[11px] font-medium leading-none">
            <span className={`inline-flex items-center gap-1 ${depthRatio ? 'text-[#00c087]' : 'text-white/30'}`}>
              <span
                className={`inline-flex h-4 min-w-4 items-center justify-center rounded-[2px] border px-0.5 ${
                  depthRatio ? 'border-[#00c087]/70' : 'border-white/15'
                }`}
                data-testid="spot-orderbook-buy-ratio-label"
              >
                B
              </span>
              <span data-testid="spot-orderbook-buy-ratio">
                {depthRatio ? `${depthRatio.buy.toFixed(2)}%` : '--'}
              </span>
            </span>
            <span className={`inline-flex items-center gap-1 ${depthRatio ? 'text-[#f6465d]' : 'text-white/30'}`}>
              <span data-testid="spot-orderbook-sell-ratio">
                {depthRatio ? `${depthRatio.sell.toFixed(2)}%` : '--'}
              </span>
              <span
                className={`inline-flex h-4 min-w-4 items-center justify-center rounded-[2px] border px-0.5 ${
                  depthRatio ? 'border-[#f6465d]/70' : 'border-white/15'
                }`}
                data-testid="spot-orderbook-sell-ratio-label"
              >
                S
              </span>
            </span>
          </div>
        </div>
      </div>
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
      className="relative grid h-full min-h-0 cursor-pointer grid-cols-3 items-center overflow-hidden rounded-[6px] px-1.5 text-left text-[12px] font-medium leading-4 tabular-nums transition-colors hover:bg-white/[0.035]"
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
