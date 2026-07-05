const DEFAULT_SPOT_PRICE_PRECISION = 2;
const MAX_SPOT_PRICE_PRECISION = 12;

export type SpotPricePrecisionInput = {
  displayPricePrecision?: unknown;
  pricePrecision?: unknown;
  priceTickSize?: unknown;
  tickSize?: unknown;
  fallbackPrecision?: unknown;
};

export function normalizeSpotPricePrecision(value: unknown): number | null {
  const nextValue = Number(value);
  if (Number.isInteger(nextValue) && nextValue >= 0 && nextValue <= MAX_SPOT_PRICE_PRECISION) {
    return nextValue;
  }
  return null;
}

function normalizeDecimalString(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  const raw = String(value).trim().replace(/,/g, '');
  if (!raw) return null;
  const num = Number(raw);
  if (!Number.isFinite(num) || num <= 0) return null;

  if (/e/i.test(raw)) {
    return num.toFixed(MAX_SPOT_PRICE_PRECISION).replace(/0+$/, '').replace(/\.$/, '');
  }

  return raw;
}

function decimalPlacesFromString(value: string): number | null {
  const normalized = normalizeDecimalString(value);
  if (!normalized) return null;
  const [, decimal = ''] = normalized.split('.');
  const trimmedDecimal = decimal.replace(/0+$/, '');
  return Math.min(trimmedDecimal.length, MAX_SPOT_PRICE_PRECISION);
}

export function precisionFromSpotTickSize(value: unknown): number | null {
  const normalized = normalizeDecimalString(value);
  if (!normalized) return null;
  return decimalPlacesFromString(normalized);
}

export function resolveSpotPricePrecision(input: SpotPricePrecisionInput = {}): number {
  const displayPrecision = normalizeSpotPricePrecision(input.displayPricePrecision);
  if (displayPrecision !== null) {
    return displayPrecision;
  }

  const tickPrecision = precisionFromSpotTickSize(input.priceTickSize ?? input.tickSize);
  if (tickPrecision !== null) {
    return tickPrecision;
  }

  const configuredPrecision = normalizeSpotPricePrecision(input.pricePrecision);
  if (configuredPrecision !== null) {
    return configuredPrecision;
  }

  const fallbackPrecision = normalizeSpotPricePrecision(input.fallbackPrecision);
  return fallbackPrecision ?? DEFAULT_SPOT_PRICE_PRECISION;
}

export function formatSpotPrice(value: string | number | null | undefined, precision?: number | null): string {
  const num = Number(String(value ?? '').replace(/,/g, ''));
  if (!Number.isFinite(num)) return '--';
  const normalizedPrecision = normalizeSpotPricePrecision(precision) ?? DEFAULT_SPOT_PRICE_PRECISION;
  return num.toLocaleString('en-US', {
    minimumFractionDigits: normalizedPrecision,
    maximumFractionDigits: normalizedPrecision,
  });
}

export function normalizeSpotPriceInput(value: string | number | null | undefined, precision?: number | null): string {
  const num = Number(String(value ?? '').replace(/,/g, ''));
  if (!Number.isFinite(num)) return '';
  const normalizedPrecision = normalizeSpotPricePrecision(precision) ?? DEFAULT_SPOT_PRICE_PRECISION;
  return num.toFixed(normalizedPrecision);
}

export function getSpotPriceStep(precision?: number | null): string {
  const normalizedPrecision = normalizeSpotPricePrecision(precision) ?? DEFAULT_SPOT_PRICE_PRECISION;
  if (normalizedPrecision <= 0) return '1';
  return `0.${'0'.repeat(normalizedPrecision - 1)}1`;
}
