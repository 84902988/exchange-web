'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { friendlyContractError, toNumber } from '@/components/contract/contractFormat';
import { useLocaleContext } from '@/contexts/LocaleContext';
import { formatPrice, getSymbolPricePrecision } from '@/lib/marketPrecision';
import {
  getContractQuote,
  type ContractDepthLevel,
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
  type ContractMarketRealtimeMessage,
  type ContractMarketRealtimeStatus,
} from '@/lib/realtime/contractMarketRealtime';

export type PriceDirection = 'up' | 'down' | 'flat';

type ContractDepthSnapshot = {
  asks: ContractDepthLevel[];
  bids: ContractDepthLevel[];
  source?: string | null;
};

type UseContractMarketStateParams = {
  contractSymbol: string;
  interval?: string;
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
};

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

function getQuoteTradePrice(quote?: ContractQuoteWithPremiumFields | null) {
  if (!quote) return 0;
  const record = quote as ContractQuoteWithPremiumFields & {
    price?: string | number | null;
    last?: string | number | null;
  };
  return toNumber(record.last_price ?? record.price ?? record.last);
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
  interval = '1m',
  symbolOptionMarketSymbol,
  symbolOptionPricePrecision,
}: UseContractMarketStateParams) {
  const { t } = useLocaleContext();
  const [hasHydrated, setHasHydrated] = useState(false);
  const [marketRealtimeStatus, setMarketRealtimeStatus] = useState<ContractMarketRealtimeStatus>('idle');
  const [priceDirection, setPriceDirection] = useState<PriceDirection>('flat');
  const [latestMarketPrice, setLatestMarketPrice] = useState<number | null>(null);
  const [bestDepth, setBestDepth] = useState<BestDepthState>(() => ({
    symbol: contractSymbol,
    bestBid: null,
    bestAsk: null,
  }));
  const [contractQuoteState, setContractQuoteState] = useState<ContractQuoteState>(() => ({
    symbol: contractSymbol,
    quote: null,
  }));
  const [contractQuoteLoading, setContractQuoteLoading] = useState(true);
  const [contractAvailabilityError, setContractAvailabilityError] = useState<string | null>(null);
  const contractQuoteRef = useRef<ContractQuoteWithPremiumFields | null>(null);
  const quoteLoadedSymbolRef = useRef<string | null>(null);
  const latestMarketPriceRef = useRef(0);

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
  const fallbackLatestPrice = toNumber(fallbackQuoteCache?.lastPrice ?? contractQuote?.last_price);
  const activeLatestMarketPrice = contractQuoteState.symbol === contractSymbol
    ? latestMarketPrice
    : fallbackLatestPrice > 0
      ? fallbackLatestPrice
      : null;
  const quantityUnit = useMemo(() => getContractQuantityUnit(contractSymbol), [contractSymbol]);
  const pricePrecision = getSymbolPricePrecision(
    contractSymbol,
    contractQuote?.price_precision ?? symbolOptionPricePrecision,
  ) ?? symbolOptionPricePrecision ?? 2;
  const bestBidFromDepth = bestDepth.symbol === contractSymbol ? bestDepth.bestBid : null;
  const bestAskFromDepth = bestDepth.symbol === contractSymbol ? bestDepth.bestAsk : null;
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

  const applyLatestPrice = useCallback((value?: string | number | null) => {
    const nextPrice = toNumber(value);
    if (!nextPrice) return;
    const previousPrice = latestMarketPriceRef.current;
    if (previousPrice) {
      setPriceDirection(nextPrice > previousPrice ? 'up' : nextPrice < previousPrice ? 'down' : 'flat');
    } else {
      setPriceDirection('flat');
    }
    latestMarketPriceRef.current = nextPrice;
    setLatestMarketPrice(nextPrice);
  }, []);

  const latestPrice = formatPrice(
    hasHydrated ? activeLatestMarketPrice || contractQuote?.last_price : null,
    pricePrecision,
  );
  const contractConfigMissing = isContractSymbolConfigMissing(contractAvailabilityError);
  const quoteHint = contractConfigMissing ? t('contractSymbolConfigMissing', 'contracts') : null;
  const initialDepth = hasHydrated ? readContractDepthCache(contractSymbol) || undefined : undefined;

  const refreshContractQuote = useCallback(async () => {
    if (quoteLoadedSymbolRef.current !== contractSymbol) {
      setContractQuoteLoading(true);
    }
    try {
      const nextQuote = await getContractQuote(contractSymbol);
      const nextPrice = getQuoteTradePrice(nextQuote);
      applyLatestPrice(nextPrice);
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
  }, [applyLatestPrice, contractSymbol, t]);

  const handleBestPricesChange = useCallback(({
    bestBid: nextBestBid,
    bestAsk: nextBestAsk,
  }: {
    bestBid: string | null;
    bestAsk: string | null;
  }) => {
    setBestDepth({
      symbol: contractSymbol,
      bestBid: nextBestBid,
      bestAsk: nextBestAsk,
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
      });
      const cache = readContractQuoteCache(contractSymbol);
      contractQuoteRef.current = cache.quote || null;
      setContractQuoteState({
        symbol: contractSymbol,
        quote: cache.quote || null,
      });
      setContractAvailabilityError(null);
      setPriceDirection('flat');
      const cachedPrice = toNumber(cache.lastPrice ?? cache.quote?.last_price);
      latestMarketPriceRef.current = cachedPrice || 0;
      setLatestMarketPrice(cachedPrice > 0 ? cachedPrice : null);
    });

    return () => {
      alive = false;
    };
  }, [contractSymbol]);

  useEffect(() => {
    contractMarketRealtime.setSession({ symbol: contractSymbol, interval });
  }, [contractSymbol, interval]);

  useEffect(() => contractMarketRealtime.subscribeStatus(setMarketRealtimeStatus), []);

  useEffect(() => {
    return () => {
      contractMarketRealtime.disconnect();
    };
  }, []);

  useEffect(() => {
    const handleQuoteMessage = (message: ContractMarketRealtimeMessage) => {
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

      const nextPrice = getQuoteTradePrice(mergedQuote);
      applyLatestPrice(nextPrice);
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
  }, [applyLatestPrice, contractSymbol]);

  useEffect(() => {
    void Promise.resolve().then(refreshContractQuote);
    if (marketRealtimeStatus === 'connected') return undefined;

    const timer = window.setInterval(() => {
      void refreshContractQuote();
    }, 2000);

    return () => window.clearInterval(timer);
  }, [marketRealtimeStatus, refreshContractQuote]);

  return {
    marketSymbol,
    quantityUnit,
    priceDirection,
    latestPrice,
    latestMarketPrice: activeLatestMarketPrice,
    bestBid,
    bestAsk,
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
    applyLatestPrice,
    handleBestPricesChange,
    handleDepthDataChange,
  };
}
