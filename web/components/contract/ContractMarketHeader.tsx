'use client';

import type { ReactNode } from 'react';
import MarketStatusBadge from '@/components/market/MarketStatusBadge';
import { useLocaleContext } from '@/contexts/LocaleContext';

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
  quoteFreshness?: string | null;
  marketSessionType?: string | null;
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
  quoteFreshness,
  marketSessionType,
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

  return (
    <div className="h-[74px] overflow-hidden border-b border-white/[0.06] bg-[#11161d] px-3 py-2.5 tabular-nums shadow-[inset_0_-1px_0_rgba(255,255,255,0.02)]">
      <div className="flex h-full min-w-0 items-center gap-3 whitespace-nowrap">
        <div className="flex h-[54px] w-[176px] min-w-0 shrink-0 items-center">
          {symbolSelector || (
            <span className="truncate text-[18px] font-semibold leading-none text-white">
              {displaySymbol} {t('perpetual', 'contracts')}
            </span>
          )}
        </div>

        <div className="flex h-[54px] w-[174px] shrink-0 flex-col justify-center gap-1">
          <div className={`max-w-full truncate text-[31px] font-semibold leading-none transition-all duration-200 ${priceColorClass}`}>
            {price}
          </div>
          <div className="min-h-4 truncate text-[12px] font-semibold leading-tight">
            <span className={changeColorClass}>{changeValue || '--'}</span>
            {priceSourceLabel ? (
              <span
                className="ml-2 text-[11px] font-medium text-white/42"
                data-price-source={priceSource}
              >
                {priceSourceLabel}
              </span>
            ) : null}
          </div>
        </div>

        <Metric
          className="w-[138px] shrink-0 flex-none"
          label={t('spotHeaderTradeStatus', 'asset')}
          value={quoteStatusLabel ? (
            <span className={`block max-w-full truncate text-[13px] font-semibold leading-tight ${quoteStatusTextClass(quoteStatusTone)}`}>
              {quoteStatusLabel}
            </span>
          ) : (
            <MarketStatusBadge
              marketStatus={marketStatus}
              quoteFreshness={quoteFreshness}
              marketSessionType={marketSessionType}
              className="!rounded-none !border-0 !bg-transparent !px-0 !py-0 text-[13px] font-semibold"
            />
          )}
          valueClassName="font-sans text-[13px] font-semibold text-white/88"
          title={marketStatusText || undefined}
        />

        <div className="grid min-w-0 flex-1 grid-flow-col auto-cols-[minmax(132px,1fr)] gap-2 overflow-hidden">
          {metrics.map((metric) => (
            <Metric
              key={metric.label}
              label={metric.label}
              value={metric.value}
              subValue={metric.subValue}
            />
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
  valueClassName = 'font-mono text-[13px] font-semibold tabular-nums text-white/88',
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
    <div className={`flex h-[54px] min-w-0 flex-col justify-center rounded-md border border-white/[0.07] bg-white/[0.025] px-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.025)] ${className}`}>
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
