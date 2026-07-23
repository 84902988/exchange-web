from __future__ import annotations

import os
import logging
import requests
from dotenv import load_dotenv
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.services.moralis_chain_mapping import build_moralis_chain_mapping

load_dotenv()

logger = logging.getLogger(__name__)

MORALIS_API_KEY = os.getenv("MORALIS_API_KEY", "").strip()
MORALIS_STREAM_ID_AVAXC = os.getenv("MORALIS_STREAM_ID_AVAXC", "").strip()
MORALIS_STREAM_ID_BSC = os.getenv("MORALIS_STREAM_ID_BSC", "").strip()
MORALIS_STREAM_ID_POLYGON = os.getenv("MORALIS_STREAM_ID_POLYGON", "").strip()
MORALIS_STREAM_ID_ETH = (
    os.getenv("MORALIS_STREAM_ID_ETHEREUM", "").strip()
    or os.getenv("MORALIS_STREAM_ID_ETH", "").strip()
    or MORALIS_STREAM_ID_BSC
    or MORALIS_STREAM_ID_POLYGON
    or MORALIS_STREAM_ID_AVAXC
)
MORALIS_STREAM_ID_ARBITRUM = (
    os.getenv("MORALIS_STREAM_ID_ARBITRUM", "").strip()
    or MORALIS_STREAM_ID_ETH
)
MORALIS_STREAM_ID_OPTIMISM = (
    os.getenv("MORALIS_STREAM_ID_OPTIMISM", "").strip()
    or MORALIS_STREAM_ID_ETH
    or MORALIS_STREAM_ID_BSC
    or MORALIS_STREAM_ID_POLYGON
    or MORALIS_STREAM_ID_AVAXC
)

# 只从 env 取，不给默认值（避免误用旧 StreamId）
STREAM_ID_MAP = {
    "ETH": MORALIS_STREAM_ID_ETH,
    "ETHEREUM": MORALIS_STREAM_ID_ETH,
    "POLYGON": MORALIS_STREAM_ID_POLYGON,
    "BSC": MORALIS_STREAM_ID_BSC,
    "ARBITRUM": MORALIS_STREAM_ID_ARBITRUM,
    "OPTIMISM": MORALIS_STREAM_ID_OPTIMISM,
    "AVAXC": MORALIS_STREAM_ID_AVAXC,
    "AVALANCHE": MORALIS_STREAM_ID_AVAXC,
    "SOLANA": os.getenv("MORALIS_STREAM_ID_SOLANA", "").strip(),
}

BASE_URL = "https://api.moralis-streams.com/streams/evm"
SOLANA_BASE_URL = "https://api.moralis-streams.com/streams/solana"


def get_stream_id_for_network(network_code: str) -> str:
    nc = (network_code or "").strip().upper()
    return (STREAM_ID_MAP.get(nc) or "").strip()


def _has_column(db: Session, table: str, column: str) -> bool:
    try:
        row = db.execute(
            text(
                """
                SELECT 1 AS ok
                FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA = DATABASE()
                  AND TABLE_NAME = :table_name
                  AND COLUMN_NAME = :column_name
                LIMIT 1
                """
            ),
            {"table_name": table, "column_name": column},
        ).mappings().first()
        return bool(row)
    except Exception:
        db.rollback()
        return False


def _db_chain_stream_config(
    db: Session | None,
    *,
    chain_key: str | None = None,
    chain_id: int | None = None,
) -> dict[str, object] | None:
    if db is None or not _has_column(db, "chains", "moralis_stream_id"):
        return None

    where_sql = ""
    params: dict[str, object] = {}
    if chain_id is not None:
        where_sql = "id = :chain_id"
        params["chain_id"] = int(chain_id)
    elif chain_key:
        where_sql = "LOWER(chain_key) = :chain_key"
        params["chain_key"] = str(chain_key or "").strip().lower()
    else:
        return None

    moralis_enabled_expr = (
        "COALESCE(moralis_stream_enabled, 1) AS moralis_stream_enabled"
        if _has_column(db, "chains", "moralis_stream_enabled")
        else "1 AS moralis_stream_enabled"
    )
    watch_enabled_expr = (
        "COALESCE(watch_enabled, 1) AS watch_enabled"
        if _has_column(db, "chains", "watch_enabled")
        else "1 AS watch_enabled"
    )
    moralis_chain_id_expr = (
        "moralis_chain_id"
        if _has_column(db, "chains", "moralis_chain_id")
        else "NULL AS moralis_chain_id"
    )
    webhook_chain_key_expr = (
        "webhook_chain_key"
        if _has_column(db, "chains", "webhook_chain_key")
        else "NULL AS webhook_chain_key"
    )
    try:
        row = db.execute(
            text(
                f"""
                SELECT id, chain_key, chain_id, moralis_stream_id,
                       {moralis_enabled_expr},
                       {watch_enabled_expr},
                       {moralis_chain_id_expr},
                       {webhook_chain_key_expr}
                FROM chains
                WHERE {where_sql}
                LIMIT 1
                """
            ),
            params,
        ).mappings().first()
    except Exception:
        db.rollback()
        logger.warning("[moralis] failed to load stream config chain=%s chain_id=%s", chain_key, chain_id)
        return None

    if not row:
        return None
    enabled = bool(int(row.get("moralis_stream_enabled") or 0)) and bool(int(row.get("watch_enabled") or 0))
    mapping = build_moralis_chain_mapping(row)
    return {
        "chain_id": row.get("id"),
        "chain_key": str(row.get("chain_key") or "").strip().lower(),
        "stream_id": str(row.get("moralis_stream_id") or "").strip(),
        **mapping,
        "enabled": enabled,
        "source": "db",
    }


def get_stream_id_for_chain(
    db: Session | None,
    network_code: str,
    *,
    chain_key: str | None = None,
    chain_id: int | None = None,
) -> str:
    db_config = _db_chain_stream_config(db, chain_key=chain_key, chain_id=chain_id)
    if db_config is not None:
        if db_config.get("enabled") is False:
            return ""
        stream_id = str(db_config.get("stream_id") or "").strip()
        if stream_id:
            return stream_id
    return get_stream_id_for_network(network_code)


def _sync_chain_watch_status(
    db: Session | None,
    *,
    chain_key: str | None = None,
    chain_id: int | None = None,
    status: str,
    error: str | None = None,
) -> None:
    if db is None or not _has_column(db, "chains", "watch_status"):
        return
    where_sql = ""
    params: dict[str, object] = {
        "status": status[:32],
        "error": (error or "")[:255] if error else None,
    }
    if chain_id is not None:
        where_sql = "id = :chain_id"
        params["chain_id"] = int(chain_id)
    elif chain_key:
        where_sql = "LOWER(chain_key) = :chain_key"
        params["chain_key"] = str(chain_key or "").strip().lower()
    else:
        return

    set_clauses = ["watch_status = :status"]
    if _has_column(db, "chains", "watch_error"):
        set_clauses.append("watch_error = :error")
    if _has_column(db, "chains", "last_watch_check_at"):
        set_clauses.append("last_watch_check_at = UTC_TIMESTAMP()")
    try:
        db.execute(
            text(
                f"""
                UPDATE chains
                SET {", ".join(set_clauses)}
                WHERE {where_sql}
                LIMIT 1
                """
            ),
            params,
        )
        db.commit()
    except Exception:
        db.rollback()
        logger.warning("[moralis] failed to sync chain watch status chain=%s chain_id=%s", chain_key, chain_id)


def add_address_to_streams(
    network_code: str,
    address: str,
    *,
    db: Session | None = None,
    chain_key: str | None = None,
    chain_id: int | None = None,
) -> bool:
    """
    把地址加入 Moralis Stream
    返回值语义：
    - True  : 新增成功（201）或已存在（200）
    - False : 配置缺失或请求失败
    说明：
    - 失败不会抛异常（由调用方决定是否重试/补偿）
    - 仅在“异常/配置错误”时打印日志
    """
    nc = (network_code or "").strip().upper()
    addr = (address or "").strip()
    if nc != "SOLANA":
        addr = addr.lower()

    if not addr:
        logger.warning("moralis_address_empty network=%s", nc)
        _sync_chain_watch_status(db, chain_key=chain_key, chain_id=chain_id, status="FAIL", error="address empty")
        return False

    if not MORALIS_API_KEY:
        logger.warning("moralis_api_key_missing network=%s", nc)
        _sync_chain_watch_status(
            db,
            chain_key=chain_key,
            chain_id=chain_id,
            status="FAIL",
            error="MORALIS_API_KEY missing",
        )
        return False

    stream_id = get_stream_id_for_chain(db, nc, chain_key=chain_key, chain_id=chain_id)
    if not stream_id:
        logger.warning("[moralis] stream id missing for network=%s", nc)
        _sync_chain_watch_status(
            db,
            chain_key=chain_key,
            chain_id=chain_id,
            status="NOT_CONFIGURED",
            error=f"stream id missing for network={nc}",
        )
        return False

    # 基础合法性校验，防手滑
    if len(stream_id) != 36 or stream_id.count("-") != 4:
        logger.warning("[moralis] invalid stream_id format: network=%s stream_id=%s", nc, stream_id)
        _sync_chain_watch_status(
            db,
            chain_key=chain_key,
            chain_id=chain_id,
            status="FAIL",
            error=f"invalid stream_id format for network={nc}",
        )
        return False

    base_url = SOLANA_BASE_URL if nc == "SOLANA" else BASE_URL
    url = f"{base_url}/{stream_id}/address"
    headers = {
        "X-API-Key": MORALIS_API_KEY,
        "Content-Type": "application/json",
        "accept": "application/json",
    }
    body = {"address": [addr]}

    try:
        res = requests.post(url, headers=headers, json=body, timeout=20)

        # 201：新增成功
        if res.status_code == 201:
            _sync_chain_watch_status(db, chain_key=chain_key, chain_id=chain_id, status="PASS", error=None)
            return True

        # 200：已存在（幂等成功）
        if res.status_code == 200:
            _sync_chain_watch_status(db, chain_key=chain_key, chain_id=chain_id, status="PASS", error=None)
            return True

        # 其它状态才记录
        logger.warning(
            "[moralis] add address failed network=%s status=%s body=%s",
            nc,
            res.status_code,
            res.text[:300],
        )
        _sync_chain_watch_status(
            db,
            chain_key=chain_key,
            chain_id=chain_id,
            status="FAIL",
            error=f"moralis status={res.status_code}: {res.text[:180]}",
        )
        return False

    except Exception as e:
        logger.warning("[moralis] request exception: network=%s error=%r", nc, e)
        _sync_chain_watch_status(
            db,
            chain_key=chain_key,
            chain_id=chain_id,
            status="FAIL",
            error=repr(e),
        )
        return False
