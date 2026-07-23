import logging
import time
from decimal import Decimal
from typing import Dict, Any, Optional
from urllib.parse import urlparse

from web3 import Web3
from web3.middleware import geth_poa_middleware
from eth_account import Account
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.core.chain_config import get_chain_config, get_runtime_chain_config
from app.services.hot_wallet_key_service import HOT_WALLET_KEY_MISMATCH_MESSAGE
from app.services.rpc_no_proxy import build_web3_no_proxy

logger = logging.getLogger(__name__)


# ✅ 保留导出：withdraw_sender.py 依赖它
ERC20_ABI_MIN = [
    {
        "name": "transfer",
        "type": "function",
        "stateMutability": "nonpayable",
        "inputs": [
            {"name": "_to", "type": "address"},
            {"name": "_value", "type": "uint256"},
        ],
        "outputs": [{"name": "", "type": "bool"}],
    },
    {
        "name": "decimals",
        "type": "function",
        "stateMutability": "view",
        "inputs": [],
        "outputs": [{"name": "", "type": "uint8"}],
    },
    {
        "name": "balanceOf",
        "type": "function",
        "stateMutability": "view",
        "inputs": [{"name": "owner", "type": "address"}],
        "outputs": [{"name": "", "type": "uint256"}],
    },
]


def _to_checksum(w3: Web3, addr: str) -> str:
    return w3.to_checksum_address(addr)


def _decimal_to_int(amount: Decimal, decimals: int) -> int:
    # 允许传 "0.005" 这种 Decimal，转成链上整数
    v = int(amount * (10 ** decimals))
    if v <= 0:
        raise ValueError("amount must be > 0")
    return v


def _mask_rpc_url(url: str) -> str:
    parsed = urlparse(url)
    if not parsed.scheme or not parsed.netloc:
        return "***"
    if parsed.path and parsed.path != "/":
        return f"{parsed.scheme}://{parsed.netloc}/***"
    return f"{parsed.scheme}://{parsed.netloc}"


def _mask_address(address: str) -> str:
    value = (address or "").strip()
    if len(value) <= 12:
        return value or "-"
    return f"{value[:6]}...{value[-4:]}"


def load_chain_hot_wallet_address(db: Session, chain_key: str) -> str:
    row = db.execute(
        text(
            """
            SELECT hot_wallet_address
            FROM chains
            WHERE chain_key = :chain_key
              AND enabled = 1
            LIMIT 1
            """
        ),
        {"chain_key": (chain_key or "").strip().lower()},
    ).mappings().first()
    if not row:
        return ""
    return str(row.get("hot_wallet_address") or "").strip()


def validate_hot_wallet_private_key_matches_chain(db: Session, chain_key: str, hot_private_key: str) -> str:
    configured_address = load_chain_hot_wallet_address(db, chain_key)
    derived_address = Account.from_key(hot_private_key).address

    if not configured_address:
        logger.warning(
            "[hotwallet] chain hot wallet address not configured, skip private key address check chain=%s derived=%s",
            (chain_key or "").strip().lower(),
            _mask_address(derived_address),
        )
        return derived_address

    if configured_address.strip().lower() != derived_address.strip().lower():
        logger.error(
            "[hotwallet] configured hot wallet mismatch chain=%s configured=%s derived=%s",
            (chain_key or "").strip().lower(),
            _mask_address(configured_address),
            _mask_address(derived_address),
        )
        raise ValueError(HOT_WALLET_KEY_MISMATCH_MESSAGE)

    logger.info(
        "[hotwallet] configured hot wallet verified chain=%s address=%s",
        (chain_key or "").strip().lower(),
        _mask_address(configured_address),
    )
    return derived_address


class HotWalletSender:
    """
    热钱包出币：串行 nonce，兼容 BSC POA
    """

    def __init__(self, chain_key: str, hot_private_key: str, db: Optional[Session] = None):
        cfg = get_runtime_chain_config(db, chain_key) if db is not None else get_chain_config(chain_key)
        self.cfg = cfg

        self.rpc_url = ""
        self.w3 = None

        tried: list[str] = []
        for rpc_url in cfg.rpc_urls:
            tried.append(_mask_rpc_url(rpc_url))
            w3 = build_web3_no_proxy(rpc_url, timeout=8)
            if w3.is_connected():
                self.w3 = w3
                self.rpc_url = rpc_url
                logger.info("[hotwallet] RPC connected chain=%s rpc=%s", chain_key, _mask_rpc_url(rpc_url))
                break
            logger.warning("[hotwallet] RPC connect failed chain=%s rpc=%s", chain_key, _mask_rpc_url(rpc_url))

        if self.w3 is None:
            raise RuntimeError(f"RPC not connected for chain {chain_key}, tried: {', '.join(tried)}")

        # ✅ BSC / POA 必须注入
        self.w3.middleware_onion.inject(geth_poa_middleware, layer=0)

        self.account = Account.from_key(hot_private_key)
        self.from_address = self.w3.to_checksum_address(self.account.address)

        logger.debug(
            "hotwallet_initialized chain_key=%s rpc_url=%s from_address=%s",
            chain_key,
            _mask_rpc_url(self.rpc_url),
            _mask_address(self.from_address),
        )

    # ---------- Nonce lock（你原来有 sender_nonce_locks 就保留）
    def _lock_sender_nonce(self, db: Session, wait_seconds: int = 10) -> int:
        # 如果你没有 sender_nonce_locks 表，可以先把这里简化掉
        db.execute(
            text(
                """
                INSERT IGNORE INTO sender_nonce_locks (address, updated_at)
                VALUES (:addr, NOW())
                """
            ),
            {"addr": self.from_address},
        )
        db.commit()

        t0 = time.time()
        while True:
            try:
                row = db.execute(
                    text("SELECT address FROM sender_nonce_locks WHERE address=:addr FOR UPDATE"),
                    {"addr": self.from_address},
                ).first()
                if row:
                    return int(self.w3.eth.get_transaction_count(self.from_address, "pending"))
            except Exception:
                db.rollback()
                raise

            if time.time() - t0 > wait_seconds:
                raise TimeoutError("nonce lock timeout")
            time.sleep(0.2)

    def _unlock_sender_nonce(self, db: Session) -> None:
        db.execute(
            text("UPDATE sender_nonce_locks SET updated_at=NOW() WHERE address=:addr"),
            {"addr": self.from_address},
        )
        db.commit()

    # ---------- Gas params（✅ 不再返回 gasPrice / maxFeePerGas）
    # 让节点自动 gas，更兼容不同 web3 版本
    def _tx_base(self, nonce: int) -> Dict[str, Any]:
        return {
            "chainId": int(self.cfg.chain_id),
            "nonce": int(nonce),
            "from": self.from_address,
        }

    # ---------- Send native
    def send_native(self, db: Session, to_address: str, amount: Decimal) -> str:
        to = _to_checksum(self.w3, to_address)
        value = int(self.w3.to_wei(amount, "ether"))

        nonce = self._lock_sender_nonce(db)
        try:
            tx: Dict[str, Any] = {
                **self._tx_base(nonce),
                "to": to,
                "value": value,
            }
            # ✅ 不传 gas/gasPrice，让节点自动处理
            signed = self.account.sign_transaction(tx)
            tx_hash = self.w3.eth.send_raw_transaction(signed.rawTransaction)
            return tx_hash.hex()
        finally:
            self._unlock_sender_nonce(db)

    # ---------- Send ERC20
    def send_erc20(
        self,
        db: Session,
        token_contract: str,
        to_address: str,
        amount: Decimal,
        token_decimals: int,
    ) -> str:
        token = _to_checksum(self.w3, token_contract)
        to = _to_checksum(self.w3, to_address)

        contract = self.w3.eth.contract(address=token, abi=ERC20_ABI_MIN)
        value_int = _decimal_to_int(amount, token_decimals)

        nonce = self._lock_sender_nonce(db)
        try:
            tx = contract.functions.transfer(to, value_int).build_transaction(
                self._tx_base(nonce)
            )
            # ✅ 不传 gasPrice；gas 也不强行设置
            signed = self.account.sign_transaction(tx)
            tx_hash = self.w3.eth.send_raw_transaction(signed.rawTransaction)
            return tx_hash.hex()
        finally:
            self._unlock_sender_nonce(db)
