from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.db.models.trading_pair import TradingPair
from app.db.session import get_db
from app.schemas.market_external import (
    ExternalDepthResponse,
    ExternalKlineResponse,
    ExternalTradesResponse,
    ExternalTickerResponse,
)
from app.services.binance_market_service import (
    BinanceMarketBadRequest,
    BinanceMarketUpstreamError,
    binance_market_service,
)

router = APIRouter(
    prefix="/market/external",
    tags=["market"],
)


def _get_price_precision(db: Session, symbol: str) -> int:
    normalized_symbol = str(symbol or "").upper().strip()
    pair = (
        db.query(TradingPair.price_precision)
        .filter(TradingPair.symbol == normalized_symbol, TradingPair.status == 1)
        .first()
    )
    if pair is None:
        return 8
    return int(pair[0] or 8)


@router.get(
    "/ticker",
    response_model=ExternalTickerResponse,
    summary="获取 Binance 外部行情 ticker",
    description="""
获取 Binance 指定交易对的最新价格、24 小时涨跌幅、24 小时成交量。

接口说明：
1. 数据来源：Binance Spot REST API
2. 仅做只读查询，不写入本地数据库
3. symbol 不区分大小写，后端会自动转成大写
4. 返回字段已适配为本项目统一风格，不直接透出 Binance 原始字段名

参数说明：
- symbol：交易对，例如 BTCUSDT、ETHUSDT

请求示例：
GET /market/external/ticker?symbol=BTCUSDT

返回示例：
{
  "symbol": "BTCUSDT",
  "price": "68000.12000000",
  "price_change_percent": "2.15",
  "volume": "12345.67890000",
  "quote_volume": "840000000.12345600",
  "ts": 1710000000000
}
""",
)
def external_ticker(
    symbol: str = Query(
        ...,
        description="交易对，示例：BTCUSDT（不区分大小写）",
        example="BTCUSDT",
    ),
):
    try:
        return binance_market_service.get_ticker(symbol=symbol)
    except BinanceMarketBadRequest as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except BinanceMarketUpstreamError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail="get external ticker failed: {0}".format(str(exc)),
        )


@router.get(
    "/depth",
    response_model=ExternalDepthResponse,
    summary="获取 Binance 外部行情盘口深度",
    description="""
获取 Binance 指定交易对的买盘 / 卖盘深度快照。

接口说明：
1. 数据来源：Binance Spot REST API
2. 返回 bids / asks 结构尽量与现有 /market/depth 保持一致
3. symbol 不区分大小写，后端会自动转成大写
4. limit 为本项目对外参数，service 层会自动适配 Binance 支持的档位并裁剪返回结果

参数说明：
- symbol：交易对，例如 BTCUSDT、ETHUSDT
- limit：返回档位数量，默认 20，最大 200

请求示例：
GET /market/external/depth?symbol=BTCUSDT&limit=20

返回示例：
{
  "symbol": "BTCUSDT",
  "bids": [
    {
      "price": "67999.99000000",
      "amount": "0.58000000"
    }
  ],
  "asks": [
    {
      "price": "68000.00000000",
      "amount": "1.25000000"
    }
  ],
  "ts": 1710000000000
}
""",
)
def external_depth(
    symbol: str = Query(
        ...,
        description="交易对，示例：BTCUSDT（不区分大小写）",
        example="BTCUSDT",
    ),
    limit: int = Query(
        20,
        ge=1,
        le=200,
        description="盘口档位数量，默认 20，最大 200",
        example=20,
    ),
    db: Session = Depends(get_db),
):
    try:
        response = binance_market_service.get_depth(symbol=symbol, limit=limit)
        response.price_precision = _get_price_precision(db, response.symbol)
        return response
    except BinanceMarketBadRequest as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except BinanceMarketUpstreamError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail="get external depth failed: {0}".format(str(exc)),
        )


@router.get(
    "/klines",
    response_model=ExternalKlineResponse,
    summary="获取 Binance 外部行情 K 线",
    description="""
获取 Binance 指定交易对的 K 线数据。

接口说明：
1. 数据来源：Binance Spot REST API
2. 当前支持 1m / 5m / 15m / 1h / 4h / 1d
3. 返回字段尽量与现有 /market/kline 保持一致
4. 若传 end_time，则语义对齐现有接口：返回 open_time < end_time 的更早 K 线
5. service 层会把 Binance 原始 K 线数组适配为结构化字段

参数说明：
- symbol：交易对，例如 BTCUSDT、ETHUSDT
- interval：K 线周期，仅支持 1m / 5m / 15m / 1h / 4h / 1d
- limit：返回数量，默认 200，最大 1000
- end_time：可选，毫秒时间戳，用于历史翻页

请求示例：
GET /market/external/klines?symbol=BTCUSDT&interval=1m&limit=200
GET /market/external/klines?symbol=BTCUSDT&interval=1h&limit=100&end_time=1710000000000

返回示例：
{
  "symbol": "BTCUSDT",
  "interval": "1m",
  "items": [
    {
      "open_time": 1710000000000,
      "close_time": 1710000060000,
      "open": "67990.00000000",
      "high": "68010.00000000",
      "low": "67980.00000000",
      "close": "68000.12000000",
      "volume": "12.34560000",
      "quote_volume": "839000.12000000"
    }
  ]
}
""",
)
def external_klines(
    symbol: str = Query(
        ...,
        description="交易对，示例：BTCUSDT（不区分大小写）",
        example="BTCUSDT",
    ),
    interval: str = Query(
        "1m",
        description="K 线周期，仅支持 1m / 5m / 15m / 1h / 4h / 1d",
        example="1m",
    ),
    limit: int = Query(
        200,
        ge=1,
        le=1000,
        description="返回 K 线数量，默认 200，最大 1000",
        example=200,
    ),
    end_time: Optional[int] = Query(
        None,
        description="可选，毫秒时间戳；传入后返回 open_time < end_time 的更早 K 线",
        example=1710000000000,
    ),
):
    try:
        return binance_market_service.get_klines(
            symbol=symbol,
            interval=interval,
            limit=limit,
            end_time_ms=end_time,
        )
    except BinanceMarketBadRequest as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except BinanceMarketUpstreamError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail="get external klines failed: {0}".format(str(exc)),
        )


@router.get(
    "/trades",
    response_model=ExternalTradesResponse,
    summary="获取 Binance 外部行情最新成交",
    description="""
获取 Binance 指定交易对的最新成交记录。

接口说明：
1. 数据来源：Binance Spot REST API recent trades
2. 当前仅做只读查询，不写入本地数据库
3. symbol 不区分大小写，后端会自动转成大写
4. 返回字段已适配为项目现有 market/trades 风格，不直接透出 Binance 原始字段名
5. items 中至少包含 price、amount、ts，方便前端直接复用

参数说明：
- symbol：交易对，例如 BTCUSDT、ETHUSDT
- limit：返回成交条数，默认 50，最大 200

请求示例：
GET /market/external/trades?symbol=BTCUSDT&limit=50

返回示例：
{
  "symbol": "BTCUSDT",
  "items": [
    {
      "price": "68000.12000000",
      "amount": "0.01500000",
      "ts": 1710000000000,
      "side": "BUY"
    }
  ]
}
""",
)
def external_trades(
    symbol: str = Query(
        ...,
        description="交易对，示例：BTCUSDT（不区分大小写）",
        example="BTCUSDT",
    ),
    limit: int = Query(
        50,
        ge=1,
        le=200,
        description="返回成交条数，默认 50，最大 200",
        example=50,
    ),
):
    try:
        return binance_market_service.get_trades(symbol=symbol, limit=limit)
    except BinanceMarketBadRequest as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except BinanceMarketUpstreamError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail="get external trades failed: {0}".format(str(exc)),
        )
