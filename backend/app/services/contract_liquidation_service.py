from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
import logging
from typing import Any, List, Optional
from uuid import uuid4

from sqlalchemy.orm import Session

from app.db.models.contract_account import ContractAccount
from app.db.models.contract_liquidation_record import ContractLiquidationRecord
from app.db.models.contract_order import ContractOrder
from app.db.models.contract_position import ContractPosition
from app.db.models.contract_symbol import ContractSymbol
from app.db.models.contract_trade import ContractTrade
from app.services.contract_balance_log_service import add_contract_balance_log, add_contract_margin_log
from app.services.contract_market_guard import ContractQuoteNotLive, require_executable_contract_quote
from app.services.contract_market_service import get_contract_quote
from app.services.contract_private_ws import publish_contract_user_updates

logger = logging.getLogger(__name__)

LIQUIDATION_GRACE_PERIOD_SECONDS = 10


class ContractLiquidationRiskError(ValueError):
    code = "CONTRACT_LIQUIDATION_RISK_ERROR"


class ContractLiquidationPositionError(ContractLiquidationRiskError):
    code = "INVALID_CONTRACT_POSITION"


class ContractLiquidationNotTriggered(ContractLiquidationRiskError):
    code = "NOT_LIQUIDATABLE"


class ContractLiquidationAlreadyClosed(ContractLiquidationRiskError):
    code = "ALREADY_CLOSED"


class ContractLiquidationAccountError(ContractLiquidationRiskError):
    code = "CONTRACT_ACCOUNT_NOT_FOUND"


@dataclass(frozen=True)
class ContractRiskResult:
    position_id: int
    symbol: str
    side: str
    is_liquidatable: bool
    equity: Decimal
    pnl: Decimal
    mark_price: Decimal
    threshold_amount: Decimal

    def to_dict(self) -> dict[str, Any]:
        return {
            "position_id": self.position_id,
            "symbol": self.symbol,
            "side": self.side,
            "is_liquidatable": self.is_liquidatable,
            "equity": _fmt_decimal(self.equity),
            "pnl": _fmt_decimal(self.pnl),
            "mark_price": _fmt_decimal(self.mark_price),
            "threshold_amount": _fmt_decimal(self.threshold_amount),
        }


@dataclass(frozen=True)
class ContractLiquidationExecutionResult:
    position_id: int
    symbol: str
    status: str
    order_id: Optional[int]
    trade_id: Optional[int]
    liquidation_record_id: Optional[int]
    mark_price: Decimal
    raw_pnl: Decimal
    realized_pnl: Decimal
    released_margin: Decimal
    settlement: Decimal

    def to_dict(self) -> dict[str, Any]:
        return {
            "position_id": self.position_id,
            "symbol": self.symbol,
            "status": self.status,
            "order_id": self.order_id,
            "trade_id": self.trade_id,
            "liquidation_record_id": self.liquidation_record_id,
            "mark_price": _fmt_decimal(self.mark_price),
            "raw_pnl": _fmt_decimal(self.raw_pnl),
            "realized_pnl": _fmt_decimal(self.realized_pnl),
            "released_margin": _fmt_decimal(self.released_margin),
            "settlement": _fmt_decimal(self.settlement),
        }


def _q18(value: Any) -> Decimal:
    if isinstance(value, Decimal):
        return value
    return Decimal(str(value or "0"))


def _fmt_decimal(value: Any) -> str:
    return format(_q18(value), "f")


def _build_order_no(now: datetime) -> str:
    return f"CL{now.strftime('%Y%m%d%H%M%S')}{uuid4().hex[:8].upper()}"


def _build_trade_no(now: datetime) -> str:
    return f"LT{now.strftime('%Y%m%d%H%M%S')}{uuid4().hex[:8].upper()}"


def _get_liquidation_threshold(db: Session, symbol: str) -> Decimal:
    item = db.query(ContractSymbol).filter(ContractSymbol.symbol == symbol).first()
    if item is None:
        return Decimal("0")
    return _q18(item.liquidation_threshold)


def _get_mark_price(db: Session, position: ContractPosition) -> Decimal:
    try:
        quote = get_contract_quote(db, str(position.symbol), log_context="liquidation_scanner")
        mark_price = _q18(quote.get("mark_price"))
        if mark_price > 0:
            return mark_price
    except Exception:
        pass
    return _q18(position.mark_price)


def _is_position_in_liquidation_grace(position: ContractPosition, now: datetime) -> bool:
    opened_at = getattr(position, "opened_at", None) or getattr(position, "created_at", None)
    if opened_at is None:
        return False
    if getattr(opened_at, "tzinfo", None) is not None:
        opened_at = opened_at.replace(tzinfo=None)
    age_seconds = (now - opened_at).total_seconds()
    return age_seconds < LIQUIDATION_GRACE_PERIOD_SECONDS


def _get_live_liquidation_mark_price(db: Session, position: ContractPosition) -> Decimal:
    try:
        quote = get_contract_quote(db, str(position.symbol), log_context="liquidation_scanner")
    except Exception as exc:
        logger.warning(
            "liquidation_skip_quote_unavailable position_id=%s symbol=%s user_id=%s reason=%s error=%s",
            getattr(position, "id", None),
            getattr(position, "symbol", None),
            getattr(position, "user_id", None),
            "LIQUIDATION_QUOTE_UNAVAILABLE",
            exc,
        )
        raise ContractLiquidationNotTriggered("LIQUIDATION_QUOTE_UNAVAILABLE") from exc
    try:
        require_executable_contract_quote(
            quote,
            context="liquidation_scanner",
            symbol=str(position.symbol),
            position_id=getattr(position, "id", None),
            user_id=getattr(position, "user_id", None),
        )
    except ContractQuoteNotLive as exc:
        logger.warning(
            "liquidation_skip_non_live_quote position_id=%s symbol=%s user_id=%s source=%s "
            "quote_freshness=%s reason=%s",
            getattr(position, "id", None),
            getattr(position, "symbol", None),
            getattr(position, "user_id", None),
            quote.get("source"),
            quote.get("quote_freshness"),
            "LIQUIDATION_QUOTE_NOT_LIVE",
        )
        raise ContractLiquidationNotTriggered("LIQUIDATION_QUOTE_NOT_LIVE") from exc

    mark_price = _q18(quote.get("mark_price"))
    if mark_price <= 0:
        logger.warning(
            "liquidation_skip_invalid_mark_price position_id=%s symbol=%s user_id=%s source=%s "
            "quote_freshness=%s mark_price=%s reason=%s",
            getattr(position, "id", None),
            getattr(position, "symbol", None),
            getattr(position, "user_id", None),
            quote.get("source"),
            quote.get("quote_freshness"),
            quote.get("mark_price"),
            "LIQUIDATION_MARK_PRICE_UNAVAILABLE",
        )
        raise ContractLiquidationNotTriggered("LIQUIDATION_MARK_PRICE_UNAVAILABLE")
    return mark_price


def _calculate_position_pnl(
    *,
    side: str,
    entry_price: Decimal,
    mark_price: Decimal,
    quantity: Decimal,
) -> Decimal:
    if side == "LONG":
        return (mark_price - entry_price) * quantity
    if side == "SHORT":
        return (entry_price - mark_price) * quantity
    raise ContractLiquidationPositionError("INVALID_POSITION_SIDE")


def _risk_from_mark_price(db: Session, position: ContractPosition, mark_price: Decimal) -> ContractRiskResult:
    if position is None or str(position.status or "").upper() != "OPEN":
        raise ContractLiquidationPositionError("POSITION_NOT_OPEN")

    side = str(position.side or "").upper()
    quantity = _q18(position.quantity)
    margin_amount = _q18(position.margin_amount)
    entry_price = _q18(position.entry_price)
    if quantity <= 0 or margin_amount <= 0 or entry_price <= 0 or mark_price <= 0:
        raise ContractLiquidationPositionError("INVALID_POSITION_RISK_DATA")

    pnl = _calculate_position_pnl(
        side=side,
        entry_price=entry_price,
        mark_price=mark_price,
        quantity=quantity,
    )
    equity = margin_amount + pnl
    liquidation_threshold = _get_liquidation_threshold(db, str(position.symbol))
    threshold_amount = margin_amount * liquidation_threshold
    return ContractRiskResult(
        position_id=int(position.id),
        symbol=str(position.symbol),
        side=side,
        is_liquidatable=equity <= threshold_amount,
        equity=equity,
        pnl=pnl,
        mark_price=mark_price,
        threshold_amount=threshold_amount,
    )


def check_position_risk(db: Session, position: ContractPosition) -> ContractRiskResult:
    if position is None or str(position.status or "").upper() != "OPEN":
        raise ContractLiquidationPositionError("POSITION_NOT_OPEN")

    side = str(position.side or "").upper()
    if side not in {"LONG", "SHORT"}:
        raise ContractLiquidationPositionError("INVALID_POSITION_SIDE")

    quantity = _q18(position.quantity)
    margin_amount = _q18(position.margin_amount)
    entry_price = _q18(position.entry_price)
    mark_price = _get_mark_price(db, position)
    if quantity <= 0 or margin_amount <= 0 or entry_price <= 0 or mark_price <= 0:
        raise ContractLiquidationPositionError("INVALID_POSITION_RISK_DATA")

    pnl = _calculate_position_pnl(
        side=side,
        entry_price=entry_price,
        mark_price=mark_price,
        quantity=quantity,
    )

    equity = margin_amount + pnl
    liquidation_threshold = _get_liquidation_threshold(db, str(position.symbol))
    threshold_amount = margin_amount * liquidation_threshold
    is_liquidatable = equity <= threshold_amount

    return ContractRiskResult(
        position_id=int(position.id),
        symbol=str(position.symbol),
        side=side,
        is_liquidatable=is_liquidatable,
        equity=equity,
        pnl=pnl,
        mark_price=mark_price,
        threshold_amount=threshold_amount,
    )


def _has_triggered_liquidation_record(db: Session, position_id: int) -> bool:
    return (
        db.query(ContractLiquidationRecord.id)
        .filter(ContractLiquidationRecord.position_id == int(position_id))
        .filter(ContractLiquidationRecord.status == "TRIGGERED")
        .first()
        is not None
    )


def _create_triggered_liquidation_record(
    db: Session,
    *,
    position: ContractPosition,
    risk: ContractRiskResult,
    now: datetime,
) -> None:
    if _has_triggered_liquidation_record(db, int(position.id)):
        return

    remaining_amount = risk.equity
    if remaining_amount < Decimal("0"):
        remaining_amount = Decimal("0")

    db.add(
        ContractLiquidationRecord(
            user_id=int(position.user_id),
            position_id=int(position.id),
            symbol=str(position.symbol),
            side=str(position.side),
            leverage=int(position.leverage),
            quantity=_q18(position.quantity),
            entry_price=_q18(position.entry_price),
            mark_price=risk.mark_price,
            liquidation_price=_q18(position.liquidation_price),
            margin_amount=_q18(position.margin_amount),
            unrealized_pnl=risk.pnl,
            remaining_amount=remaining_amount,
            status="TRIGGERED",
            created_at=now,
            updated_at=now,
        )
    )


def scan_positions_for_liquidation(db: Session, limit: int = 100) -> List[ContractRiskResult]:
    limit = max(1, min(int(limit or 100), 1000))
    now = datetime.utcnow()
    triggered: List[ContractRiskResult] = []

    positions = (
        db.query(ContractPosition)
        .filter(ContractPosition.status == "OPEN")
        .order_by(ContractPosition.id.asc())
        .limit(limit)
        .all()
    )

    for position in positions:
        if _is_position_in_liquidation_grace(position, now):
            logger.warning(
                "liquidation_skip_grace_period position_id=%s symbol=%s user_id=%s opened_at=%s "
                "grace_seconds=%s reason=%s",
                getattr(position, "id", None),
                getattr(position, "symbol", None),
                getattr(position, "user_id", None),
                getattr(position, "opened_at", None),
                LIQUIDATION_GRACE_PERIOD_SECONDS,
                "LIQUIDATION_GRACE_PERIOD",
            )
            continue
        try:
            mark_price = _get_live_liquidation_mark_price(db, position)
            risk = _risk_from_mark_price(db, position, mark_price)
        except ContractLiquidationNotTriggered:
            continue
        position.last_risk_check_at = now
        position.is_liquidatable = bool(risk.is_liquidatable)
        position.updated_at = now
        if risk.is_liquidatable:
            triggered.append(risk)
            _create_triggered_liquidation_record(db, position=position, risk=risk, now=now)

    db.commit()
    return triggered


def _lock_open_position(db: Session, position_id: int) -> ContractPosition:
    position = (
        db.query(ContractPosition)
        .filter(ContractPosition.id == int(position_id))
        .with_for_update()
        .first()
    )
    if position is None:
        raise ContractLiquidationPositionError("POSITION_NOT_FOUND")
    if str(position.status or "").upper() != "OPEN" or _q18(position.quantity) <= 0:
        raise ContractLiquidationAlreadyClosed("ALREADY_CLOSED")
    return position


def _lock_contract_account(db: Session, *, user_id: int, margin_asset: str = "USDT") -> ContractAccount:
    account = (
        db.query(ContractAccount)
        .filter(ContractAccount.user_id == int(user_id))
        .filter(ContractAccount.margin_asset == margin_asset)
        .with_for_update()
        .first()
    )
    if account is None:
        raise ContractLiquidationAccountError("CONTRACT_ACCOUNT_NOT_FOUND")
    return account


def _get_done_liquidation_record(db: Session, position_id: int) -> Optional[ContractLiquidationRecord]:
    return (
        db.query(ContractLiquidationRecord)
        .filter(ContractLiquidationRecord.position_id == int(position_id))
        .filter(ContractLiquidationRecord.status == "DONE")
        .with_for_update()
        .first()
    )


def _get_triggered_liquidation_record(db: Session, position_id: int) -> Optional[ContractLiquidationRecord]:
    return (
        db.query(ContractLiquidationRecord)
        .filter(ContractLiquidationRecord.position_id == int(position_id))
        .filter(ContractLiquidationRecord.status == "TRIGGERED")
        .order_by(ContractLiquidationRecord.id.asc())
        .with_for_update()
        .first()
    )


def _upsert_done_liquidation_record(
    db: Session,
    *,
    position: ContractPosition,
    risk: ContractRiskResult,
    realized_pnl: Decimal,
    settlement: Decimal,
    now: datetime,
) -> ContractLiquidationRecord:
    record = _get_triggered_liquidation_record(db, int(position.id))
    if record is None:
        record = ContractLiquidationRecord(
            user_id=int(position.user_id),
            position_id=int(position.id),
            symbol=str(position.symbol),
            side=str(position.side),
            leverage=int(position.leverage),
            quantity=Decimal("0"),
            entry_price=Decimal("0"),
            mark_price=Decimal("0"),
            liquidation_price=Decimal("0"),
            margin_amount=Decimal("0"),
            unrealized_pnl=Decimal("0"),
            remaining_amount=Decimal("0"),
            status="DONE",
            created_at=now,
            updated_at=now,
        )
        db.add(record)

    record.user_id = int(position.user_id)
    record.symbol = str(position.symbol)
    record.side = str(position.side)
    record.leverage = int(position.leverage)
    record.quantity = _q18(position.quantity)
    record.entry_price = _q18(position.entry_price)
    record.mark_price = risk.mark_price
    record.liquidation_price = risk.mark_price
    record.margin_amount = _q18(position.margin_amount)
    record.unrealized_pnl = realized_pnl
    record.remaining_amount = settlement
    record.status = "DONE"
    record.updated_at = now
    db.flush()
    return record


def execute_liquidation(db: Session, position_id: int) -> ContractLiquidationExecutionResult:
    initial_position = db.query(ContractPosition).filter(ContractPosition.id == int(position_id)).first()
    if initial_position is None:
        raise ContractLiquidationPositionError("POSITION_NOT_FOUND")
    if str(initial_position.status or "").upper() != "OPEN" or _q18(initial_position.quantity) <= 0:
        raise ContractLiquidationAlreadyClosed("ALREADY_CLOSED")

    now = datetime.utcnow()
    if _is_position_in_liquidation_grace(initial_position, now):
        logger.warning(
            "liquidation_skip_grace_period position_id=%s symbol=%s user_id=%s opened_at=%s "
            "grace_seconds=%s reason=%s",
            getattr(initial_position, "id", None),
            getattr(initial_position, "symbol", None),
            getattr(initial_position, "user_id", None),
            getattr(initial_position, "opened_at", None),
            LIQUIDATION_GRACE_PERIOD_SECONDS,
            "LIQUIDATION_GRACE_PERIOD",
        )
        raise ContractLiquidationNotTriggered("LIQUIDATION_GRACE_PERIOD")

    mark_price = _get_live_liquidation_mark_price(db, initial_position)

    position = _lock_open_position(db, int(position_id))
    if _get_done_liquidation_record(db, int(position.id)) is not None:
        raise ContractLiquidationAlreadyClosed("ALREADY_CLOSED")

    account = _lock_contract_account(db, user_id=int(position.user_id), margin_asset="USDT")
    risk = _risk_from_mark_price(db, position, mark_price)
    if not risk.is_liquidatable:
        db.rollback()
        raise ContractLiquidationNotTriggered("NOT_LIQUIDATABLE")

    position.last_risk_check_at = now
    position.is_liquidatable = True

    released_margin = _q18(position.margin_amount)
    quantity = _q18(position.quantity)
    raw_pnl = risk.pnl
    realized_pnl = raw_pnl
    if realized_pnl < -released_margin:
        realized_pnl = -released_margin

    settlement = released_margin + realized_pnl
    if settlement < Decimal("0"):
        settlement = Decimal("0")

    before_available = _q18(account.available_margin)
    before_frozen = _q18(account.frozen_margin)
    before_position_margin = _q18(account.position_margin)
    after_available = before_available + settlement
    after_position_margin = before_position_margin - released_margin
    if after_position_margin < Decimal("0"):
        after_position_margin = Decimal("0")

    order_side = "SELL" if str(position.side).upper() == "LONG" else "BUY"
    order = ContractOrder(
        order_no=_build_order_no(now),
        user_id=int(position.user_id),
        position_id=int(position.id),
        symbol=str(position.symbol),
        side=order_side,
        position_side=str(position.side).upper(),
        action="CLOSE",
        order_type="MARKET",
        price=None,
        quantity=quantity,
        leverage=int(position.leverage),
        margin_amount=released_margin,
        fee_amount=Decimal("0"),
        spread_x_snapshot=Decimal("0"),
        spread_fee=Decimal("0"),
        trigger_price=None,
        filled_quantity=quantity,
        avg_price=risk.mark_price,
        status="FILLED",
        fail_reason="LIQUIDATION",
        created_at=now,
        updated_at=now,
    )
    db.add(order)
    db.flush()

    trade = ContractTrade(
        trade_no=_build_trade_no(now),
        order_id=int(order.id),
        position_id=int(position.id),
        user_id=int(position.user_id),
        symbol=str(position.symbol),
        side=order_side,
        position_side=str(position.side).upper(),
        action="CLOSE",
        price=risk.mark_price,
        quantity=quantity,
        notional=risk.mark_price * quantity,
        leverage=int(position.leverage),
        margin_amount=released_margin,
        fee_amount=Decimal("0"),
        spread_fee=Decimal("0"),
        realized_pnl=realized_pnl,
        created_at=now,
    )
    db.add(trade)
    db.flush()

    record = _upsert_done_liquidation_record(
        db,
        position=position,
        risk=risk,
        realized_pnl=realized_pnl,
        settlement=settlement,
        now=now,
    )

    account.available_margin = after_available
    account.position_margin = after_position_margin
    account.realized_pnl = _q18(account.realized_pnl) + realized_pnl
    account.version = int(account.version or 0) + 1
    account.updated_at = now

    before_position_realized = _q18(position.realized_pnl)
    position.status = "LIQUIDATED"
    position.quantity = Decimal("0")
    position.margin_amount = Decimal("0")
    position.realized_pnl = before_position_realized + realized_pnl
    position.unrealized_pnl = Decimal("0")
    position.mark_price = risk.mark_price
    position.close_reason = "LIQUIDATION"
    position.closed_at = now
    position.updated_at = now

    conceptual_after_release = before_available + released_margin
    trade_id = int(trade.id)
    add_contract_margin_log(
        db,
        user_id=int(position.user_id),
        account_id=int(account.id),
        position_id=int(position.id),
        order_id=int(order.id),
        trade_id=trade_id,
        symbol=str(position.symbol),
        change_type="CLOSE_RELEASE",
        change_amount=released_margin,
        before_available=before_available,
        after_available=conceptual_after_release,
        before_frozen=before_frozen,
        after_frozen=before_frozen,
        remark="liquidation margin release",
        now=now,
    )
    add_contract_balance_log(
        db,
        user_id=int(position.user_id),
        change_type="CONTRACT_MARGIN_RELEASE",
        biz_type="CONTRACT_MARGIN_RELEASE",
        biz_id=f"liquidation:{int(record.id)}:margin_release",
        change_amount=released_margin,
        trade_id=trade_id,
        before_available=before_available,
        after_available=conceptual_after_release,
        before_frozen=before_frozen,
        after_frozen=before_frozen,
        remark="liquidation margin release",
        now=now,
    )
    add_contract_margin_log(
        db,
        user_id=int(position.user_id),
        account_id=int(account.id),
        position_id=int(position.id),
        order_id=int(order.id),
        trade_id=trade_id,
        symbol=str(position.symbol),
        change_type="REALIZED_PNL",
        change_amount=realized_pnl,
        before_available=conceptual_after_release,
        after_available=after_available,
        before_frozen=before_frozen,
        after_frozen=before_frozen,
        remark="liquidation realized pnl capped by margin" if realized_pnl != raw_pnl else "liquidation realized pnl",
        now=now,
    )
    add_contract_balance_log(
        db,
        user_id=int(position.user_id),
        change_type="CONTRACT_LIQUIDATION",
        biz_type="CONTRACT_LIQUIDATION",
        biz_id=f"liquidation:{int(record.id)}:realized_pnl",
        change_amount=realized_pnl,
        trade_id=trade_id,
        before_available=conceptual_after_release,
        after_available=after_available,
        before_frozen=before_frozen,
        after_frozen=before_frozen,
        remark=(
            "liquidation realized pnl capped by margin"
            if realized_pnl != raw_pnl
            else "liquidation realized pnl"
        ),
        now=now,
    )
    if settlement == Decimal("0"):
        add_contract_margin_log(
            db,
            user_id=int(position.user_id),
            account_id=int(account.id),
            position_id=int(position.id),
            order_id=int(order.id),
            trade_id=trade_id,
            symbol=str(position.symbol),
            change_type="LIQUIDATION_ZERO",
            change_amount=released_margin,
            before_available=after_available,
            after_available=after_available,
            before_frozen=before_frozen,
            after_frozen=before_frozen,
            remark="liquidation position balance zeroed",
            now=now,
        )

    db.commit()
    publish_contract_user_updates(
        user_id=int(position.user_id),
        symbols=[str(position.symbol)],
        position_ids=[int(position.id)],
        order_ids=[int(order.id)],
        trade_ids=[int(trade.id)],
        include_account=True,
    )
    return ContractLiquidationExecutionResult(
        position_id=int(position.id),
        symbol=str(position.symbol),
        status="DONE",
        order_id=int(order.id),
        trade_id=int(trade.id),
        liquidation_record_id=int(record.id),
        mark_price=risk.mark_price,
        raw_pnl=raw_pnl,
        realized_pnl=realized_pnl,
        released_margin=released_margin,
        settlement=settlement,
    )


def scan_and_execute_liquidations(db: Session, limit: int = 50) -> List[ContractLiquidationExecutionResult]:
    limit = max(1, min(int(limit or 50), 500))
    results: List[ContractLiquidationExecutionResult] = []
    candidates = (
        db.query(ContractPosition.id)
        .filter(ContractPosition.status == "OPEN")
        .filter(ContractPosition.quantity > 0)
        .order_by(ContractPosition.is_liquidatable.desc(), ContractPosition.id.asc())
        .limit(limit)
        .all()
    )

    for row in candidates:
        try:
            results.append(execute_liquidation(db, int(row[0])))
        except (ContractLiquidationNotTriggered, ContractLiquidationAlreadyClosed):
            db.rollback()
            continue

    return results
