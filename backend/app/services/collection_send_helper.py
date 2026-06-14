from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from decimal import Decimal
from typing import Any
from uuid import uuid4

from eth_account import Account

from app.core.chain_config import get_runtime_chain_config
from app.services.solana_client import SOLANA_SENDER_DEPENDENCY_ERROR, send_sol_transfer, send_spl_token_transfer
from app.services.solana_wallet import is_solana_address
from app.services.collection_balance_checker import get_web3_for_chain
from app.services.collection_send_guard import is_collection_real_send_master_enabled, validate_collection_send_allowed


ERC20_TRANSFER_ABI = [
    {
        "name": "transfer",
        "type": "function",
        "stateMutability": "nonpayable",
        "inputs": [
            {"name": "_to", "type": "address"},
            {"name": "_value", "type": "uint256"},
        ],
        "outputs": [{"name": "", "type": "bool"}],
    }
]
DEFAULT_EIP1559_PRIORITY_FEE_GWEI = "1"


@dataclass(frozen=True)
class SendResult:
    ok: bool
    dry_run: bool
    tx_hash: str | None
    error_message: str | None
    from_address: str
    to_address: str
    chain_key: str
    amount: Decimal
    coin_symbol: str
    raw_tx_created: bool
    signed: bool
    broadcasted: bool


def is_collection_real_send_enabled() -> bool:
    return is_collection_real_send_master_enabled()


def _normalize_chain_key(chain_key: str) -> str:
    ck = (chain_key or "").strip().lower()
    if not ck:
        raise ValueError("chain_key is required")
    return ck


def _normalize_address(address: str, field_name: str) -> str:
    value = (address or "").strip()
    if not value:
        raise ValueError(f"{field_name} is required")
    return value


def _chain_rpc_urls_from_db(db, chain_key: str) -> list[str]:
    if db is None:
        return []
    try:
        rpc_urls = get_runtime_chain_config(db, chain_key).rpc_urls
    except Exception:
        rpc_urls = []
    return [url.strip() for url in rpc_urls if url and url.strip()]


def _chain_rpc_url_from_db(db, chain_key: str) -> str | None:
    urls = _chain_rpc_urls_from_db(db, chain_key)
    return urls[0] if urls else None


def _send_with_rpc_fallback(send_fn: Callable[[str | None], str], rpc_urls: list[str]) -> str:
    candidates = rpc_urls or [None]
    last_error: Exception | None = None
    for rpc_url in candidates:
        try:
            return send_fn(rpc_url)
        except Exception as exc:
            last_error = exc
            continue
    raise RuntimeError(str(last_error or "all RPC attempts failed"))


def _to_decimal(value: Decimal) -> Decimal:
    amount = Decimal(str(value))
    if amount <= 0:
        raise ValueError("amount must be > 0")
    return amount


def _dry_result(
    *,
    prefix: str,
    chain_key: str,
    from_address: str,
    to_address: str,
    amount: Decimal,
    coin_symbol: str,
) -> SendResult:
    return SendResult(
        ok=True,
        dry_run=True,
        tx_hash=f"{prefix}_{uuid4().hex}",
        error_message=None,
        from_address=from_address,
        to_address=to_address,
        chain_key=chain_key,
        amount=amount,
        coin_symbol=coin_symbol,
        raw_tx_created=False,
        signed=False,
        broadcasted=False,
    )


def _guard_rejected_result(
    *,
    guard_reason: str,
    chain_key: str,
    from_address: str,
    to_address: str,
    amount: Decimal,
    coin_symbol: str,
) -> SendResult:
    return SendResult(
        ok=False,
        dry_run=False,
        tx_hash=None,
        error_message=f"GUARD_REJECTED:{guard_reason}",
        from_address=from_address,
        to_address=to_address,
        chain_key=chain_key,
        amount=amount,
        coin_symbol=coin_symbol,
        raw_tx_created=False,
        signed=False,
        broadcasted=False,
    )


def _resolve_private_key(private_key_or_provider: str | Callable[[], str]) -> str:
    if callable(private_key_or_provider):
        return private_key_or_provider()
    return private_key_or_provider


def assert_private_key_matches_address(private_key: str, expected_address: str) -> str:
    expected = _normalize_address(expected_address, "expected_address")
    try:
        account = Account.from_key((private_key or "").strip())
    except Exception as exc:
        raise ValueError("invalid private key") from exc
    actual = str(account.address)
    if actual.lower() != expected.lower():
        raise ValueError("private key does not match expected address")
    return actual


def _gas_price(w3):
    try:
        value = int(w3.eth.gas_price)
        if value > 0:
            return value
    except Exception:
        pass
    return int(w3.to_wei("3", "gwei"))


def _rpc_int(value: Any) -> int | None:
    if value is None:
        return None
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        return int(text, 16) if text.lower().startswith("0x") else int(text)
    return int(value)


def _latest_base_fee_per_gas(w3) -> int | None:
    for _attempt in range(3):
        try:
            block = w3.eth.get_block("latest")
            if isinstance(block, dict):
                value = block.get("baseFeePerGas")
            else:
                value = getattr(block, "baseFeePerGas", None)
            base_fee = _rpc_int(value)
            if base_fee and base_fee > 0:
                return base_fee
        except Exception:
            continue
    try:
        history = w3.eth.fee_history(1, "latest", [])
        base_fees = history.get("baseFeePerGas") if isinstance(history, dict) else getattr(history, "baseFeePerGas", None)
        if base_fees:
            base_fee = _rpc_int(base_fees[-1])
            if base_fee and base_fee > 0:
                return base_fee
    except Exception:
        return None
    return None


def _max_priority_fee_per_gas(w3) -> int:
    default_priority_fee = int(w3.to_wei(DEFAULT_EIP1559_PRIORITY_FEE_GWEI, "gwei"))
    for getter in (
        lambda: getattr(w3.eth, "max_priority_fee"),
        lambda: w3.manager.request_blocking("eth_maxPriorityFeePerGas", []),
    ):
        try:
            value = _rpc_int(getter())
            if value and value > 0:
                return max(value, default_priority_fee)
        except Exception:
            continue
    return default_priority_fee


def _evm_fee_fields(w3) -> tuple[dict[str, int], dict[str, int | str | None]]:
    base_fee = _latest_base_fee_per_gas(w3)
    if base_fee is not None:
        priority_fee = _max_priority_fee_per_gas(w3)
        max_fee = max((base_fee * 2) + priority_fee, base_fee + priority_fee)
        return (
            {
                "maxPriorityFeePerGas": int(priority_fee),
                "maxFeePerGas": int(max_fee),
            },
            {
                "type": "eip1559",
                "baseFeePerGas": int(base_fee),
                "maxPriorityFeePerGas": int(priority_fee),
                "maxFeePerGas": int(max_fee),
                "gasPrice": None,
            },
        )
    gas_price = max(_gas_price(w3) * 2, int(w3.to_wei("3", "gwei")))
    return (
        {"gasPrice": int(gas_price)},
        {
            "type": "legacy",
            "baseFeePerGas": None,
            "maxPriorityFeePerGas": None,
            "maxFeePerGas": None,
            "gasPrice": int(gas_price),
        },
    )


def _estimate_gas_with_buffer(w3, tx: dict[str, Any]) -> int:
    estimate = int(w3.eth.estimate_gas(dict(tx)))
    return max(estimate, int(estimate * 12 / 10), 21000)


def _erc20_transfer_data(token, checksum_to: str, value_int: int) -> str:
    transfer = token.functions.transfer(checksum_to, value_int)
    if hasattr(transfer, "_encode_transaction_data"):
        return transfer._encode_transaction_data()
    return transfer.build_transaction({"gas": 1}).get("data")


def _build_erc20_transfer_tx(
    w3,
    *,
    checksum_from: str,
    checksum_to: str,
    checksum_token: str,
    token,
    value_int: int,
) -> tuple[dict[str, Any], dict[str, int | str | None]]:
    nonce = w3.eth.get_transaction_count(checksum_from, "pending")
    fee_fields, fee_debug = _evm_fee_fields(w3)
    tx: dict[str, Any] = {
        "from": checksum_from,
        "to": checksum_token,
        "value": 0,
        "nonce": int(nonce),
        "chainId": int(w3.eth.chain_id),
        "data": _erc20_transfer_data(token, checksum_to, value_int),
        **fee_fields,
    }
    tx["gas"] = _estimate_gas_with_buffer(w3, tx)
    return tx, fee_debug


def _sign_and_broadcast(w3, private_key: str, tx: dict) -> str:
    signed = Account.sign_transaction(tx, private_key)
    raw_tx = getattr(signed, "rawTransaction", None) or getattr(signed, "raw_transaction", None)
    tx_hash = w3.eth.send_raw_transaction(raw_tx)
    return tx_hash.hex()



def _dependency_result(
    *,
    error_message: str,
    chain_key: str,
    from_address: str,
    to_address: str,
    amount: Decimal,
    coin_symbol: str,
) -> SendResult:
    return SendResult(
        ok=False,
        dry_run=False,
        tx_hash=None,
        error_message=error_message,
        from_address=from_address,
        to_address=to_address,
        chain_key=chain_key,
        amount=amount,
        coin_symbol=coin_symbol,
        raw_tx_created=False,
        signed=False,
        broadcasted=False,
    )



def send_native_gas_topup(
    *,
    chain_key: str,
    from_private_key: str | Callable[[], str],
    from_address: str,
    to_address: str,
    amount: Decimal,
    db=None,
    force_dry_run: bool = False,
) -> SendResult:
    ck = _normalize_chain_key(chain_key)
    from_addr = _normalize_address(from_address, "from_address")
    to_addr = _normalize_address(to_address, "to_address")
    send_amount = _to_decimal(amount)

    if force_dry_run or not is_collection_real_send_enabled():
        return _dry_result(
            prefix="DRYGAS",
            chain_key=ck,
            from_address=from_addr,
            to_address=to_addr,
            amount=send_amount,
            coin_symbol="NATIVE",
        )

    guard = validate_collection_send_allowed(
        db=db,
        chain_key=ck,
        to_address=to_addr,
        amount=send_amount,
        coin_symbol="NATIVE",
        is_gas=True,
    )
    if not guard.allowed:
        return _guard_rejected_result(
            guard_reason=guard.reason,
            chain_key=ck,
            from_address=from_addr,
            to_address=to_addr,
            amount=send_amount,
            coin_symbol="NATIVE",
        )


    if ck == "solana":
        private_key = _resolve_private_key(from_private_key)
        if not is_solana_address(from_addr):
            raise ValueError("invalid solana from_address")
        if not is_solana_address(to_addr):
            raise ValueError("invalid solana to_address")
        try:
            tx_hash = _send_with_rpc_fallback(
                lambda rpc_url: send_sol_transfer(
                    chain_key=ck,
                    from_private_key=private_key,
                    from_address=from_addr,
                    to_address=to_addr,
                    amount=send_amount,
                    rpc_url=rpc_url,
                ),
                _chain_rpc_urls_from_db(db, ck),
            )
        except RuntimeError as exc:
            return _dependency_result(
                error_message=str(exc),
                chain_key=ck,
                from_address=from_addr,
                to_address=to_addr,
                amount=send_amount,
                coin_symbol="NATIVE",
            )
        return SendResult(
            ok=True,
            dry_run=False,
            tx_hash=tx_hash,
            error_message=None,
            from_address=from_addr,
            to_address=to_addr,
            chain_key=ck,
            amount=send_amount,
            coin_symbol="NATIVE",
            raw_tx_created=True,
            signed=True,
            broadcasted=True,
        )

    private_key = _resolve_private_key(from_private_key)
    matched_address = assert_private_key_matches_address(private_key, from_addr)
    w3 = get_web3_for_chain(ck, db=db)
    checksum_from = w3.to_checksum_address(matched_address)
    checksum_to = w3.to_checksum_address(to_addr)
    nonce = w3.eth.get_transaction_count(checksum_from, "pending")
    fee_fields, _fee_debug = _evm_fee_fields(w3)
    tx = {
        "from": checksum_from,
        "to": checksum_to,
        "value": int(w3.to_wei(send_amount, "ether")),
        "nonce": int(nonce),
        "gas": 21000,
        "chainId": int(w3.eth.chain_id),
        **fee_fields,
    }
    try:
        tx_hash = _sign_and_broadcast(w3, private_key, tx)
    except Exception as exc:
        return _dependency_result(
            error_message=f"EVM_NATIVE_SEND_FAILED:{str(exc)[:500]}",
            chain_key=ck,
            from_address=from_addr,
            to_address=to_addr,
            amount=send_amount,
            coin_symbol="NATIVE",
        )
    return SendResult(
        ok=True,
        dry_run=False,
        tx_hash=tx_hash,
        error_message=None,
        from_address=from_addr,
        to_address=to_addr,
        chain_key=ck,
        amount=send_amount,
        coin_symbol="NATIVE",
        raw_tx_created=True,
        signed=True,
        broadcasted=True,
    )


def _decimal_to_token_int(amount: Decimal, decimals: int) -> int:
    raw = int((amount * (Decimal(10) ** int(decimals))).to_integral_value())
    if raw <= 0:
        raise ValueError("token amount is too small")
    return raw


def preview_erc20_collect_transfer_tx(
    *,
    chain_key: str,
    token_contract_address: str,
    token_decimals: int,
    from_address: str,
    to_address: str,
    amount: Decimal,
    db=None,
) -> dict[str, object]:
    ck = _normalize_chain_key(chain_key)
    token_contract = _normalize_address(token_contract_address, "token_contract_address")
    from_addr = _normalize_address(from_address, "from_address")
    to_addr = _normalize_address(to_address, "to_address")
    send_amount = _to_decimal(amount)

    w3 = get_web3_for_chain(ck, db=db)
    checksum_from = w3.to_checksum_address(from_addr)
    checksum_to = w3.to_checksum_address(to_addr)
    checksum_token = w3.to_checksum_address(token_contract)
    token = w3.eth.contract(address=checksum_token, abi=ERC20_TRANSFER_ABI)
    value_int = _decimal_to_token_int(send_amount, token_decimals)
    tx, fee_debug = _build_erc20_transfer_tx(
        w3,
        checksum_from=checksum_from,
        checksum_to=checksum_to,
        checksum_token=checksum_token,
        token=token,
        value_int=value_int,
    )
    return {
        "chain_key": ck,
        "from_address": checksum_from,
        "to_address": checksum_to,
        "token_contract_address": checksum_token,
        "amount": str(send_amount),
        "token_value_int": value_int,
        "chain_id": tx.get("chainId"),
        "nonce": tx.get("nonce"),
        "gas": tx.get("gas"),
        "fee_type": fee_debug.get("type"),
        "baseFeePerGas": fee_debug.get("baseFeePerGas"),
        "maxPriorityFeePerGas": fee_debug.get("maxPriorityFeePerGas"),
        "maxFeePerGas": fee_debug.get("maxFeePerGas"),
        "gasPrice": fee_debug.get("gasPrice"),
        "raw_tx_created": True,
        "signed": False,
        "broadcasted": False,
    }


def send_erc20_collect_transfer(
    *,
    chain_key: str,
    token_contract_address: str,
    token_decimals: int,
    from_private_key: str | Callable[[], str],
    from_address: str,
    to_address: str,
    amount: Decimal,
    coin_symbol: str,
    db=None,
    force_dry_run: bool = False,
) -> SendResult:
    ck = _normalize_chain_key(chain_key)
    token_contract = _normalize_address(token_contract_address, "token_contract_address")
    from_addr = _normalize_address(from_address, "from_address")
    to_addr = _normalize_address(to_address, "to_address")
    symbol = (coin_symbol or "").strip().upper() or "TOKEN"
    send_amount = _to_decimal(amount)

    if force_dry_run or not is_collection_real_send_enabled():
        return _dry_result(
            prefix="DRYRUN",
            chain_key=ck,
            from_address=from_addr,
            to_address=to_addr,
            amount=send_amount,
            coin_symbol=symbol,
        )

    guard = validate_collection_send_allowed(
        db=db,
        chain_key=ck,
        to_address=to_addr,
        amount=send_amount,
        coin_symbol=symbol,
        is_gas=False,
    )
    if not guard.allowed:
        return _guard_rejected_result(
            guard_reason=guard.reason,
            chain_key=ck,
            from_address=from_addr,
            to_address=to_addr,
            amount=send_amount,
            coin_symbol=symbol,
        )


    if ck == "solana":
        private_key = _resolve_private_key(from_private_key)
        if not is_solana_address(from_addr):
            raise ValueError("invalid solana from_address")
        if not is_solana_address(to_addr):
            raise ValueError("invalid solana to_address")
        if not is_solana_address(token_contract):
            raise ValueError("invalid solana token_mint_address")
        try:
            tx_hash = _send_with_rpc_fallback(
                lambda rpc_url: send_spl_token_transfer(
                    chain_key=ck,
                    from_private_key=private_key,
                    from_address=from_addr,
                    to_address=to_addr,
                    token_mint_address=token_contract,
                    amount=send_amount,
                    token_decimals=token_decimals,
                    rpc_url=rpc_url,
                ),
                _chain_rpc_urls_from_db(db, ck),
            )
        except RuntimeError as exc:
            return _dependency_result(
                error_message=str(exc),
                chain_key=ck,
                from_address=from_addr,
                to_address=to_addr,
                amount=send_amount,
                coin_symbol=symbol,
            )
        return SendResult(
            ok=True,
            dry_run=False,
            tx_hash=tx_hash,
            error_message=None,
            from_address=from_addr,
            to_address=to_addr,
            chain_key=ck,
            amount=send_amount,
            coin_symbol=symbol,
            raw_tx_created=True,
            signed=True,
            broadcasted=True,
        )

    private_key = _resolve_private_key(from_private_key)
    matched_address = assert_private_key_matches_address(private_key, from_addr)
    w3 = get_web3_for_chain(ck, db=db)
    checksum_from = w3.to_checksum_address(matched_address)
    checksum_to = w3.to_checksum_address(to_addr)
    checksum_token = w3.to_checksum_address(token_contract)
    token = w3.eth.contract(address=checksum_token, abi=ERC20_TRANSFER_ABI)
    value_int = _decimal_to_token_int(send_amount, token_decimals)
    try:
        tx, _fee_debug = _build_erc20_transfer_tx(
            w3,
            checksum_from=checksum_from,
            checksum_to=checksum_to,
            checksum_token=checksum_token,
            token=token,
            value_int=value_int,
        )
        tx_hash = _sign_and_broadcast(w3, private_key, tx)
    except Exception as exc:
        return _dependency_result(
            error_message=f"EVM_ERC20_SEND_FAILED:{str(exc)[:500]}",
            chain_key=ck,
            from_address=from_addr,
            to_address=to_addr,
            amount=send_amount,
            coin_symbol=symbol,
        )
    return SendResult(
        ok=True,
        dry_run=False,
        tx_hash=tx_hash,
        error_message=None,
        from_address=from_addr,
        to_address=to_addr,
        chain_key=ck,
        amount=send_amount,
        coin_symbol=symbol,
        raw_tx_created=True,
        signed=True,
        broadcasted=True,
    )
