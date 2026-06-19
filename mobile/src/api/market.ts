import {apiClient} from './client';

export type MarketCategoryKey =
  | 'overview'
  | 'favorites'
  | 'crypto'
  | 'stock'
  | 'cfd'
  | 'onchain';

export type MarketInstrument = {
  id: string;
  symbol: string;
  displaySymbol: string;
  name: string;
  category: Exclude<MarketCategoryKey, 'overview' | 'favorites'>;
  price: number | null;
  changePercent: number | null;
  pricePrecision: number;
  source: 'api' | 'fallback';
};

type MarketPairPayload = {
  items?: unknown[];
  total?: number;
  page?: number;
  page_size?: number;
};

const REQUIRED_OVERVIEW_SYMBOLS = [
  'BTCUSDT',
  'RCBUSDT',
  'NAS100',
  'XAUUSD',
  'ETHUSDT',
  'EURUSD',
];

export const MARKET_FALLBACK_ITEMS: MarketInstrument[] = [
  {
    id: 'fallback-BTCUSDT',
    symbol: 'BTCUSDT',
    displaySymbol: 'BTC',
    name: 'Bitcoin',
    category: 'crypto',
    price: 65001.81,
    changePercent: -1.06,
    pricePrecision: 2,
    source: 'fallback',
  },
  {
    id: 'fallback-RCBUSDT',
    symbol: 'RCBUSDT',
    displaySymbol: 'RCB',
    name: 'Royal Coin',
    category: 'crypto',
    price: 1.8146,
    changePercent: -0.86,
    pricePrecision: 4,
    source: 'fallback',
  },
  {
    id: 'fallback-ETHUSDT',
    symbol: 'ETHUSDT',
    displaySymbol: 'ETH',
    name: 'Ethereum',
    category: 'crypto',
    price: 3482.25,
    changePercent: 0.72,
    pricePrecision: 2,
    source: 'fallback',
  },
  {
    id: 'fallback-SPXC',
    symbol: 'SPXC',
    displaySymbol: 'SPXC',
    name: 'SpaceX',
    category: 'stock',
    price: 190.09,
    changePercent: -9.33,
    pricePrecision: 2,
    source: 'fallback',
  },
  {
    id: 'fallback-MU',
    symbol: 'MU',
    displaySymbol: 'MU',
    name: '美光科技',
    category: 'stock',
    price: 1039.85,
    changePercent: -1.84,
    pricePrecision: 2,
    source: 'fallback',
  },
  {
    id: 'fallback-NVDA',
    symbol: 'NVDA',
    displaySymbol: 'NVDA',
    name: '英伟达',
    category: 'stock',
    price: 206.86,
    changePercent: -1.37,
    pricePrecision: 2,
    source: 'fallback',
  },
  {
    id: 'fallback-SNDK',
    symbol: 'SNDK',
    displaySymbol: 'SNDK',
    name: '闪迪',
    category: 'stock',
    price: 1975.16,
    changePercent: -3.9,
    pricePrecision: 2,
    source: 'fallback',
  },
  {
    id: 'fallback-TSLA',
    symbol: 'TSLA',
    displaySymbol: 'TSLA',
    name: '特斯拉',
    category: 'stock',
    price: 398.1,
    changePercent: -2.25,
    pricePrecision: 2,
    source: 'fallback',
  },
  {
    id: 'fallback-SPYX',
    symbol: 'SPYX',
    displaySymbol: 'SPYX',
    name: '链上标普 100',
    category: 'onchain',
    price: 752.4,
    changePercent: -0.55,
    pricePrecision: 2,
    source: 'fallback',
  },
  {
    id: 'fallback-COAI',
    symbol: 'COAI',
    displaySymbol: 'COAI',
    name: 'AI 链上资产',
    category: 'onchain',
    price: 0.3485,
    changePercent: 5.71,
    pricePrecision: 4,
    source: 'fallback',
  },
  {
    id: 'fallback-AGT',
    symbol: 'AGT',
    displaySymbol: 'AGT',
    name: 'Agri Token',
    category: 'onchain',
    price: 0.02737,
    changePercent: 102.07,
    pricePrecision: 5,
    source: 'fallback',
  },
  {
    id: 'fallback-CLO',
    symbol: 'CLO',
    displaySymbol: 'CLO',
    name: 'Cloud Token',
    category: 'onchain',
    price: 0.1833,
    changePercent: 20.96,
    pricePrecision: 4,
    source: 'fallback',
  },
  {
    id: 'fallback-TRIA',
    symbol: 'TRIA',
    displaySymbol: 'TRIA',
    name: 'Trias',
    category: 'onchain',
    price: 0.03067,
    changePercent: 4.79,
    pricePrecision: 5,
    source: 'fallback',
  },
  {
    id: 'fallback-XAUUSD',
    symbol: 'XAUUSD',
    displaySymbol: 'XAUUSD',
    name: 'Gold US Dollar',
    category: 'cfd',
    price: 4350.05,
    changePercent: 0.39,
    pricePrecision: 2,
    source: 'fallback',
  },
  {
    id: 'fallback-XAGUSD',
    symbol: 'XAGUSD',
    displaySymbol: 'XAGUSD',
    name: 'Silver US Dollar',
    category: 'cfd',
    price: 70.514,
    changePercent: 0.63,
    pricePrecision: 3,
    source: 'fallback',
  },
  {
    id: 'fallback-NAS100',
    symbol: 'NAS100',
    displaySymbol: 'NAS100',
    name: '纳斯达克 100',
    category: 'cfd',
    price: 30154.88,
    changePercent: 0.53,
    pricePrecision: 2,
    source: 'fallback',
  },
  {
    id: 'fallback-USOUSD',
    symbol: 'USOUSD',
    displaySymbol: 'USOUSD',
    name: 'WTI Crude Oil Cash',
    category: 'cfd',
    price: 77.499,
    changePercent: 1.29,
    pricePrecision: 3,
    source: 'fallback',
  },
  {
    id: 'fallback-EURUSD',
    symbol: 'EURUSD',
    displaySymbol: 'EURUSD',
    name: 'Euro vs US Dollar',
    category: 'cfd',
    price: 1.1592,
    changePercent: -0.14,
    pricePrecision: 4,
    source: 'fallback',
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeSymbol(value: unknown) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function readString(row: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value);
    }
  }
  return '';
}

function readNumber(row: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = Number(row[key]);
    if (Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

function readPrecision(row: Record<string, unknown>, price: number | null) {
  const symbol = normalizeSymbol(
    row.symbol || row.ticker_symbol || row.source_symbol || row.external_symbol,
  );
  const precision = readNumber(row, ['price_precision', 'pricePrecision']);
  if (precision !== null && precision >= 0 && precision <= 8) {
    const apiPrecision = Math.trunc(precision);
    if (['RCBUSDT', 'BON2USDT', 'CREG2USDT'].includes(symbol)) {
      return Math.min(apiPrecision, 4);
    }
    if (symbol.includes('EURUSD') || symbol.includes('FX')) {
      return Math.min(apiPrecision, 5);
    }
    if (
      symbol.includes('BTC') ||
      symbol.includes('ETH') ||
      symbol.includes('NAS100') ||
      symbol.includes('XAUUSD')
    ) {
      return Math.min(apiPrecision, 2);
    }
    return Math.min(apiPrecision, 4);
  }
  if (['RCBUSDT', 'BON2USDT', 'CREG2USDT'].includes(symbol)) return 4;
  if (symbol.includes('EURUSD') || symbol.includes('FX')) return 5;
  if (
    symbol.includes('BTC') ||
    symbol.includes('ETH') ||
    symbol.includes('NAS100') ||
    symbol.includes('XAUUSD')
  ) {
    return 2;
  }
  if (price !== null && Math.abs(price) < 1) return 5;
  if (price !== null && Math.abs(price) < 10) return 4;
  return 2;
}

function readRows(payload: unknown) {
  if (Array.isArray(payload)) return payload;
  if (!isRecord(payload)) return [];
  if (Array.isArray(payload.items)) return payload.items;
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.rows)) return payload.rows;
  return [];
}

function getKnownName(symbol: string) {
  const map: Record<string, string> = {
    BTCUSDT: 'Bitcoin',
    RCBUSDT: 'Royal Coin',
    ETHUSDT: 'Ethereum',
    NAS100: '纳斯达克 100',
    XAUUSD: 'Gold US Dollar',
    XAGUSD: 'Silver US Dollar',
    EURUSD: 'Euro vs US Dollar',
    USOUSD: 'WTI Crude Oil Cash',
    NVDA: '英伟达',
    TSLA: '特斯拉',
  };
  return map[symbol] || '';
}

function getDisplaySymbol(row: Record<string, unknown>, symbol: string) {
  const display = readString(row, ['display_symbol', 'displaySymbol', 'base_asset']);
  if (display) return display.replace('/USDT', '').replace('USDT', '');
  if (symbol.endsWith('USDT')) return symbol.slice(0, -4);
  return symbol;
}

function getCategory(row: Record<string, unknown>, symbol: string) {
  const category = readString(row, [
    'market_category',
    'marketCategory',
    'asset_type',
    'assetType',
    'display_category',
    'displayCategory',
  ]).toUpperCase();
  const subCategory = readString(row, [
    'market_sub_category',
    'marketSubCategory',
  ]).toUpperCase();

  if (
    category.includes('STOCK') ||
    subCategory.includes('STOCK') ||
    ['NVDA', 'TSLA', 'SPXC', 'MU', 'SNDK'].includes(symbol)
  ) {
    return 'stock';
  }
  if (
    category.includes('RWA') ||
    category.includes('ONCHAIN') ||
    subCategory.includes('ONCHAIN') ||
    ['SPYX', 'COAI', 'AGT', 'CLO', 'TRIA'].includes(symbol)
  ) {
    return 'onchain';
  }
  if (
    category.includes('CONTRACT') ||
    category.includes('CFD') ||
    category.includes('INDEX') ||
    category.includes('FOREX') ||
    category.includes('METAL') ||
    category.includes('COMMODITY') ||
    ['NAS100', 'XAUUSD', 'XAGUSD', 'EURUSD', 'USOUSD'].includes(symbol)
  ) {
    return 'cfd';
  }
  return 'crypto';
}

function mapInstrument(row: unknown): MarketInstrument | null {
  if (!isRecord(row)) return null;
  const symbol = normalizeSymbol(
    row.symbol || row.ticker_symbol || row.source_symbol || row.external_symbol,
  );
  if (!symbol) return null;

  const price = readNumber(row, ['last_price', 'price', 'last', 'close']);
  const changePercent = readNumber(row, [
    'price_change_percent_24h',
    'change_24h',
    'percentChange24h',
    'priceChangePercent',
  ]);
  const displaySymbol = getDisplaySymbol(row, symbol);
  const name =
    readString(row, [
      'name',
      'display_name',
      'displayName',
      'name_zh',
      'label',
      'external_symbol',
    ]) ||
    getKnownName(symbol) ||
    displaySymbol;

  return {
    id: `api-${symbol}`,
    symbol,
    displaySymbol,
    name,
    category: getCategory(row, symbol),
    price,
    changePercent,
    pricePrecision: readPrecision(row, price),
    source: 'api',
  };
}

function mergeRows(pairs: unknown[], tickers: unknown[]) {
  const bySymbol = new Map<string, MarketInstrument>();

  for (const row of pairs) {
    const mapped = mapInstrument(row);
    if (mapped) bySymbol.set(mapped.symbol, mapped);
  }

  for (const row of tickers) {
    const mapped = mapInstrument(row);
    if (!mapped) continue;
    const existing = bySymbol.get(mapped.symbol);
    bySymbol.set(mapped.symbol, existing ? {...existing, ...mapped} : mapped);
  }

  return Array.from(bySymbol.values());
}

function withRequiredOverviewRows(items: MarketInstrument[]) {
  const bySymbol = new Map(items.map(item => [item.symbol, item]));

  // TODO: remove fallback catalog rows once backend exposes the full mobile
  // markets catalog for stocks, CFD and on-chain assets.
  for (const symbol of REQUIRED_OVERVIEW_SYMBOLS) {
    if (!bySymbol.has(symbol)) {
      const fallback = MARKET_FALLBACK_ITEMS.find(item => item.symbol === symbol);
      if (fallback) bySymbol.set(symbol, fallback);
    }
  }

  return Array.from(bySymbol.values());
}

export function getOverviewMarkets(items: MarketInstrument[]) {
  const bySymbol = new Map(items.map(item => [item.symbol, item]));
  return REQUIRED_OVERVIEW_SYMBOLS.map(symbol => bySymbol.get(symbol)).filter(
    (item): item is MarketInstrument => Boolean(item),
  );
}

export function formatMarketPrice(item: MarketInstrument) {
  if (item.price === null) return '--';
  const formatted = item.price.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: item.pricePrecision,
  });
  return formatted.replace(/(\.\d*?[1-9])0+$/, '$1').replace(/\.0+$/, '');
}

export function formatMarketPercent(value: number | null) {
  if (value === null) return '--';
  const prefix = value > 0 ? '+' : '';
  return `${prefix}${value.toFixed(2)}%`;
}

export async function fetchMobileMarkets() {
  const [pairPayload, tickerPayload] = await Promise.all([
    apiClient.get<MarketPairPayload>('/market/pairs?market_type=all&page_size=100'),
    apiClient.get<unknown[]>('/market/tickers'),
  ]);
  const rows = mergeRows(readRows(pairPayload), readRows(tickerPayload));
  return withRequiredOverviewRows(rows);
}
