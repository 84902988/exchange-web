from types import SimpleNamespace

from app.routers import market


class _BackgroundTasks:
    def __init__(self) -> None:
        self.tasks = []

    def add_task(self, function, *args, **kwargs) -> None:
        self.tasks.append((function, args, kwargs))


def test_mobile_overview_serves_last_good_and_revalidates_after_response(monkeypatch) -> None:
    background_tasks = _BackgroundTasks()
    promoted = []
    cache_key_calls = []
    preferred_symbols = ["BTCUSDT", "RCBUSDT", "ETHUSDT", "NVDAUSDT_PERP"]
    last_good = {
        "overview_cards": [{"symbol": "BTCUSDT"}],
        "sections": [],
        "source": "live",
        "stale": False,
    }

    real_market_cache_key = market.market_cache_key

    def capture_market_cache_key(*args, **kwargs):
        cache_key_calls.append((args, kwargs))
        real_market_cache_key(*args, **kwargs)
        return "mobile-key"

    monkeypatch.setattr(market, "market_cache_key", capture_market_cache_key)
    monkeypatch.setattr(
        market,
        "get_mobile_overview_symbol_config",
        lambda db: preferred_symbols,
    )
    monkeypatch.setattr(market, "cache_get_json", lambda key: None)
    monkeypatch.setattr(market, "cache_get_last_good_json", lambda key: last_good)
    monkeypatch.setattr(
        market,
        "cache_set_json",
        lambda key, payload, ttl, **kwargs: promoted.append((key, payload, ttl, kwargs)),
    )
    monkeypatch.setattr(
        market,
        "filter_active_mobile_market_overview",
        lambda db, payload: payload,
    )
    monkeypatch.setattr(
        market,
        "get_mobile_market_overview",
        lambda db, preferred_symbols: (_ for _ in ()).throw(
            AssertionError("must refresh after response")
        ),
    )

    payload = market.mobile_overview(background_tasks=background_tasks, db=object())

    assert payload["source"] == "last_good"
    assert payload["stale"] is True
    assert payload["is_stale"] is True
    assert payload["stale_reason"] == "revalidating"
    assert cache_key_calls[0][1]["query_params"] == {
        "shortcut_symbols": preferred_symbols,
    }
    assert promoted[0][0] == "mobile-key"
    assert promoted[0][2] == market.MARKET_MOBILE_OVERVIEW_CACHE_TTL_SECONDS
    assert background_tasks.tasks == [
        (
            market._refresh_mobile_overview_cache,
            ("mobile-key", preferred_symbols),
            {},
        ),
    ]


def test_mobile_overview_active_cache_does_not_schedule_refresh(monkeypatch) -> None:
    background_tasks = _BackgroundTasks()
    active_payload = {
        "overview_cards": [{"symbol": "BTCUSDT"}],
        "sections": [],
        "source": "live",
        "stale": False,
    }

    monkeypatch.setattr(market, "market_cache_key", lambda *args, **kwargs: "mobile-key")
    monkeypatch.setattr(
        market,
        "get_mobile_overview_symbol_config",
        lambda db: ["BTCUSDT", "RCBUSDT", "ETHUSDT", "NVDAUSDT_PERP"],
    )
    monkeypatch.setattr(market, "cache_get_json", lambda key: active_payload)
    monkeypatch.setattr(
        market,
        "cache_get_last_good_json",
        lambda key: (_ for _ in ()).throw(AssertionError("active cache must win")),
    )
    monkeypatch.setattr(
        market,
        "filter_active_mobile_market_overview",
        lambda db, payload: payload,
    )

    payload = market.mobile_overview(background_tasks=background_tasks, db=object())

    assert payload["source"] == "cache"
    assert payload["stale"] is False
    assert background_tasks.tasks == []


def test_mobile_overview_background_refresh_uses_and_closes_own_session(monkeypatch) -> None:
    fake_db = SimpleNamespace(closed=False)
    fake_db.close = lambda: setattr(fake_db, "closed", True)
    stored = []

    monkeypatch.setattr(market, "SessionLocal", lambda: fake_db)
    monkeypatch.setattr(
        market,
        "get_mobile_market_overview",
        lambda db, preferred_symbols: {
            "overview_cards": [],
            "sections": [],
            "source": "live",
        },
    )
    monkeypatch.setattr(
        market,
        "cache_set_json",
        lambda key, payload, ttl, **kwargs: stored.append((key, payload, ttl, kwargs)),
    )

    market._refresh_mobile_overview_cache(
        "mobile-key",
        ["BTCUSDT", "RCBUSDT", "ETHUSDT", "NVDAUSDT_PERP"],
    )

    assert fake_db.closed is True
    assert stored[0][0] == "mobile-key"
    assert stored[0][1]["source"] == "live"
    assert stored[0][2] == market.MARKET_MOBILE_OVERVIEW_CACHE_TTL_SECONDS
