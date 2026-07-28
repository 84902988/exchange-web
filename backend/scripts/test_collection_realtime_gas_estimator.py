from __future__ import annotations

import os
import sys
from decimal import Decimal
from unittest.mock import patch


BACKEND_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

from app.services.collection_chain_helper import (  # noqa: E402
    _fallback_token_transfer_gas_native,
    evaluate_collection_candidate,
)
from app.services.collection_evm_gas_estimator import clear_evm_gas_estimate_cache  # noqa: E402
from app.services.collection_gas_config_service import resolve_gas_topup_parameters  # noqa: E402
from app.services.collection_send_helper import _estimate_gas_with_buffer  # noqa: E402


FROM_ADDRESS = "0x1111111111111111111111111111111111111111"
TO_ADDRESS = "0x2222222222222222222222222222222222222222"
TOKEN_CONTRACT = "0x3333333333333333333333333333333333333333"


def _assert(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def _preview(**_kwargs):
    return {
        "gas": 60000,
        "maxFeePerGas": 2_000_000_000,
        "gasPrice": None,
    }


def _evaluate(chain_key: str = "bsc"):
    return evaluate_collection_candidate(
        chain_key=chain_key,
        coin_symbol="USDT",
        from_address=FROM_ADDRESS,
        to_address=TO_ADDRESS,
        token_contract_address=TOKEN_CONTRACT,
        token_decimals=18,
        token_balance=Decimal("100"),
        native_balance=Decimal("0"),
        min_collect_amount=Decimal("10"),
    )


class _FakeEth:
    def __init__(self):
        self.transactions = []

    def estimate_gas(self, transaction, state_override=None):
        self.transactions.append((dict(transaction), state_override))
        if len(self.transactions) == 1:
            raise ValueError({"code": -32000, "message": "insufficient funds for transfer"})
        return 50000


class _FakeWeb3:
    def __init__(self):
        self.eth = _FakeEth()


def main() -> None:
    clear_evm_gas_estimate_cache()
    with patch("app.services.collection_send_helper.preview_erc20_collect_transfer_tx", side_effect=_preview) as preview:
        first = _evaluate()
        second = _evaluate()

    expected_fee = Decimal("0.00012")
    _assert(first.estimated_required_native == expected_fee, "realtime fee must use gas limit times max fee")
    _assert(first.estimate_source == "REALTIME_RPC", "first estimate must come from RPC")
    _assert(first.gas_topup_amount == Decimal("0.00048"), "dynamic buffer must be bounded by realtime fee")
    _assert(second.estimate_source == "REALTIME_RPC_CACHE", "second estimate must use short cache")
    _assert(preview.call_count == 1, "identical estimate must hit RPC only once")

    fake_w3 = _FakeWeb3()
    buffered_gas = _estimate_gas_with_buffer(
        fake_w3,
        {
            "from": FROM_ADDRESS,
            "to": TOKEN_CONTRACT,
            "data": "0x1234",
            "maxFeePerGas": 2_000_000_000,
            "maxPriorityFeePerGas": 1_000_000_000,
        },
        allow_unfunded_sender=True,
    )
    _assert(buffered_gas == 60000, "unfunded estimation must retain the 20 percent gas-unit buffer")
    _assert(len(fake_w3.eth.transactions) == 2, "unfunded estimation must retry exactly once when fee-neutral works")
    _assert(
        "maxFeePerGas" not in fake_w3.eth.transactions[1][0],
        "unfunded retry must remove fee fields without changing calldata",
    )

    dynamic = resolve_gas_topup_parameters(
        None,
        chain_key="bsc",
        token_symbol="USDT",
        estimated_required_native=expected_fee,
        estimate_source="REALTIME_RPC",
    )
    _assert(dynamic["effective_buffer"] == expected_fee, "realtime absolute buffer must be bounded")
    _assert(dynamic["target_balance"] == Decimal("0.00048"), "realtime target must remain conservative")

    clear_evm_gas_estimate_cache()
    with patch(
        "app.services.collection_send_helper.preview_erc20_collect_transfer_tx",
        side_effect=RuntimeError("rpc unavailable"),
    ):
        fallback = _evaluate("ethereum")
    _assert(fallback.estimate_source == "DEFAULT_FALLBACK", "RPC failure must use conservative default")
    _assert(fallback.gas_topup_amount == Decimal("0.025"), "Ethereum fallback must keep legacy cap")

    with patch(
        "app.services.collection_gas_config_service.load_stats_p95_native_fee",
        return_value={"sample_count": 8, "p95_native_fee": Decimal("0.0002")},
    ):
        historical_fee, historical_source = _fallback_token_transfer_gas_native(
            chain_key="bsc",
            coin_symbol="USDT",
            db=object(),
        )
    _assert(historical_fee == Decimal("0.0002"), "historical P95 must be the first RPC fallback")
    _assert(historical_source == "STATS_P95_FALLBACK", "historical fallback source must be explicit")

    print("collection_realtime_gas_estimator_test")
    print("realtime_source=ok unfunded_sender=ok cache=ok dynamic_buffer=ok historical_fallback=ok conservative_fallback=ok")
    print("ok")


if __name__ == "__main__":
    main()
