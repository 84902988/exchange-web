# app/routers/webhook_moralis.py
from __future__ import annotations

import json
import logging
import os
import hashlib
from datetime import datetime
from decimal import Decimal, InvalidOperation
from typing import Any, Dict, Optional

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.db.session import SessionLocal
from app.services.moralis_signature import verify_signature
from app.services.balance import FUNDING_BALANCE_CHAIN_KEY, credit_available
from app.db.models.asset import Deposit
from app.db.models.stock_token_lock_config import StockTokenLockConfig
from app.services.stock_token_lock_service import (
    StockTokenLockError,
    create_stock_token_lock_from_deposit,
)
from app.services.collection_candidate_registry import upsert_collection_candidate_from_deposit

router = APIRouter(prefix="/webhooks", tags=["webhooks"])
logger = logging.getLogger("moralis_webhook")

AVAXC_CHAIN_KEY = "avaxc"
AVAXC_NATIVE_USDT_CONTRACT = "0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7"
SOLANA_CHAIN_KEY = "solana"
SOLANA_USDT_MINT = "Es9vMFrzaCERmJfrF4H2FyFQ5jBqFaUG2RgxN6E7j3BP"


# -------------------------
# utils
# -------------------------
def to_int_auto(v: Any, default: Optional[int] = None) -> Optional[int]:
    try:
        if v is None:
            return default
        if isinstance(v, str):
            s = v.strip()
            if s.startswith(("0x", "0X")):
                return int(s, 0)
            return int(s)
        return int(v)
    except Exception:
        return default


def norm_chain(v: str) -> str:
    s = (v or "").strip().lower()
    if s in ("solana", "sol", "spl", "spl token", "solana mainnet"):
        return "SOLANA"
    if s in ("eth", "ethereum", "ethereum mainnet"):
        return "ETHEREUM"
    if s in ("bsc", "bnb", "binance", "binance smart chain"):
        return "BSC"
    if s in ("polygon", "matic"):
        return "POLYGON"
    if s in ("optimism", "op", "optimism mainnet"):
        return "OPTIMISM"
    if s in (
        "avaxc",
        "avax",
        "avalanche",
        "avalanche mainnet",
        "avalanche c-chain",
        "avalanche c chain",
        "avalanche cchain",
    ):
        return "AVAXC"
    return ""


def norm_chain_id(v: Any) -> str:
    chain_id = str(v or "").strip().lower()
    if chain_id in ("solana", "sol", "spl", "mainnet-beta", "solana_mainnet", "solana-mainnet"):
        return "SOLANA"
    if chain_id in ("0x1", "1"):
        return "ETHEREUM"
    if chain_id in ("0x38", "56"):
        return "BSC"
    if chain_id in ("0x89", "137"):
        return "POLYGON"
    if chain_id in ("0xa", "10"):
        return "OPTIMISM"
    if chain_id in ("0xa86a", "43114"):
        return "AVAXC"
    return ""


def _get_log_index(tx: Dict[str, Any]) -> int:
    return int(to_int_auto(tx.get("logIndex") or tx.get("log_index"), 0) or 0)


def _first_text(*values: Any) -> str:
    for value in values:
        if value is None:
            continue
        if isinstance(value, dict):
            continue
        text_value = str(value).strip()
        if text_value:
            return text_value
    return ""


def _nested_text(obj: Any, *keys: str) -> str:
    if not isinstance(obj, dict):
        return ""
    current: Any = obj
    for key in keys:
        if not isinstance(current, dict):
            return ""
        current = current.get(key)
    return _first_text(current)


def extract_tx_hash(tx: Dict[str, Any], payload: Optional[Dict[str, Any]] = None) -> str:
    payload = payload or {}
    return _first_text(
        tx.get("transactionHash"),
        tx.get("txHash"),
        tx.get("hash"),
        tx.get("signature"),
        tx.get("txSignature"),
        tx.get("txID"),
        tx.get("txId"),
        payload.get("transactionHash"),
        payload.get("txHash"),
        payload.get("hash"),
        payload.get("signature"),
    )


def extract_receiver_address(tx: Dict[str, Any]) -> str:
    return _first_text(
        tx.get("to"),
        tx.get("toAddress"),
        tx.get("toOwner"),
        tx.get("ownerAddress"),
        tx.get("recipient"),
        tx.get("recipientOwner"),
        tx.get("receiver"),
        tx.get("owner"),
        tx.get("toUserAccount"),
        tx.get("destination"),
        tx.get("destinationOwner"),
        tx.get("destinationUserAccount"),
        _nested_text(tx.get("to") or {}, "owner"),
        _nested_text(tx.get("toUserAccount") or {}, "owner"),
        _nested_text(tx.get("destination") or {}, "owner"),
        _nested_text(tx.get("destinationUserAccount") or {}, "owner"),
    )


def extract_sender_address(tx: Dict[str, Any]) -> str:
    return _first_text(
        tx.get("from"),
        tx.get("fromAddress"),
        tx.get("sender"),
        tx.get("source"),
        tx.get("sourceOwner"),
        tx.get("fromUserAccount"),
        _nested_text(tx.get("from") or {}, "owner"),
        _nested_text(tx.get("source") or {}, "owner"),
    )


def _solana_log_index(tx_hash: str, mint: str, receiver: str) -> int:
    digest = hashlib.sha256(f"{tx_hash}|{mint}|{receiver}".encode("utf-8")).digest()
    return int.from_bytes(digest[:4], "big") & 0x7FFFFFFF


def _payload_transfers(payload: Dict[str, Any]) -> list[Dict[str, Any]]:
    transfer_keys = (
        "splTokenTransfers",
        "splTransfers",
        "tokenTransfers",
        "erc20Transfers",
        "transfers",
        "nativeTransfers",
    )

    collected: list[Dict[str, Any]] = []
    for key in transfer_keys:
        transfers = payload.get(key)
        if isinstance(transfers, list):
            for item in transfers:
                if isinstance(item, dict):
                    collected.append(item)
        if collected:
            return collected

    transaction_lists = (
        payload.get("transactions"),
        payload.get("txs"),
        payload.get("transaction"),
        payload.get("tx"),
    )
    for candidate in transaction_lists:
        tx_items = candidate if isinstance(candidate, list) else [candidate]
        for tx_item in tx_items:
            if not isinstance(tx_item, dict):
                continue
            parent_meta = {
                "transactionHash": extract_tx_hash(tx_item, payload),
                "signature": extract_tx_hash(tx_item, payload),
                "chain": tx_item.get("chain") or payload.get("chain") or payload.get("network"),
                "chainId": tx_item.get("chainId") or tx_item.get("chain_id") or _payload_chain_id(payload),
                "confirmationStatus": tx_item.get("confirmationStatus") or payload.get("confirmationStatus"),
                "status": tx_item.get("status") or payload.get("status"),
                "confirmed": tx_item.get("confirmed") if "confirmed" in tx_item else payload.get("confirmed"),
            }
            for key in transfer_keys:
                transfers = tx_item.get(key)
                if not isinstance(transfers, list):
                    continue
                for item in transfers:
                    if isinstance(item, dict):
                        merged = {k: v for k, v in parent_meta.items() if v not in (None, "")}
                        merged.update(item)
                        collected.append(merged)
    return collected


def _payload_chain_type(payload: Dict[str, Any]) -> str:
    chain_id = _payload_chain_id(payload)
    return (
        norm_chain(payload.get("chain") or "")
        or norm_chain(payload.get("network") or "")
        or norm_chain(payload.get("blockchain") or "")
        or norm_chain_id(chain_id)
    )


def _payload_stream_id(payload: Dict[str, Any]) -> str:
    return _first_text(payload.get("streamId"), payload.get("stream_id"))


def _payload_chain_id(payload: Dict[str, Any]) -> str:
    return _first_text(payload.get("chainId"), payload.get("chain_id"))


def _looks_like_solana_payload(payload: Dict[str, Any]) -> bool:
    if _payload_chain_type(payload) == "SOLANA":
        return True
    network = str(payload.get("network") or "").strip().lower()
    if network == "mainnet" and isinstance(payload.get("transactions"), list):
        return True
    solana_keys = {
        "splTokenTransfers",
        "splTransfers",
        "accountChanges",
        "nativeTransfers",
        "instructions",
        "signature",
    }
    if any(key in payload for key in solana_keys):
        return True
    for key in ("transactions", "txs", "transaction", "tx"):
        value = payload.get(key)
        items = value if isinstance(value, list) else [value]
        for item in items:
            if isinstance(item, dict) and any(solana_key in item for solana_key in solana_keys):
                return True
    return False


def _handle_solana_webhook(payload: Dict[str, Any], db: Session) -> Optional[Dict[str, Any]]:
    transfers = _payload_transfers(payload)
    if transfers:
        return None
    logger.warning(
        "[moralis] ignored unsupported solana payload keys=%s",
        list(payload.keys()),
    )
    return {"ok": True, "ignored": True, "reason": "unsupported_solana_payload"}


def _is_confirmed_transfer(payload: Dict[str, Any], tx: Dict[str, Any]) -> bool:
    status_text = str(
        tx.get("confirmationStatus")
        or tx.get("status")
        or payload.get("confirmationStatus")
        or payload.get("status")
        or ""
    ).strip().lower()
    return bool(
        tx.get("confirmed") is True
        or payload.get("confirmed") is True
        or status_text in {"confirmed", "finalized", "success", "confirmed_success"}
    )


def to_decimal_amount(tx: Dict[str, Any], decimals: int) -> Optional[Decimal]:
    """
    兼容：
      - valueWithDecimals/valueDecimal/valueFormatted（如果存在）
      - value（raw int）
    """
    token_amount = tx.get("tokenAmount")
    if isinstance(token_amount, dict):
        for key in ("uiAmountString", "amountWithDecimals", "valueWithDecimals", "uiAmount"):
            value = token_amount.get(key)
            if value is not None and str(value).strip() != "":
                try:
                    d = Decimal(str(value).strip())
                    return d if d > 0 else None
                except (InvalidOperation, ValueError):
                    pass
        raw_token_amount = token_amount.get("amount")
        if raw_token_amount is not None and str(raw_token_amount).strip() != "":
            try:
                return Decimal(str(raw_token_amount).strip()) / (Decimal(10) ** Decimal(decimals))
            except Exception:
                pass

    for k in (
        "valueWithDecimals",
        "valueDecimal",
        "valueFormatted",
        "amountWithDecimals",
        "amountDecimal",
        "amountFormatted",
        "uiAmount",
        "uiAmountString",
    ):
        v = tx.get(k)
        if v is not None and str(v).strip() != "":
            try:
                d = Decimal(str(v).strip())
                return d if d > 0 else None
            except (InvalidOperation, ValueError):
                pass

    raw_value = tx.get("value") or tx.get("amountRaw") or tx.get("rawAmount") or tx.get("raw_amount")
    if raw_value is None or str(raw_value).strip() == "":
        amount_value = tx.get("amount")
        if amount_value is None or str(amount_value).strip() == "":
            return None
        amount_text = str(amount_value).strip()
        try:
            if "." in amount_text:
                d = Decimal(amount_text)
                return d if d > 0 else None
            if extract_token_address_raw(tx):
                raw_int = to_int_auto(amount_text, None)
                if raw_int is not None:
                    return Decimal(raw_int) / (Decimal(10) ** Decimal(decimals))
            d = Decimal(amount_text)
            return d if d > 0 else None
        except Exception:
            return None

    try:
        raw_int = to_int_auto(raw_value, None)
        if raw_int is None:
            d = Decimal(str(raw_value).strip())
            return d if d > 0 else None
        return Decimal(raw_int) / (Decimal(10) ** Decimal(decimals))
    except Exception:
        return None


def extract_token_address(tx: Dict[str, Any]) -> str:
    """
    Moralis 不同配置/版本可能给不同字段名，这里做兜底：
      - address
      - contract / contractAddress
      - tokenAddress / token_address
      - token: { address: ... }
      - erc20: { address: ... }
    """
    candidates = [
        tx.get("address"),
        tx.get("contract"),
        tx.get("contractAddress"),
        tx.get("tokenAddress"),
        tx.get("token_address"),
        tx.get("tokenMint"),
        tx.get("token_mint"),
        tx.get("mint"),
        tx.get("mintAddress"),
        tx.get("mint_address"),
    ]

    token_obj = tx.get("token") or tx.get("erc20") or tx.get("spl") or tx.get("splToken") or {}
    if isinstance(token_obj, dict):
        candidates.append(token_obj.get("address"))
        candidates.append(token_obj.get("contract"))
        candidates.append(token_obj.get("tokenAddress"))
        candidates.append(token_obj.get("tokenMint"))
        candidates.append(token_obj.get("mint"))
        candidates.append(token_obj.get("mintAddress"))

    for v in candidates:
        if isinstance(v, str) and v.strip():
            return v.strip().lower()

    return ""


def extract_token_address_raw(tx: Dict[str, Any]) -> str:
    candidates = [
        tx.get("address"),
        tx.get("contract"),
        tx.get("contractAddress"),
        tx.get("tokenAddress"),
        tx.get("token_address"),
        tx.get("tokenMint"),
        tx.get("token_mint"),
        tx.get("mint"),
        tx.get("mintAddress"),
        tx.get("mint_address"),
    ]
    token_obj = tx.get("token") or tx.get("erc20") or tx.get("spl") or tx.get("splToken") or {}
    if isinstance(token_obj, dict):
        candidates.append(token_obj.get("address"))
        candidates.append(token_obj.get("contract"))
        candidates.append(token_obj.get("tokenAddress"))
        candidates.append(token_obj.get("tokenMint"))
        candidates.append(token_obj.get("mint"))
        candidates.append(token_obj.get("mintAddress"))
    for v in candidates:
        if isinstance(v, str) and v.strip():
            return v.strip()
    return ""


def _find_user_chain_address(db: Session, *, chain_key: str, to_addr_lower: str):
    return db.execute(
        text(
            """
            SELECT uca.user_id, uca.address, uca.memo, c.id AS chain_id, c.chain_key
            FROM user_chain_addresses uca
            JOIN chains c ON c.id = uca.chain_id
            WHERE uca.enabled = 1
              AND c.chain_key = :chain_key
              AND LOWER(uca.address) = :addr
            LIMIT 1
            """
        ),
        {"chain_key": chain_key, "addr": to_addr_lower},
    ).mappings().first()


def _find_user_chain_address_exact(db: Session, *, chain_key: str, to_addr: str):
    return db.execute(
        text(
            """
            SELECT uca.user_id, uca.address, uca.memo, c.id AS chain_id, c.chain_key
            FROM user_chain_addresses uca
            JOIN chains c ON c.id = uca.chain_id
            WHERE uca.enabled = 1
              AND c.chain_key = :chain_key
              AND uca.address = :addr
            LIMIT 1
            """
        ),
        {"chain_key": chain_key, "addr": to_addr},
    ).mappings().first()


def _env_bool(name: str) -> bool:
    return os.getenv(name, "").strip().lower() in {"1", "true", "yes", "on"}


def _env_user_id_set(name: str) -> set[int]:
    values: set[int] = set()
    for item in os.getenv(name, "").split(","):
        raw = item.strip()
        if not raw:
            continue
        try:
            values.add(int(raw))
        except ValueError:
            logger.warning("[moralis] ignore invalid user id in %s: %s", name, raw)
    return values


def _avaxc_internal_deposit_test_allowed(*, chain_key: str, user_id: int, contract_address_lower: str) -> bool:
    if (chain_key or "").strip().lower() != AVAXC_CHAIN_KEY:
        return False
    if (contract_address_lower or "").strip().lower() != AVAXC_NATIVE_USDT_CONTRACT:
        return False
    if not _env_bool("AVAXC_INTERNAL_DEPOSIT_TEST_ENABLED"):
        return False
    allowlist = _env_user_id_set("AVAXC_INTERNAL_DEPOSIT_TEST_USER_IDS")
    return int(user_id) in allowlist


def _resolve_asset_by_contract(
    db: Session,
    *,
    chain_id: int,
    chain_key: str,
    user_id: int,
    contract_address_lower: str,
):
    row = db.execute(
        text(
            """
            SELECT
              a.id            AS asset_id,
              ac.id           AS asset_chain_id,
              a.symbol        AS symbol,
              ac.contract_address AS contract_address,
              ac.decimals     AS decimals,
              COALESCE(ac.confirmations, c.confirmations) AS confirm_required
            FROM asset_chains ac
            JOIN assets a ON a.id = ac.asset_id
            JOIN chains c ON c.id = ac.chain_id
            WHERE ac.chain_id = :chain_id
              AND LOWER(ac.contract_address) = :contract
              AND ac.enabled = 1
              AND ac.deposit_enabled = 1
              AND a.enabled = 1
              AND c.enabled = 1
            LIMIT 1
            """
        ),
        {"chain_id": chain_id, "contract": contract_address_lower},
    ).mappings().first()
    if row:
        return row

    if not _avaxc_internal_deposit_test_allowed(
        chain_key=chain_key,
        user_id=user_id,
        contract_address_lower=contract_address_lower,
    ):
        return None

    logger.warning(
        "[moralis] avaxc internal deposit test mode enabled user_id=%s chain=%s contract=%s",
        user_id,
        chain_key,
        contract_address_lower,
    )
    return db.execute(
        text(
            """
            SELECT
              a.id            AS asset_id,
              ac.id           AS asset_chain_id,
              a.symbol        AS symbol,
              ac.contract_address AS contract_address,
              ac.decimals     AS decimals,
              COALESCE(ac.confirmations, c.confirmations) AS confirm_required
            FROM asset_chains ac
            JOIN assets a ON a.id = ac.asset_id
            JOIN chains c ON c.id = ac.chain_id
            WHERE ac.chain_id = :chain_id
              AND LOWER(c.chain_key) = :chain_key
              AND LOWER(ac.contract_address) = :contract
              AND UPPER(a.symbol) = 'USDT'
              AND ac.enabled = 1
              AND a.enabled = 1
              AND c.enabled = 1
            LIMIT 1
            """
        ),
        {
            "chain_id": chain_id,
            "chain_key": AVAXC_CHAIN_KEY,
            "contract": AVAXC_NATIVE_USDT_CONTRACT,
        },
    ).mappings().first()


def _resolve_asset_by_contract_exact(
    db: Session,
    *,
    chain_id: int,
    contract_address: str,
):
    return db.execute(
        text(
            """
            SELECT
              a.id            AS asset_id,
              ac.id           AS asset_chain_id,
              a.symbol        AS symbol,
              ac.contract_address AS contract_address,
              ac.decimals     AS decimals,
              COALESCE(ac.confirmations, c.confirmations) AS confirm_required
            FROM asset_chains ac
            JOIN assets a ON a.id = ac.asset_id
            JOIN chains c ON c.id = ac.chain_id
            WHERE ac.chain_id = :chain_id
              AND ac.contract_address = :contract
              AND ac.enabled = 1
              AND ac.deposit_enabled = 1
              AND a.enabled = 1
              AND c.enabled = 1
            LIMIT 1
            """
        ),
        {"chain_id": chain_id, "contract": contract_address},
    ).mappings().first()


def _is_active_stock_token_lock_symbol(db: Session, symbol: str) -> bool:
    normalized_symbol = str(symbol or "").strip().upper()
    if not normalized_symbol:
        return False

    return (
        db.query(StockTokenLockConfig.id)
        .filter(
            StockTokenLockConfig.lock_symbol == normalized_symbol,
            StockTokenLockConfig.is_active == 1,
        )
        .first()
        is not None
    )


def _moralis_header_snapshot(request: Request) -> Dict[str, str]:
    snapshot: Dict[str, str] = {}
    for key, value in request.headers.items():
        lower_key = key.lower()
        if "moralis" not in lower_key and "signature" not in lower_key:
            continue
        if any(secret_key in lower_key for secret_key in ("signature", "secret", "token", "api-key", "apikey")):
            snapshot[key] = "<redacted>"
        else:
            snapshot[key] = value
    return snapshot


def _webhook_reason(result: Any) -> str:
    if not isinstance(result, dict):
        return "non_dict_response"
    if result.get("reason"):
        return str(result.get("reason"))
    if result.get("ignored"):
        return "ignored"
    if any(key in result for key in ("handled", "skipped", "tx_errors", "credit_ok")):
        return "processed"
    return "ok"


# -------------------------
# webhook
# -------------------------
async def _moralis_webhook_impl(request: Request, db: Session) -> Dict[str, Any]:
    method = request.method
    path = request.url.path
    logger.warning(
        "[moralis] entry method=%s path=%s moralis_headers=%s",
        method,
        path,
        _moralis_header_snapshot(request),
    )

    raw = await request.body()
    if not raw:
        return {"ok": True, "ignored": True, "reason": "empty_body"}

    try:
        payload: Dict[str, Any] = json.loads(raw.decode("utf-8"))
    except Exception:
        logger.exception("[moralis] invalid json method=%s path=%s", method, path)
        return {"ok": True, "ignored": True, "reason": "invalid_json"}

    stream_id = _payload_stream_id(payload)
    chain_id = _payload_chain_id(payload)
    solana_branch = _looks_like_solana_payload(payload)
    logger.warning(
        "[moralis] payload method=%s path=%s keys=%s stream_id_present=%s chainId=%s network=%s solana_branch=%s",
        method,
        path,
        list(payload.keys()),
        bool(stream_id),
        chain_id,
        payload.get("network"),
        solana_branch,
    )

    # Moralis 偶尔会发空 payload（你的第一条 len=301 就是这种），直接忽略
    if not stream_id:
        return {"ok": True, "ignored": True, "reason": "missing_stream_id"}

    sig = (
        request.headers.get("x-signature")
        or request.headers.get("x-moralis-signature")
        or ""
    )

    if sig:
        try:
            # ✅ 你的 verify_signature 是 keyword-only，这里必须用关键字参数
            if not verify_signature(raw_body=raw, header_signature=sig, stream_id=str(stream_id)):
                return {"ok": True, "ignored": True, "reason": "invalid_signature"}
        except Exception:
            logger.exception("[moralis] signature verification exception stream_id=%s", stream_id)
            return {"ok": True, "ignored": True, "reason": "signature_exception"}

    if solana_branch:
        solana_ignored = _handle_solana_webhook(payload, db)
        if solana_ignored is not None:
            return solana_ignored

    chain_type = _payload_chain_type(payload)
    transfers = _payload_transfers(payload)
    payload_confirmed = _is_confirmed_transfer(payload, {})
    if not transfers:
        reason = "unsupported_solana_payload" if _looks_like_solana_payload(payload) else "no_supported_transfer_list"
        logger.warning(
            "[moralis] ignored payload stream_id=%s reason=%s keys=%s",
            stream_id,
            reason,
            list(payload.keys()),
        )
        return {"ok": True, "ignored": True, "reason": reason}

    now = datetime.utcnow()
    handled = skipped = idempotent_hits = tx_errors = credited = locked = credit_errors = collection_candidate_ok = 0

    try:
        for i, tx in enumerate(transfers):
            try:
                tx_hash_raw = extract_tx_hash(tx, payload)
                to_addr = extract_receiver_address(tx)
                from_addr = extract_sender_address(tx)
                log_index = _get_log_index(tx)

                if not tx_hash_raw or not to_addr:
                    logger.warning(
                        "[moralis] skip transfer missing tx_hash/to stream_id=%s tx_keys=%s",
                        stream_id,
                        list(tx.keys()),
                    )
                    skipped += 1
                    continue

                t_chain = norm_chain(tx.get("chain") or "") or norm_chain_id(tx.get("chainId") or tx.get("chain_id")) or chain_type
                chain_key_by_type = {
                    "ETHEREUM": "ethereum",
                    "BSC": "bsc",
                    "POLYGON": "polygon",
                    "OPTIMISM": "optimism",
                    "AVAXC": "avaxc",
                    "SOLANA": "solana",
                }
                if t_chain not in chain_key_by_type:
                    skipped += 1
                    continue

                chain_key = chain_key_by_type[t_chain]
                is_solana_chain = chain_key == "solana"
                is_exact_address_chain = is_solana_chain
                tx_hash = tx_hash_raw if is_exact_address_chain else tx_hash_raw.lower()

                if is_exact_address_chain:
                    addr_row = _find_user_chain_address_exact(db, chain_key=chain_key, to_addr=to_addr)
                else:
                    addr_row = _find_user_chain_address(db, chain_key=chain_key, to_addr_lower=to_addr.lower())
                if not addr_row:
                    skipped += 1
                    continue

                user_id = int(addr_row["user_id"])
                chain_id = int(addr_row["chain_id"])

                # ✅ 调试：如果以后再出现字段不一致，你一眼能看到 tx 有哪些 key
                # 先别删，跑通后你再注释掉
                if i == 0:
                    logger.warning("[moralis] transfers[0] keys=%s", list(tx.keys()))

                token_addr = extract_token_address_raw(tx) if is_exact_address_chain else extract_token_address(tx)
                if not token_addr:
                    skipped += 1
                    logger.warning("[moralis] skip missing token address tx=%s log_index=%s", tx_hash, log_index)
                    continue
                if is_solana_chain:
                    if token_addr != SOLANA_USDT_MINT:
                        skipped += 1
                        logger.warning("[moralis] skip non-USDT solana mint=%s tx=%s", token_addr, tx_hash)
                        continue
                    if log_index == 0:
                        log_index = _solana_log_index(tx_hash=tx_hash, mint=token_addr, receiver=to_addr)

                if is_exact_address_chain:
                    asset_row = _resolve_asset_by_contract_exact(
                        db,
                        chain_id=chain_id,
                        contract_address=token_addr,
                    )
                else:
                    asset_row = _resolve_asset_by_contract(
                        db,
                        chain_id=chain_id,
                        chain_key=chain_key,
                        user_id=user_id,
                        contract_address_lower=token_addr,
                    )
                if not asset_row:
                    skipped += 1
                    logger.warning(
                        "[moralis] skip asset not configured chain_id=%s contract=%s tx=%s",
                        chain_id,
                        token_addr,
                        tx_hash,
                    )
                    continue

                symbol = asset_row["symbol"]
                decimals = int(asset_row["decimals"])
                confirm_required = int(asset_row["confirm_required"] or 0)

                amount = to_decimal_amount(tx, decimals=decimals)
                if not amount or amount <= 0:
                    skipped += 1
                    logger.warning(
                        "[moralis] skip invalid amount tx=%s value=%s decimals=%s",
                        tx_hash,
                        tx.get("value"),
                        decimals,
                    )
                    continue

                is_confirmed = _is_confirmed_transfer(payload, tx)

                with db.begin_nested():
                    dep = (
                        db.query(Deposit)
                        .filter(Deposit.chain_key == chain_key)
                        .filter(Deposit.txid == tx_hash)
                        .filter(Deposit.log_index == log_index)
                        .first()
                    )

                    if not dep:
                        dep = Deposit(
                            user_id=user_id,
                            coin_symbol=symbol,
                            chain_key=chain_key,
                            address=addr_row["address"],
                            memo=addr_row.get("memo"),
                            txid=tx_hash,
                            log_index=log_index,
                            from_address=from_addr if is_exact_address_chain else from_addr.lower(),
                            amount=amount,
                            status="CONFIRMED" if is_confirmed else "DETECTING",
                            confirmations=confirm_required if is_confirmed else 0,
                            confirm_required=confirm_required,
                            created_at=now,
                            updated_at=now,
                        )
                        db.add(dep)
                        db.flush()
                    else:
                        if is_confirmed and dep.status != "CONFIRMED":
                            dep.status = "CONFIRMED"
                            dep.confirmations = confirm_required
                            dep.updated_at = now

                handled += 1

                # 入账：只在 confirmed 才结算。股票锁仓凭证进入锁仓批次，不进普通余额。
                if is_confirmed:
                    try:
                        with db.begin_nested():
                            if _is_active_stock_token_lock_symbol(db, symbol):
                                create_stock_token_lock_from_deposit(
                                    db,
                                    user_id=user_id,
                                    lock_symbol=symbol,
                                    amount=amount,
                                    source_type="DEPOSIT",
                                    source_id=int(dep.id),
                                )
                                locked += 1
                            else:
                                credit_available(
                                    db,
                                    user_id=user_id,
                                    coin_symbol=symbol,
                                    chain_key=FUNDING_BALANCE_CHAIN_KEY,
                                    amount=amount,
                                    biz_type="DEPOSIT",
                                    biz_id=str(dep.id),
                                    change_type="DEPOSIT",
                                    remark=f"Moralis deposit {tx_hash}#{log_index}",
                                    now=now,
                                )
                                if upsert_collection_candidate_from_deposit(
                                    db,
                                    user_id=user_id,
                                    chain_key=chain_key,
                                    asset_symbol=symbol,
                                    asset_id=asset_row.get("asset_id"),
                                    asset_chain_id=asset_row.get("asset_chain_id"),
                                    token_contract=asset_row.get("contract_address") or token_addr,
                                    address=addr_row["address"],
                                    deposit_amount=amount,
                                    tx_hash=tx_hash,
                                    deposit_confirmed_at=now,
                                ):
                                    collection_candidate_ok += 1
                                credited += 1
                    except IntegrityError:
                        idempotent_hits += 1
                    except StockTokenLockError as e:
                        credit_errors += 1
                        logger.exception("[moralis] stock token lock error tx=%s log_index=%s", tx_hash, log_index)
                    except Exception as e:
                        credit_errors += 1
                        logger.exception("[moralis] credit error tx=%s log_index=%s", tx_hash, log_index)

            except IntegrityError:
                idempotent_hits += 1
                continue
            except Exception:
                tx_errors += 1
                continue

        db.commit()
    except Exception:
        db.rollback()
        return {"ok": True}

    return {
        "ok": True,
        "handled": handled,
        "skipped": skipped,
        "idempotent": idempotent_hits,
        "tx_errors": tx_errors,
        "credit_ok": credited,
        "stock_token_lock_ok": locked,
        "credit_errors": credit_errors,
        "collection_candidate_ok": collection_candidate_ok,
        "confirmed": payload_confirmed,
    }


@router.post("/moralis")
async def moralis_webhook(request: Request):
    db: Optional[Session] = None
    try:
        db = SessionLocal()
        result = await _moralis_webhook_impl(request, db)
        logger.warning(
            "[moralis] return method=%s path=%s reason=%s ok=%s",
            request.method,
            request.url.path,
            _webhook_reason(result),
            result.get("ok") if isinstance(result, dict) else None,
        )
        content = result if isinstance(result, dict) else {"ok": True, "ignored": True, "reason": "non_dict_response"}
        return JSONResponse(status_code=200, content=content)
    except Exception:
        if db is not None:
            try:
                db.rollback()
            except Exception:
                pass
        logger.exception("[moralis] unhandled webhook exception")
        result = {"ok": True, "ignored": True, "reason": "webhook_exception"}
        try:
            logger.warning(
                "[moralis] return method=%s path=%s reason=%s ok=%s",
                request.method,
                request.url.path,
                result["reason"],
                result["ok"],
            )
        except Exception:
            pass
        return JSONResponse(status_code=200, content=result)
    finally:
        if db is not None:
            try:
                db.close()
            except Exception:
                pass
