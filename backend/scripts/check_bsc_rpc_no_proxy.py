from __future__ import annotations

import json
import os
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def _load_env() -> None:
    env_path = ROOT / ".env"
    if not env_path.exists():
        return
    for raw in env_path.read_text(encoding="utf-8", errors="ignore").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def _decode_int(value: object) -> int | None:
    if value is None:
        return None
    text = str(value)
    return int(text, 16) if text.startswith("0x") else int(text)


def main() -> None:
    _load_env()

    from app.core.chain_config import get_runtime_chain_config
    from app.db.session import SessionLocal
    from app.services.rpc_no_proxy import rpc_post_no_proxy

    db = SessionLocal()
    try:
        urls = list(get_runtime_chain_config(db, "bsc").rpc_urls)
    finally:
        db.close()

    results = []
    for index, rpc_url in enumerate(urls, start=1):
        item = {
            "index": index,
            "rpc_url": rpc_url,
            "chain_id": None,
            "block_number": None,
            "ok": False,
            "errors": [],
        }
        for method, key in (("eth_chainId", "chain_id"), ("eth_blockNumber", "block_number")):
            try:
                data = rpc_post_no_proxy(
                    rpc_url,
                    {"jsonrpc": "2.0", "id": 1, "method": method, "params": []},
                    timeout=8,
                )
                if data.get("error"):
                    raise RuntimeError(str(data.get("error")))
                item[f"{key}_hex"] = data.get("result")
                item[key] = _decode_int(data.get("result"))
            except Exception as exc:
                item["errors"].append(f"{method}:{type(exc).__name__}:{str(exc)[:300]}")
        item["ok"] = item["chain_id"] == 56 and bool(item["block_number"])
        results.append(item)

    print(
        json.dumps(
            {
                "proxy_env_present": {
                    key: os.environ.get(key)
                    for key in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy")
                    if os.environ.get(key)
                },
                "effective_rpc_urls": urls,
                "any_ok_chain_56": any(item["ok"] for item in results),
                "results": results,
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
