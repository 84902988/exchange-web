from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from typing import Any, Optional

from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.db.models.asset import BalanceLog, Deposit
from app.db.models.stock_token_lock_config import StockTokenLockConfig
from app.services.balance import FUNDING_BALANCE_CHAIN_KEY, credit_available
from app.services.collection_balance_checker import CollectionBalanceCheckerError, get_web3_for_chain
from app.services.collection_candidate_registry import upsert_collection_candidate_from_deposit
from app.services.deposit_status_service import DEPOSIT_SUCCESS_STATUSES, mark_deposit_confirmed
from app.services.stock_token_lock_service import StockTokenLockError, create_stock_token_lock_from_deposit

logger = logging.getLogger(__name__)

TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
SUCCESS_STATUSES = DEPOSIT_SUCCESS_STATUSES
RECHECKABLE_STATUSES = {"DETECTING", "PENDING", "CONFIRMING"}


@dataclass(frozen=True)
class DepositTxConfirmResult:
    deposit_id: int
    status: str
    message: str
    confirmations: int = 0
    confirm_required: int = 0
    block_number: Optional[int] = None
    credited: bool = False
    already_credited: bool = False
    error_message: Optional[str] = None


def _obj_get(value: Any, key: str, default: Any = None) -> Any:
    if isinstance(value, dict):
        return value.get(key, default)
    return getattr(value, key, default)


def _hex_string(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        text = value.strip()
    elif hasattr(value, "hex"):
        try:
            text = str(value.hex()).strip()
        except Exception:
            text = str(value).strip()
    else:
        text = str(value).strip()

    if not text:
        return ""
    normalized = text.lower()
    while normalized.startswith("0x"):
        normalized = normalized[2:]
    return f"0x{normalized}"


def _normalize_address(value: Any) -> str:
    return str(value or "").strip().lower()


def _topic_to_address(topic: Any) -> str:
    raw = _hex_string(topic).lower().removeprefix("0x")
    if len(raw) < 40:
        return ""
    return f"0x{raw[-40:]}"


def _data_to_int(data: Any) -> int:
    if data is None:
        return 0
    if isinstance(data, int):
        return int(data)
    if isinstance(data, (bytes, bytearray)):
        return int.from_bytes(data, "big")
    raw = _hex_string(data)
    return int(raw, 16 if raw.lower().startswith("0x") else 10)


def _decimal_to_raw(value: Decimal, decimals: int) -> int:
    return int((Decimal(str(value)) * (Decimal(10) ** Decimal(int(decimals)))).to_integral_value())


def _extract_matching_transfer(
    receipt: Any,
    *,
    token_contract: str,
    expected_to: str,
    expected_raw: int,
) -> Optional[dict[str, Any]]:
    token = _normalize_address(token_contract)
    expected_to_normalized = _normalize_address(expected_to)
    for log in list(_obj_get(receipt, "logs", []) or []):
        if _normalize_address(_obj_get(log, "address")) != token:
            continue
        topics = list(_obj_get(log, "topics", []) or [])
        if len(topics) < 3 or _hex_string(topics[0]).lower() != TRANSFER_TOPIC:
            continue
        try:
            actual_to = _topic_to_address(topics[2])
            actual_raw = _data_to_int(_obj_get(log, "data"))
        except Exception:
            logger.warning("deposit_confirm malformed transfer log skipped", exc_info=True)
            continue
        if _normalize_address(actual_to) == expected_to_normalized and int(actual_raw) == int(expected_raw):
            return {
                "from": _topic_to_address(topics[1]),
                "to": actual_to,
                "value_raw": int(actual_raw),
                "log_index": _obj_get(log, "logIndex"),
            }
    return None


def _load_deposit_asset_chain(db: Session, deposit: Deposit) -> Optional[dict[str, Any]]:
    return dict(
        db.execute(
            text(
                """
                SELECT
                  a.id AS asset_id,
                  a.symbol AS symbol,
                  ac.id AS asset_chain_id,
                  ac.contract_address AS contract_address,
                  ac.decimals AS decimals,
                  COALESCE(ac.confirmations, c.confirmations, :fallback_confirmations) AS confirm_required
                FROM asset_chains ac
                JOIN assets a ON a.id = ac.asset_id
                JOIN chains c ON c.id = ac.chain_id
                WHERE UPPER(a.symbol) = :symbol
                  AND LOWER(c.chain_key) = :chain_key
                  AND ac.enabled = 1
                  AND ac.deposit_enabled = 1
                  AND a.enabled = 1
                  AND c.enabled = 1
                LIMIT 1
                """
            ),
            {
                "symbol": str(deposit.coin_symbol or "").strip().upper(),
                "chain_key": str(deposit.chain_key or "").strip().lower(),
                "fallback_confirmations": int(deposit.confirm_required or 1),
            },
        ).mappings().first()
        or {}
    ) or None


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


def _deposit_balance_log_exists(db: Session, deposit: Deposit) -> bool:
    return (
        db.query(BalanceLog.id)
        .filter(BalanceLog.user_id == int(deposit.user_id))
        .filter(BalanceLog.coin_symbol == str(deposit.coin_symbol or "").upper())
        .filter(BalanceLog.chain_key == FUNDING_BALANCE_CHAIN_KEY)
        .filter(BalanceLog.biz_type == "DEPOSIT")
        .filter(BalanceLog.biz_id == str(deposit.id))
        .first()
        is not None
    )


def _credit_confirmed_deposit(
    db: Session,
    deposit: Deposit,
    *,
    asset_meta: dict[str, Any],
    now: datetime,
) -> tuple[bool, bool]:
    if _is_active_stock_token_lock_symbol(db, str(deposit.coin_symbol or "")):
        try:
            with db.begin_nested():
                create_stock_token_lock_from_deposit(
                    db,
                    user_id=int(deposit.user_id),
                    lock_symbol=str(deposit.coin_symbol or "").upper(),
                    amount=Decimal(str(deposit.amount)),
                    source_type="DEPOSIT",
                    source_id=int(deposit.id),
                )
            return True, False
        except StockTokenLockError:
            logger.exception("deposit_confirm stock token lock failed deposit_id=%s", deposit.id)
            raise
        except IntegrityError:
            return False, True

    if _deposit_balance_log_exists(db, deposit):
        return False, True

    try:
        with db.begin_nested():
            credit_available(
                db,
                user_id=int(deposit.user_id),
                coin_symbol=str(deposit.coin_symbol or "").upper(),
                chain_key=FUNDING_BALANCE_CHAIN_KEY,
                amount=Decimal(str(deposit.amount)),
                biz_type="DEPOSIT",
                biz_id=str(deposit.id),
                change_type="DEPOSIT",
                remark=f"Deposit chain recheck {deposit.txid}#{deposit.log_index}",
                now=now,
            )
    except IntegrityError:
        return False, True

    try:
        upsert_collection_candidate_from_deposit(
            db,
            user_id=int(deposit.user_id),
            chain_key=str(deposit.chain_key or "").lower(),
            asset_symbol=str(deposit.coin_symbol or "").upper(),
            asset_id=asset_meta.get("asset_id"),
            asset_chain_id=asset_meta.get("asset_chain_id"),
            token_contract=asset_meta.get("contract_address") or "",
            address=deposit.address,
            deposit_amount=deposit.amount,
            tx_hash=deposit.txid,
            deposit_confirmed_at=now,
        )
    except Exception:
        logger.warning("deposit_confirm collection candidate upsert failed deposit_id=%s", deposit.id, exc_info=True)
    return True, False


def recheck_deposit_chain_confirmation(db: Session, deposit_id: int) -> DepositTxConfirmResult:
    deposit = (
        db.query(Deposit)
        .filter(Deposit.id == int(deposit_id))
        .with_for_update()
        .first()
    )
    if not deposit:
        return DepositTxConfirmResult(int(deposit_id), "NOT_FOUND", "充值记录不存在", error_message="DEPOSIT_NOT_FOUND")

    status = str(deposit.status or "").strip().upper()
    tx_hash = str(deposit.txid or "").strip()
    if status in SUCCESS_STATUSES:
        return DepositTxConfirmResult(
            int(deposit.id),
            "ALREADY_CONFIRMED",
            "该充值已确认入账，无需重复处理",
            confirmations=int(deposit.confirmations or 0),
            confirm_required=int(deposit.confirm_required or 0),
            block_number=deposit.block_number,
            already_credited=True,
        )
    if status not in RECHECKABLE_STATUSES:
        return DepositTxConfirmResult(
            int(deposit.id),
            "SKIPPED",
            f"当前状态不允许链上补确认：{deposit.status}",
            confirmations=int(deposit.confirmations or 0),
            confirm_required=int(deposit.confirm_required or 0),
            error_message=f"STATUS_{deposit.status}",
        )
    if not tx_hash:
        return DepositTxConfirmResult(
            int(deposit.id),
            "SKIPPED",
            "该充值没有 tx_hash，无法链上重查",
            confirmations=int(deposit.confirmations or 0),
            confirm_required=int(deposit.confirm_required or 0),
            error_message="TX_HASH_EMPTY",
        )

    chain_key = str(deposit.chain_key or "").strip().lower()
    if chain_key == "solana":
        return DepositTxConfirmResult(
            int(deposit.id),
            "UNSUPPORTED",
            "Solana 充值补确认暂未接入该按钮",
            confirmations=int(deposit.confirmations or 0),
            confirm_required=int(deposit.confirm_required or 0),
            error_message="SOLANA_UNSUPPORTED",
        )

    asset_meta = _load_deposit_asset_chain(db, deposit)
    if not asset_meta:
        return DepositTxConfirmResult(
            int(deposit.id),
            "CONFIG_ERROR",
            "充值资产或链配置不存在，无法链上重查",
            confirmations=int(deposit.confirmations or 0),
            confirm_required=int(deposit.confirm_required or 0),
            error_message="ASSET_CHAIN_CONFIG_MISSING",
        )

    contract_address = str(asset_meta.get("contract_address") or "").strip()
    if not contract_address:
        return DepositTxConfirmResult(
            int(deposit.id),
            "UNSUPPORTED",
            "当前补确认仅支持 ERC20 充值记录",
            confirmations=int(deposit.confirmations or 0),
            confirm_required=int(deposit.confirm_required or 0),
            error_message="TOKEN_CONTRACT_EMPTY",
        )

    try:
        w3 = get_web3_for_chain(chain_key, db=db)
        receipt = w3.eth.get_transaction_receipt(tx_hash)
        latest_block = int(w3.eth.block_number)
    except CollectionBalanceCheckerError as exc:
        logger.warning(
            "deposit_confirm chain query failed deposit_id=%s chain=%s tx=%s error=%s",
            deposit.id,
            chain_key,
            tx_hash,
            exc,
        )
        return DepositTxConfirmResult(
            int(deposit.id),
            "PENDING",
            "链上查询失败，请稍后重试",
            confirmations=int(deposit.confirmations or 0),
            confirm_required=int(deposit.confirm_required or 0),
            error_message=str(exc),
        )
    except Exception as exc:
        message = str(exc)
        if "not found" in message.lower() or "transactionnotfound" in type(exc).__name__.lower():
            logger.info(
                "deposit_confirm tx not found deposit_id=%s chain=%s tx=%s",
                deposit.id,
                chain_key,
                tx_hash,
            )
            return DepositTxConfirmResult(
                int(deposit.id),
                "PENDING",
                "链上暂未查到该交易，保持确认中",
                confirmations=int(deposit.confirmations or 0),
                confirm_required=int(deposit.confirm_required or 0),
                error_message="TX_NOT_FOUND",
            )
        logger.warning(
            "deposit_confirm chain query error deposit_id=%s chain=%s tx=%s error=%s",
            deposit.id,
            chain_key,
            tx_hash,
            message,
        )
        return DepositTxConfirmResult(
            int(deposit.id),
            "PENDING",
            "链上查询失败，请稍后重试",
            confirmations=int(deposit.confirmations or 0),
            confirm_required=int(deposit.confirm_required or 0),
            error_message=message,
        )

    if receipt is None:
        return DepositTxConfirmResult(
            int(deposit.id),
            "PENDING",
            "链上暂未查到该交易，保持确认中",
            confirmations=int(deposit.confirmations or 0),
            confirm_required=int(deposit.confirm_required or 0),
            error_message="TX_NOT_FOUND",
        )

    receipt_status = int(_obj_get(receipt, "status", 0) or 0)
    block_number_raw = _obj_get(receipt, "blockNumber")
    block_number = int(block_number_raw) if block_number_raw is not None else None
    confirmations = 0
    if block_number is not None:
        confirmations = max(0, latest_block - block_number + 1)
    confirm_required = int(asset_meta.get("confirm_required") or deposit.confirm_required or 1)

    deposit.confirm_required = confirm_required
    deposit.confirmations = confirmations
    deposit.block_number = block_number
    deposit.updated_at = datetime.utcnow()

    if receipt_status != 1:
        db.flush()
        return DepositTxConfirmResult(
            int(deposit.id),
            "FAILED_ONCHAIN",
            f"链上交易未成功，receipt.status={receipt_status}",
            confirmations=confirmations,
            confirm_required=confirm_required,
            block_number=block_number,
            error_message=f"RECEIPT_STATUS_{receipt_status}",
        )

    expected_raw = _decimal_to_raw(Decimal(str(deposit.amount)), int(asset_meta.get("decimals") or 18))
    matched_transfer = _extract_matching_transfer(
        receipt,
        token_contract=contract_address,
        expected_to=str(deposit.address or ""),
        expected_raw=expected_raw,
    )
    if not matched_transfer:
        db.flush()
        return DepositTxConfirmResult(
            int(deposit.id),
            "MISMATCH",
            "链上交易成功，但 Transfer 合约、收款地址或金额与充值记录不匹配，未入账",
            confirmations=confirmations,
            confirm_required=confirm_required,
            block_number=block_number,
            error_message="TRANSFER_MISMATCH",
        )

    if not deposit.from_address:
        deposit.from_address = matched_transfer.get("from") or deposit.from_address

    if confirmations < confirm_required:
        db.flush()
        return DepositTxConfirmResult(
            int(deposit.id),
            "PENDING",
            f"链上交易已成功，当前确认数 {confirmations}/{confirm_required}，等待继续确认",
            confirmations=confirmations,
            confirm_required=confirm_required,
            block_number=block_number,
        )

    now = datetime.utcnow()
    mark_deposit_confirmed(
        deposit,
        status="CONFIRMED",
        confirmations=confirmations,
        confirm_required=confirm_required,
        block_number=block_number,
        confirmed_at=now,
    )

    credited, already_credited = _credit_confirmed_deposit(db, deposit, asset_meta=asset_meta, now=now)
    db.flush()
    if already_credited:
        return DepositTxConfirmResult(
            int(deposit.id),
            "ALREADY_CREDITED",
            "该充值已确认入账，无需重复处理",
            confirmations=confirmations,
            confirm_required=confirm_required,
            block_number=block_number,
            already_credited=True,
        )
    return DepositTxConfirmResult(
        int(deposit.id),
        "CONFIRMED",
        "已完成链上重查，确认数已更新",
        confirmations=confirmations,
        confirm_required=confirm_required,
        block_number=block_number,
        credited=credited,
    )
