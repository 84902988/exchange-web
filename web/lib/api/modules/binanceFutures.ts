const BINANCE_USDM_BASE_URL =
  process.env.NEXT_PUBLIC_BINANCE_USDM_BASE_URL || 'https://fapi.binance.com';

type BinanceKlineRow = [
  number,
  string,
  string,
  string,
  string,
  string,
  number,
  string,
  number,
  string,
  string,
  string,
];

export type BinanceFuturesKline = {
  open_time: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  close_time: number;
  quote_volume: string;
};

export type BinanceFuturesDepthLevel = {
  price: string;
  amount: string;
};

export type BinanceFuturesDepth = {
  lastUpdateId: number;
  bids: BinanceFuturesDepthLevel[];
  asks: BinanceFuturesDepthLevel[];
};

export type BinanceFuturesTrade = {
  id: number;
  price: string;
  qty: string;
  quoteQty: string;
  time: number;
  isBuyerMaker: boolean;
};

export type BinanceFuturesBookTicker = {
  symbol: string;
  bidPrice: string;
  bidQty: string;
  askPrice: string;
  askQty: string;
  time?: number;
};

export type BinanceFuturesTicker24h = {
  symbol: string;
  lastPrice: string;
  priceChange: string;
  priceChangePercent: string;
  highPrice: string;
  lowPrice: string;
  volume: string;
  quoteVolume: string;
};

function buildUrl(path: string, params: Record<string, string | number | undefined>) {
  const url = new URL(path, BINANCE_USDM_BASE_URL);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== '') {
      url.searchParams.set(key, String(value));
    }
  });
  return url.toString();
}

async function publicFetch<T>(path: string, params: Record<string, string | number | undefined>) {
  const response = await fetch(buildUrl(path, params), {
    method: 'GET',
    cache: 'no-store',
  });

  if (!response.ok) {
    throw new Error(`Binance Futures public market request failed: ${response.status}`);
  }

  return (await response.json()) as T;
}

export async function getBinanceFuturesKlines(params: {
  symbol: string;
  interval: string;
  limit?: number;
}): Promise<BinanceFuturesKline[]> {
  const rows = await publicFetch<BinanceKlineRow[]>('/fapi/v1/klines', {
    symbol: params.symbol,
    interval: params.interval,
    limit: params.limit ?? 200,
  });

  return rows.map((row) => ({
    open_time: row[0],
    open: row[1],
    high: row[2],
    low: row[3],
    close: row[4],
    volume: row[5],
    close_time: row[6],
    quote_volume: row[7],
  }));
}

export async function getBinanceFuturesDepth(
  symbol: string,
  limit = 20,
): Promise<BinanceFuturesDepth> {
  const depth = await publicFetch<{
    lastUpdateId: number;
    bids: string[][];
    asks: string[][];
  }>('/fapi/v1/depth', { symbol, limit });

  return {
    lastUpdateId: depth.lastUpdateId,
    bids: depth.bids.map(([price, amount]) => ({ price, amount })),
    asks: depth.asks.map(([price, amount]) => ({ price, amount })),
  };
}

export function getBinanceFuturesTrades(symbol: string, limit = 50) {
  return publicFetch<BinanceFuturesTrade[]>('/fapi/v1/trades', { symbol, limit });
}

export function getBinanceFuturesBookTicker(symbol: string) {
  return publicFetch<BinanceFuturesBookTicker>('/fapi/v1/ticker/bookTicker', { symbol });
}

export function getBinanceFuturesTicker24h(symbol: string) {
  return publicFetch<BinanceFuturesTicker24h>('/fapi/v1/ticker/24hr', { symbol });
}
