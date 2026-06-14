# backend/app/jobs/withdraw_tx_watcher.py
from __future__ import annotations

import logging
import os
import re
import threading
from datetime import datetime
from decimal import Decimal
from typing import Optional, Dict, Any, List, Tuple

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.core.chain_config import get_runtime_chain_config
from app.services.solana_client import get_solana_transaction_status_with_rpc_fallback

try:
    from web3 import Web3  # pip install web3
except Exception:  # pragma: no cover
    Web3 = None  # type: ignore


DEFAULT_INTERVAL_SECONDS = int(os.getenv("WITHDRAW_WATCH_INTERVAL", "20"))
DEFAULT_MAX_BATCH = int(os.getenv("WITHDRAW_WATCH_MAX_BATCH", "50"))
DEFAULT_CONFIRMATIONS_FALLBACK = int(os.getenv("WITHDRAW_WATCH_CONFIRMATIONS", "1"))
LOG_ON = os.getenv("WITHDRAW_WATCH_LOG", "1") == "1"
logger = logging.getLogger(__name__)
TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"

# cache
_BAL_COL_CACHE: Optional[Tuple[str, str, Optional[str]]] = None
_BALLOG_COLS_CACHE: Optional[Dict[str, Dict[str, Any]]] = None  # col -> meta


def _utcnow() -> datetime:
    return datetime.utcnow()


def _log(*args):
    if not LOG_ON:
        return
    logger.info("[withdraw_watcher] %s", " ".join(str(arg) for arg in args))


def _safe_int(x, default=0) -> int:
    try:
        return int(x)
    except Exception:
        return default


def _to_dec(x) -> Decimal:
    if x is None:
        return Decimal("0")
    if isinstance(x, Decimal):
        return x
    try:
        return Decimal(str(x))
    except Exception:
        return Decimal("0")


def _decimal_to_raw(amount: Decimal, decimals: int) -> int:
    return int((amount * (Decimal(10) ** int(decimals))).to_integral_value())


def _normalize_address(address: Any) -> str:
    return str(address or "").strip().lower()


def _field(obj: Any, name: str, default: Any = None) -> Any:
    if isinstance(obj, dict):
        return obj.get(name, default)
    return getattr(obj, name, default)


def _hex_string(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value if value.startswith("0x") else f"0x{value}"
    if isinstance(value, int):
        return hex(value)
    if hasattr(value, "hex"):
        raw = value.hex()
        return raw if raw.startswith("0x") else f"0x{raw}"
    raw = str(value)
    return raw if raw.startswith("0x") else f"0x{raw}"


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


def _receipt_logs(receipt: Any) -> List[Any]:
    logs = _field(receipt, "logs", [])
    return list(logs or [])


def _extract_erc20_transfers(receipt: Any, token_contract: str) -> List[Dict[str, Any]]:
    token = _normalize_address(token_contract)
    transfers: List[Dict[str, Any]] = []
    for log in _receipt_logs(receipt):
        if _normalize_address(_field(log, "address")) != token:
            continue
        topics = list(_field(log, "topics", []) or [])
        if len(topics) < 3 or _hex_string(topics[0]).lower() != TRANSFER_TOPIC:
            continue
        try:
            transfers.append(
                {
                    "from": _topic_to_address(topics[1]),
                    "to": _topic_to_address(topics[2]),
                    "value_raw": _data_to_int(_field(log, "data")),
                }
            )
        except Exception as exc:
            logger.warning("[withdraw_watcher] skip malformed transfer log error=%s", exc)
    return transfers


def _is_safe_col(name: str) -> bool:
    return bool(re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name or ""))


def _first_hit(cols: List[str], candidates: List[str]) -> Optional[str]:
    s = set(cols)
    for c in candidates:
        if c in s:
            return c
    return None


# =========================
# Detect user_balances columns (legacy helper, kept)
# =========================
def _detect_user_balances_cols(db: Session) -> Tuple[str, str, Optional[str]]:
    global _BAL_COL_CACHE
    if _BAL_COL_CACHE is not None:
        return _BAL_COL_CACHE

    rows = db.execute(text("SHOW COLUMNS FROM user_balances")).mappings().all()
    cols = [str(r["Field"]) for r in rows if r.get("Field")]

    available_col = _first_hit(
        cols,
        ["available", "available_amount", "available_balance", "avail", "free", "free_amount", "free_balance"],
    )
    frozen_col = _first_hit(
        cols,
        ["frozen", "frozen_amount", "frozen_balance", "locked", "locked_amount", "locked_balance", "hold", "on_hold"],
    )
    updated_at_col = _first_hit(cols, ["updated_at", "update_time", "modified_at"])

    if not available_col or not frozen_col:
        raise RuntimeError("user_balances columns not recognized")

    if not (
        _is_safe_col(available_col)
        and _is_safe_col(frozen_col)
        and (updated_at_col is None or _is_safe_col(updated_at_col))
    ):
        raise RuntimeError("Unsafe column name in user_balances")

    _BAL_COL_CACHE = (available_col, frozen_col, updated_at_col)
    return _BAL_COL_CACHE


# =========================
# Detect balance_logs columns (optional, kept)
# =========================
def _detect_balance_logs_cols(db: Session) -> Optional[Dict[str, Dict[str, Any]]]:
    global _BALLOG_COLS_CACHE
    if _BALLOG_COLS_CACHE is not None:
        return _BALLOG_COLS_CACHE

    try:
        db.execute(text("SELECT 1 FROM balance_logs LIMIT 1"))
    except Exception:
        _BALLOG_COLS_CACHE = None
        return None

    rows = db.execute(text("SHOW COLUMNS FROM balance_logs")).mappings().all()
    meta: Dict[str, Dict[str, Any]] = {}
    for r in rows:
        col = str(r.get("Field") or "")
        if not col:
            continue
        meta[col] = {
            "nullable": (str(r.get("Null") or "") == "YES"),
            "default": r.get("Default"),
            "extra": str(r.get("Extra") or ""),
        }

    _BALLOG_COLS_CACHE = meta
    return meta


# =========================
# Chain RPC map
# =========================
def _merge_rpc_urls(*groups: List[str]) -> List[str]:
    seen: set[str] = set()
    urls: List[str] = []
    for group in groups:
        for item in group:
            url = (item or "").strip()
            if not url or url in seen:
                continue
            seen.add(url)
            urls.append(url)
    return urls


def _get_chain_rpc_map(db: Session) -> Dict[str, Dict[str, Any]]:
    rows = db.execute(
        text(
            """
            SELECT chain_key, native_symbol, confirmations, rpc_url
            FROM chains
            WHERE enabled = 1
            """
        )
    ).mappings().all()

    m: Dict[str, Dict[str, Any]] = {}
    for r in rows:
        ck = (r.get("chain_key") or "").strip().lower()
        if not ck:
            continue
        try:
            runtime_cfg = get_runtime_chain_config(db, ck)
            rpc_urls = list(runtime_cfg.rpc_urls)
            confirmations = runtime_cfg.confirmations
            name = runtime_cfg.native_symbol or ck
        except Exception:
            rpc_urls = _merge_rpc_urls([(r.get("rpc_url") or "").strip()])
            confirmations = _safe_int(r.get("confirmations"), DEFAULT_CONFIRMATIONS_FALLBACK)
            name = (r.get("native_symbol") or ck).strip()
        if not rpc_urls:
            continue
        m[ck] = {
            "rpc_urls": rpc_urls,
            "confirmations": confirmations,
            "name": name,
        }
    return m


# =========================
# Withdraw fetch & web3
# =========================
def _fetch_sent_withdraws(db: Session, limit: int) -> List[Dict[str, Any]]:
    rows = db.execute(
        text(
            """
            SELECT id, user_id, coin_symbol, chain_key, to_address, tx_hash, amount, fee, net_amount, status
            FROM withdraw_logs
            WHERE status IN ('SENT', 'SENDING')
              AND tx_hash IS NOT NULL
              AND tx_hash <> ''
            ORDER BY id ASC
            LIMIT :limit
            """
        ),
        {"limit": limit},
    ).mappings().all()
    return [dict(r) for r in rows]


def _get_w3(rpc_url: str):
    if Web3 is None:
        raise RuntimeError("web3 is not installed")
    from app.services.rpc_no_proxy import build_web3_no_proxy

    return build_web3_no_proxy(rpc_url, timeout=10)


def _get_receipt_with_rpc_fallback(rpc_urls: List[str], tx_hash: str):
    last_error: Optional[Exception] = None
    for rpc_url in rpc_urls:
        try:
            w3 = _get_w3(rpc_url)
            if hasattr(w3, "is_connected") and not w3.is_connected():
                continue
            receipt, block_number = _get_receipt_and_block(w3, tx_hash)
            if receipt is not None:
                return receipt, block_number
        except Exception as exc:
            last_error = exc
            continue
    if last_error is not None:
        raise last_error
    return None, None


def _get_receipt_and_block(w3, tx_hash: str):
    try:
        receipt = w3.eth.get_transaction_receipt(tx_hash)
        bn = getattr(receipt, "blockNumber", None)
        return receipt, bn
    except Exception:
        return None, None


def _receipt_status_value(receipt) -> Optional[int]:
    raw = getattr(receipt, "status", None)
    if raw is None and isinstance(receipt, dict):
        raw = receipt.get("status")
    if raw is None:
        return None
    try:
        return int(raw)
    except Exception:
        pass
    if isinstance(raw, (bytes, bytearray)):
        try:
            return int.from_bytes(raw, "big")
        except Exception:
            return None
    if isinstance(raw, str):
        try:
            return int(raw, 16 if raw.lower().startswith("0x") else 10)
        except Exception:
            return None
    return None


def _get_tx_status_with_rpc_fallback(chain_key: str, rpc_urls: List[str], tx_hash: str):
    if (chain_key or "").strip().lower() == "solana":
        receipt = get_solana_transaction_status_with_rpc_fallback(rpc_urls, tx_hash)
        if receipt is None:
            return None, None
        return receipt.status, receipt.slot
    receipt, receipt_bn = _get_receipt_with_rpc_fallback(rpc_urls, tx_hash)
    if receipt is None:
        return None, None
    return _receipt_status_value(receipt), receipt_bn


def _amt_to_settle(row):
    return _to_dec(row.get("amount"))


def _load_token_withdraw_meta(db: Session, row: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    meta = db.execute(
        text(
            """
            SELECT
                ac.contract_address,
                ac.decimals,
                c.hot_wallet_address,
                c.collection_address
            FROM asset_chains ac
            JOIN assets a ON a.id = ac.asset_id
            JOIN chains c ON c.id = ac.chain_id
            WHERE a.symbol = :symbol
              AND c.chain_key = :chain_key
              AND a.enabled = 1
              AND c.enabled = 1
              AND ac.enabled = 1
            LIMIT 1
            """
        ),
        {
            "symbol": str(row.get("coin_symbol") or "").strip().upper(),
            "chain_key": str(row.get("chain_key") or "").strip().lower(),
        },
    ).mappings().first()
    return dict(meta) if meta else None


def _mark_withdraw_confirm_failed(db: Session, wid: int, message: str) -> None:
    now = _utcnow()
    reason = (message or "链上转账校验失败：收款地址或金额不一致")[:255]
    columns = db.execute(
        text(
            """
            SELECT COLUMN_NAME AS column_name
            FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME = 'withdraw_logs'
              AND COLUMN_NAME IN ('fail_reason', 'error_message', 'reason', 'remark')
            """
        )
    ).mappings().all()
    existing = {str(row.get("column_name") or "") for row in columns}
    reason_sql = ""
    for column in ("fail_reason", "error_message", "reason", "remark"):
        if column in existing:
            reason_sql = f", {column}=:reason"
            break

    db.execute(
        text(
            f"""
            UPDATE withdraw_logs
            SET status='SEND_FAILED',
                updated_at=:now
                {reason_sql}
            WHERE id=:id
              AND status IN ('SENT', 'SENDING')
              AND tx_hash IS NOT NULL
              AND tx_hash <> ''
            """
        ),
        {"id": int(wid), "now": now, "reason": reason},
    )
    db.commit()


def _validate_erc20_transfer(db: Session, row: Dict[str, Any], receipt: Any) -> Tuple[bool, str]:
    meta = _load_token_withdraw_meta(db, row)
    if not meta:
        return False, "链上转账校验失败：提现通道配置缺失"

    token_contract = str(meta.get("contract_address") or "").strip()
    if not token_contract:
        return True, "native coin skipped"

    decimals = _safe_int(meta.get("decimals"), 18)
    expected_to = _normalize_address(row.get("to_address"))
    expected_from = _normalize_address(meta.get("hot_wallet_address"))
    system_addresses = {
        item
        for item in (
            _normalize_address(meta.get("hot_wallet_address")),
            _normalize_address(meta.get("collection_address")),
        )
        if item
    }
    if expected_to in system_addresses:
        logger.error(
            "[withdraw_watcher] system address rejected withdraw_id=%s chain_key=%s coin_symbol=%s "
            "expected_to=%s tx_hash=%s",
            row.get("id"),
            row.get("chain_key"),
            row.get("coin_symbol"),
            expected_to,
            row.get("tx_hash"),
        )
        return False, "链上转账校验失败：收款地址为平台系统地址"

    expected_raw = _decimal_to_raw(_to_dec(row.get("net_amount")), decimals)
    transfers = _extract_erc20_transfers(receipt, token_contract)

    first_actual = transfers[0] if transfers else {}
    for transfer in transfers:
        actual_from = _normalize_address(transfer.get("from"))
        actual_to = _normalize_address(transfer.get("to"))
        actual_raw = int(transfer.get("value_raw") or 0)
        from_ok = not expected_from or actual_from == expected_from
        if from_ok and actual_to == expected_to and actual_raw == expected_raw:
            logger.info(
                "[withdraw_watcher] erc20 transfer verified withdraw_id=%s chain_key=%s coin_symbol=%s "
                "expected_to=%s actual_to=%s expected_raw=%s actual_raw=%s tx_hash=%s",
                row.get("id"),
                row.get("chain_key"),
                row.get("coin_symbol"),
                expected_to,
                actual_to,
                expected_raw,
                actual_raw,
                row.get("tx_hash"),
            )
            return True, "ok"

    logger.error(
        "[withdraw_watcher] erc20 transfer mismatch withdraw_id=%s chain_key=%s coin_symbol=%s "
        "expected_to=%s actual_to=%s expected_raw=%s actual_raw=%s tx_hash=%s",
        row.get("id"),
        row.get("chain_key"),
        row.get("coin_symbol"),
        expected_to,
        first_actual.get("to") or "",
        expected_raw,
        first_actual.get("value_raw", ""),
        row.get("tx_hash"),
    )
    return False, "链上转账校验失败：收款地址或金额不一致"


# =========================
# Settlement bridge (关键修复)
# =========================
def _settle_withdraw_success(db: Session, wid: int, tx_hash: str):
    """
    调用 asset_withdraw.py 里的幂等结算逻辑：扣 frozen + 写 balance_logs + 置 SUCCESS
    这里用“函数内导入”避免潜在循环引用。
    """
    from app.routers.asset_withdraw import _settle_success  # noqa

    _settle_success(db, wid, tx_hash, remark="withdraw_watcher", trace_id=None)


def _mark_withdraw_success_only(db: Session, wid: int, tx_hash: str) -> None:
    """
    Receipt-confirmed fallback: only repair withdraw_logs status/tx_hash.
    This deliberately does not send, freeze, unfreeze, or create balance logs.
    """
    now = _utcnow()
    res = db.execute(
        text(
            """
            UPDATE withdraw_logs
            SET status='SUCCESS',
                tx_hash=COALESCE(:tx_hash, tx_hash),
                updated_at=:now
            WHERE id=:id
              AND tx_hash IS NOT NULL
              AND tx_hash <> ''
              AND status IN ('SENT', 'SENDING')
            """
        ),
        {"tx_hash": tx_hash, "now": now, "id": wid},
    )
    if res.rowcount:
        db.commit()
    else:
        db.rollback()


def _settle_withdraw_failed(db: Session, wid: int, remark: str):
    """
    调用 asset_withdraw.py 里的幂等失败结算：退回 available + 扣 frozen + 置 FAILED
    """
    from app.routers.asset_withdraw import _settle_failed  # noqa

    _settle_failed(db, wid, remark=remark, trace_id=None)


# =========================
# Main loop
# =========================
def process_once(db: Session, max_batch: int = DEFAULT_MAX_BATCH) -> int:
    chain_map = _get_chain_rpc_map(db)
    items = _fetch_sent_withdraws(db, max_batch)

    # ✅ 没有待处理提现：直接返回，不打日志
    if not items:
        return 0

    _log(f"scan batch={len(items)}")

    for row in items:
        wid = _safe_int(row.get("id"))
        chain_key = (row.get("chain_key") or "").strip().lower()
        tx = (row.get("tx_hash") or "").strip()

        if not (wid and chain_key and tx):
            continue

        cfg = chain_map.get(chain_key)
        if not cfg:
            continue

        receipt = None
        try:
            if chain_key.lower() == "solana":
                status, _receipt_bn = _get_tx_status_with_rpc_fallback(chain_key, cfg["rpc_urls"], tx)
            else:
                receipt, _receipt_bn = _get_receipt_with_rpc_fallback(cfg["rpc_urls"], tx)
                status = _receipt_status_value(receipt) if receipt is not None else None
        except Exception as e:
            _log(f"skip wid={wid} chain={chain_key} reason=get_receipt_failed err={repr(e)}")
            continue
        if status is None:
            continue

        # ✅ 成功：做“结算扣冻”（幂等，重复跑也安全）
        if status == 1:
            if receipt is not None:
                ok, message = _validate_erc20_transfer(db, row, receipt)
                if not ok:
                    _mark_withdraw_confirm_failed(db, wid, message)
                    _log(f"CONFIRM_FAILED id={wid} chain={chain_key} tx={tx} reason={message}")
                    continue
            try:
                _log(f"SUCCESS id={wid} chain={chain_key} tx={tx}")
                _settle_withdraw_success(db, wid, tx)
            except Exception as e:
                # 不要让单次失败卡死整个 watcher
                _log(f"settle_success_error wid={wid} err={repr(e)}")
                db.rollback()
                try:
                    _mark_withdraw_success_only(db, wid, tx)
                    _log(f"status_success_only id={wid} chain={chain_key} tx={tx}")
                except Exception as mark_error:
                    _log(f"status_success_only_error wid={wid} err={repr(mark_error)}")
                    db.rollback()

        # ✅ 失败：做“退回解冻”（幂等）
        elif status == 0:
            try:
                _log(f"FAILED id={wid} chain={chain_key} tx={tx}")
                _settle_withdraw_failed(db, wid, remark="withdraw_watcher receipt status=0")
            except Exception as e:
                _log(f"settle_failed_error wid={wid} err={repr(e)}")
                db.rollback()

    # 结算函数内部已经 commit；这里再 commit 一次无害
    try:
        db.commit()
    except Exception:
        db.rollback()

    return len(items)


class WithdrawTxWatcher:
    def __init__(self, session_factory, interval_seconds: int = DEFAULT_INTERVAL_SECONDS):
        self.session_factory = session_factory
        self.interval_seconds = max(5, int(interval_seconds))
        self._stop = threading.Event()
        self._t: Optional[threading.Thread] = None

    def start(self):
        if self._t and self._t.is_alive():
            return
        self._stop.clear()
        self._t = threading.Thread(target=self._run, name="WithdrawTxWatcher", daemon=True)
        self._t.start()
        _log("thread started", f"interval={self.interval_seconds}s")

    def stop(self):
        self._stop.set()

    def _run(self):
        while not self._stop.is_set():
            try:
                with self.session_factory() as db:
                    process_once(db)
            except Exception as e:
                _log("loop error:", repr(e))
            self._stop.wait(self.interval_seconds)
