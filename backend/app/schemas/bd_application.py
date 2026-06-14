from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, Field, field_validator

from app.schemas.response import ApiResponse


class BdApplicationCreateIn(BaseModel):
    apply_level: str = Field(default="BD1", max_length=20)
    deposit_coin_symbol: str = Field(default="USDT", max_length=20)
    deposit_amount: str = Field(default="0")
    remark: Optional[str] = Field(default=None, max_length=255)

    @field_validator("apply_level", "deposit_coin_symbol")
    @classmethod
    def normalize_code(cls, value: str) -> str:
        normalized = str(value or "").strip().upper()
        if not normalized:
            raise ValueError("value is required")
        return normalized

    @field_validator("deposit_amount")
    @classmethod
    def validate_deposit_amount(cls, value: str) -> str:
        text = str(value or "0").strip()
        try:
            amount = float(text)
        except ValueError as exc:
            raise ValueError("deposit_amount must be numeric") from exc
        if amount < 0:
            raise ValueError("deposit_amount must be greater than or equal to 0")
        return text

    @field_validator("remark")
    @classmethod
    def normalize_remark(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        text = value.strip()
        return text or None


class BdApplicationOut(BaseModel):
    id: int
    user_id: int
    apply_level: str
    deposit_coin_symbol: str
    deposit_amount: str
    status: str
    remark: Optional[str] = None
    admin_remark: Optional[str] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None
    reviewed_at: Optional[str] = None
    reviewed_by: Optional[int] = None


class BdApplicationApiResponse(ApiResponse[Optional[BdApplicationOut]]):
    pass
