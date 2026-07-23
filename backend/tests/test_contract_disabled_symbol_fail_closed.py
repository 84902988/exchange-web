from __future__ import annotations

from types import SimpleNamespace

import pytest

from app.db.models.contract_symbol import ContractSymbol
from app.services import contract_market_service as market_service
from app.services import market_cache


SYMBOL = "DJIUSDT_PERP"


class _SingleSymbolQuery:
    def __init__(self, row):
        self._row = row

    def filter(self, *_args):
        return self

    def first(self):
        return self._row


class _SingleSymbolDb:
    def __init__(self, row):
        self._row = row

    def query(self, *_args):
        return _SingleSymbolQuery(self._row)


@pytest.mark.parametrize(
    "loader",
    (
        lambda db: market_service.get_contract_quote(db, SYMBOL),
        lambda db: market_service.get_contract_depth(db, SYMBOL),
        lambda db: market_service.get_contract_klines(db, SYMBOL),
        lambda db: market_service.get_contract_recent_trades(db, SYMBOL),
    ),
)
def test_disabled_configured_symbol_never_uses_dynamic_stock_fallback(loader) -> None:
    disabled = SimpleNamespace(symbol=SYMBOL, status=0)

    with pytest.raises(market_service.ContractSymbolDisabled):
        loader(_SingleSymbolDb(disabled))


def test_disabled_symbol_is_not_reintroduced_by_ticker_batch_fallback(
    monkeypatch,
) -> None:
    class Query:
        def __init__(self, rows):
            self._rows = rows

        def filter(self, *_args):
            return self

        def order_by(self, *_args):
            return self

        def limit(self, _limit):
            return self

        def all(self):
            return self._rows

    class Db:
        def query(self, model):
            if model is ContractSymbol:
                return Query([])
            return Query([(SYMBOL,)])

    monkeypatch.setattr(
        market_service,
        "_stock_contract_tickers_from_symbols",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("disabled symbol must not use dynamic ticker fallback")
        ),
    )

    assert market_service.get_contract_tickers(Db(), symbols=[SYMBOL]) == []


def test_market_cache_never_serves_last_good_for_disabled_symbol(
    monkeypatch,
) -> None:
    class DisabledError(RuntimeError):
        code = "CONTRACT_SYMBOL_NOT_FOUND"

    monkeypatch.setattr(
        market_cache,
        "cache_get_last_good_json",
        lambda _key: {"symbol": SYMBOL, "source": "LAST_GOOD"},
    )

    with pytest.raises(DisabledError):
        market_cache._load_and_store_json(
            "contract:quote:disabled-test",
            3,
            lambda: (_ for _ in ()).throw(DisabledError("disabled")),
            last_good_ttl_seconds=60,
            fallback_on_error=True,
        )
