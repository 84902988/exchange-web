from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest
import sqlalchemy as sa


SCRIPT_PATH = (
    Path(__file__).resolve().parents[1]
    / "scripts"
    / "apply_user_transfer_request_fingerprint_schema.py"
)


def _load_script():
    spec = importlib.util.spec_from_file_location(
        "apply_user_transfer_request_fingerprint_schema",
        SCRIPT_PATH,
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _build_database(revision: str = "20260728_000126") -> sa.Engine:
    engine = sa.create_engine("sqlite://")
    with engine.begin() as connection:
        connection.execute(
            sa.text("CREATE TABLE alembic_version (version_num VARCHAR(32) NOT NULL)")
        )
        connection.execute(
            sa.text("INSERT INTO alembic_version VALUES (:revision)"),
            {"revision": revision},
        )
        connection.execute(
            sa.text("CREATE TABLE user_transfers (id INTEGER PRIMARY KEY)")
        )
    return engine


def test_installer_previews_then_applies_hotfix_idempotently() -> None:
    script = _load_script()
    engine = _build_database()

    preview = script.apply_user_transfer_request_fingerprint_schema(
        engine,
        execute=False,
    )
    assert preview == {
        "ok": True,
        "executed": False,
        "revision_before": "20260728_000126",
        "revision_after": "20260728_000126",
        "actions": [
            "add user_transfers.request_fingerprint",
            "advance Alembic revision to 20260803_000133",
        ],
    }

    applied = script.apply_user_transfer_request_fingerprint_schema(
        engine,
        execute=True,
    )
    assert applied["revision_after"] == "20260803_000133"
    assert script.apply_user_transfer_request_fingerprint_schema(
        engine,
        execute=True,
    )["actions"] == []

    with engine.begin() as connection:
        assert connection.execute(
            sa.text("SELECT version_num FROM alembic_version")
        ).scalar_one() == "20260803_000133"
        column = next(
            item
            for item in sa.inspect(connection).get_columns("user_transfers")
            if item["name"] == "request_fingerprint"
        )
        assert isinstance(column["type"], sa.String)
        assert column["type"].length == 64
        assert column["nullable"] is True


def test_installer_rejects_an_unrelated_revision() -> None:
    script = _load_script()
    engine = _build_database("20260802_000132")

    with pytest.raises(RuntimeError, match="unsupported Alembic revision"):
        script.apply_user_transfer_request_fingerprint_schema(
            engine,
            execute=False,
        )
