import type {
  ContractPositionItem,
  ContractQuote,
  ContractTpSlTriggerPriceType,
} from '@/lib/api/modules/contract';

function positiveNumber(value: unknown): number | null {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : null;
}

function normalizeSymbol(value: unknown) {
  return String(value ?? '').trim().toUpperCase();
}

export function resolveContractTpSlQuoteReference(
  quote: Pick<ContractQuote, 'mark_price' | 'last_price'> | null | undefined,
  triggerPriceType: ContractTpSlTriggerPriceType,
  fallback?: string | number | null,
) {
  const preferred = triggerPriceType === 'LAST_PRICE' ? quote?.last_price : quote?.mark_price;
  if (positiveNumber(preferred) !== null) return preferred ?? null;
  if (positiveNumber(quote?.mark_price) !== null) return quote?.mark_price ?? null;
  return fallback ?? null;
}

export function resolveContractTpSlEditorReference({
  draftSymbol,
  positionIds,
  currentSymbol,
  positions,
  quote,
  triggerPriceType,
  fallback,
}: {
  draftSymbol: string;
  positionIds: number[];
  currentSymbol: string;
  positions: ContractPositionItem[];
  quote: Pick<ContractQuote, 'mark_price' | 'last_price'> | null | undefined;
  triggerPriceType: ContractTpSlTriggerPriceType;
  fallback: string | number | null;
}) {
  const positionIdSet = new Set(positionIds.map(Number));
  const latestPosition = positions.find((position) => (
    positionIdSet.has(Number(position.id))
    && normalizeSymbol(position.symbol) === normalizeSymbol(draftSymbol)
    && String(position.status || '').trim().toUpperCase() === 'OPEN'
  ));
  const latestPositionMark = positiveNumber(latestPosition?.mark_price) !== null
    ? latestPosition?.mark_price ?? null
    : fallback;

  if (normalizeSymbol(draftSymbol) !== normalizeSymbol(currentSymbol)) {
    return latestPositionMark;
  }
  return resolveContractTpSlQuoteReference(quote, triggerPriceType, latestPositionMark);
}
