from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from typing import Any, Optional

from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.db.models.collection import CollectionGasCostRecord, CollectionTask
from app.services.collection_balance_checker import get_web3_for_chain
from app.services.collection_chain_helper import get_native_gas_coin_symbol


logger = logging.getLogger(__name__)

TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
NATIVE_WEI = Decimal(10) ** 18
EVM_TX_HASH_RE = re.compile(r"^0x[0-9a-fA-F]{64}$")


@dataclass(frozen=True)
class CollectionGasCostRecordResult:
    ok: bool
    skipped: bool = False
    reason: str = ""
    record_id: Optional[int] = None


def _obj_get(value: Any, key: str, default: Any = None) -> Any:
    if value is None:
        return default
    if isinstance(value, dict):
        return value.get(key, default)
    return getattr(value, key, default)


def _hex(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value.lower()
    if isinstance(value, bytes):
        return "0x" + value.hex()
    hex_fn = getattr(value, "hex", None)
    if callable(hex_fn):
        result = hex_fn()
        return str(result if str(result).startswith("0x") else f"0x{result}").lower()
    return str(value).lower()


def _topic_address(topic: Any) -> str:
    value = _hex(topic)
    if not value:
        return ""
    raw = value[2:] if value.startswith("0x") else value
    if len(raw) < 40:
        return ""
    return "0x" + raw[-40:].lower()


def _int_value(value: Any) -> Optional[int]:
    if value is None:
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, bytes):
        return int.from_bytes(value, byteorder="big")
    text_value = _hex(value) if not isinstance(value, str) else value
    text_value = text_value.strip()
    if not text_value:
        return None
    return int(text_value, 16) if text_value.lower().startswith("0x") else int(text_value)


def _is_real_evm_tx_hash(tx_hash: str) -> bool:
    value = (tx_hash or "").strip()
    upper = value.upper()
    return bool(EVM_TX_HASH_RE.match(value) and not upper.startswith(("DRYRUN", "DRYGAS")))


def _load_token_contract(db: Session, task: CollectionTask) -> tuple[str, int]:
    row = db.execute(
        text(
            """
            SELECT ac.contract_address, ac.decimals
            FROM asset_chains ac
            JOIN assets a ON a.id = ac.asset_id
            JOIN chains c ON c.id = ac.chain_id
            WHERE (
                    :asset_chain_id IS NOT NULL
                    AND ac.id = :asset_chain_id
                  )
               OR (
                    UPPER(a.symbol) = :symbol
                    AND LOWER(c.chain_key) = :chain_key
                    AND ac.enabled = 1
                  )
            ORDER BY CASE WHEN ac.id = :asset_chain_id THEN 0 ELSE 1 END
            LIMIT 1
            """
        ),
        {
            "asset_chain_id": task.asset_chain_id,
            "symbol": str(task.coin_symbol or "").strip().upper(),
            "chain_key": str(task.chain_key or "").strip().lower(),
        },
    ).mappings().first()
    if not row:
        return "", 18
    return str(row.get("contract_address") or "").strip().lower(), int(row.get("decimals") or 18)


def _has_verified_transfer(
    *,
    receipt: Any,
    token_contract: str,
    from_address: str,
    to_address: str,
) -> bool:
    expected_contract = (token_contract or "").strip().lower()
    expected_from = (from_address or "").strip().lower()
    expected_to = (to_address or "").strip().lower()
    if not expected_contract or not expected_from or not expected_to:
        return False

    for log in _obj_get(receipt, "logs", []) or []:
        log_address = str(_obj_get(log, "address", "") or "").strip().lower()
        if log_address != expected_contract:
            continue
        topics = list(_obj_get(log, "topics", []) or [])
        if len(topics) < 3 or _hex(topics[0]) != TRANSFER_TOPIC:
            continue
        transfer_from = _topic_address(topics[1])
        transfer_to = _topic_address(topics[2])
        if transfer_from != expected_from or transfer_to != expected_to:
            continue
        value = _int_value(_obj_get(log, "data", None))
        if value and value > 0:
            return True
    return False


def _receipt_gas_price_wei(receipt: Any, tx: Any = None) -> Optional[int]:
    for key in ("effectiveGasPrice", "gasPrice"):
        value = _obj_get(receipt, key, None)
        parsed = _int_value(value)
        if parsed and parsed > 0:
            return parsed
    if tx is not None:
        for key in ("gasPrice", "maxFeePerGas"):
            value = _obj_get(tx, key, None)
            parsed = _int_value(value)
            if parsed and parsed > 0:
                return parsed
    return None


def record_collection_gas_cost_from_receipt(
    db: Session,
    task: CollectionTask,
    receipt: Any,
    *,
    tx: Any = None,
) -> CollectionGasCostRecordResult:
    tx_hash = (task.tx_hash or "").strip()
    chain_key = str(task.chain_key or "").strip().lower()
    if not _is_real_evm_tx_hash(tx_hash):
        return CollectionGasCostRecordResult(ok=True, skipped=True, reason="TX_HASH_NOT_REAL_EVM")
    if chain_key == "solana":
        return CollectionGasCostRecordResult(ok=True, skipped=True, reason="NON_EVM_CHAIN")

    receipt_status = _int_value(_obj_get(receipt, "status", None))
    if receipt_status != 1:
        return CollectionGasCostRecordResult(ok=True, skipped=True, reason="RECEIPT_NOT_SUCCESS")

    token_contract, _decimals = _load_token_contract(db, task)
    if not token_contract:
        return CollectionGasCostRecordResult(ok=True, skipped=True, reason="TOKEN_CONTRACT_MISSING")

    if not _has_verified_transfer(
        receipt=receipt,
        token_contract=token_contract,
        from_address=str(task.from_address or ""),
        to_address=str(task.to_address or ""),
    ):
        return CollectionGasCostRecordResult(ok=True, skipped=True, reason="TRANSFER_NOT_VERIFIED")

    gas_used = _int_value(_obj_get(receipt, "gasUsed", None))
    gas_price_wei = _receipt_gas_price_wei(receipt, tx)
    if not gas_used or gas_used <= 0 or not gas_price_wei or gas_price_wei <= 0:
        return CollectionGasCostRecordResult(ok=True, skipped=True, reason="GAS_COST_MISSING")

    confirmed_at = task.confirmed_at or datetime.utcnow()
    native_fee = (Decimal(gas_used) * Decimal(gas_price_wei)) / NATIVE_WEI

    existing = (
        db.query(CollectionGasCostRecord.id)
        .filter(
            (CollectionGasCostRecord.collection_task_id == int(task.id))
            | (CollectionGasCostRecord.tx_hash == tx_hash)
        )
        .first()
    )
    if existing:
        return CollectionGasCostRecordResult(ok=True, skipped=True, reason="DUPLICATE", record_id=int(existing[0]))

    try:
        with db.begin_nested():
            record = CollectionGasCostRecord(
                collection_task_id=int(task.id),
                chain_key=chain_key,
                token_symbol=str(task.coin_symbol or "").strip().upper(),
                tx_hash=tx_hash,
                gas_used=int(gas_used),
                gas_price_wei=Decimal(gas_price_wei),
                native_fee=native_fee,
                native_symbol=get_native_gas_coin_symbol(chain_key),
                receipt_status=1,
                transfer_verified=1,
                confirmed_at=confirmed_at,
            )
            db.add(record)
            db.flush()
        return CollectionGasCostRecordResult(ok=True, record_id=int(record.id))
    except IntegrityError:
        return CollectionGasCostRecordResult(ok=True, skipped=True, reason="DUPLICATE")


def record_collection_gas_cost_for_task(
    db: Session,
    task: CollectionTask,
) -> CollectionGasCostRecordResult:
    tx_hash = (task.tx_hash or "").strip()
    if not _is_real_evm_tx_hash(tx_hash):
        return CollectionGasCostRecordResult(ok=True, skipped=True, reason="TX_HASH_NOT_REAL_EVM")

    w3 = get_web3_for_chain(str(task.chain_key or ""), db=db)
    receipt = w3.eth.get_transaction_receipt(tx_hash)
    tx = None
    try:
        tx = w3.eth.get_transaction(tx_hash)
    except Exception:
        tx = None
    return record_collection_gas_cost_from_receipt(db, task, receipt, tx=tx)


def best_effort_record_collection_gas_cost(db: Session, task: CollectionTask) -> None:
    try:
        result = record_collection_gas_cost_for_task(db, task)
        if result.skipped:
            logger.info(
                "collection gas cost record skipped task_id=%s tx_hash=%s reason=%s",
                task.id,
                (task.tx_hash or "")[:32],
                result.reason,
            )
    except Exception:
        logger.exception("collection gas cost record failed task_id=%s", getattr(task, "id", None))
