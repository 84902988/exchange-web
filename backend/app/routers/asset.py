from __future__ import annotations

import logging
from datetime import datetime
from decimal import Decimal
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.core.chain_capabilities import (
    READY,
    get_chain_runtime_status,
    is_chain_deposit_supported,
    is_chain_withdraw_supported,
)
from app.db.session import get_db
from app.deps.auth import get_current_user_id
from app.services.address_service import get_or_create_deposit_address
from app.services.balance import FUNDING_BALANCE_CHAIN_KEY, SPOT_BALANCE_CHAIN_KEY, transfer_available
from app.services.moralis_service import add_address_to_streams, get_stream_id_for_chain

router = APIRouter(prefix="/asset", tags=["asset"])
logger = logging.getLogger(__name__)

CONTRACT_BALANCE_ACCOUNT_KEY = "contract"
CONTRACT_BALANCE_MARGIN_ASSET = "USDT"


class AssetTransferIn(BaseModel):
    symbol: str = Field(..., description="coin symbol, e.g. USDT")
    from_account: str = Field(..., description="source account: funding or spot")
    to_account: str = Field(..., description="destination account: funding or spot")
    amount: Decimal = Field(..., description="transfer amount")


# -------------------------
# helpers
# -------------------------
def _ok(data: Any, trace_id: Optional[str]):
    return {"ok": True, "data": data, "error": None, "trace_id": trace_id}


def _d(v: Any) -> str:
    """Convert Decimal or numeric values to strings for JSON safety."""
    if v is None:
        return "0"
    if isinstance(v, Decimal):
        return format(v, "f")
    return str(v)


def _sum_balance_rows(
    rows: List[Dict[str, Any]],
    *,
    key_field: str,
) -> List[Dict[str, str]]:
    grouped: Dict[str, Dict[str, Decimal]] = {}
    for row in rows:
        key = str(row.get(key_field) or "").strip()
        if not key:
            continue
        current = grouped.setdefault(
            key,
            {"available": Decimal("0"), "frozen": Decimal("0")},
        )
        current["available"] += Decimal(str(row.get("available") or "0"))
        current["frozen"] += Decimal(str(row.get("frozen") or "0"))

    return [
        {
            key_field: key,
            "available": _d(values["available"]),
            "frozen": _d(values["frozen"]),
            "total": _d(values["available"] + values["frozen"]),
        }
        for key, values in sorted(grouped.items())
    ]


def _require(v: str, name: str) -> str:
    s = (v or "").strip()
    if not s:
        raise HTTPException(
            status_code=400,
            detail={"code": "BAD_REQUEST", "message": f"{name} is required"},
        )
    return s


def _norm_chain_key(v: str) -> str:
    """
    Normalize network input into the internal chain_key format.
    - bsc / BNB / Binance Smart Chain -> bsc
    - polygon / matic -> polygon
    """
    s = (v or "").strip().lower()
    if s in ("bsc", "bnb", "binance", "binance smart chain"):
        return "bsc"
    if s in ("polygon", "matic"):
        return "polygon"
    return s


def _norm_account_key(v: str) -> str:
    return (v or "").strip().lower()


def _parse_iso_dt(s: Optional[str], name: str) -> Optional[datetime]:
    if not s:
        return None
    try:
        ss = s.strip().replace(" ", "T")
        if ss.endswith("Z"):
            ss = ss[:-1]
        return datetime.fromisoformat(ss)
    except Exception:
        raise HTTPException(
            status_code=400,
            detail={"code": "BAD_REQUEST", "message": f"invalid {name}: {s}"},
        )


def _has_column(db: Session, table: str, column: str) -> bool:
    """
    Compatibility helper for older databases that may not have the
    watch_registered-related columns yet.
    """
    try:
        row = db.execute(
            text(
                """
                SELECT 1 AS ok
                FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA = DATABASE()
                  AND TABLE_NAME = :t
                  AND COLUMN_NAME = :c
                LIMIT 1
                """
            ),
            {"t": table, "c": column},
        ).mappings().first()
        return bool(row)
    except Exception:
        return False


def _first_existing_column(db: Session, table: str, candidates: List[str]) -> Optional[str]:
    for column in candidates:
        if _has_column(db, table, column):
            return column
    return None


def _get_chain_db_id(db: Session, chain_key: str) -> Optional[int]:
    try:
        row = db.execute(
            text(
                """
                SELECT id
                FROM chains
                WHERE LOWER(chain_key) = :ck
                LIMIT 1
                """
            ),
            {"ck": (chain_key or "").strip().lower()},
        ).mappings().first()
        return int(row["id"]) if row else None
    except Exception as exc:
        db.rollback()
        logger.warning("[asset-watch] resolve chain_id failed chain=%s error=%r", chain_key, exc)
        return None


def _short_address(address: str) -> str:
    value = (address or "").strip()
    if len(value) <= 18:
        return value
    return f"{value[:10]}...{value[-6:]}"


def _sync_watch_registration_state(
    db: Session,
    user_id: int,
    chain_key: str,
    address_lower: str,
    *,
    ok: bool,
    err: Optional[str],
    chain_db_id: Optional[int] = None,
    stream_id: Optional[str] = None,
) -> None:
    """
    Persist the Moralis watch-registration status when the optional columns exist.
    - ok=True  -> watch_registered=1, watch_registered_at=UTC_TIMESTAMP(), err=NULL
    - ok=False -> watch_registered=0, err=...
    """
    status_col = _first_existing_column(db, "user_chain_addresses", ["moralis_watch_registered", "watch_registered"])
    if not status_col:
        return
    chain_db_id = chain_db_id or _get_chain_db_id(db, chain_key)
    if chain_db_id is None:
        logger.warning(
            "[asset-watch] skip state sync: chain id missing chain=%s address=%s",
            chain_key,
            _short_address(address_lower),
        )
        return

    try:
        set_clauses = [f"{status_col} = :registered"]
        params: Dict[str, Any] = {
            "registered": 1 if ok else 0,
            "uid": user_id,
            "chain_id": int(chain_db_id),
            "addr": address_lower,
        }

        synced_at_col = _first_existing_column(
            db, "user_chain_addresses", ["last_watch_sync_at", "watch_registered_at"]
        )
        if synced_at_col:
            set_clauses.append(f"{synced_at_col} = UTC_TIMESTAMP()")

        err_col = _first_existing_column(
            db,
            "user_chain_addresses",
            ["watch_register_err", "watch_register_error", "moralis_watch_register_err"],
        )
        if err_col:
            set_clauses.append(f"{err_col} = :err")
            params["err"] = None if ok else (err or "")[:250]

        stream_col = _first_existing_column(db, "user_chain_addresses", ["moralis_stream_id", "watch_stream_id"])
        if stream_col and stream_id:
            set_clauses.append(f"{stream_col} = :stream_id")
            params["stream_id"] = stream_id

        db.execute(
            text(
                f"""
                UPDATE user_chain_addresses
                SET {", ".join(set_clauses)}
                WHERE user_id = :uid
                  AND chain_id = :chain_id
                  AND LOWER(address) = :addr
                LIMIT 1
                """
            ),
            params,
        )
        db.commit()
    except Exception as exc:
        db.rollback()
        logger.warning(
            "[asset-watch] state sync failed chain=%s chain_id=%s address=%s error=%r",
            chain_key,
            chain_db_id,
            _short_address(address_lower),
            exc,
        )


def _is_already_watch_registered(
    db: Session,
    user_id: int,
    chain_key: str,
    address_lower: str,
    *,
    chain_db_id: Optional[int] = None,
) -> Optional[bool]:
    """
    Return:
      - True/False when the optional column exists and a row is checked
      - None when the optional column does not exist
    """
    status_col = _first_existing_column(db, "user_chain_addresses", ["moralis_watch_registered", "watch_registered"])
    if not status_col:
        return None
    chain_db_id = chain_db_id or _get_chain_db_id(db, chain_key)
    if chain_db_id is None:
        return False

    try:
        row = db.execute(
            text(
                f"""
                SELECT {status_col} AS watch_registered
                FROM user_chain_addresses
                WHERE user_id = :uid
                  AND chain_id = :chain_id
                  AND LOWER(address) = :addr
                LIMIT 1
                """
            ),
            {"uid": user_id, "chain_id": int(chain_db_id), "addr": address_lower},
        ).mappings().first()
        if not row:
            return False
        return bool(row.get("watch_registered", 0))
    except Exception as exc:
        db.rollback()
        logger.warning(
            "[asset-watch] registration lookup failed chain=%s chain_id=%s address=%s error=%r",
            chain_key,
            chain_db_id,
            _short_address(address_lower),
            exc,
        )
        return None


def _query_asset_chain_options(db: Session, *, scene: str) -> List[Dict[str, Any]]:
    if scene == "deposit":
        enabled_filter = "ac.deposit_enabled = 1"
    elif scene == "withdraw":
        enabled_filter = "ac.withdraw_enabled = 1"
    else:
        raise ValueError("unsupported asset option scene")

    if _has_column(db, "chains", "withdraw_fee") and _has_column(db, "asset_chains", "withdraw_fee"):
        withdraw_fee_expr = "COALESCE(c.withdraw_fee, ac.withdraw_fee, 0.005) AS withdraw_fee"
    elif _has_column(db, "chains", "withdraw_fee"):
        withdraw_fee_expr = "COALESCE(c.withdraw_fee, 0.005) AS withdraw_fee"
    elif _has_column(db, "asset_chains", "withdraw_fee"):
        withdraw_fee_expr = "COALESCE(ac.withdraw_fee, 0.005) AS withdraw_fee"
    else:
        withdraw_fee_expr = "CAST(0 AS DECIMAL(36, 18)) AS withdraw_fee"
    asset_sort_expr = (
        "a.sort_order AS asset_sort_order"
        if _has_column(db, "assets", "sort_order")
        else "0 AS asset_sort_order"
    )
    deposit_sort_expr = (
        "COALESCE(a.deposit_sort_order, 100) AS deposit_sort_order"
        if _has_column(db, "assets", "deposit_sort_order")
        else "100 AS deposit_sort_order"
    )
    deposit_quick_expr = (
        "COALESCE(a.deposit_quick_enabled, 1) AS deposit_quick_enabled"
        if _has_column(db, "assets", "deposit_quick_enabled")
        else "1 AS deposit_quick_enabled"
    )
    deposit_default_expr = (
        "COALESCE(a.deposit_default_enabled, 0) AS deposit_default_enabled"
        if _has_column(db, "assets", "deposit_default_enabled")
        else "0 AS deposit_default_enabled"
    )
    withdraw_sort_expr = (
        "COALESCE(a.withdraw_sort_order, 100) AS withdraw_sort_order"
        if _has_column(db, "assets", "withdraw_sort_order")
        else "100 AS withdraw_sort_order"
    )
    withdraw_quick_expr = (
        "COALESCE(a.withdraw_quick_enabled, 1) AS withdraw_quick_enabled"
        if _has_column(db, "assets", "withdraw_quick_enabled")
        else "1 AS withdraw_quick_enabled"
    )
    withdraw_default_expr = (
        "COALESCE(a.withdraw_default_enabled, 0) AS withdraw_default_enabled"
        if _has_column(db, "assets", "withdraw_default_enabled")
        else "0 AS withdraw_default_enabled"
    )
    chain_icon_expr = (
        "c.icon_url AS chain_icon_url"
        if _has_column(db, "chains", "icon_url")
        else "NULL AS chain_icon_url"
    )
    order_by = (
        "deposit_sort_order ASC, a.symbol ASC, ac.sort ASC, c.name ASC"
        if scene == "deposit"
        else "withdraw_sort_order ASC, a.symbol ASC, ac.sort ASC, c.name ASC"
    )

    rows = db.execute(
        text(
            f"""
            SELECT
              a.symbol AS coin_symbol,
              a.name AS coin_name,
              a.display_precision AS display_precision,
              a.icon_url AS icon_url,
              {asset_sort_expr},
              {deposit_sort_expr},
              {deposit_quick_expr},
              {deposit_default_expr},
              {withdraw_sort_expr},
              {withdraw_quick_expr},
              {withdraw_default_expr},

              c.chain_key AS chain_key,
              c.name AS chain_name,
              c.chain_id AS chain_id,
              {chain_icon_expr},
              ac.sort AS network_sort_order,

              ac.contract_address AS contract_address,
              ac.decimals AS decimals,
              ac.min_deposit AS min_deposit,
              ac.min_withdraw AS min_withdraw,
              {withdraw_fee_expr},
              ac.review_threshold_amount AS review_threshold_amount,
              COALESCE(ac.confirmations, c.confirmations) AS confirmations,
              ac.deposit_enabled AS deposit_enabled,
              ac.withdraw_enabled AS withdraw_enabled,
              a.enabled AS asset_enabled,
              c.enabled AS chain_enabled,
              ac.enabled AS asset_chain_enabled
            FROM asset_chains ac
            JOIN assets a ON a.id = ac.asset_id
            JOIN chains c ON c.id = ac.chain_id
            WHERE a.enabled = 1
              AND c.enabled = 1
              AND ac.enabled = 1
              AND {enabled_filter}
            ORDER BY {order_by}
            """
        )
    ).mappings().all()

    items: List[Dict[str, Any]] = []
    for row in rows:
        chain_key = str(row["chain_key"] or "").strip().lower()
        if get_chain_runtime_status(chain_key) != READY:
            continue
        if scene == "deposit" and not is_chain_deposit_supported(chain_key):
            continue
        if scene == "withdraw" and not is_chain_withdraw_supported(chain_key):
            continue

        item = {
            "coin_symbol": row["coin_symbol"],
            "coin_name": row["coin_name"],
            "display_precision": int(row["display_precision"] or 0),
            "icon_url": row.get("icon_url"),
            "asset_sort_order": int(row["asset_sort_order"] or 0),
            "chain_key": row["chain_key"],
            "chain_name": row["chain_name"],
            "chain_id": int(row["chain_id"] or 0),
            "chain_icon_url": row.get("chain_icon_url"),
            "network_icon_url": row.get("chain_icon_url"),
            "network_sort_order": int(row["network_sort_order"] or 0),
            "contract_address": row.get("contract_address"),
            "decimals": int(row["decimals"] or 0),
            "min_deposit": _d(row.get("min_deposit")),
            "min_withdraw": _d(row.get("min_withdraw")),
            "withdraw_fee": _d(row.get("withdraw_fee")),
            "review_threshold_amount": None if row.get("review_threshold_amount") is None else _d(row.get("review_threshold_amount")),
            "confirmations": int(row["confirmations"] or 0),
            "deposit_enabled": bool(row["deposit_enabled"]),
            "withdraw_enabled": bool(row["withdraw_enabled"]),
            "enabled": bool(row["asset_chain_enabled"]),
            "asset_enabled": bool(row["asset_enabled"]),
            "chain_enabled": bool(row["chain_enabled"]),
            "asset_chain_enabled": bool(row["asset_chain_enabled"]),
        }
        if scene == "deposit":
            item.update(
                {
                    "deposit_sort_order": int(row["deposit_sort_order"] if row["deposit_sort_order"] is not None else 100),
                    "deposit_quick_enabled": bool(row["deposit_quick_enabled"]),
                    "deposit_default_enabled": bool(row["deposit_default_enabled"]),
                }
            )
        if scene == "withdraw":
            item.update(
                {
                    "withdraw_sort_order": int(row["withdraw_sort_order"] if row["withdraw_sort_order"] is not None else 100),
                    "withdraw_quick_enabled": bool(row["withdraw_quick_enabled"]),
                    "withdraw_default_enabled": bool(row["withdraw_default_enabled"]),
                }
            )
        items.append(item)
    return items


# -------------------------
# Asset-chain options for deposit / withdraw pages
# -------------------------
@router.get("/deposit/options")
def list_deposit_options(request: Request, db: Session = Depends(get_db)):
    trace_id = getattr(request.state, "trace_id", None)
    items = _query_asset_chain_options(db, scene="deposit")
    default_item = next(
        (
            item
            for item in items
            if item.get("deposit_default_enabled") and item.get("deposit_enabled")
        ),
        items[0] if items else None,
    )
    return _ok(
        {
            "items": items,
            "default_asset_symbol": default_item.get("coin_symbol") if default_item else None,
        },
        trace_id,
    )


@router.get("/withdraw/options")
def list_withdraw_options(request: Request, db: Session = Depends(get_db)):
    trace_id = getattr(request.state, "trace_id", None)
    items = _query_asset_chain_options(db, scene="withdraw")
    default_item = next(
        (
            item
            for item in items
            if item.get("withdraw_default_enabled") and item.get("withdraw_enabled")
        ),
        items[0] if items else None,
    )
    return _ok(
        {
            "items": items,
            "default_asset_symbol": default_item.get("coin_symbol") if default_item else None,
        },
        trace_id,
    )


# -------------------------
# 1) GET /asset/coins
# -------------------------
@router.get("/coins")
def list_coins(request: Request, db: Session = Depends(get_db)):
    """Return enabled assets from the assets table."""
    trace_id = getattr(request.state, "trace_id", None)

    rows = db.execute(
        text(
            """
            SELECT id, symbol, name, asset_type, display_precision, enabled
            FROM assets
            WHERE enabled = 1
            ORDER BY id ASC
            """
        )
    ).mappings().all()

    data = [
        {
            "id": int(r["id"]),
            "symbol": r["symbol"],
            "name": r["name"],
            "asset_type": r["asset_type"],
            "display_precision": int(r["display_precision"] or 0),
            "enabled": bool(r["enabled"]),
        }
        for r in rows
    ]
    return _ok(data, trace_id)


# -------------------------
# 2) GET /asset/networks
# -------------------------
@router.get("/networks")
def list_networks(db: Session = Depends(get_db)) -> Dict[str, Any]:
    """Return enabled chain configuration rows."""
    rows = db.execute(
        text(
            """
            SELECT
              id,
              chain_key,
              name,
              chain_id,
              native_symbol,
              explorer_tx_url,
              confirmations,
              enabled
            FROM chains
            WHERE enabled = 1
            ORDER BY id ASC
            """
        )
    ).mappings().all()

    data: List[Dict[str, Any]] = []
    for r in rows:
        data.append(
            {
                "id": int(r["id"]),
                "code": r["chain_key"],
                "chain_key": r["chain_key"],
                "name": r["name"],
                "chain_id": int(r["chain_id"]),
                "native_symbol": r.get("native_symbol") or "",
                "explorer_tx_url": r.get("explorer_tx_url"),
                "confirmations": int(r["confirmations"]) if r["confirmations"] is not None else 0,
                "enabled": bool(r["enabled"]),
            }
        )

    return {"ok": True, "data": data}


# -------------------------
# internal: resolve asset + chain + asset_chain config
# -------------------------
def _resolve_asset_chain(db: Session, symbol: str, chain_key: str):
    symbol_u = (symbol or "").strip().upper()
    ck = _norm_chain_key(chain_key)

    row = db.execute(
        text(
            """
            SELECT
              a.id            AS asset_id,
              a.symbol        AS symbol,
              a.name          AS asset_name,
              a.asset_type    AS asset_type,
              a.display_precision AS display_precision,
              a.enabled       AS asset_enabled,

              c.id            AS chain_row_id,
              c.chain_key     AS chain_key,
              c.chain_id      AS evm_chain_id,
              c.name          AS chain_name,
              c.confirmations AS chain_default_confirmations,
              c.enabled       AS chain_enabled,

              ac.id               AS asset_chain_id,
              ac.contract_address AS contract_address,
              ac.decimals         AS decimals,
              ac.deposit_enabled  AS deposit_enabled,
              ac.withdraw_enabled AS withdraw_enabled,
              ac.enabled          AS asset_chain_enabled,
              ac.min_deposit      AS min_deposit,
              ac.min_withdraw     AS min_withdraw,
              ac.confirmations    AS confirmations_override
            FROM asset_chains ac
            JOIN assets a ON a.id = ac.asset_id
            JOIN chains c ON c.id = ac.chain_id
            WHERE a.symbol = :symbol
              AND LOWER(c.chain_key) = :chain_key
            LIMIT 1
            """
        ),
        {"symbol": symbol_u, "chain_key": ck},
    ).mappings().first()

    return row


# -------------------------
# 3) GET /asset/deposit/address
# -------------------------
@router.get("/deposit/address")
def get_deposit_address(
    request: Request,
    symbol: str,
    network: str,
    db: Session = Depends(get_db),
    user_id: int = Depends(get_current_user_id),
):
    trace_id = getattr(request.state, "trace_id", None)

    symbol_u = _require(symbol, "symbol").upper()
    chain_key = _norm_chain_key(_require(network, "network"))

    info = _resolve_asset_chain(db, symbol=symbol_u, chain_key=chain_key)
    if not info:
        raise HTTPException(
            status_code=404,
            detail={"code": "NOT_FOUND", "message": f"asset or chain not found: {symbol_u}-{chain_key}"},
        )

    if not bool(info["deposit_enabled"]):
        raise HTTPException(
            status_code=400,
            detail={"code": "DEPOSIT_DISABLED", "message": f"{symbol_u}-{chain_key} deposit disabled"},
        )
    if get_chain_runtime_status(chain_key) != READY or not is_chain_deposit_supported(chain_key):
        raise HTTPException(
            status_code=400,
            detail={"code": "DEPOSIT_UNSUPPORTED", "message": f"{symbol_u}-{chain_key} deposit not supported"},
        )

    if (
        not bool(info["asset_enabled"])
        or not bool(info["chain_enabled"])
        or not bool(info["asset_chain_enabled"])
    ):
        raise HTTPException(
            status_code=400,
            detail={"code": "ASSET_CHAIN_DISABLED", "message": f"{symbol_u}-{chain_key} disabled"},
        )

    try:
        address, memo = get_or_create_deposit_address(db, user_id=user_id, chain_key=chain_key)
        db.commit()
    except ValueError as e:
        raise HTTPException(status_code=400, detail={"code": "UNSUPPORTED_NETWORK", "message": str(e)})
    except RuntimeError as e:
        if chain_key == "solana":
            raise HTTPException(
                status_code=500,
                detail={"code": "ADDRESS_DERIVATION_FAILED", "message": "Solana 地址生成失败，请稍后重试"},
            )
        raise HTTPException(status_code=500, detail={"code": "ADDRESS_DERIVATION_FAILED", "message": str(e)})

    address_display = address if chain_key == "solana" else (address or "").lower()
    address_lookup = (address or "").lower()
    chain_db_id = _get_chain_db_id(db, chain_key)
    moralis_network_code = chain_key.upper()
    stream_id = get_stream_id_for_chain(db, moralis_network_code, chain_key=chain_key, chain_id=chain_db_id)

    try:
        already = _is_already_watch_registered(
            db,
            user_id=user_id,
            chain_key=chain_key,
            address_lower=address_lookup,
            chain_db_id=chain_db_id,
        )
        if already is True:
            pass
        else:
            registered = add_address_to_streams(
                network_code=moralis_network_code,
                address=address_display,
                db=db,
                chain_key=chain_key,
                chain_id=chain_db_id,
            )
            _sync_watch_registration_state(
                db,
                user_id=user_id,
                chain_key=chain_key,
                address_lower=address_lookup,
                ok=registered,
                err=None if registered else f"moralis stream registration failed or stream id missing: {moralis_network_code}",
                chain_db_id=chain_db_id,
                stream_id=stream_id,
            )
    except Exception as e:
        logger.warning(
            "[asset-watch] registration failed chain=%s chain_id=%s address=%s error=%r",
            chain_key,
            chain_db_id,
            _short_address(address_lookup),
            e,
        )
        _sync_watch_registration_state(
            db,
            user_id=user_id,
            chain_key=chain_key,
            address_lower=address_lookup,
            ok=False,
            err=str(e),
            chain_db_id=chain_db_id,
            stream_id=stream_id,
        )

    confirm_required = int(info["confirmations_override"] or info["chain_default_confirmations"] or 0)

    return _ok(
        {
            "symbol": symbol_u,
            "network": chain_key,
            "chain_id": int(info["evm_chain_id"]),
            "address": address_display,
            "memo": memo,
            "contract_address": info.get("contract_address"),
            "decimals": int(info["decimals"] or 0),
            "confirm_required": confirm_required,
            "deposit_enabled": bool(info["deposit_enabled"]),
            "withdraw_enabled": bool(info["withdraw_enabled"]),
            "min_deposit": _d(info.get("min_deposit")),
            "notice": [
                f"Please confirm that you selected the {chain_key} network.",
                (
                    f"Only deposit {symbol_u} to this address (contract: {info.get('contract_address')})."
                    if info.get("contract_address")
                    else f"Only deposit {symbol_u} to this address."
                ),
                "Deposits below the minimum amount may not be credited.",
            ],
        },
        trace_id,
    )


# -------------------------
# 4) GET /asset/balances
# -------------------------
@router.get("/balances")
def list_balances(
    request: Request,
    network: Optional[str] = None,
    db: Session = Depends(get_db),
    user_id: int = Depends(get_current_user_id),
):
    trace_id = getattr(request.state, "trace_id", None)

    params: Dict[str, Any] = {"user_id": user_id}
    net_filter_sql = ""
    if network:
        ck = _norm_chain_key(network)
        net_filter_sql = " AND LOWER(c.chain_key) = :chain_key "
        params["chain_key"] = ck

    rows = db.execute(
        text(
            f"""
            SELECT
              a.symbol AS symbol,
              a.name AS name,
              a.asset_type AS asset_type,
              a.display_precision AS display_precision,

              c.chain_key AS chain_key,
              c.chain_id AS evm_chain_id,

              ac.contract_address AS contract_address,
              ac.decimals AS decimals,
              ac.deposit_enabled AS deposit_enabled,
              ac.withdraw_enabled AS withdraw_enabled,
              ac.enabled AS enabled,
              ac.min_deposit AS min_deposit,
              ac.min_withdraw AS min_withdraw,
              COALESCE(ac.confirmations, c.confirmations) AS confirm_required,

              COALESCE(ub.available_amount, 0) AS available,
              COALESCE(ub.frozen_amount, 0) AS frozen
            FROM asset_chains ac
            JOIN assets a ON a.id = ac.asset_id
            JOIN chains c ON c.id = ac.chain_id
            LEFT JOIN user_balances ub
              ON ub.user_id = :user_id
             AND ub.coin_symbol = a.symbol
             AND ub.chain_key = c.chain_key
            WHERE a.enabled = 1
              AND c.enabled = 1
              AND ac.enabled = 1
              {net_filter_sql}
            ORDER BY c.id ASC, ac.sort ASC, a.id ASC
            """
        ),
        params,
    ).mappings().all()

    data: List[Dict[str, Any]] = []
    for r in rows:
        data.append(
            {
                "symbol": r["symbol"],
                "name": r["name"],
                "asset_type": r["asset_type"],
                "display_precision": int(r["display_precision"] or 0),
                "chain_key": r["chain_key"],
                "chain_id": int(r["evm_chain_id"] or 0),
                "available": _d(r["available"]),
                "frozen": _d(r["frozen"]),
                "contract_address": r.get("contract_address"),
                "decimals": int(r["decimals"] or 0),
                "confirm_required": int(r["confirm_required"] or 0),
                "deposit_enabled": bool(r["deposit_enabled"]),
                "withdraw_enabled": bool(r["withdraw_enabled"]),
                "min_deposit": _d(r.get("min_deposit")),
                "min_withdraw": _d(r.get("min_withdraw")),
            }
        )

    return _ok(data, trace_id)


# -------------------------
# 5) GET /asset/account-balances
# -------------------------
@router.get("/account-balances")
def list_account_balances(
    request: Request,
    db: Session = Depends(get_db),
    user_id: int = Depends(get_current_user_id),
):
    trace_id = getattr(request.state, "trace_id", None)

    rows = db.execute(
        text(
            """
            SELECT
              symbol,
              account_key,
              SUM(available) AS available,
              SUM(frozen) AS frozen
            FROM (
              SELECT
                CAST(coin_symbol AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_unicode_ci AS symbol,
                CAST(chain_key AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_unicode_ci AS account_key,
                COALESCE(available_amount, 0) AS available,
                COALESCE(frozen_amount, 0) AS frozen
              FROM user_balances
              WHERE user_id = :user_id
                AND chain_key IN (:funding_account, :spot_account)

              UNION ALL

              SELECT
                CAST(margin_asset AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_unicode_ci AS symbol,
                CAST(:contract_account AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_unicode_ci AS account_key,
                COALESCE(available_margin, 0) AS available,
                (
                  COALESCE(frozen_margin, 0)
                  + COALESCE(position_margin, 0)
                  + COALESCE(unrealized_pnl, 0)
                ) AS frozen
              FROM contract_accounts
              WHERE user_id = :user_id
                AND margin_asset = :contract_margin_asset
            ) AS account_rows
            GROUP BY symbol, account_key
            ORDER BY
              CASE
                WHEN account_key = CAST(:funding_account AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_unicode_ci THEN 0
                WHEN account_key = CAST(:spot_account AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_unicode_ci THEN 1
                WHEN account_key = CAST(:contract_account AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_unicode_ci THEN 2
                ELSE 3
              END ASC,
              symbol ASC,
              account_key ASC
            """
        ),
        {
            "user_id": user_id,
            "funding_account": FUNDING_BALANCE_CHAIN_KEY,
            "spot_account": SPOT_BALANCE_CHAIN_KEY,
            "contract_account": CONTRACT_BALANCE_ACCOUNT_KEY,
            "contract_margin_asset": CONTRACT_BALANCE_MARGIN_ASSET,
        },
    ).mappings().all()

    data: List[Dict[str, Any]] = []
    for r in rows:
        data.append(
            {
                "symbol": r["symbol"],
                "account_key": r["account_key"],
                "available": _d(r["available"]),
                "frozen": _d(r["frozen"]),
            }
        )

    logger.debug(
        "asset account balance aggregates user_id=%s by_account=%s by_symbol=%s",
        user_id,
        _sum_balance_rows(data, key_field="account_key"),
        _sum_balance_rows(data, key_field="symbol"),
    )

    return _ok(data, trace_id)


# -------------------------
# 6) POST /asset/transfer
# -------------------------
@router.post("/transfer")
def transfer_asset(
    payload: AssetTransferIn,
    db: Session = Depends(get_db),
    user_id: int = Depends(get_current_user_id),
):
    symbol = _require(payload.symbol, "symbol").upper()
    from_account = _norm_account_key(payload.from_account)
    to_account = _norm_account_key(payload.to_account)
    amount = payload.amount

    allowed_accounts = {FUNDING_BALANCE_CHAIN_KEY, SPOT_BALANCE_CHAIN_KEY}
    if from_account not in allowed_accounts:
        raise HTTPException(
            status_code=400,
            detail={"code": "BAD_REQUEST", "message": "from_account must be funding or spot"},
        )
    if to_account not in allowed_accounts:
        raise HTTPException(
            status_code=400,
            detail={"code": "BAD_REQUEST", "message": "to_account must be funding or spot"},
        )
    if from_account == to_account:
        raise HTTPException(
            status_code=400,
            detail={"code": "BAD_REQUEST", "message": "from_account and to_account cannot be the same"},
        )
    if amount <= 0:
        raise HTTPException(
            status_code=400,
            detail={"code": "BAD_REQUEST", "message": "amount must be > 0"},
        )

    try:
        transfer_available(
            db,
            user_id=user_id,
            coin_symbol=symbol,
            from_chain_key=from_account,
            to_chain_key=to_account,
            amount=amount,
            remark=f"Asset transfer {from_account}->{to_account}",
        )
        db.commit()
    except ValueError as e:
        db.rollback()
        msg = str(e)
        if msg == "INSUFFICIENT_AVAILABLE_BALANCE":
            raise HTTPException(
                status_code=400,
                detail={"code": msg, "message": "insufficient available balance"},
            )
        if msg == "SAME_ACCOUNT_TRANSFER":
            raise HTTPException(
                status_code=400,
                detail={"code": msg, "message": "from_account and to_account cannot be the same"},
            )
        if msg == "amount must be > 0":
            raise HTTPException(
                status_code=400,
                detail={"code": "BAD_REQUEST", "message": msg},
            )
        raise HTTPException(
            status_code=400,
            detail={"code": "BAD_REQUEST", "message": msg},
        )
    except HTTPException:
        db.rollback()
        raise
    except Exception:
        db.rollback()
        raise HTTPException(
            status_code=500,
            detail={"code": "INTERNAL_ERROR", "message": "transfer failed"},
        )

    return {"success": True}


# -------------------------
# 7) GET /asset/deposits
# -------------------------
@router.get("/deposits")
def list_deposits(
    request: Request,
    page: int = 1,
    page_size: int = 20,
    symbol: Optional[str] = None,
    network: Optional[str] = None,
    status: Optional[str] = None,
    q: Optional[str] = None,
    start_time: Optional[str] = None,
    end_time: Optional[str] = None,
    db: Session = Depends(get_db),
    user_id: int = Depends(get_current_user_id),
):
    trace_id = getattr(request.state, "trace_id", None)

    if page < 1:
        page = 1
    if page_size < 1:
        page_size = 20
    if page_size > 200:
        page_size = 200
    offset = (page - 1) * page_size

    where_sql = " WHERE d.user_id = :user_id "
    params: Dict[str, Any] = {"user_id": user_id, "limit": page_size, "offset": offset}

    if symbol:
        where_sql += " AND d.coin_symbol = :symbol "
        params["symbol"] = symbol.strip().upper()

    if network:
        ck = _norm_chain_key(network)
        where_sql += " AND LOWER(d.chain_key) = :chain_key "
        params["chain_key"] = ck

    if status:
        where_sql += " AND d.status = :status "
        params["status"] = status.strip()

    if q:
        qq = f"%{q.strip().lower()}%"
        where_sql += " AND (LOWER(d.txid) LIKE :q OR LOWER(d.address) LIKE :q OR LOWER(d.from_address) LIKE :q) "
        params["q"] = qq

    dt_start = _parse_iso_dt(start_time, "start_time")
    dt_end = _parse_iso_dt(end_time, "end_time")
    if dt_start:
        where_sql += " AND d.created_at >= :dt_start "
        params["dt_start"] = dt_start
    if dt_end:
        where_sql += " AND d.created_at <= :dt_end "
        params["dt_end"] = dt_end

    total_row = db.execute(
        text(
            f"""
            SELECT COUNT(1) AS cnt
            FROM deposits d
            {where_sql}
            """
        ),
        params,
    ).mappings().first()
    total = int((total_row or {}).get("cnt") or 0)

    rows = db.execute(
        text(
            f"""
            SELECT
              d.id,
              d.coin_symbol AS symbol,
              d.chain_key,
              d.address,
              d.memo,
              d.txid,
              d.log_index,
              d.from_address,
              d.amount,
              d.status,
              d.confirmations,
              d.confirm_required,
              d.block_number,
              d.block_hash,
              d.created_at,
              d.confirmed_at
            FROM deposits d
            {where_sql}
            ORDER BY d.id DESC
            LIMIT :limit OFFSET :offset
            """
        ),
        params,
    ).mappings().all()

    items: List[Dict[str, Any]] = []
    for r in rows:
        items.append(
            {
                "id": int(r["id"]),
                "symbol": r["symbol"],
                "chain_key": r["chain_key"],
                "address": r.get("address"),
                "memo": r.get("memo"),
                "txid": r.get("txid"),
                "log_index": int(r.get("log_index") or 0),
                "from_address": r.get("from_address"),
                "amount": _d(r.get("amount")),
                "status": r.get("status"),
                "confirmations": int(r.get("confirmations") or 0),
                "confirm_required": int(r.get("confirm_required") or 0),
                "block_number": int(r.get("block_number") or 0) if r.get("block_number") is not None else None,
                "block_hash": r.get("block_hash"),
                "created_at": (r.get("created_at").isoformat() if r.get("created_at") else None),
                "confirmed_at": (r.get("confirmed_at").isoformat() if r.get("confirmed_at") else None),
            }
        )

    return _ok({"items": items, "page": page, "page_size": page_size, "total": total}, trace_id)


# -------------------------
# 8) GET /asset/my/balance-logs
# -------------------------
@router.get("/my/balance-logs")
def list_my_balance_logs(
    request: Request,
    page: int = 1,
    page_size: int = 20,
    coin_symbol: Optional[str] = None,
    chain_key: Optional[str] = None,
    biz_type: Optional[str] = None,
    db: Session = Depends(get_db),
    user_id: int = Depends(get_current_user_id),
):
    trace_id = getattr(request.state, "trace_id", None)

    if page < 1:
        page = 1
    if page_size < 1:
        page_size = 20
    if page_size > 200:
        page_size = 200
    offset = (page - 1) * page_size

    where_sql = " WHERE user_id = :user_id "
    params: Dict[str, Any] = {
        "user_id": user_id,
        "limit": page_size,
        "offset": offset,
    }

    if coin_symbol:
        where_sql += " AND coin_symbol = :coin_symbol "
        params["coin_symbol"] = coin_symbol.strip().upper()

    if chain_key:
        where_sql += " AND LOWER(chain_key) = :chain_key "
        params["chain_key"] = chain_key.strip().lower()

    if biz_type:
        # 前端交易类型筛选使用 biz_type 参数；实际展示优先采用 change_type。
        where_sql += " AND (change_type = :biz_type OR biz_type = :biz_type) "
        where_sql += " AND (change_type = :biz_type OR biz_type = :biz_type) "
        params["biz_type"] = biz_type.strip().upper()

    total_row = db.execute(
        text(
            f"""
            SELECT COUNT(1) AS cnt
            FROM balance_logs
            {where_sql}
            """
        ),
        params,
    ).mappings().first()
    total = int((total_row or {}).get("cnt") or 0)

    rows = db.execute(
        text(
            f"""
            SELECT
              id,
              coin_symbol,
              chain_key,
              change_type,
              biz_type AS raw_biz_type,
              biz_id,
              request_id,
              change_amount,
              after_available,
              remark,
              created_at
            FROM balance_logs
            {where_sql}
            ORDER BY created_at DESC, id DESC
            LIMIT :limit OFFSET :offset
            """
        ),
        params,
    ).mappings().all()

    items: List[Dict[str, Any]] = []
    for r in rows:
        created_at = r.get("created_at")
        items.append(
            {
                "id": int(r["id"]),
                "created_at": created_at.strftime("%Y-%m-%d %H:%M:%S") if created_at else None,
                "biz_type": r.get("change_type") or r.get("raw_biz_type"),
                "raw_biz_type": r.get("raw_biz_type"),
                "biz_id": r.get("biz_id"),
                "request_id": r.get("request_id"),
                "coin_symbol": r.get("coin_symbol"),
                "chain_key": r.get("chain_key"),
                "change_amount": _d(r.get("change_amount")),
                "after_available": _d(r.get("after_available")),
                "remark": r.get("remark") or "",
            }
        )

    return _ok({"items": items, "page": page, "page_size": page_size, "total": total}, trace_id)
