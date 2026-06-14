'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LineStyle, type IChartApi, type ISeriesApi } from 'lightweight-charts';
import { useLocaleContext } from '@/contexts/LocaleContext';
import type {
  CandleItem,
  CandleSeriesPoint,
  SpotChartProps,
  VolumeItem,
  WsTradeMessage,
} from './chart/chart.types';
import {
  adaptKlines,
  toChartCandles,
  toChartVolumes,
  toLineData,
} from './chart/chart.adapter';
import {
  SPOT_CHART_BG,
  SPOT_CHART_INITIAL_RIGHT_PADDING_BARS,
  SPOT_CHART_INITIAL_VISIBLE_BARS,
  SPOT_CHART_MA10,
  SPOT_CHART_MA30,
  SPOT_CHART_MA5,
  SPOT_CHART_RIGHT_PRICE_SCALE_MARGINS,
  SPOT_CHART_TEXT,
} from './chart/chart.constants';
import { getBucketStart, getIntervalSeconds } from './chart/chart.utils';
import { calculateMA } from './chart/chart.indicators';
import { applySpotTradeUpdate } from './chart/chart.realtime';
import {
  createSpotChartInstance,
  resizeSpotChart,
} from './chart/chart.setup';
import {
  getSpotKlines,
  isPollingSpotDataSource,
} from '@/lib/api/modules/spot';
import { readMarketCache, writeMarketCache } from '@/lib/marketCache';
import { getSpotSymbolPricePrecision } from '@/lib/marketPrecision';
import { type RealtimePriceDirection } from './spotTickerColor';
import {
  spotMarketRealtime,
  type SpotMarketRealtimeMessage,
} from '@/services/marketRealtime';
import { getReferenceOverlay } from '@/lib/api/modules/market';
import ReferenceOverlayBadge from './ReferenceOverlayBadge';
import { formatSpotDisplaySymbol } from './spotFormat';
import {
  getReferenceOverlayConfig,
  normalizeReferenceOverlayConfig,
} from './chart/referenceOverlay';

const EXTERNAL_CHART_POLL_MS = 1500;
const CHART_KEYBOARD_STEP = 3;
const CHART_KEYBOARD_FAST_STEP = 10;
const REFERENCE_OVERLAY_PRICE_PRECISION = 4;
const SPOT_LAST_PRICE_FLAT = '#8A919E';
const PRICE_SCALE_ZOOM_MIN = -3;
const PRICE_SCALE_ZOOM_MAX = 4;
const PRICE_SCALE_ZOOM_FACTOR = 1.35;
const SPOT_CHART_PRICE_SCALE_CONTROL_EVENT = 'spot-chart-price-scale-control';
const REFERENCE_OVERLAY_FALLBACK_CANDLE_COUNT = 20;

interface SpotChartRealtimeConnection {
  close: () => void;
}

type SpotChartWsSnapshotMessage = {
  type: 'spot_market_snapshot';
  symbol?: string;
};

type SpotChartWsMessage = WsTradeMessage | SpotChartWsSnapshotMessage;

type SpotChartCache = {
  symbol?: string;
  candles?: CandleItem[];
  volumes?: VolumeItem[];
  updatedAt?: number;
};

function readCurrentChartCache(symbol: string): SpotChartCache | null {
  const normalizedSymbol = String(symbol || '').trim().toUpperCase();
  const cached = readMarketCache<SpotChartCache>('spot', normalizedSymbol);
  if (!cached) return null;
  if (String(cached.symbol || '').trim().toUpperCase() !== normalizedSymbol) return null;
  return cached;
}

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

function getSpotChartPriceScaleMargins(showReferenceLine: boolean) {
  return showReferenceLine
    ? { top: 0.05, bottom: 0.42 }
    : SPOT_CHART_RIGHT_PRICE_SCALE_MARGINS;
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

function createInternalSpotChartRealtimeConnection(params: {
  symbol: string;
  destroyedRef: React.MutableRefObject<boolean>;
  onTradeMessage: (message: SpotChartWsMessage) => void;
}): SpotChartRealtimeConnection {
  let closed = false;

  const handleMessage = (message: SpotMarketRealtimeMessage) => {
    if (closed || params.destroyedRef.current) return;
    params.onTradeMessage(message as SpotChartWsMessage);
  };

  spotMarketRealtime.setSymbol(params.symbol);
  spotMarketRealtime.subscribe('snapshot', handleMessage);
  spotMarketRealtime.subscribe('trade', handleMessage);

  return {
    close: () => {
      closed = true;
      spotMarketRealtime.unsubscribe('snapshot', handleMessage);
      spotMarketRealtime.unsubscribe('trade', handleMessage);
    },
  };
}

function createExternalSpotChartPollingConnection(params: {
  symbol: string;
  interval: string;
  destroyedRef: React.MutableRefObject<boolean>;
  onKlines: (candles: CandleItem[], volumes: VolumeItem[]) => void;
}): SpotChartRealtimeConnection {
  let closed = false;
  let polling = false;
  let pollTimer: number | null = null;

  const syncLatestKlines = async () => {
    if (closed || polling || params.destroyedRef.current) return;

    polling = true;

    try {
      const payload = await getSpotKlines({
        symbol: params.symbol,
        interval: params.interval,
        limit: 200,
      });

      if (closed || params.destroyedRef.current) return;

      const result = adaptKlines(payload?.items || []);
      params.onKlines(result.candles, result.volumes);
    } catch (err) {
      if (!closed && !params.destroyedRef.current) {
        console.warn('[SpotChart] external kline polling failed:', err);
      }
    } finally {
      polling = false;
    }
  };

  void syncLatestKlines();
  pollTimer = window.setInterval(() => {
    void syncLatestKlines();
  }, EXTERNAL_CHART_POLL_MS);

  return {
    close: () => {
      closed = true;

      if (pollTimer !== null) {
        window.clearInterval(pollTimer);
        pollTimer = null;
      }
    },
  };
}

function mergeCandlesByTime(older: CandleItem[], current: CandleItem[]): CandleItem[] {
  const map = new Map<number, CandleItem>();

  for (const item of older) {
    map.set(item.time, item);
  }

  for (const item of current) {
    map.set(item.time, item);
  }

  return Array.from(map.values()).sort((a, b) => a.time - b.time);
}

function mergeVolumesByTime(older: VolumeItem[], current: VolumeItem[]): VolumeItem[] {
  const map = new Map<number, VolumeItem>();

  for (const item of older) {
    map.set(item.time, item);
  }

  for (const item of current) {
    map.set(item.time, item);
  }

  return Array.from(map.values()).sort((a, b) => a.time - b.time);
}

function calculateVolumeMA(candles: CandleItem[], period: number) {
  const result: Array<{ time: number; value: number }> = [];
  const validCandles = candles.filter((c) => !c.isPlaceholder);

  if (validCandles.length < period) return result;

  for (let i = period - 1; i < validCandles.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) {
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
    if (!candles[i].isPlaceholder) {
      return candles[i];
    }
  }

  return null;
}

function getCandleByTime(candles: CandleItem[], time: number | null) {
  if (time === null) return null;

  for (let i = candles.length - 1; i >= 0; i -= 1) {
    const candle = candles[i];
    if (!candle.isPlaceholder && candle.time === time) {
      return candle;
    }
  }

  return null;
}

function getIndicatorValue(
  items: Array<{ time: number; value: number }>,
  time: number | null
) {
  if (time === null) return null;

  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (items[i].time === time) {
      return items[i].value;
    }
  }

  return null;
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
    isPlaceholder: matched?.isPlaceholder ?? false,
    isReferenceFallback: matched?.isReferenceFallback ?? false,
  };
}

function getPricePrecision(symbol: string, explicitPrecision?: number | null): number {
  return getSpotSymbolPricePrecision(symbol, explicitPrecision) ?? 4;
}

function parseLatestPrice(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const normalized = String(value).replace(/,/g, '').trim();
  if (!normalized || normalized === '--') return null;

  const price = Number(normalized);
  return Number.isFinite(price) && price > 0 ? price : null;
}

function formatPrice(value: number | null | undefined, precision: number) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '--';
  }

  return value.toFixed(precision);
}

function formatCompactPrice(value: number | null | undefined, precision: number) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '--';
  }

  return value.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: precision,
  });
}

function formatVolume(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '--';
  }

  const abs = Math.abs(value);

  if (abs >= 1_000_000_000) {
    return `${(value / 1_000_000_000).toFixed(2)}B`;
  }

  if (abs >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(2)}M`;
  }

  if (abs >= 1_000) {
    return `${(value / 1_000).toFixed(2)}K`;
  }

  if (abs >= 1) {
    return value.toFixed(3);
  }

  return value.toFixed(6);
}

function formatDisplayTime(time: number | null) {
  if (time === null) return '--';

  return new Date(time * 1000).toLocaleString('zh-CN', {
    hour12: false,
    year: 'numeric',
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
  const changePercent =
    candle.open !== 0 ? (change / candle.open) * 100 : null;

  return {
    change,
    changePercent,
  };
}

function getLastPriceLineColor(direction: RealtimePriceDirection) {
  if (direction === 'up') return '#00c087';
  if (direction === 'down') return '#f6465d';
  return SPOT_LAST_PRICE_FLAT;
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

async function fetchSpotChartHistory(params: {
  symbol: string
  interval: string
  limit?: number
  endTime?: number
}) {
  const payload = await getSpotKlines(params);
  return adaptKlines(payload?.items || []);
}

function buildReferenceOverlayFallbackCandles(params: {
  interval: string
  price: number
  count?: number
}): CandleItem[] {
  const price = params.price;
  if (!Number.isFinite(price) || price <= 0) return [];

  const count = params.count ?? REFERENCE_OVERLAY_FALLBACK_CANDLE_COUNT;
  const step = getIntervalSeconds(params.interval);
  const latestTime = getBucketStart(Math.floor(Date.now() / 1000), params.interval);
  const candles: CandleItem[] = [];

  for (let i = count - 1; i >= 0; i -= 1) {
    const time = latestTime - i * step;
    candles.push({
      time,
      open: price,
      high: price,
      low: price,
      close: price,
      volume: 0,
      isPlaceholder: false,
      isReferenceFallback: true,
    });
  }

  return candles;
}

export default function SpotChart({
  symbol,
  displaySymbol,
  interval,
  height = 520,
  dataSource,
  latestPrice,
  priceDirection = 'flat',
  pricePrecision: explicitPricePrecision,
}: SpotChartProps) {
  const { t } = useLocaleContext();
  const pricePrecision = useMemo(
    () => getPricePrecision(symbol, explicitPricePrecision),
    [explicitPricePrecision, symbol]
  );
  const latestPriceNumber = useMemo(() => parseLatestPrice(latestPrice), [latestPrice]);
  const fallbackReferenceOverlayConfig = useMemo(() => getReferenceOverlayConfig(symbol, t), [symbol, t]);
  const [referenceOverlayConfig, setReferenceOverlayConfig] = useState<typeof fallbackReferenceOverlayConfig>(null);
  const hasReferenceOverlay = !!referenceOverlayConfig?.enabled;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);

  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const ma5SeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const ma10SeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const ma30SeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const volumeMa5SeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const volumeMa10SeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const latestPriceLineRef = useRef<ReturnType<ISeriesApi<'Candlestick'>['createPriceLine']> | null>(null);
  const referenceOverlayPriceLineRef = useRef<ReturnType<ISeriesApi<'Candlestick'>['createPriceLine']> | null>(null);
  const latestCloseRef = useRef<number | null>(null);
  const flashTimerRef = useRef<number | null>(null);

  const realtimeConnectionRef = useRef<SpotChartRealtimeConnection | null>(null);
  const destroyedRef = useRef(false);

  const hasPositionedRef = useRef(false);
  const candlesRef = useRef<CandleItem[]>([]);
  const displayCandlesRef = useRef<CandleItem[]>([]);
  const volumesRef = useRef<VolumeItem[]>([]);
  const currentSymbolRef = useRef('');
  const currentIntervalRef = useRef(interval);
  const klineSyncingRef = useRef(false);
  const klineSyncPendingRef = useRef(false);
  const userInteractedRef = useRef(false);
  const suppressVisibleRangeInteractionRef = useRef(false);

  const isLoadingMoreRef = useRef(false);
  const hasMoreHistoryRef = useRef(true);
  const pendingRangeRestoreRef = useRef<{
    from: number;
    to: number;
    shift: number;
  } | null>(null);

  const [candles, setCandles] = useState<CandleItem[]>([]);
  const [volumes, setVolumes] = useState<VolumeItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [hoveredTime, setHoveredTime] = useState<number | null>(null);
  const [hoveredCandle, setHoveredCandle] = useState<CandleItem | null>(null);
  const [latestCandleFlashing, setLatestCandleFlashing] = useState(false);
  const [chartInstanceKey, setChartInstanceKey] = useState(0);
  const [showScrollToLatest, setShowScrollToLatest] = useState(false);
  const [priceZoomLevel, setPriceZoomLevel] = useState(0);

  useEffect(() => {
    candlesRef.current = candles;
  }, [candles]);

  useEffect(() => {
    volumesRef.current = volumes;
  }, [volumes]);

  useEffect(() => {
    currentSymbolRef.current = String(symbol || '').toUpperCase();
  }, [symbol]);

  useEffect(() => {
    currentIntervalRef.current = interval;
  }, [interval]);

  useEffect(() => {
    let alive = true;
    let timer: number | null = null;
    let refreshDelayMs = 60_000;

    const clearRefreshTimer = () => {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
    };

    const scheduleRefresh = () => {
      clearRefreshTimer();
      timer = window.setTimeout(() => {
        void loadReferenceOverlayConfig();
      }, refreshDelayMs);
    };

    const loadReferenceOverlayConfig = async () => {
      try {
        if (document.visibilityState === 'hidden') {
          scheduleRefresh();
          return;
        }
        console.log('[ReferenceOverlay] request symbol =', symbol);
        const payload = await getReferenceOverlay(symbol);
        console.log('[ReferenceOverlay] response =', payload);
        if (!alive) return;

        const nextConfig = normalizeReferenceOverlayConfig(payload, t);
        console.log('[ReferenceOverlay] normalized =', nextConfig);
        refreshDelayMs = nextConfig?.priceSource === 'AUTO' ? 15_000 : 60_000;
        setReferenceOverlayConfig(nextConfig);
      } catch (err) {
        if (!alive) return;
        console.warn('[SpotChart] reference overlay config load failed:', err);
        setReferenceOverlayConfig(fallbackReferenceOverlayConfig);
      } finally {
        if (alive) {
          scheduleRefresh();
        }
      }
    };

    setReferenceOverlayConfig(null);
    void loadReferenceOverlayConfig();

    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'hidden') {
        clearRefreshTimer();
        void loadReferenceOverlayConfig();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      alive = false;
      clearRefreshTimer();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [fallbackReferenceOverlayConfig, symbol, t]);

  const ma5 = useMemo(() => calculateMA(candles, 5), [candles]);
  const ma10 = useMemo(() => calculateMA(candles, 10), [candles]);
  const ma30 = useMemo(() => calculateMA(candles, 30), [candles]);
  const volumeMa5 = useMemo(() => calculateVolumeMA(candles, 5), [candles]);
  const volumeMa10 = useMemo(() => calculateVolumeMA(candles, 10), [candles]);
  const latestReferenceOverlayValue = useMemo(() => {
    const value = referenceOverlayConfig?.displayPrice;
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
  }, [referenceOverlayConfig]);
  const showReferenceOverlayLine =
    hasReferenceOverlay &&
    typeof latestReferenceOverlayValue === 'number' &&
    Number.isFinite(latestReferenceOverlayValue) &&
    latestReferenceOverlayValue > 0;
  const showReferenceOverlayFallback =
    candles.length === 0 &&
    showReferenceOverlayLine &&
    latestReferenceOverlayValue !== null;
  const referenceOverlayFallbackCandles = useMemo(
    () =>
      showReferenceOverlayFallback && latestReferenceOverlayValue !== null
        ? buildReferenceOverlayFallbackCandles({
            interval,
            price: latestReferenceOverlayValue,
          })
        : [],
    [interval, latestReferenceOverlayValue, showReferenceOverlayFallback]
  );
  const displayCandles = showReferenceOverlayFallback ? referenceOverlayFallbackCandles : candles;
  const displayVolumes = useMemo(
    () => (showReferenceOverlayFallback ? [] : volumes),
    [showReferenceOverlayFallback, volumes]
  );
  const priceScaleAutoMargins = useMemo(
    () => getSpotChartPriceScaleMargins(showReferenceOverlayLine),
    [showReferenceOverlayLine]
  );

  useEffect(() => {
    displayCandlesRef.current = displayCandles;
  }, [displayCandles]);

  const removeReferenceOverlayPriceLine = useCallback(() => {
    if (referenceOverlayPriceLineRef.current && candleSeriesRef.current) {
      candleSeriesRef.current.removePriceLine(referenceOverlayPriceLineRef.current);
    }
    referenceOverlayPriceLineRef.current = null;
  }, []);

  const applyPriceScaleZoom = useCallback((zoomLevel: number) => {
    const chart = chartRef.current;
    if (!chart) return;

    const priceScale = chart.priceScale('right');

    if (zoomLevel === 0) {
      priceScale.setAutoScale(true);
      priceScale.applyOptions({
        autoScale: true,
        scaleMargins: priceScaleAutoMargins,
      });
      return;
    }

    const allCandles = candlesRef.current;
    const logicalRange = chart.timeScale().getVisibleLogicalRange();
    const fromIndex = logicalRange
      ? clampNumber(Math.floor(logicalRange.from), 0, Math.max(allCandles.length - 1, 0))
      : Math.max(allCandles.length - SPOT_CHART_INITIAL_VISIBLE_BARS, 0);
    const toIndex = logicalRange
      ? clampNumber(Math.ceil(logicalRange.to), 0, Math.max(allCandles.length - 1, 0))
      : allCandles.length - 1;
    const visibleCandles = allCandles
      .slice(Math.min(fromIndex, toIndex), Math.max(fromIndex, toIndex) + 1)
      .filter((item) => !item.isPlaceholder);
    const candlesForRange = visibleCandles.length
      ? visibleCandles
      : allCandles.filter((item) => !item.isPlaceholder);

    const rangeValues: number[] = [];
    candlesForRange.forEach((item) => {
      rangeValues.push(item.low, item.high);
    });
    if (latestPriceNumber !== null) {
      rangeValues.push(latestPriceNumber);
    }
    if (showReferenceOverlayLine && latestReferenceOverlayValue !== null) {
      rangeValues.push(latestReferenceOverlayValue);
    }

    const finiteValues = rangeValues.filter((value) => Number.isFinite(value) && value > 0);
    if (!finiteValues.length) return;

    let minPrice = Math.min(...finiteValues);
    let maxPrice = Math.max(...finiteValues);
    if (minPrice === maxPrice) {
      const padding = Math.max(Math.abs(maxPrice) * 0.005, 1 / Math.pow(10, pricePrecision));
      minPrice -= padding;
      maxPrice += padding;
    }

    const center = (minPrice + maxPrice) / 2;
    const baseSpan = Math.max(maxPrice - minPrice, 1 / Math.pow(10, pricePrecision));
    const paddedSpan = baseSpan * 1.24;
    const zoomFactor = Math.pow(PRICE_SCALE_ZOOM_FACTOR, zoomLevel);
    const targetSpan = Math.max(paddedSpan / zoomFactor, 1 / Math.pow(10, pricePrecision));
    const rangeFrom = Math.max(center - targetSpan / 2, 0);
    const rangeTo = rangeFrom === 0 ? targetSpan : center + targetSpan / 2;

    priceScale.setAutoScale(false);
    priceScale.setVisibleRange({
      from: rangeFrom,
      to: rangeTo,
    });
  }, [
    latestPriceNumber,
    latestReferenceOverlayValue,
    pricePrecision,
    priceScaleAutoMargins,
    showReferenceOverlayLine,
  ]);

  const setVisibleLogicalRangeSilently = useCallback((range: { from: number; to: number }) => {
    if (!chartRef.current) return;

    suppressVisibleRangeInteractionRef.current = true;
    chartRef.current.timeScale().setVisibleLogicalRange(range);
    window.setTimeout(() => {
      suppressVisibleRangeInteractionRef.current = false;
    }, 0);
  }, []);

  const scrollChartToLatest = useCallback(() => {
    if (!chartRef.current) return;

    suppressVisibleRangeInteractionRef.current = true;
    chartRef.current.timeScale().scrollToRealTime();
    userInteractedRef.current = false;
    setShowScrollToLatest(false);
    window.setTimeout(() => {
      suppressVisibleRangeInteractionRef.current = false;
    }, 0);
  }, []);

  const resetChartView = useCallback(() => {
    setPriceZoomLevel(0);
    applyPriceScaleZoom(0);
    scrollChartToLatest();
  }, [applyPriceScaleZoom, scrollChartToLatest]);

  const adjustPriceScaleZoom = useCallback((direction: -1 | 1) => {
    const nextLevel = clampNumber(
      priceZoomLevel + direction,
      PRICE_SCALE_ZOOM_MIN,
      PRICE_SCALE_ZOOM_MAX
    );
    userInteractedRef.current = true;
    setPriceZoomLevel(nextLevel);
    applyPriceScaleZoom(nextLevel);
  }, [applyPriceScaleZoom, priceZoomLevel]);

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

  const closeRealtime = useCallback(() => {
    if (realtimeConnectionRef.current) {
      realtimeConnectionRef.current.close();
      realtimeConnectionRef.current = null;
    }
  }, []);

  const syncLatestKlinesFromServer = useCallback(async () => {
    const requestSymbol = currentSymbolRef.current;
    const requestInterval = currentIntervalRef.current;

    if (!requestSymbol || !requestInterval) return;

    if (klineSyncingRef.current) {
      klineSyncPendingRef.current = true;
      return;
    }

    klineSyncingRef.current = true;

    try {
      const result = await fetchSpotChartHistory({
        symbol: requestSymbol,
        interval: requestInterval,
        limit: 200,
      });

      if (destroyedRef.current) return;
      if (
        requestSymbol !== currentSymbolRef.current ||
        requestInterval !== currentIntervalRef.current
      ) {
        return;
      }

      const mergedCandles = mergeCandlesByTime(candlesRef.current, result.candles || []);
      const mergedVolumes = mergeVolumesByTime(volumesRef.current, result.volumes || []);

      candlesRef.current = mergedCandles;
      volumesRef.current = mergedVolumes;
      setCandles(mergedCandles);
      setVolumes(mergedVolumes);
      writeMarketCache<SpotChartCache>('spot', requestSymbol, {
        candles: mergedCandles,
        volumes: mergedVolumes,
      });
      setError('');
    } catch (err) {
      if (!destroyedRef.current) {
        console.warn('[SpotChart] latest kline sync failed:', err);
      }
    } finally {
      klineSyncingRef.current = false;

      if (klineSyncPendingRef.current) {
        klineSyncPendingRef.current = false;
        void syncLatestKlinesFromServer();
      }
    }
  }, []);

  const loadOlderHistory = useCallback(async () => {
    if (isLoadingMoreRef.current) return;
    if (!hasMoreHistoryRef.current) return;

    const currentCandles = candlesRef.current;
    if (!currentCandles.length) return;

    const oldest = currentCandles[0];
    if (!oldest || !oldest.time) return;

    isLoadingMoreRef.current = true;
    setLoadingMore(true);

    try {
      const beforeRange = chartRef.current?.timeScale().getVisibleLogicalRange() || null;

      const result = await fetchSpotChartHistory({
        symbol: currentSymbolRef.current,
        interval: currentIntervalRef.current,
        limit: 200,
        endTime: oldest.time * 1000,
      });

      const olderCandles = result.candles || [];
      const olderVolumes = result.volumes || [];

      if (!olderCandles.length) {
        hasMoreHistoryRef.current = false;
        return;
      }

      const mergedCandles = mergeCandlesByTime(olderCandles, currentCandles);
      const mergedVolumes = mergeVolumesByTime(olderVolumes, volumesRef.current);

      const addedCount = mergedCandles.length - currentCandles.length;

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

      candlesRef.current = mergedCandles;
      volumesRef.current = mergedVolumes;
      setCandles(mergedCandles);
      setVolumes(mergedVolumes);

      if (olderCandles.length < 200) {
        hasMoreHistoryRef.current = false;
      }
    } catch (e) {
      console.warn('[SpotChart] load older history failed:', e);
    } finally {
      isLoadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, []);

  useEffect(() => {
    if (!containerRef.current) return;

    destroyedRef.current = false;

    const initialHeight = containerRef.current.clientHeight || height;

    const {
      chart,
      candleSeries,
      volumeSeries,
      ma5Series,
      ma10Series,
      ma30Series,
      volumeMa5Series,
      volumeMa10Series,
    } = createSpotChartInstance(containerRef.current, initialHeight, pricePrecision);

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    volumeSeriesRef.current = volumeSeries;
    ma5SeriesRef.current = ma5Series;
    ma10SeriesRef.current = ma10Series;
    ma30SeriesRef.current = ma30Series;
    volumeMa5SeriesRef.current = volumeMa5Series;
    volumeMa10SeriesRef.current = volumeMa10Series;
    setChartInstanceKey((value) => value + 1);

    const handleResize = () => {
      resizeSpotChart(chartRef.current, containerRef.current);
    };

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
      const active = buildActiveCandleFromCrosshairData(candleData, time, displayCandlesRef.current);

      if (active) {
        setHoveredCandle(active);
        setHoveredTime(time);
        return;
      }

      const matched = getCandleByTime(displayCandlesRef.current, time);
      if (matched) {
        setHoveredCandle(matched);
        setHoveredTime(time);
        return;
      }

      setHoveredTime(time);
    };

    chart.subscribeCrosshairMove(handleCrosshairMove);
    window.addEventListener('resize', handleResize);
    const resizeObserver =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(handleResize)
        : null;
    resizeObserver?.observe(containerRef.current);
    handleResize();

    return () => {
      destroyedRef.current = true;
      window.removeEventListener('resize', handleResize);
      resizeObserver?.disconnect();
      chart.unsubscribeCrosshairMove(handleCrosshairMove);
      closeRealtime();

      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      latestPriceLineRef.current = null;
      referenceOverlayPriceLineRef.current = null;
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
      hasPositionedRef.current = false;
    };
  }, [height, closeRealtime, pricePrecision]);

  useEffect(() => {
    const series = candleSeriesRef.current;
    const price = latestReferenceOverlayValue;

    if (
      !series ||
      !referenceOverlayConfig ||
      !showReferenceOverlayLine ||
      typeof price !== 'number' ||
      !Number.isFinite(price) ||
      price <= 0
    ) {
      removeReferenceOverlayPriceLine();
      return;
    }

    removeReferenceOverlayPriceLine();
    referenceOverlayPriceLineRef.current = series.createPriceLine({
      price,
      color: referenceOverlayConfig.lineColor,
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title: referenceOverlayConfig.lineTitle,
    });

    return () => {
      removeReferenceOverlayPriceLine();
    };
  }, [
    chartInstanceKey,
    latestReferenceOverlayValue,
    referenceOverlayConfig,
    showReferenceOverlayLine,
    removeReferenceOverlayPriceLine,
  ]);

  useEffect(() => {
    if (!chartRef.current) return;

    applyPriceScaleZoom(priceZoomLevel);
  }, [applyPriceScaleZoom, chartInstanceKey, priceZoomLevel]);

  useEffect(() => {
    if (!candleSeriesRef.current || !volumeSeriesRef.current) return;

    const chartCandles = toFlashChartCandles(displayCandles, latestCandleFlashing);
    const chartVolumes = toChartVolumes(displayVolumes);

    if (process.env.NODE_ENV !== 'production') {
      console.debug('[SpotChart] last candles', displayCandles.slice(-3));
      console.debug('[SpotChart] last chart candles', chartCandles.slice(-3));
    }

    candleSeriesRef.current.setData(chartCandles);
    volumeSeriesRef.current.setData(chartVolumes);
    if (priceZoomLevel === 0) {
      candleSeriesRef.current.priceScale().applyOptions({
        autoScale: true,
        scaleMargins: priceScaleAutoMargins,
      });
    } else {
      applyPriceScaleZoom(priceZoomLevel);
    }

    ma5SeriesRef.current?.setData(toLineData(ma5));
    ma10SeriesRef.current?.setData(toLineData(ma10));
    ma30SeriesRef.current?.setData(toLineData(ma30));
    volumeMa5SeriesRef.current?.setData(toLineData(volumeMa5));
    volumeMa10SeriesRef.current?.setData(toLineData(volumeMa10));

    if (pendingRangeRestoreRef.current && chartRef.current) {
      const { from, to, shift } = pendingRangeRestoreRef.current;
      setVisibleLogicalRangeSilently({
        from: from + shift,
        to: to + shift,
      });
      pendingRangeRestoreRef.current = null;
      return;
    }

    if (displayCandles.length > 0 && chartRef.current && !hasPositionedRef.current) {
      const total = displayCandles.length;

      setVisibleLogicalRangeSilently({
        from: Math.max(total - SPOT_CHART_INITIAL_VISIBLE_BARS, 0),
        to: total + SPOT_CHART_INITIAL_RIGHT_PADDING_BARS,
      });

      hasPositionedRef.current = true;
    }
  }, [
    applyPriceScaleZoom,
    displayCandles,
    displayVolumes,
    latestCandleFlashing,
    ma5,
    ma10,
    ma30,
    priceScaleAutoMargins,
    priceZoomLevel,
    setVisibleLogicalRangeSilently,
    volumeMa5,
    volumeMa10,
  ]);

  useEffect(() => {
    hasPositionedRef.current = false;
    userInteractedRef.current = false;
    suppressVisibleRangeInteractionRef.current = false;
    hasMoreHistoryRef.current = true;
    isLoadingMoreRef.current = false;
    pendingRangeRestoreRef.current = null;
    klineSyncPendingRef.current = false;
    klineSyncingRef.current = false;
    setLoadingMore(false);
    setHoveredTime(null);
    setHoveredCandle(null);
    setLatestCandleFlashing(false);
    setShowScrollToLatest(false);
    setPriceZoomLevel(0);
    latestCloseRef.current = null;
  }, [symbol, interval]);

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

    if (!series) return;
    const priceLineValue =
      latestPriceNumber !== null
        ? latestPriceNumber
        : latest?.close;
    if (typeof priceLineValue !== 'number' || !Number.isFinite(priceLineValue)) {
      if (latestPriceLineRef.current) {
        series.removePriceLine(latestPriceLineRef.current);
        latestPriceLineRef.current = null;
      }
      return;
    }

    const color = getLastPriceLineColor(priceDirection);

    if (!latestPriceLineRef.current) {
      latestPriceLineRef.current = series.createPriceLine({
        price: priceLineValue,
        color,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: '',
      });
      return;
    }

    latestPriceLineRef.current.applyOptions({
      price: priceLineValue,
      color,
    });
  }, [candles, latestPriceNumber, priceDirection]);

  useEffect(() => {
    let mounted = true;

    const loadInitialHistory = async () => {
      const requestSymbol = String(symbol || '').toUpperCase();
      const requestInterval = interval;

      try {
        setLoading(true);
        setError('');
        const cached = readCurrentChartCache(requestSymbol);
        if (cached?.candles?.length) {
          setCandles(cached.candles);
          setVolumes(cached.volumes || []);
          candlesRef.current = cached.candles;
          volumesRef.current = cached.volumes || [];
        } else {
          candlesRef.current = [];
          volumesRef.current = [];
        }
        hasMoreHistoryRef.current = true;

        const result = await fetchSpotChartHistory({
          symbol: requestSymbol,
          interval: requestInterval,
          limit: 200,
        });

        if (!mounted) return;
        if (
          requestSymbol !== currentSymbolRef.current ||
          requestInterval !== currentIntervalRef.current
        ) {
          return;
        }

        const nextCandles =
          candlesRef.current.length > 0
            ? mergeCandlesByTime(candlesRef.current, result.candles)
            : result.candles;
        const nextVolumes =
          volumesRef.current.length > 0
            ? mergeVolumesByTime(volumesRef.current, result.volumes)
            : result.volumes;

        setCandles(nextCandles);
        setVolumes(nextVolumes);
        candlesRef.current = nextCandles;
        volumesRef.current = nextVolumes;
        writeMarketCache<SpotChartCache>('spot', requestSymbol, {
          candles: nextCandles,
          volumes: nextVolumes,
        });

        if ((result.candles || []).length < 200) {
          hasMoreHistoryRef.current = false;
        }
      } catch (e) {
        console.warn('[SpotChart] K-line load failed:', e);

        if (mounted) {
          setError(t('spotChartLoadFailed', 'asset'));
          if (candlesRef.current.length === 0) {
            setCandles([]);
            setVolumes([]);
            writeMarketCache<SpotChartCache>('spot', requestSymbol, {
              candles: [],
              volumes: [],
            });
          }
          hasMoreHistoryRef.current = false;
        }
      } finally {
        if (mounted) {
          setLoading(false);
        }
      }
    };

    loadInitialHistory();

    return () => {
      mounted = false;
    };
  }, [interval, symbol, t]);

  useEffect(() => {
    if (!chartRef.current) return;

    const timeScale = chartRef.current.timeScale();

    const handleVisibleRangeChange = (range: { from: number; to: number } | null) => {
      if (!range) return;

      if (!suppressVisibleRangeInteractionRef.current) {
        userInteractedRef.current = true;
      }

      const candleCount = candlesRef.current.length;
      const isAwayFromLatest = candleCount > 0 && range.to < candleCount - 2;
      setShowScrollToLatest(userInteractedRef.current && isAwayFromLatest);

      if (loading) return;
      if (error) return;

      if (range.from < 10) {
        loadOlderHistory();
      }
    };

    timeScale.subscribeVisibleLogicalRangeChange(handleVisibleRangeChange);

    return () => {
      timeScale.unsubscribeVisibleLogicalRangeChange(handleVisibleRangeChange);
    };
  }, [chartInstanceKey, loading, error, loadOlderHistory, symbol, interval]);

  useEffect(() => {
    const normalizedSymbol = String(symbol || '').toUpperCase();
    if (!normalizedSymbol) return;
    if (!chartRef.current) return;

    destroyedRef.current = false;
    closeRealtime();

    const handleTradeMessage = (message: SpotChartWsMessage) => {
      if (message.type === 'spot_market_snapshot') {
        const msgSymbol = String(message.symbol || '').toUpperCase();
        if (msgSymbol && msgSymbol === currentSymbolRef.current) {
          void syncLatestKlinesFromServer();
        }
        return;
      }

      if (message.type !== 'spot_trade') return;

      const result = applySpotTradeUpdate({
        message,
        currentSymbol: currentSymbolRef.current,
        currentInterval: currentIntervalRef.current,
        candles: candlesRef.current,
        volumes: volumesRef.current,
      });

      if (!result) return;

      candlesRef.current = result.nextCandles;
      volumesRef.current = result.nextVolumes;
      setCandles(result.nextCandles);
      setVolumes(result.nextVolumes);
      writeMarketCache<SpotChartCache>('spot', currentSymbolRef.current, {
        candles: result.nextCandles,
        volumes: result.nextVolumes,
      });
    };

    const handleExternalKlines = (
      nextCandles: CandleItem[],
      nextVolumes: VolumeItem[]
    ) => {
      candlesRef.current = nextCandles;
      volumesRef.current = nextVolumes;
      setCandles(nextCandles);
      setVolumes(nextVolumes);
      writeMarketCache<SpotChartCache>('spot', normalizedSymbol, {
        candles: nextCandles,
        volumes: nextVolumes,
      });
    };

    if (isPollingSpotDataSource(dataSource)) {
      realtimeConnectionRef.current = createExternalSpotChartPollingConnection({
        symbol: normalizedSymbol,
        interval,
        destroyedRef,
        onKlines: handleExternalKlines,
      });
    } else {
      realtimeConnectionRef.current = createInternalSpotChartRealtimeConnection({
        symbol: normalizedSymbol,
        destroyedRef,
        onTradeMessage: handleTradeMessage,
      });
    }

    return () => {
      closeRealtime();
    };
  }, [dataSource, symbol, interval, closeRealtime, syncLatestKlinesFromServer]);

  const realCandleCount = useMemo(
    () => candles.filter((item) => !item.isPlaceholder).length,
    [candles]
  );

  const activeCandle = useMemo(() => {
    return hoveredCandle || getCandleByTime(displayCandles, hoveredTime) || getLatestRealCandle(displayCandles);
  }, [displayCandles, hoveredCandle, hoveredTime]);

  const activeTime = activeCandle?.time ?? null;
  const activeMa5 = useMemo(() => getIndicatorValue(ma5, activeTime), [ma5, activeTime]);
  const activeMa10 = useMemo(() => getIndicatorValue(ma10, activeTime), [ma10, activeTime]);
  const activeMa30 = useMemo(() => getIndicatorValue(ma30, activeTime), [ma30, activeTime]);
  const activeVolumeMa5 = useMemo(
    () => getIndicatorValue(volumeMa5, activeTime),
    [volumeMa5, activeTime]
  );
  const activeVolumeMa10 = useMemo(
    () => getIndicatorValue(volumeMa10, activeTime),
    [volumeMa10, activeTime]
  );
  const activeVolumeText = activeCandle?.isReferenceFallback
    ? '--'
    : formatVolume(activeCandle?.volume);
  const latestReferenceOverlayText = formatCompactPrice(
    latestReferenceOverlayValue,
    REFERENCE_OVERLAY_PRICE_PRECISION
  );
  const { change, changePercent } = useMemo(
    () => getChangeMetrics(activeCandle),
    [activeCandle]
  );
  const changePositive = (change ?? 0) >= 0;
  const changeColor = changePositive ? 'text-[#16a34a]' : 'text-[#dc2626]';
  const handleChartKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
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

  return (
    <div className="tabular-nums flex h-full min-h-0 w-full flex-col" style={{ background: SPOT_CHART_BG }}>
      <div className="shrink-0 border-b border-white/[0.06] bg-[#10151b]/90 px-3 py-2 text-xs shadow-[inset_0_1px_0_rgba(255,255,255,0.02)]">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
          <span className="rounded-md border border-white/[0.06] bg-white/[0.03] px-2.5 py-1 text-[11px] font-medium text-white/88 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
            {`${displaySymbol || formatSpotDisplaySymbol(symbol)} / ${interval}`}
          </span>
          <span className="text-[11px] text-white/42">{formatDisplayTime(activeTime)}</span>
          <span className="inline-flex items-center gap-1 rounded-md bg-white/[0.02] px-2 py-1 text-[11px] text-white/76">
            <span className="text-white/34">O</span>
            <span>{formatPrice(activeCandle?.open, pricePrecision)}</span>
          </span>
          <span className="inline-flex items-center gap-1 rounded-md bg-white/[0.02] px-2 py-1 text-[11px] text-white/76">
            <span className="text-white/34">H</span>
            <span>{formatPrice(activeCandle?.high, pricePrecision)}</span>
          </span>
          <span className="inline-flex items-center gap-1 rounded-md bg-white/[0.02] px-2 py-1 text-[11px] text-white/76">
            <span className="text-white/34">L</span>
            <span>{formatPrice(activeCandle?.low, pricePrecision)}</span>
          </span>
          <span className={`inline-flex items-center gap-1 rounded-md bg-white/[0.02] px-2 py-1 text-[11px] ${changeColor}`}>
            <span className="text-white/34">C</span>
            <span>{formatPrice(activeCandle?.close, pricePrecision)}</span>
          </span>
          <span className={`inline-flex items-center gap-1 rounded-md bg-white/[0.02] px-2 py-1 text-[11px] ${changeColor}`}>
            <span className="text-white/34">{t('spotChartChange', 'asset')}</span>
            <span>{formatPrice(change, pricePrecision)}</span>
          </span>
          <span className={`inline-flex items-center gap-1 rounded-md bg-white/[0.02] px-2 py-1 text-[11px] ${changeColor}`}>
            <span className="text-white/34">{t('spotChartChangePercent', 'asset')}</span>
            <span>
              {changePercent === null || !Number.isFinite(changePercent)
                ? '--'
                : `${changePercent.toFixed(2)}%`}
            </span>
          </span>
        </div>

        <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]">
          <span className="font-medium" style={{ color: SPOT_CHART_MA5 }}>
            {`MA5 ${formatPrice(activeMa5, pricePrecision)}`}
          </span>
          <span className="font-medium" style={{ color: SPOT_CHART_MA10 }}>
            {`MA10 ${formatPrice(activeMa10, pricePrecision)}`}
          </span>
          <span className="font-medium" style={{ color: SPOT_CHART_MA30 }}>
            {`MA30 ${formatPrice(activeMa30, pricePrecision)}`}
          </span>
          <span className="text-white/74">{`VOL ${activeVolumeText}`}</span>
          <span className="text-white/52">{`VMA5 ${formatVolume(activeVolumeMa5)}`}</span>
          <span className="text-white/52">{`VMA10 ${formatVolume(activeVolumeMa10)}`}</span>
          {showReferenceOverlayLine && referenceOverlayConfig ? (
            <span
              className="font-medium"
              style={{ color: referenceOverlayConfig.lineColor }}
            >
              {`${referenceOverlayConfig.title} ${latestReferenceOverlayText} ${referenceOverlayConfig.displayUnit || 'USDT'}`}
            </span>
          ) : null}
        </div>
      </div>

      <div className="relative min-h-0 flex-1">
        {hasReferenceOverlay && referenceOverlayConfig ? (
          <ReferenceOverlayBadge config={referenceOverlayConfig} />
        ) : null}

        <div
          ref={containerRef}
          role="application"
          tabIndex={0}
          aria-label={t('spotChartAriaLabel', 'asset')}
          className="h-full w-full outline-none"
          onKeyDown={handleChartKeyDown}
          onDoubleClick={handleChartDoubleClick}
          onMouseEnter={() => focusChartContainer(containerRef.current)}
        />

        {loadingMore ? (
          <div className="pointer-events-none absolute left-3 top-3 rounded bg-black/60 px-2 py-1 text-xs text-gray-300">
            {t('spotChartLoadingMore', 'asset')}
          </div>
        ) : null}

        {showScrollToLatest ? (
          <button
            type="button"
            className="absolute bottom-4 right-4 z-10 rounded-md border border-white/10 bg-[#11161c]/90 px-3 py-1.5 text-xs font-medium text-white/82 shadow-lg shadow-black/25 backdrop-blur-sm transition hover:border-[#f0b90b]/45 hover:text-[#f0b90b]"
            onClick={scrollChartToLatest}
          >
            {t('spotChartBackToLatest', 'asset')}
          </button>
        ) : null}

        {loading ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/10">
            <div className="text-sm" style={{ color: SPOT_CHART_TEXT }}>
              {t('spotChartLoading', 'asset')}
            </div>
          </div>
        ) : null}

        {!loading && error && !showReferenceOverlayFallback ? (
          <div className="absolute inset-0 flex items-center justify-center bg-black/40">
            <div className="rounded-md border border-red-500/30 bg-[#11161c] px-4 py-3 text-sm text-red-300">
              {error}
            </div>
          </div>
        ) : null}

        {!loading && realCandleCount === 0 && showReferenceOverlayFallback ? (
          <div className="pointer-events-none absolute left-3 top-3 rounded-md border border-white/10 bg-[#11161c]/90 px-2.5 py-1.5 text-xs text-white/72 shadow-lg shadow-black/20 backdrop-blur-sm">
            {t('spotReferenceKlineFallback', 'asset')}
          </div>
        ) : null}

        {!loading && !error && realCandleCount === 0 && !showReferenceOverlayFallback ? (
          <div className="absolute inset-0 flex items-center justify-center bg-black/10">
            <div className="text-sm" style={{ color: SPOT_CHART_TEXT }}>
              {t('spotChartNoData', 'asset')}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
