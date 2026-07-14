import type {
  ContractMarketViewDetail,
  ContractQuote,
} from '@/lib/api/modules/contract';
import type { ContractMarketViewAuthorityState } from './contractMarketView.utils';
import type { ContractTradingFormStoreSnapshot } from './hooks/contractMarketStoreAdapter';

export type ContractTradingFormLegacyMarketRead = {
  displayPrice: string | null;
  displayPriceSource: string | null;
  markPrice: string | null;
  indexPrice: string | null;
  marketStatus: string | null;
  displayState: string | null;
  executable: boolean | null;
  reasonCode: string | null;
  source: string | null;
  freshness: string | null;
  stale: boolean;
  loading: boolean;
};

export type ContractTradingFormMarketRead = ContractTradingFormLegacyMarketRead & {
  authority: 'STORE' | 'LEGACY_FALLBACK';
  symbol: string | null;
};

export type ContractTradingFormMarketDifference = {
  field:
    | 'display_price'
    | 'mark_price'
    | 'index_price'
    | 'market_status'
    | 'executable'
    | 'source'
    | 'freshness';
  store: unknown;
  legacy: unknown;
};

function positivePriceText(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  const normalized = typeof value === 'string' ? value.replace(/,/g, '').trim() : value;
  const numeric = Number(normalized);
  return Number.isFinite(numeric) && numeric > 0 ? String(normalized) : null;
}

function normalizedText(value: unknown): string | null {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

function comparablePrice(value: unknown): number | null {
  const normalized = positivePriceText(value);
  return normalized === null ? null : Number(normalized);
}

export function buildContractTradingFormLegacyMarketRead(params: {
  quote: ContractQuote | null;
  marketView?: ContractMarketViewDetail | null;
  loading?: boolean;
}): ContractTradingFormLegacyMarketRead {
  const { quote, marketView } = params;
  const freshness = normalizedText(
    marketView?.ticker_freshness
    ?? quote?.quote_freshness,
  );
  return {
    displayPrice: positivePriceText(marketView?.display_price ?? quote?.last_price),
    displayPriceSource: normalizedText(
      marketView?.display_price_source
      ?? marketView?.current_price_source
      ?? quote?.source
      ?? quote?.quote_source,
    ),
    markPrice: positivePriceText(quote?.mark_price),
    indexPrice: positivePriceText(quote?.index_price),
    marketStatus: normalizedText(marketView?.market_status ?? quote?.market_status),
    displayState: normalizedText(marketView?.display_state),
    executable: typeof marketView?.executable === 'boolean'
      ? marketView.executable
      : typeof quote?.executable === 'boolean'
        ? quote.executable
        : null,
    reasonCode: normalizedText(marketView?.reason_code),
    source: normalizedText(
      marketView?.ticker_source
      ?? quote?.source
      ?? quote?.quote_source,
    ),
    freshness,
    stale: ['STALE', 'LAST_GOOD', 'LAST_VALID', 'MISSING', 'UNAVAILABLE'].includes(
      String(freshness ?? '').trim().toUpperCase(),
    ),
    loading: params.loading === true,
  };
}

export function resolveContractTradingFormMarketRead(
  store: ContractTradingFormStoreSnapshot | null,
  legacy: ContractTradingFormLegacyMarketRead,
): ContractTradingFormMarketRead {
  if (!store) {
    return {
      ...legacy,
      authority: 'LEGACY_FALLBACK',
      symbol: null,
    };
  }
  return {
    displayPrice: store.displayPrice,
    displayPriceSource: store.displayPriceSource,
    markPrice: store.markPrice,
    indexPrice: store.indexPrice,
    marketStatus: store.marketStatus,
    displayState: store.displayState,
    executable: store.executable,
    reasonCode: store.reasonCode,
    source: store.source,
    freshness: store.freshness,
    stale: store.stale,
    loading: false,
    authority: 'STORE',
    symbol: store.symbol,
  };
}

export function getContractTradingFormMarketDifferences(
  store: ContractTradingFormStoreSnapshot | null,
  legacy: ContractTradingFormLegacyMarketRead,
): ContractTradingFormMarketDifference[] {
  if (!store) return [];
  const differences: ContractTradingFormMarketDifference[] = [];
  const priceFields = [
    ['display_price', store.displayPrice, legacy.displayPrice],
    ['mark_price', store.markPrice, legacy.markPrice],
    ['index_price', store.indexPrice, legacy.indexPrice],
  ] as const;
  for (const [field, storeValue, legacyValue] of priceFields) {
    if (comparablePrice(storeValue) !== comparablePrice(legacyValue)) {
      differences.push({ field, store: storeValue, legacy: legacyValue });
    }
  }

  const valueFields = [
    ['market_status', store.marketStatus, legacy.marketStatus],
    ['executable', store.executable, legacy.executable],
    ['source', store.source, legacy.source],
    ['freshness', store.freshness, legacy.freshness],
  ] as const;
  for (const [field, storeValue, legacyValue] of valueFields) {
    const comparableStore = typeof storeValue === 'string'
      ? storeValue.trim().toUpperCase()
      : storeValue ?? null;
    const comparableLegacy = typeof legacyValue === 'string'
      ? legacyValue.trim().toUpperCase()
      : legacyValue ?? null;
    if (comparableStore !== comparableLegacy) {
      differences.push({ field, store: storeValue, legacy: legacyValue });
    }
  }
  return differences;
}

export function resolveContractTradingFormMarketState(
  read: ContractTradingFormMarketRead,
): ContractMarketViewAuthorityState {
  if (read.loading) return 'loading';
  const displayState = String(read.displayState ?? '').trim().toUpperCase();
  const marketStatus = String(read.marketStatus ?? '').trim().toUpperCase();
  if (displayState === 'PRE_MARKET' || marketStatus === 'PRE_MARKET') return 'pre_market';
  if (displayState === 'AFTER_HOURS' || marketStatus === 'AFTER_HOURS') return 'after_hours';
  if (
    displayState === 'HOLIDAY'
    || marketStatus === 'HOLIDAY'
  ) return 'holiday';
  if (
    displayState === 'CLOSED'
    || displayState === 'MARKET_CLOSED'
    || displayState.startsWith('CLOSED_')
    || marketStatus === 'CLOSED'
    || marketStatus === 'MARKET_CLOSED'
  ) return 'closed';
  const freshness = String(read.freshness ?? '').trim().toUpperCase();
  if (
    read.stale
    || read.executable === false
    || ['STALE', 'LAST_GOOD', 'LAST_VALID', 'MISSING', 'UNAVAILABLE'].includes(freshness)
    || displayState === 'EXPIRED'
    || displayState === 'UNAVAILABLE'
  ) return 'unavailable';
  if (read.displayPrice || read.markPrice || read.indexPrice) return 'live';
  return 'unavailable';
}
