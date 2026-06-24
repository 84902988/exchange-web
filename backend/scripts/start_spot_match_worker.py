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
from app.db.models.trading_pair import TradingPair  # noqa: E402
from app.db.session import SessionLocal  # noqa: E402
from app.services.matching import run_match_loop  # noqa: E402
from app.services.service_heartbeat import start_heartbeat_thread  # noqa: E402


logger = logging.getLogger("spot_match_worker")

SERVICE_NAME = "spot_match_worker"
LOCK_KEY = "service:lock:spot_match_worker"
DEFAULT_LOCK_TTL_SECONDS = 30


def _env_int(name: str, default: int, minimum: int = 1, maximum: int = 1000) -> int:
    try:
        value = int(os.getenv(name, str(default)))
    except Exception:
        value = default
    return min(max(value, minimum), maximum)


def _env_float(name: str, default: float, minimum: float = 0.1, maximum: float = 60.0) -> float:
    try:
        value = float(os.getenv(name, str(default)))
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
        logger.debug("spot match worker lock release failed", exc_info=True)


def _install_stop_handlers(stop_event: threading.Event) -> None:
    def _handle_stop(signum, frame) -> None:
        logger.info("spot match worker stopping signal=%s", signum)
        stop_event.set()

    for sig in (getattr(signal, "SIGINT", None), getattr(signal, "SIGTERM", None)):
        if sig is not None:
            try:
                signal.signal(sig, _handle_stop)
            except Exception:
                pass


def _list_active_trading_pair_ids() -> list[int]:
    db = SessionLocal()
    try:
        rows = db.query(TradingPair.id).filter(TradingPair.status == 1).all()
        return [int(row[0]) for row in rows]
    finally:
        db.close()


def _run_match_cycle(max_rounds_per_pair: int) -> tuple[int, int, int]:
    pair_ids = _list_active_trading_pair_ids()
    matched_count = 0
    error_count = 0

    for pair_id in pair_ids:
        db = SessionLocal()
        try:
            result = run_match_loop(
                db,
                int(pair_id),
                max_rounds=max_rounds_per_pair,
                skip_dirty_orders=True,
            )
            matched_count += int((result or {}).get("matched_count") or 0)
        except Exception:
            db.rollback()
            error_count += 1
            logger.exception("spot match worker pair cycle failed pair_id=%s", pair_id)
        finally:
            db.close()

    return len(pair_ids), matched_count, error_count


def run_forever() -> None:
    stop_event = threading.Event()
    _install_stop_handlers(stop_event)

    interval = _env_float("SPOT_MATCH_INTERVAL_SECONDS", 0.5, minimum=0.1, maximum=60.0)
    max_rounds = _env_int("SPOT_MATCH_MAX_ROUNDS_PER_PAIR", 100, minimum=1, maximum=1000)
    lock_ttl = _env_int("SPOT_MATCH_LOCK_TTL", DEFAULT_LOCK_TTL_SECONDS, minimum=10, maximum=300)
    owner = _owner_id()
    state = {
        "loop_status": "starting",
        "owner": owner,
        "last_result": "-",
        "active_pairs": 0,
        "matched_count": 0,
        "error_count": 0,
    }

    heartbeat_stop_event = start_heartbeat_thread(
        SERVICE_NAME,
        stop_event=stop_event,
        extra_payload_factory=lambda: dict(state),
    )
    logger.info(
        "spot match worker started interval=%ss max_rounds_per_pair=%s lock_ttl=%ss owner=%s",
        interval,
        max_rounds,
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
                logger.warning("spot match worker lock unavailable", exc_info=True)

            if not lock_owned:
                state["loop_status"] = "waiting_for_lock"
                state["last_result"] = "lock_held_by_other_owner"
                stop_event.wait(interval)
                continue

            state["loop_status"] = "matching"
            try:
                active_pairs, matched_count, error_count = _run_match_cycle(max_rounds)
                state["active_pairs"] = active_pairs
                state["matched_count"] = matched_count
                state["error_count"] = error_count
                state["last_result"] = (
                    f"pairs={active_pairs}, matched={matched_count}, errors={error_count}"
                )
                if matched_count:
                    logger.info("spot match worker matched=%s active_pairs=%s", matched_count, active_pairs)
            except Exception:
                state["loop_status"] = "round_failed"
                state["last_result"] = "round_failed"
                logger.exception("spot match worker round failed")

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
        logger.info("spot match worker stopped")


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    try:
        run_forever()
    except KeyboardInterrupt:
        logger.info("spot match worker stopped by keyboard interrupt")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
