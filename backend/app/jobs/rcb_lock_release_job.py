from __future__ import annotations

import logging
from datetime import datetime
from decimal import Decimal

from app.db.models.user_rcb_lock import UserRcbLock
from app.db.session import SessionLocal
from app.services.rcb_lock_service import release_matured_user_rcb_locks


logger = logging.getLogger(__name__)
DEFAULT_BATCH_LIMIT = 500


def process_rcb_lock_release_job_once(limit: int = DEFAULT_BATCH_LIMIT) -> dict:
    """Release due RCB locks in small per-user transactions.

    A failure for one account is isolated so it cannot roll back releases for
    other users.  Row locks plus the balance-log unique key make retries safe.
    """
    batch_limit = max(1, min(int(limit or DEFAULT_BATCH_LIMIT), 2000))
    now_value = datetime.utcnow()
    scan_db = SessionLocal()
    try:
        user_rows = (
            scan_db.query(UserRcbLock.user_id)
            .filter(
                UserRcbLock.asset_symbol == "RCB",
                UserRcbLock.status == "LOCKED",
                UserRcbLock.end_time <= now_value,
            )
            .group_by(UserRcbLock.user_id)
            .order_by(UserRcbLock.user_id.asc())
            .limit(batch_limit)
            .all()
        )
        user_ids = [int(row[0]) for row in user_rows]
    finally:
        scan_db.close()

    released_count = 0
    released_amount = Decimal("0")
    released_lock_ids: list[int] = []
    failed_user_ids: list[int] = []
    for user_id in user_ids:
        db = SessionLocal()
        try:
            result = release_matured_user_rcb_locks(
                db,
                user_id=user_id,
                now=now_value,
                limit=500,
            )
            db.commit()
            released_count += int(result["released_count"])
            released_amount += Decimal(str(result["released_amount"]))
            released_lock_ids.extend(int(lock_id) for lock_id in result["lock_ids"])
        except Exception:
            db.rollback()
            failed_user_ids.append(user_id)
            logger.exception("RCB matured lock release failed user_id=%s", user_id)
        finally:
            db.close()

    return {
        "ok": not failed_user_ids,
        "scanned_user_count": len(user_ids),
        "released_count": released_count,
        "released_amount": format(released_amount.quantize(Decimal("0.000000000000000001")), "f"),
        "lock_ids": released_lock_ids,
        "failed_user_ids": failed_user_ids,
    }
