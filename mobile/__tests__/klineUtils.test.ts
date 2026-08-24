import {
  buildCandlePathBuckets,
  formatPrice,
  normalizeKlineData,
  reconcileKlineVisibleStartIndex,
  resolveAdaptiveKlineVisibleCount,
  resolveKlineDragIndex,
} from '../src/components/trade/kline.utils';

describe('Kline chart data normalization', () => {
  it('keeps the backend-selected price precision when trailing digits are zero', () => {
    expect(formatPrice(76_770, 1)).toBe('76,770.0');
    expect(formatPrice(3200, 2)).toBe('3,200.00');
    expect(formatPrice(1.23, 3)).toBe('1.230');
  });

  it('accepts valid rows, normalizes seconds, sorts, and keeps the newest duplicate', () => {
    expect(
      normalizeKlineData([
        {
          time: 1_800_000_060,
          open: 102,
          high: 104,
          low: 101,
          close: 103,
          volume: 2,
        },
        {
          openTime: 1_800_000_000_000,
          open: 100,
          high: 103,
          low: 99,
          close: 102,
          volume: 1,
        },
        {
          open_time: 1_800_000_000_000,
          open: 100,
          high: 105,
          low: 98,
          close: 104,
          volume: 3,
        },
      ]),
    ).toEqual([
      {
        time: 1_800_000_000_000,
        open: 100,
        high: 105,
        low: 98,
        close: 104,
        volume: 3,
      },
      {
        time: 1_800_000_060_000,
        open: 102,
        high: 104,
        low: 101,
        close: 103,
        volume: 2,
      },
    ]);
  });

  it('fails closed for incomplete, impossible, or non-positive OHLCV rows', () => {
    const valid = {
      time: 1_800_000_000_000,
      open: 100,
      high: 105,
      low: 95,
      close: 102,
      volume: 1,
    };

    expect(
      normalizeKlineData([
        {...valid, volume: undefined},
        {...valid, open: 0},
        {...valid, volume: -1},
        {...valid, high: 99},
        {...valid, low: 103},
        {...valid, time: Number.MAX_SAFE_INTEGER + 1},
        valid,
      ]),
    ).toEqual([valid]);
  });
});

describe('Kline viewport reconciliation', () => {
  it('follows a newly appended candle only when the viewport was already latest', () => {
    expect(
      reconcileKlineVisibleStartIndex({
        current: 38,
        previousMax: 38,
        nextMax: 39,
        intervalChanged: false,
      }),
    ).toBe(39);
    expect(
      reconcileKlineVisibleStartIndex({
        current: 12,
        previousMax: 38,
        nextMax: 39,
        intervalChanged: false,
      }),
    ).toBe(12);
  });

  it('resets to latest on interval changes and clamps safely when history shrinks', () => {
    expect(
      reconcileKlineVisibleStartIndex({
        current: 12,
        previousMax: 38,
        nextMax: 20,
        intervalChanged: true,
      }),
    ).toBe(20);
    expect(
      reconcileKlineVisibleStartIndex({
        current: 12,
        previousMax: 38,
        nextMax: 8,
        intervalChanged: false,
      }),
    ).toBe(8);
  });

  it('keeps the visible timestamp anchored when a full rolling window drops its head', () => {
    const previousTimes = Array.from(
      {length: 80},
      (_, index) => 1_800_000_000_000 + index * 60_000,
    );
    const nextTimes = [
      ...previousTimes.slice(1),
      previousTimes.at(-1)! + 60_000,
    ];

    expect(
      reconcileKlineVisibleStartIndex({
        current: 12,
        previousMax: 38,
        nextMax: 38,
        intervalChanged: false,
        previousAnchorTime: previousTimes[12],
        nextOpenTimes: nextTimes,
      }),
    ).toBe(11);
  });
});

describe('Kline responsive density', () => {
  it('shows fewer candles on phones and expands the window on landscape screens', () => {
    expect(
      resolveAdaptiveKlineVisibleCount({
        chartWidth: 350,
        dataLength: 80,
        preferredMaximum: 96,
      }),
    ).toBe(30);
    expect(
      resolveAdaptiveKlineVisibleCount({
        chartWidth: 900,
        dataLength: 120,
        preferredMaximum: 96,
      }),
    ).toBe(85);
  });

  it('honors the caller maximum and never exceeds available data', () => {
    expect(
      resolveAdaptiveKlineVisibleCount({
        chartWidth: 900,
        dataLength: 20,
        preferredMaximum: 36,
      }),
    ).toBe(20);
    expect(
      resolveAdaptiveKlineVisibleCount({
        chartWidth: 900,
        dataLength: 120,
        preferredMaximum: 36,
      }),
    ).toBe(36);
  });
});

describe('Kline horizontal drag', () => {
  it('moves from latest candles to older history on a right swipe', () => {
    expect(
      resolveKlineDragIndex({
        candleStep: 10,
        deltaX: 300,
        dragStartIndex: 155,
        maximumStartIndex: 155,
      }),
    ).toBe(125);
  });

  it('moves back toward latest candles on a left swipe and clamps both ends', () => {
    expect(
      resolveKlineDragIndex({
        candleStep: 10,
        deltaX: -200,
        dragStartIndex: 80,
        maximumStartIndex: 155,
      }),
    ).toBe(100);
    expect(
      resolveKlineDragIndex({
        candleStep: 10,
        deltaX: 5_000,
        dragStartIndex: 155,
        maximumStartIndex: 155,
      }),
    ).toBe(0);
  });
});

describe('Kline SVG path batching', () => {
  it('keeps up/down OHLC geometry in four bounded paths', () => {
    const paths = buildCandlePathBuckets([
      {
        up: true,
        x: 10.126,
        highY: 2.234,
        lowY: 18.996,
        bodyX: 8,
        bodyY: 6,
        bodyWidth: 4,
        bodyHeight: 8,
      },
      {
        up: false,
        x: 20,
        highY: 3,
        lowY: 19,
        bodyX: 18,
        bodyY: 7,
        bodyWidth: 4,
        bodyHeight: 9,
      },
    ]);

    expect(paths).toEqual({
      upWicks: 'M 10.13 2.23 V 19',
      downWicks: 'M 20 3 V 19',
      upBodies: 'M 8 6 H 12 V 14 H 8 Z',
      downBodies: 'M 18 7 H 22 V 16 H 18 Z',
    });
    expect(Object.values(paths)).toHaveLength(4);
  });
});
