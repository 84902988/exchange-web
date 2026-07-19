from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import patch

from app.routers import contract_ws_private as private_router


def _websocket(*, cookie: str | None = None, protocols: str = "", query: str | None = None):
    return SimpleNamespace(
        cookies={"access_token": cookie} if cookie else {},
        headers={"sec-websocket-protocol": protocols} if protocols else {},
        query_params={"access_token": query} if query else {},
    )


def test_private_ws_auth_prefers_cookie_without_url_token() -> None:
    websocket = _websocket(cookie="cookie-token", protocols="contract-auth, protocol-token")
    with patch.object(private_router, "decode_token", return_value={"sub": "7"}) as decode:
        assert private_router._get_user_id_from_websocket(websocket) == 7
    decode.assert_called_once_with("cookie-token")


def test_private_ws_auth_accepts_token_from_websocket_subprotocol() -> None:
    websocket = _websocket(protocols="contract-auth, protocol-token")
    with patch.object(private_router, "decode_token", return_value={"sub": "8"}) as decode:
        assert private_router._get_user_id_from_websocket(websocket) == 8
    decode.assert_called_once_with("protocol-token")


def test_private_ws_auth_keeps_query_token_only_as_legacy_fallback() -> None:
    websocket = _websocket(query="legacy-token")
    with patch.object(private_router, "decode_token", return_value={"sub": "9"}) as decode:
        assert private_router._get_user_id_from_websocket(websocket) == 9
    decode.assert_called_once_with("legacy-token")
