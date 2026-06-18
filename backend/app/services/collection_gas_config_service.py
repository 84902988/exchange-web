from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta
from decimal import Decimal, InvalidOperation
from typing import Any, Optional

from sqlalchemy import inspect, text
from sqlalchemy.orm import Session

from app.db.models.system_config import SystemConfig
from app.services.collection_chain_helper import DEFAULT_GAS_NATIVE, GAS_TOPUP_BUFFER, GAS_TOPUP_CAP

logger = logging.getLogger(__name__)

COLLECTION_GAS_TOPUP_CONFIG_KEY = "collection_gas_topup_config_v1"
SUPPORTED_EVM_GAS_CONFIG_CHAINS = ("bsc", "polygon", "avaxc", "arbitrum", "ethereum", "optimism")
GAS_TOPUP_MODES = ("DEFAULT", "STATS_BASED", "MANUAL")
DEFAULT_SAFE_MULTIPLIER = Decimal("3")
DEFAULT_MIN_MULTIPLIER = Decimal("2")
DEFAULT_MIN_TOPUP = Decimal("0")
MIN_STATS_SAMPLE_COUNT = 3


class CollectionGasConfigError(ValueError):
    pass


def _normalize_chain_key(chain_key: str) -> str:
    return (chain_key or "").strip().lower()


def _normalize_symbol(token_symbol: Optional[str]) -> str:
    return (token_symbol or "").strip().upper()


def _to_decimal(value: Any, default: Decimal = Decimal("0")) -> Decimal:
    if value is None or value == "":
        return default
    try:
        return Decimal(str(value).strip())
    except (InvalidOperation, ValueError):
        return default


def _decimal_to_str(value: Any) -> str:
    return format(_to_decimal(value), "f")


def default_gas_topup_config(chain_key: str) -> dict[str, Any]:
    ck = _normalize_chain_key(chain_key)
    estimated = Decimal(str(DEFAULT_GAS_NATIVE.get(ck, Decimal("0"))))
    buffer_amount = Decimal(str(GAS_TOPUP_BUFFER.get(ck, Decimal("0"))))
    cap_amount = Decimal(str(GAS_TOPUP_CAP.get(ck, Decimal("0"))))
    target = estimated * DEFAULT_SAFE_MULTIPLIER + buffer_amount
    return {
        "chain_key": ck,
        "gas_topup_mode": "DEFAULT",
        "estimated_required_native": estimated,
        "safe_multiplier": DEFAULT_SAFE_MULTIPLIER,
        "min_multiplier": DEFAULT_MIN_MULTIPLIER,
        "buffer": buffer_amount,
        "cap": cap_amount,
        "min_topup": DEFAULT_MIN_TOPUP,
        "max_topup": cap_amount,
        "target_balance": target,
        "estimate_source": "DEFAULT",
        "stats_sample_count": 0,
        "stats_p95_native_fee": Decimal("0"),
        "is_custom": False,
    }


def _load_raw_config(db: Optional[Session]) -> dict[str, Any]:
    if db is None:
        return {"chains": {}}
    row = (
        db.query(SystemConfig)
        .filter(SystemConfig.config_key == COLLECTION_GAS_TOPUP_CONFIG_KEY)
        .one_or_none()
    )
    if not row or not row.config_value:
        return {"chains": {}}
    try:
        payload = json.loads(row.config_value)
    except Exception:
        logger.exception("collection gas topup config json parse failed")
        return {"chains": {}}
    if not isinstance(payload, dict):
        return {"chains": {}}
    chains = payload.get("chains")
    if not isinstance(chains, dict):
        payload["chains"] = {}
    return payload


def _save_raw_config(db: Session, payload: dict[str, Any]) -> None:
    row = (
        db.query(SystemConfig)
        .filter(SystemConfig.config_key == COLLECTION_GAS_TOPUP_CONFIG_KEY)
        .one_or_none()
    )
    config_value = json.dumps(payload, ensure_ascii=False, sort_keys=True)
    if row:
        row.config_value = config_value
        row.updated_at = datetime.utcnow()
        return
    db.add(
        SystemConfig(
            config_key=COLLECTION_GAS_TOPUP_CONFIG_KEY,
            config_value=config_value,
            description="EVM collection gas topup operation config",
        )
    )


def load_gas_topup_config(db: Optional[Session], chain_key: str) -> dict[str, Any]:
    ck = _normalize_chain_key(chain_key)
    config = default_gas_topup_config(ck)
    raw = _load_raw_config(db)
    override = raw.get("chains", {}).get(ck)
    if isinstance(override, dict):
        mode = str(override.get("gas_topup_mode") or override.get("mode") or config["gas_topup_mode"]).strip().upper()
        config["gas_topup_mode"] = mode if mode in GAS_TOPUP_MODES else "DEFAULT"
        for key in ("safe_multiplier", "buffer", "cap", "min_topup", "max_topup"):
            if key in override:
                config[key] = _to_decimal(override.get(key), config[key])
        config["is_custom"] = True
    return config


def load_all_gas_topup_configs(db: Optional[Session]) -> list[dict[str, Any]]:
    return [load_gas_topup_config(db, chain_key) for chain_key in SUPPORTED_EVM_GAS_CONFIG_CHAINS]


def _validate_decimal(name: str, value: Any, *, allow_zero: bool = True) -> Decimal:
    try:
        amount = Decimal(str(value).strip())
    except (InvalidOperation, ValueError, AttributeError):
        raise CollectionGasConfigError(f"{name} 必须是有效数字")
    if amount < 0 or (amount == 0 and not allow_zero):
        raise CollectionGasConfigError(f"{name} 必须大于{'等于' if allow_zero else ''} 0")
    return amount


def save_gas_topup_config(
    db: Session,
    *,
    chain_key: str,
    gas_topup_mode: str,
    safe_multiplier: Any,
    buffer: Any,
    cap: Any,
    min_topup: Any,
    max_topup: Any,
) -> dict[str, Any]:
    ck = _normalize_chain_key(chain_key)
    if ck not in SUPPORTED_EVM_GAS_CONFIG_CHAINS:
        raise CollectionGasConfigError("不支持的网络")
    mode = str(gas_topup_mode or "").strip().upper()
    if mode not in GAS_TOPUP_MODES:
        raise CollectionGasConfigError("补 Gas 模式不正确")

    safe_multiplier_amount = _validate_decimal("安全倍数", safe_multiplier, allow_zero=False)
    buffer_amount = _validate_decimal("安全余量", buffer)
    cap_amount = _validate_decimal("cap 上限", cap, allow_zero=False)
    min_topup_amount = _validate_decimal("最小补 Gas", min_topup)
    max_topup_amount = _validate_decimal("最大补 Gas", max_topup, allow_zero=False)
    if min_topup_amount > max_topup_amount:
        raise CollectionGasConfigError("最小补 Gas 不能大于最大补 Gas")

    raw = _load_raw_config(db)
    chains = raw.setdefault("chains", {})
    chains[ck] = {
        "gas_topup_mode": mode,
        "safe_multiplier": _decimal_to_str(safe_multiplier_amount),
        "buffer": _decimal_to_str(buffer_amount),
        "cap": _decimal_to_str(cap_amount),
        "min_topup": _decimal_to_str(min_topup_amount),
        "max_topup": _decimal_to_str(max_topup_amount),
    }
    _save_raw_config(db, raw)
    return load_gas_topup_config(db, ck)


def reset_gas_topup_config(db: Session, *, chain_key: str) -> dict[str, Any]:
    ck = _normalize_chain_key(chain_key)
    if ck not in SUPPORTED_EVM_GAS_CONFIG_CHAINS:
        raise CollectionGasConfigError("不支持的网络")
    raw = _load_raw_config(db)
    chains = raw.setdefault("chains", {})
    chains.pop(ck, None)
    _save_raw_config(db, raw)
    return default_gas_topup_config(ck)


def _has_gas_cost_table(db: Optional[Session]) -> bool:
    if db is None:
        return False
    try:
        return bool(inspect(db.get_bind()).has_table("collection_gas_cost_records"))
    except Exception:
        return False


def load_stats_p95_native_fee(
    db: Optional[Session],
    *,
    chain_key: str,
    token_symbol: Optional[str] = None,
    min_samples: int = MIN_STATS_SAMPLE_COUNT,
) -> dict[str, Any]:
    ck = _normalize_chain_key(chain_key)
    symbol = _normalize_symbol(token_symbol)
    if not _has_gas_cost_table(db):
        return {"sample_count": 0, "p95_native_fee": Decimal("0")}

    params: dict[str, Any] = {"chain_key": ck, "cutoff": datetime.utcnow() - timedelta(days=7)}
    token_filter = ""
    if symbol:
        token_filter = "AND UPPER(token_symbol) = :token_symbol"
        params["token_symbol"] = symbol
    rows = db.execute(
        text(
            f"""
            SELECT native_fee
            FROM collection_gas_cost_records
            WHERE LOWER(chain_key) = :chain_key
              AND confirmed_at >= :cutoff
              {token_filter}
              AND receipt_status = 1
              AND transfer_verified = 1
            ORDER BY confirmed_at ASC, id ASC
            """
        ),
        params,
    ).mappings().all()
    values = [_to_decimal(row.get("native_fee")) for row in rows if _to_decimal(row.get("native_fee")) > 0]
    if len(values) < min_samples:
        return {"sample_count": len(values), "p95_native_fee": Decimal("0")}
    sorted_values = sorted(values)
    index = max(0, min(len(sorted_values) - 1, int((len(sorted_values) - 1) * 95 / 100)))
    return {"sample_count": len(values), "p95_native_fee": sorted_values[index]}


def resolve_gas_topup_parameters(
    db: Optional[Session],
    *,
    chain_key: str,
    token_symbol: Optional[str],
    estimated_required_native: Decimal,
) -> dict[str, Any]:
    ck = _normalize_chain_key(chain_key)
    if db is not None:
        raw = _load_raw_config(db)
        chain_overrides = raw.get("chains", {})
        if ck not in chain_overrides:
            raise CollectionGasConfigError(f"collection gas config not initialized for chain: {ck}")
    config = load_gas_topup_config(db, chain_key)
    mode = str(config.get("gas_topup_mode") or "DEFAULT").upper()
    estimated = _to_decimal(estimated_required_native)
    estimate_source = "DEFAULT"
    stats = {"sample_count": 0, "p95_native_fee": Decimal("0")}

    if mode == "STATS_BASED":
        stats = load_stats_p95_native_fee(db, chain_key=chain_key, token_symbol=token_symbol)
        if stats["p95_native_fee"] > 0:
            estimated = stats["p95_native_fee"]
            estimate_source = "STATS_P95"
        else:
            estimate_source = "DEFAULT_FALLBACK"
    elif mode == "MANUAL":
        estimate_source = "MANUAL"

    config["estimated_required_native"] = estimated
    config["estimate_source"] = estimate_source
    config["stats_sample_count"] = int(stats["sample_count"])
    config["stats_p95_native_fee"] = stats["p95_native_fee"]
    if mode == "MANUAL":
        config["target_balance"] = _to_decimal(config.get("cap"))
    else:
        config["target_balance"] = estimated * _to_decimal(config.get("safe_multiplier")) + _to_decimal(config.get("buffer"))
    return config
