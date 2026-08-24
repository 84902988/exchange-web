import React, {useCallback, useEffect, useRef, useState} from 'react';
import {StyleSheet, Text, View} from 'react-native';
import WebView, {
  type WebViewMessageEvent,
} from 'react-native-webview';

import {
  CHART_WEB_BASE_URL,
  IS_BENCHMARK_BUILD,
  reportBenchmarkChartPerf,
} from '../../config/env';
import {useLanguage, type MobileLocale} from '../../i18n';
import {colors, typography} from '../../theme';
import type {KlineInterval} from '../trade/kline.utils';
import {
  ADVANCED_CHART_CONFIG_CAPABILITY,
  type AdvancedChartIndicatorConfigV2,
} from './advancedChartConfig';
import {
  ADVANCED_CHART_INDICATORS,
  ADVANCED_CHART_OVERLAY_INDICATORS,
  ADVANCED_CHART_PANE_INDICATORS,
  type AdvancedChartIndicator,
} from './advancedChartIndicators';
import {
  buildAdvancedChartUrl,
  buildAdvancedChartBenchmarkProbeScript,
  createAdvancedChartSessionId,
  getAdvancedChartOrigin,
  isAllowedAdvancedChartNavigation,
  isAllowedAdvancedChartTopNavigation,
  parseAdvancedChartBridgeMessage,
  type AdvancedChartCategory,
  type AdvancedChartIndicators,
  type AdvancedChartMarket,
} from './advancedChartUrl';

export type {
  AdvancedChartIndicators,
  AdvancedChartOverlayIndicator,
  AdvancedChartPaneIndicator,
} from './advancedChartUrl';
export {
  ADVANCED_CHART_INDICATORS,
  ADVANCED_CHART_OVERLAY_INDICATORS,
  ADVANCED_CHART_PANE_INDICATORS,
};
export type {AdvancedChartIndicator};

// The native preview stays usable while the Web chart warms up. Keep these as
// hard recovery guards, not short UX deadlines: a cold dev server or Android
// WebView startup must not be mistaken for a permanently broken chart.
export const ADVANCED_CHART_LOAD_STALL_TIMEOUT_MS = 60000;
export const ADVANCED_CHART_READY_TIMEOUT_MS = 45000;

function advancedChartLocale(locale: MobileLocale) {
  return locale === 'zh-CN' ? 'zh' : locale;
}

export type AdvancedChartFallbackReason =
  | 'invalid_request'
  | 'ready_timeout'
  | 'load_error'
  | 'http_error'
  | 'renderer_terminated'
  | 'navigation_blocked'
  | 'chart_error';

type Props = {
  market: AdvancedChartMarket;
  symbol: string;
  interval: KlineInterval;
  indicators: AdvancedChartIndicators;
  config: AdvancedChartIndicatorConfigV2;
  preferencesHydrated: boolean;
  category?: AdvancedChartCategory;
  onIntervalChange: (interval: KlineInterval) => void;
  onIndicatorsCommitted?: (indicators: AdvancedChartIndicators) => void;
  onIndicatorsError?: (
    message: string,
    indicators: AdvancedChartIndicators | null,
  ) => void;
  onIndicatorConfigCapabilityChange?: (supported: boolean) => void;
  onIndicatorConfigCommitted?: (config: AdvancedChartIndicatorConfigV2) => void;
  onIndicatorConfigError?: (
    message: string,
    config: AdvancedChartIndicatorConfigV2 | null,
  ) => void;
  onFallback: (reason: AdvancedChartFallbackReason) => void;
  onReady?: () => void;
};

type ChartRequest = {
  url: string;
  origin: string;
  sessionId: string;
  generation: number;
};

type AdvancedChartNativeBenchmarkMark =
  | 'NATIVE_COMPONENT_MOUNTED'
  | 'NATIVE_LOAD_START'
  | 'NATIVE_LOAD_END'
  | 'NATIVE_CHART_READY';

function benchmarkNowMs() {
  return Date.now();
}

function createReloadChartRequest(request: ChartRequest): ChartRequest | null {
  try {
    const sessionId = createAdvancedChartSessionId();
    const url = new URL(request.url);
    url.searchParams.set('sessionId', sessionId);
    return {
      url: url.toString(),
      origin: request.origin,
      sessionId,
      generation: request.generation + 1,
    };
  } catch {
    return null;
  }
}

export default function AdvancedKlineWebView({
  market,
  symbol,
  interval,
  indicators,
  config,
  preferencesHydrated,
  category,
  onIntervalChange,
  onIndicatorsCommitted,
  onIndicatorsError,
  onIndicatorConfigCapabilityChange,
  onIndicatorConfigCommitted,
  onIndicatorConfigError,
  onFallback,
  onReady,
}: Props) {
  const {locale, t} = useLanguage();
  const [request, setRequest] = useState<ChartRequest | null>(() => {
    try {
      const sessionId = createAdvancedChartSessionId();
      const url = buildAdvancedChartUrl({
        baseUrl: CHART_WEB_BASE_URL,
        market,
        symbol,
        interval,
        lang: advancedChartLocale(locale),
        sessionId,
        category,
      });
      const origin = getAdvancedChartOrigin(url);
      return origin ? {url, origin, sessionId, generation: 0} : null;
    } catch {
      return null;
    }
  });
  const [ready, setReady] = useState(false);
  const [documentLoaded, setDocumentLoaded] = useState(false);
  const [supportsIndicatorConfigV2, setSupportsIndicatorConfigV2] =
    useState(false);
  const [indicatorRetryEpoch, setIndicatorRetryEpoch] = useState(0);
  const readyRef = useRef(false);
  const activeSessionIdRef = useRef(request?.sessionId ?? '');
  const previousRequestUrlRef = useRef<string | null>(null);
  const failedRef = useRef(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fallbackRef = useRef(onFallback);
  const intervalChangeRef = useRef(onIntervalChange);
  const indicatorsCommittedRef = useRef(onIndicatorsCommitted);
  const indicatorsErrorRef = useRef(onIndicatorsError);
  const configCapabilityRef = useRef(onIndicatorConfigCapabilityChange);
  const configCommittedRef = useRef(onIndicatorConfigCommitted);
  const configErrorRef = useRef(onIndicatorConfigError);
  const readyCallbackRef = useRef(onReady);
  const webViewRef = useRef<WebView<{}> | null>(null);
  const indicatorIntentRef = useRef(0);
  const latestIndicatorIntentRef = useRef(0);
  const latestIndicatorProtocolRef = useRef<'v1' | 'v2'>('v1');
  const settledIndicatorIntentRef = useRef(0);
  const appliedIndicatorFingerprintRef = useRef('');
  const indicatorNullErrorRetryCountRef = useRef(0);
  const benchmarkSessionRef = useRef({
    sessionId: request?.sessionId ?? '',
    startedAtMs: benchmarkNowMs(),
  });
  if (
    request &&
    benchmarkSessionRef.current.sessionId !== request.sessionId
  ) {
    benchmarkSessionRef.current = {
      sessionId: request.sessionId,
      startedAtMs: benchmarkNowMs(),
    };
  }
  fallbackRef.current = onFallback;
  intervalChangeRef.current = onIntervalChange;
  indicatorsCommittedRef.current = onIndicatorsCommitted;
  indicatorsErrorRef.current = onIndicatorsError;
  configCapabilityRef.current = onIndicatorConfigCapabilityChange;
  configCommittedRef.current = onIndicatorConfigCommitted;
  configErrorRef.current = onIndicatorConfigError;
  readyCallbackRef.current = onReady;

  const clearReadyTimeout = useCallback(() => {
    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const logBenchmarkMark = useCallback(
    (
      mark: AdvancedChartNativeBenchmarkMark | `WEB_${string}`,
      webElapsedMs?: number,
    ) => {
      if (!IS_BENCHMARK_BUILD || !request) return;
      const session = benchmarkSessionRef.current;
      if (session.sessionId !== request.sessionId) return;
      const nativeElapsedMs = Math.max(
        0,
        Math.round((benchmarkNowMs() - session.startedAtMs) * 10) / 10,
      );
      reportBenchmarkChartPerf(
        JSON.stringify({
          sessionId: request.sessionId,
          market,
          symbol,
          mark,
          nativeElapsedMs,
          ...(webElapsedMs === undefined ? {} : {webElapsedMs}),
        }),
      );
    },
    [market, request, symbol],
  );

  useEffect(() => {
    logBenchmarkMark('NATIVE_COMPONENT_MOUNTED');
  }, [logBenchmarkMark]);

  const fail = useCallback(
    (reason: AdvancedChartFallbackReason) => {
      if (failedRef.current) return;
      failedRef.current = true;
      clearReadyTimeout();
      fallbackRef.current(reason);
    },
    [clearReadyTimeout],
  );

  const armReadyTimeout = useCallback(() => {
    clearReadyTimeout();
    timeoutRef.current = setTimeout(
      () => fail('ready_timeout'),
      ADVANCED_CHART_READY_TIMEOUT_MS,
    );
  }, [clearReadyTimeout, fail]);

  const armLoadStallTimeout = useCallback(() => {
    clearReadyTimeout();
    timeoutRef.current = setTimeout(
      () => fail('ready_timeout'),
      ADVANCED_CHART_LOAD_STALL_TIMEOUT_MS,
    );
  }, [clearReadyTimeout, fail]);

  useEffect(() => {
    if (!request) {
      fail('invalid_request');
      return;
    }
    armLoadStallTimeout();
    return clearReadyTimeout;
  }, [armLoadStallTimeout, clearReadyTimeout, fail, request]);

  useEffect(() => {
    if (!ready || !request || !preferencesHydrated || failedRef.current) return;
    if (indicatorIntentRef.current >= Number.MAX_SAFE_INTEGER) {
      fail('chart_error');
      return;
    }
    const intentId = indicatorIntentRef.current + 1;
    const protocol = supportsIndicatorConfigV2 ? 'v2' : 'v1';
    const fingerprint = `${protocol}:${JSON.stringify(
      supportsIndicatorConfigV2 ? config : indicators,
    )}`;
    if (appliedIndicatorFingerprintRef.current === fingerprint) return;
    indicatorIntentRef.current = intentId;
    latestIndicatorIntentRef.current = intentId;
    latestIndicatorProtocolRef.current = protocol;
    settledIndicatorIntentRef.current = 0;
    appliedIndicatorFingerprintRef.current = fingerprint;
    const message = supportsIndicatorConfigV2
      ? {
          type: 'mobile-chart-command' as const,
          sessionId: request.sessionId,
          intentId,
          command: 'set-indicator-config-v2' as const,
          config,
        }
      : {
          type: 'mobile-chart-command' as const,
          sessionId: request.sessionId,
          intentId,
          command: 'set-indicators' as const,
          indicators,
        };
    webViewRef.current?.injectJavaScript(
      `window.postMessage(${JSON.stringify(message)}, window.location.origin); true;`,
    );
  }, [
    config,
    fail,
    indicators,
    indicatorRetryEpoch,
    preferencesHydrated,
    ready,
    request,
    supportsIndicatorConfigV2,
  ]);

  const handleMessage = useCallback(
    (event: WebViewMessageEvent) => {
      if (!request || failedRef.current) return;
      const message = parseAdvancedChartBridgeMessage(
        event.nativeEvent.data,
        activeSessionIdRef.current,
      );
      if (!message) return;
      if (message.type === 'PERF_MARK') {
        logBenchmarkMark(message.mark, message.elapsedMs);
        return;
      }
      if (message.type === 'CHART_READY') {
        if (readyRef.current) return;
        readyRef.current = true;
        previousRequestUrlRef.current = null;
        logBenchmarkMark('NATIVE_CHART_READY');
        const supportsConfig = message.capabilities.includes(
          ADVANCED_CHART_CONFIG_CAPABILITY,
        );
        setSupportsIndicatorConfigV2(supportsConfig);
        configCapabilityRef.current?.(supportsConfig);
        clearReadyTimeout();
        setReady(true);
        readyCallbackRef.current?.();
        return;
      }
      if (message.type === 'CHART_ERROR') {
        fail('chart_error');
        return;
      }
      if (!readyRef.current) return;
      const settleCurrentIndicatorIntent = (
        protocol: 'v1' | 'v2',
        intentId: number,
      ) => {
        if (
          latestIndicatorProtocolRef.current !== protocol ||
          intentId !== latestIndicatorIntentRef.current ||
          settledIndicatorIntentRef.current === intentId
        ) {
          return false;
        }
        settledIndicatorIntentRef.current = intentId;
        return true;
      };
      const retryNullIndicatorError = () => {
        if (indicatorNullErrorRetryCountRef.current >= 1) return false;
        indicatorNullErrorRetryCountRef.current += 1;
        appliedIndicatorFingerprintRef.current = '';
        setIndicatorRetryEpoch(epoch => epoch + 1);
        return true;
      };
      if (message.type === 'INTERVAL_COMMITTED') {
        intervalChangeRef.current(message.interval);
        return;
      }
      if (message.type === 'INDICATORS_COMMITTED') {
        if (!settleCurrentIndicatorIntent('v1', message.intentId)) return;
        appliedIndicatorFingerprintRef.current = `v1:${JSON.stringify(
          message.indicators,
        )}`;
        indicatorNullErrorRetryCountRef.current = 0;
        indicatorsCommittedRef.current?.(message.indicators);
        return;
      }
      if (message.type === 'INDICATORS_ERROR') {
        if (!settleCurrentIndicatorIntent('v1', message.intentId)) return;
        let retryScheduled = false;
        if (message.indicators) {
          appliedIndicatorFingerprintRef.current = `v1:${JSON.stringify(
            message.indicators,
          )}`;
          indicatorNullErrorRetryCountRef.current = 0;
        } else {
          retryScheduled = retryNullIndicatorError();
        }
        indicatorsErrorRef.current?.(message.message, message.indicators);
        if (!message.indicators && !retryScheduled) fail('chart_error');
        return;
      }
      if (message.type === 'INDICATOR_CONFIG_COMMITTED') {
        if (!settleCurrentIndicatorIntent('v2', message.intentId)) return;
        appliedIndicatorFingerprintRef.current = `v2:${JSON.stringify(
          message.config,
        )}`;
        indicatorNullErrorRetryCountRef.current = 0;
        configCommittedRef.current?.(message.config);
        return;
      }
      if (!settleCurrentIndicatorIntent('v2', message.intentId)) return;
      let retryScheduled = false;
      if (message.config) {
        appliedIndicatorFingerprintRef.current = `v2:${JSON.stringify(
          message.config,
        )}`;
        indicatorNullErrorRetryCountRef.current = 0;
      } else {
        retryScheduled = retryNullIndicatorError();
      }
      configErrorRef.current?.(message.message, message.config);
      if (!message.config && !retryScheduled) fail('chart_error');
    },
    [clearReadyTimeout, fail, logBenchmarkMark, request],
  );

  if (!request) {
    return <View style={styles.container} testID="advanced-chart-invalid" />;
  }

  return (
    <View style={styles.container} testID="advanced-chart-container">
      <WebView
        ref={webViewRef}
        testID="advanced-chart-webview"
        style={styles.webview}
        source={{uri: request.url}}
        originWhitelist={[request.origin]}
        javaScriptEnabled
        domStorageEnabled
        cacheEnabled
        cacheMode="LOAD_DEFAULT"
        injectedJavaScriptBeforeContentLoaded={
          IS_BENCHMARK_BUILD
            ? buildAdvancedChartBenchmarkProbeScript(request.sessionId)
            : undefined
        }
        webviewDebuggingEnabled={__DEV__}
        mixedContentMode="never"
        allowFileAccess={false}
        allowFileAccessFromFileURLs={false}
        allowUniversalAccessFromFileURLs={false}
        thirdPartyCookiesEnabled={false}
        sharedCookiesEnabled={false}
        javaScriptCanOpenWindowsAutomatically={false}
        setSupportMultipleWindows={false}
        onMessage={handleMessage}
        onLoadStart={event => {
          if (failedRef.current) return;
          logBenchmarkMark('NATIVE_LOAD_START');
          armLoadStallTimeout();
          const navigationUrl = event.nativeEvent.url ?? request.url;
          if (readyRef.current) {
            if (
              navigationUrl === 'about:blank' ||
              !isAllowedAdvancedChartTopNavigation(
                navigationUrl,
                request.url,
              )
            ) {
              fail('navigation_blocked');
              return;
            }
            const reloadRequest = createReloadChartRequest(request);
            if (!reloadRequest) {
              fail('chart_error');
              return;
            }
            previousRequestUrlRef.current = request.url;
            activeSessionIdRef.current = reloadRequest.sessionId;
            readyRef.current = false;
            indicatorIntentRef.current = 0;
            latestIndicatorIntentRef.current = 0;
            latestIndicatorProtocolRef.current = 'v1';
            settledIndicatorIntentRef.current = 0;
            appliedIndicatorFingerprintRef.current = '';
            indicatorNullErrorRetryCountRef.current = 0;
            setReady(false);
            setSupportsIndicatorConfigV2(false);
            configCapabilityRef.current?.(false);
            clearReadyTimeout();
            setRequest(reloadRequest);
          }
          setDocumentLoaded(false);
        }}
        onLoadProgress={() => {
          if (failedRef.current || readyRef.current) return;
          armLoadStallTimeout();
        }}
        onLoadEnd={() => {
          if (failedRef.current) return;
          logBenchmarkMark('NATIVE_LOAD_END');
          setDocumentLoaded(true);
          if (!readyRef.current) armReadyTimeout();
        }}
        onError={() => fail('load_error')}
        onHttpError={() => fail('http_error')}
        onRenderProcessGone={() => fail('renderer_terminated')}
        onContentProcessDidTerminate={() => fail('renderer_terminated')}
        onNavigationStateChange={navigation => {
          const previousRequestUrl = previousRequestUrlRef.current;
          const allowed =
            (!readyRef.current && navigation.url === 'about:blank') ||
            (navigation.url !== 'about:blank' &&
              (isAllowedAdvancedChartTopNavigation(
                navigation.url,
                request.url,
              ) ||
                (previousRequestUrl !== null &&
                  isAllowedAdvancedChartTopNavigation(
                    navigation.url,
                    previousRequestUrl,
                  ))));
          if (!allowed) {
            fail('navigation_blocked');
          }
        }}
        onShouldStartLoadWithRequest={navigation => {
          const previousRequestUrl = previousRequestUrlRef.current;
          const allowed = navigation.isTopFrame
            ? (!readyRef.current && navigation.url === 'about:blank') ||
              (navigation.url !== 'about:blank' &&
                (isAllowedAdvancedChartTopNavigation(
                  navigation.url,
                  request.url,
                ) ||
                  (previousRequestUrl !== null &&
                    isAllowedAdvancedChartTopNavigation(
                      navigation.url,
                      previousRequestUrl,
                    ))))
            : isAllowedAdvancedChartNavigation(
                navigation.url,
                request.origin,
              );
          if (!allowed) fail('navigation_blocked');
          return allowed;
        }}
      />
      {!ready && !documentLoaded ? (
        <View
          pointerEvents="none"
          style={styles.loading}
          testID="advanced-chart-loading">
          <Text style={styles.loadingText}>{t('kline.advancedLoading')}</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    minHeight: 0,
    backgroundColor: colors.bg,
  },
  webview: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  loading: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bg,
  },
  loadingText: {
    ...typography.bold,
    color: colors.textMuted,
    fontSize: 13,
  },
});
