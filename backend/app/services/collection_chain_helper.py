from __future__ import annotations

import os
from dataclasses import dataclass
from decimal import Decimal
from typing import Optional


DEFAULT_MIN_COLLECT_USDT = {
    "bsc": Decimal("10"),
    "polygon": Decimal("10"),
    "avaxc": Decimal("10"),
    "arbitrum": Decimal("10"),
    "eth": Decimal("30"),
    "ethereum": Decimal("30"),
    "optimism": Decimal("10"),
    "solana": Decimal("10"),
}

DEFAULT_GAS_NATIVE = {
    "bsc": Decimal("0.0008"),
    "polygon": Decimal("0.08"),
    "avaxc": Decimal("0.05"),
    "arbitrum": Decimal("0.00015"),
    "eth": Decimal("0.003"),
    "ethereum": Decimal("0.005"),
    "optimism": Decimal("0.001"),
    "solana": Decimal("0.02"),
}

GAS_COIN_BY_CHAIN = {
    "bsc": "BNB",
    "polygon": "MATIC",
    "avaxc": "AVAX",
    "eth": "ETH",
    "ethereum": "ETH",
    "optimism": "ETH",
    "arbitrum": "ETH",
    "solana": "SOL",
}

GAS_TOPUP_BUFFER = {
    "bsc": Decimal("0.0005"),
    "polygon": Decimal("0.1"),
    "avaxc": Decimal("0.1"),
    "arbitrum": Decimal("0.0002"),
    "eth": Decimal("0.001"),
    "ethereum": Decimal("0.01"),
    "optimism": Decimal("0.002"),
    "solana": Decimal("0.05"),
}

GAS_TOPUP_CAP = {
    "bsc": Decimal("0.01"),
    "polygon": Decimal("2"),
    "avaxc": Decimal("0.25"),
    "arbitrum": Decimal("0.005"),
    "eth": Decimal("0.02"),
    "ethereum": Decimal("0.025"),
    "optimism": Decimal("0.005"),
    "solana": Decimal("0.1"),
}


@dataclass(frozen=True)
class GasEvaluationResult:
    gas_required: bool
    reason: str
    chain_key: str
    gas_coin_symbol: str
    gas_topup_mode: str
    estimate_source: str
    current_native_balance: Decimal
    estimated_required_native: Decimal
    target_native_balance: Decimal
    topup_amount: Decimal


@dataclass(frozen=True)
class CollectionEvaluationResult:
    should_collect: bool
    reason: str
    chain_key: str
    coin_symbol: str
    from_address: str
    to_address: str
    token_balance: Decimal
    collect_amount: Decimal
    min_collect_amount: Decimal
    estimated_gas_native: Optional[Decimal]
    estimated_gas_usdt: Optional[Decimal]
    current_native_balance: Decimal
    estimated_required_native: Decimal
    gas_target_balance: Decimal
    gas_required: bool
    gas_topup_amount: Decimal
    gas_coin_symbol: Optional[str]
    gas_topup_mode: str
    estimate_source: str


def _normalize_chain_key(chain_key: str) -> str:
    ck = (chain_key or "").strip().lower()
    if not ck:
        raise ValueError("chain_key is required")
    return ck


def _normalize_symbol(symbol: str) -> str:
    value = (symbol or "").strip().upper()
    if not value:
        raise ValueError("coin_symbol is required")
    return value


def _to_decimal(value: Decimal | int | str | float | None, default: Decimal = Decimal("0")) -> Decimal:
    if value is None:
        return default
    return Decimal(str(value))


def _env_decimal(name: str, default: Decimal) -> Decimal:
    raw = os.getenv(name, "").strip()
    if not raw:
        return default
    try:
        return Decimal(raw)
    except Exception as exc:
        raise ValueError(f"invalid decimal env {name}: {raw}") from exc


def _chain_env_name(prefix: str, chain_key: str) -> str:
    return f"{prefix}_{_normalize_chain_key(chain_key).upper()}"


def get_native_gas_coin_symbol(chain_key: str) -> str:
    ck = _normalize_chain_key(chain_key)
    if ck not in GAS_COIN_BY_CHAIN:
        raise ValueError(f"unsupported chain_key: {chain_key}")
    return GAS_COIN_BY_CHAIN[ck]


def compute_min_collect_amount(
    *,
    chain_key: str,
    coin_symbol: str,
    configured_min_amount: Optional[Decimal] = None,
    estimated_gas_usdt: Optional[Decimal] = None,
) -> Decimal:
    ck = _normalize_chain_key(chain_key)
    _normalize_symbol(coin_symbol)
    if configured_min_amount is not None:
        return _to_decimal(configured_min_amount)

    configured_min = _env_decimal(
        _chain_env_name("COLLECTION_MIN_USDT", ck),
        DEFAULT_MIN_COLLECT_USDT.get(ck, Decimal("10")),
    )
    if estimated_gas_usdt is None:
        return configured_min

    multiplier = _env_decimal("COLLECTION_GAS_COST_MULTIPLIER", Decimal("3"))
    gas_based_min = _to_decimal(estimated_gas_usdt) * multiplier
    return max(configured_min, gas_based_min)


def compute_collect_amount(
    *,
    token_balance: Decimal,
    min_collect_amount: Decimal,
    reserve_amount: Decimal = Decimal("0"),
) -> tuple[bool, Decimal, str]:
    balance = _to_decimal(token_balance)
    reserve = _to_decimal(reserve_amount)
    min_amount = _to_decimal(min_collect_amount)

    if balance <= reserve:
        return False, Decimal("0"), "TOKEN_BALANCE_NOT_ABOVE_RESERVE"

    available_to_collect = balance - reserve
    if available_to_collect < min_amount:
        return False, Decimal("0"), "AVAILABLE_AMOUNT_BELOW_MIN_COLLECT"

    return True, available_to_collect, "COLLECTIBLE"


def compute_gas_topup_amount(
    *,
    chain_key: str,
    current_native_balance: Decimal,
    estimated_required_native: Decimal,
    coin_symbol: Optional[str] = None,
    db=None,
) -> GasEvaluationResult:
    ck = _normalize_chain_key(chain_key)
    gas_coin_symbol = get_native_gas_coin_symbol(ck)
    current_balance = _to_decimal(current_native_balance)
    estimated_required = _to_decimal(estimated_required_native)
    gas_topup_mode = "DEFAULT"
    estimate_source = "DEFAULT"
    min_multiplier = _env_decimal("COLLECTION_GAS_TOPUP_MIN_MULTIPLIER", Decimal("2"))
    safe_multiplier = _env_decimal("COLLECTION_GAS_TOPUP_SAFE_MULTIPLIER", Decimal("3"))
    buffer_amount = _env_decimal(
        _chain_env_name("COLLECTION_GAS_TOPUP_BUFFER", ck),
        GAS_TOPUP_BUFFER.get(ck, Decimal("0")),
    )
    cap_amount = _env_decimal(
        _chain_env_name("COLLECTION_GAS_TOPUP_CAP", ck),
        GAS_TOPUP_CAP.get(ck, Decimal("0")),
    )
    min_topup_amount = Decimal("0")
    max_topup_amount = cap_amount
    if db is not None:
        from app.services.collection_gas_config_service import resolve_gas_topup_parameters

        params = resolve_gas_topup_parameters(
            db,
            chain_key=ck,
            token_symbol=coin_symbol,
            estimated_required_native=estimated_required,
        )
        gas_topup_mode = str(params.get("gas_topup_mode") or "DEFAULT").upper()
        estimate_source = str(params.get("estimate_source") or "DEFAULT").upper()
        estimated_required = _to_decimal(params.get("estimated_required_native"))
        safe_multiplier = _to_decimal(params.get("safe_multiplier"))
        buffer_amount = _to_decimal(params.get("buffer"))
        cap_amount = _to_decimal(params.get("cap"))
        min_topup_amount = _to_decimal(params.get("min_topup"))
        max_topup_amount = _to_decimal(params.get("max_topup"))

    if estimated_required <= 0 and gas_topup_mode != "MANUAL":
        return GasEvaluationResult(
            gas_required=False,
            reason="GAS_ESTIMATE_NOT_POSITIVE",
            chain_key=ck,
            gas_coin_symbol=gas_coin_symbol,
            gas_topup_mode=gas_topup_mode,
            estimate_source=estimate_source,
            current_native_balance=current_balance,
            estimated_required_native=estimated_required,
            target_native_balance=current_balance,
            topup_amount=Decimal("0"),
        )

    if gas_topup_mode == "MANUAL":
        min_required = cap_amount
        target_balance = cap_amount
    else:
        min_required = estimated_required * min_multiplier
        target_balance = estimated_required * safe_multiplier + buffer_amount
    if current_balance >= min_required:
        return GasEvaluationResult(
            gas_required=False,
            reason="GAS_BALANCE_SUFFICIENT",
            chain_key=ck,
            gas_coin_symbol=gas_coin_symbol,
            gas_topup_mode=gas_topup_mode,
            estimate_source=estimate_source,
            current_native_balance=current_balance,
            estimated_required_native=estimated_required,
            target_native_balance=target_balance,
            topup_amount=Decimal("0"),
        )

    raw_topup = target_balance - current_balance
    topup_ceiling = min(cap_amount, max_topup_amount)
    topup_amount = min(raw_topup, topup_ceiling)
    if topup_amount > 0 and min_topup_amount > 0:
        topup_amount = min(max(topup_amount, min_topup_amount), topup_ceiling)
    if topup_amount <= 0:
        return GasEvaluationResult(
            gas_required=False,
            reason="GAS_TOPUP_AMOUNT_NOT_POSITIVE",
            chain_key=ck,
            gas_coin_symbol=gas_coin_symbol,
            gas_topup_mode=gas_topup_mode,
            estimate_source=estimate_source,
            current_native_balance=current_balance,
            estimated_required_native=estimated_required,
            target_native_balance=target_balance,
            topup_amount=Decimal("0"),
        )

    return GasEvaluationResult(
        gas_required=True,
        reason="GAS_TOPUP_REQUIRED",
        chain_key=ck,
        gas_coin_symbol=gas_coin_symbol,
        gas_topup_mode=gas_topup_mode,
        estimate_source=estimate_source,
        current_native_balance=current_balance,
        estimated_required_native=estimated_required,
        target_native_balance=target_balance,
        topup_amount=topup_amount,
    )


def estimate_token_transfer_gas_native(
    *,
    chain_key: str,
    token_contract_address: str,
    from_address: str,
    to_address: str,
    amount: Decimal,
) -> Decimal:
    ck = _normalize_chain_key(chain_key)
    if not (token_contract_address or "").strip():
        raise ValueError("token_contract_address is required")
    if not (from_address or "").strip():
        raise ValueError("from_address is required")
    if not (to_address or "").strip():
        raise ValueError("to_address is required")
    if _to_decimal(amount) <= 0:
        raise ValueError("amount must be > 0")
    return _env_decimal(
        _chain_env_name("COLLECTION_DEFAULT_GAS_NATIVE", ck),
        DEFAULT_GAS_NATIVE.get(ck, Decimal("0.001")),
    )


def evaluate_collection_candidate(
    *,
    chain_key: str,
    coin_symbol: str,
    from_address: str,
    to_address: str,
    token_balance: Decimal,
    native_balance: Decimal,
    token_contract_address: Optional[str] = None,
    estimated_gas_native: Optional[Decimal] = None,
    estimated_gas_usdt: Optional[Decimal] = None,
    min_collect_amount: Optional[Decimal] = None,
    reserve_amount: Decimal = Decimal("0"),
    db=None,
) -> CollectionEvaluationResult:
    ck = _normalize_chain_key(chain_key)
    symbol = _normalize_symbol(coin_symbol)
    token_amount = _to_decimal(token_balance)
    native_amount = _to_decimal(native_balance)
    gas_native = _to_decimal(estimated_gas_native) if estimated_gas_native is not None else None
    gas_usdt = _to_decimal(estimated_gas_usdt) if estimated_gas_usdt is not None else None

    if gas_native is None:
        gas_native = estimate_token_transfer_gas_native(
            chain_key=ck,
            token_contract_address=token_contract_address or "0x0000000000000000000000000000000000000000",
            from_address=from_address,
            to_address=to_address,
            amount=max(token_amount, Decimal("0.000000000000000001")),
        )

    min_collect_amount = (
        _to_decimal(min_collect_amount)
        if min_collect_amount is not None
        else compute_min_collect_amount(
            chain_key=ck,
            coin_symbol=symbol,
            estimated_gas_usdt=gas_usdt,
        )
    )
    should_collect, collect_amount, collect_reason = compute_collect_amount(
        token_balance=token_amount,
        min_collect_amount=min_collect_amount,
        reserve_amount=reserve_amount,
    )
    gas_eval = compute_gas_topup_amount(
        chain_key=ck,
        coin_symbol=symbol,
        current_native_balance=native_amount,
        estimated_required_native=gas_native,
        db=db,
    )

    gas_required = bool(should_collect and collect_amount > 0 and token_amount > 0 and gas_eval.gas_required)

    if not should_collect:
        reason = collect_reason
    elif gas_required:
        reason = "COLLECTIBLE_BUT_GAS_REQUIRED"
    else:
        reason = "COLLECTIBLE_GAS_SUFFICIENT"

    return CollectionEvaluationResult(
        should_collect=should_collect,
        reason=reason,
        chain_key=ck,
        coin_symbol=symbol,
        from_address=(from_address or "").strip().lower(),
        to_address=(to_address or "").strip().lower(),
        token_balance=token_amount,
        collect_amount=collect_amount,
        min_collect_amount=min_collect_amount,
        estimated_gas_native=gas_native,
        estimated_gas_usdt=gas_usdt,
        current_native_balance=gas_eval.current_native_balance,
        estimated_required_native=gas_eval.estimated_required_native,
        gas_target_balance=gas_eval.target_native_balance,
        gas_required=gas_required,
        gas_topup_amount=gas_eval.topup_amount if gas_required else Decimal("0"),
        gas_coin_symbol=gas_eval.gas_coin_symbol,
        gas_topup_mode=gas_eval.gas_topup_mode,
        estimate_source=gas_eval.estimate_source,
    )
