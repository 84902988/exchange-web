import json
import logging
from typing import Optional

from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    Query,
    Request,
    WebSocket,
    WebSocketDisconnect,
)
from sqlalchemy.orm import Session

from app.core.content_locale import resolve_content_locale
from app.db.session import SessionLocal, get_db
from app.schemas.market import DepthResponse, KlineResponse, TradesResponse
from app.services.market import (
    _get_active_pair,
    filter_active_mobile_market_overview,
    filter_active_trading_pair_rows,
    get_depth,
    get_klines,
    get_mobile_market_overview,
    get_market_pairs,
    get_market_tickers,
    get_trades,
)
from app.services.market_cache import cache_fetch_json, cache_get_json, market_cache_key
from app.services.market_ws import market_ws_manager
from app.services.spot_market_view import get_spot_market_view
from app.services.reference_overlay_service import get_reference_overlay_for_symbol

router = APIRouter(
    prefix="/market",
    tags=["market"],
)
logger = logging.getLogger(__name__)

MARKET_TICKER_CACHE_VERSION = "1"
MARKET_TICKER_FIELD_VERSION = "ticker_fields_v2"
MARKET_TICKER_PROVIDER_VERSION = "default"
MARKET_MOBILE_OVERVIEW_CACHE_VERSION = "1"
MARKET_MOBILE_OVERVIEW_FIELD_VERSION = "mobile_overview_v1"


@router.get(
    "/tickers",
    summary="获取行情列表",
    description="""
获取市场页使用的最小行情列表数据。

接口说明：
1. 从 trading_pairs 表获取已启用交易对
2. BTCUSDT、ETHUSDT 优先走 Binance 外部 ticker
3. 外部 ticker 失败时，单个币对会回退为 0，不影响整个接口
4. 其他交易对继续使用本地最新成交价
5. 当前 internal 的 change_24h / volume_24h 先固定返回 0

参数说明：
1. 本接口当前无请求参数

请求示例：
GET /market/tickers

返回示例：
[
  {
    "symbol": "BTCUSDT",
    "last_price": "68000",
    "change_24h": "2.35",
    "volume_24h": "12345"
  },
  {
    "symbol": "MFCUSDT",
    "last_price": "10.2",
    "change_24h": "0",
    "volume_24h": "0"
  }
]
""",
)
def get_tickers(
    symbol: Optional[str] = Query(
        None,
        description="可选，按交易对过滤，例如 TSLAONUSDT",
    ),
    symbols: Optional[str] = Query(
        None,
        description="Optional comma-separated symbols, e.g. BTCUSDT,ETHUSDT",
    ),
    db: Session = Depends(get_db),
):
    normalized_symbol = str(symbol or "").upper().strip()
    normalized_symbols = sorted(
        item.strip().upper()
        for item in str(symbols or "").split(",")
        if item.strip()
    )
    query_params = {
        "symbol": normalized_symbol,
        "symbols": normalized_symbols,
    }
    cache_key = market_cache_key(
        "market:ticker_batch",
        version=MARKET_TICKER_CACHE_VERSION,
        symbol=normalized_symbol or None,
        symbols=normalized_symbols,
        market_type="spot",
        asset_type="mixed",
        category="all",
        provider_version=MARKET_TICKER_PROVIDER_VERSION,
        field_version=MARKET_TICKER_FIELD_VERSION,
        query_params=query_params,
    )
    try:
        payload = cache_fetch_json(
            cache_key,
            15,
            lambda: get_market_tickers(db=db, symbol=normalized_symbol or None, symbols=",".join(normalized_symbols) or None),
        )
        return filter_active_trading_pair_rows(db, payload if isinstance(payload, list) else [])
    except Exception:
        logger.exception("get tickers failed")
        raise HTTPException(status_code=500, detail="get tickers failed")


@router.get("/spot/view", summary="Get unified spot market view")
def spot_view(
    symbol: str = Query(..., description="Spot symbol, e.g. BTCUSDT"),
    db: Session = Depends(get_db),
):
    try:
        return get_spot_market_view(db=db, symbol=symbol)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        logger.exception("get spot market view failed symbol=%s", symbol)
        raise HTTPException(status_code=500, detail=f"get spot market view failed: {str(e)}")


@router.get("/pairs", summary="获取轻量交易对列表")
def get_pairs(
    market_type: str = Query("spot", description="spot / contract / all"),
    category: str = Query("all", description="mainstream / stock / platform / rwa / metal / commodity / index / forex / etf / all"),
    quote: str = Query("all", description="USDT / USDC / BTC / ETH / all"),
    keyword: Optional[str] = Query(None, description="搜索关键字"),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=100),
    db: Session = Depends(get_db),
):
    normalized_market_type = str(market_type or "spot").strip().lower()
    normalized_category = str(category or "all").strip().lower()
    normalized_quote = str(quote or "all").strip().upper()
    normalized_keyword = str(keyword or "").strip()
    normalized_page = max(int(page or 1), 1)
    normalized_page_size = max(1, min(int(page_size or 50), 100))
    try:
        # Enable/disable belongs to the administrative control plane. Keep
        # market-data caches, but read pair membership from the indexed table
        # on every catalog request so disabled symbols disappear immediately.
        return get_market_pairs(
            db=db,
            market_type=normalized_market_type,
            category=normalized_category,
            quote=normalized_quote,
            keyword=normalized_keyword or None,
            page=normalized_page,
            page_size=normalized_page_size,
        )
    except Exception:
        logger.exception("get pairs failed")
        raise HTTPException(status_code=500, detail="get pairs failed")


@router.get("/mobile/overview", summary="Get mobile market overview snapshot")
def mobile_overview(db: Session = Depends(get_db)):
    cache_key = market_cache_key(
        "market:mobile_overview",
        version=MARKET_MOBILE_OVERVIEW_CACHE_VERSION,
        market_type="all",
        category="mobile",
        field_version=MARKET_MOBILE_OVERVIEW_FIELD_VERSION,
    )
    try:
        active_cached = cache_get_json(cache_key) is not None
        payload = cache_fetch_json(
            cache_key,
            10,
            lambda: get_mobile_market_overview(db=db),
            last_good_ttl_seconds=24 * 60 * 60,
        )
        payload = filter_active_mobile_market_overview(db, payload)
        if isinstance(payload, dict) and payload.get("is_stale"):
            payload = {
                **payload,
                "stale": True,
                "source": "last_good",
            }
        elif isinstance(payload, dict):
            payload = {
                **payload,
                "source": "cache" if active_cached else payload.get("source", "live"),
            }
        return payload
    except Exception:
        logger.exception("get mobile market overview failed")
        raise HTTPException(status_code=500, detail="get mobile market overview failed")


@router.get("/reference-overlays", summary="Get chart reference overlay config")
def reference_overlays(
    request: Request,
    symbol: str = Query(..., description="Spot symbol, e.g. MFCUSDT"),
    lang: Optional[str] = Query(None, description="Optional content language"),
    db: Session = Depends(get_db),
):
    try:
        locale = resolve_content_locale(lang, request.headers.get("accept-language"))
        return get_reference_overlay_for_symbol(db, symbol=symbol, locale=locale)
    except Exception:
        logger.exception("get reference overlay failed")
        raise HTTPException(status_code=500, detail="get reference overlay failed")


@router.get(
    "/depth",
    response_model=DepthResponse,
    summary="获取盘口深度",
    description="""
获取指定交易对的盘口深度数据（买盘 / 卖盘）。

接口规则：
1. 数据来源：orders 订单表
2. 只统计状态为 OPEN、PARTIALLY_FILLED 的订单
3. amount = 剩余未成交数量 = amount - filled_amount
4. 买盘（bids）按价格从高到低排序
5. 卖盘（asks）按价格从低到高排序
6. symbol 不区分大小写，后端会自动转大写
7. 返回的 symbol 统一为标准大写格式

请求示例：
GET /market/depth?symbol=MFCUSDT&limit=20

返回示例：
{
  "symbol": "MFCUSDT",
  "bids": [
    {
      "price": "1.200000000000000000",
      "amount": "100.000000000000000000"
    }
  ],
  "asks": [
    {
      "price": "1.210000000000000000",
      "amount": "80.000000000000000000"
    }
  ],
  "ts": 1710000000000
}
""",
)
def depth(
    symbol: str = Query(
        ...,
        description="交易对，例如 MFCUSDT（不区分大小写）",
    ),
    limit: int = Query(
        20,
        ge=1,
        le=200,
        description="盘口档位数量，默认 20，最大 200",
    ),
    db: Session = Depends(get_db),
):
    try:
        return get_depth(db=db, symbol=symbol, limit=limit)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"get depth failed: {str(e)}")


@router.get(
    "/trades",
    response_model=TradesResponse,
    summary="获取最新成交",
    description="""
获取指定交易对的最新成交记录。

接口规则：
1. 数据来源：trades 成交表
2. 按最新成交倒序返回（最新的在前）
3. 用于交易页面“最新成交”区域
4. symbol 不区分大小写，后端会自动转大写
5. 返回的 symbol 统一为标准大写格式

请求示例：
GET /market/trades?symbol=MFCUSDT&limit=50

返回示例：
{
  "symbol": "MFCUSDT",
  "trades": [
    {
      "price": "1.200000000000000000",
      "amount": "10.000000000000000000",
      "side": "BUY",
      "ts": 1710000000000
    }
  ]
}
""",
)
def trades(
    symbol: str = Query(
        ...,
        description="交易对，例如 MFCUSDT（不区分大小写）",
    ),
    limit: int = Query(
        50,
        ge=1,
        le=200,
        description="返回成交条数，默认 50，最大 200",
    ),
    db: Session = Depends(get_db),
):
    try:
        return get_trades(db=db, symbol=symbol, limit=limit)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"get trades failed: {str(e)}")


@router.get(
    "/kline",
    response_model=KlineResponse,
    summary="获取K线",
    description="""
获取指定交易对的K线数据。

接口规则：
1. 数据来源：trades 成交表
2. 按时间聚合生成 OHLC
3. 支持按时间游标向前翻页
4. symbol 不区分大小写
5. 不传 end_time 时，返回最近 limit 条
6. 传 end_time(ms) 时，返回 open_time < end_time 的更早 limit 条

请求示例：
GET /market/kline?symbol=MFCUSDT&interval=1m&limit=200
GET /market/kline?symbol=MFCUSDT&interval=1m&limit=200&end_time=1710000000000

返回示例：
{
  "symbol": "MFCUSDT",
  "interval": "1m",
  "items": [
    {
      "open_time": 1710000000000,
      "close_time": 1710000060000,
      "open": "1.0",
      "high": "1.2",
      "low": "0.9",
      "close": "1.1",
      "volume": "100",
      "quote_volume": "110"
    }
  ]
}
""",
)
def kline(
    symbol: str = Query(..., description="交易对"),
    interval: str = Query(..., description="1m / 5m / 15m / 1h / 4h / 1d"),
    limit: int = Query(
        200,
        ge=1,
        le=1000,
        description="返回K线数量，默认200，最大1000",
    ),
    end_time: Optional[int] = Query(
        None,
        description="历史翻页结束时间（毫秒时间戳）。不传则返回最近 limit 条；传入后返回 open_time < end_time 的更早K线。",
    ),
    end_time_ms: Optional[int] = Query(
        None,
        description="Historical pagination cursor in ms. Takes priority over end_time.",
    ),
    force_rest: bool = Query(
        False,
        description="Force REST/DB snapshot backfill and skip LIVE_WS kline overlay.",
    ),
    db: Session = Depends(get_db),
):
    try:
        cursor_end_time_ms = end_time_ms if end_time_ms is not None else end_time
        return get_klines(
            db=db,
            symbol=symbol,
            interval=interval,
            limit=limit,
            end_time_ms=cursor_end_time_ms,
            force_rest=force_rest,
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"kline error: {str(e)}")


@router.websocket("/ws/spot")
async def spot_market_ws(websocket: WebSocket):
    """
    现货行情 WebSocket
    连接示例：
    ws://127.0.0.1:8000/market/ws/spot?symbol=MFCUSDT

    说明：
    1. 首次连接成功后，立即推送一次最新 snapshot
    2. 前端可定时发送 ping，后端返回 pong
    3. 支持 subscribe:BTCUSDT 这种方式切换订阅交易对
    """
    symbol = (websocket.query_params.get("symbol") or "").upper().strip()
    interval_param = websocket.query_params.get("interval")
    interval = interval_param.strip() if interval_param is not None else None
    if not symbol:
        await websocket.close(code=1008)
        return

    db = SessionLocal()
    connected_symbol = symbol
    manager_connected = False

    try:
        try:
            _get_active_pair(db, connected_symbol)
        except ValueError:
            await websocket.close(code=1008)
            return

        await market_ws_manager.connect(connected_symbol, websocket, interval=interval)
        manager_connected = True

        await market_ws_manager.send_snapshot_to_client(db, connected_symbol, websocket)

        while True:
            try:
                message = await websocket.receive()

                msg_type = message.get("type")

                if msg_type == "websocket.disconnect":
                    break

                if msg_type == "websocket.receive":
                    text = message.get("text") or ""

                    if text == "ping":
                        await market_ws_manager.enqueue_to_client(
                            websocket,
                            "pong",
                            symbol=connected_symbol,
                            event_type="pong",
                        )
                        continue

                    try:
                        payload = json.loads(text)
                    except (TypeError, ValueError):
                        payload = None
                    if isinstance(payload, dict):
                        op = str(payload.get("op") or "").lower().strip()
                        domain = str(payload.get("domain") or "").lower().strip()
                        if op in {"subscribe", "unsubscribe"} and domain == "kline":
                            await market_ws_manager.set_kline_subscription(
                                connected_symbol,
                                websocket,
                                str(payload.get("interval") or ""),
                                subscribed=op == "subscribe",
                            )
                            continue

                    if text.startswith("subscribe:"):
                        new_symbol = text.split(":", 1)[1].upper().strip()
                        if new_symbol and new_symbol != connected_symbol:
                            try:
                                # End the current transaction before checking
                                # control-plane state on this long-lived socket.
                                db.rollback()
                                _get_active_pair(db, new_symbol)
                            except ValueError:
                                await websocket.close(code=1008)
                                break

                            if manager_connected:
                                await market_ws_manager.disconnect(connected_symbol, websocket)

                            connected_symbol = new_symbol
                            await market_ws_manager.connect(
                                connected_symbol,
                                websocket,
                                accepted=True,
                                interval=interval,
                            )
                            manager_connected = True

                            await market_ws_manager.send_snapshot_to_client(
                                db,
                                connected_symbol,
                                websocket,
                            )

            except WebSocketDisconnect:
                break
            except RuntimeError as e:
                if "WebSocket is not connected" in str(e):
                    break
                raise

    finally:
        if manager_connected:
            try:
                await market_ws_manager.disconnect(connected_symbol, websocket)
            except Exception:
                pass
        db.close()
