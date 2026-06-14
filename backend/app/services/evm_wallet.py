from __future__ import annotations

import os

from eth_account import Account

Account.enable_unaudited_hdwallet_features()

_EVM_OFFSET_BY_CHAIN_KEY = {
    "eth": 0,
    "ethereum": 0,
    "arbitrum": 0,
    "bsc": 1,
    "polygon": 2,
    # Avalanche C-Chain is EVM-compatible, but keeps an independent offset
    # so new-chain addresses do not reuse the BSC/Polygon derivation slot.
    "avaxc": 3,
    # Optimism keeps a separate derivation slot for later chain-specific
    # rollout without reusing existing production EVM chain indexes.
    "optimism": 4,
}


def _get_mnemonic() -> str:
    mnemonic = os.getenv("MNEMONIC", "").strip()
    if not mnemonic:
        raise RuntimeError("MNEMONIC not set in env")
    return mnemonic


def _validate_mnemonic(mnemonic: str) -> None:
    try:
        Account.from_mnemonic(mnemonic, account_path="m/44'/60'/0'/0/0")
    except Exception as e:
        raise RuntimeError(f"Invalid MNEMONIC: {e}")


def _derive_evm_account(account_index: int, chain_offset: int = 0):
    mnemonic = _get_mnemonic()
    _validate_mnemonic(mnemonic)
    path = "m/44'/60'/{0}'/0/{1}".format(int(account_index), int(chain_offset))
    return Account.from_mnemonic(mnemonic, account_path=path)


def derive_evm_address(account_index: int, chain_offset: int = 0) -> str:
    acct = _derive_evm_account(account_index=account_index, chain_offset=chain_offset)
    return acct.address


def get_evm_chain_offset(chain_key: str) -> int:
    ck = (chain_key or "").strip().lower()
    if ck not in _EVM_OFFSET_BY_CHAIN_KEY:
        raise ValueError(f"Unsupported chain_key: {ck}")
    return _EVM_OFFSET_BY_CHAIN_KEY[ck]


def derive_evm_address_by_chain(user_id: int, chain_key: str) -> str:
    offset = get_evm_chain_offset(chain_key)
    return derive_evm_address(account_index=int(user_id), chain_offset=offset)


def derive_evm_private_key_by_chain(user_id: int, chain_key: str) -> str:
    offset = get_evm_chain_offset(chain_key)
    acct = _derive_evm_account(account_index=int(user_id), chain_offset=offset)
    return acct.key.hex()
