from __future__ import annotations

import importlib.util
from copy import deepcopy
from typing import Any, Dict


READY = "READY"
CONFIG_ONLY = "CONFIG_ONLY"
DISABLED = "DISABLED"

EVM = "EVM"
UNKNOWN = "UNKNOWN"

ADMIN_CAPABILITY_SUPPORTED = "supported"
ADMIN_CAPABILITY_INTERNAL_TEST = "internal_test"
ADMIN_CAPABILITY_CODE_PENDING = "code_pending"
ADMIN_CAPABILITY_DEPENDENCY_MISSING = "dependency_missing"
ADMIN_CAPABILITY_CONFIG_ONLY = "config_only"
ADMIN_CAPABILITY_UNSUPPORTED = "unsupported"


_REAL_CAPABILITY_KEYS = (
    "deposit_address_supported",
    "deposit_watch_supported",
    "withdraw_send_supported",
    "withdraw_confirm_supported",
    "collection_supported",
    "gas_topup_supported",
    "address_derivation_supported",
)


_READY_EVM_CAPABILITY: Dict[str, Any] = {
    "runtime_status": READY,
    "chain_family": EVM,
    "deposit_address_supported": True,
    "deposit_watch_supported": True,
    "withdraw_send_supported": True,
    "withdraw_confirm_supported": True,
    "collection_supported": True,
    "gas_topup_supported": True,
    "address_derivation_supported": True,
}


_READY_SOLANA_DEPOSIT_CAPABILITY: Dict[str, Any] = {
    "runtime_status": READY,
    "chain_family": "SOLANA",
    "deposit_address_supported": True,
    "deposit_watch_supported": True,
    "withdraw_send_supported": False,
    "withdraw_confirm_supported": False,
    "collection_supported": False,
    "gas_topup_supported": False,
    "address_derivation_supported": True,
}

_CONFIG_ONLY_SOLANA_CAPABILITY: Dict[str, Any] = {
    "runtime_status": CONFIG_ONLY,
    "chain_family": "SOLANA",
    "deposit_address_supported": False,
    "deposit_watch_supported": False,
    "withdraw_send_supported": False,
    "withdraw_confirm_supported": False,
    "collection_supported": False,
    "gas_topup_supported": False,
    "address_derivation_supported": False,
}

_CONFIG_ONLY_TRON_CAPABILITY: Dict[str, Any] = {
    "runtime_status": CONFIG_ONLY,
    "chain_family": "TRON",
    "deposit_address_supported": False,
    "deposit_watch_supported": False,
    "withdraw_send_supported": False,
    "withdraw_confirm_supported": False,
    "collection_supported": False,
    "gas_topup_supported": False,
    "address_derivation_supported": False,
}


_CHAIN_CAPABILITIES: Dict[str, Dict[str, Any]] = {
    "bsc": _READY_EVM_CAPABILITY,
    "polygon": _READY_EVM_CAPABILITY,
    "avaxc": _READY_EVM_CAPABILITY,
    "ethereum": _READY_EVM_CAPABILITY,
    "optimism": _READY_EVM_CAPABILITY,
}


_ADMIN_CAPABILITY_DISPLAY_META: Dict[str, Dict[str, str]] = {
    ADMIN_CAPABILITY_SUPPORTED: {
        "text": "已支持",
        "badge": "success",
    },
    ADMIN_CAPABILITY_INTERNAL_TEST: {
        "text": "内部测试",
        "badge": "warning",
    },
    ADMIN_CAPABILITY_CODE_PENDING: {
        "text": "已支持",
        "badge": "success",
    },
    ADMIN_CAPABILITY_DEPENDENCY_MISSING: {
        "text": "依赖未安装",
        "badge": "danger",
    },
    ADMIN_CAPABILITY_CONFIG_ONLY: {
        "text": "仅配置",
        "badge": "warning",
    },
    ADMIN_CAPABILITY_UNSUPPORTED: {
        "text": "未接入",
        "badge": "neutral",
    },
}


_ADMIN_AVAXC_CAPABILITY_STATES: Dict[str, str] = {
    "deposit_address_supported": ADMIN_CAPABILITY_CODE_PENDING,
    "deposit_watch_supported": ADMIN_CAPABILITY_INTERNAL_TEST,
    "withdraw_send_supported": ADMIN_CAPABILITY_CODE_PENDING,
    "withdraw_confirm_supported": ADMIN_CAPABILITY_CODE_PENDING,
    "collection_supported": ADMIN_CAPABILITY_CODE_PENDING,
    "gas_topup_supported": ADMIN_CAPABILITY_CODE_PENDING,
}


_ADMIN_EVM_CODE_PENDING_CAPABILITY_STATES: Dict[str, str] = {
    "deposit_address_supported": ADMIN_CAPABILITY_CODE_PENDING,
    "deposit_watch_supported": ADMIN_CAPABILITY_CODE_PENDING,
    "withdraw_send_supported": ADMIN_CAPABILITY_CODE_PENDING,
    "withdraw_confirm_supported": ADMIN_CAPABILITY_CODE_PENDING,
    "collection_supported": ADMIN_CAPABILITY_CODE_PENDING,
    "gas_topup_supported": ADMIN_CAPABILITY_CODE_PENDING,
}


_ADMIN_CODE_PENDING_EVM_CHAINS: set[str] = set()
_ADMIN_CODE_COMPLETE_EVM_CHAINS = {"avaxc", "ethereum"}
_ADMIN_CONFIG_ONLY_EVM_CHAINS: set[str] = set()


_ADMIN_SOLANA_CAPABILITY_STATES: Dict[str, str] = {
    "deposit_address_supported": ADMIN_CAPABILITY_CODE_PENDING,
    "deposit_watch_supported": ADMIN_CAPABILITY_CODE_PENDING,
    "withdraw_send_supported": ADMIN_CAPABILITY_CODE_PENDING,
    "withdraw_confirm_supported": ADMIN_CAPABILITY_CODE_PENDING,
    "collection_supported": ADMIN_CAPABILITY_CODE_PENDING,
    "gas_topup_supported": ADMIN_CAPABILITY_CODE_PENDING,
}


_ADMIN_SOLANA_SDK_REQUIRED_KEYS = {
    "deposit_address_supported",
    "withdraw_send_supported",
    "withdraw_confirm_supported",
    "collection_supported",
    "gas_topup_supported",
}


def _is_solana_sdk_available() -> bool:
    return importlib.util.find_spec("solders") is not None or importlib.util.find_spec("solana") is not None


_KNOWN_CHAIN_FAMILIES = {
    "ethereum": EVM,
    "eth": EVM,
    "optimism": EVM,
    "avaxc": EVM,
    "avalanche": EVM,
    "arbitrum": EVM,
    "solana": "SOLANA",
    "tron": "TRON",
}


def _normalize_chain_key(chain_key: str) -> str:
    return (chain_key or "").strip().lower()


def _config_only_capability(chain_key: str) -> Dict[str, Any]:
    ck = _normalize_chain_key(chain_key)
    capability: Dict[str, Any] = {
        "runtime_status": CONFIG_ONLY,
        "chain_family": _KNOWN_CHAIN_FAMILIES.get(ck, UNKNOWN),
    }
    capability.update({key: False for key in _REAL_CAPABILITY_KEYS})
    return capability


def get_chain_capability(chain_key: str) -> Dict[str, Any]:
    ck = _normalize_chain_key(chain_key)
    capability = _CHAIN_CAPABILITIES.get(ck)
    if capability is None:
        return _config_only_capability(ck)
    return deepcopy(capability)


def is_chain_deposit_supported(chain_key: str) -> bool:
    capability = get_chain_capability(chain_key)
    return bool(
        capability.get("deposit_address_supported")
        and capability.get("deposit_watch_supported")
    )


def is_chain_withdraw_supported(chain_key: str) -> bool:
    capability = get_chain_capability(chain_key)
    return bool(
        capability.get("withdraw_send_supported")
        and capability.get("withdraw_confirm_supported")
    )


def is_chain_collection_supported(chain_key: str) -> bool:
    capability = get_chain_capability(chain_key)
    return bool(capability.get("collection_supported"))


def get_chain_runtime_status(chain_key: str) -> str:
    return str(get_chain_capability(chain_key).get("runtime_status") or CONFIG_ONLY)


def _admin_capability_state_for_key(chain_key: str, capability_key: str, supported: bool) -> str:
    ck = _normalize_chain_key(chain_key)
    if supported:
        return ADMIN_CAPABILITY_SUPPORTED
    if ck in _ADMIN_CONFIG_ONLY_EVM_CHAINS:
        return ADMIN_CAPABILITY_CONFIG_ONLY
    if ck in _ADMIN_CODE_COMPLETE_EVM_CHAINS:
        return ADMIN_CAPABILITY_SUPPORTED
    if ck == "avaxc":
        return _ADMIN_AVAXC_CAPABILITY_STATES.get(capability_key, ADMIN_CAPABILITY_UNSUPPORTED)
    if ck in _ADMIN_CODE_PENDING_EVM_CHAINS:
        return _ADMIN_EVM_CODE_PENDING_CAPABILITY_STATES.get(capability_key, ADMIN_CAPABILITY_UNSUPPORTED)
    if ck == "solana":
        return ADMIN_CAPABILITY_CONFIG_ONLY
    if ck == "tron":
        return ADMIN_CAPABILITY_CONFIG_ONLY
    return ADMIN_CAPABILITY_UNSUPPORTED


def build_admin_chain_capability_view(
    chain_key: str,
    capability_labels: tuple[tuple[str, str], ...],
) -> Dict[str, Any]:
    """
    Read-only admin display view.

    The returned states are presentation-only and intentionally do not change
    the real capability booleans used by deposit/withdraw option filters.
    """
    ck = _normalize_chain_key(chain_key)
    capability = get_chain_capability(ck)
    runtime_status = str(capability.get("runtime_status") or CONFIG_ONLY)
    notes = []
    if runtime_status != READY:
        if ck in _ADMIN_CODE_COMPLETE_EVM_CHAINS:
            notes.append("该网络 EVM 能力已接入，可进入运营测试配置复核。")
            notes.append("当前是否对用户开放由充值/提现开关与 capability 控制。")
        else:
            notes.append("该网络仅完成后台配置，链上充值/提现能力尚未生产验收，不能暴露给普通用户。")

    items = []
    for key, label in capability_labels:
        supported = bool(capability.get(key))
        state = _admin_capability_state_for_key(ck, key, supported)
        meta = _ADMIN_CAPABILITY_DISPLAY_META[state]
        items.append(
            {
                "key": key,
                "label": label,
                "supported": supported,
                "state": state,
                "badge": meta["badge"],
                "text": meta["text"],
            }
        )

    return {
        "runtime_status": runtime_status,
        "chain_family": capability.get("chain_family") or UNKNOWN,
        "capabilities": items,
        "note": " ".join(notes),
    }
