from __future__ import annotations

import logging
from datetime import datetime
from decimal import Decimal
from types import SimpleNamespace
from typing import Any, Optional
from uuid import uuid4

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.db.models.contract_account import ContractAccount
from app.db.models.contract_margin_log import ContractMarginLog
from app.db.models.contract_order import ContractOrder
from app.db.models.contract_position import ContractPosition
from app.db.models.contract_symbol import ContractSymbol
from app.db.models.contract_trade import ContractTrade
from app.schemas.contract_order import (
    ContractCloseOrderRequest,
    ContractCloseSummaryOrderRequest,
    ContractCloseSummaryOrderResponse,
    ContractOpenOrderRequest,
    ContractOrderResponse,
)
from app.services.contract_balance_log_service import add_contract_balance_log, add_contract_margin_log
from app.services.contract_market_guard import (
    CONTRACT_QUOTE_NOT_LIVE,
    ContractQuoteNotLive,
    should_log_contract_quote_skip,
)
from app.services.contract_market_view import get_contract_execution_view
from app.services.contract_private_ws import publish_contract_user_updates


logger = logging.getLogger(__name__)

_stock_contract_quote_asset = "USDT"
_known_crypto_contract_bases = {
    "BTC",
    "ETH",
    "BNB",
    "SOL",
    "XRP",
    "DOGE",
    "ADA",
    "AVAX",
    "MATIC",
    "DOT",
    "TRX",
    "LTC",
    "BCH",
    "LINK",
    "UNI",
}


class ContractOrderError(ValueError):
    code = "CONTRACT_ORDER_ERROR"


class ContractOrderBadRequest(ContractOrderError):
    code = "BAD_REQUEST"


class ContractOrderInsufficientMargin(ContractOrderError):
    code = "INSUFFICIENT_CONTRACT_MARGIN"


class ContractOrderQuoteUnavailable(ContractOrderError):
    code = "CONTRACT_QUOTE_UNAVAILABLE"


class ContractOrderQuoteNotLive(ContractOrderQuoteUnavailable):
    code = "CONTRACT_QUOTE_NOT_LIVE"


class ContractPositionNotOpen(ContractOrderError):
    code = "POSITION_NOT_OPEN"


class ContractPositionHasOpenCloseOrder(ContractOrderError):
    code = "POSITION_HAS_OPEN_CLOSE_ORDER"


class ContractOrderCannotCancel(ContractOrderError):
    code = "CONTRACT_ORDER_CANNOT_CANCEL"


def _q18(value: Any) -> Decimal:
    if isinstance(value, Decimal):
        return value
    return Decimal(str(value or "0"))


def _raise_open_quote_not_live(exc: ContractQuoteNotLive) -> None:
    raise ContractOrderQuoteNotLive("\u5f53\u524d\u884c\u60c5\u6682\u4e0d\u53ef\u4ea4\u6613\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5") from exc


def _raise_close_quote_not_live(exc: ContractQuoteNotLive) -> None:
    raise ContractOrderQuoteNotLive("\u5f53\u524d\u884c\u60c5\u6682\u4e0d\u53ef\u5e73\u4ed3\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5") from exc


def _fmt_decimal(value: Any) -> str:
    return format(_q18(value), "f")


def _quote_spread_x(quote: dict[str, Any], fallback: Any = None) -> Decimal:
    if quote.get("single_side_spread_fee_price") is not None:
        single_side_price = _q18(quote.get("single_side_spread_fee_price"))
    elif quote.get("effective_total_spread") is not None:
        single_side_price = _q18(quote.get("effective_total_spread")) / Decimal("2")
    elif quote.get("spread_x") is not None:
        single_side_price = _q18(quote.get("spread_x")) / Decimal("2")
    else:
        single_side_price = _q18(fallback)
    if single_side_price < Decimal("0"):
        return Decimal("0")
    return single_side_price


def _execution_view_has_market_reference(view: dict[str, Any]) -> bool:
    bid = _q18(view.get("execution_bid"))
    ask = _q18(view.get("execution_ask"))
    if bid > Decimal("0") and ask > Decimal("0") and ask >= bid:
        return True
    raw_source_summary = view.get("raw_source_summary") if isinstance(view.get("raw_source_summary"), dict) else {}
    return bool(raw_source_summary.get("quote_source") or raw_source_summary.get("depth_source"))


def _execution_quote_from_view(view: dict[str, Any]) -> dict[str, Any]:
    bid_price = _q18(view.get("execution_bid"))
    ask_price = _q18(view.get("execution_ask"))
    if bid_price > Decimal("0") and ask_price > Decimal("0") and ask_price >= bid_price:
        mark_price = (bid_price + ask_price) / Decimal("2")
    else:
        mark_price = Decimal("0")
    raw_source_summary = view.get("raw_source_summary") if isinstance(view.get("raw_source_summary"), dict) else {}
    return {
        "symbol": view.get("symbol"),
        "bid_price": bid_price,
        "ask_price": ask_price,
        "last_price": mark_price,
        "mark_price": mark_price,
        "spread_x": _q18(view.get("spread_x")),
        "manual_spread_x": _q18(view.get("manual_spread_x")),
        "effective_total_spread": _q18(view.get("effective_total_spread")),
        "single_side_spread_fee_price": _q18(view.get("single_side_spread_fee_price")),
        "source": view.get("execution_mode") or "EXECUTION_VIEW",
        "quote_source": view.get("execution_mode") or "EXECUTION_VIEW",
        "depth_source": view.get("execution_mode") or "EXECUTION_VIEW",
        "quote_freshness": raw_source_summary.get("quote_freshness"),
        "market_status": raw_source_summary.get("market_status"),
        "market_session_type": raw_source_summary.get("market_session_type"),
        "closed_market_execution_mode": raw_source_summary.get("closed_market_execution_mode"),
        "executable": bool(view.get("executable")),
        "execution_mode": view.get("execution_mode"),
        "reason_code": view.get("reason_code"),
        "warnings": list(view.get("warnings") or []),
        "raw_source_summary": raw_source_summary,
        "display_state": view.get("display_state"),
        "ts": view.get("quote_time"),
        "price_age_ms": view.get("price_age_ms"),
        "last_good_at": view.get("last_good_at"),
    }


def _execution_quote_is_executable(quote: dict[str, Any]) -> bool:
    bid_price = _q18(quote.get("bid_price"))
    ask_price = _q18(quote.get("ask_price"))
    return bool(quote.get("executable")) and bid_price > Decimal("0") and ask_price > Decimal("0") and ask_price >= bid_price


def _require_execution_quote(
    quote: dict[str, Any],
    *,
    context: str,
    symbol: str,
    order_id: Any = None,
    position_id: Any = None,
    user_id: Any = None,
) -> None:
    if _execution_quote_is_executable(quote):
        return
    reason = str(quote.get("reason_code") or "CONTRACT_EXECUTION_UNAVAILABLE")
    log_key = f"execution_view:{symbol}:{order_id}:{reason}"
    if should_log_contract_quote_skip(log_key):
        logger.debug(
            "contract execution view rejected symbol=%s context=%s reason=%s execution_mode=%s "
            "display_state=%s order_id=%s position_id=%s user_id=%s",
            symbol,
            context,
            reason,
            quote.get("execution_mode"),
            quote.get("display_state"),
            order_id,
            position_id,
            user_id,
        )
    raise ContractQuoteNotLive(reason)


def _load_contract_execution_quote(
    db: Session,
    symbol: str,
    *,
    context: str,
    require_executable: bool,
    require_market_reference: bool = True,
    order_id: Any = None,
    position_id: Any = None,
    user_id: Any = None,
) -> dict[str, Any]:
    view = get_contract_execution_view(db, symbol)
    if require_market_reference and not _execution_view_has_market_reference(view):
        raise ContractOrderQuoteUnavailable("CONTRACT_MARKET_REFERENCE_UNAVAILABLE")
    quote = _execution_quote_from_view(view)
    if require_executable:
        _require_execution_quote(
            quote,
            context=context,
            symbol=symbol,
            order_id=order_id,
            position_id=position_id,
            user_id=user_id,
        )
    return quote


def _contract_spread_fee(*, spread_x: Decimal, quantity: Decimal) -> Decimal:
    if spread_x <= Decimal("0") or quantity <= Decimal("0"):
        return Decimal("0")
    # In order context, spread_x_snapshot stores the single-side spread fee price.
    return _q18(spread_x * quantity)


def _normalize_symbol(value: str) -> str:
    symbol = str(value or "").strip().upper()
    if not symbol:
        raise ContractOrderBadRequest("SYMBOL_REQUIRED")
    return symbol


def _stock_contract_underlying(symbol: str) -> Optional[str]:
    normalized = _normalize_symbol(symbol)
    if not normalized.endswith("_PERP"):
        return None
    market_symbol = normalized[:-5]
    if not market_symbol.endswith(_stock_contract_quote_asset):
        return None
    underlying = market_symbol[: -len(_stock_contract_quote_asset)]
    if not underlying or underlying in _known_crypto_contract_bases:
        return None
    return underlying


def _fallback_stock_contract_symbol(symbol: str) -> Any:
    underlying = _stock_contract_underlying(symbol)
    if not underlying:
        return None

    return SimpleNamespace(
        symbol=symbol,
        display_name=f"{underlying}USDT 永续",
        category="STOCK",
        provider="ITICK",
        provider_symbol=underlying,
        quote_asset=_stock_contract_quote_asset,
        price_precision=2,
        quantity_precision=6,
        min_quantity=Decimal("0.001"),
        max_quantity=Decimal("0"),
        min_margin=Decimal("0"),
        max_leverage=int(getattr(settings, "CONTRACT_CFD_MAX_LEVERAGE", 200) or 200),
        spread_x=Decimal("0"),
        liquidation_threshold=Decimal("0"),
        warning_threshold=Decimal("0"),
        status=1,
    )


def _normalize_quantity(value: Any) -> Decimal:
    try:
        quantity = Decimal(str(value))
    except Exception as exc:
        raise ContractOrderBadRequest("INVALID_QUANTITY") from exc
    if quantity <= Decimal("0"):
        raise ContractOrderBadRequest("QUANTITY_MUST_BE_POSITIVE")
    return quantity


def _normalize_price(value: Any, *, required: bool) -> Optional[Decimal]:
    if value in (None, ""):
        if required:
            raise ContractOrderBadRequest("LIMIT_PRICE_REQUIRED")
        return None
    try:
        price = Decimal(str(value))
    except Exception as exc:
        raise ContractOrderBadRequest("INVALID_PRICE") from exc
    if price <= Decimal("0"):
        raise ContractOrderBadRequest("PRICE_MUST_BE_POSITIVE")
    return price


def _normalize_optional_trigger_price(value: Any) -> Optional[Decimal]:
    return _normalize_price(value, required=False)


def _validate_take_profit_stop_loss(
    *,
    position_side: str,
    reference_price: Decimal,
    take_profit_price: Optional[Decimal],
    stop_loss_price: Optional[Decimal],
) -> None:
    if reference_price <= Decimal("0"):
        raise ContractOrderBadRequest("INVALID_REFERENCE_PRICE")

    if position_side == "LONG":
        if take_profit_price is not None and take_profit_price <= reference_price:
            raise ContractOrderBadRequest("TAKE_PROFIT_MUST_BE_ABOVE_ENTRY")
        if stop_loss_price is not None and stop_loss_price >= reference_price:
            raise ContractOrderBadRequest("STOP_LOSS_MUST_BE_BELOW_ENTRY")
        return

    if position_side == "SHORT":
        if take_profit_price is not None and take_profit_price >= reference_price:
            raise ContractOrderBadRequest("TAKE_PROFIT_MUST_BE_BELOW_ENTRY")
        if stop_loss_price is not None and stop_loss_price <= reference_price:
            raise ContractOrderBadRequest("STOP_LOSS_MUST_BE_ABOVE_ENTRY")
        return

    raise ContractOrderBadRequest("INVALID_POSITION_SIDE")


def _build_order_no(now: datetime) -> str:
    return f"CO{now.strftime('%Y%m%d%H%M%S')}{uuid4().hex[:8].upper()}"


def _build_trade_no(now: datetime) -> str:
    return f"CT{now.strftime('%Y%m%d%H%M%S')}{uuid4().hex[:8].upper()}"


def _load_enabled_contract_symbol(db: Session, symbol: str) -> Any:
    item = (
        db.query(ContractSymbol)
        .filter(ContractSymbol.symbol == symbol)
        .filter(ContractSymbol.status == 1)
        .first()
    )
    if item is None:
        fallback = _fallback_stock_contract_symbol(symbol)
        if fallback is not None:
            return fallback
        raise ContractOrderBadRequest("CONTRACT_SYMBOL_NOT_ENABLED")
    return item


def _lock_contract_account(db: Session, *, user_id: int, margin_asset: str = "USDT") -> ContractAccount:
    account = (
        db.query(ContractAccount)
        .filter(ContractAccount.user_id == int(user_id))
        .filter(ContractAccount.margin_asset == margin_asset)
        .with_for_update()
        .first()
    )
    if account is None:
        raise ContractOrderInsufficientMargin("CONTRACT_ACCOUNT_NOT_FOUND")
    return account


def _validate_open_request(
    *,
    contract_symbol: ContractSymbol,
    request: ContractOpenOrderRequest,
    quantity: Decimal,
    leverage: int,
) -> None:
    position_side = str(request.position_side or "").upper()
    if position_side not in {"LONG", "SHORT"}:
        raise ContractOrderBadRequest("INVALID_POSITION_SIDE")

    order_type = str(request.order_type or "").upper()
    if order_type not in {"MARKET", "LIMIT"}:
        raise ContractOrderBadRequest("INVALID_ORDER_TYPE")

    if leverage <= 0:
        raise ContractOrderBadRequest("LEVERAGE_MUST_BE_POSITIVE")
    platform_max_leverage = int(getattr(settings, "CONTRACT_CFD_MAX_LEVERAGE", 200) or 200)
    symbol_max_leverage = int(contract_symbol.max_leverage or 1)
    if leverage > symbol_max_leverage or leverage > platform_max_leverage:
        raise ContractOrderBadRequest("LEVERAGE_EXCEEDS_LIMIT")

    min_quantity = _q18(contract_symbol.min_quantity)
    max_quantity = _q18(contract_symbol.max_quantity)
    if quantity < min_quantity:
        raise ContractOrderBadRequest("QUANTITY_BELOW_MIN")
    if max_quantity > 0 and quantity > max_quantity:
        raise ContractOrderBadRequest("QUANTITY_ABOVE_MAX")


def _decide_open_execution(
    *,
    position_side: str,
    order_type: str,
    limit_price: Optional[Decimal],
    bid_price: Decimal,
    ask_price: Decimal,
) -> tuple[bool, Decimal]:
    if position_side == "LONG":
        market_entry_price = ask_price
        if order_type == "MARKET":
            return True, market_entry_price
        assert limit_price is not None
        return limit_price >= ask_price, market_entry_price if limit_price >= ask_price else limit_price

    market_entry_price = bid_price
    if order_type == "MARKET":
        return True, market_entry_price
    assert limit_price is not None
    return limit_price <= bid_price, market_entry_price if limit_price <= bid_price else limit_price


def _response_from_order(
    order: ContractOrder,
    position_id: Optional[int],
    *,
    realized_pnl: Optional[Decimal] = None,
    released_margin: Optional[Decimal] = None,
    remaining_position_quantity: Optional[Decimal] = None,
) -> ContractOrderResponse:
    return ContractOrderResponse(
        order_id=int(order.id),
        order_no=order.order_no,
        symbol=order.symbol,
        position_side=order.position_side,
        order_type=order.order_type,
        price=_fmt_decimal(order.price) if order.price is not None else None,
        quantity=_fmt_decimal(order.quantity),
        leverage=int(order.leverage),
        margin_amount=_fmt_decimal(order.margin_amount),
        fee_amount=_fmt_decimal(getattr(order, "fee_amount", None)),
        spread_fee=_fmt_decimal(order.spread_fee),
        status=order.status,
        avg_price=_fmt_decimal(order.avg_price),
        position_id=position_id,
        realized_pnl=_fmt_decimal(realized_pnl) if realized_pnl is not None else None,
        released_margin=_fmt_decimal(released_margin) if released_margin is not None else None,
        remaining_position_quantity=(
            _fmt_decimal(remaining_position_quantity) if remaining_position_quantity is not None else None
        ),
        take_profit_price=_fmt_decimal(order.take_profit_price) if order.take_profit_price is not None else None,
        stop_loss_price=_fmt_decimal(order.stop_loss_price) if order.stop_loss_price is not None else None,
    )


def create_contract_open_order(
    db: Session,
    user_id: int,
    request: ContractOpenOrderRequest,
) -> ContractOrderResponse:
    symbol = _normalize_symbol(request.symbol)
    position_side = str(request.position_side or "").upper()
    order_type = str(request.order_type or "").upper()
    quantity = _normalize_quantity(request.quantity)
    leverage = int(request.leverage or 0)
    limit_price = _normalize_price(request.price, required=order_type == "LIMIT")
    take_profit_price = _normalize_optional_trigger_price(getattr(request, "take_profit_price", None))
    stop_loss_price = _normalize_optional_trigger_price(getattr(request, "stop_loss_price", None))

    contract_symbol = _load_enabled_contract_symbol(db, symbol)
    _validate_open_request(
        contract_symbol=contract_symbol,
        request=request,
        quantity=quantity,
        leverage=leverage,
    )

    try:
        quote = _load_contract_execution_quote(
            db,
            symbol,
            context="market_open" if order_type == "MARKET" else "limit_open_reference",
            require_executable=order_type == "MARKET",
            user_id=user_id,
        )
    except ContractQuoteNotLive as exc:
        _raise_open_quote_not_live(exc)
    except Exception as exc:
        raise ContractOrderQuoteUnavailable("CONTRACT_QUOTE_UNAVAILABLE") from exc

    bid_price = _q18(quote["bid_price"])
    ask_price = _q18(quote["ask_price"])
    mark_price = _q18(quote["mark_price"])
    if order_type == "MARKET" and (bid_price <= 0 or ask_price <= 0):
        raise ContractOrderQuoteUnavailable("CONTRACT_QUOTE_UNAVAILABLE")

    quote_is_executable = _execution_quote_is_executable(quote)
    execution_quote = quote

    if order_type == "LIMIT" and not quote_is_executable:
        should_fill = False
        entry_price = limit_price
    else:
        should_fill, entry_price = _decide_open_execution(
            position_side=position_side,
            order_type=order_type,
            limit_price=limit_price,
            bid_price=bid_price,
            ask_price=ask_price,
        )
    if order_type == "LIMIT":
        logger.info(
            "contract_limit_open_decision symbol=%s provider_symbol=%s action=OPEN direction=%s "
            "order_type=%s limit_price=%s execution_bid=%s execution_ask=%s quote_source=%s should_fill=%s fill_price=%s",
            symbol,
            quote.get("provider_symbol"),
            position_side,
            order_type,
            limit_price,
            bid_price,
            ask_price,
            quote.get("source"),
            should_fill,
            entry_price,
        )
    _validate_take_profit_stop_loss(
        position_side=position_side,
        reference_price=entry_price,
        take_profit_price=take_profit_price,
        stop_loss_price=stop_loss_price,
    )

    spread_x_snapshot = _quote_spread_x(quote, contract_symbol.spread_x)
    if should_fill:
        spread_x_snapshot = _quote_spread_x(execution_quote, spread_x_snapshot)
    spread_fee_amount = _contract_spread_fee(spread_x=spread_x_snapshot, quantity=quantity)
    margin_amount = quantity * entry_price / Decimal(leverage)
    total_cost = margin_amount

    now = datetime.utcnow()
    account = _lock_contract_account(db, user_id=int(user_id), margin_asset="USDT")
    before_available = _q18(account.available_margin)
    before_frozen = _q18(account.frozen_margin)
    before_position_margin = _q18(account.position_margin)
    if before_available < total_cost:
        raise ContractOrderInsufficientMargin("INSUFFICIENT_CONTRACT_MARGIN")

    order_side = "BUY" if position_side == "LONG" else "SELL"
    order = ContractOrder(
        order_no=_build_order_no(now),
        user_id=int(user_id),
        position_id=None,
        symbol=symbol,
        side=order_side,
        position_side=position_side,
        action="OPEN",
        order_type=order_type,
        price=limit_price,
        quantity=quantity,
        leverage=leverage,
        margin_amount=margin_amount,
        fee_amount=Decimal("0"),
        spread_x_snapshot=spread_x_snapshot,
        spread_fee=spread_fee_amount,
        trigger_price=None,
        take_profit_price=take_profit_price,
        stop_loss_price=stop_loss_price,
        filled_quantity=quantity if should_fill else Decimal("0"),
        avg_price=entry_price if should_fill else Decimal("0"),
        status="FILLED" if should_fill else "OPEN",
        fail_reason=None,
        created_at=now,
        updated_at=now,
    )
    db.add(order)
    db.flush()

    position_id: Optional[int] = None
    if should_fill:
        after_margin_available = before_available - margin_amount
        account.available_margin = after_margin_available
        account.position_margin = before_position_margin + margin_amount
        account.version = int(account.version or 0) + 1
        account.updated_at = now

        position = ContractPosition(
            user_id=int(user_id),
            symbol=symbol,
            side=position_side,
            margin_mode="ISOLATED",
            leverage=leverage,
            quantity=quantity,
            entry_price=entry_price,
            mark_price=mark_price,
            margin_amount=margin_amount,
            open_fee=Decimal("0"),
            unrealized_pnl=Decimal("0"),
            realized_pnl=Decimal("0"),
            liquidation_price=Decimal("0"),
            warning_price=Decimal("0"),
            take_profit_price=take_profit_price,
            stop_loss_price=stop_loss_price,
            status="OPEN",
            opened_at=now,
            closed_at=None,
            created_at=now,
            updated_at=now,
        )
        db.add(position)
        db.flush()
        position_id = int(position.id)
        order.position_id = position_id

        trade = ContractTrade(
            trade_no=_build_trade_no(now),
            order_id=int(order.id),
            position_id=position_id,
            user_id=int(user_id),
            symbol=symbol,
            side=order_side,
            position_side=position_side,
            action="OPEN",
            price=entry_price,
            quantity=quantity,
            notional=entry_price * quantity,
            leverage=leverage,
            margin_amount=margin_amount,
            fee_amount=Decimal("0"),
            spread_fee=spread_fee_amount,
            realized_pnl=Decimal("0"),
            created_at=now,
        )
        db.add(trade)
        db.flush()
        trade_id = int(trade.id)
        add_contract_margin_log(
            db,
            user_id=int(user_id),
            account_id=int(account.id),
            position_id=position_id,
            order_id=int(order.id),
            trade_id=trade_id,
            symbol=symbol,
            change_type="OPEN_MARGIN_USED",
            change_amount=margin_amount,
            before_available=before_available,
            after_available=after_margin_available,
            before_frozen=before_frozen,
            after_frozen=before_frozen,
            remark=f"open {position_side} isolated margin used",
            now=now,
        )
        add_contract_balance_log(
            db,
            user_id=int(user_id),
            change_type="CONTRACT_OPEN_MARGIN",
            biz_type="CONTRACT_OPEN_MARGIN",
            biz_id=f"order:{int(order.id)}:open_margin",
            change_amount=-margin_amount,
            trade_id=trade_id,
            before_available=before_available,
            after_available=after_margin_available,
            before_frozen=before_frozen,
            after_frozen=before_frozen,
            remark=f"open {position_side} isolated margin used",
            now=now,
        )
    else:
        after_available = before_available - total_cost
        after_frozen = before_frozen + total_cost
        account.available_margin = after_available
        account.frozen_margin = after_frozen
        account.version = int(account.version or 0) + 1
        account.updated_at = now
        db.add(
            ContractMarginLog(
                user_id=int(user_id),
                account_id=int(account.id),
                position_id=None,
                order_id=int(order.id),
                symbol=symbol,
                change_type="OPEN_MARGIN_FREEZE",
                change_amount=total_cost,
                before_available=before_available,
                after_available=after_available,
                before_frozen=before_frozen,
                after_frozen=after_frozen,
                remark="open limit order margin frozen",
                created_at=now,
            )
        )
        add_contract_balance_log(
            db,
            user_id=int(user_id),
            change_type="CONTRACT_OPEN_MARGIN",
            biz_type="CONTRACT_OPEN_MARGIN",
            biz_id=f"order:{int(order.id)}:open_margin_freeze",
            change_amount=after_available - before_available,
            before_available=before_available,
            after_available=after_available,
            before_frozen=before_frozen,
            after_frozen=after_frozen,
            remark="open limit order margin frozen",
            now=now,
        )

    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise ContractOrderBadRequest("CONTRACT_OPEN_ORDER_FAILED") from exc
    db.refresh(order)
    return _response_from_order(order, position_id)


def cancel_contract_order(db: Session, user_id: int, order_id: int) -> ContractOrderResponse:
    if int(order_id or 0) <= 0:
        raise ContractOrderBadRequest("ORDER_ID_REQUIRED")

    order = (
        db.query(ContractOrder)
        .filter(ContractOrder.id == int(order_id))
        .filter(ContractOrder.user_id == int(user_id))
        .with_for_update()
        .first()
    )
    if order is None:
        raise ContractOrderBadRequest("CONTRACT_ORDER_NOT_FOUND")
    if order.status not in {"NEW", "OPEN", "PARTIALLY_FILLED"}:
        raise ContractOrderCannotCancel(f"ORDER_CANNOT_CANCEL_IN_STATUS_{order.status}")

    now = datetime.utcnow()
    if order.action == "OPEN":
        account = _lock_contract_account(db, user_id=int(user_id), margin_asset="USDT")
        before_available = _q18(account.available_margin)
        before_frozen = _q18(account.frozen_margin)
        quantity = _q18(order.quantity)
        filled_quantity = _q18(order.filled_quantity)
        remaining_quantity = quantity - filled_quantity
        if remaining_quantity < Decimal("0"):
            remaining_quantity = Decimal("0")
        total_frozen = _q18(order.margin_amount)
        release_amount = total_frozen
        if quantity > Decimal("0") and filled_quantity > Decimal("0"):
            release_amount = total_frozen * remaining_quantity / quantity
        if release_amount > before_frozen:
            release_amount = before_frozen
        after_available = before_available + release_amount
        after_frozen = before_frozen - release_amount
        if after_frozen < Decimal("0"):
            after_frozen = Decimal("0")
        account.available_margin = after_available
        account.frozen_margin = after_frozen
        account.version = int(account.version or 0) + 1
        account.updated_at = now
        db.add(
            ContractMarginLog(
                user_id=int(user_id),
                account_id=int(account.id),
                position_id=None,
                order_id=int(order.id),
                symbol=order.symbol,
                change_type="OPEN_MARGIN_FREEZE",
                change_amount=-release_amount,
                before_available=before_available,
                after_available=after_available,
                before_frozen=before_frozen,
                after_frozen=after_frozen,
                remark="cancel contract limit order release frozen margin",
                created_at=now,
            )
        )
        if release_amount != Decimal("0"):
            add_contract_balance_log(
                db,
                user_id=int(user_id),
                change_type="CONTRACT_MARGIN_RELEASE",
                biz_type="CONTRACT_MARGIN_RELEASE",
                biz_id=f"order:{int(order.id)}:cancel_margin_release",
                change_amount=after_available - before_available,
                before_available=before_available,
                after_available=after_available,
                before_frozen=before_frozen,
                after_frozen=after_frozen,
                remark="cancel contract limit order release frozen margin",
                now=now,
            )

    order.status = "CANCELED"
    order.updated_at = now
    db.add(order)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise ContractOrderBadRequest("CONTRACT_ORDER_CANCEL_FAILED") from exc
    db.refresh(order)
    return _response_from_order(order, int(order.position_id) if order.position_id is not None else None)


def _load_open_position(
    db: Session,
    *,
    user_id: int,
    position_id: int,
    lock: bool = True,
) -> ContractPosition:
    query = (
        db.query(ContractPosition)
        .filter(ContractPosition.id == int(position_id))
        .filter(ContractPosition.user_id == int(user_id))
        .filter(ContractPosition.status == "OPEN")
    )
    if lock:
        query = query.with_for_update()
    position = query.first()
    if position is None or _q18(position.quantity) <= Decimal("0"):
        raise ContractPositionNotOpen("POSITION_NOT_OPEN")
    return position


def _ensure_no_open_close_order(db: Session, *, user_id: int, position_id: int) -> None:
    existing = (
        db.query(ContractOrder.id)
        .filter(ContractOrder.user_id == int(user_id))
        .filter(ContractOrder.position_id == int(position_id))
        .filter(ContractOrder.action == "CLOSE")
        .filter(ContractOrder.status == "OPEN")
        .first()
    )
    if existing is not None:
        raise ContractPositionHasOpenCloseOrder("POSITION_HAS_OPEN_CLOSE_ORDER")


def _normalize_close_quantity(value: Any, *, position_quantity: Decimal) -> Decimal:
    if value in (None, ""):
        return position_quantity
    quantity = _normalize_quantity(value)
    if quantity > position_quantity:
        raise ContractOrderBadRequest("CLOSE_QUANTITY_EXCEEDS_POSITION")
    return quantity


def _decide_close_execution(
    *,
    position_side: str,
    order_type: str,
    limit_price: Optional[Decimal],
    bid_price: Decimal,
    ask_price: Decimal,
) -> tuple[bool, Decimal]:
    if position_side == "LONG":
        market_close_price = bid_price
        if order_type == "MARKET":
            return True, market_close_price
        assert limit_price is not None
        return limit_price <= bid_price, market_close_price

    market_close_price = ask_price
    if order_type == "MARKET":
        return True, market_close_price
    assert limit_price is not None
    return limit_price >= ask_price, market_close_price


def _calculate_realized_pnl(
    *,
    position_side: str,
    entry_price: Decimal,
    close_price: Decimal,
    close_quantity: Decimal,
) -> Decimal:
    if position_side == "LONG":
        return (close_price - entry_price) * close_quantity
    if position_side == "SHORT":
        return (entry_price - close_price) * close_quantity
    raise ContractOrderBadRequest("INVALID_POSITION_SIDE")


def _is_limit_order_triggered(
    *,
    action: str,
    position_side: str,
    limit_price: Decimal,
    bid_price: Decimal,
    ask_price: Decimal,
) -> bool:
    if action == "OPEN":
        if position_side == "LONG":
            return ask_price <= limit_price
        if position_side == "SHORT":
            return bid_price >= limit_price
    if action == "CLOSE":
        if position_side == "LONG":
            return bid_price >= limit_price
        if position_side == "SHORT":
            return ask_price <= limit_price
    raise ContractOrderBadRequest("INVALID_LIMIT_ORDER_SIDE")


def _limit_fill_price(*, action: str, position_side: str, bid_price: Decimal, ask_price: Decimal) -> Decimal:
    if action == "OPEN":
        if position_side == "LONG":
            return ask_price
        if position_side == "SHORT":
            return bid_price
    if action == "CLOSE":
        if position_side == "LONG":
            return bid_price
        if position_side == "SHORT":
            return ask_price
    raise ContractOrderBadRequest("INVALID_LIMIT_ORDER_SIDE")


def _fresh_execution_quote_for_limit_scan(
    db: Session,
    symbol: str,
    *,
    order_id: Any = None,
    position_id: Any = None,
    user_id: Any = None,
) -> dict[str, Any]:
    return _load_contract_execution_quote(
        db,
        symbol,
        context="limit_order_scan",
        require_executable=True,
        require_market_reference=True,
        order_id=order_id,
        position_id=position_id,
        user_id=user_id,
    )


def _is_expected_limit_scan_quote_skip(reason: Any, error: Any) -> bool:
    normalized_reason = str(reason or "").strip().upper()
    normalized_error = str(error or "").strip().upper()
    expected_reasons = {
        CONTRACT_QUOTE_NOT_LIVE,
        "ITICK_QUOTE_FALLBACK",
        "ITICK_QUOTE_UNAVAILABLE",
        "ITICK_STOCK_QUOTE_UNAVAILABLE",
        "ITICK_COOLDOWN_ACTIVE",
        "CONTRACT_EXECUTION_UNAVAILABLE",
        "CONTRACT_MARKET_REFERENCE_UNAVAILABLE",
    }
    if normalized_reason in expected_reasons:
        return True
    return "ITICK_QUOTE_UNAVAILABLE" in normalized_error or "TIMEOUT" in normalized_error


def _log_limit_scan_decision(
    *,
    order_id: int,
    symbol: str,
    action: str,
    order_side: str,
    position_side: str,
    limit_price: Decimal,
    bid_price: Decimal,
    ask_price: Decimal,
    triggered: bool,
    price_source: str,
    depth_ts: Any,
) -> None:
    logger.debug(
        "contract_limit_order_scan_decision order_id=%s symbol=%s action=%s side=%s position_side=%s "
        "limit_price=%s execution_bid=%s execution_ask=%s triggered=%s price_source=%s depth_ts=%s",
        order_id,
        symbol,
        action,
        order_side,
        position_side,
        limit_price,
        bid_price,
        ask_price,
        triggered,
        price_source,
        depth_ts,
    )


def _fill_open_order_locked(
    db: Session,
    *,
    order: ContractOrder,
    quote: dict[str, Any],
) -> Optional[int]:
    if order.action != "OPEN" or order.order_type != "LIMIT":
        raise ContractOrderBadRequest("INVALID_OPEN_LIMIT_ORDER")
    if order.status not in {"NEW", "OPEN", "PARTIALLY_FILLED"}:
        raise ContractOrderBadRequest("ORDER_NOT_OPEN")

    symbol = _normalize_symbol(order.symbol)
    position_side = str(order.position_side or "").upper()
    if position_side not in {"LONG", "SHORT"}:
        raise ContractOrderBadRequest("INVALID_POSITION_SIDE")

    limit_price = _normalize_price(order.price, required=True)
    _require_execution_quote(
        quote,
        context="limit_open_fill",
        symbol=symbol,
        order_id=getattr(order, "id", None),
        user_id=getattr(order, "user_id", None),
    )
    bid_price = _q18(quote["bid_price"])
    ask_price = _q18(quote["ask_price"])
    mark_price = _q18(quote["mark_price"])
    if not _is_limit_order_triggered(
        action="OPEN",
        position_side=position_side,
        limit_price=limit_price,
        bid_price=bid_price,
        ask_price=ask_price,
    ):
        return None

    account = _lock_contract_account(db, user_id=int(order.user_id), margin_asset="USDT")
    now = datetime.utcnow()

    quantity = _q18(order.quantity)
    leverage = int(order.leverage or 0)
    if quantity <= Decimal("0") or leverage <= 0:
        raise ContractOrderBadRequest("INVALID_ORDER_QUANTITY_OR_LEVERAGE")

    fill_price = _limit_fill_price(action="OPEN", position_side=position_side, bid_price=bid_price, ask_price=ask_price)
    spread_x_snapshot = _quote_spread_x(quote, order.spread_x_snapshot)
    spread_fee_amount = _contract_spread_fee(spread_x=spread_x_snapshot, quantity=quantity)
    actual_margin_amount = quantity * fill_price / Decimal(leverage)

    old_frozen_total = _q18(order.margin_amount)
    required_total = actual_margin_amount
    before_available = _q18(account.available_margin)
    before_frozen = _q18(account.frozen_margin)
    before_position_margin = _q18(account.position_margin)

    if before_frozen < old_frozen_total:
        raise ContractOrderInsufficientMargin("CONTRACT_FROZEN_MARGIN_NOT_ENOUGH")
    if required_total > old_frozen_total and before_available < (required_total - old_frozen_total):
        raise ContractOrderInsufficientMargin("INSUFFICIENT_CONTRACT_MARGIN")

    after_available = before_available + old_frozen_total - required_total
    after_frozen = before_frozen - old_frozen_total
    if after_frozen < Decimal("0"):
        raise ContractOrderInsufficientMargin("CONTRACT_FROZEN_MARGIN_NOT_ENOUGH")

    account.available_margin = after_available
    account.frozen_margin = after_frozen
    account.position_margin = before_position_margin + actual_margin_amount
    account.version = int(account.version or 0) + 1
    account.updated_at = now

    order.margin_amount = actual_margin_amount
    order.fee_amount = Decimal("0")
    order.spread_x_snapshot = spread_x_snapshot
    order.spread_fee = spread_fee_amount
    order.filled_quantity = quantity
    order.avg_price = fill_price
    order.status = "FILLED"
    order.updated_at = now

    order_side = "BUY" if position_side == "LONG" else "SELL"
    position = ContractPosition(
        user_id=int(order.user_id),
        symbol=symbol,
        side=position_side,
        margin_mode="ISOLATED",
        leverage=leverage,
        quantity=quantity,
        entry_price=fill_price,
        mark_price=mark_price,
        margin_amount=actual_margin_amount,
        open_fee=Decimal("0"),
        unrealized_pnl=Decimal("0"),
        realized_pnl=Decimal("0"),
        liquidation_price=Decimal("0"),
        warning_price=Decimal("0"),
        take_profit_price=order.take_profit_price,
        stop_loss_price=order.stop_loss_price,
        status="OPEN",
        opened_at=now,
        closed_at=None,
        created_at=now,
        updated_at=now,
    )
    db.add(position)
    db.flush()
    order.position_id = int(position.id)

    trade = ContractTrade(
        trade_no=_build_trade_no(now),
        order_id=int(order.id),
        position_id=int(position.id),
        user_id=int(order.user_id),
        symbol=symbol,
        side=order_side,
        position_side=position_side,
        action="OPEN",
        price=fill_price,
        quantity=quantity,
        notional=fill_price * quantity,
        leverage=leverage,
        margin_amount=actual_margin_amount,
        fee_amount=Decimal("0"),
        spread_fee=spread_fee_amount,
        realized_pnl=Decimal("0"),
        created_at=now,
    )
    db.add(trade)
    db.flush()
    trade_id = int(trade.id)
    add_contract_margin_log(
        db,
        user_id=int(order.user_id),
        account_id=int(account.id),
        position_id=int(position.id),
        order_id=int(order.id),
        trade_id=trade_id,
        symbol=symbol,
        change_type="OPEN_MARGIN_USED",
        change_amount=actual_margin_amount,
        before_available=before_available,
        after_available=after_available,
        before_frozen=before_frozen,
        after_frozen=after_frozen,
        remark="limit open order margin used",
        now=now,
    )
    add_contract_balance_log(
        db,
        user_id=int(order.user_id),
        change_type="CONTRACT_OPEN_MARGIN",
        biz_type="CONTRACT_OPEN_MARGIN",
        biz_id=f"order:{int(order.id)}:fill_open_margin",
        change_amount=-actual_margin_amount,
        trade_id=trade_id,
        before_available=before_available,
        after_available=after_available,
        before_frozen=before_frozen,
        after_frozen=after_frozen,
        remark="limit open order margin used",
        now=now,
    )
    return int(position.id)


def _fill_close_order_locked(
    db: Session,
    *,
    order: ContractOrder,
    position: ContractPosition,
    quote: dict[str, Any],
    close_reason: Optional[str] = None,
) -> tuple[Decimal, Decimal, Decimal]:
    if order.action != "CLOSE" or order.order_type not in {"MARKET", "LIMIT"}:
        raise ContractOrderBadRequest("INVALID_CLOSE_ORDER")
    if order.status not in {"NEW", "OPEN", "PARTIALLY_FILLED"}:
        raise ContractOrderBadRequest("ORDER_NOT_OPEN")
    if position.status != "OPEN" or _q18(position.quantity) <= Decimal("0"):
        raise ContractPositionNotOpen("POSITION_NOT_OPEN")
    if int(order.position_id or 0) != int(position.id):
        raise ContractOrderBadRequest("ORDER_POSITION_MISMATCH")

    position_side = str(position.side or "").upper()
    if position_side not in {"LONG", "SHORT"}:
        raise ContractOrderBadRequest("INVALID_POSITION_SIDE")

    _require_execution_quote(
        quote,
        context="close_fill",
        symbol=_normalize_symbol(order.symbol),
        order_id=getattr(order, "id", None),
        position_id=getattr(position, "id", None),
        user_id=getattr(order, "user_id", None),
    )
    bid_price = _q18(quote["bid_price"])
    ask_price = _q18(quote["ask_price"])
    mark_price = _q18(quote["mark_price"])
    if order.order_type == "LIMIT":
        limit_price = _normalize_price(order.price, required=True)
        if not _is_limit_order_triggered(
            action="CLOSE",
            position_side=position_side,
            limit_price=limit_price,
            bid_price=bid_price,
            ask_price=ask_price,
        ):
            return Decimal("0"), Decimal("0"), _q18(position.quantity)

    position_quantity = _q18(position.quantity)
    close_quantity = _q18(order.quantity)
    if close_quantity <= Decimal("0") or close_quantity > position_quantity:
        raise ContractOrderBadRequest("CLOSE_QUANTITY_EXCEEDS_POSITION")

    close_price = _limit_fill_price(action="CLOSE", position_side=position_side, bid_price=bid_price, ask_price=ask_price)
    spread_x_snapshot = _quote_spread_x(quote, order.spread_x_snapshot)
    close_spread_fee_amount = _contract_spread_fee(spread_x=spread_x_snapshot, quantity=close_quantity)
    entry_price = _q18(position.entry_price)
    old_margin_amount = _q18(position.margin_amount)
    release_margin = old_margin_amount * close_quantity / position_quantity
    if close_quantity == position_quantity:
        release_margin = old_margin_amount

    realized_pnl = _calculate_realized_pnl(
        position_side=position_side,
        entry_price=entry_price,
        close_price=close_price,
        close_quantity=close_quantity,
    )
    pnl_capped = False
    if realized_pnl < -release_margin:
        realized_pnl = -release_margin
        pnl_capped = True

    now = datetime.utcnow()
    account = _lock_contract_account(db, user_id=int(order.user_id), margin_asset="USDT")
    before_available = _q18(account.available_margin)
    before_frozen = _q18(account.frozen_margin)
    before_position_margin = _q18(account.position_margin)

    settlement_amount = release_margin + realized_pnl
    if settlement_amount < Decimal("0"):
        settlement_amount = Decimal("0")

    after_available_after_pnl = before_available + settlement_amount
    after_available = after_available_after_pnl
    if after_available < Decimal("0"):
        raise ContractOrderInsufficientMargin("INSUFFICIENT_CONTRACT_MARGIN")
    after_position_margin = before_position_margin - release_margin
    if after_position_margin < Decimal("0"):
        after_position_margin = Decimal("0")

    account.available_margin = after_available
    account.position_margin = after_position_margin
    account.realized_pnl = _q18(account.realized_pnl) + realized_pnl
    account.version = int(account.version or 0) + 1
    account.updated_at = now

    before_position_realized = _q18(position.realized_pnl)
    remaining_quantity = position_quantity - close_quantity
    remaining_margin = old_margin_amount - release_margin
    if remaining_quantity < Decimal("0"):
        remaining_quantity = Decimal("0")
    if remaining_margin < Decimal("0"):
        remaining_margin = Decimal("0")
    if close_quantity == position_quantity or remaining_quantity == Decimal("0"):
        remaining_quantity = Decimal("0")
        remaining_margin = Decimal("0")
        position.status = "CLOSED"
        position.close_reason = close_reason
        position.closed_at = now

    position.quantity = remaining_quantity
    position.margin_amount = remaining_margin
    position.realized_pnl = before_position_realized + realized_pnl
    position.mark_price = mark_price
    position.updated_at = now

    order.filled_quantity = close_quantity
    order.avg_price = close_price
    order.margin_amount = release_margin
    order.fee_amount = Decimal("0")
    order.spread_x_snapshot = spread_x_snapshot
    order.spread_fee = close_spread_fee_amount
    order.status = "FILLED"
    order.fail_reason = close_reason
    order.updated_at = now

    order_side = "SELL" if position_side == "LONG" else "BUY"
    trade = ContractTrade(
        trade_no=_build_trade_no(now),
        order_id=int(order.id),
        position_id=int(position.id),
        user_id=int(order.user_id),
        symbol=order.symbol,
        side=order_side,
        position_side=position_side,
        action="CLOSE",
        price=close_price,
        quantity=close_quantity,
        notional=close_price * close_quantity,
        leverage=int(position.leverage),
        margin_amount=release_margin,
        fee_amount=Decimal("0"),
        spread_fee=close_spread_fee_amount,
        realized_pnl=realized_pnl,
        created_at=now,
    )
    db.add(trade)
    db.flush()
    trade_id = int(trade.id)

    conceptual_after_release = before_available + release_margin
    add_contract_margin_log(
        db,
        user_id=int(order.user_id),
        account_id=int(account.id),
        position_id=int(position.id),
        order_id=int(order.id),
        trade_id=trade_id,
        symbol=order.symbol,
        change_type="CLOSE_RELEASE",
        change_amount=release_margin,
        before_available=before_available,
        after_available=conceptual_after_release,
        before_frozen=before_frozen,
        after_frozen=before_frozen,
        remark="contract close margin release",
        now=now,
    )
    add_contract_balance_log(
        db,
        user_id=int(order.user_id),
        change_type="CONTRACT_MARGIN_RELEASE",
        biz_type="CONTRACT_MARGIN_RELEASE",
        biz_id=f"order:{int(order.id)}:close_margin_release",
        change_amount=release_margin,
        trade_id=trade_id,
        before_available=before_available,
        after_available=conceptual_after_release,
        before_frozen=before_frozen,
        after_frozen=before_frozen,
        remark="contract close margin release",
        now=now,
    )
    add_contract_margin_log(
        db,
        user_id=int(order.user_id),
        account_id=int(account.id),
        position_id=int(position.id),
        order_id=int(order.id),
        trade_id=trade_id,
        symbol=order.symbol,
        change_type="REALIZED_PNL",
        change_amount=realized_pnl,
        before_available=conceptual_after_release,
        after_available=after_available_after_pnl,
        before_frozen=before_frozen,
        after_frozen=before_frozen,
        remark="pnl capped by margin" if pnl_capped else "close realized pnl",
        now=now,
    )
    add_contract_balance_log(
        db,
        user_id=int(order.user_id),
        change_type="CONTRACT_REALIZED_PNL",
        biz_type="CONTRACT_REALIZED_PNL",
        biz_id=f"order:{int(order.id)}:close_realized_pnl",
        change_amount=realized_pnl,
        trade_id=trade_id,
        before_available=conceptual_after_release,
        after_available=after_available_after_pnl,
        before_frozen=before_frozen,
        after_frozen=before_frozen,
        remark="pnl capped by margin" if pnl_capped else "close realized pnl",
        now=now,
    )
    return realized_pnl, release_margin, remaining_quantity


def close_contract_position(
    db: Session,
    user_id: int,
    request: ContractCloseOrderRequest,
    close_reason: Optional[str] = None,
    *,
    commit: bool = True,
    quote_override: Optional[dict[str, Any]] = None,
) -> ContractOrderResponse:
    if int(request.position_id or 0) <= 0:
        raise ContractOrderBadRequest("POSITION_ID_REQUIRED")

    order_type = str(request.order_type or "").upper()
    if order_type not in {"MARKET", "LIMIT"}:
        raise ContractOrderBadRequest("INVALID_ORDER_TYPE")
    limit_price = _normalize_price(request.price, required=order_type == "LIMIT")

    position = _load_open_position(db, user_id=int(user_id), position_id=int(request.position_id), lock=False)
    symbol = _normalize_symbol(position.symbol)
    contract_symbol = _load_enabled_contract_symbol(db, symbol)

    if quote_override is None:
        try:
            quote = _load_contract_execution_quote(
                db,
                symbol,
                context="market_close" if order_type == "MARKET" else "limit_close_reference",
                require_executable=order_type == "MARKET",
                position_id=request.position_id,
                user_id=user_id,
            )
        except ContractQuoteNotLive as exc:
            _raise_close_quote_not_live(exc)
        except Exception as exc:
            raise ContractOrderQuoteUnavailable("CONTRACT_QUOTE_UNAVAILABLE") from exc
    else:
        quote = quote_override

    bid_price = _q18(quote["bid_price"])
    ask_price = _q18(quote["ask_price"])
    mark_price = _q18(quote["mark_price"])
    if order_type == "MARKET" and (bid_price <= 0 or ask_price <= 0):
        raise ContractOrderQuoteUnavailable("CONTRACT_QUOTE_UNAVAILABLE")

    quote_is_executable = _execution_quote_is_executable(quote)
    execution_quote = quote
    if order_type == "MARKET":
        try:
            _require_execution_quote(
                quote,
                context="market_close",
                symbol=symbol,
                position_id=request.position_id,
                user_id=user_id,
            )
        except ContractQuoteNotLive as exc:
            _raise_close_quote_not_live(exc)

    # Re-lock after quote so stale requests cannot close an already closed or depleted position.
    position = _load_open_position(db, user_id=int(user_id), position_id=int(request.position_id), lock=True)
    position_quantity = _q18(position.quantity)
    close_quantity = _normalize_close_quantity(request.quantity, position_quantity=position_quantity)
    position_side = str(position.side or "").upper()
    if position_side not in {"LONG", "SHORT"}:
        raise ContractOrderBadRequest("INVALID_POSITION_SIDE")

    _ensure_no_open_close_order(db, user_id=int(user_id), position_id=int(position.id))

    if order_type == "LIMIT" and not quote_is_executable:
        should_fill = False
        close_price = limit_price
    else:
        should_fill, close_price = _decide_close_execution(
            position_side=position_side,
            order_type=order_type,
            limit_price=limit_price,
            bid_price=bid_price,
            ask_price=ask_price,
        )

    old_margin_amount = _q18(position.margin_amount)
    release_margin = old_margin_amount * close_quantity / position_quantity
    if close_quantity == position_quantity:
        release_margin = old_margin_amount

    now = datetime.utcnow()
    order_side = "SELL" if position_side == "LONG" else "BUY"
    order = ContractOrder(
        order_no=_build_order_no(now),
        user_id=int(user_id),
        position_id=int(position.id),
        symbol=symbol,
        side=order_side,
        position_side=position_side,
        action="CLOSE",
        order_type=order_type,
        price=limit_price,
        quantity=close_quantity,
        leverage=int(position.leverage),
        margin_amount=release_margin,
        fee_amount=Decimal("0"),
        spread_x_snapshot=_quote_spread_x(quote, contract_symbol.spread_x),
        spread_fee=Decimal("0"),
        trigger_price=None,
        take_profit_price=None,
        stop_loss_price=None,
        filled_quantity=Decimal("0"),
        avg_price=Decimal("0"),
        status="OPEN",
        fail_reason=close_reason,
        created_at=now,
        updated_at=now,
    )
    db.add(order)
    db.flush()

    remaining_quantity = position_quantity
    if not should_fill:
        if commit:
            try:
                db.commit()
            except IntegrityError as exc:
                db.rollback()
                raise ContractOrderBadRequest("CONTRACT_CLOSE_ORDER_FAILED") from exc
            db.refresh(order)
        else:
            db.flush()
        return _response_from_order(
            order,
            int(position.id),
            realized_pnl=Decimal("0"),
            released_margin=Decimal("0"),
            remaining_position_quantity=remaining_quantity,
        )

    realized_pnl, release_margin, remaining_quantity = _fill_close_order_locked(
        db,
        order=order,
        position=position,
        quote=execution_quote,
        close_reason=close_reason,
    )

    if commit:
        try:
            db.commit()
        except IntegrityError as exc:
            db.rollback()
            raise ContractOrderBadRequest("CONTRACT_CLOSE_ORDER_FAILED") from exc
        db.refresh(order)
    else:
        db.flush()
    return _response_from_order(
        order,
        int(position.id),
        realized_pnl=realized_pnl,
        released_margin=release_margin,
        remaining_position_quantity=remaining_quantity,
    )


def close_contract_position_summary(
    db: Session,
    user_id: int,
    request: ContractCloseSummaryOrderRequest,
) -> ContractCloseSummaryOrderResponse:
    symbol = _normalize_symbol(request.symbol)
    position_side = str(request.side or "").upper()
    order_type = str(request.order_type or "").upper()
    if not symbol:
        raise ContractOrderBadRequest("SYMBOL_REQUIRED")
    if position_side not in {"LONG", "SHORT"}:
        raise ContractOrderBadRequest("INVALID_POSITION_SIDE")
    if order_type not in {"MARKET", "LIMIT"}:
        raise ContractOrderBadRequest("INVALID_ORDER_TYPE")

    _load_enabled_contract_symbol(db, symbol)
    _normalize_price(request.price, required=order_type == "LIMIT")
    quote: Optional[dict[str, Any]] = None
    if order_type == "MARKET":
        try:
            quote = _load_contract_execution_quote(
                db,
                symbol,
                context="market_close_summary",
                require_executable=True,
                user_id=user_id,
            )
        except ContractQuoteNotLive as exc:
            _raise_close_quote_not_live(exc)
        except Exception as exc:
            raise ContractOrderQuoteUnavailable("CONTRACT_QUOTE_UNAVAILABLE") from exc

    positions = (
        db.query(ContractPosition)
        .filter(ContractPosition.user_id == int(user_id))
        .filter(ContractPosition.symbol == symbol)
        .filter(ContractPosition.side == position_side)
        .filter(ContractPosition.status == "OPEN")
        .filter(ContractPosition.quantity > 0)
        .order_by(ContractPosition.opened_at.asc(), ContractPosition.id.asc())
        .with_for_update()
        .all()
    )
    if not positions:
        raise ContractPositionNotOpen("POSITION_NOT_OPEN")

    total_quantity = sum((_q18(position.quantity) for position in positions), Decimal("0"))
    if total_quantity <= Decimal("0"):
        raise ContractPositionNotOpen("POSITION_NOT_OPEN")

    if request.quantity in (None, ""):
        requested_quantity = total_quantity
    else:
        requested_quantity = _normalize_quantity(request.quantity)
        if requested_quantity > total_quantity:
            raise ContractOrderBadRequest("CLOSE_QUANTITY_EXCEEDS_POSITION")

    remaining_to_close = requested_quantity
    generated_order_ids: list[int] = []
    generated_trade_ids: list[int] = []
    affected_position_ids: list[int] = []
    submitted_quantity = Decimal("0")
    closed_quantity = Decimal("0")

    try:
        for position in positions:
            if remaining_to_close <= Decimal("0"):
                break

            position_quantity = _q18(position.quantity)
            if position_quantity <= Decimal("0"):
                continue

            split_quantity = min(position_quantity, remaining_to_close)
            response = close_contract_position(
                db,
                int(user_id),
                ContractCloseOrderRequest(
                    position_id=int(position.id),
                    order_type=request.order_type,
                    price=request.price,
                    quantity=split_quantity,
                ),
                commit=False,
                quote_override=quote if order_type == "MARKET" else None,
            )

            generated_order_ids.append(int(response.order_id))
            affected_position_ids.append(int(position.id))
            submitted_quantity += split_quantity
            if response.status == "FILLED":
                closed_quantity += _q18(response.quantity)
                trades = (
                    db.query(ContractTrade.id)
                    .filter(ContractTrade.order_id == int(response.order_id))
                    .order_by(ContractTrade.id.asc())
                    .all()
                )
                generated_trade_ids.extend(int(trade_id) for (trade_id,) in trades)

            remaining_to_close -= split_quantity

        if submitted_quantity != requested_quantity:
            raise ContractOrderBadRequest("CONTRACT_CLOSE_ORDER_FAILED")

        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise ContractOrderBadRequest("CONTRACT_CLOSE_ORDER_FAILED") from exc
    except Exception:
        db.rollback()
        raise

    if closed_quantity >= requested_quantity:
        status = "FILLED"
    elif closed_quantity > Decimal("0"):
        status = "PARTIALLY_FILLED"
    else:
        status = "OPEN"

    return ContractCloseSummaryOrderResponse(
        symbol=symbol,
        side=position_side,
        order_type=order_type,
        requested_quantity=_fmt_decimal(requested_quantity),
        closed_quantity=_fmt_decimal(closed_quantity),
        submitted_quantity=_fmt_decimal(submitted_quantity),
        generated_order_ids=generated_order_ids,
        generated_trade_ids=generated_trade_ids,
        affected_position_ids=affected_position_ids,
        status=status,
    )


def _mark_order_failed(db: Session, *, order: ContractOrder, reason: str) -> None:
    now = datetime.utcnow()
    order.status = "FAILED"
    order.fail_reason = reason[:500]
    order.updated_at = now
    db.add(order)


def scan_and_execute_contract_limit_orders(db: Session, limit: int = 100) -> list[dict[str, Any]]:
    safe_limit = max(1, min(int(limit or 100), 500))
    order_ids = [
        int(row[0])
        for row in (
            db.query(ContractOrder.id)
            .filter(ContractOrder.order_type == "LIMIT")
            .filter(ContractOrder.status.in_(("NEW", "OPEN", "PARTIALLY_FILLED")))
            .order_by(ContractOrder.created_at.asc(), ContractOrder.id.asc())
            .limit(safe_limit)
            .all()
        )
    ]

    results: list[dict[str, Any]] = []
    for order_id in order_ids:
        try:
            candidate = db.query(ContractOrder).filter(ContractOrder.id == order_id).first()
            if candidate is None or candidate.status not in {"NEW", "OPEN", "PARTIALLY_FILLED"}:
                continue

            limit_price = _normalize_price(candidate.price, required=True)
            position_side = str(candidate.position_side or "").upper()
            action = str(candidate.action or "").upper()
            order_side = str(candidate.side or "").upper()
            symbol = _normalize_symbol(candidate.symbol)
            try:
                quote = _fresh_execution_quote_for_limit_scan(
                    db,
                    symbol,
                    order_id=order_id,
                    position_id=getattr(candidate, "position_id", None),
                    user_id=getattr(candidate, "user_id", None),
                )
            except Exception as exc:
                reason = getattr(exc, "code", None) or str(exc)
                expected_quote_skip = _is_expected_limit_scan_quote_skip(reason, exc)
                log_method = logger.debug if expected_quote_skip else logger.warning
                log_key = f"limit_scan_depth:{order_id}:{reason}"
                should_log = should_log_contract_quote_skip(log_key)
                if should_log:
                    log_method(
                        "contract_limit_order_scan_execution_skipped order_id=%s symbol=%s action=%s side=%s position_side=%s "
                        "limit_price=%s price_source=skipped_no_execution reason=%s error=%s user_id=%s position_id=%s",
                        order_id,
                        symbol,
                        action,
                        order_side,
                        position_side,
                        limit_price,
                        reason,
                        exc,
                        getattr(candidate, "user_id", None),
                        getattr(candidate, "position_id", None),
                    )
                db.rollback()
                continue

            bid_price = _q18(quote["bid_price"])
            ask_price = _q18(quote["ask_price"])
            triggered = _is_limit_order_triggered(
                action=action,
                position_side=position_side,
                limit_price=limit_price,
                bid_price=bid_price,
                ask_price=ask_price,
            )
            _log_limit_scan_decision(
                order_id=order_id,
                symbol=symbol,
                action=action,
                order_side=order_side,
                position_side=position_side,
                limit_price=limit_price,
                bid_price=bid_price,
                ask_price=ask_price,
                triggered=triggered,
                price_source="execution_view",
                depth_ts=quote.get("ts"),
            )
            if not triggered:
                continue

            order = (
                db.query(ContractOrder)
                .filter(ContractOrder.id == order_id)
                .with_for_update()
                .first()
            )
            if order is None or order.status not in {"NEW", "OPEN", "PARTIALLY_FILLED"}:
                db.rollback()
                continue
            if order.order_type != "LIMIT":
                db.rollback()
                continue

            # Recheck after FOR UPDATE so a concurrent cancel/fill cannot slip through.
            action = str(order.action or "").upper()
            position_side = str(order.position_side or "").upper()
            order_side = str(order.side or "").upper()
            limit_price = _normalize_price(order.price, required=True)
            triggered = _is_limit_order_triggered(
                action=action,
                position_side=position_side,
                limit_price=limit_price,
                bid_price=bid_price,
                ask_price=ask_price,
            )
            _log_limit_scan_decision(
                order_id=order_id,
                symbol=symbol,
                action=action,
                order_side=order_side,
                position_side=position_side,
                limit_price=limit_price,
                bid_price=bid_price,
                ask_price=ask_price,
                triggered=triggered,
                price_source="execution_view",
                depth_ts=quote.get("ts"),
            )
            if not triggered:
                db.rollback()
                continue

            if action == "OPEN":
                position_id = _fill_open_order_locked(db, order=order, quote=quote)
                if position_id is None:
                    db.rollback()
                    continue
                db.commit()
                trade_row = (
                    db.query(ContractTrade.id)
                    .filter(ContractTrade.order_id == int(order.id))
                    .order_by(ContractTrade.id.desc())
                    .first()
                )
                publish_contract_user_updates(
                    user_id=int(order.user_id),
                    symbols=[str(order.symbol)],
                    position_ids=[int(position_id)],
                    order_ids=[int(order.id)],
                    trade_ids=[int(trade_row[0])] if trade_row else None,
                    include_account=True,
                )
                results.append({"order_id": int(order.id), "action": "OPEN", "position_id": position_id})
                continue

            if action == "CLOSE":
                if int(order.position_id or 0) <= 0:
                    _mark_order_failed(db, order=order, reason="POSITION_ID_REQUIRED")
                    db.commit()
                    publish_contract_user_updates(
                        user_id=int(order.user_id),
                        symbols=[str(order.symbol)],
                        order_ids=[int(order.id)],
                        include_account=False,
                    )
                    results.append({"order_id": int(order.id), "action": "CLOSE", "status": "FAILED"})
                    continue

                position = (
                    db.query(ContractPosition)
                    .filter(ContractPosition.id == int(order.position_id))
                    .filter(ContractPosition.user_id == int(order.user_id))
                    .with_for_update()
                    .first()
                )
                if position is None or position.status != "OPEN" or _q18(position.quantity) <= Decimal("0"):
                    _mark_order_failed(db, order=order, reason="POSITION_NOT_OPEN")
                    db.commit()
                    publish_contract_user_updates(
                        user_id=int(order.user_id),
                        symbols=[str(order.symbol)],
                        position_ids=[int(order.position_id)] if int(order.position_id or 0) > 0 else None,
                        order_ids=[int(order.id)],
                        include_account=False,
                    )
                    results.append({"order_id": int(order.id), "action": "CLOSE", "status": "FAILED"})
                    continue

                realized_pnl, released_margin, remaining_quantity = _fill_close_order_locked(
                    db,
                    order=order,
                    position=position,
                    quote=quote,
                )
                if order.status != "FILLED":
                    db.rollback()
                    continue
                db.commit()
                trade_row = (
                    db.query(ContractTrade.id)
                    .filter(ContractTrade.order_id == int(order.id))
                    .order_by(ContractTrade.id.desc())
                    .first()
                )
                publish_contract_user_updates(
                    user_id=int(order.user_id),
                    symbols=[str(order.symbol)],
                    position_ids=[int(position.id)],
                    order_ids=[int(order.id)],
                    trade_ids=[int(trade_row[0])] if trade_row else None,
                    include_account=True,
                )
                results.append(
                    {
                        "order_id": int(order.id),
                        "action": "CLOSE",
                        "position_id": int(position.id),
                        "realized_pnl": _fmt_decimal(realized_pnl),
                        "released_margin": _fmt_decimal(released_margin),
                        "remaining_quantity": _fmt_decimal(remaining_quantity),
                    }
                )
                continue

            _mark_order_failed(db, order=order, reason="INVALID_ACTION")
            db.commit()
            publish_contract_user_updates(
                user_id=int(order.user_id),
                symbols=[str(order.symbol)],
                position_ids=[int(order.position_id)] if int(order.position_id or 0) > 0 else None,
                order_ids=[int(order.id)],
                include_account=False,
            )
            results.append({"order_id": int(order.id), "action": action, "status": "FAILED"})
        except Exception as exc:
            db.rollback()
            failed_order = None
            try:
                failed_order = db.query(ContractOrder).filter(ContractOrder.id == order_id).first()
            except Exception:
                failed_order = None
            logger.warning(
                "contract_limit_order_scan_order_failed order_id=%s symbol=%s user_id=%s position_id=%s reason=%s error=%s",
                order_id,
                getattr(failed_order, "symbol", None),
                getattr(failed_order, "user_id", None),
                getattr(failed_order, "position_id", None),
                getattr(exc, "code", None) or str(exc),
                exc,
            )
            continue

    return results
