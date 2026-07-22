from __future__ import annotations

from typing import Optional

from pydantic import BaseModel

from app.schemas.response import ApiResponse


class VipLevelConditionOut(BaseModel):
    min_30d_volume: Optional[str] = None
    min_rcb_hold: Optional[str] = None
    min_lock_amount: Optional[str] = None
    lock_period_days: Optional[int] = None
    user_limit: Optional[int] = None
    dividend_rate: Optional[str] = None


class VipLevelOut(BaseModel):
    level_code: str
    level_name: str
    sort_order: int
    spot_maker_fee: str
    spot_taker_fee: str
    contract_maker_fee: Optional[str] = None
    contract_taker_fee: Optional[str] = None
    rcb_discount_rate: Optional[str] = None
    condition: VipLevelConditionOut


class VipUserSummaryOut(BaseModel):
    vip_level_code: Optional[str] = None
    svip_level_code: Optional[str] = None
    effective_level_code: Optional[str] = None
    effective_fee_source: Optional[str] = None
    effective_spot_maker_fee: Optional[str] = None
    effective_spot_taker_fee: Optional[str] = None
    volume_30d: Optional[str] = None
    rcb_available: Optional[str] = None
    rcb_funding_available: Optional[str] = None
    rcb_locked: Optional[str] = None
    rcb_lock_period_days: Optional[int] = None


class VipOverviewOut(BaseModel):
    vip_levels: list[VipLevelOut]
    svip_levels: list[VipLevelOut]
    user_summary: VipUserSummaryOut
    auth_state: str = "anonymous"
    rcb_fee_pay_percent: Optional[str] = None
    rcb_discount_percent: Optional[str] = None


class VipOverviewApiResponse(ApiResponse[VipOverviewOut]):
    pass


class VipFeePreferenceIn(BaseModel):
    use_rcb_fee: bool = False


class VipFeePreferenceOut(BaseModel):
    use_rcb_fee: bool = False


class VipFeePreferenceApiResponse(ApiResponse[VipFeePreferenceOut]):
    pass


class VipRcbLockIn(BaseModel):
    amount: str
    lock_period_days: int


class VipRcbLockOut(BaseModel):
    id: int
    asset_symbol: str
    lock_amount: str
    lock_period_days: int
    start_time: Optional[str] = None
    end_time: Optional[str] = None
    status: str
    current_svip: Optional[str] = None
    created_at: Optional[str] = None


class VipRcbLockSummaryOut(BaseModel):
    rcb_funding_available: Optional[str] = None
    rcb_locked: Optional[str] = None
    svip_level_code: Optional[str] = None
    effective_level_code: Optional[str] = None
    effective_fee_source: Optional[str] = None
    effective_spot_maker_fee: Optional[str] = None
    effective_spot_taker_fee: Optional[str] = None


class VipRcbLockCreateOut(BaseModel):
    lock: VipRcbLockOut
    summary: VipRcbLockSummaryOut


class VipRcbLocksOut(BaseModel):
    items: list[VipRcbLockOut]


class VipRcbLockCreateApiResponse(ApiResponse[VipRcbLockCreateOut]):
    pass


class VipRcbLocksApiResponse(ApiResponse[VipRcbLocksOut]):
    pass
