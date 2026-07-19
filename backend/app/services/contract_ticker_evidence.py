from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Any, Optional


@dataclass(frozen=True)
class ContractTicker24hEvidence:
    open_24h: Optional[Decimal]
    price_change_24h: Optional[Decimal]
    price_change_percent_24h: Optional[Decimal]


def _finite_decimal(value: Any) -> Optional[Decimal]:
    if value in (None, "") or isinstance(value, bool):
        return None
    try:
        parsed = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        return None
    return parsed if parsed.is_finite() else None


def resolve_contract_ticker_24h_evidence(
    *,
    last_price: Any,
    open_24h: Any = None,
    price_change_24h: Any = None,
    price_change_percent_24h: Any = None,
) -> ContractTicker24hEvidence:
    """Return one internally consistent 24h change evidence set.

    A valid rolling/session open together with the current provider last price is
    stronger than independently rounded change fields, so both derived values
    are produced from that same pair. When a provider does not expose an open,
    truthful native change fields are preserved independently and missing values
    remain unavailable.
    """

    last = _finite_decimal(last_price)
    open_price = _finite_decimal(open_24h)
    native_change = _finite_decimal(price_change_24h)
    native_percent = _finite_decimal(price_change_percent_24h)

    if last is not None and last > 0 and open_price is not None and open_price > 0:
        change = last - open_price
        return ContractTicker24hEvidence(
            open_24h=open_price,
            price_change_24h=change,
            price_change_percent_24h=(change / open_price) * Decimal("100"),
        )

    return ContractTicker24hEvidence(
        open_24h=open_price if open_price is not None and open_price > 0 else None,
        price_change_24h=native_change,
        price_change_percent_24h=native_percent,
    )
