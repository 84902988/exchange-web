'use client';

import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import Script from 'next/script';
import { useLocaleContext } from '@/contexts/LocaleContext';
import type { SpotChartProps, SpotKlineLoadState } from './chart/chart.types';
import { formatSpotDisplaySymbol } from './spotFormat';
import {
  createSpotTradingViewDatafeed,
  spotIntervalToTradingViewResolution,
} from './tradingview/spotTradingViewDatafeed';
import {
  resolveSpotKlineStatus,
  spotMarketStatusBadgeClass,
} from './spotMarketStatus';

type TradingViewWidgetInstance = {
  remove: () => void;
};

type SpotTradingViewGlobal = {
  widget: new (options: Record<string, unknown>) => TradingViewWidgetInstance;
};

type TradingViewLoadError = {
  key: string;
  message: string;
};

type KlineLoadStateByKey = {
  key: string;
  state: SpotKlineLoadState;
};

type KlineRealtimeByKey = {
  key: string;
  updatedAtMs: number;
};

type SpotTradingViewChartProps = SpotChartProps & {
  chartMode?: 'time' | 'candle';
};

type SpotTradingViewWindow = Window & {
  TradingView?: SpotTradingViewGlobal;
};

const TRADINGVIEW_LIBRARY_PATH = '/tradingview/charting_library/';
const TRADINGVIEW_SCRIPT_SRC = `${TRADINGVIEW_LIBRARY_PATH}charting_library.js`;
const KLINE_REALTIME_STATUS_GRACE_MS = 30_000;

function normalizeTradingViewSymbol(symbol: string) {
  return String(symbol || '').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '');
}

function resolveTradingViewLocale(locale: string) {
  if (locale === 'zh-TW') return 'zh_TW';
  if (locale === 'zh') return 'zh';
  if (locale === 'ja') return 'ja';
  return 'en';
}

export default function SpotTradingViewChart({
  symbol,
  displaySymbol,
  interval,
  height = 520,
  dataSource,
  klineSource,
  klineFreshness,
  isLoading = false,
  pricePrecision,
  amountPrecision,
  chartMode = 'candle',
}: SpotTradingViewChartProps) {
  const { locale, t } = useLocaleContext();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const widgetRef = useRef<TradingViewWidgetInstance | null>(null);
  const datafeedRef = useRef<ReturnType<typeof createSpotTradingViewDatafeed> | null>(null);
  const [loadError, setLoadError] = useState<TradingViewLoadError | null>(null);
  const [scriptReady, setScriptReady] = useState(false);
  const [klineLoadStateByKey, setKlineLoadStateByKey] = useState<KlineLoadStateByKey | null>(null);
  const [klineRealtimeByKey, setKlineRealtimeByKey] = useState<KlineRealtimeByKey | null>(null);
  const [statusClockMs, setStatusClockMs] = useState(() => Date.now());
  const reactId = useId();
  const containerId = useMemo(
    () => `spot-tv-chart-${reactId.replace(/[^a-zA-Z0-9_-]/g, '')}`,
    [reactId],
  );

  const normalizedSymbol = useMemo(() => normalizeTradingViewSymbol(symbol), [symbol]);
  const activeInterval = chartMode === 'time' ? '1m' : interval;
  const widgetInterval = useMemo(() => spotIntervalToTradingViewResolution(activeInterval), [activeInterval]);
  const widgetStyle = chartMode === 'time' ? '3' : '1';
  const widgetKey = `${normalizedSymbol}:${chartMode}:${widgetInterval}:${locale}:${pricePrecision ?? 'auto'}:${amountPrecision ?? 'auto'}`;
  const displayName = displaySymbol || formatSpotDisplaySymbol(normalizedSymbol);
  const activeLoadError = loadError?.key === widgetKey ? loadError.message : '';
  const activeKlineLoadState = klineLoadStateByKey?.key === widgetKey
    ? klineLoadStateByKey.state
    : 'loading';
  const activeKlineRealtimeAtMs = klineRealtimeByKey?.key === widgetKey
    ? klineRealtimeByKey.updatedAtMs
    : null;
  const klineStatus = useMemo(
    () => resolveSpotKlineStatus({
      source: klineSource,
      freshness: klineFreshness,
      dataSource,
      loadState: activeKlineLoadState,
      isLoading,
      realtimeUpdatedAtMs: activeKlineRealtimeAtMs,
      realtimeGraceMs: KLINE_REALTIME_STATUS_GRACE_MS,
      nowMs: statusClockMs,
    }),
    [activeKlineLoadState, activeKlineRealtimeAtMs, dataSource, isLoading, klineFreshness, klineSource, statusClockMs],
  );

  useEffect(() => {
    const timer = window.setInterval(() => setStatusClockMs(Date.now()), 5_000);
    return () => window.clearInterval(timer);
  }, []);

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
      onKlineLoadStateChange: (state) => setKlineLoadStateByKey({ key: widgetKey, state }),
      onKlineRealtime: (event) => {
        const now = event.updatedAtMs || Date.now();
        setStatusClockMs(now);
        setKlineRealtimeByKey({ key: widgetKey, updatedAtMs: now });
      },
    });
    datafeedRef.current = datafeed;

    widgetRef.current = new tradingView.widget({
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
      disabled_features: [
        'use_localstorage_for_settings',
        'header_symbol_search',
        'header_compare',
        'header_resolutions',
        'symbol_search_hot_key',
        'display_market_status',
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

    return () => {
      cancelled = true;
      cleanupWidget();
    };
  }, [amountPrecision, containerId, displayName, locale, normalizedSymbol, pricePrecision, scriptReady, widgetInterval, widgetKey, widgetStyle]);

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
      <div className="pointer-events-none absolute left-3 top-3 z-10 flex flex-wrap items-center gap-1.5">
        <span className="rounded-md border border-white/[0.08] bg-[#11161c]/92 px-2 py-1 text-[11px] font-medium text-white/72 shadow-lg shadow-black/20 backdrop-blur-sm">
          {activeInterval}
        </span>
        <span className={`rounded-md border px-2 py-1 text-[11px] font-semibold shadow-lg shadow-black/20 backdrop-blur-sm ${spotMarketStatusBadgeClass(klineStatus.kind)}`}>
          {klineStatus.label}
        </span>
      </div>
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
