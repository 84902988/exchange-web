from __future__ import annotations

import os
import sys
from decimal import Decimal
from typing import Callable


BACKEND_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

from app.routers import admin_pages  # noqa: E402
from app.services import collection_send_helper as send_helper  # noqa: E402
from app.services.collection_send_guard import REAL_SEND_CONFIRM_TEXT  # noqa: E402


CHAIN_KEY = "bsc"
FROM_ADDRESS = "0x1111111111111111111111111111111111111111"
TO_ADDRESS = "0x2222222222222222222222222222222222222222"
TOKEN_CONTRACT = "0x3333333333333333333333333333333333333333"

ENV_NAMES = {
    "COLLECTION_ENABLE_REAL_SEND",
    "COLLECTION_REAL_SEND_CONFIRM",
    "COLLECTION_ALLOWED_CHAINS",
    "COLLECTION_ALLOWED_TARGET_ADDRESSES",
    "COLLECTION_MAX_SINGLE_COLLECT_USDT",
    "COLLECTION_DAILY_COLLECT_USDT_LIMIT",
    "COLLECTION_MAX_SINGLE_GAS_NATIVE_BSC",
    "COLLECTION_DAILY_GAS_NATIVE_LIMIT_BSC",
}


class _Request:
    cookies = {"admin_auth": "1"}


def _assert(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def _replace_env(values: dict[str, str], fn: Callable[[], None]) -> None:
    original = {name: os.environ.get(name) for name in ENV_NAMES}
    try:
        for name in ENV_NAMES:
            os.environ.pop(name, None)
        os.environ.update(values)
        fn()
    finally:
        for name, value in original.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value


def _test_real_send_route_rejects_when_env_disabled() -> None:
    calls = {"collection": 0, "gas": 0}
    original_collection = admin_pages.process_collection_task
    original_gas = admin_pages.process_gas_task

    def forbidden_collection(*args, **kwargs):
        calls["collection"] += 1
        raise AssertionError("collection worker must not run when real send env is disabled")

    def forbidden_gas(*args, **kwargs):
        calls["gas"] += 1
        raise AssertionError("gas worker must not run when real send env is disabled")

    def run() -> None:
        admin_pages.process_collection_task = forbidden_collection
        admin_pages.process_gas_task = forbidden_gas
        try:
            collection_response = admin_pages.collection_task_real_send(
                _Request(), 1, next_path="/admin/collections/tasks"
            )
            gas_response = admin_pages.gas_task_real_send(
                _Request(), 1, next_path="/admin/collections/gas-tasks"
            )
        finally:
            admin_pages.process_collection_task = original_collection
            admin_pages.process_gas_task = original_gas

        _assert(collection_response.status_code == 302, "collection route must redirect with rejection")
        _assert(gas_response.status_code == 302, "gas route must redirect with rejection")
        _assert("error=" in str(collection_response.headers.get("location")), "collection rejection must include error")
        _assert("error=" in str(gas_response.headers.get("location")), "gas rejection must include error")

    _replace_env({"COLLECTION_ENABLE_REAL_SEND": "false"}, run)
    _assert(calls == {"collection": 0, "gas": 0}, "env-disabled rejection must not call workers")


def _test_real_send_route_rejects_when_confirm_missing() -> None:
    calls = {"collection": 0, "gas": 0}
    original_collection = admin_pages.process_collection_task
    original_gas = admin_pages.process_gas_task

    def forbidden_collection(*args, **kwargs):
        calls["collection"] += 1
        raise AssertionError("collection worker must not run when confirm is missing")

    def forbidden_gas(*args, **kwargs):
        calls["gas"] += 1
        raise AssertionError("gas worker must not run when confirm is missing")

    def run() -> None:
        admin_pages.process_collection_task = forbidden_collection
        admin_pages.process_gas_task = forbidden_gas
        try:
            collection_response = admin_pages.collection_task_real_send(
                _Request(), 1, next_path="/admin/collections/tasks"
            )
            gas_response = admin_pages.gas_task_real_send(
                _Request(), 1, next_path="/admin/collections/gas-tasks"
            )
        finally:
            admin_pages.process_collection_task = original_collection
            admin_pages.process_gas_task = original_gas

        _assert(collection_response.status_code == 302, "collection confirm rejection must redirect")
        _assert(gas_response.status_code == 302, "gas confirm rejection must redirect")
        _assert("error=" in str(collection_response.headers.get("location")), "collection confirm rejection must include error")
        _assert("error=" in str(gas_response.headers.get("location")), "gas confirm rejection must include error")

    _replace_env({"COLLECTION_ENABLE_REAL_SEND": "true"}, run)
    _assert(calls == {"collection": 0, "gas": 0}, "confirm-missing rejection must not call workers")


def _test_send_helper_guard_rejects_before_tx_actions() -> None:
    counters = {
        "private_key": 0,
        "private_key_assert": 0,
        "web3": 0,
        "sign_and_broadcast": 0,
    }

    def private_key_provider() -> str:
        counters["private_key"] += 1
        raise AssertionError("private key provider must not run before guard approval")

    def forbidden_private_key_assert(*args, **kwargs):
        counters["private_key_assert"] += 1
        raise AssertionError("private key assertion must not run before guard approval")

    def forbidden_web3(*args, **kwargs):
        counters["web3"] += 1
        raise AssertionError("web3 must not run before guard approval")

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
            _assert(str(result.error_message or "").startswith("GUARD_REJECTED:"), "guard rejection must be explicit")
            _assert(result.raw_tx_created is False, "guard rejection must not create raw tx")
            _assert(result.signed is False, "guard rejection must not sign")
            _assert(result.broadcasted is False, "guard rejection must not broadcast")

    _replace_env(
        {
            "COLLECTION_ENABLE_REAL_SEND": "true",
            "COLLECTION_REAL_SEND_CONFIRM": REAL_SEND_CONFIRM_TEXT,
        },
        run,
    )
    _assert(counters == {key: 0 for key in counters}, "guard rejection must happen before tx actions")


def _test_dry_run_route_stays_dry_when_env_enabled() -> None:
    calls = {"collection_allow_real": None, "gas_allow_real": None}
    original_collection = admin_pages.process_collection_task
    original_gas = admin_pages.process_gas_task

    def fake_collection(task_id: int, *, allow_real_send: bool = False):
        calls["collection_allow_real"] = allow_real_send
        return {"ok": True, "status": "CONFIRMED", "tx_hash": "DRYRUN_TEST", "dry_run": True, "task_id": task_id}

    def fake_gas(task_id: int, *, allow_real_send: bool = False):
        calls["gas_allow_real"] = allow_real_send
        return {"ok": True, "status": "CONFIRMED", "tx_hash": "DRYGAS_TEST", "dry_run": True, "task_id": task_id}

    def run() -> None:
        admin_pages.process_collection_task = fake_collection
        admin_pages.process_gas_task = fake_gas
        try:
            collection_response = admin_pages.collection_task_dry_run(
                _Request(), 7, next_path="/admin/collections/tasks"
            )
            gas_response = admin_pages.gas_task_dry_run(
                _Request(), 8, next_path="/admin/collections/gas-tasks"
            )
        finally:
            admin_pages.process_collection_task = original_collection
            admin_pages.process_gas_task = original_gas

        collection_location = str(collection_response.headers.get("location"))
        gas_location = str(gas_response.headers.get("location"))
        _assert(collection_response.status_code == 302, "collection dry-run route must redirect")
        _assert(gas_response.status_code == 302, "gas dry-run route must redirect")
        _assert("DRYRUN_TEST" in collection_location, "collection dry-run route must keep DRYRUN tx marker")
        _assert("DRYGAS_TEST" in gas_location, "gas dry-run route must keep DRYGAS tx marker")

    _replace_env(
        {
            "COLLECTION_ENABLE_REAL_SEND": "true",
            "COLLECTION_REAL_SEND_CONFIRM": REAL_SEND_CONFIRM_TEXT,
        },
        run,
    )
    _assert(calls["collection_allow_real"] is False, "collection dry-run route must pass allow_real_send=False")
    _assert(calls["gas_allow_real"] is False, "gas dry-run route must pass allow_real_send=False")


def _test_send_helper_force_dry_run_when_env_enabled() -> None:
    def private_key_provider() -> str:
        raise AssertionError("force dry-run must not request private key")

    def run() -> None:
        collect_result = send_helper.send_erc20_collect_transfer(
            chain_key=CHAIN_KEY,
            token_contract_address=TOKEN_CONTRACT,
            token_decimals=18,
            from_private_key=private_key_provider,
            from_address=FROM_ADDRESS,
            to_address=TO_ADDRESS,
            amount=Decimal("1"),
            coin_symbol="USDT",
            force_dry_run=True,
        )
        gas_result = send_helper.send_native_gas_topup(
            chain_key=CHAIN_KEY,
            from_private_key=private_key_provider,
            from_address=FROM_ADDRESS,
            to_address=TO_ADDRESS,
            amount=Decimal("0.01"),
            force_dry_run=True,
        )

        _assert(str(collect_result.tx_hash or "").startswith("DRYRUN_"), "forced collection dry-run must use DRYRUN_")
        _assert(str(gas_result.tx_hash or "").startswith("DRYGAS_"), "forced gas dry-run must use DRYGAS_")
        for result in (collect_result, gas_result):
            _assert(result.dry_run is True, "forced dry-run must set dry_run=True")
            _assert(result.raw_tx_created is False, "forced dry-run must not create raw tx")
            _assert(result.signed is False, "forced dry-run must not sign")
            _assert(result.broadcasted is False, "forced dry-run must not broadcast")

    _replace_env(
        {
            "COLLECTION_ENABLE_REAL_SEND": "true",
            "COLLECTION_REAL_SEND_CONFIRM": REAL_SEND_CONFIRM_TEXT,
        },
        run,
    )


def main() -> None:
    _test_real_send_route_rejects_when_env_disabled()
    _test_real_send_route_rejects_when_confirm_missing()
    _test_send_helper_guard_rejects_before_tx_actions()
    _test_dry_run_route_stays_dry_when_env_enabled()
    _test_send_helper_force_dry_run_when_env_enabled()
    print("collection_real_send_guarded_test")
    print("real_send_env_disabled_rejected=true")
    print("real_send_confirm_missing_rejected=true")
    print("guard_reject_no_raw_tx=true")
    print("guard_reject_no_sign=true")
    print("guard_reject_no_broadcast=true")
    print("dry_run_env_true_still_dry=true")


if __name__ == "__main__":
    main()
