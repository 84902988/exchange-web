from __future__ import annotations

import logging
import os
import signal
import socket
import sys
import threading
from pathlib import Path


BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.core.rq import get_redis_connection  # noqa: E402
from app.db.session import SessionLocal  # noqa: E402
from app.services.contract_order_service import scan_and_execute_contract_limit_orders  # noqa: E402
from app.services.service_heartbeat import start_heartbeat_thread  # noqa: E402


logger = logging.getLogger("contract_limit_order_scanner")

SERVICE_NAME = "contract_limit_order_scanner"
LOCK_KEY = "service:lock:contract_limit_order_scanner"
DEFAULT_LOCK_TTL_SECONDS = 30


def _env_int(name: str, default: int, minimum: int = 1, maximum: int = 1000) -> int:
    try:
        value = int(os.getenv(name, str(default)))
    except Exception:
        value = default
    return min(max(value, minimum), maximum)


def _owner_id() -> str:
    return f"{socket.gethostname()}:{os.getpid()}"


def _decode_redis_text(value: object) -> str:
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return str(value or "")


def _acquire_or_refresh_lock(redis_conn: object, owner: str, ttl_seconds: int) -> bool:
    if redis_conn.set(LOCK_KEY, owner, nx=True, ex=ttl_seconds):
        return True
    current_owner = _decode_redis_text(redis_conn.get(LOCK_KEY))
    if current_owner == owner:
        redis_conn.expire(LOCK_KEY, ttl_seconds)
        return True
    return False


def _release_lock(redis_conn: object, owner: str) -> None:
    try:
        current_owner = _decode_redis_text(redis_conn.get(LOCK_KEY))
        if current_owner == owner:
            redis_conn.delete(LOCK_KEY)
    except Exception:
        logger.debug("contract limit scanner lock release failed", exc_info=True)


def _install_stop_handlers(stop_event: threading.Event) -> None:
    def _handle_stop(signum, frame) -> None:
        logger.info("contract limit scanner stopping signal=%s", signum)
        stop_event.set()

    for sig in (getattr(signal, "SIGINT", None), getattr(signal, "SIGTERM", None)):
        if sig is not None:
            try:
                signal.signal(sig, _handle_stop)
            except Exception:
                pass


def run_forever() -> None:
    stop_event = threading.Event()
    _install_stop_handlers(stop_event)

    interval = _env_int("CONTRACT_LIMIT_ORDER_INTERVAL", 2, minimum=1, maximum=60)
    limit = _env_int("CONTRACT_LIMIT_ORDER_LIMIT", 100, minimum=1, maximum=1000)
    lock_ttl = _env_int("CONTRACT_LIMIT_ORDER_LOCK_TTL", DEFAULT_LOCK_TTL_SECONDS, minimum=10, maximum=300)
    owner = _owner_id()
    state = {"loop_status": "starting", "owner": owner, "last_result": "-"}

    heartbeat_stop_event = start_heartbeat_thread(
        SERVICE_NAME,
        stop_event=stop_event,
        extra_payload_factory=lambda: dict(state),
    )
    logger.info(
        "contract limit scanner started interval=%ss limit=%s lock_ttl=%ss owner=%s",
        interval,
        limit,
        lock_ttl,
        owner,
    )

    redis_conn = None
    lock_owned = False
    try:
        while not stop_event.is_set():
            try:
                if redis_conn is None:
                    redis_conn = get_redis_connection()
                lock_owned = _acquire_or_refresh_lock(redis_conn, owner, lock_ttl)
            except Exception:
                redis_conn = None
                lock_owned = False
                state["loop_status"] = "lock_unavailable"
                state["last_result"] = "redis_lock_error"
                logger.warning("contract limit scanner lock unavailable", exc_info=True)

            if not lock_owned:
                state["loop_status"] = "waiting_for_lock"
                state["last_result"] = "lock_held_by_other_owner"
                stop_event.wait(interval)
                continue

            state["loop_status"] = "scanning"
            db = SessionLocal()
            try:
                results = scan_and_execute_contract_limit_orders(db, limit=limit)
                state["last_result"] = f"executed={len(results)}"
                if results:
                    logger.info("contract limit scanner executed=%s", len(results))
            except Exception:
                db.rollback()
                state["loop_status"] = "round_failed"
                state["last_result"] = "round_failed"
                logger.exception("contract limit scanner round failed")
            finally:
                db.close()

            state["loop_status"] = "sleeping"
            stop_event.wait(interval)
    finally:
        heartbeat_stop_event.set()
        if redis_conn is not None and lock_owned:
            _release_lock(redis_conn, owner)
        try:
            if redis_conn is not None:
                redis_conn.close()
        except Exception:
            pass
        logger.info("contract limit scanner stopped")


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    try:
        run_forever()
    except KeyboardInterrupt:
        logger.info("contract limit scanner stopped by keyboard interrupt")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
