import { apiClient } from './client';
import { formatFixedPrice } from '../utils/format';
import {
  getFreshExpiringEntry,
  getOrCreateInFlightRequest,
  setBoundedExpiringEntry,
} from '../utils/boundedExpiringMap';

const MARKET_PUBLIC_CACHE_TTL_MS = 5000;
const MARKET_PUBLIC_CACHE_MAX_ENTRIES = 24;
// Keep the last public catalog visible while a focus refresh is in flight.
// Trading screens never use this cache as execution authority, and both Home
// and Markets discard it immediately when the refresh itself fails.
export const MOBILE_MARKETS_MAX_STALE_MS = 2 * 60_000;
const publicMarketCache = new Map<
  string,
  { expiresAt: number; payload: unknown }
>();
const publicMarketRequests = new Map<string, Promise<unknown>>();
let mobileMarketsCache: {
  items: MarketInstrument[];
  updatedAt: number;
} | null = null;
let mobileMarketsRequest: Promise<MarketInstrument[]> | null = null;

export type MarketCategoryKey =
  | 'overview'
  | 'favorites'
  | 'crypto'
  | 'stock'
  | 'cfd'
  | 'onchain';

export type MarketInstrument = {
  id: string;
  symbol: string;
  displaySymbol: string;
  name: string;
  category: Exclude<MarketCategoryKey, 'overview' | 'favorites'>;
  price: number | null;
  changePercent: number | null;
  pricePrecision: number;
  logoUrl?: string | null;
  source: 'api';
  overviewRank?: number;
  tradable?: boolean;
  tradeMarket?: 'spot' | 'contract' | null;
  tradeSymbol?: string | null;
  tradeStatus?: 'ENABLED' | 'MARKET_DATA_ONLY' | 'UNSUPPORTED';
};

type MarketPairPayload = {
  items?: unknown[];
  total?: number;
  page?: number;
  page_size?: number;
};

type MobileMarketOverviewSectionPayload = {
  key?: string;
  title?: string;
  items?: unknown[];
};

type MobileMarketOverviewPayload = {
  server_time?: number;
  updated_at?: string;
  stale?: boolean;
  source?: string;
  overview_cards?: unknown[];
  sections?: MobileMarketOverviewSectionPayload[];
};

async function getCachedPublic<T>(url: string): Promise<T> {
  const now = Date.now();
  const cached = getFreshExpiringEntry(publicMarketCache, url, now);
  if (cached) {
    return cached.payload as T;
  }
  return getOrCreateInFlightRequest(publicMarketRequests, url, async () => {
    const payload = await apiClient.get<T>(url);
    const settledAt = Date.now();
    setBoundedExpiringEntry(
      publicMarketCache,
      url,
      { expiresAt: settledAt + MARKET_PUBLIC_CACHE_TTL_MS, payload },
      MARKET_PUBLIC_CACHE_MAX_ENTRIES,
      settledAt,
    );
    return payload;
  }) as Promise<T>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeSymbol(value: unknown) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function normalizeTradeSymbol(value: unknown) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, '');
}

function readString(row: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value);
    }
  }
  return '';
}

function readNumber(row: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const raw = row[key];
    let value: number;
    if (typeof raw === 'number') {
      value = raw;
    } else if (typeof raw === 'string') {
      const normalized = raw.trim();
      if (
        !normalized ||
        !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(normalized)
      ) {
        continue;
      }
      value = Number(normalized);
    } else {
      continue;
    }
    if (Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

function readPrecision(row: Record<string, unknown>, price: number | null) {
  const precision = readNumber(row, [
    'display_price_precision',
    'displayPricePrecision',
    'price_precision',
    'pricePrecision',
  ]);
  if (precision !== null && precision >= 0 && precision <= 8) {
    return Math.trunc(precision);
  }
  if (price !== null && Math.abs(price) < 1) return 5;
  if (price !== null && Math.abs(price) < 10) return 4;
  return 2;
}

function readRows(payload: unknown, endpoint: string): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!isRecord(payload)) {
    throw new Error(`${endpoint} returned an invalid market payload`);
  }
  if (Array.isArray(payload.items)) return payload.items;
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.rows)) return payload.rows;
  throw new Error(`${endpoint} returned an invalid market row container`);
}

function getDisplaySymbol(row: Record<string, unknown>, symbol: string) {
  const display = readString(row, [
    'display_symbol',
    'displaySymbol',
    'base_asset',
  ]);
  if (display) return display.replace('/USDT', '').replace('USDT', '');
  if (symbol.endsWith('USDT')) return symbol.slice(0, -4);
  return symbol;
}

function getCategory(row: Record<string, unknown>, symbol: string) {
  const category = readString(row, [
    'category',
    'market_category',
    'marketCategory',
    'asset_type',
    'assetType',
    'display_category',
    'displayCategory',
  ]).toUpperCase();
  const subCategory = readString(row, [
    'market_sub_category',
    'marketSubCategory',
  ]).toUpperCase();

  if (category === 'STOCKS') return 'stock';
  if (category === 'SPOT') return 'crypto';
  if (category === 'CONTRACT_CFD') return 'cfd';
  // The mobile overview currently labels RWA spot pairs as ONCHAIN even
  // though they are enabled in the authoritative spot catalog. The app has
  // no separate on-chain trading surface, so keep these real spot products
  // discoverable under Crypto and resolve the final route against /market/pairs
  // when the user opens one.
  if (category === 'ONCHAIN') return 'crypto';
  if (
    category.includes('STOCK') ||
    subCategory.includes('STOCK') ||
    ['NVDA', 'TSLA', 'SPXC', 'MU', 'SNDK'].includes(symbol)
  ) {
    return 'stock';
  }
  if (
    category.includes('RWA') ||
    category.includes('ONCHAIN') ||
    subCategory.includes('ONCHAIN') ||
    ['SPYX', 'COAI', 'AGT', 'CLO', 'TRIA'].includes(symbol)
  ) {
    return 'onchain';
  }
  if (
    category.includes('CONTRACT') ||
    category.includes('CFD') ||
    category.includes('INDEX') ||
    category.includes('FOREX') ||
    category.includes('METAL') ||
    category.includes('COMMODITY') ||
    ['NAS100', 'XAUUSD', 'XAGUSD', 'EURUSD', 'USOUSD'].includes(symbol)
  ) {
    return 'cfd';
  }
  return 'crypto';
}

function mapInstrument(row: unknown): MarketInstrument | null {
  if (!isRecord(row)) return null;
  const symbol = normalizeSymbol(
    row.symbol || row.ticker_symbol || row.source_symbol || row.external_symbol,
  );
  if (!symbol) return null;

  const price = readNumber(row, ['last_price', 'price', 'last', 'close']);
  const changePercent = readNumber(row, [
    'change_pct',
    'price_change_percent_24h',
    'change_24h',
    'percentChange24h',
    'priceChangePercent',
  ]);
  const displaySymbol = getDisplaySymbol(row, symbol);
  const name =
    readString(row, [
      'name',
      'display_name',
      'displayName',
      'name_zh',
      'label',
      'external_symbol',
    ]) || displaySymbol;
  const hasTradeRouteMetadata = [
    'tradable',
    'trade_market',
    'tradeMarket',
    'trade_symbol',
    'tradeSymbol',
    'trade_status',
    'tradeStatus',
  ].some(key => Object.prototype.hasOwnProperty.call(row, key));
  const rawTradeMarket = readString(row, [
    'trade_market',
    'tradeMarket',
  ]).toLowerCase();
  const tradeMarket =
    rawTradeMarket === 'spot' || rawTradeMarket === 'contract'
      ? rawTradeMarket
      : null;
  const tradeSymbol =
    normalizeTradeSymbol(row.trade_symbol ?? row.tradeSymbol) || null;
  const rawTradeStatus = readString(row, [
    'trade_status',
    'tradeStatus',
  ]).toUpperCase();
  const tradeStatus = (
    ['ENABLED', 'MARKET_DATA_ONLY', 'UNSUPPORTED'].includes(rawTradeStatus)
      ? rawTradeStatus
      : row.tradable === true
      ? 'ENABLED'
      : 'UNSUPPORTED'
  ) as MarketInstrument['tradeStatus'];
  const hasEnabledTradeRoute =
    row.tradable === true &&
    tradeMarket !== null &&
    tradeSymbol !== null &&
    tradeStatus === 'ENABLED';

  return {
    id: `api-${symbol}`,
    symbol,
    displaySymbol,
    name,
    category: getCategory(row, symbol),
    price,
    changePercent,
    pricePrecision: readPrecision(row, price),
    logoUrl:
      readString(row, [
        'spot_logo_url',
        'spotLogoUrl',
        'base_asset_logo_url',
        'baseAssetLogoUrl',
        'logo_url',
        'logoUrl',
        'icon_url',
        'iconUrl',
      ]) || null,
    source: 'api',
    overviewRank:
      readNumber(row, ['overview_rank', 'overviewRank']) ?? undefined,
    ...(hasTradeRouteMetadata
      ? {
          tradable: hasEnabledTradeRoute,
          tradeMarket,
          tradeSymbol: hasEnabledTradeRoute ? tradeSymbol : null,
          tradeStatus: hasEnabledTradeRoute
            ? 'ENABLED'
            : tradeStatus === 'ENABLED'
            ? 'UNSUPPORTED'
            : tradeStatus,
        }
      : {}),
  };
}

function mergeMarketLogoMetadata(items: MarketInstrument[], payload: unknown) {
  const logoBySymbol = new Map<string, string>();
  for (const row of readRows(payload, 'Spot market logo catalog')) {
    if (!isRecord(row)) continue;
    const symbol = normalizeSymbol(row.symbol);
    const logoUrl = readString(row, [
      'spot_logo_url',
      'spotLogoUrl',
      'base_asset_logo_url',
      'baseAssetLogoUrl',
      'logo_url',
      'logoUrl',
      'icon_url',
      'iconUrl',
    ]);
    if (symbol && logoUrl) logoBySymbol.set(symbol, logoUrl);
  }
  if (logoBySymbol.size === 0) return items;
  return items.map(item => ({
    ...item,
    logoUrl: item.logoUrl || logoBySymbol.get(item.symbol) || null,
  }));
}

function mergeRows(pairs: unknown[], tickers: unknown[]) {
  const bySymbol = new Map<string, Record<string, unknown>>();

  for (const row of [...pairs, ...tickers]) {
    if (!isRecord(row)) continue;
    const symbol = normalizeSymbol(
      readString(row, [
        'symbol',
        'ticker_symbol',
        'source_symbol',
        'external_symbol',
      ]),
    );
    if (!symbol) continue;
    bySymbol.set(symbol, {
      ...bySymbol.get(symbol),
      ...row,
      symbol,
    });
  }

  const items = Array.from(bySymbol.values())
    .map(mapInstrument)
    .filter((item): item is MarketInstrument => item !== null)
    .filter(isVisibleTradingCatalogItem);
  if (pairs.length + tickers.length > 0 && items.length === 0) {
    throw new Error('Legacy market APIs returned no valid instruments');
  }
  return items;
}

function readMobileOverviewRows(payload: unknown) {
  if (!isRecord(payload)) {
    throw new Error('Mobile market overview returned an invalid payload');
  }
  if (
    !Array.isArray(payload.overview_cards) ||
    !Array.isArray(payload.sections)
  ) {
    throw new Error('Mobile market overview returned an invalid row container');
  }

  const rows: unknown[] = [];
  rows.push(
    ...payload.overview_cards.map((item, index) =>
      isRecord(item) ? { ...item, overview_rank: index } : item,
    ),
  );
  for (const section of payload.sections) {
    if (!isRecord(section) || !Array.isArray(section.items)) {
      throw new Error('Mobile market overview returned an invalid section');
    }
    rows.push(...section.items);
  }
  return rows;
}

function mapMobileOverview(payload: unknown) {
  const rows = readMobileOverviewRows(payload);
  if (!rows.length) return [];

  const bySymbol = new Map<string, MarketInstrument>();
  for (const row of rows) {
    const mapped = mapInstrument(row);
    if (mapped && isVisibleTradingCatalogItem(mapped)) {
      const existing = bySymbol.get(mapped.symbol);
      bySymbol.set(mapped.symbol, {
        ...mapped,
        overviewRank: mapped.overviewRank ?? existing?.overviewRank,
      });
    }
  }
  const items = Array.from(bySymbol.values());
  if (rows.length > 0 && items.length === 0) {
    throw new Error('Mobile market overview returned no valid instruments');
  }
  return items;
}

function isVisibleTradingCatalogItem(item: MarketInstrument) {
  if (item.category !== 'cfd') return true;
  return (
    item.tradable === true &&
    item.tradeMarket === 'contract' &&
    Boolean(item.tradeSymbol)
  );
}

export function getOverviewMarkets(
  items: MarketInstrument[],
  preferredSymbols: readonly string[] = [],
) {
  const ranked = items
    .filter(item => typeof item.overviewRank === 'number')
    .sort((a, b) => (a.overviewRank || 0) - (b.overviewRank || 0));
  const bySymbol = new Map(items.map(item => [item.symbol, item]));
  const ordered: MarketInstrument[] = [];
  const seenIds = new Set<string>();
  const append = (item: MarketInstrument | undefined) => {
    if (!item || seenIds.has(item.id)) return;
    ordered.push(item);
    seenIds.add(item.id);
  };
  preferredSymbols.forEach(symbol =>
    append(bySymbol.get(normalizeSymbol(symbol))),
  );
  ranked.forEach(append);
  items.forEach(append);
  return ordered.slice(0, 6);
}

export function formatMarketPrice(item: MarketInstrument) {
  return formatFixedPrice(item.price, item.pricePrecision);
}

export function formatMarketPercent(value: number | null) {
  if (value === null) return '--';
  const prefix = value > 0 ? '+' : '';
  return `${prefix}${value.toFixed(2)}%`;
}

export function getCachedMobileMarkets() {
  if (!mobileMarketsCache) {
    return [];
  }
  if (Date.now() - mobileMarketsCache.updatedAt > MOBILE_MARKETS_MAX_STALE_MS) {
    mobileMarketsCache = null;
    return [];
  }
  return mobileMarketsCache.items;
}

async function fetchMobileMarketsLegacy() {
  const [pairPayload, tickerPayload] = await Promise.all([
    getCachedPublic<MarketPairPayload>(
      '/market/pairs?market_type=all&page_size=100',
    ),
    getCachedPublic<unknown[]>('/market/tickers'),
  ]);
  return mergeRows(
    readRows(pairPayload, 'Market pairs API'),
    readRows(tickerPayload, 'Market tickers API'),
  );
}

export async function fetchMobileMarkets() {
  const now = Date.now();
  if (
    mobileMarketsCache &&
    now - mobileMarketsCache.updatedAt < MARKET_PUBLIC_CACHE_TTL_MS
  ) {
    return mobileMarketsCache.items;
  }

  if (mobileMarketsRequest) return mobileMarketsRequest;

  mobileMarketsRequest = (async () => {
    let overviewError: unknown = null;
    try {
      const overviewPayload =
        await getCachedPublic<MobileMarketOverviewPayload>(
          '/market/mobile/overview',
        );
      const overviewRows = mapMobileOverview(overviewPayload);
      if (overviewRows.length > 0) {
        let enrichedRows = overviewRows;
        try {
          const pairPayload = await getCachedPublic<MarketPairPayload>(
            '/market/pairs?market_type=spot&page_size=100',
          );
          enrichedRows = mergeMarketLogoMetadata(overviewRows, pairPayload);
        } catch {
          // Product logos are presentation metadata. A missing or malformed
          // logo catalog must not hide otherwise valid market rows.
        }
        mobileMarketsCache = {
          items: enrichedRows,
          updatedAt: Date.now(),
        };
        return enrichedRows;
      }
    } catch (error) {
      overviewError = error;
    }

    const legacyRows = await fetchMobileMarketsLegacy();
    if (overviewError && legacyRows.length === 0) {
      throw new Error(
        'Market catalog is unavailable because the primary response was invalid',
      );
    }

    mobileMarketsCache = { items: legacyRows, updatedAt: Date.now() };
    return legacyRows;
  })();

  try {
    return await mobileMarketsRequest;
  } catch (error) {
    mobileMarketsCache = null;
    throw error;
  } finally {
    mobileMarketsRequest = null;
  }
}

export function __resetMobileMarketCacheForTests() {
  publicMarketCache.clear();
  publicMarketRequests.clear();
  mobileMarketsCache = null;
  mobileMarketsRequest = null;
}
