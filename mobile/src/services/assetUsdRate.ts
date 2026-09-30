import {publicApiClient} from '../api/client';

export type AssetUsdRate = {rate: number; asOf: number};

export function normalizeAssetUsdRate(payload: unknown, now = Date.now()): AssetUsdRate | null {
  if (!payload || typeof payload !== 'object') return null;
  const row = payload as Record<string, unknown>;
  if (row.base !== 'USDT' || row.quote !== 'USD' || row.stale !== false ||
    typeof row.rate !== 'number' || !Number.isFinite(row.rate) || row.rate <= 0 ||
    typeof row.as_of !== 'number' || !Number.isFinite(row.as_of) ||
    now - row.as_of > 120_000 || row.as_of - now > 30_000) return null;
  return {rate: row.rate, asOf: row.as_of};
}

export async function fetchAssetUsdRate(): Promise<AssetUsdRate | null> {
  try {
    return normalizeAssetUsdRate(await publicApiClient.get('/market/valuation-rate'));
  } catch {
    return null;
  }
}

export function usdtToUsd(value: number | null | undefined, rate: number | null | undefined) {
  if (value == null || rate == null || !Number.isFinite(rate) || rate <= 0) return null;
  const result = value * rate;
  return Number.isFinite(result) ? result : null;
}
