import type {
  ContractDepthLevel,
  ContractDepthMode,
} from '@/lib/api/modules/contract';

export type ContractOrderBookDisplayMode = 'FULL' | 'BUY' | 'SELL';

export type ContractOrderBookRow = {
  rawPrice: string;
  price: number;
  amount: number;
  total: number;
  widthPercent: number;
};

export type ContractOrderBookRowSlot = ContractOrderBookRow | null;

export type ContractOrderBookDepthRatio = {
  buy: number;
  sell: number;
};

export const CONTRACT_ORDERBOOK_LEVEL_LIMIT = 9;
export const CONTRACT_ORDERBOOK_SINGLE_SIDE_LEVEL_LIMIT = CONTRACT_ORDERBOOK_LEVEL_LIMIT * 2;

function normalizeToken(value?: string | null) {
  return String(value || '').trim().toUpperCase();
}

function toFiniteNumber(value?: string | number | null) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function normalizeLevels(
  levels: ContractDepthLevel[],
  side: 'ask' | 'bid',
  limit: number,
) {
  return levels
    .map((level) => ({
      rawPrice: String(level.price),
      price: toFiniteNumber(level.price),
      amount: toFiniteNumber(level.amount),
    }))
    .filter((level): level is { rawPrice: string; price: number; amount: number } => (
      level.price !== null
      && level.price > 0
      && level.amount !== null
      && level.amount >= 0
    ))
    .sort((left, right) => (
      side === 'ask' ? left.price - right.price : right.price - left.price
    ))
    .slice(0, limit);
}

export function normalizeContractDepthMode(mode?: ContractDepthMode | null) {
  return normalizeToken(mode);
}

export function getContractDepthModeLabel(mode?: ContractDepthMode | null) {
  const normalized = normalizeContractDepthMode(mode);
  if (normalized === 'BBO_ONLY') return '\u6a21\u62df\u76d8\u53e3';
  if (normalized === 'SYNTHETIC_FROM_BBO') return '\u4ec5\u6700\u4f73\u4e70\u5356\u4ef7';
  return null;
}

export function getContractOrderBookLevelLimit(
  displayMode: ContractOrderBookDisplayMode,
) {
  return displayMode === 'FULL'
    ? CONTRACT_ORDERBOOK_LEVEL_LIMIT
    : CONTRACT_ORDERBOOK_SINGLE_SIDE_LEVEL_LIMIT;
}

export function getContractOrderBookDataLimit(
  displayMode: ContractOrderBookDisplayMode,
  depthMode?: ContractDepthMode | null,
) {
  if (normalizeContractDepthMode(depthMode) === 'BBO_ONLY') return 1;
  return getContractOrderBookLevelLimit(displayMode);
}

export function buildContractOrderBookRows(
  levels: ContractDepthLevel[],
  side: 'ask' | 'bid',
  limit: number,
): ContractOrderBookRow[] {
  const normalized = normalizeLevels(levels, side, limit);
  const maxAmount = Math.max(...normalized.map((level) => level.amount), 1);
  let total = 0;
  const rows = normalized.map((level) => {
    total += level.amount;
    return {
      ...level,
      total,
      widthPercent: Math.min((level.amount / maxAmount) * 100, 100),
    };
  });

  return side === 'ask' ? rows.reverse() : rows;
}

export function padContractOrderBookRows(
  rows: ContractOrderBookRow[],
  align: 'top' | 'bottom',
  limit: number,
): ContractOrderBookRowSlot[] {
  const visibleRows = rows.slice(0, limit);
  const placeholders = Array<ContractOrderBookRowSlot>(
    Math.max(limit - visibleRows.length, 0),
  ).fill(null);
  return align === 'bottom'
    ? [...placeholders, ...visibleRows]
    : [...visibleRows, ...placeholders];
}

function sumPositiveAmount(levels: Array<{ amount: string | number }>) {
  return levels.reduce((sum, level) => {
    const amount = Number(level.amount);
    return Number.isFinite(amount) && amount > 0 ? sum + amount : sum;
  }, 0);
}

export function calculateContractOrderBookDepthRatio({
  bids,
  asks,
  displayMode,
  depthMode,
}: {
  bids: ContractDepthLevel[];
  asks: ContractDepthLevel[];
  displayMode: ContractOrderBookDisplayMode;
  depthMode?: ContractDepthMode | null;
}): ContractOrderBookDepthRatio | null {
  if (displayMode !== 'FULL') return null;
  if (normalizeContractDepthMode(depthMode) !== 'FULL_DEPTH') return null;

  const normalizedBids = normalizeLevels(bids, 'bid', CONTRACT_ORDERBOOK_LEVEL_LIMIT);
  const normalizedAsks = normalizeLevels(asks, 'ask', CONTRACT_ORDERBOOK_LEVEL_LIMIT);

  // One level per side is only BBO evidence, even if an upstream mode is mislabeled.
  if (normalizedBids.length < 2 || normalizedAsks.length < 2) return null;

  const bidVolume = sumPositiveAmount(normalizedBids);
  const askVolume = sumPositiveAmount(normalizedAsks);
  const totalVolume = bidVolume + askVolume;
  if (!Number.isFinite(totalVolume) || totalVolume <= 0) return null;

  return {
    buy: (bidVolume / totalVolume) * 100,
    sell: (askVolume / totalVolume) * 100,
  };
}

export function formatContractOrderBookAmount(value: number) {
  if (!Number.isFinite(value)) return '--';
  if (value === 0) return '0';
  if (Math.abs(value) < 0.001) {
    return value.toFixed(6).replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1');
  }
  return value.toFixed(3);
}
