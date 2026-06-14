from __future__ import annotations

import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from sqlalchemy import create_engine, text

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.core.chain_config import get_runtime_chain_config  # noqa: E402
from app.core.config import settings  # noqa: E402
from app.services.hotwallet import ERC20_ABI_MIN  # noqa: E402
from app.services.rpc_no_proxy import build_web3_no_proxy  # noqa: E402


@dataclass
class RpcResult:
    w3: object
    rpc_url: str


def _connect_rpc(db, chain_key: str) -> Optional[RpcResult]:
    cfg = get_runtime_chain_config(db, chain_key)
    for rpc_url in cfg.rpc_urls:
        try:
            w3 = build_web3_no_proxy(rpc_url, timeout=10)
            if w3.is_connected():
                return RpcResult(w3=w3, rpc_url=rpc_url)
        except Exception:
            continue
    return None


def _read_chain_decimals(w3, contract_address: str) -> int:
    token = w3.to_checksum_address(contract_address)
    contract = w3.eth.contract(address=token, abi=ERC20_ABI_MIN)
    return int(contract.functions.decimals().call())


def main() -> int:
    engine = create_engine(settings.database_url, pool_pre_ping=True, pool_recycle=3600)
    with engine.connect() as db:
        rows = db.execute(
            text(
                """
                SELECT
                    c.chain_key,
                    a.symbol AS asset,
                    ac.contract_address,
                    ac.decimals AS db_decimals
                FROM asset_chains ac
                JOIN assets a ON a.id = ac.asset_id
                JOIN chains c ON c.id = ac.chain_id
                WHERE a.enabled = 1
                  AND c.enabled = 1
                  AND ac.enabled = 1
                  AND ac.contract_address IS NOT NULL
                  AND TRIM(ac.contract_address) <> ''
                ORDER BY c.chain_key, a.symbol
                """
            )
        ).mappings().all()

        rpc_cache: dict[str, Optional[RpcResult]] = {}
        mismatches = 0
        errors = 0

        print("chain\tasset\tcontract_address\tdb_decimals\tchain_decimals\tstatus")
        for row in rows:
            chain_key = str(row["chain_key"] or "").strip().lower()
            asset = str(row["asset"] or "").strip().upper()
            contract_address = str(row["contract_address"] or "").strip()
            db_decimals = int(row["db_decimals"] or 0)

            if chain_key not in rpc_cache:
                rpc_cache[chain_key] = _connect_rpc(db, chain_key)
            rpc = rpc_cache[chain_key]
            if rpc is None:
                errors += 1
                print(f"{chain_key}\t{asset}\t{contract_address}\t{db_decimals}\t-\terror:rpc_unavailable")
                continue

            try:
                chain_decimals = _read_chain_decimals(rpc.w3, contract_address)
            except Exception as exc:
                errors += 1
                print(
                    f"{chain_key}\t{asset}\t{contract_address}\t{db_decimals}\t-"
                    f"\terror:{exc.__class__.__name__}"
                )
                continue

            status = "match" if db_decimals == chain_decimals else "mismatch"
            if status == "mismatch":
                mismatches += 1
            print(f"{chain_key}\t{asset}\t{contract_address}\t{db_decimals}\t{chain_decimals}\t{status}")

        print(f"summary: checked={len(rows)} mismatches={mismatches} errors={errors}")
        return 1 if mismatches or errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
