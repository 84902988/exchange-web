"""expand contract spread_x check range

Revision ID: 20260614_000092
Revises: 20260614_000091
Create Date: 2026-06-14
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260614_000092"
down_revision = "20260614_000091"
branch_labels = None
depends_on = None


def _has_table(bind, table_name: str) -> bool:
    return sa.inspect(bind).has_table(table_name)


def _quote_identifier(value: str) -> str:
    return "`" + value.replace("`", "``") + "`"


def _spread_x_check_constraints(bind) -> list[tuple[str, str]]:
    rows = bind.execute(
        sa.text(
            """
            SELECT cc.constraint_name, cc.check_clause
            FROM information_schema.check_constraints cc
            JOIN information_schema.table_constraints tc
              ON tc.constraint_schema = cc.constraint_schema
             AND tc.constraint_name = cc.constraint_name
            WHERE tc.table_schema = DATABASE()
              AND tc.table_name = 'contract_symbols'
              AND tc.constraint_type = 'CHECK'
              AND LOWER(cc.check_clause) LIKE '%spread_x%'
            ORDER BY cc.constraint_name
            """
        )
    ).all()
    return [(str(row[0]), str(row[1])) for row in rows]


def _is_spread_x_check_clause(clause: str, max_value: str) -> bool:
    normalized_max = max_value.strip()
    normalized_clause = clause.replace("`", "").replace(" ", "").lower()
    return "spread_x>=0" in normalized_clause and f"spread_x<={normalized_max}" in normalized_clause


def _has_only_target_spread_x_check(bind, max_value: str) -> bool:
    constraints = _spread_x_check_constraints(bind)
    return len(constraints) == 1 and _is_spread_x_check_clause(constraints[0][1], max_value)


def _drop_spread_x_checks(bind) -> None:
    for constraint_name, _clause in _spread_x_check_constraints(bind):
        bind.execute(
            sa.text(
                f"ALTER TABLE {_quote_identifier('contract_symbols')} "
                f"DROP CHECK {_quote_identifier(constraint_name)}"
            )
        )


def _add_spread_x_check(bind, max_value: str) -> None:
    bind.execute(
        sa.text(
            "ALTER TABLE `contract_symbols` "
            "ADD CONSTRAINT `ck_contract_symbols_spread_x_range` "
            f"CHECK (spread_x >= 0 AND spread_x <= {max_value})"
        )
    )


def upgrade() -> None:
    bind = op.get_bind()
    if not _has_table(bind, "contract_symbols"):
        return
    if _has_only_target_spread_x_check(bind, "100"):
        return
    _drop_spread_x_checks(bind)
    _add_spread_x_check(bind, "100")


def downgrade() -> None:
    bind = op.get_bind()
    if not _has_table(bind, "contract_symbols"):
        return
    if _has_only_target_spread_x_check(bind, "50"):
        return
    _drop_spread_x_checks(bind)
    _add_spread_x_check(bind, "50")
