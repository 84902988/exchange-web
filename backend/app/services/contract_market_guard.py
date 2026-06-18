from __future__ import annotations

import logging
import time
from typing import Any


logger = logging.getLogger(__name__)

CONTRACT_QUOTE_NOT_LIVE = "CONTRACT_QUOTE_NOT_LIVE"
QUOTE_FRESHNESS_LIVE = "LIVE"
QUOTE_SOURCE_LAST_GOOD_BBO = "LAST_GOOD_BBO"
_EXECUTABLE_CLOSED_MARKET_STATUSES = {"CLOSED", "HOLIDAY"}
_UNSAFE_EXECUTABLE_SOURCE_TOKENS = ("FALLBACK", "LAST_VALID", "STALE")
_LAST_SKIP_LOG_AT: dict[str, float] = {}


class ContractQuoteNotLive(ValueError):
    code = CONTRACT_QUOTE_NOT_LIVE


def _normalized(value: Any) -> str:
    return str(value or "").strip().upper()


def is_executable_contract_quote(quote: dict[str, Any]) -> bool:
    quote_freshness = _normalized(quote.get("quote_freshness") if isinstance(quote, dict) else None)
    source = _normalized((quote.get("quote_source") or quote.get("source")) if isinstance(quote, dict) else None)
    market_status = _normalized(quote.get("market_status") if isinstance(quote, dict) else None)
    if source == QUOTE_SOURCE_LAST_GOOD_BBO and market_status in _EXECUTABLE_CLOSED_MARKET_STATUSES:
        return True
    if quote_freshness != QUOTE_FRESHNESS_LIVE:
        return False
    return not any(token in source for token in _UNSAFE_EXECUTABLE_SOURCE_TOKENS)


def should_log_contract_quote_skip(key: str, interval_sec: int = 60) -> bool:
    now = time.time()
    last = _LAST_SKIP_LOG_AT.get(key, 0)
    if now - last >= interval_sec:
        _LAST_SKIP_LOG_AT[key] = now
        return True
    return False


def require_executable_contract_quote(
    quote: dict[str, Any],
    context: str,
    symbol: str,
    *,
    order_id: Any = None,
    position_id: Any = None,
    user_id: Any = None,
) -> None:
    if is_executable_contract_quote(quote):
        return

    quote_freshness = _normalized(quote.get("quote_freshness") if isinstance(quote, dict) else None)
    source = _normalized((quote.get("quote_source") or quote.get("source")) if isinstance(quote, dict) else None)
    market_status = _normalized(quote.get("market_status") if isinstance(quote, dict) else None)
    log_key = f"executable_quote:{symbol}:{order_id}:{CONTRACT_QUOTE_NOT_LIVE}"
    if should_log_contract_quote_skip(log_key):
        logger.debug(
            "contract executable quote rejected symbol=%s context=%s market_status=%s freshness=%s source=%s "
            "reason=%s order_id=%s position_id=%s user_id=%s",
            symbol,
            context,
            market_status,
            quote_freshness,
            source,
            CONTRACT_QUOTE_NOT_LIVE,
            order_id,
            position_id,
            user_id,
        )
    raise ContractQuoteNotLive(CONTRACT_QUOTE_NOT_LIVE)
