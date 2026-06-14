from __future__ import annotations

import sys
from datetime import datetime
from decimal import Decimal
from pathlib import Path
from typing import Any

from sqlalchemy.orm import Session


BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.db.models.vip_fee_level import VipFeeLevel  # noqa: E402
from app.db.models.vip_fee_level_condition import VipFeeLevelCondition  # noqa: E402
from app.db.session import SessionLocal  # noqa: E402


VIP_LEVELS: list[dict[str, Any]] = [
    {
        "vip_type": "VIP",
        "level_code": "VIP0",
        "level_name": "VIP0",
        "sort_order": 0,
        "is_enabled": True,
        "spot_maker_fee": Decimal("0.004000"),
        "spot_taker_fee": Decimal("0.004000"),
        "contract_maker_fee": None,
        "contract_taker_fee": None,
        "rcb_discount_rate": Decimal("0.250000"),
        "condition": {
            "min_30d_volume": Decimal("0"),
            "min_rcb_hold": Decimal("0"),
            "min_lock_amount": None,
            "lock_period_days": None,
            "user_limit": None,
            "dividend_rate": None,
        },
    },
    {
        "vip_type": "VIP",
        "level_code": "VIP1",
        "level_name": "VIP1",
        "sort_order": 1,
        "is_enabled": True,
        "spot_maker_fee": Decimal("0.003600"),
        "spot_taker_fee": Decimal("0.004000"),
        "contract_maker_fee": None,
        "contract_taker_fee": None,
        "rcb_discount_rate": Decimal("0.250000"),
        "condition": {
            "min_30d_volume": Decimal("500000.000000000000000000"),
            "min_rcb_hold": Decimal("10.000000000000000000"),
            "min_lock_amount": None,
            "lock_period_days": None,
            "user_limit": None,
            "dividend_rate": None,
        },
    },
    {
        "vip_type": "VIP",
        "level_code": "VIP2",
        "level_name": "VIP2",
        "sort_order": 2,
        "is_enabled": True,
        "spot_maker_fee": Decimal("0.003200"),
        "spot_taker_fee": Decimal("0.003600"),
        "contract_maker_fee": None,
        "contract_taker_fee": None,
        "rcb_discount_rate": Decimal("0.250000"),
        "condition": {
            "min_30d_volume": Decimal("1000000.000000000000000000"),
            "min_rcb_hold": Decimal("50.000000000000000000"),
            "min_lock_amount": None,
            "lock_period_days": None,
            "user_limit": None,
            "dividend_rate": None,
        },
    },
    {
        "vip_type": "VIP",
        "level_code": "VIP3",
        "level_name": "VIP3",
        "sort_order": 3,
        "is_enabled": True,
        "spot_maker_fee": Decimal("0.002800"),
        "spot_taker_fee": Decimal("0.003200"),
        "contract_maker_fee": None,
        "contract_taker_fee": None,
        "rcb_discount_rate": Decimal("0.250000"),
        "condition": {
            "min_30d_volume": Decimal("5000000.000000000000000000"),
            "min_rcb_hold": Decimal("100.000000000000000000"),
            "min_lock_amount": None,
            "lock_period_days": None,
            "user_limit": None,
            "dividend_rate": None,
        },
    },
    {
        "vip_type": "VIP",
        "level_code": "VIP4",
        "level_name": "VIP4",
        "sort_order": 4,
        "is_enabled": True,
        "spot_maker_fee": Decimal("0.002400"),
        "spot_taker_fee": Decimal("0.002800"),
        "contract_maker_fee": None,
        "contract_taker_fee": None,
        "rcb_discount_rate": Decimal("0.250000"),
        "condition": {
            "min_30d_volume": Decimal("10000000.000000000000000000"),
            "min_rcb_hold": Decimal("500.000000000000000000"),
            "min_lock_amount": None,
            "lock_period_days": None,
            "user_limit": None,
            "dividend_rate": None,
        },
    },
    {
        "vip_type": "VIP",
        "level_code": "VIP5",
        "level_name": "VIP5",
        "sort_order": 5,
        "is_enabled": True,
        "spot_maker_fee": Decimal("0.002000"),
        "spot_taker_fee": Decimal("0.002400"),
        "contract_maker_fee": None,
        "contract_taker_fee": None,
        "rcb_discount_rate": Decimal("0.250000"),
        "condition": {
            "min_30d_volume": Decimal("50000000.000000000000000000"),
            "min_rcb_hold": Decimal("1000.000000000000000000"),
            "min_lock_amount": None,
            "lock_period_days": None,
            "user_limit": None,
            "dividend_rate": None,
        },
    },
    {
        "vip_type": "VIP",
        "level_code": "VIP6",
        "level_name": "VIP6",
        "sort_order": 6,
        "is_enabled": True,
        "spot_maker_fee": Decimal("0.001600"),
        "spot_taker_fee": Decimal("0.002000"),
        "contract_maker_fee": None,
        "contract_taker_fee": None,
        "rcb_discount_rate": Decimal("0.250000"),
        "condition": {
            "min_30d_volume": Decimal("100000000.000000000000000000"),
            "min_rcb_hold": Decimal("1750.000000000000000000"),
            "min_lock_amount": None,
            "lock_period_days": None,
            "user_limit": None,
            "dividend_rate": None,
        },
    },
    {
        "vip_type": "VIP",
        "level_code": "VIP7",
        "level_name": "VIP7",
        "sort_order": 7,
        "is_enabled": True,
        "spot_maker_fee": Decimal("0.001200"),
        "spot_taker_fee": Decimal("0.001600"),
        "contract_maker_fee": None,
        "contract_taker_fee": None,
        "rcb_discount_rate": Decimal("0.250000"),
        "condition": {
            "min_30d_volume": Decimal("200000000.000000000000000000"),
            "min_rcb_hold": Decimal("3000.000000000000000000"),
            "min_lock_amount": None,
            "lock_period_days": None,
            "user_limit": None,
            "dividend_rate": None,
        },
    },
    {
        "vip_type": "VIP",
        "level_code": "VIP8",
        "level_name": "VIP8",
        "sort_order": 8,
        "is_enabled": True,
        "spot_maker_fee": Decimal("0.000800"),
        "spot_taker_fee": Decimal("0.001200"),
        "contract_maker_fee": None,
        "contract_taker_fee": None,
        "rcb_discount_rate": Decimal("0.250000"),
        "condition": {
            "min_30d_volume": Decimal("300000000.000000000000000000"),
            "min_rcb_hold": Decimal("4500.000000000000000000"),
            "min_lock_amount": None,
            "lock_period_days": None,
            "user_limit": None,
            "dividend_rate": None,
        },
    },
    {
        "vip_type": "VIP",
        "level_code": "LP",
        "level_name": "LP",
        "sort_order": 9,
        "is_enabled": True,
        "spot_maker_fee": Decimal("0.000400"),
        "spot_taker_fee": Decimal("0.000800"),
        "contract_maker_fee": None,
        "contract_taker_fee": None,
        "rcb_discount_rate": Decimal("0.250000"),
        "condition": {
            "min_30d_volume": Decimal("500000000.000000000000000000"),
            "min_rcb_hold": Decimal("5500.000000000000000000"),
            "min_lock_amount": None,
            "lock_period_days": None,
            "user_limit": None,
            "dividend_rate": None,
        },
    },
    {
        "vip_type": "SVIP",
        "level_code": "NORMAL",
        "level_name": "普通用户",
        "sort_order": 0,
        "is_enabled": True,
        "spot_maker_fee": Decimal("0.004000"),
        "spot_taker_fee": Decimal("0.004000"),
        "contract_maker_fee": None,
        "contract_taker_fee": None,
        "rcb_discount_rate": Decimal("0.250000"),
        "condition": {
            "min_30d_volume": None,
            "min_rcb_hold": None,
            "min_lock_amount": Decimal("0"),
            "lock_period_days": None,
            "user_limit": None,
            "dividend_rate": None,
        },
    },
    {
        "vip_type": "SVIP",
        "level_code": "SVIP1",
        "level_name": "SVIP1",
        "sort_order": 1,
        "is_enabled": True,
        "spot_maker_fee": Decimal("0.003600"),
        "spot_taker_fee": Decimal("0.004000"),
        "contract_maker_fee": None,
        "contract_taker_fee": None,
        "rcb_discount_rate": Decimal("0.250000"),
        "condition": {
            "min_30d_volume": None,
            "min_rcb_hold": None,
            "min_lock_amount": Decimal("1000.000000000000000000"),
            "lock_period_days": 365,
            "user_limit": 50000,
            "dividend_rate": Decimal("0.050000"),
        },
    },
    {
        "vip_type": "SVIP",
        "level_code": "SVIP2",
        "level_name": "SVIP2",
        "sort_order": 2,
        "is_enabled": True,
        "spot_maker_fee": Decimal("0.003200"),
        "spot_taker_fee": Decimal("0.003600"),
        "contract_maker_fee": None,
        "contract_taker_fee": None,
        "rcb_discount_rate": Decimal("0.250000"),
        "condition": {
            "min_30d_volume": None,
            "min_rcb_hold": None,
            "min_lock_amount": Decimal("2000.000000000000000000"),
            "lock_period_days": 365,
            "user_limit": 40000,
            "dividend_rate": Decimal("0.050000"),
        },
    },
    {
        "vip_type": "SVIP",
        "level_code": "SVIP3",
        "level_name": "SVIP3",
        "sort_order": 3,
        "is_enabled": True,
        "spot_maker_fee": Decimal("0.002800"),
        "spot_taker_fee": Decimal("0.003200"),
        "contract_maker_fee": None,
        "contract_taker_fee": None,
        "rcb_discount_rate": Decimal("0.250000"),
        "condition": {
            "min_30d_volume": None,
            "min_rcb_hold": None,
            "min_lock_amount": Decimal("3000.000000000000000000"),
            "lock_period_days": 365,
            "user_limit": 23000,
            "dividend_rate": Decimal("0.050000"),
        },
    },
    {
        "vip_type": "SVIP",
        "level_code": "SVIP4",
        "level_name": "SVIP4",
        "sort_order": 4,
        "is_enabled": True,
        "spot_maker_fee": Decimal("0.002400"),
        "spot_taker_fee": Decimal("0.002800"),
        "contract_maker_fee": None,
        "contract_taker_fee": None,
        "rcb_discount_rate": Decimal("0.250000"),
        "condition": {
            "min_30d_volume": None,
            "min_rcb_hold": None,
            "min_lock_amount": Decimal("5000.000000000000000000"),
            "lock_period_days": 365,
            "user_limit": 20000,
            "dividend_rate": Decimal("0.050000"),
        },
    },
    {
        "vip_type": "SVIP",
        "level_code": "SVIP5",
        "level_name": "SVIP5",
        "sort_order": 5,
        "is_enabled": True,
        "spot_maker_fee": Decimal("0.002000"),
        "spot_taker_fee": Decimal("0.002400"),
        "contract_maker_fee": None,
        "contract_taker_fee": None,
        "rcb_discount_rate": Decimal("0.250000"),
        "condition": {
            "min_30d_volume": None,
            "min_rcb_hold": None,
            "min_lock_amount": Decimal("10000.000000000000000000"),
            "lock_period_days": 365,
            "user_limit": 10000,
            "dividend_rate": Decimal("0.050000"),
        },
    },
    {
        "vip_type": "SVIP",
        "level_code": "SVIP6",
        "level_name": "SVIP6",
        "sort_order": 6,
        "is_enabled": True,
        "spot_maker_fee": Decimal("0.001600"),
        "spot_taker_fee": Decimal("0.002000"),
        "contract_maker_fee": None,
        "contract_taker_fee": None,
        "rcb_discount_rate": Decimal("0.250000"),
        "condition": {
            "min_30d_volume": None,
            "min_rcb_hold": None,
            "min_lock_amount": Decimal("20000.000000000000000000"),
            "lock_period_days": 720,
            "user_limit": 5000,
            "dividend_rate": Decimal("0.050000"),
        },
    },
    {
        "vip_type": "SVIP",
        "level_code": "SVIP7",
        "level_name": "SVIP7",
        "sort_order": 7,
        "is_enabled": True,
        "spot_maker_fee": Decimal("0.001200"),
        "spot_taker_fee": Decimal("0.001600"),
        "contract_maker_fee": None,
        "contract_taker_fee": None,
        "rcb_discount_rate": Decimal("0.250000"),
        "condition": {
            "min_30d_volume": None,
            "min_rcb_hold": None,
            "min_lock_amount": Decimal("40000.000000000000000000"),
            "lock_period_days": 720,
            "user_limit": 2500,
            "dividend_rate": Decimal("0.050000"),
        },
    },
    {
        "vip_type": "SVIP",
        "level_code": "SVIP8",
        "level_name": "SVIP8",
        "sort_order": 8,
        "is_enabled": True,
        "spot_maker_fee": Decimal("0.000800"),
        "spot_taker_fee": Decimal("0.001200"),
        "contract_maker_fee": None,
        "contract_taker_fee": None,
        "rcb_discount_rate": Decimal("0.250000"),
        "condition": {
            "min_30d_volume": None,
            "min_rcb_hold": None,
            "min_lock_amount": Decimal("50000.000000000000000000"),
            "lock_period_days": 720,
            "user_limit": 2000,
            "dividend_rate": Decimal("0.050000"),
        },
    },
    {
        "vip_type": "SVIP",
        "level_code": "LP",
        "level_name": "LP",
        "sort_order": 9,
        "is_enabled": True,
        "spot_maker_fee": Decimal("0.000400"),
        "spot_taker_fee": Decimal("0.000800"),
        "contract_maker_fee": None,
        "contract_taker_fee": None,
        "rcb_discount_rate": Decimal("0.250000"),
        "condition": {
            "min_30d_volume": None,
            "min_rcb_hold": None,
            "min_lock_amount": Decimal("100000.000000000000000000"),
            "lock_period_days": 1095,
            "user_limit": 1000,
            "dividend_rate": Decimal("0.050000"),
        },
    },
]


def _upsert_level(db: Session, item: dict[str, Any], now: datetime) -> tuple[VipFeeLevel, bool]:
    level = (
        db.query(VipFeeLevel)
        .filter(VipFeeLevel.vip_type == item["vip_type"], VipFeeLevel.level_code == item["level_code"])
        .first()
    )
    created = level is None
    if level is None:
        level = VipFeeLevel(
            vip_type=item["vip_type"],
            level_code=item["level_code"],
            created_at=now,
        )
        db.add(level)

    level.level_name = item["level_name"]
    level.sort_order = item["sort_order"]
    level.is_enabled = item["is_enabled"]
    level.spot_maker_fee = item["spot_maker_fee"]
    level.spot_taker_fee = item["spot_taker_fee"]
    level.contract_maker_fee = item["contract_maker_fee"]
    level.contract_taker_fee = item["contract_taker_fee"]
    level.rcb_discount_rate = item["rcb_discount_rate"]
    level.updated_at = now
    db.flush()
    return level, created


def _upsert_condition(db: Session, level: VipFeeLevel, condition_data: dict[str, Any], now: datetime) -> bool:
    condition = (
        db.query(VipFeeLevelCondition)
        .filter(VipFeeLevelCondition.vip_fee_level_id == level.id)
        .first()
    )
    created = condition is None
    if condition is None:
        condition = VipFeeLevelCondition(vip_fee_level_id=level.id, created_at=now)
        db.add(condition)

    condition.min_30d_volume = condition_data["min_30d_volume"]
    condition.min_rcb_hold = condition_data["min_rcb_hold"]
    condition.min_lock_amount = condition_data["min_lock_amount"]
    condition.lock_period_days = condition_data["lock_period_days"]
    condition.user_limit = condition_data["user_limit"]
    condition.dividend_rate = condition_data["dividend_rate"]
    condition.updated_at = now
    db.flush()
    return created


def seed_vip_levels() -> None:
    db = SessionLocal()
    level_inserted = 0
    level_updated = 0
    condition_inserted = 0
    condition_updated = 0
    try:
        now = datetime.utcnow()
        for item in VIP_LEVELS:
            level, level_created = _upsert_level(db, item, now)
            condition_created = _upsert_condition(db, level, item["condition"], now)
            level_inserted += int(level_created)
            level_updated += int(not level_created)
            condition_inserted += int(condition_created)
            condition_updated += int(not condition_created)

        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()

    print(
        "Seeded VIP/SVIP levels: "
        f"levels inserted={level_inserted}, levels updated={level_updated}, "
        f"conditions inserted={condition_inserted}, conditions updated={condition_updated}"
    )


if __name__ == "__main__":
    seed_vip_levels()
