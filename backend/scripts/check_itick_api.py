from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Dict, Iterable, Tuple
from urllib.error import HTTPError, URLError
from urllib.request import ProxyHandler, Request, build_opener


BACKEND_DIR = Path(__file__).resolve().parents[1]
ENV_PATH = BACKEND_DIR / ".env"
TIMEOUT_SECONDS = 5


URLS: Tuple[Tuple[str, str], ...] = (
    ("stock_quote_api", "https://api.itick.org/stock/quote?region=US&code=AAPL"),
    ("stock_quote_api0", "https://api0.itick.org/stock/quote?region=US&code=AAPL"),
    ("stock_kline_api", "https://api.itick.org/stock/kline?region=US&code=AAPL&kType=8&limit=10"),
    ("stock_kline_api0", "https://api0.itick.org/stock/kline?region=US&code=AAPL&kType=8&limit=10"),
    ("crypto_quote_api", "https://api.itick.org/crypto/quote?exchange=BA&symbol=BTCUSDT"),
    ("crypto_quote_api0", "https://api0.itick.org/crypto/quote?exchange=BA&symbol=BTCUSDT"),
)


def load_env(path: Path) -> None:
    if not path.exists():
        return

    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue

        key, value = stripped.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        os.environ.setdefault(key, value)


def token_fingerprint(token: str) -> Dict[str, object]:
    return {
        "token_exists": bool(token),
        "token_length": len(token),
        "prefix": token[:4] if len(token) >= 4 else token,
        "suffix": token[-4:] if len(token) >= 4 else token,
    }


def is_code_zero(text: str) -> bool:
    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        return False

    return isinstance(payload, dict) and payload.get("code") == 0


def request_direct(url: str, headers: Dict[str, str]) -> Tuple[int | str, str, str]:
    opener = build_opener(ProxyHandler({}))
    request = Request(url, headers=headers, method="GET")

    try:
        with opener.open(request, timeout=TIMEOUT_SECONDS) as response:
            text = response.read().decode("utf-8", errors="replace")
            return response.status, response.geturl(), text
    except HTTPError as exc:
        text = exc.read().decode("utf-8", errors="replace")
        return exc.code, exc.geturl(), text
    except URLError as exc:
        return "REQUEST_ERROR", url, repr(exc)


def print_result(name: str, final_url: str, status_code: int | str, response_text: str) -> None:
    print("CASE={0}".format(name))
    print("final_url={0}".format(final_url))
    print("status_code={0}".format(status_code))
    print("response_text_500={0}".format(response_text[:500]))
    print("code_0={0}".format(is_code_zero(response_text)))
    print("")


def main() -> None:
    load_env(ENV_PATH)
    token = (os.getenv("ITICK_API_TOKEN") or os.getenv("ITICK_API_KEY") or "").strip()

    for key, value in token_fingerprint(token).items():
        print("{0}={1}".format(key, value))
    print("header_keys=accept,token")
    print("")

    headers = {
        "accept": "application/json",
        "token": token,
    }

    for name, url in URLS:
        status_code, final_url, response_text = request_direct(url, headers)
        print_result(name, final_url, status_code, response_text)


if __name__ == "__main__":
    main()
