'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toNumber } from '@/components/contract/contractFormat';
import { getContractMarketSourceLabel } from '@/components/contract/contractMarketSourceStatus';
import { normalizeSide } from '@/components/spot/orderbook/orderbook.utils';
import { useLocaleContext } from '@/contexts/LocaleContext';
import {
  getContractDepth,
  getContractMarketTrades,
  getContractMarketView,
  getContractQuoteDisplayStatus,
  isExpiredLastGoodBboQuote,
  type ContractDepthLevel,
  type ContractDepthMode,
  type ContractKlineCurrentCandle,
  type ContractKlineMode,
  type ContractMarketTrade,
  type ContractMarketViewDetail,
  type ContractQuoteDisplayStatus,
} from '@/lib/api/modules/contract';
import {
  contractMarketRealtime,
  type ContractMarketRealtimeMessage,
} from '@/lib/realtime/contractMarketRealtime';
import {
  readContractTradesCache,
  writeContractTradesCache,
} from '@/lib/contractMarketCache';
import {
  useContractMarketState,
  type PriceDirection,
} from './useContractMarketState';

export type ContractCurrentPriceSource = 'KLINE_CLOSE' | 'LIVE_MID' | 'TRADE_TICK';

export type ContractMarketUiState = {
  label: string;
  isLoading: boolean;
  isTradable: boolean;
  isRealtime: boolean;
  reason: string;
  status: ContractQuoteDisplayStatus;
};

export type ContractMarketCenterState = {
  symbol: string;
  displayPrice: number | null;
  displayPriceSource: ContractCurrentPriceSource;
  displayPriceLabel: string;
  bestBid: number | null;
  bestAsk: number | null;
  spread: number | null;
  executionBid: number | null;
  executionAsk: number | null;
  latestTradePrice: number | null;
  latestTradePriceSource: 'TRADE_TICK' | null;
  klineMode: ContractKlineMode;
  klineCurrentCandle: ContractKlineCurrentCandle | null;
  quoteFreshness: string | null;
  displayState: string | null;
  executable: boolean | null;
  updatedAt: number;
};

type LiveDepthBbo = {
  bid: number | null;
  ask: number | null;
  mid: number | null;
  source: 'LIVE_MID' | null;
  updatedAt: number;
};

type UseContractMarketViewParams = {
  contractSymbol: string;
  interval?: string;
  symbolOptionMarketSymbol?: string | null;
  symbolOptionPricePrecision?: number | null;
  fallbackMarketStatus?: string | null;
  fallbackMarketStatusText?: string | null;
  fallbackMarketSessionType?: string | null;
  fallbackQuoteFreshness?: string | null;
  chartLastClose?: string | number | null;
};

const LIVE_DEPTH_BBO_TTL_MS = 5000;
const FUTURES_DEPTH_LIMIT = 20;
const FUTURES_TRADES_LIMIT = 30;
const DEPTH_INITIAL_GRACE_MS = 1800;
const DEPTH_FULL_DEGRADE_GRACE_MS = 3000;

type ContractDepthSnapshot = {
  symbol?: string | null;
  asks: ContractDepthLevel[];
  bids: ContractDepthLevel[];
  source?: string | null;
  quote_freshness?: string | null;
  quote_source?: string | null;
  depth_mode?: ContractDepthMode | null;
  market_status?: string | null;
  executable?: boolean | null;
  closed_market_execution_mode?: string | null;
  ts?: string | number | null;
};

type ContractDepthState = ContractDepthSnapshot & {
  symbol: string;
  loading: boolean;
  error: string | null;
  updatedAt: number | null;
};

type ContractTradesState = {
  symbol: string;
  trades: ContractMarketTrade[];
  loading: boolean;
  error: string | null;
  source: string | null;
  freshness: string | null;
  updatedAt: number | null;
};

function normalizeContractSymbol(value?: string | null) {
  return String(value || '').trim().toUpperCase();
}

function normalizeCurrentPriceSource(value?: string | null): ContractCurrentPriceSource | null {
  const normalized = String(value || '').trim().toUpperCase();
  if (normalized === 'TRADE_TICK') return 'TRADE_TICK';
  if (normalized === 'LIVE_MID') return 'LIVE_MID';
  if (normalized === 'KLINE_CLOSE') return 'KLINE_CLOSE';
  return null;
}

function normalizeMarketViewDisplayState(value?: string | null) {
  const normalized = String(value || '').trim().toUpperCase();
  return normalized || null;
}

function marketViewStateToQuoteStatus(value?: string | null): ContractQuoteDisplayStatus | null {
  const state = normalizeMarketViewDisplayState(value);
  if (!state) return null;
  if (state === 'LOADING') return 'LOADING';
  if (state === 'LIVE_TRADABLE' || state === 'REGULAR_OPEN') return 'LIVE';
  if (
    state === 'PRE_MARKET'
    || state === 'AFTER_HOURS'
    || state === 'CLOSED'
    || state === 'MARKET_CLOSED'
    || state === 'HOLIDAY'
    || state === 'CLOSED_LAST_GOOD_TRADABLE'
    || state === 'CLOSED_LAST_GOOD_DISPLAY_ONLY'
    || state === 'EXPIRED'
    || state === 'UNAVAILABLE'
  ) return 'UNAVAILABLE';
  return null;
}

function isLiveMarketState(value?: string | null) {
  const state = normalizeMarketViewDisplayState(value);
  return (
    state === 'LIVE_TRADABLE'
    || state === 'REGULAR_OPEN'
    || state === 'OPEN'
    || state === 'REGULAR'
    || state === 'LIVE'
    || state === 'TRADING'
  );
}

function isNonTradingMarketState(value?: string | null) {
  const state = normalizeMarketViewDisplayState(value);
  return (
    state === 'PRE_MARKET'
    || state === 'AFTER_HOURS'
    || state === 'CLOSED'
    || state === 'MARKET_CLOSED'
    || state === 'HOLIDAY'
    || state === 'EXPIRED'
  );
}

function getNonTradingMarketViewStatusLabel(value: string) {
  const state = normalizeMarketViewDisplayState(value);
  if (state === 'PRE_MARKET') return '盘前';
  if (state === 'AFTER_HOURS') return '盘后';
  if (state === 'CLOSED' || state === 'MARKET_CLOSED') return '闭市中';
  if (state === 'HOLIDAY') return '休市中';
  return null;
}

function getMarketViewStatusLabel(value: string, t: (key: string, namespace?: 'contracts') => string) {
  const state = normalizeMarketViewDisplayState(value);
  if (state === 'LOADING') return t('marketDataLoadingLabel', 'contracts');
  if (state === 'LIVE_TRADABLE') return t('realtimeQuoteLabel', 'contracts');
  const nonTradingLabel = getNonTradingMarketViewStatusLabel(value);
  if (nonTradingLabel) return nonTradingLabel;
  return t('quoteTemporarilyUnavailableLabel', 'contracts');
}

function getContractQuoteStatusLabel(status: ContractQuoteDisplayStatus, t: (key: string, namespace?: 'contracts') => string) {
  if (status === 'LOADING') return t('marketDataLoadingLabel', 'contracts');
  if (status === 'LIVE') return t('realtimeQuoteLabel', 'contracts');
  return t('quoteTemporarilyUnavailableLabel', 'contracts');
}

function getContractQuoteStatusTone(status: ContractQuoteDisplayStatus) {
  if (status === 'LOADING') return 'loading' as const;
  if (status === 'LIVE') return 'live' as const;
  if (status === 'EXPIRED_LAST_QUOTE') return 'expired' as const;
  if (status === 'UNAVAILABLE') return 'unavailable' as const;
  return 'last' as const;
}

function getPositivePrice(value?: string | number | null) {
  const price = toNumber(value);
  return price > 0 ? price : null;
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'contract market view unavailable';
}

function extractContractMarketStateMessage(message: ContractMarketRealtimeMessage): ContractMarketViewDetail | null {
  const source = message.market_state && typeof message.market_state === 'object'
    ? message.market_state
    : message.data && typeof message.data === 'object'
      ? message.data
      : null;
  if (!source) return null;
  const record = source as Partial<ContractMarketViewDetail>;
  return record.symbol ? record as ContractMarketViewDetail : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function getMessagePayload(message: ContractMarketRealtimeMessage) {
  if (isRecord(message.depth)) return message.depth;
  if (isRecord(message.data)) return message.data;
  return message as Record<string, unknown>;
}

function normalizeRealtimeLevels(value: unknown): ContractDepthLevel[] {
  if (!Array.isArray(value)) return [];

  return value
    .map((level) => {
      if (Array.isArray(level)) {
        return {
          price: String(level[0] ?? ''),
          amount: String(level[1] ?? ''),
        };
      }
      if (isRecord(level)) {
        return {
          price: String(level.price ?? ''),
          amount: String(level.amount ?? level.qty ?? level.quantity ?? ''),
        };
      }
      return null;
    })
    .filter((level): level is ContractDepthLevel => (
      !!level && toNumber(level.price) > 0 && toNumber(level.amount) > 0
    ));
}

function normalizeTradeTime(value: unknown) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return Date.now();
  return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
}

function getTradePayloads(message: ContractMarketRealtimeMessage) {
  if (Array.isArray(message.trades)) return message.trades;
  if (isRecord(message.trade)) return [message.trade];
  if (Array.isArray(message.data)) return message.data;
  if (isRecord(message.data)) return [message.data];
  return [message];
}

function extractRealtimeTrades(
  message: ContractMarketRealtimeMessage,
  currentSymbol: string,
): ContractMarketTrade[] {
  return getTradePayloads(message)
    .flatMap((payload) => {
      if (!isRecord(payload)) return [];
      const msgSymbol = String(message.symbol || payload.symbol || '').trim().toUpperCase();
      if (msgSymbol && msgSymbol !== normalizeContractSymbol(currentSymbol)) return [];

      const price = payload.price ?? payload.last_price;
      const qty = payload.qty ?? payload.amount ?? payload.quantity ?? payload.volume;
      const priceSource = String(payload.price_source || '').trim().toUpperCase();
      const normalizedQty = toNumber(qty as string | number | null);
      if (
        toNumber(price as string | number | null) <= 0
        || (normalizedQty <= 0 && priceSource !== 'TRADE_TICK')
      ) {
        return [];
      }

      const time = normalizeTradeTime(payload.time ?? payload.ts ?? payload.timestamp);
      const trade: ContractMarketTrade = {
        id: payload.id ? String(payload.id) : `${time}-${price}-${normalizedQty}`,
        price: String(price),
        qty: String(normalizedQty > 0 ? normalizedQty : 0),
        time,
      };
      if (payload.last_price) trade.last_price = String(payload.last_price);
      if (payload.quoteQty) trade.quoteQty = String(payload.quoteQty);
      if (payload.amount) trade.amount = String(payload.amount);
      if (payload.volume) trade.volume = String(payload.volume);
      if (payload.source) trade.source = String(payload.source);
      if (payload.quote_source) trade.quote_source = String(payload.quote_source);
      if (payload.quote_freshness) trade.quote_freshness = String(payload.quote_freshness);
      if (payload.price_source) trade.price_source = String(payload.price_source);
      if (typeof payload.synthetic === 'boolean') trade.synthetic = payload.synthetic;
      if (payload.side) trade.side = String(payload.side);
      if (typeof payload.isBuyerMaker === 'boolean') {
        trade.isBuyerMaker = payload.isBuyerMaker;
      } else if (typeof payload.is_buyer_maker === 'boolean') {
        trade.isBuyerMaker = payload.is_buyer_maker;
      }
      return [trade];
    });
}

function mergeTrades(
  incoming: ContractMarketTrade[],
  previous: ContractMarketTrade[],
  limit = FUTURES_TRADES_LIMIT,
) {
  const seen = new Set<string>();
  return [...incoming, ...previous]
    .filter((item) => {
      const key = String(item.id);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit);
}

function extractRealtimeDepth(
  message: ContractMarketRealtimeMessage,
  currentSymbol: string,
): ContractDepthSnapshot | null {
  const payload = getMessagePayload(message);
  const msgSymbol = String(message.symbol || payload.symbol || '').trim().toUpperCase();
  const normalizedCurrentSymbol = normalizeContractSymbol(currentSymbol);
  if (msgSymbol && msgSymbol !== normalizedCurrentSymbol) return null;

  const asks = normalizeRealtimeLevels(payload.asks);
  const bids = normalizeRealtimeLevels(payload.bids);
  if (asks.length === 0 && bids.length === 0) return null;

  return {
    symbol: msgSymbol || normalizedCurrentSymbol,
    asks: normalizeSide(asks, 'asks', FUTURES_DEPTH_LIMIT),
    bids: normalizeSide(bids, 'bids', FUTURES_DEPTH_LIMIT),
    source: typeof payload.source === 'string' ? payload.source : null,
    depth_mode: typeof payload.depth_mode === 'string'
      ? payload.depth_mode as ContractDepthMode
      : typeof payload.depthMode === 'string'
        ? payload.depthMode as ContractDepthMode
        : null,
    quote_source: typeof payload.quote_source === 'string' ? payload.quote_source : null,
    quote_freshness: typeof payload.quote_freshness === 'string'
      ? payload.quote_freshness
      : typeof payload.quoteFreshness === 'string'
        ? payload.quoteFreshness
        : null,
    ts: typeof payload.ts === 'string' || typeof payload.ts === 'number'
      ? payload.ts
      : typeof payload.time === 'string' || typeof payload.time === 'number'
        ? payload.time
        : typeof payload.timestamp === 'string' || typeof payload.timestamp === 'number'
          ? payload.timestamp
          : null,
    closed_market_execution_mode: typeof payload.closed_market_execution_mode === 'string'
      ? payload.closed_market_execution_mode
      : null,
    executable: typeof payload.executable === 'boolean' ? payload.executable : null,
    market_status: typeof payload.market_status === 'string' ? payload.market_status : null,
  };
}

function minPrice(levels: ContractDepthLevel[]) {
  let best: ContractDepthLevel | null = null;
  for (const level of levels) {
    const price = toNumber(level.price);
    if (price <= 0) continue;
    if (!best || price < toNumber(best.price)) best = level;
  }
  return best?.price ? String(best.price) : null;
}

function maxPrice(levels: ContractDepthLevel[]) {
  let best: ContractDepthLevel | null = null;
  for (const level of levels) {
    const price = toNumber(level.price);
    if (price <= 0) continue;
    if (!best || price > toNumber(best.price)) best = level;
  }
  return best?.price ? String(best.price) : null;
}

function getTimestampMillis(value?: string | number | null) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1_000_000_000_000 ? value : value * 1000;
  }
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric > 1_000_000_000_000 ? numeric : numeric * 1000;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

export function useContractMarketView({
  contractSymbol,
  interval = '1m',
  symbolOptionMarketSymbol,
  symbolOptionPricePrecision,
  fallbackMarketStatus,
  fallbackMarketStatusText,
  fallbackMarketSessionType,
  fallbackQuoteFreshness,
  chartLastClose,
}: UseContractMarketViewParams) {
  const { t } = useLocaleContext();
  const [restMarketView, setRestMarketView] = useState<ContractMarketViewDetail | null>(null);
  const [wsState, setWsState] = useState<ContractMarketViewDetail | null>(null);
  const [marketViewLoading, setMarketViewLoading] = useState(true);
  const [marketViewError, setMarketViewError] = useState<string | null>(null);
  const [localChartLastClose, setLocalChartLastClose] = useState<string | null>(null);
  const [lastTradePrice, setLastTradePrice] = useState<string | null>(null);
  const [liveDepthBbo, setLiveDepthBbo] = useState<LiveDepthBbo | null>(null);
  const [depthState, setDepthState] = useState<ContractDepthState>(() => ({
    symbol: normalizeContractSymbol(contractSymbol),
    asks: [],
    bids: [],
    source: null,
    quote_freshness: null,
    quote_source: null,
    depth_mode: null,
    market_status: null,
    executable: null,
    closed_market_execution_mode: null,
    ts: null,
    loading: true,
    error: null,
    updatedAt: null,
  }));
  const [tradesState, setTradesState] = useState<ContractTradesState>(() => ({
    symbol: normalizeContractSymbol(contractSymbol),
    trades: [],
    loading: true,
    error: null,
    source: null,
    freshness: null,
    updatedAt: null,
  }));
  const [fallbackDepthAllowed, setFallbackDepthAllowed] = useState(false);
  const [lastFullDepthSnapshot, setLastFullDepthSnapshot] = useState<{
    asks: ContractDepthLevel[];
    bids: ContractDepthLevel[];
  } | null>(null);
  const [priceDirection, setPriceDirection] = useState<PriceDirection>('flat');
  const [marketSessionRefreshKey, setMarketSessionRefreshKey] = useState(0);
  const requestSeqRef = useRef(0);
  const inFlightSymbolRef = useRef<string | null>(null);
  const depthRequestSeqRef = useRef(0);
  const depthInFlightSymbolRef = useRef<string | null>(null);
  const tradesRequestSeqRef = useRef(0);
  const tradesInFlightSymbolRef = useRef<string | null>(null);
  const marketViewErrorSymbolRef = useRef<string | null>(null);
  const mountedRef = useRef(false);
  const currentPriceRef = useRef<number | null>(null);
  const previousMarketViewDisplayStateRef = useRef<string | null>(null);

  const quoteState = useContractMarketState({
    contractSymbol,
    interval,
    symbolOptionMarketSymbol,
    symbolOptionPricePrecision,
  });
  const {
    initialDepth,
    marketRealtimeStatus: quoteMarketRealtimeStatus,
    handleBestPricesChange: handleDepthBestPricesChange,
    handleDepthDataChange: handleDepthSnapshotChange,
  } = quoteState;
  const initialDepthRef = useRef<ContractDepthSnapshot | undefined>(initialDepth);

  useEffect(() => {
    initialDepthRef.current = initialDepth;
  }, [initialDepth]);

  const refreshMarketView = useCallback(async () => {
    const requestSymbol = normalizeContractSymbol(contractSymbol);
    if (!requestSymbol) return;
    if (inFlightSymbolRef.current === requestSymbol) return;

    const requestSeq = requestSeqRef.current + 1;
    requestSeqRef.current = requestSeq;
    inFlightSymbolRef.current = requestSymbol;

    try {
      const view = await getContractMarketView(requestSymbol);
      if (
        !mountedRef.current
        || requestSeqRef.current !== requestSeq
        || normalizeContractSymbol(view.symbol) !== requestSymbol
      ) {
        return;
      }
      setRestMarketView(view);
      marketViewErrorSymbolRef.current = null;
      setMarketViewError(null);
    } catch (error) {
      if (!mountedRef.current || requestSeqRef.current !== requestSeq) return;
      setRestMarketView(null);
      marketViewErrorSymbolRef.current = requestSymbol;
      setMarketViewError(getErrorMessage(error));
    } finally {
      if (inFlightSymbolRef.current === requestSymbol) {
        inFlightSymbolRef.current = null;
      }
      if (mountedRef.current && requestSeqRef.current === requestSeq) {
        setMarketViewLoading(false);
      }
    }
  }, [contractSymbol]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestSeqRef.current += 1;
    };
  }, []);

  useEffect(() => {
    requestSeqRef.current += 1;
    inFlightSymbolRef.current = null;
    depthRequestSeqRef.current += 1;
    depthInFlightSymbolRef.current = null;
    tradesRequestSeqRef.current += 1;
    tradesInFlightSymbolRef.current = null;
    currentPriceRef.current = null;
    previousMarketViewDisplayStateRef.current = null;
    marketViewErrorSymbolRef.current = null;
    setRestMarketView(null);
    setWsState(null);
    setMarketViewError(null);
    setMarketViewLoading(true);
    setLocalChartLastClose(null);
    setLastTradePrice(null);
    setLiveDepthBbo(null);
    setDepthState({
      symbol: normalizeContractSymbol(contractSymbol),
      asks: [],
      bids: [],
      source: null,
      quote_freshness: null,
      quote_source: null,
      depth_mode: null,
      market_status: null,
      executable: null,
      closed_market_execution_mode: null,
      ts: null,
      loading: true,
      error: null,
      updatedAt: null,
    });
    setFallbackDepthAllowed(false);
    setLastFullDepthSnapshot(null);
    setTradesState({
      symbol: normalizeContractSymbol(contractSymbol),
      trades: [],
      loading: true,
      error: null,
      source: null,
      freshness: null,
      updatedAt: null,
    });
    setPriceDirection('flat');

    void refreshMarketView();
    const timer = window.setInterval(() => {
      void refreshMarketView();
    }, 2000);

    return () => {
      requestSeqRef.current += 1;
      window.clearInterval(timer);
    };
  }, [contractSymbol, refreshMarketView]);

  useEffect(() => {
    const handleMarketStateMessage = (message: ContractMarketRealtimeMessage) => {
      const nextState = extractContractMarketStateMessage(message);
      if (!nextState) return;
      if (normalizeContractSymbol(nextState.symbol) !== normalizeContractSymbol(contractSymbol)) return;
      setWsState(nextState);
    };

    return contractMarketRealtime.subscribe('state', handleMarketStateMessage);
  }, [contractSymbol]);

  const activeRealtimeMarketView = normalizeContractSymbol(wsState?.symbol) === normalizeContractSymbol(contractSymbol)
    ? wsState
    : null;
  const activeRestMarketView = normalizeContractSymbol(restMarketView?.symbol) === normalizeContractSymbol(contractSymbol)
    ? restMarketView
    : null;
  const marketView = activeRealtimeMarketView || activeRestMarketView;
  const currentMarketViewLoading = marketViewLoading || Boolean(
    !marketView && (restMarketView || wsState),
  );
  const currentMarketViewError = marketViewErrorSymbolRef.current === normalizeContractSymbol(contractSymbol)
    ? marketViewError
    : null;

  const quote = quoteState.contractQuote;
  const marketStatus = quote?.market_status || fallbackMarketStatus || null;
  const marketStatusText = quote?.market_status_text || fallbackMarketStatusText || null;
  const quoteFreshness = quote?.quote_freshness || fallbackQuoteFreshness || null;
  const marketSessionType = quote?.market_session_type || fallbackMarketSessionType || null;
  const quoteStatusLoading = quoteState.contractQuoteLoading && (!quote || quote.executable === false);
  const quoteDisplayStatus = getContractQuoteDisplayStatus(quote, { loading: quoteStatusLoading });
  const rawMarketViewDisplayState = normalizeMarketViewDisplayState(marketView?.display_state);
  const marketViewDisplayState = normalizeMarketViewDisplayState(
    rawMarketViewDisplayState || (currentMarketViewLoading ? 'LOADING' : null),
  );
  const marketViewQuoteDisplayStatus = marketViewStateToQuoteStatus(marketViewDisplayState);
  const effectiveQuoteDisplayStatus = marketViewQuoteDisplayStatus || quoteDisplayStatus;
  const depthBelongsToCurrentSymbol = normalizeContractSymbol(depthState.symbol) === normalizeContractSymbol(contractSymbol);
  const activeDepthAsks = useMemo(
    () => (depthBelongsToCurrentSymbol ? depthState.asks : []),
    [depthBelongsToCurrentSymbol, depthState.asks],
  );
  const activeDepthBids = useMemo(
    () => (depthBelongsToCurrentSymbol ? depthState.bids : []),
    [depthBelongsToCurrentSymbol, depthState.bids],
  );
  const activeDepthSource = depthBelongsToCurrentSymbol ? depthState.source ?? null : null;
  const activeDepthMode = depthBelongsToCurrentSymbol ? depthState.depth_mode ?? null : null;
  const activeDepthMarketStatus = depthBelongsToCurrentSymbol ? depthState.market_status ?? null : null;
  const activeDepthExecutable = depthBelongsToCurrentSymbol ? depthState.executable ?? null : null;
  const activeDepthQuoteSource = depthBelongsToCurrentSymbol ? depthState.quote_source ?? null : null;
  const activeDepthQuoteFreshness = depthBelongsToCurrentSymbol ? depthState.quote_freshness ?? null : null;
  const activeDepthTs = depthBelongsToCurrentSymbol ? depthState.ts ?? null : null;
  const activeDepthClosedMarketExecutionMode = depthBelongsToCurrentSymbol
    ? depthState.closed_market_execution_mode ?? null
    : null;
  const activeDepthUpdatedAt = depthBelongsToCurrentSymbol ? depthState.updatedAt : null;
  const activeDepthLoading = depthState.loading || !depthBelongsToCurrentSymbol;
  const effectiveMarketStatus = marketStatus === 'CLOSED'
    || marketStatus === 'HOLIDAY'
    || activeDepthMarketStatus === 'CLOSED'
    || activeDepthMarketStatus === 'HOLIDAY'
    ? 'CLOSED'
    : marketStatus || activeDepthMarketStatus || null;

  const applyDepthSnapshot = useCallback((depth: ContractDepthSnapshot, options: { loading?: boolean; error?: string | null } = {}) => {
    const requestSymbol = normalizeContractSymbol(contractSymbol);
    const nextSymbol = normalizeContractSymbol(depth.symbol) || requestSymbol;
    if (nextSymbol !== requestSymbol) return;

    setDepthState({
      symbol: requestSymbol,
      asks: normalizeSide(depth.asks || [], 'asks', FUTURES_DEPTH_LIMIT),
      bids: normalizeSide(depth.bids || [], 'bids', FUTURES_DEPTH_LIMIT),
      source: depth.source || null,
      quote_freshness: depth.quote_freshness || null,
      quote_source: depth.quote_source || depth.source || null,
      depth_mode: depth.depth_mode || null,
      market_status: depth.market_status || null,
      executable: depth.executable ?? null,
      closed_market_execution_mode: depth.closed_market_execution_mode || null,
      ts: depth.ts || null,
      loading: options.loading ?? false,
      error: options.error ?? null,
      updatedAt: getTimestampMillis(depth.ts),
    });
  }, [contractSymbol]);

  const refreshDepth = useCallback(async () => {
    const requestSymbol = normalizeContractSymbol(contractSymbol);
    if (!requestSymbol) return;
    if (depthInFlightSymbolRef.current === requestSymbol) return;

    const requestSeq = depthRequestSeqRef.current + 1;
    depthRequestSeqRef.current = requestSeq;
    depthInFlightSymbolRef.current = requestSymbol;

    try {
      const depth = await getContractDepth(requestSymbol, FUTURES_DEPTH_LIMIT);
      if (
        !mountedRef.current
        || depthRequestSeqRef.current !== requestSeq
        || normalizeContractSymbol(depth.symbol) !== requestSymbol
      ) {
        return;
      }
      applyDepthSnapshot({
        symbol: depth.symbol || requestSymbol,
        asks: depth.asks,
        bids: depth.bids,
        source: depth.source,
        depth_mode: depth.depth_mode || null,
        quote_freshness: depth.quote_freshness || null,
        quote_source: depth.quote_source || depth.source || null,
        market_status: depth.market_status || null,
        executable: depth.executable ?? null,
        closed_market_execution_mode: depth.closed_market_execution_mode || null,
        ts: depth.ts || null,
      });
    } catch (error) {
      if (!mountedRef.current || depthRequestSeqRef.current !== requestSeq) return;
      setDepthState((current) => ({
        ...current,
        symbol: requestSymbol,
        loading: false,
        error: getErrorMessage(error),
      }));
    } finally {
      if (depthInFlightSymbolRef.current === requestSymbol) {
        depthInFlightSymbolRef.current = null;
      }
    }
  }, [applyDepthSnapshot, contractSymbol]);

  useEffect(() => {
    const requestSymbol = normalizeContractSymbol(contractSymbol);
    const cachedDepth = initialDepthRef.current;
    const cachedDepthSymbol = normalizeContractSymbol(cachedDepth?.symbol) || requestSymbol;
    const cachedDepthBelongsToCurrentSymbol = cachedDepthSymbol === requestSymbol;
    const cachedAsks = cachedDepthBelongsToCurrentSymbol ? cachedDepth?.asks || [] : [];
    const cachedBids = cachedDepthBelongsToCurrentSymbol ? cachedDepth?.bids || [] : [];

    setFallbackDepthAllowed(false);
    setLastFullDepthSnapshot(null);

    if (cachedAsks.length > 0 || cachedBids.length > 0) {
      const cachedDepthHasConfirmedStatus = cachedDepth?.executable !== undefined
        && cachedDepth?.executable !== null;
      applyDepthSnapshot({
        symbol: requestSymbol,
        asks: cachedAsks,
        bids: cachedBids,
        source: cachedDepth?.source || null,
        depth_mode: cachedDepth?.depth_mode || null,
        quote_freshness: cachedDepth?.quote_freshness || null,
        quote_source: cachedDepth?.quote_source || cachedDepth?.source || null,
        market_status: cachedDepth?.market_status || null,
        executable: cachedDepth?.executable ?? null,
        closed_market_execution_mode: cachedDepth?.closed_market_execution_mode || null,
        ts: cachedDepth?.ts || null,
      }, {
        loading: !cachedDepthHasConfirmedStatus,
      });
    } else {
      setDepthState({
        symbol: requestSymbol,
        asks: [],
        bids: [],
        source: null,
        quote_freshness: null,
        quote_source: null,
        depth_mode: null,
        market_status: null,
        executable: null,
        closed_market_execution_mode: null,
        ts: null,
        loading: true,
        error: null,
        updatedAt: null,
      });
    }

    const fallbackTimer = window.setTimeout(() => {
      setFallbackDepthAllowed(true);
    }, DEPTH_INITIAL_GRACE_MS);

    void refreshDepth();
    if (quoteMarketRealtimeStatus === 'connected') {
      return () => {
        depthRequestSeqRef.current += 1;
        window.clearTimeout(fallbackTimer);
      };
    }

    const timer = window.setInterval(() => {
      void refreshDepth();
    }, 1500);

    return () => {
      depthRequestSeqRef.current += 1;
      window.clearTimeout(fallbackTimer);
      window.clearInterval(timer);
    };
  }, [
    applyDepthSnapshot,
    contractSymbol,
    marketSessionRefreshKey,
    quoteMarketRealtimeStatus,
    refreshDepth,
  ]);

  useEffect(() => {
    const handleDepthMessage = (message: ContractMarketRealtimeMessage) => {
      if (effectiveMarketStatus === 'CLOSED') return;

      const depth = extractRealtimeDepth(message, contractSymbol);
      if (!depth) return;
      applyDepthSnapshot(depth);
    };

    return contractMarketRealtime.subscribe('depth', handleDepthMessage);
  }, [applyDepthSnapshot, contractSymbol, effectiveMarketStatus]);

  const applyTradesSnapshot = useCallback((trades: ContractMarketTrade[], options: { loading?: boolean; error?: string | null } = {}) => {
    const requestSymbol = normalizeContractSymbol(contractSymbol);
    const nextRows = trades.slice(0, FUTURES_TRADES_LIMIT);
    const latest = nextRows[0] || null;
    setTradesState({
      symbol: requestSymbol,
      trades: nextRows,
      loading: options.loading ?? false,
      error: options.error ?? null,
      source: latest?.source || latest?.quote_source || latest?.price_source || null,
      freshness: latest?.quote_freshness || null,
      updatedAt: latest ? normalizeTradeTime(latest.time ?? latest.ts) : null,
    });
    writeContractTradesCache(requestSymbol, {
      trades: nextRows,
      lastPrice: latest?.price ?? null,
    });
  }, [contractSymbol]);

  const refreshTrades = useCallback(async () => {
    const requestSymbol = normalizeContractSymbol(contractSymbol);
    if (!requestSymbol) return;
    if (effectiveMarketStatus === 'CLOSED') {
      setTradesState((current) => ({
        ...current,
        symbol: requestSymbol,
        loading: false,
      }));
      return;
    }
    if (tradesInFlightSymbolRef.current === requestSymbol) return;

    const requestSeq = tradesRequestSeqRef.current + 1;
    tradesRequestSeqRef.current = requestSeq;
    tradesInFlightSymbolRef.current = requestSymbol;

    try {
      const trades = await getContractMarketTrades(requestSymbol, FUTURES_TRADES_LIMIT);
      if (!mountedRef.current || tradesRequestSeqRef.current !== requestSeq) return;
      applyTradesSnapshot([...trades].reverse());
    } catch (error) {
      if (!mountedRef.current || tradesRequestSeqRef.current !== requestSeq) return;
      setTradesState((current) => ({
        ...current,
        symbol: requestSymbol,
        loading: false,
        error: getErrorMessage(error),
      }));
    } finally {
      if (tradesInFlightSymbolRef.current === requestSymbol) {
        tradesInFlightSymbolRef.current = null;
      }
    }
  }, [applyTradesSnapshot, contractSymbol, effectiveMarketStatus]);

  useEffect(() => {
    const requestSymbol = normalizeContractSymbol(contractSymbol);
    const cached = readContractTradesCache(requestSymbol);
    if (cached?.trades?.length) {
      applyTradesSnapshot(cached.trades.slice(0, FUTURES_TRADES_LIMIT), { loading: false });
    } else {
      setTradesState({
        symbol: requestSymbol,
        trades: [],
        loading: true,
        error: null,
        source: null,
        freshness: null,
        updatedAt: null,
      });
    }

    void refreshTrades();
    if (effectiveMarketStatus === 'CLOSED' || quoteMarketRealtimeStatus === 'connected') {
      return () => {
        tradesRequestSeqRef.current += 1;
      };
    }

    const timer = window.setInterval(() => {
      void refreshTrades();
    }, 1500);

    return () => {
      tradesRequestSeqRef.current += 1;
      window.clearInterval(timer);
    };
  }, [
    applyTradesSnapshot,
    contractSymbol,
    effectiveMarketStatus,
    quoteMarketRealtimeStatus,
    refreshTrades,
  ]);

  useEffect(() => {
    const handleTradeMessage = (message: ContractMarketRealtimeMessage) => {
      if (effectiveMarketStatus === 'CLOSED') return;

      const trades = extractRealtimeTrades(message, contractSymbol);
      if (trades.length === 0) return;

      setTradesState((current) => {
        if (normalizeContractSymbol(current.symbol) !== normalizeContractSymbol(contractSymbol)) {
          return current;
        }
        const nextRows = mergeTrades(trades, current.trades, FUTURES_TRADES_LIMIT);
        const latest = nextRows[0] || null;
        writeContractTradesCache(contractSymbol, {
          trades: nextRows,
          lastPrice: latest?.price ?? null,
        });
        return {
          symbol: normalizeContractSymbol(contractSymbol),
          trades: nextRows,
          loading: false,
          error: null,
          source: latest?.source || latest?.quote_source || latest?.price_source || null,
          freshness: latest?.quote_freshness || null,
          updatedAt: latest ? normalizeTradeTime(latest.time ?? latest.ts) : Date.now(),
        };
      });
    };

    return contractMarketRealtime.subscribe('trade', handleTradeMessage);
  }, [contractSymbol, effectiveMarketStatus]);

  const tradesBelongToCurrentSymbol = normalizeContractSymbol(tradesState.symbol) === normalizeContractSymbol(contractSymbol);
  const recentTrades = tradesBelongToCurrentSymbol ? tradesState.trades : [];
  const latestTrade = recentTrades[0] || null;
  const nextTrade = recentTrades[1] || null;
  const latestTradeNumber = getPositivePrice(latestTrade?.price);
  const nextTradeNumber = getPositivePrice(nextTrade?.price);
  const latestTradeSource = latestTrade?.price_source || latestTrade?.source || null;
  const latestTradeTickPrice = String(latestTrade?.price_source || '').trim().toUpperCase() === 'TRADE_TICK'
    ? latestTradeNumber
    : null;
  const latestTradeDirection: PriceDirection = latestTradeNumber !== null && nextTradeNumber !== null
    ? latestTradeNumber > nextTradeNumber
      ? 'up'
      : latestTradeNumber < nextTradeNumber
        ? 'down'
        : 'flat'
    : 'flat';

  const marketViewDisplayPrice = getPositivePrice(marketView?.display_price);
  const marketViewCurrentPriceSource = marketViewDisplayPrice !== null
    ? normalizeCurrentPriceSource(marketView?.current_price_source || marketView?.display_price_source) || 'LIVE_MID'
    : null;
  const marketViewTradePrice = marketViewCurrentPriceSource === 'TRADE_TICK'
    ? getPositivePrice(marketView?.last_trade_price ?? marketView?.display_price)
    : null;
  const tradeTickPrice = latestTradeTickPrice ?? getPositivePrice(lastTradePrice) ?? marketViewTradePrice;
  const liveDepthMidPrice = getPositivePrice(liveDepthBbo?.mid);
  const liveDepthMidFresh = liveDepthBbo?.source === 'LIVE_MID'
    && liveDepthMidPrice !== null
    && Date.now() - liveDepthBbo.updatedAt <= LIVE_DEPTH_BBO_TTL_MS;
  const chartClosePriceNumber = getPositivePrice(chartLastClose ?? localChartLastClose);
  const displayPriceSource: ContractCurrentPriceSource = tradeTickPrice !== null
    ? 'TRADE_TICK'
    : liveDepthMidFresh
      ? 'LIVE_MID'
      : marketViewCurrentPriceSource || 'KLINE_CLOSE';
  const displayPrice = tradeTickPrice !== null
    ? tradeTickPrice
    : liveDepthMidFresh
      ? liveDepthMidPrice
      : marketViewDisplayPrice !== null
        ? marketViewDisplayPrice
        : chartClosePriceNumber;
  const displayPriceReady = displayPrice !== null;
  const displayPriceLabel = displayPriceSource === 'TRADE_TICK'
    ? t('latestPrice', 'contracts')
    : displayPriceSource === 'LIVE_MID'
      ? t('midPrice', 'contracts')
      : t('klineLatestPrice', 'contracts');

  const marketUiState = useMemo<ContractMarketUiState>(() => {
    const executable = marketView?.executable ?? quote?.executable ?? null;
    const liveByMarketView = isLiveMarketState(rawMarketViewDisplayState);
    const liveBySession = isLiveMarketState(marketSessionType) || isLiveMarketState(marketStatus);
    const quoteLive = quoteDisplayStatus === 'LIVE';
    const isTradable = executable !== false && (liveByMarketView || liveBySession || quoteLive);

    if (!displayPriceReady) {
      return {
        label: t('marketDataLoadingLabel', 'contracts'),
        isLoading: true,
        isTradable: false,
        isRealtime: false,
        reason: 'CURRENT_PRICE_PENDING',
        status: 'LOADING',
      };
    }

    if (rawMarketViewDisplayState && isNonTradingMarketState(rawMarketViewDisplayState)) {
      return {
        label: getMarketViewStatusLabel(rawMarketViewDisplayState, t),
        isLoading: false,
        isTradable: false,
        isRealtime: false,
        reason: `MARKET_VIEW_${rawMarketViewDisplayState}`,
        status: 'UNAVAILABLE',
      };
    }

    if (liveByMarketView || liveBySession || quoteLive) {
      return {
        label: t('realtimeQuoteLabel', 'contracts'),
        isLoading: false,
        isTradable,
        isRealtime: true,
        reason: liveByMarketView ? 'MARKET_VIEW_LIVE' : liveBySession ? 'SESSION_LIVE' : 'QUOTE_LIVE',
        status: 'LIVE',
      };
    }

    if (currentMarketViewLoading && !marketView && quoteDisplayStatus === 'LOADING') {
      return {
        label: t('marketDataLoadingLabel', 'contracts'),
        isLoading: true,
        isTradable: false,
        isRealtime: false,
        reason: 'MARKET_VIEW_LOADING',
        status: 'LOADING',
      };
    }

    const fallbackStatus = effectiveQuoteDisplayStatus === 'LOADING' ? 'LAST_QUOTE' : effectiveQuoteDisplayStatus;
    return {
      label: rawMarketViewDisplayState
        ? getMarketViewStatusLabel(rawMarketViewDisplayState, t)
        : getContractQuoteStatusLabel(fallbackStatus, t),
      isLoading: false,
      isTradable,
      isRealtime: fallbackStatus === 'LIVE',
      reason: rawMarketViewDisplayState ? `MARKET_VIEW_${rawMarketViewDisplayState}` : `QUOTE_${fallbackStatus}`,
      status: fallbackStatus,
    };
  }, [
    displayPriceReady,
    effectiveQuoteDisplayStatus,
    marketSessionType,
    marketStatus,
    marketView,
    currentMarketViewLoading,
    quote?.executable,
    quoteDisplayStatus,
    rawMarketViewDisplayState,
    t,
  ]);

  const normalizedActiveDepthMode = String(activeDepthMode || '').trim().toUpperCase();
  useEffect(() => {
    if (normalizedActiveDepthMode !== 'FULL_DEPTH') return;
    if (!activeDepthAsks.length || !activeDepthBids.length) return;
    setLastFullDepthSnapshot({
      asks: activeDepthAsks,
      bids: activeDepthBids,
    });
  }, [activeDepthAsks, activeDepthBids, normalizedActiveDepthMode]);

  useEffect(() => {
    if (normalizedActiveDepthMode === 'FULL_DEPTH' || !lastFullDepthSnapshot) return undefined;
    const timer = window.setTimeout(() => {
      setLastFullDepthSnapshot(null);
    }, DEPTH_FULL_DEGRADE_GRACE_MS);
    return () => window.clearTimeout(timer);
  }, [lastFullDepthSnapshot, normalizedActiveDepthMode]);

  const hasRawDepthRows = activeDepthAsks.length > 0 || activeDepthBids.length > 0;
  const hasFullDepth = normalizedActiveDepthMode === 'FULL_DEPTH';
  const shouldHoldPreviousFullDepth = !hasFullDepth && !!lastFullDepthSnapshot;
  const shouldDelayFallbackDepth = hasRawDepthRows
    && !hasFullDepth
    && !fallbackDepthAllowed
    && !shouldHoldPreviousFullDepth;
  const depthAsks = useMemo(() => {
    if (hasFullDepth) return activeDepthAsks;
    if (shouldHoldPreviousFullDepth) return lastFullDepthSnapshot?.asks || [];
    if (fallbackDepthAllowed) return activeDepthAsks;
    return [];
  }, [activeDepthAsks, fallbackDepthAllowed, hasFullDepth, lastFullDepthSnapshot, shouldHoldPreviousFullDepth]);
  const depthBids = useMemo(() => {
    if (hasFullDepth) return activeDepthBids;
    if (shouldHoldPreviousFullDepth) return lastFullDepthSnapshot?.bids || [];
    if (fallbackDepthAllowed) return activeDepthBids;
    return [];
  }, [activeDepthBids, fallbackDepthAllowed, hasFullDepth, lastFullDepthSnapshot, shouldHoldPreviousFullDepth]);
  const depthMode = hasFullDepth
    ? activeDepthMode
    : shouldHoldPreviousFullDepth
      ? 'FULL_DEPTH'
      : fallbackDepthAllowed
        ? activeDepthMode
        : null;
  const depthLoading = activeDepthLoading || shouldDelayFallbackDepth;
  const depthBestBid = maxPrice(activeDepthBids);
  const depthBestAsk = minPrice(activeDepthAsks);
  const depthBestBidNumber = getPositivePrice(depthBestBid);
  const depthBestAskNumber = getPositivePrice(depthBestAsk);
  const liveMidPrice = depthBestBidNumber !== null && depthBestAskNumber !== null && depthBestAskNumber >= depthBestBidNumber
    ? (depthBestBidNumber + depthBestAskNumber) / 2
    : null;

  useEffect(() => {
    handleDepthBestPricesChange({
      bestBid: depthBestBid,
      bestAsk: depthBestAsk,
      ts: activeDepthTs,
    });
  }, [activeDepthTs, depthBestAsk, depthBestBid, handleDepthBestPricesChange]);

  useEffect(() => {
    if (!depthBelongsToCurrentSymbol) return;
    if (!activeDepthAsks.length && !activeDepthBids.length) return;
    handleDepthSnapshotChange({
      symbol: contractSymbol,
      asks: activeDepthAsks,
      bids: activeDepthBids,
      source: activeDepthSource,
      depth_mode: activeDepthMode,
      quote_freshness: activeDepthQuoteFreshness,
      quote_source: activeDepthQuoteSource || activeDepthSource,
      market_status: activeDepthMarketStatus,
      executable: activeDepthExecutable,
      closed_market_execution_mode: activeDepthClosedMarketExecutionMode,
      ts: activeDepthTs,
    });
  }, [
    activeDepthAsks,
    activeDepthBids,
    activeDepthClosedMarketExecutionMode,
    activeDepthExecutable,
    activeDepthMarketStatus,
    activeDepthMode,
    activeDepthQuoteFreshness,
    activeDepthQuoteSource,
    activeDepthSource,
    activeDepthTs,
    contractSymbol,
    depthBelongsToCurrentSymbol,
    handleDepthSnapshotChange,
  ]);

  useEffect(() => {
    if (depthBestBidNumber !== null && depthBestAskNumber !== null && liveMidPrice !== null) {
      setLiveDepthBbo({
        bid: depthBestBidNumber,
        ask: depthBestAskNumber,
        mid: liveMidPrice,
        source: 'LIVE_MID',
        updatedAt: activeDepthUpdatedAt ?? Date.now(),
      });
      return;
    }
    setLiveDepthBbo(null);
  }, [activeDepthUpdatedAt, depthBestAskNumber, depthBestBidNumber, liveMidPrice]);

  const depthExpiredLastGoodQuote = isExpiredLastGoodBboQuote({
    executable: activeDepthExecutable ?? undefined,
    market_status: activeDepthMarketStatus || effectiveMarketStatus || undefined,
    closed_market_execution_mode: activeDepthClosedMarketExecutionMode || undefined,
    quote_freshness: activeDepthQuoteFreshness || undefined,
    quote_source: activeDepthQuoteSource || undefined,
    source: activeDepthSource || undefined,
  });
  const hasConfirmedDepthStatus = activeDepthExecutable !== null || depthExpiredLastGoodQuote;
  const depthStatusLoading = activeDepthLoading && !hasConfirmedDepthStatus;
  const ownDepthDisplayStatus = getContractQuoteDisplayStatus({
    executable: activeDepthExecutable ?? undefined,
    market_status: activeDepthMarketStatus || effectiveMarketStatus || undefined,
    closed_market_execution_mode: activeDepthClosedMarketExecutionMode || undefined,
    quote_freshness: activeDepthQuoteFreshness || undefined,
    quote_source: activeDepthQuoteSource || undefined,
    source: activeDepthSource || undefined,
  }, {
    loading: depthStatusLoading,
  });
  const quoteFallbackDisplayStatus = getContractQuoteDisplayStatus(quote, {
    loading: quoteStatusLoading && !quote,
  });
  const shouldUseQuoteFallbackStatus = !hasConfirmedDepthStatus
    && quoteFallbackDisplayStatus !== 'UNAVAILABLE';
  const fallbackDepthDisplayStatus = shouldUseQuoteFallbackStatus
    ? quoteFallbackDisplayStatus
    : ownDepthDisplayStatus;
  const depthStatus = marketUiState.status || (
    displayPriceReady
      ? (marketViewQuoteDisplayStatus || fallbackDepthDisplayStatus)
      : 'LOADING'
  );
  const depthStatusLabel = marketUiState.label || (!displayPriceReady
    ? t('marketDataLoadingLabel', 'contracts')
    : rawMarketViewDisplayState && marketViewQuoteDisplayStatus
    ? getMarketViewStatusLabel(rawMarketViewDisplayState, t)
    : getContractQuoteStatusLabel(depthStatus, t));

  const contractKlineMode: ContractKlineMode = 'PROVIDER_KLINE';
  const derivedMarketState = useMemo<ContractMarketCenterState>(() => {
    const liveBid = liveDepthMidFresh ? getPositivePrice(liveDepthBbo?.bid) : null;
    const liveAsk = liveDepthMidFresh ? getPositivePrice(liveDepthBbo?.ask) : null;
    const marketViewBid = getPositivePrice(marketView?.best_bid);
    const marketViewAsk = getPositivePrice(marketView?.best_ask);
    const quoteBid = getPositivePrice(quote?.best_bid ?? quote?.bid_price ?? quote?.bid);
    const quoteAsk = getPositivePrice(quote?.best_ask ?? quote?.ask_price ?? quote?.ask);
    const nextBestBid = liveBid ?? marketViewBid ?? getPositivePrice(quoteState.bestBid) ?? quoteBid;
    const nextBestAsk = liveAsk ?? marketViewAsk ?? getPositivePrice(quoteState.bestAsk) ?? quoteAsk;
    const nextSpread = nextBestBid !== null && nextBestAsk !== null && nextBestAsk >= nextBestBid
      ? nextBestAsk - nextBestBid
      : null;
    const quoteTime = marketView?.quote_time ? Date.parse(String(marketView.quote_time)) : NaN;

    return {
      symbol: contractSymbol,
      displayPrice,
      displayPriceSource,
      displayPriceLabel,
      bestBid: nextBestBid,
      bestAsk: nextBestAsk,
      spread: nextSpread,
      executionBid: getPositivePrice(marketView?.execution_bid),
      executionAsk: getPositivePrice(marketView?.execution_ask),
      latestTradePrice: tradeTickPrice,
      latestTradePriceSource: tradeTickPrice !== null ? 'TRADE_TICK' : null,
      klineMode: contractKlineMode,
      klineCurrentCandle: marketView?.kline_current_candle ?? null,
      quoteFreshness,
      displayState: rawMarketViewDisplayState || marketSessionType || marketStatus || null,
      executable: marketView?.executable ?? quote?.executable ?? null,
      updatedAt: liveDepthMidFresh && liveDepthBbo
        ? liveDepthBbo.updatedAt
        : Number.isFinite(quoteTime)
          ? quoteTime
          : Date.now(),
    };
  }, [
    contractKlineMode,
    contractSymbol,
    displayPrice,
    displayPriceLabel,
    displayPriceSource,
    liveDepthBbo,
    liveDepthMidFresh,
    marketSessionType,
    marketStatus,
    marketView,
    quote,
    quoteFreshness,
    quoteState.bestAsk,
    quoteState.bestBid,
    rawMarketViewDisplayState,
    tradeTickPrice,
  ]);

  const handleLatestKlineCloseChange = useCallback((value: string | null) => {
    const nextPrice = getPositivePrice(value);
    setLocalChartLastClose(nextPrice === null ? null : String(nextPrice));
  }, []);

  const handleLastTradePriceChange = useCallback((
    value: string,
    source?: string | null,
    trade?: ContractMarketTrade,
  ) => {
    const normalizedSource = String(source || trade?.price_source || '').trim().toUpperCase();
    const nextPrice = getPositivePrice(value);
    if (normalizedSource !== 'TRADE_TICK' || nextPrice === null) {
      setLastTradePrice(null);
      return;
    }
    setLastTradePrice(String(nextPrice));
  }, []);

  const handleLiveBboChange = useCallback((payload: LiveDepthBbo) => {
    const bid = getPositivePrice(payload.bid);
    const ask = getPositivePrice(payload.ask);
    const mid = getPositivePrice(payload.mid);
    if (payload.source !== 'LIVE_MID' || bid === null || ask === null || mid === null || ask < bid) {
      setLiveDepthBbo(null);
      return;
    }
    setLiveDepthBbo({
      bid,
      ask,
      mid,
      source: 'LIVE_MID',
      updatedAt: payload.updatedAt,
    });
  }, []);

  useEffect(() => {
    const source = String(marketView?.current_price_source || marketView?.display_price_source || '').trim().toUpperCase();
    const price = marketView?.last_trade_price || null;
    const nextPrice = getPositivePrice(price);
    if (source === 'TRADE_TICK' && nextPrice !== null) {
      setLastTradePrice(String(nextPrice));
    } else {
      setLastTradePrice(null);
    }
  }, [marketView]);

  useEffect(() => {
    if (!liveDepthBbo || liveDepthBbo.mid === null) return undefined;
    const age = Date.now() - liveDepthBbo.updatedAt;
    const delay = Math.max(0, LIVE_DEPTH_BBO_TTL_MS - age) + 50;
    const timer = window.setTimeout(() => {
      setLiveDepthBbo((current) => (
        current?.updatedAt === liveDepthBbo.updatedAt ? null : current
      ));
    }, delay);
    return () => window.clearTimeout(timer);
  }, [liveDepthBbo]);

  useEffect(() => {
    const nextPrice = displayPrice;
    if (nextPrice === null) {
      currentPriceRef.current = null;
      setPriceDirection('flat');
      return;
    }

    const previousPrice = currentPriceRef.current;
    if (previousPrice === null) {
      setPriceDirection('flat');
    } else {
      setPriceDirection(nextPrice > previousPrice ? 'up' : nextPrice < previousPrice ? 'down' : 'flat');
    }
    currentPriceRef.current = nextPrice;
  }, [displayPrice]);

  useEffect(() => {
    const previousState = previousMarketViewDisplayStateRef.current;
    const currentState = rawMarketViewDisplayState || marketSessionType || marketStatus || null;
    if (
      previousState
      && isNonTradingMarketState(previousState)
      && isLiveMarketState(currentState)
    ) {
      setMarketSessionRefreshKey((value) => value + 1);
    }
    previousMarketViewDisplayStateRef.current = currentState;
  }, [marketSessionType, marketStatus, rawMarketViewDisplayState]);

  const marketStateBestBid = derivedMarketState.bestBid === null ? null : String(derivedMarketState.bestBid);
  const marketStateBestAsk = derivedMarketState.bestAsk === null ? null : String(derivedMarketState.bestAsk);
  const quoteStatusLabel = marketUiState.label;
  const quoteStatusTone = getContractQuoteStatusTone(marketUiState.status);
  const expiredLastGoodQuote = isExpiredLastGoodBboQuote(quote);
  const tickerSource = marketView?.ticker_source ?? quote?.quote_source ?? quote?.source ?? null;
  const tickerFreshness = marketView?.ticker_freshness ?? quoteFreshness;
  const marketViewDepthSource = marketView?.depth_source ?? null;
  const marketViewDepthFreshness = marketView?.depth_freshness ?? null;
  const marketViewTradesSource = marketView?.trades_source ?? null;
  const marketViewTradesFreshness = marketView?.trades_freshness ?? null;
  const klineSource = marketView?.kline_source ?? marketView?.kline_current_candle?.kline_mode ?? null;
  const klineFreshness = marketView?.kline_freshness ?? null;
  const resolvedDepthSource = activeDepthSource ?? marketViewDepthSource;
  const resolvedDepthFreshness = activeDepthQuoteFreshness ?? marketViewDepthFreshness;
  const activeTradesSource = tradesBelongToCurrentSymbol ? tradesState.source : null;
  const activeTradesFreshness = tradesBelongToCurrentSymbol ? tradesState.freshness : null;
  const resolvedTradesSource = activeTradesSource ?? marketViewTradesSource;
  const resolvedTradesFreshness = activeTradesFreshness ?? marketViewTradesFreshness;
  const tickerSourceLabel = getContractMarketSourceLabel(tickerSource, tickerFreshness, t);
  const depthSourceLabel = getContractMarketSourceLabel(resolvedDepthSource, resolvedDepthFreshness, t);
  const tradesSourceLabel = getContractMarketSourceLabel(resolvedTradesSource, resolvedTradesFreshness, t);
  const klineSourceLabel = getContractMarketSourceLabel(klineSource, klineFreshness, t);

  return {
    ...quoteState,
    marketView,
    marketViewLoading: currentMarketViewLoading,
    marketViewError: currentMarketViewError,
    displayPrice,
    displayState: rawMarketViewDisplayState,
    displayPriceSource,
    displayPriceLabel,
    depthBids,
    depthAsks,
    depthLoading,
    depthError: depthBelongsToCurrentSymbol ? depthState.error : null,
    tickerSource,
    tickerFreshness,
    tickerSourceLabel,
    depthSource: resolvedDepthSource,
    depthFreshness: resolvedDepthFreshness,
    depthSourceLabel,
    marketViewDepthSource,
    marketViewDepthFreshness,
    depthUpdatedAt: activeDepthUpdatedAt,
    depthMode,
    depthStatus,
    depthStatusLabel,
    liveMidPrice,
    recentTrades,
    tradesLoading: tradesBelongToCurrentSymbol ? tradesState.loading : true,
    tradesError: tradesBelongToCurrentSymbol ? tradesState.error : null,
    tradesSource: resolvedTradesSource,
    tradesFreshness: resolvedTradesFreshness,
    tradesSourceLabel,
    marketViewTradesSource,
    marketViewTradesFreshness,
    klineSource,
    klineFreshness,
    klineSourceLabel,
    latestTradePrice: latestTradeTickPrice,
    latestTradeDirection,
    latestTradeSource,
    bestBid: derivedMarketState.bestBid,
    bestAsk: derivedMarketState.bestAsk,
    spread: derivedMarketState.spread,
    executable: derivedMarketState.executable,
    executionBid: derivedMarketState.executionBid,
    executionAsk: derivedMarketState.executionAsk,
    executionMode: marketView?.execution_mode ?? null,
    reasonCode: marketView?.reason_code ?? null,
    warnings: marketView?.warnings ?? [],
    rawSourceSummary: marketView?.raw_source_summary ?? {},
    quote,
    wsState,
    refreshMarketView,
    marketState: derivedMarketState,
    marketStateBestBid,
    marketStateBestAsk,
    marketUiState,
    marketStatus,
    marketStatusText,
    quoteFreshness,
    marketSessionType,
    quoteStatusLoading,
    quoteStatusLabel,
    quoteStatusTone,
    quoteDisplayStatus,
    currentPriceReady: displayPrice !== null,
    priceDirection,
    marketSessionRefreshKey,
    expiredLastGoodQuote,
    handleLatestKlineCloseChange,
    handleLastTradePriceChange,
    handleLiveBboChange,
  };
}
