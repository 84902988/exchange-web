import type { ContractOrderListItem, ContractPositionItem } from '@/lib/api/modules/contract';

export type ContractPrivatePositionPageSnapshot = {
  rows: ContractPositionItem[];
  total: number;
  page: number;
  pageSize: number;
};

export type ContractPrivateOrderPageSnapshot = {
  rows: ContractOrderListItem[];
  total: number;
  page: number;
  pageSize: number;
};

type ContractPrivateOrderPageFilters = {
  position_side?: string;
  order_type?: string;
  action?: string;
  created_from?: string;
  created_to?: string;
};

const ACTIVE_ORDER_STATUSES = new Set(['OPEN', 'NEW', 'PENDING', 'PARTIALLY_FILLED']);

function normalizeSymbol(value: string) {
  return String(value || '').trim().toUpperCase();
}

function positiveQuantity(position: ContractPositionItem) {
  const numberValue = Number(String(position.quantity ?? '').replace(/,/g, '').trim());
  return Number.isFinite(numberValue) && numberValue > 0;
}

function normalizeFilterValue(value: unknown) {
  return String(value ?? '').trim().toUpperCase();
}

function parseDateTime(value: unknown) {
  const timestamp = Date.parse(String(value ?? '').trim());
  return Number.isFinite(timestamp) ? timestamp : null;
}

function orderMatchesFilters(order: ContractOrderListItem, filters: ContractPrivateOrderPageFilters) {
  const positionSide = normalizeFilterValue(filters.position_side);
  if (positionSide && normalizeFilterValue(order.position_side) !== positionSide) return false;
  const orderType = normalizeFilterValue(filters.order_type);
  if (orderType && normalizeFilterValue(order.order_type) !== orderType) return false;
  const action = normalizeFilterValue(filters.action);
  if (action && normalizeFilterValue(order.action) !== action) return false;

  const createdAt = parseDateTime(order.created_at);
  const createdFrom = parseDateTime(filters.created_from);
  if (createdFrom !== null && (createdAt === null || createdAt < createdFrom)) return false;
  const createdTo = parseDateTime(filters.created_to);
  if (createdTo !== null && (createdAt === null || createdAt > createdTo)) return false;
  return true;
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

export function buildContractPrivateOrderPageSnapshot({
  orders,
  symbol,
  statusGroup,
  filters = {},
  page,
  pageSize,
}: {
  orders: ContractOrderListItem[];
  symbol: string;
  statusGroup: 'ACTIVE' | 'HISTORY';
  filters?: ContractPrivateOrderPageFilters;
  page: number;
  pageSize: number;
}): ContractPrivateOrderPageSnapshot {
  const normalizedSymbol = normalizeSymbol(symbol);
  const safePage = Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
  const safePageSize = Number.isFinite(pageSize) && pageSize > 0 ? Math.floor(pageSize) : 5;
  const uniqueOrders = new Map<number, ContractOrderListItem>();
  orders.forEach((order) => uniqueOrders.set(Number(order.id), order));
  const matchingOrders = Array.from(uniqueOrders.values())
    .filter((order) => normalizeSymbol(order.symbol) === normalizedSymbol)
    .filter((order) => {
      const isActive = ACTIVE_ORDER_STATUSES.has(normalizeFilterValue(order.status));
      return statusGroup === 'ACTIVE' ? isActive : !isActive;
    })
    .filter((order) => orderMatchesFilters(order, filters))
    .sort((left, right) => {
      const leftCreatedAt = parseDateTime(left.created_at) ?? 0;
      const rightCreatedAt = parseDateTime(right.created_at) ?? 0;
      return rightCreatedAt - leftCreatedAt || Number(right.id) - Number(left.id);
    });
  const offset = (safePage - 1) * safePageSize;
  return {
    rows: matchingOrders.slice(offset, offset + safePageSize),
    total: matchingOrders.length,
    page: safePage,
    pageSize: safePageSize,
  };
}
