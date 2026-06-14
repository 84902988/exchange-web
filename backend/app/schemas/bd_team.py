from __future__ import annotations

from typing import Dict, Optional

from pydantic import BaseModel, Field

from app.schemas.response import ApiResponse


def _default_asset_totals() -> Dict[str, str]:
    return {"RCB": "0", "USDT": "0"}


class MyBdAccountOut(BaseModel):
    bd_user_id: int
    bd_level: str
    commission_rate: str
    invite_code: str
    status: str


class MyBdTeamSummaryOut(BaseModel):
    bound_user_count: int
    total_original_fee: str
    total_commission: str
    pending_commission: str
    paid_commission: str
    paid_rcb_amount: str
    total_original_fee_by_asset: Dict[str, str] = Field(default_factory=_default_asset_totals)
    total_commission_by_asset: Dict[str, str] = Field(default_factory=_default_asset_totals)
    pending_commission_by_asset: Dict[str, str] = Field(default_factory=_default_asset_totals)
    paid_commission_by_asset: Dict[str, str] = Field(default_factory=_default_asset_totals)
    total_totals_by_asset: Dict[str, str] = Field(default_factory=_default_asset_totals)
    pending_totals_by_asset: Dict[str, str] = Field(default_factory=_default_asset_totals)
    paid_totals_by_asset: Dict[str, str] = Field(default_factory=_default_asset_totals)
    paid_amounts_by_asset: Dict[str, str] = Field(default_factory=_default_asset_totals)
    settlement_asset_symbol: str = "MULTI"
    settlement_asset_symbols: list[str] = Field(default_factory=lambda: ["RCB", "USDT"])
    source_type: str = "NONE"
    source_label: str = "无"
    latest_commission_at: Optional[str] = None


class MyBdCommissionRecordOut(BaseModel):
    id: int
    source_user_id: int
    order_id: Optional[int] = None
    trade_id: Optional[int] = None
    fee_coin_symbol: str
    original_fee_amount: str
    commission_rate: str
    commission_amount: str
    commission_asset_symbol: str = "RCB"
    pool_amount: str
    status: str
    paid_at: Optional[str] = None
    created_at: Optional[str] = None


class MyBdTeamOverviewOut(BaseModel):
    is_bd: bool
    account: Optional[MyBdAccountOut] = None
    summary: MyBdTeamSummaryOut
    records: list[MyBdCommissionRecordOut]
    total: int
    page: int
    page_size: int
    pages: int


class MyBdTeamOverviewApiResponse(ApiResponse[MyBdTeamOverviewOut]):
    pass
