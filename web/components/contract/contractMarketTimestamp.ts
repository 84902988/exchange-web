import { normalizeContractTimestampMs } from '@/lib/contractTimestamp';

export function parseContractMarketTimestamp(value?: string | number | null) {
  return normalizeContractTimestampMs(value);
}
