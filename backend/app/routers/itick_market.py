from fastapi import APIRouter, HTTPException, Query

from app.services.itick_market_service import (
    ItickMarketBadRequest,
    ItickMarketUpstreamError,
    itick_market_service,
)

router = APIRouter(
    prefix="/market/itick",
    tags=["market"],
)


@router.get("/stock/quote", summary="Get iTick stock quote")
def itick_stock_quote(
    region: str = Query(..., example="US"),
    code: str = Query(..., example="AAPL"),
):
    try:
        return itick_market_service.get_stock_quote(region=region, code=code)
    except ItickMarketBadRequest as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except ItickMarketUpstreamError as exc:
        raise HTTPException(status_code=502, detail=str(exc))


@router.get("/stock/info", summary="Get iTick stock info")
def itick_stock_info(
    region: str = Query(..., example="US"),
    code: str = Query(..., example="AAPL"),
):
    try:
        return itick_market_service.get_stock_info(region=region, code=code)
    except ItickMarketBadRequest as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except ItickMarketUpstreamError as exc:
        raise HTTPException(status_code=502, detail=str(exc))


@router.get("/stock/kline", summary="Get iTick stock kline")
def itick_stock_kline(
    region: str = Query(..., example="US"),
    code: str = Query(..., example="AAPL"),
    kType: int = Query(..., ge=1, example=8),
    limit: int = Query(100, ge=1, le=1000, example=100),
):
    try:
        return itick_market_service.get_stock_kline(
            region=region,
            code=code,
            kType=kType,
            limit=limit,
        )
    except ItickMarketBadRequest as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except ItickMarketUpstreamError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
