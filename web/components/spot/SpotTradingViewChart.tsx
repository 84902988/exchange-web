'use client';

import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import Script from 'next/script';
import { useLocaleContext } from '@/contexts/LocaleContext';
import type { SpotChartProps } from './chart/chart.types';
import { formatSpotDisplaySymbol } from './spotFormat';
import {
  createSpotTradingViewDatafeed,
  spotIntervalToTradingViewResolution,
} from './tradingview/spotTradingViewDatafeed';
type TradingViewWidgetInstance = {
  remove: () => void;
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
const SPOT_INTERVAL_OPTIONS = ['1m', '5m', '15m', '1h', '4h', '1d'];
const TIME_SHARING_LABEL = '\u5206\u65f6';

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
  return normalized;
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
  const [loadError, setLoadError] = useState<TradingViewLoadError | null>(null);
  const [scriptReady, setScriptReady] = useState(false);
  const reactId = useId();
  const containerId = useMemo(
    () => `spot-tv-chart-${reactId.replace(/[^a-zA-Z0-9_-]/g, '')}`,
    [reactId],
  );

  const normalizedSymbol = useMemo(() => normalizeTradingViewSymbol(symbol), [symbol]);
  const activeInterval = chartMode === 'time' ? '1m' : interval;
  const widgetInterval = useMemo(() => spotIntervalToTradingViewResolution(activeInterval), [activeInterval]);
  const widgetStyle = chartMode === 'time' ? TRADINGVIEW_CHART_STYLE.area : TRADINGVIEW_CHART_STYLE.candle;
  const widgetKey = `${normalizedSymbol}:${chartMode}:${widgetInterval}:${locale}:${pricePrecision ?? 'auto'}:${amountPrecision ?? 'auto'}`;
  const displayName = displaySymbol || formatSpotDisplaySymbol(normalizedSymbol);
  const activeLoadError = loadError?.key === widgetKey ? loadError.message : '';

  useEffect(() => {
    let cancelled = false;

    const cleanupWidget = () => {
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
      interval: widgetInterval,
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
      enabled_features: ['iframe_loading_same_origin'],
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

      const makeButton = (label: string, active: boolean, onClick: () => void) => {
        const button = toolbarSlot.ownerDocument.createElement('button');
        button.type = 'button';
        button.textContent = label;
        button.style.border = '0';
        button.style.padding = '0';
        button.style.margin = '0';
        button.style.background = 'transparent';
        button.style.color = active ? '#f0b90b' : 'rgba(255,255,255,0.58)';
        button.style.font = '500 13px/1 Arial, sans-serif';
        button.style.cursor = 'pointer';
        button.style.whiteSpace = 'nowrap';
        button.addEventListener('mouseenter', () => {
          if (!active) button.style.color = 'rgba(255,255,255,0.86)';
        });
        button.addEventListener('mouseleave', () => {
          if (!active) button.style.color = 'rgba(255,255,255,0.58)';
        });
        button.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          onClick();
        });
        toolbarSlot.appendChild(button);
      };

      makeButton(TIME_SHARING_LABEL, chartMode === 'time', () => onChartModeChange?.('time'));
      SPOT_INTERVAL_OPTIONS.forEach((item) => {
        makeButton(formatIntervalLabel(item), chartMode !== 'time' && interval === item, () => {
          onChartModeChange?.('candle');
          onIntervalChange?.(item);
        });
      });
    }).catch(() => undefined);

    return () => {
      cancelled = true;
      cleanupWidget();
    };
  }, [
    amountPrecision,
    chartMode,
    containerId,
    displayName,
    interval,
    locale,
    normalizedSymbol,
    onChartModeChange,
    onIntervalChange,
    pricePrecision,
    scriptReady,
    widgetInterval,
    widgetKey,
    widgetStyle,
  ]);

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
