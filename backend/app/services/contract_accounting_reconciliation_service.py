from __future__ import annotations

from datetime import datetime, timedelta
from decimal import Decimal
from typing import Any, Optional

from sqlalchemy import text
from sqlalchemy.orm import Session


DEFAULT_EPSILON = Decimal("0.00000001")
DEFAULT_LIMIT = 200


def _utc_window(start_at: Optional[datetime] = None, end_at: Optional[datetime] = None) -> tuple[datetime, datetime]:
    end = end_at or datetime.utcnow()
    start = start_at or (end - timedelta(days=1))
    return start, end


def _normalize_value(value: Any) -> Any:
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, datetime):
        return value.isoformat(sep=" ")
    return value


def _rows(db: Session, sql: str, params: dict[str, Any]) -> list[dict[str, Any]]:
    result = db.execute(text(sql), params).mappings().all()
    return [{key: _normalize_value(value) for key, value in row.items()} for row in result]


def _count(db: Session, sql: str, params: dict[str, Any]) -> int:
    row = db.execute(text(sql), params).mappings().first()
    if not row:
        return 0
    return int(row.get("cnt") or 0)


def build_contract_accounting_reconciliation_report(
    db: Session,
    *,
    start_at: Optional[datetime] = None,
    end_at: Optional[datetime] = None,
    limit: int = DEFAULT_LIMIT,
    epsilon: Decimal = DEFAULT_EPSILON,
) -> dict[str, Any]:
    start, end = _utc_window(start_at=start_at, end_at=end_at)
    params = {
        "start_at": start,
        "end_at": end,
        "limit": max(1, int(limit or DEFAULT_LIMIT)),
        "epsilon": epsilon,
    }

    order_spread_mismatches = _rows(
        db,
        """
        SELECT
            o.id AS order_id,
            o.user_id,
            o.symbol,
            o.action,
            COALESCE(o.spread_fee, 0) AS order_spread_fee,
            COALESCE(SUM(COALESCE(t.spread_fee, 0)), 0) AS trade_spread_fee,
            COUNT(t.id) AS trade_count,
            MAX(t.created_at) AS last_trade_at
        FROM contract_trades t
        INNER JOIN contract_orders o ON o.id = t.order_id
        WHERE t.created_at >= :start_at AND t.created_at < :end_at
        GROUP BY o.id, o.user_id, o.symbol, o.action, o.spread_fee
        HAVING ABS(COALESCE(o.spread_fee, 0) - COALESCE(SUM(COALESCE(t.spread_fee, 0)), 0)) > :epsilon
        ORDER BY last_trade_at DESC
        LIMIT :limit
        """,
        params,
    )

    realized_pnl_margin_mismatches = _rows(
        db,
        """
        SELECT
            t.id AS trade_id,
            t.order_id,
            t.user_id,
            t.symbol,
            t.action,
            COALESCE(t.realized_pnl, 0) AS trade_realized_pnl,
            COALESCE(SUM(CASE WHEN cml.change_type = 'REALIZED_PNL' THEN COALESCE(cml.change_amount, 0) ELSE 0 END), 0)
                AS margin_log_realized_pnl,
            t.created_at
        FROM contract_trades t
        LEFT JOIN contract_margin_logs cml ON cml.trade_id = t.id
        WHERE t.created_at >= :start_at
          AND t.created_at < :end_at
          AND t.action = 'CLOSE'
        GROUP BY t.id, t.order_id, t.user_id, t.symbol, t.action, t.realized_pnl, t.created_at
        HAVING ABS(
            COALESCE(t.realized_pnl, 0)
            - COALESCE(SUM(CASE WHEN cml.change_type = 'REALIZED_PNL' THEN COALESCE(cml.change_amount, 0) ELSE 0 END), 0)
        ) > :epsilon
        ORDER BY t.created_at DESC
        LIMIT :limit
        """,
        params,
    )

    realized_pnl_balance_mismatches = _rows(
        db,
        """
        SELECT
            t.id AS trade_id,
            t.order_id,
            t.user_id,
            t.symbol,
            t.action,
            COALESCE(t.realized_pnl, 0) AS trade_realized_pnl,
            COALESCE(SUM(CASE
                WHEN bl.change_type IN ('CONTRACT_REALIZED_PNL', 'CONTRACT_LIQUIDATION')
                THEN COALESCE(bl.change_amount, 0)
                ELSE 0
            END), 0) AS balance_log_realized_pnl,
            t.created_at
        FROM contract_trades t
        LEFT JOIN balance_logs bl ON bl.trade_id = t.id
        WHERE t.created_at >= :start_at
          AND t.created_at < :end_at
          AND t.action = 'CLOSE'
        GROUP BY t.id, t.order_id, t.user_id, t.symbol, t.action, t.realized_pnl, t.created_at
        HAVING ABS(
            COALESCE(t.realized_pnl, 0)
            - COALESCE(SUM(CASE
                WHEN bl.change_type IN ('CONTRACT_REALIZED_PNL', 'CONTRACT_LIQUIDATION')
                THEN COALESCE(bl.change_amount, 0)
                ELSE 0
            END), 0)
        ) > :epsilon
        ORDER BY t.created_at DESC
        LIMIT :limit
        """,
        params,
    )

    margin_amount_mismatches = _rows(
        db,
        """
        SELECT
            t.id AS trade_id,
            t.order_id,
            t.user_id,
            t.symbol,
            t.action,
            COALESCE(t.margin_amount, 0) AS trade_margin_amount,
            COALESCE(SUM(CASE
                WHEN t.action = 'OPEN' AND cml.change_type = 'OPEN_MARGIN_USED' THEN COALESCE(cml.change_amount, 0)
                WHEN t.action = 'CLOSE' AND cml.change_type = 'CLOSE_RELEASE' THEN COALESCE(cml.change_amount, 0)
                ELSE 0
            END), 0) AS margin_log_amount,
            t.created_at
        FROM contract_trades t
        LEFT JOIN contract_margin_logs cml ON cml.trade_id = t.id
        WHERE t.created_at >= :start_at AND t.created_at < :end_at
        GROUP BY t.id, t.order_id, t.user_id, t.symbol, t.action, t.margin_amount, t.created_at
        HAVING ABS(
            COALESCE(t.margin_amount, 0)
            - COALESCE(SUM(CASE
                WHEN t.action = 'OPEN' AND cml.change_type = 'OPEN_MARGIN_USED' THEN COALESCE(cml.change_amount, 0)
                WHEN t.action = 'CLOSE' AND cml.change_type = 'CLOSE_RELEASE' THEN COALESCE(cml.change_amount, 0)
                ELSE 0
            END), 0)
        ) > :epsilon
        ORDER BY t.created_at DESC
        LIMIT :limit
        """,
        params,
    )

    balance_log_duplicates = _rows(
        db,
        """
        SELECT
            trade_id,
            change_type,
            biz_type,
            COUNT(1) AS duplicate_count,
            COALESCE(SUM(change_amount), 0) AS total_change_amount,
            MIN(created_at) AS first_created_at,
            MAX(created_at) AS last_created_at
        FROM balance_logs
        WHERE trade_id IS NOT NULL
          AND created_at >= :start_at
          AND created_at < :end_at
        GROUP BY trade_id, change_type, biz_type
        HAVING COUNT(1) > 1
        ORDER BY duplicate_count DESC, last_created_at DESC
        LIMIT :limit
        """,
        params,
    )

    margin_log_duplicates = _rows(
        db,
        """
        SELECT
            trade_id,
            change_type,
            COUNT(1) AS duplicate_count,
            COALESCE(SUM(change_amount), 0) AS total_change_amount,
            MIN(created_at) AS first_created_at,
            MAX(created_at) AS last_created_at
        FROM contract_margin_logs
        WHERE trade_id IS NOT NULL
          AND created_at >= :start_at
          AND created_at < :end_at
        GROUP BY trade_id, change_type
        HAVING COUNT(1) > 1
        ORDER BY duplicate_count DESC, last_created_at DESC
        LIMIT :limit
        """,
        params,
    )

    balance_spread_entries = _rows(
        db,
        """
        SELECT
            trade_id,
            user_id,
            change_type,
            biz_type,
            COUNT(1) AS entry_count,
            COALESCE(SUM(change_amount), 0) AS total_change_amount,
            MAX(created_at) AS last_created_at
        FROM balance_logs
        WHERE created_at >= :start_at
          AND created_at < :end_at
          AND (change_type = 'CONTRACT_SPREAD_FEE' OR biz_type = 'CONTRACT_SPREAD_FEE')
        GROUP BY trade_id, user_id, change_type, biz_type
        ORDER BY entry_count DESC, last_created_at DESC
        LIMIT :limit
        """,
        params,
    )

    margin_spread_entries = _rows(
        db,
        """
        SELECT
            trade_id,
            user_id,
            change_type,
            COUNT(1) AS entry_count,
            COALESCE(SUM(change_amount), 0) AS total_change_amount,
            MAX(created_at) AS last_created_at
        FROM contract_margin_logs
        WHERE created_at >= :start_at
          AND created_at < :end_at
          AND change_type IN ('OPEN_FEE', 'CLOSE_FEE')
        GROUP BY trade_id, user_id, change_type
        ORDER BY entry_count DESC, last_created_at DESC
        LIMIT :limit
        """,
        params,
    )

    mismatch_report = {
        "order_spread_mismatches": order_spread_mismatches,
        "realized_pnl_margin_mismatches": realized_pnl_margin_mismatches,
        "realized_pnl_balance_mismatches": realized_pnl_balance_mismatches,
        "margin_amount_mismatches": margin_amount_mismatches,
    }
    duplicate_report = {
        "balance_log_duplicates": balance_log_duplicates,
        "margin_log_duplicates": margin_log_duplicates,
        "balance_spread_entries": balance_spread_entries,
        "margin_spread_entries": margin_spread_entries,
    }
    mismatch_count = sum(len(items) for items in mismatch_report.values())
    duplicate_count = sum(len(items) for items in duplicate_report.values())

    return {
        "ok": mismatch_count == 0 and duplicate_count == 0,
        "window": {"start_at": start.isoformat(sep=" "), "end_at": end.isoformat(sep=" ")},
        "summary": {
            "trade_count": _count(
                db,
                "SELECT COUNT(1) AS cnt FROM contract_trades WHERE created_at >= :start_at AND created_at < :end_at",
                params,
            ),
            "mismatch_count": mismatch_count,
            "duplicate_count": duplicate_count,
        },
        "mismatch_report": mismatch_report,
        "duplicate_report": duplicate_report,
    }
