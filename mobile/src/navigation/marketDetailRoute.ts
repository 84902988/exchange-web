import type {
  MarketDetailInitialKline,
  MarketDetailReferencePriceLine,
  MarketDetailRouteParams,
} from './types';

const SYMBOL_PATTERN = /^[A-Z0-9][A-Z0-9._:-]{0,63}$/;
const ASSET_PATTERN = /^[A-Z0-9][A-Z0-9._-]{0,31}$/;
const KLINE_INTERVALS = new Set(['1m', '5m', '15m', '1h', '4h', '1d']);
const MAX_INITIAL_KLINES = 48;
const MAX_REFERENCE_PRICE_LINES = 12;
const REFERENCE_PRICE_LINE_KINDS = new Set([
  'ENTRY',
  'TAKE_PROFIT',
  'STOP_LOSS',
]);

function normalizeIdentifier(value: unknown, pattern: RegExp) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toUpperCase();
  return pattern.test(normalized) ? normalized : null;
}

function normalizeDisplayLabel(value: unknown) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > 80) return null;
  const hasControlCharacter = Array.from(normalized).some(character => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
  return hasControlCharacter ? null : normalized;
}

function normalizeInitialKline(value: unknown): MarketDetailInitialKline | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const openTime = Number(raw.openTime);
  const open = Number(raw.open);
  const high = Number(raw.high);
  const low = Number(raw.low);
  const close = Number(raw.close);
  const volume = Number(raw.volume);
  if (
    !Number.isFinite(openTime) ||
    openTime <= 0 ||
    !Number.isFinite(open) ||
    open <= 0 ||
    !Number.isFinite(high) ||
    high <= 0 ||
    !Number.isFinite(low) ||
    low <= 0 ||
    !Number.isFinite(close) ||
    close <= 0 ||
    !Number.isFinite(volume) ||
    volume < 0 ||
    high < Math.max(open, close) ||
    low > Math.min(open, close)
  ) {
    return null;
  }
  return {openTime, open, high, low, close, volume};
}

function normalizeInitialKlines(value: unknown) {
  if (!Array.isArray(value)) return [];
  const normalized = value
    .slice(-MAX_INITIAL_KLINES)
    .map(normalizeInitialKline);
  if (normalized.some(item => item === null)) return [];
  return (normalized as MarketDetailInitialKline[])
    .sort((left, right) => left.openTime - right.openTime)
    .filter(
      (item, index, items) =>
        index === 0 || item.openTime !== items[index - 1].openTime,
    );
}

function normalizeReferencePriceLines(value: unknown) {
  if (!Array.isArray(value)) return [];
  const lines: MarketDetailReferencePriceLine[] = [];
  for (const item of value.slice(0, MAX_REFERENCE_PRICE_LINES)) {
    if (!item || typeof item !== 'object') return [];
    const raw = item as Record<string, unknown>;
    const key = normalizeDisplayLabel(raw.key);
    const label = normalizeDisplayLabel(raw.label);
    const kind =
      typeof raw.kind === 'string' &&
      REFERENCE_PRICE_LINE_KINDS.has(raw.kind)
        ? (raw.kind as MarketDetailReferencePriceLine['kind'])
        : null;
    const price = Number(raw.price);
    if (!key || !label || !kind || !Number.isFinite(price) || price <= 0) {
      return [];
    }
    lines.push({key, kind, label, price});
  }
  return lines;
}

export function parseMarketDetailRouteParams(
  value: unknown,
): MarketDetailRouteParams | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (raw.market !== 'spot' && raw.market !== 'contract') return null;
  const symbol = normalizeIdentifier(raw.symbol, SYMBOL_PATTERN);
  const baseAsset = normalizeIdentifier(raw.baseAsset, ASSET_PATTERN);
  const quoteAsset = normalizeIdentifier(raw.quoteAsset, ASSET_PATTERN);
  const displayLabel = normalizeDisplayLabel(raw.displayLabel);
  if (!symbol || !baseAsset || !quoteAsset || !displayLabel) return null;
  if (baseAsset === quoteAsset) return null;
  const initialInterval =
    typeof raw.initialInterval === 'string' &&
    KLINE_INTERVALS.has(raw.initialInterval)
      ? (raw.initialInterval as MarketDetailRouteParams['initialInterval'])
      : '1m';
  const initialKlines = normalizeInitialKlines(raw.initialKlines);
  const preview = initialKlines.length > 0 ? {initialKlines} : {};
  if (raw.market === 'spot') {
    return {
      market: 'spot',
      symbol,
      baseAsset,
      quoteAsset,
      displayLabel,
      initialInterval,
      ...preview,
    };
  }
  const referencePriceLines = normalizeReferencePriceLines(
    raw.referencePriceLines,
  );
  return {
    market: 'contract',
    symbol,
    baseAsset,
    quoteAsset,
    displayLabel,
    marketCategory: raw.marketCategory === 'stock' ? 'stock' : 'cfd',
    initialInterval,
    ...preview,
    ...(referencePriceLines.length > 0 ? {referencePriceLines} : {}),
  };
}
