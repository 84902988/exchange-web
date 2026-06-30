from __future__ import annotations

import logging
import time
from collections import Counter, defaultdict
from dataclasses import dataclass
from decimal import Decimal
from typing import Any, Dict, List, Optional

from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.db.models.contract_position import ContractPosition
from app.db.models.contract_symbol import ContractSymbol
from app.db.models.contract_trade import ContractTrade
from app.schemas.contract_order import ContractCloseOrderRequest
from app.services.contract_liquidation_service import _risk_from_mark_price
from app.services.contract_market_guard import ContractQuoteNotLive
from app.services.contract_market_service import get_executable_contract_quote
from app.services.contract_order_service import (
    ContractOrderError,
    ContractPositionNotOpen,
    close_contract_position,
)
from app.services.contract_private_ws import publish_contract_user_updates

logger = logging.getLogger(__name__)
TP_SL_TRIGGER_MARK_PRICE = "MARK_PRICE"
TP_SL_TRIGGER_LAST_PRICE = "LAST_PRICE"
TP_SL_TRIGGER_PRICE_TYPES = {TP_SL_TRIGGER_MARK_PRICE, TP_SL_TRIGGER_LAST_PRICE}
DEFAULT_TP_SL_TRIGGER_PRICE_TYPE = TP_SL_TRIGGER_MARK_PRICE
_TP_SL_SCAN_LOG_COOLDOWN_SECONDS = 60
_tp_sl_scan_log_last_at: dict[tuple[str, str, str], float] = {}


class ContractTpSlError(ValueError):
    code = "CONTRACT_TP_SL_ERROR"


class ContractTpSlNotTriggered(ContractTpSlError):
    code = "TP_SL_NOT_TRIGGERED"


class ContractTpSlSkippedLiquidation(ContractTpSlError):
    code = "POSITION_LIQUIDATION_PRIORITY"


class ContractTpSlPositionError(ContractTpSlError):
    code = "INVALID_CONTRACT_POSITION"


@dataclass(frozen=True)
class ContractTpSlExecutionResult:
    position_id: int
    symbol: str
    trigger_type: str
    mark_price: Decimal
    order_id: int
    status: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "position_id": self.position_id,
            "symbol": self.symbol,
            "trigger_type": self.trigger_type,
            "mark_price": _fmt_decimal(self.mark_price),
            "order_id": self.order_id,
            "status": self.status,
        }


def _q18(value: Any) -> Decimal:
    if isinstance(value, Decimal):
        return value
    return Decimal(str(value or "0"))


def _fmt_decimal(value: Any) -> str:
    return format(_q18(value), "f")


def normalize_tp_sl_trigger_price_type(value: Any) -> str:
    normalized = str(value or "").strip().upper()
    if normalized in TP_SL_TRIGGER_PRICE_TYPES:
        return normalized
    return DEFAULT_TP_SL_TRIGGER_PRICE_TYPE


def _position_tp_sl_trigger_price_type(db: Session, position: ContractPosition) -> str:
    symbol = str(getattr(position, "symbol", "") or "").strip().upper()
    if not symbol:
        return DEFAULT_TP_SL_TRIGGER_PRICE_TYPE
    item = (
        db.query(ContractSymbol.tp_sl_trigger_price_type)
        .filter(ContractSymbol.symbol == symbol)
        .first()
    )
    return normalize_tp_sl_trigger_price_type(item[0] if item else None)


def _quote_last_price(quote: dict[str, Any]) -> Decimal:
    last_price = _q18(quote.get("last_price"))
    if last_price > 0:
        return last_price
    return _q18(quote.get("price"))


def _quote_bid_ask_mid_price(quote: dict[str, Any]) -> Decimal:
    bid_price = _q18(quote.get("bid_price"))
    ask_price = _q18(quote.get("ask_price"))
    if bid_price > 0 and ask_price > 0:
        return (bid_price + ask_price) / Decimal("2")
    return Decimal("0")


def _is_last_price_detached_from_quote(quote: dict[str, Any], last_price: Decimal, mark_price: Decimal) -> bool:
    if last_price <= 0:
        return False
    reference_price = _quote_bid_ask_mid_price(quote)
    if reference_price <= 0:
        reference_price = mark_price
    if reference_price <= 0:
        return False
    tolerance = max(reference_price * Decimal("0.05"), Decimal("0.00000001"))
    return abs(last_price - reference_price) > tolerance


def _tp_sl_trigger_price_from_quote(
    quote: dict[str, Any],
    mark_price: Decimal,
    trigger_price_type: str,
    *,
    symbol: Any = None,
) -> tuple[Decimal, bool]:
    normalized_type = normalize_tp_sl_trigger_price_type(trigger_price_type)
    if normalized_type == TP_SL_TRIGGER_LAST_PRICE:
        last_price = _quote_last_price(quote)
        if last_price > 0:
            if _is_last_price_detached_from_quote(quote, last_price, mark_price):
                fallback_price = mark_price if mark_price > 0 else _quote_bid_ask_mid_price(quote)
                if fallback_price > 0:
                    _log_detached_last_price_fallback(
                        symbol=symbol,
                        last_price=last_price,
                        fallback_price=fallback_price,
                    )
                    return fallback_price, True
            return last_price, False
        _log_last_price_fallback(symbol=symbol, mark_price=mark_price)
    return mark_price, normalized_type == TP_SL_TRIGGER_LAST_PRICE


def _log_detached_last_price_fallback(*, symbol: Any, last_price: Decimal, fallback_price: Decimal) -> None:
    normalized_symbol = str(symbol or "").strip().upper() or "-"
    key = ("detached_last_price_fallback", normalized_symbol, "")
    now = time.monotonic()
    last_at = _tp_sl_scan_log_last_at.get(key)
    if last_at is not None and now - last_at < _TP_SL_SCAN_LOG_COOLDOWN_SECONDS:
        return
    _tp_sl_scan_log_last_at[key] = now
    logger.warning(
        "contract_tp_sl_last_price_detached_fallback symbol=%s trigger_price_type=%s last_price=%s fallback_price=%s",
        normalized_symbol,
        TP_SL_TRIGGER_LAST_PRICE,
        _fmt_decimal(last_price),
        _fmt_decimal(fallback_price),
    )


def _log_last_price_fallback(*, symbol: Any, mark_price: Decimal) -> None:
    normalized_symbol = str(symbol or "").strip().upper() or "-"
    key = ("last_price_fallback", normalized_symbol, "")
    now = time.monotonic()
    last_at = _tp_sl_scan_log_last_at.get(key)
    if last_at is not None and now - last_at < _TP_SL_SCAN_LOG_COOLDOWN_SECONDS:
        return
    _tp_sl_scan_log_last_at[key] = now
    logger.warning(
        "contract_tp_sl_last_price_missing_fallback symbol=%s trigger_price_type=%s fallback_mark_price=%s",
        normalized_symbol,
        TP_SL_TRIGGER_LAST_PRICE,
        _fmt_decimal(mark_price),
    )


def _error_code(exc: BaseException) -> str:
    return str(str(exc) or getattr(exc, "code", "") or exc.__class__.__name__).strip()[:120]


def _log_scan_symbol(
    *,
    level: int,
    event: str,
    symbol: str,
    trigger_price_type: str,
    trigger_price: Any,
    mark_price: Any,
    last_price: Any,
    open_positions_count: int,
    triggered_count: int,
    skipped_reasons: Dict[str, int],
) -> None:
    normalized_symbol = str(symbol or "").strip().upper() or "-"
    reason_text = ",".join(f"{reason}:{count}" for reason, count in sorted(skipped_reasons.items())) or "-"
    key = (event, normalized_symbol, reason_text if level >= logging.WARNING else "")
    now = time.monotonic()
    last_at = _tp_sl_scan_log_last_at.get(key)
    if last_at is not None and now - last_at < _TP_SL_SCAN_LOG_COOLDOWN_SECONDS:
        return
    _tp_sl_scan_log_last_at[key] = now
    logger.log(
        level,
        "contract_tp_sl_scan_symbol event=%s symbol=%s trigger_price_type=%s trigger_price=%s mark_price=%s last_price=%s open_positions=%s triggered=%s skipped=%s",
        event,
        normalized_symbol,
        normalize_tp_sl_trigger_price_type(trigger_price_type),
        _fmt_decimal(trigger_price) if trigger_price is not None else "-",
        _fmt_decimal(mark_price) if mark_price is not None else "-",
        _fmt_decimal(last_price) if last_price is not None else "-",
        open_positions_count,
        triggered_count,
        reason_text,
    )


def _log_scan_position_decision(
    *,
    level: int,
    event: str,
    position: ContractPosition,
    trigger_price_type: str,
    trigger_price: Any,
    mark_price: Any,
    last_price: Any,
    quote: Optional[dict[str, Any]],
    decision: str,
    reason: str = "-",
) -> None:
    position_id = str(getattr(position, "id", "") or "-")
    normalized_symbol = str(getattr(position, "symbol", "") or "").strip().upper() or "-"
    normalized_event = str(event or "decision")
    normalized_decision = str(decision or "none")
    normalized_reason = str(reason or "-")
    key = (normalized_event, normalized_symbol, position_id)
    now = time.monotonic()
    last_at = _tp_sl_scan_log_last_at.get(key)
    if level <= logging.DEBUG and last_at is not None and now - last_at < _TP_SL_SCAN_LOG_COOLDOWN_SECONDS:
        return
    _tp_sl_scan_log_last_at[key] = now
    logger.log(
        level,
        "contract_tp_sl_scan_position event=%s position_id=%s symbol=%s user_id=%s side=%s status=%s "
        "quantity=%s trigger_price_type=%s trigger_price=%s mark_price=%s last_price=%s bid_price=%s ask_price=%s "
        "take_profit_price=%s stop_loss_price=%s decision=%s reason=%s quote_source=%s quote_freshness=%s",
        normalized_event,
        getattr(position, "id", None),
        normalized_symbol,
        getattr(position, "user_id", None),
        getattr(position, "side", None),
        getattr(position, "status", None),
        _fmt_decimal(getattr(position, "quantity", None)),
        normalize_tp_sl_trigger_price_type(trigger_price_type),
        _fmt_decimal(trigger_price) if trigger_price is not None else "-",
        _fmt_decimal(mark_price) if mark_price is not None else "-",
        _fmt_decimal(last_price) if last_price is not None else "-",
        quote.get("bid_price") if quote else None,
        quote.get("ask_price") if quote else None,
        _fmt_decimal(position.take_profit_price) if position.take_profit_price is not None else "-",
        _fmt_decimal(position.stop_loss_price) if position.stop_loss_price is not None else "-",
        normalized_decision,
        normalized_reason,
        quote.get("source") if quote else None,
        quote.get("quote_freshness") if quote else None,
    )


def _normalize_position_side(value: Any) -> str:
    normalized = str(value or "").strip().upper()
    if normalized in {"LONG", "SHORT"}:
        return normalized
    if normalized in {"多", "多仓", "平多"}:
        return "LONG"
    if normalized in {"空", "空仓", "平空"}:
        return "SHORT"
    return normalized


def _get_executable_tp_sl_quote(db: Session, position: ContractPosition) -> dict[str, Any]:
    quote: Optional[dict[str, Any]] = None
    try:
        quote = get_executable_contract_quote(
            db,
            str(position.symbol),
            context="tp_sl_scanner",
            position_id=getattr(position, "id", None),
            user_id=getattr(position, "user_id", None),
            log_context="tp_sl_scanner",
        )
    except ContractQuoteNotLive as exc:
        logger.warning(
            "contract_tp_sl_quote_not_live position_id=%s symbol=%s user_id=%s source=%s "
            "quote_freshness=%s bid_price=%s ask_price=%s last_price=%s mark_price=%s reason=%s",
            getattr(position, "id", None),
            getattr(position, "symbol", None),
            getattr(position, "user_id", None),
            quote.get("source") if quote else None,
            quote.get("quote_freshness") if quote else None,
            quote.get("bid_price") if quote else None,
            quote.get("ask_price") if quote else None,
            quote.get("last_price") if quote else None,
            quote.get("mark_price") if quote else None,
            "CONTRACT_QUOTE_NOT_LIVE",
        )
        raise ContractTpSlNotTriggered("CONTRACT_QUOTE_NOT_LIVE") from exc
    except Exception as exc:
        logger.warning(
            "contract_tp_sl_quote_unavailable position_id=%s symbol=%s user_id=%s reason=%s error=%s",
            getattr(position, "id", None),
            getattr(position, "symbol", None),
            getattr(position, "user_id", None),
            "CONTRACT_QUOTE_UNAVAILABLE",
            exc,
        )
        raise ContractTpSlNotTriggered("CONTRACT_QUOTE_UNAVAILABLE") from exc
    return quote


def _detect_tp_sl_trigger(position: ContractPosition, trigger_price: Decimal) -> Optional[str]:
    side = _normalize_position_side(position.side)
    take_profit_price = _q18(position.take_profit_price) if position.take_profit_price is not None else None
    stop_loss_price = _q18(position.stop_loss_price) if position.stop_loss_price is not None else None

    if trigger_price <= 0 or side not in {"LONG", "SHORT"}:
        return None

    if side == "LONG":
        if stop_loss_price is not None and stop_loss_price > 0 and trigger_price <= stop_loss_price:
            return "STOP_LOSS"
        if take_profit_price is not None and take_profit_price > 0 and trigger_price >= take_profit_price:
            return "TAKE_PROFIT"
        return None

    if stop_loss_price is not None and stop_loss_price > 0 and trigger_price >= stop_loss_price:
        return "STOP_LOSS"
    if take_profit_price is not None and take_profit_price > 0 and trigger_price <= take_profit_price:
        return "TAKE_PROFIT"
    return None


def execute_contract_tp_sl(
    db: Session,
    position_id: int,
    *,
    quote_override: Optional[dict[str, Any]] = None,
    trigger_price_type_override: Optional[str] = None,
) -> ContractTpSlExecutionResult:
    position = db.query(ContractPosition).filter(ContractPosition.id == int(position_id)).first()
    if position is None:
        raise ContractTpSlPositionError("POSITION_NOT_FOUND")
    if str(position.status or "").upper() != "OPEN" or _q18(position.quantity) <= 0:
        raise ContractPositionNotOpen("POSITION_NOT_OPEN")

    quote = quote_override or _get_executable_tp_sl_quote(db, position)
    mark_price = _q18(quote.get("mark_price"))
    if mark_price <= 0:
        raise ContractTpSlNotTriggered("CONTRACT_MARK_PRICE_UNAVAILABLE")

    position = (
        db.query(ContractPosition)
        .filter(ContractPosition.id == int(position_id))
        .with_for_update()
        .first()
    )
    if position is None:
        raise ContractTpSlPositionError("POSITION_NOT_FOUND")
    if str(position.status or "").upper() != "OPEN" or _q18(position.quantity) <= 0:
        raise ContractPositionNotOpen("POSITION_NOT_OPEN")

    risk = _risk_from_mark_price(db, position, mark_price)
    if risk.is_liquidatable:
        raise ContractTpSlSkippedLiquidation("POSITION_LIQUIDATION_PRIORITY")

    trigger_price_type = normalize_tp_sl_trigger_price_type(
        trigger_price_type_override or _position_tp_sl_trigger_price_type(db, position)
    )
    trigger_price, _ = _tp_sl_trigger_price_from_quote(
        quote,
        mark_price,
        trigger_price_type,
        symbol=position.symbol,
    )
    last_price = _quote_last_price(quote)
    trigger_type = _detect_tp_sl_trigger(position, trigger_price)
    if trigger_type is None:
        _log_scan_position_decision(
            level=logging.DEBUG,
            event="decision",
            position=position,
            trigger_price_type=trigger_price_type,
            trigger_price=trigger_price,
            mark_price=mark_price,
            last_price=last_price,
            quote=quote,
            decision="none",
            reason="TP_SL_NOT_TRIGGERED",
        )
        raise ContractTpSlNotTriggered("TP_SL_NOT_TRIGGERED")

    _log_scan_position_decision(
        level=logging.INFO,
        event="hit",
        position=position,
        trigger_price_type=trigger_price_type,
        trigger_price=trigger_price,
        mark_price=mark_price,
        last_price=last_price,
        quote=quote,
        decision=trigger_type,
    )
    logger.info(
        "contract_tp_sl_trigger_detected position_id=%s symbol=%s user_id=%s side=%s "
        "trigger_type=%s trigger_price_type=%s trigger_price=%s mark_price=%s last_price=%s "
        "take_profit_price=%s stop_loss_price=%s quote_source=%s quote_freshness=%s",
        getattr(position, "id", None),
        getattr(position, "symbol", None),
        getattr(position, "user_id", None),
        getattr(position, "side", None),
        trigger_type,
        trigger_price_type,
        _fmt_decimal(trigger_price),
        _fmt_decimal(mark_price),
        _fmt_decimal(last_price),
        _fmt_decimal(position.take_profit_price) if position.take_profit_price is not None else "-",
        _fmt_decimal(position.stop_loss_price) if position.stop_loss_price is not None else "-",
        quote.get("source"),
        quote.get("quote_freshness"),
    )

    try:
        response = close_contract_position(
            db,
            int(position.user_id),
            ContractCloseOrderRequest(
                position_id=int(position.id),
                order_type="MARKET",
                price=None,
                quantity=None,
            ),
            close_reason=trigger_type,
            quote_override=quote,
        )
    except ContractOrderError as exc:
        _log_scan_position_decision(
            level=logging.WARNING,
            event="close_failed",
            position=position,
            trigger_price_type=trigger_price_type,
            trigger_price=trigger_price,
            mark_price=mark_price,
            last_price=last_price,
            quote=quote,
            decision=trigger_type,
            reason=_error_code(exc),
        )
        raise
    close_trade = (
        db.query(ContractTrade)
        .filter(ContractTrade.order_id == int(response.order_id))
        .order_by(ContractTrade.id.desc())
        .first()
    )
    closed_position = db.query(ContractPosition).filter(ContractPosition.id == int(position.id)).first()
    logger.info(
        "contract_tp_sl_close_succeeded position_id=%s symbol=%s user_id=%s trigger_type=%s "
        "trigger_price_type=%s trigger_price=%s close_order_id=%s trade_id=%s status=%s closed_at=%s",
        getattr(position, "id", None),
        getattr(position, "symbol", None),
        getattr(position, "user_id", None),
        trigger_type,
        trigger_price_type,
        _fmt_decimal(trigger_price),
        response.order_id,
        getattr(close_trade, "id", None),
        response.status,
        getattr(closed_position, "closed_at", None),
    )
    publish_contract_user_updates(
        user_id=int(position.user_id),
        symbols=[str(position.symbol)],
        position_ids=[int(position.id)],
        order_ids=[int(response.order_id)],
        trade_ids=[int(close_trade.id)] if close_trade is not None else None,
        include_account=True,
    )
    return ContractTpSlExecutionResult(
        position_id=int(position.id),
        symbol=str(position.symbol),
        trigger_type=trigger_type,
        mark_price=mark_price,
        order_id=int(response.order_id),
        status=response.status,
    )


def scan_and_execute_contract_tp_sl(
    db: Session,
    symbol: Optional[str] = None,
    limit: int = 100,
) -> List[ContractTpSlExecutionResult]:
    limit = max(1, min(int(limit or 100), 1000))
    query = (
        db.query(ContractPosition.id, ContractPosition.symbol)
        .filter(ContractPosition.status == "OPEN")
        .filter(ContractPosition.quantity > 0)
        .filter(or_(ContractPosition.take_profit_price.isnot(None), ContractPosition.stop_loss_price.isnot(None)))
    )
    normalized_symbol = str(symbol or "").strip().upper()
    if normalized_symbol:
        query = query.filter(ContractPosition.symbol == normalized_symbol)

    candidates = query.order_by(ContractPosition.symbol.asc(), ContractPosition.id.asc()).limit(limit).all()
    results: List[ContractTpSlExecutionResult] = []

    ids_by_symbol: dict[str, list[int]] = defaultdict(list)
    for position_id, position_symbol in candidates:
        ids_by_symbol[str(position_symbol or "").strip().upper()].append(int(position_id))

    for candidate_symbol, position_ids in ids_by_symbol.items():
        quote: Optional[dict[str, Any]] = None
        mark_price: Optional[Decimal] = None
        last_price: Optional[Decimal] = None
        trigger_price: Optional[Decimal] = None
        trigger_price_type = DEFAULT_TP_SL_TRIGGER_PRICE_TYPE
        skipped_reasons: Counter[str] = Counter()
        triggered_count = 0

        anchor_position = db.query(ContractPosition).filter(ContractPosition.id == int(position_ids[0])).first()
        if anchor_position is None:
            skipped_reasons["POSITION_NOT_FOUND"] += len(position_ids)
            _log_scan_symbol(
                level=logging.WARNING,
                event="position_missing",
                symbol=candidate_symbol,
                trigger_price_type=trigger_price_type,
                trigger_price=None,
                mark_price=None,
                last_price=None,
                open_positions_count=len(position_ids),
                triggered_count=0,
                skipped_reasons=dict(skipped_reasons),
            )
            db.rollback()
            continue

        try:
            quote = _get_executable_tp_sl_quote(db, anchor_position)
            mark_price = _q18(quote.get("mark_price"))
            last_price = _quote_last_price(quote)
            trigger_price_type = _position_tp_sl_trigger_price_type(db, anchor_position)
            trigger_price, _ = _tp_sl_trigger_price_from_quote(
                quote,
                mark_price,
                trigger_price_type,
                symbol=candidate_symbol,
            )
        except ContractTpSlNotTriggered as exc:
            skipped_reasons[_error_code(exc)] += len(position_ids)
            db.rollback()
            _log_scan_symbol(
                level=logging.WARNING,
                event="quote_skip",
                symbol=candidate_symbol,
                trigger_price_type=trigger_price_type,
                trigger_price=trigger_price,
                mark_price=None,
                last_price=last_price,
                open_positions_count=len(position_ids),
                triggered_count=0,
                skipped_reasons=dict(skipped_reasons),
            )
            continue
        except Exception as exc:
            skipped_reasons[_error_code(exc)] += len(position_ids)
            db.rollback()
            logger.exception("contract_tp_sl_scan_quote_failed symbol=%s positions=%s", candidate_symbol, len(position_ids))
            _log_scan_symbol(
                level=logging.WARNING,
                event="quote_error",
                symbol=candidate_symbol,
                trigger_price_type=trigger_price_type,
                trigger_price=trigger_price,
                mark_price=None,
                last_price=last_price,
                open_positions_count=len(position_ids),
                triggered_count=0,
                skipped_reasons=dict(skipped_reasons),
            )
            continue

        for position_id in position_ids:
            try:
                result = execute_contract_tp_sl(
                    db,
                    int(position_id),
                    quote_override=quote,
                    trigger_price_type_override=trigger_price_type,
                )
                results.append(result)
                triggered_count += 1
            except (ContractTpSlNotTriggered, ContractTpSlSkippedLiquidation, ContractPositionNotOpen) as exc:
                skipped_reasons[_error_code(exc)] += 1
                db.rollback()
                continue
            except ContractOrderError as exc:
                skipped_reasons[_error_code(exc)] += 1
                db.rollback()
                logger.warning(
                    "contract_tp_sl_scan_position_failed symbol=%s position_id=%s reason=%s",
                    candidate_symbol,
                    position_id,
                    _error_code(exc),
                )
                continue
            except Exception as exc:
                skipped_reasons[_error_code(exc)] += 1
                db.rollback()
                logger.exception(
                    "contract_tp_sl_scan_position_unexpected_error symbol=%s position_id=%s",
                    candidate_symbol,
                    position_id,
                )
                continue

        log_level = logging.INFO if triggered_count else logging.DEBUG
        if skipped_reasons:
            log_level = max(log_level, logging.WARNING)
        _log_scan_symbol(
            level=log_level,
            event="round",
            symbol=candidate_symbol,
            trigger_price_type=trigger_price_type,
            trigger_price=trigger_price,
            mark_price=mark_price,
            last_price=last_price,
            open_positions_count=len(position_ids),
            triggered_count=triggered_count,
            skipped_reasons=dict(skipped_reasons),
        )
    return results
