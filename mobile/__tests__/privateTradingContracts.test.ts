import { ApiClientError } from '../src/api/client';
import {
  normalizeContractAccountSummaryPayload,
  normalizeContractOrdersPayload,
  normalizeContractOrdersPagePayload,
  normalizeContractPositionsPayload,
  normalizeContractSymbolRulesPayload,
  normalizeContractTradesPayload,
  normalizeContractTradesPagePayload,
} from '../src/api/contract';
import {
  normalizeSpotBalancesPayload,
  normalizeSpotKlinesPayload,
  normalizeSpotMyTradesPage,
  normalizeSpotMyTradesPayload,
  normalizeSpotOrdersPage,
  normalizeSpotOrdersPayload,
} from '../src/api/spot';

function expectInvalid(action: () => unknown, code: string) {
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ApiClientError);
  expect(thrown).toMatchObject({ code });
}

const spotOrderRow = {
  id: 42,
  symbol: 'BTCUSDT',
  side: 'BUY',
  order_type: 'LIMIT',
  price: '100',
  amount: '2',
  filled_amount: '0.5',
  status: 'PARTIALLY_FILLED',
  created_at: '2026-08-22T01:02:03Z',
};

const spotTradeRow = {
  trade_id: 81,
  symbol: 'BTCUSDT',
  side: 'SELL',
  price: '101',
  amount: '1.5',
  quote_amount: '151.5',
  created_at: '2026-08-22T02:03:04Z',
};

const contractPositionRow = {
  id: 7,
  symbol: 'BTCUSDT_PERP',
  side: 'LONG',
  leverage: 10,
  quantity: '2',
  entry_price: '100',
  mark_price: null,
  margin_amount: '20',
  unrealized_pnl: null,
  liquidation_price: null,
  status: 'OPEN',
  opened_at: '2026-08-22T03:04:05Z',
};

const contractOrderRow = {
  id: 17,
  symbol: 'BTCUSDT_PERP',
  position_side: 'LONG',
  action: 'OPEN',
  order_type: 'LIMIT',
  price: '100',
  quantity: '2',
  leverage: 10,
  margin_amount: '20',
  spread_fee: '0.1',
  filled_quantity: '0.5',
  status: 'PARTIALLY_FILLED',
  fail_reason: null,
  created_at: '2026-08-22T04:05:06Z',
};

const contractTradeRow = {
  id: 19,
  symbol: 'BTCUSDT_PERP',
  position_side: 'SHORT',
  action: 'CLOSE',
  price: '101',
  quantity: '1',
  notional: '101',
  leverage: 10,
  margin_amount: '10.1',
  fee_amount: '0.02',
  spread_fee: '0.01',
  realized_pnl: '-1.5',
  close_reason: 'LIQUIDATION',
  created_at: '2026-08-22T05:06:07Z',
};

describe('private trading response contracts', () => {
  it('normalizes contract list metadata without guessing whether more rows exist', () => {
    expect(
      normalizeContractOrdersPagePayload(
        { items: [contractOrderRow], total: 2, page: 1, page_size: 1 },
        'BTCUSDT_PERP',
      ),
    ).toMatchObject({
      total: 2,
      page: 1,
      pageSize: 1,
      hasMore: true,
      nextPage: 2,
    });
    expect(
      normalizeContractTradesPagePayload(
        { items: [contractTradeRow], total: 1, page: 1, page_size: 20 },
        'BTCUSDT_PERP',
      ),
    ).toMatchObject({
      total: 1,
      page: 1,
      pageSize: 20,
      hasMore: false,
      nextPage: null,
    });
  });

  it('rejects contradictory contract pagination metadata', () => {
    expectInvalid(
      () =>
        normalizeContractOrdersPagePayload(
          { items: [contractOrderRow], total: 0, page: 1, page_size: 20 },
          'BTCUSDT_PERP',
        ),
      'INVALID_CONTRACT_ORDERS_RESPONSE',
    );
    expectInvalid(
      () =>
        normalizeContractTradesPagePayload(
          { items: [], total: 10, page: 2, page_size: 20 },
          'BTCUSDT_PERP',
        ),
      'INVALID_CONTRACT_TRADES_RESPONSE',
    );
  });

  it('accepts only explicit empty item containers for list responses', () => {
    const emptySpotPayload = { symbol: 'BTCUSDT', items: [] };
    expect(normalizeSpotBalancesPayload(emptySpotPayload, 'BTCUSDT')).toEqual(
      [],
    );
    expect(normalizeSpotOrdersPayload(emptySpotPayload, 'BTCUSDT')).toEqual([]);
    expect(normalizeSpotMyTradesPayload(emptySpotPayload, 'BTCUSDT')).toEqual(
      [],
    );
    expect(
      normalizeContractPositionsPayload({ items: [] }, 'BTCUSDT_PERP'),
    ).toEqual([]);
    expect(
      normalizeContractOrdersPayload({ items: [] }, 'BTCUSDT_PERP'),
    ).toEqual([]);
    expect(
      normalizeContractTradesPayload({ items: [] }, 'BTCUSDT_PERP'),
    ).toEqual([]);
  });

  it('rejects an empty spot list when its root symbol is missing or mismatched', () => {
    for (const normalize of [
      normalizeSpotBalancesPayload,
      normalizeSpotOrdersPayload,
      normalizeSpotMyTradesPayload,
    ]) {
      expect(() => normalize({ items: [] }, 'BTCUSDT')).toThrow(ApiClientError);
      expect(() =>
        normalize({ symbol: 'ETHUSDT', items: [] }, 'BTCUSDT'),
      ).toThrow(ApiClientError);
    }
  });

  it('rejects null, missing, alternate, and wrong item containers', () => {
    for (const malformed of [null, {}, { data: [] }, { items: {} }]) {
      expectInvalid(
        () => normalizeSpotOrdersPayload(malformed, 'BTCUSDT'),
        'INVALID_SPOT_ORDERS_RESPONSE',
      );
      expectInvalid(
        () => normalizeContractPositionsPayload(malformed, 'BTCUSDT_PERP'),
        'INVALID_CONTRACT_POSITIONS_RESPONSE',
      );
    }
  });

  it('normalizes complete spot balances and rejects missing fields or another symbol', () => {
    const valid = {
      symbol: 'BTCUSDT',
      items: [
        {
          coin_symbol: 'BTC',
          available_amount: '1.25',
          frozen_amount: '0.5',
        },
      ],
    };
    expect(normalizeSpotBalancesPayload(valid, 'BTCUSDT')).toEqual([
      { coinSymbol: 'BTC', availableAmount: 1.25, frozenAmount: 0.5 },
    ]);
    expectInvalid(
      () =>
        normalizeSpotBalancesPayload(
          {
            ...valid,
            items: [{ ...valid.items[0], frozen_amount: undefined }],
          },
          'BTCUSDT',
        ),
      'INVALID_SPOT_BALANCES_RESPONSE',
    );
    expectInvalid(
      () =>
        normalizeSpotBalancesPayload(
          { ...valid, symbol: 'ETHUSDT' },
          'BTCUSDT',
        ),
      'INVALID_SPOT_BALANCES_RESPONSE',
    );
  });

  it('requires complete spot order and trade rows for the requested symbol', () => {
    expect(
      normalizeSpotOrdersPayload(
        { symbol: 'BTCUSDT', items: [spotOrderRow] },
        'BTCUSDT',
      ),
    ).toEqual([
      expect.objectContaining({
        id: '42',
        orderId: 42,
        symbol: 'BTCUSDT',
        side: 'BUY',
        createdAt: '2026-08-22T01:02:03Z',
      }),
    ]);
    expect(
      normalizeSpotMyTradesPayload(
        { symbol: 'BTCUSDT', items: [spotTradeRow] },
        'BTCUSDT',
      ),
    ).toEqual([
      expect.objectContaining({
        id: '81',
        symbol: 'BTCUSDT',
        side: 'SELL',
        createdAt: '2026-08-22T02:03:04Z',
      }),
    ]);
    expectInvalid(
      () =>
        normalizeSpotOrdersPayload(
          {
            symbol: 'BTCUSDT',
            items: [{ ...spotOrderRow, amount: undefined }],
          },
          'BTCUSDT',
        ),
      'INVALID_SPOT_ORDERS_RESPONSE',
    );
    expectInvalid(
      () =>
        normalizeSpotMyTradesPayload(
          {
            symbol: 'BTCUSDT',
            items: [{ ...spotTradeRow, symbol: 'ETHUSDT' }],
          },
          'BTCUSDT',
        ),
      'INVALID_SPOT_TRADES_RESPONSE',
    );
  });

  it('normalizes cursor pagination and keeps legacy list responses compatible', () => {
    expect(
      normalizeSpotOrdersPage(
        {
          symbol: 'BTCUSDT',
          items: [spotOrderRow],
          has_more: true,
          next_cursor: 42,
        },
        'BTCUSDT',
      ),
    ).toMatchObject({
      hasMore: true,
      nextCursor: 42,
      paginationSupported: true,
    });
    expect(
      normalizeSpotMyTradesPage(
        { symbol: 'BTCUSDT', items: [spotTradeRow] },
        'BTCUSDT',
      ),
    ).toMatchObject({
      hasMore: false,
      nextCursor: null,
      paginationSupported: false,
    });
  });

  it('fails closed when cursor pagination metadata is incomplete', () => {
    expectInvalid(
      () =>
        normalizeSpotOrdersPage(
          { symbol: 'BTCUSDT', items: [], has_more: true },
          'BTCUSDT',
        ),
      'INVALID_SPOT_ORDERS_RESPONSE',
    );
    expectInvalid(
      () =>
        normalizeSpotMyTradesPage(
          {
            symbol: 'BTCUSDT',
            items: [],
            has_more: false,
            next_cursor: 81,
          },
          'BTCUSDT',
        ),
      'INVALID_SPOT_TRADES_RESPONSE',
    );
  });

  it('requires a complete contract account instead of fabricating USDT/null values', () => {
    const valid = {
      margin_asset: 'USDT',
      available_margin: '100',
      used_margin: '5',
      frozen_margin: '2',
      position_margin: '3',
      realized_pnl: '-1',
      unrealized_pnl: null,
      equity: null,
    };
    expect(normalizeContractAccountSummaryPayload(valid)).toEqual({
      marginAsset: 'USDT',
      availableMargin: 100,
      usedMargin: 5,
      frozenMargin: 2,
      positionMargin: 3,
      realizedPnl: -1,
      unrealizedPnl: null,
      equity: null,
    });
    expectInvalid(
      () => normalizeContractAccountSummaryPayload({}),
      'INVALID_CONTRACT_ACCOUNT_RESPONSE',
    );
    expectInvalid(
      () =>
        normalizeContractAccountSummaryPayload({
          ...valid,
          margin_asset: undefined,
        }),
      'INVALID_CONTRACT_ACCOUNT_RESPONSE',
    );
    expectInvalid(
      () =>
        normalizeContractAccountSummaryPayload({
          ...valid,
          frozen_margin: undefined,
        }),
      'INVALID_CONTRACT_ACCOUNT_RESPONSE',
    );
  });

  it('requires complete positions, orders, and trades for the requested contract', () => {
    expect(
      normalizeContractPositionsPayload(
        { items: [contractPositionRow] },
        'BTCUSDT_PERP',
      ),
    ).toEqual([
      expect.objectContaining({
        id: '7',
        symbol: 'BTCUSDT_PERP',
        side: 'LONG',
        markPrice: '--',
        unrealizedPnl: '--',
        openedAt: '2026-08-22T03:04:05Z',
      }),
    ]);
    expect(
      normalizeContractOrdersPayload(
        { items: [contractOrderRow] },
        'BTCUSDT_PERP',
      ),
    ).toEqual([
      expect.objectContaining({
        id: '17',
        orderId: 17,
        action: 'OPEN',
        closeReason: null,
        createdAt: '2026-08-22T04:05:06Z',
      }),
    ]);
    expect(
      normalizeContractTradesPayload(
        { items: [contractTradeRow] },
        'BTCUSDT_PERP',
      ),
    ).toEqual([
      expect.objectContaining({
        id: '19',
        action: 'CLOSE',
        closeReason: 'LIQUIDATION',
        createdAt: '2026-08-22T05:06:07Z',
      }),
    ]);

    expectInvalid(
      () =>
        normalizeContractPositionsPayload(
          { items: [{ ...contractPositionRow, side: undefined }] },
          'BTCUSDT_PERP',
        ),
      'INVALID_CONTRACT_POSITIONS_RESPONSE',
    );
    expectInvalid(
      () =>
        normalizeContractPositionsPayload(
          { items: [{ ...contractPositionRow, symbol: 'ETHUSDT_PERP' }] },
          'BTCUSDT_PERP',
        ),
      'INVALID_CONTRACT_POSITIONS_RESPONSE',
    );
    expectInvalid(
      () =>
        normalizeContractOrdersPayload(
          { items: [{ ...contractOrderRow, quantity: undefined }] },
          'BTCUSDT_PERP',
        ),
      'INVALID_CONTRACT_ORDERS_RESPONSE',
    );
    expectInvalid(
      () =>
        normalizeContractTradesPayload(
          { items: [{ ...contractTradeRow, symbol: 'ETHUSDT_PERP' }] },
          'BTCUSDT_PERP',
        ),
      'INVALID_CONTRACT_TRADES_RESPONSE',
    );
  });
});

describe('public trading bootstrap contracts', () => {
  it('accepts complete spot Klines and rejects malformed or zero OHLC rows', () => {
    const valid = {
      symbol: 'BTCUSDT',
      items: [
        {
          open_time: 1_800_000_000_000,
          open: '100',
          high: '105',
          low: '95',
          close: '102',
          volume: '12',
        },
      ],
    };
    expect(normalizeSpotKlinesPayload(valid, 'BTCUSDT')).toEqual([
      {
        openTime: 1_800_000_000_000,
        open: 100,
        high: 105,
        low: 95,
        close: 102,
        volume: 12,
      },
    ]);
    expect(normalizeSpotKlinesPayload({ items: [] }, 'BTCUSDT')).toEqual([]);
    expectInvalid(
      () => normalizeSpotKlinesPayload({}, 'BTCUSDT'),
      'INVALID_SPOT_KLINE_RESPONSE',
    );
    expectInvalid(
      () =>
        normalizeSpotKlinesPayload(
          {
            ...valid,
            items: [{ ...valid.items[0], open: '0' }],
          },
          'BTCUSDT',
        ),
      'INVALID_SPOT_KLINE_RESPONSE',
    );
    expectInvalid(
      () =>
        normalizeSpotKlinesPayload(
          {
            ...valid,
            items: [{ ...valid.items[0], high: '90' }],
          },
          'BTCUSDT',
        ),
      'INVALID_SPOT_KLINE_RESPONSE',
    );
  });

  it('uses only explicit contract symbol rules and never invents defaults', () => {
    const valid = {
      items: [
        {
          symbol: 'BTCUSDT_PERP',
          base_asset: 'BTC',
          quote_asset: 'USDT',
          price_precision: 2,
          quantity_precision: 6,
          min_quantity: '0.001',
          max_quantity: '250',
          max_leverage: 100,
          tp_sl_trigger_price_type: 'LAST_PRICE',
        },
      ],
    };
    expect(normalizeContractSymbolRulesPayload(valid, 'BTCUSDT_PERP')).toEqual({
      symbol: 'BTCUSDT_PERP',
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      pricePrecision: 2,
      quantityPrecision: 6,
      minQuantity: 0.001,
      maxQuantity: 250,
      maxLeverage: 100,
      tpSlTriggerPriceType: 'LAST_PRICE',
    });
    expect(
      normalizeContractSymbolRulesPayload({ items: [] }, 'BTCUSDT_PERP'),
    ).toBeNull();
    expectInvalid(
      () => normalizeContractSymbolRulesPayload({}, 'BTCUSDT_PERP'),
      'INVALID_CONTRACT_SYMBOL_RULES_RESPONSE',
    );
    expectInvalid(
      () =>
        normalizeContractSymbolRulesPayload(
          {
            items: [{ ...valid.items[0], base_asset: undefined }],
          },
          'BTCUSDT_PERP',
        ),
      'INVALID_CONTRACT_SYMBOL_RULES_RESPONSE',
    );
    expectInvalid(
      () =>
        normalizeContractSymbolRulesPayload(
          {
            items: [
              { ...valid.items[0], tp_sl_trigger_price_type: 'MID_PRICE' },
            ],
          },
          'BTCUSDT_PERP',
        ),
      'INVALID_CONTRACT_SYMBOL_RULES_RESPONSE',
    );
    expectInvalid(
      () =>
        normalizeContractSymbolRulesPayload(
          {
            items: [{ ...valid.items[0], max_leverage: undefined }],
          },
          'BTCUSDT_PERP',
        ),
      'INVALID_CONTRACT_SYMBOL_RULES_RESPONSE',
    );
    expectInvalid(
      () =>
        normalizeContractSymbolRulesPayload(
          {
            items: [
              { ...valid.items[0], min_quantity: '2', max_quantity: '1' },
            ],
          },
          'BTCUSDT_PERP',
        ),
      'INVALID_CONTRACT_SYMBOL_RULES_RESPONSE',
    );
  });
});
