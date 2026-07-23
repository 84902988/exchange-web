from __future__ import annotations

from datetime import datetime
from decimal import Decimal
import sys
from pathlib import Path
from types import SimpleNamespace

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.services import contract_market_service
from app.services import market
from app.services.itick_market_service import ItickMarketService


def _clear_cache_ttl_env(monkeypatch) -> None:
    for name in (
        "ITICK_QUOTE_CACHE_TTL_SECONDS",
        "ITICK_DEPTH_CACHE_TTL_SECONDS",
        "ITICK_QUOTE_DEPTH_CACHE_TTL_SECONDS",
        "ITICK_QUOTE_DEPTH_STALE_TTL_SECONDS",
    ):
        monkeypatch.delenv(name, raising=False)


def test_quote_enrichment_keeps_latest_price_and_previous_close_distinct() -> None:
    service = ItickMarketService()

    item = service._enrich_stock_quote_item(
        {
            "s": "AAPL",
            "ld": "202.50",
            "p": "200.00",
            "price": "199.00",
            "v": "10",
        }
    )

    assert item["latest_price"] == "202.50"
    assert item["price"] == "202.50"
    assert item["previous_close"] == "200.00"
    assert item["quote_volume_24h"] == 2025.0


def test_quote_item_cache_refreshes_at_15_seconds_while_depth_stays_60(
    monkeypatch,
) -> None:
    _clear_cache_ttl_env(monkeypatch)
    service = ItickMarketService()
    clock = [100.0]
    monkeypatch.setattr("app.services.itick_market_service.time.monotonic", lambda: clock[0])

    service._set_quote_item_cache("stock:US:AAPL", {"ld": "202.50"})
    service._set_response_cache("depth-key", {"data": {"b": [], "a": []}})

    clock[0] = 116.0

    assert service._get_cached_quote_item("stock:US:AAPL") is None
    assert service._get_response_cache("depth-key", endpoint="/depth") == {
        "data": {"b": [], "a": []}
    }

    clock[0] = 161.0
    assert service._get_response_cache("depth-key", endpoint="/depth") is None


def test_request_json_populates_quote_response_cache(monkeypatch) -> None:
    _clear_cache_ttl_env(monkeypatch)
    monkeypatch.setenv("ITICK_API_TOKEN", "test-token")
    service = ItickMarketService()
    calls: list[tuple[str, dict]] = []

    class Response:
        status_code = 200
        url = "https://api0.itick.org/stock/quote"
        text = ""

        @staticmethod
        def json():
            return {"code": 0, "data": {"s": "AAPL", "ld": "202.50", "p": "200.00"}}

    def get(url, *, params, headers, timeout):
        del headers, timeout
        calls.append((url, dict(params)))
        return Response()

    monkeypatch.setattr(service._session, "get", get)

    first = service._request_json("/quote", {"region": "US", "code": "AAPL"})
    second = service._request_json("/quote", {"region": "US", "code": "AAPL"})

    assert first == second
    assert len(calls) == 1


def test_contract_ticker_semantics_use_ld_for_latest_and_p_for_change_baseline() -> None:
    price, field = contract_market_service._pick_itick_quote_reference_price(
        {"ld": "202.50", "p": "200.00"}
    )
    metrics = contract_market_service._extract_itick_24h_ticker_fields(
        {"ld": "202.50", "p": "200.00"},
        last_price=price,
    )

    assert price == Decimal("202.50")
    assert field == "ld"
    assert metrics["open_24h"] == "200.00"
    assert metrics["price_change_24h"] == "2.50"
    assert metrics["price_change_percent_24h"] == "1.2500"


def test_market_ticker_semantics_use_ld_for_latest_and_p_for_change_baseline() -> None:
    pair = SimpleNamespace(
        symbol="AAPLUSDT",
        price_precision=2,
        amount_precision=6,
    )
    data = {
        "ld": "202.50",
        "p": "200.00",
        "h": "203.00",
        "l": "199.00",
        "v": "10",
        "t": datetime.utcnow().timestamp(),
    }

    ticker = market._get_itick_ticker(
        pair,
        allow_upstream=False,
        quote_data=data,
    )

    assert ticker is not None
    assert ticker.last_price == "202.50"
    assert ticker.open_24h == "200.00"
    assert ticker.price_change_24h == "2.50"
    assert ticker.price_change_percent == "1.25"
