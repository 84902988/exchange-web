from __future__ import annotations

from enum import Enum
from typing import Any, Dict, Generic, List, Literal, Optional, TypeVar, Union

from pydantic import BaseModel, Field


CONTRACT_MARKET_DOMAIN_SNAPSHOT_SCHEMA_VERSION = "contract-market-domain-snapshot/v1"


class ContractMarketDomainName(str, Enum):
    TICKER = "ticker"
    DEPTH = "depth"
    TRADES = "trades"
    KLINE = "kline"


class ContractMarketDomainTransport(str, Enum):
    PROVIDER_WS = "PROVIDER_WS"
    PROVIDER_REST = "PROVIDER_REST"
    INTERNAL_EVENT = "INTERNAL_EVENT"
    DB_READ = "DB_READ"
    CACHE_READ = "CACHE_READ"
    NONE = "NONE"


class ContractMarketDomainCacheOrigin(str, Enum):
    NONE = "NONE"
    PROVIDER_MEMORY = "PROVIDER_MEMORY"
    L1_MEMORY = "L1_MEMORY"
    REDIS = "REDIS"
    DATABASE = "DATABASE"
    PROCESS_MEMORY = "PROCESS_MEMORY"
    LAST_GOOD_MEMORY = "LAST_GOOD_MEMORY"
    HISTORY_BOUNDARY = "HISTORY_BOUNDARY"


class ContractMarketDomainSource(str, Enum):
    LIVE_WS = "LIVE_WS"
    REST_SNAPSHOT = "REST_SNAPSHOT"
    REST_HISTORY = "REST_HISTORY"
    DB_CACHE = "DB_CACHE"
    INTERNAL = "INTERNAL"
    LAST_GOOD = "LAST_GOOD"
    MISSING = "MISSING"


class ContractMarketDomainFreshness(str, Enum):
    LIVE = "LIVE"
    RECENT = "RECENT"
    STALE = "STALE"
    LAST_GOOD = "LAST_GOOD"
    MISSING = "MISSING"


class ContractMarketDomainFallbackReason(str, Enum):
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
    UNSUPPORTED_INTERVAL = "UNSUPPORTED_INTERVAL"
    UNKNOWN = "UNKNOWN"


class ContractMarketDomainCompletenessStatus(str, Enum):
    COMPLETE = "COMPLETE"
    PARTIAL = "PARTIAL"
    EMPTY = "EMPTY"
    INVALID = "INVALID"


class ContractMarketDomainFreshnessBasis(str, Enum):
    RECEIVED_AT = "RECEIVED_AT"
    CACHE_UPDATED_AT = "CACHE_UPDATED_AT"
    DB_UPDATED_AT = "DB_UPDATED_AT"
    NOT_APPLICABLE = "NOT_APPLICABLE"


class ContractMarketDomainCompleteness(BaseModel):
    status: ContractMarketDomainCompletenessStatus
    has_data: bool
    item_count: int = Field(default=0, ge=0)
    missing_fields: List[str] = Field(default_factory=list)
    details: Dict[str, Any] = Field(default_factory=dict)


class ContractMarketDomainRevision(BaseModel):
    epoch: Optional[int] = Field(default=None, ge=0)
    sequence: Optional[int] = Field(default=None, ge=0)
    is_closed: Optional[bool] = None
    close_state_source: Optional[str] = None
    checksum: Optional[str] = None


class ContractMarketDomainSnapshotMetadata(BaseModel):
    domain: ContractMarketDomainName
    symbol: str
    interval: Optional[str] = None

    source: ContractMarketDomainSource
    provider: Optional[str] = None
    provider_symbol: Optional[str] = None
    transport: ContractMarketDomainTransport
    cache_origin: ContractMarketDomainCacheOrigin
    freshness: ContractMarketDomainFreshness
    fallback_reason: Optional[ContractMarketDomainFallbackReason] = None

    provider_event_time_ms: Optional[int] = Field(default=None, ge=0)
    received_at_ms: Optional[int] = Field(default=None, ge=0)
    cache_updated_at_ms: Optional[int] = Field(default=None, ge=0)
    db_updated_at_ms: Optional[int] = Field(default=None, ge=0)
    age_ms: Optional[int] = Field(default=None, ge=0)
    ttl_ms: Optional[int] = Field(default=None, ge=0)
    stale: bool
    freshness_basis: ContractMarketDomainFreshnessBasis

    provider_generation: Optional[int] = Field(default=None, ge=0)
    revision: Optional[ContractMarketDomainRevision] = None
    completeness: ContractMarketDomainCompleteness


class ContractMarketKlineTerminalMetadata(BaseModel):
    history_terminal: Optional[bool] = None
    history_incomplete: Optional[bool] = None
    terminal_reason: Optional[str] = None
    earliest_available_time: Optional[int] = Field(default=None, ge=0)
    coverage_complete: Optional[bool] = None
    continuity_valid: Optional[bool] = None

    # Existing Contract history responses currently expose these names. They
    # remain observable during migration, but do not replace terminal evidence.
    history_complete: Optional[bool] = None
    has_more_before: Optional[bool] = None
    retryable: Optional[bool] = None
    evidence_complete: bool = False


class ContractMarketKlineDomainSnapshotMetadata(ContractMarketDomainSnapshotMetadata):
    terminal: ContractMarketKlineTerminalMetadata = Field(
        default_factory=ContractMarketKlineTerminalMetadata
    )


ContractMarketDomainDataT = TypeVar("ContractMarketDomainDataT")


class ContractMarketDomainSnapshot(BaseModel, Generic[ContractMarketDomainDataT]):
    schema_version: Literal[
        CONTRACT_MARKET_DOMAIN_SNAPSHOT_SCHEMA_VERSION
    ] = CONTRACT_MARKET_DOMAIN_SNAPSHOT_SCHEMA_VERSION
    snapshot_id: str = Field(min_length=1)
    emitted_at_ms: int = Field(ge=0)
    data: Optional[ContractMarketDomainDataT] = None
    metadata: ContractMarketDomainSnapshotMetadata


ContractMarketMappingData = Dict[str, Any]
ContractMarketSequenceData = List[Dict[str, Any]]
ContractMarketTradesData = Union[ContractMarketMappingData, ContractMarketSequenceData]
ContractMarketKlineData = Union[ContractMarketMappingData, ContractMarketSequenceData]


class ContractTickerDomainSnapshot(
    ContractMarketDomainSnapshot[ContractMarketMappingData]
):
    pass


class ContractDepthDomainSnapshot(
    ContractMarketDomainSnapshot[ContractMarketMappingData]
):
    pass


class ContractTradesDomainSnapshot(
    ContractMarketDomainSnapshot[ContractMarketTradesData]
):
    pass


class ContractKlineDomainSnapshot(
    ContractMarketDomainSnapshot[ContractMarketKlineData]
):
    metadata: ContractMarketKlineDomainSnapshotMetadata


__all__ = [
    "CONTRACT_MARKET_DOMAIN_SNAPSHOT_SCHEMA_VERSION",
    "ContractDepthDomainSnapshot",
    "ContractKlineDomainSnapshot",
    "ContractMarketDomainCacheOrigin",
    "ContractMarketDomainCompleteness",
    "ContractMarketDomainCompletenessStatus",
    "ContractMarketDomainFallbackReason",
    "ContractMarketDomainFreshness",
    "ContractMarketDomainFreshnessBasis",
    "ContractMarketDomainName",
    "ContractMarketDomainRevision",
    "ContractMarketDomainSnapshot",
    "ContractMarketDomainSnapshotMetadata",
    "ContractMarketDomainSource",
    "ContractMarketDomainTransport",
    "ContractMarketKlineDomainSnapshotMetadata",
    "ContractMarketKlineTerminalMetadata",
    "ContractTickerDomainSnapshot",
    "ContractTradesDomainSnapshot",
]
