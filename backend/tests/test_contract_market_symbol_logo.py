from __future__ import annotations

from types import SimpleNamespace

from app.routers import contract_market


class _AssetLogoQuery:
    def __init__(self, rows) -> None:
        self.rows = rows
        self.filter_count = 0

    def filter(self, _expression):
        self.filter_count += 1
        return self

    def all(self):
        return self.rows


class _AssetLogoSession:
    def __init__(self, rows) -> None:
        self.query_count = 0
        self.query_object = _AssetLogoQuery(rows)

    def query(self, *_columns):
        self.query_count += 1
        return self.query_object


def _contract_symbol(symbol: str, quote_asset: str = "USDT"):
    return SimpleNamespace(
        symbol=symbol,
        display_name=symbol,
        category="CRYPTO",
        provider="BINANCE",
        provider_symbol=symbol.replace("_PERP", "-SWAP"),
        quote_asset=quote_asset,
        tp_sl_trigger_price_type="MARK_PRICE",
        closed_market_execution_mode="DISABLED",
        holiday_calendar_code=None,
        session_profile_code="CRYPTO_24_7",
        session_timezone_override=None,
        extended_hours_execution_mode="DISPLAY_ONLY",
        price_precision=2,
        quantity_precision=3,
        max_leverage=100,
        status=1,
    )


def test_contract_logo_lookup_batches_assets_and_derives_base_symbols() -> None:
    session = _AssetLogoSession(
        [SimpleNamespace(symbol="BTC", icon_url="/static/uploads/assets/btc.svg")]
    )
    items = [
        _contract_symbol("BTCUSDT_PERP"),
        _contract_symbol("ETHUSDT_PERP"),
        _contract_symbol("ALUMINUM_PERP"),
    ]

    result = contract_market._load_contract_base_asset_logo_urls(session, items)

    assert session.query_count == 1
    assert session.query_object.filter_count == 1
    assert result == {"BTC": "/static/uploads/assets/btc.svg"}
    assert contract_market._contract_base_asset_symbol(items[0]) == "BTC"
    assert contract_market._contract_base_asset_symbol(items[2]) == "ALUMINUM"


def test_contract_symbol_payload_exposes_base_asset_logo(monkeypatch) -> None:
    item = _contract_symbol("BTCUSDT_PERP")
    monkeypatch.setattr(
        contract_market,
        "contract_symbol_market_status_payload",
        lambda _item: {},
    )

    payload = contract_market._contract_symbol_payload(
        item,
        {"BTC": "/static/uploads/assets/btc.svg"},
    )

    assert payload["base_asset"] == "BTC"
    assert payload["base_asset_logo_url"] == "/static/uploads/assets/btc.svg"
