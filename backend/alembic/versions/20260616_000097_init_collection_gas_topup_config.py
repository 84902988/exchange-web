"""init collection gas topup config

Revision ID: 20260616_000097
Revises: 20260616_000096
Create Date: 2026-06-16
"""

from __future__ import annotations

import json
from datetime import datetime
from typing import Optional, Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260616_000097"
down_revision: Union[str, None] = "20260616_000096"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

CONFIG_KEY = "collection_gas_topup_config_v1"

DEFAULT_CONFIG = {
    "chains": {
        "bsc": {
            "gas_topup_mode": "DEFAULT",
            "safe_multiplier": "3",
            "buffer": "0.0005",
            "cap": "0.01",
            "min_topup": "0",
            "max_topup": "0.01",
        },
        "polygon": {
            "gas_topup_mode": "DEFAULT",
            "safe_multiplier": "3",
            "buffer": "0.1",
            "cap": "2",
            "min_topup": "0",
            "max_topup": "2",
        },
        "avaxc": {
            "gas_topup_mode": "DEFAULT",
            "safe_multiplier": "3",
            "buffer": "0.1",
            "cap": "0.25",
            "min_topup": "0",
            "max_topup": "0.25",
        },
        "arbitrum": {
            "gas_topup_mode": "DEFAULT",
            "safe_multiplier": "3",
            "buffer": "0.0002",
            "cap": "0.005",
            "min_topup": "0",
            "max_topup": "0.005",
        },
        "ethereum": {
            "gas_topup_mode": "DEFAULT",
            "safe_multiplier": "3",
            "buffer": "0.01",
            "cap": "0.025",
            "min_topup": "0",
            "max_topup": "0.025",
        },
        "optimism": {
            "gas_topup_mode": "DEFAULT",
            "safe_multiplier": "3",
            "buffer": "0.002",
            "cap": "0.005",
            "min_topup": "0",
            "max_topup": "0.005",
        },
    }
}


def _has_table(table_name: str) -> bool:
    if bool(getattr(op.get_context(), "as_sql", False)):
        return False
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    return table_name in inspector.get_table_names()


def _has_column(table_name: str, column_name: str) -> bool:
    if bool(getattr(op.get_context(), "as_sql", False)):
        return False
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    return any(column.get("name") == column_name for column in inspector.get_columns(table_name))


def _merge_default_config(existing_value: Optional[str]) -> str:
    try:
        payload = json.loads(existing_value or "{}")
    except Exception:
        payload = {}
    if not isinstance(payload, dict):
        payload = {}
    chains = payload.setdefault("chains", {})
    if not isinstance(chains, dict):
        chains = {}
        payload["chains"] = chains

    for chain_key, defaults in DEFAULT_CONFIG["chains"].items():
        current = chains.setdefault(chain_key, {})
        if not isinstance(current, dict):
            current = {}
            chains[chain_key] = current
        for key, value in defaults.items():
            current.setdefault(key, value)
    return json.dumps(payload, ensure_ascii=False, sort_keys=True)


def _upsert_default_config() -> None:
    if bool(getattr(op.get_context(), "as_sql", False)) or not _has_table("system_configs"):
        return
    bind = op.get_bind()
    row = bind.execute(
        sa.text("SELECT id, config_value FROM system_configs WHERE config_key = :config_key LIMIT 1"),
        {"config_key": CONFIG_KEY},
    ).mappings().first()
    now = datetime.utcnow()
    if row:
        merged = _merge_default_config(row.get("config_value"))
        bind.execute(
            sa.text(
                """
                UPDATE system_configs
                SET config_value = :config_value, updated_at = :updated_at
                WHERE config_key = :config_key
                """
            ),
            {"config_value": merged, "updated_at": now, "config_key": CONFIG_KEY},
        )
        return
    bind.execute(
        sa.text(
            """
            INSERT INTO system_configs (config_key, config_value, description, created_at, updated_at)
            VALUES (:config_key, :config_value, :description, :created_at, :updated_at)
            """
        ),
        {
            "config_key": CONFIG_KEY,
            "config_value": json.dumps(DEFAULT_CONFIG, ensure_ascii=False, sort_keys=True),
            "description": "EVM collection gas topup operation config",
            "created_at": now,
            "updated_at": now,
        },
    )


def upgrade() -> None:
    if _has_table("gas_tasks"):
        if not _has_column("gas_tasks", "gas_topup_mode"):
            op.add_column("gas_tasks", sa.Column("gas_topup_mode", sa.String(length=32), nullable=True))
        if not _has_column("gas_tasks", "estimate_source"):
            op.add_column("gas_tasks", sa.Column("estimate_source", sa.String(length=32), nullable=True))
    _upsert_default_config()


def downgrade() -> None:
    if _has_table("gas_tasks"):
        if _has_column("gas_tasks", "estimate_source"):
            op.drop_column("gas_tasks", "estimate_source")
        if _has_column("gas_tasks", "gas_topup_mode"):
            op.drop_column("gas_tasks", "gas_topup_mode")
