export const DEFAULT_STOCK_CONTRACT_SYMBOL = 'NVDAUSDT_PERP'

const CRYPTO_CONTRACT_BASES = new Set([
  'BTC',
  'ETH',
  'BNB',
  'SOL',
  'XRP',
  'DOGE',
  'ADA',
  'AVAX',
  'MATIC',
  'DOT',
  'LTC',
  'BCH',
  'LINK',
  'TRX',
  'TON',
])

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
  if (!normalized.endsWith('USDT_PERP')) return false
  const base = normalized.replace(/USDT_PERP$/, '')
  return !CRYPTO_CONTRACT_BASES.has(base)
}
