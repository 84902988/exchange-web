import type {
  ContractTradingRouteParams,
  TradingRouteParams,
} from './types';

export type NormalizedSpotTradingRoute = TradingRouteParams;

export type NormalizedContractTradingRoute = TradingRouteParams & {
  marketCategory: 'crypto' | 'stock' | 'cfd';
};

export const DEFAULT_SPOT_TRADING_ROUTE: NormalizedSpotTradingRoute = {
  symbol: 'BTCUSDT',
  baseAsset: 'BTC',
  quoteAsset: 'USDT',
  displayLabel: 'BTC/USDT',
};

export const DEFAULT_CONTRACT_TRADING_ROUTE: NormalizedContractTradingRoute = {
  symbol: 'BTCUSDT_PERP',
  baseAsset: 'BTC',
  quoteAsset: 'USDT',
  displayLabel: 'BTC/USDT 永续',
  marketCategory: 'crypto',
};

const SYMBOL_PATTERN = /^[A-Z0-9][A-Z0-9._:-]{0,63}$/;
const ASSET_PATTERN = /^[A-Z0-9][A-Z0-9._-]{0,31}$/;

function normalizeIdentifier(value: unknown, pattern: RegExp) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toUpperCase();
  return pattern.test(normalized) ? normalized : null;
}

function normalizeDisplayLabel(value: unknown) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  const hasControlCharacter = Array.from(normalized).some(character => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
  if (
    !normalized ||
    normalized.length > 80 ||
    hasControlCharacter
  ) {
    return null;
  }
  return normalized;
}

function normalizeLogoUrl(value: unknown) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  const hasControlCharacter = Array.from(normalized).some(character => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
  if (!normalized || normalized.length > 2048 || hasControlCharacter) {
    return null;
  }
  return normalized;
}

function normalizeTradingRoute(
  params: Partial<TradingRouteParams> | null | undefined,
) {
  const symbol = normalizeIdentifier(params?.symbol, SYMBOL_PATTERN);
  const baseAsset = normalizeIdentifier(params?.baseAsset, ASSET_PATTERN);
  const quoteAsset = normalizeIdentifier(params?.quoteAsset, ASSET_PATTERN);
  const displayLabel = normalizeDisplayLabel(params?.displayLabel);
  if (
    !symbol ||
    !baseAsset ||
    !quoteAsset ||
    baseAsset === quoteAsset ||
    !displayLabel
  ) {
    return null;
  }
  const logoUrl = normalizeLogoUrl(params?.logoUrl);
  return {
    symbol,
    baseAsset,
    quoteAsset,
    displayLabel,
    ...(logoUrl ? {logoUrl} : {}),
  };
}

export function normalizeSpotTradingRouteParams(
  params: Partial<TradingRouteParams> | null | undefined,
): NormalizedSpotTradingRoute {
  return normalizeTradingRoute(params) || DEFAULT_SPOT_TRADING_ROUTE;
}

export function normalizeContractTradingRouteParams(
  params: Partial<ContractTradingRouteParams> | null | undefined,
): NormalizedContractTradingRoute {
  const normalized = normalizeTradingRoute(params);
  if (!normalized) return DEFAULT_CONTRACT_TRADING_ROUTE;
  return {
    ...normalized,
    marketCategory: ['crypto', 'stock', 'cfd'].includes(
      params?.marketCategory || '',
    )
      ? params!.marketCategory!
      : 'crypto',
  };
}
