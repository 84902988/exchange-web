from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.deps.auth import get_current_user_id
from app.schemas.contract_order import ContractCloseOrderRequest, ContractCloseSummaryOrderRequest, ContractOpenOrderRequest
from app.schemas.response import ok
from app.services.contract_order_service import (
    ContractOrderBadRequest,
    ContractOrderError,
    ContractOrderInsufficientMargin,
    ContractOrderQuoteUnavailable,
    cancel_contract_order,
    close_contract_position_summary,
    close_contract_position,
    create_contract_open_order,
)
from app.services.contract_private_ws import publish_contract_user_updates

router = APIRouter(prefix="/contract/orders", tags=["contract-orders"])


@router.post("/open")
def contract_open_order(
    request: Request,
    payload: ContractOpenOrderRequest,
    db: Session = Depends(get_db),
    user_id: int = Depends(get_current_user_id),
):
    trace_id = getattr(request.state, "trace_id", None)
    try:
        data = create_contract_open_order(db, int(user_id), payload)
        publish_contract_user_updates(
            user_id=int(user_id),
            symbols=[data.symbol],
            position_ids=[data.position_id] if data.position_id is not None else None,
            order_ids=[data.order_id],
            include_account=True,
        )
        return ok(data=data.model_dump(), trace_id=trace_id)
    except ContractOrderInsufficientMargin as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail={"code": exc.code, "message": str(exc)})
    except (ContractOrderBadRequest, ContractOrderQuoteUnavailable) as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail={"code": exc.code, "message": str(exc)})
    except ContractOrderError as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail={"code": exc.code, "message": str(exc)})
    except HTTPException:
        db.rollback()
        raise
    except Exception:
        db.rollback()
        raise HTTPException(
            status_code=500,
            detail={"code": "CONTRACT_OPEN_ORDER_FAILED", "message": "合约开仓失败"},
        )


@router.post("/close")
def contract_close_order(
    request: Request,
    payload: ContractCloseOrderRequest,
    db: Session = Depends(get_db),
    user_id: int = Depends(get_current_user_id),
):
    trace_id = getattr(request.state, "trace_id", None)
    try:
        data = close_contract_position(db, int(user_id), payload)
        publish_contract_user_updates(
            user_id=int(user_id),
            symbols=[data.symbol],
            position_ids=[data.position_id] if data.position_id is not None else [payload.position_id],
            order_ids=[data.order_id],
            include_account=True,
        )
        return ok(data=data.model_dump(), trace_id=trace_id)
    except ContractOrderInsufficientMargin as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail={"code": exc.code, "message": str(exc)})
    except (ContractOrderBadRequest, ContractOrderQuoteUnavailable) as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail={"code": exc.code, "message": str(exc)})
    except ContractOrderError as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail={"code": exc.code, "message": str(exc)})
    except HTTPException:
        db.rollback()
        raise
    except Exception:
        db.rollback()
        raise HTTPException(
            status_code=500,
            detail={"code": "CONTRACT_CLOSE_ORDER_FAILED", "message": "合约平仓失败"},
        )


@router.post("/close-summary")
def contract_close_summary_order(
    request: Request,
    payload: ContractCloseSummaryOrderRequest,
    db: Session = Depends(get_db),
    user_id: int = Depends(get_current_user_id),
):
    trace_id = getattr(request.state, "trace_id", None)
    try:
        data = close_contract_position_summary(db, int(user_id), payload)
        publish_contract_user_updates(
            user_id=int(user_id),
            symbols=[data.symbol],
            position_ids=data.affected_position_ids,
            order_ids=data.generated_order_ids,
            trade_ids=data.generated_trade_ids,
            include_account=True,
        )
        return ok(data=data.model_dump(), trace_id=trace_id)
    except ContractOrderInsufficientMargin as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail={"code": exc.code, "message": str(exc)})
    except (ContractOrderBadRequest, ContractOrderQuoteUnavailable) as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail={"code": exc.code, "message": str(exc)})
    except ContractOrderError as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail={"code": exc.code, "message": str(exc)})
    except HTTPException:
        db.rollback()
        raise
    except Exception:
        db.rollback()
        raise HTTPException(
            status_code=500,
            detail={"code": "CONTRACT_CLOSE_SUMMARY_ORDER_FAILED", "message": "合约聚合平仓失败"},
        )


@router.post("/{order_id}/cancel")
def contract_cancel_order(
    order_id: int,
    request: Request,
    db: Session = Depends(get_db),
    user_id: int = Depends(get_current_user_id),
):
    trace_id = getattr(request.state, "trace_id", None)
    try:
        data = cancel_contract_order(db, int(user_id), int(order_id))
        publish_contract_user_updates(
            user_id=int(user_id),
            symbols=[data.symbol],
            position_ids=[data.position_id] if data.position_id is not None else None,
            order_ids=[data.order_id],
            include_account=True,
        )
        return ok(data=data.model_dump(), trace_id=trace_id)
    except ContractOrderError as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail={"code": exc.code, "message": str(exc)})
    except Exception:
        db.rollback()
        raise HTTPException(
            status_code=500,
            detail={"code": "CONTRACT_CANCEL_ORDER_FAILED", "message": "合约撤单失败"},
        )
