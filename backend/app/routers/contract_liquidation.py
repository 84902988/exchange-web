from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.schemas.response import ok
from app.services.contract_liquidation_service import (
    ContractLiquidationRiskError,
    execute_liquidation,
    scan_and_execute_liquidations,
    scan_positions_for_liquidation,
)


router = APIRouter(prefix="/contract/liquidation", tags=["contract-liquidation"])


class ContractLiquidationExecuteRequest(BaseModel):
    position_id: int = Field(..., gt=0)


@router.post("/check-once")
def contract_liquidation_check_once(
    request: Request,
    limit: int = Query(100, ge=1, le=1000),
    db: Session = Depends(get_db),
):
    trace_id = getattr(request.state, "trace_id", None)
    try:
        triggered = scan_positions_for_liquidation(db, limit=limit)
        return ok(
            data={
                "triggered_count": len(triggered),
                "positions": [item.to_dict() for item in triggered],
            },
            trace_id=trace_id,
        )
    except ContractLiquidationRiskError as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail={"code": exc.code, "message": str(exc)})
    except HTTPException:
        db.rollback()
        raise
    except Exception:
        db.rollback()
        raise HTTPException(
            status_code=500,
            detail={"code": "CONTRACT_LIQUIDATION_CHECK_FAILED", "message": "contract liquidation check failed"},
        )


@router.post("/execute-once")
def contract_liquidation_execute_once(
    request: Request,
    payload: ContractLiquidationExecuteRequest,
    db: Session = Depends(get_db),
):
    trace_id = getattr(request.state, "trace_id", None)
    try:
        result = execute_liquidation(db, int(payload.position_id))
        return ok(data=result.to_dict(), trace_id=trace_id)
    except ContractLiquidationRiskError as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail={"code": exc.code, "message": str(exc)})
    except HTTPException:
        db.rollback()
        raise
    except Exception:
        db.rollback()
        raise HTTPException(
            status_code=500,
            detail={"code": "CONTRACT_LIQUIDATION_EXECUTE_FAILED", "message": "contract liquidation execute failed"},
        )


@router.post("/run-once")
def contract_liquidation_run_once(
    request: Request,
    limit: int = Query(50, ge=1, le=500),
    db: Session = Depends(get_db),
):
    trace_id = getattr(request.state, "trace_id", None)
    try:
        results = scan_and_execute_liquidations(db, limit=limit)
        return ok(
            data={
                "executed_count": len(results),
                "positions": [item.to_dict() for item in results],
            },
            trace_id=trace_id,
        )
    except ContractLiquidationRiskError as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail={"code": exc.code, "message": str(exc)})
    except HTTPException:
        db.rollback()
        raise
    except Exception:
        db.rollback()
        raise HTTPException(
            status_code=500,
            detail={"code": "CONTRACT_LIQUIDATION_RUN_FAILED", "message": "contract liquidation run failed"},
        )
