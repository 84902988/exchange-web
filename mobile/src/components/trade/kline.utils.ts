import type {SpotKline} from '../../api/spot';

export type KlineInterval = '1m' | '5m' | '15m' | '1h' | '4h' | '1d';

export const klineIntervals: KlineInterval[] = [
  '1m',
  '5m',
  '15m',
  '1h',
  '4h',
  '1d',
];

export type NormalizedKline = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
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
    const value = Number(row[key]);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

export function normalizeKlineData(rows: Array<SpotKline | unknown>) {
  return rows
    .map(row => {
      const record = isRecord(row) ? row : {};
      const time = readNumber(record, ['openTime', 'open_time', 'timestamp', 'time']);
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
        close === null
      ) {
        return null;
      }

      const nextHigh = Math.max(open, high, low, close);
      const nextLow = Math.min(open, high, low, close);
      return {
        time: normalizeTimestamp(time),
        open,
        high: nextHigh,
        low: nextLow,
        close,
        volume: volume ?? 0,
      };
    })
    .filter((item): item is NormalizedKline => item !== null)
    .sort((a, b) => a.time - b.time);
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
  if (value === null || value === undefined || !Number.isFinite(value)) return '--';
  return value.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: precision,
  });
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
