from __future__ import annotations

from collections.abc import Callable
from contextlib import contextmanager
from dataclasses import dataclass
from decimal import Decimal
import hashlib
import logging
import threading
from typing import Any
from uuid import uuid4

from eth_account import Account
from sqlalchemy import text
from web3 import Web3

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
EVM_NONCE_LOCK_WAIT_SECONDS = 15
EVM_RPC_BROADCAST_TIMEOUT_SECONDS = 8
logger = logging.getLogger(__name__)
_evm_nonce_locks_guard = threading.Lock()
_evm_nonce_locks: dict[str, tuple[threading.Lock, int]] = {}


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


def _is_insufficient_native_funds_error(exc: Exception) -> bool:
    message = str(exc).lower()
    return "insufficient funds" in message


def _estimate_gas_with_buffer(
    w3,
    tx: dict[str, Any],
    *,
    allow_unfunded_sender: bool = False,
) -> int:
    try:
        estimate = int(w3.eth.estimate_gas(dict(tx)))
    except Exception as exc:
        if not allow_unfunded_sender or not _is_insufficient_native_funds_error(exc):
            raise

        # Gas-unit estimation does not require charging the sender. Retry without
        # fee fields first, then use a read-only state override for stricter nodes.
        fee_neutral_tx = {
            key: value
            for key, value in tx.items()
            if key not in {"gasPrice", "maxFeePerGas", "maxPriorityFeePerGas"}
        }
        try:
            estimate = int(w3.eth.estimate_gas(fee_neutral_tx))
        except Exception:
            from_address = tx.get("from")
            if not from_address:
                raise exc
            try:
                estimate = int(
                    w3.eth.estimate_gas(
                        dict(tx),
                        state_override={from_address: {"balance": hex(10**30)}},
                    )
                )
            except Exception:
                raise exc
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
    allow_unfunded_sender: bool = False,
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
    tx["gas"] = _estimate_gas_with_buffer(
        w3,
        tx,
        allow_unfunded_sender=allow_unfunded_sender,
    )
    return tx, fee_debug


def _normalize_evm_tx_hash(value: object) -> str:
    if hasattr(value, "hex"):
        text_value = str(value.hex())
    else:
        text_value = str(value or "")
    normalized = text_value.strip().lower()
    if normalized and not normalized.startswith("0x"):
        normalized = f"0x{normalized}"
    return normalized


def _is_known_transaction_broadcast_error(exc: Exception) -> bool:
    message = str(exc or "").lower()
    return any(
        marker in message
        for marker in (
            "already known",
            "known transaction",
            "already imported",
            "transaction already exists",
        )
    )


def _web3_for_broadcast_rpc(rpc_url: str):
    return Web3(
        Web3.HTTPProvider(
            rpc_url,
            request_kwargs={"timeout": EVM_RPC_BROADCAST_TIMEOUT_SECONDS},
        )
    )


def _broadcast_raw_transaction_to_rpc_pool(w3, raw_tx: bytes, rpc_urls: list[str]) -> str:
    expected_hash = _normalize_evm_tx_hash(Web3.keccak(raw_tx))
    primary_url = str(getattr(getattr(w3, "provider", None), "endpoint_uri", "") or "").strip()
    clients: list[tuple[str, object]] = [("primary", w3)]
    seen_urls = {primary_url} if primary_url else set()
    for index, rpc_url in enumerate(rpc_urls, start=1):
        url = str(rpc_url or "").strip()
        if not url or url in seen_urls:
            continue
        seen_urls.add(url)
        clients.append((f"rpc_{index}", _web3_for_broadcast_rpc(url)))

    acknowledged = 0
    errors: list[str] = []
    for label, client in clients:
        try:
            returned_hash = _normalize_evm_tx_hash(client.eth.send_raw_transaction(raw_tx))
            if returned_hash and returned_hash != expected_hash:
                raise ValueError(f"TX_HASH_MISMATCH:{returned_hash[:18]}")
            acknowledged += 1
        except Exception as exc:
            if _is_known_transaction_broadcast_error(exc):
                acknowledged += 1
                continue
            errors.append(f"{label}:{type(exc).__name__}:{str(exc)[:160]}")

    if acknowledged <= 0:
        raise RuntimeError("EVM_RPC_BROADCAST_FAILED:" + " | ".join(errors)[:700])
    if errors:
        logger.warning(
            "EVM raw transaction broadcast partially acknowledged tx_hash=%s acknowledged=%s total=%s errors=%s",
            expected_hash,
            acknowledged,
            len(clients),
            errors,
        )
    return expected_hash


def _sign_and_broadcast(w3, private_key: str, tx: dict, *, rpc_urls: list[str] | None = None) -> str:
    signed = Account.sign_transaction(tx, private_key)
    raw_tx = getattr(signed, "rawTransaction", None) or getattr(signed, "raw_transaction", None)
    if raw_tx is None:
        raise ValueError("SIGNED_RAW_TRANSACTION_MISSING")
    return _broadcast_raw_transaction_to_rpc_pool(w3, raw_tx, rpc_urls or [])


def _evm_nonce_lock_identity(chain_key: str, from_address: str) -> str:
    digest = hashlib.sha256(f"{chain_key}:{from_address.lower()}".encode("utf-8")).hexdigest()
    return f"collection_nonce:{digest[:40]}"


@contextmanager
def _process_nonce_send_lock(lock_name: str):
    with _evm_nonce_locks_guard:
        current = _evm_nonce_locks.get(lock_name)
        lock, waiter_count = current if current is not None else (threading.Lock(), 0)
        _evm_nonce_locks[lock_name] = (lock, waiter_count + 1)
    try:
        with lock:
            yield
    finally:
        with _evm_nonce_locks_guard:
            current_lock, current_count = _evm_nonce_locks.get(lock_name, (lock, 1))
            if current_lock is lock and current_count <= 1:
                _evm_nonce_locks.pop(lock_name, None)
            elif current_lock is lock:
                _evm_nonce_locks[lock_name] = (lock, current_count - 1)


def _database_dialect_name(db) -> str:
    if db is None:
        return ""
    try:
        return str(db.get_bind().dialect.name or "").strip().lower()
    except Exception:
        return ""


@contextmanager
def _evm_nonce_send_lock(*, db, chain_key: str, from_address: str):
    """Serialize nonce allocation only for the same EVM chain and sender."""

    lock_name = _evm_nonce_lock_identity(chain_key, from_address)
    lock_connection = None
    database_lock_acquired = False
    with _process_nonce_send_lock(lock_name):
        try:
            if _database_dialect_name(db) == "mysql":
                bind = db.get_bind()
                engine = getattr(bind, "engine", bind)
                lock_connection = engine.connect()
                acquired = lock_connection.execute(
                    text("SELECT GET_LOCK(:lock_name, :wait_seconds)"),
                    {"lock_name": lock_name, "wait_seconds": EVM_NONCE_LOCK_WAIT_SECONDS},
                ).scalar()
                if int(acquired or 0) != 1:
                    raise TimeoutError(
                        f"nonce lock timeout chain={chain_key} sender={from_address[:10]}..."
                    )
                database_lock_acquired = True
            yield
        finally:
            if lock_connection is not None:
                try:
                    if database_lock_acquired:
                        released = lock_connection.execute(
                            text("SELECT RELEASE_LOCK(:lock_name)"),
                            {"lock_name": lock_name},
                        ).scalar()
                        if int(released or 0) != 1:
                            raise RuntimeError(f"nonce lock release failed result={released!r}")
                except Exception:
                    logger.exception(
                        "failed to release evm nonce lock chain=%s sender=%s",
                        chain_key,
                        from_address,
                    )
                    try:
                        lock_connection.invalidate()
                    except Exception:
                        logger.exception("failed to invalidate evm nonce lock connection")
                finally:
                    lock_connection.close()



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
    try:
        with _evm_nonce_send_lock(db=db, chain_key=ck, from_address=checksum_from):
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
            tx_hash = _sign_and_broadcast(
                w3,
                private_key,
                tx,
                rpc_urls=_chain_rpc_urls_from_db(db, ck),
            )
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
        allow_unfunded_sender=True,
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
        with _evm_nonce_send_lock(db=db, chain_key=ck, from_address=checksum_from):
            tx, _fee_debug = _build_erc20_transfer_tx(
                w3,
                checksum_from=checksum_from,
                checksum_to=checksum_to,
                checksum_token=checksum_token,
                token=token,
                value_int=value_int,
            )
            tx_hash = _sign_and_broadcast(
                w3,
                private_key,
                tx,
                rpc_urls=_chain_rpc_urls_from_db(db, ck),
            )
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
