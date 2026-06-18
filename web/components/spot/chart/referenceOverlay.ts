export type ReferenceOverlayConfig = {
  enabled: boolean;
  kind: 'IRON' | 'GOLD' | 'STOCK' | 'RWA';
  symbol: string;
  title: string;
  valueLabel: string;
  sourceLabel: string;
  sourcePriceLabel?: string | null;
  description: string;
  lineTitle: string;
  lineColor: string;
  badgeColor?: string;
  displayPrice?: number | null;
  displayUnit?: string;
  priceSource?: 'MANUAL' | 'AUTO' | string;
  stale?: boolean;
  syncError?: string | null;
};

export type ReferenceOverlayTranslator = (key: string, namespace?: 'asset') => string;

const IRON62_USD_PER_TON_TO_MFC_USDT_DIVISOR = 1000;

function normalizeReferenceSymbol(symbol: string) {
  return String(symbol || '').replace(/\//g, '').toUpperCase();
}

function formatReferenceText(template: string, values: Record<string, string>) {
  return Object.entries(values).reduce(
    (text, [key, value]) => text.replaceAll(`{${key}}`, value),
    template,
  );
}

function stripReferenceQuoteSuffix(symbol: string) {
  return normalizeReferenceSymbol(symbol)
    .replace(/2USDT$/, '')
    .replace(/USDT$/, '')
    .replace(/USD$/, '');
}

function getReferenceAssetSymbol(record: Record<string, unknown>, normalizedSymbol: string) {
  const sourceSymbol = String(record.source_symbol || record.auto_source || '').trim().toUpperCase();
  return sourceSymbol || stripReferenceQuoteSuffix(normalizedSymbol);
}

function formatReferenceNumber(value: number | null | undefined) {
  if (!Number.isFinite(value) || !value || value <= 0) return '';
  return value.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 8,
  });
}

function normalizeReferenceUnit(unit: string | null | undefined) {
  return String(unit || 'USDT').trim().toUpperCase() || 'USDT';
}

function localizedReferenceValueLabel(params: {
  kind: ReferenceOverlayConfig['kind'];
  displayPrice: number | null;
  displayUnit?: string | null;
  t: ReferenceOverlayTranslator;
}) {
  const { kind, displayPrice, displayUnit, t } = params;
  const price = formatReferenceNumber(displayPrice);
  if (!price) return '--';

  if (kind === 'IRON') {
    return formatReferenceText(t('spotReferenceIronValueLabel', 'asset'), {
      price,
      unit: t('spotReferenceUnitUsdPerKg', 'asset'),
    });
  }

  if (kind === 'GOLD') {
    return formatReferenceText(t('spotReferenceGoldValueLabel', 'asset'), {
      price,
      unit: t('spotReferenceUnitUsdPerOunce', 'asset'),
    });
  }

  const labelKey = kind === 'RWA' ? 'spotReferenceRwaValueLabel' : 'spotReferenceStockValueLabel';
  return formatReferenceText(t(labelKey, 'asset'), {
    price,
    unit: normalizeReferenceUnit(displayUnit),
  });
}

function localizedIronSourcePriceLabel(label: string | null | undefined, t: ReferenceOverlayTranslator) {
  const text = String(label || '').trim();
  if (!text) return null;
  const sourcePrice = text.match(/[\d,.]+(?:\.\d+)?/)?.[0];
  if (!sourcePrice) return text;
  return formatReferenceText(t('spotReferenceIronValueLabel', 'asset'), {
    price: sourcePrice,
    unit: t('spotReferenceUnitUsdPerTon', 'asset'),
  });
}

function localizedReferenceCopy(params: {
  kind: ReferenceOverlayConfig['kind'];
  symbol: string;
  displayPrice: number | null;
  displayUnit?: string | null;
  t: ReferenceOverlayTranslator;
}) {
  const { kind, symbol, displayPrice, displayUnit, t } = params;
  const values = { symbol };
  const valueLabel = localizedReferenceValueLabel({ kind, displayPrice, displayUnit, t });

  if (kind === 'IRON') {
    return {
      title: t('spotReferenceIronTitle', 'asset'),
      sourceLabel: t('spotReferenceIronSourceLabel', 'asset'),
      description: t('spotReferenceIronDescription', 'asset'),
      lineTitle: t('spotReferenceIronTitle', 'asset'),
      valueLabel,
    };
  }

  if (kind === 'GOLD') {
    return {
      title: t('spotReferenceGoldTitle', 'asset'),
      sourceLabel: t('spotReferenceGoldSourceLabel', 'asset'),
      description: t('spotReferenceGoldDescription', 'asset'),
      lineTitle: t('spotReferenceGoldTitle', 'asset'),
      valueLabel,
    };
  }

  const prefix = kind === 'RWA' ? 'spotReferenceRwa' : 'spotReferenceStock';
  const title = formatReferenceText(t(`${prefix}Title`, 'asset'), values);
  return {
    title,
    sourceLabel: formatReferenceText(t(`${prefix}SourceLabel`, 'asset'), values),
    description: formatReferenceText(t(`${prefix}Description`, 'asset'), values),
    lineTitle: title,
    valueLabel,
  };
}

export function getReferenceOverlayConfig(
  symbol: string,
  t: ReferenceOverlayTranslator,
): ReferenceOverlayConfig | null {
  const normalizedSymbol = normalizeReferenceSymbol(symbol);

  if (normalizedSymbol === 'MFCUSDT') {
    const copy = localizedReferenceCopy({
      kind: 'IRON',
      symbol: 'IRON62',
      displayPrice: 0.108,
      t,
    });
    return {
      enabled: true,
      kind: 'IRON',
      symbol: 'MFCUSDT',
      title: copy.title,
      valueLabel: copy.valueLabel,
      sourceLabel: copy.sourceLabel,
      sourcePriceLabel: formatReferenceText(t('spotReferenceIronValueLabel', 'asset'), {
        price: '108',
        unit: t('spotReferenceUnitUsdPerTon', 'asset'),
      }),
      description: copy.description,
      lineTitle: copy.lineTitle,
      lineColor: '#f0b90b',
      badgeColor: '#f0b90b',
      displayPrice: 0.108,
      displayUnit: 'USDT',
      priceSource: 'MANUAL',
      stale: false,
      syncError: null,
    };
  }

  // Reference mappings:
  // IGCUSDT: XAUUSD -> USDT/g
  // BON-2USDT: stock quote -> token reference
  // IMAA-2USDT: stock quote -> token reference
  return null;
}

export function toReferenceOverlayLinePriceUsdt(
  config: ReferenceOverlayConfig,
  sourcePrice: number,
) {
  if (!Number.isFinite(sourcePrice) || sourcePrice <= 0) return null;

  if (config.kind === 'IRON') {
    return sourcePrice / IRON62_USD_PER_TON_TO_MFC_USDT_DIVISOR;
  }

  return null;
}

export function normalizeReferenceOverlayConfig(
  payload: unknown,
  t: ReferenceOverlayTranslator,
): ReferenceOverlayConfig | null {
  if (!payload || typeof payload !== 'object') return null;

  const record = payload as Record<string, unknown>;
  if (record.enabled !== true) return null;

  const kind = String(record.reference_type || record.kind || '').toUpperCase();
  if (kind !== 'IRON' && kind !== 'GOLD' && kind !== 'STOCK' && kind !== 'RWA') return null;

  const symbol = normalizeReferenceSymbol(String(record.symbol || ''));
  if (!symbol) return null;

  const displayPrice = Number(record.display_price);
  const normalizedDisplayPrice = Number.isFinite(displayPrice) && displayPrice > 0 ? displayPrice : null;
  const displayUnit = normalizeReferenceUnit(String(record.display_unit || 'USDT'));
  const assetSymbol = getReferenceAssetSymbol(record, symbol);
  const rawSourcePriceLabel = typeof record.source_price_label === 'string'
    ? record.source_price_label.trim()
    : typeof record.last_ref_label === 'string'
      ? record.last_ref_label.trim()
      : null;
  const copy = localizedReferenceCopy({
    kind,
    symbol: assetSymbol || symbol,
    displayPrice: normalizedDisplayPrice,
    displayUnit,
    t,
  });

  return {
    enabled: true,
    kind,
    symbol,
    title: copy.title,
    valueLabel: copy.valueLabel,
    sourceLabel: copy.sourceLabel,
    sourcePriceLabel: kind === 'IRON' ? localizedIronSourcePriceLabel(rawSourcePriceLabel, t) : rawSourcePriceLabel,
    description: copy.description,
    lineTitle: copy.lineTitle,
    lineColor: String(record.line_color || '#f0b90b').trim(),
    badgeColor: String(record.badge_color || record.line_color || '#f0b90b').trim(),
    displayPrice: normalizedDisplayPrice,
    displayUnit,
    priceSource: String(record.price_source || 'MANUAL').trim().toUpperCase(),
    stale: record.stale === true,
    syncError: typeof record.sync_error === 'string' ? record.sync_error : null,
  };
}
