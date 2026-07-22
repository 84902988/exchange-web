# backend/app/routers/asset_withdraw.py
from __future__ import annotations

import hashlib
import json
import logging
import os
import random
from dataclasses import dataclass
from datetime import datetime, timedelta
from decimal import Decimal, ROUND_HALF_UP, ROUND_UP
from typing import Any, Dict, List, Optional, Tuple

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from pydantic import BaseModel, Field
import requests
from sqlalchemy import bindparam, text
from sqlalchemy.orm import Session

from app.core.chain_capabilities import EVM, get_chain_capability, is_chain_withdraw_supported
from app.core.redis import get_redis
from app.db.session import get_db
from app.deps.auth import get_current_user_id
from app.services.balance import FUNDING_BALANCE_CHAIN_KEY
from app.services.native_price_service import get_native_token_usdt_price
from app.services.user_withdraw_lock_service import assert_user_withdraw_unlocked
from app.services.withdraw_fee_service import get_configured_withdraw_fee
from app.services.withdraw_risk_service import check_withdraw_risk

# 可选：如果你环境里有 web3，才启用 gas 估算
try:
    from web3 import Web3
except Exception:
    Web3 = None  # type: ignore


router = APIRouter(prefix="/asset", tags=["asset"])
logger = logging.getLogger(__name__)
WITHDRAW_FEE_RPC_COOLDOWN_SECONDS = int(os.getenv("WITHDRAW_FEE_RPC_COOLDOWN_SECONDS", "600"))


# =========================
# Response helpers
# =========================
def _ok(data: Any, trace_id: Optional[str] = None):
    return {"ok": True, "data": data, "error": None, "trace_id": trace_id}


def _err(code: str, message: str, trace_id: Optional[str] = None, http_status: int = 400):
    raise HTTPException(
        status_code=http_status,
        detail={"ok": False, "data": None, "error": {"code": code, "message": message}, "trace_id": trace_id},
    )


def _now() -> datetime:
    return datetime.utcnow()


WITHDRAW_REVIEWING_STATUS = "REVIEWING"
WITHDRAW_VERIFYING_STATUS = "VERIFYING"
WITHDRAW_LOG_RISK_REASON_COLUMNS = ("risk_reason", "reject_reason", "reason", "audit_reason", "remark", "error_message", "fail_reason")
# Withdraw user balances always live in the funding account.
# withdraw_logs.chain_key is only the on-chain network used for payout/watcher flows.
WITHDRAW_BALANCE_ACCOUNT_KEY = FUNDING_BALANCE_CHAIN_KEY
WITHDRAW_FEE_COIN = "USDT"


def _get_withdraw_log_risk_reason_column(db: Session) -> Optional[str]:
    try:
        rows = db.execute(
            text(
                """
                SELECT COLUMN_NAME AS column_name
                FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA = DATABASE()
                  AND TABLE_NAME = 'withdraw_logs'
                  AND COLUMN_NAME IN :columns
                """
            ).bindparams(bindparam("columns", expanding=True)),
            {"columns": WITHDRAW_LOG_RISK_REASON_COLUMNS},
        ).mappings().all()
    except Exception as e:
        print("[withdraw-risk] reason column lookup failed", repr(e))
        return None

    existing = {str(row["column_name"]) for row in rows}
    for column in WITHDRAW_LOG_RISK_REASON_COLUMNS:
        if column in existing:
            return column
    return None


def _get_withdraw_log_columns(db: Session) -> set[str]:
    try:
        rows = db.execute(
            text(
                """
                SELECT COLUMN_NAME AS column_name
                FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA = DATABASE()
                  AND TABLE_NAME = 'withdraw_logs'
                """
            )
        ).mappings().all()
    except Exception as e:
        print("[withdraw-list] column lookup failed", repr(e))
        return set()
    return {str(row.get("column_name") or "") for row in rows}


def _withdraw_log_reason_expr(columns: set[str]) -> str:
    existing = [column for column in WITHDRAW_LOG_RISK_REASON_COLUMNS if column in columns]
    if not existing:
        return "NULL AS withdraw_reason"
    if len(existing) == 1:
        return f"NULLIF({existing[0]}, '') AS withdraw_reason"
    joined = ", ".join(f"NULLIF({column}, '')" for column in existing)
    return f"COALESCE({joined}) AS withdraw_reason"


# =========================
# Schemas
# =========================
class WithdrawCreateIn(BaseModel):
    symbol: str = Field(..., description="coin symbol, e.g. USDT")
    network: str = Field(..., description="chain name from UI, e.g. Polygon / BSC / arbitrum / chain_key")
    to_address: str = Field(..., description="destination address")
    amount: Decimal = Field(..., description="withdraw amount")


class WithdrawSendCodeIn(BaseModel):
    withdraw_id: int = Field(..., description="withdraw id")


class WithdrawCancelIn(BaseModel):
    withdraw_id: int = Field(..., description="withdraw id")


class WithdrawConfirmIn(BaseModel):
    withdraw_id: int = Field(..., description="withdraw id")
    code: str = Field(..., description="email code")


class WithdrawMarkIn(BaseModel):
    withdraw_id: int = Field(..., description="withdraw id")
    tx_hash: Optional[str] = Field(default=None, description="onchain tx hash")
    remark: Optional[str] = Field(default=None, description="remark")


# =========================
# Utilities
# =========================
def _normalize_chain_key(network: str) -> str:
    """
    UI 传 Polygon/BSC/Arbitrum 等，这里统一成 chain_key（小写）
    """
    m = {
        "polygon": "polygon",
        "matic": "polygon",
        "bsc": "bsc",
        "bnb": "bsc",
        "arbitrum": "arbitrum",
        "arb": "arbitrum",
        "avaxc": "avaxc",
        "avax": "avaxc",
        "avalanche": "avaxc",
        "avalanche c-chain": "avaxc",
        "avalanche c chain": "avaxc",
    }
    k = (network or "").strip().lower()
    return m.get(k, k)


def _gen_email_code() -> str:
    return f"{random.randint(0, 999999):06d}"


def _hash_code(code: str, salt: str) -> str:
    s = (code.strip() + "|" + salt).encode("utf-8")
    return hashlib.sha256(s).hexdigest()


def _ensure_decimal(x: Any) -> Decimal:
    if isinstance(x, Decimal):
        return x
    return Decimal(str(x))


def _q6(x: Decimal) -> str:
    return str(x.quantize(Decimal("0.000001"), rounding=ROUND_HALF_UP))


def _q_withdraw_fee(x: Decimal) -> str:
    return str(x.quantize(Decimal("0.001"), rounding=ROUND_UP))


@dataclass(frozen=True)
class WithdrawFeeEstimate:
    fee: Decimal
    fee_source: str
    raw_fee_usdt: Optional[Decimal]
    min_fee: Decimal
    buffer: Decimal
    fallback_reason: str = ""
    native_symbol: str = ""
    native_price_usdt: Optional[Decimal] = None
    native_price_source: str = ""
    gas_limit: Optional[int] = None
    gas_limit_source: str = ""
    gas_price_wei: Optional[int] = None
    chain_id: Optional[int] = None
    rpc_url: str = ""

    def api_debug(self) -> Dict[str, Any]:
        return {
            "fee_source": self.fee_source,
            "raw_fee_usdt": _q6(self.raw_fee_usdt) if self.raw_fee_usdt is not None else None,
            "min_fee": _q6(self.min_fee),
            "buffer": str(self.buffer),
            "fallback_reason": self.fallback_reason,
            "native_symbol": self.native_symbol,
            "native_price_usdt": str(self.native_price_usdt) if self.native_price_usdt is not None else None,
            "native_price_source": self.native_price_source,
            "gas_limit": self.gas_limit,
            "gas_limit_source": self.gas_limit_source,
            "gas_price_wei": self.gas_price_wei,
            "chain_id": self.chain_id,
        }


def _get_runtime_chain_config_safe(db: Session, chain_key: str):
    ck = (chain_key or "").lower()
    try:
        from app.core.chain_config import get_runtime_chain_config

        return get_runtime_chain_config(db, ck)
    except Exception:
        return None


def _get_rpc_url(db: Session, chain_key: str) -> Optional[str]:
    cfg = _get_runtime_chain_config_safe(db, chain_key)
    if cfg is None:
        return None
    return cfg.rpc_url or None


def _get_chain_price_usdt(chain_key: str, native_symbol: str = "") -> Optional[Decimal]:
    if native_symbol:
        price_result = get_native_token_usdt_price(native_symbol)
        if price_result.price is not None:
            return price_result.price

    ck = (chain_key or "").lower()
    key = None
    if ck == "bsc":
        key = "PRICE_BSC"
    elif ck == "polygon":
        key = "PRICE_POLYGON"
    elif ck == "arbitrum":
        key = "PRICE_ARBITRUM"
    elif ck == "avaxc":
        key = "PRICE_AVAXC"
    elif ck == "optimism":
        key = "PRICE_OPTIMISM"
    if not key:
        return None
    v = os.getenv(key)
    if not v and ck == "avaxc":
        v = os.getenv("PRICE_AVAX")
    if not v and ck == "optimism":
        v = os.getenv("PRICE_OP") or os.getenv("PRICE_ETH")
    if not v:
        return None
    try:
        return Decimal(str(v))
    except Exception:
        return None


# 最小 ERC20 ABI：transfer / decimals / balanceOf
_ERC20_ABI = [
    {
        "name": "transfer",
        "type": "function",
        "stateMutability": "nonpayable",
        "inputs": [{"name": "_to", "type": "address"}, {"name": "_value", "type": "uint256"}],
        "outputs": [{"name": "", "type": "bool"}],
    },
    {
        "name": "decimals",
        "type": "function",
        "stateMutability": "view",
        "inputs": [],
        "outputs": [{"name": "", "type": "uint8"}],
    },
    {
        "name": "balanceOf",
        "type": "function",
        "stateMutability": "view",
        "inputs": [{"name": "account", "type": "address"}],
        "outputs": [{"name": "", "type": "uint256"}],
    },
]


def _load_asset_chain(db: Session, symbol: str, chain_key: str) -> Tuple[Optional[str], int]:
    row = db.execute(
        text(
            """
            SELECT ac.contract_address, ac.decimals
            FROM asset_chains ac
            JOIN assets a ON a.id = ac.asset_id
            JOIN chains c ON c.id = ac.chain_id
            WHERE a.symbol = :sym
              AND c.chain_key = :ck
              AND a.enabled = 1
              AND c.enabled = 1
              AND ac.enabled = 1
              AND ac.withdraw_enabled = 1
            LIMIT 1
            """
        ),
        {"sym": symbol, "ck": chain_key},
    ).mappings().first()

    if not row:
        return None, 18

    ca = row.get("contract_address")
    dec = int(row.get("decimals") or 18)
    return (ca, dec)


def _load_withdraw_asset_chain_config(db: Session, symbol: str, chain_key: str) -> Optional[Dict[str, Any]]:
    return db.execute(
        text(
            """
            SELECT
              ac.contract_address,
              ac.decimals,
              ac.min_withdraw,
              ac.review_threshold_amount,
              COALESCE(ac.force_manual_review, 0) AS force_manual_review,
              ac.daily_withdraw_count_limit
            FROM asset_chains ac
            JOIN assets a ON a.id = ac.asset_id
            JOIN chains c ON c.id = ac.chain_id
            WHERE a.symbol = :sym
              AND c.chain_key = :ck
              AND a.enabled = 1
              AND c.enabled = 1
              AND ac.enabled = 1
              AND ac.withdraw_enabled = 1
            LIMIT 1
            """
        ),
        {"sym": symbol, "ck": chain_key},
    ).mappings().first()


def _load_chain_hot_wallet_address(db: Session, chain_key: str) -> Optional[str]:
    row = db.execute(
        text(
            """
            SELECT hot_wallet_address
            FROM chains
            WHERE chain_key = :ck
              AND enabled = 1
            LIMIT 1
            """
        ),
        {"ck": (chain_key or "").strip().lower()},
    ).mappings().first()
    if not row:
        return None
    return str(row.get("hot_wallet_address") or "").strip() or None


def _load_chain_system_addresses(db: Session, chain_key: str) -> List[str]:
    candidate_columns = (
        "hot_wallet_address",
        "collection_address",
        "gas_wallet_address",
        "platform_wallet_address",
        "fee_wallet_address",
    )
    rows = db.execute(
        text(
            """
            SELECT COLUMN_NAME AS column_name
            FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME = 'chains'
              AND COLUMN_NAME IN :columns
            """
        ).bindparams(bindparam("columns", expanding=True)),
        {"columns": candidate_columns},
    ).mappings().all()
    existing = [column for column in candidate_columns if column in {str(row.get("column_name") or "") for row in rows}]
    if not existing:
        return []

    select_columns = ", ".join(existing)
    row = db.execute(
        text(
            f"""
            SELECT {select_columns}
            FROM chains
            WHERE chain_key = :ck
              AND enabled = 1
            LIMIT 1
            """
        ),
        {"ck": (chain_key or "").strip().lower()},
    ).mappings().first()
    if not row:
        return []

    addresses: List[str] = []
    for column in existing:
        value = str(row.get(column) or "").strip()
        if value:
            addresses.append(value)
    return addresses


def _is_platform_system_address(db: Session, chain_key: str, address: str) -> bool:
    target = (address or "").strip().lower()
    if not target:
        return False
    return any(target == item.strip().lower() for item in _load_chain_system_addresses(db, chain_key) if item)


def _estimate_dummy_from_address(db: Session, chain_key: str) -> str:
    chain_hot_wallet = _load_chain_hot_wallet_address(db, chain_key)
    if chain_hot_wallet:
        return chain_hot_wallet

    env_hot_wallet = os.getenv("PLATFORM_HOT_WALLET", "").strip()
    if env_hot_wallet:
        logger.warning(
            "[withdraw-fee] chain hot wallet address not configured, fallback to PLATFORM_HOT_WALLET chain=%s",
            (chain_key or "").strip().lower(),
        )
        return env_hot_wallet

    logger.warning(
        "[withdraw-fee] chain hot wallet address not configured, fallback to dummy address chain=%s",
        (chain_key or "").strip().lower(),
    )
    return "0x1000000000000000000000000000000000000001"


def _fallback_fee_estimate(
    *,
    min_fee: Decimal,
    buffer: Decimal,
    reason: str,
    native_symbol: str = "",
    native_price_usdt: Optional[Decimal] = None,
    native_price_source: str = "",
    rpc_url: str = "",
    chain_id: Optional[int] = None,
) -> WithdrawFeeEstimate:
    logger.warning("[withdraw-fee] fallback to min fee reason=%s native=%s chain_id=%s", reason, native_symbol, chain_id)
    return WithdrawFeeEstimate(
        fee=min_fee,
        fee_source="FALLBACK",
        raw_fee_usdt=None,
        min_fee=min_fee,
        buffer=buffer,
        fallback_reason=reason,
        native_symbol=native_symbol,
        native_price_usdt=native_price_usdt,
        native_price_source=native_price_source,
        chain_id=chain_id,
        rpc_url=rpc_url,
    )


def _unavailable_fee_estimate(
    *,
    min_fee: Decimal,
    buffer: Decimal,
    reason: str,
    native_symbol: str = "",
    rpc_url: str = "",
    chain_id: Optional[int] = None,
) -> WithdrawFeeEstimate:
    logger.warning("[withdraw-fee] unavailable reason=%s native=%s chain_id=%s", reason, native_symbol, chain_id)
    return WithdrawFeeEstimate(
        fee=Decimal("0"),
        fee_source="UNAVAILABLE",
        raw_fee_usdt=None,
        min_fee=min_fee,
        buffer=buffer,
        fallback_reason=reason,
        native_symbol=native_symbol,
        chain_id=chain_id,
        rpc_url=rpc_url,
    )


def _effective_gas_price_wei(w3: Any, is_eip1559: bool) -> int:
    if is_eip1559:
        try:
            block = w3.eth.get_block("latest")
            base_fee = int(block.get("baseFeePerGas") or 0)
            priority_fee = int(getattr(w3.eth, "max_priority_fee"))
            if base_fee > 0 and priority_fee >= 0:
                return base_fee + priority_fee
        except Exception as exc:
            logger.debug("[withdraw-fee] eip1559 gas price unavailable, fallback gas_price error=%s", exc)
    return int(w3.eth.gas_price)


def _make_fee_web3(rpc_url: str) -> Any:
    from app.services.rpc_no_proxy import build_web3_no_proxy

    return build_web3_no_proxy(rpc_url, timeout=10)


def _fee_rpc_success_key(chain_key: str) -> str:
    return f"withdraw_fee_rpc:last_success:{str(chain_key or '').strip().lower()}"


def _fee_rpc_cooldown_key(chain_key: str, rpc_url: str) -> str:
    digest = hashlib.sha256(str(rpc_url or "").strip().encode("utf-8")).hexdigest()[:16]
    return f"withdraw_fee_rpc:cooldown:{str(chain_key or '').strip().lower()}:{digest}"


def _redis_get_json(key: str) -> Dict[str, Any]:
    try:
        raw = get_redis().get(key)
        if not raw:
            return {}
        if isinstance(raw, bytes):
            raw = raw.decode("utf-8", errors="ignore")
        value = json.loads(str(raw))
        return value if isinstance(value, dict) else {}
    except Exception as exc:
        logger.debug("[withdraw-fee-rpc] redis get failed key=%s error=%s", key, exc)
        return {}


def _redis_set_json(key: str, payload: Dict[str, Any], ttl_seconds: int = 7 * 24 * 3600) -> None:
    try:
        get_redis().set(key, json.dumps(payload, ensure_ascii=False, default=str), ex=ttl_seconds)
    except Exception as exc:
        logger.debug("[withdraw-fee-rpc] redis set failed key=%s error=%s", key, exc)


def _is_fee_rpc_cooling(chain_key: str, rpc_url: str) -> bool:
    try:
        return bool(get_redis().exists(_fee_rpc_cooldown_key(chain_key, rpc_url)))
    except Exception as exc:
        logger.debug("[withdraw-fee-rpc] cooldown check failed chain=%s rpc=%s error=%s", chain_key, rpc_url, exc)
        return False


def _mark_fee_rpc_failed(chain_key: str, rpc_url: str, reason: str) -> None:
    cooldown = max(60, WITHDRAW_FEE_RPC_COOLDOWN_SECONDS)
    try:
        get_redis().set(
            _fee_rpc_cooldown_key(chain_key, rpc_url),
            str(reason or "failed")[:200],
            ex=cooldown,
        )
    except Exception as exc:
        logger.debug("[withdraw-fee-rpc] cooldown set failed chain=%s rpc=%s error=%s", chain_key, rpc_url, exc)
    logger.warning(
        "[withdraw-fee-rpc] failed_rpc chain=%s failed_rpc=%s cooldown=%ss reason=%s",
        chain_key,
        rpc_url,
        cooldown,
        reason,
    )


def _mark_fee_rpc_success(chain_key: str, rpc_url: str) -> None:
    payload = {"rpc_url": rpc_url, "last_success_at": _now().isoformat()}
    _redis_set_json(_fee_rpc_success_key(chain_key), payload)
    logger.debug("[withdraw-fee-rpc] success_rpc chain=%s success_rpc=%s", chain_key, rpc_url)


def _ordered_fee_rpc_urls(chain_key: str, rpc_urls: Tuple[str, ...]) -> Tuple[str, ...]:
    urls = [str(item or "").strip() for item in (rpc_urls or ()) if str(item or "").strip()]
    if not urls:
        return tuple()

    success = str(_redis_get_json(_fee_rpc_success_key(chain_key)).get("rpc_url") or "").strip()
    ordered: list[str] = []
    if success and success in urls:
        ordered.append(success)

    active = [url for url in urls if url not in ordered and not _is_fee_rpc_cooling(chain_key, url)]
    cooling = [url for url in urls if url not in ordered and url not in active]
    ordered.extend(active)
    ordered.extend(cooling)
    logger.debug(
        "[withdraw-fee-rpc] selected_rpc_order chain=%s selected_rpc=%s last_success_rpc=%s cooling_count=%s",
        chain_key,
        ordered[0] if ordered else "",
        success or "",
        len(cooling),
    )
    return tuple(ordered)


def _estimate_erc20_gas_limit(
    *,
    w3: Any,
    contract_address: str,
    from_address: str,
    to_address: str,
    decimals: int,
) -> Tuple[int, str]:
    token = w3.eth.contract(address=w3.to_checksum_address(contract_address), abi=_ERC20_ABI)
    to_checksum = w3.to_checksum_address(to_address)
    from_checksum = w3.to_checksum_address(from_address)
    amount_int = max(1, int(os.getenv("WITHDRAW_FEE_ESTIMATE_TOKEN_UNITS", "1")))
    try:
        return int(token.functions.transfer(to_checksum, amount_int).estimate_gas({"from": from_checksum})), "ESTIMATE_GAS"
    except Exception as exc:
        gas_limit = int(os.getenv("WITHDRAW_ERC20_GAS_LIMIT", "65000"))
        logger.warning("[withdraw-fee] erc20 estimate_gas failed, fallback gas_limit=%s error=%s", gas_limit, exc)
        return gas_limit, "DEFAULT_ERC20_GAS_LIMIT"


def estimate_fee_usdt_detail(db: Session, symbol: str, chain_key: str, amount: Optional[Decimal] = None) -> WithdrawFeeEstimate:
    min_fee = Decimal(os.getenv("WITHDRAW_MIN_FEE", "0.005"))
    buffer = Decimal(os.getenv("WITHDRAW_FEE_BUFFER", "1.3"))

    cfg = _get_runtime_chain_config_safe(db, chain_key)
    native_symbol = str(getattr(cfg, "native_symbol", "") or "")
    rpc = str(getattr(cfg, "rpc_url", "") or "")
    rpc_urls = tuple(getattr(cfg, "rpc_urls", ()) or ())
    chain_id = int(getattr(cfg, "chain_id", 0) or 0) if cfg else None
    chain_family = str(get_chain_capability(chain_key).get("chain_family") or "").upper()

    if Web3 is None:
        return _fallback_fee_estimate(min_fee=min_fee, buffer=buffer, reason="web3 is not installed", native_symbol=native_symbol, rpc_url=rpc, chain_id=chain_id)
    if chain_family != EVM:
        return _unavailable_fee_estimate(
            min_fee=min_fee,
            buffer=buffer,
            reason=f"dynamic fee estimator only supports EVM chains, current family={chain_family or 'UNKNOWN'}",
            native_symbol=native_symbol,
            rpc_url=rpc,
            chain_id=chain_id,
        )
    if cfg is None:
        return _fallback_fee_estimate(min_fee=min_fee, buffer=buffer, reason="runtime chain config unavailable", native_symbol=native_symbol, rpc_url=rpc, chain_id=chain_id)
    if not rpc_urls:
        return _fallback_fee_estimate(min_fee=min_fee, buffer=buffer, reason="rpc url is empty", native_symbol=native_symbol, rpc_url=rpc, chain_id=chain_id)
    if not native_symbol:
        return _fallback_fee_estimate(min_fee=min_fee, buffer=buffer, reason="native_symbol is empty", native_symbol=native_symbol, rpc_url=rpc, chain_id=chain_id)

    price_result = get_native_token_usdt_price(native_symbol)
    price = price_result.price
    if price is None:
        return _fallback_fee_estimate(
            min_fee=min_fee,
            buffer=buffer,
            reason=f"native price unavailable: {price_result.fallback_reason}",
            native_symbol=native_symbol,
            rpc_url=rpc,
            chain_id=chain_id,
        )

    contract_address, decimals = _load_asset_chain(db, symbol, chain_key)
    if not contract_address:
        return _fallback_fee_estimate(min_fee=min_fee, buffer=buffer, reason="asset chain contract is empty", native_symbol=native_symbol, rpc_url=rpc, chain_id=chain_id)

    ordered_rpc_urls = _ordered_fee_rpc_urls(chain_key, rpc_urls)
    last_reason = ""
    last_rpc = rpc
    for index, candidate_rpc in enumerate(ordered_rpc_urls):
        last_rpc = candidate_rpc
        try:
            if index > 0:
                logger.debug("[withdraw-fee-rpc] fallback_rpc chain=%s fallback_rpc=%s", chain_key, candidate_rpc)
            logger.debug("[withdraw-fee-rpc] selected_rpc chain=%s selected_rpc=%s", chain_key, candidate_rpc)
            w3 = _make_fee_web3(candidate_rpc)
            if not w3.is_connected():
                last_reason = "rpc not connected"
                logger.warning("[withdraw-fee] rpc not connected chain=%s rpc=%s", chain_key, candidate_rpc)
                _mark_fee_rpc_failed(chain_key, candidate_rpc, last_reason)
                continue

            rpc_chain_id = int(w3.eth.chain_id)
            if chain_id and rpc_chain_id != chain_id:
                last_reason = f"rpc chain_id mismatch expected={chain_id} actual={rpc_chain_id}"
                logger.warning("[withdraw-fee] %s rpc=%s", last_reason, candidate_rpc)
                _mark_fee_rpc_failed(chain_key, candidate_rpc, last_reason)
                continue

            gas_price_wei = _effective_gas_price_wei(w3, bool(getattr(cfg, "is_eip1559", False)))
            dummy_from = _estimate_dummy_from_address(db, chain_key)
            dummy_to = "0x2000000000000000000000000000000000000002"
            gas_limit, gas_limit_source = _estimate_erc20_gas_limit(
                w3=w3,
                contract_address=contract_address,
                from_address=dummy_from,
                to_address=dummy_to,
                decimals=decimals,
            )

            fee_native = (Decimal(gas_price_wei) * Decimal(gas_limit)) / Decimal(10**18)
            raw_fee_usdt = (fee_native * price * buffer).quantize(Decimal("0.000001"), rounding=ROUND_HALF_UP)
            fee_source = "DYNAMIC" if raw_fee_usdt >= min_fee else "MIN_FEE"
            final_fee = raw_fee_usdt if raw_fee_usdt >= min_fee else min_fee
            if fee_source == "MIN_FEE":
                logger.debug(
                    "[withdraw-fee] dynamic success below min chain=%s symbol=%s raw_fee=%s min_fee=%s gas_limit=%s gas_price=%s native=%s price=%s source=%s rpc=%s",
                    chain_key,
                    symbol,
                    raw_fee_usdt,
                    min_fee,
                    gas_limit,
                    gas_price_wei,
                    native_symbol,
                    price,
                    price_result.source,
                    candidate_rpc,
                )
            else:
                logger.debug(
                    "[withdraw-fee] dynamic success chain=%s symbol=%s fee=%s gas_limit=%s gas_price=%s native=%s price=%s source=%s rpc=%s",
                    chain_key,
                    symbol,
                    final_fee,
                    gas_limit,
                    gas_price_wei,
                    native_symbol,
                    price,
                    price_result.source,
                    candidate_rpc,
                )
            _mark_fee_rpc_success(chain_key, candidate_rpc)
            return WithdrawFeeEstimate(
                fee=final_fee,
                fee_source=fee_source,
                raw_fee_usdt=raw_fee_usdt,
                min_fee=min_fee,
                buffer=buffer,
                native_symbol=native_symbol,
                native_price_usdt=price,
                native_price_source=price_result.source,
                gas_limit=gas_limit,
                gas_limit_source=gas_limit_source,
                gas_price_wei=gas_price_wei,
                chain_id=chain_id,
                rpc_url=candidate_rpc,
            )
        except Exception as exc:
            last_reason = str(exc) or exc.__class__.__name__
            logger.warning("[withdraw-fee] dynamic estimate failed chain=%s symbol=%s rpc=%s error=%s", chain_key, symbol, candidate_rpc, exc)
            _mark_fee_rpc_failed(chain_key, candidate_rpc, last_reason)

    return _fallback_fee_estimate(
        min_fee=min_fee,
        buffer=buffer,
        reason=last_reason or "all rpc urls failed",
        native_symbol=native_symbol,
        native_price_usdt=price,
        native_price_source=price_result.source,
        rpc_url=last_rpc,
        chain_id=chain_id,
    )


def estimate_fee_usdt(db: Session, symbol: str, chain_key: str, amount: Optional[Decimal] = None) -> Decimal:
    return estimate_fee_usdt_detail(db, symbol, chain_key, amount).fee


# =========================
# Internal: settle helpers (核心修复)
# =========================
def _has_balance_log(db: Session, uid: int, sym: str, ck: str, change_type: str, wid: int) -> bool:
    r = db.execute(
        text(
            """
            SELECT id
            FROM balance_logs
            WHERE user_id=:uid AND coin_symbol=:sym AND chain_key=:ck
              AND change_type=:ct
              AND biz_type='WITHDRAW'
              AND biz_id=:biz
            LIMIT 1
            """
        ),
        {"uid": uid, "sym": sym, "ck": ck, "ct": change_type, "biz": str(wid)},
    ).mappings().first()
    return bool(r)


def _lock_funding_balance(db: Session, uid: int, sym: str):
    return db.execute(
        text(
            """
            SELECT id, available_amount, frozen_amount
            FROM user_balances
            WHERE user_id=:uid AND coin_symbol=:sym AND chain_key=:ck
            FOR UPDATE
            """
        ),
        {"uid": uid, "sym": sym, "ck": WITHDRAW_BALANCE_ACCOUNT_KEY},
    ).mappings().first()


def _get_funding_available(db: Session, uid: int, sym: str) -> Optional[Decimal]:
    row = db.execute(
        text(
            """
            SELECT available_amount
            FROM user_balances
            WHERE user_id=:uid AND coin_symbol=:sym AND chain_key=:ck
            LIMIT 1
            """
        ),
        {"uid": uid, "sym": sym, "ck": WITHDRAW_BALANCE_ACCOUNT_KEY},
    ).mappings().first()
    if not row:
        return None
    return _ensure_decimal(row["available_amount"])


def _apply_funding_balance_change(
    db: Session,
    *,
    uid: int,
    sym: str,
    amount: Decimal,
    change_type: str,
    operation: str,
    wid: int,
    trace_id: Optional[str],
    remark: str,
    now: datetime,
) -> None:
    if amount <= 0:
        return
    if _has_balance_log(db, uid, sym, WITHDRAW_BALANCE_ACCOUNT_KEY, change_type, wid):
        return

    bal = _lock_funding_balance(db, uid, sym)
    if not bal:
        db.rollback()
        _err("INTERNAL_ERROR", f"funding balance row missing uid={uid} sym={sym}", trace_id, http_status=500)

    before_avail = _ensure_decimal(bal["available_amount"])
    before_frozen = _ensure_decimal(bal["frozen_amount"])

    if operation == "freeze":
        if before_avail < amount:
            db.rollback()
            if sym == WITHDRAW_FEE_COIN:
                _err("INSUFFICIENT_BALANCE", "USDT 资金账户余额不足，无法支付提现网络手续费", trace_id, http_status=400)
            _err("INSUFFICIENT_BALANCE", f"{sym} 资金账户余额不足", trace_id, http_status=400)
        after_avail = before_avail - amount
        after_frozen = before_frozen + amount
        direction = -1
    elif operation == "release":
        if before_frozen < amount:
            db.rollback()
            _err("INTERNAL_ERROR", f"{sym} frozen balance not enough", trace_id, http_status=500)
        after_avail = before_avail + amount
        after_frozen = before_frozen - amount
        direction = 1
    elif operation == "spend":
        if before_frozen < amount:
            db.rollback()
            _err("INTERNAL_ERROR", f"{sym} frozen balance not enough", trace_id, http_status=500)
        after_avail = before_avail
        after_frozen = before_frozen - amount
        direction = -1
    else:
        db.rollback()
        _err("INTERNAL_ERROR", f"unsupported funding balance operation {operation}", trace_id, http_status=500)

    res = db.execute(
        text(
            """
            UPDATE user_balances
            SET available_amount=:a_avail,
                frozen_amount=:a_frozen,
                version=version+1,
                updated_at=:now
            WHERE id=:id
            """
        ),
        {"a_avail": after_avail, "a_frozen": after_frozen, "now": now, "id": bal["id"]},
    )
    if res.rowcount != 1:
        db.rollback()
        _err("INTERNAL_ERROR", "update user_balances failed (rowcount!=1)", trace_id, http_status=500)

    db.execute(
        text(
            """
            INSERT INTO balance_logs
              (user_id, coin_symbol, chain_key,
               change_type, direction, change_amount,
               before_available, after_available,
               before_frozen, after_frozen,
               biz_type, biz_id, request_id, remark, created_at)
            VALUES
              (:uid, :sym, :ck,
               :ct, :direction, :amt,
               :b_avail, :a_avail,
               :b_frozen, :a_frozen,
               'WITHDRAW', :biz_id, NULL, :remark, :now)
            """
        ),
        {
            "uid": uid,
            "sym": sym,
            "ck": WITHDRAW_BALANCE_ACCOUNT_KEY,
            "ct": change_type,
            "direction": direction,
            "amt": amount,
            "b_avail": before_avail,
            "a_avail": after_avail,
            "b_frozen": before_frozen,
            "a_frozen": after_frozen,
            "biz_id": str(wid),
            "remark": remark,
            "now": now,
        },
    )


def _apply_withdraw_principal_and_fee(
    db: Session,
    *,
    uid: int,
    sym: str,
    amount: Decimal,
    fee: Decimal,
    operation: str,
    principal_change_type: str,
    fee_change_type: str,
    wid: int,
    trace_id: Optional[str],
    remark_prefix: str,
    now: datetime,
) -> None:
    _apply_funding_balance_change(
        db,
        uid=uid,
        sym=sym,
        amount=amount,
        change_type=principal_change_type,
        operation=operation,
        wid=wid,
        trace_id=trace_id,
        remark=f"{remark_prefix} principal amount={amount} fee_coin={WITHDRAW_FEE_COIN}",
        now=now,
    )
    _apply_funding_balance_change(
        db,
        uid=uid,
        sym=WITHDRAW_FEE_COIN,
        amount=fee,
        change_type=fee_change_type,
        operation=operation,
        wid=wid,
        trace_id=trace_id,
        remark=f"{remark_prefix} network_fee={fee} fee_coin={WITHDRAW_FEE_COIN}",
        now=now,
    )


def _settle_success(db: Session, wid: int, tx_hash: Optional[str], remark: Optional[str], trace_id: Optional[str]):
    """
    幂等：如果 withdraw_logs 已经 SUCCESS，但余额未扣冻，也会补做一次。
    以 balance_logs('WITHDRAW_SUCCESS') 作为“是否已结算”的判定。
    """
    now = _now()

    # 1) 锁提现单
    w = db.execute(
        text(
            """
            SELECT id, user_id, coin_symbol, chain_key, amount, fee, status, tx_hash
            FROM withdraw_logs
            WHERE id=:id
            FOR UPDATE
            """
        ),
        {"id": wid},
    ).mappings().first()
    if not w:
        _err("NOT_FOUND", "withdraw not found", trace_id, http_status=404)

    uid = int(w["user_id"])
    sym = str(w["coin_symbol"])
    network_chain_key = str(w["chain_key"])
    balance_account_key = WITHDRAW_BALANCE_ACCOUNT_KEY
    amount = _ensure_decimal(w["amount"])
    fee = _ensure_decimal(w.get("fee") or 0)
    debit_amount = amount + fee

    # 2) 已经结算过就直接返回（幂等）
    if _has_balance_log(db, uid, sym, balance_account_key, "WITHDRAW_SUCCESS", wid):
        # 顺手把 tx_hash 补上（如果需要）
        db.execute(
            text(
                """
                UPDATE withdraw_logs
                SET status='SUCCESS',
                    tx_hash=COALESCE(:tx_hash, tx_hash),
                    updated_at=:now
                WHERE id=:id
                """
            ),
            {"tx_hash": tx_hash, "now": now, "id": wid},
        )
        db.commit()
        return

    # 3) 锁余额行
    bal = db.execute(
        text(
            """
            SELECT id, available_amount, frozen_amount
            FROM user_balances
            WHERE user_id=:uid AND coin_symbol=:sym AND chain_key=:ck
            FOR UPDATE
            """
        ),
        {"uid": uid, "sym": sym, "ck": balance_account_key},
    ).mappings().first()
    if not bal:
        db.rollback()
        _err(
            "INTERNAL_ERROR",
            f"funding balance row missing uid={uid} sym={sym} network={network_chain_key}",
            trace_id,
            http_status=500,
        )

    before_avail = _ensure_decimal(bal["available_amount"])
    before_frozen = _ensure_decimal(bal["frozen_amount"])

    # ✅ 你当前模型：confirm 冻结的是 amount，因此这里成功只扣 amount 的 frozen
    if before_frozen < debit_amount:
        db.rollback()
        _err(
            "INTERNAL_ERROR",
            f"frozen balance not enough before_frozen={before_frozen} need={debit_amount}",
            trace_id,
            http_status=500,
        )

    after_avail = before_avail
    after_frozen = before_frozen - debit_amount

    # 4) 更新余额（必须命中 1 行）
    res1 = db.execute(
        text(
            """
            UPDATE user_balances
            SET available_amount=:a_avail,
                frozen_amount=:a_frozen,
                version=version+1,
                updated_at=:now
            WHERE id=:id
            """
        ),
        {"a_avail": after_avail, "a_frozen": after_frozen, "now": now, "id": bal["id"]},
    )
    if res1.rowcount != 1:
        db.rollback()
        _err("INTERNAL_ERROR", "update user_balances failed (rowcount!=1)", trace_id, http_status=500)

    # 5) 记流水（作为幂等锚点）
    db.execute(
        text(
            """
            INSERT INTO balance_logs
              (user_id, coin_symbol, chain_key,
               change_type, direction, change_amount,
               before_available, after_available,
               before_frozen, after_frozen,
               biz_type, biz_id, request_id, remark, created_at)
            VALUES
              (:uid, :sym, :ck,
               'WITHDRAW_SUCCESS', -1, :amt,
               :b_avail, :a_avail,
               :b_frozen, :a_frozen,
               'WITHDRAW', :biz_id, NULL, :remark, :now)
            """
        ),
        {
            "uid": uid,
            "sym": sym,
            "ck": balance_account_key,
            "amt": debit_amount,
            "b_avail": before_avail,
            "a_avail": after_avail,
            "b_frozen": before_frozen,
            "a_frozen": after_frozen,
            "biz_id": str(wid),
            "remark": remark or f"withdraw_success amount={amount} fee={fee}",
            "now": now,
        },
    )

    # 6) 更新提现单状态（允许从任何状态补到 SUCCESS）
    res2 = db.execute(
        text(
            """
            UPDATE withdraw_logs
            SET status='SUCCESS',
                tx_hash=COALESCE(:tx_hash, tx_hash),
                updated_at=:now
            WHERE id=:id
            """
        ),
        {"tx_hash": tx_hash, "now": now, "id": wid},
    )
    if res2.rowcount != 1:
        db.rollback()
        _err("INTERNAL_ERROR", "update withdraw_logs failed (rowcount!=1)", trace_id, http_status=500)

    db.commit()


def _settle_failed(db: Session, wid: int, remark: Optional[str], trace_id: Optional[str]):
    """
    幂等：以 balance_logs('WITHDRAW_UNFREEZE') 作为是否已退回的判定。
    """
    now = _now()

    w = db.execute(
        text(
            """
            SELECT id, user_id, coin_symbol, chain_key, amount, fee, status
            FROM withdraw_logs
            WHERE id=:id
            FOR UPDATE
            """
        ),
        {"id": wid},
    ).mappings().first()
    if not w:
        _err("NOT_FOUND", "withdraw not found", trace_id, http_status=404)

    uid = int(w["user_id"])
    sym = str(w["coin_symbol"])
    network_chain_key = str(w["chain_key"])
    balance_account_key = WITHDRAW_BALANCE_ACCOUNT_KEY
    amount = _ensure_decimal(w["amount"])
    fee = _ensure_decimal(w.get("fee") or 0)
    debit_amount = amount + fee

    if _has_balance_log(db, uid, sym, balance_account_key, "WITHDRAW_UNFREEZE", wid):
        db.execute(
            text(
                """
                UPDATE withdraw_logs
                SET status='FAILED',
                    updated_at=:now
                WHERE id=:id
                """
            ),
            {"now": now, "id": wid},
        )
        db.commit()
        return

    bal = db.execute(
        text(
            """
            SELECT id, available_amount, frozen_amount
            FROM user_balances
            WHERE user_id=:uid AND coin_symbol=:sym AND chain_key=:ck
            FOR UPDATE
            """
        ),
        {"uid": uid, "sym": sym, "ck": balance_account_key},
    ).mappings().first()
    if not bal:
        db.rollback()
        _err(
            "INTERNAL_ERROR",
            f"funding balance row missing uid={uid} sym={sym} network={network_chain_key}",
            trace_id,
            http_status=500,
        )

    before_avail = _ensure_decimal(bal["available_amount"])
    before_frozen = _ensure_decimal(bal["frozen_amount"])
    if before_frozen < debit_amount:
        db.rollback()
        _err("INTERNAL_ERROR", "frozen balance not enough", trace_id, http_status=500)

    after_avail = before_avail + debit_amount
    after_frozen = before_frozen - debit_amount

    res1 = db.execute(
        text(
            """
            UPDATE user_balances
            SET available_amount=:a_avail,
                frozen_amount=:a_frozen,
                version=version+1,
                updated_at=:now
            WHERE id=:id
            """
        ),
        {"a_avail": after_avail, "a_frozen": after_frozen, "now": now, "id": bal["id"]},
    )
    if res1.rowcount != 1:
        db.rollback()
        _err("INTERNAL_ERROR", "update user_balances failed (rowcount!=1)", trace_id, http_status=500)

    db.execute(
        text(
            """
            INSERT INTO balance_logs
              (user_id, coin_symbol, chain_key,
               change_type, direction, change_amount,
               before_available, after_available,
               before_frozen, after_frozen,
               biz_type, biz_id, request_id, remark, created_at)
            VALUES
              (:uid, :sym, :ck,
               'WITHDRAW_UNFREEZE', 1, :amt,
               :b_avail, :a_avail,
               :b_frozen, :a_frozen,
               'WITHDRAW', :biz_id, NULL, :remark, :now)
            """
        ),
        {
            "uid": uid,
            "sym": sym,
            "ck": balance_account_key,
            "amt": debit_amount,
            "b_avail": before_avail,
            "a_avail": after_avail,
            "b_frozen": before_frozen,
            "a_frozen": after_frozen,
            "biz_id": str(wid),
            "remark": remark or f"withdraw_unfreeze amount={amount} fee={fee}",
            "now": now,
        },
    )

    res2 = db.execute(
        text(
            """
            UPDATE withdraw_logs
            SET status='FAILED',
                updated_at=:now
            WHERE id=:id
            """
        ),
        {"now": now, "id": wid},
    )
    if res2.rowcount != 1:
        db.rollback()
        _err("INTERNAL_ERROR", "update withdraw_logs failed (rowcount!=1)", trace_id, http_status=500)

    db.commit()


def _settle_success(db: Session, wid: int, tx_hash: Optional[str], remark: Optional[str], trace_id: Optional[str]):
    now = _now()
    w = db.execute(
        text(
            """
            SELECT id, user_id, coin_symbol, chain_key, amount, fee, status, tx_hash
            FROM withdraw_logs
            WHERE id=:id
            FOR UPDATE
            """
        ),
        {"id": wid},
    ).mappings().first()
    if not w:
        _err("NOT_FOUND", "withdraw not found", trace_id, http_status=404)

    uid = int(w["user_id"])
    sym = str(w["coin_symbol"]).strip().upper()
    amount = _ensure_decimal(w["amount"])
    fee = _ensure_decimal(w.get("fee") or 0)

    _apply_withdraw_principal_and_fee(
        db,
        uid=uid,
        sym=sym,
        amount=amount,
        fee=fee,
        operation="spend",
        principal_change_type="WITHDRAW_SUCCESS",
        fee_change_type="WITHDRAW_FEE_SUCCESS",
        wid=wid,
        trace_id=trace_id,
        remark_prefix=remark or "withdraw_success",
        now=now,
    )

    res = db.execute(
        text(
            """
            UPDATE withdraw_logs
            SET status='SUCCESS',
                tx_hash=COALESCE(:tx_hash, tx_hash),
                updated_at=:now
            WHERE id=:id
            """
        ),
        {"tx_hash": tx_hash, "now": now, "id": wid},
    )
    if res.rowcount != 1:
        db.rollback()
        _err("INTERNAL_ERROR", "update withdraw_logs failed (rowcount!=1)", trace_id, http_status=500)
    db.commit()


def _settle_failed(db: Session, wid: int, remark: Optional[str], trace_id: Optional[str]):
    now = _now()
    w = db.execute(
        text(
            """
            SELECT id, user_id, coin_symbol, chain_key, amount, fee, status
            FROM withdraw_logs
            WHERE id=:id
            FOR UPDATE
            """
        ),
        {"id": wid},
    ).mappings().first()
    if not w:
        _err("NOT_FOUND", "withdraw not found", trace_id, http_status=404)

    uid = int(w["user_id"])
    sym = str(w["coin_symbol"]).strip().upper()
    amount = _ensure_decimal(w["amount"])
    fee = _ensure_decimal(w.get("fee") or 0)

    _apply_withdraw_principal_and_fee(
        db,
        uid=uid,
        sym=sym,
        amount=amount,
        fee=fee,
        operation="release",
        principal_change_type="WITHDRAW_UNFREEZE",
        fee_change_type="WITHDRAW_FEE_UNFREEZE",
        wid=wid,
        trace_id=trace_id,
        remark_prefix=remark or "withdraw_unfreeze",
        now=now,
    )

    res = db.execute(
        text(
            """
            UPDATE withdraw_logs
            SET status='FAILED',
                updated_at=:now
            WHERE id=:id
            """
        ),
        {"now": now, "id": wid},
    )
    if res.rowcount != 1:
        db.rollback()
        _err("INTERNAL_ERROR", "update withdraw_logs failed (rowcount!=1)", trace_id, http_status=500)
    db.commit()


# =========================
# Step1: Fee (estimate / final confirm)
# =========================
@router.get("/withdraw/fee", summary="Estimate Withdraw Fee (Step1/Step2)")
def get_withdraw_fee(
    request: Request,
    symbol: str,
    network: str,
    amount: Decimal,
    to_address: Optional[str] = None,
    db: Session = Depends(get_db),
    user_id: int = Depends(get_current_user_id),
):
    trace_id = getattr(request.state, "trace_id", None)

    sym = (symbol or "").strip().upper()
    ck = _normalize_chain_key(network)
    amt = _ensure_decimal(amount)
    if amt <= 0:
        _err("BAD_REQUEST", "amount must be > 0", trace_id)
    if not is_chain_withdraw_supported(ck):
        _err("NOT_SUPPORTED", "asset/chain not supported or withdraw disabled", trace_id)

    fee_config = get_configured_withdraw_fee(db, sym, ck)
    if fee_config is None:
        _err("NOT_SUPPORTED", "asset/chain not supported or withdraw disabled", trace_id)
    fee = fee_config.fee
    net = amt
    total_deduct_amount = amt
    total_fee_usdt = fee
    total_debit = amt + fee if sym == WITHDRAW_FEE_COIN else amt

    fee_debug = fee_config.api_debug()
    return _ok(
        {
            "symbol": sym,
            "chain_key": ck,
            "amount": _q6(amt),
            "fee": _q_withdraw_fee(fee),
            "fee_coin": WITHDRAW_FEE_COIN,
            "fee_currency": WITHDRAW_FEE_COIN,
            "receive_amount": _q6(net),
            "net_amount": _q6(net),
            "total_deduct_amount": _q6(total_deduct_amount),
            "total_fee_usdt": _q_withdraw_fee(total_fee_usdt),
            "total_debit": _q6(total_debit),
            **fee_debug,
        },
        trace_id,
    )


# =========================
# Step1: Create draft withdraw (NO code sent)
# =========================
@router.post("/withdraw/create", summary="Create Withdraw Draft (Step1 -> Step2)")
def create_withdraw_draft(
    request: Request,
    payload: WithdrawCreateIn = Body(...),
    db: Session = Depends(get_db),
    user_id: int = Depends(get_current_user_id),
):
    trace_id = getattr(request.state, "trace_id", None)
    assert_user_withdraw_unlocked(db, user_id)

    sym = payload.symbol.strip().upper()
    ck = _normalize_chain_key(payload.network)
    to_addr = payload.to_address.strip()
    amt = _ensure_decimal(payload.amount)

    if amt <= 0:
        _err("BAD_REQUEST", "amount must be > 0", trace_id)
    if not is_chain_withdraw_supported(ck):
        _err("NOT_SUPPORTED", "asset/chain not supported or withdraw disabled", trace_id)
    if _is_platform_system_address(db, ck, to_addr):
        _err("BAD_REQUEST", "不能提现到平台系统地址，请填写外部收款地址", trace_id)

    asset_chain_config = _load_withdraw_asset_chain_config(db, sym, ck)
    if not asset_chain_config or asset_chain_config.get("contract_address") is None:
        _err("NOT_SUPPORTED", "asset/chain not supported or withdraw disabled", trace_id)
    min_withdraw = _ensure_decimal(asset_chain_config.get("min_withdraw") or 0)
    if min_withdraw > 0 and amt < min_withdraw:
        _err("BAD_REQUEST", f"amount must be >= min withdraw {min_withdraw}", trace_id)

    # User withdrawable balance is held in funding; ck remains the payout network.
    bal = db.execute(
        text(
            """
            SELECT available_amount, frozen_amount
            FROM user_balances
            WHERE user_id=:uid AND coin_symbol=:sym AND chain_key=:ck
            LIMIT 1
            """
        ),
        {"uid": user_id, "sym": sym, "ck": WITHDRAW_BALANCE_ACCOUNT_KEY},
    ).mappings().first()

    if not bal:
        _err("INSUFFICIENT_BALANCE", "no funding balance row for this asset", trace_id)

    fee_config = get_configured_withdraw_fee(db, sym, ck)
    if fee_config is None:
        _err("NOT_SUPPORTED", "asset/chain not supported or withdraw disabled", trace_id)
    fee = fee_config.fee
    net = amt
    total_deduct_amount = amt
    total_fee_usdt = fee
    total_debit = amt + fee if sym == WITHDRAW_FEE_COIN else amt

    available = _ensure_decimal(bal["available_amount"])
    if sym == WITHDRAW_FEE_COIN:
        if available < amt + fee:
            _err("INSUFFICIENT_BALANCE", "USDT 资金账户余额不足，需要覆盖提现本金和网络手续费", trace_id)
    else:
        if available < amt:
            _err("INSUFFICIENT_BALANCE", f"{sym} 资金账户余额不足", trace_id)
        usdt_available = _get_funding_available(db, user_id, WITHDRAW_FEE_COIN)
        if fee > 0 and (usdt_available is None or usdt_available < fee):
            _err("INSUFFICIENT_BALANCE", "USDT 资金账户余额不足，无法支付网络手续费", trace_id)

    risk = check_withdraw_risk(
        db=db,
        user_id=user_id,
        coin_symbol=sym,
        chain_key=ck,
        daily_withdraw_count_limit=asset_chain_config.get("daily_withdraw_count_limit"),
    )
    review_threshold_amount = _ensure_decimal(asset_chain_config.get("review_threshold_amount") or 0)
    force_manual_review = bool(int(asset_chain_config.get("force_manual_review") or 0))
    threshold_review = review_threshold_amount > 0 and amt >= review_threshold_amount

    review_reasons: List[str] = []
    if force_manual_review:
        review_reasons.append("force_manual_review")
    if threshold_review:
        review_reasons.append("amount_threshold")
    if risk.get("need_manual_review"):
        review_reasons.append(str(risk.get("reason") or "daily_count_limit"))

    need_manual_review = bool(review_reasons)
    status = WITHDRAW_REVIEWING_STATUS if need_manual_review else WITHDRAW_VERIFYING_STATUS
    risk_reason = ",".join(dict.fromkeys(reason for reason in review_reasons if reason and reason != "ok"))
    reason_column = _get_withdraw_log_risk_reason_column(db) if need_manual_review else None

    if need_manual_review:
        print(
            "[withdraw-risk] manual review required",
            f"trace_id={trace_id}",
            f"user_id={user_id}",
            f"symbol={sym}",
            f"chain_key={ck}",
            f"amount={amt}",
            f"reason={risk_reason}",
            f"force_manual_review={force_manual_review}",
            f"review_threshold_amount={review_threshold_amount}",
            f"daily_count={risk.get('daily_count')}",
            f"daily_withdraw_count_limit={risk.get('daily_withdraw_count_limit')}",
        )
        if reason_column is None:
            print(
                "[withdraw-risk] no reason column on withdraw_logs; reason logged only",
                f"trace_id={trace_id}",
                f"user_id={user_id}",
                f"reason={risk_reason}",
            )

    now = _now()
    reason_column_sql = f", {reason_column}" if reason_column else ""
    reason_value_sql = ", :risk_reason" if reason_column else ""

    db.execute(
        text(
            f"""
            INSERT INTO withdraw_logs
              (user_id, coin_symbol, chain_key, to_address,
               amount, fee, fee_coin, net_amount,
               status, tx_hash,
               verify_code_hash, verify_expires_at,
               created_at, updated_at{reason_column_sql})
            VALUES
              (:uid, :sym, :ck, :to_addr,
               :amt, :fee, :fee_coin, :net,
               :status, NULL,
               NULL, NULL,
               :now, :now{reason_value_sql})
            """
        ),
        {
            "uid": user_id,
            "sym": sym,
            "ck": ck,
            "to_addr": to_addr,
            "amt": amt,
            "fee": fee,
            "fee_coin": WITHDRAW_FEE_COIN,
            "net": net,
            "status": status,
            "risk_reason": f"withdraw_risk:{risk_reason}"[:255],
            "now": now,
        },
    )
    withdraw_id = db.execute(text("SELECT LAST_INSERT_ID() AS id")).mappings().first()["id"]
    db.commit()

    return _ok(
        {
            "withdraw_id": int(withdraw_id),
            "symbol": sym,
            "chain_key": ck,
            "to_address": to_addr,
            "amount": _q6(amt),
            "fee_estimate": _q_withdraw_fee(fee),
            "fee_coin": WITHDRAW_FEE_COIN,
            "fee_currency": WITHDRAW_FEE_COIN,
            "receive_amount": _q6(net),
            "net_amount_estimate": _q6(net),
            "total_deduct_amount": _q6(total_deduct_amount),
            "total_fee_usdt": _q_withdraw_fee(total_fee_usdt),
            "total_debit_estimate": _q6(total_debit),
            "fee_source": fee_config.source,
            "raw_fee_usdt": _q6(fee_config.last_estimated_cost) if fee_config.last_estimated_cost is not None else None,
            "fallback_reason": fee_config.last_error,
            "status": status,
            "need_manual_review": need_manual_review,
            "risk_reason": risk_reason if need_manual_review else "",
        },
        trace_id,
    )


# =========================
# Step2: Send email code (user click)
# =========================
@router.post("/withdraw/send_code", summary="Send Withdraw Code (Step2)")
def send_withdraw_code(
    request: Request,
    payload: WithdrawSendCodeIn = Body(...),
    db: Session = Depends(get_db),
    user_id: int = Depends(get_current_user_id),
):
    trace_id = getattr(request.state, "trace_id", None)
    assert_user_withdraw_unlocked(db, user_id)
    wid = int(payload.withdraw_id)

    w = db.execute(
        text(
            """
            SELECT id, coin_symbol, chain_key, status,
                   verify_expires_at
            FROM withdraw_logs
            WHERE id=:id AND user_id=:uid
            LIMIT 1
            """
        ),
        {"id": wid, "uid": user_id},
    ).mappings().first()

    if not w:
        return _err("NOT_FOUND", "withdraw not found", trace_id, http_status=404)

    if w["status"] != "VERIFYING":
        return _err(
            "BAD_STATE",
            f"withdraw status is {w['status']}, cannot send code",
            trace_id,
            http_status=400,
        )

    exp = w.get("verify_expires_at")
    if exp and isinstance(exp, datetime) and _now() < exp:
        return _ok({"withdraw_id": wid, "status": "VERIFYING", "hint": "code already sent"}, trace_id)

    u = db.execute(text("SELECT email FROM users WHERE id=:uid LIMIT 1"), {"uid": user_id}).mappings().first()
    if not u or not u.get("email"):
        return _err("NO_EMAIL", "user email not set", trace_id, http_status=400)

    to_email = str(u["email"]).strip()

    code = _gen_email_code()
    expires_at = _now() + timedelta(minutes=10)
    salt = f"{user_id}|{w['coin_symbol']}|{w['chain_key']}"
    code_hash = _hash_code(code, salt)

    try:
        res = db.execute(
            text(
                """
                UPDATE withdraw_logs
                SET verify_code_hash=:h,
                    verify_expires_at=:exp,
                    updated_at=:now
                WHERE id=:id AND user_id=:uid AND status='VERIFYING'
                """
            ),
            {"h": code_hash, "exp": expires_at, "now": _now(), "id": wid, "uid": user_id},
        )
        if res.rowcount != 1:
            db.rollback()
            return _err("BAD_STATE", "withdraw status changed, cannot persist code", trace_id, http_status=409)
        db.commit()
    except Exception:
        logger.exception(
            "withdraw_send_code_db_update_failed trace_id=%s user_id=%s withdraw_id=%s",
            trace_id,
            user_id,
            wid,
        )
        db.rollback()
        return _err("DB_ERROR", "failed to persist verify code", trace_id, http_status=500)

    try:
        from app.tasks.email_tasks import enqueue_send_verify_code_email

        enqueue_send_verify_code_email(to_email=to_email, code=code, scene="withdraw", expire_minutes=10)
    except Exception as e:
        logger.exception(
            "withdraw_send_code_email_enqueue_failed trace_id=%s user_id=%s withdraw_id=%s",
            trace_id,
            user_id,
            wid,
        )
        try:
            db.execute(
                text(
                    """
                    UPDATE withdraw_logs
                    SET verify_code_hash=NULL,
                        verify_expires_at=NULL,
                        updated_at=:now
                    WHERE id=:id AND user_id=:uid AND status='VERIFYING'
                    """
                ),
                {"now": _now(), "id": wid, "uid": user_id},
            )
            db.commit()
        except Exception as clear_exc:
            db.rollback()
            logger.exception(
                "withdraw_send_code_clear_failed trace_id=%s user_id=%s withdraw_id=%s error_type=%s",
                trace_id,
                user_id,
                wid,
                type(clear_exc).__name__,
            )
        return _err("EMAIL_SEND_FAILED", str(e), trace_id, http_status=500)

    logger.info(
        "withdraw_send_code_email_enqueued trace_id=%s user_id=%s withdraw_id=%s expires_at=%s",
        trace_id,
        user_id,
        wid,
        expires_at.isoformat(),
    )
    return _ok({"withdraw_id": wid, "status": "VERIFYING", "hint": "email code sent"}, trace_id)


# =========================
# Step2: Confirm (verify code + final fee + freeze)
# =========================
@router.post("/withdraw/confirm", summary="Confirm Withdraw (Step2)")
def confirm_withdraw(
    request: Request,
    payload: WithdrawConfirmIn = Body(...),
    db: Session = Depends(get_db),
    user_id: int = Depends(get_current_user_id),
):
    trace_id = getattr(request.state, "trace_id", None)
    assert_user_withdraw_unlocked(db, user_id)

    wid = int(payload.withdraw_id)
    code = (payload.code or "").strip()
    if len(code) < 4:
        return _err("BAD_REQUEST", "invalid code", trace_id, http_status=400)

    w = db.execute(
        text(
            """
            SELECT id, coin_symbol, chain_key, amount, status,
                   verify_code_hash, verify_expires_at
            FROM withdraw_logs
            WHERE id=:id AND user_id=:uid
            LIMIT 1
            """
        ),
        {"id": wid, "uid": user_id},
    ).mappings().first()

    if not w:
        return _err("NOT_FOUND", "withdraw not found", trace_id, http_status=404)

    if w["status"] != "VERIFYING":
        return _err("BAD_STATE", f"withdraw status is {w['status']}, cannot confirm", trace_id, http_status=400)

    exp = w.get("verify_expires_at")
    if not exp:
        return _err("CODE_REQUIRED", "please send code first", trace_id, http_status=400)
    if isinstance(exp, datetime) and _now() > exp:
        return _err("CODE_EXPIRED", "code expired", trace_id, http_status=400)

    symbol = w["coin_symbol"]
    chain_key = w["chain_key"]
    amount = _ensure_decimal(w["amount"])

    salt = f"{user_id}|{symbol}|{chain_key}"
    if _hash_code(code, salt) != (w.get("verify_code_hash") or ""):
        return _err("CODE_INVALID", "code incorrect", trace_id, http_status=400)

    fee_config = get_configured_withdraw_fee(db, symbol, chain_key)
    if fee_config is None:
        return _err("NOT_SUPPORTED", "asset/chain not supported or withdraw disabled", trace_id, http_status=400)
    fee = fee_config.fee
    net_amount = amount
    total_deduct_amount = amount
    total_fee_usdt = fee
    total_debit = amount + fee if str(symbol).strip().upper() == WITHDRAW_FEE_COIN else amount

    now = _now()
    _apply_withdraw_principal_and_fee(
        db,
        uid=user_id,
        sym=str(symbol).strip().upper(),
        amount=amount,
        fee=fee,
        operation="freeze",
        principal_change_type="WITHDRAW_FREEZE",
        fee_change_type="WITHDRAW_FEE_FREEZE",
        wid=wid,
        trace_id=trace_id,
        remark_prefix="withdraw_freeze",
        now=now,
    )

    res2 = db.execute(
        text(
            """
            UPDATE withdraw_logs
            SET status='FROZEN',
                fee=:fee,
                fee_coin=:fee_coin,
                net_amount=:net,
                verify_code_hash=NULL,
                verify_expires_at=NULL,
                updated_at=:now
            WHERE id=:id AND user_id=:uid AND status='VERIFYING'
            """
        ),
        {"fee": fee, "fee_coin": WITHDRAW_FEE_COIN, "net": net_amount, "now": now, "id": wid, "uid": user_id},
    )

    if res2.rowcount != 1:
        db.rollback()
        return _err("BAD_STATE", "withdraw already processed", trace_id, http_status=409)

    db.commit()

    return _ok(
        {
            "withdraw_id": wid,
            "symbol": symbol,
            "chain_key": chain_key,
            "amount": _q6(amount),
            "fee_final": _q_withdraw_fee(fee),
            "fee_coin": WITHDRAW_FEE_COIN,
            "fee_currency": WITHDRAW_FEE_COIN,
            "receive_amount": _q6(net_amount),
            "net_amount_final": _q6(net_amount),
            "total_deduct_amount": _q6(total_deduct_amount),
            "total_fee_usdt": _q_withdraw_fee(total_fee_usdt),
            "total_debit_final": _q6(total_debit),
            "fee_source": fee_config.source,
            "raw_fee_usdt": _q6(fee_config.last_estimated_cost) if fee_config.last_estimated_cost is not None else None,
            "fallback_reason": fee_config.last_error,
            "status": "FROZEN",
        },
        trace_id,
    )


# =========================
# Compatibility (旧接口保留)
# =========================
@router.post("/withdraw", summary="(Legacy) Request Withdraw (create + send code)")
def legacy_request_withdraw(
    request: Request,
    payload: WithdrawCreateIn = Body(...),
    db: Session = Depends(get_db),
    user_id: int = Depends(get_current_user_id),
):
    r1 = create_withdraw_draft(request, payload, db, user_id)  # type: ignore
    if r1["data"].get("status") == WITHDRAW_VERIFYING_STATUS:
        wid = r1["data"]["withdraw_id"]
        send_withdraw_code(request, WithdrawSendCodeIn(withdraw_id=wid), db, user_id)  # type: ignore
    return r1


@router.post("/withdraw/verify", summary="(Legacy) Verify Withdraw Code")
def legacy_verify_withdraw(
    request: Request,
    payload: WithdrawConfirmIn = Body(...),
    db: Session = Depends(get_db),
    user_id: int = Depends(get_current_user_id),
):
    return confirm_withdraw(request, payload, db, user_id)  # type: ignore


# =========================
# Mark success / failed (修复版：幂等 + 强校验)
# =========================
@router.post("/withdraw/cancel", summary="Cancel Withdraw")
def cancel_withdraw(
    request: Request,
    payload: WithdrawCancelIn = Body(...),
    db: Session = Depends(get_db),
    user_id: int = Depends(get_current_user_id),
):
    trace_id = getattr(request.state, "trace_id", None)
    wid = int(payload.withdraw_id)
    now = _now()

    w = db.execute(
        text(
            """
            SELECT id, user_id, coin_symbol, chain_key, amount, fee, status, tx_hash
            FROM withdraw_logs
            WHERE id=:id AND user_id=:uid
            FOR UPDATE
            """
        ),
        {"id": wid, "uid": user_id},
    ).mappings().first()

    if not w:
        _err("NOT_FOUND", "withdraw not found", trace_id, http_status=404)

    status = str(w["status"] or "").upper()
    if w.get("tx_hash"):
        db.rollback()
        _err("BAD_STATE", "withdraw already has tx_hash, cannot cancel", trace_id, http_status=400)

    if status not in {"REVIEWING", "VERIFYING", "FROZEN"}:
        db.rollback()
        _err("BAD_STATE", f"withdraw status is {status}, cannot cancel", trace_id, http_status=400)

    if status == "FROZEN":
        sym = str(w["coin_symbol"])
        amount = _ensure_decimal(w["amount"])
        fee = _ensure_decimal(w.get("fee") or 0)

        _apply_withdraw_principal_and_fee(
            db,
            uid=user_id,
            sym=sym.strip().upper(),
            amount=amount,
            fee=fee,
            operation="release",
            principal_change_type="WITHDRAW_CANCEL",
            fee_change_type="WITHDRAW_FEE_CANCEL",
            wid=wid,
            trace_id=trace_id,
            remark_prefix="withdraw_cancel",
            now=now,
        )

    res2 = db.execute(
        text(
            """
            UPDATE withdraw_logs
            SET status='CANCELED',
                verify_code_hash=CASE WHEN :status='VERIFYING' THEN NULL ELSE verify_code_hash END,
                verify_expires_at=CASE WHEN :status='VERIFYING' THEN NULL ELSE verify_expires_at END,
                updated_at=:now
            WHERE id=:id AND user_id=:uid AND status=:status
            """
        ),
        {"now": now, "id": wid, "uid": user_id, "status": status},
    )
    if res2.rowcount != 1:
        db.rollback()
        _err("BAD_STATE", "withdraw status changed, cannot cancel", trace_id, http_status=409)

    db.commit()
    return _ok({"withdraw_id": wid, "status": "CANCELED"}, trace_id)


@router.post("/withdraw/mark_success", summary="Mark Withdraw Success (settle frozen -> spent)")
def withdraw_mark_success(
    request: Request,
    payload: WithdrawMarkIn = Body(...),
    db: Session = Depends(get_db),
    user_id: int = Depends(get_current_user_id),
):
    trace_id = getattr(request.state, "trace_id", None)
    wid = int(payload.withdraw_id)

    # ✅ 允许你“已经 SUCCESS 但没解冻”的历史单子补结算
    _settle_success(db, wid, payload.tx_hash, payload.remark, trace_id)
    return _ok({"withdraw_id": wid, "status": "SUCCESS"}, trace_id)


@router.post("/withdraw/mark_failed", summary="Mark Withdraw Failed (unfreeze back to available)")
def withdraw_mark_failed(
    request: Request,
    payload: WithdrawMarkIn = Body(...),
    db: Session = Depends(get_db),
    user_id: int = Depends(get_current_user_id),
):
    trace_id = getattr(request.state, "trace_id", None)
    wid = int(payload.withdraw_id)

    _settle_failed(db, wid, payload.remark, trace_id)
    return _ok({"withdraw_id": wid, "status": "FAILED"}, trace_id)


# =========================
# List withdraws
# =========================
@router.get("/withdraws", summary="List Withdraws")
def list_withdraws(
    request: Request,
    db: Session = Depends(get_db),
    user_id: int = Depends(get_current_user_id),
    limit: int = 20,
    offset: int = 0,
):
    trace_id = getattr(request.state, "trace_id", None)
    limit = max(1, min(limit, 100))
    offset = max(0, offset)

    columns = _get_withdraw_log_columns(db)
    reason_expr = _withdraw_log_reason_expr(columns)
    fee_coin_expr = "fee_coin" if "fee_coin" in columns else f"'{WITHDRAW_FEE_COIN}' AS fee_coin"

    rows = db.execute(
        text(
            f"""
            SELECT id, coin_symbol, chain_key, to_address,
                   amount, fee, {fee_coin_expr}, net_amount,
                   status, tx_hash, {reason_expr}, created_at, updated_at
            FROM withdraw_logs
            WHERE user_id=:uid
            ORDER BY id DESC
            LIMIT :limit OFFSET :offset
            """
        ),
        {"uid": user_id, "limit": limit, "offset": offset},
    ).mappings().all()

    items: List[Dict[str, Any]] = []
    for r in rows:
        reason = str(r.get("withdraw_reason") or "").strip() or None
        amount = _ensure_decimal(r.get("amount") or "0")
        fee = _ensure_decimal(r.get("fee") or "0")
        total_deduct_amount = amount + fee
        items.append(
            {
                "withdraw_id": int(r["id"]),
                "symbol": r["coin_symbol"],
                "chain_key": r["chain_key"],
                "to_address": r["to_address"],
                "amount": str(r["amount"]),
                "fee": str(r["fee"]),
                "fee_coin": str(r.get("fee_coin") or WITHDRAW_FEE_COIN),
                "fee_currency": str(r.get("fee_coin") or WITHDRAW_FEE_COIN),
                "receive_amount": str(r["net_amount"]),
                "total_deduct_amount": str(total_deduct_amount),
                "total_fee_usdt": str(r["fee"]),
                "net_amount": str(r["net_amount"]),
                "status": r["status"],
                "tx_hash": r.get("tx_hash"),
                "fail_reason": reason,
                "reject_reason": reason,
                "reason": reason,
                "withdraw_type": "onchain",
                "transfer_type": "onchain",
                "created_at": (r.get("created_at").isoformat() if r.get("created_at") else None),
                "updated_at": (r.get("updated_at").isoformat() if r.get("updated_at") else None),
            }
        )

    return _ok({"items": items, "limit": limit, "offset": offset}, trace_id)
