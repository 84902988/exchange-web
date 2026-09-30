import {publicRequest} from '../api/core/request';

export function normalizeUsdValuationRate(payload: unknown, now = Date.now()): number | null {
  if (!payload || typeof payload !== 'object') return null;
  const row = payload as Record<string, unknown>;
  if (row.base !== 'USDT' || row.quote !== 'USD' || row.stale !== false ||
    typeof row.rate !== 'number' || !Number.isFinite(row.rate) || row.rate <= 0 ||
    typeof row.as_of !== 'number' || !Number.isFinite(row.as_of) ||
    now - row.as_of > 120_000 || row.as_of - now > 30_000) return null;
  return row.rate;
}

export async function fetchUsdValuationRate(): Promise<unknown> {
  return publicRequest('/market/valuation-rate');
}

export function toUsd(value: number | null, rate: number | null) {
  if (value === null || rate === null || !Number.isFinite(rate) || rate <= 0) return null;
  const result = value * rate;
  return Number.isFinite(result) ? result : null;
}
