from __future__ import annotations

import inspect
from decimal import Decimal
from types import SimpleNamespace

from fastapi import HTTPException

from app.services import order_service
from app.services.spot_execution_view import SpotExecutionSnapshot, SpotExecutionUnavailable


class FakeDb:
    pass


def _execution(provider: str = "OKX_SPOT") -> SpotExecutionSnapshot:
    return SpotExecutionSnapshot(
        symbol="BTCUSDT",
        provider=provider,
        provider_symbol="BTC-USDT" if provider == "OKX_SPOT" else "BTCUSDT",
        best_bid=Decimal("100"),
        best_ask=Decimal("101"),
        event_time_ms=1000,
        received_at_ms=1100,
        freshness="LIVE",
        source="LIVE_WS",
        max_age_ms=1500,
        snapshot_id="snapshot",
        provider_generation=1,
    )


def _pair(**overrides):
    values = dict(
        id=1,
        symbol="BTCUSDT",
        data_source="BINANCE",
        market_mode="DEALER",
        amount_precision=4,
        price_precision=2,
    )
    values.update(overrides)
    return SimpleNamespace(**values)


def _order(side: str, price: str, *, amount: str = "2", filled: str = "0"):
    return SimpleNamespace(
        id=7,
        user_id=8,
        side=side,
        price=Decimal(price),
        order_type="LIMIT",
        amount=Decimal(amount),
        filled_amount=Decimal(filled),
    )


def _dealer_snapshot(provider: str = "OKX_SPOT") -> order_service.DealerPriceSnapshot:
    return order_service.DealerPriceSnapshot(
        best_bid=Decimal("100"),
        best_ask=Decimal("101"),
        ref_price=Decimal("100.5"),
        price_source=provider,
    )


def test_crypto_dealer_context_uses_unified_execution_snapshot() -> None:
    original = order_service.get_spot_execution_snapshot
    calls = []
    try:
        order_service.get_spot_execution_snapshot = lambda db, symbol, require_executable: (
            calls.append((db, symbol, require_executable)) or _execution("OKX_SPOT")
        )
        result = order_service._get_dealer_market_context(FakeDb(), _pair(), require_executable=True)
        assert result is not None
        assert result.best_bid == Decimal("100")
        assert result.best_ask == Decimal("101")
        assert result.price_source == "OKX_SPOT"
        assert len(calls) == 1
    finally:
        order_service.get_spot_execution_snapshot = original


def test_market_buy_uses_execution_ask_and_sell_uses_bid() -> None:
    assert order_service._get_dealer_execution_price_for_side(
        "BUY", best_bid=Decimal("100"), best_ask=Decimal("101")
    ) == Decimal("101")
    assert order_service._get_dealer_execution_price_for_side(
        "SELL", best_bid=Decimal("100"), best_ask=Decimal("101")
    ) == Decimal("100")


def test_limit_buy_trigger_and_execution_use_ask() -> None:
    order = _order("BUY", "101")
    assert order_service._should_fill_dealer_limit_order(
        order, best_bid=Decimal("100"), best_ask=Decimal("101")
    )
    assert order_service._get_dealer_execution_price(
        order, best_bid=Decimal("100"), best_ask=Decimal("101")
    ) == Decimal("101")


def test_limit_sell_trigger_and_execution_use_bid() -> None:
    order = _order("SELL", "100")
    assert order_service._should_fill_dealer_limit_order(
        order, best_bid=Decimal("100"), best_ask=Decimal("101")
    )
    assert order_service._get_dealer_execution_price(
        order, best_bid=Decimal("100"), best_ask=Decimal("101")
    ) == Decimal("100")


def test_limit_not_crossed_stays_open_without_fill() -> None:
    original_risk = order_service._check_dealer_execution_risk
    original_fill = order_service._fill_dealer_limit_order
    try:
        order_service._check_dealer_execution_risk = lambda *args, **kwargs: True
        order_service._fill_dealer_limit_order = lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("non-crossing limit must not fill")
        )
        assert not order_service._execute_dealer_limit_order_if_eligible(
            FakeDb(),
            order=_order("BUY", "100"),
            pair=_pair(),
            dealer_snapshot=_dealer_snapshot(),
        )
    finally:
        order_service._check_dealer_execution_risk = original_risk
        order_service._fill_dealer_limit_order = original_fill


def test_limit_fill_helper_uses_remaining_amount_after_partial_fill() -> None:
    original_risk = order_service._check_dealer_execution_risk
    original_fill = order_service._fill_dealer_limit_order
    original_guard = order_service._final_dealer_execution_guard
    captured = {}
    try:
        def risk(*args, **kwargs):
            captured["amount"] = kwargs["amount"]
            return True

        def fill(*args, **kwargs):
            captured["price"] = kwargs["execution_price"]

        order_service._check_dealer_execution_risk = risk
        order_service._fill_dealer_limit_order = fill
        order_service._final_dealer_execution_guard = lambda **kwargs: True
        assert order_service._execute_dealer_limit_order_if_eligible(
            FakeDb(),
            order=_order("BUY", "101", amount="2", filled="0.75"),
            pair=_pair(),
            dealer_snapshot=_dealer_snapshot(),
        )
        assert captured == {"amount": Decimal("1.2500"), "price": Decimal("101")}
    finally:
        order_service._check_dealer_execution_risk = original_risk
        order_service._fill_dealer_limit_order = original_fill
        order_service._final_dealer_execution_guard = original_guard


def test_limit_missing_snapshot_stays_open_without_side_effect() -> None:
    original_risk = order_service._check_dealer_execution_risk
    original_fill = order_service._fill_dealer_limit_order
    try:
        order_service._check_dealer_execution_risk = lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("risk must not run without snapshot")
        )
        order_service._fill_dealer_limit_order = lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("fill must not run without snapshot")
        )
        assert not order_service._execute_dealer_limit_order_if_eligible(
            FakeDb(), order=_order("BUY", "101"), pair=_pair(), dealer_snapshot=None
        )
    finally:
        order_service._check_dealer_execution_risk = original_risk
        order_service._fill_dealer_limit_order = original_fill


def test_limit_snapshot_invalid_before_fill_stays_open() -> None:
    originals = (
        order_service._check_dealer_execution_risk,
        order_service._final_dealer_execution_guard,
        order_service._fill_dealer_limit_order,
    )
    try:
        order_service._check_dealer_execution_risk = lambda *args, **kwargs: True
        order_service._final_dealer_execution_guard = lambda **kwargs: False
        order_service._fill_dealer_limit_order = lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("invalid final snapshot must not fill")
        )
        assert not order_service._execute_dealer_limit_order_if_eligible(
            FakeDb(),
            order=_order("BUY", "101"),
            pair=_pair(),
            dealer_snapshot=_dealer_snapshot(),
        )
    finally:
        (
            order_service._check_dealer_execution_risk,
            order_service._final_dealer_execution_guard,
            order_service._fill_dealer_limit_order,
        ) = originals


def test_required_snapshot_failure_maps_to_503() -> None:
    original = order_service.get_spot_execution_snapshot
    try:
        order_service.get_spot_execution_snapshot = lambda *args, **kwargs: (_ for _ in ()).throw(
            SpotExecutionUnavailable("missing")
        )
        try:
            order_service._get_dealer_market_context(FakeDb(), _pair(), require_executable=True)
        except HTTPException as exc:
            assert exc.status_code == 503
        else:
            raise AssertionError("MARKET execution must fail closed")
    finally:
        order_service.get_spot_execution_snapshot = original


def test_market_final_guard_failure_precedes_balance_or_trade_mutation() -> None:
    pair = _pair(
        status=1,
        base_asset=SimpleNamespace(symbol="BTC", enabled=1),
        quote_asset=SimpleNamespace(symbol="USDT", enabled=1),
        base_asset_id=1,
        quote_asset_id=2,
        min_notional=Decimal("1"),
        min_amount=Decimal("0.0001"),
    )
    payload = SimpleNamespace(
        symbol="BTCUSDT",
        side="BUY",
        order_type="MARKET",
        quote_amount=Decimal("1"),
        amount=None,
    )
    originals = (
        order_service._get_dealer_market_context,
        order_service._check_dealer_execution_risk,
        order_service._final_dealer_execution_guard,
        order_service._get_user_balance_for_update,
        order_service._get_or_create_user_balance_for_update,
    )
    try:
        order_service._get_dealer_market_context = lambda *args, **kwargs: _dealer_snapshot()
        order_service._check_dealer_execution_risk = lambda *args, **kwargs: True
        order_service._final_dealer_execution_guard = lambda **kwargs: (_ for _ in ()).throw(
            HTTPException(status_code=503, detail="dealer market price unavailable")
        )
        order_service._get_user_balance_for_update = lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("balance lookup/mutation must not start after guard rejection")
        )
        order_service._get_or_create_user_balance_for_update = lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("balance creation/mutation must not start after guard rejection")
        )
        try:
            order_service._create_dealer_market_order(
                FakeDb(),
                user_id=1,
                payload=payload,
                pair=pair,
            )
        except HTTPException as exc:
            assert exc.status_code == 503
        else:
            raise AssertionError("MARKET must reject a retired snapshot")
    finally:
        (
            order_service._get_dealer_market_context,
            order_service._check_dealer_execution_risk,
            order_service._final_dealer_execution_guard,
            order_service._get_user_balance_for_update,
            order_service._get_or_create_user_balance_for_update,
        ) = originals


def test_shared_loop_snapshot_is_guarded_again_for_each_order() -> None:
    originals = (
        order_service._check_dealer_execution_risk,
        order_service._final_dealer_execution_guard,
        order_service._fill_dealer_limit_order,
    )
    guard_results = iter((True, False))
    filled = []
    try:
        order_service._check_dealer_execution_risk = lambda *args, **kwargs: True
        order_service._final_dealer_execution_guard = lambda **kwargs: next(guard_results)
        order_service._fill_dealer_limit_order = lambda *args, **kwargs: filled.append(kwargs["order"].id)
        snapshot = _dealer_snapshot()
        first = _order("BUY", "101")
        first.id = 1
        second = _order("BUY", "101")
        second.id = 2
        assert order_service._execute_dealer_limit_order_if_eligible(
            FakeDb(), order=first, pair=_pair(), dealer_snapshot=snapshot
        )
        assert not order_service._execute_dealer_limit_order_if_eligible(
            FakeDb(), order=second, pair=_pair(), dealer_snapshot=snapshot
        )
        assert filled == [1]
    finally:
        (
            order_service._check_dealer_execution_risk,
            order_service._final_dealer_execution_guard,
            order_service._fill_dealer_limit_order,
        ) = originals


def test_optional_snapshot_failure_keeps_limit_open() -> None:
    original = order_service.get_spot_execution_snapshot
    try:
        order_service.get_spot_execution_snapshot = lambda *args, **kwargs: (_ for _ in ()).throw(
            SpotExecutionUnavailable("missing")
        )
        assert order_service._get_dealer_market_context(
            FakeDb(), _pair(), require_executable=False
        ) is None
    finally:
        order_service.get_spot_execution_snapshot = original


def test_internal_dealer_pair_fails_closed_and_skips_external_snapshot() -> None:
    original = order_service.get_spot_execution_snapshot
    try:
        order_service.get_spot_execution_snapshot = lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("INTERNAL must not use external execution")
        )
        try:
            order_service._get_dealer_market_context(
                FakeDb(), _pair(symbol="MFCUSDT", data_source="INTERNAL"), require_executable=True
            )
        except HTTPException as exc:
            assert exc.status_code == 503
        else:
            raise AssertionError("INTERNAL + DEALER must fail closed")
        try:
            order_service._create_dealer_order(
                FakeDb(),
                user_id=1,
                payload=SimpleNamespace(order_type="LIMIT"),
                pair=_pair(symbol="MFCUSDT", data_source="INTERNAL"),
            )
        except HTTPException as exc:
            assert exc.status_code == 503
        else:
            raise AssertionError("misconfigured INTERNAL dealer order must be rejected")
    finally:
        order_service.get_spot_execution_snapshot = original


def test_normal_internal_pair_keeps_internal_order_route() -> None:
    originals = (
        order_service._get_trading_pair,
        order_service._create_limit_order,
        order_service._create_dealer_order,
    )
    marker = object()
    try:
        order_service._get_trading_pair = lambda db, symbol: _pair(
            symbol="MFCUSDT",
            data_source="INTERNAL",
            market_mode="INTERNAL",
        )
        order_service._create_limit_order = lambda db, **kwargs: marker
        order_service._create_dealer_order = lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("normal INTERNAL pair must not enter dealer execution")
        )
        result = order_service.create_order(
            FakeDb(),
            user_id=1,
            payload=SimpleNamespace(symbol="MFCUSDT", order_type="LIMIT"),
        )
        assert result is marker
    finally:
        (
            order_service._get_trading_pair,
            order_service._create_limit_order,
            order_service._create_dealer_order,
        ) = originals


def test_stock_dealer_path_remains_itick_and_skips_spot_execution() -> None:
    originals = (
        order_service.is_stock_dealer_pair,
        order_service.get_stock_trade_context,
        order_service.get_spot_execution_snapshot,
    )
    try:
        order_service.is_stock_dealer_pair = lambda pair: True
        order_service.get_stock_trade_context = lambda **kwargs: SimpleNamespace(
            source="ITICK",
            cached_age_ms=0,
            best_bid=Decimal("10"),
            best_ask=Decimal("11"),
            mid_price=Decimal("10.5"),
            spread_bps=Decimal("100"),
        )
        order_service.get_spot_execution_snapshot = lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("stock must not use crypto execution snapshot")
        )
        result = order_service._get_dealer_market_context(FakeDb(), _pair(data_source="ITICK"))
        assert result is not None
        assert result.price_source == "ITICK"
        assert result.best_bid == Decimal("10")
    finally:
        (
            order_service.is_stock_dealer_pair,
            order_service.get_stock_trade_context,
            order_service.get_spot_execution_snapshot,
        ) = originals


def test_immediate_and_loop_call_same_limit_execution_helper() -> None:
    source_immediate = inspect.getsource(order_service._create_dealer_limit_order)
    source_loop = inspect.getsource(order_service.process_open_dealer_orders)
    helper_name = "_execute_dealer_limit_order_if_eligible"
    assert source_immediate.count(helper_name) == 1
    assert source_loop.count(helper_name) == 1


def test_market_immediate_limit_and_loop_share_one_final_guard() -> None:
    final_guard = "_final_dealer_execution_guard"
    limit_helper = "_execute_dealer_limit_order_if_eligible"
    assert final_guard in inspect.getsource(order_service._create_dealer_market_order)
    assert final_guard in inspect.getsource(order_service._execute_dealer_limit_order_if_eligible)
    assert limit_helper in inspect.getsource(order_service._create_dealer_limit_order)
    assert limit_helper in inspect.getsource(order_service.process_open_dealer_orders)


def test_dealer_loop_continues_after_one_pair_snapshot_failure() -> None:
    first_pair = _pair(id=1, symbol="BTCUSDT")
    second_pair = _pair(id=2, symbol="ETHUSDT")
    orders = [
        SimpleNamespace(id=1, order_type="LIMIT", trading_pair=first_pair),
        SimpleNamespace(id=2, order_type="LIMIT", trading_pair=second_pair),
    ]

    class Scalars:
        def all(self):
            return orders

    class Result:
        def scalars(self):
            return Scalars()

    class LoopDb:
        def execute(self, stmt):
            return Result()

    originals = (
        order_service._get_dealer_market_context,
        order_service._execute_dealer_limit_order_if_eligible,
    )
    calls = []
    try:
        def context(db, pair, **kwargs):
            if pair.id == 1:
                raise SpotExecutionUnavailable("primary unavailable")
            return _dealer_snapshot("BITGET_SPOT")

        def execute(db, *, order, pair, dealer_snapshot):
            calls.append((pair.id, dealer_snapshot.price_source if dealer_snapshot else None))
            return dealer_snapshot is not None

        order_service._get_dealer_market_context = context
        order_service._execute_dealer_limit_order_if_eligible = execute
        assert order_service.process_open_dealer_orders(LoopDb()) == 1
        assert calls == [(1, None), (2, "BITGET_SPOT")]
    finally:
        (
            order_service._get_dealer_market_context,
            order_service._execute_dealer_limit_order_if_eligible,
        ) = originals


def test_order_service_no_longer_imports_fixed_binance_execution_service() -> None:
    source = inspect.getsource(order_service)
    assert "binance_market_service" not in source
    assert "get_spot_execution_snapshot" in source


def test_limit_decision_does_not_read_ticker_last_or_frontend_provider() -> None:
    source = inspect.getsource(order_service._execute_dealer_limit_order_if_eligible)
    assert "ticker" not in source.lower()
    assert "last_price" not in source
    assert "provider" not in inspect.signature(
        order_service._execute_dealer_limit_order_if_eligible
    ).parameters


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
    print("spot dealer execution tests passed")
