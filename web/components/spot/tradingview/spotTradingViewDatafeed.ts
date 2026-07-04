'use client';

import {
  getSpotKlines,
  normalizeSpotSymbol,
  type SpotMarketKlineItem,
} from '@/lib/api/modules/spot';
import {
  spotMarketRealtime,
  type SpotMarketKlineMessage,
  type SpotMarketRealtimeMessage,
} from '@/services/marketRealtime';
import { normalizeTimeToSeconds } from '../chart/chart.utils';
import type { SpotChartProps } from '../chart/chart.types';

type TradingViewResolution = '1' | '5' | '15' | '60' | '240' | '1D';

type TradingViewBar = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
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
>;

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
  const unsubscribeByUid = new Map<string, () => void>();

  const getLatestBarKey = (resolution: TradingViewResolution | string) =>
    `${apiSymbol}:${normalizeResolution(resolution)}`;

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
      const endTime = Number(periodParams.to) > 0 ? Number(periodParams.to) * 1000 : undefined;

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

          const latestBar = bars[bars.length - 1] || null;
          if (latestBar) {
            latestBars.set(getLatestBarKey(requestResolution), latestBar);
          }

          onHistory(bars, { noData: bars.length === 0 });
        })
        .catch((err: unknown) => {
          onError(err instanceof Error ? err.message : 'Failed to load spot history');
        });
    },

    subscribeBars(_symbolInfo, resolution, onRealtime, subscriberUid, _onResetCacheNeeded) {
      void _onResetCacheNeeded;

      const existingUnsubscribe = unsubscribeByUid.get(subscriberUid);
      existingUnsubscribe?.();

      const requestResolution = normalizeResolution(resolution);
      const interval = tradingViewResolutionToSpotInterval(requestResolution);
      const latestBarKey = getLatestBarKey(requestResolution);

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

        latestBars.set(latestBarKey, bar);
        onRealtime(bar);
      };

      spotMarketRealtime.setSymbol(apiSymbol, interval);
      const unsubscribe = spotMarketRealtime.subscribe('kline', handleKline);
      unsubscribeByUid.set(subscriberUid, unsubscribe);
      latestBarKeyByUid.set(subscriberUid, latestBarKey);
    },

    unsubscribeBars(subscriberUid) {
      const unsubscribe = unsubscribeByUid.get(subscriberUid);
      unsubscribe?.();
      unsubscribeByUid.delete(subscriberUid);
      const latestBarKey = latestBarKeyByUid.get(subscriberUid);
      if (latestBarKey) {
        latestBars.delete(latestBarKey);
      }
      latestBarKeyByUid.delete(subscriberUid);
    },

    destroy() {
      for (const unsubscribe of Array.from(unsubscribeByUid.values())) {
        unsubscribe();
      }
      unsubscribeByUid.clear();
      latestBarKeyByUid.clear();
      latestBars.clear();
    },
  };
}
