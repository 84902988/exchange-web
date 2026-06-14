from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field, root_validator, validator


class CreateOrderRequest(BaseModel):
    symbol: str = Field(..., min_length=2, max_length=50, description="Trading pair symbol, for example BTCUSDT")
    side: str = Field(..., description="Order side: BUY / SELL")
    order_type: str = Field(..., description="Order type: LIMIT / MARKET")

    price: Optional[Decimal] = Field(
        default=None,
        description="Limit price. Required for LIMIT orders and omitted for MARKET orders.",
    )
    amount: Optional[Decimal] = Field(
        default=None,
        description="Order amount. Required for LIMIT orders and MARKET SELL orders.",
    )
    quote_amount: Optional[Decimal] = Field(
        default=None,
        description="Quote amount. Required for MARKET BUY orders.",
    )

    @validator("symbol")
    def validate_symbol(cls, v: str) -> str:
        v = v.strip().upper()
        if not v:
            raise ValueError("symbol cannot be empty")
        return v

    @validator("side")
    def validate_side(cls, v: str) -> str:
        v = v.strip().upper()
        if v not in {"BUY", "SELL"}:
            raise ValueError("side only supports BUY or SELL")
        return v

    @validator("order_type")
    def validate_order_type(cls, v: str) -> str:
        v = v.strip().upper()
        if v not in {"LIMIT", "MARKET"}:
            raise ValueError("order_type only supports LIMIT or MARKET")
        return v

    @validator("price")
    def validate_price_positive(cls, v: Optional[Decimal]) -> Optional[Decimal]:
        if v is not None and v <= 0:
            raise ValueError("price must be greater than 0")
        return v

    @validator("amount")
    def validate_amount_positive(cls, v: Optional[Decimal]) -> Optional[Decimal]:
        if v is not None and v <= 0:
            raise ValueError("amount must be greater than 0")
        return v

    @validator("quote_amount")
    def validate_quote_amount_positive(cls, v: Optional[Decimal]) -> Optional[Decimal]:
        if v is not None and v <= 0:
            raise ValueError("quote_amount must be greater than 0")
        return v

    @root_validator(skip_on_failure=True)
    def validate_by_order_type(cls, values):
        order_type = (values.get("order_type") or "").upper()
        side = (values.get("side") or "").upper()
        price = values.get("price")
        amount = values.get("amount")
        quote_amount = values.get("quote_amount")

        if order_type == "LIMIT":
            if price is None:
                raise ValueError("LIMIT order requires price")
            if amount is None:
                raise ValueError("LIMIT order requires amount")

        if order_type == "MARKET" and side == "BUY":
            if quote_amount is None:
                raise ValueError("MARKET BUY requires quote_amount")

        if order_type == "MARKET" and side == "SELL":
            if amount is None:
                raise ValueError("MARKET SELL requires amount")

        return values


class CreateOrderResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    order_no: str
    symbol: str
    side: str
    order_type: str

    price: Optional[Decimal]
    amount: Decimal
    filled_amount: Decimal
    frozen_amount: Decimal

    status: str
    created_at: datetime


class CancelOrderResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    order_no: str
    status: str


class OrderListItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    order_no: str
    trading_pair_id: int

    side: str
    order_type: str

    price: Optional[Decimal]
    amount: Decimal
    filled_amount: Decimal
    avg_price: Decimal

    frozen_amount: Decimal
    executed_quote_amount: Decimal
    fee_amount: Decimal

    status: str
    source: str
    created_at: datetime
    updated_at: datetime
