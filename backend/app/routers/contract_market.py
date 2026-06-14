from __future__ import annotations

import logging
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy.orm import Session

from app.db.models.contract_symbol import ContractSymbol
from app.db.session import get_db
from app.schemas.contract_market import (
    ContractDepthResponse,
    ContractQuoteResponse,
    ContractSymbolListResponse,
    ContractTickerListResponse,
)
from app.schemas.response import ok
from app.services.contract_market_service import (
    CONTRACT_MARKET_FOREX_PRICE_FIELD_VERSION,
    CONTRACT_MARKET_STATUS_VERSION,
    CONTRACT_MARKET_SESSION_POLICY_VERSION,
    ContractMarketError,
    ContractSymbolNotFound,
    attach_contract_symbol_market_metadata,
    contract_symbol_market_status_payload,
    contract_depth_to_response,
    contract_quote_to_response,
    get_contract_depth,
    get_contract_klines,
    get_contract_quote,
    get_contract_recent_trades,
    get_contract_tickers,
)
from app.services.market_cache import cache_fetch_json, market_cache_key

router = APIRouter(prefix="/contract/market", tags=["contract-market"])
logger = logging.getLogger(__name__)


def _normalize_contract_category(value: str) -> str:
    normalized = str(value or "all").strip().lower()
    if normalized in ("", "all"):
        return "all"
    if normalized in ("core", "crypto", "usdt"):
        return "CRYPTO"
    if normalized == "stock":
        return "STOCK"
    if normalized in ("metal", "gold"):
        return "GOLD"
    if normalized in ("commodity", "futures"):
        return "FUTURES"
    return normalized.upper()


def _contract_symbol_payload(item: ContractSymbol) -> dict:
    return {
        "symbol": item.symbol,
        "display_name": item.display_name,
        "category": item.category,
        "provider": item.provider,
        "provider_symbol": item.provider_symbol,
        "quote_asset": item.quote_asset,
        "tp_sl_trigger_price_type": str(getattr(item, "tp_sl_trigger_price_type", "") or "MARK_PRICE").strip().upper(),
        "price_precision": item.price_precision,
        "quantity_precision": item.quantity_precision,
        "max_leverage": item.max_leverage,
        "status": item.status,
        **contract_symbol_market_status_payload(item),
    }


@router.get("/symbols")
def contract_market_symbols(
    request: Request,
    category: str = Query("all", description="all / core / stock / metal / commodity"),
    quote: str = Query("all", description="USDT / USDC / all"),
    keyword: Optional[str] = Query(None, description="symbol search keyword"),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=100),
    db: Session = Depends(get_db),
):
    trace_id = getattr(request.state, "trace_id", None)
    normalized_category = _normalize_contract_category(category)
    normalized_quote = str(quote or "all").strip().upper()
    normalized_keyword = str(keyword or "").strip().upper()
    normalized_page = max(int(page or 1), 1)
    normalized_page_size = max(1, min(int(page_size or 50), 100))
    cache_key = market_cache_key(
        "contract:symbols",
        {
            "session_policy": CONTRACT_MARKET_SESSION_POLICY_VERSION,
            "market_status": CONTRACT_MARKET_STATUS_VERSION,
            "forex_price_field": CONTRACT_MARKET_FOREX_PRICE_FIELD_VERSION,
            "category": normalized_category,
            "quote": normalized_quote,
            "keyword": normalized_keyword,
            "page": normalized_page,
            "page_size": normalized_page_size,
        },
    )

    def load_data() -> dict:
        query = db.query(ContractSymbol).filter(ContractSymbol.status == 1)
        if normalized_category != "all":
            query = query.filter(ContractSymbol.category == normalized_category)
        if normalized_quote != "ALL":
            query = query.filter(ContractSymbol.quote_asset == normalized_quote)
        if normalized_keyword:
            like_text = f"%{normalized_keyword}%"
            query = query.filter(
                (ContractSymbol.symbol.ilike(like_text))
                | (ContractSymbol.display_name.ilike(like_text))
                | (ContractSymbol.provider_symbol.ilike(like_text))
            )

        total = query.count()
        offset = (normalized_page - 1) * normalized_page_size
        rows = (
            query.order_by(ContractSymbol.category.asc(), ContractSymbol.symbol.asc())
            .offset(offset)
            .limit(normalized_page_size)
            .all()
        )
        attach_contract_symbol_market_metadata(db, rows)
        data = ContractSymbolListResponse(
            items=[_contract_symbol_payload(item) for item in rows],
            total=total,
            page=normalized_page,
            page_size=normalized_page_size,
        )
        return data.model_dump()

    return ok(data=cache_fetch_json(cache_key, 120, load_data), trace_id=trace_id)


@router.get("/quote")
def contract_market_quote(
    request: Request,
    symbol: str = Query(..., description="Contract symbol, e.g. BTCUSDT_PERP"),
    db: Session = Depends(get_db),
):
    trace_id = getattr(request.state, "trace_id", None)
    normalized_symbol = str(symbol or "").strip().upper()
    cache_key = market_cache_key(
        "contract:quote",
        {
            "session_policy": CONTRACT_MARKET_SESSION_POLICY_VERSION,
            "market_status": CONTRACT_MARKET_STATUS_VERSION,
            "forex_price_field": CONTRACT_MARKET_FOREX_PRICE_FIELD_VERSION,
            "symbol": normalized_symbol,
        },
    )
    try:
        data = cache_fetch_json(
            cache_key,
            3,
            lambda: ContractQuoteResponse(**contract_quote_to_response(get_contract_quote(db, normalized_symbol))).model_dump(),
        )
        return ok(data=data, trace_id=trace_id)
    except ContractSymbolNotFound as exc:
        db.rollback()
        raise HTTPException(status_code=404, detail={"code": exc.code, "message": str(exc)})
    except ContractMarketError as exc:
        db.rollback()
        raise HTTPException(status_code=503, detail={"code": exc.code, "message": str(exc)})
    except HTTPException:
        db.rollback()
        raise
    except Exception:
        db.rollback()
        raise HTTPException(
            status_code=503,
            detail={"code": "CONTRACT_QUOTE_UNAVAILABLE", "message": "contract quote unavailable"},
        )


@router.get("/tickers")
def contract_market_tickers(
    request: Request,
    symbols: Optional[str] = Query(None, description="Comma separated contract symbols"),
    limit: int = Query(100, ge=1, le=200),
    db: Session = Depends(get_db),
):
    trace_id = getattr(request.state, "trace_id", None)
    selected_symbols: Optional[List[str]] = None
    if symbols:
        selected_symbols = sorted({item.strip().upper() for item in symbols.split(",") if item.strip()})
    safe_limit = max(1, min(int(limit or 100), 200))
    cache_key = market_cache_key(
        "contract:ticker_batch",
        {
            "session_policy": CONTRACT_MARKET_SESSION_POLICY_VERSION,
            "market_status": CONTRACT_MARKET_STATUS_VERSION,
            "forex_price_field": CONTRACT_MARKET_FOREX_PRICE_FIELD_VERSION,
            "symbols": selected_symbols or [],
            "limit": safe_limit,
        },
    )

    data = cache_fetch_json(
        cache_key,
        15,
        lambda: ContractTickerListResponse(items=get_contract_tickers(db, symbols=selected_symbols, limit=safe_limit)).model_dump(),
    )
    return ok(data=data, trace_id=trace_id)


@router.get("/depth")
def contract_market_depth(
    request: Request,
    symbol: str = Query(..., description="Contract symbol, e.g. BTCUSDT_PERP"),
    limit: int = Query(20, ge=5, le=100),
    db: Session = Depends(get_db),
):
    trace_id = getattr(request.state, "trace_id", None)
    normalized_symbol = str(symbol or "").strip().upper()
    safe_limit = max(5, min(int(limit or 20), 100))
    cache_key = market_cache_key(
        "contract:depth",
        {
            "session_policy": CONTRACT_MARKET_SESSION_POLICY_VERSION,
            "market_status": CONTRACT_MARKET_STATUS_VERSION,
            "forex_price_field": CONTRACT_MARKET_FOREX_PRICE_FIELD_VERSION,
            "symbol": normalized_symbol,
            "limit": safe_limit,
        },
    )
    try:
        def load_data() -> dict:
            depth = get_contract_depth(db, normalized_symbol, limit=safe_limit)
            logger.info(
                "contract_market_depth_response symbol=%s provider_symbol=%s source=%s bids_count=%s asks_count=%s "
                "first_bid=%s first_ask=%s",
                depth.get("symbol"),
                depth.get("provider_symbol"),
                depth.get("source"),
                len(depth.get("bids") or []),
                len(depth.get("asks") or []),
                depth.get("best_bid"),
                depth.get("best_ask"),
            )
            return ContractDepthResponse(**contract_depth_to_response(depth)).model_dump()

        return ok(data=cache_fetch_json(cache_key, 3, load_data), trace_id=trace_id)
    except ContractSymbolNotFound as exc:
        db.rollback()
        raise HTTPException(status_code=404, detail={"code": exc.code, "message": str(exc)})
    except ContractMarketError as exc:
        db.rollback()
        raise HTTPException(status_code=503, detail={"code": exc.code, "message": str(exc)})
    except HTTPException:
        db.rollback()
        raise
    except Exception:
        db.rollback()
        raise HTTPException(
            status_code=503,
            detail={"code": "CONTRACT_DEPTH_UNAVAILABLE", "message": "contract depth unavailable"},
        )


@router.get("/kline")
@router.get("/klines")
def contract_market_kline(
    request: Request,
    symbol: str = Query(..., description="Contract symbol, e.g. BTCUSDT_PERP"),
    interval: str = Query("1m", description="1m / 5m / 15m / 1h / 4h / 1d"),
    limit: int = Query(200, ge=1, le=1000),
    end_time_ms: Optional[int] = Query(
        None,
        ge=0,
        description="Optional history pagination end time in milliseconds. Returns klines with open_time < end_time_ms.",
    ),
    db: Session = Depends(get_db),
):
    trace_id = getattr(request.state, "trace_id", None)
    try:
        rows = get_contract_klines(
            db,
            symbol=symbol,
            interval=interval,
            limit=limit,
            end_time_ms=end_time_ms,
        )
        return ok(data=rows, trace_id=trace_id)
    except ContractSymbolNotFound as exc:
        db.rollback()
        raise HTTPException(status_code=404, detail={"code": exc.code, "message": str(exc)})
    except ContractMarketError as exc:
        db.rollback()
        raise HTTPException(status_code=503, detail={"code": exc.code, "message": str(exc)})
    except HTTPException:
        db.rollback()
        raise
    except Exception:
        db.rollback()
        raise HTTPException(
            status_code=503,
            detail={"code": "CONTRACT_KLINE_UNAVAILABLE", "message": "contract kline unavailable"},
        )


@router.get("/trades")
def contract_market_trades(
    request: Request,
    symbol: str = Query(..., description="Contract symbol, e.g. BTCUSDT_PERP"),
    limit: int = Query(30, ge=1, le=100),
    db: Session = Depends(get_db),
):
    trace_id = getattr(request.state, "trace_id", None)
    try:
        rows = get_contract_recent_trades(db, symbol=symbol, limit=limit)
        return ok(data=rows, trace_id=trace_id)
    except ContractSymbolNotFound as exc:
        db.rollback()
        raise HTTPException(status_code=404, detail={"code": exc.code, "message": str(exc)})
    except ContractMarketError as exc:
        db.rollback()
        raise HTTPException(status_code=503, detail={"code": exc.code, "message": str(exc)})
    except HTTPException:
        db.rollback()
        raise
    except Exception:
        db.rollback()
        raise HTTPException(
            status_code=503,
            detail={"code": "CONTRACT_TRADES_UNAVAILABLE", "message": "contract trades unavailable"},
        )
