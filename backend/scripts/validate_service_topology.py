from __future__ import annotations

import argparse
import sys
from pathlib import Path


EXPECTED_SERVICES: dict[str, str] = {
    "exchange-api.service": "/opt/exchange-web/.venv/bin/python -m uvicorn app.main:app",
    "exchange-rq-email.service": "scripts/start_rq_worker.py email",
    "exchange-rq-withdraw.service": "scripts/start_rq_worker.py withdraw",
    "exchange-rq-payout.service": "scripts/start_rq_worker.py payout",
    "exchange-rq-release.service": "scripts/start_rq_worker.py release",
    "exchange-rq-tx-confirm.service": "scripts/start_rq_worker.py tx_confirm",
    "exchange-rq-collection.service": "scripts/start_rq_worker.py collection",
    "exchange-rq-gas.service": "scripts/start_rq_worker.py gas",
    "exchange-rq-maintenance.service": "scripts/start_rq_worker.py maintenance",
    "exchange-withdraw-fee-scheduler.service": "scripts/start_withdraw_fee_scheduler.py",
    "exchange-collection-auto-scheduler.service": "scripts/start_collection_auto_scheduler.py",
    "exchange-spot-match-worker.service": "scripts/start_spot_match_worker.py",
    "exchange-dealer-loop.service": "scripts/start_dealer_loop.py",
    "exchange-liquidation-scanner.service": "scripts/start_liquidation_scanner.py",
    "exchange-tp-sl-scanner.service": "scripts/start_tp_sl_scanner.py",
    "exchange-contract-limit-order-scanner.service": "scripts/start_contract_limit_order_scanner.py",
    "exchange-contract-accounting-reconciliation-scheduler.service": (
        "scripts/start_contract_accounting_reconciliation_scheduler.py"
    ),
}

SERVICE_DB_POOL_LIMITS: dict[str, tuple[int, int]] = {
    service_name: ((10, 10) if service_name == "exchange-api.service" else (2, 1))
    for service_name in EXPECTED_SERVICES
}
MAX_TOPOLOGY_DB_CONNECTION_BUDGET = 80

COMMON_REQUIRED_LINES = {
    "Type=simple",
    "WorkingDirectory=/opt/exchange-web/backend",
    "EnvironmentFile=/opt/exchange-web/backend/.env",
    "Environment=PYTHONUNBUFFERED=1",
    "User=exchange",
    "Group=exchange",
    "Restart=always",
    "RestartSec=5",
    "TimeoutStopSec=30",
    "KillSignal=SIGTERM",
    "KillMode=mixed",
    "StandardOutput=journal",
    "StandardError=journal",
    "NoNewPrivileges=true",
    "PrivateTmp=true",
    "ProtectSystem=full",
    "ProtectHome=true",
    "UMask=0027",
    "StartLimitIntervalSec=60",
    "StartLimitBurst=5",
    "PartOf=exchange-backend.target",
}

API_OWNER_GUARDS = {
    "Environment=EMBED_BACKGROUND_LOOPS_IN_API=0",
    "Environment=ENABLE_SPOT_AUTO_MATCH_IN_API=0",
    "Environment=ENABLE_CONTRACT_LIMIT_ORDER_JOB=0",
}


def _meaningful_lines(path: Path) -> list[str]:
    return [
        line.strip()
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.lstrip().startswith(("#", ";"))
    ]


def validate_topology(repo_root: Path) -> list[str]:
    errors: list[str] = []
    systemd_dir = repo_root / "deploy" / "systemd"
    target_path = systemd_dir / "exchange-backend.target"
    exec_starts: dict[str, str] = {}
    db_connection_budget = 0

    for service_name, expected_command in EXPECTED_SERVICES.items():
        path = systemd_dir / service_name
        if not path.is_file():
            errors.append(f"missing service unit: {service_name}")
            continue

        lines = _meaningful_lines(path)
        line_set = set(lines)
        for required_line in sorted(COMMON_REQUIRED_LINES - line_set):
            errors.append(f"{service_name}: missing {required_line}")

        pool_size, max_overflow = SERVICE_DB_POOL_LIMITS[service_name]
        expected_pool_lines = {
            f"Environment=DB_POOL_SIZE={pool_size}",
            f"Environment=DB_MAX_OVERFLOW={max_overflow}",
        }
        for required_line in sorted(expected_pool_lines - line_set):
            errors.append(f"{service_name}: missing role DB pool limit {required_line}")
        db_connection_budget += pool_size + max_overflow

        if not any(line == "Wants=network-online.target redis.service" for line in lines):
            errors.append(f"{service_name}: Redis must be an explicit Wants dependency")

        exec_lines = [line.removeprefix("ExecStart=") for line in lines if line.startswith("ExecStart=")]
        if len(exec_lines) != 1:
            errors.append(f"{service_name}: expected exactly one ExecStart, found {len(exec_lines)}")
            continue
        exec_start = exec_lines[0]
        exec_starts[service_name] = exec_start
        if expected_command not in exec_start:
            errors.append(f"{service_name}: unexpected ExecStart: {exec_start}")

    api_path = systemd_dir / "exchange-api.service"
    if api_path.is_file():
        api_lines = set(_meaningful_lines(api_path))
        for guard in sorted(API_OWNER_GUARDS - api_lines):
            errors.append(f"exchange-api.service: missing single-owner guard {guard}")

    command_owners: dict[str, list[str]] = {}
    for service_name, command in exec_starts.items():
        command_owners.setdefault(command, []).append(service_name)
    for command, owners in command_owners.items():
        if len(owners) > 1:
            errors.append(f"duplicate ExecStart owner {command}: {', '.join(sorted(owners))}")

    if db_connection_budget > MAX_TOPOLOGY_DB_CONNECTION_BUDGET:
        errors.append(
            "production DB connection budget exceeded: "
            f"{db_connection_budget} > {MAX_TOPOLOGY_DB_CONNECTION_BUDGET}"
        )

    if not target_path.is_file():
        errors.append("missing service group target: exchange-backend.target")
    else:
        target_lines = _meaningful_lines(target_path)
        wanted_services: set[str] = set()
        for line in target_lines:
            if line.startswith("Wants="):
                wanted_services.update(line.removeprefix("Wants=").split())
        missing_target_services = set(EXPECTED_SERVICES) - wanted_services
        for service_name in sorted(missing_target_services):
            errors.append(f"exchange-backend.target: missing Wants={service_name}")

    return errors


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Validate the production systemd service ownership and runtime hardening contract."
    )
    parser.add_argument(
        "--repo-root",
        type=Path,
        default=Path(__file__).resolve().parents[2],
        help="repository root containing deploy/systemd",
    )
    args = parser.parse_args(argv)

    repo_root = args.repo_root.resolve()
    errors = validate_topology(repo_root)
    if errors:
        print("service topology validation failed:", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        return 1

    print(
        "service topology validation passed: "
        f"{len(EXPECTED_SERVICES)} unique services, API embedded owners disabled, "
        f"DB budget {sum(size + overflow for size, overflow in SERVICE_DB_POOL_LIMITS.values())}, target complete"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
