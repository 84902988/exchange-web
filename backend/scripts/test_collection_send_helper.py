from __future__ import annotations

import os
import sys
from decimal import Decimal


BACKEND_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

from app.services.collection_send_helper import (  # noqa: E402
    is_collection_real_send_enabled,
    send_erc20_collect_transfer,
    send_native_gas_topup,
)


FAKE_PRIVATE_KEY = "0x" + "11" * 32
FROM_ADDRESS = "0x1111111111111111111111111111111111111111"
TO_ADDRESS = "0x2222222222222222222222222222222222222222"
TOKEN_CONTRACT = "0x3333333333333333333333333333333333333333"


def _assert(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def _run_default_dry_run() -> None:
    native_result = send_native_gas_topup(
        chain_key="bsc",
        from_private_key=FAKE_PRIVATE_KEY,
        from_address=FROM_ADDRESS,
        to_address=TO_ADDRESS,
        amount=Decimal("0.001"),
    )
    erc20_result = send_erc20_collect_transfer(
        chain_key="bsc",
        token_contract_address=TOKEN_CONTRACT,
        token_decimals=18,
        from_private_key=FAKE_PRIVATE_KEY,
        from_address=FROM_ADDRESS,
        to_address=TO_ADDRESS,
        amount=Decimal("12.34"),
        coin_symbol="USDT",
    )

    _assert(native_result.dry_run is True, "native result must be dry-run")
    _assert(str(native_result.tx_hash or "").startswith("DRYGAS_"), "native tx hash must be DRYGAS_")
    _assert(native_result.raw_tx_created is False, "native dry-run must not create raw tx")
    _assert(native_result.signed is False, "native dry-run must not sign")
    _assert(native_result.broadcasted is False, "native dry-run must not broadcast")

    _assert(erc20_result.dry_run is True, "erc20 result must be dry-run")
    _assert(str(erc20_result.tx_hash or "").startswith("DRYRUN_"), "erc20 tx hash must be DRYRUN_")
    _assert(erc20_result.raw_tx_created is False, "erc20 dry-run must not create raw tx")
    _assert(erc20_result.signed is False, "erc20 dry-run must not sign")
    _assert(erc20_result.broadcasted is False, "erc20 dry-run must not broadcast")

    print("collection_send_helper_test")
    print(f"real_send_enabled={is_collection_real_send_enabled()}")
    print(f"native dry_run={native_result.dry_run} tx_hash={native_result.tx_hash}")
    print(
        "native flags "
        f"raw_tx_created={native_result.raw_tx_created} signed={native_result.signed} broadcasted={native_result.broadcasted}"
    )
    print(f"erc20 dry_run={erc20_result.dry_run} tx_hash={erc20_result.tx_hash}")
    print(
        "erc20 flags "
        f"raw_tx_created={erc20_result.raw_tx_created} signed={erc20_result.signed} broadcasted={erc20_result.broadcasted}"
    )


def _run_optional_real_send_guard() -> None:
    if os.getenv("COLLECTION_TEST_ALLOW_REAL_SEND", "").strip().lower() not in {"true", "1", "yes"}:
        print("REAL_SEND_REFUSED: set COLLECTION_TEST_ALLOW_REAL_SEND=true for optional real-send test")
        return

    required = [
        "COLLECTION_TEST_FROM_PRIVATE_KEY",
        "COLLECTION_TEST_FROM_ADDRESS",
        "COLLECTION_TEST_TO_ADDRESS",
        "COLLECTION_TEST_CHAIN_KEY",
        "COLLECTION_TEST_AMOUNT",
    ]
    missing = [name for name in required if not os.getenv(name, "").strip()]
    if missing:
        print("REAL_SEND_REFUSED: missing " + ",".join(missing))
        return

    result = send_native_gas_topup(
        chain_key=os.getenv("COLLECTION_TEST_CHAIN_KEY", ""),
        from_private_key=os.getenv("COLLECTION_TEST_FROM_PRIVATE_KEY", ""),
        from_address=os.getenv("COLLECTION_TEST_FROM_ADDRESS", ""),
        to_address=os.getenv("COLLECTION_TEST_TO_ADDRESS", ""),
        amount=Decimal(os.getenv("COLLECTION_TEST_AMOUNT", "0")),
    )
    print(f"REAL_SEND_RESULT dry_run={result.dry_run} tx_hash={result.tx_hash}")


def main() -> None:
    if is_collection_real_send_enabled():
        _run_optional_real_send_guard()
    else:
        _run_default_dry_run()


if __name__ == "__main__":
    main()
