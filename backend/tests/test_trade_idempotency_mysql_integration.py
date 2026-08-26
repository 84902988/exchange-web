from __future__ import annotations

import os
from concurrent.futures import ThreadPoolExecutor
from threading import Event
import time

import pytest
from sqlalchemy import create_engine, func, select, text
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session

from app.db.models.trade_idempotency_request import TradeIdempotencyRequest
from app.services.trade_idempotency_service import (
    claim_trade_idempotency,
    complete_trade_idempotency,
)


MYSQL_TEST_URL_ENV = "TRADE_IDEMPOTENCY_MYSQL_TEST_URL"
MYSQL_TEST_RESET_ENV = "TRADE_IDEMPOTENCY_MYSQL_ALLOW_RESET"
MYSQL_TEST_DATABASE = "exchange_idempotency_test"
MYSQL_TEST_USERNAME = "exchange_test"
MYSQL_TEST_EFFECTS_TABLE = "trade_idempotency_test_effects"


def _mysql_test_engine():
    raw_url = os.getenv(MYSQL_TEST_URL_ENV, "").strip()
    if not raw_url:
        pytest.skip(f"{MYSQL_TEST_URL_ENV} is not configured")
    if os.getenv(MYSQL_TEST_RESET_ENV, "").strip() != "YES":
        pytest.fail(
            f"{MYSQL_TEST_RESET_ENV}=YES is required because this test resets "
            "its dedicated schema"
        )

    url = make_url(raw_url)
    if not url.drivername.startswith("mysql+"):
        pytest.fail("trade idempotency integration test requires a MySQL driver")
    if url.host not in {"127.0.0.1", "localhost"}:
        pytest.fail("trade idempotency integration test only accepts local MySQL")
    if url.database != MYSQL_TEST_DATABASE or url.username != MYSQL_TEST_USERNAME:
        pytest.fail(
            "trade idempotency integration test requires the dedicated "
            f"{MYSQL_TEST_USERNAME}@{MYSQL_TEST_DATABASE} identity"
        )
    return create_engine(
        raw_url,
        future=True,
        isolation_level="REPEATABLE READ",
        pool_size=4,
        max_overflow=0,
        pool_pre_ping=True,
    )


@pytest.fixture()
def mysql_idempotency_engine():
    engine = _mysql_test_engine()
    try:
        with engine.begin() as connection:
            database_name = connection.scalar(text("SELECT DATABASE()"))
            isolation = connection.scalar(text("SELECT @@transaction_isolation"))
            assert database_name == MYSQL_TEST_DATABASE
            assert str(isolation).upper().replace("_", "-") == "REPEATABLE-READ"
            connection.execute(
                text(f"DROP TABLE IF EXISTS {MYSQL_TEST_EFFECTS_TABLE}")
            )
            TradeIdempotencyRequest.__table__.drop(connection, checkfirst=True)
            TradeIdempotencyRequest.__table__.create(connection)
            connection.execute(
                text(
                    f"""
                    CREATE TABLE {MYSQL_TEST_EFFECTS_TABLE} (
                        id BIGINT NOT NULL AUTO_INCREMENT,
                        client_order_id VARCHAR(64) NOT NULL,
                        PRIMARY KEY (id),
                        UNIQUE KEY uq_trade_idempotency_test_effect_client (client_order_id)
                    ) ENGINE=InnoDB
                    """
                )
            )
            table_engine = connection.scalar(
                text(
                    """
                    SELECT ENGINE
                    FROM information_schema.tables
                    WHERE table_schema = DATABASE()
                      AND table_name = :table_name
                    """
                ),
                {"table_name": TradeIdempotencyRequest.__tablename__},
            )
            assert str(table_engine).upper() == "INNODB"
        yield engine
    finally:
        with engine.begin() as connection:
            connection.execute(
                text(f"DROP TABLE IF EXISTS {MYSQL_TEST_EFFECTS_TABLE}")
            )
            TradeIdempotencyRequest.__table__.drop(connection, checkfirst=True)
        engine.dispose()


def test_mysql_same_key_concurrency_executes_one_business_effect_and_replays(
    mysql_idempotency_engine,
):
    engine = mysql_idempotency_engine
    client_order_id = "mysql-concurrent-spot-1"
    request_payload = {"symbol": "BTCUSDT", "amount": "1"}
    winner_reserved = Event()
    allow_winner_commit = Event()

    def winner_request():
        with Session(engine) as db:
            claim = claim_trade_idempotency(
                db,
                user_id=7001,
                market="SPOT",
                operation="SPOT_CREATE",
                client_order_id=client_order_id,
                request_payload=request_payload,
            )
            assert claim.is_replay is False
            effect_result = db.execute(
                text(
                    f"""
                    INSERT INTO {MYSQL_TEST_EFFECTS_TABLE} (client_order_id)
                    VALUES (:client_order_id)
                    """
                ),
                {"client_order_id": client_order_id},
            )
            effect_id = int(effect_result.lastrowid)
            response_payload = {
                "id": effect_id,
                "status": "FILLED",
                "client_order_id": client_order_id,
            }
            complete_trade_idempotency(db, claim, response_payload)
            winner_reserved.set()
            assert allow_winner_commit.wait(timeout=10)
            db.commit()
            return response_payload

    def duplicate_request():
        assert winner_reserved.wait(timeout=10)
        with Session(engine) as db:
            claim = claim_trade_idempotency(
                db,
                user_id=7001,
                market="SPOT",
                operation="SPOT_CREATE",
                client_order_id=client_order_id,
                request_payload=request_payload,
            )
            assert claim.is_replay is True
            assert claim.record is None
            return claim.replay_payload

    with ThreadPoolExecutor(max_workers=2) as executor:
        winner_future = executor.submit(winner_request)
        assert winner_reserved.wait(timeout=10)
        duplicate_future = executor.submit(duplicate_request)
        time.sleep(0.2)
        assert duplicate_future.done() is False
        allow_winner_commit.set()
        winner_payload = winner_future.result(timeout=10)
        replay_payload = duplicate_future.result(timeout=10)

    assert replay_payload == winner_payload
    with Session(engine) as db:
        request_count = db.scalar(
            select(func.count()).select_from(TradeIdempotencyRequest)
        )
        effect_count = db.scalar(
            text(f"SELECT COUNT(*) FROM {MYSQL_TEST_EFFECTS_TABLE}")
        )
        stored = db.scalar(select(TradeIdempotencyRequest))
        assert request_count == 1
        assert effect_count == 1
        assert stored is not None
        assert stored.status == "COMPLETED"
        assert stored.client_order_id == client_order_id
