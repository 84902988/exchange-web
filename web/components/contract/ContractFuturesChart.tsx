'use client';

import {
  type Dispatch,
  type KeyboardEvent,
  type MutableRefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { LineStyle, type IChartApi, type ISeriesApi } from 'lightweight-charts';
import {
  adaptKlines,
  makeCandle,
  makeVolume,
  toChartCandles,
  toChartVolumes,
  toLineData,
} from '@/components/spot/chart/chart.adapter';
import { getBucketStart } from '@/components/spot/chart/chart.utils';
import {
  SPOT_CHART_INITIAL_RIGHT_PADDING_BARS,
  SPOT_CHART_INITIAL_VISIBLE_BARS,
  SPOT_CHART_MA10,
  SPOT_CHART_MA30,
  SPOT_CHART_MA5,
  SPOT_CHART_RIGHT_PRICE_SCALE_MARGINS,
} from '@/components/spot/chart/chart.constants';
import { applySpotTradeUpdate } from '@/components/spot/chart/chart.realtime';
import type { CandleSeriesPoint, WsTradeMessage } from '@/components/spot/chart/chart.types';
import { calculateMA } from '@/components/spot/chart/chart.indicators';
import {
  createSpotChartInstance,
  resizeSpotChart,
} from '@/components/spot/chart/chart.setup';
import type { CandleItem, VolumeItem } from '@/components/spot/chart/chart.types';
import { getContractMarketKlines } from '@/lib/api/modules/contract';
import { getSymbolPricePrecision } from '@/lib/marketPrecision';
import {
  readContractKlineCache,
  writeContractKlineCache,
} from '@/lib/contractMarketCache';
import {
  contractMarketRealtime,
  type ContractMarketRealtimeMessage,
  type ContractMarketRealtimeStatus,
} from '@/lib/realtime/contractMarketRealtime';
import { useLocaleContext } from '@/contexts/LocaleContext';

type ContractFuturesChartProps = {
  symbol: string;
  interval: string;
  height?: number;
  marketStatus?: string | null;
  marketSessionType?: string | null;
  quoteFreshness?: string | null;
  marketRealtimeStatus?: ContractMarketRealtimeStatus;
  pricePrecision?: number | null;
  latestCandlePatchPrice?: string | number | null;
  latestPriceTimestamp?: string | number | null;
  allowLatestPriceCandlePatch?: boolean;
  latestCandlePatchMaxDeviationRatio?: number | null;
  allowRealtimeTradeCandlePatch?: boolean;
  positionOverlay?: ContractPositionOverlay | null;
  positionEntryOverlays?: PositionEntryOverlay[];
  positionTpSlOverlays?: PositionTpSlOverlay[];
};

export type ContractPositionOverlay = {
  side: 'LONG' | 'SHORT';
  liquidationPrice?: number | null;
};

export type PositionEntryOverlay = {
  id: number;
  index: number;
  side: 'LONG' | 'SHORT';
  entryPrice?: string | null;
};

export type PositionTpSlOverlay = {
  id: number;
  index: number;
  side: 'LONG' | 'SHORT';
  tpPrice?: string | null;
  slPrice?: string | null;
};

type ContractPriceLine = ReturnType<ISeriesApi<'Candlestick'>['createPriceLine']>;

const CHART_KEYBOARD_STEP = 3;
const CHART_KEYBOARD_FAST_STEP = 10;
const CONTRACT_CHART_GREEN = '#00c087';
const CONTRACT_CHART_RED = '#f6465d';
const CONTRACT_PRICE_SCALE_ZOOM_MIN = -3;
const CONTRACT_PRICE_SCALE_ZOOM_MAX = 4;
const CONTRACT_PRICE_SCALE_ZOOM_FACTOR = 1.35;
const CONTRACT_CHART_KLINE_LIMIT = 200;
const CONTRACT_CHART_HISTORY_TRIGGER_BARS = 10;
const SPOT_CHART_PRICE_SCALE_CONTROL_EVENT = 'spot-chart-price-scale-control';
const CONTRACT_LATEST_PATCH_MAX_LAG_SECONDS = 15 * 60;

function isTextControlActive() {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return false;

  const tagName = active.tagName.toLowerCase();
  return (
    tagName === 'input' ||
    tagName === 'textarea' ||
    tagName === 'select' ||
    active.isContentEditable
  );
}

function focusChartContainer(container: HTMLDivElement | null) {
  if (!container || isTextControlActive()) return;
  container.focus({ preventScroll: true });
}

function clampNumber(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function moveChartLogicalRange(
  chart: IChartApi | null,
  direction: -1 | 1,
  step: number
) {
  if (!chart) return;

  const timeScale = chart.timeScale();
  const range = timeScale.getVisibleLogicalRange();
  if (!range) return;

  timeScale.setVisibleLogicalRange({
    from: range.from + direction * step,
    to: range.to + direction * step,
  });
}

function resolveChartPricePrecision(symbol: string, explicitPrecision?: number | null) {
  return getSymbolPricePrecision(symbol, explicitPrecision) ?? 2;
}

function calculateVolumeMA(candles: CandleItem[], period: number) {
  const result: Array<{ time: number; value: number }> = [];
  const validCandles = candles.filter((item) => !item.isPlaceholder);

  if (validCandles.length < period) return result;

  for (let i = period - 1; i < validCandles.length; i += 1) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j += 1) {
      sum += validCandles[j].volume;
    }

    result.push({
      time: validCandles[i].time,
      value: Number((sum / period).toFixed(6)),
    });
  }

  return result;
}

function getLatestRealCandle(candles: CandleItem[]) {
  for (let i = candles.length - 1; i >= 0; i -= 1) {
    if (!candles[i].isPlaceholder) return candles[i];
  }
  return null;
}

function getCandleByTime(candles: CandleItem[], time: number | null) {
  if (time === null) return null;

  for (let i = candles.length - 1; i >= 0; i -= 1) {
    const candle = candles[i];
    if (!candle.isPlaceholder && candle.time === time) return candle;
  }

  return null;
}

function getIndicatorValue(items: Array<{ time: number; value: number }>, time: number | null) {
  if (time === null) return null;

  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (items[i].time === time) return items[i].value;
  }

  return null;
}

function normalizeKlinePairs(
  candles: CandleItem[],
  volumes: VolumeItem[] = [],
) {
  const volumeByTime = new Map<number, VolumeItem>();
  for (const volume of volumes) {
    if (!Number.isFinite(volume.time)) continue;
    volumeByTime.set(volume.time, volume);
  }

  const candleByTime = new Map<number, CandleItem>();
  for (const candle of candles) {
    if (!Number.isFinite(candle.time)) continue;
    candleByTime.set(candle.time, candle);
  }

  const nextCandles = Array.from(candleByTime.values()).sort((a, b) => a.time - b.time);
  const nextVolumes = nextCandles.map((candle) => {
    const sourceVolume = volumeByTime.get(candle.time);
    const value = Number.isFinite(sourceVolume?.value)
      ? Number(sourceVolume?.value)
      : candle.volume;
    return makeVolume(candle.time, value, candle.open, candle.close);
  });

  return {
    candles: nextCandles,
    volumes: nextVolumes,
  };
}

function setKlinePairState(
  refs: {
    candlesRef: MutableRefObject<CandleItem[]>;
    volumesRef: MutableRefObject<VolumeItem[]>;
    oldestTimeRef: MutableRefObject<number | null>;
  },
  setters: {
    setCandles: Dispatch<SetStateAction<CandleItem[]>>;
    setVolumes: Dispatch<SetStateAction<VolumeItem[]>>;
  },
  candles: CandleItem[],
  volumes: VolumeItem[] = [],
) {
  const normalized = normalizeKlinePairs(candles, volumes);
  refs.candlesRef.current = normalized.candles;
  refs.volumesRef.current = normalized.volumes;
  refs.oldestTimeRef.current = normalized.candles[0]?.time ?? null;
  setters.setCandles(normalized.candles);
  setters.setVolumes(normalized.volumes);
  return normalized;
}

function normalizeCrosshairTime(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isCrosshairCandleData(value: unknown): value is {
  open: number;
  high: number;
  low: number;
  close: number;
} {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return ['open', 'high', 'low', 'close'].every((key) => Number.isFinite(Number(record[key])));
}

function buildActiveCandleFromCrosshairData(
  data: unknown,
  time: number | null,
  candles: CandleItem[],
) {
  if (!isCrosshairCandleData(data) || time === null) return null;
  const matched = getCandleByTime(candles, time);

  return {
    time,
    open: Number(data.open),
    high: Number(data.high),
    low: Number(data.low),
    close: Number(data.close),
    volume: matched?.volume ?? 0,
    isPlaceholder: false,
  };
}

function formatPrice(value: number | null | undefined, precision: number) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '--';
  return value.toFixed(precision);
}

function isValidOverlayPrice(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function parseTpSlOverlayPrice(value: string | number | null | undefined) {
  const price = Number(value);
  return Number.isFinite(price) && price > 0 ? price : null;
}

function parseChartPrice(value: string | number | null | undefined) {
  if (typeof value === 'string') {
    const normalized = value.replace(/,/g, '').trim();
    const price = Number(normalized);
    return Number.isFinite(price) && price > 0 ? price : null;
  }

  const price = Number(value);
  return Number.isFinite(price) && price > 0 ? price : null;
}

function firstValidPrice(...values: Array<string | number | null | undefined>) {
  for (const value of values) {
    const price = parseChartPrice(value);
    if (price !== null) return price;
  }
  return null;
}

function formatVolume(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '--';

  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(2)}K`;
  if (abs >= 1) return value.toFixed(3);
  return value.toFixed(6);
}

function formatDisplayTime(time: number | null) {
  if (time === null) return '--';

  return new Date(time * 1000).toLocaleString('zh-CN', {
    hour12: false,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function getChangeMetrics(candle: CandleItem | null) {
  if (!candle) {
    return {
      change: null,
      changePercent: null,
    };
  }

  const change = candle.close - candle.open;
  const changePercent = candle.open !== 0 ? (change / candle.open) * 100 : null;

  return {
    change,
    changePercent,
  };
}

function toFlashChartCandles(candles: CandleItem[], flashing: boolean): CandleSeriesPoint[] {
  const latest = getLatestRealCandle(candles);
  const latestTime = latest?.time ?? null;

  return toChartCandles(candles).map((item) => {
    if (!flashing || latestTime === null || item.time !== latestTime || !('open' in item)) return item;
    const isUp = item.close >= item.open;
    const color = isUp ? '#34d399' : '#fb7185';
    return {
      ...item,
      color,
      borderColor: color,
      wickColor: color,
    };
  });
}

function displaySymbol(symbol: string) {
  return symbol.replace(/_PERP$/, '');
}

const INDEX_CONTRACT_BASES = new Set(['DJI', 'IXIC', 'NAS100', 'NDX', 'SPX', 'SPX500', 'US30', 'US500']);

function isIndexContractSymbol(symbol: string) {
  const base = displaySymbol(symbol).replace(/USDT$/, '').toUpperCase();
  return INDEX_CONTRACT_BASES.has(base);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function getRealtimePayload(message: ContractMarketRealtimeMessage) {
  if (isRecord(message.trade)) return message.trade;
  if (isRecord(message.kline)) return message.kline;
  if (isRecord(message.data)) return message.data;
  return message as Record<string, unknown>;
}

function normalizeRealtimeSymbol(
  message: ContractMarketRealtimeMessage,
  payload: Record<string, unknown>,
) {
  return String(message.symbol || payload.symbol || '').trim().toUpperCase();
}

function normalizeMilliseconds(value: unknown) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return Date.now();
  return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
}

function parseTimestampMs(value: string | number | null | undefined) {
  if (value === null || value === undefined || value === '') return null;

  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
  }

  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function getQuoteBucketTime(value: string | number | null | undefined, interval: string) {
  const timestampMs = parseTimestampMs(value);
  if (timestampMs === null) return null;
  return getBucketStart(Math.floor(timestampMs / 1000), interval);
}

function getIntervalSeconds(interval: string) {
  const normalized = String(interval || '').trim().toLowerCase();
  const match = normalized.match(/^(\d+)([mhd])$/);
  if (!match) return 60;

  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return 60;

  if (match[2] === 'h') return value * 60 * 60;
  if (match[2] === 'd') return value * 24 * 60 * 60;
  return value * 60;
}

function canPatchLatestCandleWithQuote(
  latestTime: number,
  quoteBucketTime: number | null,
  interval: string,
) {
  if (quoteBucketTime === null) return true;
  if (quoteBucketTime === latestTime) return true;

  const intervalSeconds = getIntervalSeconds(interval);
  const maxLagSeconds = Math.max(intervalSeconds * 3, CONTRACT_LATEST_PATCH_MAX_LAG_SECONDS);
  return quoteBucketTime > latestTime && quoteBucketTime - latestTime <= maxLagSeconds;
}

function extractRealtimeTradeMessage(
  message: ContractMarketRealtimeMessage,
  currentSymbol: string,
): WsTradeMessage | null {
  const payload = getRealtimePayload(message);
  const msgSymbol = normalizeRealtimeSymbol(message, payload);
  if (msgSymbol && msgSymbol !== currentSymbol.toUpperCase()) return null;

  const price = payload.price ?? payload.last_price ?? payload.close;
  if (!Number.isFinite(Number(price)) || Number(price) <= 0) return null;

  return {
    type: 'spot_trade',
    symbol: currentSymbol,
    trade: {
      price: String(price),
      amount: String(payload.amount ?? payload.qty ?? payload.quantity ?? payload.volume ?? 0),
      ts: normalizeMilliseconds(payload.ts ?? payload.time ?? payload.timestamp ?? payload.open_time),
    },
  };
}

function extractRealtimeKline(
  message: ContractMarketRealtimeMessage,
  currentSymbol: string,
  currentInterval: string,
) {
  const payload = getRealtimePayload(message);
  const msgSymbol = normalizeRealtimeSymbol(message, payload);
  if (msgSymbol && msgSymbol !== currentSymbol.toUpperCase()) return null;
  const msgInterval = String(message.interval || payload.interval || '').trim().toLowerCase();
  if (msgInterval && msgInterval !== String(currentInterval || '').trim().toLowerCase()) return null;

  const open = payload.open;
  const high = payload.high;
  const low = payload.low;
  const close = payload.close;
  const time = payload.open_time ?? payload.time ?? payload.timestamp ?? payload.ts;
  if (![open, high, low, close, time].every((value) => Number.isFinite(Number(value)))) {
    return null;
  }

  const adapted = adaptKlines([{
    open_time: normalizeMilliseconds(time),
    open: String(open),
    high: String(high),
    low: String(low),
    close: String(close),
    volume: String(payload.volume ?? payload.qty ?? payload.amount ?? 0),
  }]);
  const candle = adapted.candles[0];
  if (!candle) return null;

  return {
    candle,
    volume: adapted.volumes[0] || makeVolume(candle.time, candle.volume, candle.open, candle.close),
  };
}

function upsertRealtimeKline(
  candles: CandleItem[],
  volumes: VolumeItem[],
  candle: CandleItem,
  volume: VolumeItem,
) {
  const nextCandles = [...candles];
  const nextVolumes = [...volumes];
  const candleIndex = nextCandles.findIndex((item) => item.time === candle.time);
  const volumeIndex = nextVolumes.findIndex((item) => item.time === volume.time);

  if (candleIndex >= 0) {
    nextCandles[candleIndex] = candle;
  } else {
    nextCandles.push(candle);
  }

  if (volumeIndex >= 0) {
    nextVolumes[volumeIndex] = volume;
  } else {
    nextVolumes.push(volume);
  }

  nextCandles.sort((a, b) => a.time - b.time);
  nextVolumes.sort((a, b) => a.time - b.time);

  const normalized = normalizeKlinePairs(nextCandles, nextVolumes);
  const limitedCandles = normalized.candles.slice(-CONTRACT_CHART_KLINE_LIMIT);
  const earliestTime = limitedCandles[0]?.time ?? null;
  const limitedVolumes = earliestTime === null
    ? []
    : normalized.volumes.filter((item) => item.time >= earliestTime);
  return {
    nextCandles: limitedCandles,
    nextVolumes: limitedVolumes,
  };
}

function mergeCandlesByTime(base: CandleItem[], incoming: CandleItem[]) {
  const byTime = new Map<number, CandleItem>();
  [...base, ...incoming].forEach((item) => {
    if (!Number.isFinite(item.time)) return;
    byTime.set(item.time, item);
  });
  return Array.from(byTime.values()).sort((a, b) => a.time - b.time);
}

function mergeVolumesByTime(base: VolumeItem[], incoming: VolumeItem[]) {
  const byTime = new Map<number, VolumeItem>();
  [...base, ...incoming].forEach((item) => {
    if (!Number.isFinite(item.time)) return;
    byTime.set(item.time, item);
  });
  return Array.from(byTime.values()).sort((a, b) => a.time - b.time);
}

function syncLatestPriceToCurrentCandle(
  candles: CandleItem[],
  volumes: VolumeItem[],
  interval: string,
  price: number,
  quoteTimestamp: string | number | null | undefined,
  maxDeviationRatio?: number | null,
) {
  if (!Number.isFinite(price) || price <= 0 || !candles.length) return null;

  const nextCandles = [...candles];
  const nextVolumes = [...volumes];
  const latest = getLatestRealCandle(nextCandles);
  if (!latest) return null;

  const quoteBucketTime = getQuoteBucketTime(quoteTimestamp, interval);
  if (!canPatchLatestCandleWithQuote(latest.time, quoteBucketTime, interval)) return null;

  const candleIndex = nextCandles.findIndex((item) => item.time === latest.time);
  if (candleIndex < 0) return null;

  const current = nextCandles[candleIndex];
  if (current.isPlaceholder) return null;
  if (
    typeof maxDeviationRatio === 'number' &&
    Number.isFinite(maxDeviationRatio) &&
    maxDeviationRatio > 0 &&
    current.close > 0 &&
    Math.abs(price - current.close) / current.close > maxDeviationRatio
  ) {
    return null;
  }

  const high = Math.max(current.high, price);
  const low = Math.min(current.low, price);

  if (current.close === price && current.high === high && current.low === low) {
    return null;
  }

  const updated = makeCandle(current.time, current.open, high, low, price, current.volume);
  nextCandles[candleIndex] = updated;

  const volumeIndex = nextVolumes.findIndex((item) => item.time === current.time);
  const volumeValue = volumeIndex >= 0 ? nextVolumes[volumeIndex].value : updated.volume;
  const updatedVolume = makeVolume(current.time, volumeValue, updated.open, updated.close);
  if (volumeIndex >= 0) {
    nextVolumes[volumeIndex] = updatedVolume;
  } else {
    nextVolumes.push(updatedVolume);
  }

  nextCandles.sort((a, b) => a.time - b.time);
  nextVolumes.sort((a, b) => a.time - b.time);
  const normalized = normalizeKlinePairs(nextCandles, nextVolumes);
  return {
    nextCandles: normalized.candles,
    nextVolumes: normalized.volumes,
  };
}

export default function ContractFuturesChart({
  symbol,
  interval,
  height = 520,
  marketStatus,
  pricePrecision: explicitPricePrecision,
  marketRealtimeStatus = 'idle',
  latestCandlePatchPrice,
  latestPriceTimestamp,
  allowLatestPriceCandlePatch = true,
  latestCandlePatchMaxDeviationRatio = null,
  allowRealtimeTradeCandlePatch = true,
  positionOverlay = null,
  positionEntryOverlays = [],
  positionTpSlOverlays = [],
}: ContractFuturesChartProps) {
  const { t } = useLocaleContext();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const ma5SeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const ma10SeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const ma30SeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const volumeMa5SeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const volumeMa10SeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const latestPriceLineRef = useRef<ContractPriceLine | null>(null);
  const liqLineRef = useRef<ContractPriceLine | null>(null);
  const entryPriceLinesRef = useRef<ContractPriceLine[]>([]);
  const tpSlPriceLinesRef = useRef<ContractPriceLine[]>([]);
  const latestCloseRef = useRef<number | null>(null);
  const latestPriceLinePriceRef = useRef<number | null>(null);
  const latestPriceLineColorRef = useRef(CONTRACT_CHART_GREEN);
  const flashTimerRef = useRef<number | null>(null);
  const latestPatchRef = useRef<{
    allow: boolean;
    price: number | null;
    timestamp?: string | number | null;
    maxDeviationRatio?: number | null;
  }>({
    allow: false,
    price: null,
    timestamp: null,
    maxDeviationRatio: null,
  });
  const candlesRef = useRef<CandleItem[]>([]);
  const volumesRef = useRef<VolumeItem[]>([]);
  const positionedRef = useRef(false);
  const currentSymbolRef = useRef(symbol);
  const currentIntervalRef = useRef(interval);
  const isLoadingMoreRef = useRef(false);
  const hasMoreHistoryRef = useRef(true);
  const oldestTimeRef = useRef<number | null>(null);
  const requestedHistoryEndTimesRef = useRef<Set<number>>(new Set());
  const pendingRangeRestoreRef = useRef<{
    from: number;
    to: number;
    shift: number;
  } | null>(null);
  const suppressVisibleRangeInteractionRef = useRef(false);
  const userInteractedRef = useRef(false);

  const [candles, setCandles] = useState<CandleItem[]>([]);
  const [volumes, setVolumes] = useState<VolumeItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [hoveredTime, setHoveredTime] = useState<number | null>(null);
  const [hoveredCandle, setHoveredCandle] = useState<CandleItem | null>(null);
  const [latestCandleFlashing, setLatestCandleFlashing] = useState(false);
  const [priceZoomLevel, setPriceZoomLevel] = useState(0);

  const precision = useMemo(
    () => resolveChartPricePrecision(symbol, explicitPricePrecision),
    [explicitPricePrecision, symbol],
  );
  const ma5 = useMemo(() => calculateMA(candles, 5), [candles]);
  const ma10 = useMemo(() => calculateMA(candles, 10), [candles]);
  const ma30 = useMemo(() => calculateMA(candles, 30), [candles]);
  const volumeMa5 = useMemo(() => calculateVolumeMA(candles, 5), [candles]);
  const volumeMa10 = useMemo(() => calculateVolumeMA(candles, 10), [candles]);

  const activeCandle = useMemo(() => {
    return hoveredCandle || getCandleByTime(candles, hoveredTime) || getLatestRealCandle(candles);
  }, [candles, hoveredCandle, hoveredTime]);
  const activeTime = activeCandle?.time ?? null;
  const activeMa5 = useMemo(() => getIndicatorValue(ma5, activeTime), [activeTime, ma5]);
  const activeMa10 = useMemo(() => getIndicatorValue(ma10, activeTime), [activeTime, ma10]);
  const activeMa30 = useMemo(() => getIndicatorValue(ma30, activeTime), [activeTime, ma30]);
  const activeVolumeMa5 = useMemo(() => getIndicatorValue(volumeMa5, activeTime), [activeTime, volumeMa5]);
  const activeVolumeMa10 = useMemo(() => getIndicatorValue(volumeMa10, activeTime), [activeTime, volumeMa10]);
  const { change, changePercent } = useMemo(() => getChangeMetrics(activeCandle), [activeCandle]);
  const changePositive = (change ?? 0) >= 0;
  const changeColor = changePositive ? 'text-[#00c087]' : 'text-[#f6465d]';
  const realCandleCount = useMemo(
    () => candles.filter((item) => !item.isPlaceholder).length,
    [candles],
  );
  const emptyKlineMessage = isIndexContractSymbol(symbol)
    ? t('contractChartNoIndexKlineData', 'contracts')
    : t('contractChartNoKlineData', 'contracts');
  const clearPositionOverlayLines = useCallback(() => {
    const series = candleSeriesRef.current;

    if (series && liqLineRef.current) {
      series.removePriceLine(liqLineRef.current);
    }
    liqLineRef.current = null;
  }, []);
  const clearPositionEntryOverlayLines = useCallback(() => {
    const series = candleSeriesRef.current;
    if (series) {
      entryPriceLinesRef.current.forEach((line) => {
        series.removePriceLine(line);
      });
    }
    entryPriceLinesRef.current = [];
  }, []);
  const clearPositionTpSlOverlayLines = useCallback(() => {
    const series = candleSeriesRef.current;
    if (series) {
      tpSlPriceLinesRef.current.forEach((line) => {
        series.removePriceLine(line);
      });
    }
    tpSlPriceLinesRef.current = [];
  }, []);

  const applyPriceScaleZoom = useCallback((zoomLevel: number) => {
    const chart = chartRef.current;
    if (!chart) return;

    const priceScale = chart.priceScale('right');
    if (zoomLevel === 0) {
      priceScale.setAutoScale(true);
      priceScale.applyOptions({
        autoScale: true,
        scaleMargins: SPOT_CHART_RIGHT_PRICE_SCALE_MARGINS,
      });
      return;
    }

    const allCandles = candlesRef.current;
    const logicalRange = chart.timeScale().getVisibleLogicalRange();
    const lastIndex = Math.max(allCandles.length - 1, 0);
    const fromIndex = logicalRange
      ? clampNumber(Math.floor(logicalRange.from), 0, lastIndex)
      : Math.max(allCandles.length - SPOT_CHART_INITIAL_VISIBLE_BARS, 0);
    const toIndex = logicalRange
      ? clampNumber(Math.ceil(logicalRange.to), 0, lastIndex)
      : lastIndex;
    const visibleCandles = allCandles
      .slice(Math.min(fromIndex, toIndex), Math.max(fromIndex, toIndex) + 1)
      .filter((item) => !item.isPlaceholder);
    const candlesForRange = visibleCandles.length
      ? visibleCandles
      : allCandles.filter((item) => !item.isPlaceholder);

    if (!candlesForRange.length) return;

    const values: number[] = [];
    candlesForRange.forEach((item) => {
      values.push(item.low, item.high);
    });

    const latest = getLatestRealCandle(allCandles);
    const currentPrice = firstValidPrice(latestCandlePatchPrice, latest?.close);
    if (currentPrice !== null) values.push(currentPrice);

    const finiteValues = values.filter((value) => Number.isFinite(value) && value > 0);
    if (!finiteValues.length) return;

    let minPrice = Math.min(...finiteValues);
    let maxPrice = Math.max(...finiteValues);
    if (minPrice === maxPrice) {
      const padding = Math.max(Math.abs(maxPrice) * 0.005, 1 / Math.pow(10, precision));
      minPrice -= padding;
      maxPrice += padding;
    }

    const center = (minPrice + maxPrice) / 2;
    const baseSpan = Math.max(maxPrice - minPrice, 1 / Math.pow(10, precision));
    const paddedSpan = baseSpan * 1.24;
    const zoomFactor = Math.pow(CONTRACT_PRICE_SCALE_ZOOM_FACTOR, zoomLevel);
    const targetSpan = Math.max(paddedSpan / zoomFactor, 1 / Math.pow(10, precision));
    const rangeFrom = Math.max(center - targetSpan / 2, 0);
    const rangeTo = rangeFrom === 0 ? targetSpan : center + targetSpan / 2;

    priceScale.setAutoScale(false);
    priceScale.setVisibleRange({
      from: rangeFrom,
      to: rangeTo,
    });
  }, [latestCandlePatchPrice, precision]);

  const applyTrustedLatestPricePatch = useCallback((
    sourceCandles: CandleItem[],
    sourceVolumes: VolumeItem[],
  ) => {
    const normalized = normalizeKlinePairs(sourceCandles, sourceVolumes);
    const patch = latestPatchRef.current;
    if (!patch.allow || patch.price === null) return normalized;

    const synced = syncLatestPriceToCurrentCandle(
      normalized.candles,
      normalized.volumes,
      currentIntervalRef.current,
      patch.price,
      patch.timestamp,
      patch.maxDeviationRatio,
    );
    if (!synced) return normalized;

    return normalizeKlinePairs(synced.nextCandles, synced.nextVolumes);
  }, []);

  useEffect(() => {
    latestPatchRef.current = {
      allow: allowLatestPriceCandlePatch && marketStatus !== 'CLOSED',
      price: firstValidPrice(latestCandlePatchPrice),
      timestamp: latestPriceTimestamp,
      maxDeviationRatio: latestCandlePatchMaxDeviationRatio,
    };
  }, [
    allowLatestPriceCandlePatch,
    latestCandlePatchMaxDeviationRatio,
    latestCandlePatchPrice,
    latestPriceTimestamp,
    marketStatus,
  ]);

  const resetChartView = useCallback(() => {
    setPriceZoomLevel(0);
    applyPriceScaleZoom(0);
    suppressVisibleRangeInteractionRef.current = true;
    chartRef.current?.timeScale().scrollToRealTime();
    userInteractedRef.current = false;
    window.setTimeout(() => {
      suppressVisibleRangeInteractionRef.current = false;
    }, 0);
  }, [applyPriceScaleZoom]);

  const adjustPriceScaleZoom = useCallback((direction: -1 | 1) => {
    const nextLevel = clampNumber(
      priceZoomLevel + direction,
      CONTRACT_PRICE_SCALE_ZOOM_MIN,
      CONTRACT_PRICE_SCALE_ZOOM_MAX,
    );
    setPriceZoomLevel(nextLevel);
    applyPriceScaleZoom(nextLevel);
  }, [applyPriceScaleZoom, priceZoomLevel]);

  const setVisibleLogicalRangeSilently = useCallback((range: { from: number; to: number }) => {
    if (!chartRef.current) return;

    suppressVisibleRangeInteractionRef.current = true;
    chartRef.current.timeScale().setVisibleLogicalRange(range);
    window.setTimeout(() => {
      suppressVisibleRangeInteractionRef.current = false;
    }, 0);
  }, []);

  const loadOlderHistory = useCallback(async () => {
    if (isLoadingMoreRef.current) return;
    if (!hasMoreHistoryRef.current) return;

    const currentCandles = candlesRef.current;
    if (!currentCandles.length) return;

    const oldestTime = oldestTimeRef.current ?? currentCandles[0]?.time;
    if (!oldestTime) return;
    const requestEndTimeMs = oldestTime * 1000;
    if (requestedHistoryEndTimesRef.current.has(requestEndTimeMs)) return;

    isLoadingMoreRef.current = true;
    requestedHistoryEndTimesRef.current.add(requestEndTimeMs);
    setLoadingMore(true);

    try {
      const beforeRange = chartRef.current?.timeScale().getVisibleLogicalRange() || null;
      const requestSymbol = currentSymbolRef.current;
      const requestInterval = currentIntervalRef.current;
      const rows = await getContractMarketKlines({
        symbol: requestSymbol,
        interval: requestInterval,
        limit: CONTRACT_CHART_KLINE_LIMIT,
        endTimeMs: requestEndTimeMs,
      });
      if (
        requestSymbol !== currentSymbolRef.current ||
        requestInterval !== currentIntervalRef.current
      ) {
        return;
      }
      const adapted = adaptKlines(rows);
      const olderCandles = adapted.candles || [];
      const olderVolumes = adapted.volumes || [];

      if (!olderCandles.length) {
        hasMoreHistoryRef.current = false;
        return;
      }

      const mergedCandles = mergeCandlesByTime(olderCandles, currentCandles);
      const mergedVolumes = mergeVolumesByTime(olderVolumes, volumesRef.current);
      const normalized = applyTrustedLatestPricePatch(mergedCandles, mergedVolumes);
      const addedCount = normalized.candles.length - currentCandles.length;

      if (addedCount <= 0) {
        hasMoreHistoryRef.current = false;
        return;
      }

      if (beforeRange) {
        pendingRangeRestoreRef.current = {
          from: beforeRange.from,
          to: beforeRange.to,
          shift: addedCount,
        };
      }

      setKlinePairState(
        { candlesRef, volumesRef, oldestTimeRef },
        { setCandles, setVolumes },
        normalized.candles,
        normalized.volumes,
      );
      writeContractKlineCache(requestSymbol, requestInterval, {
        candles: normalized.candles,
        volumes: normalized.volumes,
      });

      if (olderCandles.length < CONTRACT_CHART_KLINE_LIMIT) {
        hasMoreHistoryRef.current = false;
      }
    } catch (err) {
      requestedHistoryEndTimesRef.current.delete(requestEndTimeMs);
      console.warn('[ContractFuturesChart] load older history failed:', err);
    } finally {
      isLoadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [applyTrustedLatestPricePatch]);

  useEffect(() => {
    candlesRef.current = candles;
    volumesRef.current = volumes;
    oldestTimeRef.current = candles[0]?.time ?? null;
  }, [candles, volumes]);

  useEffect(() => {
    currentSymbolRef.current = symbol;
    currentIntervalRef.current = interval;
  }, [symbol, interval]);

  useEffect(() => {
    if (!containerRef.current) return;

    const chartHeight = containerRef.current.clientHeight || height;
    const chart = createSpotChartInstance(containerRef.current, chartHeight, precision);
    chartRef.current = chart.chart;
    candleSeriesRef.current = chart.candleSeries;
    volumeSeriesRef.current = chart.volumeSeries;
    ma5SeriesRef.current = chart.ma5Series;
    ma10SeriesRef.current = chart.ma10Series;
    ma30SeriesRef.current = chart.ma30Series;
    volumeMa5SeriesRef.current = chart.volumeMa5Series;
    volumeMa10SeriesRef.current = chart.volumeMa10Series;

    const handleResize = () => resizeSpotChart(chartRef.current, containerRef.current);
    const handleCrosshairMove = (param: unknown) => {
      const crosshairParam = param as {
        point?: { x: number; y: number };
        time?: unknown;
        seriesData?: Map<unknown, unknown>;
      };
      const point = crosshairParam?.point;
      const time = normalizeCrosshairTime(crosshairParam?.time);

      if (
        !point ||
        !containerRef.current ||
        point.x < 0 ||
        point.y < 0 ||
        point.x > containerRef.current.clientWidth ||
        point.y > containerRef.current.clientHeight
      ) {
        setHoveredTime(null);
        setHoveredCandle(null);
        return;
      }

      const candleSeries = candleSeriesRef.current;
      const candleData = candleSeries && crosshairParam.seriesData
        ? crosshairParam.seriesData.get(candleSeries)
        : null;
      const active = buildActiveCandleFromCrosshairData(candleData, time, candlesRef.current);

      if (active) {
        setHoveredCandle(active);
        setHoveredTime(time);
        return;
      }

      const matched = getCandleByTime(candlesRef.current, time);
      if (matched) {
        setHoveredCandle(matched);
        setHoveredTime(time);
        return;
      }

      setHoveredTime(time);
    };

    chart.chart.subscribeCrosshairMove(handleCrosshairMove);
    window.addEventListener('resize', handleResize);
    const resizeObserver =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(handleResize)
        : null;
    resizeObserver?.observe(containerRef.current);

    return () => {
      window.removeEventListener('resize', handleResize);
      resizeObserver?.disconnect();
      chart.chart.unsubscribeCrosshairMove(handleCrosshairMove);
      clearPositionOverlayLines();
      clearPositionEntryOverlayLines();
      clearPositionTpSlOverlayLines();

      if (latestPriceLineRef.current) {
        chart.candleSeries.removePriceLine(latestPriceLineRef.current);
        latestPriceLineRef.current = null;
        latestPriceLinePriceRef.current = null;
        latestPriceLineColorRef.current = CONTRACT_CHART_GREEN;
      }

      chartRef.current?.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
      ma5SeriesRef.current = null;
      ma10SeriesRef.current = null;
      ma30SeriesRef.current = null;
      volumeMa5SeriesRef.current = null;
      volumeMa10SeriesRef.current = null;
      if (flashTimerRef.current !== null) {
        window.clearTimeout(flashTimerRef.current);
        flashTimerRef.current = null;
      }
      positionedRef.current = false;
    };
  }, [clearPositionEntryOverlayLines, clearPositionOverlayLines, clearPositionTpSlOverlayLines, height, precision]);

  useEffect(() => {
    let alive = true;
    let polling = false;

    async function loadKlines() {
      if (polling) return;
      polling = true;
      try {
        const rows = await getContractMarketKlines({
          symbol,
          interval,
          limit: CONTRACT_CHART_KLINE_LIMIT,
        });
        if (!alive) return;
        const adapted = adaptKlines(rows);
        const shouldReplaceKlines = isIndexContractSymbol(symbol);
        const nextCandles = !shouldReplaceKlines && candlesRef.current.length
          ? mergeCandlesByTime(candlesRef.current, adapted.candles)
          : adapted.candles;
        const nextVolumes = !shouldReplaceKlines && volumesRef.current.length
          ? mergeVolumesByTime(volumesRef.current, adapted.volumes)
          : adapted.volumes;
        const patched = applyTrustedLatestPricePatch(nextCandles, nextVolumes);
        const normalized = setKlinePairState(
          { candlesRef, volumesRef, oldestTimeRef },
          { setCandles, setVolumes },
          patched.candles,
          patched.volumes,
        );
        writeContractKlineCache(symbol, interval, {
          candles: normalized.candles,
          volumes: normalized.volumes,
        });
        setError('');
      } catch {
        if (!alive) return;
        setError(t('contractChartLoadFailed', 'contracts'));
      } finally {
        if (alive) setLoading(false);
        polling = false;
      }
    }

    positionedRef.current = false;
    setHoveredTime(null);
    setHoveredCandle(null);
    setLatestCandleFlashing(false);
    latestCloseRef.current = null;
    latestPriceLinePriceRef.current = null;
    latestPriceLineColorRef.current = CONTRACT_CHART_GREEN;
    hasMoreHistoryRef.current = true;
    isLoadingMoreRef.current = false;
    requestedHistoryEndTimesRef.current.clear();
    pendingRangeRestoreRef.current = null;
    suppressVisibleRangeInteractionRef.current = false;
    userInteractedRef.current = false;
    oldestTimeRef.current = null;
    setLoadingMore(false);
    setPriceZoomLevel(0);
    setError('');
    const cached = readContractKlineCache(symbol, interval);
    if (cached?.candles?.length) {
      const patched = applyTrustedLatestPricePatch(cached.candles, cached.volumes || []);
      setKlinePairState(
        { candlesRef, volumesRef, oldestTimeRef },
        { setCandles, setVolumes },
        patched.candles,
        patched.volumes,
      );
      setLoading(false);
    } else {
      setKlinePairState(
        { candlesRef, volumesRef, oldestTimeRef },
        { setCandles, setVolumes },
        [],
        [],
      );
      setLoading(true);
    }
    void loadKlines();
    if (marketRealtimeStatus === 'connected') {
      return () => {
        alive = false;
      };
    }
    const timer = window.setInterval(() => {
      void loadKlines();
    }, 1500);

    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [applyTrustedLatestPricePatch, symbol, interval, marketRealtimeStatus, t]);

  useEffect(() => {
    const applyRealtimeUpdate = (message: ContractMarketRealtimeMessage) => {
      if (marketStatus === 'CLOSED') return;

      const realtimeKline = extractRealtimeKline(message, symbol, interval);
      let updated = realtimeKline
        ? upsertRealtimeKline(
          candlesRef.current,
          volumesRef.current,
          realtimeKline.candle,
          realtimeKline.volume,
        )
        : null;

      if (!updated) {
        if (!allowRealtimeTradeCandlePatch) return;
        const tradeMessage = extractRealtimeTradeMessage(message, symbol);
        if (!tradeMessage) return;
        updated = applySpotTradeUpdate({
          message: tradeMessage,
          currentSymbol: symbol,
          currentInterval: interval,
          candles: candlesRef.current,
          volumes: volumesRef.current,
        });
      }

      if (!updated) return;

      const nextCandles = updated.nextCandles;
      const nextVolumes = updated.nextVolumes;
      const normalized = setKlinePairState(
        { candlesRef, volumesRef, oldestTimeRef },
        { setCandles, setVolumes },
        nextCandles,
        nextVolumes,
      );
      setLoading(false);
      setError('');
      writeContractKlineCache(symbol, interval, {
        candles: normalized.candles,
        volumes: normalized.volumes,
      });
    };

    const unsubscribeTrade = contractMarketRealtime.subscribe('trade', applyRealtimeUpdate);
    const unsubscribeKline = contractMarketRealtime.subscribe('kline', applyRealtimeUpdate);

    return () => {
      unsubscribeTrade();
      unsubscribeKline();
    };
  }, [allowRealtimeTradeCandlePatch, interval, marketStatus, symbol]);

  useEffect(() => {
    if (!candleSeriesRef.current || !volumeSeriesRef.current) return;

    candleSeriesRef.current.setData(toFlashChartCandles(candles, latestCandleFlashing));
    volumeSeriesRef.current.setData(toChartVolumes(volumes));
    ma5SeriesRef.current?.setData(toLineData(ma5));
    ma10SeriesRef.current?.setData(toLineData(ma10));
    ma30SeriesRef.current?.setData(toLineData(ma30));
    volumeMa5SeriesRef.current?.setData(toLineData(volumeMa5));
    volumeMa10SeriesRef.current?.setData(toLineData(volumeMa10));

    if (priceZoomLevel === 0) {
      candleSeriesRef.current.priceScale().applyOptions({
        autoScale: true,
        scaleMargins: SPOT_CHART_RIGHT_PRICE_SCALE_MARGINS,
      });
    } else {
      applyPriceScaleZoom(priceZoomLevel);
    }

    if (pendingRangeRestoreRef.current && chartRef.current) {
      const { from, to, shift } = pendingRangeRestoreRef.current;
      setVisibleLogicalRangeSilently({
        from: from + shift,
        to: to + shift,
      });
      pendingRangeRestoreRef.current = null;
      return;
    }

    if (candles.length > 0 && chartRef.current && !positionedRef.current) {
      const total = candles.length;
      setVisibleLogicalRangeSilently({
        from: Math.max(total - SPOT_CHART_INITIAL_VISIBLE_BARS, 0),
        to: total + SPOT_CHART_INITIAL_RIGHT_PADDING_BARS,
      });
      positionedRef.current = true;
    }
  }, [
    applyPriceScaleZoom,
    candles,
    latestCandleFlashing,
    ma5,
    ma10,
    ma30,
    priceZoomLevel,
    setVisibleLogicalRangeSilently,
    volumeMa5,
    volumeMa10,
    volumes,
  ]);

  useEffect(() => {
    if (!allowLatestPriceCandlePatch) return;
    if (marketStatus === 'CLOSED') return;

    const price = firstValidPrice(latestCandlePatchPrice);
    if (price === null) return;

    const synced = syncLatestPriceToCurrentCandle(
      candlesRef.current,
      volumesRef.current,
      interval,
      price,
      latestPriceTimestamp,
      latestCandlePatchMaxDeviationRatio,
    );
    if (!synced) return;

    const normalized = setKlinePairState(
      { candlesRef, volumesRef, oldestTimeRef },
      { setCandles, setVolumes },
      synced.nextCandles,
      synced.nextVolumes,
    );
    writeContractKlineCache(symbol, interval, {
      candles: normalized.candles,
      volumes: normalized.volumes,
    });
  }, [
    allowLatestPriceCandlePatch,
    candles,
    interval,
    latestCandlePatchMaxDeviationRatio,
    latestCandlePatchPrice,
    latestPriceTimestamp,
    marketStatus,
    symbol,
  ]);

  useEffect(() => {
    if (!chartRef.current) return;

    const timeScale = chartRef.current.timeScale();
    const handleVisibleRangeChange = (range: { from: number; to: number } | null) => {
      if (!range) return;

      if (!suppressVisibleRangeInteractionRef.current) {
        userInteractedRef.current = true;
      }

      if (loading) return;
      if (error) return;

      if (range.from < CONTRACT_CHART_HISTORY_TRIGGER_BARS) {
        void loadOlderHistory();
      }
    };

    timeScale.subscribeVisibleLogicalRangeChange(handleVisibleRangeChange);

    return () => {
      timeScale.unsubscribeVisibleLogicalRangeChange(handleVisibleRangeChange);
    };
  }, [loading, error, loadOlderHistory, symbol, interval]);

  useEffect(() => {
    const latest = getLatestRealCandle(candles);
    if (!latest) return;

    const previousClose = latestCloseRef.current;
    if (previousClose !== null && latest.close !== previousClose) {
      setLatestCandleFlashing(true);
      if (flashTimerRef.current !== null) {
        window.clearTimeout(flashTimerRef.current);
      }
      flashTimerRef.current = window.setTimeout(() => {
        setLatestCandleFlashing(false);
        flashTimerRef.current = null;
      }, 200);
    }
    latestCloseRef.current = latest.close;
  }, [candles]);

  useEffect(() => {
    const series = candleSeriesRef.current;
    const latest = getLatestRealCandle(candles);
    const trustedPrice = firstValidPrice(latestCandlePatchPrice);
    const price = firstValidPrice(trustedPrice, latest?.close);

    if (!series) return;
    if (price === null) {
      if (latestPriceLineRef.current) {
        series.removePriceLine(latestPriceLineRef.current);
        latestPriceLineRef.current = null;
        latestPriceLinePriceRef.current = null;
        latestPriceLineColorRef.current = CONTRACT_CHART_GREEN;
      }
      return;
    }

    const previousPrice = latestPriceLinePriceRef.current;
    const color = previousPrice === null || price === previousPrice
      ? latestPriceLineColorRef.current
      : price > previousPrice
        ? CONTRACT_CHART_GREEN
        : CONTRACT_CHART_RED;
    latestPriceLinePriceRef.current = price;
    latestPriceLineColorRef.current = color;

    if (!latestPriceLineRef.current) {
      latestPriceLineRef.current = series.createPriceLine({
        price,
        color,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: '',
      });
      return;
    }

    latestPriceLineRef.current.applyOptions({
      price,
      color,
      title: '',
    });
  }, [candles, latestCandlePatchPrice]);

  useEffect(() => {
    const series = candleSeriesRef.current;
    clearPositionOverlayLines();

    if (!series || !positionOverlay) return;

    if (isValidOverlayPrice(positionOverlay.liquidationPrice)) {
      liqLineRef.current = series.createPriceLine({
        price: positionOverlay.liquidationPrice,
        color: CONTRACT_CHART_RED,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: 'Liq',
      });
    }

    return clearPositionOverlayLines;
  }, [clearPositionOverlayLines, positionOverlay, precision, symbol]);

  useEffect(() => {
    const series = candleSeriesRef.current;
    clearPositionEntryOverlayLines();

    if (!series) return;

    positionEntryOverlays.forEach((position) => {
      const entryPrice = parseTpSlOverlayPrice(position.entryPrice);
      if (entryPrice === null) return;

      entryPriceLinesRef.current.push(
        series.createPriceLine({
          price: entryPrice,
          color: '#22c55e',
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: t('contractChartPositionLineTitle', 'contracts')
            .replace('{index}', String(position.index))
            .replace('{label}', 'Entry'),
        }),
      );
    });

    return clearPositionEntryOverlayLines;
  }, [clearPositionEntryOverlayLines, positionEntryOverlays, t]);

  useEffect(() => {
    const series = candleSeriesRef.current;
    clearPositionTpSlOverlayLines();

    if (!series) return;

    positionTpSlOverlays.forEach((position) => {
      const tpPrice = parseTpSlOverlayPrice(position.tpPrice);
      if (tpPrice !== null) {
        tpSlPriceLinesRef.current.push(
          series.createPriceLine({
            price: tpPrice,
            color: CONTRACT_CHART_GREEN,
            lineWidth: 1,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: true,
            title: t('contractChartPositionLineTitle', 'contracts')
              .replace('{index}', String(position.index))
              .replace('{label}', 'TP'),
          }),
        );
      }

      const slPrice = parseTpSlOverlayPrice(position.slPrice);
      if (slPrice !== null) {
        tpSlPriceLinesRef.current.push(
          series.createPriceLine({
            price: slPrice,
            color: CONTRACT_CHART_RED,
            lineWidth: 1,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: true,
            title: t('contractChartPositionLineTitle', 'contracts')
              .replace('{index}', String(position.index))
              .replace('{label}', 'SL'),
          }),
        );
      }
    });

    return clearPositionTpSlOverlayLines;
  }, [clearPositionTpSlOverlayLines, positionTpSlOverlays, t]);

  const handleChartKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    if (isTextControlActive()) return;

    const direction = event.key === 'ArrowLeft' ? -1 : 1;
    const step = event.shiftKey ? CHART_KEYBOARD_FAST_STEP : CHART_KEYBOARD_STEP;

    event.preventDefault();
    moveChartLogicalRange(chartRef.current, direction, step);
  }, []);

  const handleChartDoubleClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const chart = chartRef.current;
    const container = containerRef.current;
    if (!chart || !container) return;

    const rect = container.getBoundingClientRect();
    const priceScaleWidth = chart.priceScale('right').width();
    const resetZoneWidth = Math.max(priceScaleWidth + 12, 64);
    const localX = event.clientX - rect.left;

    if (localX >= rect.width - resetZoneWidth) {
      resetChartView();
    }
  }, [resetChartView]);

  useEffect(() => {
    const handlePriceScaleControl = (event: Event) => {
      const action = (event as CustomEvent<{ action?: string }>).detail?.action;
      if (action === 'zoom-in') {
        adjustPriceScaleZoom(1);
        return;
      }
      if (action === 'zoom-out') {
        adjustPriceScaleZoom(-1);
        return;
      }
      if (action === 'reset') {
        resetChartView();
      }
    };

    window.addEventListener(SPOT_CHART_PRICE_SCALE_CONTROL_EVENT, handlePriceScaleControl);
    return () => {
      window.removeEventListener(SPOT_CHART_PRICE_SCALE_CONTROL_EVENT, handlePriceScaleControl);
    };
  }, [adjustPriceScaleZoom, resetChartView]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#0b0e11] tabular-nums">
      <div className="shrink-0 border-b border-white/[0.06] bg-[#10151b]/90 px-3 py-2 text-xs shadow-[inset_0_1px_0_rgba(255,255,255,0.02)]">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
          <span className="rounded-md border border-white/[0.06] bg-white/[0.03] px-2.5 py-1 text-[11px] font-medium text-white/88 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
            {`${displaySymbol(symbol)} ${t('perpetual', 'contracts')} / ${interval}`}
          </span>
          <span className="text-[11px] text-white/42">{formatDisplayTime(activeTime)}</span>
          <Metric label="O" value={formatPrice(activeCandle?.open, precision)} />
          <Metric label="H" value={formatPrice(activeCandle?.high, precision)} />
          <Metric label="L" value={formatPrice(activeCandle?.low, precision)} />
          <Metric label="C" value={formatPrice(activeCandle?.close, precision)} className={changeColor} />
          <Metric label={t('priceChange', 'contracts')} value={formatPrice(change, precision)} className={changeColor} />
          <Metric
            label={t('priceChangePercent', 'contracts')}
            value={changePercent === null || !Number.isFinite(changePercent) ? '--' : `${changePercent.toFixed(2)}%`}
            className={changeColor}
          />
        </div>

        <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]">
          <span className="font-medium" style={{ color: SPOT_CHART_MA5 }}>
            {`MA5 ${formatPrice(activeMa5, precision)}`}
          </span>
          <span className="font-medium" style={{ color: SPOT_CHART_MA10 }}>
            {`MA10 ${formatPrice(activeMa10, precision)}`}
          </span>
          <span className="font-medium" style={{ color: SPOT_CHART_MA30 }}>
            {`MA30 ${formatPrice(activeMa30, precision)}`}
          </span>
          <span className="text-white/74">{`VOL ${formatVolume(activeCandle?.volume)}`}</span>
          <span className="text-white/52">{`VMA5 ${formatVolume(activeVolumeMa5)}`}</span>
          <span className="text-white/52">{`VMA10 ${formatVolume(activeVolumeMa10)}`}</span>
        </div>
      </div>

      <div className="relative min-h-0 flex-1">
        <div
          ref={containerRef}
          role="application"
          tabIndex={0}
          aria-label={t('contractChartAriaLabel', 'contracts')}
          className="h-full w-full outline-none"
          onKeyDown={handleChartKeyDown}
          onDoubleClick={handleChartDoubleClick}
          onMouseEnter={() => focusChartContainer(containerRef.current)}
        />
        {((loading && realCandleCount === 0) || error || realCandleCount === 0) && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-white/45">
            {error || (loading ? t('contractChartLoading', 'contracts') : emptyKlineMessage)}
          </div>
        )}
        {loadingMore && realCandleCount > 0 && (
          <div className="pointer-events-none absolute left-3 top-3 rounded border border-white/[0.08] bg-black/45 px-2 py-1 text-[11px] text-white/58">
            正在加载历史数据...
          </div>
        )}
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  className = 'text-white/76',
}: {
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-md bg-white/[0.02] px-2 py-1 text-[11px] ${className}`}>
      <span className="text-white/34">{label}</span>
      <span>{value}</span>
    </span>
  );
}
