from __future__ import annotations

from datetime import datetime
from typing import List, Optional

from pydantic import BaseModel


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
