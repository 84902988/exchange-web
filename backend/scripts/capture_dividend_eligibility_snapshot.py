from __future__ import annotations

import json
import sys
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Optional


BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.db.session import SessionLocal  # noqa: E402
from app.services.dividend_service import capture_dividend_eligibility_snapshot  # noqa: E402


def process_dividend_eligibility_snapshot_once(
    now_utc: Optional[datetime] = None,
) -> dict[str, Any]:
    now = now_utc or datetime.utcnow()
    dividend_date = now.date() - timedelta(days=1)
    db = SessionLocal()
    try:
        snapshot, created = capture_dividend_eligibility_snapshot(
            db,
            dividend_date,
            now_utc=now,
        )
        db.commit()
        return {
            "ok": True,
            "created": created,
            "snapshot_id": int(snapshot.id),
            "dividend_date": dividend_date.isoformat(),
            "snapshot_at": snapshot.snapshot_at.isoformat(),
            "eligible_user_count": int(snapshot.eligible_user_count or 0),
        }
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def main() -> int:
    try:
        result = process_dividend_eligibility_snapshot_once()
        print(json.dumps(result, ensure_ascii=False, sort_keys=True))
        return 0
    except Exception as exc:
        print(json.dumps({"ok": False, "error": repr(exc)}, ensure_ascii=False, sort_keys=True))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
