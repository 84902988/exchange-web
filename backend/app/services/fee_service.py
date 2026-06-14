from __future__ import annotations

from datetime import datetime
from decimal import Decimal, ROUND_DOWN
from typing import Optional

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.db.models.asset import Asset, BalanceLog, UserBalance
from app.db.models.bd_account import BdAccount
from app.db.models.bd_commission_record import BdCommissionRecord
from app.db.models.bd_user_relation import BdUserRelation
from app.db.models.order import Order
from app.db.models.trade import Trade
from app.db.models.trading_pair import TradingPair
from app.db.models.user_fee_preference import UserFeePreference
from app.db.models.user_vip_snapshot import UserVipSnapshot
from app.db.models.vip_fee_level import VipFeeLevel
from app.services.referral_source_service import (
    SOURCE_BD,
    SOURCE_USER_INVITE,
    get_user_commission_source,
)
from app.services.spot_fee_settings_service import load_spot_fee_settings
from app.services.user_invite_commission_service import create_user_invite_commission_for_fee


SPOT_BALANCE_CHAIN_KEY = "spot"
PLATFORM_USER_ID = 99999999
Q18 = Decimal("0.000000000000000001")
DEFAULT_RCB_PAY_RATIO = Decimal("0.75")
USDT_SYMBOL = "USDT"
RCB_SYMBOL = "RCB"


def _q18(value: Decimal) -> Decimal:
    return Decimal(str(value or 0)).quantize(Q18, rounding=ROUND_DOWN)


def _log_direction(change_amount: Decimal) -> int:
    return 1 if _q18(change_amount) >= Decimal("0") else -1


def _get_balance_for_update(
    db: Session,
    *,
    user_id: int,
    coin_symbol: str,
    auto_create: bool = False,
) -> Optional[UserBalance]:
    stmt = (
        select(UserBalance)
        .where(
            UserBalance.user_id == user_id,
            UserBalance.coin_symbol == coin_symbol,
            UserBalance.chain_key == SPOT_BALANCE_CHAIN_KEY,
        )
        .with_for_update()
    )
    balance = db.execute(stmt).scalar_one_or_none()
    if balance or not auto_create:
        return balance

    balance = UserBalance(
        user_id=user_id,
        coin_symbol=coin_symbol,
        chain_key=SPOT_BALANCE_CHAIN_KEY,
        available_amount=Decimal("0"),
        frozen_amount=Decimal("0"),
        version=1,
    )
    db.add(balance)
    db.flush()
    return balance


def _get_asset_id(db: Session, symbol: str) -> int:
    normalized_symbol = (symbol or "").upper().strip()
    asset_id = (
        db.query(Asset.id)
        .filter(Asset.symbol == normalized_symbol)
        .scalar()
    )
    if asset_id is None:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"fee asset not configured: {normalized_symbol}",
        )
    return int(asset_id)


def _normalize_fee_symbol(symbol: str) -> str:
    return (symbol or "").upper().strip()


def _record_trade_fee_payment(
    *,
    trade: Trade,
    side: str,
    fee_asset_symbol: str,
    fee_amount: Decimal,
) -> None:
    fee_asset_symbol = _normalize_fee_symbol(fee_asset_symbol)
    fee_amount = _q18(fee_amount)
    normalized_side = (side or "").upper().strip()

    if normalized_side == "BUY":
        trade.buyer_fee_amount = fee_amount
        trade.buyer_fee_asset_symbol = fee_asset_symbol
    elif normalized_side == "SELL":
        trade.seller_fee_amount = fee_amount
        trade.seller_fee_asset_symbol = fee_asset_symbol

    existing_symbol = _normalize_fee_symbol(getattr(trade, "fee_asset_symbol", None))
    existing_amount = getattr(trade, "fee_amount", None)
    if not existing_symbol:
        trade.fee_asset_symbol = fee_asset_symbol
        trade.fee_amount = fee_amount
        return

    if existing_symbol == fee_asset_symbol:
        trade.fee_asset_symbol = fee_asset_symbol
        trade.fee_amount = _q18(Decimal(str(existing_amount or 0)) + fee_amount)
        return

    trade.fee_asset_symbol = "MIXED"
    trade.fee_amount = None


def _resolve_trade_side_fee_snapshot(
    *,
    trade: Optional[Trade],
    user_id: int,
    fallback_fee_asset_symbol: str,
    fallback_fee_amount: Decimal,
) -> tuple[str, Decimal]:
    fallback_symbol = _normalize_fee_symbol(fallback_fee_asset_symbol) or USDT_SYMBOL
    fallback_amount = _q18(fallback_fee_amount)
    if trade is None:
        return fallback_symbol, fallback_amount

    fee_asset_symbol = ""
    fee_amount = None
    if int(user_id) == int(getattr(trade, "buyer_user_id", 0) or 0):
        fee_asset_symbol = _normalize_fee_symbol(getattr(trade, "buyer_fee_asset_symbol", None))
        fee_amount = getattr(trade, "buyer_fee_amount", None)
    elif int(user_id) == int(getattr(trade, "seller_user_id", 0) or 0):
        fee_asset_symbol = _normalize_fee_symbol(getattr(trade, "seller_fee_asset_symbol", None))
        fee_amount = getattr(trade, "seller_fee_amount", None)

    if not fee_asset_symbol or fee_asset_symbol == "MIXED":
        fee_asset_symbol = fallback_symbol
    if fee_asset_symbol not in {RCB_SYMBOL, USDT_SYMBOL}:
        fee_asset_symbol = fallback_symbol

    resolved_amount = _q18(Decimal(str(fee_amount or fallback_amount)))
    return fee_asset_symbol, resolved_amount


def _add_balance_log(
    db: Session,
    *,
    user_id: int,
    coin_symbol: str,
    before_available: Decimal,
    after_available: Decimal,
    before_frozen: Decimal,
    after_frozen: Decimal,
    change_amount: Decimal,
    change_type: str,
    biz_id: str,
    remark: str,
) -> BalanceLog:
    balance_log = BalanceLog(
        user_id=user_id,
        coin_symbol=coin_symbol,
        chain_key=SPOT_BALANCE_CHAIN_KEY,
        change_type=change_type,
        direction=_log_direction(change_amount),
        change_amount=_q18(change_amount),
        before_available=_q18(before_available),
        after_available=_q18(after_available),
        before_frozen=_q18(before_frozen),
        after_frozen=_q18(after_frozen),
        biz_type="TRADE_FEE",
        biz_id=biz_id,
        remark=remark,
        created_at=datetime.utcnow(),
    )
    db.add(balance_log)
    return balance_log


def _create_bd_commission_record_if_needed(
    db: Session,
    *,
    user_id: int,
    order_id: Optional[int],
    trade_id: Optional[int],
    trade: Optional[Trade],
    source_balance_log_id: Optional[int],
    fee_asset_id: int,
    fee_coin_symbol: str,
    fee_amount: Decimal,
) -> Optional[BdCommissionRecord]:
    fee_coin_symbol, fee_amount = _resolve_trade_side_fee_snapshot(
        trade=trade,
        user_id=int(user_id),
        fallback_fee_asset_symbol=fee_coin_symbol,
        fallback_fee_amount=fee_amount,
    )
    if fee_amount <= Decimal("0"):
        return None

    relation = (
        db.query(BdUserRelation)
        .filter(
            BdUserRelation.user_id == int(user_id),
            BdUserRelation.status == "ACTIVE",
        )
        .first()
    )
    if relation is None:
        return None

    bd_account = (
        db.query(BdAccount)
        .filter(
            BdAccount.user_id == int(relation.bd_user_id),
            BdAccount.status == "ACTIVE",
        )
        .first()
    )
    if bd_account is None:
        return None

    bd_user_id = int(relation.bd_user_id)
    if trade_id is not None:
        existing_record = (
            db.query(BdCommissionRecord)
            .filter(
                BdCommissionRecord.trade_id == int(trade_id),
                BdCommissionRecord.bd_user_id == bd_user_id,
            )
            .first()
        )
        if existing_record is not None:
            return existing_record

    commission_rate = Decimal(str(bd_account.commission_rate or 0))
    commission_amount = _q18(fee_amount * commission_rate)
    pool_amount = _q18(fee_amount - commission_amount)
    record = BdCommissionRecord(
        bd_user_id=bd_user_id,
        user_id=int(user_id),
        order_id=int(order_id) if order_id is not None else None,
        trade_id=int(trade_id) if trade_id is not None else None,
        source_balance_log_id=(
            int(source_balance_log_id) if source_balance_log_id is not None else None
        ),
        fee_asset_id=int(fee_asset_id),
        fee_coin_symbol=fee_coin_symbol,
        original_fee_amount=fee_amount,
        commission_rate=commission_rate,
        commission_amount=commission_amount,
        commission_asset_symbol=fee_coin_symbol,
        pool_amount=pool_amount,
        status="PENDING",
    )

    try:
        with db.begin_nested():
            db.add(record)
            db.flush()
    except IntegrityError:
        if trade_id is None:
            return None
        return (
            db.query(BdCommissionRecord)
            .filter(
                BdCommissionRecord.trade_id == int(trade_id),
                BdCommissionRecord.bd_user_id == bd_user_id,
            )
            .first()
        )

    return record


def _load_user_fee_rate(
    db: Session,
    *,
    snapshot: Optional[UserVipSnapshot],
    pair: TradingPair,
    role: str,
) -> Decimal:
    normalized_role = (role or "").upper().strip()
    fallback_rate = pair.maker_fee_rate if normalized_role == "MAKER" else pair.taker_fee_rate
    rates: list[Decimal] = []

    if snapshot and snapshot.vip_level_code:
        vip_level = _load_fee_level(
            db,
            vip_type="VIP",
            level_code=snapshot.vip_level_code,
        )
        rate = _level_role_rate(vip_level, normalized_role)
        if rate is not None:
            rates.append(rate)

    if snapshot and snapshot.svip_level_code:
        svip_level = _load_fee_level(
            db,
            vip_type="SVIP",
            level_code=snapshot.svip_level_code,
        )
        rate = _level_role_rate(svip_level, normalized_role)
        if rate is not None:
            rates.append(rate)

    if rates:
        return min(rates)

    return Decimal(str(fallback_rate or 0))


def _load_user_vip_snapshot(db: Session, user_id: int) -> Optional[UserVipSnapshot]:
    return (
        db.query(UserVipSnapshot)
        .filter(UserVipSnapshot.user_id == user_id)
        .first()
    )


def _load_fee_level(db: Session, *, vip_type: str, level_code: str) -> Optional[VipFeeLevel]:
    return (
        db.query(VipFeeLevel)
        .filter(
            VipFeeLevel.vip_type == vip_type,
            VipFeeLevel.level_code == level_code,
            VipFeeLevel.is_enabled.is_(True),
        )
        .order_by(VipFeeLevel.id.asc())
        .first()
    )


def _level_role_rate(level: Optional[VipFeeLevel], role: str) -> Optional[Decimal]:
    if level is None:
        return None

    normalized_role = (role or "").upper().strip()
    if normalized_role == "MAKER":
        rate = level.spot_maker_fee
    else:
        rate = level.spot_taker_fee

    if rate is None:
        return None
    return Decimal(str(rate))


def _load_rcb_discount_rate(db: Session, snapshot: Optional[UserVipSnapshot]) -> Optional[Decimal]:
    if not snapshot or not snapshot.effective_level_code:
        return None

    query = db.query(VipFeeLevel).filter(VipFeeLevel.level_code == snapshot.effective_level_code)
    if snapshot.effective_fee_source:
        query = query.filter(VipFeeLevel.vip_type == snapshot.effective_fee_source)

    level = query.order_by(VipFeeLevel.id.asc()).first()
    if not level or level.rcb_discount_rate is None:
        return None

    discount_rate = Decimal(str(level.rcb_discount_rate or 0))
    # Some historical configs may store "-0.25" to mean a 25% discount.
    return abs(discount_rate)


def _rcb_pay_ratio(discount_rate: Optional[Decimal]) -> Decimal:
    if discount_rate is None:
        return DEFAULT_RCB_PAY_RATIO
    ratio = Decimal("1") - abs(Decimal(str(discount_rate)))
    if ratio <= Decimal("0") or ratio > Decimal("1"):
        return DEFAULT_RCB_PAY_RATIO
    return ratio


def _is_rcb_fee_enabled(db: Session, user_id: int) -> bool:
    preference = (
        db.query(UserFeePreference)
        .filter(UserFeePreference.user_id == user_id)
        .first()
    )
    return bool(preference.use_rcb_fee) if preference else False


def _load_rcb_usdt_price(db: Session, current_pair: TradingPair, trade: Trade) -> Optional[Decimal]:
    current_symbol = (current_pair.symbol or "").upper().strip()
    if current_symbol == "RCBUSDT":
        price = Decimal(str(trade.price or 0))
        return price if price > Decimal("0") else None

    rcb_pair = (
        db.query(TradingPair)
        .filter(TradingPair.symbol == "RCBUSDT")
        .first()
    )
    if not rcb_pair:
        return None

    latest_trade = (
        db.query(Trade)
        .filter(Trade.trading_pair_id == rcb_pair.id)
        .order_by(Trade.id.desc())
        .first()
    )
    if not latest_trade:
        return None

    price = Decimal(str(latest_trade.price or 0))
    return price if price > Decimal("0") else None


def _select_fee_payment(
    db: Session,
    *,
    user_id: int,
    fee_usdt: Decimal,
    snapshot: Optional[UserVipSnapshot],
    current_pair: TradingPair,
    trade: Trade,
    rcb_usdt_price: Optional[Decimal],
) -> tuple[str, Decimal]:
    platform_settings = load_spot_fee_settings(db)
    if not platform_settings.spot_rcb_fee_enabled:
        return USDT_SYMBOL, fee_usdt

    if not _is_rcb_fee_enabled(db, user_id):
        return USDT_SYMBOL, fee_usdt

    price = Decimal(str(rcb_usdt_price or 0)) if rcb_usdt_price is not None else None
    if price is None or price <= Decimal("0"):
        price = _load_rcb_usdt_price(db, current_pair, trade)
    if price is None or price <= Decimal("0"):
        return USDT_SYMBOL, fee_usdt

    discounted_fee_usdt = _q18(fee_usdt * platform_settings.rcb_fee_discount_rate)
    fee_rcb = _q18(discounted_fee_usdt / price)
    if platform_settings.min_rcb_fee_amount > Decimal("0") and fee_rcb < platform_settings.min_rcb_fee_amount:
        fee_rcb = _q18(platform_settings.min_rcb_fee_amount)
    if fee_rcb <= Decimal("0"):
        return USDT_SYMBOL, fee_usdt

    rcb_balance = _get_balance_for_update(
        db,
        user_id=user_id,
        coin_symbol=RCB_SYMBOL,
        auto_create=False,
    )
    if rcb_balance is None:
        return USDT_SYMBOL, fee_usdt

    if Decimal(str(rcb_balance.available_amount or 0)) < fee_rcb:
        return USDT_SYMBOL, fee_usdt

    return RCB_SYMBOL, fee_rcb


def apply_trade_fee(
    db: Session,
    *,
    pair: TradingPair,
    order: Order,
    trade: Trade,
    side: str,
    role: str,
    rcb_usdt_price: Optional[Decimal] = None,
) -> Decimal:
    """Apply spot trade fee after the original trade settlement has completed."""

    snapshot = _load_user_vip_snapshot(db, int(order.user_id))
    fee_rate = _load_user_fee_rate(
        db,
        snapshot=snapshot,
        pair=pair,
        role=role,
    )
    if fee_rate <= Decimal("0"):
        return Decimal("0")

    fee_usdt = _q18(Decimal(str(trade.quote_amount or 0)) * fee_rate)
    if fee_usdt <= Decimal("0"):
        return Decimal("0")

    fee_coin_symbol, fee_amount = _select_fee_payment(
        db,
        user_id=int(order.user_id),
        fee_usdt=fee_usdt,
        snapshot=snapshot,
        current_pair=pair,
        trade=trade,
        rcb_usdt_price=rcb_usdt_price,
    )
    fee_asset_id = _get_asset_id(db, fee_coin_symbol)
    user_balance = _get_balance_for_update(
        db,
        user_id=int(order.user_id),
        coin_symbol=fee_coin_symbol,
        auto_create=False,
    )
    if user_balance is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"fee balance account not found: {fee_coin_symbol}",
        )

    platform_balance = _get_balance_for_update(
        db,
        user_id=PLATFORM_USER_ID,
        coin_symbol=fee_coin_symbol,
        auto_create=True,
    )
    if platform_balance is None:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"platform fee balance account not found: {fee_coin_symbol}",
        )

    user_before_available = Decimal(str(user_balance.available_amount or 0))
    user_before_frozen = Decimal(str(user_balance.frozen_amount or 0))
    platform_before_available = Decimal(str(platform_balance.available_amount or 0))
    platform_before_frozen = Decimal(str(platform_balance.frozen_amount or 0))

    if user_before_available < fee_amount:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"insufficient balance for trade fee: {fee_coin_symbol}",
        )

    user_balance.available_amount = _q18(user_before_available - fee_amount)
    user_balance.version = int(user_balance.version or 0) + 1
    platform_balance.available_amount = _q18(platform_before_available + fee_amount)
    platform_balance.version = int(platform_balance.version or 0) + 1

    order.fee_amount = _q18(Decimal(str(order.fee_amount or 0)) + fee_amount)
    order.fee_asset_id = fee_asset_id
    order.fee_asset_symbol = fee_coin_symbol
    _record_trade_fee_payment(
        trade=trade,
        side=side,
        fee_asset_symbol=fee_coin_symbol,
        fee_amount=fee_amount,
    )

    biz_id = f"{int(trade.id)}:{int(order.id)}:{(side or '').upper()}:{(role or '').upper()}"
    debit_log = _add_balance_log(
        db,
        user_id=int(order.user_id),
        coin_symbol=fee_coin_symbol,
        before_available=user_before_available,
        after_available=user_balance.available_amount,
        before_frozen=user_before_frozen,
        after_frozen=user_before_frozen,
        change_amount=-fee_amount,
        change_type="TRADE_FEE_DEBIT",
        biz_id=biz_id,
        remark="trade fee debit",
    )
    _add_balance_log(
        db,
        user_id=PLATFORM_USER_ID,
        coin_symbol=fee_coin_symbol,
        before_available=platform_before_available,
        after_available=platform_balance.available_amount,
        before_frozen=platform_before_frozen,
        after_frozen=platform_before_frozen,
        change_amount=fee_amount,
        change_type="TRADE_FEE_CREDIT",
        biz_id=biz_id,
        remark="trade fee credit",
    )

    db.add(user_balance)
    db.add(platform_balance)
    db.add(order)
    db.add(trade)
    db.flush()

    commission_source = get_user_commission_source(db, int(order.user_id))
    source_type = str(commission_source.get("source_type") or "")
    if source_type == SOURCE_BD:
        _create_bd_commission_record_if_needed(
            db,
            user_id=int(order.user_id),
            order_id=int(order.id),
            trade_id=int(trade.id),
            trade=trade,
            source_balance_log_id=int(debit_log.id) if debit_log.id is not None else None,
            fee_asset_id=fee_asset_id,
            fee_coin_symbol=fee_coin_symbol,
            fee_amount=fee_amount,
        )
    elif source_type == SOURCE_USER_INVITE:
        create_user_invite_commission_for_fee(
            db,
            invitee_user_id=int(order.user_id),
            order_id=int(order.id),
            trade_id=int(trade.id),
            fee_asset_id=fee_asset_id,
            fee_coin_symbol=fee_coin_symbol,
            fee_amount=fee_amount,
        )
    return fee_amount
