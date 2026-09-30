from types import SimpleNamespace
from unittest.mock import Mock, patch

from app.services import market


def test_full_stock_catalog_batches_quotes_without_truncating_membership():
    catalog = [SimpleNamespace(symbol=f"STOCK{i:03d}USDT_PERP", provider_symbol=f"STOCK{i:03d}") for i in range(205)]
    db = Mock()
    db.query.return_value.filter.return_value.all.return_value = catalog
    batches = []

    def tickers(db, symbols, limit):
        assert len(symbols) == limit <= 200
        batches.append(list(symbols))
        return [{"symbol": symbol, "last_price": "10.25"} for symbol in symbols]

    with patch.object(market, "get_contract_tickers", side_effect=tickers):
        rows = market._mobile_stock_contract_rows(db, [catalog[-1].symbol])
    assert len(rows) == 205
    assert [len(batch) for batch in batches] == [200, 5]
    assert rows[0]["symbol"] == catalog[-1].symbol
    assert all(row["last_price"] == "10.25" for row in rows)


def test_overview_keeps_full_stock_section_and_cfd_classification():
    stocks = [{"symbol": f"STOCK{i}USDT_PERP", "market_category": "STOCK", "last_price": "10"} for i in range(101)]
    cfd = [{"symbol": f"CFD{i}_PERP", "market_category": category} for i, category in enumerate(["GOLD", "METAL", "COMMODITY", "FOREX", "INDEX"])]
    routes = {row["symbol"]: {"tradable": True, "trade_market": "contract", "trade_symbol": row["symbol"], "trade_status": "ENABLED"} for row in stocks + cfd}
    with patch.object(market, "get_market_pairs", return_value={"items": []}), \
         patch.object(market, "get_market_tickers", return_value=[]), \
         patch.object(market, "_mobile_stock_contract_rows", return_value=stocks), \
         patch.object(market, "_mobile_cfd_contract_rows", return_value=cfd), \
         patch.object(market, "_mobile_contract_trade_routes", return_value=routes):
        payload = market.get_mobile_market_overview(object(), preferred_symbols=[])
    sections = {s["key"]: s["items"] for s in payload["sections"]}
    assert len(sections["stocks"]) == 101
    assert len(payload["overview_cards"]) == 6
    assert {r["market_category"] for r in sections["contract_cfd"]} == {r["market_category"] for r in cfd}
    assert all(row["tradable"] for row in sections["stocks"])
