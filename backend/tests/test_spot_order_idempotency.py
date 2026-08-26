from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from fastapi.encoders import jsonable_encoder
from pydantic import ValidationError

from app.routers import order as order_router
from app.schemas.order import CreateOrderRequest, CreateOrderResponse
from app.services.trade_idempotency_service import (
    TradeIdempotencyClaim,
    TradeIdempotencyConflict,
    TradeIdempotencyUnavailable,
    TradeIdempotencyStatus,
)


class FakeDb:
    def __init__(self, events: list[str] | None = None):
        self.events = events if events is not None else []
        self.commit_count = 0
        self.rollback_count = 0

    def commit(self) -> None:
        self.commit_count += 1
        self.events.append("commit")

    def rollback(self) -> None:
        self.rollback_count += 1
        self.events.append("rollback")


def _request(client_order_id: str | None = None, *, amount: str = "1"):
    return CreateOrderRequest(
        symbol="BTCUSDT",
        side="BUY",
        order_type="LIMIT",
        price=Decimal("63000"),
        amount=Decimal(amount),
        client_order_id=client_order_id,
    )


def _order(order_id: int = 41):
    return SimpleNamespace(
        id=order_id,
        order_no=f"ORD-{order_id}",
        side="BUY",
        order_type="LIMIT",
        price=Decimal("63000"),
        amount=Decimal("1"),
        filled_amount=Decimal("0"),
        frozen_amount=Decimal("63000"),
        status="OPEN",
        created_at=datetime(2026, 8, 1, 1, 2, 3),
        _extra_private_updates=[],
    )


def _replay_payload(order_id: int, client_order_id: str):
    return {
        "id": order_id,
        "order_no": f"ORD-{order_id}",
        "symbol": "BTCUSDT",
        "side": "BUY",
        "order_type": "LIMIT",
        "price": "63000",
        "amount": "1",
        "filled_amount": "0",
        "frozen_amount": "63000",
        "status": "OPEN",
        "created_at": "2026-08-01T01:02:03",
        "client_order_id": client_order_id,
    }


def _disable_real_broadcasts(monkeypatch, events: list[str]) -> None:
    monkeypatch.setattr(
        order_router,
        "serialize_spot_order",
        lambda order, symbol: {"symbol": symbol},
    )

    def close_and_record(coro, label: str) -> None:
        close = getattr(coro, "close", None)
        if callable(close):
            close()
        events.append(f"private:{label}")

    monkeypatch.setattr(order_router, "_fire_and_forget", close_and_record)
    monkeypatch.setattr(
        order_router,
        "_broadcast_spot_balance_update",
        lambda user_id: events.append(f"balance:{user_id}"),
    )
    monkeypatch.setattr(
        order_router,
        "_broadcast_public_orderbook",
        lambda symbol: events.append(f"public:{symbol}"),
    )


def test_client_order_id_is_optional_normalized_and_whitelisted():
    assert _request().client_order_id is None
    assert _request("  MOB:Spot_ABC-1  ").client_order_id == "mob:spot_abc-1"

    for invalid in ("", " ", "abc def", "abc!", "中文", "a" * 65):
        with pytest.raises(ValidationError):
            _request(invalid)


def test_idempotency_fingerprint_uses_only_executable_order_fields():
    limit = CreateOrderRequest(
        symbol="BTCUSDT",
        side="BUY",
        order_type="LIMIT",
        price=Decimal("63000"),
        amount=Decimal("1"),
        quote_amount=Decimal("999"),
        client_order_id="mob:spot-limit",
    )
    market_buy = CreateOrderRequest(
        symbol="BTCUSDT",
        side="BUY",
        order_type="MARKET",
        price=Decimal("1"),
        amount=Decimal("2"),
        quote_amount=Decimal("100"),
        client_order_id="mob:spot-market",
    )

    assert order_router._spot_idempotency_request_payload(limit) == {
        "symbol": "BTCUSDT",
        "side": "BUY",
        "order_type": "LIMIT",
        "price": Decimal("63000"),
        "amount": Decimal("1"),
    }
    assert order_router._spot_idempotency_request_payload(market_buy) == {
        "symbol": "BTCUSDT",
        "side": "BUY",
        "order_type": "MARKET",
        "quote_amount": Decimal("100"),
    }


def test_legacy_response_omits_only_client_order_id_and_keeps_null_price():
    response = CreateOrderResponse(
        id=1,
        order_no="ORD-1",
        symbol="BTCUSDT",
        side="BUY",
        order_type="MARKET",
        price=None,
        amount=Decimal("0.1"),
        filled_amount=Decimal("0.1"),
        frozen_amount=Decimal("0"),
        status="FILLED",
        created_at=datetime(2026, 8, 1, 1, 2, 3),
    )

    payload = jsonable_encoder(response)
    assert "client_order_id" not in payload
    assert "price" in payload
    assert payload["price"] is None


def test_pc_request_keeps_legacy_path_and_broadcasts_once(monkeypatch):
    events: list[str] = []
    db = FakeDb(events)
    create_count = 0

    def create_order(**kwargs):
        nonlocal create_count
        create_count += 1
        events.append("create")
        return _order()

    monkeypatch.setattr(order_router, "create_order", create_order)
    monkeypatch.setattr(
        order_router,
        "lock_trade_idempotency_owner",
        lambda *args, **kwargs: pytest.fail("legacy request must not take idempotency lock"),
    )
    monkeypatch.setattr(
        order_router,
        "lookup_trade_idempotency",
        lambda *args, **kwargs: pytest.fail("legacy request must not lookup idempotency"),
    )
    monkeypatch.setattr(
        order_router,
        "claim_trade_idempotency",
        lambda *args, **kwargs: pytest.fail("legacy request must not claim idempotency"),
    )
    _disable_real_broadcasts(monkeypatch, events)

    response = order_router.create_order_api(
        request=None,
        payload=_request(),
        user_id="7",
        db=db,
    )

    assert create_count == 1
    assert db.commit_count == 1
    assert db.rollback_count == 0
    assert response.model_dump(mode="json").get("client_order_id") is None
    assert "client_order_id" not in response.model_dump(mode="json")
    assert events.count("balance:7") == 1
    assert events.count("public:BTCUSDT") == 1
    assert sum(item.startswith("private:") for item in events) == 1


def test_same_key_replays_without_second_commit_or_broadcast(monkeypatch):
    events: list[str] = []
    db = FakeDb(events)
    stored_response: dict | None = None
    create_count = 0
    complete_count = 0
    claim_record = object()

    def lock_owner(db, *, user_id):
        events.append(f"lock:{user_id}")

    def lookup(db, **kwargs):
        events.append("lookup")
        if stored_response is None:
            return None
        return TradeIdempotencyClaim(
            client_order_id=kwargs["client_order_id"],
            record=None,
            replay_payload=dict(stored_response),
        )

    def create_order(**kwargs):
        nonlocal create_count
        create_count += 1
        events.append("create")
        return _order()

    def claim(db, **kwargs):
        events.append("claim")
        assert "client_order_id" not in kwargs["request_payload"]
        assert kwargs["request_payload"]["symbol"] == "BTCUSDT"
        assert kwargs["request_payload"]["amount"] == Decimal("1")
        return TradeIdempotencyClaim(
            client_order_id=kwargs["client_order_id"],
            record=claim_record,
            replay_payload=None,
        )

    def complete(db, claim, response_payload):
        nonlocal complete_count, stored_response
        complete_count += 1
        events.append("complete")
        stored_response = dict(response_payload)

    monkeypatch.setattr(order_router, "lock_trade_idempotency_owner", lock_owner)
    monkeypatch.setattr(order_router, "lookup_trade_idempotency", lookup)
    monkeypatch.setattr(order_router, "create_order", create_order)
    monkeypatch.setattr(order_router, "claim_trade_idempotency", claim)
    monkeypatch.setattr(order_router, "complete_trade_idempotency", complete)
    _disable_real_broadcasts(monkeypatch, events)

    first = order_router.create_order_api(
        request=None,
        payload=_request(" MOB:SPOT-7 "),
        user_id="7",
        db=db,
    )
    second = order_router.create_order_api(
        request=None,
        payload=_request("mob:spot-7"),
        user_id="7",
        db=db,
    )

    assert first.id == second.id == 41
    assert first.client_order_id == second.client_order_id == "mob:spot-7"
    assert create_count == 1
    assert complete_count == 1
    assert db.commit_count == 1
    assert db.rollback_count == 1
    assert events.index("lock:7") < events.index("lookup") < events.index("create")
    assert events.index("create") < events.index("claim") < events.index("complete") < events.index("commit")
    assert events.count("balance:7") == 1
    assert events.count("public:BTCUSDT") == 1
    assert sum(item.startswith("private:") for item in events) == 1


@pytest.mark.parametrize(
    ("error", "expected_status", "expected_code"),
    [
        (
            TradeIdempotencyConflict("different payload"),
            409,
            "IDEMPOTENCY_KEY_REUSED",
        ),
        (
            TradeIdempotencyUnavailable("result unavailable"),
            503,
            "IDEMPOTENCY_RESULT_UNAVAILABLE",
        ),
    ],
)
def test_idempotency_errors_release_lock_and_map_to_stable_http_status(
    monkeypatch,
    error,
    expected_status,
    expected_code,
):
    db = FakeDb()
    monkeypatch.setattr(
        order_router,
        "lock_trade_idempotency_owner",
        lambda *args, **kwargs: None,
    )
    monkeypatch.setattr(
        order_router,
        "lookup_trade_idempotency",
        lambda *args, **kwargs: (_ for _ in ()).throw(error),
    )
    monkeypatch.setattr(
        order_router,
        "create_order",
        lambda **kwargs: pytest.fail("conflicted request must not execute an order"),
    )

    with pytest.raises(HTTPException) as captured:
        order_router.create_order_api(
            request=None,
            payload=_request("mob:spot-conflict"),
            user_id="7",
            db=db,
        )

    assert captured.value.status_code == expected_status
    assert captured.value.detail["code"] == expected_code
    assert db.commit_count == 0
    assert db.rollback_count == 1


def test_late_claim_race_rolls_back_new_order_and_replays_without_broadcast(
    monkeypatch,
):
    events: list[str] = []
    db = FakeDb(events)
    old_payload = _replay_payload(19, "mob:spot-race")

    monkeypatch.setattr(
        order_router,
        "lock_trade_idempotency_owner",
        lambda *args, **kwargs: events.append("lock"),
    )
    monkeypatch.setattr(
        order_router,
        "lookup_trade_idempotency",
        lambda *args, **kwargs: None,
    )
    monkeypatch.setattr(order_router, "create_order", lambda **kwargs: _order(99))
    monkeypatch.setattr(
        order_router,
        "claim_trade_idempotency",
        lambda *args, **kwargs: TradeIdempotencyClaim(
            client_order_id="mob:spot-race",
            record=None,
            replay_payload=old_payload,
        ),
    )
    monkeypatch.setattr(
        order_router,
        "complete_trade_idempotency",
        lambda *args, **kwargs: pytest.fail("replay claim must not be completed"),
    )
    _disable_real_broadcasts(monkeypatch, events)

    response = order_router.create_order_api(
        request=None,
        payload=_request("mob:spot-race"),
        user_id="7",
        db=db,
    )

    assert response.id == 19
    assert db.rollback_count == 1
    assert db.commit_count == 0
    assert not any(item.startswith("private:") for item in events)
    assert not any(item.startswith("balance:") for item in events)
    assert not any(item.startswith("public:") for item in events)


def test_corrupt_replay_payload_fails_closed_without_broadcast(monkeypatch):
    events: list[str] = []
    db = FakeDb(events)
    monkeypatch.setattr(
        order_router,
        "lock_trade_idempotency_owner",
        lambda *args, **kwargs: None,
    )
    monkeypatch.setattr(
        order_router,
        "lookup_trade_idempotency",
        lambda *args, **kwargs: TradeIdempotencyClaim(
            client_order_id="mob:spot-corrupt",
            record=None,
            replay_payload={"id": 1},
        ),
    )
    _disable_real_broadcasts(monkeypatch, events)

    with pytest.raises(HTTPException) as captured:
        order_router.create_order_api(
            request=None,
            payload=_request("mob:spot-corrupt"),
            user_id="7",
            db=db,
        )

    assert captured.value.status_code == 503
    assert captured.value.detail["code"] == "IDEMPOTENCY_RESULT_UNAVAILABLE"
    assert db.rollback_count == 1
    assert db.commit_count == 0
    assert not any(item.startswith(("private:", "balance:", "public:")) for item in events)


def test_spot_status_endpoint_returns_only_validated_completed_result(monkeypatch):
    monkeypatch.setattr(
        order_router,
        "get_trade_idempotency_status",
        lambda *args, **kwargs: TradeIdempotencyStatus(
            market="SPOT",
            client_order_id="mob-spot-status-1",
            status="COMPLETED",
            operation="SPOT_CREATE",
            response_payload=_replay_payload(77, "mob-spot-status-1"),
            created_at=datetime(2026, 8, 2, 1, 2, 3),
            completed_at=datetime(2026, 8, 2, 1, 2, 4),
        ),
    )

    response = order_router.get_spot_idempotency_result(
        "MOB-SPOT-STATUS-1",
        user_id="7",
        db=FakeDb(),
    )

    assert response.status == "COMPLETED"
    assert response.market == "SPOT"
    assert response.operation == "SPOT_CREATE"
    assert response.result["id"] == 77
    assert response.result["client_order_id"] == "mob-spot-status-1"


def test_spot_status_endpoint_rejects_corrupt_completed_payload(monkeypatch):
    monkeypatch.setattr(
        order_router,
        "get_trade_idempotency_status",
        lambda *args, **kwargs: TradeIdempotencyStatus(
            market="SPOT",
            client_order_id="mob-spot-invalid-1",
            status="COMPLETED",
            operation="SPOT_CREATE",
            response_payload={"client_order_id": "mob-spot-invalid-1"},
            created_at=None,
            completed_at=None,
        ),
    )

    with pytest.raises(HTTPException) as captured:
        order_router.get_spot_idempotency_result(
            "mob-spot-invalid-1",
            user_id="7",
            db=FakeDb(),
        )

    assert captured.value.status_code == 503
    assert captured.value.detail["code"] == "IDEMPOTENCY_RESULT_UNAVAILABLE"
