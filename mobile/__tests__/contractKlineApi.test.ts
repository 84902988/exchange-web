import {
  fetchContractKlineHistory,
  normalizeContractKlineRows,
} from '../src/api/contract';
import {publicApiClient} from '../src/api/client';

describe('Contract Kline REST normalization', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('normalizes timestamps, sorts, deduplicates, and applies the requested bound', () => {
    expect(
      normalizeContractKlineRows(
        {
          data: [
            {
              open_time: 1_800_000_120,
              open: '102',
              high: '105',
              low: '101',
              close: '104',
              volume: '2',
            },
            {
              open_time: 1_800_000_000_000,
              open: 100,
              high: 103,
              low: 99,
              close: 102,
              volume: 1,
            },
            {
              open_time: 1_800_000_120_000,
              open: 102,
              high: 106,
              low: 100,
              close: 105,
              volume: 3,
            },
          ],
        },
        1,
      ),
    ).toEqual([
      {
        openTime: 1_800_000_120_000,
        open: 102,
        high: 106,
        low: 100,
        close: 105,
        volume: 3,
      },
    ]);
  });

  it('rejects incomplete, impossible, or unsafe rows instead of repairing them', () => {
    const valid = {
      open_time: 1_800_000_000_000,
      open: 100,
      high: 105,
      low: 95,
      close: 102,
      volume: 1,
    };

    expect(
      normalizeContractKlineRows({
        items: [
          {...valid, volume: undefined},
          {...valid, high: 99},
          {...valid, low: 103},
          {...valid, close: 0},
          {...valid, volume: -1},
          {...valid, open_time: Number.MAX_SAFE_INTEGER + 1},
          valid,
        ],
      }),
    ).toEqual([
      {
        openTime: valid.open_time,
        open: valid.open,
        high: valid.high,
        low: valid.low,
        close: valid.close,
        volume: valid.volume,
      },
    ]);
  });

  it('requests metadata without the shared Kline cache and preserves retry signals', async () => {
    const controller = new AbortController();
    const getSpy = jest.spyOn(publicApiClient, 'get').mockResolvedValue({
      items: [],
      stale: true,
      freshness: 'stale',
      history_incomplete: true,
      history_complete: false,
      has_more_before: true,
      history_terminal: false,
      coverage_complete: false,
      provider_error_code: 'PROVIDER_TIMEOUT',
      retryable: true,
    });

    await expect(
      fetchContractKlineHistory(' btcusdt_perp ', '5m', 500, {
        signal: controller.signal,
      }),
    ).resolves.toEqual({
      items: [],
      stale: true,
      freshness: 'STALE',
      historyIncomplete: true,
      historyComplete: false,
      hasMoreBefore: true,
      historyTerminal: false,
      coverageComplete: false,
      providerErrorCode: 'PROVIDER_TIMEOUT',
      retryable: true,
    });
    expect(getSpy).toHaveBeenCalledWith(
      '/contract/market/kline?symbol=BTCUSDT_PERP&interval=5m&limit=200&include_metadata=1',
      {signal: controller.signal},
    );
  });
});
