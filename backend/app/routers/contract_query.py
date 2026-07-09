from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.deps.auth import get_current_user_id
from app.schemas.contract_order import ContractPositionTpSlUpdateRequest
from app.schemas.response import ok
from app.services.contract_position_service import (
    ContractPositionBadRequest,
    ContractPositionNotOpen,
    ContractPositionQuoteUnavailable,
    ContractPositionServiceError,
    update_contract_position_tp_sl,
)
from app.services.contract_query_service import (
    get_user_contract_orders,
    get_user_contract_position_summaries,
    get_user_contract_positions,
    get_user_contract_trades,
)

router = APIRouter(prefix="/contract", tags=["contract-query"])


@router.get("/positions")
def contract_positions(
    request: Request,
    symbol: str = Query("", description="Optional contract symbol"),
    status: str = Query("OPEN", description="Position status, default OPEN"),
    db: Session = Depends(get_db),
    user_id: int = Depends(get_current_user_id),
):
    trace_id = getattr(request.state, "trace_id", None)
    try:
        data = get_user_contract_positions(db, int(user_id), symbol=symbol, status=status)
        return ok(data=data.model_dump(), trace_id=trace_id)
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(
            status_code=500,
            detail={"code": "CONTRACT_POSITIONS_QUERY_FAILED", "message": "查询合约持仓失败"},
        )


@router.get("/positions/summary")
def contract_position_summaries(
    request: Request,
    symbol: str = Query("", description="Optional contract symbol"),
    side: str = Query("", description="Optional position side: LONG or SHORT"),
    db: Session = Depends(get_db),
    user_id: int = Depends(get_current_user_id),
):
    trace_id = getattr(request.state, "trace_id", None)
    try:
        data = get_user_contract_position_summaries(db, int(user_id), symbol=symbol, side=side)
        return ok(data=data.model_dump(), trace_id=trace_id)
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(
            status_code=500,
            detail={"code": "CONTRACT_POSITION_SUMMARY_QUERY_FAILED", "message": "查询合约持仓汇总失败"},
        )


@router.patch("/positions/{position_id}/tp-sl")
def contract_position_tp_sl_update(
    position_id: int,
    request: Request,
    payload: ContractPositionTpSlUpdateRequest,
    db: Session = Depends(get_db),
    user_id: int = Depends(get_current_user_id),
):
    trace_id = getattr(request.state, "trace_id", None)
    try:
        data = update_contract_position_tp_sl(db, int(user_id), int(position_id), payload)
        return ok(data=data.model_dump(), trace_id=trace_id)
    except (ContractPositionBadRequest, ContractPositionNotOpen, ContractPositionQuoteUnavailable) as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail={"code": exc.code, "message": str(exc)})
    except ContractPositionServiceError as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail={"code": exc.code, "message": str(exc)})
    except HTTPException:
        db.rollback()
        raise
    except Exception:
        db.rollback()
        raise HTTPException(
            status_code=500,
            detail={"code": "CONTRACT_POSITION_TP_SL_UPDATE_FAILED", "message": "修改止盈止损失败"},
        )


@router.get("/orders")
def contract_orders(
    request: Request,
    symbol: str = Query("", description="Optional contract symbol"),
    status: str = Query("", description="Optional order status"),
    status_group: str = Query("", description="Optional order status group: ACTIVE or HISTORY"),
    side: str = Query("", description="Optional order side: BUY or SELL"),
    position_side: str = Query("", description="Optional position side: LONG or SHORT"),
    order_type: str = Query("", description="Optional order type: MARKET or LIMIT"),
    action: str = Query("", description="Optional order action: OPEN or CLOSE"),
    created_from: str = Query("", description="Optional created_at lower bound"),
    created_to: str = Query("", description="Optional created_at upper bound"),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
    user_id: int = Depends(get_current_user_id),
):
    trace_id = getattr(request.state, "trace_id", None)
    try:
        data = get_user_contract_orders(
            db,
            int(user_id),
            symbol=symbol,
            status=status,
            status_group=status_group,
            side=side,
            position_side=position_side,
            order_type=order_type,
            action=action,
            created_from=created_from,
            created_to=created_to,
            page=page,
            page_size=page_size,
        )
        return ok(data=data.model_dump(), trace_id=trace_id)
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(
            status_code=500,
            detail={"code": "CONTRACT_ORDERS_QUERY_FAILED", "message": "查询合约订单失败"},
        )


@router.get("/trades")
def contract_trades(
    request: Request,
    symbol: str = Query("", description="Optional contract symbol"),
    side: str = Query("", description="Optional trade side: BUY or SELL"),
    position_side: str = Query("", description="Optional position side: LONG or SHORT"),
    action: str = Query("", description="Optional trade action: OPEN or CLOSE"),
    created_from: str = Query("", description="Optional created_at lower bound"),
    created_to: str = Query("", description="Optional created_at upper bound"),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
    user_id: int = Depends(get_current_user_id),
):
    trace_id = getattr(request.state, "trace_id", None)
    try:
        data = get_user_contract_trades(
            db,
            int(user_id),
            symbol=symbol,
            side=side,
            position_side=position_side,
            action=action,
            created_from=created_from,
            created_to=created_to,
            page=page,
            page_size=page_size,
        )
        return ok(data=data.model_dump(), trace_id=trace_id)
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(
            status_code=500,
            detail={"code": "CONTRACT_TRADES_QUERY_FAILED", "message": "查询合约成交失败"},
        )
