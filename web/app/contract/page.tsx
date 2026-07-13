'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import ContractAccountPanel from '@/components/contract/ContractAccountPanel';
import ContractFuturesOrderBook from '@/components/contract/ContractFuturesOrderBook';
import ContractFuturesTrades from '@/components/contract/ContractFuturesTrades';
import ContractMarketHeader, {
  type HeaderMetric,
} from '@/components/contract/ContractMarketHeader';
import ContractPositionTabs, {
  type ContractPositionTabKey,
} from '@/components/contract/ContractPositionTabs';
import ContractTradingForm from '@/components/contract/ContractTradingForm';
import ContractTradingViewChart from '@/components/contract/ContractTradingViewChart';
import {
  normalizeContractKlineAssetClass,
  type ContractKlineAssetClass,
} from '@/components/contract/tradingview/contractKlineCachePolicy';
import { useContractMarketView } from '@/components/contract/hooks/useContractMarketView';
import { useContractPageVisibility } from '@/components/contract/hooks/useContractMarketViewPolling';
import { useContractUserState } from '@/components/contract/hooks/useContractUserState';
import GlobalMarketSelector, {
  type GlobalMarketSelectorPair,
  type PairQueryUpdate,
} from '@/components/spot/GlobalMarketSelector';
import { useAuth } from '@/lib/authContext';
import { useLocaleContext } from '@/contexts/LocaleContext';
import { formatPrice } from '@/lib/marketPrecision';
import {
  getContractSymbols,
  getContractTickers,
  type ContractTickerItem,
  type ContractSymbolItem,
} from '@/lib/api/modules/contract';
import type { SpotMarketPairItem } from '@/lib/api/modules/spot';
import { isMockStockContractSymbol, toStockContractSymbol } from '@/lib/stockContracts';

type RightPanelTab = 'orderbook' | 'trades';
type ContractChartMode = 'time' | 'candle';
type ContractUrlCategory = 'usdt' | 'stock' | 'cfd' | '';
type ContractDataScope = 'current' | 'all';
type ContractTranslator = (key: string, namespace?: 'contracts' | 'markets') => string;
type ContractSelectorPair = GlobalMarketSelectorPair & {
  contractKlineAssetClass?: ContractKlineAssetClass;
};

const DEFAULT_CONTRACT_SYMBOL = 'BTCUSDT_PERP';
const CONTRACT_INTERVAL_OPTIONS = ['1m', '5m', '15m', '1h', '4h', '1d', '1w', '1M'];
const CONTRACT_TRADFI_INTERVAL_OPTIONS = CONTRACT_INTERVAL_OPTIONS.filter((item) => item !== '4h');
const CFD_CONTRACT_CATEGORIES = new Set(['GOLD', 'FUTURES', 'INDEX', 'FOREX', 'METAL', 'COMMODITY']);
const CRYPTO_CONTRACT_BASES = new Set([
  'BTC',
  'ETH',
  'BNB',
  'SOL',
  'XRP',
  'DOGE',
  'ADA',
  'AVAX',
  'MATIC',
  'DOT',
  'LTC',
  'BCH',
  'LINK',
  'TRX',
  'TON',
]);

const CONTRACT_SYMBOL_OPTIONS = [
  { contractSymbol: DEFAULT_CONTRACT_SYMBOL, marketSymbol: 'BTCUSDT', pricePrecision: 1 },
];

function getContractSymbol(marketSymbol: string) {
  const normalized = String(marketSymbol || '').trim().toUpperCase();
  if (normalized.endsWith('_PERP')) return normalized;
  return (
    CONTRACT_SYMBOL_OPTIONS.find((item) => item.contractSymbol === normalized)?.contractSymbol ||
    CONTRACT_SYMBOL_OPTIONS.find((item) => item.marketSymbol === normalized)?.contractSymbol ||
    `${normalized}_PERP`
  );
}

function normalizeContractSymbol(value?: string | null) {
  const normalized = String(value || '').trim().toUpperCase();
  if (!normalized) return '';
  return getContractSymbol(normalized);
}

function normalizeContractUrlCategory(value?: string | null): ContractUrlCategory {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'usdt' || normalized === 'stock' || normalized === 'cfd') return normalized;
  return '';
}

function normalizeContractCategoryValue(value?: string | null) {
  const normalized = String(value || '').trim().toUpperCase();
  if (normalized === 'CORE' || normalized === 'CRYPTO' || normalized === 'USDT' || normalized === 'CONTRACT' || normalized === 'PERPETUAL') {
    return 'CRYPTO';
  }
  if (normalized === 'STOCK' || normalized === 'STOCK_CONTRACT') return 'STOCK';
  if (normalized === 'FX') return 'FOREX';
  if (normalized === 'METAL' || normalized === 'GOLD' || normalized === 'SILVER') return 'GOLD';
  if (normalized === 'COMMODITY' || normalized === 'FUTURES') return 'FUTURES';
  return normalized;
}

function getContractPairCategories(pair: GlobalMarketSelectorPair) {
  return [
    pair.assetType,
    pair.marketCategory,
    pair.marketSubCategory,
    pair.displayGroup,
  ].map(normalizeContractCategoryValue);
}

function contractPairMatchesUrlCategory(pair: GlobalMarketSelectorPair, category: ContractUrlCategory) {
  if (!category) return false;

  const categories = getContractPairCategories(pair);
  if (category === 'stock') return categories.includes('STOCK');
  if (category === 'cfd') return categories.some((item) => CFD_CONTRACT_CATEGORIES.has(item));
  return categories.includes('CRYPTO') && !categories.includes('STOCK') && !categories.some((item) => CFD_CONTRACT_CATEGORIES.has(item));
}

function getFirstContractPairForCategory(
  pairs: GlobalMarketSelectorPair[],
  category: ContractUrlCategory,
) {
  if (!category) return null;
  return pairs.find((item) => contractPairMatchesUrlCategory(item, category)) || null;
}

function getContractUrlForResolvedSymbol(category: ContractUrlCategory, symbol: string) {
  const symbolParam = encodeURIComponent(symbol);
  if (!category) return `/contract?symbol=${symbolParam}`;
  return `/contract?category=${encodeURIComponent(category)}&symbol=${symbolParam}`;
}

function contractSymbolToMarketSymbol(symbol: string) {
  return symbol.replace(/_PERP$/, '');
}

function formatContractMarketDisplaySymbol(symbol: string, quoteAsset?: string | null) {
  const normalized = String(symbol || '').trim().toUpperCase().replace(/_PERP$/, '');
  const quote = String(quoteAsset || '').trim().toUpperCase();
  if (!normalized) return '';
  if (normalized.includes('/')) return normalized;
  if (quote && normalized.endsWith(quote) && normalized.length > quote.length) {
    return `${normalized.slice(0, -quote.length)}/${quote}`;
  }
  for (const fallbackQuote of ['USDT', 'USDC', 'USD']) {
    if (normalized.endsWith(fallbackQuote) && normalized.length > fallbackQuote.length) {
      return `${normalized.slice(0, -fallbackQuote.length)}/${fallbackQuote}`;
    }
  }
  return normalized;
}

function isKnownCryptoContractSymbol(symbol: string) {
  const marketSymbol = contractSymbolToMarketSymbol(symbol).toUpperCase();
  const base = marketSymbol.replace(/(USDT|USDC|USD)$/, '');
  return CRYPTO_CONTRACT_BASES.has(base);
}

function shouldUseInitialContractSymbol(symbol: string) {
  return Boolean(symbol);
}

function getContractDisplayLabel(item: ContractSymbolItem, t: ContractTranslator) {
  const displayName = String(item.display_name || '').trim();
  const marketDisplaySymbol = formatContractMarketDisplaySymbol(item.symbol, item.quote_asset);
  if (displayName && displayName.toUpperCase() !== contractSymbolToMarketSymbol(item.symbol).toUpperCase()) {
    return displayName;
  }
  return `${marketDisplaySymbol} ${t('perpetual', 'contracts')}`;
}

function getFallbackContractPair(contractSymbol: string, pricePrecision: number, t: ContractTranslator): ContractSelectorPair {
  const option = CONTRACT_SYMBOL_OPTIONS.find((item) => item.contractSymbol === contractSymbol);
  const marketSymbol = option?.marketSymbol || contractSymbolToMarketSymbol(contractSymbol);
  const label = `${formatContractMarketDisplaySymbol(marketSymbol, 'USDT')} ${t('perpetual', 'contracts')}`;
  return {
    symbol: contractSymbol,
    label,
    displaySymbol: label,
    baseAsset: marketSymbol.replace(/USDT$/, ''),
    quoteAsset: 'USDT',
    assetType: 'CONTRACT',
    marketCategory: 'CONTRACT',
    marketSubCategory: 'PERPETUAL',
    displayGroup: t('contract', 'contracts'),
    pricePrecision,
    maxLeverage: 200,
    tpSlTriggerPriceType: 'MARK_PRICE',
    contractKlineAssetClass: 'UNKNOWN',
  };
}

function normalizeTpSlTriggerPriceType(value: unknown): 'MARK_PRICE' | 'LAST_PRICE' {
  return String(value || '').trim().toUpperCase() === 'LAST_PRICE' ? 'LAST_PRICE' : 'MARK_PRICE';
}

function buildContractPairOption(item: ContractSymbolItem, t: ContractTranslator): ContractSelectorPair {
  const marketSymbol = contractSymbolToMarketSymbol(item.symbol);
  const category = normalizeContractCategoryValue(item.category || item.asset_type || item.underlying_type);
  const isStockContract = category === 'STOCK';
  const isCfdContract = CFD_CONTRACT_CATEGORIES.has(category);
  return {
    symbol: item.symbol,
    label: getContractDisplayLabel(item, t),
    displaySymbol: getContractDisplayLabel(item, t),
    baseAsset: marketSymbol.endsWith(item.quote_asset)
      ? marketSymbol.slice(0, -item.quote_asset.length)
      : marketSymbol,
    quoteAsset: item.quote_asset,
    assetType: category || 'CONTRACT',
    dataSource: item.provider,
    marketMode: item.provider,
    marketCategory: isStockContract ? 'STOCK' : isCfdContract ? category : 'CONTRACT',
    marketSubCategory: isStockContract ? 'STOCK_CONTRACT' : isCfdContract ? category : 'PERPETUAL',
    displayGroup: isStockContract ? t('stockContracts', 'contracts') : isCfdContract ? 'CFD' : t('contract', 'contracts'),
    marketStatus: item.market_status,
    marketStatusText: item.market_status_text,
    marketSessionCode: item.market_session_code,
    marketTimezone: item.market_timezone,
    marketTradingHours: item.market_trading_hours,
    marketSessionType: item.market_session_type,
    tpSlTriggerPriceType: normalizeTpSlTriggerPriceType(item.tp_sl_trigger_price_type),
    pricePrecision: item.price_precision,
    maxLeverage: item.max_leverage,
    contractKlineAssetClass: normalizeContractKlineAssetClass(item.category),
  };
}

function parseOptionalPrecision(value: unknown): number | null {
  const nextValue = Number(value);
  if (Number.isInteger(nextValue) && nextValue >= 0 && nextValue <= 12) {
    return nextValue;
  }
  return null;
}

function formatCompactAmount(value: unknown, precision = 2) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '--';
  const abs = Math.abs(amount);
  if (abs >= 1_000_000_000) return `${(amount / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${(amount / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(amount / 1_000).toFixed(2)}K`;
  return amount.toFixed(precision);
}

function formatSignedPercent(value: unknown) {
  const percent = Number(value);
  if (!Number.isFinite(percent)) return '--';
  if (percent === 0) return '0.00%';
  return `${percent > 0 ? '+' : ''}${percent.toFixed(2)}%`;
}

function formatFundingPercent(value: unknown) {
  const rate = Number(value);
  if (!Number.isFinite(rate)) return '--';
  return `${rate > 0 ? '+' : ''}${(rate * 100).toFixed(4)}%`;
}

function formatSignedPriceChange(value: unknown, pricePrecision: number) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '--';
  if (amount === 0) return formatPrice(0, pricePrecision);
  return `${amount > 0 ? '+' : ''}${amount.toFixed(pricePrecision)}`;
}

function formatHeaderChange(changeAmount: unknown, changePercent: unknown, pricePrecision: number) {
  const amount = formatSignedPriceChange(changeAmount, pricePrecision);
  const percent = formatSignedPercent(changePercent);
  if (amount !== '--' && percent !== '--') return `${amount} / ${percent}`;
  if (amount !== '--') return amount;
  return percent;
}

function getTickerChangePercent(ticker: ContractTickerItem | null) {
  return ticker?.price_change_percent_24h ?? ticker?.priceChangePercent ?? null;
}

function getTickerChangeAmount(ticker: ContractTickerItem | null) {
  return ticker?.price_change_24h ?? ticker?.change_24h ?? null;
}

function isCryptoContractPair(pair: GlobalMarketSelectorPair | null | undefined) {
  if (!pair) return false;
  const categories = getContractPairCategories(pair);
  return (
    categories.includes('CRYPTO') &&
    !categories.includes('STOCK') &&
    !categories.some((item) => CFD_CONTRACT_CATEGORIES.has(item))
  );
}

function isTradfiContractPair(pair: GlobalMarketSelectorPair | null | undefined) {
  if (!pair) return false;
  const categories = getContractPairCategories(pair);
  return categories.includes('STOCK') || categories.some((item) => CFD_CONTRACT_CATEGORIES.has(item));
}

// Kept for future cross-market toolbar support; contract page no longer calls spot pair APIs on first paint.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function buildSpotPairOption(item: SpotMarketPairItem): GlobalMarketSelectorPair | null {
  const symbol = String(item.symbol || '').trim().toUpperCase();
  if (!symbol) return null;

  return {
    symbol,
    label: String(item.display_symbol || '').trim() || symbol,
    displaySymbol: item.display_symbol,
    baseAsset: item.base_asset,
    quoteAsset: item.quote_asset,
    assetType: item.asset_type,
    dataSource: item.data_source,
    marketMode: item.market_mode,
    marketCategory: item.market_category,
    marketSubCategory: item.market_sub_category,
    displayGroup: String(item.display_group || '').trim() || null,
    pricePrecision: parseOptionalPrecision(item.price_precision),
    amountPrecision: parseOptionalPrecision(item.amount_precision),
  };
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function buildMockStockContractPairOption(item: SpotMarketPairItem, t: ContractTranslator): GlobalMarketSelectorPair | null {
  const base = String(item.external_symbol || item.base_asset || '')
    .trim()
    .toUpperCase()
    .replace(/USDT$/, '')
    .replace(/ON$/, '');
  const symbol = toStockContractSymbol(base);
  if (!base || !symbol) return null;

  return {
    symbol,
    label: `${formatContractMarketDisplaySymbol(`${base}USDT`, 'USDT')} ${t('perpetual', 'contracts')}`,
    displaySymbol: `${formatContractMarketDisplaySymbol(`${base}USDT`, 'USDT')} ${t('perpetual', 'contracts')}`,
    baseAsset: base,
    quoteAsset: 'USDT',
    assetType: 'STOCK',
    dataSource: item.data_source,
    marketMode: 'MOCK_STOCK_CONTRACT',
    marketCategory: 'STOCK',
    marketSubCategory: 'STOCK_CONTRACT',
    displayGroup: t('stockContracts', 'contracts'),
    sourceSymbol: item.symbol,
    pricePrecision: parseOptionalPrecision(item.price_precision),
    amountPrecision: parseOptionalPrecision(item.amount_precision),
  };
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function isLegacyStockSpotOption(item: GlobalMarketSelectorPair): boolean {
  return item.assetType === 'STOCK' && item.marketSubCategory !== 'STOCK_CONTRACT';
}

function ContractPageContent() {
  const { t } = useLocaleContext();
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialUrlContractSymbol = normalizeContractSymbol(searchParams.get('symbol'));
  const initialContractSymbol = shouldUseInitialContractSymbol(initialUrlContractSymbol)
    ? initialUrlContractSymbol
    : DEFAULT_CONTRACT_SYMBOL;
  const { isLoggedIn, loading: authLoading, userIdentityKey } = useAuth();
  const isPageVisible = useContractPageVisibility();
  const [contractSymbol, setContractSymbol] = useState(() => initialContractSymbol);
  const [interval, setIntervalValue] = useState('1m');
  const [chartMode, setChartMode] = useState<ContractChartMode>('candle');
  const [rightPanelTab, setRightPanelTab] = useState<RightPanelTab>('orderbook');
  const [contractDataScope, setContractDataScope] = useState<ContractDataScope>('current');
  const [contractUserTab, setContractUserTab] = useState<ContractPositionTabKey>('positions');
  const [selectedPriceState, setSelectedPriceState] = useState<{ symbol: string; price: string } | null>(null);
  const [contractPairs, setContractPairs] = useState<ContractSelectorPair[]>(() => [
    getFallbackContractPair(DEFAULT_CONTRACT_SYMBOL, 1, t),
  ]);
  const [contractPairsLoading, setContractPairsLoading] = useState(false);
  const [contractPairsLoaded, setContractPairsLoaded] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [contractTicker, setContractTicker] = useState<ContractTickerItem | null>(null);
  const urlContractSymbol = useMemo(
    () => normalizeContractSymbol(searchParams.get('symbol')),
    [searchParams],
  );
  const urlContractCategory = useMemo(
    () => normalizeContractUrlCategory(searchParams.get('category')),
    [searchParams],
  );

  const symbolOption = useMemo(
    () => CONTRACT_SYMBOL_OPTIONS.find((item) => item.contractSymbol === contractSymbol),
    [contractSymbol],
  );
  const currentContractPair = useMemo(
    () => contractPairs.find((item) => item.symbol === contractSymbol) || null,
    [contractPairs, contractSymbol],
  );
  const activeContractTicker = useMemo(
    () => contractTicker && normalizeContractSymbol(contractTicker.symbol) === contractSymbol
      ? contractTicker
      : null,
    [contractSymbol, contractTicker],
  );
  const selectedPrice = selectedPriceState?.symbol === contractSymbol
    ? selectedPriceState.price
    : null;
  const currentContractKlineAssetClass = normalizeContractKlineAssetClass(
    currentContractPair?.contractKlineAssetClass,
  );
  const contractChartIntervalOptions = useMemo(
    () => (isTradfiContractPair(currentContractPair) ? CONTRACT_TRADFI_INTERVAL_OPTIONS : CONTRACT_INTERVAL_OPTIONS),
    [currentContractPair],
  );
  const effectiveKlineInterval = chartMode === 'time' ? '1m' : interval;
  const maxLeverage = currentContractPair?.maxLeverage || 200;
  const {
    marketSymbol,
    quantityUnit,
    quote: contractQuote,
    contractAvailabilityError,
    pricePrecision,
    quoteHint,
    marketView: activeContractMarketView,
    displayPrice: currentPriceNumber,
    displayPriceSource: currentPriceSource,
    displayPriceLabel: currentPriceSourceLabel,
    depthBids,
    depthAsks,
    depthLoading,
    depthError,
    tickerSource,
    tickerFreshness,
    depthSource,
    depthFreshness,
    depthUpdatedAt,
    depthMode,
    depthStatus,
    depthStatusLabel,
    recentTrades,
    tradesLoading,
    tradesError,
    tradesSource,
    tradesFreshness,
    latestTradeDirection,
    bestBid: hookBestBid,
    bestAsk: hookBestAsk,
    spread: hookSpread,
    executable: contractExecutable,
    executionBid,
    executionAsk,
    reasonCode,
    marketState: contractMarketState,
    marketUiState,
    marketStatus: contractMarketStatus,
    marketStatusText: contractMarketStatusText,
    marketSessionType: contractMarketSessionType,
    quoteStatusLoading,
    quoteStatusLabel,
    quoteStatusTone,
    currentPriceReady,
    priceDirection: currentPriceDirection,
    expiredLastGoodQuote,
    handleLatestKlineCloseChange,
  } = useContractMarketView({
    contractSymbol,
    interval: effectiveKlineInterval,
    symbolOptionMarketSymbol: symbolOption?.marketSymbol,
    symbolOptionPricePrecision: currentContractPair?.pricePrecision ?? symbolOption?.pricePrecision,
    fallbackMarketStatus: activeContractTicker?.market_status || currentContractPair?.marketStatus,
    fallbackMarketStatusText: activeContractTicker?.market_status_text || currentContractPair?.marketStatusText,
    fallbackMarketSessionType: activeContractTicker?.market_session_type || currentContractPair?.marketSessionType,
    fallbackQuoteFreshness: activeContractTicker?.quote_freshness,
  });
  const marketViewCategory = normalizeContractCategoryValue(activeContractMarketView?.category);
  const isCryptoContract = isCryptoContractPair(currentContractPair)
    || marketViewCategory === 'CRYPTO'
    || isKnownCryptoContractSymbol(contractSymbol)
    || (!!symbolOption && !currentContractPair);
  const currentPriceDisplay = currentPriceReady
    ? formatPrice(currentPriceNumber, pricePrecision)
    : '--';
  const headerDisplayPrice = currentPriceDisplay;
  const headerMainPrice = currentPriceDisplay;
  const displayLastPrice = currentPriceDisplay;
  const lastGoodQuotePrice = formatPrice(contractQuote?.last_price, pricePrecision);
  const tpSlTriggerPriceType = normalizeTpSlTriggerPriceType(currentContractPair?.tpSlTriggerPriceType);
  const headerMetrics = useMemo<HeaderMetric[]>(() => {
    const bid = formatPrice(hookBestBid, pricePrecision);
    const ask = formatPrice(hookBestAsk, pricePrecision);
    const spread = formatPrice(hookSpread, pricePrecision);
    const highLow = `${formatPrice(activeContractTicker?.high_24h, pricePrecision)} / ${formatPrice(activeContractTicker?.low_24h, pricePrecision)}`;
    const volumeTurnover = `${formatCompactAmount(activeContractTicker?.base_volume_24h)} / ${formatCompactAmount(activeContractTicker?.quote_volume_24h)}`;
    const bidAskSpread = `${bid} / ${ask} / ${spread}`;
    if (isCryptoContract) {
      return [
        {
          label: `${t('markPrice', 'contracts')} / ${t('indexPrice', 'contracts')} / 资金费率`,
          value: `${formatPrice(contractQuote?.mark_price, pricePrecision)} / ${formatPrice(contractQuote?.index_price, pricePrecision)} / ${formatFundingPercent(contractQuote?.funding_rate)}`,
        },
        { label: '24h高 / 低', value: highLow },
        { label: '24h量 / 额', value: volumeTurnover },
        { label: '买 / 卖 / 差', value: bidAskSpread },
      ];
    }

    if (expiredLastGoodQuote) {
      return [
        {
          label: `${currentPriceSourceLabel} / ${t('markLatest', 'contracts')}`,
          value: `${headerDisplayPrice} / ${lastGoodQuotePrice}`,
          subValue: quoteStatusLabel,
        },
        { label: '买 / 卖 / 差', value: bidAskSpread },
        { label: '24h高 / 低', value: highLow },
      ];
    }

    return [
      {
        label: `${t('markLatest', 'contracts')} / ${currentPriceSourceLabel}`,
        value: `${formatPrice(contractQuote?.mark_price, pricePrecision)} / ${displayLastPrice}`,
      },
      { label: '买 / 卖 / 差', value: bidAskSpread },
      { label: '24h高 / 低', value: highLow },
    ];
  }, [
    activeContractTicker?.base_volume_24h,
    contractQuote?.index_price,
    contractQuote?.funding_rate,
    contractQuote?.mark_price,
    activeContractTicker?.high_24h,
    activeContractTicker?.low_24h,
    activeContractTicker?.quote_volume_24h,
    currentPriceSourceLabel,
    displayLastPrice,
    expiredLastGoodQuote,
    headerDisplayPrice,
    isCryptoContract,
    lastGoodQuotePrice,
    hookBestAsk,
    hookBestBid,
    hookSpread,
    pricePrecision,
    quoteStatusLabel,
    t,
  ]);
  const headerChange = formatHeaderChange(
    getTickerChangeAmount(activeContractTicker),
    getTickerChangePercent(activeContractTicker),
    pricePrecision,
  );

  const {
    account,
    positions,
    positionsPageItems,
    positionSummaries,
    activeOrders,
    orders,
    trades,
    activeOrdersFilters,
    orderHistoryFilters,
    tradeHistoryFilters,
    privateLoading,
    isScopeSwitching,
    isAllPositionsLoading,
    isOrdersLoading,
    isTradesLoading,
    accountError,
    realtimeStatus,
    openPositionsForTrading,
    refreshPrivateSilently,
    positionsPagination,
    activeOrdersPagination,
    orderHistoryPagination,
    tradeHistoryPagination,
    onActiveOrdersFiltersChange,
    onOrderHistoryFiltersChange,
    onTradeHistoryFiltersChange,
  } = useContractUserState({
    contractSymbol,
    dataScope: contractDataScope,
    activeTab: contractUserTab,
    isLoggedIn,
    userIdentityKey,
    onErrorChange: setError,
  });
  const contractPairSymbols = useMemo(
    () => contractPairs.map((item) => item.symbol),
    [contractPairs],
  );
  const toolbarPairs = useMemo(() => contractPairs, [contractPairs]);
  const toolbarPairSymbols = useMemo(
    () => toolbarPairs.map((item) => item.symbol),
    [toolbarPairs],
  );
  const toolbarPairLabels = useMemo(
    () =>
      Object.fromEntries(toolbarPairs.map((item) => [item.symbol, item.label || item.symbol])) as Record<string, string>,
    [toolbarPairs],
  );

  const selectContractSymbol = useCallback((nextSymbol: string, historyMode: 'push' | 'replace' = 'push') => {
    const normalizedSymbol = normalizeContractSymbol(nextSymbol) || DEFAULT_CONTRACT_SYMBOL;
    setSelectedPriceState(null);
    setNotice(null);
    setError(null);
    setContractDataScope('current');
    setContractSymbol(normalizedSymbol);
    const nextPath = `/contract?symbol=${encodeURIComponent(normalizedSymbol)}`;
    if (historyMode === 'replace') {
      router.replace(nextPath);
    } else {
      router.push(nextPath);
    }
  }, [router]);

  const refreshContractPairs = useCallback(async () => {
    setContractPairsLoading(true);
    try {
      const contractResponse = await getContractSymbols({ category: 'all', quote: 'all', page: 1, page_size: 100 });
      setContractPairs(contractResponse.items.map((item) => buildContractPairOption(item, t)));
    } catch {
      setContractPairs((previous) => {
        if (previous.some((item) => item.symbol === DEFAULT_CONTRACT_SYMBOL)) return previous;
        return [getFallbackContractPair(DEFAULT_CONTRACT_SYMBOL, 1, t), ...previous];
      });
    } finally {
      setContractPairsLoaded(true);
      setContractPairsLoading(false);
    }
  }, [t]);

  const handleToolbarPairQueryChange = useCallback((query: PairQueryUpdate) => {
    if (query.marketType === 'spot') return;
  }, []);

  const handleContractIntervalChange = useCallback((nextInterval: string) => {
    setChartMode('candle');
    setIntervalValue(nextInterval);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void refreshContractPairs();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [refreshContractPairs]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSelectedPriceState(null);
      setNotice(null);
      setError(null);
      setContractDataScope('current');
      onActiveOrdersFiltersChange({});
      onOrderHistoryFiltersChange({});
      onTradeHistoryFiltersChange({});
    }, 0);
    return () => window.clearTimeout(timer);
  }, [
    contractSymbol,
    onActiveOrdersFiltersChange,
    onOrderHistoryFiltersChange,
    onTradeHistoryFiltersChange,
  ]);

  useEffect(() => {
    if (contractChartIntervalOptions.includes(interval)) return;
    const timer = window.setTimeout(() => {
      setIntervalValue(contractChartIntervalOptions.includes('1h') ? '1h' : contractChartIntervalOptions[0] || '1m');
    }, 0);
    return () => window.clearTimeout(timer);
  }, [contractChartIntervalOptions, interval]);

  useEffect(() => {
    if (!isPageVisible) return undefined;
    let alive = true;

    async function refreshTicker() {
      try {
        const response = await getContractTickers({ symbols: [contractSymbol], limit: 1 });
        if (!alive) return;
        const ticker = response.items.find((item) => item.symbol === contractSymbol) || response.items[0] || null;
        setContractTicker(ticker);
      } catch {
        if (alive) setContractTicker(null);
      }
    }

    void refreshTicker();
    const timer = window.setInterval(() => {
      void refreshTicker();
    }, 5000);

    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [contractSymbol, isPageVisible]);

  useEffect(() => {
    if (!contractPairsLoaded) return;
    const timer = window.setTimeout(() => {
      const availableSymbols = new Set(contractPairs.map((item) => item.symbol));
      const requestedSymbol = urlContractSymbol;

      if (requestedSymbol && availableSymbols.has(requestedSymbol)) {
        if (contractSymbol !== requestedSymbol) {
          setContractSymbol(requestedSymbol);
        }
        return;
      }

      if (requestedSymbol && isMockStockContractSymbol(requestedSymbol)) {
        const requestedDisplaySymbol = formatContractMarketDisplaySymbol(requestedSymbol, 'USDT');
        const mockPair: GlobalMarketSelectorPair = {
          symbol: requestedSymbol,
          label: `${requestedDisplaySymbol} ${t('perpetual', 'contracts')}`,
          displaySymbol: `${requestedDisplaySymbol} ${t('perpetual', 'contracts')}`,
          baseAsset: contractSymbolToMarketSymbol(requestedSymbol).replace(/USDT$/, ''),
          quoteAsset: 'USDT',
          assetType: 'STOCK',
          marketMode: 'MOCK_STOCK_CONTRACT',
          marketCategory: 'STOCK',
          marketSubCategory: 'STOCK_CONTRACT',
          displayGroup: t('stockContracts', 'contracts'),
        };
        setContractPairs((previous) => (
          previous.some((item) => item.symbol === requestedSymbol) ? previous : [...previous, mockPair]
        ));
        if (contractSymbol !== requestedSymbol) {
          setContractSymbol(requestedSymbol);
        }
        return;
      }

      if (!requestedSymbol && urlContractCategory) {
        const categoryPair = getFirstContractPairForCategory(contractPairs, urlContractCategory);
        if (categoryPair) {
          if (contractSymbol !== categoryPair.symbol) {
            setContractSymbol(categoryPair.symbol);
          }
          router.replace(getContractUrlForResolvedSymbol(urlContractCategory, categoryPair.symbol));
          return;
        }
      }

      if (availableSymbols.has(DEFAULT_CONTRACT_SYMBOL)) {
        if (contractSymbol !== DEFAULT_CONTRACT_SYMBOL) {
          setContractSymbol(DEFAULT_CONTRACT_SYMBOL);
        }
        router.replace(getContractUrlForResolvedSymbol('', DEFAULT_CONTRACT_SYMBOL));
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [contractPairs, contractPairsLoaded, contractSymbol, router, t, urlContractCategory, urlContractSymbol]);

  function pushNotice(message: string) {
    setError(null);
    setNotice(message);
  }

  function pushError(message: string) {
    setNotice(null);
    setError(message);
  }

  return (
    <div className="flex flex-col overflow-x-hidden bg-[#0b0e11] text-white">
      <div className="w-full px-2 py-2 xl:px-3 xl:py-2">
        <ContractMarketHeader
          marketSymbol={marketSymbol}
          price={headerMainPrice}
          change={headerChange}
          quoteStatusLabel={quoteStatusLabel}
          quoteStatusTone={quoteStatusTone}
          metrics={headerMetrics}
          hint={quoteHint}
          marketStatus={contractMarketStatus}
          marketStatusText={contractMarketStatusText}
          tickerSource={tickerSource}
          tickerFreshness={tickerFreshness}
          marketSessionType={contractMarketSessionType}
          executable={contractExecutable}
          priceDirection={currentPriceDirection}
          priceSource={currentPriceSource}
          priceSourceLabel={currentPriceSourceLabel}
          symbolSelector={(
            <GlobalMarketSelector
              pageType="contract"
              placement="header"
              symbol={contractSymbol}
              interval={interval}
              symbols={toolbarPairSymbols.length ? toolbarPairSymbols : contractPairSymbols}
              symbolLabels={toolbarPairLabels}
              pairs={toolbarPairs}
              pairsLoading={contractPairsLoading}
              onPairQueryChange={handleToolbarPairQueryChange}
              onSymbolChange={(nextSymbol) => selectContractSymbol(nextSymbol)}
              onIntervalChange={handleContractIntervalChange}
            />
          )}
        />
        {(notice || error) ? (
          <div
            className={`mt-2 border px-3 py-2 text-sm ${
              error
                ? 'border-[#f6465d]/25 bg-[#f6465d]/10 text-[#f6465d]'
                : 'border-[#00c087]/25 bg-[#00c087]/10 text-[#00c087]'
            }`}
          >
            {error || notice}
          </div>
        ) : null}

        <div className="mt-2 grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,8.6fr)_minmax(240px,1.95fr)_minmax(260px,1.85fr)] xl:grid-rows-[minmax(max(540px,62vh),auto)_minmax(170px,auto)] xl:items-stretch">
          <div className="min-h-[420px] min-w-0 xl:col-start-1 xl:row-start-1 xl:min-h-0">
            <div className="flex h-full min-h-0 flex-col overflow-hidden border border-white/10 bg-[#12161c]">
              <div className="min-h-0 flex-1">
                <ContractTradingViewChart
                  symbol={contractSymbol}
                  category={currentContractKlineAssetClass}
                  displaySymbol={currentContractPair?.displaySymbol || marketSymbol}
                  interval={interval}
                  chartMode={chartMode}
                  intervalOptions={contractChartIntervalOptions}
                  onChartModeChange={setChartMode}
                  onIntervalChange={handleContractIntervalChange}
                  pricePrecision={pricePrecision}
                  amountPrecision={currentContractPair?.amountPrecision}
                  onLatestKlineCloseChange={handleLatestKlineCloseChange}
                />
              </div>
            </div>
          </div>

          <div className="min-h-0 min-w-0 xl:col-start-2 xl:row-start-1">
            <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden border border-white/10 bg-[#12161c]">
              <div className="shrink-0 border-b border-white/10 px-2.5">
                <div className="inline-flex h-10 items-stretch gap-5">
                  <button
                    type="button"
                    onClick={() => setRightPanelTab('orderbook')}
                    className={`relative px-0 text-[13px] font-medium leading-4 transition-colors ${
                      rightPanelTab === 'orderbook'
                        ? 'text-white after:absolute after:inset-x-0 after:bottom-[-1px] after:h-0.5 after:rounded-full after:bg-white'
                        : 'text-white/65 hover:text-white'
                    }`}
                  >
                    {t('orderBook', 'contracts')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setRightPanelTab('trades')}
                    className={`relative px-0 text-[13px] font-medium leading-4 transition-colors ${
                      rightPanelTab === 'trades'
                        ? 'text-white after:absolute after:inset-x-0 after:bottom-[-1px] after:h-0.5 after:rounded-full after:bg-white'
                        : 'text-white/65 hover:text-white'
                    }`}
                  >
                    {t('trades', 'contracts')}
                  </button>
                </div>
              </div>

              <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
                <div className={rightPanelTab === 'orderbook' ? 'block h-full min-h-0 min-w-0' : 'hidden h-full min-h-0 min-w-0'}>
                  <ContractFuturesOrderBook
                    priceDirection={currentPriceDirection}
                    pricePrecision={pricePrecision}
                    bids={depthBids}
                    asks={depthAsks}
                    status={depthStatus}
                    statusLabel={depthStatusLabel}
                    centerPrice={contractMarketState.displayPrice}
                    centerPriceReady={currentPriceReady}
                    centerPriceSource={contractMarketState.displayPriceSource}
                    centerPriceLabel={contractMarketState.displayPriceLabel}
                    bestBid={hookBestBid}
                    bestAsk={hookBestAsk}
                    spread={hookSpread}
                    marketView={activeContractMarketView}
                    depthMode={depthMode}
                    depthSource={depthSource}
                    depthFreshness={depthFreshness}
                    depthUpdatedAt={depthUpdatedAt}
                    loading={depthLoading}
                    error={depthError}
                    onPriceClick={(price) => setSelectedPriceState({ symbol: contractSymbol, price })}
                  />
                </div>

                <div className={rightPanelTab === 'trades' ? 'block h-full min-h-0 min-w-0' : 'hidden h-full min-h-0 min-w-0'}>
                  <ContractFuturesTrades
                    trades={recentTrades}
                    loading={tradesLoading}
                    error={tradesError}
                    status={contractMarketStatus}
                    source={tradesSource}
                    freshness={tradesFreshness}
                    pricePrecision={pricePrecision}
                    latestPriceDirection={latestTradeDirection}
                    onPriceClick={(price) => setSelectedPriceState({ symbol: contractSymbol, price })}
                  />
                </div>
              </div>
            </div>
          </div>

          <div className="flex min-h-[150px] min-w-0 flex-col overflow-visible border border-white/10 bg-[#12161c] xl:col-span-2 xl:col-start-1 xl:row-start-2 xl:min-h-0">
            <ContractPositionTabs
              currentSymbol={contractSymbol}
              scope={contractDataScope}
              positions={positions}
              positionsPageItems={positionsPageItems}
              positionSummaries={positionSummaries}
              activeOrders={activeOrders}
              orders={orders}
              trades={trades}
              quote={contractQuote}
              pricePrecision={pricePrecision}
              quantityUnit={quantityUnit}
              isLoggedIn={isLoggedIn}
              loading={privateLoading}
              isScopeSwitching={isScopeSwitching}
              isAllPositionsLoading={isAllPositionsLoading}
              isOrdersLoading={isOrdersLoading}
              isTradesLoading={isTradesLoading}
              realtimeStatus={realtimeStatus}
              positionsPagination={positionsPagination}
              activeOrdersPagination={activeOrdersPagination}
              orderHistoryPagination={orderHistoryPagination}
              tradeHistoryPagination={tradeHistoryPagination}
              activeOrdersFilters={activeOrdersFilters}
              orderHistoryFilters={orderHistoryFilters}
              tradeHistoryFilters={tradeHistoryFilters}
              onActiveOrdersFiltersChange={onActiveOrdersFiltersChange}
              onOrderHistoryFiltersChange={onOrderHistoryFiltersChange}
              onTradeHistoryFiltersChange={onTradeHistoryFiltersChange}
              onActiveTabChange={setContractUserTab}
              onSymbolSelect={(symbol) => selectContractSymbol(symbol)}
              onScopeChange={setContractDataScope}
              onSuccess={refreshPrivateSilently}
              tpSlTriggerPriceType={tpSlTriggerPriceType}
            />
          </div>

          <div className="min-h-[420px] min-w-0 xl:col-start-3 xl:row-start-1 xl:min-h-0">
            <div className="relative flex min-h-[420px] flex-col overflow-visible border border-white/10 bg-[#12161c] p-1.5 xl:min-h-[max(540px,62vh)] xl:p-2 [@media(max-height:850px)]:xl:min-h-0 [@media(max-height:850px)]:xl:p-1.5">
              <ContractTradingForm
                key={contractSymbol}
                symbol={contractSymbol}
                quote={contractQuote}
                marketView={activeContractMarketView}
                positions={openPositionsForTrading}
                positionSummaries={positionSummaries}
                selectedPrice={selectedPrice}
                bestBid={hookBestBid}
                bestAsk={hookBestAsk}
                executionBid={executionBid}
                executionAsk={executionAsk}
                executable={contractExecutable}
                reasonCode={reasonCode}
                pricePrecision={pricePrecision}
                quantityUnit={quantityUnit}
                maxLeverage={maxLeverage}
                availableMargin={account?.available_margin}
                isLoggedIn={isLoggedIn && !authLoading}
                disabled={!!contractAvailabilityError}
                quoteLoading={quoteStatusLoading}
                marketUiState={marketUiState}
                onSuccess={refreshPrivateSilently}
                tpSlTriggerPriceType={tpSlTriggerPriceType}
              />
            </div>
          </div>

          <div className="min-h-[150px] min-w-0 xl:col-start-3 xl:row-start-2 xl:min-h-0">
            <div className="flex h-full min-h-0 flex-col overflow-y-auto border border-white/10 bg-[#12161c]">
                <ContractAccountPanel
                  account={account}
                  isLoggedIn={isLoggedIn && !authLoading}
                  loading={privateLoading}
                  error={accountError}
                  onSuccess={refreshPrivateSilently}
                  onNotice={pushNotice}
                  onError={pushError}
                />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function ContractPage() {
  return (
    <Suspense fallback={null}>
      <ContractPageContent />
    </Suspense>
  );
}
