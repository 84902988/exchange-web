export type ContractHeaderChangeInput = {
  changeAmount: unknown;
  changePercent: unknown;
  pricePrecision: number;
};

function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function formatSigned(value: number, precision: number, suffix = '') {
  return `${value > 0 ? '+' : ''}${value.toFixed(precision)}${suffix}`;
}

export function formatContractHeaderChange({
  changeAmount,
  changePercent,
  pricePrecision,
}: ContractHeaderChangeInput): string | null {
  const amount = finiteNumber(changeAmount);
  const percent = finiteNumber(changePercent);
  const safePricePrecision = Number.isInteger(pricePrecision)
    ? Math.max(0, Math.min(pricePrecision, 12))
    : 2;

  if (amount === null && percent === null) return null;
  if (amount !== null && percent !== null) {
    return `${formatSigned(amount, safePricePrecision)} / ${formatSigned(percent, 2, '%')}`;
  }
  if (amount !== null) return formatSigned(amount, safePricePrecision);
  return percent !== null ? formatSigned(percent, 2, '%') : null;
}
