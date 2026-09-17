from decimal import Decimal
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from starlette.requests import Request
from starlette.responses import Response
from sqlalchemy import create_engine, event
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.db.models.asset import UserBalance
from app.db.models.spot_fee_settings import SpotFeeSettings
from app.db.models.trade import Trade
from app.db.models.trading_pair import TradingPair
from app.db.models.user_fee_preference import UserFeePreference
from app.deps.auth import get_current_user_id
from app.routers.spot import router, spot_fee_payment_context
from app.services import fee_service
from app.services.spot_fee_preview_service import get_spot_fee_payment_context


@pytest.fixture
def db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    for model in (UserBalance, SpotFeeSettings, Trade, TradingPair, UserFeePreference):
        model.__table__.create(engine)
    with Session(engine) as session:
        yield session
    engine.dispose()


def seed(db):
    db.add_all([
        TradingPair(id=1, symbol="RCBUSDT", base_asset_id=1, quote_asset_id=2),
        Trade(id=1, trading_pair_id=1, buy_order_id=1, sell_order_id=2,
              buyer_user_id=1, seller_user_id=2, price=Decimal("2"), amount=1,
              quote_amount=2, maker_order_id=1, taker_order_id=2),
        UserFeePreference(id=1, user_id=7, use_rcb_fee=True),
        UserBalance(id=1, user_id=7, coin_symbol="RCB", chain_key="funding", available_amount=1000, frozen_amount=0),
        UserBalance(id=2, user_id=8, coin_symbol="RCB", chain_key="spot", available_amount=200, frozen_amount=0),
    ])
    db.commit()


def test_context_uses_only_current_users_spot_balance_and_issues_only_reads(db):
    seed(db)
    statements = []
    def capture(_conn, _cursor, statement, _parameters, _context, _executemany):
        statements.append(statement)
    event.listen(db.bind, "before_cursor_execute", capture)
    context = get_spot_fee_payment_context(db, 7)
    assert context["use_rcb_fee"] is True
    assert Decimal(context["rcb_spot_available"]) == 0
    assert Decimal(context["rcb_usdt_price"]) == 2
    assert all(sql.lstrip().upper().startswith("SELECT") for sql in statements)
    assert all("FOR UPDATE" not in sql.upper() for sql in statements)
    event.remove(db.bind, "before_cursor_execute", capture)


def test_missing_preferences_and_price_are_not_created_or_invented(db):
    context = get_spot_fee_payment_context(db, 7)
    assert context["use_rcb_fee"] is False
    assert context["rcb_usdt_price"] is None
    assert Decimal(context["rcb_spot_available"]) == 0
    assert db.query(UserFeePreference).count() == 0
    assert db.query(UserBalance).count() == 0


def test_conversion_price_and_balance_agree_with_actual_fee_selection(db):
    seed(db)
    db.add(UserBalance(id=3, user_id=7, coin_symbol="RCB", chain_key="spot", available_amount=1, frozen_amount=5))
    db.commit()
    context = get_spot_fee_payment_context(db, 7)
    assert Decimal(context["rcb_spot_available"]) == 1
    pair = SimpleNamespace(symbol="ETHUSDT")
    trade = SimpleNamespace(price=Decimal("2500"))
    assert fee_service._load_rcb_usdt_price(db, pair, trade) == Decimal(context["rcb_usdt_price"])
    actual = fee_service._select_fee_payment(db, user_id=7, fee_usdt=Decimal("1"), snapshot=None, current_pair=pair, trade=trade, rcb_usdt_price=None)
    assert actual == ("RCB", Decimal("0.375"))
    # RCB/USDT itself still uses its own fill price for settlement.
    assert fee_service._load_rcb_usdt_price(db, SimpleNamespace(symbol="RCBUSDT"), SimpleNamespace(price=Decimal("3"))) == Decimal("3")


def test_endpoint_requires_authentication_and_disables_caching(db):
    route = next(route for route in router.routes if route.path == "/spot/fee-payment-context")
    assert get_current_user_id in [dependency.call for dependency in route.dependant.dependencies]
    with pytest.raises(HTTPException) as error:
        get_current_user_id(Request({"type": "http", "headers": []}), db)
    assert error.value.status_code == 401
    response = Response()
    body = spot_fee_payment_context(response, db, "7")
    assert response.headers["cache-control"] == "private, no-store"
    assert body["use_rcb_fee"] is False
