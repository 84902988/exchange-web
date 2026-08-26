from pathlib import Path

from alembic.config import Config
from alembic.migration import MigrationContext
from alembic.operations import Operations
from alembic.script import ScriptDirectory
from sqlalchemy import create_engine, text


def test_kyc_admin_permissions_migration_is_least_privilege_and_reversible() -> None:
    backend_dir = Path(__file__).resolve().parents[1]
    config = Config(str(backend_dir / "alembic.ini"))
    config.set_main_option("script_location", str(backend_dir / "alembic"))
    revision = ScriptDirectory.from_config(config).get_revision("20260802_000132")
    assert revision is not None
    assert revision.down_revision == "20260802_000131"

    engine = create_engine("sqlite://")
    with engine.begin() as connection:
        connection.execute(text("""
            CREATE TABLE admin_permissions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                code VARCHAR(100) NOT NULL UNIQUE,
                name VARCHAR(100) NOT NULL,
                group_code VARCHAR(64) NOT NULL,
                description VARCHAR(500),
                created_at DATETIME NOT NULL,
                updated_at DATETIME NOT NULL
            )
        """))
        connection.execute(text("""
            CREATE TABLE admin_roles (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                code VARCHAR(64) NOT NULL UNIQUE
            )
        """))
        connection.execute(text("""
            CREATE TABLE admin_role_permissions (
                role_id INTEGER NOT NULL,
                permission_id INTEGER NOT NULL,
                created_at DATETIME NOT NULL,
                UNIQUE (role_id, permission_id)
            )
        """))
        connection.execute(text("""
            INSERT INTO admin_permissions
                (code, name, group_code, description, created_at, updated_at)
            VALUES
                ('users.view', '用户查看', 'users', '', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        """))
        connection.execute(text("INSERT INTO admin_roles (code) VALUES ('reviewer'), ('super_admin')"))
        connection.execute(text("""
            INSERT INTO admin_role_permissions (role_id, permission_id, created_at)
            SELECT role.id, permission.id, CURRENT_TIMESTAMP
            FROM admin_roles role
            JOIN admin_permissions permission ON permission.code = 'users.view'
            WHERE role.code = 'reviewer'
        """))

        operations = Operations(MigrationContext.configure(connection))
        original_op = revision.module.op
        revision.module.op = operations
        try:
            revision.module.upgrade()
            permissions = set(connection.execute(text("SELECT code FROM admin_permissions")).scalars())
            reviewer_permissions = set(connection.execute(text("""
                SELECT permission.code
                FROM admin_role_permissions link
                JOIN admin_roles role ON role.id = link.role_id
                JOIN admin_permissions permission ON permission.id = link.permission_id
                WHERE role.code = 'reviewer'
            """)).scalars())
            super_permissions = set(connection.execute(text("""
                SELECT permission.code
                FROM admin_role_permissions link
                JOIN admin_roles role ON role.id = link.role_id
                JOIN admin_permissions permission ON permission.id = link.permission_id
                WHERE role.code = 'super_admin'
            """)).scalars())

            assert {"users.view", "kyc.view", "kyc.manage"} <= permissions
            assert "kyc.view" in reviewer_permissions
            assert "kyc.manage" not in reviewer_permissions
            assert "kyc.manage" in super_permissions

            revision.module.downgrade()
            remaining = set(connection.execute(text("SELECT code FROM admin_permissions")).scalars())
            assert remaining == {"users.view"}
        finally:
            revision.module.op = original_op
