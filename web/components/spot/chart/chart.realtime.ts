import { makeCandle, makeVolume } from './chart.adapter';
import type {
  CandleItem,
  VolumeItem,
  WsTradeMessage,
} from './chart.types';
import {
  getBucketStart,
  normalizeTimeToSeconds,
  toNumber,
} from './chart.utils';

export interface ApplySpotTradeUpdateParams {
  message: WsTradeMessage;
  currentSymbol: string;
  currentInterval: string;
  candles: CandleItem[];
  volumes: VolumeItem[];
}

export interface ApplySpotTradeUpdateResult {
  nextCandles: CandleItem[];
  nextVolumes: VolumeItem[];
}

export function applySpotTradeUpdate(
  params: ApplySpotTradeUpdateParams
): ApplySpotTradeUpdateResult | null {
  const { message, currentSymbol, currentInterval, candles, volumes } = params;

  if (message.type !== 'spot_trade') return null;

  const msgSymbol = String(message.symbol || '').toUpperCase();
  if (!msgSymbol || msgSymbol !== String(currentSymbol || '').toUpperCase()) {
    return null;
  }

  const price = toNumber(message.trade?.price);
  const amount = toNumber(message.trade?.amount);
  const ts = normalizeTimeToSeconds(message.trade?.ts || Date.now());

  if (!price || !ts) return null;

  const bucketTime = getBucketStart(ts, currentInterval);

  const nextCandles = [...candles];
  const nextVolumes = [...volumes];

  const candleIndex = nextCandles.findIndex((c) => c.time === bucketTime);
  const volumeIndex = nextVolumes.findIndex((v) => v.time === bucketTime);

  if (candleIndex >= 0) {
    const oldCandle = nextCandles[candleIndex];

    const baseOpen = oldCandle.isPlaceholder ? price : oldCandle.open;
    const baseHigh = oldCandle.isPlaceholder
      ? price
      : Math.max(oldCandle.high, price);
    const baseLow = oldCandle.isPlaceholder
      ? price
      : Math.min(oldCandle.low, price);
    const baseVolume =
      (oldCandle.isPlaceholder ? 0 : oldCandle.volume) + amount;

    const updatedCandle = makeCandle(
      bucketTime,
      baseOpen,
      baseHigh,
      baseLow,
      price,
      baseVolume
    );

    nextCandles[candleIndex] = updatedCandle;

    const updatedVolume = makeVolume(
      bucketTime,
      (volumeIndex >= 0 ? nextVolumes[volumeIndex].value : 0) + amount,
      updatedCandle.open,
      updatedCandle.close
    );

    if (volumeIndex >= 0) {
      nextVolumes[volumeIndex] = updatedVolume;
    } else {
      nextVolumes.push(updatedVolume);
    }
  } else {
    const insertIndex = nextCandles.findIndex((c) => c.time > bucketTime);

    const newCandle = makeCandle(
      bucketTime,
      price,
      price,
      price,
      price,
      amount
    );

    if (insertIndex === -1) {
      nextCandles.push(newCandle);
    } else {
      nextCandles.splice(insertIndex, 0, newCandle);
    }

    nextVolumes.push(
      makeVolume(bucketTime, amount, newCandle.open, newCandle.close)
    );
  }

  nextCandles.sort((a, b) => a.time - b.time);
  nextVolumes.sort((a, b) => a.time - b.time);

  return {
    nextCandles,
    nextVolumes,
  };
}
