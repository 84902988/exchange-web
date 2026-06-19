import {apiClient} from './client';

const PUBLIC_CACHE_TTL_MS = 4000;
const publicCache = new Map<string, {expiresAt: number; payload: unknown}>();

export type SpotTicker = {
  symbol: string;
  lastPrice: number | null;
  changePercent: number | null;
  pricePrecision: number;
};

export type SpotOrderBookLevel = {
  price: number;
  amount: number;
};

export type SpotOrderBook = {
  symbol: string;
  bids: SpotOrderBookLevel[];
  asks: SpotOrderBookLevel[];
};

export type SpotTrade = {
  id: string;
  price: number | null;
  amount: number | null;
  side: 'BUY' | 'SELL';
  ts?: number | string | null;
};

export type SpotKline = {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type SpotBalanceItem = {
  coinSymbol: string;
  availableAmount: number | null;
  frozenAmount: number | null;
};

export type SpotOrderItem = {
  id: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  orderType: string;
  price: string;
  amount: string;
  filledAmount: string;
  status: string;
  createdAt?: string | null;
};

export type SpotMyTradeItem = {
  id: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  price: string;
  amount: string;
  quoteAmount: string;
  createdAt?: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readRows(payload: unknown, keys: string[]) {
  if (Array.isArray(payload)) return payload;
  if (!isRecord(payload)) return [];
  for (const key of keys) {
    const value = payload[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

function readString(row: Record<string, unknown>, keys: string[], fallback = '') {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return fallback;
}

function readNumber(row: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = Number(row[key]);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function normalizeSide(value: unknown): 'BUY' | 'SELL' {
  return String(value || '').toUpperCase() === 'SELL' ? 'SELL' : 'BUY';
}

function getPricePrecision(symbol: string, price: number | null) {
  const normalized = symbol.toUpperCase();
  if (normalized.includes('BTC') || normalized.includes('ETH')) return 2;
  if (price !== null && Math.abs(price) < 1) return 5;
  if (price !== null && Math.abs(price) < 10) return 4;
  return 2;
}

async function getCachedPublic<T>(url: string): Promise<T> {
  const now = Date.now();
  const cached = publicCache.get(url);
  if (cached && cached.expiresAt > now) return cached.payload as T;
  const payload = await apiClient.get<T>(url);
  publicCache.set(url, {expiresAt: now + PUBLIC_CACHE_TTL_MS, payload});
  return payload;
}

export function formatSpotNumber(
  value: number | null | undefined,
  precision = 4,
) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '--';
  return value.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: precision,
  });
}

export function formatSpotPercent(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '--';
  const prefix = value > 0 ? '+' : '';
  return `${prefix}${value.toFixed(2)}%`;
}

export async function fetchSpotTicker(symbol: string): Promise<SpotTicker | null> {
  const payload = await getCachedPublic<unknown>(
    `/market/tickers?symbol=${encodeURIComponent(symbol)}`,
  );
  const rows = readRows(payload, ['items', 'data', 'rows']);
  const raw = rows[0];
  if (!isRecord(raw)) return null;
  const normalizedSymbol = readString(raw, ['symbol'], symbol).toUpperCase();
  const lastPrice = readNumber(raw, ['last_price', 'price', 'last', 'close']);
  const changePercent = readNumber(raw, [
    'price_change_percent_24h',
    'change_24h',
    'priceChangePercent',
  ]);
  return {
    symbol: normalizedSymbol,
    lastPrice,
    changePercent,
    pricePrecision: getPricePrecision(normalizedSymbol, lastPrice),
  };
}

export async function fetchSpotDepth(
  symbol: string,
  limit = 10,
): Promise<SpotOrderBook> {
  const payload = await getCachedPublic<unknown>(
    `/market/depth?symbol=${encodeURIComponent(symbol)}&limit=${limit}`,
  );
  const root = isRecord(payload) ? payload : {};
  const mapLevel = (row: unknown): SpotOrderBookLevel | null => {
    if (!isRecord(row)) return null;
    const price = readNumber(row, ['price']);
    const amount = readNumber(row, ['amount', 'qty', 'quantity']);
    if (price === null || amount === null) return null;
    return {price, amount};
  };
  return {
    symbol: readString(root, ['symbol'], symbol).toUpperCase(),
    bids: readRows(root.bids, ['items']).map(mapLevel).filter(Boolean),
    asks: readRows(root.asks, ['items']).map(mapLevel).filter(Boolean),
  } as SpotOrderBook;
}

export async function fetchSpotTrades(
  symbol: string,
  limit = 20,
): Promise<SpotTrade[]> {
  const payload = await getCachedPublic<unknown>(
    `/market/trades?symbol=${encodeURIComponent(symbol)}&limit=${limit}`,
  );
  return readRows(payload, ['trades', 'items', 'data']).map((row, index) => {
    const record = isRecord(row) ? row : {};
    return {
      id: readString(record, ['id', 'trade_id'], `${index}`),
      price: readNumber(record, ['price']),
      amount: readNumber(record, ['amount']),
      side: normalizeSide(record.side),
      ts: record.ts as number | string | null | undefined,
    };
  });
}

export async function fetchSpotKlines(
  symbol: string,
  interval = '1m',
  limit = 40,
): Promise<SpotKline[]> {
  const payload = await getCachedPublic<unknown>(
    `/market/kline?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}`,
  );
  return readRows(payload, ['items', 'data', 'rows']).map(row => {
    const record = isRecord(row) ? row : {};
    return {
      openTime: Number(record.open_time || record.openTime || record.timestamp || record.time || 0),
      open: Number(record.open || 0),
      high: Number(record.high || 0),
      low: Number(record.low || 0),
      close: Number(record.close || 0),
      volume: Number(record.volume || 0),
    };
  });
}

export async function fetchSpotBalances(symbol: string): Promise<SpotBalanceItem[]> {
  const payload = await apiClient.get<unknown>(
    `/spot/balances?symbol=${encodeURIComponent(symbol)}`,
  );
  return readRows(payload, ['items', 'data']).map(row => {
    const record = isRecord(row) ? row : {};
    return {
      coinSymbol: readString(record, ['coin_symbol', 'coinSymbol', 'symbol']),
      availableAmount: readNumber(record, ['available_amount', 'availableAmount']),
      frozenAmount: readNumber(record, ['frozen_amount', 'frozenAmount']),
    };
  });
}

export async function fetchSpotCurrentOrders(
  symbol: string,
  limit = 20,
): Promise<SpotOrderItem[]> {
  const payload = await apiClient.get<unknown>(
    `/spot/orders/current?symbol=${encodeURIComponent(symbol)}&limit=${limit}`,
  );
  return readRows(payload, ['items', 'data']).map(mapSpotOrder);
}

export async function fetchSpotHistoryOrders(
  symbol: string,
  limit = 20,
): Promise<SpotOrderItem[]> {
  const payload = await apiClient.get<unknown>(
    `/spot/orders/history?symbol=${encodeURIComponent(symbol)}&limit=${limit}`,
  );
  return readRows(payload, ['items', 'data']).map(mapSpotOrder);
}

export async function fetchSpotMyTrades(
  symbol: string,
  limit = 20,
): Promise<SpotMyTradeItem[]> {
  const payload = await apiClient.get<unknown>(
    `/spot/trades?symbol=${encodeURIComponent(symbol)}&limit=${limit}`,
  );
  return readRows(payload, ['items', 'data']).map((row, index) => {
    const record = isRecord(row) ? row : {};
    return {
      id: readString(record, ['trade_id', 'id'], `${index}`),
      symbol: readString(record, ['symbol'], symbol).toUpperCase(),
      side: normalizeSide(record.side),
      price: readString(record, ['price'], '--'),
      amount: readString(record, ['amount'], '--'),
      quoteAmount: readString(record, ['quote_amount', 'quoteAmount'], '--'),
      createdAt: readString(record, ['created_at', 'createdAt']) || null,
    };
  });
}

function mapSpotOrder(row: unknown, index: number): SpotOrderItem {
  const record = isRecord(row) ? row : {};
  return {
    id: readString(record, ['id', 'order_id', 'order_no'], `${index}`),
    symbol: readString(record, ['symbol']).toUpperCase(),
    side: normalizeSide(record.side),
    orderType: readString(record, ['order_type', 'orderType'], 'LIMIT'),
    price: readString(record, ['price'], '--'),
    amount: readString(record, ['amount'], '--'),
    filledAmount: readString(record, ['filled_amount', 'filledAmount'], '--'),
    status: readString(record, ['status'], '--'),
    createdAt: readString(record, ['created_at', 'createdAt']) || null,
  };
}
