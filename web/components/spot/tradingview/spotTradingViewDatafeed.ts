'use client';

import {
  getSpotKlines,
  normalizeSpotSymbol,
  type SpotMarketKlineItem,
  type SpotMarketTradeItem,
} from '@/lib/api/modules/spot';
import {
  spotMarketRealtime,
  type SpotMarketKlineMessage,
  type SpotMarketRealtimeMessage,
  type SpotMarketTradeMessage,
} from '@/services/marketRealtime';
import { normalizeTimeToSeconds } from '../chart/chart.utils';
import type { SpotChartProps, SpotKlineLoadState } from '../chart/chart.types';

type TradingViewResolution = '1' | '5' | '15' | '60' | '240' | '1D';

type TradingViewBar = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
};

export type SpotTradingViewKlineGapEvent = {
  symbol: string;
  interval: string;
  barTime: number;
  latestBarTime: number;
  gapIntervals: number;
};

type TradingViewLibrarySymbolInfo = {
  name: string;
  ticker: string;
  description: string;
  type: string;
  session: string;
  timezone: string;
  exchange: string;
  listed_exchange: string;
  minmov: number;
  pricescale: number;
  has_intraday: boolean;
  has_daily: boolean;
  has_weekly_and_monthly: boolean;
  supported_resolutions: TradingViewResolution[];
  intraday_multipliers: string[];
  daily_multipliers: string[];
  volume_precision: number;
  data_status: string;
  format: string;
};

type TradingViewSearchSymbolResult = {
  symbol: string;
  full_name: string;
  description: string;
  exchange: string;
  ticker: string;
  type: string;
};

type TradingViewPeriodParams = {
  from: number;
  to: number;
  firstDataRequest?: boolean;
  countBack?: number;
};

type TradingViewDatafeedConfiguration = {
  supports_search: boolean;
  supports_group_request: boolean;
  supports_marks: boolean;
  supports_timescale_marks: boolean;
  supports_time: boolean;
  exchanges: Array<{ value: string; name: string; desc: string }>;
  symbols_types: Array<{ name: string; value: string }>;
  supported_resolutions: TradingViewResolution[];
};

type DatafeedCallbacks = {
  onReady: (configuration: TradingViewDatafeedConfiguration) => void;
  onSearchReady: (items: TradingViewSearchSymbolResult[]) => void;
  onSymbolResolved: (symbolInfo: TradingViewLibrarySymbolInfo) => void;
  onResolveError: (reason: string) => void;
  onHistory: (bars: TradingViewBar[], meta: { noData?: boolean }) => void;
  onHistoryError: (reason: string) => void;
  onRealtime: (bar: TradingViewBar) => void;
};

type SpotTradingViewDatafeed = {
  onReady: (callback: DatafeedCallbacks['onReady']) => void;
  searchSymbols: (
    userInput: string,
    exchange: string,
    symbolType: string,
    callback: DatafeedCallbacks['onSearchReady'],
  ) => void;
  resolveSymbol: (
    symbolName: string,
    onResolve: DatafeedCallbacks['onSymbolResolved'],
    onError: DatafeedCallbacks['onResolveError'],
  ) => void;
  getBars: (
    symbolInfo: TradingViewLibrarySymbolInfo,
    resolution: TradingViewResolution | string,
    periodParams: TradingViewPeriodParams,
    onHistory: DatafeedCallbacks['onHistory'],
    onError: DatafeedCallbacks['onHistoryError'],
  ) => void;
  subscribeBars: (
    symbolInfo: TradingViewLibrarySymbolInfo,
    resolution: TradingViewResolution | string,
    onRealtime: DatafeedCallbacks['onRealtime'],
    subscriberUid: string,
    onResetCacheNeeded?: () => void,
  ) => void;
  unsubscribeBars: (subscriberUid: string) => void;
  destroy: () => void;
};

type SpotTradingViewDatafeedOptions = Pick<
  SpotChartProps,
  'symbol' | 'displaySymbol' | 'pricePrecision' | 'amountPrecision'
> & {
  onKlineGap?: (event: SpotTradingViewKlineGapEvent) => void;
  onKlineLoadStateChange?: (state: SpotKlineLoadState) => void;
};

type KlineGapState = {
  barTime: number;
  latestBarTime: number;
  lastResetAt: number;
};

type KlineBackfillState = {
  barTime: number;
  latestBarTime: number;
  requestedAt: number;
  inFlight: boolean;
};

type TradeBucketState = {
  signatures: Set<string>;
};

type EmitRealtimeBar = (bar: TradingViewBar, reason: string) => boolean;

const SPOT_EXCHANGE_NAME = 'EXCHANGE';
const SUPPORTED_RESOLUTIONS: TradingViewResolution[] = ['1', '5', '15', '60', '240', '1D'];
const RESOLUTION_TO_SPOT_INTERVAL: Record<string, string> = {
  '1': '1m',
  '5': '5m',
  '15': '15m',
  '60': '1h',
  '240': '4h',
  D: '1d',
  '1D': '1d',
};

const SPOT_INTERVAL_TO_RESOLUTION: Record<string, TradingViewResolution> = {
  '1m': '1',
  '5m': '5',
  '15m': '15',
  '1h': '60',
  '4h': '240',
  '1d': '1D',
};
const SPOT_INTERVAL_MS: Record<string, number> = {
  '1m': 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '4h': 4 * 60 * 60_000,
  '1d': 24 * 60 * 60_000,
};
const KLINE_GAP_RESET_THROTTLE_MS = 3_000;
const KLINE_GAP_BACKFILL_THROTTLE_MS = 3_000;

const DATAFEED_CONFIGURATION: TradingViewDatafeedConfiguration = {
  supports_search: true,
  supports_group_request: false,
  supports_marks: false,
  supports_timescale_marks: false,
  supports_time: false,
  exchanges: [{ value: SPOT_EXCHANGE_NAME, name: SPOT_EXCHANGE_NAME, desc: SPOT_EXCHANGE_NAME }],
  symbols_types: [{ name: 'spot', value: 'spot' }],
  supported_resolutions: SUPPORTED_RESOLUTIONS,
};

function toPositiveNumber(value: unknown): number | null {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : null;
}

function normalizeProvider(value: unknown): string {
  return String(value || '').trim().toUpperCase();
}

function normalizeSource(value: unknown): string {
  return String(value || '').trim().toUpperCase();
}

function normalizeFreshness(value: unknown): string {
  return String(value || '').trim().toUpperCase();
}

function normalizeTimeMs(value: unknown): number {
  const seconds = normalizeTimeToSeconds(value);
  return seconds > 0 ? seconds * 1000 : 0;
}

function getTradeTimeMs(trade: SpotMarketTradeItem, message?: SpotMarketTradeMessage): number {
  return (
    normalizeTimeMs(trade.ts) ||
    normalizeTimeMs(trade.time) ||
    normalizeTimeMs(trade.updated_at_ms) ||
    normalizeTimeMs(message?.updated_at_ms)
  );
}

function getTradeSignature(
  symbol: string,
  provider: string,
  trade: SpotMarketTradeItem,
): string | null {
  const tradeId = String(trade.provider_trade_id || trade.trade_id || trade.id || '').trim();
  if (!tradeId) return null;
  return `${provider || 'UNKNOWN'}:${symbol}:${tradeId}`;
}

function getTradeBucketTimeMs(tradeTimeMs: number, intervalMs: number): number {
  if (!tradeTimeMs || !intervalMs) return 0;
  return Math.floor(tradeTimeMs / intervalMs) * intervalMs;
}

function normalizeResolution(resolution: string): TradingViewResolution {
  const normalized = String(resolution || '').trim().toUpperCase();
  if (normalized === 'D') return '1D';
  if (SUPPORTED_RESOLUTIONS.includes(normalized as TradingViewResolution)) {
    return normalized as TradingViewResolution;
  }
  return '1';
}

export function spotIntervalToTradingViewResolution(interval: string): TradingViewResolution {
  const normalized = String(interval || '').trim().toLowerCase();
  return SPOT_INTERVAL_TO_RESOLUTION[normalized] || '1';
}

function tradingViewResolutionToSpotInterval(resolution: string): string {
  return RESOLUTION_TO_SPOT_INTERVAL[normalizeResolution(resolution)] || '1m';
}

function getSpotIntervalMs(interval: string): number {
  return SPOT_INTERVAL_MS[String(interval || '').trim().toLowerCase()] || SPOT_INTERVAL_MS['1m'];
}

function getPriceScale(precision?: number | null): number {
  const nextPrecision = Number(precision);
  if (!Number.isInteger(nextPrecision) || nextPrecision < 0 || nextPrecision > 12) {
    return 100;
  }
  return Math.max(1, 10 ** nextPrecision);
}

function normalizeKlineTimeMs(item: SpotMarketKlineItem): number {
  const seconds =
    normalizeTimeToSeconds(item.open_time) ||
    normalizeTimeToSeconds(item.time) ||
    normalizeTimeToSeconds(item.timestamp);
  return seconds > 0 ? seconds * 1000 : 0;
}

function klineToBar(item: SpotMarketKlineItem): TradingViewBar | null {
  const time = normalizeKlineTimeMs(item);
  const open = toPositiveNumber(item.open);
  const high = toPositiveNumber(item.high);
  const low = toPositiveNumber(item.low);
  const close = toPositiveNumber(item.close);
  const volume = Number(item.volume);

  if (!time || open === null || high === null || low === null || close === null) {
    return null;
  }

  return {
    time,
    open,
    high,
    low,
    close,
    volume: Number.isFinite(volume) && volume > 0 ? volume : 0,
  };
}

function klinePayloadToBar(payload: unknown): TradingViewBar | null {
  if (!payload || typeof payload !== 'object') return null;
  return klineToBar(payload as SpotMarketKlineItem);
}

function buildSymbolInfo(options: SpotTradingViewDatafeedOptions): TradingViewLibrarySymbolInfo {
  const symbol = normalizeSpotSymbol(options.symbol);
  const description = String(options.displaySymbol || '').trim() || symbol;
  const volumePrecision = Number(options.amountPrecision);

  return {
    name: symbol,
    ticker: symbol,
    description,
    type: 'spot',
    session: '24x7',
    timezone: 'Etc/UTC',
    exchange: SPOT_EXCHANGE_NAME,
    listed_exchange: SPOT_EXCHANGE_NAME,
    minmov: 1,
    pricescale: getPriceScale(options.pricePrecision),
    has_intraday: true,
    has_daily: true,
    has_weekly_and_monthly: false,
    supported_resolutions: SUPPORTED_RESOLUTIONS,
    intraday_multipliers: ['1', '5', '15', '60', '240'],
    daily_multipliers: ['1'],
    volume_precision: Number.isInteger(volumePrecision) && volumePrecision >= 0 && volumePrecision <= 12
      ? volumePrecision
      : 8,
    data_status: 'streaming',
    format: 'price',
  };
}

function buildSearchResult(symbolInfo: TradingViewLibrarySymbolInfo): TradingViewSearchSymbolResult {
  return {
    symbol: symbolInfo.name,
    full_name: `${symbolInfo.exchange}:${symbolInfo.name}`,
    description: symbolInfo.description,
    exchange: symbolInfo.exchange,
    ticker: symbolInfo.ticker,
    type: symbolInfo.type,
  };
}

export function createSpotTradingViewDatafeed(
  options: SpotTradingViewDatafeedOptions,
): SpotTradingViewDatafeed {
  const symbolInfo = buildSymbolInfo(options);
  const apiSymbol = normalizeSpotSymbol(symbolInfo.ticker || symbolInfo.name);
  const latestBars = new Map<string, TradingViewBar>();
  const latestBarKeyByUid = new Map<string, string>();
  const gapStateByLatestBarKey = new Map<string, KlineGapState>();
  const backfillStateByLatestBarKey = new Map<string, KlineBackfillState>();
  const tradeBucketStateByKey = new Map<string, TradeBucketState>();
  const latestKlineProviderByKey = new Map<string, string>();
  const latestKlineSourceByKey = new Map<string, string>();
  const lastEmittedBarTimeByUid = new Map<string, number>();
  const lastDroppedRealtimeBarByUid = new Map<string, string>();
  const unsubscribeByUid = new Map<string, () => void>();

  const getLatestBarKey = (resolution: TradingViewResolution | string) =>
    `${apiSymbol}:${normalizeResolution(resolution)}`;

  const getTradeBucketKey = (latestBarKey: string, bucketTime: number) =>
    `${latestBarKey}:${bucketTime}`;

  const clearTradeBucketState = (latestBarKey: string) => {
    const prefix = `${latestBarKey}:`;
    for (const key of Array.from(tradeBucketStateByKey.keys())) {
      if (key.startsWith(prefix)) {
        tradeBucketStateByKey.delete(key);
      }
    }
  };

  const pruneTradeBucketState = (latestBarKey: string, minBucketTime: number) => {
    const prefix = `${latestBarKey}:`;
    for (const key of Array.from(tradeBucketStateByKey.keys())) {
      if (!key.startsWith(prefix)) continue;
      const bucketTime = Number(key.slice(prefix.length));
      if (!Number.isFinite(bucketTime) || bucketTime < minBucketTime) {
        tradeBucketStateByKey.delete(key);
      }
    }
  };

  const logKlineGapDebug = (payload: {
    interval: string;
    latestBarTime: number;
    realtimeBarTime: number;
    gapIntervals: number;
    action: string;
  }) => {
    if (process.env.NODE_ENV === 'production') return;
    console.debug('[SpotTradingViewDatafeed] kline gap', {
      symbol: apiSymbol,
      interval: payload.interval,
      latestBarTime: payload.latestBarTime,
      realtimeBarTime: payload.realtimeBarTime,
      gapIntervals: payload.gapIntervals,
      action: payload.action,
    });
  };

  const resetKlineGap = (
    latestBarKey: string,
    interval: string,
    intervalMs: number,
    latestBar: TradingViewBar,
    realtimeBar: TradingViewBar,
    onResetCacheNeeded?: () => void,
  ) => {
    const now = Date.now();
    const previousGap = gapStateByLatestBarKey.get(latestBarKey);
    const shouldReset =
      !previousGap ||
      previousGap.barTime !== realtimeBar.time ||
      previousGap.latestBarTime !== latestBar.time ||
      now - previousGap.lastResetAt >= KLINE_GAP_RESET_THROTTLE_MS;

    if (!shouldReset) return;

    gapStateByLatestBarKey.set(latestBarKey, {
      barTime: realtimeBar.time,
      latestBarTime: latestBar.time,
      lastResetAt: now,
    });
    const gapIntervals = Math.max(2, Math.round((realtimeBar.time - latestBar.time) / intervalMs));
    onResetCacheNeeded?.();
    options.onKlineGap?.({
      symbol: apiSymbol,
      interval,
      barTime: realtimeBar.time,
      latestBarTime: latestBar.time,
      gapIntervals,
    });
    logKlineGapDebug({
      interval,
      latestBarTime: latestBar.time,
      realtimeBarTime: realtimeBar.time,
      gapIntervals,
      action: 'reset',
    });
  };

  const backfillKlineGap = (
    latestBarKey: string,
    interval: string,
    intervalMs: number,
    latestBar: TradingViewBar,
    realtimeBar: TradingViewBar,
    emitRealtimeBar: EmitRealtimeBar,
    onResetCacheNeeded?: () => void,
  ) => {
    const now = Date.now();
    const gapIntervals = Math.max(2, Math.round((realtimeBar.time - latestBar.time) / intervalMs));
    const previousBackfill = backfillStateByLatestBarKey.get(latestBarKey);
    if (previousBackfill?.inFlight) return;
    if (
      previousBackfill &&
      previousBackfill.barTime === realtimeBar.time &&
      previousBackfill.latestBarTime === latestBar.time &&
      now - previousBackfill.requestedAt < KLINE_GAP_BACKFILL_THROTTLE_MS
    ) {
      return;
    }

    backfillStateByLatestBarKey.set(latestBarKey, {
      barTime: realtimeBar.time,
      latestBarTime: latestBar.time,
      requestedAt: now,
      inFlight: true,
    });
    logKlineGapDebug({
      interval,
      latestBarTime: latestBar.time,
      realtimeBarTime: realtimeBar.time,
      gapIntervals,
      action: 'backfill_start',
    });

    const reset = (latestForReset: TradingViewBar) => {
      resetKlineGap(latestBarKey, interval, intervalMs, latestForReset, realtimeBar, onResetCacheNeeded);
    };

    void getSpotKlines({
      symbol: apiSymbol,
      interval,
      limit: Math.min(Math.max(gapIntervals + 5, 20), 200),
    })
      .then((payload) => {
        const state = backfillStateByLatestBarKey.get(latestBarKey);
        if (
          !state ||
          state.barTime !== realtimeBar.time ||
          state.latestBarTime !== latestBar.time
        ) {
          return;
        }

        const currentLatest = latestBars.get(latestBarKey);
        if (currentLatest && currentLatest.time >= realtimeBar.time) {
          gapStateByLatestBarKey.delete(latestBarKey);
          backfillStateByLatestBarKey.delete(latestBarKey);
          return;
        }

        let cursor =
          currentLatest && currentLatest.time > latestBar.time
            ? currentLatest
            : latestBar;
        const bars = (payload.items || [])
          .map(klineToBar)
          .filter((item): item is TradingViewBar => Boolean(item))
          .filter((item) => item.time > cursor.time)
          .sort((a, b) => a.time - b.time);

        if (!bars.length || bars[0].time !== cursor.time + intervalMs) {
          reset(cursor);
          return;
        }

        for (const nextBar of bars) {
          if (nextBar.time < cursor.time) {
            continue;
          }
          if (nextBar.time === cursor.time) {
            if (!emitRealtimeBar(nextBar, 'backfill_update')) {
              const currentLatestAfterDrop = latestBars.get(latestBarKey);
              if (currentLatestAfterDrop && currentLatestAfterDrop.time >= nextBar.time) {
                cursor = currentLatestAfterDrop;
                continue;
              }
              return;
            }
            cursor = latestBars.get(latestBarKey) || nextBar;
            continue;
          }
          if (nextBar.time !== cursor.time + intervalMs) {
            reset(cursor);
            return;
          }
          if (!emitRealtimeBar(nextBar, 'backfill_append')) {
            const currentLatestAfterDrop = latestBars.get(latestBarKey);
            if (currentLatestAfterDrop && currentLatestAfterDrop.time >= nextBar.time) {
              cursor = currentLatestAfterDrop;
              continue;
            }
            return;
          }
          cursor = latestBars.get(latestBarKey) || nextBar;
        }

        if (realtimeBar.time === cursor.time) {
          if (emitRealtimeBar(realtimeBar, 'backfill_realtime_update')) {
            cursor = latestBars.get(latestBarKey) || realtimeBar;
          }
        } else if (realtimeBar.time === cursor.time + intervalMs) {
          if (emitRealtimeBar(realtimeBar, 'backfill_realtime_append')) {
            cursor = latestBars.get(latestBarKey) || realtimeBar;
          }
        } else if (realtimeBar.time > cursor.time) {
          reset(cursor);
          return;
        }

        gapStateByLatestBarKey.delete(latestBarKey);
        backfillStateByLatestBarKey.delete(latestBarKey);
        logKlineGapDebug({
          interval,
          latestBarTime: latestBar.time,
          realtimeBarTime: realtimeBar.time,
          gapIntervals,
          action: 'backfill_success',
        });
      })
      .catch(() => {
        const state = backfillStateByLatestBarKey.get(latestBarKey);
        if (
          !state ||
          state.barTime !== realtimeBar.time ||
          state.latestBarTime !== latestBar.time
        ) {
          return;
        }

        reset(latestBars.get(latestBarKey) || latestBar);
      })
      .finally(() => {
        const state = backfillStateByLatestBarKey.get(latestBarKey);
        if (
          state &&
          state.barTime === realtimeBar.time &&
          state.latestBarTime === latestBar.time
        ) {
          backfillStateByLatestBarKey.set(latestBarKey, {
            ...state,
            inFlight: false,
          });
        }
      });
  };

  return {
    onReady(callback) {
      window.setTimeout(() => callback(DATAFEED_CONFIGURATION), 0);
    },

    searchSymbols(userInput, _exchange, _symbolType, callback) {
      const normalizedInput = normalizeSpotSymbol(userInput);
      const result = buildSearchResult(symbolInfo);
      window.setTimeout(() => {
        callback(!normalizedInput || symbolInfo.name.includes(normalizedInput) ? [result] : []);
      }, 0);
    },

    resolveSymbol(symbolName, onResolve, onError) {
      const requested = normalizeSpotSymbol(symbolName);
      if (requested && requested !== apiSymbol) {
        window.setTimeout(() => onError('Unknown symbol'), 0);
        return;
      }
      window.setTimeout(() => onResolve(symbolInfo), 0);
    },

    getBars(_symbolInfo, resolution, periodParams, onHistory, onError) {
      const requestResolution = normalizeResolution(resolution);
      const interval = tradingViewResolutionToSpotInterval(requestResolution);
      const countBack = Number(periodParams.countBack || 0);
      const limit = Math.min(Math.max(countBack || 300, 50), 1000);
      const intervalMs = getSpotIntervalMs(interval);
      const requestedEndTime = Number(periodParams.to) > 0 ? Number(periodParams.to) * 1000 : 0;
      const isHistoricalPage =
        periodParams.firstDataRequest === false &&
        requestedEndTime > 0 &&
        requestedEndTime < Date.now() - intervalMs;
      const endTime = isHistoricalPage ? requestedEndTime : undefined;

      void getSpotKlines({
        symbol: apiSymbol,
        interval,
        limit,
        endTime,
      })
        .then((payload) => {
          const bars = (payload.items || [])
            .map(klineToBar)
            .filter((item): item is TradingViewBar => Boolean(item))
            .sort((a, b) => a.time - b.time);

          const latestBarKey = getLatestBarKey(requestResolution);
          const latestBar = bars[bars.length - 1] || null;
          if (latestBar) {
            latestBars.set(latestBarKey, latestBar);
          }
          const historyProvider = normalizeProvider(payload.provider);
          const historySource = normalizeSource(payload.source);
          if (historyProvider) {
            latestKlineProviderByKey.set(latestBarKey, historyProvider);
          }
          if (historySource) {
            latestKlineSourceByKey.set(latestBarKey, historySource);
          }
          gapStateByLatestBarKey.delete(latestBarKey);
          backfillStateByLatestBarKey.delete(latestBarKey);
          pruneTradeBucketState(latestBarKey, (latestBar?.time || 0) - intervalMs);

          options.onKlineLoadStateChange?.(bars.length > 0 ? 'loaded' : 'empty');
          onHistory(bars, { noData: bars.length === 0 });
        })
        .catch((err: unknown) => {
          options.onKlineLoadStateChange?.('error');
          onError(err instanceof Error ? err.message : 'Failed to load spot history');
        });
    },

    subscribeBars(_symbolInfo, resolution, onRealtime, subscriberUid, onResetCacheNeeded) {
      const existingUnsubscribe = unsubscribeByUid.get(subscriberUid);
      existingUnsubscribe?.();

      const requestResolution = normalizeResolution(resolution);
      const interval = tradingViewResolutionToSpotInterval(requestResolution);
      const intervalMs = getSpotIntervalMs(interval);
      const latestBarKey = getLatestBarKey(requestResolution);
      lastEmittedBarTimeByUid.set(subscriberUid, latestBars.get(latestBarKey)?.time || 0);
      latestBarKeyByUid.set(subscriberUid, latestBarKey);

      const emitRealtimeBar: EmitRealtimeBar = (bar, reason) => {
        if (latestBarKeyByUid.get(subscriberUid) !== latestBarKey) return false;

        const lastEmittedTime = lastEmittedBarTimeByUid.get(subscriberUid) || 0;
        if (bar.time < lastEmittedTime) {
          if (process.env.NODE_ENV !== 'production') {
            const dropKey = `${reason}:${bar.time}:${lastEmittedTime}`;
            if (lastDroppedRealtimeBarByUid.get(subscriberUid) !== dropKey) {
              lastDroppedRealtimeBarByUid.set(subscriberUid, dropKey);
              console.debug('[SpotTradingViewDatafeed] drop stale realtime bar', {
                symbol: apiSymbol,
                interval,
                subscriberUid,
                reason,
                barTime: bar.time,
                lastEmittedBarTime: lastEmittedTime,
              });
            }
          }
          return false;
        }

        const nextBar = { ...bar };
        latestBars.set(latestBarKey, nextBar);
        lastEmittedBarTimeByUid.set(subscriberUid, nextBar.time);
        onRealtime(nextBar);
        return true;
      };

      const handleKline = (realtimeMessage: SpotMarketRealtimeMessage) => {
        const message = realtimeMessage as SpotMarketKlineMessage;
        if (message.type !== 'spot_kline_update') return;

        const msgSymbol = normalizeSpotSymbol(message.symbol || '');
        if (msgSymbol !== apiSymbol) return;

        const msgInterval = String(message.interval || '').trim().toLowerCase();
        if (msgInterval !== interval) return;

        const bar = klinePayloadToBar(message.kline);
        if (!bar) return;

        const latestBar = latestBars.get(latestBarKey);
        if (latestBar && bar.time < latestBar.time) return;
        if (latestBar && bar.time > latestBar.time + intervalMs) {
          backfillKlineGap(
            latestBarKey,
            interval,
            intervalMs,
            latestBar,
            bar,
            emitRealtimeBar,
            onResetCacheNeeded,
          );
          return;
        }

        const klinePayload = message.kline && typeof message.kline === 'object'
          ? message.kline as Record<string, unknown>
          : null;
        const klineProvider = normalizeProvider(klinePayload?.provider || (message as { provider?: unknown }).provider);
        const klineSource = normalizeSource(klinePayload?.source || message.source);
        if (klineProvider) {
          latestKlineProviderByKey.set(latestBarKey, klineProvider);
        }
        if (klineSource) {
          latestKlineSourceByKey.set(latestBarKey, klineSource);
        }
        const didEmit = emitRealtimeBar(bar, 'kline');
        if (!didEmit) return;
        gapStateByLatestBarKey.delete(latestBarKey);
        backfillStateByLatestBarKey.delete(latestBarKey);
        pruneTradeBucketState(latestBarKey, bar.time - intervalMs);
      };

      const handleTrade = (realtimeMessage: SpotMarketRealtimeMessage) => {
        const message = realtimeMessage as SpotMarketTradeMessage;
        if (message.type !== 'spot_trade') return;

        const trade = message.trade && typeof message.trade === 'object'
          ? message.trade as SpotMarketTradeItem
          : null;
        if (!trade) return;

        const msgSymbol = normalizeSpotSymbol(message.symbol || '');
        if (msgSymbol !== apiSymbol) return;

        const tradeProvider = normalizeProvider(trade.provider || message.provider);
        const tradeSource = normalizeSource(trade.source || message.source);
        const tradeFreshness = normalizeFreshness(trade.freshness || message.freshness);
        const currentKlineProvider = latestKlineProviderByKey.get(latestBarKey) || '';
        if (tradeProvider && currentKlineProvider && tradeProvider !== currentKlineProvider) return;
        if (tradeSource && !['LIVE_WS', 'INTERNAL'].includes(tradeSource)) return;
        if (tradeFreshness && !['LIVE', 'INTERNAL'].includes(tradeFreshness)) return;

        const price = toPositiveNumber(trade.price);
        if (price === null) return;

        const tradeTimeMs = getTradeTimeMs(trade, message);
        const bucketTime = getTradeBucketTimeMs(tradeTimeMs, intervalMs);
        if (!bucketTime) return;

        const latestBar = latestBars.get(latestBarKey);
        if (!latestBar || bucketTime < latestBar.time) return;
        const lastEmittedTime = lastEmittedBarTimeByUid.get(subscriberUid) || 0;
        if (bucketTime < lastEmittedTime) return;

        const amount = toPositiveNumber(trade.amount);
        const signature = getTradeSignature(apiSymbol, tradeProvider, trade);
        const bucketKey = getTradeBucketKey(latestBarKey, bucketTime);
        const bucketState = tradeBucketStateByKey.get(bucketKey) || { signatures: new Set<string>() };
        const shouldAccumulateVolume = Boolean(signature && amount !== null && !bucketState.signatures.has(signature));
        if (signature) {
          bucketState.signatures.add(signature);
          tradeBucketStateByKey.set(bucketKey, bucketState);
        }

        const baseBar = bucketTime === latestBar.time
          ? latestBar
          : {
              time: bucketTime,
              open: price,
              high: price,
              low: price,
              close: price,
              volume: 0,
            };
        const nextBar: TradingViewBar = {
          time: bucketTime,
          open: baseBar.open,
          high: Math.max(baseBar.high, price),
          low: Math.min(baseBar.low, price),
          close: price,
          volume: (baseBar.volume || 0) + (shouldAccumulateVolume ? amount || 0 : 0),
        };

        const didEmit = emitRealtimeBar(nextBar, 'trade');
        if (!didEmit) return;
        pruneTradeBucketState(latestBarKey, bucketTime - intervalMs);
      };

      const subscriptionId = spotMarketRealtime.acquireSubscription({
        symbol: apiSymbol,
        interval,
        domains: ['kline', 'trades'],
        owner: `tradingview:${subscriberUid}`,
      });
      const unsubscribeKline = spotMarketRealtime.subscribe('kline', handleKline);
      const unsubscribeTrade = spotMarketRealtime.subscribe('trade', handleTrade);
      const unsubscribe = () => {
        unsubscribeKline();
        unsubscribeTrade();
        spotMarketRealtime.releaseSubscription(subscriptionId);
      };
      unsubscribeByUid.set(subscriberUid, unsubscribe);
    },

    unsubscribeBars(subscriberUid) {
      const unsubscribe = unsubscribeByUid.get(subscriberUid);
      unsubscribe?.();
      unsubscribeByUid.delete(subscriberUid);
      const latestBarKey = latestBarKeyByUid.get(subscriberUid);
      if (latestBarKey) {
        latestBars.delete(latestBarKey);
        gapStateByLatestBarKey.delete(latestBarKey);
        backfillStateByLatestBarKey.delete(latestBarKey);
        latestKlineProviderByKey.delete(latestBarKey);
        latestKlineSourceByKey.delete(latestBarKey);
        clearTradeBucketState(latestBarKey);
      }
      lastEmittedBarTimeByUid.delete(subscriberUid);
      lastDroppedRealtimeBarByUid.delete(subscriberUid);
      latestBarKeyByUid.delete(subscriberUid);
    },

    destroy() {
      for (const unsubscribe of Array.from(unsubscribeByUid.values())) {
        unsubscribe();
      }
      unsubscribeByUid.clear();
      latestBarKeyByUid.clear();
      latestBars.clear();
      gapStateByLatestBarKey.clear();
      backfillStateByLatestBarKey.clear();
      latestKlineProviderByKey.clear();
      latestKlineSourceByKey.clear();
      lastEmittedBarTimeByUid.clear();
      lastDroppedRealtimeBarByUid.clear();
      tradeBucketStateByKey.clear();
    },
  };
}
