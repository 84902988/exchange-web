"""Opt-in, receipt-verified deposits of an EVM network's native currency."""
from __future__ import annotations

import re
from datetime import datetime
from decimal import Decimal, localcontext
from typing import Any

from sqlalchemy import text
from sqlalchemy.orm import Session
from web3.middleware import geth_poa_middleware

from app.core.chain_capabilities import EVM, get_chain_capability, is_chain_deposit_supported
from app.db.models.asset import Deposit
from app.services.collection_balance_checker import get_web3_for_chain
from app.services.deposit_status_service import mark_deposit_confirmed

# Native value and ERC20 log 0 may belong to the same transaction.
NATIVE_LOG_INDEX = -1
ADDRESS_RE = re.compile(r"0x[0-9a-f]{40}\Z")
HASH_RE = re.compile(r"0x[0-9a-f]{64}\Z")


def native_amount(raw: Any) -> Decimal:
    """Only integer wei; never use token decimals or formatted webhook amounts."""
    value = str(raw).strip()
    if not re.fullmatch(r"(?:0[xX][0-9a-fA-F]+|[0-9]+)", value) or len(value) > 80:
        raise ValueError("INVALID_NATIVE_VALUE")
    wei = int(value, 16 if value.lower().startswith("0x") else 10)
    if not 0 < wei < 10**36:
        raise ValueError("INVALID_NATIVE_VALUE")
    with localcontext() as ctx:
        ctx.prec = 50
        return Decimal(wei).scaleb(-18)


def native_configuration_errors(*, chain_key: str, symbol: str, native_symbol: str,
                                contract_address: Any, decimals: Any,
                                withdraw_enabled: bool = False,
                                collection_real_send_enabled: bool = False) -> list[str]:
    errors = []
    if get_chain_capability(chain_key).get("chain_family") != EVM or not is_chain_deposit_supported(chain_key):
        errors.append("当前网络不支持原生币充值。")
    if not native_symbol or str(symbol).strip().upper() != str(native_symbol).strip().upper():
        errors.append("原生币充值的币种必须与网络配置的主币一致。")
    if str(contract_address or "").strip():
        errors.append("原生币没有代币合约，请清空合约地址；包装币应关闭原生币充值选项。")
    if str(decimals).strip() != "18":
        errors.append("已接入 EVM 网络的原生币精度必须为 18。")
    if withdraw_enabled or collection_real_send_enabled:
        errors.append("原生币当前仅接入充值，请关闭提现和真实归集发送。")
    return errors


def extract_native_transfers(payload: dict) -> list[dict]:
    # Moralis EVM native transfers are top-level txs, not ERC20 Transfer logs.
    # Internal traces are deliberately excluded until they have their own identity.
    items = payload.get("txs")
    if not isinstance(items, list):
        return []
    result = []
    for tx in items:
        if not isinstance(tx, dict):
            continue
        try:
            native_amount(tx.get("value"))
        except ValueError:
            continue
        result.append(tx)
    return result


def load_native_asset(db: Session, chain_key: str, symbol: str | None = None):
    if get_chain_capability(chain_key).get("chain_family") != EVM or not is_chain_deposit_supported(chain_key):
        return None
    rows = db.execute(text("""
        SELECT a.id AS asset_id, a.symbol, ac.id AS asset_chain_id,
               ac.contract_address, ac.decimals, ac.min_deposit,
               c.id AS chain_id, c.chain_id AS evm_chain_id, c.native_symbol,
               COALESCE(ac.confirmations, c.confirmations, 1) AS confirm_required
        FROM asset_chains ac
        JOIN assets a ON a.id = ac.asset_id
        JOIN chains c ON c.id = ac.chain_id
        WHERE c.chain_key = :chain_key
          AND ac.native_deposit_enabled = 1
          AND NULLIF(TRIM(ac.contract_address), '') IS NULL
          AND UPPER(a.symbol) = UPPER(c.native_symbol)
          AND ac.decimals = 18
          AND ac.enabled = 1 AND ac.deposit_enabled = 1
          AND a.enabled = 1 AND c.enabled = 1
    """), {"chain_key": chain_key}).mappings().all()
    if len(rows) != 1 or (symbol and str(rows[0]["symbol"]).upper() != symbol.upper()):
        return None
    return dict(rows[0])


def internal_native_transfer(db: Session, chain_key: str, sender: str, txid: str) -> bool:
    # Sender checks cover the race between broadcasting a top-up and saving its hash.
    # Historical task hashes remain excluded after an operator changes wallets.
    return db.execute(text("""
        SELECT 1 FROM chains
        WHERE chain_key = :chain_key AND
          (LOWER(hot_wallet_address) = :sender OR LOWER(collection_address) = :sender)
        UNION ALL
        SELECT 1 FROM gas_tasks WHERE chain_key = :chain_key AND LOWER(tx_hash) = :txid
        UNION ALL
        SELECT 1 FROM collection_tasks WHERE chain_key = :chain_key AND LOWER(tx_hash) = :txid
        LIMIT 1
    """), {"chain_key": chain_key, "sender": sender, "txid": txid}).first() is not None


def register_native_deposit(db: Session, chain_key: str, tx: dict) -> Deposit | None:
    txid = str(tx.get("hash") or tx.get("transactionHash") or "").strip().lower()
    recipient = str(tx.get("toAddress") or tx.get("to") or "").strip().lower()
    sender = str(tx.get("fromAddress") or tx.get("from") or "").strip().lower()
    if not HASH_RE.fullmatch(txid) or not ADDRESS_RE.fullmatch(recipient) or not ADDRESS_RE.fullmatch(sender):
        return None
    amount = native_amount(tx.get("value"))
    asset = load_native_asset(db, chain_key)
    if not asset or amount < Decimal(str(asset["min_deposit"] or 0)):
        return None
    owner = db.execute(text("""
        SELECT user_id FROM user_chain_addresses
        WHERE chain_id = :chain_id AND LOWER(address) = :address AND enabled = 1
    """), {"chain_id": asset["chain_id"], "address": recipient}).mappings().all()
    if len(owner) != 1 or internal_native_transfer(db, chain_key, sender, txid):
        return None
    deposit = db.query(Deposit).filter_by(chain_key=chain_key, txid=txid, log_index=NATIVE_LOG_INDEX).first()
    if deposit is not None:
        # Never rewrite the owner or amount on replay. The worker verifies against RPC.
        return deposit
    deposit = Deposit(user_id=int(owner[0]["user_id"]), coin_symbol=asset["symbol"],
                      chain_key=chain_key, address=recipient, from_address=sender,
                      txid=txid, log_index=NATIVE_LOG_INDEX, amount=amount,
                      status="DETECTING", confirmations=0,
                      confirm_required=max(1, int(asset["confirm_required"] or 1)))
    db.add(deposit)
    db.flush()
    return deposit


def _field(obj: Any, key: str, default=None):
    return obj.get(key, default) if isinstance(obj, dict) else getattr(obj, key, default)


def _number(value: Any) -> int:
    return int(value, 16 if value.lower().startswith("0x") else 10) if isinstance(value, str) else int(value)


def _hex(value: Any) -> str:
    if isinstance(value, (bytes, bytearray)):
        return "0x" + bytes(value).hex()
    return str(value or "").lower()


def recheck_native_deposit(db: Session, deposit: Deposit):
    from app.services.deposit_tx_confirm_service import (
        DepositTxConfirmResult, _credit_confirmed_deposit, _deposit_balance_log_exists,
    )

    def result(status, message, error=None, **kwargs):
        return DepositTxConfirmResult(int(deposit.id), status, message,
                                      confirmations=int(deposit.confirmations or 0),
                                      confirm_required=int(deposit.confirm_required or 1),
                                      block_number=deposit.block_number, error_message=error, **kwargs)

    if _deposit_balance_log_exists(db, deposit):
        return result("ALREADY_CREDITED", "该充值已经入账", already_credited=True)
    if deposit.status not in {"DETECTING", "PENDING", "CONFIRMING"}:
        return result("SKIPPED", "当前状态不允许原生币补确认", "STATUS_NOT_RECHECKABLE")
    asset = load_native_asset(db, deposit.chain_key, deposit.coin_symbol)
    if not asset:
        return result("CONFIG_ERROR", "原生币充值未配置或已关闭", "NATIVE_DEPOSIT_DISABLED")
    owner = db.execute(text("""
        SELECT user_id FROM user_chain_addresses
        WHERE chain_id = :chain_id AND LOWER(address) = :address AND enabled = 1
    """), {"chain_id": asset["chain_id"], "address": deposit.address.lower()}).mappings().all()
    if len(owner) != 1 or int(owner[0]["user_id"]) != int(deposit.user_id):
        return result("MISMATCH", "充值地址归属不匹配", "ADDRESS_OWNER_MISMATCH")
    try:
        w3 = get_web3_for_chain(deposit.chain_key, db=db)
        # BSC/Polygon headers may exceed Ethereum's extraData size limit.
        # Apply only to this newly created confirmation client, not global RPC use.
        w3.middleware_onion.inject(geth_poa_middleware, layer=0)
        if int(w3.eth.chain_id) != int(asset["evm_chain_id"]):
            return result("CONFIG_ERROR", "RPC 网络与充值配置不一致", "RPC_CHAIN_MISMATCH")
        tx = w3.eth.get_transaction(deposit.txid)
        receipt = w3.eth.get_transaction_receipt(deposit.txid)
        if tx is None or receipt is None or _field(receipt, "blockNumber") is None:
            return result("PENDING", "等待链上交易确认", "TX_NOT_MINED")
        block_number = _number(_field(receipt, "blockNumber"))
        canonical_block = w3.eth.get_block(block_number)
        latest_block = int(w3.eth.block_number)
    except Exception:
        return result("PENDING", "链上查询暂不可用，将自动重试", "RPC_UNAVAILABLE")

    deposit.confirmations = max(0, latest_block - block_number + 1)
    deposit.confirm_required = max(1, int(asset["confirm_required"] or 1))
    deposit.block_number = block_number
    deposit.block_hash = _hex(_field(receipt, "blockHash"))
    deposit.updated_at = datetime.utcnow()
    try:
        sender = str(_field(tx, "from", "")).lower()
        matches = (
            _hex(_field(tx, "hash")) == deposit.txid.lower()
            and _hex(_field(receipt, "transactionHash")) == deposit.txid.lower()
            and str(_field(tx, "to", "")).lower() == deposit.address.lower()
            and sender == str(deposit.from_address or "").lower()
            and native_amount(_field(tx, "value")) == Decimal(str(deposit.amount))
        )
        receipt_status = _number(_field(receipt, "status", 0))
    except (ValueError, TypeError):
        matches = False
        receipt_status = 0
    if not matches:
        return result("MISMATCH", "原生转账或区块与充值记录不一致，未入账", "NATIVE_TRANSFER_MISMATCH")
    if (not deposit.block_hash
            or _field(tx, "blockNumber") is None
            or _number(_field(tx, "blockNumber")) != block_number
            or _hex(_field(tx, "blockHash")) != deposit.block_hash
            or _hex(_field(canonical_block, "hash")) != deposit.block_hash):
        return result("PENDING", "区块尚不一致，等待链上状态稳定后重试", "BLOCK_NOT_CANONICAL")
    if receipt_status != 1:
        deposit.status = "FAILED"
        return result("FAILED_ONCHAIN", "链上交易失败，未入账", "RECEIPT_FAILED")
    if internal_native_transfer(db, deposit.chain_key, sender, deposit.txid):
        deposit.status = "IGNORED"
        return result("SKIPPED", "平台内部转账不计为用户充值", "INTERNAL_TRANSFER")
    if Decimal(str(deposit.amount)) < Decimal(str(asset["min_deposit"] or 0)):
        return result("SKIPPED", "充值金额低于后台配置的最小充值金额", "BELOW_MINIMUM")
    if deposit.confirmations < deposit.confirm_required:
        deposit.status = "CONFIRMING"
        return result("PENDING", "确认数不足，将自动继续确认")

    now = datetime.utcnow()
    # Mark confirmed only after ledger credit succeeds; both commit atomically.
    with localcontext() as ctx:
        ctx.prec = 60
        credited, already_credited = _credit_confirmed_deposit(db, deposit, asset_meta=asset, now=now)
    # An unrelated unique-key error must never be mistaken for a successful credit.
    if not _deposit_balance_log_exists(db, deposit):
        raise RuntimeError("NATIVE_DEPOSIT_LEDGER_MISSING")
    mark_deposit_confirmed(deposit, confirmations=deposit.confirmations,
                           confirm_required=deposit.confirm_required, block_number=block_number,
                           block_hash=deposit.block_hash, confirmed_at=now)
    db.flush()
    return result("CONFIRMED", "原生币充值已确认入账", credited=credited, already_credited=already_credited)
