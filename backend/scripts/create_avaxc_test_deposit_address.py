from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path
from typing import Any

import requests
from dotenv import load_dotenv
from sqlalchemy import text
from sqlalchemy.orm import Session


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

load_dotenv(ROOT / ".env", override=False)

from app.core.chain_capabilities import CONFIG_ONLY, get_chain_runtime_status, is_chain_deposit_supported  # noqa: E402
from app.db.session import SessionLocal  # noqa: E402
from app.services.address_service import get_or_create_deposit_address  # noqa: E402
from app.services.moralis_service import BASE_URL, MORALIS_API_KEY, STREAM_ID_MAP  # noqa: E402


CHAIN_KEY = "avaxc"
ASSET_SYMBOL = "USDT"
USDT_CONTRACT = "0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7"
DEFAULT_USER_ID = int(os.getenv("AVAXC_TEST_USER_ID", "100000001"))


def _columns(db: Session, table_name: str) -> set[str]:
    try:
        rows = db.execute(
            text(
                """
                SELECT COLUMN_NAME
                FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA = DATABASE()
                  AND TABLE_NAME = :table_name
                """
            ),
            {"table_name": table_name},
        ).mappings().all()
        cols = {str(row["COLUMN_NAME"]) for row in rows}
        if cols:
            return cols
    except Exception:
        db.rollback()

    try:
        rows = db.execute(text(f"PRAGMA table_info({table_name})")).mappings().all()
        return {str(row["name"]) for row in rows}
    except Exception:
        db.rollback()
        return set()


def _mask(value: str) -> str:
    text = (value or "").strip()
    if len(text) <= 12:
        return text
    return f"{text[:6]}...{text[-4:]}"


def _env_bool(name: str) -> bool:
    return os.getenv(name, "").strip().lower() in {"1", "true", "yes", "on"}


def _env_user_id_set(name: str) -> set[int]:
    values: set[int] = set()
    for item in os.getenv(name, "").split(","):
        raw = item.strip()
        if not raw:
            continue
        try:
            values.add(int(raw))
        except ValueError:
            pass
    return values


def _load_asset_chain(db: Session) -> dict[str, Any] | None:
    return db.execute(
        text(
            """
            SELECT
              ac.id,
              ac.contract_address,
              ac.decimals,
              ac.enabled,
              ac.deposit_enabled,
              ac.withdraw_enabled,
              c.id AS chain_id,
              c.chain_key
            FROM asset_chains ac
            JOIN assets a ON a.id = ac.asset_id
            JOIN chains c ON c.id = ac.chain_id
            WHERE UPPER(a.symbol) = :symbol
              AND LOWER(c.chain_key) = :chain_key
            LIMIT 1
            """
        ),
        {"symbol": ASSET_SYMBOL, "chain_key": CHAIN_KEY},
    ).mappings().first()


def _load_existing_address(db: Session, *, user_id: int, chain_id: int) -> dict[str, Any] | None:
    return db.execute(
        text(
            """
            SELECT id, user_id, chain_id, address, memo, enabled
            FROM user_chain_addresses
            WHERE user_id = :user_id
              AND chain_id = :chain_id
              AND enabled = 1
            LIMIT 1
            """
        ),
        {"user_id": user_id, "chain_id": chain_id},
    ).mappings().first()


def _mark_watch_status(db: Session, *, address_id: int, ok: bool, err: str = "") -> None:
    columns = _columns(db, "user_chain_addresses")
    if "watch_registered" not in columns:
        return
    if ok:
        db.execute(
            text(
                """
                UPDATE user_chain_addresses
                SET watch_registered = 1,
                    watch_registered_at = UTC_TIMESTAMP(),
                    watch_register_err = NULL
                WHERE id = :id
                """
            ),
            {"id": address_id},
        )
        db.commit()
        return
    if "watch_register_err" not in columns:
        return
    db.execute(
        text(
            """
            UPDATE user_chain_addresses
            SET watch_registered = 0,
                watch_register_err = :err
            WHERE id = :id
            """
        ),
        {"id": address_id, "err": err[:250]},
    )
    db.commit()


def _add_address_to_avaxc_stream(address: str) -> dict[str, Any]:
    stream_id = (STREAM_ID_MAP.get("AVAXC") or "").strip()
    result: dict[str, Any] = {
        "stream_id": stream_id,
        "stream_id_masked": _mask(stream_id),
        "ok": False,
        "status_code": None,
        "message": "",
    }
    if not stream_id:
        result["message"] = "MORALIS_STREAM_ID_AVAXC missing"
        return result
    if not MORALIS_API_KEY:
        result["message"] = "MORALIS_API_KEY missing"
        return result
    if len(stream_id) != 36 or stream_id.count("-") != 4:
        result["message"] = "invalid MORALIS_STREAM_ID_AVAXC format"
        return result

    try:
        response = requests.post(
            f"{BASE_URL}/{stream_id}/address",
            headers={
                "X-API-Key": MORALIS_API_KEY,
                "Content-Type": "application/json",
                "accept": "application/json",
            },
            json={"address": [address.lower()]},
            timeout=20,
        )
    except Exception as exc:
        result["message"] = repr(exc)
        return result

    result["status_code"] = response.status_code
    if response.status_code == 201:
        result["ok"] = True
        result["message"] = "address added"
    elif response.status_code == 200:
        result["ok"] = True
        result["message"] = "address already registered"
    else:
        result["message"] = response.text[:300]
    return result


def create_test_address(user_id: int) -> int:
    internal_test_enabled_raw = os.getenv("AVAXC_INTERNAL_DEPOSIT_TEST_ENABLED", "")
    internal_test_enabled = _env_bool("AVAXC_INTERNAL_DEPOSIT_TEST_ENABLED")
    internal_test_user_ids_raw = os.getenv("AVAXC_INTERNAL_DEPOSIT_TEST_USER_IDS", "")
    internal_test_allowlist = _env_user_id_set("AVAXC_INTERNAL_DEPOSIT_TEST_USER_IDS")
    internal_test_user_allowed = int(user_id) in internal_test_allowlist

    db = SessionLocal()
    try:
        asset_chain = _load_asset_chain(db)
        if not asset_chain:
            raise RuntimeError("USDT + avaxc asset_chain missing")
        contract = str(asset_chain.get("contract_address") or "").strip().lower()
        if contract != USDT_CONTRACT:
            raise RuntimeError(f"USDT avaxc contract mismatch: {contract or '(empty)'}")
        if int(asset_chain.get("deposit_enabled") or 0) != 0:
            raise RuntimeError("avaxc deposit_enabled must stay 0")
        if int(asset_chain.get("withdraw_enabled") or 0) != 0:
            raise RuntimeError("avaxc withdraw_enabled must stay 0")

        runtime_status = get_chain_runtime_status(CHAIN_KEY)
        if runtime_status != CONFIG_ONLY or is_chain_deposit_supported(CHAIN_KEY):
            raise RuntimeError(f"avaxc capability must stay CONFIG_ONLY, got {runtime_status}")

        chain_id = int(asset_chain["chain_id"])
        before = _load_existing_address(db, user_id=user_id, chain_id=chain_id)
        address, memo = get_or_create_deposit_address(db, user_id=user_id, chain_key=CHAIN_KEY)
        db.commit()
        after = _load_existing_address(db, user_id=user_id, chain_id=chain_id)
        if not after:
            raise RuntimeError("address row missing after get_or_create_deposit_address")

        stream_result = _add_address_to_avaxc_stream(address)
        try:
            _mark_watch_status(
                db,
                address_id=int(after["id"]),
                ok=bool(stream_result["ok"]),
                err=str(stream_result.get("message") or ""),
            )
        except Exception:
            db.rollback()

        print(f"user_id={user_id}")
        print(f"chain_key={CHAIN_KEY}")
        print(f"asset={ASSET_SYMBOL}")
        print(f"address={address.lower()}")
        print(f"memo={memo or ''}")
        print(f"address_row_id={after['id']}")
        print(f"created_new={before is None}")
        print(f"stream_id={stream_result['stream_id_masked']}")
        print(f"stream_join_ok={stream_result['ok']}")
        print(f"stream_join_status={stream_result['status_code']}")
        print(f"stream_join_message={stream_result['message']}")
        print(f"capability_runtime_status={runtime_status}")
        print(f"AVAXC_INTERNAL_DEPOSIT_TEST_ENABLED={internal_test_enabled_raw or '(unset)'}")
        print(f"AVAXC_INTERNAL_DEPOSIT_TEST_USER_IDS={internal_test_user_ids_raw or '(unset)'}")
        print(f"internal_deposit_test_enabled={internal_test_enabled}")
        print(f"internal_deposit_test_user_allowed={internal_test_user_allowed}")
        if not internal_test_enabled or not internal_test_user_allowed:
            print("internal_deposit_test_ready=False")
            print("internal_deposit_test_message=configure AVAXC_INTERNAL_DEPOSIT_TEST_ENABLED=true and include this user_id in AVAXC_INTERNAL_DEPOSIT_TEST_USER_IDS before real credit validation")
        else:
            print("internal_deposit_test_ready=True")
        print("deposit_enabled=0")
        print("withdraw_enabled=0")
        return 0 if stream_result["ok"] else 2
    finally:
        db.close()


def main() -> int:
    parser = argparse.ArgumentParser(description="Create/read an internal avaxc USDT test deposit address.")
    parser.add_argument("--user-id", type=int, default=DEFAULT_USER_ID)
    args = parser.parse_args()
    return create_test_address(int(args.user_id))


if __name__ == "__main__":
    raise SystemExit(main())
