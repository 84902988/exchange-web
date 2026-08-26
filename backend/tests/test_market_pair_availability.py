from __future__ import annotations

from types import SimpleNamespace

import app.services.market as market_service
from app.services.market import (
    _mobile_cfd_contract_pair_rows,
    _mobile_contract_trade_routes,
    _mobile_filter_pc_contract_catalog,
    _mobile_market_item,
    _mobile_stock_contract_pair_rows,
    filter_contract_authorized_trading_pairs,
    filter_active_mobile_market_overview,
    filter_active_trading_pair_rows,
    get_market_pairs,
)


def test_mobile_overview_exposes_complete_pc_cfd_catalog(monkeypatch) -> None:
    catalog = [
        ("XAGUSDT_PERP", "XAGUSD", "GOLD"),
        ("XAUUSDT_PERP", "XAUUSD", "GOLD"),
        ("BRENTUSDT_PERP", "XBRUSD", "FUTURES"),
        ("OILUSDT_PERP", "USOIL", "FUTURES"),
        ("NAS100USDT_PERP", "NAS100", "INDEX"),
        ("SPXUSDT_PERP", "SPX", "INDEX"),
        ("EURUSD_PERP", "EURUSD", "FOREX"),
        ("GBPUSD_PERP", "GBPUSD", "FOREX"),
        ("USDJPY_PERP", "USDJPY", "FOREX"),
    ]
    cfd_rows = [
        {
            "symbol": symbol,
            "display_symbol": provider_symbol,
            "display_name": provider_symbol,
            "market_category": category,
            "last_price": "1",
            "price_change_percent_24h": "0",
        }
        for symbol, provider_symbol, category in catalog
    ]
    routes = {
        symbol: {
            "tradable": True,
            "trade_market": "contract",
            "trade_symbol": symbol,
            "trade_status": "ENABLED",
        }
        for symbol, _provider_symbol, _category in catalog
    }
    monkeypatch.setattr(
        market_service,
        "get_market_pairs",
        lambda **_kwargs: {"items": []},
    )
    monkeypatch.setattr(
        market_service,
        "get_market_tickers",
        lambda **_kwargs: [],
    )
    monkeypatch.setattr(
        market_service,
        "_mobile_stock_contract_rows",
        lambda _db, _preferred_symbols: [],
    )
    monkeypatch.setattr(
        market_service,
        "_mobile_cfd_contract_rows",
        lambda _db: cfd_rows,
    )
    monkeypatch.setattr(
        market_service,
        "_mobile_contract_trade_routes",
        lambda _db, _pair_rows: routes,
    )

    payload = market_service.get_mobile_market_overview(
        object(),
        preferred_symbols=[],
    )
    cfd_items = next(
        section["items"]
        for section in payload["sections"]
        if section["key"] == "contract_cfd"
    )

    assert len(cfd_items) == 9
    assert {item["symbol"] for item in cfd_items} == {
        symbol for symbol, _provider_symbol, _category in catalog
    }
    assert all(item["tradable"] is True for item in cfd_items)


def test_mobile_cfd_rows_reuse_pc_contract_catalog_and_ticker_fields() -> None:
    catalog = [
        SimpleNamespace(
            symbol="XAUUSDT_PERP",
            provider_symbol="XAUUSD",
            category="GOLD",
            display_name="黄金 / USDT",
            price_precision=2,
            quantity_precision=3,
        )
    ]

    rows = _mobile_cfd_contract_pair_rows(
        catalog,
        [
            {
                "symbol": "XAUUSDT_PERP",
                "last_price": "2412.35",
                "price_change_percent_24h": "0.72",
                "quote_volume_24h": "150000",
                "source": "ITICK_QUOTE",
                "quote_freshness": "FRESH",
                "ts": 123456,
            }
        ],
    )

    assert rows == [
        {
            "symbol": "XAUUSDT_PERP",
            "external_symbol": "XAUUSD",
            "display_symbol": "XAUUSD",
            "display_name": "黄金 / USDT",
            "asset_type": "GOLD",
            "market_category": "GOLD",
            "last_price": "2412.35",
            "price_change_percent_24h": "0.72",
            "quote_volume_24h": "150000",
            "price_precision": 2,
            "amount_precision": 3,
            "source": "ITICK_QUOTE",
            "stale": False,
            "updated_at": 123456,
        }
    ]


def test_mobile_stock_contract_rows_reuse_real_contract_catalog_and_ticker_fields() -> None:
    catalog = [
        SimpleNamespace(
            symbol="NVDAUSDT_PERP",
            provider_symbol="NVDA",
            base_asset="NVDA",
            display_name="NVDAUSDT 永续",
            price_precision=2,
            quantity_precision=6,
        )
    ]
    rows = _mobile_stock_contract_pair_rows(
        catalog,
        [
            {
                "symbol": "NVDAUSDT_PERP",
                "last_price": "200.75",
                "price_change_percent_24h": "2.93",
                "quote_volume_24h": "1000",
                "source": "ITICK_QUOTE",
            }
        ],
    )

    assert rows == [
        {
            "symbol": "NVDAUSDT_PERP",
            "external_symbol": "NVDA",
            "display_symbol": "NVDA",
            "display_name": "NVIDIA",
            "asset_type": "STOCK",
            "market_category": "STOCK",
            "last_price": "200.75",
            "price_change_percent_24h": "2.93",
            "quote_volume_24h": "1000",
            "price_precision": 2,
            "amount_precision": 6,
            "source": "ITICK_QUOTE",
            "stale": False,
            "updated_at": None,
        }
    ]


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


def test_cached_mobile_cfd_keeps_only_canonical_pc_contract_symbol() -> None:
    payload = {
        "overview_cards": [],
        "sections": [
            {
                "key": "contract_cfd",
                "items": [
                    {
                        "symbol": "XAGUSDUSDT",
                        "category": "contract_cfd",
                        "trade_market": "contract",
                        "trade_symbol": "XAGUSDT_PERP",
                    },
                    {
                        "symbol": "XAGUSDT_PERP",
                        "category": "contract_cfd",
                        "trade_market": "contract",
                        "trade_symbol": "XAGUSDT_PERP",
                    },
                ],
            }
        ],
    }
    db = _ContractAvailabilitySession(
        pairs=[
            SimpleNamespace(symbol="XAGUSDUSDT"),
            SimpleNamespace(symbol="XAGUSDT_PERP"),
        ],
        contract_symbols=[SimpleNamespace(symbol="XAGUSDT_PERP")],
    )

    filtered = filter_active_mobile_market_overview(db, payload)

    assert [row["symbol"] for row in filtered["sections"][0]["items"]] == [
        "XAGUSDT_PERP"
    ]


def test_mobile_overview_annotates_authoritative_contract_routes_in_one_batch() -> None:
    pair_rows = [
        {
            "symbol": "XAGUSDUSDT",
            "display_symbol": "XAGUSD",
            "external_symbol": "XAGUSD",
            "market_category": "METAL",
        },
        {
            "symbol": "XAGEURUSDT",
            "display_symbol": "XAGEUR",
            "external_symbol": "XAGEUR",
            "market_category": "METAL",
        },
    ]
    db = _ContractAvailabilitySession(
        contract_symbols=[
            SimpleNamespace(
                symbol="XAGUSDT_PERP",
                provider_symbol="XAGUSD",
                status=1,
            ),
        ],
    )

    routes = _mobile_contract_trade_routes(db, pair_rows)

    assert routes["XAGUSDUSDT"] == {
        "tradable": True,
        "trade_market": "contract",
        "trade_symbol": "XAGUSDT_PERP",
        "trade_status": "ENABLED",
    }
    assert routes["XAGEURUSDT"] == {
        "tradable": False,
        "trade_market": "contract",
        "trade_symbol": None,
        "trade_status": "MARKET_DATA_ONLY",
    }
    assert db.query_count == 1


def test_mobile_market_item_exposes_spot_and_market_data_only_status() -> None:
    spot = _mobile_market_item(
        {
            "symbol": "BTCUSDT",
            "display_symbol": "BTC",
            "market_category": "CRYPTO",
        },
    )
    market_only = _mobile_market_item(
        {
            "symbol": "XAGEURUSDT",
            "display_symbol": "XAGEUR",
            "market_category": "METAL",
        },
        {},
    )

    assert spot["tradable"] is True
    assert spot["trade_market"] == "spot"
    assert spot["trade_symbol"] == "BTCUSDT"
    assert spot["trade_status"] == "ENABLED"
    assert market_only["tradable"] is False
    assert market_only["trade_market"] == "contract"
    assert market_only["trade_symbol"] is None
    assert market_only["trade_status"] == "MARKET_DATA_ONLY"


def test_mobile_cfd_filter_rejects_external_aliases_and_market_only_rows() -> None:
    items = [
        {"symbol": "BTCUSDT", "category": "spot", "tradable": True},
        {
            "symbol": "XAGUSDUSDT",
            "category": "contract_cfd",
            "tradable": True,
        },
        {
            "symbol": "XAGUSDT_PERP",
            "category": "contract_cfd",
            "tradable": True,
        },
        {
            "symbol": "XPTUSD",
            "category": "contract_cfd",
            "tradable": False,
        },
    ]

    filtered = _mobile_filter_pc_contract_catalog(items, {"XAGUSDT_PERP"})

    assert [item["symbol"] for item in filtered] == [
        "BTCUSDT",
        "XAGUSDT_PERP",
    ]
