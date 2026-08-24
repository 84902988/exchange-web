export function signedPercent(value: number) {
  const prefix = value > 0 ? '+' : '';
  return `${prefix}${value.toFixed(2)}%`;
}

export function formatFixedPrice(
  value: number | null | undefined,
  precision = 2,
) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '--';
  }
  const safePrecision = Number.isFinite(precision)
    ? Math.min(20, Math.max(0, Math.trunc(precision)))
    : 2;
  return value.toLocaleString('en-US', {
    minimumFractionDigits: safePrecision,
    maximumFractionDigits: safePrecision,
  });
}
