import type {
  ContractMarketKlineItem,
  ContractMarketKlineMetadataResponse,
} from '@/lib/api/modules/contract';
import {
  CONTRACT_KLINE_CURRENT_CACHE_TTL_MS,
  normalizeContractKlineAssetClass,
  type ContractKlineAssetClass,
} from './contractKlineCachePolicy';

export const CONTRACT_KLINE_CURRENT_CACHE_MAX_ENTRIES = 64;

export type ContractKlineCurrentCacheKeyParams = {
  category?: ContractKlineAssetClass | string | null;
  symbol: string;
  interval: string;
  limit: number;
};

type ContractKlineCurrentCacheEntry = {
  response: ContractMarketKlineMetadataResponse;
  writtenAt: number;
  expiresAt: number;
};

type ContractKlineCurrentCacheOptions = {
  maxEntries?: number;
  now?: () => number;
};

const NON_PROVIDER_KLINE_SOURCE_TOKENS = new Set([
  'BBO',
  'DEPTH',
  'DISPLAY_PRICE',
  'LIVE_MID',
  'QUOTE_DRIVEN',
  'SYNTHETIC_FROM_QUOTE',
  'TRADE_TICK',
]);

function normalizeSymbol(symbol: string) {
  return String(symbol || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
}

function normalizeInterval(interval: string) {
  const normalized = String(interval || '').trim();
  return normalized === '1M' ? '1M' : normalized.toLowerCase();
}

function normalizeTtlMs(ttlMs: number) {
  return Number.isFinite(ttlMs) && ttlMs > 0
    ? Math.max(1, Math.floor(ttlMs))
    : CONTRACT_KLINE_CURRENT_CACHE_TTL_MS;
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isProviderKlineItem(value: unknown) {
  const record = toRecord(value);
  if (!record) return false;
  const hasProviderSource = ['kline_mode', 'price_source', 'source', 'quote_source'].every((key) => {
    const rawValue = record[key];
    if (rawValue === undefined || rawValue === null || rawValue === '') return true;
    const normalized = String(rawValue).trim().toUpperCase();
    return (
      !NON_PROVIDER_KLINE_SOURCE_TOKENS.has(normalized)
      && !normalized.includes('QUOTE')
      && !normalized.includes('SYNTHETIC')
    );
  });
  if (!hasProviderSource) return false;

  const openTime = Number(record.open_time ?? record.time ?? record.timestamp);
  const hasValidOhlc = ['open', 'high', 'low', 'close'].every((key) => (
    Number.isFinite(Number(record[key]))
  ));
  return Number.isFinite(openTime) && openTime > 0 && hasValidOhlc;
}

function cloneKlineItem(item: ContractMarketKlineItem) {
  return { ...item };
}

export function cloneContractKlineMetadataResponse(
  response: ContractMarketKlineMetadataResponse,
): ContractMarketKlineMetadataResponse {
  return {
    ...response,
    items: response.items.map(cloneKlineItem),
  };
}

export function buildContractKlineCurrentCacheKey(params: ContractKlineCurrentCacheKeyParams) {
  return [
    normalizeContractKlineAssetClass(params.category),
    normalizeSymbol(params.symbol),
    normalizeInterval(params.interval),
    params.limit,
  ].join('|');
}

export function isContractKlineCurrentResponseCacheable(value: unknown) {
  const record = toRecord(value);
  if (!record || !Array.isArray(record.items) || record.items.length === 0) return false;
  if (!record.items.every(isProviderKlineItem)) return false;
  const cacheStatus = typeof record.cache_status === 'string'
    ? record.cache_status.trim().toUpperCase()
    : '';
  const freshnessMatchesCacheStatus = (
    (record.freshness === 'RECENT' && cacheStatus === 'MISS')
    || (record.freshness === 'CACHED' && cacheStatus === 'HIT')
  );
  return (
    freshnessMatchesCacheStatus
    && record.stale === false
    && record.history_incomplete === false
    && record.history_complete === null
    && record.has_more_before === null
    && record.provider_error_code === null
    && record.retryable === false
  );
}

export class ContractKlineCurrentCache {
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, ContractKlineCurrentCacheEntry>();

  constructor({
    maxEntries = CONTRACT_KLINE_CURRENT_CACHE_MAX_ENTRIES,
    now = Date.now,
  }: ContractKlineCurrentCacheOptions = {}) {
    this.maxEntries = Math.max(1, Math.floor(maxEntries));
    this.now = now;
  }

  get(params: ContractKlineCurrentCacheKeyParams) {
    const key = buildContractKlineCurrentCacheKey(params);
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return null;
    }
    return cloneContractKlineMetadataResponse(entry.response);
  }

  set(
    params: ContractKlineCurrentCacheKeyParams,
    response: ContractMarketKlineMetadataResponse,
    ttlMs: number,
  ) {
    if (!isContractKlineCurrentResponseCacheable(response)) return false;
    const key = buildContractKlineCurrentCacheKey(params);
    const writtenAt = this.now();
    this.entries.delete(key);
    this.entries.set(key, {
      response: cloneContractKlineMetadataResponse(response),
      writtenAt,
      expiresAt: writtenAt + normalizeTtlMs(ttlMs),
    });
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (!oldestKey) break;
      this.entries.delete(oldestKey);
    }
    return true;
  }

  clear() {
    this.entries.clear();
  }

  get size() {
    return this.entries.size;
  }
}

export const contractKlineCurrentCache = new ContractKlineCurrentCache();
