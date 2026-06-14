from __future__ import annotations

import base64
import hashlib
import os
from datetime import datetime
from typing import Any, Optional

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from eth_account import Account
from sqlalchemy import inspect, text
from sqlalchemy.orm import Session


KEY_STATUS_CONFIGURED = "CONFIGURED"
KEY_STATUS_NOT_CONFIGURED = "NOT_CONFIGURED"
HOT_WALLET_KEY_MISMATCH_MESSAGE = "热钱包私钥与后台配置的热钱包地址不一致，请检查网络配置。"


def _normalize_chain_key(chain_key: Any) -> str:
    return str(chain_key or "").strip().lower()


def _chain_env_key(chain_key: str) -> str:
    return _normalize_chain_key(chain_key).upper().replace("-", "_")


def _short_address(address: str) -> str:
    value = str(address or "").strip()
    if len(value) <= 12:
        return value
    return f"{value[:6]}...{value[-4:]}"


def _has_column(db: Session, table_name: str, column_name: str) -> bool:
    try:
        return column_name in {column["name"] for column in inspect(db.get_bind()).get_columns(table_name)}
    except Exception:
        return False


def ensure_chain_hot_wallet_key_columns(db: Session) -> None:
    columns = {
        "hot_wallet_private_key_encrypted": "TEXT NULL",
        "hot_wallet_key_status": "VARCHAR(32) NULL",
        "hot_wallet_key_updated_at": "DATETIME NULL",
    }
    changed = False
    for column, ddl in columns.items():
        if _has_column(db, "chains", column):
            continue
        db.execute(text(f"ALTER TABLE chains ADD COLUMN {column} {ddl}"))
        changed = True
    if changed:
        db.commit()


def _wallet_aes_key() -> bytes:
    raw = os.getenv("WALLET_AES_KEY", "").strip()
    if not raw:
        raise ValueError("WALLET_AES_KEY 未配置，无法保存或读取热钱包私钥。")
    return hashlib.sha256(raw.encode("utf-8")).digest()


def encrypt_hot_wallet_private_key(private_key: str) -> str:
    key = _wallet_aes_key()
    nonce = os.urandom(12)
    cipher = AESGCM(key).encrypt(nonce, private_key.strip().encode("utf-8"), None)
    return "v1:" + base64.urlsafe_b64encode(nonce + cipher).decode("ascii")


def decrypt_hot_wallet_private_key(encrypted_value: str) -> str:
    value = str(encrypted_value or "").strip()
    if not value:
        return ""
    if not value.startswith("v1:"):
        raise ValueError("热钱包私钥密文版本不支持，请重新配置。")
    raw = base64.urlsafe_b64decode(value[3:].encode("ascii"))
    if len(raw) <= 12:
        raise ValueError("热钱包私钥密文格式无效，请重新配置。")
    nonce, cipher = raw[:12], raw[12:]
    return AESGCM(_wallet_aes_key()).decrypt(nonce, cipher, None).decode("utf-8").strip()


def derive_evm_address_from_private_key(private_key: str) -> str:
    try:
        return str(Account.from_key(str(private_key or "").strip()).address)
    except Exception as exc:
        raise ValueError("热钱包私钥格式无效。") from exc


def validate_hot_wallet_private_key_matches_address(private_key: str, expected_address: str) -> str:
    derived = derive_evm_address_from_private_key(private_key)
    expected = str(expected_address or "").strip()
    if expected and derived.lower() != expected.lower():
        raise ValueError(HOT_WALLET_KEY_MISMATCH_MESSAGE)
    return derived


def save_chain_hot_wallet_private_key(
    db: Session,
    *,
    chain_id: int,
    private_key: str,
    hot_wallet_address: str,
) -> str:
    normalized_private_key = str(private_key or "").strip()
    if not normalized_private_key:
        return ""
    derived_address = validate_hot_wallet_private_key_matches_address(normalized_private_key, hot_wallet_address)
    encrypted = encrypt_hot_wallet_private_key(normalized_private_key)
    ensure_chain_hot_wallet_key_columns(db)
    db.execute(
        text(
            """
            UPDATE chains
            SET hot_wallet_private_key_encrypted=:encrypted,
                hot_wallet_key_status=:status,
                hot_wallet_key_updated_at=UTC_TIMESTAMP(),
                updated_at=UTC_TIMESTAMP()
            WHERE id=:chain_id
            """
        ),
        {
            "chain_id": int(chain_id),
            "encrypted": encrypted,
            "status": KEY_STATUS_CONFIGURED,
        },
    )
    return derived_address


def get_chain_hot_wallet_private_key(db: Optional[Session], chain_key: str) -> str:
    ck = _normalize_chain_key(chain_key)
    if db is not None and _has_column(db, "chains", "hot_wallet_private_key_encrypted"):
        row = db.execute(
            text(
                """
                SELECT hot_wallet_private_key_encrypted
                FROM chains
                WHERE LOWER(chain_key)=:chain_key
                LIMIT 1
                """
            ),
            {"chain_key": ck},
        ).mappings().first()
        encrypted = str((row or {}).get("hot_wallet_private_key_encrypted") or "").strip()
        if encrypted:
            return decrypt_hot_wallet_private_key(encrypted)

    env_specific = f"HOT_WALLET_PRIVATE_KEY_{_chain_env_key(ck)}"
    return os.getenv(env_specific, "").strip() or os.getenv("HOT_WALLET_PRIVATE_KEY", "").strip()


def get_chain_hot_wallet_key_meta(row: dict[str, Any]) -> dict[str, Any]:
    encrypted = str(row.get("hot_wallet_private_key_encrypted") or "").strip()
    status = str(row.get("hot_wallet_key_status") or "").strip().upper()
    updated_at = row.get("hot_wallet_key_updated_at")
    configured = bool(encrypted)
    derived_address = ""
    read_error = ""

    if configured:
        try:
            derived_address = derive_evm_address_from_private_key(decrypt_hot_wallet_private_key(encrypted))
        except Exception as exc:
            read_error = str(exc)

    hot_wallet_address = str(row.get("hot_wallet_address") or "").strip()
    matches = bool(derived_address and hot_wallet_address and derived_address.lower() == hot_wallet_address.lower())
    mismatch = bool(derived_address and hot_wallet_address and not matches)

    return {
        "hot_wallet_key_configured": configured,
        "hot_wallet_key_status": status or (KEY_STATUS_CONFIGURED if configured else KEY_STATUS_NOT_CONFIGURED),
        "hot_wallet_key_status_label": "已配置" if configured else "未配置",
        "hot_wallet_key_status_badge": "ok" if configured and not mismatch and not read_error else ("danger" if mismatch or read_error else "warn"),
        "hot_wallet_key_updated_at": updated_at,
        "hot_wallet_key_updated_at_display": updated_at.strftime("%Y-%m-%d %H:%M:%S") if isinstance(updated_at, datetime) else (str(updated_at or "") or "-"),
        "hot_wallet_key_derived_address": derived_address,
        "hot_wallet_key_derived_address_display": _short_address(derived_address) if derived_address else "-",
        "hot_wallet_key_matches_address": matches,
        "hot_wallet_key_match_label": "一致" if matches else ("不一致" if mismatch else "-"),
        "hot_wallet_key_read_error": read_error,
    }
