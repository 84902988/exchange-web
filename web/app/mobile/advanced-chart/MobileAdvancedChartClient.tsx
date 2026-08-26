'use client';

import dynamic from 'next/dynamic';
import { useSearchParams } from 'next/navigation';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { useLocaleContext } from '@/contexts/LocaleContext';
import {
  getContractSymbols,
  type ContractSymbolItem,
} from '@/lib/api/modules/contract';
import { getSpotMarketTickers, type SpotMarketTickerItem } from '@/lib/api/modules/spot';
import type { ContractReferencePrice } from '@/components/contract/contractPriceAuthority';

import {
  ADVANCED_CHART_INTERVALS,
  clearAdvancedChartBootstrapCache,
  createAdvancedChartBridgeEmitter,
  getAdvancedChartSessionIdForBridge,
  isAdvancedChartInterval,
  parseAdvancedChartQuery,
  readAdvancedChartBootstrapCache,
  resolveExactContractBootstrap,
  resolveExactSpotBootstrap,
  writeAdvancedChartBootstrapCache,
  type AdvancedChartBootstrap,
  type AdvancedChartBridgeEvent,
  type AdvancedChartFailure,
  type AdvancedChartInterval,
  type AdvancedChartQuery,
  type AdvancedChartResult,
} from './advancedChartRoute';
import {
  AdvancedChartIndicatorController,
  parseAdvancedChartIndicatorCommand,
  type ParsedAdvancedChartIndicatorCommand,
  type AdvancedChartStudyApi,
} from './advancedChartIndicators';
import {
  loadContractAdvancedChartComponent,
  loadSpotAdvancedChartComponent,
  preloadAdvancedChartComponent,
} from './advancedChartComponentLoader';
import { getAdvancedChartCustomIndicators } from './advancedChartCustomIndicators';

const SpotTradingViewChart = dynamic(
  loadSpotAdvancedChartComponent,
  { ssr: false, loading: () => <ChartLoading /> },
);

const ContractTradingViewChart = dynamic(
  loadContractAdvancedChartComponent,
  { ssr: false, loading: () => <ChartLoading /> },
);

type ReactNativeWebViewBridge = {
  postMessage: (message: string) => void;
};

type BridgeWindow = Window & {
  ReactNativeWebView?: ReactNativeWebViewBridge;
};

function hasAdvancedChartStudyApi(
  chart: AdvancedChartStudyApi | null,
): chart is AdvancedChartStudyApi & Required<Pick<AdvancedChartStudyApi, 'getStudyById'>> {
  return Boolean(
    chart
    && typeof chart.createStudy === 'function'
    && typeof chart.removeEntity === 'function'
    && typeof chart.getAllStudies === 'function'
    && typeof chart.getStudyById === 'function',
  );
}

type PendingIndicatorCommand = Readonly<{
  sessionId: string;
  intentId: number;
  fingerprint: string;
  command: ParsedAdvancedChartIndicatorCommand;
}>;

const bootstrapPromises = new Map<
  string,
  Promise<AdvancedChartResult<AdvancedChartBootstrap>>
>();

function ChartLoading() {
  return (
    <div
      className="flex h-full min-h-0 items-center justify-center bg-[#12161c]"
      aria-label="高级 K 线图加载中"
    >
      <div className="flex items-center gap-2 rounded-full border border-white/[0.06] bg-black/25 px-4 py-3">
        {[0, 1, 2].map((item) => (
          <span
            key={item}
            className="h-2 w-2 animate-bounce rounded-full bg-[#f0b90b]"
            style={{ animationDelay: `${item * 110}ms` }}
          />
        ))}
      </div>
    </div>
  );
}

function bootstrapCacheKey(query: AdvancedChartQuery) {
  return `${query.market}:${query.symbol}`;
}

async function loadAdvancedChartBootstrap(
  query: AdvancedChartQuery,
): Promise<AdvancedChartResult<AdvancedChartBootstrap>> {
  if (query.market === 'spot') {
    const items = await getSpotMarketTickers(query.symbol);
    return resolveExactSpotBootstrap(items as SpotMarketTickerItem[], query.symbol);
  }

  const payload = await getContractSymbols({
    keyword: query.symbol,
    page: 1,
    page_size: 100,
  });
  return resolveExactContractBootstrap(
    (payload.items || []) as ContractSymbolItem[],
    query.symbol,
  );
}

function getCachedBootstrap(query: AdvancedChartQuery) {
  const key = bootstrapCacheKey(query);
  const existing = bootstrapPromises.get(key);
  if (existing) return existing;

  const request = loadAdvancedChartBootstrap(query).catch((error: unknown) => {
    bootstrapPromises.delete(key);
    throw error;
  });
  bootstrapPromises.set(key, request);
  if (bootstrapPromises.size > 16) {
    const oldestKey = bootstrapPromises.keys().next().value;
    if (typeof oldestKey === 'string' && oldestKey !== key) {
      bootstrapPromises.delete(oldestKey);
    }
  }
  return request;
}

function clearCachedBootstrap(query: AdvancedChartQuery) {
  bootstrapPromises.delete(bootstrapCacheKey(query));
}

function unavailableReferencePrice(symbol: string): ContractReferencePrice {
  return {
    value: null,
    domain: 'UNAVAILABLE',
    source: null,
    provider: null,
    freshness: null,
    eventTimeMs: null,
    usable: false,
    rejectReason: 'MOBILE_CHART_BOOTSTRAP',
    symbol,
    role: 'UNAVAILABLE',
  };
}

function networkFailure(): AdvancedChartFailure {
  return {
    code: 'METADATA_INVALID',
    message: '高级 K 线图元数据加载失败',
  };
}

export default function MobileAdvancedChartClient() {
  const searchParams = useSearchParams();
  const rawQuery = searchParams.toString();
  const parsed = useMemo(() => parseAdvancedChartQuery(rawQuery), [rawQuery]);
  const bridgeSessionId = useMemo(
    () => getAdvancedChartSessionIdForBridge(rawQuery),
    [rawQuery],
  );
  const { locale, changeLocale, isInitialized, isLoading: localeLoading } = useLocaleContext();
  const [bootstrap, setBootstrap] = useState<AdvancedChartBootstrap | null>(null);
  const [bootstrapError, setBootstrapError] = useState<AdvancedChartFailure | null>(null);
  const [bootstrapLoading, setBootstrapLoading] = useState(false);
  const [bootstrapSource, setBootstrapSource] = useState<
    'pending' | 'persistent-cache' | 'request'
  >('pending');
  const [retrySequence, setRetrySequence] = useState(0);
  const [interval, setInterval] = useState<AdvancedChartInterval>('1m');
  const chartHostRef = useRef<HTMLDivElement | null>(null);
  const bridgeEmitterRef = useRef<ReturnType<typeof createAdvancedChartBridgeEmitter> | null>(null);
  const chartDataReadySessionRef = useRef<string | null>(null);
  const chartReadySessionRef = useRef<string | null>(null);
  const studyApiAttachedSessionRef = useRef<string | null>(null);
  const pendingIndicatorCommandRef = useRef<PendingIndicatorCommand | null>(null);
  const indicatorCommandSequenceRef = useRef<Readonly<{
    sessionId: string | null;
    intentId: number;
    fingerprint: string;
  }>>({ sessionId: null, intentId: 0, fingerprint: '' });

  if (!bridgeEmitterRef.current) {
    bridgeEmitterRef.current = createAdvancedChartBridgeEmitter((message) => {
      if (typeof window === 'undefined') return;
      (window as BridgeWindow).ReactNativeWebView?.postMessage(message);
    });
  }

  const emitBridge = useCallback((event: AdvancedChartBridgeEvent) => {
    return bridgeEmitterRef.current?.emit(event);
  }, []);

  const indicatorController = useMemo(() => {
    if (!parsed.ok) return null;
    return new AdvancedChartIndicatorController({
      onCommitted: (intentId, indicators) => {
        emitBridge({
          type: 'INDICATORS_COMMITTED',
          sessionId: parsed.value.sessionId,
          intentId,
          indicators,
        });
      },
      onError: (intentId, message, indicators) => {
        emitBridge({
          type: 'INDICATORS_ERROR',
          sessionId: parsed.value.sessionId,
          intentId,
          message,
          indicators,
        });
      },
      onConfigCommitted: (intentId, config) => {
        emitBridge({
          type: 'INDICATOR_CONFIG_COMMITTED',
          sessionId: parsed.value.sessionId,
          intentId,
          config,
        });
      },
      onConfigError: (intentId, message, config) => {
        emitBridge({
          type: 'INDICATOR_CONFIG_ERROR',
          sessionId: parsed.value.sessionId,
          intentId,
          message,
          config,
        });
      },
    });
  }, [emitBridge, parsed]);

  const applyIndicatorCommand = useCallback((
    command: ParsedAdvancedChartIndicatorCommand,
  ) => {
    if (!indicatorController) return false;
    if (command.command === 'set-indicator-config-v2') {
      return indicatorController.setIndicatorConfig(command.config, command.intentId);
    }
    return indicatorController.setIndicators(command.indicators, command.intentId);
  }, [indicatorController]);

  const flushPendingIndicatorCommand = useCallback(() => {
    if (!parsed.ok) return;
    const sessionId = parsed.value.sessionId;
    if (studyApiAttachedSessionRef.current !== sessionId) return;
    if (
      chartReadySessionRef.current !== sessionId
      && chartDataReadySessionRef.current !== sessionId
    ) return;
    const pending = pendingIndicatorCommandRef.current;
    if (!pending || pending.sessionId !== sessionId) return;
    pendingIndicatorCommandRef.current = null;
    applyIndicatorCommand(pending.command);
  }, [applyIndicatorCommand, parsed]);

  const emitChartReadyIfPossible = useCallback(() => {
    if (!parsed.ok) return;
    const sessionId = parsed.value.sessionId;
    if (
      chartDataReadySessionRef.current !== sessionId
      || studyApiAttachedSessionRef.current !== sessionId
    ) return;
    emitBridge({
      type: 'CHART_READY',
      sessionId,
      capabilities: ['indicator-config-v2'],
    });
    chartReadySessionRef.current = sessionId;
    flushPendingIndicatorCommand();
  }, [emitBridge, flushPendingIndicatorCommand, parsed]);

  const handleMobileChartApiReady = useCallback((chart: AdvancedChartStudyApi | null) => {
    if (!parsed.ok) return;
    const sessionId = parsed.value.sessionId;
    if (!hasAdvancedChartStudyApi(chart)) {
      studyApiAttachedSessionRef.current = null;
      indicatorController?.attach(null);
      return;
    }
    indicatorController?.attach(chart);
    studyApiAttachedSessionRef.current = sessionId;
    if (chartReadySessionRef.current === sessionId) {
      flushPendingIndicatorCommand();
    } else {
      emitChartReadyIfPossible();
    }
  }, [emitChartReadyIfPossible, flushPendingIndicatorCommand, indicatorController, parsed]);

  useEffect(() => {
    if (!parsed.ok || !indicatorController) return;
    const handleMessage = (event: MessageEvent<unknown>) => {
      if (event.source !== window || event.origin !== window.location.origin) return;
      const command = parseAdvancedChartIndicatorCommand(
        event.data,
        parsed.value.sessionId,
      );
      if (!command) return;
      const sessionId = parsed.value.sessionId;
      const fingerprint = JSON.stringify(command);
      const sequence = indicatorCommandSequenceRef.current;
      if (sequence.sessionId === sessionId) {
        if (command.intentId < sequence.intentId) return;
        if (command.intentId === sequence.intentId) {
          if (fingerprint !== sequence.fingerprint) return;
          return;
        }
      }
      indicatorCommandSequenceRef.current = {
        sessionId,
        intentId: command.intentId,
        fingerprint,
      };
      if (
        studyApiAttachedSessionRef.current === sessionId
        && (
          chartReadySessionRef.current === sessionId
          || chartDataReadySessionRef.current === sessionId
        )
      ) {
        applyIndicatorCommand(command);
        return;
      }
      pendingIndicatorCommandRef.current = {
        sessionId,
        intentId: command.intentId,
        fingerprint,
        command,
      };
    };
    window.addEventListener('message', handleMessage);
    return () => {
      window.removeEventListener('message', handleMessage);
      studyApiAttachedSessionRef.current = null;
      chartDataReadySessionRef.current = null;
      chartReadySessionRef.current = null;
      pendingIndicatorCommandRef.current = null;
      indicatorCommandSequenceRef.current = {
        sessionId: null,
        intentId: 0,
        fingerprint: '',
      };
      indicatorController.attach(null);
    };
  }, [applyIndicatorCommand, indicatorController, parsed]);

  useEffect(() => {
    if (!parsed.ok || !isInitialized || localeLoading) return;
    if (locale !== parsed.value.locale) changeLocale(parsed.value.locale);
  }, [changeLocale, isInitialized, locale, localeLoading, parsed]);

  useEffect(() => {
    if (!parsed.ok) return;
    setInterval(parsed.value.interval);
  }, [parsed]);

  useEffect(() => {
    if (!parsed.ok) return;
    void preloadAdvancedChartComponent(parsed.value.market).catch(
      () => undefined,
    );
  }, [parsed]);

  useEffect(() => {
    if (!parsed.ok) {
      setBootstrap(null);
      setBootstrapError(parsed.error);
      setBootstrapLoading(false);
      setBootstrapSource('pending');
      if (bridgeSessionId) {
        emitBridge({
          type: 'CHART_ERROR',
          sessionId: bridgeSessionId,
          message: parsed.error.message,
        });
      }
      return;
    }

    let active = true;
    const cachedBootstrap = retrySequence === 0
      ? readAdvancedChartBootstrapCache(parsed.value)
      : null;
    if (cachedBootstrap) {
      setBootstrap(cachedBootstrap);
      setBootstrapError(null);
      setBootstrapLoading(false);
      setBootstrapSource('persistent-cache');
      return;
    }

    setBootstrap(null);
    setBootstrapError(null);
    setBootstrapLoading(true);
    setBootstrapSource('request');
    void getCachedBootstrap(parsed.value).then((result) => {
      if (!active) return;
      if (result.ok) {
        writeAdvancedChartBootstrapCache(parsed.value, result.value);
        setBootstrap(result.value);
        setBootstrapError(null);
      } else {
        setBootstrap(null);
        setBootstrapError(result.error);
        emitBridge({
          type: 'CHART_ERROR',
          sessionId: parsed.value.sessionId,
          message: result.error.message,
        });
      }
    }).catch(() => {
      if (!active) return;
      const error = networkFailure();
      setBootstrap(null);
      setBootstrapError(error);
      emitBridge({
        type: 'CHART_ERROR',
        sessionId: parsed.value.sessionId,
        message: error.message,
      });
    }).finally(() => {
      if (active) setBootstrapLoading(false);
    });

    return () => {
      active = false;
    };
  }, [bridgeSessionId, emitBridge, parsed, retrySequence]);

  const handleIntervalCommit = useCallback((value: string) => {
    if (!parsed.ok || !isAdvancedChartInterval(value)) return;
    setInterval(value);
    emitBridge({
      type: 'INTERVAL_COMMITTED',
      sessionId: parsed.value.sessionId,
      interval: value,
    });
  }, [emitBridge, parsed]);

  const handleEmbeddedIntervalChange = useCallback((value: string) => {
    if (isAdvancedChartInterval(value)) setInterval(value);
  }, []);

  const handleSpotIntervalResolutionFailure = useCallback((rollbackValue: string) => {
    if (isAdvancedChartInterval(rollbackValue)) setInterval(rollbackValue);
  }, []);

  useEffect(() => {
    if (!parsed.ok || !bootstrap || !chartHostRef.current) return;
    const host = chartHostRef.current;
    const inspectChartState = () => {
      const chartRoot = parsed.value.market === 'spot'
        ? host.querySelector<HTMLElement>('[data-spot-chart-bootstrap="ready"]')
        : host.querySelector<HTMLElement>('[data-contract-chart-bootstrap="ready"]');
      if (!chartRoot) {
        chartDataReadySessionRef.current = null;
        return;
      }

      const error = parsed.value.market === 'spot'
        ? chartRoot.dataset.spotChartError
        : chartRoot.dataset.contractChartError;
      if (error) {
        chartDataReadySessionRef.current = null;
        emitBridge({
          type: 'CHART_ERROR',
          sessionId: parsed.value.sessionId,
          message: error.slice(0, 200),
        });
        return;
      }

      const loading = parsed.value.market === 'spot'
        ? chartRoot.dataset.spotChartLoading
        : chartRoot.dataset.contractChartLoading;
      chartDataReadySessionRef.current = loading === 'ready'
        ? parsed.value.sessionId
        : null;
      if (loading === 'ready') {
        emitChartReadyIfPossible();
      }
    };

    const observer = new MutationObserver(inspectChartState);
    observer.observe(host, {
      attributes: true,
      childList: true,
      subtree: true,
      attributeFilter: [
        'data-spot-chart-bootstrap',
        'data-spot-chart-loading',
        'data-spot-chart-error',
        'data-contract-chart-bootstrap',
        'data-contract-chart-loading',
        'data-contract-chart-error',
      ],
    });
    const frame = window.requestAnimationFrame(inspectChartState);
    return () => {
      chartDataReadySessionRef.current = null;
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [bootstrap, emitBridge, emitChartReadyIfPossible, parsed]);

  const retry = useCallback(() => {
    if (!parsed.ok) return;
    clearCachedBootstrap(parsed.value);
    clearAdvancedChartBootstrapCache(parsed.value);
    setRetrySequence((value) => value + 1);
  }, [parsed]);

  const query = parsed.ok ? parsed.value : null;
  const localeReady = Boolean(
    query
    && isInitialized
    && !localeLoading
    && locale === query.locale,
  );
  const referencePrice = useMemo(
    () => unavailableReferencePrice(query?.symbol || ''),
    [query?.symbol],
  );

  return (
    <main
      className="fixed inset-0 flex min-h-0 flex-col overflow-hidden bg-[#0b0e11] text-white"
      data-mobile-advanced-chart={query?.market || 'invalid'}
      data-mobile-chart-bootstrap-source={bootstrapSource}
    >
      <div
        ref={chartHostRef}
        className="min-h-0 flex-1 overflow-hidden bg-[#12161c] landscape:mx-2 landscape:mt-1 landscape:rounded-lg landscape:border landscape:border-white/[0.08] landscape:shadow-[0_10px_28px_rgba(0,0,0,0.28)]"
        data-mobile-chart-region
      >
        {bootstrapError ? (
          <div className="flex h-full min-h-0 flex-col items-center justify-center gap-4 bg-[#12161c] px-6 text-center">
            <p className="text-sm text-[#f6465d]">{bootstrapError.message}</p>
            {parsed.ok ? (
              <button
                type="button"
                className="rounded-md border border-white/15 px-4 py-2 text-sm text-white/85 active:bg-white/10"
                onClick={retry}
              >
                重试
              </button>
            ) : null}
          </div>
        ) : bootstrapLoading || !bootstrap || !query || !localeReady ? (
          <ChartLoading />
        ) : query.market === 'spot' ? (
          <SpotTradingViewChart
            key={`spot:${bootstrap.symbol}`}
            amountPrecision={bootstrap.amountPrecision}
            bootstrapReady
            chartMode="candle"
            customIndicatorsGetter={getAdvancedChartCustomIndicators}
            displaySymbol={bootstrap.displaySymbol}
            height={0}
            interval={interval}
            mobileEmbed
            pricePrecision={bootstrap.pricePrecision}
            showRwaReference={false}
            spotLogoAlt={bootstrap.logoAlt}
            spotLogoUrl={bootstrap.logoUrl}
            symbol={bootstrap.symbol}
            onIntervalChange={handleEmbeddedIntervalChange}
            onIntervalResolutionCommit={handleIntervalCommit}
            onIntervalResolutionFailure={handleSpotIntervalResolutionFailure}
            onMobileChartApiReady={handleMobileChartApiReady}
          />
        ) : (
          <ContractTradingViewChart
            key={`contract:${bootstrap.symbol}`}
            amountPrecision={bootstrap.amountPrecision}
            bootstrapReady
            category={bootstrap.category || query.category}
            chartMode="candle"
            customIndicatorsGetter={getAdvancedChartCustomIndicators}
            displaySymbol={bootstrap.displaySymbol}
            height={0}
            interval={interval}
            intervalOptions={[...ADVANCED_CHART_INTERVALS]}
            mobileEmbed
            positions={[]}
            priceDirection="flat"
            pricePrecision={bootstrap.pricePrecision}
            referencePrice={referencePrice}
            symbol={bootstrap.symbol}
            onIntervalChange={handleEmbeddedIntervalChange}
            onIntervalResolutionCommit={handleIntervalCommit}
            onMobileChartApiReady={handleMobileChartApiReady}
          />
        )}
      </div>

      <nav
        className="grid h-11 shrink-0 grid-cols-6 items-center gap-1 overflow-hidden border-t border-white/10 bg-[#0b0e11] px-2 shadow-[0_-8px_24px_rgba(0,0,0,0.18)] landscape:h-10 landscape:gap-2 landscape:border-white/[0.08] landscape:bg-[#0f1319] landscape:px-6"
        aria-label="K 线周期"
        data-mobile-chart-periods
      >
        {ADVANCED_CHART_INTERVALS.map((item) => (
          <button
            key={item}
            type="button"
            className={`h-8 min-w-0 rounded-full border px-1 text-[11px] font-semibold transition-colors landscape:h-7 landscape:text-xs ${
              interval === item
                ? 'border-[#f0b90b]/25 bg-[#f0b90b]/15 text-[#f0b90b] shadow-[inset_0_-1px_0_rgba(240,185,11,0.35)]'
                : 'border-transparent text-white/55 active:bg-white/10 active:text-white'
            }`}
            disabled={!bootstrap || !localeReady}
            aria-pressed={interval === item}
            onClick={() => setInterval(item)}
          >
            {item}
          </button>
        ))}
      </nav>
    </main>
  );
}
