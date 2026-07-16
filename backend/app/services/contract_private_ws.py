"""Private contract WebSocket fanout for per-user contract state updates."""

from __future__ import annotations

import asyncio
import json
import logging
import time
from uuid import uuid4
from collections import defaultdict
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Iterable

from fastapi import WebSocket
from pydantic import BaseModel
from redis import Redis
from redis.exceptions import ConnectionError as RedisConnectionError
from redis.exceptions import TimeoutError as RedisTimeoutError
from sqlalchemy.orm import Session

from app.core.rq import get_redis_url
from app.db.session import SessionLocal
from app.db.models.contract_order import ContractOrder
from app.db.models.contract_position import ContractPosition
from app.db.models.contract_trade import ContractTrade
from app.services.contract_account_service import get_contract_account_summary
from app.services.contract_query_service import (
    get_user_contract_orders,
    get_user_contract_position_summaries,
    get_user_contract_positions,
    get_user_contract_trades,
)
from app.services.service_heartbeat import (
    beat_service_heartbeat,
    heartbeat_age_seconds,
    is_heartbeat_alive,
    read_service_heartbeat,
)

logger = logging.getLogger(__name__)
CONTRACT_USER_EVENTS_CHANNEL = "contract:user_events"
CONTRACT_USER_EVENT_SUBSCRIBER_SERVICE = "contract_user_event_subscriber"
CONTRACT_USER_EVENT_PUBLISH_HEALTH_KEY = "service:health:contract_user_event_publisher"
CONTRACT_USER_EVENT_REDIS_UNAVAILABLE_LOG_INTERVAL_SECONDS = 30.0
CONTRACT_ACCOUNT_EQUITY_REFRESH_INTERVAL_SECONDS = 1.0
_subscriber_task: asyncio.Task[None] | None = None
_subscriber_stop_event: asyncio.Event | None = None

_REDIS_UNAVAILABLE_ERRORS = (
    RedisConnectionError,
    RedisTimeoutError,
    OSError,
    ConnectionRefusedError,
    asyncio.TimeoutError,
)


def _to_jsonable(value: Any) -> Any:
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, BaseModel):
        return _to_jsonable(value.model_dump())
    if isinstance(value, dict):
        return {key: _to_jsonable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_to_jsonable(item) for item in value]
    return value


def _first(items: Iterable[dict[str, Any]], item_id: int | None) -> dict[str, Any] | None:
    if item_id is None:
        return None
    for item in items:
        if int(item.get("id") or 0) == int(item_id):
            return item
    return None


def _symbol_from_models(
    db: Session,
    user_id: int,
    *,
    position_id: int | None = None,
    order_id: int | None = None,
    trade_id: int | None = None,
) -> str | None:
    if position_id is not None:
        position = db.query(ContractPosition).filter(
            ContractPosition.id == position_id,
            ContractPosition.user_id == user_id,
        ).first()
        if position:
            return position.symbol
    if order_id is not None:
        order = db.query(ContractOrder).filter(
            ContractOrder.id == order_id,
            ContractOrder.user_id == user_id,
        ).first()
        if order:
            return order.symbol
    if trade_id is not None:
        trade = db.query(ContractTrade).filter(
            ContractTrade.id == trade_id,
            ContractTrade.user_id == user_id,
        ).first()
        if trade:
            return trade.symbol
    return None


def _account_payload(db: Session, user_id: int) -> dict[str, Any]:
    return get_contract_account_summary(db, int(user_id)).model_dump()


def _account_signature(account: dict[str, Any]) -> str:
    return json.dumps(_to_jsonable(account), sort_keys=True, separators=(",", ":"))


def _load_account_payload(user_id: int) -> dict[str, Any]:
    db = SessionLocal()
    try:
        return _account_payload(db, user_id)
    finally:
        db.close()


def _snapshot_payload(db: Session, user_id: int, symbol: str | None = None) -> dict[str, Any]:
    positions = get_user_contract_positions(
        db,
        user_id=user_id,
        symbol=symbol,
        status="ALL",
    ).model_dump()
    position_summaries = get_user_contract_position_summaries(
        db,
        user_id=user_id,
        symbol=symbol,
    ).model_dump()
    orders = get_user_contract_orders(
        db,
        user_id=user_id,
        symbol=symbol,
        page=1,
        page_size=100,
    ).model_dump()
    trades = get_user_contract_trades(
        db,
        user_id=user_id,
        symbol=symbol,
        page=1,
        page_size=100,
    ).model_dump()
    return {
        "account": _account_payload(db, user_id),
        "positions": positions.get("items") or [],
        "position_summaries": position_summaries.get("items") or [],
        "orders": orders.get("items") or [],
        "trades": trades.get("items") or [],
    }


class ContractPrivateWsManager:
    def __init__(self) -> None:
        self._connections: dict[int, set[WebSocket]] = defaultdict(set)
        self._account_refresh_tasks: dict[int, asyncio.Task[None]] = {}
        self._account_signatures: dict[int, str] = {}
        self._lock = asyncio.Lock()

    async def connect(self, user_id: int, websocket: WebSocket) -> None:
        await websocket.accept()
        async with self._lock:
            self._connections[user_id].add(websocket)
            task = self._account_refresh_tasks.get(user_id)
            if task is None or task.done():
                self._account_refresh_tasks[user_id] = asyncio.create_task(
                    self._account_refresh_loop(user_id)
                )

    async def disconnect(self, user_id: int, websocket: WebSocket) -> None:
        refresh_task: asyncio.Task[None] | None = None
        async with self._lock:
            sockets = self._connections.get(user_id)
            if not sockets:
                return
            sockets.discard(websocket)
            if not sockets:
                self._connections.pop(user_id, None)
                self._account_signatures.pop(user_id, None)
                refresh_task = self._account_refresh_tasks.pop(user_id, None)
        if refresh_task is not None and refresh_task is not asyncio.current_task():
            refresh_task.cancel()

    async def has_user_connections(self, user_id: int) -> bool:
        async with self._lock:
            return bool(self._connections.get(user_id))

    async def _remember_account_signature(self, user_id: int, account: dict[str, Any]) -> None:
        async with self._lock:
            self._account_signatures[user_id] = _account_signature(account)

    async def _refresh_account_if_changed(self, user_id: int) -> bool:
        if not await self.has_user_connections(user_id):
            return False
        account = await asyncio.to_thread(_load_account_payload, user_id)
        signature = _account_signature(account)
        async with self._lock:
            if not self._connections.get(user_id):
                return False
            if self._account_signatures.get(user_id) == signature:
                return False
            self._account_signatures[user_id] = signature
        payload = {"account": account}
        await self._send_to_user(
            user_id,
            self._message("contract_user_account_update", payload, user_id=user_id),
        )
        return True

    async def _account_refresh_loop(self, user_id: int) -> None:
        current_task = asyncio.current_task()
        try:
            while True:
                await asyncio.sleep(CONTRACT_ACCOUNT_EQUITY_REFRESH_INTERVAL_SECONDS)
                if not await self.has_user_connections(user_id):
                    return
                try:
                    await self._refresh_account_if_changed(user_id)
                except Exception:
                    logger.warning(
                        "contract_private_ws_account_refresh_failed user_id=%s",
                        user_id,
                        exc_info=True,
                    )
        except asyncio.CancelledError:
            raise
        finally:
            async with self._lock:
                if self._account_refresh_tasks.get(user_id) is current_task:
                    self._account_refresh_tasks.pop(user_id, None)

    def _message(
        self,
        event_type: str,
        payload: dict[str, Any],
        symbol: str | None = None,
        user_id: int | None = None,
    ) -> dict[str, Any]:
        seq = time.time_ns()
        server_ts = datetime.now(timezone.utc).isoformat()
        message = {
            "type": event_type,
            "event_id": f"contract-user-{uuid4().hex}",
            "seq": seq,
            "server_ts": server_ts,
            "user_id": user_id,
            "symbol": symbol,
            "payload": payload,
        }
        message.update(payload)
        return _to_jsonable(message)

    async def _send_to_user(self, user_id: int, message: dict[str, Any]) -> None:
        async with self._lock:
            sockets = list(self._connections.get(user_id) or [])
        for websocket in sockets:
            try:
                await websocket.send_json(message)
            except Exception:
                logger.debug("contract_private_ws_send_failed user_id=%s", user_id, exc_info=True)
                await self.disconnect(user_id, websocket)

    async def dispatch_published_event(self, message: dict[str, Any]) -> None:
        user_id = message.get("user_id")
        if user_id is None:
            payload = message.get("payload")
            if isinstance(payload, dict):
                user_id = payload.get("user_id")
        try:
            normalized_user_id = int(user_id)
        except (TypeError, ValueError):
            logger.warning("contract_private_ws_event_missing_user_id type=%s", message.get("type"))
            return
        if not await self.has_user_connections(normalized_user_id):
            return
        payload = message.get("payload")
        if message.get("type") == "contract_user_account_update" and isinstance(payload, dict):
            account = payload.get("account")
            if isinstance(account, dict):
                signature = _account_signature(account)
                async with self._lock:
                    if self._account_signatures.get(normalized_user_id) == signature:
                        return
                    self._account_signatures[normalized_user_id] = signature
        await self._send_to_user(normalized_user_id, _to_jsonable(message))

    async def send_snapshot_to_one(
        self,
        websocket: WebSocket,
        db: Session,
        user_id: int,
        symbol: str | None = None,
    ) -> None:
        payload = _snapshot_payload(db, user_id, symbol)
        account = payload.get("account")
        if isinstance(account, dict):
            await self._remember_account_signature(user_id, account)
        await websocket.send_json(self._message("contract_user_snapshot", payload, symbol=symbol, user_id=user_id))

    async def send_account_update(self, db: Session, user_id: int) -> None:
        account = _account_payload(db, user_id)
        signature = _account_signature(account)
        async with self._lock:
            if self._account_signatures.get(user_id) == signature:
                return
            self._account_signatures[user_id] = signature
        payload = {"account": account}
        await self._send_to_user(user_id, self._message("contract_user_account_update", payload, user_id=user_id))

    def build_account_update_event(self, db: Session, user_id: int) -> dict[str, Any]:
        payload = {"account": _account_payload(db, user_id)}
        return self._message("contract_user_account_update", payload, user_id=user_id)

    def build_position_update_event(
        self,
        db: Session,
        user_id: int,
        symbol: str,
        position_id: int | None = None,
    ) -> dict[str, Any]:
        positions = get_user_contract_positions(
            db,
            user_id=user_id,
            symbol=symbol,
            status="ALL",
        ).model_dump().get("items") or []
        summaries = get_user_contract_position_summaries(
            db,
            user_id=user_id,
            symbol=symbol,
        ).model_dump().get("items") or []
        payload = {
            "position": _first(positions, position_id),
            "positions": positions,
            "position_summaries": summaries,
        }
        return self._message("contract_user_position_update", payload, symbol=symbol, user_id=user_id)

    async def send_position_update(
        self,
        db: Session,
        user_id: int,
        symbol: str,
        position_id: int | None = None,
    ) -> None:
        await self._send_to_user(
            user_id,
            self.build_position_update_event(db, user_id, symbol, position_id=position_id),
        )

    def build_order_update_event(
        self,
        db: Session,
        user_id: int,
        symbol: str,
        order_id: int | None = None,
    ) -> dict[str, Any]:
        orders = get_user_contract_orders(
            db,
            user_id=user_id,
            symbol=symbol,
            page=1,
            page_size=100,
        ).model_dump().get("items") or []
        payload = {"order": _first(orders, order_id), "orders": orders}
        return self._message("contract_user_order_update", payload, symbol=symbol, user_id=user_id)

    async def send_order_update(
        self,
        db: Session,
        user_id: int,
        symbol: str,
        order_id: int | None = None,
    ) -> None:
        await self._send_to_user(
            user_id,
            self.build_order_update_event(db, user_id, symbol, order_id=order_id),
        )

    def build_trade_update_event(
        self,
        db: Session,
        user_id: int,
        symbol: str,
        trade_id: int | None = None,
    ) -> dict[str, Any]:
        trades = get_user_contract_trades(
            db,
            user_id=user_id,
            symbol=symbol,
            page=1,
            page_size=100,
        ).model_dump().get("items") or []
        payload = {"trade": _first(trades, trade_id), "trades": trades}
        return self._message("contract_user_trade_update", payload, symbol=symbol, user_id=user_id)

    async def send_trade_update(
        self,
        db: Session,
        user_id: int,
        symbol: str,
        trade_id: int | None = None,
    ) -> None:
        await self._send_to_user(
            user_id,
            self.build_trade_update_event(db, user_id, symbol, trade_id=trade_id),
        )

    async def send_state_update(
        self,
        db: Session,
        user_id: int,
        *,
        symbols: Iterable[str] | None = None,
        position_ids: Iterable[int] | None = None,
        order_ids: Iterable[int] | None = None,
        trade_ids: Iterable[int] | None = None,
        include_account: bool = True,
    ) -> None:
        events = self.build_state_update_events(
            db,
            user_id,
            symbols=symbols,
            position_ids=position_ids,
            order_ids=order_ids,
            trade_ids=trade_ids,
            include_account=include_account,
        )
        for event in events:
            await self.dispatch_published_event(event)

    def build_state_update_events(
        self,
        db: Session,
        user_id: int,
        *,
        symbols: Iterable[str] | None = None,
        position_ids: Iterable[int] | None = None,
        order_ids: Iterable[int] | None = None,
        trade_ids: Iterable[int] | None = None,
        include_account: bool = True,
    ) -> list[dict[str, Any]]:
        events: list[dict[str, Any]] = []
        known_symbols = {str(symbol) for symbol in (symbols or []) if symbol}
        position_ids = [int(item) for item in (position_ids or []) if item is not None]
        order_ids = [int(item) for item in (order_ids or []) if item is not None]
        trade_ids = [int(item) for item in (trade_ids or []) if item is not None]

        if include_account:
            events.append(self.build_account_update_event(db, user_id))

        for position_id in position_ids:
            symbol = _symbol_from_models(db, user_id, position_id=position_id)
            if symbol:
                known_symbols.add(symbol)
                events.append(self.build_position_update_event(db, user_id, symbol, position_id=position_id))

        for order_id in order_ids:
            symbol = _symbol_from_models(db, user_id, order_id=order_id)
            if symbol:
                known_symbols.add(symbol)
                events.append(self.build_order_update_event(db, user_id, symbol, order_id=order_id))
                trade = (
                    db.query(ContractTrade)
                    .filter(ContractTrade.order_id == int(order_id))
                    .filter(ContractTrade.user_id == int(user_id))
                    .order_by(ContractTrade.id.desc())
                    .first()
                )
                if trade and int(trade.id) not in trade_ids:
                    trade_ids.append(int(trade.id))

        for trade_id in trade_ids:
            symbol = _symbol_from_models(db, user_id, trade_id=trade_id)
            if symbol:
                known_symbols.add(symbol)
                events.append(self.build_trade_update_event(db, user_id, symbol, trade_id=trade_id))

        if not position_ids:
            for symbol in sorted(known_symbols):
                events.append(self.build_position_update_event(db, user_id, symbol))
        return events


contract_private_ws_manager = ContractPrivateWsManager()


def _event_redis() -> Redis:
    return Redis.from_url(
        get_redis_url(),
        socket_connect_timeout=0.5,
        socket_timeout=0.5,
        decode_responses=False,
    )


def _utc_iso_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _read_json_key(redis: Redis, key: str) -> dict[str, Any]:
    raw = redis.get(key)
    if raw is None:
        return {}
    if isinstance(raw, bytes):
        raw = raw.decode("utf-8", errors="replace")
    try:
        parsed = json.loads(str(raw))
    except Exception:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _write_publish_health(redis: Redis, *, status: str, error: Exception | None = None) -> None:
    try:
        current = _read_json_key(redis, CONTRACT_USER_EVENT_PUBLISH_HEALTH_KEY)
        failure_count = int(current.get("failure_count") or 0)
        payload = {
            "service": "contract_user_event_publisher",
            "channel": CONTRACT_USER_EVENTS_CHANNEL,
            "status": status,
            "failure_count": failure_count,
            "last_success_at": current.get("last_success_at"),
            "last_failure_at": current.get("last_failure_at"),
            "last_error": current.get("last_error"),
            "updated_at": _utc_iso_now(),
        }
        if status == "ok":
            payload["last_success_at"] = payload["updated_at"]
            payload["last_error"] = ""
        else:
            payload["failure_count"] = failure_count + 1
            payload["last_failure_at"] = payload["updated_at"]
            payload["last_error"] = repr(error)[:240] if error is not None else "publish failed"
        redis.set(CONTRACT_USER_EVENT_PUBLISH_HEALTH_KEY, json.dumps(payload, ensure_ascii=False), ex=3600)
    except Exception:
        logger.debug("contract_private_ws_publish_health_write_failed", exc_info=True)


def _beat_contract_user_event_subscriber(status: str, *, dispatch_count: int = 0) -> None:
    redis = _event_redis()
    try:
        beat_service_heartbeat(
            redis,
            CONTRACT_USER_EVENT_SUBSCRIBER_SERVICE,
            extra_payload={
                "loop_status": status,
                "channel": CONTRACT_USER_EVENTS_CHANNEL,
                "dispatch_count": int(dispatch_count or 0),
            },
        )
    except Exception:
        logger.debug("contract_private_ws_subscriber_heartbeat_failed", exc_info=True)
    finally:
        try:
            redis.close()
        except Exception:
            pass


def _publish_event_to_redis(event: dict[str, Any]) -> None:
    redis = _event_redis()
    try:
        redis.publish(CONTRACT_USER_EVENTS_CHANNEL, json.dumps(_to_jsonable(event), ensure_ascii=False))
        _write_publish_health(redis, status="ok")
    except Exception as exc:
        _write_publish_health(redis, status="failed", error=exc)
        raise
    finally:
        try:
            redis.close()
        except Exception:
            pass


async def _close_redis_resource(resource: Any) -> None:
    close = getattr(resource, "aclose", None) or getattr(resource, "close", None)
    if close is None:
        return
    result = close()
    if hasattr(result, "__await__"):
        await result


def _is_redis_unavailable_error(exc: BaseException) -> bool:
    return isinstance(exc, _REDIS_UNAVAILABLE_ERRORS)


def _redis_unavailable_error_text(exc: BaseException) -> str:
    text = str(exc).strip()
    return text or exc.__class__.__name__


def _decode_event_data(data: Any) -> dict[str, Any] | None:
    if isinstance(data, (bytes, bytearray)):
        data = data.decode("utf-8")
    if isinstance(data, str):
        parsed = json.loads(data)
    else:
        parsed = data
    return parsed if isinstance(parsed, dict) else None


async def _contract_user_event_subscriber_loop(stop_event: asyncio.Event) -> None:
    try:
        import redis.asyncio as redis_async
    except Exception:
        logger.warning("contract_private_ws_subscriber_redis_async_unavailable", exc_info=True)
        return

    retry_delay = 1.0
    last_redis_unavailable_log_at = 0.0
    while not stop_event.is_set():
        redis = None
        pubsub = None
        try:
            redis = redis_async.Redis.from_url(
                get_redis_url(),
                socket_connect_timeout=1.0,
                socket_timeout=1.0,
                decode_responses=False,
            )
            pubsub = redis.pubsub()
            await pubsub.subscribe(CONTRACT_USER_EVENTS_CHANNEL)
            logger.info("contract_private_ws_subscriber_started channel=%s", CONTRACT_USER_EVENTS_CHANNEL)
            retry_delay = 1.0
            dispatch_count = 0
            last_heartbeat_at = 0.0
            await asyncio.to_thread(_beat_contract_user_event_subscriber, "subscribed", dispatch_count=dispatch_count)

            while not stop_event.is_set():
                now = time.monotonic()
                if now - last_heartbeat_at >= 10:
                    await asyncio.to_thread(
                        _beat_contract_user_event_subscriber,
                        "subscribed",
                        dispatch_count=dispatch_count,
                    )
                    last_heartbeat_at = now
                message = await pubsub.get_message(ignore_subscribe_messages=True, timeout=1.0)
                if not message:
                    continue
                try:
                    event = _decode_event_data(message.get("data"))
                    if event:
                        await contract_private_ws_manager.dispatch_published_event(event)
                        dispatch_count += 1
                except Exception:
                    logger.warning("contract_private_ws_subscriber_dispatch_failed", exc_info=True)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            if _is_redis_unavailable_error(exc):
                now = time.monotonic()
                if (
                    last_redis_unavailable_log_at <= 0
                    or now - last_redis_unavailable_log_at >= CONTRACT_USER_EVENT_REDIS_UNAVAILABLE_LOG_INTERVAL_SECONDS
                ):
                    logger.warning(
                        "contract_private_ws_redis_unavailable channel=%s retry_in=%ss error=%s",
                        CONTRACT_USER_EVENTS_CHANNEL,
                        int(retry_delay),
                        _redis_unavailable_error_text(exc),
                    )
                    last_redis_unavailable_log_at = now
            else:
                await asyncio.to_thread(_beat_contract_user_event_subscriber, "reconnecting")
                logger.warning("contract_private_ws_subscriber_failed channel=%s", CONTRACT_USER_EVENTS_CHANNEL, exc_info=True)
            await asyncio.sleep(retry_delay)
            retry_delay = min(retry_delay * 2, 15.0)
        finally:
            if pubsub is not None:
                try:
                    await pubsub.unsubscribe(CONTRACT_USER_EVENTS_CHANNEL)
                except Exception:
                    pass
                await _close_redis_resource(pubsub)
            if redis is not None:
                await _close_redis_resource(redis)


def start_contract_user_event_subscriber() -> None:
    global _subscriber_task, _subscriber_stop_event
    if _subscriber_task is not None and not _subscriber_task.done():
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        logger.warning("contract_private_ws_subscriber_start_failed_no_event_loop")
        return
    _subscriber_stop_event = asyncio.Event()
    _subscriber_task = loop.create_task(_contract_user_event_subscriber_loop(_subscriber_stop_event))


def get_contract_user_event_bridge_health() -> dict[str, Any]:
    redis = _event_redis()
    try:
        subscriber = read_service_heartbeat(redis, CONTRACT_USER_EVENT_SUBSCRIBER_SERVICE)
        subscriber_alive = is_heartbeat_alive(subscriber)
        subscriber_age = heartbeat_age_seconds(subscriber)
        publish_health = _read_json_key(redis, CONTRACT_USER_EVENT_PUBLISH_HEALTH_KEY)
        publish_status = str(publish_health.get("status") or "unknown").lower()
        publish_failed = publish_status == "failed"
        status = "ok" if subscriber_alive and not publish_failed else "degraded"
        return {
            "status": status,
            "channel": CONTRACT_USER_EVENTS_CHANNEL,
            "subscriber": {
                "alive": subscriber_alive,
                "age_seconds": subscriber_age,
                "last_seen_at": subscriber.get("last_seen_at"),
                "loop_status": subscriber.get("loop_status"),
                "pid": subscriber.get("pid"),
                "hostname": subscriber.get("hostname"),
            },
            "publisher": {
                "status": publish_status,
                "failure_count": int(publish_health.get("failure_count") or 0),
                "last_success_at": publish_health.get("last_success_at"),
                "last_failure_at": publish_health.get("last_failure_at"),
                "last_error": publish_health.get("last_error") or "",
            },
            "rest_fallback_recommended": status != "ok",
        }
    except Exception as exc:
        logger.warning("contract_private_ws_bridge_health_read_failed", exc_info=True)
        return {
            "status": "degraded",
            "channel": CONTRACT_USER_EVENTS_CHANNEL,
            "subscriber": {"alive": False},
            "publisher": {"status": "unknown", "last_error": repr(exc)[:240]},
            "rest_fallback_recommended": True,
        }
    finally:
        try:
            redis.close()
        except Exception:
            pass


async def stop_contract_user_event_subscriber() -> None:
    global _subscriber_task, _subscriber_stop_event
    task = _subscriber_task
    stop_event = _subscriber_stop_event
    _subscriber_task = None
    _subscriber_stop_event = None
    if stop_event is not None:
        stop_event.set()
    if task is None:
        return
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass


async def _publish_contract_user_updates(
    *,
    user_id: int,
    symbols: Iterable[str] | None = None,
    position_ids: Iterable[int] | None = None,
    order_ids: Iterable[int] | None = None,
    trade_ids: Iterable[int] | None = None,
    include_account: bool = True,
) -> None:
    db = SessionLocal()
    try:
        events = contract_private_ws_manager.build_state_update_events(
            db,
            user_id,
            symbols=symbols,
            position_ids=position_ids,
            order_ids=order_ids,
            trade_ids=trade_ids,
            include_account=include_account,
        )
        for event in events:
            await asyncio.to_thread(_publish_event_to_redis, event)
    except Exception:
        logger.warning("contract_private_ws_redis_publish_failed user_id=%s", user_id, exc_info=True)
    finally:
        db.close()


def publish_contract_user_updates(
    *,
    user_id: int | None,
    symbols: Iterable[str] | None = None,
    position_ids: Iterable[int] | None = None,
    order_ids: Iterable[int] | None = None,
    trade_ids: Iterable[int] | None = None,
    include_account: bool = True,
) -> None:
    if user_id is None:
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        asyncio.run(
            _publish_contract_user_updates(
                user_id=int(user_id),
                symbols=symbols,
                position_ids=position_ids,
                order_ids=order_ids,
                trade_ids=trade_ids,
                include_account=include_account,
            )
        )
    else:
        loop.create_task(
            _publish_contract_user_updates(
                user_id=int(user_id),
                symbols=symbols,
                position_ids=position_ids,
                order_ids=order_ids,
                trade_ids=trade_ids,
                include_account=include_account,
            )
        )
