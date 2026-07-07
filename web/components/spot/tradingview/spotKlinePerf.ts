'use client';

export type SpotKlinePerfPayload = Record<string, unknown>;

export type SpotKlinePerfEvent = SpotKlinePerfPayload & {
  event: string;
  timestamp: number;
  time: string;
  performance_now: number;
};

declare global {
  interface Window {
    __spotKlinePerfEvents?: SpotKlinePerfEvent[];
    __spotKlinePerfClear?: () => void;
    __spotKlinePerfTable?: () => SpotKlinePerfEvent[];
  }
}

const SPOT_KLINE_PERF_EVENT_LIMIT = 1000;
const SPOT_KLINE_PERF_PREFIX = '[spot-kline-perf]';
let spotKlinePerfIdSeq = 0;

function getPerfNow() {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

function getPerfWindow() {
  if (typeof window === 'undefined') return null;
  return window;
}

export function isSpotKlinePerfEnabled() {
  const perfWindow = getPerfWindow();
  if (!perfWindow) return false;

  try {
    return perfWindow.localStorage?.getItem('spotKlinePerfDebug') === '1';
  } catch {
    return false;
  }
}

export function createSpotKlinePerfId(prefix: string) {
  spotKlinePerfIdSeq += 1;
  return `${prefix}-${Date.now()}-${spotKlinePerfIdSeq}`;
}

export function markSpotKlinePerf(event: string, payload: SpotKlinePerfPayload = {}) {
  if (!isSpotKlinePerfEnabled()) return null;

  const perfWindow = getPerfWindow();
  if (!perfWindow) return null;

  const timestamp = Date.now();
  const entry: SpotKlinePerfEvent = {
    event,
    timestamp,
    time: new Date(timestamp).toISOString(),
    performance_now: getPerfNow(),
    ...payload,
  };

  try {
    const events = perfWindow.__spotKlinePerfEvents || [];
    events.push(entry);
    if (events.length > SPOT_KLINE_PERF_EVENT_LIMIT) {
      events.splice(0, events.length - SPOT_KLINE_PERF_EVENT_LIMIT);
    }
    perfWindow.__spotKlinePerfEvents = events;
    perfWindow.__spotKlinePerfClear = () => {
      perfWindow.__spotKlinePerfEvents = [];
    };
    perfWindow.__spotKlinePerfTable = () => {
      const rows = perfWindow.__spotKlinePerfEvents || [];
      console.table(rows);
      return rows;
    };
    console.info(SPOT_KLINE_PERF_PREFIX, entry);
  } catch {
    // Perf telemetry is best-effort only and must never affect the page.
  }

  return entry;
}
