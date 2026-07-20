import {
  getContractQuoteDisplayStatus,
  type ContractQuote,
} from '@/lib/api/modules/contract';

export type LiveContractPositionValuation = {
  price: number;
  unrealizedPnl: number;
  roe: number | null;
};

type ResolveLiveContractPositionValuationInput = {
  positionSymbol: string;
  currentSymbol: string;
  side: string | null | undefined;
  quantity: string | number | null | undefined;
  entryPrice: string | number | null | undefined;
  marginAmount: string | number | null | undefined;
  quote?: ContractQuote | null;
  liveBestBid?: string | number | null;
  liveBestAsk?: string | number | null;
  liveMarketUsable: boolean;
  useBboMidpoint: boolean;
};

function normalizeContractSymbol(value: string | null | undefined) {
  const normalized = String(value || '').trim().toUpperCase();
  if (!normalized) return '';
  return normalized.endsWith('_PERP') ? normalized : `${normalized}_PERP`;
}

function toPositiveNumber(value: string | number | null | undefined) {
  if (value === null || value === undefined || value === '') return 0;
  const parsed = Number(typeof value === 'string' ? value.replace(/,/g, '').trim() : value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function resolveLiveQuotePrice(
  quote: ContractQuote,
  liveBestBid: string | number | null | undefined,
  liveBestAsk: string | number | null | undefined,
  useBboMidpoint: boolean,
) {
  const authoritativeBid = toPositiveNumber(liveBestBid);
  const authoritativeAsk = toPositiveNumber(liveBestAsk);
  if (authoritativeBid > 0 && authoritativeAsk >= authoritativeBid) {
    return (authoritativeBid + authoritativeAsk) / 2;
  }

  const bid = toPositiveNumber(quote.bid_price ?? quote.best_bid ?? quote.bid);
  const ask = toPositiveNumber(quote.ask_price ?? quote.best_ask ?? quote.ask);
  const hasValidBbo = bid > 0 && ask > 0 && ask >= bid;
  const midpoint = hasValidBbo ? (bid + ask) / 2 : 0;
  const markPrice = toPositiveNumber(quote.mark_price);

  if (useBboMidpoint) return midpoint;
  return markPrice || midpoint;
}

export function resolveLiveContractPositionValuation({
  positionSymbol,
  currentSymbol,
  side,
  quantity,
  entryPrice,
  marginAmount,
  quote,
  liveBestBid,
  liveBestAsk,
  liveMarketUsable,
  useBboMidpoint,
}: ResolveLiveContractPositionValuationInput): LiveContractPositionValuation | null {
  const normalizedCurrentSymbol = normalizeContractSymbol(currentSymbol);
  if (
    !quote ||
    !liveMarketUsable ||
    !normalizedCurrentSymbol ||
    normalizeContractSymbol(positionSymbol) !== normalizedCurrentSymbol ||
    normalizeContractSymbol(quote.symbol) !== normalizedCurrentSymbol
  ) {
    return null;
  }

  const freshness = String(quote.quote_freshness || '').trim().toUpperCase();
  if (
    freshness !== 'LIVE' ||
    quote.executable !== true ||
    quote.stale === true ||
    getContractQuoteDisplayStatus(quote) !== 'LIVE'
  ) {
    return null;
  }

  const price = resolveLiveQuotePrice(quote, liveBestBid, liveBestAsk, useBboMidpoint);
  const normalizedSide = String(side || '').trim().toUpperCase();
  const positionQuantity = toPositiveNumber(quantity);
  const positionEntryPrice = toPositiveNumber(entryPrice);
  if (
    price <= 0 ||
    positionQuantity <= 0 ||
    positionEntryPrice <= 0 ||
    (normalizedSide !== 'LONG' && normalizedSide !== 'SHORT')
  ) {
    return null;
  }

  const unrealizedPnl = normalizedSide === 'LONG'
    ? (price - positionEntryPrice) * positionQuantity
    : (positionEntryPrice - price) * positionQuantity;
  const margin = toPositiveNumber(marginAmount);

  return {
    price,
    unrealizedPnl,
    roe: margin > 0 ? (unrealizedPnl / margin) * 100 : null,
  };
}
