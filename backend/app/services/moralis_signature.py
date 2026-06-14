from __future__ import annotations

import logging
import os
from typing import Optional

from eth_utils import keccak, to_hex


logger = logging.getLogger("moralis_signature")


def get_webhook_secret(stream_id: str = "") -> str:
    return os.getenv("MORALIS_WEBHOOK_SECRET", "").strip()


def compute_signature(body_str: str, secret: str) -> str:
    return to_hex(keccak(text=body_str + secret)).lower()


def verify_signature(
    *,
    raw_body: bytes,
    header_signature: Optional[str],
    stream_id: str = "",
) -> bool:
    sig = (header_signature or "").strip().lower()
    secret = get_webhook_secret(stream_id)

    if not sig or not secret:
        logger.warning(
            "[moralis_signature] missing signature or secret stream_id=%s has_signature=%s has_secret=%s",
            stream_id,
            bool(sig),
            bool(secret),
        )
        return False

    body_str = raw_body.decode("utf-8", errors="replace")
    computed = compute_signature(body_str, secret)
    sig_cmp = sig[2:] if sig.startswith("0x") else sig
    computed_cmp = computed[2:] if computed.startswith("0x") else computed
    result = sig_cmp == computed_cmp

    logger.warning(
        "[moralis_signature] verified stream_id=%s body_len=%s result=%s",
        stream_id,
        len(body_str),
        result,
    )
    return result
