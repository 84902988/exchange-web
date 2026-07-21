import type { ContractSymbolItem } from '@/lib/api/modules/contract';
import type { SpotMarketPairItem } from '@/lib/api/modules/spot';

// Keep result classification independent from the interactive header component.

export type HeaderMarketSearchGroup = 'SPOT' | 'CONTRACT' | 'STOCK' | 'CFD';
export type HeaderMarketSearchKind =
  | 'SPOT'
  | 'CONTRACT'
  | 'STOCK_QUOTE'
  | 'STOCK_CONTRACT'
  | 'CFD';

export type HeaderMarketSearchResult = {
  id: string;
  symbol: string;
  displaySymbol: string;
  displayName: string;
  group: HeaderMarketSearchGroup;
  kind: HeaderMarketSearchKind;
  href: string;
};

export const HEADER_MARKET_SEARCH_GROUP_ORDER: HeaderMarketSearchGroup[] = [
  'SPOT',
  'CONTRACT',
  'STOCK',
  'CFD',
];

const CFD_CATEGORIES = new Set([
  'INDEX',
  'FOREX',
  'FX',
  'METAL',
  'GOLD',
  'SILVER',
  'COMMODITY',
  'FUTURES',
]);

function normalize(value: unknown): string {
  return String(value || '').trim().toUpperCase();
}

function getDisplaySymbol(item: SpotMarketPairItem): string {
  const displaySymbol = String(item.display_symbol || '').trim();
  if (displaySymbol) return displaySymbol;

  const base = normalize(item.base_asset);
  const quote = normalize(item.quote_asset);
  if (base && quote) return `${base}/${quote}`;
  return normalize(item.symbol);
}

function isSpotStockQuote(item: SpotMarketPairItem): boolean {
  const categories = [
    item.asset_type,
    item.market_category,
    item.market_sub_category,
    item.display_category,
  ].map(normalize);
  const subCategory = normalize(item.market_sub_category);
  const marketMode = normalize(item.market_mode);

  return (
    categories.includes('STOCK') &&
    subCategory !== 'STOCK_CONTRACT' &&
    marketMode !== 'MOCK_STOCK_CONTRACT'
  );
}

function getSpotStockSymbol(item: SpotMarketPairItem): string {
  const externalSymbol = normalize(item.external_symbol);
  const baseAsset = normalize(item.base_asset);
  const displayBase = normalize(item.display_symbol).split('/')[0];
  const source = externalSymbol || baseAsset || displayBase || normalize(item.symbol);
  return source.replace(/USDT$/, '').replace(/ON$/, '');
}

export function buildSpotHeaderSearchResult(
  item: SpotMarketPairItem,
): HeaderMarketSearchResult | null {
  const symbol = normalize(item.symbol);
  if (!symbol) return null;

  if (isSpotStockQuote(item)) {
    const stockSymbol = getSpotStockSymbol(item);
    if (!stockSymbol) return null;
    const href = `/markets/stocks/${encodeURIComponent(stockSymbol)}`;
    return {
      id: `STOCK_QUOTE:${stockSymbol}`,
      symbol: stockSymbol,
      displaySymbol: stockSymbol,
      displayName: stockSymbol,
      group: 'STOCK',
      kind: 'STOCK_QUOTE',
      href,
    };
  }

  return {
    id: `SPOT:${symbol}`,
    symbol,
    displaySymbol: getDisplaySymbol(item),
    displayName: normalize(item.base_asset) || symbol,
    group: 'SPOT',
    kind: 'SPOT',
    href: `/trade/spot?symbol=${encodeURIComponent(symbol)}`,
  };
}

function getContractKind(item: ContractSymbolItem): {
  group: HeaderMarketSearchGroup;
  kind: HeaderMarketSearchKind;
} {
  const categories = [
    item.category,
    item.asset_type,
    item.underlying_type,
    item.contract_type,
  ].map(normalize);

  if (categories.some((category) => category === 'STOCK' || category === 'STOCK_CONTRACT')) {
    return { group: 'STOCK', kind: 'STOCK_CONTRACT' };
  }
  if (categories.some((category) => CFD_CATEGORIES.has(category))) {
    return { group: 'CFD', kind: 'CFD' };
  }
  return { group: 'CONTRACT', kind: 'CONTRACT' };
}

export function buildContractHeaderSearchResult(
  item: ContractSymbolItem,
): HeaderMarketSearchResult | null {
  const symbol = normalize(item.symbol);
  if (!symbol) return null;

  const classification = getContractKind(item);
  const displayName = String(item.display_name || '').trim() || symbol;
  return {
    id: `${classification.kind}:${symbol}`,
    symbol,
    displaySymbol: displayName,
    displayName,
    ...classification,
    href: `/contract?symbol=${encodeURIComponent(symbol)}`,
  };
}

export function mergeHeaderMarketSearchResults(
  spotItems: SpotMarketPairItem[],
  contractItems: ContractSymbolItem[],
): HeaderMarketSearchResult[] {
  const merged = [
    ...spotItems.map(buildSpotHeaderSearchResult),
    ...contractItems.map(buildContractHeaderSearchResult),
  ].filter((item): item is HeaderMarketSearchResult => Boolean(item));
  const deduped = new Map<string, HeaderMarketSearchResult>();
  merged.forEach((item) => {
    if (!deduped.has(item.id)) deduped.set(item.id, item);
  });
  return Array.from(deduped.values());
}
