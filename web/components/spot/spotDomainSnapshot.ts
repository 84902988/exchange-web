export const SPOT_DOMAIN_SNAPSHOT_SCHEMA_VERSION = 'spot-domain-snapshot/v1' as const;

export type DomainName = 'ticker' | 'depth' | 'trades' | 'kline';

export type DomainTransport =
  | 'PROVIDER_WS'
  | 'PROVIDER_REST'
  | 'INTERNAL_EVENT'
  | 'DB_READ'
  | 'CACHE_READ'
  | 'NONE';

export type DomainCacheOrigin =
  | 'NONE'
  | 'PROVIDER_MEMORY'
  | 'L1_MEMORY'
  | 'REDIS'
  | 'DATABASE'
  | 'LAST_GOOD_MEMORY'
  | 'HISTORY_BOUNDARY';

export type DomainSource =
  | 'LIVE_WS'
  | 'REST_SNAPSHOT'
  | 'REST_HISTORY'
  | 'DB_CACHE'
  | 'INTERNAL'
  | 'LAST_GOOD'
  | 'MISSING';

export type DomainFreshness =
  | 'LIVE'
  | 'RECENT'
  | 'STALE'
  | 'LAST_GOOD'
  | 'MISSING';

export type DomainFallbackReason =
  | 'WS_MISS'
  | 'WS_STALE'
  | 'PROVIDER_COOLDOWN'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_EMPTY'
  | 'PROVIDER_ERROR'
  | 'CACHE_MISS'
  | 'CACHE_STALE'
  | 'REDIS_DOWN'
  | 'HISTORY_BOUNDARY'
  | 'BUDGET_EXHAUSTED'
  | 'INVALID_DATA'
  | 'UNKNOWN';

export type DomainCompletenessStatus =
  | 'COMPLETE'
  | 'PARTIAL'
  | 'EMPTY'
  | 'INVALID';

export type DomainFreshnessBasis =
  | 'RECEIVED_AT'
  | 'CACHE_UPDATED_AT'
  | 'DB_UPDATED_AT'
  | 'NOT_APPLICABLE';

export interface DomainCompleteness {
  status: DomainCompletenessStatus;
  has_data: boolean;
  item_count: number;
  missing_fields: string[];
  details: Record<string, unknown>;
}

export interface DomainRevision {
  epoch: number | null;
  sequence: number | null;
  is_closed: boolean | null;
  close_state_source: string | null;
}

export interface DomainSnapshotMetadata {
  domain: DomainName;
  symbol: string;
  interval: string | null;

  provider: string | null;
  provider_symbol: string | null;

  transport: DomainTransport;
  cache_origin: DomainCacheOrigin;
  source: DomainSource;
  freshness: DomainFreshness;
  fallback_reason: DomainFallbackReason | null;

  provider_event_time_ms: number | null;
  received_at_ms: number | null;
  cache_updated_at_ms: number | null;

  age_ms: number | null;
  ttl_ms: number | null;
  stale: boolean;

  provider_generation: number | null;
  revision: DomainRevision | null;
  completeness: DomainCompleteness;
  freshness_basis: DomainFreshnessBasis;
}

export interface DomainSnapshot<TData> {
  schema_version: typeof SPOT_DOMAIN_SNAPSHOT_SCHEMA_VERSION;
  snapshot_id: string;
  emitted_at_ms: number;
  data: TData | null;
  metadata: DomainSnapshotMetadata;
}

export type TickerDomainSnapshot<TData = Record<string, unknown>> = DomainSnapshot<TData>;
export type DepthDomainSnapshot<TData = Record<string, unknown>> = DomainSnapshot<TData>;
export type TradesDomainSnapshot<TData = Record<string, unknown>> = DomainSnapshot<TData>;
export type KlineDomainSnapshot<TData = Record<string, unknown>> = DomainSnapshot<TData>;
