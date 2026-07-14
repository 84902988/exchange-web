'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useLocaleContext } from '@/contexts/LocaleContext';
import {
  useContractHeaderStoreSnapshot,
  type ContractHeaderStoreSnapshot,
} from './hooks/contractMarketStoreAdapter';

export type ContractHeaderPriceDirection = 'up' | 'down' | 'flat';
export type ContractHeaderQuoteStatusTone = 'loading' | 'live' | 'last' | 'expired' | 'unavailable';
export type ContractHeaderMarketState = 'live' | 'pre_market' | 'after_hours' | 'closed' | 'holiday' | 'unavailable';

type ContractHeaderLabels = {
  live: string;
  preMarket: string;
  afterHours: string;
  closed: string;
  holiday: string;
  unavailable: string;
  fundingRate: string;
  bestBid: string;
  bestAsk: string;
};

const HEADER_LABELS: Record<string, ContractHeaderLabels> = {
  en: {
    live: 'Live',
    preMarket: 'Pre-market',
    afterHours: 'After-hours',
    closed: 'Closed',
    holiday: 'Market holiday',
    unavailable: 'Market data unavailable',
    fundingRate: 'Funding Rate',
    bestBid: 'Best Bid',
    bestAsk: 'Best Ask',
  },
  zh: {
    live: '\u5b9e\u65f6',
    preMarket: '\u76d8\u524d',
    afterHours: '\u76d8\u540e',
    closed: '\u95ed\u5e02\u4e2d',
    holiday: '\u4f11\u5e02\u4e2d',
    unavailable: '\u884c\u60c5\u6682\u4e0d\u53ef\u7528',
    fundingRate: '\u8d44\u91d1\u8d39\u7387',
    bestBid: '\u4e70\u4e00',
    bestAsk: '\u5356\u4e00',
  },
  'zh-TW': {
    live: '\u5373\u6642',
    preMarket: '\u76e4\u524d',
    afterHours: '\u76e4\u5f8c',
    closed: '\u9589\u5e02\u4e2d',
    holiday: '\u4f11\u5e02\u4e2d',
    unavailable: '\u884c\u60c5\u66ab\u4e0d\u53ef\u7528',
    fundingRate: '\u8cc7\u91d1\u8cbb\u7387',
    bestBid: '\u8cb7\u4e00',
    bestAsk: '\u8ce3\u4e00',
  },
  ja: {
    live: '\u30ea\u30a2\u30eb\u30bf\u30a4\u30e0',
    preMarket: '\u30d7\u30ec\u30de\u30fc\u30b1\u30c3\u30c8',
    afterHours: '\u6642\u9593\u5916',
    closed: '\u9589\u5834\u4e2d',
    holiday: '\u4f11\u5834\u4e2d',
    unavailable: '\u5e02\u5834\u30c7\u30fc\u30bf\u3092\u5229\u7528\u3067\u304d\u307e\u305b\u3093',
    fundingRate: '\u8cc7\u91d1\u8abf\u9054\u7387',
    bestBid: '\u6700\u826f\u8cb7\u6c17\u914d',
    bestAsk: '\u6700\u826f\u58f2\u6c17\u914d',
  },
};

type ContractMarketHeaderProps = {
  marketSymbol: string;
  displayPrice: string;
  change?: string | null;
  quoteStatusLabel?: string | null;
  quoteStatusTone?: ContractHeaderQuoteStatusTone;
  hint?: string | null;
  marketStatus?: string | null;
  tickerSource?: string | null;
  tickerFreshness?: string | null;
  marketSessionType?: string | null;
  executable?: boolean | null;
  priceDirection?: ContractHeaderPriceDirection;
  displayPriceSource?: 'KLINE_CLOSE' | 'LIVE_MID' | 'TRADE_TICK' | null;
  displayPriceLabel?: string | null;
  markPrice?: string | null;
  indexPrice?: string | null;
  fundingRate?: string | null;
  bestBid?: string | null;
  bestAsk?: string | null;
  spread?: string | null;
  highLow24h?: string | null;
  volumeTurnover24h?: string | null;
  symbolSelector?: ReactNode;
};

type ContractHeaderLegacyRead = {
  displayPrice: string;
  change: string | null;
  quoteStatusLabel: string | null;
  quoteStatusTone: ContractHeaderQuoteStatusTone;
  marketStatus: string | null;
  tickerSource: string | null;
  tickerFreshness: string | null;
  marketSessionType: string | null;
  executable: boolean | null;
  displayPriceSource: 'KLINE_CLOSE' | 'LIVE_MID' | 'TRADE_TICK' | null;
  displayPriceLabel: string | null;
  markPrice: string | null;
  indexPrice: string | null;
  fundingRate: string | null;
  bestBid: string | null;
  bestAsk: string | null;
  spread: string | null;
  highLow24h: string | null;
  volumeTurnover24h: string | null;
};

export type ContractHeaderMarketRead = ContractHeaderLegacyRead & {
  authority: 'STORE' | 'LEGACY_FALLBACK';
};

export type ContractHeaderReadDifference = {
  field: string;
  storeValue: string | number | boolean | null;
  legacyValue: string | number | boolean | null;
};

function parseComparableNumber(value: unknown): number | null {
  const normalized = String(value ?? '').replace(/,/g, '').replace(/%$/, '').trim();
  if (!normalized || normalized === '--') return null;
  const numeric = Number(normalized);
  return Number.isFinite(numeric) ? numeric : null;
}

function inferFractionDigits(value: unknown, fallback = 2): number {
  const normalized = String(value ?? '').replace(/,/g, '').replace(/%$/, '').trim();
  const decimal = normalized.split('.')[1];
  return decimal === undefined ? fallback : Math.min(decimal.length, 12);
}

function formatStoreNumber(value: string | null, legacyValue: string | null): string | null {
  if (value === null) return legacyValue;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return legacyValue;
  const legacyNumeric = parseComparableNumber(legacyValue);
  if (legacyNumeric !== null && legacyNumeric === numeric) return legacyValue;
  const precision = inferFractionDigits(legacyValue, inferFractionDigits(value));
  return numeric.toLocaleString('en-US', {
    minimumFractionDigits: precision,
    maximumFractionDigits: precision,
  });
}

function formatStoreFunding(value: string | null, legacyValue: string | null): string | null {
  if (value === null) return legacyValue;
  const hasPercentSuffix = String(value).trim().endsWith('%');
  const numeric = parseComparableNumber(value);
  if (numeric === null) return legacyValue;
  const percent = hasPercentSuffix ? numeric : numeric * 100;
  const legacyPercent = parseComparableNumber(legacyValue);
  if (legacyPercent !== null && legacyPercent === percent) return legacyValue;
  const precision = inferFractionDigits(legacyValue, 4);
  return `${percent > 0 ? '+' : ''}${percent.toFixed(precision)}%`;
}

function formatSigned(value: string, precision: number, suffix = '') {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '--';
  return `${numeric > 0 ? '+' : ''}${numeric.toFixed(precision)}${suffix}`;
}

function formatStoreChange(
  store: ContractHeaderStoreSnapshot,
  fallback: string | null,
  displayPriceFallback: string,
) {
  if (store.priceChange24h === null && store.priceChangePercent24h === null) return fallback;
  const precision = inferFractionDigits(displayPriceFallback, 2);
  const amount = store.priceChange24h === null
    ? '--'
    : formatSigned(store.priceChange24h, precision);
  const percent = store.priceChangePercent24h === null
    ? '--'
    : formatSigned(store.priceChangePercent24h, 2, '%');
  if (amount !== '--' && percent !== '--') return `${amount} / ${percent}`;
  return amount !== '--' ? amount : percent;
}

function formatCompactAmount(value: string | null) {
  if (value === null) return '--';
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '--';
  const abs = Math.abs(amount);
  if (abs >= 1_000_000_000) return `${(amount / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${(amount / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(amount / 1_000).toFixed(2)}K`;
  return amount.toFixed(2);
}

function resolveStoreQuoteTone(
  store: ContractHeaderStoreSnapshot,
  executable: boolean | null,
  fallback: ContractHeaderQuoteStatusTone,
): ContractHeaderQuoteStatusTone {
  const displayState = normalizeToken(store.displayState);
  const freshness = normalizeToken(store.freshness);
  if (displayState === 'LOADING') return 'loading';
  if (store.stale || ['STALE', 'LAST_GOOD', 'MISSING'].includes(freshness)) return 'last';
  if (executable === true && ['LIVE', 'RECENT'].includes(freshness)) return 'live';
  if (
    ['PRE_MARKET', 'AFTER_HOURS', 'CLOSED', 'MARKET_CLOSED', 'HOLIDAY', 'EXPIRED', 'UNAVAILABLE']
      .includes(displayState)
  ) return 'unavailable';
  return fallback;
}

export function resolveContractHeaderMarketRead(
  store: ContractHeaderStoreSnapshot | null,
  legacy: ContractHeaderLegacyRead,
): ContractHeaderMarketRead {
  if (!store) return { ...legacy, authority: 'LEGACY_FALLBACK' };
  const executable = store.executable ?? legacy.executable;
  const displayPrice = formatStoreNumber(store.displayPrice, legacy.displayPrice) || legacy.displayPrice;
  const highLow24h = store.high24h !== null || store.low24h !== null
    ? `${formatStoreNumber(store.high24h, null) || '--'} / ${formatStoreNumber(store.low24h, null) || '--'}`
    : legacy.highLow24h;
  const volumeTurnover24h = store.baseVolume24h !== null || store.quoteVolume24h !== null
    ? `${formatCompactAmount(store.baseVolume24h)} / ${formatCompactAmount(store.quoteVolume24h)}`
    : legacy.volumeTurnover24h;
  const displayPriceSource = store.displayPriceSource ?? legacy.displayPriceSource;

  return {
    authority: 'STORE',
    displayPrice,
    change: formatStoreChange(store, legacy.change, legacy.displayPrice),
    quoteStatusLabel: store.displayState || store.marketStatus || legacy.quoteStatusLabel,
    quoteStatusTone: resolveStoreQuoteTone(store, executable, legacy.quoteStatusTone),
    marketStatus: store.marketStatus ?? legacy.marketStatus,
    tickerSource: store.source ?? legacy.tickerSource,
    tickerFreshness: store.freshness ?? legacy.tickerFreshness,
    marketSessionType: store.marketSessionType ?? legacy.marketSessionType,
    executable,
    displayPriceSource,
    displayPriceLabel: displayPriceSource && displayPriceSource !== legacy.displayPriceSource
      ? displayPriceSource
      : legacy.displayPriceLabel,
    markPrice: formatStoreNumber(store.markPrice, legacy.markPrice),
    indexPrice: formatStoreNumber(store.indexPrice, legacy.indexPrice),
    fundingRate: formatStoreFunding(store.fundingRate, legacy.fundingRate),
    bestBid: formatStoreNumber(store.bestBid, legacy.bestBid),
    bestAsk: formatStoreNumber(store.bestAsk, legacy.bestAsk),
    spread: formatStoreNumber(store.spread, legacy.spread),
    highLow24h,
    volumeTurnover24h,
  };
}

function valuesDiffer(storeValue: unknown, legacyValue: unknown, funding = false) {
  const storeNumeric = parseComparableNumber(storeValue);
  const legacyNumeric = parseComparableNumber(legacyValue);
  if (storeNumeric !== null && legacyNumeric !== null) {
    const storeIsPercent = String(storeValue ?? '').trim().endsWith('%');
    const normalizedStore = funding && !storeIsPercent ? storeNumeric * 100 : storeNumeric;
    return Math.abs(normalizedStore - legacyNumeric) > 1e-9;
  }
  return normalizeToken(String(storeValue ?? '')) !== normalizeToken(String(legacyValue ?? ''));
}

export function getContractHeaderReadDifferences(
  store: ContractHeaderStoreSnapshot | null,
  legacy: ContractHeaderLegacyRead,
): ContractHeaderReadDifference[] {
  if (!store) return [];
  const candidates: Array<[string, unknown, unknown, boolean?]> = [
    ['displayPrice', store.displayPrice, legacy.displayPrice],
    ['markPrice', store.markPrice, legacy.markPrice],
    ['indexPrice', store.indexPrice, legacy.indexPrice],
    ['fundingRate', store.fundingRate, legacy.fundingRate, true],
    ['bestBid', store.bestBid, legacy.bestBid],
    ['bestAsk', store.bestAsk, legacy.bestAsk],
    ['spread', store.spread, legacy.spread],
    ['displayPriceSource', store.displayPriceSource, legacy.displayPriceSource],
    ['tickerSource', store.source, legacy.tickerSource],
    ['tickerFreshness', store.freshness, legacy.tickerFreshness],
    ['executable', store.executable, legacy.executable],
  ];
  return candidates.flatMap(([field, storeValue, legacyValue, funding]) => {
    if (storeValue === null || storeValue === undefined) return [];
    if (!valuesDiffer(storeValue, legacyValue, funding)) return [];
    return [{
      field,
      storeValue: storeValue as string | number | boolean,
      legacyValue: legacyValue as string | number | boolean | null,
    }];
  });
}

function normalizeToken(value?: string | null) {
  return String(value || '').trim().toUpperCase();
}

function includesAny(value: string, candidates: string[]) {
  return candidates.some((candidate) => value.includes(candidate));
}

function getHeaderLabels(locale?: string | null) {
  return HEADER_LABELS[locale || ''] || HEADER_LABELS.en;
}

export function resolveContractHeaderMarketPresentation({
  displayPrice,
  quoteStatusLabel,
  quoteStatusTone = 'last',
  marketStatus,
  marketSessionType,
  executable,
  locale,
}: {
  displayPrice?: string | null;
  quoteStatusLabel?: string | null;
  quoteStatusTone?: ContractHeaderQuoteStatusTone;
  marketStatus?: string | null;
  marketSessionType?: string | null;
  executable?: boolean | null;
  locale?: string | null;
}): {
  state: ContractHeaderMarketState;
  label: string;
  dotClass: string;
} {
  const labels = getHeaderLabels(locale);
  const statusLabel = [quoteStatusLabel, marketStatus, marketSessionType]
    .map(normalizeToken)
    .filter(Boolean)
    .join(' ');

  if (
    includesAny(statusLabel, ['PRE-MARKET', '\u76d8\u524d', '\u76e4\u524d', '\u30d7\u30ec\u30de\u30fc\u30b1\u30c3\u30c8'])
  ) {
    return { state: 'pre_market', label: labels.preMarket, dotClass: 'bg-[#f0b90b]' };
  }
  if (
    includesAny(statusLabel, ['AFTER-HOURS', '\u76d8\u540e', '\u76e4\u5f8C', '\u6642\u9593\u5916'])
  ) {
    return { state: 'after_hours', label: labels.afterHours, dotClass: 'bg-[#f0b90b]' };
  }
  if (
    includesAny(statusLabel, ['HOLIDAY', '\u4f11\u5e02', '\u4f11\u5834', '\u5e02\u5834\u5047\u671f'])
  ) {
    return { state: 'holiday', label: labels.holiday, dotClass: 'bg-[#f0b90b]' };
  }
  if (
    includesAny(statusLabel, ['CLOSED', '\u95ed\u5e02', '\u9589\u5e02', '\u9589\u5834'])
  ) {
    return { state: 'closed', label: labels.closed, dotClass: 'bg-[#f0b90b]' };
  }

  const hasDisplayPrice = !!String(displayPrice || '').trim() && displayPrice !== '--';
  if (!hasDisplayPrice || executable !== true || quoteStatusTone !== 'live') {
    return { state: 'unavailable', label: labels.unavailable, dotClass: 'bg-[#f6465d]' };
  }

  return { state: 'live', label: labels.live, dotClass: 'bg-[#00c087]' };
}

function priceDirectionTextClass(direction: ContractHeaderPriceDirection) {
  if (direction === 'up') return 'text-[#00c087]';
  if (direction === 'down') return 'text-[#f6465d]';
  return 'text-white';
}

function priceDirectionFlashClass(direction: ContractHeaderPriceDirection) {
  if (direction === 'up') return 'bg-[#00c087]/10';
  if (direction === 'down') return 'bg-[#f6465d]/10';
  return '';
}

export default function ContractMarketHeader({
  marketSymbol,
  displayPrice: legacyDisplayPrice,
  change: legacyChange,
  quoteStatusLabel: legacyQuoteStatusLabel,
  quoteStatusTone: legacyQuoteStatusTone = 'last',
  hint,
  marketStatus: legacyMarketStatus,
  tickerSource: legacyTickerSource,
  tickerFreshness: legacyTickerFreshness,
  marketSessionType: legacyMarketSessionType,
  executable: legacyExecutable,
  priceDirection = 'flat',
  displayPriceSource: legacyDisplayPriceSource,
  displayPriceLabel: legacyDisplayPriceLabel,
  markPrice: legacyMarkPrice,
  indexPrice: legacyIndexPrice,
  fundingRate: legacyFundingRate,
  bestBid: legacyBestBid,
  bestAsk: legacyBestAsk,
  spread: legacySpread,
  highLow24h: legacyHighLow24h,
  volumeTurnover24h: legacyVolumeTurnover24h,
  symbolSelector,
}: ContractMarketHeaderProps) {
  const { locale, t } = useLocaleContext();
  const [flash, setFlash] = useState(false);
  const labels = getHeaderLabels(locale);
  const storeSnapshot = useContractHeaderStoreSnapshot(marketSymbol);
  const legacyRead = useMemo<ContractHeaderLegacyRead>(() => ({
    displayPrice: legacyDisplayPrice,
    change: legacyChange ?? null,
    quoteStatusLabel: legacyQuoteStatusLabel ?? null,
    quoteStatusTone: legacyQuoteStatusTone,
    marketStatus: legacyMarketStatus ?? null,
    tickerSource: legacyTickerSource ?? null,
    tickerFreshness: legacyTickerFreshness ?? null,
    marketSessionType: legacyMarketSessionType ?? null,
    executable: legacyExecutable ?? null,
    displayPriceSource: legacyDisplayPriceSource ?? null,
    displayPriceLabel: legacyDisplayPriceLabel ?? null,
    markPrice: legacyMarkPrice ?? null,
    indexPrice: legacyIndexPrice ?? null,
    fundingRate: legacyFundingRate ?? null,
    bestBid: legacyBestBid ?? null,
    bestAsk: legacyBestAsk ?? null,
    spread: legacySpread ?? null,
    highLow24h: legacyHighLow24h ?? null,
    volumeTurnover24h: legacyVolumeTurnover24h ?? null,
  }), [
    legacyBestAsk,
    legacyBestBid,
    legacyChange,
    legacyDisplayPrice,
    legacyDisplayPriceLabel,
    legacyDisplayPriceSource,
    legacyExecutable,
    legacyFundingRate,
    legacyHighLow24h,
    legacyIndexPrice,
    legacyMarketSessionType,
    legacyMarketStatus,
    legacyMarkPrice,
    legacyQuoteStatusLabel,
    legacyQuoteStatusTone,
    legacySpread,
    legacyTickerFreshness,
    legacyTickerSource,
    legacyVolumeTurnover24h,
  ]);
  const marketRead = resolveContractHeaderMarketRead(storeSnapshot, legacyRead);
  const {
    displayPrice,
    change,
    quoteStatusLabel,
    quoteStatusTone,
    marketStatus,
    tickerFreshness,
    marketSessionType,
    executable,
    displayPriceSource,
    displayPriceLabel,
    markPrice,
    indexPrice,
    fundingRate,
    bestBid,
    bestAsk,
    spread,
    highLow24h,
    volumeTurnover24h,
  } = marketRead;

  useEffect(() => {
    const differences = getContractHeaderReadDifferences(storeSnapshot, legacyRead);
    if (!storeSnapshot || differences.length === 0) return;
    console.info('[contract-header-market-diff]', {
      symbol: marketSymbol,
      provider: storeSnapshot.provider,
      providerGeneration: storeSnapshot.providerGeneration,
      revision: storeSnapshot.revision,
      observedAtMs: storeSnapshot.observedAtMs,
      differences,
    });
  }, [
    legacyRead,
    marketSymbol,
    storeSnapshot,
  ]);

  useEffect(() => {
    if (!displayPrice || displayPrice === '--') return undefined;

    const startTimer = window.setTimeout(() => {
      setFlash(true);
    }, 0);
    const endTimer = window.setTimeout(() => {
      setFlash(false);
    }, 320);

    return () => {
      window.clearTimeout(startTimer);
      window.clearTimeout(endTimer);
    };
  }, [displayPrice]);

  const priceColorClass = priceDirectionTextClass(priceDirection);
  const priceFlashClass = flash ? priceDirectionFlashClass(priceDirection) : '';
  const displaySymbol = formatContractDisplaySymbol(marketSymbol);
  const changeValue = String(change || '').trim();
  const changeColorClass = changeValue.startsWith('+')
    ? 'text-[#00c087]'
    : changeValue.startsWith('-')
      ? 'text-[#f6465d]'
      : 'text-white/58';
  const marketPresentation = resolveContractHeaderMarketPresentation({
    displayPrice,
    quoteStatusLabel,
    quoteStatusTone,
    marketStatus,
    marketSessionType,
    executable,
    locale,
  });

  return (
    <div
      className="tabular-nums border-b border-white/[0.06] bg-[#11161d] px-3 py-2 shadow-[inset_0_-1px_0_rgba(255,255,255,0.02)]"
      data-market-authority={marketRead.authority}
      data-provider-generation={storeSnapshot?.providerGeneration ?? ''}
    >
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
              className={`inline-flex max-w-full items-center truncate rounded-md px-1 py-0.5 text-[28px] font-semibold leading-none transition-all duration-200 ${priceColorClass} ${priceFlashClass} ${
                flash ? 'scale-[1.02] shadow-[0_0_24px_rgba(255,255,255,0.04)]' : 'scale-100'
              }`}
              data-display-freshness={tickerFreshness || ''}
              data-display-source={displayPriceSource || ''}
              data-testid="contract-header-display-price"
              title={displayPriceLabel || undefined}
            >
              {displayPrice}
            </div>
            <div className="min-h-4 pl-1 text-[12px] font-semibold leading-tight">
              <span className={changeColorClass}>{changeValue || '--'}</span>
            </div>
          </div>
        </div>

        <div className="grid min-w-0 flex-1 grid-cols-2 gap-2 text-[12px] text-gray-300 md:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-9">
          <Metric
            label={t('tradeStatus', 'contracts')}
            testId="contract-header-market-status-card"
            title={marketPresentation.label}
            value={(
              <span
                className="inline-flex min-w-0 items-center gap-1.5 whitespace-nowrap text-[13px] font-medium text-white/78"
                data-market-state={marketPresentation.state}
                data-testid="contract-header-market-status"
              >
                <span
                  aria-hidden="true"
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${marketPresentation.dotClass}`}
                  data-testid="contract-header-market-status-dot"
                />
                <span className="truncate">{marketPresentation.label}</span>
              </span>
            )}
          />
          <Metric label={t('markPrice', 'contracts')} testId="contract-header-mark-price" value={markPrice || '--'} />
          <Metric label={t('indexPrice', 'contracts')} testId="contract-header-index-price" value={indexPrice || '--'} />
          <Metric label={labels.fundingRate} testId="contract-header-funding-rate" value={fundingRate || '--'} />
          <Metric label={labels.bestBid} testId="contract-header-best-bid" value={bestBid || '--'} />
          <Metric label={labels.bestAsk} testId="contract-header-best-ask" value={bestAsk || '--'} />
          <Metric label={t('spread', 'contracts')} testId="contract-header-spread" value={spread || '--'} />
          <Metric label={t('highLow24h', 'contracts')} testId="contract-header-high-low-24h" value={highLow24h || '--'} />
          <Metric
            label={`${t('volume24h', 'contracts')} / ${t('turnover24h', 'contracts')}`}
            testId="contract-header-volume-turnover-24h"
            value={volumeTurnover24h || '--'}
          />
        </div>
      </div>
      {hint ? <div className="sr-only">{hint}</div> : null}
    </div>
  );
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
  title,
  testId,
}: {
  label: string;
  value: ReactNode;
  title?: string;
  testId: string;
}) {
  return (
    <div
      className="min-w-0 rounded-md border border-white/[0.045] bg-white/[0.02] px-3 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.02)]"
      data-testid={testId}
    >
      <div className="truncate text-[10px] font-medium leading-none text-white/36">
        {label}
      </div>
      <div className="mt-1.5 flex min-w-0 items-baseline gap-1.5 font-sans text-[13px] font-medium leading-tight tabular-nums text-white/88">
        <span className="min-w-0 truncate" title={title || (typeof value === 'string' ? value : undefined)}>
          {value}
        </span>
      </div>
    </div>
  );
}
