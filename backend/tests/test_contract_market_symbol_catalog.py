from __future__ import annotations

from types import SimpleNamespace

from app.routers import contract_market


def test_symbol_catalog_reads_control_plane_without_public_snapshot_cache(
    monkeypatch,
) -> None:
    expected = {
        "items": [],
        "total": 0,
        "page": 1,
        "page_size": 100,
    }
    monkeypatch.setattr(
        contract_market,
        "cache_fetch_json",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("symbol availability must not use stale snapshot cache")
        ),
    )
    monkeypatch.setattr(
        contract_market,
        "_load_with_short_session",
        lambda _loader: expected,
    )

    response = contract_market.contract_market_symbols(
        request=SimpleNamespace(state=SimpleNamespace(trace_id="catalog-test")),
        category="all",
        quote="all",
        keyword=None,
        page=1,
        page_size=100,
    )

    assert response["ok"] is True
    assert response["data"] == expected
    assert response["trace_id"] == "catalog-test"


def test_cached_contract_tickers_drop_only_configured_disabled_symbols(
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        contract_market,
        "_load_with_short_session",
        lambda _loader: {"symbols": ["DJIUSDT_PERP"]},
    )

    filtered = contract_market._filter_disabled_configured_contract_tickers({
        "items": [
            {"symbol": "DJIUSDT_PERP", "last_price": "1"},
            {"symbol": "AAPLUSDT_PERP", "last_price": "2"},
        ],
    })

    assert [item["symbol"] for item in filtered["items"]] == ["AAPLUSDT_PERP"]


def test_dynamic_unconfigured_contract_symbol_is_not_rejected(monkeypatch) -> None:
    monkeypatch.setattr(
        contract_market,
        "_configured_contract_symbol_status",
        lambda _symbol: None,
    )

    contract_market._raise_if_configured_contract_symbol_disabled("AAPLUSDT_PERP")
