from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from sqlalchemy import text

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.db.session import engine


TARGET_FIELDS = ("title", "summary", "content", "category", "category_label")

MOJIBAKE_MARKERS = {
    "\ufffd",
    "\u3126",
    "\u935a",
    "\u934f",
    "\u9422",
    "\u9435",
    "\u93cd",
    "\u95c6",
    "\u7f01",
    "\u7ec2",
    "\u9a9e",
    "\u5a32",
    "\u7eef",
}


def _has_private_use(value: str) -> bool:
    return any("\ue000" <= char <= "\uf8ff" for char in value)


def _suspicion_score(value: str) -> int:
    score = 0
    score += sum(6 for char in value if char in MOJIBAKE_MARKERS)
    score += sum(10 for char in value if "\ue000" <= char <= "\uf8ff")
    score += value.count("\ufffd") * 10
    return score


def _looks_like_mojibake(value: str) -> bool:
    if not value:
        return False
    return _has_private_use(value) or any(char in value for char in MOJIBAKE_MARKERS)


def fix_mojibake(value: Any) -> str | None:
    if not isinstance(value, str) or not _looks_like_mojibake(value):
        return None
    try:
        fixed = value.encode("gbk").decode("utf-8")
    except UnicodeError:
        return None
    if fixed == value:
        return None
    if _suspicion_score(fixed) >= _suspicion_score(value):
        return None
    return fixed


def main() -> int:
    parser = argparse.ArgumentParser(description="Repair obvious mojibake in announcements text fields.")
    parser.add_argument("--apply", action="store_true", help="Write changes. Without this flag the script only previews.")
    args = parser.parse_args()

    with engine.begin() as conn:
        existing_columns = {
            row["Field"]
            for row in conn.execute(text("SHOW COLUMNS FROM announcements")).mappings().all()
        }
        fields = [field for field in TARGET_FIELDS if field in existing_columns]
        if not fields:
            print("No target fields exist on announcements.")
            return 0

        select_columns = ", ".join(["id", *fields])
        rows = conn.execute(text(f"SELECT {select_columns} FROM announcements ORDER BY id ASC")).mappings().all()

        changed_rows = 0
        for row in rows:
            updates: dict[str, str] = {}
            for field in fields:
                fixed = fix_mojibake(row.get(field))
                if fixed is not None:
                    updates[field] = fixed
                    print(
                        json.dumps(
                            {
                                "id": row["id"],
                                "field": field,
                                "old": row[field],
                                "new": fixed,
                            },
                            ensure_ascii=False,
                        )
                    )

            if not updates:
                continue

            changed_rows += 1
            if args.apply:
                set_clause = ", ".join(f"{field} = :{field}" for field in updates)
                conn.execute(
                    text(f"UPDATE announcements SET {set_clause} WHERE id = :id"),
                    {**updates, "id": row["id"]},
                )

    mode = "applied" if args.apply else "dry-run"
    print(f"{mode}: {changed_rows} announcement row(s) with mojibake changes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
