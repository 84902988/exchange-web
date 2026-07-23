from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.services import contract_market_service
from app.services.itick_market_service import ItickMarketService


def test_itick_market_quotes_by_code_uses_one_batch_request(monkeypatch) -> None:
    service = ItickMarketService()
    calls: list[tuple[str, dict, dict]] = []

    def fake_request(path: str, params: dict, **kwargs):
        calls.append((path, params, kwargs))
        return {
            "data": [
                {"s": "EURUSD", "ld": "1.12", "p": "1.10"},
                {"s": "GBPUSD", "ld": "1.31", "p": "1.30"},
            ]
        }

    monkeypatch.setattr(service, "_request_json", fake_request)

    result = service.get_market_quotes_by_code(
        "forex",
        "GB",
        ["EURUSD", "GBPUSD", "EURUSD"],
        timeout=3,
    )

    assert len(calls) == 1
    assert calls[0][0] == "/quotes"
    assert calls[0][1] == {"region": "GB", "codes": "EURUSD,GBPUSD"}
    assert calls[0][2]["timeout"] == 3
    assert result["EURUSD"]["latest_price"] == "1.12"
    assert result["GBPUSD"]["latest_price"] == "1.31"


def test_contract_cfd_tickers_share_provider_batch(monkeypatch) -> None:
    rows = [
        SimpleNamespace(symbol="EURUSD_PERP", provider_symbol="EURUSD", category="FOREX"),
        SimpleNamespace(symbol="GBPUSD_PERP", provider_symbol="GBPUSD", category="FOREX"),
        SimpleNamespace(symbol="USDJPY_PERP", provider_symbol="USDJPY", category="FOREX"),
    ]
    batch_calls: list[tuple[str, str, list[str], int]] = []

    monkeypatch.setattr(
        contract_market_service,
        "_get_cached_tradfi_quote_for_contract",
        lambda *_args, **_kwargs: None,
    )
    monkeypatch.setattr(
        contract_market_service.itick_market_service,
        "is_quote_depth_cooldown_active",
        lambda: False,
    )

    def fake_batch(market: str, region: str, codes: list[str], timeout: int):
        batch_calls.append((market, region, codes, timeout))
        return {
            code: {"s": code, "p": str(index + 1), "o": "1"}
            for index, code in enumerate(codes)
        }

    monkeypatch.setattr(
        contract_market_service.itick_market_service,
        "get_market_quotes_by_code",
        fake_batch,
    )
    monkeypatch.setattr(
        contract_market_service,
        "_contract_ticker_from_itick_cfd",
        lambda row, *, quote_item=None: {
            "symbol": row.symbol,
            "last_price": quote_item["p"] if quote_item else None,
        },
    )

    result = contract_market_service._itick_cfd_tickers_from_symbols(SimpleNamespace(), rows)

    assert batch_calls == [
        ("forex", "GB", ["EURUSD", "GBPUSD", "USDJPY"], 3),
    ]
    assert [item["symbol"] for item in result] == [row.symbol for row in rows]
    assert [item["last_price"] for item in result] == ["1", "2", "3"]


def test_contract_cfd_batch_omission_does_not_fan_out_single_requests(monkeypatch) -> None:
    rows = [
        SimpleNamespace(symbol="EURUSD_PERP", provider_symbol="EURUSD", category="FOREX"),
        SimpleNamespace(symbol="GBPUSD_PERP", provider_symbol="GBPUSD", category="FOREX"),
    ]
    received_quote_items: list[dict] = []

    monkeypatch.setattr(
        contract_market_service,
        "_get_cached_tradfi_quote_for_contract",
        lambda *_args, **_kwargs: None,
    )
    monkeypatch.setattr(
        contract_market_service.itick_market_service,
        "is_quote_depth_cooldown_active",
        lambda: False,
    )
    monkeypatch.setattr(
        contract_market_service.itick_market_service,
        "get_market_quotes_by_code",
        lambda *_args, **_kwargs: {"EURUSD": {"s": "EURUSD", "p": "1.12"}},
    )

    def fake_ticker(row, *, quote_item=None):
        received_quote_items.append(quote_item)
        return {"symbol": row.symbol, "last_price": quote_item.get("p")}

    monkeypatch.setattr(contract_market_service, "_contract_ticker_from_itick_cfd", fake_ticker)

    result = contract_market_service._itick_cfd_tickers_from_symbols(SimpleNamespace(), rows)

    assert [item["symbol"] for item in result] == [row.symbol for row in rows]
    assert received_quote_items == [{"s": "EURUSD", "p": "1.12"}, {}]


def test_contract_ticker_batch_carries_catalog_price_precision(monkeypatch) -> None:
    rows = [
        SimpleNamespace(
            symbol="EURUSD_PERP",
            provider="ITICK",
            provider_symbol="EURUSD",
            category="FOREX",
            price_precision=5,
        ),
        SimpleNamespace(
            symbol="USDJPY_PERP",
            provider="ITICK",
            provider_symbol="USDJPY",
            category="FOREX",
            price_precision=3,
        ),
    ]

    class QueryStub:
        def filter(self, *_args):
            return self

        def order_by(self, *_args):
            return self

        def limit(self, _limit):
            return self

        def all(self):
            return rows

    db = SimpleNamespace(query=lambda _model: QueryStub())
    monkeypatch.setattr(contract_market_service, "attach_contract_symbol_market_metadata", lambda *_args: None)
    monkeypatch.setattr(
        contract_market_service,
        "_itick_cfd_tickers_from_symbols",
        lambda _db, _rows: [
            {"symbol": "EURUSD_PERP", "last_price": "1.14080"},
            {"symbol": "USDJPY_PERP", "last_price": "163.009"},
        ],
    )
    monkeypatch.setattr(
        contract_market_service,
        "_market_status_for_contract_symbol",
        lambda *_args: object(),
    )
    monkeypatch.setattr(contract_market_service, "_with_market_status", lambda item, _status: item)

    result = contract_market_service.get_contract_tickers(db, limit=2)

    assert [(item["symbol"], item["price_precision"]) for item in result] == [
        ("EURUSD_PERP", 5),
        ("USDJPY_PERP", 3),
    ]
