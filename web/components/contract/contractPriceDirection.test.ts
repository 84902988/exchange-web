import { describe, expect, it } from '@jest/globals';
import {
  advanceContractPriceDirection,
  createContractPriceDirectionState,
} from './contractPriceDirection';

describe('contract reference price direction', () => {
  it('tracks the displayed symbol and only changes on a real price move', () => {
    const initial = createContractPriceDirectionState('BTCUSDT_PERP');
    const first = advanceContractPriceDirection(initial, {
      symbol: 'BTCUSDT_PERP',
      price: '100',
    });
    const up = advanceContractPriceDirection(first, {
      symbol: 'BTCUSDT_PERP',
      price: '101',
    });
    const repeated = advanceContractPriceDirection(up, {
      symbol: 'BTCUSDT_PERP',
      price: '101',
    });
    const down = advanceContractPriceDirection(repeated, {
      symbol: 'BTCUSDT_PERP',
      price: '99',
    });

    expect(first.direction).toBe('flat');
    expect(up.direction).toBe('up');
    expect(repeated).toBe(up);
    expect(repeated.direction).toBe('up');
    expect(down.direction).toBe('down');
  });

  it('resets on a symbol switch and unavailable reference price', () => {
    const btc = advanceContractPriceDirection(
      advanceContractPriceDirection(createContractPriceDirectionState('BTCUSDT_PERP'), {
        symbol: 'BTCUSDT_PERP',
        price: '100',
      }),
      { symbol: 'BTCUSDT_PERP', price: '101' },
    );
    const eth = advanceContractPriceDirection(btc, {
      symbol: 'ETHUSDT_PERP',
      price: '3000',
    });
    const unavailable = advanceContractPriceDirection(eth, {
      symbol: 'ETHUSDT_PERP',
      price: null,
    });

    expect(eth).toEqual({
      symbol: 'ETHUSDT_PERP',
      lastPrice: 3000,
      direction: 'flat',
    });
    expect(unavailable).toEqual(createContractPriceDirectionState('ETHUSDT_PERP'));
  });
});
