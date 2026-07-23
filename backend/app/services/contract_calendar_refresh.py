from __future__ import annotations

import asyncio
import logging
from typing import Optional


logger = logging.getLogger(__name__)

REFRESH_INTERVAL_SECONDS = 6 * 60 * 60
DEFAULT_CALENDAR_CODES = {"US"}

_refresh_task: Optional[asyncio.Task] = None
_stop_event: Optional[asyncio.Event] = None


def _active_calendar_codes() -> set[str]:
    from app.db.models.contract_symbol import ContractSymbol
    from app.db.session import SessionLocal

    db = SessionLocal()
    try:
        rows = (
            db.query(ContractSymbol.holiday_calendar_code)
            .filter(
                ContractSymbol.status == 1,
                ContractSymbol.holiday_calendar_code.isnot(None),
            )
            .distinct()
            .all()
        )
        codes = {
            str(row[0] or "").strip().upper()
            for row in rows
            if str(row[0] or "").strip()
        }
        return codes or set(DEFAULT_CALENDAR_CODES)
    except Exception as exc:
        db.rollback()
        logger.warning("contract calendar code discovery failed reason=%s", exc)
        return set(DEFAULT_CALENDAR_CODES)
    finally:
        db.close()


def _refresh_once_sync() -> dict[str, bool]:
    from app.services.itick_holiday_service import itick_holiday_service

    codes = sorted(_active_calendar_codes())
    return itick_holiday_service.prewarm(codes)


async def refresh_contract_calendars_once() -> dict[str, bool]:
    try:
        results = await asyncio.to_thread(_refresh_once_sync)
    except Exception:
        logger.exception("contract calendar refresh failed")
        return {}
    failed = sorted(code for code, ok in results.items() if not ok)
    if failed:
        logger.warning("contract calendar refresh incomplete failed_codes=%s", failed)
    else:
        logger.info("contract calendar refresh complete codes=%s", sorted(results))
    return results


async def _refresh_loop(stop_event: asyncio.Event) -> None:
    while not stop_event.is_set():
        await refresh_contract_calendars_once()
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=REFRESH_INTERVAL_SECONDS)
        except asyncio.TimeoutError:
            continue


def start_contract_calendar_refresh() -> None:
    global _refresh_task, _stop_event
    if _refresh_task is not None and not _refresh_task.done():
        return
    _stop_event = asyncio.Event()
    _refresh_task = asyncio.create_task(
        _refresh_loop(_stop_event),
        name="contract-calendar-refresh",
    )


async def stop_contract_calendar_refresh() -> None:
    global _refresh_task, _stop_event
    task = _refresh_task
    stop_event = _stop_event
    _refresh_task = None
    _stop_event = None
    if task is None:
        return
    if stop_event is not None:
        stop_event.set()
    try:
        await asyncio.wait_for(task, timeout=2)
    except asyncio.TimeoutError:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
