# app/services/address_service.py
from __future__ import annotations

from typing import Optional, Tuple

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.services.evm_wallet import derive_evm_address
from app.services.solana_wallet import derive_solana_address, is_solana_address


# chain_key -> EVM offset
# Avalanche C-Chain 与 BSC/Polygon 同属 EVM 链，但 offset 独立，
# 避免不同链复用地址索引策略混乱；已有 BSC/Polygon offset 不可修改。
_EVM_OFFSET_BY_CHAIN_KEY = {
    "eth": 0,
    "ethereum": 0,
    "arbitrum": 0,
    "bsc": 1,
    "polygon": 2,
    "avaxc": 3,
    # Optimism uses its own EVM derivation slot so it does not reuse the
    # production BSC/Polygon/Avalanche address index strategy.
    "optimism": 4,
}


def get_or_create_deposit_address(
    db: Session,
    *,
    user_id: int,
    chain_key: str,
) -> Tuple[str, Optional[str]]:
    """
    返回 (address, memo)

    规则：
    - 地址唯一真相源：user_chain_addresses
    - 一用户一链一个地址
    - 不再使用 user_deposit_addresses
    """

    ck = (chain_key or "").strip().lower()
    if ck == ("tr" + "on"):
        raise ValueError("当前系统不支持 Tron 网络")
    if ck != "solana" and ck not in _EVM_OFFSET_BY_CHAIN_KEY:
        raise ValueError(f"Unsupported chain_key: {ck}")

    # 1️⃣ 找 chain_id
    chain_row = db.execute(
        text(
            """
            SELECT id
            FROM chains
            WHERE chain_key = :ck AND enabled = 1
            LIMIT 1
            """
        ),
        {"ck": ck},
    ).mappings().first()

    if not chain_row:
        raise ValueError(f"chain_key not found or disabled: {ck}")

    chain_id = int(chain_row["id"])

    # 2️⃣ 是否已存在地址
    exists = db.execute(
        text(
            """
            SELECT id, address, memo
            FROM user_chain_addresses
            WHERE user_id = :uid
              AND chain_id = :cid
              AND enabled = 1
            LIMIT 1
            """
        ),
        {"uid": user_id, "cid": chain_id},
    ).mappings().first()

    replace_existing_id: Optional[int] = None
    if exists:
        existing_address = str(exists["address"] or "").strip()
        if ck == "solana" and (existing_address.lower().startswith("0x") or not is_solana_address(existing_address)):
            replace_existing_id = int(exists["id"])
        else:
            return exists["address"], exists.get("memo")

    # 3️⃣ 不存在 → 生成地址（EVM 派生）
    if ck == "solana":
        address = derive_solana_address(account_index=user_id)
        stored_address = address
    else:
        offset = _EVM_OFFSET_BY_CHAIN_KEY[ck]
        address = derive_evm_address(
            account_index=user_id,
            chain_offset=offset,
        )
        stored_address = address.lower()

    # 4️⃣ 写入 user_chain_addresses（幂等靠唯一键兜底）
    if replace_existing_id is not None:
        db.execute(
            text(
                """
                UPDATE user_chain_addresses
                SET address = :addr,
                    memo = NULL,
                    enabled = 1,
                    updated_at = UTC_TIMESTAMP()
                WHERE id = :id
                """
            ),
            {"id": replace_existing_id, "addr": stored_address},
        )
    else:
        db.execute(
            text(
                """
                INSERT INTO user_chain_addresses
                  (user_id, chain_id, address, memo, enabled)
                VALUES
                  (:uid, :cid, :addr, NULL, 1)
                """
            ),
            {
                "uid": user_id,
                "cid": chain_id,
                "addr": stored_address,
            },
        )

    return stored_address, None
