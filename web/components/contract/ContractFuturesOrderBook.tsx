'use client';

import { useMemo } from 'react';
import {
  type ContractDepthLevel,
  type ContractDepthMode,
  type ContractMarketViewDetail,
  type ContractQuoteDisplayStatus,
} from '@/lib/api/modules/contract';
import { formatPrice } from '@/lib/marketPrecision';
import { useLocaleContext } from '@/contexts/LocaleContext';
import {
  getContractDomainStatusLabel,
  getContractMarketSourceLabel,
  getContractMarketSourceTone,
  getContractMarketSourceToneClass,
} from './contractMarketSourceStatus';

type ContractFuturesOrderBookProps = {
  priceDirection?: 'up' | 'down' | 'flat';
  pricePrecision: number;
  bids?: ContractDepthLevel[];
  asks?: ContractDepthLevel[];
  status?: ContractQuoteDisplayStatus | null;
  statusLabel?: string | null;
  centerPrice?: string | number | null;
  centerPriceReady?: boolean;
  centerPriceSource?: 'KLINE_CLOSE' | 'LIVE_MID' | 'TRADE_TICK';
  centerPriceLabel?: string | null;
  bestBid?: string | number | null;
  bestAsk?: string | number | null;
  spread?: string | number | null;
  marketView?: ContractMarketViewDetail | null;
  depthMode?: ContractDepthMode | null;
  depthSource?: string | null;
  depthFreshness?: string | null;
  depthUpdatedAt?: number | null;
  loading?: boolean;
  error?: string | null;
  onPriceClick?: (price: string) => void;
  onPriceSelect?: (price: string) => void;
  onBestBidAskChange?: (best: {
    bestBid: string | null;
    bestAsk: string | null;
    source?: string | null;
    depthMode?: ContractDepthMode | null;
    ts?: string | number | null;
    bidsCount?: number;
    asksCount?: number;
  }) => void;
};

type Row = {
  rawPrice: string;
  price: number;
  amount: number;
  total: number;
  width: number;
};

const UI_DISPLAY_LIMIT = 9;

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

export default function ContractFuturesOrderBook({
  priceDirection = 'flat',
  pricePrecision,
  bids = [],
  asks = [],
  status,
  statusLabel,
  centerPrice,
  centerPriceReady = false,
  centerPriceSource = 'KLINE_CLOSE',
  centerPriceLabel,
  depthMode,
  marketView,
  depthSource,
  depthFreshness,
  loading = false,
  error,
  onPriceClick,
  onPriceSelect,
}: ContractFuturesOrderBookProps) {
  const { t } = useLocaleContext();
  const handlePriceSelect = onPriceClick || onPriceSelect;
  const normalizedDisplayDepthMode = normalizeDepthMode(depthMode);
  const displayStatus = status || (loading ? 'LOADING' : error ? 'UNAVAILABLE' : null);
  const depthStatusLabel = statusLabel || (displayStatus ? getQuoteStatusLabel(displayStatus, t) : null);
  const depthSourceValue = depthSource ?? marketView?.depth_source ?? null;
  const depthFreshnessValue = depthFreshness ?? marketView?.depth_freshness ?? null;
  const hasDepthSourceStatus = !!depthSourceValue || !!depthFreshnessValue;
  const depthSourceTone = getContractMarketSourceTone(depthSourceValue, depthFreshnessValue);
  const depthSourceStatusLabel = hasDepthSourceStatus
    ? getContractMarketSourceLabel(depthSourceValue, depthFreshnessValue, t)
    : null;
  const depthSourceStatusTitle = hasDepthSourceStatus
    ? getContractDomainStatusLabel('depth', depthSourceValue, depthFreshnessValue, t)
    : null;
  const displayDepthStatusLabel = depthSourceStatusLabel || depthStatusLabel;
  const displayDepthStatusClass = depthSourceStatusLabel
    ? getContractMarketSourceToneClass(depthSourceTone)
    : displayStatus
      ? quoteStatusBadgeClass(displayStatus)
      : 'border-white/10 bg-white/[0.05] text-white/58';
  const hasDepthQuoteStatus = !!displayDepthStatusLabel && (hasDepthSourceStatus || !!displayStatus);

  const askRows = useMemo(() => {
    const limit = normalizedDisplayDepthMode === 'BBO_ONLY' ? 1 : UI_DISPLAY_LIMIT;
    const visibleAsks = sortLevelsByPrice(asks, 'asc').slice(0, limit);
    return buildRows(visibleAsks).reverse();
  }, [asks, normalizedDisplayDepthMode]);
  const bidRows = useMemo(() => {
    const limit = normalizedDisplayDepthMode === 'BBO_ONLY' ? 1 : UI_DISPLAY_LIMIT;
    const visibleBids = sortLevelsByPrice(bids, 'desc').slice(0, limit);
    return buildRows(visibleBids);
  }, [bids, normalizedDisplayDepthMode]);

  const centerPriceNumber = toPositivePrice(centerPrice);
  const hasCenterPrice = centerPriceReady && centerPriceNumber !== null;
  const normalizedCenterPriceSource = normalizeCurrentPriceSource(centerPriceSource) || 'KLINE_CLOSE';
  const priceClass =
    priceDirection === 'up'
      ? 'text-[#00c087]'
      : priceDirection === 'down'
        ? 'text-[#f6465d]'
        : 'text-white';
  const depthModeLabel = getDepthModeLabel(depthMode);
  const centerDisplayPrice = !hasCenterPrice || centerPriceNumber === null
    ? '--'
    : formatPrice(centerPriceNumber, pricePrecision);
  const centerSelectPrice = !hasCenterPrice || centerPriceNumber === null
    ? null
    : String(centerPriceNumber);
  const centerLabel = normalizedCenterPriceSource === 'TRADE_TICK'
    ? centerPriceLabel || t('latestPrice', 'contracts')
    : normalizedCenterPriceSource === 'LIVE_MID'
      ? t('midPrice', 'contracts')
      : t('klineLatestPrice', 'contracts');

  return (
    <div className="tabular-nums flex h-full min-h-0 min-w-0 flex-col bg-[#11161d] px-2.5 py-2">
      {hasDepthQuoteStatus || depthModeLabel ? (
        <div className="mb-1.5 flex min-h-5 min-w-0 items-center gap-2 px-1">
          {hasDepthQuoteStatus ? (
            <div
              className={`shrink-0 whitespace-nowrap rounded-full border px-2 py-0.5 text-[10px] font-semibold ${displayDepthStatusClass}`}
              title={depthSourceStatusTitle || undefined}
            >
              {displayDepthStatusLabel}
            </div>
          ) : null}
          {depthModeLabel ? (
            <div className="shrink-0 whitespace-nowrap rounded-full border border-[#f0b90b]/25 bg-[#f0b90b]/10 px-2 py-0.5 text-[10px] font-semibold text-[#f0b90b]">
              {depthModeLabel}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="mb-1.5 grid grid-cols-3 px-1 text-[11px] font-medium text-gray-400">
        <div>{t('price', 'contracts')}</div>
        <div className="text-center">{t('amount', 'contracts')}</div>
        <div className="text-right">{t('total', 'contracts')}</div>
      </div>

      {loading && askRows.length === 0 && bidRows.length === 0 ? (
        <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-white/40">
          {t('loading', 'contracts')}
        </div>
      ) : askRows.length === 0 && bidRows.length === 0 ? (
        <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-white/40">
          {error ? t('marketDataUnavailable', 'contracts') : t('noOrderBookData', 'contracts')}
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_auto_minmax(0,1fr)] gap-1">
          <div className="grid min-h-0 grid-rows-9 gap-px overflow-hidden">
            {askRows.map((row) => (
              <BookRow key={`ask-${row.rawPrice}`} row={row} side="ask" pricePrecision={pricePrecision} onPriceSelect={handlePriceSelect} />
            ))}
          </div>

          <button
            type="button"
            aria-label={centerLabel}
            title={centerLabel}
            disabled={!handlePriceSelect || centerDisplayPrice === '--' || !centerSelectPrice}
            onClick={() => {
              if (centerSelectPrice) handlePriceSelect?.(centerSelectPrice);
            }}
            data-price-source={normalizedCenterPriceSource}
            className={`rounded-md border border-white/[0.05] bg-white/[0.02] px-2 py-1.5 text-center font-semibold leading-none transition-colors hover:bg-white/[0.05] disabled:cursor-default disabled:hover:bg-white/[0.02] ${priceClass}`}
          >
            <span className="block text-[17px] leading-none">{centerDisplayPrice}</span>
          </button>

          <div className="grid min-h-0 grid-rows-9 gap-px overflow-hidden">
            {bidRows.map((row) => (
              <BookRow key={`bid-${row.rawPrice}`} row={row} side="bid" pricePrecision={pricePrecision} onPriceSelect={handlePriceSelect} />
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
      className="relative grid h-full min-h-0 grid-cols-3 items-center overflow-hidden rounded-[6px] px-1.5 text-left text-[12px] font-medium leading-4 tabular-nums transition-colors hover:bg-white/[0.035]"
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
