import {
  StockTokenContractError,
  normalizeStockTokenConverts,
  normalizeStockTokenLocks,
} from '../src/api/stockToken';

const lockPayload = {
  id: 9,
  lock_symbol: 'xabc',
  trade_symbol: 'ABC',
  total_amount: '100.000000000000000000',
  locked_amount: '75.000000000000000000',
  available_amount: '15.000000000000000000',
  converted_amount: '10.000000000000000000',
  conversion_rate_snapshot: '2.500000000000000000',
  daily_release_rate: '0.010000000000000000',
  lock_days: 30,
  release_days: 100,
  unlock_at: '2026-08-01T00:00:00',
  lock_start_at: '2026-07-02T00:00:00',
  lock_end_at: '2026-08-01T00:00:00',
  release_start_at: '2026-08-01T00:00:00',
  release_finish_at: '2026-11-09T00:00:00',
  release_started: true,
  progress_percent: '25.00',
  status: 'ACTIVE',
  start_at: '2026-07-02T00:00:00',
  end_at: '2026-11-09T00:00:00',
};

describe('mobile stock token API contracts', () => {
  it('maps lock and convert responses into strict mobile fields', () => {
    expect(normalizeStockTokenLocks({items: [lockPayload]}).items[0]).toMatchObject({
      id: 9,
      lockSymbol: 'XABC',
      tradeSymbol: 'ABC',
      totalAmount: '100',
      availableAmount: '15',
      dailyReleaseRate: '0.01',
      progressPercent: '25',
      status: 'ACTIVE',
    });

    expect(
      normalizeStockTokenConverts({
        items: [
          {
            id: 11,
            from_symbol: 'XABC',
            to_symbol: 'ABC',
            from_amount: '10.000000000000000000',
            to_amount: '25.000000000000000000',
            conversion_rate: '2.500000000000000000',
            status: 'SUCCESS',
            created_at: '2026-08-03T03:20:00',
          },
        ],
      }).items[0],
    ).toMatchObject({
      id: 11,
      fromSymbol: 'XABC',
      toSymbol: 'ABC',
      fromAmount: '10',
      toAmount: '25',
      conversionRate: '2.5',
      status: 'SUCCESS',
    });
  });

  it('fails closed for malformed financial, identity, or status fields', () => {
    expect(() =>
      normalizeStockTokenLocks({
        items: [{...lockPayload, available_amount: '-1'}],
      }),
    ).toThrow(StockTokenContractError);
    expect(() =>
      normalizeStockTokenLocks({items: [{...lockPayload, id: 0}]}),
    ).toThrow(StockTokenContractError);
    expect(() =>
      normalizeStockTokenLocks({items: [{...lockPayload, status: 'UNKNOWN'}]}),
    ).toThrow(StockTokenContractError);
    expect(() =>
      normalizeStockTokenConverts({
        items: [
          {
            id: 1,
            from_symbol: 'XABC',
            to_symbol: 'ABC',
            from_amount: '1e4',
            to_amount: '1',
            conversion_rate: '1',
            status: 'SUCCESS',
            created_at: null,
          },
        ],
      }),
    ).toThrow(StockTokenContractError);
  });
});
