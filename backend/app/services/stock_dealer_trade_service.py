from __future__ import annotations

import logging
import os
import random
import time
from decimal import Decimal, ROUND_DOWN
from typing import Any, Dict, List

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session, joinedload

from app.db.models.asset import UserBalance
from app.db.models.trading_pair import TradingPair
from app.schemas.order import CreateOrderRequest
from app.services.order_service import (
    DEALER_MAX_DEVIATION_RATE,
    PLATFORM_USER_ID,
    SPOT_BALANCE_CHAIN_KEY,
    create_order,
)
from app.services.stock_dealer_depth_service import (
    get_stock_trade_context,
    is_stock_dealer_pair,
)
from app.services.itick_market_service import ItickMarketRateLimited, itick_market_service

logger = logging.getLogger(__name__)

_RNG = random.SystemRandom()
_Q18 = Decimal("0.000000000000000001")
_ROUND_CURSOR = 0


def _decimal_env(name: str, default: str) -> Decimal:
    try:
        value = Decimal(str(os.getenv(name, default)).strip())
    except Exception:
        value = Decimal(default)
    return value if value > 0 else Decimal(default)


def _float_env(name: str, default: str) -> float:
    try:
        value = float(str(os.getenv(name, default)).strip())
    except Exception:
        value = float(default)
    return max(0.0, min(value, 1.0))


def _int_env(name: str, default: str, *, minimum: int, maximum: int) -> int:
    try:
        value = int(str(os.getenv(name, default)).strip())
    except Exception:
        value = int(default)
    return max(minimum, min(value, maximum))


def _quantize_down(value: Decimal, precision: int) -> Decimal:
    quant = Decimal("1").scaleb(-int(precision or 0))
    return Decimal(str(value or 0)).quantize(quant, rounding=ROUND_DOWN)


def _trade_value(value: Decimal) -> Decimal:
    return Decimal(str(value or 0)).quantize(_Q18, rounding=ROUND_DOWN)


def _stock_trade_max_bbo_ratio() -> Decimal:
    return _decimal_env("STOCK_DEALER_TRADE_MAX_BBO_RATIO", "1.02")


def _dealer_execution_guard_price(context) -> Decimal:
    for name in ("mid_price", "dealer_mid", "ref_price"):
        price = _context_decimal(context, name)
        if price > 0:
            return price
    return Decimal("0")


def _context_decimal(context, name: str) -> Decimal:
    try:
        return Decimal(str(getattr(context, name, None) or 0))
    except Exception:
        return Decimal("0")


def _is_price_within_dealer_guard(*, execution_price: Decimal, guard_price: Decimal) -> bool:
    if execution_price <= 0 or guard_price <= 0:
        return False
    return abs(execution_price - guard_price) / guard_price <= DEALER_MAX_DEVIATION_RATE


def _skip_reason_for_context(pair: TradingPair, context) -> str:
    best_bid = _context_decimal(context, "best_bid")
    best_ask = _context_decimal(context, "best_ask")
    if best_bid <= 0:
        return "best_bid_unavailable"
    if best_ask <= 0:
        return "best_ask_unavailable"
    if best_ask <= best_bid:
        return "bbo_crossed"

    bbo_ratio = best_ask / best_bid
    max_bbo_ratio = _stock_trade_max_bbo_ratio()
    if bbo_ratio > max_bbo_ratio:
        return f"bbo_ratio_abnormal:{bbo_ratio}"

    guard_price = _dealer_execution_guard_price(context)
    if guard_price <= 0:
        return "dealer_mid_unavailable"

    bid_execution = _quantize_down(best_bid, int(getattr(pair, "price_precision", 2) or 2))
    ask_execution = _quantize_down(best_ask, int(getattr(pair, "price_precision", 2) or 2))
    if not _is_price_within_dealer_guard(
        execution_price=bid_execution,
        guard_price=guard_price,
    ):
        return f"best_bid_out_of_dealer_guard:{bid_execution}/{guard_price}"
    if not _is_price_within_dealer_guard(
        execution_price=ask_execution,
        guard_price=guard_price,
    ):
        return f"best_ask_out_of_dealer_guard:{ask_execution}/{guard_price}"

    return ""


def _load_stock_dealer_pairs(db: Session) -> List[TradingPair]:
    return list(
        db.execute(
            select(TradingPair)
            .options(
                joinedload(TradingPair.base_asset),
                joinedload(TradingPair.quote_asset),
            )
            .where(
                TradingPair.asset_type == "STOCK",
                TradingPair.data_source == "ITICK",
                TradingPair.market_mode == "DEALER",
                TradingPair.status == 1,
            )
            .order_by(TradingPair.id.asc())
        )
        .scalars()
        .all()
    )


def _ensure_platform_balance(
    db: Session,
    *,
    coin_symbol: str,
    required_amount: Decimal,
) -> UserBalance:
    normalized_symbol = str(coin_symbol or "").upper().strip()
    if not normalized_symbol:
        raise ValueError("coin_symbol is required")

    stmt = (
        select(UserBalance)
        .where(
            UserBalance.user_id == PLATFORM_USER_ID,
            UserBalance.coin_symbol == normalized_symbol,
            UserBalance.chain_key == SPOT_BALANCE_CHAIN_KEY,
        )
        .with_for_update()
    )
    balance = db.execute(stmt).scalar_one_or_none()
    if balance is None:
        balance = UserBalance(
            user_id=PLATFORM_USER_ID,
            coin_symbol=normalized_symbol,
            chain_key=SPOT_BALANCE_CHAIN_KEY,
            available_amount=Decimal("0"),
            frozen_amount=Decimal("0"),
            version=1,
        )
        db.add(balance)
        db.flush()

    available_amount = Decimal(str(balance.available_amount or 0))
    required_amount = _trade_value(max(Decimal(str(required_amount or 0)), Decimal("0")))
    minimum_balance = _decimal_env("STOCK_DEALER_PLATFORM_MIN_BALANCE", "1000000")
    target_amount = max(minimum_balance, required_amount * Decimal("20"), required_amount)

    if available_amount < required_amount:
        balance.available_amount = _trade_value(target_amount)
        balance.version = int(balance.version or 0) + 1
        db.add(balance)
        db.flush()

    return balance


def _choose_amount(pair: TradingPair, price: Decimal) -> Decimal:
    min_amount = _decimal_env("STOCK_DEALER_TRADE_MIN_AMOUNT", "0.1")
    max_amount = _decimal_env("STOCK_DEALER_TRADE_MAX_AMOUNT", "5")
    if max_amount < min_amount:
        max_amount = min_amount

    span = max_amount - min_amount
    random_ratio = Decimal(str(_RNG.random()))
    amount = min_amount + span * random_ratio

    pair_min_amount = Decimal(str(getattr(pair, "min_amount", None) or "0"))
    if amount < pair_min_amount:
        amount = pair_min_amount

    min_notional = Decimal(str(getattr(pair, "min_notional", None) or "0"))
    if min_notional > 0 and price > 0 and amount * price < min_notional:
        amount = (min_notional / price) * Decimal("1.01")

    amount = _quantize_down(amount, int(getattr(pair, "amount_precision", 6) or 6))
    amount_quant = Decimal("1").scaleb(-int(getattr(pair, "amount_precision", 6) or 6))
    return max(amount, amount_quant)


def _build_market_order_payload(pair: TradingPair, context) -> CreateOrderRequest:
    side = "BUY" if _RNG.random() < 0.5 else "SELL"
    price = context.best_ask if side == "BUY" else context.best_bid
    if price is None or price <= 0:
        raise ValueError("stock dealer BBO unavailable")
    amount = _choose_amount(pair, price)

    if side == "BUY":
        quote_amount = _quantize_down(
            amount * price,
            int(getattr(pair, "price_precision", 2) or 2),
        )
        return CreateOrderRequest(
            symbol=pair.symbol,
            side=side,
            order_type="MARKET",
            quote_amount=quote_amount,
        )

    return CreateOrderRequest(
        symbol=pair.symbol,
        side=side,
        order_type="MARKET",
        amount=amount,
    )


def _required_platform_balances(pair: TradingPair, payload: CreateOrderRequest, context) -> Dict[str, Decimal]:
    if context.best_bid is None or context.best_ask is None:
        raise ValueError("stock dealer BBO unavailable")

    if payload.side == "BUY":
        quote_amount = Decimal(str(payload.quote_amount or 0))
        base_amount = _quantize_down(
            quote_amount / context.best_ask,
            int(getattr(pair, "amount_precision", 6) or 6),
        )
    else:
        base_amount = Decimal(str(payload.amount or 0))
        quote_amount = _trade_value(base_amount * context.best_bid)

    return {
        str(pair.base_asset.symbol).upper(): base_amount,
        str(pair.quote_asset.symbol).upper(): quote_amount,
    }


def run_stock_dealer_trade_once(
    db: Session,
    *,
    allow_skip: bool = False,
) -> Dict[str, Any]:
    global _ROUND_CURSOR

    all_pairs = [pair for pair in _load_stock_dealer_pairs(db) if is_stock_dealer_pair(pair)]
    max_pairs_per_round = _int_env("STOCK_DEALER_TRADE_MAX_SYMBOLS_PER_ROUND", "8", minimum=1, maximum=10)
    if all_pairs:
        start = _ROUND_CURSOR % len(all_pairs)
        rotated_pairs = all_pairs[start:] + all_pairs[:start]
        pairs = rotated_pairs[:max_pairs_per_round]
        _ROUND_CURSOR = (start + len(pairs)) % len(all_pairs)
    else:
        pairs = []

    result: Dict[str, Any] = {
        "scanned_count": len(pairs),
        "total_candidate_count": len(all_pairs),
        "created_count": 0,
        "skipped_count": 0,
        "failed_count": 0,
        "orders": [],
        "skipped": [],
        "errors": [],
    }

    skip_probability = _float_env("STOCK_DEALER_TRADE_SKIP_PROBABILITY", "0.55")

    if itick_market_service.is_quote_depth_cooldown_active():
        result["skipped_count"] = len(pairs)
        result["skipped"].append(
            {
                "reason": "itick_cooldown_active",
                "cooldown_remaining_seconds": itick_market_service.quote_depth_cooldown_remaining_seconds(),
            }
        )
        return result

    for pair in pairs:
        if itick_market_service.is_quote_depth_cooldown_active():
            result["skipped_count"] += 1
            result["skipped"].append(
                {
                    "symbol": pair.symbol,
                    "reason": "itick_cooldown_active",
                    "cooldown_remaining_seconds": itick_market_service.quote_depth_cooldown_remaining_seconds(),
                }
            )
            break

        if allow_skip and _RNG.random() < skip_probability:
            result["skipped_count"] += 1
            continue

        try:
            context = get_stock_trade_context(db=db, trading_pair=pair, limit=1)
            skip_reason = _skip_reason_for_context(pair, context)
            if skip_reason:
                result["skipped_count"] += 1
                result["skipped"].append(
                    {
                        "symbol": pair.symbol,
                        "reason": skip_reason,
                        "best_bid": str(getattr(context, "best_bid", None)),
                        "best_ask": str(getattr(context, "best_ask", None)),
                        "mid_price": str(getattr(context, "mid_price", None)),
                        "source": str(getattr(context, "source", "")),
                    }
                )
                logger.warning("stock dealer auto trade skipped for %s: %s", pair.symbol, skip_reason)
                continue

            payload = _build_market_order_payload(pair, context)
            for coin_symbol, required_amount in _required_platform_balances(pair, payload, context).items():
                _ensure_platform_balance(
                    db,
                    coin_symbol=coin_symbol,
                    required_amount=required_amount,
                )

            started_at = time.time()
            order = create_order(
                db=db,
                user_id=PLATFORM_USER_ID,
                payload=payload,
            )
            db.commit()
            result["created_count"] += 1
            result["orders"].append(
                {
                    "symbol": pair.symbol,
                    "side": order.side,
                    "order_id": int(order.id),
                    "avg_price": str(order.avg_price),
                    "amount": str(order.filled_amount),
                    "executed_quote_amount": str(order.executed_quote_amount),
                    "elapsed_ms": int((time.time() - started_at) * 1000),
                }
            )
        except HTTPException as exc:
            db.rollback()
            result["failed_count"] += 1
            result["errors"].append(
                {
                    "symbol": pair.symbol,
                    "status_code": exc.status_code,
                    "detail": exc.detail,
                }
            )
            logger.warning("stock dealer auto trade failed for %s: %s", pair.symbol, exc.detail)
        except ItickMarketRateLimited as exc:
            db.rollback()
            result["failed_count"] += 1
            result["errors"].append({"symbol": pair.symbol, "error": repr(exc), "stop_round": True})
            logger.warning(
                "stock dealer auto trade stopped by itick cooldown for %s: remaining=%ss",
                pair.symbol,
                itick_market_service.quote_depth_cooldown_remaining_seconds(),
            )
            break
        except Exception as exc:
            db.rollback()
            result["failed_count"] += 1
            result["errors"].append({"symbol": pair.symbol, "error": repr(exc)})
            logger.warning("stock dealer auto trade failed for %s: %r", pair.symbol, exc)

    return result
