export type SpotOrderSide = 'buy' | 'sell';

export type SpotOrderType = 'limit' | 'market';

export type SpotExecutableDepthFreshnessKind =
  | 'fresh'
  | 'stale'
  | 'delayed'
  | 'missing'
  | 'unknown'
  | 'loading';

export type SpotExecutableDepthRejectReason =
  | 'SYMBOL_SWITCHING'
  | 'SYMBOL_MISMATCH'
  | 'MARKET_NOT_TRADABLE'
  | 'DEPTH_LOADING'
  | 'DEPTH_STALE'
  | 'DEPTH_DELAYED'
  | 'DEPTH_MISSING'
  | 'DEPTH_UNKNOWN'
  | 'MISSING_ASK'
  | 'MISSING_BID';

export type SpotExecutableDepthInput = {
  currentSymbol: string;
  depthSymbol?: string | null;
  bestBid?: string | number | null;
  bestAsk?: string | number | null;
  depthSource?: string | null;
  depthFreshness?: string | null;
  depthStatus?: string | null;
  depthStale?: boolean | null;
  dataSource?: string | null;
  isLoading?: boolean;
  isSwitchingSymbol?: boolean;
  marketStatus?: string | null;
  pairMarketStatus?: string | null;
  pairEnabled?: boolean | null;
  pairStatus?: string | number | boolean | null;
};

export type SpotExecutableDepthState = {
  currentSymbol: string;
  depthSymbol: string | null;
  isCurrentSymbol: boolean;
  freshnessKind: SpotExecutableDepthFreshnessKind;
  hasFreshBid: boolean;
  hasFreshAsk: boolean;
  hasFreshTwoSidedBook: boolean;
  buyMarketExecutable: boolean;
  sellMarketExecutable: boolean;
  buyBboAvailable: boolean;
  sellBboAvailable: boolean;
  buyReferencePrice: string | number | null;
  sellReferencePrice: string | number | null;
  marketTradable: boolean;
  rejectReason: SpotExecutableDepthRejectReason | null;
  buyRejectReason: SpotExecutableDepthRejectReason | null;
  sellRejectReason: SpotExecutableDepthRejectReason | null;
  depthSource: string | null;
  depthFreshness: string | null;
  depthStatus: string | null;
  depthStale: boolean;
  dataSource: string | null;
  isLoading: boolean;
  marketStatus: string | null;
  pairMarketStatus: string | null;
  pairEnabled: boolean | null;
  pairStatus: string | number | boolean | null;
};

export type SpotOrderDepthInteraction = {
  side: SpotOrderSide;
  orderType: SpotOrderType;
  depthAllowsSubmit: boolean;
  orderExecutable: boolean;
  bboAvailable: boolean;
  referencePrice: string | number | null;
  rejectReason: SpotExecutableDepthRejectReason | null;
};

const FRESH_VALUES = new Set(['LIVE', 'RECENT']);
const STALE_VALUES = new Set(['STALE', 'EXPIRED']);
const DELAYED_VALUES = new Set([
  'DELAYED',
  'CACHED',
  'FALLBACK',
  'LAST_GOOD',
  'LAST_VALID',
]);
const MISSING_VALUES = new Set([
  'MISSING',
  'EMPTY',
  'UNAVAILABLE',
  'NONE',
  'NULL',
  'ERROR',
  'FAILED',
]);
const NON_TRADABLE_VALUES = new Set([
  '0',
  'CLOSE',
  'CLOSED',
  'DISABLED',
  'HALTED',
  'INACTIVE',
  'MAINTENANCE',
  'OFFLINE',
  'PAUSED',
  'SUSPENDED',
  'UNAVAILABLE',
  'DELISTED',
]);

function normalizeText(value: unknown): string {
  return String(value ?? '').trim().toUpperCase();
}

function normalizeSymbol(value: unknown): string {
  return normalizeText(value).replace(/[^A-Z0-9-]/g, '');
}

function normalizeEvidence(value: unknown): string | null {
  const normalized = normalizeText(value);
  return normalized || null;
}

function normalizePrice(value: unknown): string | number | null {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return typeof value === 'string' ? value.trim() : numeric;
}

function classifyUnsafeSignal(value: string | null): Exclude<SpotExecutableDepthFreshnessKind, 'fresh' | 'loading'> | null {
  if (!value || value === 'UNKNOWN') return 'unknown';
  if (STALE_VALUES.has(value)) return 'stale';
  if (DELAYED_VALUES.has(value)) return 'delayed';
  if (MISSING_VALUES.has(value)) return 'missing';
  return null;
}

function resolveFreshnessKind({
  depthSource,
  depthFreshness,
  depthStatus,
  depthStale,
  isLoading,
}: {
  depthSource: string | null;
  depthFreshness: string | null;
  depthStatus: string | null;
  depthStale: boolean;
  isLoading: boolean;
}): SpotExecutableDepthFreshnessKind {
  if (isLoading) return 'loading';
  if (depthStale) return 'stale';

  const sourceClassification = classifyUnsafeSignal(depthSource);
  const freshnessClassification = classifyUnsafeSignal(depthFreshness);
  const statusClassification = depthStatus ? classifyUnsafeSignal(depthStatus) : null;
  const classifications = [
    sourceClassification,
    freshnessClassification,
    statusClassification,
  ];

  if (classifications.includes('stale')) return 'stale';
  if (classifications.includes('delayed')) return 'delayed';
  if (classifications.includes('missing')) return 'missing';
  if (!FRESH_VALUES.has(depthFreshness || '')) return 'unknown';
  if (sourceClassification === 'unknown') return 'unknown';
  return 'fresh';
}

function isExplicitlyNonTradable(value: unknown): boolean {
  if (value === false || value === 0) return true;
  return NON_TRADABLE_VALUES.has(normalizeText(value));
}

function rejectReasonForFreshness(
  freshnessKind: SpotExecutableDepthFreshnessKind,
): SpotExecutableDepthRejectReason | null {
  switch (freshnessKind) {
    case 'loading':
      return 'DEPTH_LOADING';
    case 'stale':
      return 'DEPTH_STALE';
    case 'delayed':
      return 'DEPTH_DELAYED';
    case 'missing':
      return 'DEPTH_MISSING';
    case 'unknown':
      return 'DEPTH_UNKNOWN';
    case 'fresh':
    default:
      return null;
  }
}

export function resolveSpotExecutableDepth(
  input: SpotExecutableDepthInput,
): SpotExecutableDepthState {
  const currentSymbol = normalizeSymbol(input.currentSymbol);
  const depthSymbol = normalizeSymbol(input.depthSymbol) || null;
  const isLoading = Boolean(input.isLoading);
  const isSwitchingSymbol = Boolean(input.isSwitchingSymbol);
  const hasSymbolMismatch = Boolean(depthSymbol && currentSymbol && depthSymbol !== currentSymbol);
  const isCurrentSymbol = Boolean(
    !isSwitchingSymbol && currentSymbol && depthSymbol && !hasSymbolMismatch,
  );
  const depthSource = normalizeEvidence(input.depthSource);
  const depthFreshness = normalizeEvidence(input.depthFreshness);
  const depthStatus = normalizeEvidence(input.depthStatus);
  const dataSource = normalizeEvidence(input.dataSource);
  const marketStatus = normalizeEvidence(input.marketStatus);
  const pairMarketStatus = normalizeEvidence(input.pairMarketStatus);
  const depthStale = Boolean(input.depthStale);
  const freshnessKind = resolveFreshnessKind({
    depthSource,
    depthFreshness,
    depthStatus,
    depthStale,
    isLoading,
  });
  const normalizedBestBid = normalizePrice(input.bestBid);
  const normalizedBestAsk = normalizePrice(input.bestAsk);
  const pairEnabled = typeof input.pairEnabled === 'boolean' ? input.pairEnabled : null;
  const marketTradable = !(
    pairEnabled === false ||
    isExplicitlyNonTradable(marketStatus) ||
    isExplicitlyNonTradable(pairMarketStatus) ||
    isExplicitlyNonTradable(input.pairStatus)
  );
  const hasFreshDepthEvidence = isCurrentSymbol && freshnessKind === 'fresh';
  const hasFreshBid = hasFreshDepthEvidence && normalizedBestBid !== null;
  const hasFreshAsk = hasFreshDepthEvidence && normalizedBestAsk !== null;
  const hasFreshTwoSidedBook = hasFreshBid && hasFreshAsk;
  const buyMarketExecutable = marketTradable && hasFreshAsk;
  const sellMarketExecutable = marketTradable && hasFreshBid;
  const buyBboAvailable = buyMarketExecutable;
  const sellBboAvailable = sellMarketExecutable;

  let commonRejectReason: SpotExecutableDepthRejectReason | null = null;
  if (isSwitchingSymbol) {
    commonRejectReason = 'SYMBOL_SWITCHING';
  } else if (hasSymbolMismatch) {
    commonRejectReason = 'SYMBOL_MISMATCH';
  } else if (!marketTradable) {
    commonRejectReason = 'MARKET_NOT_TRADABLE';
  } else if (!depthSymbol) {
    commonRejectReason = 'DEPTH_MISSING';
  } else {
    commonRejectReason = rejectReasonForFreshness(freshnessKind);
  }

  const buyRejectReason = commonRejectReason || (hasFreshAsk ? null : 'MISSING_ASK');
  const sellRejectReason = commonRejectReason || (hasFreshBid ? null : 'MISSING_BID');
  const rejectReason = commonRejectReason || (
    !hasFreshBid && !hasFreshAsk ? 'DEPTH_MISSING' : null
  );

  return {
    currentSymbol,
    depthSymbol,
    isCurrentSymbol,
    freshnessKind,
    hasFreshBid,
    hasFreshAsk,
    hasFreshTwoSidedBook,
    buyMarketExecutable,
    sellMarketExecutable,
    buyBboAvailable,
    sellBboAvailable,
    buyReferencePrice: buyBboAvailable ? normalizedBestAsk : null,
    sellReferencePrice: sellBboAvailable ? normalizedBestBid : null,
    marketTradable,
    rejectReason,
    buyRejectReason,
    sellRejectReason,
    depthSource,
    depthFreshness,
    depthStatus,
    depthStale,
    dataSource,
    isLoading,
    marketStatus,
    pairMarketStatus,
    pairEnabled,
    pairStatus: input.pairStatus ?? null,
  };
}

export function resolveSpotOrderDepthInteraction(
  state: SpotExecutableDepthState,
  side: SpotOrderSide,
  orderType: SpotOrderType,
): SpotOrderDepthInteraction {
  const marketExecutable = side === 'buy'
    ? state.buyMarketExecutable
    : state.sellMarketExecutable;
  const bboAvailable = side === 'buy'
    ? state.buyBboAvailable
    : state.sellBboAvailable;
  const sideRejectReason = side === 'buy'
    ? state.buyRejectReason
    : state.sellRejectReason;
  const depthAllowsSubmit = orderType === 'limit' || marketExecutable;
  const hasOrderContextBlocker =
    state.rejectReason === 'SYMBOL_SWITCHING' ||
    state.rejectReason === 'SYMBOL_MISMATCH' ||
    state.rejectReason === 'MARKET_NOT_TRADABLE';
  const orderExecutable = orderType === 'limit'
    ? state.marketTradable && !hasOrderContextBlocker
    : marketExecutable;

  return {
    side,
    orderType,
    depthAllowsSubmit,
    orderExecutable,
    bboAvailable,
    referencePrice: bboAvailable
      ? side === 'buy'
        ? state.buyReferencePrice
        : state.sellReferencePrice
      : null,
    rejectReason: orderExecutable ? null : sideRejectReason || state.rejectReason,
  };
}
