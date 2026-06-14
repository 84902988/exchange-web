from __future__ import annotations

from datetime import datetime
from typing import List, Optional

from sqlalchemy import BigInteger, Boolean, DateTime, ForeignKey, Index, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base


class AdminUser(Base):
    __tablename__ = "admin_users"
    __table_args__ = (
        UniqueConstraint("username", name="uq_admin_users_username"),
        Index("idx_admin_users_status", "status"),
        Index("idx_admin_users_email", "email"),
        {"extend_existing": True},
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    username: Mapped[str] = mapped_column(String(64), nullable=False)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    display_name: Mapped[str] = mapped_column(String(100), nullable=False)
    email: Mapped[Optional[str]] = mapped_column(String(191), nullable=True)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="ACTIVE")
    last_login_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow)

    role_links: Mapped[List["AdminUserRole"]] = relationship(
        "AdminUserRole",
        back_populates="admin_user",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )


class AdminRole(Base):
    __tablename__ = "admin_roles"
    __table_args__ = (
        UniqueConstraint("code", name="uq_admin_roles_code"),
        Index("idx_admin_roles_status", "status"),
        Index("idx_admin_roles_is_system", "is_system"),
        {"extend_existing": True},
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    code: Mapped[str] = mapped_column(String(64), nullable=False)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    description: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    is_system: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="ACTIVE")
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow)

    user_links: Mapped[List["AdminUserRole"]] = relationship(
        "AdminUserRole",
        back_populates="role",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
    permission_links: Mapped[List["AdminRolePermission"]] = relationship(
        "AdminRolePermission",
        back_populates="role",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )


class AdminPermission(Base):
    __tablename__ = "admin_permissions"
    __table_args__ = (
        UniqueConstraint("code", name="uq_admin_permissions_code"),
        Index("idx_admin_permissions_group_code", "group_code"),
        {"extend_existing": True},
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    code: Mapped[str] = mapped_column(String(100), nullable=False)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    group_code: Mapped[str] = mapped_column(String(64), nullable=False)
    description: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow)

    role_links: Mapped[List["AdminRolePermission"]] = relationship(
        "AdminRolePermission",
        back_populates="permission",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )


class AdminUserRole(Base):
    __tablename__ = "admin_user_roles"
    __table_args__ = (
        UniqueConstraint("admin_user_id", "role_id", name="uq_admin_user_roles_user_role"),
        Index("idx_admin_user_roles_admin_user_id", "admin_user_id"),
        Index("idx_admin_user_roles_role_id", "role_id"),
        {"extend_existing": True},
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    admin_user_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("admin_users.id", name="fk_admin_user_roles_admin_user", ondelete="CASCADE"),
        nullable=False,
    )
    role_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("admin_roles.id", name="fk_admin_user_roles_role", ondelete="CASCADE"),
        nullable=False,
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)

    admin_user: Mapped["AdminUser"] = relationship("AdminUser", back_populates="role_links")
    role: Mapped["AdminRole"] = relationship("AdminRole", back_populates="user_links")


class AdminRolePermission(Base):
    __tablename__ = "admin_role_permissions"
    __table_args__ = (
        UniqueConstraint("role_id", "permission_id", name="uq_admin_role_permissions_role_permission"),
        Index("idx_admin_role_permissions_role_id", "role_id"),
        Index("idx_admin_role_permissions_permission_id", "permission_id"),
        {"extend_existing": True},
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    role_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("admin_roles.id", name="fk_admin_role_permissions_role", ondelete="CASCADE"),
        nullable=False,
    )
    permission_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("admin_permissions.id", name="fk_admin_role_permissions_permission", ondelete="CASCADE"),
        nullable=False,
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.utcnow)

    role: Mapped["AdminRole"] = relationship("AdminRole", back_populates="permission_links")
    permission: Mapped["AdminPermission"] = relationship("AdminPermission", back_populates="role_links")
