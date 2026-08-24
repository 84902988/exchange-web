import type {ContractOrderItem} from '../src/api/contract';
import {findAuthoritativeContractOrdersForIntent} from '../src/services/contractOrderIntent';
import {createPendingTradeIntent} from '../src/services/pendingTradeIntent';

function order(
  orderId: number,
  overrides: Partial<ContractOrderItem> = {},
): ContractOrderItem {
  return {
    id: String(orderId),
    orderId,
    symbol: 'BTCUSDT_PERP',
    positionSide: 'LONG',
    action: 'OPEN',
    orderType: 'LIMIT',
    price: '100.00',
    quantity: '1.000000',
    leverage: 10,
    marginAmount: '10',
    spreadFee: '0',
    filledQuantity: '0',
    status: 'OPEN',
    createdAt: '2026-08-01T00:00:02.000Z',
    ...overrides,
  };
}

describe('contract ambiguous order reconciliation', () => {
  it('matches a V2 open order only by its exact client order id', () => {
    const intent = createPendingTradeIntent({
      market: 'contract',
      ownerKey: '7',
      instrumentKey: 'BTCUSDT_PERP',
      createdAtMs: Date.parse('2026-08-01T00:00:00.000Z'),
      baselineIds: [11],
      payload: {
        action: 'OPEN' as const,
        symbol: 'BTCUSDT_PERP',
        positionSide: 'LONG' as const,
        orderType: 'LIMIT' as const,
        price: '100',
        quantity: '1',
        leverage: 10,
      },
    });

    expect(
      findAuthoritativeContractOrdersForIntent(
        intent,
        [
          order(11),
          order(12, {clientOrderId: intent.clientOrderId}),
        ],
        [],
      )?.map(item => item.orderId),
    ).toEqual([12]);
    expect(
      findAuthoritativeContractOrdersForIntent(
        intent,
        [order(12, {clientOrderId: 'm-different-contract-order'})],
        [],
      ),
    ).toBeNull();
  });

  it('does not resolve a legacy open intent from baseline, stale or conflicting orders', () => {
    const v2Intent = createPendingTradeIntent({
      market: 'contract',
      ownerKey: '7',
      instrumentKey: 'BTCUSDT_PERP',
      createdAtMs: Date.parse('2026-08-01T00:00:00.000Z'),
      baselineIds: [11],
      payload: {
        action: 'OPEN' as const,
        symbol: 'BTCUSDT_PERP',
        positionSide: 'LONG' as const,
        orderType: 'LIMIT' as const,
        price: '100',
        quantity: '1',
        leverage: 10,
      },
    });
    const intent = {
      version: 1 as const,
      id: 'legacy-contract-intent',
      market: v2Intent.market,
      ownerKey: v2Intent.ownerKey,
      instrumentKey: v2Intent.instrumentKey,
      payload: v2Intent.payload,
      baselineIds: v2Intent.baselineIds,
      createdAtMs: v2Intent.createdAtMs,
    };

    expect(
      findAuthoritativeContractOrdersForIntent(
        intent,
        [
          order(11),
          order(12, {quantity: '2'}),
          order(13, {createdAt: '2026-07-31T23:58:00.000Z'}),
          order(14, {createdAt: '2026-08-01T00:05:00.001Z'}),
        ],
        [],
      ),
    ).toBeNull();
  });

  it('reconciles a close-summary intent only when the new order quantities add up', () => {
    const intent = createPendingTradeIntent({
      market: 'contract',
      ownerKey: '7',
      instrumentKey: 'BTCUSDT_PERP',
      createdAtMs: Date.parse('2026-08-01T00:00:00.000Z'),
      baselineIds: [20],
      payload: {
        action: 'CLOSE' as const,
        symbol: 'BTCUSDT_PERP',
        positionSide: 'LONG' as const,
        orderType: 'MARKET' as const,
        quantity: '1.25',
      },
    });
    const first = order(21, {
      clientOrderId: intent.clientOrderId,
      action: 'CLOSE',
      orderType: 'MARKET',
      price: '--',
      quantity: '0.5',
    });
    const second = order(22, {
      clientOrderId: intent.clientOrderId,
      action: 'CLOSE',
      orderType: 'MARKET',
      price: '--',
      quantity: '0.7500',
      status: 'FILLED',
    });

    expect(
      findAuthoritativeContractOrdersForIntent(intent, [first], [second])?.map(
        item => item.orderId,
      ),
    ).toEqual([21, 22]);
    expect(
      findAuthoritativeContractOrdersForIntent(intent, [first], []),
    ).toBeNull();
  });
});
