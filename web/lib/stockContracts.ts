export const DEFAULT_STOCK_CONTRACT_SYMBOL = 'NVDAUSDT_PERP'

export function normalizeStockBaseSymbol(value?: string | null): string {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/USDT$/, '')
    .replace(/ON$/, '')
}

export function toStockContractSymbol(value?: string | null): string {
  const base = normalizeStockBaseSymbol(value)
  return base ? `${base}USDT_PERP` : ''
}

export function stockContractToMarketSymbol(symbol: string): string {
  return String(symbol || '').trim().toUpperCase().replace(/_?PERP$/, '')
}

export function isMockStockContractSymbol(symbol?: string | null): boolean {
  const normalized = String(symbol || '').trim().toUpperCase()
  return normalized.endsWith('USDT_PERP') && normalized !== 'BTCUSDT_PERP'
}

