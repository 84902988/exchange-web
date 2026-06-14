from __future__ import annotations

from typing import List, Literal, Optional

from pydantic import BaseModel


class ContractPositionItem(BaseModel):
    id: int
    symbol: str
    side: str
    leverage: int
    quantity: str
    entry_price: str
    mark_price: str
    margin_amount: str
    open_fee: str
    unrealized_pnl: str
    realized_pnl: str
    liquidation_price: str
    warning_price: str
    take_profit_price: Optional[str] = None
    stop_loss_price: Optional[str] = None
    close_reason: Optional[str] = None
    opened_quantity: Optional[str] = None
    closed_quantity: Optional[str] = None
    opened_margin_amount: Optional[str] = None
    released_margin_amount: Optional[str] = None
    close_avg_price: Optional[str] = None
    status: str
    opened_at: Optional[str] = None
    closed_at: Optional[str] = None


class ContractPositionListResponse(BaseModel):
    items: List[ContractPositionItem]


class ContractPositionSummaryItem(BaseModel):
    symbol: str
    side: str
    quantity: str
    avg_entry_price: str
    margin_amount: str
    unrealized_pnl: str
    liquidation_price: str
    position_ids: List[int]
    count: int
    take_profit_price: Optional[str] = None
    stop_loss_price: Optional[str] = None
    tp_sl_mode: Literal["NONE", "SINGLE", "MIXED"]


class ContractPositionSummaryListResponse(BaseModel):
    items: List[ContractPositionSummaryItem]
