from __future__ import annotations

import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
BACKEND = ROOT / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from app.services.market_depth_cache import MarketDepthCacheMetadata  # noqa: E402
from app.services.market_domain_snapshot import MarketDomainSnapshot  # noqa: E402
from app.services.market_kline_cache import MarketKlineCacheMetadata  # noqa: E402
from app.services.market_ticker_cache import MarketTickerCacheMetadata  # noqa: E402
from app.services.market_trades_cache import MarketTradesCacheMetadata  # noqa: E402


UPDATED_AT = 1_720_000_000_000


def test_ticker_metadata_converts_to_domain_snapshot_without_legacy_changes() -> None:
    data = {"symbol": "BTCUSDT", "last_price": "60000"}
    metadata = MarketTickerCacheMetadata(
        data=data,
        source="LIVE_WS",
        provider="OKX_SPOT",
        updated_at=UPDATED_AT,
    )
    legacy_before = metadata.to_dict()

    snapshot = metadata.to_domain_snapshot(now_ms=UPDATED_AT + 500)

    assert isinstance(snapshot, MarketDomainSnapshot)
    assert snapshot.symbol == "BTCUSDT"
    assert snapshot.domain == "ticker"
    assert snapshot.data == data
    assert snapshot.source == "LIVE_WS"
    assert snapshot.provider == "OKX_SPOT"
    assert snapshot.freshness == "LIVE"
    assert snapshot.updated_at == UPDATED_AT
    assert snapshot.age_ms == 500
    assert snapshot.fallback_reason is None
    assert metadata.to_dict() == legacy_before
    assert set(legacy_before) == {"data", "source", "provider", "updated_at", "version"}


def test_depth_metadata_converts_with_explicit_fallback_reason() -> None:
    data = {
        "symbol": "ETHUSDT",
        "bids": [{"price": "3000", "amount": "1"}],
        "asks": [{"price": "3001", "amount": "1"}],
    }
    metadata = MarketDepthCacheMetadata(
        data=data,
        source="external",
        provider="OKX_SPOT",
        updated_at=UPDATED_AT,
        sequence=42,
    )

    snapshot = metadata.to_domain_snapshot(
        fallback_reason="WS_MISS",
        now_ms=UPDATED_AT + 250,
    )

    assert snapshot.symbol == "ETHUSDT"
    assert snapshot.domain == "depth"
    assert snapshot.data == data
    assert snapshot.freshness == "LIVE"
    assert snapshot.age_ms == 250
    assert snapshot.fallback_reason == "WS_MISS"
    assert metadata.sequence == 42
    assert "sequence" in metadata.to_dict()


def test_trades_metadata_converts_without_changing_identity_or_order() -> None:
    data = {
        "symbol": "BTCUSDT",
        "trades": [
            {"provider_trade_id": "trade-2", "price": "101"},
            {"provider_trade_id": "trade-1", "price": "100"},
        ],
    }
    metadata = MarketTradesCacheMetadata(
        data=data,
        source="REST_SNAPSHOT",
        provider="OKX_SPOT",
        updated_at=UPDATED_AT,
        last_trade_id="trade-2",
    )

    snapshot = metadata.to_domain_snapshot(now_ms=UPDATED_AT + 100)

    assert snapshot.domain == "trades"
    assert snapshot.data["trades"] == data["trades"]
    assert metadata.last_trade_id == "trade-2"
    assert metadata.to_dict()["last_trade_id"] == "trade-2"


def test_kline_metadata_requires_symbol_and_preserves_revision() -> None:
    bars = [
        {
            "open_time": 1_720_000_000_000,
            "close": "100",
            "revision_epoch": 4,
            "revision_seq": 12,
        }
    ]
    revision = {
        "epoch": 4,
        "sequence": 12,
        "is_closed": False,
        "close_state_source": "PROVIDER_CONFIRMED",
    }
    metadata = MarketKlineCacheMetadata(
        data=bars,
        source="REST_SNAPSHOT",
        provider="OKX_SPOT",
        updated_at=UPDATED_AT,
        version="v1",
        interval="1m",
        last_open_time=1_720_000_000_000,
        revision=revision,
    )

    snapshot = metadata.to_domain_snapshot(
        symbol="BTCUSDT",
        now_ms=UPDATED_AT + 1_000,
    )

    assert snapshot.symbol == "BTCUSDT"
    assert snapshot.domain == "kline"
    assert snapshot.data == bars
    assert snapshot.freshness == "LIVE"
    assert metadata.revision == revision
    assert metadata.to_dict()["revision"] == revision


def test_snapshot_freshness_reports_stale_and_missing_without_mutating_metadata() -> None:
    ticker = MarketTickerCacheMetadata(
        data={"symbol": "BTCUSDT", "last_price": "60000"},
        source="external",
        provider="OKX_SPOT",
        updated_at=UPDATED_AT,
    )
    stale = ticker.to_domain_snapshot(now_ms=UPDATED_AT + 1_501)
    assert stale.freshness == "STALE"
    assert stale.age_ms == 1_501

    kline = MarketKlineCacheMetadata(
        data=[],
        source="DB_CACHE",
        provider=None,
        updated_at=None,
        version="v1",
        interval="1Dutc",
        last_open_time=None,
        revision=None,
    )
    missing = kline.to_domain_snapshot(symbol="BTCUSDT", now_ms=UPDATED_AT)
    assert missing.freshness == "MISSING"
    assert missing.age_ms is None
    assert missing.provider is None


def test_snapshot_to_dict_is_internal_and_detached_from_metadata_data() -> None:
    metadata = MarketTickerCacheMetadata(
        data={"symbol": "BTCUSDT", "last_price": "60000"},
        source="external",
        provider="OKX_SPOT",
        updated_at=UPDATED_AT,
    )
    snapshot = metadata.to_domain_snapshot(now_ms=UPDATED_AT)

    payload = snapshot.to_dict()
    payload["data"]["last_price"] = "1"

    assert metadata.data["last_price"] == "60000"
    assert snapshot.data["last_price"] == "60000"
    assert set(payload) == {
        "symbol",
        "domain",
        "data",
        "source",
        "provider",
        "freshness",
        "updated_at",
        "age_ms",
        "version",
        "fallback_reason",
    }
