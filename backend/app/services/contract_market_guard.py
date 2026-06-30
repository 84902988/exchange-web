from __future__ import annotations

import logging
import time
from typing import Any


logger = logging.getLogger(__name__)

CONTRACT_QUOTE_NOT_LIVE = "CONTRACT_QUOTE_NOT_LIVE"
QUOTE_FRESHNESS_LIVE = "LIVE"
_NON_EXECUTABLE_MARKET_STATUSES = {"CLOSED", "HOLIDAY", "SUSPENDED", "UNKNOWN"}
_UNSAFE_EXECUTABLE_SOURCE_TOKENS = ("FALLBACK", "LAST_VALID", "LAST_GOOD", "STALE", "INVALID", "CACHE_STALE")
_LAST_SKIP_LOG_AT: dict[str, float] = {}


class ContractQuoteNotLive(ValueError):
    code = CONTRACT_QUOTE_NOT_LIVE


def _normalized(value: Any) -> str:
    return str(value or "").strip().upper()


def executable_contract_quote_rejection_reason(
    quote: dict[str, Any],
    *,
    require_mark_price: bool = True,
) -> str | None:
    if not isinstance(quote, dict):
        return "quote_not_live"

    quote_freshness = _normalized(quote.get("quote_freshness") if isinstance(quote, dict) else None)
    source = _normalized((quote.get("quote_source") or quote.get("source")) if isinstance(quote, dict) else None)
    market_status = _normalized(quote.get("market_status") if isinstance(quote, dict) else None)
    if not market_status or market_status in _NON_EXECUTABLE_MARKET_STATUSES:
        return "market_closed_not_executable"
    if quote_freshness != QUOTE_FRESHNESS_LIVE:
        return "quote_not_live"
    if any(token in source for token in _UNSAFE_EXECUTABLE_SOURCE_TOKENS):
        return "quote_source_not_executable"

    bid = quote.get("bid_price") or quote.get("best_bid") or quote.get("bid")
    ask = quote.get("ask_price") or quote.get("best_ask") or quote.get("ask")
    try:
        bid_value = float(bid)
        ask_value = float(ask)
    except Exception:
        return "missing_executable_bbo"
    if bid_value <= 0 or ask_value <= 0 or ask_value < bid_value:
        return "missing_executable_bbo"

    if require_mark_price:
        try:
            mark_value = float(quote.get("mark_price"))
        except Exception:
            return "missing_executable_mark_price"
        if mark_value <= 0:
            return "missing_executable_mark_price"

    return None


def is_executable_contract_quote(quote: dict[str, Any], *, require_mark_price: bool = True) -> bool:
    return executable_contract_quote_rejection_reason(quote, require_mark_price=require_mark_price) is None


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
    require_mark_price: bool = True,
) -> None:
    reason = executable_contract_quote_rejection_reason(quote, require_mark_price=require_mark_price)
    if reason is None:
        return

    quote_freshness = _normalized(quote.get("quote_freshness") if isinstance(quote, dict) else None)
    source = _normalized((quote.get("quote_source") or quote.get("source")) if isinstance(quote, dict) else None)
    market_status = _normalized(quote.get("market_status") if isinstance(quote, dict) else None)
    log_key = f"executable_quote:{symbol}:{order_id}:{reason}"
    if should_log_contract_quote_skip(log_key):
        logger.debug(
            "contract executable quote rejected symbol=%s context=%s market_status=%s freshness=%s source=%s "
            "reason=%s order_id=%s position_id=%s user_id=%s",
            symbol,
            context,
            market_status,
            quote_freshness,
            source,
            reason,
            order_id,
            position_id,
            user_id,
        )
    raise ContractQuoteNotLive(reason)
