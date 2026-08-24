import type { ContractPositionItem } from '../../api/contract';
import type { KlineReferencePriceLine } from '../trade/MobileKlineChart';

type LivePositionMarketInput = {
  currentSymbol: string;
  marketSymbol: string | null | undefined;
  liveBestBid: number | null | undefined;
  liveBestAsk: number | null | undefined;
  liveMarketUsable: boolean;
};

type PositionLineLabels = {
  entry: string;
  takeProfit: string;
  stopLoss: string;
};

function normalizeContractSymbol(value: string | null | undefined) {
  const normalized = String(value || '').trim().toUpperCase();
  if (!normalized) return '';
  return normalized.endsWith('_PERP') ? normalized : `${normalized}_PERP`;
}

function positiveNumber(value: string | number | null | undefined) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(
    typeof value === 'string' ? value.replace(/,/g, '').trim() : value,
  );
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function resolveLiveContractPositionPrice({
  currentSymbol,
  marketSymbol,
  liveBestBid,
  liveBestAsk,
  liveMarketUsable,
}: LivePositionMarketInput) {
  const normalizedCurrentSymbol = normalizeContractSymbol(currentSymbol);
  if (
    !liveMarketUsable ||
    !normalizedCurrentSymbol ||
    normalizeContractSymbol(marketSymbol) !== normalizedCurrentSymbol
  ) {
    return null;
  }

  const bid = positiveNumber(liveBestBid);
  const ask = positiveNumber(liveBestAsk);
  if (bid === null || ask === null || ask < bid) return null;
  return (bid + ask) / 2;
}

export function applyLiveContractPositionValuations(
  positions: readonly ContractPositionItem[],
  currentSymbol: string,
  livePrice: number | null,
) {
  const normalizedCurrentSymbol = normalizeContractSymbol(currentSymbol);
  if (!normalizedCurrentSymbol || livePrice === null || livePrice <= 0) {
    return positions as ContractPositionItem[];
  }

  return positions.map(position => {
    if (normalizeContractSymbol(position.symbol) !== normalizedCurrentSymbol) {
      return position;
    }
    const quantity = positiveNumber(position.quantity);
    const entryPrice = positiveNumber(position.entryPrice);
    if (quantity === null || entryPrice === null) return position;

    const unrealizedPnl =
      position.side === 'SHORT'
        ? (entryPrice - livePrice) * quantity
        : (livePrice - entryPrice) * quantity;
    return {
      ...position,
      markPrice: String(livePrice),
      unrealizedPnl: String(unrealizedPnl),
    };
  });
}

export function buildContractPositionPriceLines(
  positions: readonly ContractPositionItem[],
  currentSymbol: string,
  labels: PositionLineLabels,
): KlineReferencePriceLine[] {
  const normalizedCurrentSymbol = normalizeContractSymbol(currentSymbol);
  if (!normalizedCurrentSymbol) return [];

  const eligiblePositions = positions
    .filter(
      position =>
        normalizeContractSymbol(position.symbol) === normalizedCurrentSymbol &&
        position.status.trim().toUpperCase() === 'OPEN' &&
        positiveNumber(position.quantity) !== null,
    )
    .sort((left, right) =>
      left.id.localeCompare(right.id, undefined, {numeric: true}),
    );

  return eligiblePositions.flatMap((position, positionIndex) => {
    const sideLabel = position.side === 'SHORT' ? 'SELL' : 'BUY';
    const suffix =
      eligiblePositions.length > 1 ? ` #${positionIndex + 1}` : '';
    const lines: KlineReferencePriceLine[] = [];
    const entryPrice = positiveNumber(position.entryPrice);
    const takeProfitPrice = positiveNumber(position.takeProfitPrice);
    const stopLossPrice = positiveNumber(position.stopLossPrice);

    if (entryPrice !== null) {
      lines.push({
        key: `${position.id}:ENTRY`,
        kind: 'ENTRY',
        label: `${sideLabel} ${labels.entry}${suffix}`,
        price: entryPrice,
      });
    }
    if (takeProfitPrice !== null) {
      lines.push({
        key: `${position.id}:TP`,
        kind: 'TAKE_PROFIT',
        label: `${sideLabel} ${labels.takeProfit}${suffix}`,
        price: takeProfitPrice,
      });
    }
    if (stopLossPrice !== null) {
      lines.push({
        key: `${position.id}:SL`,
        kind: 'STOP_LOSS',
        label: `${sideLabel} ${labels.stopLoss}${suffix}`,
        price: stopLossPrice,
      });
    }
    return lines;
  });
}
