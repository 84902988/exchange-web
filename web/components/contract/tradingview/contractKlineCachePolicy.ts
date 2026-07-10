export const CONTRACT_KLINE_ASSET_CLASSES = [
  'CRYPTO',
  'STOCK',
  'CFD',
  'INDEX',
  'UNKNOWN',
] as const;

export type ContractKlineAssetClass = typeof CONTRACT_KLINE_ASSET_CLASSES[number];

export const CONTRACT_KLINE_CURRENT_CACHE_TTL_MS = 15_000;

const CRYPTO_CATEGORY_ALIASES = new Set(['CRYPTO']);
const STOCK_CATEGORY_ALIASES = new Set(['STOCK', 'STOCK_CONTRACT']);
const CFD_CATEGORY_ALIASES = new Set([
  'CFD',
  'FOREX',
  'FX',
  'METAL',
  'GOLD',
  'COMMODITY',
  'FUTURES',
]);

const CURRENT_CACHE_TTL_BY_ASSET_CLASS: Record<
  ContractKlineAssetClass,
  Readonly<Record<string, number>>
> = {
  CRYPTO: {
    '1m': 5_000,
    '5m': 10_000,
    '15m': 10_000,
  },
  STOCK: {
    '1m': 10_000,
    '5m': 10_000,
  },
  CFD: {
    '1m': 10_000,
    '5m': 10_000,
  },
  INDEX: {
    '1m': 10_000,
    '5m': 10_000,
  },
  UNKNOWN: {},
};

export function normalizeContractKlineAssetClass(value: unknown): ContractKlineAssetClass {
  const normalized = String(value ?? '').trim().toUpperCase();
  if (CRYPTO_CATEGORY_ALIASES.has(normalized)) return 'CRYPTO';
  if (STOCK_CATEGORY_ALIASES.has(normalized)) return 'STOCK';
  if (CFD_CATEGORY_ALIASES.has(normalized)) return 'CFD';
  if (normalized === 'INDEX') return 'INDEX';
  return 'UNKNOWN';
}

export function normalizeContractKlinePolicyInterval(value: unknown) {
  const normalized = String(value ?? '').trim();
  return normalized === '1M' ? '1M' : normalized.toLowerCase();
}

export function getContractKlineCurrentCacheTtlMs({
  category,
  interval,
}: {
  category: unknown;
  interval: unknown;
}) {
  const assetClass = normalizeContractKlineAssetClass(category);
  const normalizedInterval = normalizeContractKlinePolicyInterval(interval);
  if (!normalizedInterval) return CONTRACT_KLINE_CURRENT_CACHE_TTL_MS;
  return (
    CURRENT_CACHE_TTL_BY_ASSET_CLASS[assetClass][normalizedInterval]
    ?? CONTRACT_KLINE_CURRENT_CACHE_TTL_MS
  );
}
