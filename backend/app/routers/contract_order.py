from __future__ import annotations

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request
from pydantic import ValidationError
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.deps.auth import get_current_user_id
from app.schemas.contract_order import (
    ContractCloseOrderRequest,
    ContractCloseSummaryOrderRequest,
    ContractCloseSummaryOrderResponse,
    ContractOpenOrderRequest,
    ContractOrderResponse,
)
from app.schemas.response import ok
from app.schemas.trade_idempotency import TradeIdempotencyStatusResponse
from app.services.contract_order_service import (
    ContractOrderBadRequest,
    ContractOrderError,
    ContractOrderInsufficientMargin,
    ContractOrderQuoteUnavailable,
    cancel_contract_order,
    close_contract_position_summary,
    close_contract_position,
    contract_close_summary_idempotency_payload,
    contract_open_idempotency_payload,
    create_contract_open_order,
    prepare_contract_close_summary_order_quote,
    prepare_contract_open_order_quote,
)
from app.services.contract_private_ws import publish_contract_user_updates_background as publish_contract_user_updates
from app.services.trade_idempotency_service import (
    TradeIdempotencyConflict,
    TradeIdempotencyUnavailable,
    claim_trade_idempotency,
    complete_trade_idempotency,
    get_trade_idempotency_status,
    lookup_trade_idempotency,
)

router = APIRouter(prefix="/contract/orders", tags=["contract-orders"])


def _mutation_response_dump(
    data: ContractOrderResponse | ContractCloseSummaryOrderResponse,
) -> dict:
    result = data.model_dump()
    if result.get("client_order_id") is None:
        result.pop("client_order_id", None)
    return result


def _validate_contract_open_replay(
    payload: object,
    *,
    client_order_id: str,
) -> ContractOrderResponse:
    try:
        data = ContractOrderResponse.model_validate(payload)
    except ValidationError as exc:
        raise TradeIdempotencyUnavailable("原合约开仓结果格式无效，请人工核验") from exc
    if data.client_order_id != client_order_id:
        raise TradeIdempotencyUnavailable("原合约开仓结果的 client_order_id 不匹配，请人工核验")
    return data


def _validate_contract_close_summary_replay(
    payload: object,
    *,
    client_order_id: str,
) -> ContractCloseSummaryOrderResponse:
    try:
        data = ContractCloseSummaryOrderResponse.model_validate(payload)
    except ValidationError as exc:
        raise TradeIdempotencyUnavailable("原合约聚合平仓结果格式无效，请人工核验") from exc
    if data.client_order_id != client_order_id:
        raise TradeIdempotencyUnavailable("原合约聚合平仓结果的 client_order_id 不匹配，请人工核验")
    return data


def _publish_order_result(
    background_tasks: BackgroundTasks,
    *,
    user_id: int,
    symbols: list[str],
    position_ids: list[int] | None,
    order_ids: list[int],
    trade_ids: list[int] | None = None,
) -> None:
    background_tasks.add_task(
        publish_contract_user_updates,
        user_id=user_id,
        symbols=symbols,
        position_ids=position_ids,
        order_ids=order_ids,
        trade_ids=trade_ids,
        include_account=False,
        prefer_transaction_mark=True,
    )
    background_tasks.add_task(
        publish_contract_user_updates,
        user_id=user_id,
        include_account=True,
    )


@router.get("/idempotency/{client_order_id}")
def get_contract_idempotency_result(
    client_order_id: str,
    request: Request,
    db: Session = Depends(get_db),
    user_id: int = Depends(get_current_user_id),
):
    trace_id = getattr(request.state, "trace_id", None)
    try:
        result = get_trade_idempotency_status(
            db,
            user_id=int(user_id),
            market="CONTRACT",
            client_order_id=client_order_id,
        )
        if result.operation not in {
            None,
            "CONTRACT_OPEN",
            "CONTRACT_CLOSE_SUMMARY",
        }:
            raise TradeIdempotencyUnavailable(
                "原合约交易请求类型无法识别，请人工核验"
            )
        response_payload = None
        if result.status == "COMPLETED":
            if result.operation == "CONTRACT_OPEN":
                data = _validate_contract_open_replay(
                    result.response_payload,
                    client_order_id=result.client_order_id,
                )
            elif result.operation == "CONTRACT_CLOSE_SUMMARY":
                data = _validate_contract_close_summary_replay(
                    result.response_payload,
                    client_order_id=result.client_order_id,
                )
            else:
                raise TradeIdempotencyUnavailable(
                    "原合约交易请求类型缺失，请人工核验"
                )
            response_payload = data.model_dump(mode="json")
        response = TradeIdempotencyStatusResponse(
            market="CONTRACT",
            client_order_id=result.client_order_id,
            status=result.status,
            operation=result.operation,
            result=response_payload,
            created_at=result.created_at,
            completed_at=result.completed_at,
        )
        return ok(data=response.model_dump(mode="json"), trace_id=trace_id)
    except TradeIdempotencyConflict as exc:
        raise HTTPException(status_code=409, detail={"code": exc.code, "message": str(exc)})
    except TradeIdempotencyUnavailable as exc:
        raise HTTPException(status_code=503, detail={"code": exc.code, "message": str(exc)})
    except ValueError as exc:
        raise HTTPException(
            status_code=422,
            detail={"code": "INVALID_CLIENT_ORDER_ID", "message": str(exc)},
        ) from exc


@router.post("/open")
def contract_open_order(
    request: Request,
    payload: ContractOpenOrderRequest,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    user_id: int = Depends(get_current_user_id),
):
    trace_id = getattr(request.state, "trace_id", None)
    try:
        if payload.client_order_id is not None:
            request_payload = contract_open_idempotency_payload(payload)
            replay = lookup_trade_idempotency(
                db,
                user_id=int(user_id),
                market="CONTRACT",
                operation="CONTRACT_OPEN",
                client_order_id=payload.client_order_id,
                request_payload=request_payload,
            )
            if replay is not None:
                data = _validate_contract_open_replay(
                    replay.replay_payload,
                    client_order_id=replay.client_order_id,
                )
                db.rollback()
                return ok(data=_mutation_response_dump(data), trace_id=trace_id)

            # Release the missing-row FOR UPDATE gap lock (and the read-only
            # authentication transaction) before the insert-first claim.
            # A concurrent winner between this rollback and claim is handled
            # by the idempotency unique key and replay path in claim().
            db.rollback()
            quote = prepare_contract_open_order_quote(db, int(user_id), payload)
            claim = claim_trade_idempotency(
                db,
                user_id=int(user_id),
                market="CONTRACT",
                operation="CONTRACT_OPEN",
                client_order_id=payload.client_order_id,
                request_payload=request_payload,
            )
            if claim.is_replay:
                data = _validate_contract_open_replay(
                    claim.replay_payload,
                    client_order_id=claim.client_order_id,
                )
                db.rollback()
                return ok(data=_mutation_response_dump(data), trace_id=trace_id)

            data = create_contract_open_order(
                db,
                int(user_id),
                payload,
                commit=False,
                quote_override=quote,
            )
            complete_trade_idempotency(
                db,
                claim,
                data.model_dump(mode="json"),
            )
            db.commit()
        else:
            data = create_contract_open_order(db, int(user_id), payload)
        _publish_order_result(
            background_tasks,
            user_id=int(user_id),
            symbols=[data.symbol],
            position_ids=[data.position_id] if data.position_id is not None else None,
            order_ids=[data.order_id],
        )
        return ok(data=_mutation_response_dump(data), trace_id=trace_id)
    except TradeIdempotencyConflict as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail={"code": exc.code, "message": str(exc)})
    except TradeIdempotencyUnavailable as exc:
        db.rollback()
        raise HTTPException(status_code=503, detail={"code": exc.code, "message": str(exc)})
    except ContractOrderInsufficientMargin as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail={"code": exc.code, "message": str(exc)})
    except (ContractOrderBadRequest, ContractOrderQuoteUnavailable) as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail={"code": exc.code, "message": str(exc)})
    except ContractOrderError as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail={"code": exc.code, "message": str(exc)})
    except HTTPException:
        db.rollback()
        raise
    except Exception:
        db.rollback()
        raise HTTPException(
            status_code=500,
            detail={"code": "CONTRACT_OPEN_ORDER_FAILED", "message": "合约开仓失败"},
        )


@router.post("/close")
def contract_close_order(
    request: Request,
    payload: ContractCloseOrderRequest,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    user_id: int = Depends(get_current_user_id),
):
    trace_id = getattr(request.state, "trace_id", None)
    try:
        data = close_contract_position(db, int(user_id), payload)
        _publish_order_result(
            background_tasks,
            user_id=int(user_id),
            symbols=[data.symbol],
            position_ids=[data.position_id] if data.position_id is not None else [payload.position_id],
            order_ids=[data.order_id],
        )
        return ok(data=_mutation_response_dump(data), trace_id=trace_id)
    except ContractOrderInsufficientMargin as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail={"code": exc.code, "message": str(exc)})
    except (ContractOrderBadRequest, ContractOrderQuoteUnavailable) as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail={"code": exc.code, "message": str(exc)})
    except ContractOrderError as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail={"code": exc.code, "message": str(exc)})
    except HTTPException:
        db.rollback()
        raise
    except Exception:
        db.rollback()
        raise HTTPException(
            status_code=500,
            detail={"code": "CONTRACT_CLOSE_ORDER_FAILED", "message": "合约平仓失败"},
        )


@router.post("/close-summary")
def contract_close_summary_order(
    request: Request,
    payload: ContractCloseSummaryOrderRequest,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    user_id: int = Depends(get_current_user_id),
):
    trace_id = getattr(request.state, "trace_id", None)
    try:
        if payload.client_order_id is not None:
            request_payload = contract_close_summary_idempotency_payload(payload)
            replay = lookup_trade_idempotency(
                db,
                user_id=int(user_id),
                market="CONTRACT",
                operation="CONTRACT_CLOSE_SUMMARY",
                client_order_id=payload.client_order_id,
                request_payload=request_payload,
            )
            if replay is not None:
                data = _validate_contract_close_summary_replay(
                    replay.replay_payload,
                    client_order_id=replay.client_order_id,
                )
                db.rollback()
                return ok(data=_mutation_response_dump(data), trace_id=trace_id)

            # See contract_open_order: do not carry a missing-row gap lock
            # into the insert-first claim transaction.
            db.rollback()
            quote = prepare_contract_close_summary_order_quote(db, int(user_id), payload)
            claim = claim_trade_idempotency(
                db,
                user_id=int(user_id),
                market="CONTRACT",
                operation="CONTRACT_CLOSE_SUMMARY",
                client_order_id=payload.client_order_id,
                request_payload=request_payload,
            )
            if claim.is_replay:
                data = _validate_contract_close_summary_replay(
                    claim.replay_payload,
                    client_order_id=claim.client_order_id,
                )
                db.rollback()
                return ok(data=_mutation_response_dump(data), trace_id=trace_id)

            data = close_contract_position_summary(
                db,
                int(user_id),
                payload,
                commit=False,
                quote_override=quote,
            )
            complete_trade_idempotency(
                db,
                claim,
                data.model_dump(mode="json"),
            )
            db.commit()
        else:
            data = close_contract_position_summary(db, int(user_id), payload)
        _publish_order_result(
            background_tasks,
            user_id=int(user_id),
            symbols=[data.symbol],
            position_ids=data.affected_position_ids,
            order_ids=data.generated_order_ids,
            trade_ids=data.generated_trade_ids,
        )
        return ok(data=_mutation_response_dump(data), trace_id=trace_id)
    except TradeIdempotencyConflict as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail={"code": exc.code, "message": str(exc)})
    except TradeIdempotencyUnavailable as exc:
        db.rollback()
        raise HTTPException(status_code=503, detail={"code": exc.code, "message": str(exc)})
    except ContractOrderInsufficientMargin as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail={"code": exc.code, "message": str(exc)})
    except (ContractOrderBadRequest, ContractOrderQuoteUnavailable) as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail={"code": exc.code, "message": str(exc)})
    except ContractOrderError as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail={"code": exc.code, "message": str(exc)})
    except HTTPException:
        db.rollback()
        raise
    except Exception:
        db.rollback()
        raise HTTPException(
            status_code=500,
            detail={"code": "CONTRACT_CLOSE_SUMMARY_ORDER_FAILED", "message": "合约聚合平仓失败"},
        )


@router.post("/{order_id}/cancel")
def contract_cancel_order(
    order_id: int,
    request: Request,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    user_id: int = Depends(get_current_user_id),
):
    trace_id = getattr(request.state, "trace_id", None)
    try:
        data = cancel_contract_order(db, int(user_id), int(order_id))
        _publish_order_result(
            background_tasks,
            user_id=int(user_id),
            symbols=[data.symbol],
            position_ids=[data.position_id] if data.position_id is not None else None,
            order_ids=[data.order_id],
        )
        return ok(data=_mutation_response_dump(data), trace_id=trace_id)
    except ContractOrderError as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail={"code": exc.code, "message": str(exc)})
    except Exception:
        db.rollback()
        raise HTTPException(
            status_code=500,
            detail={"code": "CONTRACT_CANCEL_ORDER_FAILED", "message": "合约撤单失败"},
        )
