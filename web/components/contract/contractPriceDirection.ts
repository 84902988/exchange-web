export type ContractPriceDirection = 'up' | 'down' | 'flat';

export type ContractPriceDirectionState = {
  symbol: string;
  lastPrice: number | null;
  direction: ContractPriceDirection;
};

export function createContractPriceDirectionState(
  symbolValue = '',
): ContractPriceDirectionState {
  return {
    symbol: String(symbolValue || '').trim().toUpperCase(),
    lastPrice: null,
    direction: 'flat',
  };
}

function positivePrice(value: unknown): number | null {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

export function advanceContractPriceDirection(
  state: ContractPriceDirectionState,
  input: { symbol: string; price: unknown },
): ContractPriceDirectionState {
  const symbol = String(input.symbol || '').trim().toUpperCase();
  const price = positivePrice(input.price);

  if (!symbol || price === null) return createContractPriceDirectionState(symbol);
  if (state.symbol !== symbol || state.lastPrice === null) {
    return { symbol, lastPrice: price, direction: 'flat' };
  }
  if (price === state.lastPrice) return state;

  return {
    symbol,
    lastPrice: price,
    direction: price > state.lastPrice ? 'up' : 'down',
  };
}
