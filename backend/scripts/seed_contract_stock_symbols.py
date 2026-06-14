from __future__ import annotations

import os
import sys
from decimal import Decimal
from typing import Optional


BACKEND_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

from app.db.models.contract_symbol import ContractSymbol  # noqa: E402
from app.db.models.trading_pair import TradingPair  # noqa: E402
from app.db.session import SessionLocal  # noqa: E402


def _normalize_stock_code(value: Optional[str]) -> str:
    normalized = str(value or "").strip().upper()
    if normalized.endswith("_PERP"):
        normalized = normalized[:-5]
    if normalized.endswith("USDT"):
        normalized = normalized[:-4]
    if normalized.endswith("ON"):
        normalized = normalized[:-2]
    return normalized


def _contract_symbol_for_stock(code: str) -> str:
    return f"{code}USDT_PERP"


def _apply_stock_contract(item: ContractSymbol, code: str) -> None:
    symbol = _contract_symbol_for_stock(code)
    item.symbol = symbol
    item.display_name = f"{code}USDT 永续"
    item.category = "STOCK"
    item.provider = "ITICK"
    item.provider_symbol = code
    item.quote_asset = "USDT"
    item.price_precision = 2
    item.quantity_precision = 6
    item.min_quantity = Decimal("0.001")
    item.max_quantity = Decimal("0")
    item.min_margin = Decimal("0")
    item.max_leverage = 100
    item.spread_x = Decimal("0")
    item.liquidation_threshold = Decimal("0")
    item.warning_threshold = Decimal("0")
    item.status = 1


def seed_contract_stock_symbols() -> None:
    db = SessionLocal()
    created = 0
    updated = 0
    skipped = 0

    try:
        pairs = (
            db.query(TradingPair)
            .filter(TradingPair.status == 1)
            .filter(TradingPair.asset_type == "STOCK")
            .filter(TradingPair.data_source == "ITICK")
            .order_by(TradingPair.sort_order.asc(), TradingPair.symbol.asc())
            .all()
        )
        for pair in pairs:
            base_symbol = getattr(pair.base_asset, "symbol", None) if pair.base_asset is not None else None
            code = _normalize_stock_code(pair.external_symbol or base_symbol or pair.symbol)
            if not code:
                skipped += 1
                continue

            symbol = _contract_symbol_for_stock(code)
            item = db.query(ContractSymbol).filter(ContractSymbol.symbol == symbol).first()
            if item is None:
                item = ContractSymbol(symbol=symbol)
                db.add(item)
                created += 1
            else:
                updated += 1

            _apply_stock_contract(item, code)
            print(f"seeded stock_contract symbol={symbol} provider_symbol={code}")

        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()

    print(f"done created={created} updated={updated} skipped={skipped}")


if __name__ == "__main__":
    seed_contract_stock_symbols()
