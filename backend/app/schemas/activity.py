from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Optional

from pydantic import BaseModel


class ActivityOut(BaseModel):
    id: int
    title: str
    subtitle: str = ""
    description: str = ""
    detail_content: str = ""
    reward_text: str = ""
    reward_value: Optional[Decimal] = None
    cover_url: str = ""
    banner_url: str = ""
    banner_type: str = "image"
    video_url: str = ""
    status: str = "active"
    status_label: str = "进行中"
    sort_order: int = 0
    start_at: Optional[datetime] = None
    end_at: Optional[datetime] = None
    cta_text: str = "立即参与"
    cta_url: str = ""


class ActivityBannerOut(BaseModel):
    id: int
    title: str
    subtitle: str = ""
    media_type: str = "image"
    media_url: str = ""
    link_url: str = ""
    sort_order: int = 0
    enabled: bool = True
    start_at: Optional[datetime] = None
    end_at: Optional[datetime] = None
