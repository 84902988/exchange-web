from typing import List, Literal, Optional

from pydantic import BaseModel


class ExternalTickerResponse(BaseModel):
    symbol: str
    price: str
    price_change: str = "0"
    price_change_percent: str
    volume: str
    quote_volume: str
    high_price: Optional[str] = None
    low_price: Optional[str] = None
    ts: int


class ExternalDepthItem(BaseModel):
    price: str
    amount: str


class ExternalDepthResponse(BaseModel):
    symbol: str
    price_precision: int = 8
    bids: List[ExternalDepthItem]
    asks: List[ExternalDepthItem]
    ts: int


ExternalKlineInterval = Literal["1m", "5m", "15m", "1h", "4h", "1d"]


class ExternalKlineItem(BaseModel):
    open_time: int
    close_time: int
    open: str
    high: str
    low: str
    close: str
    volume: str
    quote_volume: str


class ExternalKlineResponse(BaseModel):
    symbol: str
    interval: ExternalKlineInterval
    items: List[ExternalKlineItem]


class ExternalTradeItem(BaseModel):
    price: str
    amount: str
    ts: int
    side: str = "BUY"


class ExternalTradesResponse(BaseModel):
    symbol: str
    items: List[ExternalTradeItem]
