from datetime import timedelta
from decimal import Decimal

import pytest
from sqlalchemy import BigInteger, Integer, MetaData, create_engine
from sqlalchemy.dialects.mysql import TINYINT
from sqlalchemy.orm import Session

from app.db.models.stock_token_lock_config import StockTokenLockConfig
from app.db.models.user_stock_token_lock import UserStockTokenLock
from app.routers.stock_token import get_my_stock_token_locks
from app.services.admin_queries import _admin_stock_lock_item
from app.services.stock_token_lock_service import (
    calculate_stock_token_releasable_amount,
    create_stock_token_lock_from_deposit,
)


@pytest.fixture
def db():
    engine = create_engine("sqlite://")
    metadata = MetaData()
    # Adapt only the disposable test schema, leaving the production models intact.
    for model in (StockTokenLockConfig, UserStockTokenLock):
        table = model.__table__.to_metadata(metadata)
        for column in table.columns:
            if isinstance(column.type, TINYINT) or (
                column.primary_key and isinstance(column.type, BigInteger)
            ):
                column.type = Integer()
    metadata.create_all(engine)
    with Session(engine) as session:
        yield session
    engine.dispose()


def make_config(rate):
    return StockTokenLockConfig(
        lock_symbol="HYT1", trade_symbol="HYT", display_name="HYT",
        lock_days=90, daily_release_rate=Decimal(rate),
        conversion_rate=Decimal("1"), is_active=1,
    )


def test_replacement_config_applies_to_new_batches_and_preserves_old_batch_rate(db):
    old_config = make_config("0.0012")
    db.add(old_config)
    db.flush()
    old_batch = create_stock_token_lock_from_deposit(db, 7, "HYT1", Decimal("100"))
    old_config.is_active = 0
    new_config = make_config("0.00123457")
    db.add(new_config)
    db.flush()
    new_batch = create_stock_token_lock_from_deposit(db, 7, "HYT1", Decimal("100"))
    db.commit()
    db.expire_all()

    assert old_batch.config_id == old_config.id
    assert new_batch.config_id == new_config.id
    items = {item["id"]: item for item in get_my_stock_token_locks(user_id=7, db=db)["items"]}
    assert Decimal(items[old_batch.id]["daily_release_rate"]) == Decimal("0.0012")
    assert Decimal(items[new_batch.id]["daily_release_rate"]) == Decimal("0.00123457")
    assert items[old_batch.id]["release_days"] == 834
    assert items[new_batch.id]["release_days"] == 810
    # Disabling/replacing the config does not stop or reprice an existing batch.
    assert calculate_stock_token_releasable_amount(
        old_batch, old_batch.start_at + timedelta(days=91), old_config,
    ) == Decimal("0.12")
    assert calculate_stock_token_releasable_amount(
        new_batch, new_batch.start_at + timedelta(days=91), new_config,
    ) == Decimal("0.123457")


def test_editing_rate_does_not_change_an_existing_batch_snapshot(db):
    config = make_config("0.0012")
    db.add(config)
    db.flush()
    batch = create_stock_token_lock_from_deposit(db, 7, "HYT1", Decimal("100"))
    config.daily_release_rate = Decimal("0.00123457")
    db.commit()
    item = get_my_stock_token_locks(user_id=7, db=db)["items"][0]
    assert Decimal(item["daily_release_rate"]) == Decimal("0.0012")
    assert calculate_stock_token_releasable_amount(
        batch, batch.start_at + timedelta(days=91), config,
    ) == Decimal("0.12")


@pytest.mark.parametrize("rate, expected", [
    ("0.00123457", "0.123457"),
    ("0.00142857", "0.142857"),
    ("0.00000001", "0.000001"),
    ("0.0012", "0.12"),
    ("0.05", "5"),
    ("1", "100"),
])
def test_admin_batch_display_preserves_snapshot_precision(rate, expected):
    item = _admin_stock_lock_item({
        "daily_release_rate_snapshot": Decimal(rate),
        "daily_release_rate": Decimal("0.5"),
    })
    assert item["daily_release_rate_percent"] == expected
