import {apiClient} from './client';

const PUBLIC_CACHE_TTL_MS = 3000;
const publicCache = new Map<string, {expiresAt: number; payload: unknown}>();

export type ContractOrderType = 'LIMIT' | 'MARKET';
export type ContractPositionSide = 'LONG' | 'SHORT';

export type ContractQuote = {
  symbol: string;
  lastPrice: number | null;
  markPrice: number | null;
  indexPrice: number | null;
  bidPrice: number | null;
  askPrice: number | null;
  changePercent: number | null;
  pricePrecision: number;
  executable?: boolean;
  quoteSource?: string | null;
  marketStatus?: string | null;
  spreadFeePrice?: number | null;
  effectiveSpread?: number | null;
};

export type ContractOrderBookLevel = {
  price: number;
  amount: number;
};

export type ContractDepth = {
  symbol: string;
  bids: ContractOrderBookLevel[];
  asks: ContractOrderBookLevel[];
  pricePrecision: number;
  executable?: boolean;
};

export type ContractMarketTrade = {
  id: string;
  price: number | null;
  amount: number | null;
  side: 'BUY' | 'SELL';
  ts?: number | string | null;
};

export type ContractKline = {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type ContractAccountSummary = {
  marginAsset: string;
  availableMargin: number | null;
  usedMargin: number | null;
  frozenMargin: number | null;
  positionMargin: number | null;
  realizedPnl: number | null;
  unrealizedPnl: number | null;
  equity: number | null;
};

export type ContractPositionItem = {
  id: string;
  symbol: string;
  side: ContractPositionSide;
  leverage: number;
  quantity: string;
  entryPrice: string;
  markPrice: string;
  marginAmount: string;
  unrealizedPnl: string;
  liquidationPrice: string;
  status: string;
};

export type ContractOrderItem = {
  id: string;
  symbol: string;
  positionSide: ContractPositionSide;
  action: 'OPEN' | 'CLOSE' | string;
  orderType: string;
  price: string;
  quantity: string;
  leverage: number;
  marginAmount: string;
  spreadFee: string;
  filledQuantity: string;
  status: string;
  createdAt?: string | null;
};

export type ContractTradeItem = {
  id: string;
  symbol: string;
  positionSide: ContractPositionSide;
  action: 'OPEN' | 'CLOSE' | string;
  price: string;
  quantity: string;
  notional: string;
  leverage: number;
  marginAmount: string;
  feeAmount: string;
  spreadFee: string;
  realizedPnl: string;
  createdAt?: string | null;
};

export type ContractOpenOrderPayload = {
  symbol: string;
  position_side: ContractPositionSide;
  order_type: ContractOrderType;
  price?: string | null;
  quantity: string;
  leverage: number;
};

export type ContractCloseSummaryPayload = {
  symbol: string;
  side: ContractPositionSide;
  order_type: ContractOrderType;
  price?: string | null;
  quantity?: string | null;
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

function normalizePositionSide(value: unknown): ContractPositionSide {
  return String(value || '').toUpperCase() === 'SHORT' ? 'SHORT' : 'LONG';
}

function normalizeTradeSide(value: unknown): 'BUY' | 'SELL' {
  const text = String(value || '').toUpperCase();
  if (text === 'SELL' || text === 'SHORT') return 'SELL';
  return 'BUY';
}

function getPricePrecision(symbol: string, price: number | null, fallback?: number | null) {
  if (typeof fallback === 'number' && Number.isFinite(fallback)) return fallback;
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

function withQuery(path: string, params: Record<string, string | number | undefined | null>) {
  const query = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && String(value) !== '')
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&');
  return query ? `${path}?${query}` : path;
}

export function formatContractNumber(
  value: number | null | undefined,
  precision = 4,
) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '--';
  return value.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: precision,
  });
}

export function formatContractPercent(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '--';
  const prefix = value > 0 ? '+' : '';
  return `${prefix}${value.toFixed(2)}%`;
}

export async function fetchContractQuote(symbol: string): Promise<ContractQuote | null> {
  const payload = await getCachedPublic<unknown>(
    `/contract/market/quote?symbol=${encodeURIComponent(symbol)}`,
  );
  const root = isRecord(payload) ? payload : {};
  const lastPrice = readNumber(root, ['last_price', 'lastPrice', 'price']);
  const markPrice = readNumber(root, ['mark_price', 'markPrice']);
  const normalizedSymbol = readString(root, ['symbol'], symbol).toUpperCase();
  return {
    symbol: normalizedSymbol,
    lastPrice,
    markPrice,
    indexPrice: readNumber(root, ['index_price', 'indexPrice']),
    bidPrice: readNumber(root, ['bid_price', 'bidPrice', 'bid', 'best_bid']),
    askPrice: readNumber(root, ['ask_price', 'askPrice', 'ask', 'best_ask']),
    changePercent: readNumber(root, [
      'price_change_percent_24h',
      'change_24h',
      'priceChangePercent',
    ]),
    pricePrecision: getPricePrecision(
      normalizedSymbol,
      markPrice ?? lastPrice,
      readNumber(root, ['price_precision', 'pricePrecision']),
    ),
    executable: typeof root.executable === 'boolean' ? root.executable : undefined,
    quoteSource: readString(root, ['quote_source', 'quoteSource']) || null,
    marketStatus: readString(root, ['market_status', 'marketStatus']) || null,
    spreadFeePrice: readNumber(root, [
      'single_side_spread_fee_price',
      'spread_fee_price',
      'spreadFeePrice',
    ]),
    effectiveSpread: readNumber(root, ['effective_total_spread', 'effectiveSpread']),
  };
}

export async function fetchContractDepth(
  symbol: string,
  limit = 10,
): Promise<ContractDepth> {
  const payload = await getCachedPublic<unknown>(
    `/contract/market/depth?symbol=${encodeURIComponent(symbol)}&limit=${limit}`,
  );
  const root = isRecord(payload) ? payload : {};
  const mapLevel = (row: unknown): ContractOrderBookLevel | null => {
    if (Array.isArray(row)) {
      const price = Number(row[0]);
      const amount = Number(row[1]);
      if (Number.isFinite(price) && Number.isFinite(amount)) return {price, amount};
      return null;
    }
    if (!isRecord(row)) return null;
    const price = readNumber(row, ['price']);
    const amount = readNumber(row, ['amount', 'qty', 'quantity']);
    if (price === null || amount === null) return null;
    return {price, amount};
  };
  const depthPrice = readNumber(root, ['best_bid', 'best_ask', 'bid', 'ask']);
  const normalizedSymbol = readString(root, ['symbol'], symbol).toUpperCase();
  return {
    symbol: normalizedSymbol,
    bids: readRows(root.bids, ['items']).map(mapLevel).filter(Boolean),
    asks: readRows(root.asks, ['items']).map(mapLevel).filter(Boolean),
    pricePrecision: getPricePrecision(
      normalizedSymbol,
      depthPrice,
      readNumber(root, ['price_precision', 'pricePrecision']),
    ),
    executable: typeof root.executable === 'boolean' ? root.executable : undefined,
  } as ContractDepth;
}

export async function fetchContractKlines(
  symbol: string,
  interval = '1m',
  limit = 80,
): Promise<ContractKline[]> {
  const payload = await getCachedPublic<unknown>(
    `/contract/market/kline?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}`,
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

export async function fetchContractMarketTrades(
  symbol: string,
  limit = 20,
): Promise<ContractMarketTrade[]> {
  const payload = await getCachedPublic<unknown>(
    `/contract/market/trades?symbol=${encodeURIComponent(symbol)}&limit=${limit}`,
  );
  return readRows(payload, ['trades', 'items', 'data']).map((row, index) => {
    const record = isRecord(row) ? row : {};
    return {
      id: readString(record, ['id', 'trade_id', 'tradeNo'], `${index}`),
      price: readNumber(record, ['price']),
      amount: readNumber(record, ['amount', 'qty', 'quantity']),
      side: normalizeTradeSide(record.side ?? record.position_side),
      ts: record.time as number | string | null | undefined,
    };
  });
}

export async function fetchContractAccountSummary(): Promise<ContractAccountSummary> {
  const payload = await apiClient.get<unknown>('/contract/account/summary');
  const root = isRecord(payload) ? payload : {};
  return {
    marginAsset: readString(root, ['margin_asset', 'marginAsset'], 'USDT'),
    availableMargin: readNumber(root, ['available_margin', 'availableMargin']),
    usedMargin: readNumber(root, ['used_margin', 'usedMargin']),
    frozenMargin: readNumber(root, ['frozen_margin', 'frozenMargin']),
    positionMargin: readNumber(root, ['position_margin', 'positionMargin']),
    realizedPnl: readNumber(root, ['realized_pnl', 'realizedPnl']),
    unrealizedPnl: readNumber(root, ['unrealized_pnl', 'unrealizedPnl']),
    equity: readNumber(root, ['equity']),
  };
}

export async function fetchContractPositions(
  symbol: string,
): Promise<ContractPositionItem[]> {
  const payload = await apiClient.get<unknown>(
    withQuery('/contract/positions', {symbol, status: 'OPEN'}),
  );
  return readRows(payload, ['items', 'data']).map((row, index) => {
    const record = isRecord(row) ? row : {};
    return {
      id: readString(record, ['id'], `${index}`),
      symbol: readString(record, ['symbol'], symbol).toUpperCase(),
      side: normalizePositionSide(record.side),
      leverage: readNumber(record, ['leverage']) ?? 0,
      quantity: readString(record, ['quantity'], '--'),
      entryPrice: readString(record, ['entry_price', 'entryPrice', 'avg_entry_price'], '--'),
      markPrice: readString(record, ['mark_price', 'markPrice'], '--'),
      marginAmount: readString(record, ['margin_amount', 'marginAmount'], '--'),
      unrealizedPnl: readString(record, ['unrealized_pnl', 'unrealizedPnl'], '--'),
      liquidationPrice: readString(record, ['liquidation_price', 'liquidationPrice'], '--'),
      status: readString(record, ['status'], '--'),
    };
  });
}

export async function fetchContractOrders(params: {
  symbol: string;
  status?: string;
  pageSize?: number;
}): Promise<ContractOrderItem[]> {
  const payload = await apiClient.get<unknown>(
    withQuery('/contract/orders', {
      symbol: params.symbol,
      status: params.status,
      page: 1,
      page_size: params.pageSize ?? 20,
    }),
  );
  return readRows(payload, ['items', 'data']).map((row, index) => {
    const record = isRecord(row) ? row : {};
    return {
      id: readString(record, ['id', 'order_id', 'order_no'], `${index}`),
      symbol: readString(record, ['symbol'], params.symbol).toUpperCase(),
      positionSide: normalizePositionSide(record.position_side ?? record.side),
      action: readString(record, ['action'], '--'),
      orderType: readString(record, ['order_type', 'orderType'], '--'),
      price: readString(record, ['price'], '--'),
      quantity: readString(record, ['quantity'], '--'),
      leverage: readNumber(record, ['leverage']) ?? 0,
      marginAmount: readString(record, ['margin_amount', 'marginAmount'], '--'),
      spreadFee: readString(record, ['spread_fee', 'spreadFee'], '--'),
      filledQuantity: readString(record, ['filled_quantity', 'filledQuantity'], '--'),
      status: readString(record, ['status'], '--'),
      createdAt: readString(record, ['created_at', 'createdAt']) || null,
    };
  });
}

export async function fetchContractTrades(
  symbol: string,
  pageSize = 20,
): Promise<ContractTradeItem[]> {
  const payload = await apiClient.get<unknown>(
    withQuery('/contract/trades', {symbol, page: 1, page_size: pageSize}),
  );
  return readRows(payload, ['items', 'data']).map((row, index) => {
    const record = isRecord(row) ? row : {};
    return {
      id: readString(record, ['id', 'trade_id', 'trade_no'], `${index}`),
      symbol: readString(record, ['symbol'], symbol).toUpperCase(),
      positionSide: normalizePositionSide(record.position_side),
      action: readString(record, ['action'], '--'),
      price: readString(record, ['price'], '--'),
      quantity: readString(record, ['quantity'], '--'),
      notional: readString(record, ['notional'], '--'),
      leverage: readNumber(record, ['leverage']) ?? 0,
      marginAmount: readString(record, ['margin_amount', 'marginAmount'], '--'),
      feeAmount: readString(record, ['fee_amount', 'feeAmount'], '--'),
      spreadFee: readString(record, ['spread_fee', 'spreadFee'], '--'),
      realizedPnl: readString(record, ['realized_pnl', 'realizedPnl'], '--'),
      createdAt: readString(record, ['created_at', 'createdAt']) || null,
    };
  });
}

export function openContractOrder(payload: ContractOpenOrderPayload) {
  return apiClient.post<unknown>('/contract/orders/open', payload);
}

export function closeContractSummaryOrder(payload: ContractCloseSummaryPayload) {
  return apiClient.post<unknown>('/contract/orders/close-summary', payload);
}
