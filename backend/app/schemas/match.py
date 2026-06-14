from __future__ import annotations

from decimal import Decimal
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field


class MatchRunResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    matched: bool = Field(..., description="是否成功撮合")

    trade_id: Optional[int] = Field(
        None, description="成交记录ID（成功撮合时返回）"
    )

    buy_order_id: Optional[int] = Field(
        None, description="买单ID"
    )

    sell_order_id: Optional[int] = Field(
        None, description="卖单ID"
    )

    price: Optional[Decimal] = Field(
        None, description="成交价格"
    )

    amount: Optional[Decimal] = Field(
        None, description="成交数量"
    )

    quote_amount: Optional[Decimal] = Field(
        None, description="成交金额（price × amount）"
    )

    message: str = Field(
        ..., description="结果说明，例如 success / 无订单 / 未交叉"
    )