import {
  ADVANCED_CHART_PATH,
  buildAdvancedChartBenchmarkProbeScript,
  buildAdvancedChartUrl,
  createAdvancedChartSessionId,
  isAllowedAdvancedChartNavigation,
  isAllowedAdvancedChartTopNavigation,
  parseAdvancedChartBridgeMessage,
} from '../src/components/chart/advancedChartUrl';

describe('advanced chart URL and bridge contract', () => {
  it('builds the fixed mobile route with only strict authority params', () => {
    const url = new URL(
      buildAdvancedChartUrl({
        baseUrl: 'https://charts.example.com',
        market: 'contract',
        symbol: 'btcusdt_perp',
        interval: '5m',
        lang: 'zh',
        sessionId: 'session-1234',
        category: 'cfd',
      }),
    );

    expect(url.origin).toBe('https://charts.example.com');
    expect(url.pathname).toBe(ADVANCED_CHART_PATH);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      market: 'contract',
      symbol: 'BTCUSDT_PERP',
      interval: '5m',
      lang: 'zh',
      sessionId: 'session-1234',
      category: 'cfd',
    });
  });

  it('creates bounded per-mount session identifiers', () => {
    const first = createAdvancedChartSessionId(10_000, 0.25);
    const second = createAdvancedChartSessionId(10_000, 0.25);
    expect(first).toMatch(/^[a-z0-9-]{8,96}$/);
    expect(second).not.toBe(first);
  });

  it('builds a session-scoped Benchmark probe without changing the chart URL', () => {
    const script = buildAdvancedChartBenchmarkProbeScript('session-1234');
    expect(script).toContain('session-1234');
    expect(script).toContain('WEB_DOM_CONTENT_LOADED');
    expect(script).toContain('WEB_BOOTSTRAP_REQUEST');
    expect(script).toContain('WEB_SCRIPT_READY');
    expect(script).toContain('WEB_GET_BARS_REQUEST');
    expect(script).toContain('WEB_GET_BARS_HTTP_RESPONSE');
    expect(script).toContain('WEB_GET_BARS_NORMALIZED');
    expect(script).toContain('WEB_GET_BARS_DELIVERED');
    expect(script).toContain('WEB_HISTORY_READY');
    expect(script).toContain('WEB_STUDY_API_READY');
    expect(script).toContain('WEB_DATA_READY');
    expect(script).toContain("type: 'PERF_MARK'");
    expect(() =>
      buildAdvancedChartBenchmarkProbeScript('bad session'),
    ).toThrow('Advanced chart benchmark session is invalid');
  });

  it('keeps symbol validation aligned with the Web route allowlist', () => {
    expect(() =>
      buildAdvancedChartUrl({
        baseUrl: 'https://charts.example.com',
        market: 'spot',
        symbol: 'ETH.USDT',
        interval: '1m',
        lang: 'zh',
        sessionId: 'session-1234',
      }),
    ).toThrow('Advanced chart symbol is invalid');
    expect(() =>
      buildAdvancedChartUrl({
        baseUrl: 'https://charts.example.com',
        market: 'contract',
        symbol: 'BRK.B',
        interval: '1d',
        lang: 'zh',
        sessionId: 'session-1234',
        category: 'stock',
      }),
    ).not.toThrow();
  });

  it('allows only the exact origin and blocks prefix-lookalike navigation', () => {
    const origin = 'https://charts.example.com';
    const unsafeScriptUrl = ['java', 'script:alert(1)'].join('');
    expect(
      isAllowedAdvancedChartNavigation(
        'https://charts.example.com/mobile/advanced-chart',
        origin,
      ),
    ).toBe(true);
    expect(isAllowedAdvancedChartNavigation('about:blank', origin)).toBe(true);
    expect(
      isAllowedAdvancedChartNavigation(
        'https://charts.example.com.evil.test/steal',
        origin,
      ),
    ).toBe(false);
    expect(
      isAllowedAdvancedChartNavigation(
        'https://charts.example.com@evil.test/steal',
        origin,
      ),
    ).toBe(false);
    expect(isAllowedAdvancedChartNavigation(unsafeScriptUrl, origin)).toBe(
      false,
    );
  });

  it('freezes top-level navigation to the exact route and query', () => {
    const expected =
      'https://charts.example.com/mobile/advanced-chart?market=spot&symbol=BTCUSDT&interval=1m&lang=zh&sessionId=session-1234';
    expect(isAllowedAdvancedChartTopNavigation(expected, expected)).toBe(true);
    expect(isAllowedAdvancedChartTopNavigation('about:blank', expected)).toBe(
      true,
    );
    expect(
      isAllowedAdvancedChartTopNavigation(
        expected.replace('/mobile/advanced-chart', '/account'),
        expected,
      ),
    ).toBe(false);
    expect(
      isAllowedAdvancedChartTopNavigation(
        `${expected}&extra=1`,
        expected,
      ),
    ).toBe(false);
    expect(
      isAllowedAdvancedChartTopNavigation(`${expected}#changed`, expected),
    ).toBe(false);
  });

  it('accepts only current-session low-frequency bridge messages', () => {
    const sessionId = 'session-1234';
    expect(
      parseAdvancedChartBridgeMessage(
        JSON.stringify({type: 'CHART_READY', sessionId}),
        sessionId,
      ),
    ).toEqual({type: 'CHART_READY', sessionId, capabilities: []});
    expect(
      parseAdvancedChartBridgeMessage(
        JSON.stringify({
          type: 'INTERVAL_COMMITTED',
          sessionId,
          interval: '4h',
        }),
        sessionId,
      ),
    ).toEqual({type: 'INTERVAL_COMMITTED', sessionId, interval: '4h'});
    expect(
      parseAdvancedChartBridgeMessage(
        JSON.stringify({type: 'CHART_ERROR', sessionId: 'old-session'}),
        sessionId,
      ),
    ).toBeNull();
    expect(
      parseAdvancedChartBridgeMessage(
        JSON.stringify({
          type: 'INTERVAL_COMMITTED',
          sessionId,
          interval: '2m',
        }),
        sessionId,
      ),
    ).toBeNull();
    expect(parseAdvancedChartBridgeMessage('{bad json', sessionId)).toBeNull();
  });

  it('strictly bounds current-session Benchmark performance marks', () => {
    const sessionId = 'session-1234';
    expect(
      parseAdvancedChartBridgeMessage(
        JSON.stringify({
          type: 'PERF_MARK',
          sessionId,
          mark: 'WEB_DATA_READY',
          elapsedMs: 842.6,
        }),
        sessionId,
      ),
    ).toEqual({
      type: 'PERF_MARK',
      sessionId,
      mark: 'WEB_DATA_READY',
      elapsedMs: 842.6,
    });
    for (const invalid of [
      {mark: 'WEB_UNKNOWN', elapsedMs: 1},
      {mark: 'WEB_DATA_READY', elapsedMs: -1},
      {mark: 'WEB_DATA_READY', elapsedMs: 120_001},
      {mark: 'WEB_DATA_READY', elapsedMs: Number.NaN},
    ]) {
      expect(
        parseAdvancedChartBridgeMessage(
          JSON.stringify({type: 'PERF_MARK', sessionId, ...invalid}),
          sessionId,
        ),
      ).toBeNull();
    }
  });

  it('accepts the four bounded Contract getBars Benchmark marks', () => {
    const sessionId = 'session-1234';
    for (const [mark, elapsedMs] of [
      ['WEB_GET_BARS_REQUEST', 1200.1],
      ['WEB_GET_BARS_HTTP_RESPONSE', 1488.4],
      ['WEB_GET_BARS_NORMALIZED', 1491.2],
      ['WEB_GET_BARS_DELIVERED', 1491.5],
    ] as const) {
      expect(
        parseAdvancedChartBridgeMessage(
          JSON.stringify({type: 'PERF_MARK', sessionId, mark, elapsedMs}),
          sessionId,
        ),
      ).toEqual({type: 'PERF_MARK', sessionId, mark, elapsedMs});
    }
  });

  it('strictly parses current-session indicator acknowledgements', () => {
    const sessionId = 'session-1234';
    expect(
      parseAdvancedChartBridgeMessage(
        JSON.stringify({
          type: 'INDICATORS_COMMITTED',
          sessionId,
          intentId: 7,
          indicators: {overlay: 'BOLL', pane: 'RSI'},
        }),
        sessionId,
      ),
    ).toEqual({
      type: 'INDICATORS_COMMITTED',
      sessionId,
      intentId: 7,
      indicators: {overlay: 'BOLL', pane: 'RSI'},
    });
    expect(
      parseAdvancedChartBridgeMessage(
        JSON.stringify({
          type: 'INDICATORS_ERROR',
          sessionId,
          intentId: 8,
          message: '  技术指标切换失败  ',
          indicators: {overlay: 'EMA', pane: 'MACD'},
        }),
        sessionId,
      ),
    ).toEqual({
      type: 'INDICATORS_ERROR',
      sessionId,
      intentId: 8,
      message: '技术指标切换失败',
      indicators: {overlay: 'EMA', pane: 'MACD'},
    });

    for (const invalid of [
      {
        type: 'INDICATORS_COMMITTED',
        sessionId: 'old-session',
        intentId: 1,
        indicators: {overlay: 'MA', pane: 'VOL'},
      },
      {
        type: 'INDICATORS_COMMITTED',
        sessionId,
        intentId: 2,
        indicators: {overlay: 'VOL', pane: 'MA'},
      },
      {
        type: 'INDICATORS_COMMITTED',
        sessionId,
        intentId: 3,
        indicators: {overlay: 'MA', pane: 'VOL', extra: true},
      },
      {
        type: 'INDICATORS_ERROR',
        sessionId,
        intentId: 4,
        message: '   ',
        indicators: null,
      },
      {
        type: 'INDICATORS_ERROR',
        sessionId,
        intentId: 5,
        message: 'failed',
        indicators: null,
        extra: true,
      },
      {
        type: 'INDICATORS_ERROR',
        sessionId,
        intentId: 0,
        message: 'failed',
        indicators: null,
      },
      {
        type: 'INDICATORS_ERROR',
        sessionId,
        intentId: Number.MAX_SAFE_INTEGER + 1,
        message: 'failed',
        indicators: null,
      },
      {
        type: 'INDICATORS_ERROR',
        sessionId,
        intentId: 6,
        message: 'failed',
        indicators: {overlay: 'MA', pane: 'UNKNOWN'},
      },
    ]) {
      expect(
        parseAdvancedChartBridgeMessage(JSON.stringify(invalid), sessionId),
      ).toBeNull();
    }
  });

  it('parses v2 capability and strict indicator config receipts', () => {
    const sessionId = 'session-1234';
    const config = {
      protocolVersion: 2,
      overlay: {kind: 'BOLL', params: {length: 20, multiplier: 2}},
      pane: {
        kind: 'MACD',
        params: {fastLength: 12, slowLength: 26, signalLength: 9},
      },
    };
    expect(
      parseAdvancedChartBridgeMessage(
        JSON.stringify({
          type: 'CHART_READY',
          sessionId,
          capabilities: ['indicator-config-v2'],
        }),
        sessionId,
      ),
    ).toEqual({
      type: 'CHART_READY',
      sessionId,
      capabilities: ['indicator-config-v2'],
    });
    expect(
      parseAdvancedChartBridgeMessage(
        JSON.stringify({
          type: 'INDICATOR_CONFIG_COMMITTED',
          sessionId,
          intentId: 3,
          config,
        }),
        sessionId,
      ),
    ).toEqual({
      type: 'INDICATOR_CONFIG_COMMITTED',
      sessionId,
      intentId: 3,
      config,
    });
    expect(
      parseAdvancedChartBridgeMessage(
        JSON.stringify({
          type: 'INDICATOR_CONFIG_ERROR',
          sessionId,
          intentId: 4,
          message: '参数应用失败',
          config: null,
        }),
        sessionId,
      ),
    ).toEqual({
      type: 'INDICATOR_CONFIG_ERROR',
      sessionId,
      intentId: 4,
      message: '参数应用失败',
      config: null,
    });
    expect(
      parseAdvancedChartBridgeMessage(
        JSON.stringify({
          type: 'INDICATOR_CONFIG_COMMITTED',
          sessionId,
          intentId: 5,
          config: {...config, protocolVersion: 1},
        }),
        sessionId,
      ),
    ).toBeNull();
  });
});
