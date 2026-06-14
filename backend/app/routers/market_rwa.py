from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.db.session import get_db

from app.services.rwa_reference_service import (
    RwaReferenceBadRateError,
    RwaReferenceConfigError,
    RwaReferenceMissingRateError,
    RwaReferencePlanUnsupportedError,
    RwaReferenceSymbolUnsupportedError,
    RwaReferenceUpstreamError,
    debug_iron62_symbols,
    debug_supported_symbols,
    get_iron62_reference_price,
    get_iron62_reference_kline,
)

router = APIRouter(
    prefix="/market/rwa",
    tags=["market"],
)


@router.get("/debug-symbols")
def debug_symbols():
    try:
        return debug_iron62_symbols()
    except RwaReferenceConfigError as exc:
        raise HTTPException(
            status_code=503,
            detail={"code": "RWA_REFERENCE_CONFIG_MISSING", "message": str(exc)},
        )


@router.get("/debug-supported-symbols")
def debug_supported_symbols_route():
    try:
        return debug_supported_symbols()
    except RwaReferenceConfigError as exc:
        raise HTTPException(
            status_code=503,
            detail={"code": "RWA_REFERENCE_CONFIG_MISSING", "message": str(exc)},
        )


@router.get("/iron62/reference")
def iron62_reference(db: Session = Depends(get_db)):
    try:
        return get_iron62_reference_price(db)
    except RwaReferenceConfigError as exc:
        raise HTTPException(
            status_code=503,
            detail={"code": "RWA_REFERENCE_CONFIG_MISSING", "message": str(exc)},
        )
    except RwaReferenceUpstreamError as exc:
        raise HTTPException(
            status_code=503,
            detail={"code": "RWA_REFERENCE_UPSTREAM_FAILED", "message": str(exc)},
        )
    except RwaReferenceMissingRateError as exc:
        raise HTTPException(
            status_code=502,
            detail={"code": "RWA_REFERENCE_RATE_MISSING", "message": str(exc)},
        )
    except RwaReferenceBadRateError as exc:
        raise HTTPException(
            status_code=502,
            detail={"code": "RWA_REFERENCE_RATE_INVALID", "message": str(exc)},
        )
    except RwaReferenceSymbolUnsupportedError as exc:
        raise HTTPException(
            status_code=502,
            detail={"code": "RWA_REFERENCE_SYMBOL_UNSUPPORTED", "message": str(exc)},
        )
    except RwaReferencePlanUnsupportedError as exc:
        raise HTTPException(
            status_code=502,
            detail={"code": "RWA_REFERENCE_PLAN_UNSUPPORTED", "message": str(exc)},
        )


@router.get("/iron62/kline")
def iron62_kline(
    interval: str = Query("1d"),
    limit: int = Query(120, ge=1, le=365),
    db: Session = Depends(get_db),
):
    try:
        return get_iron62_reference_kline(db, interval=interval, limit=limit)
    except RwaReferenceConfigError as exc:
        raise HTTPException(
            status_code=503,
            detail={"code": "RWA_REFERENCE_CONFIG_MISSING", "message": str(exc)},
        )
    except RwaReferenceUpstreamError as exc:
        raise HTTPException(
            status_code=503,
            detail={"code": "RWA_REFERENCE_UPSTREAM_FAILED", "message": str(exc)},
        )
    except RwaReferenceMissingRateError as exc:
        raise HTTPException(
            status_code=502,
            detail={"code": "RWA_REFERENCE_RATE_MISSING", "message": str(exc)},
        )
    except RwaReferenceBadRateError as exc:
        raise HTTPException(
            status_code=502,
            detail={"code": "RWA_REFERENCE_RATE_INVALID", "message": str(exc)},
        )
    except RwaReferenceSymbolUnsupportedError as exc:
        raise HTTPException(
            status_code=502,
            detail={"code": "RWA_REFERENCE_SYMBOL_UNSUPPORTED", "message": str(exc)},
        )
    except RwaReferencePlanUnsupportedError as exc:
        raise HTTPException(
            status_code=502,
            detail={"code": "RWA_REFERENCE_PLAN_UNSUPPORTED", "message": str(exc)},
        )
