from __future__ import annotations
from typing import Any, Dict, Optional, TypeVar, Generic
from pydantic import BaseModel

T = TypeVar("T")

class ApiError(BaseModel):
    code: str
    message: str

class ApiResponse(BaseModel, Generic[T]):
    ok: bool
    data: Optional[T] = None
    error: Optional[ApiError] = None
    trace_id: Optional[str] = None

def ok(data: Any = None, trace_id: Optional[str] = None) -> Dict[str, Any]:
    return ApiResponse(ok=True, data=data, error=None, trace_id=trace_id).model_dump()

def fail(code: str, message: str, trace_id: Optional[str] = None) -> Dict[str, Any]:
    return ApiResponse(ok=False, data=None, error=ApiError(code=code, message=message), trace_id=trace_id).model_dump()
