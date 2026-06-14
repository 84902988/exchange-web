from __future__ import annotations

import os
from dataclasses import dataclass
from datetime import datetime, time
from decimal import Decimal

from sqlalchemy import inspect
from sqlalchemy import text


REAL_SEND_CONFIRM_TEXT = "I_UNDERSTAND_COLLECTION_REAL_SEND"
MASTER_SWITCH_ENV = "COLLECTION_REAL_SEND_MASTER_SWITCH"
LEGACY_REAL_SEND_ENV = "COLLECTION_ENABLE_REAL_SEND"

DEFAULT_GAS_SINGLE_LIMIT_BY_CHAIN = {
    "avaxc": Decimal("0.2"),
    "ethereum": Decimal("0.02"),
    "optimism": Decimal("0.005"),
    "solana": Decimal("0.1"),
}

DEFAULT_GAS_DAILY_LIMIT_BY_CHAIN = {
    "avaxc": Decimal("1"),
    "ethereum": Decimal("0.1"),
    "optimism": Decimal("0.05"),
    "solana": Decimal("1"),
}


@dataclass(frozen=True)
class CollectionSendGuardResult:
    allowed: bool
    reason: str
    chain_key: str
    to_address: str
    amount: Decimal
    coin_symbol: str
    is_gas: bool


def _env_enabled(name: str) -> bool:
    return os.getenv(name, "").strip().lower() in {"true", "1", "yes"}


def _env_has_value(name: str) -> bool:
    return os.getenv(name, "").strip() != ""


def is_collection_real_send_master_enabled() -> bool:
    if _env_has_value(MASTER_SWITCH_ENV):
        return _env_enabled(MASTER_SWITCH_ENV)
    # Legacy fallback only: old deployments used COLLECTION_ENABLE_REAL_SEND.
    return _env_enabled(LEGACY_REAL_SEND_ENV)


def _env_decimal(name: str, default: Decimal | None = None) -> Decimal | None:
    raw = os.getenv(name, "").strip()
    if not raw:
        return default
    try:
        return Decimal(raw)
    except Exception as exc:
        raise ValueError(f"invalid decimal env {name}") from exc


def _split_env_set(name: str, *, lower: bool = True) -> set[str]:
    values = set()
    for part in os.getenv(name, "").split(","):
        item = part.strip()
        if not item:
            continue
        values.add(item.lower() if lower else item)
    return values


def _db_has_column(db, table_name: str, column_name: str) -> bool:
    try:
        return any(column.get("name") == column_name for column in inspect(db.get_bind()).get_columns(table_name))
    except Exception:
        return False


def _optional_column_sql(db, table_alias: str, table_name: str, column_name: str, alias: str) -> str:
    if db is not None and _db_has_column(db, table_name, column_name):
        return f"{table_alias}.{column_name} AS {alias}"
    return f"NULL AS {alias}"


def _reject(*, reason: str, chain_key: str, to_address: str, amount: Decimal, coin_symbol: str, is_gas: bool):
    return CollectionSendGuardResult(
        allowed=False,
        reason=reason,
        chain_key=chain_key,
        to_address=to_address,
        amount=amount,
        coin_symbol=coin_symbol,
        is_gas=is_gas,
    )


def _allow(*, chain_key: str, to_address: str, amount: Decimal, coin_symbol: str, is_gas: bool):
    return CollectionSendGuardResult(
        allowed=True,
        reason="ALLOWED",
        chain_key=chain_key,
        to_address=to_address,
        amount=amount,
        coin_symbol=coin_symbol,
        is_gas=is_gas,
    )


def _today_start() -> datetime:
    return datetime.combine(datetime.utcnow().date(), time.min)


def _daily_collection_sent_amount(db, *, coin_symbol: str) -> Decimal:
    row = db.execute(
        text(
            """
            SELECT COALESCE(SUM(amount), 0) AS total
            FROM collection_tasks
            WHERE created_at >= :start_at
              AND status IN ('SENT', 'CONFIRMED')
              AND UPPER(coin_symbol) = :coin_symbol
              AND tx_hash IS NOT NULL
              AND tx_hash NOT LIKE 'DRYRUN_%'
            """
        ),
        {"start_at": _today_start(), "coin_symbol": coin_symbol.upper()},
    ).mappings().first()
    return Decimal(str((row or {}).get("total") or 0))


def _daily_collection_sent_amount_for_chain(db, *, chain_key: str, coin_symbol: str) -> Decimal:
    row = db.execute(
        text(
            """
            SELECT COALESCE(SUM(amount), 0) AS total
            FROM collection_tasks
            WHERE created_at >= :start_at
              AND status IN ('SENT', 'CONFIRMED')
              AND LOWER(chain_key) = :chain_key
              AND UPPER(coin_symbol) = :coin_symbol
              AND tx_hash IS NOT NULL
              AND tx_hash NOT LIKE 'DRYRUN_%'
            """
        ),
        {"start_at": _today_start(), "chain_key": chain_key.lower(), "coin_symbol": coin_symbol.upper()},
    ).mappings().first()
    return Decimal(str((row or {}).get("total") or 0))


def _daily_gas_sent_amount(db, *, chain_key: str) -> Decimal:
    row = db.execute(
        text(
            """
            SELECT COALESCE(SUM(topup_amount), 0) AS total
            FROM gas_tasks
            WHERE created_at >= :start_at
              AND status IN ('SENT', 'CONFIRMED')
              AND LOWER(chain_key) = :chain_key
              AND tx_hash IS NOT NULL
              AND tx_hash NOT LIKE 'DRYGAS_%'
            """
        ),
        {"start_at": _today_start(), "chain_key": chain_key.lower()},
    ).mappings().first()
    return Decimal(str((row or {}).get("total") or 0))


def _decimal_or_none(value) -> Decimal | None:
    if value is None or str(value).strip() == "":
        return None
    return Decimal(str(value))


def _enabled01(value) -> bool:
    try:
        return int(value or 0) == 1
    except Exception:
        return False


def _load_chain_send_config(db, chain_key: str) -> dict[str, object] | None:
    row = db.execute(
        text(
            f"""
            SELECT c.id,
                   c.chain_key,
                   c.enabled,
                   c.collection_address,
                   c.hot_wallet_address,
                   c.hot_wallet_private_key_encrypted,
                   { _optional_column_sql(db, "c", "chains", "collection_real_send_enabled", "collection_real_send_enabled") },
                   { _optional_column_sql(db, "c", "chains", "collection_max_single_gas_native", "collection_max_single_gas_native") },
                   { _optional_column_sql(db, "c", "chains", "collection_daily_gas_native_limit", "collection_daily_gas_native_limit") }
            FROM chains c
            WHERE LOWER(c.chain_key) = :chain_key
            LIMIT 1
            """
        ),
        {"chain_key": chain_key.lower()},
    ).mappings().first()
    return dict(row) if row else None


def _load_asset_send_config(db, chain_key: str, coin_symbol: str) -> dict[str, object] | None:
    row = db.execute(
        text(
            f"""
            SELECT ac.id,
                   ac.enabled,
                   { _optional_column_sql(db, "ac", "asset_chains", "collection_enabled", "collection_enabled") },
                   ac.contract_address,
                   ac.decimals,
                   ac.collection_min_amount,
                   { _optional_column_sql(db, "ac", "asset_chains", "collection_real_send_enabled", "asset_collection_real_send_enabled") },
                   { _optional_column_sql(db, "ac", "asset_chains", "collection_max_single_amount", "collection_max_single_amount") },
                   { _optional_column_sql(db, "ac", "asset_chains", "collection_daily_amount_limit", "collection_daily_amount_limit") }
            FROM asset_chains ac
            JOIN assets a ON a.id = ac.asset_id
            JOIN chains c ON c.id = ac.chain_id
            WHERE LOWER(c.chain_key) = :chain_key
              AND UPPER(a.symbol) = :coin_symbol
            LIMIT 1
            """
        ),
        {"chain_key": chain_key.lower(), "coin_symbol": coin_symbol.upper()},
    ).mappings().first()
    return dict(row) if row else None


def _chain_real_send_allowed(db, chain_row: dict[str, object] | None, chain_key: str) -> bool:
    if not chain_row or not _enabled01(chain_row.get("enabled")):
        return False
    if _db_has_column(db, "chains", "collection_real_send_enabled"):
        return _enabled01(chain_row.get("collection_real_send_enabled"))
    # Legacy fallback only: if old allowlist exists, honor it; otherwise use enabled chain config.
    allowed_chains = _split_env_set("COLLECTION_ALLOWED_CHAINS")
    return not allowed_chains or chain_key.lower() in allowed_chains


def _asset_real_send_allowed(db, asset_row: dict[str, object] | None) -> bool:
    if not asset_row or not _enabled01(asset_row.get("enabled")):
        return False
    if _db_has_column(db, "asset_chains", "collection_enabled") and not _enabled01(asset_row.get("collection_enabled")):
        return False
    if _db_has_column(db, "asset_chains", "collection_real_send_enabled"):
        return _enabled01(asset_row.get("asset_collection_real_send_enabled"))
    return False


def _expected_collection_address(db, chain_row: dict[str, object] | None) -> str:
    address = str((chain_row or {}).get("collection_address") or "").strip().lower()
    if address:
        return address
    # Legacy fallback only: old deployments kept target allowlist in env.
    allowed_targets = _split_env_set("COLLECTION_ALLOWED_TARGET_ADDRESSES")
    return next(iter(allowed_targets), "")


def _gas_target_user_address_allowed(db, chain_key: str, to_address: str) -> bool:
    if not chain_key or not to_address:
        return False
    enabled_clause = "AND uca.enabled = 1" if _db_has_column(db, "user_chain_addresses", "enabled") else ""
    row = db.execute(
        text(
            f"""
            SELECT uca.id
            FROM user_chain_addresses uca
            JOIN chains c ON c.id = uca.chain_id
            WHERE LOWER(c.chain_key) = :chain_key
              AND LOWER(uca.address) = :to_address
              {enabled_clause}
            LIMIT 1
            """
        ),
        {"chain_key": chain_key.lower(), "to_address": to_address.lower()},
    ).mappings().first()
    return row is not None


def _collection_single_limit(db, asset_row: dict[str, object] | None, symbol: str) -> Decimal | None:
    if _db_has_column(db, "asset_chains", "collection_max_single_amount"):
        return _decimal_or_none((asset_row or {}).get("collection_max_single_amount"))
    # Legacy fallback only.
    return _env_decimal(f"COLLECTION_MAX_SINGLE_COLLECT_{symbol.upper()}") or _env_decimal("COLLECTION_MAX_SINGLE_COLLECT_USDT")


def _collection_daily_limit(db, asset_row: dict[str, object] | None, symbol: str) -> Decimal | None:
    if _db_has_column(db, "asset_chains", "collection_daily_amount_limit"):
        return _decimal_or_none((asset_row or {}).get("collection_daily_amount_limit"))
    # Legacy fallback only.
    return _env_decimal(f"COLLECTION_DAILY_COLLECT_{symbol.upper()}_LIMIT") or _env_decimal("COLLECTION_DAILY_COLLECT_USDT_LIMIT")


def _gas_single_limit(db, chain_row: dict[str, object] | None, chain_key: str) -> Decimal | None:
    if _db_has_column(db, "chains", "collection_max_single_gas_native"):
        return _decimal_or_none((chain_row or {}).get("collection_max_single_gas_native"))
    # Legacy fallback only.
    return _env_decimal(f"COLLECTION_MAX_SINGLE_GAS_NATIVE_{chain_key.upper()}", DEFAULT_GAS_SINGLE_LIMIT_BY_CHAIN.get(chain_key))


def _gas_daily_limit(db, chain_row: dict[str, object] | None, chain_key: str) -> Decimal | None:
    if _db_has_column(db, "chains", "collection_daily_gas_native_limit"):
        return _decimal_or_none((chain_row or {}).get("collection_daily_gas_native_limit"))
    # Legacy fallback only.
    return _env_decimal(f"COLLECTION_DAILY_GAS_NATIVE_LIMIT_{chain_key.upper()}", DEFAULT_GAS_DAILY_LIMIT_BY_CHAIN.get(chain_key))


def _positive_limit(value: Decimal | None) -> Decimal | None:
    if value is None or value <= 0:
        return None
    return value


def validate_collection_send_allowed(
    *,
    db,
    chain_key: str,
    to_address: str,
    amount: Decimal,
    coin_symbol: str,
    is_gas: bool,
) -> CollectionSendGuardResult:
    ck = (chain_key or "").strip().lower()
    to_addr = (to_address or "").strip().lower()
    symbol = (coin_symbol or "").strip().upper()
    send_amount = Decimal(str(amount))

    if not is_collection_real_send_master_enabled():
        return _reject(reason="REAL_SEND_MASTER_SWITCH_DISABLED", chain_key=ck, to_address=to_addr, amount=send_amount, coin_symbol=symbol, is_gas=is_gas)

    if send_amount <= 0:
        return _reject(reason="AMOUNT_NOT_POSITIVE", chain_key=ck, to_address=to_addr, amount=send_amount, coin_symbol=symbol, is_gas=is_gas)

    if db is None:
        return _reject(reason="DB_REQUIRED_FOR_REAL_SEND", chain_key=ck, to_address=to_addr, amount=send_amount, coin_symbol=symbol, is_gas=is_gas)

    chain_row = _load_chain_send_config(db, ck)
    if not _chain_real_send_allowed(db, chain_row, ck):
        return _reject(reason="CHAIN_NOT_ALLOWED", chain_key=ck, to_address=to_addr, amount=send_amount, coin_symbol=symbol, is_gas=is_gas)

    if is_gas:
        if not _gas_target_user_address_allowed(db, ck, to_addr):
            return _reject(reason="GAS_TARGET_NOT_USER_ADDRESS", chain_key=ck, to_address=to_addr, amount=send_amount, coin_symbol=symbol, is_gas=True)
        if not str((chain_row or {}).get("hot_wallet_address") or "").strip():
            return _reject(reason="HOT_WALLET_ADDRESS_NOT_CONFIGURED", chain_key=ck, to_address=to_addr, amount=send_amount, coin_symbol=symbol, is_gas=True)
        if not str((chain_row or {}).get("hot_wallet_private_key_encrypted") or "").strip():
            return _reject(reason="HOT_WALLET_PRIVATE_KEY_NOT_CONFIGURED", chain_key=ck, to_address=to_addr, amount=send_amount, coin_symbol=symbol, is_gas=True)
        single_limit = _gas_single_limit(db, chain_row, ck)
        daily_limit = _gas_daily_limit(db, chain_row, ck)
        effective_single_limit = _positive_limit(single_limit)
        effective_daily_limit = _positive_limit(daily_limit)
        if effective_single_limit is not None and send_amount > effective_single_limit:
            return _reject(reason="GAS_SINGLE_LIMIT_EXCEEDED", chain_key=ck, to_address=to_addr, amount=send_amount, coin_symbol=symbol, is_gas=True)
        if effective_daily_limit is not None and _daily_gas_sent_amount(db, chain_key=ck) + send_amount > effective_daily_limit:
            return _reject(reason="GAS_DAILY_LIMIT_EXCEEDED", chain_key=ck, to_address=to_addr, amount=send_amount, coin_symbol=symbol, is_gas=True)
        return _allow(chain_key=ck, to_address=to_addr, amount=send_amount, coin_symbol=symbol, is_gas=True)

    asset_row = _load_asset_send_config(db, ck, symbol)
    if asset_row is None:
        return _reject(reason="ASSET_CHAIN_NOT_CONFIGURED", chain_key=ck, to_address=to_addr, amount=send_amount, coin_symbol=symbol, is_gas=False)
    if not _asset_real_send_allowed(db, asset_row):
        return _reject(reason="ASSET_CHAIN_NOT_ALLOWED", chain_key=ck, to_address=to_addr, amount=send_amount, coin_symbol=symbol, is_gas=False)

    expected_target = _expected_collection_address(db, chain_row)
    if not expected_target:
        return _reject(reason="COLLECTION_ADDRESS_NOT_CONFIGURED", chain_key=ck, to_address=to_addr, amount=send_amount, coin_symbol=symbol, is_gas=False)
    if to_addr != expected_target:
        return _reject(reason="TARGET_ADDRESS_NOT_ALLOWED", chain_key=ck, to_address=to_addr, amount=send_amount, coin_symbol=symbol, is_gas=False)

    if not str(asset_row.get("contract_address") or "").strip():
        return _reject(reason="TOKEN_CONTRACT_NOT_CONFIGURED", chain_key=ck, to_address=to_addr, amount=send_amount, coin_symbol=symbol, is_gas=False)

    single_limit = _collection_single_limit(db, asset_row, symbol)
    daily_limit = _collection_daily_limit(db, asset_row, symbol)
    if single_limit is not None and send_amount > single_limit:
        return _reject(reason="COLLECT_SINGLE_LIMIT_EXCEEDED", chain_key=ck, to_address=to_addr, amount=send_amount, coin_symbol=symbol, is_gas=False)
    if daily_limit is not None and _daily_collection_sent_amount_for_chain(db, chain_key=ck, coin_symbol=symbol) + send_amount > daily_limit:
        return _reject(reason="COLLECT_DAILY_LIMIT_EXCEEDED", chain_key=ck, to_address=to_addr, amount=send_amount, coin_symbol=symbol, is_gas=False)

    return _allow(chain_key=ck, to_address=to_addr, amount=send_amount, coin_symbol=symbol, is_gas=False)
