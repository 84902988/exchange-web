from __future__ import annotations

import os
import sys


BACKEND_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

from app.db.models.trading_pair import TradingPair  # noqa: E402
from app.db.session import SessionLocal  # noqa: E402


def _normalize(value: object) -> str:
    return str(value or "").strip().upper()


def _resolve_stock_sub_category(pair: TradingPair) -> str:
    symbol = _normalize(pair.symbol)
    base_symbol = _normalize(getattr(getattr(pair, "base_asset", None), "symbol", ""))
    market_mode = _normalize(getattr(pair, "market_mode", None))

    if symbol.endswith("PERP") or symbol.endswith("_PERP") or market_mode == "CONTRACT":
        return "STOCK_CONTRACT"
    if symbol.endswith("ONUSDT") or base_symbol.endswith("ON"):
        return "STOCK_TOKEN"
    return "US_STOCK"


def seed_market_sub_categories() -> None:
    db = SessionLocal()
    updated = 0
    skipped = 0

    try:
        pairs = (
            db.query(TradingPair)
            .filter(TradingPair.asset_type == "STOCK", TradingPair.market_category == "STOCK")
            .order_by(TradingPair.id.asc())
            .all()
        )

        for pair in pairs:
            next_sub_category = _resolve_stock_sub_category(pair)
            if _normalize(getattr(pair, "market_sub_category", None)) == next_sub_category:
                skipped += 1
                continue

            pair.market_sub_category = next_sub_category
            db.add(pair)
            updated += 1
            print(f"updated symbol={pair.symbol} market_sub_category={next_sub_category}")

        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()

    print(f"done updated={updated} skipped={skipped}")


if __name__ == "__main__":
    seed_market_sub_categories()
