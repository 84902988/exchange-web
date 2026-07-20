from __future__ import annotations

from unittest.mock import patch

from starlette.datastructures import Headers, QueryParams

import app.routers.spot_ws_private as private_router


def _websocket(*, cookie: str | None = None, protocols: str = "", query: str | None = None):
    class WebSocketStub:
        cookies = {"access_token": cookie} if cookie else {}
        headers = Headers(
            {"sec-websocket-protocol": protocols} if protocols else {}
        )
        query_params = QueryParams(
            {"access_token": query} if query else {}
        )

    return WebSocketStub()


def test_private_ws_auth_prefers_explicit_protocol_token_over_cookie() -> None:
    websocket = _websocket(
        cookie="cookie-token",
        protocols="spot-auth, protocol-token",
    )
    with patch.object(
        private_router,
        "decode_token",
        return_value={"sub": "7", "type": "access"},
    ) as decode:
        assert private_router._get_user_id_from_websocket(websocket) == 7
    decode.assert_called_once_with("protocol-token", audience="user")


def test_private_ws_auth_accepts_token_from_websocket_subprotocol() -> None:
    websocket = _websocket(protocols="spot-auth, protocol-token")
    with patch.object(
        private_router,
        "decode_token",
        return_value={"sub": "8", "type": "access"},
    ) as decode:
        assert private_router._get_user_id_from_websocket(websocket) == 8
    decode.assert_called_once_with("protocol-token", audience="user")


def test_private_ws_auth_keeps_query_token_compatibility() -> None:
    websocket = _websocket(query="legacy-token")
    with patch.object(
        private_router,
        "decode_token",
        return_value={"sub": "9", "type": "access"},
    ) as decode:
        assert private_router._get_user_id_from_websocket(websocket) == 9
    decode.assert_called_once_with("legacy-token", audience="user")
