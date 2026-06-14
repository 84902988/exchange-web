from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any


RPC_URLS = [
    "https://bsc.publicnode.com",
    "https://bsc-rpc.publicnode.com",
    "https://rpc.ankr.com/bsc",
    "https://bsc-dataseed.bnbchain.org",
    "https://bsc-dataseed1.bnbchain.org",
    "https://bsc.meowrpc.com",
]

BSC_USDT_CONTRACT = "0x55d398326f99059fF775485246999027B3197955"
TEST_ADDRESS = os.getenv("BSC_RPC_TEST_ADDRESS", "0x0000000000000000000000000000000000000000")
REQUEST_TIMEOUT_SECONDS = float(os.getenv("BSC_RPC_TIMEOUT_SECONDS", "3"))


@dataclass
class StepResult:
    name: str
    ok: bool
    elapsed_ms: float
    value: str = ""
    error: str = ""


@dataclass
class RpcResult:
    url: str
    ok: bool
    elapsed_ms: float
    steps: list[StepResult]


def _json_rpc(url: str, method: str, params: list[Any]) -> Any:
    payload = json.dumps(
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": method,
            "params": params,
        }
    ).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=payload,
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
        raw = response.read().decode("utf-8", errors="replace")
    data = json.loads(raw)
    if isinstance(data, dict) and data.get("error"):
        raise RuntimeError(json.dumps(data["error"], ensure_ascii=False))
    if not isinstance(data, dict) or "result" not in data:
        raise RuntimeError(f"invalid json-rpc response: {raw[:200]}")
    return data["result"]


def _balance_of_data(address: str) -> str:
    normalized = address.lower().removeprefix("0x")
    if len(normalized) != 40:
        raise ValueError("BSC_RPC_TEST_ADDRESS must be a 20-byte hex address")
    return "0x70a08231" + normalized.rjust(64, "0")


def _run_step(url: str, name: str, method: str, params: list[Any]) -> StepResult:
    print(f"  {name} start", flush=True)
    started = time.perf_counter()
    try:
        value = _json_rpc(url, method, params)
        elapsed_ms = (time.perf_counter() - started) * 1000
        print(f"  {name} done OK {_fmt_ms(elapsed_ms)}", flush=True)
        return StepResult(name=name, ok=True, elapsed_ms=elapsed_ms, value=str(value))
    except (urllib.error.URLError, TimeoutError, OSError, ValueError, RuntimeError, json.JSONDecodeError) as exc:
        elapsed_ms = (time.perf_counter() - started) * 1000
        print(f"  {name} done FAIL {_fmt_ms(elapsed_ms)} {type(exc).__name__}: {exc}", flush=True)
        return StepResult(name=name, ok=False, elapsed_ms=elapsed_ms, error=f"{type(exc).__name__}: {exc}")


def check_rpc(url: str) -> RpcResult:
    print(f"testing: {url}", flush=True)
    step_specs = [
        ("eth_chainId", "eth_chainId", []),
        ("eth_blockNumber", "eth_blockNumber", []),
        (
            "balanceOf",
            "eth_call",
            [
                {"to": BSC_USDT_CONTRACT, "data": _balance_of_data(TEST_ADDRESS)},
                "latest",
            ],
        ),
    ]
    steps = []
    for name, method, params in step_specs:
        step = _run_step(url, name, method, params)
        steps.append(step)
        if not step.ok:
            break
    total_ms = sum(step.elapsed_ms for step in steps)
    return RpcResult(url=url, ok=all(step.ok for step in steps), elapsed_ms=total_ms, steps=steps)


def _fmt_ms(value: float) -> str:
    return f"{value:.0f}ms"


def main() -> int:
    print("BSC RPC latency check", flush=True)
    print(f"USDT contract: {BSC_USDT_CONTRACT}", flush=True)
    print(f"balanceOf address: {TEST_ADDRESS}", flush=True)
    print(f"timeout: {REQUEST_TIMEOUT_SECONDS:g}s", flush=True)
    print(flush=True)

    results = [check_rpc(url) for url in RPC_URLS]
    results.sort(key=lambda item: (not item.ok, item.elapsed_ms))

    for index, result in enumerate(results, 1):
        status = "OK" if result.ok else "FAIL"
        print(f"{index}. {status} {result.url} total={_fmt_ms(result.elapsed_ms)}", flush=True)
        for step in result.steps:
            step_status = "OK" if step.ok else "FAIL"
            suffix = step.value if step.ok else step.error
            print(f"   - {step.name}: {step_status} {_fmt_ms(step.elapsed_ms)} {suffix}", flush=True)
        print(flush=True)

    return 0 if any(result.ok for result in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
