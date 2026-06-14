from __future__ import annotations

import logging
from datetime import datetime
from decimal import Decimal
from typing import Any, Optional

from sqlalchemy import inspect, text
from sqlalchemy.orm import Session


logger = logging.getLogger(__name__)

COLLECTION_CANDIDATE_EVM_CHAINS = {
    "arbitrum",
    "avaxc",
    "bsc",
    "eth",
    "ethereum",
    "optimism",
    "polygon",
}


def _normalize_chain_key(value: Any) -> str:
    return str(value or "").strip().lower()


def _normalize_symbol(value: Any) -> str:
    return str(value or "").strip().upper()


def _normalize_address(value: Any) -> str:
    return str(value or "").strip().lower()


def _decimal(value: Any) -> Decimal:
    try:
        return Decimal(str(value or "0"))
    except Exception:
        return Decimal("0")


def _has_collection_candidates_table(db: Session) -> bool:
    try:
        return inspect(db.get_bind()).has_table("collection_candidates")
    except Exception:
        logger.exception("collection candidates table inspection failed")
        return False


def upsert_collection_candidate_from_deposit(
    db: Session,
    *,
    user_id: int,
    chain_key: str,
    asset_symbol: str,
    asset_id: Optional[int],
    asset_chain_id: Optional[int],
    token_contract: str,
    address: str,
    deposit_amount: Any,
    tx_hash: str,
    deposit_confirmed_at: Optional[datetime] = None,
) -> bool:
    chain = _normalize_chain_key(chain_key)
    symbol = _normalize_symbol(asset_symbol)
    token = _normalize_address(token_contract)
    user_address = _normalize_address(address)
    amount = _decimal(deposit_amount)
    confirmed_at = deposit_confirmed_at or datetime.utcnow()
    if chain not in COLLECTION_CANDIDATE_EVM_CHAINS:
        return False
    if not symbol or not token or not user_address or amount <= 0:
        return False
    if not _has_collection_candidates_table(db):
        logger.warning("collection candidate skipped because table is missing chain=%s symbol=%s", chain, symbol)
        return False

    db.execute(
        text(
            """
            INSERT INTO collection_candidates (
                user_id, chain_key, asset_symbol, asset_id, asset_chain_id,
                token_contract, address, total_detected_amount, latest_deposit_amount,
                latest_tx_hash, source, status, detected_at, latest_deposit_at,
                created_at, updated_at
            ) VALUES (
                :user_id, :chain_key, :asset_symbol, :asset_id, :asset_chain_id,
                :token_contract, :address, :amount, :amount,
                :tx_hash, 'DEPOSIT', 'PENDING', :confirmed_at, :confirmed_at,
                :confirmed_at, :confirmed_at
            )
            ON DUPLICATE KEY UPDATE
                user_id = VALUES(user_id),
                asset_id = VALUES(asset_id),
                asset_chain_id = VALUES(asset_chain_id),
                total_detected_amount = COALESCE(total_detected_amount, 0) + VALUES(latest_deposit_amount),
                latest_deposit_amount = VALUES(latest_deposit_amount),
                latest_tx_hash = VALUES(latest_tx_hash),
                source = 'DEPOSIT',
                status = CASE WHEN status = 'DISABLED' THEN 'DISABLED' ELSE 'ACTIVE' END,
                latest_deposit_at = VALUES(latest_deposit_at),
                updated_at = VALUES(updated_at)
            """
        ),
        {
            "user_id": int(user_id),
            "chain_key": chain,
            "asset_symbol": symbol,
            "asset_id": int(asset_id) if asset_id is not None else None,
            "asset_chain_id": int(asset_chain_id) if asset_chain_id is not None else None,
            "token_contract": token,
            "address": user_address,
            "amount": amount,
            "tx_hash": str(tx_hash or "").strip(),
            "confirmed_at": confirmed_at,
        },
    )
    logger.info(
        "collection candidate upserted source=DEPOSIT chain=%s symbol=%s address=%s tx=%s amount=%s",
        chain,
        symbol,
        user_address,
        str(tx_hash or "")[:32],
        amount,
    )
    return True


def mark_collection_candidate_scanned(
    db: Session,
    *,
    chain_key: str,
    asset_symbol: str,
    token_contract: str,
    address: str,
    balance_amount: Any,
    scanned_at: Optional[datetime] = None,
) -> None:
    if not _has_collection_candidates_table(db):
        return
    chain = _normalize_chain_key(chain_key)
    symbol = _normalize_symbol(asset_symbol)
    token = _normalize_address(token_contract)
    user_address = _normalize_address(address)
    if not chain or not symbol or not token or not user_address:
        return
    now = scanned_at or datetime.utcnow()
    db.execute(
        text(
            """
            UPDATE collection_candidates
            SET last_scan_at = :scanned_at,
                last_balance_amount = :balance_amount,
                status = CASE WHEN status = 'DISABLED' THEN 'DISABLED' ELSE 'ACTIVE' END,
                updated_at = :scanned_at
            WHERE chain_key = :chain_key
              AND asset_symbol = :asset_symbol
              AND LOWER(token_contract) = :token_contract
              AND LOWER(address) = :address
            """
        ),
        {
            "scanned_at": now,
            "balance_amount": _decimal(balance_amount),
            "chain_key": chain,
            "asset_symbol": symbol,
            "token_contract": token,
            "address": user_address,
        },
    )
