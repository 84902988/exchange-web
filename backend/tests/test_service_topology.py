import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
BACKEND_DIR = REPO_ROOT / "backend"
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from scripts.validate_service_topology import EXPECTED_SERVICES, validate_topology  # noqa: E402


def test_production_service_topology_is_complete_and_single_owner() -> None:
    assert len(EXPECTED_SERVICES) == 17
    assert validate_topology(REPO_ROOT) == []
