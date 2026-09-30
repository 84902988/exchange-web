import asyncio
import json
from decimal import Decimal
from types import SimpleNamespace

import pytest
from hexbytes import HexBytes
from sqlalchemy import Integer, MetaData, create_engine, text
from sqlalchemy.orm import Session
from starlette.requests import Request
from web3.datastructures import AttributeDict

from app.db.models.asset import BalanceLog, Deposit, UserBalance
from app.routers import webhook_moralis as webhook
from app.services import deposit_tx_confirm_service as confirm
from app.services import native_deposit_service as native
from app.tasks import native_deposit_tasks as tasks

TXID = "0x624888e5cba48f3151c9bc47815bd4df7344ef4faf353e4d297143f2e49050f2"
ADDRESS = "0x07bf000164bc4d7af28ec9c80eed54ccd27a3716"
SENDER = "0x29d02e7bc9817d5e9caf59c0530bcb85d0b47a44"
BLOCK_HASH = "0x" + "ab" * 32
CONTRACT = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c"


@pytest.fixture
def db(monkeypatch):
    engine = create_engine("sqlite://")
    metadata = MetaData()
    for model in (Deposit, BalanceLog, UserBalance):
        table = model.__table__.to_metadata(metadata)
        table.c.id.type = Integer()
    metadata.create_all(engine)
    session = Session(engine)
    ddl = [
        "CREATE TABLE assets (id INTEGER PRIMARY KEY, symbol TEXT, enabled INTEGER)",
        """CREATE TABLE chains (id INTEGER PRIMARY KEY, chain_key TEXT, chain_id INTEGER,
            native_symbol TEXT, enabled INTEGER, confirmations INTEGER,
            hot_wallet_address TEXT, collection_address TEXT)""",
        """CREATE TABLE asset_chains (id INTEGER PRIMARY KEY, asset_id INTEGER, chain_id INTEGER,
            native_deposit_enabled INTEGER DEFAULT 0, contract_address TEXT, decimals INTEGER,
            min_deposit NUMERIC DEFAULT 0, confirmations INTEGER, enabled INTEGER,
            deposit_enabled INTEGER)""",
        """CREATE TABLE user_chain_addresses (id INTEGER PRIMARY KEY, user_id INTEGER,
            chain_id INTEGER, address TEXT, memo TEXT, enabled INTEGER)""",
        "CREATE TABLE gas_tasks (chain_key TEXT, tx_hash TEXT)",
        "CREATE TABLE collection_tasks (chain_key TEXT, tx_hash TEXT)",
    ]
    for sql in ddl:
        session.execute(text(sql))
    session.execute(text("INSERT INTO assets VALUES (16, 'BNB', 1)"))
    session.execute(text("INSERT INTO chains VALUES (1,'bsc',56,'BNB',1,12,NULL,NULL)"))
    session.execute(text("""INSERT INTO asset_chains
        (id,asset_id,chain_id,native_deposit_enabled,decimals,enabled,deposit_enabled)
        VALUES (17,16,1,1,18,1,1)"""))
    session.execute(text("INSERT INTO user_chain_addresses VALUES (4,8,1,:addr,NULL,1)"), {"addr": ADDRESS})
    session.commit()
    monkeypatch.setattr(confirm, "_is_active_stock_token_lock_symbol", lambda *args: False)
    monkeypatch.setattr(webhook, "_is_active_stock_token_lock_symbol", lambda *args: False)
    # SQLite in-memory engine inspection shares the session's physical connection;
    # its rollback would discard savepoints. Collection has separate MySQL tests.
    monkeypatch.setattr("app.services.collection_candidate_registry._has_collection_candidates_table", lambda db: False)
    yield session
    session.close()
    engine.dispose()


@pytest.fixture
def rpc(monkeypatch):
    tx = {"hash": HexBytes(TXID), "from": SENDER, "to": ADDRESS, "value": 100000000000000,
          "blockNumber": 100, "blockHash": HexBytes(BLOCK_HASH)}
    receipt = {"transactionHash": HexBytes(TXID), "status": 1, "blockNumber": 100,
               "blockHash": HexBytes(BLOCK_HASH), "logs": []}
    block = {"hash": HexBytes(BLOCK_HASH)}
    eth = SimpleNamespace(chain_id=56, block_number=111,
                          get_transaction=lambda _: AttributeDict(tx),
                          get_transaction_receipt=lambda _: AttributeDict(receipt),
                          get_block=lambda _: AttributeDict(block))
    monkeypatch.setattr(native, "get_web3_for_chain", lambda *a, **k: SimpleNamespace(
        eth=eth, middleware_onion=SimpleNamespace(inject=lambda *a, **kw: None)))
    return SimpleNamespace(tx=tx, receipt=receipt, block=block, eth=eth)


def tx_notification(**changes):
    return {"hash": TXID, "fromAddress": SENDER, "toAddress": ADDRESS,
            "value": "100000000000000", **changes}


def balance(db, symbol="BNB"):
    row = db.query(UserBalance).filter_by(user_id=8, coin_symbol=symbol, chain_key="funding").first()
    return row.available_amount if row else Decimal(0)


@pytest.mark.parametrize("chain,symbol,chain_id", [
    ("bsc", "BNB", 56), ("ethereum", "ETH", 1), ("optimism", "ETH", 10),
    ("avaxc", "AVAX", 43114), ("polygon", "POL", 137),
])
def test_all_supported_evm_networks_use_explicit_config_and_real_ledger(db, rpc, chain, symbol, chain_id):
    db.execute(text("UPDATE chains SET chain_key=:c, native_symbol=:s, chain_id=:i"), {"c": chain, "s": symbol, "i": chain_id})
    db.execute(text("UPDATE assets SET symbol=:s"), {"s": symbol})
    rpc.eth.chain_id = chain_id
    dep = native.register_native_deposit(db, chain, tx_notification())
    assert dep.status == "DETECTING" and balance(db, symbol) == 0
    first = confirm.recheck_deposit_chain_confirmation(db, dep.id)
    db.commit()
    second = confirm.recheck_deposit_chain_confirmation(db, dep.id)
    assert first.credited and second.already_credited
    assert balance(db, symbol) == Decimal("0.0001")
    assert db.query(BalanceLog).count() == 1
    assert dep.log_index == -1 and dep.status == "CONFIRMED" and dep.confirmations == 12


@pytest.mark.parametrize("sql", [
    "UPDATE asset_chains SET native_deposit_enabled=0",
    "UPDATE asset_chains SET contract_address='" + CONTRACT + "'",
    "UPDATE asset_chains SET deposit_enabled=0",
    "UPDATE asset_chains SET enabled=0",
    "UPDATE assets SET enabled=0", "UPDATE chains SET enabled=0",
    "UPDATE assets SET symbol='WBNB'", "UPDATE asset_chains SET decimals=6",
    "UPDATE asset_chains SET min_deposit=0.001", "UPDATE user_chain_addresses SET enabled=0",
    "DELETE FROM asset_chains",
])
def test_unconfigured_disabled_wrapped_or_wrong_assets_never_register(db, sql):
    db.execute(text(sql))
    assert native.register_native_deposit(db, "bsc", tx_notification()) is None
    assert db.query(Deposit).count() == 0
    assert db.query(BalanceLog).count() == 0


def test_another_user_address_and_another_network_are_not_credited(db):
    assert native.register_native_deposit(db, "ethereum", tx_notification()) is None
    assert native.register_native_deposit(db, "bsc", tx_notification(toAddress="0x" + "99" * 20)) is None


@pytest.mark.parametrize("where", ["hot_wallet_address", "collection_address", "gas_tasks", "collection_tasks"])
def test_platform_internal_transfers_do_not_create_deposits(db, where):
    if where.endswith("address"):
        db.execute(text(f"UPDATE chains SET {where}=:sender"), {"sender": SENDER})
    else:
        db.execute(text(f"INSERT INTO {where} VALUES ('bsc',:txid)"), {"txid": TXID})
    assert native.register_native_deposit(db, "bsc", tx_notification()) is None


def test_internal_hash_added_after_notification_is_excluded_at_credit(db, rpc):
    dep = native.register_native_deposit(db, "bsc", tx_notification())
    db.execute(text("INSERT INTO gas_tasks VALUES ('bsc',:txid)"), {"txid": TXID})
    assert confirm.recheck_deposit_chain_confirmation(db, dep.id).error_message == "INTERNAL_TRANSFER"
    assert balance(db) == 0 and dep.status == "IGNORED"


def test_confirmations_are_from_rpc_not_webhook_and_pending_later_credits(db, rpc):
    dep = native.register_native_deposit(db, "bsc", tx_notification(confirmed=True))
    rpc.eth.block_number = 103
    assert confirm.recheck_deposit_chain_confirmation(db, dep.id).status == "PENDING"
    assert balance(db) == 0 and dep.confirmations == 4
    rpc.eth.block_number = 111
    assert confirm.recheck_deposit_chain_confirmation(db, dep.id).credited
    assert balance(db) == Decimal("0.0001")


@pytest.mark.parametrize("part,key,value", [
    ("tx", "to", "0x" + "99" * 20), ("tx", "from", "0x" + "99" * 20),
    ("tx", "value", 200000000000000), ("tx", "hash", "0x" + "99" * 32),
    ("receipt", "transactionHash", "0x" + "99" * 32),
])
def test_rpc_mismatch_never_credits(db, rpc, part, key, value):
    dep = native.register_native_deposit(db, "bsc", tx_notification())
    getattr(rpc, part)[key] = value
    assert confirm.recheck_deposit_chain_confirmation(db, dep.id).status == "MISMATCH"
    assert balance(db) == 0


@pytest.mark.parametrize("part,key,value", [
    ("tx", "blockNumber", 99), ("block", "hash", "0x" + "99" * 32),
    ("tx", "blockHash", "0x" + "99" * 32),
])
def test_reorg_waits_for_canonical_receipt_and_can_recover(db, rpc, part, key, value):
    dep = native.register_native_deposit(db, "bsc", tx_notification())
    original = getattr(rpc, part)[key]
    getattr(rpc, part)[key] = value
    assert confirm.recheck_deposit_chain_confirmation(db, dep.id).error_message == "BLOCK_NOT_CANONICAL"
    assert balance(db) == 0
    getattr(rpc, part)[key] = original
    assert confirm.recheck_deposit_chain_confirmation(db, dep.id).credited


def test_failed_receipt_and_wrong_rpc_network_fail_closed(db, rpc):
    dep = native.register_native_deposit(db, "bsc", tx_notification())
    rpc.eth.chain_id = 1
    assert confirm.recheck_deposit_chain_confirmation(db, dep.id).error_message == "RPC_CHAIN_MISMATCH"
    rpc.eth.chain_id = 56
    rpc.receipt["status"] = 0
    assert confirm.recheck_deposit_chain_confirmation(db, dep.id).status == "FAILED_ONCHAIN"
    assert balance(db) == 0


def test_operator_disable_after_detection_prevents_credit(db, rpc):
    dep = native.register_native_deposit(db, "bsc", tx_notification())
    db.execute(text("UPDATE asset_chains SET native_deposit_enabled=0"))
    assert confirm.recheck_deposit_chain_confirmation(db, dep.id).error_message == "NATIVE_DEPOSIT_DISABLED"
    assert balance(db) == 0


@pytest.mark.parametrize("raw", [0, -1, True, None, "1.5", "1e18", "NaN", "Infinity", "-0x1", str(10**36)])
def test_invalid_native_amounts_are_rejected(raw):
    with pytest.raises(ValueError):
        native.native_amount(raw)


def test_amounts_keep_18_decimal_precision_and_ignore_formatted_fields():
    assert native.native_amount("0x1") == Decimal("0.000000000000000001")
    assert str(native.native_amount("999999999999999999999999999999999999")) == "999999999999999999.999999999999999999"
    assert native.extract_native_transfers({"txs": [tx_notification(value="0", valueWithDecimals="1000")]}) == []
    assert native.extract_native_transfers({"txsInternal": [tx_notification()]}) == []


def request(payload, signed=True):
    async def receive():
        return {"type": "http.request", "body": json.dumps(payload).encode(), "more_body": False}
    headers = [(b"x-signature", b"test-signature")] if signed else []
    return Request({"type": "http", "method": "POST", "path": "/webhooks/moralis", "headers": headers}, receive)


def payload(**changes):
    return {"streamId": "test-stream", "chainId": "0x38", "confirmed": True,
            "txs": [tx_notification()], "erc20Transfers": [], **changes}


def test_signed_webhook_registers_once_and_queue_failure_can_be_replayed(db, monkeypatch):
    monkeypatch.setattr(webhook, "verify_signature", lambda **kw: True)
    monkeypatch.setattr(webhook, "_enqueue_native_after_commit", lambda ids: False)
    first = asyncio.run(webhook._moralis_webhook_impl(request(payload()), db))
    assert first["retryable"] and db.query(Deposit).count() == 1
    queued = []
    monkeypatch.setattr(webhook, "_enqueue_native_after_commit", lambda ids: queued.extend(ids) or True)
    second = asyncio.run(webhook._moralis_webhook_impl(request(payload()), db))
    assert second["native_pending"] == 1 and len(queued) == 1
    assert db.query(Deposit).count() == 1 and balance(db) == 0


@pytest.mark.parametrize("signed,valid", [(False, True), (True, False)])
def test_unsigned_or_invalid_webhook_cannot_register_native_money(db, monkeypatch, signed, valid):
    monkeypatch.setattr(webhook, "verify_signature", lambda **kw: valid)
    monkeypatch.setattr(webhook, "_enqueue_native_after_commit", lambda ids: True)
    asyncio.run(webhook._moralis_webhook_impl(request(payload(), signed=signed), db))
    assert db.query(Deposit).count() == 0


def test_erc20_log_zero_and_native_value_same_transaction_have_separate_identities(db, rpc, monkeypatch):
    db.execute(text("INSERT INTO assets VALUES (20,'WBNB',1)"))
    db.execute(text("""INSERT INTO asset_chains
        (id,asset_id,chain_id,contract_address,decimals,enabled,deposit_enabled)
        VALUES (21,20,1,:contract,18,1,1)"""), {"contract": CONTRACT})
    monkeypatch.setattr(webhook, "verify_signature", lambda **kw: True)
    monkeypatch.setattr(webhook, "_enqueue_native_after_commit", lambda ids: True)
    transfer = {"transactionHash": TXID, "from": SENDER, "to": ADDRESS,
                "contract": CONTRACT, "value": "1000000000000000000", "logIndex": 0}
    for _ in range(2):
        result = asyncio.run(webhook._moralis_webhook_impl(request(payload(erc20Transfers=[transfer])), db))
        assert result["native_pending"] == 1
    assert {d.log_index for d in db.query(Deposit).all()} == {-1, 0}
    assert balance(db, "WBNB") == 1 and balance(db) == 0
    dep = db.query(Deposit).filter_by(log_index=-1).one()
    assert confirm.recheck_deposit_chain_confirmation(db, dep.id).credited
    assert balance(db) == Decimal("0.0001") and db.query(BalanceLog).count() == 2


def test_ledger_failure_does_not_leave_deposit_marked_confirmed(db, rpc, monkeypatch):
    dep = native.register_native_deposit(db, "bsc", tx_notification())
    db.commit()
    def fail(*args, **kwargs):
        raise RuntimeError("ledger unavailable")
    monkeypatch.setattr(confirm, "credit_available", fail)
    with pytest.raises(RuntimeError):
        confirm.recheck_deposit_chain_confirmation(db, dep.id)
    db.rollback()
    assert dep.status == "DETECTING" and balance(db) == 0


def test_native_worker_schedules_pending_retries_and_scheduler_is_enabled(db, rpc, monkeypatch):
    from scripts.start_rq_worker import _scheduler_required
    dep = native.register_native_deposit(db, "bsc", tx_notification())
    db.commit()
    rpc.eth.block_number = 100
    monkeypatch.setattr(tasks, "SessionLocal", lambda: db)
    with pytest.raises(tasks.NativeDepositPending):
        tasks.confirm_native_deposit(dep.id)
    assert _scheduler_required(["tx_confirm"])
    assert balance(db) == 0


def test_native_configuration_requires_matching_network_asset_and_no_contract():
    good = dict(chain_key="bsc", symbol="BNB", native_symbol="BNB", contract_address="", decimals=18)
    assert not native.native_configuration_errors(**good)
    for change in [dict(contract_address=CONTRACT), dict(symbol="WBNB"), dict(decimals=6),
                   dict(chain_key="solana"), dict(withdraw_enabled=True), dict(collection_real_send_enabled=True)]:
        assert native.native_configuration_errors(**{**good, **change})


def test_negative_token_log_index_cannot_use_native_identity(db, monkeypatch):
    db.execute(text("UPDATE asset_chains SET native_deposit_enabled=0, contract_address=:c"), {"c": CONTRACT})
    monkeypatch.setattr(webhook, "verify_signature", lambda **kw: True)
    transfer = {"transactionHash": TXID, "from": SENDER, "to": ADDRESS,
                "contract": CONTRACT, "value": "1000000000000000000", "logIndex": -1}
    result = asyncio.run(webhook._moralis_webhook_impl(request(payload(txs=[], erc20Transfers=[transfer])), db))
    assert result["skipped"] == 1
    assert db.query(Deposit).count() == 0 and balance(db) == 0


def test_missing_ledger_cannot_be_reported_as_already_credited(db, rpc, monkeypatch):
    dep = native.register_native_deposit(db, "bsc", tx_notification())
    monkeypatch.setattr(confirm, "_credit_confirmed_deposit", lambda *a, **kw: (False, True))
    with pytest.raises(RuntimeError, match="LEDGER_MISSING"):
        confirm.recheck_deposit_chain_confirmation(db, dep.id)
    assert dep.status != "CONFIRMED" and balance(db) == 0


def test_rpc_outage_is_pending_and_retry_can_credit(db, rpc):
    dep = native.register_native_deposit(db, "bsc", tx_notification())
    original = rpc.eth.get_transaction
    def unavailable(_):
        raise TimeoutError("test RPC unavailable")
    rpc.eth.get_transaction = unavailable
    result = confirm.recheck_deposit_chain_confirmation(db, dep.id)
    assert result.status == "PENDING" and result.error_message == "RPC_UNAVAILABLE"
    assert balance(db) == 0
    rpc.eth.get_transaction = original
    assert confirm.recheck_deposit_chain_confirmation(db, dep.id).credited


def test_queue_failure_responds_http_503_for_provider_retry(db, monkeypatch):
    monkeypatch.setattr(webhook, "SessionLocal", lambda: db)
    monkeypatch.setattr(webhook, "verify_signature", lambda **kw: True)
    monkeypatch.setattr(webhook, "_enqueue_native_after_commit", lambda ids: False)
    response = asyncio.run(webhook.moralis_webhook(request(payload())))
    assert response.status_code == 503
    assert json.loads(response.body)["retryable"]
    assert db.query(Deposit).count() == 1 and balance(db) == 0


@pytest.mark.parametrize("status", ["queued", "started", "scheduled", "deferred"])
def test_pending_job_is_not_replaced_on_duplicate_callback(monkeypatch, status):
    job = SimpleNamespace(get_status=lambda **kw: status)
    queue = SimpleNamespace(fetch_job=lambda _: job,
                            enqueue_call=lambda **kw: pytest.fail("duplicate job"))
    monkeypatch.setattr(tasks, "get_queue", lambda _: queue)
    assert tasks.enqueue_native_deposit(123) == "native_deposit_123"


def test_new_job_uses_delayed_retries(monkeypatch):
    import inspect
    from rq import Queue
    calls = []
    def enqueue_call(**kwargs):
        # Validate against the installed RQ API, including its timeout argument.
        inspect.signature(Queue.enqueue_call).bind(None, **kwargs)
        calls.append(kwargs)
    queue = SimpleNamespace(fetch_job=lambda _: None, enqueue_call=enqueue_call)
    monkeypatch.setattr(tasks, "get_queue", lambda _: queue)
    tasks.enqueue_native_deposit(123)
    assert calls[0]["args"] == (123,) and calls[0]["retry"].max == 48
    assert calls[0]["retry"].intervals == [15, 30, 60, 120, 300]
    assert calls[0]["timeout"] == 120


def test_ambiguous_native_asset_mapping_fails_closed(db):
    db.execute(text("INSERT INTO assets VALUES (99,'BNB',1)"))
    db.execute(text("INSERT INTO asset_chains (id,asset_id,chain_id,native_deposit_enabled,decimals,enabled,deposit_enabled) VALUES (99,99,1,1,18,1,1)"))
    assert native.register_native_deposit(db, "bsc", tx_notification()) is None


def test_admin_validation_uses_actual_network_metadata(db):
    from app.services.admin_queries import _validate_native_deposit_config
    data = {"native_deposit_enabled": "1", "contract_address": "", "decimals": "18"}
    errors = []
    _validate_native_deposit_config(db, 16, 1, data, errors)
    assert errors == []
    _validate_native_deposit_config(db, 16, 1, {**data, "contract_address": CONTRACT}, errors)
    assert errors


def test_migration_keeps_existing_contract_mapping_and_defaults_native_off():
    from importlib.util import module_from_spec, spec_from_file_location
    from pathlib import Path
    from alembic.migration import MigrationContext
    from alembic.operations import Operations
    path = Path(__file__).resolve().parents[1] / "alembic/versions/20260924_000137_add_native_deposit_opt_in.py"
    spec = spec_from_file_location("native_migration", path)
    migration = module_from_spec(spec)
    spec.loader.exec_module(migration)
    engine = create_engine("sqlite://")
    with engine.begin() as connection:
        connection.execute(text("CREATE TABLE asset_chains (id INTEGER PRIMARY KEY, contract_address TEXT)"))
        connection.execute(text("INSERT INTO asset_chains VALUES (17,:c)"), {"c": CONTRACT})
        migration.op = Operations(MigrationContext.configure(connection))
        migration.upgrade()
        row = connection.execute(text("SELECT * FROM asset_chains")).mappings().one()
        assert row["contract_address"] == CONTRACT and row["native_deposit_enabled"] == 0
        connection.execute(text("INSERT INTO asset_chains (id) VALUES (18)"))
        assert connection.execute(text("SELECT native_deposit_enabled FROM asset_chains WHERE id=18")).scalar_one() == 0
    engine.dispose()


def test_unconfigured_empty_contract_is_not_offered_or_given_an_address(db, monkeypatch):
    from fastapi import HTTPException
    from app.routers import asset as asset_router
    for statement in [
        "ALTER TABLE assets ADD COLUMN name TEXT", "ALTER TABLE assets ADD COLUMN display_precision INTEGER DEFAULT 8",
        "ALTER TABLE assets ADD COLUMN icon_url TEXT", "ALTER TABLE chains ADD COLUMN name TEXT",
        "ALTER TABLE asset_chains ADD COLUMN sort INTEGER DEFAULT 0",
        "ALTER TABLE asset_chains ADD COLUMN min_withdraw NUMERIC DEFAULT 0",
        "ALTER TABLE asset_chains ADD COLUMN review_threshold_amount NUMERIC",
        "ALTER TABLE asset_chains ADD COLUMN withdraw_enabled INTEGER DEFAULT 0",
    ]:
        db.execute(text(statement))
    monkeypatch.setattr(asset_router, "_has_column", lambda *args: False)
    assert len(asset_router._query_asset_chain_options(db, scene="deposit")) == 1
    db.execute(text("UPDATE asset_chains SET native_deposit_enabled=0"))
    assert asset_router._query_asset_chain_options(db, scene="deposit") == []
    monkeypatch.setattr(asset_router, "_resolve_asset_chain", lambda *a, **kw: {
        "deposit_enabled": 1, "asset_enabled": 1, "chain_enabled": 1, "asset_chain_enabled": 1,
        "contract_address": None,
    })
    monkeypatch.setattr(asset_router, "get_or_create_deposit_address", lambda *a, **kw: pytest.fail("unconfigured address issued"))
    with pytest.raises(HTTPException) as caught:
        asset_router.get_deposit_address(request({}), "BNB", "bsc", db, 8)
    assert caught.value.detail["code"] == "NATIVE_DEPOSIT_DISABLED"
    db.execute(text("UPDATE asset_chains SET contract_address=:c"), {"c": CONTRACT})
    assert len(asset_router._query_asset_chain_options(db, scene="deposit")) == 1


def test_real_web3_decodes_poa_header_and_hexbytes_before_credit(db, monkeypatch):
    from web3 import Web3
    from web3.providers.base import BaseProvider
    responses = {
        "eth_chainId": "0x38", "eth_blockNumber": "0x6f",
        "eth_getTransactionByHash": {"hash": TXID, "from": SENDER, "to": ADDRESS,
            "value": hex(100000000000000), "blockNumber": "0x64", "blockHash": BLOCK_HASH},
        "eth_getTransactionReceipt": {"transactionHash": TXID, "status": "0x1",
            "blockNumber": "0x64", "blockHash": BLOCK_HASH, "logs": []},
        "eth_getBlockByNumber": {"number": "0x64", "hash": BLOCK_HASH,
            "extraData": "0x" + "aa" * 97},
    }
    class TestProvider(BaseProvider):
        def make_request(self, method, params):
            return {"jsonrpc": "2.0", "id": 1, "result": responses[method]}
    monkeypatch.setattr(native, "get_web3_for_chain", lambda *a, **kw: Web3(TestProvider()))
    dep = native.register_native_deposit(db, "bsc", tx_notification())
    assert confirm.recheck_deposit_chain_confirmation(db, dep.id).credited
    assert balance(db) == Decimal("0.0001")
