import type { AdvancedChartIndicatorConfigV2 } from './advancedChartIndicators';

export const ADVANCED_CHART_MARKETS = ['spot', 'contract'] as const;
export const ADVANCED_CHART_INTERVALS = [
  '1m',
  '5m',
  '15m',
  '1h',
  '4h',
  '1d',
] as const;

export type AdvancedChartMarket = typeof ADVANCED_CHART_MARKETS[number];
export type AdvancedChartInterval = typeof ADVANCED_CHART_INTERVALS[number];
export type AdvancedChartLocale = 'en' | 'zh' | 'zh-TW' | 'ja';

export type AdvancedChartQuery = Readonly<{
  market: AdvancedChartMarket;
  symbol: string;
  interval: AdvancedChartInterval;
  locale: AdvancedChartLocale;
  sessionId: string;
  category: string | null;
}>;

export type AdvancedChartBootstrap = Readonly<{
  market: AdvancedChartMarket;
  symbol: string;
  displaySymbol: string;
  category: string | null;
  pricePrecision: number;
  amountPrecision: number;
  logoUrl: string | null;
  logoAlt: string | null;
}>;

export const ADVANCED_CHART_BOOTSTRAP_CACHE_TTL_MS = 10 * 60 * 1000;
export const ADVANCED_CHART_BOOTSTRAP_CACHE_MAX_ENTRIES = 8;

const ADVANCED_CHART_BOOTSTRAP_CACHE_KEY =
  'mobile-advanced-chart:bootstrap:v2';
const ADVANCED_CHART_BOOTSTRAP_LEGACY_CACHE_KEY =
  'mobile-advanced-chart:bootstrap:v1';
const ADVANCED_CHART_BOOTSTRAP_CACHE_SCHEMA_VERSION = 2;

type AdvancedChartBootstrapStorage = Pick<
  Storage,
  'getItem' | 'setItem' | 'removeItem'
>;

type AdvancedChartBootstrapCacheOptions = Readonly<{
  storage?: AdvancedChartBootstrapStorage | null;
  nowMs?: number;
}>;

export type AdvancedChartFailure = Readonly<{
  code: 'INVALID_QUERY' | 'SYMBOL_NOT_FOUND' | 'METADATA_INVALID';
  message: string;
}>;

export type AdvancedChartResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: AdvancedChartFailure }>;

type SpotBootstrapItem = Readonly<{
  symbol?: unknown;
  display_symbol?: unknown;
  display_price_precision?: unknown;
  price_tick_size?: unknown;
  tick_size?: unknown;
  price_precision?: unknown;
  amount_precision?: unknown;
  base_asset_logo_url?: unknown;
  spot_logo_url?: unknown;
  spot_logo_alt?: unknown;
}>;

type ContractBootstrapItem = Readonly<{
  symbol?: unknown;
  display_name?: unknown;
  category?: unknown;
  price_precision?: unknown;
  quantity_precision?: unknown;
  base_asset_logo_url?: unknown;
}>;

type AdvancedChartBridgeIndicatorSelection = Readonly<{
  overlay: 'MA' | 'EMA' | 'BOLL' | 'SAR' | 'AVL' | 'SUPER';
  pane: 'VOL' | 'MACD' | 'RSI' | 'KDJ' | 'OBV' | 'WR' | 'StochRSI';
}>;

export type AdvancedChartBridgeEvent =
  | Readonly<{
      type: 'CHART_READY';
      sessionId: string;
      capabilities: readonly ['indicator-config-v2'];
    }>
  | Readonly<{ type: 'CHART_ERROR'; sessionId: string; message: string }>
  | Readonly<{
      type: 'INTERVAL_COMMITTED';
      sessionId: string;
      interval: AdvancedChartInterval;
    }>
  | Readonly<{
      type: 'INDICATORS_COMMITTED';
      sessionId: string;
      intentId: number;
      indicators: AdvancedChartBridgeIndicatorSelection;
    }>
  | Readonly<{
      type: 'INDICATORS_ERROR';
      sessionId: string;
      intentId: number;
      message: string;
      indicators: AdvancedChartBridgeIndicatorSelection | null;
    }>
  | Readonly<{
      type: 'INDICATOR_CONFIG_COMMITTED';
      sessionId: string;
      intentId: number;
      config: AdvancedChartIndicatorConfigV2;
    }>
  | Readonly<{
      type: 'INDICATOR_CONFIG_ERROR';
      sessionId: string;
      intentId: number;
      message: string;
      config: AdvancedChartIndicatorConfigV2 | null;
    }>;

const ALLOWED_QUERY_KEYS = new Set([
  'market',
  'symbol',
  'interval',
  'lang',
  'sessionId',
  'category',
]);
const SPOT_SYMBOL_PATTERN = /^[A-Z0-9][A-Z0-9-]{0,63}$/;
const CONTRACT_SYMBOL_PATTERN = /^[A-Z0-9][A-Z0-9._-]{0,63}$/;
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;
const CATEGORY_PATTERN = /^[A-Z][A-Z0-9_]{0,31}$/;
const INTERVAL_SET = new Set<string>(ADVANCED_CHART_INTERVALS);
const LOCALE_ALIASES: Readonly<Record<string, AdvancedChartLocale>> = {
  en: 'en',
  'en-US': 'en',
  ja: 'ja',
  'ja-JP': 'ja',
  zh: 'zh',
  'zh-CN': 'zh',
  'zh-TW': 'zh-TW',
};

function failure(
  code: AdvancedChartFailure['code'],
  message: string,
): AdvancedChartResult<never> {
  return { ok: false, error: { code, message } };
}

function normalizeMarket(value: string | null): AdvancedChartMarket | null {
  const normalized = String(value || '').trim().toLowerCase();
  return ADVANCED_CHART_MARKETS.includes(normalized as AdvancedChartMarket)
    ? normalized as AdvancedChartMarket
    : null;
}

function normalizeSymbol(value: unknown, market: AdvancedChartMarket) {
  const normalized = String(value || '').trim().toUpperCase();
  const pattern = market === 'spot' ? SPOT_SYMBOL_PATTERN : CONTRACT_SYMBOL_PATTERN;
  return pattern.test(normalized) ? normalized : null;
}

function normalizeInterval(value: string | null): AdvancedChartInterval | null {
  const normalized = String(value || '1m').trim();
  return INTERVAL_SET.has(normalized) ? normalized as AdvancedChartInterval : null;
}

export function isAdvancedChartInterval(value: unknown): value is AdvancedChartInterval {
  return INTERVAL_SET.has(String(value || '').trim());
}

export function getAdvancedChartSessionIdForBridge(rawQuery: string) {
  const sessionId = new URLSearchParams(rawQuery).get('sessionId');
  return sessionId
    && sessionId === sessionId.trim()
    && SESSION_ID_PATTERN.test(sessionId)
    ? sessionId
    : null;
}

function normalizeLocale(value: string | null): AdvancedChartLocale | null {
  const normalized = String(value || 'zh').trim();
  return LOCALE_ALIASES[normalized] || null;
}

function safeDisplayText(value: unknown, fallback: string) {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > 80 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    return fallback;
  }
  return normalized;
}

function safeOptionalText(value: unknown, maxLength = 160) {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) {
    return null;
  }
  return normalized;
}

function safeImageUrl(value: unknown) {
  const normalized = safeOptionalText(value, 512);
  if (!normalized) return null;
  if (normalized.startsWith('/')) return normalized;
  try {
    const url = new URL(normalized);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function getBrowserBootstrapStorage(): AdvancedChartBootstrapStorage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function resolveBootstrapStorage(
  options: AdvancedChartBootstrapCacheOptions,
) {
  return options.storage === undefined
    ? getBrowserBootstrapStorage()
    : options.storage;
}

function advancedChartBootstrapCacheIdentity(query: AdvancedChartQuery) {
  const category = query.market === 'contract'
    ? query.category || 'AUTO'
    : 'SPOT';
  return [query.market, query.symbol, category].join(':');
}

type AdvancedChartBootstrapCacheEntry = Readonly<{
  identity: string;
  cachedAtMs: number;
  value: unknown;
}>;

function parseBootstrapCacheEntries(raw: string | null) {
  if (!raw) return [];
  const parsed = JSON.parse(raw) as {
    version?: unknown;
    entries?: unknown;
  };
  if (
    parsed.version !== ADVANCED_CHART_BOOTSTRAP_CACHE_SCHEMA_VERSION
    || !Array.isArray(parsed.entries)
  ) {
    throw new Error('invalid advanced chart bootstrap cache');
  }
  const entriesValid = parsed.entries.every((entry) => (
    Boolean(entry)
    && typeof entry === 'object'
    && typeof (entry as AdvancedChartBootstrapCacheEntry).identity === 'string'
  ));
  if (!entriesValid) throw new Error('invalid advanced chart bootstrap cache');
  return parsed.entries as AdvancedChartBootstrapCacheEntry[];
}

function writeBootstrapCacheEntries(
  storage: AdvancedChartBootstrapStorage,
  entries: readonly AdvancedChartBootstrapCacheEntry[],
) {
  if (!entries.length) {
    storage.removeItem(ADVANCED_CHART_BOOTSTRAP_CACHE_KEY);
    return;
  }
  storage.setItem(
    ADVANCED_CHART_BOOTSTRAP_CACHE_KEY,
    JSON.stringify({
      version: ADVANCED_CHART_BOOTSTRAP_CACHE_SCHEMA_VERSION,
      entries,
    }),
  );
}

function hasFreshBootstrapTimestamp(cachedAtMs: unknown, nowMs: number) {
  const numeric = Number(cachedAtMs);
  const ageMs = nowMs - numeric;
  return Number.isFinite(numeric)
    && numeric >= 0
    && ageMs >= 0
    && ageMs <= ADVANCED_CHART_BOOTSTRAP_CACHE_TTL_MS;
}

function sanitizeCachedBootstrap(
  value: unknown,
  query: AdvancedChartQuery,
): AdvancedChartBootstrap | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Partial<AdvancedChartBootstrap>;
  if (item.market !== query.market || item.symbol !== query.symbol) return null;

  const displaySymbol = safeDisplayText(item.displaySymbol, '');
  if (!displaySymbol || displaySymbol !== item.displaySymbol) return null;

  const pricePrecision = parsePrecision(item.pricePrecision);
  const amountPrecision = parsePrecision(item.amountPrecision);
  if (
    pricePrecision === null
    || amountPrecision === null
    || pricePrecision !== item.pricePrecision
    || amountPrecision !== item.amountPrecision
  ) {
    return null;
  }

  const category = typeof item.category === 'string'
    ? item.category.trim().toUpperCase()
    : null;
  if (query.market === 'spot') {
    if (item.category !== null) return null;
  } else if (
    !category
    || !CATEGORY_PATTERN.test(category)
    || category !== item.category
  ) {
    return null;
  }

  const logoUrl = item.logoUrl === null ? null : safeImageUrl(item.logoUrl);
  if (item.logoUrl !== null && logoUrl !== item.logoUrl) return null;
  const logoAlt = item.logoAlt === null
    ? null
    : safeOptionalText(item.logoAlt, 80);
  if (item.logoAlt !== null && logoAlt !== item.logoAlt) return null;

  return {
    market: query.market,
    symbol: query.symbol,
    displaySymbol,
    category,
    pricePrecision,
    amountPrecision,
    logoUrl,
    logoAlt,
  };
}

export function readAdvancedChartBootstrapCache(
  query: AdvancedChartQuery,
  options: AdvancedChartBootstrapCacheOptions = {},
) {
  const storage = resolveBootstrapStorage(options);
  if (!storage) return null;
  const nowMs = options.nowMs ?? Date.now();
  if (!Number.isFinite(nowMs)) return null;

  try {
    storage.removeItem(ADVANCED_CHART_BOOTSTRAP_LEGACY_CACHE_KEY);
    const entries = parseBootstrapCacheEntries(
      storage.getItem(ADVANCED_CHART_BOOTSTRAP_CACHE_KEY),
    );
    const freshEntries = entries
      .filter((entry) => hasFreshBootstrapTimestamp(entry.cachedAtMs, nowMs))
      .slice(0, ADVANCED_CHART_BOOTSTRAP_CACHE_MAX_ENTRIES);
    const identity = advancedChartBootstrapCacheIdentity(query);
    const entry = freshEntries.find((item) => item.identity === identity);
    const value = entry ? sanitizeCachedBootstrap(entry.value, query) : null;

    const retainedEntries = value
      ? freshEntries
      : freshEntries.filter((item) => item.identity !== identity);
    if (
      retainedEntries.length !== entries.length
      || retainedEntries.some((item, index) => item !== entries[index])
    ) {
      writeBootstrapCacheEntries(storage, retainedEntries);
    }
    return value || null;
  } catch {
    try {
      storage.removeItem(ADVANCED_CHART_BOOTSTRAP_CACHE_KEY);
    } catch {
      // Storage is an optional performance cache; failures stay fail-open.
    }
    return null;
  }
}

export function writeAdvancedChartBootstrapCache(
  query: AdvancedChartQuery,
  value: AdvancedChartBootstrap,
  options: AdvancedChartBootstrapCacheOptions = {},
) {
  const storage = resolveBootstrapStorage(options);
  if (!storage) return false;
  const cachedAtMs = options.nowMs ?? Date.now();
  const sanitized = sanitizeCachedBootstrap(value, query);
  if (!Number.isFinite(cachedAtMs) || cachedAtMs < 0 || !sanitized) {
    return false;
  }

  try {
    let entries: AdvancedChartBootstrapCacheEntry[] = [];
    try {
      entries = parseBootstrapCacheEntries(
        storage.getItem(ADVANCED_CHART_BOOTSTRAP_CACHE_KEY),
      );
    } catch {
      // Replace a malformed optional cache with the validated current entry.
    }
    const identity = advancedChartBootstrapCacheIdentity(query);
    const nextEntries = [
      { identity, cachedAtMs, value: sanitized },
      ...entries.filter((entry) => (
        entry.identity !== identity
        && hasFreshBootstrapTimestamp(entry.cachedAtMs, cachedAtMs)
      )),
    ].slice(0, ADVANCED_CHART_BOOTSTRAP_CACHE_MAX_ENTRIES);
    writeBootstrapCacheEntries(storage, nextEntries);
    return true;
  } catch {
    return false;
  }
}

export function clearAdvancedChartBootstrapCache(
  query: AdvancedChartQuery,
  options: Pick<AdvancedChartBootstrapCacheOptions, 'storage'> = {},
) {
  const storage = resolveBootstrapStorage(options);
  if (!storage) return;
  try {
    const identity = advancedChartBootstrapCacheIdentity(query);
    const entries = parseBootstrapCacheEntries(
      storage.getItem(ADVANCED_CHART_BOOTSTRAP_CACHE_KEY),
    );
    writeBootstrapCacheEntries(
      storage,
      entries.filter((entry) => entry.identity !== identity),
    );
  } catch {
    try {
      storage.removeItem(ADVANCED_CHART_BOOTSTRAP_CACHE_KEY);
    } catch {
      // Retry still proceeds through the network when storage is unavailable.
    }
  }
}

function parsePrecision(value: unknown, maximum = 12) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric >= 0 && numeric <= maximum
    ? numeric
    : null;
}

function parseTickSizePrecision(value: unknown) {
  if (
    (typeof value !== 'string' && typeof value !== 'number')
    || String(value).trim() === ''
  ) {
    return null;
  }
  const text = String(value).trim().toLowerCase();
  const numeric = Number(text);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  const [coefficient, exponentText] = text.split('e');
  const exponent = exponentText === undefined ? 0 : Number(exponentText);
  if (!Number.isInteger(exponent)) return null;
  const decimals = (coefficient.split('.')[1] || '').replace(/0+$/, '').length;
  return parsePrecision(Math.max(0, decimals - exponent));
}

function exactMatches<T extends { symbol?: unknown }>(
  items: readonly T[],
  symbol: string,
  market: AdvancedChartMarket,
) {
  return items.filter((item) => normalizeSymbol(item.symbol, market) === symbol);
}

export function parseAdvancedChartQuery(rawQuery: string): AdvancedChartResult<AdvancedChartQuery> {
  const params = new URLSearchParams(rawQuery);
  for (const key of params.keys()) {
    if (!ALLOWED_QUERY_KEYS.has(key) || params.getAll(key).length !== 1) {
      return failure('INVALID_QUERY', '图表参数无效');
    }
  }

  const market = normalizeMarket(params.get('market'));
  if (!market) return failure('INVALID_QUERY', '缺少有效的市场类型');

  const symbol = normalizeSymbol(params.get('symbol'), market);
  if (!symbol) return failure('INVALID_QUERY', '交易对参数无效');

  const interval = normalizeInterval(params.get('interval'));
  if (!interval) return failure('INVALID_QUERY', 'K 线周期参数无效');

  const locale = normalizeLocale(params.get('lang'));
  if (!locale) return failure('INVALID_QUERY', '语言参数无效');

  const sessionId = params.get('sessionId');
  if (!sessionId || sessionId !== sessionId.trim() || !SESSION_ID_PATTERN.test(sessionId)) {
    return failure('INVALID_QUERY', '图表会话参数无效');
  }

  const rawCategory = params.get('category');
  if (market === 'spot' && rawCategory !== null) {
    return failure('INVALID_QUERY', '现货图表不接受合约分类参数');
  }
  const category = rawCategory === null ? null : rawCategory.trim().toUpperCase();
  if (category !== null && !CATEGORY_PATTERN.test(category)) {
    return failure('INVALID_QUERY', '合约分类参数无效');
  }

  return {
    ok: true,
    value: { market, symbol, interval, locale, sessionId, category },
  };
}

export function resolveExactSpotBootstrap(
  items: readonly SpotBootstrapItem[],
  requestedSymbol: string,
): AdvancedChartResult<AdvancedChartBootstrap> {
  const symbol = normalizeSymbol(requestedSymbol, 'spot');
  if (!symbol) return failure('INVALID_QUERY', '交易对参数无效');

  const matches = exactMatches(items, symbol, 'spot');
  if (!matches.length) return failure('SYMBOL_NOT_FOUND', '未找到对应的现货交易对');

  const item = matches[0];
  const pricePrecision = parsePrecision(item.display_price_precision)
    ?? parseTickSizePrecision(item.price_tick_size ?? item.tick_size)
    ?? parsePrecision(item.price_precision);
  const amountPrecision = parsePrecision(item.amount_precision);
  if (pricePrecision === null || amountPrecision === null) {
    return failure('METADATA_INVALID', '现货交易对精度信息不完整');
  }

  return {
    ok: true,
    value: {
      market: 'spot',
      symbol,
      displaySymbol: safeDisplayText(item.display_symbol, symbol),
      category: null,
      pricePrecision,
      amountPrecision,
      logoUrl: safeImageUrl(item.spot_logo_url || item.base_asset_logo_url),
      logoAlt: safeOptionalText(item.spot_logo_alt, 80),
    },
  };
}

export function resolveExactContractBootstrap(
  items: readonly ContractBootstrapItem[],
  requestedSymbol: string,
): AdvancedChartResult<AdvancedChartBootstrap> {
  const symbol = normalizeSymbol(requestedSymbol, 'contract');
  if (!symbol) return failure('INVALID_QUERY', '交易对参数无效');

  const matches = exactMatches(items, symbol, 'contract');
  if (!matches.length) return failure('SYMBOL_NOT_FOUND', '未找到对应的合约交易对');

  const item = matches[0];
  const pricePrecision = parsePrecision(item.price_precision);
  const amountPrecision = parsePrecision(item.quantity_precision);
  const category = safeOptionalText(item.category, 32)?.toUpperCase() || null;
  if (pricePrecision === null || amountPrecision === null || !category) {
    return failure('METADATA_INVALID', '合约交易对元数据不完整');
  }

  return {
    ok: true,
    value: {
      market: 'contract',
      symbol,
      displaySymbol: safeDisplayText(item.display_name, symbol),
      category,
      pricePrecision,
      amountPrecision,
      logoUrl: safeImageUrl(item.base_asset_logo_url),
      logoAlt: null,
    },
  };
}

export function createAdvancedChartBridgeEmitter(
  postMessage: (message: string) => void,
) {
  const sentLifecycleSignatures = new Set<string>();
  let lastCommittedInterval: AdvancedChartInterval | null = null;
  let lastCommittedIndicators = '';
  let lastCommittedIndicatorConfig = '';

  return {
    emit(event: AdvancedChartBridgeEvent) {
      if (event.type === 'INTERVAL_COMMITTED') {
        if (!event.interval || event.interval === lastCommittedInterval) return false;
        postMessage(JSON.stringify(event));
        lastCommittedInterval = event.interval;
        return true;
      }

      if (event.type === 'INDICATORS_COMMITTED') {
        const signature = `${event.intentId}|${event.indicators.overlay}|${event.indicators.pane}`;
        if (signature === lastCommittedIndicators) return false;
        postMessage(JSON.stringify(event));
        lastCommittedIndicators = signature;
        return true;
      }

      if (event.type === 'INDICATORS_ERROR') {
        postMessage(JSON.stringify(event));
        return true;
      }

      if (event.type === 'INDICATOR_CONFIG_COMMITTED') {
        const signature = `${event.intentId}|${JSON.stringify(event.config)}`;
        if (signature === lastCommittedIndicatorConfig) return false;
        postMessage(JSON.stringify(event));
        lastCommittedIndicatorConfig = signature;
        return true;
      }

      if (event.type === 'INDICATOR_CONFIG_ERROR') {
        postMessage(JSON.stringify(event));
        return true;
      }

      const signature = [
        event.type,
        event.sessionId,
        event.type === 'CHART_ERROR' ? event.message : '',
      ].join('|');
      if (sentLifecycleSignatures.has(signature)) return false;
      postMessage(JSON.stringify(event));
      sentLifecycleSignatures.add(signature);
      return true;
    },
  };
}
