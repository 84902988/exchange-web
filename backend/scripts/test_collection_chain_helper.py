from __future__ import annotations

import os
import sys
from decimal import Decimal


BACKEND_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

from app.services.collection_chain_helper import (  # noqa: E402
    compute_gas_topup_amount,
    compute_min_collect_amount,
    evaluate_collection_candidate,
)


FROM_ADDRESS = "0x1111111111111111111111111111111111111111"
TO_ADDRESS = "0x2222222222222222222222222222222222222222"
TOKEN_CONTRACT = "0x3333333333333333333333333333333333333333"


def _assert(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def main() -> None:
    bsc_collectible = evaluate_collection_candidate(
        chain_key="bsc",
        coin_symbol="USDT",
        from_address=FROM_ADDRESS,
        to_address=TO_ADDRESS,
        token_contract_address=TOKEN_CONTRACT,
        token_balance=Decimal("100"),
        native_balance=Decimal("0.01"),
        estimated_gas_native=Decimal("0.0008"),
        estimated_gas_usdt=Decimal("0.2"),
    )
    _assert(bsc_collectible.should_collect is True, "bsc balance=100 should collect")
    _assert(bsc_collectible.gas_required is False, "bsc gas should be sufficient")

    bsc_too_small = evaluate_collection_candidate(
        chain_key="bsc",
        coin_symbol="USDT",
        from_address=FROM_ADDRESS,
        to_address=TO_ADDRESS,
        token_contract_address=TOKEN_CONTRACT,
        token_balance=Decimal("1"),
        native_balance=Decimal("0.01"),
        estimated_gas_native=Decimal("0.0008"),
        estimated_gas_usdt=Decimal("0.2"),
    )
    _assert(bsc_too_small.should_collect is False, "bsc balance=1 should not collect")

    bsc_gas_low = evaluate_collection_candidate(
        chain_key="bsc",
        coin_symbol="USDT",
        from_address=FROM_ADDRESS,
        to_address=TO_ADDRESS,
        token_contract_address=TOKEN_CONTRACT,
        token_balance=Decimal("100"),
        native_balance=Decimal("0.0001"),
        estimated_gas_native=Decimal("0.0008"),
        estimated_gas_usdt=Decimal("0.2"),
    )
    _assert(bsc_gas_low.should_collect is True, "bsc balance=100 should still be collectible")
    _assert(bsc_gas_low.gas_required is True, "bsc low native balance should need gas")
    _assert(bsc_gas_low.gas_topup_amount > 0, "bsc gas topup should be positive")

    bsc_gas_ok = compute_gas_topup_amount(
        chain_key="bsc",
        current_native_balance=Decimal("0.01"),
        estimated_required_native=Decimal("0.0008"),
    )
    _assert(bsc_gas_ok.gas_required is False, "bsc sufficient gas should not require topup")

    bsc_min = compute_min_collect_amount(chain_key="bsc", coin_symbol="USDT")
    eth_min = compute_min_collect_amount(chain_key="eth", coin_symbol="USDT")
    _assert(eth_min > bsc_min, "eth default min collect should be higher than bsc")

    capped = compute_gas_topup_amount(
        chain_key="bsc",
        current_native_balance=Decimal("0"),
        estimated_required_native=Decimal("1"),
    )
    _assert(capped.gas_required is True, "large bsc estimate should require gas")
    _assert(capped.topup_amount == Decimal("0.01"), "bsc topup should be capped at 0.01")

    print("collection_chain_helper_test")
    print(
        "bsc_collectible "
        f"should_collect={bsc_collectible.should_collect} gas_required={bsc_collectible.gas_required} "
        f"collect_amount={bsc_collectible.collect_amount} min={bsc_collectible.min_collect_amount}"
    )
    print(
        "bsc_too_small "
        f"should_collect={bsc_too_small.should_collect} reason={bsc_too_small.reason}"
    )
    print(
        "bsc_gas_low "
        f"gas_required={bsc_gas_low.gas_required} gas_topup_amount={bsc_gas_low.gas_topup_amount} "
        f"gas_coin={bsc_gas_low.gas_coin_symbol}"
    )
    print(f"default_min bsc={bsc_min} eth={eth_min}")
    print(f"cap_check bsc_topup={capped.topup_amount}")
    print("ok")


if __name__ == "__main__":
    main()
