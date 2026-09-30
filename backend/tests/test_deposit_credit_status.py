import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session

from app.services.deposit_credit_status import load_deposit_credit_destinations


@pytest.fixture
def db():
    engine = create_engine('sqlite://')
    with Session(engine) as session:
        for sql in [
            'CREATE TABLE deposits (id INTEGER, user_id INTEGER, coin_symbol TEXT, amount NUMERIC)',
            'CREATE TABLE balance_logs (user_id INTEGER, coin_symbol TEXT, biz_type TEXT, biz_id TEXT, change_amount NUMERIC)',
            'CREATE TABLE user_stock_token_locks (user_id INTEGER, lock_symbol TEXT, source_type TEXT, source_id INTEGER, total_amount NUMERIC)',
            "INSERT INTO deposits VALUES (1,10,'USDT',5),(2,10,'STOCK',3),(3,20,'USDT',5),(4,10,'USDT',5)",
        ]:
            session.execute(text(sql))
        yield session


def test_confirmation_without_credit_is_not_credited(db):
    assert load_deposit_credit_destinations(db, 10, [1, 2, 3, 4]) == {1: None, 2: None, 4: None}


def test_funding_and_stock_lock_evidence(db):
    db.execute(text("INSERT INTO balance_logs VALUES (10,'USDT','DEPOSIT','1',5)"))
    db.execute(text("INSERT INTO user_stock_token_locks VALUES (10,'STOCK','DEPOSIT',2,3)"))
    assert load_deposit_credit_destinations(db, 10, [1, 2]) == {1: 'funding', 2: 'stock_token_lock'}


@pytest.mark.parametrize('user,symbol,biz,amount', [
    (20, 'USDT', 'DEPOSIT', 5), (10, 'ETH', 'DEPOSIT', 5),
    (10, 'USDT', 'TRANSFER', 5), (10, 'USDT', 'DEPOSIT', -5),
    (10, 'USDT', 'DEPOSIT', 1),
])
def test_unrelated_or_insufficient_ledger_rows_do_not_prove_credit(db, user, symbol, biz, amount):
    db.execute(text('INSERT INTO balance_logs VALUES (:u,:s,:b,\'1\',:a)'), {'u': user, 's': symbol, 'b': biz, 'a': amount})
    assert load_deposit_credit_destinations(db, 10, [1]) == {1: None}


def test_empty_list_never_queries():
    assert load_deposit_credit_destinations(None, 10, []) == {}
