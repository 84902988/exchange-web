from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.schemas.response import ok
from app.services.contract_order_service import ContractOrderError
from app.services.contract_tp_sl_service import (
    ContractTpSlError,
    execute_contract_tp_sl,
    scan_and_execute_contract_tp_sl,
)


router = APIRouter(prefix="/contract/tp-sl", tags=["contract-tp-sl"])


class ContractTpSlExecuteRequest(BaseModel):
    position_id: int = Field(..., gt=0)


@router.post("/execute-once")
def contract_tp_sl_execute_once(
    request: Request,
    payload: ContractTpSlExecuteRequest,
    db: Session = Depends(get_db),
):
    trace_id = getattr(request.state, "trace_id", None)
    try:
        result = execute_contract_tp_sl(db, int(payload.position_id))
        return ok(data=result.to_dict(), trace_id=trace_id)
    except (ContractTpSlError, ContractOrderError) as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail={"code": exc.code, "message": str(exc)})
    except HTTPException:
        db.rollback()
        raise
    except Exception:
        db.rollback()
        raise HTTPException(
            status_code=500,
            detail={"code": "CONTRACT_TP_SL_EXECUTE_FAILED", "message": "contract tp/sl execute failed"},
        )


@router.post("/run-once")
def contract_tp_sl_run_once(
    request: Request,
    symbol: Optional[str] = Query(None),
    limit: int = Query(100, ge=1, le=1000),
    db: Session = Depends(get_db),
):
    trace_id = getattr(request.state, "trace_id", None)
    try:
        results = scan_and_execute_contract_tp_sl(db, symbol=symbol, limit=limit)
        return ok(
            data={
                "executed_count": len(results),
                "positions": [item.to_dict() for item in results],
            },
            trace_id=trace_id,
        )
    except (ContractTpSlError, ContractOrderError) as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail={"code": exc.code, "message": str(exc)})
    except HTTPException:
        db.rollback()
        raise
    except Exception:
        db.rollback()
        raise HTTPException(
            status_code=500,
            detail={"code": "CONTRACT_TP_SL_RUN_FAILED", "message": "contract tp/sl run failed"},
        )
