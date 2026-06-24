from __future__ import annotations

import os
import sys
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable

from sqlalchemy.orm import Session


BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.core.security import hash_password  # noqa: E402
from app.db.models import AdminPermission, AdminRole, AdminRolePermission, AdminUser, AdminUserRole  # noqa: E402
from app.db.session import SessionLocal  # noqa: E402


ADMIN_STATUS_ACTIVE = "ACTIVE"
SUPER_ADMIN_ROLE_CODE = "super_admin"
DEFAULT_ADMIN_USERNAME = "admin"


PERMISSIONS: tuple[dict[str, str], ...] = (
    {"code": "dashboard.view", "name": "Dashboard View", "group_code": "dashboard"},
    {"code": "users.view", "name": "Users View", "group_code": "users"},
    {"code": "assets.view", "name": "Assets View", "group_code": "funds"},
    {"code": "balance_logs.view", "name": "Balance Logs View", "group_code": "funds"},
    {"code": "deposit_records.view", "name": "Deposit Records View", "group_code": "funds"},
    {"code": "withdraw_records.view", "name": "Withdraw Records View", "group_code": "funds"},
    {"code": "withdraw_anomalies.view", "name": "提现异常治理查看", "group_code": "funds"},
    {"code": "withdraw_reviews.view", "name": "Withdraw Reviews View", "group_code": "funds"},
    {"code": "user_transfers.view", "name": "User Transfers View", "group_code": "funds"},
    {"code": "orders.view", "name": "Orders View", "group_code": "trading"},
    {"code": "trades.view", "name": "Trades View", "group_code": "trading"},
    {"code": "market_analysis.view", "name": "Market Analysis View", "group_code": "trading"},
    {"code": "fee_settings.manage", "name": "现货手续费配置", "group_code": "trading"},
    {"code": "contract_orders.view", "name": "Contract Orders View", "group_code": "trading"},
    {"code": "contract_trades.view", "name": "Contract Trades View", "group_code": "trading"},
    {"code": "contract_positions.view", "name": "Contract Positions View", "group_code": "trading"},
    {"code": "contract_accounts.view", "name": "Contract Accounts View", "group_code": "trading"},
    {"code": "contract_liquidations.view", "name": "Contract Liquidations View", "group_code": "risk"},
    {"code": "trading_pairs.manage", "name": "Trading Pairs Manage", "group_code": "trading"},
    {"code": "contract_symbols.manage", "name": "Contract Symbols Manage", "group_code": "trading"},
    {"code": "asset_configs.manage", "name": "Asset Configs Manage", "group_code": "funds"},
    {"code": "platform_accounts.view", "name": "Platform Accounts View", "group_code": "funds"},
    {"code": "platform_adjust.manage", "name": "Platform Adjust Manage", "group_code": "funds"},
    {"code": "collection_tasks.manage", "name": "归集任务管理", "group_code": "funds"},
    {"code": "gas_tasks.manage", "name": "Gas任务管理", "group_code": "funds"},
    {"code": "dealer_risk.manage", "name": "Dealer Risk Manage", "group_code": "risk"},
    {"code": "vip.view", "name": "VIP View", "group_code": "users"},
    {"code": "dividend.view", "name": "Dividend View", "group_code": "users"},
    {"code": "dividends.distribute", "name": "分红发放", "group_code": "business"},
    {"code": "bd.view", "name": "BD View", "group_code": "users"},
    {"code": "bd_accounts.manage", "name": "BD账号与审核管理", "group_code": "business"},
    {"code": "bd_commissions.manage", "name": "BD佣金发放", "group_code": "business"},
    {"code": "invite.view", "name": "Invite View", "group_code": "users"},
    {"code": "invite_commissions.manage", "name": "邀请佣金发放", "group_code": "business"},
    {"code": "stock_locks.view", "name": "Stock Locks View", "group_code": "users"},
    {"code": "stock_locks.manage", "name": "股票锁仓管理", "group_code": "business"},
    {"code": "site_settings.manage", "name": "Site Settings Manage", "group_code": "system"},
    {"code": "banners.manage", "name": "Banners Manage", "group_code": "system"},
    {"code": "announcements.manage", "name": "Announcements Manage", "group_code": "system"},
    {"code": "site_content.manage", "name": "站点配置、Banner、公告、运营内容管理", "group_code": "system"},
    {"code": "support_tickets.manage", "name": "支持工单管理", "group_code": "users"},
    {"code": "audit.view", "name": "Audit View", "group_code": "system"},
    {"code": "admin_users.manage", "name": "管理员账号管理", "group_code": "system"},
    {"code": "admin_roles.manage", "name": "角色权限管理", "group_code": "system"},
    {"code": "export_tasks.view", "name": "Export Tasks View", "group_code": "system"},
    {"code": "withdraw_reviews.manage", "name": "提现审核管理", "group_code": "funds"},
)


def _upsert_super_admin_role(db: Session, now: datetime) -> tuple[AdminRole, bool]:
    role = db.query(AdminRole).filter(AdminRole.code == SUPER_ADMIN_ROLE_CODE).first()
    created = role is None
    if role is None:
        role = AdminRole(code=SUPER_ADMIN_ROLE_CODE, created_at=now)
        db.add(role)

    role.name = "Super Administrator"
    role.description = "System role with all admin permissions."
    role.is_system = True
    role.status = ADMIN_STATUS_ACTIVE
    role.updated_at = now
    db.flush()
    return role, created


def _upsert_permissions(db: Session, permission_items: Iterable[dict[str, str]], now: datetime) -> tuple[list[AdminPermission], int, int]:
    permissions: list[AdminPermission] = []
    inserted = 0
    updated = 0

    for item in permission_items:
        permission = db.query(AdminPermission).filter(AdminPermission.code == item["code"]).first()
        if permission is None:
            permission = AdminPermission(code=item["code"], created_at=now)
            db.add(permission)
            inserted += 1
        else:
            updated += 1

        permission.name = item["name"]
        permission.group_code = item["group_code"]
        permission.description = item.get("description")
        permission.updated_at = now
        permissions.append(permission)

    db.flush()
    return permissions, inserted, updated


def _ensure_role_permissions(db: Session, role: AdminRole, permissions: Iterable[AdminPermission], now: datetime) -> int:
    existing_permission_ids = {
        row.permission_id
        for row in db.query(AdminRolePermission.permission_id).filter(AdminRolePermission.role_id == role.id).all()
    }
    inserted = 0

    for permission in permissions:
        if permission.id in existing_permission_ids:
            continue
        db.add(AdminRolePermission(role_id=role.id, permission_id=permission.id, created_at=now))
        inserted += 1

    db.flush()
    return inserted


def _ensure_default_admin(db: Session, role: AdminRole, now: datetime) -> dict[str, Any]:
    admin = db.query(AdminUser).filter(AdminUser.username == DEFAULT_ADMIN_USERNAME).first()
    password = os.getenv("ADMIN_INITIAL_PASSWORD")
    created = False
    password_skipped = False

    if admin is None:
        if not password:
            return {
                "admin": None,
                "created": False,
                "password_skipped": True,
                "role_bound": False,
            }
        admin = AdminUser(
            username=DEFAULT_ADMIN_USERNAME,
            password_hash=hash_password(password),
            display_name="Administrator",
            status=ADMIN_STATUS_ACTIVE,
            created_at=now,
            updated_at=now,
        )
        db.add(admin)
        db.flush()
        created = True
    else:
        admin.display_name = admin.display_name or "Administrator"
        admin.status = admin.status or ADMIN_STATUS_ACTIVE
        admin.updated_at = now
        db.flush()
        password_skipped = True

    existing_link = (
        db.query(AdminUserRole)
        .filter(AdminUserRole.admin_user_id == admin.id, AdminUserRole.role_id == role.id)
        .first()
    )
    role_bound = existing_link is None
    if existing_link is None:
        db.add(AdminUserRole(admin_user_id=admin.id, role_id=role.id, created_at=now))
        db.flush()

    return {
        "admin": admin,
        "created": created,
        "password_skipped": password_skipped,
        "role_bound": role_bound,
    }


def seed_admin_rbac() -> None:
    db = SessionLocal()
    try:
        now = datetime.utcnow()
        role, role_created = _upsert_super_admin_role(db, now)
        permissions, permissions_inserted, permissions_updated = _upsert_permissions(db, PERMISSIONS, now)
        role_permissions_inserted = _ensure_role_permissions(db, role, permissions, now)
        admin_result = _ensure_default_admin(db, role, now)
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()

    if admin_result["password_skipped"] and admin_result["admin"] is None:
        print("ADMIN_INITIAL_PASSWORD is not set; default admin account was not created.")
    elif admin_result["created"]:
        print("Default admin account created from ADMIN_INITIAL_PASSWORD.")
    else:
        print("Default admin account already exists; password was not overwritten.")

    print(
        "Seeded admin RBAC: "
        f"role_created={int(role_created)}, "
        f"permissions_inserted={permissions_inserted}, "
        f"permissions_updated={permissions_updated}, "
        f"role_permissions_inserted={role_permissions_inserted}, "
        f"default_admin_role_bound={int(admin_result['role_bound'])}"
    )


if __name__ == "__main__":
    seed_admin_rbac()
