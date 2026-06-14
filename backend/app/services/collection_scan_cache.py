from __future__ import annotations

import hashlib
import json
import logging
import re
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Any, Dict, Iterable, Optional

from app.core.rq import get_redis_connection


logger = logging.getLogger(__name__)

SCAN_LOCK_TTL_SECONDS = 30 * 60
SCAN_STATUS_TTL_SECONDS = 2 * 60 * 60
SCAN_SNAPSHOT_TTL_SECONDS = 24 * 60 * 60


def _utc_now() -> datetime:
    return datetime.utcnow()


def _iso_now() -> str:
    return _utc_now().isoformat(timespec="seconds") + "Z"


def normalize_scan_chain_key(chain_key: Any) -> str:
    return str(chain_key or "").strip().lower()


def safe_scan_job_id_part(value: Any, *, fallback: str = "all") -> str:
    text = normalize_scan_chain_key(value)
    safe = re.sub(r"[^A-Za-z0-9_-]+", "_", text).strip("_")
    return safe or fallback


def normalize_scan_filters(filters: Optional[Dict[str, Any]]) -> Dict[str, str]:
    filters = filters or {}
    return {
        "coin_symbol": str(filters.get("coin_symbol") or filters.get("symbol") or "").strip().upper(),
        "min_amount": str(filters.get("min_amount") or "").strip(),
        "user_id": str(filters.get("user_id") or "").strip(),
        "address": str(filters.get("address") or "").strip(),
    }


def scan_scope_hash(filters: Optional[Dict[str, Any]]) -> str:
    payload = json.dumps(normalize_scan_filters(filters), ensure_ascii=False, sort_keys=True)
    return hashlib.sha1(payload.encode("utf-8")).hexdigest()[:16]


def scan_lock_key(chain_key: Any) -> str:
    return f"collection_center:scan:lock:{normalize_scan_chain_key(chain_key)}"


def scan_status_key(chain_key: Any) -> str:
    return f"collection_center:scan:status:{normalize_scan_chain_key(chain_key)}"


def scan_snapshot_key(chain_key: Any, filters: Optional[Dict[str, Any]]) -> str:
    return f"collection_center:scan:snapshot:{normalize_scan_chain_key(chain_key)}:{scan_scope_hash(filters)}"


def _json_safe(value: Any) -> Any:
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, datetime):
        return value.isoformat(timespec="seconds")
    if isinstance(value, dict):
        return {str(key): _json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_json_safe(item) for item in value]
    if hasattr(value, "__dict__"):
        return str(value)
    return value


def _first_snapshot_value(*values: Any) -> Any:
    for value in values:
        if value is None:
            continue
        if isinstance(value, str) and not value.strip():
            continue
        return value
    return ""


def _snapshot_scan_status(row: Dict[str, Any]) -> str:
    status = str(row.get("scan_status") or row.get("status") or "").strip().lower()
    if status in {"completed", "completed_with_errors", "success", "running", "queued", "failed", "timeout"}:
        return status
    if status in {"scanned", "read_ok"}:
        return "completed"
    if status in {"read_failed"}:
        return "failed"
    if str(row.get("balance_error") or "").strip():
        return "failed"
    scanned_at = str(_first_snapshot_value(row.get("scanned_at"), row.get("last_scan_at")) or "").strip()
    if scanned_at and scanned_at not in {"-", "未扫描", "待扫描"}:
        return "completed"
    return "none"


def _normalize_snapshot_row(row: Any) -> Any:
    if not isinstance(row, dict):
        return row
    data = dict(row)
    token_balance = _first_snapshot_value(
        data.get("token_balance"),
        data.get("token_balance_raw"),
        data.get("onchain_collectable_balance_label"),
        data.get("onchain_balance_label"),
        data.get("balance_amount_label"),
    )
    if token_balance != "":
        data.setdefault("token_balance", token_balance)
    collectable_amount = _first_snapshot_value(
        data.get("collectable_amount"),
        data.get("collectable_amount_raw"),
        data.get("collect_amount"),
        data.get("collect_amount_raw"),
    )
    if collectable_amount != "":
        data.setdefault("collectable_amount", collectable_amount)
    native_balance = _first_snapshot_value(data.get("native_balance"), data.get("native_balance_raw"))
    if native_balance != "":
        data.setdefault("native_balance", native_balance)
    required_gas = _first_snapshot_value(data.get("required_gas"), data.get("required_gas_raw"), data.get("estimated_gas_native"))
    if required_gas != "":
        data.setdefault("required_gas", required_gas)
    estimated_usd = _first_snapshot_value(
        data.get("estimated_usd"),
        data.get("usd_estimate_raw"),
        data.get("collectable_value_usd"),
        data.get("collect_usd_raw"),
        data.get("usd_estimate_label"),
        data.get("collect_usd_label"),
    )
    if estimated_usd != "":
        data.setdefault("estimated_usd", estimated_usd)
        data.setdefault("collectable_value_usd", estimated_usd)
    data.setdefault("estimated_usd_label", _first_snapshot_value(data.get("usd_estimate_label"), data.get("collect_usd_label")))
    data.setdefault("gas_status", _first_snapshot_value(data.get("gas_status"), data.get("gas_status_label")))
    data.setdefault("balance_status", _first_snapshot_value(data.get("balance_status"), data.get("scan_status")))
    data.setdefault("scanned_at", _first_snapshot_value(data.get("scanned_at"), data.get("last_scan_at")))
    data.setdefault("scan_status", _snapshot_scan_status(data))
    return data


def _snapshot_payload_with_scan_fields(payload: Dict[str, Any]) -> Dict[str, Any]:
    data = dict(payload)
    for key in ("items", "asset_items", "address_items", "network_items"):
        rows = data.get(key)
        if isinstance(rows, list):
            data[key] = [_normalize_snapshot_row(row) for row in rows]
    return data


def _decode_json(raw: Any) -> Dict[str, Any]:
    if not raw:
        return {}
    try:
        if isinstance(raw, bytes):
            raw = raw.decode("utf-8")
        payload = json.loads(str(raw))
        return payload if isinstance(payload, dict) else {}
    except Exception:
        return {}


def set_scan_status(chain_key: Any, payload: Dict[str, Any], *, ttl_seconds: int = SCAN_STATUS_TTL_SECONDS) -> None:
    chain = normalize_scan_chain_key(chain_key)
    if not chain:
        return
    data = {"chain_key": chain, "updated_at": _iso_now(), **payload}
    try:
        get_redis_connection().set(
            scan_status_key(chain),
            json.dumps(_json_safe(data), ensure_ascii=False, sort_keys=True),
            ex=max(1, int(ttl_seconds)),
        )
    except Exception as exc:
        logger.warning("collection center scan status write failed chain=%s error=%s", chain, exc)


def get_scan_status(chain_key: Any) -> Dict[str, Any]:
    chain = normalize_scan_chain_key(chain_key)
    if not chain:
        return {}
    try:
        payload = _decode_json(get_redis_connection().get(scan_status_key(chain)))
    except Exception as exc:
        logger.debug("collection center scan status read failed chain=%s error=%s", chain, exc)
        return {}
    status = str(payload.get("status") or "").lower()
    updated_at = str(payload.get("updated_at") or "")
    if status in {"queued", "running"} and updated_at:
        try:
            job_id = str(payload.get("job_id") or "").strip()
            if job_id:
                try:
                    from rq.job import Job

                    job = Job.fetch(job_id, connection=get_redis_connection())
                    job_status_raw = job.get_status(refresh=True)
                    job_status = str(getattr(job_status_raw, "value", job_status_raw) or "").lower()
                    if job_status == "finished":
                        payload["status"] = "completed"
                        payload["error"] = None
                        payload["finished_at"] = payload.get("finished_at") or _iso_now()
                        payload["stale_status_resolved"] = "finished"
                        return payload
                    if job_status and job_status not in {"queued", "started", "deferred", "scheduled"}:
                        payload["status"] = "failed"
                        payload["error"] = payload.get("error") or "STALE_SCAN_STATUS"
                        payload["finished_at"] = payload.get("finished_at") or _iso_now()
                        return payload
                except Exception as exc:
                    if exc.__class__.__name__ == "NoSuchJobError":
                        payload["status"] = "failed"
                        payload["error"] = payload.get("error") or "STALE_SCAN_STATUS"
                        payload["finished_at"] = payload.get("finished_at") or _iso_now()
                        return payload
            age = _utc_now() - datetime.fromisoformat(updated_at.replace("Z", ""))
            timeout_seconds = int(payload.get("job_timeout_seconds") or SCAN_LOCK_TTL_SECONDS)
            if age > timedelta(seconds=max(1, timeout_seconds) + 30):
                payload["status"] = "failed"
                payload["error"] = payload.get("error") or "SCAN_TIMEOUT"
                payload["finished_at"] = payload.get("finished_at") or _iso_now()
        except Exception:
            pass
    return payload


def get_scan_statuses(chain_keys: Iterable[Any]) -> Dict[str, Dict[str, Any]]:
    return {chain: get_scan_status(chain) for chain in {normalize_scan_chain_key(item) for item in chain_keys} if chain}


def scan_status_label(status: Optional[Dict[str, Any]]) -> str:
    value = str((status or {}).get("status") or "").lower()
    if value == "queued":
        return "扫描排队中"
    if value == "running":
        return "扫描中"
    if value == "completed":
        return "扫描完成"
    if value in {"failed", "timeout"}:
        return "扫描失败"
    return "未扫描"


def scan_status_running(status: Optional[Dict[str, Any]]) -> bool:
    return str((status or {}).get("status") or "").lower() in {"queued", "running"}


def save_scan_snapshot(
    chain_key: Any,
    filters: Optional[Dict[str, Any]],
    payload: Dict[str, Any],
    *,
    metadata: Optional[Dict[str, Any]] = None,
) -> None:
    chain = normalize_scan_chain_key(chain_key)
    if not chain:
        return
    payload_for_snapshot = _snapshot_payload_with_scan_fields(payload)
    summary = payload_for_snapshot.get("summary") or {}
    rows = payload_for_snapshot.get("items") or payload_for_snapshot.get("asset_items") or []
    balance_error_count = sum(1 for item in rows if isinstance(item, dict) and item.get("balance_error"))
    data = {
        **{key: value for key, value in payload_for_snapshot.items() if key != "scan"},
        "scan": None,
        "snapshot_chain_key": chain,
        "snapshot_scope": normalize_scan_filters(filters),
        "snapshot_saved_at": _iso_now(),
        "scan_meta": {
            "chain_key": chain,
            "status": "completed",
            "scanned_address_count": int(summary.get("total_addresses") or 0),
            "collectable_address_count": int(summary.get("collectible_count") or 0),
            "gas_needed_count": int(summary.get("gas_required_count") or 0),
            "balance_error_count": balance_error_count,
            **(metadata or {}),
        },
    }
    try:
        get_redis_connection().set(
            scan_snapshot_key(chain, filters),
            json.dumps(_json_safe(data), ensure_ascii=False, sort_keys=True),
            ex=SCAN_SNAPSHOT_TTL_SECONDS,
        )
    except Exception as exc:
        logger.warning("collection center scan snapshot write failed chain=%s error=%s", chain, exc)


def load_scan_snapshot(chain_key: Any, filters: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    chain = normalize_scan_chain_key(chain_key)
    if not chain:
        return {}
    try:
        return _decode_json(get_redis_connection().get(scan_snapshot_key(chain, filters)))
    except Exception as exc:
        logger.debug("collection center scan snapshot read failed chain=%s error=%s", chain, exc)
        return {}
