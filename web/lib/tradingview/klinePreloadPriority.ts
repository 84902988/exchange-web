export const KLINE_PRELOAD_IDLE_DELAY_MS = 180;
export const KLINE_PRELOAD_IDLE_TIMEOUT_MS = 500;
export const KLINE_PRELOAD_REQUEST_GAP_MS = 100;
export const KLINE_PRELOAD_BACKGROUND_INTERVAL_LIMIT = 3;

const KLINE_INTERVAL_PRIORITY: Readonly<Record<string, readonly string[]>> = {
  '1m': ['5m', '15m', '1h', '4h', '1d', '1w', '1M'],
  '5m': ['1m', '15m', '1h', '4h', '1d', '1w', '1M'],
  '15m': ['5m', '1h', '1m', '4h', '1d', '1w', '1M'],
  '1h': ['4h', '15m', '5m', '1d', '1m', '1w', '1M'],
  '4h': ['1h', '1d', '15m', '1w', '5m', '1M', '1m'],
  '1d': ['1w', '1M', '4h', '1h', '15m', '5m', '1m'],
  '1w': ['1M', '1d', '4h', '1h', '15m', '5m', '1m'],
  '1M': ['1w', '1d', '4h', '1h', '15m', '5m', '1m'],
};

export function normalizeKlinePreloadInterval(value: string) {
  const interval = String(value || '').trim();
  if (interval === '1M' || interval === '1Mutc') return '1M';
  if (interval === '1Dutc') return '1d';
  if (interval === '1Wutc') return '1w';
  return interval.toLowerCase();
}

export function rankKlinePreloadIntervals(
  activeInterval: string,
  availableIntervals: readonly string[],
) {
  const active = normalizeKlinePreloadInterval(activeInterval);
  const availableByIdentity = new Map<string, string>();
  availableIntervals.forEach((interval) => {
    const identity = normalizeKlinePreloadInterval(interval);
    if (identity && !availableByIdentity.has(identity)) availableByIdentity.set(identity, interval);
  });
  availableByIdentity.delete(active);

  const ranked: string[] = [];
  const append = (identity: string) => {
    const interval = availableByIdentity.get(identity);
    if (!interval) return;
    ranked.push(interval);
    availableByIdentity.delete(identity);
  };
  (KLINE_INTERVAL_PRIORITY[active] || []).forEach(append);
  availableByIdentity.forEach((interval) => ranked.push(interval));
  return ranked;
}

export function promoteKlinePreloadInterval(queue: readonly string[], interval: string) {
  const target = normalizeKlinePreloadInterval(interval);
  if (!target) return [...queue];
  const promoted = queue.find((item) => normalizeKlinePreloadInterval(item) === target) || interval;
  return [
    promoted,
    ...queue.filter((item) => normalizeKlinePreloadInterval(item) !== target),
  ];
}
