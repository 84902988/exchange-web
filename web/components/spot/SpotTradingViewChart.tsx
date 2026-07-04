'use client';

import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import Script from 'next/script';
import { useLocaleContext } from '@/contexts/LocaleContext';
import type { SpotChartProps } from './chart/chart.types';
import { formatSpotDisplaySymbol } from './spotFormat';
import {
  createSpotTradingViewDatafeed,
  spotIntervalToTradingViewResolution,
  type SpotTradingViewKlineGapEvent,
} from './tradingview/spotTradingViewDatafeed';

type TradingViewActiveChartInstance = {
  resetData?: () => void;
};

type TradingViewWidgetInstance = {
  remove: () => void;
  activeChart?: () => TradingViewActiveChartInstance;
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
};

type SpotTradingViewWindow = Window & {
  TradingView?: SpotTradingViewGlobal;
};

const TRADINGVIEW_LIBRARY_PATH = '/tradingview/charting_library/';
const TRADINGVIEW_SCRIPT_SRC = `${TRADINGVIEW_LIBRARY_PATH}charting_library.js`;

function normalizeTradingViewSymbol(symbol: string) {
  return String(symbol || '').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '');
}

function resolveTradingViewLocale(locale: string) {
  if (locale === 'zh-TW') return 'zh_TW';
  if (locale === 'zh') return 'zh';
  if (locale === 'ja') return 'ja';
  return 'en';
}

function parseDisplayPrice(value?: string | number | null): number | null {
  const num = Number(String(value ?? '').replace(/,/g, '').trim());
  return Number.isFinite(num) && num > 0 ? num : null;
}

function formatDisplayPriceFallback(value: number, precision?: number | null): string {
  const precisionNumber = Number(precision);
  const digits = Number.isInteger(precisionNumber) ? Math.min(Math.max(precisionNumber, 0), 12) : 2;
  return value.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function getDisplayPriceOverlayColor(direction?: string | null): string {
  if (direction === 'up') return '#00c087';
  if (direction === 'down') return '#f6465d';
  return '#f0b90b';
}

export default function SpotTradingViewChart({
  symbol,
  displaySymbol,
  interval,
  height = 520,
  latestPrice,
  displayPriceRaw,
  displayPriceFormatted,
  priceDirection = 'flat',
  pricePrecision,
  amountPrecision,
  tickerFreshness,
  klineFreshness,
  chartMode = 'candle',
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
  const widgetStyle = chartMode === 'time' ? '3' : '1';
  const widgetKey = `${normalizedSymbol}:${chartMode}:${widgetInterval}:${locale}:${pricePrecision ?? 'auto'}:${amountPrecision ?? 'auto'}`;
  const displayName = displaySymbol || formatSpotDisplaySymbol(normalizedSymbol);
  const activeLoadError = loadError?.key === widgetKey ? loadError.message : '';
  const displayPriceNumber = useMemo(
    () => parseDisplayPrice(displayPriceRaw ?? displayPriceFormatted ?? latestPrice),
    [displayPriceFormatted, displayPriceRaw, latestPrice],
  );
  const displayPriceLabel = useMemo(() => {
    const label = String(displayPriceFormatted || '').trim();
    if (label && label !== '--') return label;
    return displayPriceNumber !== null
      ? formatDisplayPriceFallback(displayPriceNumber, pricePrecision)
      : '';
  }, [displayPriceFormatted, displayPriceNumber, pricePrecision]);
  const displayPriceOverlayColor = useMemo(
    () => getDisplayPriceOverlayColor(priceDirection),
    [priceDirection],
  );
  const displayPriceTooltip = useMemo(() => {
    const parts = ['MarketView display price'];
    if (tickerFreshness) parts.push(`ticker=${tickerFreshness}`);
    if (klineFreshness) parts.push(`kline=${klineFreshness}`);
    return parts.join(' | ');
  }, [klineFreshness, tickerFreshness]);
  const handleKlineGap = useCallback((event: SpotTradingViewKlineGapEvent) => {
    const activeChart = widgetRef.current?.activeChart?.();
    if (activeChart && typeof activeChart.resetData === 'function') {
      activeChart.resetData();
      if (process.env.NODE_ENV !== 'production') {
        console.debug('[SpotTradingViewChart] kline gap resetData', {
          symbol: event.symbol,
          interval: event.interval,
          barTime: event.barTime,
          latestBarTime: event.latestBarTime,
          gapIntervals: event.gapIntervals,
          action: 'resetData',
        });
      }
      return;
    }

    if (process.env.NODE_ENV !== 'production') {
      console.warn('[SpotTradingViewChart] resetData unavailable for kline gap', {
        symbol: event.symbol,
        interval: event.interval,
        barTime: event.barTime,
        latestBarTime: event.latestBarTime,
        gapIntervals: event.gapIntervals,
        action: 'onResetCacheNeeded',
      });
    }
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
      onKlineGap: handleKlineGap,
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
    }) as TradingViewWidgetInstance;
    widgetRef.current = widget;

    return () => {
      cancelled = true;
      cleanupWidget();
    };
  }, [amountPrecision, containerId, displayName, handleKlineGap, locale, normalizedSymbol, pricePrecision, scriptReady, widgetInterval, widgetKey, widgetStyle]);

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
      {displayPriceNumber !== null && displayPriceLabel ? (
        <div
          aria-hidden="true"
          title={displayPriceTooltip}
          className="pointer-events-none absolute right-3 top-14 z-10 rounded-l-md border px-2 py-1 text-[12px] font-semibold leading-none shadow-lg"
          style={{
            borderColor: displayPriceOverlayColor,
            backgroundColor: `${displayPriceOverlayColor}22`,
            color: displayPriceOverlayColor,
          }}
        >
          {displayPriceLabel}
        </div>
      ) : null}
      {activeLoadError ? (
        <div className="absolute inset-0 flex items-center justify-center bg-[#12161c] px-4 text-center text-sm text-[#f6465d]">
          {t('spotChartLoadFailed', 'asset')}: {activeLoadError}
        </div>
      ) : null}
    </div>
  );
}
