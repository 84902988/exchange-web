import { apiClient } from '../src/api/client';
import {
  cancelSpotOrder,
  createSpotOrder,
  fetchSpotCurrentOrders,
  fetchSpotCurrentOrdersPage,
  type SpotOrderItem,
} from '../src/api/spot';
import { getCancelableSpotOrderId } from '../src/components/trade/TradeBottomTabs';

function order(overrides: Partial<SpotOrderItem> = {}): SpotOrderItem {
  return {
    id: '42',
    orderId: 42,
    symbol: 'BTCUSDT',
    side: 'BUY',
    orderType: 'LIMIT',
    price: '100',
    amount: '2',
    filledAmount: '0',
    status: 'OPEN',
    createdAt: '2026-07-31T00:00:00Z',
    ...overrides,
  };
}

describe('Spot REST order lifecycle', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('preserves the backend numeric order id in current-order snapshots', async () => {
    jest.spyOn(apiClient, 'get').mockResolvedValue({
      symbol: 'BTCUSDT',
      items: [
        {
          id: 42,
          symbol: 'BTCUSDT',
          side: 'BUY',
          order_type: 'LIMIT',
          price: '100',
          amount: '2',
          filled_amount: '0',
          status: 'OPEN',
        },
      ],
    });

    const result = await fetchSpotCurrentOrders('BTCUSDT');

    expect(result[0]).toMatchObject({
      id: '42',
      orderId: 42,
      status: 'OPEN',
    });
  });

  it('requests older current orders with a stable keyset cursor', async () => {
    const get = jest.spyOn(apiClient, 'get').mockResolvedValue({
      symbol: 'BTCUSDT',
      items: [],
      has_more: false,
      next_cursor: null,
    });

    await expect(fetchSpotCurrentOrdersPage('BTCUSDT', 20, 42)).resolves.toEqual(
      {
        items: [],
        hasMore: false,
        nextCursor: null,
        paginationSupported: true,
      },
    );
    expect(get).toHaveBeenCalledWith(
      '/spot/orders/current?symbol=BTCUSDT&limit=20&before_id=42',
    );
  });

  it('posts a cancel request to the exact order route once', async () => {
    const post = jest.spyOn(apiClient, 'post').mockResolvedValue({
      id: 42,
      order_no: 'SPOT-42',
      status: 'CANCELED',
    });

    await expect(cancelSpotOrder(42)).resolves.toEqual({
      orderId: 42,
      orderNo: 'SPOT-42',
      status: 'CANCELED',
    });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith('/order/42/cancel');
  });

  it('accepts a create response only with a real order id and backend success status', async () => {
    const post = jest.spyOn(apiClient, 'post').mockResolvedValue({
      id: 42,
      order_no: 'SPOT-42',
      symbol: 'BTCUSDT',
      side: 'buy',
      order_type: 'limit',
      price: '100.0',
      amount: '2.00',
      filled_amount: '0',
      frozen_amount: '200',
      status: 'open',
      created_at: '2026-07-31T00:00:00Z',
    });

    await expect(
      createSpotOrder({
        symbol: 'BTCUSDT',
        side: 'BUY',
        order_type: 'LIMIT',
        price: '100',
        amount: '2',
      }),
    ).resolves.toEqual({
      id: 42,
      orderNo: 'SPOT-42',
      symbol: 'BTCUSDT',
      side: 'BUY',
      orderType: 'LIMIT',
      price: '100.0',
      amount: '2.00',
      filledAmount: '0',
      frozenAmount: '200',
      status: 'OPEN',
      createdAt: '2026-07-31T00:00:00Z',
    });
    expect(post).toHaveBeenCalledWith('/order/create', {
      symbol: 'BTCUSDT',
      side: 'BUY',
      order_type: 'LIMIT',
      price: '100',
      amount: '2',
    });
  });

  it('accepts the backend fixed-scale decimal echo for an idempotent LIMIT replay', async () => {
    const clientOrderId =
      'm-msaugetp-00001-d88b0417d4f96d47b554d0ead92906a2';
    jest.spyOn(apiClient, 'post').mockResolvedValue({
      id: 141271,
      order_no: 'ORD202608012051476564596',
      symbol: 'BTCUSDT',
      side: 'BUY',
      order_type: 'LIMIT',
      price: '50000.000000000000000000',
      amount: '0.000200000000000000',
      filled_amount: '0E-18',
      frozen_amount: '10.000000000000000000',
      status: 'OPEN',
      created_at: '2026-08-01T20:51:48',
      client_order_id: clientOrderId,
    });

    await expect(
      createSpotOrder({
        symbol: 'BTCUSDT',
        side: 'BUY',
        order_type: 'LIMIT',
        client_order_id: clientOrderId,
        price: '50000',
        amount: '0.0002',
      }),
    ).resolves.toMatchObject({
      id: 141271,
      price: '50000.000000000000000000',
      amount: '0.000200000000000000',
      filledAmount: '0E-18',
      frozenAmount: '10.000000000000000000',
      status: 'OPEN',
    });
  });

  it.each([
    ['missing', undefined],
    ['mismatched', 'm-other-client-id'],
  ])(
    'rejects a create response with %s client_order_id when the request has one',
    async (_label, responseClientOrderId) => {
      jest.spyOn(apiClient, 'post').mockResolvedValue({
        id: 42,
        order_no: 'SPOT-42',
        symbol: 'BTCUSDT',
        side: 'BUY',
        order_type: 'LIMIT',
        client_order_id: responseClientOrderId,
        price: '100',
        amount: '2',
        filled_amount: '0',
        frozen_amount: '200',
        status: 'OPEN',
        created_at: '2026-07-31T00:00:00Z',
      });

      await expect(
        createSpotOrder({
          symbol: 'BTCUSDT',
          side: 'BUY',
          order_type: 'LIMIT',
          client_order_id: 'm-client-id',
          price: '100',
          amount: '2',
        }),
      ).rejects.toMatchObject({code: 'INVALID_SPOT_ORDER_RESPONSE'});
    },
  );

  it('accepts and forwards an exactly echoed client_order_id', async () => {
    const post = jest.spyOn(apiClient, 'post').mockResolvedValue({
      id: 42,
      order_no: 'SPOT-42',
      symbol: 'BTCUSDT',
      side: 'BUY',
      order_type: 'LIMIT',
      client_order_id: 'm-client-id',
      price: '100',
      amount: '2',
      filled_amount: '0',
      frozen_amount: '200',
      status: 'OPEN',
      created_at: '2026-07-31T00:00:00Z',
    });

    await expect(
      createSpotOrder({
        symbol: 'BTCUSDT',
        side: 'BUY',
        order_type: 'LIMIT',
        client_order_id: 'm-client-id',
        price: '100',
        amount: '2',
      }),
    ).resolves.toMatchObject({id: 42});
    expect(post).toHaveBeenCalledWith(
      '/order/create',
      expect.objectContaining({client_order_id: 'm-client-id'}),
    );
  });

  it.each([
    ['missing order id', { status: 'OPEN' }],
    ['zero order id', { id: 0, status: 'OPEN' }],
    ['a non-numeric order id', { id: true, status: 'OPEN' }],
    ['missing status', { id: 42 }],
    ['synthetic submitted status', { id: 42, status: 'SUBMITTED' }],
  ])('rejects a create response with %s', async (_label, response) => {
    jest.spyOn(apiClient, 'post').mockResolvedValue(response);

    await expect(
      createSpotOrder({
        symbol: 'BTCUSDT',
        side: 'BUY',
        order_type: 'MARKET',
        amount: '1',
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_SPOT_ORDER_RESPONSE',
    });
  });

  it.each([
    [
      'a different symbol',
      { symbol: 'ETHUSDT', side: 'BUY', order_type: 'LIMIT' },
    ],
    [
      'a different side',
      { symbol: 'BTCUSDT', side: 'SELL', order_type: 'LIMIT' },
    ],
    [
      'a different order type',
      { symbol: 'BTCUSDT', side: 'BUY', order_type: 'MARKET' },
    ],
  ])(
    'rejects a create response with %s even when id and status look successful',
    async (_label, fields) => {
      jest.spyOn(apiClient, 'post').mockResolvedValue(
        Object.assign(
          {
            id: 42,
            order_no: 'SPOT-42',
            symbol: 'BTCUSDT',
            side: 'BUY',
            order_type: 'LIMIT',
            price: '100',
            amount: '2',
            filled_amount: '0',
            frozen_amount: '200',
            status: 'OPEN',
            created_at: '2026-07-31T00:00:00Z',
          },
          fields,
        ),
      );

      await expect(
        createSpotOrder({
          symbol: 'BTCUSDT',
          side: 'BUY',
          order_type: 'LIMIT',
          price: '100',
          amount: '2',
        }),
      ).rejects.toMatchObject({
        code: 'INVALID_SPOT_ORDER_RESPONSE',
      });
    },
  );

  it.each([
    ['order_no', undefined],
    ['price', undefined],
    ['amount', undefined],
    ['filled_amount', undefined],
    ['frozen_amount', undefined],
    ['created_at', undefined],
    ['order_no', 42],
    ['created_at', 1_800_000_000_000],
    ['amount', 'not-a-number'],
    ['filled_amount', '-1'],
    ['frozen_amount', '-1'],
    ['created_at', 'not-a-date'],
  ])(
    'rejects a create response with invalid required %s',
    async (field, value) => {
      jest.spyOn(apiClient, 'post').mockResolvedValue({
        id: 42,
        order_no: 'SPOT-42',
        symbol: 'BTCUSDT',
        side: 'BUY',
        order_type: 'LIMIT',
        price: '100',
        amount: '2',
        filled_amount: '0',
        frozen_amount: '200',
        status: 'OPEN',
        created_at: '2026-07-31T00:00:00Z',
        [field]: value,
      });

      await expect(
        createSpotOrder({
          symbol: 'BTCUSDT',
          side: 'BUY',
          order_type: 'LIMIT',
          price: '100',
          amount: '2',
        }),
      ).rejects.toMatchObject({ code: 'INVALID_SPOT_ORDER_RESPONSE' });
    },
  );

  it.each([
    ['different limit price', { price: '100.0000000000000000001' }],
    ['different limit amount', { amount: '2.0000000000000000001' }],
    ['filled amount above amount', { filled_amount: '2.1' }],
  ])('rejects a create response with %s', async (_label, overrides) => {
    jest.spyOn(apiClient, 'post').mockResolvedValue({
      id: 42,
      order_no: 'SPOT-42',
      symbol: 'BTCUSDT',
      side: 'BUY',
      order_type: 'LIMIT',
      price: '100',
      amount: '2',
      filled_amount: '0',
      frozen_amount: '200',
      status: 'OPEN',
      created_at: '2026-07-31T00:00:00Z',
      ...overrides,
    });

    await expect(
      createSpotOrder({
        symbol: 'BTCUSDT',
        side: 'BUY',
        order_type: 'LIMIT',
        price: '100',
        amount: '2',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_SPOT_ORDER_RESPONSE' });
  });

  it('accepts the backend MARKET shape with a present null price', async () => {
    jest.spyOn(apiClient, 'post').mockResolvedValue({
      id: 43,
      order_no: 'SPOT-43',
      symbol: 'BTCUSDT',
      side: 'SELL',
      order_type: 'MARKET',
      price: null,
      amount: '1.0',
      filled_amount: '1',
      frozen_amount: '0',
      status: 'FILLED',
      created_at: '2026-07-31T00:00:00Z',
    });

    await expect(
      createSpotOrder({
        symbol: 'BTCUSDT',
        side: 'SELL',
        order_type: 'MARKET',
        amount: '1',
      }),
    ).resolves.toMatchObject({
      id: 43,
      price: null,
      amount: '1.0',
      filledAmount: '1',
      frozenAmount: '0',
    });
  });

  it.each([
    ['missing order id', { status: 'CANCELED' }],
    ['a different order id', { id: 43, status: 'CANCELED' }],
    ['a non-numeric order id', { id: true, status: 'CANCELED' }],
    ['missing status', { id: 42 }],
    ['a non-canceled status', { id: 42, status: 'OPEN' }],
  ])('rejects a cancel response with %s', async (_label, response) => {
    jest.spyOn(apiClient, 'post').mockResolvedValue(response);

    await expect(cancelSpotOrder(42)).rejects.toMatchObject({
      code: 'INVALID_SPOT_CANCEL_RESPONSE',
    });
  });

  it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid numeric order id %s before transport',
    async invalidOrderId => {
      const post = jest.spyOn(apiClient, 'post');

      await expect(cancelSpotOrder(invalidOrderId)).rejects.toMatchObject({
        code: 'INVALID_ORDER_ID',
      });
      expect(post).not.toHaveBeenCalled();
    },
  );

  it.each(['OPEN', 'PARTIALLY_FILLED'])(
    'allows cancel only for a valid %s order',
    status => {
      expect(getCancelableSpotOrderId(order({ status }))).toBe(42);
    },
  );

  it.each(['FILLED', 'CANCELED', 'REJECTED', 'SUBMITTED', ''])(
    'blocks cancel for terminal or unsupported status %s',
    status => {
      expect(getCancelableSpotOrderId(order({ status }))).toBeNull();
    },
  );

  it('blocks cancel when the backend numeric order id is missing', () => {
    expect(
      getCancelableSpotOrderId(order({ id: 'SPOT-42', orderId: null })),
    ).toBeNull();
  });
});
