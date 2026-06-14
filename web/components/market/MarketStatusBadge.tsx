'use client';

import { useLocaleContext } from '@/contexts/LocaleContext';

type MarketStatusBadgeProps = {
  marketStatus?: string | null;
  quoteFreshness?: string | null;
  marketSessionType?: string | null;
  className?: string;
};

type MarketTranslate = (key: string, namespace?: 'markets') => string;

function marketText(t: MarketTranslate, key: string, fallback: string) {
  const value = t(key, 'markets');
  return value === key ? fallback : value;
}

function withMarketDetail(base: string, detail: string) {
  return `${base} \u00b7 ${detail}`;
}

export function buildMarketStatusBadgeText({
  marketStatus,
  quoteFreshness,
  marketSessionType,
  t,
}: Pick<MarketStatusBadgeProps, 'marketStatus' | 'quoteFreshness' | 'marketSessionType'> & {
  t: MarketTranslate;
}) {
  const status = String(marketStatus || '').toUpperCase();
  const freshness = String(quoteFreshness || '').toUpperCase();
  const sessionType = String(marketSessionType || '').toUpperCase();

  const unknownText = marketText(t, 'market.session.unknown', 'Status unknown');
  const lastQuoteText = marketText(t, 'market.session.lastQuote', 'Last quote');
  const cachedQuoteText = marketText(t, 'market.session.cachedQuote', 'Cached quote');
  const delayedQuoteText = marketText(t, 'market.session.delayedQuote', 'Delayed quote');

  if (status === 'UNKNOWN' || !status) return unknownText;
  if (status === 'HOLIDAY' || sessionType === 'HOLIDAY') {
    return marketText(t, 'market.session.holiday', 'Market holiday');
  }
  if (sessionType === 'PRE_MARKET') {
    return withMarketDetail(marketText(t, 'market.session.preMarket', 'Pre-market'), lastQuoteText);
  }
  if (sessionType === 'AFTER_HOURS') {
    return withMarketDetail(marketText(t, 'market.session.afterHours', 'After-hours'), lastQuoteText);
  }

  if (status === 'OPEN') {
    const openText = marketText(t, 'market.session.open', 'Trading');
    if (freshness === 'STALE') return withMarketDetail(openText, delayedQuoteText);
    if (freshness === 'LAST_VALID') return withMarketDetail(openText, cachedQuoteText);
    if (freshness === 'FALLBACK') return withMarketDetail(openText, cachedQuoteText);
    return openText;
  }

  if (status === 'CLOSED') {
    const closedText = marketText(t, 'market.session.closed', 'Closed');
    if (freshness === 'FALLBACK') return withMarketDetail(closedText, cachedQuoteText);
    return withMarketDetail(closedText, lastQuoteText);
  }

  return unknownText;
}

export function shouldShowMarketStatusBadge(marketStatus?: string | null) {
  const status = String(marketStatus || '').toUpperCase();
  return status === 'OPEN' || status === 'CLOSED' || status === 'HOLIDAY' || status === 'UNKNOWN';
}

function marketStatusBadgeClass(marketStatus?: string | null, marketSessionType?: string | null) {
  const status = String(marketStatus || '').toUpperCase();
  const sessionType = String(marketSessionType || '').toUpperCase();
  if (status === 'OPEN' && sessionType !== 'PRE_MARKET' && sessionType !== 'AFTER_HOURS') {
    return 'border-[#00c087]/25 bg-[#00c087]/10 text-[#00c087]';
  }
  if (
    status === 'CLOSED' ||
    status === 'HOLIDAY' ||
    sessionType === 'PRE_MARKET' ||
    sessionType === 'AFTER_HOURS' ||
    sessionType === 'HOLIDAY'
  ) {
    return 'border-[#f0b90b]/25 bg-[#f0b90b]/10 text-[#f0b90b]';
  }
  return 'border-white/15 bg-white/5 text-white/60';
}

export default function MarketStatusBadge({
  marketStatus,
  quoteFreshness,
  marketSessionType,
  className = '',
}: MarketStatusBadgeProps) {
  const { t } = useLocaleContext();

  if (!shouldShowMarketStatusBadge(marketStatus)) return null;

  return (
    <span
      className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${marketStatusBadgeClass(
        marketStatus,
        marketSessionType,
      )} ${className}`}
    >
      {buildMarketStatusBadgeText({ marketStatus, quoteFreshness, marketSessionType, t })}
    </span>
  );
}
