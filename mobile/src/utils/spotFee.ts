import type { TradeOrderType } from '../components/trade/TradeOrderForm';
import type { SpotFeePaymentContext } from '../api/spot';

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
    orderType === 'MARKET' ? lastPrice : Number(price.replace(/,/g, '').trim());
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
  const rate = role === 'TAKER' ? takerRate : Math.max(makerRate, takerRate);
  return {
    fee: executionPrice * amountValue * rate,
    rate,
    role,
  };
}

export function estimateSpotFeePayment({
  feeUsdt,
  context,
  symbol,
  side,
  amount,
  executionPrice,
}: {
  feeUsdt: number;
  context: SpotFeePaymentContext;
  symbol: string;
  side: 'BUY' | 'SELL';
  amount: number;
  executionPrice: number | null;
}) {
  const usdt = (
    reason:
      | 'platformOff'
      | 'disabled'
      | 'priceUnavailable'
      | 'insufficient'
      | 'zero',
  ) => ({ asset: 'USDT' as const, fee: feeUsdt, reason });
  if (!context.platformEnabled) return usdt('platformOff');
  if (!context.useRcbFee) return usdt('disabled');
  if (feeUsdt <= 0) return usdt('zero');
  const rcbPair = symbol === 'RCBUSDT';
  const price = rcbPair ? executionPrice : context.rcbUsdtPrice;
  if (price === null || !Number.isFinite(price) || price <= 0)
    return usdt('priceUnavailable');
  const fee = Math.max((feeUsdt * context.payRatio) / price, context.minRcbFee);
  // Settlement selects the fee asset after crediting/debiting the traded RCB.
  const available =
    context.spotRcbAvailable +
    (rcbPair ? (side === 'BUY' ? amount : -amount) : 0);
  if (!Number.isFinite(fee) || available < fee) return usdt('insufficient');
  return { asset: 'RCB' as const, fee, reason: 'rcb' as const };
}
