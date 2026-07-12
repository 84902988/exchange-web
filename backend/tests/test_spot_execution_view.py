from __future__ import annotations

import time
from decimal import Decimal

from app.schemas.market import DepthItem, DepthResponse
from app.schemas.spot_domain_snapshot import DomainSource, DomainTransport
from app.services import spot_execution_view as execution
from app.services.contract_market_provider_service import (
    MARKET_TYPE_SPOT,
    MarketDataProviderConfig,
)
from app.services.spot_market_gateway import SpotMarketGateway


class Pair:
    symbol = "BTCUSDT"
    status = 1
    data_source = "BINANCE"


class FakeDb:
    pass


def _provider(code: str, priority: int) -> MarketDataProviderConfig:
    return MarketDataProviderConfig(
        provider_code=code,
        provider_name=code,
        market_type=MARKET_TYPE_SPOT,
        enabled=True,
        priority=priority,
        base_url="https://example.test",
        timeout_ms=300,
        cooldown_seconds=1,
    )


def _depth(
    provider: str,
    *,
    bid: str = "100",
    ask: str = "101",
    event_time_ms: int | None = None,
    received_at_ms: int | None = None,
    source: str = "LIVE_WS",
    freshness: str = "LIVE",
) -> DepthResponse:
    now_ms = int(time.time() * 1000)
    return DepthResponse(
        symbol="BTCUSDT",
        bids=[DepthItem(price=bid, amount="2")],
        asks=[DepthItem(price=ask, amount="3")],
        ts=event_time_ms or now_ms,
        provider=provider,
        source=source,
        freshness=freshness,
        fetched_at=received_at_ms or now_ms,
    )


def _gateway(active_provider: str = "OKX_SPOT") -> SpotMarketGateway:
    gateway = SpotMarketGateway(
        provider_symbol_allowed=lambda symbol: True,
        precision_resolver=lambda symbol: (2, 4),
    )
    gateway._depth_authority.ensure_provider("BTCUSDT", active_provider)
    gateway._symbol_providers["BTCUSDT"] = active_provider
    return gateway


def _committed_snapshot(
    gateway: SpotMarketGateway,
    *,
    provider: str = "OKX_SPOT",
    source: str = "LIVE_WS",
    freshness: str = "LIVE",
    event_time_ms: int | None = None,
    received_at_ms: int | None = None,
) -> execution.SpotExecutionSnapshot:
    now_ms = int(time.time() * 1000)
    event_ms = event_time_ms or now_ms
    received_ms = received_at_ms or now_ms
    depth = _depth(
        provider,
        event_time_ms=event_ms,
        received_at_ms=received_ms,
        source=source,
        freshness=freshness,
    )
    state = gateway.commit_authoritative_depth(
        symbol="BTCUSDT",
        provider=provider,
        provider_symbol="BTC-USDT" if provider == "OKX_SPOT" else "BTCUSDT",
        depth=depth,
        event_time_ms=event_ms,
        received_at_ms=received_ms,
        freshness=freshness,
        source=source,
        allow_switch=provider != "OKX_SPOT",
        expected_provider="OKX_SPOT" if provider != "OKX_SPOT" else None,
    )
    assert state is not None
    snapshot = execution._build_snapshot(
        symbol=state.symbol,
        provider=state.provider,
        provider_symbol=state.provider_symbol,
        depth=state.depth,
        event_time_ms=state.event_time_ms,
        received_at_ms=state.received_at_ms,
        freshness=state.freshness,
        source=state.source,
        provider_generation=state.provider_generation,
        max_age_ms=1500,
        now_ms=received_ms,
    )
    assert snapshot is not None
    return snapshot


def _run_with_sources(
    *,
    ws_by_provider: dict,
    rest_by_provider: dict,
    active_provider: str = "OKX_SPOT",
    provider_codes: tuple[str, ...] = ("OKX_SPOT", "BITGET_SPOT"),
):
    originals = {
        "gateway": execution.spot_market_gateway,
        "pair": execution._pair,
        "enabled": execution.enabled_spot_market_providers,
        "resolve": execution.resolve_spot_provider_symbol,
        "ws": execution.get_spot_provider_ws_depth,
        "request": execution.request_contract_market_provider_json,
        "success": execution.mark_contract_market_provider_success,
        "failure": execution.mark_contract_market_provider_failure,
    }
    calls: list[tuple[str, str]] = []
    gateway = _gateway(active_provider)
    providers = tuple(_provider(code, (index + 1) * 10) for index, code in enumerate(provider_codes))
    try:
        execution.spot_market_gateway = gateway
        execution._pair = lambda db, symbol: Pair()
        execution.enabled_spot_market_providers = lambda db: providers
        execution.resolve_spot_provider_symbol = (
            lambda db, provider_code, local_symbol: "BTC-USDT" if provider_code == "OKX_SPOT" else "BTCUSDT"
        )
        execution.get_spot_provider_ws_depth = lambda symbol, provider, **kwargs: ws_by_provider.get(provider)

        def request(provider, endpoint, provider_symbol, **kwargs):
            calls.append((provider.provider_code, endpoint))
            value = rest_by_provider.get(provider.provider_code)
            if isinstance(value, Exception):
                raise value
            if value is None:
                raise RuntimeError("unavailable")
            return value

        execution.request_contract_market_provider_json = request
        execution.mark_contract_market_provider_success = lambda *args, **kwargs: None
        execution.mark_contract_market_provider_failure = lambda *args, **kwargs: None
        result = execution.get_spot_execution_snapshot(FakeDb(), "BTCUSDT", require_executable=False)
        return result, calls, gateway
    finally:
        execution.spot_market_gateway = originals["gateway"]
        execution._pair = originals["pair"]
        execution.enabled_spot_market_providers = originals["enabled"]
        execution.resolve_spot_provider_symbol = originals["resolve"]
        execution.get_spot_provider_ws_depth = originals["ws"]
        execution.request_contract_market_provider_json = originals["request"]
        execution.mark_contract_market_provider_success = originals["success"]
        execution.mark_contract_market_provider_failure = originals["failure"]


def _okx_rest(*, bid: str = "100", ask: str = "101", ts: int | None = None) -> dict:
    return {"data": [{"bids": [[bid, "2"]], "asks": [[ask, "3"]], "ts": str(ts or int(time.time() * 1000))}]}


def _bitget_rest(*, bid: str = "99", ask: str = "100", ts: int | None = None) -> dict:
    return {
        "data": {"bids": [[bid, "2"]], "asks": [[ask, "3"]], "ts": str(ts or int(time.time() * 1000))}
    }


def test_fresh_active_ws_snapshot_is_executable() -> None:
    result, calls, gateway = _run_with_sources(
        ws_by_provider={"OKX_SPOT": _depth("OKX_SPOT")},
        rest_by_provider={},
    )
    assert result is not None
    assert result.provider == "OKX_SPOT"
    assert result.best_bid == Decimal("100")
    assert result.best_ask == Decimal("101")
    assert result.source == "LIVE_WS"
    assert result.provider_generation == 1
    assert calls == []
    assert gateway.get_active_depth_provider("BTCUSDT") == ("OKX_SPOT", 1)


def test_stale_ws_is_rejected_and_fresh_rest_is_used() -> None:
    stale_ms = int(time.time() * 1000) - 60_000
    result, calls, gateway = _run_with_sources(
        ws_by_provider={"OKX_SPOT": _depth("OKX_SPOT", received_at_ms=stale_ms)},
        rest_by_provider={"OKX_SPOT": _okx_rest()},
    )
    assert result is not None
    assert result.source == "REST"
    assert result.freshness == "RECENT"
    assert calls == [("OKX_SPOT", "depth")]
    domain_snapshot = gateway.get_depth_domain_snapshot("BTCUSDT")
    assert domain_snapshot is not None
    assert domain_snapshot.metadata.transport == DomainTransport.PROVIDER_REST
    assert domain_snapshot.metadata.source == DomainSource.REST_SNAPSHOT
    assert domain_snapshot.metadata.provider_generation == result.provider_generation


def test_primary_failure_switches_atomically_to_complete_fallback() -> None:
    result, calls, gateway = _run_with_sources(
        ws_by_provider={},
        rest_by_provider={"OKX_SPOT": RuntimeError("down"), "BITGET_SPOT": _bitget_rest()},
    )
    assert result is not None
    assert result.provider == "BITGET_SPOT"
    assert result.provider_generation == 2
    assert gateway.get_active_depth_provider("BTCUSDT") == ("BITGET_SPOT", 2)
    public_state = gateway.get_authoritative_depth("BTCUSDT")
    assert public_state is not None
    assert public_state.provider == result.provider
    assert public_state.provider_generation == result.provider_generation
    assert Decimal(public_state.depth.bids[0].price) == result.best_bid
    assert Decimal(public_state.depth.asks[0].price) == result.best_ask
    domain_snapshot = gateway.get_depth_domain_snapshot("BTCUSDT")
    assert domain_snapshot is not None
    assert domain_snapshot.metadata.provider == result.provider
    assert domain_snapshot.metadata.provider_generation == result.provider_generation
    assert calls == [("OKX_SPOT", "depth"), ("BITGET_SPOT", "depth")]


def test_disabled_active_provider_is_not_used_for_execution() -> None:
    result, calls, gateway = _run_with_sources(
        ws_by_provider={
            "OKX_SPOT": _depth("OKX_SPOT", bid="200", ask="201"),
            "BITGET_SPOT": _depth("BITGET_SPOT", bid="99", ask="100"),
        },
        rest_by_provider={},
        provider_codes=("BITGET_SPOT",),
    )
    assert result is not None
    assert result.provider == "BITGET_SPOT"
    assert result.best_ask == Decimal("100")
    assert gateway.get_active_depth_provider("BTCUSDT") == ("BITGET_SPOT", 2)
    assert calls == []


def test_incomplete_fallback_does_not_switch_provider() -> None:
    result, _, gateway = _run_with_sources(
        ws_by_provider={},
        rest_by_provider={
            "OKX_SPOT": RuntimeError("down"),
            "BITGET_SPOT": {"data": {"bids": [["99", "2"]], "asks": [], "ts": str(int(time.time() * 1000))}},
        },
    )
    assert result is None
    assert gateway.get_active_depth_provider("BTCUSDT") == ("OKX_SPOT", 1)


def test_crossed_bbo_is_not_executable() -> None:
    result, _, gateway = _run_with_sources(
        ws_by_provider={},
        rest_by_provider={"OKX_SPOT": _okx_rest(bid="102", ask="101"), "BITGET_SPOT": RuntimeError("down")},
    )
    assert result is None
    assert gateway.get_active_depth_provider("BTCUSDT") == ("OKX_SPOT", 1)


def test_zero_or_negative_bbo_is_not_executable() -> None:
    now_ms = int(time.time() * 1000)
    for bid, ask in (("0", "101"), ("100", "0"), ("-1", "101"), ("100", "-1")):
        assert execution._build_snapshot(
            symbol="BTCUSDT",
            provider="OKX_SPOT",
            provider_symbol="BTC-USDT",
            depth=_depth("OKX_SPOT", bid=bid, ask=ask, event_time_ms=now_ms, received_at_ms=now_ms),
            event_time_ms=now_ms,
            received_at_ms=now_ms,
            freshness="LIVE",
            source="LIVE_WS",
            provider_generation=1,
            max_age_ms=1500,
            now_ms=now_ms,
        ) is None


def test_missing_provider_event_time_is_not_replaced_by_received_time() -> None:
    now_ms = int(time.time() * 1000)
    depth = _depth("OKX_SPOT", event_time_ms=now_ms)
    snapshot = execution._build_snapshot(
        symbol="BTCUSDT",
        provider="OKX_SPOT",
        provider_symbol="BTC-USDT",
        depth=depth,
        event_time_ms=0,
        received_at_ms=now_ms,
        freshness="LIVE",
        source="LIVE_WS",
        provider_generation=1,
        max_age_ms=1500,
        now_ms=now_ms,
    )
    assert snapshot is None


def test_provider_event_time_clock_skew_does_not_override_fresh_received_time() -> None:
    now_ms = int(time.time() * 1000)
    snapshot = execution._build_snapshot(
        symbol="BTCUSDT",
        provider="OKX_SPOT",
        provider_symbol="BTC-USDT",
        depth=_depth("OKX_SPOT", event_time_ms=now_ms + 5000, received_at_ms=now_ms),
        event_time_ms=now_ms + 5000,
        received_at_ms=now_ms,
        freshness="LIVE",
        source="LIVE_WS",
        provider_generation=1,
        max_age_ms=1500,
        now_ms=now_ms,
    )
    assert snapshot is not None


def test_last_good_and_synthetic_sources_are_rejected() -> None:
    now_ms = int(time.time() * 1000)
    for source in ("LAST_GOOD", "SYNTHETIC", "CACHED"):
        assert execution._build_snapshot(
            symbol="BTCUSDT",
            provider="OKX_SPOT",
            provider_symbol="BTC-USDT",
            depth=_depth("OKX_SPOT", event_time_ms=now_ms, received_at_ms=now_ms),
            event_time_ms=now_ms,
            received_at_ms=now_ms,
            freshness="LIVE",
            source=source,
            provider_generation=1,
            max_age_ms=1500,
            now_ms=now_ms,
        ) is None


def test_snapshot_id_is_stable_for_same_execution_evidence() -> None:
    now_ms = int(time.time() * 1000)
    kwargs = dict(
        symbol="BTCUSDT",
        provider="OKX_SPOT",
        provider_symbol="BTC-USDT",
        depth=_depth("OKX_SPOT", event_time_ms=now_ms, received_at_ms=now_ms),
        event_time_ms=now_ms,
        received_at_ms=now_ms,
        freshness="LIVE",
        source="LIVE_WS",
        provider_generation=3,
        max_age_ms=1500,
        now_ms=now_ms,
    )
    first = execution._build_snapshot(**kwargs)
    second = execution._build_snapshot(**kwargs)
    assert first is not None and second is not None
    assert first.snapshot_id == second.snapshot_id


def test_received_age_over_max_age_is_rejected() -> None:
    now_ms = int(time.time() * 1000)
    assert execution._build_snapshot(
        symbol="BTCUSDT",
        provider="OKX_SPOT",
        provider_symbol="BTC-USDT",
        depth=_depth("OKX_SPOT", event_time_ms=now_ms - 2000, received_at_ms=now_ms - 2000),
        event_time_ms=now_ms - 2000,
        received_at_ms=now_ms - 2000,
        freshness="LIVE",
        source="LIVE_WS",
        provider_generation=1,
        max_age_ms=1500,
        now_ms=now_ms,
    ) is None


def test_stale_or_missing_freshness_is_rejected() -> None:
    now_ms = int(time.time() * 1000)
    for freshness in ("STALE", "MISSING", "UNKNOWN"):
        assert execution._build_snapshot(
            symbol="BTCUSDT",
            provider="OKX_SPOT",
            provider_symbol="BTC-USDT",
            depth=_depth("OKX_SPOT", event_time_ms=now_ms, received_at_ms=now_ms),
            event_time_ms=now_ms,
            received_at_ms=now_ms,
            freshness=freshness,
            source="LIVE_WS",
            provider_generation=1,
            max_age_ms=1500,
            now_ms=now_ms,
        ) is None


def test_provider_generation_is_part_of_snapshot_identity() -> None:
    now_ms = int(time.time() * 1000)
    common = dict(
        symbol="BTCUSDT",
        provider="OKX_SPOT",
        provider_symbol="BTC-USDT",
        depth=_depth("OKX_SPOT", event_time_ms=now_ms, received_at_ms=now_ms),
        event_time_ms=now_ms,
        received_at_ms=now_ms,
        freshness="LIVE",
        source="LIVE_WS",
        max_age_ms=1500,
        now_ms=now_ms,
    )
    first = execution._build_snapshot(**common, provider_generation=1)
    second = execution._build_snapshot(**common, provider_generation=2)
    assert first is not None and second is not None
    assert first.snapshot_id != second.snapshot_id


def test_snapshot_from_old_gateway_generation_is_rejected() -> None:
    original_gateway = execution.spot_market_gateway
    now_ms = int(time.time() * 1000)
    try:
        execution.spot_market_gateway = _gateway("OKX_SPOT")
        snapshot = execution._build_snapshot(
            symbol="BTCUSDT",
            provider="OKX_SPOT",
            provider_symbol="BTC-USDT",
            depth=_depth("OKX_SPOT", event_time_ms=now_ms, received_at_ms=now_ms),
            event_time_ms=now_ms,
            received_at_ms=now_ms,
            freshness="LIVE",
            source="LIVE_WS",
            provider_generation=2,
            max_age_ms=1500,
            now_ms=now_ms,
        )
        assert snapshot is not None
        assert execution._if_current_gateway_snapshot(snapshot) is None
    finally:
        execution.spot_market_gateway = original_gateway


def test_final_guard_rejects_generation_switch_after_snapshot_selection() -> None:
    original_gateway = execution.spot_market_gateway
    gateway = _gateway("OKX_SPOT")
    try:
        execution.spot_market_gateway = gateway
        old_snapshot = _committed_snapshot(gateway)
        _committed_snapshot(gateway, provider="BITGET_SPOT", source="REST", freshness="RECENT")
        result = execution.guard_spot_execution_snapshot(old_snapshot)
        assert not result.executable
        assert result.reject_reason == "PROVIDER_RETIRED"
    finally:
        execution.spot_market_gateway = original_gateway


def test_final_guard_rejects_snapshot_that_expires_before_fill() -> None:
    original_gateway = execution.spot_market_gateway
    gateway = _gateway("OKX_SPOT")
    now_ms = int(time.time() * 1000)
    try:
        execution.spot_market_gateway = gateway
        snapshot = _committed_snapshot(
            gateway,
            event_time_ms=now_ms - 2000,
            received_at_ms=now_ms - 2000,
        )
        result = execution.guard_spot_execution_snapshot(snapshot, now_ms=now_ms)
        assert not result.executable
        assert result.reject_reason == "SNAPSHOT_EXPIRED"
        assert result.age_ms == 2000
    finally:
        execution.spot_market_gateway = original_gateway


def test_final_guard_rejects_retired_ws_and_rest_provider_snapshots() -> None:
    for source, freshness in (("LIVE_WS", "LIVE"), ("REST", "RECENT")):
        original_gateway = execution.spot_market_gateway
        gateway = _gateway("OKX_SPOT")
        try:
            execution.spot_market_gateway = gateway
            snapshot = _committed_snapshot(
                gateway,
                source=source,
                freshness=freshness,
            )
            _committed_snapshot(gateway, provider="BITGET_SPOT", source="REST", freshness="RECENT")
            assert not execution.guard_spot_execution_snapshot(snapshot).executable
        finally:
            execution.spot_market_gateway = original_gateway


def test_final_guard_allows_same_current_snapshot_to_be_reused() -> None:
    original_gateway = execution.spot_market_gateway
    gateway = _gateway("OKX_SPOT")
    try:
        execution.spot_market_gateway = gateway
        snapshot = _committed_snapshot(gateway)
        assert execution.guard_spot_execution_snapshot(snapshot).executable
        assert execution.guard_spot_execution_snapshot(snapshot).executable
    finally:
        execution.spot_market_gateway = original_gateway


def test_non_executable_pair_returns_none_or_raises() -> None:
    original_pair = execution._pair
    try:
        class InternalPair:
            data_source = "INTERNAL"

        execution._pair = lambda db, symbol: InternalPair()
        assert execution.get_spot_execution_snapshot(FakeDb(), "MFCUSDT", False) is None
        try:
            execution.get_spot_execution_snapshot(FakeDb(), "MFCUSDT", True)
        except execution.SpotExecutionUnavailable:
            pass
        else:
            raise AssertionError("require_executable must fail closed")
    finally:
        execution._pair = original_pair


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
    print("spot execution view tests passed")
