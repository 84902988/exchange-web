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

type SpotTradingViewRealtimeEvent = {
  symbol: string;
  interval: string;
  reason: 'kline' | 'trade';
  barTime: number;
  updatedAtMs: number;
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
  onKlineLoadStateChange?: (state: SpotKlineLoadState) => void;
  onKlineRealtime?: (event: SpotTradingViewRealtimeEvent) => void;
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
const realtimeHighWaterMarkByKey = new Map<string, number>();

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

function getRealtimeHighWaterMark(latestBarKey: string): number {
  return realtimeHighWaterMarkByKey.get(latestBarKey) || 0;
}

function rememberRealtimeHighWaterMark(latestBarKey: string, time: number) {
  if (!Number.isFinite(time) || time <= 0) return;
  const previous = getRealtimeHighWaterMark(latestBarKey);
  if (time > previous) {
    realtimeHighWaterMarkByKey.set(latestBarKey, time);
  }
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

function normalizeHistoryBars(items: SpotMarketKlineItem[] | undefined): TradingViewBar[] {
  const byTime = new Map<number, TradingViewBar>();
  for (const item of items || []) {
    const bar = klineToBar(item);
    if (!bar) continue;
    byTime.set(bar.time, bar);
  }
  return Array.from(byTime.values()).sort((a, b) => a.time - b.time);
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
  const tradeBucketStateByKey = new Map<string, TradeBucketState>();
  const latestKlineProviderByKey = new Map<string, string>();
  const latestKlineSourceByKey = new Map<string, string>();
  const lastEmittedBarTimeByUid = new Map<string, number>();
  const lastDroppedRealtimeBarByUid = new Map<string, string>();
  const activeSubscriptionKeyByUid = new Map<string, string>();
  const historyReadyByLatestBarKey = new Map<string, boolean>();
  const historyRequestSeqByLatestBarKey = new Map<string, number>();
  const unsubscribeByUid = new Map<string, () => void>();

  const getLatestBarKey = (resolution: TradingViewResolution | string) =>
    `${apiSymbol}:${normalizeResolution(resolution)}`;

  const getSubscriptionKey = (interval: string, subscriberUid: string) =>
    `${apiSymbol}:${interval}:${subscriberUid}`;

  const getTradeBucketKey = (latestBarKey: string, bucketTime: number) =>
    `${latestBarKey}:${bucketTime}`;

  const syncLastEmittedAfterHistory = (latestBarKey: string, latestBarTime: number) => {
    if (!latestBarTime) return;

    for (const [subscriberUid, subscriberLatestBarKey] of Array.from(latestBarKeyByUid.entries())) {
      if (subscriberLatestBarKey !== latestBarKey) continue;

      const previous = lastEmittedBarTimeByUid.get(subscriberUid) || 0;
      if (latestBarTime > previous) {
        lastEmittedBarTimeByUid.set(subscriberUid, latestBarTime);
      }
    }
  };

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
      const latestBarKey = getLatestBarKey(requestResolution);
      const historyRequestSeq = (historyRequestSeqByLatestBarKey.get(latestBarKey) || 0) + 1;
      historyRequestSeqByLatestBarKey.set(latestBarKey, historyRequestSeq);
      if (periodParams.firstDataRequest !== false) {
        historyReadyByLatestBarKey.set(latestBarKey, false);
      }

      void getSpotKlines({
        symbol: apiSymbol,
        interval,
        limit,
        endTime,
      })
        .then((payload) => {
          if (historyRequestSeqByLatestBarKey.get(latestBarKey) !== historyRequestSeq) {
            onHistory([], { noData: true });
            return;
          }

          const bars = normalizeHistoryBars(payload.items);
          const latestBar = bars[bars.length - 1] || null;
          const currentLatestBeforeHistory = latestBars.get(latestBarKey);
          if (
            periodParams.firstDataRequest !== false &&
            latestBar &&
            currentLatestBeforeHistory &&
            latestBar.time <= currentLatestBeforeHistory.time
          ) {
            historyReadyByLatestBarKey.set(latestBarKey, true);
            onHistory([], { noData: true });
            return;
          }

          if (latestBar) {
            latestBars.set(latestBarKey, latestBar);
            rememberRealtimeHighWaterMark(latestBarKey, latestBar.time);
            syncLastEmittedAfterHistory(latestBarKey, latestBar.time);
          }
          const historyProvider = normalizeProvider(payload.provider);
          const historySource = normalizeSource(payload.source);
          if (historyProvider) {
            latestKlineProviderByKey.set(latestBarKey, historyProvider);
          }
          if (historySource) {
            latestKlineSourceByKey.set(latestBarKey, historySource);
          }
          pruneTradeBucketState(latestBarKey, (latestBar?.time || 0) - intervalMs);

          options.onKlineLoadStateChange?.(bars.length > 0 ? 'loaded' : 'empty');
          historyReadyByLatestBarKey.set(latestBarKey, true);
          onHistory(bars, { noData: bars.length === 0 });
        })
        .catch((err: unknown) => {
          if (historyRequestSeqByLatestBarKey.get(latestBarKey) !== historyRequestSeq) {
            onHistory([], { noData: true });
            return;
          }

          options.onKlineLoadStateChange?.('error');
          historyReadyByLatestBarKey.set(latestBarKey, true);
          onError(err instanceof Error ? err.message : 'Failed to load spot history');
        });
    },

    subscribeBars(_symbolInfo, resolution, onRealtime, subscriberUid) {
      const existingUnsubscribe = unsubscribeByUid.get(subscriberUid);
      existingUnsubscribe?.();

      const requestResolution = normalizeResolution(resolution);
      const interval = tradingViewResolutionToSpotInterval(requestResolution);
      const intervalMs = getSpotIntervalMs(interval);
      const latestBarKey = getLatestBarKey(requestResolution);
      const subscriptionKey = getSubscriptionKey(interval, subscriberUid);
      const isCurrentSubscription = () =>
        activeSubscriptionKeyByUid.get(subscriberUid) === subscriptionKey &&
        latestBarKeyByUid.get(subscriberUid) === latestBarKey;

      if (!historyReadyByLatestBarKey.has(latestBarKey)) {
        historyReadyByLatestBarKey.set(latestBarKey, false);
      }
      activeSubscriptionKeyByUid.set(subscriberUid, subscriptionKey);
      lastEmittedBarTimeByUid.set(
        subscriberUid,
        Math.max(latestBars.get(latestBarKey)?.time || 0, getRealtimeHighWaterMark(latestBarKey)),
      );
      latestBarKeyByUid.set(subscriberUid, latestBarKey);

      const emitRealtimeBar: EmitRealtimeBar = (bar, reason) => {
        if (!isCurrentSubscription()) return false;
        if (historyReadyByLatestBarKey.get(latestBarKey) === false) return false;
        if (!Number.isFinite(bar.time) || bar.time <= 0) return false;

        const lastEmittedTime = Math.max(
          lastEmittedBarTimeByUid.get(subscriberUid) || 0,
          latestBars.get(latestBarKey)?.time || 0,
          getRealtimeHighWaterMark(latestBarKey),
        );
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
        rememberRealtimeHighWaterMark(latestBarKey, nextBar.time);
        lastEmittedBarTimeByUid.set(subscriberUid, nextBar.time);
        onRealtime(nextBar);
        return true;
      };

      const handleKline = (realtimeMessage: SpotMarketRealtimeMessage) => {
        if (!isCurrentSubscription()) return;

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
        options.onKlineRealtime?.({
          symbol: apiSymbol,
          interval,
          reason: 'kline',
          barTime: bar.time,
          updatedAtMs: Date.now(),
        });
        pruneTradeBucketState(latestBarKey, bar.time - intervalMs);
      };

      const handleTrade = (realtimeMessage: SpotMarketRealtimeMessage) => {
        if (!isCurrentSubscription()) return;

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
        options.onKlineRealtime?.({
          symbol: apiSymbol,
          interval,
          reason: 'trade',
          barTime: nextBar.time,
          updatedAtMs: Date.now(),
        });
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
        latestKlineProviderByKey.delete(latestBarKey);
        latestKlineSourceByKey.delete(latestBarKey);
        historyReadyByLatestBarKey.delete(latestBarKey);
        historyRequestSeqByLatestBarKey.delete(latestBarKey);
        clearTradeBucketState(latestBarKey);
      }
      lastEmittedBarTimeByUid.delete(subscriberUid);
      lastDroppedRealtimeBarByUid.delete(subscriberUid);
      latestBarKeyByUid.delete(subscriberUid);
      activeSubscriptionKeyByUid.delete(subscriberUid);
    },

    destroy() {
      for (const unsubscribe of Array.from(unsubscribeByUid.values())) {
        unsubscribe();
      }
      unsubscribeByUid.clear();
      latestBarKeyByUid.clear();
      latestBars.clear();
      latestKlineProviderByKey.clear();
      latestKlineSourceByKey.clear();
      historyReadyByLatestBarKey.clear();
      historyRequestSeqByLatestBarKey.clear();
      lastEmittedBarTimeByUid.clear();
      lastDroppedRealtimeBarByUid.clear();
      activeSubscriptionKeyByUid.clear();
      tradeBucketStateByKey.clear();
    },
  };
}
