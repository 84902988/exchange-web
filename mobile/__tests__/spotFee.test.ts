import {apiClient} from '../src/api/client';
import {fetchSpotFeeRates} from '../src/api/spot';
import {calculateSpotEstimatedFee} from '../src/utils/spotFee';

describe('authoritative spot fee estimate', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('loads the authenticated effective maker and taker rates', async () => {
    jest.spyOn(apiClient, 'get').mockResolvedValue({
      auth_state: 'authenticated',
      user_summary: {
        effective_spot_maker_fee: '0.001',
        effective_spot_taker_fee: '0.002',
      },
    });

    await expect(fetchSpotFeeRates()).resolves.toEqual({
      makerRate: 0.001,
      takerRate: 0.002,
    });
  });

  it.each([
    {},
    {auth_state: 'anonymous', user_summary: {}},
    {
      auth_state: 'authenticated',
      user_summary: {
        effective_spot_maker_fee: null,
        effective_spot_taker_fee: '0.002',
      },
    },
  ])('rejects malformed or unauthenticated fee payloads', async payload => {
    jest.spyOn(apiClient, 'get').mockResolvedValue(payload);

    await expect(fetchSpotFeeRates()).rejects.toThrow(
      /手续费率|费率响应/,
    );
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
    ).toEqual({fee: 0.4, rate: 0.002, role: 'TAKER'});
    expect(
      calculateSpotEstimatedFee({
        amount: '2',
        lastPrice: 100,
        makerRate: 0.003,
        orderType: 'LIMIT',
        price: '100',
        takerRate: 0.002,
      }),
    ).toEqual({fee: 0.6, rate: 0.003, role: 'CONSERVATIVE'});
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
