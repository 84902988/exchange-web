from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import func
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.core.content_locale import DEFAULT_CONTENT_LOCALE, localize_i18n_value
from app.db.models.reference_overlay import ReferenceOverlay


STOCK_REFERENCE_OVERLAY_DEFAULT_REFRESH_SECONDS = 15


def _decimal_to_text(value: Any) -> str | None:
    if value is None:
        return None
    try:
        decimal_value = Decimal(str(value))
    except Exception:
        return None
    return format(decimal_value.normalize(), "f") if decimal_value != 0 else "0"


def _datetime_to_text(value: Any) -> str | None:
    if value is None:
        return None
    isoformat = getattr(value, "isoformat", None)
    if callable(isoformat):
        return isoformat()
    return str(value)


def _positive_decimal(value: Any) -> Decimal | None:
    if value is None:
        return None
    try:
        decimal_value = Decimal(str(value))
    except Exception:
        return None
    return decimal_value if decimal_value > 0 else None


def _display_price_label(
    *,
    reference_type: str,
    display_price: Decimal,
    display_label: str | None,
) -> str | None:
    price_text = _decimal_to_text(display_price)
    if reference_type == "IRON" and price_text:
        return f"{price_text} USD/公斤"
    if reference_type == "GOLD" and price_text:
        return display_label or f"{price_text} USD/g"
    return display_label or price_text


def _normalize_text(value: Any) -> str:
    return str(value or "").strip().upper()


def _refresh_interval_seconds(overlay: ReferenceOverlay) -> int:
    try:
        interval = int(overlay.refresh_interval_sec or 0)
    except Exception:
        interval = 0
    return interval if interval > 0 else STOCK_REFERENCE_OVERLAY_DEFAULT_REFRESH_SECONDS


def _stock_overlay_should_refresh(overlay: ReferenceOverlay, *, now: datetime) -> bool:
    if int(overlay.enabled or 0) != 1:
        return False
    if _normalize_text(overlay.reference_type or overlay.kind) != "STOCK":
        return False
    if _normalize_text(overlay.price_source) != "AUTO":
        return False

    market_status = _normalize_text(overlay.market_status) or "UNKNOWN"
    if market_status not in {"OPEN", "UNKNOWN"}:
        return False

    last_sync_at = overlay.last_sync_at
    if last_sync_at is None:
        return True
    elapsed = (now - last_sync_at).total_seconds()
    return elapsed >= _refresh_interval_seconds(overlay)


def _maybe_refresh_stock_overlay(db: Session, overlay: ReferenceOverlay | None) -> ReferenceOverlay | None:
    if overlay is None:
        return None
    if not _stock_overlay_should_refresh(overlay, now=datetime.utcnow()):
        return overlay

    overlay_id = int(overlay.id)
    symbol = str(overlay.symbol or "")
    try:
        from app.services.reference_overlay_sync_service import sync_reference_overlay_once

        sync_reference_overlay_once(db, symbol)
    except Exception:
        db.rollback()
    return db.query(ReferenceOverlay).filter(ReferenceOverlay.id == overlay_id).first()


def _disabled_payload(
    symbol: str,
    *,
    sync_status: str | None = None,
    price_source: str | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "symbol": str(symbol or "").strip().upper(),
        "enabled": False,
    }
    if sync_status is not None:
        payload["sync_status"] = sync_status
    if price_source is not None:
        payload["price_source"] = price_source
    return payload


def serialize_reference_overlay(
    overlay: ReferenceOverlay | None,
    *,
    requested_symbol: str = "",
    locale: str = DEFAULT_CONTENT_LOCALE,
) -> dict[str, Any]:
    if overlay is None or int(overlay.enabled or 0) != 1:
        return _disabled_payload(str(requested_symbol or "").strip().upper())

    display_price = _positive_decimal(overlay.display_price)
    display_label = overlay.display_value_label
    source_price_label: str | None = None
    reference_type = str(overlay.reference_type or overlay.kind or "").strip().upper()
    price_source = str(overlay.price_source or "MANUAL").strip().upper()
    sync_status = str(overlay.sync_status or "PENDING").strip().upper()
    stale = False
    if price_source == "AUTO":
        last_ref_price = _positive_decimal(overlay.last_ref_price)
        if last_ref_price is not None:
            display_price = last_ref_price
            source_price_label = overlay.last_ref_label or None
        stale = sync_status == "FAILED"

    if display_price is None:
        return _disabled_payload(str(overlay.symbol or requested_symbol or "").strip().upper())

    display_price_label = _display_price_label(
        reference_type=reference_type,
        display_price=display_price,
        display_label=display_label,
    )

    localized_title = localize_i18n_value(getattr(overlay, "title_i18n", None), locale, overlay.title)
    localized_source_label = localize_i18n_value(
        getattr(overlay, "source_label_i18n", None),
        locale,
        overlay.source_label,
    )
    localized_description = localize_i18n_value(
        getattr(overlay, "description_i18n", None),
        locale,
        overlay.description,
    )
    localized_line_title = localize_i18n_value(
        getattr(overlay, "line_title_i18n", None),
        locale,
        overlay.line_title or localized_title,
    )
    localized_display_label = localize_i18n_value(
        getattr(overlay, "display_value_label_i18n", None),
        locale,
        display_label,
    )
    display_price_label = _display_price_label(
        reference_type=reference_type,
        display_price=display_price,
        display_label=localized_display_label,
    )

    return {
        "symbol": overlay.symbol,
        "enabled": True,
        "reference_type": overlay.reference_type or overlay.kind,
        "price_source": price_source,
        "sync_status": sync_status,
        "sync_error": overlay.sync_error,
        "stale": stale,
        "auto_source": overlay.auto_source,
        "refresh_interval_sec": overlay.refresh_interval_sec,
        "last_ref_price": _decimal_to_text(overlay.last_ref_price),
        "last_ref_label": overlay.last_ref_label,
        "last_sync_at": _datetime_to_text(overlay.last_sync_at),
        "market_status": overlay.market_status or "UNKNOWN",
        "market_status_text": overlay.market_status_text,
        "price_time": _datetime_to_text(overlay.price_time),
        "is_realtime": bool(overlay.is_realtime),
        "kind": overlay.kind,
        "title": localized_title,
        "subtitle": localized_source_label,
        "source_label": localized_source_label,
        "description": localized_description,
        "line_title": localized_line_title,
        "line_color": overlay.line_color or "#f0b90b",
        "badge_color": overlay.badge_color or overlay.line_color or "#f0b90b",
        "display_value_label": localized_display_label,
        "display_price": _decimal_to_text(display_price),
        "display_price_label": display_price_label,
        "source_price_label": source_price_label,
        "display_unit": overlay.display_unit,
        "data_source": overlay.data_source,
        "source_symbol": overlay.source_symbol,
        "source_region": overlay.source_region,
        "conversion_type": overlay.conversion_type,
        "conversion_factor": _decimal_to_text(overlay.conversion_factor),
    }


def get_reference_overlay_for_symbol(db: Session, symbol: str, *, locale: str = DEFAULT_CONTENT_LOCALE) -> dict[str, Any]:
    normalized_symbol = str(symbol or "").replace("/", "").replace("-", "").strip().upper()
    if not normalized_symbol:
        return {"symbol": "", "enabled": False}
    compact_symbol = normalized_symbol.replace("-", "")

    try:
        overlay = (
            db.query(ReferenceOverlay)
            .filter(ReferenceOverlay.symbol == normalized_symbol)
            .first()
        )
        if overlay is None and compact_symbol:
            overlay = (
                db.query(ReferenceOverlay)
                .filter(func.replace(ReferenceOverlay.symbol, "-", "") == compact_symbol)
                .first()
            )
        overlay = _maybe_refresh_stock_overlay(db, overlay)
    except SQLAlchemyError:
        db.rollback()
        raise

    return serialize_reference_overlay(overlay, requested_symbol=normalized_symbol, locale=locale)
