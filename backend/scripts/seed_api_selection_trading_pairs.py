from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from decimal import Decimal
from typing import Iterable, List


BACKEND_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

from app.db.models.asset import Asset  # noqa: E402
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

MIN_BASE_AMOUNT = Decimal("0.000001")
MIN_QUOTE_AMOUNT = Decimal("1")
DEFAULT_MAKER_FEE_RATE = Decimal("0.00100000")
DEFAULT_TAKER_FEE_RATE = Decimal("0.00100000")


@dataclass(frozen=True)
class SelectionItem:
    external_symbol: str
    symbol: str
    base_asset: str
    quote_asset: str
    asset_type: str
    data_source: str
    external_region: str
    market_category: str
    display_group: str
    market_mode: str
    price_precision: int
    amount_precision: int
    sort_order: int
    is_hot: bool


def _normalize(value: str) -> str:
    return str(value or "").strip().upper()


def _selection_items() -> List[SelectionItem]:
    items: List[SelectionItem] = []

    def add_group(
        symbols: Iterable[str],
        *,
        asset_type: str,
        external_region: str,
        market_category: str,
        display_group: str,
        stock_symbol_format: bool = False,
    ) -> None:
        for index, raw_symbol in enumerate(symbols, start=1):
            external_symbol = _normalize(raw_symbol)
            if stock_symbol_format:
                base_asset = f"{external_symbol}ON"
                symbol = f"{external_symbol}ONUSDT"
                price_precision = 2
            else:
                base_asset = external_symbol
                symbol = f"{external_symbol}USDT"
                price_precision = 4

            items.append(
                SelectionItem(
                    external_symbol=external_symbol,
                    symbol=symbol,
                    base_asset=base_asset,
                    quote_asset="USDT",
                    asset_type=asset_type,
                    data_source="ITICK",
                    external_region=external_region,
                    market_category=market_category,
                    display_group=display_group,
                    market_mode="DEALER",
                    price_precision=price_precision,
                    amount_precision=6,
                    sort_order=index,
                    is_hot=external_symbol in HOT,
                )
            )

    add_group(
        STOCKS,
        asset_type="STOCK",
        external_region="US",
        market_category="STOCK",
        display_group="股票",
        stock_symbol_format=True,
    )
    add_group(
        INDICES,
        asset_type="INDEX",
        external_region="US",
        market_category="INDEX",
        display_group="指数",
    )
    add_group(
        FOREX,
        asset_type="FOREX",
        external_region="FOREX",
        market_category="FOREX",
        display_group="外汇",
    )
    add_group(
        METALS,
        asset_type="METAL",
        external_region="GLOBAL",
        market_category="METAL",
        display_group="贵金属",
    )
    add_group(
        COMMODITIES,
        asset_type="COMMODITY",
        external_region="GLOBAL",
        market_category="COMMODITY",
        display_group="大宗商品",
    )
    return items


def _get_or_create_asset(db, symbol: str, *, display_precision: int, sort_order: int) -> Asset:
    normalized_symbol = _normalize(symbol)
    asset = db.query(Asset).filter(Asset.symbol == normalized_symbol).first()
    if asset is not None:
        if int(asset.enabled or 0) != 1:
            asset.enabled = 1
            db.add(asset)
        return asset

    asset = Asset(
        symbol=normalized_symbol,
        name=normalized_symbol,
        asset_type="token",
        display_precision=display_precision,
        enabled=1,
        sort_order=sort_order,
    )
    db.add(asset)
    db.flush()
    return asset


def _apply_pair_config(pair: TradingPair, item: SelectionItem, base_asset: Asset, quote_asset: Asset) -> None:
    pair.base_asset_id = base_asset.id
    pair.quote_asset_id = quote_asset.id
    pair.asset_type = item.asset_type
    pair.data_source = item.data_source
    pair.external_symbol = item.external_symbol
    pair.external_region = item.external_region
    pair.market_category = item.market_category
    pair.display_group = item.display_group
    pair.sort_order = item.sort_order
    pair.is_hot = item.is_hot
    pair.market_mode = item.market_mode
    pair.status = 1
    pair.price_precision = item.price_precision
    pair.amount_precision = item.amount_precision
    pair.min_amount = MIN_BASE_AMOUNT
    pair.min_notional = MIN_QUOTE_AMOUNT


def seed_api_selection_trading_pairs() -> None:
    db = SessionLocal()
    created = 0
    updated = 0
    skipped = 0
    errors = 0

    try:
        quote_asset = _get_or_create_asset(db, "USDT", display_precision=6, sort_order=0)

        for item in _selection_items():
            try:
                base_asset = _get_or_create_asset(
                    db,
                    item.base_asset,
                    display_precision=item.amount_precision,
                    sort_order=item.sort_order,
                )

                existing_by_symbol = (
                    db.query(TradingPair)
                    .filter(TradingPair.symbol == item.symbol)
                    .first()
                )
                if existing_by_symbol is not None:
                    _apply_pair_config(existing_by_symbol, item, base_asset, quote_asset)
                    db.add(existing_by_symbol)
                    db.commit()
                    updated += 1
                    print(f"updated symbol={item.symbol} external_symbol={item.external_symbol}")
                    continue

                existing_by_assets = (
                    db.query(TradingPair)
                    .filter(
                        TradingPair.base_asset_id == base_asset.id,
                        TradingPair.quote_asset_id == quote_asset.id,
                    )
                    .first()
                )
                if existing_by_assets is not None:
                    db.commit()
                    skipped += 1
                    print(
                        "skipped "
                        f"symbol={item.symbol} reason=base_quote_exists "
                        f"existing_symbol={existing_by_assets.symbol}"
                    )
                    continue

                pair = TradingPair(
                    symbol=item.symbol,
                    base_asset_id=base_asset.id,
                    quote_asset_id=quote_asset.id,
                    maker_fee_rate=DEFAULT_MAKER_FEE_RATE,
                    taker_fee_rate=DEFAULT_TAKER_FEE_RATE,
                )
                _apply_pair_config(pair, item, base_asset, quote_asset)
                db.add(pair)
                db.flush()
                db.commit()
                created += 1
                print(f"created symbol={item.symbol} external_symbol={item.external_symbol}")
            except Exception as exc:
                errors += 1
                db.rollback()
                quote_asset = _get_or_create_asset(db, "USDT", display_precision=6, sort_order=0)
                print(f"error symbol={item.symbol} external_symbol={item.external_symbol} error={exc!r}")

        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()

    print(f"done created={created} updated={updated} skipped={skipped} errors={errors}")


if __name__ == "__main__":
    seed_api_selection_trading_pairs()
