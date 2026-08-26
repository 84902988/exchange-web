from __future__ import annotations

from datetime import datetime
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field


class TradeIdempotencyStatusResponse(BaseModel):
    market: Literal["SPOT", "CONTRACT"]
    client_order_id: str = Field(min_length=1, max_length=64)
    status: Literal["NOT_FOUND", "PENDING", "COMPLETED"]
    operation: Optional[str] = None
    result: Optional[dict[str, Any]] = None
    created_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None
