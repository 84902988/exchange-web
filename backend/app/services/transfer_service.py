from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from uuid import uuid4

from sqlalchemy.orm import Session

from app.db.models.asset import UserBalance
from app.db.models.internal_transfer import InternalTransfer
from app.schemas.account_transfer import (
    AccountTransferRecordItem,
    AccountTransferRecordsData,
    AccountTransferRequest,
    AccountTransferSubmitData,
)
from app.services.balance import (
    FUNDING_BALANCE_CHAIN_KEY,
    SPOT_BALANCE_CHAIN_KEY,
    transfer_available,
)


class TransferServiceError(RuntimeError):
    code = "TRANSFER_ERROR"


class TransferBadRequest(TransferServiceError):
    code = "BAD_REQUEST"


class TransferInsufficientBalance(TransferServiceError):
    code = "INSUFFICIENT_AVAILABLE_BALANCE"


class TransferService:
    ALLOWED_ACCOUNTS = (
        FUNDING_BALANCE_CHAIN_KEY,
        SPOT_BALANCE_CHAIN_KEY,
    )

    def create_transfer(
        self,
        db: Session,
        *,
        user_id: int,
        payload: AccountTransferRequest,
    ) -> AccountTransferSubmitData:
        self._ensure_table(db)

        symbol = self._normalize_symbol(payload.symbol)
        from_account = self._normalize_account(payload.from_account, field_name="from_account")
        to_account = self._normalize_account(payload.to_account, field_name="to_account")
        amount = self._normalize_amount(payload.amount)

        if from_account == to_account:
            raise TransferBadRequest("from_account 和 to_account 不能相同")

        now = datetime.utcnow()
        transfer_no = self._build_transfer_no(now)

        from_balance = self._lock_balance(
            db,
            user_id=user_id,
            symbol=symbol,
            account_key=from_account,
        )
        from_before = self._safe_decimal(
            from_balance.available_amount if from_balance else Decimal("0")
        )
        if from_before < amount:
            raise TransferInsufficientBalance("可用余额不足")

        to_balance = self._lock_balance(
            db,
            user_id=user_id,
            symbol=symbol,
            account_key=to_account,
        )
        to_before = self._safe_decimal(
            to_balance.available_amount if to_balance else Decimal("0")
        )

        try:
            transfer_available(
                db,
                user_id=user_id,
                coin_symbol=symbol,
                from_chain_key=from_account,
                to_chain_key=to_account,
                amount=amount,
                biz_id=transfer_no,
                remark="internal transfer {0}->{1}".format(from_account, to_account),
                now=now,
            )
        except ValueError as exc:
            message = str(exc)
            if message == "INSUFFICIENT_AVAILABLE_BALANCE":
                raise TransferInsufficientBalance("可用余额不足")
            if message == "SAME_ACCOUNT_TRANSFER":
                raise TransferBadRequest("from_account 和 to_account 不能相同")
            raise TransferBadRequest(message)

        from_after = from_before - amount
        to_after = to_before + amount

        record = InternalTransfer(
            transfer_no=transfer_no,
            user_id=user_id,
            coin_symbol=symbol,
            from_account=from_account,
            to_account=to_account,
            amount=amount,
            status="SUCCESS",
            from_available_before=from_before,
            from_available_after=from_after,
            to_available_before=to_before,
            to_available_after=to_after,
            remark="internal transfer {0}->{1}".format(from_account, to_account),
            created_at=now,
            updated_at=now,
        )
        db.add(record)
        db.commit()
        db.refresh(record)

        return AccountTransferSubmitData(record=self._to_record_item(record))

    def list_records(
        self,
        db: Session,
        *,
        user_id: int,
        page: int = 1,
        page_size: int = 20,
        symbol: str = "",
        from_account: str = "",
        to_account: str = "",
    ) -> AccountTransferRecordsData:
        self._ensure_table(db)

        normalized_page = max(int(page or 1), 1)
        normalized_page_size = max(min(int(page_size or 20), 200), 1)

        query = db.query(InternalTransfer).filter(InternalTransfer.user_id == user_id)

        normalized_symbol = self._normalize_optional_symbol(symbol)
        if normalized_symbol:
            query = query.filter(InternalTransfer.coin_symbol == normalized_symbol)

        normalized_from_account = self._normalize_optional_account(
            from_account,
            field_name="from_account",
        )
        if normalized_from_account:
            query = query.filter(InternalTransfer.from_account == normalized_from_account)

        normalized_to_account = self._normalize_optional_account(
            to_account,
            field_name="to_account",
        )
        if normalized_to_account:
            query = query.filter(InternalTransfer.to_account == normalized_to_account)

        total = query.count()
        rows = (
            query.order_by(InternalTransfer.id.desc())
            .offset((normalized_page - 1) * normalized_page_size)
            .limit(normalized_page_size)
            .all()
        )

        return AccountTransferRecordsData(
            items=[self._to_record_item(row) for row in rows],
            total=total,
            page=normalized_page,
            page_size=normalized_page_size,
        )

    def _ensure_table(self, db: Session) -> None:
        # 临时最小闭环方案：
        # 当前对话限制不允许改 app/db/models/__init__.py 或补 Alembic migration，
        # 因此这里在首次调用时按需建表，保证 /account/transfer 能本地闭环。
        # 后续应改为正式的 Alembic migration，并把模型纳入统一注册流程。
        InternalTransfer.__table__.create(bind=db.get_bind(), checkfirst=True)

    def _lock_balance(
        self,
        db: Session,
        *,
        user_id: int,
        symbol: str,
        account_key: str,
    ):
        return (
            db.query(UserBalance)
            .filter(UserBalance.user_id == user_id)
            .filter(UserBalance.coin_symbol == symbol)
            .filter(UserBalance.chain_key == account_key)
            .with_for_update()
            .first()
        )

    def _normalize_symbol(self, symbol: str) -> str:
        normalized_symbol = (symbol or "").strip().upper()
        if not normalized_symbol:
            raise TransferBadRequest("symbol 不能为空")
        return normalized_symbol

    def _normalize_optional_symbol(self, symbol: str) -> str:
        normalized_symbol = (symbol or "").strip().upper()
        return normalized_symbol

    def _normalize_account(self, account: str, *, field_name: str) -> str:
        normalized_account = (account or "").strip().lower()
        if normalized_account not in self.ALLOWED_ACCOUNTS:
            raise TransferBadRequest(
                "{0} 仅支持 funding 或 spot".format(field_name)
            )
        return normalized_account

    def _normalize_optional_account(self, account: str, *, field_name: str) -> str:
        normalized_account = (account or "").strip().lower()
        if not normalized_account:
            return ""
        return self._normalize_account(normalized_account, field_name=field_name)

    def _normalize_amount(self, amount: Decimal) -> Decimal:
        try:
            normalized_amount = Decimal(str(amount))
        except Exception:
            raise TransferBadRequest("amount 格式不正确")

        if normalized_amount <= Decimal("0"):
            raise TransferBadRequest("amount 必须大于 0")

        return normalized_amount

    def _build_transfer_no(self, now: datetime) -> str:
        return "ITR{0}{1}".format(
            now.strftime("%Y%m%d%H%M%S"),
            uuid4().hex[:8].upper(),
        )

    def _safe_decimal(self, value: Decimal) -> Decimal:
        if isinstance(value, Decimal):
            return value
        return Decimal(str(value or "0"))

    def _format_decimal(self, value: Decimal) -> str:
        return format(self._safe_decimal(value), "f")

    def _to_record_item(self, row: InternalTransfer) -> AccountTransferRecordItem:
        return AccountTransferRecordItem(
            id=int(row.id),
            transfer_no=row.transfer_no,
            symbol=row.coin_symbol,
            from_account=row.from_account,
            to_account=row.to_account,
            amount=self._format_decimal(row.amount),
            status=row.status,
            from_available_before=self._format_decimal(row.from_available_before),
            from_available_after=self._format_decimal(row.from_available_after),
            to_available_before=self._format_decimal(row.to_available_before),
            to_available_after=self._format_decimal(row.to_available_after),
            remark=row.remark,
            created_at=row.created_at.isoformat() if row.created_at else "",
        )


transfer_service = TransferService()
