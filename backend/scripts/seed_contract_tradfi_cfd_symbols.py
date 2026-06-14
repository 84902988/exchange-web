from __future__ import annotations

import os
import sys
from decimal import Decimal
from typing import Dict, List


BACKEND_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

from app.db.models.contract_symbol import ContractSymbol  # noqa: E402
from app.db.session import SessionLocal  # noqa: E402


CONTRACTS: List[Dict[str, object]] = [
    {
        "symbol": "XAUUSDT_PERP",
        "display_name": "XAUUSDT 永续",
        "category": "GOLD",
        "provider": "ITICK",
        "provider_symbol": "XAUUSD",
        "quote_asset": "USDT",
        "price_precision": 2,
    },
    {
        "symbol": "XAGUSDT_PERP",
        "display_name": "XAGUSDT 永续",
        "category": "GOLD",
        "provider": "ITICK",
        "provider_symbol": "XAGUSD",
        "quote_asset": "USDT",
        "price_precision": 3,
    },
    {
        "symbol": "OILUSDT_PERP",
        "display_name": "OILUSDT 永续",
        "category": "FUTURES",
        "provider": "ITICK",
        "provider_symbol": "USOIL",
        "quote_asset": "USDT",
        "price_precision": 2,
    },
    {
        "symbol": "BRENTUSDT_PERP",
        "display_name": "BRENTUSDT 永续",
        "category": "FUTURES",
        "provider": "ITICK",
        "provider_symbol": "XBRUSD",
        "quote_asset": "USDT",
        "price_precision": 2,
    },
    {
        "symbol": "SPXUSDT_PERP",
        "display_name": "SPXUSDT 永续",
        "category": "INDEX",
        "provider": "ITICK",
        "provider_symbol": "SPX",
        "quote_asset": "USDT",
        "price_precision": 2,
    },
    {
        "symbol": "NAS100USDT_PERP",
        "display_name": "NAS100USDT 永续",
        "category": "INDEX",
        "provider": "ITICK",
        "provider_symbol": "NAS100",
        "quote_asset": "USDT",
        "price_precision": 2,
    },
    {
        "symbol": "DJIUSDT_PERP",
        "display_name": "DJIUSDT 永续",
        "category": "INDEX",
        "provider": "ITICK",
        "provider_symbol": "DJI",
        "quote_asset": "USDT",
        "price_precision": 2,
    },
    {
        "symbol": "EURUSD_PERP",
        "display_name": "EURUSD 永续",
        "category": "FOREX",
        "provider": "ITICK",
        "provider_symbol": "EURUSD",
        "quote_asset": "USD",
        "price_precision": 5,
    },
    {
        "symbol": "GBPUSD_PERP",
        "display_name": "GBPUSD 永续",
        "category": "FOREX",
        "provider": "ITICK",
        "provider_symbol": "GBPUSD",
        "quote_asset": "USD",
        "price_precision": 5,
    },
    {
        "symbol": "USDJPY_PERP",
        "display_name": "USDJPY 永续",
        "category": "FOREX",
        "provider": "ITICK",
        "provider_symbol": "USDJPY",
        "quote_asset": "JPY",
        "price_precision": 3,
    },
]


def _apply_contract(item: ContractSymbol, payload: Dict[str, object]) -> None:
    item.display_name = str(payload["display_name"])
    item.category = str(payload["category"])
    item.provider = str(payload["provider"])
    item.provider_symbol = str(payload["provider_symbol"])
    item.quote_asset = str(payload["quote_asset"])
    item.price_precision = int(payload["price_precision"])
    item.quantity_precision = 6
    item.min_quantity = Decimal("0.001")
    item.max_quantity = Decimal("0")
    item.min_margin = Decimal("0")
    item.max_leverage = 100
    item.spread_x = Decimal("0")
    item.liquidation_threshold = Decimal("0")
    item.warning_threshold = Decimal("0")
    item.status = 1


def seed_contract_tradfi_cfd_symbols() -> None:
    db = SessionLocal()
    created = 0
    updated = 0

    try:
        for payload in CONTRACTS:
            symbol = str(payload["symbol"])
            item = db.query(ContractSymbol).filter(ContractSymbol.symbol == symbol).first()
            if item is None:
                item = ContractSymbol(symbol=symbol)
                db.add(item)
                created += 1
            else:
                updated += 1

            _apply_contract(item, payload)
            print(f"seeded contract_symbol symbol={symbol} category={payload['category']} provider_symbol={payload['provider_symbol']}")

        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()

    print(f"done created={created} updated={updated}")


if __name__ == "__main__":
    seed_contract_tradfi_cfd_symbols()
