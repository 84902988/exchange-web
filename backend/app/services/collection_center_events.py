from __future__ import annotations

import json
import logging
from datetime import datetime
from typing import Any, Dict, Iterable

from app.core.rq import get_redis_connection


logger = logging.getLogger(__name__)

COLLECTION_CENTER_EVENT_STREAM = "collection:center:events"
COLLECTION_CENTER_EVENT_MAXLEN = 5000


def _json_safe(value: Any) -> Any:
    if isinstance(value, datetime):
        return value.isoformat(timespec="seconds")
    if isinstance(value, dict):
        return {str(key): _json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_json_safe(item) for item in value]
    return value


def publish_collection_center_event(event_type: str, payload: Dict[str, Any]) -> None:
    event_name = str(event_type or "").strip()
    if not event_name:
        return
    event_payload = {
        **(payload or {}),
        "event_type": event_name,
        "created_at": (payload or {}).get("created_at") or datetime.utcnow().isoformat(timespec="seconds") + "Z",
    }
    try:
        get_redis_connection().xadd(
            COLLECTION_CENTER_EVENT_STREAM,
            {
                "event_type": event_name,
                "payload": json.dumps(_json_safe(event_payload), ensure_ascii=False, sort_keys=True),
            },
            maxlen=COLLECTION_CENTER_EVENT_MAXLEN,
            approximate=True,
        )
    except Exception as exc:
        logger.warning("collection center event publish failed type=%s error=%s", event_name, exc)


def decode_collection_center_stream_entries(entries: Iterable[Any]) -> list[Dict[str, Any]]:
    events: list[Dict[str, Any]] = []
    for entry_id, fields in entries or []:
        try:
            normalized: dict[str, Any] = {}
            for key, value in (fields or {}).items():
                text_key = key.decode("utf-8") if isinstance(key, bytes) else str(key)
                text_value = value.decode("utf-8") if isinstance(value, bytes) else str(value)
                normalized[text_key] = text_value
            payload = json.loads(str(normalized.get("payload") or "{}"))
            if not isinstance(payload, dict):
                payload = {}
            payload.setdefault("event_type", normalized.get("event_type") or "")
            payload["_stream_id"] = entry_id.decode("utf-8") if isinstance(entry_id, bytes) else str(entry_id)
            events.append(payload)
        except Exception:
            continue
    return events


def collection_center_event_matches_filters(event: Dict[str, Any], filters: Dict[str, Any]) -> bool:
    chain_key = str(filters.get("chain_key") or "").strip().lower()
    if chain_key and str(event.get("chain_key") or "").strip().lower() != chain_key:
        return False
    asset_symbol = str(filters.get("asset_symbol") or filters.get("coin_symbol") or "").strip().upper()
    event_symbol = str(event.get("asset_symbol") or event.get("coin_symbol") or "").strip().upper()
    if asset_symbol and event_symbol and event_symbol != asset_symbol:
        return False
    user_id = str(filters.get("user_id") or "").strip()
    if user_id and str(event.get("user_id") or "").strip() != user_id:
        return False
    address_keyword = str(filters.get("address_keyword") or filters.get("address") or "").strip().lower()
    if address_keyword and address_keyword not in str(event.get("address") or "").strip().lower():
        return False
    return True
