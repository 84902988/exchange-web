const ISO_DATETIME_WITHOUT_TIMEZONE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/;

/**
 * Contract provider datetimes are UTC instants. Older REST responses omitted
 * the timezone suffix, so parse those values as UTC instead of browser-local
 * time. Numeric provider timestamps keep their seconds/milliseconds contract.
 */
export function normalizeContractTimestampMs(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;

  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return null;
    const numeric = Number(text);
    if (!Number.isFinite(numeric)) {
      const parseTarget = ISO_DATETIME_WITHOUT_TIMEZONE.test(text)
        ? `${text.replace(' ', 'T')}Z`
        : text;
      const parsed = Date.parse(parseTarget);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    }
    return numeric > 0
      ? numeric < 1_000_000_000_000 ? numeric * 1000 : numeric
      : null;
  }

  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
}
