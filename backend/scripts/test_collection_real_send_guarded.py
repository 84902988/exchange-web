from __future__ import annotations

import os
import sys
from decimal import Decimal
from types import SimpleNamespace
from typing import Callable


BACKEND_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

from app.routers import admin_pages  # noqa: E402
from app.services import collection_send_helper as send_helper  # noqa: E402


CHAIN_KEY = "bsc"
FROM_ADDRESS = "0x1111111111111111111111111111111111111111"
TO_ADDRESS = "0x2222222222222222222222222222222222222222"
TOKEN_CONTRACT = "0x3333333333333333333333333333333333333333"

ENV_NAMES = {
    "COLLECTION_REAL_SEND_MASTER_SWITCH",
    "COLLECTION_ENABLE_REAL_SEND",
}


class _Request:
    cookies = {"admin_auth": "test"}


class _FakeQuery:
    def __init__(self, item) -> None:
        self.item = item

    def filter(self, *args, **kwargs):
        return self

    def first(self):
        return self.item


class _FakeDB:
    def __init__(self, item=None) -> None:
        self.item = item
        self.commits = 0
        self.rollbacks = 0

    def query(self, *args, **kwargs):
        return _FakeQuery(self.item)

    def commit(self) -> None:
        self.commits += 1

    def rollback(self) -> None:
        self.rollbacks += 1


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


def _with_admin_route_isolation(fn: Callable[[], None]) -> None:
    originals = {
        "require_admin_post_permission": admin_pages.require_admin_post_permission,
        "is_collection_task_job_active": admin_pages.is_collection_task_job_active,
        "publish": admin_pages._publish_admin_collection_task_changed,
    }
    admin_pages.require_admin_post_permission = lambda *args, **kwargs: None
    admin_pages.is_collection_task_job_active = lambda *args, **kwargs: False
    admin_pages._publish_admin_collection_task_changed = lambda *args, **kwargs: None
    try:
        fn()
    finally:
        admin_pages.require_admin_post_permission = originals["require_admin_post_permission"]
        admin_pages.is_collection_task_job_active = originals["is_collection_task_job_active"]
        admin_pages._publish_admin_collection_task_changed = originals["publish"]


def _test_real_send_routes_fail_closed_when_master_disabled() -> None:
    calls = {"collection_enqueue": 0, "gas_process": 0}
    collection_task = SimpleNamespace(
        id=1,
        batch_id=1,
        task_no="CT-1",
        status="PENDING",
        chain_key=CHAIN_KEY,
        coin_symbol="USDT",
        gas_task_id=None,
        tx_hash=None,
        last_error=None,
        reason=None,
        next_retry_at=None,
        locked_at=None,
        updated_at=None,
        sent_at=None,
        confirmed_at=None,
        block_number=None,
    )
    db = _FakeDB(collection_task)
    original_enqueue = admin_pages.enqueue_collection_task
    original_gas = admin_pages.process_gas_task

    def forbidden_enqueue(*args, **kwargs):
        calls["collection_enqueue"] += 1
        raise AssertionError("collection enqueue must not run with master switch disabled")

    def forbidden_gas(*args, **kwargs):
        calls["gas_process"] += 1
        raise AssertionError("gas worker must not run with master switch disabled")

    def run_routes() -> None:
        admin_pages.enqueue_collection_task = forbidden_enqueue
        admin_pages.process_gas_task = forbidden_gas
        try:
            collection_response = admin_pages.collection_task_real_send(
                _Request(), 1, next_path="/admin/collections/tasks", db=db
            )
            gas_response = admin_pages.gas_task_real_send(
                _Request(), 1, next_path="/admin/collections/gas-tasks", db=db
            )
        finally:
            admin_pages.enqueue_collection_task = original_enqueue
            admin_pages.process_gas_task = original_gas

        for response in (collection_response, gas_response):
            _assert(response.status_code == 302, "disabled real-send route must redirect")
            _assert("error=" in str(response.headers.get("location")), "disabled real-send route must include an error")
        _assert(collection_task.status == "PENDING", "blocked collection task must remain pending")
        _assert(collection_task.last_error == "GUARD_REJECTED:MASTER_SWITCH_OFF", "blocked collection task must record guard reason")

    def run() -> None:
        _with_admin_route_isolation(run_routes)

    _replace_env(
        {"COLLECTION_REAL_SEND_MASTER_SWITCH": "false", "COLLECTION_ENABLE_REAL_SEND": "true"},
        run,
    )
    _assert(calls == {"collection_enqueue": 0, "gas_process": 0}, "master-off rejection must precede queue and worker calls")


def _test_send_helper_guard_rejects_before_tx_actions() -> None:
    counters = {"private_key": 0, "private_key_assert": 0, "web3": 0, "sign_and_broadcast": 0}

    def private_key_provider() -> str:
        counters["private_key"] += 1
        raise AssertionError("private key provider must not run before DB-backed guard approval")

    originals = {
        "assert_private_key_matches_address": send_helper.assert_private_key_matches_address,
        "get_web3_for_chain": send_helper.get_web3_for_chain,
        "_sign_and_broadcast": send_helper._sign_and_broadcast,
    }

    def forbidden_private_key_assert(*args, **kwargs):
        counters["private_key_assert"] += 1
        raise AssertionError("private key assertion must not run")

    def forbidden_web3(*args, **kwargs):
        counters["web3"] += 1
        raise AssertionError("web3 must not run")

    def forbidden_broadcast(*args, **kwargs):
        counters["sign_and_broadcast"] += 1
        raise AssertionError("sign/broadcast must not run")

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
                    to_address=TO_ADDRESS,
                    amount=Decimal("0.01"),
                ),
            )
        finally:
            send_helper.assert_private_key_matches_address = originals["assert_private_key_matches_address"]
            send_helper.get_web3_for_chain = originals["get_web3_for_chain"]
            send_helper._sign_and_broadcast = originals["_sign_and_broadcast"]

        for result in results:
            _assert(result.ok is False, "missing DB-backed authorization must reject")
            _assert(result.error_message == "GUARD_REJECTED:DB_REQUIRED_FOR_REAL_SEND", "guard rejection must be explicit")
            _assert(result.raw_tx_created is False, "guard rejection must not create raw tx")
            _assert(result.signed is False, "guard rejection must not sign")
            _assert(result.broadcasted is False, "guard rejection must not broadcast")

    _replace_env({"COLLECTION_REAL_SEND_MASTER_SWITCH": "true"}, run)
    _assert(counters == {key: 0 for key in counters}, "guard rejection must precede secrets, RPC, sign, and broadcast")


def _test_dry_run_routes_stay_dry_when_master_enabled() -> None:
    calls = {"collection_allow_real": None, "gas_allow_real": None}
    originals = {
        "collection": admin_pages.process_collection_task,
        "gas": admin_pages.process_gas_task,
    }

    def fake_collection(task_id: int, *, allow_real_send: bool = False):
        calls["collection_allow_real"] = allow_real_send
        return {"ok": True, "status": "SENT", "tx_hash": "DRYRUN_TEST", "dry_run": True, "task_id": task_id}

    def fake_gas(task_id: int, *, allow_real_send: bool = False):
        calls["gas_allow_real"] = allow_real_send
        return {"ok": True, "status": "SENT", "tx_hash": "DRYGAS_TEST", "dry_run": True, "task_id": task_id}

    def run_routes() -> None:
        admin_pages.process_collection_task = fake_collection
        admin_pages.process_gas_task = fake_gas
        try:
            collection_response = admin_pages.collection_task_dry_run(
                _Request(), 7, next_path="/admin/collections/tasks", db=_FakeDB()
            )
            gas_response = admin_pages.gas_task_dry_run(
                _Request(), 8, next_path="/admin/collections/gas-tasks", db=_FakeDB()
            )
        finally:
            admin_pages.process_collection_task = originals["collection"]
            admin_pages.process_gas_task = originals["gas"]

        _assert("DRYRUN_TEST" in str(collection_response.headers.get("location")), "collection route must preserve dry-run marker")
        _assert("DRYGAS_TEST" in str(gas_response.headers.get("location")), "gas route must preserve dry-run marker")

    def run() -> None:
        _with_admin_route_isolation(run_routes)

    _replace_env({"COLLECTION_REAL_SEND_MASTER_SWITCH": "true"}, run)
    _assert(calls["collection_allow_real"] is False, "collection dry-run route must force allow_real_send=False")
    _assert(calls["gas_allow_real"] is False, "gas dry-run route must force allow_real_send=False")


def _test_send_helper_force_dry_run_when_master_enabled() -> None:
    def private_key_provider() -> str:
        raise AssertionError("forced dry-run must not request a private key")

    def run() -> None:
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
                force_dry_run=True,
            ),
            send_helper.send_native_gas_topup(
                chain_key=CHAIN_KEY,
                from_private_key=private_key_provider,
                from_address=FROM_ADDRESS,
                to_address=TO_ADDRESS,
                amount=Decimal("0.01"),
                force_dry_run=True,
            ),
        )
        for result, prefix in zip(results, ("DRYRUN_", "DRYGAS_")):
            _assert(result.ok is True and result.dry_run is True, "forced dry-run must succeed without real send")
            _assert(str(result.tx_hash or "").startswith(prefix), "forced dry-run must use a dry marker")
            _assert(result.raw_tx_created is False, "forced dry-run must not create raw tx")
            _assert(result.signed is False, "forced dry-run must not sign")
            _assert(result.broadcasted is False, "forced dry-run must not broadcast")

    _replace_env({"COLLECTION_REAL_SEND_MASTER_SWITCH": "true"}, run)


def main() -> None:
    _test_real_send_routes_fail_closed_when_master_disabled()
    _test_send_helper_guard_rejects_before_tx_actions()
    _test_dry_run_routes_stay_dry_when_master_enabled()
    _test_send_helper_force_dry_run_when_master_enabled()
    print("collection_real_send_guarded_test")
    print("isolated_db_only=true")
    print("master_switch_disabled_rejected=true")
    print("guard_reject_no_raw_tx=true")
    print("guard_reject_no_sign=true")
    print("guard_reject_no_broadcast=true")
    print("dry_run_master_true_still_dry=true")


if __name__ == "__main__":
    main()
