from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import ValidationError
from sqlalchemy.orm import Session

from app.db.models.trading_pair import TradingPair
from app.db.session import get_db
from app.deps.auth import get_current_user_id
from app.schemas.order import (
    CancelOrderResponse,
    CreateOrderRequest,
    CreateOrderResponse,
)
from app.schemas.trade_idempotency import TradeIdempotencyStatusResponse
from app.services.market_ws import market_ws_manager
from app.services.order_service import cancel_order, create_order
from app.services.spot_order_payload import serialize_spot_order
from app.services.spot_private_ws import spot_private_ws_manager
from app.services.spot_public_depth_events import publish_spot_public_depth_refresh
from app.services.trade_idempotency_service import (
    TradeIdempotencyClaim,
    TradeIdempotencyConflict,
    TradeIdempotencyError,
    TradeIdempotencyUnavailable,
    claim_trade_idempotency,
    complete_trade_idempotency,
    get_trade_idempotency_status,
    lock_trade_idempotency_owner,
    lookup_trade_idempotency,
)


router = APIRouter(prefix="/order", tags=["order"])
logger = logging.getLogger(__name__)
SPOT_IDEMPOTENCY_MARKET = "SPOT"
SPOT_CREATE_OPERATION = "SPOT_CREATE"


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


def _spot_idempotency_request_payload(payload: CreateOrderRequest) -> dict:
    request_payload = {
        "symbol": payload.symbol,
        "side": payload.side,
        "order_type": payload.order_type,
    }
    if payload.order_type == "LIMIT":
        request_payload["price"] = payload.price
        request_payload["amount"] = payload.amount
    elif payload.side == "BUY":
        request_payload["quote_amount"] = payload.quote_amount
    else:
        request_payload["amount"] = payload.amount
    return request_payload


def _build_create_order_response(
    order,
    *,
    symbol: str,
    client_order_id: str | None,
) -> CreateOrderResponse:
    return CreateOrderResponse(
        id=order.id,
        order_no=order.order_no,
        symbol=symbol,
        side=order.side,
        order_type=order.order_type,
        price=order.price,
        amount=order.amount,
        filled_amount=order.filled_amount,
        frozen_amount=order.frozen_amount,
        status=order.status,
        created_at=order.created_at,
        client_order_id=client_order_id,
    )


def _validate_spot_replay_response(
    claim: TradeIdempotencyClaim,
) -> CreateOrderResponse:
    try:
        response = CreateOrderResponse.model_validate(claim.replay_payload)
    except ValidationError as exc:
        raise TradeIdempotencyUnavailable(
            "stored spot order response is invalid; manual verification is required"
        ) from exc
    if response.client_order_id != claim.client_order_id:
        raise TradeIdempotencyUnavailable(
            "stored spot order response does not match client_order_id"
        )
    return response


def _raise_trade_idempotency_http(exc: TradeIdempotencyError) -> None:
    if isinstance(exc, TradeIdempotencyConflict):
        status_code = status.HTTP_409_CONFLICT
    else:
        status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    raise HTTPException(
        status_code=status_code,
        detail={"code": exc.code, "message": str(exc)},
    ) from exc


@router.get(
    "/idempotency/{client_order_id}",
    summary="Read current user's spot idempotency result",
    response_model=TradeIdempotencyStatusResponse,
)
def get_spot_idempotency_result(
    client_order_id: str,
    user_id: str = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    try:
        result = get_trade_idempotency_status(
            db,
            user_id=int(user_id),
            market=SPOT_IDEMPOTENCY_MARKET,
            client_order_id=client_order_id,
        )
        if result.operation not in {None, SPOT_CREATE_OPERATION}:
            raise TradeIdempotencyUnavailable(
                "原现货交易请求类型无法识别，请人工核验"
            )
        response_payload = None
        if result.status == "COMPLETED":
            claim = TradeIdempotencyClaim(
                client_order_id=result.client_order_id,
                record=None,
                replay_payload=result.response_payload,
            )
            response_payload = _validate_spot_replay_response(claim).model_dump(
                mode="json"
            )
        return TradeIdempotencyStatusResponse(
            market="SPOT",
            client_order_id=result.client_order_id,
            status=result.status,
            operation=result.operation,
            result=response_payload,
            created_at=result.created_at,
            completed_at=result.completed_at,
        )
    except (TradeIdempotencyError, ValueError) as exc:
        if isinstance(exc, TradeIdempotencyError):
            _raise_trade_idempotency_http(exc)
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": "INVALID_CLIENT_ORDER_ID", "message": str(exc)},
        ) from exc


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

    normalized_user_id = int(user_id)
    client_order_id = payload.client_order_id
    request_payload = (
        _spot_idempotency_request_payload(payload) if client_order_id else None
    )

    try:
        if client_order_id and request_payload is not None:
            lock_trade_idempotency_owner(db, user_id=normalized_user_id)
            replay = lookup_trade_idempotency(
                db,
                user_id=normalized_user_id,
                market=SPOT_IDEMPOTENCY_MARKET,
                operation=SPOT_CREATE_OPERATION,
                client_order_id=client_order_id,
                request_payload=request_payload,
            )
            if replay is not None:
                response = _validate_spot_replay_response(replay)
                db.rollback()
                return response

        order = create_order(
            db=db,
            user_id=normalized_user_id,
            payload=payload,
        )
        response = _build_create_order_response(
            order,
            symbol=payload.symbol,
            client_order_id=client_order_id,
        )

        if client_order_id and request_payload is not None:
            claim = claim_trade_idempotency(
                db,
                user_id=normalized_user_id,
                market=SPOT_IDEMPOTENCY_MARKET,
                operation=SPOT_CREATE_OPERATION,
                client_order_id=client_order_id,
                request_payload=request_payload,
            )
            if claim.is_replay:
                db.rollback()
                return _validate_spot_replay_response(claim)
            complete_trade_idempotency(
                db,
                claim,
                response.model_dump(mode="json"),
            )

        extra_private_updates = list(
            getattr(order, "_extra_private_updates", []) or []
        )
        db.commit()
    except TradeIdempotencyError as exc:
        db.rollback()
        _raise_trade_idempotency_http(exc)
    except Exception:
        if client_order_id:
            db.rollback()
        raise

    try:
        order_payload = serialize_spot_order(order, payload.symbol)
        _fire_and_forget(
            spot_private_ws_manager.send_order_update(
                normalized_user_id,
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

    balance_user_ids = {normalized_user_id}
    for item in extra_private_updates:
        try:
            balance_user_ids.add(int(item["user_id"]))
        except Exception:
            pass
    for balance_user_id in balance_user_ids:
        _broadcast_spot_balance_update(balance_user_id)

    _broadcast_public_orderbook(payload.symbol)

    return response


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
