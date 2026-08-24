import React from 'react';
import ReactTestRenderer, {act} from 'react-test-renderer';
import AsyncStorage from '@react-native-async-storage/async-storage';

const mockWebViewProps: {current: Record<string, any> | null} = {
  current: null,
};
const mockInjectedScripts: string[] = [];
const mockBenchmarkPerfReports: string[] = [];

jest.mock('../src/config/env', () => ({
  CHART_WEB_BASE_URL: 'http://127.0.0.1:3000',
  IS_BENCHMARK_BUILD: true,
  reportBenchmarkChartPerf: (payload: string) => {
    mockBenchmarkPerfReports.push(payload);
  },
}));

jest.mock('react-native-webview', () => {
  const ReactModule = require('react');
  const MockWebView = ReactModule.forwardRef(
    (props: Record<string, any>, ref: React.Ref<unknown>) => {
      mockWebViewProps.current = props;
      ReactModule.useImperativeHandle(ref, () => ({
        injectJavaScript: (script: string) => mockInjectedScripts.push(script),
      }));
      return ReactModule.createElement('WebView', props);
    },
  );
  return {
    __esModule: true,
    default: MockWebView,
    WebView: MockWebView,
  };
});

import AdvancedKlineWebView, {
  ADVANCED_CHART_LOAD_STALL_TIMEOUT_MS,
  ADVANCED_CHART_READY_TIMEOUT_MS,
} from '../src/components/chart/AdvancedKlineWebView';
import {useAdvancedChartPreferences} from '../src/components/chart/useAdvancedChartPreferences';

let integratedPreferences: ReturnType<
  typeof useAdvancedChartPreferences
> | null = null;

function IntegratedPreferencesChart({onFallback}: {onFallback: jest.Mock}) {
  const preferences = useAdvancedChartPreferences();
  integratedPreferences = preferences;
  return (
    <AdvancedKlineWebView
      config={preferences.config}
      indicators={preferences.selection}
      interval="1m"
      market="spot"
      preferencesHydrated={preferences.hydrated}
      symbol="BTCUSDT"
      onFallback={onFallback}
      onIndicatorConfigCommitted={preferences.commitConfig}
      onIndicatorConfigError={(_, actual) =>
        preferences.handleConfigError(actual)
      }
      onIndicatorsCommitted={preferences.commitSelection}
      onIndicatorsError={(_, actual) =>
        preferences.handleSelectionError(actual)
      }
      onIntervalChange={jest.fn()}
    />
  );
}

function renderAdvancedChart({
  onFallback = jest.fn(),
  onIndicatorsCommitted = jest.fn(),
  onIndicatorsError = jest.fn(),
  onIndicatorConfigCapabilityChange = jest.fn(),
  onIndicatorConfigCommitted = jest.fn(),
  onIndicatorConfigError = jest.fn(),
  onIntervalChange = jest.fn(),
  onReady = jest.fn(),
}: {
  onFallback?: jest.Mock;
  onIndicatorsCommitted?: jest.Mock;
  onIndicatorsError?: jest.Mock;
  onIndicatorConfigCapabilityChange?: jest.Mock;
  onIndicatorConfigCommitted?: jest.Mock;
  onIndicatorConfigError?: jest.Mock;
  onIntervalChange?: jest.Mock;
  onReady?: jest.Mock;
} = {}) {
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  act(() => {
    renderer = ReactTestRenderer.create(
      <AdvancedKlineWebView
        config={{
          protocolVersion: 2,
          overlay: {kind: 'MA', params: {length: 9}},
          pane: {kind: 'VOL', params: {showMA: false, maLength: 20}},
        }}
        indicators={{overlay: 'MA', pane: 'VOL'}}
        interval="1m"
        market="spot"
        preferencesHydrated
        symbol="BTCUSDT"
        onFallback={onFallback}
        onIndicatorsCommitted={onIndicatorsCommitted}
        onIndicatorsError={onIndicatorsError}
        onIndicatorConfigCapabilityChange={
          onIndicatorConfigCapabilityChange
        }
        onIndicatorConfigCommitted={onIndicatorConfigCommitted}
        onIndicatorConfigError={onIndicatorConfigError}
        onIntervalChange={onIntervalChange}
        onReady={onReady}
      />,
    );
  });
  return {
    renderer,
    onFallback,
    onIndicatorsCommitted,
    onIndicatorsError,
    onIndicatorConfigCapabilityChange,
    onIndicatorConfigCommitted,
    onIndicatorConfigError,
    onIntervalChange,
    onReady,
  };
}

function currentSession() {
  const uri = String(mockWebViewProps.current?.source?.uri);
  return {
    uri,
    origin: new URL(uri).origin,
    sessionId: new URL(uri).searchParams.get('sessionId')!,
  };
}

function postMessage(value: Record<string, unknown>) {
  act(() => {
    mockWebViewProps.current?.onMessage({
      nativeEvent: {data: JSON.stringify(value)},
    });
  });
}

describe('AdvancedKlineWebView', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(10_000);
    integratedPreferences = null;
    mockWebViewProps.current = null;
    mockInjectedScripts.length = 0;
    mockBenchmarkPerfReports.length = 0;
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('freezes one URL/session per mount and commits interval only after READY', () => {
    const {renderer, onFallback, onIntervalChange, onReady} = renderAdvancedChart();
    const initial = currentSession();
    const initialUrl = new URL(initial.uri);
    expect(initialUrl.pathname).toBe('/mobile/advanced-chart');
    expect(initialUrl.searchParams.get('symbol')).toBe('BTCUSDT');
    expect(initialUrl.searchParams.get('interval')).toBe('1m');
    expect(mockWebViewProps.current?.originWhitelist).toEqual([initial.origin]);
    expect(mockWebViewProps.current?.cacheEnabled).toBe(true);
    expect(mockWebViewProps.current?.cacheMode).toBe('LOAD_DEFAULT');
    expect(
      mockWebViewProps.current?.injectedJavaScriptBeforeContentLoaded,
    ).toContain(initial.sessionId);

    postMessage({
      type: 'INTERVAL_COMMITTED',
      sessionId: initial.sessionId,
      interval: '5m',
    });
    expect(onIntervalChange).not.toHaveBeenCalled();

    postMessage({type: 'CHART_READY', sessionId: initial.sessionId});
    expect(onReady).toHaveBeenCalledTimes(1);
    postMessage({
      type: 'INTERVAL_COMMITTED',
      sessionId: initial.sessionId,
      interval: '5m',
    });
    expect(onIntervalChange).toHaveBeenCalledWith('5m');

    act(() => {
      renderer.update(
        <AdvancedKlineWebView
          config={{
            protocolVersion: 2,
            overlay: {kind: 'MA', params: {length: 9}},
            pane: {kind: 'VOL', params: {showMA: false, maLength: 20}},
          }}
          indicators={{overlay: 'MA', pane: 'VOL'}}
          interval="5m"
          market="spot"
          preferencesHydrated
          symbol="BTCUSDT"
          onFallback={onFallback}
          onIntervalChange={onIntervalChange}
        />,
      );
    });
    expect(currentSession()).toEqual(initial);
    act(() => renderer.unmount());
  });

  it('records native and Web milestones only through the Benchmark bridge', () => {
    const {renderer, onReady} = renderAdvancedChart();
    const initial = currentSession();

    act(() => {
      mockWebViewProps.current?.onLoadStart({
        nativeEvent: {url: initial.uri},
      });
      mockWebViewProps.current?.onLoadEnd({nativeEvent: {}});
    });
    postMessage({
      type: 'PERF_MARK',
      sessionId: initial.sessionId,
      mark: 'WEB_DATA_READY',
      elapsedMs: 812.4,
    });
    postMessage({type: 'CHART_READY', sessionId: initial.sessionId});

    const reports = mockBenchmarkPerfReports.map(value => JSON.parse(value));
    expect(reports.map(value => value.mark)).toEqual(
      expect.arrayContaining([
        'NATIVE_COMPONENT_MOUNTED',
        'NATIVE_LOAD_START',
        'NATIVE_LOAD_END',
        'WEB_DATA_READY',
        'NATIVE_CHART_READY',
      ]),
    );
    expect(
      reports.find(value => value.mark === 'WEB_DATA_READY'),
    ).toEqual(
      expect.objectContaining({
        sessionId: initial.sessionId,
        market: 'spot',
        symbol: 'BTCUSDT',
        webElapsedMs: 812.4,
      }),
    );
    expect(onReady).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });

  it('sends grouped indicator state after READY and toggles without reloading', () => {
    const {renderer, onFallback, onIntervalChange} = renderAdvancedChart();
    const initial = currentSession();

    expect(mockInjectedScripts).toHaveLength(0);
    postMessage({type: 'CHART_READY', sessionId: initial.sessionId});
    expect(mockInjectedScripts).toHaveLength(1);
    expect(mockInjectedScripts[0]).toContain(
      `window.postMessage({"type":"mobile-chart-command","sessionId":"${initial.sessionId}","intentId":1,"command":"set-indicators","indicators":{"overlay":"MA","pane":"VOL"}}, window.location.origin)`,
    );

    act(() => {
      renderer.update(
        <AdvancedKlineWebView
          config={{
            protocolVersion: 2,
            overlay: {kind: 'BOLL', params: {length: 20, multiplier: 2}},
            pane: {
              kind: 'MACD',
              params: {fastLength: 12, slowLength: 26, signalLength: 9},
            },
          }}
          indicators={{overlay: 'BOLL', pane: 'MACD'}}
          interval="1m"
          market="spot"
          preferencesHydrated
          symbol="BTCUSDT"
          onFallback={onFallback}
          onIntervalChange={onIntervalChange}
        />,
      );
    });
    expect(mockInjectedScripts).toHaveLength(2);
    expect(mockInjectedScripts[1]).toContain(
      '"intentId":2,"command":"set-indicators","indicators":{"overlay":"BOLL","pane":"MACD"}',
    );
    expect(currentSession()).toEqual(initial);
    act(() => renderer.unmount());
  });

  it('waits for hydration, negotiates v2 and ignores unrelated rerenders', () => {
    const stableConfig = {
      protocolVersion: 2 as const,
      overlay: {kind: 'BOLL' as const, params: {length: 20, multiplier: 2}},
      pane: {kind: 'RSI' as const, params: {length: 14}},
    };
    const stableIndicators = {overlay: 'BOLL' as const, pane: 'RSI' as const};
    const onCapability = jest.fn();
    const onConfigCommitted = jest.fn();
    const onConfigError = jest.fn();
    const onFallback = jest.fn();
    const onIntervalChange = jest.fn();
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(
        <AdvancedKlineWebView
          config={stableConfig}
          indicators={stableIndicators}
          interval="1m"
          market="spot"
          preferencesHydrated={false}
          symbol="BTCUSDT"
          onFallback={onFallback}
          onIndicatorConfigCapabilityChange={onCapability}
          onIndicatorConfigCommitted={onConfigCommitted}
          onIndicatorConfigError={onConfigError}
          onIntervalChange={onIntervalChange}
        />,
      );
    });
    const initial = currentSession();
    postMessage({
      type: 'CHART_READY',
      sessionId: initial.sessionId,
      capabilities: ['indicator-config-v2'],
    });
    expect(onCapability).toHaveBeenCalledWith(true);
    expect(mockInjectedScripts).toHaveLength(0);

    act(() => {
      renderer.update(
        <AdvancedKlineWebView
          config={stableConfig}
          indicators={stableIndicators}
          interval="1m"
          market="spot"
          preferencesHydrated
          symbol="BTCUSDT"
          onFallback={onFallback}
          onIndicatorConfigCapabilityChange={onCapability}
          onIndicatorConfigCommitted={onConfigCommitted}
          onIndicatorConfigError={onConfigError}
          onIntervalChange={onIntervalChange}
        />,
      );
    });
    expect(mockInjectedScripts).toHaveLength(1);
    expect(mockInjectedScripts[0]).toContain(
      '"command":"set-indicator-config-v2","config":{"protocolVersion":2',
    );
    expect(mockInjectedScripts[0]).toContain('"intentId":1');

    act(() => {
      renderer.update(
        <AdvancedKlineWebView
          config={stableConfig}
          indicators={stableIndicators}
          interval="1m"
          market="spot"
          preferencesHydrated
          symbol="BTCUSDT"
          onFallback={jest.fn()}
          onIndicatorConfigCapabilityChange={jest.fn()}
          onIndicatorConfigCommitted={onConfigCommitted}
          onIndicatorConfigError={onConfigError}
          onIntervalChange={jest.fn()}
        />,
      );
    });
    expect(mockInjectedScripts).toHaveLength(1);
    expect(currentSession()).toEqual(initial);

    postMessage({
      type: 'INDICATOR_CONFIG_COMMITTED',
      sessionId: initial.sessionId,
      intentId: 1,
      config: stableConfig,
    });
    expect(onConfigCommitted).toHaveBeenCalledWith(stableConfig);
    act(() => {
      renderer.update(
        <AdvancedKlineWebView
          config={{
            protocolVersion: 2,
            overlay: {kind: 'BOLL', params: {length: 20, multiplier: 2}},
            pane: {kind: 'RSI', params: {length: 14}},
          }}
          indicators={{overlay: 'BOLL', pane: 'RSI'}}
          interval="1m"
          market="spot"
          preferencesHydrated
          symbol="BTCUSDT"
          onFallback={onFallback}
          onIndicatorConfigCapabilityChange={onCapability}
          onIndicatorConfigCommitted={onConfigCommitted}
          onIndicatorConfigError={onConfigError}
          onIntervalChange={onIntervalChange}
        />,
      );
    });
    expect(mockInjectedScripts).toHaveLength(1);

    const changedConfig = {
      ...stableConfig,
      overlay: {kind: 'BOLL' as const, params: {length: 21, multiplier: 2}},
    };
    act(() => {
      renderer.update(
        <AdvancedKlineWebView
          config={changedConfig}
          indicators={stableIndicators}
          interval="1m"
          market="spot"
          preferencesHydrated
          symbol="BTCUSDT"
          onFallback={onFallback}
          onIndicatorConfigCapabilityChange={onCapability}
          onIndicatorConfigCommitted={onConfigCommitted}
          onIndicatorConfigError={onConfigError}
          onIntervalChange={onIntervalChange}
        />,
      );
    });
    expect(mockInjectedScripts).toHaveLength(2);
    expect(mockInjectedScripts[1]).toContain('"intentId":2');
    postMessage({
      type: 'INDICATOR_CONFIG_COMMITTED',
      sessionId: initial.sessionId,
      intentId: 2,
      config: changedConfig,
    });
    act(() => {
      renderer.update(
        <AdvancedKlineWebView
          config={{...changedConfig, overlay: {...changedConfig.overlay, params: {...changedConfig.overlay.params}}}}
          indicators={{...stableIndicators}}
          interval="1m"
          market="spot"
          preferencesHydrated
          symbol="BTCUSDT"
          onFallback={onFallback}
          onIndicatorConfigCapabilityChange={onCapability}
          onIndicatorConfigCommitted={onConfigCommitted}
          onIndicatorConfigError={onConfigError}
          onIntervalChange={onIntervalChange}
        />,
      );
    });
    expect(mockInjectedScripts).toHaveLength(2);
    postMessage({
      type: 'INDICATOR_CONFIG_ERROR',
      sessionId: initial.sessionId,
      intentId: 2,
      message: '参数应用失败',
      config: null,
    });
    expect(onConfigError).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('settles each v2 intent once when an error arrives before a commit', () => {
    const result = renderAdvancedChart();
    const sessionId = currentSession().sessionId;
    const actual = {
      protocolVersion: 2,
      overlay: {kind: 'MA', params: {length: 9}},
      pane: {kind: 'VOL', params: {showMA: false, maLength: 20}},
    };
    postMessage({
      type: 'CHART_READY',
      sessionId,
      capabilities: ['indicator-config-v2'],
    });
    postMessage({
      type: 'INDICATOR_CONFIG_ERROR',
      sessionId,
      intentId: 1,
      message: '参数已回退',
      config: actual,
    });
    expect(result.onIndicatorConfigError).toHaveBeenCalledTimes(1);

    postMessage({
      type: 'INDICATOR_CONFIG_COMMITTED',
      sessionId,
      intentId: 1,
      config: actual,
    });
    expect(result.onIndicatorConfigCommitted).not.toHaveBeenCalled();
    act(() => result.renderer.unmount());
  });

  it('retries the first null config error once and fails closed on the second', () => {
    const result = renderAdvancedChart();
    const sessionId = currentSession().sessionId;
    postMessage({
      type: 'CHART_READY',
      sessionId,
      capabilities: ['indicator-config-v2'],
    });
    expect(mockInjectedScripts).toHaveLength(1);
    expect(mockInjectedScripts[0]).toContain('"intentId":1');

    postMessage({
      type: 'INDICATOR_CONFIG_ERROR',
      sessionId,
      intentId: 1,
      message: '图表状态未知',
      config: null,
    });
    expect(result.onIndicatorConfigError).toHaveBeenCalledTimes(1);
    expect(result.onFallback).not.toHaveBeenCalled();
    expect(mockInjectedScripts).toHaveLength(2);
    expect(mockInjectedScripts[1]).toContain('"intentId":2');

    postMessage({
      type: 'INDICATOR_CONFIG_ERROR',
      sessionId,
      intentId: 2,
      message: '重试后状态仍未知',
      config: null,
    });
    expect(result.onIndicatorConfigError).toHaveBeenCalledTimes(2);
    expect(result.onFallback).toHaveBeenCalledTimes(1);
    expect(result.onFallback).toHaveBeenCalledWith('chart_error');
    expect(mockInjectedScripts).toHaveLength(2);

    postMessage({
      type: 'INDICATOR_CONFIG_COMMITTED',
      sessionId,
      intentId: 2,
      config: {
        protocolVersion: 2,
        overlay: {kind: 'MA', params: {length: 9}},
        pane: {kind: 'VOL', params: {showMA: false, maLength: 20}},
      },
    });
    expect(result.onIndicatorConfigCommitted).not.toHaveBeenCalled();
    expect(mockInjectedScripts).toHaveLength(2);
    act(() => result.renderer.unmount());
  });

  it('shares one null-error retry budget across a real hook B-to-A rollback chain', async () => {
    await AsyncStorage.clear();
    const onFallback = jest.fn();
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(
        <IntegratedPreferencesChart onFallback={onFallback} />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(integratedPreferences!.hydrated).toBe(true);
    const sessionId = currentSession().sessionId;
    const configA = integratedPreferences!.config;
    postMessage({
      type: 'CHART_READY',
      sessionId,
      capabilities: ['indicator-config-v2'],
    });
    postMessage({
      type: 'INDICATOR_CONFIG_COMMITTED',
      sessionId,
      intentId: 1,
      config: configA,
    });

    const configB = {
      protocolVersion: 2 as const,
      overlay: {kind: 'BOLL' as const, params: {length: 24, multiplier: 2}},
      pane: {kind: 'RSI' as const, params: {length: 12}},
    };
    act(() => integratedPreferences!.applyConfig(configB));
    expect(mockInjectedScripts).toHaveLength(2);
    expect(mockInjectedScripts[1]).toContain('"intentId":2');
    expect(mockInjectedScripts[1]).toContain('"kind":"BOLL"');

    postMessage({
      type: 'INDICATOR_CONFIG_ERROR',
      sessionId,
      intentId: 2,
      message: 'B 状态未知',
      config: null,
    });
    expect(integratedPreferences!.config).toEqual(configA);
    expect(onFallback).not.toHaveBeenCalled();
    expect(mockInjectedScripts).toHaveLength(3);
    expect(mockInjectedScripts[2]).toContain('"intentId":3');
    expect(mockInjectedScripts[2]).toContain('"kind":"MA"');

    postMessage({
      type: 'INDICATOR_CONFIG_ERROR',
      sessionId,
      intentId: 3,
      message: 'A 补偿后仍未知',
      config: null,
    });
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(onFallback).toHaveBeenCalledWith('chart_error');
    expect(mockInjectedScripts).toHaveLength(3);
    act(() => renderer.unmount());
  });

  it('consumes only current-session indicator committed/error receipts after READY', () => {
    const result = renderAdvancedChart();
    const sessionId = currentSession().sessionId;
    postMessage({
      type: 'INDICATORS_COMMITTED',
      sessionId,
      intentId: 1,
      indicators: {overlay: 'EMA', pane: 'MACD'},
    });
    expect(result.onIndicatorsCommitted).not.toHaveBeenCalled();

    postMessage({type: 'CHART_READY', sessionId});
    postMessage({
      type: 'INDICATORS_COMMITTED',
      sessionId: 'old-session',
      intentId: 1,
      indicators: {overlay: 'BOLL', pane: 'RSI'},
    });
    postMessage({
      type: 'INDICATORS_COMMITTED',
      sessionId,
      intentId: 1,
      indicators: {overlay: 'EMA', pane: 'MACD'},
    });
    expect(result.onIndicatorsCommitted).toHaveBeenCalledTimes(1);
    expect(result.onIndicatorsCommitted).toHaveBeenCalledWith({
      overlay: 'EMA',
      pane: 'MACD',
    });

    postMessage({
      type: 'INDICATORS_ERROR',
      sessionId,
      intentId: 1,
      message: '技术指标切换失败',
      indicators: null,
    });
    expect(result.onIndicatorsError).not.toHaveBeenCalled();
    act(() => result.renderer.unmount());
  });

  it('ignores stale committed and late error receipts after a newer intent', () => {
    const result = renderAdvancedChart();
    const sessionId = currentSession().sessionId;
    postMessage({type: 'CHART_READY', sessionId});

    act(() => {
      result.renderer.update(
        <AdvancedKlineWebView
          config={{
            protocolVersion: 2,
            overlay: {kind: 'BOLL', params: {length: 20, multiplier: 2}},
            pane: {kind: 'RSI', params: {length: 14}},
          }}
          indicators={{overlay: 'BOLL', pane: 'RSI'}}
          interval="1m"
          market="spot"
          preferencesHydrated
          symbol="BTCUSDT"
          onFallback={result.onFallback}
          onIndicatorsCommitted={result.onIndicatorsCommitted}
          onIndicatorsError={result.onIndicatorsError}
          onIntervalChange={result.onIntervalChange}
        />,
      );
    });
    expect(mockInjectedScripts[1]).toContain('"intentId":2');

    postMessage({
      type: 'INDICATORS_COMMITTED',
      sessionId,
      intentId: 1,
      indicators: {overlay: 'MA', pane: 'VOL'},
    });
    postMessage({
      type: 'INDICATORS_ERROR',
      sessionId,
      intentId: 1,
      message: '晚到错误',
      indicators: {overlay: 'MA', pane: 'VOL'},
    });
    expect(result.onIndicatorsCommitted).not.toHaveBeenCalled();
    expect(result.onIndicatorsError).not.toHaveBeenCalled();

    postMessage({
      type: 'INDICATORS_COMMITTED',
      sessionId,
      intentId: 2,
      indicators: {overlay: 'BOLL', pane: 'RSI'},
    });
    expect(result.onIndicatorsCommitted).toHaveBeenCalledWith({
      overlay: 'BOLL',
      pane: 'RSI',
    });
    act(() => result.renderer.unmount());
  });

  it('reveals the real Web loading shell after document load without declaring chart ready', () => {
    const {renderer, onFallback, onReady} = renderAdvancedChart();
    expect(
      renderer.root.findAll(node => node.props.testID === 'advanced-chart-loading').length,
    ).toBeGreaterThan(0);

    act(() => {
      mockWebViewProps.current?.onLoadEnd({nativeEvent: {}});
    });
    expect(
      renderer.root.findAll(node => node.props.testID === 'advanced-chart-loading'),
    ).toHaveLength(0);
    expect(onReady).not.toHaveBeenCalled();

    act(() => jest.advanceTimersByTime(ADVANCED_CHART_READY_TIMEOUT_MS));
    expect(onFallback).toHaveBeenCalledWith('ready_timeout');
    act(() => renderer.unmount());
  });

  it('does not spend the chart-ready budget while the document is still loading', () => {
    const {renderer, onFallback} = renderAdvancedChart();

    act(() => jest.advanceTimersByTime(ADVANCED_CHART_READY_TIMEOUT_MS));
    expect(onFallback).not.toHaveBeenCalled();

    act(() => {
      mockWebViewProps.current?.onLoadProgress({nativeEvent: {progress: 0.5}});
      jest.advanceTimersByTime(ADVANCED_CHART_LOAD_STALL_TIMEOUT_MS - 1);
    });
    expect(onFallback).not.toHaveBeenCalled();

    act(() => jest.advanceTimersByTime(1));
    expect(onFallback).toHaveBeenCalledWith('ready_timeout');
    act(() => renderer.unmount());
  });

  it('keeps the timeout armed for a wrong session but clears it for READY', () => {
    const first = renderAdvancedChart();
    const firstSession = currentSession().sessionId;
    act(() => {
      mockWebViewProps.current?.onLoadEnd({nativeEvent: {}});
    });
    postMessage({type: 'CHART_READY', sessionId: `${firstSession}-old`});
    act(() => jest.advanceTimersByTime(ADVANCED_CHART_READY_TIMEOUT_MS));
    expect(first.onFallback).toHaveBeenCalledWith('ready_timeout');
    act(() => first.renderer.unmount());

    const second = renderAdvancedChart();
    postMessage({
      type: 'CHART_READY',
      sessionId: currentSession().sessionId,
    });
    act(() => jest.advanceTimersByTime(ADVANCED_CHART_READY_TIMEOUT_MS));
    expect(second.onFallback).not.toHaveBeenCalled();
    act(() => second.renderer.unmount());
  });

  it('resets a reloaded document and replays only after its new READY', () => {
    const result = renderAdvancedChart();
    const initial = currentSession();
    postMessage({type: 'CHART_READY', sessionId: initial.sessionId});
    expect(mockInjectedScripts).toHaveLength(1);
    expect(mockInjectedScripts[0]).toContain('"command":"set-indicators"');

    act(() => {
      mockWebViewProps.current?.onLoadStart({nativeEvent: {url: initial.uri}});
    });
    const reloaded = currentSession();
    expect(reloaded.sessionId).not.toBe(initial.sessionId);
    act(() => {
      mockWebViewProps.current?.onNavigationStateChange({url: initial.uri});
    });
    expect(result.onFallback).not.toHaveBeenCalled();
    expect(result.onIndicatorConfigCapabilityChange).toHaveBeenLastCalledWith(
      false,
    );
    expect(mockInjectedScripts).toHaveLength(1);

    postMessage({
      type: 'INDICATORS_COMMITTED',
      sessionId: initial.sessionId,
      intentId: 1,
      indicators: {overlay: 'MA', pane: 'VOL'},
    });
    expect(result.onIndicatorsCommitted).not.toHaveBeenCalled();

    postMessage({type: 'CHART_READY', sessionId: initial.sessionId});
    postMessage({
      type: 'CHART_ERROR',
      sessionId: initial.sessionId,
      message: '旧文档迟到错误',
    });
    expect(result.onReady).toHaveBeenCalledTimes(1);
    expect(result.onFallback).not.toHaveBeenCalled();
    expect(mockInjectedScripts).toHaveLength(1);

    postMessage({
      type: 'CHART_READY',
      sessionId: reloaded.sessionId,
      capabilities: ['indicator-config-v2'],
    });
    expect(result.onReady).toHaveBeenCalledTimes(2);
    expect(result.onIndicatorConfigCapabilityChange).toHaveBeenLastCalledWith(
      true,
    );
    expect(mockInjectedScripts).toHaveLength(2);
    expect(mockInjectedScripts[1]).toContain(
      `"sessionId":"${reloaded.sessionId}"`,
    );
    expect(mockInjectedScripts[1]).toContain('"intentId":1');
    expect(mockInjectedScripts[1]).toContain(
      '"command":"set-indicator-config-v2"',
    );
    act(() => result.renderer.unmount());
  });

  it('re-arms READY timeout on reload and blocks about:blank after READY', () => {
    const timedOut = renderAdvancedChart();
    const first = currentSession();
    postMessage({type: 'CHART_READY', sessionId: first.sessionId});
    act(() => {
      mockWebViewProps.current?.onLoadStart({
        nativeEvent: {url: first.uri},
      });
    });
    act(() => {
      mockWebViewProps.current?.onLoadEnd({nativeEvent: {}});
    });
    act(() => {
      jest.advanceTimersByTime(ADVANCED_CHART_READY_TIMEOUT_MS);
    });
    expect(timedOut.onFallback).toHaveBeenCalledWith('ready_timeout');
    act(() => timedOut.renderer.unmount());

    const blocked = renderAdvancedChart();
    postMessage({
      type: 'CHART_READY',
      sessionId: currentSession().sessionId,
    });
    expect(
      mockWebViewProps.current?.onShouldStartLoadWithRequest({
        url: 'about:blank',
        isTopFrame: true,
      }),
    ).toBe(false);
    expect(blocked.onFallback).toHaveBeenCalledWith('navigation_blocked');
    act(() => blocked.renderer.unmount());
  });

  it('blocks lookalike origins and falls back only once across failures', () => {
    const {renderer, onFallback} = renderAdvancedChart();
    const {origin} = currentSession();
    expect(
      mockWebViewProps.current?.onShouldStartLoadWithRequest({
        url: currentSession().uri,
        isTopFrame: true,
      }),
    ).toBe(true);
    expect(
      mockWebViewProps.current?.onShouldStartLoadWithRequest({
        url: `${origin}/charting_library/static/tv-chart.html`,
        isTopFrame: false,
      }),
    ).toBe(true);
    expect(
      mockWebViewProps.current?.onShouldStartLoadWithRequest({
        url: `${origin.replace('127.0.0.1', '127.0.0.1.evil.test')}/steal`,
        isTopFrame: false,
      }),
    ).toBe(false);
    act(() => {
      mockWebViewProps.current?.onHttpError({nativeEvent: {statusCode: 503}});
      mockWebViewProps.current?.onRenderProcessGone({
        nativeEvent: {didCrash: false},
      });
    });
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(onFallback).toHaveBeenCalledWith('navigation_blocked');
    act(() => renderer.unmount());
  });

  it('blocks a same-origin top-level path change while allowing same-origin subframes', () => {
    const {renderer, onFallback} = renderAdvancedChart();
    const {origin} = currentSession();
    expect(
      mockWebViewProps.current?.onShouldStartLoadWithRequest({
        url: `${origin}/mobile/advanced-chart/other`,
        isTopFrame: true,
      }),
    ).toBe(false);
    expect(onFallback).toHaveBeenCalledWith('navigation_blocked');
    act(() => renderer.unmount());
  });

  it('treats navigation-state changes as strict top-level navigation', () => {
    const {renderer, onFallback} = renderAdvancedChart();
    const {origin} = currentSession();
    act(() => {
      mockWebViewProps.current?.onNavigationStateChange({
        url: `${origin}/account`,
      });
    });
    expect(onFallback).toHaveBeenCalledWith('navigation_blocked');
    act(() => renderer.unmount());
  });

  it('falls back for a matching-session CHART_ERROR bridge event', () => {
    const {renderer, onFallback} = renderAdvancedChart();
    postMessage({
      type: 'CHART_ERROR',
      sessionId: currentSession().sessionId,
      message: 'widget failed',
    });
    expect(onFallback).toHaveBeenCalledWith('chart_error');
    act(() => renderer.unmount());
  });

  it.each([
    ['load_error', 'onError'],
    ['http_error', 'onHttpError'],
    ['renderer_terminated', 'onRenderProcessGone'],
    ['renderer_terminated', 'onContentProcessDidTerminate'],
  ])('falls back on %s', (reason, eventName) => {
    const {renderer, onFallback} = renderAdvancedChart();
    act(() => {
      mockWebViewProps.current?.[eventName]({nativeEvent: {}});
    });
    expect(onFallback).toHaveBeenCalledWith(reason);
    act(() => renderer.unmount());
  });
});
