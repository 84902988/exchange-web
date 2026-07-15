from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any, Mapping
from uuid import uuid4

from sqlalchemy import select
from sqlalchemy.dialects.mysql import insert as mysql_insert
from sqlalchemy.orm import Session

from app.db.models.spot_private_event import SpotPrivateEvent, SpotPrivateEventSequence


SPOT_PRIVATE_EVENTS_CHANNEL = "spot:user_events"
SPOT_PRIVATE_EVENT_PENDING = "PENDING"
SPOT_PRIVATE_EVENT_PUBLISHED = "PUBLISHED"


@dataclass(frozen=True)
class SpotPrivateEventEnvelope:
    event_id: str
    user_id: int
    sequence: int
    event_type: str
    payload: dict[str, Any]

    def to_dict(self) -> dict[str, Any]:
        return {
            "event_id": self.event_id,
            "user_id": self.user_id,
            "sequence": self.sequence,
            "event_type": self.event_type,
            "payload": self.payload,
        }


def _normalize_event_type(value: str) -> str:
    normalized = str(value or "").strip().upper()
    if not normalized:
        raise ValueError("spot private event_type is required")
    return normalized


def _normalize_payload(value: Mapping[str, Any]) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        raise ValueError("spot private event payload must be an object")
    return dict(value)


def reserve_spot_private_event_sequence(db: Session, user_id: int) -> int:
    normalized_user_id = int(user_id)
    if normalized_user_id <= 0:
        raise ValueError("spot private event user_id must be positive")

    bind = db.get_bind()
    if bind.dialect.name == "mysql":
        statement = mysql_insert(SpotPrivateEventSequence).values(
            user_id=normalized_user_id,
            last_sequence=1,
        )
        statement = statement.on_duplicate_key_update(
            last_sequence=SpotPrivateEventSequence.last_sequence + 1,
        )
        db.execute(statement)
        sequence = db.execute(
            select(SpotPrivateEventSequence.last_sequence).where(
                SpotPrivateEventSequence.user_id == normalized_user_id
            )
        ).scalar_one()
        return int(sequence)

    sequence_row = db.execute(
        select(SpotPrivateEventSequence)
        .where(SpotPrivateEventSequence.user_id == normalized_user_id)
        .with_for_update()
    ).scalar_one_or_none()
    if sequence_row is None:
        sequence_row = SpotPrivateEventSequence(
            user_id=normalized_user_id,
            last_sequence=0,
        )
        db.add(sequence_row)
        db.flush()

    sequence_row.last_sequence = int(sequence_row.last_sequence or 0) + 1
    db.flush()
    return int(sequence_row.last_sequence)


def create_spot_private_event(
    db: Session,
    *,
    user_id: int,
    event_type: str,
    payload: Mapping[str, Any],
    event_id: str | None = None,
    created_at: datetime | None = None,
) -> SpotPrivateEvent:
    sequence = reserve_spot_private_event_sequence(db, int(user_id))
    normalized_event_id = str(event_id or f"spot-private-{uuid4().hex}").strip()
    if not normalized_event_id:
        raise ValueError("spot private event_id is required")

    event = SpotPrivateEvent(
        event_id=normalized_event_id,
        user_id=int(user_id),
        sequence=sequence,
        event_type=_normalize_event_type(event_type),
        payload_json=_normalize_payload(payload),
        status=SPOT_PRIVATE_EVENT_PENDING,
        created_at=created_at or datetime.utcnow(),
        retry_count=0,
    )
    db.add(event)
    db.flush()
    return event


def envelope_from_event(event: SpotPrivateEvent) -> SpotPrivateEventEnvelope:
    return SpotPrivateEventEnvelope(
        event_id=str(event.event_id),
        user_id=int(event.user_id),
        sequence=int(event.sequence),
        event_type=str(event.event_type),
        payload=dict(event.payload_json or {}),
    )
