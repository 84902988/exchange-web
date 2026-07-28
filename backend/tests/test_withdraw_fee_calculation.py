from __future__ import annotations

from decimal import Decimal
from pathlib import Path
import sys


BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.routers.asset_withdraw import _calculate_dynamic_withdraw_fee_usdt
from app.services.withdraw_fee_service import calculate_suggested_fee


def test_dynamic_fee_keeps_raw_cost_unbuffered_and_applies_one_safety_multiplier() -> None:
    raw_cost, direct_fee, source = _calculate_dynamic_withdraw_fee_usdt(
        fee_native=Decimal("0.000005"),
        native_price_usdt=Decimal("2000"),
        buffer=Decimal("1.3"),
        min_fee=Decimal("0.005"),
    )

    assert raw_cost == Decimal("0.010000")
    assert direct_fee == Decimal("0.013000")
    assert source == "DYNAMIC"

    maintained_fee = calculate_suggested_fee(
        raw_cost,
        Decimal("1.3"),
        Decimal("0.005"),
        Decimal("100"),
    )
    assert maintained_fee == Decimal("0.013")


def test_dynamic_fee_still_honors_minimum_after_single_buffer() -> None:
    raw_cost, direct_fee, source = _calculate_dynamic_withdraw_fee_usdt(
        fee_native=Decimal("0.0000005"),
        native_price_usdt=Decimal("2000"),
        buffer=Decimal("1.3"),
        min_fee=Decimal("0.005"),
    )

    assert raw_cost == Decimal("0.001000")
    assert direct_fee == Decimal("0.005")
    assert source == "MIN_FEE"
