import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
BACKEND_DIR = REPO_ROOT / "backend"
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from scripts.validate_service_topology import (  # noqa: E402
    EXPECTED_SERVICES,
    MAX_TOPOLOGY_DB_CONNECTION_BUDGET,
    SERVICE_DB_POOL_LIMITS,
    validate_topology,
)


def test_production_service_topology_is_complete_and_single_owner() -> None:
    assert len(EXPECTED_SERVICES) == 20
    assert set(SERVICE_DB_POOL_LIMITS) == set(EXPECTED_SERVICES)
    assert sum(size + overflow for size, overflow in SERVICE_DB_POOL_LIMITS.values()) <= MAX_TOPOLOGY_DB_CONNECTION_BUDGET
    assert validate_topology(REPO_ROOT) == []


def test_removed_embedded_owner_flags_cannot_be_reenabled() -> None:
    for relative_path in (
        "backend/app/main.py",
        "backend/app/services/admin_queries.py",
        "backend/.env.example",
    ):
        content = (REPO_ROOT / relative_path).read_text(encoding="utf-8")
        assert "ENABLE_WITHDRAW_WATCHER" not in content
        assert "ENABLE_DIVIDEND_JOB" not in content
