from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Any, Optional

from sqlalchemy.orm import Session

from app.db.models.contract_position import ContractPosition
from app.schemas.contract_order import ContractPositionTpSlUpdateRequest, ContractPositionTpSlUpdateResponse
from app.services.contract_market_service import get_contract_quote
from app.services.contract_tp_sl_service import resolve_position_tp_sl_trigger_reference


class ContractPositionServiceError(ValueError):
    code = "CONTRACT_POSITION_ERROR"


class ContractPositionBadRequest(ContractPositionServiceError):
    code = "BAD_REQUEST"


class ContractPositionNotOpen(ContractPositionServiceError):
    code = "POSITION_NOT_OPEN"


class ContractPositionQuoteUnavailable(ContractPositionServiceError):
    code = "CONTRACT_QUOTE_UNAVAILABLE"


def _q18(value: Any) -> Decimal:
    if isinstance(value, Decimal):
        return value
    return Decimal(str(value or "0"))


def _fmt_decimal(value: Any) -> str:
    return format(_q18(value), "f")


def _normalize_optional_price(value: Any) -> Optional[Decimal]:
    if value is None:
        return None
    try:
        price = Decimal(str(value))
    except Exception:
        raise ContractPositionBadRequest("INVALID_TP_SL_PRICE")
    if price <= Decimal("0"):
        raise ContractPositionBadRequest("INVALID_TP_SL_PRICE")
    return price


def _normalize_position_side(value: Any) -> str:
    normalized = str(value or "").strip().upper()
    if normalized in {"LONG", "SHORT"}:
        return normalized
    if normalized in {"多", "多仓", "平多"}:
        return "LONG"
    if normalized in {"空", "空仓", "平空"}:
        return "SHORT"
    return normalized


def _get_tp_sl_reference_snapshot(db: Session, position: ContractPosition) -> tuple[Decimal, Decimal]:
    quote: dict[str, Any] = {}
    try:
        quote = get_contract_quote(db, str(position.symbol))
        mark_price = _q18(quote.get("mark_price"))
    except Exception:
        mark_price = Decimal("0")

    if mark_price <= Decimal("0"):
        mark_price = _q18(position.mark_price)
        if mark_price > Decimal("0"):
            quote = {**quote, "mark_price": mark_price}
    if mark_price <= Decimal("0"):
        raise ContractPositionQuoteUnavailable("CONTRACT_MARK_PRICE_UNAVAILABLE")

    trigger_price, resolved_mark_price, _ = resolve_position_tp_sl_trigger_reference(db, position, quote)
    if trigger_price <= Decimal("0"):
        raise ContractPositionQuoteUnavailable("CONTRACT_TP_SL_REFERENCE_UNAVAILABLE")
    return trigger_price, resolved_mark_price if resolved_mark_price > Decimal("0") else mark_price


def _validate_tp_sl_prices(
    *,
    side: str,
    mark_price: Decimal,
    take_profit_price: Optional[Decimal],
    stop_loss_price: Optional[Decimal],
) -> None:
    if side == "LONG":
        if take_profit_price is not None and take_profit_price <= mark_price:
            raise ContractPositionBadRequest("LONG_TP_MUST_BE_ABOVE_MARK_PRICE")
        if stop_loss_price is not None and stop_loss_price >= mark_price:
            raise ContractPositionBadRequest("LONG_SL_MUST_BE_BELOW_MARK_PRICE")
        return

    if side == "SHORT":
        if take_profit_price is not None and take_profit_price >= mark_price:
            raise ContractPositionBadRequest("SHORT_TP_MUST_BE_BELOW_MARK_PRICE")
        if stop_loss_price is not None and stop_loss_price <= mark_price:
            raise ContractPositionBadRequest("SHORT_SL_MUST_BE_ABOVE_MARK_PRICE")
        return

    raise ContractPositionBadRequest("INVALID_POSITION_SIDE")


def update_contract_position_tp_sl(
    db: Session,
    user_id: int,
    position_id: int,
    request: ContractPositionTpSlUpdateRequest,
) -> ContractPositionTpSlUpdateResponse:
    fields_set = getattr(request, "model_fields_set", None)
    if fields_set is None:
        fields_set = getattr(request, "__fields_set__", set())
    if not fields_set:
        raise ContractPositionBadRequest("TP_SL_UPDATE_EMPTY")

    position = (
        db.query(ContractPosition)
        .filter(ContractPosition.id == int(position_id))
        .filter(ContractPosition.user_id == int(user_id))
        .first()
    )
    if position is None or str(position.status or "").upper() != "OPEN" or _q18(position.quantity) <= Decimal("0"):
        raise ContractPositionNotOpen("POSITION_NOT_OPEN")

    side = _normalize_position_side(position.side)
    trigger_reference_price, mark_price = _get_tp_sl_reference_snapshot(db, position)

    position = (
        db.query(ContractPosition)
        .filter(ContractPosition.id == int(position_id))
        .filter(ContractPosition.user_id == int(user_id))
        .with_for_update()
        .first()
    )
    if position is None or str(position.status or "").upper() != "OPEN" or _q18(position.quantity) <= Decimal("0"):
        raise ContractPositionNotOpen("POSITION_NOT_OPEN")

    side = _normalize_position_side(position.side)
    take_profit_price = _q18(position.take_profit_price) if position.take_profit_price is not None else None
    stop_loss_price = _q18(position.stop_loss_price) if position.stop_loss_price is not None else None

    if "take_profit_price" in fields_set:
        take_profit_price = _normalize_optional_price(request.take_profit_price)
    if "stop_loss_price" in fields_set:
        stop_loss_price = _normalize_optional_price(request.stop_loss_price)

    _validate_tp_sl_prices(
        side=side,
        mark_price=trigger_reference_price,
        take_profit_price=take_profit_price,
        stop_loss_price=stop_loss_price,
    )

    position.take_profit_price = take_profit_price
    position.stop_loss_price = stop_loss_price
    position.mark_price = mark_price
    position.updated_at = datetime.utcnow()
    db.add(position)
    db.commit()
    db.refresh(position)

    return ContractPositionTpSlUpdateResponse(
        position_id=int(position.id),
        symbol=str(position.symbol),
        side=side,
        mark_price=_fmt_decimal(mark_price),
        take_profit_price=_fmt_decimal(position.take_profit_price) if position.take_profit_price is not None else None,
        stop_loss_price=_fmt_decimal(position.stop_loss_price) if position.stop_loss_price is not None else None,
    )
