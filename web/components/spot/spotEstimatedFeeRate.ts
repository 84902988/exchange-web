import type { SpotExecutableDepthState, SpotOrderSide, SpotOrderType } from './spotExecutableDepth';

export type SpotEstimatedFeeRole = 'MAKER' | 'TAKER' | 'CONSERVATIVE';

export type SpotEstimatedFeeRateResolution = {
  rate: number | null;
  role: SpotEstimatedFeeRole;
  reason:
    | 'MARKET_ORDER'
    | 'DEALER_LIMIT'
    | 'CROSSING_LIMIT'
    | 'RESTING_LIMIT'
    | 'UNRELIABLE_EXECUTION_EVIDENCE';
};

type SpotEstimatedFeeDepthEvidence = Pick<
  SpotExecutableDepthState,
  | 'isCurrentSymbol'
  | 'freshnessKind'
  | 'hasFreshBid'
  | 'hasFreshAsk'
  | 'buyReferencePrice'
  | 'sellReferencePrice'
>;

type ResolveSpotEstimatedFeeRateInput = {
  orderType: SpotOrderType;
  side: SpotOrderSide;
  limitPrice: string | number | null | undefined;
  marketMode: string | null | undefined;
  makerFeeRate: string | number | null | undefined;
  takerFeeRate: string | number | null | undefined;
  executableDepth: SpotEstimatedFeeDepthEvidence;
};

function parseRate(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
}

function conservativeRate(makerRate: number | null, takerRate: number | null): number | null {
  if (makerRate === null) return takerRate;
  if (takerRate === null) return makerRate;
  return Math.max(makerRate, takerRate);
}

function preferredRate(preferred: number | null, fallback: number | null): number | null {
  return preferred ?? fallback;
}

export function resolveSpotEstimatedFeeRate({
  orderType,
  side,
  limitPrice,
  marketMode,
  makerFeeRate,
  takerFeeRate,
  executableDepth,
}: ResolveSpotEstimatedFeeRateInput): SpotEstimatedFeeRateResolution {
  const makerRate = parseRate(makerFeeRate);
  const takerRate = parseRate(takerFeeRate);

  if (orderType === 'market') {
    return {
      rate: preferredRate(takerRate, makerRate),
      role: 'TAKER',
      reason: 'MARKET_ORDER',
    };
  }

  const normalizedMarketMode = String(marketMode || '').trim().toUpperCase();
  if (normalizedMarketMode === 'DEALER') {
    return {
      rate: preferredRate(makerRate, takerRate),
      role: 'MAKER',
      reason: 'DEALER_LIMIT',
    };
  }

  const price = Number(limitPrice);
  const opposingPrice = Number(
    side === 'buy'
      ? executableDepth.buyReferencePrice
      : executableDepth.sellReferencePrice,
  );
  const hasReliableExecutionEvidence =
    normalizedMarketMode === 'INTERNAL' &&
    executableDepth.isCurrentSymbol &&
    executableDepth.freshnessKind === 'fresh' &&
    (side === 'buy' ? executableDepth.hasFreshAsk : executableDepth.hasFreshBid) &&
    Number.isFinite(price) &&
    price > 0 &&
    Number.isFinite(opposingPrice) &&
    opposingPrice > 0;

  if (!hasReliableExecutionEvidence) {
    return {
      rate: conservativeRate(makerRate, takerRate),
      role: 'CONSERVATIVE',
      reason: 'UNRELIABLE_EXECUTION_EVIDENCE',
    };
  }

  const crossesBook = side === 'buy' ? price >= opposingPrice : price <= opposingPrice;
  if (crossesBook) {
    return {
      rate: preferredRate(takerRate, makerRate),
      role: 'TAKER',
      reason: 'CROSSING_LIMIT',
    };
  }

  return {
    rate: preferredRate(makerRate, takerRate),
    role: 'MAKER',
    reason: 'RESTING_LIMIT',
  };
}
