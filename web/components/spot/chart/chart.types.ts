import type { RealtimePriceDirection } from '../spotTickerColor';

export type SpotKlineLoadState = 'loading' | 'loaded' | 'empty' | 'error';

export interface SpotChartProps {
  symbol: string;
  displaySymbol?: string | null;
  interval: string;
  height?: number;
  dataSource?: string | null;
  klineSource?: string | null;
  klineFreshness?: string | null;
  isLoading?: boolean;
  latestPrice?: string | number | null;
  latestTradeOrTickerPrice?: string | number | null;
  priceDirection?: RealtimePriceDirection;
  pricePrecision?: number | null;
  amountPrecision?: number | null;
  showRwaReference?: boolean;
}

export interface RawKlineItem {
  open_time?: number | string;
  time?: number | string;
  timestamp?: number | string;
  open: number | string;
  high: number | string;
  low: number | string;
  close: number | string;
  volume: number | string;
}

export interface CandleItem {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  isPlaceholder: boolean;
  isReferenceFallback?: boolean;
}

export interface VolumeItem {
  time: number;
  value: number;
  color: string;
}

export type WsTradeMessage = {
  type: 'spot_trade';
  symbol: string;
  trade: {
    price: string | number;
    amount: string | number;
    ts?: string | number;
  };
};

export type CandleSeriesPoint =
  | {
      time: number;
      open: number;
      high: number;
      low: number;
      close: number;
    }
  | { time: number };
