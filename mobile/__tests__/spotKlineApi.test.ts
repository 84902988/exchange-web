import {publicApiClient} from '../src/api/client';
import {fetchSpotKlines} from '../src/api/spot';

describe('Spot Kline API', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('forces a REST snapshot for fresh 1m candles', async () => {
    const getSpy = jest.spyOn(publicApiClient, 'get').mockResolvedValue({
      symbol: 'TESTUSDT',
      interval: '1m',
      items: [
        {
          open_time: 1_800_000_000_000,
          open: '100',
          high: '102',
          low: '99',
          close: '101',
          volume: '12',
        },
      ],
    });

    await expect(fetchSpotKlines('TESTUSDT', '1m', 80)).resolves.toEqual([
      {
        openTime: 1_800_000_000_000,
        open: 100,
        high: 102,
        low: 99,
        close: 101,
        volume: 12,
      },
    ]);
    expect(getSpy).toHaveBeenCalledWith(
      '/market/kline?symbol=TESTUSDT&interval=1m&limit=80&force_rest=1',
    );
  });
});
