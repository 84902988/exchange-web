from __future__ import annotations

import time
from datetime import datetime
from decimal import Decimal
from typing import Any, Dict, Optional

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.core.chain_capabilities import CONFIG_ONLY, EVM, get_chain_capability, get_chain_runtime_status
from app.core.chain_config import get_runtime_chain_config
from app.services.collection_balance_checker import ERC20_BALANCE_ABI, get_web3_for_chain, _rpc_call_with_timeout


HOT_WALLET_TOKEN_LOW_THRESHOLD = Decimal("0")
HOT_WALLET_GAS_LOW_THRESHOLD = Decimal("0.01")
HOT_WALLET_BALANCE_CACHE_SECONDS = 60
HOT_WALLET_RPC_TIMEOUT_SECONDS = 5.0

HOT_WALLET_WARNING_STATUSES = {"UNCONFIGURED", "TOKEN_LOW", "GAS_LOW"}
HOT_WALLET_READY_EVM_CHAINS = {"bsc", "polygon", "avaxc", "ethereum", "optimism"}

_BALANCE_CACHE: Dict[str, Dict[str, Any]] = {}


def _normalize_chain_key(value: Any) -> str:
    return str(value or "").strip().lower()


def _normalize_symbol(value: Any) -> str:
    return str(value or "").strip().upper()


def _decimal(value: Any) -> Decimal:
    try:
        return Decimal(str(value or "0"))
    except Exception:
        return Decimal("0")


def _int(value: Any) -> int:
    try:
        return int(value or 0)
    except Exception:
        return 0


def _amount_display(value: Any, symbol: str = "") -> str:
    amount = _decimal(value)
    text_value = format(amount.normalize(), "f") if amount != 0 else "0"
    if "." in text_value:
        text_value = text_value.rstrip("0").rstrip(".") or "0"
    return f"{text_value} {symbol}".strip()


def _datetime_display(value: Optional[datetime]) -> str:
    if not value:
        return "-"
    try:
        return value.strftime("%Y-%m-%d %H:%M:%S")
    except Exception:
        return "-"


def _short_address(address: Any) -> str:
    text_value = str(address or "").strip()
    if not text_value:
        return "-"
    if len(text_value) <= 16:
        return text_value
    return f"{text_value[:8]}...{text_value[-6:]}"


def _explorer_address_url(chain_key: str, address: str) -> str:
    if not address:
        return ""
    mapping = {
        "bsc": "https://bscscan.com/address/{address}",
        "polygon": "https://polygonscan.com/address/{address}",
        "avaxc": "https://snowtrace.io/address/{address}",
        "ethereum": "https://etherscan.io/address/{address}",
        "optimism": "https://optimistic.etherscan.io/address/{address}",
    }
    template = mapping.get(_normalize_chain_key(chain_key), "")
    return template.format(address=address) if template else ""


def _is_supported_monitor_chain(chain_key: str) -> bool:
    ck = _normalize_chain_key(chain_key)
    if ck not in HOT_WALLET_READY_EVM_CHAINS:
        return False
    try:
        capability = get_chain_capability(ck)
        return (
            str(capability.get("chain_family") or "").upper() == EVM
            and get_chain_runtime_status(ck) != CONFIG_ONLY
        )
    except Exception:
        return False


def _status_meta(status: str) -> tuple[str, str]:
    value = str(status or "").upper()
    mapping = {
        "PENDING_REFRESH": ("待刷新", "neutral"),
        "NORMAL": ("正常", "success"),
        "UNCONFIGURED": ("未配置", "warning"),
        "READ_FAILED": ("读取失败", "danger"),
        "TOKEN_LOW": ("币种余额偏低", "warning"),
        "GAS_LOW": ("Gas不足", "warning"),
    }
    return mapping.get(value, (value or "未知", "neutral"))


def _cache_key(row: Dict[str, Any]) -> str:
    return f"{int(row.get('asset_chain_id') or 0)}:{_normalize_chain_key(row.get('chain_key'))}:{str(row.get('hot_wallet_address') or '').strip().lower()}"


def _base_balance_snapshot(row: Dict[str, Any], *, status: str = "PENDING_REFRESH") -> Dict[str, Any]:
    chain_key = _normalize_chain_key(row.get("chain_key"))
    native_symbol = str(row.get("native_symbol") or "").strip()
    try:
        runtime_config = get_runtime_chain_config(None, chain_key)
        native_symbol = native_symbol or runtime_config.native_symbol
    except Exception:
        pass
    token_threshold = HOT_WALLET_TOKEN_LOW_THRESHOLD
    gas_threshold = HOT_WALLET_GAS_LOW_THRESHOLD
    if not str(row.get("hot_wallet_address") or "").strip():
        status = "UNCONFIGURED"
    status_label, status_badge = _status_meta(status)
    return {
        "token_balance": None,
        "gas_balance": None,
        "checked_at": None,
        "error": "",
        "status": status,
        "status_label": status_label,
        "status_badge": status_badge,
        "token_threshold": token_threshold,
        "gas_threshold": gas_threshold,
        "native_symbol": native_symbol,
        "cache_state": "missing",
    }


def _load_monitor_rows(db: Session) -> list[Dict[str, Any]]:
    rows = db.execute(
        text(
            """
            SELECT
              ac.id AS asset_chain_id,
              a.id AS asset_id,
              UPPER(a.symbol) AS symbol,
              a.name AS asset_name,
              COALESCE(a.display_precision, 6) AS display_precision,
              c.id AS chain_id,
              LOWER(c.chain_key) AS chain_key,
              c.name AS chain_name,
              c.native_symbol,
              c.hot_wallet_address,
              LOWER(ac.contract_address) AS contract_address,
              COALESCE(ac.decimals, 18) AS decimals,
              COALESCE(ac.deposit_enabled, 0) AS deposit_enabled,
              COALESCE(ac.withdraw_enabled, 0) AS withdraw_enabled
            FROM asset_chains ac
            JOIN assets a ON a.id = ac.asset_id
            JOIN chains c ON c.id = ac.chain_id
            WHERE COALESCE(c.enabled, 0) = 1
              AND COALESCE(ac.enabled, 0) = 1
              AND COALESCE(a.enabled, 0) = 1
              AND (COALESCE(ac.withdraw_enabled, 0) = 1 OR COALESCE(ac.deposit_enabled, 0) = 1)
            ORDER BY c.name ASC, c.chain_key ASC, a.symbol ASC
            """
        )
    ).mappings().all()
    return [dict(row) for row in rows if _is_supported_monitor_chain(row.get("chain_key"))]


def _read_monitor_balance(db: Session, row: Dict[str, Any]) -> Dict[str, Any]:
    chain_key = _normalize_chain_key(row.get("chain_key"))
    symbol = _normalize_symbol(row.get("symbol"))
    native_symbol = str(row.get("native_symbol") or "").strip()
    try:
        runtime_config = get_runtime_chain_config(db, chain_key)
        native_symbol = native_symbol or runtime_config.native_symbol
    except Exception:
        pass

    address = str(row.get("hot_wallet_address") or "").strip()
    checked_at = datetime.utcnow()
    token_threshold = HOT_WALLET_TOKEN_LOW_THRESHOLD
    gas_threshold = HOT_WALLET_GAS_LOW_THRESHOLD
    if not address:
        status = "UNCONFIGURED"
        status_label, status_badge = _status_meta(status)
        return {
            "token_balance": None,
            "gas_balance": None,
            "checked_at": None,
            "error": "",
            "status": status,
            "status_label": status_label,
            "status_badge": status_badge,
            "token_threshold": token_threshold,
            "gas_threshold": gas_threshold,
            "native_symbol": native_symbol,
        }

    try:
        deadline = time.monotonic() + HOT_WALLET_RPC_TIMEOUT_SECONDS
        w3 = get_web3_for_chain(chain_key, db=db, deadline_monotonic=deadline)
        owner_address = w3.to_checksum_address(address)
        wei_balance = int(
            _rpc_call_with_timeout(
                f"{chain_key} hot_wallet get_balance {owner_address}",
                lambda: w3.eth.get_balance(owner_address),
                deadline_monotonic=deadline,
                timeout_seconds=HOT_WALLET_RPC_TIMEOUT_SECONDS,
            )
        )
        gas_balance = Decimal(wei_balance) / Decimal(10**18)
        contract_address = str(row.get("contract_address") or "").strip()
        if contract_address:
            token_address = w3.to_checksum_address(contract_address)
            token = w3.eth.contract(address=token_address, abi=ERC20_BALANCE_ABI)
            raw_token_balance = int(
                _rpc_call_with_timeout(
                    f"{chain_key} hot_wallet balanceOf {token_address} {owner_address}",
                    lambda: token.functions.balanceOf(owner_address).call(),
                    deadline_monotonic=deadline,
                    timeout_seconds=HOT_WALLET_RPC_TIMEOUT_SECONDS,
                )
            )
            token_balance = raw_token_balance / (Decimal(10) ** int(row.get("decimals") or 18))
        else:
            token_balance = gas_balance
    except Exception as exc:
        status = "READ_FAILED"
        status_label, status_badge = _status_meta(status)
        return {
            "token_balance": None,
            "gas_balance": None,
            "checked_at": checked_at,
            "error": str(exc)[:180],
            "status": status,
            "status_label": status_label,
            "status_badge": status_badge,
            "token_threshold": token_threshold,
            "gas_threshold": gas_threshold,
            "native_symbol": native_symbol,
        }

    if token_balance <= token_threshold:
        status = "TOKEN_LOW"
    elif gas_balance <= gas_threshold:
        status = "GAS_LOW"
    else:
        status = "NORMAL"
    status_label, status_badge = _status_meta(status)
    return {
        "token_balance": token_balance,
        "gas_balance": gas_balance,
        "checked_at": checked_at,
        "error": "",
        "status": status,
        "status_label": status_label,
        "status_badge": status_badge,
        "token_threshold": token_threshold,
        "gas_threshold": gas_threshold,
        "native_symbol": native_symbol,
    }


def _balance_snapshot(
    db: Session,
    row: Dict[str, Any],
    *,
    force_refresh: bool = False,
    cache_only: bool = False,
) -> Dict[str, Any]:
    key = _cache_key(row)
    now = time.time()
    cached = _BALANCE_CACHE.get(key)
    if not force_refresh and cached and float(cached.get("expires_at") or 0) > now:
        data = dict(cached.get("data") or {})
        data["cache_state"] = "fresh"
        return data
    if cache_only:
        return _base_balance_snapshot(row, status="PENDING_REFRESH")
    data = _read_monitor_balance(db, row)
    _BALANCE_CACHE[key] = {
        "expires_at": now + HOT_WALLET_BALANCE_CACHE_SECONDS,
        "data": dict(data),
    }
    data["cache_state"] = "fresh"
    return data


def _monitor_item(
    db: Session,
    row: Dict[str, Any],
    *,
    force_refresh: bool = False,
    cache_only: bool = False,
) -> Dict[str, Any]:
    balance = _balance_snapshot(db, row, force_refresh=force_refresh, cache_only=cache_only)
    chain_key = _normalize_chain_key(row.get("chain_key"))
    symbol = _normalize_symbol(row.get("symbol"))
    native_symbol = str(balance.get("native_symbol") or row.get("native_symbol") or "").strip()
    address = str(row.get("hot_wallet_address") or "").strip()
    token_balance = balance.get("token_balance")
    gas_balance = balance.get("gas_balance")
    token_threshold = _decimal(balance.get("token_threshold"))
    gas_threshold = _decimal(balance.get("gas_threshold"))
    return {
        "asset_chain_id": int(row.get("asset_chain_id") or 0),
        "asset_id": int(row.get("asset_id") or 0),
        "chain_key": chain_key,
        "chain_name": row.get("chain_name") or chain_key,
        "symbol": symbol,
        "asset_name": row.get("asset_name") or "",
        "hot_wallet_address": address,
        "hot_wallet_address_short": _short_address(address),
        "explorer_address_url": _explorer_address_url(chain_key, address),
        "contract_address": str(row.get("contract_address") or "").strip(),
        "token_balance": token_balance,
        "token_balance_label": _amount_display(token_balance, symbol) if token_balance is not None else "-",
        "gas_balance": gas_balance,
        "gas_balance_label": _amount_display(gas_balance, native_symbol) if gas_balance is not None else "-",
        "token_threshold": token_threshold,
        "token_threshold_label": _amount_display(token_threshold, symbol),
        "gas_threshold": gas_threshold,
        "gas_threshold_label": _amount_display(gas_threshold, native_symbol),
        "native_symbol": native_symbol,
        "status": balance.get("status") or "READ_FAILED",
        "status_label": balance.get("status_label") or "读取失败",
        "status_badge": balance.get("status_badge") or "danger",
        "error": balance.get("error") or "",
        "checked_at": balance.get("checked_at"),
        "checked_at_label": _datetime_display(balance.get("checked_at")),
        "needs_refresh": bool(balance.get("status") == "PENDING_REFRESH"),
        "cache_state": balance.get("cache_state") or "",
        "deposit_enabled": int(row.get("deposit_enabled") or 0),
        "withdraw_enabled": int(row.get("withdraw_enabled") or 0),
    }


def hot_wallet_monitor_item_payload(item: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "asset_chain_id": int(item.get("asset_chain_id") or 0),
        "asset_id": int(item.get("asset_id") or 0),
        "chain_key": item.get("chain_key") or "",
        "symbol": item.get("symbol") or "",
        "token_balance_label": item.get("token_balance_label") or "-",
        "gas_balance_label": item.get("gas_balance_label") or "-",
        "token_threshold_label": item.get("token_threshold_label") or "-",
        "gas_threshold_label": item.get("gas_threshold_label") or "-",
        "status": item.get("status") or "",
        "status_label": item.get("status_label") or "",
        "status_badge": item.get("status_badge") or "neutral",
        "error": item.get("error") or "",
        "checked_at_label": item.get("checked_at_label") or "-",
        "needs_refresh": bool(item.get("needs_refresh")),
    }


def query_hot_wallet_monitor(db: Session, filters: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    filters = filters or {}
    chain_filter = _normalize_chain_key(filters.get("chain_key"))
    symbol_filter = _normalize_symbol(filters.get("symbol"))
    status_filter = str(filters.get("status") or "").strip().upper()
    allowed_statuses = {"", "NORMAL", "WARNING", "READ_FAILED", "UNCONFIGURED", "TOKEN_LOW", "GAS_LOW"}
    if status_filter not in allowed_statuses:
        status_filter = ""

    rows = _load_monitor_rows(db)
    chain_options = []
    symbol_options = []
    seen_chains = set()
    seen_symbols = set()
    for row in rows:
        chain_key = _normalize_chain_key(row.get("chain_key"))
        symbol = _normalize_symbol(row.get("symbol"))
        if chain_key not in seen_chains:
            seen_chains.add(chain_key)
            chain_options.append({"chain_key": chain_key, "chain_name": row.get("chain_name") or chain_key})
        if symbol not in seen_symbols:
            seen_symbols.add(symbol)
            symbol_options.append({"symbol": symbol})

    target_rows = []
    for row in rows:
        if chain_filter and _normalize_chain_key(row.get("chain_key")) != chain_filter:
            continue
        if symbol_filter and _normalize_symbol(row.get("symbol")) != symbol_filter:
            continue
        target_rows.append(row)
    all_items = [_monitor_item(db, row, cache_only=True) for row in target_rows]

    def include_item(item: Dict[str, Any]) -> bool:
        if chain_filter and item["chain_key"] != chain_filter:
            return False
        if symbol_filter and item["symbol"] != symbol_filter:
            return False
        item_status = str(item.get("status") or "").upper()
        if status_filter == "WARNING":
            return item_status in HOT_WALLET_WARNING_STATUSES
        if status_filter:
            return item_status == status_filter
        return True

    items = [item for item in all_items if include_item(item)]
    summary = {
        "total": len(items),
        "normal": sum(1 for item in items if item.get("status") == "NORMAL"),
        "warning": sum(1 for item in items if item.get("status") in HOT_WALLET_WARNING_STATUSES),
        "read_failed": sum(1 for item in items if item.get("status") == "READ_FAILED"),
    }
    return {
        "items": items,
        "summary": summary,
        "filters": {
            "chain_key": chain_filter,
            "symbol": symbol_filter,
            "status": status_filter,
        },
        "chain_options": sorted(chain_options, key=lambda item: (item["chain_name"], item["chain_key"])),
        "symbol_options": sorted(symbol_options, key=lambda item: item["symbol"]),
        "cache_seconds": HOT_WALLET_BALANCE_CACHE_SECONDS,
    }


def refresh_hot_wallet_monitor_item(
    db: Session,
    *,
    chain_key: str = "",
    asset_chain_id: Any = None,
    asset_id: Any = None,
) -> Dict[str, Any]:
    rows = _load_monitor_rows(db)
    normalized_chain = _normalize_chain_key(chain_key)
    target_asset_chain_id = _int(asset_chain_id)
    target_asset_id = _int(asset_id)
    for row in rows:
        if normalized_chain and _normalize_chain_key(row.get("chain_key")) != normalized_chain:
            continue
        if target_asset_chain_id and int(row.get("asset_chain_id") or 0) != target_asset_chain_id:
            continue
        if target_asset_id and int(row.get("asset_id") or 0) != target_asset_id:
            continue
        item = _monitor_item(db, row, force_refresh=True)
        return {"ok": item.get("status") != "READ_FAILED", "item": item, "error": item.get("error") or ""}
    return {"ok": False, "item": None, "error": "未找到匹配的热钱包监控项"}
