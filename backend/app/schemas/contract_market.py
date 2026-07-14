from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class ContractQuoteResponse(BaseModel):
    symbol: str
    provider: str
    provider_symbol: str
    price_precision: int = 8
    market_status: str = "UNKNOWN"
    market_status_text: str = ""
    market_session_code: Optional[str] = None
    market_timezone: Optional[str] = None
    market_trading_hours: Optional[str] = None
    market_session_type: Optional[str] = None
    quote_freshness: str = "FALLBACK"
    quote_source: str = "UNKNOWN"
    closed_market_execution_mode: str = "DISABLED"
    executable: bool = False
    is_realtime: bool = False
    last_good_at: Optional[datetime] = None
    stale: bool = True
    spread_x: str = "0"
    manual_spread_x: str = "0"
    effective_total_spread: str = "0"
    single_side_spread_fee_price: str = "0"
    bid: str
    ask: str
    bid_price: str
    ask_price: str
    best_bid: str
    best_ask: str
    raw_bid_price: Optional[str] = None
    raw_ask_price: Optional[str] = None
    last_price: str
    mark_price: str
    index_price: Optional[str] = None
    funding_rate: Optional[str] = None
    next_funding_time: Optional[int] = None
    source: str
    ts: datetime


class ContractDepthResponse(BaseModel):
    symbol: str
    provider: str
    provider_symbol: str
    price_precision: int = 8
    market_status: str = "UNKNOWN"
    market_status_text: str = ""
    market_session_code: Optional[str] = None
    market_timezone: Optional[str] = None
    market_trading_hours: Optional[str] = None
    market_session_type: Optional[str] = None
    quote_freshness: str = "FALLBACK"
    quote_source: str = "UNKNOWN"
    depth_mode: str = "FULL_DEPTH"
    closed_market_execution_mode: str = "DISABLED"
    executable: bool = False
    is_realtime: bool = False
    last_good_at: Optional[datetime] = None
    spread_x: str = "0"
    manual_spread_x: str = "0"
    effective_total_spread: str = "0"
    single_side_spread_fee_price: str = "0"
    bids: List[List[str]]
    asks: List[List[str]]
    raw_bids: Optional[List[List[str]]] = None
    raw_asks: Optional[List[List[str]]] = None
    bid: Optional[str] = None
    ask: Optional[str] = None
    best_bid: Optional[str] = None
    best_ask: Optional[str] = None
    raw_best_bid: Optional[str] = None
    raw_best_ask: Optional[str] = None
    source: str
    ts: datetime


class ContractSymbolItem(BaseModel):
    symbol: str
    display_name: str
    category: str
    provider: str
    provider_symbol: str
    quote_asset: str
    tp_sl_trigger_price_type: str = "MARK_PRICE"
    closed_market_execution_mode: str = "DISABLED"
    price_precision: int = 8
    quantity_precision: int = 8
    max_leverage: int = 1
    status: int = 1
    market_status: str = "UNKNOWN"
    market_status_text: str = ""
    market_session_code: Optional[str] = None
    market_timezone: Optional[str] = None
    market_trading_hours: Optional[str] = None
    market_session_type: Optional[str] = None


class ContractSymbolListResponse(BaseModel):
    items: List[ContractSymbolItem]
    total: int
    page: int
    page_size: int


class ContractTickerItem(BaseModel):
    symbol: str
    market_status: str = "UNKNOWN"
    market_status_text: str = ""
    market_session_code: Optional[str] = None
    market_timezone: Optional[str] = None
    market_trading_hours: Optional[str] = None
    market_session_type: Optional[str] = None
    quote_freshness: str = "FALLBACK"
    last_price: Optional[str] = None
    price_change_24h: Optional[str] = None
    price_change_percent_24h: Optional[str] = None
    high_24h: Optional[str] = None
    low_24h: Optional[str] = None
    base_volume_24h: Optional[str] = None
    quote_volume_24h: Optional[str] = None
    source: Optional[str] = None
    ts: Optional[datetime] = None


class ContractTickerListResponse(BaseModel):
    items: List[ContractTickerItem]


class ContractKlineCurrentCandle(BaseModel):
    time: int
    open_time: int
    open: str
    high: str
    low: str
    close: str
    volume: str
    interval: str
    kline_mode: str = "PROVIDER_KLINE"
    price_source: str = "KLINE_CLOSE"
    volume_source: str = "PROVIDER_KLINE"
    updated_at_ms: int


class ContractKlineHistoryMetadataResponse(BaseModel):
    """Opt-in metadata payload for Contract Kline history responses."""

    items: List[Dict[str, Any]] = Field(default_factory=list)
    cache_status: str
    freshness: str
    stale: bool
    history_incomplete: bool = False
    history_complete: Optional[bool] = None
    has_more_before: Optional[bool] = None
    history_terminal: Optional[bool] = None
    terminal_reason: Optional[str] = None
    earliest_available_time: Optional[int] = Field(default=None, ge=0)
    coverage_complete: Optional[bool] = None
    provider_error_code: Optional[str] = None
    retryable: bool = False


class ContractMarketViewDetail(BaseModel):
    symbol: str
    display_symbol: str
    view_version: str = "2"
    authority_source: str = "LEGACY_COMPAT"
    snapshot_authority: bool = False
    market_type: str = "CONTRACT"
    category: str = "INTERNAL"
    market_status: str = "UNKNOWN"
    display_state: str = "UNAVAILABLE"
    display_price: Optional[str] = None
    display_price_source: str = "NONE"
    current_price_source: str = "NONE"
    mark_price: Optional[str] = None
    mark_price_source: Optional[str] = None
    index_price: Optional[str] = None
    index_price_source: Optional[str] = None
    ticker_source: Optional[str] = None
    ticker_freshness: Optional[str] = None
    depth_source: Optional[str] = None
    depth_freshness: Optional[str] = None
    trades_source: Optional[str] = None
    trades_freshness: Optional[str] = None
    kline_source: Optional[str] = None
    kline_freshness: Optional[str] = None
    last_trade_price: Optional[str] = None
    last_trade_time: Optional[datetime] = None
    best_bid: Optional[str] = None
    best_ask: Optional[str] = None
    spread: Optional[str] = None
    executable: bool = False
    execution_bid: Optional[str] = None
    execution_ask: Optional[str] = None
    execution_mode: str = "DISABLED"
    last_good_bbo_valid: bool = False
    price_age_ms: Optional[int] = None
    quote_time: Optional[datetime] = None
    last_good_at: Optional[datetime] = None
    reason_code: str = "UNAVAILABLE"
    warnings: List[str] = Field(default_factory=list)
    kline_current_candle: Optional[ContractKlineCurrentCandle] = None
    ticker: Optional[Dict[str, Any]] = None
    depth: Optional[Dict[str, Any]] = None
    trades: List[Dict[str, Any]] = Field(default_factory=list)
    kline: Optional[Dict[str, Any]] = None
    snapshot_metadata: Dict[str, Any] = Field(default_factory=dict)
    raw_source_summary: Dict[str, Any] = Field(default_factory=dict)
