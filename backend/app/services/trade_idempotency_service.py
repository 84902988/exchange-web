from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from enum import Enum
from hashlib import sha256
import json
import re
from typing import Any, Mapping, Optional

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.db.models.trade_idempotency_request import TradeIdempotencyRequest
from app.db.models.user import User


FINGERPRINT_VERSION = 1
CLIENT_ORDER_ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9._:-]{0,63}$")


class TradeIdempotencyError(RuntimeError):
    code = "TRADE_IDEMPOTENCY_ERROR"


class TradeIdempotencyConflict(TradeIdempotencyError):
    code = "IDEMPOTENCY_KEY_REUSED"


class TradeIdempotencyUnavailable(TradeIdempotencyError):
    code = "IDEMPOTENCY_RESULT_UNAVAILABLE"


@dataclass(frozen=True)
class TradeIdempotencyClaim:
    client_order_id: str
    record: Optional[TradeIdempotencyRequest]
    replay_payload: Optional[dict[str, Any]]

    @property
    def is_replay(self) -> bool:
        return self.replay_payload is not None


@dataclass(frozen=True)
class TradeIdempotencyStatus:
    market: str
    client_order_id: str
    status: str
    operation: Optional[str]
    response_payload: Optional[dict[str, Any]]
    created_at: Optional[datetime]
    completed_at: Optional[datetime]


def normalize_trade_client_order_id(value: object) -> str:
    if not isinstance(value, str):
        raise ValueError("client_order_id must be a string")
    normalized = value.strip().lower()
    if CLIENT_ORDER_ID_PATTERN.fullmatch(normalized) is None:
        raise ValueError("client_order_id has an invalid format")
    return normalized


def _canonicalize(value: Any) -> Any:
    if isinstance(value, Decimal):
        if not value.is_finite():
            raise ValueError("trade idempotency payload contains a non-finite decimal")
        if value == 0:
            return "0"
        return format(value.normalize(), "f")
    if isinstance(value, Enum):
        return _canonicalize(value.value)
    if isinstance(value, Mapping):
        return {str(key): _canonicalize(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_canonicalize(item) for item in value]
    return value


def canonical_request_hash(payload: Mapping[str, Any]) -> str:
    encoded = json.dumps(
        _canonicalize(payload),
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return sha256(encoded).hexdigest()


def lock_trade_idempotency_owner(db: Session, *, user_id: int) -> None:
    owner_id = (
        db.query(User.id)
        .filter(User.id == int(user_id))
        .with_for_update()
        .scalar()
    )
    if owner_id is None:
        raise TradeIdempotencyUnavailable("交易账户不存在，无法建立幂等锁")


def lookup_trade_idempotency(
    db: Session,
    *,
    user_id: int,
    market: str,
    operation: str,
    client_order_id: str,
    request_payload: Mapping[str, Any],
) -> Optional[TradeIdempotencyClaim]:
    normalized_market = str(market or "").strip().upper()
    normalized_operation = str(operation or "").strip().upper()
    normalized_client_order_id = normalize_trade_client_order_id(client_order_id)
    if not normalized_market or not normalized_operation or not normalized_client_order_id:
        raise ValueError("trade idempotency identity is required")
    request_hash = canonical_request_hash(request_payload)
    existing = (
        db.query(TradeIdempotencyRequest)
        .filter(TradeIdempotencyRequest.user_id == int(user_id))
        .filter(TradeIdempotencyRequest.market == normalized_market)
        .filter(
            TradeIdempotencyRequest.client_order_id
            == normalized_client_order_id
        )
        # A locking read is required here. Authentication has already issued a
        # normal SELECT in this Session, and MySQL REPEATABLE READ could
        # otherwise reuse that older snapshot for a concurrent replay lookup.
        .with_for_update()
        .first()
    )
    if existing is None:
        return None
    return TradeIdempotencyClaim(
        client_order_id=normalized_client_order_id,
        record=None,
        replay_payload=_validate_existing(
            existing,
            operation=normalized_operation,
            request_hash=request_hash,
        ),
    )


def _validate_existing(
    existing: TradeIdempotencyRequest,
    *,
    operation: str,
    request_hash: str,
) -> dict[str, Any]:
    if int(existing.fingerprint_version or 0) != FINGERPRINT_VERSION:
        raise TradeIdempotencyUnavailable(
            "原交易请求使用了不兼容的指纹版本，请人工核验"
        )
    if existing.operation != operation or existing.request_hash != request_hash:
        raise TradeIdempotencyConflict(
            "client_order_id 已被另一笔不同参数的交易请求使用"
        )
    if existing.status != "COMPLETED" or not existing.response_json:
        raise TradeIdempotencyUnavailable("原交易请求结果尚不可用，请稍后核验")
    return _read_completed_response(existing)


def _read_completed_response(
    existing: TradeIdempotencyRequest,
) -> dict[str, Any]:
    try:
        payload = json.loads(existing.response_json)
    except (TypeError, ValueError) as exc:
        raise TradeIdempotencyUnavailable("原交易请求结果无法读取，请人工核验") from exc
    if not isinstance(payload, dict):
        raise TradeIdempotencyUnavailable("原交易请求结果格式无效，请人工核验")
    return payload


def get_trade_idempotency_status(
    db: Session,
    *,
    user_id: int,
    market: str,
    client_order_id: str,
) -> TradeIdempotencyStatus:
    """Read one committed idempotency result owned by the current user.

    A missing row is deliberately not treated as proof that the mutation never
    reached the server. Callers must keep their safety lock for NOT_FOUND and
    PENDING states.
    """

    normalized_market = str(market or "").strip().upper()
    normalized_client_order_id = normalize_trade_client_order_id(client_order_id)
    if not normalized_market:
        raise ValueError("trade idempotency market is required")
    existing = (
        db.query(TradeIdempotencyRequest)
        .filter(TradeIdempotencyRequest.user_id == int(user_id))
        .filter(TradeIdempotencyRequest.market == normalized_market)
        .filter(
            TradeIdempotencyRequest.client_order_id
            == normalized_client_order_id
        )
        .first()
    )
    if existing is None:
        return TradeIdempotencyStatus(
            market=normalized_market,
            client_order_id=normalized_client_order_id,
            status="NOT_FOUND",
            operation=None,
            response_payload=None,
            created_at=None,
            completed_at=None,
        )
    if int(existing.fingerprint_version or 0) != FINGERPRINT_VERSION:
        raise TradeIdempotencyUnavailable(
            "原交易请求使用了不兼容的指纹版本，请人工核验"
        )
    normalized_status = str(existing.status or "").strip().upper()
    if normalized_status == "PENDING":
        response_payload = None
    elif normalized_status == "COMPLETED":
        if not existing.response_json:
            raise TradeIdempotencyUnavailable(
                "原交易请求结果尚不可用，请稍后核验"
            )
        response_payload = _read_completed_response(existing)
    else:
        raise TradeIdempotencyUnavailable(
            "原交易请求状态无法识别，请人工核验"
        )
    return TradeIdempotencyStatus(
        market=normalized_market,
        client_order_id=normalized_client_order_id,
        status=normalized_status,
        operation=str(existing.operation or "").strip().upper() or None,
        response_payload=response_payload,
        created_at=existing.created_at,
        completed_at=existing.completed_at,
    )


def claim_trade_idempotency(
    db: Session,
    *,
    user_id: int,
    market: str,
    operation: str,
    client_order_id: str,
    request_payload: Mapping[str, Any],
) -> TradeIdempotencyClaim:
    """Reserve a request key before any balance/order mutation.

    This function must be the first mutating operation in the transaction. A
    concurrent duplicate blocks on the unique constraint; after the original
    transaction commits it replays the stored response. If the original rolls
    back, the duplicate can acquire the key and execute normally.
    """

    normalized_market = str(market or "").strip().upper()
    normalized_operation = str(operation or "").strip().upper()
    normalized_client_order_id = normalize_trade_client_order_id(client_order_id)
    if not normalized_market or not normalized_operation or not normalized_client_order_id:
        raise ValueError("trade idempotency identity is required")

    request_hash = canonical_request_hash(request_payload)
    filters = (
        TradeIdempotencyRequest.user_id == int(user_id),
        TradeIdempotencyRequest.market == normalized_market,
        TradeIdempotencyRequest.client_order_id == normalized_client_order_id,
    )
    # Insert first instead of SELECT-then-INSERT. On InnoDB this lets the
    # unique index serialize concurrent requests without two missing-row gap
    # locks racing into a deadlock. A duplicate waits for the winner and then
    # follows the replay path below.
    record = TradeIdempotencyRequest(
        user_id=int(user_id),
        market=normalized_market,
        operation=normalized_operation,
        client_order_id=normalized_client_order_id,
        fingerprint_version=FINGERPRINT_VERSION,
        request_hash=request_hash,
        status="PENDING",
        response_json=None,
        created_at=datetime.utcnow(),
        completed_at=None,
    )
    db.add(record)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        existing = (
            db.query(TradeIdempotencyRequest)
            .filter(*filters)
            .with_for_update()
            .first()
        )
        if existing is None:
            raise
        return TradeIdempotencyClaim(
            client_order_id=normalized_client_order_id,
            record=None,
            replay_payload=_validate_existing(
                existing,
                operation=normalized_operation,
                request_hash=request_hash,
            ),
        )

    return TradeIdempotencyClaim(
        client_order_id=normalized_client_order_id,
        record=record,
        replay_payload=None,
    )


def complete_trade_idempotency(
    db: Session,
    claim: TradeIdempotencyClaim,
    response_payload: Mapping[str, Any],
) -> None:
    if claim.record is None or claim.is_replay:
        raise ValueError("only a new idempotency claim can be completed")
    claim.record.response_json = json.dumps(
        dict(response_payload),
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    claim.record.status = "COMPLETED"
    claim.record.completed_at = datetime.utcnow()
    db.add(claim.record)
    db.flush()
