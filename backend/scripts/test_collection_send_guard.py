from __future__ import annotations

import os
import sys
from contextlib import contextmanager
from decimal import Decimal
from typing import Callable, Iterator

from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session, sessionmaker


BACKEND_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

from app.services import collection_send_helper as send_helper  # noqa: E402
from app.services.collection_send_guard import validate_collection_send_allowed  # noqa: E402


CHAIN_KEY = "bsc"
FROM_ADDRESS = "0x1111111111111111111111111111111111111111"
TO_ADDRESS = "0x2222222222222222222222222222222222222222"
USER_ADDRESS = "0x4444444444444444444444444444444444444444"
OTHER_ADDRESS = "0x9999999999999999999999999999999999999999"
TOKEN_CONTRACT = "0x3333333333333333333333333333333333333333"

GUARD_ENV_NAMES = {
    "COLLECTION_REAL_SEND_MASTER_SWITCH",
    "COLLECTION_ENABLE_REAL_SEND",
    "COLLECTION_ALLOWED_CHAINS",
    "COLLECTION_ALLOWED_TARGET_ADDRESSES",
    "COLLECTION_MAX_SINGLE_COLLECT_USDT",
    "COLLECTION_DAILY_COLLECT_USDT_LIMIT",
    "COLLECTION_MAX_SINGLE_GAS_NATIVE_BSC",
    "COLLECTION_DAILY_GAS_NATIVE_LIMIT_BSC",
}


def _assert(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def _replace_env(values: dict[str, str], fn: Callable[[], None]) -> None:
    original = {name: os.environ.get(name) for name in GUARD_ENV_NAMES}
    try:
        for name in GUARD_ENV_NAMES:
            os.environ.pop(name, None)
        os.environ.update(values)
        fn()
    finally:
        for name, value in original.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value


@contextmanager
def _isolated_guard_db() -> Iterator[Session]:
    engine = create_engine("sqlite:///:memory:")
    with engine.begin() as connection:
        for statement in (
            """
            CREATE TABLE chains (
                id INTEGER PRIMARY KEY,
                chain_key TEXT NOT NULL,
                enabled INTEGER NOT NULL,
                collection_address TEXT,
                hot_wallet_address TEXT,
                hot_wallet_private_key_encrypted TEXT,
                collection_real_send_enabled INTEGER NOT NULL,
                collection_max_single_gas_native NUMERIC,
                collection_daily_gas_native_limit NUMERIC
            )
            """,
            "CREATE TABLE assets (id INTEGER PRIMARY KEY, symbol TEXT NOT NULL)",
            """
            CREATE TABLE asset_chains (
                id INTEGER PRIMARY KEY,
                asset_id INTEGER NOT NULL,
                chain_id INTEGER NOT NULL,
                enabled INTEGER NOT NULL,
                collection_enabled INTEGER NOT NULL,
                contract_address TEXT,
                decimals INTEGER,
                collection_min_amount NUMERIC,
                collection_real_send_enabled INTEGER NOT NULL,
                collection_max_single_amount NUMERIC,
                collection_daily_amount_limit NUMERIC
            )
            """,
            """
            CREATE TABLE user_chain_addresses (
                id INTEGER PRIMARY KEY,
                chain_id INTEGER NOT NULL,
                address TEXT NOT NULL,
                enabled INTEGER NOT NULL
            )
            """,
            """
            CREATE TABLE collection_tasks (
                id INTEGER PRIMARY KEY,
                created_at DATETIME,
                status TEXT,
                amount NUMERIC,
                chain_key TEXT,
                coin_symbol TEXT,
                tx_hash TEXT
            )
            """,
            """
            CREATE TABLE gas_tasks (
                id INTEGER PRIMARY KEY,
                created_at DATETIME,
                status TEXT,
                topup_amount NUMERIC,
                chain_key TEXT,
                tx_hash TEXT
            )
            """,
        ):
            connection.execute(text(statement))
        connection.execute(
            text(
                """
                INSERT INTO chains (
                    id, chain_key, enabled, collection_address,
                    hot_wallet_address, hot_wallet_private_key_encrypted,
                    collection_real_send_enabled,
                    collection_max_single_gas_native,
                    collection_daily_gas_native_limit
                ) VALUES (1, :chain_key, 1, :collection_address, :hot_wallet, 'encrypted', 1, 0.1, 1)
                """
            ),
            {
                "chain_key": CHAIN_KEY,
                "collection_address": TO_ADDRESS,
                "hot_wallet": FROM_ADDRESS,
            },
        )
        connection.execute(text("INSERT INTO assets (id, symbol) VALUES (1, 'USDT')"))
        connection.execute(
            text(
                """
                INSERT INTO asset_chains (
                    id, asset_id, chain_id, enabled, collection_enabled,
                    contract_address, decimals, collection_min_amount,
                    collection_real_send_enabled, collection_max_single_amount,
                    collection_daily_amount_limit
                ) VALUES (1, 1, 1, 1, 1, :contract, 18, 0.01, 1, 100, 1000)
                """
            ),
            {"contract": TOKEN_CONTRACT},
        )
        connection.execute(
            text("INSERT INTO user_chain_addresses (id, chain_id, address, enabled) VALUES (1, 1, :address, 1)"),
            {"address": USER_ADDRESS},
        )

    factory = sessionmaker(bind=engine)
    db = factory()
    try:
        yield db
    finally:
        db.close()
        engine.dispose()


def _validate_collect(db: Session, *, amount: Decimal = Decimal("1"), to_address: str = TO_ADDRESS):
    return validate_collection_send_allowed(
        db=db,
        chain_key=CHAIN_KEY,
        to_address=to_address,
        amount=amount,
        coin_symbol="USDT",
        is_gas=False,
    )


def _validate_gas(db: Session, *, amount: Decimal = Decimal("0.01"), to_address: str = USER_ADDRESS):
    return validate_collection_send_allowed(
        db=db,
        chain_key=CHAIN_KEY,
        to_address=to_address,
        amount=amount,
        coin_symbol="NATIVE",
        is_gas=True,
    )


def _test_guard_matrix() -> None:
    with _isolated_guard_db() as db:
        def check_default() -> None:
            _assert(send_helper.is_collection_real_send_enabled() is False, "real send must be disabled by default")
            _assert(_validate_collect(db).reason == "REAL_SEND_MASTER_SWITCH_DISABLED", "default guard must fail closed")

        _replace_env({}, check_default)

        def check_master_precedence() -> None:
            _assert(send_helper.is_collection_real_send_enabled() is False, "explicit master switch must override legacy enable")
            _assert(_validate_collect(db).reason == "REAL_SEND_MASTER_SWITCH_DISABLED", "explicit master off must reject")

        _replace_env(
            {"COLLECTION_REAL_SEND_MASTER_SWITCH": "false", "COLLECTION_ENABLE_REAL_SEND": "true"},
            check_master_precedence,
        )

        def check_enabled_matrix() -> None:
            _assert(_validate_collect(db).allowed is True, "enabled chain and asset config must allow collection")
            _assert(_validate_collect(db, amount=Decimal("101")).reason == "COLLECT_SINGLE_LIMIT_EXCEEDED", "collection limit must reject")
            _assert(_validate_collect(db, to_address=OTHER_ADDRESS).reason == "TARGET_ADDRESS_NOT_ALLOWED", "target mismatch must reject")
            _assert(_validate_gas(db).allowed is True, "enabled gas config and user target must allow gas")
            _assert(_validate_gas(db, amount=Decimal("0.2")).reason == "GAS_SINGLE_LIMIT_EXCEEDED", "gas limit must reject")
            _assert(_validate_gas(db, to_address=OTHER_ADDRESS).reason == "GAS_TARGET_NOT_USER_ADDRESS", "gas target must be a user address")

            db.execute(text("UPDATE asset_chains SET collection_real_send_enabled = 0 WHERE id = 1"))
            db.commit()
            asset_disabled = _validate_collect(db)
            _assert(
                asset_disabled.reason == "ASSET_CHAIN_NOT_ALLOWED",
                f"asset real-send switch must reject, got {asset_disabled.reason}",
            )
            db.execute(text("UPDATE asset_chains SET collection_real_send_enabled = 1 WHERE id = 1"))
            db.execute(text("UPDATE chains SET collection_real_send_enabled = 0 WHERE id = 1"))
            db.commit()
            chain_disabled = _validate_collect(db)
            _assert(
                chain_disabled.reason == "CHAIN_NOT_ALLOWED",
                f"chain real-send switch must reject, got {chain_disabled.reason}",
            )

        _replace_env({"COLLECTION_REAL_SEND_MASTER_SWITCH": "true"}, check_enabled_matrix)


def _test_send_helper_guard_rejects_before_tx_actions() -> None:
    counters = {"private_key": 0, "private_key_assert": 0, "web3": 0, "sign_and_broadcast": 0}

    def private_key_provider() -> str:
        counters["private_key"] += 1
        raise AssertionError("private key provider must not run before guard approval")

    originals = {
        "assert_private_key_matches_address": send_helper.assert_private_key_matches_address,
        "get_web3_for_chain": send_helper.get_web3_for_chain,
        "_sign_and_broadcast": send_helper._sign_and_broadcast,
    }

    def forbidden_private_key_assert(*args, **kwargs):
        counters["private_key_assert"] += 1
        raise AssertionError("private key assertion must not run before guard approval")

    def forbidden_web3(*args, **kwargs):
        counters["web3"] += 1
        raise AssertionError("web3 must not run before guard approval")

    def forbidden_broadcast(*args, **kwargs):
        counters["sign_and_broadcast"] += 1
        raise AssertionError("sign/broadcast must not run before guard approval")

    def run() -> None:
        send_helper.assert_private_key_matches_address = forbidden_private_key_assert
        send_helper.get_web3_for_chain = forbidden_web3
        send_helper._sign_and_broadcast = forbidden_broadcast
        try:
            results = (
                send_helper.send_erc20_collect_transfer(
                    chain_key=CHAIN_KEY,
                    token_contract_address=TOKEN_CONTRACT,
                    token_decimals=18,
                    from_private_key=private_key_provider,
                    from_address=FROM_ADDRESS,
                    to_address=TO_ADDRESS,
                    amount=Decimal("1"),
                    coin_symbol="USDT",
                ),
                send_helper.send_native_gas_topup(
                    chain_key=CHAIN_KEY,
                    from_private_key=private_key_provider,
                    from_address=FROM_ADDRESS,
                    to_address=USER_ADDRESS,
                    amount=Decimal("0.01"),
                ),
            )
        finally:
            send_helper.assert_private_key_matches_address = originals["assert_private_key_matches_address"]
            send_helper.get_web3_for_chain = originals["get_web3_for_chain"]
            send_helper._sign_and_broadcast = originals["_sign_and_broadcast"]

        for result in results:
            _assert(result.ok is False, "missing DB-backed authorization must reject")
            _assert(result.error_message == "GUARD_REJECTED:DB_REQUIRED_FOR_REAL_SEND", "guard reason must be explicit")
            _assert(result.raw_tx_created is False, "guard rejection must not create raw tx")
            _assert(result.signed is False, "guard rejection must not sign")
            _assert(result.broadcasted is False, "guard rejection must not broadcast")

    _replace_env({"COLLECTION_REAL_SEND_MASTER_SWITCH": "true"}, run)
    _assert(counters == {key: 0 for key in counters}, "guard rejection must happen before secrets, RPC, sign, or broadcast")


def main() -> None:
    _test_guard_matrix()
    _test_send_helper_guard_rejects_before_tx_actions()
    print("collection_send_guard_test")
    print("isolated_sqlite_db=true")
    print("master_switch_fail_closed=true")
    print("db_chain_asset_guards=true")
    print("guard_reject_no_raw_tx=true")
    print("guard_reject_no_sign=true")
    print("guard_reject_no_broadcast=true")


if __name__ == "__main__":
    main()
