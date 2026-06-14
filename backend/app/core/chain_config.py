import os
import re
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Set, Tuple

from sqlalchemy import text


@dataclass(frozen=True)
class ChainConfig:
    chain_key: str
    chain_id: int
    rpc_urls: Tuple[str, ...]
    is_eip1559: bool
    confirmations: int
    native_symbol: str = ""
    explorer_tx_url: str = ""
    collection_address: str = ""
    hot_wallet_address: str = ""

    @property
    def rpc_url(self) -> str:
        return self.rpc_urls[0] if self.rpc_urls else ""


def _split_urls(value: Optional[str]) -> Tuple[str, ...]:
    seen: Set[str] = set()
    urls: List[str] = []
    for item in re.split(r"[\n\r,]+", value or ""):
        url = item.strip()
        if not url or url in seen:
            continue
        seen.add(url)
        urls.append(url)
    return tuple(urls)


def normalize_rpc_urls_text(value: Optional[str]) -> str:
    return "\n".join(_split_urls(value))


def _merge_urls(*groups: Tuple[str, ...]) -> Tuple[str, ...]:
    seen: Set[str] = set()
    urls: List[str] = []
    for group in groups:
        for url in group:
            if url in seen:
                continue
            seen.add(url)
            urls.append(url)
    return tuple(urls)


def _safe_int(value: Any, default: int) -> int:
    try:
        if value is None or value == "":
            return default
        return int(value)
    except Exception:
        return default


def _env_first(*names: str) -> str:
    for name in names:
        value = os.getenv(name, "").strip()
        if value:
            return value
    return ""


def _chain_env_key(chain_key: str) -> str:
    return (chain_key or "").strip().upper().replace("-", "_")


def _runtime_address_env(chain_key: str, kind: str) -> str:
    key = _chain_env_key(chain_key)
    if kind == "collection":
        return _env_first(
            f"COLLECTION_{key}_TARGET_ADDRESS",
            f"{key}_COLLECTION_ADDRESS",
            f"COLLECTION_{key}_ADDRESS",
            "COLLECTION_TARGET_ADDRESS",
        )
    if kind == "hot_wallet":
        return _env_first(
            f"{key}_HOT_WALLET_ADDRESS",
            f"HOT_WALLET_ADDRESS_{key}",
            "HOT_WALLET_ADDRESS",
        )
    return ""


POLYGON_DEFAULT_RPC_URLS = (
    "https://polygon-bor-rpc.publicnode.com",
    "https://polygon.drpc.org",
    "https://rpc.ankr.com/polygon",
    "https://polygon-rpc.com",
)

BSC_DEFAULT_RPC_URLS = (
    "https://bsc-dataseed.bnbchain.org",
    "https://bsc-dataseed.binance.org",
    "https://bsc-dataseed1.binance.org",
    "https://bsc.publicnode.com",
)

AVAXC_DEFAULT_RPC_URLS = (
    "https://api.avax.network/ext/bc/C/rpc",
    "https://avalanche-c-chain-rpc.publicnode.com",
    "https://rpc.ankr.com/avalanche",
)

ETHEREUM_DEFAULT_RPC_URLS = (
    "https://ethereum-rpc.publicnode.com",
    "https://eth.drpc.org",
    "https://rpc.ankr.com/eth",
)

OPTIMISM_DEFAULT_RPC_URLS = (
    "https://optimism-rpc.publicnode.com",
    "https://optimism.drpc.org",
    "https://rpc.ankr.com/optimism",
)

SOLANA_DEFAULT_RPC_URLS = (
    "https://api.mainnet-beta.solana.com",
    "https://solana-rpc.publicnode.com",
)


CHAIN_CONFIGS: Dict[str, ChainConfig] = {
    "bsc": ChainConfig(
        chain_key="bsc",
        chain_id=56,
        rpc_urls=_merge_urls(
            _split_urls(os.getenv("RPC_BSC")),
            _split_urls(os.getenv("BSC_RPC_URL")),
            _split_urls(os.getenv("BSC_RPC_URLS")),
            BSC_DEFAULT_RPC_URLS,
        ),
        is_eip1559=False,
        confirmations=1,
        native_symbol="BNB",
        explorer_tx_url="https://bscscan.com/tx/{tx_hash}",
    ),
    "polygon": ChainConfig(
        chain_key="polygon",
        chain_id=137,
        rpc_urls=_merge_urls(
            _split_urls(os.getenv("RPC_POLYGON")),
            _split_urls(os.getenv("POLYGON_RPC_URL")),
            _split_urls(os.getenv("POLYGON_RPC_URLS")),
            POLYGON_DEFAULT_RPC_URLS,
        ),
        is_eip1559=True,
        confirmations=1,
        native_symbol="MATIC",
        explorer_tx_url="https://polygonscan.com/tx/{tx_hash}",
    ),
    "avaxc": ChainConfig(
        chain_key="avaxc",
        chain_id=43114,
        rpc_urls=_merge_urls(
            _split_urls(os.getenv("RPC_AVAXC")),
            _split_urls(os.getenv("AVAXC_RPC_URLS")),
            _split_urls(os.getenv("AVAXC_RPC_URL")),
            AVAXC_DEFAULT_RPC_URLS,
        ),
        is_eip1559=True,
        confirmations=12,
        native_symbol="AVAX",
        explorer_tx_url="https://snowtrace.io/tx/{tx_hash}",
    ),
    "ethereum": ChainConfig(
        chain_key="ethereum",
        chain_id=1,
        rpc_urls=_merge_urls(
            _split_urls(os.getenv("RPC_ETHEREUM")),
            _split_urls(os.getenv("RPC_ETH")),
            _split_urls(os.getenv("ETHEREUM_RPC_URLS")),
            _split_urls(os.getenv("ETHEREUM_RPC_URL")),
            _split_urls(os.getenv("ETH_RPC_URLS")),
            _split_urls(os.getenv("ETH_RPC_URL")),
            ETHEREUM_DEFAULT_RPC_URLS,
        ),
        is_eip1559=True,
        confirmations=12,
        native_symbol="ETH",
        explorer_tx_url="https://etherscan.io/tx/{tx}",
    ),
    "optimism": ChainConfig(
        chain_key="optimism",
        chain_id=10,
        rpc_urls=_merge_urls(
            _split_urls(os.getenv("RPC_OPTIMISM")),
            _split_urls(os.getenv("RPC_OP")),
            _split_urls(os.getenv("OPTIMISM_RPC_URLS")),
            _split_urls(os.getenv("OPTIMISM_RPC_URL")),
            _split_urls(os.getenv("OP_RPC_URLS")),
            _split_urls(os.getenv("OP_RPC_URL")),
            OPTIMISM_DEFAULT_RPC_URLS,
        ),
        is_eip1559=True,
        confirmations=12,
        native_symbol="ETH",
        explorer_tx_url="https://optimistic.etherscan.io/tx/{tx}",
    ),
    "solana": ChainConfig(
        chain_key="solana",
        chain_id=101,
        rpc_urls=_merge_urls(
            _split_urls(os.getenv("SOLANA_RPC_URLS")),
            _split_urls(os.getenv("SOLANA_RPC_URL")),
            SOLANA_DEFAULT_RPC_URLS,
        ),
        is_eip1559=False,
        confirmations=32,
        native_symbol="SOL",
        explorer_tx_url="https://solscan.io/tx/{tx}",
    ),
}


def get_chain_config(chain_key: str) -> ChainConfig:
    ck = (chain_key or "").lower().strip()
    if ck not in CHAIN_CONFIGS:
        raise ValueError(f"Unsupported chain_key: {chain_key}")
    return CHAIN_CONFIGS[ck]


def get_runtime_chain_config_from_row(row: Any, chain_key: str) -> ChainConfig:
    ck = (chain_key or "").lower().strip()
    fallback = get_chain_config(ck)
    if row is None:
        return ChainConfig(
            chain_key=fallback.chain_key,
            chain_id=fallback.chain_id,
            rpc_urls=fallback.rpc_urls,
            is_eip1559=fallback.is_eip1559,
            confirmations=fallback.confirmations,
            native_symbol=fallback.native_symbol,
            explorer_tx_url=fallback.explorer_tx_url,
            collection_address=_runtime_address_env(ck, "collection"),
            hot_wallet_address=_runtime_address_env(ck, "hot_wallet"),
        )

    db_rpc_urls = _split_urls(str(row.get("rpc_url") or ""))
    return ChainConfig(
        chain_key=str(row.get("chain_key") or ck).strip().lower(),
        chain_id=_safe_int(row.get("chain_id"), fallback.chain_id),
        rpc_urls=_merge_urls(db_rpc_urls, fallback.rpc_urls),
        is_eip1559=fallback.is_eip1559,
        confirmations=_safe_int(row.get("confirmations"), fallback.confirmations),
        native_symbol=str(row.get("native_symbol") or "").strip() or fallback.native_symbol,
        explorer_tx_url=str(row.get("explorer_tx_url") or "").strip() or fallback.explorer_tx_url,
        collection_address=str(row.get("collection_address") or "").strip() or _runtime_address_env(ck, "collection"),
        hot_wallet_address=str(row.get("hot_wallet_address") or "").strip() or _runtime_address_env(ck, "hot_wallet"),
    )


def get_runtime_chain_config(db: Any, chain_key: str) -> ChainConfig:
    """
    Resolve runtime chain config with DB as the source of truth.

    Order:
    1. chains table fields
    2. environment-backed values already merged into get_chain_config()
    3. code defaults from chain_config.py
    """
    ck = (chain_key or "").lower().strip()
    row = None
    if db is not None:
        try:
            row = db.execute(
                text(
                    """
                    SELECT chain_key, chain_id, rpc_url, confirmations, native_symbol,
                           explorer_tx_url, collection_address, hot_wallet_address
                    FROM chains
                    WHERE LOWER(chain_key) = :chain_key
                    LIMIT 1
                    """
                ),
                {"chain_key": ck},
            ).mappings().first()
        except Exception:
            row = None

    if row is None:
        return get_runtime_chain_config_from_row(None, ck)
    return get_runtime_chain_config_from_row(row, ck)
