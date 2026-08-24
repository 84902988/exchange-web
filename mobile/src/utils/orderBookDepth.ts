export type OrderBookDepthLevel = {
  price: number;
  amount: number;
};

export function aggregateOrderBookLevels<T extends OrderBookDepthLevel>(
  levels: T[],
  side: 'ask' | 'bid',
  step: number,
): OrderBookDepthLevel[] {
  if (!Number.isFinite(step) || step <= 0) {
    return levels
      .filter(
        level =>
          Number.isFinite(level.price) &&
          Number.isFinite(level.amount) &&
          level.price > 0 &&
          level.amount > 0,
      )
      .map(level => ({price: level.price, amount: level.amount}));
  }

  const precision = getStepPrecision(step);
  const grouped = new Map<string, OrderBookDepthLevel>();

  levels.forEach(level => {
    if (
      !Number.isFinite(level.price) ||
      !Number.isFinite(level.amount) ||
      level.price <= 0 ||
      level.amount <= 0
    )
      return;

    const rawPrice =
      side === 'ask'
        ? Math.ceil(level.price / step) * step
        : Math.floor(level.price / step) * step;
    const price = Number(rawPrice.toFixed(precision));
    const key = price.toFixed(precision);
    const current = grouped.get(key);

    if (current) {
      current.amount += level.amount;
      return;
    }

    grouped.set(key, {price, amount: level.amount});
  });

  return Array.from(grouped.values()).sort((a, b) => b.price - a.price);
}

function getStepPrecision(step: number) {
  const [coefficient, exponentText] = step.toString().toLowerCase().split('e');
  const [, decimal = ''] = coefficient.split('.');
  const exponent = Number(exponentText || 0);
  return Math.max(0, decimal.length - exponent);
}
