'use client';

import type { MarketTickerItem } from '@/lib/api/modules/market';

export const MARKET_CACHE_TTL_MS = 60_000;
export const SHARED_MARKETS_ROWS_CACHE_KEY = 'royal_exchange_markets_rows_v2';
export const SHARED_MARKETS_ROWS_CACHE_TTL_MS = 120_000;

type MarketCacheValue = Record<string, unknown> & {
  updatedAt?: number;
};

export type SharedMarketsRowsCache = {
  rows: MarketTickerItem[];
  lastUpdated: Date | null;
  stale: boolean;
};

function canUseStorage() {
  if (typeof window === 'undefined') return false;
  try {
    return !!window.localStorage;
  } catch {
    return false;
  }
}

export function getMarketCacheKey(kind: 'spot' | 'contract', symbol: string) {
  const normalizedSymbol = String(symbol || '').trim().toUpperCase();
  const cacheSymbol = kind === 'spot' ? normalizedSymbol.replace(/[^A-Z0-9-]/g, '') : normalizedSymbol;
  return `market-cache:${kind}:${cacheSymbol}`;
}

export function readMarketCache<T extends MarketCacheValue>(
  kind: 'spot' | 'contract',
  symbol: string,
): T | null {
  if (!canUseStorage()) return null;

  try {
    const raw = window.localStorage.getItem(getMarketCacheKey(kind, symbol));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as T;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function writeMarketCache<T extends MarketCacheValue>(
  kind: 'spot' | 'contract',
  symbol: string,
  patch: Partial<T>,
) {
  if (!canUseStorage()) return;

  const normalizedSymbol = String(symbol || '').trim().toUpperCase();
  const cacheSymbol = kind === 'spot' ? normalizedSymbol.replace(/[^A-Z0-9-]/g, '') : normalizedSymbol;
  const key = getMarketCacheKey(kind, cacheSymbol);
  const previous = readMarketCache<T>(kind, symbol) || ({} as T);
  const next = {
    ...previous,
    ...patch,
    symbol: cacheSymbol,
    updatedAt: Date.now(),
  };

  try {
    window.localStorage.setItem(key, JSON.stringify(next));
  } catch {
    // Best-effort cache only.
  }
}

export function clearMarketCache(kind: 'spot' | 'contract', symbol: string) {
  if (!canUseStorage()) return;

  try {
    window.localStorage.removeItem(getMarketCacheKey(kind, symbol));
  } catch {
    // Best-effort cache only.
  }
}

export function isMarketCacheFresh(cache: MarketCacheValue | null, ttlMs = MARKET_CACHE_TTL_MS) {
  const updatedAt = Number(cache?.updatedAt || 0);
  return Number.isFinite(updatedAt) && Date.now() - updatedAt <= ttlMs;
}

function parseCacheDate(value: unknown): Date | null {
  const timestamp = Number(value || 0);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  return new Date(timestamp);
}

export function readSharedMarketsRowsCache(): SharedMarketsRowsCache | null {
  if (!canUseStorage()) return null;

  try {
    const raw = window.localStorage.getItem(SHARED_MARKETS_ROWS_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      rows?: MarketTickerItem[];
      lastUpdatedAt?: number;
      savedAt?: number;
    };
    const rows = Array.isArray(parsed?.rows)
      ? parsed.rows.filter((row): row is MarketTickerItem => Boolean(row?.symbol))
      : [];
    if (rows.length === 0) return null;

    const savedAt = Number(parsed.savedAt || 0);
    return {
      rows,
      lastUpdated: parseCacheDate(parsed.lastUpdatedAt || savedAt),
      stale: !Number.isFinite(savedAt) || Date.now() - savedAt > SHARED_MARKETS_ROWS_CACHE_TTL_MS,
    };
  } catch {
    return null;
  }
}

export function writeSharedMarketsRowsCache(rows: MarketTickerItem[], lastUpdated: Date | null = new Date()) {
  if (!canUseStorage() || rows.length === 0) return;

  try {
    window.localStorage.setItem(
      SHARED_MARKETS_ROWS_CACHE_KEY,
      JSON.stringify({
        rows,
        lastUpdatedAt: lastUpdated?.getTime() || Date.now(),
        savedAt: Date.now(),
      }),
    );
  } catch {
    // Best-effort cache only.
  }
}
