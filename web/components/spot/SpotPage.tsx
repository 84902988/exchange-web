'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useLocaleContext } from '@/contexts/LocaleContext';
import SpotHeader from './SpotHeader';
import SpotTradingViewChart from './SpotTradingViewChart';
import GlobalMarketSelector from './GlobalMarketSelector';
import SpotOrderBook from './SpotOrderBook';
import SpotTradesHistory from './SpotTradesHistory';
import SpotTradingForm from './SpotTradingForm';
import SpotAssetInfo from './SpotAssetInfo';
import SpotOrderTabs from './SpotOrderTabs';
import { useAuth } from '@/lib/authContext';
import {
  getSpotAccountBalances,
  getSpotMarketPairs,
  getSpotMarketTickers,
  normalizeSpotDataSource,
  type SpotAccountBalanceItem,
  type SpotMarketPairItem,
  type SpotMarketTickerItem,
  type SpotMarketView,
} from '@/lib/api/modules/spot';
import {
  DEFAULT_PRICE_PRECISION,
  formatPrice,
  formatRawPrice,
  getSpotSymbolPricePrecision,
} from '@/lib/marketPrecision';
import { formatSpotDisplaySymbol } from './spotFormat';
import { useSpotMarket } from './useSpotMarket';

interface SpotHeaderMarketData {
  change: string;
  changeAmount: string;
  highLow: string;
  volume: string;
  turnover: string;
}

const EMPTY_MARKET_DATA: SpotHeaderMarketData = {
  change: '--',
  changeAmount: '--',
  highLow: '-- / --',
  volume: '--',
  turnover: '--',
};
const DEFAULT_SPOT_SYMBOL = 'BTCUSDT';
const SPOT_PAIR_PAGE_SIZE = 6;
type SpotPairQuery = {
  marketType: 'spot' | 'contract' | 'all';
  category: string;
  quote: string;
  keyword: string;
};
const cachedSpotPairPages = new Map<string, { items: SpotPairOption[]; total: number }>();

function getInitialPairQuery(category?: string): SpotPairQuery {
  const normalizedCategory = String(category || '').trim().toLowerCase();
  return {
    marketType: 'spot',
    category: normalizedCategory === 'rwa' ? normalizedCategory : 'all',
    quote: 'all',
    keyword: '',
  };
}

function getPairQueryKey(query: SpotPairQuery): string {
  return [
    query.marketType,
    query.category || 'all',
    query.quote || 'all',
    query.keyword || '',
  ].join('|');
}

function formatPriceBySymbol(symbol: string, value: string, precision?: number | null): string {
  if (!value || value === '--') return '';
  const num = Number(value);
  if (!Number.isFinite(num)) return '';
  return formatPrice(num, precision ?? getSpotSymbolPricePrecision(symbol) ?? DEFAULT_PRICE_PRECISION);
}

function formatOrderInputPriceBySymbol(symbol: string, value: string, precision?: number | null): string {
  if (!value || value === '--') return '';
  const normalizedValue = String(value).replace(/,/g, '');
  const num = Number(normalizedValue);
  if (!Number.isFinite(num)) return '';
  return formatRawPrice(num, precision ?? getSpotSymbolPricePrecision(symbol) ?? DEFAULT_PRICE_PRECISION);
}

function formatSignedPercent(value: number): string {
  if (!Number.isFinite(value)) return '--';
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
}

function formatSignedPrice(value: number, precision: number): string {
  if (!Number.isFinite(value)) return '--';
  return `${value >= 0 ? '+' : ''}${value.toFixed(precision)}`;
}

function formatCompactMetric(value: string | number | null | undefined): string {
  const num = Number(value);
  if (!Number.isFinite(num)) return '--';

  const abs = Math.abs(num);
  if (abs >= 1_000_000_000) return `${(num / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${(num / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(num / 1_000).toFixed(2)}K`;

  return num.toLocaleString('en-US', {
    maximumFractionDigits: 2,
  });
}

function parseOptionalPrecision(value: unknown): number | null {
  const nextValue = Number(value);
  if (Number.isInteger(nextValue) && nextValue >= 0 && nextValue <= 12) {
    return nextValue;
  }
  return null;
}

function resolveSpotPricePrecision(
  symbol: string,
  configuredPrecision?: number | null,
  pairPrecision?: number | null,
): number {
  const configured = parseOptionalPrecision(configuredPrecision);
  if (configured !== null) {
    return configured;
  }

  const pair = parseOptionalPrecision(pairPrecision);
  if (pair !== null) {
    return pair;
  }

  return getSpotSymbolPricePrecision(symbol) ?? DEFAULT_PRICE_PRECISION;
}

type RightPanelTab = 'orderbook' | 'trades';
type SpotChartMode = 'time' | 'candle';

type SpotPageProps = {
  initialSymbol?: string;
  initialCategory?: string;
};

type SpotPairOption = {
  symbol: string;
  label: string;
  assetType?: string | null;
  dataSource?: string | null;
  marketMode?: string | null;
  marketCategory?: string | null;
  marketSubCategory?: string | null;
  displayCategory?: string | null;
  displayGroup?: string | null;
  baseAsset?: string | null;
  quoteAsset?: string | null;
  displaySymbol?: string | null;
  price?: string | number | null;
  change24h?: string | number | null;
  percentChange24h?: string | number | null;
  priceChangePercent?: string | number | null;
  priceChange24h?: string | number | null;
  open24h?: string | number | null;
  high24h?: string | number | null;
  low24h?: string | number | null;
  volume24h?: string | number | null;
  baseVolume24h?: string | number | null;
  quoteVolume24h?: string | number | null;
  pricePrecision?: number | null;
  amountPrecision?: number | null;
  marketStatus?: string | null;
  marketStatusText?: string | null;
  marketSessionType?: string | null;
  quoteFreshness?: string | null;
  showSpotLogo?: boolean;
  spotLogoUrl?: string | null;
};

function normalizeSpotApiSymbol(value?: string | null): string {
  return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '');
}

function normalizeSpotSymbolKey(value?: string | null): string {
  return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function findSpotPairBySymbol(pairs: SpotPairOption[], value?: string | null): SpotPairOption | null {
  const symbolValue = normalizeSpotApiSymbol(value);
  if (!symbolValue) return null;
  const exact = pairs.find((item) => normalizeSpotApiSymbol(item.symbol) === symbolValue);
  if (exact) return exact;
  const symbolKey = normalizeSpotSymbolKey(symbolValue);
  return pairs.find((item) => normalizeSpotSymbolKey(item.symbol) === symbolKey) || null;
}

function resolveSpotAssetSymbols(
  symbol: string,
  pair?: Pick<SpotPairOption, 'baseAsset' | 'quoteAsset'> | null,
): { baseAsset: string; quoteAsset: string } {
  const pairBase = String(pair?.baseAsset || '').trim().toUpperCase();
  const pairQuote = String(pair?.quoteAsset || '').trim().toUpperCase();
  if (pairBase || pairQuote) {
    return { baseAsset: pairBase, quoteAsset: pairQuote };
  }

  const upperSymbol = normalizeSpotApiSymbol(symbol);
  const quoteCandidates = ['USDT', 'USDC', 'BUSD', 'FDUSD', 'BTC', 'ETH'];
  for (const quoteAsset of quoteCandidates) {
    if (upperSymbol.endsWith(quoteAsset) && upperSymbol.length > quoteAsset.length) {
      return {
        baseAsset: upperSymbol.slice(0, -quoteAsset.length),
        quoteAsset,
      };
    }
  }

  return { baseAsset: upperSymbol, quoteAsset: '' };
}

function getTickerPrice(item: SpotMarketTickerItem): string | number | null {
  return item.last_price ?? item.price ?? item.last ?? item.close ?? null;
}

function getTickerChangePercent(item: SpotMarketTickerItem): string | number | null {
  const record = item as SpotMarketTickerItem & {
    change_percent_24h?: string | number | null;
    changePercent24h?: string | number | null;
    changePercent?: string | number | null;
    change_percent?: string | number | null;
    percent_change_24h?: string | number | null;
    priceChangePercent?: string | number | null;
    price_change_percent?: string | number | null;
  };

  return (
    record.price_change_percent_24h ??
    record.price_change_percent ??
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

function buildMarketDataFromMarketView(
  symbol: string,
  view: SpotMarketView | null,
  pricePrecision: number,
): SpotHeaderMarketData | null {
  if (!view) return null;

  const ticker = view.ticker;
  const changePercent = Number(
    view.ticker_24h_change_percent ??
    ticker?.price_change_percent_24h ??
    ticker?.price_change_percent ??
    ticker?.change_24h,
  );
  const changeAmount = Number(view.ticker_24h_change ?? ticker?.price_change_24h);
  const high = Number(view.ticker_24h_high ?? ticker?.high_24h);
  const low = Number(view.ticker_24h_low ?? ticker?.low_24h);

  return {
    change: Number.isFinite(changePercent) ? formatSignedPercent(changePercent) : '--',
    changeAmount: Number.isFinite(changeAmount)
      ? formatSignedPrice(changeAmount, pricePrecision)
      : '--',
    highLow:
      Number.isFinite(high) && Number.isFinite(low)
        ? `${formatPriceBySymbol(symbol, String(high), pricePrecision)} / ${formatPriceBySymbol(symbol, String(low), pricePrecision)}`
        : '-- / --',
    volume: formatCompactMetric(view.ticker_volume ?? ticker?.base_volume_24h ?? ticker?.volume_24h),
    turnover: formatCompactMetric(view.ticker_quote_volume ?? ticker?.quote_volume_24h),
  };
}

function buildSpotPairOption(item: SpotMarketTickerItem | SpotMarketPairItem): SpotPairOption | null {
  const symbol = String(item.symbol || '').trim().toUpperCase();
  if (!symbol) return null;

  return {
    symbol,
    label: String(item.display_symbol || '').trim() || formatSpotDisplaySymbol(symbol),
    displaySymbol: item.display_symbol,
    baseAsset: item.base_asset,
    quoteAsset: item.quote_asset,
    assetType: item.asset_type,
    dataSource: item.data_source,
    marketMode: item.market_mode,
    marketCategory: item.market_category,
    marketSubCategory: item.market_sub_category,
    displayCategory: item.display_category,
    displayGroup: String(item.display_group || '').trim() || null,
    price: getTickerPrice(item),
    change24h: getTickerChangePercent(item),
    percentChange24h: (item as SpotMarketTickerItem & { percent_change_24h?: string | number | null }).percent_change_24h,
    priceChangePercent: (item as SpotMarketTickerItem & { priceChangePercent?: string | number | null }).priceChangePercent,
    priceChange24h: (item as SpotMarketTickerItem).price_change_24h,
    open24h: (item as SpotMarketTickerItem & { open_24h?: string | number | null }).open_24h ??
      (item as SpotMarketTickerItem & { open24h?: string | number | null }).open24h,
    high24h: (item as SpotMarketTickerItem).high_24h,
    low24h: (item as SpotMarketTickerItem).low_24h,
    volume24h: (item as SpotMarketTickerItem).volume_24h,
    baseVolume24h: (item as SpotMarketTickerItem).base_volume_24h ?? (item as SpotMarketTickerItem).volume_24h,
    quoteVolume24h: (item as SpotMarketTickerItem).quote_volume_24h,
    pricePrecision: parseOptionalPrecision(item.price_precision),
    amountPrecision: parseOptionalPrecision(item.amount_precision),
    marketStatus: (item as SpotMarketTickerItem).market_status,
    marketStatusText: (item as SpotMarketTickerItem).market_status_text,
    marketSessionType: (item as SpotMarketTickerItem).market_session_type,
    quoteFreshness: (item as SpotMarketTickerItem).quote_freshness,
    showSpotLogo: parseBooleanFlag((item as SpotMarketTickerItem | SpotMarketPairItem).show_spot_logo),
    spotLogoUrl: String((item as SpotMarketTickerItem | SpotMarketPairItem).spot_logo_url || '').trim() || null,
  };
}

function normalizePairValue(value?: string | number | null): string {
  return String(value ?? '').trim().toUpperCase();
}

function parseBooleanFlag(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1;
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());
}

function isSpotLogoEligiblePair(pair: SpotPairOption | null | undefined): boolean {
  if (!pair?.showSpotLogo || !pair.spotLogoUrl) return false;

  const eligibleValues = new Set(['STOCK', 'RWA', 'STOCK_TOKEN']);
  return [
    pair.assetType,
    pair.marketCategory,
    pair.marketSubCategory,
    pair.displayCategory,
  ].some((value) => eligibleValues.has(normalizePairValue(value)));
}

function SpotLogoCard({
  symbol,
  pair,
}: {
  symbol: string;
  pair: SpotPairOption | null;
}) {
  const logoUrl = String(pair?.spotLogoUrl || '').trim();
  const [failedUrl, setFailedUrl] = useState('');
  const shouldShow = isSpotLogoEligiblePair(pair) && logoUrl && failedUrl !== logoUrl;

  if (!shouldShow) {
    return null;
  }

  return (
    <div className="spot-pair-logo-inline relative ml-3 hidden h-10 min-w-0 w-[clamp(120px,18vw,360px)] flex-[0_1_auto] items-center justify-start overflow-visible lg:flex">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={logoUrl}
        alt={symbol}
        className="absolute left-0 top-1/2 block h-[clamp(40px,4.6vw,72px)] w-full -translate-y-1/2 object-contain object-left"
        onError={() => setFailedUrl(logoUrl)}
      />
    </div>
  );
}

function pairMatchesInitialCategory(pair: SpotPairOption, category?: string): boolean {
  const normalizedCategory = String(category || '').trim().toLowerCase();
  if (normalizedCategory === 'stock') {
    return false;
  }

  if (normalizedCategory === 'rwa') {
    return normalizePairValue(pair.displayCategory) === 'RWA';
  }

  return false;
}

function getToolbarInitialCategory(category?: string): 'rwa' | undefined {
  const normalizedCategory = String(category || '').trim().toLowerCase();
  if (normalizedCategory === 'rwa') return 'rwa';
  return undefined;
}

export default function SpotPage({ initialSymbol, initialCategory }: SpotPageProps) {
  const router = useRouter();
  const { t } = useLocaleContext();
  const { user, isLoggedIn, loading: authLoading, authChecked } = useAuth();
  const hasInitialSymbol = Boolean(String(initialSymbol || '').trim());
  const initialSpotSymbol = normalizeSpotApiSymbol(initialSymbol || DEFAULT_SPOT_SYMBOL) || DEFAULT_SPOT_SYMBOL;
  const [symbol, setSymbol] = useState(initialSpotSymbol);
  const spotMarket = useSpotMarket(symbol);
  const symbolRef = useRef(symbol);
  const appliedCategoryRef = useRef('');
  const [interval, setIntervalValue] = useState('1m');
  const [chartMode, setChartMode] = useState<SpotChartMode>('candle');
  const [orderPrice, setOrderPrice] = useState('');
  const [orderPriceSelectNonce, setOrderPriceSelectNonce] = useState(0);

  const [refreshKey, setRefreshKey] = useState(0);
  const [accountBalances, setAccountBalances] = useState<SpotAccountBalanceItem[]>([]);
  const [balancesLoading, setBalancesLoading] = useState(false);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [rightPanelTab, setRightPanelTab] = useState<RightPanelTab>('orderbook');
  const accountBalancesLoadedRef = useRef(false);
  const [configuredPricePrecision, setConfiguredPricePrecision] = useState<number | null>(null);
  const [pairQuery, setPairQuery] = useState<SpotPairQuery>(() => getInitialPairQuery(initialCategory));
  const initialPairCache = cachedSpotPairPages.get(getPairQueryKey(getInitialPairQuery(initialCategory)));
  const [pairOptions, setPairOptions] = useState<SpotPairOption[]>(initialPairCache?.items || []);
  const [pairOptionsQueryKey, setPairOptionsQueryKey] = useState(
    initialPairCache ? getPairQueryKey(getInitialPairQuery(initialCategory)) : '',
  );
  const [pairTotal, setPairTotal] = useState(initialPairCache?.total || 0);
  const [pairPage, setPairPage] = useState(initialPairCache?.items.length ? 1 : 0);
  const [pairOptionsLoading, setPairOptionsLoading] = useState(!initialPairCache);
  const [pairOptionsLoadingMore, setPairOptionsLoadingMore] = useState(false);
  const pairOptionsRef = useRef<SpotPairOption[]>([]);
  const pairQueryRef = useRef(pairQuery);
  const pairRequestIdRef = useRef(0);
  const [headerTicker, setHeaderTicker] = useState<SpotPairOption | null>(null);
  const selectedPairPrecision = useMemo(() => {
    const normalizedSymbol = normalizeSpotApiSymbol(symbol);
    const viewPrecision = parseOptionalPrecision(spotMarket.marketView?.price_precision);
    if (viewPrecision !== null) {
      return viewPrecision;
    }
    if (headerTicker && normalizeSpotApiSymbol(headerTicker.symbol) === normalizedSymbol) {
      return headerTicker.pricePrecision ?? null;
    }
    return findSpotPairBySymbol(pairOptions, normalizedSymbol)?.pricePrecision ?? null;
  }, [headerTicker, pairOptions, spotMarket.marketView?.price_precision, symbol]);
  const currentAmountPrecision = useMemo(() => {
    const normalizedSymbol = normalizeSpotApiSymbol(symbol);
    const viewPrecision = parseOptionalPrecision(spotMarket.marketView?.amount_precision);
    if (viewPrecision !== null) {
      return viewPrecision;
    }
    const depthPrecision = parseOptionalPrecision(spotMarket.depth?.amount_precision);
    if (depthPrecision !== null) {
      return depthPrecision;
    }
    if (headerTicker && normalizeSpotApiSymbol(headerTicker.symbol) === normalizedSymbol) {
      return headerTicker.amountPrecision ?? null;
    }
    return findSpotPairBySymbol(pairOptions, normalizedSymbol)?.amountPrecision ?? null;
  }, [headerTicker, pairOptions, spotMarket.depth?.amount_precision, spotMarket.marketView?.amount_precision, symbol]);
  const pricePrecision =
    resolveSpotPricePrecision(symbol, configuredPricePrecision, selectedPairPrecision);

  const toolbarPairs = useMemo(() => pairOptions, [pairOptions]);
  const toolbarSymbols = useMemo(
    () => toolbarPairs.map((item) => item.symbol),
    [toolbarPairs],
  );
  const symbolLabels = useMemo(
    () =>
      Object.fromEntries(
        toolbarPairs.map((item) => [item.symbol, item.label]),
      ) as Record<string, string>,
    [toolbarPairs],
  );
  const selectedPair = useMemo(() => findSpotPairBySymbol(pairOptions, symbol), [pairOptions, symbol]);
  const selectedTicker = useMemo(() => {
    const normalizedSymbol = normalizeSpotApiSymbol(symbol);
    if (normalizeSpotApiSymbol(headerTicker?.symbol) === normalizedSymbol) {
      return headerTicker;
    }
    return selectedPair;
  }, [headerTicker, selectedPair, symbol]);
  const spotAssetSymbols = useMemo(
    () => resolveSpotAssetSymbols(symbol, selectedTicker || selectedPair),
    [selectedPair, selectedTicker, symbol],
  );
  const selectedDataSourceKnown = Boolean(selectedTicker?.dataSource || selectedPair?.dataSource);
  const selectedDataSource = normalizeSpotDataSource(selectedTicker?.dataSource || selectedPair?.dataSource);
  const marketFeedDataSource = selectedDataSourceKnown ? selectedDataSource : 'external';
  const showRwaReference = useMemo(() => {
    return selectedTicker ? pairMatchesInitialCategory(selectedTicker, 'rwa') : false;
  }, [selectedTicker]);

  useEffect(() => {
    if (!selectedPair?.symbol || selectedPair.symbol === symbol) {
      return;
    }
    if (normalizeSpotSymbolKey(selectedPair.symbol) !== normalizeSpotSymbolKey(symbol)) {
      return;
    }
    setSymbol(selectedPair.symbol);
    router.replace(`/trade/spot?symbol=${encodeURIComponent(selectedPair.symbol)}`);
  }, [router, selectedPair?.symbol, symbol]);

  useEffect(() => {
    symbolRef.current = symbol;
  }, [symbol]);

  useEffect(() => {
    pairOptionsRef.current = pairOptions;
  }, [pairOptions]);

  useEffect(() => {
    pairQueryRef.current = pairQuery;
  }, [pairQuery]);

  useEffect(() => {
    setOrderPrice('');
    setConfiguredPricePrecision(null);
  }, [symbol]);

  useEffect(() => {
    const nextPricePrecision =
      parseOptionalPrecision(spotMarket.marketView?.price_precision) ??
      parseOptionalPrecision(spotMarket.depth?.price_precision);
    if (nextPricePrecision !== null) {
      setConfiguredPricePrecision(nextPricePrecision);
    }
  }, [spotMarket.depth?.price_precision, spotMarket.marketView?.price_precision]);

  useEffect(() => {
    const nextSymbol = normalizeSpotApiSymbol(initialSymbol);
    if (nextSymbol) {
      if (nextSymbol !== symbolRef.current) {
        setSymbol(nextSymbol);
      }
      return;
    }
  }, [initialCategory, initialSymbol]);

  useEffect(() => {
    appliedCategoryRef.current = '';
    setPairQuery(getInitialPairQuery(initialCategory));
  }, [initialCategory]);

  const hydratePairTickers = useCallback(async (pairs: SpotPairOption[], queryKey: string) => {
    const symbols = pairs.map((item) => item.symbol).filter(Boolean);
    if (!symbols.length) return;

    try {
      const tickers = await getSpotMarketTickers(symbols);
      const tickerMap = new Map<string, SpotPairOption>();
      for (const ticker of tickers) {
        const option = buildSpotPairOption(ticker);
        if (option) {
          tickerMap.set(option.symbol, option);
        }
      }

      if (getPairQueryKey(pairQueryRef.current) !== queryKey) {
        return;
      }

      setPairOptions((prev) =>
        prev.map((pair) => {
          const ticker = tickerMap.get(pair.symbol);
          return ticker ? { ...pair, ...ticker } : pair;
        }),
      );
    } catch (error) {
      console.error('SpotPage visible ticker load error:', error);
    }
  }, []);

  const loadPairPage = useCallback(
    async (query: SpotPairQuery, page: number, append = false) => {
      const queryKey = getPairQueryKey(query);
      const requestId = ++pairRequestIdRef.current;

      if (!append) {
        const cachedPage = cachedSpotPairPages.get(queryKey);
        if (cachedPage) {
          setPairOptions(cachedPage.items);
          setPairOptionsQueryKey(queryKey);
          setPairTotal(cachedPage.total);
          setPairPage(1);
          setPairOptionsLoading(false);
          void hydratePairTickers(cachedPage.items, queryKey);
        } else {
          setPairOptions([]);
          setPairOptionsQueryKey('');
          setPairTotal(0);
          setPairPage(0);
          setPairOptionsLoading(true);
        }
      } else {
        setPairOptionsLoadingMore(true);
      }

      try {
        const response = await getSpotMarketPairs({
          marketType: query.marketType,
          category: query.category,
          quote: query.quote,
          keyword: query.keyword,
          page,
          pageSize: SPOT_PAIR_PAGE_SIZE,
        });

        if (requestId !== pairRequestIdRef.current || getPairQueryKey(pairQueryRef.current) !== queryKey) {
          return;
        }

        const nextPairs = response.items
          .map(buildSpotPairOption)
          .filter((item): item is SpotPairOption => Boolean(item));

        let mergedPairs = nextPairs;
        if (append) {
          const map = new Map(pairOptionsRef.current.map((item) => [item.symbol, item]));
          for (const pair of nextPairs) {
            map.set(pair.symbol, pair);
          }
          mergedPairs = Array.from(map.values());
        }

        setPairOptions(mergedPairs);
        setPairOptionsQueryKey(queryKey);
        setPairTotal(response.total);
        setPairPage(response.page);
        if (!append) {
          cachedSpotPairPages.set(queryKey, {
            items: mergedPairs,
            total: response.total,
          });
        }

      const currentSymbol = normalizeSpotApiSymbol(symbolRef.current);
        const currentPair = mergedPairs.find((item) => item.symbol === currentSymbol);
        if (currentPair) {
          setHeaderTicker((prev) => (prev?.symbol === currentSymbol ? { ...currentPair, ...prev } : currentPair));
        }

        void hydratePairTickers(nextPairs, queryKey);
      } catch (error) {
        if (requestId === pairRequestIdRef.current) {
          console.error('SpotPage pair list load error:', error);
          if (!append && !cachedSpotPairPages.has(queryKey)) {
            setPairOptions([]);
          }
        }
      } finally {
        if (requestId === pairRequestIdRef.current) {
          setPairOptionsLoading(false);
          setPairOptionsLoadingMore(false);
        }
      }
    },
    [hydratePairTickers],
  );

  useEffect(() => {
    void loadPairPage(pairQuery, 1, false);
  }, [loadPairPage, pairQuery]);

  useEffect(() => {
    const currentSymbol = normalizeSpotApiSymbol(symbol);
    if (!currentSymbol) {
      setHeaderTicker(null);
      return;
    }

    const nextTicker = spotMarket.marketView?.ticker
      ? buildSpotPairOption(spotMarket.marketView.ticker)
      : null;

    if (!nextTicker || nextTicker.symbol !== currentSymbol) {
      const cachedPair = pairOptionsRef.current.find((item) => item.symbol === currentSymbol);
      setHeaderTicker(cachedPair || null);
      return;
    }

    setHeaderTicker(nextTicker);
    setPairOptions((prev) => {
      const map = new Map(prev.map((item) => [item.symbol, item]));
      if (map.has(nextTicker.symbol)) {
        map.set(nextTicker.symbol, { ...map.get(nextTicker.symbol), ...nextTicker });
      }
      return Array.from(map.values());
    });
  }, [spotMarket.marketView?.ticker, symbol]);

  useEffect(() => {
    const category = String(initialCategory || '').trim().toLowerCase();
    const categoryQueryKey = getPairQueryKey(getInitialPairQuery(category));
    if (
      hasInitialSymbol ||
      category !== 'rwa' ||
      pairOptionsQueryKey !== categoryQueryKey ||
      appliedCategoryRef.current === category ||
      pairOptions.length === 0
    ) {
      return;
    }

    appliedCategoryRef.current = category;

    const matchedPair = pairOptions.find((pair) => pairMatchesInitialCategory(pair, category)) || pairOptions[0];
    if (!matchedPair) {
      return;
    }

    if (matchedPair.symbol !== symbol) {
      setSymbol(matchedPair.symbol);
    }
    router.replace(`/trade/spot?category=${encodeURIComponent(category)}&symbol=${encodeURIComponent(matchedPair.symbol)}`);
  }, [hasInitialSymbol, initialCategory, pairOptions, pairOptionsQueryKey, router, symbol]);

  const loadAccountBalances = useCallback(async (options?: { silent?: boolean }) => {
    if (!isLoggedIn) {
      accountBalancesLoadedRef.current = false;
      setAccountBalances([]);
      return;
    }

    const shouldShowLoading = !options?.silent && !accountBalancesLoadedRef.current;

    try {
      if (shouldShowLoading) {
        setBalancesLoading(true);
      }
      const data = await getSpotAccountBalances();
      setAccountBalances(data);
      accountBalancesLoadedRef.current = true;
    } catch (error) {
      console.error('SpotPage account balances load error:', error);
    } finally {
      if (shouldShowLoading) {
        setBalancesLoading(false);
      }
    }
  }, [isLoggedIn]);

  useEffect(() => {
    loadAccountBalances();
  }, [loadAccountBalances, refreshKey]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (balancesLoading || ordersLoading) {
        return;
      }

      setRefreshKey((v) => v + 1);
    }, 3000);

    return () => {
      window.clearInterval(timer);
    };
  }, [balancesLoading, ordersLoading]);

  const handleOrderBookPriceClick = useCallback(
    (price: string) => {
      const orderInputPrice = formatOrderInputPriceBySymbol(symbol, price, pricePrecision);
      if (!orderInputPrice) {
        return;
      }
      setOrderPrice(orderInputPrice);
      setOrderPriceSelectNonce((value) => value + 1);
    },
    [pricePrecision, symbol]
  );

  const handleSymbolChange = useCallback(
    (value: string) => {
    const nextSymbol = normalizeSpotApiSymbol(value);
      if (!nextSymbol || nextSymbol === symbol) {
        return;
      }

      setSymbol(nextSymbol);
      router.push(`/trade/spot?symbol=${encodeURIComponent(nextSymbol)}`);
    },
    [router, symbol],
  );

  const handlePairQueryChange = useCallback((nextQuery: SpotPairQuery) => {
    setPairQuery((prev) => {
      if (getPairQueryKey(prev) === getPairQueryKey(nextQuery)) {
        return prev;
      }
      return nextQuery;
    });
  }, []);

  const handleLoadMorePairs = useCallback(() => {
    if (pairOptionsLoading || pairOptionsLoadingMore) {
      return;
    }
    if (pairOptions.length >= pairTotal) {
      return;
    }
    void loadPairPage(pairQueryRef.current, pairPage + 1, true);
  }, [loadPairPage, pairOptions.length, pairOptionsLoading, pairOptionsLoadingMore, pairPage, pairTotal]);

  const handleOrderSuccess = useCallback(() => {
    setRefreshKey((v) => v + 1);
    void loadAccountBalances({ silent: true });
  }, [loadAccountBalances]);

  const handleOrdersChanged = useCallback(() => {
    setRefreshKey((v) => v + 1);
    void loadAccountBalances({ silent: true });
  }, [loadAccountBalances]);

  const handleAccountBalanceUpdate = useCallback((items: SpotAccountBalanceItem[]) => {
    if (!items.length) return;

    setAccountBalances((prev) => {
      const map = new Map(
        prev.map((item) => [
          `${String(item.account_key || '').toLowerCase()}|${String(item.symbol || '').toUpperCase()}`,
          item,
        ]),
      );

      for (const item of items) {
        const accountKey = String(item.account_key || '').toLowerCase();
        const itemSymbol = String(item.symbol || '').toUpperCase();
        if (!accountKey || !itemSymbol) continue;

        map.set(`${accountKey}|${itemSymbol}`, {
          ...map.get(`${accountKey}|${itemSymbol}`),
          ...item,
          account_key: accountKey,
          symbol: itemSymbol,
        });
      }

      accountBalancesLoadedRef.current = true;

      return Array.from(map.values()).sort((a, b) => {
        const symbolCompare = String(a.symbol || '').localeCompare(String(b.symbol || ''));
        if (symbolCompare !== 0) return symbolCompare;
        return String(a.account_key || '').localeCompare(String(b.account_key || ''));
      });
    });
  }, []);

  const currentDisplaySymbol = useMemo(() => {
    return selectedTicker?.displaySymbol || selectedPair?.displaySymbol || selectedTicker?.label || formatSpotDisplaySymbol(symbol);
  }, [selectedPair?.displaySymbol, selectedTicker?.displaySymbol, selectedTicker?.label, symbol]);
  const spotLastPrice = formatPriceBySymbol(
    symbol,
    String(spotMarket.displayPrice ?? ''),
    pricePrecision,
  ) || '--';
  const orderbookReferencePrice = spotLastPrice;
  const formMarketPrice = formatOrderInputPriceBySymbol(
    symbol,
    String(spotMarket.orderbookMidPrice ?? spotMarket.bestAsk ?? spotMarket.bestBid ?? spotMarket.displayPrice ?? ''),
    pricePrecision,
  );
  const spotDepth = spotMarket.depth;
  const spotDepthAsks = spotDepth?.asks || [];
  const spotDepthBids = spotDepth?.bids || [];
  const marketHeaderData = buildMarketDataFromMarketView(symbol, spotMarket.marketView, pricePrecision) || EMPTY_MARKET_DATA;
  const priceDirection = spotMarket.priceDirection;
  const spotMarketStatus = spotMarket.marketView?.market_status || selectedPair?.marketStatus || 'OPEN';
  const spotMarketDataSource = spotMarket.marketView?.data_source || marketFeedDataSource;
  const spotTickerFreshness = spotMarket.freshness.ticker;
  const spotMarketSessionType = selectedTicker?.marketSessionType || selectedPair?.marketSessionType || null;
  const chartInterval = chartMode === 'time' ? '1m' : interval;
  const marketSyncingText = t('loading', 'common');
  const shouldShowMarketSyncing = spotMarket.isLoading && spotLastPrice === '--';
  const displayLatestPrice = shouldShowMarketSyncing ? marketSyncingText : spotLastPrice;
  const displayMarketHeaderData = shouldShowMarketSyncing
    ? {
      change: marketSyncingText,
      changeAmount: marketSyncingText,
      highLow: marketSyncingText,
      volume: marketSyncingText,
      turnover: marketSyncingText,
    }
    : marketHeaderData;

  return (
    <div className="flex flex-col overflow-x-hidden bg-[#0b0e11] text-white">
      <SpotHeader
        symbol={symbol}
        displaySymbol={currentDisplaySymbol}
        price={displayLatestPrice}
        change={displayMarketHeaderData.change}
        changeAmount={displayMarketHeaderData.changeAmount}
        highLow={displayMarketHeaderData.highLow}
        volume={displayMarketHeaderData.volume}
        turnover={displayMarketHeaderData.turnover}
        priceDirection={priceDirection}
        marketStatus={spotMarketStatus}
        quoteFreshness={null}
        tickerFreshness={spotTickerFreshness}
        marketSessionType={spotMarketSessionType}
      />

      <div className="w-full px-2 py-2 xl:px-3 xl:py-2">
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,10.55fr)_minmax(260px,1.85fr)] xl:items-start">
          <div className="min-w-0">
            <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,8.6fr)_minmax(240px,1.95fr)] xl:grid-rows-[minmax(540px,62vh)_auto]">
              <div className="min-w-0 min-h-0 xl:col-start-1 xl:row-start-1">
                <div className="flex h-full min-h-0 flex-col overflow-hidden border border-white/10 bg-[#12161c]">
                  <GlobalMarketSelector
                    key={`spot-toolbar-${initialCategory || 'default'}`}
                    symbol={symbol}
                    interval={interval}
                    chartMode={chartMode}
                    symbols={toolbarSymbols}
                    symbolLabels={symbolLabels}
                    pairs={toolbarPairs}
                    pairsLoading={pairOptionsLoading}
                    pairsLoadingMore={pairOptionsLoadingMore}
                    hasMorePairs={pairOptions.length < pairTotal}
                    initialCategory={getToolbarInitialCategory(initialCategory)}
                    onPairQueryChange={handlePairQueryChange}
                    onLoadMorePairs={handleLoadMorePairs}
                    onSymbolChange={handleSymbolChange}
                    onIntervalChange={setIntervalValue}
                    onChartModeChange={setChartMode}
                    toolbarAddon={<SpotLogoCard symbol={symbol} pair={selectedTicker || selectedPair} />}
                  />
                  <div className="min-h-0 flex-1">
                    <SpotTradingViewChart
                      symbol={symbol}
                      displaySymbol={currentDisplaySymbol}
                      interval={chartInterval}
                      chartMode={chartMode}
                      dataSource={spotMarketDataSource}
                      latestPrice={spotLastPrice}
                      latestTradeOrTickerPrice={null}
                      displayPriceRaw={spotMarket.displayPrice}
                      displayPriceFormatted={spotLastPrice}
                      priceDirection={priceDirection}
                      pricePrecision={pricePrecision}
                      amountPrecision={currentAmountPrecision}
                      tickerFreshness={spotTickerFreshness}
                      klineFreshness={spotMarket.freshness.kline}
                      showRwaReference={showRwaReference}
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
                        {t('spotOrderBook', 'asset')}
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
                        {t('spotTrades', 'asset')}
                      </button>
                    </div>
                  </div>

                  <div className="relative flex-1 min-h-0 min-w-0 overflow-hidden">
                    <div className={rightPanelTab === 'orderbook' ? 'block h-full min-h-0 min-w-0' : 'hidden h-full min-h-0 min-w-0'}>
                      <SpotOrderBook
                        symbol={symbol}
                        displaySymbol={currentDisplaySymbol}
                        referencePrice={orderbookReferencePrice}
                        pricePrecision={pricePrecision}
                        priceDirection={priceDirection}
                        asks={spotDepthAsks}
                        bids={spotDepthBids}
                        bestAsk={spotMarket.bestAsk}
                        bestBid={spotMarket.bestBid}
                        isLoading={spotMarket.isLoading}
                        onPriceClick={handleOrderBookPriceClick}
                      />
                    </div>

                    <div className={rightPanelTab === 'trades' ? 'block h-full min-h-0 min-w-0' : 'hidden h-full min-h-0 min-w-0'}>
                      <SpotTradesHistory
                        symbol={symbol}
                        displaySymbol={currentDisplaySymbol}
                        pricePrecision={pricePrecision}
                        trades={spotMarket.trades}
                        isLoading={spotMarket.isLoading}
                        onPriceClick={handleOrderBookPriceClick}
                      />
                    </div>
                  </div>
                </div>
              </div>

              <div className="min-w-0 min-h-0 overflow-visible border border-white/10 bg-[#12161c] xl:col-span-2 xl:col-start-1 xl:row-start-2">
                <SpotOrderTabs
                  symbol={symbol}
                  refreshKey={refreshKey}
                  onOrdersChanged={handleOrdersChanged}
                  onLoadingChange={setOrdersLoading}
                  onBalanceUpdate={handleAccountBalanceUpdate}
                />
              </div>
            </div>
          </div>

          <div className="min-w-0 xl:self-start">
            <div className="flex flex-col gap-2 overflow-visible">
              <div className="relative shrink-0 border border-white/10 bg-[#12161c] p-1.5 xl:p-2">
                <div>
                  <SpotTradingForm
                    symbol={symbol}
                    baseAsset={spotAssetSymbols.baseAsset}
                    quoteAsset={spotAssetSymbols.quoteAsset}
                    marketPrice={formMarketPrice}
                    selectedPrice={orderPrice}
                    priceSelectNonce={orderPriceSelectNonce}
                    pricePrecision={pricePrecision}
                    amountPrecision={currentAmountPrecision}
                    accountBalances={accountBalances}
                    asks={spotDepthAsks}
                    bids={spotDepthBids}
                    onPriceChange={setOrderPrice}
                    onOrderSuccess={handleOrderSuccess}
                    isLoggedIn={isLoggedIn}
                    authLoading={authLoading}
                    authChecked={authChecked}
                    userId={user?.id ?? null}
                  />
                </div>
              </div>

              <div className="shrink-0 overflow-visible border border-white/10 bg-[#12161c]">
                <SpotAssetInfo
                  symbol={symbol}
                  baseAsset={spotAssetSymbols.baseAsset}
                  quoteAsset={spotAssetSymbols.quoteAsset}
                  refreshKey={refreshKey}
                  accountBalances={accountBalances}
                  loading={balancesLoading}
                  isLoggedIn={isLoggedIn}
                  onTransferSuccess={handleOrderSuccess}
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
