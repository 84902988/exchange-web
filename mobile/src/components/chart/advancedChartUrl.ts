import {
  klineIntervals,
  type KlineInterval,
} from '../trade/kline.utils';
import {
  parseAdvancedChartIndicatorConfigV2,
  type AdvancedChartIndicatorConfigV2,
} from './advancedChartConfig';

export const ADVANCED_CHART_PATH = '/mobile/advanced-chart';

export type AdvancedChartMarket = 'spot' | 'contract';
export type AdvancedChartCategory = 'stock' | 'cfd';
export type AdvancedChartOverlayIndicator =
  | 'MA'
  | 'EMA'
  | 'BOLL'
  | 'SAR'
  | 'AVL'
  | 'SUPER';
export type AdvancedChartPaneIndicator =
  | 'VOL'
  | 'MACD'
  | 'RSI'
  | 'KDJ'
  | 'OBV'
  | 'WR'
  | 'StochRSI';
export type AdvancedChartIndicators = {
  overlay: AdvancedChartOverlayIndicator;
  pane: AdvancedChartPaneIndicator;
};

export const ADVANCED_CHART_BENCHMARK_MARKS = [
  'WEB_DOM_CONTENT_LOADED',
  'WEB_WINDOW_LOAD',
  'WEB_CLIENT_MOUNTED',
  'WEB_BOOTSTRAP_REQUEST',
  'WEB_BOOTSTRAP_CACHE',
  'WEB_CHART_ROOT',
  'WEB_SCRIPT_READY',
  'WEB_WIDGET_CREATED',
  'WEB_GET_BARS_REQUEST',
  'WEB_GET_BARS_HTTP_RESPONSE',
  'WEB_GET_BARS_NORMALIZED',
  'WEB_GET_BARS_DELIVERED',
  'WEB_HISTORY_READY',
  'WEB_STUDY_API_READY',
  'WEB_DATA_READY',
] as const;

export type AdvancedChartBenchmarkMark =
  (typeof ADVANCED_CHART_BENCHMARK_MARKS)[number];

export type AdvancedChartUrlOptions = {
  baseUrl: string;
  market: AdvancedChartMarket;
  symbol: string;
  interval: KlineInterval;
  lang: string;
  sessionId: string;
  category?: AdvancedChartCategory;
};

export type AdvancedChartBridgeMessage =
  | {type: 'CHART_READY'; sessionId: string; capabilities: string[]}
  | {type: 'CHART_ERROR'; sessionId: string; message?: string}
  | {
      type: 'PERF_MARK';
      sessionId: string;
      mark: AdvancedChartBenchmarkMark;
      elapsedMs: number;
    }
  | {
      type: 'INTERVAL_COMMITTED';
      sessionId: string;
      interval: KlineInterval;
    }
  | {
      type: 'INDICATORS_COMMITTED';
      sessionId: string;
      intentId: number;
      indicators: AdvancedChartIndicators;
    }
  | {
      type: 'INDICATORS_ERROR';
      sessionId: string;
      intentId: number;
      message: string;
      indicators: AdvancedChartIndicators | null;
    }
  | {
      type: 'INDICATOR_CONFIG_COMMITTED';
      sessionId: string;
      intentId: number;
      config: AdvancedChartIndicatorConfigV2;
    }
  | {
      type: 'INDICATOR_CONFIG_ERROR';
      sessionId: string;
      intentId: number;
      message: string;
      config: AdvancedChartIndicatorConfigV2 | null;
    };

const SPOT_SYMBOL_PATTERN = /^[A-Z0-9][A-Z0-9-]{0,63}$/;
const CONTRACT_SYMBOL_PATTERN = /^[A-Z0-9][A-Z0-9._-]{0,63}$/;
const SESSION_PATTERN = /^[a-z0-9-]{8,96}$/;
const LANG_PATTERN = /^[a-z]{2}(?:-[A-Z]{2})?$/;
const intervalSet = new Set<string>(klineIntervals);
const overlayIndicatorSet = new Set<string>([
  'MA',
  'EMA',
  'BOLL',
  'SAR',
  'AVL',
  'SUPER',
]);
const paneIndicatorSet = new Set<string>([
  'VOL',
  'MACD',
  'RSI',
  'KDJ',
  'OBV',
  'WR',
  'StochRSI',
]);
const benchmarkMarkSet = new Set<string>(ADVANCED_CHART_BENCHMARK_MARKS);
let sessionSequence = 0;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === 'number' && value > 0;
}

function parseIndicatorSelection(
  value: unknown,
): AdvancedChartIndicators | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['overlay', 'pane']) ||
    typeof value.overlay !== 'string' ||
    !overlayIndicatorSet.has(value.overlay) ||
    typeof value.pane !== 'string' ||
    !paneIndicatorSet.has(value.pane)
  ) {
    return null;
  }
  return {
    overlay: value.overlay as AdvancedChartIndicators['overlay'],
    pane: value.pane as AdvancedChartIndicators['pane'],
  };
}

export function createAdvancedChartSessionId(
  nowMs = Date.now(),
  randomValue = Math.random(),
) {
  sessionSequence = (sessionSequence + 1) % 1679616;
  const timePart = Math.max(0, Math.trunc(nowMs)).toString(36);
  const randomPart = Math.max(0, Math.min(0.999999999, randomValue))
    .toString(36)
    .slice(2, 10)
    .padEnd(4, '0');
  return `${timePart}-${sessionSequence.toString(36)}-${randomPart}`;
}

export function getAdvancedChartOrigin(url: string) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

export function buildAdvancedChartUrl({
  baseUrl,
  market,
  symbol,
  interval,
  lang,
  sessionId,
  category,
}: AdvancedChartUrlOptions) {
  const origin = getAdvancedChartOrigin(baseUrl);
  const normalizedSymbol = symbol.trim().toUpperCase();
  const symbolPattern =
    market === 'spot' ? SPOT_SYMBOL_PATTERN : CONTRACT_SYMBOL_PATTERN;
  if (!origin || new URL(baseUrl).origin !== baseUrl.replace(/\/+$/, '')) {
    throw new Error('Advanced chart base URL must be an HTTP or HTTPS origin');
  }
  if (!symbolPattern.test(normalizedSymbol)) {
    throw new Error('Advanced chart symbol is invalid');
  }
  if (!intervalSet.has(interval)) {
    throw new Error('Advanced chart interval is invalid');
  }
  if (!SESSION_PATTERN.test(sessionId)) {
    throw new Error('Advanced chart session is invalid');
  }
  if (!LANG_PATTERN.test(lang)) {
    throw new Error('Advanced chart language is invalid');
  }
  if (category && market !== 'contract') {
    throw new Error('Advanced chart category is only valid for contract markets');
  }

  const url = new URL(ADVANCED_CHART_PATH, `${origin}/`);
  url.searchParams.set('market', market);
  url.searchParams.set('symbol', normalizedSymbol);
  url.searchParams.set('interval', interval);
  url.searchParams.set('lang', lang);
  url.searchParams.set('sessionId', sessionId);
  if (category) url.searchParams.set('category', category);
  return url.toString();
}

export function buildAdvancedChartBenchmarkProbeScript(sessionId: string) {
  if (!SESSION_PATTERN.test(sessionId)) {
    throw new Error('Advanced chart benchmark session is invalid');
  }
  const serializedSessionId = JSON.stringify(sessionId);
  return `(() => {
    const sessionId = ${serializedSessionId};
    const sent = new Set();
    const emit = (mark, observedElapsedMs) => {
      if (sent.has(mark)) return;
      const bridge = window.ReactNativeWebView;
      if (!bridge || typeof bridge.postMessage !== 'function') return;
      const elapsedMs = Number.isFinite(observedElapsedMs) && observedElapsedMs >= 0
        ? Math.round(observedElapsedMs * 10) / 10
        : typeof performance !== 'undefined' && typeof performance.now === 'function'
          ? Math.max(0, Math.round(performance.now() * 10) / 10)
          : 0;
      bridge.postMessage(JSON.stringify({type: 'PERF_MARK', sessionId, mark, elapsedMs}));
      sent.add(mark);
    };
    const inspect = () => {
      const client = document.querySelector('[data-mobile-advanced-chart]');
      if (client) {
        emit('WEB_CLIENT_MOUNTED');
        const source = client.getAttribute('data-mobile-chart-bootstrap-source');
        if (source === 'request') emit('WEB_BOOTSTRAP_REQUEST');
        if (source === 'persistent-cache') emit('WEB_BOOTSTRAP_CACHE');
      }
      const chart = document.querySelector(
        '[data-spot-chart-bootstrap="ready"], [data-contract-chart-bootstrap="ready"]',
      );
      if (!chart) return;
      emit('WEB_CHART_ROOT');
      if (chart.getAttribute('data-contract-chart-script') === 'ready') {
        emit('WEB_SCRIPT_READY');
      }
      const contractContainer = chart.querySelector(
        '[data-contract-chart-perf]',
      );
      if (contractContainer?.getAttribute('data-contract-chart-widget') === 'ready') {
        emit('WEB_WIDGET_CREATED');
      }
      const emitContractHistoryTiming = (attribute, mark) => {
        const rawValue = contractContainer?.getAttribute(attribute);
        if (rawValue === null || rawValue === undefined || rawValue === '') return;
        const observedElapsedMs = Number(rawValue);
        if (!Number.isFinite(observedElapsedMs) || observedElapsedMs < 0) return;
        emit(mark, observedElapsedMs);
      };
      emitContractHistoryTiming(
        'data-contract-chart-get-bars-request',
        'WEB_GET_BARS_REQUEST',
      );
      emitContractHistoryTiming(
        'data-contract-chart-get-bars-response',
        'WEB_GET_BARS_HTTP_RESPONSE',
      );
      emitContractHistoryTiming(
        'data-contract-chart-get-bars-normalized',
        'WEB_GET_BARS_NORMALIZED',
      );
      emitContractHistoryTiming(
        'data-contract-chart-get-bars-delivered',
        'WEB_GET_BARS_DELIVERED',
      );
      if (contractContainer?.getAttribute('data-contract-chart-history') === 'ready') {
        emit('WEB_HISTORY_READY');
      }
      if (contractContainer?.getAttribute('data-contract-chart-study-api') === 'ready') {
        emit('WEB_STUDY_API_READY');
      }
      const ready = chart.getAttribute('data-spot-chart-loading') === 'ready'
        || chart.getAttribute('data-contract-chart-loading') === 'ready';
      if (ready) emit('WEB_DATA_READY');
    };
    let observing = false;
    const observe = () => {
      if (observing || !document.documentElement) return;
      observing = true;
      const observer = new MutationObserver(inspect);
      observer.observe(document.documentElement, {
        attributes: true,
        childList: true,
        subtree: true,
        attributeFilter: [
          'data-mobile-advanced-chart',
          'data-mobile-chart-bootstrap-source',
          'data-spot-chart-bootstrap',
          'data-spot-chart-loading',
          'data-contract-chart-bootstrap',
          'data-contract-chart-loading',
          'data-contract-chart-script',
          'data-contract-chart-perf',
          'data-contract-chart-widget',
          'data-contract-chart-get-bars-request',
          'data-contract-chart-get-bars-response',
          'data-contract-chart-get-bars-normalized',
          'data-contract-chart-get-bars-delivered',
          'data-contract-chart-history',
          'data-contract-chart-study-api',
        ],
      });
      inspect();
    };
    document.addEventListener('DOMContentLoaded', () => {
      emit('WEB_DOM_CONTENT_LOADED');
      observe();
    }, {once: true});
    window.addEventListener('load', () => {
      emit('WEB_WINDOW_LOAD');
      inspect();
    }, {once: true});
    observe();
    requestAnimationFrame(inspect);
  })(); true;`;
}

export function isAllowedAdvancedChartNavigation(
  url: string,
  expectedOrigin: string,
) {
  if (url === 'about:blank') return true;
  return getAdvancedChartOrigin(url) === expectedOrigin;
}

export function isAllowedAdvancedChartTopNavigation(
  url: string,
  expectedUrl: string,
) {
  if (url === 'about:blank') return true;
  try {
    const actual = new URL(url);
    const expected = new URL(expectedUrl);
    return (
      actual.origin === expected.origin &&
      actual.pathname === expected.pathname &&
      actual.search === expected.search &&
      actual.hash === '' &&
      expected.hash === ''
    );
  } catch {
    return false;
  }
}

export function parseAdvancedChartBridgeMessage(
  raw: string,
  expectedSessionId: string,
): AdvancedChartBridgeMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.sessionId !== expectedSessionId) return null;

  if (parsed.type === 'CHART_READY') {
    if (
      !hasExactKeys(parsed, ['type', 'sessionId']) &&
      !hasExactKeys(parsed, ['type', 'sessionId', 'capabilities'])
    ) {
      return null;
    }
    const capabilities = parsed.capabilities ?? [];
    if (
      !Array.isArray(capabilities) ||
      capabilities.length > 32 ||
      capabilities.some(
        value => typeof value !== 'string' || value.length < 1 || value.length > 64,
      )
    ) {
      return null;
    }
    return {
      type: 'CHART_READY',
      sessionId: expectedSessionId,
      capabilities: [...new Set(capabilities as string[])],
    };
  }
  if (parsed.type === 'CHART_ERROR') {
    const message =
      typeof parsed.message === 'string'
        ? parsed.message.trim().slice(0, 160)
        : undefined;
    return {
      type: 'CHART_ERROR',
      sessionId: expectedSessionId,
      ...(message ? {message} : {}),
    };
  }
  if (
    parsed.type === 'PERF_MARK' &&
    hasExactKeys(parsed, [
      'type',
      'sessionId',
      'mark',
      'elapsedMs',
    ]) &&
    typeof parsed.mark === 'string' &&
    benchmarkMarkSet.has(parsed.mark) &&
    typeof parsed.elapsedMs === 'number' &&
    Number.isFinite(parsed.elapsedMs) &&
    parsed.elapsedMs >= 0 &&
    parsed.elapsedMs <= 120_000
  ) {
    return {
      type: 'PERF_MARK',
      sessionId: expectedSessionId,
      mark: parsed.mark as AdvancedChartBenchmarkMark,
      elapsedMs: parsed.elapsedMs,
    };
  }
  if (
    parsed.type === 'INTERVAL_COMMITTED' &&
    typeof parsed.interval === 'string' &&
    intervalSet.has(parsed.interval)
  ) {
    return {
      type: 'INTERVAL_COMMITTED',
      sessionId: expectedSessionId,
      interval: parsed.interval as KlineInterval,
    };
  }
  if (
    parsed.type === 'INDICATORS_COMMITTED' &&
    hasExactKeys(parsed, ['type', 'sessionId', 'intentId', 'indicators']) &&
    isPositiveSafeInteger(parsed.intentId)
  ) {
    const indicators = parseIndicatorSelection(parsed.indicators);
    if (!indicators) return null;
    return {
      type: 'INDICATORS_COMMITTED',
      sessionId: expectedSessionId,
      intentId: parsed.intentId,
      indicators,
    };
  }
  if (
    parsed.type === 'INDICATORS_ERROR' &&
    hasExactKeys(parsed, [
      'type',
      'sessionId',
      'intentId',
      'message',
      'indicators',
    ]) &&
    isPositiveSafeInteger(parsed.intentId) &&
    typeof parsed.message === 'string'
  ) {
    const message = parsed.message.trim().slice(0, 160);
    if (!message) return null;
    const indicators =
      parsed.indicators === null
        ? null
        : parseIndicatorSelection(parsed.indicators);
    if (parsed.indicators !== null && !indicators) return null;
    return {
      type: 'INDICATORS_ERROR',
      sessionId: expectedSessionId,
      intentId: parsed.intentId,
      message,
      indicators,
    };
  }
  if (
    parsed.type === 'INDICATOR_CONFIG_COMMITTED' &&
    hasExactKeys(parsed, ['type', 'sessionId', 'intentId', 'config']) &&
    isPositiveSafeInteger(parsed.intentId)
  ) {
    const config = parseAdvancedChartIndicatorConfigV2(parsed.config);
    if (!config) return null;
    return {
      type: 'INDICATOR_CONFIG_COMMITTED',
      sessionId: expectedSessionId,
      intentId: parsed.intentId,
      config,
    };
  }
  if (
    parsed.type === 'INDICATOR_CONFIG_ERROR' &&
    hasExactKeys(parsed, [
      'type',
      'sessionId',
      'intentId',
      'message',
      'config',
    ]) &&
    isPositiveSafeInteger(parsed.intentId) &&
    typeof parsed.message === 'string'
  ) {
    const message = parsed.message.trim().slice(0, 160);
    if (!message) return null;
    const config =
      parsed.config === null
        ? null
        : parseAdvancedChartIndicatorConfigV2(parsed.config);
    if (parsed.config !== null && !config) return null;
    return {
      type: 'INDICATOR_CONFIG_ERROR',
      sessionId: expectedSessionId,
      intentId: parsed.intentId,
      message,
      config,
    };
  }
  return null;
}
