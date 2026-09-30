from copy import deepcopy
from datetime import datetime
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from app.routers.asset import _balance_log_display_amount, list_my_balance_logs


@pytest.mark.parametrize("change_type", [
    "WITHDRAW_FREEZE", "WITHDRAW_FEE_FREEZE", "WITHDRAW_SUCCESS", "WITHDRAW_FEE_SUCCESS",
])
@pytest.mark.parametrize("stored", ["0.005000000000000001", "-0.005000000000000001"])
def test_withdraw_outflow_is_negative_without_double_negating_or_losing_precision(change_type, stored):
    row = {"change_type": change_type, "raw_biz_type": "WITHDRAW", "direction": -1, "change_amount": Decimal(stored)}
    assert _balance_log_display_amount(row) == "-0.005000000000000001"
    assert row["change_amount"] == Decimal(stored)


@pytest.mark.parametrize("change_type", [
    "WITHDRAW_CANCEL", "WITHDRAW_FEE_CANCEL", "WITHDRAW_UNFREEZE", "WITHDRAW_FEE_UNFREEZE", "WITHDRAW_REFUND",
])
def test_returned_funds_stay_positive(change_type):
    assert _balance_log_display_amount({"change_type": change_type, "direction": 1, "change_amount": Decimal("0.1")}) == "0.1"


@pytest.mark.parametrize("change_type,direction,amount", [
    ("DEPOSIT", 1, "0.1"),
    ("TRADE_FEE_DEBIT", -1, "-0.005"),
    ("REALIZED_PNL", -1, "-0.123456789012345678"),
    ("REALIZED_PNL", 1, "0.123456789012345678"),
    ("TRANSFER_OUT", -1, "1.5"),
    ("WITHDRAW_SUCCESS", None, "0.1"),
])
def test_other_ledger_conventions_and_missing_direction_are_unchanged(change_type, direction, amount):
    assert _balance_log_display_amount({"change_type": change_type, "direction": direction, "change_amount": Decimal(amount)}) == amount


def test_legacy_withdraw_type_and_zero():
    assert _balance_log_display_amount({"raw_biz_type": "WITHDRAW", "direction": -1, "change_amount": Decimal("1")}) == "-1"
    assert _balance_log_display_amount({"change_type": "WITHDRAW_FEE_SUCCESS", "direction": -1, "change_amount": Decimal("0.000")}) == "0.000"


def test_balance_history_response_applies_direction_without_writing_ledger():
    rows = [
        {"id": index, "created_at": datetime(2026, 9, 19, 8, 34, 7),
         "change_type": change_type, "raw_biz_type": biz_type, "direction": direction,
         "change_amount": Decimal(amount), "after_available": Decimal("6.26032967"),
         "coin_symbol": "USDT", "chain_key": "funding"}
        for index, (change_type, biz_type, direction, amount) in enumerate([
            ("WITHDRAW_FEE_SUCCESS", "WITHDRAW", -1, "0.005"),
            ("WITHDRAW_SUCCESS", "WITHDRAW", -1, "0.1"),
            ("WITHDRAW_FEE_FREEZE", "WITHDRAW", -1, "0.005"),
            ("WITHDRAW_CANCEL", "WITHDRAW", 1, "0.1"),
            ("DEPOSIT", "DEPOSIT", 1, "0.1"),
        ], 1)
    ]
    before = deepcopy(rows)
    db = Mock()
    count_result = Mock()
    count_result.mappings.return_value.first.return_value = {"cnt": len(rows)}
    rows_result = Mock()
    rows_result.mappings.return_value.all.return_value = rows
    db.execute.side_effect = [count_result, rows_result]
    response = list_my_balance_logs(SimpleNamespace(state=SimpleNamespace()), db=db, user_id=10)
    assert response["ok"] is True
    assert [r["change_amount"] for r in response["data"]["items"]] == ["-0.005", "-0.1", "-0.005", "0.1", "0.1"]
    assert all(r["after_available"] == "6.26032967" for r in response["data"]["items"])
    assert "direction," in str(db.execute.call_args_list[1].args[0])
    assert all(str(call.args[0]).lstrip().startswith("SELECT") for call in db.execute.call_args_list)
    db.commit.assert_not_called()
    assert rows == before
