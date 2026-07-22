'use client';

export const CONTRACT_SELECTOR_TICKER_CACHE_KEY = 'royal_exchange_contract_selector_tickers_v1';
export const CONTRACT_SELECTOR_TICKER_MAX_STALE_MS = 2 * 60_000;
const CONTRACT_SELECTOR_TICKER_MAX_ENTRIES = 240;

type TickerScalar = string | number | null;

export type ContractSelectorTickerCacheItem = {
  symbol: string;
  price?: TickerScalar;
  change24h?: TickerScalar;
  percentChange24h?: TickerScalar;
  priceChangePercent?: TickerScalar;
  priceChange24h?: TickerScalar;
  volume24h?: TickerScalar;
  baseVolume24h?: TickerScalar;
  quoteVolume24h?: TickerScalar;
  high24h?: TickerScalar;
  low24h?: TickerScalar;
  marketStatus?: string | null;
  marketStatusText?: string | null;
  quoteFreshness?: string | null;
  displayPricePrecision?: number | null;
  pricePrecision?: number | null;
  updatedAt: number;
};

function canUseStorage(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return !!window.localStorage;
  } catch {
    return false;
  }
}

function normalizeSymbol(value: unknown): string {
  return String(value || '').trim().toUpperCase();
}

function optionalScalar(value: unknown): TickerScalar | undefined {
  if (value === null) return null;
  return typeof value === 'string' || typeof value === 'number' ? value : undefined;
}

function optionalText(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === 'string' ? value : undefined;
}

function optionalPrecision(value: unknown): number | null | undefined {
  if (value === null) return null;
  const precision = Number(value);
  return Number.isInteger(precision) && precision >= 0 && precision <= 12
    ? precision
    : undefined;
}

function sanitizeItem(value: unknown, now = Date.now()): ContractSelectorTickerCacheItem | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  const symbol = normalizeSymbol(item.symbol);
  const updatedAt = Number(item.updatedAt || 0);
  if (!symbol || !Number.isFinite(updatedAt) || updatedAt <= 0) return null;
  if (now - updatedAt > CONTRACT_SELECTOR_TICKER_MAX_STALE_MS) return null;

  const sanitized: ContractSelectorTickerCacheItem = { symbol, updatedAt };
  const scalarFields = [
    'price',
    'change24h',
    'percentChange24h',
    'priceChangePercent',
    'priceChange24h',
    'volume24h',
    'baseVolume24h',
    'quoteVolume24h',
    'high24h',
    'low24h',
  ] as const;
  scalarFields.forEach((field) => {
    const nextValue = optionalScalar(item[field]);
    if (nextValue !== undefined) sanitized[field] = nextValue;
  });
  const textFields = ['marketStatus', 'marketStatusText', 'quoteFreshness'] as const;
  textFields.forEach((field) => {
    const nextValue = optionalText(item[field]);
    if (nextValue !== undefined) sanitized[field] = nextValue;
  });
  const precisionFields = ['displayPricePrecision', 'pricePrecision'] as const;
  precisionFields.forEach((field) => {
    const nextValue = optionalPrecision(item[field]);
    if (nextValue !== undefined) sanitized[field] = nextValue;
  });

  const price = sanitized.price;
  const change = sanitized.change24h ?? sanitized.percentChange24h ?? sanitized.priceChangePercent;
  const hasPrice = price !== null && price !== undefined && price !== '' && Number.isFinite(Number(price));
  const hasChange = change !== null && change !== undefined && change !== '' && Number.isFinite(Number(change));
  return hasPrice || hasChange ? sanitized : null;
}

function readRawItems(): unknown[] {
  if (!canUseStorage()) return [];
  try {
    const raw = window.localStorage.getItem(CONTRACT_SELECTOR_TICKER_CACHE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { items?: unknown[] };
    return Array.isArray(parsed?.items) ? parsed.items : [];
  } catch {
    return [];
  }
}

export function readContractSelectorTickerCache(): ContractSelectorTickerCacheItem[] {
  const now = Date.now();
  return readRawItems()
    .map((item) => sanitizeItem(item, now))
    .filter((item): item is ContractSelectorTickerCacheItem => Boolean(item))
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, CONTRACT_SELECTOR_TICKER_MAX_ENTRIES);
}

export function writeContractSelectorTickerCache(
  items: Array<Omit<ContractSelectorTickerCacheItem, 'updatedAt'> & { updatedAt?: number }>,
): void {
  if (!canUseStorage() || items.length === 0) return;

  const now = Date.now();
  const merged = new Map<string, ContractSelectorTickerCacheItem>();
  readContractSelectorTickerCache().forEach((item) => merged.set(item.symbol, item));
  items.forEach((item) => {
    const next = sanitizeItem({ ...item, updatedAt: item.updatedAt || now }, now);
    if (next) merged.set(next.symbol, next);
  });

  const nextItems = Array.from(merged.values())
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, CONTRACT_SELECTOR_TICKER_MAX_ENTRIES);
  try {
    window.localStorage.setItem(
      CONTRACT_SELECTOR_TICKER_CACHE_KEY,
      JSON.stringify({ version: 1, savedAt: now, items: nextItems }),
    );
  } catch {
    // Best-effort public market-data cache only.
  }
}

export function clearContractSelectorTickerCache(): void {
  if (!canUseStorage()) return;
  try {
    window.localStorage.removeItem(CONTRACT_SELECTOR_TICKER_CACHE_KEY);
  } catch {
    // Best-effort cache only.
  }
}
