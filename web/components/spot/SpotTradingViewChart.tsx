'use client';

import React, {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
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
  type SpotRealtimeSubscriptionReadiness,
  type SpotTradingViewCandleAuthorityEvent,
  type SpotTradingViewHistoryBarsEvent,
  type SpotTradingViewRealtimeEvent,
} from './tradingview/spotTradingViewDatafeed';
import type { SpotNativeCandleDisplayPrice } from './spotDisplayPrice';
import {
  isCurrentSpotTradingViewKlineFallback,
  SpotTradingViewPriceOverlayController,
  type SpotTradingViewCandleOverlayValue,
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
  scheduleSpotSubscriberReadinessGrace,
  setSpotToolbarLoadingState,
  shouldRequestSpotChartSubscriberRearm,
  shouldStartSpotChartResolutionChange,
  SpotChartLoadingCoordinator,
  SpotResolutionIntentCoordinator,
  type SpotChartLoadingToken,
  type SpotResolutionIntentToken,
} from './tradingview/spotTradingViewResolutionState';
import { applyTradingViewViewport } from '@/components/tradingview/tradingViewViewportLifecycle';
import {
  getKlineLifecycleSessionIdentity,
  type KlineLifecycleReducerResult,
  type KlineLifecycleSessionIdentity,
  type KlineLifecycleSubscriberEvidence,
} from '@/components/tradingview/klineLifecycleProtocol';
import { KlineLifecycleRuntimeCoordinator } from '@/components/tradingview/klineLifecycleRuntimeCoordinator';
import { bootstrapKlineLifecycleObservability } from '@/components/tradingview/klineLifecycleObservability';

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
};

type TradingViewChartApi = {
  dataReady?: () => Promise<boolean> | boolean;
  resetCache?: () => void;
  resetData?: () => void;
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
  onNativeCandleDisplay,
}: SpotTradingViewChartProps) {
  const { locale, t } = useLocaleContext();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const widgetRef = useRef<TradingViewWidgetInstance | null>(null);
  const datafeedRef = useRef<ReturnType<typeof createSpotTradingViewDatafeed> | null>(null);
  const chartReadyRef = useRef(false);
  const resolutionIntentCoordinatorRef = useRef(new SpotResolutionIntentCoordinator());
  const lifecycleRuntimeCoordinatorRef = useRef<KlineLifecycleRuntimeCoordinator | null>(null);
  const resolutionRequestSeqRef = useRef(0);
  const resolutionRequestCancelRef = useRef<(() => void) | null>(null);
  const subscriberReadinessGraceCancelRef = useRef<(() => void) | null>(null);
  const subscriberReadinessGraceSessionRef = useRef('');
  const activeIntervalRef = useRef('');
  const chartModeRef = useRef<'time' | 'candle'>(chartMode);
  const normalizedSymbolRef = useRef('');
  const widgetIntervalRef = useRef('');
  const initialVisibleRangeAppliedKeyRef = useRef('');
  const initialVisibleRangeInFlightKeyRef = useRef('');
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
  const activeCandleOverlayRef = useRef<SpotTradingViewCandleOverlayValue | null>(null);
  const activeCandleOverlayScopeRef = useRef('');
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
    const lifecycleSnapshot = lifecycleRuntimeCoordinatorRef.current?.snapshot();
    setSpotToolbarLoadingState(toolbarOwner.toolbarSlot, toolbarOwner.toolbarButtons, {
      loading: true,
      pendingKey: lifecycleSnapshot?.candidate
        ? tradingViewResolutionToSpotInterval(lifecycleSnapshot.candidate.tradingViewResolution)
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
        reason,
        source: 'SpotTradingViewChart',
      });
    },
    [resolutionKlineOwner],
  );

  const applyInitialVisibleRangeFromHistory = useCallback(
    (
      event: SpotTradingViewHistoryBarsEvent,
      triggerReason = 'history-callback',
      expectedWidgetGeneration = activeWidgetGenerationRef.current,
    ) => {
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
      if (
        initialVisibleRangeAppliedKeyRef.current === applyKey
        || initialVisibleRangeInFlightKeyRef.current === applyKey
      ) {
        spotTradingViewChartDebug('initial-visible-range', {
          ...baseDebugPayload,
          applied: false,
          reason: initialVisibleRangeAppliedKeyRef.current === applyKey
            ? 'already applied'
            : 'apply already in flight',
        });
        return;
      }
      const lifecycleSnapshot = lifecycleRuntimeCoordinatorRef.current?.snapshot();
      if (
        lifecycleSnapshot?.candidate?.tradingViewResolution === event.resolution
        && lifecycleSnapshot.committed?.tradingViewResolution !== event.resolution
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

      initialVisibleRangeInFlightKeyRef.current = applyKey;
      pendingInitialVisibleRangeRef.current = null;
      const applySeq = ++initialVisibleRangeApplySeqRef.current;
      const visibleRangeRequestId = createSpotKlinePerfId('visible-range');
      const visibleRangeStartedAt = getSpotChartPerfNow();
      const isCurrentViewportIntent = () => (
        initialVisibleRangeApplySeqRef.current === applySeq
        && activeWidgetGenerationRef.current === expectedWidgetGeneration
        && widgetRef.current === widget
        && normalizedSymbolRef.current === activeSymbol
        && widgetIntervalRef.current === activeResolution
        && activeIntervalRef.current === activeIntervalValue
      );
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
        from: rangeInfo.range.from,
        to: rangeInfo.range.to,
        reason: triggerReason,
        source: triggerReason,
      });
      void applyTradingViewViewport({
        chart,
        range: rangeInfo.range,
        fallbackRange: rangeInfo.fallbackRange,
        intervalSeconds: rangeInfo.intervalSeconds,
        rightPaddingBars: rangeInfo.rightPaddingBars,
        isCurrent: isCurrentViewportIntent,
        maxRetries: 1,
      }).then((result) => {
        if (initialVisibleRangeInFlightKeyRef.current === applyKey) {
          initialVisibleRangeInFlightKeyRef.current = '';
        }
        if (!isCurrentViewportIntent()) return;
        initialVisibleRangeAppliedKeyRef.current = result.applied ? applyKey : '';
        const visibleRange = result.visibleRange ?? readTradingViewVisibleRange(chart);
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
          attempts: result.attempts,
          applied: result.applied,
          note: result.reason,
        });
        spotTradingViewChartDebug('initial-visible-range', {
          ...baseDebugPayload,
          applied: result.applied,
          reason: result.reason,
          attempts: result.attempts,
          rightPaddingBars: rangeInfo.rightPaddingBars,
          intervalSeconds: rangeInfo.intervalSeconds,
          visibleFrom: visibleRange?.from ?? null,
          visibleTo: visibleRange?.to ?? null,
          rightPaddingClamped: visibleRange?.to ? visibleRange.to <= rangeInfo.latestBarTime : null,
        });
      });
    },
    [scheduleKlinePreload],
  );

  const resetInitialVisibleRangeIntent = useCallback(() => {
    pendingInitialVisibleRangeRef.current = null;
    initialVisibleRangeAppliedKeyRef.current = '';
    initialVisibleRangeInFlightKeyRef.current = '';
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

  const updateCandlePriceOverlay = useCallback((value: SpotTradingViewCandleOverlayValue) => {
    const activeIntervalValue = activeIntervalRef.current || value.interval;
    if (!isCurrentSpotTradingViewKlineFallback({
      eventSymbol: value.symbol,
      eventInterval: value.interval,
      activeSymbol: normalizedSymbolRef.current,
      activeBackendInterval: getBackendKlineIntervalForSpotInterval(activeIntervalValue),
    })) return;

    activeCandleOverlayRef.current = value;
    priceOverlayControllerRef.current?.update(value);
    if (containerRef.current) {
      containerRef.current.dataset.spotChartCandleClose = String(value.close);
      containerRef.current.dataset.spotChartCandleSource = value.source;
      containerRef.current.dataset.spotChartCandleBarTime = String(value.barTime);
    }
  }, []);

  const handleDatafeedHistoryBars = useCallback((
    event: SpotTradingViewHistoryBarsEvent,
    widgetGeneration: number,
  ) => {
    if (activeWidgetGenerationRef.current !== widgetGeneration) return;
    applyInitialVisibleRangeFromHistory(event, 'history-callback', widgetGeneration);
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

    const lifecycleSnapshot = lifecycleRuntimeCoordinatorRef.current?.snapshot();
    if (
      lifecycleSnapshot?.committed?.tradingViewResolution === event.resolution
      && !lifecycleSnapshot.candidate
      && !resolutionIntentCoordinatorRef.current.snapshot().activeToken
    ) {
      finishChartLoading(event.barCount > 0 ? 'current-history-bars' : 'current-history-empty');
    }
    if (event.lastBarClose !== null && event.lastBarTime !== null) {
      const receivedAtMs = Date.now();
      updateCandlePriceOverlay({
        symbol: activeSymbol,
        interval: event.backendInterval,
        close: event.lastBarClose,
        barTime: event.lastBarTime,
        source: 'REST_HISTORY',
        receivedAtMs,
      });
      onNativeCandleDisplayRef.current?.({
        symbol: activeSymbol,
        interval: activeIntervalValue,
        price: event.lastBarClose,
        eventTimeMs: event.lastBarTime,
        receivedAtMs,
        source: 'REST_HISTORY',
        provider: null,
        freshness: 'CACHED',
      });
    }
  }, [applyInitialVisibleRangeFromHistory, finishChartLoading, updateCandlePriceOverlay]);

  const handleCandleAuthority = useCallback((event: SpotTradingViewCandleAuthorityEvent) => {
    updateCandlePriceOverlay({
      symbol: event.symbol,
      interval: event.interval,
      close: event.close,
      barTime: event.barTime,
      source: event.source,
      receivedAtMs: event.receivedAtMs,
    });
  }, [updateCandlePriceOverlay]);

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

  const applyCommittedLifecycleEffects = useCallback((
    decision: KlineLifecycleReducerResult,
    reason: string,
    metrics?: {
      requestId?: number;
      requestSequence?: number;
      resolutionRequestId?: string;
      startedAt?: number;
    },
  ) => {
    const committed = decision.state.committed;
    if (!decision.accepted || !committed) return false;
    if (activeWidgetGenerationRef.current !== committed.widgetGeneration) return false;

    const targetInterval = tradingViewResolutionToSpotInterval(committed.tradingViewResolution);
    updateToolbarButtons(toolbarButtonRefs.current, chartModeRef.current, targetInterval);
    setSpotToolbarLoadingState(toolbarSlotRef.current, toolbarButtonRefs.current, { loading: false });
    if (committed.intentId > 1) onIntervalResolutionCommitRef.current?.(targetInterval);
    const loadingToken = activeChartLoadingTokenRef.current;
    if (loadingToken?.widgetGeneration === committed.widgetGeneration) {
      finishChartLoading('resolution-committed', loadingToken);
    }
    getPreloadManager().setForegroundState({
      loading: false,
      symbol: committed.symbol,
      interval: committed.backendInterval,
      generation: metrics?.requestSequence ?? committed.intentId,
    });
    syncKlineIntervalAfterResolutionCommit('resolution_commit');
    const pendingInitialRange = pendingInitialVisibleRangeRef.current;
    if (pendingInitialRange) {
      applyInitialVisibleRangeFromHistory(pendingInitialRange, 'resolution-committed');
    } else {
      applyRecentVisibleRangeAfterResolutionCommit('resolution_commit');
    }
    markSpotKlinePerf('set_resolution_data_ready', {
      symbol: committed.symbol,
      interval: targetInterval,
      resolution: committed.tradingViewResolution,
      intentId: committed.intentId,
      latestIntentId: decision.state.latestIntentId,
      requestId: metrics?.requestId,
      requestSequence: metrics?.requestSequence,
      resolutionRequestId: metrics?.resolutionRequestId,
      widget_generation: committed.widgetGeneration,
      duration_ms: metrics?.startedAt === undefined
        ? 0
        : Math.max(0, getSpotChartPerfNow() - metrics.startedAt),
      note: `${reason}; subscriber ready`,
    });
    spotTradingViewChartDebug('resolution-committed', {
      resolution: committed.tradingViewResolution,
      interval: targetInterval,
      intentId: committed.intentId,
      latestIntentId: decision.state.latestIntentId,
      requestSequence: metrics?.requestSequence ?? null,
      widgetGeneration: committed.widgetGeneration,
      reason,
    });
    return true;
  }, [
    applyInitialVisibleRangeFromHistory,
    applyRecentVisibleRangeAfterResolutionCommit,
    finishChartLoading,
    getPreloadManager,
    syncKlineIntervalAfterResolutionCommit,
  ]);

  const tryCommitRuntimeCandidate = useCallback((
    identity: KlineLifecycleSessionIdentity,
    reason: string,
    metrics?: Parameters<typeof applyCommittedLifecycleEffects>[2],
  ) => {
    const runtimeCoordinator = lifecycleRuntimeCoordinatorRef.current;
    if (!runtimeCoordinator) return false;
    const decision = runtimeCoordinator.tryCommit(identity);
    return applyCommittedLifecycleEffects(decision, reason, metrics);
  }, [applyCommittedLifecycleEffects]);

  const cancelSubscriberReadinessGrace = useCallback((sessionId?: string) => {
    if (
      sessionId
      && subscriberReadinessGraceSessionRef.current
      && subscriberReadinessGraceSessionRef.current !== sessionId
    ) return false;
    subscriberReadinessGraceCancelRef.current?.();
    subscriberReadinessGraceCancelRef.current = null;
    subscriberReadinessGraceSessionRef.current = '';
    return true;
  }, []);

  const requestMissingSubscriberRearm = useCallback((
    identity: KlineLifecycleSessionIdentity,
  ) => {
    const runtimeCoordinator = lifecycleRuntimeCoordinatorRef.current;
    const candidate = runtimeCoordinator?.snapshot().candidate;
    if (
      !runtimeCoordinator
      || !candidate
      || candidate.sessionId !== identity.sessionId
      || activeWidgetGenerationRef.current !== identity.widgetGeneration
    ) return false;

    const result = runtimeCoordinator.requestRearm(identity, 'SUBSCRIBER_MISSING');
    if (!result.allowed || !result.permit) return false;

    const chart = widgetRef.current?.activeChart?.() || null;
    if (
      typeof chart?.resetCache !== 'function'
      || typeof chart.resetData !== 'function'
    ) {
      runtimeCoordinator.recordResetExecution(
        identity,
        'SUBSCRIBER_MISSING',
        false,
        'RESET_EXECUTOR_UNAVAILABLE',
      );
      return false;
    }
    try {
      chart.resetCache();
      chart.resetData();
      // Executor success does not imply subscriber recovery. The Runtime candidate remains
      // RESOLUTION_APPLIED until the Datafeed produces matching readiness evidence.
      runtimeCoordinator.recordResetExecution(
        identity,
        'SUBSCRIBER_MISSING',
        true,
        'RESET_EXECUTED',
      );
      return true;
    } catch {
      runtimeCoordinator.recordResetExecution(
        identity,
        'SUBSCRIBER_MISSING',
        false,
        'RESET_EXECUTION_FAILED',
      );
      return false;
    }
  }, []);

  const recordRealtimeSubscriptionReadiness = useCallback((
    readiness: SpotRealtimeSubscriptionReadiness,
    widgetGeneration: number,
  ) => {
    if (activeWidgetGenerationRef.current !== widgetGeneration) return false;
    const runtimeCoordinator = lifecycleRuntimeCoordinatorRef.current;
    const datafeed = datafeedRef.current;
    const candidate = runtimeCoordinator?.snapshot().candidate;
    if (!runtimeCoordinator || !datafeed || !candidate) return false;

    const activeReadiness = datafeed.getRealtimeSubscriptionReadiness(
      readiness.symbol,
      readiness.interval,
    );
    if (
      !activeReadiness
      || activeReadiness.datafeedInstanceId !== readiness.datafeedInstanceId
      || activeReadiness.subscriberUid !== readiness.subscriberUid
      || activeReadiness.subscriptionGeneration !== readiness.subscriptionGeneration
      || activeReadiness.ownerId !== readiness.ownerId
      || candidate.widgetGeneration !== widgetGeneration
      || candidate.datafeedInstanceId !== readiness.datafeedInstanceId
      || candidate.symbol !== normalizeTradingViewSymbol(readiness.symbol)
      || candidate.backendInterval !== readiness.interval
    ) {
      return false;
    }
    const evidence: KlineLifecycleSubscriberEvidence = {
      ...getKlineLifecycleSessionIdentity(candidate),
      subscriberUid: readiness.subscriberUid,
      subscriptionGeneration: readiness.subscriptionGeneration,
      ownerId: readiness.ownerId,
    };
    const decision = runtimeCoordinator.recordSubscriber(evidence);
    if (!decision.accepted && decision.reason !== 'SUBSCRIBER_ALREADY_READY') return false;
    cancelSubscriberReadinessGrace(candidate.sessionId);
    tryCommitRuntimeCandidate(
      getKlineLifecycleSessionIdentity(candidate),
      'subscriber readiness',
    );
    return true;
  }, [cancelSubscriberReadinessGrace, tryCommitRuntimeCandidate]);

  const beginLifecycleIntent = useCallback((
    nextResolution: string,
    widgetGeneration: number,
  ): KlineLifecycleSessionIdentity | null => {
    const runtimeCoordinator = lifecycleRuntimeCoordinatorRef.current;
    const datafeed = datafeedRef.current;
    if (
      !runtimeCoordinator
      || !datafeed
      || activeWidgetGenerationRef.current !== widgetGeneration
    ) return null;

    const targetInterval = tradingViewResolutionToSpotInterval(nextResolution);
    const backendInterval = getBackendKlineIntervalForSpotInterval(targetInterval);
    const snapshot = runtimeCoordinator.snapshot();
    if (
      snapshot.candidate
      && snapshot.candidate.widgetGeneration === widgetGeneration
      && snapshot.candidate.datafeedInstanceId === datafeed.getDatafeedInstanceId()
      && snapshot.candidate.symbol === normalizedSymbolRef.current
      && snapshot.candidate.tradingViewResolution === nextResolution
      && snapshot.candidate.backendInterval === backendInterval
    ) {
      return getKlineLifecycleSessionIdentity(snapshot.candidate);
    }
    if (
      !snapshot.candidate
      && snapshot.committed?.tradingViewResolution === nextResolution
      && snapshot.committed.backendInterval === backendInterval
    ) return null;

    cancelSubscriberReadinessGrace();
    const result = runtimeCoordinator.beginIntent({
      tradingViewResolution: nextResolution,
      backendInterval,
    });
    if (!result.decision.accepted) return null;
    spotTradingViewChartDebug('resolution-intent-requested', {
      from: snapshot.committed?.tradingViewResolution || null,
      to: nextResolution,
      intentId: result.identity.intentId,
      latestIntentId: result.decision.state.latestIntentId,
      interval: targetInterval,
      pending: true,
      widgetGeneration,
    });
    return result.identity;
  }, [cancelSubscriberReadinessGrace]);

  const applyWidgetResolution = useCallback(
    (nextResolution: string, widgetGeneration = activeWidgetGenerationRef.current) => {
      if (!nextResolution || !widgetGeneration) return;
      if (activeWidgetGenerationRef.current !== widgetGeneration) return;

      const runtimeCoordinator = lifecycleRuntimeCoordinatorRef.current;
      const widget = widgetRef.current;
      if (!runtimeCoordinator || !widget) return;
      const identity = beginLifecycleIntent(nextResolution, widgetGeneration);
      if (!identity) return;
      const candidate = runtimeCoordinator.snapshot().candidate;
      if (!candidate || candidate.sessionId !== identity.sessionId) return;

      const transportCoordinator = resolutionIntentCoordinatorRef.current;
      const chart = widget.activeChart?.();
      const chartResolution = (() => {
        try {
          return String(chart?.resolution?.() || '');
        } catch {
          return '';
        }
      })();
      const isLatest = () => (
        lifecycleRuntimeCoordinatorRef.current?.snapshot().candidate?.sessionId === identity.sessionId
      );
      const updateToolbarIntentState = (loading: boolean) => {
        const candidateResolution = lifecycleRuntimeCoordinatorRef.current
          ?.snapshot().candidate?.tradingViewResolution;
        updateToolbarButtons(
          toolbarButtonRefs.current,
          chartModeRef.current,
          activeIntervalRef.current,
        );
        setSpotToolbarLoadingState(toolbarSlotRef.current, toolbarButtonRefs.current, {
          loading,
          pendingKey: candidateResolution
            ? tradingViewResolutionToSpotInterval(candidateResolution)
            : undefined,
        });
      };
      const scheduleLatestCandidate = () => {
        const latestCandidate = lifecycleRuntimeCoordinatorRef.current?.snapshot().candidate;
        if (!latestCandidate || latestCandidate.sessionId === identity.sessionId) return;
        window.setTimeout(() => {
          if (activeWidgetGenerationRef.current !== widgetGeneration) return;
          applyWidgetResolution(latestCandidate.tradingViewResolution, widgetGeneration);
        }, 0);
      };
      const recordActiveReadiness = () => {
        const readiness = datafeedRef.current?.getRealtimeSubscriptionReadiness(
          candidate.symbol,
          candidate.backendInterval,
        );
        return readiness
          ? recordRealtimeSubscriptionReadiness(readiness, widgetGeneration)
          : false;
      };
      const applyResolutionEvidence = (
        reason: string,
        metrics?: Parameters<typeof applyCommittedLifecycleEffects>[2],
      ) => {
        const activeRuntime = lifecycleRuntimeCoordinatorRef.current;
        if (!activeRuntime) return { applied: false, subscriberReady: false };
        const resolutionDecision = activeRuntime.applyResolution(identity);
        if (!resolutionDecision.accepted) return { applied: false, subscriberReady: false };
        const subscriberReady = recordActiveReadiness();
        if (subscriberReady) tryCommitRuntimeCandidate(identity, reason, metrics);
        return { applied: true, subscriberReady };
      };
      const retireMissingSubscriberCandidate = (
        metrics?: Parameters<typeof applyCommittedLifecycleEffects>[2],
      ) => {
        cancelSubscriberReadinessGrace(identity.sessionId);
        const activeRuntime = lifecycleRuntimeCoordinatorRef.current;
        if (!activeRuntime || !isLatest()) return false;
        const retireDecision = activeRuntime.retireSession(identity, 'SUBSCRIBER_TIMEOUT');
        if (!retireDecision.accepted) return false;
        const latestCandidate = activeRuntime.snapshot().candidate;
        if (latestCandidate) {
          scheduleLatestCandidate();
          return true;
        }

        const committed = retireDecision.state.committed;
        const stableResolution = committed?.tradingViewResolution || chartResolution || nextResolution;
        const stableInterval = tradingViewResolutionToSpotInterval(stableResolution);
        updateToolbarButtons(toolbarButtonRefs.current, chartModeRef.current, stableInterval);
        setSpotToolbarLoadingState(
          toolbarSlotRef.current,
          toolbarButtonRefs.current,
          { loading: false },
        );
        onIntervalResolutionFailureRef.current?.(stableInterval);
        const loadingToken = activeChartLoadingTokenRef.current;
        if (loadingToken?.widgetGeneration === widgetGeneration) {
          finishChartLoading('subscriber-timeout', loadingToken);
        }
        getPreloadManager().setForegroundState({
          loading: false,
          symbol: committed?.symbol || candidate.symbol,
          interval: committed?.backendInterval
            || getBackendKlineIntervalForSpotInterval(stableInterval),
          generation: metrics?.requestSequence ?? identity.intentId,
        });
        markSpotKlinePerf('set_resolution_error', {
          symbol: candidate.symbol,
          interval: tradingViewResolutionToSpotInterval(identity.tradingViewResolution),
          resolution: identity.tradingViewResolution,
          intentId: identity.intentId,
          latestIntentId: activeRuntime.snapshot().latestIntentId,
          requestId: metrics?.requestId,
          requestSequence: metrics?.requestSequence,
          resolutionRequestId: metrics?.resolutionRequestId,
          widget_generation: widgetGeneration,
          duration_ms: metrics?.startedAt === undefined
            ? 0
            : Math.max(0, getSpotChartPerfNow() - metrics.startedAt),
          note: 'subscriber readiness timed out after one-shot rearm',
        });
        return true;
      };
      const scheduleSubscriberGrace = (
        phase: 'BEFORE_REARM' | 'AFTER_REARM',
        metrics?: Parameters<typeof applyCommittedLifecycleEffects>[2],
      ) => {
        cancelSubscriberReadinessGrace();
        let cancelGrace: () => void = () => undefined;
        cancelGrace = scheduleSpotSubscriberReadinessGrace({
          isCurrent: isLatest,
          isSubscriberReady: recordActiveReadiness,
          onSettled: () => {
            if (subscriberReadinessGraceCancelRef.current !== cancelGrace) return;
            subscriberReadinessGraceCancelRef.current = null;
            subscriberReadinessGraceSessionRef.current = '';
          },
          onExpired: () => {
            if (phase === 'BEFORE_REARM' && requestMissingSubscriberRearm(identity)) {
              scheduleSubscriberGrace('AFTER_REARM', metrics);
              return;
            }
            retireMissingSubscriberCandidate(metrics);
          },
        });
        subscriberReadinessGraceCancelRef.current = cancelGrace;
        subscriberReadinessGraceSessionRef.current = identity.sessionId;
      };
      const postResolutionBarrierCheck = (
        reason: string,
        metrics?: Parameters<typeof applyCommittedLifecycleEffects>[2],
      ) => {
        const result = applyResolutionEvidence(reason, metrics);
        if (
          shouldRequestSpotChartSubscriberRearm({
            resolutionApplied: result.applied,
            subscriberReady: result.subscriberReady,
          })
        ) {
          scheduleSubscriberGrace('BEFORE_REARM', metrics);
        }
        return result.applied;
      };

      if (chartReadyRef.current && chartResolution === nextResolution) {
        postResolutionBarrierCheck('already current resolution');
        return;
      }

      const intentDecision = transportCoordinator.request({
        sessionId: identity.sessionId,
        resolution: nextResolution,
        intentId: identity.intentId,
      }, {
        canStart: Boolean(chartReadyRef.current && chart),
        isLatest: isLatest(),
      });
      spotTradingViewChartDebug('resolution-intent-applied', {
        to: nextResolution,
        intentId: identity.intentId,
        latestIntentId: runtimeCoordinator.snapshot().latestIntentId,
        inFlightResolution: intentDecision.snapshot.activeToken?.resolution || null,
        pendingResolution: candidate.tradingViewResolution,
        pending: intentDecision.action === 'pending',
        action: intentDecision.action,
        requestSequence: intentDecision.snapshot.requestSequence,
        widgetGeneration,
      });
      markSpotKlinePerf('apply_resolution_start', {
        symbol: candidate.symbol,
        interval: tradingViewResolutionToSpotInterval(nextResolution),
        resolution: nextResolution,
        intentId: identity.intentId,
        latestIntentId: runtimeCoordinator.snapshot().latestIntentId,
        inFlightResolution: intentDecision.snapshot.activeToken?.resolution || null,
        pendingResolution: candidate.tradingViewResolution,
        requestSequence: intentDecision.snapshot.requestSequence,
        widget_generation: widgetGeneration,
      });
      if (intentDecision.action !== 'start' || !intentDecision.token || !chart) {
        updateToolbarIntentState(Boolean(
          intentDecision.snapshot.activeToken
          || runtimeCoordinator.snapshot().candidate
          || activeChartLoadingTokenRef.current
        ));
        return;
      }

      const runResolutionRequest = (intentToken: SpotResolutionIntentToken) => {
        if (!transportCoordinator.canStart(intentToken) || !isLatest()) {
          transportCoordinator.settle(intentToken);
          scheduleLatestCandidate();
          return;
        }
        if (!shouldStartSpotChartResolutionChange({
          widgetAvailable: true,
          chartReady: chartReadyRef.current,
          observedResolution: chartResolution,
          nextResolution: intentToken.resolution,
        })) {
          transportCoordinator.settle(intentToken);
          postResolutionBarrierCheck('current chart resolution');
          return;
        }

        const targetInterval = tradingViewResolutionToSpotInterval(intentToken.resolution);
        const targetBackendInterval = getBackendKlineIntervalForSpotInterval(targetInterval);
        const loadingToken = startChartLoading('resolution-change', widgetGeneration);
        if (!loadingToken) {
          transportCoordinator.settle(intentToken);
          return;
        }
        getPreloadManager().setForegroundState({
          loading: true,
          symbol: candidate.symbol,
          interval: targetBackendInterval,
          generation: intentToken.requestSequence,
        });
        const requestSeq = ++resolutionRequestSeqRef.current;
        const resolutionRequestId = createSpotKlinePerfId('set-resolution');
        const setResolutionStartedAt = getSpotChartPerfNow();
        const previousResolution = runtimeCoordinator.snapshot().committed?.tradingViewResolution
          || chartResolution
          || '1';
        const rollbackInterval = tradingViewResolutionToSpotInterval(previousResolution);
        resetInitialVisibleRangeIntent();
        resolutionRequestCancelRef.current?.();
        markSpotKlinePerf('set_resolution_called', {
          symbol: candidate.symbol,
          interval: targetInterval,
          resolution: intentToken.resolution,
          intentId: intentToken.intentId,
          latestIntentId: runtimeCoordinator.snapshot().latestIntentId,
          requestId: requestSeq,
          requestSequence: intentToken.requestSequence,
          resolutionRequestId,
          previousResolution,
          widget_generation: widgetGeneration,
        });
        resolutionRequestCancelRef.current = requestSpotSetResolution({
          chart,
          resolution: intentToken.resolution,
          isCurrent: () => (
            resolutionRequestSeqRef.current === requestSeq
            && transportCoordinator.isCurrent(intentToken)
            && widgetRef.current === widget
            && activeWidgetGenerationRef.current === widgetGeneration
          ),
          onCommitted: (reason) => {
            resolutionRequestCancelRef.current = null;
            if (!transportCoordinator.settle(intentToken).accepted) return;
            const applied = postResolutionBarrierCheck(reason, {
              requestId: requestSeq,
              requestSequence: intentToken.requestSequence,
              resolutionRequestId,
              startedAt: setResolutionStartedAt,
            });
            if (!applied) scheduleLatestCandidate();
          },
          onFailed: (reason, error) => {
            resolutionRequestCancelRef.current = null;
            if (!transportCoordinator.settle(intentToken).accepted) return;
            const activeRuntime = lifecycleRuntimeCoordinatorRef.current;
            const retireDecision = activeRuntime?.retireSession(identity, 'RESOLUTION_FAILED');
            markSpotKlinePerf('set_resolution_error', {
              symbol: candidate.symbol,
              interval: targetInterval,
              rollbackInterval,
              resolution: intentToken.resolution,
              intentId: intentToken.intentId,
              latestIntentId: activeRuntime?.snapshot().latestIntentId ?? null,
              requestId: requestSeq,
              requestSequence: intentToken.requestSequence,
              resolutionRequestId,
              widget_generation: widgetGeneration,
              duration_ms: Math.max(0, getSpotChartPerfNow() - setResolutionStartedAt),
              note: reason,
              error: error instanceof Error ? error.message : error ? String(error) : undefined,
            });
            const latestCandidate = activeRuntime?.snapshot().candidate;
            if (!retireDecision?.accepted || latestCandidate) {
              scheduleLatestCandidate();
              return;
            }
            const stableResolution = activeRuntime?.snapshot().committed?.tradingViewResolution
              || previousResolution;
            const committedInterval = tradingViewResolutionToSpotInterval(stableResolution);
            updateToolbarButtons(toolbarButtonRefs.current, chartModeRef.current, committedInterval);
            onIntervalResolutionFailureRef.current?.(committedInterval);
            finishChartLoading('resolution-failed', loadingToken);
            getPreloadManager().setForegroundState({
              loading: false,
              symbol: candidate.symbol,
              interval: getBackendKlineIntervalForSpotInterval(committedInterval),
              generation: intentToken.requestSequence,
            });
          },
        });
      };

      runResolutionRequest(intentDecision.token);
    },
    [
      beginLifecycleIntent,
      cancelSubscriberReadinessGrace,
      finishChartLoading,
      getPreloadManager,
      recordRealtimeSubscriptionReadiness,
      requestMissingSubscriberRearm,
      resetInitialVisibleRangeIntent,
      startChartLoading,
      tryCommitRuntimeCandidate,
    ],
  );

  useLayoutEffect(() => {
    bootstrapKlineLifecycleObservability();
    const nextCandleOverlayScope = `${normalizedSymbol}:${getBackendKlineIntervalForSpotInterval(activeInterval)}`;
    if (activeCandleOverlayScopeRef.current !== nextCandleOverlayScope) {
      activeCandleOverlayScopeRef.current = nextCandleOverlayScope;
      activeCandleOverlayRef.current = null;
      priceOverlayControllerRef.current?.clear();
      if (containerRef.current) {
        containerRef.current.dataset.spotChartCandleClose = '';
        containerRef.current.dataset.spotChartCandleSource = '';
        containerRef.current.dataset.spotChartCandleBarTime = '';
      }
    }
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
    onNativeCandleDisplayRef.current = onNativeCandleDisplay;
  }, [onNativeCandleDisplay]);

  useEffect(() => () => {
    cancelSubscriberReadinessGrace();
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
  }, [cancelSubscriberReadinessGrace]);

  useEffect(() => () => {
    clearScheduledKlinePreload('symbol changed or component unmounted');
    releaseResolutionKlineInterval('symbol changed or component unmounted', normalizedSymbol);
  }, [clearScheduledKlinePreload, normalizedSymbol, releaseResolutionKlineInterval]);

  useEffect(() => {
    let cancelled = false;
    let widgetGeneration = 0;
    let runtimeCoordinator: KlineLifecycleRuntimeCoordinator | null = null;

    const cleanupWidget = (generation = activeWidgetGenerationRef.current) => {
      if (generation && activeWidgetGenerationRef.current !== generation) return;
      if (generation) retireChartLoadingGeneration(generation);
      clearScheduledKlinePreload('widget cleanup');
      releaseResolutionKlineInterval('widget cleanup', normalizedSymbol);
      cancelSubscriberReadinessGrace();
      resolutionRequestCancelRef.current?.();
      resolutionRequestCancelRef.current = null;
      resolutionRequestSeqRef.current += 1;
      chartReadyRef.current = false;
      const retireReason = normalizedSymbolRef.current !== normalizedSymbol
        ? 'SYMBOL_SWITCH'
        : 'WIDGET_DESTROY';
      const coordinatorToRetire = runtimeCoordinator || lifecycleRuntimeCoordinatorRef.current;
      coordinatorToRetire?.retireAll(retireReason);
      if (lifecycleRuntimeCoordinatorRef.current === coordinatorToRetire) {
        lifecycleRuntimeCoordinatorRef.current = null;
      }
      runtimeCoordinator = null;
      resolutionIntentCoordinatorRef.current.reset();
      initialVisibleRangeApplySeqRef.current += 1;
      initialVisibleRangeAppliedKeyRef.current = '';
      initialVisibleRangeInFlightKeyRef.current = '';
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
    resolutionIntentCoordinatorRef.current.reset();
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
      onCandleAuthority: handleCandleAuthority,
      onRealtimeSubscriptionReady: (evidence) => {
        recordRealtimeSubscriptionReadiness(evidence, widgetGeneration);
      },
      debugEnabled: isSpotTradingViewDebugEnabled(),
    });
    datafeedRef.current = datafeed;
    runtimeCoordinator = new KlineLifecycleRuntimeCoordinator({
      terminalType: 'SPOT',
      widgetGeneration,
      datafeedInstanceId: datafeed.getDatafeedInstanceId(),
      symbol: normalizedSymbol,
    });
    lifecycleRuntimeCoordinatorRef.current = runtimeCoordinator;
    runtimeCoordinator.beginIntent({
      tradingViewResolution: initialResolution,
      backendInterval: getBackendKlineIntervalForSpotInterval(initialInterval),
    });
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
        const activeCandleOverlay = activeCandleOverlayRef.current;
        if (activeCandleOverlay) priceOverlayControllerRef.current.update(activeCandleOverlay);
      }
      const candidateResolution = lifecycleRuntimeCoordinatorRef.current
        ?.snapshot().candidate?.tradingViewResolution;
      if (candidateResolution) applyWidgetResolution(candidateResolution, widgetGeneration);
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
          const intentIdentity = beginLifecycleIntent(targetResolution, widgetGeneration);
          if (intentIdentity) {
            setSpotToolbarLoadingState(toolbarSlotRef.current, toolbarButtonRefs.current, {
              loading: true,
              pendingKey: item,
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
        const lifecycleSnapshot = lifecycleRuntimeCoordinatorRef.current?.snapshot();
        setSpotToolbarLoadingState(toolbarOwner.toolbarSlot, toolbarOwner.toolbarButtons, {
          loading: true,
          pendingKey: lifecycleSnapshot?.candidate
            ? tradingViewResolutionToSpotInterval(lifecycleSnapshot.candidate.tradingViewResolution)
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
    beginLifecycleIntent,
    handleCandleAuthority,
    handleDatafeedHistoryBars,
    handleDatafeedRealtime,
    recordRealtimeSubscriptionReadiness,
    amountPrecision,
    cancelSubscriberReadinessGrace,
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
        data-spot-chart-candle-close=""
        data-spot-chart-candle-source=""
        data-spot-chart-candle-bar-time=""
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
