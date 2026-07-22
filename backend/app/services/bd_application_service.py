from __future__ import annotations

from datetime import datetime
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from typing import Any, Dict, Optional

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.db.models.bd_account import BdAccount
from app.db.models.bd_application import BdApplication
from app.db.models.bd_commission_rate_change_log import BdCommissionRateChangeLog
from app.schemas.bd_application import BdApplicationCreateIn

BD_LEVEL_DEFAULT_RATES = {
    "BD1": Decimal("0.300000"),
    "BD2": Decimal("0.400000"),
    "BD3": Decimal("0.500000"),
}


class BdApplicationReviewError(Exception):
    pass


class BdCommissionRateUpdateError(Exception):
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


def _normalize_commission_rate(value: Any, *, field_name: str) -> Decimal:
    try:
        rate = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError) as exc:
        raise BdCommissionRateUpdateError(f"{field_name}格式不正确") from exc
    if not rate.is_finite() or rate < Decimal("0") or rate > Decimal("1"):
        raise BdCommissionRateUpdateError(f"{field_name}必须在 0% 到 100% 之间")
    return rate.quantize(Decimal("0.000001"), rounding=ROUND_HALF_UP)


def _normalize_commission_percent(value: Any) -> Decimal:
    try:
        percent = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError) as exc:
        raise BdCommissionRateUpdateError("请输入正确的BD分佣比例") from exc
    if not percent.is_finite() or percent < Decimal("0") or percent > Decimal("100"):
        raise BdCommissionRateUpdateError("BD分佣比例必须在 0% 到 100% 之间")
    try:
        rounded_percent = percent.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    except InvalidOperation as exc:
        raise BdCommissionRateUpdateError("BD分佣比例最多保留两位小数") from exc
    if percent != rounded_percent:
        raise BdCommissionRateUpdateError("BD分佣比例最多保留两位小数")
    return (percent / Decimal("100")).quantize(Decimal("0.000001"), rounding=ROUND_HALF_UP)


def update_bd_commission_rate(
    db: Session,
    *,
    application_id: int,
    commission_percent: Any,
    expected_commission_rate: Any,
    changed_by_admin_id: int,
    reason: str,
) -> Dict[str, Any]:
    reason_text = str(reason or "").strip()
    if not reason_text:
        raise BdCommissionRateUpdateError("修改原因不能为空")
    if len(reason_text) > 500:
        raise BdCommissionRateUpdateError("修改原因不能超过 500 个字符")

    try:
        admin_id = int(changed_by_admin_id)
    except (TypeError, ValueError) as exc:
        raise BdCommissionRateUpdateError("无法识别当前管理员，请重新登录") from exc
    if admin_id <= 0:
        raise BdCommissionRateUpdateError("无法识别当前管理员，请重新登录")

    application = (
        db.query(BdApplication)
        .filter(BdApplication.id == int(application_id))
        .first()
    )
    if application is None:
        raise BdCommissionRateUpdateError("BD申请不存在")
    if str(application.status or "").strip().upper() != "APPROVED":
        raise BdCommissionRateUpdateError("只有已通过的BD申请可以修改分佣比例")

    account = (
        db.query(BdAccount)
        .filter(BdAccount.user_id == int(application.user_id))
        .with_for_update()
        .first()
    )
    if account is None:
        raise BdCommissionRateUpdateError("该用户没有BD账号")
    if str(account.status or "").strip().upper() != "ACTIVE":
        raise BdCommissionRateUpdateError("只有生效中的BD账号可以修改分佣比例")

    current_rate = _normalize_commission_rate(account.commission_rate, field_name="当前分佣比例")
    expected_rate = _normalize_commission_rate(expected_commission_rate, field_name="页面中的原分佣比例")
    if current_rate != expected_rate:
        raise BdCommissionRateUpdateError("分佣比例已被其他管理员修改，请刷新页面后重试")

    new_rate = _normalize_commission_percent(commission_percent)
    if new_rate == current_rate:
        raise BdCommissionRateUpdateError("新分佣比例与当前比例相同")

    now = datetime.utcnow()
    account.commission_rate = new_rate
    account.updated_at = now
    change_log = BdCommissionRateChangeLog(
        bd_account_id=int(account.id),
        bd_user_id=int(account.user_id),
        application_id=int(application.id),
        old_commission_rate=current_rate,
        new_commission_rate=new_rate,
        changed_by_admin_id=admin_id,
        reason=reason_text,
        created_at=now,
    )
    db.add(account)
    db.add(change_log)
    db.flush()
    return {
        "application_id": int(application.id),
        "bd_user_id": int(account.user_id),
        "old_commission_rate": current_rate,
        "new_commission_rate": new_rate,
        "change_log_id": int(change_log.id),
    }


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
