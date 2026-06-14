from __future__ import annotations

import os
import sys

from sqlalchemy import create_engine, text


BACKEND_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

from app.core.config import settings  # noqa: E402
from app.services.collection_balance_checker import (  # noqa: E402
    CollectionBalanceCheckerError,
    get_collection_onchain_balances,
)


def _mask(value: str) -> str:
    text = str(value or "").strip()
    if len(text) <= 10:
        return text or "-"
    return f"{text[:6]}...{text[-4:]}"


def _load_one_candidate(conn):
    columns = conn.execute(
        text(
            """
            SELECT COLUMN_NAME
            FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME = 'user_chain_addresses'
            """
        )
    ).mappings().all()
    column_names = {str(row["COLUMN_NAME"]) for row in columns}
    has_chain_key = "chain_key" in column_names
    has_chain_id = "chain_id" in column_names
    if not has_chain_key and not has_chain_id:
        raise RuntimeError("user_chain_addresses must contain chain_key or chain_id")

    chain_key_expr = "uca.chain_key" if has_chain_key else "NULL"
    join_chain_sql = "LEFT JOIN chains c ON c.id = uca.chain_id" if has_chain_id else "LEFT JOIN chains c ON c.chain_key = uca.chain_key"
    active_filter = ""
    if "is_active" in column_names:
        active_filter = "AND COALESCE(uca.is_active, 0) = 1"
    elif "enabled" in column_names:
        active_filter = "AND COALESCE(uca.enabled, 0) = 1"

    sql = f"""
        SELECT
          LOWER(uca.address) AS address,
          COALESCE(NULLIF(LOWER(TRIM({chain_key_expr})), ''), LOWER(TRIM(c.chain_key))) AS chain_key,
          a.symbol AS coin_symbol,
          ac.contract_address AS token_contract_address,
          ac.decimals AS token_decimals
        FROM user_chain_addresses uca
        {join_chain_sql}
        JOIN asset_chains ac ON ac.chain_id = c.id
        JOIN assets a ON a.id = ac.asset_id
        WHERE c.enabled = 1
          AND a.enabled = 1
          AND ac.enabled = 1
          AND ac.deposit_enabled = 1
          AND UPPER(a.symbol) = 'USDT'
          AND ac.contract_address IS NOT NULL
          AND ac.contract_address <> ''
          {active_filter}
        ORDER BY uca.id ASC, ac.id ASC
        LIMIT 1
    """
    return conn.execute(text(sql)).mappings().first()


def main() -> None:
    engine = create_engine(settings.database_url, pool_pre_ping=True, pool_recycle=3600)
    with engine.connect() as conn:
        row = _load_one_candidate(conn)

    print("collection_balance_checker_test")
    if not row:
        print("NO_CANDIDATE")
        return

    try:
        result = get_collection_onchain_balances(
            chain_key=row["chain_key"],
            address=row["address"],
            token_contract_address=row["token_contract_address"],
            token_decimals=int(row["token_decimals"] or 18),
        )
    except CollectionBalanceCheckerError as exc:
        print(exc.code)
        return

    if not result.ok:
        message = result.error_message or "UNKNOWN_ERROR"
        if "RPC_NOT_CONFIGURED" in message:
            print("RPC_NOT_CONFIGURED")
        elif "RPC_NOT_CONNECTED" in message:
            print("RPC_NOT_CONNECTED")
        else:
            print(f"ONCHAIN_BALANCE_CHECK_FAILED: {message[:120]}")
        return

    print(f"chain_key={result.chain_key}")
    print(f"address={_mask(result.address)}")
    print(f"token_balance={result.token_balance}")
    print(f"native_balance={result.native_balance}")
    print(f"checked_at={result.checked_at.isoformat()}")


if __name__ == "__main__":
    main()
