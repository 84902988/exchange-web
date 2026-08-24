import type {AdvancedChartIndicatorConfigV2} from '../chart/advancedChartConfig';
import type {NormalizedKline} from './kline.utils';

export type NativeIndicatorLine = Readonly<{
  key: string;
  label: string;
  values: ReadonlyArray<number | null>;
  render: 'line' | 'points';
}>;

export type NativePaneHistogram = Readonly<{
  key: 'volume' | 'macd';
  values: ReadonlyArray<number | null>;
}>;

export type NativeKlineIndicatorResult = Readonly<{
  overlayKind: AdvancedChartIndicatorConfigV2['overlay']['kind'];
  overlayLines: readonly NativeIndicatorLine[];
  paneKind: AdvancedChartIndicatorConfigV2['pane']['kind'];
  paneLines: readonly NativeIndicatorLine[];
  paneHistogram: NativePaneHistogram | null;
  paneFixedRange: readonly [number, number] | null;
  paneGuides: readonly number[];
}>;

type NullableSeries = Array<number | null>;

export function calculateNativeKlineIndicators(
  data: readonly NormalizedKline[],
  config: AdvancedChartIndicatorConfigV2,
): NativeKlineIndicatorResult {
  return {
    overlayKind: config.overlay.kind,
    overlayLines: calculateOverlay(data, config),
    paneKind: config.pane.kind,
    ...calculatePane(data, config),
  };
}

function calculateOverlay(
  data: readonly NormalizedKline[],
  config: AdvancedChartIndicatorConfigV2,
): readonly NativeIndicatorLine[] {
  const close = data.map(item => item.close);
  switch (config.overlay.kind) {
    case 'MA': {
      const length = config.overlay.params.length;
      return [line('ma', `MA(${length})`, sma(close, length))];
    }
    case 'EMA': {
      const length = config.overlay.params.length;
      return [line('ema', `EMA(${length})`, ema(close, length))];
    }
    case 'BOLL': {
      const {length, multiplier} = config.overlay.params;
      const bands = bollinger(close, length, multiplier);
      return [
        line('boll-upper', 'UP', bands.upper),
        line('boll-middle', `BOLL(${length})`, bands.middle),
        line('boll-lower', 'DN', bands.lower),
      ];
    }
    case 'SAR': {
      const {start, increment, maximum} = config.overlay.params;
      return [
        line(
          'sar',
          `SAR(${start},${increment},${maximum})`,
          parabolicSar(data, start, increment, maximum),
          'points',
        ),
      ];
    }
    case 'AVL': {
      const {length} = config.overlay.params;
      return [line('avl', length > 0 ? `AVL(${length})` : 'AVL', vwap(data, length))];
    }
    case 'SUPER': {
      const {length, multiplier} = config.overlay.params;
      return [
        line('super', `SUPER(${length},${multiplier})`, superTrend(data, length, multiplier)),
      ];
    }
  }
}

function calculatePane(
  data: readonly NormalizedKline[],
  config: AdvancedChartIndicatorConfigV2,
): Omit<NativeKlineIndicatorResult, 'overlayKind' | 'overlayLines' | 'paneKind'> {
  const close = data.map(item => item.close);
  switch (config.pane.kind) {
    case 'VOL': {
      const volumes = data.map(item => item.volume);
      return {
        paneLines: config.pane.params.showMA
          ? [
              line(
                'volume-ma',
                `MA(${config.pane.params.maLength})`,
                sma(volumes, config.pane.params.maLength),
              ),
            ]
          : [],
        paneHistogram: {key: 'volume', values: volumes},
        paneFixedRange: null,
        paneGuides: [0],
      };
    }
    case 'MACD': {
      const {fastLength, slowLength, signalLength} = config.pane.params;
      const fast = ema(close, fastLength);
      const slow = ema(close, slowLength);
      const dif = fast.map((value, index) =>
        value === null || slow[index] === null ? null : value - Number(slow[index]),
      );
      const dea = emaNullable(dif, signalLength);
      const histogram = dif.map((value, index) =>
        value === null || dea[index] === null
          ? null
          : (value - Number(dea[index])) * 2,
      );
      return {
        paneLines: [line('macd-dif', 'DIF', dif), line('macd-dea', 'DEA', dea)],
        paneHistogram: {key: 'macd', values: histogram},
        paneFixedRange: null,
        paneGuides: [0],
      };
    }
    case 'RSI': {
      const length = config.pane.params.length;
      return {
        paneLines: [line('rsi', `RSI(${length})`, rsi(close, length))],
        paneHistogram: null,
        paneFixedRange: [0, 100],
        paneGuides: [20, 50, 80],
      };
    }
    case 'KDJ': {
      const {length, kSmoothing, dSmoothing} = config.pane.params;
      const value = kdj(data, length, kSmoothing, dSmoothing);
      return {
        paneLines: [
          line('kdj-k', 'K', value.k),
          line('kdj-d', 'D', value.d),
          line('kdj-j', 'J', value.j),
        ],
        paneHistogram: null,
        paneFixedRange: [0, 100],
        paneGuides: [20, 50, 80],
      };
    }
    case 'OBV': {
      const values = obv(data);
      const {maLength} = config.pane.params;
      return {
        paneLines: [
          line('obv', 'OBV', values),
          ...(maLength > 0
            ? [line('obv-ma', `MA(${maLength})`, sma(values, maLength))]
            : []),
        ],
        paneHistogram: null,
        paneFixedRange: null,
        paneGuides: [0],
      };
    }
    case 'WR': {
      const {length} = config.pane.params;
      return {
        paneLines: [line('wr', `WR(${length})`, williamsR(data, length))],
        paneHistogram: null,
        paneFixedRange: [-100, 0],
        paneGuides: [-80, -50, -20],
      };
    }
    case 'StochRSI': {
      const {rsiLength, stochasticLength, kSmoothing, dSmoothing} =
        config.pane.params;
      const value = stochasticRsi(
        close,
        rsiLength,
        stochasticLength,
        kSmoothing,
        dSmoothing,
      );
      return {
        paneLines: [
          line('stoch-rsi-k', 'K', value.k),
          line('stoch-rsi-d', 'D', value.d),
        ],
        paneHistogram: null,
        paneFixedRange: [0, 100],
        paneGuides: [20, 50, 80],
      };
  }
}
}

function line(
  key: string,
  label: string,
  values: ReadonlyArray<number | null>,
  render: NativeIndicatorLine['render'] = 'line',
): NativeIndicatorLine {
  return {key, label, values, render};
}

export function sma(values: readonly number[], period: number): NullableSeries {
  const result: NullableSeries = Array(values.length).fill(null);
  if (period < 1) return result;
  let sum = 0;
  for (let index = 0; index < values.length; index += 1) {
    sum += values[index];
    if (index >= period) sum -= values[index - period];
    if (index >= period - 1) result[index] = sum / period;
  }
  return result;
}

export function ema(values: readonly number[], period: number): NullableSeries {
  return emaNullable(values, period);
}

function emaNullable(
  values: ReadonlyArray<number | null>,
  period: number,
): NullableSeries {
  const result: NullableSeries = Array(values.length).fill(null);
  if (period < 1) return result;
  const multiplier = 2 / (period + 1);
  let seed: number[] = [];
  let previous: number | null = null;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === null || !Number.isFinite(value)) {
      seed = [];
      previous = null;
      continue;
    }
    if (previous === null) {
      seed.push(value);
      if (seed.length < period) continue;
      if (seed.length > period) seed.shift();
      previous = seed.reduce((sum, item) => sum + item, 0) / period;
      result[index] = previous;
      continue;
    }
    previous = (value - previous) * multiplier + previous;
    result[index] = previous;
  }
  return result;
}

function bollinger(values: readonly number[], period: number, multiplier: number) {
  const middle = sma(values, period);
  const upper: NullableSeries = Array(values.length).fill(null);
  const lower: NullableSeries = Array(values.length).fill(null);
  for (let index = period - 1; index < values.length; index += 1) {
    const mean = middle[index];
    if (mean === null) continue;
    let squared = 0;
    for (let cursor = index + 1 - period; cursor <= index; cursor += 1) {
      squared += (values[cursor] - mean) ** 2;
    }
    const deviation = Math.sqrt(squared / period) * multiplier;
    upper[index] = mean + deviation;
    lower[index] = mean - deviation;
  }
  return {middle, upper, lower};
}

function parabolicSar(
  data: readonly NormalizedKline[],
  start: number,
  increment: number,
  maximum: number,
): NullableSeries {
  const result: NullableSeries = Array(data.length).fill(null);
  if (data.length === 0) return result;
  let rising = data.length < 2 || data[1].close >= data[0].close;
  let sar = rising ? data[0].low : data[0].high;
  let extreme = rising ? data[0].high : data[0].low;
  let acceleration = start;
  result[0] = sar;
  for (let index = 1; index < data.length; index += 1) {
    sar += acceleration * (extreme - sar);
    if (rising) {
      sar = Math.min(sar, data[index - 1].low, data[Math.max(0, index - 2)].low);
      if (data[index].low < sar) {
        rising = false;
        sar = extreme;
        extreme = data[index].low;
        acceleration = start;
      } else if (data[index].high > extreme) {
        extreme = data[index].high;
        acceleration = Math.min(maximum, acceleration + increment);
      }
    } else {
      sar = Math.max(sar, data[index - 1].high, data[Math.max(0, index - 2)].high);
      if (data[index].high > sar) {
        rising = true;
        sar = extreme;
        extreme = data[index].high;
        acceleration = start;
      } else if (data[index].low < extreme) {
        extreme = data[index].low;
        acceleration = Math.min(maximum, acceleration + increment);
      }
    }
    result[index] = sar;
  }
  return result;
}

function vwap(data: readonly NormalizedKline[], length: number): NullableSeries {
  if (length > 0) {
    let rollingVolume = 0;
    let rollingValue = 0;
    return data.map((item, index) => {
      const typical = (item.high + item.low + item.close) / 3;
      rollingVolume += item.volume;
      rollingValue += typical * item.volume;
      if (index >= length) {
        const retired = data[index - length];
        const retiredTypical = (retired.high + retired.low + retired.close) / 3;
        rollingVolume -= retired.volume;
        rollingValue -= retiredTypical * retired.volume;
      }
      return rollingVolume > 0 ? rollingValue / rollingVolume : typical;
    });
  }
  let volumeTotal = 0;
  let valueTotal = 0;
  return data.map(item => {
    const typical = (item.high + item.low + item.close) / 3;
    volumeTotal += item.volume;
    valueTotal += typical * item.volume;
    return volumeTotal > 0 ? valueTotal / volumeTotal : typical;
  });
}

function trueRange(data: readonly NormalizedKline[]) {
  return data.map((item, index) => {
    if (index === 0) return item.high - item.low;
    const previousClose = data[index - 1].close;
    return Math.max(
      item.high - item.low,
      Math.abs(item.high - previousClose),
      Math.abs(item.low - previousClose),
    );
  });
}

function wilder(values: readonly number[], period: number): NullableSeries {
  const result: NullableSeries = Array(values.length).fill(null);
  if (values.length < period || period < 1) return result;
  let average = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  result[period - 1] = average;
  for (let index = period; index < values.length; index += 1) {
    average = (average * (period - 1) + values[index]) / period;
    result[index] = average;
  }
  return result;
}

function superTrend(
  data: readonly NormalizedKline[],
  period: number,
  multiplier: number,
): NullableSeries {
  const atr = wilder(trueRange(data), period);
  const result: NullableSeries = Array(data.length).fill(null);
  let previousUpper: number | null = null;
  let previousLower: number | null = null;
  let previousTrend: number | null = null;
  for (let index = 0; index < data.length; index += 1) {
    const atrValue = atr[index];
    if (atrValue === null) continue;
    const midpoint = (data[index].high + data[index].low) / 2;
    const basicUpper = midpoint + multiplier * atrValue;
    const basicLower = midpoint - multiplier * atrValue;
    const previousClose = index > 0 ? data[index - 1].close : data[index].close;
    const upper: number =
      previousUpper === null || basicUpper < previousUpper || previousClose > previousUpper
        ? basicUpper
        : previousUpper;
    const lower: number =
      previousLower === null || basicLower > previousLower || previousClose < previousLower
        ? basicLower
        : previousLower;
    const trend: number =
      previousTrend === null || previousTrend === previousUpper
        ? data[index].close <= upper
          ? upper
          : lower
        : data[index].close >= lower
        ? lower
        : upper;
    result[index] = trend;
    previousUpper = upper;
    previousLower = lower;
    previousTrend = trend;
  }
  return result;
}

export function rsi(values: readonly number[], period: number): NullableSeries {
  const result: NullableSeries = Array(values.length).fill(null);
  if (values.length <= period || period < 1) return result;
  let gains = 0;
  let losses = 0;
  for (let index = 1; index <= period; index += 1) {
    const change = values[index] - values[index - 1];
    gains += Math.max(change, 0);
    losses += Math.max(-change, 0);
  }
  let averageGain = gains / period;
  let averageLoss = losses / period;
  result[period] = rsiValue(averageGain, averageLoss);
  for (let index = period + 1; index < values.length; index += 1) {
    const change = values[index] - values[index - 1];
    averageGain = (averageGain * (period - 1) + Math.max(change, 0)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(-change, 0)) / period;
    result[index] = rsiValue(averageGain, averageLoss);
  }
  return result;
}

function rsiValue(averageGain: number, averageLoss: number) {
  if (averageLoss === 0) return averageGain === 0 ? 50 : 100;
  return 100 - 100 / (1 + averageGain / averageLoss);
}

function kdj(
  data: readonly NormalizedKline[],
  period: number,
  kSmoothing: number,
  dSmoothing: number,
) {
  const k: NullableSeries = Array(data.length).fill(null);
  const d: NullableSeries = Array(data.length).fill(null);
  const j: NullableSeries = Array(data.length).fill(null);
  let previousK = 50;
  let previousD = 50;
  for (let index = period - 1; index < data.length; index += 1) {
    const window = data.slice(index + 1 - period, index + 1);
    const highest = Math.max(...window.map(item => item.high));
    const lowest = Math.min(...window.map(item => item.low));
    const range = highest - lowest;
    const rsv = range > 0 ? ((data[index].close - lowest) / range) * 100 : 50;
    previousK = ((kSmoothing - 1) * previousK + rsv) / kSmoothing;
    previousD = ((dSmoothing - 1) * previousD + previousK) / dSmoothing;
    k[index] = previousK;
    d[index] = previousD;
    j[index] = 3 * previousK - 2 * previousD;
  }
  return {k, d, j};
}

function obv(data: readonly NormalizedKline[]): number[] {
  let total = 0;
  return data.map((item, index) => {
    if (index > 0) {
      if (item.close > data[index - 1].close) total += item.volume;
      if (item.close < data[index - 1].close) total -= item.volume;
    }
    return total;
  });
}

function williamsR(data: readonly NormalizedKline[], period: number): NullableSeries {
  const result: NullableSeries = Array(data.length).fill(null);
  for (let index = period - 1; index < data.length; index += 1) {
    const window = data.slice(index + 1 - period, index + 1);
    const highest = Math.max(...window.map(item => item.high));
    const lowest = Math.min(...window.map(item => item.low));
    result[index] = highest === lowest
      ? -50
      : ((highest - data[index].close) / (highest - lowest)) * -100;
  }
  return result;
}

function stochasticRsi(
  close: readonly number[],
  rsiPeriod: number,
  stochasticPeriod: number,
  smoothK: number,
  smoothD: number,
) {
  const rsiValues = rsi(close, rsiPeriod);
  const raw: NullableSeries = Array(close.length).fill(null);
  for (let index = 0; index < rsiValues.length; index += 1) {
    const start = index + 1 - stochasticPeriod;
    if (start < 0) continue;
    const window = rsiValues.slice(start, index + 1);
    if (window.some(value => value === null)) continue;
    const values = window as number[];
    const minimum = Math.min(...values);
    const maximum = Math.max(...values);
    const current = rsiValues[index] as number;
    raw[index] = maximum === minimum ? 50 : ((current - minimum) / (maximum - minimum)) * 100;
  }
  const k = smaNullable(raw, smoothK);
  return {k, d: smaNullable(k, smoothD)};
}

function smaNullable(values: ReadonlyArray<number | null>, period: number): NullableSeries {
  const result: NullableSeries = Array(values.length).fill(null);
  for (let index = period - 1; index < values.length; index += 1) {
    const window = values.slice(index + 1 - period, index + 1);
    if (window.some(value => value === null)) continue;
    result[index] = (window as number[]).reduce((sum, value) => sum + value, 0) / period;
  }
  return result;
}
