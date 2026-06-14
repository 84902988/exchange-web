from __future__ import annotations

from decimal import Decimal
from typing import Any, Dict, Iterable, List, Optional

from sqlalchemy import text
from sqlalchemy.orm import Session


RELEASABLE_WITHDRAW_STATUSES = {"FAILED", "FROZEN", "SEND_FAILED", "CANCELED", "PROCESSING", "APPROVED"}
FAILED_FROZEN_CANDIDATE_STATUSES = {"FAILED", "SEND_FAILED"}
FEE_CLOSE_CHANGE_TYPES = ("WITHDRAW_FEE_SUCCESS", "WITHDRAW_FEE_UNFREEZE", "WITHDRAW_FEE_CANCEL")
PRINCIPAL_CLOSE_CHANGE_TYPES = ("WITHDRAW_SUCCESS", "WITHDRAW_UNFREEZE", "WITHDRAW_CANCEL")


def _dec(value: Any) -> Decimal:
    if value is None:
        return Decimal("0")
    try:
        return Decimal(str(value))
    except Exception:
        return Decimal("0")


def _table_column_set(db: Session, table_name: str, candidates: Iterable[str]) -> set[str]:
    candidate_list = [str(column or "").strip() for column in candidates if str(column or "").strip()]
    if not candidate_list:
        return set()
    params = {f"col_{idx}": column for idx, column in enumerate(candidate_list)}
    placeholders = ", ".join(f":col_{idx}" for idx in range(len(candidate_list)))
    try:
        rows = db.execute(
            text(
                f"""
                SELECT COLUMN_NAME AS column_name
                FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA = DATABASE()
                  AND TABLE_NAME = :table_name
                  AND COLUMN_NAME IN ({placeholders})
                """
            ),
            {"table_name": table_name, **params},
        ).mappings().all()
    except Exception:
        return set()
    return {str(row.get("column_name") or "") for row in rows}


def _reason_expr(db: Session) -> str:
    candidates = ("error_message", "fail_reason", "reason", "remark", "risk_reason", "reject_reason")
    existing = _table_column_set(db, "withdraw_logs", candidates)
    ordered = [column for column in candidates if column in existing]
    if not ordered:
        return "NULL"
    return "COALESCE(" + ", ".join(f"NULLIF(w.{column}, '')" for column in ordered) + ")"


def _sum_change(db: Session, withdraw_id: int, change_types: Iterable[str], coin_symbol: Optional[str] = None) -> Decimal:
    types = tuple(change_types)
    if not types:
        return Decimal("0")
    params: Dict[str, Any] = {f"ct_{idx}": change_type for idx, change_type in enumerate(types)}
    placeholders = ", ".join(f":ct_{idx}" for idx in range(len(types)))
    coin_filter = ""
    if coin_symbol:
        coin_filter = "AND coin_symbol=:coin_symbol"
        params["coin_symbol"] = coin_symbol
    row = db.execute(
        text(
            f"""
            SELECT COALESCE(SUM(change_amount), 0) AS amount
            FROM balance_logs
            WHERE biz_type='WITHDRAW'
              AND biz_id=:biz_id
              {coin_filter}
              AND change_type IN ({placeholders})
            """
        ),
        {"biz_id": str(int(withdraw_id)), **params},
    ).mappings().first()
    return _dec(row.get("amount") if row else 0)


def frozen_remaining_for_withdraw(db: Session, row: Dict[str, Any]) -> Decimal:
    withdraw_id = int(row["id"])
    coin_symbol = str(row.get("coin_symbol") or "").strip().upper()
    principal_frozen = _sum_change(db, withdraw_id, ("WITHDRAW_FREEZE",), coin_symbol)
    principal_closed = _sum_change(db, withdraw_id, PRINCIPAL_CLOSE_CHANGE_TYPES, coin_symbol)
    fee_frozen = _sum_change(db, withdraw_id, ("WITHDRAW_FEE_FREEZE",), "USDT")
    fee_closed = _sum_change(db, withdraw_id, FEE_CLOSE_CHANGE_TYPES, "USDT")
    return (principal_frozen - principal_closed) + (fee_frozen - fee_closed)


def fee_ledger_missing(db: Session, row: Dict[str, Any]) -> bool:
    withdraw_id = int(row["id"])
    fee = _dec(row.get("fee"))
    if fee <= 0:
        return False
    fee_frozen = _sum_change(db, withdraw_id, ("WITHDRAW_FEE_FREEZE",), "USDT")
    fee_closed = _sum_change(db, withdraw_id, FEE_CLOSE_CHANGE_TYPES, "USDT")
    return fee_frozen <= 0 and fee_closed <= 0


def _base_item(row: Dict[str, Any], *, frozen_remaining: Optional[Decimal] = None) -> Dict[str, Any]:
    status = str(row.get("status") or "").strip().upper()
    tx_hash = str(row.get("tx_hash") or "").strip()
    remaining = _dec(frozen_remaining)
    return {
        "withdraw_id": int(row.get("id")),
        "id": int(row.get("id")),
        "user_id": row.get("user_id"),
        "coin": row.get("coin_symbol") or "",
        "coin_symbol": row.get("coin_symbol") or "",
        "chain": row.get("chain_key") or "",
        "chain_key": row.get("chain_key") or "",
        "amount": str(row.get("amount")),
        "fee": str(row.get("fee")),
        "net_amount": str(row.get("net_amount")),
        "frozen_remaining": str(remaining),
        "status": status,
        "tx_hash": tx_hash,
        "fail_reason": str(row.get("fail_reason") or "").strip(),
        "created_at": row.get("created_at"),
        "can_release_frozen": (
            not tx_hash
            and remaining > 0
            and status != "SUCCESS"
            and status in RELEASABLE_WITHDRAW_STATUSES
        ),
    }


def _fetch_withdraw_rows(db: Session, where_sql: str, params: Dict[str, Any], limit: int) -> List[Dict[str, Any]]:
    reason = _reason_expr(db)
    rows = db.execute(
        text(
            f"""
            SELECT
                w.id,
                w.user_id,
                w.coin_symbol,
                w.chain_key,
                w.amount,
                w.fee,
                w.net_amount,
                w.status,
                w.tx_hash,
                {reason} AS fail_reason,
                w.created_at
            FROM withdraw_logs w
            WHERE {where_sql}
            ORDER BY w.id DESC
            LIMIT :limit
            """
        ),
        {**params, "limit": int(limit)},
    ).mappings().all()
    return [dict(row) for row in rows]


def query_failed_frozen_candidates(db: Session, limit: int = 50) -> List[Dict[str, Any]]:
    rows = _fetch_withdraw_rows(
        db,
        "w.status IN ('FAILED', 'SEND_FAILED') AND (w.tx_hash IS NULL OR w.tx_hash = '')",
        {},
        limit * 3,
    )
    items: List[Dict[str, Any]] = []
    for row in rows:
        remaining = frozen_remaining_for_withdraw(db, row)
        if remaining > 0:
            items.append(_base_item(row, frozen_remaining=remaining))
        if len(items) >= limit:
            break
    return items


def query_fee_issues(db: Session, limit: int = 50) -> List[Dict[str, Any]]:
    rows = _fetch_withdraw_rows(db, "w.fee > 0", {}, limit * 3)
    items: List[Dict[str, Any]] = []
    for row in rows:
        remaining = frozen_remaining_for_withdraw(db, row)
        if fee_ledger_missing(db, row):
            item = _base_item(row, frozen_remaining=remaining)
            item["issue_reason"] = "缺少提现手续费冻结/扣减/解冻流水"
            if int(item["withdraw_id"]) == 71:
                item["suggestion"] = "历史手续费未扣，建议人工决定补扣或豁免"
            else:
                item["suggestion"] = "仅审计展示，不自动补扣"
            items.append(item)
        if len(items) >= limit:
            break
    return items


def query_precheck_failures(db: Session, limit: int = 50) -> List[Dict[str, Any]]:
    reason = _reason_expr(db)
    rows = db.execute(
        text(
            f"""
            SELECT
                w.id,
                w.user_id,
                w.coin_symbol,
                w.chain_key,
                w.amount,
                w.fee,
                w.net_amount,
                w.status,
                w.tx_hash,
                {reason} AS fail_reason,
                w.created_at
            FROM withdraw_logs w
            WHERE (w.tx_hash IS NULL OR w.tx_hash = '')
              AND {reason} LIKE 'PRECHECK:%'
            ORDER BY w.id DESC
            LIMIT :limit
            """
        ),
        {"limit": int(limit)},
    ).mappings().all()
    items: List[Dict[str, Any]] = []
    for row in rows:
        row_dict = dict(row)
        items.append(_base_item(row_dict, frozen_remaining=frozen_remaining_for_withdraw(db, row_dict)))
    return items


def query_amount_net_mismatch(db: Session, limit: int = 50) -> List[Dict[str, Any]]:
    rows = _fetch_withdraw_rows(
        db,
        "w.amount <> w.net_amount",
        {},
        limit,
    )
    return [_base_item(row, frozen_remaining=frozen_remaining_for_withdraw(db, row)) for row in rows]


def query_withdraw_anomalies(db: Session, limit: int = 50) -> Dict[str, Any]:
    safe_limit = max(1, min(int(limit or 50), 100))
    failed_frozen_candidates = query_failed_frozen_candidates(db, safe_limit)
    fee_issues = query_fee_issues(db, safe_limit)
    precheck_failures = query_precheck_failures(db, safe_limit)
    amount_net_mismatch = query_amount_net_mismatch(db, safe_limit)
    return {
        "failed_frozen_candidates": failed_frozen_candidates,
        "fee_issues": fee_issues,
        "precheck_failures": precheck_failures,
        "amount_net_mismatch": amount_net_mismatch,
        "summary": {
            "failed_frozen_count": len(failed_frozen_candidates),
            "fee_issue_count": len(fee_issues),
            "precheck_failure_count": len(precheck_failures),
            "amount_net_mismatch_count": len(amount_net_mismatch),
        },
        "limit": safe_limit,
    }
