from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.deps.auth import get_current_user_id
from app.schemas.account_transfer import AccountTransferRequest
from app.schemas.response import ok
from app.services.transfer_service import (
    TransferBadRequest,
    TransferInsufficientBalance,
    transfer_service,
)

router = APIRouter(
    prefix="/account/transfer",
    tags=["account"],
)


@router.post(
    "",
    summary="账户内部划转",
    description="""
在 funding 与 spot 账户之间执行内部划转。

接口说明：
1. 当前仅支持 funding -> spot 与 spot -> funding
2. 仅在用户自己的两个账户之间转移，不涉及链上转账
3. service 层会校验可用余额，并同步写入 internal_transfer 记录
4. 本步仅提供最小闭环，不涉及审核、风控、手续费、幂等键

请求参数：
- from_account：转出账户，仅支持 funding / spot
- to_account：转入账户，仅支持 funding / spot
- symbol：币种，例如 USDT
- amount：划转数量，必须大于 0

请求示例：
POST /account/transfer
{
  "from_account": "funding",
  "to_account": "spot",
  "symbol": "USDT",
  "amount": "100"
}

返回示例：
{
  "ok": true,
  "data": {
    "record": {
      "id": 1,
      "transfer_no": "ITR202604081230001A2B3C4D",
      "symbol": "USDT",
      "from_account": "funding",
      "to_account": "spot",
      "amount": "100",
      "status": "SUCCESS",
      "from_available_before": "300",
      "from_available_after": "200",
      "to_available_before": "20",
      "to_available_after": "120",
      "remark": "internal transfer funding->spot",
      "created_at": "2026-04-08T12:30:00"
    }
  },
  "error": null,
  "trace_id": "xxx"
}
""",
)
def create_account_transfer(
    request: Request,
    payload: AccountTransferRequest,
    db: Session = Depends(get_db),
    user_id: int = Depends(get_current_user_id),
):
    trace_id = getattr(request.state, "trace_id", None)

    try:
        # 项目当前使用 Pydantic v2（requirements.txt 固定为 2.12.5，
        # 且全局已使用 ConfigDict / model_config），这里保持 model_dump()。
        data = transfer_service.create_transfer(db, user_id=user_id, payload=payload)
        return ok(data=data.model_dump(), trace_id=trace_id)
    except TransferInsufficientBalance as exc:
        db.rollback()
        raise HTTPException(
            status_code=400,
            detail={"code": exc.code, "message": str(exc)},
        )
    except TransferBadRequest as exc:
        db.rollback()
        raise HTTPException(
            status_code=400,
            detail={"code": exc.code, "message": str(exc)},
        )
    except HTTPException:
        db.rollback()
        raise
    except Exception:
        db.rollback()
        raise HTTPException(
            status_code=500,
            detail={"code": "INTERNAL_ERROR", "message": "account transfer failed"},
        )


@router.get(
    "/records",
    summary="查询内部划转记录",
    description="""
查询当前用户的 funding / spot 内部划转记录。

接口说明：
1. 仅返回当前登录用户自己的划转记录
2. 支持按 symbol、from_account、to_account 过滤
3. 返回结果按 id 倒序排列，最新记录优先

参数说明：
- page：页码，默认 1
- page_size：每页数量，默认 20，最大 200
- symbol：可选，币种过滤，例如 USDT
- from_account：可选，转出账户过滤，funding / spot
- to_account：可选，转入账户过滤，funding / spot

请求示例：
GET /account/transfer/records?page=1&page_size=20&symbol=USDT

返回示例：
{
  "ok": true,
  "data": {
    "items": [
      {
        "id": 1,
        "transfer_no": "ITR202604081230001A2B3C4D",
        "symbol": "USDT",
        "from_account": "funding",
        "to_account": "spot",
        "amount": "100",
        "status": "SUCCESS",
        "from_available_before": "300",
        "from_available_after": "200",
        "to_available_before": "20",
        "to_available_after": "120",
        "remark": "internal transfer funding->spot",
        "created_at": "2026-04-08T12:30:00"
      }
    ],
    "total": 1,
    "page": 1,
    "page_size": 20
  },
  "error": null,
  "trace_id": "xxx"
}
""",
)
def list_account_transfer_records(
    request: Request,
    page: int = Query(1, ge=1, description="页码，默认 1", example=1),
    page_size: int = Query(20, ge=1, le=200, description="每页数量，默认 20，最大 200", example=20),
    symbol: str = Query("", description="可选，币种过滤，例如 USDT", example="USDT"),
    from_account: str = Query("", description="可选，转出账户过滤：funding / spot", example="funding"),
    to_account: str = Query("", description="可选，转入账户过滤：funding / spot", example="spot"),
    db: Session = Depends(get_db),
    user_id: int = Depends(get_current_user_id),
):
    trace_id = getattr(request.state, "trace_id", None)

    try:
        # 项目当前使用 Pydantic v2，保持 model_dump()，不回退到 dict()。
        data = transfer_service.list_records(
            db,
            user_id=user_id,
            page=page,
            page_size=page_size,
            symbol=symbol,
            from_account=from_account,
            to_account=to_account,
        )
        return ok(data=data.model_dump(), trace_id=trace_id)
    except TransferBadRequest as exc:
        db.rollback()
        raise HTTPException(
            status_code=400,
            detail={"code": exc.code, "message": str(exc)},
        )
    except HTTPException:
        db.rollback()
        raise
    except Exception:
        db.rollback()
        raise HTTPException(
            status_code=500,
            detail={"code": "INTERNAL_ERROR", "message": "list account transfer records failed"},
        )
