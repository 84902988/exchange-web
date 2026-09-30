"""Public valuation-only USDT/USD rate; never substitutes a fixed peg."""
import math
import threading
import time

from app.services.itick_market_service import itick_market_service

MAX_AGE_SECONDS = 120
_lock = threading.Lock()
_cached = None
_cached_at = 0.0


def normalize_usdt_usd_quote(payload, now=None):
    now = time.time() if now is None else now
    unavailable = {"base": "USDT", "quote": "USD", "rate": None,
                   "as_of": None, "source": "ITICK", "stale": True}
    row = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(row, dict) or row.get("s") != "USDTUSD":
        return unavailable
    if payload.get("code", 0) not in (0, "0"):
        return unavailable
    try:
        if isinstance(row.get("ld"), bool) or isinstance(row.get("t"), bool):
            return unavailable
        price, timestamp = float(row["ld"]), float(row["t"])
        if timestamp > 10_000_000_000:
            timestamp /= 1000
        if not math.isfinite(price) or price <= 0 or not math.isfinite(timestamp):
            return unavailable
        if not -30 <= now - timestamp <= MAX_AGE_SECONDS:
            return unavailable
    except (KeyError, TypeError, ValueError, OverflowError):
        return unavailable
    return {**unavailable, "rate": price, "as_of": int(timestamp * 1000), "stale": False}


def get_usdt_usd_valuation_rate():
    global _cached, _cached_at
    with _lock:
        now = time.time()
        if _cached is not None and now - _cached_at < (5 if _cached["stale"] else 15):
            if _cached["stale"] or now * 1000 - _cached["as_of"] <= MAX_AGE_SECONDS * 1000:
                return dict(_cached)
        try:
            payload = itick_market_service.get_market_quote("crypto", "BT", "USDTUSD", timeout=5)
            result = normalize_usdt_usd_quote(payload)
        except Exception:
            result = normalize_usdt_usd_quote(None)
        _cached, _cached_at = result, time.time()
        return dict(result)
