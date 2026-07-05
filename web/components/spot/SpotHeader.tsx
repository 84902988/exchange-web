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
  symbolSelector?: React.ReactNode;
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
  symbolSelector,
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
    return 'text-white/58';
  }, [isChangeUp, isChangeDown]);

  const changeSummary = useMemo(() => {
    const safeAmount = String(changeAmount || '').trim();
    const safePercent = String(change || '').trim();
    const hasAmount = safeAmount && safeAmount !== '--';
    const hasPercent = safePercent && safePercent !== '--';

    if (hasAmount && hasPercent) return `${safeAmount} (${safePercent})`;
    if (hasAmount) return safeAmount;
    if (hasPercent) return safePercent;
    return '--';
  }, [change, changeAmount]);

  const [high24h, low24h] = useMemo(() => {
    const [highValue, lowValue] = highLow.split('/').map((item) => item.trim());
    return [highValue || '--', lowValue || '--'];
  }, [highLow]);

  return (
    <div className="tabular-nums border-b border-white/[0.06] bg-[#11161d] px-3 py-2 shadow-[inset_0_-1px_0_rgba(255,255,255,0.02)]">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2.5 xl:flex-nowrap">
        <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 whitespace-nowrap sm:min-w-[350px]">
          <div className="flex min-w-0 flex-col justify-center gap-1">
            {symbolSelector || (
              <span className="text-[17px] font-semibold leading-none text-white">
                {displaySymbol || formatSpotDisplaySymbol(symbol)}
              </span>
            )}
          </div>

          <div className="flex w-[154px] flex-col justify-center gap-0.5">
            <div
              className={`inline-flex max-w-full items-center truncate rounded-md px-1 py-0.5 text-[28px] font-semibold leading-none transition-all duration-200 ${priceColorClass} ${priceFlashClass} ${
                flash ? 'scale-[1.02] shadow-[0_0_24px_rgba(255,255,255,0.04)]' : 'scale-100'
              }`}
            >
              {price}
            </div>
            <div className="min-h-4 pl-1 text-[12px] font-semibold leading-tight">
              <span className={statColorClass}>{changeSummary}</span>
            </div>
          </div>
        </div>

        <div className="grid min-w-0 flex-1 grid-cols-2 gap-2 text-[12px] text-gray-300 md:grid-cols-5">
          <Metric
            label={t('spotHeaderTradeStatus', 'asset')}
            value={
              <MarketStatusBadge
                marketStatus={marketStatus || 'UNKNOWN'}
                quoteFreshness={quoteFreshness}
                marketSessionType={marketSessionType}
                className="!border-transparent !bg-transparent !px-0 !py-0 text-[13px] font-medium"
              />
            }
          />
          <Metric label={t('spotHeaderHigh24h', 'asset')} value={high24h} />
          <Metric label={t('spotHeaderLow24h', 'asset')} value={low24h} />
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
  value: React.ReactNode;
  valueClassName?: string;
}) {
  return (
    <div className="rounded-md border border-white/[0.045] bg-white/[0.02] px-3 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.02)]">
      <div className="text-[10px] font-medium leading-none text-white/36">{label}</div>
      <div className={`mt-1.5 text-[13px] font-medium leading-tight ${valueClassName}`}>{value}</div>
    </div>
  );
}
