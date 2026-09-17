import {branding} from '../config/branding';
import AsyncStorage from '@react-native-async-storage/async-storage';

export const MARKET_FAVORITES_STORAGE_KEY =
  'exchange_mobile_market_favorites_v1';

type MarketFavoritesPayload = {
  version: 1;
  symbols: string[];
};

let cachedSymbols: string[] | null = null;
let loadPromise: Promise<string[]> | null = null;
let mutationQueue: Promise<unknown> = Promise.resolve();
const listeners = new Set<(symbols: string[]) => void>();

export function normalizeMarketFavoriteSymbol(value: unknown) {
  if (typeof value !== 'string') return '';
  const symbol = value.trim().toUpperCase();
  return /^[A-Z0-9][A-Z0-9._-]{0,63}$/.test(symbol) ? symbol : '';
}

export function normalizeMarketFavoriteSymbols(value: unknown) {
  const rows = Array.isArray(value)
    ? value
    : isMarketFavoritesPayload(value)
      ? value.symbols
      : [];
  const symbols: string[] = [];
  const seen = new Set<string>();
  rows.forEach(row => {
    const symbol = normalizeMarketFavoriteSymbol(row);
    if (!symbol || seen.has(symbol)) return;
    seen.add(symbol);
    symbols.push(symbol);
  });
  return symbols;
}

export function getCachedMarketFavoriteSymbols() {
  return cachedSymbols ? [...cachedSymbols] : [];
}

export function hasLoadedMarketFavoriteSymbols() {
  return cachedSymbols !== null;
}

export function subscribeMarketFavoriteSymbols(
  listener: (symbols: string[]) => void,
) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

async function readStoredFavorites() {
  const current = await AsyncStorage.getItem(MARKET_FAVORITES_STORAGE_KEY);
  if (current !== null) return current;
  for (const key of branding.legacyFavoritesStorageKeys) {
    const previous = await AsyncStorage.getItem(key);
    if (previous === null) continue;
    try {
      const symbols = normalizeMarketFavoriteSymbols(JSON.parse(previous));
      const migrated = JSON.stringify({version: 1, symbols});
      await AsyncStorage.setItem(MARKET_FAVORITES_STORAGE_KEY, migrated).catch(() => undefined);
      return migrated;
    } catch { /* Ignore an invalid legacy value. */ }
  }
  return null;
}

export function loadMarketFavoriteSymbols() {
  if (cachedSymbols) {
    return Promise.resolve([...cachedSymbols]);
  }
  if (loadPromise) return loadPromise;

  loadPromise = readStoredFavorites()
    .then(raw => {
      if (!raw) return [];
      try {
        return normalizeMarketFavoriteSymbols(JSON.parse(raw));
      } catch {
        return [];
      }
    })
    .then(symbols => {
      cachedSymbols = symbols;
      notify(symbols);
      return [...symbols];
    })
    .finally(() => {
      loadPromise = null;
    });
  return loadPromise;
}

export function toggleMarketFavoriteSymbol(value: unknown) {
  const symbol = normalizeMarketFavoriteSymbol(value);
  if (!symbol) {
    return Promise.reject(new Error('Invalid market favorite symbol'));
  }

  const mutation = mutationQueue.then(async () => {
    const current = cachedSymbols ?? (await loadMarketFavoriteSymbols());
    const next = current.includes(symbol)
      ? current.filter(item => item !== symbol)
      : [...current, symbol];
    const payload: MarketFavoritesPayload = {version: 1, symbols: next};
    await AsyncStorage.setItem(
      MARKET_FAVORITES_STORAGE_KEY,
      JSON.stringify(payload),
    );
    cachedSymbols = next;
    notify(next);
    return [...next];
  });
  mutationQueue = mutation.catch(() => undefined);
  return mutation;
}

export function __resetMarketFavoritesForTests() {
  cachedSymbols = null;
  loadPromise = null;
  mutationQueue = Promise.resolve();
  listeners.clear();
}

function isMarketFavoritesPayload(value: unknown): value is MarketFavoritesPayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as {version?: unknown}).version === 1 &&
    Array.isArray((value as {symbols?: unknown}).symbols)
  );
}

function notify(symbols: string[]) {
  listeners.forEach(listener => listener([...symbols]));
}
