import { describe, expect, it } from '@jest/globals';

import { buildContractPrivatePositionPageSnapshot } from './contractPrivateSnapshotPage';

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
