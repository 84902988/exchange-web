from pydantic import BaseModel
from typing import List, Literal, Optional


class DepthItem(BaseModel):
    price: str
    amount: str


class DepthResponse(BaseModel):
    symbol: str
    price_precision: int = 8
    amount_precision: int = 8
    bids: List[DepthItem]
    asks: List[DepthItem]
    ts: int
    provider: Optional[str] = None
    stale: bool = False
    updated_at: Optional[str] = None
    last_price: Optional[str] = None
    mid_price: Optional[str] = None
    ref_price: Optional[str] = None
    dealer_mid: Optional[str] = None
    spread_bps: Optional[str] = None
    offset_bps: Optional[str] = None
    source: Optional[str] = None
    fetched_at: Optional[int] = None


class TradeItem(BaseModel):
    price: str
    amount: str
    side: str
    ts: int


class TradesResponse(BaseModel):
    symbol: str
    trades: List[TradeItem]
    provider: Optional[str] = None
    stale: bool = False
    updated_at: Optional[str] = None




# =========================
# K线
# =========================

KlineInterval = Literal["1m", "5m", "15m", "1h", "4h", "1d"]


class KlineItem(BaseModel):
    open_time: int
    close_time: int
    open: str
    high: str
    low: str
    close: str
    volume: str
    quote_volume: str


class KlineResponse(BaseModel):
    symbol: str
    interval: KlineInterval
    items: List[KlineItem]
    provider: Optional[str] = None
    stale: bool = False
    updated_at: Optional[str] = None


class TickerItem(BaseModel):
    symbol: str
    last_price: str
    open_24h: str = "0"
    price_change_24h: str = "0"
    price_change_percent: str
    volume_24h: str
    base_volume_24h: str = "0"
    high_24h: str = "0"
    low_24h: str = "0"
    quote_volume_24h: str = "0"
    price_precision: int = 8
    amount_precision: int = 8
    source: Literal["internal", "binance", "itick", "external"]
    provider: Optional[str] = None
    stale: bool = False
    updated_at: Optional[str] = None
    market_status: str = "UNKNOWN"
    market_status_text: str = ""
    market_session_code: Optional[str] = None
    market_timezone: Optional[str] = None
    market_trading_hours: Optional[str] = None
    market_session_type: Optional[str] = None
    quote_freshness: str = "FALLBACK"
    ts: Optional[str] = None
    display_symbol: Optional[str] = None
    base_asset: Optional[str] = None
    quote_asset: Optional[str] = None
    asset_type: Optional[str] = None
    data_source: Optional[str] = None
    market_mode: Optional[str] = None
    external_symbol: Optional[str] = None
    external_region: Optional[str] = None
    market_category: Optional[str] = None
    market_sub_category: Optional[str] = None
    display_category: Optional[str] = None
    display_group: Optional[str] = None
    sort_order: int = 0
    is_hot: bool = False
    show_spot_logo: bool = False
    spot_logo_url: Optional[str] = None
    spot_logo_alt: Optional[str] = None


class TickerListResponse(BaseModel):
    items: List[TickerItem]
