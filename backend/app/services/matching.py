from __future__ import annotations

import asyncio
from contextlib import contextmanager
import logging
import random
import threading
import time
import uuid
from datetime import datetime
from decimal import Decimal, ROUND_DOWN
from typing import Any, Callable, Dict, Iterator, Optional, Tuple, TypeVar

from fastapi import HTTPException
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session

from app.core.redis import get_redis
from app.db.models.asset import BalanceLog, UserBalance
from app.db.models.order import Order
from app.db.models.trade import Trade
from app.db.models.trading_pair import TradingPair
from app.db.session import SessionLocal
from app.services.fee_service import apply_trade_fee
from app.services.market_ws import market_ws_manager
from app.services.spot_order_payload import serialize_spot_order
from app.services.spot_private_event_bridge import create_spot_private_event
from app.services.spot_public_depth_events import publish_spot_public_depth_refresh


logger = logging.getLogger(__name__)

DECIMAL_ZERO = Decimal("0")
Q18 = Decimal("0.000000000000000001")
SPOT_CHAIN_KEY = "spot"
_AUTO_MATCH_THREAD: Optional[threading.Thread] = None
_AUTO_MATCH_STOP_EVENT = threading.Event()
_MYSQL_RETRYABLE_LOCK_ERROR_CODES = {1205, 1213}
_AUTO_MATCH_LOCK_RETRY_MAX_ATTEMPTS = 3
_AUTO_MATCH_LOCK_RETRY_MIN_SLEEP_SECONDS = 0.05
_AUTO_MATCH_LOCK_RETRY_MAX_SLEEP_SECONDS = 0.2
_AUTO_MATCH_PAIR_LOCK_TTL_SECONDS = 4
_LOCAL_PAIR_LOCKS: dict[int, threading.Lock] = {}
_LOCAL_PAIR_LOCKS_GUARD = threading.Lock()
ACTIVE_MATCH_EXECUTION_MODE = "MATCHING"
MATCHING_ORDER_PARTIAL_FILLED_EVENT = "ORDER_PARTIAL_FILLED"
MATCHING_ORDER_FILLED_EVENT = "ORDER_FILLED"
MATCHING_BALANCE_UPDATED_EVENT = "BALANCE_UPDATED"
T = TypeVar("T")


class DirtyMatchingOrderError(HTTPException):
    def __init__(
        self,
        *,
        detail: str,
        dirty_order_id: int,
        dirty_side: str,
        reason: str,
        context: Dict[str, Any],
    ) -> None:
        super().__init__(status_code=400, detail=detail)
        self.dirty_order_id = dirty_order_id
        self.dirty_side = dirty_side
        self.reason = reason
        self.context = context


def q(v: Decimal) -> Decimal:
    return Decimal(str(v)).quantize(Q18, rounding=ROUND_DOWN)


def _decimal_text(value: Decimal) -> str:
    return format(q(value), "f")


def norm_symbol(symbol: str) -> str:
    return (symbol or "").strip().upper()


def _is_mysql_retryable_lock_error(exc: Exception) -> bool:
    if not isinstance(exc, OperationalError):
        return False

    orig = getattr(exc, "orig", None)
    args = getattr(orig, "args", ())
    if args:
        try:
            return int(args[0]) in _MYSQL_RETRYABLE_LOCK_ERROR_CODES
        except (TypeError, ValueError):
            pass

    message = str(exc)
    return "1213" in message or "1205" in message


def _auto_match_pair_lock_key(trading_pair_id: int) -> str:
    return f"auto_match:pair:{int(trading_pair_id)}"


def _get_local_pair_lock(trading_pair_id: int) -> threading.Lock:
    pair_id = int(trading_pair_id)
    with _LOCAL_PAIR_LOCKS_GUARD:
        lock = _LOCAL_PAIR_LOCKS.get(pair_id)
        if lock is None:
            lock = threading.Lock()
            _LOCAL_PAIR_LOCKS[pair_id] = lock
        return lock


def _try_acquire_redis_pair_lock(trading_pair_id: int) -> tuple[bool, Optional[str], Optional[Exception]]:
    token = uuid.uuid4().hex
    key = _auto_match_pair_lock_key(trading_pair_id)
    try:
        acquired = get_redis().set(
            key,
            token,
            nx=True,
            ex=_AUTO_MATCH_PAIR_LOCK_TTL_SECONDS,
        )
        return bool(acquired), token if acquired else None, None
    except Exception as exc:
        return False, None, exc


def _release_redis_pair_lock(trading_pair_id: int, token: str) -> None:
    key = _auto_match_pair_lock_key(trading_pair_id)
    script = """
    if redis.call("GET", KEYS[1]) == ARGV[1] then
        return redis.call("DEL", KEYS[1])
    end
    return 0
    """
    try:
        get_redis().eval(script, 1, key, token)
    except Exception as exc:
        logger.warning(
            "[auto_match] pair_id=%s redis lock release failed: %s",
            trading_pair_id,
            exc,
        )


@contextmanager
def _auto_match_pair_lock(trading_pair_id: int) -> Iterator[bool]:
    acquired, token, redis_error = _try_acquire_redis_pair_lock(trading_pair_id)
    if acquired and token:
        try:
            yield True
        finally:
            _release_redis_pair_lock(trading_pair_id, token)
        return

    if redis_error is None:
        yield False
        return

    logger.warning(
        "[auto_match] pair_id=%s redis pair lock unavailable, using local fallback: %s",
        trading_pair_id,
        redis_error,
    )
    local_lock = _get_local_pair_lock(trading_pair_id)
    local_acquired = local_lock.acquire(blocking=False)
    try:
        yield local_acquired
    finally:
        if local_acquired:
            local_lock.release()


def _run_with_mysql_lock_retries(
    db: Session,
    trading_pair_id: int,
    operation: Callable[[], T],
    *,
    label: str,
    fallback: T,
) -> T:
    last_error: Optional[OperationalError] = None
    for attempt in range(1, _AUTO_MATCH_LOCK_RETRY_MAX_ATTEMPTS + 1):
        try:
            return operation()
        except OperationalError as exc:
            if not _is_mysql_retryable_lock_error(exc):
                raise

            last_error = exc
            db.rollback()
            if attempt >= _AUTO_MATCH_LOCK_RETRY_MAX_ATTEMPTS:
                break

            sleep_seconds = random.uniform(
                _AUTO_MATCH_LOCK_RETRY_MIN_SLEEP_SECONDS,
                _AUTO_MATCH_LOCK_RETRY_MAX_SLEEP_SECONDS,
            )
            logger.warning(
                "[auto_match] pair_id=%s %s retryable mysql lock error attempt=%s/%s sleep_ms=%s: %s",
                trading_pair_id,
                label,
                attempt,
                _AUTO_MATCH_LOCK_RETRY_MAX_ATTEMPTS,
                int(sleep_seconds * 1000),
                exc,
            )
            time.sleep(sleep_seconds)

    logger.warning(
        "[auto_match] pair_id=%s %s retryable mysql lock error exceeded retries, skip this cycle: %s",
        trading_pair_id,
        label,
        last_error,
    )
    return fallback


def remaining(order: Order) -> Decimal:
    amount = Decimal(str(order.amount or 0))
    filled = Decimal(str(order.filled_amount or 0))
    rem = q(amount - filled)
    if rem < DECIMAL_ZERO:
        return DECIMAL_ZERO
    return rem


def _ensure_non_negative_decimal(value: Decimal, detail: str) -> None:
    if q(value) < DECIMAL_ZERO:
        raise HTTPException(status_code=500, detail=detail)


def _ensure_balance_non_negative_values(
    *,
    available: Decimal,
    frozen: Decimal,
    detail: str,
) -> None:
    if q(available) < DECIMAL_ZERO or q(frozen) < DECIMAL_ZERO:
        raise HTTPException(status_code=500, detail=detail)


def _log_direction(change_amount: Decimal) -> int:
    return 1 if q(change_amount) >= DECIMAL_ZERO else -1


def _settle_log_context(
    *,
    trading_pair_id: int,
    buy_order: Order,
    sell_order: Order,
    trade_price: Decimal,
    trade_amount: Decimal,
    required_quote: Decimal,
) -> Dict[str, Any]:
    buy_price = Decimal(str(buy_order.price or 0))
    buy_amount = Decimal(str(buy_order.amount or 0))
    buy_filled = Decimal(str(buy_order.filled_amount or 0))
    buy_frozen = Decimal(str(buy_order.frozen_amount or 0))
    sell_price = Decimal(str(sell_order.price or 0))
    sell_amount = Decimal(str(sell_order.amount or 0))
    sell_filled = Decimal(str(sell_order.filled_amount or 0))
    sell_frozen = Decimal(str(sell_order.frozen_amount or 0))

    return {
        "trading_pair_id": trading_pair_id,
        "buy_order_id": int(buy_order.id),
        "buy_user_id": int(buy_order.user_id),
        "buy_order_price": _decimal_text(buy_price),
        "buy_order_amount": _decimal_text(buy_amount),
        "buy_order_filled_amount": _decimal_text(buy_filled),
        "buy_order_remaining_amount": _decimal_text(remaining(buy_order)),
        "buy_order_frozen_amount": _decimal_text(buy_frozen),
        "buy_order_status": buy_order.status,
        "buy_order_type": buy_order.order_type,
        "buy_order_execution_mode": buy_order.execution_mode,
        "sell_order_id": int(sell_order.id),
        "sell_user_id": int(sell_order.user_id),
        "sell_order_price": _decimal_text(sell_price),
        "sell_order_amount": _decimal_text(sell_amount),
        "sell_order_filled_amount": _decimal_text(sell_filled),
        "sell_order_remaining_amount": _decimal_text(remaining(sell_order)),
        "sell_order_frozen_amount": _decimal_text(sell_frozen),
        "sell_order_status": sell_order.status,
        "sell_order_type": sell_order.order_type,
        "sell_order_execution_mode": sell_order.execution_mode,
        "trade_price": _decimal_text(trade_price),
        "trade_amount": _decimal_text(trade_amount),
        "required_quote": _decimal_text(required_quote),
    }


def _format_settle_context(context: Dict[str, Any]) -> str:
    return " ".join(f"{key}={value}" for key, value in context.items())


def _log_settle_context(level: int, event: str, context: Dict[str, Any]) -> None:
    logger.log(
        level,
        "[matching_settle] event=%s %s",
        event,
        _format_settle_context(context),
        extra={"matching_settle": context},
    )


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
    biz_type: str,
    biz_id: str,
    remark: Optional[str] = None,
) -> None:
    db.add(
        BalanceLog(
            user_id=user_id,
            coin_symbol=coin_symbol,
            chain_key=SPOT_CHAIN_KEY,
            change_type=change_type,
            direction=_log_direction(change_amount),
            change_amount=q(change_amount),
            before_available=q(before_available),
            after_available=q(after_available),
            before_frozen=q(before_frozen),
            after_frozen=q(after_frozen),
            biz_type=biz_type,
            biz_id=biz_id,
            remark=remark,
            created_at=datetime.utcnow(),
        )
    )


def _fire_and_forget(coro, label: str) -> None:
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        try:
            asyncio.run(coro)
        except Exception as e:
            logger.exception("[%s]", label)
        return

    task = loop.create_task(coro)

    def _done_callback(done_task: asyncio.Task) -> None:
        try:
            done_task.result()
        except Exception as e:
            logger.exception("[%s]", label)

    task.add_done_callback(_done_callback)


def get_balance(
    db: Session,
    user_id: int,
    coin: str,
    auto_create: bool = False,
) -> UserBalance:
    coin = norm_symbol(coin)

    row = (
        db.query(UserBalance)
        .filter(
            UserBalance.user_id == user_id,
            UserBalance.coin_symbol == coin,
            UserBalance.chain_key == SPOT_CHAIN_KEY,
        )
        .with_for_update()
        .first()
    )

    if row:
        return row

    if auto_create:
        row = UserBalance(
            user_id=user_id,
            coin_symbol=coin,
            chain_key=SPOT_CHAIN_KEY,
            available_amount=DECIMAL_ZERO,
            frozen_amount=DECIMAL_ZERO,
            version=1,
        )
        db.add(row)
        db.flush()
        return row

    raise HTTPException(
        status_code=400,
        detail=f"余额不存在: user_id={user_id}, coin={coin}, chain_key={SPOT_CHAIN_KEY}",
    )


def _quarantine_dirty_order(
    db: Session,
    *,
    pair: TradingPair,
    dirty_order_id: int,
    reason: str,
    context: Dict[str, Any],
) -> bool:
    order = (
        db.query(Order)
        .filter(Order.id == dirty_order_id)
        .with_for_update()
        .first()
    )
    if not order:
        logger.warning(
            "[auto_match_dirty_order] action=quarantine_missing order_id=%s reason=%s %s",
            dirty_order_id,
            reason,
            _format_settle_context(context),
            extra={"matching_settle": context},
        )
        return False

    if order.status not in ["OPEN", "PARTIALLY_FILLED"]:
        logger.info(
            "[auto_match_dirty_order] action=quarantine_skip_inactive order_id=%s status=%s reason=%s",
            order.id,
            order.status,
            reason,
            extra={"matching_settle": context},
        )
        return False

    release_amount = q(Decimal(str(order.frozen_amount or 0)))
    release_coin_symbol = None
    released = False

    if release_amount > DECIMAL_ZERO:
        if order.side == "BUY":
            release_symbol = getattr(getattr(pair, "quote_asset", None), "symbol", None)
            release_coin_symbol = norm_symbol(release_symbol) if release_symbol else None
        elif order.side == "SELL":
            release_symbol = getattr(getattr(pair, "base_asset", None), "symbol", None)
            release_coin_symbol = norm_symbol(release_symbol) if release_symbol else None

    if release_coin_symbol and release_amount > DECIMAL_ZERO:
        try:
            balance = get_balance(db, int(order.user_id), release_coin_symbol, auto_create=False)
            before_available = q(Decimal(str(balance.available_amount or 0)))
            before_frozen = q(Decimal(str(balance.frozen_amount or 0)))

            if before_frozen >= release_amount:
                after_available = q(before_available + release_amount)
                after_frozen = q(before_frozen - release_amount)
                balance.available_amount = after_available
                balance.frozen_amount = after_frozen
                balance.version = int(balance.version or 0) + 1
                order.frozen_amount = DECIMAL_ZERO
                released = True

                _add_balance_log(
                    db,
                    user_id=int(order.user_id),
                    coin_symbol=release_coin_symbol,
                    before_available=before_available,
                    after_available=after_available,
                    before_frozen=before_frozen,
                    after_frozen=after_frozen,
                    change_amount=q(after_frozen - before_frozen),
                    change_type="MATCHING_DIRTY_ORDER_RELEASE",
                    biz_type="ORDER_DIRTY_QUARANTINE",
                    biz_id=str(order.id),
                    remark=f"dirty order quarantine: {reason}",
                )
            else:
                logger.error(
                    "[auto_match_dirty_order] action=release_skip_account_frozen_insufficient "
                    "order_id=%s coin=%s order_frozen_amount=%s account_frozen_amount=%s reason=%s %s",
                    order.id,
                    release_coin_symbol,
                    _decimal_text(release_amount),
                    _decimal_text(before_frozen),
                    reason,
                    _format_settle_context(context),
                    extra={"matching_settle": context},
                )
        except HTTPException:
            logger.exception(
                "[auto_match_dirty_order] action=release_failed order_id=%s coin=%s reason=%s",
                order.id,
                release_coin_symbol,
                reason,
                extra={"matching_settle": context},
            )

    order.status = "FAILED"
    order.updated_at = datetime.utcnow()
    db.add(order)
    db.flush()

    logger.error(
        "[auto_match_dirty_order] action=quarantined order_id=%s side=%s released=%s "
        "release_coin=%s release_amount=%s reason=%s %s",
        order.id,
        order.side,
        released,
        release_coin_symbol or "",
        _decimal_text(release_amount),
        reason,
        _format_settle_context(context),
        extra={"matching_settle": context},
    )
    return True


def pick_orders(db: Session, pair_id: int) -> Tuple[Optional[Order], Optional[Order]]:
    buy = (
        db.query(Order)
        .filter(
            Order.trading_pair_id == pair_id,
            Order.side == "BUY",
            Order.order_type == "LIMIT",
            Order.execution_mode == ACTIVE_MATCH_EXECUTION_MODE,
            Order.status.in_(["OPEN", "PARTIALLY_FILLED"]),
        )
        .order_by(Order.price.desc(), Order.id.asc())
        .with_for_update()
        .first()
    )

    sell = (
        db.query(Order)
        .filter(
            Order.trading_pair_id == pair_id,
            Order.side == "SELL",
            Order.order_type == "LIMIT",
            Order.execution_mode == ACTIVE_MATCH_EXECUTION_MODE,
            Order.status.in_(["OPEN", "PARTIALLY_FILLED"]),
        )
        .order_by(Order.price.asc(), Order.id.asc())
        .with_for_update()
        .first()
    )

    return buy, sell


def update_order_status(order: Order) -> None:
    rem = remaining(order)
    filled = Decimal(str(order.filled_amount or 0))

    if rem <= DECIMAL_ZERO:
        order.status = "FILLED"
    elif filled > DECIMAL_ZERO:
        order.status = "PARTIALLY_FILLED"
    else:
        order.status = "OPEN"


def update_buy_order_after_trade(
    order: Order,
    trade_amount: Decimal,
    trade_quote_amount: Decimal,
) -> None:
    old_filled = Decimal(str(order.filled_amount or 0))
    old_executed_quote = Decimal(str(order.executed_quote_amount or 0))
    old_frozen = Decimal(str(order.frozen_amount or 0))
    order_price = Decimal(str(order.price or 0))

    reserved_quote = q(order_price * trade_amount)
    new_filled = q(old_filled + trade_amount)
    new_executed_quote = q(old_executed_quote + trade_quote_amount)
    new_frozen = q(old_frozen - reserved_quote)

    _ensure_non_negative_decimal(new_frozen, "买单订单冻结金额变为负数")

    order.filled_amount = new_filled
    order.executed_quote_amount = new_executed_quote
    order.frozen_amount = new_frozen

    if new_filled > DECIMAL_ZERO:
        order.avg_price = q(new_executed_quote / new_filled)
    else:
        order.avg_price = DECIMAL_ZERO

    update_order_status(order)


def update_sell_order_after_trade(
    order: Order,
    trade_amount: Decimal,
    trade_quote_amount: Decimal,
) -> None:
    old_filled = Decimal(str(order.filled_amount or 0))
    old_executed_quote = Decimal(str(order.executed_quote_amount or 0))
    old_frozen = Decimal(str(order.frozen_amount or 0))

    new_filled = q(old_filled + trade_amount)
    new_executed_quote = q(old_executed_quote + trade_quote_amount)
    new_frozen = q(old_frozen - trade_amount)

    _ensure_non_negative_decimal(new_frozen, "卖单订单冻结金额变为负数")

    order.filled_amount = new_filled
    order.executed_quote_amount = new_executed_quote
    order.frozen_amount = new_frozen

    if new_filled > DECIMAL_ZERO:
        order.avg_price = q(new_executed_quote / new_filled)
    else:
        order.avg_price = DECIMAL_ZERO

    update_order_status(order)


def _matching_order_event_type(order: Order) -> str:
    status = str(order.status or "").upper().strip()
    if status == "FILLED":
        return MATCHING_ORDER_FILLED_EVENT
    if status == "PARTIALLY_FILLED":
        return MATCHING_ORDER_PARTIAL_FILLED_EVENT
    raise RuntimeError(
        f"matching order private event requires filled status: order_id={order.id} status={status}"
    )


def _create_matching_private_events(
    db: Session,
    *,
    symbol: str,
    orders: Tuple[Order, ...],
) -> None:
    affected_user_ids: set[int] = set()
    ordered_orders = sorted(orders, key=lambda order: int(order.user_id))
    for order in ordered_orders:
        user_id = int(order.user_id)
        affected_user_ids.add(user_id)
        create_spot_private_event(
            db,
            user_id=user_id,
            event_type=_matching_order_event_type(order),
            payload={
                "symbol": norm_symbol(symbol),
                "order": serialize_spot_order(order, symbol),
            },
        )

    for user_id in sorted(affected_user_ids):
        create_spot_private_event(
            db,
            user_id=user_id,
            event_type=MATCHING_BALANCE_UPDATED_EVENT,
            payload={},
        )


def _prepare_trade_context(
    db: Session,
    trading_pair_id: int,
) -> Tuple[TradingPair, Order, Order, Decimal, Decimal, Decimal, Decimal, Decimal, Order, Order, str, str]:
    pair = (
        db.query(TradingPair)
        .filter(TradingPair.id == trading_pair_id)
        .first()
    )
    if not pair:
        raise HTTPException(status_code=404, detail="交易对不存在")

    buy, sell = pick_orders(db, trading_pair_id)

    if not buy or not sell:
        raise HTTPException(status_code=400, detail="无订单")

    buy_price = Decimal(str(buy.price or 0))
    sell_price = Decimal(str(sell.price or 0))

    if buy_price < sell_price:
        raise HTTPException(status_code=400, detail="未成交")

    if buy.user_id == sell.user_id:
        raise HTTPException(status_code=400, detail="自成交跳过")

    buy_remaining = remaining(buy)
    sell_remaining = remaining(sell)
    amt = q(min(buy_remaining, sell_remaining))

    if amt <= DECIMAL_ZERO:
        raise HTTPException(status_code=400, detail="无可成交数量")

    if buy.created_at <= sell.created_at:
        maker = buy
        taker = sell
    else:
        maker = sell
        taker = buy

    trade_price = q(sell_price)
    trade_quote_amount = q(trade_price * amt)

    base_symbol = norm_symbol(pair.base_asset.symbol)
    quote_symbol = norm_symbol(pair.quote_asset.symbol)

    return (
        pair,
        buy,
        sell,
        buy_price,
        sell_price,
        amt,
        trade_price,
        trade_quote_amount,
        maker,
        taker,
        base_symbol,
        quote_symbol,
    )


def _push_trade_and_depth(
    *,
    symbol: str,
    price: Decimal,
    amount: Decimal,
    side: str,
    trade_id: int,
) -> None:
    try:
        ts = int(time.time() * 1000)

        publish_spot_public_depth_refresh(symbol, reason="trade_matched")

        _fire_and_forget(
            market_ws_manager.send_trade(
                symbol=symbol,
                price=price,
                amount=amount,
                side=side,
                ts=ts,
                trade_id=trade_id,
            ),
            "public ws trade push error",
        )

        _fire_and_forget(
            _push_depth_and_snapshot(
                symbol=symbol,
                price=price,
                amount=amount,
                ts=ts,
            ),
            "public ws depth/snapshot push error",
        )
    except Exception as e:
        logger.exception("[public ws push error]")


async def _push_depth_and_snapshot(
    *,
    symbol: str,
    price: Decimal,
    amount: Decimal,
    ts: int,
) -> None:
    ws_db = SessionLocal()
    try:
        try:
            await market_ws_manager.send_kline_update(
                db=ws_db,
                symbol=symbol,
                price=price,
                amount=amount,
                ts=ts,
            )
        except Exception:
            logger.warning("public ws kline push error symbol=%s", symbol, exc_info=True)

        await market_ws_manager.send_depth_update(
            db=ws_db,
            symbol=symbol,
            limit=20,
        )
        await market_ws_manager.send_snapshot(
            ws_db,
            symbol,
        )
    finally:
        ws_db.close()


def _settle_one_trade(
    db: Session,
    trading_pair_id: int,
):
    (
        pair,
        buy,
        sell,
        buy_price,
        _sell_price,
        amt,
        trade_price,
        trade_quote_amount,
        maker,
        taker,
        base_symbol,
        quote_symbol,
    ) = _prepare_trade_context(db, trading_pair_id)

    buy_order_frozen_before = q(Decimal(str(buy.frozen_amount or 0)))
    sell_order_frozen_before = q(Decimal(str(sell.frozen_amount or 0)))

    reserved_quote = q(buy_price * amt)
    refund_quote = q(reserved_quote - trade_quote_amount)
    settle_context = _settle_log_context(
        trading_pair_id=trading_pair_id,
        buy_order=buy,
        sell_order=sell,
        trade_price=trade_price,
        trade_amount=amt,
        required_quote=reserved_quote,
    )
    _log_settle_context(logging.DEBUG, "pre_order_frozen_check", settle_context)

    if refund_quote < DECIMAL_ZERO:
        _log_settle_context(logging.ERROR, "buy_refund_negative", settle_context)
        raise HTTPException(status_code=400, detail="买单退款金额异常")

    if buy_order_frozen_before < reserved_quote:
        diff = q(reserved_quote - buy_order_frozen_before)
        context = {
            **settle_context,
            "frozen_shortfall": _decimal_text(diff),
        }
        _log_settle_context(logging.ERROR, "buy_order_frozen_insufficient", context)
        raise DirtyMatchingOrderError(
            detail=(
                "买单冻结数量不足: "
                f"buy_order_id={buy.id}, sell_order_id={sell.id}, "
                f"frozen_amount={_decimal_text(buy_order_frozen_before)}, "
                f"required_quote={_decimal_text(reserved_quote)}, "
                f"shortfall={_decimal_text(diff)}"
            ),
            dirty_order_id=int(buy.id),
            dirty_side="BUY",
            reason="buy_order_frozen_insufficient",
            context=context,
        )
    if sell_order_frozen_before < amt:
        diff = q(amt - sell_order_frozen_before)
        context = {
            **settle_context,
            "frozen_shortfall": _decimal_text(diff),
        }
        _log_settle_context(logging.ERROR, "sell_order_frozen_insufficient", context)
        raise DirtyMatchingOrderError(
            detail=(
                "卖单冻结数量不足: "
                f"sell_order_id={sell.id}, buy_order_id={buy.id}, "
                f"frozen_amount={_decimal_text(sell_order_frozen_before)}, "
                f"required_base={_decimal_text(amt)}, "
                f"shortfall={_decimal_text(diff)}"
            ),
            dirty_order_id=int(sell.id),
            dirty_side="SELL",
            reason="sell_order_frozen_insufficient",
            context=context,
        )

    _log_settle_context(logging.DEBUG, "order_frozen_check_ok", settle_context)

    # Debit/frozen-side balances must already exist; never auto-create accounts
    # that are used to pay or release frozen funds. Credit-side balances may be
    # created for first-time receivers, e.g. a user buying a coin for the first time.
    # Keep these flags asymmetric so this does not drift into all auto_create=True.
    buyer_quote_balance = get_balance(db, buy.user_id, quote_symbol, auto_create=False)
    buyer_base_balance = get_balance(db, buy.user_id, base_symbol, auto_create=True)
    seller_base_balance = get_balance(db, sell.user_id, base_symbol, auto_create=False)
    seller_quote_balance = get_balance(db, sell.user_id, quote_symbol, auto_create=True)

    db.refresh(buyer_quote_balance)
    db.refresh(buyer_base_balance)
    db.refresh(seller_base_balance)
    db.refresh(seller_quote_balance)

    buyer_quote_before_available = q(Decimal(str(buyer_quote_balance.available_amount or 0)))
    buyer_quote_before_frozen = q(Decimal(str(buyer_quote_balance.frozen_amount or 0)))
    buyer_base_before_available = q(Decimal(str(buyer_base_balance.available_amount or 0)))
    buyer_base_before_frozen = q(Decimal(str(buyer_base_balance.frozen_amount or 0)))
    seller_base_before_available = q(Decimal(str(seller_base_balance.available_amount or 0)))
    seller_base_before_frozen = q(Decimal(str(seller_base_balance.frozen_amount or 0)))
    seller_quote_before_available = q(Decimal(str(seller_quote_balance.available_amount or 0)))
    seller_quote_before_frozen = q(Decimal(str(seller_quote_balance.frozen_amount or 0)))

    if buyer_quote_before_frozen < reserved_quote:
        diff = q(reserved_quote - buyer_quote_before_frozen)
        context = {
            **settle_context,
            "buyer_quote_account_frozen": _decimal_text(buyer_quote_before_frozen),
            "frozen_shortfall": _decimal_text(diff),
        }
        _log_settle_context(logging.ERROR, "buyer_quote_balance_frozen_insufficient", context)
        raise DirtyMatchingOrderError(
            detail=(
                "买方冻结余额不足: "
                f"buy_order_id={buy.id}, sell_order_id={sell.id}, "
                f"account_frozen_amount={_decimal_text(buyer_quote_before_frozen)}, "
                f"required_quote={_decimal_text(reserved_quote)}, "
                f"shortfall={_decimal_text(diff)}"
            ),
            dirty_order_id=int(buy.id),
            dirty_side="BUY",
            reason="buyer_quote_balance_frozen_insufficient",
            context=context,
        )
    if seller_base_before_frozen < amt:
        diff = q(amt - seller_base_before_frozen)
        context = {
            **settle_context,
            "seller_base_account_frozen": _decimal_text(seller_base_before_frozen),
            "frozen_shortfall": _decimal_text(diff),
        }
        _log_settle_context(logging.ERROR, "seller_base_balance_frozen_insufficient", context)
        raise DirtyMatchingOrderError(
            detail=(
                "卖方冻结余额不足: "
                f"sell_order_id={sell.id}, buy_order_id={buy.id}, "
                f"account_frozen_amount={_decimal_text(seller_base_before_frozen)}, "
                f"required_base={_decimal_text(amt)}, "
                f"shortfall={_decimal_text(diff)}"
            ),
            dirty_order_id=int(sell.id),
            dirty_side="SELL",
            reason="seller_base_balance_frozen_insufficient",
            context=context,
        )

    buyer_quote_after_frozen = q(buyer_quote_before_frozen - reserved_quote)
    buyer_quote_after_available = q(buyer_quote_before_available + refund_quote)
    buyer_base_after_available = q(buyer_base_before_available + amt)
    seller_base_after_frozen = q(seller_base_before_frozen - amt)
    seller_quote_after_available = q(seller_quote_before_available + trade_quote_amount)

    _ensure_non_negative_decimal(refund_quote, "买单退款金额异常")
    _ensure_balance_non_negative_values(
        available=buyer_quote_after_available,
        frozen=buyer_quote_after_frozen,
        detail="买方 quote 余额出现负数",
    )
    _ensure_balance_non_negative_values(
        available=buyer_base_after_available,
        frozen=buyer_base_before_frozen,
        detail="买方 base 余额出现负数",
    )
    _ensure_balance_non_negative_values(
        available=seller_base_before_available,
        frozen=seller_base_after_frozen,
        detail="卖方 base 余额出现负数",
    )
    _ensure_balance_non_negative_values(
        available=seller_quote_after_available,
        frozen=seller_quote_before_frozen,
        detail="卖方 quote 余额出现负数",
    )

    buyer_quote_balance.frozen_amount = buyer_quote_after_frozen
    buyer_quote_balance.available_amount = buyer_quote_after_available
    buyer_quote_balance.version = int(buyer_quote_balance.version or 0) + 1

    buyer_base_balance.available_amount = buyer_base_after_available
    buyer_base_balance.version = int(buyer_base_balance.version or 0) + 1

    seller_base_balance.frozen_amount = seller_base_after_frozen
    seller_base_balance.version = int(seller_base_balance.version or 0) + 1

    seller_quote_balance.available_amount = seller_quote_after_available
    seller_quote_balance.version = int(seller_quote_balance.version or 0) + 1

    update_buy_order_after_trade(
        order=buy,
        trade_amount=amt,
        trade_quote_amount=trade_quote_amount,
    )
    update_sell_order_after_trade(
        order=sell,
        trade_amount=amt,
        trade_quote_amount=trade_quote_amount,
    )

    if q(buy_order_frozen_before - reserved_quote) != q(Decimal(str(buy.frozen_amount or 0))):
        raise HTTPException(status_code=500, detail="买单订单冻结金额与账户扣减不一致")
    if q(sell_order_frozen_before - amt) != q(Decimal(str(sell.frozen_amount or 0))):
        raise HTTPException(status_code=500, detail="卖单订单冻结金额与账户扣减不一致")

    trade = Trade(
        trading_pair_id=trading_pair_id,
        buy_order_id=buy.id,
        sell_order_id=sell.id,
        buyer_user_id=buy.user_id,
        seller_user_id=sell.user_id,
        price=trade_price,
        amount=amt,
        quote_amount=trade_quote_amount,
        maker_order_id=maker.id,
        taker_order_id=taker.id,
    )
    db.add(trade)
    db.flush()

    trade_biz_id = str(trade.id)

    _add_balance_log(
        db,
        user_id=buy.user_id,
        coin_symbol=quote_symbol,
        before_available=buyer_quote_before_available,
        after_available=buyer_quote_before_available,
        before_frozen=buyer_quote_before_frozen,
        after_frozen=buyer_quote_after_frozen,
        change_amount=buyer_quote_after_frozen - buyer_quote_before_frozen,
        change_type="TRADE_BUYER_QUOTE_SETTLE_FROZEN",
        biz_type="TRADE",
        biz_id=f"{trade_biz_id}:BUYER_QUOTE_FROZEN",
        remark="quote settle",
    )
    _add_balance_log(
        db,
        user_id=buy.user_id,
        coin_symbol=quote_symbol,
        before_available=buyer_quote_before_available,
        after_available=buyer_quote_after_available,
        before_frozen=buyer_quote_after_frozen,
        after_frozen=buyer_quote_after_frozen,
        change_amount=buyer_quote_after_available - buyer_quote_before_available,
        change_type="TRADE_BUYER_QUOTE_REFUND",
        biz_type="TRADE",
        biz_id=f"{trade_biz_id}:BUYER_QUOTE_REFUND",
        remark="quote refund credit",
    )
    _add_balance_log(
        db,
        user_id=buy.user_id,
        coin_symbol=base_symbol,
        before_available=buyer_base_before_available,
        after_available=buyer_base_after_available,
        before_frozen=buyer_base_before_frozen,
        after_frozen=buyer_base_before_frozen,
        change_amount=buyer_base_after_available - buyer_base_before_available,
        change_type="TRADE_BUYER_BASE_CREDIT",
        biz_type="TRADE",
        biz_id=f"{trade_biz_id}:BUYER_BASE_CREDIT",
        remark="base credit",
    )
    _add_balance_log(
        db,
        user_id=sell.user_id,
        coin_symbol=base_symbol,
        before_available=seller_base_before_available,
        after_available=seller_base_before_available,
        before_frozen=seller_base_before_frozen,
        after_frozen=seller_base_after_frozen,
        change_amount=seller_base_after_frozen - seller_base_before_frozen,
        change_type="TRADE_SELLER_BASE_RELEASE",
        biz_type="TRADE",
        biz_id=f"{trade_biz_id}:SELLER_BASE_RELEASE",
        remark="base release",
    )
    _add_balance_log(
        db,
        user_id=sell.user_id,
        coin_symbol=quote_symbol,
        before_available=seller_quote_before_available,
        after_available=seller_quote_after_available,
        before_frozen=seller_quote_before_frozen,
        after_frozen=seller_quote_before_frozen,
        change_amount=seller_quote_after_available - seller_quote_before_available,
        change_type="TRADE_SELLER_QUOTE_CREDIT",
        biz_type="TRADE",
        biz_id=f"{trade_biz_id}:SELLER_QUOTE_CREDIT",
        remark="quote credit",
    )

    buyer_quote_delta = q(
        (buyer_quote_after_available + buyer_quote_after_frozen)
        - (buyer_quote_before_available + buyer_quote_before_frozen)
    )
    seller_quote_delta = q(
        seller_quote_after_available - seller_quote_before_available
    )

    if buyer_quote_delta != q(-trade_quote_amount):
        raise HTTPException(status_code=500, detail="买方 quote 结算金额不守恒")
    if seller_quote_delta != q(trade_quote_amount):
        raise HTTPException(status_code=500, detail="卖方 quote 结算金额不守恒")

    apply_trade_fee(
        db,
        pair=pair,
        order=buy,
        trade=trade,
        side="BUY",
        role="MAKER" if maker.id == buy.id else "TAKER",
    )
    apply_trade_fee(
        db,
        pair=pair,
        order=sell,
        trade=trade,
        side="SELL",
        role="MAKER" if maker.id == sell.id else "TAKER",
    )

    _create_matching_private_events(
        db,
        symbol=pair.symbol,
        orders=(buy, sell),
    )

    taker_side = (taker.side or "").upper()

    return {
        "trade_id": trade.id,
        "buy_order_id": buy.id,
        "sell_order_id": sell.id,
        "price": trade_price,
        "amount": amt,
        "quote_amount": trade_quote_amount,
        "symbol": pair.symbol,
        "trade_side": taker_side,
    }


def _run_match_once_unlocked(db: Session, trading_pair_id: int):
    try:
        result = _settle_one_trade(db, trading_pair_id)
        db.commit()

        _push_trade_and_depth(
            symbol=result["symbol"],
            price=result["price"],
            amount=result["amount"],
            side=result["trade_side"],
            trade_id=result["trade_id"],
        )

        return {
            "matched": True,
            **result,
            "message": "success",
        }
    except HTTPException as e:
        db.rollback()
        if e.detail in ["无订单", "未成交", "自成交跳过", "无可成交数量"]:
            return {
                "matched": False,
                "message": e.detail,
            }
        raise
    except Exception:
        db.rollback()
        raise


def run_match_once(db: Session, trading_pair_id: int):
    with _auto_match_pair_lock(trading_pair_id) as acquired:
        if not acquired:
            db.rollback()
            logger.info("[auto_match] pair_id=%s pair lock busy, skip run_once", trading_pair_id)
            return {
                "matched": False,
                "message": "pair lock busy, skipped",
            }

        return _run_with_mysql_lock_retries(
            db,
            trading_pair_id,
            lambda: _run_match_once_unlocked(db, trading_pair_id),
            label="run_once",
            fallback={
                "matched": False,
                "message": "retryable mysql lock error, skipped",
            },
        )


def _run_match_loop_unlocked(
    db: Session,
    trading_pair_id: int,
    max_rounds: int = 100,
    *,
    skip_dirty_orders: bool = False,
):
    pair = (
        db.query(TradingPair)
        .filter(TradingPair.id == trading_pair_id)
        .first()
    )
    if not pair:
        raise HTTPException(status_code=404, detail="交易对不存在")

    matched_count = 0
    trade_ids = []
    try:
        for _ in range(max_rounds):
            try:
                result = _settle_one_trade(db, trading_pair_id)
                db.commit()
                matched_count += 1
                trade_ids.append(result["trade_id"])
                _push_trade_and_depth(
                    symbol=result["symbol"],
                    price=result["price"],
                    amount=result["amount"],
                    side=result["trade_side"],
                    trade_id=result["trade_id"],
                )
            except DirtyMatchingOrderError as e:
                if not skip_dirty_orders:
                    raise

                db.rollback()
                quarantined = _quarantine_dirty_order(
                    db,
                    pair=pair,
                    dirty_order_id=e.dirty_order_id,
                    reason=e.reason,
                    context=e.context,
                )
                db.commit()
                logger.error(
                    "[auto_match_dirty_order] pair_id=%s dirty_order_id=%s dirty_side=%s "
                    "reason=%s quarantined=%s",
                    trading_pair_id,
                    e.dirty_order_id,
                    e.dirty_side,
                    e.reason,
                    quarantined,
                    extra={"matching_settle": e.context},
                )
                if not quarantined:
                    break
            except HTTPException as e:
                if e.detail in ["无订单", "未成交", "自成交跳过", "无可成交数量"]:
                    db.rollback()
                    break
                raise

        return {
            "matched_count": matched_count,
            "trade_ids": trade_ids,
        }

    except Exception:
        db.rollback()
        raise


def run_match_loop(
    db: Session,
    trading_pair_id: int,
    max_rounds: int = 100,
    *,
    skip_dirty_orders: bool = False,
):
    with _auto_match_pair_lock(trading_pair_id) as acquired:
        if not acquired:
            db.rollback()
            logger.info("[auto_match] pair_id=%s pair lock busy, skip run_loop", trading_pair_id)
            return {
                "matched_count": 0,
                "trade_ids": [],
                "message": "pair lock busy, skipped",
            }

        return _run_with_mysql_lock_retries(
            db,
            trading_pair_id,
            lambda: _run_match_loop_unlocked(
                db,
                trading_pair_id,
                max_rounds=max_rounds,
                skip_dirty_orders=skip_dirty_orders,
            ),
            label="run_loop",
            fallback={
                "matched_count": 0,
                "trade_ids": [],
                "message": "retryable mysql lock error, skipped",
            },
        )


def _list_active_trading_pair_ids() -> list[int]:
    db = SessionLocal()
    try:
        rows = (
            db.query(TradingPair.id)
            .filter(TradingPair.status == 1)
            .all()
        )
        return [int(row[0]) for row in rows]
    finally:
        db.close()


def _run_match_loop_with_lock_retry(
    db: Session,
    trading_pair_id: int,
    *,
    max_rounds: int,
) -> None:
    run_match_loop(
        db,
        trading_pair_id,
        max_rounds=max_rounds,
        skip_dirty_orders=True,
    )


def _run_auto_match_cycle(max_rounds_per_pair: int) -> None:
    trading_pair_ids = _list_active_trading_pair_ids()

    for trading_pair_id in trading_pair_ids:
        if _AUTO_MATCH_STOP_EVENT.is_set():
            return

        db = SessionLocal()
        try:
            _run_match_loop_with_lock_retry(
                db,
                trading_pair_id,
                max_rounds=max_rounds_per_pair,
            )
        except Exception:
            db.rollback()
            logger.exception("[auto_match] pair_id=%s cycle error", trading_pair_id)
        finally:
            db.close()


def _auto_match_worker(
    poll_interval_seconds: float,
    max_rounds_per_pair: int,
) -> None:
    logger.info(
        "[auto_match] worker started poll_interval=%ss max_rounds_per_pair=%s",
        poll_interval_seconds,
        max_rounds_per_pair,
    )

    while not _AUTO_MATCH_STOP_EVENT.is_set():
        _run_auto_match_cycle(max_rounds_per_pair)
        _AUTO_MATCH_STOP_EVENT.wait(poll_interval_seconds)

    logger.debug("[auto_match] worker stopped")


def start_auto_match_worker(
    poll_interval_seconds: float = 0.5,
    max_rounds_per_pair: int = 100,
) -> None:
    global _AUTO_MATCH_THREAD

    if _AUTO_MATCH_THREAD and _AUTO_MATCH_THREAD.is_alive():
        logger.debug("[auto_match] worker already running")
        return

    _AUTO_MATCH_STOP_EVENT.clear()
    _AUTO_MATCH_THREAD = threading.Thread(
        target=_auto_match_worker,
        args=(poll_interval_seconds, max_rounds_per_pair),
        name="spot-auto-match-worker",
        daemon=True,
    )
    _AUTO_MATCH_THREAD.start()


def stop_auto_match_worker(timeout_seconds: float = 2.0) -> None:
    global _AUTO_MATCH_THREAD

    _AUTO_MATCH_STOP_EVENT.set()

    if _AUTO_MATCH_THREAD and _AUTO_MATCH_THREAD.is_alive():
        _AUTO_MATCH_THREAD.join(timeout=timeout_seconds)

    _AUTO_MATCH_THREAD = None
