from __future__ import annotations

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.deps.auth import get_current_user_id
from app.schemas.dividend import (
    MyDividendRecordsApiResponse,
    MyDividendSummaryApiResponse,
)
from app.schemas.response import ok
from app.services.dividend_query import (
    get_my_dividend_records,
    get_my_dividend_summary,
)


router = APIRouter(prefix="/dividend", tags=["dividend"])


@router.get("/my/summary", response_model=MyDividendSummaryApiResponse)
def my_dividend_summary(
    request: Request,
    user_id: str = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    trace_id = getattr(request.state, "trace_id", None)
    # 只读取当前登录用户自己的分红汇总，不触发分红计算或发放。
    data = get_my_dividend_summary(db=db, user_id=int(user_id))
    return ok(data=data, trace_id=trace_id)


@router.get("/my/records", response_model=MyDividendRecordsApiResponse)
def my_dividend_records(
    request: Request,
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    user_id: str = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    trace_id = getattr(request.state, "trace_id", None)
    # 分页返回当前用户自己的分红明细，避免跨用户读取。
    data = get_my_dividend_records(
        db=db,
        user_id=int(user_id),
        page=page,
        page_size=page_size,
    )
    return ok(data=data, trace_id=trace_id)
