from copy import deepcopy

import pytest
from sqlalchemy import create_engine, event, text
from sqlalchemy.orm import Session

from app.services.mobile_market_logos import enrich_mobile_market_logos


@pytest.fixture
def db():
    # Isolated metadata tables: never connects to the application database.
    engine = create_engine("sqlite://")
    with engine.begin() as conn:
        conn.execute(text("CREATE TABLE assets (id INTEGER, symbol TEXT, icon_url TEXT)"))
        conn.execute(text("CREATE TABLE trading_pairs (symbol TEXT, base_asset_id INTEGER, spot_logo_url TEXT, status INTEGER)"))
        conn.execute(text("CREATE TABLE contract_symbols (symbol TEXT, quote_asset TEXT, status INTEGER)"))
        conn.execute(text("INSERT INTO assets VALUES (1,'BTC','/btc.svg'),(2,'ETH','/eth.svg'),(3,'NVDA','/nvda.svg'),(4,'RCB','/rcb.svg'),(5,'EUR','/eur.svg')"))
        conn.execute(text("INSERT INTO trading_pairs VALUES ('BTCUSDT',1,NULL,1),('ETHUSDT',2,NULL,1),('RCBUSDT',4,'/custom-rcb.webp',1)"))
        conn.execute(text("INSERT INTO contract_symbols VALUES ('NVDAUSDT_PERP','USDT',1),('EURUSD_PERP','USD',1)"))
    with Session(engine) as session:
        yield session
    engine.dispose()


def overview():
    rows = [
        {"symbol": "BTCUSDT", "price": "100", "trade_market": "spot", "trade_symbol": "BTCUSDT"},
        {"symbol": "ETHUSDT", "price": "200"},
        {"symbol": "NVDAUSDT_PERP", "price": "300", "trade_market": "contract", "trade_symbol": "NVDAUSDT_PERP"},
        {"symbol": "RCBUSDT", "price": "2"},
    ]
    return {"overview_cards": rows, "sections": [{"key": "hot", "items": rows}], "stale": True, "updated_at": 123}


def test_spot_and_contract_logos_reach_every_surface_without_changing_quotes(db):
    payload = overview()
    original = deepcopy(payload)
    statements = []
    def record(_conn, _cursor, statement, *_args):
        statements.append(statement)
    event.listen(db.bind, "before_cursor_execute", record)
    result = enrich_mobile_market_logos(db, payload)
    event.remove(db.bind, "before_cursor_execute", record)
    assert len(statements) == 3
    assert payload == original
    for rows in (result["overview_cards"], result["sections"][0]["items"]):
        assert [r["base_asset_logo_url"] for r in rows] == ["/btc.svg", "/eth.svg", "/nvda.svg", "/rcb.svg"]
        assert rows[3]["spot_logo_url"] == "/custom-rcb.webp"
        for before, after in zip(original["overview_cards"], rows):
            assert all(after[key] == value for key, value in before.items())
    assert result["stale"] is True
    assert result["updated_at"] == 123


def test_current_edits_and_removal_override_last_good_logo_metadata(db):
    cached = enrich_mobile_market_logos(db, overview())
    db.execute(text("UPDATE assets SET icon_url='/new-btc.svg' WHERE symbol='BTC'"))
    db.execute(text("UPDATE assets SET icon_url=NULL WHERE symbol='NVDA'"))
    db.execute(text("UPDATE trading_pairs SET spot_logo_url=NULL WHERE symbol='RCBUSDT'"))
    result = enrich_mobile_market_logos(db, cached)
    for rows in (result["overview_cards"], result["sections"][0]["items"]):
        assert rows[0]["base_asset_logo_url"] == "/new-btc.svg"
        assert rows[2]["base_asset_logo_url"] is None
        assert rows[3]["spot_logo_url"] is None
        assert rows[3]["base_asset_logo_url"] == "/rcb.svg"
    assert cached["overview_cards"][2]["base_asset_logo_url"] == "/nvda.svg"


def test_missing_icons_and_contract_quote_suffix(db):
    result = enrich_mobile_market_logos(db, {"overview_cards": [
        {"symbol": "UNKNOWN"},
        {"symbol": "EURUSD_PERP", "trade_market": "contract", "trade_symbol": "EURUSD_PERP"},
    ], "sections": []})
    assert result["overview_cards"][0]["base_asset_logo_url"] is None
    assert result["overview_cards"][1]["base_asset_logo_url"] == "/eur.svg"


@pytest.mark.parametrize("last_good", [False, True])
def test_cached_overview_route_uses_current_logos(db, monkeypatch, last_good):
    from fastapi import BackgroundTasks
    from app.routers import market

    payload = overview()
    payload["stale"] = False
    monkeypatch.setattr(market, "get_mobile_overview_symbol_config", lambda db: [])
    monkeypatch.setattr(market, "cache_get_json", lambda key: None if last_good else payload)
    monkeypatch.setattr(market, "cache_get_last_good_json", lambda key: payload)
    monkeypatch.setattr(market, "cache_set_json", lambda *args, **kwargs: None)
    monkeypatch.setattr(market, "filter_active_mobile_market_overview", lambda db, data: data)
    tasks = BackgroundTasks()
    result = market.mobile_overview(background_tasks=tasks, db=db)
    assert result["overview_cards"][0]["base_asset_logo_url"] == "/btc.svg"
    assert result["sections"][0]["items"][2]["base_asset_logo_url"] == "/nvda.svg"
    assert result["source"] == ("last_good" if last_good else "cache")
    assert len(tasks.tasks) == int(last_good)
    assert "base_asset_logo_url" not in payload["overview_cards"][0]
