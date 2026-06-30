from __future__ import annotations

import logging
import time
from typing import Any


logger = logging.getLogger(__name__)

CONTRACT_QUOTE_NOT_LIVE = "CONTRACT_QUOTE_NOT_LIVE"
QUOTE_FRESHNESS_LIVE = "LIVE"
QUOTE_SOURCE_LAST_GOOD_BBO = "LAST_GOOD_BBO"
CLOSED_MARKET_EXECUTION_DISABLED = "DISABLED"
CLOSED_MARKET_EXECUTION_LAST_GOOD_BBO = "LAST_GOOD_BBO"
_NON_EXECUTABLE_MARKET_STATUSES = {"CLOSED", "HOLIDAY", "SUSPENDED", "UNKNOWN"}
_CLOSED_MARKET_LAST_GOOD_BBO_STATUSES = {"CLOSED", "HOLIDAY"}
_UNSAFE_EXECUTABLE_SOURCE_TOKENS = ("FALLBACK", "LAST_VALID", "LAST_GOOD", "STALE", "INVALID", "CACHE_STALE")
_CRYPTO_OR_PERP_TOKENS = ("CRYPTO", "PERP", "SWAP")
_LAST_SKIP_LOG_AT: dict[str, float] = {}


class ContractQuoteNotLive(ValueError):
    code = CONTRACT_QUOTE_NOT_LIVE


def _normalized(value: Any) -> str:
    return str(value or "").strip().upper()


def _attr(source: Any, name: str) -> Any:
    if source is None:
        return None
    if isinstance(source, dict):
        return source.get(name)
    return getattr(source, name, None)


def _is_crypto_or_perp_contract(quote: dict[str, Any], contract_symbol: Any = None) -> bool:
    category = _normalized(_attr(contract_symbol, "category") or quote.get("category"))
    if category:
        return category in _CRYPTO_OR_PERP_TOKENS

    values = (_attr(contract_symbol, "provider_symbol"), quote.get("provider_symbol"), quote.get("symbol"))
    for value in values:
        normalized = _normalized(value)
        if any(token in normalized for token in _CRYPTO_OR_PERP_TOKENS):
            return True
    return False


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


def _has_mark_or_derivable_mid(quote: dict[str, Any]) -> bool:
    try:
        mark_value = float(quote.get("mark_price"))
    except Exception:
        mark_value = 0
    if mark_value > 0:
        return True
    return _valid_bbo(quote) is not None


def _allows_closed_market_last_good_bbo(quote: dict[str, Any], contract_symbol: Any = None) -> bool:
    # Product exception for tradfi CFD symbols explicitly configured by operations.
    # It does not make stale/fallback/last-valid quotes executable in normal error paths.
    market_status = _normalized(quote.get("market_status") if isinstance(quote, dict) else None)
    source = _normalized((quote.get("quote_source") or quote.get("source")) if isinstance(quote, dict) else None)
    quote_freshness = _normalized(quote.get("quote_freshness") if isinstance(quote, dict) else None)
    mode = _normalized(
        _attr(contract_symbol, "closed_market_execution_mode")
        or quote.get("closed_market_execution_mode")
        or CLOSED_MARKET_EXECUTION_DISABLED
    )
    return (
        mode == CLOSED_MARKET_EXECUTION_LAST_GOOD_BBO
        and market_status in _CLOSED_MARKET_LAST_GOOD_BBO_STATUSES
        and source == QUOTE_SOURCE_LAST_GOOD_BBO
        and quote_freshness == QUOTE_FRESHNESS_LIVE
        and _valid_bbo(quote) is not None
        and _has_mark_or_derivable_mid(quote)
        and not _is_crypto_or_perp_contract(quote, contract_symbol)
    )


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
    if _allows_closed_market_last_good_bbo(quote, contract_symbol):
        return None
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
