from decimal import Decimal
import logging
from typing import Optional, Dict, Any

from sqlalchemy.orm import Session
from sqlalchemy import text

from web3 import Web3

from app.core.chain_capabilities import READY, get_chain_runtime_status, is_chain_withdraw_supported
from app.core.chain_config import get_runtime_chain_config
from app.services.solana_client import SOLANA_SENDER_DEPENDENCY_ERROR
from app.services.solana_wallet import is_solana_address
from app.services.hotwallet import (
    HotWalletSender,
    ERC20_ABI_MIN,
    _mask_address,
    validate_hot_wallet_private_key_matches_chain,
)
from app.services.hot_wallet_key_service import HOT_WALLET_KEY_MISMATCH_MESSAGE

STATUS_VERIFYING = "VERIFYING"
STATUS_QUEUED = "QUEUED"
STATUS_FROZEN = "FROZEN"
STATUS_APPROVED = "APPROVED"
STATUS_PROCESSING = "PROCESSING"
STATUS_SENDING = "SENDING"
STATUS_SENT = "SENT"
STATUS_FAILED = "FAILED"

SENDABLE_STATUSES = (STATUS_FROZEN, STATUS_APPROVED, STATUS_PROCESSING)

logger = logging.getLogger(__name__)
WITHDRAW_BALANCE_ACCOUNT_KEY = "funding"
WITHDRAW_FEE_COIN = "USDT"


class WithdrawSendError(RuntimeError):
    def __init__(self, code: str, message: str, *, http_status: int = 400):
        super().__init__(message)
        self.code = code
        self.message = message
        self.http_status = http_status


def _chain_display(chain_key: str) -> str:
    labels = {
        "polygon": "Polygon",
        "bsc": "BSC",
        "ethereum": "Ethereum",
        "optimism": "Optimism",
        "avaxc": "Avalanche C-Chain",
        "solana": "Solana",
    }
    return labels.get((chain_key or "").strip().lower(), chain_key or "-")


def _get_asset_chain_meta(db: Session, coin_symbol: str, chain_key: str) -> Dict[str, Any]:
    row = db.execute(
        text(
            """
            SELECT
                a.enabled AS asset_enabled,
                c.enabled AS chain_enabled,
                ac.enabled AS asset_chain_enabled,
                ac.withdraw_enabled,
                ac.contract_address,
                ac.decimals
            FROM asset_chains ac
            JOIN assets a ON a.id = ac.asset_id
            JOIN chains c ON c.id = ac.chain_id
            WHERE a.symbol=:symbol AND c.chain_key=:chain_key
            LIMIT 1
            """
        ),
        {"symbol": coin_symbol, "chain_key": chain_key},
    ).mappings().first()

    if not row:
        raise WithdrawSendError(
            "ASSET_CHAIN_NOT_CONFIGURED",
            f"{coin_symbol} 在 {_chain_display(chain_key)} 网络未配置提现通道，无法链上发送。",
        )

    return {
        "asset_enabled": int(row.get("asset_enabled") or 0),
        "chain_enabled": int(row.get("chain_enabled") or 0),
        "asset_chain_enabled": int(row.get("asset_chain_enabled") or 0),
        "withdraw_enabled": int(row.get("withdraw_enabled") or 0),
        "contract_address": row.get("contract_address"),
        "decimals": int(row.get("decimals") or 18),
    }


def _get_chain_hot_wallet_config(db: Session, chain_key: str) -> Dict[str, Any]:
    cfg = get_runtime_chain_config(db, chain_key)
    return {
        "hot_wallet_address": cfg.hot_wallet_address,
        "rpc_url": cfg.rpc_url,
        "rpc_urls": list(cfg.rpc_urls),
    }



def _withdraw_log_reason_column(db: Session) -> Optional[str]:
    rows = db.execute(
        text(
            """
            SELECT COLUMN_NAME AS column_name
            FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME = 'withdraw_logs'
              AND COLUMN_NAME IN ('error_message', 'fail_reason', 'reason', 'remark')
            """
        )
    ).mappings().all()
    existing = {str(row.get("column_name") or "") for row in rows}
    for column in ("error_message", "fail_reason", "reason", "remark"):
        if column in existing:
            return column
    return None


def _store_send_failure_reason(
    db: Session,
    withdraw_id: int,
    code: str,
    message: str,
    *,
    stage: str = "PRECHECK",
) -> None:
    column = _withdraw_log_reason_column(db)
    if not column:
        return
    reason = f"{stage}:{code}:{message}"[:255]
    db.execute(
        text(
            f"""
            UPDATE withdraw_logs
            SET {column}=:reason
            WHERE id=:id
              AND (tx_hash IS NULL OR tx_hash = '')
            """
        ),
        {"id": int(withdraw_id), "reason": reason},
    )


def _mark_status(db: Session, withdraw_id: int, status: str, tx_hash: Optional[str] = None, reason: Optional[str] = None):
    db.execute(
        text(
            """
            UPDATE withdraw_logs
            SET status=:status,
                tx_hash=COALESCE(:tx_hash, tx_hash)
            WHERE id=:id
            """
        ),
        {"status": status, "tx_hash": tx_hash, "id": withdraw_id},
    )
    db.commit()


def _decimal_to_int(amount: Decimal, decimals: int) -> int:
    q = Decimal(10) ** decimals
    v = (amount * q).to_integral_value()
    return int(v)


def _format_units(v_int: int, decimals: int) -> str:
    return str(Decimal(v_int) / (Decimal(10) ** decimals))


def _check_erc20_balance(sender: HotWalletSender, token_contract: str, needed_int: int, token_decimals: int) -> Dict[str, Any]:
    w3 = sender.w3
    token = w3.to_checksum_address(token_contract)
    contract = w3.eth.contract(address=token, abi=ERC20_ABI_MIN)

    bal = contract.functions.balanceOf(sender.from_address).call()
    bal_int = int(bal)

    logger.debug(
        "withdraw_token_balance_checked from_address=%s token_contract=%s decimals=%s sufficient=%s",
        _mask_address(sender.from_address),
        _mask_address(token_contract),
        token_decimals,
        bal_int >= int(needed_int),
    )

    return {"balance_int": bal_int, "needed_int": int(needed_int), "ok": bal_int >= int(needed_int)}


def _check_token_decimals_match(
    sender: HotWalletSender,
    *,
    chain_key: str,
    coin_symbol: str,
    token_contract: str,
    db_decimals: int,
) -> Optional[tuple[str, str]]:
    token = sender.w3.to_checksum_address(token_contract)
    contract = sender.w3.eth.contract(address=token, abi=ERC20_ABI_MIN)
    chain_decimals = int(contract.functions.decimals().call())
    if int(db_decimals) == chain_decimals:
        return None
    return (
        "TOKEN_DECIMALS_MISMATCH",
        (
            f"chain={chain_key} asset={coin_symbol} contract_address={token_contract} "
            f"db_decimals={int(db_decimals)} chain_decimals={chain_decimals}"
        ),
    )


def _refund_withdraw_freeze_if_needed(db: Session, w: Dict[str, Any], reason: str = "") -> None:
    """
    Legacy helper: refund frozen withdraw amount back to available.
    Keep this path only for compatibility with old manual flows.
    """
    wid = int(w["id"])
    uid = int(w["user_id"])
    symbol = w["coin_symbol"]
    chain_key = (w["chain_key"] or "").lower()

    amount = Decimal(str(w.get("amount") or "0"))
    fee = Decimal(str(w.get("fee") or "0"))

    # 之前的冻结口径是 amount + fee，这里按这个退，同时用 min 防止多退。
    delta = amount + fee
    if delta <= 0:
        return

    biz_type = "WITHDRAW_REFUND"
    biz_id = f"withdraw:{wid}:refund"

    # 幂等：已经退过就跳过。
    ex = db.execute(
        text(
            """
            SELECT id FROM balance_logs
            WHERE biz_type=:biz_type AND biz_id=:biz_id
            LIMIT 1
            """
        ),
        {"biz_type": biz_type, "biz_id": biz_id},
    ).mappings().first()
    if ex:
        db.rollback()
        return

    # 锁余额行。
    bal = db.execute(
        text(
            """
            SELECT id, available, frozen
            FROM user_balances
            WHERE user_id=:uid AND coin_symbol=:sym AND chain_key=:ck
            FOR UPDATE
            """
        ),
        {"uid": uid, "sym": symbol, "ck": chain_key},
    ).mappings().first()

    if not bal:
        db.rollback()
        return

    before_av = Decimal(str(bal["available"]))
    before_fr = Decimal(str(bal["frozen"]))

    refundable = min(delta, before_fr)
    if refundable <= 0:
        db.rollback()
        return

    after_av = before_av + refundable
    after_fr = before_fr - refundable

    # 更新余额。
    db.execute(
        text(
            """
            UPDATE user_balances
            SET available=:after_av, frozen=:after_fr
            WHERE id=:id
            """
        ),
        {"after_av": str(after_av), "after_fr": str(after_fr), "id": bal["id"]},
    )

    # 记流水（frozen -> available）。
    db.execute(
        text(
            """
            INSERT INTO balance_logs
            (user_id, coin_symbol, chain_key, change_type, direction, change_amount,
             before_available, after_available, before_frozen, after_frozen,
             biz_type, biz_id)
            VALUES
            (:uid, :sym, :ck, :change_type, :direction, :amt,
             :b_av, :a_av, :b_fr, :a_fr,
             :biz_type, :biz_id)
            """
        ),
        {
            "uid": uid,
            "sym": symbol,
            "ck": chain_key,
            "change_type": "WITHDRAW_REFUND",
            "direction": 1,  # 可用增加
            "amt": str(refundable),
            "b_av": str(before_av),
            "a_av": str(after_av),
            "b_fr": str(before_fr),
            "a_fr": str(after_fr),
            "biz_type": biz_type,
            "biz_id": biz_id,
        },
    )

    db.commit()


def _fail_and_refund(db: Session, w: Dict[str, Any], err: str) -> Dict[str, Any]:
    """
    失败并退冻结（仅用于未成功广播、无 tx_hash 的失败场景）。
    """
    wid = int(w["id"])

    # 先把状态改成 FAILED，即使失败也继续退冻结。
    try:
        _mark_status(db, wid, STATUS_FAILED)
    except Exception:
        pass

    try:
        _refund_withdraw_freeze_if_needed(db, w, reason=err)
    except Exception:
        pass

    return {"ok": False, "status": STATUS_FAILED, "error": err}


def _fail_without_refund(db: Session, withdraw_id: int, err: str) -> Dict[str, Any]:
    _mark_status(db, int(withdraw_id), STATUS_FAILED)
    return {"ok": False, "status": STATUS_FAILED, "error": err}


def _keep_frozen(db: Session, withdraw_id: int, code: str, message: str, *, stage: str = "PRECHECK") -> Dict[str, Any]:
    _store_send_failure_reason(db, withdraw_id, code, message, stage=stage)
    db.execute(
        text(
            """
            UPDATE withdraw_logs
            SET status=:status
            WHERE id=:id
              AND status IN ('FROZEN', 'APPROVED', 'PROCESSING', 'SENDING')
              AND (tx_hash IS NULL OR tx_hash = '')
            """
        ),
        {"status": STATUS_FROZEN, "id": int(withdraw_id)},
    )
    db.commit()
    return {
        "ok": False,
        "status": STATUS_FROZEN,
        "code": code,
        "error": message,
        "message": message,
        "stage": stage,
    }


def _has_withdraw_balance_log(db: Session, withdraw_id: int, change_type: str) -> bool:
    row = db.execute(
        text(
            """
            SELECT id
            FROM balance_logs
            WHERE biz_type='WITHDRAW'
              AND biz_id=:biz_id
              AND change_type=:change_type
            LIMIT 1
            """
        ),
        {"biz_id": str(int(withdraw_id)), "change_type": change_type},
    ).mappings().first()
    return bool(row)


def _validate_withdraw_send_ledger(
    db: Session,
    *,
    withdraw_id: int,
    amount: Decimal,
    fee: Decimal,
    net_amount: Decimal,
) -> Optional[tuple[str, str]]:
    if net_amount <= 0:
        return "INVALID_NET_AMOUNT", "提现到账金额必须大于 0，已阻断链上发送。"
    if amount <= 0:
        return "INVALID_AMOUNT", "提现金额必须大于 0，已阻断链上发送。"
    if net_amount != amount:
        return (
            "WITHDRAW_AMOUNT_POLICY_MISMATCH",
            f"提现金额口径不一致：amount={amount} net_amount={net_amount}，已阻断链上发送。",
        )
    if not _has_withdraw_balance_log(db, withdraw_id, "WITHDRAW_FREEZE"):
        return "WITHDRAW_FREEZE_MISSING", "缺少提现本金冻结流水，已阻断链上发送。"
    if fee > 0 and not _has_withdraw_balance_log(db, withdraw_id, "WITHDRAW_FEE_FREEZE"):
        return "WITHDRAW_FEE_FREEZE_MISSING", "缺少提现手续费冻结流水，已阻断链上发送。"
    return None


def _ensure_send_config(db: Session, coin_symbol: str, chain_key: str, contract: str, decimals: int) -> None:
    chain_label = _chain_display(chain_key)
    if get_chain_runtime_status(chain_key) != READY or not is_chain_withdraw_supported(chain_key):
        raise WithdrawSendError(
            "CHAIN_NOT_READY",
            f"{chain_label} 网络当前未开启链上提现发送能力，无法继续提交。",
        )
    if not contract:
        raise WithdrawSendError(
            "CONTRACT_NOT_CONFIGURED",
            f"{coin_symbol} 在 {chain_label} 网络未配置提现合约地址，无法链上发送。",
        )
    if int(decimals) < 0:
        raise WithdrawSendError(
            "TOKEN_DECIMALS_INVALID",
            f"{coin_symbol} 在 {chain_label} 网络的精度配置无效，无法链上发送。",
        )


def _classify_sender_init_error(chain_key: str, exc: Exception) -> WithdrawSendError:
    message = str(exc)
    chain_label = _chain_display(chain_key)
    if "RPC not connected" in message:
        return WithdrawSendError(
            "RPC_UNAVAILABLE",
            f"{chain_label} RPC 不可用，无法链上发送，请联系平台处理。",
            http_status=503,
        )
    return WithdrawSendError("SENDER_INIT_FAILED", f"链上发送初始化失败：{message}", http_status=500)


def _classify_send_exception(exc: Exception) -> tuple[str, str]:
    raw = str(exc) or exc.__class__.__name__
    normalized = raw.lower()
    if "insufficient funds" in normalized or ("gas" in normalized and "insufficient" in normalized):
        return "HOT_WALLET_GAS_NOT_ENOUGH", "热钱包 Gas 不足，请联系平台处理。"
    if "rpc" in normalized or "connection" in normalized or "timeout" in normalized:
        return "RPC_UNAVAILABLE", "RPC 不可用，无法链上发送，请稍后重试或联系平台处理。"
    return "ERC20_SEND_FAILED", f"ERC20 发送失败：{raw}"


def _check_native_gas_balance(sender: HotWalletSender, token_contract: str, to_address: str, amount_int: int) -> None:
    try:
        native_balance = int(sender.w3.eth.get_balance(sender.from_address))
        token = sender.w3.to_checksum_address(token_contract)
        to = sender.w3.to_checksum_address(to_address)
        contract = sender.w3.eth.contract(address=token, abi=ERC20_ABI_MIN)
        gas_limit = int(
            contract.functions.transfer(to, int(amount_int)).estimate_gas(
                {"from": sender.from_address}
            )
        )
        gas_price = int(sender.w3.eth.gas_price)
        if native_balance < gas_limit * gas_price:
            raise WithdrawSendError(
                "HOT_WALLET_GAS_NOT_ENOUGH",
                "热钱包 Gas 不足，请联系平台处理。",
            )
    except WithdrawSendError:
        raise
    except Exception as exc:
        code, message = _classify_send_exception(exc)
        raise WithdrawSendError(code, message, http_status=503 if code == "RPC_UNAVAILABLE" else 400) from exc



def _send_solana_withdraw(
    db: Session,
    *,
    withdraw_id: int,
    withdraw_row: Dict[str, Any],
    contract: str,
    decimals: int,
    to_address: str,
) -> Dict[str, Any]:
    if not contract:
        return _keep_frozen(db, withdraw_id, "CONTRACT_NOT_CONFIGURED", "Solana 网络未配置提现 token mint，无法链上发送。")
    if not is_solana_address(contract):
        return _keep_frozen(db, withdraw_id, "CONTRACT_NOT_CONFIGURED", "Solana 提现 token mint 配置无效，无法链上发送。")
    if not is_solana_address(to_address):
        return _keep_frozen(db, withdraw_id, "INVALID_TO_ADDRESS", "收款地址格式无效，无法链上发送。")
    if int(decimals) < 0:
        return _keep_frozen(db, withdraw_id, "TOKEN_DECIMALS_INVALID", "Solana token 精度配置无效，无法链上发送。")

    chain_config = _get_chain_hot_wallet_config(db, "solana")
    hot_wallet_address = chain_config["hot_wallet_address"]
    if not hot_wallet_address:
        return _keep_frozen(db, withdraw_id, "HOT_WALLET_NOT_CONFIGURED", "Solana 热钱包未配置，请联系平台处理。")
    if not is_solana_address(hot_wallet_address):
        return _keep_frozen(db, withdraw_id, "HOT_WALLET_NOT_CONFIGURED", "Solana 热钱包地址配置无效，请联系平台处理。")

    return _keep_frozen(db, withdraw_id, "SOLANA_SENDER_UNAVAILABLE", SOLANA_SENDER_DEPENDENCY_ERROR)


def send_withdraw_once(
    db: Session,
    withdraw_id: int,
    hot_private_key: str,
) -> Dict[str, Any]:
    """
    单笔发送：适合先用 API 手动触发测试。
    - 允许 FROZEN 状态发送
    - ERC20 发送前检查热钱包 token 余额，避免 revert
    - 发送失败（余额不足/异常）时立即退冻结，避免用户资产卡住
    """
    w = db.execute(
        text(
            """
            SELECT id, user_id, coin_symbol, chain_key, to_address, amount, fee, net_amount, status, tx_hash
            FROM withdraw_logs
            WHERE id=:id
            FOR UPDATE
            """
        ),
        {"id": withdraw_id},
    ).mappings().first()

    if not w:
        db.rollback()
        raise ValueError("withdraw not found")

    if w.get("tx_hash"):
        db.commit()
        return {
            "ok": False,
            "tx_hash": w["tx_hash"],
            "status": w["status"],
            "code": "TX_HASH_EXISTS",
            "error": "tx_hash 已存在，不允许重复提交。",
            "message": "tx_hash 已存在，不允许重复提交。",
        }

    if w["status"] in (STATUS_SENDING, STATUS_SENT):
        db.commit()
        return {
            "ok": False,
            "status": w["status"],
            "code": "BAD_STATE",
            "error": f"当前状态 {w['status']} 不允许继续提交。",
            "message": f"当前状态 {w['status']} 不允许继续提交。",
        }

    if w["status"] not in SENDABLE_STATUSES:
        db.commit()
        return {
            "ok": False,
            "status": w["status"],
            "code": "BAD_STATE",
            "error": f"当前状态 {w['status']} 不允许继续提交。",
            "message": f"当前状态 {w['status']} 不允许继续提交。",
        }

    coin_symbol = w["coin_symbol"]
    chain_key = (w["chain_key"] or "").lower()
    to_address = w["to_address"]
    amount = Decimal(str(w["amount"]))
    fee = Decimal(str(w.get("fee") or "0"))
    net_amount = Decimal(str(w["net_amount"]))

    ledger_error = _validate_withdraw_send_ledger(
        db,
        withdraw_id=int(withdraw_id),
        amount=amount,
        fee=fee,
        net_amount=net_amount,
    )
    if ledger_error:
        code, message = ledger_error
        return _keep_frozen(db, withdraw_id, code, message, stage="PRECHECK")

    res_sending = db.execute(
        text(
            """
            UPDATE withdraw_logs
            SET status=:sending
            WHERE id=:id
              AND status IN ('FROZEN', 'APPROVED', 'PROCESSING')
              AND (tx_hash IS NULL OR tx_hash = '')
            """
        ),
        {"sending": STATUS_SENDING, "id": int(withdraw_id)},
    )
    if res_sending.rowcount != 1:
        db.commit()
        return {
            "ok": False,
            "status": w["status"],
            "code": "BAD_STATE",
            "error": "withdraw status changed before sending.",
            "message": "withdraw status changed before sending.",
        }

    db.commit()  # 释放行锁，避免发送交易时长时间锁表。

    meta = _get_asset_chain_meta(db, coin_symbol, chain_key)
    contract = (meta["contract_address"] or "").strip()
    decimals = int(meta["decimals"])

    if not meta["asset_enabled"]:
        return _keep_frozen(db, withdraw_id, "ASSET_DISABLED", f"{coin_symbol} 当前未启用，无法链上发送。")
    if not meta["chain_enabled"]:
        return _keep_frozen(db, withdraw_id, "CHAIN_DISABLED", f"{_chain_display(chain_key)} 网络当前未启用，无法链上发送。")
    if not meta["asset_chain_enabled"] or not meta["withdraw_enabled"]:
        return _keep_frozen(
            db,
            withdraw_id,
            "WITHDRAW_DISABLED",
            f"{coin_symbol} 在 {_chain_display(chain_key)} 网络未开启提现，无法链上发送。",
        )
    try:
        _ensure_send_config(db, coin_symbol, chain_key, contract, decimals)
    except WithdrawSendError as exc:
        return _keep_frozen(db, withdraw_id, exc.code, exc.message)

    chain_config = _get_chain_hot_wallet_config(db, chain_key)
    if not str(chain_config.get("hot_wallet_address") or "").strip():
        return _keep_frozen(db, withdraw_id, "HOT_WALLET_NOT_CONFIGURED", "热钱包未配置，请联系平台处理。")

    if chain_key == "solana":
        return _send_solana_withdraw(
            db,
            withdraw_id=withdraw_id,
            withdraw_row=dict(w),
            contract=contract,
            decimals=decimals,
            to_address=to_address,
        )

    try:
        validate_hot_wallet_private_key_matches_chain(db, chain_key, hot_private_key)
    except Exception as exc:
        logger.warning(
            "[withdraw-send] hot wallet private key mismatch withdraw_id=%s chain=%s error=%s",
            withdraw_id,
            chain_key,
            exc,
        )
        message = "热钱包私钥未配置或格式无效，请联系平台处理。"
        if "mismatch" in str(exc).lower() or "不匹配" in str(exc) or "不一致" in str(exc):
            message = HOT_WALLET_KEY_MISMATCH_MESSAGE
        return _keep_frozen(db, withdraw_id, "HOT_WALLET_PRIVATE_KEY_INVALID", message)

    try:
        sender = HotWalletSender(chain_key=chain_key, hot_private_key=hot_private_key, db=db)
    except Exception as exc:
        err = _classify_sender_init_error(chain_key, exc)
        logger.exception(
            "[withdraw-send] sender init failed withdraw_id=%s chain=%s code=%s",
            withdraw_id,
            chain_key,
            err.code,
        )
        return _keep_frozen(db, withdraw_id, err.code, err.message)

    if not Web3.is_address(to_address):
        return _keep_frozen(db, withdraw_id, "INVALID_TO_ADDRESS", "收款地址格式无效，无法链上发送。")
    if str(chain_config.get("hot_wallet_address") or "").strip() and not Web3.is_address(
        str(chain_config.get("hot_wallet_address"))
    ):
        return _keep_frozen(db, withdraw_id, "HOT_WALLET_NOT_CONFIGURED", "热钱包地址配置无效，请联系平台处理。")

    logger.debug(
        "withdraw_send_prepared coin=%s chain=%s to_address=%s token_contract=%s "
        "decimals=%s from_address=%s",
        coin_symbol,
        chain_key,
        _mask_address(to_address),
        _mask_address(contract) if contract else "(native)",
        decimals,
        _mask_address(sender.from_address),
    )

    try:
        if contract:
            decimals_error = _check_token_decimals_match(
                sender,
                chain_key=chain_key,
                coin_symbol=coin_symbol,
                token_contract=contract,
                db_decimals=decimals,
            )
            if decimals_error:
                code, message = decimals_error
                return _keep_frozen(db, withdraw_id, code, message, stage="PRECHECK")

            needed_int = _decimal_to_int(net_amount, decimals)

            chk = _check_erc20_balance(sender, contract, needed_int, token_decimals=decimals)
            if not chk["ok"]:
                bal_s = _format_units(chk["balance_int"], decimals)
                need_s = _format_units(chk["needed_int"], decimals)
                return _keep_frozen(
                    db,
                    withdraw_id,
                    "HOT_WALLET_TOKEN_NOT_ENOUGH",
                    f"热钱包 {coin_symbol} 余额不足，请联系平台处理。当前余额 {bal_s}，需要 {need_s}。",
                )

            try:
                _check_native_gas_balance(sender, contract, to_address, needed_int)
            except WithdrawSendError as err:
                return _keep_frozen(db, withdraw_id, err.code, err.message, stage="PRECHECK")

            tx_hash = sender.send_erc20(
                db=db,
                token_contract=contract,
                to_address=to_address,
                amount=net_amount,
                token_decimals=decimals,
            )
        else:
            tx_hash = sender.send_native(db=db, to_address=to_address, amount=net_amount)

        _mark_status(db, withdraw_id, STATUS_SENT, tx_hash=tx_hash)
        return {"ok": True, "tx_hash": tx_hash, "status": STATUS_SENT}

    except Exception as e:
        code, message = _classify_send_exception(e)
        logger.exception(
            "[withdraw-send] send failed withdraw_id=%s coin=%s chain=%s code=%s error=%s",
            withdraw_id,
            coin_symbol,
            chain_key,
            code,
            e,
        )
        return _keep_frozen(db, withdraw_id, code, message, stage="BROADCAST")
