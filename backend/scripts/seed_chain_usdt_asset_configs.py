from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

from sqlalchemy import text
from sqlalchemy.orm import Session


BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.db.session import SessionLocal  # noqa: E402


CHAIN_SEEDS: list[dict[str, Any]] = [
    {
        "chain_key": "optimism",
        "name": "Optimism",
        "chain_type": "EVM",
        "chain_id": 10,
        "native_symbol": "ETH",
        "confirmations": 12,
        "explorer_tx_url": "https://optimistic.etherscan.io/tx/{tx}",
        "enabled": 1,
        "usdt_contract_address": "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58",
        "usdt_decimals": 6,
        "usdt_deposit_enabled": 1,
        "usdt_withdraw_enabled": 0,
    },
    {
        "chain_key": "ethereum",
        "name": "Ethereum",
        "chain_type": "EVM",
        "chain_id": 1,
        "native_symbol": "ETH",
        "confirmations": 12,
        "explorer_tx_url": "https://etherscan.io/tx/{tx}",
        "enabled": 1,
        "usdt_contract_address": "0xdAC17F958D2ee523a2206206994597C13D831ec7",
        "usdt_decimals": 6,
        "usdt_deposit_enabled": 1,
        "usdt_withdraw_enabled": 0,
    },
    {
        "chain_key": "avaxc",
        "name": "Avalanche C-Chain",
        "chain_type": "EVM",
        "chain_id": 43114,
        "native_symbol": "AVAX",
        "confirmations": 12,
        "explorer_tx_url": "https://snowtrace.io",
        "enabled": 1,
    },
    {
        "chain_key": "polygon",
        "name": "Polygon",
        "chain_type": "EVM",
        "chain_id": 137,
        "native_symbol": "POL",
        "confirmations": 12,
        "explorer_tx_url": "https://polygonscan.com",
        "enabled": 1,
    },
    {
        "chain_key": "bsc",
        "name": "BSC",
        "chain_type": "EVM",
        "chain_id": 56,
        "native_symbol": "BNB",
        "confirmations": 12,
        "explorer_tx_url": "https://bscscan.com",
        "enabled": 1,
    },
]


def _columns(db: Session, table_name: str) -> set[str]:
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
    return {str(row["COLUMN_NAME"]) for row in rows}


def _fill_missing_chain_explorer(db: Session, item: dict[str, Any]) -> bool:
    result = db.execute(
        text(
            """
            UPDATE chains
            SET explorer_tx_url = :explorer_tx_url,
                updated_at = UTC_TIMESTAMP(3)
            WHERE chain_key = :chain_key
              AND (explorer_tx_url IS NULL OR TRIM(explorer_tx_url) = '')
            """
        ),
        {"chain_key": item["chain_key"], "explorer_tx_url": item["explorer_tx_url"]},
    )
    return int(result.rowcount or 0) > 0


def _is_managed_deposit_only_chain(item: dict[str, Any]) -> bool:
    return item.get("chain_key") in {"optimism", "ethereum"}


def _update_managed_deposit_only_chain(db: Session, item: dict[str, Any], chain_columns: set[str]) -> bool:
    if not _is_managed_deposit_only_chain(item):
        return False
    assignments = [
        "name = :name",
        "chain_id = :chain_id",
        "native_symbol = :native_symbol",
        "confirmations = :confirmations",
        "explorer_tx_url = :explorer_tx_url",
        "enabled = :enabled",
    ]
    params = {
        "chain_key": item["chain_key"],
        "name": item["name"],
        "chain_id": item["chain_id"],
        "native_symbol": item["native_symbol"],
        "confirmations": item["confirmations"],
        "explorer_tx_url": item["explorer_tx_url"],
        "enabled": item["enabled"],
    }
    if "chain_type" in chain_columns:
        assignments.append("chain_type = :chain_type")
        params["chain_type"] = item["chain_type"]
    result = db.execute(
        text(
            f"""
            UPDATE chains
            SET {", ".join(assignments)},
                updated_at = UTC_TIMESTAMP(3)
            WHERE chain_key = :chain_key
            """
        ),
        params,
    )
    return int(result.rowcount or 0) > 0


def _insert_chain(db: Session, item: dict[str, Any], chain_columns: set[str]) -> bool:
    existing = db.execute(
        text("SELECT id FROM chains WHERE chain_key = :chain_key LIMIT 1"),
        {"chain_key": item["chain_key"]},
    ).mappings().first()
    if existing:
        return False

    insert_columns = [
        "chain_key",
        "name",
        "chain_id",
        "native_symbol",
        "explorer_tx_url",
        "confirmations",
        "enabled",
        "collection_address",
        "hot_wallet_address",
        "created_at",
        "updated_at",
    ]
    values = [
        ":chain_key",
        ":name",
        ":chain_id",
        ":native_symbol",
        ":explorer_tx_url",
        ":confirmations",
        ":enabled",
        "NULL",
        "NULL",
        "UTC_TIMESTAMP(3)",
        "UTC_TIMESTAMP(3)",
    ]
    params = {
        "chain_key": item["chain_key"],
        "name": item["name"],
        "chain_id": item["chain_id"],
        "native_symbol": item["native_symbol"],
        "explorer_tx_url": item["explorer_tx_url"],
        "confirmations": item["confirmations"],
        "enabled": item["enabled"],
    }

    if "chain_type" in chain_columns:
        insert_columns.insert(2, "chain_type")
        values.insert(2, ":chain_type")
        params["chain_type"] = item["chain_type"]

    db.execute(
        text(
            f"""
            INSERT INTO chains ({", ".join(insert_columns)})
            VALUES ({", ".join(values)})
            """
        ),
        params,
    )
    return True


def _insert_usdt_asset_chain(db: Session, *, usdt_asset_id: int, chain_id: int, item: dict[str, Any]) -> bool:
    existing = db.execute(
        text(
            """
            SELECT id
            FROM asset_chains
            WHERE asset_id = :asset_id
              AND chain_id = :chain_id
            LIMIT 1
            """
        ),
        {"asset_id": usdt_asset_id, "chain_id": chain_id},
    ).mappings().first()
    if existing:
        return False

    db.execute(
        text(
            """
            INSERT INTO asset_chains
              (asset_id, chain_id, contract_address, decimals, deposit_enabled, withdraw_enabled,
               enabled, min_deposit, min_withdraw, confirmations, sort, created_at, updated_at)
            VALUES
              (:asset_id, :chain_id, :contract_address, :decimals, :deposit_enabled, :withdraw_enabled,
               1, 0, 0, :confirmations, 100, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))
            """
        ),
        {
            "asset_id": usdt_asset_id,
            "chain_id": chain_id,
            "contract_address": item.get("usdt_contract_address"),
            "decimals": int(item.get("usdt_decimals") or 6),
            "deposit_enabled": int(item.get("usdt_deposit_enabled") or 0),
            "withdraw_enabled": int(item.get("usdt_withdraw_enabled") or 0),
            "confirmations": item.get("confirmations") if _is_managed_deposit_only_chain(item) else None,
        },
    )
    return True


def _update_managed_deposit_only_usdt_asset_chain(db: Session, *, usdt_asset_id: int, chain_id: int, item: dict[str, Any]) -> bool:
    if not _is_managed_deposit_only_chain(item):
        return False
    result = db.execute(
        text(
            """
            UPDATE asset_chains
            SET contract_address = :contract_address,
                decimals = :decimals,
                deposit_enabled = :deposit_enabled,
                withdraw_enabled = 0,
                enabled = 1,
                confirmations = :confirmations,
                updated_at = UTC_TIMESTAMP(3)
            WHERE asset_id = :asset_id
              AND chain_id = :chain_id
            """
        ),
        {
            "asset_id": usdt_asset_id,
            "chain_id": chain_id,
            "contract_address": item["usdt_contract_address"],
            "decimals": int(item.get("usdt_decimals") or 6),
            "deposit_enabled": int(item.get("usdt_deposit_enabled") or 0),
            "confirmations": item["confirmations"],
        },
    )
    return int(result.rowcount or 0) > 0


def seed_chain_usdt_asset_configs() -> dict[str, int]:
    db = SessionLocal()
    inserted_chains = 0
    skipped_chains = 0
    updated_chain_explorers = 0
    updated_managed_chains = 0
    inserted_asset_chains = 0
    skipped_asset_chains = 0
    updated_managed_asset_chains = 0

    try:
        chain_columns = _columns(db, "chains")
        usdt = db.execute(
            text("SELECT id FROM assets WHERE symbol = 'USDT' LIMIT 1")
        ).mappings().first()
        if not usdt:
            raise RuntimeError("USDT asset not found")
        usdt_asset_id = int(usdt["id"])

        for item in CHAIN_SEEDS:
            if _insert_chain(db, item, chain_columns):
                inserted_chains += 1
            else:
                skipped_chains += 1
                if _update_managed_deposit_only_chain(db, item, chain_columns):
                    updated_managed_chains += 1
                elif _fill_missing_chain_explorer(db, item):
                    updated_chain_explorers += 1

            chain = db.execute(
                text("SELECT id FROM chains WHERE chain_key = :chain_key LIMIT 1"),
                {"chain_key": item["chain_key"]},
            ).mappings().one()
            if _insert_usdt_asset_chain(db, usdt_asset_id=usdt_asset_id, chain_id=int(chain["id"]), item=item):
                inserted_asset_chains += 1
            else:
                skipped_asset_chains += 1
                if _update_managed_deposit_only_usdt_asset_chain(db, usdt_asset_id=usdt_asset_id, chain_id=int(chain["id"]), item=item):
                    updated_managed_asset_chains += 1

        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()

    result = {
        "inserted_chains": inserted_chains,
        "skipped_chains": skipped_chains,
        "updated_chain_explorers": updated_chain_explorers,
        "updated_managed_chains": updated_managed_chains,
        "inserted_asset_chains": inserted_asset_chains,
        "skipped_asset_chains": skipped_asset_chains,
        "updated_managed_asset_chains": updated_managed_asset_chains,
    }
    print(
        "Seeded chain USDT asset configs: "
        f"chains inserted={inserted_chains}, chains skipped={skipped_chains}, "
        f"chain explorers updated={updated_chain_explorers}, "
        f"managed deposit-only chains updated={updated_managed_chains}, "
        f"asset_chains inserted={inserted_asset_chains}, asset_chains skipped={skipped_asset_chains}"
        f", managed deposit-only asset_chains updated={updated_managed_asset_chains}"
    )
    return result


if __name__ == "__main__":
    seed_chain_usdt_asset_configs()
