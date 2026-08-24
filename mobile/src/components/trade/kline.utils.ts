import type {SpotKline} from '../../api/spot';
import {formatFixedPrice} from '../../utils/format';

export type KlineInterval = '1m' | '5m' | '15m' | '1h' | '4h' | '1d';

export const klineIntervals: KlineInterval[] = [
  '1m',
  '5m',
  '15m',
  '1h',
  '4h',
  '1d',
];

const KLINE_PRICE_AXIS_WIDTH = 58;
const TARGET_CANDLE_STEP = 10;
const MIN_VISIBLE_CANDLES = 18;

export function resolveAdaptiveKlineVisibleCount({
  chartWidth,
  dataLength,
  preferredMaximum,
}: {
  chartWidth: number;
  dataLength: number;
  preferredMaximum: number;
}) {
  if (dataLength <= 0 || preferredMaximum <= 0) return 0;
  const usableWidth = Math.max(chartWidth - KLINE_PRICE_AXIS_WIDTH, 1);
  const widthCapacity = Math.max(
    MIN_VISIBLE_CANDLES,
    Math.floor(usableWidth / TARGET_CANDLE_STEP) + 1,
  );
  return Math.min(dataLength, preferredMaximum, widthCapacity);
}

export function resolveKlineDragIndex({
  candleStep,
  deltaX,
  dragStartIndex,
  maximumStartIndex,
}: {
  candleStep: number;
  deltaX: number;
  dragStartIndex: number;
  maximumStartIndex: number;
}) {
  if (!Number.isFinite(candleStep) || candleStep <= 0) {
    return Math.max(0, Math.min(maximumStartIndex, dragStartIndex));
  }
  const indexShift = Math.trunc(deltaX / candleStep);
  return Math.max(
    0,
    Math.min(maximumStartIndex, dragStartIndex - indexShift),
  );
}

export function reconcileKlineVisibleStartIndex({
  current,
  previousMax,
  nextMax,
  intervalChanged,
  previousAnchorTime = null,
  nextOpenTimes = [],
}: {
  current: number;
  previousMax: number;
  nextMax: number;
  intervalChanged: boolean;
  previousAnchorTime?: number | null;
  nextOpenTimes?: readonly number[];
}) {
  if (intervalChanged || current >= previousMax) return nextMax;
  if (previousAnchorTime !== null) {
    const anchoredIndex = nextOpenTimes.indexOf(previousAnchorTime);
    if (anchoredIndex >= 0) {
      return Math.max(0, Math.min(nextMax, anchoredIndex));
    }
  }
  return Math.max(0, Math.min(nextMax, current));
}

export type NormalizedKline = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type CandlePathInput = {
  up: boolean;
  x: number;
  highY: number;
  lowY: number;
  bodyX: number;
  bodyY: number;
  bodyWidth: number;
  bodyHeight: number;
};

export type CandlePathBuckets = {
  upWicks: string;
  downWicks: string;
  upBodies: string;
  downBodies: string;
};

type ScaleInput = {
  data: NormalizedKline[];
  width: number;
  height: number;
  priceValues?: number[];
  rightPadding?: number;
};

type ChartScales = {
  left: number;
  right: number;
  top: number;
  bottom: number;
  plotWidth: number;
  plotHeight: number;
  candleWidth: number;
  priceTicks: number[];
  timeTicks: Array<{index: number; label: string}>;
  minPrice: number;
  maxPrice: number;
  xForIndex: (index: number) => number;
  yForPrice: (price: number) => number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readNumber(row: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const raw = row[key];
    if (raw === null || raw === undefined || raw === '') continue;
    const value = Number(raw);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

export function normalizeKlineData(rows: Array<SpotKline | unknown>) {
  const byTime = new Map<number, NormalizedKline>();
  for (const row of rows) {
    const record = isRecord(row) ? row : {};
    const time = readNumber(record, [
      'openTime',
      'open_time',
      'timestamp',
      'time',
    ]);
    const open = readNumber(record, ['open']);
    const high = readNumber(record, ['high']);
    const low = readNumber(record, ['low']);
    const close = readNumber(record, ['close']);
    const volume = readNumber(record, ['volume']);

    if (
      time === null ||
      open === null ||
      high === null ||
      low === null ||
      close === null ||
      volume === null ||
      time <= 0 ||
      open <= 0 ||
      high <= 0 ||
      low <= 0 ||
      close <= 0 ||
      volume < 0 ||
      high < Math.max(open, low, close) ||
      low > Math.min(open, high, close)
    ) {
      continue;
    }

    const normalizedTime = normalizeTimestamp(time);
    if (!Number.isSafeInteger(normalizedTime) || normalizedTime <= 0) {
      continue;
    }
    byTime.set(normalizedTime, {
      time: normalizedTime,
      open,
      high,
      low,
      close,
      volume,
    });
  }
  return Array.from(byTime.values()).sort(
    (a, b) => a.time - b.time,
  );
}

export function calculateMA(data: NormalizedKline[], period: number) {
  return data.map((_, index) => {
    if (index + 1 < period) return null;
    const slice = data.slice(index + 1 - period, index + 1);
    const total = slice.reduce((sum, item) => sum + item.close, 0);
    return total / period;
  });
}

export function formatPrice(value: number | null | undefined, precision = 2) {
  return formatFixedPrice(value, precision);
}

export function formatTimeLabel(timestamp: number, interval: KlineInterval) {
  const date = new Date(normalizeTimestamp(timestamp));
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  if (interval === '1d') return `${month}/${day}`;
  return `${hour}:${minute}`;
}

export function buildChartScales({
  data,
  width,
  height,
  priceValues = [],
  rightPadding = 54,
}: ScaleInput): ChartScales {
  const left = 4;
  const right = width - rightPadding;
  const top = 8;
  const bottom = height - 22;
  const plotWidth = Math.max(right - left, 1);
  const plotHeight = Math.max(bottom - top, 1);
  const allPrices = data
    .flatMap(item => [item.high, item.low, item.open, item.close])
    .concat(priceValues)
    .filter(value => Number.isFinite(value));
  const rawMin = allPrices.length > 0 ? Math.min(...allPrices) : 0;
  const rawMax = allPrices.length > 0 ? Math.max(...allPrices) : 1;
  const rawRange = rawMax - rawMin;
  const padding = rawRange === 0 ? Math.max(Math.abs(rawMax) * 0.002, 1) : rawRange * 0.08;
  const minPrice = rawMin - padding;
  const maxPrice = rawMax + padding;
  const priceRange = Math.max(maxPrice - minPrice, 0.000001);
  const count = Math.max(data.length, 1);
  const step = count > 1 ? plotWidth / (count - 1) : plotWidth;
  const candleWidth = Math.max(2, Math.min(8, step * 0.58));
  const priceTicks = [0, 0.25, 0.5, 0.75, 1].map(
    ratio => maxPrice - priceRange * ratio,
  );
  const tickIndexes = buildTimeTickIndexes(data.length);

  return {
    left,
    right,
    top,
    bottom,
    plotWidth,
    plotHeight,
    candleWidth,
    priceTicks,
    timeTicks: tickIndexes.map(index => ({
      index,
      label: data[index] ? formatTimeLabel(data[index].time, '1m') : '',
    })),
    minPrice,
    maxPrice,
    xForIndex: (index: number) => {
      if (count <= 1) return left + plotWidth / 2;
      return left + step * index;
    },
    yForPrice: (price: number) => top + ((maxPrice - price) / priceRange) * plotHeight,
  };
}

export function buildTimeTicks(data: NormalizedKline[], interval: KlineInterval) {
  return buildTimeTickIndexes(data.length).map(index => ({
    index,
    label: data[index] ? formatTimeLabel(data[index].time, interval) : '',
  }));
}

/**
 * Collapses every candle into four reusable SVG paths. This keeps the same
 * OHLC geometry while avoiding a native Group + Line + Rect tree per candle.
 */
export function buildCandlePathBuckets(
  candles: readonly CandlePathInput[],
): CandlePathBuckets {
  const paths: Record<keyof CandlePathBuckets, string[]> = {
    upWicks: [],
    downWicks: [],
    upBodies: [],
    downBodies: [],
  };

  for (const candle of candles) {
    const wick = `M ${pathCoordinate(candle.x)} ${pathCoordinate(
      candle.highY,
    )} V ${pathCoordinate(candle.lowY)}`;
    const bodyRight = candle.bodyX + candle.bodyWidth;
    const bodyBottom = candle.bodyY + candle.bodyHeight;
    const body = `M ${pathCoordinate(candle.bodyX)} ${pathCoordinate(
      candle.bodyY,
    )} H ${pathCoordinate(bodyRight)} V ${pathCoordinate(
      bodyBottom,
    )} H ${pathCoordinate(candle.bodyX)} Z`;
    paths[candle.up ? 'upWicks' : 'downWicks'].push(wick);
    paths[candle.up ? 'upBodies' : 'downBodies'].push(body);
  }

  return {
    upWicks: paths.upWicks.join(' '),
    downWicks: paths.downWicks.join(' '),
    upBodies: paths.upBodies.join(' '),
    downBodies: paths.downBodies.join(' '),
  };
}

function buildTimeTickIndexes(length: number) {
  if (length <= 0) return [];
  if (length === 1) return [0];
  const indexes = [0, Math.floor((length - 1) / 2), length - 1];
  return Array.from(new Set(indexes));
}

function normalizeTimestamp(value: number) {
  if (!Number.isFinite(value)) return 0;
  return value < 10000000000 ? value * 1000 : value;
}

function pathCoordinate(value: number) {
  return Math.round(value * 100) / 100;
}
