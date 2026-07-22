import { normalizeContractTimestampMs } from '@/lib/contractTimestamp';

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

export function getContractTradeEventTimeMs(value: unknown): number | null {
  const trade = asRecord(value);
  if (!trade) return null;
  for (const key of [
    'event_time_ms',
    'provider_event_time_ms',
    'time',
    'ts',
    'timestamp',
    'exchange_ts',
  ]) {
    const timestampMs = normalizeContractTimestampMs(trade[key]);
    if (timestampMs !== null) return timestampMs;
  }
  return null;
}

export function getContractTradeIdentity(value: unknown): string | null {
  const trade = asRecord(value);
  if (!trade) return null;
  const explicitId = String(trade.id ?? trade.trade_id ?? '').trim();
  if (explicitId) return explicitId;
  const timestampMs = getContractTradeEventTimeMs(trade);
  const price = String(trade.price ?? trade.last_price ?? '').trim();
  const quantity = String(
    trade.qty ?? trade.amount ?? trade.quantity ?? trade.volume ?? '',
  ).trim();
  return timestampMs !== null && price && quantity
    ? `${timestampMs}:${price}:${quantity}`
    : null;
}

/**
 * Canonical Contract trade ordering shared by REST bootstrap, WS updates and
 * the domain Store. The newest real event is always row zero; invalid/missing
 * timestamps can never outrank valid provider events.
 */
export function orderContractTradesNewestFirst<T>(
  trades: readonly T[],
  limit = 30,
): T[] {
  const safeLimit = Math.max(0, Math.floor(limit));
  if (safeLimit === 0 || trades.length === 0) return [];

  const ordered = trades.map((trade, inputIndex) => ({
    trade,
    inputIndex,
    eventTimeMs: getContractTradeEventTimeMs(trade) ?? Number.NEGATIVE_INFINITY,
  }));
  ordered.sort((left, right) => (
    right.eventTimeMs - left.eventTimeMs || left.inputIndex - right.inputIndex
  ));

  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of ordered) {
    const identity = getContractTradeIdentity(item.trade);
    if (identity && seen.has(identity)) continue;
    if (identity) seen.add(identity);
    result.push(item.trade);
    if (result.length >= safeLimit) break;
  }
  return result;
}
