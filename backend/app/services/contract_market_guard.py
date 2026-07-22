from __future__ import annotations

import logging
import time
from typing import Any

from app.services.contract_trading_session_resolver import resolve_contract_trading_session


logger = logging.getLogger(__name__)

CONTRACT_QUOTE_NOT_LIVE = "CONTRACT_QUOTE_NOT_LIVE"
QUOTE_FRESHNESS_LIVE = "LIVE"
QUOTE_SOURCE_LAST_GOOD_BBO = "LAST_GOOD_BBO"
_NON_EXECUTABLE_MARKET_STATUSES = {"CLOSED", "HOLIDAY", "SUSPENDED", "UNKNOWN"}
_CLOSED_MARKET_LAST_GOOD_BBO_MAX_AGE_SECONDS = 72 * 60 * 60
_UNSAFE_EXECUTABLE_SOURCE_TOKENS = (
    "FALLBACK",
    "LAST_VALID",
    "LAST_GOOD",
    "STALE",
    "INVALID",
    "CACHE_STALE",
    "DERIVED_BBO",
)
_LAST_SKIP_LOG_AT: dict[str, float] = {}


class ContractQuoteNotLive(ValueError):
    code = CONTRACT_QUOTE_NOT_LIVE


def _normalized(value: Any) -> str:
    return str(value or "").strip().upper()


def _valid_bbo(quote: dict[str, Any]) -> tuple[float, float] | None:
    bid = quote.get("bid_price") or quote.get("best_bid") or quote.get("bid")
    ask = quote.get("ask_price") or quote.get("best_ask") or quote.get("ask")
    try:
        bid_value = float(bid)
        ask_value = float(ask)
    except Exception:
        return None
    if bid_value <= 0 or ask_value <= 0 or ask_value < bid_value:
        return None
    return bid_value, ask_value


def executable_contract_quote_rejection_reason(
    quote: dict[str, Any],
    *,
    require_mark_price: bool = True,
    contract_symbol: Any = None,
) -> str | None:
    if not isinstance(quote, dict):
        return "quote_not_live"

    quote_freshness = _normalized(quote.get("quote_freshness") if isinstance(quote, dict) else None)
    source = _normalized((quote.get("quote_source") or quote.get("source")) if isinstance(quote, dict) else None)
    market_status = _normalized(quote.get("market_status") if isinstance(quote, dict) else None)
    trading_session = resolve_contract_trading_session(
        contract_symbol=contract_symbol,
        quote=quote,
    )
    if not trading_session.trading_allowed:
        return str(trading_session.reason_code or "non_trading_session").lower()
    if not market_status or market_status in _NON_EXECUTABLE_MARKET_STATUSES:
        return "market_closed_not_executable"
    if quote_freshness != QUOTE_FRESHNESS_LIVE:
        return "quote_not_live"
    if any(token in source for token in _UNSAFE_EXECUTABLE_SOURCE_TOKENS):
        return "quote_source_not_executable"

    if _valid_bbo(quote) is None:
        return "missing_executable_bbo"

    if require_mark_price:
        try:
            mark_value = float(quote.get("mark_price"))
        except Exception:
            return "missing_executable_mark_price"
        if mark_value <= 0:
            return "missing_executable_mark_price"

    return None


def is_executable_contract_quote(
    quote: dict[str, Any],
    *,
    require_mark_price: bool = True,
    contract_symbol: Any = None,
) -> bool:
    return (
        executable_contract_quote_rejection_reason(
            quote,
            require_mark_price=require_mark_price,
            contract_symbol=contract_symbol,
        )
        is None
    )


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
    contract_symbol: Any = None,
) -> None:
    reason = executable_contract_quote_rejection_reason(
        quote,
        require_mark_price=require_mark_price,
        contract_symbol=contract_symbol,
    )
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
