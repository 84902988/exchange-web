from __future__ import annotations

from collections.abc import Mapping
from typing import Any


def _read_value(source: Any, key: str) -> Any:
    if isinstance(source, Mapping):
        return source.get(key)
    return getattr(source, key, None)


def _clean(value: Any) -> str:
    return str(value or "").strip()


def auto_moralis_chain_id(chain_id: Any) -> str:
    try:
        numeric_chain_id = int(str(chain_id or "").strip(), 10)
    except Exception:
        return ""
    if numeric_chain_id <= 0:
        return ""
    return f"0x{numeric_chain_id:x}"


def auto_webhook_chain_key(chain_key: Any) -> str:
    return _clean(chain_key).lower()


def get_effective_moralis_chain_id(chain: Any) -> str:
    custom_value = _clean(_read_value(chain, "moralis_chain_id")).lower()
    if custom_value:
        return custom_value
    return auto_moralis_chain_id(_read_value(chain, "chain_id"))


def get_effective_webhook_chain_key(chain: Any) -> str:
    custom_value = _clean(_read_value(chain, "webhook_chain_key")).lower()
    if custom_value:
        return custom_value
    return auto_webhook_chain_key(_read_value(chain, "chain_key"))


def build_moralis_chain_mapping(chain: Any) -> dict[str, str]:
    custom_moralis_chain_id = _clean(_read_value(chain, "moralis_chain_id")).lower()
    custom_webhook_chain_key = _clean(_read_value(chain, "webhook_chain_key")).lower()
    auto_chain_id = auto_moralis_chain_id(_read_value(chain, "chain_id"))
    auto_chain_key = auto_webhook_chain_key(_read_value(chain, "chain_key"))
    effective_chain_id = custom_moralis_chain_id or auto_chain_id
    effective_chain_key = custom_webhook_chain_key or auto_chain_key
    source_label = "自定义" if custom_moralis_chain_id or custom_webhook_chain_key else "自动"
    display = f"{effective_chain_id or '-'} / {effective_chain_key or '-'}"
    return {
        "auto_moralis_chain_id": auto_chain_id,
        "auto_webhook_chain_key": auto_chain_key,
        "effective_moralis_chain_id": effective_chain_id,
        "effective_webhook_chain_key": effective_chain_key,
        "moralis_mapping_source_label": source_label,
        "moralis_mapping_display": display,
    }


def validate_effective_moralis_mapping(
    *,
    chain_id: Any,
    chain_key: Any,
    moralis_stream_enabled: Any,
    watch_enabled: Any,
) -> list[str]:
    enabled = str(moralis_stream_enabled or "").strip() in {"1", "true", "on", "yes"}
    watching = str(watch_enabled or "").strip() in {"1", "true", "on", "yes"}
    if not (enabled or watching):
        return []

    errors: list[str] = []
    if not auto_moralis_chain_id(chain_id):
        errors.append("链 ID 缺失，无法生成 Moralis Chain ID。")
    if not auto_webhook_chain_key(chain_key):
        errors.append("网络标识缺失，无法生成 Webhook Chain Key。")
    return errors
