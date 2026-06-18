from __future__ import annotations

from datetime import datetime
from typing import Optional

from app.db.models.asset import Deposit


DEPOSIT_SUCCESS_STATUSES = {"CONFIRMED", "SUCCESS", "SUCCEEDED", "COMPLETED", "CREDITED"}


def mark_deposit_confirmed(
    deposit: Deposit,
    *,
    status: str = "CONFIRMED",
    confirmations: Optional[int] = None,
    confirm_required: Optional[int] = None,
    block_number: Optional[int] = None,
    block_hash: Optional[str] = None,
    confirmed_at: Optional[datetime] = None,
) -> Deposit:
    """Mark a deposit as confirmed without overwriting an existing confirmation time."""
    next_status = str(status or "CONFIRMED").strip().upper()
    deposit.status = next_status
    if confirmations is not None:
        deposit.confirmations = int(confirmations)
    if confirm_required is not None:
        deposit.confirm_required = int(confirm_required)
    if block_number is not None:
        deposit.block_number = int(block_number)
    if block_hash is not None:
        deposit.block_hash = str(block_hash)
    if next_status in DEPOSIT_SUCCESS_STATUSES and deposit.confirmed_at is None:
        deposit.confirmed_at = confirmed_at or datetime.utcnow()
    deposit.updated_at = datetime.utcnow()
    return deposit
