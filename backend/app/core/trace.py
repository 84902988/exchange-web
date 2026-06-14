from __future__ import annotations
from typing import Optional
from fastapi import Request

def trace_id_from_request(request: Request) -> Optional[str]:
    # 兼容你是否做了 middleware：有就用，没有就返回 None
    return getattr(request.state, "trace_id", None) or request.headers.get("X-Trace-Id")
