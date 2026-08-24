import { NativeModules, Platform } from 'react-native';

import { resolveApiBaseUrl } from './apiBaseUrl';
import { resolveChartWebBaseUrl } from './chartWebBaseUrl';

type AppConfigNativeModule = {
  API_BASE_URL?: unknown;
  CHART_WEB_BASE_URL?: unknown;
  BUILD_TYPE?: unknown;
  reportFullyDrawn?: () => void;
  logBenchmarkChartPerf?: (payload: string) => void;
};

const appConfig = NativeModules.AppConfig as AppConfigNativeModule | undefined;
const nativeBuildType =
  typeof appConfig?.BUILD_TYPE === 'string'
    ? appConfig.BUILD_TYPE.trim().toLowerCase()
    : '';

export const IS_BENCHMARK_BUILD = nativeBuildType === 'benchmark';

export const API_BASE_URL = resolveApiBaseUrl({
  platform: Platform.OS,
  nativeApiBaseUrl: appConfig?.API_BASE_URL,
  allowLocalFallback: __DEV__,
  requireHttps: nativeBuildType === 'release',
});

export const CHART_WEB_BASE_URL = resolveChartWebBaseUrl({
  nativeChartWebBaseUrl: appConfig?.CHART_WEB_BASE_URL,
  allowLocalFallback: __DEV__,
  // Benchmark is release-like JavaScript but intentionally targets an
  // adb-reversed local origin. Only the actual production Release variant
  // requires public HTTPS here; its Gradle pre-build check enforces the same.
  requireHttps: nativeBuildType === 'release',
});

export const API_TIMEOUT_MS = 15000;

let fullyDrawnReported = false;

export function reportAppFullyDrawn() {
  if (fullyDrawnReported) return;
  const report = appConfig?.reportFullyDrawn;
  if (typeof report !== 'function') return;
  fullyDrawnReported = true;
  try {
    report();
  } catch {
    fullyDrawnReported = false;
  }
}

export function reportBenchmarkChartPerf(payload: string) {
  if (!IS_BENCHMARK_BUILD || typeof payload !== 'string') return;
  const report = appConfig?.logBenchmarkChartPerf;
  if (typeof report !== 'function') return;
  try {
    report(payload);
  } catch {
    // Benchmark observability must never change chart behavior.
  }
}
