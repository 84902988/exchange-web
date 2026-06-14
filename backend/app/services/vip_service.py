from __future__ import annotations

import logging
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Optional

import sqlalchemy as sa
from sqlalchemy import func, or_
from sqlalchemy.orm import Session, joinedload

from app.db.models.asset import UserBalance
from app.db.models.contract_trade import ContractTrade
from app.db.models.trade import Trade
from app.db.models.user_rcb_lock import UserRcbLock
from app.db.models.user_vip_snapshot import UserVipSnapshot
from app.db.models.vip_fee_level import VipFeeLevel
from app.services.balance import FUNDING_BALANCE_CHAIN_KEY, SPOT_BALANCE_CHAIN_KEY


ZERO = Decimal("0")
RCB_BALANCE_CHAIN_KEYS = (FUNDING_BALANCE_CHAIN_KEY, SPOT_BALANCE_CHAIN_KEY)
logger = logging.getLogger(__name__)


def _decimal_or_zero(value: Optional[Decimal]) -> Decimal:
    return value if value is not None else ZERO


def _load_enabled_levels(db: Session, vip_type: str) -> list[VipFeeLevel]:
    return (
        db.query(VipFeeLevel)
        .options(joinedload(VipFeeLevel.condition))
        .filter(VipFeeLevel.vip_type == vip_type)
        .filter(VipFeeLevel.is_enabled.is_(True))
        .order_by(VipFeeLevel.sort_order.asc(), VipFeeLevel.id.asc())
        .all()
    )


def get_user_30d_spot_volume(db: Session, user_id: int, since: Optional[datetime] = None) -> Decimal:
    since = since or datetime.utcnow() - timedelta(days=30)
    total = (
        db.query(func.coalesce(func.sum(Trade.quote_amount), ZERO))
        .filter(or_(Trade.buyer_user_id == user_id, Trade.seller_user_id == user_id))
        .filter(Trade.created_at >= since)
        .scalar()
    )
    return Decimal(str(total or ZERO))


def get_user_30d_contract_volume(db: Session, user_id: int, since: datetime) -> Decimal:
    total = (
        db.query(func.coalesce(func.sum(ContractTrade.notional), ZERO))
        .filter(ContractTrade.user_id == user_id)
        .filter(ContractTrade.created_at >= since)
        .filter(ContractTrade.action.in_(["OPEN", "CLOSE"]))
        .scalar()
    )
    return Decimal(str(total or ZERO))


def _load_user_volume_30d(db: Session, user_id: int) -> Decimal:
    since = datetime.utcnow() - timedelta(days=30)
    spot_volume = get_user_30d_spot_volume(db, user_id, since)
    contract_volume = get_user_30d_contract_volume(db, user_id, since)
    return spot_volume + contract_volume


def _load_user_rcb_balance_totals(db: Session, user_id: int) -> dict[str, Decimal]:
    rows = (
        db.query(
            UserBalance.chain_key,
            func.coalesce(func.sum(UserBalance.available_amount), ZERO).label("available_amount"),
            func.coalesce(func.sum(UserBalance.frozen_amount), ZERO).label("frozen_amount"),
        )
        .filter(UserBalance.user_id == user_id)
        .filter(func.upper(UserBalance.coin_symbol) == "RCB")
        .filter(UserBalance.chain_key.in_(RCB_BALANCE_CHAIN_KEYS))
        .group_by(UserBalance.chain_key)
        .all()
    )

    totals = {
        "funding_available": ZERO,
        "funding_frozen": ZERO,
        "spot_available": ZERO,
        "spot_frozen": ZERO,
    }
    for chain_key, available_amount, frozen_amount in rows:
        normalized_chain_key = str(chain_key or "").strip().lower()
        if normalized_chain_key == FUNDING_BALANCE_CHAIN_KEY:
            totals["funding_available"] += Decimal(str(available_amount or ZERO))
            totals["funding_frozen"] += Decimal(str(frozen_amount or ZERO))
        elif normalized_chain_key == SPOT_BALANCE_CHAIN_KEY:
            totals["spot_available"] += Decimal(str(available_amount or ZERO))
            totals["spot_frozen"] += Decimal(str(frozen_amount or ZERO))
    totals["available"] = totals["funding_available"] + totals["spot_available"]
    totals["non_locked_hold"] = totals["available"] + totals["funding_frozen"] + totals["spot_frozen"]
    return totals


def _load_user_rcb_lock_state(db: Session, user_id: int) -> tuple[Decimal, list[tuple[Decimal, int]]]:
    now = datetime.utcnow()
    rows = (
        db.query(
            UserRcbLock.lock_amount,
            UserRcbLock.lock_period_days,
        )
        .filter(UserRcbLock.user_id == user_id)
        .filter(UserRcbLock.asset_symbol == "RCB")
        .filter(UserRcbLock.status == "LOCKED")
        .filter(UserRcbLock.end_time >= now)
        .all()
    )
    period_amounts = [(Decimal(str(amount or ZERO)), int(period_days or 0)) for amount, period_days in rows]
    total_locked = sum((amount for amount, _ in period_amounts), ZERO)
    return total_locked, period_amounts


def _matches_vip(level: VipFeeLevel, volume_30d: Decimal, rcb_hold: Decimal) -> bool:
    condition = level.condition
    if condition is None:
        return True

    min_volume = _decimal_or_zero(condition.min_30d_volume)
    min_rcb_hold = _decimal_or_zero(condition.min_rcb_hold)
    return volume_30d >= min_volume and rcb_hold >= min_rcb_hold


def _matches_svip(level: VipFeeLevel, rcb_locked: Decimal, period_amounts: list[tuple[Decimal, int]]) -> bool:
    condition = level.condition
    if condition is None:
        return True

    min_lock_amount = _decimal_or_zero(condition.min_lock_amount)
    lock_period_days = condition.lock_period_days
    qualifying_locked = (
        rcb_locked
        if lock_period_days is None
        else sum((amount for amount, period_days in period_amounts if period_days >= lock_period_days), ZERO)
    )
    return qualifying_locked >= min_lock_amount


def _pick_highest_level(levels: list[VipFeeLevel]) -> Optional[VipFeeLevel]:
    if not levels:
        return None
    return max(levels, key=lambda level: (level.sort_order, level.id))


def _fallback_level(levels: list[VipFeeLevel], preferred_code: str) -> Optional[VipFeeLevel]:
    for level in levels:
        if level.level_code == preferred_code:
            return level
    return levels[0] if levels else None


def _lower_rate(left: Optional[Decimal], right: Optional[Decimal]) -> Optional[Decimal]:
    if left is None:
        return right
    if right is None:
        return left
    return left if left <= right else right


def _select_effective_level(
    vip_level: Optional[VipFeeLevel],
    svip_level: Optional[VipFeeLevel],
) -> Optional[VipFeeLevel]:
    if vip_level is None:
        return svip_level
    if svip_level is None:
        return vip_level

    vip_maker = _decimal_or_zero(vip_level.spot_maker_fee)
    svip_maker = _decimal_or_zero(svip_level.spot_maker_fee)
    if vip_maker != svip_maker:
        return vip_level if vip_maker < svip_maker else svip_level

    vip_taker = _decimal_or_zero(vip_level.spot_taker_fee)
    svip_taker = _decimal_or_zero(svip_level.spot_taker_fee)
    if vip_taker != svip_taker:
        return vip_level if vip_taker < svip_taker else svip_level

    return svip_level


def _get_or_create_snapshot(db: Session, user_id: int, now: datetime) -> UserVipSnapshot:
    snapshot = (
        db.query(UserVipSnapshot)
        .filter(UserVipSnapshot.user_id == user_id)
        .with_for_update()
        .first()
    )
    if snapshot is not None:
        return snapshot

    snapshot = UserVipSnapshot(user_id=user_id, created_at=now, updated_at=now)
    db.add(snapshot)
    db.flush()
    return snapshot


def _sync_optional_metric_columns(
    db: Session,
    snapshot: UserVipSnapshot,
    *,
    volume_30d: Decimal,
    rcb_available: Decimal,
    rcb_locked: Decimal,
) -> None:
    inspector = sa.inspect(db.get_bind())
    columns = {column["name"] for column in inspector.get_columns(UserVipSnapshot.__tablename__)}
    optional_values = {
        "volume_30d": volume_30d,
        "rcb_available": rcb_available,
        "rcb_locked": rcb_locked,
    }
    values = {key: value for key, value in optional_values.items() if key in columns}
    if not values:
        return

    db.execute(
        sa.update(UserVipSnapshot)
        .where(UserVipSnapshot.id == snapshot.id)
        .values(**values)
    )


def calculate_user_vip_snapshot(db: Session, user_id: int) -> UserVipSnapshot:
    now = datetime.utcnow()

    vip_levels = _load_enabled_levels(db, "VIP")
    svip_levels = _load_enabled_levels(db, "SVIP")

    volume_30d = _load_user_volume_30d(db, user_id)
    rcb_balance_totals = _load_user_rcb_balance_totals(db, user_id)
    rcb_non_locked_hold = rcb_balance_totals["non_locked_hold"]
    rcb_available = rcb_balance_totals["available"]
    rcb_locked, rcb_lock_period_amounts = _load_user_rcb_lock_state(db, user_id)

    matched_vip = _pick_highest_level(
        [level for level in vip_levels if _matches_vip(level, volume_30d, rcb_non_locked_hold)]
    ) or _fallback_level(vip_levels, "VIP0")
    matched_svip = _pick_highest_level(
        [level for level in svip_levels if _matches_svip(level, rcb_locked, rcb_lock_period_amounts)]
    ) or _fallback_level(svip_levels, "NORMAL")
    effective_level = _select_effective_level(matched_vip, matched_svip)
    logger.debug(
        "VIP snapshot metrics user_id=%s funding_rcb_available=%s spot_rcb_available=%s "
        "rcb_non_locked_hold=%s rcb_locked=%s volume_30d=%s matched_vip_level=%s",
        user_id,
        rcb_balance_totals["funding_available"],
        rcb_balance_totals["spot_available"],
        rcb_non_locked_hold,
        rcb_locked,
        volume_30d,
        matched_vip.level_code if matched_vip else None,
    )

    snapshot = _get_or_create_snapshot(db, user_id, now)
    snapshot.vip_level_code = matched_vip.level_code if matched_vip else None
    snapshot.svip_level_code = matched_svip.level_code if matched_svip else None
    snapshot.effective_level_code = effective_level.level_code if effective_level else None
    snapshot.effective_fee_source = effective_level.vip_type if effective_level else None
    snapshot.effective_spot_maker_fee = _lower_rate(
        matched_vip.spot_maker_fee if matched_vip else None,
        matched_svip.spot_maker_fee if matched_svip else None,
    )
    snapshot.effective_spot_taker_fee = _lower_rate(
        matched_vip.spot_taker_fee if matched_vip else None,
        matched_svip.spot_taker_fee if matched_svip else None,
    )
    snapshot.effective_contract_maker_fee = effective_level.contract_maker_fee if effective_level else None
    snapshot.effective_contract_taker_fee = effective_level.contract_taker_fee if effective_level else None
    snapshot.vip_updated_at = now
    snapshot.svip_updated_at = now
    snapshot.updated_at = now

    db.flush()
    _sync_optional_metric_columns(
        db,
        snapshot,
        volume_30d=volume_30d,
        rcb_available=rcb_available,
        rcb_locked=rcb_locked,
    )
    db.flush()

    return snapshot
