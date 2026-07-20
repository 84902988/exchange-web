import {
  normalizeSpotPricePrecision,
  precisionFromSpotTickSize,
  resolveSpotPricePrecision,
} from '../spotPricePrecision';

export type SpotTradingViewBootstrapPair = {
  symbol?: string | null;
  displaySymbol?: string | null;
  label?: string | null;
  displayPricePrecision?: number | null;
  pricePrecision?: number | null;
  priceTickSize?: string | number | null;
  amountPrecision?: number | null;
};

export type SpotTradingViewBootstrapMetadata = {
  symbol: string;
  displaySymbol: string;
  pricePrecision: number;
  amountPrecision: number;
};

const spotTradingViewBootstrapCache = new Map<string, SpotTradingViewBootstrapMetadata>();

function normalizeSpotTradingViewBootstrapSymbol(value?: string | null) {
  return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '');
}

export function resolveSpotTradingViewBootstrapMetadata(params: {
  symbol: string;
  pair?: SpotTradingViewBootstrapPair | null;
  fallbackDisplaySymbol: string;
}): SpotTradingViewBootstrapMetadata | null {
  const symbol = normalizeSpotTradingViewBootstrapSymbol(params.symbol);
  const pairSymbol = normalizeSpotTradingViewBootstrapSymbol(params.pair?.symbol);
  if (!symbol || pairSymbol !== symbol) return null;

  const displayPrecision = normalizeSpotPricePrecision(params.pair?.displayPricePrecision);
  const tickPrecision = precisionFromSpotTickSize(params.pair?.priceTickSize);
  const configuredPrecision = normalizeSpotPricePrecision(params.pair?.pricePrecision);
  const amountPrecision = normalizeSpotPricePrecision(params.pair?.amountPrecision);
  if (
    amountPrecision === null
    || (displayPrecision === null && tickPrecision === null && configuredPrecision === null)
  ) return null;

  return {
    symbol,
    displaySymbol: String(
      params.pair?.displaySymbol
      || params.pair?.label
      || params.fallbackDisplaySymbol
      || symbol,
    ).trim(),
    pricePrecision: resolveSpotPricePrecision({
      ...(displayPrecision !== null ? { displayPricePrecision: displayPrecision } : {}),
      ...(params.pair?.priceTickSize !== null && params.pair?.priceTickSize !== undefined
        ? { priceTickSize: params.pair.priceTickSize }
        : {}),
      ...(configuredPrecision !== null
        ? { pricePrecision: configuredPrecision, fallbackPrecision: configuredPrecision }
        : {}),
    }),
    amountPrecision,
  };
}

export function getSpotTradingViewBootstrapMetadata(symbol: string) {
  const normalizedSymbol = normalizeSpotTradingViewBootstrapSymbol(symbol);
  return spotTradingViewBootstrapCache.get(normalizedSymbol) || null;
}

export function rememberSpotTradingViewBootstrapMetadata(
  metadata: SpotTradingViewBootstrapMetadata,
) {
  spotTradingViewBootstrapCache.set(metadata.symbol, metadata);
  return metadata;
}

export function clearSpotTradingViewBootstrapMetadataCache() {
  spotTradingViewBootstrapCache.clear();
}
