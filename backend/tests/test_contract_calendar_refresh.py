from __future__ import annotations

import asyncio

from app.services import contract_calendar_refresh as refresh


def _run_without_replacing_default_loop(coro):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


def test_refresh_runs_blocking_calendar_load_off_event_loop(monkeypatch) -> None:
    monkeypatch.setattr(refresh, "_refresh_once_sync", lambda: {"US": True})

    result = _run_without_replacing_default_loop(refresh.refresh_contract_calendars_once())

    assert result == {"US": True}


def test_refresh_task_is_singleton_and_stops_cleanly(monkeypatch) -> None:
    calls: list[int] = []

    async def fake_refresh_once() -> dict[str, bool]:
        calls.append(1)
        return {"US": True}

    monkeypatch.setattr(refresh, "refresh_contract_calendars_once", fake_refresh_once)
    monkeypatch.setattr(refresh, "REFRESH_INTERVAL_SECONDS", 3600)

    async def scenario() -> None:
        refresh.start_contract_calendar_refresh()
        first_task = refresh._refresh_task
        refresh.start_contract_calendar_refresh()
        assert refresh._refresh_task is first_task
        await asyncio.sleep(0)
        await refresh.stop_contract_calendar_refresh()
        assert first_task is not None
        assert first_task.done()

    _run_without_replacing_default_loop(scenario())

    assert calls == [1]
