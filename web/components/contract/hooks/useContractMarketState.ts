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
import { ApiError } from '@/lib/api/core/error';
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
import { useContractMarketTransportRecovery } from './useContractMarketTransportRecovery';
import { mergeContractQuoteIncrement } from './contractQuoteIncrement';

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
    if (contractQuoteRequestStore.get(contractSymbol)?.promise !== promise) return;
    contractQuoteRequestStore.set(contractSymbol, {
      promise: null,
      quote,
      settledAt: Date.now(),
    });
  }).catch(() => {
    if (contractQuoteRequestStore.get(contractSymbol)?.promise === promise) {
      contractQuoteRequestStore.delete(contractSymbol);
    }
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

export function isContractSymbolConfigMissingError(error: unknown) {
  const code = error instanceof ApiError
    ? String(error.code || '').trim().toUpperCase()
    : '';
  const message = error instanceof Error ? error.message : String(error || '');
  return (
    code === 'CONTRACT_SYMBOL_NOT_FOUND' ||
    code === 'CONTRACT_SYMBOL_NOT_ENABLED' ||
    (
      message.includes('contract symbol') &&
      message.includes('not found or disabled')
    ) ||
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
  const [contractConfigMissing, setContractConfigMissing] = useState(false);
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
  const quoteRequestSeqRef = useRef(0);
  const previousMarketRealtimeStatusRef = useRef<ContractMarketRealtimeStatus>('idle');
  const transportRecovery = useContractMarketTransportRecovery(
    contractSymbol,
    marketRealtimeStatus,
  );

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

  const quoteHint = contractConfigMissing ? t('contractSymbolConfigMissing', 'contracts') : null;
  const initialDepth = hasHydrated ? readContractDepthCache(contractSymbol) || undefined : undefined;

  useEffect(() => {
    activateContractMarketShadowSymbol(contractSymbol);
  }, [contractSymbol]);

  const refreshContractQuote = useCallback(async () => {
    const requestSeq = quoteRequestSeqRef.current + 1;
    quoteRequestSeqRef.current = requestSeq;
    if (quoteLoadedSymbolRef.current !== contractSymbol) {
      setContractQuoteLoading(true);
    }
    try {
      const nextQuote = await loadContractQuote(contractSymbol);
      if (quoteRequestSeqRef.current !== requestSeq) return;
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
      setContractConfigMissing(false);
      setContractAvailabilityError(null);
    } catch (err) {
      if (quoteRequestSeqRef.current !== requestSeq) return;
      setContractConfigMissing(isContractSymbolConfigMissingError(err));
      setContractAvailabilityError(friendlyContractError(err, t));
    } finally {
      if (quoteRequestSeqRef.current === requestSeq) {
        setContractQuoteLoading(false);
      }
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
      quoteRequestSeqRef.current += 1;
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
      setContractConfigMissing(false);
      setContractAvailabilityError(null);
    });

    return () => {
      alive = false;
    };
  }, [contractSymbol]);

  useEffect(() => {
    return contractMarketRealtime.setMarketSession(contractSymbol);
  }, [contractSymbol]);

  useEffect(() => {
    let previousStatus = contractMarketRealtime.getStatus();
    return contractMarketRealtime.subscribeStatus((nextStatus) => {
      const recoveredConnection = (
        previousStatus !== 'connected'
        && nextStatus === 'connected'
      );
      previousStatus = nextStatus;

      if (recoveredConnection) {
        // setStatus() runs synchronously inside the realtime singleton before it
        // replays Market/K-line subscriptions. Rotate the shared Store here so
        // the new socket's bootstrap snapshot lands in the new session instead
        // of being invalidated later by a React reconnect effect.
        restartContractMarketShadowSession(contractSymbol);
        quoteRequestSeqRef.current += 1;
        contractQuoteRequestStore.delete(contractSymbol);
      }
      setMarketRealtimeStatus(nextStatus);
    });
  }, [contractSymbol]);

  useEffect(() => {
    const previousStatus = previousMarketRealtimeStatusRef.current;
    previousMarketRealtimeStatusRef.current = marketRealtimeStatus;
    if (previousStatus !== 'connected' || marketRealtimeStatus === 'connected') return;

    // Start the REST recovery path immediately, but do not destroy the last
    // accepted realtime snapshot for a single short socket reconnect.
    void refreshContractQuote();
  }, [marketRealtimeStatus, refreshContractQuote]);

  useEffect(() => {
    if (transportRecovery.reconnectGeneration <= 0) return;

    // Store lineage already rotated synchronously at the socket-open boundary,
    // before the singleton replayed subscriptions. This effect only re-arms
    // the REST fallback after React observes the recovered transport.
    void refreshContractQuote();
  }, [
    contractSymbol,
    refreshContractQuote,
    transportRecovery.reconnectGeneration,
  ]);

  useEffect(() => {
    if (!transportRecovery.recoveryExpired) return;

    restartContractMarketShadowSession(contractSymbol);
    contractQuoteRef.current = null;
    quoteLoadedSymbolRef.current = null;
    setContractQuoteLoading(true);
    setContractQuoteState({ symbol: contractSymbol, quote: null });
    setBestDepth({ symbol: contractSymbol, bestBid: null, bestAsk: null, ts: null });
    void refreshContractQuote();
  }, [contractSymbol, refreshContractQuote, transportRecovery.recoveryExpired]);

  useEffect(() => {
    const handleQuoteMessage = (message: ContractMarketRealtimeMessage) => {
      if (!isContractMarketDomainMessage(message)) return;
      const msgSymbol = getRealtimeMessageSymbol(message);
      if (msgSymbol && msgSymbol !== contractSymbol) return;

      const nextQuote = extractRealtimeQuote(message);
      if (!nextQuote) return;
      const previousQuote = contractQuoteRef.current;
      const mergedQuote = mergeContractQuoteIncrement(previousQuote, nextQuote);

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
      setContractConfigMissing(false);
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
    contractConfigMissing,
    pricePrecision,
    spreadInfo,
    quoteHint,
    marketRealtimeStatus,
    initialDepth,
    handleBestPricesChange,
    handleDepthDataChange,
  };
}
