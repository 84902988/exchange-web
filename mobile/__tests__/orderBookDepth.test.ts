import {aggregateOrderBookLevels} from '../src/utils/orderBookDepth';

describe('order book depth aggregation', () => {
  it('rounds asks upward, merges the same level, and sorts highest first', () => {
    expect(
      aggregateOrderBookLevels(
        [
          {price: 100.011, amount: 1},
          {price: 100.019, amount: 2},
          {price: 99.991, amount: 4},
        ],
        'ask',
        0.01,
      ),
    ).toEqual([
      {price: 100.02, amount: 3},
      {price: 100, amount: 4},
    ]);
  });

  it('rounds bids downward and merges without mutating input rows', () => {
    const levels = [
      {price: 100.019, amount: 1},
      {price: 100.011, amount: 2},
      {price: 99.999, amount: 4},
    ];

    expect(aggregateOrderBookLevels(levels, 'bid', 0.01)).toEqual([
      {price: 100.01, amount: 3},
      {price: 99.99, amount: 4},
    ]);
    expect(levels).toEqual([
      {price: 100.019, amount: 1},
      {price: 100.011, amount: 2},
      {price: 99.999, amount: 4},
    ]);
  });

  it('filters non-finite rows from an aggregated book', () => {
    expect(
      aggregateOrderBookLevels(
        [
          {price: 10, amount: 1},
          {price: Number.NaN, amount: 2},
          {price: 11, amount: Number.POSITIVE_INFINITY},
        ],
        'ask',
        1,
      ),
    ).toEqual([{price: 10, amount: 1}]);
  });

  it('filters zero and negative price or quantity levels', () => {
    const levels = [
      {price: 10, amount: 1},
      {price: 11, amount: 0},
      {price: 12, amount: -1},
      {price: 0, amount: 2},
      {price: -1, amount: 2},
    ];

    expect(aggregateOrderBookLevels(levels, 'ask', 1)).toEqual([
      {price: 10, amount: 1},
    ]);
    expect(aggregateOrderBookLevels(levels, 'ask', 0)).toEqual([
      {price: 10, amount: 1},
    ]);
  });

  it('returns scalar copies without aggregation when the step is invalid', () => {
    const source = [{price: 10.25, amount: 3}];
    const result = aggregateOrderBookLevels(source, 'ask', 0);

    expect(result).toEqual(source);
    expect(result).not.toBe(source);
    expect(result[0]).not.toBe(source[0]);
  });

  it('preserves precision for scientific-notation depth steps', () => {
    expect(
      aggregateOrderBookLevels(
        [{price: 0.000000011, amount: 2}],
        'ask',
        1e-8,
      ),
    ).toEqual([{price: 0.00000002, amount: 2}]);
  });
});
