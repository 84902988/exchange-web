import { estimateSpotFeePayment } from '../src/utils/spotFee';
import type { SpotFeePaymentContext } from '../src/api/spot';

const context: SpotFeePaymentContext = {
  useRcbFee: true,
  platformEnabled: true,
  payRatio: 0.75,
  minRcbFee: 0,
  spotRcbAvailable: 1,
  rcbUsdtPrice: 2,
};
const input = {
  feeUsdt: 1,
  context,
  symbol: 'ETHUSDT',
  side: 'BUY' as const,
  amount: 0.1,
  executionPrice: 2500,
};

describe('spot RCB fee preview', () => {
  it('uses the configured pay ratio and RCB conversion price', () => {
    expect(estimateSpotFeePayment(input)).toEqual({
      asset: 'RCB',
      fee: 0.375,
      reason: 'rcb',
    });
  });
  it.each([
    [{ spotRcbAvailable: 0 }, 'insufficient'],
    [{ spotRcbAvailable: 0.374 }, 'insufficient'],
    [{ rcbUsdtPrice: null }, 'priceUnavailable'],
    [{ useRcbFee: false }, 'disabled'],
    [{ platformEnabled: false }, 'platformOff'],
  ] as const)('explains the USDT fallback for %o', (changes, reason) => {
    expect(
      estimateSpotFeePayment({ ...input, context: { ...context, ...changes } }),
    ).toEqual({ asset: 'USDT', fee: 1, reason });
  });
  it('accepts an exactly sufficient balance and respects a minimum RCB fee', () => {
    expect(
      estimateSpotFeePayment({
        ...input,
        context: { ...context, spotRcbAvailable: 0.375 },
      }).asset,
    ).toBe('RCB');
    expect(
      estimateSpotFeePayment({
        ...input,
        context: { ...context, minRcbFee: 0.5 },
      }).fee,
    ).toBe(0.5);
    expect(
      estimateSpotFeePayment({
        ...input,
        context: { ...context, minRcbFee: 2 },
      }).reason,
    ).toBe('insufficient');
  });
  it('uses the estimated execution price and post-trade RCB balance for RCB pairs', () => {
    expect(
      estimateSpotFeePayment({
        ...input,
        symbol: 'RCBUSDT',
        amount: 1,
        executionPrice: 3,
        context: { ...context, spotRcbAvailable: 0, rcbUsdtPrice: null },
      }),
    ).toEqual({ asset: 'RCB', fee: 0.25, reason: 'rcb' });
    expect(
      estimateSpotFeePayment({
        ...input,
        symbol: 'RCBUSDT',
        amount: 1,
        side: 'SELL',
        executionPrice: 3,
      }).reason,
    ).toBe('insufficient');
  });
  it('does not apply a minimum charge when the trading fee is zero', () => {
    expect(
      estimateSpotFeePayment({
        ...input,
        feeUsdt: 0,
        context: { ...context, minRcbFee: 1 },
      }),
    ).toEqual({ asset: 'USDT', fee: 0, reason: 'zero' });
  });
});
