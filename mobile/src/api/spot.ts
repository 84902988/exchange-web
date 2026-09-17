import { ApiClientError, apiClient, publicApiClient } from './client';
import {
  getFreshExpiringEntry,
  getOrCreateInFlightRequest,
  setBoundedExpiringEntry,
} from '../utils/boundedExpiringMap';

const PUBLIC_CACHE_TTL_MS = 4000;
const PUBLIC_CACHE_MAX_ENTRIES = 32;
const publicCache = new Map<string, { expiresAt: number; payload: unknown }>();
const publicRequests = new Map<string, Promise<unknown>>();

export type SpotDisplayPricePrecisionSource =
  | 'display_price_precision'
  | 'price_tick_size'
  | 'price_precision'
  | 'fallback';

export type SpotTicker = {
  symbol: string;
  lastPrice: number | null;
  changePercent: number | null;
  high24h: number | null;
  low24h: number | null;
  baseVolume24h: number | null;
  quoteVolume24h: number | null;
  pricePrecision: number;
  displayPricePrecision?: number | null;
  displayPricePrecisionSource?: SpotDisplayPricePrecisionSource;
  priceTickSize?: number | null;
  amountPrecision: number;
  minAmount: number | null;
  minNotional: number | null;
  marketStatus?: string | null;
  freshness?: string | null;
  stale?: boolean;
};

export type SpotOrderBookLevel = {
  price: number;
  amount: number;
};

export type SpotOrderBook = {
  symbol: string;
  bids: SpotOrderBookLevel[];
  asks: SpotOrderBookLevel[];
  freshness?: string | null;
  stale?: boolean;
};

export type SpotTrade = {
  id: string;
  price: number | null;
  amount: number | null;
  side: 'BUY' | 'SELL';
  ts?: number | string | null;
};

export type SpotMarketView = {
  symbol: string;
  ticker: SpotTicker;
  depth: SpotOrderBook;
  trades: SpotTrade[];
  displayPrice: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  executionBid: number | null;
  executionAsk: number | null;
  executable: boolean;
  marketStatus: string;
  quoteFreshness: string | null;
  depthFreshness: string | null;
  tradesFreshness: string | null;
  updatedAt: string | null;
  tickerObservedAtMs: number | null;
  depthObservedAtMs: number | null;
  tradesObservedAtMs: number | null;
  warnings: string[];
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
  orderId: number | null;
  clientOrderId?: string | null;
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

export type SpotCursorPage<T> = {
  items: T[];
  hasMore: boolean;
  nextCursor: number | null;
  paginationSupported: boolean;
};

export type CreateSpotOrderPayload = {
  symbol: string;
  side: 'BUY' | 'SELL';
  order_type: 'LIMIT' | 'MARKET';
  client_order_id?: string;
  price?: string;
  amount?: string;
  quote_amount?: string;
};

export type CreateSpotOrderResponse = {
  id: number;
  orderNo: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  orderType: 'LIMIT' | 'MARKET';
  price: string | null;
  amount: string;
  filledAmount: string;
  frozenAmount: string;
  status: string;
  createdAt: string;
};

export type CancelSpotOrderResponse = {
  orderId: number;
  orderNo: string;
  status: string;
};

export type SpotFeeRates = {
  makerRate: number;
  takerRate: number;
  payment: SpotFeePaymentContext;
};

export type SpotFeePaymentContext = {
  useRcbFee: boolean;
  platformEnabled: boolean;
  payRatio: number;
  minRcbFee: number;
  spotRcbAvailable: number;
  rcbUsdtPrice: number | null;
};

const SPOT_ORDER_SUCCESS_STATUSES = new Set([
  'OPEN',
  'PARTIALLY_FILLED',
  'FILLED',
]);
const SPOT_CANCEL_SUCCESS_STATUSES = new Set(['CANCELED']);

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

function readString(
  row: Record<string, unknown>,
  keys: string[],
  fallback = '',
) {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value))
      return String(value);
  }
  return fallback;
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
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function invalidSpotPrivateResponse(code: string, detail: string): never {
  throw new ApiClientError(`${detail}数据暂不可用，请刷新后重试`, code);
}

function readSpotPrivateItems(payload: unknown, code: string, detail: string) {
  if (
    !isRecord(payload) ||
    !Object.prototype.hasOwnProperty.call(payload, 'items') ||
    !Array.isArray(payload.items)
  ) {
    invalidSpotPrivateResponse(code, detail);
  }
  return payload.items;
}

function requireSpotPrivateRecord(
  value: unknown,
  code: string,
  detail: string,
) {
  if (!isRecord(value) || Array.isArray(value)) {
    invalidSpotPrivateResponse(code, detail);
  }
  return value;
}

function requireSpotPrivateString(
  row: Record<string, unknown>,
  keys: string[],
  code: string,
  detail: string,
) {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return invalidSpotPrivateResponse(code, detail);
}

function requireSpotPrivateDecimalText(
  row: Record<string, unknown>,
  keys: string[],
  code: string,
  detail: string,
  options: { allowNegative?: boolean; allowZero?: boolean } = {},
) {
  const allowNegative = options.allowNegative === true;
  const allowZero = options.allowZero !== false;
  for (const key of keys) {
    const raw = row[key];
    if (
      (typeof raw !== 'string' && typeof raw !== 'number') ||
      (typeof raw === 'string' && !raw.trim())
    ) {
      continue;
    }
    const value = Number(raw);
    if (
      Number.isFinite(value) &&
      (allowNegative || value >= 0) &&
      (allowZero || value > 0)
    ) {
      return typeof raw === 'string' ? raw.trim() : String(raw);
    }
  }
  return invalidSpotPrivateResponse(code, detail);
}

function canonicalDecimal(value: string | number | undefined) {
  if (value === undefined) return null;
  const text = String(value).trim();
  const match = text.match(
    /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/,
  );
  if (!match) return null;
  const sign = match[1] === '-' ? '-' : '';
  const integer = match[2] ?? '';
  const fraction = match[3] ?? match[4] ?? '';
  const exponent = Number(match[5] ?? '0');
  if (!Number.isSafeInteger(exponent)) return null;

  let digits = `${integer}${fraction}`.replace(/^0+/, '');
  if (!digits) return { sign: '', digits: '0', exponent: 0 };
  const trailingZeros = digits.match(/0+$/)?.[0].length ?? 0;
  if (trailingZeros > 0) digits = digits.slice(0, -trailingZeros);
  return {
    sign,
    digits,
    exponent: exponent - fraction.length + trailingZeros,
  };
}

function decimalTextsEqual(
  left: string | number | undefined,
  right: string | number | undefined,
) {
  const normalizedLeft = canonicalDecimal(left);
  const normalizedRight = canonicalDecimal(right);
  return (
    normalizedLeft !== null &&
    normalizedRight !== null &&
    normalizedLeft.sign === normalizedRight.sign &&
    normalizedLeft.digits === normalizedRight.digits &&
    normalizedLeft.exponent === normalizedRight.exponent
  );
}

function decimalTextGreaterThan(left: string, right: string) {
  const normalizedLeft = canonicalDecimal(left);
  const normalizedRight = canonicalDecimal(right);
  if (normalizedLeft === null || normalizedRight === null) return true;
  if (normalizedLeft.sign !== normalizedRight.sign) {
    return normalizedRight.sign === '-';
  }
  if (normalizedLeft.digits === '0') return false;
  if (normalizedRight.digits === '0') return normalizedLeft.sign !== '-';
  const leftMagnitude = normalizedLeft.digits.length + normalizedLeft.exponent;
  const rightMagnitude =
    normalizedRight.digits.length + normalizedRight.exponent;
  let magnitudeComparison: number;
  if (leftMagnitude !== rightMagnitude) {
    magnitudeComparison = leftMagnitude > rightMagnitude ? 1 : -1;
  } else {
    const width = Math.max(
      normalizedLeft.digits.length,
      normalizedRight.digits.length,
    );
    const paddedLeft = normalizedLeft.digits.padEnd(width, '0');
    const paddedRight = normalizedRight.digits.padEnd(width, '0');
    magnitudeComparison =
      paddedLeft === paddedRight ? 0 : paddedLeft > paddedRight ? 1 : -1;
  }
  return normalizedLeft.sign === '-'
    ? magnitudeComparison < 0
    : magnitudeComparison > 0;
}

function requireSpotPrivateSymbol(
  row: Record<string, unknown>,
  expectedSymbol: string,
  code: string,
  detail: string,
) {
  const symbol = requireSpotPrivateString(
    row,
    ['symbol'],
    code,
    detail,
  ).toUpperCase();
  if (symbol !== expectedSymbol.trim().toUpperCase()) {
    invalidSpotPrivateResponse(code, detail);
  }
  return symbol;
}

function requireSpotPrivateSide(
  row: Record<string, unknown>,
  code: string,
  detail: string,
) {
  const side = requireSpotPrivateString(
    row,
    ['side'],
    code,
    detail,
  ).toUpperCase();
  if (side !== 'BUY' && side !== 'SELL') {
    invalidSpotPrivateResponse(code, detail);
  }
  return side;
}

function readSpotPrivateOptionalString(
  row: Record<string, unknown>,
  keys: string[],
  code: string,
  detail: string,
) {
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(row, key) || row[key] === null) {
      continue;
    }
    const value = row[key];
    if (typeof value === 'string') return value.trim() || null;
    invalidSpotPrivateResponse(code, detail);
  }
  return null;
}

function readObservedAtMs(row: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value > 0 && value < 10_000_000_000 ? value * 1000 : value;
    }
    if (typeof value === 'string' && value.trim()) {
      const numeric = Number(value);
      if (Number.isFinite(numeric)) {
        return numeric > 0 && numeric < 10_000_000_000
          ? numeric * 1000
          : numeric;
      }
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
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

function normalizePrecision(value: number | null, fallback: number) {
  if (value === null || value < 0) return fallback;
  return Math.min(18, Math.floor(value));
}

function normalizeExplicitPrecision(value: number | null) {
  if (value === null || value < 0 || value > 18) return null;
  return Math.floor(value);
}

function precisionFromTickSize(value: unknown) {
  if (
    (typeof value !== 'string' && typeof value !== 'number') ||
    String(value).trim() === ''
  ) {
    return null;
  }
  const text = String(value).trim().toLowerCase();
  const numeric = Number(text);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  const [coefficient, exponentText] = text.split('e');
  const exponent = exponentText === undefined ? 0 : Number(exponentText);
  if (!Number.isInteger(exponent)) return null;
  const decimalPart = (coefficient.split('.')[1] || '').replace(/0+$/, '');
  return Math.min(18, Math.max(0, decimalPart.length - exponent));
}

function resolveSpotPricePrecision(
  records: Record<string, unknown>[],
  symbol: string,
  price: number | null,
) {
  let pricePrecision: number | null = null;
  for (const record of records) {
    pricePrecision = normalizeExplicitPrecision(
      readNumber(record, ['price_precision', 'pricePrecision']),
    );
    if (pricePrecision !== null) break;
  }
  const tradingPrecision = pricePrecision ?? getPricePrecision(symbol, price);

  for (const record of records) {
    const displayPricePrecision = normalizeExplicitPrecision(
      readNumber(record, ['display_price_precision', 'displayPricePrecision']),
    );
    if (displayPricePrecision !== null) {
      const priceTickSize = readNumber(record, [
        'price_tick_size',
        'priceTickSize',
        'tick_size',
        'tickSize',
      ]);
      return {
        displayPricePrecision,
        displayPricePrecisionSource: 'display_price_precision' as const,
        pricePrecision: tradingPrecision,
        priceTickSize:
          priceTickSize !== null && priceTickSize > 0 ? priceTickSize : null,
      };
    }
  }

  for (const record of records) {
    for (const key of [
      'price_tick_size',
      'priceTickSize',
      'tick_size',
      'tickSize',
    ]) {
      const displayPricePrecision = precisionFromTickSize(record[key]);
      if (displayPricePrecision !== null) {
        return {
          displayPricePrecision,
          displayPricePrecisionSource: 'price_tick_size' as const,
          pricePrecision: tradingPrecision,
          priceTickSize: Number(record[key]),
        };
      }
    }
  }

  return {
    displayPricePrecision: tradingPrecision,
    displayPricePrecisionSource:
      pricePrecision === null
        ? ('fallback' as const)
        : ('price_precision' as const),
    pricePrecision: tradingPrecision,
    priceTickSize: null,
  };
}

async function getCachedPublic<T>(url: string): Promise<T> {
  const now = Date.now();
  const cached = getFreshExpiringEntry(publicCache, url, now);
  if (cached) return cached.payload as T;
  return getOrCreateInFlightRequest(publicRequests, url, async () => {
    const payload = await publicApiClient.get<T>(url);
    const settledAt = Date.now();
    setBoundedExpiringEntry(
      publicCache,
      url,
      { expiresAt: settledAt + PUBLIC_CACHE_TTL_MS, payload },
      PUBLIC_CACHE_MAX_ENTRIES,
      settledAt,
    );
    return payload;
  }) as Promise<T>;
}

export function normalizeSpotDepthPayload(
  payload: unknown,
  fallbackSymbol: string,
): SpotOrderBook {
  const root = isRecord(payload) ? payload : {};
  const mapLevel = (row: unknown): SpotOrderBookLevel | null => {
    if (Array.isArray(row)) {
      const price = Number(row[0]);
      const amount = Number(row[1]);
      return Number.isFinite(price) &&
        Number.isFinite(amount) &&
        price > 0 &&
        amount > 0
        ? { price, amount }
        : null;
    }
    if (!isRecord(row)) return null;
    const price = readNumber(row, ['price']);
    const amount = readNumber(row, ['amount', 'qty', 'quantity']);
    if (price === null || amount === null || price <= 0 || amount <= 0)
      return null;
    return { price, amount };
  };
  return {
    symbol: readString(root, ['symbol'], fallbackSymbol).toUpperCase(),
    bids: readRows(root.bids, ['items']).map(mapLevel).filter(Boolean),
    asks: readRows(root.asks, ['items']).map(mapLevel).filter(Boolean),
    freshness:
      readString(root, ['freshness', 'quote_freshness']).toUpperCase() || null,
    stale: root.stale === true,
  } as SpotOrderBook;
}

export function normalizeSpotTradesPayload(
  payload: unknown,
  expectedSymbol?: string,
): SpotTrade[] {
  if (expectedSymbol && isRecord(payload)) {
    const payloadSymbol = readString(payload, ['symbol']).toUpperCase();
    if (
      payloadSymbol &&
      payloadSymbol !== expectedSymbol.trim().toUpperCase()
    ) {
      throw new ApiClientError(
        '现货成交行情标识不匹配，请重新加载',
        'SPOT_MARKET_VIEW_SYMBOL_MISMATCH',
      );
    }
  }
  return readRows(payload, ['trades', 'items', 'data']).map((row, index) => {
    const record = isRecord(row) ? row : {};
    return {
      id: readString(
        record,
        ['id', 'trade_id', 'provider_trade_id'],
        `${index}`,
      ),
      price: readNumber(record, ['price']),
      amount: readNumber(record, ['amount', 'qty', 'quantity']),
      side: normalizeSide(record.side),
      ts: (record.ts ?? record.time ?? record.event_time_ms) as
        | number
        | string
        | null
        | undefined,
    };
  });
}

export function normalizeSpotTickerPayload(
  payload: unknown,
  fallbackSymbol: string,
): SpotTicker | null {
  if (!isRecord(payload)) return null;
  const normalizedSymbol = readString(
    payload,
    ['symbol'],
    fallbackSymbol,
  ).toUpperCase();
  const lastPrice = readNumber(payload, [
    'last_price',
    'price',
    'last',
    'close',
  ]);
  const priceMetadata = resolveSpotPricePrecision(
    [payload],
    normalizedSymbol,
    lastPrice,
  );
  return {
    symbol: normalizedSymbol,
    lastPrice,
    changePercent: readNumber(payload, [
      'price_change_percent_24h',
      'change_24h',
      'priceChangePercent',
    ]),
    high24h: readNumber(payload, [
      'high_24h',
      'high24h',
      'highPrice',
      'ticker_24h_high',
    ]),
    low24h: readNumber(payload, [
      'low_24h',
      'low24h',
      'lowPrice',
      'ticker_24h_low',
    ]),
    baseVolume24h: readNumber(payload, [
      'base_volume_24h',
      'volume_24h',
      'baseVolume24h',
      'volume24h',
      'vol24h',
    ]),
    quoteVolume24h: readNumber(payload, [
      'quote_volume_24h',
      'quoteVolume24h',
      'quoteVolume',
      'volCcy24h',
    ]),
    pricePrecision: priceMetadata.pricePrecision,
    displayPricePrecision: priceMetadata.displayPricePrecision,
    displayPricePrecisionSource: priceMetadata.displayPricePrecisionSource,
    priceTickSize: priceMetadata.priceTickSize,
    amountPrecision: normalizePrecision(
      readNumber(payload, ['amount_precision', 'amountPrecision']),
      6,
    ),
    minAmount: readNumber(payload, ['min_amount', 'minAmount']),
    minNotional: readNumber(payload, ['min_notional', 'minNotional']),
    marketStatus:
      readString(payload, ['market_status', 'marketStatus']).toUpperCase() ||
      null,
    freshness:
      readString(payload, ['quote_freshness', 'freshness']).toUpperCase() ||
      null,
    stale: payload.stale === true,
  };
}

export function hasUsableSpotExecutionDepth(
  depth: SpotOrderBook,
  marketStatus: string | null | undefined,
) {
  const bestBid = depth.bids[0]?.price ?? null;
  const bestAsk = depth.asks[0]?.price ?? null;
  const freshness = String(depth.freshness || '').toUpperCase();
  return (
    String(marketStatus || '').toUpperCase() === 'OPEN' &&
    depth.stale !== true &&
    (freshness === 'LIVE' || freshness === 'RECENT') &&
    bestBid !== null &&
    bestAsk !== null &&
    Number.isFinite(bestBid) &&
    Number.isFinite(bestAsk) &&
    bestBid > 0 &&
    bestAsk > 0 &&
    bestAsk >= bestBid
  );
}

export function normalizeSpotMarketViewPayload(
  payload: unknown,
  requestedSymbol: string,
): SpotMarketView {
  if (!isRecord(payload)) {
    throw new ApiClientError(
      '现货行情数据暂不可用，请重新加载',
      'SPOT_MARKET_VIEW_INVALID_PAYLOAD',
    );
  }
  const root = payload;
  const normalizedRequestedSymbol = requestedSymbol.trim().toUpperCase();
  const symbol = readString(root, ['symbol']).toUpperCase();
  if (!symbol) {
    throw new ApiClientError(
      '现货行情数据暂不可用，请重新加载',
      'SPOT_MARKET_VIEW_INVALID_PAYLOAD',
    );
  }
  if (symbol !== normalizedRequestedSymbol) {
    throw new ApiClientError(
      '现货行情标识不匹配，请重新加载',
      'SPOT_MARKET_VIEW_SYMBOL_MISMATCH',
    );
  }

  const rawTicker = isRecord(root.ticker) ? root.ticker : {};
  const tickerSymbol = readString(rawTicker, ['symbol']).toUpperCase();
  if (tickerSymbol && tickerSymbol !== symbol) {
    throw new ApiClientError(
      '现货行情标识不匹配，请重新加载',
      'SPOT_MARKET_VIEW_SYMBOL_MISMATCH',
    );
  }
  const displayPrice =
    readNumber(root, [
      'display_price',
      'last_price',
      'last_trade_price',
      'ticker_last_price',
    ]) ?? readNumber(rawTicker, ['last_price', 'price', 'last', 'close']);
  const normalizedDepth = normalizeSpotDepthPayload(root.depth, symbol);
  const depth: SpotOrderBook = {
    ...normalizedDepth,
    freshness:
      normalizedDepth.freshness ||
      readString(root, ['depth_freshness']).toUpperCase() ||
      null,
  };
  if (depth.symbol !== symbol) {
    throw new ApiClientError(
      '现货盘口行情标识不匹配，请重新加载',
      'SPOT_MARKET_VIEW_SYMBOL_MISMATCH',
    );
  }
  const trades = normalizeSpotTradesPayload(root.trades, symbol);
  const rawTrades = isRecord(root.trades) ? root.trades : {};
  const firstRawTrade = readRows(root.trades, ['trades', 'items', 'data']).find(
    isRecord,
  );
  const bestBid =
    readNumber(root, ['best_bid']) ?? depth.bids[0]?.price ?? null;
  const bestAsk =
    readNumber(root, ['best_ask']) ?? depth.asks[0]?.price ?? null;
  const rawDepth = isRecord(root.depth) ? root.depth : {};
  const depthFreshness = readString(root, ['depth_freshness']).toUpperCase();
  const depthIsCurrent =
    readString(root, ['depth_status']).toLowerCase() === 'ok' &&
    rawDepth.stale !== true &&
    (depthFreshness === 'LIVE' || depthFreshness === 'RECENT');
  const hasUsableBbo =
    bestBid !== null &&
    bestAsk !== null &&
    bestBid > 0 &&
    bestAsk > 0 &&
    bestAsk >= bestBid;
  const marketStatus = readString(
    root,
    ['market_status'],
    'UNKNOWN',
  ).toUpperCase();
  const normalizedTicker = normalizeSpotTickerPayload(rawTicker, symbol);
  const priceMetadata = resolveSpotPricePrecision(
    [root, rawTicker],
    symbol,
    displayPrice,
  );
  const amountPrecision = normalizePrecision(
    readNumber(root, ['amount_precision']) ??
      readNumber(rawTicker, ['amount_precision', 'amountPrecision']),
    6,
  );

  return {
    symbol,
    ticker: {
      symbol,
      lastPrice: displayPrice,
      changePercent:
        readNumber(root, ['ticker_24h_change_percent']) ??
        readNumber(rawTicker, [
          'price_change_percent_24h',
          'change_24h',
          'priceChangePercent',
        ]),
      high24h:
        readNumber(root, ['ticker_24h_high']) ??
        normalizedTicker?.high24h ??
        null,
      low24h:
        readNumber(root, ['ticker_24h_low']) ??
        normalizedTicker?.low24h ??
        null,
      baseVolume24h:
        readNumber(root, ['ticker_volume']) ??
        normalizedTicker?.baseVolume24h ??
        null,
      quoteVolume24h:
        readNumber(root, ['ticker_quote_volume']) ??
        normalizedTicker?.quoteVolume24h ??
        null,
      pricePrecision: priceMetadata.pricePrecision,
      displayPricePrecision: priceMetadata.displayPricePrecision,
      displayPricePrecisionSource: priceMetadata.displayPricePrecisionSource,
      priceTickSize: priceMetadata.priceTickSize,
      amountPrecision,
      minAmount:
        readNumber(root, ['min_amount']) ?? normalizedTicker?.minAmount ?? null,
      minNotional:
        readNumber(root, ['min_notional']) ??
        normalizedTicker?.minNotional ??
        null,
      marketStatus,
      freshness:
        readString(root, [
          'quote_freshness',
          'ticker_freshness',
        ]).toUpperCase() || null,
      stale: normalizedTicker?.stale,
    },
    depth,
    trades,
    displayPrice,
    bestBid,
    bestAsk,
    executionBid:
      root.executable === true &&
      marketStatus === 'OPEN' &&
      depthIsCurrent &&
      hasUsableBbo
        ? bestBid
        : null,
    executionAsk:
      root.executable === true &&
      marketStatus === 'OPEN' &&
      depthIsCurrent &&
      hasUsableBbo
        ? bestAsk
        : null,
    executable:
      root.executable === true &&
      marketStatus === 'OPEN' &&
      depthIsCurrent &&
      hasUsableBbo,
    marketStatus,
    quoteFreshness:
      readString(root, ['quote_freshness', 'ticker_freshness']) || null,
    depthFreshness: depthFreshness || null,
    tradesFreshness: readString(root, ['trades_freshness']) || null,
    updatedAt: readString(root, ['updated_at']) || null,
    tickerObservedAtMs: readObservedAtMs(rawTicker, [
      'event_time_ms',
      'received_at_ms',
      'updated_at_ms',
      'ts',
      'updated_at',
    ]),
    depthObservedAtMs: readObservedAtMs(rawDepth, [
      'event_time_ms',
      'received_at_ms',
      'updated_at_ms',
      'ts',
      'updated_at',
      'fetched_at',
    ]),
    tradesObservedAtMs:
      readObservedAtMs(rawTrades, [
        'event_time_ms',
        'received_at_ms',
        'updated_at_ms',
        'ts',
        'updated_at',
      ]) ||
      (firstRawTrade
        ? readObservedAtMs(firstRawTrade, [
            'event_time_ms',
            'received_at_ms',
            'updated_at_ms',
            'ts',
            'time',
            'created_at',
          ])
        : null),
    warnings: Array.isArray(root.warnings)
      ? root.warnings.filter(
          (warning): warning is string => typeof warning === 'string',
        )
      : [],
  };
}

export async function fetchSpotMarketView(
  symbol: string,
): Promise<SpotMarketView> {
  const normalizedSymbol = symbol.trim().toUpperCase();
  const payload = await publicApiClient.get<unknown>(
    `/market/spot/view?symbol=${encodeURIComponent(normalizedSymbol)}`,
  );
  return normalizeSpotMarketViewPayload(payload, normalizedSymbol);
}

export function formatSpotNumber(
  value: number | null | undefined,
  precision = 4,
) {
  if (value === null || value === undefined || !Number.isFinite(value))
    return '--';
  return value.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: precision,
  });
}

export function formatSpotPercent(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value))
    return '--';
  const prefix = value > 0 ? '+' : '';
  return `${prefix}${value.toFixed(2)}%`;
}

export async function fetchSpotTicker(
  symbol: string,
): Promise<SpotTicker | null> {
  const payload = await getCachedPublic<unknown>(
    `/market/tickers?symbol=${encodeURIComponent(symbol)}`,
  );
  const rows = readRows(payload, ['items', 'data', 'rows']);
  const raw = rows[0];
  return normalizeSpotTickerPayload(raw, symbol);
}

export async function fetchSpotDepth(
  symbol: string,
  limit = 10,
): Promise<SpotOrderBook> {
  const payload = await getCachedPublic<unknown>(
    `/market/depth?symbol=${encodeURIComponent(symbol)}&limit=${limit}`,
  );
  return normalizeSpotDepthPayload(payload, symbol);
}

export async function fetchSpotTrades(
  symbol: string,
  limit = 20,
): Promise<SpotTrade[]> {
  const payload = await getCachedPublic<unknown>(
    `/market/trades?symbol=${encodeURIComponent(symbol)}&limit=${limit}`,
  );
  return normalizeSpotTradesPayload(payload, symbol);
}

export async function fetchSpotKlines(
  symbol: string,
  interval = '1m',
  limit = 40,
): Promise<SpotKline[]> {
  const payload = await getCachedPublic<unknown>(
    `/market/kline?symbol=${encodeURIComponent(
      symbol,
    )}&interval=${interval}&limit=${limit}&force_rest=1`,
  );
  return normalizeSpotKlinesPayload(payload, symbol);
}

export function normalizeSpotKlinesPayload(
  payload: unknown,
  expectedSymbol: string,
): SpotKline[] {
  const code = 'INVALID_SPOT_KLINE_RESPONSE';
  const detail = '现货 K线';
  const rows = readSpotPrivateItems(payload, code, detail);
  if (rows.length === 0) return [];
  const root = requireSpotPrivateRecord(payload, code, detail);
  requireSpotPrivateSymbol(root, expectedSymbol, code, detail);
  return rows.map(row => {
    const record = requireSpotPrivateRecord(row, code, detail);
    const openTime = readSafePositiveInteger(record, ['open_time']);
    if (openTime === null) invalidSpotPrivateResponse(code, detail);
    const open = Number(
      requireSpotPrivateDecimalText(record, ['open'], code, detail, {
        allowZero: false,
      }),
    );
    const high = Number(
      requireSpotPrivateDecimalText(record, ['high'], code, detail, {
        allowZero: false,
      }),
    );
    const low = Number(
      requireSpotPrivateDecimalText(record, ['low'], code, detail, {
        allowZero: false,
      }),
    );
    const close = Number(
      requireSpotPrivateDecimalText(record, ['close'], code, detail, {
        allowZero: false,
      }),
    );
    const volume = Number(
      requireSpotPrivateDecimalText(record, ['volume'], code, detail),
    );
    if (
      high < low ||
      high < open ||
      high < close ||
      low > open ||
      low > close
    ) {
      invalidSpotPrivateResponse(code, detail);
    }
    return { openTime, open, high, low, close, volume };
  });
}

function requireSpotFeeRate(value: unknown) {
  if (
    (typeof value !== 'string' && typeof value !== 'number') ||
    String(value).trim() === ''
  ) {
    throw new ApiClientError(
      '现货手续费率暂不可用，请稍后重试',
      'SPOT_FEE_RATES_INVALID',
    );
  }
  const rate = Number(value);
  if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
    throw new ApiClientError(
      '现货手续费率暂不可用，请稍后重试',
      'SPOT_FEE_RATES_INVALID',
    );
  }
  return rate;
}

export async function fetchSpotFeeRates({
  signal,
}: { signal?: AbortSignal } = {}): Promise<SpotFeeRates> {
  const [payload, payment] = await Promise.all([
    apiClient.get<unknown>('/vip/overview', { signal }),
    apiClient.get<unknown>('/spot/fee-payment-context', { signal }),
  ]);
  if (
    !isRecord(payload) ||
    readString(payload, ['auth_state']).toLowerCase() !== 'authenticated' ||
    !isRecord(payload.user_summary)
  ) {
    throw new ApiClientError(
      '现货手续费率暂不可用，请稍后重试',
      'SPOT_FEE_RATES_INVALID',
    );
  }
  return {
    makerRate: requireSpotFeeRate(
      payload.user_summary.effective_spot_maker_fee,
    ),
    takerRate: requireSpotFeeRate(
      payload.user_summary.effective_spot_taker_fee,
    ),
    payment: normalizeSpotFeePaymentContext(payment),
  };
}

function normalizeSpotFeePaymentContext(value: unknown): SpotFeePaymentContext {
  const invalid = () =>
    new ApiClientError(
      '现货手续费抵扣条件暂不可用',
      'SPOT_FEE_CONTEXT_INVALID',
    );
  if (
    !isRecord(value) ||
    typeof value.use_rcb_fee !== 'boolean' ||
    typeof value.spot_rcb_fee_enabled !== 'boolean'
  ) {
    throw invalid();
  }
  const decimal = (raw: unknown) => {
    if (
      (typeof raw !== 'number' && typeof raw !== 'string') ||
      String(raw).trim() === ''
    )
      throw invalid();
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) throw invalid();
    return parsed;
  };
  const payRatio = decimal(value.rcb_fee_discount_rate);
  if (payRatio <= 0 || payRatio > 1) throw invalid();
  return {
    useRcbFee: value.use_rcb_fee,
    platformEnabled: value.spot_rcb_fee_enabled,
    payRatio,
    minRcbFee: decimal(value.min_rcb_fee_amount),
    spotRcbAvailable: decimal(value.rcb_spot_available),
    rcbUsdtPrice:
      value.rcb_usdt_price === null ? null : decimal(value.rcb_usdt_price),
  };
}

export async function fetchSpotBalances(
  symbol: string,
): Promise<SpotBalanceItem[]> {
  const payload = await apiClient.get<unknown>(
    `/spot/balances?symbol=${encodeURIComponent(symbol)}`,
  );
  return normalizeSpotBalancesPayload(payload, symbol);
}

export async function fetchSpotCurrentOrders(
  symbol: string,
  limit = 20,
): Promise<SpotOrderItem[]> {
  return (await fetchSpotCurrentOrdersPage(symbol, limit)).items;
}

export async function fetchSpotCurrentOrdersPage(
  symbol: string,
  limit = 20,
  beforeId?: number | null,
): Promise<SpotCursorPage<SpotOrderItem>> {
  const payload = await apiClient.get<unknown>(
    buildSpotCursorUrl('/spot/orders/current', symbol, limit, beforeId),
  );
  return normalizeSpotOrdersPage(payload, symbol);
}

export async function fetchSpotHistoryOrders(
  symbol: string,
  limit = 20,
): Promise<SpotOrderItem[]> {
  return (await fetchSpotHistoryOrdersPage(symbol, limit)).items;
}

export async function fetchSpotHistoryOrdersPage(
  symbol: string,
  limit = 20,
  beforeId?: number | null,
): Promise<SpotCursorPage<SpotOrderItem>> {
  const payload = await apiClient.get<unknown>(
    buildSpotCursorUrl('/spot/orders/history', symbol, limit, beforeId),
  );
  return normalizeSpotOrdersPage(payload, symbol);
}

export async function fetchSpotMyTrades(
  symbol: string,
  limit = 20,
): Promise<SpotMyTradeItem[]> {
  return (await fetchSpotMyTradesPage(symbol, limit)).items;
}

export async function fetchSpotMyTradesPage(
  symbol: string,
  limit = 20,
  beforeId?: number | null,
): Promise<SpotCursorPage<SpotMyTradeItem>> {
  const payload = await apiClient.get<unknown>(
    buildSpotCursorUrl('/spot/trades', symbol, limit, beforeId),
  );
  return normalizeSpotMyTradesPage(payload, symbol);
}

function buildSpotCursorUrl(
  pathname: string,
  symbol: string,
  limit: number,
  beforeId?: number | null,
) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new ApiClientError(
      '现货记录请求参数无效',
      'INVALID_SPOT_PAGE_REQUEST',
    );
  }
  let url = `${pathname}?symbol=${encodeURIComponent(symbol)}&limit=${limit}`;
  if (beforeId !== undefined && beforeId !== null) {
    if (!Number.isSafeInteger(beforeId) || beforeId < 1) {
      throw new ApiClientError(
        '现货记录请求参数无效',
        'INVALID_SPOT_PAGE_REQUEST',
      );
    }
    url += `&before_id=${beforeId}`;
  }
  return url;
}

export function normalizeSpotBalancesPayload(
  payload: unknown,
  expectedSymbol: string,
): SpotBalanceItem[] {
  const code = 'INVALID_SPOT_BALANCES_RESPONSE';
  const detail = '现货余额';
  const root = requireSpotPrivateRecord(payload, code, detail);
  requireSpotPrivateSymbol(root, expectedSymbol, code, detail);
  const rows = readSpotPrivateItems(root, code, detail);
  if (rows.length === 0) return [];
  return rows.map(row => {
    const record = requireSpotPrivateRecord(row, code, detail);
    const availableAmount = Number(
      requireSpotPrivateDecimalText(record, ['available_amount'], code, detail),
    );
    const frozenAmount = Number(
      requireSpotPrivateDecimalText(record, ['frozen_amount'], code, detail),
    );
    return {
      coinSymbol: requireSpotPrivateString(
        record,
        ['coin_symbol'],
        code,
        detail,
      ).toUpperCase(),
      availableAmount,
      frozenAmount,
    };
  });
}

export function normalizeSpotOrdersPayload(
  payload: unknown,
  expectedSymbol: string,
): SpotOrderItem[] {
  return normalizeSpotOrdersPage(payload, expectedSymbol).items;
}

export function normalizeSpotOrdersPage(
  payload: unknown,
  expectedSymbol: string,
): SpotCursorPage<SpotOrderItem> {
  const code = 'INVALID_SPOT_ORDERS_RESPONSE';
  const detail = '现货委托';
  const root = requireSpotPrivateRecord(payload, code, detail);
  requireSpotPrivateSymbol(root, expectedSymbol, code, detail);
  const rows = readSpotPrivateItems(root, code, detail);
  const pagination = normalizeSpotPagination(root, code, detail);
  return {
    items: rows.map(row => mapSpotOrder(row, expectedSymbol, code, detail)),
    ...pagination,
  };
}

export function normalizeSpotMyTradesPayload(
  payload: unknown,
  expectedSymbol: string,
): SpotMyTradeItem[] {
  return normalizeSpotMyTradesPage(payload, expectedSymbol).items;
}

export function normalizeSpotMyTradesPage(
  payload: unknown,
  expectedSymbol: string,
): SpotCursorPage<SpotMyTradeItem> {
  const code = 'INVALID_SPOT_TRADES_RESPONSE';
  const detail = '现货成交';
  const root = requireSpotPrivateRecord(payload, code, detail);
  requireSpotPrivateSymbol(root, expectedSymbol, code, detail);
  const rows = readSpotPrivateItems(root, code, detail);
  const pagination = normalizeSpotPagination(root, code, detail);
  return {
    items: rows.map(row => {
      const record = requireSpotPrivateRecord(row, code, detail);
      const tradeId = readSafePositiveInteger(record, ['trade_id']);
      if (tradeId === null) invalidSpotPrivateResponse(code, detail);
      return {
        id: String(tradeId),
        symbol: requireSpotPrivateSymbol(record, expectedSymbol, code, detail),
        side: requireSpotPrivateSide(record, code, detail),
        price: requireSpotPrivateDecimalText(record, ['price'], code, detail, {
          allowZero: false,
        }),
        amount: requireSpotPrivateDecimalText(
          record,
          ['amount'],
          code,
          detail,
          {
            allowZero: false,
          },
        ),
        quoteAmount: requireSpotPrivateDecimalText(
          record,
          ['quote_amount'],
          code,
          detail,
          { allowZero: false },
        ),
        createdAt: readSpotPrivateOptionalString(
          record,
          ['created_at'],
          code,
          detail,
        ),
      };
    }),
    ...pagination,
  };
}

function normalizeSpotPagination(
  root: Record<string, unknown>,
  code: string,
  detail: string,
): Omit<SpotCursorPage<never>, 'items'> {
  const hasHasMore = Object.prototype.hasOwnProperty.call(root, 'has_more');
  const hasNextCursor = Object.prototype.hasOwnProperty.call(
    root,
    'next_cursor',
  );
  if (!hasHasMore && !hasNextCursor) {
    return {
      hasMore: false,
      nextCursor: null,
      paginationSupported: false,
    };
  }
  if (!hasHasMore || typeof root.has_more !== 'boolean') {
    invalidSpotPrivateResponse(code, detail);
  }
  if (!root.has_more) {
    if (
      hasNextCursor &&
      root.next_cursor !== null &&
      root.next_cursor !== undefined
    ) {
      invalidSpotPrivateResponse(code, detail);
    }
    return {
      hasMore: false,
      nextCursor: null,
      paginationSupported: true,
    };
  }
  const nextCursor = readSafePositiveInteger(root, ['next_cursor']);
  if (nextCursor === null) invalidSpotPrivateResponse(code, detail);
  return {
    hasMore: true,
    nextCursor,
    paginationSupported: true,
  };
}

export async function createSpotOrder(
  payload: CreateSpotOrderPayload,
): Promise<CreateSpotOrderResponse> {
  if (
    payload.client_order_id !== undefined &&
    !isValidSpotClientOrderId(payload.client_order_id)
  ) {
    throw new ApiClientError(
      '订单信息校验失败，未提交任何委托',
      'INVALID_CLIENT_ORDER_ID',
    );
  }
  const response = await apiClient.post<unknown>('/order/create', payload);
  const root = isRecord(response) ? response : {};
  const orderId =
    typeof root.id === 'number' && Number.isSafeInteger(root.id) && root.id > 0
      ? root.id
      : null;
  const responseCode = 'INVALID_SPOT_ORDER_RESPONSE';
  const responseDetail = '现货下单';
  const status = requireSpotPrivateString(
    root,
    ['status'],
    responseCode,
    responseDetail,
  ).toUpperCase();
  const responseSymbol = requireSpotPrivateString(
    root,
    ['symbol'],
    responseCode,
    responseDetail,
  ).toUpperCase();
  const responseSide = requireSpotPrivateString(
    root,
    ['side'],
    responseCode,
    responseDetail,
  ).toUpperCase();
  const responseOrderType = requireSpotPrivateString(
    root,
    ['order_type'],
    responseCode,
    responseDetail,
  ).toUpperCase();
  const orderNo = requireSpotPrivateString(
    root,
    ['order_no'],
    responseCode,
    responseDetail,
  );
  if (!Object.prototype.hasOwnProperty.call(root, 'price')) {
    throw new ApiClientError(
      '订单状态暂时无法确认，请刷新委托记录',
      'INVALID_SPOT_ORDER_RESPONSE',
    );
  }
  const responsePrice =
    root.price === null
      ? null
      : requireSpotPrivateDecimalText(
          root,
          ['price'],
          responseCode,
          responseDetail,
          { allowZero: false },
        );
  const responseAmount = requireSpotPrivateDecimalText(
    root,
    ['amount'],
    responseCode,
    responseDetail,
    { allowZero: false },
  );
  const responseFilledAmount = requireSpotPrivateDecimalText(
    root,
    ['filled_amount'],
    responseCode,
    responseDetail,
  );
  const responseFrozenAmount = requireSpotPrivateDecimalText(
    root,
    ['frozen_amount'],
    responseCode,
    responseDetail,
  );
  const createdAt = requireSpotPrivateString(
    root,
    ['created_at'],
    responseCode,
    responseDetail,
  );
  const responseClientOrderId = readSpotOptionalClientOrderId(
    root,
    responseCode,
    responseDetail,
  );
  const requestMatched =
    responseOrderType === 'LIMIT'
      ? responsePrice !== null &&
        decimalTextsEqual(responsePrice, payload.price) &&
        decimalTextsEqual(responseAmount, payload.amount)
      : payload.side === 'SELL'
      ? responsePrice === null &&
        decimalTextsEqual(responseAmount, payload.amount)
      : responsePrice === null;
  if (
    !orderId ||
    !orderNo ||
    !SPOT_ORDER_SUCCESS_STATUSES.has(status) ||
    responseSymbol !== payload.symbol.trim().toUpperCase() ||
    responseSide !== payload.side ||
    responseOrderType !== payload.order_type ||
    (payload.client_order_id !== undefined &&
      responseClientOrderId !== payload.client_order_id) ||
    !requestMatched ||
    decimalTextGreaterThan(responseFilledAmount, responseAmount) ||
    !createdAt ||
    !Number.isFinite(Date.parse(createdAt))
  ) {
    throw new ApiClientError(
      '订单状态暂时无法确认，请刷新委托记录',
      'INVALID_SPOT_ORDER_RESPONSE',
    );
  }
  return {
    id: orderId,
    orderNo,
    symbol: responseSymbol,
    side: responseSide as 'BUY' | 'SELL',
    orderType: responseOrderType as 'LIMIT' | 'MARKET',
    price: responsePrice,
    amount: responseAmount,
    filledAmount: responseFilledAmount,
    frozenAmount: responseFrozenAmount,
    status,
    createdAt,
  };
}

export async function cancelSpotOrder(
  orderId: number,
): Promise<CancelSpotOrderResponse> {
  if (!Number.isSafeInteger(orderId) || orderId <= 0) {
    throw new ApiClientError('订单信息无效，无法撤单', 'INVALID_ORDER_ID');
  }

  const response = await apiClient.post<unknown>(`/order/${orderId}/cancel`);
  const root = isRecord(response) ? response : {};
  const responseOrderId = readSafePositiveInteger(root, [
    'id',
    'order_id',
    'orderId',
  ]);
  const status = readString(root, ['status']).toUpperCase();
  if (
    responseOrderId !== orderId ||
    !SPOT_CANCEL_SUCCESS_STATUSES.has(status)
  ) {
    throw new ApiClientError(
      '暂时无法确认撤单结果，请刷新委托记录',
      'INVALID_SPOT_CANCEL_RESPONSE',
    );
  }
  return {
    orderId: responseOrderId,
    orderNo: readString(root, ['order_no', 'orderNo']),
    status,
  };
}

function mapSpotOrder(
  row: unknown,
  expectedSymbol: string,
  code: string,
  detail: string,
): SpotOrderItem {
  const record = requireSpotPrivateRecord(row, code, detail);
  const orderId = readSafePositiveInteger(record, ['id']);
  if (orderId === null) invalidSpotPrivateResponse(code, detail);
  const orderType = requireSpotPrivateString(
    record,
    ['order_type'],
    code,
    detail,
  ).toUpperCase();
  if (orderType !== 'LIMIT' && orderType !== 'MARKET') {
    invalidSpotPrivateResponse(code, detail);
  }
  return {
    id: String(orderId),
    orderId,
    clientOrderId: readSpotOptionalClientOrderId(record, code, detail),
    symbol: requireSpotPrivateSymbol(record, expectedSymbol, code, detail),
    side: requireSpotPrivateSide(record, code, detail),
    orderType,
    price: requireSpotPrivateDecimalText(record, ['price'], code, detail),
    amount: requireSpotPrivateDecimalText(record, ['amount'], code, detail, {
      allowZero: false,
    }),
    filledAmount: requireSpotPrivateDecimalText(
      record,
      ['filled_amount'],
      code,
      detail,
    ),
    status: requireSpotPrivateString(
      record,
      ['status'],
      code,
      detail,
    ).toUpperCase(),
    createdAt: readSpotPrivateOptionalString(
      record,
      ['created_at'],
      code,
      detail,
    ),
  };
}

function isValidSpotClientOrderId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 64 &&
    /^[a-z0-9][a-z0-9._-]{0,63}$/.test(value)
  );
}

function readSpotOptionalClientOrderId(
  row: Record<string, unknown>,
  code: string,
  detail: string,
) {
  if (!Object.prototype.hasOwnProperty.call(row, 'client_order_id'))
    return null;
  const value = row.client_order_id;
  if (value === null) return null;
  if (!isValidSpotClientOrderId(value)) {
    invalidSpotPrivateResponse(code, detail);
  }
  return value;
}

function readSafePositiveInteger(row: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const raw = row[key];
    const value =
      typeof raw === 'number'
        ? raw
        : typeof raw === 'string' && /^[1-9]\d*$/.test(raw.trim())
        ? Number(raw)
        : null;
    if (value !== null && Number.isSafeInteger(value) && value > 0)
      return value;
  }
  return null;
}
