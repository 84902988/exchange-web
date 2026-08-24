import type {TradeOrderType} from '../components/trade/TradeOrderForm';

export type SpotEstimatedFee = {
  fee: number;
  rate: number;
  role: 'TAKER' | 'CONSERVATIVE';
};

export function calculateSpotEstimatedFee({
  amount,
  lastPrice,
  makerRate,
  orderType,
  price,
  takerRate,
}: {
  amount: string;
  lastPrice: number | null;
  makerRate: number;
  orderType: TradeOrderType;
  price: string;
  takerRate: number;
}): SpotEstimatedFee | null {
  const amountValue = Number(amount.trim());
  const executionPrice =
    orderType === 'MARKET'
      ? lastPrice
      : Number(price.replace(/,/g, '').trim());
  if (
    executionPrice === null ||
    !Number.isFinite(executionPrice) ||
    executionPrice <= 0 ||
    !Number.isFinite(amountValue) ||
    amountValue <= 0 ||
    !Number.isFinite(makerRate) ||
    makerRate < 0 ||
    !Number.isFinite(takerRate) ||
    takerRate < 0
  ) {
    return null;
  }
  const role = orderType === 'MARKET' ? 'TAKER' : 'CONSERVATIVE';
  const rate =
    role === 'TAKER' ? takerRate : Math.max(makerRate, takerRate);
  return {
    fee: executionPrice * amountValue * rate,
    rate,
    role,
  };
}
