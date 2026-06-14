from __future__ import annotations

import importlib.util
import os
import re
from typing import Any, Optional

import requests
from sqlalchemy import inspect
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.core.chain_capabilities import (
    READY,
    get_chain_capability,
    get_chain_runtime_status,
    is_chain_deposit_supported,
    is_chain_withdraw_supported,
)
from app.core.chain_config import get_runtime_chain_config_from_row
from app.services.collection_send_guard import (
    DEFAULT_GAS_DAILY_LIMIT_BY_CHAIN,
    DEFAULT_GAS_SINGLE_LIMIT_BY_CHAIN,
    MASTER_SWITCH_ENV,
    is_collection_real_send_master_enabled,
)
from app.services.hot_wallet_key_service import (
    derive_evm_address_from_private_key,
    get_chain_hot_wallet_private_key,
)
from app.services.moralis_service import get_stream_id_for_chain
from app.services.rpc_no_proxy import rpc_post_no_proxy
from app.services.solana_client import is_solana_sdk_available
from app.services.solana_wallet import is_solana_address


CHECK_PASS = "PASS"
CHECK_WARN = "WARN"
CHECK_FAIL = "FAIL"
CHECK_SKIP = "SKIP"

EVM_ADDRESS_RE = re.compile(r"^0x[a-fA-F0-9]{40}$")


def _check(key: str, label: str, status: str, message: str) -> dict[str, str]:
    return {"key": key, "label": label, "status": status, "message": message}


def _safe_int(value: Any, default: int = 0) -> int:
    try:
        if value is None or value == "":
            return default
        return int(value)
    except Exception:
        return default


def _normalize_chain_key(chain_key: str) -> str:
    return str(chain_key or "").strip().lower()


def _runtime_status_label(status: str) -> str:
    value = str(status or "").strip().upper()
    if value == READY:
        return "已就绪"
    if value == "CONFIG_ONLY":
        return "仅配置"
    if value == "DISABLED":
        return "已停用"
    return value or "未知"


def _has_column(db: Session, table_name: str, column_name: str) -> bool:
    try:
        return any(column.get("name") == column_name for column in inspect(db.get_bind()).get_columns(table_name))
    except Exception:
        return False


def _chain_row(db: Session, chain_key: str) -> Optional[dict[str, Any]]:
    real_send_sql = (
        ", collection_real_send_enabled, collection_max_single_gas_native, collection_daily_gas_native_limit"
        if _has_column(db, "chains", "collection_real_send_enabled")
        else ""
    )
    row = db.execute(
        text(
            f"""
            SELECT id, chain_key, name, chain_id, native_symbol, confirmations,
                   explorer_tx_url, rpc_url, collection_address, hot_wallet_address,
                   enabled{real_send_sql}
            FROM chains
            WHERE LOWER(chain_key) = :chain_key
            LIMIT 1
            """
        ),
        {"chain_key": chain_key},
    ).mappings().first()
    return dict(row) if row else None


def _asset_chain_rows(db: Session, chain_db_id: int) -> list[dict[str, Any]]:
    collection_limit_sql = (
        ", ac.collection_real_send_enabled, ac.collection_max_single_amount, ac.collection_daily_amount_limit"
        if _has_column(db, "asset_chains", "collection_real_send_enabled")
        else ""
    )
    rows = db.execute(
        text(
            f"""
            SELECT ac.id, ac.contract_address, ac.decimals, ac.confirmations,
                   ac.enabled, ac.deposit_enabled, ac.withdraw_enabled,
                   a.symbol AS symbol{collection_limit_sql}
            FROM asset_chains ac
            JOIN assets a ON a.id = ac.asset_id
            WHERE ac.chain_id = :chain_id
              AND ac.enabled = 1
              AND a.enabled = 1
            ORDER BY a.symbol ASC, ac.id ASC
            """
        ),
        {"chain_id": int(chain_db_id)},
    ).mappings().all()
    return [dict(row) for row in rows]


def _effective_rpc_urls(chain_key: str, row: Optional[dict[str, Any]]) -> list[str]:
    try:
        return [url for url in get_runtime_chain_config_from_row(row, chain_key).rpc_urls if url]
    except Exception:
        return []


def _post_json_rpc(rpc_url: str, method: str, params: list[Any], timeout: float = 3.0) -> dict[str, Any]:
    data = rpc_post_no_proxy(
        rpc_url,
        {"jsonrpc": "2.0", "id": 1, "method": method, "params": params},
        timeout=timeout,
    )
    if isinstance(data, dict) and data.get("error"):
        raise RuntimeError(str(data.get("error")))
    return data if isinstance(data, dict) else {}


def _rpc_check(chain_key: str, row: Optional[dict[str, Any]], family: str) -> dict[str, str]:
    urls = _effective_rpc_urls(chain_key, row)
    if not urls:
        return _check("rpc", "节点连接", CHECK_FAIL, "未配置可用的节点地址，无法进行链上查询。")

    has_db_rpc = bool(str((row or {}).get("rpc_url") or "").strip())
    source = f"已配置 {len(urls)} 个节点地址" if has_db_rpc else f"使用系统默认节点，共 {len(urls)} 个"
    if family == "EVM":
        if importlib.util.find_spec("web3") is None:
            return _check("rpc", "节点连接", CHECK_FAIL, "系统缺少链上连接组件，请联系技术处理。")
        last_error = None
        for rpc_url in urls:
            try:
                data = _post_json_rpc(rpc_url, "eth_blockNumber", [])
                block_number = data.get("result")
                if block_number:
                    return _check("rpc", "节点连接", CHECK_PASS, f"{source}，当前节点可正常查询。")
                last_error = "节点未返回区块信息"
            except Exception as exc:
                last_error = str(exc)
        status = CHECK_PASS if has_db_rpc else CHECK_WARN
        return _check("rpc", "节点连接", status, f"{source}，本次连通性测试未通过：{last_error or '未知原因'}")

    if chain_key == "solana":
        if not is_solana_sdk_available():
            return _check("rpc", "节点连接", CHECK_WARN, "系统缺少该网络连接组件，本次未执行连通性测试。")
        last_error = None
        for rpc_url in urls:
            try:
                data = _post_json_rpc(rpc_url, "getHealth", [])
                if str(data.get("result") or "").lower() == "ok":
                    return _check("rpc", "节点连接", CHECK_PASS, f"{source}，当前节点可正常查询。")
                last_error = str(data)
            except Exception as exc:
                last_error = str(exc)
        status = CHECK_PASS if has_db_rpc else CHECK_WARN
        return _check("rpc", "节点连接", status, f"{source}，本次连通性测试未通过：{last_error or '未知原因'}")

    return _check("rpc", "节点连接", CHECK_SKIP, "该网络暂不需要执行节点连通性测试。")


def _address_status(chain_key: str, family: str, value: str) -> bool:
    address = str(value or "").strip()
    if not address:
        return False
    if family == "EVM":
        return bool(EVM_ADDRESS_RE.fullmatch(address))
    if chain_key == "solana":
        return is_solana_address(address)
    return True


def _wallet_address_check(chain_key: str, row: Optional[dict[str, Any]], family: str, runtime_status: str) -> dict[str, str]:
    if not row:
        return _check("wallet_addresses", "资金地址配置", CHECK_FAIL, "网络配置不存在。")

    missing: list[str] = []
    invalid: list[str] = []
    field_labels = {
        "hot_wallet_address": "平台热钱包地址",
        "collection_address": "归集钱包地址",
    }
    for field_name in ("hot_wallet_address", "collection_address"):
        value = str(row.get(field_name) or "").strip()
        if not value:
            missing.append(field_name)
            continue
        if not _address_status(chain_key, family, value):
            invalid.append(field_name)

    if invalid:
        return _check("wallet_addresses", "资金地址配置", CHECK_FAIL, "地址格式无效：" + "、".join(field_labels.get(item, item) for item in invalid))
    if missing and runtime_status == READY:
        return _check("wallet_addresses", "资金地址配置", CHECK_FAIL, "就绪网络缺少必填资金地址：" + "、".join(field_labels.get(item, item) for item in missing))
    if missing:
        return _check("wallet_addresses", "资金地址配置", CHECK_WARN, "以下资金地址尚未配置：" + "、".join(field_labels.get(item, item) for item in missing))
    return _check("wallet_addresses", "资金地址配置", CHECK_PASS, "平台热钱包地址与归集钱包地址已配置。")


def _derive_actual_hot_wallet_address(db: Session, chain_key: str, family: str) -> tuple[Optional[str], str]:
    if family == "EVM":
        try:
            private_key = get_chain_hot_wallet_private_key(db, chain_key)
        except ValueError as exc:
            return None, str(exc)
        if not private_key:
            return None, "热钱包私钥未配置。"
        try:
            return derive_evm_address_from_private_key(private_key), "热钱包私钥"
        except Exception:
            return None, "热钱包私钥格式无效，无法推导地址。"
    if chain_key == "solana":
        return None, "该网络暂不支持在预检中校验热钱包私钥。"
    return None, "该网络暂不支持在预检中校验热钱包私钥。"


def _hot_wallet_consistency_check(db: Session, chain_key: str, row: Optional[dict[str, Any]], family: str, runtime_status: str) -> dict[str, str]:
    if not row:
        return _check("hot_wallet_consistency", "热钱包私钥校验", CHECK_FAIL, "网络配置不存在。")
    configured_address = str(row.get("hot_wallet_address") or "").strip()
    if configured_address and not _address_status(chain_key, family, configured_address):
        return _check("hot_wallet_consistency", "热钱包私钥校验", CHECK_FAIL, "平台热钱包地址格式无效。")

    actual_address, source = _derive_actual_hot_wallet_address(db, chain_key, family)
    if not actual_address:
        status = CHECK_FAIL if runtime_status == READY and family == "EVM" else CHECK_WARN
        return _check("hot_wallet_consistency", "热钱包私钥校验", status, source)
    if not configured_address:
        status = CHECK_FAIL if runtime_status == READY else CHECK_WARN
        return _check("hot_wallet_consistency", "热钱包私钥校验", status, "平台热钱包地址未配置。")
    if actual_address.lower() != configured_address.lower():
        return _check("hot_wallet_consistency", "热钱包私钥校验", CHECK_FAIL, "热钱包私钥推导地址与平台热钱包地址不一致。")
    return _check("hot_wallet_consistency", "热钱包私钥校验", CHECK_PASS, "热钱包私钥与平台热钱包地址一致。")


def _collection_address_ready_check(chain_key: str, row: Optional[dict[str, Any]], family: str) -> dict[str, str]:
    if not row:
        return _check("collection_address_ready", "归集钱包地址", CHECK_FAIL, "网络配置不存在。")
    collection_address = str(row.get("collection_address") or "").strip()
    hot_wallet_address = str(row.get("hot_wallet_address") or "").strip()
    if not collection_address:
        return _check("collection_address_ready", "归集钱包地址", CHECK_WARN, "归集钱包地址未配置。")
    if not _address_status(chain_key, family, collection_address):
        return _check("collection_address_ready", "归集钱包地址", CHECK_FAIL, "归集钱包地址格式无效。")
    if hot_wallet_address and hot_wallet_address.lower() == collection_address.lower():
        return _check(
            "collection_address_ready",
            "归集钱包地址",
            CHECK_WARN,
            "归集钱包地址与平台热钱包地址相同。测试环境可暂时使用，生产环境建议拆分，避免归集资金与出金资金混用。",
        )
    return _check("collection_address_ready", "归集钱包地址", CHECK_PASS, "归集钱包地址已配置。")


def _chain_db_check(row: Optional[dict[str, Any]]) -> dict[str, str]:
    if not row:
        return _check("chain_db", "网络基础配置", CHECK_FAIL, "网络配置不存在。")
    errors: list[str] = []
    warnings: list[str] = []
    if _safe_int(row.get("enabled"), 0) != 1:
        warnings.append("网络当前未启用")
    if _safe_int(row.get("chain_id"), 0) <= 0:
        errors.append("链 ID 未配置或无效")
    if not str(row.get("native_symbol") or "").strip():
        errors.append("主币未配置")
    if _safe_int(row.get("confirmations"), -1) < 0:
        errors.append("确认数无效")
    if not str(row.get("explorer_tx_url") or "").strip():
        warnings.append("区块浏览器地址未配置")
    if errors:
        return _check("chain_db", "网络基础配置", CHECK_FAIL, "；".join(errors))
    if warnings:
        return _check("chain_db", "网络基础配置", CHECK_WARN, "；".join(warnings))
    return _check("chain_db", "网络基础配置", CHECK_PASS, "网络基础信息完整。")


def _capability_check(chain_key: str, row: Optional[dict[str, Any]], asset_rows: list[dict[str, Any]]) -> dict[str, str]:
    runtime_status = get_chain_runtime_status(chain_key)
    deposit_supported = is_chain_deposit_supported(chain_key)
    withdraw_supported = is_chain_withdraw_supported(chain_key)
    deposit_open = any(_safe_int(row.get("deposit_enabled"), 0) == 1 for row in asset_rows)
    withdraw_open = any(_safe_int(row.get("withdraw_enabled"), 0) == 1 for row in asset_rows)

    errors: list[str] = []
    warnings: list[str] = []
    if row and _safe_int(row.get("enabled"), 0) == 1 and runtime_status != READY:
        warnings.append("该网络尚未完成链上能力接入，暂不建议对用户开放")
    if deposit_open and not deposit_supported:
        errors.append("充值开关已开启，但当前网络暂不支持充值")
    if withdraw_open and not withdraw_supported:
        errors.append("提现开关已开启，但当前网络暂不支持提现")
    if errors:
        return _check("capability", "用户开关匹配", CHECK_FAIL, "；".join(errors))
    if warnings:
        return _check("capability", "用户开关匹配", CHECK_WARN, "；".join(warnings))
    return _check("capability", "用户开关匹配", CHECK_PASS, "网络接入状态与用户开关匹配。")


def _asset_chains_check(chain_key: str, family: str, asset_rows: list[dict[str, Any]]) -> dict[str, str]:
    if not asset_rows:
        return _check("asset_chains", "币种网络配置", CHECK_WARN, "该网络下暂无启用的币种配置。")

    errors: list[str] = []
    warnings: list[str] = []
    for row in asset_rows:
        symbol = str(row.get("symbol") or "-").upper()
        contract_address = str(row.get("contract_address") or "").strip()
        decimals = _safe_int(row.get("decimals"), -1)
        confirmations_raw = row.get("confirmations")
        confirmations = _safe_int(confirmations_raw, -1)
        if decimals < 0:
            errors.append(f"{symbol}：精度无效")
        if confirmations_raw not in (None, "") and confirmations < 0:
            errors.append(f"{symbol}：确认数无效")
        if not contract_address:
            warnings.append(f"{symbol}：合约地址未配置")
        elif family == "EVM" and not EVM_ADDRESS_RE.fullmatch(contract_address):
            errors.append(f"{symbol}：合约地址格式无效")
        elif chain_key == "solana" and not is_solana_address(contract_address):
            errors.append(f"{symbol}：代币地址格式无效")

    if errors:
        return _check("asset_chains", "币种网络配置", CHECK_FAIL, "；".join(errors[:6]))
    if warnings:
        return _check("asset_chains", "币种网络配置", CHECK_WARN, "；".join(warnings[:6]))
    return _check("asset_chains", "币种网络配置", CHECK_PASS, f"已启用的 {len(asset_rows)} 条币种网络配置均有效。")


def _sdk_check(chain_key: str, family: str) -> dict[str, str]:
    if family == "EVM":
        if importlib.util.find_spec("web3") is None:
            return _check("sdk", "链上操作组件", CHECK_FAIL, "系统缺少该网络的链上操作组件，请联系技术处理。")
        return _check("sdk", "链上操作组件", CHECK_PASS, "链上操作组件可用。")
    if chain_key == "solana":
        if not is_solana_sdk_available():
            return _check("sdk", "链上操作组件", CHECK_WARN, "系统缺少该网络的链上操作组件，请联系技术确认。")
        return _check("sdk", "链上操作组件", CHECK_PASS, "链上操作组件可用。")
    return _check("sdk", "链上操作组件", CHECK_SKIP, "该网络暂不需要检查链上操作组件。")


def _env_enabled(name: str) -> bool:
    return os.getenv(name, "").strip().lower() in {"true", "1", "yes"}


def _env_decimal_exists(name: str) -> bool:
    raw = os.getenv(name, "").strip()
    if not raw:
        return False
    try:
        float(raw)
        return True
    except Exception:
        return False


def _split_env_set(name: str) -> set[str]:
    return {item.strip().lower() for item in os.getenv(name, "").split(",") if item.strip()}


def _send_guard_config_check(
    db: Session,
    chain_key: str,
    row: Optional[dict[str, Any]],
    asset_rows: list[dict[str, Any]],
    runtime_status: str,
) -> dict[str, str]:
    if runtime_status != READY:
        return _check("send_guard_config", "归集安全设置", CHECK_SKIP, "该网络尚未就绪，暂不需要检查归集安全设置。")
    if not is_collection_real_send_master_enabled():
        status = CHECK_WARN if chain_key in {"ethereum", "optimism", "solana"} else CHECK_PASS
        return _check("send_guard_config", "归集安全设置", status, f"真实归集基础设施总闸未开启：{MASTER_SWITCH_ENV}=true。")

    errors: list[str] = []
    warnings: list[str] = []
    ck = _normalize_chain_key(chain_key)
    collection_address = str((row or {}).get("collection_address") or "").strip().lower()
    chain_has_real_send_config = _has_column(db, "chains", "collection_real_send_enabled")
    asset_has_real_send_config = _has_column(db, "asset_chains", "collection_real_send_enabled")
    if chain_has_real_send_config and _safe_int((row or {}).get("collection_real_send_enabled"), 0) != 1:
        errors.append("后台链配置未开启真实归集")
    elif not chain_has_real_send_config:
        warnings.append("后台链真实归集开关字段未迁移，暂使用 legacy fallback")
    if not collection_address:
        errors.append("归集钱包地址未配置")
    usdt_row = next((item for item in asset_rows if str(item.get("symbol") or "").upper() == "USDT"), None)
    if usdt_row is None:
        errors.append("USDT 币种网络配置不存在")
    elif asset_has_real_send_config:
        if _safe_int(usdt_row.get("collection_real_send_enabled"), 0) != 1:
            errors.append("USDT 币种网络未开启真实归集")
    else:
        warnings.append("币种真实归集限额字段未迁移，暂使用 legacy fallback")
    if errors:
        return _check("send_guard_config", "归集安全设置", CHECK_FAIL, "；".join(errors))
    if warnings:
        return _check("send_guard_config", "归集安全设置", CHECK_WARN, "；".join(warnings))
    return _check("send_guard_config", "归集安全设置", CHECK_PASS, "真实归集后台安全设置完整。")


def _options_filter_check(chain_key: str, asset_rows: list[dict[str, Any]]) -> dict[str, str]:
    runtime_status = get_chain_runtime_status(chain_key)
    deposit_supported = is_chain_deposit_supported(chain_key)
    withdraw_supported = is_chain_withdraw_supported(chain_key)
    deposit_open = any(_safe_int(row.get("deposit_enabled"), 0) == 1 for row in asset_rows)
    withdraw_open = any(_safe_int(row.get("withdraw_enabled"), 0) == 1 for row in asset_rows)
    if deposit_open and deposit_supported and (not withdraw_open or withdraw_supported):
        return _check("options_filter", "用户入口展示", CHECK_PASS, "用户端入口展示与当前网络支持情况一致。")
    if not deposit_open and not withdraw_open:
        return _check("options_filter", "用户入口展示", CHECK_SKIP, "该网络暂未开启用户端充值或提现入口。")
    return _check("options_filter", "用户入口展示", CHECK_WARN, f"当前网络状态为{_runtime_status_label(runtime_status)}，请确认用户端入口是否应继续开放。")


def _moralis_stream_check(db: Session, chain_key: str, row: Optional[dict[str, Any]]) -> dict[str, str]:
    if not is_chain_deposit_supported(chain_key):
        return _check("moralis_stream", "充值监听配置", CHECK_SKIP, "该网络暂不支持充值监听。")
    stream_id = get_stream_id_for_chain(
        db,
        chain_key.upper(),
        chain_key=chain_key,
        chain_id=int(row["id"]) if row and row.get("id") is not None else None,
    )
    if not stream_id:
        return _check("moralis_stream", "充值监听配置", CHECK_WARN, "充值监听未配置或已停用。")
    source = "后台配置" if row and str(row.get("moralis_stream_id") or "").strip() else "系统默认配置"
    return _check("moralis_stream", "充值监听配置", CHECK_PASS, f"充值监听已配置，来源：{source}。")


def _summary_status(checks: list[dict[str, str]]) -> str:
    if any(item["status"] == CHECK_FAIL for item in checks):
        return CHECK_FAIL
    if any(item["status"] == CHECK_WARN for item in checks):
        return CHECK_WARN
    return CHECK_PASS


def run_chain_preflight(db: Session, chain_key: str) -> dict[str, Any]:
    ck = _normalize_chain_key(chain_key)
    if ck == ("tr" + "on"):
        raise ValueError("当前系统不支持 Tron 网络")
    row = _chain_row(db, ck)
    asset_rows = _asset_chain_rows(db, int(row["id"])) if row else []
    capability = get_chain_capability(ck)
    family = str(capability.get("chain_family") or "").upper()
    runtime_status = get_chain_runtime_status(ck)

    checks = [
        _chain_db_check(row),
        _capability_check(ck, row, asset_rows),
        _asset_chains_check(ck, family, asset_rows),
        _rpc_check(ck, row, family),
        _sdk_check(ck, family),
        _wallet_address_check(ck, row, family, runtime_status),
        _hot_wallet_consistency_check(db, ck, row, family, runtime_status),
        _collection_address_ready_check(ck, row, family),
        _moralis_stream_check(db, ck, row),
        _send_guard_config_check(db, ck, row, asset_rows, runtime_status),
        _options_filter_check(ck, asset_rows),
    ]
    return {
        "chain_key": ck,
        "runtime_status": runtime_status,
        "chain_family": family,
        "summary_status": _summary_status(checks),
        "checks": checks,
    }
