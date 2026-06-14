from __future__ import annotations

import os
import sys
from decimal import Decimal
from typing import Callable


BACKEND_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

from app.services import collection_send_helper as send_helper  # noqa: E402
from app.services.collection_send_guard import REAL_SEND_CONFIRM_TEXT, validate_collection_send_allowed  # noqa: E402


CHAIN_KEY = "bsc"
FROM_ADDRESS = "0x1111111111111111111111111111111111111111"
TO_ADDRESS = "0x2222222222222222222222222222222222222222"
OTHER_ADDRESS = "0x9999999999999999999999999999999999999999"
TOKEN_CONTRACT = "0x3333333333333333333333333333333333333333"

GUARD_ENV_NAMES = {
    "COLLECTION_ENABLE_REAL_SEND",
    "COLLECTION_REAL_SEND_CONFIRM",
    "COLLECTION_ALLOWED_CHAINS",
    "COLLECTION_ALLOWED_TARGET_ADDRESSES",
    "COLLECTION_MAX_SINGLE_COLLECT_USDT",
    "COLLECTION_DAILY_COLLECT_USDT_LIMIT",
    "COLLECTION_MAX_SINGLE_GAS_NATIVE_BSC",
    "COLLECTION_DAILY_GAS_NATIVE_LIMIT_BSC",
}


class _FakeResult:
    def __init__(self, total: Decimal) -> None:
        self.total = total

    def mappings(self) -> "_FakeResult":
        return self

    def first(self) -> dict[str, str]:
        return {"total": str(self.total)}


class _FakeDB:
    def __init__(self, total: Decimal = Decimal("0")) -> None:
        self.total = total
        self.execute_calls = 0

    def execute(self, *args, **kwargs) -> _FakeResult:
        self.execute_calls += 1
        return _FakeResult(self.total)


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


def _base_real_send_env() -> dict[str, str]:
    return {
        "COLLECTION_ENABLE_REAL_SEND": "true",
        "COLLECTION_REAL_SEND_CONFIRM": REAL_SEND_CONFIRM_TEXT,
        "COLLECTION_ALLOWED_CHAINS": CHAIN_KEY,
        "COLLECTION_ALLOWED_TARGET_ADDRESSES": TO_ADDRESS,
        "COLLECTION_MAX_SINGLE_COLLECT_USDT": "100",
        "COLLECTION_DAILY_COLLECT_USDT_LIMIT": "1000",
        "COLLECTION_MAX_SINGLE_GAS_NATIVE_BSC": "0.1",
        "COLLECTION_DAILY_GAS_NATIVE_LIMIT_BSC": "1",
    }


def _validate_collect(
    *,
    env: dict[str, str],
    amount: Decimal = Decimal("1"),
    to_address: str = TO_ADDRESS,
    db=None,
):
    result = None

    def run() -> None:
        nonlocal result
        result = validate_collection_send_allowed(
            db=db,
            chain_key=CHAIN_KEY,
            to_address=to_address,
            amount=amount,
            coin_symbol="USDT",
            is_gas=False,
        )

    _replace_env(env, run)
    return result


def _validate_gas(*, env: dict[str, str], amount: Decimal = Decimal("0.01"), db=None):
    result = None

    def run() -> None:
        nonlocal result
        result = validate_collection_send_allowed(
            db=db,
            chain_key=CHAIN_KEY,
            to_address=TO_ADDRESS,
            amount=amount,
            coin_symbol="NATIVE",
            is_gas=True,
        )

    _replace_env(env, run)
    return result


def _test_guard_matrix() -> None:
    default_enabled = None

    def check_default_flag() -> None:
        nonlocal default_enabled
        default_enabled = send_helper.is_collection_real_send_enabled()

    _replace_env({}, check_default_flag)
    result = _validate_collect(env={})
    _assert(result.allowed is False, "default config must reject real send")
    _assert(default_enabled is False, "real send must be disabled by default")

    result = _validate_collect(env={"COLLECTION_ENABLE_REAL_SEND": "true"})
    _assert(result.allowed is False, "missing confirm must reject real send")

    env = _base_real_send_env()
    env["COLLECTION_REAL_SEND_CONFIRM"] = "WRONG"
    result = _validate_collect(env=env)
    _assert(result.allowed is False, "wrong confirm must reject real send")

    env = _base_real_send_env()
    env["COLLECTION_ALLOWED_CHAINS"] = "eth"
    result = _validate_collect(env=env)
    _assert(result.allowed is False, "chain outside allowlist must reject real send")

    env = _base_real_send_env()
    env["COLLECTION_ALLOWED_TARGET_ADDRESSES"] = OTHER_ADDRESS
    result = _validate_collect(env=env, to_address=TO_ADDRESS)
    _assert(result.allowed is False, "target outside allowlist must reject real send")

    env = _base_real_send_env()
    env["COLLECTION_MAX_SINGLE_COLLECT_USDT"] = "10"
    result = _validate_collect(env=env, amount=Decimal("11"))
    _assert(result.allowed is False, "collection single limit must reject real send")

    env = _base_real_send_env()
    env["COLLECTION_MAX_SINGLE_GAS_NATIVE_BSC"] = "0.001"
    result = _validate_gas(env=env, amount=Decimal("0.002"))
    _assert(result.allowed is False, "gas single limit must reject real send")

    result = _validate_collect(env=_base_real_send_env(), amount=Decimal("1"), db=_FakeDB())
    _assert(result.allowed is True, "complete config and small allowlisted collection must be allowed")


def _test_send_helper_guard_rejects_before_tx_actions() -> None:
    counters = {
        "private_key": 0,
        "private_key_assert": 0,
        "web3": 0,
        "sign_and_broadcast": 0,
    }

    def private_key_provider() -> str:
        counters["private_key"] += 1
        raise AssertionError("private key provider must not be called before guard approval")

    def forbidden_private_key_assert(*args, **kwargs):
        counters["private_key_assert"] += 1
        raise AssertionError("private key assertion must not run before guard approval")

    def forbidden_web3(*args, **kwargs):
        counters["web3"] += 1
        raise AssertionError("web3 must not be requested before guard approval")

    def forbidden_sign_and_broadcast(*args, **kwargs):
        counters["sign_and_broadcast"] += 1
        raise AssertionError("sign/broadcast must not run before guard approval")

    originals = {
        "assert_private_key_matches_address": send_helper.assert_private_key_matches_address,
        "get_web3_for_chain": send_helper.get_web3_for_chain,
        "_sign_and_broadcast": send_helper._sign_and_broadcast,
    }

    def run() -> None:
        send_helper.assert_private_key_matches_address = forbidden_private_key_assert
        send_helper.get_web3_for_chain = forbidden_web3
        send_helper._sign_and_broadcast = forbidden_sign_and_broadcast
        try:
            collect_result = send_helper.send_erc20_collect_transfer(
                chain_key=CHAIN_KEY,
                token_contract_address=TOKEN_CONTRACT,
                token_decimals=18,
                from_private_key=private_key_provider,
                from_address=FROM_ADDRESS,
                to_address=TO_ADDRESS,
                amount=Decimal("1"),
                coin_symbol="USDT",
            )
            gas_result = send_helper.send_native_gas_topup(
                chain_key=CHAIN_KEY,
                from_private_key=private_key_provider,
                from_address=FROM_ADDRESS,
                to_address=TO_ADDRESS,
                amount=Decimal("0.01"),
            )
        finally:
            send_helper.assert_private_key_matches_address = originals["assert_private_key_matches_address"]
            send_helper.get_web3_for_chain = originals["get_web3_for_chain"]
            send_helper._sign_and_broadcast = originals["_sign_and_broadcast"]

        for result in (collect_result, gas_result):
            _assert(result.ok is False, "guard rejection must return ok=False")
            _assert(result.dry_run is False, "real-send guard rejection is not dry-run")
            _assert(str(result.error_message or "").startswith("GUARD_REJECTED:"), "error must be guard-prefixed")
            _assert(result.raw_tx_created is False, "guard rejection must not create raw tx")
            _assert(result.signed is False, "guard rejection must not sign")
            _assert(result.broadcasted is False, "guard rejection must not broadcast")

    _replace_env({"COLLECTION_ENABLE_REAL_SEND": "true"}, run)
    _assert(counters == {key: 0 for key in counters}, "guard rejection must happen before private key/RPC/sign/broadcast")


def main() -> None:
    _test_guard_matrix()
    _test_send_helper_guard_rejects_before_tx_actions()
    print("collection_send_guard_test")
    print("default_real_send_enabled=false")
    print("guard_reject_no_raw_tx=true")
    print("guard_reject_no_sign=true")
    print("guard_reject_no_broadcast=true")


if __name__ == "__main__":
    main()
