from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from typing import Any
from uuid import uuid4

from sqlalchemy.orm import Session

from app.db.models.asset import BalanceLog, UserBalance
from app.db.models.contract_account import ContractAccount
from app.db.models.contract_position import ContractPosition
from app.db.models.contract_margin_log import ContractMarginLog
from app.schemas.contract_account import ContractAccountSummaryResponse, ContractTransferResponse
from app.services.balance import FUNDING_BALANCE_CHAIN_KEY
from app.services.contract_balance_log_service import add_contract_balance_log
from app.services.contract_query_service import resolve_contract_position_pnl


CONTRACT_MARGIN_ASSET = "USDT"
CONTRACT_ACCOUNT_BIZ_TYPE = "CONTRACT_TRANSFER"


@dataclass(frozen=True)
class ContractAccountPnlSnapshot:
    unrealized_pnl: Decimal | None
    state: str
    usable: bool
    source: str


class ContractAccountServiceError(ValueError):
    code = "CONTRACT_ACCOUNT_ERROR"


class ContractAccountBadRequest(ContractAccountServiceError):
    code = "BAD_REQUEST"


class ContractAccountInsufficientBalance(ContractAccountServiceError):
    code = "INSUFFICIENT_AVAILABLE_BALANCE"


def _q18(value: Any) -> Decimal:
    if isinstance(value, Decimal):
        return value
    return Decimal(str(value or "0"))


def _fmt_decimal(value: Any) -> str:
    return format(_q18(value), "f")


def _normalize_user_id(user_id: Any) -> int:
    try:
        parsed = int(user_id)
    except (TypeError, ValueError):
        raise ContractAccountBadRequest("invalid user_id")
    if parsed <= 0:
        raise ContractAccountBadRequest("invalid user_id")
    return parsed


def _normalize_margin_asset(margin_asset: str) -> str:
    normalized = str(margin_asset or "").strip().upper()
    if normalized != CONTRACT_MARGIN_ASSET:
        raise ContractAccountBadRequest("contract V1 only supports USDT margin asset")
    return normalized


def _normalize_account_key(account: str) -> str:
    normalized = str(account or "").strip().lower()
    if normalized != FUNDING_BALANCE_CHAIN_KEY:
        raise ContractAccountBadRequest("contract V1 only supports funding account transfers")
    return normalized


def _normalize_amount(amount: Any) -> Decimal:
    try:
        parsed = Decimal(str(amount))
    except Exception:
        raise ContractAccountBadRequest("amount format is invalid")
    if parsed <= Decimal("0"):
        raise ContractAccountBadRequest("amount must be greater than 0")
    return parsed


def _build_transfer_no(prefix: str, now: datetime) -> str:
    return f"{prefix}{now.strftime('%Y%m%d%H%M%S')}{uuid4().hex[:8].upper()}"


def _lock_contract_account(
    db: Session,
    *,
    user_id: int,
    margin_asset: str,
    now: datetime,
) -> ContractAccount:
    account = (
        db.query(ContractAccount)
        .filter(ContractAccount.user_id == user_id)
        .filter(ContractAccount.margin_asset == margin_asset)
        .with_for_update()
        .first()
    )
    if account is not None:
        return account

    account = ContractAccount(
        user_id=user_id,
        margin_asset=margin_asset,
        available_margin=Decimal("0"),
        frozen_margin=Decimal("0"),
        position_margin=Decimal("0"),
        realized_pnl=Decimal("0"),
        unrealized_pnl=Decimal("0"),
        version=0,
        created_at=now,
        updated_at=now,
    )
    db.add(account)
    db.flush()
    return account


def _lock_existing_funding_balance(
    db: Session,
    *,
    user_id: int,
    margin_asset: str,
) -> UserBalance | None:
    return (
        db.query(UserBalance)
        .filter(UserBalance.user_id == user_id)
        .filter(UserBalance.coin_symbol == margin_asset)
        .filter(UserBalance.chain_key == FUNDING_BALANCE_CHAIN_KEY)
        .with_for_update()
        .first()
    )


def _lock_or_create_funding_balance(
    db: Session,
    *,
    user_id: int,
    margin_asset: str,
    now: datetime,
) -> UserBalance:
    balance = _lock_existing_funding_balance(db, user_id=user_id, margin_asset=margin_asset)
    if balance is not None:
        return balance

    balance = UserBalance(
        user_id=user_id,
        coin_symbol=margin_asset,
        chain_key=FUNDING_BALANCE_CHAIN_KEY,
        available_amount=Decimal("0"),
        frozen_amount=Decimal("0"),
        version=0,
        created_at=now,
        updated_at=now,
    )
    db.add(balance)
    db.flush()
    return balance


def _account_position_pnl_snapshot(
    db: Session,
    *,
    user_id: int,
) -> ContractAccountPnlSnapshot:
    positions = (
        db.query(ContractPosition)
        .filter(ContractPosition.user_id == int(user_id))
        .filter(ContractPosition.status == "OPEN")
        .filter(ContractPosition.quantity > 0)
        .all()
    )
    if not positions:
        return ContractAccountPnlSnapshot(
            unrealized_pnl=Decimal("0"),
            state="LIVE",
            usable=True,
            source="NO_OPEN_POSITIONS",
        )

    total = Decimal("0")
    aggregate_state = "LIVE"
    for position in positions:
        snapshot = resolve_contract_position_pnl(db, position)
        if snapshot.unrealized_pnl is None or snapshot.freshness == "UNAVAILABLE":
            return ContractAccountPnlSnapshot(
                unrealized_pnl=None,
                state="UNAVAILABLE",
                usable=False,
                source="OPEN_POSITION_MARK_TO_MARKET",
            )
        total += snapshot.unrealized_pnl
        if snapshot.freshness == "STALE":
            aggregate_state = "STALE"
        elif snapshot.freshness == "RECENT" and aggregate_state == "LIVE":
            aggregate_state = "RECENT"

    return ContractAccountPnlSnapshot(
        unrealized_pnl=total,
        state=aggregate_state,
        usable=aggregate_state in {"LIVE", "RECENT"},
        source="OPEN_POSITION_MARK_TO_MARKET",
    )


def _summary_from_account(db: Session, account: ContractAccount) -> ContractAccountSummaryResponse:
    available_margin = _q18(account.available_margin)
    frozen_margin = _q18(account.frozen_margin)
    position_margin = _q18(account.position_margin)
    pnl_snapshot = _account_position_pnl_snapshot(db, user_id=int(account.user_id))
    unrealized_pnl = pnl_snapshot.unrealized_pnl
    equity = (
        available_margin + frozen_margin + position_margin + unrealized_pnl
        if unrealized_pnl is not None
        else None
    )
    return ContractAccountSummaryResponse(
        user_id=int(account.user_id),
        margin_asset=account.margin_asset,
        available_margin=_fmt_decimal(available_margin),
        used_margin=_fmt_decimal(position_margin),
        frozen_margin=_fmt_decimal(frozen_margin),
        position_margin=_fmt_decimal(position_margin),
        realized_pnl=_fmt_decimal(account.realized_pnl),
        unrealized_pnl=_fmt_decimal(unrealized_pnl) if unrealized_pnl is not None else None,
        equity=_fmt_decimal(equity) if equity is not None else None,
        equity_state=pnl_snapshot.state,
        equity_usable=pnl_snapshot.usable,
        equity_source=pnl_snapshot.source,
    )


def _empty_account_summary(
    *,
    user_id: int,
    margin_asset: str,
) -> ContractAccountSummaryResponse:
    return ContractAccountSummaryResponse(
        user_id=user_id,
        margin_asset=margin_asset,
        available_margin="0",
        used_margin="0",
        frozen_margin="0",
        position_margin="0",
        realized_pnl="0",
        unrealized_pnl="0",
        equity="0",
        equity_state="LIVE",
        equity_usable=True,
        equity_source="NO_OPEN_POSITIONS",
    )


def get_or_create_contract_account(
    db: Session,
    user_id: int,
    margin_asset: str = CONTRACT_MARGIN_ASSET,
) -> ContractAccount:
    normalized_user_id = _normalize_user_id(user_id)
    normalized_asset = _normalize_margin_asset(margin_asset)
    now = datetime.utcnow()
    return _lock_contract_account(db, user_id=normalized_user_id, margin_asset=normalized_asset, now=now)


def get_contract_account_summary(db: Session, user_id: int) -> ContractAccountSummaryResponse:
    normalized_user_id = _normalize_user_id(user_id)
    normalized_asset = _normalize_margin_asset(CONTRACT_MARGIN_ASSET)
    account = (
        db.query(ContractAccount)
        .filter(ContractAccount.user_id == normalized_user_id)
        .filter(ContractAccount.margin_asset == normalized_asset)
        .first()
    )
    if account is None:
        return _empty_account_summary(
            user_id=normalized_user_id,
            margin_asset=normalized_asset,
        )
    return _summary_from_account(db, account)


def transfer_to_contract(
    db: Session,
    user_id: int,
    amount: Any,
    from_account: str = FUNDING_BALANCE_CHAIN_KEY,
) -> ContractTransferResponse:
    normalized_user_id = _normalize_user_id(user_id)
    account_key = _normalize_account_key(from_account)
    transfer_amount = _normalize_amount(amount)
    now = datetime.utcnow()
    transfer_no = _build_transfer_no("CTI", now)

    contract_account = _lock_contract_account(
        db,
        user_id=normalized_user_id,
        margin_asset=CONTRACT_MARGIN_ASSET,
        now=now,
    )
    funding_balance = _lock_existing_funding_balance(
        db,
        user_id=normalized_user_id,
        margin_asset=CONTRACT_MARGIN_ASSET,
    )
    funding_before = _q18(funding_balance.available_amount if funding_balance else Decimal("0"))
    funding_before_frozen = _q18(funding_balance.frozen_amount if funding_balance else Decimal("0"))
    if funding_balance is None or funding_before < transfer_amount:
        raise ContractAccountInsufficientBalance("funding USDT available balance is insufficient")

    contract_before = _q18(contract_account.available_margin)
    contract_before_frozen = _q18(contract_account.frozen_margin)
    funding_after = funding_before - transfer_amount
    contract_after = contract_before + transfer_amount

    funding_balance.available_amount = funding_after
    funding_balance.version = int(funding_balance.version or 0) + 1
    funding_balance.updated_at = now

    contract_account.available_margin = contract_after
    contract_account.version = int(contract_account.version or 0) + 1
    contract_account.updated_at = now

    db.add(
        ContractMarginLog(
            user_id=normalized_user_id,
            account_id=int(contract_account.id),
            position_id=None,
            order_id=None,
            symbol=None,
            change_type="TRANSFER_IN",
            change_amount=transfer_amount,
            before_available=contract_before,
            after_available=contract_after,
            before_frozen=contract_before_frozen,
            after_frozen=contract_before_frozen,
            remark=f"transfer from {account_key} to contract",
            created_at=now,
        )
    )
    db.add(
        BalanceLog(
            user_id=normalized_user_id,
            coin_symbol=CONTRACT_MARGIN_ASSET,
            chain_key=account_key,
            change_type="CONTRACT_TRANSFER_OUT",
            direction=-1,
            change_amount=transfer_amount,
            before_available=funding_before,
            after_available=funding_after,
            before_frozen=funding_before_frozen,
            after_frozen=funding_before_frozen,
            biz_type=CONTRACT_ACCOUNT_BIZ_TYPE,
            biz_id=transfer_no,
            request_id=None,
            remark="transfer to contract account",
            created_at=now,
        )
    )
    add_contract_balance_log(
        db,
        user_id=normalized_user_id,
        change_type=CONTRACT_ACCOUNT_BIZ_TYPE,
        biz_type=CONTRACT_ACCOUNT_BIZ_TYPE,
        biz_id=transfer_no,
        change_amount=transfer_amount,
        before_available=contract_before,
        after_available=contract_after,
        before_frozen=contract_before_frozen,
        after_frozen=contract_before_frozen,
        remark="transfer from funding account",
        now=now,
    )
    db.commit()
    db.refresh(contract_account)

    return ContractTransferResponse(
        transfer_no=transfer_no,
        direction="IN",
        margin_asset=CONTRACT_MARGIN_ASSET,
        amount=_fmt_decimal(transfer_amount),
        funding_available_before=_fmt_decimal(funding_before),
        funding_available_after=_fmt_decimal(funding_after),
        contract_available_before=_fmt_decimal(contract_before),
        contract_available_after=_fmt_decimal(contract_after),
        account=_summary_from_account(db, contract_account),
    )


def transfer_from_contract(
    db: Session,
    user_id: int,
    amount: Any,
    to_account: str = FUNDING_BALANCE_CHAIN_KEY,
) -> ContractTransferResponse:
    normalized_user_id = _normalize_user_id(user_id)
    account_key = _normalize_account_key(to_account)
    transfer_amount = _normalize_amount(amount)
    now = datetime.utcnow()
    transfer_no = _build_transfer_no("CTO", now)

    contract_account = _lock_contract_account(
        db,
        user_id=normalized_user_id,
        margin_asset=CONTRACT_MARGIN_ASSET,
        now=now,
    )
    funding_balance = _lock_or_create_funding_balance(
        db,
        user_id=normalized_user_id,
        margin_asset=CONTRACT_MARGIN_ASSET,
        now=now,
    )

    contract_before = _q18(contract_account.available_margin)
    contract_before_frozen = _q18(contract_account.frozen_margin)
    if contract_before < transfer_amount:
        raise ContractAccountInsufficientBalance("contract available margin is insufficient")

    funding_before = _q18(funding_balance.available_amount)
    funding_before_frozen = _q18(funding_balance.frozen_amount)
    contract_after = contract_before - transfer_amount
    funding_after = funding_before + transfer_amount

    contract_account.available_margin = contract_after
    contract_account.version = int(contract_account.version or 0) + 1
    contract_account.updated_at = now

    funding_balance.available_amount = funding_after
    funding_balance.version = int(funding_balance.version or 0) + 1
    funding_balance.updated_at = now

    db.add(
        ContractMarginLog(
            user_id=normalized_user_id,
            account_id=int(contract_account.id),
            position_id=None,
            order_id=None,
            symbol=None,
            change_type="TRANSFER_OUT",
            change_amount=transfer_amount,
            before_available=contract_before,
            after_available=contract_after,
            before_frozen=contract_before_frozen,
            after_frozen=contract_before_frozen,
            remark=f"transfer from contract to {account_key}",
            created_at=now,
        )
    )
    db.add(
        BalanceLog(
            user_id=normalized_user_id,
            coin_symbol=CONTRACT_MARGIN_ASSET,
            chain_key=account_key,
            change_type="CONTRACT_TRANSFER_IN",
            direction=1,
            change_amount=transfer_amount,
            before_available=funding_before,
            after_available=funding_after,
            before_frozen=funding_before_frozen,
            after_frozen=funding_before_frozen,
            biz_type=CONTRACT_ACCOUNT_BIZ_TYPE,
            biz_id=transfer_no,
            request_id=None,
            remark="transfer from contract account",
            created_at=now,
        )
    )
    add_contract_balance_log(
        db,
        user_id=normalized_user_id,
        change_type=CONTRACT_ACCOUNT_BIZ_TYPE,
        biz_type=CONTRACT_ACCOUNT_BIZ_TYPE,
        biz_id=transfer_no,
        change_amount=-transfer_amount,
        before_available=contract_before,
        after_available=contract_after,
        before_frozen=contract_before_frozen,
        after_frozen=contract_before_frozen,
        remark="transfer to funding account",
        now=now,
    )
    db.commit()
    db.refresh(contract_account)

    return ContractTransferResponse(
        transfer_no=transfer_no,
        direction="OUT",
        margin_asset=CONTRACT_MARGIN_ASSET,
        amount=_fmt_decimal(transfer_amount),
        funding_available_before=_fmt_decimal(funding_before),
        funding_available_after=_fmt_decimal(funding_after),
        contract_available_before=_fmt_decimal(contract_before),
        contract_available_after=_fmt_decimal(contract_after),
        account=_summary_from_account(db, contract_account),
    )
