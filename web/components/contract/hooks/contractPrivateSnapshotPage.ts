import type { ContractPositionItem } from '@/lib/api/modules/contract';

export type ContractPrivatePositionPageSnapshot = {
  rows: ContractPositionItem[];
  total: number;
  page: number;
  pageSize: number;
};

function normalizeSymbol(value: string) {
  return String(value || '').trim().toUpperCase();
}

function positiveQuantity(position: ContractPositionItem) {
  const numberValue = Number(String(position.quantity ?? '').replace(/,/g, '').trim());
  return Number.isFinite(numberValue) && numberValue > 0;
}

export function buildContractPrivatePositionPageSnapshot({
  positions,
  symbol,
  page,
  pageSize,
}: {
  positions: ContractPositionItem[];
  symbol: string;
  page: number;
  pageSize: number;
}): ContractPrivatePositionPageSnapshot {
  const normalizedSymbol = normalizeSymbol(symbol);
  const safePage = Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
  const safePageSize = Number.isFinite(pageSize) && pageSize > 0 ? Math.floor(pageSize) : 5;
  const openPositions = positions.filter((position) => (
    normalizeSymbol(position.symbol) === normalizedSymbol
    && String(position.status || '').trim().toUpperCase() === 'OPEN'
    && positiveQuantity(position)
  ));
  const offset = (safePage - 1) * safePageSize;
  return {
    rows: openPositions.slice(offset, offset + safePageSize),
    total: openPositions.length,
    page: safePage,
    pageSize: safePageSize,
  };
}
