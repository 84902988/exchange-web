from __future__ import annotations

from decimal import Decimal
from typing import List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field


class UserTransferRecipientData(BaseModel):
    user_id: int
    email_mask: str
    nickname: Optional[str] = None
    avatar_url: Optional[str] = None
    can_transfer: bool


class UserTransferRequest(BaseModel):
    model_config = ConfigDict(
        json_schema_extra={
            "example": {
                "request_id": "b43bbf1b-54d1-4f71-8e70-f8d43d56f7f6",
                "recipient_email": "user@example.com",
                "symbol": "USDT",
                "amount": "10",
                "remark": "optional",
            }
        }
    )

    request_id: str = Field(..., min_length=1, max_length=64)
    recipient_email: str = Field(..., min_length=3, max_length=191)
    symbol: str = Field(..., min_length=1, max_length=32)
    amount: Decimal = Field(...)
    remark: Optional[str] = Field(None, max_length=255)


class UserTransferRecordItem(BaseModel):
    id: int
    transfer_no: str
    request_id: str
    direction: Literal["in", "out"]
    counterparty_user_id: int
    counterparty_nickname: Optional[str] = None
    recipient_nickname: Optional[str] = None
    recipient_email_mask: str
    symbol: str
    from_account: Literal["funding"]
    to_account: Literal["funding"]
    amount: str
    fee_amount: str
    net_amount: str
    status: str
    sender_available_before: str
    sender_available_after: str
    receiver_available_before: str
    receiver_available_after: str
    remark: Optional[str] = None
    created_at: str


class UserTransferSubmitData(BaseModel):
    record: UserTransferRecordItem


class UserTransferRecordsData(BaseModel):
    items: List[UserTransferRecordItem]
    total: int
    page: int
    page_size: int
