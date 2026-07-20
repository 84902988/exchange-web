from __future__ import annotations

import asyncio

from jose import JWTError
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.core.config import settings
from app.core.security import decode_token
from app.db.session import SessionLocal
from app.services.spot_private_ws import spot_private_ws_manager


router = APIRouter(
    prefix="/spot",
    tags=["spot-private"],
)

SPOT_PRIVATE_WS_AUTH_PROTOCOL = "spot-auth"


def _private_ws_protocols(websocket: WebSocket) -> list[str]:
    return [
        value.strip()
        for value in (websocket.headers.get("sec-websocket-protocol") or "").split(",")
        if value.strip()
    ]


def _private_ws_protocol_token(websocket: WebSocket) -> str | None:
    protocols = _private_ws_protocols(websocket)
    try:
        auth_index = protocols.index(SPOT_PRIVATE_WS_AUTH_PROTOCOL)
    except ValueError:
        return None
    token_index = auth_index + 1
    return protocols[token_index] if token_index < len(protocols) else None


def _get_user_id_from_websocket(websocket: WebSocket) -> int:
    token = (
        _private_ws_protocol_token(websocket)
        or websocket.cookies.get(settings.ACCESS_TOKEN_COOKIE_NAME or "access_token")
        or websocket.query_params.get("access_token")
        or websocket.query_params.get("token")
    )
    if not token:
        raise JWTError("missing access token")

    payload = decode_token(token, audience="user")
    if payload.get("type") != "access":
        raise JWTError("invalid token type")

    sub = payload.get("sub")
    if sub is None or str(sub).strip() == "":
        raise JWTError("missing sub")

    return int(sub)


@router.websocket("/ws/private")
async def spot_private_ws(websocket: WebSocket):
    symbol = (websocket.query_params.get("symbol") or "").upper().strip()
    if not symbol:
        await websocket.close(code=1008)
        return

    try:
        user_id = _get_user_id_from_websocket(websocket)
    except Exception as e:
        print("[spot_private_ws auth error]", repr(e))
        await websocket.close(code=1008)
        return

    db = SessionLocal()
    connected_symbol = symbol
    manager_connected = False

    try:
        negotiated_protocol = (
            SPOT_PRIVATE_WS_AUTH_PROTOCOL
            if SPOT_PRIVATE_WS_AUTH_PROTOCOL in _private_ws_protocols(websocket)
            else None
        )
        await websocket.accept(subprotocol=negotiated_protocol)

        await spot_private_ws_manager.connect(user_id, connected_symbol, websocket)
        manager_connected = True

        await spot_private_ws_manager.send_orders_snapshot_to_one(
            websocket,
            db,
            user_id,
            connected_symbol,
        )

        while True:
            try:
                try:
                    message = await asyncio.wait_for(websocket.receive(), timeout=30)
                except asyncio.TimeoutError:
                    await websocket.send_text("ping")
                    continue

                msg_type = message.get("type")

                if msg_type == "websocket.disconnect":
                    break

                if msg_type == "websocket.receive":
                    text = message.get("text") or ""

                    if text == "ping":
                        await websocket.send_text("pong")
                        continue

                    if text.startswith("subscribe:"):
                        new_symbol = text.split(":", 1)[1].upper().strip()
                        if not new_symbol:
                            continue
                        if new_symbol == connected_symbol:
                            continue

                        if manager_connected:
                            await spot_private_ws_manager.disconnect(
                                user_id,
                                connected_symbol,
                                websocket,
                            )

                        connected_symbol = new_symbol
                        await spot_private_ws_manager.connect(
                            user_id,
                            connected_symbol,
                            websocket,
                        )
                        manager_connected = True

                        await spot_private_ws_manager.send_orders_snapshot_to_one(
                            websocket,
                            db,
                            user_id,
                            connected_symbol,
                        )

            except WebSocketDisconnect:
                break
            except RuntimeError as e:
                if "WebSocket is not connected" in str(e):
                    break
                raise

    finally:
        if manager_connected:
            try:
                await spot_private_ws_manager.disconnect(
                    user_id,
                    connected_symbol,
                    websocket,
                )
            except Exception:
                pass
        db.close()
