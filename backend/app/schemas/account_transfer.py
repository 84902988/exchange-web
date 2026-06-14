from __future__ import annotations

from decimal import Decimal
from typing import List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field


AccountKey = Literal["funding", "spot"]


class AccountTransferRequest(BaseModel):
    model_config = ConfigDict(
        json_schema_extra={
            "example": {
                "from_account": "funding",
                "to_account": "spot",
                "symbol": "USDT",
                "amount": "100.5",
            }
        }
    )

    from_account: AccountKey = Field(..., description="转出账户：funding 或 spot")
    to_account: AccountKey = Field(..., description="转入账户：funding 或 spot")
    symbol: str = Field(..., description="币种，例如 USDT")
    amount: Decimal = Field(..., description="划转数量，必须大于 0")


class AccountTransferRecordItem(BaseModel):
    id: int
    transfer_no: str
    symbol: str
    from_account: AccountKey
    to_account: AccountKey
    amount: str
    status: str
    from_available_before: str
    from_available_after: str
    to_available_before: str
    to_available_after: str
    remark: Optional[str] = None
    created_at: str


class AccountTransferSubmitData(BaseModel):
    record: AccountTransferRecordItem


class AccountTransferRecordsData(BaseModel):
    items: List[AccountTransferRecordItem]
    total: int
    page: int
    page_size: int
