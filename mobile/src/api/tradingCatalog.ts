import { publicApiClient } from './client';
import {
  getFreshExpiringEntry,
  setBoundedExpiringEntry,
} from '../utils/boundedExpiringMap';

const CATALOG_CACHE_TTL_MS = 30_000;
const CATALOG_CACHE_MAX_ENTRIES = 32;

export type SpotTradingInstrument = {
  symbol: string;
  displaySymbol: string;
  baseAsset: string;
  quoteAsset: string;
};

export type ContractTradingInstrument = {
  symbol: string;
  displayName: string;
  baseAsset: string;
  quoteAsset: string;
  category: string;
};

export type ContractMarketCategory = 'crypto' | 'stock' | 'cfd';

export type ContractCatalogInstrument = ContractTradingInstrument & {
  displaySymbol: string;
  marketCategory: ContractMarketCategory;
  providerSymbol: string;
  logoUrl: string | null;
  marketStatus: string;
};

type CacheEntry<T> = {
  expiresAt: number;
  value: T | null;
};

const spotCache = new Map<string, CacheEntry<SpotTradingInstrument>>();
const contractCache = new Map<string, CacheEntry<ContractTradingInstrument>>();
const spotRequests = new Map<string, Promise<SpotTradingInstrument | null>>();
const contractRequests = new Map<
  string,
  Promise<ContractTradingInstrument | null>
>();
let contractCatalogCache: CacheEntry<ContractCatalogInstrument[]> | null = null;
let contractCatalogRequest: Promise<ContractCatalogInstrument[]> | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeSymbol(value: unknown) {
  return String(value || '')
    .trim()
    .toUpperCase();
}

function readString(row: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value);
    }
  }
  return '';
}

function readRows(
  payload: unknown,
  endpoint: string,
): Record<string, unknown>[] {
  let rows: unknown[] | null = null;
  if (Array.isArray(payload)) {
    rows = payload;
  } else if (isRecord(payload)) {
    if (Array.isArray(payload.items)) {
      rows = payload.items;
    } else if (Array.isArray(payload.data)) {
      rows = payload.data;
    } else if (isRecord(payload.data) && Array.isArray(payload.data.items)) {
      rows = payload.data.items;
    }
  }
  if (rows === null) {
    throw new Error(`${endpoint} returned an invalid row container`);
  }
  if (rows.some(row => !isRecord(row))) {
    throw new Error(`${endpoint} returned an invalid catalog row`);
  }
  return rows as Record<string, unknown>[];
}

function isEnabled(row: Record<string, unknown>) {
  const status = row.status;
  const enabled = row.enabled;
  return (
    status !== 0 &&
    String(status ?? '1').toUpperCase() !== 'DISABLED' &&
    enabled !== false
  );
}

function mapSpotInstrument(
  row: unknown,
  requestedSymbol: string,
): SpotTradingInstrument | null {
  if (!isRecord(row) || !isEnabled(row)) return null;
  const symbol = normalizeSymbol(row.symbol);
  const baseAsset = normalizeSymbol(row.base_asset ?? row.baseAsset);
  const quoteAsset = normalizeSymbol(row.quote_asset ?? row.quoteAsset);
  if (!symbol || symbol !== requestedSymbol || !baseAsset || !quoteAsset) {
    return null;
  }
  return {
    symbol,
    displaySymbol:
      readString(row, ['display_symbol', 'displaySymbol']) ||
      `${baseAsset}/${quoteAsset}`,
    baseAsset,
    quoteAsset,
  };
}

function contractMatchScore(
  row: Record<string, unknown>,
  requestedSymbol: string,
) {
  const symbol = normalizeSymbol(row.symbol);
  const withoutPerp = symbol.replace(/_PERP$/, '');
  const providerSymbol = normalizeSymbol(
    row.provider_symbol ?? row.providerSymbol,
  );
  const baseAsset = normalizeSymbol(row.base_asset ?? row.baseAsset);
  const quoteAsset = normalizeSymbol(row.quote_asset ?? row.quoteAsset);
  const requestedWithoutPerp = requestedSymbol.replace(/_PERP$/, '');

  if (symbol === requestedSymbol) return 100;
  if (withoutPerp === requestedWithoutPerp) return 95;
  if (providerSymbol && providerSymbol === requestedWithoutPerp) return 90;
  if (
    baseAsset &&
    quoteAsset &&
    `${baseAsset}${quoteAsset}` === requestedWithoutPerp
  ) {
    return 85;
  }
  if (
    baseAsset &&
    requestedWithoutPerp.endsWith('USDT') &&
    requestedWithoutPerp.slice(0, -4) === baseAsset
  ) {
    return 75;
  }
  if (
    baseAsset &&
    quoteAsset === 'USDT' &&
    requestedWithoutPerp.endsWith('USD') &&
    requestedWithoutPerp.slice(0, -3) === baseAsset
  ) {
    return 74;
  }
  if (baseAsset && requestedWithoutPerp === baseAsset) return 70;
  return 0;
}

function mapContractInstrument(
  row: Record<string, unknown>,
): ContractTradingInstrument | null {
  if (!isEnabled(row)) return null;
  const symbol = normalizeSymbol(row.symbol);
  const baseAsset = normalizeSymbol(row.base_asset ?? row.baseAsset);
  const quoteAsset = normalizeSymbol(row.quote_asset ?? row.quoteAsset);
  if (!symbol || !baseAsset || !quoteAsset) return null;
  return {
    symbol,
    displayName:
      readString(row, ['display_name', 'displayName']) ||
      `${baseAsset}/${quoteAsset}`,
    baseAsset,
    quoteAsset,
    category: normalizeSymbol(row.category),
  };
}

function mapContractMarketCategory(
  category: string,
): ContractMarketCategory | null {
  if (category === 'CRYPTO') return 'crypto';
  if (category === 'STOCK') return 'stock';
  if (
    ['CFD', 'FOREX', 'FUTURES', 'GOLD', 'INDEX', 'METAL', 'COMMODITY'].includes(
      category,
    )
  ) {
    return 'cfd';
  }
  return null;
}

function mapContractCatalogInstrument(
  row: Record<string, unknown>,
): ContractCatalogInstrument {
  const mapped = mapContractInstrument(row);
  if (!mapped) {
    throw new Error('Contract trading catalog returned an invalid enabled row');
  }
  const marketCategory = mapContractMarketCategory(mapped.category);
  if (!marketCategory) {
    throw new Error(
      `Contract trading catalog returned an unsupported category: ${
        mapped.category || 'EMPTY'
      }`,
    );
  }
  const providerSymbol = normalizeSymbol(
    row.provider_symbol ?? row.providerSymbol,
  );
  return {
    ...mapped,
    displaySymbol: `${mapped.baseAsset}/${mapped.quoteAsset}`,
    marketCategory,
    providerSymbol,
    logoUrl:
      readString(row, ['base_asset_logo_url', 'baseAssetLogoUrl']) || null,
    marketStatus: normalizeSymbol(row.market_status ?? row.marketStatus),
  };
}

type ContractCatalogPage = {
  rows: Record<string, unknown>[];
  total: number;
  page: number;
  pageSize: number;
};

function readCatalogInteger(
  row: Record<string, unknown>,
  keys: string[],
  label: string,
) {
  for (const key of keys) {
    const raw = row[key];
    const value = typeof raw === 'string' && raw.trim() ? Number(raw) : raw;
    if (
      typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      value >= 0
    ) {
      return value;
    }
  }
  throw new Error(`Contract trading catalog returned an invalid ${label}`);
}

function readContractCatalogPage(payload: unknown): ContractCatalogPage {
  const root =
    isRecord(payload) && isRecord(payload.data) ? payload.data : payload;
  if (!isRecord(root)) {
    throw new Error('Contract trading catalog returned an invalid page');
  }
  const rows = readRows(root, 'Contract trading catalog');
  const total = readCatalogInteger(root, ['total'], 'total');
  const page = readCatalogInteger(root, ['page'], 'page');
  const pageSize = readCatalogInteger(
    root,
    ['page_size', 'pageSize'],
    'page size',
  );
  if (page < 1 || pageSize < 1 || pageSize > 100 || total > 10_000) {
    throw new Error('Contract trading catalog returned unsafe pagination');
  }
  return { rows, total, page, pageSize };
}

async function loadContractCatalogPage(page: number) {
  const payload = await publicApiClient.get<unknown>(
    `/contract/market/symbols?page=${page}&page_size=100`,
  );
  const result = readContractCatalogPage(payload);
  if (result.page !== page || result.pageSize !== 100) {
    throw new Error(
      'Contract trading catalog pagination did not match the request',
    );
  }
  return result;
}

async function fetchContractTradingCatalogUncached() {
  const first = await loadContractCatalogPage(1);
  const pageCount = Math.max(1, Math.ceil(first.total / first.pageSize));
  const remainingPages = await Promise.all(
    Array.from({ length: pageCount - 1 }, (_, index) =>
      loadContractCatalogPage(index + 2),
    ),
  );
  const pages = [first, ...remainingPages];
  if (pages.some(page => page.total !== first.total)) {
    throw new Error('Contract trading catalog changed during pagination');
  }
  const rows = pages.flatMap(page => page.rows);
  if (rows.length !== first.total) {
    throw new Error('Contract trading catalog returned an incomplete result');
  }

  const items = rows.map(mapContractCatalogInstrument);
  const symbols = new Set(items.map(item => item.symbol));
  if (symbols.size !== items.length) {
    throw new Error('Contract trading catalog returned duplicate symbols');
  }
  return items;
}

async function resolveSpotTradingInstrumentUncached(
  symbol: string,
): Promise<SpotTradingInstrument | null> {
  const payload = await publicApiClient.get<unknown>(
    `/market/pairs?market_type=spot&keyword=${encodeURIComponent(
      symbol,
    )}&page_size=20`,
  );
  for (const row of readRows(payload, 'Spot trading catalog')) {
    const item = mapSpotInstrument(row, symbol);
    if (item) return item;
  }
  return null;
}

async function resolveContractTradingInstrumentUncached(
  marketSymbol: string,
): Promise<ContractTradingInstrument | null> {
  const payload = await publicApiClient.get<unknown>(
    `/contract/market/symbols?keyword=${encodeURIComponent(
      marketSymbol,
    )}&page_size=100`,
  );
  const candidates = readRows(payload, 'Contract trading catalog')
    .map(row => ({ row, score: contractMatchScore(row, marketSymbol) }))
    .filter(candidate => candidate.score > 0)
    .sort((left, right) => right.score - left.score);

  for (const candidate of candidates) {
    const item = mapContractInstrument(candidate.row);
    if (item) return item;
  }
  return null;
}

async function resolveCached<T>(
  key: string,
  cache: Map<string, CacheEntry<T>>,
  requests: Map<string, Promise<T | null>>,
  load: () => Promise<T | null>,
) {
  const cached = getFreshExpiringEntry(cache, key);
  if (cached) return cached.value;
  const activeRequest = requests.get(key);
  if (activeRequest) return activeRequest;

  const request = load()
    .then(value => {
      const settledAt = Date.now();
      setBoundedExpiringEntry(
        cache,
        key,
        { expiresAt: settledAt + CATALOG_CACHE_TTL_MS, value },
        CATALOG_CACHE_MAX_ENTRIES,
        settledAt,
      );
      return value;
    })
    .finally(() => {
      requests.delete(key);
    });
  requests.set(key, request);
  return request;
}

export function resolveSpotTradingInstrument(symbol: string) {
  const normalized = normalizeSymbol(symbol);
  if (!normalized) return Promise.resolve(null);
  return resolveCached(normalized, spotCache, spotRequests, () =>
    resolveSpotTradingInstrumentUncached(normalized),
  );
}

export function resolveContractTradingInstrument(marketSymbol: string) {
  const normalized = normalizeSymbol(marketSymbol);
  if (!normalized) return Promise.resolve(null);
  return resolveCached(normalized, contractCache, contractRequests, () =>
    resolveContractTradingInstrumentUncached(normalized),
  );
}

export function getCachedContractTradingCatalog() {
  if (!contractCatalogCache || contractCatalogCache.expiresAt <= Date.now()) {
    contractCatalogCache = null;
    return [];
  }
  return contractCatalogCache.value || [];
}

export function fetchContractTradingCatalog() {
  const cached = getCachedContractTradingCatalog();
  if (contractCatalogCache) return Promise.resolve(cached);
  if (contractCatalogRequest) return contractCatalogRequest;

  contractCatalogRequest = fetchContractTradingCatalogUncached()
    .then(items => {
      contractCatalogCache = {
        expiresAt: Date.now() + CATALOG_CACHE_TTL_MS,
        value: items,
      };
      return items;
    })
    .finally(() => {
      contractCatalogRequest = null;
    });
  return contractCatalogRequest;
}

export function __resetTradingCatalogForTests() {
  spotCache.clear();
  contractCache.clear();
  spotRequests.clear();
  contractRequests.clear();
  contractCatalogCache = null;
  contractCatalogRequest = null;
}
