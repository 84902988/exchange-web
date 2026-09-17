import { apiClient } from '../src/api/client';
import { fetchSpotFeeRates } from '../src/api/spot';
import { calculateSpotEstimatedFee } from '../src/utils/spotFee';

const paymentPayload = {
  use_rcb_fee: true,
  spot_rcb_fee_enabled: true,
  rcb_fee_discount_rate: '0.75',
  min_rcb_fee_amount: '0',
  rcb_spot_available: '1',
  rcb_usdt_price: '2',
};
const ratesPayload = {
  auth_state: 'authenticated',
  user_summary: {
    effective_spot_maker_fee: '0.001',
    effective_spot_taker_fee: '0.002',
  },
};

describe('authoritative spot fee estimate', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('loads the authenticated effective maker and taker rates', async () => {
    jest
      .spyOn(apiClient, 'get')
      .mockResolvedValueOnce(ratesPayload)
      .mockResolvedValueOnce(paymentPayload);

    await expect(fetchSpotFeeRates()).resolves.toEqual({
      makerRate: 0.001,
      takerRate: 0.002,
      payment: {
        useRcbFee: true,
        platformEnabled: true,
        payRatio: 0.75,
        minRcbFee: 0,
        spotRcbAvailable: 1,
        rcbUsdtPrice: 2,
      },
    });
  });

  it.each([
    {},
    { ...paymentPayload, use_rcb_fee: 'true' },
    { ...paymentPayload, rcb_spot_available: null },
    { ...paymentPayload, rcb_fee_discount_rate: '1.5' },
    { ...paymentPayload, rcb_usdt_price: undefined },
  ])(
    'does not invent a payment asset from malformed context',
    async payment => {
      jest
        .spyOn(apiClient, 'get')
        .mockResolvedValueOnce(ratesPayload)
        .mockResolvedValueOnce(payment);
      await expect(fetchSpotFeeRates()).rejects.toThrow('手续费抵扣条件');
    },
  );

  it('preserves an unavailable conversion price and aborts both reads with the same signal', async () => {
    const request = jest
      .spyOn(apiClient, 'get')
      .mockResolvedValueOnce(ratesPayload)
      .mockResolvedValueOnce({ ...paymentPayload, rcb_usdt_price: null });
    const controller = new AbortController();
    const result = await fetchSpotFeeRates({ signal: controller.signal });
    expect(result.payment.rcbUsdtPrice).toBeNull();
    expect(request).toHaveBeenCalledWith('/spot/fee-payment-context', {
      signal: controller.signal,
    });
    expect(request).toHaveBeenCalledWith('/vip/overview', {
      signal: controller.signal,
    });
  });

  it.each([
    {},
    { auth_state: 'anonymous', user_summary: {} },
    {
      auth_state: 'authenticated',
      user_summary: {
        effective_spot_maker_fee: null,
        effective_spot_taker_fee: '0.002',
      },
    },
  ])('rejects malformed or unauthenticated fee payloads', async payload => {
    jest.spyOn(apiClient, 'get').mockResolvedValue(payload);

    await expect(fetchSpotFeeRates()).rejects.toThrow(/手续费率|费率响应/);
  });

  it('uses taker for market orders and a conservative maximum for limit orders', () => {
    expect(
      calculateSpotEstimatedFee({
        amount: '2',
        lastPrice: 100,
        makerRate: 0.001,
        orderType: 'MARKET',
        price: '',
        takerRate: 0.002,
      }),
    ).toEqual({ fee: 0.4, rate: 0.002, role: 'TAKER' });
    expect(
      calculateSpotEstimatedFee({
        amount: '2',
        lastPrice: 100,
        makerRate: 0.003,
        orderType: 'LIMIT',
        price: '100',
        takerRate: 0.002,
      }),
    ).toEqual({ fee: 0.6, rate: 0.003, role: 'CONSERVATIVE' });
  });

  it('does not fabricate a fee without valid price and quantity', () => {
    expect(
      calculateSpotEstimatedFee({
        amount: '',
        lastPrice: null,
        makerRate: 0.001,
        orderType: 'MARKET',
        price: '',
        takerRate: 0.002,
      }),
    ).toBeNull();
  });
});
