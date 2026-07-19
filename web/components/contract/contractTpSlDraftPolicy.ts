import type { ContractPositionSide } from '@/lib/api/modules/contract';
import { formatRawPrice } from '@/lib/marketPrecision';

export type ContractTpSlDraftFieldOrigin = 'EMPTY' | 'EXISTING' | 'RECOMMENDED' | 'USER';

export type ContractTpSlDraftField = {
  value: string;
  origin: ContractTpSlDraftFieldOrigin;
};

export type ContractTpSlDraftPrices = {
  takeProfit: ContractTpSlDraftField;
  stopLoss: ContractTpSlDraftField;
};

export type ContractTpSlValidationError =
  | 'LONG_TP_MUST_BE_ABOVE_REFERENCE'
  | 'LONG_SL_MUST_BE_BELOW_REFERENCE'
  | 'SHORT_TP_MUST_BE_BELOW_REFERENCE'
  | 'SHORT_SL_MUST_BE_ABOVE_REFERENCE';

const DEFAULT_OFFSET_RATE = 0.002;

function toPositiveNumber(value: string | number | null | undefined) {
  const numberValue = Number(String(value ?? '').replace(/,/g, '').trim());
  return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : null;
}

function isValidForSide(
  side: ContractPositionSide,
  kind: 'TAKE_PROFIT' | 'STOP_LOSS',
  price: number | null,
  referencePrice: number | null,
) {
  if (price === null || referencePrice === null) return false;
  if (side === 'LONG') {
    return kind === 'TAKE_PROFIT' ? price > referencePrice : price < referencePrice;
  }
  return kind === 'TAKE_PROFIT' ? price < referencePrice : price > referencePrice;
}

function recommendedPrice(
  side: ContractPositionSide,
  kind: 'TAKE_PROFIT' | 'STOP_LOSS',
  referencePrice: number,
  pricePrecision: number,
) {
  const direction = side === 'LONG'
    ? kind === 'TAKE_PROFIT' ? 1 : -1
    : kind === 'TAKE_PROFIT' ? -1 : 1;
  return formatRawPrice(referencePrice * (1 + direction * DEFAULT_OFFSET_RATE), pricePrecision);
}

function initialField(
  side: ContractPositionSide,
  kind: 'TAKE_PROFIT' | 'STOP_LOSS',
  currentValue: string | number | null | undefined,
  referencePrice: number | null,
  pricePrecision: number,
): ContractTpSlDraftField {
  const currentPrice = toPositiveNumber(currentValue);
  if (isValidForSide(side, kind, currentPrice, referencePrice)) {
    return {
      value: formatRawPrice(currentPrice as number, pricePrecision),
      origin: 'EXISTING',
    };
  }
  if (referencePrice !== null) {
    return {
      value: recommendedPrice(side, kind, referencePrice, pricePrecision),
      origin: 'RECOMMENDED',
    };
  }
  return {
    value: currentPrice === null ? '' : formatRawPrice(currentPrice, pricePrecision),
    origin: currentPrice === null ? 'EMPTY' : 'EXISTING',
  };
}

export function buildContractTpSlDraftPrices({
  side,
  referencePrice,
  entryPrice,
  takeProfitPrice,
  stopLossPrice,
  pricePrecision,
}: {
  side: ContractPositionSide;
  referencePrice: string | number | null;
  entryPrice: string | number | null | undefined;
  takeProfitPrice: string | number | null | undefined;
  stopLossPrice: string | number | null | undefined;
  pricePrecision: number;
}): ContractTpSlDraftPrices {
  const resolvedReferencePrice = toPositiveNumber(referencePrice) ?? toPositiveNumber(entryPrice);
  return {
    takeProfit: initialField(
      side,
      'TAKE_PROFIT',
      takeProfitPrice,
      resolvedReferencePrice,
      pricePrecision,
    ),
    stopLoss: initialField(
      side,
      'STOP_LOSS',
      stopLossPrice,
      resolvedReferencePrice,
      pricePrecision,
    ),
  };
}

export function refreshContractTpSlRecommendations({
  side,
  referencePrice,
  prices,
  pricePrecision,
}: {
  side: ContractPositionSide;
  referencePrice: string | number | null;
  prices: ContractTpSlDraftPrices;
  pricePrecision: number;
}): ContractTpSlDraftPrices {
  const resolvedReferencePrice = toPositiveNumber(referencePrice);
  if (resolvedReferencePrice === null) return prices;

  const refreshField = (
    field: ContractTpSlDraftField,
    kind: 'TAKE_PROFIT' | 'STOP_LOSS',
  ): ContractTpSlDraftField => {
    if (field.origin !== 'RECOMMENDED') return field;
    if (isValidForSide(side, kind, toPositiveNumber(field.value), resolvedReferencePrice)) return field;
    return {
      value: recommendedPrice(side, kind, resolvedReferencePrice, pricePrecision),
      origin: 'RECOMMENDED',
    };
  };

  return {
    takeProfit: refreshField(prices.takeProfit, 'TAKE_PROFIT'),
    stopLoss: refreshField(prices.stopLoss, 'STOP_LOSS'),
  };
}

export function validateContractTpSlPrices({
  side,
  referencePrice,
  takeProfitPrice,
  stopLossPrice,
}: {
  side: ContractPositionSide;
  referencePrice: string | number;
  takeProfitPrice: string | number | null;
  stopLossPrice: string | number | null;
}): ContractTpSlValidationError | null {
  const reference = toPositiveNumber(referencePrice);
  const takeProfit = takeProfitPrice === null ? null : toPositiveNumber(takeProfitPrice);
  const stopLoss = stopLossPrice === null ? null : toPositiveNumber(stopLossPrice);
  if (reference === null) return null;

  if (side === 'LONG') {
    if (takeProfit !== null && takeProfit <= reference) return 'LONG_TP_MUST_BE_ABOVE_REFERENCE';
    if (stopLoss !== null && stopLoss >= reference) return 'LONG_SL_MUST_BE_BELOW_REFERENCE';
    return null;
  }
  if (takeProfit !== null && takeProfit >= reference) return 'SHORT_TP_MUST_BE_BELOW_REFERENCE';
  if (stopLoss !== null && stopLoss <= reference) return 'SHORT_SL_MUST_BE_ABOVE_REFERENCE';
  return null;
}
