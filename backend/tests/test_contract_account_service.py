from __future__ import annotations

from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import MagicMock

from app.services import contract_account_service as service


def _session_with_account(account):
    db = MagicMock()
    query = MagicMock()
    db.query.return_value = query
    query.filter.return_value = query
    query.first.return_value = account
    return db


def test_account_summary_returns_zero_values_without_creating_account():
    db = _session_with_account(None)

    summary = service.get_contract_account_summary(db, user_id=42)

    assert summary.model_dump() == {
        "user_id": 42,
        "margin_asset": "USDT",
        "available_margin": "0",
        "used_margin": "0",
        "frozen_margin": "0",
        "position_margin": "0",
        "realized_pnl": "0",
        "unrealized_pnl": "0",
        "equity": "0",
    }
    db.add.assert_not_called()
    db.flush.assert_not_called()
    db.commit.assert_not_called()
    db.refresh.assert_not_called()


def test_account_summary_reads_existing_account_without_committing():
    db = _session_with_account(
        SimpleNamespace(
            user_id=42,
            margin_asset="USDT",
            available_margin=Decimal("10"),
            frozen_margin=Decimal("2"),
            position_margin=Decimal("3"),
            realized_pnl=Decimal("4"),
            unrealized_pnl=Decimal("5"),
        )
    )

    summary = service.get_contract_account_summary(db, user_id=42)

    assert summary.available_margin == "10"
    assert summary.used_margin == "3"
    assert summary.frozen_margin == "2"
    assert summary.position_margin == "3"
    assert summary.realized_pnl == "4"
    assert summary.unrealized_pnl == "5"
    assert summary.equity == "20"
    db.commit.assert_not_called()
    db.refresh.assert_not_called()
