from __future__ import annotations

from decimal import Decimal

import pytest

from app.services.contract_order_service import (
    ContractOrderWouldLiquidate,
    _ensure_open_equity_above_liquidation_threshold,
)


def test_open_guard_rejects_the_reported_eth_spread_and_leverage_combination() -> None:
    with pytest.raises(ContractOrderWouldLiquidate) as exc_info:
        _ensure_open_equity_above_liquidation_threshold(
            position_side="LONG",
            entry_price=Decimal("2603.66"),
            mark_price=Decimal("2504.445"),
            quantity=Decimal("1"),
            margin_amount=Decimal("13.0183"),
            liquidation_threshold=Decimal("0"),
        )

    assert exc_info.value.code == "OPEN_WOULD_LIQUIDATE_IMMEDIATELY"


def test_open_guard_allows_a_position_with_equity_above_threshold() -> None:
    _ensure_open_equity_above_liquidation_threshold(
        position_side="LONG",
        entry_price=Decimal("2504.45"),
        mark_price=Decimal("2504.445"),
        quantity=Decimal("1"),
        margin_amount=Decimal("12.52225"),
        liquidation_threshold=Decimal("0"),
    )


def test_open_guard_applies_non_zero_symbol_threshold() -> None:
    with pytest.raises(ContractOrderWouldLiquidate):
        _ensure_open_equity_above_liquidation_threshold(
            position_side="SHORT",
            entry_price=Decimal("100"),
            mark_price=Decimal("100.95"),
            quantity=Decimal("1"),
            margin_amount=Decimal("1"),
            liquidation_threshold=Decimal("0.1"),
        )
