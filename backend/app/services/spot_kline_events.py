from __future__ import annotations

from dataclasses import dataclass
from hashlib import sha256
from typing import Any, Mapping


KLINE_REVISION_SIGNATURE_FIELDS = (
    "open_time",
    "open",
    "high",
    "low",
    "close",
    "volume",
    "quote_volume",
    "is_closed",
    "close_state_source",
    "revision_epoch",
    "revision_seq",
)


def _normalize_symbol(value: Any) -> str:
    raw = str(value or "").strip().upper()
    return "".join(character for character in raw if character.isalnum())


def provider_kline_revision_signature(
    symbol: Any,
    interval: Any,
    kline: Mapping[str, Any],
) -> str:
    signature_payload = repr(
        (
            _normalize_symbol(symbol),
            str(interval or "").strip(),
            tuple(kline.get(key) for key in KLINE_REVISION_SIGNATURE_FIELDS),
        )
    )
    return sha256(signature_payload.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class ProviderKlineRevisionAccepted:
    provider: str
    symbol: str
    interval: str
    open_time: int
    revision_epoch: int
    revision_seq: int
    generation: int
    signature: str
    accepted_at_ms: int
    is_closed: bool | None

    @property
    def revision(self) -> tuple[int, int]:
        return self.revision_epoch, self.revision_seq


__all__ = [
    "KLINE_REVISION_SIGNATURE_FIELDS",
    "ProviderKlineRevisionAccepted",
    "provider_kline_revision_signature",
]
