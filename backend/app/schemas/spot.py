from typing import List, Optional
from pydantic import BaseModel


class SpotBalanceItem(BaseModel):
    coin_symbol: str
    available_amount: str
    frozen_amount: str


class SpotBalancesResponse(BaseModel):
    symbol: str
    base_asset: str
    quote_asset: str
    items: List[SpotBalanceItem]


class SpotOrderItem(BaseModel):
    id: int
    symbol: str
    side: str
    order_type: str
    price: str
    amount: str
    filled_amount: str
    remaining_amount: str
    executed_quote_amount: str
    avg_price: str
    fee_amount: str
    fee_asset_id: Optional[int] = None
    fee_asset_symbol: Optional[str] = None
    status: str
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


class SpotOrdersResponse(BaseModel):
    symbol: str
    total: int
    items: List[SpotOrderItem]


class SpotTradeItem(BaseModel):
    trade_id: int
    symbol: str
    side: str
    price: str
    amount: str
    quote_amount: str
    buyer_user_id: Optional[int] = None
    seller_user_id: Optional[int] = None
    buy_order_id: Optional[int] = None
    sell_order_id: Optional[int] = None
    maker_order_id: Optional[int] = None
    taker_order_id: Optional[int] = None
    role: str
    fee_amount: Optional[str] = None
    fee_asset: Optional[str] = None
    fee_asset_symbol: Optional[str] = None
    created_at: Optional[str] = None


class SpotTradesResponse(BaseModel):
    symbol: str
    total: int
    items: List[SpotTradeItem]
