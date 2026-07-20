import asyncio
from types import SimpleNamespace

from fastapi import BackgroundTasks

from app.routers import contract_query


class _Db:
    def rollback(self):
        raise AssertionError("successful update must not roll back")


def test_manual_tp_sl_update_publishes_structural_position_refresh(monkeypatch):
    result = SimpleNamespace(
        symbol="XAUUSDT_PERP",
        position_id=17,
        model_dump=lambda: {
            "symbol": "XAUUSDT_PERP",
            "position_id": 17,
            "mark_price": "4011.99",
            "take_profit_price": "4013.35",
            "stop_loss_price": "4004.28",
        },
    )
    published = []
    monkeypatch.setattr(contract_query, "update_contract_position_tp_sl", lambda *_args, **_kwargs: result)
    monkeypatch.setattr(contract_query, "publish_contract_user_updates", lambda **kwargs: published.append(kwargs))
    background_tasks = BackgroundTasks()

    response = contract_query.contract_position_tp_sl_update(
        position_id=17,
        request=SimpleNamespace(state=SimpleNamespace(trace_id="trace")),
        payload=SimpleNamespace(),
        background_tasks=background_tasks,
        db=_Db(),
        user_id=42,
    )

    assert response["ok"] is True
    assert published == []

    asyncio.run(background_tasks())

    assert published == [{
        "user_id": 42,
        "symbols": ["XAUUSDT_PERP"],
        "position_ids": [17],
        "include_account": False,
        "prefer_transaction_mark": True,
    }]
