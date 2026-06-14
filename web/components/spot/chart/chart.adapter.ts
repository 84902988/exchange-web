import type {
  HistogramData,
  LineData,
  UTCTimestamp,
} from 'lightweight-charts';
import type {
  CandleItem,
  CandleSeriesPoint,
  RawKlineItem,
  VolumeItem,
} from './chart.types';
import {
  isPlaceholderCandle,
  normalizeTimeToSeconds,
  toNumber,
} from './chart.utils';

export function makeCandle(
  time: number,
  open: number,
  high: number,
  low: number,
  close: number,
  volume: number
): CandleItem {
  const placeholder = isPlaceholderCandle(open, high, low, close, volume);

  if (placeholder) {
    return {
      time,
      open,
      high,
      low,
      close,
      volume,
      isPlaceholder: true,
    };
  }

  return {
    time,
    open,
    high,
    low,
    close,
    volume,
    isPlaceholder: false,
  };
}

export function makeVolume(
  time: number,
  value: number,
  open: number,
  close: number
): VolumeItem {
  return {
    time,
    value,
    color:
      close >= open
        ? 'rgba(34,197,94,0.55)'
        : 'rgba(239,68,68,0.55)',
  };
}

export function adaptKlines(raw: RawKlineItem[]) {
  const candles: CandleItem[] = raw
    .map((item) => {
      const time =
        normalizeTimeToSeconds(item.open_time) ||
        normalizeTimeToSeconds(item.time) ||
        normalizeTimeToSeconds(item.timestamp);

      if (!time) return null;

      const open = toNumber(item.open);
      const high = toNumber(item.high);
      const low = toNumber(item.low);
      const close = toNumber(item.close);
      const volume = toNumber(item.volume);

      if (![open, high, low, close].every(Number.isFinite)) return null;

      return makeCandle(time, open, high, low, close, volume);
    })
    .filter(Boolean) as CandleItem[];

  candles.sort((a, b) => a.time - b.time);

  const volumes: VolumeItem[] = candles.map((c) =>
    makeVolume(c.time, c.volume, c.open, c.close)
  );

  return { candles, volumes };
}

export function toChartCandles(candles: CandleItem[]): CandleSeriesPoint[] {
  return candles.map((c) => {
    if (c.isPlaceholder) {
      return { time: c.time as UTCTimestamp };
    }

    return {
      time: c.time as UTCTimestamp,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    };
  });
}

export function toChartVolumes(volumes: VolumeItem[]): HistogramData<UTCTimestamp>[] {
  return volumes
    .filter((v) => v.value > 0)
    .map((v) => ({
      time: v.time as UTCTimestamp,
      value: v.value,
      color: v.color,
    }));
}

export function toLineData(items: Array<{ time: number; value: number }>): LineData<UTCTimestamp>[] {
  return items.map((item) => ({
    time: item.time as UTCTimestamp,
    value: item.value,
  }));
}
