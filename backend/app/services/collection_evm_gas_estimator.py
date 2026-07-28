from __future__ import annotations

from dataclasses import dataclass, replace
from decimal import Decimal
import hashlib
import logging
import os
import threading
import time
from typing import Any


logger = logging.getLogger(__name__)

SUPPORTED_EVM_GAS_ESTIMATE_CHAINS = frozenset(
    {"bsc", "polygon", "avaxc", "arbitrum", "eth", "ethereum", "optimism"}
)
DYNAMIC_GAS_ESTIMATE_SOURCES = frozenset(
    {"REALTIME_RPC", "REALTIME_RPC_CACHE", "STATS_P95", "STATS_P95_FALLBACK"}
)
DEFAULT_CACHE_TTL_SECONDS = 15.0
DEFAULT_FAILURE_CACHE_TTL_SECONDS = 5.0
MAX_CACHE_ENTRIES = 2048
WEI_PER_NATIVE = Decimal("1000000000000000000")


class RealtimeGasEstimateUnavailable(RuntimeError):
    pass


@dataclass(frozen=True)
class EvmGasEstimateResult:
    chain_key: str
    estimated_native_fee: Decimal
    gas_limit: int
    fee_per_gas_wei: int
    source: str
    cached: bool


_cache_lock = threading.Lock()
_success_cache: dict[str, tuple[float, EvmGasEstimateResult]] = {}
_failure_cache: dict[str, tuple[float, str]] = {}


def _normalize_chain_key(chain_key: str) -> str:
    value = (chain_key or "").strip().lower()
    if not value:
        raise ValueError("chain_key is required")
    if value not in SUPPORTED_EVM_GAS_ESTIMATE_CHAINS:
        raise ValueError(f"unsupported EVM chain_key: {value}")
    return value


def _to_decimal(value: Any) -> Decimal:
    return Decimal(str(value))


def _ttl_seconds(env_name: str, default: float) -> float:
    raw = os.getenv(env_name, "").strip()
    if not raw:
        return default
    try:
        return max(1.0, min(float(raw), 60.0))
    except (TypeError, ValueError):
        return default


def _cache_key(
    *,
    chain_key: str,
    token_contract_address: str,
    token_decimals: int,
    from_address: str,
    to_address: str,
    amount: Decimal,
) -> str:
    # Store only a digest so wallet and token addresses never appear in cache keys or diagnostics.
    payload = "|".join(
        (
            chain_key,
            (token_contract_address or "").strip().lower(),
            str(int(token_decimals)),
            (from_address or "").strip().lower(),
            (to_address or "").strip().lower(),
            format(amount, "f"),
        )
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _prune_cache_locked(now: float) -> None:
    for cache in (_success_cache, _failure_cache):
        expired = [key for key, value in cache.items() if value[0] <= now]
        for key in expired:
            cache.pop(key, None)
        while len(cache) >= MAX_CACHE_ENTRIES:
            oldest_key = min(cache, key=lambda key: cache[key][0])
            cache.pop(oldest_key, None)


def clear_evm_gas_estimate_cache() -> None:
    with _cache_lock:
        _success_cache.clear()
        _failure_cache.clear()


def bounded_dynamic_gas_buffer(
    *,
    configured_buffer: Decimal,
    estimated_required_native: Decimal,
    estimate_source: str,
) -> Decimal:
    configured = max(_to_decimal(configured_buffer), Decimal("0"))
    estimated = max(_to_decimal(estimated_required_native), Decimal("0"))
    source = (estimate_source or "").strip().upper()
    if source in DYNAMIC_GAS_ESTIMATE_SOURCES:
        return min(configured, estimated)
    return configured


def estimate_erc20_transfer_gas_native(
    *,
    chain_key: str,
    token_contract_address: str,
    token_decimals: int,
    from_address: str,
    to_address: str,
    amount: Decimal,
    db=None,
) -> EvmGasEstimateResult:
    ck = _normalize_chain_key(chain_key)
    decimals = int(token_decimals)
    if decimals < 0 or decimals > 255:
        raise ValueError("token_decimals is out of range")
    send_amount = _to_decimal(amount)
    if send_amount <= 0:
        raise ValueError("amount must be > 0")

    cache_key = _cache_key(
        chain_key=ck,
        token_contract_address=token_contract_address,
        token_decimals=decimals,
        from_address=from_address,
        to_address=to_address,
        amount=send_amount,
    )
    now = time.monotonic()
    with _cache_lock:
        success_entry = _success_cache.get(cache_key)
        if success_entry and success_entry[0] > now:
            return replace(success_entry[1], source="REALTIME_RPC_CACHE", cached=True)
        failure_entry = _failure_cache.get(cache_key)
        if failure_entry and failure_entry[0] > now:
            raise RealtimeGasEstimateUnavailable(failure_entry[1])

    try:
        # Function-level import avoids the balance-checker/send-helper import cycle.
        from app.services.collection_send_helper import preview_erc20_collect_transfer_tx

        preview = preview_erc20_collect_transfer_tx(
            chain_key="ethereum" if ck == "eth" else ck,
            token_contract_address=token_contract_address,
            token_decimals=decimals,
            from_address=from_address,
            to_address=to_address,
            amount=send_amount,
            db=db,
        )
        gas_limit = int(preview.get("gas") or 0)
        fee_per_gas_wei = int(preview.get("maxFeePerGas") or preview.get("gasPrice") or 0)
        if gas_limit <= 0 or fee_per_gas_wei <= 0:
            raise RealtimeGasEstimateUnavailable("RPC_ESTIMATE_NOT_POSITIVE")
        estimated_native_fee = (Decimal(gas_limit) * Decimal(fee_per_gas_wei)) / WEI_PER_NATIVE
        if estimated_native_fee <= 0:
            raise RealtimeGasEstimateUnavailable("RPC_FEE_NOT_POSITIVE")
        result = EvmGasEstimateResult(
            chain_key=ck,
            estimated_native_fee=estimated_native_fee,
            gas_limit=gas_limit,
            fee_per_gas_wei=fee_per_gas_wei,
            source="REALTIME_RPC",
            cached=False,
        )
    except Exception as exc:
        error_type = type(exc).__name__
        with _cache_lock:
            _prune_cache_locked(now)
            _failure_cache[cache_key] = (
                now + _ttl_seconds("COLLECTION_EVM_GAS_FAILURE_CACHE_TTL_SECONDS", DEFAULT_FAILURE_CACHE_TTL_SECONDS),
                error_type,
            )
        logger.warning("EVM collection gas estimate failed chain=%s error_type=%s", ck, error_type)
        if isinstance(exc, RealtimeGasEstimateUnavailable):
            raise
        raise RealtimeGasEstimateUnavailable(error_type) from exc

    with _cache_lock:
        _prune_cache_locked(now)
        _success_cache[cache_key] = (
            now + _ttl_seconds("COLLECTION_EVM_GAS_ESTIMATE_CACHE_TTL_SECONDS", DEFAULT_CACHE_TTL_SECONDS),
            result,
        )
        _failure_cache.pop(cache_key, None)
    return result
