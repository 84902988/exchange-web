from __future__ import annotations

import json
from decimal import Decimal
from pathlib import Path

import pytest
from alembic.config import Config
from alembic.migration import MigrationContext
from alembic.operations import Operations
from alembic.script import ScriptDirectory
from sqlalchemy import create_engine, inspect
from sqlalchemy.orm import Session

from app.db.models.trade_idempotency_request import TradeIdempotencyRequest
from app.jobs.db_lifecycle_cleanup_job import PROTECTED_TABLES
from app.services.trade_idempotency_service import (
    TradeIdempotencyConflict,
    TradeIdempotencyUnavailable,
    canonical_request_hash,
    claim_trade_idempotency,
    complete_trade_idempotency,
    get_trade_idempotency_status,
)


@pytest.fixture()
def engine():
    value = create_engine("sqlite+pysqlite:///:memory:", future=True)
    TradeIdempotencyRequest.__table__.create(value)
    try:
        yield value
    finally:
        value.dispose()


def test_canonical_request_hash_is_order_independent_and_value_sensitive():
    assert canonical_request_hash({"symbol": "BTCUSDT", "amount": "1"}) == (
        canonical_request_hash({"amount": "1", "symbol": "BTCUSDT"})
    )
    assert canonical_request_hash({"amount": "1"}) != canonical_request_hash(
        {"amount": "2"}
    )
    assert canonical_request_hash({"amount": Decimal("1.000")}) == (
        canonical_request_hash({"amount": Decimal("1")})
    )


def test_completed_claim_replays_the_original_response(engine):
    with Session(engine) as db:
        claim = claim_trade_idempotency(
            db,
            user_id=7,
            market="spot",
            operation="spot_create",
            client_order_id="mob_spot_abc",
            request_payload={"symbol": "BTCUSDT", "amount": "1"},
        )
        assert claim.is_replay is False
        complete_trade_idempotency(
            db,
            claim,
            {"id": 19, "status": "FILLED", "client_order_id": "mob_spot_abc"},
        )
        db.commit()

    with Session(engine) as db:
        replay = claim_trade_idempotency(
            db,
            user_id=7,
            market="SPOT",
            operation="SPOT_CREATE",
            client_order_id="mob_spot_abc",
            request_payload={"amount": "1", "symbol": "BTCUSDT"},
        )
        assert replay.is_replay is True
        assert replay.record is None
        assert replay.replay_payload == {
            "client_order_id": "mob_spot_abc",
            "id": 19,
            "status": "FILLED",
        }


def test_reusing_a_key_for_different_payload_fails_closed(engine):
    with Session(engine) as db:
        claim = claim_trade_idempotency(
            db,
            user_id=7,
            market="SPOT",
            operation="SPOT_CREATE",
            client_order_id="mob_spot_conflict",
            request_payload={"amount": "1"},
        )
        complete_trade_idempotency(db, claim, {"id": 20})
        db.commit()

    with Session(engine) as db:
        with pytest.raises(TradeIdempotencyConflict):
            claim_trade_idempotency(
                db,
                user_id=7,
                market="SPOT",
                operation="SPOT_CREATE",
                client_order_id="mob_spot_conflict",
                request_payload={"amount": "2"},
            )


def test_committed_incomplete_claim_never_executes_as_a_new_request(engine):
    with Session(engine) as db:
        db.add(
            TradeIdempotencyRequest(
                user_id=7,
                market="CONTRACT",
                operation="CONTRACT_OPEN",
                client_order_id="mob_contract_pending",
                fingerprint_version=1,
                request_hash=canonical_request_hash({"quantity": "1"}),
                status="PENDING",
                response_json=None,
            )
        )
        db.commit()

    with Session(engine) as db:
        with pytest.raises(TradeIdempotencyUnavailable):
            claim_trade_idempotency(
                db,
                user_id=7,
                market="CONTRACT",
                operation="CONTRACT_OPEN",
                client_order_id="mob_contract_pending",
                request_payload={"quantity": "1"},
            )


def test_completed_response_is_stored_as_canonical_json(engine):
    with Session(engine) as db:
        claim = claim_trade_idempotency(
            db,
            user_id=8,
            market="SPOT",
            operation="SPOT_CREATE",
            client_order_id="mob_spot_json",
            request_payload={"amount": "1"},
        )
        complete_trade_idempotency(db, claim, {"status": "OPEN", "id": 3})
        db.commit()
        stored = db.query(TradeIdempotencyRequest).one()
        assert stored.status == "COMPLETED"
        assert json.loads(stored.response_json or "") == {"id": 3, "status": "OPEN"}
        assert stored.completed_at is not None


def test_trade_idempotency_migration_is_head_and_round_trips_on_sqlite():
    backend_dir = Path(__file__).resolve().parents[1]
    config = Config(str(backend_dir / "alembic.ini"))
    config.set_main_option("script_location", str(backend_dir / "alembic"))
    script = ScriptDirectory.from_config(config)
    assert script.get_heads() == ["20260824_000136"]
    revision = script.get_revision("20260801_000128")
    assert revision is not None
    assert revision.down_revision == "20260731_000127"

    migration_engine = create_engine("sqlite://")
    with migration_engine.begin() as connection:
        operations = Operations(MigrationContext.configure(connection))
        original_op = revision.module.op
        revision.module.op = operations
        try:
            revision.module.upgrade()
            inspector = inspect(connection)
            assert "trade_idempotency_requests" in inspector.get_table_names()
            unique_constraints = inspector.get_unique_constraints(
                "trade_idempotency_requests"
            )
            assert any(
                item.get("name") == "uq_trade_idempotency_user_market_client"
                for item in unique_constraints
            )
            revision.module.downgrade()
            assert "trade_idempotency_requests" not in inspect(
                connection
            ).get_table_names()
        finally:
            revision.module.op = original_op
    migration_engine.dispose()


def test_trade_idempotency_records_are_never_part_of_destructive_cleanup():
    assert "trade_idempotency_requests" in PROTECTED_TABLES


def test_status_query_is_scoped_by_owner_and_market_and_never_treats_missing_as_safe(
    engine,
):
    with Session(engine) as db:
        claim = claim_trade_idempotency(
            db,
            user_id=7,
            market="SPOT",
            operation="SPOT_CREATE",
            client_order_id="mob-status-1",
            request_payload={"symbol": "BTCUSDT"},
        )
        complete_trade_idempotency(
            db,
            claim,
            {
                "id": 91,
                "symbol": "BTCUSDT",
                "client_order_id": "mob-status-1",
            },
        )
        db.add(
            TradeIdempotencyRequest(
                user_id=7,
                market="CONTRACT",
                operation="CONTRACT_OPEN",
                client_order_id="mob-pending-1",
                fingerprint_version=1,
                request_hash=canonical_request_hash({"symbol": "BTCUSDT_PERP"}),
                status="PENDING",
                response_json=None,
            )
        )
        db.commit()

    with Session(engine) as db:
        completed = get_trade_idempotency_status(
            db,
            user_id=7,
            market="spot",
            client_order_id="MOB-STATUS-1",
        )
        assert completed.status == "COMPLETED"
        assert completed.operation == "SPOT_CREATE"
        assert completed.response_payload == {
            "client_order_id": "mob-status-1",
            "id": 91,
            "symbol": "BTCUSDT",
        }

        pending = get_trade_idempotency_status(
            db,
            user_id=7,
            market="CONTRACT",
            client_order_id="mob-pending-1",
        )
        assert pending.status == "PENDING"
        assert pending.response_payload is None

        wrong_owner = get_trade_idempotency_status(
            db,
            user_id=8,
            market="SPOT",
            client_order_id="mob-status-1",
        )
        assert wrong_owner.status == "NOT_FOUND"
        assert wrong_owner.operation is None

        wrong_market = get_trade_idempotency_status(
            db,
            user_id=7,
            market="CONTRACT",
            client_order_id="mob-status-1",
        )
        assert wrong_market.status == "NOT_FOUND"
