export type SpotMarketStatusKind =
  | 'live'
  | 'snapshot'
  | 'fallback'
  | 'internal'
  | 'stale'
  | 'unavailable'
  | 'loading';

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
  label: string;
  isAvailable: boolean;
  isFresh: boolean;
};

const STATUS_LABELS: Record<SpotMarketStatusKind, string> = {
  live: '实时',
  snapshot: '快照',
  fallback: '兜底',
  internal: '内盘',
  stale: '延迟',
  unavailable: '暂不可用',
  loading: '加载中',
};

const UNAVAILABLE_VALUES = new Set(['MISSING', 'UNAVAILABLE', 'ERROR', 'FAILED', 'NONE', 'NULL']);
const LOADING_VALUES = new Set(['LOADING', 'PENDING']);
const INTERNAL_VALUES = new Set(['INTERNAL', 'LOCAL']);
const FALLBACK_VALUES = new Set(['FALLBACK', 'LAST_GOOD', 'LAST_VALID']);
const SNAPSHOT_VALUES = new Set(['REST', 'REST_SNAPSHOT', 'SNAPSHOT', 'REST_HISTORY', 'HISTORY']);
const UNKNOWN_VALUES = new Set(['', 'UNKNOWN']);

export function normalizeSpotMarketStatusValue(value?: string | null): string {
  return String(value || '').trim().toUpperCase();
}

export function resolveSpotMarketStatus(input: SpotMarketStatusInput): SpotMarketStatus {
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

  return {
    kind,
    label: STATUS_LABELS[kind],
    isAvailable: kind !== 'unavailable' && kind !== 'loading',
    isFresh: kind === 'live' || kind === 'snapshot' || kind === 'internal',
  };
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

export function formatSpotStatusBadgeText(input: SpotMarketStatusInput): string {
  return resolveSpotMarketStatus(input).label;
}

export function resolveSpotKlineStatus(input: SpotKlineStatusInput): SpotMarketStatus {
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
    return resolveSpotMarketStatus(input);
  }

  if (hasRecentRealtime) {
    return {
      kind: 'live',
      label: STATUS_LABELS.live,
      isAvailable: true,
      isFresh: true,
    };
  }

  if (input.loadState === 'loaded') {
    return {
      kind: 'snapshot',
      label: STATUS_LABELS.snapshot,
      isAvailable: true,
      isFresh: true,
    };
  }

  if (input.loadState === 'loading' || input.isLoading) {
    return {
      kind: 'loading',
      label: STATUS_LABELS.loading,
      isAvailable: false,
      isFresh: false,
    };
  }

  if (input.loadState === 'empty' || input.loadState === 'error') {
    return {
      kind: 'unavailable',
      label: STATUS_LABELS.unavailable,
      isAvailable: false,
      isFresh: false,
    };
  }

  if (UNKNOWN_VALUES.has(source) && UNKNOWN_VALUES.has(freshness)) {
    return {
      kind: 'unavailable',
      label: STATUS_LABELS.unavailable,
      isAvailable: false,
      isFresh: false,
    };
  }

  return resolveSpotMarketStatus(input);
}

export function getSpotBboBasisLabel(side: 'buy' | 'sell'): string {
  return side === 'buy' ? '价格依据：盘口卖一' : '价格依据：盘口买一';
}

export function getSpotBboAvailabilityLabel(status: SpotMarketStatus, hasBboPrice: boolean): string {
  return status.isFresh && hasBboPrice ? '可用' : '暂不可用';
}
