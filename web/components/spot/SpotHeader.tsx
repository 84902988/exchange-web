'use client';

import React, { useEffect, useMemo, useState } from 'react';
import MarketStatusBadge from '@/components/market/MarketStatusBadge';
import { useLocaleContext } from '@/contexts/LocaleContext';
import { formatSpotDisplaySymbol } from './spotFormat';
import {
  getTickerDirectionFlashClass,
  getTickerDirectionTextClass,
  type PriceDirection,
} from './spotTickerColor';

interface SpotHeaderProps {
  symbol: string;
  displaySymbol?: string | null;
  price: string;
  change: string;
  changeAmount: string;
  highLow: string;
  volume: string;
  turnover: string;
  priceDirection?: PriceDirection;
  marketStatus?: string | null;
  quoteFreshness?: string | null;
  tickerSource?: string | null;
  tickerFreshness?: string | null;
  dataSource?: string | null;
  isLoading?: boolean;
  marketSessionType?: string | null;
}

export default function SpotHeader({
  symbol,
  displaySymbol,
  price,
  change,
  changeAmount,
  highLow,
  volume,
  turnover,
  priceDirection = 'flat',
  marketStatus,
  quoteFreshness,
  marketSessionType,
}: SpotHeaderProps) {
  const { t } = useLocaleContext();
  const [flash, setFlash] = useState(false);

  useEffect(() => {
    if (!price || price === '--') return;

    const startTimer = window.setTimeout(() => {
      setFlash(true);
    }, 0);
    const timer = window.setTimeout(() => {
      setFlash(false);
    }, 320);

    return () => {
      window.clearTimeout(startTimer);
      window.clearTimeout(timer);
    };
  }, [price]);

  const isChangeUp = change.startsWith('+');
  const isChangeDown = change.startsWith('-');

  const priceColorClass = getTickerDirectionTextClass(priceDirection);
  const priceFlashClass = flash ? getTickerDirectionFlashClass(priceDirection) : '';

  const statColorClass = useMemo(() => {
    if (isChangeUp) return 'text-[#00c087]';
    if (isChangeDown) return 'text-[#f6465d]';
    return 'text-white';
  }, [isChangeUp, isChangeDown]);

  return (
    <div className="tabular-nums border-b border-white/[0.06] bg-[#11161d] px-3 py-2 shadow-[inset_0_-1px_0_rgba(255,255,255,0.02)]">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3 xl:flex-nowrap">
        <div className="flex shrink-0 flex-col justify-center gap-1.5 whitespace-nowrap">
          <div className="text-[13px] font-medium text-white/42">
            <span>{displaySymbol || formatSpotDisplaySymbol(symbol)}</span>
            <MarketStatusBadge
              marketStatus={marketStatus}
              quoteFreshness={quoteFreshness}
              marketSessionType={marketSessionType}
              className="ml-2"
            />
          </div>
          <div
            className={`inline-flex w-fit items-center rounded-lg px-2 py-0.5 text-[30px] font-semibold leading-none transition-all duration-200 ${priceColorClass} ${priceFlashClass} ${
              flash ? 'scale-[1.02] shadow-[0_0_24px_rgba(255,255,255,0.04)]' : 'scale-100'
            }`}
          >
            {price}
          </div>
        </div>

        <div className="grid min-w-0 flex-1 grid-cols-2 gap-2 text-[12px] text-gray-300 md:grid-cols-5">
          <Metric label={t('spotHeaderChange24h', 'asset')} value={change} valueClassName={statColorClass} />
          <Metric label={t('spotHeaderChangeAmount', 'asset')} value={changeAmount} valueClassName={statColorClass} />
          <Metric label={t('spotHeaderHighLow24h', 'asset')} value={highLow} />
          <Metric label={t('spotHeaderVolume24h', 'asset')} value={volume} />
          <Metric label={t('spotHeaderTurnover24h', 'asset')} value={turnover} />
        </div>
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  valueClassName = 'text-white/88',
}: {
  label: string;
  value: string;
  valueClassName?: string;
}) {
  return (
    <div className="rounded-lg border border-white/[0.04] bg-white/[0.02] px-3 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.02)]">
      <div className="text-[10px] font-medium text-white/36">{label}</div>
      <div className={`mt-1 text-[13px] font-medium ${valueClassName}`}>{value}</div>
    </div>
  );
}
