from __future__ import annotations

import sys
from types import ModuleType, SimpleNamespace

from app.services.contract_symbol_runtime_lifecycle import (
    invalidate_contract_symbol_runtime,
)


def test_committed_symbol_change_invalidates_every_process_local_owner(monkeypatch) -> None:
    calls: list[tuple[str, str | None]] = []

    gateway_module = ModuleType("app.services.contract_market_gateway")
    gateway_module.contract_market_gateway = SimpleNamespace(
        invalidate_symbol_configuration=lambda symbol: calls.append(("gateway", symbol)),
    )
    provider_service_module = ModuleType("app.services.contract_market_provider_service")
    provider_service_module.clear_contract_market_provider_cache = lambda: calls.append(
        ("provider_cache", None),
    )
    provider_ws_module = ModuleType("app.services.contract_market_provider_ws")
    provider_ws_module.force_stop_provider_ws_subscriptions_for_symbol = (
        lambda symbol: calls.append(("provider_ws", symbol))
    )

    monkeypatch.setitem(sys.modules, gateway_module.__name__, gateway_module)
    monkeypatch.setitem(sys.modules, provider_service_module.__name__, provider_service_module)
    monkeypatch.setitem(sys.modules, provider_ws_module.__name__, provider_ws_module)

    invalidate_contract_symbol_runtime("  eurusd_perp  ")

    assert calls == [
        ("provider_cache", None),
        ("provider_ws", "EURUSD_PERP"),
        ("gateway", "EURUSD_PERP"),
    ]


def test_blank_symbol_change_is_a_noop() -> None:
    invalidate_contract_symbol_runtime("   ")
