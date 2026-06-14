export function formatRatePercent(
  value: number | string | null | undefined,
  fallback = "--",
) {
  if (value === null || value === undefined) return fallback;

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return fallback;
    if (trimmed.endsWith("%")) return trimmed;

    const numericValue = Number(trimmed);
    if (!Number.isFinite(numericValue)) return fallback;
    return `${(numericValue * 100).toFixed(0)}%`;
  }

  if (!Number.isFinite(value)) return fallback;
  return `${(value * 100).toFixed(0)}%`;
}
