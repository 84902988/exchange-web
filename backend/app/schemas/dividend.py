from __future__ import annotations

from typing import Optional

from pydantic import BaseModel

from app.schemas.response import ApiResponse


class MyDividendSummaryOut(BaseModel):
    total_rcb: str
    month_rcb: str
    latest_amount_rcb: Optional[str] = None
    latest_dividend_date: Optional[str] = None
    latest_status: Optional[str] = None
    current_svip_level: Optional[str] = None
    eligible: bool = False


class MyDividendRecordOut(BaseModel):
    id: int
    dividend_date: Optional[str] = None
    svip_level_code: str
    amount_rcb: str
    amount_usdt: str
    status: str
    paid_at: Optional[str] = None


class MyDividendRecordsOut(BaseModel):
    items: list[MyDividendRecordOut]
    total: int
    page: int
    page_size: int


class MyDividendSummaryApiResponse(ApiResponse[MyDividendSummaryOut]):
    pass


class MyDividendRecordsApiResponse(ApiResponse[MyDividendRecordsOut]):
    pass
