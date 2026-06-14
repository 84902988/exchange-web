'use client';

export type PriceDirection = 'up' | 'down' | 'flat';
export type RealtimePriceDirection = PriceDirection;

type TickerLike = unknown;

function parsePrice(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const normalized = String(value).replace(/,/g, '').trim();
  if (!normalized || normalized === '--') return null;
  const numberValue = Number(normalized);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function pickFirstNumber(record: TickerLike, keys: string[]): number | null {
  if (!record || typeof record !== 'object') return null;
  const source = record as Record<string, unknown>;

  for (const key of keys) {
    const value = parsePrice(source[key]);
    if (value !== null) return value;
  }

  return null;
}

export function getTicker24hDirection(
  ticker: TickerLike,
  latestPrice?: string | number | null,
): PriceDirection {
  const lastPrice =
    parsePrice(latestPrice) ??
    pickFirstNumber(ticker, ['last_price', 'lastPrice', 'price', 'last', 'close']);
  const open24h = pickFirstNumber(ticker, ['open_24h', 'open24h', 'open_24', 'open24']);

  if (lastPrice !== null && open24h !== null && open24h > 0) {
    if (lastPrice > open24h) return 'up';
    if (lastPrice < open24h) return 'down';
    return 'flat';
  }

  const changeAmount = pickFirstNumber(ticker, [
    'price_change_24h',
    'priceChange24h',
    'change_24h',
    'change24h',
  ]);
  if (changeAmount !== null) {
    if (changeAmount > 0) return 'up';
    if (changeAmount < 0) return 'down';
    return 'flat';
  }

  const changePercent = pickFirstNumber(ticker, [
    'price_change_percent_24h',
    'price_change_percent',
    'priceChangePercent',
    'change_percent_24h',
    'changePercent24h',
    'changePercent',
    'change_percent',
    'percent_change_24h',
    'percentChange24h',
  ]);
  if (changePercent !== null) {
    if (changePercent > 0) return 'up';
    if (changePercent < 0) return 'down';
  }

  return 'flat';
}

export function getTickerDirectionTextClass(direction: PriceDirection): string {
  if (direction === 'up') return 'text-[#00c087]';
  if (direction === 'down') return 'text-[#f6465d]';
  return 'text-white';
}

export function getTickerDirectionFlashClass(direction: PriceDirection): string {
  if (direction === 'up') return 'bg-[#00c087]/10';
  if (direction === 'down') return 'bg-[#f6465d]/10';
  return '';
}

export function getRealtimePriceDirection(
  latestPrice: string | number | null | undefined,
  previousPrice: string | number | null | undefined,
  fallback: RealtimePriceDirection = 'flat',
): RealtimePriceDirection {
  const latest = parsePrice(latestPrice);
  const previous = parsePrice(previousPrice);

  if (latest === null || previous === null) return fallback;
  if (latest > previous) return 'up';
  if (latest < previous) return 'down';
  return fallback;
}
