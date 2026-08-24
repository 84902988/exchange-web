import {apiClient, ApiClientError} from '../src/api/client';
import {
  fetchTradeIdempotencyStatus,
  normalizeTradeIdempotencyStatusPayload,
} from '../src/api/tradeIdempotency';

const completedSpot = {
  market: 'SPOT',
  client_order_id: 'm-authority-1',
  status: 'COMPLETED',
  operation: 'SPOT_CREATE',
  result: {
    id: 41,
    symbol: 'BTCUSDT',
    client_order_id: 'm-authority-1',
  },
  created_at: '2026-08-02T01:02:03Z',
  completed_at: '2026-08-02T01:02:04Z',
};

describe('trade idempotency authority API', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('accepts a completed result only when market and client id match', () => {
    expect(
      normalizeTradeIdempotencyStatusPayload(
        completedSpot,
        'spot',
        'm-authority-1',
      ),
    ).toMatchObject({
      status: 'COMPLETED',
      operation: 'SPOT_CREATE',
      resultSymbol: 'BTCUSDT',
    });
    expect(() =>
      normalizeTradeIdempotencyStatusPayload(
        completedSpot,
        'contract',
        'm-authority-1',
      ),
    ).toThrow(ApiClientError);
    expect(() =>
      normalizeTradeIdempotencyStatusPayload(
        completedSpot,
        'spot',
        'm-other-id',
      ),
    ).toThrow(ApiClientError);
  });

  it('keeps NOT_FOUND and PENDING explicitly non-authoritative', () => {
    expect(
      normalizeTradeIdempotencyStatusPayload(
        {
          market: 'CONTRACT',
          client_order_id: 'm-missing-1',
          status: 'NOT_FOUND',
          operation: null,
          result: null,
          created_at: null,
          completed_at: null,
        },
        'contract',
        'm-missing-1',
      ),
    ).toMatchObject({status: 'NOT_FOUND', result: null});
    expect(
      normalizeTradeIdempotencyStatusPayload(
        {
          market: 'CONTRACT',
          client_order_id: 'm-pending-1',
          status: 'PENDING',
          operation: 'CONTRACT_OPEN',
          result: null,
          created_at: '2026-08-02T01:02:03Z',
          completed_at: null,
        },
        'contract',
        'm-pending-1',
      ),
    ).toMatchObject({status: 'PENDING', result: null});
  });

  it('rejects malformed completed authority responses', () => {
    for (const payload of [
      {...completedSpot, operation: 'UNKNOWN'},
      {...completedSpot, result: {...completedSpot.result, client_order_id: 'm-other'}},
      {...completedSpot, result: {...completedSpot.result, symbol: ''}},
      {...completedSpot, completed_at: null},
    ]) {
      expect(() =>
        normalizeTradeIdempotencyStatusPayload(
          payload,
          'spot',
          'm-authority-1',
        ),
      ).toThrow(ApiClientError);
    }
  });

  it('uses the market-specific authenticated endpoint', async () => {
    const get = jest.spyOn(apiClient, 'get').mockResolvedValue(completedSpot);
    await expect(
      fetchTradeIdempotencyStatus('spot', 'M-AUTHORITY-1'),
    ).resolves.toMatchObject({status: 'COMPLETED'});
    expect(get).toHaveBeenCalledWith('/order/idempotency/m-authority-1');
  });
});
