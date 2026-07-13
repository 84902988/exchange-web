'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import Script from 'next/script';
import { useLocaleContext } from '@/contexts/LocaleContext';
import {
  contractIntervalToTradingViewResolution,
  createContractTradingViewDatafeed,
  type ContractHistoryBarsEvent,
  type ContractHistoryErrorEvent,
} from './tradingview/contractTradingViewDatafeed';
import {
  normalizeContractKlineAssetClass,
  type ContractKlineAssetClass,
} from './tradingview/contractKlineCachePolicy';
import { setSpotToolbarLoadingState } from '@/components/spot/tradingview/spotTradingViewResolutionState';

export type ContractChartMode = 'time' | 'candle';

export type TradingViewChartApi = {
  getSeries?: () => {
    setChartStyleProperties?: (chartStyle: number, preferences: Record<string, unknown>) => void;
  };
  setResolution?: (
    resolution: string,
    options?: { dataReady?: () => void; doNotActivateChart?: boolean } | (() => void),
  ) => Promise<boolean> | boolean | void;
};

type TradingViewWidgetInstance = {
  remove: () => void;
  activeChart: () => TradingViewChartApi;
  applyOverrides?: (overrides: Record<string, unknown>) => void;
  chartReady?: () => Promise<void>;
  onChartReady?: (callback: () => void) => void;
  headerReady: () => Promise<void>;
  createButton: (options?: {
    align?: 'left' | 'right';
    useTradingViewStyle?: false;
  }) => HTMLElement;
};

type ContractTradingViewGlobal = {
  widget: new (options: Record<string, unknown>) => TradingViewWidgetInstance;
};

type ContractTradingViewWindow = {
  TradingView?: ContractTradingViewGlobal;
};

type TradingViewLoadError = {
  key: string;
  message: string;
};

type ContractTradingViewChartProps = {
  symbol: string;
  category?: ContractKlineAssetClass | string | null;
  displaySymbol?: string | null;
  interval: string;
  chartMode: ContractChartMode;
  intervalOptions?: string[];
  height?: number;
  pricePrecision?: number | null;
  amountPrecision?: number | null;
  onChartModeChange?: (value: ContractChartMode) => void;
  onIntervalChange?: (value: string) => void;
  onLatestKlineCloseChange?: (price: string | null) => void;
};

type ContractResolutionRequestParams = {
  chart: TradingViewChartApi | null;
  resolution: string;
  isCurrent: () => boolean;
  onSettled: () => void;
  onFallback: (reason: string, error?: unknown) => void;
};

type ContractChartLoadingClock = {
  now: () => number;
  setTimeout: (callback: () => void, delayMs: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

type ContractChartLoadingCoordinatorOptions = {
  onChange: (reason: string) => void;
  clock?: ContractChartLoadingClock;
  minVisibleMs?: number;
  safetyTimeoutMs?: number;
};

const TRADINGVIEW_LIBRARY_PATH = '/tradingview/charting_library/';
const TRADINGVIEW_SCRIPT_SRC = `${TRADINGVIEW_LIBRARY_PATH}charting_library.js`;
const TRADINGVIEW_TIMEZONE = 'Asia/Shanghai';
const TRADINGVIEW_CANDLE_STYLE = 1;
const TRADINGVIEW_TIME_STYLE = 2;
const CONTRACT_CHART_LOADING_MIN_VISIBLE_MS = 220;
const CONTRACT_CHART_LOADING_SAFETY_TIMEOUT_MS = 5000;
const DEFAULT_INTERVAL_OPTIONS = ['1m', '5m', '15m', '1h', '4h', '1d', '1w', '1M'];
const TIME_SHARING_KEY = 'time';
const TIME_SHARING_LABEL = 'Time';

export const CONTRACT_TIME_SERIES_OVERRIDES = {
  'mainSeriesProperties.lineStyle.colorType': 'solid',
  'mainSeriesProperties.lineStyle.gradientStartColor': '#f0b90b',
  'mainSeriesProperties.lineStyle.gradientEndColor': '#f0b90b',
  'mainSeriesProperties.lineStyle.color': '#f0b90b',
  'mainSeriesProperties.lineStyle.linewidth': 2,
  'mainSeriesProperties.lineStyle.linestyle': 0,
  'mainSeriesProperties.lineStyle.priceSource': 'close',
  'mainSeriesProperties.areaStyle.color1': 'rgba(240,185,11,0.24)',
  'mainSeriesProperties.areaStyle.color2': 'rgba(240,185,11,0.02)',
  'mainSeriesProperties.areaStyle.linecolor': '#f0b90b',
  'mainSeriesProperties.areaStyle.linewidth': 2,
} as const;

export const CONTRACT_TIME_LINE_STYLE_PREFERENCES = {
  colorType: 'solid',
  gradientStartColor: '#f0b90b',
  gradientEndColor: '#f0b90b',
  color: '#f0b90b',
  linestyle: 0,
  linewidth: 2,
} as const;

export const CONTRACT_CHART_LOADING_OVERLAY_CLASS_NAME =
  'pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-[#12161c]/75';

export function resolveContractEffectiveKlineInterval(
  chartMode: ContractChartMode,
  candleInterval: string,
) {
  return chartMode === 'time' ? '1m' : candleInterval;
}

export function resolveContractWidgetStyle(chartMode: ContractChartMode) {
  return chartMode === 'time' ? TRADINGVIEW_TIME_STYLE : TRADINGVIEW_CANDLE_STYLE;
}

export function resolveContractToolbarSelection(
  key: string,
  currentInterval: string,
): { chartMode: ContractChartMode; interval: string } {
  if (key === TIME_SHARING_KEY) {
    return { chartMode: 'time', interval: currentInterval };
  }
  return { chartMode: 'candle', interval: key };
}

export function isContractToolbarButtonActive(
  key: string,
  chartMode: ContractChartMode,
  candleInterval: string,
) {
  return key === TIME_SHARING_KEY
    ? chartMode === 'time'
    : chartMode === 'candle' && key === candleInterval;
}

export function buildContractWidgetIdentityKey(params: {
  symbol: string;
  category?: ContractKlineAssetClass | string | null;
  locale: string;
  pricePrecision?: number | null;
  amountPrecision?: number | null;
  chartMode: ContractChartMode;
  fallbackNonce: number;
}) {
  return [
    params.symbol,
    normalizeContractKlineAssetClass(params.category),
    params.locale,
    params.pricePrecision ?? 'auto',
    params.amountPrecision ?? 'auto',
    params.chartMode,
    params.fallbackNonce,
  ].join(':');
}

export function shouldShowContractChartLoading(reason: string, error: string) {
  return Boolean(reason) && !error;
}

export function isContractHistoryEventCurrent(
  event: ContractHistoryBarsEvent | ContractHistoryErrorEvent,
  expected: {
    symbol: string;
    interval: string;
    resolution: string;
    minimumRequestSeq: number;
  },
) {
  return event.symbol === expected.symbol
    && event.interval === expected.interval
    && event.resolution === expected.resolution
    && event.requestSeq >= expected.minimumRequestSeq;
}

export function requestContractSetResolution({
  chart,
  resolution,
  isCurrent,
  onSettled,
  onFallback,
}: ContractResolutionRequestParams) {
  let finished = false;

  const settleOnce = () => {
    if (finished) return;
    finished = true;
    if (isCurrent()) onSettled();
  };

  const fallbackOnce = (reason: string, error?: unknown) => {
    if (finished) return;
    finished = true;
    if (isCurrent()) onFallback(reason, error);
  };

  const setResolution = chart?.setResolution;
  if (typeof setResolution !== 'function') {
    fallbackOnce('setResolution unavailable');
    return;
  }

  try {
    const result = setResolution.call(chart, resolution, { dataReady: settleOnce });
    if (result === false) {
      fallbackOnce('setResolution returned false');
      return;
    }
    if (result === true) {
      settleOnce();
      return;
    }
    if (result && typeof result.then === 'function') {
      void result.then((changed) => {
        if (changed === false) {
          fallbackOnce('setResolution returned false');
          return;
        }
        settleOnce();
      }).catch((error: unknown) => {
        fallbackOnce('setResolution rejected', error);
      });
    }
  } catch (error) {
    fallbackOnce('setResolution threw', error);
  }
}

export class ContractChartLoadingCoordinator {
  private readonly onChange: (reason: string) => void;
  private readonly clock: ContractChartLoadingClock;
  private readonly minVisibleMs: number;
  private readonly safetyTimeoutMs: number;
  private sequence = 0;
  private startedAt = 0;
  private finishScheduledSeq = 0;
  private finishTimer: unknown = null;
  private safetyTimer: unknown = null;
  private destroyed = false;

  constructor({
    onChange,
    clock,
    minVisibleMs = CONTRACT_CHART_LOADING_MIN_VISIBLE_MS,
    safetyTimeoutMs = CONTRACT_CHART_LOADING_SAFETY_TIMEOUT_MS,
  }: ContractChartLoadingCoordinatorOptions) {
    this.onChange = onChange;
    this.clock = clock || {
      now: () => Date.now(),
      setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
      clearTimeout: (handle) => window.clearTimeout(handle as number),
    };
    this.minVisibleMs = minVisibleMs;
    this.safetyTimeoutMs = safetyTimeoutMs;
  }

  private clearTimers() {
    if (this.finishTimer !== null) {
      this.clock.clearTimeout(this.finishTimer);
      this.finishTimer = null;
    }
    if (this.safetyTimer !== null) {
      this.clock.clearTimeout(this.safetyTimer);
      this.safetyTimer = null;
    }
  }

  start(reason: string) {
    if (this.destroyed) return this.sequence;
    this.clearTimers();
    this.sequence += 1;
    const sequence = this.sequence;
    this.startedAt = this.clock.now();
    this.finishScheduledSeq = 0;
    this.onChange(reason);
    this.safetyTimer = this.clock.setTimeout(() => {
      this.safetyTimer = null;
      this.finish(sequence);
    }, this.safetyTimeoutMs);
    return sequence;
  }

  finish(sequence: number) {
    if (
      this.destroyed
      || sequence !== this.sequence
      || this.finishScheduledSeq === sequence
    ) {
      return false;
    }

    this.finishScheduledSeq = sequence;
    if (this.safetyTimer !== null) {
      this.clock.clearTimeout(this.safetyTimer);
      this.safetyTimer = null;
    }
    const elapsedMs = Math.max(0, this.clock.now() - this.startedAt);
    const delayMs = Math.max(0, this.minVisibleMs - elapsedMs);
    this.finishTimer = this.clock.setTimeout(() => {
      this.finishTimer = null;
      if (this.destroyed || sequence !== this.sequence) return;
      this.finishScheduledSeq = 0;
      this.onChange('');
    }, delayMs);
    return true;
  }

  currentSequence() {
    return this.sequence;
  }

  destroy() {
    this.destroyed = true;
    this.sequence += 1;
    this.finishScheduledSeq = 0;
    this.clearTimers();
  }
}

function normalizeTradingViewSymbol(symbol: string) {
  return String(symbol || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
}

function resolveTradingViewLocale(locale: string) {
  if (locale === 'zh-TW') return 'zh_TW';
  if (locale === 'zh') return 'zh';
  if (locale === 'ja') return 'ja';
  return 'en';
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

function styleToolbarButton(button: HTMLButtonElement, active: boolean) {
  button.dataset.active = active ? '1' : '0';
  button.style.color = active ? '#f0b90b' : 'rgba(255,255,255,0.58)';
  button.style.cursor = 'pointer';
}

function updateToolbarButtons(
  buttons: Map<string, HTMLButtonElement>,
  chartMode: ContractChartMode,
  candleInterval: string,
) {
  buttons.forEach((button, key) => {
    styleToolbarButton(button, isContractToolbarButtonActive(key, chartMode, candleInterval));
  });
}

function createToolbarButton(params: {
  owner: Document;
  key: string;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  const button = params.owner.createElement('button');
  button.type = 'button';
  button.textContent = params.label;
  button.dataset.key = params.key;
  button.style.border = '0';
  button.style.padding = '0';
  button.style.margin = '0';
  button.style.background = 'transparent';
  button.style.font = '500 13px/1 Arial, sans-serif';
  button.style.whiteSpace = 'nowrap';
  styleToolbarButton(button, params.active);
  button.addEventListener('mouseenter', () => {
    if (button.dataset.active !== '1') button.style.color = 'rgba(255,255,255,0.86)';
  });
  button.addEventListener('mouseleave', () => {
    if (button.dataset.active !== '1') button.style.color = 'rgba(255,255,255,0.58)';
  });
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    params.onClick();
  });
  return button;
}

function getTradingViewGlobal() {
  return (window as unknown as ContractTradingViewWindow).TradingView;
}

export default function ContractTradingViewChart({
  symbol,
  category,
  displaySymbol,
  interval,
  chartMode,
  intervalOptions,
  height = 520,
  pricePrecision,
  amountPrecision,
  onChartModeChange,
  onIntervalChange,
  onLatestKlineCloseChange,
}: ContractTradingViewChartProps) {
  const { locale, t } = useLocaleContext();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const widgetRef = useRef<TradingViewWidgetInstance | null>(null);
  const datafeedRef = useRef<ReturnType<typeof createContractTradingViewDatafeed> | null>(null);
  const toolbarButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const toolbarSlotRef = useRef<HTMLElement | null>(null);
  const chartReadyRef = useRef(false);
  const currentResolutionRef = useRef('');
  const pendingResolutionRef = useRef('');
  const pendingResolutionSeqRef = useRef(0);
  const pendingResolutionLoadingSeqRef = useRef(0);
  const inFlightResolutionRef = useRef('');
  const resolutionRequestSeqRef = useRef(0);
  const fallbackRequestSeqRef = useRef(0);
  const datafeedBuildSeqRef = useRef(0);
  const latestHistoryRequestSeqRef = useRef(0);
  const activeChartLoadingSeqRef = useRef(0);
  const reactId = useId();
  const containerId = useMemo(
    () => `contract-tv-chart-${reactId.replace(/[^a-zA-Z0-9_-]/g, '')}`,
    [reactId],
  );
  const normalizedSymbol = useMemo(() => normalizeTradingViewSymbol(symbol), [symbol]);
  const canonicalCategory = useMemo(
    () => normalizeContractKlineAssetClass(category),
    [category],
  );
  const activeIntervals = useMemo(
    () => (intervalOptions?.length ? intervalOptions : DEFAULT_INTERVAL_OPTIONS)
      .filter((item) => Boolean(String(item || '').trim())),
    [intervalOptions],
  );
  const activeInterval = activeIntervals.includes(interval) ? interval : activeIntervals[0] || '1m';
  const effectiveInterval = resolveContractEffectiveKlineInterval(chartMode, activeInterval);
  const widgetInterval = contractIntervalToTradingViewResolution(effectiveInterval);
  const displayName = displaySymbol || normalizedSymbol;
  const [resolutionFallbackNonce, setResolutionFallbackNonce] = useState(0);
  const widgetKey = buildContractWidgetIdentityKey({
    symbol: normalizedSymbol,
    category: canonicalCategory,
    locale,
    pricePrecision,
    amountPrecision,
    chartMode,
    fallbackNonce: resolutionFallbackNonce,
  });
  const [scriptReady, setScriptReady] = useState(
    () => typeof window !== 'undefined' && Boolean(getTradingViewGlobal()?.widget),
  );
  const [loadError, setLoadError] = useState<TradingViewLoadError | null>(null);
  const [chartLoadingReason, setChartLoadingReason] = useState('');
  const activeLoadError = loadError?.key === widgetKey ? loadError.message : '';
  const showChartLoading = shouldShowContractChartLoading(chartLoadingReason, activeLoadError);

  const normalizedSymbolRef = useRef(normalizedSymbol);
  const activeIntervalsRef = useRef(activeIntervals);
  const activeIntervalRef = useRef(activeInterval);
  const effectiveIntervalRef = useRef(effectiveInterval);
  const widgetIntervalRef = useRef(widgetInterval);
  const chartModeRef = useRef(chartMode);
  const displayNameRef = useRef(displayName);
  const widgetKeyRef = useRef(widgetKey);
  const onChartModeChangeRef = useRef(onChartModeChange);
  const onIntervalChangeRef = useRef(onIntervalChange);
  const onLatestKlineCloseChangeRef = useRef(onLatestKlineCloseChange);

  const [loadingCoordinator] = useState(() => (
    new ContractChartLoadingCoordinator({
      onChange: setChartLoadingReason,
    })
  ));

  useEffect(() => {
    normalizedSymbolRef.current = normalizedSymbol;
    activeIntervalsRef.current = activeIntervals;
    activeIntervalRef.current = activeInterval;
    effectiveIntervalRef.current = effectiveInterval;
    widgetIntervalRef.current = widgetInterval;
    chartModeRef.current = chartMode;
    displayNameRef.current = displayName;
    widgetKeyRef.current = widgetKey;
    onChartModeChangeRef.current = onChartModeChange;
    onIntervalChangeRef.current = onIntervalChange;
    onLatestKlineCloseChangeRef.current = onLatestKlineCloseChange;
  }, [
    activeInterval,
    activeIntervals,
    chartMode,
    displayName,
    effectiveInterval,
    normalizedSymbol,
    onChartModeChange,
    onIntervalChange,
    onLatestKlineCloseChange,
    widgetInterval,
    widgetKey,
  ]);

  const startChartLoading = useCallback((reason: string) => {
    setLoadError(null);
    const sequence = loadingCoordinator.start(reason);
    activeChartLoadingSeqRef.current = sequence;
    return sequence;
  }, [loadingCoordinator]);

  const finishChartLoading = useCallback((sequence: number) => {
    loadingCoordinator.finish(sequence);
  }, [loadingCoordinator]);

  const restoreToolbarInteraction = useCallback((buildSeq: number) => {
    window.requestAnimationFrame(() => {
      if (datafeedBuildSeqRef.current !== buildSeq) return;
      setSpotToolbarLoadingState(toolbarSlotRef.current, toolbarButtonRefs.current, {
        loading: false,
      });
    });
  }, []);

  const requestResolutionFallbackRebuild = useCallback((
    nextResolution: string,
    requestSeq: number,
  ) => {
    if (
      resolutionRequestSeqRef.current !== requestSeq
      || fallbackRequestSeqRef.current === requestSeq
    ) return;
    fallbackRequestSeqRef.current = requestSeq;
    pendingResolutionRef.current = nextResolution;
    inFlightResolutionRef.current = '';
    activeChartLoadingSeqRef.current = startChartLoading('resolution-fallback-rebuild');
    setResolutionFallbackNonce((current) => current + 1);
  }, [startChartLoading]);

  const applyWidgetResolution = useCallback((nextResolution: string) => {
    const normalizedResolution = String(nextResolution || '').trim();
    if (!normalizedResolution) return;
    if (currentResolutionRef.current === normalizedResolution) {
      pendingResolutionRef.current = '';
      inFlightResolutionRef.current = '';
      return;
    }

    if (pendingResolutionRef.current !== normalizedResolution) {
      resolutionRequestSeqRef.current += 1;
      pendingResolutionSeqRef.current = resolutionRequestSeqRef.current;
      pendingResolutionRef.current = normalizedResolution;
      pendingResolutionLoadingSeqRef.current = startChartLoading('set-resolution');
      inFlightResolutionRef.current = '';
    }

    if (!chartReadyRef.current) return;
    const requestSeq = pendingResolutionSeqRef.current;
    const inFlightKey = `${requestSeq}:${normalizedResolution}`;
    if (inFlightResolutionRef.current === inFlightKey) return;

    const widget = widgetRef.current;
    const chart = widget?.activeChart?.() || null;
    inFlightResolutionRef.current = inFlightKey;
    requestContractSetResolution({
      chart,
      resolution: normalizedResolution,
      isCurrent: () => (
        resolutionRequestSeqRef.current === requestSeq
        && pendingResolutionRef.current === normalizedResolution
        && widgetRef.current === widget
      ),
      onSettled: () => {
        currentResolutionRef.current = normalizedResolution;
        pendingResolutionRef.current = '';
        inFlightResolutionRef.current = '';
        finishChartLoading(pendingResolutionLoadingSeqRef.current);
      },
      onFallback: () => {
        requestResolutionFallbackRebuild(normalizedResolution, requestSeq);
      },
    });
  }, [finishChartLoading, requestResolutionFallbackRebuild, startChartLoading]);

  useEffect(() => () => {
    loadingCoordinator.destroy();
  }, [loadingCoordinator]);

  useEffect(() => {
    let cancelled = false;
    let chartReadyTimer: number | null = null;
    let widgetBuildLoadingTimer: number | null = null;
    let widgetBuildCompleted = false;

    const cleanupWidget = () => {
      chartReadyRef.current = false;
      resolutionRequestSeqRef.current += 1;
      pendingResolutionRef.current = '';
      inFlightResolutionRef.current = '';
      toolbarButtonRefs.current.clear();
      toolbarSlotRef.current = null;
      datafeedRef.current?.destroy();
      datafeedRef.current = null;
      try {
        widgetRef.current?.remove();
      } catch {
        // TradingView cleanup remains best-effort during allowed rebuilds.
      }
      widgetRef.current = null;
    };

    const disposeEffect = () => {
      cancelled = true;
      if (chartReadyTimer !== null) window.clearTimeout(chartReadyTimer);
      if (widgetBuildLoadingTimer !== null) window.clearTimeout(widgetBuildLoadingTimer);
      cleanupWidget();
    };

    cleanupWidget();
    if (!scriptReady || !normalizedSymbol || !containerRef.current) {
      return disposeEffect;
    }

    const tradingView = getTradingViewGlobal();
    if (!tradingView?.widget) {
      chartReadyTimer = window.setTimeout(() => {
        if (cancelled) return;
        setLoadError({ key: widgetKey, message: '图表组件暂不可用' });
        finishChartLoading(activeChartLoadingSeqRef.current);
      }, 0);
      return disposeEffect;
    }

    const initialResolution = widgetIntervalRef.current;
    const initialStyle = resolveContractWidgetStyle(chartModeRef.current);
    const buildSeq = datafeedBuildSeqRef.current + 1;
    datafeedBuildSeqRef.current = buildSeq;
    latestHistoryRequestSeqRef.current = 0;
    chartReadyRef.current = false;
    currentResolutionRef.current = initialResolution;
    pendingResolutionRef.current = '';
    pendingResolutionSeqRef.current = resolutionRequestSeqRef.current;
    inFlightResolutionRef.current = '';
    fallbackRequestSeqRef.current = 0;
    widgetBuildLoadingTimer = window.setTimeout(() => {
      widgetBuildLoadingTimer = null;
      if (!cancelled && !widgetBuildCompleted) {
        activeChartLoadingSeqRef.current = startChartLoading('widget-build');
      }
    }, 0);

    const eventMatchesCurrentChart = (event: ContractHistoryBarsEvent | ContractHistoryErrorEvent) => (
      !cancelled
      && datafeedBuildSeqRef.current === buildSeq
      && isContractHistoryEventCurrent(event, {
        symbol: normalizedSymbolRef.current,
        interval: effectiveIntervalRef.current,
        resolution: widgetIntervalRef.current,
        minimumRequestSeq: latestHistoryRequestSeqRef.current,
      })
    );

    const datafeed = createContractTradingViewDatafeed({
      symbol: normalizedSymbol,
      category: canonicalCategory,
      displaySymbol: displayNameRef.current,
      pricePrecision,
      amountPrecision,
      onLatestBar: (price) => onLatestKlineCloseChangeRef.current?.(price),
      onHistoryBars: (event) => {
        if (!event.firstDataRequest || !eventMatchesCurrentChart(event)) return;
        widgetBuildCompleted = true;
        if (widgetBuildLoadingTimer !== null) {
          window.clearTimeout(widgetBuildLoadingTimer);
          widgetBuildLoadingTimer = null;
        }
        latestHistoryRequestSeqRef.current = event.requestSeq;
        setLoadError(null);
        finishChartLoading(activeChartLoadingSeqRef.current);
      },
      onHistoryError: (event) => {
        if (!event.firstDataRequest || !eventMatchesCurrentChart(event)) return;
        widgetBuildCompleted = true;
        if (widgetBuildLoadingTimer !== null) {
          window.clearTimeout(widgetBuildLoadingTimer);
          widgetBuildLoadingTimer = null;
        }
        latestHistoryRequestSeqRef.current = event.requestSeq;
        setLoadError({ key: widgetKeyRef.current, message: event.error });
        finishChartLoading(activeChartLoadingSeqRef.current);
      },
    });
    datafeedRef.current = datafeed;

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
      style: initialStyle,
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
        'mainSeriesProperties.style': initialStyle,
        ...CONTRACT_TIME_SERIES_OVERRIDES,
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
      widget.applyOverrides?.(CONTRACT_TIME_SERIES_OVERRIDES);
      if (chartModeRef.current === 'time') {
        widget.activeChart().getSeries?.().setChartStyleProperties?.(
          TRADINGVIEW_TIME_STYLE,
          CONTRACT_TIME_LINE_STYLE_PREFERENCES,
        );
      }
      chartReadyRef.current = true;
      const pendingResolution = pendingResolutionRef.current;
      if (pendingResolution && pendingResolution !== currentResolutionRef.current) {
        applyWidgetResolution(pendingResolution);
      }
      restoreToolbarInteraction(buildSeq);
    };

    if (typeof widget.chartReady === 'function') {
      void widget.chartReady().then(markChartReady).catch(() => undefined);
    } else if (typeof widget.onChartReady === 'function') {
      widget.onChartReady(markChartReady);
    } else {
      chartReadyTimer = window.setTimeout(markChartReady, 0);
    }

    void widget.headerReady().then(() => {
      if (cancelled || widgetRef.current !== widget) return;
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

      const appendButton = (key: string, label: string, onClick: () => void) => {
        const button = createToolbarButton({
          owner: toolbarSlot.ownerDocument,
          key,
          label,
          active: isContractToolbarButtonActive(
            key,
            chartModeRef.current,
            activeIntervalRef.current,
          ),
          onClick,
        });
        toolbarSlot.appendChild(button);
        toolbarButtonRefs.current.set(key, button);
      };

      appendButton(TIME_SHARING_KEY, TIME_SHARING_LABEL, () => {
        const selection = resolveContractToolbarSelection(
          TIME_SHARING_KEY,
          activeIntervalRef.current,
        );
        if (chartModeRef.current !== selection.chartMode) {
          activeChartLoadingSeqRef.current = startChartLoading('toolbar-mode-change');
        }
        chartModeRef.current = selection.chartMode;
        effectiveIntervalRef.current = '1m';
        widgetIntervalRef.current = contractIntervalToTradingViewResolution('1m');
        updateToolbarButtons(
          toolbarButtonRefs.current,
          selection.chartMode,
          selection.interval,
        );
        onChartModeChangeRef.current?.(selection.chartMode);
      });

      activeIntervalsRef.current.forEach((item) => {
        appendButton(item, formatIntervalLabel(item), () => {
          const selection = resolveContractToolbarSelection(item, activeIntervalRef.current);
          if (
            chartModeRef.current !== selection.chartMode
            || activeIntervalRef.current !== selection.interval
          ) {
            activeChartLoadingSeqRef.current = startChartLoading('toolbar-interval-click');
          }
          const previousMode = chartModeRef.current;
          chartModeRef.current = selection.chartMode;
          activeIntervalRef.current = selection.interval;
          effectiveIntervalRef.current = selection.interval;
          widgetIntervalRef.current = contractIntervalToTradingViewResolution(selection.interval);
          updateToolbarButtons(
            toolbarButtonRefs.current,
            selection.chartMode,
            selection.interval,
          );
          if (previousMode !== 'candle') onChartModeChangeRef.current?.('candle');
          onIntervalChangeRef.current?.(selection.interval);
        });
      });
      setSpotToolbarLoadingState(toolbarSlot, toolbarButtonRefs.current, { loading: false });
      restoreToolbarInteraction(buildSeq);
    }).catch(() => undefined);

    return disposeEffect;
  }, [
    amountPrecision,
    applyWidgetResolution,
    canonicalCategory,
    chartMode,
    containerId,
    finishChartLoading,
    locale,
    normalizedSymbol,
    pricePrecision,
    resolutionFallbackNonce,
    restoreToolbarInteraction,
    scriptReady,
    startChartLoading,
    widgetKey,
  ]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      applyWidgetResolution(widgetInterval);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [activeInterval, applyWidgetResolution, chartMode, widgetInterval]);

  useEffect(() => {
    updateToolbarButtons(toolbarButtonRefs.current, chartMode, activeInterval);
  }, [activeInterval, chartMode]);

  return (
    <div className="relative flex h-full min-h-[420px] w-full flex-col bg-[#12161c]" style={{ minHeight: height }}>
      <Script
        src={TRADINGVIEW_SCRIPT_SRC}
        strategy="afterInteractive"
        onReady={() => setScriptReady(true)}
        onError={() => {
          setLoadError({ key: widgetKeyRef.current, message: '图表组件加载失败' });
          finishChartLoading(activeChartLoadingSeqRef.current);
        }}
      />
      <div
        id={containerId}
        ref={containerRef}
        className="min-h-0 flex-1"
        aria-label={`${displayName || normalizedSymbol} ${chartMode === 'time' ? 'time' : activeInterval}`}
      />
      {activeLoadError ? (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-[#12161c] px-4 text-center text-sm text-[#f6465d]">
          {t('spotChartLoadFailed', 'asset')}: {activeLoadError}
        </div>
      ) : null}
      {showChartLoading ? (
        <div
          className={CONTRACT_CHART_LOADING_OVERLAY_CLASS_NAME}
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
