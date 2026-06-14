from __future__ import annotations

from pathlib import Path
import sys

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.db.session import SessionLocal
from app.services.withdraw_anomaly_service import query_withdraw_anomalies


def main() -> int:
    db = SessionLocal()
    try:
        result = query_withdraw_anomalies(db, limit=100)

        print("withdraw_fee_ledger_issues")
        for item in result["fee_issues"]:
            print(
                f"id={item['withdraw_id']} user_id={item['user_id']} coin={item['coin_symbol']} "
                f"chain={item['chain_key']} amount={item['amount']} fee={item['fee']} "
                f"net_amount={item['net_amount']} status={item['status']} "
                f"frozen_remaining={item['frozen_remaining']} suggestion={item['suggestion']}"
            )

        print("withdraw_failed_frozen_candidates")
        for item in result["failed_frozen_candidates"]:
            suggestion = "candidate_for_admin_release_if_chain_not_broadcast"
            print(
                f"id={item['withdraw_id']} user_id={item['user_id']} coin={item['coin_symbol']} "
                f"chain={item['chain_key']} amount={item['amount']} fee={item['fee']} "
                f"net_amount={item['net_amount']} status={item['status']} "
                f"tx_hash={item['tx_hash'] or '-'} frozen_remaining={item['frozen_remaining']} "
                f"suggestion={suggestion}"
            )

        summary = result["summary"]
        print(
            "summary "
            f"fee_issues={summary['fee_issue_count']} "
            f"failed_frozen_candidates={summary['failed_frozen_count']} "
            f"precheck_failures={summary['precheck_failure_count']} "
            f"amount_net_mismatch={summary['amount_net_mismatch_count']}"
        )
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())
