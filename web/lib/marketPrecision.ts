export const DEFAULT_PRICE_PRECISION = 2

const SPOT_SYMBOL_PRICE_PRECISION: Record<string, number> = {
  BTCUSDT: 2,
  ETHUSDT: 2,
  MFCUSDT: 2,
  RCBUSDT: 4,
}

const CONTRACT_SYMBOL_PRICE_PRECISION: Record<string, number> = {
  BTCUSDT_PERP: 1,
  ETHUSDT_PERP: 2,
}

const SYMBOL_PRICE_PRECISION: Record<string, number> = {
  ...SPOT_SYMBOL_PRICE_PRECISION,
  ...CONTRACT_SYMBOL_PRICE_PRECISION,
}

export function normalizeMarketSymbol(symbol: string) {
  return String(symbol || '').trim().toUpperCase()
}

export function getSymbolPricePrecision(symbol: string, explicitPrecision?: number | null) {
  if (
    typeof explicitPrecision === 'number' &&
    Number.isInteger(explicitPrecision) &&
    explicitPrecision >= 0
  ) {
    return explicitPrecision
  }
  return SYMBOL_PRICE_PRECISION[normalizeMarketSymbol(symbol)] ?? DEFAULT_PRICE_PRECISION
}

export function getSpotSymbolPricePrecision(symbol: string, explicitPrecision?: number | null) {
  if (
    typeof explicitPrecision === 'number' &&
    Number.isInteger(explicitPrecision) &&
    explicitPrecision >= 0
  ) {
    return explicitPrecision
  }
  return SPOT_SYMBOL_PRICE_PRECISION[normalizeMarketSymbol(symbol)] ?? DEFAULT_PRICE_PRECISION
}

export function formatPrice(value: string | number | null | undefined, precision: number) {
  const num = Number(value)
  if (!Number.isFinite(num)) return '--'
  return num.toLocaleString('en-US', {
    minimumFractionDigits: precision,
    maximumFractionDigits: precision,
  })
}

export function formatRawPrice(value: string | number | null | undefined, precision: number) {
  const num = Number(value)
  if (!Number.isFinite(num)) return ''
  return num.toFixed(precision)
}
