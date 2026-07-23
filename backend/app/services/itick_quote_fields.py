"""Canonical iTick quote-field semantics shared by market consumers.

iTick uses ``ld`` for the latest traded/quoted price and ``p`` for the
previous close. Keeping these aliases in one module prevents spot, contract,
and market-list code paths from assigning different meanings to the same
provider payload.
"""

ITICK_LATEST_PRICE_FIELDS = (
    "ld",
    "last",
    "latest_price",
    "price",
    "close",
    "c",
)

ITICK_PREVIOUS_CLOSE_FIELDS = (
    "p",
    "previous_close",
    "previousClose",
    "prevClose",
    "preClose",
    "pc",
    "yc",
    "lastClose",
    "close_yesterday",
)

ITICK_OPEN_PRICE_FIELDS = (
    "o",
    "open",
    "open_price",
    "open_24h",
    "openPrice",
    "day_open",
    "dayOpen",
)
