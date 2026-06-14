'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import ContractAccountPanel from '@/components/contract/ContractAccountPanel';
import ContractFuturesChart, {
  type ContractPositionOverlay,
  type PositionEntryOverlay,
  type PositionTpSlOverlay,
} from '@/components/contract/ContractFuturesChart';
import ContractFuturesOrderBook from '@/components/contract/ContractFuturesOrderBook';
import ContractFuturesTrades from '@/components/contract/ContractFuturesTrades';
import ContractMarketHeader, {
  type HeaderMetric,
} from '@/components/contract/ContractMarketHeader';
import ContractPositionTabs from '@/components/contract/ContractPositionTabs';
import ContractTradingForm from '@/components/contract/ContractTradingForm';
import { useContractMarketState } from '@/components/contract/hooks/useContractMarketState';
import { useContractUserState } from '@/components/contract/hooks/useContractUserState';
import GlobalMarketSelector, {
  type GlobalMarketSelectorPair,
  type PairQueryUpdate,
} from '@/components/spot/GlobalMarketSelector';
import { useAuth } from '@/lib/authContext';
import { useLocaleContext } from '@/contexts/LocaleContext';
import { toNumber } from '@/components/contract/contractFormat';
import { formatPrice } from '@/lib/marketPrecision';
import {
  getContractSymbols,
  getContractTickers,
  type ContractTickerItem,
  type ContractPositionItem,
  type ContractPositionSummaryItem,
  type ContractSymbolItem,
} from '@/lib/api/modules/contract';
import type { SpotMarketPairItem } from '@/lib/api/modules/spot';
import { isMockStockContractSymbol, toStockContractSymbol } from '@/lib/stockContracts';

type RightPanelTab = 'orderbook' | 'trades';
type ContractUrlCategory = 'usdt' | 'stock' | 'cfd' | '';
type ContractDataScope = 'current' | 'all';
type ContractTranslator = (key: string, namespace?: 'contracts') => string;

const DEFAULT_CONTRACT_SYMBOL = 'BTCUSDT_PERP';
const CFD_CONTRACT_CATEGORIES = new Set(['GOLD', 'FUTURES', 'INDEX', 'FOREX', 'METAL', 'COMMODITY']);

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

function getContractDisplayLabel(item: ContractSymbolItem, t: ContractTranslator) {
  const displayName = String(item.display_name || '').trim();
  if (displayName) return displayName;
  return `${contractSymbolToMarketSymbol(item.symbol)} ${t('perpetual', 'contracts')}`;
}

function getFallbackContractPair(contractSymbol: string, pricePrecision: number, t: ContractTranslator): GlobalMarketSelectorPair {
  const option = CONTRACT_SYMBOL_OPTIONS.find((item) => item.contractSymbol === contractSymbol);
  const marketSymbol = option?.marketSymbol || contractSymbolToMarketSymbol(contractSymbol);
  const label = `${marketSymbol} ${t('perpetual', 'contracts')}`;
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
  };
}

function normalizeTpSlTriggerPriceType(value: unknown): 'MARK_PRICE' | 'LAST_PRICE' {
  return String(value || '').trim().toUpperCase() === 'LAST_PRICE' ? 'LAST_PRICE' : 'MARK_PRICE';
}

function buildContractPairOption(item: ContractSymbolItem, t: ContractTranslator): GlobalMarketSelectorPair {
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
  };
}

function parseOptionalPrecision(value: unknown): number | null {
  const nextValue = Number(value);
  if (Number.isInteger(nextValue) && nextValue >= 0 && nextValue <= 12) {
    return nextValue;
  }
  return null;
}

function parsePositionOverlayPrice(value: unknown): number | null {
  const price = Number(value);
  return Number.isFinite(price) && price > 0 ? price : null;
}

function formatPercent(value: unknown) {
  const percent = Number(value);
  if (!Number.isFinite(percent)) return '--';
  return `${percent.toFixed(2)}%`;
}

function formatHeaderSpread(bestBid: string | null, bestAsk: string | null, pricePrecision: number) {
  const bid = toNumber(bestBid);
  const ask = toNumber(bestAsk);
  if (!bid || !ask || ask <= bid) return '--';
  return formatPrice(ask - bid, pricePrecision);
}

function pickDisplayPrice(...values: Array<string | number | null | undefined>) {
  for (const value of values) {
    const price = toNumber(value);
    if (price > 0) return String(value);
  }
  return null;
}

function getTickerChangePercent(ticker: ContractTickerItem | null) {
  return ticker?.price_change_percent_24h ?? ticker?.priceChangePercent ?? null;
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

function buildPositionOverlay(
  positionSummaries: ContractPositionSummaryItem[],
  contractSymbol: string,
): ContractPositionOverlay | null {
  const normalizedSymbol = String(contractSymbol || '').trim().toUpperCase();
  const summary = positionSummaries.find((item) => {
    const itemSymbol = String(item.symbol || '').trim().toUpperCase();
    return (
      (!itemSymbol || itemSymbol === normalizedSymbol) &&
      toNumber(item.quantity) > 0
    );
  });

  if (!summary) return null;

  const side = String(summary.side || '').trim().toUpperCase();
  if (side !== 'LONG' && side !== 'SHORT') return null;

  const record = summary as ContractPositionSummaryItem & {
    liq_price?: string | number | null;
  };

  return {
    side,
    liquidationPrice: parsePositionOverlayPrice(record.liquidation_price ?? record.liq_price),
  };
}

function buildPositionEntryOverlays(
  positions: ContractPositionItem[],
  contractSymbol: string,
): PositionEntryOverlay[] {
  const normalizedSymbol = String(contractSymbol || '').trim().toUpperCase();

  return positions
    .filter((position) => (
      position.status === 'OPEN' &&
      String(position.symbol || '').trim().toUpperCase() === normalizedSymbol
    ))
    .map((position, index): PositionEntryOverlay | null => {
      const record = position as ContractPositionItem & {
        open_price?: string | number | null;
      };
      const side = String(position.side || '').trim().toUpperCase();
      if (side !== 'LONG' && side !== 'SHORT') return null;
      const entryPrice = record.entry_price ?? record.open_price ?? null;

      return {
        id: position.id,
        index: index + 1,
        side,
        entryPrice: entryPrice === null ? null : String(entryPrice),
      };
    })
    .filter((position): position is PositionEntryOverlay => (
      !!position && toNumber(position.entryPrice) > 0
    ));
}

function buildPositionTpSlOverlays(
  positions: ContractPositionItem[],
  contractSymbol: string,
): PositionTpSlOverlay[] {
  const normalizedSymbol = String(contractSymbol || '').trim().toUpperCase();

  return positions
    .filter((position) => (
      position.status === 'OPEN' &&
      String(position.symbol || '').trim().toUpperCase() === normalizedSymbol
    ))
    .map((position, index): PositionTpSlOverlay | null => {
      const record = position as ContractPositionItem & {
        tp_price?: string | number | null;
        sl_price?: string | number | null;
      };
      const side = String(position.side || '').trim().toUpperCase();
      if (side !== 'LONG' && side !== 'SHORT') return null;
      const tpPrice = record.take_profit_price ?? record.tp_price ?? null;
      const slPrice = record.stop_loss_price ?? record.sl_price ?? null;

      return {
        id: position.id,
        index: index + 1,
        side,
        tpPrice: tpPrice === null ? null : String(tpPrice),
        slPrice: slPrice === null ? null : String(slPrice),
      };
    })
    .filter((position): position is PositionTpSlOverlay => (
      !!position &&
      (toNumber(position.tpPrice) > 0 || toNumber(position.slPrice) > 0)
    ));
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
    label: `${base}USDT ${t('perpetual', 'contracts')}`,
    displaySymbol: `${base}USDT ${t('perpetual', 'contracts')}`,
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
  const initialContractSymbol = initialUrlContractSymbol || DEFAULT_CONTRACT_SYMBOL;
  const { isLoggedIn, loading: authLoading } = useAuth();
  const [contractSymbol, setContractSymbol] = useState(() => initialContractSymbol);
  const [interval, setIntervalValue] = useState('1m');
  const [rightPanelTab, setRightPanelTab] = useState<RightPanelTab>('orderbook');
  const [contractDataScope, setContractDataScope] = useState<ContractDataScope>('current');
  const [selectedPrice, setSelectedPrice] = useState<string | null>(null);
  const [contractPairs, setContractPairs] = useState<GlobalMarketSelectorPair[]>(() => [
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
  const maxLeverage = currentContractPair?.maxLeverage || 200;
  const {
    marketSymbol,
    quantityUnit,
    priceDirection,
    latestMarketPrice,
    bestBid,
    bestAsk,
    midPrice,
    bestBidFromDepth,
    bestAskFromDepth,
    contractQuote,
    contractAvailabilityError,
    pricePrecision,
    quoteHint,
    initialDepth,
    applyLatestPrice,
    handleBestPricesChange,
    handleDepthDataChange,
  } = useContractMarketState({
    contractSymbol,
    symbolOptionMarketSymbol: symbolOption?.marketSymbol,
    symbolOptionPricePrecision: symbolOption?.pricePrecision,
  });
  const lastPrice = pickDisplayPrice(latestMarketPrice, contractQuote?.last_price, midPrice);
  const displayLastPrice = lastPrice ? formatPrice(lastPrice, pricePrecision) : '--';
  const isCryptoContract = isCryptoContractPair(currentContractPair) || (!!symbolOption && !currentContractPair);
  const contractMarketStatus = contractQuote?.market_status || contractTicker?.market_status || currentContractPair?.marketStatus || null;
  const contractMarketStatusText = contractQuote?.market_status_text || contractTicker?.market_status_text || currentContractPair?.marketStatusText || null;
  const contractQuoteFreshness = contractQuote?.quote_freshness || contractTicker?.quote_freshness || null;
  const contractMarketSessionType = contractQuote?.market_session_type || contractTicker?.market_session_type || currentContractPair?.marketSessionType || null;
  const tpSlTriggerPriceType = normalizeTpSlTriggerPriceType(currentContractPair?.tpSlTriggerPriceType);
  const headerMetrics = useMemo<HeaderMetric[]>(() => {
    const bidAsk = `${formatPrice(bestBid, pricePrecision)} / ${formatPrice(bestAsk, pricePrecision)}`;
    const spread = formatHeaderSpread(bestBid, bestAsk, pricePrecision);
    if (isCryptoContract) {
      return [
        { label: t('markPrice', 'contracts'), value: formatPrice(contractQuote?.mark_price, pricePrecision) },
        { label: t('indexPrice', 'contracts'), value: formatPrice(contractQuote?.index_price, pricePrecision) },
        { label: t('spread', 'contracts'), value: spread },
        { label: t('bestBidAsk', 'contracts'), value: bidAsk },
      ];
    }

    return [
      {
        label: t('markLatest', 'contracts'),
        value: formatPrice(contractQuote?.mark_price, pricePrecision),
        subValue: displayLastPrice,
      },
      { label: t('spread', 'contracts'), value: spread },
      { label: t('todayChange', 'contracts'), value: formatPercent(getTickerChangePercent(contractTicker)) },
      { label: t('bestBidAsk', 'contracts'), value: bidAsk },
    ];
  }, [
    bestAsk,
    bestBid,
    contractQuote?.index_price,
    contractQuote?.mark_price,
    contractTicker,
    displayLastPrice,
    isCryptoContract,
    pricePrecision,
    t,
  ]);

  const {
    account,
    positions,
    positionSummaries,
    orders,
    trades,
    privateLoading,
    isScopeSwitching,
    isAllPositionsLoading,
    isOrdersLoading,
    isTradesLoading,
    accountError,
    openPositionsForTrading,
    refreshPrivateSilently,
  } = useContractUserState({
    contractSymbol,
    dataScope: contractDataScope,
    isLoggedIn,
    onErrorChange: setError,
  });
  const positionOverlay = useMemo(
    () => buildPositionOverlay(positionSummaries, contractSymbol),
    [contractSymbol, positionSummaries],
  );
  const positionEntryOverlays = useMemo(
    () => buildPositionEntryOverlays(positions, contractSymbol),
    [contractSymbol, positions],
  );
  const positionTpSlOverlays = useMemo(
    () => buildPositionTpSlOverlays(positions, contractSymbol),
    [contractSymbol, positions],
  );
  const chartCurrentPrice = lastPrice;

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

  useEffect(() => {
    setSelectedPrice(null);
  }, [contractSymbol]);

  useEffect(() => {
    void refreshContractPairs();
  }, [refreshContractPairs]);

  useEffect(() => {
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

    setContractTicker(null);
    void refreshTicker();
    const timer = window.setInterval(() => {
      void refreshTicker();
    }, 5000);

    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [contractSymbol]);

  useEffect(() => {
    if (!contractPairsLoaded) return;
    const availableSymbols = new Set(contractPairs.map((item) => item.symbol));
    const requestedSymbol = urlContractSymbol;

    if (requestedSymbol && availableSymbols.has(requestedSymbol)) {
      if (contractSymbol !== requestedSymbol) {
        setContractSymbol(requestedSymbol);
      }
      return;
    }

    if (requestedSymbol && isMockStockContractSymbol(requestedSymbol)) {
      const mockPair: GlobalMarketSelectorPair = {
        symbol: requestedSymbol,
        label: `${contractSymbolToMarketSymbol(requestedSymbol)} ${t('perpetual', 'contracts')}`,
        displaySymbol: `${contractSymbolToMarketSymbol(requestedSymbol)} ${t('perpetual', 'contracts')}`,
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
    <div className="flex min-h-screen flex-col overflow-y-auto overflow-x-hidden bg-[#0b0e11] text-white">
      <ContractMarketHeader
        marketSymbol={marketSymbol}
        price={displayLastPrice}
        metrics={headerMetrics}
        hint={quoteHint}
        marketStatus={contractMarketStatus}
        marketStatusText={contractMarketStatusText}
        quoteFreshness={contractQuoteFreshness}
        marketSessionType={contractMarketSessionType}
        priceDirection={priceDirection}
      />

      <div className="w-full px-2 py-2 xl:px-3 xl:py-2">
        {(notice || error) ? (
          <div
            className={`mb-2 border px-3 py-2 text-sm ${
              error
                ? 'border-[#f6465d]/25 bg-[#f6465d]/10 text-[#f6465d]'
                : 'border-[#00c087]/25 bg-[#00c087]/10 text-[#00c087]'
            }`}
          >
            {error || notice}
          </div>
        ) : null}

        <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,10.55fr)_minmax(260px,1.85fr)] xl:items-start">
          <div className="min-w-0">
            <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,8.6fr)_minmax(240px,1.95fr)] xl:grid-rows-[minmax(540px,62vh)_auto]">
              <div className="min-w-0 min-h-0 xl:col-start-1 xl:row-start-1">
                <div className="flex h-full min-h-0 flex-col overflow-hidden border border-white/10 bg-[#12161c]">
                  <GlobalMarketSelector
                    pageType="contract"
                    symbol={contractSymbol}
                    interval={interval}
                    symbols={toolbarPairSymbols.length ? toolbarPairSymbols : contractPairSymbols}
                    symbolLabels={toolbarPairLabels}
                    pairs={toolbarPairs}
                    pairsLoading={contractPairsLoading}
                    onPairQueryChange={handleToolbarPairQueryChange}
                    onSymbolChange={(nextSymbol) => selectContractSymbol(nextSymbol)}
                    onIntervalChange={setIntervalValue}
                  />
                  <div className="min-h-0 flex-1">
                    <ContractFuturesChart
                      symbol={contractSymbol}
                      interval={interval}
                      marketStatus={contractMarketStatus}
                      latestPrice={chartCurrentPrice}
                      lastPrice={lastPrice}
                      midPrice={midPrice}
                      positionOverlay={positionOverlay}
                      positionEntryOverlays={positionEntryOverlays}
                      positionTpSlOverlays={positionTpSlOverlays}
                    />
                  </div>
                </div>
              </div>

              <div className="min-w-0 min-h-0 xl:col-start-2 xl:row-start-1">
                <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden border border-white/10 bg-[#12161c]">
                  <div className="shrink-0 border-b border-white/10 px-2.5 py-2">
                    <div className="inline-flex rounded-md bg-[#0b0e11] p-1">
                      <button
                        type="button"
                        onClick={() => setRightPanelTab('orderbook')}
                        className={`rounded px-3 py-1.5 text-sm transition-colors ${
                          rightPanelTab === 'orderbook'
                            ? 'bg-white text-black'
                            : 'text-white/65 hover:text-white'
                        }`}
                      >
                        {t('orderBook', 'contracts')}
                      </button>
                      <button
                        type="button"
                        onClick={() => setRightPanelTab('trades')}
                        className={`rounded px-3 py-1.5 text-sm transition-colors ${
                          rightPanelTab === 'trades'
                            ? 'bg-white text-black'
                            : 'text-white/65 hover:text-white'
                        }`}
                      >
                        {t('trades', 'contracts')}
                      </button>
                    </div>
                  </div>

                  <div className="relative flex-1 min-h-0 min-w-0 overflow-hidden">
                    <div className={rightPanelTab === 'orderbook' ? 'block h-full min-h-0 min-w-0' : 'hidden h-full min-h-0 min-w-0'}>
                      <ContractFuturesOrderBook
                        symbol={contractSymbol}
                        lastPrice={displayLastPrice}
                        priceDirection={priceDirection}
                        pricePrecision={pricePrecision}
                        marketStatus={contractMarketStatus}
                        initialDepth={initialDepth}
                        onPriceSelect={setSelectedPrice}
                        onBestPricesChange={handleBestPricesChange}
                        onDepthDataChange={handleDepthDataChange}
                      />
                    </div>

                    <div className={rightPanelTab === 'trades' ? 'block h-full min-h-0 min-w-0' : 'hidden h-full min-h-0 min-w-0'}>
                      <ContractFuturesTrades
                        symbol={contractSymbol}
                        pricePrecision={pricePrecision}
                        latestPriceDirection={priceDirection}
                        marketStatus={contractMarketStatus}
                        onPriceSelect={setSelectedPrice}
                        onLastPriceChange={applyLatestPrice}
                      />
                    </div>
                  </div>
                </div>
              </div>

              <div className="min-w-0 min-h-0 overflow-visible border border-white/10 bg-[#12161c] xl:col-span-2 xl:col-start-1 xl:row-start-2">
                <ContractPositionTabs
                  currentSymbol={contractSymbol}
                  scope={contractDataScope}
                  positions={positions}
                  positionSummaries={positionSummaries}
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
                  onSymbolSelect={(symbol) => selectContractSymbol(symbol)}
                  onScopeChange={setContractDataScope}
                  onSuccess={refreshPrivateSilently}
                  tpSlTriggerPriceType={tpSlTriggerPriceType}
                />
              </div>
            </div>
          </div>

          <div className="min-w-0 xl:self-start">
            <div className="flex flex-col gap-2 overflow-visible">
              <div className="relative shrink-0 border border-white/10 bg-[#12161c] p-1.5">
                <ContractTradingForm
                  symbol={contractSymbol}
                  quote={contractQuote}
                  positions={openPositionsForTrading}
                  positionSummaries={positionSummaries}
                  selectedPrice={selectedPrice}
                  bestBid={bestBidFromDepth}
                  bestAsk={bestAskFromDepth}
                  pricePrecision={pricePrecision}
                  quantityUnit={quantityUnit}
                  maxLeverage={maxLeverage}
                  availableMargin={account?.available_margin}
                  isLoggedIn={isLoggedIn && !authLoading}
                  disabled={!!contractAvailabilityError || !contractQuote}
                  onSuccess={refreshPrivateSilently}
                  tpSlTriggerPriceType={tpSlTriggerPriceType}
                />
              </div>

              <div className="shrink-0 overflow-visible border border-white/10 bg-[#12161c]">
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
