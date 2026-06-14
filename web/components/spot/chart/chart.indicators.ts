import type { CandleItem } from './chart.types';

export function calculateMA(candles: CandleItem[], period: number) {
  const result: Array<{ time: number; value: number }> = [];
  const validCandles = candles.filter((c) => !c.isPlaceholder);

  if (validCandles.length < period) return result;

  for (let i = period - 1; i < validCandles.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      sum += validCandles[j].close;
    }

    result.push({
      time: validCandles[i].time,
      value: Number((sum / period).toFixed(6)),
    });
  }

  return result;
}