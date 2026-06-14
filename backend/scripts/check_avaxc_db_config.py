from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

from sqlalchemy import text
from sqlalchemy.orm import Session


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.core.chain_capabilities import CONFIG_ONLY, get_chain_runtime_status, is_chain_deposit_supported, is_chain_withdraw_supported  # noqa: E402
from app.db.session import SessionLocal  # noqa: E402


CHAIN_KEY = "avaxc"
USDT_SYMBOL = "USDT"
EXPECTED_EXPLORER_TX_URL = "https://snowtrace.io/tx/{tx}"


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


def _chain_id_column(chain_columns: set[str]) -> str:
    if "chain_id" in chain_columns:
        return "chain_id"
    if "chain_value" in chain_columns:
        return "chain_value"
    return ""


def _ok(name: str, detail: str) -> None:
    print(f"[OK] {name}: {detail}")


def _warn(name: str, detail: str) -> None:
    print(f"[WARN] {name}: {detail}")


def _fail(failures: list[str], name: str, detail: str) -> None:
    failures.append(f"{name}: {detail}")
    print(f"[FAIL] {name}: {detail}")


def _select_chain(db: Session, chain_id_col: str) -> dict[str, Any] | None:
    return db.execute(
        text(
            f"""
            SELECT id, chain_key, name, {chain_id_col} AS chain_id, native_symbol,
                   confirmations, explorer_tx_url, enabled
            FROM chains
            WHERE LOWER(chain_key) = :chain_key
            LIMIT 1
            """
        ),
        {"chain_key": CHAIN_KEY},
    ).mappings().first()


def _select_usdt(db: Session) -> dict[str, Any] | None:
    return db.execute(
        text("SELECT id, symbol FROM assets WHERE UPPER(symbol) = :symbol LIMIT 1"),
        {"symbol": USDT_SYMBOL},
    ).mappings().first()


def _select_asset_chain(db: Session, *, asset_id: int, chain_id: int) -> dict[str, Any] | None:
    return db.execute(
        text(
            """
            SELECT id, asset_id, chain_id, contract_address, decimals, enabled,
                   deposit_enabled, withdraw_enabled, confirmations
            FROM asset_chains
            WHERE asset_id = :asset_id
              AND chain_id = :chain_id
            LIMIT 1
            """
        ),
        {"asset_id": asset_id, "chain_id": chain_id},
    ).mappings().first()


def main() -> int:
    failures: list[str] = []
    db = SessionLocal()
    try:
        chain_columns = _columns(db, "chains")
        chain_id_col = _chain_id_column(chain_columns)
        if not chain_id_col:
            _fail(failures, "chains_schema", "chains table has no chain_id or chain_value column")
            return 1

        chain = _select_chain(db, chain_id_col)
        if not chain:
            _fail(failures, "chain", "avaxc chain row missing")
        else:
            _ok("chain", f"id={chain['id']} name={chain.get('name')}")
            if int(chain.get("chain_id") or 0) == 43114:
                _ok("chain_id", "43114")
            else:
                _fail(failures, "chain_id", f"expected 43114, got {chain.get('chain_id')}")
            if str(chain.get("native_symbol") or "").upper() == "AVAX":
                _ok("native_symbol", "AVAX")
            else:
                _fail(failures, "native_symbol", f"expected AVAX, got {chain.get('native_symbol')}")
            if int(chain.get("confirmations") or 0) == 12:
                _ok("confirmations", "12")
            else:
                _fail(failures, "confirmations", f"expected 12, got {chain.get('confirmations')}")
            explorer_tx_url = str(chain.get("explorer_tx_url") or "").strip()
            if explorer_tx_url == EXPECTED_EXPLORER_TX_URL:
                _ok("explorer_tx_url", explorer_tx_url)
            elif explorer_tx_url:
                _warn("explorer_tx_url", f"configured but not the Step 2 target: {explorer_tx_url}")
            else:
                _fail(failures, "explorer_tx_url", "missing")

        usdt = _select_usdt(db)
        if not usdt:
            _fail(failures, "asset", "USDT asset missing")
        else:
            _ok("asset", f"USDT id={usdt['id']}")

        asset_chain = None
        if chain and usdt:
            asset_chain = _select_asset_chain(db, asset_id=int(usdt["id"]), chain_id=int(chain["id"]))
            if not asset_chain:
                _fail(failures, "asset_chain", "USDT + avaxc asset_chain missing")
            else:
                _ok("asset_chain", f"id={asset_chain['id']} enabled={asset_chain.get('enabled')}")
                contract = str(asset_chain.get("contract_address") or "").strip()
                if contract:
                    _ok("contract_address", contract)
                else:
                    _warn("contract_address", "missing; manually confirm whether to use USDT or USDT.e before testing")
                if int(asset_chain.get("decimals") or 0) == 6:
                    _ok("decimals", "6")
                else:
                    _fail(failures, "decimals", f"expected 6, got {asset_chain.get('decimals')}")
                if int(asset_chain.get("deposit_enabled") or 0) == 0:
                    _ok("deposit_enabled", "0")
                else:
                    _fail(failures, "deposit_enabled", f"expected 0, got {asset_chain.get('deposit_enabled')}")
                if int(asset_chain.get("withdraw_enabled") or 0) == 0:
                    _ok("withdraw_enabled", "0")
                else:
                    _fail(failures, "withdraw_enabled", f"expected 0, got {asset_chain.get('withdraw_enabled')}")

        runtime_status = get_chain_runtime_status(CHAIN_KEY)
        if runtime_status == CONFIG_ONLY:
            _ok("chain_capability", "CONFIG_ONLY")
        else:
            _fail(failures, "chain_capability", f"expected CONFIG_ONLY, got {runtime_status}")

        deposit_supported = is_chain_deposit_supported(CHAIN_KEY)
        withdraw_supported = is_chain_withdraw_supported(CHAIN_KEY)
        if not deposit_supported:
            _ok("deposit_options_theory", "avaxc is blocked by capability filter")
        else:
            _fail(failures, "deposit_options_theory", "avaxc deposit capability is enabled unexpectedly")
        if not withdraw_supported:
            _ok("withdraw_options_theory", "avaxc is blocked by capability filter")
        else:
            _fail(failures, "withdraw_options_theory", "avaxc withdraw capability is enabled unexpectedly")

        if asset_chain:
            if int(asset_chain.get("deposit_enabled") or 0) == 0 and not deposit_supported:
                _ok("deposit_options", "DB switch is off and capability is CONFIG_ONLY; /asset/deposit/options will not expose avaxc")
            if int(asset_chain.get("withdraw_enabled") or 0) == 0 and not withdraw_supported:
                _ok("withdraw_options", "DB switch is off and capability is CONFIG_ONLY; /asset/withdraw/options will not expose avaxc")

        if failures:
            print("[summary] FAILED")
            return 1
        print("[summary] OK")
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())
