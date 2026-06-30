'use client';

import type { CandleItem, VolumeItem } from '@/components/spot/chart/chart.types';
import type {
  ContractDepthLevel,
  ContractMarketTrade,
  ContractQuote,
} from '@/lib/api/modules/contract';
import { readMarketCache, writeMarketCache } from '@/lib/marketCache';

const CLOSED_QUOTE_CACHE_TTL_MS = 30_000;
const CONTRACT_KLINE_CACHE_VERSION = 2;

export type ContractDepthCache = {
  symbol?: string | null;
  asks: ContractDepthLevel[];
  bids: ContractDepthLevel[];
  source?: string | null;
  quote_freshness?: string | null;
  quote_source?: string | null;
  market_status?: string | null;
  executable?: boolean | null;
  closed_market_execution_mode?: string | null;
  ts?: string | number | null;
};

export type ContractKlineCache = {
  candles?: CandleItem[];
  volumes?: VolumeItem[];
  updatedAt?: number;
  version?: number;
};

export type ContractTradesCache = {
  trades?: ContractMarketTrade[];
  lastPrice?: string | number | null;
  updatedAt?: number;
};

export type ContractMarketCache = {
  quote?: ContractQuote | null;
  lastPrice?: string | number | null;
  depth?: ContractDepthCache;
  klines?: Record<string, ContractKlineCache>;
  klineCacheVersion?: number;
  trades?: ContractMarketTrade[];
  tradesLastPrice?: string | number | null;
  candles?: CandleItem[];
  volumes?: VolumeItem[];
  updatedAt?: number;
};

function normalizeSymbol(symbol: string) {
  return String(symbol || '').trim().toUpperCase();
}

export function readContractMarketCache(symbol: string) {
  return readMarketCache<ContractMarketCache>('contract', normalizeSymbol(symbol));
}

export function writeContractMarketCache(symbol: string, patch: Partial<ContractMarketCache>) {
  writeMarketCache<ContractMarketCache>('contract', normalizeSymbol(symbol), patch);
}

export function readContractQuoteCache(symbol: string) {
  const cache = readContractMarketCache(symbol);
  const quote = cache?.quote ?? null;
  const isStaleClosedQuote =
    quote?.market_status === 'CLOSED' &&
    (!cache?.updatedAt || Date.now() - cache.updatedAt > CLOSED_QUOTE_CACHE_TTL_MS);

  return {
    quote: isStaleClosedQuote ? null : quote,
    lastPrice: cache?.lastPrice ?? quote?.last_price ?? quote?.mark_price ?? null,
  };
}

export function writeContractQuoteCache(symbol: string, quote: ContractQuote) {
  writeContractMarketCache(symbol, {
    quote,
    lastPrice: quote.last_price || quote.mark_price,
  });
}

export function readContractDepthCache(symbol: string) {
  return readContractMarketCache(symbol)?.depth ?? null;
}

export function writeContractDepthCache(symbol: string, depth: ContractDepthCache) {
  writeContractMarketCache(symbol, { depth });
}

export function readContractKlineCache(symbol: string, interval: string): ContractKlineCache | null {
  const cache = readContractMarketCache(symbol);
  const normalizedInterval = String(interval || '').trim() || '1m';
  const intervalCache = cache?.klines?.[normalizedInterval];
  if (intervalCache?.version === CONTRACT_KLINE_CACHE_VERSION && intervalCache?.candles?.length) {
    return intervalCache;
  }
  if (cache?.klineCacheVersion === CONTRACT_KLINE_CACHE_VERSION && cache?.candles?.length) {
    return {
      candles: cache.candles,
      volumes: cache.volumes,
      updatedAt: cache.updatedAt,
    };
  }
  return null;
}

export function writeContractKlineCache(
  symbol: string,
  interval: string,
  data: Omit<ContractKlineCache, 'updatedAt'>,
) {
  const cache = readContractMarketCache(symbol);
  const normalizedInterval = String(interval || '').trim() || '1m';
  writeContractMarketCache(symbol, {
    klineCacheVersion: CONTRACT_KLINE_CACHE_VERSION,
    klines: {
      ...(cache?.klines || {}),
      [normalizedInterval]: {
        ...data,
        updatedAt: Date.now(),
        version: CONTRACT_KLINE_CACHE_VERSION,
      },
    },
  });
}

export function readContractTradesCache(symbol: string): ContractTradesCache | null {
  const cache = readContractMarketCache(symbol);
  if (!cache?.trades?.length) return null;
  return {
    trades: cache.trades,
    lastPrice: cache.tradesLastPrice,
    updatedAt: cache.updatedAt,
  };
}

export function writeContractTradesCache(symbol: string, data: Omit<ContractTradesCache, 'updatedAt'>) {
  writeContractMarketCache(symbol, {
    trades: data.trades,
    tradesLastPrice: data.lastPrice,
  });
}
