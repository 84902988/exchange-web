from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any, Dict

from sqlalchemy import bindparam, text
from sqlalchemy.orm import Session


EXCLUDED_STATUSES = ("REJECTED", "FAILED", "CANCELED")


def _normalize_code(value: Any) -> str:
    return str(value or "").strip().upper()


def _normalize_chain_key(value: Any) -> str:
    return str(value or "").strip().lower()


def _normalize_limit(value: Any) -> int:
    try:
        limit = int(value or 0)
    except (TypeError, ValueError):
        return 0
    return max(limit, 0)


def _current_day_range() -> tuple[datetime, datetime]:
    day_start = datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
    return day_start, day_start + timedelta(days=1)


def check_withdraw_risk(
    db: Session,
    user_id: int,
    coin_symbol: Any,
    chain_key: Any,
    daily_withdraw_count_limit: Any = None,
) -> Dict[str, Any]:
    normalized_coin_symbol = _normalize_code(coin_symbol)
    normalized_chain_key = _normalize_chain_key(chain_key)
    daily_count_limit = _normalize_limit(daily_withdraw_count_limit)

    result: Dict[str, Any] = {
        "need_manual_review": False,
        "reason": "ok",
        "daily_count": 0,
        "daily_withdraw_count_limit": daily_count_limit,
    }

    if daily_count_limit <= 0:
        return result

    day_start, day_end = _current_day_range()
    row = db.execute(
        text(
            """
            SELECT COUNT(1) AS daily_count
            FROM withdraw_logs
            WHERE user_id = :user_id
              AND coin_symbol = :coin_symbol
              AND LOWER(chain_key) = :chain_key
              AND created_at >= :day_start
              AND created_at < :day_end
              AND status NOT IN :excluded_statuses
            """
        ).bindparams(bindparam("excluded_statuses", expanding=True)),
        {
            "user_id": user_id,
            "coin_symbol": normalized_coin_symbol,
            "chain_key": normalized_chain_key,
            "day_start": day_start,
            "day_end": day_end,
            "excluded_statuses": EXCLUDED_STATUSES,
        },
    ).mappings().one()

    daily_count = int(row.get("daily_count") or 0)
    result["daily_count"] = daily_count

    if daily_count >= daily_count_limit:
        result["need_manual_review"] = True
        result["reason"] = "daily_count_limit"

    return result
