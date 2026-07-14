export type ContractKlineLoadPolicy = Readonly<{
  visibleBars: number;
  currentLimit: number;
  historyPageLimit: number;
  preloadLimit: number;
  requestDeadlineMs: number;
  historyChainDeadlineMs: number;
  preloadDeadlineMs: number;
}>;

export const CONTRACT_KLINE_HISTORY_CHAIN_PAGE_LIMIT = 500;
export const CONTRACT_KLINE_PRELOAD_CACHE_BARS = 360;

const CONTRACT_KLINE_LOAD_POLICIES: Readonly<Record<string, ContractKlineLoadPolicy>> = {
  '1m': {
    visibleBars: 75,
    currentLimit: 150,
    historyPageLimit: 200,
    preloadLimit: CONTRACT_KLINE_PRELOAD_CACHE_BARS,
    requestDeadlineMs: 12_000,
    historyChainDeadlineMs: 12_000,
    preloadDeadlineMs: 15_000,
  },
  '5m': {
    visibleBars: 75,
    currentLimit: 140,
    historyPageLimit: 200,
    preloadLimit: CONTRACT_KLINE_PRELOAD_CACHE_BARS,
    requestDeadlineMs: 12_000,
    historyChainDeadlineMs: 12_000,
    preloadDeadlineMs: 15_000,
  },
  '15m': {
    visibleBars: 85,
    currentLimit: 130,
    historyPageLimit: 180,
    preloadLimit: CONTRACT_KLINE_PRELOAD_CACHE_BARS,
    requestDeadlineMs: 12_000,
    historyChainDeadlineMs: 12_000,
    preloadDeadlineMs: 15_000,
  },
  '1h': {
    visibleBars: 75,
    currentLimit: 150,
    historyPageLimit: 180,
    preloadLimit: CONTRACT_KLINE_PRELOAD_CACHE_BARS,
    requestDeadlineMs: 12_000,
    historyChainDeadlineMs: 12_000,
    preloadDeadlineMs: 15_000,
  },
  '4h': {
    visibleBars: 65,
    currentLimit: 130,
    historyPageLimit: 160,
    preloadLimit: CONTRACT_KLINE_PRELOAD_CACHE_BARS,
    requestDeadlineMs: 12_000,
    historyChainDeadlineMs: 12_000,
    preloadDeadlineMs: 15_000,
  },
  '1d': {
    visibleBars: 60,
    currentLimit: 120,
    historyPageLimit: 120,
    preloadLimit: CONTRACT_KLINE_PRELOAD_CACHE_BARS,
    requestDeadlineMs: 12_000,
    historyChainDeadlineMs: 12_000,
    preloadDeadlineMs: 15_000,
  },
  '1w': {
    visibleBars: 45,
    currentLimit: 80,
    historyPageLimit: 100,
    preloadLimit: CONTRACT_KLINE_PRELOAD_CACHE_BARS,
    requestDeadlineMs: 12_000,
    historyChainDeadlineMs: 12_000,
    preloadDeadlineMs: 15_000,
  },
  '1M': {
    visibleBars: 36,
    currentLimit: 60,
    historyPageLimit: 60,
    preloadLimit: CONTRACT_KLINE_PRELOAD_CACHE_BARS,
    requestDeadlineMs: 15_000,
    historyChainDeadlineMs: 15_000,
    preloadDeadlineMs: 15_000,
  },
};

const CONTRACT_KLINE_MIN_REQUEST_LIMIT = 50;

export function normalizeContractKlineLoadInterval(value: unknown) {
  const normalized = String(value ?? '').trim();
  return normalized === '1M' ? '1M' : normalized.toLowerCase();
}
export function normalizeContractKlineLoadSymbol(value: unknown) {
  return String(value ?? '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
}

export function getContractKlineLoadPolicy(interval: unknown): ContractKlineLoadPolicy {
  return (
    CONTRACT_KLINE_LOAD_POLICIES[normalizeContractKlineLoadInterval(interval)]
    ?? CONTRACT_KLINE_LOAD_POLICIES['1m']
  );
}

export function getContractKlineVisibleBars(interval: unknown) {
  return getContractKlineLoadPolicy(interval).visibleBars;
}

export function buildContractKlineRangeKey({
  symbol,
  interval,
  endTimeMs,
}: {
  symbol: unknown;
  interval: unknown;
  endTimeMs?: number | null;
}) {
  const rangeEnd = endTimeMs === undefined || endTimeMs === null
    ? 'CURRENT'
    : String(Math.floor(Number(endTimeMs)));
  return [
    normalizeContractKlineLoadSymbol(symbol),
    normalizeContractKlineLoadInterval(interval),
    rangeEnd,
  ].join('|');
}

function normalizeRequestedBars(value: unknown, fallback: number) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.max(1, Math.ceil(numeric));
}

export function resolveContractKlineRequestPlan({
  interval,
  countBack,
  firstDataRequest,
  maxBars = 1_000,
}: {
  interval: unknown;
  countBack: unknown;
  firstDataRequest: boolean;
  maxBars?: number;
}) {
  const policy = getContractKlineLoadPolicy(interval);
  const maximum = Math.max(CONTRACT_KLINE_MIN_REQUEST_LIMIT, Math.floor(maxBars));
  const requestedBars = Math.min(
    normalizeRequestedBars(countBack, policy.currentLimit),
    maximum,
  );

  if (firstDataRequest) {
    const requiredBars = Math.min(
      Math.max(requestedBars, policy.visibleBars, CONTRACT_KLINE_MIN_REQUEST_LIMIT),
      maximum,
    );
    return {
      requestedBars,
      requiredBars,
      initialLimit: Math.min(requiredBars, policy.currentLimit),
      pageLimit: Math.min(maximum, CONTRACT_KLINE_HISTORY_CHAIN_PAGE_LIMIT),
      policy,
    };
  }

  const requiredBars = Math.max(CONTRACT_KLINE_MIN_REQUEST_LIMIT, requestedBars);
  return {
    requestedBars,
    requiredBars,
    initialLimit: Math.min(requiredBars, policy.historyPageLimit),
    pageLimit: Math.min(maximum, CONTRACT_KLINE_HISTORY_CHAIN_PAGE_LIMIT),
    policy,
  };
}
