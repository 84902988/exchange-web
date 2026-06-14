from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal, ROUND_DOWN
from typing import Optional

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session, joinedload

from app.db.models.asset import BalanceLog, UserBalance
from app.db.models.order import Order
from app.db.models.trade import Trade
from app.db.models.trading_pair import TradingPair
from app.schemas.order import CreateOrderRequest
from app.services.dealer_risk_service import DealerRiskRejected, check_dealer_order_risk
from app.services.binance_market_service import BinanceMarketServiceError, binance_market_service
from app.services.fee_service import apply_trade_fee
from app.services.spot_order_payload import serialize_spot_order
from app.services.stock_dealer_depth_service import (
    get_stock_trade_context,
    is_stock_dealer_pair,
)


logger = logging.getLogger(__name__)

SPOT_BALANCE_CHAIN_KEY = "spot"
PLATFORM_USER_ID = 99999999
VALID_CANCEL_STATUSES = {"OPEN", "PARTIALLY_FILLED"}
ACTIVE_MATCH_STATUSES = {"OPEN", "PARTIALLY_FILLED"}
TRADE_VALUE_PRECISION = 18
DEALER_MAX_DEVIATION_RATE = Decimal("0.01")


@dataclass(frozen=True)
class DealerPriceSnapshot:
    best_bid: Optional[Decimal]
    best_ask: Optional[Decimal]
    ref_price: Optional[Decimal]
    price_source: Optional[str] = None
    spread_bps: Optional[Decimal] = None


def _generate_order_no(user_id: int) -> str:
    now = datetime.utcnow()
    return f"ORD{now.strftime('%Y%m%d%H%M%S%f')}{user_id}"


def _decimal_places(value: Decimal) -> int:
    exponent = value.as_tuple().exponent
    return abs(exponent) if exponent < 0 else 0


def _validate_precision(value: Decimal, precision: int, field_name: str) -> None:
    if _decimal_places(value) > precision:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"{field_name} precision cannot exceed {precision}",
        )


def _quantize_down(value: Decimal, precision: int) -> Decimal:
    if precision <= 0:
        return value.quantize(Decimal("1"), rounding=ROUND_DOWN)

    quant = Decimal("1").scaleb(-precision)
    return value.quantize(quant, rounding=ROUND_DOWN)


def _precision_unit(precision: int) -> Decimal:
    if precision <= 0:
        return Decimal("1")
    return Decimal("1").scaleb(-precision)


def _trade_value(value: Decimal) -> Decimal:
    return _quantize_down(value, TRADE_VALUE_PRECISION)


def _log_direction(change_amount: Decimal) -> int:
    return 1 if change_amount >= Decimal("0") else -1


def _create_balance_log(
    db: Session,
    *,
    user_id: int,
    coin_symbol: str,
    chain_key: str,
    before_available: Decimal,
    after_available: Decimal,
    before_frozen: Decimal,
    after_frozen: Decimal,
    change_amount: Decimal,
    change_type: str,
    biz_type: str,
    biz_id: str,
    remark: Optional[str] = None,
) -> None:
    db.add(
        BalanceLog(
            user_id=user_id,
            coin_symbol=coin_symbol,
            chain_key=chain_key,
            change_type=change_type,
            direction=_log_direction(change_amount),
            change_amount=change_amount,
            before_available=before_available,
            after_available=after_available,
            before_frozen=before_frozen,
            after_frozen=after_frozen,
            biz_type=biz_type,
            biz_id=biz_id,
            remark=remark,
            created_at=datetime.utcnow(),
        )
    )


def _get_trading_pair(db: Session, symbol: str) -> TradingPair:
    stmt = (
        select(TradingPair)
        .options(
            joinedload(TradingPair.base_asset),
            joinedload(TradingPair.quote_asset),
        )
        .where(TradingPair.symbol == symbol)
    )
    pair = db.execute(stmt).scalar_one_or_none()
    if not pair:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="trading pair not found",
        )
    return pair


def _get_dealer_reference_price(pair: TradingPair) -> Decimal:
    if is_stock_dealer_pair(pair):
        try:
            return get_stock_trade_context(db=None, trading_pair=pair, limit=1).mid_price
        except Exception:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="dealer reference price unavailable",
            )

    try:
        payload = binance_market_service.get_ticker(symbol=pair.symbol)
        price = Decimal(str(payload.price))
    except (BinanceMarketServiceError, ValueError, TypeError, ArithmeticError):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="dealer reference price unavailable",
        )
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="dealer reference price unavailable",
        )

    if price <= 0:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="dealer reference price unavailable",
        )

    return price


def _parse_dealer_market_price(value) -> Optional[Decimal]:
    try:
        price = Decimal(str(value))
    except (ValueError, TypeError, ArithmeticError):
        return None

    if price <= 0:
        return None

    return price


def _dealer_price_source(value: object, fallback: str) -> str:
    text = str(value or fallback).strip().upper()
    return (text or fallback)[:32]


def _dealer_ref_price_from_bbo(best_bid: Optional[Decimal], best_ask: Optional[Decimal]) -> Optional[Decimal]:
    if best_bid is not None and best_ask is not None and best_bid > 0 and best_ask > 0:
        return (best_bid + best_ask) / Decimal("2")
    return None


def _dealer_spread_bps(value: object) -> Optional[Decimal]:
    try:
        spread = Decimal(str(value))
    except (ValueError, TypeError, ArithmeticError):
        return None
    if spread < 0:
        return None
    return spread.quantize(Decimal("0.00000001"), rounding=ROUND_DOWN)


def _dealer_trade_snapshot_values(snapshot: Optional[DealerPriceSnapshot]) -> dict:
    if snapshot is None:
        return {
            "dealer_ref_price": None,
            "dealer_best_bid": None,
            "dealer_best_ask": None,
            "dealer_price_source": None,
            "dealer_spread_bps": None,
        }
    return {
        "dealer_ref_price": snapshot.ref_price,
        "dealer_best_bid": snapshot.best_bid,
        "dealer_best_ask": snapshot.best_ask,
        "dealer_price_source": snapshot.price_source,
        "dealer_spread_bps": snapshot.spread_bps,
    }


def _get_dealer_market_context(pair: TradingPair) -> DealerPriceSnapshot:
    if is_stock_dealer_pair(pair):
        try:
            context = get_stock_trade_context(db=None, trading_pair=pair, limit=1)
        except Exception:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="dealer market price unavailable",
            )
        logger.debug(
            "[stock_dealer_bbo] symbol=%s source=%s cached_age_ms=%s best_bid=%s best_ask=%s mid_price=%s",
            pair.symbol,
            context.source,
            context.cached_age_ms,
            context.best_bid,
            context.best_ask,
            context.mid_price,
        )
        ref_price = context.mid_price or _dealer_ref_price_from_bbo(context.best_bid, context.best_ask)
        return DealerPriceSnapshot(
            best_bid=context.best_bid,
            best_ask=context.best_ask,
            ref_price=ref_price,
            price_source=_dealer_price_source(context.source, "ITICK"),
            spread_bps=_dealer_spread_bps(getattr(context, "spread_bps", None)),
        )

    best_bid: Optional[Decimal] = None
    best_ask: Optional[Decimal] = None

    try:
        depth = binance_market_service.get_depth(symbol=pair.symbol, limit=5)
    except BinanceMarketServiceError:
        depth = None
    except Exception:
        depth = None

    if depth is not None:
        if depth.bids:
            best_bid = _parse_dealer_market_price(depth.bids[0].price)
        if depth.asks:
            best_ask = _parse_dealer_market_price(depth.asks[0].price)

    if best_bid is not None and best_ask is not None:
        return DealerPriceSnapshot(
            best_bid=best_bid,
            best_ask=best_ask,
            ref_price=_dealer_ref_price_from_bbo(best_bid, best_ask),
            price_source="BINANCE",
            spread_bps=None,
        )

    return DealerPriceSnapshot(
        best_bid=best_bid,
        best_ask=best_ask,
        ref_price=_get_dealer_reference_price(pair),
        price_source="BINANCE",
        spread_bps=None,
    )


def _get_user_balance_for_update(
    db: Session,
    user_id: int,
    coin_symbol: str,
    chain_key: str = SPOT_BALANCE_CHAIN_KEY,
) -> Optional[UserBalance]:
    stmt = (
        select(UserBalance)
        .where(
            UserBalance.user_id == user_id,
            UserBalance.coin_symbol == coin_symbol,
            UserBalance.chain_key == chain_key,
        )
        .with_for_update()
    )
    return db.execute(stmt).scalar_one_or_none()


def _get_or_create_user_balance_for_update(
    db: Session,
    *,
    user_id: int,
    coin_symbol: str,
    chain_key: str = SPOT_BALANCE_CHAIN_KEY,
) -> UserBalance:
    balance = _get_user_balance_for_update(
        db=db,
        user_id=user_id,
        coin_symbol=coin_symbol,
        chain_key=chain_key,
    )
    if balance is not None:
        return balance

    balance = UserBalance(
        user_id=user_id,
        coin_symbol=coin_symbol,
        chain_key=chain_key,
        available_amount=Decimal("0"),
        frozen_amount=Decimal("0"),
        version=1,
    )
    db.add(balance)
    db.flush()
    return balance


def _freeze_balance(
    db: Session,
    *,
    user_id: int,
    coin_symbol: str,
    freeze_amount: Decimal,
    chain_key: str = SPOT_BALANCE_CHAIN_KEY,
) -> UserBalance:
    balance = _get_user_balance_for_update(
        db=db,
        user_id=user_id,
        coin_symbol=coin_symbol,
        chain_key=chain_key,
    )

    if not balance:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"balance account not found: {coin_symbol}",
        )

    if balance.available_amount < freeze_amount:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"insufficient available balance: {coin_symbol}",
        )

    balance.available_amount = balance.available_amount - freeze_amount
    balance.frozen_amount = balance.frozen_amount + freeze_amount
    balance.version = balance.version + 1

    db.add(balance)
    return balance


def _release_balance(
    db: Session,
    *,
    user_id: int,
    coin_symbol: str,
    release_amount: Decimal,
    chain_key: str = SPOT_BALANCE_CHAIN_KEY,
) -> UserBalance:
    balance = _get_user_balance_for_update(
        db=db,
        user_id=user_id,
        coin_symbol=coin_symbol,
        chain_key=chain_key,
    )

    if not balance:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"balance account not found: {coin_symbol}",
        )

    if release_amount <= 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="release amount must be greater than 0",
        )

    if balance.frozen_amount < release_amount:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"insufficient frozen balance: {coin_symbol}",
        )

    balance.available_amount = balance.available_amount + release_amount
    balance.frozen_amount = balance.frozen_amount - release_amount
    balance.version = balance.version + 1

    db.add(balance)
    return balance


def _remaining_amount(order: Order, amount_precision: int) -> Decimal:
    amount = Decimal(str(order.amount or 0))
    filled_amount = Decimal(str(order.filled_amount or 0))
    remaining = _quantize_down(amount - filled_amount, amount_precision)
    return remaining if remaining > 0 else Decimal("0")


def _should_fill_dealer_limit_order(
    order: Order,
    *,
    best_bid: Optional[Decimal],
    best_ask: Optional[Decimal],
) -> bool:
    price = Decimal(str(order.price or 0))

    if price <= 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="dealer limit order price is invalid",
        )

    if order.side == "BUY":
        return best_ask is not None and price >= best_ask

    if order.side == "SELL":
        return best_bid is not None and price <= best_bid

    raise HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail="unsupported side",
    )


def _get_dealer_execution_price(
    order: Order,
    *,
    best_bid: Optional[Decimal],
    best_ask: Optional[Decimal],
) -> Optional[Decimal]:
    if order.side == "BUY":
        return best_ask

    if order.side == "SELL":
        return best_bid

    raise HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail="unsupported side",
    )


def _is_dealer_price_within_guard(
    *,
    execution_price: Decimal,
    guard_price: Decimal,
    max_deviation_rate: Decimal,
) -> bool:
    if execution_price <= 0 or guard_price <= 0:
        return False

    deviation_rate = abs(execution_price - guard_price) / guard_price
    return deviation_rate <= max_deviation_rate


def _check_dealer_execution_risk(
    db: Session,
    *,
    pair: TradingPair,
    side: str,
    order_type: str,
    amount: Decimal,
    quote_amount: Decimal,
    ref_price: Decimal,
    order_id: Optional[int] = None,
    user_id: Optional[int] = None,
    raise_on_reject: bool,
) -> bool:
    try:
        check_dealer_order_risk(
            db=db,
            symbol=pair.symbol,
            side=side,
            order_type=order_type,
            amount=amount,
            quote_amount=quote_amount,
            ref_price=ref_price,
            order_id=order_id,
            user_id=user_id,
        )
        return True
    except DealerRiskRejected as exc:
        if raise_on_reject:
            try:
                db.commit()
            except Exception:
                db.rollback()
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=str(exc),
            )
        return False


def _fill_dealer_limit_order(
    db: Session,
    *,
    order: Order,
    pair: TradingPair,
    execution_price: Decimal,
    dealer_snapshot: Optional[DealerPriceSnapshot] = None,
) -> Order:
    if order.execution_mode != "DEALER":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="order execution_mode must be DEALER",
        )

    if order.order_type != "LIMIT":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="order_type must be LIMIT",
        )

    if order.status != "OPEN":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="order status must be OPEN",
        )

    if not pair.base_asset or not pair.quote_asset:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="trading pair asset config is invalid",
        )

    amount = _remaining_amount(order, pair.amount_precision)
    execution_price = _quantize_down(execution_price, pair.price_precision)

    if amount <= 0 or execution_price <= 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="dealer limit order is invalid",
        )

    quote_amount = _trade_value(execution_price * amount)
    if quote_amount <= 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="dealer limit order quote amount is invalid",
        )

    balance_snapshots = {}

    if order.side == "BUY":
        reserved_quote_amount = _trade_value(Decimal(str(order.frozen_amount or 0)))
        user_quote_balance = _get_user_balance_for_update(
            db,
            user_id=order.user_id,
            coin_symbol=pair.quote_asset.symbol,
            chain_key=SPOT_BALANCE_CHAIN_KEY,
        )
        user_base_balance = _get_or_create_user_balance_for_update(
            db,
            user_id=order.user_id,
            coin_symbol=pair.base_asset.symbol,
            chain_key=SPOT_BALANCE_CHAIN_KEY,
        )
        platform_quote_balance = _get_or_create_user_balance_for_update(
            db,
            user_id=PLATFORM_USER_ID,
            coin_symbol=pair.quote_asset.symbol,
            chain_key=SPOT_BALANCE_CHAIN_KEY,
        )
        platform_base_balance = _get_user_balance_for_update(
            db,
            user_id=PLATFORM_USER_ID,
            coin_symbol=pair.base_asset.symbol,
            chain_key=SPOT_BALANCE_CHAIN_KEY,
        )

        if not user_quote_balance:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="user balances are missing",
            )

        if not platform_base_balance:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="platform balances are missing",
            )

        if Decimal(str(user_quote_balance.frozen_amount or 0)) < reserved_quote_amount:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"insufficient frozen balance: {pair.quote_asset.symbol}",
            )

        if reserved_quote_amount < quote_amount:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="dealer buy frozen amount is insufficient for execution price",
            )

        if Decimal(str(platform_base_balance.available_amount or 0)) < amount:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"insufficient platform balance: {pair.base_asset.symbol}",
            )

        _remember_balance_snapshot(balance_snapshots, user_quote_balance)
        _remember_balance_snapshot(balance_snapshots, user_base_balance)
        _remember_balance_snapshot(balance_snapshots, platform_quote_balance)
        _remember_balance_snapshot(balance_snapshots, platform_base_balance)

        user_quote_balance.frozen_amount = _trade_value(
            Decimal(str(user_quote_balance.frozen_amount or 0)) - reserved_quote_amount
        )
        user_quote_balance.available_amount = _trade_value(
            Decimal(str(user_quote_balance.available_amount or 0))
            + (reserved_quote_amount - quote_amount)
        )
        user_base_balance.available_amount = _trade_value(
            Decimal(str(user_base_balance.available_amount or 0)) + amount
        )
        platform_quote_balance.available_amount = _trade_value(
            Decimal(str(platform_quote_balance.available_amount or 0)) + quote_amount
        )
        platform_base_balance.available_amount = _trade_value(
            Decimal(str(platform_base_balance.available_amount or 0)) - amount
        )

        if user_quote_balance.frozen_amount < 0 or platform_base_balance.available_amount < 0:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="dealer buy settlement produced negative balances",
            )

        trade = Trade(
            trading_pair_id=pair.id,
            buy_order_id=order.id,
            sell_order_id=order.id,
            buyer_user_id=order.user_id,
            seller_user_id=PLATFORM_USER_ID,
            price=execution_price,
            amount=amount,
            quote_amount=quote_amount,
            maker_order_id=order.id,
            taker_order_id=order.id,
            counterparty_type="PLATFORM",
            **_dealer_trade_snapshot_values(dealer_snapshot),
        )

        _update_order_after_buy_trade(
            order,
            trade_amount=amount,
            trade_quote_amount=quote_amount,
            reserved_quote_amount=reserved_quote_amount,
        )
    elif order.side == "SELL":
        user_base_balance = _get_user_balance_for_update(
            db,
            user_id=order.user_id,
            coin_symbol=pair.base_asset.symbol,
            chain_key=SPOT_BALANCE_CHAIN_KEY,
        )
        user_quote_balance = _get_or_create_user_balance_for_update(
            db,
            user_id=order.user_id,
            coin_symbol=pair.quote_asset.symbol,
            chain_key=SPOT_BALANCE_CHAIN_KEY,
        )
        platform_base_balance = _get_or_create_user_balance_for_update(
            db,
            user_id=PLATFORM_USER_ID,
            coin_symbol=pair.base_asset.symbol,
            chain_key=SPOT_BALANCE_CHAIN_KEY,
        )
        platform_quote_balance = _get_user_balance_for_update(
            db,
            user_id=PLATFORM_USER_ID,
            coin_symbol=pair.quote_asset.symbol,
            chain_key=SPOT_BALANCE_CHAIN_KEY,
        )

        if not user_base_balance:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="user balances are missing",
            )

        if not platform_quote_balance:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="platform balances are missing",
            )

        if Decimal(str(user_base_balance.frozen_amount or 0)) < amount:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"insufficient frozen balance: {pair.base_asset.symbol}",
            )

        if Decimal(str(platform_quote_balance.available_amount or 0)) < quote_amount:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"insufficient platform balance: {pair.quote_asset.symbol}",
            )

        _remember_balance_snapshot(balance_snapshots, user_base_balance)
        _remember_balance_snapshot(balance_snapshots, user_quote_balance)
        _remember_balance_snapshot(balance_snapshots, platform_base_balance)
        _remember_balance_snapshot(balance_snapshots, platform_quote_balance)

        user_base_balance.frozen_amount = _trade_value(
            Decimal(str(user_base_balance.frozen_amount or 0)) - amount
        )
        user_quote_balance.available_amount = _trade_value(
            Decimal(str(user_quote_balance.available_amount or 0)) + quote_amount
        )
        platform_base_balance.available_amount = _trade_value(
            Decimal(str(platform_base_balance.available_amount or 0)) + amount
        )
        platform_quote_balance.available_amount = _trade_value(
            Decimal(str(platform_quote_balance.available_amount or 0)) - quote_amount
        )

        if user_base_balance.frozen_amount < 0 or platform_quote_balance.available_amount < 0:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="dealer sell settlement produced negative balances",
            )

        trade = Trade(
            trading_pair_id=pair.id,
            buy_order_id=order.id,
            sell_order_id=order.id,
            buyer_user_id=PLATFORM_USER_ID,
            seller_user_id=order.user_id,
            price=execution_price,
            amount=amount,
            quote_amount=quote_amount,
            maker_order_id=order.id,
            taker_order_id=order.id,
            counterparty_type="PLATFORM",
            **_dealer_trade_snapshot_values(dealer_snapshot),
        )

        _update_order_after_sell_trade(
            order,
            trade_amount=amount,
            trade_quote_amount=quote_amount,
        )
    else:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="unsupported side",
        )

    db.add(trade)
    db.flush()

    _append_balance_logs_from_snapshots(
        db,
        snapshots=balance_snapshots,
        biz_id=str(order.id),
        remark_prefix="dealer limit settlement",
    )
    apply_trade_fee(
        db,
        pair=pair,
        order=order,
        trade=trade,
        side=order.side,
        role="MAKER",
    )

    db.add(order)
    db.flush()
    db.refresh(order)
    return order


def _market_counter_orders(
    db: Session,
    *,
    pair_id: int,
    side: str,
    user_id: int,
):
    stmt = (
        select(Order)
        .where(
            Order.trading_pair_id == pair_id,
            Order.order_type == "LIMIT",
            Order.status.in_(ACTIVE_MATCH_STATUSES),
            Order.user_id != user_id,
        )
        .with_for_update()
    )

    if side == "BUY":
        stmt = stmt.where(Order.side == "SELL").order_by(Order.price.asc(), Order.id.asc())
    else:
        stmt = stmt.where(Order.side == "BUY").order_by(Order.price.desc(), Order.id.asc())

    return list(db.execute(stmt).scalars().all())


def _remember_balance_snapshot(snapshots: dict, balance: UserBalance) -> None:
    key = (int(balance.user_id), str(balance.coin_symbol), str(balance.chain_key))
    if key in snapshots:
        return

    snapshots[key] = {
        "balance": balance,
        "before_available": Decimal(str(balance.available_amount or 0)),
        "before_frozen": Decimal(str(balance.frozen_amount or 0)),
    }


def _append_balance_logs_from_snapshots(
    db: Session,
    *,
    snapshots: dict,
    biz_id: str,
    remark_prefix: str,
) -> None:
    for item in snapshots.values():
        balance = item["balance"]
        before_available = item["before_available"]
        before_frozen = item["before_frozen"]
        after_available = Decimal(str(balance.available_amount or 0))
        after_frozen = Decimal(str(balance.frozen_amount or 0))

        if before_available == after_available and before_frozen == after_frozen:
            continue

        change_amount = (after_available + after_frozen) - (before_available + before_frozen)

        _create_balance_log(
            db,
            user_id=int(balance.user_id),
            coin_symbol=str(balance.coin_symbol),
            chain_key=str(balance.chain_key),
            before_available=before_available,
            after_available=after_available,
            before_frozen=before_frozen,
            after_frozen=after_frozen,
            change_amount=change_amount,
            change_type="TRADE",
            biz_type="TRADE",
            biz_id=biz_id,
            remark=remark_prefix,
        )


def _update_order_after_buy_trade(
    order: Order,
    *,
    trade_amount: Decimal,
    trade_quote_amount: Decimal,
    reserved_quote_amount: Decimal,
) -> None:
    old_filled = Decimal(str(order.filled_amount or 0))
    old_executed_quote = Decimal(str(order.executed_quote_amount or 0))
    old_frozen = Decimal(str(order.frozen_amount or 0))

    new_filled = _trade_value(old_filled + trade_amount)
    new_executed_quote = _trade_value(old_executed_quote + trade_quote_amount)
    new_frozen = _trade_value(old_frozen - reserved_quote_amount)

    if new_frozen < 0:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="buy order frozen amount became negative",
        )

    order.filled_amount = new_filled
    order.executed_quote_amount = new_executed_quote
    order.frozen_amount = new_frozen
    order.avg_price = _trade_value(new_executed_quote / new_filled) if new_filled > 0 else Decimal("0")

    total_amount = Decimal(str(order.amount or 0))
    if new_filled >= total_amount:
        order.status = "FILLED"
    elif new_filled > 0:
        order.status = "PARTIALLY_FILLED"
    else:
        order.status = "OPEN"


def _update_order_after_sell_trade(
    order: Order,
    *,
    trade_amount: Decimal,
    trade_quote_amount: Decimal,
) -> None:
    old_filled = Decimal(str(order.filled_amount or 0))
    old_executed_quote = Decimal(str(order.executed_quote_amount or 0))
    old_frozen = Decimal(str(order.frozen_amount or 0))

    new_filled = _trade_value(old_filled + trade_amount)
    new_executed_quote = _trade_value(old_executed_quote + trade_quote_amount)
    new_frozen = _trade_value(old_frozen - trade_amount)

    if new_frozen < 0:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="sell order frozen amount became negative",
        )

    order.filled_amount = new_filled
    order.executed_quote_amount = new_executed_quote
    order.frozen_amount = new_frozen
    order.avg_price = _trade_value(new_executed_quote / new_filled) if new_filled > 0 else Decimal("0")

    total_amount = Decimal(str(order.amount or 0))
    if new_filled >= total_amount:
        order.status = "FILLED"
    elif new_filled > 0:
        order.status = "PARTIALLY_FILLED"
    else:
        order.status = "OPEN"


def _build_market_buy_plan(
    db: Session,
    *,
    pair: TradingPair,
    user_id: int,
    quote_amount: Decimal,
):
    makers = _market_counter_orders(
        db,
        pair_id=pair.id,
        side="BUY",
        user_id=user_id,
    )
    fills = []
    remaining_quote = _trade_value(quote_amount)

    for maker in makers:
        maker_price = Decimal(str(maker.price or 0))
        maker_remaining = _remaining_amount(maker, pair.amount_precision)

        if maker_price <= 0 or maker_remaining <= 0:
            continue

        max_fill_amount = _quantize_down(remaining_quote / maker_price, pair.amount_precision)
        trade_amount = _quantize_down(min(maker_remaining, max_fill_amount), pair.amount_precision)

        if trade_amount <= 0:
            continue

        trade_quote_amount = _trade_value(maker_price * trade_amount)
        if trade_quote_amount <= 0:
            continue

        fills.append(
            {
                "maker": maker,
                "price": maker_price,
                "amount": trade_amount,
                "quote_amount": trade_quote_amount,
            }
        )
        remaining_quote = _trade_value(remaining_quote - trade_quote_amount)

        if remaining_quote <= _precision_unit(TRADE_VALUE_PRECISION):
            break

    executed_amount = _trade_value(sum((item["amount"] for item in fills), Decimal("0")))
    executed_quote_amount = _trade_value(sum((item["quote_amount"] for item in fills), Decimal("0")))

    return fills, executed_amount, executed_quote_amount, remaining_quote


def _build_market_sell_plan(
    db: Session,
    *,
    pair: TradingPair,
    user_id: int,
    amount: Decimal,
):
    makers = _market_counter_orders(
        db,
        pair_id=pair.id,
        side="SELL",
        user_id=user_id,
    )
    fills = []
    remaining_amount = _quantize_down(amount, pair.amount_precision)

    for maker in makers:
        maker_price = Decimal(str(maker.price or 0))
        maker_remaining = _remaining_amount(maker, pair.amount_precision)

        if maker_price <= 0 or maker_remaining <= 0:
            continue

        trade_amount = _quantize_down(min(maker_remaining, remaining_amount), pair.amount_precision)
        if trade_amount <= 0:
            continue

        trade_quote_amount = _trade_value(maker_price * trade_amount)
        if trade_quote_amount <= 0:
            continue

        fills.append(
            {
                "maker": maker,
                "price": maker_price,
                "amount": trade_amount,
                "quote_amount": trade_quote_amount,
            }
        )
        remaining_amount = _quantize_down(remaining_amount - trade_amount, pair.amount_precision)

        if remaining_amount <= 0:
            break

    executed_quote_amount = _trade_value(sum((item["quote_amount"] for item in fills), Decimal("0")))

    return fills, executed_quote_amount, remaining_amount


def _create_limit_order(
    db: Session,
    *,
    user_id: int,
    payload: CreateOrderRequest,
) -> Order:
    pair = _get_trading_pair(db, payload.symbol)

    if pair.status != 1:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="trading pair is not active",
        )

    if not pair.base_asset or not pair.quote_asset:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="trading pair asset config is invalid",
        )

    if pair.base_asset.enabled != 1 or pair.quote_asset.enabled != 1:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="trading pair assets are disabled",
        )

    if pair.market_mode == "DEALER":
        execution_mode = "DEALER"
    else:
        execution_mode = "MATCHING"

    if payload.amount is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="LIMIT order requires amount",
        )

    if payload.price is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="LIMIT order requires price",
        )

    _validate_precision(payload.amount, pair.amount_precision, "amount")
    _validate_precision(payload.price, pair.price_precision, "price")

    amount = _quantize_down(payload.amount, pair.amount_precision)
    price = _quantize_down(payload.price, pair.price_precision)

    if amount <= 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="amount must be greater than 0",
        )

    if price <= 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="price must be greater than 0",
        )

    if amount < pair.min_amount:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"amount is below min_amount {pair.min_amount}",
        )

    notional = _trade_value(price * amount)
    if notional < pair.min_notional:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"order notional is below min_notional {pair.min_notional}",
        )

    if payload.side == "BUY":
        freeze_coin_symbol = pair.quote_asset.symbol
        freeze_amount = notional
        fee_asset_id = pair.quote_asset_id
    elif payload.side == "SELL":
        freeze_coin_symbol = pair.base_asset.symbol
        freeze_amount = amount
        fee_asset_id = pair.quote_asset_id
    else:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="unsupported side",
        )

    if freeze_amount <= 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="freeze amount must be greater than 0",
        )

    try:
        _freeze_balance(
            db=db,
            user_id=user_id,
            coin_symbol=freeze_coin_symbol,
            freeze_amount=freeze_amount,
            chain_key=SPOT_BALANCE_CHAIN_KEY,
        )

        order = Order(
            order_no=_generate_order_no(user_id),
            user_id=user_id,
            trading_pair_id=pair.id,
            side=payload.side,
            order_type=payload.order_type,
            execution_mode=execution_mode,
            price=price,
            amount=amount,
            filled_amount=Decimal("0"),
            avg_price=Decimal("0"),
            frozen_amount=freeze_amount,
            executed_quote_amount=Decimal("0"),
            fee_amount=Decimal("0"),
            fee_asset_id=fee_asset_id,
            status="OPEN",
            source="WEB",
        )

        db.add(order)
        db.flush()
        db.refresh(order)

        return order

    except HTTPException:
        db.rollback()
        raise
    except Exception:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="failed to create order",
        )


def _create_market_order(
    db: Session,
    *,
    user_id: int,
    payload: CreateOrderRequest,
) -> Order:
    logger.debug("[_create_market_order] entered symbol=%s side=%s", payload.symbol, payload.side)
    pair = _get_trading_pair(db, payload.symbol)

    if pair.status != 1:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="trading pair is not active",
        )

    if not pair.base_asset or not pair.quote_asset:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="trading pair asset config is invalid",
        )

    if pair.base_asset.enabled != 1 or pair.quote_asset.enabled != 1:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="trading pair assets are disabled",
        )

    if pair.market_mode == "DEALER":
        execution_mode = "DEALER"
    else:
        execution_mode = "MATCHING"

    extra_private_updates = []
    fee_applications = []

    try:
        if payload.side == "BUY":
            if payload.quote_amount is None:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="MARKET BUY requires quote_amount",
                )

            _validate_precision(payload.quote_amount, TRADE_VALUE_PRECISION, "quote_amount")
            quote_amount = _trade_value(payload.quote_amount)

            if quote_amount <= 0:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="quote_amount must be greater than 0",
                )

            if quote_amount < pair.min_notional:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"quote_amount is below min_notional {pair.min_notional}",
                )

            fills, executed_amount, executed_quote_amount, remaining_quote = _build_market_buy_plan(
                db,
                pair=pair,
                user_id=user_id,
                quote_amount=quote_amount,
            )

            if not fills or executed_amount <= 0:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="当前无可成交卖盘",
                )

            remaining_quote_liquidity_threshold = max(
                _precision_unit(TRADE_VALUE_PRECISION),
                Decimal(str(pair.min_notional or 0)),
            )
            if remaining_quote >= remaining_quote_liquidity_threshold:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="当前盘口流动性不足",
                )

            _freeze_balance(
                db=db,
                user_id=user_id,
                coin_symbol=pair.quote_asset.symbol,
                freeze_amount=quote_amount,
                chain_key=SPOT_BALANCE_CHAIN_KEY,
            )

            order = Order(
                order_no=_generate_order_no(user_id),
                user_id=user_id,
                trading_pair_id=pair.id,
                side=payload.side,
                order_type=payload.order_type,
                execution_mode=execution_mode,
                price=None,
                amount=executed_amount,
                filled_amount=Decimal("0"),
                avg_price=Decimal("0"),
                frozen_amount=quote_amount,
                executed_quote_amount=Decimal("0"),
                fee_amount=Decimal("0"),
                fee_asset_id=pair.quote_asset_id,
                status="OPEN",
                source="WEB",
            )
            db.add(order)
            db.flush()

            balance_snapshots = {}
            buyer_quote_balance = _get_user_balance_for_update(
                db,
                user_id=user_id,
                coin_symbol=pair.quote_asset.symbol,
                chain_key=SPOT_BALANCE_CHAIN_KEY,
            )
            buyer_base_balance = _get_or_create_user_balance_for_update(
                db,
                user_id=user_id,
                coin_symbol=pair.base_asset.symbol,
                chain_key=SPOT_BALANCE_CHAIN_KEY,
            )

            if not buyer_quote_balance:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="市价买入金额不足",
                )

            _remember_balance_snapshot(balance_snapshots, buyer_quote_balance)
            _remember_balance_snapshot(balance_snapshots, buyer_base_balance)

            touched_orders = {}

            for fill in fills:
                maker = fill["maker"]
                trade_price = fill["price"]
                trade_amount = fill["amount"]
                trade_quote = fill["quote_amount"]

                seller_base_balance = _get_user_balance_for_update(
                    db,
                    user_id=int(maker.user_id),
                    coin_symbol=pair.base_asset.symbol,
                    chain_key=SPOT_BALANCE_CHAIN_KEY,
                )
                seller_quote_balance = _get_or_create_user_balance_for_update(
                    db,
                    user_id=int(maker.user_id),
                    coin_symbol=pair.quote_asset.symbol,
                    chain_key=SPOT_BALANCE_CHAIN_KEY,
                )

                if not seller_base_balance:
                    raise HTTPException(
                        status_code=status.HTTP_400_BAD_REQUEST,
                        detail="卖盘余额不足",
                    )

                _remember_balance_snapshot(balance_snapshots, seller_base_balance)
                _remember_balance_snapshot(balance_snapshots, seller_quote_balance)

                buyer_quote_balance.frozen_amount = _trade_value(
                    Decimal(str(buyer_quote_balance.frozen_amount or 0)) - trade_quote
                )
                buyer_base_balance.available_amount = _trade_value(
                    Decimal(str(buyer_base_balance.available_amount or 0)) + trade_amount
                )
                seller_base_balance.frozen_amount = _trade_value(
                    Decimal(str(seller_base_balance.frozen_amount or 0)) - trade_amount
                )
                seller_quote_balance.available_amount = _trade_value(
                    Decimal(str(seller_quote_balance.available_amount or 0)) + trade_quote
                )

                if buyer_quote_balance.frozen_amount < 0 or seller_base_balance.frozen_amount < 0:
                    raise HTTPException(
                        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                        detail="market buy settlement produced negative balances",
                    )

                _update_order_after_sell_trade(
                    maker,
                    trade_amount=trade_amount,
                    trade_quote_amount=trade_quote,
                )
                touched_orders[int(maker.id)] = maker

                order.filled_amount = _trade_value(Decimal(str(order.filled_amount or 0)) + trade_amount)
                order.executed_quote_amount = _trade_value(
                    Decimal(str(order.executed_quote_amount or 0)) + trade_quote
                )
                order.avg_price = _trade_value(order.executed_quote_amount / order.filled_amount)

                trade = Trade(
                    trading_pair_id=pair.id,
                    buy_order_id=order.id,
                    sell_order_id=maker.id,
                    buyer_user_id=order.user_id,
                    seller_user_id=maker.user_id,
                    price=trade_price,
                    amount=trade_amount,
                    quote_amount=trade_quote,
                    maker_order_id=maker.id,
                    taker_order_id=order.id,
                )
                db.add(trade)
                db.flush()
                fee_applications.append((order, trade, "BUY", "TAKER"))
                fee_applications.append((maker, trade, "SELL", "MAKER"))

            refund_quote = _trade_value(quote_amount - Decimal(str(order.executed_quote_amount or 0)))
            if refund_quote < 0:
                raise HTTPException(
                    status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                    detail="market buy refund became negative",
                )

            if refund_quote > 0:
                buyer_quote_balance.available_amount = _trade_value(
                    Decimal(str(buyer_quote_balance.available_amount or 0)) + refund_quote
                )
                buyer_quote_balance.frozen_amount = _trade_value(
                    Decimal(str(buyer_quote_balance.frozen_amount or 0)) - refund_quote
                )

            if buyer_quote_balance.frozen_amount < 0:
                raise HTTPException(
                    status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                    detail="market buy left negative quote frozen balance",
                )

            order.status = "FILLED"
            order.frozen_amount = Decimal("0")
            order.amount = Decimal(str(order.filled_amount or 0))

            _append_balance_logs_from_snapshots(
                db,
                snapshots=balance_snapshots,
                biz_id=str(order.id),
                remark_prefix="market buy settlement",
            )
            for fee_order, fee_trade, fee_side, fee_role in fee_applications:
                apply_trade_fee(
                    db,
                    pair=pair,
                    order=fee_order,
                    trade=fee_trade,
                    side=fee_side,
                    role=fee_role,
                )

            extra_private_updates = [
                {
                    "user_id": int(maker.user_id),
                    "symbol": pair.symbol,
                    "order": serialize_spot_order(maker, pair.symbol),
                }
                for maker in touched_orders.values()
            ]

        elif payload.side == "SELL":
            if payload.amount is None:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="MARKET SELL requires amount",
                )

            _validate_precision(payload.amount, pair.amount_precision, "amount")
            amount = _quantize_down(payload.amount, pair.amount_precision)

            if amount <= 0:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="amount must be greater than 0",
                )

            if amount < pair.min_amount:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"amount is below min_amount {pair.min_amount}",
                )

            fills, executed_quote_amount, remaining_amount = _build_market_sell_plan(
                db,
                pair=pair,
                user_id=user_id,
                amount=amount,
            )

            if not fills:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="当前无可成交买盘",
                )

            if remaining_amount > 0:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="当前盘口流动性不足",
                )

            _freeze_balance(
                db=db,
                user_id=user_id,
                coin_symbol=pair.base_asset.symbol,
                freeze_amount=amount,
                chain_key=SPOT_BALANCE_CHAIN_KEY,
            )

            order = Order(
                order_no=_generate_order_no(user_id),
                user_id=user_id,
                trading_pair_id=pair.id,
                side=payload.side,
                order_type=payload.order_type,
                execution_mode=execution_mode,
                price=None,
                amount=amount,
                filled_amount=Decimal("0"),
                avg_price=Decimal("0"),
                frozen_amount=amount,
                executed_quote_amount=Decimal("0"),
                fee_amount=Decimal("0"),
                fee_asset_id=pair.quote_asset_id,
                status="OPEN",
                source="WEB",
            )
            db.add(order)
            db.flush()

            balance_snapshots = {}
            seller_base_balance = _get_user_balance_for_update(
                db,
                user_id=user_id,
                coin_symbol=pair.base_asset.symbol,
                chain_key=SPOT_BALANCE_CHAIN_KEY,
            )
            seller_quote_balance = _get_or_create_user_balance_for_update(
                db,
                user_id=user_id,
                coin_symbol=pair.quote_asset.symbol,
                chain_key=SPOT_BALANCE_CHAIN_KEY,
            )

            if not seller_base_balance:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="市价卖出数量不足",
                )

            _remember_balance_snapshot(balance_snapshots, seller_base_balance)
            _remember_balance_snapshot(balance_snapshots, seller_quote_balance)

            touched_orders = {}

            for fill in fills:
                maker = fill["maker"]
                trade_price = fill["price"]
                trade_amount = fill["amount"]
                trade_quote = fill["quote_amount"]
                reserved_quote = _trade_value(Decimal(str(maker.price or 0)) * trade_amount)
                refund_quote = _trade_value(reserved_quote - trade_quote)

                buyer_quote_balance = _get_user_balance_for_update(
                    db,
                    user_id=int(maker.user_id),
                    coin_symbol=pair.quote_asset.symbol,
                    chain_key=SPOT_BALANCE_CHAIN_KEY,
                )
                buyer_base_balance = _get_or_create_user_balance_for_update(
                    db,
                    user_id=int(maker.user_id),
                    coin_symbol=pair.base_asset.symbol,
                    chain_key=SPOT_BALANCE_CHAIN_KEY,
                )

                if not buyer_quote_balance:
                    raise HTTPException(
                        status_code=status.HTTP_400_BAD_REQUEST,
                        detail="买盘余额不足",
                    )

                _remember_balance_snapshot(balance_snapshots, buyer_quote_balance)
                _remember_balance_snapshot(balance_snapshots, buyer_base_balance)

                seller_base_balance.frozen_amount = _trade_value(
                    Decimal(str(seller_base_balance.frozen_amount or 0)) - trade_amount
                )
                seller_quote_balance.available_amount = _trade_value(
                    Decimal(str(seller_quote_balance.available_amount or 0)) + trade_quote
                )
                buyer_quote_balance.frozen_amount = _trade_value(
                    Decimal(str(buyer_quote_balance.frozen_amount or 0)) - reserved_quote
                )
                buyer_quote_balance.available_amount = _trade_value(
                    Decimal(str(buyer_quote_balance.available_amount or 0)) + refund_quote
                )
                buyer_base_balance.available_amount = _trade_value(
                    Decimal(str(buyer_base_balance.available_amount or 0)) + trade_amount
                )

                if seller_base_balance.frozen_amount < 0 or buyer_quote_balance.frozen_amount < 0:
                    raise HTTPException(
                        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                        detail="market sell settlement produced negative balances",
                    )

                _update_order_after_buy_trade(
                    maker,
                    trade_amount=trade_amount,
                    trade_quote_amount=trade_quote,
                    reserved_quote_amount=reserved_quote,
                )
                touched_orders[int(maker.id)] = maker

                order.filled_amount = _trade_value(Decimal(str(order.filled_amount or 0)) + trade_amount)
                order.executed_quote_amount = _trade_value(
                    Decimal(str(order.executed_quote_amount or 0)) + trade_quote
                )
                order.avg_price = _trade_value(order.executed_quote_amount / order.filled_amount)

                trade = Trade(
                    trading_pair_id=pair.id,
                    buy_order_id=maker.id,
                    sell_order_id=order.id,
                    buyer_user_id=maker.user_id,
                    seller_user_id=order.user_id,
                    price=trade_price,
                    amount=trade_amount,
                    quote_amount=trade_quote,
                    maker_order_id=maker.id,
                    taker_order_id=order.id,
                )
                db.add(trade)
                db.flush()
                fee_applications.append((maker, trade, "BUY", "MAKER"))
                fee_applications.append((order, trade, "SELL", "TAKER"))

            remaining_base_to_release = _quantize_down(
                Decimal(str(amount)) - Decimal(str(order.filled_amount or 0)),
                pair.amount_precision,
            )
            if remaining_base_to_release > 0:
                seller_base_balance.available_amount = _trade_value(
                    Decimal(str(seller_base_balance.available_amount or 0))
                    + remaining_base_to_release
                )
                seller_base_balance.frozen_amount = _trade_value(
                    Decimal(str(seller_base_balance.frozen_amount or 0))
                    - remaining_base_to_release
                )

                if seller_base_balance.frozen_amount < 0:
                    raise HTTPException(
                        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                        detail="market sell left negative base frozen balance",
                    )

            order.status = "FILLED"
            order.frozen_amount = Decimal("0")
            order.amount = Decimal(str(order.filled_amount or 0))

            _append_balance_logs_from_snapshots(
                db,
                snapshots=balance_snapshots,
                biz_id=str(order.id),
                remark_prefix="market sell settlement",
            )
            for fee_order, fee_trade, fee_side, fee_role in fee_applications:
                apply_trade_fee(
                    db,
                    pair=pair,
                    order=fee_order,
                    trade=fee_trade,
                    side=fee_side,
                    role=fee_role,
                )

            extra_private_updates = [
                {
                    "user_id": int(maker.user_id),
                    "symbol": pair.symbol,
                    "order": serialize_spot_order(maker, pair.symbol),
                }
                for maker in touched_orders.values()
            ]
        else:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="unsupported side",
            )

        db.add(order)
        db.flush()
        db.refresh(order)
        setattr(order, "_extra_private_updates", extra_private_updates)
        return order

    except HTTPException:
        db.rollback()
        raise
    except Exception:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="failed to create market order",
        )


def _create_dealer_limit_order(
    db: Session,
    *,
    user_id: int,
    payload: CreateOrderRequest,
    pair: TradingPair,
) -> Order:
    if pair.status != 1:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="trading pair is not active",
        )

    if not pair.base_asset or not pair.quote_asset:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="trading pair asset config is invalid",
        )

    if pair.base_asset.enabled != 1 or pair.quote_asset.enabled != 1:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="trading pair assets are disabled",
        )

    if payload.amount is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="LIMIT order requires amount",
        )

    if payload.price is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="LIMIT order requires price",
        )

    _validate_precision(payload.amount, pair.amount_precision, "amount")
    _validate_precision(payload.price, pair.price_precision, "price")

    amount = _quantize_down(payload.amount, pair.amount_precision)
    price = _quantize_down(payload.price, pair.price_precision)

    if amount <= 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="amount must be greater than 0",
        )

    if price <= 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="price must be greater than 0",
        )

    # TODO: add dealer price protection based on external reference price

    if amount < pair.min_amount:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"amount is below min_amount {pair.min_amount}",
        )

    quote_amount = _trade_value(price * amount)
    if quote_amount < pair.min_notional:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"order notional is below min_notional {pair.min_notional}",
        )

    if payload.side == "BUY":
        freeze_coin_symbol = pair.quote_asset.symbol
        freeze_amount = quote_amount
        fee_asset_id = pair.quote_asset_id
    elif payload.side == "SELL":
        freeze_coin_symbol = pair.base_asset.symbol
        freeze_amount = amount
        fee_asset_id = pair.quote_asset_id
    else:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="unsupported side",
        )

    if freeze_amount <= 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="freeze amount must be greater than 0",
        )

    try:
        _freeze_balance(
            db=db,
            user_id=user_id,
            coin_symbol=freeze_coin_symbol,
            freeze_amount=freeze_amount,
            chain_key=SPOT_BALANCE_CHAIN_KEY,
        )

        order = Order(
            order_no=_generate_order_no(user_id),
            user_id=user_id,
            trading_pair_id=pair.id,
            side=payload.side,
            order_type=payload.order_type,
            execution_mode="DEALER",
            price=price,
            amount=amount,
            filled_amount=Decimal("0"),
            avg_price=Decimal("0"),
            frozen_amount=freeze_amount,
            executed_quote_amount=Decimal("0"),
            fee_amount=Decimal("0"),
            fee_asset_id=fee_asset_id,
            status="OPEN",
            source="WEB",
        )
        db.add(order)
        db.flush()

        dealer_snapshot = _get_dealer_market_context(pair)
        best_bid = dealer_snapshot.best_bid
        best_ask = dealer_snapshot.best_ask
        guard_price = dealer_snapshot.ref_price

        if not _should_fill_dealer_limit_order(
            order,
            best_bid=best_bid,
            best_ask=best_ask,
        ):
            order.status = "OPEN"
            db.add(order)
            db.flush()
            db.refresh(order)
            return order

        execution_price = _get_dealer_execution_price(
            order,
            best_bid=best_bid,
            best_ask=best_ask,
        )
        if execution_price is None:
            order.status = "OPEN"
            db.add(order)
            db.flush()
            db.refresh(order)
            return order
        if guard_price is None or guard_price <= 0:
            order.status = "OPEN"
            db.add(order)
            db.flush()
            db.refresh(order)
            return order

        if not _is_dealer_price_within_guard(
            execution_price=execution_price,
            guard_price=guard_price,
            max_deviation_rate=DEALER_MAX_DEVIATION_RATE,
        ):
            order.status = "OPEN"
            db.add(order)
            db.flush()
            db.refresh(order)
            return order

        remaining_amount = _remaining_amount(order, pair.amount_precision)
        execution_quote_amount = _trade_value(execution_price * remaining_amount)
        if not _check_dealer_execution_risk(
            db,
            pair=pair,
            side=order.side,
            order_type=order.order_type,
            amount=remaining_amount,
            quote_amount=execution_quote_amount,
            ref_price=execution_price,
            order_id=order.id,
            user_id=order.user_id,
            raise_on_reject=False,
        ):
            order.status = "OPEN"
            db.add(order)
            db.flush()
            db.refresh(order)
            return order

        return _fill_dealer_limit_order(
            db,
            order=order,
            pair=pair,
            execution_price=execution_price,
            dealer_snapshot=dealer_snapshot,
        )

    except HTTPException:
        db.rollback()
        raise
    except Exception:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="failed to create dealer limit order",
        )


def _create_dealer_market_order(
    db: Session,
    *,
    user_id: int,
    payload: CreateOrderRequest,
    pair: TradingPair,
) -> Order:
    logger.debug("[_create_dealer_market_order] entered symbol=%s side=%s", payload.symbol, payload.side)
    if pair.status != 1:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="trading pair is not active",
        )

    if not pair.base_asset or not pair.quote_asset:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="trading pair asset config is invalid",
        )

    if pair.base_asset.enabled != 1 or pair.quote_asset.enabled != 1:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="trading pair assets are disabled",
        )

    dealer_snapshot = _get_dealer_market_context(pair)
    best_bid = dealer_snapshot.best_bid
    best_ask = dealer_snapshot.best_ask
    guard_price = dealer_snapshot.ref_price
    execution_price = None
    logger.debug(
        "[_create_dealer_market_order] best_bid=%s best_ask=%s guard_price=%s",
        best_bid,
        best_ask,
        guard_price,
    )

    if payload.side == "BUY":
        execution_price = best_ask
    elif payload.side == "SELL":
        execution_price = best_bid
    else:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="unsupported side",
        )

    if execution_price is None or execution_price <= 0:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="dealer market price unavailable",
        )
    if guard_price is None or guard_price <= 0:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="dealer reference price unavailable",
        )

    execution_price = _quantize_down(execution_price, pair.price_precision)
    logger.debug("[_create_dealer_market_order] execution_price=%s", execution_price)

    if not _is_dealer_price_within_guard(
        execution_price=execution_price,
        guard_price=guard_price,
        max_deviation_rate=DEALER_MAX_DEVIATION_RATE,
    ):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="dealer market price out of range",
        )

    balance_snapshots = {}

    if payload.side == "BUY":
        if payload.quote_amount is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="MARKET BUY requires quote_amount",
            )

        _validate_precision(payload.quote_amount, TRADE_VALUE_PRECISION, "quote_amount")
        quote_amount = _trade_value(payload.quote_amount)
        logger.debug("[_create_dealer_market_order] quote_amount=%s", quote_amount)

        if quote_amount <= 0:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="quote_amount must be greater than 0",
            )

        if quote_amount < pair.min_notional:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"quote_amount is below min_notional {pair.min_notional}",
            )

        base_amount = _quantize_down(
            quote_amount / execution_price,
            pair.amount_precision,
        )
        if base_amount <= 0:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="dealer market buy amount is invalid",
            )

        _check_dealer_execution_risk(
            db,
            pair=pair,
            side=payload.side,
            order_type=payload.order_type,
            amount=base_amount,
            quote_amount=quote_amount,
            ref_price=execution_price,
            order_id=None,
            user_id=user_id,
            raise_on_reject=True,
        )

        user_quote_balance = _get_user_balance_for_update(
            db,
            user_id=user_id,
            coin_symbol=pair.quote_asset.symbol,
            chain_key=SPOT_BALANCE_CHAIN_KEY,
        )
        user_base_balance = _get_or_create_user_balance_for_update(
            db,
            user_id=user_id,
            coin_symbol=pair.base_asset.symbol,
            chain_key=SPOT_BALANCE_CHAIN_KEY,
        )
        platform_quote_balance = _get_or_create_user_balance_for_update(
            db,
            user_id=PLATFORM_USER_ID,
            coin_symbol=pair.quote_asset.symbol,
            chain_key=SPOT_BALANCE_CHAIN_KEY,
        )
        platform_base_balance = _get_user_balance_for_update(
            db,
            user_id=PLATFORM_USER_ID,
            coin_symbol=pair.base_asset.symbol,
            chain_key=SPOT_BALANCE_CHAIN_KEY,
        )

        if not user_quote_balance:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="user balances are missing",
            )

        if not platform_base_balance:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="platform balances are missing",
            )

        if Decimal(str(user_quote_balance.available_amount or 0)) < quote_amount:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"insufficient balance: {pair.quote_asset.symbol}",
            )

        _remember_balance_snapshot(balance_snapshots, user_quote_balance)
        _remember_balance_snapshot(balance_snapshots, user_base_balance)
        _remember_balance_snapshot(balance_snapshots, platform_quote_balance)
        _remember_balance_snapshot(balance_snapshots, platform_base_balance)

        user_quote_balance.available_amount = _trade_value(
            Decimal(str(user_quote_balance.available_amount or 0)) - quote_amount
        )
        user_base_balance.available_amount = _trade_value(
            Decimal(str(user_base_balance.available_amount or 0)) + base_amount
        )
        platform_quote_balance.available_amount = _trade_value(
            Decimal(str(platform_quote_balance.available_amount or 0)) + quote_amount
        )
        platform_base_balance.available_amount = _trade_value(
            Decimal(str(platform_base_balance.available_amount or 0)) - base_amount
        )

        if user_quote_balance.available_amount < 0:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="dealer market buy produced negative balances",
            )

        order = Order(
            order_no=_generate_order_no(user_id),
            user_id=user_id,
            trading_pair_id=pair.id,
            side=payload.side,
            order_type=payload.order_type,
            execution_mode="DEALER",
            price=None,
            amount=base_amount,
            filled_amount=base_amount,
            avg_price=execution_price,
            frozen_amount=Decimal("0"),
            executed_quote_amount=quote_amount,
            fee_amount=Decimal("0"),
            fee_asset_id=pair.quote_asset_id,
            status="FILLED",
            source="WEB",
        )
        logger.debug(
            "[_create_dealer_market_order] created order execution_mode=%s status=%s filled_amount=%s executed_quote_amount=%s",
            order.execution_mode,
            order.status,
            order.filled_amount,
            order.executed_quote_amount,
        )
        db.add(order)
        db.flush()

        trade = Trade(
            trading_pair_id=pair.id,
            buy_order_id=order.id,
            sell_order_id=order.id,
            buyer_user_id=order.user_id,
            seller_user_id=PLATFORM_USER_ID,
            price=execution_price,
            amount=base_amount,
            quote_amount=quote_amount,
            maker_order_id=order.id,
            taker_order_id=order.id,
            counterparty_type="PLATFORM",
            **_dealer_trade_snapshot_values(dealer_snapshot),
        )
    else:
        if payload.amount is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="MARKET SELL requires amount",
            )

        _validate_precision(payload.amount, pair.amount_precision, "amount")
        amount = _quantize_down(payload.amount, pair.amount_precision)
        logger.debug("[_create_dealer_market_order] amount=%s", amount)

        if amount <= 0:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="amount must be greater than 0",
            )

        if amount < pair.min_amount:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"amount is below min_amount {pair.min_amount}",
            )

        quote_amount = _trade_value(amount * execution_price)
        if quote_amount <= 0:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="dealer market sell amount is invalid",
            )

        _check_dealer_execution_risk(
            db,
            pair=pair,
            side=payload.side,
            order_type=payload.order_type,
            amount=amount,
            quote_amount=quote_amount,
            ref_price=execution_price,
            order_id=None,
            user_id=user_id,
            raise_on_reject=True,
        )

        user_base_balance = _get_user_balance_for_update(
            db,
            user_id=user_id,
            coin_symbol=pair.base_asset.symbol,
            chain_key=SPOT_BALANCE_CHAIN_KEY,
        )
        user_quote_balance = _get_or_create_user_balance_for_update(
            db,
            user_id=user_id,
            coin_symbol=pair.quote_asset.symbol,
            chain_key=SPOT_BALANCE_CHAIN_KEY,
        )
        platform_base_balance = _get_or_create_user_balance_for_update(
            db,
            user_id=PLATFORM_USER_ID,
            coin_symbol=pair.base_asset.symbol,
            chain_key=SPOT_BALANCE_CHAIN_KEY,
        )
        platform_quote_balance = _get_user_balance_for_update(
            db,
            user_id=PLATFORM_USER_ID,
            coin_symbol=pair.quote_asset.symbol,
            chain_key=SPOT_BALANCE_CHAIN_KEY,
        )

        if not user_base_balance:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="user balances are missing",
            )

        if not platform_quote_balance:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="platform balances are missing",
            )

        if Decimal(str(user_base_balance.available_amount or 0)) < amount:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"insufficient balance: {pair.base_asset.symbol}",
            )

        _remember_balance_snapshot(balance_snapshots, user_base_balance)
        _remember_balance_snapshot(balance_snapshots, user_quote_balance)
        _remember_balance_snapshot(balance_snapshots, platform_base_balance)
        _remember_balance_snapshot(balance_snapshots, platform_quote_balance)

        user_base_balance.available_amount = _trade_value(
            Decimal(str(user_base_balance.available_amount or 0)) - amount
        )
        user_quote_balance.available_amount = _trade_value(
            Decimal(str(user_quote_balance.available_amount or 0)) + quote_amount
        )
        platform_base_balance.available_amount = _trade_value(
            Decimal(str(platform_base_balance.available_amount or 0)) + amount
        )
        platform_quote_balance.available_amount = _trade_value(
            Decimal(str(platform_quote_balance.available_amount or 0)) - quote_amount
        )

        if user_base_balance.available_amount < 0:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="dealer market sell produced negative balances",
            )

        order = Order(
            order_no=_generate_order_no(user_id),
            user_id=user_id,
            trading_pair_id=pair.id,
            side=payload.side,
            order_type=payload.order_type,
            execution_mode="DEALER",
            price=None,
            amount=amount,
            filled_amount=amount,
            avg_price=execution_price,
            frozen_amount=Decimal("0"),
            executed_quote_amount=quote_amount,
            fee_amount=Decimal("0"),
            fee_asset_id=pair.quote_asset_id,
            status="FILLED",
            source="WEB",
        )
        logger.debug(
            "[_create_dealer_market_order] created order execution_mode=%s status=%s filled_amount=%s executed_quote_amount=%s",
            order.execution_mode,
            order.status,
            order.filled_amount,
            order.executed_quote_amount,
        )
        db.add(order)
        db.flush()

        trade = Trade(
            trading_pair_id=pair.id,
            buy_order_id=order.id,
            sell_order_id=order.id,
            buyer_user_id=PLATFORM_USER_ID,
            seller_user_id=order.user_id,
            price=execution_price,
            amount=amount,
            quote_amount=quote_amount,
            maker_order_id=order.id,
            taker_order_id=order.id,
            counterparty_type="PLATFORM",
            **_dealer_trade_snapshot_values(dealer_snapshot),
        )

    db.add(trade)
    db.flush()

    _append_balance_logs_from_snapshots(
        db,
        snapshots=balance_snapshots,
        biz_id=str(order.id),
        remark_prefix="dealer market settlement",
    )
    apply_trade_fee(
        db,
        pair=pair,
        order=order,
        trade=trade,
        side=order.side,
        role="TAKER",
    )

    db.add(order)
    db.flush()
    db.refresh(order)
    return order


def _create_dealer_order(
    db: Session,
    *,
    user_id: int,
    payload: CreateOrderRequest,
    pair: TradingPair,
) -> Order:
    logger.debug("[_create_dealer_order] order_type=%s", payload.order_type)
    if payload.order_type == "LIMIT":
        logger.debug("[_create_dealer_order] order_type=LIMIT -> dealer limit")
        return _create_dealer_limit_order(
            db=db,
            user_id=user_id,
            payload=payload,
            pair=pair,
        )

    if payload.order_type == "MARKET":
        logger.debug("[_create_dealer_order] order_type=MARKET -> dealer market")
        return _create_dealer_market_order(
            db=db,
            user_id=user_id,
            payload=payload,
            pair=pair,
        )

    raise HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail="unsupported order_type",
    )


def process_open_dealer_orders(db: Session) -> int:
    stmt = (
        select(Order)
        .options(
            joinedload(Order.trading_pair).joinedload(TradingPair.base_asset),
            joinedload(Order.trading_pair).joinedload(TradingPair.quote_asset),
        )
        .where(
            Order.status == "OPEN",
            Order.execution_mode == "DEALER",
        )
        .order_by(Order.id.asc())
        .with_for_update()
    )
    orders = list(db.execute(stmt).scalars().all())
    filled_count = 0
    market_context_cache = {}

    for order in orders:
        if order.order_type != "LIMIT":
            continue

        pair = order.trading_pair
        if not pair:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="trading pair not found",
            )

        market_context = market_context_cache.get(pair.id)
        if market_context is None:
            market_context = _get_dealer_market_context(pair)
            market_context_cache[pair.id] = market_context
        best_bid = market_context.best_bid
        best_ask = market_context.best_ask
        guard_price = market_context.ref_price

        if not _should_fill_dealer_limit_order(
            order,
            best_bid=best_bid,
            best_ask=best_ask,
        ):
            continue

        execution_price = _get_dealer_execution_price(
            order,
            best_bid=best_bid,
            best_ask=best_ask,
        )
        if execution_price is None:
            continue
        if guard_price is None or guard_price <= 0:
            continue

        if not _is_dealer_price_within_guard(
            execution_price=execution_price,
            guard_price=guard_price,
            max_deviation_rate=DEALER_MAX_DEVIATION_RATE,
        ):
            continue

        remaining_amount = _remaining_amount(order, pair.amount_precision)
        execution_quote_amount = _trade_value(execution_price * remaining_amount)
        if not _check_dealer_execution_risk(
            db,
            pair=pair,
            side=order.side,
            order_type=order.order_type,
            amount=remaining_amount,
            quote_amount=execution_quote_amount,
            ref_price=execution_price,
            order_id=order.id,
            user_id=order.user_id,
            raise_on_reject=False,
        ):
            continue

        _fill_dealer_limit_order(
            db,
            order=order,
            pair=pair,
            execution_price=execution_price,
            dealer_snapshot=market_context,
        )
        filled_count += 1

    return filled_count


def create_order(
    db: Session,
    *,
    user_id: int,
    payload: CreateOrderRequest,
) -> Order:
    pair = _get_trading_pair(db, payload.symbol)
    if pair.market_mode == "DEALER":
        route = "DEALER"
    else:
        route = "INTERNAL"
    logger.debug(
        "[create_order] symbol=%s order_type=%s pair_symbol=%s market_mode=%s route=%s",
        payload.symbol,
        payload.order_type,
        pair.symbol,
        pair.market_mode,
        route,
    )

    if pair.market_mode == "DEALER":
        return _create_dealer_order(
            db=db,
            user_id=user_id,
            payload=payload,
            pair=pair,
        )

    if payload.order_type == "LIMIT":
        return _create_limit_order(
            db,
            user_id=user_id,
            payload=payload,
        )

    if payload.order_type == "MARKET":
        return _create_market_order(
            db,
            user_id=user_id,
            payload=payload,
        )

    raise HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail="unsupported order_type",
    )


def cancel_order(
    db: Session,
    *,
    user_id: int,
    order_id: int,
) -> Order:
    try:
        stmt = (
            select(Order)
            .where(Order.id == order_id)
            .with_for_update()
        )
        order = db.execute(stmt).scalar_one_or_none()

        if not order:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="order not found",
            )

        if order.user_id != user_id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="cannot cancel another user's order",
            )

        if order.status not in VALID_CANCEL_STATUSES:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"order cannot be canceled in status {order.status}",
            )

        pair_stmt = (
            select(TradingPair)
            .options(
                joinedload(TradingPair.base_asset),
                joinedload(TradingPair.quote_asset),
            )
            .where(TradingPair.id == order.trading_pair_id)
        )
        pair = db.execute(pair_stmt).scalar_one_or_none()

        if not pair:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="trading pair not found",
            )

        if not pair.base_asset or not pair.quote_asset:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="trading pair asset config is invalid",
            )

        amount = Decimal(str(order.amount or 0))
        filled_amount = Decimal(str(order.filled_amount or 0))
        frozen_amount = Decimal(str(order.frozen_amount or 0))
        remaining_amount = amount - filled_amount

        if amount <= 0:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="invalid order amount",
            )

        if remaining_amount <= 0:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="no remaining amount to cancel",
            )

        if frozen_amount <= Decimal("0"):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="no frozen amount to release",
            )

        if order.side == "BUY":
            release_coin_symbol = pair.quote_asset.symbol
            release_precision = TRADE_VALUE_PRECISION
        else:
            release_coin_symbol = pair.base_asset.symbol
            release_precision = pair.amount_precision

        quantized_release_amount = _quantize_down(frozen_amount, release_precision)
        release_residual = frozen_amount - quantized_release_amount
        precision_unit = _precision_unit(release_precision)

        if release_residual > Decimal("0") and release_residual < precision_unit:
            release_amount = frozen_amount
        else:
            release_amount = quantized_release_amount

        if release_amount <= Decimal("0"):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="invalid release amount",
            )

        balance_before = _get_user_balance_for_update(
            db=db,
            user_id=user_id,
            coin_symbol=release_coin_symbol,
            chain_key=SPOT_BALANCE_CHAIN_KEY,
        )
        if not balance_before:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"balance account not found: {release_coin_symbol}",
            )

        before_available = Decimal(str(balance_before.available_amount or 0))
        before_frozen = Decimal(str(balance_before.frozen_amount or 0))

        release_balance = _release_balance(
            db=db,
            user_id=user_id,
            coin_symbol=release_coin_symbol,
            release_amount=release_amount,
            chain_key=SPOT_BALANCE_CHAIN_KEY,
        )

        after_available = Decimal(str(release_balance.available_amount or 0))
        after_frozen = Decimal(str(release_balance.frozen_amount or 0))

        order.frozen_amount = _quantize_down(Decimal("0"), release_precision)
        order.status = "CANCELED"

        _create_balance_log(
            db,
            user_id=user_id,
            coin_symbol=release_coin_symbol,
            chain_key=SPOT_BALANCE_CHAIN_KEY,
            before_available=before_available,
            after_available=after_available,
            before_frozen=before_frozen,
            after_frozen=after_frozen,
            change_amount=after_frozen - before_frozen,
            change_type="UNFREEZE",
            biz_type="CANCEL",
            biz_id=str(order.id),
            remark=f"cancel unfreeze; available delta={after_available - before_available}",
        )

        db.add(order)
        db.flush()
        db.refresh(order)

        return order

    except HTTPException:
        db.rollback()
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"cancel order failed: {str(e)}",
        )
