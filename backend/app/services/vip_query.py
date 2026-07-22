from __future__ import annotations

from decimal import Decimal
from typing import Any, Optional

from sqlalchemy.orm import Session, joinedload

from app.db.models.asset import UserBalance
from app.db.models.user_rcb_lock import UserRcbLock
from app.db.models.user_vip_snapshot import UserVipSnapshot
from app.db.models.vip_fee_level import VipFeeLevel
from app.services.balance import FUNDING_BALANCE_CHAIN_KEY
from app.services.spot_fee_settings_service import load_spot_fee_settings


def _fmt_decimal(value: Any, scale: Optional[int] = None) -> Optional[str]:
    if value is None:
        return None
    dec = value if isinstance(value, Decimal) else Decimal(str(value))
    if scale is not None:
        return format(dec, f".{scale}f")
    return format(dec.normalize(), "f") if dec != 0 else "0"


def _fmt_rate(value: Any) -> Optional[str]:
    return _fmt_decimal(value, scale=10)


def _fmt_percent(value: Any) -> Optional[str]:
    if value is None:
        return None
    dec = value if isinstance(value, Decimal) else Decimal(str(value))
    return format(dec.quantize(Decimal("0.01")).normalize(), "f")


def _serialize_level(level: VipFeeLevel) -> dict[str, Any]:
    condition = level.condition
    return {
        "level_code": level.level_code,
        "level_name": level.level_name,
        "sort_order": int(level.sort_order),
        "spot_maker_fee": _fmt_rate(level.spot_maker_fee),
        "spot_taker_fee": _fmt_rate(level.spot_taker_fee),
        "contract_maker_fee": _fmt_rate(level.contract_maker_fee),
        "contract_taker_fee": _fmt_rate(level.contract_taker_fee),
        "rcb_discount_rate": _fmt_rate(level.rcb_discount_rate),
        "condition": {
            "min_30d_volume": _fmt_decimal(condition.min_30d_volume) if condition else None,
            "min_rcb_hold": _fmt_decimal(condition.min_rcb_hold) if condition else None,
            "min_lock_amount": _fmt_decimal(condition.min_lock_amount) if condition else None,
            "lock_period_days": int(condition.lock_period_days) if condition and condition.lock_period_days is not None else None,
            "user_limit": int(condition.user_limit) if condition and condition.user_limit is not None else None,
            "dividend_rate": _fmt_rate(condition.dividend_rate) if condition else None,
        },
    }


def _empty_user_summary() -> dict[str, Any]:
    return {
        "vip_level_code": None,
        "svip_level_code": None,
        "effective_level_code": None,
        "effective_fee_source": None,
        "effective_spot_maker_fee": None,
        "effective_spot_taker_fee": None,
        "volume_30d": None,
        "rcb_available": None,
        "rcb_funding_available": None,
        "rcb_locked": None,
        "rcb_lock_period_days": None,
    }


def _load_levels(db: Session, vip_type: str) -> list[dict[str, Any]]:
    levels = (
        db.query(VipFeeLevel)
        .options(joinedload(VipFeeLevel.condition))
        .filter(VipFeeLevel.vip_type == vip_type, VipFeeLevel.is_enabled.is_(True))
        .order_by(VipFeeLevel.sort_order.asc(), VipFeeLevel.id.asc())
        .all()
    )
    return [_serialize_level(level) for level in levels]


def _load_user_summary(db: Session, user_id: Optional[int]) -> dict[str, Any]:
    summary = _empty_user_summary()
    if user_id is None:
        return summary

    snapshot = (
        db.query(UserVipSnapshot)
        .filter(UserVipSnapshot.user_id == user_id)
        .first()
    )
    if snapshot is None:
        return summary

    funding_balance = (
        db.query(UserBalance)
        .filter(
            UserBalance.user_id == user_id,
            UserBalance.coin_symbol == "RCB",
            UserBalance.chain_key == FUNDING_BALANCE_CHAIN_KEY,
        )
        .first()
    )
    max_lock_period_days = (
        db.query(UserRcbLock.lock_period_days)
        .filter(UserRcbLock.user_id == user_id)
        .filter(UserRcbLock.asset_symbol == "RCB")
        .filter(UserRcbLock.status == "LOCKED")
        .order_by(UserRcbLock.lock_period_days.desc())
        .limit(1)
        .scalar()
    )

    summary.update(
        {
            "vip_level_code": snapshot.vip_level_code,
            "svip_level_code": snapshot.svip_level_code,
            "effective_level_code": snapshot.effective_level_code,
            "effective_fee_source": snapshot.effective_fee_source,
            "effective_spot_maker_fee": _fmt_rate(snapshot.effective_spot_maker_fee),
            "effective_spot_taker_fee": _fmt_rate(snapshot.effective_spot_taker_fee),
            "volume_30d": _fmt_decimal(snapshot.volume_30d),
            "rcb_available": _fmt_decimal(snapshot.rcb_available),
            "rcb_funding_available": _fmt_decimal(funding_balance.available_amount) if funding_balance else "0",
            "rcb_locked": _fmt_decimal(snapshot.rcb_locked),
            "rcb_lock_period_days": int(max_lock_period_days or 0),
        }
    )
    return summary


def get_vip_overview(
    db: Session,
    user_id: Optional[int] = None,
    *,
    auth_state: str = "anonymous",
) -> dict[str, Any]:
    spot_fee_settings = load_spot_fee_settings(db)
    rcb_fee_pay_percent = Decimal(str(spot_fee_settings.rcb_fee_discount_rate)) * Decimal("100")
    rcb_discount_percent = Decimal("100") - rcb_fee_pay_percent
    return {
        "vip_levels": _load_levels(db, "VIP"),
        "svip_levels": _load_levels(db, "SVIP"),
        "user_summary": _load_user_summary(db, user_id),
        "auth_state": auth_state,
        "rcb_fee_pay_percent": _fmt_percent(rcb_fee_pay_percent),
        # Compatibility field: existing clients may still consume the fee-savings percentage.
        "rcb_discount_percent": _fmt_percent(rcb_discount_percent),
    }
