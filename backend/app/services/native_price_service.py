import logging
import os
from dataclasses import dataclass
from decimal import Decimal
from typing import Optional, Sequence

from app.services.binance_market_service import BinanceMarketServiceError, binance_market_service

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class NativeTokenPriceResult:
    price: Optional[Decimal]
    symbol: str
    pair: str = ""
    source: str = ""
    fallback_reason: str = ""


_PRICE_PAIRS: dict[str, tuple[str, ...]] = {
    "BTC": ("BTCUSDT",),
    "ETH": ("ETHUSDT",),
    "BNB": ("BNBUSDT",),
    "MATIC": ("MATICUSDT", "POLUSDT"),
    "POL": ("POLUSDT", "MATICUSDT"),
    "AVAX": ("AVAXUSDT",),
    "SOL": ("SOLUSDT",),
}

_ENV_PRICE_KEYS: dict[str, tuple[str, ...]] = {
    "BTC": ("PRICE_BTC",),
    "ETH": ("PRICE_ETH", "PRICE_ETHEREUM", "PRICE_ARBITRUM", "PRICE_OPTIMISM"),
    "BNB": ("PRICE_BNB", "PRICE_BSC"),
    "MATIC": ("PRICE_MATIC", "PRICE_POLYGON"),
    "POL": ("PRICE_POL", "PRICE_MATIC", "PRICE_POLYGON"),
    "AVAX": ("PRICE_AVAX", "PRICE_AVAXC"),
    "SOL": ("PRICE_SOL",),
}


def _positive_decimal(value: object) -> Optional[Decimal]:
    try:
        price = Decimal(str(value))
    except Exception:
        return None
    return price if price > 0 else None


def _env_price(symbol: str, keys: Sequence[str]) -> NativeTokenPriceResult:
    for key in keys:
        price = _positive_decimal(os.getenv(key, ""))
        if price is not None:
            return NativeTokenPriceResult(price=price, symbol=symbol, source=f"ENV:{key}")
    return NativeTokenPriceResult(price=None, symbol=symbol, source="ENV", fallback_reason="native price env not configured")


def get_native_token_usdt_price(native_symbol: str) -> NativeTokenPriceResult:
    symbol = (native_symbol or "").strip().upper()
    if not symbol:
        return NativeTokenPriceResult(price=None, symbol="", fallback_reason="native_symbol is empty")

    if symbol in {"USDT", "USDC", "USD"}:
        return NativeTokenPriceResult(price=Decimal("1"), symbol=symbol, pair=f"{symbol}USDT", source="STABLE")

    pairs = _PRICE_PAIRS.get(symbol, (f"{symbol}USDT",))
    last_error = ""
    for pair in pairs:
        try:
            ticker = binance_market_service.get_ticker(pair)
            price = _positive_decimal(getattr(ticker, "price", None))
            if price is not None:
                return NativeTokenPriceResult(price=price, symbol=symbol, pair=pair, source="BINANCE")
            last_error = f"{pair} ticker price is empty"
        except BinanceMarketServiceError as exc:
            last_error = str(exc) or exc.__class__.__name__
            logger.warning("[native-price] binance ticker failed pair=%s error=%s", pair, exc)
        except Exception as exc:
            last_error = str(exc) or exc.__class__.__name__
            logger.warning("[native-price] unexpected ticker failed pair=%s error=%s", pair, exc)

    env_result = _env_price(symbol, _ENV_PRICE_KEYS.get(symbol, (f"PRICE_{symbol}",)))
    if env_result.price is not None:
        return env_result

    reason = last_error or env_result.fallback_reason or "native price unavailable"
    return NativeTokenPriceResult(price=None, symbol=symbol, pair=pairs[0] if pairs else "", source="NONE", fallback_reason=reason)
