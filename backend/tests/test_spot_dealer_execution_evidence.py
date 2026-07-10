from __future__ import annotations

import importlib.util
import inspect
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace

from sqlalchemy import BigInteger, Integer, String

from app.db.models.trade import Trade
from app.schemas.order import CreateOrderRequest
from app.schemas.spot import SpotTradeItem
from app.services import order_service, spot_query
from app.services.spot_execution_view import SpotExecutionSnapshot


EVIDENCE_COLUMNS = (
    "dealer_provider",
    "dealer_provider_symbol",
    "dealer_event_time_ms",
    "dealer_received_at_ms",
    "dealer_freshness",
    "dealer_snapshot_id",
    "dealer_provider_generation",
    "dealer_snapshot_max_age_ms",
)


def _execution(
    provider: str = "OKX_SPOT",
    *,
    generation: int = 7,
    snapshot_id: str = "a" * 64,
) -> SpotExecutionSnapshot:
    return SpotExecutionSnapshot(
        symbol="BTCUSDT",
        provider=provider,
        provider_symbol="BTC-USDT" if provider == "OKX_SPOT" else "BTCUSDT",
        best_bid=Decimal("100.25"),
        best_ask=Decimal("100.75"),
        event_time_ms=1_720_000_000_123,
        received_at_ms=1_720_000_000_456,
        freshness="LIVE",
        source="LIVE_WS",
        max_age_ms=1500,
        snapshot_id=snapshot_id,
        provider_generation=generation,
    )


def _dealer_snapshot(execution: SpotExecutionSnapshot | None) -> order_service.DealerPriceSnapshot:
    return order_service.DealerPriceSnapshot(
        best_bid=execution.best_bid if execution is not None else Decimal("10"),
        best_ask=execution.best_ask if execution is not None else Decimal("11"),
        ref_price=(execution.best_bid + execution.best_ask) / Decimal("2") if execution else Decimal("10.5"),
        price_source=execution.provider if execution is not None else "ITICK",
        spread_bps=Decimal("49.62779156") if execution is not None else Decimal("100"),
        execution_snapshot=execution,
    )


def _trade(side: str, execution: SpotExecutionSnapshot | None) -> Trade:
    order = SimpleNamespace(id=31, user_id=88, side=side)
    pair = SimpleNamespace(id=17)
    price = execution.best_ask if side == "BUY" and execution else (
        execution.best_bid if execution else Decimal("10")
    )
    return order_service._build_dealer_trade(
        pair=pair,
        order=order,
        execution_price=price,
        amount=Decimal("2"),
        quote_amount=price * Decimal("2"),
        dealer_snapshot=_dealer_snapshot(execution),
    )


def _load_migration():
    path = (
        Path(__file__).resolve().parents[1]
        / "alembic"
        / "versions"
        / "20260711_000120_add_spot_dealer_execution_evidence.py"
    )
    spec = importlib.util.spec_from_file_location("spot_dealer_execution_evidence_migration", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _spot_trade_payload(**overrides):
    values = {
        "trade_id": 1,
        "symbol": "BTCUSDT",
        "side": "BUY",
        "price": "100.75",
        "amount": "2",
        "quote_amount": "201.5",
        "role": "TAKER",
    }
    values.update(overrides)
    return values


def test_trade_model_has_nullable_execution_evidence_columns() -> None:
    columns = Trade.__table__.columns
    assert all(name in columns for name in EVIDENCE_COLUMNS)
    assert all(columns[name].nullable for name in EVIDENCE_COLUMNS)


def test_trade_model_execution_evidence_column_types_and_lengths() -> None:
    columns = Trade.__table__.columns
    assert isinstance(columns.dealer_provider.type, String) and columns.dealer_provider.type.length == 64
    assert isinstance(columns.dealer_provider_symbol.type, String) and columns.dealer_provider_symbol.type.length == 64
    assert isinstance(columns.dealer_event_time_ms.type, BigInteger)
    assert isinstance(columns.dealer_received_at_ms.type, BigInteger)
    assert isinstance(columns.dealer_freshness.type, String) and columns.dealer_freshness.type.length == 32
    assert isinstance(columns.dealer_snapshot_id.type, String) and columns.dealer_snapshot_id.type.length == 64
    assert isinstance(columns.dealer_provider_generation.type, BigInteger)
    assert isinstance(columns.dealer_snapshot_max_age_ms.type, Integer)


def test_migration_revision_chain_is_current_head_child() -> None:
    migration = _load_migration()
    assert migration.revision == "20260711_000120"
    assert migration.down_revision == "20260710_000119"


def test_migration_upgrade_adds_all_nullable_evidence_columns() -> None:
    migration = _load_migration()

    class FakeOp:
        def __init__(self):
            self.added = []

        @staticmethod
        def get_bind():
            return object()

        def add_column(self, table_name, column):
            self.added.append((table_name, column))

    fake_op = FakeOp()
    migration.op = fake_op
    migration._has_table = lambda bind, table_name: True
    migration._has_column = lambda bind, table_name, column_name: False
    migration.upgrade()
    assert [column.name for table, column in fake_op.added if table == "trades"] == list(EVIDENCE_COLUMNS)
    assert all(column.nullable for _, column in fake_op.added)


def test_migration_downgrade_drops_exact_evidence_columns_in_reverse() -> None:
    migration = _load_migration()

    class FakeOp:
        def __init__(self):
            self.dropped = []

        @staticmethod
        def get_bind():
            return object()

        def drop_column(self, table_name, column_name):
            self.dropped.append((table_name, column_name))

    fake_op = FakeOp()
    migration.op = fake_op
    migration._has_column = lambda bind, table_name, column_name: True
    migration.downgrade()
    assert fake_op.dropped == [("trades", name) for name in reversed(EVIDENCE_COLUMNS)]


def test_migration_does_not_add_constraints_or_rewrite_history() -> None:
    source = inspect.getsource(_load_migration())
    assert "create_unique_constraint" not in source
    assert "execute(" not in source
    assert "UPDATE " not in source.upper()


def test_apply_spot_execution_evidence_preserves_exact_snapshot_values() -> None:
    snapshot = _execution()
    trade = order_service.apply_spot_execution_evidence(Trade(), snapshot)
    assert trade.dealer_provider == snapshot.provider
    assert trade.dealer_provider_symbol == snapshot.provider_symbol
    assert trade.dealer_event_time_ms == snapshot.event_time_ms
    assert trade.dealer_received_at_ms == snapshot.received_at_ms
    assert trade.dealer_freshness == snapshot.freshness
    assert trade.dealer_snapshot_id == snapshot.snapshot_id
    assert trade.dealer_provider_generation == snapshot.provider_generation
    assert trade.dealer_snapshot_max_age_ms == snapshot.max_age_ms


def test_market_buy_trade_uses_same_snapshot_ask_and_evidence() -> None:
    snapshot = _execution()
    trade = _trade("BUY", snapshot)
    assert trade.price == snapshot.best_ask
    assert trade.dealer_best_bid == snapshot.best_bid
    assert trade.dealer_best_ask == snapshot.best_ask
    assert trade.dealer_snapshot_id == snapshot.snapshot_id
    assert trade.buyer_user_id == 88 and trade.seller_user_id == order_service.PLATFORM_USER_ID


def test_market_sell_trade_uses_same_snapshot_bid_and_evidence() -> None:
    snapshot = _execution()
    trade = _trade("SELL", snapshot)
    assert trade.price == snapshot.best_bid
    assert trade.dealer_best_bid == snapshot.best_bid
    assert trade.dealer_best_ask == snapshot.best_ask
    assert trade.dealer_snapshot_id == snapshot.snapshot_id
    assert trade.buyer_user_id == order_service.PLATFORM_USER_ID and trade.seller_user_id == 88


def test_okx_trade_persists_okx_provider_and_provider_symbol() -> None:
    snapshot = _execution("OKX_SPOT")
    trade = _trade("BUY", snapshot)
    assert trade.dealer_provider == "OKX_SPOT"
    assert trade.dealer_provider_symbol == "BTC-USDT"


def test_bitget_takeover_trade_persists_bitget_provider_and_provider_symbol() -> None:
    snapshot = _execution("BITGET_SPOT", generation=8)
    trade = _trade("SELL", snapshot)
    assert trade.dealer_provider == "BITGET_SPOT"
    assert trade.dealer_provider_symbol == "BTCUSDT"
    assert trade.dealer_provider_generation == 8


def test_new_generation_is_persisted_without_reusing_prior_generation() -> None:
    old_trade = _trade("BUY", _execution(generation=7, snapshot_id="a" * 64))
    new_trade = _trade("BUY", _execution(generation=9, snapshot_id="b" * 64))
    assert old_trade.dealer_provider_generation == 7
    assert new_trade.dealer_provider_generation == 9
    assert new_trade.dealer_snapshot_id == "b" * 64


def test_event_and_received_times_remain_distinct_and_unmodified() -> None:
    trade = _trade("BUY", _execution())
    assert trade.dealer_event_time_ms == 1_720_000_000_123
    assert trade.dealer_received_at_ms == 1_720_000_000_456
    assert trade.dealer_event_time_ms != trade.dealer_received_at_ms


def test_provider_and_transport_source_are_not_conflated() -> None:
    trade = _trade("BUY", _execution("OKX_SPOT"))
    assert trade.dealer_provider == "OKX_SPOT"
    assert trade.dealer_price_source == "LIVE_WS"
    assert trade.dealer_freshness == "LIVE"


def test_snapshot_id_is_not_recomputed_during_persistence() -> None:
    original_id = "f" * 64
    trade = _trade("BUY", _execution(snapshot_id=original_id))
    assert trade.dealer_snapshot_id is original_id
    source = inspect.getsource(order_service.apply_spot_execution_evidence)
    assert "_snapshot_id(" not in source
    assert "hashlib" not in source
    assert "get_spot_execution_snapshot" not in source


def test_market_and_limit_fills_share_one_trade_evidence_builder() -> None:
    market_source = inspect.getsource(order_service._create_dealer_market_order)
    limit_source = inspect.getsource(order_service._fill_dealer_limit_order)
    assert market_source.count("_build_dealer_trade") == 2
    assert limit_source.count("_build_dealer_trade") == 2
    assert "apply_spot_execution_evidence" not in market_source
    assert "apply_spot_execution_evidence" not in limit_source


def test_immediate_limit_and_dealer_loop_share_evidence_fill_path() -> None:
    immediate_source = inspect.getsource(order_service._create_dealer_limit_order)
    loop_source = inspect.getsource(order_service.process_open_dealer_orders)
    assert "_execute_dealer_limit_order_if_eligible" in immediate_source
    assert "_execute_dealer_limit_order_if_eligible" in loop_source
    assert "_build_dealer_trade" in inspect.getsource(order_service._fill_dealer_limit_order)


def test_stock_dealer_trade_keeps_external_evidence_null() -> None:
    trade = _trade("BUY", None)
    assert trade.dealer_price_source == "ITICK"
    assert all(getattr(trade, name) is None for name in EVIDENCE_COLUMNS)


def test_internal_trade_model_defaults_external_evidence_to_null() -> None:
    trade = Trade()
    assert all(getattr(trade, name) is None for name in EVIDENCE_COLUMNS)


def test_historical_null_trade_serializes_with_optional_evidence() -> None:
    item = SpotTradeItem(**_spot_trade_payload())
    payload = item.model_dump() if hasattr(item, "model_dump") else item.dict()
    assert all(payload[name] is None for name in EVIDENCE_COLUMNS)
    assert payload["dealer_best_bid"] is None
    assert payload["dealer_price_source"] is None


def test_api_schema_serializes_complete_execution_evidence() -> None:
    snapshot = _execution()
    item = SpotTradeItem(
        **_spot_trade_payload(
            dealer_provider=snapshot.provider,
            dealer_provider_symbol=snapshot.provider_symbol,
            dealer_event_time_ms=snapshot.event_time_ms,
            dealer_received_at_ms=snapshot.received_at_ms,
            dealer_freshness=snapshot.freshness,
            dealer_snapshot_id=snapshot.snapshot_id,
            dealer_provider_generation=snapshot.provider_generation,
            dealer_snapshot_max_age_ms=snapshot.max_age_ms,
        )
    )
    payload = item.model_dump() if hasattr(item, "model_dump") else item.dict()
    assert payload["dealer_provider"] == "OKX_SPOT"
    assert payload["dealer_snapshot_id"] == snapshot.snapshot_id


def test_spot_query_exposes_old_and_new_dealer_evidence() -> None:
    trade = _trade("BUY", _execution())
    result = spot_query._spot_trade_dealer_evidence(trade)
    assert result["dealer_best_bid"] == "100.25"
    assert result["dealer_best_ask"] == "100.75"
    assert result["dealer_price_source"] == "LIVE_WS"
    assert result["dealer_provider"] == "OKX_SPOT"
    assert result["dealer_snapshot_max_age_ms"] == 1500


def test_spot_query_handles_historical_rows_without_evidence_attributes() -> None:
    result = spot_query._spot_trade_dealer_evidence(SimpleNamespace())
    assert all(result[name] is None for name in EVIDENCE_COLUMNS)
    assert result["dealer_ref_price"] is None


def test_create_order_request_cannot_populate_server_evidence_fields() -> None:
    request = CreateOrderRequest(
        symbol="BTCUSDT",
        side="BUY",
        order_type="MARKET",
        quote_amount=Decimal("10"),
        dealer_provider="ATTACKER",
        dealer_snapshot_id="forged",
    )
    payload = request.model_dump() if hasattr(request, "model_dump") else request.dict()
    assert "dealer_provider" not in payload
    assert "dealer_snapshot_id" not in payload


def test_evidence_helper_has_no_database_side_effect_and_uses_one_trade_object() -> None:
    source = inspect.getsource(order_service.apply_spot_execution_evidence)
    assert "db." not in source
    trade = Trade()
    assert order_service.apply_spot_execution_evidence(trade, _execution()) is trade
    assert order_service.apply_spot_execution_evidence(trade, None) is trade
