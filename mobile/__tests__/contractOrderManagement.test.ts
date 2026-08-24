import {
  canCancelContractOrder,
  cancelContractOrder,
  closeContractSummaryOrder,
  fetchContractOrders,
  fetchContractOrdersPage,
  fetchContractTradesPage,
  isContractOrderStatusCancelable,
  isValidContractOrderId,
  openContractOrder,
  updateContractPositionTpSl,
  type ContractOrderItem,
  type ContractPositionItem,
} from '../src/api/contract';
import { ApiClientError, apiClient } from '../src/api/client';

function order(overrides: Partial<ContractOrderItem> = {}): ContractOrderItem {
  return {
    id: '17',
    orderId: 17,
    symbol: 'BTCUSDT_PERP',
    positionSide: 'LONG',
    action: 'OPEN',
    orderType: 'LIMIT',
    price: '100',
    quantity: '2',
    leverage: 10,
    marginAmount: '20',
    spreadFee: '0',
    filledQuantity: '0',
    status: 'OPEN',
    createdAt: null,
    ...overrides,
  };
}

function openOrderResponse(overrides: Record<string, unknown> = {}) {
  return {
    order_id: 31,
    order_no: 'C-31',
    symbol: 'BTCUSDT_PERP',
    position_side: 'LONG',
    order_type: 'LIMIT',
    price: '100.000000000000000000',
    quantity: '2.000000000000000000',
    leverage: 10,
    status: 'partially_filled',
    position_id: 7,
    ...overrides,
  };
}

function marketOpenOrderResponse(overrides: Record<string, unknown> = {}) {
  return openOrderResponse({
    order_type: 'MARKET',
    price: null,
    quantity: '1.000000000000000000',
    status: 'filled',
    ...overrides,
  });
}

function closeSummaryResponse(overrides: Record<string, unknown> = {}) {
  return {
    symbol: 'BTCUSDT_PERP',
    side: 'LONG',
    order_type: 'MARKET',
    price: null,
    requested_quantity: '2.000000000000000000',
    submitted_quantity: '2.000000000000000000',
    closed_quantity: '2.000000000000000000',
    generated_order_ids: [31, 32],
    generated_trade_ids: [41, 42],
    affected_position_ids: [7, 8],
    status: 'filled',
    ...overrides,
  };
}

function position(
  overrides: Partial<ContractPositionItem> = {},
): ContractPositionItem {
  return {
    id: '7',
    symbol: 'BTCUSDT_PERP',
    side: 'LONG',
    leverage: 10,
    quantity: '2',
    entryPrice: '100',
    markPrice: '101',
    marginAmount: '20',
    unrealizedPnl: '2',
    liquidationPrice: '90',
    takeProfitPrice: null,
    stopLossPrice: null,
    status: 'OPEN',
    ...overrides,
  };
}

describe('Contract order management API', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('requests active and historical orders with separate backend filters', async () => {
    const getSpy = jest
      .spyOn(apiClient, 'get')
      .mockResolvedValue({ items: [] });

    await fetchContractOrders({
      symbol: 'BTCUSDT_PERP',
      status: 'ACTIVE',
    });
    await fetchContractOrders({
      symbol: 'BTCUSDT_PERP',
      statusGroup: 'HISTORY',
    });

    expect(getSpy).toHaveBeenNthCalledWith(
      1,
      '/contract/orders?symbol=BTCUSDT_PERP&status=ACTIVE&page=1&page_size=20',
    );
    expect(getSpy).toHaveBeenNthCalledWith(
      2,
      '/contract/orders?symbol=BTCUSDT_PERP&status_group=HISTORY&page=1&page_size=20',
    );
  });

  it('requests explicit contract record pages and returns validated metadata', async () => {
    const getSpy = jest.spyOn(apiClient, 'get').mockResolvedValue({
      items: [],
      total: 20,
      page: 2,
      page_size: 20,
    });

    await expect(
      fetchContractOrdersPage({
        symbol: 'BTCUSDT_PERP',
        statusGroup: 'HISTORY',
        page: 2,
        pageSize: 20,
      }),
    ).resolves.toMatchObject({
      total: 20,
      page: 2,
      pageSize: 20,
      hasMore: false,
      nextPage: null,
    });
    await expect(
      fetchContractTradesPage('BTCUSDT_PERP', 20, 2),
    ).resolves.toMatchObject({ page: 2, pageSize: 20 });

    expect(getSpy).toHaveBeenNthCalledWith(
      1,
      '/contract/orders?symbol=BTCUSDT_PERP&status_group=HISTORY&page=2&page_size=20',
    );
    expect(getSpy).toHaveBeenNthCalledWith(
      2,
      '/contract/trades?symbol=BTCUSDT_PERP&page=2&page_size=20',
    );
  });

  it('rejects invalid local contract pagination before transport', async () => {
    const getSpy = jest.spyOn(apiClient, 'get');

    await expect(
      fetchContractOrdersPage({
        symbol: 'BTCUSDT_PERP',
        page: 0,
        pageSize: 20,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CONTRACT_PAGE_REQUEST' });
    await expect(
      fetchContractTradesPage('BTCUSDT_PERP', 101, 1),
    ).rejects.toMatchObject({ code: 'INVALID_CONTRACT_PAGE_REQUEST' });
    expect(getSpy).not.toHaveBeenCalled();
  });

  it('keeps a strict numeric mutation id separate from the display id', async () => {
    jest.spyOn(apiClient, 'get').mockResolvedValue({
      items: [
        {
          id: 23,
          order_no: 'C-23',
          symbol: 'BTCUSDT_PERP',
          position_side: 'LONG',
          action: 'open',
          order_type: 'limit',
          price: '100',
          quantity: '2',
          leverage: 10,
          margin_amount: '20',
          spread_fee: '0.1',
          filled_quantity: '0.5',
          status: 'partially_filled',
        },
      ],
    });

    const result = await fetchContractOrders({
      symbol: 'BTCUSDT_PERP',
      status: 'ACTIVE',
    });

    expect(result[0]).toMatchObject({
      id: '23',
      orderId: 23,
      action: 'OPEN',
      orderType: 'LIMIT',
      status: 'PARTIALLY_FILLED',
    });
  });

  it('posts the real cancel path and normalizes the response', async () => {
    const postSpy = jest.spyOn(apiClient, 'post').mockResolvedValue({
      order_id: 17,
      status: 'canceled',
    });

    await expect(cancelContractOrder(17)).resolves.toEqual({
      orderId: 17,
      status: 'CANCELED',
    });
    expect(postSpy).toHaveBeenCalledWith('/contract/orders/17/cancel');
  });

  it('accepts an open response only with a real order id and backend success status', async () => {
    const postSpy = jest
      .spyOn(apiClient, 'post')
      .mockResolvedValue(openOrderResponse());

    await expect(
      openContractOrder({
        symbol: 'BTCUSDT_PERP',
        position_side: 'LONG',
        order_type: 'LIMIT',
        price: '100',
        quantity: '2',
        leverage: 10,
      }),
    ).resolves.toEqual({
      orderId: 31,
      orderNo: 'C-31',
      status: 'PARTIALLY_FILLED',
      positionId: 7,
    });
    expect(postSpy).toHaveBeenCalledWith('/contract/orders/open', {
      symbol: 'BTCUSDT_PERP',
      position_side: 'LONG',
      order_type: 'LIMIT',
      price: '100',
      quantity: '2',
      leverage: 10,
    });
  });

  it.each([
    ['missing', undefined],
    ['mismatched', 'm-other-client-id'],
  ])(
    'rejects an open response with %s client_order_id when the request has one',
    async (_label, responseClientOrderId) => {
      jest
        .spyOn(apiClient, 'post')
        .mockResolvedValue(
          openOrderResponse({ client_order_id: responseClientOrderId }),
        );
      await expect(
        openContractOrder({
          symbol: 'BTCUSDT_PERP',
          position_side: 'LONG',
          order_type: 'LIMIT',
          client_order_id: 'm-contract-client-id',
          price: '100',
          quantity: '2',
          leverage: 10,
        }),
      ).rejects.toMatchObject({
        code: 'INVALID_CONTRACT_ORDER_RESPONSE',
      });
    },
  );

  it('accepts and forwards an exactly echoed open client_order_id', async () => {
    const postSpy = jest
      .spyOn(apiClient, 'post')
      .mockResolvedValue(
        openOrderResponse({ client_order_id: 'm-contract-client-id' }),
      );
    await expect(
      openContractOrder({
        symbol: 'BTCUSDT_PERP',
        position_side: 'LONG',
        order_type: 'LIMIT',
        client_order_id: 'm-contract-client-id',
        price: '100',
        quantity: '2',
        leverage: 10,
      }),
    ).resolves.toMatchObject({ orderId: 31 });
    expect(postSpy).toHaveBeenCalledWith(
      '/contract/orders/open',
      expect.objectContaining({ client_order_id: 'm-contract-client-id' }),
    );
  });

  it('accepts a matching MARKET open response with a null limit price', async () => {
    jest.spyOn(apiClient, 'post').mockResolvedValue(marketOpenOrderResponse());

    await expect(
      openContractOrder({
        symbol: 'BTCUSDT_PERP',
        position_side: 'LONG',
        order_type: 'MARKET',
        quantity: '1',
        leverage: 10,
      }),
    ).resolves.toEqual({
      orderId: 31,
      orderNo: 'C-31',
      status: 'FILLED',
      positionId: 7,
    });
  });

  it.each([
    ['missing order id', marketOpenOrderResponse({ order_id: undefined })],
    ['zero order id', marketOpenOrderResponse({ order_id: 0 })],
    ['a string order id', marketOpenOrderResponse({ order_id: '31' })],
    ['a non-numeric order id', marketOpenOrderResponse({ order_id: true })],
    ['missing status', marketOpenOrderResponse({ status: undefined })],
    [
      'synthetic submitted status',
      marketOpenOrderResponse({ status: 'SUBMITTED' }),
    ],
  ])('rejects an open response with %s', async (_label, response) => {
    jest.spyOn(apiClient, 'post').mockResolvedValue(response);

    await expect(
      openContractOrder({
        symbol: 'BTCUSDT_PERP',
        position_side: 'LONG',
        order_type: 'MARKET',
        quantity: '1',
        leverage: 10,
      }),
    ).rejects.toMatchObject<Partial<ApiClientError>>({
      code: 'INVALID_CONTRACT_ORDER_RESPONSE',
    });
  });

  it.each([
    ['symbol', { symbol: 'ETHUSDT_PERP' }],
    ['position side', { position_side: 'SHORT' }],
    ['order type', { order_type: 'MARKET', price: null }],
    ['quantity', { quantity: '3' }],
    ['leverage', { leverage: 20 }],
    ['limit price', { price: '100.01' }],
  ])(
    'rejects an open response whose %s differs from the request',
    async (_label, overrides) => {
      jest
        .spyOn(apiClient, 'post')
        .mockResolvedValue(openOrderResponse(overrides));

      await expect(
        openContractOrder({
          symbol: 'BTCUSDT_PERP',
          position_side: 'LONG',
          order_type: 'LIMIT',
          price: '100',
          quantity: '2',
          leverage: 10,
        }),
      ).rejects.toMatchObject<Partial<ApiClientError>>({
        code: 'INVALID_CONTRACT_ORDER_RESPONSE',
      });
    },
  );

  it.each([
    ['order number', { order_no: '' }],
    ['symbol', { symbol: undefined }],
    ['position side', { position_side: undefined }],
    ['order type', { order_type: undefined }],
    ['price', { price: undefined }],
    ['quantity', { quantity: 2 }],
    ['leverage', { leverage: '10' }],
    ['position id', { position_id: '7' }],
  ])(
    'rejects an open response with malformed %s',
    async (_label, overrides) => {
      jest
        .spyOn(apiClient, 'post')
        .mockResolvedValue(openOrderResponse(overrides));

      await expect(
        openContractOrder({
          symbol: 'BTCUSDT_PERP',
          position_side: 'LONG',
          order_type: 'LIMIT',
          price: '100',
          quantity: '2',
          leverage: 10,
        }),
      ).rejects.toMatchObject<Partial<ApiClientError>>({
        code: 'INVALID_CONTRACT_ORDER_RESPONSE',
      });
    },
  );

  it('accepts an OPEN close response with zero filled quantity when generated orders are valid', async () => {
    jest.spyOn(apiClient, 'post').mockResolvedValue(
      closeSummaryResponse({
        order_type: 'LIMIT',
        price: '100.000000000000000000',
        closed_quantity: '0.000000000000000000',
        generated_trade_ids: [],
        status: 'open',
      }),
    );

    await expect(
      closeContractSummaryOrder({
        symbol: 'BTCUSDT_PERP',
        side: 'LONG',
        order_type: 'LIMIT',
        price: '100',
        quantity: '2',
      }),
    ).resolves.toEqual({
      orderIds: [31, 32],
      status: 'OPEN',
      requestedQuantity: '2.000000000000000000',
      closedQuantity: '0.000000000000000000',
    });
  });

  it('accepts a matching FILLED market close response', async () => {
    jest.spyOn(apiClient, 'post').mockResolvedValue(closeSummaryResponse());

    await expect(
      closeContractSummaryOrder({
        symbol: 'BTCUSDT_PERP',
        side: 'LONG',
        order_type: 'MARKET',
        quantity: '2',
      }),
    ).resolves.toEqual({
      orderIds: [31, 32],
      status: 'FILLED',
      requestedQuantity: '2.000000000000000000',
      closedQuantity: '2.000000000000000000',
    });
  });

  it.each([
    ['missing', undefined],
    ['mismatched', '101'],
  ])(
    'rejects a LIMIT close response with %s price',
    async (_label, responsePrice) => {
      jest.spyOn(apiClient, 'post').mockResolvedValue(
        closeSummaryResponse({
          order_type: 'LIMIT',
          price: responsePrice,
          closed_quantity: '0.000000000000000000',
          generated_trade_ids: [],
          status: 'open',
        }),
      );

      await expect(
        closeContractSummaryOrder({
          symbol: 'BTCUSDT_PERP',
          side: 'LONG',
          order_type: 'LIMIT',
          price: '100',
          quantity: '2',
        }),
      ).rejects.toMatchObject({
        code: 'INVALID_CONTRACT_CLOSE_RESPONSE',
      });
    },
  );

  it.each([
    ['missing', undefined],
    ['non-null', '100'],
  ])('rejects a MARKET close response with %s price', async (_label, price) => {
    jest
      .spyOn(apiClient, 'post')
      .mockResolvedValue(closeSummaryResponse({ price }));

    await expect(
      closeContractSummaryOrder({
        symbol: 'BTCUSDT_PERP',
        side: 'LONG',
        order_type: 'MARKET',
        quantity: '2',
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_CONTRACT_CLOSE_RESPONSE',
    });
  });

  it.each([
    ['missing', undefined],
    ['mismatched', 'm-other-client-id'],
  ])(
    'rejects a close response with %s client_order_id when the request has one',
    async (_label, responseClientOrderId) => {
      jest
        .spyOn(apiClient, 'post')
        .mockResolvedValue(
          closeSummaryResponse({ client_order_id: responseClientOrderId }),
        );
      await expect(
        closeContractSummaryOrder({
          symbol: 'BTCUSDT_PERP',
          side: 'LONG',
          order_type: 'MARKET',
          client_order_id: 'm-contract-close-id',
          quantity: '2',
        }),
      ).rejects.toMatchObject({
        code: 'INVALID_CONTRACT_CLOSE_RESPONSE',
      });
    },
  );

  it('accepts and forwards an exactly echoed close client_order_id', async () => {
    const postSpy = jest
      .spyOn(apiClient, 'post')
      .mockResolvedValue(
        closeSummaryResponse({ client_order_id: 'm-contract-close-id' }),
      );
    await expect(
      closeContractSummaryOrder({
        symbol: 'BTCUSDT_PERP',
        side: 'LONG',
        order_type: 'MARKET',
        client_order_id: 'm-contract-close-id',
        quantity: '2',
      }),
    ).resolves.toMatchObject({ orderIds: [31, 32] });
    expect(postSpy).toHaveBeenCalledWith(
      '/contract/orders/close-summary',
      expect.objectContaining({ client_order_id: 'm-contract-close-id' }),
    );
  });

  it.each([
    [
      'missing generated order ids',
      closeSummaryResponse({ generated_order_ids: undefined }),
    ],
    [
      'an empty generated order list',
      closeSummaryResponse({ generated_order_ids: [] }),
    ],
    [
      'a malformed generated order id',
      closeSummaryResponse({ generated_order_ids: [31, 'not-an-id'] }),
    ],
    [
      'a string generated order id',
      closeSummaryResponse({ generated_order_ids: [31, '32'] }),
    ],
    [
      'a non-numeric generated order id',
      closeSummaryResponse({ generated_order_ids: [31, true] }),
    ],
    [
      'a synthetic submitted status',
      closeSummaryResponse({ status: 'SUBMITTED' }),
    ],
  ])('rejects a close response with %s', async (_label, response) => {
    jest.spyOn(apiClient, 'post').mockResolvedValue(response);

    await expect(
      closeContractSummaryOrder({
        symbol: 'BTCUSDT_PERP',
        side: 'LONG',
        order_type: 'MARKET',
      }),
    ).rejects.toMatchObject<Partial<ApiClientError>>({
      code: 'INVALID_CONTRACT_CLOSE_RESPONSE',
    });
  });

  it.each([
    ['symbol', { symbol: 'ETHUSDT_PERP' }],
    ['side', { side: 'SHORT' }],
    ['order type', { order_type: 'LIMIT' }],
    ['requested quantity', { requested_quantity: '3' }],
  ])(
    'rejects a close response whose %s differs from the request',
    async (_label, overrides) => {
      jest
        .spyOn(apiClient, 'post')
        .mockResolvedValue(closeSummaryResponse(overrides));

      await expect(
        closeContractSummaryOrder({
          symbol: 'BTCUSDT_PERP',
          side: 'LONG',
          order_type: 'MARKET',
          quantity: '2',
        }),
      ).rejects.toMatchObject<Partial<ApiClientError>>({
        code: 'INVALID_CONTRACT_CLOSE_RESPONSE',
      });
    },
  );

  it.each([
    ['submitted quantity mismatch', { submitted_quantity: '1.5' }],
    ['closed quantity above requested', { closed_quantity: '3' }],
    ['OPEN with non-zero closed quantity', { status: 'OPEN' }],
    ['FILLED with partial closed quantity', { closed_quantity: '1' }],
    [
      'PARTIALLY_FILLED with zero closed quantity',
      { status: 'PARTIALLY_FILLED', closed_quantity: '0' },
    ],
    ['duplicate generated order ids', { generated_order_ids: [31, 31] }],
    ['missing generated trade ids', { generated_trade_ids: undefined }],
    ['missing affected position ids', { affected_position_ids: undefined }],
    ['affected position count mismatch', { affected_position_ids: [7] }],
  ])('rejects a close response with %s', async (_label, overrides) => {
    jest
      .spyOn(apiClient, 'post')
      .mockResolvedValue(closeSummaryResponse(overrides));

    await expect(
      closeContractSummaryOrder({
        symbol: 'BTCUSDT_PERP',
        side: 'LONG',
        order_type: 'MARKET',
        quantity: '2',
      }),
    ).rejects.toMatchObject<Partial<ApiClientError>>({
      code: 'INVALID_CONTRACT_CLOSE_RESPONSE',
    });
  });

  it.each([
    ['missing order id', { status: 'CANCELED' }],
    ['a different order id', { order_id: 18, status: 'CANCELED' }],
    ['a non-numeric order id', { order_id: true, status: 'CANCELED' }],
    ['missing status', { order_id: 17 }],
    ['a non-canceled status', { order_id: 17, status: 'OPEN' }],
  ])('rejects a cancel response with %s', async (_label, response) => {
    jest.spyOn(apiClient, 'post').mockResolvedValue(response);

    await expect(cancelContractOrder(17)).rejects.toMatchObject<
      Partial<ApiClientError>
    >({
      code: 'INVALID_CONTRACT_CANCEL_RESPONSE',
    });
  });

  it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid mutation id %s before transport',
    async invalidId => {
      const postSpy = jest.spyOn(apiClient, 'post');

      await expect(cancelContractOrder(invalidId)).rejects.toMatchObject<
        Partial<ApiClientError>
      >({
        code: 'INVALID_CONTRACT_ORDER_ID',
      });
      expect(postSpy).not.toHaveBeenCalled();
    },
  );

  it('patches a real position TP/SL path and verifies the echoed prices', async () => {
    const patchSpy = jest.spyOn(apiClient, 'patch').mockResolvedValue({
      position_id: 7,
      symbol: 'BTCUSDT_PERP',
      side: 'LONG',
      mark_price: '101.000000000000000000',
      take_profit_price: '110.000000000000000000',
      stop_loss_price: '95.000000000000000000',
    });

    await expect(
      updateContractPositionTpSl(position(), {
        take_profit_price: '110',
        stop_loss_price: '95',
      }),
    ).resolves.toEqual({
      positionId: 7,
      symbol: 'BTCUSDT_PERP',
      side: 'LONG',
      markPrice: '101.000000000000000000',
      takeProfitPrice: '110.000000000000000000',
      stopLossPrice: '95.000000000000000000',
    });
    expect(patchSpy).toHaveBeenCalledWith('/contract/positions/7/tp-sl', {
      take_profit_price: '110',
      stop_loss_price: '95',
    });
  });

  it('rejects a TP/SL response that cannot prove the requested mutation', async () => {
    jest.spyOn(apiClient, 'patch').mockResolvedValue({
      position_id: 7,
      symbol: 'BTCUSDT_PERP',
      side: 'LONG',
      mark_price: '101',
      take_profit_price: '111',
      stop_loss_price: null,
    });

    await expect(
      updateContractPositionTpSl(position(), {
        take_profit_price: '110',
        stop_loss_price: null,
      }),
    ).rejects.toMatchObject({code: 'INVALID_CONTRACT_TP_SL_RESPONSE'});
  });
});

describe('Contract cancel status guard', () => {
  it.each(['NEW', 'OPEN', 'PARTIALLY_FILLED'])(
    'allows backend-cancelable status %s',
    status => {
      expect(isContractOrderStatusCancelable(status)).toBe(true);
      expect(canCancelContractOrder(order({ status }))).toBe(true);
    },
  );

  it.each(['PENDING', 'FILLED', 'CANCELED', 'FAILED', ''])(
    'blocks non-cancelable status %s',
    status => {
      expect(isContractOrderStatusCancelable(status)).toBe(false);
      expect(canCancelContractOrder(order({ status }))).toBe(false);
    },
  );

  it('blocks cancelable-looking rows without a strict positive integer id', () => {
    expect(isValidContractOrderId(null)).toBe(false);
    expect(canCancelContractOrder(order({ orderId: null }))).toBe(false);
  });
});
