from __future__ import annotations

import re
from decimal import Decimal
from typing import List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator


_CLIENT_ORDER_ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9._:-]{0,63}$")


def _normalize_client_order_id(value: object) -> Optional[str]:
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError("client_order_id must be a string")
    normalized = value.strip().lower()
    if not normalized:
        raise ValueError("client_order_id must not be empty")
    if len(normalized) > 64:
        raise ValueError("client_order_id must not exceed 64 characters")
    if _CLIENT_ORDER_ID_PATTERN.fullmatch(normalized) is None:
        raise ValueError("client_order_id contains unsupported characters")
    return normalized


class ContractOpenOrderRequest(BaseModel):
    model_config = ConfigDict(
        json_schema_extra={
            "example": {
                "symbol": "BTCUSDT_PERP",
                "position_side": "LONG",
                "order_type": "MARKET",
                "price": None,
                "quantity": "0.001",
                "leverage": 10,
            }
        }
    )

    symbol: str = Field(..., description="Contract symbol, e.g. BTCUSDT_PERP")
    position_side: Literal["LONG", "SHORT"]
    order_type: Literal["MARKET", "LIMIT"]
    price: Optional[Decimal] = None
    quantity: Decimal
    leverage: int
    take_profit_price: Optional[Decimal] = None
    stop_loss_price: Optional[Decimal] = None
    client_order_id: Optional[str] = None

    @field_validator("client_order_id", mode="before")
    @classmethod
    def normalize_client_order_id(cls, value: object) -> Optional[str]:
        return _normalize_client_order_id(value)


class ContractCloseOrderRequest(BaseModel):
    model_config = ConfigDict(
        json_schema_extra={
            "example": {
                "position_id": 1,
                "order_type": "MARKET",
                "price": None,
                "quantity": None,
            }
        }
    )

    position_id: int
    order_type: Literal["MARKET", "LIMIT"]
    price: Optional[Decimal] = None
    quantity: Optional[Decimal] = None


class ContractCloseSummaryOrderRequest(BaseModel):
    model_config = ConfigDict(
        json_schema_extra={
            "example": {
                "symbol": "BTCUSDT_PERP",
                "side": "LONG",
                "order_type": "MARKET",
                "price": None,
                "quantity": "0.003",
            }
        }
    )

    symbol: str = Field(..., description="Contract symbol, e.g. BTCUSDT_PERP")
    side: Literal["LONG", "SHORT"] = Field(..., description="Position side to close")
    order_type: Literal["MARKET", "LIMIT"]
    price: Optional[Decimal] = None
    quantity: Optional[Decimal] = None
    client_order_id: Optional[str] = None

    @field_validator("client_order_id", mode="before")
    @classmethod
    def normalize_client_order_id(cls, value: object) -> Optional[str]:
        return _normalize_client_order_id(value)


class ContractPositionTpSlUpdateRequest(BaseModel):
    take_profit_price: Optional[Decimal] = None
    stop_loss_price: Optional[Decimal] = None


class ContractPositionTpSlUpdateResponse(BaseModel):
    position_id: int
    symbol: str
    side: str
    mark_price: str
    take_profit_price: Optional[str] = None
    stop_loss_price: Optional[str] = None


class ContractOrderResponse(BaseModel):
    order_id: int
    order_no: str
    symbol: str
    position_side: str
    order_type: str
    price: Optional[str] = None
    quantity: str
    leverage: int
    margin_amount: str
    fee_amount: str
    spread_fee: str
    status: str
    avg_price: str
    position_id: Optional[int] = None
    realized_pnl: Optional[str] = None
    released_margin: Optional[str] = None
    remaining_position_quantity: Optional[str] = None
    take_profit_price: Optional[str] = None
    stop_loss_price: Optional[str] = None
    client_order_id: Optional[str] = None


class ContractCloseSummaryOrderResponse(BaseModel):
    symbol: str
    side: str
    order_type: str
    price: Optional[str] = None
    requested_quantity: str
    closed_quantity: str
    submitted_quantity: str
    generated_order_ids: List[int]
    generated_trade_ids: List[int]
    affected_position_ids: List[int]
    status: str
    client_order_id: Optional[str] = None


class ContractOrderListItem(BaseModel):
    id: int
    order_no: str
    symbol: str
    position_id: Optional[int] = None
    side: Optional[str] = None
    position_side: str
    action: str
    order_type: str
    price: Optional[str] = None
    quantity: str
    leverage: int
    margin_amount: str
    fee_amount: str
    spread_fee: str
    filled_quantity: str
    avg_price: str
    status: str
    fail_reason: Optional[str] = None
    take_profit_price: Optional[str] = None
    stop_loss_price: Optional[str] = None
    created_at: Optional[str] = None


class ContractOrderListResponse(BaseModel):
    items: List[ContractOrderListItem]
    total: int
    page: int
    page_size: int


class ContractTradeListItem(BaseModel):
    id: int
    trade_no: str
    order_id: int
    position_id: Optional[int] = None
    symbol: str
    position_side: str
    action: str
    price: str
    quantity: str
    notional: str
    leverage: int
    margin_amount: str
    fee_amount: str
    spread_fee: str
    realized_pnl: str
    close_reason: Optional[str] = None
    created_at: Optional[str] = None


class ContractTradeListResponse(BaseModel):
    items: List[ContractTradeListItem]
    total: int
    page: int
    page_size: int
