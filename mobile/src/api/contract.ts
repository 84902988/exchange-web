import { ApiClientError, apiClient, publicApiClient } from './client';
import {
  getFreshExpiringEntry,
  getOrCreateInFlightRequest,
  setBoundedExpiringEntry,
} from '../utils/boundedExpiringMap';

const PUBLIC_CACHE_TTL_MS = 3000;
const PUBLIC_CACHE_MAX_ENTRIES = 32;
const publicCache = new Map<string, { expiresAt: number; payload: unknown }>();
const publicRequests = new Map<string, Promise<unknown>>();

export type ContractOrderType = 'LIMIT' | 'MARKET';
export type ContractPositionSide = 'LONG' | 'SHORT';
export type ContractTpSlTriggerPriceType = 'MARK_PRICE' | 'LAST_PRICE';

export type ContractQuote = {
  symbol: string;
  lastPrice: number | null;
  markPrice: number | null;
  indexPrice: number | null;
  bidPrice: number | null;
  askPrice: number | null;
  fundingRate?: number | null;
  changePercent: number | null;
  high24h: number | null;
  low24h: number | null;
  baseVolume24h: number | null;
  quoteVolume24h: number | null;
  pricePrecision: number;
  executable?: boolean;
  quoteSource?: string | null;
  marketStatus?: string | null;
  spreadFeePrice?: number | null;
  effectiveSpread?: number | null;
  displayPrice?: number | null;
  executionBid?: number | null;
  executionAsk?: number | null;
  executionMode?: string | null;
  displayState?: string | null;
  reasonCode?: string | null;
  depthFreshness?: string | null;
  snapshotAuthority?: boolean;
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

export type ContractPage<T> = {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
  nextPage: number | null;
};

export type ContractMarketRevision = {
  epoch: number | null;
  sequence: number | null;
  isClosed: boolean | null;
  checksum: string | null;
};

export type ContractMarketSnapshotDomainMetadata = {
  domain: string;
  symbol: string;
  interval: string | null;
  source: string | null;
  provider: string | null;
  providerSymbol: string | null;
  transport: string | null;
  freshness: string | null;
  providerGeneration: number | null;
  revision: ContractMarketRevision | null;
  providerEventTimeMs: number | null;
  receivedAtMs: number | null;
  ageMs: number | null;
  ttlMs: number | null;
  stale: boolean | null;
  completenessStatus: string | null;
};

export type ContractMarketSnapshotMetadata = {
  ticker: ContractMarketSnapshotDomainMetadata | null;
  depth: ContractMarketSnapshotDomainMetadata | null;
  trades: ContractMarketSnapshotDomainMetadata | null;
  kline: ContractMarketSnapshotDomainMetadata | null;
};

export type ContractMarketView = {
  symbol: string;
  quote: ContractQuote;
  depth: ContractDepth;
  trades: ContractMarketTrade[];
  executable: boolean;
  displayState: string;
  reasonCode: string;
  authoritySource: string | null;
  snapshotAuthority: boolean;
  quoteFreshness: string | null;
  depthFreshness: string | null;
  tradesFreshness: string | null;
  priceAgeMs: number | null;
  executionTtlMs: number | null;
  snapshotMetadata: ContractMarketSnapshotMetadata;
  warnings: string[];
};

export function isContractExecutionReady(
  quote: ContractQuote | null | undefined,
  expectedSymbol: string,
) {
  if (!quote) return false;
  const bid = quote.executionBid;
  const ask = quote.executionAsk;
  return (
    quote.symbol.trim().toUpperCase() === expectedSymbol.trim().toUpperCase() &&
    quote.snapshotAuthority === true &&
    quote.executable === true &&
    quote.displayState?.toUpperCase() === 'LIVE_TRADABLE' &&
    quote.executionMode?.toUpperCase() === 'LIVE_BBO' &&
    bid !== null &&
    bid !== undefined &&
    ask !== null &&
    ask !== undefined &&
    Number.isFinite(bid) &&
    Number.isFinite(ask) &&
    bid > 0 &&
    ask > 0 &&
    ask >= bid
  );
}

export type ContractKline = {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type ContractKlineHistoryResult = {
  items: ContractKline[];
  stale: boolean | null;
  freshness: string | null;
  historyIncomplete: boolean;
  historyComplete: boolean | null;
  hasMoreBefore: boolean | null;
  historyTerminal: boolean | null;
  coverageComplete: boolean | null;
  providerErrorCode: string | null;
  retryable: boolean;
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
  takeProfitPrice: string | null;
  stopLossPrice: string | null;
  status: string;
  openedAt?: string | null;
};

export type ContractOrderItem = {
  id: string;
  orderId: number | null;
  clientOrderId?: string | null;
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
  closeReason?: string | null;
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
  closeReason?: string | null;
  createdAt?: string | null;
};

export type ContractSymbolRules = {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  pricePrecision: number;
  quantityPrecision: number;
  minQuantity: number;
  maxQuantity: number;
  maxLeverage: number;
  tpSlTriggerPriceType: ContractTpSlTriggerPriceType;
};

export type ContractOpenOrderPayload = {
  symbol: string;
  position_side: ContractPositionSide;
  order_type: ContractOrderType;
  client_order_id?: string;
  price?: string | null;
  quantity: string;
  leverage: number;
};

export type ContractCloseSummaryPayload = {
  symbol: string;
  side: ContractPositionSide;
  order_type: ContractOrderType;
  client_order_id?: string;
  price?: string | null;
  quantity?: string | null;
};

export type ContractOpenOrderResponse = {
  orderId: number;
  orderNo: string;
  status: string;
  positionId: number | null;
};

export type ContractCloseSummaryResponse = {
  orderIds: number[];
  status: string;
  requestedQuantity: string;
  closedQuantity: string;
};

export type ContractPositionTpSlPayload = {
  take_profit_price: string | null;
  stop_loss_price: string | null;
};

export type ContractPositionTpSlResponse = {
  positionId: number;
  symbol: string;
  side: ContractPositionSide;
  markPrice: string;
  takeProfitPrice: string | null;
  stopLossPrice: string | null;
};

export type ContractCancelOrderResponse = {
  orderId: number;
  status: string;
};

const CONTRACT_CANCELABLE_ORDER_STATUSES = new Set([
  'NEW',
  'OPEN',
  'PARTIALLY_FILLED',
]);
const CONTRACT_ORDER_SUCCESS_STATUSES = new Set([
  'OPEN',
  'PARTIALLY_FILLED',
  'FILLED',
]);
const CONTRACT_CANCEL_SUCCESS_STATUSES = new Set(['CANCELED']);

export function isValidContractOrderId(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function normalizeContractOrderId(value: unknown) {
  const candidate =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^[1-9]\d*$/.test(value.trim())
      ? Number(value)
      : null;
  return isValidContractOrderId(candidate) ? candidate : null;
}

function readContractOrderId(row: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const orderId = normalizeContractOrderId(row[key]);
    if (orderId !== null) return orderId;
  }
  return null;
}

export function isContractOrderStatusCancelable(status: unknown) {
  return CONTRACT_CANCELABLE_ORDER_STATUSES.has(
    String(status || '')
      .trim()
      .toUpperCase(),
  );
}

export function canCancelContractOrder(
  order: Pick<ContractOrderItem, 'orderId' | 'status'>,
) {
  return (
    isValidContractOrderId(order.orderId) &&
    isContractOrderStatusCancelable(order.status)
  );
}

type CanonicalContractDecimal = {
  sign: '' | '-';
  digits: string;
  exponent: number;
};

function canonicalContractDecimal(
  value: unknown,
): CanonicalContractDecimal | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim();
  const match = text.match(
    /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/,
  );
  if (!match) return null;
  const exponent = Number(match[5] ?? '0');
  if (!Number.isSafeInteger(exponent)) return null;

  const integer = match[2] ?? '';
  const fraction = match[3] ?? match[4] ?? '';
  let digits = `${integer}${fraction}`.replace(/^0+/, '');
  if (!digits) return { sign: '', digits: '0', exponent: 0 };
  const trailingZeros = digits.match(/0+$/)?.[0].length ?? 0;
  if (trailingZeros > 0) digits = digits.slice(0, -trailingZeros);
  return {
    sign: match[1] === '-' ? '-' : '',
    digits,
    exponent: exponent - fraction.length + trailingZeros,
  };
}

function contractDecimalsEqual(left: unknown, right: unknown) {
  const normalizedLeft = canonicalContractDecimal(left);
  const normalizedRight = canonicalContractDecimal(right);
  return (
    normalizedLeft !== null &&
    normalizedRight !== null &&
    normalizedLeft.sign === normalizedRight.sign &&
    normalizedLeft.digits === normalizedRight.digits &&
    normalizedLeft.exponent === normalizedRight.exponent
  );
}

function compareCanonicalContractDecimals(
  left: CanonicalContractDecimal,
  right: CanonicalContractDecimal,
) {
  if (left.sign !== right.sign) return left.sign === '-' ? -1 : 1;
  if (left.digits === '0' && right.digits === '0') return 0;

  const leftMagnitude = left.digits.length + left.exponent;
  const rightMagnitude = right.digits.length + right.exponent;
  let magnitudeComparison = 0;
  if (leftMagnitude !== rightMagnitude) {
    magnitudeComparison = leftMagnitude > rightMagnitude ? 1 : -1;
  } else {
    const width = Math.max(left.digits.length, right.digits.length);
    const paddedLeft = left.digits.padEnd(width, '0');
    const paddedRight = right.digits.padEnd(width, '0');
    magnitudeComparison =
      paddedLeft === paddedRight ? 0 : paddedLeft > paddedRight ? 1 : -1;
  }
  return left.sign === '-' ? -magnitudeComparison : magnitudeComparison;
}

function readStrictContractMutationText(
  row: Record<string, unknown>,
  key: string,
) {
  const value = row[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readStrictContractMutationDecimal(
  row: Record<string, unknown>,
  key: string,
  options: { allowZero?: boolean } = {},
) {
  const value = readStrictContractMutationText(row, key);
  const normalized = canonicalContractDecimal(value);
  if (
    value === null ||
    normalized === null ||
    normalized.sign === '-' ||
    (options.allowZero !== true && normalized.digits === '0')
  ) {
    return null;
  }
  return { text: value, normalized };
}

function readStrictContractMutationIdList(
  row: Record<string, unknown>,
  key: string,
  options: { allowEmpty?: boolean } = {},
) {
  const rawValues = row[key];
  if (!Array.isArray(rawValues)) return null;
  const values: number[] = [];
  for (const rawValue of rawValues) {
    if (!isValidContractOrderId(rawValue) || values.includes(rawValue)) {
      return null;
    }
    values.push(rawValue);
  }
  if (values.length === 0 && options.allowEmpty !== true) return null;
  return values;
}

function invalidContractMutationResponse(
  code:
    | 'INVALID_CONTRACT_ORDER_RESPONSE'
    | 'INVALID_CONTRACT_CLOSE_RESPONSE'
    | 'INVALID_CONTRACT_TP_SL_RESPONSE',
): never {
  const action =
    code === 'INVALID_CONTRACT_ORDER_RESPONSE'
      ? '下单'
      : code === 'INVALID_CONTRACT_CLOSE_RESPONSE'
      ? '平仓'
      : '止盈止损更新';
  throw new ApiClientError(
    `合约${action}响应与请求不一致或缺少有效订单信息，请刷新委托列表确认结果`,
    code,
  );
}

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

function invalidContractPrivateResponse(code: string, detail: string): never {
  throw new ApiClientError(`${detail}响应格式无效，请刷新后重试`, code);
}

function isValidContractClientOrderId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 64 &&
    /^[a-z0-9][a-z0-9._-]{0,63}$/.test(value)
  );
}

function readContractOptionalClientOrderId(
  row: Record<string, unknown>,
  code: string,
  detail: string,
) {
  if (!Object.prototype.hasOwnProperty.call(row, 'client_order_id'))
    return null;
  const value = row.client_order_id;
  if (value === null) return null;
  if (!isValidContractClientOrderId(value)) {
    invalidContractPrivateResponse(code, detail);
  }
  return value;
}

function readContractPrivateItems(
  payload: unknown,
  code: string,
  detail: string,
) {
  if (
    !isRecord(payload) ||
    !Object.prototype.hasOwnProperty.call(payload, 'items') ||
    !Array.isArray(payload.items)
  ) {
    invalidContractPrivateResponse(code, detail);
  }
  return payload.items;
}

function requireContractPrivateRecord(
  value: unknown,
  code: string,
  detail: string,
) {
  if (!isRecord(value) || Array.isArray(value)) {
    invalidContractPrivateResponse(code, detail);
  }
  return value;
}

function requireContractPrivateString(
  row: Record<string, unknown>,
  keys: string[],
  code: string,
  detail: string,
) {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return invalidContractPrivateResponse(code, detail);
}

function requireContractPrivateDecimalText(
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
  return invalidContractPrivateResponse(code, detail);
}

function readContractPrivateNullableDecimalText(
  row: Record<string, unknown>,
  keys: string[],
  code: string,
  detail: string,
  options: {
    allowNegative?: boolean;
    allowZero?: boolean;
    required?: boolean;
  } = {},
) {
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(row, key)) continue;
    if (row[key] === null) return null;
    return requireContractPrivateDecimalText(row, [key], code, detail, options);
  }
  if (options.required === true) {
    invalidContractPrivateResponse(code, detail);
  }
  return null;
}

function requireContractPrivatePositiveInteger(
  row: Record<string, unknown>,
  keys: string[],
  code: string,
  detail: string,
) {
  for (const key of keys) {
    const value = normalizeContractOrderId(row[key]);
    if (value !== null) return value;
  }
  return invalidContractPrivateResponse(code, detail);
}

function requireContractPrivateNonNegativeInteger(
  row: Record<string, unknown>,
  keys: string[],
  code: string,
  detail: string,
) {
  for (const key of keys) {
    const raw = row[key];
    const value =
      typeof raw === 'number'
        ? raw
        : typeof raw === 'string' && /^\d+$/.test(raw.trim())
        ? Number(raw)
        : null;
    if (value !== null && Number.isSafeInteger(value) && value >= 0) {
      return value;
    }
  }
  return invalidContractPrivateResponse(code, detail);
}

function requireContractPrivateSymbol(
  row: Record<string, unknown>,
  expectedSymbol: string,
  code: string,
  detail: string,
) {
  const symbol = requireContractPrivateString(
    row,
    ['symbol'],
    code,
    detail,
  ).toUpperCase();
  if (symbol !== expectedSymbol.trim().toUpperCase()) {
    invalidContractPrivateResponse(code, detail);
  }
  return symbol;
}

function requireContractPrivatePositionSide(
  row: Record<string, unknown>,
  code: string,
  detail: string,
) {
  const side = requireContractPrivateString(
    row,
    ['position_side', 'side'],
    code,
    detail,
  ).toUpperCase();
  if (side !== 'LONG' && side !== 'SHORT') {
    invalidContractPrivateResponse(code, detail);
  }
  return side;
}

function requireContractPrivateAction(
  row: Record<string, unknown>,
  code: string,
  detail: string,
) {
  const action = requireContractPrivateString(
    row,
    ['action'],
    code,
    detail,
  ).toUpperCase();
  if (action !== 'OPEN' && action !== 'CLOSE') {
    invalidContractPrivateResponse(code, detail);
  }
  return action;
}

function readContractPrivateOptionalString(
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
    invalidContractPrivateResponse(code, detail);
  }
  return null;
}

function readBoolean(row: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'boolean') return value;
  }
  return null;
}

function readNonNegativeSafeInteger(
  row: Record<string, unknown>,
  keys: string[],
) {
  const value = readNumber(row, keys);
  return value !== null && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function normalizeContractMarketRevision(
  payload: unknown,
): ContractMarketRevision | null {
  if (!isRecord(payload)) return null;
  const revision = {
    epoch: readNonNegativeSafeInteger(payload, ['epoch', 'revision_epoch']),
    sequence: readNonNegativeSafeInteger(payload, [
      'sequence',
      'revision_sequence',
      'revision_seq',
    ]),
    isClosed: readBoolean(payload, ['is_closed', 'isClosed']),
    checksum: readString(payload, ['checksum']) || null,
  };
  return Object.values(revision).some(value => value !== null)
    ? revision
    : null;
}

function normalizeContractMarketSnapshotDomainMetadata(
  payload: unknown,
): ContractMarketSnapshotDomainMetadata | null {
  if (!isRecord(payload)) return null;
  const completeness = isRecord(payload.completeness)
    ? payload.completeness
    : {};
  const embeddedRevision = normalizeContractMarketRevision(payload.revision);
  const flattenedRevision = normalizeContractMarketRevision(payload);
  return {
    domain: readString(payload, ['domain']).toLowerCase(),
    symbol: readString(payload, ['symbol']).toUpperCase(),
    interval: readString(payload, ['interval']) || null,
    source: readString(payload, ['source']).toUpperCase() || null,
    provider: readString(payload, ['provider']).toUpperCase() || null,
    providerSymbol:
      readString(payload, ['provider_symbol', 'providerSymbol']) || null,
    transport: readString(payload, ['transport']).toUpperCase() || null,
    freshness: readString(payload, ['freshness']).toUpperCase() || null,
    providerGeneration: readNonNegativeSafeInteger(payload, [
      'provider_generation',
      'providerGeneration',
    ]),
    revision: embeddedRevision || flattenedRevision,
    providerEventTimeMs: readNumber(payload, [
      'provider_event_time_ms',
      'providerEventTimeMs',
    ]),
    receivedAtMs: readNumber(payload, ['received_at_ms', 'receivedAtMs']),
    ageMs: readNumber(payload, ['age_ms', 'ageMs']),
    ttlMs: readNumber(payload, ['ttl_ms', 'ttlMs']),
    stale: readBoolean(payload, ['stale']),
    completenessStatus:
      readString(completeness, ['status']).toUpperCase() || null,
  };
}

function normalizeTradeSide(value: unknown): 'BUY' | 'SELL' {
  const text = String(value || '').toUpperCase();
  if (text === 'SELL' || text === 'SHORT') return 'SELL';
  return 'BUY';
}

function getPricePrecision(
  symbol: string,
  price: number | null,
  fallback?: number | null,
) {
  if (typeof fallback === 'number' && Number.isFinite(fallback))
    return fallback;
  const normalized = symbol.toUpperCase();
  if (normalized.includes('BTC') || normalized.includes('ETH')) return 2;
  if (price !== null && Math.abs(price) < 1) return 5;
  if (price !== null && Math.abs(price) < 10) return 4;
  return 2;
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

function withQuery(
  path: string,
  params: Record<string, string | number | undefined | null>,
) {
  const query = Object.entries(params)
    .filter(
      ([, value]) =>
        value !== undefined && value !== null && String(value) !== '',
    )
    .map(
      ([key, value]) =>
        `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`,
    )
    .join('&');
  return query ? `${path}?${query}` : path;
}

function normalizeContractDepthPayload(
  payload: unknown,
  fallbackSymbol: string,
): ContractDepth {
  const root = isRecord(payload) ? payload : {};
  const mapLevel = (row: unknown): ContractOrderBookLevel | null => {
    if (Array.isArray(row)) {
      const price = Number(row[0]);
      const amount = Number(row[1]);
      if (Number.isFinite(price) && Number.isFinite(amount)) {
        return { price, amount };
      }
      return null;
    }
    if (!isRecord(row)) return null;
    const price = readNumber(row, ['price']);
    const amount = readNumber(row, ['amount', 'qty', 'quantity']);
    if (price === null || amount === null) return null;
    return { price, amount };
  };
  const normalizedFallback = fallbackSymbol.trim().toUpperCase();
  const symbol = readString(root, ['symbol'], normalizedFallback).toUpperCase();
  if (symbol !== normalizedFallback) {
    throw new ApiClientError(
      '合约盘口行情标识不匹配，请重新加载',
      'CONTRACT_MARKET_VIEW_SYMBOL_MISMATCH',
    );
  }
  const depthPrice = readNumber(root, ['best_bid', 'best_ask', 'bid', 'ask']);
  return {
    symbol,
    bids: readRows(root.bids, ['items']).map(mapLevel).filter(Boolean),
    asks: readRows(root.asks, ['items']).map(mapLevel).filter(Boolean),
    pricePrecision: getPricePrecision(
      symbol,
      depthPrice,
      readNumber(root, ['price_precision', 'pricePrecision']),
    ),
    executable:
      typeof root.executable === 'boolean' ? root.executable : undefined,
  } as ContractDepth;
}

function normalizeContractMarketTradesPayload(
  payload: unknown,
  expectedSymbol?: string,
): ContractMarketTrade[] {
  if (expectedSymbol && isRecord(payload)) {
    const payloadSymbol = readString(payload, ['symbol']).toUpperCase();
    if (
      payloadSymbol &&
      payloadSymbol !== expectedSymbol.trim().toUpperCase()
    ) {
      throw new ApiClientError(
        '合约成交行情标识不匹配，请重新加载',
        'CONTRACT_MARKET_VIEW_SYMBOL_MISMATCH',
      );
    }
  }
  return readRows(payload, ['trades', 'items', 'data']).map((row, index) => {
    const record = isRecord(row) ? row : {};
    const rowSymbol = readString(record, ['symbol']).toUpperCase();
    if (
      expectedSymbol &&
      rowSymbol &&
      rowSymbol !== expectedSymbol.trim().toUpperCase()
    ) {
      throw new ApiClientError(
        '合约成交行情标识不匹配，请重新加载',
        'CONTRACT_MARKET_VIEW_SYMBOL_MISMATCH',
      );
    }
    return {
      id: readString(
        record,
        ['id', 'trade_id', 'tradeNo', 'provider_trade_id'],
        `${index}`,
      ),
      price: readNumber(record, ['price']),
      amount: readNumber(record, ['amount', 'qty', 'quantity']),
      side: normalizeTradeSide(record.side ?? record.position_side),
      ts: (record.time ?? record.ts ?? record.event_time_ms) as
        | number
        | string
        | null
        | undefined,
    };
  });
}

export function normalizeContractMarketViewPayload(
  payload: unknown,
  requestedSymbol: string,
): ContractMarketView {
  if (!isRecord(payload)) {
    throw new ApiClientError(
      '合约行情响应格式无效，请重新加载',
      'CONTRACT_MARKET_VIEW_INVALID_PAYLOAD',
    );
  }
  const root = payload;
  const normalizedRequestedSymbol = requestedSymbol.trim().toUpperCase();
  const symbol = readString(root, ['symbol']).toUpperCase();
  if (!symbol) {
    throw new ApiClientError(
      '合约行情响应缺少交易对，请重新加载',
      'CONTRACT_MARKET_VIEW_INVALID_PAYLOAD',
    );
  }
  if (symbol !== normalizedRequestedSymbol) {
    throw new ApiClientError(
      '合约行情标识不匹配，请重新加载',
      'CONTRACT_MARKET_VIEW_SYMBOL_MISMATCH',
    );
  }

  const rawTicker = isRecord(root.ticker) ? root.ticker : {};
  const tickerSymbol = readString(rawTicker, ['symbol']).toUpperCase();
  if (tickerSymbol && tickerSymbol !== symbol) {
    throw new ApiClientError(
      '合约行情标识不匹配，请重新加载',
      'CONTRACT_MARKET_VIEW_SYMBOL_MISMATCH',
    );
  }
  const depth = normalizeContractDepthPayload(root.depth, symbol);
  const trades = normalizeContractMarketTradesPayload(root.trades, symbol);
  const displayPrice =
    readNumber(root, ['display_price', 'last_trade_price']) ??
    readNumber(rawTicker, ['last_price', 'lastPrice', 'price']);
  const markPrice =
    readNumber(root, ['mark_price']) ??
    readNumber(rawTicker, ['mark_price', 'markPrice']);
  const indexPrice =
    readNumber(root, ['index_price']) ??
    readNumber(rawTicker, ['index_price', 'indexPrice']);
  const bestBid =
    readNumber(root, ['best_bid']) ?? depth.bids[0]?.price ?? null;
  const bestAsk =
    readNumber(root, ['best_ask']) ?? depth.asks[0]?.price ?? null;
  const rawExecutionBid = readNumber(root, ['execution_bid']);
  const rawExecutionAsk = readNumber(root, ['execution_ask']);
  const snapshotAuthority = root.snapshot_authority === true;
  const displayState = readString(
    root,
    ['display_state'],
    'UNAVAILABLE',
  ).toUpperCase();
  const reasonCode = readString(
    root,
    ['reason_code'],
    'UNAVAILABLE',
  ).toUpperCase();
  const executionMode = readString(
    root,
    ['execution_mode'],
    'DISABLED',
  ).toUpperCase();
  const hasUsableExecutionBbo =
    rawExecutionBid !== null &&
    rawExecutionAsk !== null &&
    rawExecutionBid > 0 &&
    rawExecutionAsk > 0 &&
    rawExecutionAsk >= rawExecutionBid;
  const executable =
    snapshotAuthority &&
    readString(root, ['view_version']) === '2' &&
    root.executable === true &&
    displayPrice !== null &&
    displayPrice > 0 &&
    displayState === 'LIVE_TRADABLE' &&
    reasonCode === 'LIVE_BBO' &&
    executionMode === 'LIVE_BBO' &&
    hasUsableExecutionBbo;
  const pricePrecision = getPricePrecision(
    symbol,
    markPrice ?? displayPrice,
    readNumber(rawTicker, ['price_precision', 'pricePrecision']) ??
      depth.pricePrecision,
  );
  const quoteFreshness =
    readString(root, ['ticker_freshness']) ||
    readString(rawTicker, ['quote_freshness', 'freshness']) ||
    null;
  const depthFreshness =
    readString(root, ['depth_freshness']) ||
    (isRecord(root.depth)
      ? readString(root.depth, ['quote_freshness', 'freshness'])
      : '') ||
    null;
  const priceAgeMs = readNumber(root, ['price_age_ms']);
  const snapshotMetadata = isRecord(root.snapshot_metadata)
    ? root.snapshot_metadata
    : {};
  const tickerMetadata = isRecord(snapshotMetadata.ticker)
    ? snapshotMetadata.ticker
    : {};
  const depthMetadata = isRecord(snapshotMetadata.depth)
    ? snapshotMetadata.depth
    : {};
  const explicitExecutionTtlMs = readNumber(root, ['execution_ttl_ms']);
  const tickerTtlMs = readNumber(tickerMetadata, ['ttl_ms']);
  const depthTtlMs = readNumber(depthMetadata, ['ttl_ms']);
  const executionTtlMs =
    explicitExecutionTtlMs !== null && explicitExecutionTtlMs > 0
      ? explicitExecutionTtlMs
      : tickerTtlMs !== null &&
        tickerTtlMs > 0 &&
        depthTtlMs !== null &&
        depthTtlMs > 0
      ? Math.min(tickerTtlMs, depthTtlMs)
      : null;
  const normalizedSnapshotMetadata: ContractMarketSnapshotMetadata = {
    ticker: normalizeContractMarketSnapshotDomainMetadata(
      snapshotMetadata.ticker,
    ),
    depth: normalizeContractMarketSnapshotDomainMetadata(
      snapshotMetadata.depth,
    ),
    trades: normalizeContractMarketSnapshotDomainMetadata(
      snapshotMetadata.trades,
    ),
    kline: normalizeContractMarketSnapshotDomainMetadata(
      snapshotMetadata.kline,
    ),
  };

  return {
    symbol,
    quote: {
      symbol,
      lastPrice: displayPrice,
      displayPrice,
      markPrice,
      indexPrice,
      bidPrice: bestBid,
      askPrice: bestAsk,
      fundingRate:
        readNumber(rawTicker, ['funding_rate', 'fundingRate']) ??
        readNumber(root, ['funding_rate', 'fundingRate']),
      executionBid: executable ? rawExecutionBid : null,
      executionAsk: executable ? rawExecutionAsk : null,
      changePercent: readNumber(rawTicker, [
        'price_change_percent_24h',
        'change_24h',
        'priceChangePercent',
      ]),
      high24h:
        readNumber(rawTicker, ['high_24h', 'high24h', 'highPrice']) ??
        readNumber(root, ['high_24h', 'high24h', 'highPrice']),
      low24h:
        readNumber(rawTicker, ['low_24h', 'low24h', 'lowPrice']) ??
        readNumber(root, ['low_24h', 'low24h', 'lowPrice']),
      baseVolume24h:
        readNumber(rawTicker, [
          'base_volume_24h',
          'baseVolume24h',
          'volume_24h',
          'volume24h',
          'vol24h',
        ]) ??
        readNumber(root, [
          'base_volume_24h',
          'baseVolume24h',
          'volume_24h',
          'volume24h',
          'vol24h',
        ]),
      quoteVolume24h:
        readNumber(rawTicker, [
          'quote_volume_24h',
          'quoteVolume24h',
          'quoteVolume',
          'volCcy24h',
        ]) ??
        readNumber(root, [
          'quote_volume_24h',
          'quoteVolume24h',
          'quoteVolume',
          'volCcy24h',
        ]),
      pricePrecision,
      executable,
      quoteSource:
        readString(root, ['ticker_source', 'authority_source']) || null,
      marketStatus: readString(root, ['market_status']) || null,
      spreadFeePrice: readNumber(rawTicker, [
        'single_side_spread_fee_price',
        'spread_fee_price',
        'spreadFeePrice',
      ]),
      effectiveSpread: readNumber(rawTicker, [
        'effective_total_spread',
        'effectiveSpread',
      ]),
      executionMode,
      displayState,
      reasonCode,
      depthFreshness,
      snapshotAuthority,
    },
    depth,
    trades,
    executable,
    displayState,
    reasonCode,
    authoritySource:
      readString(root, ['authority_source']).toUpperCase() || null,
    snapshotAuthority,
    quoteFreshness,
    depthFreshness,
    tradesFreshness: readString(root, ['trades_freshness']) || null,
    priceAgeMs: priceAgeMs !== null && priceAgeMs >= 0 ? priceAgeMs : null,
    executionTtlMs,
    snapshotMetadata: normalizedSnapshotMetadata,
    warnings: Array.isArray(root.warnings)
      ? root.warnings.filter(
          (warning): warning is string => typeof warning === 'string',
        )
      : [],
  };
}

export async function fetchContractMarketView(
  symbol: string,
  options: { signal?: AbortSignal } = {},
): Promise<ContractMarketView> {
  const normalizedSymbol = symbol.trim().toUpperCase();
  const payload = await publicApiClient.get<unknown>(
    withQuery('/contract/market/view', { symbol: normalizedSymbol }),
    options,
  );
  return normalizeContractMarketViewPayload(payload, normalizedSymbol);
}

export function formatContractNumber(
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

export function formatContractPercent(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value))
    return '--';
  const prefix = value > 0 ? '+' : '';
  return `${prefix}${value.toFixed(2)}%`;
}

export function formatContractFundingRate(
  value: number | null | undefined,
  labels?: {
    unavailable: string;
    format: (rate: string) => string;
  },
) {
  if (
    value === null ||
    value === undefined ||
    !Number.isFinite(value) ||
    Math.abs(value) > 1
  ) {
    return labels?.unavailable ?? '资金费率不可用';
  }
  const percent = value * 100;
  const prefix = percent > 0 ? '+' : '';
  const rate = `${prefix}${percent.toFixed(4)}%`;
  return labels?.format(rate) ?? `资金费率 ${rate}`;
}

export async function fetchContractQuote(
  symbol: string,
): Promise<ContractQuote | null> {
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
    fundingRate: readNumber(root, ['funding_rate', 'fundingRate']),
    changePercent: readNumber(root, [
      'price_change_percent_24h',
      'change_24h',
      'priceChangePercent',
    ]),
    high24h: readNumber(root, ['high_24h', 'high24h', 'highPrice']),
    low24h: readNumber(root, ['low_24h', 'low24h', 'lowPrice']),
    baseVolume24h: readNumber(root, [
      'base_volume_24h',
      'baseVolume24h',
      'volume_24h',
      'volume24h',
      'vol24h',
    ]),
    quoteVolume24h: readNumber(root, [
      'quote_volume_24h',
      'quoteVolume24h',
      'quoteVolume',
      'volCcy24h',
    ]),
    pricePrecision: getPricePrecision(
      normalizedSymbol,
      markPrice ?? lastPrice,
      readNumber(root, ['price_precision', 'pricePrecision']),
    ),
    executable:
      typeof root.executable === 'boolean' ? root.executable : undefined,
    quoteSource: readString(root, ['quote_source', 'quoteSource']) || null,
    marketStatus: readString(root, ['market_status', 'marketStatus']) || null,
    spreadFeePrice: readNumber(root, [
      'single_side_spread_fee_price',
      'spread_fee_price',
      'spreadFeePrice',
    ]),
    effectiveSpread: readNumber(root, [
      'effective_total_spread',
      'effectiveSpread',
    ]),
  };
}

export async function fetchContractSymbolRules(
  symbol: string,
): Promise<ContractSymbolRules | null> {
  const normalizedSymbol = symbol.trim().toUpperCase();
  const payload = await getCachedPublic<unknown>(
    withQuery('/contract/market/symbols', {
      keyword: normalizedSymbol,
      page: 1,
      page_size: 100,
    }),
  );
  return normalizeContractSymbolRulesPayload(payload, normalizedSymbol);
}

export function normalizeContractSymbolRulesPayload(
  payload: unknown,
  expectedSymbol: string,
): ContractSymbolRules | null {
  const code = 'INVALID_CONTRACT_SYMBOL_RULES_RESPONSE';
  const detail = '合约交易规则';
  const normalizedSymbol = expectedSymbol.trim().toUpperCase();
  const rows = readContractPrivateItems(payload, code, detail);
  let matched: Record<string, unknown> | null = null;
  for (const row of rows) {
    const record = requireContractPrivateRecord(row, code, detail);
    const symbol = requireContractPrivateString(
      record,
      ['symbol'],
      code,
      detail,
    ).toUpperCase();
    if (symbol === normalizedSymbol) matched = record;
  }
  if (!matched) return null;

  const pricePrecision = requireContractPrivateNonNegativeInteger(
    matched,
    ['price_precision'],
    code,
    detail,
  );
  const quantityPrecision = requireContractPrivateNonNegativeInteger(
    matched,
    ['quantity_precision'],
    code,
    detail,
  );
  if (pricePrecision > 18 || quantityPrecision > 18) {
    invalidContractPrivateResponse(code, detail);
  }
  const minQuantity = Number(
    requireContractPrivateDecimalText(matched, ['min_quantity'], code, detail),
  );
  const maxQuantity = Number(
    requireContractPrivateDecimalText(matched, ['max_quantity'], code, detail),
  );
  if (maxQuantity > 0 && maxQuantity < minQuantity) {
    invalidContractPrivateResponse(code, detail);
  }
  const tpSlTriggerPriceType = requireContractPrivateString(
    matched,
    ['tp_sl_trigger_price_type'],
    code,
    detail,
  ).toUpperCase();
  if (
    tpSlTriggerPriceType !== 'MARK_PRICE' &&
    tpSlTriggerPriceType !== 'LAST_PRICE'
  ) {
    invalidContractPrivateResponse(code, detail);
  }
  return {
    symbol: normalizedSymbol,
    baseAsset: requireContractPrivateString(
      matched,
      ['base_asset'],
      code,
      detail,
    ).toUpperCase(),
    quoteAsset: requireContractPrivateString(
      matched,
      ['quote_asset'],
      code,
      detail,
    ).toUpperCase(),
    pricePrecision,
    quantityPrecision,
    minQuantity,
    maxQuantity,
    maxLeverage: requireContractPrivatePositiveInteger(
      matched,
      ['max_leverage'],
      code,
      detail,
    ),
    tpSlTriggerPriceType,
  };
}

export async function fetchContractDepth(
  symbol: string,
  limit = 10,
): Promise<ContractDepth> {
  const payload = await getCachedPublic<unknown>(
    `/contract/market/depth?symbol=${encodeURIComponent(
      symbol,
    )}&limit=${limit}`,
  );
  return normalizeContractDepthPayload(payload, symbol);
}

export async function fetchContractKlines(
  symbol: string,
  interval = '1m',
  limit = 80,
  options: { signal?: AbortSignal } = {},
): Promise<ContractKline[]> {
  const result = await fetchContractKlineHistory(
    symbol,
    interval,
    limit,
    options,
  );
  return result.items;
}

function normalizeContractKlineRow(row: unknown): ContractKline | null {
  if (!isRecord(row)) return null;
  const rawOpenTime = readNumber(row, [
    'open_time',
    'openTime',
    'timestamp',
    'time',
  ]);
  const openTime =
    rawOpenTime !== null && rawOpenTime > 0
      ? Math.trunc(
          rawOpenTime < 10_000_000_000 ? rawOpenTime * 1000 : rawOpenTime,
        )
      : null;
  const open = readNumber(row, ['open']);
  const high = readNumber(row, ['high']);
  const low = readNumber(row, ['low']);
  const close = readNumber(row, ['close']);
  const volume = readNumber(row, ['volume']);
  if (
    openTime === null ||
    !Number.isSafeInteger(openTime) ||
    openTime <= 0 ||
    open === null ||
    high === null ||
    low === null ||
    close === null ||
    volume === null ||
    open <= 0 ||
    high <= 0 ||
    low <= 0 ||
    close <= 0 ||
    volume < 0 ||
    high < Math.max(open, low, close) ||
    low > Math.min(open, high, close)
  ) {
    return null;
  }
  return { openTime, open, high, low, close, volume };
}

export function normalizeContractKlineRows(payload: unknown, limit = 80) {
  const byOpenTime = new Map<number, ContractKline>();
  for (const row of readRows(payload, ['items', 'data', 'rows'])) {
    const normalized = normalizeContractKlineRow(row);
    if (normalized) byOpenTime.set(normalized.openTime, normalized);
  }
  const boundedLimit = Math.max(1, Math.min(200, Math.floor(limit)));
  return Array.from(byOpenTime.values())
    .sort((left, right) => left.openTime - right.openTime)
    .slice(-boundedLimit);
}

export async function fetchContractKlineHistory(
  symbol: string,
  interval = '1m',
  limit = 80,
  options: { signal?: AbortSignal } = {},
): Promise<ContractKlineHistoryResult> {
  const boundedLimit = Math.max(1, Math.min(200, Math.floor(limit)));
  const payload = await publicApiClient.get<unknown>(
    withQuery('/contract/market/kline', {
      symbol: symbol.trim().toUpperCase(),
      interval,
      limit: boundedLimit,
      include_metadata: 1,
    }),
    options,
  );
  const root = isRecord(payload) ? payload : {};
  return {
    items: normalizeContractKlineRows(payload, boundedLimit),
    stale: readBoolean(root, ['stale']),
    freshness: readString(root, ['freshness']).toUpperCase() || null,
    historyIncomplete:
      readBoolean(root, ['history_incomplete', 'historyIncomplete']) === true,
    historyComplete: readBoolean(root, ['history_complete', 'historyComplete']),
    hasMoreBefore: readBoolean(root, ['has_more_before', 'hasMoreBefore']),
    historyTerminal: readBoolean(root, ['history_terminal', 'historyTerminal']),
    coverageComplete: readBoolean(root, [
      'coverage_complete',
      'coverageComplete',
    ]),
    providerErrorCode:
      readString(root, ['provider_error_code', 'providerErrorCode']) || null,
    retryable: readBoolean(root, ['retryable']) === true,
  };
}

export async function fetchContractMarketTrades(
  symbol: string,
  limit = 20,
): Promise<ContractMarketTrade[]> {
  const payload = await getCachedPublic<unknown>(
    `/contract/market/trades?symbol=${encodeURIComponent(
      symbol,
    )}&limit=${limit}`,
  );
  return normalizeContractMarketTradesPayload(payload, symbol);
}

export async function fetchContractAccountSummary(): Promise<ContractAccountSummary> {
  const payload = await apiClient.get<unknown>('/contract/account/summary');
  return normalizeContractAccountSummaryPayload(payload);
}

export async function fetchContractPositions(
  symbol: string,
): Promise<ContractPositionItem[]> {
  const payload = await apiClient.get<unknown>(
    withQuery('/contract/positions', { symbol, status: 'OPEN' }),
  );
  return normalizeContractPositionsPayload(payload, symbol);
}

export async function fetchContractOrders(params: {
  symbol: string;
  status?: string;
  statusGroup?: 'ACTIVE' | 'HISTORY';
  pageSize?: number;
}): Promise<ContractOrderItem[]> {
  const payload = await apiClient.get<unknown>(
    withQuery('/contract/orders', {
      symbol: params.symbol,
      status: params.status,
      status_group: params.statusGroup,
      page: 1,
      page_size: params.pageSize ?? 20,
    }),
  );
  return normalizeContractOrdersPayload(payload, params.symbol);
}

export async function fetchContractOrdersPage(params: {
  symbol: string;
  status?: string;
  statusGroup?: 'ACTIVE' | 'HISTORY';
  page?: number;
  pageSize?: number;
}): Promise<ContractPage<ContractOrderItem>> {
  const page = params.page ?? 1;
  const pageSize = params.pageSize ?? 20;
  assertContractPageRequest(page, pageSize);
  const payload = await apiClient.get<unknown>(
    withQuery('/contract/orders', {
      symbol: params.symbol,
      status: params.status,
      status_group: params.statusGroup,
      page,
      page_size: pageSize,
    }),
  );
  return normalizeContractOrdersPagePayload(payload, params.symbol);
}

export async function fetchContractTrades(
  symbol: string,
  pageSize = 20,
): Promise<ContractTradeItem[]> {
  const payload = await apiClient.get<unknown>(
    withQuery('/contract/trades', { symbol, page: 1, page_size: pageSize }),
  );
  return normalizeContractTradesPayload(payload, symbol);
}

export async function fetchContractTradesPage(
  symbol: string,
  pageSize = 20,
  page = 1,
): Promise<ContractPage<ContractTradeItem>> {
  assertContractPageRequest(page, pageSize);
  const payload = await apiClient.get<unknown>(
    withQuery('/contract/trades', { symbol, page, page_size: pageSize }),
  );
  return normalizeContractTradesPagePayload(payload, symbol);
}

function assertContractPageRequest(page: number, pageSize: number) {
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > 100
  ) {
    throw new ApiClientError(
      '合约记录请求参数无效',
      'INVALID_CONTRACT_PAGE_REQUEST',
    );
  }
}

function normalizeContractPageMetadata<T>(
  payload: unknown,
  items: T[],
  code: string,
  detail: string,
): ContractPage<T> {
  const root = requireContractPrivateRecord(payload, code, detail);
  const total = requireContractPrivateNonNegativeInteger(
    root,
    ['total'],
    code,
    detail,
  );
  const page = requireContractPrivatePositiveInteger(
    root,
    ['page'],
    code,
    detail,
  );
  const pageSize = requireContractPrivatePositiveInteger(
    root,
    ['page_size'],
    code,
    detail,
  );
  const offset = (page - 1) * pageSize;
  const expectedItemCount =
    offset >= total ? 0 : Math.min(pageSize, total - offset);
  if (pageSize > 100 || offset > total || items.length !== expectedItemCount) {
    invalidContractPrivateResponse(code, detail);
  }
  const hasMore = page * pageSize < total;
  return {
    items,
    total,
    page,
    pageSize,
    hasMore,
    nextPage: hasMore ? page + 1 : null,
  };
}

export function normalizeContractAccountSummaryPayload(
  payload: unknown,
): ContractAccountSummary {
  const code = 'INVALID_CONTRACT_ACCOUNT_RESPONSE';
  const detail = '合约账户';
  const root = requireContractPrivateRecord(payload, code, detail);
  const marginAsset = requireContractPrivateString(
    root,
    ['margin_asset'],
    code,
    detail,
  ).toUpperCase();
  if (marginAsset !== 'USDT') {
    invalidContractPrivateResponse(code, detail);
  }
  const requiredNumber = (
    key: string,
    options: { allowNegative?: boolean } = {},
  ) =>
    Number(
      requireContractPrivateDecimalText(root, [key], code, detail, options),
    );
  const requiredNullableNumber = (
    key: string,
    options: { allowNegative?: boolean } = {},
  ) => {
    const value = readContractPrivateNullableDecimalText(
      root,
      [key],
      code,
      detail,
      { ...options, required: true },
    );
    return value === null ? null : Number(value);
  };
  return {
    marginAsset,
    availableMargin: requiredNumber('available_margin'),
    usedMargin: requiredNumber('used_margin'),
    frozenMargin: requiredNumber('frozen_margin'),
    positionMargin: requiredNumber('position_margin'),
    realizedPnl: requiredNumber('realized_pnl', { allowNegative: true }),
    unrealizedPnl: requiredNullableNumber('unrealized_pnl', {
      allowNegative: true,
    }),
    equity: requiredNullableNumber('equity', { allowNegative: true }),
  };
}

export function normalizeContractPositionsPayload(
  payload: unknown,
  expectedSymbol: string,
): ContractPositionItem[] {
  const code = 'INVALID_CONTRACT_POSITIONS_RESPONSE';
  const detail = '合约持仓';
  const rows = readContractPrivateItems(payload, code, detail);
  return rows.map(row => {
    const record = requireContractPrivateRecord(row, code, detail);
    const status = requireContractPrivateString(
      record,
      ['status'],
      code,
      detail,
    ).toUpperCase();
    if (status !== 'OPEN') invalidContractPrivateResponse(code, detail);
    const markPrice = readContractPrivateNullableDecimalText(
      record,
      ['mark_price'],
      code,
      detail,
      { allowZero: false, required: true },
    );
    const unrealizedPnl = readContractPrivateNullableDecimalText(
      record,
      ['unrealized_pnl'],
      code,
      detail,
      { allowNegative: true, required: true },
    );
    const liquidationPrice = readContractPrivateNullableDecimalText(
      record,
      ['liquidation_price'],
      code,
      detail,
      { allowZero: false },
    );
    const takeProfitPrice = readContractPrivateNullableDecimalText(
      record,
      ['take_profit_price'],
      code,
      detail,
      { allowZero: false },
    );
    const stopLossPrice = readContractPrivateNullableDecimalText(
      record,
      ['stop_loss_price'],
      code,
      detail,
      { allowZero: false },
    );
    return {
      id: String(
        requireContractPrivatePositiveInteger(record, ['id'], code, detail),
      ),
      symbol: requireContractPrivateSymbol(
        record,
        expectedSymbol,
        code,
        detail,
      ),
      side: requireContractPrivatePositionSide(record, code, detail),
      leverage: requireContractPrivatePositiveInteger(
        record,
        ['leverage'],
        code,
        detail,
      ),
      quantity: requireContractPrivateDecimalText(
        record,
        ['quantity'],
        code,
        detail,
        { allowZero: false },
      ),
      entryPrice: requireContractPrivateDecimalText(
        record,
        ['entry_price'],
        code,
        detail,
        { allowZero: false },
      ),
      markPrice: markPrice ?? '--',
      marginAmount: requireContractPrivateDecimalText(
        record,
        ['margin_amount'],
        code,
        detail,
      ),
      unrealizedPnl: unrealizedPnl ?? '--',
      liquidationPrice: liquidationPrice ?? '--',
      takeProfitPrice,
      stopLossPrice,
      status,
      openedAt: readContractPrivateOptionalString(
        record,
        ['opened_at'],
        code,
        detail,
      ),
    };
  });
}

export function normalizeContractOrdersPayload(
  payload: unknown,
  expectedSymbol: string,
): ContractOrderItem[] {
  const code = 'INVALID_CONTRACT_ORDERS_RESPONSE';
  const detail = '合约委托';
  const rows = readContractPrivateItems(payload, code, detail);
  return rows.map(row => {
    const record = requireContractPrivateRecord(row, code, detail);
    const orderId = requireContractPrivatePositiveInteger(
      record,
      ['id'],
      code,
      detail,
    );
    const orderType = requireContractPrivateString(
      record,
      ['order_type'],
      code,
      detail,
    ).toUpperCase();
    if (orderType !== 'LIMIT' && orderType !== 'MARKET') {
      invalidContractPrivateResponse(code, detail);
    }
    const price = readContractPrivateNullableDecimalText(
      record,
      ['price'],
      code,
      detail,
      { allowZero: false, required: true },
    );
    if (orderType === 'LIMIT' && price === null) {
      invalidContractPrivateResponse(code, detail);
    }
    return {
      id: String(orderId),
      orderId,
      clientOrderId: readContractOptionalClientOrderId(record, code, detail),
      symbol: requireContractPrivateSymbol(
        record,
        expectedSymbol,
        code,
        detail,
      ),
      positionSide: requireContractPrivatePositionSide(record, code, detail),
      action: requireContractPrivateAction(record, code, detail),
      orderType,
      price: price ?? '--',
      quantity: requireContractPrivateDecimalText(
        record,
        ['quantity'],
        code,
        detail,
        { allowZero: false },
      ),
      leverage: requireContractPrivatePositiveInteger(
        record,
        ['leverage'],
        code,
        detail,
      ),
      marginAmount: requireContractPrivateDecimalText(
        record,
        ['margin_amount'],
        code,
        detail,
      ),
      spreadFee: requireContractPrivateDecimalText(
        record,
        ['spread_fee'],
        code,
        detail,
      ),
      filledQuantity: requireContractPrivateDecimalText(
        record,
        ['filled_quantity'],
        code,
        detail,
      ),
      status: requireContractPrivateString(
        record,
        ['status'],
        code,
        detail,
      ).toUpperCase(),
      closeReason: readContractPrivateOptionalString(
        record,
        ['fail_reason'],
        code,
        detail,
      )?.toUpperCase() ?? null,
      createdAt: readContractPrivateOptionalString(
        record,
        ['created_at'],
        code,
        detail,
      ),
    };
  });
}

export function normalizeContractOrdersPagePayload(
  payload: unknown,
  expectedSymbol: string,
): ContractPage<ContractOrderItem> {
  const code = 'INVALID_CONTRACT_ORDERS_RESPONSE';
  const detail = '合约委托';
  return normalizeContractPageMetadata(
    payload,
    normalizeContractOrdersPayload(payload, expectedSymbol),
    code,
    detail,
  );
}

export function normalizeContractTradesPayload(
  payload: unknown,
  expectedSymbol: string,
): ContractTradeItem[] {
  const code = 'INVALID_CONTRACT_TRADES_RESPONSE';
  const detail = '合约成交';
  const rows = readContractPrivateItems(payload, code, detail);
  return rows.map(row => {
    const record = requireContractPrivateRecord(row, code, detail);
    return {
      id: String(
        requireContractPrivatePositiveInteger(record, ['id'], code, detail),
      ),
      symbol: requireContractPrivateSymbol(
        record,
        expectedSymbol,
        code,
        detail,
      ),
      positionSide: requireContractPrivatePositionSide(record, code, detail),
      action: requireContractPrivateAction(record, code, detail),
      price: requireContractPrivateDecimalText(
        record,
        ['price'],
        code,
        detail,
        { allowZero: false },
      ),
      quantity: requireContractPrivateDecimalText(
        record,
        ['quantity'],
        code,
        detail,
        { allowZero: false },
      ),
      notional: requireContractPrivateDecimalText(
        record,
        ['notional'],
        code,
        detail,
      ),
      leverage: requireContractPrivatePositiveInteger(
        record,
        ['leverage'],
        code,
        detail,
      ),
      marginAmount: requireContractPrivateDecimalText(
        record,
        ['margin_amount'],
        code,
        detail,
      ),
      feeAmount: requireContractPrivateDecimalText(
        record,
        ['fee_amount'],
        code,
        detail,
      ),
      spreadFee: requireContractPrivateDecimalText(
        record,
        ['spread_fee'],
        code,
        detail,
      ),
      realizedPnl: requireContractPrivateDecimalText(
        record,
        ['realized_pnl'],
        code,
        detail,
        { allowNegative: true },
      ),
      closeReason: readContractPrivateOptionalString(
        record,
        ['close_reason'],
        code,
        detail,
      )?.toUpperCase() ?? null,
      createdAt: readContractPrivateOptionalString(
        record,
        ['created_at'],
        code,
        detail,
      ),
    };
  });
}

export function normalizeContractTradesPagePayload(
  payload: unknown,
  expectedSymbol: string,
): ContractPage<ContractTradeItem> {
  const code = 'INVALID_CONTRACT_TRADES_RESPONSE';
  const detail = '合约成交';
  return normalizeContractPageMetadata(
    payload,
    normalizeContractTradesPayload(payload, expectedSymbol),
    code,
    detail,
  );
}

export async function openContractOrder(
  payload: ContractOpenOrderPayload,
): Promise<ContractOpenOrderResponse> {
  if (
    payload.client_order_id !== undefined &&
    !isValidContractClientOrderId(payload.client_order_id)
  ) {
    throw new ApiClientError(
      '合约订单请求信息无效，订单未发送',
      'INVALID_CLIENT_ORDER_ID',
    );
  }
  const response = await apiClient.post<unknown>(
    '/contract/orders/open',
    payload,
  );
  const root = isRecord(response) ? response : {};
  const orderId = isValidContractOrderId(root.order_id) ? root.order_id : null;
  const orderNo = readStrictContractMutationText(root, 'order_no');
  const status = readStrictContractMutationText(root, 'status')?.toUpperCase();
  const symbol = readStrictContractMutationText(root, 'symbol')?.toUpperCase();
  const positionSide = readStrictContractMutationText(
    root,
    'position_side',
  )?.toUpperCase();
  const orderType = readStrictContractMutationText(
    root,
    'order_type',
  )?.toUpperCase();
  const quantity = readStrictContractMutationDecimal(root, 'quantity');
  const responseLeverage = root.leverage;
  const responsePrice = root.price;
  const expectedPrice = payload.price;
  const priceMatches =
    expectedPrice === undefined || expectedPrice === null
      ? responsePrice === null
      : typeof responsePrice === 'string' &&
        contractDecimalsEqual(responsePrice, expectedPrice);
  const rawPositionId = root.position_id;
  const positionId =
    rawPositionId === null
      ? null
      : isValidContractOrderId(rawPositionId)
      ? rawPositionId
      : undefined;
  const responseClientOrderId = readContractOptionalClientOrderId(
    root,
    'INVALID_CONTRACT_ORDER_RESPONSE',
    '合约下单',
  );
  if (
    !isValidContractOrderId(orderId) ||
    orderNo === null ||
    status === undefined ||
    !CONTRACT_ORDER_SUCCESS_STATUSES.has(status) ||
    symbol !== payload.symbol.trim().toUpperCase() ||
    positionSide !== payload.position_side ||
    orderType !== payload.order_type ||
    (payload.client_order_id !== undefined &&
      responseClientOrderId !== payload.client_order_id) ||
    quantity === null ||
    !contractDecimalsEqual(quantity.text, payload.quantity) ||
    !Number.isSafeInteger(responseLeverage) ||
    responseLeverage !== payload.leverage ||
    !priceMatches ||
    positionId === undefined
  ) {
    invalidContractMutationResponse('INVALID_CONTRACT_ORDER_RESPONSE');
  }
  return {
    orderId,
    orderNo,
    status,
    positionId,
  };
}

export async function closeContractSummaryOrder(
  payload: ContractCloseSummaryPayload,
): Promise<ContractCloseSummaryResponse> {
  if (
    payload.client_order_id !== undefined &&
    !isValidContractClientOrderId(payload.client_order_id)
  ) {
    throw new ApiClientError(
      '合约订单请求信息无效，订单未发送',
      'INVALID_CLIENT_ORDER_ID',
    );
  }
  const response = await apiClient.post<unknown>(
    '/contract/orders/close-summary',
    payload,
  );
  const root = isRecord(response) ? response : {};
  const orderIds = readStrictContractMutationIdList(
    root,
    'generated_order_ids',
  );
  const tradeIds = readStrictContractMutationIdList(
    root,
    'generated_trade_ids',
    { allowEmpty: true },
  );
  const positionIds = readStrictContractMutationIdList(
    root,
    'affected_position_ids',
  );
  const status = readStrictContractMutationText(root, 'status')?.toUpperCase();
  const symbol = readStrictContractMutationText(root, 'symbol')?.toUpperCase();
  const side = readStrictContractMutationText(root, 'side')?.toUpperCase();
  const orderType = readStrictContractMutationText(
    root,
    'order_type',
  )?.toUpperCase();
  const hasResponsePrice = Object.prototype.hasOwnProperty.call(root, 'price');
  const responseLimitPrice =
    orderType === 'LIMIT'
      ? readStrictContractMutationDecimal(root, 'price')
      : null;
  const responsePriceMatchesPayload =
    hasResponsePrice &&
    ((orderType === 'LIMIT' &&
      typeof payload.price === 'string' &&
      responseLimitPrice !== null &&
      contractDecimalsEqual(responseLimitPrice.text, payload.price)) ||
      (orderType === 'MARKET' && root.price === null));
  const requestedQuantity = readStrictContractMutationDecimal(
    root,
    'requested_quantity',
  );
  const submittedQuantity = readStrictContractMutationDecimal(
    root,
    'submitted_quantity',
  );
  const closedQuantity = readStrictContractMutationDecimal(
    root,
    'closed_quantity',
    { allowZero: true },
  );
  const requestedMatchesPayload =
    payload.quantity === undefined || payload.quantity === null
      ? true
      : requestedQuantity !== null &&
        contractDecimalsEqual(requestedQuantity.text, payload.quantity);
  const quantityRelationshipValid =
    requestedQuantity !== null &&
    submittedQuantity !== null &&
    closedQuantity !== null &&
    contractDecimalsEqual(submittedQuantity.text, requestedQuantity.text) &&
    compareCanonicalContractDecimals(
      closedQuantity.normalized,
      requestedQuantity.normalized,
    ) <= 0;
  const statusMatchesQuantities =
    requestedQuantity !== null &&
    closedQuantity !== null &&
    ((status === 'OPEN' && closedQuantity.normalized.digits === '0') ||
      (status === 'FILLED' &&
        contractDecimalsEqual(closedQuantity.text, requestedQuantity.text)) ||
      (status === 'PARTIALLY_FILLED' &&
        closedQuantity.normalized.digits !== '0' &&
        compareCanonicalContractDecimals(
          closedQuantity.normalized,
          requestedQuantity.normalized,
        ) < 0));
  const responseClientOrderId = readContractOptionalClientOrderId(
    root,
    'INVALID_CONTRACT_CLOSE_RESPONSE',
    '合约平仓',
  );
  if (
    orderIds === null ||
    tradeIds === null ||
    positionIds === null ||
    positionIds.length !== orderIds.length ||
    status === undefined ||
    !CONTRACT_ORDER_SUCCESS_STATUSES.has(status) ||
    symbol !== payload.symbol.trim().toUpperCase() ||
    side !== payload.side ||
    orderType !== payload.order_type ||
    !responsePriceMatchesPayload ||
    (payload.client_order_id !== undefined &&
      responseClientOrderId !== payload.client_order_id) ||
    !requestedMatchesPayload ||
    !quantityRelationshipValid ||
    !statusMatchesQuantities
  ) {
    invalidContractMutationResponse('INVALID_CONTRACT_CLOSE_RESPONSE');
  }
  return {
    orderIds,
    status,
    requestedQuantity: requestedQuantity.text,
    closedQuantity: closedQuantity.text,
  };
}

export async function updateContractPositionTpSl(
  position: Pick<ContractPositionItem, 'id' | 'symbol' | 'side'>,
  payload: ContractPositionTpSlPayload,
): Promise<ContractPositionTpSlResponse> {
  const positionId = normalizeContractOrderId(position.id);
  if (positionId === null) {
    throw new ApiClientError(
      '合约持仓标识无效，请刷新持仓后重试',
      'INVALID_CONTRACT_POSITION_ID',
    );
  }
  const response = await apiClient.patch<unknown>(
    `/contract/positions/${positionId}/tp-sl`,
    payload,
  );
  const root = isRecord(response) ? response : {};
  const responsePositionId = readContractOrderId(root, ['position_id']);
  const symbol = readStrictContractMutationText(root, 'symbol')?.toUpperCase();
  const side = readStrictContractMutationText(root, 'side')?.toUpperCase();
  const markPrice = readStrictContractMutationDecimal(root, 'mark_price');
  const readNullablePrice = (key: 'take_profit_price' | 'stop_loss_price') => {
    if (!Object.prototype.hasOwnProperty.call(root, key)) return undefined;
    if (root[key] === null) return null;
    return readStrictContractMutationDecimal(root, key);
  };
  const takeProfitPrice = readNullablePrice('take_profit_price');
  const stopLossPrice = readNullablePrice('stop_loss_price');
  const priceMatches = (
    responsePrice: ReturnType<typeof readNullablePrice>,
    requestedPrice: string | null,
  ) =>
    requestedPrice === null
      ? responsePrice === null
      : responsePrice !== null &&
        responsePrice !== undefined &&
        contractDecimalsEqual(responsePrice.text, requestedPrice);
  if (
    responsePositionId !== positionId ||
    symbol !== position.symbol.trim().toUpperCase() ||
    side !== position.side ||
    markPrice === null ||
    takeProfitPrice === undefined ||
    stopLossPrice === undefined ||
    !priceMatches(takeProfitPrice, payload.take_profit_price) ||
    !priceMatches(stopLossPrice, payload.stop_loss_price)
  ) {
    invalidContractMutationResponse('INVALID_CONTRACT_TP_SL_RESPONSE');
  }
  return {
    positionId,
    symbol,
    side: side as ContractPositionSide,
    markPrice: markPrice.text,
    takeProfitPrice: takeProfitPrice === null ? null : takeProfitPrice.text,
    stopLossPrice: stopLossPrice === null ? null : stopLossPrice.text,
  };
}

export async function cancelContractOrder(
  orderId: number,
): Promise<ContractCancelOrderResponse> {
  if (!isValidContractOrderId(orderId)) {
    throw new ApiClientError(
      '合约订单标识无效，请刷新委托列表后重试',
      'INVALID_CONTRACT_ORDER_ID',
    );
  }
  const response = await apiClient.post<unknown>(
    `/contract/orders/${orderId}/cancel`,
  );
  const root = isRecord(response) ? response : {};
  const responseOrderId = readContractOrderId(root, [
    'order_id',
    'orderId',
    'id',
  ]);
  const status = readString(root, ['status']).toUpperCase();
  if (
    !isValidContractOrderId(responseOrderId) ||
    responseOrderId !== orderId ||
    !CONTRACT_CANCEL_SUCCESS_STATUSES.has(status)
  ) {
    throw new ApiClientError(
      '合约撤单响应无法确认订单状态，请刷新委托列表确认结果',
      'INVALID_CONTRACT_CANCEL_RESPONSE',
    );
  }
  return {
    orderId: responseOrderId,
    status,
  };
}
