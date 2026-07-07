export type SpotMarketStatusKind =
  | 'live'
  | 'snapshot'
  | 'fallback'
  | 'internal'
  | 'stale'
  | 'unavailable'
  | 'loading';

export type SpotMarketStatusKey =
  | 'live'
  | 'snapshot'
  | 'fallback'
  | 'internal'
  | 'delayed'
  | 'unavailable'
  | 'loading';

export type SpotMarketStatusTranslator = (
  key: string,
  namespace?: 'asset',
) => string;

export type SpotMarketStatusInput = {
  source?: string | null;
  freshness?: string | null;
  dataSource?: string | null;
  isLoading?: boolean;
};

export type SpotKlineLoadState = 'loading' | 'loaded' | 'empty' | 'error';

export type SpotKlineStatusInput = SpotMarketStatusInput & {
  loadState?: SpotKlineLoadState;
  realtimeUpdatedAtMs?: number | null;
  realtimeGraceMs?: number | null;
  nowMs?: number | null;
};

export type SpotMarketStatus = {
  kind: SpotMarketStatusKind;
  statusKey: SpotMarketStatusKey;
  label: string;
  fullLabel: string;
  compactLabel: string;
  isAvailable: boolean;
  isFresh: boolean;
};

const STATUS_KEY_BY_KIND: Record<SpotMarketStatusKind, SpotMarketStatusKey> = {
  live: 'live',
  snapshot: 'snapshot',
  fallback: 'fallback',
  internal: 'internal',
  stale: 'delayed',
  unavailable: 'unavailable',
  loading: 'loading',
};

const STATUS_LABEL_KEYS: Record<SpotMarketStatusKey, { full: string; compact: string }> = {
  live: {
    full: 'spotMarketStatusLive',
    compact: 'spotMarketStatusLiveCompact',
  },
  snapshot: {
    full: 'spotMarketStatusSnapshot',
    compact: 'spotMarketStatusSnapshotCompact',
  },
  fallback: {
    full: 'spotMarketStatusFallback',
    compact: 'spotMarketStatusFallbackCompact',
  },
  internal: {
    full: 'spotMarketStatusInternal',
    compact: 'spotMarketStatusInternalCompact',
  },
  delayed: {
    full: 'spotMarketStatusDelayed',
    compact: 'spotMarketStatusDelayedCompact',
  },
  unavailable: {
    full: 'spotMarketStatusUnavailable',
    compact: 'spotMarketStatusUnavailableCompact',
  },
  loading: {
    full: 'spotMarketStatusLoading',
    compact: 'spotMarketStatusLoadingCompact',
  },
};

const STATUS_FALLBACK_FULL: Record<SpotMarketStatusKey, string> = {
  live: 'Live',
  snapshot: 'Snapshot',
  fallback: 'Fallback',
  internal: 'Internal',
  delayed: 'Delayed',
  unavailable: 'Unavailable',
  loading: 'Loading',
};

const STATUS_FALLBACK_COMPACT: Record<SpotMarketStatusKey, string> = {
  live: 'Live',
  snapshot: 'Snap',
  fallback: 'FB',
  internal: 'INT',
  delayed: 'Delay',
  unavailable: 'N/A',
  loading: 'Load',
};

const UNAVAILABLE_VALUES = new Set(['MISSING', 'UNAVAILABLE', 'ERROR', 'FAILED', 'NONE', 'NULL']);
const LOADING_VALUES = new Set(['LOADING', 'PENDING']);
const INTERNAL_VALUES = new Set(['INTERNAL', 'LOCAL']);
const FALLBACK_VALUES = new Set(['FALLBACK', 'LAST_GOOD', 'LAST_VALID']);
const SNAPSHOT_VALUES = new Set(['REST', 'REST_SNAPSHOT', 'SNAPSHOT', 'REST_HISTORY', 'HISTORY']);
const UNKNOWN_VALUES = new Set(['', 'UNKNOWN']);

function translateAssetLabel(
  translate: SpotMarketStatusTranslator | undefined,
  key: string,
  fallback: string,
): string {
  const value = translate?.(key, 'asset');
  return value && value !== key ? value : fallback;
}

function buildSpotMarketStatus(kind: SpotMarketStatusKind, translate?: SpotMarketStatusTranslator): SpotMarketStatus {
  const statusKey = STATUS_KEY_BY_KIND[kind];
  const labelKeys = STATUS_LABEL_KEYS[statusKey];
  const fullLabel = translateAssetLabel(translate, labelKeys.full, STATUS_FALLBACK_FULL[statusKey]);
  const compactLabel = translateAssetLabel(translate, labelKeys.compact, STATUS_FALLBACK_COMPACT[statusKey]);

  return {
    kind,
    statusKey,
    label: fullLabel,
    fullLabel,
    compactLabel,
    isAvailable: kind !== 'unavailable' && kind !== 'loading',
    isFresh: kind === 'live' || kind === 'snapshot' || kind === 'internal',
  };
}

export function normalizeSpotMarketStatusValue(value?: string | null): string {
  return String(value || '').trim().toUpperCase();
}

export function resolveSpotMarketStatus(
  input: SpotMarketStatusInput,
  translate?: SpotMarketStatusTranslator,
): SpotMarketStatus {
  const source = normalizeSpotMarketStatusValue(input.source);
  const freshness = normalizeSpotMarketStatusValue(input.freshness);
  const dataSource = normalizeSpotMarketStatusValue(input.dataSource);

  let kind: SpotMarketStatusKind = 'unavailable';

  if (input.isLoading && !source && !freshness) {
    kind = 'loading';
  } else if (source && !UNKNOWN_VALUES.has(source)) {
    if (LOADING_VALUES.has(source)) {
      kind = 'loading';
    } else if (UNAVAILABLE_VALUES.has(source)) {
      kind = 'unavailable';
    } else if (source === 'STALE') {
      kind = 'stale';
    } else if (INTERNAL_VALUES.has(source)) {
      kind = 'internal';
    } else if (FALLBACK_VALUES.has(source)) {
      kind = 'fallback';
    } else if (source === 'LIVE_WS') {
      kind = 'live';
    } else if (SNAPSHOT_VALUES.has(source)) {
      kind = 'snapshot';
    }
  } else if (INTERNAL_VALUES.has(dataSource)) {
    kind = 'internal';
  } else if (freshness && !UNKNOWN_VALUES.has(freshness)) {
    if (LOADING_VALUES.has(freshness)) {
      kind = 'loading';
    } else if (UNAVAILABLE_VALUES.has(freshness)) {
      kind = 'unavailable';
    } else if (freshness === 'STALE') {
      kind = 'stale';
    } else if (INTERNAL_VALUES.has(freshness)) {
      kind = 'internal';
    } else if (FALLBACK_VALUES.has(freshness)) {
      kind = 'fallback';
    } else if (SNAPSHOT_VALUES.has(freshness) || freshness === 'LIVE' || freshness === 'RECENT') {
      kind = 'snapshot';
    }
  }

  return buildSpotMarketStatus(kind, translate);
}

export function spotMarketStatusBadgeClass(kind: SpotMarketStatusKind): string {
  switch (kind) {
    case 'live':
      return 'border-emerald-400/20 bg-emerald-400/10 text-emerald-200';
    case 'snapshot':
      return 'border-sky-300/18 bg-sky-300/10 text-sky-100';
    case 'fallback':
      return 'border-amber-300/22 bg-amber-300/10 text-amber-100';
    case 'internal':
      return 'border-[#f0b90b]/24 bg-[#f0b90b]/10 text-[#f0d27a]';
    case 'stale':
      return 'border-orange-300/22 bg-orange-300/10 text-orange-100';
    case 'loading':
      return 'border-white/[0.08] bg-white/[0.04] text-white/48';
    case 'unavailable':
    default:
      return 'border-white/[0.08] bg-white/[0.03] text-white/34';
  }
}

export function spotMarketStatusDotClass(kind: SpotMarketStatusKind): string {
  switch (kind) {
    case 'live':
      return 'bg-emerald-300 shadow-[0_0_8px_rgba(110,231,183,0.38)]';
    case 'snapshot':
      return 'bg-sky-300';
    case 'fallback':
      return 'bg-amber-300';
    case 'internal':
      return 'bg-[#f0b90b]';
    case 'stale':
      return 'bg-orange-300';
    case 'loading':
      return 'bg-white/36';
    case 'unavailable':
    default:
      return 'bg-white/22';
  }
}

export function formatSpotStatusBadgeText(
  input: SpotMarketStatusInput,
  translate?: SpotMarketStatusTranslator,
): string {
  return resolveSpotMarketStatus(input, translate).compactLabel;
}

export function resolveSpotKlineStatus(
  input: SpotKlineStatusInput,
  translate?: SpotMarketStatusTranslator,
): SpotMarketStatus {
  const source = normalizeSpotMarketStatusValue(input.source);
  const freshness = normalizeSpotMarketStatusValue(input.freshness);
  const dataSource = normalizeSpotMarketStatusValue(input.dataSource);
  const realtimeUpdatedAtMs = Number(input.realtimeUpdatedAtMs || 0);
  const realtimeGraceMs = Number(input.realtimeGraceMs || 0);
  const nowMs = Number(input.nowMs || Date.now());
  const hasRecentRealtime =
    realtimeUpdatedAtMs > 0 &&
    nowMs >= realtimeUpdatedAtMs &&
    nowMs - realtimeUpdatedAtMs <= (Number.isFinite(realtimeGraceMs) && realtimeGraceMs > 0 ? realtimeGraceMs : 30_000);

  if (INTERNAL_VALUES.has(source) || INTERNAL_VALUES.has(freshness) || INTERNAL_VALUES.has(dataSource)) {
    return resolveSpotMarketStatus(input, translate);
  }

  if (hasRecentRealtime) {
    return buildSpotMarketStatus('live', translate);
  }

  if (input.loadState === 'loaded') {
    return buildSpotMarketStatus('snapshot', translate);
  }

  if (input.loadState === 'loading' || input.isLoading) {
    return buildSpotMarketStatus('loading', translate);
  }

  if (input.loadState === 'empty' || input.loadState === 'error') {
    return buildSpotMarketStatus('unavailable', translate);
  }

  if (UNKNOWN_VALUES.has(source) && UNKNOWN_VALUES.has(freshness)) {
    return buildSpotMarketStatus('unavailable', translate);
  }

  return resolveSpotMarketStatus(input, translate);
}

export function getSpotBboBasisLabel(
  side: 'buy' | 'sell',
  translate?: SpotMarketStatusTranslator,
): string {
  return side === 'buy'
    ? translateAssetLabel(translate, 'spotBboBasisBuy', 'Price basis: best ask')
    : translateAssetLabel(translate, 'spotBboBasisSell', 'Price basis: best bid');
}

export function getSpotBboAvailabilityLabel(
  status: SpotMarketStatus,
  hasBboPrice: boolean,
  translate?: SpotMarketStatusTranslator,
): string {
  return status.isFresh && hasBboPrice
    ? translateAssetLabel(translate, 'spotBboAvailable', 'Available')
    : translateAssetLabel(translate, 'spotBboUnavailable', 'Unavailable');
}
