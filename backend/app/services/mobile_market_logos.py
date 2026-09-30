"""Attach current operator logo metadata without refreshing cached quotes."""

from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models.asset import Asset
from app.db.models.contract_symbol import ContractSymbol
from app.db.models.trading_pair import TradingPair


def _symbol(value: Any) -> str:
    return str(value or "").strip().upper()


def _url(value: Any) -> str | None:
    return str(value or "").strip() or None


def enrich_mobile_market_logos(db: Session, payload: dict) -> dict:
    """Enrich all overview surfaces after cache retrieval, in at most 3 queries.

    Quotes and trading routes remain untouched. Logo edits/removal should not
    wait for the quote cache (including its last-good fallback) to expire.
    """
    cards = payload.get("overview_cards", [])
    sections = payload.get("sections", [])
    rows = [row for row in cards if isinstance(row, dict)]
    for section in sections:
        if isinstance(section, dict):
            rows.extend(row for row in section.get("items", []) if isinstance(row, dict))
    symbols = {_symbol(row.get("symbol")) for row in rows} - {""}
    if not symbols:
        return payload

    logos = {
        _symbol(row.symbol): {
            "spot_logo_url": _url(row.spot_logo_url),
            "base_asset_logo_url": _url(row.icon_url),
        }
        for row in db.execute(
            select(TradingPair.symbol, TradingPair.spot_logo_url, Asset.icon_url)
            .outerjoin(Asset, Asset.id == TradingPair.base_asset_id)
            .where(TradingPair.symbol.in_(symbols), TradingPair.status == 1)
        )
    }
    contract_symbols = {
        _symbol(row.get("trade_symbol"))
        for row in rows
        if str(row.get("trade_market") or "").lower() == "contract"
    } - {""}
    contract_bases = {}
    if contract_symbols:
        for row in db.execute(
            select(ContractSymbol.symbol, ContractSymbol.quote_asset).where(
                ContractSymbol.symbol.in_(contract_symbols), ContractSymbol.status == 1
            )
        ):
            symbol = _symbol(row.symbol)
            base = symbol.removesuffix("_PERP")
            quote = _symbol(row.quote_asset)
            if quote and base.endswith(quote) and len(base) > len(quote):
                base = base[:-len(quote)]
            contract_bases[symbol] = base
    asset_logos = {}
    if contract_bases:
        asset_logos = {
            _symbol(row.symbol): _url(row.icon_url)
            for row in db.execute(
                select(Asset.symbol, Asset.icon_url).where(
                    Asset.symbol.in_(set(contract_bases.values()))
                )
            )
        }

    def enrich(row: dict) -> dict:
        metadata = logos.get(_symbol(row.get("symbol")))
        if metadata is None:
            base = contract_bases.get(_symbol(row.get("trade_symbol")))
            metadata = {"spot_logo_url": None, "base_asset_logo_url": asset_logos.get(base)}
        return {**row, **metadata}

    return {
        **payload,
        "overview_cards": [enrich(row) for row in cards if isinstance(row, dict)],
        "sections": [
            {**section, "items": [enrich(row) for row in section.get("items", []) if isinstance(row, dict)]}
            for section in sections
            if isinstance(section, dict)
        ],
    }
