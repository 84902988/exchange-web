from __future__ import annotations

import logging
from typing import Any


logger = logging.getLogger(__name__)


def invalidate_contract_symbol_runtime(symbol: Any) -> None:
    """Apply a committed admin symbol change to process-local market runtime."""
    normalized_symbol = str(symbol or "").strip().upper()
    if not normalized_symbol:
        return
    try:
        # Lazy imports keep the large admin query module out of the market
        # runtime's import graph and ensure this only runs after DB commit.
        from app.services.contract_market_gateway import contract_market_gateway
        from app.services.contract_market_provider_service import clear_contract_market_provider_cache
        from app.services.contract_market_provider_ws import (
            force_stop_provider_ws_subscriptions_for_symbol,
        )

        clear_contract_market_provider_cache()
        force_stop_provider_ws_subscriptions_for_symbol(normalized_symbol)
        contract_market_gateway.invalidate_symbol_configuration(normalized_symbol)
    except Exception:
        # The database transaction is already committed. Runtime refresh is
        # best-effort here; normal gateway refresh remains the recovery path.
        logger.exception(
            "contract_symbol_runtime_invalidation_failed symbol=%s",
            normalized_symbol,
        )
