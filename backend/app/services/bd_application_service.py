from __future__ import annotations

from datetime import datetime
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from typing import Any, Dict, Optional

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.db.models.bd_account import BdAccount
from app.db.models.bd_application import BdApplication
from app.schemas.bd_application import BdApplicationCreateIn

BD_LEVEL_DEFAULT_RATES = {
    "BD1": Decimal("0.300000"),
    "BD2": Decimal("0.400000"),
    "BD3": Decimal("0.500000"),
}


class BdApplicationReviewError(Exception):
    pass


def _fmt_decimal(value: Any, scale: int = 8) -> str:
    if value is None:
        return "0"
    if not isinstance(value, Decimal):
        value = Decimal(str(value))
    quantizer = Decimal("1").scaleb(-scale)
    rounded = value.quantize(quantizer, rounding=ROUND_HALF_UP)
    text = format(rounded, "f").rstrip("0").rstrip(".")
    return text or "0"


def _fmt_datetime(value: Any) -> Optional[str]:
    if not isinstance(value, datetime):
        return None
    return value.strftime("%Y-%m-%d %H:%M:%S")


def _serialize_application(application: BdApplication) -> Dict[str, Any]:
    return {
        "id": int(application.id),
        "user_id": int(application.user_id),
        "apply_level": str(application.apply_level or "").upper(),
        "deposit_coin_symbol": str(application.deposit_coin_symbol or "").upper(),
        "deposit_amount": _fmt_decimal(application.deposit_amount),
        "status": str(application.status or "").upper(),
        "remark": application.remark,
        "admin_remark": application.admin_remark,
        "created_at": _fmt_datetime(application.created_at),
        "updated_at": _fmt_datetime(application.updated_at),
        "reviewed_at": _fmt_datetime(application.reviewed_at),
        "reviewed_by": int(application.reviewed_by) if application.reviewed_by is not None else None,
    }


def get_latest_bd_application(db: Session, user_id: int) -> Optional[Dict[str, Any]]:
    application = (
        db.query(BdApplication)
        .filter(BdApplication.user_id == int(user_id))
        .order_by(BdApplication.created_at.desc(), BdApplication.id.desc())
        .first()
    )
    return _serialize_application(application) if application else None


def create_bd_application(
    db: Session,
    user_id: int,
    payload: BdApplicationCreateIn,
) -> Dict[str, Any]:
    existing_account = db.query(BdAccount).filter(BdAccount.user_id == int(user_id)).first()
    if existing_account:
        raise HTTPException(
            status_code=400,
            detail={"code": "ALREADY_BD", "message": "Current user is already a BD account"},
        )

    existing_pending = (
        db.query(BdApplication)
        .filter(
            BdApplication.user_id == int(user_id),
            BdApplication.status == "PENDING",
        )
        .order_by(BdApplication.created_at.desc(), BdApplication.id.desc())
        .first()
    )
    if existing_pending:
        return _serialize_application(existing_pending)

    try:
        deposit_amount = Decimal(str(payload.deposit_amount))
    except (InvalidOperation, ValueError) as exc:
        raise HTTPException(
            status_code=400,
            detail={"code": "INVALID_DEPOSIT_AMOUNT", "message": "Invalid deposit amount"},
        ) from exc

    if deposit_amount < 0:
        raise HTTPException(
            status_code=400,
            detail={"code": "INVALID_DEPOSIT_AMOUNT", "message": "Deposit amount must be non-negative"},
        )

    application = BdApplication(
        user_id=int(user_id),
        apply_level=payload.apply_level,
        deposit_coin_symbol=payload.deposit_coin_symbol,
        deposit_amount=deposit_amount,
        status="PENDING",
        remark=payload.remark,
    )
    db.add(application)
    db.flush()
    return _serialize_application(application)


def _normalize_apply_level(value: Any) -> str:
    level = str(value or "").strip().upper()
    if level not in BD_LEVEL_DEFAULT_RATES:
        raise BdApplicationReviewError(f"Unsupported BD level: {level or '-'}")
    return level


def _generate_invite_code(db: Session, user_id: int) -> str:
    base_code = f"BD{int(user_id)}"
    exists = db.query(BdAccount.id).filter(BdAccount.invite_code == base_code).first()
    if not exists:
        return base_code

    suffix = 1
    while True:
        candidate = f"{base_code}_{suffix}"
        exists = db.query(BdAccount.id).filter(BdAccount.invite_code == candidate).first()
        if not exists:
            return candidate
        suffix += 1


def approve_bd_application(
    db: Session,
    application_id: int,
    reviewed_by: Optional[int] = None,
    admin_remark: Optional[str] = None,
    commission_rate_override: Optional[Any] = None,
) -> Dict[str, Any]:
    application = (
        db.query(BdApplication)
        .filter(BdApplication.id == int(application_id))
        .with_for_update()
        .first()
    )
    if application is None:
        raise BdApplicationReviewError("BD application not found")

    if str(application.status or "").upper() != "PENDING":
        raise BdApplicationReviewError("Only PENDING applications can be reviewed")

    apply_level = _normalize_apply_level(application.apply_level)
    commission_rate = BD_LEVEL_DEFAULT_RATES[apply_level]
    if commission_rate_override not in (None, ""):
        try:
            commission_rate = Decimal(str(commission_rate_override))
        except (InvalidOperation, ValueError) as exc:
            raise BdApplicationReviewError("BD commission rate must be a decimal between 0 and 1") from exc
        if commission_rate < Decimal("0") or commission_rate > Decimal("1"):
            raise BdApplicationReviewError("BD commission rate must be between 0 and 1")
        commission_rate = commission_rate.quantize(Decimal("0.000001"), rounding=ROUND_HALF_UP)
    now = datetime.utcnow()
    remark_text = (admin_remark or "").strip() or None

    account = db.query(BdAccount).filter(BdAccount.user_id == int(application.user_id)).first()
    if account is None:
        account = BdAccount(
            user_id=int(application.user_id),
            bd_level=apply_level,
            commission_rate=commission_rate,
            invite_code=_generate_invite_code(db, int(application.user_id)),
            status="ACTIVE",
            remark=remark_text,
        )
        db.add(account)
    else:
        account.bd_level = apply_level
        account.commission_rate = commission_rate
        account.status = "ACTIVE"
        if remark_text:
            account.remark = remark_text

    application.status = "APPROVED"
    application.reviewed_at = now
    application.reviewed_by = reviewed_by
    application.admin_remark = remark_text
    db.flush()
    return _serialize_application(application)


def reject_bd_application(
    db: Session,
    application_id: int,
    reviewed_by: Optional[int] = None,
    admin_remark: Optional[str] = None,
) -> Dict[str, Any]:
    application = (
        db.query(BdApplication)
        .filter(BdApplication.id == int(application_id))
        .with_for_update()
        .first()
    )
    if application is None:
        raise BdApplicationReviewError("BD application not found")

    if str(application.status or "").upper() != "PENDING":
        raise BdApplicationReviewError("Only PENDING applications can be reviewed")

    application.status = "REJECTED"
    application.reviewed_at = datetime.utcnow()
    application.reviewed_by = reviewed_by
    application.admin_remark = (admin_remark or "").strip() or None
    db.flush()
    return _serialize_application(application)
