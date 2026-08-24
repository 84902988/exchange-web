import type {
  CreateSpotOrderPayload,
  SpotOrderItem,
} from '../api/spot';
import type {PendingTradeIntent} from './pendingTradeIntent';

export type PendingSpotOrderIntent = PendingTradeIntent<CreateSpotOrderPayload>;

const ORDER_INTENT_MATCH_WINDOW_MS = 5 * 60_000;

function normalizeText(value: unknown) {
  return String(value ?? '').trim().toUpperCase();
}

function normalizeDecimal(value: unknown) {
  const raw = String(value ?? '').trim();
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw)) return null;
  const [wholeRaw = '0', fractionRaw = ''] = raw.split('.');
  const whole = wholeRaw.replace(/^0+(?=\d)/, '') || '0';
  const fraction = fractionRaw.replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

function hasCompatibleCreatedAt(intent: PendingSpotOrderIntent, order: SpotOrderItem) {
  if (!order.createdAt) return false;
  const createdAtMs = Date.parse(order.createdAt);
  if (!Number.isFinite(createdAtMs)) return false;
  return (
    createdAtMs >= intent.createdAtMs - 60_000 &&
    createdAtMs <= intent.createdAtMs + ORDER_INTENT_MATCH_WINDOW_MS
  );
}

function matchesIntentFields(
  intent: PendingSpotOrderIntent,
  order: SpotOrderItem,
) {
  const payload = intent.payload;
  if (
    normalizeText(order.symbol) !== normalizeText(payload.symbol) ||
    normalizeText(order.side) !== normalizeText(payload.side) ||
    normalizeText(order.orderType) !== normalizeText(payload.order_type) ||
    !hasCompatibleCreatedAt(intent, order)
  ) {
    return false;
  }

  if (payload.order_type === 'LIMIT') {
    return (
      normalizeDecimal(order.price) === normalizeDecimal(payload.price) &&
      normalizeDecimal(order.amount) === normalizeDecimal(payload.amount)
    );
  }
  if (payload.side === 'SELL') {
    return normalizeDecimal(order.amount) === normalizeDecimal(payload.amount);
  }

  // MARKET BUY is submitted in quote currency while the order snapshot exposes
  // the actually filled base amount. Without a server-enforced client order id,
  // another device's order cannot be distinguished safely, so remain locked for
  // an explicit user review instead of heuristically clearing the safety lock.
  return false;
}

export function findAuthoritativeSpotOrderForIntent(
  intent: PendingSpotOrderIntent,
  currentOrders: readonly SpotOrderItem[],
  historyOrders: readonly SpotOrderItem[],
) {
  const baseline = new Set(intent.baselineIds);
  const byId = new Map<number, SpotOrderItem>();
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
        : !baseline.has(orderId) && matchesIntentFields(intent, order);
    if (!matchesOwnership) continue;
    byId.set(orderId, order);
  }
  return byId.size === 1 ? Array.from(byId.values())[0] : null;
}
