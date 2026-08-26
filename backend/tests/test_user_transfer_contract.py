from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from pathlib import Path

import pytest
from alembic.config import Config
from alembic.migration import MigrationContext
from alembic.operations import Operations
from alembic.script import ScriptDirectory
from fastapi import HTTPException, Response
from sqlalchemy import create_engine, event, inspect, text
from sqlalchemy.orm import Session

from app.db.models.user_transfer import UserTransfer
from app.schemas.user_transfer import UserTransferRequest, UserTransferRequestStatusData
from app.services.user_transfer_service import (
    UserTransferIdempotencyConflict,
    UserTransferService,
)


def _record(**overrides) -> UserTransfer:
    values = {
        "id": 17,
        "transfer_no": "UTR202608030001",
        "request_id": "intent-1",
        "request_fingerprint": "fingerprint-1",
        "from_user_id": 101,
        "to_user_id": 202,
        "coin_symbol": "USDT",
        "from_account": "funding",
        "to_account": "funding",
        "amount": Decimal("12.50"),
        "fee_amount": Decimal("0"),
        "net_amount": Decimal("12.50"),
        "status": "SUCCESS",
        "recipient_email_mask": "f***d@example.com",
        "sender_available_before": Decimal("100.00"),
        "sender_available_after": Decimal("87.50"),
        "receiver_available_before": Decimal("2.00"),
        "receiver_available_after": Decimal("14.50"),
        "remark": "lunch",
        "created_at": datetime(2026, 8, 3, 8, 0, 0),
        "updated_at": datetime(2026, 8, 3, 8, 0, 0),
    }
    values.update(overrides)
    return UserTransfer(**values)


def test_public_transfer_record_never_exposes_either_users_balance_snapshots() -> None:
    service = UserTransferService()
    row = _record()

    outbound = service._to_record_item(row, current_user_id=101).model_dump()
    inbound = service._to_record_item(row, current_user_id=202).model_dump()

    private_fields = {
        "sender_available_before",
        "sender_available_after",
        "receiver_available_before",
        "receiver_available_after",
    }
    assert private_fields.isdisjoint(outbound)
    assert private_fields.isdisjoint(inbound)
    assert inbound["direction"] == "in"
    assert inbound["counterparty_user_id"] == 101
    assert row.sender_available_before == Decimal("100.00")
    assert row.receiver_available_after == Decimal("14.50")


def test_request_fingerprint_is_stable_for_equivalent_payload_formatting() -> None:
    service = UserTransferService()

    first = service._build_request_fingerprint(
        recipient_email="Friend@Example.com",
        symbol="USDT",
        amount=Decimal("001.2300"),
        remark="lunch",
    )
    retried = service._build_request_fingerprint(
        recipient_email="friend@example.com",
        symbol="USDT",
        amount=Decimal("1.23"),
        remark="lunch",
    )

    assert first == retried
    assert len(first) == 64


@pytest.mark.parametrize(
    ("field", "changed"),
    [
        ("recipient_email", "other@example.com"),
        ("symbol", "BTC"),
        ("amount", Decimal("12.51")),
        ("remark", "dinner"),
    ],
)
def test_same_request_id_rejects_changed_transfer_parameters(field: str, changed: object) -> None:
    service = UserTransferService()
    original = {
        "recipient_email": "friend@example.com",
        "symbol": "USDT",
        "amount": Decimal("12.50"),
        "remark": "lunch",
    }
    row = _record(
        request_fingerprint=service._build_request_fingerprint(**original),
    )
    retried = {**original, field: changed}

    with pytest.raises(UserTransferIdempotencyConflict):
        service._assert_idempotency_match(
            row,
            request_fingerprint=service._build_request_fingerprint(**retried),
            **retried,
        )


def test_legacy_record_allows_matching_retry_but_rejects_changed_amount() -> None:
    service = UserTransferService()
    row = _record(request_fingerprint=None)
    params = {
        "recipient_email": "friend@example.com",
        "symbol": "USDT",
        "amount": Decimal("12.50"),
        "remark": "lunch",
    }

    service._assert_idempotency_match(row, request_fingerprint="new-fingerprint", **params)
    with pytest.raises(UserTransferIdempotencyConflict):
        service._assert_idempotency_match(
            row,
            request_fingerprint="changed-fingerprint",
            **{**params, "amount": Decimal("99")},
        )


def test_router_maps_idempotency_mismatch_to_http_409(monkeypatch) -> None:
    from app.routers import user_transfer as router_module

    class State:
        trace_id = "trace-1"

    class Request:
        state = State()

    class Db:
        rolled_back = False

        def rollback(self) -> None:
            self.rolled_back = True

    db = Db()
    monkeypatch.setattr(router_module, "assert_user_withdraw_unlocked", lambda *_args: None)
    monkeypatch.setattr(
        router_module.user_transfer_service,
        "create_transfer",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            UserTransferIdempotencyConflict("request_id was already used")
        ),
    )

    payload = UserTransferRequest(
        request_id="intent-1",
        recipient_email="friend@example.com",
        symbol="USDT",
        amount=Decimal("1"),
    )
    with pytest.raises(HTTPException) as exc_info:
        router_module.create_user_transfer(Request(), payload, db, 101)

    assert exc_info.value.status_code == 409
    assert exc_info.value.detail["code"] == "IDEMPOTENCY_KEY_REUSE_MISMATCH"
    assert db.rolled_back is True


def test_request_status_is_sender_only_privacy_safe_and_read_only() -> None:
    service = UserTransferService()
    engine = create_engine("sqlite://")
    UserTransfer.__table__.create(engine)
    statements: list[str] = []

    def record_statement(_conn, _cursor, statement, _parameters, _context, _executemany):
        statements.append(statement.strip().upper())

    event.listen(engine, "before_cursor_execute", record_statement)
    with Session(engine) as db:
        db.add(_record(id=1))
        db.commit()
        statements.clear()

        sender_status = service.get_request_status(
            db,
            from_user_id=101,
            request_id=" intent-1 ",
        )
        recipient_status = service.get_request_status(
            db,
            from_user_id=202,
            request_id="intent-1",
        )
        unrelated_status = service.get_request_status(
            db,
            from_user_id=303,
            request_id="intent-1",
        )

        sender_payload = sender_status.model_dump()
        assert sender_payload["state"] == "COMPLETED"
        assert sender_payload["request_id"] == "intent-1"
        assert sender_payload["record"]["direction"] == "out"
        assert {
            "sender_available_before",
            "sender_available_after",
            "receiver_available_before",
            "receiver_available_after",
        }.isdisjoint(sender_payload["record"])
        assert recipient_status.model_dump() == {
            "request_id": "intent-1",
            "state": "NOT_FOUND",
            "record": None,
        }
        assert unrelated_status.state == "NOT_FOUND"
        assert not db.new
        assert not db.dirty
        assert not db.deleted
        assert statements
        assert all(statement.startswith("SELECT") for statement in statements)


def test_request_status_route_sets_no_store_and_returns_explicit_not_found(monkeypatch) -> None:
    from app.routers import user_transfer as router_module

    class State:
        trace_id = "trace-status"

    class Request:
        state = State()

    monkeypatch.setattr(
        router_module.user_transfer_service,
        "get_request_status",
        lambda *_args, **_kwargs: UserTransferRequestStatusData(
            request_id="intent-missing",
            state="NOT_FOUND",
            record=None,
        ),
    )
    response = Response()
    result = router_module.get_user_transfer_request_status(
        Request(),
        response,
        "intent-missing",
        object(),
        101,
    )

    assert response.headers["Cache-Control"] == "no-store"
    assert result["ok"] is True
    assert result["data"] == {
        "request_id": "intent-missing",
        "state": "NOT_FOUND",
        "record": None,
    }


def test_user_transfer_fingerprint_migration_is_isolated_and_round_trips() -> None:
    backend_dir = Path(__file__).resolve().parents[1]
    config = Config(str(backend_dir / "alembic.ini"))
    config.set_main_option("script_location", str(backend_dir / "alembic"))
    script = ScriptDirectory.from_config(config)
    revision = script.get_revision("20260803_000133")

    assert script.get_heads() == ["20260824_000136"]
    assert revision is not None
    assert revision.down_revision == "20260728_000126"
    merge_revision = script.get_revision("20260803_000134")
    assert merge_revision is not None
    assert set(merge_revision.down_revision) == {
        "20260802_000132",
        "20260803_000133",
    }

    engine = create_engine("sqlite://")
    with engine.begin() as connection:
        connection.execute(text("CREATE TABLE user_transfers (id INTEGER PRIMARY KEY)"))
        operations = Operations(MigrationContext.configure(connection))
        original_op = revision.module.op
        revision.module.op = operations
        try:
            revision.module.upgrade()
            assert "request_fingerprint" in {
                column["name"] for column in inspect(connection).get_columns("user_transfers")
            }
            revision.module.downgrade()
            assert "request_fingerprint" not in {
                column["name"] for column in inspect(connection).get_columns("user_transfers")
            }
        finally:
            revision.module.op = original_op
