from __future__ import annotations

import os
import logging
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeoutError
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
import time
from typing import Callable, Optional, TypeVar

try:
    from web3 import Web3
except Exception:  # pragma: no cover - import depends on runtime package set
    Web3 = None  # type: ignore

from app.core.chain_config import get_runtime_chain_config
from app.services.collection_chain_helper import CollectionEvaluationResult, evaluate_collection_candidate
from app.services.rpc_no_proxy import build_web3_no_proxy


ERC20_BALANCE_ABI = [
    {
        "name": "balanceOf",
        "type": "function",
        "stateMutability": "view",
        "inputs": [{"name": "owner", "type": "address"}],
        "outputs": [{"name": "", "type": "uint256"}],
    },
    {
        "name": "decimals",
        "type": "function",
        "stateMutability": "view",
        "inputs": [],
        "outputs": [{"name": "", "type": "uint8"}],
    },
]

RPC_REQUEST_TIMEOUT_SECONDS = 5.0
RPC_CALL_TIMEOUT_SECONDS = 5.0
_T = TypeVar("_T")
logger = logging.getLogger(__name__)
_LAST_SUCCESS_RPC_BY_CHAIN: dict[str, str] = {}


class CollectionBalanceCheckerError(RuntimeError):
    def __init__(self, code: str, message: str):
        self.code = code
        super().__init__(message)


@dataclass(frozen=True)
class OnchainBalanceResult:
    chain_key: str
    address: str
    token_balance: Decimal
    native_balance: Decimal
    token_decimals: int
    checked_at: datetime
    ok: bool
    error_message: Optional[str] = None


def _normalize_chain_key(chain_key: str) -> str:
    ck = (chain_key or "").strip().lower()
    if not ck:
        raise ValueError("chain_key is required")
    return ck


def _require_address(address: str, field_name: str) -> str:
    value = (address or "").strip()
    if not value:
        raise ValueError(f"{field_name} is required")
    return value


def _rpc_env_candidates(chain_key: str) -> list[str]:
    ck = _normalize_chain_key(chain_key).upper()
    return [
        f"{ck}_RPC_URL",
        f"RPC_{ck}",
        f"COLLECTION_{ck}_RPC_URL",
    ]


def get_rpc_urls_for_chain(chain_key: str, db=None) -> list[str]:
    ck = _normalize_chain_key(chain_key)

    try:
        cfg = get_runtime_chain_config(db, ck)
    except Exception:
        cfg = None
    if cfg:
        urls = [url.strip() for url in cfg.rpc_urls if url and url.strip()]
        if urls:
            return urls

    for name in _rpc_env_candidates(ck):
        value = os.getenv(name, "").strip()
        if value:
            return [value]

    raise CollectionBalanceCheckerError("RPC_NOT_CONFIGURED", f"RPC_NOT_CONFIGURED: {ck}")


def get_rpc_url_for_chain(chain_key: str, db=None) -> str:
    return get_rpc_urls_for_chain(chain_key, db=db)[0]


def _ordered_rpc_urls(chain_key: str, urls: list[str]) -> list[str]:
    ck = _normalize_chain_key(chain_key)
    last_success = _LAST_SUCCESS_RPC_BY_CHAIN.get(ck)
    if last_success and last_success in urls:
        return [last_success, *[url for url in urls if url != last_success]]
    return urls


def _mask_rpc_url(rpc_url: str) -> str:
    text_value = str(rpc_url or "").strip()
    if len(text_value) <= 48:
        return text_value
    return f"{text_value[:28]}...{text_value[-14:]}"


def _short_address(address: str) -> str:
    text_value = str(address or "").strip()
    if len(text_value) <= 14:
        return text_value
    return f"{text_value[:8]}...{text_value[-6:]}"


def _remaining_timeout(default_timeout: float, deadline_monotonic: Optional[float] = None) -> float:
    timeout = max(0.1, float(default_timeout or RPC_CALL_TIMEOUT_SECONDS))
    if deadline_monotonic is None:
        return timeout
    remaining = float(deadline_monotonic) - time.monotonic()
    if remaining <= 0:
        raise CollectionBalanceCheckerError("RPC_CALL_TIMEOUT", "RPC_CALL_TIMEOUT: address deadline reached")
    return max(0.1, min(timeout, remaining))


def _rpc_call_with_timeout(
    label: str,
    fn: Callable[[], _T],
    *,
    deadline_monotonic: Optional[float] = None,
    timeout_seconds: float = RPC_CALL_TIMEOUT_SECONDS,
) -> _T:
    timeout = _remaining_timeout(timeout_seconds, deadline_monotonic)
    executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="collection-rpc")
    future = executor.submit(fn)
    try:
        return future.result(timeout=timeout)
    except FutureTimeoutError as exc:
        future.cancel()
        raise CollectionBalanceCheckerError(
            "RPC_CALL_TIMEOUT",
            f"RPC_CALL_TIMEOUT: {label} timeout after {timeout:g}s",
        ) from exc
    finally:
        executor.shutdown(wait=False, cancel_futures=True)


def get_web3_for_chain(
    chain_key: str,
    db=None,
    *,
    deadline_monotonic: Optional[float] = None,
    rpc_urls: Optional[list[str]] = None,
):
    if Web3 is None:
        raise CollectionBalanceCheckerError("WEB3_NOT_INSTALLED", "web3 is not installed")

    ck = _normalize_chain_key(chain_key)
    last_error = ""
    urls = _ordered_rpc_urls(ck, list(rpc_urls or get_rpc_urls_for_chain(ck, db=db)))
    for rpc_index, rpc_url in enumerate(urls, start=1):
        try:
            request_timeout = _remaining_timeout(RPC_REQUEST_TIMEOUT_SECONDS, deadline_monotonic)
            w3 = build_web3_no_proxy(rpc_url, timeout=request_timeout)
            if _rpc_call_with_timeout(
                f"{ck} is_connected",
                w3.is_connected,
                deadline_monotonic=deadline_monotonic,
                timeout_seconds=request_timeout,
            ):
                _LAST_SUCCESS_RPC_BY_CHAIN[ck] = rpc_url
                try:
                    setattr(w3, "_collection_rpc_url", rpc_url)
                    setattr(w3, "_collection_rpc_index", rpc_index)
                    setattr(w3, "_collection_rpc_attempts", rpc_index)
                except Exception:
                    pass
                return w3
            last_error = f"RPC_NOT_CONNECTED: {rpc_url}"
        except Exception as exc:
            last_error = str(exc)
            logger.warning(
                "collection scan rpc fallback chain=%s rpc_index=%s rpc=%s error=%s",
                ck,
                rpc_index,
                _mask_rpc_url(rpc_url),
                str(exc)[:120],
            )
            continue
    raise CollectionBalanceCheckerError("RPC_NOT_CONNECTED", f"RPC_NOT_CONNECTED: {ck} {last_error}")


def get_native_balance(
    *,
    chain_key: str,
    address: str,
    db=None,
) -> Decimal:
    w3 = get_web3_for_chain(chain_key, db=db)
    checksum_address = w3.to_checksum_address(_require_address(address, "address"))
    wei_balance = int(_rpc_call_with_timeout(f"{chain_key} get_balance {checksum_address}", lambda: w3.eth.get_balance(checksum_address)))
    return Decimal(wei_balance) / Decimal(10**18)


def get_erc20_balance(
    *,
    chain_key: str,
    token_contract_address: str,
    address: str,
    decimals: Optional[int] = None,
    db=None,
) -> Decimal:
    w3 = get_web3_for_chain(chain_key, db=db)
    token_address = w3.to_checksum_address(_require_address(token_contract_address, "token_contract_address"))
    owner_address = w3.to_checksum_address(_require_address(address, "address"))
    token = w3.eth.contract(address=token_address, abi=ERC20_BALANCE_ABI)
    token_decimals = (
        int(decimals)
        if decimals is not None
        else int(_rpc_call_with_timeout(f"{chain_key} decimals {token_address}", lambda: token.functions.decimals().call()))
    )
    raw_balance = int(
        _rpc_call_with_timeout(
            f"{chain_key} balanceOf {token_address} {owner_address}",
            lambda: token.functions.balanceOf(owner_address).call(),
        )
    )
    return Decimal(raw_balance) / (Decimal(10) ** token_decimals)


def get_erc20_decimals(
    *,
    chain_key: str,
    token_contract_address: str,
    db=None,
) -> int:
    w3 = get_web3_for_chain(chain_key, db=db)
    token_address = w3.to_checksum_address(_require_address(token_contract_address, "token_contract_address"))
    token = w3.eth.contract(address=token_address, abi=ERC20_BALANCE_ABI)
    return int(_rpc_call_with_timeout(f"{chain_key} decimals {token_address}", lambda: token.functions.decimals().call()))


def get_collection_onchain_balances(
    *,
    chain_key: str,
    address: str,
    token_contract_address: str,
    token_decimals: Optional[int] = None,
    db=None,
    deadline_monotonic: Optional[float] = None,
    rpc_urls: Optional[list[str]] = None,
) -> OnchainBalanceResult:
    ck = _normalize_chain_key(chain_key)
    normalized_address = _require_address(address, "address").lower()
    checked_at = datetime.utcnow()
    address_started = time.monotonic()
    rpc_index = 0
    rpc_attempts = 0
    native_elapsed = 0.0
    token_elapsed = 0.0
    try:
        w3 = get_web3_for_chain(ck, db=db, deadline_monotonic=deadline_monotonic, rpc_urls=rpc_urls)
        rpc_index = int(getattr(w3, "_collection_rpc_index", 0) or 0)
        rpc_attempts = int(getattr(w3, "_collection_rpc_attempts", 0) or 0)
        token_address = w3.to_checksum_address(_require_address(token_contract_address, "token_contract_address"))
        owner_address = w3.to_checksum_address(_require_address(normalized_address, "address"))
        token = w3.eth.contract(address=token_address, abi=ERC20_BALANCE_ABI)
        resolved_token_decimals = (
            int(token_decimals)
            if token_decimals is not None
            else int(_rpc_call_with_timeout(f"{ck} decimals {token_address}", lambda: token.functions.decimals().call(), deadline_monotonic=deadline_monotonic))
        )
        native_started = time.monotonic()
        wei_balance = int(_rpc_call_with_timeout(f"{ck} get_balance {owner_address}", lambda: w3.eth.get_balance(owner_address), deadline_monotonic=deadline_monotonic))
        native_elapsed = time.monotonic() - native_started
        token_started = time.monotonic()
        raw_token_balance = int(
            _rpc_call_with_timeout(
                f"{ck} balanceOf {token_address} {owner_address}",
                lambda: token.functions.balanceOf(owner_address).call(),
                deadline_monotonic=deadline_monotonic,
            )
        )
        token_elapsed = time.monotonic() - token_started
        native_balance = Decimal(wei_balance) / Decimal(10**18)
        token_balance = Decimal(raw_token_balance) / (Decimal(10) ** resolved_token_decimals)
        logger.debug(
            "collection scan balance ok chain=%s address=%s rpc_index=%s fallback_attempts=%s native_ms=%s token_ms=%s total_ms=%s",
            ck,
            _short_address(normalized_address),
            rpc_index,
            rpc_attempts,
            int(native_elapsed * 1000),
            int(token_elapsed * 1000),
            int((time.monotonic() - address_started) * 1000),
        )
        return OnchainBalanceResult(
            chain_key=ck,
            address=normalized_address,
            token_balance=token_balance,
            native_balance=native_balance,
            token_decimals=resolved_token_decimals,
            checked_at=checked_at,
            ok=True,
            error_message=None,
        )
    except Exception as exc:
        logger.warning(
            "collection scan balance failed chain=%s address=%s rpc_index=%s fallback_attempts=%s native_ms=%s token_ms=%s total_ms=%s error=%s",
            ck,
            _short_address(normalized_address),
            rpc_index,
            rpc_attempts,
            int(native_elapsed * 1000),
            int(token_elapsed * 1000),
            int((time.monotonic() - address_started) * 1000),
            str(exc)[:160],
        )
        return OnchainBalanceResult(
            chain_key=ck,
            address=normalized_address,
            token_balance=Decimal("0"),
            native_balance=Decimal("0"),
            token_decimals=int(token_decimals or 0),
            checked_at=checked_at,
            ok=False,
            error_message=str(exc),
        )


def confirm_collection_candidate_onchain(
    *,
    chain_key: str,
    coin_symbol: str,
    from_address: str,
    to_address: str,
    token_contract_address: str,
    token_decimals: int,
    estimated_gas_native: Optional[Decimal] = None,
    estimated_gas_usdt: Optional[Decimal] = None,
    min_collect_amount: Optional[Decimal] = None,
    db=None,
) -> CollectionEvaluationResult:
    balances = get_collection_onchain_balances(
        chain_key=chain_key,
        address=from_address,
        token_contract_address=token_contract_address,
        token_decimals=token_decimals,
        db=db,
    )
    if not balances.ok:
        raise CollectionBalanceCheckerError("ONCHAIN_BALANCE_CHECK_FAILED", balances.error_message or "balance check failed")

    return evaluate_collection_candidate(
        chain_key=chain_key,
        coin_symbol=coin_symbol,
        from_address=from_address,
        to_address=to_address,
        token_balance=balances.token_balance,
        native_balance=balances.native_balance,
        token_contract_address=token_contract_address,
        estimated_gas_native=estimated_gas_native,
        estimated_gas_usdt=estimated_gas_usdt,
        min_collect_amount=min_collect_amount,
        db=db,
    )
