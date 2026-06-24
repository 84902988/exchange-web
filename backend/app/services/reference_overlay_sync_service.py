from __future__ import annotations

from datetime import datetime
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from typing import Any

from sqlalchemy.orm import Session

from app.db.models.reference_overlay import ReferenceOverlay
from app.services.itick_market_service import itick_market_service
from app.services.rwa_reference_service import get_iron62_reference_price


TROY_OUNCE_GRAMS = Decimal("31.1034768")
GOLD_DISPLAY_PRICE_QUANT = Decimal("0.01")


def _normalize_symbol(symbol: str) -> str:
    return str(symbol or "").replace("/", "").strip().upper()


def _normalize_text(value: Any) -> str:
    return str(value or "").strip().upper()


def _stock_source_symbol(overlay: ReferenceOverlay) -> str:
    source_symbol = _normalize_text(overlay.source_symbol)
    if not source_symbol:
        raise ValueError("stock reference overlay requires source_symbol")
    return source_symbol


def _stock_source_region(overlay: ReferenceOverlay) -> str:
    return _normalize_text(overlay.source_region) or "US"


def _decimal_from_payload(value: Any) -> Decimal:
    try:
        decimal_value = Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError) as exc:
        raise ValueError("invalid reference price") from exc
    if decimal_value <= 0:
        raise ValueError("reference price must be greater than zero")
    return decimal_value


def _decimal_text(value: Decimal) -> str:
    return format(value.normalize(), "f") if value != 0 else "0"


def _error_text(exc: Exception) -> str:
    return f"{type(exc).__name__}: {exc}"[:500]


def _quote_data(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        return {}
    data = payload.get("data")
    if isinstance(data, dict):
        return data
    if isinstance(data, list):
        for item in data:
            if isinstance(item, dict):
                return item
    return {}


def _pick_decimal(payload: Any, keys: tuple[str, ...]) -> Decimal:
    data = _quote_data(payload)
    candidates: list[Any] = []
    if data:
        candidates.extend(data.get(key) for key in keys)
    if isinstance(payload, dict):
        candidates.extend(payload.get(key) for key in keys)

    for raw_value in candidates:
        if raw_value in (None, ""):
            continue
        try:
            return _decimal_from_payload(raw_value)
        except ValueError:
            continue
    raise ValueError("iTick quote missing valid price")


def _quote_time(payload: Any, fallback: datetime) -> datetime:
    data = _quote_data(payload)
    candidates: list[Any] = []
    if data:
        candidates.extend(data.get(key) for key in ("price_time", "time", "datetime", "ts", "t", "tu"))
    if isinstance(payload, dict):
        candidates.extend(payload.get(key) for key in ("price_time", "time", "datetime", "ts", "t", "tu"))

    for raw_value in candidates:
        if raw_value in (None, ""):
            continue
        if isinstance(raw_value, (int, float)):
            timestamp = float(raw_value)
            if timestamp <= 0:
                continue
            if timestamp > 10_000_000_000:
                timestamp = timestamp / 1000
            if timestamp <= 0:
                continue
            try:
                return datetime.utcfromtimestamp(timestamp)
            except (OverflowError, OSError, ValueError):
                continue
        if isinstance(raw_value, str):
            text = raw_value.strip()
            if not text:
                continue
            try:
                timestamp = float(text)
                if timestamp <= 0:
                    continue
                if timestamp > 10_000_000_000:
                    timestamp = timestamp / 1000
                if timestamp <= 0:
                    continue
                return datetime.utcfromtimestamp(timestamp)
            except (OverflowError, OSError, ValueError):
                pass
            try:
                parsed = datetime.fromisoformat(text.replace("Z", "+00:00")).replace(tzinfo=None)
                if parsed.timestamp() <= 0:
                    continue
                return parsed
            except ValueError:
                continue
    return fallback


def _mark_failed(db: Session, overlay_id: int, error_message: str) -> dict[str, Any]:
    overlay = db.query(ReferenceOverlay).filter(ReferenceOverlay.id == overlay_id).first()
    if overlay is None:
        db.rollback()
        return {"status": "skipped", "reason": "not_found"}

    now = datetime.utcnow()
    overlay.sync_status = "FAILED"
    overlay.sync_error = error_message[:500]
    overlay.last_sync_at = now
    overlay.updated_at = now
    db.commit()
    return {
        "status": "failed",
        "symbol": overlay.symbol,
        "sync_status": "FAILED",
        "error": overlay.sync_error,
    }


def _sync_iron_overlay(db: Session, overlay: ReferenceOverlay, normalized_symbol: str) -> dict[str, Any]:
    if normalized_symbol != "MFCUSDT":
        return {"status": "skipped", "reason": "unsupported_symbol", "symbol": normalized_symbol}

    overlay_id = int(overlay.id)
    try:
        reference = get_iron62_reference_price(db)
        usd_per_ton = _decimal_from_payload(
            reference.get("iron62_usd_per_ton") or reference.get("usd_per_ton")
        )
        display_price = _decimal_from_payload(
            reference.get("mfc_usdt_price") or (usd_per_ton / Decimal("1000"))
        )
        display_label = f"{_decimal_text(display_price)} USD/公斤"
        source_label = f"{_decimal_text(usd_per_ton)} USD/吨"
        price_time = datetime.utcnow()
    except Exception as exc:
        db.rollback()
        return _mark_failed(db, overlay_id, _error_text(exc))

    return _mark_success(
        db,
        overlay_id=overlay_id,
        normalized_symbol=normalized_symbol,
        display_price=display_price,
        display_label=display_label,
        source_label=source_label,
        price_time=price_time,
    )


def _sync_gold_overlay(db: Session, overlay: ReferenceOverlay, normalized_symbol: str) -> dict[str, Any]:
    if normalized_symbol != "IGCUSDT":
        return {"status": "skipped", "reason": "unsupported_symbol", "symbol": normalized_symbol}
    if _normalize_text(overlay.auto_source) != "XAUUSD" or _normalize_text(overlay.source_symbol) != "XAUUSD":
        return {"status": "skipped", "reason": "unsupported_gold_config", "symbol": normalized_symbol}

    overlay_id = int(overlay.id)
    try:
        payload = itick_market_service.get_market_quote(market="forex", region="GB", code="XAUUSD")
        xau_usd_price = _pick_decimal(payload, ("ld", "price", "last", "close"))
        display_price = _decimal_from_payload(xau_usd_price / TROY_OUNCE_GRAMS)
        display_label = f"{_decimal_text(display_price.quantize(GOLD_DISPLAY_PRICE_QUANT, rounding=ROUND_HALF_UP))} USD/g"
        source_label = f"{_decimal_text(xau_usd_price)} USD/oz"
        price_time = _quote_time(payload, overlay.last_sync_at or datetime.utcnow())
    except Exception as exc:
        db.rollback()
        return _mark_failed(db, overlay_id, _error_text(exc))

    return _mark_success(
        db,
        overlay_id=overlay_id,
        normalized_symbol=normalized_symbol,
        display_price=display_price,
        display_label=display_label,
        source_label=source_label,
        price_time=price_time,
        display_unit="USD/g",
    )


def _sync_stock_overlay(db: Session, overlay: ReferenceOverlay, normalized_symbol: str) -> dict[str, Any]:
    overlay_id = int(overlay.id)
    try:
        source_symbol = _stock_source_symbol(overlay)
        source_region = _stock_source_region(overlay)
        payload = itick_market_service.get_stock_quote(
            region=source_region,
            code=source_symbol,
            timeout=3,
        )
        latest_price = _pick_decimal(payload, ("ld", "price", "last", "close", "p", "c"))
        display_label = f"{_decimal_text(latest_price)} USD"
        price_time = _quote_time(payload, overlay.last_sync_at or datetime.utcnow())
    except Exception as exc:
        db.rollback()
        return _mark_failed(db, overlay_id, _error_text(exc))

    return _mark_success(
        db,
        overlay_id=overlay_id,
        normalized_symbol=normalized_symbol,
        display_price=latest_price,
        display_label=display_label,
        price_time=price_time,
        market_status="OPEN",
        market_status_text="实时",
        is_realtime=True,
    )


def _mark_success(
    db: Session,
    *,
    overlay_id: int,
    normalized_symbol: str,
    display_price: Decimal,
    display_label: str,
    price_time: datetime,
    source_label: str | None = None,
    display_unit: str | None = None,
    market_status: str = "OPEN",
    market_status_text: str = "实时",
    is_realtime: bool = True,
) -> dict[str, Any]:
    overlay = db.query(ReferenceOverlay).filter(ReferenceOverlay.id == overlay_id).first()
    if overlay is None:
        return {"status": "skipped", "reason": "not_found", "symbol": normalized_symbol}

    now = datetime.utcnow()
    overlay.last_ref_price = display_price
    overlay.last_ref_label = source_label or display_label
    overlay.last_sync_at = now
    overlay.sync_status = "SUCCESS"
    overlay.sync_error = None
    overlay.market_status = market_status or "UNKNOWN"
    overlay.market_status_text = market_status_text or ""
    overlay.is_realtime = bool(is_realtime)
    overlay.price_time = price_time
    overlay.display_price = display_price
    overlay.display_value_label = display_label
    if display_unit:
        overlay.display_unit = display_unit
    overlay.updated_at = now
    db.commit()

    return {
        "status": "success",
        "symbol": normalized_symbol,
        "sync_status": "SUCCESS",
        "last_ref_price": _decimal_text(display_price),
        "last_ref_label": source_label or display_label,
        "display_price": _decimal_text(display_price),
        "display_value_label": display_label,
    }


def sync_reference_overlay_once(db: Session, symbol: str) -> dict[str, Any]:
    normalized_symbol = _normalize_symbol(symbol)
    if not normalized_symbol:
        return {"status": "skipped", "reason": "empty_symbol"}

    overlay = (
        db.query(ReferenceOverlay)
        .filter(ReferenceOverlay.symbol == normalized_symbol)
        .first()
    )
    if overlay is None:
        return {"status": "skipped", "reason": "not_found", "symbol": normalized_symbol}
    if int(overlay.enabled or 0) != 1:
        return {"status": "skipped", "reason": "disabled", "symbol": normalized_symbol}
    if _normalize_text(overlay.price_source) != "AUTO":
        return {"status": "skipped", "reason": "price_source_not_auto", "symbol": normalized_symbol}

    reference_type = _normalize_text(overlay.reference_type)
    if reference_type == "IRON":
        return _sync_iron_overlay(db, overlay, normalized_symbol)
    if reference_type == "GOLD":
        return _sync_gold_overlay(db, overlay, normalized_symbol)
    if reference_type == "STOCK":
        return _sync_stock_overlay(db, overlay, normalized_symbol)

    return {
        "status": "skipped",
        "reason": "unsupported_reference_type",
        "symbol": normalized_symbol,
    }
