from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from app.db.models import BdUserRelation, User, UserInviteRelation
from app.db.session import get_db
from app.deps.auth import get_current_user_id
from app.schemas.response import ok
from app.schemas.user_invited_friend import InvitedFriendsApiResponse
from app.services.referral_source_service import SOURCE_BD, SOURCE_USER_INVITE


router = APIRouter(prefix="/user", tags=["user"])


def _datetime_value(value: Any) -> Optional[datetime]:
    return value if isinstance(value, datetime) else None


def _sort_bound_at(item: dict[str, Any]) -> datetime:
    return item.get("bound_at") or item.get("registered_at") or datetime.min


@router.get("/invited-friends", response_model=InvitedFriendsApiResponse)
def get_my_invited_friends(
    request: Request,
    user_id: str = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    trace_id = getattr(request.state, "trace_id", None)
    current_user_id = int(user_id)

    user_invite_rows = (
        db.query(UserInviteRelation, User)
        .outerjoin(User, User.id == UserInviteRelation.invitee_user_id)
        .filter(
            UserInviteRelation.inviter_user_id == current_user_id,
            UserInviteRelation.status == "ACTIVE",
        )
        .order_by(UserInviteRelation.created_at.desc(), UserInviteRelation.id.desc())
        .limit(10)
        .all()
    )
    bd_rows = (
        db.query(BdUserRelation, User)
        .outerjoin(User, User.id == BdUserRelation.user_id)
        .filter(
            BdUserRelation.bd_user_id == current_user_id,
            BdUserRelation.status == "ACTIVE",
        )
        .order_by(BdUserRelation.bound_at.desc(), BdUserRelation.created_at.desc(), BdUserRelation.id.desc())
        .limit(10)
        .all()
    )

    items: list[dict[str, Any]] = []
    for relation, invited_user in user_invite_rows:
        registered_at = _datetime_value(getattr(invited_user, "created_at", None))
        bound_at = _datetime_value(getattr(relation, "created_at", None))
        items.append(
            {
                "user_id": int(relation.invitee_user_id),
                "email": getattr(invited_user, "email", None),
                "source_type": SOURCE_USER_INVITE,
                "invite_code": relation.invite_code,
                "registered_at": registered_at,
                "bound_at": bound_at,
            }
        )

    for relation, invited_user in bd_rows:
        registered_at = _datetime_value(getattr(invited_user, "created_at", None))
        bound_at = _datetime_value(getattr(relation, "bound_at", None)) or _datetime_value(
            getattr(relation, "created_at", None)
        )
        items.append(
            {
                "user_id": int(relation.user_id),
                "email": getattr(invited_user, "email", None),
                "source_type": SOURCE_BD,
                "invite_code": relation.invite_code,
                "registered_at": registered_at,
                "bound_at": bound_at,
            }
        )

    items = sorted(items, key=_sort_bound_at, reverse=True)[:10]
    return ok(data={"items": items}, trace_id=trace_id)
