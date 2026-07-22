'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toNumber } from '@/components/contract/contractFormat';
import { getContractMarketSourceLabel } from '@/components/contract/contractMarketSourceStatus';
import { parseContractMarketTimestamp } from '@/components/contract/contractMarketTimestamp';
import { normalizeSide } from '@/components/spot/orderbook/orderbook.utils';
import { useLocaleContext } from '@/contexts/LocaleContext';
import {
  getContractDepth,
  getContractMarketTrades,
  getContractMarketView,
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
  isContractKlineDomainMessage,
  isContractMarketDomainMessage,
  type ContractMarketRealtimeMessage,
} from '@/lib/realtime/contractMarketRealtime';
import {
  readContractTradesCache,
  writeContractTradesCache,
} from '@/lib/contractMarketCache';
import {
  useContractMarketState,
} from './useContractMarketState';
import {
  advanceContractPriceDirection,
  createContractPriceDirectionState,
  type ContractPriceDirection,
} from '../contractPriceDirection';
import { useContractMarketViewPolling } from './useContractMarketViewPolling';
import {
  resolveContractRestBootstrap,
  type ContractRestBootstrapCursor,
} from './contractRestBootstrapPolicy';
import { resolveContractDepthBootstrapPresentation } from './contractDepthBootstrapPolicy';
import {
  CONTRACT_MARKET_STORE_RECOVERY_MAX_AGE_MS,
  hydrateContractMarketRestDomain,
  hydrateContractMarketViewShadow,
  ingestContractMarketWsDomain,
  projectContractMarketViewStoreAuthority,
  useContractMarketViewStoreAuthoritySnapshot,
} from './contractMarketStoreAdapter';
import {
  normalizeContractMarketViewDisplayState,
  readContractMarketViewAuthority,
  resolveContractMarketViewAuthorityPresentation,
  shouldHoldContractMarketViewBootstrap,
  shouldExposeContractMarketDepth,
  type ContractMarketViewAuthorityState,
} from '../contractMarketView.utils';
import {
  buildContractPriceAuthority,
  selectContractReferencePrice,
} from '../contractPriceAuthority';
import { orderContractTradesNewestFirst } from '../contractTradeOrdering';
import { useContractMarketTransportRecovery } from './useContractMarketTransportRecovery';

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
  displayPriceSource: ContractCurrentPriceSource | null;
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
  updatedAt: number | null;
};

type UseContractMarketViewParams = {
  contractSymbol: string;
  symbolOptionMarketSymbol?: string | null;
  symbolOptionPricePrecision?: number | null;
  fallbackMarketStatus?: string | null;
  fallbackMarketStatusText?: string | null;
  fallbackMarketSessionType?: string | null;
  fallbackQuoteFreshness?: string | null;
  fallbackLastPrice?: string | number | null;
  fallbackLastPriceSource?: string | null;
  fallbackLastPriceTime?: string | number | null;
};

const FUTURES_DEPTH_LIMIT = 20;
const FUTURES_TRADES_LIMIT = 30;
const DEPTH_INITIAL_GRACE_MS = 1800;
const REST_BOOTSTRAP_GRACE_MS = 750;
const MARKET_VIEW_INITIAL_BOOTSTRAP_GRACE_MS = 1500;
const MARKET_STATE_STORE_DOMAINS = ['ticker', 'depth', 'trades'] as const;

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

function isLiveMarketState(value?: string | null) {
  const state = normalizeContractMarketViewDisplayState(value);
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
  const state = normalizeContractMarketViewDisplayState(value);
  return (
    state === 'PRE_MARKET'
    || state === 'AFTER_HOURS'
    || state === 'CLOSED'
    || state === 'MARKET_CLOSED'
    || state === 'HOLIDAY'
    || state === 'EXPIRED'
  );
}

function getMarketViewStatusLabel(
  state: ContractMarketViewAuthorityState,
  t: (key: string, namespace?: 'contracts') => string,
) {
  if (state === 'loading') return t('marketDataLoadingLabel', 'contracts');
  if (state === 'live') return t('realtimeQuoteLabel', 'contracts');
  if (state === 'pre_market') return '盘前';
  if (state === 'after_hours') return '盘后';
  if (state === 'closed') return '闭市中';
  if (state === 'holiday') return '休市中';
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
  return parseContractMarketTimestamp(value as string | number | null | undefined);
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
  const normalized = getTradePayloads(message)
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

      const time = normalizeTradeTime(
        payload.event_time_ms
        ?? payload.provider_event_time_ms
        ?? payload.time
        ?? payload.ts
        ?? payload.timestamp
        ?? payload.exchange_ts,
      );
      if (time === null) return [];
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
  return orderContractTradesNewestFirst(normalized, FUTURES_TRADES_LIMIT);
}

function mergeTrades(
  incoming: ContractMarketTrade[],
  previous: ContractMarketTrade[],
  limit = FUTURES_TRADES_LIMIT,
) {
  return orderContractTradesNewestFirst([...incoming, ...previous], limit);
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
  return parseContractMarketTimestamp(value) ?? Date.now();
}

export function useContractMarketView({
  contractSymbol,
  symbolOptionMarketSymbol,
  symbolOptionPricePrecision,
  fallbackMarketStatus,
  fallbackMarketStatusText,
  fallbackMarketSessionType,
  fallbackQuoteFreshness,
  fallbackLastPrice,
  fallbackLastPriceSource,
  fallbackLastPriceTime,
}: UseContractMarketViewParams) {
  const { t } = useLocaleContext();
  const [restMarketView, setRestMarketView] = useState<ContractMarketViewDetail | null>(null);
  const [wsState, setWsState] = useState<ContractMarketViewDetail | null>(null);
  const [marketViewLoading, setMarketViewLoading] = useState(true);
  const [marketViewError, setMarketViewError] = useState<string | null>(null);
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
  const [priceDirection, setPriceDirection] = useState<ContractPriceDirection>('flat');
  const [storeAuthorityEvaluationTimeMs, setStoreAuthorityEvaluationTimeMs] = useState(0);
  const [marketSessionRefreshKey, setMarketSessionRefreshKey] = useState(0);
  const [marketViewBootstrapGrace, setMarketViewBootstrapGrace] = useState(() => ({
    symbol: normalizeContractSymbol(contractSymbol),
    active: true,
  }));
  const requestSeqRef = useRef(0);
  const inFlightSymbolRef = useRef<string | null>(null);
  const marketViewAbortControllerRef = useRef<AbortController | null>(null);
  const depthRequestSeqRef = useRef(0);
  const depthInFlightSymbolRef = useRef<string | null>(null);
  const depthRestBootstrapRef = useRef<ContractRestBootstrapCursor>({
    key: null,
    realtimeStatus: 'idle',
  });
  const tradesRequestSeqRef = useRef(0);
  const tradesInFlightSymbolRef = useRef<string | null>(null);
  const tradesRestBootstrapRef = useRef<ContractRestBootstrapCursor>({
    key: null,
    realtimeStatus: 'idle',
  });
  const marketViewErrorSymbolRef = useRef<string | null>(null);
  const mountedRef = useRef(false);
  const priceDirectionStateRef = useRef(createContractPriceDirectionState(contractSymbol));
  const previousMarketViewDisplayStateRef = useRef<string | null>(null);

  const quoteState = useContractMarketState({
    contractSymbol,
    symbolOptionMarketSymbol,
    symbolOptionPricePrecision,
  });
  const storeMarketViewAuthority = useContractMarketViewStoreAuthoritySnapshot(contractSymbol);
  const {
    initialDepth,
    marketRealtimeStatus: quoteMarketRealtimeStatus,
    handleBestPricesChange: handleDepthBestPricesChange,
    handleDepthDataChange: handleDepthSnapshotChange,
  } = quoteState;
  const transportRecovery = useContractMarketTransportRecovery(
    contractSymbol,
    quoteMarketRealtimeStatus,
  );
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
    const abortController = new AbortController();
    marketViewAbortControllerRef.current = abortController;

    try {
      const view = await getContractMarketView(requestSymbol, { signal: abortController.signal });
      if (
        !mountedRef.current
        || requestSeqRef.current !== requestSeq
        || normalizeContractSymbol(view.symbol) !== requestSymbol
      ) {
        return;
      }
      hydrateContractMarketViewShadow(view, 'REST');
      setRestMarketView(view);
      marketViewErrorSymbolRef.current = null;
      setMarketViewError(null);
    } catch (error) {
      if (abortController.signal.aborted) return;
      if (!mountedRef.current || requestSeqRef.current !== requestSeq) return;
      setRestMarketView(null);
      marketViewErrorSymbolRef.current = requestSymbol;
      setMarketViewError(getErrorMessage(error));
    } finally {
      if (inFlightSymbolRef.current === requestSymbol) {
        inFlightSymbolRef.current = null;
      }
      if (marketViewAbortControllerRef.current === abortController) {
        marketViewAbortControllerRef.current = null;
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
      marketViewAbortControllerRef.current?.abort();
      marketViewAbortControllerRef.current = null;
    };
  }, []);

  useEffect(() => {
    marketViewAbortControllerRef.current?.abort();
    marketViewAbortControllerRef.current = null;
    requestSeqRef.current += 1;
    inFlightSymbolRef.current = null;
    depthRequestSeqRef.current += 1;
    depthInFlightSymbolRef.current = null;
    tradesRequestSeqRef.current += 1;
    tradesInFlightSymbolRef.current = null;
    priceDirectionStateRef.current = createContractPriceDirectionState(contractSymbol);
    previousMarketViewDisplayStateRef.current = null;
    marketViewErrorSymbolRef.current = null;
    setRestMarketView(null);
    setWsState(null);
    setMarketViewError(null);
    setMarketViewLoading(true);
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

    return () => {
      marketViewAbortControllerRef.current?.abort();
      marketViewAbortControllerRef.current = null;
      requestSeqRef.current += 1;
    };
  }, [contractSymbol, refreshMarketView]);

  useEffect(() => {
    const symbol = normalizeContractSymbol(contractSymbol);
    setMarketViewBootstrapGrace({ symbol, active: true });
    const timer = window.setTimeout(() => {
      setMarketViewBootstrapGrace((current) => (
        current.symbol === symbol ? { symbol, active: false } : current
      ));
    }, MARKET_VIEW_INITIAL_BOOTSTRAP_GRACE_MS);
    return () => window.clearTimeout(timer);
  }, [contractSymbol]);

  useEffect(() => {
    const handleMarketStateMessage = (message: ContractMarketRealtimeMessage) => {
      if (!isContractMarketDomainMessage(message)) return;
      const nextState = extractContractMarketStateMessage(message);
      if (!nextState) return;
      if (normalizeContractSymbol(nextState.symbol) !== normalizeContractSymbol(contractSymbol)) return;
      // Market-state frames own Header, execution quote/depth and recent trades.
      // Native K-line authority is ingested only from the dedicated K-line
      // channel below. Rehydrating the embedded candle on every market-state
      // tick can replay an older Native OPEN over a newer trade preview and
      // makes TradingView wait for the next provider candle before recovering.
      const storeResults = hydrateContractMarketViewShadow(
        nextState,
        'WS',
        MARKET_STATE_STORE_DOMAINS,
      );
      const tickerAccepted = storeResults.some((result) => (
        result.accepted && result.entry?.domain === 'ticker'
      ));
      if (!tickerAccepted) return;
      setWsState(nextState);
    };

    return contractMarketRealtime.subscribe('state', handleMarketStateMessage);
  }, [contractSymbol]);

  useEffect(() => {
    if (!transportRecovery.recoveryExpired) return;

    setWsState(null);
    setDepthState((current) => ({
      ...current,
      symbol: normalizeContractSymbol(contractSymbol),
      asks: [],
      bids: [],
      loading: true,
      error: null,
    }));
    setTradesState((current) => ({
      ...current,
      symbol: normalizeContractSymbol(contractSymbol),
      trades: [],
      loading: true,
      error: null,
      source: null,
      freshness: null,
      updatedAt: null,
    }));
  }, [contractSymbol, transportRecovery.recoveryExpired]);

  useEffect(() => {
    if (transportRecovery.reconnectGeneration <= 0) return;

    // Supersede a request that may have been left waiting while the backend
    // process was down. The new Store generation is owned by
    // useContractMarketState; this hook rehydrates its full MarketView
    // authority and re-arms depth/trade REST bootstrap for the same symbol.
    requestSeqRef.current += 1;
    marketViewAbortControllerRef.current?.abort();
    marketViewAbortControllerRef.current = null;
    inFlightSymbolRef.current = null;
    setWsState(null);
    setMarketViewError(null);
    marketViewErrorSymbolRef.current = null;
    setMarketViewLoading(true);
    setMarketSessionRefreshKey((value) => value + 1);
    void refreshMarketView();
  }, [
    refreshMarketView,
    transportRecovery.reconnectGeneration,
  ]);

  const activeRealtimeMarketView = transportRecovery.preserveRealtimeAuthority
    && normalizeContractSymbol(wsState?.symbol) === normalizeContractSymbol(contractSymbol)
    ? wsState
    : null;
  const activeRestMarketView = normalizeContractSymbol(restMarketView?.symbol) === normalizeContractSymbol(contractSymbol)
    ? restMarketView
    : null;
  useEffect(() => {
    if (
      !transportRecovery.preserveRealtimeAuthority
      || !storeMarketViewAuthority?.hasRealtimeAuthority
      || storeMarketViewAuthority.tickerObservedAtMs <= 0
    ) return undefined;
    const tickerExpiresAt = storeMarketViewAuthority.tickerObservedAtMs
      + CONTRACT_MARKET_STORE_RECOVERY_MAX_AGE_MS;
    const bboExpiresAt = storeMarketViewAuthority.executable === true
      && storeMarketViewAuthority.bboObservedAtMs > 0
      ? storeMarketViewAuthority.bboObservedAtMs
        + CONTRACT_MARKET_STORE_RECOVERY_MAX_AGE_MS
      : Number.POSITIVE_INFINITY;
    const expiresAt = Math.min(tickerExpiresAt, bboExpiresAt);
    const remainingMs = expiresAt - Date.now();
    if (remainingMs <= 0) return undefined;
    const timer = window.setTimeout(() => {
      setStoreAuthorityEvaluationTimeMs(Date.now());
    }, remainingMs + 1);
    return () => window.clearTimeout(timer);
  }, [
    transportRecovery.preserveRealtimeAuthority,
    storeAuthorityEvaluationTimeMs,
    storeMarketViewAuthority,
  ]);
  const storeMarketView = useMemo(
    () => transportRecovery.preserveRealtimeAuthority
      ? projectContractMarketViewStoreAuthority(
        storeMarketViewAuthority,
        activeRestMarketView,
        Math.max(Date.now(), storeAuthorityEvaluationTimeMs),
      )
      : null,
    [
      activeRestMarketView,
      transportRecovery.preserveRealtimeAuthority,
      storeAuthorityEvaluationTimeMs,
      storeMarketViewAuthority,
    ],
  );
  const marketView = storeMarketView || activeRestMarketView || activeRealtimeMarketView;
  const marketViewRecoveryRequired = quoteMarketRealtimeStatus === 'connected' && (
    !marketView
    || normalizeContractMarketViewDisplayState(marketView.display_state) === 'MARKET_DATA_UNAVAILABLE'
    || normalizeContractMarketViewDisplayState(marketView.display_state) === 'UNAVAILABLE'
    || normalizeContractMarketViewDisplayState(marketView.display_state) === 'UNKNOWN'
  );
  useContractMarketViewPolling({
    symbol: contractSymbol,
    realtimeStatus: quoteMarketRealtimeStatus,
    recoveryRequired: marketViewRecoveryRequired,
    refresh: refreshMarketView,
  });
  const currentMarketViewLoading = marketViewLoading || Boolean(
    !marketView && (restMarketView || wsState),
  );
  const currentMarketViewError = marketViewErrorSymbolRef.current === normalizeContractSymbol(contractSymbol)
    ? marketViewError
    : null;

  const quote = quoteState.contractQuote;
  const marketStatus = quote?.market_status || fallbackMarketStatus || null;
  const marketStatusText = quote?.market_status_text || fallbackMarketStatusText || null;
  const marketSessionType = quote?.market_session_type || fallbackMarketSessionType || null;
  const marketViewAuthority = useMemo(
    () => readContractMarketViewAuthority(marketView),
    [marketView],
  );
  const rawMarketViewDisplayState = marketViewAuthority.displayState;
  const marketViewBootstrapGraceActive = marketViewBootstrapGrace.symbol
    !== normalizeContractSymbol(contractSymbol)
    || marketViewBootstrapGrace.active;
  const depthBelongsToCurrentSymbol = normalizeContractSymbol(depthState.symbol) === normalizeContractSymbol(contractSymbol);
  const activeDepthAsks = useMemo(
    () => (depthBelongsToCurrentSymbol ? depthState.asks : []),
    [depthBelongsToCurrentSymbol, depthState.asks],
  );
  const activeDepthBids = useMemo(
    () => (depthBelongsToCurrentSymbol ? depthState.bids : []),
    [depthBelongsToCurrentSymbol, depthState.bids],
  );
  const hasActiveDepthRows = activeDepthAsks.length > 0 || activeDepthBids.length > 0;
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
      const storeResult = hydrateContractMarketRestDomain({
        symbol: requestSymbol,
        domain: 'depth',
        data: depth,
        metadata: depth,
      });
      if (!storeResult.accepted) return;
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

    return () => window.clearTimeout(fallbackTimer);
  }, [applyDepthSnapshot, contractSymbol, marketSessionRefreshKey]);

  useEffect(() => {
    const requestSymbol = normalizeContractSymbol(contractSymbol);
    const bootstrapKey = `${requestSymbol}|${marketSessionRefreshKey}`;
    const lostRealtime = depthRestBootstrapRef.current.realtimeStatus === 'connected'
      && quoteMarketRealtimeStatus !== 'connected';
    const decision = resolveContractRestBootstrap(
      depthRestBootstrapRef.current,
      bootstrapKey,
      quoteMarketRealtimeStatus,
      {
        hasUsableSnapshot: hasActiveDepthRows,
        refreshIfConnectedWithoutSnapshot: true,
      },
    );
    depthRestBootstrapRef.current = decision.next;

    // A connected socket is only transport readiness, not proof that the
    // current symbol has delivered a depth frame. If WS connects before the
    // first snapshot, re-arm one REST bootstrap; a later WS frame still wins
    // through the domain Store's realtime authority checks.
    let bootstrapTimer: number | null = null;
    if (decision.shouldRefresh) {
      if (lostRealtime) void refreshDepth();
      else {
        bootstrapTimer = window.setTimeout(() => {
          void refreshDepth();
        }, REST_BOOTSTRAP_GRACE_MS);
      }
    }

    if (quoteMarketRealtimeStatus === 'connected') {
      return () => {
        if (bootstrapTimer !== null) window.clearTimeout(bootstrapTimer);
      };
    }

    const timer = window.setInterval(() => {
      void refreshDepth();
    }, 1500);

    return () => {
      if (bootstrapTimer !== null) window.clearTimeout(bootstrapTimer);
      window.clearInterval(timer);
    };
  }, [
    contractSymbol,
    hasActiveDepthRows,
    marketSessionRefreshKey,
    quoteMarketRealtimeStatus,
    refreshDepth,
  ]);

  useEffect(() => {
    const handleDepthMessage = (message: ContractMarketRealtimeMessage) => {
      if (!isContractMarketDomainMessage(message)) return;
      if (effectiveMarketStatus === 'CLOSED') return;

      // BBO-only providers can publish real bid/ask prices without a usable
      // quantity. Persist the raw authority frame before deriving visual rows;
      // otherwise those zero-quantity frames are dropped and Header/Form BBO
      // freezes even though the provider WebSocket is still advancing.
      const storeResult = ingestContractMarketWsDomain({
        domain: 'depth',
        message,
      });
      if (!storeResult.accepted) return;

      const depth = extractRealtimeDepth(message, contractSymbol);
      if (!depth) return;
      applyDepthSnapshot(depth);
    };

    return contractMarketRealtime.subscribe('depth', handleDepthMessage);
  }, [applyDepthSnapshot, contractSymbol, effectiveMarketStatus]);

  const applyTradesSnapshot = useCallback((trades: ContractMarketTrade[], options: { loading?: boolean; error?: string | null } = {}) => {
    const requestSymbol = normalizeContractSymbol(contractSymbol);
    const nextRows = orderContractTradesNewestFirst(trades, FUTURES_TRADES_LIMIT);
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
      const nextTrades = orderContractTradesNewestFirst(
        trades,
        FUTURES_TRADES_LIMIT,
      );
      const storeResult = hydrateContractMarketRestDomain({
        symbol: requestSymbol,
        domain: 'trades',
        data: nextTrades,
        metadata: nextTrades[0] || null,
      });
      if (!storeResult.accepted) return;
      applyTradesSnapshot(nextTrades);
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
  }, [applyTradesSnapshot, contractSymbol]);

  useEffect(() => {
    const requestSymbol = normalizeContractSymbol(contractSymbol);
    const sessionMode = effectiveMarketStatus === 'CLOSED' ? 'CLOSED' : 'ACTIVE';
    const bootstrapKey = `${requestSymbol}|${marketSessionRefreshKey}|${sessionMode}`;
    const lostRealtime = tradesRestBootstrapRef.current.realtimeStatus === 'connected'
      && quoteMarketRealtimeStatus !== 'connected';
    const decision = resolveContractRestBootstrap(
      tradesRestBootstrapRef.current,
      bootstrapKey,
      quoteMarketRealtimeStatus,
    );
    tradesRestBootstrapRef.current = decision.next;

    let bootstrapTimer: number | null = null;
    if (decision.shouldRefresh) {
      if (lostRealtime) void refreshTrades();
      else {
        bootstrapTimer = window.setTimeout(() => {
          void refreshTrades();
        }, REST_BOOTSTRAP_GRACE_MS);
      }
    }
    if (effectiveMarketStatus === 'CLOSED' || quoteMarketRealtimeStatus === 'connected') {
      return () => {
        if (bootstrapTimer !== null) window.clearTimeout(bootstrapTimer);
      };
    }

    const timer = window.setInterval(() => {
      void refreshTrades();
    }, 1500);

    return () => {
      if (bootstrapTimer !== null) window.clearTimeout(bootstrapTimer);
      window.clearInterval(timer);
    };
  }, [
    contractSymbol,
    effectiveMarketStatus,
    marketSessionRefreshKey,
    quoteMarketRealtimeStatus,
    refreshTrades,
  ]);

  useEffect(() => {
    const handleTradeMessage = (message: ContractMarketRealtimeMessage) => {
      if (!isContractMarketDomainMessage(message)) return;
      if (effectiveMarketStatus === 'CLOSED') return;

      const trades = extractRealtimeTrades(message, contractSymbol);
      if (trades.length === 0) return;
      const storeResult = ingestContractMarketWsDomain({
        domain: 'trades',
        message,
        data: trades,
      });
      if (!storeResult.accepted) return;

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
          updatedAt: latest ? normalizeTradeTime(latest.time ?? latest.ts) : null,
        };
      });
    };

    return contractMarketRealtime.subscribe('trade', handleTradeMessage);
  }, [contractSymbol, effectiveMarketStatus]);

  useEffect(() => {
    const handleKlineMessage = (message: ContractMarketRealtimeMessage) => {
      if (!isContractKlineDomainMessage(message)) return;
      if (String(message.type || '').toLowerCase() === 'contract_candle_preview_update') return;
      ingestContractMarketWsDomain({
        domain: 'kline',
        message,
        data: message.kline ?? message.data,
        interval: message.interval || null,
      });
    };

    return contractMarketRealtime.subscribe('kline', handleKlineMessage);
  }, []);

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
  const latestTradeDirection: ContractPriceDirection = latestTradeNumber !== null && nextTradeNumber !== null
    ? latestTradeNumber > nextTradeNumber
      ? 'up'
      : latestTradeNumber < nextTradeNumber
        ? 'down'
        : 'flat'
    : 'flat';

  const priceAuthority = useMemo(() => buildContractPriceAuthority({
    symbol: contractSymbol,
    trade: latestTrade ? {
      symbol: contractSymbol,
      price: latestTrade.price,
      time: latestTrade.time ?? latestTrade.ts,
      source: latestTrade.source ?? latestTrade.quote_source,
      freshness: latestTrade.quote_freshness,
      priceSource: latestTrade.price_source,
      synthetic: latestTrade.synthetic,
    } : null,
    kline: marketView?.kline_current_candle ? {
      symbol: marketView.symbol,
      close: marketView.kline_current_candle.close,
      // Reference ordering is bucket based: an older cached trade may not
      // override the active provider candle. received/updated time is only a
      // transport timestamp and would incorrectly make every in-bucket trade
      // look older than the Kline.
      time: marketView.kline_current_candle.open_time
        ?? marketView.kline_current_candle.time
        ?? marketView.kline_current_candle.updated_at_ms
        ?? marketView.kline_current_candle.timestamp,
      freshness: marketView.kline_freshness,
      priceSource: marketView.kline_current_candle.price_source,
      klineMode: marketView.kline_current_candle.kline_mode ?? marketView.kline_source,
    } : null,
    ticker: {
      symbol: contractSymbol,
      price: quote?.last_price ?? fallbackLastPrice,
      time: quote?.ts ?? fallbackLastPriceTime,
      source: quote?.source ?? quote?.quote_source ?? fallbackLastPriceSource,
      freshness: quote?.quote_freshness ?? fallbackQuoteFreshness,
      marketStatus: quote?.market_status ?? fallbackMarketStatus,
      marketSessionType: quote?.market_session_type ?? fallbackMarketSessionType,
    },
    execution: marketView ? {
      symbol: marketView.symbol,
      bid: marketView.execution_bid,
      ask: marketView.execution_ask,
      executable: marketView.executable,
      mode: marketView.execution_mode,
      freshness: marketView.depth_freshness,
      source: marketView.depth_source,
      time: marketView.quote_time,
    } : null,
  }), [
    contractSymbol,
    fallbackLastPrice,
    fallbackLastPriceSource,
    fallbackLastPriceTime,
    fallbackMarketSessionType,
    fallbackMarketStatus,
    fallbackQuoteFreshness,
    latestTrade,
    marketView,
    quote?.last_price,
    quote?.market_session_type,
    quote?.market_status,
    quote?.quote_freshness,
    quote?.quote_source,
    quote?.source,
    quote?.ts,
  ]);
  const referencePrice = useMemo(
    () => selectContractReferencePrice(priceAuthority),
    [priceAuthority],
  );

  const displayPrice = marketViewAuthority.displayPrice;
  const displayPriceSource = displayPrice !== null
    ? normalizeCurrentPriceSource(marketView?.current_price_source || marketView?.display_price_source)
    : null;
  const displayPriceLabel = displayPriceSource === 'TRADE_TICK'
    ? t('latestPrice', 'contracts')
    : displayPriceSource === 'LIVE_MID'
      ? t('midPrice', 'contracts')
      : displayPriceSource === 'KLINE_CLOSE'
        ? t('klineLatestPrice', 'contracts')
        : t('latestPrice', 'contracts');

  const marketViewAuthorityPresentation = useMemo(
    () => resolveContractMarketViewAuthorityPresentation({
      marketView,
      executionReady: priceAuthority.executable,
      loading: shouldHoldContractMarketViewBootstrap({
        marketView,
        loading: currentMarketViewLoading,
        graceActive: marketViewBootstrapGraceActive,
        executionReady: priceAuthority.executable,
      }),
    }),
    [
      currentMarketViewLoading,
      marketView,
      marketViewBootstrapGraceActive,
      priceAuthority.executable,
    ],
  );

  const marketUiState = useMemo<ContractMarketUiState>(() => {
    return {
      ...marketViewAuthorityPresentation,
      label: getMarketViewStatusLabel(marketViewAuthorityPresentation.state, t),
    };
  }, [
    marketViewAuthorityPresentation,
    t,
  ]);

  const depthBootstrapPresentation = resolveContractDepthBootstrapPresentation(
    activeDepthMode,
    hasActiveDepthRows,
    fallbackDepthAllowed,
  );
  const depthAsks = useMemo(() => {
    return depthBootstrapPresentation.exposeRows ? activeDepthAsks : [];
  }, [activeDepthAsks, depthBootstrapPresentation.exposeRows]);
  const depthBids = useMemo(() => {
    return depthBootstrapPresentation.exposeRows ? activeDepthBids : [];
  }, [activeDepthBids, depthBootstrapPresentation.exposeRows]);
  const depthMode = depthBootstrapPresentation.depthMode;
  const depthLoading = activeDepthLoading || depthBootstrapPresentation.delayRows;
  const depthBestBid = maxPrice(activeDepthBids);
  const depthBestAsk = minPrice(activeDepthAsks);

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

  const exposeMarketDepth = shouldExposeContractMarketDepth(marketViewAuthorityPresentation);
  const authoritativeDepthAsks = exposeMarketDepth ? depthAsks : [];
  const authoritativeDepthBids = exposeMarketDepth ? depthBids : [];
  const depthStatus = marketUiState.status;
  const depthStatusLabel = marketUiState.label;

  const contractKlineMode: ContractKlineMode = 'PROVIDER_KLINE';
  const derivedMarketState = useMemo<ContractMarketCenterState>(() => {
    const quoteTime = parseContractMarketTimestamp(marketView?.quote_time);

    return {
      symbol: contractSymbol,
      displayPrice,
      displayPriceSource,
      displayPriceLabel,
      bestBid: marketViewAuthority.bestBid,
      bestAsk: marketViewAuthority.bestAsk,
      spread: marketViewAuthority.spread,
      executionBid: marketViewAuthority.executionBid,
      executionAsk: marketViewAuthority.executionAsk,
      latestTradePrice: latestTradeTickPrice,
      latestTradePriceSource: latestTradeTickPrice !== null ? 'TRADE_TICK' : null,
      klineMode: contractKlineMode,
      klineCurrentCandle: marketView?.kline_current_candle ?? null,
      quoteFreshness: marketView?.ticker_freshness ?? null,
      displayState: marketViewAuthority.displayState,
      executable: marketViewAuthority.executable,
      updatedAt: quoteTime,
    };
  }, [
    contractKlineMode,
    contractSymbol,
    displayPrice,
    displayPriceLabel,
    displayPriceSource,
    latestTradeTickPrice,
    marketView,
    marketViewAuthority,
  ]);

  const handleLatestKlineCloseChange = useCallback((value: string | null) => {
    void value;
  }, []);

  useEffect(() => {
    const currentState = priceDirectionStateRef.current;
    const nextState = advanceContractPriceDirection(currentState, {
      symbol: contractSymbol,
      price: referencePrice.usable ? referencePrice.value : null,
    });
    if (nextState === currentState) return;
    priceDirectionStateRef.current = nextState;
    setPriceDirection((current) => current === nextState.direction ? current : nextState.direction);
  }, [contractSymbol, referencePrice.usable, referencePrice.value]);

  useEffect(() => {
    const previousState = previousMarketViewDisplayStateRef.current;
    const currentState = rawMarketViewDisplayState;
    if (
      previousState
      && isNonTradingMarketState(previousState)
      && isLiveMarketState(currentState)
    ) {
      setMarketSessionRefreshKey((value) => value + 1);
    }
    previousMarketViewDisplayStateRef.current = currentState;
  }, [rawMarketViewDisplayState]);

  const marketStateBestBid = derivedMarketState.bestBid === null ? null : String(derivedMarketState.bestBid);
  const marketStateBestAsk = derivedMarketState.bestAsk === null ? null : String(derivedMarketState.bestAsk);
  const quoteStatusLabel = marketUiState.label;
  const quoteStatusTone = getContractQuoteStatusTone(marketUiState.status);
  const tickerSource = marketView?.ticker_source ?? null;
  const tickerFreshness = marketView?.ticker_freshness ?? null;
  const marketViewDepthSource = marketView?.depth_source ?? null;
  const marketViewDepthFreshness = marketView?.depth_freshness ?? null;
  const marketViewTradesSource = marketView?.trades_source ?? null;
  const marketViewTradesFreshness = marketView?.trades_freshness ?? null;
  const klineSource = marketView?.kline_source ?? marketView?.kline_current_candle?.kline_mode ?? null;
  const klineFreshness = marketView?.kline_freshness ?? null;
  const resolvedDepthSource = marketViewDepthSource;
  const resolvedDepthFreshness = marketViewDepthFreshness;
  const resolvedTradesSource = marketViewTradesSource;
  const resolvedTradesFreshness = marketViewTradesFreshness;
  const tickerSourceLabel = getContractMarketSourceLabel(tickerSource, tickerFreshness, t);
  const depthSourceLabel = getContractMarketSourceLabel(resolvedDepthSource, resolvedDepthFreshness, t);
  const tradesSourceLabel = getContractMarketSourceLabel(resolvedTradesSource, resolvedTradesFreshness, t);
  const klineSourceLabel = getContractMarketSourceLabel(klineSource, klineFreshness, t);

  return {
    ...quoteState,
    marketView,
    marketViewLoading: currentMarketViewLoading,
    marketViewError: currentMarketViewError,
    priceAuthority,
    referencePrice,
    displayPrice,
    displayState: rawMarketViewDisplayState,
    displayPriceSource,
    displayPriceLabel,
    depthBids: authoritativeDepthBids,
    depthAsks: authoritativeDepthAsks,
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
    executable: marketViewAuthority.executable,
    executionBid: marketViewAuthority.executionBid,
    executionAsk: marketViewAuthority.executionAsk,
    executionMode: marketView?.execution_mode ?? null,
    reasonCode: marketViewAuthority.reasonCode,
    warnings: marketView?.warnings ?? [],
    rawSourceSummary: marketView?.raw_source_summary ?? {},
    quote,
    wsState,
    refreshMarketView,
    marketState: derivedMarketState,
    marketStateBestBid,
    marketStateBestAsk,
    marketUiState,
    marketStatus: marketView?.market_status ?? null,
    marketStatusText,
    quoteFreshness: marketView?.ticker_freshness ?? null,
    marketSessionType,
    quoteStatusLoading: marketUiState.isLoading,
    quoteStatusLabel,
    quoteStatusTone,
    quoteDisplayStatus: marketUiState.status,
    currentPriceReady: displayPrice !== null,
    priceDirection,
    marketSessionRefreshKey,
    handleLatestKlineCloseChange,
  };
}
