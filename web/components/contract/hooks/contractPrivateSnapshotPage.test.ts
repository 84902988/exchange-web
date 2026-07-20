import { describe, expect, it } from '@jest/globals';

import {
  buildContractPrivateOrderPageSnapshot,
  buildContractPrivatePositionPageSnapshot,
} from './contractPrivateSnapshotPage';

function position(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    symbol: 'BTCUSDT_PERP',
    side: 'LONG',
    leverage: 10,
    quantity: '1',
    entry_price: '100',
    mark_price: '101',
    margin_amount: '10',
    open_fee: '0',
    unrealized_pnl: '1',
    realized_pnl: '0',
    warning_price: '50',
    status: 'OPEN',
    ...overrides,
  };
}

describe('buildContractPrivatePositionPageSnapshot', () => {
  it('turns the authoritative websocket position snapshot into the visible first page', () => {
    const result = buildContractPrivatePositionPageSnapshot({
      positions: [
        position(3),
        position(2),
        position(1),
        position(4, { status: 'CLOSED' }),
        position(5, { symbol: 'ETHUSDT_PERP' }),
      ],
      symbol: 'BTCUSDT_PERP',
      page: 1,
      pageSize: 2,
    });

    expect(result.rows.map((item) => item.id)).toEqual([3, 2]);
    expect(result.total).toBe(3);
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(2);
  });

  it('does not expose closed, zero-quantity, or another symbol position', () => {
    const result = buildContractPrivatePositionPageSnapshot({
      positions: [
        position(1, { status: 'CLOSED' }),
        position(2, { quantity: '0' }),
        position(3, { symbol: 'ETHUSDT_PERP' }),
      ],
      symbol: 'BTCUSDT_PERP',
      page: 1,
      pageSize: 5,
    });

    expect(result).toEqual({ rows: [], total: 0, page: 1, pageSize: 5 });
  });
});

function order(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    order_no: `CO-${id}`,
    symbol: 'BTCUSDT_PERP',
    position_id: null,
    side: 'BUY',
    position_side: 'LONG',
    action: 'OPEN',
    order_type: 'LIMIT',
    price: '100',
    quantity: '1',
    leverage: 10,
    margin_amount: '10',
    fee_amount: '0',
    spread_fee: '0',
    filled_quantity: '0',
    avg_price: '0',
    status: 'NEW',
    fail_reason: null,
    take_profit_price: null,
    stop_loss_price: null,
    created_at: `2026-07-21T00:00:0${id}Z`,
    ...overrides,
  };
}

describe('buildContractPrivateOrderPageSnapshot', () => {
  it('projects an authoritative websocket order list into the visible active page', () => {
    const result = buildContractPrivateOrderPageSnapshot({
      orders: [
        order(1),
        order(2, { status: 'PARTIALLY_FILLED', position_side: 'SHORT' }),
        order(3, { status: 'FILLED' }),
        order(2, { status: 'PARTIALLY_FILLED', position_side: 'SHORT' }),
        order(4, { symbol: 'ETHUSDT_PERP' }),
      ],
      symbol: 'BTCUSDT_PERP',
      statusGroup: 'ACTIVE',
      filters: { position_side: 'SHORT' },
      page: 1,
      pageSize: 5,
    });

    expect(result.rows.map((item) => item.id)).toEqual([2]);
    expect(result.total).toBe(1);
  });

  it('keeps filled orders in history and paginates newest first', () => {
    const result = buildContractPrivateOrderPageSnapshot({
      orders: [
        order(1, { status: 'FILLED' }),
        order(2, { status: 'CANCELED' }),
        order(3),
      ],
      symbol: 'BTCUSDT_PERP',
      statusGroup: 'HISTORY',
      page: 1,
      pageSize: 1,
    });

    expect(result.rows.map((item) => item.id)).toEqual([2]);
    expect(result.total).toBe(2);
  });
});
