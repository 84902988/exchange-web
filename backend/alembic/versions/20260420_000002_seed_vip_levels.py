"""seed vip and svip level data

Revision ID: 20260420_000002
Revises: 20260420_000001
Create Date: 2026-04-20 00:00:02
"""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "20260420_000002"
down_revision = "20260420_000001"
branch_labels = None
depends_on = None


VIP_LEVELS = [
    {
        "vip_type": "VIP",
        "level_code": "VIP0",
        "level_name": "VIP0",
        "sort_order": 0,
        "spot_maker_fee": Decimal("0.0040"),
        "spot_taker_fee": Decimal("0.0040"),
        "contract_maker_fee": None,
        "contract_taker_fee": None,
        "rcb_discount_rate": Decimal("0.25"),
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
        "spot_maker_fee": Decimal("0.0036"),
        "spot_taker_fee": Decimal("0.0040"),
        "contract_maker_fee": None,
        "contract_taker_fee": None,
        "rcb_discount_rate": Decimal("0.25"),
        "condition": {
            "min_30d_volume": Decimal("500000"),
            "min_rcb_hold": Decimal("10"),
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
        "spot_maker_fee": Decimal("0.0032"),
        "spot_taker_fee": Decimal("0.0036"),
        "contract_maker_fee": None,
        "contract_taker_fee": None,
        "rcb_discount_rate": Decimal("0.25"),
        "condition": {
            "min_30d_volume": Decimal("1000000"),
            "min_rcb_hold": Decimal("50"),
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
        "spot_maker_fee": Decimal("0.0028"),
        "spot_taker_fee": Decimal("0.0032"),
        "contract_maker_fee": None,
        "contract_taker_fee": None,
        "rcb_discount_rate": Decimal("0.25"),
        "condition": {
            "min_30d_volume": Decimal("5000000"),
            "min_rcb_hold": Decimal("100"),
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
        "spot_maker_fee": Decimal("0.0024"),
        "spot_taker_fee": Decimal("0.0028"),
        "contract_maker_fee": None,
        "contract_taker_fee": None,
        "rcb_discount_rate": Decimal("0.25"),
        "condition": {
            "min_30d_volume": Decimal("10000000"),
            "min_rcb_hold": Decimal("500"),
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
        "spot_maker_fee": Decimal("0.0020"),
        "spot_taker_fee": Decimal("0.0024"),
        "contract_maker_fee": None,
        "contract_taker_fee": None,
        "rcb_discount_rate": Decimal("0.25"),
        "condition": {
            "min_30d_volume": Decimal("50000000"),
            "min_rcb_hold": Decimal("1000"),
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
        "spot_maker_fee": Decimal("0.0016"),
        "spot_taker_fee": Decimal("0.0020"),
        "contract_maker_fee": None,
        "contract_taker_fee": None,
        "rcb_discount_rate": Decimal("0.25"),
        "condition": {
            "min_30d_volume": Decimal("100000000"),
            "min_rcb_hold": Decimal("1750"),
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
        "spot_maker_fee": Decimal("0.0012"),
        "spot_taker_fee": Decimal("0.0016"),
        "contract_maker_fee": None,
        "contract_taker_fee": None,
        "rcb_discount_rate": Decimal("0.25"),
        "condition": {
            "min_30d_volume": Decimal("200000000"),
            "min_rcb_hold": Decimal("3000"),
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
        "spot_maker_fee": Decimal("0.0008"),
        "spot_taker_fee": Decimal("0.0012"),
        "contract_maker_fee": None,
        "contract_taker_fee": None,
        "rcb_discount_rate": Decimal("0.25"),
        "condition": {
            "min_30d_volume": Decimal("300000000"),
            "min_rcb_hold": Decimal("4500"),
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
        "spot_maker_fee": Decimal("0.0004"),
        "spot_taker_fee": Decimal("0.0008"),
        "contract_maker_fee": None,
        "contract_taker_fee": None,
        "rcb_discount_rate": Decimal("0.25"),
        "condition": {
            "min_30d_volume": Decimal("500000000"),
            "min_rcb_hold": Decimal("5500"),
            "min_lock_amount": None,
            "lock_period_days": None,
            "user_limit": None,
            "dividend_rate": None,
        },
    },
]

SVIP_LEVELS = [
    {
        "vip_type": "SVIP",
        "level_code": "NORMAL",
        "level_name": "普通用户",
        "sort_order": 0,
        "spot_maker_fee": Decimal("0.0040"),
        "spot_taker_fee": Decimal("0.0040"),
        "contract_maker_fee": None,
        "contract_taker_fee": None,
        "rcb_discount_rate": Decimal("0.25"),
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
        "spot_maker_fee": Decimal("0.0036"),
        "spot_taker_fee": Decimal("0.0040"),
        "contract_maker_fee": None,
        "contract_taker_fee": None,
        "rcb_discount_rate": Decimal("0.25"),
        "condition": {
            "min_30d_volume": None,
            "min_rcb_hold": None,
            "min_lock_amount": Decimal("1000"),
            "lock_period_days": 365,
            "user_limit": 50000,
            "dividend_rate": Decimal("0.05"),
        },
    },
    {
        "vip_type": "SVIP",
        "level_code": "SVIP2",
        "level_name": "SVIP2",
        "sort_order": 2,
        "spot_maker_fee": Decimal("0.0032"),
        "spot_taker_fee": Decimal("0.0036"),
        "contract_maker_fee": None,
        "contract_taker_fee": None,
        "rcb_discount_rate": Decimal("0.25"),
        "condition": {
            "min_30d_volume": None,
            "min_rcb_hold": None,
            "min_lock_amount": Decimal("2000"),
            "lock_period_days": 365,
            "user_limit": 40000,
            "dividend_rate": Decimal("0.05"),
        },
    },
    {
        "vip_type": "SVIP",
        "level_code": "SVIP3",
        "level_name": "SVIP3",
        "sort_order": 3,
        "spot_maker_fee": Decimal("0.0028"),
        "spot_taker_fee": Decimal("0.0032"),
        "contract_maker_fee": None,
        "contract_taker_fee": None,
        "rcb_discount_rate": Decimal("0.25"),
        "condition": {
            "min_30d_volume": None,
            "min_rcb_hold": None,
            "min_lock_amount": Decimal("3000"),
            "lock_period_days": 365,
            "user_limit": 23000,
            "dividend_rate": Decimal("0.05"),
        },
    },
    {
        "vip_type": "SVIP",
        "level_code": "SVIP4",
        "level_name": "SVIP4",
        "sort_order": 4,
        "spot_maker_fee": Decimal("0.0024"),
        "spot_taker_fee": Decimal("0.0028"),
        "contract_maker_fee": None,
        "contract_taker_fee": None,
        "rcb_discount_rate": Decimal("0.25"),
        "condition": {
            "min_30d_volume": None,
            "min_rcb_hold": None,
            "min_lock_amount": Decimal("5000"),
            "lock_period_days": 365,
            "user_limit": 20000,
            "dividend_rate": Decimal("0.05"),
        },
    },
    {
        "vip_type": "SVIP",
        "level_code": "SVIP5",
        "level_name": "SVIP5",
        "sort_order": 5,
        "spot_maker_fee": Decimal("0.0020"),
        "spot_taker_fee": Decimal("0.0024"),
        "contract_maker_fee": None,
        "contract_taker_fee": None,
        "rcb_discount_rate": Decimal("0.25"),
        "condition": {
            "min_30d_volume": None,
            "min_rcb_hold": None,
            "min_lock_amount": Decimal("10000"),
            "lock_period_days": 365,
            "user_limit": 10000,
            "dividend_rate": Decimal("0.05"),
        },
    },
    {
        "vip_type": "SVIP",
        "level_code": "SVIP6",
        "level_name": "SVIP6",
        "sort_order": 6,
        "spot_maker_fee": Decimal("0.0016"),
        "spot_taker_fee": Decimal("0.0020"),
        "contract_maker_fee": None,
        "contract_taker_fee": None,
        "rcb_discount_rate": Decimal("0.25"),
        "condition": {
            "min_30d_volume": None,
            "min_rcb_hold": None,
            "min_lock_amount": Decimal("20000"),
            "lock_period_days": 720,
            "user_limit": 5000,
            "dividend_rate": Decimal("0.05"),
        },
    },
    {
        "vip_type": "SVIP",
        "level_code": "SVIP7",
        "level_name": "SVIP7",
        "sort_order": 7,
        "spot_maker_fee": Decimal("0.0012"),
        "spot_taker_fee": Decimal("0.0016"),
        "contract_maker_fee": None,
        "contract_taker_fee": None,
        "rcb_discount_rate": Decimal("0.25"),
        "condition": {
            "min_30d_volume": None,
            "min_rcb_hold": None,
            "min_lock_amount": Decimal("40000"),
            "lock_period_days": 720,
            "user_limit": 2500,
            "dividend_rate": Decimal("0.05"),
        },
    },
    {
        "vip_type": "SVIP",
        "level_code": "SVIP8",
        "level_name": "SVIP8",
        "sort_order": 8,
        "spot_maker_fee": Decimal("0.0008"),
        "spot_taker_fee": Decimal("0.0012"),
        "contract_maker_fee": None,
        "contract_taker_fee": None,
        "rcb_discount_rate": Decimal("0.25"),
        "condition": {
            "min_30d_volume": None,
            "min_rcb_hold": None,
            "min_lock_amount": Decimal("50000"),
            "lock_period_days": 720,
            "user_limit": 2000,
            "dividend_rate": Decimal("0.05"),
        },
    },
    {
        "vip_type": "SVIP",
        "level_code": "LP",
        "level_name": "LP",
        "sort_order": 9,
        "spot_maker_fee": Decimal("0.0004"),
        "spot_taker_fee": Decimal("0.0008"),
        "contract_maker_fee": None,
        "contract_taker_fee": None,
        "rcb_discount_rate": Decimal("0.25"),
        "condition": {
            "min_30d_volume": None,
            "min_rcb_hold": None,
            "min_lock_amount": Decimal("100000"),
            "lock_period_days": 1095,
            "user_limit": 1000,
            "dividend_rate": Decimal("0.05"),
        },
    },
]


def _find_level_id(conn, vip_type: str, level_code: str):
    return conn.execute(
        sa.text(
            """
            SELECT id
            FROM vip_fee_levels
            WHERE vip_type = :vip_type AND level_code = :level_code
            LIMIT 1
            """
        ),
        {"vip_type": vip_type, "level_code": level_code},
    ).scalar()


def _find_condition_id(conn, vip_fee_level_id: int):
    return conn.execute(
        sa.text(
            """
            SELECT id
            FROM vip_fee_level_conditions
            WHERE vip_fee_level_id = :vip_fee_level_id
            LIMIT 1
            """
        ),
        {"vip_fee_level_id": vip_fee_level_id},
    ).scalar()


def _upsert_level(conn, level: dict) -> int:
    now = datetime.utcnow()
    level_id = _find_level_id(conn, level["vip_type"], level["level_code"])

    params = {
        "vip_type": level["vip_type"],
        "level_code": level["level_code"],
        "level_name": level["level_name"],
        "sort_order": level["sort_order"],
        "is_enabled": True,
        "spot_maker_fee": level["spot_maker_fee"],
        "spot_taker_fee": level["spot_taker_fee"],
        "contract_maker_fee": level["contract_maker_fee"],
        "contract_taker_fee": level["contract_taker_fee"],
        "rcb_discount_rate": level["rcb_discount_rate"],
        "created_at": now,
        "updated_at": now,
    }

    if level_id is None:
        conn.execute(
            sa.text(
                """
                INSERT INTO vip_fee_levels (
                    vip_type,
                    level_code,
                    level_name,
                    sort_order,
                    is_enabled,
                    spot_maker_fee,
                    spot_taker_fee,
                    contract_maker_fee,
                    contract_taker_fee,
                    rcb_discount_rate,
                    created_at,
                    updated_at
                ) VALUES (
                    :vip_type,
                    :level_code,
                    :level_name,
                    :sort_order,
                    :is_enabled,
                    :spot_maker_fee,
                    :spot_taker_fee,
                    :contract_maker_fee,
                    :contract_taker_fee,
                    :rcb_discount_rate,
                    :created_at,
                    :updated_at
                )
                """
            ),
            params,
        )
        level_id = _find_level_id(conn, level["vip_type"], level["level_code"])
    else:
        conn.execute(
            sa.text(
                """
                UPDATE vip_fee_levels
                SET
                    level_name = :level_name,
                    sort_order = :sort_order,
                    is_enabled = :is_enabled,
                    spot_maker_fee = :spot_maker_fee,
                    spot_taker_fee = :spot_taker_fee,
                    contract_maker_fee = :contract_maker_fee,
                    contract_taker_fee = :contract_taker_fee,
                    rcb_discount_rate = :rcb_discount_rate,
                    updated_at = :updated_at
                WHERE id = :level_id
                """
            ),
            {**params, "level_id": level_id},
        )

    return int(level_id)


def _upsert_condition(conn, vip_fee_level_id: int, condition: dict) -> None:
    now = datetime.utcnow()
    condition_id = _find_condition_id(conn, vip_fee_level_id)
    params = {
        "vip_fee_level_id": vip_fee_level_id,
        "min_30d_volume": condition["min_30d_volume"],
        "min_rcb_hold": condition["min_rcb_hold"],
        "min_lock_amount": condition["min_lock_amount"],
        "lock_period_days": condition["lock_period_days"],
        "user_limit": condition["user_limit"],
        "dividend_rate": condition["dividend_rate"],
        "created_at": now,
        "updated_at": now,
    }

    if condition_id is None:
        conn.execute(
            sa.text(
                """
                INSERT INTO vip_fee_level_conditions (
                    vip_fee_level_id,
                    min_30d_volume,
                    min_rcb_hold,
                    min_lock_amount,
                    lock_period_days,
                    user_limit,
                    dividend_rate,
                    created_at,
                    updated_at
                ) VALUES (
                    :vip_fee_level_id,
                    :min_30d_volume,
                    :min_rcb_hold,
                    :min_lock_amount,
                    :lock_period_days,
                    :user_limit,
                    :dividend_rate,
                    :created_at,
                    :updated_at
                )
                """
            ),
            params,
        )
    else:
        conn.execute(
            sa.text(
                """
                UPDATE vip_fee_level_conditions
                SET
                    min_30d_volume = :min_30d_volume,
                    min_rcb_hold = :min_rcb_hold,
                    min_lock_amount = :min_lock_amount,
                    lock_period_days = :lock_period_days,
                    user_limit = :user_limit,
                    dividend_rate = :dividend_rate,
                    updated_at = :updated_at
                WHERE id = :condition_id
                """
            ),
            {**params, "condition_id": condition_id},
        )


def upgrade() -> None:
    conn = op.get_bind()
    for level in VIP_LEVELS + SVIP_LEVELS:
        level_id = _upsert_level(conn, level)
        _upsert_condition(conn, level_id, level["condition"])


def downgrade() -> None:
    conn = op.get_bind()
    for level in reversed(VIP_LEVELS + SVIP_LEVELS):
        level_id = _find_level_id(conn, level["vip_type"], level["level_code"])
        if level_id is None:
            continue
        conn.execute(
            sa.text(
                """
                DELETE FROM vip_fee_level_conditions
                WHERE vip_fee_level_id = :vip_fee_level_id
                """
            ),
            {"vip_fee_level_id": level_id},
        )
        conn.execute(
            sa.text(
                """
                DELETE FROM vip_fee_levels
                WHERE id = :id
                """
            ),
            {"id": level_id},
        )
