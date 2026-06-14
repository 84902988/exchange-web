from __future__ import annotations

from typing import Any, Dict, Optional

import requests
from web3 import Web3
from web3.providers.rpc import HTTPProvider
from web3.types import RPCEndpoint, RPCResponse


NO_PROXY_PROXIES: Dict[str, Optional[str]] = {"http": None, "https": None}


def create_no_proxy_session() -> requests.Session:
    session = requests.Session()
    session.trust_env = False
    session.proxies.update(NO_PROXY_PROXIES)
    return session


def rpc_post_no_proxy(rpc_url: str, payload: Dict[str, Any], *, timeout: float = 10.0) -> Dict[str, Any]:
    response = create_no_proxy_session().post(
        rpc_url,
        json=payload,
        timeout=timeout,
        proxies=NO_PROXY_PROXIES,
    )
    response.raise_for_status()
    data = response.json()
    return data if isinstance(data, dict) else {}


class NoProxyHTTPProvider(HTTPProvider):
    def __init__(self, endpoint_uri: str, request_kwargs: Optional[Dict[str, Any]] = None) -> None:
        super().__init__(endpoint_uri=endpoint_uri, request_kwargs=request_kwargs)
        self._no_proxy_session = create_no_proxy_session()

    def make_request(self, method: RPCEndpoint, params: Any) -> RPCResponse:
        request_data = self.encode_rpc_request(method, params)
        kwargs = dict(self.get_request_kwargs())
        kwargs["proxies"] = NO_PROXY_PROXIES
        response = self._no_proxy_session.post(self.endpoint_uri, data=request_data, **kwargs)
        response.raise_for_status()
        return self.decode_rpc_response(response.content)


def build_web3_no_proxy_provider(rpc_url: str, *, timeout: float = 10.0) -> NoProxyHTTPProvider:
    return NoProxyHTTPProvider(rpc_url, request_kwargs={"timeout": timeout})


def build_web3_no_proxy(rpc_url: str, *, timeout: float = 10.0) -> Web3:
    return Web3(build_web3_no_proxy_provider(rpc_url, timeout=timeout))
