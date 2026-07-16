from __future__ import annotations

from decimal import Decimal
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field


class ContractAccountSummaryResponse(BaseModel):
    user_id: int
    margin_asset: str
    available_margin: str
    used_margin: str
    frozen_margin: str
    position_margin: str
    realized_pnl: str
    unrealized_pnl: Optional[str]
    equity: Optional[str]
    equity_state: Literal["LIVE", "RECENT", "STALE", "UNAVAILABLE"]
    equity_usable: bool
    equity_source: str


class ContractTransferRequest(BaseModel):
    model_config = ConfigDict(
        json_schema_extra={
            "example": {
                "amount": "100",
                "margin_asset": "USDT",
                "account": "funding",
            }
        }
    )

    amount: Decimal = Field(..., description="Transfer amount, must be greater than 0")
    margin_asset: Literal["USDT"] = Field("USDT", description="V1 only supports USDT")
    account: Literal["funding"] = Field("funding", description="V1 only supports funding")


class ContractTransferResponse(BaseModel):
    transfer_no: str
    direction: Literal["IN", "OUT"]
    margin_asset: str
    amount: str
    funding_available_before: str
    funding_available_after: str
    contract_available_before: str
    contract_available_after: str
    account: ContractAccountSummaryResponse
