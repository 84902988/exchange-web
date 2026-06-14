from __future__ import annotations

import hmac
import importlib.util
import os
import struct

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ed25519
from mnemonic import Mnemonic


SOLANA_WALLET_DEPENDENCY_ERROR = "solana wallet dependency not configured"
_BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
_BASE58_INDEX = {char: index for index, char in enumerate(_BASE58_ALPHABET)}


def is_solana_wallet_dependency_available() -> bool:
    return (
        importlib.util.find_spec("cryptography") is not None
        and importlib.util.find_spec("mnemonic") is not None
    )


def _base58_encode(raw: bytes) -> str:
    if not raw:
        return ""
    number = int.from_bytes(raw, "big")
    encoded = ""
    while number:
        number, rem = divmod(number, 58)
        encoded = _BASE58_ALPHABET[rem] + encoded
    leading_zeroes = len(raw) - len(raw.lstrip(b"\x00"))
    return ("1" * leading_zeroes) + (encoded or "1")


def _base58_decode(value: str) -> bytes:
    raw = (value or "").strip()
    if not raw:
        raise ValueError("empty base58 value")

    number = 0
    for char in raw:
        index = _BASE58_INDEX.get(char)
        if index is None:
            raise ValueError("invalid base58 character")
        number = number * 58 + index

    payload = number.to_bytes((number.bit_length() + 7) // 8, "big") if number else b""
    leading_zeroes = len(raw) - len(raw.lstrip("1"))
    return (b"\x00" * leading_zeroes) + payload


def is_solana_address(address: str) -> bool:
    value = (address or "").strip()
    if not (32 <= len(value) <= 44):
        return False
    try:
        return len(_base58_decode(value)) == 32
    except Exception:
        return False


def _get_mnemonic() -> str:
    mnemonic = os.getenv("SOLANA_MNEMONIC", "").strip() or os.getenv("MNEMONIC", "").strip()
    if not mnemonic:
        raise RuntimeError("MNEMONIC not set in env")
    return mnemonic


def _hardened(index: int) -> int:
    return int(index) | 0x80000000


def _slip10_master_key(seed: bytes) -> tuple[bytes, bytes]:
    digest = hmac.new(b"ed25519 seed", seed, "sha512").digest()
    return digest[:32], digest[32:]


def _slip10_derive_child(key: bytes, chain_code: bytes, index: int) -> tuple[bytes, bytes]:
    data = b"\x00" + key + struct.pack(">L", _hardened(index))
    digest = hmac.new(chain_code, data, "sha512").digest()
    return digest[:32], digest[32:]


def _derive_solana_private_seed(account_index: int) -> bytes:
    mnemonic = _get_mnemonic()
    if not Mnemonic("english").check(mnemonic):
        raise RuntimeError("Invalid MNEMONIC")
    seed = Mnemonic.to_seed(mnemonic, passphrase=os.getenv("SOLANA_MNEMONIC_PASSPHRASE", ""))
    key, chain_code = _slip10_master_key(seed)
    # Solana standard account path: m/44'/501'/{account_index}'/0'
    for index in (44, 501, int(account_index), 0):
        key, chain_code = _slip10_derive_child(key, chain_code, index)
    return key


def derive_solana_address(*, account_index: int) -> str:
    if not is_solana_wallet_dependency_available():
        raise RuntimeError(SOLANA_WALLET_DEPENDENCY_ERROR)
    private_seed = _derive_solana_private_seed(account_index)
    public_key = (
        ed25519.Ed25519PrivateKey.from_private_bytes(private_seed)
        .public_key()
        .public_bytes(
            encoding=serialization.Encoding.Raw,
            format=serialization.PublicFormat.Raw,
        )
    )
    address = _base58_encode(public_key)
    if not is_solana_address(address) or address.lower().startswith("0x"):
        raise RuntimeError("solana address derivation produced invalid address")
    return address
