'use client';

import type { ReactNode } from 'react';
import MarketStatusBadge from '@/components/market/MarketStatusBadge';
import { useLocaleContext } from '@/contexts/LocaleContext';
import {
  getContractTickerDomainStatusLabel,
} from './contractMarketSourceStatus';

type PriceDirection = 'up' | 'down' | 'flat';

export type HeaderMetric = {
  label: string;
  value: ReactNode;
  subValue?: ReactNode;
};

type ContractMarketHeaderProps = {
  marketSymbol: string;
  price: string;
  change?: string | null;
  quoteStatusLabel?: string | null;
  quoteStatusTone?: 'loading' | 'live' | 'last' | 'expired' | 'unavailable';
  metrics: HeaderMetric[];
  hint?: string | null;
  marketStatus?: string | null;
  marketStatusText?: string | null;
  tickerSource?: string | null;
  tickerFreshness?: string | null;
  marketSessionType?: string | null;
  executable?: boolean | null;
  priceDirection?: PriceDirection;
  priceSource?: 'KLINE_CLOSE' | 'LIVE_MID' | 'TRADE_TICK';
  priceSourceLabel?: string | null;
  symbolSelector?: ReactNode;
};

export default function ContractMarketHeader({
  marketSymbol,
  price,
  change,
  quoteStatusLabel,
  quoteStatusTone = 'last',
  metrics,
  hint,
  marketStatus,
  marketStatusText,
  tickerSource,
  tickerFreshness,
  marketSessionType,
  executable,
  priceDirection = 'flat',
  priceSource,
  priceSourceLabel,
  symbolSelector,
}: ContractMarketHeaderProps) {
  const { t } = useLocaleContext();
  const priceColorClass =
    priceDirection === 'up'
      ? 'text-[#00c087]'
      : priceDirection === 'down'
        ? 'text-[#f6465d]'
        : 'text-white';
  const displaySymbol = formatContractDisplaySymbol(marketSymbol);
  const changeValue = String(change || '').trim();
  const changeColorClass = changeValue.startsWith('+')
    ? 'text-[#00c087]'
    : changeValue.startsWith('-')
      ? 'text-[#f6465d]'
      : 'text-white/58';
  const hasTickerSourceStatus = !!tickerSource || !!tickerFreshness;
  const tickerSourceStatusTitle = hasTickerSourceStatus
    ? getContractTickerDomainStatusLabel({
        source: tickerSource,
        freshness: tickerFreshness,
        marketStatus,
        marketSessionType,
        executable,
        t,
      })
    : null;
  const tradeStatusTitle = [marketStatusText, tickerSourceStatusTitle]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="tabular-nums border-b border-white/[0.06] bg-[#11161d] px-3 py-2 shadow-[inset_0_-1px_0_rgba(255,255,255,0.02)]">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2.5 xl:flex-nowrap">
        <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 whitespace-nowrap sm:min-w-[350px]">
          <div className="flex min-w-0 flex-col justify-center gap-1">
            {symbolSelector || (
              <span className="truncate text-[17px] font-semibold leading-none text-white">
                {displaySymbol} {t('perpetual', 'contracts')}
              </span>
            )}
          </div>

          <div className="flex w-[174px] flex-col justify-center gap-0.5">
            <div
              data-price-source={priceSource}
              title={priceSourceLabel || undefined}
              className={`max-w-full truncate rounded-md px-1 py-0.5 text-[28px] font-semibold leading-none transition-all duration-200 ${priceColorClass}`}
            >
              {price}
            </div>
            <div className="min-h-4 pl-1 text-[12px] font-semibold leading-tight">
              <span className={changeColorClass}>{changeValue || '--'}</span>
            </div>
          </div>
        </div>

        <div className="grid min-w-0 flex-1 grid-cols-2 gap-2 text-[12px] text-gray-300 md:grid-cols-4 xl:grid-cols-5">
          <Metric
            label={t('tradeStatus', 'contracts')}
            value={(
              <span className="flex min-w-0 items-center gap-1.5">
                {quoteStatusLabel ? (
                  <span className={`min-w-0 truncate text-[13px] font-medium leading-tight ${quoteStatusTextClass(quoteStatusTone)}`}>
                    {quoteStatusLabel}
                  </span>
                ) : null}
                <MarketStatusBadge
                  marketStatus={marketStatus}
                  quoteFreshness={tickerFreshness}
                  marketSessionType={marketSessionType}
                  className="max-w-full truncate !rounded-none !border-0 !bg-transparent !px-0 !py-0 text-[12px] font-medium"
                />
              </span>
            )}
            title={tradeStatusTitle || undefined}
          />
          {metrics.map((metric) => (
            <Metric key={metric.label} label={metric.label} value={metric.value} subValue={metric.subValue} />
          ))}
        </div>
      </div>
      {hint ? <div className="sr-only">{hint}</div> : null}
    </div>
  );
}

function quoteStatusTextClass(tone: NonNullable<ContractMarketHeaderProps['quoteStatusTone']>) {
  if (tone === 'loading') return 'text-white/58';
  if (tone === 'live') return 'text-[#00c087]';
  if (tone === 'expired' || tone === 'unavailable') return 'text-[#f6465d]';
  return 'text-[#f0b90b]';
}

function formatContractDisplaySymbol(symbol: string) {
  const normalized = String(symbol || '').trim().toUpperCase().replace(/_PERP$/, '');
  if (!normalized) return '';
  if (normalized.includes('/')) return normalized;

  for (const quote of ['USDT', 'USDC', 'USD']) {
    if (normalized.endsWith(quote) && normalized.length > quote.length) {
      return `${normalized.slice(0, -quote.length)}/${quote}`;
    }
  }

  return normalized;
}

function Metric({
  label,
  value,
  subValue,
  className = '',
  valueClassName = 'font-sans text-[13px] font-medium tabular-nums text-white/88',
  title,
}: {
  label: string;
  value: ReactNode;
  subValue?: ReactNode;
  className?: string;
  valueClassName?: string;
  title?: string;
}) {
  return (
    <div className={`min-w-0 rounded-md border border-white/[0.045] bg-white/[0.02] px-3 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.02)] ${className}`}>
      <div className="truncate text-[10px] font-medium leading-none text-white/36">
        {label}
      </div>
      <div className={`mt-1.5 flex min-w-0 items-baseline gap-1.5 leading-tight ${valueClassName}`}>
        <span className="min-w-0 truncate" title={title || (typeof value === 'string' ? value : undefined)}>
          {value}
        </span>
        {subValue ? <span className="shrink-0 text-[11px] font-medium text-white/48">{subValue}</span> : null}
      </div>
    </div>
  );
}
