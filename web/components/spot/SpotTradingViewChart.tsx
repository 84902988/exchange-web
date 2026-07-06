'use client';

import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import Script from 'next/script';
import { useLocaleContext } from '@/contexts/LocaleContext';
import type { SpotChartProps } from './chart/chart.types';
import { formatSpotDisplaySymbol } from './spotFormat';
import {
  createSpotTradingViewDatafeed,
  preloadSpotTradingViewKlineCache,
  spotIntervalToTradingViewResolution,
} from './tradingview/spotTradingViewDatafeed';

type TradingViewVisibleRange = {
  from: number;
  to?: number;
};

type TradingViewVisibleRangeOptions = {
  applyDefaultRightMargin?: boolean;
  percentRightMargin?: number;
  rejectByTimeout?: number;
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
  onIntervalChange?: (value: string) => void;
  onChartModeChange?: (value: 'time' | 'candle') => void;
};

type SpotTradingViewWindow = Window & {
  TradingView?: SpotTradingViewGlobal;
};

const TRADINGVIEW_LIBRARY_PATH = '/tradingview/charting_library/';
const TRADINGVIEW_SCRIPT_SRC = `${TRADINGVIEW_LIBRARY_PATH}charting_library.js`;
const TRADINGVIEW_CHART_STYLE = {
  candle: 1,
  area: 3,
} as const;
const SPOT_INTERVAL_OPTIONS = ['1m', '5m', '15m', '1h', '4h', '1d', '1w', '1M'];
const SPOT_PRELOAD_INTERVAL_OPTIONS = ['1m', '1M', '5m', '15m', '1w', '1h', '4h', '1d'];
const TIME_SHARING_LABEL = '\u5206\u65f6';
const TIME_SHARING_KEY = 'time';
const VISIBLE_RANGE_LOOKBACK_SECONDS: Record<string, number> = {
  '1m': 6 * 60 * 60,
  '5m': 24 * 60 * 60,
  '15m': 3 * 24 * 60 * 60,
  '1h': 14 * 24 * 60 * 60,
  '4h': 60 * 24 * 60 * 60,
  '1d': 120 * 24 * 60 * 60,
  '1w': 2 * 365 * 24 * 60 * 60,
};

function normalizeTradingViewSymbol(symbol: string) {
  return String(symbol || '').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '');
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

function resolveInitialTimeframe(interval: string) {
  if (interval === '1M') return resolveMonthlyInitialVisibleRange();
  if (interval === '1w') return '12M';
  return undefined;
}

function resolveMonthlyInitialVisibleRange(nowMs = Date.now()) {
  const now = new Date(nowMs);
  const from = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1) / 1000;
  const to = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 2, 1) / 1000;
  return { from, to };
}

function resolveVisibleRangeForInterval(interval: string, nowMs = Date.now()): TradingViewVisibleRange {
  if (interval === '1M') {
    const now = new Date(nowMs);
    return { from: Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 13, 1) / 1000 };
  }

  const lookbackSeconds = VISIBLE_RANGE_LOOKBACK_SECONDS[interval] ?? VISIBLE_RANGE_LOOKBACK_SECONDS['1d'];
  return { from: Math.floor(nowMs / 1000) - lookbackSeconds };
}

function applyVisibleRangeForInterval(chart: TradingViewChartApi, interval: string) {
  if (typeof chart.setVisibleRange !== 'function') return;

  const maybePromise = chart.setVisibleRange(resolveVisibleRangeForInterval(interval), {
    percentRightMargin: 8,
    rejectByTimeout: 1500,
  });
  if (maybePromise && typeof maybePromise.catch === 'function') {
    void maybePromise.catch(() => undefined);
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
  onIntervalChange,
  onChartModeChange,
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
  const widgetIntervalRef = useRef('');
  const toolbarButtonRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const [loadError, setLoadError] = useState<TradingViewLoadError | null>(null);
  const [scriptReady, setScriptReady] = useState(false);
  const [resolutionFallbackNonce, setResolutionFallbackNonce] = useState(0);
  const reactId = useId();
  const containerId = useMemo(
    () => `spot-tv-chart-${reactId.replace(/[^a-zA-Z0-9_-]/g, '')}`,
    [reactId],
  );

  const normalizedSymbol = useMemo(() => normalizeTradingViewSymbol(symbol), [symbol]);
  const activeInterval = chartMode === 'time' ? '1m' : interval;
  const widgetInterval = useMemo(() => spotIntervalToTradingViewResolution(activeInterval), [activeInterval]);
  const widgetStyle = chartMode === 'time' ? TRADINGVIEW_CHART_STYLE.area : TRADINGVIEW_CHART_STYLE.candle;
  const widgetKey = `${normalizedSymbol}:${chartMode}:${locale}:${pricePrecision ?? 'auto'}:${amountPrecision ?? 'auto'}:${resolutionFallbackNonce}`;
  const displayName = displaySymbol || formatSpotDisplaySymbol(normalizedSymbol);
  const activeLoadError = loadError?.key === widgetKey ? loadError.message : '';

  const requestResolutionFallbackRebuild = useCallback(
    (nextResolution: string, reason: string, error?: unknown) => {
      const fallbackKey = `${widgetKey}:${nextResolution}`;
      if (resolutionFallbackKeyRef.current === fallbackKey) return;

      resolutionFallbackKeyRef.current = fallbackKey;
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

  const applyWidgetResolution = useCallback(
    (nextResolution: string, nextInterval = activeIntervalRef.current) => {
      if (!nextResolution) return;

      const widget = widgetRef.current;
      if (!widget || !chartReadyRef.current) {
        pendingResolutionRef.current = nextResolution;
        return;
      }

      if (currentResolutionRef.current === nextResolution) {
        pendingResolutionRef.current = '';
        return;
      }

      const chart = widget.activeChart?.();
      const setResolution = chart?.setResolution;
      if (typeof setResolution !== 'function') {
        pendingResolutionRef.current = nextResolution;
        requestResolutionFallbackRebuild(nextResolution, 'setResolution unavailable');
        return;
      }

      const requestSeq = ++resolutionRequestSeqRef.current;
      pendingResolutionRef.current = nextResolution;
      let finished = false;

      const scheduleVisibleRangeApply = (delayMs: number) => {
        window.setTimeout(() => {
          if (resolutionRequestSeqRef.current !== requestSeq || widgetRef.current !== widget) return;
          applyVisibleRangeForInterval(chart, nextInterval);
        }, delayMs);
      };

      const finishResolutionChange = () => {
        if (finished || resolutionRequestSeqRef.current !== requestSeq || widgetRef.current !== widget) return;
        finished = true;
        currentResolutionRef.current = nextResolution;
        pendingResolutionRef.current = '';
        applyVisibleRangeForInterval(chart, nextInterval);
      };

      try {
        const maybePromise = setResolution.call(chart, nextResolution, {
          dataReady: finishResolutionChange,
        });
        if (maybePromise && typeof maybePromise.then === 'function') {
          void maybePromise.then((changed) => {
            if (changed === false) {
              requestResolutionFallbackRebuild(nextResolution, 'setResolution returned false');
              return;
            }
            finishResolutionChange();
          }).catch((error: unknown) => {
            pendingResolutionRef.current = nextResolution;
            requestResolutionFallbackRebuild(nextResolution, 'setResolution rejected', error);
          });
        }
        currentResolutionRef.current = nextResolution;
        scheduleVisibleRangeApply(50);
      } catch (error) {
        pendingResolutionRef.current = nextResolution;
        requestResolutionFallbackRebuild(nextResolution, 'setResolution threw', error);
      }
    },
    [requestResolutionFallbackRebuild],
  );

  useEffect(() => {
    activeIntervalRef.current = activeInterval;
    widgetIntervalRef.current = widgetInterval;
  }, [activeInterval, widgetInterval]);

  useEffect(() => {
    if (!normalizedSymbol) return undefined;

    let cancelled = false;
    const timer = window.setTimeout(() => {
      void preloadSpotTradingViewKlineCache({
        symbol: normalizedSymbol,
        intervals: SPOT_PRELOAD_INTERVAL_OPTIONS,
        skipInterval: activeInterval,
        concurrency: 2,
        shouldContinue: () => !cancelled,
      }).catch((err: unknown) => {
        if (!cancelled && process.env.NODE_ENV !== 'production') {
          console.debug('[SpotTradingViewChart] preload kline cache failed', {
            symbol: normalizedSymbol,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      });
    }, 350);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [activeInterval, normalizedSymbol]);

  useEffect(() => {
    let cancelled = false;

    const cleanupWidget = () => {
      resolutionRequestSeqRef.current += 1;
      chartReadyRef.current = false;
      currentResolutionRef.current = '';
      pendingResolutionRef.current = '';
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
    });
    datafeedRef.current = datafeed;

    const widget = new tradingView.widget({
      autosize: true,
      symbol: normalizedSymbol,
      interval: initialResolution,
      timeframe: resolveInitialTimeframe(initialInterval),
      container: containerId,
      datafeed,
      library_path: TRADINGVIEW_LIBRARY_PATH,
      locale: resolveTradingViewLocale(locale),
      timezone: 'Etc/UTC',
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
        applyWidgetResolution(pendingResolution, activeIntervalRef.current);
      } else {
        pendingResolutionRef.current = '';
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

      makeButton(TIME_SHARING_KEY, TIME_SHARING_LABEL, () => onChartModeChange?.('time'));
      SPOT_INTERVAL_OPTIONS.forEach((item) => {
        makeButton(item, formatIntervalLabel(item), () => {
          onChartModeChange?.('candle');
          onIntervalChange?.(item);
        });
      });
      updateToolbarButtons(toolbarButtonRefs.current, chartMode, activeIntervalRef.current);
    }).catch(() => undefined);

    return () => {
      cancelled = true;
      cleanupWidget();
    };
  }, [
    applyWidgetResolution,
    amountPrecision,
    chartMode,
    containerId,
    displayName,
    locale,
    normalizedSymbol,
    onChartModeChange,
    onIntervalChange,
    pricePrecision,
    scriptReady,
    widgetKey,
    widgetStyle,
  ]);

  useEffect(() => {
    let cancelled = false;
    updateToolbarButtons(toolbarButtonRefs.current, chartMode, activeInterval);

    const timer = window.setTimeout(() => {
      if (!cancelled) applyWidgetResolution(widgetInterval, activeInterval);
    }, 0);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [activeInterval, applyWidgetResolution, chartMode, widgetInterval]);

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
    </div>
  );
}
