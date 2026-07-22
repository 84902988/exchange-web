'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocaleContext } from '@/contexts/LocaleContext';
import {
  useContractHeaderStoreSnapshot,
  type ContractHeaderStoreSnapshot,
} from './hooks/contractMarketStoreAdapter';
import { formatContractHeaderChange } from './contractHeaderChange';
import type { ContractReferencePrice } from './contractPriceAuthority';

export type ContractHeaderPriceDirection = 'up' | 'down' | 'flat';
export type ContractHeaderQuoteStatusTone = 'loading' | 'live' | 'last' | 'expired' | 'unavailable';
export type ContractHeaderMarketState = 'loading' | 'live' | 'pre_market' | 'after_hours' | 'closed' | 'holiday' | 'unavailable';

type ContractHeaderLabels = {
  loading: string;
  waitingForQuote: string;
  live: string;
  preMarket: string;
  afterHours: string;
  closed: string;
  holiday: string;
  unavailable: string;
  trading: string;
  notTradable: string;
  bestBid: string;
  bestAsk: string;
};

const HEADER_LABELS: Record<string, ContractHeaderLabels> = {
  en: {
    loading: 'Loading',
    waitingForQuote: 'Waiting for quote',
    live: 'Live',
    preMarket: 'Pre-market',
    afterHours: 'After-hours',
    closed: 'Closed',
    holiday: 'Market holiday',
    unavailable: 'Market data unavailable',
    trading: 'Trading',
    notTradable: 'Unavailable',
    bestBid: 'Best Bid',
    bestAsk: 'Best Ask',
  },
  zh: {
    loading: '\u52a0\u8f7d\u4e2d',
    waitingForQuote: '\u7b49\u5f85\u884c\u60c5',
    live: '\u5b9e\u65f6',
    preMarket: '\u76d8\u524d',
    afterHours: '\u76d8\u540e',
    closed: '\u95ed\u5e02\u4e2d',
    holiday: '\u4f11\u5e02\u4e2d',
    unavailable: '\u884c\u60c5\u6682\u4e0d\u53ef\u7528',
    trading: '\u4ea4\u6613\u4e2d',
    notTradable: '\u4e0d\u53ef\u4ea4\u6613',
    bestBid: '\u4e70\u4e00',
    bestAsk: '\u5356\u4e00',
  },
  'zh-TW': {
    loading: '\u8f09\u5165\u4e2d',
    waitingForQuote: '\u7b49\u5f85\u884c\u60c5',
    live: '\u5373\u6642',
    preMarket: '\u76e4\u524d',
    afterHours: '\u76e4\u5f8c',
    closed: '\u9589\u5e02\u4e2d',
    holiday: '\u4f11\u5e02\u4e2d',
    unavailable: '\u884c\u60c5\u66ab\u4e0d\u53ef\u7528',
    trading: '\u4ea4\u6613\u4e2d',
    notTradable: '\u4e0d\u53ef\u4ea4\u6613',
    bestBid: '\u8cb7\u4e00',
    bestAsk: '\u8ce3\u4e00',
  },
  ja: {
    loading: '\u8aad\u307f\u8fbc\u307f\u4e2d',
    waitingForQuote: '\u30ec\u30fc\u30c8\u5f85\u3061',
    live: '\u30ea\u30a2\u30eb\u30bf\u30a4\u30e0',
    preMarket: '\u30d7\u30ec\u30de\u30fc\u30b1\u30c3\u30c8',
    afterHours: '\u6642\u9593\u5916',
    closed: '\u9589\u5834\u4e2d',
    holiday: '\u4f11\u5834\u4e2d',
    unavailable: '\u5e02\u5834\u30c7\u30fc\u30bf\u3092\u5229\u7528\u3067\u304d\u307e\u305b\u3093',
    trading: '\u53d6\u5f15\u4e2d',
    notTradable: '\u53d6\u5f15\u4e0d\u53ef',
    bestBid: '\u6700\u826f\u8cb7\u6c17\u914d',
    bestAsk: '\u6700\u826f\u58f2\u6c17\u914d',
  },
};

type ContractMarketHeaderProps = {
  marketSymbol: string;
  isTradfi?: boolean;
  referencePrice?: ContractReferencePrice | null;
  pricePrecision?: number;
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
  markPriceLabel?: string | null;
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

function formatStoreChange(
  store: ContractHeaderStoreSnapshot,
  fallback: string | null,
  displayPriceFallback: string,
) {
  if (store.priceChange24h === null && store.priceChangePercent24h === null) return fallback;
  const precision = inferFractionDigits(displayPriceFallback, 2);
  return formatContractHeaderChange({
    changeAmount: store.priceChange24h,
    changePercent: store.priceChangePercent24h,
    pricePrecision: precision,
  }) ?? fallback;
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
  const storeDisplayState = normalizeToken(store.displayState);
  const storeHasLiveStructure = ['LIVE_TRADABLE', 'REGULAR_OPEN'].includes(storeDisplayState)
    && store.executable === true;
  const preserveBootstrapLoading = legacy.quoteStatusTone === 'loading'
    && (
      !storeDisplayState
      || ['LOADING', 'MARKET_DATA_UNAVAILABLE', 'UNAVAILABLE', 'UNKNOWN']
        .includes(storeDisplayState)
    );
  const legacyBid = parseComparableNumber(legacy.bestBid);
  const legacyAsk = parseComparableNumber(legacy.bestAsk);
  const legacyHasLiveStructure = legacy.quoteStatusTone === 'live'
    && legacy.executable === true
    && legacyBid !== null
    && legacyAsk !== null
    && legacyBid > 0
    && legacyAsk >= legacyBid;
  // Header reads the low-latency Store directly, but a just-reconnected ticker
  // can briefly retain unavailable structure while the complete MarketView
  // REST/depth authority is already live. Keep non-price Store metrics, and
  // recover structure plus BBO/valuation from that same-symbol authority.
  const recoverStructureFromLegacy = legacyHasLiveStructure && !storeHasLiveStructure;
  const executable = recoverStructureFromLegacy
    ? legacy.executable
    : store.executable ?? legacy.executable;
  const displayPrice = recoverStructureFromLegacy
    ? legacy.displayPrice
    : formatStoreNumber(store.displayPrice, legacy.displayPrice) || legacy.displayPrice;
  const highLow24h = store.high24h !== null || store.low24h !== null
    ? `${formatStoreNumber(store.high24h, null) || '--'} / ${formatStoreNumber(store.low24h, null) || '--'}`
    : legacy.highLow24h;
  const volumeTurnover24h = store.baseVolume24h !== null || store.quoteVolume24h !== null
    ? `${formatCompactAmount(store.baseVolume24h)} / ${formatCompactAmount(store.quoteVolume24h)}`
    : legacy.volumeTurnover24h;
  const displayPriceSource = recoverStructureFromLegacy
    ? legacy.displayPriceSource
    : store.displayPriceSource ?? legacy.displayPriceSource;

  return {
    authority: 'STORE',
    displayPrice,
    change: formatStoreChange(store, legacy.change, legacy.displayPrice),
    quoteStatusLabel: recoverStructureFromLegacy || preserveBootstrapLoading
      ? legacy.quoteStatusLabel
      : store.displayState || store.marketStatus || legacy.quoteStatusLabel,
    quoteStatusTone: recoverStructureFromLegacy || preserveBootstrapLoading
      ? legacy.quoteStatusTone
      : resolveStoreQuoteTone(store, executable, legacy.quoteStatusTone),
    marketStatus: recoverStructureFromLegacy
      ? legacy.marketStatus
      : store.marketStatus ?? legacy.marketStatus,
    tickerSource: recoverStructureFromLegacy
      ? legacy.tickerSource
      : store.source ?? legacy.tickerSource,
    tickerFreshness: recoverStructureFromLegacy
      ? legacy.tickerFreshness
      : store.freshness ?? legacy.tickerFreshness,
    marketSessionType: recoverStructureFromLegacy
      ? legacy.marketSessionType
      : store.marketSessionType ?? legacy.marketSessionType,
    executable,
    displayPriceSource,
    displayPriceLabel: displayPriceSource && displayPriceSource !== legacy.displayPriceSource
      ? displayPriceSource
      : legacy.displayPriceLabel,
    markPrice: recoverStructureFromLegacy
      ? legacy.markPrice
      : formatStoreNumber(store.markPrice, legacy.markPrice),
    indexPrice: recoverStructureFromLegacy
      ? legacy.indexPrice
      : formatStoreNumber(store.indexPrice, legacy.indexPrice),
    fundingRate: formatStoreFunding(store.fundingRate, legacy.fundingRate),
    bestBid: recoverStructureFromLegacy
      ? legacy.bestBid
      : formatStoreNumber(store.bestBid, legacy.bestBid),
    bestAsk: recoverStructureFromLegacy
      ? legacy.bestAsk
      : formatStoreNumber(store.bestAsk, legacy.bestAsk),
    spread: recoverStructureFromLegacy
      ? legacy.spread
      : formatStoreNumber(store.spread, legacy.spread),
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
  tradingLabel: string;
  dotClass: string;
} {
  const labels = getHeaderLabels(locale);
  const statusLabel = [quoteStatusLabel, marketStatus, marketSessionType]
    .map(normalizeToken)
    .filter(Boolean)
    .join(' ');

  if (quoteStatusTone === 'loading') {
    return {
      state: 'loading',
      label: labels.loading,
      tradingLabel: labels.waitingForQuote,
      dotClass: 'bg-[#f0b90b] animate-pulse',
    };
  }

  if (
    includesAny(statusLabel, ['PRE-MARKET', '\u76d8\u524d', '\u76e4\u524d', '\u30d7\u30ec\u30de\u30fc\u30b1\u30c3\u30c8'])
  ) {
    return {
      state: 'pre_market',
      label: labels.preMarket,
      tradingLabel: labels.notTradable,
      dotClass: 'bg-[#f0b90b]',
    };
  }
  if (
    includesAny(statusLabel, ['AFTER-HOURS', '\u76d8\u540e', '\u76e4\u5f8C', '\u6642\u9593\u5916'])
  ) {
    return {
      state: 'after_hours',
      label: labels.afterHours,
      tradingLabel: labels.notTradable,
      dotClass: 'bg-[#f0b90b]',
    };
  }
  if (
    includesAny(statusLabel, ['HOLIDAY', '\u4f11\u5e02', '\u4f11\u5834', '\u5e02\u5834\u5047\u671f'])
  ) {
    return {
      state: 'holiday',
      label: labels.holiday,
      tradingLabel: labels.notTradable,
      dotClass: 'bg-[#f0b90b]',
    };
  }
  if (
    includesAny(statusLabel, ['CLOSED', '\u95ed\u5e02', '\u9589\u5e02', '\u9589\u5834'])
  ) {
    return {
      state: 'closed',
      label: labels.closed,
      tradingLabel: labels.notTradable,
      dotClass: 'bg-[#f0b90b]',
    };
  }

  const hasDisplayPrice = !!String(displayPrice || '').trim() && displayPrice !== '--';
  if (!hasDisplayPrice || executable !== true || quoteStatusTone !== 'live') {
    return {
      state: 'unavailable',
      label: labels.unavailable,
      tradingLabel: labels.notTradable,
      dotClass: 'bg-[#f6465d]',
    };
  }

  return {
    state: 'live',
    label: labels.live,
    tradingLabel: labels.trading,
    dotClass: 'bg-[#00c087]',
  };
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

function formatReferencePrice(referencePrice: ContractReferencePrice | null | undefined, pricePrecision: number) {
  if (!referencePrice?.usable || referencePrice.value === null || !Number.isFinite(referencePrice.value)) {
    return '--';
  }
  const precision = Number.isInteger(pricePrecision) && pricePrecision >= 0
    ? Math.min(pricePrecision, 12)
    : 2;
  return referencePrice.value.toLocaleString('en-US', {
    minimumFractionDigits: precision,
    maximumFractionDigits: precision,
  });
}

function isClosedMarketDisplayState(
  marketStatus?: string | null,
  marketSessionType?: string | null,
) {
  const normalizedStatus = String(marketStatus || '').trim().toUpperCase();
  const normalizedSession = String(marketSessionType || '').trim().toUpperCase();
  return normalizedStatus === 'CLOSED'
    || normalizedStatus === 'HOLIDAY'
    || ['PRE_MARKET', 'AFTER_HOURS', 'CLOSED', 'HOLIDAY'].includes(normalizedSession);
}

export default function ContractMarketHeader({
  marketSymbol,
  isTradfi = false,
  referencePrice,
  pricePrecision = 2,
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
  markPriceLabel,
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
  const originalDocumentTitleRef = useRef<string | null>(null);
  const titleUpdateTimerRef = useRef<number | null>(null);
  const titleUpdatedAtRef = useRef(0);
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
    displayPrice: marketReadDisplayPrice,
    change,
    quoteStatusLabel,
    quoteStatusTone,
    marketStatus,
    tickerFreshness: marketReadTickerFreshness,
    marketSessionType,
    executable,
    displayPriceSource: marketReadDisplayPriceSource,
    displayPriceLabel: marketReadDisplayPriceLabel,
    markPrice,
    bestBid,
    bestAsk,
    highLow24h,
    volumeTurnover24h,
  } = marketRead;
  const hasReferencePriceContract = referencePrice !== null && referencePrice !== undefined;
  const usesReferencePrice = hasReferencePriceContract && referencePrice.usable;
  const usesClosedMarketDisplayFallback = hasReferencePriceContract
    && !referencePrice.usable
    && isClosedMarketDisplayState(marketStatus, marketSessionType);
  const legacyDisplayValue = String(legacyDisplayPrice || '').trim() || '--';
  const displayPrice = usesReferencePrice
    ? formatReferencePrice(referencePrice, pricePrecision)
    : !hasReferencePriceContract
      ? marketReadDisplayPrice
      : usesClosedMarketDisplayFallback
        ? legacyDisplayValue
        : '--';
  const displayPriceFreshness = usesReferencePrice
    ? referencePrice.freshness
    : !hasReferencePriceContract
      ? marketReadTickerFreshness
      : usesClosedMarketDisplayFallback
        ? legacyTickerFreshness
        : referencePrice.freshness;
  const displayPriceSource = usesReferencePrice
    ? referencePrice.source
    : !hasReferencePriceContract
      ? marketReadDisplayPriceSource
      : usesClosedMarketDisplayFallback
        ? legacyDisplayPriceSource
        : referencePrice.source;
  const referencePriceRole = hasReferencePriceContract && !usesClosedMarketDisplayFallback
    ? referencePrice.role
    : null;
  const displayPriceTitle = hasReferencePriceContract && !usesClosedMarketDisplayFallback
    ? referencePrice.role
    : !hasReferencePriceContract
      ? marketReadDisplayPriceLabel
      : legacyDisplayPriceLabel;
  const displaySymbol = formatContractDisplaySymbol(marketSymbol);

  useEffect(() => {
    originalDocumentTitleRef.current = document.title || 'Royal Exchange';

    return () => {
      if (titleUpdateTimerRef.current !== null) {
        window.clearTimeout(titleUpdateTimerRef.current);
        titleUpdateTimerRef.current = null;
      }
      document.title = originalDocumentTitleRef.current || 'Royal Exchange';
    };
  }, []);

  useEffect(() => {
    const titlePrice = displayPrice && displayPrice !== '--' ? displayPrice : '';
    const nextTitle = titlePrice
      ? `${titlePrice} ${displaySymbol} 合约交易 | Royal Exchange`
      : `${displaySymbol} 合约交易 | Royal Exchange`;
    const now = Date.now();
    const remainingMs = Math.max(1000 - (now - titleUpdatedAtRef.current), 0);
    const applyTitle = () => {
      document.title = nextTitle;
      titleUpdatedAtRef.current = Date.now();
      titleUpdateTimerRef.current = null;
    };

    if (titleUpdateTimerRef.current !== null) {
      window.clearTimeout(titleUpdateTimerRef.current);
      titleUpdateTimerRef.current = null;
    }

    if (remainingMs === 0) {
      applyTitle();
      return;
    }

    titleUpdateTimerRef.current = window.setTimeout(applyTitle, remainingMs);
  }, [displayPrice, displaySymbol]);

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
      data-market-authority={hasReferencePriceContract ? 'PRICE_AUTHORITY_V1' : marketRead.authority}
      data-provider-generation={storeSnapshot?.providerGeneration ?? ''}
      data-secondary-market-authority={marketRead.authority}
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
              data-display-freshness={displayPriceFreshness || ''}
              data-display-source={displayPriceSource || ''}
              data-reference-role={referencePriceRole || ''}
              data-testid="contract-header-display-price"
              title={displayPriceTitle || undefined}
            >
              {displayPrice}
            </div>
            <div className="min-h-4 pl-1 text-[12px] font-semibold leading-tight">
              <span className={changeColorClass}>{changeValue || '--'}</span>
            </div>
          </div>
        </div>

        <div className={`grid min-w-0 flex-1 grid-cols-2 gap-2 text-[12px] text-gray-300 md:grid-cols-4 ${isTradfi ? 'xl:grid-cols-[1.05fr_0.9fr_0.75fr_1.3fr_1.35fr_0.85fr_0.85fr]' : 'xl:grid-cols-7'}`}>
          <Metric
            label={t('tradeStatus', 'contracts')}
            testId="contract-header-market-status-card"
            title={`${marketPresentation.label} \u00b7 ${marketPresentation.tradingLabel}`}
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
                <span className="text-white/36">{'\u00b7'}</span>
                <span className="truncate">{marketPresentation.tradingLabel}</span>
              </span>
            )}
          />
          <Metric label={markPriceLabel || t('markPrice', 'contracts')} testId="contract-header-mark-price" value={markPrice || '--'} />
          {!isTradfi ? (
            <>
              <Metric label={labels.bestBid} testId="contract-header-best-bid" value={bestBid || '--'} />
              <Metric label={labels.bestAsk} testId="contract-header-best-ask" value={bestAsk || '--'} />
            </>
          ) : null}
          <Metric label={t('spread', 'contracts')} testId="contract-header-spread" value={t('spreadFloating', 'contracts')} />
          <Metric label={t('highLow24h', 'contracts')} testId="contract-header-high-low-24h" value={highLow24h || '--'} />
          <Metric
            label={`${t('volume24h', 'contracts')} / ${t('turnover24h', 'contracts')}`}
            testId="contract-header-volume-turnover-24h"
            value={volumeTurnover24h || '--'}
          />
          {isTradfi ? (
            <>
              <Metric label={labels.bestBid} testId="contract-header-best-bid" value={bestBid || '--'} />
              <Metric label={labels.bestAsk} testId="contract-header-best-ask" value={bestAsk || '--'} />
            </>
          ) : null}
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
