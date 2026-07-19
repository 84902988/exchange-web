'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { friendlyContractError, toNumber } from '@/components/contract/contractFormat';
import { useLocaleContext } from '@/contexts/LocaleContext';
import { formatPrice, getSymbolPricePrecision } from '@/lib/marketPrecision';
import {
  getContractQuote,
  type ContractDepthLevel,
  type ContractDepthMode,
  type ContractQuote,
} from '@/lib/api/modules/contract';
import {
  readContractDepthCache,
  readContractQuoteCache,
  writeContractDepthCache,
  writeContractQuoteCache,
} from '@/lib/contractMarketCache';
import {
  contractMarketRealtime,
  isContractMarketDomainMessage,
  type ContractMarketRealtimeMessage,
  type ContractMarketRealtimeStatus,
} from '@/lib/realtime/contractMarketRealtime';
import {
  activateContractMarketShadowSymbol,
  hydrateContractMarketRestDomain,
  ingestContractMarketWsDomain,
  restartContractMarketShadowSession,
} from './contractMarketStoreAdapter';

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

type UseContractMarketStateParams = {
  contractSymbol: string;
  symbolOptionMarketSymbol?: string | null;
  symbolOptionPricePrecision?: number | null;
};

export type ContractQuoteWithPremiumFields = ContractQuote & {
  index_price?: string | number | null;
  funding_rate?: string | number | null;
};

type ContractQuoteState = {
  symbol: string;
  quote: ContractQuoteWithPremiumFields | null;
};

type BestDepthState = {
  symbol: string;
  bestBid: string | null;
  bestAsk: string | null;
  ts: string | number | null;
};

type ContractQuoteRequestEntry = {
  promise: Promise<ContractQuote> | null;
  quote: ContractQuote | null;
  settledAt: number;
};

const CONTRACT_QUOTE_REQUEST_DEDUPE_MS = 1_000;
const CONTRACT_QUOTE_REST_BOOTSTRAP_GRACE_MS = 750;
const contractQuoteRequestStore = new Map<string, ContractQuoteRequestEntry>();

function loadContractQuote(contractSymbol: string) {
  const now = Date.now();
  const existing = contractQuoteRequestStore.get(contractSymbol);
  if (existing?.promise) return existing.promise;
  if (existing?.quote && now - existing.settledAt < CONTRACT_QUOTE_REQUEST_DEDUPE_MS) {
    return Promise.resolve(existing.quote);
  }

  const promise = getContractQuote(contractSymbol);
  contractQuoteRequestStore.set(contractSymbol, {
    promise,
    quote: existing?.quote || null,
    settledAt: existing?.settledAt || 0,
  });
  void promise.then((quote) => {
    contractQuoteRequestStore.set(contractSymbol, {
      promise: null,
      quote,
      settledAt: Date.now(),
    });
  }).catch(() => {
    contractQuoteRequestStore.delete(contractSymbol);
  });
  return promise;
}

function getMarketSymbol(contractSymbol: string, symbolOptionMarketSymbol?: string | null) {
  return symbolOptionMarketSymbol || contractSymbol.replace(/_PERP$/, '');
}

function contractSymbolToMarketSymbol(symbol: string) {
  return symbol.replace(/_PERP$/, '');
}

function getContractQuantityUnit(symbol: string) {
  const marketSymbol = contractSymbolToMarketSymbol(symbol);
  for (const quote of ['USDT', 'USDC', 'USD']) {
    if (marketSymbol.endsWith(quote)) {
      const base = marketSymbol.slice(0, -quote.length);
      return base || '\u5f20';
    }
  }
  return marketSymbol || '\u5f20';
}

function getRealtimeMessageSymbol(message: ContractMarketRealtimeMessage) {
  const record = message as Record<string, unknown>;
  const data = record.data && typeof record.data === 'object'
    ? record.data as Record<string, unknown>
    : null;
  const quote = record.quote && typeof record.quote === 'object'
    ? record.quote as Record<string, unknown>
    : null;

  return String(record.symbol || data?.symbol || quote?.symbol || '').trim().toUpperCase();
}

function extractRealtimeQuote(message: ContractMarketRealtimeMessage): ContractQuoteWithPremiumFields | null {
  const source =
    message.quote && typeof message.quote === 'object'
      ? message.quote
      : message.data && typeof message.data === 'object'
        ? message.data
        : message;
  const record = source as Record<string, unknown>;

  if (!record.last_price && !record.mark_price) return null;
  return record as unknown as ContractQuoteWithPremiumFields;
}

export function formatFundingRate(value?: string | number | null) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '--';
  return `${(num * 100).toFixed(4)}%`;
}

function isContractSymbolConfigMissing(message: string | null) {
  if (!message) return false;
  return (
    message.includes('contract symbol not found or disabled') ||
    message.includes('\u5408\u7ea6\u54c1\u79cd\u672a\u542f\u7528') ||
    message.includes('\u914d\u7f6e\u7f3a\u5931')
  );
}

export function useContractMarketState({
  contractSymbol,
  symbolOptionMarketSymbol,
  symbolOptionPricePrecision,
}: UseContractMarketStateParams) {
  const { t } = useLocaleContext();
  const [hasHydrated, setHasHydrated] = useState(false);
  const [marketRealtimeStatus, setMarketRealtimeStatus] = useState<ContractMarketRealtimeStatus>('idle');
  const [bestDepth, setBestDepth] = useState<BestDepthState>(() => ({
    symbol: contractSymbol,
    bestBid: null,
    bestAsk: null,
    ts: null,
  }));
  const [contractQuoteState, setContractQuoteState] = useState<ContractQuoteState>(() => ({
    symbol: contractSymbol,
    quote: null,
  }));
  const [contractQuoteLoading, setContractQuoteLoading] = useState(true);
  const [contractAvailabilityError, setContractAvailabilityError] = useState<string | null>(null);
  const contractQuoteRef = useRef<ContractQuoteWithPremiumFields | null>(null);
  const quoteLoadedSymbolRef = useRef<string | null>(null);
  const previousMarketRealtimeStatusRef = useRef<ContractMarketRealtimeStatus>('idle');

  const marketSymbol = useMemo(
    () => getMarketSymbol(contractSymbol, symbolOptionMarketSymbol),
    [contractSymbol, symbolOptionMarketSymbol],
  );
  const fallbackQuoteCache = !hasHydrated || contractQuoteState.symbol === contractSymbol
    ? null
    : readContractQuoteCache(contractSymbol);
  const contractQuote = contractQuoteState.symbol === contractSymbol
    ? contractQuoteState.quote
    : fallbackQuoteCache?.quote || null;
  const quantityUnit = useMemo(() => getContractQuantityUnit(contractSymbol), [contractSymbol]);
  const pricePrecision = getSymbolPricePrecision(
    contractSymbol,
    contractQuote?.price_precision ?? symbolOptionPricePrecision,
  ) ?? symbolOptionPricePrecision ?? 2;
  const bestBidFromDepth = bestDepth.symbol === contractSymbol ? bestDepth.bestBid : null;
  const bestAskFromDepth = bestDepth.symbol === contractSymbol ? bestDepth.bestAsk : null;
  const bestDepthTimestamp = bestDepth.symbol === contractSymbol ? bestDepth.ts : null;
  const bestBid = bestBidFromDepth || null;
  const bestAsk = bestAskFromDepth || null;
  const midPrice = useMemo(() => {
    const bid = toNumber(bestBid);
    const ask = toNumber(bestAsk);
    if (!bid || !ask || ask <= bid) return null;
    return String((ask + bid) / 2);
  }, [bestAsk, bestBid]);
  const spreadInfo = useMemo(() => {
    const bid = toNumber(bestBid);
    const ask = toNumber(bestAsk);
    if (!bid || !ask || ask <= bid) {
      return {
        value: '--',
        percent: t('noOrderBook', 'contracts'),
      };
    }
    const spread = ask - bid;
    const markPrice = toNumber(contractQuote?.mark_price);
    const midPrice = (ask + bid) / 2;
    const percentBase = markPrice > 0 ? markPrice : midPrice;
    const spreadPercent = percentBase > 0 ? (spread / percentBase) * 100 : 0;
    return {
      value: `${formatPrice(spread, pricePrecision)} USDT`,
      percent: `${spreadPercent.toFixed(4)}%`,
    };
  }, [bestAsk, bestBid, contractQuote?.mark_price, pricePrecision, t]);

  const contractConfigMissing = isContractSymbolConfigMissing(contractAvailabilityError);
  const quoteHint = contractConfigMissing ? t('contractSymbolConfigMissing', 'contracts') : null;
  const initialDepth = hasHydrated ? readContractDepthCache(contractSymbol) || undefined : undefined;

  useEffect(() => {
    activateContractMarketShadowSymbol(contractSymbol);
  }, [contractSymbol]);

  const refreshContractQuote = useCallback(async () => {
    if (quoteLoadedSymbolRef.current !== contractSymbol) {
      setContractQuoteLoading(true);
    }
    try {
      const nextQuote = await loadContractQuote(contractSymbol);
      const storeResult = hydrateContractMarketRestDomain({
        symbol: contractSymbol,
        domain: 'ticker',
        data: nextQuote,
        metadata: nextQuote,
      });
      if (!storeResult.accepted) return;
      contractQuoteRef.current = nextQuote;
      quoteLoadedSymbolRef.current = contractSymbol;
      setContractQuoteState({
        symbol: contractSymbol,
        quote: nextQuote,
      });
      writeContractQuoteCache(contractSymbol, nextQuote);
      setContractAvailabilityError(null);
    } catch (err) {
      setContractAvailabilityError(friendlyContractError(err, t));
    } finally {
      setContractQuoteLoading(false);
    }
  }, [contractSymbol, t]);

  const handleBestPricesChange = useCallback(({
    bestBid: nextBestBid,
    bestAsk: nextBestAsk,
    ts,
  }: {
    bestBid: string | null;
    bestAsk: string | null;
    ts?: string | number | null;
  }) => {
    setBestDepth({
      symbol: contractSymbol,
      bestBid: nextBestBid,
      bestAsk: nextBestAsk,
      ts: ts ?? null,
    });
  }, [contractSymbol]);

  const handleDepthDataChange = useCallback((depth: ContractDepthSnapshot) => {
    writeContractDepthCache(contractSymbol, depth);
  }, [contractSymbol]);

  useEffect(() => {
    let alive = true;

    void Promise.resolve().then(() => {
      if (!alive) return;
      setHasHydrated(true);
      quoteLoadedSymbolRef.current = null;
      setContractQuoteLoading(true);
      setBestDepth({
        symbol: contractSymbol,
        bestBid: null,
        bestAsk: null,
        ts: null,
      });
      const cache = readContractQuoteCache(contractSymbol);
      contractQuoteRef.current = cache.quote || null;
      setContractQuoteState({
        symbol: contractSymbol,
        quote: cache.quote || null,
      });
      setContractAvailabilityError(null);
    });

    return () => {
      alive = false;
    };
  }, [contractSymbol]);

  useEffect(() => {
    return contractMarketRealtime.setMarketSession(contractSymbol);
  }, [contractSymbol]);

  useEffect(() => contractMarketRealtime.subscribeStatus(setMarketRealtimeStatus), []);

  useEffect(() => {
    const previousStatus = previousMarketRealtimeStatusRef.current;
    previousMarketRealtimeStatusRef.current = marketRealtimeStatus;
    if (previousStatus !== 'connected' || marketRealtimeStatus === 'connected') return;

    restartContractMarketShadowSession(contractSymbol);
    contractQuoteRef.current = null;
    quoteLoadedSymbolRef.current = null;
    setContractQuoteLoading(true);
    setContractQuoteState({ symbol: contractSymbol, quote: null });
    setBestDepth({ symbol: contractSymbol, bestBid: null, bestAsk: null, ts: null });
    void refreshContractQuote();
  }, [contractSymbol, marketRealtimeStatus, refreshContractQuote]);

  useEffect(() => {
    const handleQuoteMessage = (message: ContractMarketRealtimeMessage) => {
      if (!isContractMarketDomainMessage(message)) return;
      const msgSymbol = getRealtimeMessageSymbol(message);
      if (msgSymbol && msgSymbol !== contractSymbol) return;

      const nextQuote = extractRealtimeQuote(message);
      if (!nextQuote) return;
      const previousQuote = contractQuoteRef.current;
      const mergedQuote = {
        ...(previousQuote ? {
          market_status: previousQuote?.market_status,
          market_status_text: previousQuote?.market_status_text,
          market_session_code: previousQuote?.market_session_code,
          market_timezone: previousQuote?.market_timezone,
          market_trading_hours: previousQuote?.market_trading_hours,
          market_session_type: previousQuote?.market_session_type,
          quote_freshness: previousQuote?.quote_freshness,
          quote_source: previousQuote?.quote_source,
          executable: previousQuote?.executable,
          is_realtime: previousQuote?.is_realtime,
          last_good_at: previousQuote?.last_good_at,
          stale: previousQuote?.stale,
        } : {}),
        ...nextQuote,
      };

      const storeResult = ingestContractMarketWsDomain({
        domain: 'ticker',
        message,
        data: mergedQuote,
      });
      if (!storeResult.accepted) return;
      contractQuoteRef.current = mergedQuote;
      quoteLoadedSymbolRef.current = contractSymbol;
      setContractQuoteLoading(false);
      setContractQuoteState({
        symbol: contractSymbol,
        quote: mergedQuote,
      });
      writeContractQuoteCache(contractSymbol, mergedQuote);
      setContractAvailabilityError(null);
    };

    return contractMarketRealtime.subscribe('quote', handleQuoteMessage);
  }, [contractSymbol]);

  useEffect(() => {
    if (marketRealtimeStatus === 'connected') return undefined;
    const timer = window.setTimeout(() => {
      void refreshContractQuote();
    }, CONTRACT_QUOTE_REST_BOOTSTRAP_GRACE_MS);
    return () => window.clearTimeout(timer);
  }, [marketRealtimeStatus, refreshContractQuote]);

  useEffect(() => {
    if (marketRealtimeStatus === 'connected') return undefined;

    const timer = window.setInterval(() => {
      void refreshContractQuote();
    }, 2000);

    return () => window.clearInterval(timer);
  }, [marketRealtimeStatus, refreshContractQuote]);

  return {
    marketSymbol,
    quantityUnit,
    bestBid,
    bestAsk,
    bestDepthTimestamp,
    midPrice,
    bestBidFromDepth,
    bestAskFromDepth,
    contractQuote,
    contractQuoteLoading,
    contractAvailabilityError,
    pricePrecision,
    spreadInfo,
    quoteHint,
    marketRealtimeStatus,
    initialDepth,
    handleBestPricesChange,
    handleDepthDataChange,
  };
}
