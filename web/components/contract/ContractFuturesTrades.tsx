'use client';

import { useMemo } from 'react';
import {
  type ContractMarketTrade,
} from '@/lib/api/modules/contract';
import { formatPrice as formatMarketPrice } from '@/lib/marketPrecision';
import { useLocaleContext } from '@/contexts/LocaleContext';
import {
  getContractDomainStatusLabel,
  getContractMarketSourceLabel,
  getContractMarketSourceTone,
  getContractMarketSourceToneClass,
} from './contractMarketSourceStatus';

type PriceDirection = 'up' | 'down' | 'flat';

type ContractFuturesTradesProps = {
  symbol: string;
  trades?: ContractMarketTrade[];
  loading?: boolean;
  error?: string | null;
  status?: string | null;
  source?: string | null;
  freshness?: string | null;
  pricePrecision: number;
  latestPriceDirection?: PriceDirection;
  onPriceClick?: (price: string) => void;
  onPriceSelect?: (price: string) => void;
};

function toNumber(value?: string | number | null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function formatPrice(value: string | number, precision: number) {
  const n = toNumber(value);
  return n ? formatMarketPrice(n, precision) : '--';
}

function formatAmount(value: string | number) {
  const n = toNumber(value);
  return n ? n.toFixed(6) : '--';
}

function formatTime(value: number) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--:--:--';
  return date.toLocaleTimeString('zh-CN', { hour12: false });
}

export default function ContractFuturesTrades({
  symbol,
  trades = [],
  loading = false,
  status,
  source,
  freshness,
  pricePrecision,
  latestPriceDirection,
  onPriceClick,
  onPriceSelect,
}: ContractFuturesTradesProps) {
  const { t } = useLocaleContext();
  const handlePriceSelect = onPriceClick || onPriceSelect;
  const normalizedStatus = String(status || '').trim().toUpperCase();
  const hasTradesSourceStatus = !!source || !!freshness;
  const tradesSourceTone = getContractMarketSourceTone(source, freshness);
  const tradesSourceStatusLabel = hasTradesSourceStatus
    ? getContractMarketSourceLabel(source, freshness, t)
    : null;
  const tradesSourceStatusTitle = hasTradesSourceStatus
    ? getContractDomainStatusLabel('trades', source, freshness, t)
    : null;

  const data = useMemo(() => {
    return trades.map((item, index) => {
      const next = trades[index + 1];
      const currentPrice = toNumber(item.price);
      const prevPrice = next ? toNumber(next.price) : currentPrice;
      return {
        ...item,
        direction: index === 0 && latestPriceDirection
          ? latestPriceDirection
          : currentPrice > prevPrice
            ? 'up'
            : currentPrice < prevPrice
              ? 'down'
              : 'flat',
      };
    });
  }, [latestPriceDirection, trades]);

  return (
    <div className="tabular-nums flex h-full min-h-0 min-w-0 flex-col bg-[#11161d] px-2.5 py-2">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="text-[13px] font-medium text-white/88">{t('marketTrades', 'contracts')}</div>
          {tradesSourceStatusLabel ? (
            <div
              className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${getContractMarketSourceToneClass(tradesSourceTone)}`}
              title={tradesSourceStatusTitle || undefined}
            >
              {tradesSourceStatusLabel}
            </div>
          ) : null}
          {normalizedStatus === 'CLOSED' ? (
            <div className="rounded-full border border-[#f0b90b]/20 bg-[#f0b90b]/10 px-2 py-0.5 text-[11px] font-semibold text-[#f0b90b]">
              {t('closedNoRealtimeTrades', 'contracts')}
            </div>
          ) : null}
        </div>
        <div className="rounded-full bg-white/[0.03] px-2 py-0.5 text-[13px] font-medium text-white/42">
          {symbol}
        </div>
      </div>

      {loading && data.length === 0 ? (
        <div className="flex min-h-0 flex-1 items-center justify-center px-2.5 py-6 text-sm text-zinc-400">
          {t('loading', 'contracts')}
        </div>
      ) : data.length === 0 ? (
        <div className="flex min-h-0 flex-1 items-center justify-center px-2.5 py-6 text-sm text-zinc-400">
          {t('noTradeData', 'contracts')}
        </div>
      ) : (
        <>
          <div className="mb-1.5 grid grid-cols-[minmax(0,1.18fr)_minmax(0,0.92fr)_60px] items-center gap-x-2 px-1 text-[11px] font-medium text-gray-400">
            <div>{t('price', 'contracts')}</div>
            <div className="text-right">{t('amount', 'contracts')}</div>
            <div className="text-right">{t('time', 'contracts')}</div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-color:#3f3f46_transparent] [scrollbar-width:thin] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-zinc-700/60 hover:[&::-webkit-scrollbar-thumb]:bg-zinc-500/80">
            {data.map((item) => {
              const priceClass =
                item.direction === 'up'
                  ? 'text-[#00c087]'
                  : item.direction === 'down'
                    ? 'text-[#f6465d]'
                    : 'text-zinc-200';

              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => handlePriceSelect?.(item.price)}
                  className="grid w-full grid-cols-[minmax(0,1.18fr)_minmax(0,0.92fr)_60px] items-center gap-x-2 rounded-[6px] px-1.5 py-1 text-[12px] transition-colors hover:bg-white/[0.035]"
                >
                  <div className={`overflow-hidden text-ellipsis whitespace-nowrap text-left font-medium ${priceClass}`}>
                    {formatPrice(item.price, pricePrecision)}
                  </div>
                  <div className="overflow-hidden text-ellipsis whitespace-nowrap text-right text-zinc-200/90">
                    {formatAmount(item.qty)}
                  </div>
                  <div className="text-right text-zinc-400">{formatTime(item.time)}</div>
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
