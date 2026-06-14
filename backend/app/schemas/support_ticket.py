from __future__ import annotations

from pydantic import BaseModel, Field


class SupportTicketCreateIn(BaseModel):
    category: str = Field(..., min_length=1, max_length=32)
    subject: str = Field(..., min_length=1, max_length=255)
    content: str = Field(..., min_length=1, max_length=5000)


class SupportTicketMessageCreateIn(BaseModel):
    message: str = Field(..., min_length=1, max_length=5000)
