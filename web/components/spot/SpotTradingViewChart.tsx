'use client';

import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import Script from 'next/script';
import type { ChartPropertiesOverrides } from '../../public/tradingview/charting_library/charting_library';
import { useLocaleContext } from '@/contexts/LocaleContext';
import { spotMarketRealtime } from '@/services/marketRealtime';
import type { SpotChartProps } from './chart/chart.types';
import { formatSpotDisplaySymbol } from './spotFormat';
import {
  createSpotTradingViewDatafeed,
  spotIntervalToTradingViewResolution,
  tradingViewResolutionToSpotInterval,
  type SpotTradingViewHistoryBarsEvent,
  type SpotTradingViewRealtimeEvent,
} from './tradingview/spotTradingViewDatafeed';
import type {
  SpotDisplayPrice,
  SpotNativeCandleDisplayPrice,
} from './spotDisplayPrice';
import {
  isCurrentSpotTradingViewKlineFallback,
  SpotTradingViewPriceOverlayController,
  type SpotTradingViewOverlayChart,
} from './tradingview/spotTradingViewPriceOverlay';
import { getBackendKlineIntervalForSpotInterval } from './tradingview/spotKlineClientCache';
import {
  createSpotKlinePreloadManager,
  type SpotKlinePreloadManager,
} from './tradingview/spotKlinePreloadManager';
import {
  createSpotKlinePerfId,
  markSpotKlinePerf,
} from './tradingview/spotKlinePerf';
import {
  requestSpotSetResolution,
  setSpotToolbarLoadingState,
  shouldStartSpotChartResolutionChange,
  SpotChartLoadingCoordinator,
  SpotResolutionIntentCoordinator,
  type SpotChartLoadingToken,
  type SpotResolutionIntentToken,
} from './tradingview/spotTradingViewResolutionState';

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
  ) => Promise<boolean> | boolean | void;
  resolution?: () => string;
  setVisibleRange?: (
    range: TradingViewVisibleRange,
    options?: TradingViewVisibleRangeOptions,
  ) => Promise<void> | void;
  getVisibleRange?: () => TradingViewVisibleRange;
  getTimeScale?: () => TradingViewTimeScaleApi;
  createShape?: SpotTradingViewOverlayChart['createShape'];
  getShapeById?: SpotTradingViewOverlayChart['getShapeById'];
  removeEntity?: SpotTradingViewOverlayChart['removeEntity'];
};

type TradingViewWidgetInstance = {
  remove: () => void;
  activeChart?: () => TradingViewChartApi;
  chartReady: () => Promise<void>;
  applyOverrides?: (overrides: Partial<ChartPropertiesOverrides>) => void;
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

type SpotTradingViewChartProps = Omit<SpotChartProps, 'isLoading'> & {
  displayPrice: SpotDisplayPrice;
  chartMode?: 'time' | 'candle';
  intervalSwitchLoading?: boolean;
  onIntervalChange?: (value: string) => void;
  onChartModeChange?: (value: 'time' | 'candle') => void;
  onIntervalSwitchLoadComplete?: () => void;
  onIntervalResolutionCommit?: (value: string) => void;
  onIntervalResolutionFailure?: (rollbackValue: string) => void;
  onNativeCandleDisplay?: (value: SpotNativeCandleDisplayPrice) => void;
};

type SpotTradingViewWindow = {
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

type SpotChartLoadingToolbarOwner = {
  token: SpotChartLoadingToken;
  toolbarSlot: HTMLElement | null;
  toolbarButtons: Map<string, HTMLButtonElement>;
};

const TRADINGVIEW_LIBRARY_PATH = '/tradingview/charting_library/';
const TRADINGVIEW_SCRIPT_SRC = `${TRADINGVIEW_LIBRARY_PATH}charting_library.js`;
const TRADINGVIEW_TIMEZONE = 'Asia/Shanghai';
const TRADINGVIEW_CHART_STYLE = {
  candle: 1,
  line: 2,
} as const;
const SPOT_INTERVAL_OPTIONS = ['1m', '5m', '15m', '1h', '4h', '1d', '1w', '1M'];
const TIME_SHARING_LABEL = 'Time';
const TIME_SHARING_KEY = 'time';
const SPOT_TV_DEBUG_EVENT_LIMIT = 500;
const SPOT_TV_INITIAL_RIGHT_PADDING_BARS = 4;
const SPOT_TV_INITIAL_VISIBLE_RANGE_DELAY_MS = 80;
const SPOT_TV_RESOLUTION_KLINE_OWNER_PREFIX = 'spot-tradingview-chart-resolution';
const SPOT_TV_PRICE_LABEL_OVERRIDES = {
  'mainSeriesProperties.showPriceLine': false,
  'scalesProperties.showSeriesLastValue': false,
} satisfies Partial<ChartPropertiesOverrides>;
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
  const debugWindow = window as unknown as SpotTradingViewWindow;
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
  chartMode = 'candle',
  intervalSwitchLoading = false,
  onIntervalChange,
  onChartModeChange,
  onIntervalSwitchLoadComplete,
  onIntervalResolutionCommit,
  onIntervalResolutionFailure,
  displayPrice,
  onNativeCandleDisplay,
}: SpotTradingViewChartProps) {
  const { locale, t } = useLocaleContext();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const widgetRef = useRef<TradingViewWidgetInstance | null>(null);
  const datafeedRef = useRef<ReturnType<typeof createSpotTradingViewDatafeed> | null>(null);
  const chartReadyRef = useRef(false);
  const resolutionIntentCoordinatorRef = useRef(new SpotResolutionIntentCoordinator());
  const resolutionRequestSeqRef = useRef(0);
  const resolutionRequestCancelRef = useRef<(() => void) | null>(null);
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
  const toolbarSlotRef = useRef<HTMLElement | null>(null);
  const chartLoadingCoordinatorRef = useRef<SpotChartLoadingCoordinator | null>(null);
  const widgetGenerationSequenceRef = useRef(0);
  const activeWidgetGenerationRef = useRef(0);
  const activeChartLoadingTokenRef = useRef<SpotChartLoadingToken | null>(null);
  const chartLoadingToolbarOwnerRef = useRef<SpotChartLoadingToolbarOwner | null>(null);
  const priceOverlayControllerRef = useRef<SpotTradingViewPriceOverlayController | null>(null);
  const displayPriceRef = useRef(displayPrice);
  const onNativeCandleDisplayRef = useRef(onNativeCandleDisplay);
  const onIntervalSwitchLoadCompleteRef = useRef(onIntervalSwitchLoadComplete);
  const onIntervalResolutionCommitRef = useRef(onIntervalResolutionCommit);
  const onIntervalResolutionFailureRef = useRef(onIntervalResolutionFailure);
  const [loadError, setLoadError] = useState<TradingViewLoadError | null>(null);
  const [scriptReady, setScriptReady] = useState(false);
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
  const widgetKey = `${normalizedSymbol}:${chartMode}:${locale}:${pricePrecision ?? 'auto'}:${amountPrecision ?? 'auto'}`;
  const displayName = displaySymbol || formatSpotDisplaySymbol(normalizedSymbol);
  const activeLoadError = loadError?.key === widgetKey ? loadError.message : '';
  const showChartLoading = Boolean(chartLoadingReason || intervalSwitchLoading) && !activeLoadError;

  const restoreToolbarInteractionAfterReady = useCallback((widgetGeneration: number) => {
    window.requestAnimationFrame(() => {
      if (activeWidgetGenerationRef.current !== widgetGeneration) return;
      const activeToken = activeChartLoadingTokenRef.current;
      if (activeToken && chartLoadingCoordinatorRef.current?.isActive(activeToken)) return;
      setSpotToolbarLoadingState(toolbarSlotRef.current, toolbarButtonRefs.current, {
        loading: false,
      });
    });
  }, []);

  const getChartLoadingCoordinator = useCallback(() => {
    if (!chartLoadingCoordinatorRef.current) {
      chartLoadingCoordinatorRef.current = new SpotChartLoadingCoordinator({
        onChange: setChartLoadingReason,
        onSettled: (token) => {
          const toolbarOwner = chartLoadingToolbarOwnerRef.current;
          if (
            toolbarOwner
            && toolbarOwner.token.widgetGeneration === token.widgetGeneration
            && toolbarOwner.token.sequence === token.sequence
          ) {
            setSpotToolbarLoadingState(
              toolbarOwner.toolbarSlot,
              toolbarOwner.toolbarButtons,
              { loading: false },
            );
            chartLoadingToolbarOwnerRef.current = null;
          }
          if (
            activeChartLoadingTokenRef.current?.widgetGeneration === token.widgetGeneration
            && activeChartLoadingTokenRef.current?.sequence === token.sequence
          ) {
            activeChartLoadingTokenRef.current = null;
          }
          if (activeWidgetGenerationRef.current === token.widgetGeneration) {
            onIntervalSwitchLoadCompleteRef.current?.();
            restoreToolbarInteractionAfterReady(token.widgetGeneration);
          }
        },
      });
    }
    return chartLoadingCoordinatorRef.current;
  }, [restoreToolbarInteractionAfterReady]);

  const startChartLoading = useCallback((reason: string, widgetGeneration: number) => {
    if (!widgetGeneration || activeWidgetGenerationRef.current !== widgetGeneration) return null;
    const token = getChartLoadingCoordinator().start(widgetGeneration, reason);
    const toolbarOwner: SpotChartLoadingToolbarOwner = {
      token,
      toolbarSlot: toolbarSlotRef.current,
      toolbarButtons: new Map(toolbarButtonRefs.current),
    };
    activeChartLoadingTokenRef.current = token;
    chartLoadingToolbarOwnerRef.current = toolbarOwner;
    const resolutionState = resolutionIntentCoordinatorRef.current.snapshot();
    setSpotToolbarLoadingState(toolbarOwner.toolbarSlot, toolbarOwner.toolbarButtons, {
      loading: true,
      pendingKey: resolutionState.pendingResolution
        ? tradingViewResolutionToSpotInterval(resolutionState.pendingResolution.resolution)
        : undefined,
    });
    return token;
  }, [getChartLoadingCoordinator]);

  const finishChartLoading = useCallback((
    reason: string,
    token: SpotChartLoadingToken | null = activeChartLoadingTokenRef.current,
  ) => {
    if (!token || token.widgetGeneration !== activeWidgetGenerationRef.current) return false;
    const elapsedMs = Math.max(0, Date.now() - token.startedAt);
    markSpotKlinePerf('chart_loading_end', {
      symbol: normalizedSymbolRef.current,
      interval: activeIntervalRef.current,
      resolution: widgetIntervalRef.current,
      reason,
      duration_ms: elapsedMs,
      loading_sequence: token.sequence,
      widget_generation: token.widgetGeneration,
      loading_intent: token.intent,
    });
    return getChartLoadingCoordinator().finish(token);
  }, [getChartLoadingCoordinator]);

  const retireChartLoadingGeneration = useCallback((widgetGeneration: number) => {
    const toolbarOwner = chartLoadingToolbarOwnerRef.current;
    if (toolbarOwner?.token.widgetGeneration === widgetGeneration) {
      setSpotToolbarLoadingState(
        toolbarOwner.toolbarSlot,
        toolbarOwner.toolbarButtons,
        { loading: false },
      );
      chartLoadingToolbarOwnerRef.current = null;
    }
    if (activeChartLoadingTokenRef.current?.widgetGeneration === widgetGeneration) {
      activeChartLoadingTokenRef.current = null;
    }
    return chartLoadingCoordinatorRef.current?.retireGeneration(widgetGeneration) ?? false;
  }, []);

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
      const resolutionState = resolutionIntentCoordinatorRef.current.snapshot();
      if (
        resolutionState.inFlightResolution === event.resolution &&
        resolutionState.currentResolution !== event.resolution
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
    [scheduleKlinePreload],
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

  const handleDatafeedHistoryBars = useCallback((
    event: SpotTradingViewHistoryBarsEvent,
    widgetGeneration: number,
  ) => {
    if (activeWidgetGenerationRef.current !== widgetGeneration) return;
    applyInitialVisibleRangeFromHistory(event);
    if (event.isHistoryRequest || event.phase !== 'current') return;

    const activeSymbol = normalizedSymbolRef.current;
    const activeIntervalValue = activeIntervalRef.current || '1m';
    const activeResolution = widgetIntervalRef.current || spotIntervalToTradingViewResolution(activeIntervalValue);
    const activeBackendInterval = getBackendKlineIntervalForSpotInterval(activeIntervalValue);
    if (
      normalizeTradingViewSymbol(event.symbol) !== activeSymbol
      || event.resolution !== activeResolution
      || event.backendInterval !== activeBackendInterval
    ) {
      return;
    }

    const resolutionState = resolutionIntentCoordinatorRef.current.snapshot();
    if (
      resolutionState.currentResolution === event.resolution
      && !resolutionState.inFlightResolution
      && !resolutionState.pendingResolution
    ) {
      finishChartLoading(event.barCount > 0 ? 'current-history-bars' : 'current-history-empty');
    }
    if (event.lastBarClose !== null && event.lastBarTime !== null) {
      onNativeCandleDisplayRef.current?.({
        symbol: activeSymbol,
        interval: activeIntervalValue,
        price: event.lastBarClose,
        eventTimeMs: event.lastBarTime,
        receivedAtMs: Date.now(),
        source: 'REST_HISTORY',
        provider: null,
        freshness: 'CACHED',
      });
    }
  }, [applyInitialVisibleRangeFromHistory, finishChartLoading]);

  const handleDatafeedRealtime = useCallback((event: SpotTradingViewRealtimeEvent) => {
    const activeIntervalValue = activeIntervalRef.current || event.interval;
    if (!isCurrentSpotTradingViewKlineFallback({
      eventSymbol: event.symbol,
      eventInterval: event.interval,
      activeSymbol: normalizedSymbolRef.current,
      activeBackendInterval: getBackendKlineIntervalForSpotInterval(activeIntervalValue),
    })) return;
    onNativeCandleDisplayRef.current?.({
      symbol: event.symbol,
      interval: activeIntervalValue,
      price: event.close,
      eventTimeMs: event.barTime,
      receivedAtMs: event.receivedAtMs,
      source: event.source,
      provider: event.provider,
      freshness: event.freshness,
    });
  }, []);

  const applyWidgetResolution = useCallback(
    (nextResolution: string, widgetGeneration = activeWidgetGenerationRef.current) => {
      if (!nextResolution) return;
      if (!widgetGeneration || activeWidgetGenerationRef.current !== widgetGeneration) return;

      const activeIntervalValue = activeIntervalRef.current;
      const widget = widgetRef.current;
      const canStart = Boolean(widget && chartReadyRef.current);
      const intentCoordinator = resolutionIntentCoordinatorRef.current;
      const previousIntentState = intentCoordinator.snapshot();
      const latestIntent = intentCoordinator.latestIntent()
        ?? intentCoordinator.registerIntent(nextResolution).intent;
      const intentDecision = intentCoordinator.request(latestIntent, { canStart });
      const updateToolbarIntentState = (
        loading: boolean,
        pendingResolution = intentDecision.snapshot.pendingResolution?.resolution,
      ) => {
        updateToolbarButtons(
          toolbarButtonRefs.current,
          chartModeRef.current,
          activeIntervalRef.current,
        );
        setSpotToolbarLoadingState(toolbarSlotRef.current, toolbarButtonRefs.current, {
          loading,
          pendingKey: pendingResolution
            ? tradingViewResolutionToSpotInterval(pendingResolution)
            : undefined,
        });
      };

      spotTradingViewChartDebug('resolution-intent-applied', {
        from: previousIntentState.currentResolution,
        to: nextResolution,
        intentId: latestIntent.intentId,
        latestIntentId: intentDecision.snapshot.latestIntentId,
        latestResolution: intentCoordinator.latestIntent()?.resolution || null,
        inFlightResolution: intentDecision.snapshot.inFlightResolution || null,
        pendingResolution: intentDecision.snapshot.pendingResolution?.resolution || null,
        pending: intentDecision.action === 'pending',
        action: intentDecision.action,
        requestSequence: intentDecision.snapshot.requestSequence,
        widgetGeneration,
      });
      markSpotKlinePerf('apply_resolution_start', {
        symbol: normalizedSymbolRef.current,
        interval: activeIntervalValue,
        resolution: nextResolution,
        intentId: latestIntent.intentId,
        latestIntentId: intentDecision.snapshot.latestIntentId,
        currentResolution: intentDecision.snapshot.currentResolution,
        inFlightResolution: intentDecision.snapshot.inFlightResolution || null,
        pendingResolution: intentDecision.snapshot.pendingResolution?.resolution || null,
        requestSequence: intentDecision.snapshot.requestSequence,
        widget_generation: widgetGeneration,
      });
      if (!canStart || !widget) {
        updateToolbarIntentState(Boolean(
          intentDecision.snapshot.inFlightResolution
          || intentDecision.snapshot.pendingResolution
          || activeChartLoadingTokenRef.current
        ));
        markSpotKlinePerf('apply_resolution_start', {
          symbol: normalizedSymbolRef.current,
          interval: activeIntervalValue,
          resolution: nextResolution,
          intentId: latestIntent.intentId,
          latestIntentId: intentDecision.snapshot.latestIntentId,
          currentResolution: intentDecision.snapshot.currentResolution,
          pendingResolution: intentDecision.snapshot.pendingResolution?.resolution || null,
          requestSequence: intentDecision.snapshot.requestSequence,
          widget_generation: widgetGeneration,
          note: !widget ? 'widget not ready' : 'chart not ready',
        });
        return;
      }

      if (intentDecision.action === 'pending') {
        updateToolbarIntentState(true);
        return;
      }

      if (intentDecision.action === 'stale') {
        updateToolbarIntentState(Boolean(
          intentDecision.snapshot.inFlightResolution
          || intentDecision.snapshot.pendingResolution
        ));
        return;
      }

      if (intentDecision.action === 'noop') {
        updateToolbarIntentState(Boolean(intentDecision.snapshot.inFlightResolution));
        if (
          intentDecision.snapshot.currentResolution !== nextResolution
          || intentDecision.snapshot.inFlightResolution
        ) return;
        syncKlineIntervalAfterResolutionCommit('already_current_resolution');
        applyRecentVisibleRangeAfterResolutionCommit('already_current_resolution');
        onIntervalResolutionCommitRef.current?.(activeIntervalValue);
        const activeToken = activeChartLoadingTokenRef.current;
        if (activeToken?.widgetGeneration === widgetGeneration) {
          finishChartLoading('already-current-resolution', activeToken);
        }
        markSpotKlinePerf('set_resolution_data_ready', {
          symbol: normalizedSymbolRef.current,
          interval: activeIntervalValue,
          resolution: nextResolution,
          currentResolution: intentDecision.snapshot.currentResolution,
          requestSequence: intentDecision.snapshot.requestSequence,
          widget_generation: widgetGeneration,
          note: 'already current resolution',
          duration_ms: 0,
        });
        return;
      }

      const runResolutionRequest = (intentToken: SpotResolutionIntentToken) => {
        if (!intentCoordinator.canStart(intentToken)) return;
        const resolution = intentToken.resolution;
        const targetInterval = tradingViewResolutionToSpotInterval(resolution);
        const targetBackendInterval = getBackendKlineIntervalForSpotInterval(targetInterval);
        const resolutionState = intentCoordinator.snapshot();

        if (!shouldStartSpotChartResolutionChange({
          widgetAvailable: Boolean(widget),
          chartReady: chartReadyRef.current,
          currentResolution: resolutionState.currentResolution,
          nextResolution: resolution,
        })) return;

        const loadingToken = startChartLoading('resolution-change', widgetGeneration);
        if (!loadingToken) return;
        getPreloadManager().setForegroundState({
          loading: true,
          symbol: normalizedSymbolRef.current,
          interval: targetBackendInterval,
          generation: intentToken.requestSequence,
        });

        const chart = widget.activeChart?.();
        const requestSeq = ++resolutionRequestSeqRef.current;
        const resolutionRequestId = createSpotKlinePerfId('set-resolution');
        const setResolutionStartedAt = getSpotChartPerfNow();
        const previousResolution = resolutionState.currentResolution;
        const rollbackInterval = tradingViewResolutionToSpotInterval(previousResolution || '1');
        resetInitialVisibleRangeIntent();
        resolutionRequestCancelRef.current?.();
        markSpotKlinePerf('set_resolution_called', {
          symbol: normalizedSymbolRef.current,
          interval: targetInterval,
          resolution,
          intentId: intentToken.intentId,
          latestIntentId: resolutionState.latestIntentId,
          requestId: requestSeq,
          requestSequence: intentToken.requestSequence,
          resolutionRequestId,
          previousResolution,
          widget_generation: widgetGeneration,
        });
        resolutionRequestCancelRef.current = requestSpotSetResolution({
          chart,
          resolution,
          isCurrent: () => (
            resolutionRequestSeqRef.current === requestSeq
            && intentCoordinator.isCurrent(intentToken)
            && widgetRef.current === widget
            && activeWidgetGenerationRef.current === widgetGeneration
          ),
          onCommitted: (reason) => {
            resolutionRequestCancelRef.current = null;
            const settlement = intentCoordinator.commit(intentToken);
            if (!settlement.accepted) return;
            const durationMs = Math.max(0, getSpotChartPerfNow() - setResolutionStartedAt);
            markSpotKlinePerf('set_resolution_data_ready', {
              symbol: normalizedSymbolRef.current,
              interval: targetInterval,
              resolution,
              intentId: intentToken.intentId,
              latestIntentId: settlement.snapshot.latestIntentId,
              requestId: requestSeq,
              requestSequence: intentToken.requestSequence,
              resolutionRequestId,
              widget_generation: widgetGeneration,
              duration_ms: durationMs,
              note: reason,
            });
            spotTradingViewChartDebug('resolution-committed', {
              resolution,
              interval: targetInterval,
              requestId: resolutionRequestId,
              intentId: intentToken.intentId,
              latestIntentId: settlement.snapshot.latestIntentId,
              requestSequence: intentToken.requestSequence,
              pendingResolution: settlement.snapshot.pendingResolution?.resolution || null,
              nextResolution: settlement.nextToken?.resolution || null,
              widgetGeneration,
              reason,
            });

            if (settlement.nextToken) {
              const nextInterval = tradingViewResolutionToSpotInterval(settlement.nextToken.resolution);
              updateToolbarIntentState(true, settlement.nextToken.resolution);
              spotTradingViewChartDebug('pending-resolution-started', {
                resolution: settlement.nextToken.resolution,
                intentId: settlement.nextToken.intentId,
                interval: nextInterval,
                requestSequence: settlement.nextToken.requestSequence,
                previousResolution: resolution,
                widgetGeneration,
              });
              runResolutionRequest(settlement.nextToken);
              return;
            }

            updateToolbarButtons(toolbarButtonRefs.current, chartModeRef.current, targetInterval);
            onIntervalResolutionCommitRef.current?.(targetInterval);
            finishChartLoading('resolution-committed', loadingToken);
            getPreloadManager().setForegroundState({
              loading: false,
              symbol: normalizedSymbolRef.current,
              interval: targetBackendInterval,
              generation: intentToken.requestSequence,
            });
            syncKlineIntervalAfterResolutionCommit('resolution_commit');
            const pendingInitialRange = pendingInitialVisibleRangeRef.current;
            if (pendingInitialRange) {
              applyInitialVisibleRangeFromHistory(pendingInitialRange, 'resolution-committed');
            } else {
              applyRecentVisibleRangeAfterResolutionCommit('resolution_commit');
            }
          },
          onFailed: (reason, error) => {
            resolutionRequestCancelRef.current = null;
            const settlement = intentCoordinator.fail(intentToken);
            if (!settlement.accepted) return;
            markSpotKlinePerf('set_resolution_error', {
              symbol: normalizedSymbolRef.current,
              interval: targetInterval,
              rollbackInterval,
              resolution,
              intentId: intentToken.intentId,
              latestIntentId: settlement.snapshot.latestIntentId,
              requestId: requestSeq,
              requestSequence: intentToken.requestSequence,
              resolutionRequestId,
              widget_generation: widgetGeneration,
              duration_ms: Math.max(0, getSpotChartPerfNow() - setResolutionStartedAt),
              note: reason,
              error: error instanceof Error ? error.message : error ? String(error) : undefined,
            });

            if (settlement.nextToken) {
              const nextInterval = tradingViewResolutionToSpotInterval(settlement.nextToken.resolution);
              updateToolbarIntentState(true, settlement.nextToken.resolution);
              spotTradingViewChartDebug('pending-resolution-started', {
                resolution: settlement.nextToken.resolution,
                intentId: settlement.nextToken.intentId,
                interval: nextInterval,
                requestSequence: settlement.nextToken.requestSequence,
                previousResolution: resolution,
                widgetGeneration,
                reason: 'previous resolution failed',
              });
              runResolutionRequest(settlement.nextToken);
              return;
            }

            const committedResolution = settlement.snapshot.currentResolution || previousResolution;
            const committedInterval = tradingViewResolutionToSpotInterval(committedResolution || '1');
            updateToolbarButtons(toolbarButtonRefs.current, chartModeRef.current, committedInterval);
            onIntervalResolutionFailureRef.current?.(committedInterval);
            finishChartLoading('resolution-failed', loadingToken);
            getPreloadManager().setForegroundState({
              loading: false,
              symbol: normalizedSymbolRef.current,
              interval: getBackendKlineIntervalForSpotInterval(committedInterval),
              generation: intentToken.requestSequence,
            });
          },
        });
      };

      if (!intentDecision.token) return;
      if (!shouldStartSpotChartResolutionChange({
        widgetAvailable: Boolean(widget),
        chartReady: chartReadyRef.current,
        currentResolution: previousIntentState.currentResolution,
        nextResolution,
      })) return;
      runResolutionRequest(intentDecision.token);
    },
    [
      applyInitialVisibleRangeFromHistory,
      applyRecentVisibleRangeAfterResolutionCommit,
      finishChartLoading,
      getPreloadManager,
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

  useEffect(() => {
    onIntervalSwitchLoadCompleteRef.current = onIntervalSwitchLoadComplete;
    onIntervalResolutionCommitRef.current = onIntervalResolutionCommit;
    onIntervalResolutionFailureRef.current = onIntervalResolutionFailure;
  }, [onIntervalResolutionCommit, onIntervalResolutionFailure, onIntervalSwitchLoadComplete]);

  useEffect(() => {
    displayPriceRef.current = displayPrice;
    onNativeCandleDisplayRef.current = onNativeCandleDisplay;
    priceOverlayControllerRef.current?.update(displayPrice);
  }, [displayPrice, onNativeCandleDisplay]);

  useEffect(() => () => {
    resolutionRequestCancelRef.current?.();
    resolutionRequestCancelRef.current = null;
    const toolbarOwner = chartLoadingToolbarOwnerRef.current;
    if (toolbarOwner) {
      setSpotToolbarLoadingState(
        toolbarOwner.toolbarSlot,
        toolbarOwner.toolbarButtons,
        { loading: false },
      );
      chartLoadingToolbarOwnerRef.current = null;
    }
    activeChartLoadingTokenRef.current = null;
    chartLoadingCoordinatorRef.current?.destroy();
    chartLoadingCoordinatorRef.current = null;
  }, []);

  useEffect(() => () => {
    clearScheduledKlinePreload('symbol changed or component unmounted');
    releaseResolutionKlineInterval('symbol changed or component unmounted', normalizedSymbol);
  }, [clearScheduledKlinePreload, normalizedSymbol, releaseResolutionKlineInterval]);

  useEffect(() => {
    let cancelled = false;
    let widgetGeneration = 0;

    const cleanupWidget = (generation = activeWidgetGenerationRef.current) => {
      if (generation && activeWidgetGenerationRef.current !== generation) return;
      if (generation) retireChartLoadingGeneration(generation);
      clearScheduledKlinePreload('widget cleanup');
      releaseResolutionKlineInterval('widget cleanup', normalizedSymbol);
      resolutionRequestCancelRef.current?.();
      resolutionRequestCancelRef.current = null;
      resolutionRequestSeqRef.current += 1;
      chartReadyRef.current = false;
      resolutionIntentCoordinatorRef.current.reset('');
      initialVisibleRangeApplySeqRef.current += 1;
      initialVisibleRangeAppliedKeyRef.current = '';
      pendingInitialVisibleRangeRef.current = null;
      recentVisibleRangeEventsRef.current.clear();
      toolbarButtonRefs.current.clear();
      toolbarSlotRef.current = null;
      priceOverlayControllerRef.current?.destroy();
      priceOverlayControllerRef.current = null;
      widgetRef.current?.remove();
      widgetRef.current = null;
      datafeedRef.current?.destroy();
      datafeedRef.current = null;
      if (!generation || activeWidgetGenerationRef.current === generation) {
        activeWidgetGenerationRef.current = 0;
      }
    };

    cleanupWidget();

    if (!scriptReady || !normalizedSymbol || !containerRef.current) {
      return cleanupWidget;
    }

    const tradingView = (window as unknown as SpotTradingViewWindow).TradingView;
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
    resolutionIntentCoordinatorRef.current.reset(initialResolution);
    toolbarButtonRefs.current.clear();
    widgetGeneration = ++widgetGenerationSequenceRef.current;
    activeWidgetGenerationRef.current = widgetGeneration;

    const datafeed = createSpotTradingViewDatafeed({
      symbol: normalizedSymbol,
      displaySymbol: displayName,
      pricePrecision,
      amountPrecision,
      onHistoryBars: (event) => handleDatafeedHistoryBars(event, widgetGeneration),
      onKlineRealtime: handleDatafeedRealtime,
      debugEnabled: isSpotTradingViewDebugEnabled(),
    });
    datafeedRef.current = datafeed;
    const widgetBuildLoadingTimer = window.setTimeout(() => {
      if (!cancelled && activeWidgetGenerationRef.current === widgetGeneration) {
        startChartLoading('widget-build', widgetGeneration);
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
        ...SPOT_TV_PRICE_LABEL_OVERRIDES,
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
      if (
        cancelled
        || widgetRef.current !== widget
        || activeWidgetGenerationRef.current !== widgetGeneration
      ) return;
      chartReadyRef.current = true;
      widget.applyOverrides?.(SPOT_TV_PRICE_LABEL_OVERRIDES);
      const chart = widget.activeChart?.();
      if (
        chart?.createShape
        && chart.getShapeById
        && chart.removeEntity
        && !priceOverlayControllerRef.current
      ) {
        priceOverlayControllerRef.current = new SpotTradingViewPriceOverlayController(
          chart as SpotTradingViewOverlayChart,
        );
        priceOverlayControllerRef.current.update(displayPriceRef.current);
      }
      const resolutionState = resolutionIntentCoordinatorRef.current.snapshot();
      const pendingResolution = resolutionState.pendingResolution;
      if (pendingResolution && pendingResolution.resolution !== resolutionState.currentResolution) {
        applyWidgetResolution(pendingResolution.resolution, widgetGeneration);
      } else {
        const activeToken = activeChartLoadingTokenRef.current;
        if (activeToken?.widgetGeneration === widgetGeneration) {
          finishChartLoading('chart-ready-current-resolution', activeToken);
        }
      }
      const pendingInitialRange = pendingInitialVisibleRangeRef.current;
      if (pendingInitialRange) {
        applyInitialVisibleRangeFromHistory(pendingInitialRange, 'chart-ready');
      }
      restoreToolbarInteractionAfterReady(widgetGeneration);
    };

    void widget.chartReady().then(markChartReady).catch(() => undefined);

    widget.headerReady().then(() => {
      if (
        cancelled
        || widgetRef.current !== widget
        || activeWidgetGenerationRef.current !== widgetGeneration
      ) return;
      const toolbarSlot = widget.createButton({ align: 'left', useTradingViewStyle: false });
      toolbarSlotRef.current = toolbarSlot;
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
        button.addEventListener('click', (event: MouseEvent) => {
          event.preventDefault();
          event.stopPropagation();
          onClick();
        });
        toolbarSlot.appendChild(button);
        toolbarButtonRefs.current.set(key, button);
      };

      makeButton(TIME_SHARING_KEY, TIME_SHARING_LABEL, () => {
        if (activeWidgetGenerationRef.current !== widgetGeneration) return;
        onChartModeChange?.('time');
      });
      SPOT_INTERVAL_OPTIONS.forEach((item) => {
        makeButton(item, formatIntervalLabel(item), () => {
          if (activeWidgetGenerationRef.current !== widgetGeneration) return;
          const targetResolution = spotIntervalToTradingViewResolution(item);
          const intentRegistration = resolutionIntentCoordinatorRef.current.registerIntent(targetResolution);
          const resolutionState = intentRegistration.snapshot;
          spotTradingViewChartDebug('resolution-intent-requested', {
            from: resolutionState.currentResolution,
            to: targetResolution,
            intentId: intentRegistration.intent.intentId,
            latestIntentId: resolutionState.latestIntentId,
            interval: item,
            inFlightResolution: resolutionState.inFlightResolution || null,
            pendingResolution: resolutionState.pendingResolution?.resolution || null,
            pending: Boolean(resolutionState.pendingResolution),
            requestSequence: resolutionState.requestSequence,
            widgetGeneration,
            source: 'tradingview-toolbar',
          });
          if (resolutionState.inFlightResolution || resolutionState.pendingResolution) {
            setSpotToolbarLoadingState(toolbarSlotRef.current, toolbarButtonRefs.current, {
              loading: true,
              pendingKey: resolutionState.pendingResolution ? item : undefined,
            });
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
      const activeToken = activeChartLoadingTokenRef.current;
      const loadingActive = Boolean(
        activeToken
        && activeToken.widgetGeneration === widgetGeneration
        && chartLoadingCoordinatorRef.current?.isActive(activeToken)
      );
      if (loadingActive && activeToken) {
        const toolbarOwner: SpotChartLoadingToolbarOwner = {
          token: activeToken,
          toolbarSlot,
          toolbarButtons: new Map(toolbarButtonRefs.current),
        };
        chartLoadingToolbarOwnerRef.current = toolbarOwner;
        const resolutionState = resolutionIntentCoordinatorRef.current.snapshot();
        setSpotToolbarLoadingState(toolbarOwner.toolbarSlot, toolbarOwner.toolbarButtons, {
          loading: true,
          pendingKey: resolutionState.pendingResolution
            ? tradingViewResolutionToSpotInterval(resolutionState.pendingResolution.resolution)
            : undefined,
        });
      } else {
        setSpotToolbarLoadingState(toolbarSlot, toolbarButtonRefs.current, { loading: false });
      }
      restoreToolbarInteractionAfterReady(widgetGeneration);
    }).catch(() => undefined);

    return () => {
      cancelled = true;
      window.clearTimeout(widgetBuildLoadingTimer);
      cleanupWidget(widgetGeneration);
    };
  }, [
    applyInitialVisibleRangeFromHistory,
    applyWidgetResolution,
    handleDatafeedHistoryBars,
    handleDatafeedRealtime,
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
    finishChartLoading,
    retireChartLoadingGeneration,
    restoreToolbarInteractionAfterReady,
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

  return (
    <div
      className="relative flex h-full min-h-[420px] w-full flex-col bg-[#12161c]"
      style={{ minHeight: height }}
      data-spot-display-price={displayPrice.price ?? ''}
      data-spot-display-domain={displayPrice.sourceDomain}
      data-spot-display-freshness={displayPrice.freshness}
    >
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
