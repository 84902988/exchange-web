import {
  getContractTradeEventTimeMs,
  orderContractTradesNewestFirst,
} from './contractTradeOrdering';

describe('Contract trade authority ordering', () => {
  it('uses event time instead of REST or WS input order', () => {
    const older = { id: 'older', price: '100', qty: '1', time: 1_720_000_000_000 };
    const newest = {
      id: 'newest',
      price: '102',
      qty: '1',
      event_time_ms: 1_720_000_002_000,
    };
    const middle = { id: 'middle', price: '101', qty: '1', ts: 1_720_000_001 };

    expect(orderContractTradesNewestFirst([older, newest, middle])).toEqual([
      newest,
      middle,
      older,
    ]);
  });

  it('deduplicates by provider trade id while keeping the newest event', () => {
    const staleDuplicate = { id: 'trade-1', price: '100', qty: '1', time: 1000 };
    const newest = { id: 'trade-1', price: '101', qty: '1', time: 2000 };

    expect(orderContractTradesNewestFirst([staleDuplicate, newest])).toEqual([newest]);
  });

  it('never lets a missing or malformed timestamp outrank valid provider evidence', () => {
    const malformed = { id: 'bad', price: '999', qty: '1', time: 'not-a-time' };
    const valid = { id: 'good', price: '100', qty: '1', time: 1_720_000_000_000 };

    expect(orderContractTradesNewestFirst([malformed, valid])).toEqual([valid, malformed]);
    expect(getContractTradeEventTimeMs(malformed)).toBeNull();
  });

  it('keeps deterministic input order for equal timestamps and applies the limit', () => {
    const first = { id: 'first', price: '100', qty: '1', time: 1_720_000_000_000 };
    const second = { id: 'second', price: '101', qty: '1', time: 1_720_000_000_000 };

    expect(orderContractTradesNewestFirst([first, second], 1)).toEqual([first]);
  });
});
