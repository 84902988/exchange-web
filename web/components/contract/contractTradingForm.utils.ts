const DEFAULT_CONTRACT_AMOUNT_PRECISION = 6;
const MAX_CONTRACT_AMOUNT_PRECISION = 12;

export function normalizeContractAmountPrecision(
  value: unknown,
  fallback = DEFAULT_CONTRACT_AMOUNT_PRECISION,
) {
  const normalizedFallback = Number.isInteger(fallback)
    && fallback >= 0
    && fallback <= MAX_CONTRACT_AMOUNT_PRECISION
    ? fallback
    : DEFAULT_CONTRACT_AMOUNT_PRECISION;
  const precision = value === null
    || value === undefined
    || (typeof value === 'string' && value.trim() === '')
    ? Number.NaN
    : Number(value);
  return Number.isInteger(precision)
    && precision >= 0
    && precision <= MAX_CONTRACT_AMOUNT_PRECISION
    ? precision
    : normalizedFallback;
}

export function normalizeContractDecimalInput(value: string): string | null {
  return /^\d*\.?\d*$/.test(value) ? value : null;
}

function toFiniteNonNegativeNumber(value: string | number) {
  if (value === '' || value === '.') return null;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue >= 0 ? numberValue : null;
}

export function formatContractAmountOnBlur(
  value: string | number,
  precision: unknown,
) {
  const numberValue = toFiniteNonNegativeNumber(value);
  if (numberValue === null) return '';
  return numberValue.toFixed(normalizeContractAmountPrecision(precision));
}

export function floorContractAmount(
  value: string | number,
  precision: unknown,
) {
  const numberValue = toFiniteNonNegativeNumber(value);
  if (numberValue === null) return '';
  const safePrecision = normalizeContractAmountPrecision(precision);
  const factor = 10 ** safePrecision;
  const flooredValue = Math.floor(numberValue * factor) / factor;
  return flooredValue.toFixed(safePrecision);
}

export function calculateContractSliderAmount(
  maximumQuantity: string | number,
  percent: number,
  precision: unknown,
) {
  const quantity = toFiniteNonNegativeNumber(maximumQuantity);
  if (quantity === null) return '';
  const safePercent = Number.isFinite(percent)
    ? Math.min(Math.max(percent, 0), 100)
    : 0;
  return floorContractAmount(quantity * (safePercent / 100), precision);
}

export function isPositiveContractAmountAtPrecision(
  value: string | number,
  precision: unknown,
) {
  const formatted = formatContractAmountOnBlur(value, precision);
  return formatted !== '' && Number(formatted) > 0;
}

export function resolveContractOpenEntryReference({
  side,
  orderType,
  limitPrice,
  executionPrice,
  executable,
}: {
  side: 'LONG' | 'SHORT';
  orderType: 'MARKET' | 'LIMIT';
  limitPrice: string | number;
  executionPrice: string | number | null;
  executable: boolean;
}): number | null {
  const liveExecutionPrice = Number(executionPrice);
  if (!executable || !Number.isFinite(liveExecutionPrice) || liveExecutionPrice <= 0) return null;
  if (orderType === 'MARKET') return liveExecutionPrice;

  const normalizedLimitPrice = Number(limitPrice);
  if (!Number.isFinite(normalizedLimitPrice) || normalizedLimitPrice <= 0) return null;
  const isMarketable = side === 'LONG'
    ? normalizedLimitPrice >= liveExecutionPrice
    : normalizedLimitPrice <= liveExecutionPrice;
  return isMarketable ? liveExecutionPrice : normalizedLimitPrice;
}
