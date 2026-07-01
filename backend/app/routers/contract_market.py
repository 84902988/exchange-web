from __future__ import annotations

import json
import logging
from typing import Any, Callable, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from sqlalchemy.orm import Session

from app.db.models.contract_symbol import ContractSymbol
from app.db.session import SessionLocal, get_db
from app.schemas.contract_market import (
    ContractDepthResponse,
    ContractMarketViewDetail,
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
from app.services.contract_market_gateway import contract_market_gateway
from app.services.contract_market_view import get_contract_market_view
from app.services.contract_market_ws import (
    contract_market_ws_manager,
    normalize_contract_ws_interval,
    normalize_contract_ws_symbol,
)
from app.services.market_cache import cache_fetch_json, market_cache_key

router = APIRouter(prefix="/contract/market", tags=["contract-market"])
logger = logging.getLogger(__name__)

CONTRACT_TICKER_CACHE_VERSION = "1"
CONTRACT_TICKER_FIELD_VERSION = "ticker_fields_v2"
CONTRACT_TICKER_PROVIDER_VERSION = "default"


def _parse_ws_receive(message: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    if message.get("type") == "websocket.disconnect":
        return "disconnect", {}
    if message.get("type") != "websocket.receive":
        return "", {}

    if message.get("text") is not None:
        text = str(message.get("text") or "").strip()
        if text == "ping":
            return "ping", {}
        if text.startswith("subscribe:"):
            raw_symbol = text.split(":", 1)[1].strip()
            symbol, _, interval = raw_symbol.partition(":")
            return "subscribe", {
                "symbol": normalize_contract_ws_symbol(symbol),
                "interval": normalize_contract_ws_interval(interval or None),
            }
        try:
            parsed = json.loads(text)
        except Exception:
            return "", {}
        if isinstance(parsed, dict):
            action = str(parsed.get("type") or parsed.get("action") or "").strip().lower()
            return action, parsed
        return "", {}

    if message.get("bytes") is not None:
        try:
            parsed = json.loads(message["bytes"].decode("utf-8"))
        except Exception:
            return "", {}
        if isinstance(parsed, dict):
            action = str(parsed.get("type") or parsed.get("action") or "").strip().lower()
            return action, parsed
    return "", {}


def _load_with_short_session(loader: Callable[[Session], dict]):
    db = SessionLocal()
    try:
        return loader(db)
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


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
        "closed_market_execution_mode": str(
            getattr(item, "closed_market_execution_mode", "") or "DISABLED"
        ).strip().upper(),
        "price_precision": item.price_precision,
        "quantity_precision": item.quantity_precision,
        "max_leverage": item.max_leverage,
        "status": item.status,
        **contract_symbol_market_status_payload(item),
    }


@router.websocket("/ws")
async def contract_market_public_ws(
    websocket: WebSocket,
    symbol: str = Query(..., description="Contract symbol, e.g. BTCUSDT_PERP"),
    interval: str = Query("1m", description="Current chart interval"),
) -> None:
    connected_symbol = normalize_contract_ws_symbol(symbol)
    connected_interval = normalize_contract_ws_interval(interval)
    if not connected_symbol:
        await websocket.close(code=1008)
        return

    manager_connected = False
    try:
        await contract_market_ws_manager.connect(
            connected_symbol,
            websocket,
            interval=connected_interval,
        )
        manager_connected = True
        snapshot = await contract_market_gateway.snapshot(connected_symbol, connected_interval)
        await contract_market_ws_manager.send_to_one(websocket, snapshot)
        await contract_market_gateway.ensure_symbol(connected_symbol)

        while True:
            try:
                message = await websocket.receive()
            except WebSocketDisconnect:
                break
            action, payload = _parse_ws_receive(message)
            if action == "disconnect":
                break
            if action == "ping":
                await websocket.send_json({"type": "pong"})
                continue
            if action == "subscribe":
                next_symbol = normalize_contract_ws_symbol(payload.get("symbol") or connected_symbol)
                next_interval = normalize_contract_ws_interval(payload.get("interval") or connected_interval)
                if not next_symbol:
                    continue
                previous_symbol = connected_symbol
                connected_symbol = next_symbol
                connected_interval = next_interval
                await contract_market_ws_manager.connect(
                    connected_symbol,
                    websocket,
                    interval=connected_interval,
                    accepted=True,
                )
                if previous_symbol != connected_symbol:
                    await contract_market_gateway.release_symbol_if_idle(previous_symbol)
                snapshot = await contract_market_gateway.snapshot(connected_symbol, connected_interval)
                await contract_market_ws_manager.send_to_one(websocket, snapshot)
                await contract_market_gateway.ensure_symbol(connected_symbol)
    finally:
        if manager_connected:
            disconnected_symbol = await contract_market_ws_manager.disconnect(websocket)
            if disconnected_symbol:
                await contract_market_gateway.release_symbol_if_idle(disconnected_symbol)


@router.get("/symbols")
def contract_market_symbols(
    request: Request,
    category: str = Query("all", description="all / core / stock / metal / commodity"),
    quote: str = Query("all", description="USDT / USDC / all"),
    keyword: Optional[str] = Query(None, description="symbol search keyword"),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=100),
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

    def load_data(db: Session) -> dict:
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

    return ok(data=cache_fetch_json(cache_key, 120, lambda: _load_with_short_session(load_data)), trace_id=trace_id)


@router.get("/view")
def contract_market_view(
    request: Request,
    symbol: str = Query(..., description="Contract symbol, e.g. AAPLUSDT_PERP"),
):
    trace_id = getattr(request.state, "trace_id", None)
    normalized_symbol = str(symbol or "").strip().upper()
    if not normalized_symbol:
        raise HTTPException(status_code=400, detail={"code": "CONTRACT_SYMBOL_REQUIRED", "message": "symbol is required"})
    try:
        def load_data(db: Session) -> dict:
            view_payload = get_contract_market_view(db, normalized_symbol)
            return ContractMarketViewDetail(**view_payload).model_dump()

        return ok(data=_load_with_short_session(load_data), trace_id=trace_id)
    except ContractSymbolNotFound as exc:
        raise HTTPException(status_code=404, detail={"code": exc.code, "message": str(exc)})
    except ContractMarketError as exc:
        raise HTTPException(status_code=503, detail={"code": exc.code, "message": str(exc)})
    except HTTPException:
        raise
    except Exception:
        logger.exception("contract market view failed symbol=%s", normalized_symbol)
        raise HTTPException(
            status_code=503,
            detail={"code": "CONTRACT_MARKET_VIEW_UNAVAILABLE", "message": "contract market view unavailable"},
        )


@router.get("/quote")
def contract_market_quote(
    request: Request,
    symbol: str = Query(..., description="Contract symbol, e.g. BTCUSDT_PERP"),
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
        def load_data(db: Session) -> dict:
            quote_payload = get_contract_quote(db, normalized_symbol)
            return ContractQuoteResponse(**contract_quote_to_response(quote_payload)).model_dump()

        data = cache_fetch_json(
            cache_key,
            3,
            lambda: _load_with_short_session(load_data),
        )
        return ok(data=data, trace_id=trace_id)
    except ContractSymbolNotFound as exc:
        raise HTTPException(status_code=404, detail={"code": exc.code, "message": str(exc)})
    except ContractMarketError as exc:
        raise HTTPException(status_code=503, detail={"code": exc.code, "message": str(exc)})
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(
            status_code=503,
            detail={"code": "CONTRACT_QUOTE_UNAVAILABLE", "message": "contract quote unavailable"},
        )


@router.get("/tickers")
def contract_market_tickers(
    request: Request,
    symbols: Optional[str] = Query(None, description="Comma separated contract symbols"),
    limit: int = Query(100, ge=1, le=200),
):
    trace_id = getattr(request.state, "trace_id", None)
    selected_symbols: Optional[List[str]] = None
    if symbols:
        selected_symbols = sorted({item.strip().upper() for item in symbols.split(",") if item.strip()})
    safe_limit = max(1, min(int(limit or 100), 200))
    query_params = {
        "session_policy": CONTRACT_MARKET_SESSION_POLICY_VERSION,
        "market_status_version": CONTRACT_MARKET_STATUS_VERSION,
        "forex_price_field_version": CONTRACT_MARKET_FOREX_PRICE_FIELD_VERSION,
        "symbols": selected_symbols or [],
        "limit": safe_limit,
    }
    cache_key = market_cache_key(
        "contract:ticker_batch",
        {
            "session_policy": CONTRACT_MARKET_SESSION_POLICY_VERSION,
            "market_status_version": CONTRACT_MARKET_STATUS_VERSION,
            "forex_price_field": CONTRACT_MARKET_FOREX_PRICE_FIELD_VERSION,
        },
        version=CONTRACT_TICKER_CACHE_VERSION,
        symbols=selected_symbols or [],
        market_type="contract",
        asset_type="mixed",
        category="all",
        provider_version=CONTRACT_TICKER_PROVIDER_VERSION,
        field_version=CONTRACT_TICKER_FIELD_VERSION,
        query_params=query_params,
    )

    data = cache_fetch_json(
        cache_key,
        15,
        lambda: _load_with_short_session(
            lambda db: ContractTickerListResponse(
                items=get_contract_tickers(db, symbols=selected_symbols, limit=safe_limit)
            ).model_dump()
        ),
    )
    return ok(data=data, trace_id=trace_id)


@router.get("/depth")
def contract_market_depth(
    request: Request,
    symbol: str = Query(..., description="Contract symbol, e.g. BTCUSDT_PERP"),
    limit: int = Query(20, ge=5, le=100),
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
        def load_data(db: Session) -> dict:
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

        return ok(data=cache_fetch_json(cache_key, 3, lambda: _load_with_short_session(load_data)), trace_id=trace_id)
    except ContractSymbolNotFound as exc:
        raise HTTPException(status_code=404, detail={"code": exc.code, "message": str(exc)})
    except ContractMarketError as exc:
        raise HTTPException(status_code=503, detail={"code": exc.code, "message": str(exc)})
    except HTTPException:
        raise
    except Exception:
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
