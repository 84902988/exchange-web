import {apiClient, ApiClientError} from './client';

export type TradeIdempotencyMarket = 'spot' | 'contract';
export type TradeIdempotencyAuthorityStatus =
  | 'NOT_FOUND'
  | 'PENDING'
  | 'COMPLETED';

export type TradeIdempotencyAuthority = {
  market: TradeIdempotencyMarket;
  clientOrderId: string;
  status: TradeIdempotencyAuthorityStatus;
  operation: string | null;
  result: Record<string, unknown> | null;
  resultSymbol: string | null;
  createdAt: string | null;
  completedAt: string | null;
};

const CLIENT_ORDER_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,63}$/;
const OPERATIONS: Record<TradeIdempotencyMarket, ReadonlySet<string>> = {
  spot: new Set(['SPOT_CREATE']),
  contract: new Set(['CONTRACT_OPEN', 'CONTRACT_CLOSE_SUMMARY']),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function invalidAuthority(message: string): never {
  throw new ApiClientError(message, 'INVALID_TRADE_IDEMPOTENCY_RESPONSE');
}

function readNullableTimestamp(value: unknown, field: string) {
  if (value === null || value === undefined) return null;
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    !Number.isFinite(Date.parse(value))
  ) {
    invalidAuthority(`订单权威核验响应的 ${field} 无效`);
  }
  return value;
}

export function normalizeTradeIdempotencyStatusPayload(
  payload: unknown,
  expectedMarket: TradeIdempotencyMarket,
  expectedClientOrderId: string,
): TradeIdempotencyAuthority {
  const normalizedClientOrderId = expectedClientOrderId.trim().toLowerCase();
  if (!CLIENT_ORDER_ID_PATTERN.test(normalizedClientOrderId)) {
    throw new ApiClientError(
      '订单幂等标识无效，无法执行权威核验',
      'INVALID_CLIENT_ORDER_ID',
    );
  }
  if (!isRecord(payload)) {
    invalidAuthority('订单权威核验响应格式无效');
  }
  const market =
    typeof payload.market === 'string' ? payload.market.trim().toUpperCase() : '';
  const expectedMarketValue = expectedMarket.toUpperCase();
  const clientOrderId =
    typeof payload.client_order_id === 'string'
      ? payload.client_order_id.trim().toLowerCase()
      : '';
  const status =
    typeof payload.status === 'string' ? payload.status.trim().toUpperCase() : '';
  const operation =
    payload.operation === null || payload.operation === undefined
      ? null
      : typeof payload.operation === 'string'
        ? payload.operation.trim().toUpperCase()
        : invalidAuthority('订单权威核验响应的操作类型无效');
  const createdAt = readNullableTimestamp(payload.created_at, 'created_at');
  const completedAt = readNullableTimestamp(
    payload.completed_at,
    'completed_at',
  );

  if (
    market !== expectedMarketValue ||
    clientOrderId !== normalizedClientOrderId ||
    !['NOT_FOUND', 'PENDING', 'COMPLETED'].includes(status)
  ) {
    invalidAuthority('订单权威核验响应与当前安全锁不一致');
  }

  if (status === 'NOT_FOUND') {
    if (
      operation !== null ||
      payload.result !== null ||
      createdAt !== null ||
      completedAt !== null
    ) {
      invalidAuthority('未找到状态包含了不应存在的订单结果');
    }
    return {
      market: expectedMarket,
      clientOrderId,
      status,
      operation: null,
      result: null,
      resultSymbol: null,
      createdAt: null,
      completedAt: null,
    };
  }

  if (!operation || !OPERATIONS[expectedMarket].has(operation)) {
    invalidAuthority('订单权威核验响应的操作类型不受支持');
  }
  if (status === 'PENDING') {
    if (payload.result !== null || completedAt !== null || createdAt === null) {
      invalidAuthority('待处理订单的权威核验响应无效');
    }
    return {
      market: expectedMarket,
      clientOrderId,
      status,
      operation,
      result: null,
      resultSymbol: null,
      createdAt,
      completedAt: null,
    };
  }

  if (!isRecord(payload.result) || createdAt === null || completedAt === null) {
    invalidAuthority('已完成订单缺少权威结果');
  }
  const resultClientOrderId =
    typeof payload.result.client_order_id === 'string'
      ? payload.result.client_order_id.trim().toLowerCase()
      : '';
  const resultSymbol =
    typeof payload.result.symbol === 'string'
      ? payload.result.symbol.trim().toUpperCase()
      : '';
  if (resultClientOrderId !== clientOrderId || !resultSymbol) {
    invalidAuthority('已完成订单结果与当前安全锁不一致');
  }
  return {
    market: expectedMarket,
    clientOrderId,
    status: 'COMPLETED',
    operation,
    result: payload.result,
    resultSymbol,
    createdAt,
    completedAt,
  };
}

export async function fetchTradeIdempotencyStatus(
  market: TradeIdempotencyMarket,
  clientOrderId: string,
) {
  const normalizedClientOrderId = clientOrderId.trim().toLowerCase();
  if (!CLIENT_ORDER_ID_PATTERN.test(normalizedClientOrderId)) {
    throw new ApiClientError(
      '订单幂等标识无效，无法执行权威核验',
      'INVALID_CLIENT_ORDER_ID',
    );
  }
  const basePath =
    market === 'spot' ? '/order/idempotency' : '/contract/orders/idempotency';
  const response = await apiClient.get<unknown>(
    `${basePath}/${encodeURIComponent(normalizedClientOrderId)}`,
  );
  return normalizeTradeIdempotencyStatusPayload(
    response,
    market,
    normalizedClientOrderId,
  );
}
