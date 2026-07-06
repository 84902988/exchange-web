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
import { formatSpotDisplaySymbol } from './spotFormat';
import { useSpotMarket } from './useSpotMarket';
import {
  formatSpotPrice,
  normalizeSpotPriceInput,
  normalizeSpotPricePrecision,
  resolveSpotPricePrecision,
} from './spotPricePrecision';

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
const SPOT_INTERVAL_CHANGE_DEBOUNCE_MS = 350;
const SPOT_PRIVATE_FOREGROUND_REFRESH_MS = 10000;
const SPOT_PRIVATE_HIDDEN_REFRESH_MS = 30000;
const SPOT_PRIVATE_MIN_REFRESH_INTERVAL_MS = 2000;
type SpotPairQuery = {
  marketType: 'spot' | 'contract' | 'all';
  category: string;
  quote: string;
  keyword: string;
};
const cachedSpotPairPages = new Map<string, { items: SpotPairOption[]; total: number }>();

function normalizeSpotPageInterval(value: string): string {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw === '1M') return '1M';

  const normalized = raw.toLowerCase();
  if (normalized === '1h') return '1h';
  if (normalized === '4h') return '4h';
  if (normalized === '1d') return '1d';
  if (normalized === '1w') return '1w';
  return normalized;
}

function isSpotPageTvDebugEnabled() {
  if (typeof window === 'undefined') return false;

  try {
    if (new URLSearchParams(window.location.search || '').get('tvdebug') === '1') return true;
    if (/[?&]tvdebug=1(?:&|$)/.test(window.location.href || '')) return true;
  } catch {
    // Diagnostics only.
  }

  try {
    return window.localStorage?.getItem('SPOT_TV_DEBUG') === '1';
  } catch {
    return false;
  }
}

function spotPageIntervalDebug(event: string, payload: Record<string, unknown>) {
  if (!isSpotPageTvDebugEnabled()) return;

  try {
    const debugWindow = window as typeof window & {
      __SPOT_TV_DEBUG_EVENTS__?: Array<Record<string, unknown>>;
      __dumpSpotTvDebug?: () => Array<Record<string, unknown>>;
    };
    const timestamp = Date.now();
    const entry = {
      event,
      timestamp,
      time: new Date(timestamp).toISOString(),
      ...payload,
    };
    const events = debugWindow.__SPOT_TV_DEBUG_EVENTS__ || [];
    events.push(entry);
    if (events.length > 500) {
      events.splice(0, events.length - 500);
    }
    debugWindow.__SPOT_TV_DEBUG_EVENTS__ = events;
    debugWindow.__dumpSpotTvDebug = () => (debugWindow.__SPOT_TV_DEBUG_EVENTS__ || []).slice(-100);
    console.info(`[SpotPage] ${event} ${JSON.stringify(entry)}`);
  } catch {
    // Debug telemetry is best-effort only.
  }
}

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
  void symbol;
  if (!value || value === '--') return '';
  const num = Number(value);
  if (!Number.isFinite(num)) return '';
  const formatted = formatSpotPrice(num, precision ?? undefined);
  return formatted === '--' ? '' : formatted;
}

function formatOrderInputPriceBySymbol(symbol: string, value: string, precision?: number | null): string {
  void symbol;
  if (!value || value === '--') return '';
  const normalizedValue = String(value).replace(/,/g, '');
  const num = Number(normalizedValue);
  if (!Number.isFinite(num)) return '';
  return normalizeSpotPriceInput(num, precision ?? undefined);
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
  return normalizeSpotPricePrecision(value);
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
  displayPricePrecision?: number | null;
  pricePrecision?: number | null;
  priceTickSize?: string | number | null;
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

function getSpotTickSizeValue(
  value?: {
    price_tick_size?: string | number | null;
    tick_size?: string | number | null;
    priceTickSize?: string | number | null;
  } | null,
): string | number | null {
  return value?.price_tick_size ?? value?.priceTickSize ?? value?.tick_size ?? null;
}

function getSpotDisplayPricePrecision(
  value?: {
    display_price_precision?: unknown;
    displayPricePrecision?: unknown;
  } | null,
): number | null {
  return parseOptionalPrecision(value?.display_price_precision ?? value?.displayPricePrecision);
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
    displayPricePrecision: parseOptionalPrecision(
      (item as SpotMarketTickerItem | SpotMarketPairItem).display_price_precision,
    ),
    pricePrecision: parseOptionalPrecision(item.price_precision),
    priceTickSize: (item as SpotMarketTickerItem | SpotMarketPairItem).price_tick_size ??
      (item as SpotMarketTickerItem | SpotMarketPairItem).tick_size ??
      null,
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
  const originalDocumentTitleRef = useRef<string | null>(null);
  const titleUpdateTimerRef = useRef<number | null>(null);
  const titleUpdatedAtRef = useRef(0);
  const [interval, setIntervalValue] = useState('1d');
  const activeIntervalRef = useRef('1d');
  const intervalChangeTimerRef = useRef<number | null>(null);
  const intervalChangeSeqRef = useRef(0);
  const pendingIntervalChangeRef = useRef<{
    interval: string;
    source: string;
    seq: number;
  } | null>(null);
  const [chartMode, setChartMode] = useState<SpotChartMode>('candle');
  const [orderPrice, setOrderPrice] = useState('');
  const [orderPriceSelectNonce, setOrderPriceSelectNonce] = useState(0);

  const [refreshKey, setRefreshKey] = useState(0);
  const [accountBalances, setAccountBalances] = useState<SpotAccountBalanceItem[]>([]);
  const [balancesLoading, setBalancesLoading] = useState(false);
  const [, setOrdersLoading] = useState(false);
  const [rightPanelTab, setRightPanelTab] = useState<RightPanelTab>('orderbook');
  const accountBalancesLoadedRef = useRef(false);
  const accountBalancesInFlightRef = useRef(false);
  const accountBalancesRequestSeqRef = useRef(0);
  const lastAccountBalancesStartedAtRef = useRef(0);
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
  const selectedPair = useMemo(() => findSpotPairBySymbol(pairOptions, symbol), [pairOptions, symbol]);
  const selectedTicker = useMemo(() => {
    const normalizedSymbol = normalizeSpotApiSymbol(symbol);
    if (normalizeSpotApiSymbol(headerTicker?.symbol) === normalizedSymbol) {
      return headerTicker;
    }
    return selectedPair;
  }, [headerTicker, selectedPair, symbol]);
  const selectedDisplayPricePrecision = useMemo(() => {
    const normalizedSymbol = normalizeSpotApiSymbol(symbol);
    const viewPrecision = getSpotDisplayPricePrecision(spotMarket.marketView);
    if (viewPrecision !== null) {
      return viewPrecision;
    }
    const depthPrecision = getSpotDisplayPricePrecision(spotMarket.depth);
    if (depthPrecision !== null) {
      return depthPrecision;
    }
    if (headerTicker && normalizeSpotApiSymbol(headerTicker.symbol) === normalizedSymbol) {
      return headerTicker.displayPricePrecision ?? null;
    }
    return findSpotPairBySymbol(pairOptions, normalizedSymbol)?.displayPricePrecision ?? null;
  }, [
    headerTicker,
    pairOptions,
    spotMarket.depth,
    spotMarket.marketView,
    symbol,
  ]);
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
  const selectedPriceTickSize = useMemo(() => (
    getSpotTickSizeValue(spotMarket.marketView) ??
    getSpotTickSizeValue(spotMarket.depth) ??
    getSpotTickSizeValue(selectedTicker) ??
    getSpotTickSizeValue(selectedPair)
  ), [selectedPair, selectedTicker, spotMarket.depth, spotMarket.marketView]);
  const pricePrecision = resolveSpotPricePrecision({
    displayPricePrecision: selectedDisplayPricePrecision,
    priceTickSize: selectedPriceTickSize,
    pricePrecision: selectedPairPrecision,
    fallbackPrecision: selectedPairPrecision,
  });

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
    activeIntervalRef.current = interval;
  }, [interval]);

  useEffect(() => {
    pairOptionsRef.current = pairOptions;
  }, [pairOptions]);

  useEffect(() => {
    pairQueryRef.current = pairQuery;
  }, [pairQuery]);

  useEffect(() => {
    setOrderPrice('');
  }, [symbol]);

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

  const loadAccountBalances = useCallback(async (options?: { force?: boolean; silent?: boolean }) => {
    if (!isLoggedIn) {
      accountBalancesLoadedRef.current = false;
      accountBalancesInFlightRef.current = false;
      setAccountBalances([]);
      return;
    }

    const now = Date.now();
    if (accountBalancesInFlightRef.current) {
      return;
    }
    if (
      !options?.force &&
      lastAccountBalancesStartedAtRef.current > 0 &&
      now - lastAccountBalancesStartedAtRef.current < SPOT_PRIVATE_MIN_REFRESH_INTERVAL_MS
    ) {
      return;
    }

    const shouldShowLoading = !options?.silent && !accountBalancesLoadedRef.current;
    const requestSeq = ++accountBalancesRequestSeqRef.current;
    accountBalancesInFlightRef.current = true;
    lastAccountBalancesStartedAtRef.current = now;

    try {
      if (shouldShowLoading) {
        setBalancesLoading(true);
      }
      const data = await getSpotAccountBalances();
      if (accountBalancesRequestSeqRef.current !== requestSeq) {
        return;
      }
      setAccountBalances(data);
      accountBalancesLoadedRef.current = true;
    } catch (error) {
      console.error('SpotPage account balances load error:', error);
    } finally {
      if (accountBalancesRequestSeqRef.current === requestSeq) {
        accountBalancesInFlightRef.current = false;
      }
      if (shouldShowLoading) {
        setBalancesLoading(false);
      }
    }
  }, [isLoggedIn]);

  useEffect(() => {
    void loadAccountBalances({
      force: refreshKey === 0 || !accountBalancesLoadedRef.current,
      silent: refreshKey > 0,
    });
  }, [loadAccountBalances, refreshKey]);

  useEffect(() => {
    if (!isLoggedIn) {
      return undefined;
    }

    let stopped = false;
    let timer: number | null = null;

    const getRefreshDelayMs = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        return SPOT_PRIVATE_HIDDEN_REFRESH_MS;
      }
      return SPOT_PRIVATE_FOREGROUND_REFRESH_MS;
    };

    const clearTimer = () => {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
    };

    const scheduleNextRefresh = () => {
      clearTimer();
      timer = window.setTimeout(() => {
        if (stopped) return;
        setRefreshKey((v) => v + 1);
        scheduleNextRefresh();
      }, getRefreshDelayMs());
    };

    const handleVisibilityChange = () => {
      if (stopped) return;
      clearTimer();
      if (document.visibilityState === 'visible') {
        setRefreshKey((v) => v + 1);
      }
      scheduleNextRefresh();
    };

    scheduleNextRefresh();
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      stopped = true;
      clearTimer();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [isLoggedIn]);

  useEffect(() => {
    if (!isLoggedIn) {
      accountBalancesLoadedRef.current = false;
      accountBalancesInFlightRef.current = false;
      accountBalancesRequestSeqRef.current += 1;
      lastAccountBalancesStartedAtRef.current = 0;
      setBalancesLoading(false);
      setAccountBalances([]);
    }
  }, [isLoggedIn]);

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

  const clearPendingIntervalChange = useCallback((reason: string) => {
    const pending = pendingIntervalChangeRef.current;
    if (intervalChangeTimerRef.current !== null) {
      window.clearTimeout(intervalChangeTimerRef.current);
      intervalChangeTimerRef.current = null;
    }
    pendingIntervalChangeRef.current = null;

    if (pending) {
      spotPageIntervalDebug('interval-change-cancelled', {
        interval: pending.interval,
        source: pending.source,
        reason,
        debounceMs: SPOT_INTERVAL_CHANGE_DEBOUNCE_MS,
      });
    }
  }, []);

  const scheduleIntervalChange = useCallback(
    (nextInterval: string, source = 'spot-page') => {
      const requestedInterval = normalizeSpotPageInterval(nextInterval);
      if (!requestedInterval) return;

      const activeInterval = activeIntervalRef.current;
      if (requestedInterval === activeInterval) {
        clearPendingIntervalChange('already active');
        spotPageIntervalDebug('interval-change-requested', {
          interval: requestedInterval,
          source,
          skipped: true,
          reason: 'already active',
          debounceMs: SPOT_INTERVAL_CHANGE_DEBOUNCE_MS,
        });
        return;
      }

      const pending = pendingIntervalChangeRef.current;
      if (pending?.interval === requestedInterval) {
        spotPageIntervalDebug('interval-change-requested', {
          interval: requestedInterval,
          source,
          skipped: true,
          reason: 'already pending',
          debounceMs: SPOT_INTERVAL_CHANGE_DEBOUNCE_MS,
        });
        return;
      }

      if (pending) {
        clearPendingIntervalChange('superseded by latest intent');
      }

      const requestSeq = ++intervalChangeSeqRef.current;
      pendingIntervalChangeRef.current = {
        interval: requestedInterval,
        source,
        seq: requestSeq,
      };

      spotPageIntervalDebug('interval-change-requested', {
        requestSeq,
        interval: requestedInterval,
        activeInterval,
        source,
        debounceMs: SPOT_INTERVAL_CHANGE_DEBOUNCE_MS,
      });

      intervalChangeTimerRef.current = window.setTimeout(() => {
        const latestPending = pendingIntervalChangeRef.current;
        if (!latestPending || latestPending.seq !== requestSeq) return;

        intervalChangeTimerRef.current = null;
        pendingIntervalChangeRef.current = null;

        if (activeIntervalRef.current === requestedInterval) {
          spotPageIntervalDebug('interval-change-committed', {
            requestSeq,
            interval: requestedInterval,
            source,
            skipped: true,
            reason: 'already active at commit',
            debounceMs: SPOT_INTERVAL_CHANGE_DEBOUNCE_MS,
          });
          return;
        }

        setIntervalValue(requestedInterval);
        spotPageIntervalDebug('interval-change-committed', {
          requestSeq,
          interval: requestedInterval,
          source,
          debounceMs: SPOT_INTERVAL_CHANGE_DEBOUNCE_MS,
        });
      }, SPOT_INTERVAL_CHANGE_DEBOUNCE_MS);
    },
    [clearPendingIntervalChange],
  );

  useEffect(() => () => {
    clearPendingIntervalChange('component unmount');
  }, [clearPendingIntervalChange]);

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

  const handleHeaderIntervalChange = useCallback(
    (value: string) => {
      scheduleIntervalChange(value, 'header-selector');
    },
    [scheduleIntervalChange],
  );

  const handleChartIntervalChange = useCallback(
    (value: string) => {
      scheduleIntervalChange(value, 'tradingview-toolbar');
    },
    [scheduleIntervalChange],
  );

  const handleChartModeChange = useCallback(
    (value: SpotChartMode) => {
      if (value === 'time') {
        clearPendingIntervalChange('chart mode changed to time sharing');
      }
      setChartMode(value);
    },
    [clearPendingIntervalChange],
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
    void loadAccountBalances({ force: true, silent: true });
  }, [loadAccountBalances]);

  const handleOrdersChanged = useCallback(() => {
    setRefreshKey((v) => v + 1);
    void loadAccountBalances({ force: true, silent: true });
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
  const hasSpotTradePrice = spotMarket.lastTradePrice !== null && spotMarket.lastTradePrice !== undefined && String(spotMarket.lastTradePrice).trim() !== '';
  const headerPriceValue = hasSpotTradePrice ? spotMarket.lastTradePrice : spotMarket.displayPrice;
  const spotLastPrice = formatPriceBySymbol(
    symbol,
    String(headerPriceValue ?? ''),
    pricePrecision,
  ) || '--';
  const orderbookReferencePrice = spotLastPrice;
  const formMarketPrice = formatOrderInputPriceBySymbol(
    symbol,
    String(spotMarket.orderbookMidPrice ?? spotMarket.bestAsk ?? spotMarket.bestBid ?? ''),
    pricePrecision,
  );
  const latestTradePriceText = formatOrderInputPriceBySymbol(
    symbol,
    String(spotMarket.lastTradePrice ?? ''),
    pricePrecision,
  );
  const spotDepth = spotMarket.depth;
  const spotDepthAsks = spotDepth?.asks || [];
  const spotDepthBids = spotDepth?.bids || [];
  const marketHeaderData = buildMarketDataFromMarketView(symbol, spotMarket.marketView, pricePrecision) || EMPTY_MARKET_DATA;
  const priceDirection = hasSpotTradePrice ? spotMarket.lastTradeDirection : spotMarket.priceDirection;
  const spotMarketStatus = spotMarket.marketView?.market_status || selectedPair?.marketStatus || 'OPEN';
  const spotMarketDataSource = spotMarket.marketView?.data_source || marketFeedDataSource;
  const spotSources = spotMarket.sources;
  const spotFreshness = spotMarket.freshness;
  const normalizedDisplayPriceSource = String(spotMarket.displayPriceSource || '').toLowerCase();
  const spotPriceStatusDomain = hasSpotTradePrice || normalizedDisplayPriceSource.includes('trade')
    ? 'trades'
    : normalizedDisplayPriceSource.includes('kline')
      ? 'kline'
      : 'ticker';
  const spotPriceStatusSource = spotSources[spotPriceStatusDomain];
  const spotPriceStatusFreshness = spotFreshness[spotPriceStatusDomain];
  const spotMarketSessionType = selectedTicker?.marketSessionType || selectedPair?.marketSessionType || null;
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
    const displaySymbol = formatSpotDisplaySymbol(symbol);
    const titlePrice = !shouldShowMarketSyncing && spotLastPrice !== '--' ? spotLastPrice : '';
    const nextTitle = titlePrice
      ? `${titlePrice} ${displaySymbol} 现货交易 | Royal Exchange`
      : `${displaySymbol} 现货交易 | Royal Exchange`;
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
  }, [shouldShowMarketSyncing, spotLastPrice, symbol]);

  return (
    <div className="flex flex-col overflow-x-hidden bg-[#0b0e11] text-white">
      <div className="w-full px-2 py-2 xl:px-3 xl:py-2">
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
          tickerSource={spotPriceStatusSource}
          tickerFreshness={spotPriceStatusFreshness}
          dataSource={spotMarketDataSource}
          isLoading={spotMarket.isLoading}
          marketSessionType={spotMarketSessionType}
          symbolSelector={
            <GlobalMarketSelector
              key={`spot-header-selector-${initialCategory || 'default'}`}
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
              onIntervalChange={handleHeaderIntervalChange}
              onChartModeChange={handleChartModeChange}
              placement="header"
            />
          }
        />

        <div className="mt-2 grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,8.6fr)_minmax(240px,1.95fr)_minmax(260px,1.85fr)] xl:grid-rows-[minmax(540px,62vh)_minmax(170px,auto)] xl:items-stretch">
          <div className="min-h-[420px] min-w-0 xl:col-start-1 xl:row-start-1 xl:min-h-0">
            <div className="flex h-full min-h-0 flex-col overflow-hidden border border-white/10 bg-[#12161c]">
              <div className="min-h-0 flex-1">
                <SpotTradingViewChart
                  symbol={symbol}
                  displaySymbol={currentDisplaySymbol}
                  interval={interval}
                  chartMode={chartMode}
                  onIntervalChange={handleChartIntervalChange}
                  onChartModeChange={handleChartModeChange}
                  dataSource={spotMarketDataSource}
                  klineSource={spotSources.kline}
                  klineFreshness={spotFreshness.kline}
                  isLoading={spotMarket.isLoading}
                  latestPrice={spotLastPrice}
                  latestTradeOrTickerPrice={null}
                  priceDirection={priceDirection}
                  pricePrecision={pricePrecision}
                  amountPrecision={currentAmountPrecision}
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
                    depthSource={spotSources.depth}
                    depthFreshness={spotFreshness.depth}
                    dataSource={spotMarketDataSource}
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
                    tradesSource={spotSources.trades}
                    tradesFreshness={spotFreshness.trades}
                    dataSource={spotMarketDataSource}
                    isLoading={spotMarket.isLoading}
                    onPriceClick={handleOrderBookPriceClick}
                  />
                </div>
              </div>
            </div>
          </div>

          <div className="flex min-h-[150px] min-w-0 flex-col overflow-visible border border-white/10 bg-[#12161c] xl:col-span-2 xl:col-start-1 xl:row-start-2 xl:min-h-0">
            <SpotOrderTabs
              symbol={symbol}
              refreshKey={refreshKey}
              onOrdersChanged={handleOrdersChanged}
              onLoadingChange={setOrdersLoading}
              onBalanceUpdate={handleAccountBalanceUpdate}
            />
          </div>

          <div className="min-h-[420px] min-w-0 xl:col-start-3 xl:row-start-1 xl:min-h-0">
            <div className="relative flex h-full min-h-0 flex-col overflow-y-auto border border-white/10 bg-[#12161c] p-1.5 xl:p-2">
              <SpotTradingForm
                symbol={symbol}
                baseAsset={spotAssetSymbols.baseAsset}
                quoteAsset={spotAssetSymbols.quoteAsset}
                marketPrice={formMarketPrice}
                latestTradePrice={latestTradePriceText || null}
                latestTradeAt={spotMarket.lastTradeAt}
                selectedPrice={orderPrice}
                priceSelectNonce={orderPriceSelectNonce}
                pricePrecision={pricePrecision}
                amountPrecision={currentAmountPrecision}
                accountBalances={accountBalances}
                asks={spotDepthAsks}
                bids={spotDepthBids}
                depthSource={spotSources.depth}
                depthFreshness={spotFreshness.depth}
                dataSource={spotMarketDataSource}
                marketDataLoading={spotMarket.isLoading}
                onPriceChange={setOrderPrice}
                onOrderSuccess={handleOrderSuccess}
                isLoggedIn={isLoggedIn}
                authLoading={authLoading}
                authChecked={authChecked}
                userId={user?.id ?? null}
              />
            </div>
          </div>

          <div className="min-h-[150px] min-w-0 xl:col-start-3 xl:row-start-2 xl:min-h-0">
            <div className="flex h-full min-h-0 flex-col overflow-y-auto border border-white/10 bg-[#12161c]">
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
  );
}
