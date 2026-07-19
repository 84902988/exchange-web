"""Private contract WebSocket endpoint."""

from __future__ import annotations

import logging
from typing import Any, Optional

from fastapi import APIRouter, Depends, Query, WebSocket, WebSocketDisconnect, status
from sqlalchemy.orm import Session

from app.core.security import decode_token
from app.db.session import get_db
from app.deps.auth import get_current_user_id
from app.schemas.response import ok
from app.services.contract_private_ws import contract_private_ws_manager, get_contract_user_event_bridge_health

router = APIRouter(prefix="/contract", tags=["contract-private"])
logger = logging.getLogger(__name__)
CONTRACT_PRIVATE_WS_AUTH_PROTOCOL = "contract-auth"


@router.get("/ws/private/health")
def contract_private_ws_health(user_id: int = Depends(get_current_user_id)):
    return ok(data=get_contract_user_event_bridge_health())


def _private_ws_protocols(websocket: WebSocket) -> list[str]:
    return [
        value.strip()
        for value in (websocket.headers.get("sec-websocket-protocol") or "").split(",")
        if value.strip()
    ]


def _private_ws_protocol_token(websocket: WebSocket) -> str | None:
    protocols = _private_ws_protocols(websocket)
    try:
        auth_index = protocols.index(CONTRACT_PRIVATE_WS_AUTH_PROTOCOL)
    except ValueError:
        return None
    token_index = auth_index + 1
    return protocols[token_index] if token_index < len(protocols) else None


def _get_user_id_from_websocket(websocket: WebSocket) -> int | None:
    token = (
        websocket.cookies.get("access_token")
        or _private_ws_protocol_token(websocket)
        or websocket.query_params.get("access_token")
    )
    if not token:
        return None
    if token.lower().startswith("bearer "):
        token = token.split(" ", 1)[1].strip()
    try:
        payload = decode_token(token)
    except Exception:
        logger.debug("contract_private_ws_token_decode_failed", exc_info=True)
        return None
    subject = payload.get("sub") or payload.get("user_id")
    if subject is None:
        return None
    try:
        return int(subject)
    except (TypeError, ValueError):
        return None


@router.websocket("/ws/private")
async def contract_private_ws(
    websocket: WebSocket,
    symbol: Optional[str] = Query(default=None),
    db: Session = Depends(get_db),
) -> None:
    user_id = _get_user_id_from_websocket(websocket)
    if user_id is None:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    active_symbol = symbol.strip().upper() if symbol else None
    negotiated_protocol = (
        CONTRACT_PRIVATE_WS_AUTH_PROTOCOL
        if CONTRACT_PRIVATE_WS_AUTH_PROTOCOL in _private_ws_protocols(websocket)
        else None
    )
    await contract_private_ws_manager.connect(user_id, websocket, subprotocol=negotiated_protocol)
    try:
        await contract_private_ws_manager.send_snapshot_to_one(websocket, db, user_id, active_symbol)
        while True:
            message: Any = await websocket.receive_json()
            action = message.get("type") or message.get("action")
            if action == "ping":
                await websocket.send_json({"type": "pong"})
            elif action == "subscribe":
                next_symbol = message.get("symbol")
                active_symbol = str(next_symbol).strip().upper() if next_symbol else None
                await contract_private_ws_manager.send_snapshot_to_one(websocket, db, user_id, active_symbol)
    except WebSocketDisconnect:
        pass
    except Exception:
        logger.debug("contract_private_ws_closed_with_error user_id=%s", user_id, exc_info=True)
    finally:
        await contract_private_ws_manager.disconnect(user_id, websocket)
