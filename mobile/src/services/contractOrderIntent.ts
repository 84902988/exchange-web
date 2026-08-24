import type {
  ContractOrderItem,
  ContractOrderType,
  ContractPositionSide,
} from '../api/contract';
import type {PendingTradeIntent} from './pendingTradeIntent';

export type ContractOrderIntentPayload = {
  action: 'OPEN' | 'CLOSE';
  symbol: string;
  positionSide: ContractPositionSide;
  orderType: ContractOrderType;
  price?: string | null;
  quantity: string;
  leverage?: number | null;
};

export type PendingContractOrderIntent =
  PendingTradeIntent<ContractOrderIntentPayload>;

const ORDER_INTENT_MATCH_WINDOW_MS = 5 * 60_000;

function normalizeText(value: unknown) {
  return String(value ?? '').trim().toUpperCase();
}

function parseDecimal(value: unknown) {
  const raw = String(value ?? '').trim();
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw)) return null;
  const [wholeRaw = '0', fractionRaw = ''] = raw.split('.');
  const whole = wholeRaw.replace(/^0+(?=\d)/, '') || '0';
  const fraction = fractionRaw.replace(/0+$/, '');
  return {
    digits: BigInt(`${whole}${fraction}` || '0'),
    scale: fraction.length,
  };
}

function equalDecimal(left: unknown, right: unknown) {
  const first = parseDecimal(left);
  const second = parseDecimal(right);
  if (!first || !second) return false;
  if (first.scale === second.scale) return first.digits === second.digits;
  if (first.scale < second.scale) {
    return (
      first.digits * 10n ** BigInt(second.scale - first.scale) ===
      second.digits
    );
  }
  return (
    first.digits ===
    second.digits * 10n ** BigInt(first.scale - second.scale)
  );
}

function sumEquals(values: readonly string[], expected: string) {
  const parsed = values.map(parseDecimal);
  const target = parseDecimal(expected);
  if (!target || parsed.some(item => item === null)) return false;
  const rows = parsed.filter(item => item !== null);
  const scale = Math.max(target.scale, ...rows.map(item => item.scale));
  const sum = rows.reduce(
    (total, item) =>
      total + item.digits * 10n ** BigInt(scale - item.scale),
    0n,
  );
  return sum === target.digits * 10n ** BigInt(scale - target.scale);
}

function hasCompatibleCreatedAt(
  intent: PendingContractOrderIntent,
  order: ContractOrderItem,
) {
  if (!order.createdAt) return false;
  const createdAtMs = Date.parse(order.createdAt);
  return (
    Number.isFinite(createdAtMs) &&
    createdAtMs >= intent.createdAtMs - 60_000 &&
    createdAtMs <= intent.createdAtMs + ORDER_INTENT_MATCH_WINDOW_MS
  );
}

function matchesCommonFields(
  intent: PendingContractOrderIntent,
  order: ContractOrderItem,
) {
  const payload = intent.payload;
  if (
    normalizeText(order.symbol) !== normalizeText(payload.symbol) ||
    normalizeText(order.action) !== payload.action ||
    normalizeText(order.positionSide) !== payload.positionSide ||
    normalizeText(order.orderType) !== payload.orderType ||
    !hasCompatibleCreatedAt(intent, order)
  ) {
    return false;
  }
  return (
    payload.orderType !== 'LIMIT' ||
    equalDecimal(order.price, payload.price)
  );
}

/**
 * Reconciles an ambiguous mutation only against orders that were not present
 * before submission. It is a mobile-side safety net, not a replacement for a
 * server-enforced client order id.
 */
export function findAuthoritativeContractOrdersForIntent(
  intent: PendingContractOrderIntent,
  currentOrders: readonly ContractOrderItem[],
  historyOrders: readonly ContractOrderItem[],
) {
  const baseline = new Set(intent.baselineIds);
  const candidates = new Map<number, ContractOrderItem>();
  for (const order of [...currentOrders, ...historyOrders]) {
    const orderId = order.orderId;
    if (
      orderId === null ||
      !Number.isSafeInteger(orderId) ||
      orderId <= 0
    ) {
      continue;
    }
    const matchesOwnership =
      intent.version === 2
        ? order.clientOrderId === intent.clientOrderId
        : !baseline.has(orderId) && matchesCommonFields(intent, order);
    if (!matchesOwnership) continue;
    candidates.set(orderId, order);
  }

  const rows = Array.from(candidates.values()).sort(
    (left, right) => Number(left.orderId) - Number(right.orderId),
  );
  if (intent.payload.action === 'OPEN') {
    if (rows.length !== 1) return null;
    const [order] = rows;
    if (
      !equalDecimal(order.quantity, intent.payload.quantity) ||
      (intent.payload.leverage !== null &&
        intent.payload.leverage !== undefined &&
        order.leverage !== intent.payload.leverage)
    ) {
      return null;
    }
    return rows;
  }

  if (
    rows.length === 0 ||
    !sumEquals(
      rows.map(order => order.quantity),
      intent.payload.quantity,
    )
  ) {
    return null;
  }
  return rows;
}
