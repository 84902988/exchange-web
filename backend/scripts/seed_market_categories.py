from __future__ import annotations

import os
import sys
from typing import Dict, Iterable, List, Tuple

from sqlalchemy import or_


BACKEND_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

from app.db.models.trading_pair import TradingPair  # noqa: E402
from app.db.session import SessionLocal  # noqa: E402


STOCKS = [
    "NVDA", "MSFT", "AAPL", "AMZN", "GOOG", "GOOGL", "META", "AVGO", "TSLA", "BRK.B",
    "JPM", "LLY", "V", "NFLX", "XOM", "MA", "COST", "WMT", "PG", "JNJ", "HD", "ABBV",
    "BAC", "PLTR", "KO", "PM", "UNH", "GE", "CSCO", "IBM", "WFC", "CVX", "ABT", "CRM",
    "MCD", "MS", "AXP", "DIS", "LIN", "T", "MRK", "GS", "NOW", "RTX", "UBER", "PEP",
    "INTU", "BX", "VZ", "BKNG", "TMO", "ISRG", "AMD", "CAT", "SCHW", "QCOM", "TXN",
    "BLK", "SPGI", "BA", "ACN", "C", "AMGN", "BSX", "PGR", "SYK", "NEE", "AMAT",
    "PFE", "GILD", "HON", "PDD", "UNP", "TJX", "DHR", "ADBE", "COF", "DE", "LOW",
    "ETN", "MU", "PANW", "LRCX", "ANET", "KLAC", "APH", "ADP", "COP", "CRWD", "MDT",
    "VRTX", "ADI", "CB", "CMCSA", "LMT", "MO", "ICE", "SBUX", "SO", "BMY", "WELL",
    "PLD", "BON", "CREG",
]

INDICES = ["IXIC", "DJI", "SPX", "NAS100", "US30", "US2000", "FAANG", "DXY"]
FOREX = ["AUDUSD", "EURUSD", "GBPUSD", "NZDUSD", "USDCAD", "USDCHF", "USDJPY"]
METALS = ["XAUGBP", "XAGEUR", "XAGUSD", "XPTUSD", "XPDUSD", "XCUUSD"]
COMMODITIES = ["TIO", "ALUMINUM", "NICKEL", "LEAD", "ZINC", "XBRUSD", "XNGUSD", "USOIL"]
HOT = {"TSLA", "NVDA", "AAPL", "MSFT", "AMZN", "META", "GOOGL", "AMD", "BON", "CREG"}

CATEGORIES: List[Tuple[str, str, List[str]]] = [
    ("STOCK", "股票", STOCKS),
    ("INDEX", "指数", INDICES),
    ("FOREX", "外汇", FOREX),
    ("METAL", "贵金属", METALS),
    ("COMMODITY", "大宗商品", COMMODITIES),
]


def _normalize(value: str) -> str:
    return str(value or "").strip().upper()


def _build_lookup() -> Dict[str, Tuple[str, str, int, bool]]:
    lookup: Dict[str, Tuple[str, str, int, bool]] = {}
    for category, display_group, symbols in CATEGORIES:
        for index, symbol in enumerate(symbols, start=1):
            code = _normalize(symbol)
            lookup[code] = (category, display_group, index, code in HOT)
    return lookup


def _load_pairs(db, code: str) -> List[TradingPair]:
    normalized = _normalize(code)
    return list(
        db.query(TradingPair)
        .filter(
            or_(
                TradingPair.symbol == normalized,
                TradingPair.external_symbol == normalized,
            )
        )
        .order_by(TradingPair.id.asc())
        .all()
    )


def seed_market_categories() -> None:
    lookup = _build_lookup()
    db = SessionLocal()
    updated = 0
    skipped: List[str] = []

    try:
        for code, (category, display_group, sort_order, is_hot) in lookup.items():
            pairs = _load_pairs(db, code)
            if not pairs:
                skipped.append(code)
                continue

            for pair in pairs:
                pair.market_category = category
                pair.display_group = display_group
                pair.sort_order = sort_order
                pair.is_hot = is_hot
                db.add(pair)
                updated += 1
                print(
                    "updated "
                    f"code={code} symbol={pair.symbol} category={category} "
                    f"is_hot={int(is_hot)} sort_order={sort_order}"
                )

        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()

    print(f"done updated={updated} skipped={len(skipped)}")
    if skipped:
        print("skipped:", ", ".join(skipped))


if __name__ == "__main__":
    seed_market_categories()
