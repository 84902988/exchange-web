from __future__ import annotations

from decimal import Decimal

from app.services import contract_order_service as service


def _execution_view(**overrides):
    payload = {
        "symbol": "BTCUSDT_PERP",
        "executable": True,
        "execution_bid": "100",
        "execution_ask": "102",
        "display_price": "999",
        "display_state": "LIVE_TRADABLE",
        "execution_mode": "LIVE_BBO",
        "reason_code": "LIVE_BBO",
        "warnings": [],
        "raw_source_summary": {
            "market_status": "OPEN",
            "quote_freshness": "LIVE",
            "market_session_type": "REGULAR",
        },
        "spread_x": "0.4",
        "manual_spread_x": "0",
        "effective_total_spread": "0.4",
        "single_side_spread_fee_price": "0.2",
    }
    payload.update(overrides)
    return payload


def test_execution_quote_uses_execution_bid_ask_not_display_price():
    quote = service._execution_quote_from_view(_execution_view())

    assert quote["bid_price"] == Decimal("100")
    assert quote["ask_price"] == Decimal("102")
    assert quote["mark_price"] == Decimal("101")
    assert "display_price" not in quote


def test_fill_price_direction_uses_execution_side_contract():
    bid = Decimal("100")
    ask = Decimal("102")

    assert service._limit_fill_price(action="OPEN", position_side="LONG", bid_price=bid, ask_price=ask) == ask
    assert service._limit_fill_price(action="OPEN", position_side="SHORT", bid_price=bid, ask_price=ask) == bid
    assert service._limit_fill_price(action="CLOSE", position_side="LONG", bid_price=bid, ask_price=ask) == bid
    assert service._limit_fill_price(action="CLOSE", position_side="SHORT", bid_price=bid, ask_price=ask) == ask


def test_market_execution_uses_execution_side_contract():
    bid = Decimal("100")
    ask = Decimal("102")

    assert service._decide_open_execution(
        position_side="LONG",
        order_type="MARKET",
        limit_price=None,
        bid_price=bid,
        ask_price=ask,
    ) == (True, ask)
    assert service._decide_open_execution(
        position_side="SHORT",
        order_type="MARKET",
        limit_price=None,
        bid_price=bid,
        ask_price=ask,
    ) == (True, bid)
    assert service._decide_close_execution(
        position_side="LONG",
        order_type="MARKET",
        limit_price=None,
        bid_price=bid,
        ask_price=ask,
    ) == (True, bid)
    assert service._decide_close_execution(
        position_side="SHORT",
        order_type="MARKET",
        limit_price=None,
        bid_price=bid,
        ask_price=ask,
    ) == (True, ask)


def test_limit_trigger_uses_execution_side_contract():
    bid = Decimal("100")
    ask = Decimal("102")

    assert service._is_limit_order_triggered(
        action="OPEN",
        position_side="LONG",
        limit_price=Decimal("102"),
        bid_price=bid,
        ask_price=ask,
    )
    assert service._is_limit_order_triggered(
        action="OPEN",
        position_side="SHORT",
        limit_price=Decimal("100"),
        bid_price=bid,
        ask_price=ask,
    )
    assert service._is_limit_order_triggered(
        action="CLOSE",
        position_side="LONG",
        limit_price=Decimal("100"),
        bid_price=bid,
        ask_price=ask,
    )
    assert service._is_limit_order_triggered(
        action="CLOSE",
        position_side="SHORT",
        limit_price=Decimal("102"),
        bid_price=bid,
        ask_price=ask,
    )


def test_non_executable_view_is_not_executable_quote():
    quote = service._execution_quote_from_view(
        _execution_view(
            executable=False,
            execution_bid=None,
            execution_ask=None,
            display_price="101",
            display_state="EXPIRED",
            execution_mode="DISABLED",
            reason_code="QUOTE_STALE",
        )
    )

    assert service._execution_quote_is_executable(quote) is False


def test_limit_scan_quote_uses_execution_view_helper():
    calls: list[tuple[object, str]] = []
    previous = service.get_contract_execution_view

    def fake_get_contract_execution_view(db, symbol):
        calls.append((db, symbol))
        return _execution_view(execution_bid="88", execution_ask="89", display_price="999")

    service.get_contract_execution_view = fake_get_contract_execution_view
    try:
        quote = service._fresh_execution_quote_for_limit_scan(object(), "BTCUSDT_PERP", order_id=123)
    finally:
        service.get_contract_execution_view = previous

    assert calls and calls[0][1] == "BTCUSDT_PERP"
    assert quote["bid_price"] == Decimal("88")
    assert quote["ask_price"] == Decimal("89")
    assert quote["mark_price"] == Decimal("88.5")
