from __future__ import annotations

import logging
from datetime import datetime
from typing import Any, Dict, Iterable, Optional

from sqlalchemy.orm import Session

from app.db.models.bd_user_relation import BdUserRelation
from app.db.models.user_invite_relation import UserInviteRelation


SOURCE_BD = "BD"
SOURCE_USER_INVITE = "USER_INVITE"
SOURCE_NONE = "NONE"
SOURCE_AMBIGUOUS = "AMBIGUOUS"

logger = logging.getLogger(__name__)


def _relation_time(value: Any) -> Optional[datetime]:
    return value if isinstance(value, datetime) else None


def _source_label(source_type: str) -> str:
    if source_type == SOURCE_BD:
        return "BD"
    if source_type == SOURCE_USER_INVITE:
        return "普通分享"
    if source_type == SOURCE_AMBIGUOUS:
        return "异常（双关系）"
    return "无"


def _source_badge(source_type: str) -> str:
    if source_type == SOURCE_BD:
        return "info"
    if source_type == SOURCE_USER_INVITE:
        return "success"
    if source_type == SOURCE_AMBIGUOUS:
        return "danger"
    return "neutral"


def _result(
    source_type: str,
    *,
    source_relation_id: Optional[int] = None,
    bound_at: Optional[datetime] = None,
) -> Dict[str, Any]:
    return {
        "source_type": source_type,
        "source_label": _source_label(source_type),
        "source_badge": _source_badge(source_type),
        "source_relation_id": source_relation_id,
        "bound_at": bound_at,
    }


def get_user_commission_source(db: Session, user_id: int) -> Dict[str, Any]:
    bd_relation = (
        db.query(BdUserRelation)
        .filter(
            BdUserRelation.user_id == int(user_id),
            BdUserRelation.status == "ACTIVE",
        )
        .order_by(BdUserRelation.created_at.asc(), BdUserRelation.id.asc())
        .first()
    )
    user_relation = (
        db.query(UserInviteRelation)
        .filter(
            UserInviteRelation.invitee_user_id == int(user_id),
            UserInviteRelation.status == "ACTIVE",
        )
        .order_by(UserInviteRelation.created_at.asc(), UserInviteRelation.id.asc())
        .first()
    )

    if bd_relation is not None and user_relation is None:
        bound_at = _relation_time(getattr(bd_relation, "bound_at", None)) or _relation_time(
            getattr(bd_relation, "created_at", None)
        )
        return _result(SOURCE_BD, source_relation_id=int(bd_relation.id), bound_at=bound_at)

    if user_relation is not None and bd_relation is None:
        return _result(
            SOURCE_USER_INVITE,
            source_relation_id=int(user_relation.id),
            bound_at=_relation_time(getattr(user_relation, "created_at", None)),
        )

    if bd_relation is None and user_relation is None:
        return _result(SOURCE_NONE)

    bd_time = _relation_time(getattr(bd_relation, "bound_at", None)) or _relation_time(
        getattr(bd_relation, "created_at", None)
    )
    user_time = _relation_time(getattr(user_relation, "created_at", None))
    if bd_time and user_time:
        if bd_time < user_time:
            return _result(SOURCE_BD, source_relation_id=int(bd_relation.id), bound_at=bd_time)
        if user_time < bd_time:
            return _result(
                SOURCE_USER_INVITE,
                source_relation_id=int(user_relation.id),
                bound_at=user_time,
            )

    logger.warning(
        "ambiguous referral source user_id=%s bd_relation_id=%s user_invite_relation_id=%s",
        user_id,
        getattr(bd_relation, "id", None),
        getattr(user_relation, "id", None),
    )
    return _result(SOURCE_AMBIGUOUS)


def get_user_commission_sources(db: Session, user_ids: Iterable[int]) -> Dict[int, Dict[str, Any]]:
    return {int(user_id): get_user_commission_source(db, int(user_id)) for user_id in user_ids}
