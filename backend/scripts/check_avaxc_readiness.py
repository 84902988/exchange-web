from __future__ import annotations

import os
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.core.chain_capabilities import CONFIG_ONLY, get_chain_runtime_status  # noqa: E402
from app.core.chain_config import get_chain_config  # noqa: E402
from app.services import address_service  # noqa: E402
from app.services.evm_wallet import derive_evm_address_by_chain, get_evm_chain_offset  # noqa: E402
from app.services.moralis_service import STREAM_ID_MAP  # noqa: E402


def _ok(name: str, detail: str) -> None:
    print(f"[OK] {name}: {detail}")


def _warn(name: str, detail: str) -> None:
    print(f"[WARN] {name}: {detail}")


def main() -> int:
    cfg = get_chain_config("avaxc")
    if cfg.chain_id != 43114:
        raise SystemExit(f"unexpected avaxc chain_id: {cfg.chain_id}")
    if not cfg.rpc_urls:
        raise SystemExit("avaxc rpc_urls is empty")
    _ok("chain_config", f"chain_id={cfg.chain_id} confirmations={cfg.confirmations} rpc_count={len(cfg.rpc_urls)}")

    offset = get_evm_chain_offset("avaxc")
    if offset in {get_evm_chain_offset("bsc"), get_evm_chain_offset("polygon")}:
        raise SystemExit("avaxc offset reuses bsc/polygon offset")
    _ok("evm_wallet_offset", f"avaxc_offset={offset}")

    address_offsets = getattr(address_service, "_EVM_OFFSET_BY_CHAIN_KEY", {})
    if address_offsets.get("avaxc") != offset:
        raise SystemExit("address_service avaxc offset mismatch")
    _ok("address_service", "avaxc is accepted by the deposit-address allowlist")

    if os.getenv("MNEMONIC", "").strip():
        addr = derive_evm_address_by_chain(100000001, "avaxc")
        _ok("address_derivation", f"sample_address={addr}")
    else:
        _warn("address_derivation", "MNEMONIC not set; skipped sample derivation")

    stream_id = (STREAM_ID_MAP.get("AVAXC") or "").strip()
    if stream_id:
        _ok("moralis_stream", "MORALIS_STREAM_ID_AVAXC is configured")
    else:
        _warn("moralis_stream", "MORALIS_STREAM_ID_AVAXC is not configured")

    runtime_status = get_chain_runtime_status("avaxc")
    if runtime_status != CONFIG_ONLY:
        raise SystemExit(f"avaxc capability must stay CONFIG_ONLY, got {runtime_status}")
    _ok("chain_capability", f"runtime_status={runtime_status}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
