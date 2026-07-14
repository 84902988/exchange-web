'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import Script from 'next/script';
import { useLocaleContext } from '@/contexts/LocaleContext';
import {
  contractIntervalToTradingViewResolution,
  createContractTradingViewDatafeed,
  type ContractHistoryBarsEvent,
  type ContractHistoryErrorEvent,
} from './tradingview/contractTradingViewDatafeed';
import {
  normalizeContractKlineAssetClass,
  type ContractKlineAssetClass,
} from './tradingview/contractKlineCachePolicy';
import {
  getContractKlineVisibleBars,
  normalizeContractKlineLoadInterval,
} from './tradingview/contractKlineLoadPolicy';
import { createContractKlinePreloadManager } from './tradingview/contractKlinePreloadManager';
import {
  ContractTradingViewPriceOverlayController,
  type ContractPriceDirection,
  type ContractTradingViewOverlayChart,
} from './tradingview/contractTradingViewPriceOverlay';
import { setSpotToolbarLoadingState } from '@/components/spot/tradingview/spotTradingViewResolutionState';
import { applyTradingViewViewport } from '@/components/tradingview/tradingViewViewportLifecycle';

export type ContractChartMode = 'time' | 'candle';

export type TradingViewChartApi = {
  dataReady?: () => Promise<boolean> | boolean;
  resolution?: () => string;
  getSeries?: () => {
    setChartStyleProperties?: (chartStyle: number, preferences: Record<string, unknown>) => void;
  };
  setResolution?: (
    resolution: string,
    options?: { dataReady?: () => void; doNotActivateChart?: boolean } | (() => void),
  ) => Promise<boolean> | boolean | void;
  setVisibleRange?: (
    range: { from: number; to?: number },
    options?: {
      applyDefaultRightMargin?: boolean;
      percentRightMargin?: number;
      rejectByTimeout?: number;
    },
  ) => Promise<void> | void;
  getVisibleRange?: () => { from: number; to?: number };
  getTimeScale?: () => {
    setRightOffset?: (offset: number) => void;
  };
  createShape?: ContractTradingViewOverlayChart['createShape'];
  getShapeById?: ContractTradingViewOverlayChart['getShapeById'];
  removeEntity?: ContractTradingViewOverlayChart['removeEntity'];
};

type TradingViewWidgetInstance = {
  remove: () => void;
  activeChart: () => TradingViewChartApi;
  applyOverrides?: (overrides: Record<string, unknown>) => void;
  chartReady?: () => Promise<void>;
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

type ContractTradingViewWindow = {
  TradingView?: ContractTradingViewGlobal;
};

type TradingViewLoadError = {
  key: string;
  message: string;
};

type ContractTradingViewChartProps = {
  symbol: string;
  category?: ContractKlineAssetClass | string | null;
  displaySymbol?: string | null;
  interval: string;
  chartMode: ContractChartMode;
  intervalOptions?: string[];
  height?: number;
  pricePrecision?: number | null;
  amountPrecision?: number | null;
  displayPrice?: number | null;
  priceDirection?: ContractPriceDirection;
  onChartModeChange?: (value: ContractChartMode) => void;
  onIntervalChange?: (value: string) => void;
  onLatestKlineCloseChange?: (price: string | null) => void;
};

type ContractResolutionRequestParams = {
  chart: TradingViewChartApi | null;
  resolution: string;
  isCurrent: () => boolean;
  onCommitted?: (reason: string, activeResolution: string) => void;
  onFailed?: (reason: string, error?: unknown) => void;
  // Legacy aliases remain supported for the existing Contract chart test/API surface.
  onSettled?: (activeResolution: string) => void;
  onFallback?: (reason: string, error?: unknown) => void;
  clock?: ContractChartLoadingClock;
  timeoutMs?: number;
};

export type ContractResolutionIntent = Readonly<{
  resolution: string;
  intentId: number;
}>;

export type ContractResolutionIntentToken = Readonly<{
  resolution: string;
  intentId: number;
  requestSequence: number;
}>;

export type ContractResolutionIntentSnapshot = Readonly<{
  currentResolution: string;
  inFlightResolution: string;
  pendingResolution: ContractResolutionIntent | null;
  latestIntentId: number;
  requestSequence: number;
}>;

type ContractResolutionIntentDecision = Readonly<{
  action: 'start' | 'pending' | 'noop' | 'stale';
  token?: ContractResolutionIntentToken;
  snapshot: ContractResolutionIntentSnapshot;
}>;

type ContractResolutionIntentSettlement = Readonly<{
  accepted: boolean;
  nextToken?: ContractResolutionIntentToken;
  snapshot: ContractResolutionIntentSnapshot;
}>;

export type ContractResolutionRequest = Promise<void> & {
  cancel: () => void;
};

export type ContractResolutionLifecycleState = Readonly<{
  requestedResolution: string;
  committedResolution: string;
  activeTradingViewResolution: string;
  inFlightResolution: string;
}>;

type ContractChartLoadingClock = {
  now: () => number;
  setTimeout: (callback: () => void, delayMs: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

type ContractChartLoadingCoordinatorOptions = {
  onChange: (reason: string) => void;
  clock?: ContractChartLoadingClock;
  minVisibleMs?: number;
  safetyTimeoutMs?: number;
};

const TRADINGVIEW_LIBRARY_PATH = '/tradingview/charting_library/';
const TRADINGVIEW_SCRIPT_SRC = `${TRADINGVIEW_LIBRARY_PATH}charting_library.js`;
const TRADINGVIEW_TIMEZONE = 'Asia/Shanghai';
const TRADINGVIEW_CANDLE_STYLE = 1;
const TRADINGVIEW_TIME_STYLE = 2;
const CONTRACT_CHART_LOADING_MIN_VISIBLE_MS = 220;
const CONTRACT_CHART_LOADING_SAFETY_TIMEOUT_MS = 5000;
export const CONTRACT_SET_RESOLUTION_TIMEOUT_MS = 4500;
const CONTRACT_TV_INITIAL_RIGHT_PADDING_BARS = 4;
const DEFAULT_INTERVAL_OPTIONS = ['1m', '5m', '15m', '1h', '4h', '1d', '1w', '1M'];
const TIME_SHARING_KEY = 'time';
const TIME_SHARING_LABEL = 'Time';

export const CONTRACT_TV_PRICE_LABEL_OVERRIDES = {
  'mainSeriesProperties.showPriceLine': false,
  'scalesProperties.showSeriesLastValue': false,
} as const;

type ContractPriceOverlayInput = Parameters<
  ContractTradingViewPriceOverlayController['update']
>[0];

type ContractPriceOverlayController = Pick<
  ContractTradingViewPriceOverlayController,
  'update' | 'destroy'
>;

export type ContractPriceOverlayLifecycleState = 'suspended' | 'active' | 'destroyed';

export class ContractPriceOverlayLifecycle {
  private lifecycleState: ContractPriceOverlayLifecycleState = 'suspended';

  constructor(
    private readonly getController: () => ContractPriceOverlayController | null,
  ) {}

  state() {
    return this.lifecycleState;
  }

  suspend() {
    if (this.lifecycleState === 'destroyed') return;
    this.lifecycleState = 'suspended';
  }

  resume(input: ContractPriceOverlayInput) {
    if (this.lifecycleState === 'destroyed') return;
    this.lifecycleState = 'active';
    this.getController()?.update(input);
  }

  update(input: ContractPriceOverlayInput) {
    if (this.lifecycleState !== 'active') return;
    this.getController()?.update(input);
  }

  destroy() {
    if (this.lifecycleState === 'destroyed') return;
    this.lifecycleState = 'destroyed';
    this.getController()?.destroy();
  }
}

const CONTRACT_TV_INTERVAL_SECONDS: Readonly<Record<string, number>> = {
  '1m': 60,
  '5m': 5 * 60,
  '15m': 15 * 60,
  '1h': 60 * 60,
  '4h': 4 * 60 * 60,
  '1d': 24 * 60 * 60,
  '1w': 7 * 24 * 60 * 60,
  '1M': 30 * 24 * 60 * 60,
};

export function resolveContractInitialVisibleRange(interval: string, latestBarTimeMs: number) {
  const normalizedInterval = normalizeContractKlineLoadInterval(interval);
  const intervalSeconds = CONTRACT_TV_INTERVAL_SECONDS[normalizedInterval]
    ?? CONTRACT_TV_INTERVAL_SECONDS['1d'];
  const targetVisibleBars = getContractKlineVisibleBars(normalizedInterval);
  const latestBarTime = Math.floor(Number(latestBarTimeMs) / 1000);
  if (!Number.isFinite(latestBarTime) || latestBarTime <= 0) return null;
  return {
    range: {
      from: latestBarTime - intervalSeconds * targetVisibleBars,
      to: latestBarTime,
    },
    fallbackRange: {
      from: latestBarTime - intervalSeconds * targetVisibleBars,
      to: latestBarTime + intervalSeconds * CONTRACT_TV_INITIAL_RIGHT_PADDING_BARS,
    },
    intervalSeconds,
    latestBarTime,
    rightPaddingBars: CONTRACT_TV_INITIAL_RIGHT_PADDING_BARS,
    targetVisibleBars,
  };
}

export const CONTRACT_TIME_SERIES_OVERRIDES = {
  'mainSeriesProperties.lineStyle.colorType': 'solid',
  'mainSeriesProperties.lineStyle.gradientStartColor': '#f0b90b',
  'mainSeriesProperties.lineStyle.gradientEndColor': '#f0b90b',
  'mainSeriesProperties.lineStyle.color': '#f0b90b',
  'mainSeriesProperties.lineStyle.linewidth': 2,
  'mainSeriesProperties.lineStyle.linestyle': 0,
  'mainSeriesProperties.lineStyle.priceSource': 'close',
  'mainSeriesProperties.areaStyle.color1': 'rgba(240,185,11,0.24)',
  'mainSeriesProperties.areaStyle.color2': 'rgba(240,185,11,0.02)',
  'mainSeriesProperties.areaStyle.linecolor': '#f0b90b',
  'mainSeriesProperties.areaStyle.linewidth': 2,
} as const;

export const CONTRACT_TIME_LINE_STYLE_PREFERENCES = {
  colorType: 'solid',
  gradientStartColor: '#f0b90b',
  gradientEndColor: '#f0b90b',
  color: '#f0b90b',
  linestyle: 0,
  linewidth: 2,
} as const;

export const CONTRACT_CHART_LOADING_OVERLAY_CLASS_NAME =
  'pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-[#12161c]/75';

export function resolveContractEffectiveKlineInterval(
  chartMode: ContractChartMode,
  candleInterval: string,
) {
  return chartMode === 'time' ? '1m' : candleInterval;
}

export function resolveContractWidgetStyle(chartMode: ContractChartMode) {
  return chartMode === 'time' ? TRADINGVIEW_TIME_STYLE : TRADINGVIEW_CANDLE_STYLE;
}

export function resolveContractToolbarSelection(
  key: string,
  currentInterval: string,
): { chartMode: ContractChartMode; interval: string } {
  if (key === TIME_SHARING_KEY) {
    return { chartMode: 'time', interval: currentInterval };
  }
  return { chartMode: 'candle', interval: key };
}

export function isContractToolbarButtonActive(
  key: string,
  chartMode: ContractChartMode,
  candleInterval: string,
) {
  return key === TIME_SHARING_KEY
    ? chartMode === 'time'
    : chartMode === 'candle' && key === candleInterval;
}

export function buildContractWidgetIdentityKey(params: {
  symbol: string;
  category?: ContractKlineAssetClass | string | null;
  locale: string;
  pricePrecision?: number | null;
  amountPrecision?: number | null;
  chartMode: ContractChartMode;
  fallbackNonce: number;
}) {
  return [
    params.symbol,
    normalizeContractKlineAssetClass(params.category),
    params.locale,
    params.pricePrecision ?? 'auto',
    params.amountPrecision ?? 'auto',
    params.chartMode,
    params.fallbackNonce,
  ].join(':');
}

export function shouldShowContractChartLoading(reason: string, error: string) {
  return Boolean(reason) && !error;
}

export function isContractHistoryEventCurrent(
  event: ContractHistoryBarsEvent | ContractHistoryErrorEvent,
  expected: {
    symbol: string;
    interval: string;
    resolution: string;
    minimumRequestSeq: number;
  },
) {
  return event.symbol === expected.symbol
    && event.interval === expected.interval
    && event.resolution === expected.resolution
    && event.requestSeq >= expected.minimumRequestSeq;
}

function normalizeContractResolutionValue(value: unknown) {
  return String(value || '').trim();
}

export function readContractActiveTradingViewResolution(chart: TradingViewChartApi | null) {
  if (typeof chart?.resolution !== 'function') return '';
  try {
    return normalizeContractResolutionValue(chart.resolution());
  } catch {
    return '';
  }
}

export function shouldRequestContractResolution(
  state: ContractResolutionLifecycleState,
  targetResolution: string,
) {
  const target = normalizeContractResolutionValue(targetResolution);
  if (!target) return false;
  if (
    state.requestedResolution === target
    && state.inFlightResolution.endsWith(`:${target}`)
  ) return false;
  return Boolean(
    state.inFlightResolution
    || state.requestedResolution !== target
    || state.committedResolution !== target
    || state.activeTradingViewResolution !== target
  );
}

export class ContractResolutionIntentCoordinator {
  private currentResolution = '';
  private inFlightResolution = '';
  private pendingResolution: ContractResolutionIntent | null = null;
  private latestIntentValue: ContractResolutionIntent | null = null;
  private latestIntentId = 0;
  private requestSequence = 0;

  constructor(currentResolution = '') {
    this.currentResolution = normalizeContractResolutionValue(currentResolution);
  }

  private snapshotValue(): ContractResolutionIntentSnapshot {
    return {
      currentResolution: this.currentResolution,
      inFlightResolution: this.inFlightResolution,
      pendingResolution: this.pendingResolution,
      latestIntentId: this.latestIntentId,
      requestSequence: this.requestSequence,
    };
  }

  private start(intent: ContractResolutionIntent): ContractResolutionIntentToken {
    this.requestSequence += 1;
    this.inFlightResolution = intent.resolution;
    return { ...intent, requestSequence: this.requestSequence };
  }

  reset(currentResolution = '') {
    this.requestSequence += 1;
    this.latestIntentId += 1;
    this.currentResolution = normalizeContractResolutionValue(currentResolution);
    this.inFlightResolution = '';
    this.pendingResolution = null;
    this.latestIntentValue = null;
    return this.snapshotValue();
  }

  snapshot() {
    return this.snapshotValue();
  }

  latestIntent() {
    return this.latestIntentValue;
  }

  registerIntent(resolution: string) {
    const nextResolution = normalizeContractResolutionValue(resolution);
    this.latestIntentId += 1;
    const intent: ContractResolutionIntent = {
      resolution: nextResolution,
      intentId: this.latestIntentId,
    };
    this.latestIntentValue = intent;
    this.pendingResolution = nextResolution
      && nextResolution !== (this.inFlightResolution || this.currentResolution)
      ? intent
      : null;
    return { intent, snapshot: this.snapshotValue() };
  }

  isLatestIntent(intent: ContractResolutionIntent | null | undefined) {
    return Boolean(
      intent
      && intent.intentId === this.latestIntentId
      && intent.resolution === this.latestIntentValue?.resolution
      && intent.intentId === this.latestIntentValue?.intentId
    );
  }

  request(
    intent: ContractResolutionIntent,
    options: { canStart?: boolean } = {},
  ): ContractResolutionIntentDecision {
    const nextResolution = normalizeContractResolutionValue(intent.resolution);
    if (!this.isLatestIntent(intent)) {
      return { action: 'stale', snapshot: this.snapshotValue() };
    }
    if (!nextResolution) {
      return { action: 'noop', snapshot: this.snapshotValue() };
    }
    if (this.inFlightResolution) {
      this.pendingResolution = nextResolution === this.inFlightResolution ? null : intent;
      return {
        action: this.pendingResolution ? 'pending' : 'noop',
        snapshot: this.snapshotValue(),
      };
    }
    if (options.canStart === false) {
      this.pendingResolution = nextResolution === this.currentResolution ? null : intent;
      return {
        action: this.pendingResolution ? 'pending' : 'noop',
        snapshot: this.snapshotValue(),
      };
    }
    if (nextResolution === this.currentResolution) {
      if (this.pendingResolution?.intentId === intent.intentId) this.pendingResolution = null;
      return { action: 'noop', snapshot: this.snapshotValue() };
    }
    if (this.pendingResolution?.intentId === intent.intentId) this.pendingResolution = null;
    const token = this.start(intent);
    return { action: 'start', token, snapshot: this.snapshotValue() };
  }

  private drainPending(): ContractResolutionIntentDecision {
    if (this.inFlightResolution || !this.pendingResolution) {
      return { action: 'noop', snapshot: this.snapshotValue() };
    }
    const pendingIntent = this.pendingResolution;
    this.pendingResolution = null;
    if (!this.isLatestIntent(pendingIntent)) {
      return { action: 'stale', snapshot: this.snapshotValue() };
    }
    if (pendingIntent.resolution === this.currentResolution) {
      return { action: 'noop', snapshot: this.snapshotValue() };
    }
    const token = this.start(pendingIntent);
    return { action: 'start', token, snapshot: this.snapshotValue() };
  }

  isCurrent(token: ContractResolutionIntentToken | null | undefined) {
    return Boolean(
      token
      && token.requestSequence === this.requestSequence
      && token.intentId > 0
      && token.resolution === this.inFlightResolution
    );
  }

  canStart(token: ContractResolutionIntentToken | null | undefined) {
    return Boolean(this.isCurrent(token) && this.isLatestIntent(token));
  }

  commit(token: ContractResolutionIntentToken): ContractResolutionIntentSettlement {
    if (!this.isCurrent(token)) {
      return { accepted: false, snapshot: this.snapshotValue() };
    }
    this.currentResolution = token.resolution;
    this.inFlightResolution = '';
    const decision = this.drainPending();
    return {
      accepted: true,
      nextToken: decision.token,
      snapshot: decision.snapshot,
    };
  }

  fail(token: ContractResolutionIntentToken): ContractResolutionIntentSettlement {
    if (!this.isCurrent(token)) {
      return { accepted: false, snapshot: this.snapshotValue() };
    }
    this.inFlightResolution = '';
    const decision = this.drainPending();
    return {
      accepted: true,
      nextToken: decision.token,
      snapshot: decision.snapshot,
    };
  }
}

function createContractResolutionClock(): ContractChartLoadingClock {
  return {
    now: () => Date.now(),
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
}

export async function confirmContractResolutionReady(
  chart: TradingViewChartApi | null,
  requestedResolution: string,
) {
  const target = normalizeContractResolutionValue(requestedResolution);
  if (typeof chart?.dataReady !== 'function') {
    return { ok: false as const, activeResolution: '', reason: 'dataReady unavailable' };
  }

  try {
    const ready = await chart.dataReady();
    if (ready === false) {
      return { ok: false as const, activeResolution: '', reason: 'dataReady returned false' };
    }
  } catch (error) {
    return { ok: false as const, activeResolution: '', reason: 'dataReady rejected', error };
  }

  const activeResolution = readContractActiveTradingViewResolution(chart);
  if (!activeResolution) {
    return { ok: false as const, activeResolution: '', reason: 'resolution unavailable' };
  }
  if (activeResolution !== target) {
    return {
      ok: false as const,
      activeResolution,
      reason: 'resolution mismatch',
    };
  }
  return { ok: true as const, activeResolution, reason: 'ready' };
}

export function requestContractSetResolution({
  chart,
  resolution,
  isCurrent,
  onCommitted,
  onFailed,
  onSettled,
  onFallback,
  clock = createContractResolutionClock(),
  timeoutMs = CONTRACT_SET_RESOLUTION_TIMEOUT_MS,
}: ContractResolutionRequestParams): ContractResolutionRequest {
  const targetResolution = normalizeContractResolutionValue(resolution);
  let finished = false;
  let timeoutHandle: unknown = null;
  let resolveCompletion: () => void = () => undefined;
  const completion = new Promise<void>((resolve) => {
    resolveCompletion = resolve;
  }) as ContractResolutionRequest;

  const clearRequestTimeout = () => {
    if (timeoutHandle === null) return;
    clock.clearTimeout(timeoutHandle);
    timeoutHandle = null;
  };

  const completeRequest = () => {
    clearRequestTimeout();
    resolveCompletion();
  };

  const settleOnce = (reason: string, authoritative = false) => {
    if (finished) return;
    const activeResolution = readContractActiveTradingViewResolution(chart);
    if (!authoritative && activeResolution && activeResolution !== targetResolution) {
      fallbackOnce('setResolution commit mismatch');
      return;
    }
    finished = true;
    completeRequest();
    if (!isCurrent()) return;
    onCommitted?.(reason, activeResolution || targetResolution);
    onSettled?.(activeResolution || targetResolution);
  };

  const fallbackOnce = (reason: string, error?: unknown) => {
    if (finished) return;
    finished = true;
    completeRequest();
    if (!isCurrent()) return;
    onFailed?.(reason, error);
    onFallback?.(reason, error);
  };

  const setResolution = chart?.setResolution;
  if (typeof setResolution !== 'function') {
    fallbackOnce('setResolution unavailable');
  } else {
    timeoutHandle = clock.setTimeout(() => {
      timeoutHandle = null;
      const activeResolution = readContractActiveTradingViewResolution(chart);
      if (activeResolution === targetResolution) {
        settleOnce('setResolution timeout confirmed by chart resolution');
        return;
      }
      fallbackOnce('setResolution timeout');
    }, Math.max(0, timeoutMs));

    const confirmLegacyCompletion = () => {
      if (finished || typeof chart?.dataReady !== 'function') return;
      void confirmContractResolutionReady(chart, targetResolution).then((confirmation) => {
        if (confirmation.ok) {
          settleOnce('dataReady confirmed');
          return;
        }
        fallbackOnce(
          confirmation.reason,
          'error' in confirmation ? confirmation.error : undefined,
        );
      });
    };

    try {
      const result = setResolution.call(chart, targetResolution, {
        dataReady: () => settleOnce('dataReady callback', true),
      });
      if (result === false) {
        fallbackOnce('setResolution returned false');
      } else if (result === true) {
        if (typeof chart?.dataReady === 'function') confirmLegacyCompletion();
        else settleOnce('setResolution returned true');
      } else if (result && typeof result.then === 'function') {
        void result.then((changed) => {
          if (changed === false) {
            fallbackOnce('setResolution returned false');
            return;
          }
          if (typeof chart?.dataReady === 'function') confirmLegacyCompletion();
          else settleOnce('setResolution promise resolved');
        }).catch((error: unknown) => {
          fallbackOnce('setResolution rejected', error);
        });
      } else {
        confirmLegacyCompletion();
      }
    } catch (error) {
      fallbackOnce('setResolution threw', error);
    }
  }

  completion.cancel = () => {
    if (finished) return;
    finished = true;
    completeRequest();
  };
  return completion;
}

export class ContractChartLoadingCoordinator {
  private readonly onChange: (reason: string) => void;
  private readonly clock: ContractChartLoadingClock;
  private readonly minVisibleMs: number;
  private readonly safetyTimeoutMs: number;
  private sequence = 0;
  private startedAt = 0;
  private finishScheduledSeq = 0;
  private finishTimer: unknown = null;
  private safetyTimer: unknown = null;
  private destroyed = false;

  constructor({
    onChange,
    clock,
    minVisibleMs = CONTRACT_CHART_LOADING_MIN_VISIBLE_MS,
    safetyTimeoutMs = CONTRACT_CHART_LOADING_SAFETY_TIMEOUT_MS,
  }: ContractChartLoadingCoordinatorOptions) {
    this.onChange = onChange;
    this.clock = clock || {
      now: () => Date.now(),
      setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
      clearTimeout: (handle) => window.clearTimeout(handle as number),
    };
    this.minVisibleMs = minVisibleMs;
    this.safetyTimeoutMs = safetyTimeoutMs;
  }

  private clearTimers() {
    if (this.finishTimer !== null) {
      this.clock.clearTimeout(this.finishTimer);
      this.finishTimer = null;
    }
    if (this.safetyTimer !== null) {
      this.clock.clearTimeout(this.safetyTimer);
      this.safetyTimer = null;
    }
  }

  start(reason: string) {
    if (this.destroyed) return this.sequence;
    this.clearTimers();
    this.sequence += 1;
    const sequence = this.sequence;
    this.startedAt = this.clock.now();
    this.finishScheduledSeq = 0;
    this.onChange(reason);
    this.safetyTimer = this.clock.setTimeout(() => {
      this.safetyTimer = null;
      this.finish(sequence);
    }, this.safetyTimeoutMs);
    return sequence;
  }

  finish(sequence: number) {
    if (
      this.destroyed
      || sequence !== this.sequence
      || this.finishScheduledSeq === sequence
    ) {
      return false;
    }

    this.finishScheduledSeq = sequence;
    if (this.safetyTimer !== null) {
      this.clock.clearTimeout(this.safetyTimer);
      this.safetyTimer = null;
    }
    const elapsedMs = Math.max(0, this.clock.now() - this.startedAt);
    const delayMs = Math.max(0, this.minVisibleMs - elapsedMs);
    this.finishTimer = this.clock.setTimeout(() => {
      this.finishTimer = null;
      if (this.destroyed || sequence !== this.sequence) return;
      this.finishScheduledSeq = 0;
      this.onChange('');
    }, delayMs);
    return true;
  }

  currentSequence() {
    return this.sequence;
  }

  destroy() {
    this.destroyed = true;
    this.sequence += 1;
    this.finishScheduledSeq = 0;
    this.clearTimers();
  }
}

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

function resolveContractIntervalForResolution(
  resolution: string,
  intervals: string[],
  fallbackInterval: string,
) {
  const normalizedResolution = normalizeContractResolutionValue(resolution);
  return intervals.find(
    (item) => contractIntervalToTradingViewResolution(item) === normalizedResolution,
  ) || fallbackInterval;
}

function styleToolbarButton(button: HTMLButtonElement, active: boolean) {
  button.dataset.active = active ? '1' : '0';
  button.style.color = active ? '#f0b90b' : 'rgba(255,255,255,0.58)';
  button.style.cursor = 'pointer';
}

function updateToolbarButtons(
  buttons: Map<string, HTMLButtonElement>,
  chartMode: ContractChartMode,
  candleInterval: string,
) {
  buttons.forEach((button, key) => {
    styleToolbarButton(button, isContractToolbarButtonActive(key, chartMode, candleInterval));
  });
}

function createToolbarButton(params: {
  owner: Document;
  key: string;
  label: string;
  active: boolean;
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
  styleToolbarButton(button, params.active);
  button.addEventListener('mouseenter', () => {
    if (button.dataset.active !== '1') button.style.color = 'rgba(255,255,255,0.86)';
  });
  button.addEventListener('mouseleave', () => {
    if (button.dataset.active !== '1') button.style.color = 'rgba(255,255,255,0.58)';
  });
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    params.onClick();
  });
  return button;
}

function getTradingViewGlobal() {
  return (window as unknown as ContractTradingViewWindow).TradingView;
}

export default function ContractTradingViewChart({
  symbol,
  category,
  displaySymbol,
  interval,
  chartMode,
  intervalOptions,
  height = 520,
  pricePrecision,
  amountPrecision,
  displayPrice = null,
  priceDirection = 'flat',
  onChartModeChange,
  onIntervalChange,
  onLatestKlineCloseChange,
}: ContractTradingViewChartProps) {
  const { locale, t } = useLocaleContext();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const widgetRef = useRef<TradingViewWidgetInstance | null>(null);
  const datafeedRef = useRef<ReturnType<typeof createContractTradingViewDatafeed> | null>(null);
  const priceOverlayControllerRef = useRef<ContractTradingViewPriceOverlayController | null>(null);
  const priceOverlayLifecycleRef = useRef<ContractPriceOverlayLifecycle | null>(null);
  const overlayIntervalRef = useRef('');
  const preloadManagerRef = useRef<ReturnType<typeof createContractKlinePreloadManager> | null>(null);
  const toolbarButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const toolbarSlotRef = useRef<HTMLElement | null>(null);
  const chartReadyRef = useRef(false);
  const resolutionIntentCoordinatorRef = useRef(new ContractResolutionIntentCoordinator());
  const resolutionRequestRef = useRef<ContractResolutionRequest | null>(null);
  const widgetGenerationSequenceRef = useRef(0);
  const activeWidgetGenerationRef = useRef(0);
  const requestedResolutionRef = useRef('');
  const committedResolutionRef = useRef('');
  const activeTradingViewResolutionRef = useRef('');
  const pendingResolutionLoadingSeqRef = useRef(0);
  const inFlightResolutionRef = useRef('');
  const resolutionRequestSeqRef = useRef(0);
  const datafeedBuildSeqRef = useRef(0);
  const latestHistoryRequestSeqRef = useRef(0);
  const preloadForegroundGenerationRef = useRef(0);
  const pendingInitialVisibleRangeRef = useRef<ContractHistoryBarsEvent | null>(null);
  const initialVisibleRangeAppliedKeyRef = useRef('');
  const initialVisibleRangeInFlightKeyRef = useRef('');
  const initialVisibleRangeApplySeqRef = useRef(0);
  const flushPendingInitialVisibleRangeRef = useRef<(resolution: string) => void>(() => undefined);
  const activeChartLoadingSeqRef = useRef(0);
  const reactId = useId();
  const containerId = useMemo(
    () => `contract-tv-chart-${reactId.replace(/[^a-zA-Z0-9_-]/g, '')}`,
    [reactId],
  );
  const normalizedSymbol = useMemo(() => normalizeTradingViewSymbol(symbol), [symbol]);
  const canonicalCategory = useMemo(
    () => normalizeContractKlineAssetClass(category),
    [category],
  );
  const activeIntervals = useMemo(
    () => (intervalOptions?.length ? intervalOptions : DEFAULT_INTERVAL_OPTIONS)
      .filter((item) => Boolean(String(item || '').trim())),
    [intervalOptions],
  );
  const activeInterval = activeIntervals.includes(interval) ? interval : activeIntervals[0] || '1m';
  const effectiveInterval = resolveContractEffectiveKlineInterval(chartMode, activeInterval);
  const widgetInterval = contractIntervalToTradingViewResolution(effectiveInterval);
  const displayName = displaySymbol || normalizedSymbol;
  const widgetKey = buildContractWidgetIdentityKey({
    symbol: normalizedSymbol,
    category: canonicalCategory,
    locale,
    pricePrecision,
    amountPrecision,
    chartMode,
    fallbackNonce: 0,
  });
  const [scriptReady, setScriptReady] = useState(
    () => typeof window !== 'undefined' && Boolean(getTradingViewGlobal()?.widget),
  );
  const [loadError, setLoadError] = useState<TradingViewLoadError | null>(null);
  const [chartLoadingReason, setChartLoadingReason] = useState('');
  const activeLoadError = loadError?.key === widgetKey ? loadError.message : '';
  const showChartLoading = shouldShowContractChartLoading(chartLoadingReason, activeLoadError);

  const normalizedSymbolRef = useRef(normalizedSymbol);
  const activeIntervalsRef = useRef(activeIntervals);
  const activeIntervalRef = useRef(activeInterval);
  const effectiveIntervalRef = useRef(effectiveInterval);
  const widgetIntervalRef = useRef(widgetInterval);
  const chartModeRef = useRef(chartMode);
  const displayNameRef = useRef(displayName);
  const canonicalCategoryRef = useRef(canonicalCategory);
  const displayPriceRef = useRef(displayPrice);
  const priceDirectionRef = useRef(priceDirection);
  const widgetKeyRef = useRef(widgetKey);
  const onChartModeChangeRef = useRef(onChartModeChange);
  const onIntervalChangeRef = useRef(onIntervalChange);
  const onLatestKlineCloseChangeRef = useRef(onLatestKlineCloseChange);

  const [loadingCoordinator] = useState(() => (
    new ContractChartLoadingCoordinator({
      onChange: setChartLoadingReason,
    })
  ));

  useEffect(() => {
    normalizedSymbolRef.current = normalizedSymbol;
    activeIntervalsRef.current = activeIntervals;
    activeIntervalRef.current = activeInterval;
    effectiveIntervalRef.current = effectiveInterval;
    widgetIntervalRef.current = widgetInterval;
    chartModeRef.current = chartMode;
    displayNameRef.current = displayName;
    canonicalCategoryRef.current = canonicalCategory;
    displayPriceRef.current = displayPrice;
    priceDirectionRef.current = priceDirection;
    widgetKeyRef.current = widgetKey;
    onChartModeChangeRef.current = onChartModeChange;
    onIntervalChangeRef.current = onIntervalChange;
    onLatestKlineCloseChangeRef.current = onLatestKlineCloseChange;
  }, [
    activeInterval,
    activeIntervals,
    chartMode,
    canonicalCategory,
    displayPrice,
    displayName,
    effectiveInterval,
    normalizedSymbol,
    onChartModeChange,
    onIntervalChange,
    onLatestKlineCloseChange,
    priceDirection,
    widgetInterval,
    widgetKey,
  ]);

  const getPriceOverlayLifecycle = useCallback(() => {
    if (!priceOverlayLifecycleRef.current) {
      priceOverlayLifecycleRef.current = new ContractPriceOverlayLifecycle(
        () => priceOverlayControllerRef.current,
      );
    }
    return priceOverlayLifecycleRef.current;
  }, []);

  const priceOverlayInput = useCallback((interval?: string): ContractPriceOverlayInput => ({
      symbol: normalizedSymbolRef.current,
      interval: interval || overlayIntervalRef.current || effectiveIntervalRef.current,
      displayPrice: displayPriceRef.current,
      priceDirection: priceDirectionRef.current,
  }), []);

  const updatePriceOverlay = useCallback(() => {
    getPriceOverlayLifecycle().update(priceOverlayInput());
  }, [getPriceOverlayLifecycle, priceOverlayInput]);

  const suspendPriceOverlay = useCallback(() => {
    getPriceOverlayLifecycle().suspend();
  }, [getPriceOverlayLifecycle]);

  const resumePriceOverlay = useCallback((interval?: string) => {
    const nextInterval = interval || overlayIntervalRef.current || effectiveIntervalRef.current;
    overlayIntervalRef.current = nextInterval;
    getPriceOverlayLifecycle().resume(priceOverlayInput(nextInterval));
  }, [getPriceOverlayLifecycle, priceOverlayInput]);

  const getPreloadManager = useCallback(() => {
    if (!preloadManagerRef.current) {
      preloadManagerRef.current = createContractKlinePreloadManager({
        getState: () => ({
          symbol: normalizedSymbolRef.current,
          category: canonicalCategoryRef.current,
          interval: effectiveIntervalRef.current,
        }),
      });
    }
    return preloadManagerRef.current;
  }, []);

  const pausePreloadForeground = useCallback((interval: string) => {
    const generation = preloadForegroundGenerationRef.current + 1;
    preloadForegroundGenerationRef.current = generation;
    getPreloadManager().setForegroundState({
      loading: true,
      symbol: normalizedSymbolRef.current,
      interval,
      generation,
    });
    return generation;
  }, [getPreloadManager]);

  const resumePreloadForeground = useCallback((event: ContractHistoryBarsEvent | ContractHistoryErrorEvent) => {
    getPreloadManager().setForegroundState({
      loading: false,
      symbol: event.symbol,
      interval: event.interval,
      generation: preloadForegroundGenerationRef.current,
    });
  }, [getPreloadManager]);

  useEffect(() => {
    updatePriceOverlay();
  }, [displayPrice, priceDirection, updatePriceOverlay]);

  const startChartLoading = useCallback((reason: string) => {
    setLoadError(null);
    const sequence = loadingCoordinator.start(reason);
    activeChartLoadingSeqRef.current = sequence;
    return sequence;
  }, [loadingCoordinator]);

  const finishChartLoading = useCallback((sequence: number) => {
    loadingCoordinator.finish(sequence);
  }, [loadingCoordinator]);

  const restoreToolbarInteraction = useCallback((buildSeq: number) => {
    window.requestAnimationFrame(() => {
      if (datafeedBuildSeqRef.current !== buildSeq) return;
      setSpotToolbarLoadingState(toolbarSlotRef.current, toolbarButtonRefs.current, {
        loading: false,
      });
    });
  }, []);

  const applyWidgetResolution = useCallback((
    nextResolution: string,
    widgetGeneration = activeWidgetGenerationRef.current,
  ) => {
    const normalizedResolution = String(nextResolution || '').trim();
    if (
      !normalizedResolution
      || !widgetGeneration
      || activeWidgetGenerationRef.current !== widgetGeneration
    ) return;
    const widget = widgetRef.current;
    const coordinator = resolutionIntentCoordinatorRef.current;
    const latestIntent = coordinator.latestIntent();
    const intent = latestIntent?.resolution === normalizedResolution
      ? latestIntent
      : coordinator.registerIntent(normalizedResolution).intent;
    requestedResolutionRef.current = normalizedResolution;
    const decision = coordinator.request(intent, {
      canStart: Boolean(widget && chartReadyRef.current),
    });

    if (decision.action === 'stale') return;
    if (decision.action === 'noop') {
      inFlightResolutionRef.current = decision.snapshot.inFlightResolution;
      if (
        decision.snapshot.currentResolution === normalizedResolution
        && !decision.snapshot.inFlightResolution
      ) {
        committedResolutionRef.current = normalizedResolution;
        activeTradingViewResolutionRef.current = normalizedResolution;
      }
      return;
    }

    suspendPriceOverlay();
    pausePreloadForeground(effectiveIntervalRef.current);
    pendingInitialVisibleRangeRef.current = null;
    initialVisibleRangeAppliedKeyRef.current = '';
    initialVisibleRangeInFlightKeyRef.current = '';
    initialVisibleRangeApplySeqRef.current += 1;
    pendingResolutionLoadingSeqRef.current = startChartLoading('set-resolution');

    if (decision.action === 'pending') {
      inFlightResolutionRef.current = decision.snapshot.inFlightResolution;
      return;
    }
    if (!widget || !decision.token) return;

    const runResolutionRequest = (token: ContractResolutionIntentToken) => {
      if (!coordinator.canStart(token)) return;
      const targetResolution = token.resolution;
      const requestSeq = ++resolutionRequestSeqRef.current;
      inFlightResolutionRef.current = targetResolution;
      resolutionRequestRef.current?.cancel();

      const settleForeground = (resolution: string) => {
        const interval = resolveContractIntervalForResolution(
          resolution,
          activeIntervalsRef.current,
          activeIntervalRef.current,
        );
        getPreloadManager().setForegroundState({
          loading: false,
          symbol: normalizedSymbolRef.current,
          interval,
          generation: token.requestSequence,
        });
        return interval;
      };

      const rollbackChartToStableResolution = (
        stableResolution: string,
        onRollbackSettled: () => void,
      ) => {
        let rollbackSettled = false;
        const settleRollbackOnce = () => {
          if (rollbackSettled) return;
          rollbackSettled = true;
          onRollbackSettled();
        };
        if (!stableResolution) {
          settleRollbackOnce();
          return;
        }
        const activeChart = widget.activeChart?.() || null;
        const observedResolution = readContractActiveTradingViewResolution(activeChart);
        activeTradingViewResolutionRef.current = observedResolution;
        if (observedResolution === stableResolution) {
          settleRollbackOnce();
          return;
        }

        const rollbackRequestSeq = ++resolutionRequestSeqRef.current;
        let rollbackRequest: ContractResolutionRequest | null = null;
        let settledSynchronously = false;
        const clearRollbackRequest = () => {
          if (!rollbackRequest) {
            settledSynchronously = true;
            return;
          }
          if (resolutionRequestRef.current === rollbackRequest) {
            resolutionRequestRef.current = null;
          }
        };
        const createdRollbackRequest = requestContractSetResolution({
          chart: activeChart,
          resolution: stableResolution,
          isCurrent: () => (
            resolutionRequestSeqRef.current === rollbackRequestSeq
            && widgetRef.current === widget
            && activeWidgetGenerationRef.current === widgetGeneration
          ),
          onCommitted: (_reason, activeResolution) => {
            clearRollbackRequest();
            activeTradingViewResolutionRef.current = activeResolution || stableResolution;
            settleRollbackOnce();
          },
          onFailed: () => {
            clearRollbackRequest();
            settleRollbackOnce();
          },
        });
        rollbackRequest = createdRollbackRequest;
        if (!settledSynchronously) resolutionRequestRef.current = createdRollbackRequest;
      };

      let request: ContractResolutionRequest | null = null;
      let settledSynchronously = false;
      const clearActiveRequest = () => {
        if (!request) {
          settledSynchronously = true;
          return;
        }
        if (resolutionRequestRef.current === request) resolutionRequestRef.current = null;
      };
      const createdRequest = requestContractSetResolution({
        chart: widget.activeChart?.() || null,
        resolution: targetResolution,
        isCurrent: () => (
          resolutionRequestSeqRef.current === requestSeq
          && coordinator.isCurrent(token)
          && widgetRef.current === widget
          && activeWidgetGenerationRef.current === widgetGeneration
        ),
        onCommitted: (_reason, activeResolution) => {
          clearActiveRequest();
          const settlement = coordinator.commit(token);
          if (!settlement.accepted) return;
          committedResolutionRef.current = targetResolution;
          activeTradingViewResolutionRef.current = activeResolution || targetResolution;
          inFlightResolutionRef.current = settlement.snapshot.inFlightResolution;

          if (settlement.nextToken) {
            requestedResolutionRef.current = settlement.nextToken.resolution;
            runResolutionRequest(settlement.nextToken);
            return;
          }

          requestedResolutionRef.current = targetResolution;
          settleForeground(targetResolution);
          finishChartLoading(pendingResolutionLoadingSeqRef.current);
          flushPendingInitialVisibleRangeRef.current(targetResolution);
        },
        onFailed: () => {
          clearActiveRequest();
          const settlement = coordinator.fail(token);
          if (!settlement.accepted) return;
          inFlightResolutionRef.current = settlement.snapshot.inFlightResolution;

          if (settlement.nextToken) {
            requestedResolutionRef.current = settlement.nextToken.resolution;
            runResolutionRequest(settlement.nextToken);
            return;
          }

          const stableResolution = settlement.snapshot.currentResolution;
          const stableInterval = settleForeground(stableResolution);
          requestedResolutionRef.current = stableResolution;
          committedResolutionRef.current = stableResolution;
          rollbackChartToStableResolution(
            stableResolution,
            () => resumePriceOverlay(stableInterval),
          );
          updateToolbarButtons(
            toolbarButtonRefs.current,
            chartModeRef.current,
            stableInterval,
          );
          finishChartLoading(pendingResolutionLoadingSeqRef.current);
          if (stableInterval && activeIntervalRef.current !== stableInterval) {
            onIntervalChangeRef.current?.(stableInterval);
          }
        },
      });
      request = createdRequest;
      if (!settledSynchronously) resolutionRequestRef.current = createdRequest;
    };

    runResolutionRequest(decision.token);
  }, [
    finishChartLoading,
    getPreloadManager,
    pausePreloadForeground,
    resumePriceOverlay,
    startChartLoading,
    suspendPriceOverlay,
  ]);

  useEffect(() => () => {
    loadingCoordinator.destroy();
  }, [loadingCoordinator]);

  useEffect(() => () => {
    preloadManagerRef.current?.destroy();
    preloadManagerRef.current = null;
  }, []);

  useEffect(() => {
    let cancelled = false;
    let widgetGeneration = 0;
    let chartReadyTimer: number | null = null;
    let widgetBuildLoadingTimer: number | null = null;
    let widgetBuildCompleted = false;

    const cleanupWidget = (generation = activeWidgetGenerationRef.current) => {
      if (
        generation
        && activeWidgetGenerationRef.current
        && activeWidgetGenerationRef.current !== generation
      ) return;
      activeWidgetGenerationRef.current = 0;
      chartReadyRef.current = false;
      resolutionRequestRef.current?.cancel();
      resolutionRequestRef.current = null;
      resolutionIntentCoordinatorRef.current.reset('');
      priceOverlayLifecycleRef.current?.destroy();
      priceOverlayLifecycleRef.current = null;
      priceOverlayControllerRef.current = null;
      overlayIntervalRef.current = '';
      preloadManagerRef.current?.cancel('contract chart widget cleanup');
      pendingInitialVisibleRangeRef.current = null;
      initialVisibleRangeAppliedKeyRef.current = '';
      initialVisibleRangeInFlightKeyRef.current = '';
      initialVisibleRangeApplySeqRef.current += 1;
      flushPendingInitialVisibleRangeRef.current = () => undefined;
      resolutionRequestSeqRef.current += 1;
      requestedResolutionRef.current = '';
      committedResolutionRef.current = '';
      activeTradingViewResolutionRef.current = '';
      inFlightResolutionRef.current = '';
      toolbarButtonRefs.current.clear();
      toolbarSlotRef.current = null;
      datafeedRef.current?.destroy();
      datafeedRef.current = null;
      try {
        widgetRef.current?.remove();
      } catch {
        // TradingView cleanup remains best-effort during allowed rebuilds.
      }
      widgetRef.current = null;
    };

    const disposeEffect = () => {
      cancelled = true;
      if (chartReadyTimer !== null) window.clearTimeout(chartReadyTimer);
      if (widgetBuildLoadingTimer !== null) window.clearTimeout(widgetBuildLoadingTimer);
      cleanupWidget(widgetGeneration);
    };

    cleanupWidget(activeWidgetGenerationRef.current);
    if (!scriptReady || !normalizedSymbol || !containerRef.current) {
      return disposeEffect;
    }

    const tradingView = getTradingViewGlobal();
    if (!tradingView?.widget) {
      chartReadyTimer = window.setTimeout(() => {
        if (cancelled) return;
        setLoadError({ key: widgetKey, message: '图表组件暂不可用' });
        finishChartLoading(activeChartLoadingSeqRef.current);
      }, 0);
      return disposeEffect;
    }

    const initialResolution = widgetIntervalRef.current;
    const initialStyle = resolveContractWidgetStyle(chartModeRef.current);
    widgetGeneration = ++widgetGenerationSequenceRef.current;
    activeWidgetGenerationRef.current = widgetGeneration;
    const buildSeq = datafeedBuildSeqRef.current + 1;
    datafeedBuildSeqRef.current = buildSeq;
    latestHistoryRequestSeqRef.current = 0;
    pausePreloadForeground(effectiveIntervalRef.current);
    overlayIntervalRef.current = effectiveIntervalRef.current;
    suspendPriceOverlay();
    chartReadyRef.current = false;
    resolutionIntentCoordinatorRef.current.reset(initialResolution);
    requestedResolutionRef.current = initialResolution;
    committedResolutionRef.current = initialResolution;
    activeTradingViewResolutionRef.current = initialResolution;
    inFlightResolutionRef.current = '';
    widgetBuildLoadingTimer = window.setTimeout(() => {
      widgetBuildLoadingTimer = null;
      if (
        !cancelled
        && !widgetBuildCompleted
        && activeWidgetGenerationRef.current === widgetGeneration
      ) {
        activeChartLoadingSeqRef.current = startChartLoading('widget-build');
      }
    }, 0);

    const eventMatchesCurrentChart = (event: ContractHistoryBarsEvent | ContractHistoryErrorEvent) => (
      !cancelled
      && datafeedBuildSeqRef.current === buildSeq
      && isContractHistoryEventCurrent(event, {
        symbol: normalizedSymbolRef.current,
        interval: effectiveIntervalRef.current,
        resolution: requestedResolutionRef.current || widgetIntervalRef.current,
        minimumRequestSeq: latestHistoryRequestSeqRef.current,
      })
    );

    const applyInitialVisibleRange = (event: ContractHistoryBarsEvent) => {
      if (!event.firstDataRequest || !eventMatchesCurrentChart(event)) return;
      if (!event.lastBarTime) {
        resumePreloadForeground(event);
        return;
      }
      const rangeInfo = resolveContractInitialVisibleRange(event.interval, event.lastBarTime);
      if (!rangeInfo) {
        resumePreloadForeground(event);
        return;
      }
      const applyKey = [event.symbol, event.interval, event.resolution, event.requestSeq].join('|');
      if (initialVisibleRangeAppliedKeyRef.current === applyKey) {
        resumePreloadForeground(event);
        return;
      }
      if (initialVisibleRangeInFlightKeyRef.current === applyKey) return;

      if (
        (
          requestedResolutionRef.current === event.resolution
          && committedResolutionRef.current !== event.resolution
        )
        || inFlightResolutionRef.current === event.resolution
      ) {
        pendingInitialVisibleRangeRef.current = event;
        return;
      }

      const activeWidget = widgetRef.current;
      const chart = activeWidget?.activeChart?.() || null;
      if (!activeWidget || !chartReadyRef.current || typeof chart?.setVisibleRange !== 'function') {
        pendingInitialVisibleRangeRef.current = event;
        return;
      }

      initialVisibleRangeInFlightKeyRef.current = applyKey;
      pendingInitialVisibleRangeRef.current = null;
      const applySeq = ++initialVisibleRangeApplySeqRef.current;
      const isCurrentViewportIntent = () => (
        initialVisibleRangeApplySeqRef.current === applySeq
        && datafeedBuildSeqRef.current === buildSeq
        && widgetRef.current === activeWidget
        && normalizedSymbolRef.current === event.symbol
        && effectiveIntervalRef.current === event.interval
        && requestedResolutionRef.current === event.resolution
        && latestHistoryRequestSeqRef.current === event.requestSeq
      );
      void applyTradingViewViewport({
        chart,
        range: rangeInfo.range,
        fallbackRange: rangeInfo.fallbackRange,
        intervalSeconds: rangeInfo.intervalSeconds,
        rightPaddingBars: rangeInfo.rightPaddingBars,
        isCurrent: isCurrentViewportIntent,
        maxRetries: 1,
      }).then((result) => {
        if (initialVisibleRangeInFlightKeyRef.current === applyKey) {
          initialVisibleRangeInFlightKeyRef.current = '';
        }
        if (!isCurrentViewportIntent()) return;
        initialVisibleRangeAppliedKeyRef.current = result.applied ? applyKey : '';
        resumePreloadForeground(event);
      }).catch(() => {
        if (isCurrentViewportIntent()) resumePreloadForeground(event);
      });
    };

    flushPendingInitialVisibleRangeRef.current = (resolution) => {
      const pendingEvent = pendingInitialVisibleRangeRef.current;
      if (!pendingEvent || pendingEvent.resolution !== resolution) return;
      applyInitialVisibleRange(pendingEvent);
    };

    const datafeed = createContractTradingViewDatafeed({
      symbol: normalizedSymbol,
      category: canonicalCategory,
      displaySymbol: displayNameRef.current,
      pricePrecision,
      amountPrecision,
      onLatestBar: (price) => onLatestKlineCloseChangeRef.current?.(price),
      onHistoryBars: (event) => {
        if (!event.firstDataRequest || !eventMatchesCurrentChart(event)) return;
        widgetBuildCompleted = true;
        if (widgetBuildLoadingTimer !== null) {
          window.clearTimeout(widgetBuildLoadingTimer);
          widgetBuildLoadingTimer = null;
        }
        latestHistoryRequestSeqRef.current = event.requestSeq;
        resumePriceOverlay(event.interval);
        getPreloadManager().schedule(event);
        applyInitialVisibleRange(event);
        setLoadError(null);
        finishChartLoading(activeChartLoadingSeqRef.current);
      },
      onHistoryError: (event) => {
        if (!event.firstDataRequest || !eventMatchesCurrentChart(event)) return;
        widgetBuildCompleted = true;
        if (widgetBuildLoadingTimer !== null) {
          window.clearTimeout(widgetBuildLoadingTimer);
          widgetBuildLoadingTimer = null;
        }
        latestHistoryRequestSeqRef.current = event.requestSeq;
        resumePriceOverlay(event.interval);
        setLoadError({ key: widgetKeyRef.current, message: event.error });
        resumePreloadForeground(event);
        finishChartLoading(activeChartLoadingSeqRef.current);
      },
    });
    datafeedRef.current = datafeed;

    const widget = new tradingView.widget({
      autosize: true,
      symbol: normalizedSymbol,
      interval: initialResolution,
      container: containerId,
      datafeed,
      library_path: TRADINGVIEW_LIBRARY_PATH,
      locale: resolveTradingViewLocale(locale),
      timezone: TRADINGVIEW_TIMEZONE,
      theme: 'dark',
      style: initialStyle,
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
        'mainSeriesProperties.style': initialStyle,
        ...CONTRACT_TV_PRICE_LABEL_OVERRIDES,
        ...CONTRACT_TIME_SERIES_OVERRIDES,
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

    const markChartReady = () => {
      if (
        cancelled
        || widgetRef.current !== widget
        || activeWidgetGenerationRef.current !== widgetGeneration
      ) return;
      widget.applyOverrides?.({
        ...CONTRACT_TV_PRICE_LABEL_OVERRIDES,
        ...CONTRACT_TIME_SERIES_OVERRIDES,
      });
      const chart = widget.activeChart();
      if (
        chart.createShape
        && chart.getShapeById
        && chart.removeEntity
        && !priceOverlayControllerRef.current
      ) {
        priceOverlayControllerRef.current = new ContractTradingViewPriceOverlayController(
          chart as ContractTradingViewOverlayChart,
        );
      }
      if (chartModeRef.current === 'time') {
        chart.getSeries?.().setChartStyleProperties?.(
          TRADINGVIEW_TIME_STYLE,
          CONTRACT_TIME_LINE_STYLE_PREFERENCES,
        );
      }
      chartReadyRef.current = true;
      updatePriceOverlay();
      const resolutionState = resolutionIntentCoordinatorRef.current.snapshot();
      const activeResolution = readContractActiveTradingViewResolution(chart);
      activeTradingViewResolutionRef.current = activeResolution || resolutionState.currentResolution;
      committedResolutionRef.current = resolutionState.currentResolution;
      const pendingResolution = resolutionState.pendingResolution;
      if (pendingResolution) {
        applyWidgetResolution(pendingResolution.resolution, widgetGeneration);
      } else {
        const requestedResolution = requestedResolutionRef.current || widgetIntervalRef.current;
        if (requestedResolution !== resolutionState.currentResolution) {
          applyWidgetResolution(requestedResolution, widgetGeneration);
        } else {
          const pendingInitialVisibleRange = pendingInitialVisibleRangeRef.current;
          if (pendingInitialVisibleRange) applyInitialVisibleRange(pendingInitialVisibleRange);
        }
      }
      restoreToolbarInteraction(buildSeq);
    };

    if (typeof widget.chartReady === 'function') {
      void widget.chartReady().then(markChartReady).catch(() => undefined);
    } else if (typeof widget.onChartReady === 'function') {
      widget.onChartReady(markChartReady);
    } else {
      chartReadyTimer = window.setTimeout(markChartReady, 0);
    }

    void widget.headerReady().then(() => {
      if (
        cancelled
        || widgetRef.current !== widget
        || activeWidgetGenerationRef.current !== widgetGeneration
      ) return;
      const toolbarSlot = widget.createButton({ align: 'left', useTradingViewStyle: false });
      toolbarSlotRef.current = toolbarSlot;
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

      const appendButton = (key: string, label: string, onClick: () => void) => {
        const button = createToolbarButton({
          owner: toolbarSlot.ownerDocument,
          key,
          label,
          active: isContractToolbarButtonActive(
            key,
            chartModeRef.current,
            activeIntervalRef.current,
          ),
          onClick,
        });
        toolbarSlot.appendChild(button);
        toolbarButtonRefs.current.set(key, button);
      };

      appendButton(TIME_SHARING_KEY, TIME_SHARING_LABEL, () => {
        if (activeWidgetGenerationRef.current !== widgetGeneration) return;
        const selection = resolveContractToolbarSelection(
          TIME_SHARING_KEY,
          activeIntervalRef.current,
        );
        pausePreloadForeground(selection.interval);
        if (chartModeRef.current !== selection.chartMode) {
          activeChartLoadingSeqRef.current = startChartLoading('toolbar-mode-change');
        }
        chartModeRef.current = selection.chartMode;
        const targetResolution = contractIntervalToTradingViewResolution('1m');
        resolutionIntentCoordinatorRef.current.registerIntent(targetResolution);
        requestedResolutionRef.current = targetResolution;
        updateToolbarButtons(
          toolbarButtonRefs.current,
          selection.chartMode,
          selection.interval,
        );
        onChartModeChangeRef.current?.(selection.chartMode);
      });

      activeIntervalsRef.current.forEach((item) => {
        appendButton(item, formatIntervalLabel(item), () => {
          if (activeWidgetGenerationRef.current !== widgetGeneration) return;
          const selection = resolveContractToolbarSelection(item, activeIntervalRef.current);
          pausePreloadForeground(selection.interval);
          if (
            chartModeRef.current !== selection.chartMode
            || activeIntervalRef.current !== selection.interval
          ) {
            activeChartLoadingSeqRef.current = startChartLoading('toolbar-interval-click');
          }
          const previousMode = chartModeRef.current;
          chartModeRef.current = selection.chartMode;
          const targetResolution = contractIntervalToTradingViewResolution(selection.interval);
          resolutionIntentCoordinatorRef.current.registerIntent(targetResolution);
          requestedResolutionRef.current = targetResolution;
          updateToolbarButtons(
            toolbarButtonRefs.current,
            selection.chartMode,
            selection.interval,
          );
          if (previousMode !== 'candle') onChartModeChangeRef.current?.('candle');
          onIntervalChangeRef.current?.(selection.interval);
        });
      });
      setSpotToolbarLoadingState(toolbarSlot, toolbarButtonRefs.current, { loading: false });
      restoreToolbarInteraction(buildSeq);
    }).catch(() => undefined);

    return disposeEffect;
  }, [
    amountPrecision,
    applyWidgetResolution,
    canonicalCategory,
    chartMode,
    containerId,
    finishChartLoading,
    getPreloadManager,
    locale,
    normalizedSymbol,
    pausePreloadForeground,
    pricePrecision,
    restoreToolbarInteraction,
    resumePriceOverlay,
    resumePreloadForeground,
    scriptReady,
    startChartLoading,
    suspendPriceOverlay,
    updatePriceOverlay,
    widgetKey,
  ]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      applyWidgetResolution(widgetInterval);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [activeInterval, applyWidgetResolution, chartMode, widgetInterval]);

  useEffect(() => {
    updateToolbarButtons(toolbarButtonRefs.current, chartMode, activeInterval);
  }, [activeInterval, chartMode]);

  return (
    <div className="relative flex h-full min-h-[420px] w-full flex-col bg-[#12161c]" style={{ minHeight: height }}>
      <Script
        src={TRADINGVIEW_SCRIPT_SRC}
        strategy="afterInteractive"
        onReady={() => setScriptReady(true)}
        onError={() => {
          setLoadError({ key: widgetKeyRef.current, message: '图表组件加载失败' });
          finishChartLoading(activeChartLoadingSeqRef.current);
        }}
      />
      <div
        id={containerId}
        ref={containerRef}
        className="min-h-0 flex-1"
        aria-label={`${displayName || normalizedSymbol} ${chartMode === 'time' ? 'time' : activeInterval}`}
      />
      {activeLoadError ? (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-[#12161c] px-4 text-center text-sm text-[#f6465d]">
          {t('spotChartLoadFailed', 'asset')}: {activeLoadError}
        </div>
      ) : null}
      {showChartLoading ? (
        <div
          className={CONTRACT_CHART_LOADING_OVERLAY_CLASS_NAME}
          style={{
            backgroundImage:
              'linear-gradient(rgba(255,255,255,0.035) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.035) 1px, transparent 1px)',
            backgroundSize: '80px 58px',
          }}
          aria-hidden="true"
        >
          <div className="flex items-center gap-2 rounded-full border border-white/[0.06] bg-[#0b0e11]/55 px-4 py-3 shadow-[0_18px_50px_rgba(0,0,0,0.36)]">
            {[0, 1, 2, 3].map((item) => (
              <span
                key={item}
                className="h-2 w-2 animate-bounce rounded-full bg-[#f0b90b] shadow-[0_0_14px_rgba(240,185,11,0.72)]"
                style={{ animationDelay: `${item * 110}ms` }}
              />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
