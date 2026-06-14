from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal, InvalidOperation, ROUND_DOWN
from typing import Optional

from sqlalchemy.orm import Session

from app.db.models.spot_fee_settings import SpotFeeSettings


DEFAULT_SPOT_RCB_FEE_ENABLED = True
DEFAULT_RCB_FEE_DISCOUNT_RATE = Decimal("0.75")
DEFAULT_MIN_RCB_FEE_AMOUNT = Decimal("0")
Q18 = Decimal("0.000000000000000001")


class SpotFeeSettingsError(ValueError):
    pass


@dataclass(frozen=True)
class SpotFeeSettingsSnapshot:
    spot_rcb_fee_enabled: bool
    rcb_fee_discount_rate: Decimal
    min_rcb_fee_amount: Decimal
    updated_by_admin_id: Optional[int] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


def _decimal_or_default(value: object, default: Decimal) -> Decimal:
    try:
        return Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        return default


def _q18(value: Decimal) -> Decimal:
    return Decimal(str(value or 0)).quantize(Q18, rounding=ROUND_DOWN)


def _settings_from_row(row: Optional[SpotFeeSettings]) -> SpotFeeSettingsSnapshot:
    if row is None:
        return SpotFeeSettingsSnapshot(
            spot_rcb_fee_enabled=DEFAULT_SPOT_RCB_FEE_ENABLED,
            rcb_fee_discount_rate=DEFAULT_RCB_FEE_DISCOUNT_RATE,
            min_rcb_fee_amount=DEFAULT_MIN_RCB_FEE_AMOUNT,
        )
    rate = _decimal_or_default(row.rcb_fee_discount_rate, DEFAULT_RCB_FEE_DISCOUNT_RATE)
    if rate <= Decimal("0") or rate > Decimal("1"):
        rate = DEFAULT_RCB_FEE_DISCOUNT_RATE
    min_amount = _decimal_or_default(row.min_rcb_fee_amount, DEFAULT_MIN_RCB_FEE_AMOUNT)
    if min_amount < Decimal("0"):
        min_amount = DEFAULT_MIN_RCB_FEE_AMOUNT
    return SpotFeeSettingsSnapshot(
        spot_rcb_fee_enabled=bool(row.spot_rcb_fee_enabled),
        rcb_fee_discount_rate=rate,
        min_rcb_fee_amount=_q18(min_amount),
        updated_by_admin_id=int(row.updated_by_admin_id) if row.updated_by_admin_id is not None else None,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


def load_spot_fee_settings(db: Session) -> SpotFeeSettingsSnapshot:
    row = db.query(SpotFeeSettings).order_by(SpotFeeSettings.id.asc()).first()
    return _settings_from_row(row)


def get_or_create_spot_fee_settings(db: Session) -> SpotFeeSettings:
    row = db.query(SpotFeeSettings).order_by(SpotFeeSettings.id.asc()).first()
    if row is not None:
        return row
    row = SpotFeeSettings(
        spot_rcb_fee_enabled=DEFAULT_SPOT_RCB_FEE_ENABLED,
        rcb_fee_discount_rate=DEFAULT_RCB_FEE_DISCOUNT_RATE,
        min_rcb_fee_amount=DEFAULT_MIN_RCB_FEE_AMOUNT,
    )
    db.add(row)
    db.flush()
    return row


def validate_rcb_fee_discount_rate(value: Decimal) -> Decimal:
    rate = _decimal_or_default(value, Decimal("0"))
    if rate <= Decimal("0") or rate > Decimal("1"):
        raise SpotFeeSettingsError("RCB抵扣比例必须大于 0 且小于等于 100%")
    return rate.quantize(Decimal("0.000001"), rounding=ROUND_DOWN)


def update_spot_fee_settings(
    db: Session,
    *,
    spot_rcb_fee_enabled: bool,
    rcb_fee_discount_rate: Decimal,
    updated_by_admin_id: Optional[int] = None,
    min_rcb_fee_amount: Optional[Decimal] = None,
) -> SpotFeeSettingsSnapshot:
    row = get_or_create_spot_fee_settings(db)
    row.spot_rcb_fee_enabled = bool(spot_rcb_fee_enabled)
    row.rcb_fee_discount_rate = validate_rcb_fee_discount_rate(rcb_fee_discount_rate)
    if min_rcb_fee_amount is not None:
        min_amount = _decimal_or_default(min_rcb_fee_amount, DEFAULT_MIN_RCB_FEE_AMOUNT)
        if min_amount < Decimal("0"):
            raise SpotFeeSettingsError("最低 RCB 手续费数量不能小于 0")
        row.min_rcb_fee_amount = _q18(min_amount)
    row.updated_by_admin_id = int(updated_by_admin_id) if updated_by_admin_id is not None else None
    row.updated_at = datetime.utcnow()
    db.add(row)
    db.flush()
    return _settings_from_row(row)
