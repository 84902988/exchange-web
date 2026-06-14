from __future__ import annotations

import os
import re
import sys
from pathlib import Path
from typing import Any

from sqlalchemy import text
from sqlalchemy.orm import Session


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.core.chain_capabilities import get_chain_runtime_status  # noqa: E402
from app.db.session import SessionLocal  # noqa: E402


CHAIN_KEY = "avaxc"
CHAIN_NAME = "Avalanche C-Chain"
CHAIN_ID = 43114
CHAIN_TYPE = "EVM"
NATIVE_SYMBOL = "AVAX"
CONFIRMATIONS = 12
EXPLORER_TX_URL = "https://snowtrace.io/tx/{tx}"
USDT_SYMBOL = "USDT"


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


def _timestamp_sql(db: Session) -> str:
    return "UTC_TIMESTAMP(3)" if db.bind and db.bind.dialect.name.startswith("mysql") else "CURRENT_TIMESTAMP"


def _chain_id_column(chain_columns: set[str]) -> str:
    if "chain_id" in chain_columns:
        return "chain_id"
    if "chain_value" in chain_columns:
        return "chain_value"
    raise RuntimeError("chains table must contain chain_id or chain_value")


def _validate_contract(value: str) -> str:
    contract = (value or "").strip()
    if not contract:
        return ""
    if not re.fullmatch(r"0x[a-fA-F0-9]{40}", contract):
        raise RuntimeError("AVAXC_USDT_CONTRACT_ADDRESS must be a 0x-prefixed EVM address")
    return contract.lower()


def _select_chain(db: Session, chain_id_col: str) -> dict[str, Any] | None:
    return db.execute(
        text(
            f"""
            SELECT id, chain_key, name, {chain_id_col} AS chain_id, native_symbol,
                   confirmations, explorer_tx_url, collection_address, hot_wallet_address, enabled
            FROM chains
            WHERE chain_key = :chain_key
            LIMIT 1
            """
        ),
        {"chain_key": CHAIN_KEY},
    ).mappings().first()


def _select_usdt_asset(db: Session) -> dict[str, Any] | None:
    return db.execute(
        text("SELECT id, symbol FROM assets WHERE UPPER(symbol) = :symbol LIMIT 1"),
        {"symbol": USDT_SYMBOL},
    ).mappings().first()


def _select_asset_chain(db: Session, *, asset_id: int, chain_id: int) -> dict[str, Any] | None:
    return db.execute(
        text(
            """
            SELECT *
            FROM asset_chains
            WHERE asset_id = :asset_id
              AND chain_id = :chain_id
            LIMIT 1
            """
        ),
        {"asset_id": asset_id, "chain_id": chain_id},
    ).mappings().first()


def _load_usdt_defaults(db: Session) -> dict[str, Any]:
    row = db.execute(
        text(
            """
            SELECT ac.*
            FROM asset_chains ac
            JOIN assets a ON a.id = ac.asset_id
            JOIN chains c ON c.id = ac.chain_id
            WHERE UPPER(a.symbol) = :symbol
              AND LOWER(c.chain_key) IN ('bsc', 'polygon')
            ORDER BY CASE LOWER(c.chain_key) WHEN 'bsc' THEN 1 WHEN 'polygon' THEN 2 ELSE 3 END
            LIMIT 1
            """
        ),
        {"symbol": USDT_SYMBOL},
    ).mappings().first()
    return dict(row or {})


def _insert_chain(db: Session, chain_columns: set[str], chain_id_col: str) -> None:
    now_sql = _timestamp_sql(db)
    values: dict[str, Any] = {
        "chain_key": CHAIN_KEY,
        "name": CHAIN_NAME,
        chain_id_col: CHAIN_ID,
        "native_symbol": NATIVE_SYMBOL,
        "confirmations": CONFIRMATIONS,
        "explorer_tx_url": EXPLORER_TX_URL,
        "enabled": 1,
    }
    if "chain_type" in chain_columns:
        values["chain_type"] = CHAIN_TYPE
    if "collection_address" in chain_columns:
        values["collection_address"] = os.getenv("AVAXC_COLLECTION_ADDRESS", "").strip() or None
    if "hot_wallet_address" in chain_columns:
        values["hot_wallet_address"] = os.getenv("AVAXC_HOT_WALLET_ADDRESS", "").strip() or None
    if "created_at" in chain_columns:
        values["created_at"] = now_sql
    if "updated_at" in chain_columns:
        values["updated_at"] = now_sql

    columns = list(values.keys())
    placeholders = [values[col] if col in {"created_at", "updated_at"} else f":{col}" for col in columns]
    params = {k: v for k, v in values.items() if k not in {"created_at", "updated_at"}}
    db.execute(
        text(
            f"""
            INSERT INTO chains ({", ".join(columns)})
            VALUES ({", ".join(str(item) for item in placeholders)})
            """
        ),
        params,
    )


def _update_chain(db: Session, chain_columns: set[str], chain_id_col: str, record_id: int) -> None:
    now_sql = _timestamp_sql(db)
    assignments = [
        "name = :name",
        f"{chain_id_col} = :chain_id",
        "native_symbol = :native_symbol",
        "confirmations = :confirmations",
        "explorer_tx_url = :explorer_tx_url",
        "enabled = 1",
    ]
    params: dict[str, Any] = {
        "record_id": record_id,
        "name": CHAIN_NAME,
        "chain_id": CHAIN_ID,
        "native_symbol": NATIVE_SYMBOL,
        "confirmations": CONFIRMATIONS,
        "explorer_tx_url": EXPLORER_TX_URL,
    }
    if "chain_type" in chain_columns:
        assignments.append("chain_type = :chain_type")
        params["chain_type"] = CHAIN_TYPE
    collection_address = os.getenv("AVAXC_COLLECTION_ADDRESS", "").strip()
    if collection_address and "collection_address" in chain_columns:
        assignments.append("collection_address = :collection_address")
        params["collection_address"] = collection_address
    hot_wallet_address = os.getenv("AVAXC_HOT_WALLET_ADDRESS", "").strip()
    if hot_wallet_address and "hot_wallet_address" in chain_columns:
        assignments.append("hot_wallet_address = :hot_wallet_address")
        params["hot_wallet_address"] = hot_wallet_address
    if "updated_at" in chain_columns:
        assignments.append(f"updated_at = {now_sql}")

    db.execute(
        text(
            f"""
            UPDATE chains
            SET {", ".join(assignments)}
            WHERE id = :record_id
            """
        ),
        params,
    )


def _asset_chain_insert_values(
    asset_chain_columns: set[str],
    *,
    asset_id: int,
    chain_id: int,
    contract_address: str,
    defaults: dict[str, Any],
    db: Session,
) -> tuple[list[str], list[str], dict[str, Any]]:
    now_sql = _timestamp_sql(db)
    values: dict[str, Any] = {
        "asset_id": asset_id,
        "chain_id": chain_id,
        "contract_address": contract_address or None,
        "decimals": 6,
        "deposit_enabled": 0,
        "withdraw_enabled": 0,
        "enabled": 1,
        "min_deposit": defaults.get("min_deposit") if defaults.get("min_deposit") is not None else 0,
        "min_withdraw": defaults.get("min_withdraw") if defaults.get("min_withdraw") is not None else 0,
        "review_threshold_amount": defaults.get("review_threshold_amount"),
        "force_manual_review": int(defaults.get("force_manual_review") or 0),
        "daily_withdraw_count_limit": defaults.get("daily_withdraw_count_limit"),
        "confirmations": CONFIRMATIONS,
        "sort": defaults.get("sort") if defaults.get("sort") is not None else 100,
    }
    if "withdraw_fee" in asset_chain_columns:
        values["withdraw_fee"] = defaults.get("withdraw_fee") if defaults.get("withdraw_fee") is not None else 0
    if "created_at" in asset_chain_columns:
        values["created_at"] = now_sql
    if "updated_at" in asset_chain_columns:
        values["updated_at"] = now_sql

    columns = [col for col in values if col in asset_chain_columns]
    placeholders = [values[col] if col in {"created_at", "updated_at"} else f":{col}" for col in columns]
    params = {col: values[col] for col in columns if col not in {"created_at", "updated_at"}}
    return columns, [str(item) for item in placeholders], params


def _insert_asset_chain(
    db: Session,
    asset_chain_columns: set[str],
    *,
    asset_id: int,
    chain_id: int,
    contract_address: str,
    defaults: dict[str, Any],
) -> None:
    columns, placeholders, params = _asset_chain_insert_values(
        asset_chain_columns,
        asset_id=asset_id,
        chain_id=chain_id,
        contract_address=contract_address,
        defaults=defaults,
        db=db,
    )
    db.execute(
        text(
            f"""
            INSERT INTO asset_chains ({", ".join(columns)})
            VALUES ({", ".join(placeholders)})
            """
        ),
        params,
    )


def _update_asset_chain(
    db: Session,
    asset_chain_columns: set[str],
    *,
    asset_chain_id: int,
    contract_address: str,
) -> None:
    now_sql = _timestamp_sql(db)
    assignments = [
        "decimals = 6",
        "deposit_enabled = 0",
        "withdraw_enabled = 0",
        "enabled = 1",
        "confirmations = :confirmations",
    ]
    params: dict[str, Any] = {"asset_chain_id": asset_chain_id, "confirmations": CONFIRMATIONS}
    if contract_address:
        assignments.append("contract_address = :contract_address")
        params["contract_address"] = contract_address
    if "updated_at" in asset_chain_columns:
        assignments.append(f"updated_at = {now_sql}")

    db.execute(
        text(
            f"""
            UPDATE asset_chains
            SET {", ".join(assignments)}
            WHERE id = :asset_chain_id
            """
        ),
        params,
    )


def _print_status(chain: dict[str, Any] | None, asset_chain: dict[str, Any] | None) -> None:
    if chain:
        print(
            "[status] chain "
            f"id={chain.get('id')} chain_key={chain.get('chain_key')} chain_id={chain.get('chain_id')} "
            f"native={chain.get('native_symbol')} confirmations={chain.get('confirmations')} enabled={chain.get('enabled')}"
        )
    else:
        print("[status] chain missing")
    if asset_chain:
        print(
            "[status] USDT asset_chain "
            f"id={asset_chain.get('id')} contract={asset_chain.get('contract_address') or '(empty)'} "
            f"decimals={asset_chain.get('decimals')} deposit_enabled={asset_chain.get('deposit_enabled')} "
            f"withdraw_enabled={asset_chain.get('withdraw_enabled')} enabled={asset_chain.get('enabled')}"
        )
    else:
        print("[status] USDT asset_chain missing")
    print(f"[status] capability runtime_status={get_chain_runtime_status(CHAIN_KEY)}")


def main() -> int:
    contract_address = _validate_contract(os.getenv("AVAXC_USDT_CONTRACT_ADDRESS", ""))
    print("[plan] ensure chains.avaxc exists and is enabled with chain_id=43114")
    print("[plan] ensure USDT asset_chain for avaxc exists")
    print("[plan] force deposit_enabled=0 and withdraw_enabled=0")
    if contract_address:
        print(f"[plan] use AVAXC_USDT_CONTRACT_ADDRESS={contract_address}")
    else:
        print("[plan] AVAXC_USDT_CONTRACT_ADDRESS not set; contract_address will be preserved or left empty")

    db = SessionLocal()
    try:
        chain_columns = _columns(db, "chains")
        asset_chain_columns = _columns(db, "asset_chains")
        if not chain_columns:
            raise RuntimeError("chains table not found")
        if not asset_chain_columns:
            raise RuntimeError("asset_chains table not found")

        chain_id_col = _chain_id_column(chain_columns)
        chain = _select_chain(db, chain_id_col)
        if chain:
            _update_chain(db, chain_columns, chain_id_col, int(chain["id"]))
            print("[action] updated existing avaxc chain")
        else:
            _insert_chain(db, chain_columns, chain_id_col)
            print("[action] inserted avaxc chain")

        usdt = _select_usdt_asset(db)
        if not usdt:
            raise RuntimeError("USDT asset not found; refusing to auto-create assets")

        chain = _select_chain(db, chain_id_col)
        if not chain:
            raise RuntimeError("avaxc chain missing after upsert")

        defaults = _load_usdt_defaults(db)
        asset_chain = _select_asset_chain(db, asset_id=int(usdt["id"]), chain_id=int(chain["id"]))
        if asset_chain:
            _update_asset_chain(
                db,
                asset_chain_columns,
                asset_chain_id=int(asset_chain["id"]),
                contract_address=contract_address,
            )
            print("[action] updated existing USDT avaxc asset_chain")
        else:
            _insert_asset_chain(
                db,
                asset_chain_columns,
                asset_id=int(usdt["id"]),
                chain_id=int(chain["id"]),
                contract_address=contract_address,
                defaults=defaults,
            )
            print("[action] inserted USDT avaxc asset_chain")

        db.commit()

        chain = _select_chain(db, chain_id_col)
        asset_chain = _select_asset_chain(db, asset_id=int(usdt["id"]), chain_id=int(chain["id"])) if chain else None
        _print_status(dict(chain) if chain else None, dict(asset_chain) if asset_chain else None)
        if not contract_address and not (asset_chain or {}).get("contract_address"):
            print("[warn] contract_address is empty; manually confirm USDT vs USDT.e and set AVAXC_USDT_CONTRACT_ADDRESS before chain testing")
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
