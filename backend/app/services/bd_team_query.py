from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timedelta
from decimal import Decimal, ROUND_HALF_UP
from math import ceil
from typing import Any, Dict, Iterable, Optional

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.db.models.asset import BalanceLog
from app.db.models.bd_account import BdAccount
from app.db.models.bd_commission_record import BdCommissionRecord
from app.db.models.bd_user_relation import BdUserRelation
from app.services.admin_queries import _fmt_admin_amount_display, _fmt_admin_decimal
from app.services.referral_source_service import SOURCE_BD


DEFAULT_PAGE = 1
DEFAULT_PAGE_SIZE = 20
MAX_PAGE_SIZE = 100
BD_COMMISSION_SETTLEMENT_SYMBOL = "RCB"
BD_COMMISSION_ASSET_SYMBOLS = ("RCB", "USDT")
BD_COMMISSION_PAID_BIZ_TYPE = "BD_COMMISSION_CREDIT"
BD_ACCOUNT_ACTIVE_STATUS = "ACTIVE"
BD_ACCOUNT_INACTIVE_STATUS = "INACTIVE"
BD_ACCOUNT_DISABLED_STATUSES = {"INACTIVE", "DISABLED"}


class BdAccountStatusUpdateError(ValueError):
    pass


def _normalize_page(value: Any) -> int:
    try:
        page = int(value)
    except (TypeError, ValueError):
        return DEFAULT_PAGE
    return page if page > 0 else DEFAULT_PAGE


def _normalize_page_size(value: Any) -> int:
    try:
        page_size = int(value)
    except (TypeError, ValueError):
        return DEFAULT_PAGE_SIZE
    if page_size <= 0:
        return DEFAULT_PAGE_SIZE
    return min(page_size, MAX_PAGE_SIZE)


def _normalize_code(value: Any) -> str:
    return str(value or "").strip().upper()


def _fmt_decimal(value: Any, scale: int = 8) -> str:
    if value is None:
        return "0"
    if not isinstance(value, Decimal):
        value = Decimal(str(value))
    quantizer = Decimal("1").scaleb(-scale)
    rounded = value.quantize(quantizer, rounding=ROUND_HALF_UP)
    text = format(rounded, "f").rstrip("0").rstrip(".")
    return text or "0"


def _fmt_datetime(value: Any) -> Optional[str]:
    if not isinstance(value, datetime):
        return None
    return value.strftime("%Y-%m-%d %H:%M:%S")


def _rate_to_percent(value: Any) -> str:
    if value is None:
        return "-"
    if not isinstance(value, Decimal):
        value = Decimal(str(value))
    percent = (value * Decimal("100")).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    return f"{format(percent, 'f')}%"


def _bd_account_status_label(status: Any) -> str:
    normalized = _normalize_code(status)
    if normalized == BD_ACCOUNT_ACTIVE_STATUS:
        return "生效中"
    if normalized in BD_ACCOUNT_DISABLED_STATUSES:
        return "已停用"
    if normalized == "EXPIRED":
        return "已过期"
    return "未知"


def _bd_account_status_badge(status: Any) -> str:
    normalized = _normalize_code(status)
    if normalized == BD_ACCOUNT_ACTIVE_STATUS:
        return "success"
    if normalized in BD_ACCOUNT_DISABLED_STATUSES or normalized == "EXPIRED":
        return "danger"
    return "secondary"


def update_bd_account_status(db: Session, bd_user_id: int, *, active: bool) -> BdAccount:
    account = (
        db.query(BdAccount)
        .filter(BdAccount.user_id == int(bd_user_id))
        .with_for_update()
        .first()
    )
    if account is None:
        raise BdAccountStatusUpdateError("BD账号不存在")

    account.status = BD_ACCOUNT_ACTIVE_STATUS if active else "DISABLED"
    account.updated_at = datetime.utcnow()
    db.add(account)
    db.flush()
    return account


def _coin_amount_items(values: Dict[str, Decimal], precision: int = 2) -> list[Dict[str, str]]:
    if not values:
        return []
    sortable_items = []
    for coin_symbol, amount in values.items():
        normalized_symbol = _normalize_code(coin_symbol)
        if not normalized_symbol:
            continue
        try:
            raw_amount = Decimal(str(amount or 0))
        except Exception:
            raw_amount = Decimal("0")
        sortable_items.append((normalized_symbol, raw_amount))
    sortable_items.sort(key=lambda item: item[1], reverse=True)

    items = []
    for normalized_symbol, raw_amount in sortable_items:
        items.append(
            {
                "coin_symbol": normalized_symbol,
                "amount_display": _fmt_admin_amount_display(raw_amount, normalized_symbol),
                "amount_raw": format(raw_amount, "f"),
            }
        )
    return items


def _coin_amount_text(values: Dict[str, Decimal], precision: int = 2) -> str:
    items = _coin_amount_items(values, precision=precision)
    if not items:
        return "0"
    return " / ".join(f"{item['coin_symbol']} {item['amount_display']}" for item in items)


def _asset_totals_payload(values: Dict[str, Decimal]) -> Dict[str, str]:
    payload = {
        symbol: _fmt_admin_decimal(values.get(symbol, Decimal("0")), precision=2)
        for symbol in BD_COMMISSION_ASSET_SYMBOLS
    }
    for symbol in sorted(values):
        normalized_symbol = _normalize_code(symbol)
        if normalized_symbol and normalized_symbol not in payload:
            payload[normalized_symbol] = _fmt_admin_decimal(values[symbol], precision=2)
    return payload


def _zero_asset_totals_payload() -> Dict[str, str]:
    return _asset_totals_payload({})


def _empty_coin_totals() -> Dict[str, Decimal]:
    return defaultdict(lambda: Decimal("0"))


def _sum_record_amounts_by_coin(
    db: Session,
    bd_user_ids: Iterable[int],
    amount_column: Any,
    status: Optional[str] = None,
    coin_column: Any = None,
    created_from: Optional[datetime] = None,
) -> Dict[int, Dict[str, Decimal]]:
    ids = [int(item) for item in bd_user_ids]
    if not ids:
        return {}

    coin_expr = coin_column if coin_column is not None else BdCommissionRecord.fee_coin_symbol
    query = (
        db.query(
            BdCommissionRecord.bd_user_id,
            coin_expr,
            func.coalesce(func.sum(amount_column), Decimal("0")),
        )
        .filter(BdCommissionRecord.bd_user_id.in_(ids))
    )
    if status:
        query = query.filter(BdCommissionRecord.status == status)
    if created_from:
        query = query.filter(BdCommissionRecord.created_at >= created_from)

    rows = query.group_by(
        BdCommissionRecord.bd_user_id,
        coin_expr,
    ).all()

    result: Dict[int, Dict[str, Decimal]] = defaultdict(_empty_coin_totals)
    for bd_user_id, coin_symbol, amount in rows:
        result[int(bd_user_id)][_normalize_code(coin_symbol)] += Decimal(str(amount or 0))
    return result


def _latest_commission_times(db: Session, bd_user_ids: Iterable[int]) -> Dict[int, Optional[str]]:
    ids = [int(item) for item in bd_user_ids]
    if not ids:
        return {}

    rows = (
        db.query(
            BdCommissionRecord.bd_user_id,
            func.max(BdCommissionRecord.created_at),
        )
        .filter(BdCommissionRecord.bd_user_id.in_(ids))
        .group_by(BdCommissionRecord.bd_user_id)
        .all()
    )
    return {int(bd_user_id): _fmt_datetime(latest_at) for bd_user_id, latest_at in rows}


def _active_relation_counts(db: Session, bd_user_ids: Iterable[int]) -> Dict[int, int]:
    ids = [int(item) for item in bd_user_ids]
    if not ids:
        return {}

    rows = (
        db.query(BdUserRelation.bd_user_id, func.count(BdUserRelation.id))
        .filter(
            BdUserRelation.bd_user_id.in_(ids),
            BdUserRelation.status == "ACTIVE",
        )
        .group_by(BdUserRelation.bd_user_id)
        .all()
    )
    return {int(bd_user_id): int(count or 0) for bd_user_id, count in rows}


def get_admin_bd_team_stats(
    db: Session,
    page: int = 1,
    page_size: int = 20,
    status: Optional[str] = None,
    bd_user_id: Optional[str] = None,
) -> Dict[str, Any]:
    page = _normalize_page(page)
    page_size = _normalize_page_size(page_size)

    query = db.query(BdAccount)

    normalized_status = _normalize_code(status)
    if normalized_status:
        if normalized_status == "DISABLED":
            query = query.filter(BdAccount.status.in_(BD_ACCOUNT_DISABLED_STATUSES))
        else:
            query = query.filter(BdAccount.status == normalized_status)

    bd_user_id_text = str(bd_user_id or "").strip()
    if bd_user_id_text.isdigit():
        query = query.filter(BdAccount.user_id == int(bd_user_id_text))

    total = int(query.count())
    accounts = (
        query.order_by(BdAccount.created_at.desc(), BdAccount.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )

    bd_user_ids = [int(account.user_id) for account in accounts]
    relation_counts = _active_relation_counts(db, bd_user_ids)
    original_fee_totals = _sum_record_amounts_by_coin(
        db,
        bd_user_ids,
        BdCommissionRecord.original_fee_amount,
    )
    commission_totals = _sum_record_amounts_by_coin(
        db,
        bd_user_ids,
        BdCommissionRecord.commission_amount,
        coin_column=func.coalesce(BdCommissionRecord.commission_asset_symbol, "RCB"),
    )
    pending_totals = _sum_record_amounts_by_coin(
        db,
        bd_user_ids,
        BdCommissionRecord.commission_amount,
        status="PENDING",
        coin_column=func.coalesce(BdCommissionRecord.commission_asset_symbol, "RCB"),
    )
    paid_totals = _sum_record_amounts_by_coin(
        db,
        bd_user_ids,
        BdCommissionRecord.commission_amount,
        status="PAID",
        coin_column=func.coalesce(BdCommissionRecord.commission_asset_symbol, "RCB"),
    )
    cutoff_30d = datetime.utcnow() - timedelta(days=30)
    volume_30d_totals = _sum_record_amounts_by_coin(
        db,
        bd_user_ids,
        BdCommissionRecord.original_fee_amount,
        created_from=cutoff_30d,
    )
    latest_times = _latest_commission_times(db, bd_user_ids)

    items = []
    for account in accounts:
        bd_id = int(account.user_id)
        status = _normalize_code(account.status) or BD_ACCOUNT_ACTIVE_STATUS
        summary_fields = _summary_totals_fields(
            original_fee_totals=original_fee_totals.get(bd_id, {}),
            commission_totals=commission_totals.get(bd_id, {}),
            pending_totals=pending_totals.get(bd_id, {}),
            paid_totals=paid_totals.get(bd_id, {}),
            paid_amounts=paid_totals.get(bd_id, {}),
        )
        items.append(
            {
                "bd_user_id": bd_id,
                "bd_level": account.bd_level,
                "commission_rate": _fmt_decimal(account.commission_rate, scale=6),
                "commission_rate_percent": _rate_to_percent(account.commission_rate),
                "invite_code": account.invite_code,
                "status": status,
                "status_label": _bd_account_status_label(status),
                "status_badge": _bd_account_status_badge(status),
                "can_disable": status == BD_ACCOUNT_ACTIVE_STATUS,
                "can_enable": status in BD_ACCOUNT_DISABLED_STATUSES,
                "source_type": SOURCE_BD,
                "source_label": "BD",
                "source_badge": "info",
                "bound_user_count": relation_counts.get(bd_id, 0),
                "direct_user_count": relation_counts.get(bd_id, 0),
                "team_user_count": relation_counts.get(bd_id, 0),
                "volume_30d": _coin_amount_text(volume_30d_totals.get(bd_id, {})),
                "volume_30d_items": _coin_amount_items(volume_30d_totals.get(bd_id, {})),
                **summary_fields,
                "latest_commission_at": latest_times.get(bd_id) or "-",
            }
        )

    try:
        bd_count = int(db.query(func.count(BdAccount.id)).scalar() or 0)
    except Exception:
        bd_count = 0
    try:
        subordinate_count = int(
            db.query(func.count(BdUserRelation.id))
            .filter(BdUserRelation.status == "ACTIVE")
            .scalar()
            or 0
        )
    except Exception:
        subordinate_count = 0
    try:
        volume_rows = (
            db.query(
                BdCommissionRecord.fee_coin_symbol,
                func.coalesce(func.sum(BdCommissionRecord.original_fee_amount), Decimal("0")),
            )
            .filter(BdCommissionRecord.created_at >= cutoff_30d)
            .group_by(BdCommissionRecord.fee_coin_symbol)
            .all()
        )
        volume_30d_total = _coin_amount_text(
            {_normalize_code(symbol): Decimal(str(amount or 0)) for symbol, amount in volume_rows}
        )
        volume_30d_total_items = _coin_amount_items(
            {_normalize_code(symbol): Decimal(str(amount or 0)) for symbol, amount in volume_rows}
        )
    except Exception:
        volume_30d_total = "0"
        volume_30d_total_items = []
    try:
        commission_rows = (
            db.query(
                func.coalesce(BdCommissionRecord.commission_asset_symbol, "RCB"),
                func.coalesce(func.sum(BdCommissionRecord.commission_amount), Decimal("0")),
            )
            .group_by(func.coalesce(BdCommissionRecord.commission_asset_symbol, "RCB"))
            .all()
        )
        commission_total = _coin_amount_text(
            {_normalize_code(symbol): Decimal(str(amount or 0)) for symbol, amount in commission_rows}
        )
        commission_total_items = _coin_amount_items(
            {_normalize_code(symbol): Decimal(str(amount or 0)) for symbol, amount in commission_rows}
        )
    except Exception:
        commission_total = "0"
        commission_total_items = []

    return {
        "items": items,
        "total": total,
        "page": page,
        "page_size": page_size,
        "pages": max(1, ceil(total / page_size)) if page_size else 1,
        "stats": {
            "bd_count": bd_count,
            "subordinate_count": subordinate_count,
            "volume_30d_total": volume_30d_total,
            "volume_30d_total_items": volume_30d_total_items,
            "commission_total": commission_total,
            "commission_total_items": commission_total_items,
        },
    }


def _get_paid_rcb_total(db: Session, bd_user_id: int) -> Decimal:
    return _get_paid_totals_by_asset(db, bd_user_id).get(BD_COMMISSION_SETTLEMENT_SYMBOL, Decimal("0"))


def _get_paid_totals_by_asset(db: Session, bd_user_id: int) -> Dict[str, Decimal]:
    rows = (
        db.query(
            BalanceLog.coin_symbol,
            func.coalesce(func.sum(BalanceLog.change_amount), Decimal("0")),
        )
        .filter(
            BalanceLog.user_id == bd_user_id,
            BalanceLog.chain_key == "funding",
            BalanceLog.biz_type == BD_COMMISSION_PAID_BIZ_TYPE,
        )
        .group_by(BalanceLog.coin_symbol)
        .all()
    )
    totals: Dict[str, Decimal] = defaultdict(lambda: Decimal("0"))
    for coin_symbol, amount in rows:
        normalized_symbol = _normalize_code(coin_symbol) or BD_COMMISSION_SETTLEMENT_SYMBOL
        totals[normalized_symbol] += Decimal(str(amount or 0))
    return totals


def _summary_totals_fields(
    *,
    original_fee_totals: Dict[str, Decimal],
    commission_totals: Dict[str, Decimal],
    pending_totals: Dict[str, Decimal],
    paid_totals: Dict[str, Decimal],
    paid_amounts: Optional[Dict[str, Decimal]] = None,
) -> Dict[str, Any]:
    total_payload = _asset_totals_payload(commission_totals)
    pending_payload = _asset_totals_payload(pending_totals)
    paid_payload = _asset_totals_payload(paid_totals)
    return {
        "total_original_fee": _coin_amount_text(original_fee_totals),
        "total_original_fee_items": _coin_amount_items(original_fee_totals),
        "total_original_fee_by_asset": _asset_totals_payload(original_fee_totals),
        "total_commission": _coin_amount_text(commission_totals),
        "total_commission_items": _coin_amount_items(commission_totals),
        "pending_commission": _coin_amount_text(pending_totals),
        "pending_commission_items": _coin_amount_items(pending_totals),
        "paid_commission": _coin_amount_text(paid_totals),
        "paid_commission_items": _coin_amount_items(paid_totals),
        "total_commission_by_asset": total_payload,
        "pending_commission_by_asset": pending_payload,
        "paid_commission_by_asset": paid_payload,
        "total_totals_by_asset": total_payload,
        "pending_totals_by_asset": pending_payload,
        "paid_totals_by_asset": paid_payload,
        "paid_amounts_by_asset": _asset_totals_payload(paid_amounts or {}),
        "settlement_asset_symbol": "MULTI",
        "settlement_asset_symbols": list(BD_COMMISSION_ASSET_SYMBOLS),
    }


def _empty_summary_totals_fields() -> Dict[str, Any]:
    return _summary_totals_fields(
        original_fee_totals={},
        commission_totals={},
        pending_totals={},
        paid_totals={},
        paid_amounts={},
    )


def get_my_bd_team_overview(
    db: Session,
    user_id: int,
    page: int = 1,
    page_size: int = 10,
) -> Dict[str, Any]:
    page = _normalize_page(page)
    page_size = _normalize_page_size(page_size)

    account = db.query(BdAccount).filter(BdAccount.user_id == int(user_id)).first()
    if not account:
        return {
            "is_bd": False,
            "account": None,
            "summary": {
                "bound_user_count": 0,
                "paid_rcb_amount": "0",
                **_empty_summary_totals_fields(),
                "source_type": "NONE",
                "source_label": "无",
                "latest_commission_at": None,
            },
            "records": [],
            "total": 0,
            "page": page,
            "page_size": page_size,
            "pages": 1,
        }

    account_status = _normalize_code(account.status) or BD_ACCOUNT_ACTIVE_STATUS
    if account_status != BD_ACCOUNT_ACTIVE_STATUS:
        return {
            "is_bd": False,
            "account": {
                "bd_user_id": int(account.user_id),
                "bd_level": account.bd_level,
                "commission_rate": _fmt_decimal(account.commission_rate, scale=6),
                "commission_rate_percent": _rate_to_percent(account.commission_rate),
                "invite_code": account.invite_code,
                "status": account_status,
            },
            "summary": {
                "bound_user_count": 0,
                "paid_rcb_amount": "0",
                **_empty_summary_totals_fields(),
                "source_type": "NONE",
                "source_label": "BD资格已停用",
                "latest_commission_at": None,
            },
            "records": [],
            "total": 0,
            "page": page,
            "page_size": page_size,
            "pages": 1,
        }

    bd_user_id = int(account.user_id)
    original_fee_totals = _sum_record_amounts_by_coin(
        db,
        [bd_user_id],
        BdCommissionRecord.original_fee_amount,
    ).get(bd_user_id, {})
    commission_totals = _sum_record_amounts_by_coin(
        db,
        [bd_user_id],
        BdCommissionRecord.commission_amount,
        coin_column=func.coalesce(BdCommissionRecord.commission_asset_symbol, "RCB"),
    ).get(bd_user_id, {})
    pending_totals = _sum_record_amounts_by_coin(
        db,
        [bd_user_id],
        BdCommissionRecord.commission_amount,
        status="PENDING",
        coin_column=func.coalesce(BdCommissionRecord.commission_asset_symbol, "RCB"),
    ).get(bd_user_id, {})
    paid_totals = _sum_record_amounts_by_coin(
        db,
        [bd_user_id],
        BdCommissionRecord.commission_amount,
        status="PAID",
        coin_column=func.coalesce(BdCommissionRecord.commission_asset_symbol, "RCB"),
    ).get(bd_user_id, {})
    paid_amounts = _get_paid_totals_by_asset(db, bd_user_id)
    latest_times = _latest_commission_times(db, [bd_user_id])
    records_query = (
        db.query(BdCommissionRecord)
        .filter(BdCommissionRecord.bd_user_id == bd_user_id)
        .order_by(BdCommissionRecord.created_at.desc(), BdCommissionRecord.id.desc())
    )
    records_total = int(records_query.count())
    records = records_query.offset((page - 1) * page_size).limit(page_size).all()

    return {
        "is_bd": True,
        "account": {
            "bd_user_id": bd_user_id,
            "bd_level": account.bd_level,
            "commission_rate": _fmt_decimal(account.commission_rate, scale=6),
            "commission_rate_percent": _rate_to_percent(account.commission_rate),
            "invite_code": account.invite_code,
            "status": _normalize_code(account.status),
        },
        "summary": {
            "bound_user_count": _active_relation_counts(db, [bd_user_id]).get(bd_user_id, 0),
            **_summary_totals_fields(
                original_fee_totals=original_fee_totals,
                commission_totals=commission_totals,
                pending_totals=pending_totals,
                paid_totals=paid_totals,
                paid_amounts=paid_amounts,
            ),
            "paid_rcb_amount": _fmt_decimal(paid_amounts.get(BD_COMMISSION_SETTLEMENT_SYMBOL, Decimal("0"))),
            "source_type": SOURCE_BD,
            "source_label": "BD渠道",
            "latest_commission_at": latest_times.get(bd_user_id),
        },
        "records": [
            {
                "id": int(record.id),
                "source_user_id": int(record.user_id),
                "order_id": int(record.order_id) if record.order_id is not None else None,
                "trade_id": int(record.trade_id) if record.trade_id is not None else None,
                "fee_coin_symbol": _normalize_code(record.fee_coin_symbol),
                "original_fee_amount": _fmt_decimal(record.original_fee_amount),
                "commission_rate": _fmt_decimal(record.commission_rate, scale=6),
                "commission_amount": _fmt_decimal(record.commission_amount),
                "commission_asset_symbol": _normalize_code(record.commission_asset_symbol) or BD_COMMISSION_SETTLEMENT_SYMBOL,
                "pool_amount": _fmt_decimal(record.pool_amount),
                "status": _normalize_code(record.status),
                "paid_at": _fmt_datetime(record.paid_at),
                "created_at": _fmt_datetime(record.created_at),
            }
            for record in records
        ],
        "total": records_total,
        "page": page,
        "page_size": page_size,
        "pages": max(1, ceil(records_total / page_size)) if page_size else 1,
    }
