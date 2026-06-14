from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal, ROUND_HALF_UP, ROUND_UP
from typing import Any, Dict, Iterable, Optional

from sqlalchemy import bindparam, text
from sqlalchemy.orm import Session

from app.core.redis import get_redis


logger = logging.getLogger(__name__)

COST_QUANT = Decimal("0.000001")
FEE_QUANT = Decimal("0.001")
DEFAULT_WITHDRAW_FEE = Decimal("0.005")
DEFAULT_FEE_MIN = Decimal("0.005")
DEFAULT_FEE_MAX = Decimal("100")
DEFAULT_MULTIPLIER = Decimal("1.3")
DEFAULT_UPDATE_THRESHOLD = Decimal("0.001")
MAX_SINGLE_CHANGE_RATIO = Decimal("0.20")


@dataclass(frozen=True)
class ConfiguredWithdrawFee:
    chain_id: int
    symbol: str
    chain_key: str
    fee: Decimal
    source: str = "NETWORK_CONFIG"
    last_estimated_cost: Optional[Decimal] = None
    suggested_fee: Optional[Decimal] = None
    last_estimated_at: Optional[datetime] = None
    last_error: str = ""

    def api_debug(self) -> Dict[str, Any]:
        return {
            "fee_source": self.source,
            "fee_coin": "USDT",
            "fee_currency": "USDT",
            "raw_fee_usdt": _fmt_cost(self.last_estimated_cost) if self.last_estimated_cost is not None else None,
            "suggested_fee": _fmt_fee(self.suggested_fee) if self.suggested_fee is not None else None,
            "last_estimated_at": self.last_estimated_at.isoformat() if self.last_estimated_at else None,
            "fallback_reason": self.last_error,
        }


def _decimal(value: Any, default: Decimal = Decimal("0")) -> Decimal:
    if value is None or value == "":
        return default
    try:
        return Decimal(str(value))
    except Exception:
        return default


def quantize_withdraw_fee(value: Decimal) -> Decimal:
    return value.quantize(FEE_QUANT, rounding=ROUND_UP)


def _fmt_cost(value: Decimal) -> str:
    return str(value.quantize(COST_QUANT, rounding=ROUND_HALF_UP))


def _fmt_fee(value: Decimal) -> str:
    return str(quantize_withdraw_fee(value))


def _fee_key(chain_key: str) -> str:
    return f"withdraw_fee:{chain_key.strip().lower()}"


def _estimate_key(chain_key: str) -> str:
    return f"withdraw_fee_estimate:{chain_key.strip().lower()}"


def _redis_set_json(key: str, payload: Dict[str, Any], ttl_seconds: int = 7 * 24 * 3600) -> None:
    try:
        get_redis().set(key, json.dumps(payload, ensure_ascii=False, default=str), ex=ttl_seconds)
    except Exception as exc:
        logger.debug("[withdraw-fee-cache] redis set failed key=%s error=%s", key, exc)


def _redis_set_value(key: str, value: Decimal, ttl_seconds: int = 7 * 24 * 3600) -> None:
    try:
        get_redis().set(key, _fmt_fee(value), ex=ttl_seconds)
    except Exception as exc:
        logger.debug("[withdraw-fee-cache] redis set failed key=%s error=%s", key, exc)


def get_configured_withdraw_fee(db: Session, symbol: str, chain_key: str) -> Optional[ConfiguredWithdrawFee]:
    sym = (symbol or "").strip().upper()
    ck = (chain_key or "").strip().lower()
    row = db.execute(
        text(
            """
            SELECT
              c.id AS chain_id,
              COALESCE(c.withdraw_fee, ac.withdraw_fee, 0.005) AS withdraw_fee,
              CASE WHEN c.withdraw_fee IS NULL THEN 'ASSET_CHAIN_FALLBACK' ELSE 'NETWORK_CONFIG' END AS fee_source,
              COALESCE(c.withdraw_fee_last_estimated, ac.withdraw_fee_last_estimated_cost) AS withdraw_fee_last_estimated,
              COALESCE(c.withdraw_fee_last_suggested, ac.withdraw_fee_suggested) AS withdraw_fee_last_suggested,
              COALESCE(c.withdraw_fee_last_updated_at, ac.withdraw_fee_last_estimated_at) AS withdraw_fee_last_updated_at,
              COALESCE(c.withdraw_fee_last_error, ac.withdraw_fee_last_error) AS withdraw_fee_last_error
            FROM asset_chains ac
            JOIN assets a ON a.id = ac.asset_id
            JOIN chains c ON c.id = ac.chain_id
            WHERE UPPER(a.symbol) = :sym
              AND LOWER(c.chain_key) = :ck
              AND a.enabled = 1
              AND c.enabled = 1
              AND ac.enabled = 1
              AND ac.withdraw_enabled = 1
            LIMIT 1
            """
        ),
        {"sym": sym, "ck": ck},
    ).mappings().first()
    if not row:
        return None

    fee = quantize_withdraw_fee(_decimal(row.get("withdraw_fee"), DEFAULT_WITHDRAW_FEE))
    result = ConfiguredWithdrawFee(
        chain_id=int(row["chain_id"]),
        symbol=sym,
        chain_key=ck,
        fee=fee,
        source=str(row.get("fee_source") or "NETWORK_CONFIG"),
        last_estimated_cost=_decimal(row.get("withdraw_fee_last_estimated")) if row.get("withdraw_fee_last_estimated") is not None else None,
        suggested_fee=quantize_withdraw_fee(_decimal(row.get("withdraw_fee_last_suggested"))) if row.get("withdraw_fee_last_suggested") is not None else None,
        last_estimated_at=row.get("withdraw_fee_last_updated_at"),
        last_error=str(row.get("withdraw_fee_last_error") or ""),
    )
    _redis_set_value(_fee_key(ck), fee)
    return result


def calculate_suggested_fee(real_cost: Decimal, multiplier: Decimal, min_fee: Decimal, max_fee: Decimal) -> Decimal:
    suggested = real_cost * multiplier
    if suggested < min_fee:
        suggested = min_fee
    if max_fee > 0 and suggested > max_fee:
        suggested = max_fee
    return quantize_withdraw_fee(suggested)


def _limit_single_change(current_fee: Decimal, suggested_fee: Decimal, min_fee: Decimal, max_fee: Decimal) -> Decimal:
    if current_fee <= 0:
        limited = suggested_fee
    else:
        lower = current_fee * (Decimal("1") - MAX_SINGLE_CHANGE_RATIO)
        upper = current_fee * (Decimal("1") + MAX_SINGLE_CHANGE_RATIO)
        limited = min(max(suggested_fee, lower), upper)
    if limited < min_fee:
        limited = min_fee
    if max_fee > 0 and limited > max_fee:
        limited = max_fee
    return quantize_withdraw_fee(limited)


def _estimate_chain_cost(db: Session, symbol: str, chain_key: str):
    # Keep the chain/RPC estimator out of user request paths. This import is
    # local to avoid a module import cycle with app.routers.asset_withdraw.
    from app.routers.asset_withdraw import estimate_fee_usdt_detail

    return estimate_fee_usdt_detail(db, symbol, chain_key, None)


def _representative_symbol_for_chain(db: Session, chain_id: int) -> Optional[str]:
    row = db.execute(
        text(
            """
            SELECT UPPER(a.symbol) AS symbol
            FROM asset_chains ac
            JOIN assets a ON a.id = ac.asset_id
            WHERE ac.chain_id = :chain_id
              AND a.enabled = 1
              AND ac.enabled = 1
              AND ac.withdraw_enabled = 1
              AND ac.contract_address IS NOT NULL
              AND TRIM(ac.contract_address) <> ''
            ORDER BY CASE WHEN UPPER(a.symbol) = 'USDT' THEN 0 ELSE 1 END, ac.sort ASC, ac.id ASC
            LIMIT 1
            """
        ),
        {"chain_id": int(chain_id)},
    ).mappings().first()
    return str(row.get("symbol") or "").strip().upper() if row else None


def maintain_withdraw_fee_once(db: Session, chain_keys: Optional[Iterable[str]] = None) -> Dict[str, Any]:
    chain_filter = tuple(sorted({str(item).strip().lower() for item in (chain_keys or []) if str(item).strip()}))
    params: Dict[str, Any] = {}
    chain_sql = ""
    if chain_filter:
        chain_sql = "AND LOWER(c.chain_key) IN :chain_keys"
        params["chain_keys"] = chain_filter

    query = text(
        f"""
            SELECT
              c.id,
              LOWER(c.chain_key) AS chain_key,
              COALESCE(c.withdraw_fee, 0.005) AS withdraw_fee,
              COALESCE(c.withdraw_fee_auto_enabled, 0) AS withdraw_fee_auto_enabled,
              COALESCE(c.withdraw_fee_min, 0.005) AS withdraw_fee_min,
              COALESCE(c.withdraw_fee_max, 100) AS withdraw_fee_max,
              COALESCE(c.withdraw_fee_multiplier, 1.3) AS withdraw_fee_multiplier,
              COALESCE(c.withdraw_fee_update_threshold, 0.001) AS withdraw_fee_update_threshold
            FROM chains c
            WHERE c.enabled = 1
              AND COALESCE(c.withdraw_fee_auto_enabled, 0) = 1
              {chain_sql}
            ORDER BY c.chain_key ASC, c.id ASC
            """
    )
    if chain_filter:
        query = query.bindparams(bindparam("chain_keys", expanding=True))
    rows = db.execute(query, params).mappings().all()

    scanned = len(rows)
    estimated = 0
    updated = 0
    failed = 0
    skipped = 0
    details: list[dict[str, Any]] = []
    now = datetime.utcnow()

    for row in rows:
        chain_id = int(row["id"])
        chain_key = str(row["chain_key"])
        symbol = _representative_symbol_for_chain(db, chain_id)
        current_fee = quantize_withdraw_fee(_decimal(row.get("withdraw_fee"), DEFAULT_WITHDRAW_FEE))
        auto_enabled = int(row.get("withdraw_fee_auto_enabled") or 0) == 1
        min_fee = quantize_withdraw_fee(_decimal(row.get("withdraw_fee_min"), DEFAULT_FEE_MIN))
        max_fee = quantize_withdraw_fee(_decimal(row.get("withdraw_fee_max"), DEFAULT_FEE_MAX))
        multiplier = _decimal(row.get("withdraw_fee_multiplier"), DEFAULT_MULTIPLIER)
        threshold = _decimal(row.get("withdraw_fee_update_threshold"), DEFAULT_UPDATE_THRESHOLD)

        try:
            if not symbol:
                raise RuntimeError("no withdraw-enabled token contract configured for this chain")
            estimate = _estimate_chain_cost(db, symbol, chain_key)
            if estimate.raw_fee_usdt is None:
                raise RuntimeError(estimate.fallback_reason or f"fee estimate unavailable: {estimate.fee_source}")
            real_cost = estimate.raw_fee_usdt
            suggested_fee = calculate_suggested_fee(real_cost, multiplier, min_fee, max_fee)
            applied_fee = suggested_fee if auto_enabled else current_fee
            should_update = auto_enabled and applied_fee != current_fee
            db.execute(
                text(
                    """
                    UPDATE chains
                    SET withdraw_fee = :withdraw_fee,
                        withdraw_fee_last_estimated = :real_cost,
                        withdraw_fee_last_suggested = :suggested_fee,
                        withdraw_fee_last_updated_at = :now,
                        withdraw_fee_last_error = NULL,
                        updated_at = :now
                    WHERE id = :id
                    """
                ),
                {
                    "id": chain_id,
                    "withdraw_fee": applied_fee,
                    "real_cost": real_cost,
                    "suggested_fee": suggested_fee,
                    "now": now,
                },
            )
            if should_update:
                updated += 1
            else:
                skipped += 1

            estimated += 1
            _redis_set_value(_fee_key(chain_key), applied_fee)
            _redis_set_json(
                _estimate_key(chain_key),
                {
                    "chain_key": chain_key,
                    "representative_symbol": symbol,
                    "real_cost": _fmt_cost(real_cost),
                    "estimated_cost": _fmt_cost(real_cost),
                    "suggested_fee": _fmt_fee(suggested_fee),
                    "applied_fee": _fmt_fee(applied_fee),
                    "current_fee": _fmt_fee(applied_fee),
                    "previous_fee": _fmt_fee(current_fee),
                    "fee_source": estimate.fee_source,
                    "estimated_at": now.isoformat(),
                },
            )
            details.append(
                {
                    "chain_id": chain_id,
                    "representative_symbol": symbol,
                    "chain_key": chain_key,
                    "status": "UPDATED" if should_update else "ESTIMATED",
                    "estimated_cost": _fmt_cost(real_cost),
                    "real_cost": _fmt_cost(real_cost),
                    "suggested_fee": _fmt_fee(suggested_fee),
                    "applied_fee": _fmt_fee(applied_fee),
                    "current_fee": _fmt_fee(applied_fee),
                    "previous_fee": _fmt_fee(current_fee),
                    "auto_enabled": auto_enabled,
                }
            )
        except Exception as exc:
            failed += 1
            error_message = (str(exc) or exc.__class__.__name__)[:512]
            logger.warning(
                "[withdraw-fee-maintenance] estimate failed chain_id=%s symbol=%s chain=%s error=%s",
                chain_id,
                symbol,
                chain_key,
                error_message,
            )
            db.execute(
                text(
                    """
                    UPDATE chains
                    SET withdraw_fee_last_error = :error,
                        withdraw_fee_last_updated_at = :now
                    WHERE id = :id
                    """
                ),
                {"id": chain_id, "error": error_message, "now": now},
            )
            _redis_set_json(
                _estimate_key(chain_key),
                {
                    "chain_key": chain_key,
                    "representative_symbol": symbol,
                    "error": error_message,
                    "estimated_at": now.isoformat(),
                },
            )
            details.append(
                {
                    "chain_id": chain_id,
                    "representative_symbol": symbol,
                    "chain_key": chain_key,
                    "status": "FAILED",
                    "error": error_message,
                    "auto_enabled": auto_enabled,
                }
            )

    return {
        "scanned": scanned,
        "estimated": estimated,
        "updated": updated,
        "skipped": skipped,
        "failed": failed,
        "details": details,
    }
