from __future__ import annotations

import sys
from datetime import datetime
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace

from sqlalchemy import select
from sqlalchemy.dialects import mysql
from sqlalchemy.exc import OperationalError


ROOT = Path(__file__).resolve().parents[2]
BACKEND = ROOT / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from app.db.models.market_kline import MarketKline  # noqa: E402
from app.services.spot_kline_realtime import (  # noqa: E402
    SUPPORTED_SPOT_KLINE_INTERVALS,
    apply_spot_trade_to_klines,
    apply_trade_to_spot_kline_item,
    build_spot_kline_update_message,
    spot_kline_bucket_bounds,
)
from app.services.market_kline_cache import interval_ms  # noqa: E402


class _BatchQuery:
    def __init__(self, session: "_BatchSession") -> None:
        self._session = session

    def filter(self, *criteria):
        self._session.filter_calls.append(criteria)
        return self

    def order_by(self, *criteria):
        self._session.order_by_calls.append(criteria)
        return self

    def all(self):
        self._session.all_calls += 1
        return list(self._session.selected_rows)

    def first(self):
        self._session.first_calls += 1
        raise AssertionError("batch persistence must not query each interval with first()")


class _BatchSession:
    def __init__(self, selected_rows, *, execute_error: Exception | None = None) -> None:
        self.selected_rows = list(selected_rows)
        self.execute_error = execute_error
        self.execute_calls = []
        self.query_calls = 0
        self.filter_calls = []
        self.order_by_calls = []
        self.all_calls = 0
        self.first_calls = 0
        self.commit_calls = 0
        self.rollback_calls = 0
        self.flush_calls = 0

    def execute(self, statement):
        self.execute_calls.append(statement)
        if self.execute_error is not None:
            raise self.execute_error

    def query(self, model):
        assert model is MarketKline
        self.query_calls += 1
        return _BatchQuery(self)

    def flush(self):
        self.flush_calls += 1
        raise AssertionError("Core multi-row UPSERT must not require db.flush()")

    def commit(self):
        self.commit_calls += 1

    def rollback(self):
        self.rollback_calls += 1


def _selected_db_rows(
    *,
    trade_ts_ms: int,
    open_price: str,
    high: str,
    low: str,
    close: str,
    volume: str,
    quote_volume: str,
):
    updated_at = datetime(2026, 7, 15, 12, 0, 0)
    rows = []
    for interval in SUPPORTED_SPOT_KLINE_INTERVALS:
        open_time, close_time = spot_kline_bucket_bounds(trade_ts_ms, interval)
        rows.append(
            SimpleNamespace(
                interval=interval,
                open_time=open_time,
                close_time=close_time,
                open=Decimal(open_price),
                high=Decimal(high),
                low=Decimal(low),
                close=Decimal(close),
                volume=Decimal(volume),
                quote_volume=Decimal(quote_volume),
                updated_at=updated_at,
            )
        )
    return rows


def test_spot_kline_bucket_floor_uses_interval_milliseconds():
    open_time, close_time = spot_kline_bucket_bounds(1710000075123, "1m")

    assert open_time == 1710000060000
    assert close_time == 1710000120000


def test_spot_kline_new_bucket_uses_trade_price_for_ohlc():
    item = apply_trade_to_spot_kline_item(
        None,
        interval="1m",
        trade_price="100.25",
        trade_amount="2.5",
        trade_ts_ms=1710000075123,
    )

    assert item["open"] == Decimal("100.25")
    assert item["high"] == Decimal("100.25")
    assert item["low"] == Decimal("100.25")
    assert item["close"] == Decimal("100.25")
    assert item["volume"] == Decimal("2.5")
    assert item["quote_volume"] == Decimal("250.625")


def test_spot_kline_existing_bucket_updates_close_and_totals():
    existing = {
        "open_time": 1710000060000,
        "close_time": 1710000120000,
        "open": Decimal("100"),
        "high": Decimal("105"),
        "low": Decimal("99"),
        "close": Decimal("101"),
        "volume": Decimal("2"),
        "quote_volume": Decimal("202"),
    }

    item = apply_trade_to_spot_kline_item(
        existing,
        interval="1m",
        trade_price="98",
        trade_amount="3",
        trade_ts_ms=1710000075123,
    )

    assert item["open"] == Decimal("100")
    assert item["high"] == Decimal("105")
    assert item["low"] == Decimal("98")
    assert item["close"] == Decimal("98")
    assert item["volume"] == Decimal("5")
    assert item["quote_volume"] == Decimal("496")


def test_spot_kline_generates_supported_intervals():
    for interval in SUPPORTED_SPOT_KLINE_INTERVALS:
        open_time, close_time = spot_kline_bucket_bounds(1710000075123, interval)

        assert close_time - open_time == interval_ms(interval)
        assert open_time % interval_ms(interval) == 0


def test_spot_kline_update_message_serializes_public_payload():
    item = apply_trade_to_spot_kline_item(
        None,
        interval="5m",
        trade_price="10",
        trade_amount="4",
        trade_ts_ms=1710000075123,
    )

    message = build_spot_kline_update_message(
        symbol="btcusdt",
        interval="5m",
        kline=item,
        updated_at="2026-07-03T00:00:00",
    )

    assert message["type"] == "spot_kline_update"
    assert message["symbol"] == "BTCUSDT"
    assert message["interval"] == "5m"
    assert message["source"] == "INTERNAL_TRADE"
    assert message["updated_at"] == "2026-07-03T00:00:00"
    assert message["kline"] == {
        "open_time": 1710000000000,
        "close_time": 1710000300000,
        "open": "10",
        "high": "10",
        "low": "10",
        "close": "10",
        "volume": "4",
        "quote_volume": "40",
    }


def test_spot_kline_batch_persistence_uses_one_upsert_one_exact_select_and_db_rows():
    trade_ts_ms = 1710000075123
    selected_rows = _selected_db_rows(
        trade_ts_ms=trade_ts_ms,
        open_price="95",
        high="120",
        low="90",
        close="101",
        volume="7",
        quote_volume="707",
    )
    db = _BatchSession(reversed(selected_rows))

    messages = apply_spot_trade_to_klines(
        db,
        symbol="btcusdt",
        trade_price="100",
        trade_amount="1",
        trade_ts_ms=trade_ts_ms,
    )

    assert len(db.execute_calls) == 1
    assert db.query_calls == 1
    assert len(db.filter_calls) == 1
    assert len(db.order_by_calls) == 1
    assert db.all_calls == 1
    assert db.first_calls == 0
    assert db.flush_calls == 0
    assert db.commit_calls == 1
    assert db.rollback_calls == 0
    assert [message["interval"] for message in messages] == list(
        SUPPORTED_SPOT_KLINE_INTERVALS
    )

    for message in messages:
        assert message["kline"]["open"] == "95"
        assert message["kline"]["high"] == "120"
        assert message["kline"]["low"] == "90"
        assert message["kline"]["close"] == "101"
        assert message["kline"]["volume"] == "7"
        assert message["kline"]["quote_volume"] == "707"

    insert_sql = " ".join(
        str(
            db.execute_calls[0].compile(
                dialect=mysql.dialect(),
                compile_kwargs={"literal_binds": True},
            )
        ).split()
    )
    assert insert_sql.count("'BTCUSDT'") == len(SUPPORTED_SPOT_KLINE_INTERVALS)
    interval_positions = [
        insert_sql.index(f"'{interval}'")
        for interval in SUPPORTED_SPOT_KLINE_INTERVALS
    ]
    assert interval_positions == sorted(interval_positions)
    update_sql = insert_sql.lower().split("on duplicate key update", 1)[1]
    assert "open =" not in update_sql
    assert "high = greatest(market_klines.high, values(high))" in update_sql
    assert "low = least(market_klines.low, values(low))" in update_sql
    assert "close = values(close)" in update_sql
    assert "volume = (market_klines.volume + values(volume))" in update_sql
    assert "quote_volume = (coalesce(market_klines.quote_volume," in update_sql
    assert "+ values(quote_volume))" in update_sql

    select_statement = (
        select(MarketKline.id)
        .where(*db.filter_calls[0])
        .order_by(*db.order_by_calls[0])
    )
    select_sql = " ".join(
        str(
            select_statement.compile(
                dialect=mysql.dialect(),
                compile_kwargs={"literal_binds": True},
            )
        ).split()
    )
    assert "market_klines.market_type = 'spot'" in select_sql
    assert "market_klines.symbol = 'BTCUSDT'" in select_sql
    for interval in SUPPORTED_SPOT_KLINE_INTERVALS:
        open_time, _ = spot_kline_bucket_bounds(trade_ts_ms, interval)
        assert f"('{interval}', {open_time})" in select_sql
    assert "order by case market_klines.`interval`" in select_sql.lower()


def test_spot_kline_batch_persistence_new_candle_payload_matches_db_row():
    trade_ts_ms = 1710000075123
    db = _BatchSession(
        _selected_db_rows(
            trade_ts_ms=trade_ts_ms,
            open_price="100",
            high="100",
            low="100",
            close="100",
            volume="1",
            quote_volume="100",
        )
    )
    messages = apply_spot_trade_to_klines(
        db,
        symbol="BTCUSDT",
        trade_price="100",
        trade_amount="1",
        trade_ts_ms=trade_ts_ms,
    )

    assert messages[0]["kline"] == {
        "open_time": 1710000060000,
        "close_time": 1710000120000,
        "open": "100",
        "high": "100",
        "low": "100",
        "close": "100",
        "volume": "1",
        "quote_volume": "100",
    }


def test_spot_kline_batch_persistence_missing_db_row_rolls_back_without_messages():
    trade_ts_ms = 1710000075123
    selected_rows = _selected_db_rows(
        trade_ts_ms=trade_ts_ms,
        open_price="100",
        high="100",
        low="100",
        close="100",
        volume="1",
        quote_volume="100",
    )
    db = _BatchSession(selected_rows[:-1])

    messages = apply_spot_trade_to_klines(
        db,
        symbol="BTCUSDT",
        trade_price="100",
        trade_amount="1",
        trade_ts_ms=trade_ts_ms,
    )

    assert messages == []
    assert db.commit_calls == 0
    assert db.rollback_calls == 1


def test_spot_kline_batch_persistence_db_failure_rolls_back_without_messages():
    db_error = OperationalError(
        "INSERT INTO market_klines ...",
        {},
        RuntimeError("database unavailable"),
    )
    db = _BatchSession([], execute_error=db_error)

    messages = apply_spot_trade_to_klines(
        db,
        symbol="BTCUSDT",
        trade_price="100",
        trade_amount="1",
        trade_ts_ms=1710000075123,
    )

    assert messages == []
    assert len(db.execute_calls) == 1
    assert db.query_calls == 0
    assert db.commit_calls == 0
    assert db.rollback_calls == 1
