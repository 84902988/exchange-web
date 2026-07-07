'use client';

import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import Script from 'next/script';
import { useLocaleContext } from '@/contexts/LocaleContext';
import { spotMarketRealtime } from '@/services/marketRealtime';
import type { SpotChartProps } from './chart/chart.types';
import { formatSpotDisplaySymbol } from './spotFormat';
import {
  createSpotTradingViewDatafeed,
  spotIntervalToTradingViewResolution,
  type SpotTradingViewHistoryBarsEvent,
} from './tradingview/spotTradingViewDatafeed';
import { getBackendKlineIntervalForSpotInterval } from './tradingview/spotKlineClientCache';
import {
  createSpotKlinePreloadManager,
  type SpotKlinePreloadManager,
} from './tradingview/spotKlinePreloadManager';
import {
  createSpotKlinePerfId,
  markSpotKlinePerf,
} from './tradingview/spotKlinePerf';

type TradingViewVisibleRange = {
  from: number;
  to?: number;
};

type TradingViewVisibleRangeOptions = {
  applyDefaultRightMargin?: boolean;
  percentRightMargin?: number;
  rejectByTimeout?: number;
};

type TradingViewTimeScaleApi = {
  setRightOffset?: (offset: number) => void;
  rightOffset?: () => number;
};

type TradingViewChartApi = {
  setResolution?: (
    resolution: string,
    options?: { dataReady?: () => void; doNotActivateChart?: boolean } | (() => void),
  ) => Promise<boolean> | void;
  setVisibleRange?: (
    range: TradingViewVisibleRange,
    options?: TradingViewVisibleRangeOptions,
  ) => Promise<void> | void;
  getVisibleRange?: () => TradingViewVisibleRange;
  getTimeScale?: () => TradingViewTimeScaleApi;
};

type TradingViewWidgetInstance = {
  remove: () => void;
  activeChart?: () => TradingViewChartApi;
  onChartReady?: (callback: () => void) => void;
  headerReady: () => Promise<void>;
  createButton: (options?: {
    align?: 'left' | 'right';
    useTradingViewStyle?: false;
  }) => HTMLElement;
};

type SpotTradingViewGlobal = {
  widget: new (options: Record<string, unknown>) => TradingViewWidgetInstance;
};

type TradingViewLoadError = {
  key: string;
  message: string;
};

type SpotTradingViewChartProps = SpotChartProps & {
  chartMode?: 'time' | 'candle';
  intervalSwitchLoading?: boolean;
  onIntervalChange?: (value: string) => void;
  onChartModeChange?: (value: 'time' | 'candle') => void;
  onIntervalSwitchLoadComplete?: () => void;
};

type SpotTradingViewWindow = Window & {
  TradingView?: SpotTradingViewGlobal;
  __SPOT_TV_DEBUG_EVENTS__?: SpotTvDebugEvent[];
  __dumpSpotTvDebug?: () => SpotTvDebugEvent[];
};

type SpotTvDebugEvent = {
  event: string;
  timestamp: number;
  time: string;
  [key: string]: unknown;
};

type SpotRecentVisibleRangeEvent = SpotTradingViewHistoryBarsEvent & {
  updatedAt: number;
};

const TRADINGVIEW_LIBRARY_PATH = '/tradingview/charting_library/';
const TRADINGVIEW_SCRIPT_SRC = `${TRADINGVIEW_LIBRARY_PATH}charting_library.js`;
const TRADINGVIEW_TIMEZONE = 'Asia/Shanghai';
const TRADINGVIEW_CHART_STYLE = {
  candle: 1,
  line: 2,
} as const;
const SPOT_INTERVAL_OPTIONS = ['1m', '5m', '15m', '1h', '4h', '1d', '1w', '1M'];
const TIME_SHARING_LABEL = '\u5206\u65f6';
const TIME_SHARING_KEY = 'time';
const SPOT_TV_DEBUG_EVENT_LIMIT = 500;
const SPOT_TV_INITIAL_RIGHT_PADDING_BARS = 4;
const SPOT_TV_INITIAL_VISIBLE_RANGE_DELAY_MS = 80;
const SPOT_TV_LOADING_MIN_VISIBLE_MS = 220;
const SPOT_TV_RESOLUTION_KLINE_OWNER_PREFIX = 'spot-tradingview-chart-resolution';
const SPOT_TV_INITIAL_VISIBLE_BARS: Record<string, number> = {
  '1m': 75,
  '5m': 75,
  '15m': 85,
  '1h': 75,
  '4h': 65,
  '1d': 60,
  '1w': 45,
  '1M': 36,
};
const SPOT_TV_INTERVAL_SECONDS: Record<string, number> = {
  '1m': 60,
  '5m': 5 * 60,
  '15m': 15 * 60,
  '1h': 60 * 60,
  '4h': 4 * 60 * 60,
  '1d': 24 * 60 * 60,
  '1w': 7 * 24 * 60 * 60,
  '1M': 30 * 24 * 60 * 60,
};

function normalizeTradingViewSymbol(symbol: string) {
  return String(symbol || '').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '');
}

function buildVisibleRangeSnapshotKey(symbol: string, backendInterval: string) {
  return `${normalizeTradingViewSymbol(symbol)}:${String(backendInterval || '').trim()}`;
}

function resolveTradingViewLocale(locale: string) {
  if (locale === 'zh-TW') return 'zh_TW';
  if (locale === 'zh') return 'zh';
  if (locale === 'ja') return 'ja';
  return 'en';
}

function isSpotTradingViewDebugEnabled() {
  if (typeof window === 'undefined') return false;

  try {
    if (new URLSearchParams(window.location.search || '').get('tvdebug') === '1') return true;
    if (/[?&]tvdebug=1(?:&|$)/.test(window.location.href || '')) return true;
  } catch {
    // URL access is best-effort only for diagnostics.
  }

  try {
    return window.localStorage?.getItem('SPOT_TV_DEBUG') === '1';
  } catch {
    return false;
  }
}

function ensureSpotTradingViewDebugBuffer() {
  if (typeof window === 'undefined') return null;
  const debugWindow = window as SpotTradingViewWindow;
  try {
    debugWindow.__SPOT_TV_DEBUG_EVENTS__ = debugWindow.__SPOT_TV_DEBUG_EVENTS__ || [];
    debugWindow.__dumpSpotTvDebug = () => (debugWindow.__SPOT_TV_DEBUG_EVENTS__ || []).slice(-100);
    return debugWindow;
  } catch {
    return null;
  }
}

function spotTradingViewChartDebug(event: string, payload: Record<string, unknown>) {
  if (!isSpotTradingViewDebugEnabled()) return;
  const debugWindow = ensureSpotTradingViewDebugBuffer();
  if (!debugWindow) return;

  const timestamp = Date.now();
  const entry: SpotTvDebugEvent = {
    event,
    timestamp,
    time: new Date(timestamp).toISOString(),
    ...payload,
  };

  try {
    const events = debugWindow.__SPOT_TV_DEBUG_EVENTS__ || [];
    events.push(entry);
    if (events.length > SPOT_TV_DEBUG_EVENT_LIMIT) {
      events.splice(0, events.length - SPOT_TV_DEBUG_EVENT_LIMIT);
    }
    debugWindow.__SPOT_TV_DEBUG_EVENTS__ = events;
    debugWindow.__dumpSpotTvDebug = () => (debugWindow.__SPOT_TV_DEBUG_EVENTS__ || []).slice(-100);
    console.info(`[SpotTradingViewChart] ${event} ${JSON.stringify(entry)}`);
  } catch {
    // Debug telemetry is best-effort only.
  }
}

function getSpotChartPerfNow() {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

function formatIntervalLabel(value: string) {
  const normalized = String(value || '').trim();
  if (normalized === '1h') return '1H';
  if (normalized === '4h') return '4H';
  if (normalized === '1d') return '1D';
  if (normalized === '1w') return '1W';
  if (normalized === '1M') return '1M';
  return normalized;
}

function resolveInitialVisibleRangeFromLatestBar(interval: string, latestBarTimeMs: number) {
  const targetVisibleBars = SPOT_TV_INITIAL_VISIBLE_BARS[interval] ?? SPOT_TV_INITIAL_VISIBLE_BARS['1d'];
  const intervalSeconds = SPOT_TV_INTERVAL_SECONDS[interval] ?? SPOT_TV_INTERVAL_SECONDS['1d'];
  const latestBarTime = Math.floor(latestBarTimeMs / 1000);
  if (!Number.isFinite(latestBarTime) || latestBarTime <= 0) return null;

  return {
    range: {
      from: latestBarTime - intervalSeconds * targetVisibleBars,
      to: latestBarTime,
    },
    fallbackRange: {
      from: latestBarTime - intervalSeconds * targetVisibleBars,
      to: latestBarTime + intervalSeconds * SPOT_TV_INITIAL_RIGHT_PADDING_BARS,
    },
    intervalSeconds,
    latestBarTime,
    rightPaddingBars: SPOT_TV_INITIAL_RIGHT_PADDING_BARS,
    targetVisibleBars,
  };
}

function readTradingViewVisibleRange(chart: TradingViewChartApi) {
  try {
    return typeof chart.getVisibleRange === 'function' ? chart.getVisibleRange() : null;
  } catch {
    return null;
  }
}

function readTradingViewRightOffset(timeScale: TradingViewTimeScaleApi | null) {
  try {
    return typeof timeScale?.rightOffset === 'function' ? timeScale.rightOffset() : null;
  } catch {
    return null;
  }
}

function styleToolbarButton(button: HTMLButtonElement, active: boolean) {
  button.dataset.active = active ? '1' : '0';
  button.style.color = active ? '#f0b90b' : 'rgba(255,255,255,0.58)';
}

function updateToolbarButtons(
  buttons: Map<string, HTMLButtonElement>,
  chartMode: 'time' | 'candle',
  interval: string,
) {
  for (const [key, button] of buttons.entries()) {
    styleToolbarButton(button, chartMode === 'time' ? key === TIME_SHARING_KEY : key === interval);
  }
}

export default function SpotTradingViewChart({
  symbol,
  displaySymbol,
  interval,
  height = 520,
  pricePrecision,
  amountPrecision,
  isLoading: marketDataLoading = false,
  chartMode = 'candle',
  intervalSwitchLoading = false,
  onIntervalChange,
  onChartModeChange,
  onIntervalSwitchLoadComplete,
}: SpotTradingViewChartProps) {
  const { locale, t } = useLocaleContext();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const widgetRef = useRef<TradingViewWidgetInstance | null>(null);
  const datafeedRef = useRef<ReturnType<typeof createSpotTradingViewDatafeed> | null>(null);
  const chartReadyRef = useRef(false);
  const currentResolutionRef = useRef('');
  const pendingResolutionRef = useRef('');
  const resolutionRequestSeqRef = useRef(0);
  const resolutionFallbackKeyRef = useRef('');
  const warnedResolutionFallbackRef = useRef(false);
  const activeIntervalRef = useRef('');
  const chartModeRef = useRef<'time' | 'candle'>(chartMode);
  const normalizedSymbolRef = useRef('');
  const widgetIntervalRef = useRef('');
  const initialVisibleRangeAppliedKeyRef = useRef('');
  const initialVisibleRangeApplySeqRef = useRef(0);
  const pendingInitialVisibleRangeRef = useRef<SpotTradingViewHistoryBarsEvent | null>(null);
  const recentVisibleRangeEventsRef = useRef<Map<string, SpotRecentVisibleRangeEvent>>(new Map());
  const preloadManagerRef = useRef<SpotKlinePreloadManager | null>(null);
  const toolbarButtonRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const chartLoadingSeqRef = useRef(0);
  const chartLoadingStartedAtRef = useRef(0);
  const [loadError, setLoadError] = useState<TradingViewLoadError | null>(null);
  const [scriptReady, setScriptReady] = useState(false);
  const [resolutionFallbackNonce, setResolutionFallbackNonce] = useState(0);
  const [chartLoadingReason, setChartLoadingReason] = useState<string>('initial');
  const reactId = useId();
  const containerId = useMemo(
    () => `spot-tv-chart-${reactId.replace(/[^a-zA-Z0-9_-]/g, '')}`,
    [reactId],
  );
  const resolutionKlineOwner = useMemo(
    () => `${SPOT_TV_RESOLUTION_KLINE_OWNER_PREFIX}:${containerId}`,
    [containerId],
  );

  const normalizedSymbol = useMemo(() => normalizeTradingViewSymbol(symbol), [symbol]);
  const activeInterval = chartMode === 'time' ? '1m' : interval;
  const widgetInterval = useMemo(() => spotIntervalToTradingViewResolution(activeInterval), [activeInterval]);
  const widgetStyle = chartMode === 'time' ? TRADINGVIEW_CHART_STYLE.line : TRADINGVIEW_CHART_STYLE.candle;
  const widgetKey = `${normalizedSymbol}:${chartMode}:${locale}:${pricePrecision ?? 'auto'}:${amountPrecision ?? 'auto'}:${resolutionFallbackNonce}`;
  const displayName = displaySymbol || formatSpotDisplaySymbol(normalizedSymbol);
  const activeLoadError = loadError?.key === widgetKey ? loadError.message : '';
  const showChartLoading = Boolean(chartLoadingReason || marketDataLoading || intervalSwitchLoading) && !activeLoadError;

  const startChartLoading = useCallback((reason: string) => {
    chartLoadingSeqRef.current += 1;
    chartLoadingStartedAtRef.current = getSpotChartPerfNow();
    setChartLoadingReason(reason);
  }, []);

  const finishChartLoading = useCallback((reason: string) => {
    const loadingSeq = chartLoadingSeqRef.current;
    const elapsedMs = Math.max(0, getSpotChartPerfNow() - chartLoadingStartedAtRef.current);
    const finishDelayMs = Math.max(0, SPOT_TV_LOADING_MIN_VISIBLE_MS - elapsedMs);
    markSpotKlinePerf('chart_loading_end', {
      symbol: normalizedSymbolRef.current,
      interval: activeIntervalRef.current,
      resolution: widgetIntervalRef.current,
      reason,
      duration_ms: elapsedMs,
      finish_delay_ms: finishDelayMs,
    });
    window.setTimeout(() => window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        if (chartLoadingSeqRef.current === loadingSeq) {
          setChartLoadingReason('');
          onIntervalSwitchLoadComplete?.();
        }
      });
    }), finishDelayMs);
  }, [onIntervalSwitchLoadComplete]);

  const getPreloadManager = useCallback(() => {
    if (!preloadManagerRef.current) {
      preloadManagerRef.current = createSpotKlinePreloadManager({
        getState: () => {
          const intervalValue = activeIntervalRef.current || '1m';
          return {
            symbol: normalizedSymbolRef.current,
            interval: intervalValue,
            resolution: widgetIntervalRef.current || spotIntervalToTradingViewResolution(intervalValue),
          };
        },
      });
    }
    return preloadManagerRef.current;
  }, []);

  const requestResolutionFallbackRebuild = useCallback(
    (nextResolution: string, reason: string, error?: unknown) => {
      const fallbackKey = `${widgetKey}:${nextResolution}`;
      if (resolutionFallbackKeyRef.current === fallbackKey) return;

      resolutionFallbackKeyRef.current = fallbackKey;
      markSpotKlinePerf('fallback_rebuild_start', {
        symbol: normalizedSymbolRef.current,
        interval: activeIntervalRef.current,
        resolution: nextResolution,
        widgetKey,
        note: reason,
        error: error instanceof Error ? error.message : error ? String(error) : undefined,
      });
      if (!warnedResolutionFallbackRef.current) {
        warnedResolutionFallbackRef.current = true;
        console.warn('[SpotTradingViewChart] setResolution fallback to widget rebuild', {
          resolution: nextResolution,
          reason,
          error: error instanceof Error ? error.message : error ? String(error) : undefined,
        });
      }
      setResolutionFallbackNonce((value) => value + 1);
    },
    [widgetKey],
  );

  const clearScheduledKlinePreload = useCallback((reason: string) => {
    getPreloadManager().cancel(reason);
  }, [getPreloadManager]);

  const scheduleKlinePreload = useCallback((event: SpotTradingViewHistoryBarsEvent, reason: string) => {
    getPreloadManager().schedule(event, reason);
  }, [getPreloadManager]);

  const releaseResolutionKlineInterval = useCallback(
    (reason: string, symbolOverride?: string) => {
      const activeSymbol = normalizeTradingViewSymbol(symbolOverride || normalizedSymbolRef.current);
      if (!activeSymbol) return;

      const result = spotMarketRealtime.releaseKlineIntervalOwner({
        symbol: activeSymbol,
        owner: resolutionKlineOwner,
      });
      markSpotKlinePerf('kline_interval_sync_release', {
        symbol: activeSymbol,
        previousInterval: result?.previousInterval ?? null,
        owner: resolutionKlineOwner,
        released: result?.released ?? false,
        reason,
        source: 'SpotTradingViewChart',
      });
    },
    [resolutionKlineOwner],
  );

  const syncKlineIntervalAfterResolutionCommit = useCallback(
    (reason: string) => {
      const activeSymbol = normalizedSymbolRef.current;
      if (!activeSymbol) return;

      const uiInterval = activeIntervalRef.current || '1m';
      const backendInterval = getBackendKlineIntervalForSpotInterval(uiInterval);
      const datafeedRealtimeIntervals = datafeedRef.current?.getActiveRealtimeIntervals() ?? [];
      const datafeedRealtimeMatched =
        datafeedRealtimeIntervals.length > 0 &&
        datafeedRealtimeIntervals.every((activeInterval) => activeInterval === backendInterval);
      const syncResult = spotMarketRealtime.syncKlineInterval({
        symbol: activeSymbol,
        interval: backendInterval,
        owner: resolutionKlineOwner,
      });
      const datafeedSyncResult = datafeedRealtimeMatched
        ? null
        : datafeedRef.current?.syncRealtimeKlineSubscription(
          backendInterval,
          'resolution_commit_interval_mismatch',
        );

      markSpotKlinePerf('kline_interval_sync_after_resolution_commit', {
        symbol: activeSymbol,
        uiInterval,
        interval: backendInterval,
        backendInterval,
        previousInterval: syncResult?.previousInterval ?? null,
        owner: resolutionKlineOwner,
        subscriptionId: syncResult?.subscriptionId ?? null,
        changed: syncResult?.changed ?? false,
        datafeedRealtimeIntervals,
        datafeedRealtimeMatched,
        syncedDatafeedOwner: Boolean(datafeedSyncResult),
        datafeedSyncChanged: datafeedSyncResult?.changed ?? false,
        datafeedActiveIntervalsAfterSync: datafeedSyncResult?.activeIntervals ?? datafeedRealtimeIntervals,
        datafeedDroppedIntervals: datafeedSyncResult?.droppedIntervals ?? [],
        reason,
        source: 'SpotTradingViewChart',
      });
    },
    [resolutionKlineOwner],
  );

  const applyInitialVisibleRangeFromHistory = useCallback(
    (event: SpotTradingViewHistoryBarsEvent, triggerReason = 'history-callback') => {
      scheduleKlinePreload(event, triggerReason);
      const activeSymbol = normalizedSymbolRef.current;
      const activeIntervalValue = activeIntervalRef.current || '1m';
      const backendInterval = event.backendInterval || getBackendKlineIntervalForSpotInterval(activeIntervalValue);
      const activeResolution = widgetIntervalRef.current || spotIntervalToTradingViewResolution(activeIntervalValue);
      const eventSymbol = normalizeTradingViewSymbol(event.symbol);
      const applyKey = `${activeSymbol}:${activeResolution}:${backendInterval}`;
      const latestBarTimeMs = Number(event.lastBarTime || 0);
      const rangeInfo = resolveInitialVisibleRangeFromLatestBar(activeIntervalValue, latestBarTimeMs);
      const baseDebugPayload = {
        phase: 'initial-visible-range',
        symbol: event.symbol,
        activeSymbol,
        resolution: event.resolution,
        activeResolution,
        interval: event.interval,
        backendInterval,
        activeInterval: activeIntervalValue,
        requestSeq: event.requestSeq,
        barCount: event.barCount,
        requiredBars: event.requiredBars,
        latestBarTime: latestBarTimeMs || null,
        latestBarTimeIso: latestBarTimeMs ? new Date(latestBarTimeMs).toISOString() : null,
        targetVisibleBars: rangeInfo?.targetVisibleBars ?? null,
        from: rangeInfo?.range.from ?? null,
        to: rangeInfo?.range.to ?? null,
      };

      if (event.isHistoryRequest || event.phase !== 'current') {
        spotTradingViewChartDebug('initial-visible-range', {
          ...baseDebugPayload,
          applied: false,
          reason: 'skip non-current getBars callback',
        });
        return;
      }
      if (!event.barCount || !rangeInfo) {
        markSpotKlinePerf('visible_range_skip_no_bars', {
          symbol: event.symbol,
          interval: event.interval,
          backendInterval,
          resolution: event.resolution,
          requestId: event.requestSeq,
          bars_count: event.barCount,
          targetBars: rangeInfo?.targetVisibleBars ?? null,
          firstTime: event.firstBarTime,
          lastTime: event.lastBarTime,
          reason: 'empty current bars',
          source: triggerReason,
        });
        spotTradingViewChartDebug('initial-visible-range', {
          ...baseDebugPayload,
          applied: false,
          reason: 'skip empty bars',
        });
        return;
      }
      if (!activeSymbol || eventSymbol !== activeSymbol || event.resolution !== activeResolution) {
        spotTradingViewChartDebug('initial-visible-range', {
          ...baseDebugPayload,
          applied: false,
          reason: 'skip stale symbol or resolution',
        });
        return;
      }
      const recentVisibleRangeEvent: SpotRecentVisibleRangeEvent = {
        ...event,
        backendInterval,
        updatedAt: Date.now(),
      };
      finishChartLoading('history-bars');
      recentVisibleRangeEventsRef.current.set(
        buildVisibleRangeSnapshotKey(activeSymbol, backendInterval),
        recentVisibleRangeEvent,
      );
      markSpotKlinePerf('visible_range_after_history_bars', {
        symbol: event.symbol,
        interval: event.interval,
        backendInterval,
        resolution: event.resolution,
        requestId: event.requestSeq,
        bars_count: event.barCount,
        targetBars: rangeInfo.targetVisibleBars,
        firstTime: event.firstBarTime,
        lastTime: event.lastBarTime,
        reason: triggerReason,
      });
      if (initialVisibleRangeAppliedKeyRef.current === applyKey) {
        spotTradingViewChartDebug('initial-visible-range', {
          ...baseDebugPayload,
          applied: false,
          reason: 'already applied',
        });
        return;
      }
      if (
        pendingResolutionRef.current === event.resolution &&
        currentResolutionRef.current !== event.resolution
      ) {
        pendingInitialVisibleRangeRef.current = event;
        spotTradingViewChartDebug('initial-visible-range', {
          ...baseDebugPayload,
          applied: false,
          reason: 'wait for resolution dataReady',
        });
        return;
      }

      const widget = widgetRef.current;
      const chart = widget?.activeChart?.();
      if (!widget || !chartReadyRef.current || !chart || typeof chart.setVisibleRange !== 'function') {
        pendingInitialVisibleRangeRef.current = event;
        spotTradingViewChartDebug('initial-visible-range', {
          ...baseDebugPayload,
          applied: false,
          reason: !widget ? 'widget not ready' : 'chart not ready',
        });
        return;
      }

      initialVisibleRangeAppliedKeyRef.current = applyKey;
      pendingInitialVisibleRangeRef.current = null;
      const applySeq = ++initialVisibleRangeApplySeqRef.current;
      const visibleRangeRequestId = createSpotKlinePerfId('visible-range');
      window.setTimeout(() => {
        if (initialVisibleRangeApplySeqRef.current !== applySeq) return;
        if (widgetRef.current !== widget) return;
        if (normalizedSymbolRef.current !== activeSymbol) return;
        if (widgetIntervalRef.current !== activeResolution) return;

        const timeScale = typeof chart.getTimeScale === 'function' ? chart.getTimeScale() : null;
        const canSetRightOffset = typeof timeScale?.setRightOffset === 'function';
        const rightOffsetRange = canSetRightOffset ? rangeInfo.range : rangeInfo.fallbackRange;
        const applyRightOffset = (stage: string) => {
          if (!canSetRightOffset) return false;
          try {
            timeScale.setRightOffset?.(rangeInfo.rightPaddingBars);
            const visibleRange = readTradingViewVisibleRange(chart);
            const currentRightOffset = readTradingViewRightOffset(timeScale);
            spotTradingViewChartDebug('right-offset-applied', {
              ...baseDebugPayload,
              stage,
              applied: true,
              rightOffsetApiAvailable: true,
              rightPaddingBars: rangeInfo.rightPaddingBars,
              currentRightOffset,
              visibleFrom: visibleRange?.from ?? null,
              visibleTo: visibleRange?.to ?? null,
              rightPaddingClamped: visibleRange?.to ? visibleRange.to <= rangeInfo.latestBarTime : null,
            });
            return true;
          } catch (error) {
            spotTradingViewChartDebug('right-offset-applied', {
              ...baseDebugPayload,
              stage,
              applied: false,
              rightOffsetApiAvailable: true,
              rightPaddingBars: rangeInfo.rightPaddingBars,
              error: error instanceof Error ? error.message : String(error),
            });
            return false;
          }
        };
        const stabilizeRightPadding = (stage: string) => {
          window.requestAnimationFrame(() => {
            window.setTimeout(() => {
              if (initialVisibleRangeApplySeqRef.current !== applySeq) return;
              if (widgetRef.current !== widget) return;
              if (normalizedSymbolRef.current !== activeSymbol) return;
              if (widgetIntervalRef.current !== activeResolution) return;
              if (canSetRightOffset) {
                applyRightOffset(stage);
                return;
              }
              const visibleRange = readTradingViewVisibleRange(chart);
              spotTradingViewChartDebug('right-offset-applied', {
                ...baseDebugPayload,
                stage,
                applied: false,
                rightOffsetApiAvailable: false,
                rightPaddingBars: rangeInfo.rightPaddingBars,
                visibleFrom: visibleRange?.from ?? null,
                visibleTo: visibleRange?.to ?? null,
                rightPaddingClamped: visibleRange?.to ? visibleRange.to <= rangeInfo.latestBarTime : null,
                reason: 'timeScale right offset unavailable',
              });
            }, 50);
          });
        };

        applyRightOffset('before-visible-range');
        const visibleRangeStartedAt = getSpotChartPerfNow();
        markSpotKlinePerf('visible_range_apply_start', {
          symbol: event.symbol,
          interval: event.interval,
          backendInterval,
          resolution: event.resolution,
          requestId: event.requestSeq,
          visibleRangeRequestId,
          bars_count: event.barCount,
          targetBars: rangeInfo.targetVisibleBars,
          targetVisibleBars: rangeInfo.targetVisibleBars,
          firstTime: event.firstBarTime,
          lastTime: event.lastBarTime,
          from: rightOffsetRange.from,
          to: rightOffsetRange.to,
          reason: triggerReason,
          source: triggerReason,
        });
        const maybePromise = chart.setVisibleRange?.(rightOffsetRange, {
          applyDefaultRightMargin: false,
          percentRightMargin: 0,
          rejectByTimeout: 1500,
        });
        const debugPayload = {
          ...baseDebugPayload,
          rightPaddingBars: rangeInfo.rightPaddingBars,
          intervalSeconds: rangeInfo.intervalSeconds,
          rightOffsetApiAvailable: canSetRightOffset,
          rightOffsetApplied: canSetRightOffset,
          from: rightOffsetRange.from,
          to: rightOffsetRange.to,
          applied: true,
          reason: triggerReason,
        };
        if (maybePromise && typeof maybePromise.catch === 'function') {
          void maybePromise
            .then(() => {
              applyRightOffset('after-visible-range');
              stabilizeRightPadding('stabilize-visible-range');
              const visibleRange = readTradingViewVisibleRange(chart);
              markSpotKlinePerf('visible_range_apply_end', {
                symbol: event.symbol,
                interval: event.interval,
                backendInterval,
                resolution: event.resolution,
                requestId: event.requestSeq,
                visibleRangeRequestId,
                duration_ms: Math.max(0, getSpotChartPerfNow() - visibleRangeStartedAt),
                bars_count: event.barCount,
                targetBars: rangeInfo.targetVisibleBars,
                targetVisibleBars: rangeInfo.targetVisibleBars,
                firstTime: event.firstBarTime,
                lastTime: event.lastBarTime,
                visibleFrom: visibleRange?.from ?? null,
                visibleTo: visibleRange?.to ?? null,
                reason: triggerReason,
                source: triggerReason,
              });
              spotTradingViewChartDebug('initial-visible-range', {
                ...debugPayload,
                visibleFrom: visibleRange?.from ?? null,
                visibleTo: visibleRange?.to ?? null,
                rightPaddingClamped: visibleRange?.to ? visibleRange.to <= rangeInfo.latestBarTime : null,
              });
            })
            .catch((error: unknown) => {
              initialVisibleRangeAppliedKeyRef.current = '';
              markSpotKlinePerf('visible_range_apply_end', {
                symbol: event.symbol,
                interval: event.interval,
                backendInterval,
                resolution: event.resolution,
                requestId: event.requestSeq,
                visibleRangeRequestId,
                duration_ms: Math.max(0, getSpotChartPerfNow() - visibleRangeStartedAt),
                bars_count: event.barCount,
                targetBars: rangeInfo.targetVisibleBars,
                targetVisibleBars: rangeInfo.targetVisibleBars,
                firstTime: event.firstBarTime,
                lastTime: event.lastBarTime,
                source: triggerReason,
                reason: triggerReason,
                error: error instanceof Error ? error.message : String(error),
              });
              spotTradingViewChartDebug('initial-visible-range', {
                ...debugPayload,
                applied: false,
                reason: 'setVisibleRange rejected',
                error: error instanceof Error ? error.message : String(error),
              });
            });
          return;
        }
        applyRightOffset('after-visible-range');
        stabilizeRightPadding('stabilize-visible-range');
        const visibleRange = readTradingViewVisibleRange(chart);
        markSpotKlinePerf('visible_range_apply_end', {
          symbol: event.symbol,
          interval: event.interval,
          backendInterval,
          resolution: event.resolution,
          requestId: event.requestSeq,
          visibleRangeRequestId,
          duration_ms: Math.max(0, getSpotChartPerfNow() - visibleRangeStartedAt),
          bars_count: event.barCount,
          targetBars: rangeInfo.targetVisibleBars,
          targetVisibleBars: rangeInfo.targetVisibleBars,
          firstTime: event.firstBarTime,
          lastTime: event.lastBarTime,
          visibleFrom: visibleRange?.from ?? null,
          visibleTo: visibleRange?.to ?? null,
          reason: triggerReason,
          source: triggerReason,
        });
        spotTradingViewChartDebug('initial-visible-range', {
          ...debugPayload,
          visibleFrom: visibleRange?.from ?? null,
          visibleTo: visibleRange?.to ?? null,
          rightPaddingClamped: visibleRange?.to ? visibleRange.to <= rangeInfo.latestBarTime : null,
        });
      }, SPOT_TV_INITIAL_VISIBLE_RANGE_DELAY_MS);
    },
    [finishChartLoading, scheduleKlinePreload],
  );

  const resetInitialVisibleRangeIntent = useCallback(() => {
    pendingInitialVisibleRangeRef.current = null;
    initialVisibleRangeAppliedKeyRef.current = '';
    initialVisibleRangeApplySeqRef.current += 1;
  }, []);

  const applyRecentVisibleRangeAfterResolutionCommit = useCallback(
    (reason: string) => {
      const activeSymbol = normalizedSymbolRef.current;
      const activeIntervalValue = activeIntervalRef.current || '1m';
      const backendInterval = getBackendKlineIntervalForSpotInterval(activeIntervalValue);
      const activeResolution = widgetIntervalRef.current || spotIntervalToTradingViewResolution(activeIntervalValue);
      const targetBars =
        SPOT_TV_INITIAL_VISIBLE_BARS[activeIntervalValue] ?? SPOT_TV_INITIAL_VISIBLE_BARS['1d'];
      const recentRange = activeSymbol
        ? recentVisibleRangeEventsRef.current.get(buildVisibleRangeSnapshotKey(activeSymbol, backendInterval))
        : null;

      if (
        !recentRange ||
        !recentRange.barCount ||
        !recentRange.lastBarTime ||
        recentRange.resolution !== activeResolution
      ) {
        markSpotKlinePerf('visible_range_skip_no_bars', {
          symbol: activeSymbol,
          interval: activeIntervalValue,
          backendInterval,
          resolution: activeResolution,
          targetBars,
          bars_count: recentRange?.barCount ?? 0,
          firstTime: recentRange?.firstBarTime ?? null,
          lastTime: recentRange?.lastBarTime ?? null,
          reason: recentRange ? 'no matching recent current bars range' : 'no recent current bars range',
          source: reason,
        });
        return false;
      }

      markSpotKlinePerf('visible_range_after_resolution_commit', {
        symbol: activeSymbol,
        interval: activeIntervalValue,
        backendInterval,
        resolution: activeResolution,
        targetBars,
        bars_count: recentRange.barCount,
        firstTime: recentRange.firstBarTime,
        lastTime: recentRange.lastBarTime,
        cache_age_ms: Math.max(0, Date.now() - recentRange.updatedAt),
        reason,
      });

      resetInitialVisibleRangeIntent();
      applyInitialVisibleRangeFromHistory(recentRange, reason);
      return true;
    },
    [applyInitialVisibleRangeFromHistory, resetInitialVisibleRangeIntent],
  );

  const applyWidgetResolution = useCallback(
    (nextResolution: string) => {
      if (!nextResolution) return;

      const activeIntervalValue = activeIntervalRef.current;
      startChartLoading('resolution-change');
      markSpotKlinePerf('apply_resolution_start', {
        symbol: normalizedSymbolRef.current,
        interval: activeIntervalValue,
        resolution: nextResolution,
        currentResolution: currentResolutionRef.current,
        pendingResolution: pendingResolutionRef.current || null,
      });
      const widget = widgetRef.current;
      if (!widget || !chartReadyRef.current) {
        pendingResolutionRef.current = nextResolution;
        markSpotKlinePerf('apply_resolution_start', {
          symbol: normalizedSymbolRef.current,
          interval: activeIntervalValue,
          resolution: nextResolution,
          currentResolution: currentResolutionRef.current,
          note: !widget ? 'widget not ready' : 'chart not ready',
        });
        return;
      }

      if (currentResolutionRef.current === nextResolution) {
        pendingResolutionRef.current = '';
        updateToolbarButtons(toolbarButtonRefs.current, chartModeRef.current, activeIntervalRef.current);
        syncKlineIntervalAfterResolutionCommit('already_current_resolution');
        applyRecentVisibleRangeAfterResolutionCommit('already_current_resolution');
        finishChartLoading('already-current-resolution');
        markSpotKlinePerf('set_resolution_data_ready', {
          symbol: normalizedSymbolRef.current,
          interval: activeIntervalValue,
          resolution: nextResolution,
          currentResolution: currentResolutionRef.current,
          note: 'already current resolution',
          duration_ms: 0,
        });
        return;
      }

      const chart = widget.activeChart?.();
      const setResolution = chart?.setResolution;
      if (typeof setResolution !== 'function') {
        pendingResolutionRef.current = nextResolution;
        markSpotKlinePerf('set_resolution_error', {
          symbol: normalizedSymbolRef.current,
          interval: activeIntervalValue,
          resolution: nextResolution,
          note: 'setResolution unavailable',
        });
        requestResolutionFallbackRebuild(nextResolution, 'setResolution unavailable');
        return;
      }

      const requestSeq = ++resolutionRequestSeqRef.current;
      const resolutionRequestId = createSpotKlinePerfId('set-resolution');
      const setResolutionStartedAt = getSpotChartPerfNow();
      pendingResolutionRef.current = nextResolution;
      resetInitialVisibleRangeIntent();
      let finished = false;

      const finishResolutionChange = () => {
        if (finished || resolutionRequestSeqRef.current !== requestSeq || widgetRef.current !== widget) return;
        finished = true;
        const durationMs = Math.max(0, getSpotChartPerfNow() - setResolutionStartedAt);
        currentResolutionRef.current = nextResolution;
        pendingResolutionRef.current = '';
        updateToolbarButtons(toolbarButtonRefs.current, chartModeRef.current, activeIntervalRef.current);
        markSpotKlinePerf('set_resolution_data_ready', {
          symbol: normalizedSymbolRef.current,
          interval: activeIntervalRef.current,
          resolution: nextResolution,
          requestId: requestSeq,
          resolutionRequestId,
          duration_ms: durationMs,
        });
        finishChartLoading('resolution-data-ready');
        syncKlineIntervalAfterResolutionCommit('resolution_commit');
        const pendingInitialRange = pendingInitialVisibleRangeRef.current;
        if (pendingInitialRange) {
          applyInitialVisibleRangeFromHistory(pendingInitialRange, 'resolution-data-ready');
        } else {
          applyRecentVisibleRangeAfterResolutionCommit('resolution_commit');
        }
      };

      try {
        markSpotKlinePerf('set_resolution_called', {
          symbol: normalizedSymbolRef.current,
          interval: activeIntervalValue,
          resolution: nextResolution,
          requestId: requestSeq,
          resolutionRequestId,
          previousResolution: currentResolutionRef.current,
        });
        const maybePromise = setResolution.call(chart, nextResolution, {
          dataReady: finishResolutionChange,
        });
        if (maybePromise && typeof maybePromise.then === 'function') {
          void maybePromise.then((changed) => {
            if (changed === false) {
              markSpotKlinePerf('set_resolution_error', {
                symbol: normalizedSymbolRef.current,
                interval: activeIntervalRef.current,
                resolution: nextResolution,
                requestId: requestSeq,
                resolutionRequestId,
                duration_ms: Math.max(0, getSpotChartPerfNow() - setResolutionStartedAt),
                note: 'setResolution returned false',
              });
              requestResolutionFallbackRebuild(nextResolution, 'setResolution returned false');
              return;
            }
            finishResolutionChange();
          }).catch((error: unknown) => {
            pendingResolutionRef.current = nextResolution;
            markSpotKlinePerf('set_resolution_error', {
              symbol: normalizedSymbolRef.current,
              interval: activeIntervalRef.current,
              resolution: nextResolution,
              requestId: requestSeq,
              resolutionRequestId,
              duration_ms: Math.max(0, getSpotChartPerfNow() - setResolutionStartedAt),
              error: error instanceof Error ? error.message : String(error),
            });
            requestResolutionFallbackRebuild(nextResolution, 'setResolution rejected', error);
          });
        }
      } catch (error) {
        pendingResolutionRef.current = nextResolution;
        markSpotKlinePerf('set_resolution_error', {
          symbol: normalizedSymbolRef.current,
          interval: activeIntervalRef.current,
          resolution: nextResolution,
          requestId: requestSeq,
          resolutionRequestId,
          duration_ms: Math.max(0, getSpotChartPerfNow() - setResolutionStartedAt),
          error: error instanceof Error ? error.message : String(error),
        });
        requestResolutionFallbackRebuild(nextResolution, 'setResolution threw', error);
      }
    },
    [
      applyInitialVisibleRangeFromHistory,
      applyRecentVisibleRangeAfterResolutionCommit,
      finishChartLoading,
      requestResolutionFallbackRebuild,
      resetInitialVisibleRangeIntent,
      startChartLoading,
      syncKlineIntervalAfterResolutionCommit,
    ],
  );

  useEffect(() => {
    chartModeRef.current = chartMode;
    normalizedSymbolRef.current = normalizedSymbol;
    activeIntervalRef.current = activeInterval;
    widgetIntervalRef.current = widgetInterval;
  }, [activeInterval, chartMode, normalizedSymbol, widgetInterval]);

  useEffect(() => () => {
    clearScheduledKlinePreload('symbol changed or component unmounted');
    releaseResolutionKlineInterval('symbol changed or component unmounted', normalizedSymbol);
  }, [clearScheduledKlinePreload, normalizedSymbol, releaseResolutionKlineInterval]);

  useEffect(() => {
    let cancelled = false;

    const cleanupWidget = () => {
      clearScheduledKlinePreload('widget cleanup');
      releaseResolutionKlineInterval('widget cleanup', normalizedSymbol);
      resolutionRequestSeqRef.current += 1;
      chartReadyRef.current = false;
      currentResolutionRef.current = '';
      pendingResolutionRef.current = '';
      initialVisibleRangeApplySeqRef.current += 1;
      initialVisibleRangeAppliedKeyRef.current = '';
      pendingInitialVisibleRangeRef.current = null;
      recentVisibleRangeEventsRef.current.clear();
      toolbarButtonRefs.current.clear();
      widgetRef.current?.remove();
      widgetRef.current = null;
      datafeedRef.current?.destroy();
      datafeedRef.current = null;
    };

    cleanupWidget();

    if (!scriptReady || !normalizedSymbol || !containerRef.current) {
      return cleanupWidget;
    }

    const tradingView = (window as SpotTradingViewWindow).TradingView;
    if (!tradingView?.widget) {
      window.setTimeout(() => {
        if (cancelled) return;
        setLoadError({
          key: widgetKey,
          message: 'TradingView widget is unavailable',
        });
      }, 0);
      return cleanupWidget;
    }

    const initialInterval = activeIntervalRef.current || '1m';
    const initialResolution =
      widgetIntervalRef.current || spotIntervalToTradingViewResolution(initialInterval);
    chartReadyRef.current = false;
    currentResolutionRef.current = initialResolution;
    pendingResolutionRef.current = '';
    toolbarButtonRefs.current.clear();

    const datafeed = createSpotTradingViewDatafeed({
      symbol: normalizedSymbol,
      displaySymbol: displayName,
      pricePrecision,
      amountPrecision,
      onHistoryBars: applyInitialVisibleRangeFromHistory,
      debugEnabled: isSpotTradingViewDebugEnabled(),
    });
    datafeedRef.current = datafeed;
    const widgetBuildLoadingTimer = window.setTimeout(() => {
      if (!cancelled) {
        startChartLoading('widget-build');
      }
    }, 0);

    const widget = new tradingView.widget({
      autosize: true,
      symbol: normalizedSymbol,
      interval: initialResolution,
      container: containerId,
      datafeed,
      library_path: TRADINGVIEW_LIBRARY_PATH,
      locale: resolveTradingViewLocale(locale),
      timezone: TRADINGVIEW_TIMEZONE,
      theme: 'dark',
      style: widgetStyle,
      header_widget_buttons_mode: 'compact',
      disabled_features: [
        'use_localstorage_for_settings',
        'header_symbol_search',
        'header_compare',
        'header_resolutions',
        'symbol_search_hot_key',
        'display_market_status',
        'volume_force_overlay',
      ],
      enabled_features: ['iframe_loading_same_origin', 'custom_resolutions'],
      overrides: {
        'paneProperties.background': '#12161c',
        'paneProperties.backgroundType': 'solid',
        'paneProperties.vertGridProperties.color': 'rgba(255,255,255,0.04)',
        'paneProperties.horzGridProperties.color': 'rgba(255,255,255,0.04)',
        'scalesProperties.textColor': 'rgba(255,255,255,0.65)',
        'scalesProperties.showStudyLastValue': false,
        'scalesProperties.showStudyPlotLabels': false,
        volumePaneSize: 'small',
        'mainSeriesProperties.style': widgetStyle,
        'mainSeriesProperties.areaStyle.color1': 'rgba(240,185,11,0.24)',
        'mainSeriesProperties.areaStyle.color2': 'rgba(240,185,11,0.02)',
        'mainSeriesProperties.areaStyle.linecolor': '#f0b90b',
        'mainSeriesProperties.areaStyle.linewidth': 2,
        'mainSeriesProperties.candleStyle.upColor': '#00c087',
        'mainSeriesProperties.candleStyle.downColor': '#f6465d',
        'mainSeriesProperties.candleStyle.borderUpColor': '#00c087',
        'mainSeriesProperties.candleStyle.borderDownColor': '#f6465d',
        'mainSeriesProperties.candleStyle.wickUpColor': '#00c087',
        'mainSeriesProperties.candleStyle.wickDownColor': '#f6465d',
      },
      studies_overrides: {
        'volume.volume.color.0': 'rgba(246,70,93,0.45)',
        'volume.volume.color.1': 'rgba(0,192,135,0.45)',
      },
      custom_css_url: '',
      loading_screen: {
        backgroundColor: '#12161c',
        foregroundColor: '#f0b90b',
      },
    });
    widgetRef.current = widget;

    const markChartReady = () => {
      if (cancelled || widgetRef.current !== widget) return;
      chartReadyRef.current = true;
      const pendingResolution = pendingResolutionRef.current;
      if (pendingResolution && pendingResolution !== currentResolutionRef.current) {
        applyWidgetResolution(pendingResolution);
      } else {
        pendingResolutionRef.current = '';
      }
      const pendingInitialRange = pendingInitialVisibleRangeRef.current;
      if (pendingInitialRange) {
        applyInitialVisibleRangeFromHistory(pendingInitialRange, 'chart-ready');
      }
    };

    if (typeof widget.onChartReady === 'function') {
      widget.onChartReady(markChartReady);
    } else {
      window.setTimeout(markChartReady, 0);
    }

    widget.headerReady().then(() => {
      if (cancelled) return;
      const toolbarSlot = widget.createButton({ align: 'left', useTradingViewStyle: false });
      toolbarSlot.setAttribute('title', '');
      toolbarSlot.style.display = 'inline-flex';
      toolbarSlot.style.alignItems = 'center';
      toolbarSlot.style.gap = '16px';
      toolbarSlot.style.height = '100%';
      toolbarSlot.style.padding = '0 8px';
      toolbarSlot.style.margin = '0';
      toolbarSlot.style.background = 'transparent';
      toolbarSlot.style.border = '0';
      toolbarSlot.style.cursor = 'default';

      const makeButton = (key: string, label: string, onClick: () => void) => {
        const button = toolbarSlot.ownerDocument.createElement('button');
        button.type = 'button';
        button.textContent = label;
        button.style.border = '0';
        button.style.padding = '0';
        button.style.margin = '0';
        button.style.background = 'transparent';
        styleToolbarButton(button, false);
        button.style.font = '500 13px/1 Arial, sans-serif';
        button.style.cursor = 'pointer';
        button.style.whiteSpace = 'nowrap';
        button.addEventListener('mouseenter', () => {
          if (button.dataset.active !== '1') button.style.color = 'rgba(255,255,255,0.86)';
        });
        button.addEventListener('mouseleave', () => {
          if (button.dataset.active !== '1') button.style.color = 'rgba(255,255,255,0.58)';
        });
        button.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          onClick();
        });
        toolbarSlot.appendChild(button);
        toolbarButtonRefs.current.set(key, button);
      };

      makeButton(TIME_SHARING_KEY, TIME_SHARING_LABEL, () => {
        if (chartModeRef.current !== 'time') {
          startChartLoading('toolbar-mode-change');
        }
        onChartModeChange?.('time');
      });
      SPOT_INTERVAL_OPTIONS.forEach((item) => {
        makeButton(item, formatIntervalLabel(item), () => {
          if (chartModeRef.current !== 'candle' || activeIntervalRef.current !== item) {
            startChartLoading('toolbar-interval-click');
          }
          if (chartModeRef.current !== 'candle') {
            onChartModeChange?.('candle');
          }
          spotTradingViewChartDebug('interval-change-requested', {
            interval: item,
            activeInterval: activeIntervalRef.current,
            source: 'tradingview-toolbar',
          });
          onIntervalChange?.(item);
        });
      });
      updateToolbarButtons(toolbarButtonRefs.current, chartMode, activeIntervalRef.current);
    }).catch(() => undefined);

    return () => {
      cancelled = true;
      window.clearTimeout(widgetBuildLoadingTimer);
      cleanupWidget();
    };
  }, [
    applyWidgetResolution,
    applyInitialVisibleRangeFromHistory,
    amountPrecision,
    clearScheduledKlinePreload,
    chartMode,
    containerId,
    displayName,
    locale,
    normalizedSymbol,
    onChartModeChange,
    onIntervalChange,
    pricePrecision,
    releaseResolutionKlineInterval,
    scriptReady,
    startChartLoading,
    widgetKey,
    widgetStyle,
  ]);

  useEffect(() => {
    let cancelled = false;

    const timer = window.setTimeout(() => {
      if (!cancelled) applyWidgetResolution(widgetInterval);
    }, 0);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [activeInterval, applyWidgetResolution, chartMode, widgetInterval]);

  useEffect(() => {
    if (!chartLoadingReason) return undefined;

    const timer = window.setTimeout(() => {
      finishChartLoading('safety-timeout');
    }, 5000);

    return () => window.clearTimeout(timer);
  }, [chartLoadingReason, finishChartLoading]);

  return (
    <div className="relative flex h-full min-h-[420px] w-full flex-col bg-[#12161c]" style={{ minHeight: height }}>
      <Script
        src={TRADINGVIEW_SCRIPT_SRC}
        strategy="afterInteractive"
        onReady={() => setScriptReady(true)}
        onError={() => {
          setLoadError({
            key: widgetKey,
            message: 'Failed to load TradingView library',
          });
        }}
      />
      <div
        id={containerId}
        ref={containerRef}
        className="min-h-0 flex-1"
        aria-label={`${displayName || normalizedSymbol} ${chartMode === 'time' ? 'time' : activeInterval}`}
      />
      {activeLoadError ? (
        <div className="absolute inset-0 flex items-center justify-center bg-[#12161c] px-4 text-center text-sm text-[#f6465d]">
          {t('spotChartLoadFailed', 'asset')}: {activeLoadError}
        </div>
      ) : null}
      {showChartLoading ? (
        <div
          className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-[#12161c]/75"
          style={{
            backgroundImage:
              'linear-gradient(rgba(255,255,255,0.035) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.035) 1px, transparent 1px)',
            backgroundSize: '80px 58px',
          }}
          aria-hidden="true"
        >
          <div className="flex items-center gap-2 rounded-full border border-white/[0.06] bg-[#0b0e11]/55 px-4 py-3 shadow-[0_18px_50px_rgba(0,0,0,0.36)]">
            {[0, 1, 2, 3].map((item) => (
              <span
                key={item}
                className="h-2 w-2 animate-bounce rounded-full bg-[#f0b90b] shadow-[0_0_14px_rgba(240,185,11,0.72)]"
                style={{ animationDelay: `${item * 110}ms` }}
              />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
