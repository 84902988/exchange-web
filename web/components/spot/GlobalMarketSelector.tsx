'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getRuntimeApiBaseUrl } from '@/lib/api/core/baseUrl';
import {
  getSpotMarketPairs,
  getSpotMarketTickers,
  type SpotMarketPairItem,
  type SpotMarketTickerItem,
} from '@/lib/api/modules/spot';
import {
  getContractSymbols,
  getContractTickers,
  type ContractTickerItem,
  type ContractSymbolItem,
} from '@/lib/api/modules/contract';
import type { MarketTickerItem } from '@/lib/api/modules/market';
import { readSharedMarketsRowsCache } from '@/lib/marketCache';
import { readContractQuoteCache } from '@/lib/contractMarketCache';
import { formatSpotDisplaySymbol } from './spotFormat';
import { useLocaleContext } from '@/contexts/LocaleContext';
import {
  formatSpotPrice,
  resolveSpotPricePrecision,
} from './spotPricePrecision';

type MarketLayerTab = 'favorites' | 'crypto' | 'stock' | 'cfd';
type ToolbarPageType = 'spot' | 'contract';
type SpotChartMode = 'time' | 'candle';
export type PairCategory = 'all' | 'spot' | 'contract' | 'platform' | 'rwa';
type StockCategory = 'all' | 'stock_contract';
type ContractCategory = 'all' | 'metal' | 'commodity' | 'index' | 'forex';
type FavoriteMarket = 'spot' | 'contract';
type FavoriteSymbolItem = {
  symbol: string;
  market: FavoriteMarket;
};
type MarketDisplayLabels = {
  stockSuffix: string;
  spotGroup: string;
  perpetualSuffix: string;
  stockContractGroup: string;
  perpetualContractGroup: string;
  contractGroup: string;
};
export type PairQueryUpdate = {
  marketType: 'spot' | 'contract' | 'all';
  category: string;
  quote: string;
  keyword: string;
};

export interface GlobalMarketSelectorPair {
  symbol: string;
  label?: string;
  displaySymbol?: string | null;
  externalSymbol?: string | null;
  baseAsset?: string | null;
  quoteAsset?: string | null;
  baseAssetLogoUrl?: string | null;
  assetType?: string | null;
  dataSource?: string | null;
  marketMode?: string | null;
  marketCategory?: string | null;
  marketSubCategory?: string | null;
  displayCategory?: string | null;
  displayGroup?: string | null;
  sourceSymbol?: string | null;
  price?: string | number | null;
  change24h?: string | number | null;
  percentChange24h?: string | number | null;
  priceChangePercent?: string | number | null;
  priceChange24h?: string | number | null;
  volume24h?: string | number | null;
  baseVolume24h?: string | number | null;
  quoteVolume24h?: string | number | null;
  high24h?: string | number | null;
  low24h?: string | number | null;
  marketStatus?: string | null;
  marketStatusText?: string | null;
  marketSessionCode?: string | null;
  marketTimezone?: string | null;
  marketTradingHours?: string | null;
  marketSessionType?: string | null;
  quoteFreshness?: string | null;
  tpSlTriggerPriceType?: 'MARK_PRICE' | 'LAST_PRICE' | string | null;
  displayPricePrecision?: number | null;
  pricePrecision?: number | null;
  priceTickSize?: string | number | null;
  amountPrecision?: number | null;
  maxLeverage?: number | null;
  showSpotLogo?: boolean | null;
  spotLogoUrl?: string | null;
  spotLogoAlt?: string | null;
}

interface GlobalMarketSelectorProps {
  symbol: string;
  interval: string;
  chartMode?: SpotChartMode;
  onSymbolChange: (value: string) => void;
  onIntervalChange: (value: string) => void;
  onChartModeChange?: (value: SpotChartMode) => void;
  symbols: string[];
  symbolLabels?: Record<string, string>;
  pairs?: GlobalMarketSelectorPair[];
  pairsLoading?: boolean;
  pairsLoadingMore?: boolean;
  hasMorePairs?: boolean;
  pageType?: ToolbarPageType;
  placement?: 'toolbar' | 'header';
  initialCategory?: PairCategory;
  onPairQueryChange?: (query: PairQueryUpdate) => void;
  onLoadMorePairs?: () => void;
}

const intervals = ['1m', '5m', '15m', '1h', '4h', '1d', '1w', '1M'];
const TRADFI_INTERVALS = intervals.filter((item) => item !== '4h');

const MARKET_TABS: Array<{ key: MarketLayerTab; labelKey: string }> = [
  { key: 'favorites', labelKey: 'favorites' },
  { key: 'crypto', labelKey: 'crypto' },
  { key: 'stock', labelKey: 'stocks' },
  { key: 'cfd', labelKey: 'cfd' },
];

const CRYPTO_CATEGORY_TABS: Array<{ key: PairCategory; labelKey: string }> = [
  { key: 'all', labelKey: 'all' },
  { key: 'spot', labelKey: 'spot' },
  { key: 'contract', labelKey: 'contract' },
  { key: 'platform', labelKey: 'platformToken' },
  { key: 'rwa', labelKey: 'rwa' },
];

const STOCK_CATEGORY_TABS: Array<{ key: StockCategory; labelKey: string }> = [
  { key: 'all', labelKey: 'all' },
  { key: 'stock_contract', labelKey: 'stockContracts' },
];

const CONTRACT_CATEGORY_TABS: Array<{ key: ContractCategory; labelKey: string }> = [
  { key: 'all', labelKey: 'all' },
  { key: 'index', labelKey: 'index' },
  { key: 'forex', labelKey: 'forex' },
  { key: 'metal', labelKey: 'preciousMetals' },
  { key: 'commodity', labelKey: 'commodities' },
];


const SPOT_TICKER_BATCH_SIZE = 30;
const SPOT_TICKER_PRELOAD_SIZE = 50;
const PAIRS_PAGE_SIZE = 100;
const CONTRACT_TICKER_BATCH_SIZE = 25;
const STOCK_CONTRACT_TICKER_BATCH_SIZE = 12;
const CONTRACT_TICKER_REFRESH_TTL_MS = 25_000;
const STOCK_CONTRACT_TICKER_REFRESH_TTL_MS = 60_000;
const VISIBLE_TICKER_LOAD_DEBOUNCE_MS = 350;
const PAIR_SELECTOR_METADATA_CACHE_TTL_MS = 30_000;
const MARKET_SELECTOR_CACHE_VERSION = 'v3';
const FAVORITE_SYMBOLS_STORAGE_KEY = 'royal_exchange_favorite_symbols_v1';
const DEFAULT_SPOT_PAIRS_CACHE_KEY = `spot:${MARKET_SELECTOR_CACHE_VERSION}:all:all:`;
const DEFAULT_CONTRACT_PAIRS_CACHE_KEY = `contract:${MARKET_SELECTOR_CACHE_VERSION}:all:all:`;
const spotPairsCacheStore = new Map<string, GlobalMarketSelectorPair[]>();
const contractPairsCacheStore = new Map<string, GlobalMarketSelectorPair[]>();
const spotPairsCacheFetchedAtStore = new Map<string, number>();
const contractPairsCacheFetchedAtStore = new Map<string, number>();
const tickerCacheStore = new Map<string, GlobalMarketSelectorPair>();
const tickerHydratingStore = new Set<string>();
const contractTickerCacheStore = new Map<string, GlobalMarketSelectorPair>();
const contractTickerHydratingStore = new Set<string>();
const contractTickerFetchedAtStore = new Map<string, number>();
const contractTickerBatchHydratingStore = new Set<string>();

function appendMarketSuffix(value: string, suffix: string): string {
  const base = String(value || '').trim();
  return suffix ? `${base} ${suffix}`.trim() : base;
}

function normalize(value?: string | number | null): string {
  return String(value ?? '').trim().toUpperCase();
}

function normalizePairSearchText(value?: string | number | null): string {
  return normalize(value).replace(/[^A-Z0-9-]/g, '');
}

function normalizeSpotApiSymbol(value?: string | number | null): string {
  return normalize(value).replace(/[^A-Z0-9-]/g, '');
}

function normalizeUnknown(value: unknown): string {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return normalize(value);
}

function optionalTickerValue(value: unknown): string | number | null {
  return typeof value === 'string' || typeof value === 'number' ? value : null;
}

function inferBaseQuote(pair: GlobalMarketSelectorPair): { base: string; quote: string } {
  const base = normalize(pair.baseAsset);
  const quote = normalize(pair.quoteAsset);
  if (base || quote) return { base, quote };

  const label = pair.displaySymbol || pair.label || formatSpotDisplaySymbol(pair.symbol);
  if (label.includes('/')) {
    const [labelBase, labelQuote] = label.split('/');
    return { base: normalize(labelBase), quote: normalize(labelQuote) };
  }

  for (const suffix of ['USDT', 'USDC', 'BTC', 'ETH']) {
    const symbol = normalize(pair.symbol);
    if (symbol.endsWith(suffix) && symbol.length > suffix.length) {
      return { base: symbol.slice(0, -suffix.length), quote: suffix };
    }
  }

  return { base: normalize(pair.symbol), quote: '' };
}


function isContractSymbol(pair: GlobalMarketSelectorPair): boolean {
  const symbol = normalize(pair.symbol);
  return symbol.includes('PERP') || symbol.includes('SWAP') || symbol.includes('FUTURES');
}


function isContractMarketPair(pair: GlobalMarketSelectorPair): boolean {
  const assetType = normalize(pair.assetType);
  const marketSubCategory = normalize(pair.marketSubCategory);

  if (isContractSymbol(pair)) return true;
  if (assetType === 'CONTRACT') return true;
  if (marketSubCategory.includes('CONTRACT') || marketSubCategory === 'STOCK_CONTRACT') return true;

  return false;
}

function isSpotMarketPair(pair: GlobalMarketSelectorPair): boolean {
  return !isContractMarketPair(pair);
}

function getPairMarket(pair: GlobalMarketSelectorPair): FavoriteMarket {
  return isContractMarketPair(pair) ? 'contract' : 'spot';
}

function getPairRowType(pair: GlobalMarketSelectorPair): 'spot' | 'stock_quote' | 'contract' {
  if (isStockQuotePair(pair)) return 'stock_quote';
  return isContractMarketPair(pair) ? 'contract' : 'spot';
}

function getPairUniqueKey(pair: GlobalMarketSelectorPair): string {
  return `${getPairRowType(pair)}:${normalize(pair.symbol)}`;
}

function isMockStockContractPair(pair: GlobalMarketSelectorPair): boolean {
  return pair.marketMode === 'MOCK_STOCK_CONTRACT';
}

function getPairTickerSymbol(pair: GlobalMarketSelectorPair): string {
  return normalize(pair.sourceSymbol || pair.symbol);
}

function getMarketRowTickerSymbol(row: MarketTickerItem): string {
  return normalizeUnknown(row.ticker_symbol || row.source_symbol || row.symbol);
}

function mergeUniquePairs(...groups: GlobalMarketSelectorPair[][]): GlobalMarketSelectorPair[] {
  const map = new Map<string, GlobalMarketSelectorPair>();
  groups.flat().forEach((item) => {
    const key = getPairUniqueKey(item);
    if (!map.has(key)) {
      map.set(key, item);
    }
  });
  return Array.from(map.values());
}

function readFreshPairCache(
  cache: Map<string, GlobalMarketSelectorPair[]>,
  fetchedAt: Map<string, number>,
  key: string,
): GlobalMarketSelectorPair[] | undefined {
  const rows = cache.get(key);
  if (!rows) return undefined;
  const updatedAt = fetchedAt.get(key) || 0;
  if (updatedAt && Date.now() - updatedAt <= PAIR_SELECTOR_METADATA_CACHE_TTL_MS) {
    return rows;
  }
  cache.delete(key);
  fetchedAt.delete(key);
  return undefined;
}

function writePairCache(
  cache: Map<string, GlobalMarketSelectorPair[]>,
  fetchedAt: Map<string, number>,
  key: string,
  rows: GlobalMarketSelectorPair[],
) {
  cache.set(key, rows);
  fetchedAt.set(key, Date.now());
}

function getFavoriteKey(symbol: string, market: FavoriteMarket): string {
  return `${market}:${normalize(symbol)}`;
}

function getFavoriteTarget(pair: GlobalMarketSelectorPair): FavoriteSymbolItem & { key: string } {
  const market = getPairMarket(pair);
  const symbol = market === 'spot' ? normalizeSpotApiSymbol(pair.symbol) : normalize(pair.symbol);
  return {
    symbol,
    market,
    key: getFavoriteKey(symbol, market),
  };
}

function parseBooleanFlag(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1;
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());
}

function resolveSpotAssetImageUrl(url?: string | null): string {
  const value = String(url || '').trim();
  if (!value) return '';
  if (/^(https?:)?\/\//i.test(value) || value.startsWith('data:') || value.startsWith('blob:')) {
    return value;
  }
  if (value.startsWith('/static/')) {
    return `${getRuntimeApiBaseUrl().replace(/\/+$/, '')}${value}`;
  }
  return value;
}

function getPairLogoUrl(pair?: GlobalMarketSelectorPair | null): string {
  return resolveSpotAssetImageUrl(pair?.baseAssetLogoUrl);
}

function getCoinLogoText(baseAsset: string): string {
  const normalized = normalize(baseAsset);
  return normalized.slice(0, 2) || '?';
}

function getCoinLogoClass(): string {
  return 'bg-[#1f2937] text-white/85';
}

function readFavoriteSymbols(): FavoriteSymbolItem[] {
  if (typeof window === 'undefined') return [];

  try {
    const rawValue = window.localStorage.getItem(FAVORITE_SYMBOLS_STORAGE_KEY);
    const parsed = rawValue ? JSON.parse(rawValue) : [];
    if (!Array.isArray(parsed)) return [];

    return parsed
      .map((item) => ({
        symbol: normalize(item?.symbol),
        market: (item?.market === 'contract' ? 'contract' : 'spot') as FavoriteMarket,
      }))
      .filter((item) => Boolean(item.symbol));
  } catch {
    return [];
  }
}

function writeFavoriteSymbols(items: FavoriteSymbolItem[]) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(FAVORITE_SYMBOLS_STORAGE_KEY, JSON.stringify(items));
}

function normalizeAssetClass(pair: GlobalMarketSelectorPair): string {
  const raw = normalize(pair.assetType || pair.marketCategory || pair.marketSubCategory || pair.displayGroup);
  if (raw === 'FX') return 'FOREX';
  if (raw === 'GOLD' || raw === 'SILVER' || raw === 'METAL') return 'METAL';
  if (raw === 'FUTURES' || raw === 'COMMODITY') return 'COMMODITY';
  if (raw === 'STOCK_CONTRACT') return 'STOCK';
  if (raw === 'CONTRACT') {
    const symbol = normalize(pair.symbol);
    if (symbol.includes('BTC') || symbol.includes('ETH')) return 'CRYPTO';
  }
  return raw;
}

function isPlatformPair(pair: GlobalMarketSelectorPair): boolean {
  return normalize(pair.displayCategory) === 'PLATFORM' || normalizeAssetClass(pair) === 'PLATFORM';
}

function isRwaPair(pair: GlobalMarketSelectorPair): boolean {
  return normalize(pair.displayCategory) === 'RWA' || normalizeAssetClass(pair) === 'RWA';
}

function isStockQuotePair(pair: GlobalMarketSelectorPair): boolean {
  const assetClass = normalizeAssetClass(pair);
  const marketSubCategory = normalize(pair.marketSubCategory);
  return assetClass === 'STOCK' && !isContractMarketPair(pair) && marketSubCategory !== 'STOCK_CONTRACT';
}

function isStockContractPair(pair: GlobalMarketSelectorPair): boolean {
  const assetClass = normalizeAssetClass(pair);
  const marketSubCategory = normalize(pair.marketSubCategory);
  return isContractMarketPair(pair) && (assetClass === 'STOCK' || marketSubCategory === 'STOCK_CONTRACT');
}

function isStockMarketPair(pair: GlobalMarketSelectorPair): boolean {
  return isStockContractPair(pair);
}

function isTradfiCfdPair(pair: GlobalMarketSelectorPair): boolean {
  return ['INDEX', 'FOREX', 'METAL', 'COMMODITY'].includes(normalizeAssetClass(pair));
}

function isCryptoContractPair(pair: GlobalMarketSelectorPair): boolean {
  if (!isContractMarketPair(pair) || isStockContractPair(pair) || isTradfiCfdPair(pair) || isRwaPair(pair)) return false;
  const assetClass = normalizeAssetClass(pair);
  return assetClass === 'CRYPTO' || assetClass === 'CONTRACT' || isContractSymbol(pair);
}

function isCryptoSpotPair(pair: GlobalMarketSelectorPair): boolean {
  return isSpotMarketPair(pair) && !isStockMarketPair(pair) && !isTradfiCfdPair(pair);
}

function getContractCategory(pair: GlobalMarketSelectorPair): ContractCategory {
  const assetClass = normalizeAssetClass(pair);
  if (assetClass === 'METAL') return 'metal';
  if (assetClass === 'COMMODITY') return 'commodity';
  if (assetClass === 'FOREX') return 'forex';
  if (assetClass === 'INDEX') return 'index';
  return 'all';
}

function getContractCategoryLabel(pair: GlobalMarketSelectorPair, t: (key: string, namespace?: 'markets') => string): string {
  const category = getContractCategory(pair);
  const match = CONTRACT_CATEGORY_TABS.find((item) => item.key === category);
  return match ? t(match.labelKey, 'markets') : 'CFD';
}

function getPairSubtitle(pair: GlobalMarketSelectorPair, t: (key: string, namespace?: 'markets') => string): string {
  if (isStockQuotePair(pair)) return t('stock', 'markets');
  if (isStockContractPair(pair)) return t('stockContracts', 'markets');
  if (isTradfiCfdPair(pair)) return getContractCategoryLabel(pair, t);
  if (isRwaPair(pair)) return isContractMarketPair(pair) ? `${t('rwa', 'markets')}${t('contract', 'markets')}` : `${t('rwa', 'markets')}${t('spot', 'markets')}`;
  if (isCryptoContractPair(pair)) return t('contract', 'markets');
  if (isPlatformPair(pair)) return t('platformToken', 'markets');
  return t('spot', 'markets');
}

function pairMatchesCryptoCategory(pair: GlobalMarketSelectorPair, category: PairCategory): boolean {
  if (category === 'all') return isCryptoSpotPair(pair) || isPlatformPair(pair) || isCryptoContractPair(pair) || isRwaPair(pair);
  if (category === 'spot') return isCryptoSpotPair(pair);
  if (category === 'contract') return isCryptoContractPair(pair);
  if (category === 'platform') return isSpotMarketPair(pair) && isPlatformPair(pair);
  if (category === 'rwa') return isRwaPair(pair);
  return false;
}

export function pairMatchesSpotSelectorSearch(pair: GlobalMarketSelectorPair, query: string): boolean {
  const normalizedQuery = normalizePairSearchText(query);
  if (!normalizedQuery) return true;

  const { base, quote: pairQuote } = inferBaseQuote(pair);
  const values = [
    pair.symbol,
    pair.displaySymbol,
    pair.label,
    pair.externalSymbol,
    base,
    pairQuote,
    pair.assetType,
    pair.marketCategory,
    pair.marketSubCategory,
    pair.displayCategory,
    pair.displayGroup,
    formatSpotDisplaySymbol(pair.symbol),
  ];
  return values.some((value) => normalizePairSearchText(value).includes(normalizedQuery));
}

export function pairMatchesSpotSelectorCategory(pair: GlobalMarketSelectorPair, category: PairCategory): boolean {
  return pairMatchesCryptoCategory(pair, category);
}

function pairMatchesStockCategory(pair: GlobalMarketSelectorPair, category: StockCategory): boolean {
  void category;
  return isStockContractPair(pair);
}

function pairMatchesContractCategory(pair: GlobalMarketSelectorPair, category: ContractCategory): boolean {
  if (!isTradfiCfdPair(pair)) return false;
  if (category === 'all') return true;
  return getContractCategory(pair) === category;
}

function getEmptyPairText(marketTab: MarketLayerTab, t: (key: string, namespace?: 'markets') => string): string {
  if (marketTab === 'favorites') return t('noFavoritePairs', 'markets');
  if (marketTab === 'stock') return t('noStockContracts', 'markets');
  if (marketTab === 'cfd') return t('noCfdPairs', 'markets');
  return t('noPairs', 'markets');
}

function formatPercent(value?: string | number | null): string {
  const num = Number(value);
  if (!Number.isFinite(num)) return '--';
  if (num === 0) return '0.00%';
  return `${num > 0 ? '+' : ''}${num.toFixed(2)}%`;
}

function formatIntervalLabel(value: string): string {
  const normalized = String(value || '').trim();
  if (normalized === '1h') return '1H';
  if (normalized === '4h') return '4H';
  if (normalized === '1d') return '1D';
  if (normalized === '1w') return '1W';
  if (normalized === '1M') return '1M';
  return normalized;
}

function getPairChangeValue(pair: GlobalMarketSelectorPair): string | number | null | undefined {
  return pair.change24h ?? pair.percentChange24h ?? pair.priceChangePercent;
}

function formatPrice(value?: string | number | null, pair?: GlobalMarketSelectorPair | null): string {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return '--';
  const pricePrecision = resolveSpotPricePrecision({
    displayPricePrecision: pair?.displayPricePrecision,
    pricePrecision: pair?.pricePrecision,
    priceTickSize: pair?.priceTickSize,
  });
  return formatSpotPrice(num, pricePrecision);
}

function hasValidTickerNumber(value?: string | number | null, options: { positiveOnly?: boolean } = {}): boolean {
  const num = Number(value);
  if (!Number.isFinite(num)) return false;
  return options.positiveOnly ? num > 0 : true;
}

function parseOptionalPrecision(value: unknown): number | null {
  const nextValue = Number(value);
  if (Number.isInteger(nextValue) && nextValue >= 0 && nextValue <= 12) {
    return nextValue;
  }
  return null;
}

function getTickerPrice(item: SpotMarketTickerItem | SpotMarketPairItem): string | number | null {
  const record = item as SpotMarketTickerItem;
  return record.last_price ?? record.price ?? record.last ?? record.close ?? null;
}

function getTickerChangePercent(item: SpotMarketTickerItem | SpotMarketPairItem): string | number | null {
  const record = item as SpotMarketTickerItem & {
    change_percent_24h?: string | number | null;
    changePercent24h?: string | number | null;
    changePercent?: string | number | null;
    change_percent?: string | number | null;
    percent_change_24h?: string | number | null;
    priceChangePercent?: string | number | null;
  };

  return (
    record.price_change_percent_24h ??
    record.change_percent_24h ??
    record.changePercent24h ??
    record.changePercent ??
    record.change_percent ??
    record.percent_change_24h ??
    record.priceChangePercent ??
    record.change_24h ??
    null
  );
}

function getMarketRowCategory(row: MarketTickerItem): string {
  const raw =
    row.asset_type ||
    row.market_category ||
    row.market_sub_category ||
    row.category ||
    row.underlying_type ||
    row.contract_type ||
    'CRYPTO';
  return normalizeUnknown(raw);
}

function isSharedContractMarketRow(row: MarketTickerItem): boolean {
  const symbol = normalize(row.symbol);
  const rowType = normalizeUnknown(row.rowType || row.row_type);
  const marketMode = normalize(row.market_mode);
  const marketCategory = normalize(row.market_category);
  const marketSubCategory = normalize(row.market_sub_category);
  return (
    rowType === 'CONTRACT' ||
    marketMode === 'MOCK_STOCK_CONTRACT' ||
    marketCategory === 'CONTRACT' ||
    marketSubCategory === 'CONTRACT' ||
    marketSubCategory === 'STOCK_CONTRACT' ||
    symbol.includes('PERP') ||
    symbol.includes('SWAP')
  );
}

function buildSharedMarketSelectorPair(
  row: MarketTickerItem,
  options: { includeTicker: boolean },
): GlobalMarketSelectorPair | null {
  const symbol = normalize(row.symbol);
  if (!symbol) return null;

  const category = getMarketRowCategory(row);
  const isContract = isSharedContractMarketRow(row);
  const marketCategory = normalize(row.market_category || (isContract && category === 'CRYPTO' ? 'CONTRACT' : category));
  const marketSubCategory = normalize(
    row.market_sub_category ||
      (category === 'STOCK' && !isContract ? 'STOCK_QUOTE' : isContract && category === 'CRYPTO' ? 'CONTRACT' : category),
  );
  const displaySymbol = String(row.display_symbol || row.display_name || '').trim();
  const rowPrecision = row as MarketTickerItem & {
    price_tick_size?: string | number | null;
    tick_size?: string | number | null;
    display_price_precision?: string | number | null;
    displayPricePrecision?: string | number | null;
    show_spot_logo?: boolean | number | string | null;
    spot_logo_url?: string | null;
    spot_logo_alt?: string | null;
    base_asset_logo_url?: string | null;
  };
  const hasBaseAssetLogoUrl = Object.prototype.hasOwnProperty.call(rowPrecision, 'base_asset_logo_url');
  const tickerFields = options.includeTicker
    ? {
        price: optionalTickerValue(row.last_price ?? row.price),
        change24h: optionalTickerValue(row.price_change_percent_24h ?? row.change_24h),
        percentChange24h: optionalTickerValue(row.percent_change_24h),
        priceChangePercent: optionalTickerValue(row.price_change_percent_24h),
        priceChange24h: optionalTickerValue(row.price_change_24h),
        volume24h: optionalTickerValue(row.quote_volume_24h ?? row.volume_24h),
        baseVolume24h: optionalTickerValue(row.base_volume_24h ?? row.volume_24h),
        quoteVolume24h: optionalTickerValue(row.quote_volume_24h),
        high24h: optionalTickerValue(row.high_24h),
        low24h: optionalTickerValue(row.low_24h),
      }
    : {};

  return {
    symbol,
    label: displaySymbol || formatSpotDisplaySymbol(symbol),
    displaySymbol: displaySymbol || undefined,
    externalSymbol: normalize(row.external_symbol),
    baseAsset: typeof row.base_asset === 'string' ? row.base_asset : null,
    quoteAsset: typeof row.quote_asset === 'string' ? row.quote_asset : null,
    ...(hasBaseAssetLogoUrl
      ? { baseAssetLogoUrl: String(rowPrecision.base_asset_logo_url || '').trim() || null }
      : {}),
    assetType: category,
    dataSource: typeof row.data_source === 'string' ? row.data_source : null,
    marketMode: typeof row.market_mode === 'string' ? row.market_mode : null,
    marketCategory,
    marketSubCategory,
    displayCategory: typeof row.display_category === 'string' ? row.display_category : null,
    displayGroup: typeof row.display_group === 'string' ? row.display_group : null,
    sourceSymbol: getMarketRowTickerSymbol(row) || symbol,
    displayPricePrecision: parseOptionalPrecision(
      rowPrecision.display_price_precision ?? rowPrecision.displayPricePrecision,
    ),
    pricePrecision: parseOptionalPrecision(row.price_precision),
    priceTickSize: rowPrecision.price_tick_size ?? rowPrecision.tick_size ?? null,
    amountPrecision: parseOptionalPrecision(row.amount_precision),
    showSpotLogo: parseBooleanFlag(rowPrecision.show_spot_logo),
    spotLogoUrl: String(rowPrecision.spot_logo_url || '').trim() || null,
    spotLogoAlt: String(rowPrecision.spot_logo_alt || '').trim() || null,
    ...tickerFields,
  };
}

function buildGlobalMarketSelectorPair(
  item: SpotMarketTickerItem | SpotMarketPairItem,
  labels: MarketDisplayLabels,
): GlobalMarketSelectorPair | null {
  const symbol = String(item.symbol || '').trim().toUpperCase();
  if (!symbol) return null;
  const rawAssetType = normalize(item.asset_type);
  const rawMarketCategory = normalize(item.market_category);
  const rawMarketSubCategory = normalize(item.market_sub_category);
  const category = [rawAssetType, rawMarketCategory, rawMarketSubCategory].includes('RWA')
    ? 'RWA'
    : normalize(item.asset_type || item.market_category || item.market_sub_category || 'CRYPTO');
  const marketCategory = normalize(item.market_category || category);
  const marketSubCategory = category === 'STOCK' ? 'STOCK_QUOTE' : normalize(item.market_sub_category || category);
  const externalSymbol = normalize((item as SpotMarketPairItem & { external_symbol?: string | null }).external_symbol);
  const { base } = inferBaseQuote({
    symbol,
    displaySymbol: item.display_symbol,
    baseAsset: item.base_asset,
    quoteAsset: item.quote_asset,
  });
  const stockCode = normalize(externalSymbol || base).replace(/USDT$/, '').replace(/ON$/, '');
  const isStockQuote = category === 'STOCK';
  const hasBaseAssetLogoUrl = Object.prototype.hasOwnProperty.call(item, 'base_asset_logo_url');

  return {
    symbol,
    label: isStockQuote
      ? appendMarketSuffix(stockCode || symbol, labels.stockSuffix)
      : String(item.display_symbol || '').trim() || formatSpotDisplaySymbol(symbol),
    displaySymbol: isStockQuote ? appendMarketSuffix(stockCode || symbol, labels.stockSuffix) : item.display_symbol,
    externalSymbol,
    baseAsset: item.base_asset,
    quoteAsset: item.quote_asset,
    ...(hasBaseAssetLogoUrl
      ? { baseAssetLogoUrl: String(item.base_asset_logo_url || '').trim() || null }
      : {}),
    assetType: category,
    dataSource: item.data_source,
    marketMode: item.market_mode,
    marketCategory,
    marketSubCategory,
    displayCategory: item.display_category,
    displayGroup: category === 'STOCK' ? labels.stockSuffix : labels.spotGroup,
    sourceSymbol: symbol,
    price: getTickerPrice(item),
    change24h: getTickerChangePercent(item),
    percentChange24h: (item as SpotMarketTickerItem & { percent_change_24h?: string | number | null }).percent_change_24h,
    priceChangePercent: (item as SpotMarketTickerItem & { priceChangePercent?: string | number | null }).priceChangePercent,
    priceChange24h: (item as SpotMarketTickerItem & { price_change_24h?: string | number | null }).price_change_24h,
    volume24h:
      (item as SpotMarketTickerItem & { quote_volume_24h?: string | number | null }).quote_volume_24h ??
      (item as SpotMarketTickerItem).volume_24h,
    baseVolume24h:
      (item as SpotMarketTickerItem & { base_volume_24h?: string | number | null }).base_volume_24h ??
      (item as SpotMarketTickerItem).volume_24h,
    quoteVolume24h: (item as SpotMarketTickerItem & { quote_volume_24h?: string | number | null }).quote_volume_24h,
    high24h: (item as SpotMarketTickerItem & { high_24h?: string | number | null }).high_24h,
    low24h: (item as SpotMarketTickerItem & { low_24h?: string | number | null }).low_24h,
    marketStatus: item.market_status,
    marketStatusText: item.market_status_text,
    marketSessionCode: item.market_session_code,
    marketTimezone: item.market_timezone,
    marketTradingHours: item.market_trading_hours,
    marketSessionType: item.market_session_type,
    quoteFreshness: item.quote_freshness,
    displayPricePrecision: parseOptionalPrecision(item.display_price_precision),
    pricePrecision: parseOptionalPrecision(item.price_precision),
    priceTickSize: item.price_tick_size ?? item.tick_size ?? null,
    amountPrecision: parseOptionalPrecision(item.amount_precision),
    showSpotLogo: parseBooleanFlag(item.show_spot_logo),
    spotLogoUrl: String(item.spot_logo_url || '').trim() || null,
    spotLogoAlt: String(item.spot_logo_alt || '').trim() || null,
  };
}

function contractSymbolToMarketSymbol(symbol: string): string {
  return String(symbol || '').trim().toUpperCase().replace(/_PERP$/, '');
}

function getContractDisplayLabel(symbol: string, labels: MarketDisplayLabels): string {
  return appendMarketSuffix(contractSymbolToMarketSymbol(symbol), labels.perpetualSuffix);
}

function buildContractToolbarPair(item: ContractSymbolItem, labels: MarketDisplayLabels): GlobalMarketSelectorPair {
  const symbol = String(item.symbol || '').trim().toUpperCase();
  const quoteAsset = String(item.quote_asset || '').trim().toUpperCase();
  const category = normalize(item.asset_type || item.underlying_type || item.category || 'CRYPTO');
  const marketSymbol = contractSymbolToMarketSymbol(symbol);
  const displayLabel = String(item.display_name || '').trim() || appendMarketSuffix(marketSymbol, labels.perpetualSuffix);
  const marketSubCategory = category === 'STOCK' ? 'STOCK_CONTRACT' : category === 'CRYPTO' ? 'CONTRACT' : category;

  return {
    symbol,
    label: getContractDisplayLabel(symbol, labels) || displayLabel,
    displaySymbol: getContractDisplayLabel(symbol, labels) || displayLabel,
    baseAsset: quoteAsset && marketSymbol.endsWith(quoteAsset)
      ? marketSymbol.slice(0, -quoteAsset.length)
      : marketSymbol,
    quoteAsset,
    assetType: category,
    dataSource: item.provider,
    marketMode: item.provider,
    marketCategory: category,
    marketSubCategory,
    displayGroup: category === 'STOCK' ? labels.stockContractGroup : labels.perpetualContractGroup,
    marketStatus: item.market_status,
    marketStatusText: item.market_status_text,
    marketSessionCode: item.market_session_code,
    marketTimezone: item.market_timezone,
    marketTradingHours: item.market_trading_hours,
    marketSessionType: item.market_session_type,
    pricePrecision: item.price_precision,
    amountPrecision: item.quantity_precision,
  };
}

function mergePairsWithTickerCache(
  pairs: GlobalMarketSelectorPair[],
  tickerCache: Map<string, GlobalMarketSelectorPair>,
): GlobalMarketSelectorPair[] {
  return pairs.map((pair) => {
    const ticker = tickerCache.get(getPairTickerSymbol(pair));
    return ticker ? mergePairMarketData(pair, ticker) : pair;
  });
}

function buildContractTickerPair(item: ContractTickerItem): GlobalMarketSelectorPair | null {
  const symbol = String(item.symbol || '').trim().toUpperCase();
  if (!symbol) return null;

  return {
    symbol,
    price: item.last_price ?? item.price ?? null,
    change24h: item.price_change_percent_24h ?? item.change_24h ?? item.priceChangePercent ?? null,
    priceChangePercent: item.price_change_percent_24h ?? item.priceChangePercent ?? null,
    priceChange24h: item.price_change_24h ?? null,
    volume24h: item.quote_volume_24h ?? item.base_volume_24h ?? null,
    baseVolume24h: item.base_volume_24h ?? null,
    quoteVolume24h: item.quote_volume_24h ?? null,
    high24h: item.high_24h ?? null,
    low24h: item.low_24h ?? null,
    marketStatus: item.market_status,
    marketStatusText: item.market_status_text,
    marketSessionCode: item.market_session_code,
    marketTimezone: item.market_timezone,
    marketTradingHours: item.market_trading_hours,
    marketSessionType: item.market_session_type,
    quoteFreshness: item.quote_freshness,
  };
}

function hasOwnSelectorPairField<K extends keyof GlobalMarketSelectorPair>(
  pair: GlobalMarketSelectorPair,
  field: K,
): boolean {
  return Object.prototype.hasOwnProperty.call(pair, field);
}

function mergePairMarketData(pair: GlobalMarketSelectorPair, ticker: GlobalMarketSelectorPair): GlobalMarketSelectorPair {
  const tickerHasLogo = hasOwnSelectorPairField(ticker, 'baseAssetLogoUrl');

  return {
    ...pair,
    baseAssetLogoUrl: tickerHasLogo ? ticker.baseAssetLogoUrl ?? null : pair.baseAssetLogoUrl ?? null,
    price: ticker.price ?? pair.price,
    change24h: ticker.change24h ?? pair.change24h,
    percentChange24h: ticker.percentChange24h ?? pair.percentChange24h,
    priceChangePercent: ticker.priceChangePercent ?? pair.priceChangePercent,
    priceChange24h: ticker.priceChange24h ?? pair.priceChange24h,
    volume24h: ticker.volume24h ?? pair.volume24h,
    baseVolume24h: ticker.baseVolume24h ?? pair.baseVolume24h,
    quoteVolume24h: ticker.quoteVolume24h ?? pair.quoteVolume24h,
    high24h: ticker.high24h ?? pair.high24h,
    low24h: ticker.low24h ?? pair.low24h,
    marketStatus: ticker.marketStatus ?? pair.marketStatus,
    marketStatusText: ticker.marketStatusText ?? pair.marketStatusText,
    marketSessionCode: ticker.marketSessionCode ?? pair.marketSessionCode,
    marketTimezone: ticker.marketTimezone ?? pair.marketTimezone,
    marketTradingHours: ticker.marketTradingHours ?? pair.marketTradingHours,
    marketSessionType: ticker.marketSessionType ?? pair.marketSessionType,
    quoteFreshness: ticker.quoteFreshness ?? pair.quoteFreshness,
  };
}

function mergePairsWithContractTickerCache(
  pairs: GlobalMarketSelectorPair[],
  tickerCache: Map<string, GlobalMarketSelectorPair>,
): GlobalMarketSelectorPair[] {
  return pairs.map((pair) => {
    const ticker = tickerCache.get(pair.symbol);
    if (ticker) return mergePairMarketData(pair, ticker);

    const quoteCache = readContractQuoteCache(pair.symbol);
    if (quoteCache.lastPrice) {
      return mergePairMarketData(pair, {
        symbol: pair.symbol,
        price: quoteCache.lastPrice,
      });
    }

    return pair;
  });
}

function cacheTickerItems(
  tickerCache: Map<string, GlobalMarketSelectorPair>,
  tickers: SpotMarketTickerItem[],
  labels: MarketDisplayLabels,
): boolean {
  let changed = false;

  tickers.forEach((ticker) => {
    const option = buildGlobalMarketSelectorPair(ticker, labels);
    if (option) {
      tickerCache.set(option.symbol, option);
      changed = true;
    }
  });

  return changed;
}

function cacheContractTickerItems(
  tickerCache: Map<string, GlobalMarketSelectorPair>,
  tickers: ContractTickerItem[],
  fetchedAt?: Map<string, number>,
): boolean {
  let changed = false;
  const now = Date.now();

  tickers.forEach((ticker) => {
    const option = buildContractTickerPair(ticker);
    if (option) {
      tickerCache.set(option.symbol, option);
      fetchedAt?.set(option.symbol, now);
      changed = true;
    }
  });

  return changed;
}

function seedSelectorCachesFromSharedRows(params: {
  rows: MarketTickerItem[];
  includeTicker: boolean;
  spotPairsCache: Map<string, GlobalMarketSelectorPair[]>;
  contractPairsCache: Map<string, GlobalMarketSelectorPair[]>;
  spotPairsCacheFetchedAt: Map<string, number>;
  contractPairsCacheFetchedAt: Map<string, number>;
  tickerCache: Map<string, GlobalMarketSelectorPair>;
  contractTickerCache: Map<string, GlobalMarketSelectorPair>;
  contractTickerFetchedAt: Map<string, number>;
}): { spotPairs: GlobalMarketSelectorPair[]; contractPairs: GlobalMarketSelectorPair[]; tickerChanged: boolean } {
  const pairs = params.rows
    .map((row) => buildSharedMarketSelectorPair(row, { includeTicker: params.includeTicker }))
    .filter((item): item is GlobalMarketSelectorPair => Boolean(item));
  const spotPairs = pairs.filter(isSpotMarketPair);
  const contractPairs = pairs.filter(isContractMarketPair);
  const now = Date.now();
  let tickerChanged = false;

  if (spotPairs.length) {
    writePairCache(
      params.spotPairsCache,
      params.spotPairsCacheFetchedAt,
      DEFAULT_SPOT_PAIRS_CACHE_KEY,
      mergeUniquePairs(params.spotPairsCache.get(DEFAULT_SPOT_PAIRS_CACHE_KEY) || [], spotPairs),
    );
  }

  if (contractPairs.length) {
    writePairCache(
      params.contractPairsCache,
      params.contractPairsCacheFetchedAt,
      DEFAULT_CONTRACT_PAIRS_CACHE_KEY,
      mergeUniquePairs(params.contractPairsCache.get(DEFAULT_CONTRACT_PAIRS_CACHE_KEY) || [], contractPairs),
    );
  }

  if (params.includeTicker) {
    spotPairs.forEach((pair) => {
      if (!hasValidTickerNumber(pair.price, { positiveOnly: true }) && !hasValidTickerNumber(getPairChangeValue(pair))) {
        return;
      }
      params.tickerCache.set(getPairTickerSymbol(pair), pair);
      tickerChanged = true;
    });
    contractPairs.forEach((pair) => {
      if (!hasValidTickerNumber(pair.price, { positiveOnly: true }) && !hasValidTickerNumber(getPairChangeValue(pair))) {
        return;
      }
      params.contractTickerCache.set(pair.symbol, pair);
      params.contractTickerFetchedAt.set(pair.symbol, now);
      tickerChanged = true;
    });
  }

  return { spotPairs, contractPairs, tickerChanged };
}

async function fetchAllGlobalMarketSelectorPairs(params: {
  marketType: PairQueryUpdate['marketType'];
  category: string;
  quote: string;
  keyword?: string;
  labels: MarketDisplayLabels;
}): Promise<GlobalMarketSelectorPair[]> {
  const collected: GlobalMarketSelectorPair[] = [];
  let total = 0;

  for (let page = 1; page <= 10; page += 1) {
    const response = await getSpotMarketPairs({
      marketType: params.marketType,
      category: params.category,
      quote: params.quote,
      keyword: params.keyword,
      page,
      pageSize: PAIRS_PAGE_SIZE,
    });
    const nextPairs = (response.items || [])
      .map((item) => buildGlobalMarketSelectorPair(item, params.labels))
      .filter((item): item is GlobalMarketSelectorPair => {
        if (!item) return false;
        return !isStockQuotePair(item);
      });

    collected.push(...nextPairs);
    total = Number(response.total || collected.length);
    if (collected.length >= total || nextPairs.length < PAIRS_PAGE_SIZE) break;
  }

  return mergeUniquePairs(collected);
}

async function fetchAllContractToolbarPairs(params: {
  category: string;
  quote: string;
  keyword?: string;
  labels: MarketDisplayLabels;
}): Promise<GlobalMarketSelectorPair[]> {
  const collected: GlobalMarketSelectorPair[] = [];
  let total = 0;

  for (let page = 1; page <= 10; page += 1) {
    const response = await getContractSymbols({
      category: params.category,
      quote: params.quote,
      keyword: params.keyword,
      page,
      page_size: PAIRS_PAGE_SIZE,
    });
    const nextPairs = (response.items || []).map((item) => buildContractToolbarPair(item, params.labels));

    collected.push(...nextPairs);
    total = Number(response.total || collected.length);
    if (collected.length >= total || nextPairs.length < PAIRS_PAGE_SIZE) break;
  }

  return mergeUniquePairs(collected);
}

function getContractPairCategoryForSelectorView(
  marketTab: MarketLayerTab,
  spotCategory: PairCategory,
  contractCategory: ContractCategory,
): string {
  if (marketTab === 'stock') return 'stock';
  if (marketTab === 'cfd') return contractCategory === 'all' ? 'all' : contractCategory;
  if (marketTab === 'crypto' && (spotCategory === 'all' || spotCategory === 'contract')) return 'crypto';
  return 'all';
}

export default function GlobalMarketSelector({
  symbol,
  interval,
  chartMode = 'candle',
  onSymbolChange,
  onIntervalChange,
  onChartModeChange,
  symbols,
  symbolLabels,
  pairs,
  pairsLoading = false,
  pairsLoadingMore = false,
  hasMorePairs = false,
  pageType = 'spot',
  placement = 'toolbar',
  initialCategory,
  onPairQueryChange,
  onLoadMorePairs,
}: GlobalMarketSelectorProps) {
  const router = useRouter();
  const { t } = useLocaleContext();
  const marketDisplayLabels = useMemo<MarketDisplayLabels>(() => ({
    stockSuffix: t('stockSuffix', 'markets'),
    spotGroup: t('spot', 'markets'),
    perpetualSuffix: t('perpetualSuffix', 'markets'),
    stockContractGroup: t('stockContracts', 'markets'),
    perpetualContractGroup: t('perpetualContracts', 'markets'),
    contractGroup: t('contract', 'markets'),
  }), [t]);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [marketTab, setMarketTab] = useState<MarketLayerTab>('crypto');
  const [spotCategory, setSpotCategory] = useState<PairCategory>(
    initialCategory || (pageType === 'spot' ? 'spot' : pageType === 'contract' ? 'contract' : 'all'),
  );
  const [stockCategory, setStockCategory] = useState<StockCategory>('all');
  const [contractCategory, setContractCategory] = useState<ContractCategory>('all');
  const menuRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLDivElement | null>(null);
  const [menuPosition, setMenuPosition] = useState({ left: 0, top: 0 });
  const [internalSpotPairs, setInternalSpotPairs] = useState<GlobalMarketSelectorPair[]>([]);
  const [internalContractPairs, setInternalContractPairs] = useState<GlobalMarketSelectorPair[]>([]);
  const [internalSpotPairsKey, setInternalSpotPairsKey] = useState('');
  const [internalContractPairsKey, setInternalContractPairsKey] = useState('');
  const [spotPairsLoading, setSpotPairsLoading] = useState(false);
  const [contractPairsLoading, setContractPairsLoading] = useState(false);
  const [tickerCacheVersion, setTickerCacheVersion] = useState(0);
  const [contractTickerCacheVersion, setContractTickerCacheVersion] = useState(0);
  const [contractTickerHydratingVersion, setContractTickerHydratingVersion] = useState(0);
  const [visibleTickerLimit, setVisibleTickerLimit] = useState(SPOT_TICKER_BATCH_SIZE);
  const [favoriteSymbols, setFavoriteSymbols] = useState<FavoriteSymbolItem[]>([]);
  const [failedLogoUrls, setFailedLogoUrls] = useState<string[]>([]);
  const [stablePairRows, setStablePairRows] = useState<GlobalMarketSelectorPair[]>([]);
  const spotPairsCacheRef = useRef<Map<string, GlobalMarketSelectorPair[]>>(spotPairsCacheStore);
  const contractPairsCacheRef = useRef<Map<string, GlobalMarketSelectorPair[]>>(contractPairsCacheStore);
  const spotPairsCacheFetchedAtRef = useRef<Map<string, number>>(spotPairsCacheFetchedAtStore);
  const contractPairsCacheFetchedAtRef = useRef<Map<string, number>>(contractPairsCacheFetchedAtStore);
  const tickerCacheRef = useRef<Map<string, GlobalMarketSelectorPair>>(tickerCacheStore);
  const tickerHydratingRef = useRef<Set<string>>(tickerHydratingStore);
  const contractTickerCacheRef = useRef<Map<string, GlobalMarketSelectorPair>>(contractTickerCacheStore);
  const contractTickerHydratingRef = useRef<Set<string>>(contractTickerHydratingStore);
  const contractTickerFetchedAtRef = useRef<Map<string, number>>(contractTickerFetchedAtStore);
  const contractTickerBatchHydratingRef = useRef<Set<string>>(contractTickerBatchHydratingStore);
  const visibleTickerDebounceRef = useRef<number | null>(null);
  const preloadStartedRef = useRef(false);
  const loadedSpotPairKeysRef = useRef<Set<string>>(new Set());
  const loadedContractPairKeysRef = useRef<Set<string>>(new Set());
  const sharedRowsCacheSeededRef = useRef(false);
  const wasOpenRef = useRef(false);
  const spotRequestIdRef = useRef(0);
  const contractRequestIdRef = useRef(0);

  const spotPairCategory = 'all';
  const spotPairQuote = 'all';
  const pairKeyword = search.trim();
  const spotPairsCacheKey = `spot:${MARKET_SELECTOR_CACHE_VERSION}:${spotPairCategory}:${spotPairQuote}:${pairKeyword}`;
  const contractPairQuote = 'all';
  const contractPairCategory = getContractPairCategoryForSelectorView(marketTab, spotCategory, contractCategory);
  const contractPairsCacheKey = `contract:${MARKET_SELECTOR_CACHE_VERSION}:${contractPairCategory}:${contractPairQuote}:${pairKeyword}`;
  const externalPairItems = useMemo<GlobalMarketSelectorPair[]>(() => {
    if (pairs?.length) return pairs;
    return symbols.map((item) => ({
      symbol: item,
      label: symbolLabels?.[item] || formatSpotDisplaySymbol(item),
    }));
  }, [pairs, symbolLabels, symbols]);

  const pairItems = useMemo<GlobalMarketSelectorPair[]>(() => {
    void tickerCacheVersion;
    void contractTickerCacheVersion;

    if (marketTab === 'favorites') return [];

    const externalSpotPairs = externalPairItems.filter(isSpotMarketPair);
    const cachedSpotPairs =
      readFreshPairCache(spotPairsCacheRef.current, spotPairsCacheFetchedAtRef.current, spotPairsCacheKey) ||
      (!pairKeyword
        ? readFreshPairCache(spotPairsCacheRef.current, spotPairsCacheFetchedAtRef.current, DEFAULT_SPOT_PAIRS_CACHE_KEY)
        : undefined);
    const internalSpotSource = internalSpotPairs.length && internalSpotPairsKey === spotPairsCacheKey
      ? internalSpotPairs
      : [];
    const spotSource = mergeUniquePairs(
      externalSpotPairs,
      internalSpotSource,
      cachedSpotPairs || [],
    );

    const cachedContractPairs =
      readFreshPairCache(contractPairsCacheRef.current, contractPairsCacheFetchedAtRef.current, contractPairsCacheKey) ||
      (!pairKeyword
        ? readFreshPairCache(contractPairsCacheRef.current, contractPairsCacheFetchedAtRef.current, DEFAULT_CONTRACT_PAIRS_CACHE_KEY)
        : undefined);
    const contractSource = cachedContractPairs?.length
      ? cachedContractPairs
      : internalContractPairs.length && internalContractPairsKey === contractPairsCacheKey
      ? internalContractPairs
      : externalPairItems.filter(isContractMarketPair);

    return mergeUniquePairs(
      mergePairsWithTickerCache(spotSource, tickerCacheRef.current),
      mergePairsWithContractTickerCache(contractSource, contractTickerCacheRef.current),
    ).filter((item) => !isStockQuotePair(item));
  }, [
    contractPairsCacheKey,
    contractTickerCacheVersion,
    externalPairItems,
    internalContractPairs,
    internalContractPairsKey,
    internalSpotPairs,
    internalSpotPairsKey,
    marketTab,
    pairKeyword,
    spotPairsCacheKey,
    tickerCacheVersion,
  ]);

  void contractTickerHydratingVersion;

  const allKnownPairs = useMemo(
    () => [...externalPairItems, ...internalSpotPairs, ...internalContractPairs],
    [externalPairItems, internalContractPairs, internalSpotPairs],
  );

  const currentPair = useMemo(
    () => allKnownPairs.find((item) => normalize(item.symbol) === normalize(symbol)),
    [allKnownPairs, symbol],
  );

  const currentLabel = useMemo(() => {
    if (currentPair && getPairMarket(currentPair) === 'contract') {
      return getContractDisplayLabel(currentPair.symbol, marketDisplayLabels);
    }
    return currentPair?.displaySymbol || currentPair?.label || symbolLabels?.[symbol] || formatSpotDisplaySymbol(symbol);
  }, [currentPair, marketDisplayLabels, symbol, symbolLabels]);

  const currentHeaderPair = useMemo<GlobalMarketSelectorPair>(
    () => currentPair || {
      symbol,
      label: currentLabel,
      displaySymbol: currentLabel,
    },
    [currentLabel, currentPair, symbol],
  );

  const currentBaseAsset = useMemo(() => inferBaseQuote(currentHeaderPair).base || normalize(symbol), [currentHeaderPair, symbol]);
  const currentLogoUrl = getPairLogoUrl(currentHeaderPair);
  const failedLogoUrlSet = useMemo(() => new Set(failedLogoUrls), [failedLogoUrls]);
  const activeLogoUrl = currentLogoUrl && !failedLogoUrlSet.has(currentLogoUrl) ? currentLogoUrl : '';
  const coinLogoText = getCoinLogoText(currentBaseAsset);
  const coinLogoClass = getCoinLogoClass();

  const intervalOptions = useMemo(
    () => (currentPair && (isStockContractPair(currentPair) || isTradfiCfdPair(currentPair)) ? TRADFI_INTERVALS : intervals),
    [currentPair],
  );
  const showIntervalControls = pageType !== 'spot';
  const showTimeSharing = pageType === 'spot' && Boolean(onChartModeChange);
  const isHeaderPlacement = placement === 'header';
  const needsSpotRows =
    marketTab === 'crypto' &&
    spotCategory !== 'contract';
  const needsContractRows =
    marketTab === 'stock' ||
    marketTab === 'cfd' ||
    (marketTab === 'crypto' && (spotCategory === 'all' || spotCategory === 'contract'));
  const shouldHydrateContractTickerRows =
    marketTab === 'favorites' ||
    marketTab === 'stock' ||
    marketTab === 'cfd' ||
    (marketTab === 'crypto' && (spotCategory === 'all' || spotCategory === 'contract'));
  const activePairsRefreshing =
    (needsSpotRows && spotPairsLoading) ||
    (needsContractRows && contractPairsLoading);

  useEffect(() => {
    if (intervalOptions.includes(interval)) return;
    onIntervalChange(intervalOptions.includes('1h') ? '1h' : intervalOptions[0]);
  }, [interval, intervalOptions, onIntervalChange]);

  useEffect(() => {
    if (!open) {
      wasOpenRef.current = false;
      return;
    }
    if (wasOpenRef.current) return;
    wasOpenRef.current = true;

    const current = allKnownPairs.find((item) => normalize(item.symbol) === normalize(symbol));
    if (!current) {
      setMarketTab('crypto');
      if (pageType === 'contract') {
        setSpotCategory('contract');
      }
      return;
    }
    if (isStockContractPair(current)) {
      setMarketTab('stock');
      return;
    }
    if (isRwaPair(current)) {
      setMarketTab('crypto');
      setSpotCategory('rwa');
      return;
    }
    if (isTradfiCfdPair(current)) {
      setMarketTab('cfd');
      return;
    }
    if (isPlatformPair(current)) {
      setMarketTab('crypto');
      setSpotCategory('platform');
      return;
    }
    if (isCryptoContractPair(current)) {
      setMarketTab('crypto');
      setSpotCategory('contract');
      return;
    }
    if (isCryptoSpotPair(current)) {
      setMarketTab('crypto');
      setSpotCategory('spot');
      return;
    }
    setMarketTab('crypto');
    if (pageType === 'contract') {
      setSpotCategory('contract');
    }
  }, [allKnownPairs, open, pageType, symbol]);

  const hydrateTickerSymbols = useCallback((symbolsToHydrate: string[]) => {
    const visibleSymbols = symbolsToHydrate
      .map(normalize)
      .filter((item) => item && !tickerCacheRef.current.has(item) && !tickerHydratingRef.current.has(item));

    if (visibleSymbols.length === 0) return;

    visibleSymbols.forEach((item) => tickerHydratingRef.current.add(item));

    const loadTickers = async () => {
      try {
        const tickers = await getSpotMarketTickers(visibleSymbols);
        if (cacheTickerItems(tickerCacheRef.current, tickers, marketDisplayLabels)) {
          setTickerCacheVersion((value) => value + 1);
        }
      } catch (error) {
        console.error('GlobalMarketSelector ticker preload error:', error);
      } finally {
        visibleSymbols.forEach((item) => tickerHydratingRef.current.delete(item));
      }
    };

    void loadTickers();
  }, [marketDisplayLabels]);

  const hydrateContractTickerSymbols = useCallback((
    symbolsToHydrate: string[],
    batchSize = CONTRACT_TICKER_BATCH_SIZE,
    options: { ttlMs?: number } = {},
  ) => {
    const safeBatchSize = Math.max(1, Math.min(batchSize, CONTRACT_TICKER_BATCH_SIZE));
    const now = Date.now();
    const ttlMs = options.ttlMs ?? CONTRACT_TICKER_REFRESH_TTL_MS;
    const selectedSymbols = Array.from(new Set(symbolsToHydrate.map(normalize)))
      .filter((item) => {
        if (!item || contractTickerHydratingRef.current.has(item)) return false;
        const fetchedAt = contractTickerFetchedAtRef.current.get(item) || 0;
        if (contractTickerCacheRef.current.has(item) && fetchedAt === 0) {
          contractTickerFetchedAtRef.current.set(item, now);
          return false;
        }
        return now - fetchedAt >= ttlMs;
      });

    if (selectedSymbols.length === 0) return;

    selectedSymbols.forEach((item) => contractTickerHydratingRef.current.add(item));
    setContractTickerHydratingVersion((value) => value + 1);

    const loadTickers = async () => {
      let changed = false;
      try {
        for (let index = 0; index < selectedSymbols.length; index += safeBatchSize) {
          const batch = selectedSymbols.slice(index, index + safeBatchSize);
          const batchKey = batch.join(',');
          if (contractTickerBatchHydratingRef.current.has(batchKey)) {
            continue;
          }
          contractTickerBatchHydratingRef.current.add(batchKey);
          try {
            const response = await getContractTickers({ symbols: batch, limit: batch.length });
            changed = cacheContractTickerItems(
              contractTickerCacheRef.current,
              response.items,
              contractTickerFetchedAtRef.current,
            ) || changed;
          } catch (error) {
            console.warn('GlobalMarketSelector contract ticker batch warning:', error);
          } finally {
            const fetchedAt = Date.now();
            batch.forEach((item) => contractTickerFetchedAtRef.current.set(item, fetchedAt));
            contractTickerBatchHydratingRef.current.delete(batchKey);
          }
        }

        if (changed) {
          setContractTickerCacheVersion((value) => value + 1);
        }
      } catch (error) {
        console.error('GlobalMarketSelector contract ticker load error:', error);
      } finally {
        selectedSymbols.forEach((item) => contractTickerHydratingRef.current.delete(item));
        setContractTickerHydratingVersion((value) => value + 1);
      }
    };

    void loadTickers();
  }, []);

  const favoriteKeySet = useMemo(
    () => new Set(favoriteSymbols.map((item) => getFavoriteKey(item.symbol, item.market))),
    [favoriteSymbols],
  );
  const currentFavoriteTarget = useMemo(() => getFavoriteTarget(currentHeaderPair), [currentHeaderPair]);
  const currentFavoriteActive = favoriteKeySet.has(currentFavoriteTarget.key);

  const favoritePairs = useMemo<GlobalMarketSelectorPair[]>(() => {
    void tickerCacheVersion;
    void contractTickerCacheVersion;

    const cachedPairs = [
      ...Array.from(spotPairsCacheRef.current.values()).flat(),
      ...Array.from(contractPairsCacheRef.current.values()).flat(),
    ];
    const knownPairs = [...internalSpotPairs, ...internalContractPairs, ...externalPairItems, ...cachedPairs];

    return favoriteSymbols.map((favorite) => {
      const knownPair = knownPairs.find(
        (item) => normalize(item.symbol) === favorite.symbol && getPairMarket(item) === favorite.market,
      );
      if (knownPair && isStockQuotePair(knownPair)) {
        return null;
      }
      const cachedTicker =
        favorite.market === 'spot' || (knownPair && isMockStockContractPair(knownPair))
          ? tickerCacheRef.current.get(knownPair ? getPairTickerSymbol(knownPair) : favorite.symbol)
          : contractTickerCacheRef.current.get(favorite.symbol);

      if (knownPair) {
        return cachedTicker ? { ...knownPair, ...cachedTicker } : knownPair;
      }

      if (favorite.market === 'contract') {
        const marketSymbol = contractSymbolToMarketSymbol(favorite.symbol);
        return {
          symbol: favorite.symbol,
          label: appendMarketSuffix(marketSymbol, marketDisplayLabels.perpetualSuffix),
          displaySymbol: appendMarketSuffix(marketSymbol, marketDisplayLabels.perpetualSuffix),
          baseAsset: marketSymbol.replace(/USDT$/, ''),
          quoteAsset: 'USDT',
          assetType: 'CONTRACT',
          marketCategory: 'CONTRACT',
          marketSubCategory: 'PERPETUAL',
          displayGroup: marketDisplayLabels.contractGroup,
        };
      }

      return {
        symbol: favorite.symbol,
        label: formatSpotDisplaySymbol(favorite.symbol),
        displaySymbol: formatSpotDisplaySymbol(favorite.symbol),
      };
    }).filter((item): item is GlobalMarketSelectorPair => Boolean(item));
  }, [
    externalPairItems,
    favoriteSymbols,
    internalContractPairs,
    internalSpotPairs,
    marketDisplayLabels,
    contractTickerCacheVersion,
    tickerCacheVersion,
  ]);

  useEffect(() => {
    setFavoriteSymbols(readFavoriteSymbols());
  }, []);

  useEffect(() => {
    if (sharedRowsCacheSeededRef.current) return;

    const cached = readSharedMarketsRowsCache();
    if (!cached?.rows.length) return;

    const seeded = seedSelectorCachesFromSharedRows({
      rows: cached.rows,
      includeTicker: !cached.stale,
      spotPairsCache: spotPairsCacheRef.current,
      contractPairsCache: contractPairsCacheRef.current,
      spotPairsCacheFetchedAt: spotPairsCacheFetchedAtRef.current,
      contractPairsCacheFetchedAt: contractPairsCacheFetchedAtRef.current,
      tickerCache: tickerCacheRef.current,
      contractTickerCache: contractTickerCacheRef.current,
      contractTickerFetchedAt: contractTickerFetchedAtRef.current,
    });
    if (seeded.spotPairs.length === 0 && seeded.contractPairs.length === 0) return;

    sharedRowsCacheSeededRef.current = true;
    const cachedSpotPairs = readFreshPairCache(
      spotPairsCacheRef.current,
      spotPairsCacheFetchedAtRef.current,
      DEFAULT_SPOT_PAIRS_CACHE_KEY,
    );
    const cachedContractPairs = readFreshPairCache(
      contractPairsCacheRef.current,
      contractPairsCacheFetchedAtRef.current,
      DEFAULT_CONTRACT_PAIRS_CACHE_KEY,
    );
    if (cachedSpotPairs?.length && spotPairsCacheKey === DEFAULT_SPOT_PAIRS_CACHE_KEY) {
      setInternalSpotPairs(cachedSpotPairs);
      setInternalSpotPairsKey(DEFAULT_SPOT_PAIRS_CACHE_KEY);
      loadedSpotPairKeysRef.current.add(DEFAULT_SPOT_PAIRS_CACHE_KEY);
    }
    if (cachedContractPairs?.length && contractPairsCacheKey === DEFAULT_CONTRACT_PAIRS_CACHE_KEY) {
      setInternalContractPairs(cachedContractPairs);
      setInternalContractPairsKey(DEFAULT_CONTRACT_PAIRS_CACHE_KEY);
      loadedContractPairKeysRef.current.add(DEFAULT_CONTRACT_PAIRS_CACHE_KEY);
    }
    if (seeded.tickerChanged) {
      setTickerCacheVersion((value) => value + 1);
      setContractTickerCacheVersion((value) => value + 1);
    }
  }, [contractPairsCacheKey, spotPairsCacheKey]);

  useEffect(() => {
    if (preloadStartedRef.current) return;
    preloadStartedRef.current = true;

    let cancelled = false;

    const preloadPairs = async () => {
      try {
        const hasDefaultSpotPairs = !!readFreshPairCache(
          spotPairsCacheRef.current,
          spotPairsCacheFetchedAtRef.current,
          DEFAULT_SPOT_PAIRS_CACHE_KEY,
        )?.length;
        const hasDefaultContractPairs = !!readFreshPairCache(
          contractPairsCacheRef.current,
          contractPairsCacheFetchedAtRef.current,
          DEFAULT_CONTRACT_PAIRS_CACHE_KEY,
        )?.length;
        const shouldPreloadSpotPairs = pageType === 'spot';
        const shouldPreloadContractPairs = pageType === 'contract';
        if (!shouldPreloadSpotPairs && !shouldPreloadContractPairs) return;
        if (
          (!shouldPreloadSpotPairs || hasDefaultSpotPairs) &&
          (!shouldPreloadContractPairs || hasDefaultContractPairs)
        ) return;

        const [spotResult, contractResult] = await Promise.allSettled([
          !shouldPreloadSpotPairs || hasDefaultSpotPairs
            ? Promise.resolve<GlobalMarketSelectorPair[]>([])
            : fetchAllGlobalMarketSelectorPairs({
                marketType: 'spot',
                category: 'all',
                quote: 'all',
                labels: marketDisplayLabels,
              }),
          !shouldPreloadContractPairs || hasDefaultContractPairs
            ? Promise.resolve<GlobalMarketSelectorPair[]>([])
            : fetchAllContractToolbarPairs({
                category: 'all',
                quote: 'all',
                labels: marketDisplayLabels,
              }),
        ]);
        if (cancelled) return;

        if (spotResult.status === 'fulfilled' && spotResult.value.length) {
          const nextSpotPairs = spotResult.value;
          writePairCache(
            spotPairsCacheRef.current,
            spotPairsCacheFetchedAtRef.current,
            DEFAULT_SPOT_PAIRS_CACHE_KEY,
            nextSpotPairs,
          );
          loadedSpotPairKeysRef.current.add(DEFAULT_SPOT_PAIRS_CACHE_KEY);
          if (spotPairsCacheKey === DEFAULT_SPOT_PAIRS_CACHE_KEY) {
            setInternalSpotPairs(nextSpotPairs);
            setInternalSpotPairsKey(DEFAULT_SPOT_PAIRS_CACHE_KEY);
          }
          hydrateTickerSymbols(
            nextSpotPairs
              .slice(0, SPOT_TICKER_PRELOAD_SIZE)
              .map(getPairTickerSymbol),
          );
        }

        if (contractResult.status === 'fulfilled' && contractResult.value.length) {
          const nextContractPairs = mergeUniquePairs(
            contractResult.value,
            externalPairItems.filter(isContractMarketPair),
          );
          writePairCache(
            contractPairsCacheRef.current,
            contractPairsCacheFetchedAtRef.current,
            DEFAULT_CONTRACT_PAIRS_CACHE_KEY,
            nextContractPairs,
          );
          loadedContractPairKeysRef.current.add(DEFAULT_CONTRACT_PAIRS_CACHE_KEY);
          if (contractPairsCacheKey === DEFAULT_CONTRACT_PAIRS_CACHE_KEY) {
            setInternalContractPairs(nextContractPairs);
            setInternalContractPairsKey(DEFAULT_CONTRACT_PAIRS_CACHE_KEY);
          }
        }
      } catch (error) {
        console.warn('GlobalMarketSelector preload pairs warning:', error);
      }
    };

    void preloadPairs();

    return () => {
      cancelled = true;
    };
  }, [contractPairsCacheKey, externalPairItems, hydrateTickerSymbols, marketDisplayLabels, pageType, spotPairsCacheKey]);

  useEffect(() => {
    if (!open) return;
    if (marketTab === 'favorites') return;
    if (marketTab !== 'crypto' || spotCategory === 'contract') return;

    onPairQueryChange?.({
      marketType: 'spot',
      category: ['spot', 'platform', 'rwa'].includes(spotCategory) ? spotCategory : 'all',
      quote: 'all',
      keyword: pairKeyword,
    });
  }, [marketTab, onPairQueryChange, open, pairKeyword, spotCategory]);

  useEffect(() => {
    if (!open || marketTab !== 'crypto' || spotCategory === 'contract') return;

    const requestId = ++spotRequestIdRef.current;
    const cachedPairs = readFreshPairCache(
      spotPairsCacheRef.current,
      spotPairsCacheFetchedAtRef.current,
      spotPairsCacheKey,
    );
    if (cachedPairs) {
      setInternalSpotPairs(cachedPairs);
      setInternalSpotPairsKey(spotPairsCacheKey);
      loadedSpotPairKeysRef.current.add(spotPairsCacheKey);
    } else {
      loadedSpotPairKeysRef.current.delete(spotPairsCacheKey);
    }
    if (loadedSpotPairKeysRef.current.has(spotPairsCacheKey) || cachedPairs) {
      setSpotPairsLoading(false);
      return;
    }
    setSpotPairsLoading(!cachedPairs);

    const loadSpotPairs = async () => {
      try {
        const nextPairs = await fetchAllGlobalMarketSelectorPairs({
          marketType: 'spot',
          category: 'all',
          quote: spotPairQuote,
          keyword: pairKeyword,
          labels: marketDisplayLabels,
        });

        if (requestId !== spotRequestIdRef.current) return;
        writePairCache(
          spotPairsCacheRef.current,
          spotPairsCacheFetchedAtRef.current,
          spotPairsCacheKey,
          nextPairs,
        );
        loadedSpotPairKeysRef.current.add(spotPairsCacheKey);
        setInternalSpotPairs(nextPairs);
        setInternalSpotPairsKey(spotPairsCacheKey);
        hydrateTickerSymbols(
          nextPairs
            .slice(0, SPOT_TICKER_PRELOAD_SIZE)
            .map((item) => item.symbol),
        );
      } catch (error) {
        if (requestId === spotRequestIdRef.current) {
          console.warn('GlobalMarketSelector spot pairs load warning:', error);
        }
      } finally {
        if (requestId === spotRequestIdRef.current) {
          setSpotPairsLoading(false);
        }
      }
    };

    void loadSpotPairs();
  }, [hydrateTickerSymbols, marketDisplayLabels, marketTab, open, pairKeyword, spotCategory, spotPairCategory, spotPairQuote, spotPairsCacheKey]);

  useEffect(() => {
    if (!open || !needsContractRows) return;

    const requestId = ++contractRequestIdRef.current;
    const cachedPairs =
      readFreshPairCache(contractPairsCacheRef.current, contractPairsCacheFetchedAtRef.current, contractPairsCacheKey) ||
      (!pairKeyword
        ? readFreshPairCache(
            contractPairsCacheRef.current,
            contractPairsCacheFetchedAtRef.current,
            DEFAULT_CONTRACT_PAIRS_CACHE_KEY,
          )
        : undefined);
    if (cachedPairs) {
      setInternalContractPairs(cachedPairs);
      setInternalContractPairsKey(contractPairsCacheKey);
      loadedContractPairKeysRef.current.add(contractPairsCacheKey);
    } else {
      loadedContractPairKeysRef.current.delete(contractPairsCacheKey);
    }
    if (loadedContractPairKeysRef.current.has(contractPairsCacheKey) || cachedPairs) {
      setContractPairsLoading(false);
      return;
    }
    setContractPairsLoading(!cachedPairs);

    const loadContractPairs = async () => {
      try {
        const contractResponsePromise = fetchAllContractToolbarPairs({
          category: contractPairCategory,
          quote: contractPairQuote,
          keyword: pairKeyword,
          labels: marketDisplayLabels,
        });
        const contractResponse = await contractResponsePromise;

        if (requestId !== contractRequestIdRef.current) return;
        const nextPairs = mergeUniquePairs(
          contractResponse,
          externalPairItems.filter(isContractMarketPair),
        );
        writePairCache(
          contractPairsCacheRef.current,
          contractPairsCacheFetchedAtRef.current,
          contractPairsCacheKey,
          nextPairs,
        );
        loadedContractPairKeysRef.current.add(contractPairsCacheKey);
        setInternalContractPairs(nextPairs);
        setInternalContractPairsKey(contractPairsCacheKey);
      } catch (error) {
        if (requestId === contractRequestIdRef.current) {
          console.warn('GlobalMarketSelector contract symbols load warning:', error);
        }
      } finally {
        if (requestId === contractRequestIdRef.current) {
          setContractPairsLoading(false);
        }
      }
    };

    void loadContractPairs();
  }, [contractPairCategory, contractPairQuote, contractPairsCacheKey, externalPairItems, marketDisplayLabels, needsContractRows, open, pairKeyword]);

  const pairMatchesSearch = useCallback((pair: GlobalMarketSelectorPair, query: string) => {
    return pairMatchesSpotSelectorSearch(pair, query);
  }, []);

  const filteredPairs = useMemo(() => {
    const query = normalize(search);

    if (marketTab === 'favorites') {
      return favoritePairs.filter((pair) => pairMatchesSearch(pair, query));
    }

    if (marketTab === 'stock') {
      return pairItems.filter((pair) => pairMatchesStockCategory(pair, stockCategory) && pairMatchesSearch(pair, query));
    }

    if (marketTab === 'cfd') {
      return pairItems.filter((pair) => pairMatchesContractCategory(pair, contractCategory) && pairMatchesSearch(pair, query));
    }

    return pairItems.filter((pair) => pairMatchesCryptoCategory(pair, spotCategory) && pairMatchesSearch(pair, query));
  }, [contractCategory, favoritePairs, marketTab, pairItems, pairMatchesSearch, search, spotCategory, stockCategory]);

  const showInitialPairsLoading =
    filteredPairs.length === 0 &&
    pairItems.length === 0 &&
    stablePairRows.length === 0 &&
    (activePairsRefreshing || pairsLoading);

  const isSwitchingWithoutRows =
    !pairKeyword &&
    filteredPairs.length === 0 &&
    stablePairRows.length > 0 &&
    (activePairsRefreshing ||
      (needsSpotRows &&
        internalSpotPairsKey !== spotPairsCacheKey &&
        !spotPairsCacheRef.current.has(spotPairsCacheKey)) ||
      (needsContractRows &&
        internalContractPairsKey !== contractPairsCacheKey &&
        !contractPairsCacheRef.current.has(contractPairsCacheKey)));

  const displayPairs = isSwitchingWithoutRows ? stablePairRows : filteredPairs;
  const showEmptyPairs = !showInitialPairsLoading && displayPairs.length === 0 && !isSwitchingWithoutRows;
  const emptyPairText = pairKeyword
    ? t('noMatchingPairs', 'markets')
    : marketTab === 'favorites'
      ? t('noFavoritePairsHint', 'markets')
      : getEmptyPairText(marketTab, t);

  useEffect(() => {
    if (filteredPairs.length > 0) {
      setStablePairRows(filteredPairs);
      return;
    }

    if (!activePairsRefreshing && !isSwitchingWithoutRows) {
      setStablePairRows([]);
    }
  }, [activePairsRefreshing, filteredPairs, isSwitchingWithoutRows]);

  useEffect(() => {
    setVisibleTickerLimit(marketTab === 'stock' ? STOCK_CONTRACT_TICKER_BATCH_SIZE : SPOT_TICKER_BATCH_SIZE);
  }, [contractCategory, marketTab, pairKeyword, spotCategory, stockCategory]);

  useEffect(() => {
    if (!open || !['crypto', 'stock', 'cfd', 'favorites'].includes(marketTab) || displayPairs.length === 0) return;

    hydrateTickerSymbols(
      displayPairs
        .slice(0, visibleTickerLimit)
        .filter((item) => getPairMarket(item) === 'spot' || isMockStockContractPair(item))
      .map(getPairTickerSymbol),
    );
  }, [displayPairs, hydrateTickerSymbols, marketTab, open, visibleTickerLimit]);

  useEffect(() => {
    if (!open || !shouldHydrateContractTickerRows || displayPairs.length === 0) return;

    if (marketTab === 'stock') return;

    const contractPairsToHydrate = displayPairs.filter(
      (item) => getPairMarket(item) === 'contract' && !isMockStockContractPair(item),
    );
    hydrateContractTickerSymbols(
      contractPairsToHydrate.slice(0, visibleTickerLimit).map((item) => item.symbol),
      CONTRACT_TICKER_BATCH_SIZE,
      { ttlMs: CONTRACT_TICKER_REFRESH_TTL_MS },
    );
  }, [displayPairs, hydrateContractTickerSymbols, marketTab, open, shouldHydrateContractTickerRows, visibleTickerLimit]);

  useEffect(() => {
    if (!open || !shouldHydrateContractTickerRows || marketTab !== 'stock' || displayPairs.length === 0) return;

    const visibleStockContractSymbols = displayPairs
      .filter((item) => getPairMarket(item) === 'contract' && !isMockStockContractPair(item))
      .slice(0, visibleTickerLimit)
      .map((item) => item.symbol);

    hydrateContractTickerSymbols(
      visibleStockContractSymbols,
      STOCK_CONTRACT_TICKER_BATCH_SIZE,
      { ttlMs: STOCK_CONTRACT_TICKER_REFRESH_TTL_MS },
    );
  }, [displayPairs, hydrateContractTickerSymbols, marketTab, open, shouldHydrateContractTickerRows, visibleTickerLimit]);

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || buttonRef.current?.contains(target)) {
        return;
      }
      setOpen(false);
    };

    const updateMenuPosition = () => {
      const rect = buttonRef.current?.getBoundingClientRect();
      if (!rect) {
        return;
      }

      const menuWidth = Math.min(window.innerWidth * 0.94, 600);
      const left = Math.min(Math.max(8, rect.left), window.innerWidth - menuWidth - 8);
      setMenuPosition({
        left,
        top: rect.bottom + 8,
      });
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };

    updateMenuPosition();
    document.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('resize', updateMenuPosition);
    window.addEventListener('scroll', updateMenuPosition, true);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('resize', updateMenuPosition);
      window.removeEventListener('scroll', updateMenuPosition, true);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  const handleSelect = (pair: GlobalMarketSelectorPair) => {
    const nextMarket = getPairMarket(pair);
    const nextSymbol = nextMarket === 'spot' ? normalizeSpotApiSymbol(pair.symbol) : normalize(pair.symbol);

    if (isStockQuotePair(pair)) {
      setOpen(false);
      setSearch('');
      return;
    }

    if (nextMarket === 'contract') {
      if (pageType === 'contract') {
        onSymbolChange(nextSymbol);
      } else {
        router.push(`/contract?symbol=${encodeURIComponent(nextSymbol)}`);
      }
      setOpen(false);
      setSearch('');
      return;
    }

    if (nextMarket === 'spot' && pageType === 'contract') {
      router.push(`/trade/spot?symbol=${encodeURIComponent(nextSymbol)}`);
      setOpen(false);
      setSearch('');
      return;
    }

    onSymbolChange(nextSymbol);
    setOpen(false);
    setSearch('');
  };

  const toggleFavorite = (
    pair: GlobalMarketSelectorPair,
    event: React.MouseEvent<HTMLButtonElement>,
  ) => {
    event.preventDefault();
    event.stopPropagation();

    const nextFavorite = getFavoriteTarget(pair);

    setFavoriteSymbols((previous) => {
      const exists = previous.some((item) => getFavoriteKey(item.symbol, item.market) === nextFavorite.key);
      const nextFavorites = exists
        ? previous.filter((item) => getFavoriteKey(item.symbol, item.market) !== nextFavorite.key)
        : [...previous, { symbol: nextFavorite.symbol, market: nextFavorite.market }];

      writeFavoriteSymbols(nextFavorites);
      return nextFavorites;
    });
  };

  const markLogoFailed = useCallback((url: string) => {
    setFailedLogoUrls((previous) => {
      if (previous.includes(url)) return previous;
      return [...previous, url];
    });
  }, []);

  const handleMarketTabChange = (nextTab: MarketLayerTab) => {
    setMarketTab(nextTab);
    setSearch('');
  };

  const scheduleVisibleTickerExpansion = useCallback(() => {
    if (!['crypto', 'stock', 'cfd', 'favorites'].includes(marketTab) || visibleTickerLimit >= displayPairs.length) {
      return;
    }
    if (visibleTickerDebounceRef.current) {
      window.clearTimeout(visibleTickerDebounceRef.current);
    }
    const increment = marketTab === 'stock' ? STOCK_CONTRACT_TICKER_BATCH_SIZE : SPOT_TICKER_BATCH_SIZE;
    visibleTickerDebounceRef.current = window.setTimeout(() => {
      setVisibleTickerLimit((value) => Math.min(value + increment, displayPairs.length));
      visibleTickerDebounceRef.current = null;
    }, VISIBLE_TICKER_LOAD_DEBOUNCE_MS);
  }, [displayPairs.length, marketTab, visibleTickerLimit]);

  useEffect(() => {
    return () => {
      if (visibleTickerDebounceRef.current) {
        window.clearTimeout(visibleTickerDebounceRef.current);
      }
    };
  }, []);

  const handleListScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    const distanceToBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
    if (distanceToBottom < 140 && ['crypto', 'stock', 'cfd', 'favorites'].includes(marketTab) && visibleTickerLimit < displayPairs.length) {
      scheduleVisibleTickerExpansion();
    }
    if (distanceToBottom < 80 && hasMorePairs && !activePairsRefreshing && !pairsLoading && !pairsLoadingMore) {
      onLoadMorePairs?.();
    }
  };

  const handleListWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    if (event.deltaY <= 0 || !hasMorePairs || activePairsRefreshing || pairsLoading || pairsLoadingMore) {
      return;
    }

    const element = event.currentTarget;
    const hasScrollableContent = element.scrollHeight > element.clientHeight + 1;
    if (!hasScrollableContent) {
      if (['crypto', 'stock', 'cfd', 'favorites'].includes(marketTab) && visibleTickerLimit < displayPairs.length) {
        scheduleVisibleTickerExpansion();
      }
      onLoadMorePairs?.();
    }
  };

  return (
    <div
      className={
        isHeaderPlacement
          ? 'inline-flex min-w-0 items-center'
          : 'flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-3 py-2'
      }
    >
      <div className="flex min-w-0 flex-1 items-center">
        <div
          ref={buttonRef}
          className={`relative flex max-w-full shrink-0 items-center ${
            isHeaderPlacement
              ? 'h-11 min-w-0 max-w-[210px] gap-0 overflow-visible rounded-lg'
              : 'h-10 min-w-[190px] overflow-hidden rounded-md border border-white/10 bg-[#0b0e11] transition-colors hover:border-white/20 hover:bg-[#11161d]'
          }`}
        >
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            className={`flex h-full min-w-0 flex-1 items-center text-left text-white outline-none transition-colors focus-visible:bg-white/[0.04] ${
              isHeaderPlacement
                ? 'gap-2 rounded-lg pl-0 pr-0.5 hover:bg-white/[0.04]'
                : 'gap-2 px-3 text-sm'
            }`}
            aria-label={`${currentLabel} ${t('select', 'markets')}`}
          >
            <span
              className={`relative flex shrink-0 items-center justify-center overflow-hidden rounded-full font-bold leading-none ${coinLogoClass} ${
                isHeaderPlacement ? 'h-[30px] w-[30px] text-[13px]' : 'h-6 w-6 text-[11px]'
              }`}
            >
              {activeLogoUrl ? (
                <>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={activeLogoUrl}
                    alt={currentBaseAsset}
                    className="absolute inset-0 h-full w-full rounded-full object-cover"
                    onError={() => markLogoFailed(activeLogoUrl)}
                  />
                  <span className="sr-only">{currentBaseAsset}</span>
                </>
              ) : (
                coinLogoText
              )}
            </span>
            <span className={`min-w-0 truncate font-semibold leading-none ${isHeaderPlacement ? 'text-[17px]' : 'text-[15px]'}`}>{currentLabel}</span>
            <span
              aria-hidden="true"
              className={`relative h-3 w-3 shrink-0 transition-transform duration-150 ${open ? 'rotate-180' : ''}`}
            >
              <span
                className={`absolute left-1/2 top-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-[72%] rotate-45 border-b-2 border-r-2 ${
                  isHeaderPlacement ? 'border-white/65' : 'border-white/40'
                }`}
              />
            </span>
          </button>
          <button
            type="button"
            onClick={(event) => toggleFavorite(currentHeaderPair, event)}
            className={`flex shrink-0 items-center justify-center transition-colors ${
              currentFavoriteActive
                ? 'text-[#f0b90b] hover:bg-[#f0b90b]/10'
                : 'text-white/58 hover:bg-white/[0.06] hover:text-[#f0b90b]'
            } ${isHeaderPlacement ? 'h-7 w-7 rounded-full text-[20px] font-semibold' : 'mr-1.5 h-7 w-7 rounded text-[15px]'}`}
            aria-label={currentFavoriteActive ? t('removeFavorite', 'markets') : t('addFavorite', 'markets')}
          >
            {currentFavoriteActive ? '\u2605' : '\u2606'}
          </button>

          {open ? (
            <div
              ref={menuRef}
              className="fixed z-[1000] flex max-h-[min(70vh,640px)] w-[min(94vw,600px)] flex-col overflow-hidden rounded-lg border border-white/[0.08] bg-[#0d1117] pb-2 shadow-xl shadow-black/40"
              style={{ left: menuPosition.left, top: menuPosition.top }}
            >
            <div className="shrink-0 border-b border-white/[0.08] px-3 py-2.5">
              <div className="mb-2 flex items-center justify-between">
                <div className="text-sm font-semibold text-white">{t('tradingPair', 'markets')}</div>
                <div className="text-xs text-white/35">
                  {marketTab === 'crypto' ? t('crypto', 'markets') : marketTab === 'stock' ? t('stocks', 'markets') : marketTab === 'cfd' ? 'CFD' : t('favorites', 'markets')}
                </div>
              </div>

              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t('searchSymbolName', 'markets')}
                className="h-8 w-full rounded-md border border-white/[0.08] bg-[#070a0f] px-3 text-[13px] text-white outline-none placeholder:text-white/30 focus:border-[#00c087]/60"
              />

              <div className="mt-2 flex gap-1 overflow-x-auto pb-0.5">
                {MARKET_TABS.map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => handleMarketTabChange(item.key)}
                    className={`shrink-0 rounded-md px-2.5 py-1 text-[11px] transition-colors ${
                      marketTab === item.key
                        ? 'bg-[#1f2a33] text-white'
                        : 'text-white/50 hover:bg-white/[0.06] hover:text-white'
                    }`}
                  >
                    {t(item.labelKey, 'markets')}
                  </button>
                ))}
              </div>

              {marketTab === 'crypto' ? (
                <div className="mt-1.5 flex gap-1 overflow-x-auto pb-0.5">
                  {CRYPTO_CATEGORY_TABS.map((item) => (
                    <button
                      key={item.key}
                      type="button"
                      onClick={() => setSpotCategory(item.key)}
                      className={`shrink-0 rounded-md px-2 py-0.5 text-[11px] transition-colors ${
                        spotCategory === item.key
                          ? 'bg-[#14352e] text-[#00c087]'
                          : 'text-white/45 hover:bg-white/[0.06] hover:text-white'
                      }`}
                    >
                      {t(item.labelKey, 'markets')}
                    </button>
                  ))}
                </div>
              ) : null}

              {marketTab === 'stock' ? (
                <div className="mt-1.5 flex gap-1 overflow-x-auto pb-0.5">
                  {STOCK_CATEGORY_TABS.map((item) => (
                    <button
                      key={item.key}
                      type="button"
                      onClick={() => setStockCategory(item.key)}
                      className={`shrink-0 rounded-md px-2 py-0.5 text-[11px] transition-colors ${
                        stockCategory === item.key
                          ? 'bg-[#14352e] text-[#00c087]'
                          : 'text-white/45 hover:bg-white/[0.06] hover:text-white'
                      }`}
                    >
                      {t(item.labelKey, 'markets')}
                    </button>
                  ))}
                </div>
              ) : null}

              {marketTab === 'cfd' ? (
                <div className="mt-1.5 flex gap-1 overflow-x-auto pb-0.5">
                  {CONTRACT_CATEGORY_TABS.map((item) => (
                    <button
                      key={item.key}
                      type="button"
                      onClick={() => setContractCategory(item.key)}
                      className={`shrink-0 rounded-md px-2 py-0.5 text-[11px] transition-colors ${
                        contractCategory === item.key
                          ? 'bg-[#14352e] text-[#00c087]'
                          : 'text-white/45 hover:bg-white/[0.06] hover:text-white'
                      }`}
                    >
                      {t(item.labelKey, 'markets')}
                    </button>
                  ))}
                </div>
              ) : null}

            </div>

            <div className="grid shrink-0 grid-cols-[24px_minmax(120px,1fr)_100px_82px] gap-2 border-b border-white/[0.08] bg-[#0a0f15] px-3 py-1.5 text-[10px] font-medium text-white/35">
              <span />
              <span>{t('tradingPair', 'markets')}</span>
              <span className="text-right">{t('latestPrice', 'markets')}</span>
              <span className="text-right">{t('change24h', 'markets')}</span>
            </div>

            <div className="shrink-0 pb-1">
              <div
                className="h-[290px] overflow-y-auto"
                onScroll={handleListScroll}
                onWheel={handleListWheel}
              >
              {showInitialPairsLoading ? (
                <div className="px-4 py-10 text-center text-sm text-white/40">
                  {t('loadingPairs', 'markets')}
                </div>
              ) : showEmptyPairs ? (
                <div className="px-4 py-10 text-center text-sm text-white/40">
                  {emptyPairText}
                </div>
              ) : (
                <>
                {displayPairs.map((pair) => {
                  const active = normalize(pair.symbol) === normalize(symbol);
                  const changeValue = getPairChangeValue(pair);
                  const change = Number(changeValue);
                  const changeClass =
                    Number.isFinite(change) && change < 0
                      ? 'text-[#f6465d]'
                      : Number.isFinite(change) && change > 0
                        ? 'text-[#00c087]'
                        : 'text-white/45';
                  const pairMarket = getPairMarket(pair);
                  const rowKey = getPairUniqueKey(pair);
                  const label =
                    pairMarket === 'contract'
                      ? getContractDisplayLabel(pair.symbol, marketDisplayLabels)
                      : pair.displaySymbol || pair.label || formatSpotDisplaySymbol(pair.symbol);
                  const favoriteKey = getFavoriteKey(pair.symbol, pairMarket);
                  const favoriteActive = favoriteKeySet.has(favoriteKey);
                  const contractTickerLoading =
                    pairMarket === 'contract' && contractTickerHydratingRef.current.has(normalize(pair.symbol));
                  const priceText =
                    contractTickerLoading && !hasValidTickerNumber(pair.price, { positiveOnly: true })
                      ? t('loading', 'markets')
                      : formatPrice(pair.price, pair);
                  const changeText =
                    contractTickerLoading && !hasValidTickerNumber(changeValue)
                      ? t('loading', 'markets')
                      : formatPercent(changeValue);

                  return (
                    <div
                      key={rowKey}
                      role="button"
                      tabIndex={0}
                      onClick={() => handleSelect(pair)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          handleSelect(pair);
                        }
                      }}
                    className={`grid h-[58px] w-full cursor-pointer grid-cols-[24px_28px_minmax(120px,1fr)_100px_72px] items-center gap-2 px-3 text-left transition-colors hover:bg-white/[0.05] ${
                      active ? 'bg-[#10201d]' : ''
                    }`}
                  >
                      <button
                        type="button"
                        onClick={(event) => toggleFavorite(pair, event)}
                        className={`flex h-7 w-7 items-center justify-center rounded text-[15px] transition-colors ${
                          favoriteActive
                            ? 'text-[#f0b90b] hover:bg-[#f0b90b]/10'
                            : 'text-white/28 hover:bg-white/[0.06] hover:text-[#f0b90b]'
                        }`}
                        aria-label={favoriteActive ? t('removeFavorite', 'markets') : t('addFavorite', 'markets')}
                      >
                        {favoriteActive ? '\u2605' : '\u2606'}
                      </button>
                      {(() => {
                        const rowBaseAsset = inferBaseQuote(pair).base || normalize(pair.symbol);
                        const rowLogoUrl = getPairLogoUrl(pair);
                        const rowActiveLogoUrl = rowLogoUrl && !failedLogoUrlSet.has(rowLogoUrl) ? rowLogoUrl : '';

                        return (
                          <span
                            className={`relative flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-full text-[11px] font-bold leading-none ${getCoinLogoClass()}`}
                          >
                            {rowActiveLogoUrl ? (
                              <>
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img
                                  src={rowActiveLogoUrl}
                                  alt={rowBaseAsset}
                                  className="absolute inset-0 h-full w-full rounded-full object-cover"
                                  onError={() => markLogoFailed(rowActiveLogoUrl)}
                                />
                                <span className="sr-only">{rowBaseAsset}</span>
                              </>
                            ) : (
                              getCoinLogoText(rowBaseAsset)
                            )}
                          </span>
                        );
                      })()}
                      <span className="min-w-0">
                        <span className="block truncate text-[13px] font-semibold text-white">{label}</span>
                        <span className="mt-0.5 block text-[11px] text-white/38">
                          {getPairSubtitle(pair, t)}
                        </span>
                      </span>
                      <span className="truncate text-right text-[13px] text-white/78">{priceText}</span>
                      <span className={`text-right text-[13px] font-semibold ${changeClass}`}>
                        {changeText}
                      </span>
                    </div>
                  );
                })}
                {pairsLoadingMore ? (
                  <div className="px-4 py-3 text-center text-xs text-white/35">{t('loadingMorePairs', 'markets')}</div>
                ) : null}
                </>
              )}
              </div>
            </div>
          </div>
          ) : null}
        </div>
      </div>

      {showIntervalControls ? (
        <div className="flex shrink-0 items-center gap-2 overflow-x-auto">
          {showTimeSharing ? (
            <button
              type="button"
              onClick={() => onChartModeChange?.('time')}
              className={`px-2.5 py-1 text-sm font-medium transition-colors ${
                chartMode === 'time'
                  ? 'text-[#f0b90b]'
                  : 'text-gray-400 hover:text-white'
              }`}
            >
              {'\u5206\u65f6'}
            </button>
          ) : null}
          {intervalOptions.map((item) => {
            const active = chartMode !== 'time' && interval === item;
            return (
              <button
                key={item}
                type="button"
                onClick={() => {
                  onChartModeChange?.('candle');
                  onIntervalChange(item);
                }}
                className={`px-2.5 py-1 text-sm font-medium transition-colors ${
                  active
                    ? 'text-[#f0b90b]'
                    : 'text-gray-400 hover:text-white'
                }`}
              >
                {formatIntervalLabel(item)}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
