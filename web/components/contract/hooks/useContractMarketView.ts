'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toNumber } from '@/components/contract/contractFormat';
import { useLocaleContext } from '@/contexts/LocaleContext';
import {
  getContractMarketView,
  getContractQuoteDisplayStatus,
  isExpiredLastGoodBboQuote,
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
  const [priceDirection, setPriceDirection] = useState<PriceDirection>('flat');
  const [marketSessionRefreshKey, setMarketSessionRefreshKey] = useState(0);
  const requestSeqRef = useRef(0);
  const inFlightSymbolRef = useRef<string | null>(null);
  const mountedRef = useRef(false);
  const currentPriceRef = useRef<number | null>(null);
  const previousMarketViewDisplayStateRef = useRef<string | null>(null);

  const quoteState = useContractMarketState({
    contractSymbol,
    interval,
    symbolOptionMarketSymbol,
    symbolOptionPricePrecision,
  });

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
      setMarketViewError(null);
    } catch (error) {
      if (!mountedRef.current || requestSeqRef.current !== requestSeq) return;
      setRestMarketView(null);
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
    currentPriceRef.current = null;
    previousMarketViewDisplayStateRef.current = null;
    setRestMarketView(null);
    setWsState(null);
    setMarketViewError(null);
    setMarketViewLoading(true);
    setLocalChartLastClose(null);
    setLastTradePrice(null);
    setLiveDepthBbo(null);
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

  const quote = quoteState.contractQuote;
  const marketStatus = quote?.market_status || fallbackMarketStatus || null;
  const marketStatusText = quote?.market_status_text || fallbackMarketStatusText || null;
  const quoteFreshness = quote?.quote_freshness || fallbackQuoteFreshness || null;
  const marketSessionType = quote?.market_session_type || fallbackMarketSessionType || null;
  const quoteStatusLoading = quoteState.contractQuoteLoading && (!quote || quote.executable === false);
  const quoteDisplayStatus = getContractQuoteDisplayStatus(quote, { loading: quoteStatusLoading });
  const rawMarketViewDisplayState = normalizeMarketViewDisplayState(marketView?.display_state);
  const marketViewDisplayState = normalizeMarketViewDisplayState(
    rawMarketViewDisplayState || (marketViewLoading ? 'LOADING' : null),
  );
  const marketViewQuoteDisplayStatus = marketViewStateToQuoteStatus(marketViewDisplayState);
  const effectiveQuoteDisplayStatus = marketViewQuoteDisplayStatus || quoteDisplayStatus;
  const marketViewDisplayPrice = getPositivePrice(marketView?.display_price);
  const marketViewCurrentPriceSource = marketViewDisplayPrice !== null
    ? normalizeCurrentPriceSource(marketView?.current_price_source || marketView?.display_price_source) || 'LIVE_MID'
    : null;
  const marketViewTradePrice = marketViewCurrentPriceSource === 'TRADE_TICK'
    ? getPositivePrice(marketView?.last_trade_price ?? marketView?.display_price)
    : null;
  const tradeTickPrice = getPositivePrice(lastTradePrice) ?? marketViewTradePrice;
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

    if (marketViewLoading && !marketView && quoteDisplayStatus === 'LOADING') {
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
    marketViewLoading,
    quote?.executable,
    quoteDisplayStatus,
    rawMarketViewDisplayState,
    t,
  ]);

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

  return {
    ...quoteState,
    marketView,
    marketViewLoading,
    marketViewError,
    displayPrice,
    displayState: rawMarketViewDisplayState,
    displayPriceSource,
    displayPriceLabel,
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
