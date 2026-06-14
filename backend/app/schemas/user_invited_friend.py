from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel

from app.schemas.response import ApiResponse


class InvitedFriendItem(BaseModel):
    user_id: int
    email: Optional[str] = None
    source_type: str
    invite_code: Optional[str] = None
    registered_at: Optional[datetime] = None
    bound_at: Optional[datetime] = None


class InvitedFriendsOut(BaseModel):
    items: list[InvitedFriendItem]


class InvitedFriendsApiResponse(ApiResponse[InvitedFriendsOut]):
    pass
