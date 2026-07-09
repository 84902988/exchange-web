from __future__ import annotations

from decimal import Decimal
from types import SimpleNamespace

from app.services import contract_query_service as service


def _position(**overrides):
    payload = {
        "symbol": "AAPLUSDT_PERP",
        "side": "LONG",
        "quantity": Decimal("2"),
        "entry_price": Decimal("100"),
        "margin_amount": Decimal("20"),
        "liquidation_price": Decimal("0"),
    }
    payload.update(overrides)
    return SimpleNamespace(**payload)


def test_position_liquidation_price_derives_from_margin_when_stored_value_is_empty():
    position = _position()

    liquidation_price = service._position_display_liquidation_price(position, Decimal("0"))
    risk_metrics = service._position_risk_metrics(
        side=position.side,
        quantity=position.quantity,
        mark_price=Decimal("110"),
        margin_amount=position.margin_amount,
        unrealized_pnl=Decimal("20"),
        liquidation_price=liquidation_price,
    )

    assert liquidation_price == Decimal("90")
    assert risk_metrics["liquidation_distance"] == Decimal("20")
    assert risk_metrics["liquidation_distance_rate"].quantize(Decimal("0.0001")) == Decimal("18.1818")


def test_position_liquidation_price_respects_symbol_threshold():
    position = _position(side="SHORT")

    liquidation_price = service._position_display_liquidation_price(position, Decimal("0.1"))

    assert liquidation_price == Decimal("109.0")


def test_single_summary_liquidation_price_derives_from_the_position():
    position = _position()

    liquidation_price = service._summary_display_liquidation_price(
        [position],
        {"AAPLUSDT_PERP": Decimal("0")},
    )

    assert liquidation_price == Decimal("90")


def test_multi_position_summary_liquidation_price_uses_group_margin_and_average_entry():
    positions = [
        _position(quantity=Decimal("0.2"), entry_price=Decimal("297.84"), margin_amount=Decimal("5.9568")),
        _position(quantity=Decimal("0.8"), entry_price=Decimal("298.36"), margin_amount=Decimal("23.8688")),
        _position(quantity=Decimal("0.1"), entry_price=Decimal("298.36"), margin_amount=Decimal("2.9836")),
        _position(quantity=Decimal("0.1"), entry_price=Decimal("298.36"), margin_amount=Decimal("2.9836")),
    ]

    liquidation_price = service._summary_display_liquidation_price(
        positions,
        {"AAPLUSDT_PERP": Decimal("0")},
    )

    assert liquidation_price == Decimal("268.4466666666666666666666667")
