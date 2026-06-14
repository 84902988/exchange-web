'use client';

import MarketStatusBadge from '@/components/market/MarketStatusBadge';
import { useLocaleContext } from '@/contexts/LocaleContext';

type PriceDirection = 'up' | 'down' | 'flat';

export type HeaderMetric = {
  label: string;
  value: string;
  subValue?: string;
};

type ContractMarketHeaderProps = {
  marketSymbol: string;
  price: string;
  metrics: HeaderMetric[];
  hint?: string | null;
  marketStatus?: string | null;
  marketStatusText?: string | null;
  quoteFreshness?: string | null;
  marketSessionType?: string | null;
  priceDirection?: PriceDirection;
};

export default function ContractMarketHeader({
  marketSymbol,
  price,
  metrics,
  hint,
  marketStatus,
  quoteFreshness,
  marketSessionType,
  priceDirection = 'flat',
}: ContractMarketHeaderProps) {
  const { t } = useLocaleContext();
  const priceColorClass =
    priceDirection === 'up'
      ? 'text-[#00c087]'
      : priceDirection === 'down'
        ? 'text-[#f6465d]'
        : 'text-white';

  return (
    <div className="tabular-nums border-b border-white/[0.06] bg-[#11161d] px-3 py-2 shadow-[inset_0_-1px_0_rgba(255,255,255,0.02)]">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3 xl:flex-nowrap">
        <div className="flex shrink-0 flex-col justify-center gap-1.5 whitespace-nowrap">
          <div className="text-[13px] font-medium text-white/42">
            <span>{marketSymbol} {t('perpetual', 'contracts')}</span>
            <MarketStatusBadge
              marketStatus={marketStatus}
              quoteFreshness={quoteFreshness}
              marketSessionType={marketSessionType}
              className="ml-2"
            />
          </div>
          <div className={`inline-flex w-fit items-center rounded-lg px-2 py-0.5 text-[30px] font-semibold leading-none transition-all duration-200 ${priceColorClass}`}>
            {price}
          </div>
        </div>

        <div className="grid min-w-0 flex-1 grid-cols-2 gap-2 text-[12px] text-gray-300 md:grid-cols-4">
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
      {hint ? <div className="mt-1.5 text-[11px] text-yellow-300/85">{hint}</div> : null}
    </div>
  );
}

function Metric({
  label,
  value,
  subValue,
}: {
  label: string;
  value: string;
  subValue?: string;
}) {
  return (
    <div className="rounded-lg border border-white/[0.04] bg-white/[0.02] px-3 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.02)]">
      <div className="text-[10px] font-medium text-white/36">
        {label}
      </div>
      <div className="mt-1 flex min-w-0 items-baseline gap-1.5 font-mono text-[13px] font-medium tabular-nums text-white/88">
        <span className="truncate">{value}</span>
        {subValue ? <span className="shrink-0 text-[11px] font-medium text-white/48">{subValue}</span> : null}
      </div>
    </div>
  );
}
