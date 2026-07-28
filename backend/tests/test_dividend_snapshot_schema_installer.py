from __future__ import annotations

import importlib.util
from pathlib import Path

import sqlalchemy as sa


SCRIPT_PATH = (
    Path(__file__).resolve().parents[1]
    / "scripts"
    / "apply_dividend_snapshot_schema.py"
)


def _load_script():
    spec = importlib.util.spec_from_file_location(
        "apply_dividend_snapshot_schema",
        SCRIPT_PATH,
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_schema_installer_is_dry_run_first_and_idempotent() -> None:
    script = _load_script()
    engine = sa.create_engine("sqlite://")
    with engine.begin() as connection:
        connection.execute(
            sa.text(
                "CREATE TABLE alembic_version (version_num VARCHAR(32) NOT NULL)"
            )
        )
        connection.execute(
            sa.text(
                "INSERT INTO alembic_version (version_num) VALUES (:revision)"
            ),
            {"revision": script.EXPECTED_REVISION},
        )
        connection.execute(
            sa.text(
                """
                CREATE TABLE dividend_pools (
                    id INTEGER PRIMARY KEY,
                    dividend_date DATE NOT NULL,
                    rcb_price_used NUMERIC(36, 18) NOT NULL
                )
                """
            )
        )

    dry_run = script.apply_dividend_snapshot_schema(engine, execute=False)
    assert dry_run["executed"] is False
    assert dry_run["revision_after"] == script.EXPECTED_REVISION
    assert len(dry_run["actions"]) == 6

    applied = script.apply_dividend_snapshot_schema(engine, execute=True)
    assert applied["executed"] is True
    assert applied["revision_after"] == script.TARGET_REVISION

    repeated = script.apply_dividend_snapshot_schema(engine, execute=True)
    assert repeated["executed"] is True
    assert repeated["revision_after"] == script.TARGET_REVISION
    assert repeated["actions"] == []


def test_schema_installer_rejects_unexpected_revision() -> None:
    script = _load_script()
    engine = sa.create_engine("sqlite://")
    with engine.begin() as connection:
        connection.execute(
            sa.text(
                "CREATE TABLE alembic_version (version_num VARCHAR(32) NOT NULL)"
            )
        )
        connection.execute(
            sa.text("INSERT INTO alembic_version (version_num) VALUES ('unexpected')")
        )
        connection.execute(
            sa.text(
                """
                CREATE TABLE dividend_pools (
                    id INTEGER PRIMARY KEY,
                    dividend_date DATE NOT NULL,
                    rcb_price_used NUMERIC(36, 18) NOT NULL
                )
                """
            )
        )

    try:
        script.apply_dividend_snapshot_schema(engine, execute=False)
    except RuntimeError as exc:
        assert "unsupported Alembic revision" in str(exc)
    else:
        raise AssertionError("unexpected revision must fail closed")
