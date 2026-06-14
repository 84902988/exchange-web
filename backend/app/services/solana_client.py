from __future__ import annotations

import importlib.util
from dataclasses import dataclass
from decimal import Decimal
from typing import Any, Optional

from app.core.chain_config import get_chain_config
from app.services.solana_wallet import is_solana_address


SOLANA_SENDER_DEPENDENCY_ERROR = "solana sender dependency not configured"
SOLANA_CONFIRM_DEPENDENCY_ERROR = "solana confirm dependency not configured"


@dataclass(frozen=True)
class SolanaTxStatus:
    status: Optional[int]
    slot: Optional[int]
    raw: dict[str, Any]


def is_solana_sdk_available() -> bool:
    return importlib.util.find_spec("solders") is not None or importlib.util.find_spec("solana") is not None


def validate_solana_address(address: str) -> bool:
    return is_solana_address(address)


def get_solana_client(chain_key: str = "solana", rpc_url: Optional[str] = None):
    if (chain_key or "").strip().lower() != "solana":
        raise ValueError("get_solana_client only supports solana")
    if not is_solana_sdk_available():
        raise RuntimeError(SOLANA_SENDER_DEPENDENCY_ERROR)
    raise RuntimeError("solana client implementation not configured")


def get_solana_tx_info(
    tx_hash: str,
    *,
    chain_key: str = "solana",
    rpc_url: Optional[str] = None,
) -> Optional[SolanaTxStatus]:
    if (chain_key or "").strip().lower() != "solana":
        raise ValueError("get_solana_tx_info only supports solana")
    if not (tx_hash or "").strip():
        raise ValueError("tx_hash is required")
    if not is_solana_sdk_available():
        raise RuntimeError(SOLANA_CONFIRM_DEPENDENCY_ERROR)
    raise RuntimeError("solana tx confirmation implementation not configured")


def get_solana_transaction_status_with_rpc_fallback(
    rpc_urls: list[str],
    tx_hash: str,
) -> Optional[SolanaTxStatus]:
    if not (tx_hash or "").strip():
        raise ValueError("tx_hash is required")
    if not is_solana_sdk_available():
        raise RuntimeError(SOLANA_CONFIRM_DEPENDENCY_ERROR)
    last_error: Optional[Exception] = None
    for rpc_url in rpc_urls:
        try:
            return get_solana_tx_info(tx_hash, rpc_url=rpc_url)
        except RuntimeError as exc:
            last_error = exc
            continue
    if last_error is not None:
        raise RuntimeError(str(last_error)) from last_error
    return None


def get_solana_transaction_status(chain_key: str, tx_hash: str) -> Optional[SolanaTxStatus]:
    cfg = get_chain_config(chain_key)
    return get_solana_transaction_status_with_rpc_fallback(list(cfg.rpc_urls), tx_hash)


def get_sol_balance(owner_address: str, *, chain_key: str = "solana", rpc_url: Optional[str] = None) -> Decimal:
    if not validate_solana_address(owner_address):
        raise ValueError("invalid solana owner_address")
    if not is_solana_sdk_available():
        raise RuntimeError(SOLANA_SENDER_DEPENDENCY_ERROR)
    raise RuntimeError("solana balance implementation not configured")


def get_spl_token_balance(
    mint_address: str,
    owner_address: str,
    *,
    chain_key: str = "solana",
    token_decimals: int = 6,
    rpc_url: Optional[str] = None,
) -> Decimal:
    if not validate_solana_address(mint_address):
        raise ValueError("invalid solana mint_address")
    if not validate_solana_address(owner_address):
        raise ValueError("invalid solana owner_address")
    if not is_solana_sdk_available():
        raise RuntimeError(SOLANA_SENDER_DEPENDENCY_ERROR)
    raise RuntimeError("solana SPL token balance implementation not configured")


def send_spl_token_transfer(
    *,
    chain_key: str,
    from_private_key: str,
    from_address: str,
    to_address: str,
    token_mint_address: str,
    amount: Decimal,
    token_decimals: int,
    rpc_url: Optional[str] = None,
) -> str:
    if (chain_key or "").strip().lower() != "solana":
        raise ValueError("send_spl_token_transfer only supports solana")
    if not validate_solana_address(from_address):
        raise ValueError("invalid solana from_address")
    if not validate_solana_address(to_address):
        raise ValueError("invalid solana to_address")
    if not validate_solana_address(token_mint_address):
        raise ValueError("invalid solana token_mint_address")
    if not is_solana_sdk_available():
        raise RuntimeError(SOLANA_SENDER_DEPENDENCY_ERROR)
    raise RuntimeError("solana SPL token sender implementation not configured")


def send_sol_transfer(
    *,
    chain_key: str,
    from_private_key: str,
    from_address: str,
    to_address: str,
    amount: Decimal,
    rpc_url: Optional[str] = None,
) -> str:
    if (chain_key or "").strip().lower() != "solana":
        raise ValueError("send_sol_transfer only supports solana")
    if not validate_solana_address(from_address):
        raise ValueError("invalid solana from_address")
    if not validate_solana_address(to_address):
        raise ValueError("invalid solana to_address")
    if not is_solana_sdk_available():
        raise RuntimeError(SOLANA_SENDER_DEPENDENCY_ERROR)
    raise RuntimeError("solana SOL sender implementation not configured")
