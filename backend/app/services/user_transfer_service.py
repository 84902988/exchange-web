from __future__ import annotations

from datetime import datetime
from decimal import Decimal, InvalidOperation
from typing import Optional
from uuid import uuid4

from sqlalchemy import or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.db.models.asset import BalanceLog, UserBalance
from app.db.models.profile import UserProfile
from app.db.models.user import User
from app.db.models.user_transfer import UserTransfer
from app.schemas.user_transfer import (
    UserTransferRecipientData,
    UserTransferRecordItem,
    UserTransferRecordsData,
    UserTransferRequest,
    UserTransferSubmitData,
)
from app.services.balance import FUNDING_BALANCE_CHAIN_KEY


class UserTransferServiceError(RuntimeError):
    code = "USER_TRANSFER_ERROR"


class UserTransferBadRequest(UserTransferServiceError):
    code = "BAD_REQUEST"


class UserTransferNotFound(UserTransferServiceError):
    code = "NOT_FOUND"


class UserTransferInsufficientBalance(UserTransferServiceError):
    code = "INSUFFICIENT_AVAILABLE_BALANCE"


class UserTransferService:
    ACCOUNT_KEY = FUNDING_BALANCE_CHAIN_KEY
    STATUS_SUCCESS = "SUCCESS"
    BIZ_TYPE = "USER_TRANSFER"

    def resolve_recipient(
        self,
        db: Session,
        *,
        current_user_id: int,
        email: str,
    ) -> UserTransferRecipientData:
        recipient_email = self._normalize_email(email)
        sender = self._get_user(db, current_user_id)
        self._ensure_active_user(sender, "sender")

        row = (
            db.query(User, UserProfile)
            .outerjoin(UserProfile, UserProfile.user_id == User.id)
            .filter(User.email == recipient_email)
            .first()
        )
        if not row:
            raise UserTransferNotFound("recipient not found")

        user, profile = row
        if int(user.id) == int(current_user_id):
            raise UserTransferBadRequest("cannot transfer to yourself")
        self._ensure_active_user(user, "recipient")

        return UserTransferRecipientData(
            user_id=int(user.id),
            email_mask=self._mask_email(user.email or recipient_email),
            nickname=profile.nickname if profile else None,
            avatar_url=profile.avatar_url if profile else None,
            can_transfer=True,
        )

    def create_transfer(
        self,
        db: Session,
        *,
        from_user_id: int,
        payload: UserTransferRequest,
    ) -> UserTransferSubmitData:
        request_id = self._normalize_request_id(payload.request_id)
        existing = self._find_existing(db, from_user_id=from_user_id, request_id=request_id)
        if existing:
            return UserTransferSubmitData(record=self._to_record_item(existing, current_user_id=from_user_id))

        symbol = self._normalize_symbol(payload.symbol)
        amount = self._normalize_amount(payload.amount)
        recipient_email = self._normalize_email(payload.recipient_email)
        remark = (payload.remark or "").strip() or None

        try:
            sender = self._get_user(db, from_user_id, for_update=True)
            self._ensure_active_user(sender, "sender")

            recipient = (
                db.query(User)
                .filter(User.email == recipient_email)
                .with_for_update()
                .first()
            )
            if not recipient:
                raise UserTransferNotFound("recipient not found")
            if int(recipient.id) == int(from_user_id):
                raise UserTransferBadRequest("cannot transfer to yourself")
            self._ensure_active_user(recipient, "recipient")

            now = datetime.utcnow()
            balances = self._lock_funding_balances(
                db,
                user_ids=[int(sender.id), int(recipient.id)],
                symbol=symbol,
                now=now,
            )
            sender_balance = balances.get(int(sender.id))
            if not sender_balance:
                raise UserTransferInsufficientBalance("available balance is insufficient")

            receiver_balance = balances.get(int(recipient.id))
            if not receiver_balance:
                receiver_balance = self._create_balance(
                    db,
                    user_id=int(recipient.id),
                    symbol=symbol,
                    now=now,
                )

            sender_before = self._safe_decimal(sender_balance.available_amount)
            receiver_before = self._safe_decimal(receiver_balance.available_amount)
            if sender_before < amount:
                raise UserTransferInsufficientBalance("available balance is insufficient")

            sender_after = sender_before - amount
            receiver_after = receiver_before + amount
            transfer_no = self._build_transfer_no(now)
            email_mask = self._mask_email(recipient.email or recipient_email)

            record = UserTransfer(
                transfer_no=transfer_no,
                request_id=request_id,
                from_user_id=int(sender.id),
                to_user_id=int(recipient.id),
                coin_symbol=symbol,
                from_account=self.ACCOUNT_KEY,
                to_account=self.ACCOUNT_KEY,
                amount=amount,
                fee_amount=Decimal("0"),
                net_amount=amount,
                status=self.STATUS_SUCCESS,
                recipient_email_mask=email_mask,
                sender_available_before=sender_before,
                sender_available_after=sender_after,
                receiver_available_before=receiver_before,
                receiver_available_after=receiver_after,
                remark=remark,
                created_at=now,
                updated_at=now,
            )
            db.add(record)

            sender_balance.available_amount = sender_after
            sender_balance.version += 1
            sender_balance.updated_at = now

            receiver_balance.available_amount = receiver_after
            receiver_balance.version += 1
            receiver_balance.updated_at = now

            db.add(
                BalanceLog(
                    user_id=int(sender.id),
                    coin_symbol=symbol,
                    chain_key=self.ACCOUNT_KEY,
                    change_type="USER_TRANSFER_OUT",
                    direction=-1,
                    change_amount=amount,
                    before_available=sender_before,
                    after_available=sender_after,
                    before_frozen=sender_balance.frozen_amount,
                    after_frozen=sender_balance.frozen_amount,
                    biz_type=self.BIZ_TYPE,
                    biz_id=transfer_no,
                    request_id=request_id,
                    remark=remark,
                    created_at=now,
                )
            )
            db.add(
                BalanceLog(
                    user_id=int(recipient.id),
                    coin_symbol=symbol,
                    chain_key=self.ACCOUNT_KEY,
                    change_type="USER_TRANSFER_IN",
                    direction=1,
                    change_amount=amount,
                    before_available=receiver_before,
                    after_available=receiver_after,
                    before_frozen=receiver_balance.frozen_amount,
                    after_frozen=receiver_balance.frozen_amount,
                    biz_type=self.BIZ_TYPE,
                    biz_id=transfer_no,
                    request_id=request_id,
                    remark=remark,
                    created_at=now,
                )
            )

            db.flush()
            db.commit()
            db.refresh(record)
            return UserTransferSubmitData(record=self._to_record_item(record, current_user_id=from_user_id))
        except IntegrityError:
            db.rollback()
            existing = self._find_existing(db, from_user_id=from_user_id, request_id=request_id)
            if existing:
                return UserTransferSubmitData(record=self._to_record_item(existing, current_user_id=from_user_id))
            raise

    def list_records(
        self,
        db: Session,
        *,
        user_id: int,
        direction: str = "all",
        page: int = 1,
        page_size: int = 20,
        symbol: str = "",
    ) -> UserTransferRecordsData:
        normalized_direction = (direction or "all").strip().lower()
        if normalized_direction not in {"all", "in", "out"}:
            raise UserTransferBadRequest("direction must be all, in, or out")

        normalized_page = max(int(page or 1), 1)
        normalized_page_size = max(min(int(page_size or 20), 200), 1)
        normalized_symbol = self._normalize_optional_symbol(symbol)

        query = db.query(UserTransfer)
        if normalized_direction == "in":
            query = query.filter(UserTransfer.to_user_id == user_id)
        elif normalized_direction == "out":
            query = query.filter(UserTransfer.from_user_id == user_id)
        else:
            query = query.filter(
                or_(
                    UserTransfer.from_user_id == user_id,
                    UserTransfer.to_user_id == user_id,
                )
            )

        if normalized_symbol:
            query = query.filter(UserTransfer.coin_symbol == normalized_symbol)

        total = query.count()
        rows = (
            query.order_by(UserTransfer.id.desc())
            .offset((normalized_page - 1) * normalized_page_size)
            .limit(normalized_page_size)
            .all()
        )
        counterparty_user_ids = {
            int(row.to_user_id if int(row.from_user_id) == int(user_id) else row.from_user_id)
            for row in rows
        }
        recipient_user_ids = {int(row.to_user_id) for row in rows}
        nickname_map = {}
        nickname_user_ids = counterparty_user_ids | recipient_user_ids
        if nickname_user_ids:
            nickname_rows = (
                db.query(UserProfile.user_id, UserProfile.nickname)
                .filter(UserProfile.user_id.in_(nickname_user_ids))
                .all()
            )
            nickname_map = {
                int(profile_user_id): nickname
                for profile_user_id, nickname in nickname_rows
                if nickname
            }

        return UserTransferRecordsData(
            items=[
                self._to_record_item(
                    row,
                    current_user_id=user_id,
                    counterparty_nickname=nickname_map.get(
                        int(row.to_user_id if int(row.from_user_id) == int(user_id) else row.from_user_id)
                    ),
                    recipient_nickname=nickname_map.get(int(row.to_user_id)),
                )
                for row in rows
            ],
            total=total,
            page=normalized_page,
            page_size=normalized_page_size,
        )

    def _get_user(self, db: Session, user_id: int, *, for_update: bool = False) -> User:
        query = db.query(User).filter(User.id == user_id)
        if for_update:
            query = query.with_for_update()
        user = query.first()
        if not user:
            raise UserTransferBadRequest("user not found")
        return user

    def _ensure_active_user(self, user: User, role: str) -> None:
        if int(user.status or 0) != 1:
            raise UserTransferBadRequest(f"{role} status is not active")

    def _lock_funding_balances(
        self,
        db: Session,
        *,
        user_ids: list[int],
        symbol: str,
        now: datetime,
    ) -> dict[int, UserBalance]:
        balances: dict[int, UserBalance] = {}
        for user_id in sorted(set(int(uid) for uid in user_ids)):
            bal = (
                db.query(UserBalance)
                .filter(UserBalance.user_id == user_id)
                .filter(UserBalance.coin_symbol == symbol)
                .filter(UserBalance.chain_key == self.ACCOUNT_KEY)
                .with_for_update()
                .first()
            )
            if bal:
                balances[user_id] = bal
        return balances

    def _create_balance(self, db: Session, *, user_id: int, symbol: str, now: datetime) -> UserBalance:
        bal = UserBalance(
            user_id=user_id,
            coin_symbol=symbol,
            chain_key=self.ACCOUNT_KEY,
            available_amount=Decimal("0"),
            frozen_amount=Decimal("0"),
            version=0,
            created_at=now,
            updated_at=now,
        )
        db.add(bal)
        db.flush()
        return bal

    def _find_existing(self, db: Session, *, from_user_id: int, request_id: str) -> Optional[UserTransfer]:
        return (
            db.query(UserTransfer)
            .filter(UserTransfer.from_user_id == from_user_id)
            .filter(UserTransfer.request_id == request_id)
            .first()
        )

    def _normalize_email(self, email: str) -> str:
        normalized = (email or "").strip()
        if not normalized or "@" not in normalized:
            raise UserTransferBadRequest("recipient email is invalid")
        return normalized

    def _normalize_request_id(self, request_id: str) -> str:
        normalized = (request_id or "").strip()
        if not normalized:
            raise UserTransferBadRequest("request_id is required")
        if len(normalized) > 64:
            raise UserTransferBadRequest("request_id is too long")
        return normalized

    def _normalize_symbol(self, symbol: str) -> str:
        normalized = (symbol or "").strip().upper()
        if not normalized:
            raise UserTransferBadRequest("symbol is required")
        return normalized

    def _normalize_optional_symbol(self, symbol: str) -> str:
        return (symbol or "").strip().upper()

    def _normalize_amount(self, amount: Decimal) -> Decimal:
        try:
            normalized = Decimal(str(amount))
        except (InvalidOperation, ValueError):
            raise UserTransferBadRequest("amount is invalid")
        if normalized <= Decimal("0"):
            raise UserTransferBadRequest("amount must be greater than 0")
        return normalized

    def _build_transfer_no(self, now: datetime) -> str:
        return "UTR{0}{1}".format(now.strftime("%Y%m%d%H%M%S"), uuid4().hex[:8].upper())

    def _mask_email(self, email: str) -> str:
        local, sep, domain = (email or "").partition("@")
        if not sep:
            return "***"
        if len(local) <= 1:
            masked_local = "*"
        elif len(local) == 2:
            masked_local = local[0] + "*"
        else:
            masked_local = local[0] + "***" + local[-1]
        return f"{masked_local}@{domain}"

    def _safe_decimal(self, value: Decimal) -> Decimal:
        if isinstance(value, Decimal):
            return value
        return Decimal(str(value or "0"))

    def _format_decimal(self, value: Decimal) -> str:
        return format(self._safe_decimal(value), "f")

    def _to_record_item(
        self,
        row: UserTransfer,
        *,
        current_user_id: int,
        counterparty_nickname: Optional[str] = None,
        recipient_nickname: Optional[str] = None,
    ) -> UserTransferRecordItem:
        is_out = int(row.from_user_id) == int(current_user_id)
        return UserTransferRecordItem(
            id=int(row.id),
            transfer_no=row.transfer_no,
            request_id=row.request_id,
            direction="out" if is_out else "in",
            counterparty_user_id=int(row.to_user_id if is_out else row.from_user_id),
            counterparty_nickname=counterparty_nickname,
            recipient_nickname=recipient_nickname,
            recipient_email_mask=row.recipient_email_mask,
            symbol=row.coin_symbol,
            from_account="funding",
            to_account="funding",
            amount=self._format_decimal(row.amount),
            fee_amount=self._format_decimal(row.fee_amount),
            net_amount=self._format_decimal(row.net_amount),
            status=row.status,
            sender_available_before=self._format_decimal(row.sender_available_before),
            sender_available_after=self._format_decimal(row.sender_available_after),
            receiver_available_before=self._format_decimal(row.receiver_available_before),
            receiver_available_after=self._format_decimal(row.receiver_available_after),
            remark=row.remark,
            created_at=row.created_at.isoformat() if row.created_at else "",
        )


user_transfer_service = UserTransferService()
