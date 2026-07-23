from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from app.db.models.trading_pair import TradingPair
from app.db.session import get_db
from app.deps.auth import get_current_user_id
from app.schemas.order import (
    CancelOrderResponse,
    CreateOrderRequest,
    CreateOrderResponse,
)
from app.services.market_ws import market_ws_manager
from app.services.order_service import cancel_order, create_order
from app.services.spot_order_payload import serialize_spot_order
from app.services.spot_private_ws import spot_private_ws_manager
from app.services.spot_public_depth_events import publish_spot_public_depth_refresh


router = APIRouter(prefix="/order", tags=["order"])
logger = logging.getLogger(__name__)


def _fire_and_forget(coro, label: str) -> None:
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        try:
            asyncio.run(coro)
        except Exception:
            logger.exception(label)
        return

    task = loop.create_task(coro)

    def _done_callback(done_task: asyncio.Task) -> None:
        try:
            done_task.result()
        except Exception:
            logger.exception(label)

    task.add_done_callback(_done_callback)


async def _push_depth_and_snapshot(symbol: str) -> None:
    ws_db = get_db_session()
    try:
        await market_ws_manager.send_depth_update(
            db=ws_db,
            symbol=symbol,
            limit=20,
        )
        await market_ws_manager.send_snapshot(ws_db, symbol)
    finally:
        ws_db.close()


def _broadcast_public_orderbook(symbol: str) -> None:
    normalized_symbol = (symbol or "").upper().strip()
    if not normalized_symbol:
        return

    publish_spot_public_depth_refresh(normalized_symbol, reason="order_changed")

    _fire_and_forget(
        _push_depth_and_snapshot(normalized_symbol),
        "order public ws push error",
    )


async def _push_spot_balance_update(user_id: int) -> None:
    ws_db = get_db_session()
    try:
        await spot_private_ws_manager.send_account_balances_snapshot(ws_db, int(user_id))
    finally:
        ws_db.close()


def _broadcast_spot_balance_update(user_id: int) -> None:
    _fire_and_forget(
        _push_spot_balance_update(int(user_id)),
        "spot balance private ws push error",
    )


def _resolve_order_symbol(db: Session, trading_pair_id: int) -> str:
    pair = db.query(TradingPair).filter(TradingPair.id == trading_pair_id).first()
    return (getattr(pair, "symbol", "") or "").upper().strip()


def get_db_session():
    from app.db.session import SessionLocal

    return SessionLocal()


@router.post(
    "/create",
    summary="Create spot order",
    response_model=CreateOrderResponse,
)
def create_order_api(
    request: Request,
    payload: CreateOrderRequest,
    user_id: str = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    """Create spot LIMIT or MARKET order using spot balances."""

    order = create_order(
        db=db,
        user_id=int(user_id),
        payload=payload,
    )
    extra_private_updates = list(getattr(order, "_extra_private_updates", []) or [])

    db.commit()

    try:
        order_payload = serialize_spot_order(order, payload.symbol)
        _fire_and_forget(
            spot_private_ws_manager.send_order_update(
                int(user_id),
                order_payload["symbol"],
                order_payload,
            ),
            "order private ws push error",
        )
    except Exception:
        logger.exception("order private ws push error")

    for item in extra_private_updates:
        try:
            _fire_and_forget(
                spot_private_ws_manager.send_order_update(
                    int(item["user_id"]),
                    item["symbol"],
                    item["order"],
                ),
                "order private ws push error",
            )
        except Exception:
            logger.exception("order private ws push error")

    balance_user_ids = {int(user_id)}
    for item in extra_private_updates:
        try:
            balance_user_ids.add(int(item["user_id"]))
        except Exception:
            pass
    for balance_user_id in balance_user_ids:
        _broadcast_spot_balance_update(balance_user_id)

    _broadcast_public_orderbook(payload.symbol)

    return CreateOrderResponse(
        id=order.id,
        order_no=order.order_no,
        symbol=payload.symbol,
        side=order.side,
        order_type=order.order_type,
        price=order.price,
        amount=order.amount,
        filled_amount=order.filled_amount,
        frozen_amount=order.frozen_amount,
        status=order.status,
        created_at=order.created_at,
    )


@router.post(
    "/{order_id}/cancel",
    summary="Cancel order",
    response_model=CancelOrderResponse,
)
def cancel_order_api(
    order_id: int,
    user_id: str = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    """Cancel the current user's OPEN or PARTIALLY_FILLED order."""

    order = cancel_order(
        db=db,
        user_id=int(user_id),
        order_id=order_id,
    )

    db.commit()

    try:
        order_symbol = getattr(getattr(order, "trading_pair", None), "symbol", None)
        if not order_symbol:
            order_symbol = _resolve_order_symbol(db, order.trading_pair_id)
        order_payload = serialize_spot_order(order, order_symbol)
        _fire_and_forget(
            spot_private_ws_manager.send_order_update(
                int(user_id),
                order_payload["symbol"],
                order_payload,
            ),
            "order private ws push error",
        )
    except Exception:
        logger.exception("order private ws push error")

    _broadcast_spot_balance_update(int(user_id))
    _broadcast_public_orderbook(order_symbol)

    return CancelOrderResponse(
        id=order.id,
        order_no=order.order_no,
        status=order.status,
    )
