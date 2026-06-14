const SPOT_QUOTE_SUFFIXES = ['USDT', 'USDC', 'BTC', 'ETH'];

export function formatSpotDisplaySymbol(symbol: string): string {
  const normalized = String(symbol || '').trim().toUpperCase();
  if (!normalized) return '';

  if (normalized.includes('/')) return normalized;

  for (const quote of SPOT_QUOTE_SUFFIXES) {
    if (normalized.endsWith(quote) && normalized.length > quote.length) {
      return `${normalized.slice(0, -quote.length)}/${quote}`;
    }
  }

  return normalized;
}
