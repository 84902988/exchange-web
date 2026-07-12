from __future__ import annotations

import asyncio
from datetime import datetime
from types import SimpleNamespace

import pytest

from app.schemas.spot_domain_snapshot import (
    DomainCacheOrigin,
    DomainFreshness,
    DomainSource,
    DomainTransport,
)
from app.services import market
from app.services.market_domain_snapshot import MarketDomainSnapshot
from app.services.market_kline_cache import (
    KLINE_CACHE_ORIGIN_DB_CACHE,
    KLINE_CACHE_ORIGIN_EMPTY,
    KLINE_CACHE_ORIGIN_REST_FETCH,
    KlineCacheResult,
)
from app.services.spot_market_gateway import SpotMarketGateway


def _gateway() -> SpotMarketGateway:
    try:
        asyncio.get_event_loop()
    except RuntimeError:
        asyncio.set_event_loop(asyncio.new_event_loop())
    return SpotMarketGateway(
        ensure_depth=lambda _symbol: None,
        ensure_kline=lambda _symbol, _interval: None,
        release_depth=lambda _symbol: None,
        get_depth=lambda _symbol, **_kwargs: None,
        get_ticker=lambda _symbol, **_kwargs: None,
        get_trades=lambda _symbol, **_kwargs: None,
        get_klines=lambda _symbol, _interval, **_kwargs: None,
        provider_symbol_allowed=lambda _symbol: True,
        precision_resolver=lambda _symbol: (2, 6),
    )


def _pair():
    return SimpleNamespace(
        id=1,
        symbol="BTCUSDT",
        data_source="BINANCE",
        asset_type="CRYPTO",
        market_category="SPOT",
    )


def _bar(open_time: int, *, close: str, revision_seq: int) -> dict:
    return {
        "open_time": open_time,
        "close_time": open_time + 60_000,
        "open": "100",
        "high": "110",
        "low": "90",
        "close": close,
        "volume": "5",
        "quote_volume": "500",
        "revision_epoch": 7,
        "revision_seq": revision_seq,
        "is_closed": True,
        "close_state_source": "REST_CONFIRMED",
    }


def _bars() -> list[dict]:
    return [
        _bar(1_720_000_060_000, close="102", revision_seq=12),
        _bar(1_720_000_000_000, close="101", revision_seq=11),
    ]


def _install_common(monkeypatch, gateway: SpotMarketGateway) -> None:
    provider = SimpleNamespace(provider_code="OKX_SPOT")
    monkeypatch.setattr(market, "_spot_market_gateway_service", lambda: gateway)
    monkeypatch.setattr(market, "_get_active_pair", lambda *_args, **_kwargs: _pair())
    monkeypatch.setattr(
        market,
        "_enabled_spot_market_providers_for_pair",
        lambda *_args, **_kwargs: [provider],
    )
    monkeypatch.setattr(
        market,
        "spot_provider_ws_supports_provider",
        lambda *_args, **_kwargs: False,
    )


def _capture_market_snapshots(monkeypatch, gateway: SpotMarketGateway):
    captured: list[MarketDomainSnapshot] = []
    original = gateway.record_kline_market_domain_snapshot

    def record(**kwargs):
        captured.append(kwargs["snapshot"])
        return original(**kwargs)

    monkeypatch.setattr(gateway, "record_kline_market_domain_snapshot", record)
    return captured


@pytest.mark.parametrize(
    ("interval", "end_time_ms", "expected_source"),
    [
        ("1m", None, DomainSource.REST_SNAPSHOT),
        ("1Dutc", None, DomainSource.REST_SNAPSHOT),
        ("1Wutc", 1_720_100_000_000, DomainSource.REST_HISTORY),
        ("1Mutc", 1_720_100_000_000, DomainSource.REST_HISTORY),
    ],
)
def test_rest_latest_and_history_snapshot_preserve_bars(
    monkeypatch,
    interval,
    end_time_ms,
    expected_source,
):
    gateway = _gateway()
    bars = _bars()
    _install_common(monkeypatch, gateway)
    market_snapshots = _capture_market_snapshots(monkeypatch, gateway)
    monkeypatch.setattr(
        market,
        "get_klines_cache_first",
        lambda *_args, **_kwargs: KlineCacheResult(
            bars,
            origin=KLINE_CACHE_ORIGIN_REST_FETCH,
            cache_status="MISS",
        ),
    )
    monkeypatch.setitem(
        market._SPOT_LAST_GOOD_KLINES,
        ("BTCUSDT", interval),
        {
            "items": bars,
            "provider": "OKX_SPOT",
            "updated_at": datetime.utcnow().isoformat(),
        },
    )

    result = market.get_klines(
        object(),
        "BTCUSDT",
        interval,
        limit=20,
        end_time_ms=end_time_ms,
        force_rest=True,
    )

    assert result["items"] == bars
    assert result["items"][0]["close"] == "102"
    assert result["items"][1]["revision_seq"] == 11
    assert len(market_snapshots) == 1
    assert market_snapshots[0].domain == "kline"
    assert market_snapshots[0].data == bars
    assert market_snapshots[0].source == expected_source.value
    assert market_snapshots[0].data[0]["revision_seq"] == 12
    snapshot = gateway.get_kline_domain_snapshot("BTCUSDT", interval)
    assert snapshot is not None
    assert snapshot.data["items"] == bars
    assert snapshot.metadata.transport == DomainTransport.PROVIDER_REST
    assert snapshot.metadata.cache_origin == DomainCacheOrigin.NONE
    assert snapshot.metadata.source == expected_source
    assert snapshot.metadata.provider == "OKX_SPOT"
    assert snapshot.metadata.freshness == DomainFreshness.RECENT
    assert snapshot.metadata.history_terminal == result["history_terminal"]
    assert snapshot.metadata.history_incomplete == result["history_incomplete"]


def test_db_cache_snapshot_does_not_invent_database_update_time(monkeypatch):
    gateway = _gateway()
    bars = _bars()
    _install_common(monkeypatch, gateway)
    market_snapshots = _capture_market_snapshots(monkeypatch, gateway)
    monkeypatch.setattr(
        market,
        "get_klines_cache_first",
        lambda *_args, **_kwargs: KlineCacheResult(
            bars,
            origin=KLINE_CACHE_ORIGIN_DB_CACHE,
            cache_status="HIT",
        ),
    )

    result = market.get_klines(
        object(),
        "BTCUSDT",
        "1Dutc",
        limit=20,
        force_rest=True,
    )

    assert result["items"] == bars
    assert len(market_snapshots) == 1
    assert market_snapshots[0].source == "DB_CACHE"
    assert market_snapshots[0].data == bars
    snapshot = gateway.get_kline_domain_snapshot("BTCUSDT", "1Dutc")
    assert snapshot is not None
    assert snapshot.metadata.transport == DomainTransport.DB_READ
    assert snapshot.metadata.cache_origin == DomainCacheOrigin.DATABASE
    assert snapshot.metadata.source == DomainSource.DB_CACHE
    assert snapshot.metadata.freshness == DomainFreshness.MISSING
    assert snapshot.metadata.cache_updated_at_ms is None


def test_last_good_snapshot_keeps_original_provider_and_terminal_fields(monkeypatch):
    gateway = _gateway()
    bars = _bars()
    _install_common(monkeypatch, gateway)
    market_snapshots = _capture_market_snapshots(monkeypatch, gateway)
    monkeypatch.setitem(
        market._SPOT_LAST_GOOD_KLINES,
        ("BTCUSDT", "1Wutc"),
        {
            "items": bars,
            "provider": "OKX_SPOT",
            "updated_at": datetime.utcnow().isoformat(),
        },
    )

    def fake_fetch(*_args, fetch_metadata=None, **_kwargs):
        fetch_metadata.update(
            {
                "provider": "OKX_SPOT",
                "from_last_good": True,
            }
        )
        return bars

    def fake_cache(*_args, fetch_external=None, **_kwargs):
        return KlineCacheResult(
            fetch_external(20, None),
            origin=KLINE_CACHE_ORIGIN_REST_FETCH,
            cache_status="MISS",
            history_incomplete=True,
        )

    monkeypatch.setattr(market, "_fetch_external_spot_klines", fake_fetch)
    monkeypatch.setattr(market, "get_klines_cache_first", fake_cache)

    result = market.get_klines(
        object(),
        "BTCUSDT",
        "1Wutc",
        limit=20,
        force_rest=True,
    )

    assert result["items"] == bars
    assert len(market_snapshots) == 1
    assert market_snapshots[0].source == "LAST_GOOD"
    assert market_snapshots[0].data == bars
    snapshot = gateway.get_kline_domain_snapshot("BTCUSDT", "1Wutc")
    assert snapshot is not None
    assert snapshot.metadata.transport == DomainTransport.CACHE_READ
    assert snapshot.metadata.cache_origin == DomainCacheOrigin.LAST_GOOD_MEMORY
    assert snapshot.metadata.source == DomainSource.LAST_GOOD
    assert snapshot.metadata.provider == "OKX_SPOT"
    assert snapshot.metadata.freshness == DomainFreshness.LAST_GOOD
    assert snapshot.metadata.history_incomplete is True


def test_history_boundary_snapshot_preserves_terminal_semantics(monkeypatch):
    gateway = _gateway()
    _install_common(monkeypatch, gateway)
    market_snapshots = _capture_market_snapshots(monkeypatch, gateway)
    monkeypatch.setattr(
        market,
        "get_klines_cache_first",
        lambda *_args, **_kwargs: KlineCacheResult(
            [],
            origin=KLINE_CACHE_ORIGIN_EMPTY,
            cache_status="MISS",
            history_incomplete=False,
            history_terminal=True,
            terminal_reason="PROVIDER_HISTORY_BOUNDARY",
            earliest_available_time=1_514_764_800_000,
        ),
    )

    result = market.get_klines(
        object(),
        "BTCUSDT",
        "1Mutc",
        limit=20,
        end_time_ms=1_500_000_000_000,
        force_rest=True,
    )

    assert result["items"] == []
    assert len(market_snapshots) == 1
    assert market_snapshots[0].source == "MISSING"
    assert market_snapshots[0].data == []
    snapshot = gateway.get_kline_domain_snapshot("BTCUSDT", "1Mutc")
    assert snapshot is not None
    assert snapshot.data["items"] == []
    assert snapshot.metadata.transport == DomainTransport.CACHE_READ
    assert snapshot.metadata.cache_origin == DomainCacheOrigin.HISTORY_BOUNDARY
    assert snapshot.metadata.source == DomainSource.MISSING
    assert snapshot.metadata.freshness == DomainFreshness.MISSING
    assert snapshot.metadata.stale is False
    assert snapshot.metadata.history_terminal is True
    assert snapshot.metadata.history_incomplete is False
    assert snapshot.metadata.terminal_reason == "PROVIDER_HISTORY_BOUNDARY"
    assert snapshot.metadata.earliest_available_time == 1_514_764_800_000


def test_live_ws_current_snapshot_stays_separate_from_history_response(monkeypatch):
    gateway = _gateway()
    history = [_bar(1_720_000_000_000, close="101", revision_seq=11)]
    current = _bar(1_720_000_060_000, close="103", revision_seq=13)
    current.update(
        {
            "is_closed": False,
            "close_state_source": "PROVIDER_CONFIRMED",
            "received_at_ms": 1_720_000_060_150,
        }
    )
    provider = SimpleNamespace(provider_code="OKX_SPOT")
    monkeypatch.setattr(market, "_spot_market_gateway_service", lambda: gateway)
    monkeypatch.setattr(market, "_get_active_pair", lambda *_args, **_kwargs: _pair())
    monkeypatch.setattr(
        market,
        "_enabled_spot_market_providers_for_pair",
        lambda *_args, **_kwargs: [provider],
    )
    monkeypatch.setattr(
        market,
        "spot_provider_ws_supports_provider",
        lambda *_args, **_kwargs: True,
    )
    monkeypatch.setattr(
        market,
        "get_spot_provider_ws_klines",
        lambda *_args, **_kwargs: {
            "symbol": "BTCUSDT",
            "interval": "1m",
            "items": [current],
            "provider": "OKX_SPOT",
            "source": "LIVE_WS",
            "freshness": "LIVE",
            "updated_at": "2024-07-03T09:47:40.150000+00:00",
        },
    )
    monkeypatch.setattr(
        market,
        "get_klines_cache_first",
        lambda *_args, **_kwargs: KlineCacheResult(
            history,
            origin=KLINE_CACHE_ORIGIN_DB_CACHE,
            cache_status="HIT",
        ),
    )
    market_snapshots = _capture_market_snapshots(monkeypatch, gateway)

    result = market.get_klines(
        object(),
        "BTCUSDT",
        "1m",
        limit=20,
        force_rest=False,
    )

    assert result["items"] == [history[0], current]
    assert result["source"] == "LIVE_WS"
    assert len(market_snapshots) == 1
    assert market_snapshots[0].source == "LIVE_WS"
    assert market_snapshots[0].data == [current]
    assert market_snapshots[0].data[0]["revision_seq"] == 13
    snapshot = gateway.get_kline_domain_snapshot("BTCUSDT", "1m")
    assert snapshot is not None
    assert snapshot.data["items"] == [history[0], current]
    assert snapshot.metadata.source == DomainSource.LIVE_WS
    assert snapshot.metadata.revision is not None
    assert snapshot.metadata.revision.sequence == 13
    assert snapshot.metadata.revision.is_closed is False
