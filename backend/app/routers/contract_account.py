from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.deps.auth import get_current_user_id
from app.schemas.contract_account import ContractTransferRequest
from app.schemas.response import ok
from app.services.contract_account_service import (
    ContractAccountBadRequest,
    ContractAccountInsufficientBalance,
    get_contract_account_summary,
    transfer_from_contract,
    transfer_to_contract,
)
from app.services.contract_private_ws import publish_contract_user_updates

router = APIRouter(prefix="/contract/account", tags=["contract-account"])


def _contract_account_summary_response(
    request: Request,
    db: Session = Depends(get_db),
    user_id: int = Depends(get_current_user_id),
):
    trace_id = getattr(request.state, "trace_id", None)
    try:
        data = get_contract_account_summary(db, int(user_id))
        return ok(data=data.model_dump(), trace_id=trace_id)
    except ContractAccountBadRequest as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail={"code": exc.code, "message": str(exc)})
    except HTTPException:
        db.rollback()
        raise
    except Exception:
        db.rollback()
        raise HTTPException(
            status_code=500,
            detail={"code": "INTERNAL_ERROR", "message": "contract account summary failed"},
        )


@router.get("")
def contract_account(
    request: Request,
    db: Session = Depends(get_db),
    user_id: int = Depends(get_current_user_id),
):
    return _contract_account_summary_response(request=request, db=db, user_id=user_id)


@router.get("/summary")
def contract_account_summary(
    request: Request,
    db: Session = Depends(get_db),
    user_id: int = Depends(get_current_user_id),
):
    return _contract_account_summary_response(request=request, db=db, user_id=user_id)


@router.post("/transfer-in")
def contract_transfer_in(
    request: Request,
    payload: ContractTransferRequest,
    db: Session = Depends(get_db),
    user_id: int = Depends(get_current_user_id),
):
    trace_id = getattr(request.state, "trace_id", None)
    try:
        data = transfer_to_contract(
            db,
            user_id=int(user_id),
            amount=payload.amount,
            from_account=payload.account,
        )
        publish_contract_user_updates(user_id=int(user_id), include_account=True)
        return ok(data=data.model_dump(), trace_id=trace_id)
    except (ContractAccountBadRequest, ContractAccountInsufficientBalance) as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail={"code": exc.code, "message": str(exc)})
    except HTTPException:
        db.rollback()
        raise
    except Exception:
        db.rollback()
        raise HTTPException(
            status_code=500,
            detail={"code": "INTERNAL_ERROR", "message": "contract transfer-in failed"},
        )


@router.post("/transfer-out")
def contract_transfer_out(
    request: Request,
    payload: ContractTransferRequest,
    db: Session = Depends(get_db),
    user_id: int = Depends(get_current_user_id),
):
    trace_id = getattr(request.state, "trace_id", None)
    try:
        data = transfer_from_contract(
            db,
            user_id=int(user_id),
            amount=payload.amount,
            to_account=payload.account,
        )
        publish_contract_user_updates(user_id=int(user_id), include_account=True)
        return ok(data=data.model_dump(), trace_id=trace_id)
    except (ContractAccountBadRequest, ContractAccountInsufficientBalance) as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail={"code": exc.code, "message": str(exc)})
    except HTTPException:
        db.rollback()
        raise
    except Exception:
        db.rollback()
        raise HTTPException(
            status_code=500,
            detail={"code": "INTERNAL_ERROR", "message": "contract transfer-out failed"},
        )
