import type { ContractQuote } from '@/lib/api/modules/contract';

const CONTRACT_QUOTE_STICKY_INCREMENT_FIELDS = [
  'market_status',
  'market_status_text',
  'market_session_code',
  'market_timezone',
  'market_trading_hours',
  'market_session_type',
  'quote_freshness',
  'quote_source',
  'executable',
  'is_realtime',
  'last_good_at',
  'stale',
  'open_24h',
  'price_change_24h',
  'price_change_percent_24h',
  'high_24h',
  'low_24h',
  'base_volume_24h',
  'quote_volume_24h',
] as const satisfies readonly (keyof ContractQuote)[];

function isMissingIncrementValue(value: unknown) {
  return value === undefined || value === null || value === '';
}

/**
 * Provider quote frames are incremental. Preserve slow-moving session and
 * 24h evidence when a faster price-only frame omits it, while still allowing
 * explicit false/zero values to replace the previous snapshot.
 */
export function mergeContractQuoteIncrement<T extends ContractQuote>(
  previous: T | null,
  incoming: T,
): T {
  if (!previous) return incoming;

  const merged: Record<string, unknown> = { ...incoming };
  const previousRecord = previous as unknown as Record<string, unknown>;
  for (const field of CONTRACT_QUOTE_STICKY_INCREMENT_FIELDS) {
    if (
      isMissingIncrementValue(merged[field])
      && !isMissingIncrementValue(previousRecord[field])
    ) {
      merged[field] = previousRecord[field];
    }
  }
  return merged as T;
}
