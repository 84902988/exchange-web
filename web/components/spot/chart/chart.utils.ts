export function toNumber(value: unknown, fallback = 0): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

export function normalizeTimeToSeconds(value: unknown): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return num > 9999999999 ? Math.floor(num / 1000) : Math.floor(num);
}

export function extractItems(payload: unknown) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];

  const record = payload as Record<string, unknown>;
  if (Array.isArray(record.items)) return record.items;
  if (Array.isArray(record.data)) return record.data;
  if (Array.isArray(record.rows)) return record.rows;
  if (Array.isArray(record.result)) return record.result;
  return [];
}

export function isPlaceholderCandle(
  open: number,
  high: number,
  low: number,
  close: number,
  volume: number
): boolean {
  return volume <= 0 && open === high && high === low && low === close;
}

export function formatUtcTimeLabel(time: number): string {
  const date = new Date(time * 1000);
  return `${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(
    date.getUTCDate()
  ).padStart(2, '0')} ${String(date.getUTCHours()).padStart(2, '0')}:${String(
    date.getUTCMinutes()
  ).padStart(2, '0')}`;
}

export function getIntervalSeconds(interval: string): number {
  switch (interval) {
    case '1m':
      return 60;
    case '5m':
      return 5 * 60;
    case '15m':
      return 15 * 60;
    case '30m':
      return 30 * 60;
    case '1h':
      return 60 * 60;
    case '4h':
      return 4 * 60 * 60;
    case '1d':
      return 24 * 60 * 60;
    case '1w':
      return 7 * 24 * 60 * 60;
    case '1M':
      return 30 * 24 * 60 * 60;
    default:
      return 60;
  }
}

export function getBucketStart(ts: number, interval: string): number {
  const step = getIntervalSeconds(interval);
  return Math.floor(ts / step) * step;
}
