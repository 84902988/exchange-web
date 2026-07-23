from __future__ import annotations

from types import SimpleNamespace

from app.services.market import (
    filter_contract_authorized_trading_pairs,
    filter_active_mobile_market_overview,
    filter_active_trading_pair_rows,
    get_market_pairs,
)


class _ActivePairQuery:
    def __init__(self, symbols: list[str]) -> None:
        self._symbols = symbols

    def filter(self, *_args):
        return self

    def all(self):
        return [SimpleNamespace(symbol=symbol) for symbol in self._symbols]


class _ActivePairSession:
    def __init__(self, symbols: list[str]) -> None:
        self._symbols = symbols

    def query(self, *_args):
        return _ActivePairQuery(self._symbols)


class _RowsQuery:
    def __init__(self, rows: list[SimpleNamespace]) -> None:
        self._rows = rows

    def filter(self, *_args):
        return self

    def order_by(self, *_args):
        return self

    def all(self):
        return self._rows


class _ContractAvailabilitySession:
    def __init__(
        self,
        *,
        pairs: list[SimpleNamespace] | None = None,
        contract_symbols: list[SimpleNamespace] | None = None,
    ) -> None:
        self._pairs = pairs or []
        self._contract_symbols = contract_symbols or []
        self.query_count = 0
        self.info: dict[str, object] = {}

    def query(self, *_args):
        self.query_count += 1
        if self.query_count == 1 and self._pairs:
            return _RowsQuery(self._pairs)
        return _RowsQuery(self._contract_symbols)


def _contract_pair(symbol: str, external_symbol: str) -> SimpleNamespace:
    return SimpleNamespace(
        symbol=symbol,
        external_symbol=external_symbol,
        external_region="US",
        asset_type="INDEX",
        data_source="ITICK",
        market_mode="DEALER",
        market_category="INDEX",
        market_sub_category=None,
        display_category="INDEX",
        display_group="指数",
        base_asset=SimpleNamespace(symbol=external_symbol, icon_url=None),
        quote_asset=SimpleNamespace(symbol="USDT"),
        price_precision=2,
        amount_precision=6,
        sort_order=0,
        is_hot=False,
        show_spot_logo=False,
        spot_logo_url=None,
        spot_logo_alt=None,
        status=1,
    )


def test_contract_membership_uses_one_batched_authority_query() -> None:
    pairs = [
        _contract_pair("SPXUSDT", "SPX"),
        _contract_pair("DJIUSDT", "DJI"),
        _contract_pair("EURUSDUSDT", "EURUSD"),
    ]
    db = _ContractAvailabilitySession(
        contract_symbols=[
            SimpleNamespace(symbol="SPXUSDT_PERP", provider_symbol="SPX", status=1),
            SimpleNamespace(symbol="DJIUSDT_PERP", provider_symbol="DJI", status=0),
            SimpleNamespace(symbol="EURUSD_PERP", provider_symbol="EURUSD", status=1),
        ],
    )

    filtered = filter_contract_authorized_trading_pairs(db, pairs)

    assert [pair.symbol for pair in filtered] == ["SPXUSDT", "EURUSDUSDT"]
    assert db.query_count == 1


def test_spot_only_membership_does_not_query_contract_authority() -> None:
    pair = SimpleNamespace(
        symbol="BTCUSDT",
        external_symbol="BTCUSDT",
        asset_type="CRYPTO",
        market_category="CRYPTO",
        market_sub_category=None,
    )
    db = _ContractAvailabilitySession()

    filtered = filter_contract_authorized_trading_pairs(db, [pair])

    assert filtered == [pair]
    assert db.query_count == 0


def test_unconfigured_legacy_contract_pair_remains_available() -> None:
    pair = _contract_pair("US30USDT", "US30")
    db = _ContractAvailabilitySession(contract_symbols=[])

    filtered = filter_contract_authorized_trading_pairs(db, [pair])

    assert filtered == [pair]
    assert db.query_count == 1


def test_contract_authority_is_reused_within_one_db_session() -> None:
    pairs = [_contract_pair("SPXUSDT", "SPX")]
    db = _ContractAvailabilitySession(
        contract_symbols=[
            SimpleNamespace(symbol="SPXUSDT_PERP", provider_symbol="SPX", status=1),
        ],
    )

    first = filter_contract_authorized_trading_pairs(db, pairs)
    second = filter_contract_authorized_trading_pairs(db, pairs)

    assert first == pairs
    assert second == pairs
    assert db.query_count == 1


def test_contract_pair_catalog_applies_contract_symbol_authority_before_paging() -> None:
    pairs = [
        _contract_pair("SPXUSDT", "SPX"),
        _contract_pair("DJIUSDT", "DJI"),
    ]
    db = _ContractAvailabilitySession(
        pairs=pairs,
        contract_symbols=[
            SimpleNamespace(symbol="SPXUSDT_PERP", provider_symbol="SPX", status=1),
            SimpleNamespace(symbol="DJIUSDT_PERP", provider_symbol="DJI", status=0),
        ],
    )

    payload = get_market_pairs(
        db,
        market_type="contract",
        page=1,
        page_size=100,
    )

    assert payload["total"] == 1
    assert [row["symbol"] for row in payload["items"]] == ["SPXUSDT"]
    assert db.query_count == 2


def test_cached_contract_ticker_is_pruned_by_contract_symbol_authority() -> None:
    pairs = [
        _contract_pair("SPXUSDT", "SPX"),
        _contract_pair("DJIUSDT", "DJI"),
    ]
    db = _ContractAvailabilitySession(
        pairs=pairs,
        contract_symbols=[
            SimpleNamespace(symbol="SPXUSDT_PERP", provider_symbol="SPX", status=1),
            SimpleNamespace(symbol="DJIUSDT_PERP", provider_symbol="DJI", status=0),
        ],
    )
    rows = [
        {"symbol": "SPXUSDT", "last_price": "1"},
        {"symbol": "DJIUSDT", "last_price": "2"},
    ]

    filtered = filter_active_trading_pair_rows(db, rows)

    assert [row["symbol"] for row in filtered] == ["SPXUSDT"]
    assert db.query_count == 2


def test_cached_ticker_rows_are_pruned_by_current_active_membership() -> None:
    rows = [
        {"symbol": "BTCUSDT", "last_price": "1"},
        {"symbol": "MFCUSDT", "last_price": "2"},
    ]

    filtered = filter_active_trading_pair_rows(
        _ActivePairSession(["BTCUSDT"]),
        rows,
    )

    assert [row["symbol"] for row in filtered] == ["BTCUSDT"]


def test_cached_mobile_overview_is_pruned_in_every_membership_surface() -> None:
    payload = {
        "overview_cards": [
            {"symbol": "BTCUSDT"},
            {"symbol": "MFCUSDT"},
        ],
        "sections": [
            {
                "key": "hot",
                "items": [
                    {"symbol": "MFCUSDT"},
                    {"symbol": "BTCUSDT"},
                ],
            },
        ],
        "is_stale": True,
    }

    filtered = filter_active_mobile_market_overview(
        _ActivePairSession(["BTCUSDT"]),
        payload,
    )

    assert [row["symbol"] for row in filtered["overview_cards"]] == ["BTCUSDT"]
    assert [row["symbol"] for row in filtered["sections"][0]["items"]] == ["BTCUSDT"]
    assert filtered["is_stale"] is True
