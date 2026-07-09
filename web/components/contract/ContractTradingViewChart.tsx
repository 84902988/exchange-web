'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import Script from 'next/script';
import { useLocaleContext } from '@/contexts/LocaleContext';
import {
  contractIntervalToTradingViewResolution,
  createContractTradingViewDatafeed,
} from './tradingview/contractTradingViewDatafeed';

type TradingViewChartApi = {
  setResolution?: (
    resolution: string,
    options?: { dataReady?: () => void; doNotActivateChart?: boolean } | (() => void),
  ) => Promise<boolean> | void;
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

type ContractTradingViewGlobal = {
  widget: new (options: Record<string, unknown>) => TradingViewWidgetInstance;
};

type ContractTradingViewWindow = Window & {
  TradingView?: ContractTradingViewGlobal;
};

type TradingViewLoadError = {
  key: string;
  message: string;
};

type ContractTradingViewChartProps = {
  symbol: string;
  displaySymbol?: string | null;
  interval: string;
  intervalOptions?: string[];
  height?: number;
  pricePrecision?: number | null;
  amountPrecision?: number | null;
  onIntervalChange?: (value: string) => void;
  onLatestKlineCloseChange?: (price: string | null) => void;
};

const TRADINGVIEW_LIBRARY_PATH = '/tradingview/charting_library/';
const TRADINGVIEW_SCRIPT_SRC = `${TRADINGVIEW_LIBRARY_PATH}charting_library.js`;
const TRADINGVIEW_TIMEZONE = 'Asia/Shanghai';
const TRADINGVIEW_CANDLE_STYLE = 1;
const DEFAULT_INTERVAL_OPTIONS = ['1m', '5m', '15m', '1h', '4h', '1d', '1w', '1M'];
const TIME_SHARING_KEY = 'time';
const TIME_SHARING_LABEL = 'Time';

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

function styleToolbarButton(button: HTMLButtonElement, active: boolean, disabled = false) {
  button.dataset.active = active ? '1' : '0';
  button.style.color = disabled
    ? 'rgba(255,255,255,0.28)'
    : active
      ? '#f0b90b'
      : 'rgba(255,255,255,0.58)';
  button.style.cursor = disabled ? 'default' : 'pointer';
}

function createToolbarButton(params: {
  owner: Document;
  key: string;
  label: string;
  active: boolean;
  disabled?: boolean;
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
  button.disabled = Boolean(params.disabled);
  styleToolbarButton(button, params.active, params.disabled);
  button.addEventListener('mouseenter', () => {
    if (!params.disabled && button.dataset.active !== '1') {
      button.style.color = 'rgba(255,255,255,0.86)';
    }
  });
  button.addEventListener('mouseleave', () => {
    if (!params.disabled && button.dataset.active !== '1') {
      button.style.color = 'rgba(255,255,255,0.58)';
    }
  });
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!params.disabled) params.onClick();
  });
  return button;
}

export default function ContractTradingViewChart({
  symbol,
  displaySymbol,
  interval,
  intervalOptions,
  height = 520,
  pricePrecision,
  amountPrecision,
  onIntervalChange,
  onLatestKlineCloseChange,
}: ContractTradingViewChartProps) {
  const { locale, t } = useLocaleContext();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const widgetRef = useRef<TradingViewWidgetInstance | null>(null);
  const datafeedRef = useRef<ReturnType<typeof createContractTradingViewDatafeed> | null>(null);
  const reactId = useId();
  const containerId = useMemo(
    () => `contract-tv-chart-${reactId.replace(/[^a-zA-Z0-9_-]/g, '')}`,
    [reactId],
  );
  const normalizedSymbol = useMemo(() => normalizeTradingViewSymbol(symbol), [symbol]);
  const activeIntervals = useMemo(
    () => (intervalOptions?.length ? intervalOptions : DEFAULT_INTERVAL_OPTIONS)
      .filter((item) => Boolean(String(item || '').trim())),
    [intervalOptions],
  );
  const activeInterval = activeIntervals.includes(interval) ? interval : activeIntervals[0] || '1m';
  const widgetInterval = useMemo(() => contractIntervalToTradingViewResolution(activeInterval), [activeInterval]);
  const displayName = displaySymbol || normalizedSymbol;
  const widgetKey = `${normalizedSymbol}:${activeInterval}:${locale}:${pricePrecision ?? 'auto'}:${amountPrecision ?? 'auto'}`;
  const [scriptReady, setScriptReady] = useState(
    () => typeof window !== 'undefined' && Boolean((window as ContractTradingViewWindow).TradingView?.widget),
  );
  const [loadError, setLoadError] = useState<TradingViewLoadError | null>(null);
  const activeLoadError = loadError?.key === widgetKey ? loadError.message : '';

  useEffect(() => {
    let cancelled = false;

    const cleanupWidget = () => {
      datafeedRef.current?.destroy();
      datafeedRef.current = null;

      try {
        widgetRef.current?.remove();
      } catch {
        // TradingView cleanup is best-effort during route/interval switches.
      }
      widgetRef.current = null;
    };

    cleanupWidget();

    if (!scriptReady || !normalizedSymbol || !containerRef.current) {
      return cleanupWidget;
    }

    const tradingView = (window as ContractTradingViewWindow).TradingView;
    if (!tradingView?.widget) {
      window.setTimeout(() => {
        if (cancelled) return;
        setLoadError({
          key: widgetKey,
          message: '图表组件暂不可用',
        });
      }, 0);
      return cleanupWidget;
    }

    const datafeed = createContractTradingViewDatafeed({
      symbol: normalizedSymbol,
      displaySymbol: displayName,
      pricePrecision,
      amountPrecision,
      onLatestBar: onLatestKlineCloseChange,
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
      timezone: TRADINGVIEW_TIMEZONE,
      theme: 'dark',
      style: TRADINGVIEW_CANDLE_STYLE,
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
        'mainSeriesProperties.style': TRADINGVIEW_CANDLE_STYLE,
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

    if (typeof widget.onChartReady === 'function') {
      widget.onChartReady(() => {
        const chart = widget.activeChart?.();
        chart?.setResolution?.(widgetInterval);
      });
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

      toolbarSlot.appendChild(createToolbarButton({
        owner: toolbarSlot.ownerDocument,
        key: TIME_SHARING_KEY,
        label: TIME_SHARING_LABEL,
        active: false,
        disabled: true,
        onClick: () => undefined,
      }));

      activeIntervals.forEach((item) => {
        toolbarSlot.appendChild(createToolbarButton({
          owner: toolbarSlot.ownerDocument,
          key: item,
          label: formatIntervalLabel(item),
          active: item === activeInterval,
          onClick: () => onIntervalChange?.(item),
        }));
      });
    }).catch(() => undefined);

    return () => {
      cancelled = true;
      cleanupWidget();
    };
  }, [
    activeInterval,
    activeIntervals,
    amountPrecision,
    containerId,
    displayName,
    locale,
    normalizedSymbol,
    onIntervalChange,
    onLatestKlineCloseChange,
    pricePrecision,
    scriptReady,
    widgetInterval,
    widgetKey,
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
            message: '图表组件加载失败',
          });
        }}
      />
      <div
        id={containerId}
        ref={containerRef}
        className="min-h-0 flex-1"
        aria-label={`${displayName || normalizedSymbol} ${activeInterval}`}
      />
      {activeLoadError ? (
        <div className="absolute inset-0 flex items-center justify-center bg-[#12161c] px-4 text-center text-sm text-[#f6465d]">
          {t('spotChartLoadFailed', 'asset')}: {activeLoadError}
        </div>
      ) : null}
    </div>
  );
}
