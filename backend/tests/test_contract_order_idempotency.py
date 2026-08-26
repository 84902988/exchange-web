from __future__ import annotations

from decimal import Decimal
from types import SimpleNamespace

import pytest
from fastapi import BackgroundTasks, HTTPException
from pydantic import ValidationError
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from starlette.requests import Request

from app.db.models.trade_idempotency_request import TradeIdempotencyRequest
from app.routers import contract_order as router
from app.schemas.contract_order import (
    ContractCloseSummaryOrderRequest,
    ContractCloseSummaryOrderResponse,
    ContractOpenOrderRequest,
    ContractOrderResponse,
)
from app.services import contract_order_service as service
from app.services.trade_idempotency_service import canonical_request_hash


class CountingSession(Session):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.commit_calls = 0
        self.rollback_calls = 0

    def commit(self) -> None:
        self.commit_calls += 1
        super().commit()

    def rollback(self) -> None:
        self.rollback_calls += 1
        super().rollback()


@pytest.fixture()
def db():
    engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
    TradeIdempotencyRequest.__table__.create(engine)
    session = CountingSession(bind=engine)
    try:
        yield session
    finally:
        session.close()
        engine.dispose()


def _request(path: str) -> Request:
    request = Request({"type": "http", "method": "POST", "path": path})
    request.state.trace_id = "contract-idempotency-test"
    return request


def _open_response(client_order_id: str) -> ContractOrderResponse:
    return ContractOrderResponse(
        order_id=101,
        order_no="CO-101",
        symbol="BTCUSDT_PERP",
        position_side="LONG",
        order_type="MARKET",
        price=None,
        quantity="1",
        leverage=10,
        margin_amount="10",
        fee_amount="0",
        spread_fee="0",
        status="FILLED",
        avg_price="100",
        position_id=201,
        client_order_id=client_order_id,
    )


def _summary_response(client_order_id: str) -> ContractCloseSummaryOrderResponse:
    return ContractCloseSummaryOrderResponse(
        symbol="BTCUSDT_PERP",
        side="LONG",
        order_type="MARKET",
        price=None,
        requested_quantity="3",
        closed_quantity="3",
        submitted_quantity="3",
        generated_order_ids=[301, 302],
        generated_trade_ids=[401, 402],
        affected_position_ids=[501, 502],
        status="FILLED",
        client_order_id=client_order_id,
    )


def test_client_order_id_is_trimmed_lowered_and_restricted():
    payload = ContractOpenOrderRequest(
        symbol="BTCUSDT_PERP",
        position_side="LONG",
        order_type="MARKET",
        quantity="1",
        leverage=10,
        client_order_id="  MOB.Contract-ABC:1  ",
    )
    assert payload.client_order_id == "mob.contract-abc:1"

    with pytest.raises(ValidationError):
        ContractOpenOrderRequest(
            symbol="BTCUSDT_PERP",
            position_side="LONG",
            order_type="MARKET",
            quantity="1",
            leverage=10,
            client_order_id="bad/client/id",
        )

    with pytest.raises(ValidationError):
        ContractCloseSummaryOrderRequest(
            symbol="BTCUSDT_PERP",
            side="LONG",
            order_type="MARKET",
            client_order_id="x" * 65,
        )


def test_open_keyed_request_commits_and_publishes_once_then_replays(
    db: CountingSession,
    monkeypatch,
):
    service_calls: list[bool] = []
    publish_calls: list[dict] = []
    quote_prepare_calls: list[str] = []

    def fake_create(_db, user_id, payload, *, commit=True, quote_override=None):
        assert _db is db
        assert user_id == 7
        assert quote_override == {"source": "prepared-open"}
        service_calls.append(commit)
        return _open_response(payload.client_order_id)

    def fake_prepare_open(*_args):
        assert db.rollback_calls == 1
        quote_prepare_calls.append("open")
        return {"source": "prepared-open"}

    monkeypatch.setattr(router, "create_contract_open_order", fake_create)
    monkeypatch.setattr(
        router,
        "prepare_contract_open_order_quote",
        fake_prepare_open,
    )
    monkeypatch.setattr(
        router,
        "_publish_order_result",
        lambda _tasks, **kwargs: publish_calls.append(kwargs),
    )
    payload = ContractOpenOrderRequest(
        symbol="BTCUSDT_PERP",
        position_side="LONG",
        order_type="MARKET",
        quantity="1.0",
        leverage=10,
        client_order_id="MOB-CONTRACT-OPEN-1",
    )

    first = router.contract_open_order(
        _request("/contract/orders/open"),
        payload,
        BackgroundTasks(),
        db,
        7,
    )
    second = router.contract_open_order(
        _request("/contract/orders/open"),
        payload,
        BackgroundTasks(),
        db,
        7,
    )

    assert first["data"] == second["data"]
    assert first["data"]["client_order_id"] == "mob-contract-open-1"
    assert service_calls == [False]
    assert quote_prepare_calls == ["open"]
    assert db.commit_calls == 1
    assert db.rollback_calls == 2
    assert len(publish_calls) == 1
    stored = db.query(TradeIdempotencyRequest).one()
    assert stored.status == "COMPLETED"

    conflicting = payload.model_copy(update={"quantity": Decimal("2")})
    with pytest.raises(HTTPException) as exc_info:
        router.contract_open_order(
            _request("/contract/orders/open"),
            conflicting,
            BackgroundTasks(),
            db,
            7,
        )
    assert exc_info.value.status_code == 409
    assert exc_info.value.detail["code"] == "IDEMPOTENCY_KEY_REUSED"
    assert service_calls == [False]
    assert db.commit_calls == 1
    assert len(publish_calls) == 1


def test_close_summary_all_quantity_replays_as_one_group_and_conflicts_with_exact(
    db: CountingSession,
    monkeypatch,
):
    service_calls: list[bool] = []
    publish_calls: list[dict] = []
    quote_prepare_calls: list[str] = []

    def fake_close(_db, user_id, payload, *, commit=True, quote_override=None):
        assert _db is db
        assert user_id == 8
        assert quote_override == {"source": "prepared-close"}
        service_calls.append(commit)
        return _summary_response(payload.client_order_id)

    def fake_prepare_close(*_args):
        assert db.rollback_calls == 1
        quote_prepare_calls.append("close")
        return {"source": "prepared-close"}

    monkeypatch.setattr(router, "close_contract_position_summary", fake_close)
    monkeypatch.setattr(
        router,
        "prepare_contract_close_summary_order_quote",
        fake_prepare_close,
    )
    monkeypatch.setattr(
        router,
        "_publish_order_result",
        lambda _tasks, **kwargs: publish_calls.append(kwargs),
    )
    payload = ContractCloseSummaryOrderRequest(
        symbol="BTCUSDT_PERP",
        side="LONG",
        order_type="MARKET",
        price=None,
        quantity=None,
        client_order_id="MOB-CONTRACT-CLOSE-ALL-1",
    )

    first = router.contract_close_summary_order(
        _request("/contract/orders/close-summary"),
        payload,
        BackgroundTasks(),
        db,
        8,
    )
    second = router.contract_close_summary_order(
        _request("/contract/orders/close-summary"),
        payload,
        BackgroundTasks(),
        db,
        8,
    )

    assert first["data"] == second["data"]
    assert first["data"]["price"] is None
    assert service_calls == [False]
    assert quote_prepare_calls == ["close"]
    assert db.commit_calls == 1
    assert db.rollback_calls == 2
    assert len(publish_calls) == 1

    exact_quantity = payload.model_copy(update={"quantity": Decimal("3")})
    with pytest.raises(HTTPException) as exc_info:
        router.contract_close_summary_order(
            _request("/contract/orders/close-summary"),
            exact_quantity,
            BackgroundTasks(),
            db,
            8,
        )
    assert exc_info.value.status_code == 409
    assert exc_info.value.detail["code"] == "IDEMPOTENCY_KEY_REUSED"
    assert service_calls == [False]
    assert db.commit_calls == 1
    assert len(publish_calls) == 1


def test_committed_pending_key_returns_503_without_business_execution(
    db: CountingSession,
    monkeypatch,
):
    payload = ContractOpenOrderRequest(
        symbol="BTCUSDT_PERP",
        position_side="LONG",
        order_type="MARKET",
        quantity="1",
        leverage=10,
        client_order_id="mob-contract-pending-1",
    )
    db.add(
        TradeIdempotencyRequest(
            user_id=9,
            market="CONTRACT",
            operation="CONTRACT_OPEN",
            client_order_id=payload.client_order_id,
            fingerprint_version=1,
            request_hash=canonical_request_hash(
                service.contract_open_idempotency_payload(payload)
            ),
            status="PENDING",
            response_json=None,
        )
    )
    db.commit()
    baseline_commits = db.commit_calls
    monkeypatch.setattr(
        router,
        "create_contract_open_order",
        lambda *_args, **_kwargs: pytest.fail("business service must not execute"),
    )
    monkeypatch.setattr(
        router,
        "prepare_contract_open_order_quote",
        lambda *_args: pytest.fail("pending replay must not load a live quote"),
    )
    monkeypatch.setattr(
        router,
        "_publish_order_result",
        lambda *_args, **_kwargs: pytest.fail("pending replay must not publish"),
    )

    with pytest.raises(HTTPException) as exc_info:
        router.contract_open_order(
            _request("/contract/orders/open"),
            payload,
            BackgroundTasks(),
            db,
            9,
        )
    assert exc_info.value.status_code == 503
    assert exc_info.value.detail["code"] == "IDEMPOTENCY_RESULT_UNAVAILABLE"
    assert db.commit_calls == baseline_commits


def test_invalid_stored_open_response_returns_503_without_quote_or_publish(
    db: CountingSession,
    monkeypatch,
):
    payload = ContractOpenOrderRequest(
        symbol="BTCUSDT_PERP",
        position_side="LONG",
        order_type="MARKET",
        quantity="1",
        leverage=10,
        client_order_id="mob-contract-invalid-replay-1",
    )
    db.add(
        TradeIdempotencyRequest(
            user_id=9,
            market="CONTRACT",
            operation="CONTRACT_OPEN",
            client_order_id=payload.client_order_id,
            fingerprint_version=1,
            request_hash=canonical_request_hash(
                service.contract_open_idempotency_payload(payload)
            ),
            status="COMPLETED",
            response_json="{}",
        )
    )
    db.commit()
    monkeypatch.setattr(
        router,
        "prepare_contract_open_order_quote",
        lambda *_args: pytest.fail("completed replay must not load a live quote"),
    )
    monkeypatch.setattr(
        router,
        "create_contract_open_order",
        lambda *_args, **_kwargs: pytest.fail("invalid replay must not execute business service"),
    )
    monkeypatch.setattr(
        router,
        "_publish_order_result",
        lambda *_args, **_kwargs: pytest.fail("invalid replay must not publish"),
    )

    with pytest.raises(HTTPException) as exc_info:
        router.contract_open_order(
            _request("/contract/orders/open"),
            payload,
            BackgroundTasks(),
            db,
            9,
        )

    assert exc_info.value.status_code == 503
    assert exc_info.value.detail["code"] == "IDEMPOTENCY_RESULT_UNAVAILABLE"


def test_open_failure_rolls_back_claim_and_retry_can_execute(
    db: CountingSession,
    monkeypatch,
):
    should_fail = True
    publish_calls: list[dict] = []
    service_calls = 0

    def fake_create(_db, _user_id, payload, *, commit=True, quote_override=None):
        nonlocal service_calls
        service_calls += 1
        assert commit is False
        assert quote_override == {"source": "prepared-open"}
        if should_fail:
            raise service.ContractOrderBadRequest("forced failure")
        return _open_response(payload.client_order_id)

    monkeypatch.setattr(router, "create_contract_open_order", fake_create)
    monkeypatch.setattr(
        router,
        "prepare_contract_open_order_quote",
        lambda *_args: {"source": "prepared-open"},
    )
    monkeypatch.setattr(
        router,
        "_publish_order_result",
        lambda _tasks, **kwargs: publish_calls.append(kwargs),
    )
    payload = ContractOpenOrderRequest(
        symbol="BTCUSDT_PERP",
        position_side="LONG",
        order_type="MARKET",
        quantity="1",
        leverage=10,
        client_order_id="mob-contract-retry-1",
    )

    with pytest.raises(HTTPException) as exc_info:
        router.contract_open_order(
            _request("/contract/orders/open"),
            payload,
            BackgroundTasks(),
            db,
            12,
        )
    assert exc_info.value.status_code == 400
    assert db.query(TradeIdempotencyRequest).count() == 0
    assert db.commit_calls == 0
    assert publish_calls == []

    should_fail = False
    result = router.contract_open_order(
        _request("/contract/orders/open"),
        payload,
        BackgroundTasks(),
        db,
        12,
    )

    assert result["data"]["client_order_id"] == "mob-contract-retry-1"
    assert service_calls == 2
    assert db.commit_calls == 1
    assert len(publish_calls) == 1
    assert db.query(TradeIdempotencyRequest).one().status == "COMPLETED"


def test_non_keyed_open_preserves_legacy_service_commit_and_response_shape(
    db: CountingSession,
    monkeypatch,
):
    commit_modes: list[bool] = []

    def fake_create(_db, _user_id, _payload, *, commit=True):
        commit_modes.append(commit)
        return _open_response(client_order_id=None)

    monkeypatch.setattr(router, "create_contract_open_order", fake_create)
    monkeypatch.setattr(router, "_publish_order_result", lambda *_args, **_kwargs: None)
    payload = ContractOpenOrderRequest(
        symbol="BTCUSDT_PERP",
        position_side="LONG",
        order_type="MARKET",
        quantity="1",
        leverage=10,
    )

    result = router.contract_open_order(
        _request("/contract/orders/open"),
        payload,
        BackgroundTasks(),
        db,
        10,
    )

    assert commit_modes == [True]
    assert "client_order_id" not in result["data"]
    assert db.query(TradeIdempotencyRequest).count() == 0


def test_non_keyed_close_summary_preserves_legacy_router_service_path(
    db: CountingSession,
    monkeypatch,
):
    commit_modes: list[tuple[bool, object]] = []

    def fake_close(
        _db,
        _user_id,
        payload,
        *,
        commit=True,
        quote_override=None,
    ):
        commit_modes.append((commit, quote_override))
        return ContractCloseSummaryOrderResponse(
            symbol=payload.symbol,
            side=payload.side,
            order_type=payload.order_type,
            price="101.25",
            requested_quantity="3",
            closed_quantity="0",
            submitted_quantity="3",
            generated_order_ids=[301, 302],
            generated_trade_ids=[],
            affected_position_ids=[501, 502],
            status="OPEN",
        )

    monkeypatch.setattr(router, "close_contract_position_summary", fake_close)
    monkeypatch.setattr(
        router,
        "prepare_contract_close_summary_order_quote",
        lambda *_args: pytest.fail("non-keyed close-summary must not pre-load a router quote"),
    )
    monkeypatch.setattr(router, "_publish_order_result", lambda *_args, **_kwargs: None)
    payload = ContractCloseSummaryOrderRequest(
        symbol="BTCUSDT_PERP",
        side="LONG",
        order_type="LIMIT",
        price="101.25",
        quantity=None,
    )

    result = router.contract_close_summary_order(
        _request("/contract/orders/close-summary"),
        payload,
        BackgroundTasks(),
        db,
        10,
    )

    assert commit_modes == [(True, None)]
    assert result["data"]["price"] == "101.25"
    assert "client_order_id" not in result["data"]
    assert db.query(TradeIdempotencyRequest).count() == 0


def test_close_summary_commit_false_builds_limit_price_response_before_commit(
    monkeypatch,
):
    positions = [
        SimpleNamespace(id=501, quantity=Decimal("1")),
        SimpleNamespace(id=502, quantity=Decimal("2")),
    ]

    class Query:
        def filter(self, *_args):
            return self

        def order_by(self, *_args):
            return self

        def with_for_update(self):
            return self

        def all(self):
            return positions

    class FakeDb:
        def __init__(self):
            self.commit_calls = 0
            self.flush_calls = 0
            self.rollback_calls = 0

        def query(self, *_args):
            return Query()

        def commit(self):
            self.commit_calls += 1

        def flush(self):
            self.flush_calls += 1

        def rollback(self):
            self.rollback_calls += 1

    db = FakeDb()
    generated = iter([301, 302])

    monkeypatch.setattr(service, "_load_enabled_contract_symbol", lambda *_args: object())

    def fake_close(_db, _user_id, request, *, commit=True, quote_override=None):
        assert commit is False
        assert quote_override is None
        return ContractOrderResponse(
            order_id=next(generated),
            order_no=f"CO-{request.position_id}",
            symbol="BTCUSDT_PERP",
            position_side="LONG",
            order_type="LIMIT",
            price=str(request.price),
            quantity=str(request.quantity),
            leverage=10,
            margin_amount="1",
            fee_amount="0",
            spread_fee="0",
            status="OPEN",
            avg_price="0",
            position_id=request.position_id,
        )

    monkeypatch.setattr(service, "close_contract_position", fake_close)
    payload = ContractCloseSummaryOrderRequest(
        symbol="BTCUSDT_PERP",
        side="LONG",
        order_type="LIMIT",
        price="101.2500",
        quantity=None,
        client_order_id="MOB-CONTRACT-LIMIT-CLOSE-1",
    )

    result = service.close_contract_position_summary(
        db,
        11,
        payload,
        commit=False,
    )

    assert result.price == "101.2500"
    assert result.client_order_id == "mob-contract-limit-close-1"
    assert result.requested_quantity == "3"
    assert result.submitted_quantity == "3"
    assert result.closed_quantity == "0"
    assert result.generated_order_ids == [301, 302]
    assert result.affected_position_ids == [501, 502]
    assert result.status == "OPEN"
    assert db.commit_calls == 0
    assert db.flush_calls == 1
    assert db.rollback_calls == 0


def test_contract_status_endpoint_returns_validated_completed_result(
    db: CountingSession,
):
    client_order_id = "mob-contract-status-1"
    response = _open_response(client_order_id)
    db.add(
        TradeIdempotencyRequest(
            user_id=21,
            market="CONTRACT",
            operation="CONTRACT_OPEN",
            client_order_id=client_order_id,
            fingerprint_version=1,
            request_hash=canonical_request_hash({"symbol": "BTCUSDT_PERP"}),
            status="COMPLETED",
            response_json=response.model_dump_json(),
        )
    )
    db.commit()

    result = router.get_contract_idempotency_result(
        client_order_id,
        _request(f"/contract/orders/idempotency/{client_order_id}"),
        db,
        21,
    )

    assert result["data"]["status"] == "COMPLETED"
    assert result["data"]["operation"] == "CONTRACT_OPEN"
    assert result["data"]["result"]["order_id"] == 101
    assert result["data"]["result"]["client_order_id"] == client_order_id


def test_contract_status_endpoint_keeps_missing_result_non_authoritative(
    db: CountingSession,
):
    result = router.get_contract_idempotency_result(
        "mob-contract-missing-1",
        _request("/contract/orders/idempotency/mob-contract-missing-1"),
        db,
        21,
    )

    assert result["data"] == {
        "market": "CONTRACT",
        "client_order_id": "mob-contract-missing-1",
        "status": "NOT_FOUND",
        "operation": None,
        "result": None,
        "created_at": None,
        "completed_at": None,
    }
