from __future__ import annotations

import asyncio
import inspect

from fastapi import BackgroundTasks

from app.routers import contract_order


def test_order_router_uses_async_private_event_background_entrypoint():
    assert inspect.iscoroutinefunction(contract_order.publish_contract_user_updates)


def test_order_result_publishes_entities_first_and_defers_account_reconciliation(monkeypatch):
    published: list[dict] = []
    monkeypatch.setattr(
        contract_order,
        "publish_contract_user_updates",
        lambda **kwargs: published.append(kwargs),
    )
    background_tasks = BackgroundTasks()

    contract_order._publish_order_result(
        background_tasks,
        user_id=42,
        symbols=["XAUUSDT_PERP"],
        position_ids=[17],
        order_ids=[31],
        trade_ids=[44],
    )

    assert published == []

    asyncio.run(background_tasks())

    assert published[0] == {
        "user_id": 42,
        "symbols": ["XAUUSDT_PERP"],
        "position_ids": [17],
        "order_ids": [31],
        "trade_ids": [44],
        "include_account": False,
        "prefer_transaction_mark": True,
    }

    assert published[-1] == {
        "user_id": 42,
        "include_account": True,
    }
