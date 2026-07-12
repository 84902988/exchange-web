from __future__ import annotations

from enum import Enum
from typing import Any, Dict, Generic, List, Literal, Optional, TypeVar

from pydantic import BaseModel, Field


DOMAIN_SNAPSHOT_SCHEMA_VERSION = "spot-domain-snapshot/v1"


class DomainName(str, Enum):
    TICKER = "ticker"
    DEPTH = "depth"
    TRADES = "trades"
    KLINE = "kline"


class DomainTransport(str, Enum):
    PROVIDER_WS = "PROVIDER_WS"
    PROVIDER_REST = "PROVIDER_REST"
    INTERNAL_EVENT = "INTERNAL_EVENT"
    DB_READ = "DB_READ"
    CACHE_READ = "CACHE_READ"
    NONE = "NONE"


class DomainCacheOrigin(str, Enum):
    NONE = "NONE"
    PROVIDER_MEMORY = "PROVIDER_MEMORY"
    L1_MEMORY = "L1_MEMORY"
    REDIS = "REDIS"
    DATABASE = "DATABASE"
    LAST_GOOD_MEMORY = "LAST_GOOD_MEMORY"
    HISTORY_BOUNDARY = "HISTORY_BOUNDARY"


class DomainSource(str, Enum):
    LIVE_WS = "LIVE_WS"
    REST_SNAPSHOT = "REST_SNAPSHOT"
    REST_HISTORY = "REST_HISTORY"
    DB_CACHE = "DB_CACHE"
    INTERNAL = "INTERNAL"
    LAST_GOOD = "LAST_GOOD"
    MISSING = "MISSING"


class DomainFreshness(str, Enum):
    LIVE = "LIVE"
    RECENT = "RECENT"
    STALE = "STALE"
    LAST_GOOD = "LAST_GOOD"
    MISSING = "MISSING"


class DomainFallbackReason(str, Enum):
    WS_MISS = "WS_MISS"
    WS_STALE = "WS_STALE"
    PROVIDER_COOLDOWN = "PROVIDER_COOLDOWN"
    PROVIDER_TIMEOUT = "PROVIDER_TIMEOUT"
    PROVIDER_EMPTY = "PROVIDER_EMPTY"
    PROVIDER_ERROR = "PROVIDER_ERROR"
    CACHE_MISS = "CACHE_MISS"
    CACHE_STALE = "CACHE_STALE"
    REDIS_DOWN = "REDIS_DOWN"
    HISTORY_BOUNDARY = "HISTORY_BOUNDARY"
    BUDGET_EXHAUSTED = "BUDGET_EXHAUSTED"
    INVALID_DATA = "INVALID_DATA"
    UNKNOWN = "UNKNOWN"


class DomainCompletenessStatus(str, Enum):
    COMPLETE = "COMPLETE"
    PARTIAL = "PARTIAL"
    EMPTY = "EMPTY"
    INVALID = "INVALID"


class DomainFreshnessBasis(str, Enum):
    RECEIVED_AT = "RECEIVED_AT"
    CACHE_UPDATED_AT = "CACHE_UPDATED_AT"
    DB_UPDATED_AT = "DB_UPDATED_AT"
    NOT_APPLICABLE = "NOT_APPLICABLE"


class DomainCompleteness(BaseModel):
    status: DomainCompletenessStatus
    has_data: bool
    item_count: int = Field(default=0, ge=0)
    missing_fields: List[str] = Field(default_factory=list)
    details: Dict[str, Any] = Field(default_factory=dict)


class DomainRevision(BaseModel):
    epoch: Optional[int] = Field(default=None, ge=0)
    sequence: Optional[int] = Field(default=None, ge=0)
    is_closed: Optional[bool] = None
    close_state_source: Optional[str] = None


class DomainSnapshotMetadata(BaseModel):
    domain: DomainName
    symbol: str
    interval: Optional[str] = None

    provider: Optional[str] = None
    provider_symbol: Optional[str] = None

    transport: DomainTransport
    cache_origin: DomainCacheOrigin
    source: DomainSource
    freshness: DomainFreshness
    fallback_reason: Optional[DomainFallbackReason] = None

    provider_event_time_ms: Optional[int] = Field(default=None, ge=0)
    received_at_ms: Optional[int] = Field(default=None, ge=0)
    cache_updated_at_ms: Optional[int] = Field(default=None, ge=0)

    age_ms: Optional[int] = Field(default=None, ge=0)
    ttl_ms: Optional[int] = Field(default=None, ge=0)
    stale: bool

    provider_generation: Optional[int] = Field(default=None, ge=0)
    revision: Optional[DomainRevision] = None
    completeness: DomainCompleteness
    freshness_basis: DomainFreshnessBasis


DomainDataT = TypeVar("DomainDataT")


class DomainSnapshot(BaseModel, Generic[DomainDataT]):
    schema_version: Literal[DOMAIN_SNAPSHOT_SCHEMA_VERSION] = DOMAIN_SNAPSHOT_SCHEMA_VERSION
    snapshot_id: str
    emitted_at_ms: int = Field(ge=0)
    data: Optional[DomainDataT] = None
    metadata: DomainSnapshotMetadata


TickerDomainSnapshot = DomainSnapshot[Dict[str, Any]]
DepthDomainSnapshot = DomainSnapshot[Dict[str, Any]]
TradesDomainSnapshot = DomainSnapshot[Dict[str, Any]]
KlineDomainSnapshot = DomainSnapshot[Dict[str, Any]]
