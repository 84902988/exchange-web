import {fetchAssetBalanceLogs} from '../src/api/assets';
import {ASSET_HISTORY_FILTERS} from '../src/screens/assets/AssetHistoryScreen';

function jsonResponse(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    text: jest.fn().mockResolvedValue(JSON.stringify(payload)),
  } as unknown as Response;
}

describe('asset history server-side filters and pagination identity', () => {
  const originalFetch = globalThis.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    globalThis.fetch = fetchMock as typeof fetch;
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  it('uses exact backend business types instead of page-local grouping', () => {
    const queryByFilter = Object.fromEntries(
      ASSET_HISTORY_FILTERS.map(item => [item.value, item.serverBizType]),
    );

    expect(queryByFilter).toMatchObject({
      withdraw: 'WITHDRAW_SUCCESS',
      userTransfer: 'USER_TRANSFER',
      transfer: 'TRANSFER',
      trade: 'TRADE',
      tradeFee: 'TRADE_FEE',
      dividend: 'DIVIDEND',
      bdCommission: 'BD_COMMISSION_CREDIT',
      inviteReward: 'USER_INVITE_COMMISSION_CREDIT',
    });
    expect(
      ASSET_HISTORY_FILTERS.every(
        item => item.value === 'all' || Boolean(item.serverBizType),
      ),
    ).toBe(true);
  });

  it('sends the exact filter and preserves the required backend row id', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        ok: true,
        data: {
          items: [
            {
              id: 201,
              biz_type: 'WITHDRAW_SUCCESS',
              coin_symbol: 'USDT',
              chain_key: 'funding',
              change_amount: '-10',
              after_available: '90',
            },
          ],
          page: 2,
          page_size: 20,
          total: 21,
        },
      }),
    );

    const result = await fetchAssetBalanceLogs(2, 20, {
      bizType: 'WITHDRAW_SUCCESS',
    });
    const url = String(fetchMock.mock.calls[0][0]);

    expect(url).toContain('biz_type=WITHDRAW_SUCCESS');
    expect(url).toContain('page=2');
    expect(result.items[0].id).toBe('201');
    expect(result.total).toBe(21);
  });
});
