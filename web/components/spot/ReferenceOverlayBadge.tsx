'use client';

import { useLocaleContext } from '@/contexts/LocaleContext';
import type { ReferenceOverlayConfig } from './chart/referenceOverlay';

export default function ReferenceOverlayBadge({
  config,
}: {
  config: ReferenceOverlayConfig;
}) {
  const { t } = useLocaleContext();
  const badgeColor = config.badgeColor || config.lineColor;
  const titleParts = [config.title, config.sourceLabel, config.sourcePriceLabel, config.description]
    .filter(Boolean)
    .join('\n');

  return (
    <div
      title={titleParts}
      className="pointer-events-auto absolute left-3 top-3 z-10 max-w-[calc(100%-1.5rem)] rounded-lg border bg-[#090b10]/70 px-3 py-2 shadow-lg shadow-black/25 backdrop-blur-md"
      style={{ borderColor: `${badgeColor}59` }}
    >
      <div className="text-[11px] font-medium leading-4" style={{ color: badgeColor }}>
        {config.title}
      </div>
      <div className="mt-0.5 font-mono text-sm font-semibold leading-5 text-white">
        {config.valueLabel || '--'}
      </div>
      <div className="mt-0.5 truncate text-[10px] leading-4 text-white/52">
        {config.sourceLabel || '--'}
      </div>
      {config.sourcePriceLabel ? (
        <div className="mt-0.5 truncate text-[10px] leading-4 text-white/52">
          {config.sourcePriceLabel}
        </div>
      ) : null}
      {config.description ? (
        <div className="mt-0.5 truncate text-[10px] leading-4 text-white/48">
          {config.description}
        </div>
      ) : null}
      {config.stale ? (
        <div
          className="mt-1 truncate text-[10px] leading-4 text-[#f0b90b]/80"
          title={config.syncError || t('spotReferenceDelay', 'asset')}
        >
          {t('spotReferenceDelay', 'asset')}
        </div>
      ) : null}
    </div>
  );
}
