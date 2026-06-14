from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from decimal import Decimal
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
        return w3.eth.gas_price
    except Exception:
        return w3.to_wei("3", "gwei")


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
    tx = {
        "from": checksum_from,
        "to": checksum_to,
        "value": int(w3.to_wei(send_amount, "ether")),
        "nonce": int(nonce),
        "gas": 21000,
        "gasPrice": _gas_price(w3),
        "chainId": int(w3.eth.chain_id),
    }
    tx_hash = _sign_and_broadcast(w3, private_key, tx)
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
    nonce = w3.eth.get_transaction_count(checksum_from, "pending")
    tx_base = {
        "from": checksum_from,
        "nonce": int(nonce),
        "gasPrice": _gas_price(w3),
        "chainId": int(w3.eth.chain_id),
    }
    tx = token.functions.transfer(checksum_to, value_int).build_transaction(tx_base)
    if not tx.get("gas"):
        try:
            tx["gas"] = int(w3.eth.estimate_gas(tx))
        except Exception:
            tx["gas"] = 120000
    tx_hash = _sign_and_broadcast(w3, private_key, tx)
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
