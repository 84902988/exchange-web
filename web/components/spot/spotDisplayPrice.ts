import type { SpotMarketTradeItem } from '@/lib/api/modules/spot';

export type SpotDisplayPriceDomain = 'trades' | 'ticker' | 'kline' | 'unavailable';

export type SpotDisplayPrice = {
  symbol: string;
  price: string | number | null;
  eventTimeMs: number | null;
  receivedAtMs: number | null;
  sourceDomain: SpotDisplayPriceDomain;
  source: string;
  provider: string | null;
  freshness: string;
  isRealTrade: boolean;
};

export type SpotDisplayPriceCandidate = Omit<SpotDisplayPrice, 'sourceDomain' | 'isRealTrade'>;

export type SpotNativeCandleDisplayPrice = SpotDisplayPriceCandidate & {
  interval: string;
};

type SelectSpotDisplayPriceInput = {
  symbol: string;
  trade?: SpotDisplayPriceCandidate | null;
  ticker?: SpotDisplayPriceCandidate | null;
  kline?: SpotDisplayPriceCandidate | null;
};

const USABLE_DISPLAY_FRESHNESS = new Set([
  'LIVE',
  'RECENT',
  'FRESH',
  'CURRENT',
  'CACHED',
  'INTERNAL',
]);

function normalizeText(value: unknown, fallback: string): string {
  const normalized = String(value ?? '').trim().toUpperCase();
  return normalized || fallback;
}

function normalizeTime(value: unknown): number | null {
  const time = Number(value);
  return Number.isFinite(time) && time > 0 ? time : null;
}

function isUsableCandidate(
  candidate: SpotDisplayPriceCandidate | null | undefined,
  symbol: string,
): candidate is SpotDisplayPriceCandidate {
  if (!candidate || normalizeText(candidate.symbol, '') !== symbol) return false;
  const price = Number(candidate.price);
  if (!Number.isFinite(price) || price <= 0) return false;
  return USABLE_DISPLAY_FRESHNESS.has(normalizeText(candidate.freshness, 'UNKNOWN'));
}

function selectCandidate(
  candidate: SpotDisplayPriceCandidate,
  sourceDomain: Exclude<SpotDisplayPriceDomain, 'unavailable'>,
): SpotDisplayPrice {
  return {
    ...candidate,
    symbol: normalizeText(candidate.symbol, ''),
    eventTimeMs: normalizeTime(candidate.eventTimeMs),
    receivedAtMs: normalizeTime(candidate.receivedAtMs),
    sourceDomain,
    source: normalizeText(candidate.source, 'UNKNOWN'),
    provider: normalizeText(candidate.provider, '') || null,
    freshness: normalizeText(candidate.freshness, 'UNKNOWN'),
    isRealTrade: sourceDomain === 'trades',
  };
}

export function unavailableSpotDisplayPrice(symbol: string): SpotDisplayPrice {
  return {
    symbol: normalizeText(symbol, ''),
    price: null,
    eventTimeMs: null,
    receivedAtMs: null,
    sourceDomain: 'unavailable',
    source: 'MISSING',
    provider: null,
    freshness: 'MISSING',
    isRealTrade: false,
  };
}

export function selectSpotDisplayPrice({
  symbol,
  trade,
  ticker,
  kline,
}: SelectSpotDisplayPriceInput): SpotDisplayPrice {
  const normalizedSymbol = normalizeText(symbol, '');
  if (isUsableCandidate(trade, normalizedSymbol)) return selectCandidate(trade, 'trades');
  if (isUsableCandidate(ticker, normalizedSymbol)) return selectCandidate(ticker, 'ticker');
  if (isUsableCandidate(kline, normalizedSymbol)) return selectCandidate(kline, 'kline');
  return unavailableSpotDisplayPrice(normalizedSymbol);
}

export function sortSpotTradesLatestFirst(
  trades: SpotMarketTradeItem[],
  extractEventTimeMs: (trade: SpotMarketTradeItem) => number | null,
): SpotMarketTradeItem[] {
  return trades
    .map((trade, index) => ({ trade, index, eventTimeMs: extractEventTimeMs(trade) }))
    .sort((left, right) => {
      if (left.eventTimeMs !== null && right.eventTimeMs !== null) {
        return right.eventTimeMs - left.eventTimeMs || left.index - right.index;
      }
      if (left.eventTimeMs !== null) return -1;
      if (right.eventTimeMs !== null) return 1;
      return left.index - right.index;
    })
    .map(({ trade }) => trade);
}

export function shouldShowSpotDisplayPriceOverlay(displayPrice: SpotDisplayPrice): boolean {
  return (
    displayPrice.sourceDomain !== 'unavailable' &&
    Number.isFinite(Number(displayPrice.price)) &&
    Number(displayPrice.price) > 0 &&
    USABLE_DISPLAY_FRESHNESS.has(normalizeText(displayPrice.freshness, 'UNKNOWN'))
  );
}
