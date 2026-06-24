from __future__ import annotations

import logging
import asyncio
import base64
import html
import io
import json
import os
import secrets
import shutil
import subprocess
import uuid
from datetime import date, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Dict, Optional
from urllib.parse import parse_qsl, quote, unquote, urlencode, urlsplit, urlunsplit

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, Response, StreamingResponse
from fastapi.routing import APIRoute
from fastapi.templating import Jinja2Templates
from passlib.exc import UnknownHashError
from sqlalchemy import func, text
from sqlalchemy.exc import OperationalError, ProgrammingError
from sqlalchemy.orm import Session

from app.core.chain_capabilities import CONFIG_ONLY, EVM, READY, get_chain_capability, get_chain_runtime_status
from app.core.config import settings
from app.core.redis import get_redis
from app.core.request_utils import get_client_ip, get_user_agent
from app.core.security import verify_password
from app.db.models.collection import CollectionTask, CollectionTaskStatus, GasTask, GasTaskStatus
from app.db.models.bd_commission_record import BdCommissionRecord
from app.db.models.user_invite_commission_record import UserInviteCommissionRecord
from app.db.models.geo_access import GeoAccessLog, GeoIpRule
from app.db.models.db_lifecycle_cleanup_log import DbLifecycleCleanupLog
from app.db.models.core_archive import CoreArchiveBatch
from app.db.models import AdminUser, User
from app.db.session import SessionLocal, get_db
from app.services.admin_balance_adjust_service import (
    AdminBalanceAdjustError,
    adjust_platform_available_balance,
)
from app.services.hot_wallet_monitor_service import (
    hot_wallet_monitor_item_payload,
    query_hot_wallet_monitor,
    refresh_hot_wallet_monitor_item,
)
from app.services.deposit_tx_confirm_service import recheck_deposit_chain_confirmation
from app.services.admin_queries import (
    PLATFORM_ACCOUNT_USER_ID,
    admin_create_reference_overlay,
    admin_create_contract_symbol,
    admin_create_asset_chain_config,
    admin_create_asset_config,
    admin_create_chain_config,
    admin_create_stock_token_lock_config,
    admin_create_pair,
    admin_delete_admin_role,
    admin_delete_pair,
    admin_delete_asset_chain_config,
    admin_delete_asset_config,
    admin_delete_chain_config,
    admin_get_contract_symbol,
    admin_get_dealer_risk_limit,
    admin_get_pair_asset_options,
    admin_get_pair_detail,
    admin_get_reference_overlay,
    admin_get_stock_token_lock_config,
    admin_get_stock_token_lock_detail,
    admin_create_admin_user,
    admin_create_admin_role,
    admin_get_all_role_permission_ids,
    admin_get_current_admin_rbac_context,
    admin_list_active_roles,
    admin_list_permissions_by_group,
    admin_query_admin_users,
    admin_query_admin_roles,
    admin_query_balance_logs,
    admin_query_unified_balance_logs,
    admin_query_vip_fee_preferences,
    admin_query_vip_levels,
    admin_query_vip_users,
    get_admin_chain_health,
    admin_query_asset_configs,
    admin_query_audit_logs,
    admin_query_bd_applications,
    admin_query_bd_team_detail,
    admin_query_bd_commission_job_logs,
    admin_restore_bd_application_account,
    admin_revoke_bd_application_account,
    admin_query_contract_symbols,
    admin_query_deposit_records,
    admin_query_market_analysis_pairs,
    admin_query_orders,
    admin_query_dealer_risk_hit_logs,
    admin_query_dealer_risk_limits,
    admin_get_dividend_pool_detail,
    admin_query_dividend_config_rules,
    admin_query_dividend_job_logs,
    admin_query_dividend_pools,
    admin_query_dividend_stats,
    admin_toggle_vip_fee_level_enabled,
    admin_update_vip_fee_level_rule,
    admin_query_pairs,
    admin_query_operations_center,
    admin_query_reference_overlays,
    admin_query_rq_status,
    admin_query_service_overview,
    admin_query_platform_adjust_logs,
    admin_query_platform_balances,
    admin_query_stock_token_locks,
    admin_query_stock_token_lock_configs,
    admin_query_stock_token_release_logs,
    admin_query_trades,
    admin_query_user_transfer_records,
    admin_query_withdraw_reviews,
    admin_query_withdraw_records,
    admin_query_withdraw_anomalies,
    admin_release_unbroadcast_withdraw_frozen,
    admin_review_withdraw,
    admin_reset_admin_user_password,
    admin_save_dealer_risk_limit,
    admin_set_admin_user_status,
    admin_update_admin_role,
    admin_update_admin_role_permissions,
    admin_user_is_super_admin,
    admin_toggle_dealer_risk_enabled,
    admin_toggle_dealer_risk_status,
    admin_toggle_contract_symbol_status,
    admin_toggle_pair_status,
    admin_toggle_reference_overlay_enabled,
    admin_toggle_stock_token_lock_config_active,
    admin_sync_chain_withdraw_fee,
    admin_update_asset_chain_config,
    admin_update_asset_config,
    admin_update_chain_config,
    admin_update_contract_symbol,
    admin_update_stock_token_lock_config,
    admin_update_pair,
    admin_update_reference_overlay,
    get_admin_balances,
    get_admin_users,
    admin_query_user_invite_relations,
    get_bd_commission_records,
    admin_query_funds_dashboard,
    admin_query_collection_batch_detail,
    admin_query_collection_auto_settings,
    save_collection_auto_rule_config,
    admin_add_manual_collection_candidate,
    admin_update_collection_tool_candidate_row,
    admin_query_collection_candidate_workbench,
    admin_query_collection_center_filters,
    admin_query_collection_center_snapshot,
    admin_query_collection_center_stats,
    admin_query_collection_gas_cost_stats,
    admin_query_collection_tool_results,
    admin_query_risk_dashboard,
    admin_query_trading_dashboard,
    get_admin_date_time_window,
    get_admin_today_date,
    admin_create_collection_batch_from_candidates,
    admin_create_collection_batch_from_verified_candidates,
    get_dashboard_metrics,
    get_user_invite_commission_records,
    get_user_invite_commission_summary,
    is_collection_task_retryable,
    list_admin_contract_accounts,
    list_admin_contract_liquidations,
    list_admin_contract_orders,
    list_admin_contract_positions,
    list_admin_contract_trades,
    list_collection_batches,
    list_collection_tasks,
    list_gas_tasks,
    AdminWithdrawUnfreezeError,
    WithdrawReviewError,
)
from app.services.bd_application_service import (
    BdApplicationReviewError,
    approve_bd_application,
    reject_bd_application,
)
from app.services.bd_commission_service import pay_bd_commission_record
from app.services.bd_team_query import (
    BdAccountStatusUpdateError,
    get_admin_bd_team_stats,
    update_bd_account_status,
)
from app.services.collection_send_helper import is_collection_real_send_enabled
from app.services.collection_send_guard import validate_collection_send_allowed
from app.services.collection_gas_config_service import (
    CollectionGasConfigError,
    reset_gas_topup_config,
    save_gas_topup_config,
)
from app.services.collection_service import create_gas_task, mark_collection_task_wait_gas, safe_cancel_collection_task
from app.services.collection_candidate_scanner import (
    ScanResult,
    admin_create_collection_tasks,
    admin_preview_collection_candidates,
)
from app.services.collection_chain_helper import compute_min_collect_amount, get_native_gas_coin_symbol
from app.services.chain_preflight_service import run_chain_preflight
from app.services.dividend_service import (
    calculate_dividend_pool,
    create_dividend_pool_skeleton,
    distribute_dividend_pool,
    get_dividend_config,
    set_dividend_rcb_price_snapshot_time,
    set_dividend_run_time,
)
from app.jobs.dividend_job import process_dividend_job_for_date
from app.jobs.db_lifecycle_cleanup_job import (
    OPERATION_MODE_EXECUTE,
    RISK_LEVEL_REAL_DELETE,
    PROTECTED_TABLES,
    can_execute_cleanup,
    core_financial_table_rows,
)
from app.services.market_cache_metrics import get_market_cache_metrics_snapshot
from app.services.reference_overlay_sync_service import sync_reference_overlay_once
from app.services.spot_fee_settings_service import (
    SpotFeeSettingsError,
    load_spot_fee_settings,
    update_spot_fee_settings,
)
from app.services.contract_market_provider_service import (
    admin_list_contract_market_providers,
    admin_update_contract_market_provider,
    classify_market_provider_error,
    test_contract_market_provider_connection,
)
from app.services.geo_access_service import (
    GEO_ACCESS_LOG_RETENTION_DAYS,
    RULE_ALLOW,
    RULE_BLOCK,
    create_geo_ip_rule,
    delete_geo_ip_rule,
    get_or_create_geo_access_settings,
    parse_country_list,
    set_geo_ip_rule_enabled,
    update_geo_access_settings,
)
from app.services.moralis_service import add_address_to_streams
from app.services.stock_token_lock_service import (
    StockTokenLockError,
    force_release_stock_token_lock,
    record_stock_token_release_log,
    release_stock_token_locks,
)
from app.services.site_content_service import (
    ANNOUNCEMENT_CATEGORY_OPTIONS,
    admin_about_page_form,
    admin_announcement_form_from_payload,
    admin_banner_form_from_payload,
    admin_legal_pages_form,
    admin_create_announcement,
    admin_create_home_banner,
    admin_delete_home_banner,
    admin_get_announcement,
    admin_get_home_banner,
    admin_query_announcements,
    admin_query_home_banners,
    admin_site_settings_form,
    admin_toggle_announcement_status,
    admin_toggle_home_banner_status,
    admin_update_announcement,
    admin_update_home_banner,
    get_or_create_site_settings,
    update_about_page_sections,
    update_legal_pages,
    update_site_settings,
)
from app.services.help_content_service import (
    admin_create_help_article,
    admin_create_help_category,
    admin_get_help_article,
    admin_get_help_category,
    admin_help_article_form_from_payload,
    admin_help_category_form_from_payload,
    admin_list_help_category_options,
    admin_query_help_articles,
    admin_query_help_categories,
    admin_toggle_help_article_enabled,
    admin_toggle_help_article_hot,
    admin_toggle_help_category_enabled,
    admin_update_help_article,
    admin_update_help_category,
)
from app.services.support_ticket_service import (
    SUPPORT_TICKET_CATEGORIES,
    SUPPORT_TICKET_STATUS_OPTIONS,
    admin_get_support_ticket,
    admin_query_support_tickets,
    admin_reply_support_ticket,
    admin_update_support_ticket_status,
)
from app.services.user_withdraw_lock_service import (
    DEFAULT_WITHDRAW_LOCK_REASON,
    set_user_withdraw_lock,
)
from app.services.user_invite_commission_service import pay_user_invite_commission_record
from app.services.user_invite_service import (
    get_user_invite_commission_config,
    update_user_invite_commission_rate,
)
from app.services.collection_candidate_scanner import (
    finalize_tool_scan_snapshot,
    prepare_collection_tool_scan_progress,
    write_candidate_verify_status,
)
from app.services.collection_center_events import (
    COLLECTION_CENTER_EVENT_STREAM,
    collection_center_event_matches_filters,
    decode_collection_center_stream_entries,
    publish_collection_center_event,
)
from app.core.rq import get_redis_connection
from app.jobs.withdraw_fee_maintenance_rq_job import enqueue_withdraw_fee_maintenance_job
from app.tasks.bd_commission_tasks import enqueue_pay_bd_commission
from app.tasks.collection_tasks import (
    enqueue_collection_center_scan,
    enqueue_collection_task,
    enqueue_gas_task,
    enqueue_tx_confirm_collection_task,
    enqueue_tx_confirm_gas_task,
    is_collection_task_job_active,
    is_gas_task_job_active,
    process_collection_task,
    process_gas_task,
)
from app.tasks.user_invite_commission_tasks import enqueue_pay_user_invite_commission


ADMIN_DOC_TAGS = {
    "admin": "ADMIN 后台管理 / Admin",
    "activity": "ACTIVITY 活动管理 / Activity",
    "asset": "ASSET 资产配置 / Asset",
    "bd": "BD 商务管理 / BD",
    "collection": "COLLECTION 归集管理 / Collection",
    "contract": "CONTRACT 合约管理 / Contract",
    "dashboard": "DASHBOARD 数据看板 / Dashboard",
    "dividend": "DIVIDEND 分红管理 / Dividend",
    "funds": "FUNDS 资金流水 / Funds",
    "invite": "INVITE 邀请返佣 / Invite",
    "market": "MARKET 行情市场 / Market",
    "platform": "PLATFORM 平台账户 / Platform",
    "risk": "RISK 风控管理 / Risk",
    "system": "SYSTEM 系统运维 / System",
    "trade": "TRADE 交易订单 / Trade",
    "user": "USER 用户管理 / User",
    "vip": "VIP 费率等级 / VIP",
    "withdraw": "WITHDRAW 提现审核 / Withdraw",
}

ADMIN_DOC_RESOURCE_LABELS: tuple[tuple[str, str, str], ...] = (
    ("/uploads/image", "通用图片上传", "upload shared admin image"),
    ("/asset-configs/upload-asset-icon", "资产图标上传", "upload asset icon"),
    ("/login", "后台登录", "admin login"),
    ("/logout", "后台退出登", "admin logout"),
    ("/dashboard", "后台总览看板", "admin overview dashboard"),
    ("/funds-dashboard", "资金看板", "funds dashboard"),
    ("/trading-dashboard", "交易看板", "trading dashboard"),
    ("/risk-dashboard", "风控看板", "risk dashboard"),
    ("/admin-users", "后台账号", "admin user"),
    ("/admin-roles", "后台角色", "admin role"),
    ("/users", "用户", "user"),
    ("/assets", "资产列表", "asset list"),
    ("/deposit-records", "充值记", "deposit record"),
    ("/withdraw-records", "提现记录", "withdraw record"),
    ("/withdraw-anomalies", "提现异常", "withdraw anomaly"),
    ("/withdraw-reviews", "提现审核", "withdraw review"),
    ("/user-transfers", "用户划转", "user transfer"),
    ("/balance-logs", "余额流水", "balance log"),
    ("/collections/auto-settings", "自动归集设置", "auto collection settings"),
    ("/collections/center", "归集中心", "collection center"),
    ("/collections/tools", "归集工具", "collection tool workbench"),
    ("/collection/manual", "手动归集", "manual collection"),
    ("/collections/tasks", "归集任务", "collection task"),
    ("/collections/batches", "归集批次", "collection batch"),
    ("/collections/records", "归集记录", "collection record"),
    ("/collections/gas-costs", "归集 Gas 成本统计", "collection gas cost stats"),
    ("/asset-configs/chains", "链配", "chain config"),
    ("/asset-configs/asset-chains", "资产链配", "asset-chain config"),
    ("/asset-configs/assets", "资产配置", "asset config"),
    ("/asset-configs", "资产配置中心", "asset config center"),
    ("/chain-health", "链路健康", "chain health"),
    ("/hot-wallets", "热钱包监", "hot wallet monitor"),
    ("/orders", "订单", "order"),
    ("/trades", "成交", "trade"),
    ("/spot-fee-settings", "现货费率设置", "spot fee settings"),
    ("/market-cache-monitor", "行情缓存监控", "market cache monitor"),
    ("/market-analysis/pairs", "行情交易对分", "market pair analysis"),
    ("/market-analysis", "行情分析", "market analysis"),
    ("/system/operations", "运营中心", "operations center"),
    ("/system/rq", "RQ 队列状", "RQ queue status"),
    ("/system/services", "服务概览", "service overview"),
    ("/system/db-lifecycle", "DB 生命周期", "DB lifecycle"),
    ("/system/core-archives", "Core Archive", "core archive"),
    ("/trading-pairs", "交易", "trading pair"),
    ("/pairs", "交易", "trading pair"),
    ("/reference-overlays", "参考价覆盖", "reference price overlay"),
    ("/contract-symbols", "合约标的", "contract symbol"),
    ("/contract-accounts", "合约账户", "contract account"),
    ("/contract-positions", "合约持仓", "contract position"),
    ("/contract-orders", "合约订单", "contract order"),
    ("/contract-trades", "合约成交", "contract trade"),
    ("/contract-liquidations", "合约强平", "contract liquidation"),
    ("/stock-token-lock-configs", "股票币锁仓配", "stock token lock config"),
    ("/stock-token-release-logs", "股票币释放日", "stock token release log"),
    ("/stock-token-locks", "股票币锁", "stock token lock"),
    ("/platform/adjust-logs", "平台调账日志", "platform adjustment log"),
    ("/platform/adjust/logs", "平台调账日志", "platform adjustment log"),
    ("/platform-adjust-logs", "平台调账日志", "platform adjustment log"),
    ("/platform/adjust", "平台调账", "platform adjustment"),
    ("/platform-adjust", "平台调账", "platform adjustment"),
    ("/platform-accounts", "平台账户", "platform account"),
    ("/platform-account", "平台账户", "platform account"),
    ("/vip/fee-preferences", "VIP 费率偏好", "VIP fee preference"),
    ("/vip/levels", "VIP 等级", "VIP level"),
    ("/vip/users", "VIP 用户", "VIP user"),
    ("/bd/commission-job-logs", "BD 佣金任务日志", "BD commission job log"),
    ("/bd/commissions", "BD 佣金", "BD commission"),
    ("/bd/applications", "BD 申请", "BD application"),
    ("/bd/accounts", "BD 账号", "BD account"),
    ("/bd/teams", "BD 团队", "BD team"),
    ("/bd/team", "BD 团队", "BD team"),
    ("/invite/commissions", "邀请佣", "invite commission"),
    ("/invite/relations", "邀请关", "invite relation"),
    ("/dividends/job-logs", "分红任务日志", "dividend job log"),
    ("/dividends/stats", "分红统计", "dividend stats"),
    ("/dividend-stats", "分红统计", "dividend stats"),
    ("/dividends/config", "分红配置", "dividend config"),
    ("/dividend-config", "分红配置", "dividend config"),
    ("/dividends/pools", "分红", "dividend pool"),
    ("/dividend-pools", "分红", "dividend pool"),
    ("/dividends", "分红", "dividend pool"),
    ("/platform/dealer-risk-logs", "做市商风控日", "dealer risk log"),
    ("/dealer-risk-logs", "做市商风控日", "dealer risk log"),
    ("/platform/dealer-risk", "做市商风", "dealer risk"),
    ("/dealer-risk", "做市商风", "dealer risk"),
    ("/audit", "审计日志", "audit log"),
    ("/geo-access", "Geo Access Control", "geo access control"),
    ("/site-settings", "站点设置", "site settings"),
    ("/home-banners", "首页 Banner", "home banner"),
    ("/announcements", "公告", "announcement"),
    ("/help/categories", "帮助分类", "help category"),
    ("/help/articles", "帮助文章", "help article"),
    ("", "后台首页", "admin home"),
)

ADMIN_DOC_ACTION_LABELS: tuple[tuple[str, str, str], ...] = (
    ("/toggle-status", "切换状", "toggle status"),
    ("/toggle-enabled", "切换启用状", "toggle enabled state"),
    ("/toggle-active", "切换生效状", "toggle active state"),
    ("/toggle", "切换状", "toggle state"),
    ("/reset-password", "重置密码", "reset password"),
    ("/withdraw-unlock", "解除提现锁定", "unlock withdrawals"),
    ("/withdraw-lock", "设置提现锁定", "lock withdrawals"),
    ("/release-frozen", "释放冻结资金", "release frozen funds"),
    ("/approve", "审核通过", "approve"),
    ("/reject", "审核拒绝", "reject"),
    ("/revoke", "撤销", "revoke"),
    ("/restore", "恢复", "restore"),
    ("/disable", "禁用", "disable"),
    ("/enable", "启用", "enable"),
    ("/permissions", "保存权限", "save permissions"),
    ("/delete", "删除", "delete"),
    ("/edit", "编辑", "edit"),
    ("/new", "新建", "create"),
    ("/create-batch", "创建批次", "create batch"),
    ("/create-one", "创建单笔任务", "create single task"),
    ("/create", "创建", "create"),
    ("/update", "更新", "update"),
    ("/save", "保存", "save"),
    ("/sync", "同步", "sync"),
    ("/preflight", "预检", "preflight"),
    ("/watch-test", "监听测试", "watch test"),
    ("/withdraw-fee/sync", "同步提现手续", "sync withdraw fee"),
    ("/refresh", "刷新", "refresh"),
    ("/scan-missing", "扫描缺失候", "scan missing candidates"),
    ("/scan-events", "查看扫描事件", "view scan events"),
    ("/scan", "扫描", "scan"),
    ("/verify", "校验", "verify"),
    ("/add-candidates", "批量添加候", "add candidates"),
    ("/add-candidate", "添加候", "add candidate"),
    ("/requeue", "重新入队", "requeue"),
    ("/confirm-requeue", "确认重新入队", "confirm requeue"),
    ("/retry", "重试", "retry"),
    ("/dry-run", "试运", "dry run"),
    ("/real-send", "真实发", "real send"),
    ("/send", "发", "send"),
    ("/calculate", "计算", "calculate"),
    ("/distribute", "发放", "distribute"),
    ("/pay-pending", "支付待处理记", "pay pending records"),
    ("/pay", "支付", "pay"),
    ("/config", "配置", "configure"),
    ("/rules", "规则", "rule"),
    ("/events", "事件", "event stream"),
)


def _admin_doc_path(path: str) -> str:
    return path if path.startswith("/admin") else f"/admin{path}"


def _admin_doc_relative_path(path: str) -> str:
    if path.startswith("/admin"):
        return path[len("/admin") :] or ""
    return path


def _admin_doc_tag(path: str) -> str:
    relative_path = _admin_doc_relative_path(path)
    if relative_path in ("", "/login", "/logout", "/dashboard", "/funds-dashboard", "/trading-dashboard", "/risk-dashboard"):
        return ADMIN_DOC_TAGS["dashboard"]
    if relative_path.startswith("/admin-users") or relative_path.startswith("/admin-roles"):
        return ADMIN_DOC_TAGS["admin"]
    if relative_path.startswith("/users") or relative_path.startswith("/kyc"):
        return ADMIN_DOC_TAGS["user"]
    if relative_path.startswith(("/assets", "/asset-configs", "/chain-health", "/hot-wallets")):
        return ADMIN_DOC_TAGS["asset"]
    if relative_path.startswith(("/deposit-records", "/balance-logs", "/user-transfers")):
        return ADMIN_DOC_TAGS["funds"]
    if relative_path.startswith(("/withdraw-records", "/withdraw-anomalies", "/withdraw-reviews")):
        return ADMIN_DOC_TAGS["withdraw"]
    if relative_path.startswith(("/collections", "/collection")):
        return ADMIN_DOC_TAGS["collection"]
    if relative_path.startswith(("/orders", "/trades", "/spot-fee-settings")):
        return ADMIN_DOC_TAGS["trade"]
    if relative_path.startswith(("/market", "/trading-pairs", "/pairs", "/reference-overlays")):
        return ADMIN_DOC_TAGS["market"]
    if relative_path.startswith("/contract"):
        return ADMIN_DOC_TAGS["contract"]
    if relative_path.startswith("/stock-token"):
        return ADMIN_DOC_TAGS["asset"]
    if relative_path.startswith("/platform/dealer-risk") or relative_path.startswith("/dealer-risk"):
        return ADMIN_DOC_TAGS["risk"]
    if relative_path.startswith("/platform") or relative_path.startswith("/platform-"):
        return ADMIN_DOC_TAGS["platform"]
    if relative_path.startswith("/vip"):
        return ADMIN_DOC_TAGS["vip"]
    if relative_path.startswith("/bd"):
        return ADMIN_DOC_TAGS["bd"]
    if relative_path.startswith("/invite"):
        return ADMIN_DOC_TAGS["invite"]
    if relative_path.startswith(("/dividend", "/dividends")):
        return ADMIN_DOC_TAGS["dividend"]
    if relative_path.startswith(("/system", "/audit", "/geo-access")):
        return ADMIN_DOC_TAGS["system"]
    if relative_path.startswith(("/site-settings", "/home-banners", "/announcements", "/help", "/uploads")):
        return ADMIN_DOC_TAGS["activity"]
    return ADMIN_DOC_TAGS["admin"]


def _admin_doc_resource(path: str) -> tuple[str, str]:
    relative_path = _admin_doc_relative_path(path)
    best_match = ("", "后台接口", "admin endpoint")
    for prefix, zh_label, en_label in ADMIN_DOC_RESOURCE_LABELS:
        if relative_path == prefix or (prefix and relative_path.startswith(prefix)):
            if len(prefix) >= len(best_match[0]):
                best_match = (prefix, zh_label, en_label)
    return best_match[1], best_match[2]


def _admin_doc_action(path: str, methods: set[str]) -> tuple[str, str]:
    relative_path = _admin_doc_relative_path(path)
    for suffix, zh_label, en_label in ADMIN_DOC_ACTION_LABELS:
        if relative_path.endswith(suffix) or f"{suffix}/" in relative_path:
            return zh_label, en_label
    if "POST" in methods:
        return "提交", "submit"
    return "查看", "view"


def _admin_doc_permission(path: str, methods: set[str]) -> str:
    full_path = _admin_doc_path(path)
    permission = globals().get("ADMIN_GET_PERMISSION_EXACT", {}).get(full_path)
    if permission is None:
        for prefix, prefix_permission in globals().get("ADMIN_GET_PERMISSION_PREFIXES", ()):
            if full_path.startswith(prefix):
                permission = prefix_permission
                break
    if permission == globals().get("ADMIN_PERMISSION_SUPER_ADMIN_ONLY"):
        return "权限要求：需要超级管理员权限。/ Permission: super admin only."
    if permission:
        if "POST" in methods:
            return f"权限要求：页面访问通常需要 `{permission}`，提交操作还会校验对应管理权限。/ Permission: page access usually requires `{permission}`; submit actions also validate the related management permission."
        return f"权限要求：需要 `{permission}`。/ Permission: `{permission}` is required."
    if full_path in ("/admin/login", "/admin/logout"):
        return "权限要求：登录或退出登录流程，无需已登录后台会话。/ Permission: login or logout flow, no existing admin session required."
    return "权限要求：需要有效后台管理员会话。/ Permission: an active admin session is required."


def _admin_doc_summary(path: str, methods: set[str]) -> str:
    zh_resource, en_resource = _admin_doc_resource(path)
    zh_action, en_action = _admin_doc_action(path, methods)
    return f"{zh_action}{zh_resource} / {en_action.title()} {en_resource}"


def _admin_doc_description(path: str, methods: set[str]) -> str:
    full_path = _admin_doc_path(path)
    zh_resource, en_resource = _admin_doc_resource(path)
    zh_action, en_action = _admin_doc_action(path, methods)
    permission_text = _admin_doc_permission(path, methods)
    method_text = ", ".join(sorted(methods))
    return (
        f"前端使用场景：AdminPages 后台通过 `{full_path}` 页面或交互用于{zh_action}{zh_resource}"
        "支撑列表浏览、表单提交、状态切换或异步操作反馈。\n\n"
        f"Frontend usage: AdminPages uses this {method_text} endpoint to {en_action} {en_resource} "
        "from the matching admin page, form, table action, or event-driven workflow.\n\n"
        f"{permission_text}\n\n"
        "注意事项：仅补充 Swagger/OpenAPI 文档元数据；接口路径、HTTP 方法、请求参数和返回结构保持不变。/ "
        "Notes: documentation metadata only; path, HTTP method, request parameters, and response shape are unchanged."
    )


class AdminPagesDocumentedRoute(APIRoute):
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.tags = [_admin_doc_tag(self.path)]
        self.summary = self.summary or _admin_doc_summary(self.path, self.methods)
        self.description = self.description or _admin_doc_description(self.path, self.methods)


router = APIRouter(prefix="/admin", tags=["AdminPages"], route_class=AdminPagesDocumentedRoute)

BASE_DIR = Path(__file__).resolve().parents[2]
TEMPLATES_DIR = BASE_DIR / "templates"
templates = Jinja2Templates(directory=str(TEMPLATES_DIR))
logger = logging.getLogger(__name__)

COOKIE_NAME = "admin_auth"
COOKIE_VALUE = "1"
ADMIN_USER_ID_COOKIE_NAME = "admin_user_id"
ADMIN_USERNAME_COOKIE_NAME = "admin_username"
ADMIN_COOKIE_MAX_AGE = 3600 * 8
ADMIN_PERMISSION_SUPER_ADMIN_ONLY = "__super_admin_only__"
ADMIN_POST_FORBIDDEN_MESSAGE = "当前账号没有执行此操作的权限，请联系超级管理员"
ADMIN_STATUS_ACTIVE = "ACTIVE"
ADMIN_LOGIN_INVALID_MESSAGE = "用户名或密码错误"
ADMIN_LOGIN_DISABLED_MESSAGE = "管理员账号已停用"
ADMIN_LOGIN_CAPTCHA_REQUIRED_MESSAGE = "请输入图形验证码"
ADMIN_LOGIN_CAPTCHA_INVALID_MESSAGE = "验证码错误或已过期"
ADMIN_LOGIN_CAPTCHA_UNAVAILABLE_MESSAGE = "验证码服务暂不可用，请稍后重试"
ADMIN_LOGIN_CAPTCHA_TTL_SECONDS = int(getattr(settings, "LOGIN_CAPTCHA_TTL_SECONDS", 5 * 60))
ADMIN_RBAC_UNINITIALIZED_MESSAGE = "后台权限系统未初始化，请先执行数据库迁移和初始化脚本"
UPLOAD_IMAGE_MAX_BYTES = 2 * 1024 * 1024
UPLOAD_IMAGE_TYPES = {
    "image/png": {".png"},
    "image/jpeg": {".jpg", ".jpeg"},
    "image/webp": {".webp"},
    "image/svg+xml": {".svg"},
}
UPLOAD_IMAGE_DEFAULT_EXT = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/svg+xml": ".svg",
}
UPLOAD_SITE_MEDIA_MAX_BYTES = 20 * 1024 * 1024
UPLOAD_SITE_VIDEO_MAX_BYTES = 100 * 1024 * 1024
UPLOAD_SITE_OUTPUT_MAX_BYTES = 20 * 1024 * 1024
UPLOAD_SITE_IMAGE_TYPES = {
    **UPLOAD_IMAGE_TYPES,
}
UPLOAD_SITE_VIDEO_TYPES = {
    "video/mp4": {".mp4"},
    "video/webm": {".webm"},
}
UPLOAD_SITE_MEDIA_TYPES = {
    **UPLOAD_SITE_IMAGE_TYPES,
    **UPLOAD_SITE_VIDEO_TYPES,
}
UPLOAD_SITE_MEDIA_DEFAULT_EXT = {
    **UPLOAD_IMAGE_DEFAULT_EXT,
    "video/mp4": ".mp4",
    "video/webm": ".webm",
}


def _normalize_upload_content_type(content_type: Optional[str]) -> str:
    return (content_type or "").split(";", 1)[0].strip().lower()


def _validate_site_media_type(content_type: str, original_ext: str) -> str:
    allowed_exts = UPLOAD_SITE_MEDIA_TYPES.get(content_type)
    if not allowed_exts or original_ext not in allowed_exts:
        raise HTTPException(
            status_code=400,
            detail="仅支持 png、jpg、jpeg、webp、svg、mp4、webm 文件",
        )
    if content_type in UPLOAD_SITE_VIDEO_TYPES:
        return "video"
    if content_type == "image/svg+xml":
        return "svg"
    return "image"


def _ensure_site_upload_dir() -> Path:
    upload_dir = BASE_DIR / "static" / "uploads" / "site"
    upload_dir.mkdir(parents=True, exist_ok=True)
    return upload_dir


def _ensure_output_within_limit(target: Path, detail: str) -> None:
    if target.stat().st_size <= UPLOAD_SITE_OUTPUT_MAX_BYTES:
        return
    target.unlink(missing_ok=True)
    raise HTTPException(status_code=400, detail=detail)


def _compress_site_image(content: bytes, target: Path) -> None:
    try:
        from PIL import Image, ImageOps, UnidentifiedImageError
    except ImportError as exc:
        raise HTTPException(status_code=500, detail="服务器未安装图片处理组件") from exc

    try:
        with Image.open(io.BytesIO(content)) as image:
            image = ImageOps.exif_transpose(image)
            resampling = getattr(getattr(Image, "Resampling", Image), "LANCZOS")
            image.thumbnail((1920, 1920), resampling)
            if image.mode not in {"RGB", "RGBA"}:
                has_alpha = image.mode in {"LA", "PA"} or (
                    image.mode == "P" and "transparency" in image.info
                )
                image = image.convert("RGBA" if has_alpha else "RGB")
            image.save(target, format="WEBP", quality=85, method=6)
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        target.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail="图片处理失败，请更换文件后重") from exc

    _ensure_output_within_limit(target, "图片压缩后仍超过 20MB，请降低清晰度或尺寸")


def _transcode_site_video(content: bytes, source_ext: str, upload_dir: Path) -> Path:
    ffmpeg_path = shutil.which("ffmpeg")
    if not ffmpeg_path:
        raise HTTPException(status_code=400, detail="服务器未安装视频处理组件")

    source = upload_dir / f"{uuid.uuid4().hex}_source{source_ext}"
    target = upload_dir / f"{uuid.uuid4().hex}.mp4"
    source.write_bytes(content)
    command = [
        ffmpeg_path,
        "-y",
        "-i",
        str(source),
        "-vf",
        "scale='min(1920,iw)':'min(1080,ih)':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "28",
        "-pix_fmt",
        "yuv420p",
        "-an",
        "-movflags",
        "+faststart",
        str(target),
    ]

    try:
        result = subprocess.run(command, capture_output=True, timeout=300, check=False)
        if result.returncode != 0 or not target.exists() or target.stat().st_size == 0:
            stderr = result.stderr.decode("utf-8", "ignore")[-4000:]
            logger.warning("Failed to transcode site media upload: %s", stderr)
            target.unlink(missing_ok=True)
            raise HTTPException(status_code=400, detail="视频处理失败，请更换文件后重")
        _ensure_output_within_limit(target, "视频过大，请缩短时长或降低清晰度")
        return target
    except subprocess.TimeoutExpired as exc:
        target.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail="视频处理超时，请缩短时长后重") from exc
    except OSError as exc:
        target.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail="服务器未安装视频处理组件") from exc
    finally:
        source.unlink(missing_ok=True)

ADMIN_GET_PERMISSION_EXACT: Dict[str, str] = {
    "/admin": "dashboard.view",
    "/admin/dashboard": "dashboard.view",
    "/admin/funds-dashboard": "dashboard.view",
    "/admin/trading-dashboard": "dashboard.view",
    "/admin/risk-dashboard": "dashboard.view",
    "/admin/users": "users.view",
    "/admin/kyc/submissions": "users.view",
    "/admin/assets": "assets.view",
    "/admin/balance-logs": "balance_logs.view",
    "/admin/deposit-records": "deposit_records.view",
    "/admin/withdraw-records": "withdraw_records.view",
    "/admin/withdraw-anomalies": "withdraw_anomalies.view",
    "/admin/withdraw-reviews": "withdraw_reviews.view",
    "/admin/user-transfers": "user_transfers.view",
    "/admin/orders": "orders.view",
    "/admin/trades": "trades.view",
    "/admin/market-analysis/pairs": "market_analysis.view",
    "/admin/spot-fee-settings": "fee_settings.manage",
    "/admin/contract-orders": "contract_orders.view",
    "/admin/contract-trades": "contract_trades.view",
    "/admin/contract-positions": "contract_positions.view",
    "/admin/contract-accounts": "contract_accounts.view",
    "/admin/contract-liquidations": "contract_liquidations.view",
    "/admin/market-providers": "contract_symbols.manage",
    "/admin/trading-pairs": "trading_pairs.manage",
    "/admin/pairs": "trading_pairs.manage",
    "/admin/reference-overlays": "trading_pairs.manage",
    "/admin/contract-symbols": "contract_symbols.manage",
    "/admin/asset-configs": "asset_configs.manage",
    "/admin/chain-health": "asset_configs.manage",
    "/admin/platform-accounts": "platform_accounts.view",
    "/admin/platform-account": "platform_accounts.view",
    "/admin/platform/accounts": "platform_accounts.view",
    "/admin/platform-adjust": "platform_adjust.manage",
    "/admin/platform/adjust": "platform_adjust.manage",
    "/admin/platform-adjust-logs": "platform_adjust.manage",
    "/admin/platform/adjust-logs": "platform_adjust.manage",
    "/admin/platform/adjust/logs": "platform_adjust.manage",
    "/admin/hot-wallets": "collection_tasks.manage",
    "/admin/dealer-risk": "dealer_risk.manage",
    "/admin/platform/dealer-risk": "dealer_risk.manage",
    "/admin/dealer-risk-logs": "dealer_risk.manage",
    "/admin/platform/dealer-risk-logs": "dealer_risk.manage",
    "/admin/audit": "audit.view",
    "/admin/geo-access": ADMIN_PERMISSION_SUPER_ADMIN_ONLY,
    "/admin/system/operations": ADMIN_PERMISSION_SUPER_ADMIN_ONLY,
    "/admin/system/db-lifecycle": ADMIN_PERMISSION_SUPER_ADMIN_ONLY,
    "/admin/system/core-archives": ADMIN_PERMISSION_SUPER_ADMIN_ONLY,
    "/admin/system/services": ADMIN_PERMISSION_SUPER_ADMIN_ONLY,
    "/admin/system/rq": ADMIN_PERMISSION_SUPER_ADMIN_ONLY,
    "/admin/site-settings": "site_settings.manage",
    "/admin/site-about-page": "site_content.manage",
    "/admin/site-legal-pages": "site_content.manage",
    "/admin/support-tickets": "support_tickets.manage",
    "/admin/admin-users": ADMIN_PERMISSION_SUPER_ADMIN_ONLY,
    "/admin/admin-roles": ADMIN_PERMISSION_SUPER_ADMIN_ONLY,
}

ADMIN_GET_PERMISSION_PREFIXES: tuple[tuple[str, str], ...] = (
    ("/admin/pairs", "trading_pairs.manage"),
    ("/admin/reference-overlays", "trading_pairs.manage"),
    ("/admin/contract-symbols", "contract_symbols.manage"),
    ("/admin/market-providers", "contract_symbols.manage"),
    ("/admin/asset-configs", "asset_configs.manage"),
    ("/admin/vip", "vip.view"),
    ("/admin/bd", "bd.view"),
    ("/admin/invite", "invite.view"),
    ("/admin/dividend", "dividend.view"),
    ("/admin/dividends", "dividend.view"),
    ("/admin/stock-token-lock-configs", "stock_locks.view"),
    ("/admin/stock-token-locks", "stock_locks.view"),
    ("/admin/stock-token-release-logs", "stock_locks.view"),
    ("/admin/home-banners", "banners.manage"),
    ("/admin/activity-banners", "banners.manage"),
    ("/admin/activities", "banners.manage"),
    ("/admin/announcements", "announcements.manage"),
    ("/admin/site-about-page", "site_content.manage"),
    ("/admin/site-legal-pages", "site_content.manage"),
    ("/admin/help/categories", "site_content.manage"),
    ("/admin/help/articles", "site_content.manage"),
    ("/admin/support-tickets", "support_tickets.manage"),
    ("/admin/geo-access", ADMIN_PERMISSION_SUPER_ADMIN_ONLY),
    ("/admin/admin-users", ADMIN_PERMISSION_SUPER_ADMIN_ONLY),
    ("/admin/admin-roles", ADMIN_PERMISSION_SUPER_ADMIN_ONLY),
    ("/admin/system/operations", ADMIN_PERMISSION_SUPER_ADMIN_ONLY),
    ("/admin/system/db-lifecycle", ADMIN_PERMISSION_SUPER_ADMIN_ONLY),
    ("/admin/system/core-archives", ADMIN_PERMISSION_SUPER_ADMIN_ONLY),
    ("/admin/system/services", ADMIN_PERMISSION_SUPER_ADMIN_ONLY),
    ("/admin/system/rq", ADMIN_PERMISSION_SUPER_ADMIN_ONLY),
    ("/admin/market-analysis", "market_analysis.view"),
)

# Kept as a narrow fallback helper for historical audit placeholders.
# There are currently no active admin routes that call render_placeholder_page.
PLACEHOLDER_PAGE_TEMPLATE = """
{% extends "admin/layout.html" %}

{% block title %}{{ title }}{% endblock %}
{% block page_title %}{{ page_title }}{% endblock %}

{% block content %}
  <section class="page-section">
    <div class="card">
      <div class="section-title">{{ page_title }}</div>
      <p class="muted">{{ message }}</p>
    </div>
  </section>
{% endblock %}
"""


def _admin_redis_key(key: str) -> str:
    prefix = getattr(settings, "REDIS_KEY_PREFIX", "exchange")
    return f"{prefix}:{key}"


def _admin_login_captcha_key(captcha_id: str) -> str:
    return _admin_redis_key(f"admin_login_captcha:{captcha_id}")


def _decode_redis_value(value: Any) -> str:
    if isinstance(value, (bytes, bytearray)):
        return value.decode("utf-8")
    return str(value or "")


def _generate_admin_login_captcha_code(length: int = 5) -> str:
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    return "".join(secrets.choice(alphabet) for _ in range(length))


def _build_admin_login_captcha_image(code: str) -> str:
    escaped = html.escape(code)
    lines = []
    for _ in range(6):
        x1 = secrets.randbelow(130)
        y1 = 12 + secrets.randbelow(30)
        x2 = secrets.randbelow(130)
        y2 = 12 + secrets.randbelow(30)
        color = secrets.choice(["#8bb8ff", "#f6c76f", "#7dd3fc", "#c084fc"])
        lines.append(
            f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" '
            f'stroke="{color}" stroke-width="1.2" opacity="0.65" />'
        )

    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" width="132" height="44" viewBox="0 0 132 44">
<rect width="132" height="44" rx="6" fill="#10141c"/>
{''.join(lines)}
<text x="66" y="29" text-anchor="middle" font-family="Consolas, Menlo, monospace" font-size="24" font-weight="700" fill="#f8fafc" letter-spacing="4">{escaped}</text>
</svg>"""
    encoded = base64.b64encode(svg.encode("utf-8")).decode("ascii")
    return f"data:image/svg+xml;base64,{encoded}"


def _create_admin_login_captcha() -> Dict[str, str]:
    captcha_id = secrets.token_urlsafe(24)
    code = _generate_admin_login_captcha_code()
    get_redis().setex(_admin_login_captcha_key(captcha_id), ADMIN_LOGIN_CAPTCHA_TTL_SECONDS, code)
    return {"id": captcha_id, "image": _build_admin_login_captcha_image(code)}


def _admin_login_template_ctx(*, error: str = "") -> Dict[str, Any]:
    ctx: Dict[str, Any] = {
        "active_group": "system",
        "active": "admin_login",
        "error": error,
        "captcha": None,
    }
    try:
        ctx["captcha"] = _create_admin_login_captcha()
    except Exception:
        logger.exception("Failed to create admin login captcha")
        if not error:
            ctx["error"] = ADMIN_LOGIN_CAPTCHA_UNAVAILABLE_MESSAGE
    return ctx


def _verify_admin_login_captcha(captcha_id: str, captcha_code: str) -> tuple[bool, str]:
    cid = str(captcha_id or "").strip()
    code = str(captcha_code or "").strip().upper()
    if not cid or not code:
        return False, ADMIN_LOGIN_CAPTCHA_REQUIRED_MESSAGE

    try:
        redis = get_redis()
        key = _admin_login_captcha_key(cid)
        expected = _decode_redis_value(redis.get(key)).upper()
        redis.delete(key)
    except Exception:
        logger.exception("Failed to verify admin login captcha")
        return False, ADMIN_LOGIN_CAPTCHA_UNAVAILABLE_MESSAGE

    if not expected or not secrets.compare_digest(expected, code):
        return False, ADMIN_LOGIN_CAPTCHA_INVALID_MESSAGE
    return True, ""


def get_admin_from_request(request: Request) -> Optional[Dict[str, Any]]:
    if request.cookies.get(COOKIE_NAME) != COOKIE_VALUE:
        return None

    admin_user_id = str(request.cookies.get(ADMIN_USER_ID_COOKIE_NAME) or "").strip()
    admin_username = str(request.cookies.get(ADMIN_USERNAME_COOKIE_NAME) or "").strip()
    if not admin_user_id or not admin_username:
        return None

    try:
        parsed_admin_user_id = int(admin_user_id)
    except ValueError:
        return None

    return {
        "id": parsed_admin_user_id,
        "username": unquote(admin_username),
    }


def _default_pagination() -> Dict[str, int]:
    return {"page": 1, "page_size": 20, "total": 0, "pages": 1}


def _result_items(result: Optional[Dict[str, Any]]) -> list[Any]:
    if not isinstance(result, dict):
        return []
    return result.get("items") or []


def _result_records(result: Optional[Dict[str, Any]]) -> list[Any]:
    if not isinstance(result, dict):
        return []
    return result.get("records") or _result_items(result)


def _result_filters(result: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    if not isinstance(result, dict):
        return {}
    return dict(result.get("filters") or {})


def _result_summary(result: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    if not isinstance(result, dict):
        return {}
    return result.get("summary") or {}


def _result_stats(result: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    if not isinstance(result, dict):
        return {}
    return result.get("stats") or {}


def _result_page(result: Optional[Dict[str, Any]]) -> int:
    if not isinstance(result, dict):
        return 1
    return int(result.get("page") or 1)


def _result_page_size(result: Optional[Dict[str, Any]]) -> int:
    if not isinstance(result, dict):
        return 20
    return int(result.get("page_size") or 20)


def _result_total(result: Optional[Dict[str, Any]]) -> int:
    if not isinstance(result, dict):
        return 0
    return int(result.get("total") or 0)


def _result_pages(result: Optional[Dict[str, Any]]) -> int:
    if not isinstance(result, dict):
        return 1
    pages = result.get("pages")
    if pages:
        return int(pages)
    page_size = _result_page_size(result)
    total = _result_total(result)
    return max(1, (total + page_size - 1) // page_size)


def _result_pagination(result: Optional[Dict[str, Any]]) -> Dict[str, int]:
    if isinstance(result, dict) and isinstance(result.get("pagination"), dict):
        pagination = dict(result["pagination"])
    else:
        pagination = {}
    pagination.setdefault("page", _result_page(result))
    pagination.setdefault("page_size", _result_page_size(result))
    pagination.setdefault("total", _result_total(result))
    pagination.setdefault("pages", _result_pages(result))
    return pagination


def _format_datetime_local(value: Optional[datetime]) -> str:
    if not isinstance(value, datetime):
        return ""
    return value.strftime("%Y-%m-%dT%H:%M")


def _format_date_input(value: Optional[datetime]) -> str:
    if not isinstance(value, datetime):
        return ""
    return value.strftime("%Y-%m-%d")


def _clean_query_text(value: Any) -> str:
    return str(value or "").strip()


def _parse_trade_date_query(value: Any, *, is_end: bool = False) -> tuple[Optional[datetime], str, bool]:
    text_value = _clean_query_text(value)
    if not text_value:
        return None, "", False
    normalized = text_value.replace(" ", "T")
    try:
        parsed_date = datetime.strptime(normalized, "%Y-%m-%d")
        if is_end:
            return parsed_date.replace(hour=23, minute=59, second=59, microsecond=999999), text_value, False
        return parsed_date.replace(hour=0, minute=0, second=0, microsecond=0), text_value, False
    except ValueError:
        pass
    for pattern in ("%Y-%m-%dT%H:%M", "%Y-%m-%dT%H:%M:%S"):
        try:
            return datetime.strptime(normalized, pattern), text_value, False
        except ValueError:
            pass
    return None, text_value, True


def _normalize_coin_symbol_value(value: str) -> str:
    return str(value or "").strip().upper()


def _normalize_chain_key_value(value: str, default: str = "") -> str:
    normalized = str(value or "").strip().lower()
    return normalized or default


def _parse_fee_discount_percent_value(value: str) -> Decimal:
    text_value = str(value or "").strip().replace("%", "")
    if not text_value:
        raise ValueError("请输入 RCB 抵扣比例")
    try:
        rate = Decimal(text_value)
    except Exception as exc:
        raise ValueError("RCB抵扣比例格式不正") from exc
    if rate > Decimal("1"):
        rate = rate / Decimal("100")
    return rate


def _format_fee_discount_percent_input(value: Decimal) -> str:
    percent_value = (Decimal(str(value or 0)) * Decimal("100")).quantize(Decimal("0.01"))
    return format(percent_value.normalize(), "f")


def _build_spot_fee_settings_redirect_url(*, notice: str = "", error: str = "") -> str:
    params = []
    if notice:
        params.append(f"notice={quote(notice)}")
    if error:
        params.append(f"error={quote(error)}")
    if not params:
        return "/admin/spot-fee-settings"
    return f"/admin/spot-fee-settings?{'&'.join(params)}"


def _build_pairs_redirect_url(
    *,
    notice: str = "",
    error: str = "",
    next_path: str = "/admin/pairs",
) -> str:
    base = next_path if next_path.startswith("/admin/pairs") else "/admin/pairs"
    params = []
    if notice:
        params.append(f"notice={quote(notice)}")
    if error:
        params.append(f"error={quote(error)}")
    if not params:
        return base
    separator = "&" if "?" in base else "?"
    return f"{base}{separator}{'&'.join(params)}"


def _build_contract_symbols_redirect_url(
    *,
    notice: str = "",
    error: str = "",
    next_path: str = "/admin/contract-symbols",
) -> str:
    base = next_path if next_path.startswith("/admin/contract-symbols") else "/admin/contract-symbols"
    params = []
    if notice:
        params.append(f"notice={quote(notice)}")
    if error:
        params.append(f"error={quote(error)}")
    if not params:
        return base
    separator = "&" if "?" in base else "?"
    return f"{base}{separator}{'&'.join(params)}"


def _build_stock_token_lock_config_redirect_url(
    *,
    notice: str = "",
    error: str = "",
    next_path: str = "/admin/stock-token-lock-configs",
) -> str:
    base = (
        next_path
        if next_path.startswith("/admin/stock-token-lock-configs")
        else "/admin/stock-token-lock-configs"
    )
    params = []
    if notice:
        params.append(f"notice={quote(notice)}")
    if error:
        params.append(f"error={quote(error)}")
    if not params:
        return base
    separator = "&" if "?" in base else "?"
    return f"{base}{separator}{'&'.join(params)}"


def _build_stock_token_locks_redirect_url(
    *,
    notice: str = "",
    error: str = "",
    next_path: str = "/admin/stock-token-locks",
) -> str:
    base = next_path if next_path.startswith("/admin/stock-token-locks") else "/admin/stock-token-locks"
    params = []
    if notice:
        params.append(f"notice={quote(notice)}")
    if error:
        params.append(f"error={quote(error)}")
    if not params:
        return base
    separator = "&" if "?" in base else "?"
    return f"{base}{separator}{'&'.join(params)}"


def _build_platform_redirect_url(
    *,
    notice: str = "",
    error: str = "",
    next_path: str = "/admin/platform/adjust",
) -> str:
    base = next_path if next_path.startswith("/admin/platform/") else "/admin/platform/adjust"
    params = []
    if notice:
        params.append(f"notice={quote(notice)}")
    if error:
        params.append(f"error={quote(error)}")
    if not params:
        return base
    separator = "&" if "?" in base else "?"
    return f"{base}{separator}{'&'.join(params)}"


def _build_withdraw_review_redirect_url(
    *,
    notice: str = "",
    error: str = "",
    next_path: str = "/admin/withdraw-reviews",
) -> str:
    base = next_path if next_path.startswith("/admin/withdraw-reviews") else "/admin/withdraw-reviews"
    params = []
    if notice:
        params.append(f"notice={quote(notice)}")
    if error:
        params.append(f"error={quote(error)}")
    if not params:
        return base
    separator = "&" if "?" in base else "?"
    return f"{base}{separator}{'&'.join(params)}"


def _build_withdraw_records_redirect_url(
    *,
    notice: str = "",
    error: str = "",
    next_path: str = "/admin/withdraw-records",
) -> str:
    base = (
        next_path
        if next_path.startswith("/admin/withdraw-records") or next_path.startswith("/admin/withdraw-anomalies")
        else "/admin/withdraw-records"
    )
    params = []
    if notice:
        params.append(f"notice={quote(notice)}")
    if error:
        params.append(f"error={quote(error)}")
    if not params:
        return base
    separator = "&" if "?" in base else "?"
    return f"{base}{separator}{'&'.join(params)}"


def _build_deposit_records_redirect_url(
    *,
    notice: str = "",
    error: str = "",
    next_path: str = "/admin/deposit-records",
) -> str:
    base = next_path if str(next_path or "").startswith("/admin/deposit-records") else "/admin/deposit-records"
    params = []
    if notice:
        params.append(f"notice={quote(notice)}")
    if error:
        params.append(f"error={quote(error)}")
    if not params:
        return base
    separator = "&" if "?" in base else "?"
    return f"{base}{separator}{'&'.join(params)}"


def _build_collection_tasks_redirect_url(
    *,
    notice: str = "",
    notice_detail: str = "",
    error: str = "",
    next_path: str = "/admin/collections/tasks",
) -> str:
    base = next_path if next_path.startswith("/admin/collections/tasks") else "/admin/collections/tasks"
    params = []
    if notice:
        params.append(f"notice={quote(notice)}")
    if notice_detail:
        params.append(f"notice_detail={quote(notice_detail)}")
    if error:
        params.append(f"error={quote(error)}")
    if not params:
        return base
    separator = "&" if "?" in base else "?"
    return f"{base}{separator}{'&'.join(params)}"


_COLLECTION_CREATE_SKIP_REASON_LABELS = {
    "BELOW_MIN_COLLECT_AMOUNT": "低于最小归集额",
    "ACTIVE_COLLECTION_TASK_EXISTS": "已有归集任务",
    "ZERO_VERIFIED_BALANCE": "链上余额为 0",
    "ONCHAIN_VERIFY_FAILED": "链上核实失败",
    "CHAIN_COLLECTION_DISABLED": "网络归集未开启",
    "ASSET_CHAIN_DISABLED": "币种网络未启用",
    "REAL_SEND_DISABLED": "真实归集发送未开启",
    "GAS_NOT_READY": "Gas 不足或未就绪",
    "UNKNOWN": "未满足归集条件",
    "MIN_COLLECT_AMOUNT_NOT_REACHED": "低于最小归集额",
    "AVAILABLE_AMOUNT_BELOW_MIN_COLLECT": "低于最小归集额",
    "ZERO_BALANCE": "链上余额为 0",
    "DUPLICATE_ACTIVE_TASK": "已有归集任务",
    "COLLECTION_DISABLED": "网络归集未开启",
    "GAS_REQUIRED": "Gas 不足或未就绪",
    "COLLECTIBLE_BUT_GAS_REQUIRED": "Gas 不足或未就绪",
    "UNVERIFIED": "未满足归集条件",
}


def _collection_create_skip_reason_label(reason: Any) -> str:
    key = str(reason or "").strip()
    if not key:
        key = "UNKNOWN"
    return _COLLECTION_CREATE_SKIP_REASON_LABELS.get(key.upper(), _COLLECTION_CREATE_SKIP_REASON_LABELS["UNKNOWN"])


def _collection_create_short_address(value: Any) -> str:
    address = str(value or "").strip()
    if len(address) <= 18:
        return address
    return f"{address[:8]}...{address[-6:]}"


def _collection_create_text(value: Any, default: str = "-") -> str:
    text_value = str(value or "").strip()
    return text_value or default


def _collection_create_skip_item(raw_item: Any) -> Dict[str, Any]:
    item = dict(raw_item or {}) if isinstance(raw_item, dict) else {}
    reason = str(item.get("skip_reason") or item.get("reason") or "UNKNOWN").strip().upper() or "UNKNOWN"
    action = str(item.get("action") or "").strip().lower()
    task_id = item.get("task_id") or ""
    batch_id = item.get("batch_id") or ""
    task_status = str(item.get("task_status") or "").strip().upper()
    task_completed = bool(task_status in {"CONFIRMED", "SUCCESS", "COMPLETED"})
    action_labels = {
        "created": "已新建任务",
        "reused_existing": "近期已归集完成" if task_completed else "已存在",
        "duplicate_active": "已有处理中任务",
        "skipped_zero": "链上余额为 0",
        "skipped_below_min": "低于最小归集额",
        "skipped_config": "配置不可用",
        "error": "创建失败",
    }
    action_groups = {
        "error": ("异常", "danger", 10),
        "enqueue_error": ("异常", "danger", 10),
        "created": ("新建", "success", 20),
        "reused_existing": ("已存在", "warning", 30),
        "duplicate_active": ("已存在", "warning", 31),
        "skipped_zero": ("跳过", "neutral", 40),
        "skipped_below_min": ("跳过", "neutral", 41),
        "skipped_config": ("跳过", "neutral", 42),
    }
    action_group, action_tone, action_sort = action_groups.get(action, ("跳过", "neutral", 50))
    address = _collection_create_text(item.get("address"), "")
    return {
        "candidate_id": item.get("candidate_id") or item.get("id") or "",
        "chain_key": _collection_create_text(item.get("chain_key") or item.get("network")),
        "coin_symbol": _collection_create_text(item.get("coin_symbol") or item.get("asset_symbol") or item.get("symbol")),
        "address": address,
        "address_short": _collection_create_text(item.get("address_short") or _collection_create_short_address(address)),
        "verified_onchain_amount": _collection_create_text(
            item.get("verified_onchain_amount")
            if item.get("verified_onchain_amount") not in (None, "")
            else item.get("balance_amount")
        ),
        "min_collect_amount": _collection_create_text(item.get("min_collect_amount")),
        "skip_reason": reason,
        "skip_reason_label": _collection_create_skip_reason_label(reason),
        "action": action,
        "action_label": action_labels.get(action) or _collection_create_skip_reason_label(reason),
        "action_group": action_group,
        "action_tone": action_tone,
        "action_sort": action_sort,
        "task_id": task_id,
        "task_status": task_status,
        "batch_id": batch_id,
        "batch_no": item.get("batch_no") or "",
        "detail_url": f"/admin/collections/tasks?batch_id={batch_id}" if batch_id else "",
    }


def _collection_create_safe_technical_value(value: Any) -> Any:
    if isinstance(value, dict):
        safe: Dict[str, Any] = {}
        for key, item in value.items():
            key_text = str(key or "")
            if any(token in key_text.lower() for token in ("traceback", "exception", "sql", "error", "stack")):
                safe[key_text] = "已隐藏"
            else:
                safe[key_text] = _collection_create_safe_technical_value(item)
        return safe
    if isinstance(value, list):
        return [_collection_create_safe_technical_value(item) for item in value]
    return value


def _build_collection_create_detail(result: Dict[str, Any], enqueue_result: Dict[str, Any]) -> Dict[str, Any]:
    created_count = int(result.get("created_task_count") or 0)
    skipped_count = int(result.get("skipped_count") or 0)
    candidate_count = int(result.get("candidate_count") or 0)
    reused_existing_count = int(result.get("reused_existing_count") or 0)
    duplicate_active_count = int(result.get("duplicate_active_count") or 0)
    reused_count = int(result.get("reused_count") or 0) or reused_existing_count + duplicate_active_count
    skipped_reason_stats = result.get("skipped_reason_stats") or {}
    reason_items = []
    for reason, count in skipped_reason_stats.items():
        count_value = int(count or 0)
        if count_value <= 0:
            continue
        reason_items.append(
            {
                "reason": str(reason or "UNKNOWN").strip().upper() or "UNKNOWN",
                "label": _collection_create_skip_reason_label(reason),
                "count": count_value,
            }
        )
    raw_debug_items = result.get("skipped_items") or result.get("debug_items") or []
    raw_items = raw_debug_items if isinstance(raw_debug_items, list) else [raw_debug_items]
    if candidate_count <= 0 and raw_debug_items:
        candidate_count = len(raw_items)
    skipped_items = [
        _collection_create_skip_item(item)
        for item in raw_items
        if isinstance(item, dict)
        and str(item.get("action") or item.get("skip_reason") or item.get("reason") or "").strip()
    ]
    actual_skipped_items = [
        item
        for item in skipped_items
        if str(item.get("action") or "").strip().lower() not in {"created", "reused_existing", "duplicate_active"}
        and str(item.get("skip_reason") or "").strip().upper()
        not in {"EXISTING_IDEMPOTENT_TASK", "EXISTING_COLLECTION_TASK", "ACTIVE_COLLECTION_TASK_EXISTS"}
    ]
    if not reason_items and skipped_items:
        reason_counts: Dict[str, int] = {}
        for item in actual_skipped_items:
            reason = str(item.get("skip_reason") or "UNKNOWN").strip().upper() or "UNKNOWN"
            reason_counts[reason] = reason_counts.get(reason, 0) + 1
        reason_items = [
            {"reason": reason, "label": _collection_create_skip_reason_label(reason), "count": count}
            for reason, count in sorted(reason_counts.items())
        ]
    if skipped_count <= 0 and actual_skipped_items:
        skipped_count = len(actual_skipped_items)
    errors = enqueue_result.get("errors") or []
    enqueue_error_count = len(errors) if isinstance(errors, list) else (1 if errors else 0)
    skipped_items = sorted(
        skipped_items,
        key=lambda item: (
            int(item.get("action_sort") or 99),
            str(item.get("chain_key") or ""),
            str(item.get("coin_symbol") or ""),
            str(item.get("address") or ""),
        ),
    )
    if enqueue_error_count > 0:
        result_status_label = "部分任务异常，请查看详情"
        result_status_tone = "danger"
    elif created_count > 0:
        result_status_label = "已创建新归集任务"
        result_status_tone = "success"
    elif skipped_count > 0 or reused_count > 0:
        result_status_label = "没有新建任务"
        result_status_tone = "warning"
    else:
        result_status_label = "创建检查完成"
        result_status_tone = "info"
    return {
        "result_status_label": result_status_label,
        "result_status_tone": result_status_tone,
        "candidate_count": candidate_count,
        "created_count": created_count,
        "skipped_count": skipped_count,
        "reused_count": reused_count,
        "reused_existing_count": reused_existing_count,
        "duplicate_active_count": duplicate_active_count,
        "enqueue_error_count": enqueue_error_count,
        "skipped_reasons": reason_items,
        "skipped_items": skipped_items,
        "diagnostics": {
            "debug_item_count": len(raw_items) if raw_debug_items else 0,
            "enqueue_error_count": enqueue_error_count,
        },
        "technical_detail": {
            "debug_items": _collection_create_safe_technical_value(raw_debug_items),
            "enqueue_error_count": enqueue_error_count,
        },
    }


def _build_collection_create_notice(result: Dict[str, Any], enqueue_result: Dict[str, Any]) -> tuple[str, str]:
    detail = _build_collection_create_detail(result, enqueue_result)
    candidate_count = int(detail.get("candidate_count") or 0)
    created_count = int(detail.get("created_count") or 0)
    skipped_count = int(detail.get("skipped_count") or 0)
    reused_count = int(detail.get("reused_count") or 0)
    reason_items = list(detail.get("skipped_reasons") or [])
    reason_summary = ", ".join(item["label"] for item in reason_items[:2])
    if len(reason_items) > 2:
        reason_summary = f"{reason_summary}等"

    notice = f"本次扫描候选 {candidate_count} 个；新建归集任务 {created_count} 个"
    if skipped_count > 0:
        notice = f"{notice}；跳过 {skipped_count} 个"
        if reason_summary:
            notice = f"{notice}（{reason_summary}）"
    if reused_count > 0:
        notice = f"{notice}；复用/已存在 {reused_count} 个"
    enqueue_error_count = int(detail.get("enqueue_error_count") or 0)
    if enqueue_error_count:
        notice = f"{notice}；入队异常 {enqueue_error_count} 个，请查看详情"
    return notice, json.dumps(detail, ensure_ascii=False, default=str)


def _build_collection_center_redirect_url(
    *,
    notice: str = "",
    notice_detail: str = "",
    error: str = "",
    view: str = "",
    chain_key: str = "",
    coin_symbol: str = "",
    status: str = "",
    source: str = "",
    min_amount: str = "",
    user_id: str = "",
    address: str = "",
    page: str = "",
    per_page: str = "",
    next_path: str = "/admin/collections/center",
    anchor: str = "",
) -> str:
    base = next_path if next_path.startswith("/admin/collections/center") else "/admin/collections/center"
    params = []
    if view:
        params.append(f"view={quote(str(view))}")
    if chain_key:
        params.append(f"chain_key={quote(str(chain_key))}")
    if coin_symbol:
        params.append(f"coin_symbol={quote(str(coin_symbol))}")
    if status:
        params.append(f"status={quote(str(status))}")
    if source:
        params.append(f"source={quote(str(source))}")
    if min_amount:
        params.append(f"min_amount={quote(str(min_amount))}")
    if user_id:
        params.append(f"user_id={quote(str(user_id))}")
    if address:
        params.append(f"address={quote(str(address))}")
    if page:
        params.append(f"page={quote(str(page))}")
    if per_page:
        params.append(f"per_page={quote(str(per_page))}")
    if notice:
        params.append(f"notice={quote(notice)}")
    if notice_detail:
        params.append(f"notice_detail={quote(notice_detail)}")
    if error:
        params.append(f"error={quote(error)}")
    url = base
    if params:
        separator = "&" if "?" in base else "?"
        url = f"{base}{separator}{'&'.join(params)}"
    anchor_text = str(anchor or "").strip().lstrip("#")
    if anchor_text:
        url = f"{url}#{quote(anchor_text)}"
    return url


def _parse_collection_notice_detail(value: Any) -> Dict[str, Any]:
    raw = str(value or "").strip()
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except Exception:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _enqueue_created_collection_jobs(db: Session, result: Dict[str, Any]) -> Dict[str, Any]:
    collection_job_ids: list[str] = []
    gas_job_ids: list[str] = []
    errors: list[str] = []
    collection_task_ids = sorted({int(item) for item in result.get("created_task_ids") or [] if str(item).strip()})
    gas_task_ids = sorted({int(item) for item in result.get("created_gas_task_ids") or [] if str(item).strip()})

    for task_id in gas_task_ids:
        gas_task = db.query(GasTask).filter(GasTask.id == task_id).first()
        if not gas_task:
            errors.append(f"gas_task_not_found:{task_id}")
            continue
        if gas_task.status not in {GasTaskStatus.PENDING.value, GasTaskStatus.FAILED.value}:
            logger.debug(
                "skip gas task enqueue because status is not pending task_id=%s status=%s",
                task_id,
                gas_task.status,
            )
            continue
        try:
            job_id = enqueue_gas_task(task_id, allow_real_send=True)
            gas_job_ids.append(job_id)
            logger.info(
                "gas task created and enqueued task_id=%s task_no=%s chain_key=%s job_id=%s",
                task_id,
                gas_task.task_no,
                gas_task.chain_key,
                job_id,
            )
        except Exception as exc:
            errors.append(f"gas_task_enqueue_failed:{task_id}:{str(exc)[:120]}")
            logger.warning("gas task enqueue failed task_id=%s", task_id, exc_info=True)

    for task_id in collection_task_ids:
        task = db.query(CollectionTask).filter(CollectionTask.id == task_id).first()
        if not task:
            errors.append(f"collection_task_not_found:{task_id}")
            continue
        if task.status not in {CollectionTaskStatus.PENDING.value, CollectionTaskStatus.FAILED.value}:
            logger.debug(
                "skip collection task enqueue because status is not pending task_id=%s status=%s",
                task_id,
                task.status,
            )
            continue
        try:
            job_id = enqueue_collection_task(task_id, allow_real_send=True)
            collection_job_ids.append(job_id)
            logger.info(
                "collection task created and enqueued task_id=%s task_no=%s chain_key=%s job_id=%s",
                task_id,
                task.task_no,
                task.chain_key,
                job_id,
            )
        except Exception as exc:
            errors.append(f"collection_task_enqueue_failed:{task_id}:{str(exc)[:120]}")
            logger.warning("collection task enqueue failed task_id=%s", task_id, exc_info=True)

    return {
        "collection_job_ids": collection_job_ids,
        "gas_job_ids": gas_job_ids,
        "errors": errors,
    }


def _decimal_form_value(value: Any) -> str:
    text_value = str(value or "").strip()
    if not text_value:
        return ""
    try:
        amount = Decimal(text_value)
    except Exception:
        return ""
    return format(amount, "f")


def _load_manual_collection_chains(db: Session) -> list[Dict[str, Any]]:
    rows = db.execute(
        text(
            """
            SELECT id, chain_key, name, native_symbol, collection_address, hot_wallet_address
            FROM chains
            WHERE enabled = 1
            ORDER BY name ASC, chain_key ASC
            """
        )
    ).mappings().all()
    items: list[Dict[str, Any]] = []
    for row in rows:
        chain_key = str(row.get("chain_key") or "").strip().lower()
        capability = get_chain_capability(chain_key)
        if str(capability.get("runtime_status") or "").upper() != READY:
            continue
        if str(capability.get("chain_family") or "").upper() != EVM:
            continue
        if not capability.get("collection_supported"):
            continue
        items.append(
            {
                "id": row.get("id"),
                "chain_key": chain_key,
                "name": row.get("name") or chain_key,
                "native_symbol": row.get("native_symbol") or "",
                "collection_address": row.get("collection_address") or "",
                "hot_wallet_address": row.get("hot_wallet_address") or "",
            }
        )
    return items


def _load_manual_collection_assets(db: Session, chain_key: str) -> list[Dict[str, Any]]:
    ck = str(chain_key or "").strip().lower()
    if not ck:
        return []
    rows = db.execute(
        text(
            """
            SELECT ac.id AS asset_chain_id, a.symbol, a.name, ac.contract_address,
                   ac.decimals, ac.min_deposit
            FROM asset_chains ac
            JOIN assets a ON a.id = ac.asset_id
            JOIN chains c ON c.id = ac.chain_id
            WHERE LOWER(c.chain_key) = :chain_key
              AND c.enabled = 1
              AND ac.enabled = 1
              AND a.enabled = 1
              AND ac.deposit_enabled = 1
            ORDER BY CASE WHEN UPPER(a.symbol) = 'USDT' THEN 0 ELSE 1 END,
                     COALESCE(ac.sort, 0), a.symbol
            """
        ),
        {"chain_key": ck},
    ).mappings().all()
    return [
        {
            "asset_chain_id": row.get("asset_chain_id"),
            "symbol": str(row.get("symbol") or "").strip().upper(),
            "name": row.get("name") or row.get("symbol") or "",
            "contract_address": row.get("contract_address") or "",
            "decimals": row.get("decimals"),
            "min_deposit": _decimal_form_value(row.get("min_deposit")),
        }
        for row in rows
        if str(row.get("symbol") or "").strip()
    ]


def _manual_collection_min_amount(chain_key: str, asset_symbol: str, value: str = "") -> Decimal:
    raw = str(value or "").strip()
    if raw:
        amount = Decimal(raw)
        if amount <= 0:
            raise ValueError("最小归集金额必须大于 0")
        return amount
    return compute_min_collect_amount(chain_key=chain_key, coin_symbol=asset_symbol)


def _manual_collection_summary(scan: ScanResult) -> Dict[str, Any]:
    total_balance = sum((candidate.token_balance for candidate in scan.candidates), Decimal("0"))
    total_collect_amount = sum(
        (candidate.evaluation.collect_amount for candidate in scan.candidates if candidate.should_create_task),
        Decimal("0"),
    )
    gas_topup_amount = sum(
        (candidate.evaluation.gas_topup_amount for candidate in scan.candidates if candidate.evaluation.gas_required),
        Decimal("0"),
    )
    gas_coin_symbol = ""
    for candidate in scan.candidates:
        if candidate.evaluation.gas_required and candidate.evaluation.gas_coin_symbol:
            gas_coin_symbol = candidate.evaluation.gas_coin_symbol
            break
    return {
        "total_addresses": scan.total_addresses,
        "evaluated_count": scan.evaluated_count,
        "collectible_count": scan.collectible_count,
        "gas_required_count": scan.gas_required_count,
        "skipped_count": scan.skipped_count,
        "created_task_count": scan.created_task_count,
        "created_gas_task_count": scan.created_gas_task_count,
        "batch_id": scan.batch_id,
        "batch_no": scan.batch_no,
        "total_balance": format(total_balance, "f"),
        "total_collect_amount": format(total_collect_amount, "f"),
        "gas_topup_amount": format(gas_topup_amount, "f"),
        "gas_coin_symbol": gas_coin_symbol,
        "warnings": scan.warnings,
    }


def _build_gas_tasks_redirect_url(
    *,
    notice: str = "",
    error: str = "",
    next_path: str = "/admin/collections/gas-tasks",
) -> str:
    base = (
        next_path
        if next_path.startswith("/admin/collections/gas-tasks") or next_path.startswith("/admin/collections/tasks")
        else "/admin/collections/gas-tasks"
    )
    params = []
    if notice:
        params.append(f"notice={quote(notice)}")
    if error:
        params.append(f"error={quote(error)}")
    if not params:
        return base
    separator = "&" if "?" in base else "?"
    return f"{base}{separator}{'&'.join(params)}"


def _build_asset_configs_redirect_url(
    *,
    notice: str = "",
    success: str = "",
    warning: str = "",
    info: str = "",
    error: str = "",
    next_path: str = "/admin/asset-configs",
) -> str:
    fallback = "/admin/asset-configs"
    candidate = next_path if next_path.startswith(fallback) else fallback
    parts = urlsplit(candidate)
    path = parts.path if parts.path.startswith(fallback) else fallback
    params = [
        (key, value)
        for key, value in parse_qsl(parts.query, keep_blank_values=True)
        if key not in {"notice", "success", "warning", "info", "error"}
    ]
    if success:
        params.append(("success", success))
    if notice:
        params.append(("notice", notice))
    if warning:
        params.append(("warning", warning))
    if info:
        params.append(("info", info))
    if error:
        params.append(("error", error))
    return urlunsplit(("", "", path, urlencode(params, doseq=True), parts.fragment))


def _chain_same_wallet_warning(collection_address: str, hot_wallet_address: str) -> str:
    collection = str(collection_address or "").strip()
    hot_wallet = str(hot_wallet_address or "").strip()
    if collection and hot_wallet and collection.lower() == hot_wallet.lower():
        return "归集地址与热钱包地址相同，请确认这是否符合运营策略"
    return ""


def _chain_save_notice(
    *,
    ok: bool,
    action: str,
    chain_key: str,
    collection_address: str,
    hot_wallet_address: str,
) -> str:
    if not ok:
        return ""
    ck = str(chain_key or "").strip().lower()
    collection = str(collection_address or "").strip()
    hot_wallet = str(hot_wallet_address or "").strip()
    same_wallet_warning = (
        "归集地址与热钱包地址相同，请确认这是否符合运营策略"
        if collection and hot_wallet and collection.lower() == hot_wallet.lower()
        else ""
    )
    if not ck:
        return "网络配置保存成功"
    try:
        runtime_status = get_chain_runtime_status(ck)
    except Exception:
        runtime_status = ""
    if runtime_status == READY:
        missing = []
        if not hot_wallet:
            missing.append("缺少热钱包地址，预检仍会失败")
        if not collection:
            missing.append("缺少归集地址，预检仍会失败")
        if missing:
            notice = "保存成功，但就绪网络" + ", ".join(missing) + ""
            return notice + (same_wallet_warning if same_wallet_warning else "")
        return "保存成功，建议立即执行链能力预检" + (same_wallet_warning if same_wallet_warning else "")
    if runtime_status == CONFIG_ONLY:
        return "保存成功。该网络仍为仅配置状态，未完成验收前不能开放充值、提现" + (
            same_wallet_warning if same_wallet_warning else ""
        )
    return f"网络 {ck} 保存成功"


def _withdraw_fee_auto_enabled_value(value: Any) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "on", "yes", "enabled"}


def _refresh_chain_withdraw_fee_notice_legacy(db: Session, chain_key: str, auto_enabled: Any) -> str:
    return _refresh_chain_withdraw_fee_notice(db, chain_key, auto_enabled)
    if not _withdraw_fee_auto_enabled_value(auto_enabled):
        return ""
    ck = str(chain_key or "").strip().lower()
    if not ck:
        return "自动维护已启用；未能识别网络标识，暂未刷新手续费估算"
    try:
        result = maintain_withdraw_fee_once(db, chain_keys=[ck])
        db.commit()
    except Exception:
        db.rollback()
        return "自动维护已启用；手续费估算刷新失败，请查看最近错误"
    if int(result.get("failed") or 0) > 0:
        return "自动维护已启用；手续费估算刷新失败，请查看最近错误"
    if int(result.get("estimated") or 0) > 0:
        return "自动维护已启用；手续费估算已刷新"
    return "自动维护已启用；当前网络未启用或暂无可估算币种，暂未刷新估算"


def _refresh_chain_withdraw_fee_notice(db: Session, chain_key: str, auto_enabled: Any) -> str:
    if not _withdraw_fee_auto_enabled_value(auto_enabled):
        return ""
    ck = str(chain_key or "").strip().lower()
    if not ck:
        return "自动维护已启用，但未能识别网络标识，暂未提交手续费同步任务"
    try:
        result = enqueue_withdraw_fee_maintenance_job(chain_keys=[ck])
    except Exception:
        return "手续费同步任务提交失败，可点击“立即同步手续费”重试"
    if result.get("enqueued"):
        return "手续费同步任务已提交，请稍后查看更新时间"
    return "手续费同步任务已存在，请稍后查看更新时间"


def _build_bd_commission_redirect_url(
    *,
    notice: str = "",
    error: str = "",
    next_path: str = "/admin/bd/commissions",
) -> str:
    base = next_path if next_path.startswith("/admin/bd/commissions") else "/admin/bd/commissions"
    params = []
    if notice:
        params.append(f"notice={quote(notice)}")
    if error:
        params.append(f"error={quote(error)}")
    if not params:
        return base
    separator = "&" if "?" in base else "?"
    return f"{base}{separator}{'&'.join(params)}"


def _build_user_invite_commission_redirect_url(
    *,
    notice: str = "",
    error: str = "",
    next_path: str = "/admin/invite/commissions",
) -> str:
    base = next_path if next_path.startswith("/admin/invite/commissions") else "/admin/invite/commissions"
    params = []
    if notice:
        params.append(f"notice={quote(notice)}")
    if error:
        params.append(f"error={quote(error)}")
    if not params:
        return base
    separator = "&" if "?" in base else "?"
    return f"{base}{separator}{'&'.join(params)}"


def _build_bd_application_redirect_url(
    *,
    notice: str = "",
    error: str = "",
    next_path: str = "/admin/bd/applications",
) -> str:
    base = next_path if next_path.startswith("/admin/bd/applications") else "/admin/bd/applications"
    params = []
    if notice:
        params.append(f"notice={quote(notice)}")
    if error:
        params.append(f"error={quote(error)}")
    if not params:
        return base
    separator = "&" if "?" in base else "?"
    return f"{base}{separator}{'&'.join(params)}"


def _invite_commission_percent_input(config: Dict[str, Any]) -> str:
    return str((config or {}).get("commission_percent") or "15").strip()


def _build_reference_overlays_redirect_url(
    *,
    notice: str = "",
    error: str = "",
    next_path: str = "/admin/reference-overlays",
) -> str:
    base = next_path if next_path.startswith("/admin/reference-overlays") else "/admin/reference-overlays"
    params = []
    if notice:
        params.append(f"notice={quote(notice)}")
    if error:
        params.append(f"error={quote(error)}")
    if not params:
        return base
    separator = "&" if "?" in base else "?"
    return f"{base}{separator}{'&'.join(params)}"


def _build_admin_users_redirect_url(
    *,
    notice: str = "",
    error: str = "",
    next_path: str = "/admin/users",
) -> str:
    base = next_path if str(next_path or "").startswith("/admin/users") else "/admin/users"
    params = []
    if notice:
        params.append(f"notice={quote(notice)}")
    if error:
        params.append(f"error={quote(error)}")
    if not params:
        return base
    separator = "&" if "?" in base else "?"
    return f"{base}{separator}{'&'.join(params)}"


def _build_admin_user_accounts_redirect_url(
    *,
    notice: str = "",
    error: str = "",
    next_path: str = "/admin/admin-users",
) -> str:
    base = next_path if str(next_path or "").startswith("/admin/admin-users") else "/admin/admin-users"
    params = []
    if notice:
        params.append(f"notice={quote(notice)}")
    if error:
        params.append(f"error={quote(error)}")
    if not params:
        return base
    separator = "&" if "?" in base else "?"
    return f"{base}{separator}{'&'.join(params)}"


def _build_admin_roles_redirect_url(
    *,
    notice: str = "",
    error: str = "",
    next_path: str = "/admin/admin-roles",
) -> str:
    base = next_path if str(next_path or "").startswith("/admin/admin-roles") else "/admin/admin-roles"
    params = []
    if notice:
        params.append(f"notice={quote(notice)}")
    if error:
        params.append(f"error={quote(error)}")
    if not params:
        return base
    separator = "&" if "?" in base else "?"
    return f"{base}{separator}{'&'.join(params)}"


_ADMIN_ROLE_PERMISSION_DISPLAY: Dict[str, Dict[str, str]] = {
    "dashboard.view": {"name": "仪表盘查", "description": "可查看后台首页指标和运营概览"},
    "users.view": {"name": "用户管理查看", "description": "可查看用户列表、用户详情和用户基础信息"},
    "assets.view": {"name": "资产查询", "description": "可查看用户资产、平台资产与资产查询页面"},
    "balance_logs.view": {"name": "资金流水查看", "description": "可查看用户资金流水记"},
    "deposit_records.view": {"name": "充值记录查", "description": "可查看用户充值记"},
    "withdraw_records.view": {"name": "提现记录查看", "description": "可查看用户提现记"},
    "withdraw_anomalies.view": {"name": "提现异常治理", "description": "可查看提现异常候选并释放未广播冻结资"},
    "withdraw_reviews.view": {"name": "提现审核查看", "description": "可查看提现审核列表与详情"},
    "withdraw_reviews.manage": {"name": "提现审核管理", "description": "可通过或拒绝提现审"},
    "user_transfers.view": {"name": "站内划转查看", "description": "可查看用户站内划转记"},
    "platform_accounts.view": {"name": "平台账户查看", "description": "可查看平台账户与余额信息"},
    "platform_adjust.manage": {"name": "平台调账管理", "description": "可执行平台调账和查看调账结果"},
    "asset_configs.manage": {"name": "资产配置管理", "description": "可维护资产、链和资产链配置"},
    "orders.view": {"name": "现货订单查看", "description": "可查看现货订单列表和详情"},
    "trades.view": {"name": "现货成交查看", "description": "可查看现货成交记"},
    "market_analysis.view": {"name": "市场分析查看", "description": "可查看交易对运营分析看板"},
    "contract_orders.view": {"name": "合约订单查看", "description": "可查看合约订单列表和详情"},
    "contract_trades.view": {"name": "合约成交查看", "description": "可查看合约成交记"},
    "contract_positions.view": {"name": "合约持仓查看", "description": "可查看合约持仓数"},
    "contract_accounts.view": {"name": "合约账户查看", "description": "可查看合约账户资产与保证金信"},
    "contract_liquidations.view": {"name": "强平记录查看", "description": "可查看合约强平记"},
    "trading_pairs.manage": {"name": "交易对配置管", "description": "可新增、编辑、启停、删除现货交易对"},
    "fee_settings.manage": {"name": "现货手续费配置", "description": "可维护现货 RCB 手续费抵扣全局开关和抵扣比例"},
    "contract_symbols.manage": {"name": "合约品种配置管理", "description": "可新增、编辑、启停合约品"},
    "dealer_risk.manage": {"name": "Dealer 风控管理", "description": "可维护 Dealer 风控参数和启停风控规则"},
    "collection_tasks.manage": {"name": "归集任务管理", "description": "可执行归集任务试运行和真实发"},
    "gas_tasks.manage": {"name": "Gas 任务管理", "description": "可执行补 Gas 任务试运行和真实发"},
    "vip.view": {"name": "VIP 查看", "description": "可查看 VIP 等级、费率和用户 VIP 信息"},
    "dividend.view": {"name": "分红查看", "description": "可查看分红配置、分红池和分红记"},
    "dividends.distribute": {"name": "分红发放管理", "description": "可维护分红配置、计算分红池并执行分红发"},
    "bd.view": {"name": "BD 查看", "description": "可查看 BD 申请、账号和佣金记录"},
    "bd_accounts.manage": {"name": "BD账号与审核管理", "description": "可审核 BD 申请，并启用或停用 BD 账号"},
    "bd_commissions.manage": {"name": "BD佣金发放", "description": "可发放单笔或批量 BD 佣金"},
    "invite.view": {"name": "邀请查", "description": "可查看邀请关系和邀请佣金记"},
    "invite_commissions.manage": {"name": "邀请佣金发", "description": "可发放单笔或批量邀请佣"},
    "stock_locks.view": {"name": "股票锁仓查看", "description": "可查看股票锁仓配置和用户锁仓记录"},
    "stock_locks.manage": {"name": "股票锁仓管理", "description": "可维护股票锁仓配置并执行释放操作"},
    "site_settings.manage": {"name": "站点配置管理", "description": "可维护站点基础配置"},
    "banners.manage": {"name": "Banner 管理", "description": "可维护首页 Banner 和运营活动展示"},
    "announcements.manage": {"name": "公告管理", "description": "可维护公告内容和上下架状"},
    "site_content.manage": {"name": "内容管理", "description": "可维护站点配置、Banner、公告和图片上传"},
    "support_tickets.manage": {"name": "支持工单管理", "description": "可查看、回复和更新用户支持工单状态"},
    "audit.view": {"name": "操作审计查看", "description": "可查看后台操作审计记"},
    "admin_users.manage": {"name": "管理员账号管", "description": "可新增、启停、重置后台管理员账号，并执行用户账号高风险控"},
    "admin_roles.manage": {"name": "角色权限管理", "description": "可新增和编辑角色，并配置角色权限"},
    "export_tasks.view": {"name": "导出任务查看", "description": "可查看预留的导出任务入口"},
}


_ADMIN_ROLE_PERMISSION_GROUPS: tuple[tuple[str, str, tuple[str, ...]], ...] = (
    (
        "系统管理",
        "后台账号、角色权限、审计和系统级入口",
        ("dashboard.view", "admin_users.manage", "admin_roles.manage", "audit.view", "export_tasks.view"),
    ),
    (
        "用户与资",
        "用户资料、资金记录、提现审核、平台调账和资产配置",
        (
            "users.view",
            "assets.view",
            "balance_logs.view",
            "deposit_records.view",
            "withdraw_records.view",
            "withdraw_anomalies.view",
            "withdraw_reviews.view",
            "withdraw_reviews.manage",
            "user_transfers.view",
            "support_tickets.manage",
            "platform_accounts.view",
            "platform_adjust.manage",
            "asset_configs.manage",
            "admin_users.manage",
        ),
    ),
    (
        "交易配置",
        "现货、合约、交易对、合约品种和 Dealer 风控",
        (
            "orders.view",
            "trades.view",
            "market_analysis.view",
            "contract_orders.view",
            "contract_trades.view",
            "contract_positions.view",
            "contract_accounts.view",
            "contract_liquidations.view",
            "trading_pairs.manage",
            "fee_settings.manage",
            "contract_symbols.manage",
            "dealer_risk.manage",
        ),
    ),
    (
        "任务与链",
        "归集、补 Gas 和真实链上任务",
        ("collection_tasks.manage", "gas_tasks.manage"),
    ),
    (
        "会员与运",
        "VIP、分红、BD、邀请和股票锁仓运营能力",
        (
            "vip.view",
            "dividend.view",
            "dividends.distribute",
            "bd.view",
            "bd_accounts.manage",
            "bd_commissions.manage",
            "invite.view",
            "invite_commissions.manage",
            "stock_locks.view",
            "stock_locks.manage",
        ),
    ),
    (
        "内容管理",
        "站点配置、Banner、公告和运营内容",
        ("site_settings.manage", "banners.manage", "announcements.manage", "site_content.manage"),
    ),
)


def _build_admin_role_permission_groups(permission_groups: list[Dict[str, Any]]) -> list[Dict[str, Any]]:
    permissions_by_code: Dict[str, Dict[str, Any]] = {}
    for group in permission_groups:
        for permission in group.get("permissions", []):
            code = str(permission.get("code") or "")
            if code:
                permissions_by_code[code] = dict(permission)

    display_groups: list[Dict[str, Any]] = []
    configured_codes: set[str] = set()

    for title, description, codes in _ADMIN_ROLE_PERMISSION_GROUPS:
        permissions: list[Dict[str, Any]] = []
        for code in codes:
            permission = permissions_by_code.get(code)
            if not permission:
                continue
            meta = _ADMIN_ROLE_PERMISSION_DISPLAY.get(code, {})
            permissions.append(
                {
                    **permission,
                    "display_name": meta.get("name") or permission.get("name") or code,
                    "display_description": meta.get("description") or permission.get("description") or "",
                }
            )
            configured_codes.add(code)
        if permissions:
            display_groups.append({"title": title, "description": description, "permissions": permissions})

    extra_permissions: list[Dict[str, Any]] = []
    for code in sorted(permissions_by_code):
        if code in configured_codes:
            continue
        permission = permissions_by_code[code]
        meta = _ADMIN_ROLE_PERMISSION_DISPLAY.get(code, {})
        extra_permissions.append(
            {
                **permission,
                "display_name": meta.get("name") or permission.get("name") or code,
                "display_description": meta.get("description") or permission.get("description") or "暂未归类的权限点",
            }
        )
    if extra_permissions:
        display_groups.append({"title": "其他权限", "description": "尚未归入固定业务模块的权限点", "permissions": extra_permissions})

    return display_groups


def build_template_context(
    request: Request,
    ctx: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    admin = get_admin_from_request(request)
    rbac_context = {"is_super_admin": False, "permissions": set()}
    if admin and admin.get("id") is not None:
        db = SessionLocal()
        try:
            rbac_context = admin_get_current_admin_rbac_context(db, admin.get("id"))
        finally:
            db.close()

    data: Dict[str, Any] = {
        "request": request,
        "admin": admin,
        "current_admin_permissions": rbac_context.get("permissions") or set(),
        "is_super_admin": bool(rbac_context.get("is_super_admin")),
        "active_group": "",
        "active": "",
        "filters": {},
        "pagination": _default_pagination(),
    }
    if ctx:
        data.update(ctx)
    return data


def render(
    request: Request,
    tpl: str,
    ctx: Optional[Dict[str, Any]] = None,
    status_code: int = 200,
) -> Response:
    data = build_template_context(request, ctx)
    return templates.TemplateResponse(tpl, data, status_code=status_code)


def render_inline(
    request: Request,
    template_source: str,
    ctx: Optional[Dict[str, Any]] = None,
    status_code: int = 200,
) -> HTMLResponse:
    # Keep inline rendering only for the single audit placeholder page.
    # Real admin pages should continue to use standalone Jinja templates.
    data = build_template_context(request, ctx)
    template = templates.env.from_string(template_source)
    return HTMLResponse(content=template.render(**data), status_code=status_code)


def _set_admin_login_cookies(response: Response, admin_user: AdminUser) -> None:
    cookie_options = {
        "httponly": True,
        "samesite": "lax",
        "max_age": ADMIN_COOKIE_MAX_AGE,
    }
    response.set_cookie(key=COOKIE_NAME, value=COOKIE_VALUE, **cookie_options)
    response.set_cookie(key=ADMIN_USER_ID_COOKIE_NAME, value=str(admin_user.id), **cookie_options)
    response.set_cookie(key=ADMIN_USERNAME_COOKIE_NAME, value=quote(admin_user.username), **cookie_options)


def _delete_admin_login_cookies(response: Response) -> None:
    response.delete_cookie(COOKIE_NAME)
    response.delete_cookie(ADMIN_USER_ID_COOKIE_NAME)
    response.delete_cookie(ADMIN_USERNAME_COOKIE_NAME)


def _path_matches_admin_prefix(path: str, prefix: str) -> bool:
    return path == prefix or path.startswith(f"{prefix}/")


def _get_admin_get_permission_code(path: str) -> Optional[str]:
    permission_code = ADMIN_GET_PERMISSION_EXACT.get(path)
    if permission_code:
        return permission_code
    for prefix, prefix_permission_code in ADMIN_GET_PERMISSION_PREFIXES:
        if _path_matches_admin_prefix(path, prefix):
            return prefix_permission_code
    return None


def get_current_admin_rbac_context(request: Request, db: Session) -> Dict[str, Any]:
    admin = get_admin_from_request(request)
    if admin is None:
        return {"is_super_admin": False, "permissions": set()}
    return admin_get_current_admin_rbac_context(db, admin.get("id"))


def _render_admin_forbidden(request: Request) -> Response:
    try:
        return render(
            request,
            "admin/forbidden.html",
            ctx={"active_group": "system", "active": ""},
            status_code=403,
        )
    except Exception:
        return HTMLResponse(
            content=(
                "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"UTF-8\">"
                "<title>无权限访问</title></head><body>"
                "<h1>无权限访问</h1>"
                "<p>当前账号没有访问该页面的权限，请联系超级管理员。</p>"
                "</body></html>"
            ),
            status_code=403,
        )


def require_admin_permission(request: Request, db: Session, permission_code: str) -> Optional[Response]:
    try:
        rbac_context = get_current_admin_rbac_context(request, db)
    except Exception:
        return _render_admin_forbidden(request)

    if bool(rbac_context.get("is_super_admin")):
        return None
    if permission_code == ADMIN_PERMISSION_SUPER_ADMIN_ONLY:
        return _render_admin_forbidden(request)

    current_permissions = rbac_context.get("permissions") or set()
    if permission_code in current_permissions:
        return None
    return _render_admin_forbidden(request)


def _render_admin_post_forbidden() -> Response:
    return HTMLResponse(
        content=(
            "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"UTF-8\">"
            "<title>无权限操作</title></head><body>"
            f"<p>{ADMIN_POST_FORBIDDEN_MESSAGE}</p>"
            "</body></html>"
        ),
        status_code=403,
    )


def require_admin_post_permission(request: Request, db: Session, permission_code: str) -> Optional[Response]:
    redir = require_admin(request)
    if redir:
        return redir

    try:
        rbac_context = get_current_admin_rbac_context(request, db)
    except Exception:
        return _render_admin_post_forbidden()

    if bool(rbac_context.get("is_super_admin")):
        return None

    current_permissions = rbac_context.get("permissions") or set()
    if permission_code in current_permissions:
        return None
    return _render_admin_post_forbidden()


def require_admin(request: Request) -> Optional[Response]:
    if get_admin_from_request(request) is None:
        return RedirectResponse(url="/admin/login", status_code=302)
    if request.method.upper() != "GET":
        return None

    permission_code = _get_admin_get_permission_code(request.url.path)
    if permission_code is None:
        return None

    db = SessionLocal()
    try:
        return require_admin_permission(request, db, permission_code)
    finally:
        db.close()


@router.post("/uploads/image")
async def upload_admin_site_image(
    request: Request,
    file: UploadFile = File(...),
):
    if get_admin_from_request(request) is None:
        raise HTTPException(status_code=401, detail="Admin login required")
    db = SessionLocal()
    try:
        rbac_context = get_current_admin_rbac_context(request, db)
    finally:
        db.close()
    current_permissions = rbac_context.get("permissions") or set()
    if not (
        bool(rbac_context.get("is_super_admin"))
        or "site_content.manage" in current_permissions
        or "trading_pairs.manage" in current_permissions
    ):
        return _render_admin_post_forbidden()

    content_type = _normalize_upload_content_type(file.content_type)
    original_ext = Path(file.filename or "").suffix.lower()
    media_type = _validate_site_media_type(content_type, original_ext)

    max_bytes = UPLOAD_SITE_VIDEO_MAX_BYTES if media_type == "video" else UPLOAD_SITE_MEDIA_MAX_BYTES
    content = await file.read(max_bytes + 1)
    await file.close()
    if not content:
        raise HTTPException(status_code=400, detail="文件不能为空")
    if len(content) > max_bytes:
        if media_type == "video":
            raise HTTPException(status_code=400, detail="视频最大 100MB，上传后会自动转码压缩")
        raise HTTPException(status_code=400, detail="图片最大 20MB，上传后会自动压缩")

    upload_dir = _ensure_site_upload_dir()
    if media_type == "video":
        target = _transcode_site_video(content, original_ext, upload_dir)
    elif media_type == "svg":
        target = upload_dir / f"{uuid.uuid4().hex}{UPLOAD_SITE_MEDIA_DEFAULT_EXT[content_type]}"
        target.write_bytes(content)
        _ensure_output_within_limit(target, "图片最大 20MB，上传后会自动压缩")
    else:
        target = upload_dir / f"{uuid.uuid4().hex}.webp"
        _compress_site_image(content, target)

    filename = target.name
    url = f"/static/uploads/site/{filename}"
    return {"url": url, "location": url}


@router.post("/asset-configs/upload-asset-icon")
async def upload_asset_icon(
    request: Request,
    file: UploadFile = File(...),
):
    if get_admin_from_request(request) is None:
        raise HTTPException(status_code=401, detail="Admin login required")

    db = SessionLocal()
    try:
        redir = require_admin_post_permission(request, db, "asset_configs.manage")
    finally:
        db.close()
    if redir:
        return redir

    content_type = (file.content_type or "").lower()
    allowed_exts = UPLOAD_IMAGE_TYPES.get(content_type)
    if not allowed_exts:
        raise HTTPException(status_code=400, detail="Only PNG, JPEG, WebP and SVG images are allowed")

    content = await file.read(UPLOAD_IMAGE_MAX_BYTES + 1)
    await file.close()
    if not content:
        raise HTTPException(status_code=400, detail="Empty file")
    if len(content) > UPLOAD_IMAGE_MAX_BYTES:
        raise HTTPException(status_code=400, detail="Image must be 2MB or smaller")

    original_ext = Path(file.filename or "").suffix.lower()
    ext = original_ext if original_ext in allowed_exts else UPLOAD_IMAGE_DEFAULT_EXT[content_type]
    filename = f"asset_icon_{uuid.uuid4().hex}{ext}"
    upload_dir = BASE_DIR / "static" / "uploads" / "assets"
    upload_dir.mkdir(parents=True, exist_ok=True)
    target = upload_dir / filename
    target.write_bytes(content)
    url = f"/static/uploads/assets/{filename}"
    return {"ok": True, "url": url}


def render_placeholder_page(
    request: Request,
    *,
    title: str,
    page_title: str,
    message: str,
    active_group: str,
    active: str,
    filters: Dict[str, Any],
    pagination: Dict[str, Any],
    data_total: int,
) -> HTMLResponse:
    # Centralized placeholder rendering is intentionally limited to audit.
    # If a page enters real development, it should move to a dedicated template
    # instead of adding more transitional inline views here.
    return render_inline(
        request,
        PLACEHOLDER_PAGE_TEMPLATE,
        ctx={
            "title": title,
            "page_title": page_title,
            "message": message,
            "active_group": active_group,
            "active": active,
            "filters": filters,
            "pagination": pagination,
            "data_total": data_total,
        },
    )


def _build_platform_adjust_page_context(
    *,
    db: Session,
    coin_symbol: str = "",
    chain_key: str = "spot",
    page: int = 1,
    page_size: int = 20,
    form: Optional[Dict[str, Any]] = None,
    errors: Optional[list[str]] = None,
    notice: str = "",
    error: str = "",
) -> Dict[str, Any]:
    coin_symbol = _normalize_coin_symbol_value(coin_symbol)
    chain_key = _normalize_chain_key_value(chain_key, "spot")
    balance_filters = {
        "coin_symbol": coin_symbol,
        "chain_key": chain_key,
        "has_balance": "1",
        "has_frozen": "",
        "page": page,
        "page_size": page_size,
        "platform_user_id": PLATFORM_ACCOUNT_USER_ID,
    }
    balance_result = admin_query_platform_balances(db=db, filters=balance_filters)
    pagination = {
        "page": _result_page(balance_result),
        "page_size": _result_page_size(balance_result),
        "total": _result_total(balance_result),
        "pages": _result_pages(balance_result),
    }
    balance_filters_view = {
        "coin_symbol": coin_symbol,
        "chain_key": chain_key,
    }
    default_form = {
        "coin_symbol": coin_symbol,
        "chain_key": chain_key,
        "direction": "INCREASE",
        "amount": "",
        "reason": "",
        "remark": "",
        "confirm_text": "",
    }
    current_form = {**default_form, **(form or {})}
    balance_lookup = {}
    for item in _result_items(balance_result):
        lookup_key = f"{str(item.get('coin_symbol') or '').upper()}|{str(item.get('chain_key') or '').lower()}"
        balance_lookup[lookup_key] = {
            "available_amount": item.get("available_amount") or "0",
            "available_amount_raw": item.get("available_amount_raw") or item.get("available_amount") or "0",
        }
    return {
        "items": _result_items(balance_result),
        "platform_user_id": balance_result.get("platform_user_id", PLATFORM_ACCOUNT_USER_ID),
        "form": current_form,
        "balance_lookup": balance_lookup,
        "errors": errors or [],
        "notice": notice,
        "error": error,
        "active_group": "funds",
        "active": "platform_adjust",
        "filters": balance_filters_view,
        "balance_filters": balance_filters_view,
        "pagination": pagination,
    }


def _build_dealer_risk_page_context(
    *,
    db: Session,
    symbol: str = "",
    status: str = "",
    enabled: str = "",
    edit_id: Optional[int] = None,
    page: int = 1,
    page_size: int = 20,
    form: Optional[Dict[str, Any]] = None,
    errors: Optional[list[str]] = None,
    notice: str = "",
    error: str = "",
) -> Dict[str, Any]:
    symbol = _normalize_coin_symbol_value(symbol)
    status = str(status or "").strip().upper()
    enabled = str(enabled or "").strip()

    query_filters = {
        "symbol": symbol,
        "status": status,
        "enabled": enabled,
        "page": page,
        "page_size": page_size,
    }
    result = admin_query_dealer_risk_limits(db=db, filters=query_filters)
    pagination = {
        "page": _result_page(result),
        "page_size": _result_page_size(result),
        "total": _result_total(result),
        "pages": _result_pages(result),
    }
    filters = {
        "symbol": symbol,
        "status": status,
        "enabled": enabled,
    }

    edit_form = form
    if edit_form is None and edit_id:
        edit_form = admin_get_dealer_risk_limit(db, edit_id)

    default_form = {
        "id": "",
        "symbol": symbol,
        "enabled": "1",
        "status": "ACTIVE",
        "max_single_notional": "",
        "max_net_base_position": "",
        "max_net_quote_exposure": "",
        "remark": "",
    }
    edit_form = {**default_form, **(edit_form or {})}

    return {
        "items": _result_items(result),
        "form": edit_form,
        "editing": bool(edit_form.get("id")),
        "errors": errors or [],
        "notice": notice,
        "error": error,
        "active_group": "trade",
        "active": "dealer_risk",
        "filters": filters,
        "pagination": pagination,
    }


@router.get("", response_class=HTMLResponse)
def admin_index(request: Request):
    redir = require_admin(request)
    if redir:
        return redir
    return RedirectResponse(url="/admin/dashboard", status_code=302)


@router.get("/login", response_class=HTMLResponse)
def login_page(request: Request):
    if get_admin_from_request(request) is not None:
        return RedirectResponse(url="/admin/dashboard", status_code=302)
    return render(
        request,
        "admin/login.html",
        ctx=_admin_login_template_ctx(),
    )


@router.get("/login/captcha")
def login_captcha():
    try:
        captcha = _create_admin_login_captcha()
    except Exception:
        logger.exception("Failed to refresh admin login captcha")
        return JSONResponse(
            status_code=503,
            content={"ok": False, "message": ADMIN_LOGIN_CAPTCHA_UNAVAILABLE_MESSAGE},
        )
    return JSONResponse(
        content={"ok": True, "captcha": captcha},
        headers={"Cache-Control": "no-store"},
    )


@router.post("/login")
def login_submit(
    request: Request,
    username: str = Form(...),
    password: str = Form(...),
    captcha_id: str = Form(""),
    captcha_code: str = Form(""),
    db: Session = Depends(get_db),
):
    login_username = str(username or "").strip()
    login_password = str(password or "")

    captcha_ok, captcha_error = _verify_admin_login_captcha(captcha_id, captcha_code)
    if not captcha_ok:
        return render(
            request,
            "admin/login.html",
            ctx=_admin_login_template_ctx(error=captcha_error),
            status_code=400,
        )

    try:
        admin_user = db.query(AdminUser).filter(AdminUser.username == login_username).first()
    except (OperationalError, ProgrammingError):
        return render(
            request,
            "admin/login.html",
            ctx=_admin_login_template_ctx(error=ADMIN_RBAC_UNINITIALIZED_MESSAGE),
            status_code=500,
        )

    password_ok = False
    if admin_user is not None:
        try:
            password_ok = verify_password(login_password, admin_user.password_hash)
        except (ValueError, UnknownHashError):
            password_ok = False

    if admin_user is None or not password_ok:
        return render(
            request,
            "admin/login.html",
            ctx=_admin_login_template_ctx(error=ADMIN_LOGIN_INVALID_MESSAGE),
            status_code=400,
        )

    if str(admin_user.status or "").upper() != ADMIN_STATUS_ACTIVE:
        return render(
            request,
            "admin/login.html",
            ctx=_admin_login_template_ctx(error=ADMIN_LOGIN_DISABLED_MESSAGE),
            status_code=400,
        )

    admin_user.last_login_at = datetime.utcnow()
    admin_user.updated_at = datetime.utcnow()
    db.add(admin_user)
    db.commit()

    resp = RedirectResponse(url="/admin", status_code=302)
    _set_admin_login_cookies(resp, admin_user)
    return resp


@router.get("/dashboard", response_class=HTMLResponse)
def dashboard_page(
    request: Request,
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return redir

    metrics = get_dashboard_metrics(db=db)
    return render(
        request,
        "admin/dashboard.html",
        ctx={
            "metrics": metrics,
            "active_group": "overview",
            "active": "dashboard",
            "pagination": _default_pagination(),
        },
    )


@router.get("/funds-dashboard", response_class=HTMLResponse)
def funds_dashboard_page(
    request: Request,
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return redir

    funds_dashboard = admin_query_funds_dashboard(db=db)
    return render(
        request,
        "admin/funds_dashboard.html",
        ctx={
            "funds_dashboard": funds_dashboard,
            "active_group": "overview",
            "active": "funds_dashboard",
            "pagination": _default_pagination(),
        },
    )


@router.get("/trading-dashboard", response_class=HTMLResponse)
def trading_dashboard_page(
    request: Request,
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return redir

    trading_dashboard = admin_query_trading_dashboard(db=db)
    return render(
        request,
        "admin/trading_dashboard.html",
        ctx={
            "trading_dashboard": trading_dashboard,
            "active_group": "overview",
            "active": "trading_dashboard",
            "pagination": _default_pagination(),
        },
    )


@router.get("/risk-dashboard", response_class=HTMLResponse)
def risk_dashboard_page(
    request: Request,
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return redir

    risk_dashboard = admin_query_risk_dashboard(db=db)
    return render(
        request,
        "admin/risk_dashboard.html",
        ctx={
            "risk_dashboard": risk_dashboard,
            "active_group": "overview",
            "active": "risk_dashboard",
            "pagination": _default_pagination(),
        },
    )


@router.get("/users", response_class=HTMLResponse)
def users_page(
    request: Request,
    keyword: str = "",
    user_id: str = "",
    email: str = "",
    phone: str = "",
    status: str = "",
    kyc_level: str = "",
    source_type: str = "",
    registered_from: str = "",
    registered_to: str = "",
    page: int = 1,
    page_size: int = 20,
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return redir

    registered_from_text = str(registered_from or "").strip()
    registered_to_text = str(registered_to or "").strip()
    registered_from_value = _parse_admin_query_date(registered_from_text)
    registered_to_value = _parse_admin_query_date(registered_to_text)

    query_filters = {
        "user_id": user_id,
        "email": email,
        "phone": phone,
        "status": status,
        "kyc_level": kyc_level,
        "source_type": source_type,
        "registered_from": registered_from_value,
        "registered_to": registered_to_value,
        "page": page,
        "page_size": page_size,
    }
    result = get_admin_users(db=db, filters=query_filters)
    pagination = {
        "page": _result_page(result),
        "page_size": _result_page_size(result),
        "total": _result_total(result),
        "pages": _result_pages(result),
    }
    filters = {
        "keyword": "",
        "user_id": user_id,
        "email": email,
        "phone": phone,
        "status": status,
        "kyc_level": kyc_level,
        "source_type": source_type,
        "registered_from": registered_from_text if registered_from_value else "",
        "registered_to": registered_to_text if registered_to_value else "",
    }
    return render(
        request,
        "admin/users_list.html",
        ctx={
            "items": _result_items(result),
            "active_group": "users",
            "active": "users_list",
            "filters": filters,
            "pagination": pagination,
        },
    )


@router.get("/admin-users", response_class=HTMLResponse)
def admin_users_page(
    request: Request,
    username: str = "",
    status: str = "",
    role_code: str = "",
    notice: str = "",
    error: str = "",
    page: int = 1,
    page_size: int = 20,
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return redir

    current_admin = get_admin_from_request(request) or {}
    can_manage_admin_users = admin_user_is_super_admin(db, current_admin.get("id"))
    result = admin_query_admin_users(
        db,
        {
            "username": username,
            "status": status,
            "role_code": role_code,
            "page": page,
            "page_size": page_size,
        },
    )
    return render(
        request,
        "admin/admin_users.html",
        ctx={
            "items": _result_items(result),
            "active_group": "system",
            "active": "admin_users",
            "filters": _result_filters(result),
            "pagination": {
                "page": _result_page(result),
                "page_size": _result_page_size(result),
                "total": _result_total(result),
                "pages": _result_pages(result),
            },
            "notice": notice,
            "error": error,
            "active_roles": admin_list_active_roles(db),
            "can_manage_admin_users": can_manage_admin_users,
        },
    )


@router.post("/admin-users")
def create_admin_user_account(
    request: Request,
    username: str = Form(""),
    password: str = Form(""),
    confirm_password: str = Form(""),
    display_name: str = Form(""),
    email: str = Form(""),
    status: str = Form("ACTIVE"),
    role_codes: Optional[list[str]] = Form(None),
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "admin_users.manage")
    if redir:
        return redir

    current_admin = get_admin_from_request(request) or {}
    result = admin_create_admin_user(
        db,
        {
            "username": username,
            "password": password,
            "confirm_password": confirm_password,
            "display_name": display_name,
            "email": email,
            "status": status,
            "role_codes": role_codes,
        },
        current_admin_user_id=current_admin.get("id"),
    )
    return RedirectResponse(
        url=_build_admin_user_accounts_redirect_url(
            notice=result["message"] if result.get("ok") else "",
            error="" if result.get("ok") else result["message"],
        ),
        status_code=302,
    )


@router.post("/admin-users/{admin_user_id}/reset-password")
def reset_admin_user_password(
    request: Request,
    admin_user_id: int,
    password: str = Form(""),
    confirm_password: str = Form(""),
    next_path: str = Form("/admin/admin-users"),
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "admin_users.manage")
    if redir:
        return redir

    current_admin = get_admin_from_request(request) or {}
    result = admin_reset_admin_user_password(
        db,
        admin_user_id=admin_user_id,
        password=password,
        confirm_password=confirm_password,
        current_admin_user_id=current_admin.get("id"),
    )
    return RedirectResponse(
        url=_build_admin_user_accounts_redirect_url(
            notice=result["message"] if result.get("ok") else "",
            error="" if result.get("ok") else result["message"],
            next_path=next_path,
        ),
        status_code=302,
    )


@router.post("/admin-users/{admin_user_id}/disable")
def disable_admin_user_account(
    request: Request,
    admin_user_id: int,
    next_path: str = Form("/admin/admin-users"),
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "admin_users.manage")
    if redir:
        return redir

    current_admin = get_admin_from_request(request) or {}
    result = admin_set_admin_user_status(
        db,
        admin_user_id=admin_user_id,
        status="DISABLED",
        current_admin_user_id=current_admin.get("id"),
    )
    return RedirectResponse(
        url=_build_admin_user_accounts_redirect_url(
            notice=result["message"] if result.get("ok") else "",
            error="" if result.get("ok") else result["message"],
            next_path=next_path,
        ),
        status_code=302,
    )


@router.post("/admin-users/{admin_user_id}/enable")
def enable_admin_user_account(
    request: Request,
    admin_user_id: int,
    next_path: str = Form("/admin/admin-users"),
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "admin_users.manage")
    if redir:
        return redir

    result = admin_set_admin_user_status(
        db,
        admin_user_id=admin_user_id,
        status="ACTIVE",
        current_admin_user_id=(get_admin_from_request(request) or {}).get("id"),
    )
    return RedirectResponse(
        url=_build_admin_user_accounts_redirect_url(
            notice=result["message"] if result.get("ok") else "",
            error="" if result.get("ok") else result["message"],
            next_path=next_path,
        ),
        status_code=302,
    )


@router.get("/admin-roles", response_class=HTMLResponse)
def admin_roles_page(
    request: Request,
    code: str = "",
    status: str = "",
    notice: str = "",
    error: str = "",
    page: int = 1,
    page_size: int = 20,
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return redir

    current_admin = get_admin_from_request(request) or {}
    can_manage_admin_roles = admin_user_is_super_admin(db, current_admin.get("id"))
    result = admin_query_admin_roles(
        db,
        {
            "code": code,
            "status": status,
            "page": page,
            "page_size": page_size,
        },
    )
    return render(
        request,
        "admin/admin_roles.html",
        ctx={
            "items": _result_items(result),
            "active_group": "system",
            "active": "admin_roles",
            "filters": _result_filters(result),
            "pagination": {
                "page": _result_page(result),
                "page_size": _result_page_size(result),
                "total": _result_total(result),
                "pages": _result_pages(result),
            },
            "permission_groups": _build_admin_role_permission_groups(admin_list_permissions_by_group(db)),
            "role_permission_ids": admin_get_all_role_permission_ids(db),
            "can_manage_admin_roles": can_manage_admin_roles,
            "notice": notice,
            "error": error,
        },
    )


@router.post("/admin-roles")
def create_admin_role(
    request: Request,
    code: str = Form(""),
    name: str = Form(""),
    description: str = Form(""),
    status: str = Form("ACTIVE"),
    permission_ids: Optional[list[int]] = Form(None),
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "admin_roles.manage")
    if redir:
        return redir

    result = admin_create_admin_role(
        db,
        {
            "code": code,
            "name": name,
            "description": description,
            "status": status,
        },
        current_admin_user_id=(get_admin_from_request(request) or {}).get("id"),
    )
    if result.get("ok") and result.get("role_id") and permission_ids:
        permission_result = admin_update_admin_role_permissions(
            db,
            int(result["role_id"]),
            permission_ids,
            current_admin_user_id=(get_admin_from_request(request) or {}).get("id"),
        )
        if not permission_result.get("ok"):
            result = permission_result
    return RedirectResponse(
        url=_build_admin_roles_redirect_url(
            notice=result["message"] if result.get("ok") else "",
            error="" if result.get("ok") else result["message"],
        ),
        status_code=302,
    )


@router.post("/admin-roles/{role_id}/edit")
def update_admin_role(
    request: Request,
    role_id: int,
    name: str = Form(""),
    description: str = Form(""),
    status: str = Form("ACTIVE"),
    next_path: str = Form("/admin/admin-roles"),
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "admin_roles.manage")
    if redir:
        return redir

    result = admin_update_admin_role(
        db,
        role_id,
        {
            "name": name,
            "description": description,
            "status": status,
        },
        current_admin_user_id=(get_admin_from_request(request) or {}).get("id"),
    )
    return RedirectResponse(
        url=_build_admin_roles_redirect_url(
            notice=result["message"] if result.get("ok") else "",
            error="" if result.get("ok") else result["message"],
            next_path=next_path,
        ),
        status_code=302,
    )


@router.post("/admin-roles/{role_id}/permissions")
def update_admin_role_permissions(
    request: Request,
    role_id: int,
    permission_ids: Optional[list[int]] = Form(None),
    next_path: str = Form("/admin/admin-roles"),
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "admin_roles.manage")
    if redir:
        return redir

    result = admin_update_admin_role_permissions(
        db,
        role_id,
        permission_ids,
        current_admin_user_id=(get_admin_from_request(request) or {}).get("id"),
    )
    return RedirectResponse(
        url=_build_admin_roles_redirect_url(
            notice=result["message"] if result.get("ok") else "",
            error="" if result.get("ok") else result["message"],
            next_path=next_path,
        ),
        status_code=302,
    )


@router.post("/admin-roles/{role_id}/delete")
def delete_admin_role(
    request: Request,
    role_id: int,
    next_path: str = Form("/admin/admin-roles"),
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "admin_roles.manage")
    if redir:
        return redir

    result = admin_delete_admin_role(
        db,
        role_id,
        current_admin_user_id=(get_admin_from_request(request) or {}).get("id"),
    )
    return RedirectResponse(
        url=_build_admin_roles_redirect_url(
            notice=result["message"] if result.get("ok") else "",
            error="" if result.get("ok") else result["message"],
            next_path=next_path,
        ),
        status_code=302,
    )


@router.post("/users/{user_id}/disable")
def disable_user_account(
    request: Request,
    user_id: int,
    next_path: str = Form("/admin/users"),
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "admin_users.manage")
    if redir:
        return redir

    try:
        user = db.query(User).filter(User.id == user_id).first()
        if not user:
            return RedirectResponse(
                url=_build_admin_users_redirect_url(error=f"用户 {user_id} 不存", next_path=next_path),
                status_code=302,
            )
        user.status = 2
        db.commit()
        return RedirectResponse(
            url=_build_admin_users_redirect_url(notice=f"用户 {user_id} 已停", next_path=next_path),
            status_code=302,
        )
    except Exception as exc:
        db.rollback()
        return RedirectResponse(
            url=_build_admin_users_redirect_url(error=f"停用账户失败：{exc}", next_path=next_path),
            status_code=302,
        )


@router.post("/users/{user_id}/enable")
def enable_user_account(
    request: Request,
    user_id: int,
    next_path: str = Form("/admin/users"),
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "admin_users.manage")
    if redir:
        return redir

    try:
        user = db.query(User).filter(User.id == user_id).first()
        if not user:
            return RedirectResponse(
                url=_build_admin_users_redirect_url(error=f"用户 {user_id} 不存", next_path=next_path),
                status_code=302,
            )
        user.status = 1
        db.commit()
        return RedirectResponse(
            url=_build_admin_users_redirect_url(notice=f"用户 {user_id} 已启", next_path=next_path),
            status_code=302,
        )
    except Exception as exc:
        db.rollback()
        return RedirectResponse(
            url=_build_admin_users_redirect_url(error=f"启用账户失败：{exc}", next_path=next_path),
            status_code=302,
        )


@router.post("/users/{user_id}/withdraw-lock")
def lock_user_withdraw(
    request: Request,
    user_id: int,
    reason: str = Form(DEFAULT_WITHDRAW_LOCK_REASON),
    next_path: str = Form("/admin/users"),
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "admin_users.manage")
    if redir:
        return redir

    admin = get_admin_from_request(request) or {}
    try:
        set_user_withdraw_lock(
            db,
            user_id=user_id,
            locked=True,
            reason=reason,
            admin_user=str(admin.get("username") or "").strip() or None,
            admin_user_id=admin.get("id"),
            admin_ip=get_client_ip(request),
            user_agent=get_user_agent(request),
        )
        return RedirectResponse(
            url=_build_admin_users_redirect_url(notice=f"用户 {user_id} 已锁定出", next_path=next_path),
            status_code=302,
        )
    except Exception as exc:
        db.rollback()
        return RedirectResponse(
            url=_build_admin_users_redirect_url(error=f"锁定出金失败：{exc}", next_path=next_path),
            status_code=302,
        )


@router.post("/users/{user_id}/withdraw-unlock")
def unlock_user_withdraw(
    request: Request,
    user_id: int,
    next_path: str = Form("/admin/users"),
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "admin_users.manage")
    if redir:
        return redir

    admin = get_admin_from_request(request) or {}
    try:
        set_user_withdraw_lock(
            db,
            user_id=user_id,
            locked=False,
            reason="解锁出金",
            admin_user=str(admin.get("username") or "").strip() or None,
            admin_user_id=admin.get("id"),
            admin_ip=get_client_ip(request),
            user_agent=get_user_agent(request),
        )
        return RedirectResponse(
            url=_build_admin_users_redirect_url(notice=f"用户 {user_id} 已解锁出", next_path=next_path),
            status_code=302,
        )
    except Exception as exc:
        db.rollback()
        return RedirectResponse(
            url=_build_admin_users_redirect_url(error=f"解锁出金失败：{exc}", next_path=next_path),
            status_code=302,
        )


@router.get("/assets", response_class=HTMLResponse)
def assets_page(
    request: Request,
    user_id: str = "",
    keyword: str = "",
    coin_symbol: str = "",
    chain_key: str = "",
    account_type: str = "",
    non_zero_only: str = "1",
    has_frozen: str = "",
    page: int = 1,
    page_size: int = 20,
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return redir

    query_filters = {
        "user_id": user_id,
        "keyword": keyword,
        "coin_symbol": coin_symbol,
        "chain_key": chain_key or account_type,
        "account_type": account_type or chain_key,
        "non_zero_only": non_zero_only,
        "has_frozen": has_frozen,
        "page": page,
        "page_size": page_size,
    }
    result = get_admin_balances(db=db, filters=query_filters)
    pagination = {
        "page": _result_page(result),
        "page_size": _result_page_size(result),
        "total": _result_total(result),
        "pages": _result_pages(result),
    }
    filters = {
        "user_id": user_id,
        "keyword": keyword,
        "coin_symbol": coin_symbol,
        "chain_key": chain_key or account_type,
        "account_type": account_type or chain_key,
        "non_zero_only": non_zero_only,
        "has_frozen": has_frozen,
    }
    return render(
        request,
        "admin/assets_query.html",
        ctx={
            "items": _result_items(result),
            "active_group": "funds",
            "active": "assets_query",
            "filters": filters,
            "pagination": pagination,
        },
    )


@router.get("/deposit-records", response_class=HTMLResponse)
def deposit_records_page(
    request: Request,
    deposit_id: str = "",
    deposit_no: str = "",
    user_id: str = "",
    coin_symbol: str = "",
    chain_key: str = "",
    chain: str = "",
    status: str = "",
    txid: str = "",
    tx_hash: str = "",
    request_id: str = "",
    address: str = "",
    date_from: str = "",
    date_to: str = "",
    start_time: str = "",
    end_time: str = "",
    created_from: str = "",
    created_to: str = "",
    notice: str = "",
    error: str = "",
    page: int = 1,
    page_size: int = 20,
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return redir

    deposit_id_value = _clean_query_text(deposit_id)
    deposit_no_value = _clean_query_text(deposit_no)
    user_id_value = _clean_query_text(user_id)
    coin_symbol_value = _clean_query_text(coin_symbol).upper()
    chain_key_value = _clean_query_text(chain_key or chain).lower()
    status_value = _clean_query_text(status).upper()
    tx_hash_value = _clean_query_text(tx_hash or txid)
    request_id_value = _clean_query_text(request_id)
    address_value = _clean_query_text(address)
    notice_value = _clean_query_text(notice)
    error_value = _clean_query_text(error)
    range_from, range_to, query_notices, used_default_range = _balance_log_date_range(
        date_from_text=date_from or start_time,
        date_to_text=date_to or end_time,
        created_from_text=created_from,
        created_to_text=created_to,
    )
    range_days = (range_to - range_from).days + 1
    has_precise_condition = _balance_log_has_precise_condition(
        user_id_value,
        deposit_id_value,
        deposit_no_value,
        tx_hash_value,
        request_id_value,
        status_value,
    )
    range_blocked = range_days > 30 and not has_precise_condition
    if range_blocked:
        query_notices.append(DEPOSIT_RECORDS_RANGE_BLOCK_NOTICE)
        range_from, range_to = _narrow_admin_range_to_30_days(range_to)
        range_days = 30
    active_range_days = range_days if range_days in {7, 15, 30} else (7 if used_default_range else 0)
    today = get_admin_today_date()
    quick_ranges = [
        {
            "days": days,
            "date_from": (today - timedelta(days=days - 1)).isoformat(),
            "date_to": today.isoformat(),
        }
        for days in (7, 15, 30)
    ]
    query_filters = {
        "deposit_id": deposit_id_value,
        "deposit_no": deposit_no_value,
        "user_id": user_id_value,
        "coin_symbol": coin_symbol_value,
        "chain_key": chain_key_value,
        "status": status_value,
        "txid": tx_hash_value,
        "tx_hash": tx_hash_value,
        "request_id": request_id_value,
        "address": address_value,
        "created_from": range_from.isoformat(),
        "created_to": range_to.isoformat(),
        "date_from": range_from.isoformat(),
        "date_to": range_to.isoformat(),
        "page": page,
        "page_size": page_size,
    }
    result = admin_query_deposit_records(db=db, filters=query_filters)
    query_notice = " ".join(query_notices)
    return render(
        request,
        "admin/deposit_records.html",
        ctx={
            "items": _result_items(result),
            "active_group": "funds",
            "active": "deposit_records",
            "filters": {
                "deposit_id": deposit_id_value,
                "deposit_no": deposit_no_value,
                "user_id": user_id_value,
                "coin_symbol": _result_filters(result).get("coin_symbol", ""),
                "chain_key": _result_filters(result).get("chain_key", ""),
                "status": _result_filters(result).get("status", ""),
                "txid": tx_hash_value,
                "tx_hash": tx_hash_value,
                "request_id": request_id_value,
                "address": address_value,
                "created_from": range_from.isoformat(),
                "created_to": range_to.isoformat(),
                "date_from": range_from.isoformat(),
                "date_to": range_to.isoformat(),
            },
            "pagination": {
                "page": _result_page(result),
                "page_size": _result_page_size(result),
                "total": _result_total(result),
                "pages": _result_pages(result),
            },
            "large_table_notice": DEPOSIT_RECORDS_LARGE_TABLE_NOTICE,
            "query_notice": query_notice,
            "notice": notice_value,
            "error": error_value,
            "quick_ranges": quick_ranges,
            "active_range_days": active_range_days,
        },
    )


@router.post("/deposit-records/{deposit_id}/recheck-chain-confirmation")
def recheck_deposit_chain_confirmation_action(
    request: Request,
    deposit_id: int,
    next_path: str = Form("/admin/deposit-records"),
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "deposit_records.view")
    if redir:
        return redir

    try:
        result = recheck_deposit_chain_confirmation(db, int(deposit_id))
        db.commit()
    except Exception as exc:
        db.rollback()
        return RedirectResponse(
            url=_build_deposit_records_redirect_url(
                next_path=next_path,
                error=f"链上查询失败，请稍后重试：{str(exc)[:160]}",
            ),
            status_code=303,
        )

    if result.error_message and result.status not in {"PENDING", "ALREADY_CONFIRMED", "ALREADY_CREDITED"}:
        return RedirectResponse(
            url=_build_deposit_records_redirect_url(next_path=next_path, error=result.message),
            status_code=303,
        )
    return RedirectResponse(
        url=_build_deposit_records_redirect_url(next_path=next_path, notice=result.message),
        status_code=303,
    )


@router.get("/withdraw-records", response_class=HTMLResponse)
def withdraw_records_page(
    request: Request,
    withdraw_id: str = "",
    withdraw_no: str = "",
    user_id: str = "",
    coin_symbol: str = "",
    chain_key: str = "",
    chain: str = "",
    status: str = "",
    tx_hash: str = "",
    request_id: str = "",
    to_address: str = "",
    date_from: str = "",
    date_to: str = "",
    start_time: str = "",
    end_time: str = "",
    created_from: str = "",
    created_to: str = "",
    notice: str = "",
    error: str = "",
    page: int = 1,
    page_size: int = 20,
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "contract_symbols.manage")
    if redir:
        return redir

    withdraw_id_value = _clean_query_text(withdraw_id)
    withdraw_no_value = _clean_query_text(withdraw_no)
    user_id_value = _clean_query_text(user_id)
    coin_symbol_value = _clean_query_text(coin_symbol).upper()
    chain_key_value = _clean_query_text(chain_key or chain).lower()
    status_value = _clean_query_text(status).upper()
    tx_hash_value = _clean_query_text(tx_hash)
    request_id_value = _clean_query_text(request_id)
    to_address_value = _clean_query_text(to_address)
    has_explicit_date_filter = any(
        _clean_query_text(value)
        for value in (date_from, date_to, start_time, end_time, created_from, created_to)
    )
    skip_default_date_filter = status_value == "FAILED_GROUP" and not has_explicit_date_filter
    range_from, range_to, query_notices, used_default_range = _balance_log_date_range(
        date_from_text=date_from or start_time,
        date_to_text=date_to or end_time,
        created_from_text=created_from,
        created_to_text=created_to,
    )
    range_days = 0 if skip_default_date_filter else (range_to - range_from).days + 1
    created_from_filter = "" if skip_default_date_filter else range_from.isoformat()
    created_to_filter = "" if skip_default_date_filter else range_to.isoformat()
    has_precise_condition = _balance_log_has_precise_condition(
        user_id_value,
        withdraw_id_value,
        withdraw_no_value,
        tx_hash_value,
        request_id_value,
        status_value,
    )
    range_blocked = False if skip_default_date_filter else range_days > 30 and not has_precise_condition
    if range_blocked:
        query_notices.append(WITHDRAW_RECORDS_RANGE_BLOCK_NOTICE)
        range_from, range_to = _narrow_admin_range_to_30_days(range_to)
        range_days = 30
        created_from_filter = range_from.isoformat()
        created_to_filter = range_to.isoformat()
    active_range_days = 0 if skip_default_date_filter else (range_days if range_days in {7, 15, 30} else (7 if used_default_range else 0))
    today = get_admin_today_date()
    quick_ranges = [
        {
            "days": days,
            "date_from": (today - timedelta(days=days - 1)).isoformat(),
            "date_to": today.isoformat(),
        }
        for days in (7, 15, 30)
    ]
    query_filters = {
        "withdraw_id": withdraw_id_value,
        "withdraw_no": withdraw_no_value,
        "user_id": user_id_value,
        "coin_symbol": coin_symbol_value,
        "chain_key": chain_key_value,
        "status": status_value,
        "tx_hash": tx_hash_value,
        "request_id": request_id_value,
        "to_address": to_address_value,
        "created_from": created_from_filter,
        "created_to": created_to_filter,
        "date_from": created_from_filter,
        "date_to": created_to_filter,
        "page": page,
        "page_size": page_size,
    }
    result = admin_query_withdraw_records(db=db, filters=query_filters)
    anomaly_summary = result.get("anomaly_summary")
    if anomaly_summary is None:
        anomaly_summary = admin_query_withdraw_anomalies(db, limit=100).get("summary", {})
    query_notice = " ".join(query_notices)
    return render(
        request,
        "admin/withdraw_records.html",
        ctx={
            "items": _result_items(result),
            "active_group": "funds",
            "active": "withdraw_records",
            "filters": {
                "withdraw_id": withdraw_id_value,
                "withdraw_no": withdraw_no_value,
                "user_id": user_id_value,
                "coin_symbol": _result_filters(result).get("coin_symbol", ""),
                "chain_key": _result_filters(result).get("chain_key", ""),
                "status": _result_filters(result).get("status", ""),
                "tx_hash": tx_hash_value,
                "request_id": request_id_value,
                "to_address": to_address_value,
                "created_from": created_from_filter,
                "created_to": created_to_filter,
                "date_from": created_from_filter,
                "date_to": created_to_filter,
            },
            "pagination": {
                "page": _result_page(result),
                "page_size": _result_page_size(result),
                "total": _result_total(result),
                "pages": _result_pages(result),
            },
            "large_table_notice": WITHDRAW_RECORDS_LARGE_TABLE_NOTICE,
            "anomaly_summary": anomaly_summary,
            "query_notice": query_notice,
            "notice": _clean_query_text(notice),
            "error": _clean_query_text(error),
            "quick_ranges": quick_ranges,
            "active_range_days": active_range_days,
        },
    )


@router.post("/withdraw-records/{withdraw_id}/release-frozen")
def withdraw_record_release_frozen(
    request: Request,
    withdraw_id: int,
    release_amount: str = Form(""),
    confirm_text: str = Form(""),
    next_path: str = Form("/admin/withdraw-records"),
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "withdraw_reviews.manage")
    if redir:
        return redir

    if str(confirm_text or "").strip().upper() != "RELEASE":
        return RedirectResponse(
            url=_build_withdraw_records_redirect_url(
                next_path=next_path,
                error="请输入 RELEASE 确认取消提现并释放冻结金额",
            ),
            status_code=302,
        )

    try:
        result = admin_release_unbroadcast_withdraw_frozen(
            db,
            int(withdraw_id),
            release_amount=release_amount,
            admin_note="ADMIN_RELEASE_UNBROADCAST: chain tx not broadcast, frozen balance released",
        )
        db.commit()
        released = ", ".join(
            f"{item.get('amount')} {item.get('coin_symbol')}" for item in result.get("released", [])
        )
        notice = f"冻结金额已释放：提现 {withdraw_id}，{released or '-'}"
        error = ""
    except AdminWithdrawUnfreezeError as exc:
        db.rollback()
        notice = ""
        error = str(exc)
    except Exception as exc:
        db.rollback()
        notice = ""
        error = f"释放提现冻结金额失败：{exc}"

    return RedirectResponse(
        url=_build_withdraw_records_redirect_url(next_path=next_path, notice=notice, error=error),
        status_code=302,
    )


@router.get("/withdraw-anomalies", response_class=HTMLResponse)
def withdraw_anomalies_page(
    request: Request,
    limit: int = 50,
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return redir

    result = admin_query_withdraw_anomalies(db, limit=limit)
    return render(
        request,
        "admin/withdraw_anomalies.html",
        ctx={
            "active_group": "funds",
            "active": "withdraw_anomalies",
            "limit": result.get("limit", limit),
            "summary": result.get("summary", {}),
            "failed_frozen_candidates": result.get("failed_frozen_candidates", []),
            "fee_issues": result.get("fee_issues", []),
            "precheck_failures": result.get("precheck_failures", []),
            "amount_net_mismatch": result.get("amount_net_mismatch", []),
        },
    )


@router.get("/user-transfers", response_class=HTMLResponse)
def user_transfers_page(
    request: Request,
    transfer_id: str = "",
    transfer_no: str = "",
    user_id: str = "",
    from_user_id: str = "",
    to_user_id: str = "",
    coin_symbol: str = "",
    request_id: str = "",
    direction: str = "all",
    status: str = "",
    date_from: str = "",
    date_to: str = "",
    start_time: str = "",
    end_time: str = "",
    created_from: str = "",
    created_to: str = "",
    page: int = 1,
    page_size: int = 20,
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return redir

    transfer_id_value = _clean_query_text(transfer_id)
    transfer_no_value = _clean_query_text(transfer_no)
    user_id_value = _clean_query_text(user_id)
    from_user_id_value = _clean_query_text(from_user_id)
    to_user_id_value = _clean_query_text(to_user_id)
    coin_symbol_value = _clean_query_text(coin_symbol).upper()
    request_id_value = _clean_query_text(request_id)
    direction_value = _clean_query_text(direction).lower() or "all"
    status_value = _clean_query_text(status).upper()
    range_from, range_to, query_notices, used_default_range = _balance_log_date_range(
        date_from_text=date_from or start_time,
        date_to_text=date_to or end_time,
        created_from_text=created_from,
        created_to_text=created_to,
    )
    range_days = (range_to - range_from).days + 1
    has_precise_condition = _balance_log_has_precise_condition(
        transfer_id_value,
        transfer_no_value,
        from_user_id_value,
        to_user_id_value,
        user_id_value,
        coin_symbol_value,
        request_id_value,
    )
    range_blocked = range_days > 30 and not has_precise_condition
    if range_blocked:
        query_notices.append(USER_TRANSFERS_RANGE_BLOCK_NOTICE)
    active_range_days = range_days if range_days in {7, 15, 30} else (7 if used_default_range else 0)
    today = get_admin_today_date()
    quick_ranges = [
        {
            "days": days,
            "date_from": (today - timedelta(days=days - 1)).isoformat(),
            "date_to": today.isoformat(),
        }
        for days in (7, 15, 30)
    ]
    query_filters = {
        "transfer_id": transfer_id_value,
        "transfer_no": transfer_no_value,
        "user_id": user_id_value,
        "from_user_id": from_user_id_value,
        "to_user_id": to_user_id_value,
        "coin_symbol": coin_symbol_value,
        "request_id": request_id_value,
        "direction": direction_value,
        "status": status_value,
        "created_from": range_from.isoformat(),
        "created_to": range_to.isoformat(),
        "date_from": range_from.isoformat(),
        "date_to": range_to.isoformat(),
        "page": page,
        "page_size": page_size,
    }
    if range_blocked:
        result = {
            "items": [],
            "filters": query_filters,
            "pagination": {"page": 1, "page_size": page_size, "total": 0, "pages": 1},
            "total": 0,
            "page": 1,
            "page_size": page_size,
            "pages": 1,
        }
    else:
        result = admin_query_user_transfer_records(db=db, filters=query_filters)
    result_filters = _result_filters(result)
    query_notice = " ".join(query_notices)
    return render(
        request,
        "admin/user_transfers.html",
        ctx={
            "items": _result_items(result),
            "active_group": "funds",
            "active": "user_transfers",
            "filters": {
                "transfer_id": result_filters.get("transfer_id", ""),
                "transfer_no": result_filters.get("transfer_no", ""),
                "user_id": result_filters.get("user_id", ""),
                "from_user_id": result_filters.get("from_user_id", ""),
                "to_user_id": result_filters.get("to_user_id", ""),
                "coin_symbol": result_filters.get("coin_symbol", ""),
                "request_id": result_filters.get("request_id", ""),
                "direction": result_filters.get("direction", ""),
                "status": result_filters.get("status", ""),
                "created_from": range_from.isoformat(),
                "created_to": range_to.isoformat(),
                "date_from": range_from.isoformat(),
                "date_to": range_to.isoformat(),
            },
            "pagination": {
                "page": _result_page(result),
                "page_size": _result_page_size(result),
                "total": _result_total(result),
                "pages": _result_pages(result),
            },
            "large_table_notice": USER_TRANSFERS_LARGE_TABLE_NOTICE,
            "query_notice": query_notice,
            "quick_ranges": quick_ranges,
            "active_range_days": active_range_days,
        },
    )


BALANCE_LOG_CHANGE_TYPE_OPTIONS = [
    ("DEPOSIT", "充值到"),
    ("WITHDRAW_FREEZE", "提现冻结"),
    ("WITHDRAW_FEE_FREEZE", "提现手续费冻"),
    ("WITHDRAW_SUCCESS", "提现成功"),
    ("WITHDRAW_FEE_SUCCESS", "提现手续费扣"),
    ("WITHDRAW_UNFREEZE", "提现解冻"),
    ("WITHDRAW_FEE_UNFREEZE", "提现手续费解"),
    ("WITHDRAW_CANCEL", "提现取消"),
    ("WITHDRAW_FEE_CANCEL", "提现手续费取"),
    ("WITHDRAW_FAILED", "提现失败"),
    ("USER_TRANSFER_OUT", "站内转出"),
    ("USER_TRANSFER_IN", "站内转入"),
    ("TRANSFER_OUT", "转出"),
    ("TRANSFER_IN", "转入"),
    ("ADMIN_ADJUST", "后台调账"),
    ("PLATFORM_ADJUST", "平台调账"),
    ("TRADE_BUY", "现货买入"),
    ("TRADE_SELL", "现货卖出"),
    ("TRADE_FEE_DEBIT", "交易手续费扣"),
    ("TRADE_FEE_CREDIT", "平台手续费收"),
    ("CONTRACT_TRANSFER_IN", "合约转入"),
    ("CONTRACT_TRANSFER_OUT", "合约转出"),
    ("CONTRACT_OPEN_MARGIN", "合约开仓保证金"),
    ("CONTRACT_MARGIN_RELEASE", "合约保证金释"),
    ("CONTRACT_REALIZED_PNL", "合约已实现盈"),
    ("CONTRACT_SPREAD_FEE", "历史点差费用"),
    ("CONTRACT_LIQUIDATION", "合约强平"),
    ("LIQUIDATION_ZERO", "合约强平清零"),
    ("CONTRACT_TRANSFER", "合约划转"),
    ("REALIZED_PNL", "已实现盈"),
]

BALANCE_LOG_BIZ_TYPE_OPTIONS = [
    ("DEPOSIT", "充值到"),
    ("WITHDRAW", "提现"),
    ("USER_TRANSFER", "站内划转"),
    ("ACCOUNT_TRANSFER", "账户划转"),
    ("PLATFORM_ADJUST", "平台调账"),
    ("ADMIN_ADJUST", "后台调账"),
    ("TRADE", "现货交易"),
    ("CONTRACT_OPEN_MARGIN", "合约开仓保证金"),
    ("CONTRACT_MARGIN_RELEASE", "合约保证金释"),
    ("CONTRACT_REALIZED_PNL", "合约已实现盈"),
    ("CONTRACT_SPREAD_FEE", "历史点差费用"),
    ("CONTRACT_LIQUIDATION", "合约强平"),
    ("LIQUIDATION_ZERO", "合约强平清零"),
    ("CONTRACT_TRANSFER", "合约划转"),
    ("DIVIDEND_PAYOUT", "SVIP 分红发放"),
    ("BD_COMMISSION_PAYOUT", "BD 佣金发放"),
    ("USER_INVITE_COMMISSION_PAYOUT", "邀请奖励发"),
    ("STOCK_TOKEN_LOCK", "股票代币锁仓"),
    ("STOCK_TOKEN_RELEASE", "股票代币释放"),
    ("GAS_TOPUP", "补 Gas"),
    ("COLLECTION", "资金归集"),
]


BALANCE_LOG_LARGE_TABLE_NOTICE = "大表请优先按用户ID、流水号、TxID、请求ID等条件定位。默认查询最近7天，普通查询最大范围为30天"
BALANCE_LOG_RANGE_BLOCK_NOTICE = "查询范围超过30天，请输入用户ID、业务ID、请求ID或TxID等精准条件后再查询"


def _parse_admin_query_date(value: Any) -> Optional[date]:
    text_value = str(value or "").strip()
    if not text_value:
        return None
    try:
        return date.fromisoformat(text_value)
    except ValueError:
        return None


def _collection_task_date_range(created_from_text: str, created_to_text: str) -> tuple[date, date, str, str]:
    parsed_from = _parse_admin_query_date(created_from_text)
    parsed_to = _parse_admin_query_date(created_to_text)
    today = get_admin_today_date()
    if not parsed_from and not parsed_to:
        parsed_from = today - timedelta(days=6)
        parsed_to = today
    elif parsed_from and not parsed_to:
        parsed_to = today
    elif parsed_to and not parsed_from:
        parsed_from = parsed_to - timedelta(days=6)
    if parsed_from and parsed_to and parsed_from > parsed_to:
        parsed_from, parsed_to = parsed_to, parsed_from
    parsed_from = parsed_from or today - timedelta(days=6)
    parsed_to = parsed_to or today
    return parsed_from, parsed_to, parsed_from.isoformat(), parsed_to.isoformat()


def _collection_task_range_notice(start: date, end: date, *precise_values: str) -> str:
    if (end - start).days <= 30:
        return ""
    if any(str(value or "").strip() for value in precise_values):
        return ""
    return "当前时间范围超过 30 天，建议输入用户ID、地址、tx_hash 或任务ID等精准条件后查询"


def _balance_log_date_range(
    *,
    date_from_text: str,
    date_to_text: str,
    created_from_text: str,
    created_to_text: str,
) -> tuple[date, date, list[str], bool]:
    notices: list[str] = []
    raw_from = str(date_from_text or created_from_text or "").strip()
    raw_to = str(date_to_text or created_to_text or "").strip()
    parsed_from = _parse_admin_query_date(raw_from)
    parsed_to = _parse_admin_query_date(raw_to)
    if raw_from and parsed_from is None:
        notices.append("开始日期格式不正确，已按默认最近7天查询")
    if raw_to and parsed_to is None:
        notices.append("结束日期格式不正确，已按默认最近7天查询")

    today = get_admin_today_date()
    used_default = not parsed_from and not parsed_to
    if used_default:
        return today - timedelta(days=6), today, notices, True
    if parsed_from and not parsed_to:
        parsed_to = today
    if parsed_to and not parsed_from:
        parsed_from = parsed_to - timedelta(days=6)
    if parsed_from and parsed_to and parsed_from > parsed_to:
        parsed_from, parsed_to = parsed_to, parsed_from
    return parsed_from or today - timedelta(days=6), parsed_to or today, notices, False


def _balance_log_has_precise_condition(*values: str) -> bool:
    return any(str(value or "").strip() for value in values)


def _narrow_admin_range_to_30_days(range_to: date) -> tuple[date, date]:
    return range_to - timedelta(days=29), range_to


DEPOSIT_RECORDS_LARGE_TABLE_NOTICE = "大表请优先按用户ID、充值ID、TxID、币种、链、地址等条件定位。默认查询最近7天，普通查询最大范围为30天"
DEPOSIT_RECORDS_RANGE_BLOCK_NOTICE = "查询范围超过30天，请输入用户ID、充值ID、TxID、币种、链或地址等精准条件后再查询"
WITHDRAW_RECORDS_LARGE_TABLE_NOTICE = "大表请优先按用户ID、提现ID、提现单号、TxID、币种、链等条件定位。默认查询最近7天，普通查询最大范围为30天"
WITHDRAW_RECORDS_RANGE_BLOCK_NOTICE = "查询范围超过30天，请输入用户ID、提现ID、提现单号、TxID、币种或链等精准条件后再查询"
USER_TRANSFERS_LARGE_TABLE_NOTICE = "大表请优先按划转ID、划转单号、转出用户、转入用户、币种等条件定位。默认查询最近7天，普通查询最大范围为30天"
USER_TRANSFERS_RANGE_BLOCK_NOTICE = "查询范围超过30天，请输入划转ID、划转单号、用户ID或币种等精准条件后再查询"
AUDIT_LOGS_LARGE_TABLE_NOTICE = "大表请优先按审计ID、管理员ID、操作模块、动作、请求ID、IP等条件定位。默认查询最近7天，普通查询最大范围为30天"
AUDIT_LOGS_RANGE_BLOCK_NOTICE = "查询范围超过30天，请输入审计ID、管理员ID、操作模块、动作、请求ID或IP等精准条件后再查询"
ORDERS_LARGE_TABLE_NOTICE = "大表请优先按用户ID、订单ID、订单号、交易对等条件定位。默认查询最近7天，普通查询最大范围为30天"
ORDERS_RANGE_BLOCK_NOTICE = "查询范围超过30天，请输入用户ID、订单ID或交易对等精准条件后再查询"
TRADES_LARGE_TABLE_NOTICE = "大表请优先按用户ID、成交ID、订单ID、交易对等条件定位。默认查询最近7天，普通查询最大范围为30天"
TRADES_RANGE_BLOCK_NOTICE = "查询范围超过30天，请输入用户ID、成交ID、订单ID或交易对等精准条件后再查询"
CONTRACT_TRADES_LARGE_TABLE_NOTICE = "大表请优先按用户ID、成交ID、订单ID、持仓ID、合约品种等条件定位。默认查询最近7天，普通查询最大范围为30天"
CONTRACT_TRADES_RANGE_BLOCK_NOTICE = "查询范围超过30天，请输入用户ID、成交ID、订单ID、持仓ID或合约品种等精准条件后再查询"
CONTRACT_ORDERS_LARGE_TABLE_NOTICE = "大表请优先按用户ID、订单ID、订单号、持仓ID、合约品种等条件定位。默认查询最近7天，普通查询最大范围为30天"
CONTRACT_ORDERS_RANGE_BLOCK_NOTICE = "查询范围超过30天，请输入用户ID、订单ID、持仓ID或合约品种等精准条件后再查询"


BALANCE_LOG_RANGE_BLOCK_NOTICE = "查询范围超过30天且缺少用户ID、业务ID、请求ID或TxID等精准条件，已自动收窄为最近30天"
DEPOSIT_RECORDS_RANGE_BLOCK_NOTICE = "查询范围超过30天且缺少用户ID、充值ID、TxID、请求ID或状态等精准条件，已自动收窄为最近30天"
WITHDRAW_RECORDS_RANGE_BLOCK_NOTICE = "查询范围超过30天且缺少用户ID、提现ID、提现单号、TxID、请求ID或状态等精准条件，已自动收窄为最近30天"
AUDIT_LOGS_RANGE_BLOCK_NOTICE = "查询范围超过30天且缺少审计ID、管理员ID、请求ID或IP等精准条件，已自动收窄为最近30天"
ORDERS_RANGE_BLOCK_NOTICE = "查询范围超过30天且缺少用户ID、订单ID、订单号、交易对或状态等精准条件，已自动收窄为最近30天"
TRADES_RANGE_BLOCK_NOTICE = "查询范围超过30天且缺少用户ID、成交ID、订单ID、订单号或交易对等精准条件，已自动收窄为最近30天"
CONTRACT_TRADES_RANGE_BLOCK_NOTICE = "查询范围超过30天且缺少用户ID、成交ID、订单ID、持仓ID或合约品种等精准条件，已自动收窄为最近30天"
CONTRACT_ORDERS_RANGE_BLOCK_NOTICE = "查询范围超过30天且缺少用户ID、订单ID、订单号、持仓ID、合约品种或状态等精准条件，已自动收窄为最近30天"
BD_JOB_LOGS_LARGE_TABLE_NOTICE = "任务日志默认查询最近7天，普通查询最大范围为30天；超过30天请至少输入状态"
BD_JOB_LOGS_RANGE_BLOCK_NOTICE = "查询范围超过30天且缺少状态等精准条件，已自动收窄为最近30天"
DIVIDEND_JOB_LOGS_LARGE_TABLE_NOTICE = "任务日志默认查询最近7天，普通查询最大范围为30天；超过30天请至少输入分红池、分红日期或状态"
DIVIDEND_JOB_LOGS_RANGE_BLOCK_NOTICE = "查询范围超过30天且缺少分红池、分红日期或状态等精准条件，已自动收窄为最近30天"
STOCK_TOKEN_RELEASE_LOGS_LARGE_TABLE_NOTICE = "释放日志默认查询最近7天，普通查询最大范围为30天；超过30天请至少输入状态"
STOCK_TOKEN_RELEASE_LOGS_RANGE_BLOCK_NOTICE = "查询范围超过30天且缺少状态等精准条件，已自动收窄为最近30天"


BALANCE_LOGS_INLINE_TEMPLATE = """
{% extends "admin/layout.html" %}
{% block title %}资金流水{% endblock %}
{% block page_title %}资金流水{% endblock %}
{% block page_subtitle %}
  <div class="page-subtitle">统一展示 balance_logs 与 contract_margin_logs 的用户资金变动流水，仅用于后台只读核查。</div>
{% endblock %}
{% block content %}
  <style>
    .balance-log-amount.admin-amount-positive{ color:#86efac; font-weight:700; }
    .balance-log-amount.admin-amount-negative{ color:#fca5a5; font-weight:700; }
    .balance-log-note{
      max-width:240px;
      overflow:hidden;
      text-overflow:ellipsis;
      white-space:nowrap;
      font-size:12px;
    }
    .balance-log-related{ max-width:190px; }
    .balance-log-policy{
      margin-top:10px;
      color:var(--muted);
      font-size:12px;
    }
    .balance-log-range-actions{
      display:flex;
      flex-wrap:wrap;
      gap:8px;
      margin:12px 0 6px;
    }
    .balance-log-range-actions .active{
      background:var(--brand-soft);
      border-color:rgba(189,52,25,.35);
      color:#fff;
    }
    .balance-log-warning{
      margin-top:12px;
      padding:10px 12px;
      border:1px solid rgba(227,171,57,.30);
      border-radius:10px;
      background:rgba(189,134,25,.12);
      color:#ffd68a;
      font-size:13px;
    }
  </style>
  <section class="page-section">
    <div class="filter-card">
      <div class="section-title">筛选条件</div>
      <div class="balance-log-policy">{{ large_table_notice }}</div>
      <div class="balance-log-range-actions">
        {% for range_item in quick_ranges %}
          <a
            href="{{ request.url.include_query_params(range_days=range_item.range_days, date_from=range_item.date_from, date_to=range_item.date_to, created_from=range_item.date_from, created_to=range_item.date_to, page=1) }}"
            class="btn secondary admin-btn admin-btn-secondary admin-btn-sm {% if active_range_days == range_item.days %}active{% endif %}"
          >最近{{ range_item.days }}天</a>
        {% endfor %}
      </div>
      {% if query_notice %}
        <div class="balance-log-warning">{{ query_notice }}</div>
      {% endif %}
      <form method="get" action="/admin/balance-logs" class="filter-form">
        <div class="field"><label for="user_id">用户ID</label><input id="user_id" name="user_id" value="{{ filters.user_id or '' }}" /></div>
        <div class="field"><label for="coin_symbol">币种</label><input id="coin_symbol" name="coin_symbol" value="{{ filters.coin_symbol or '' }}" placeholder="USDT" /></div>
        <div class="field">
          <label for="account_type">账户类型</label>
          <select id="account_type" name="account_type">
            <option value="" {% if not filters.account_type and not filters.chain_key %}selected{% endif %}>全部</option>
            <option value="funding" {% if filters.account_type == 'funding' or filters.chain_key == 'funding' %}selected{% endif %}>资金账户</option>
            <option value="spot" {% if filters.account_type == 'spot' or filters.chain_key == 'spot' %}selected{% endif %}>现货账户</option>
            <option value="contract" {% if filters.account_type == 'contract' or filters.chain_key == 'contract' %}selected{% endif %}>合约账户</option>
          </select>
        </div>
        <div class="field">
          <label for="change_type">变动类型</label>
          <select id="change_type" name="change_type">
            <option value="" {% if not filters.change_type %}selected{% endif %}>全部</option>
            {% if filters.change_type and filters.change_type not in change_type_values %}
              <option value="{{ filters.change_type }}" selected>{{ filters.change_type }}</option>
            {% endif %}
            {% for value, label in change_type_options %}
              <option value="{{ value }}" {% if filters.change_type == value %}selected{% endif %}>{{ label }}</option>
            {% endfor %}
          </select>
        </div>
        <div class="field">
          <label for="biz_type">业务类型</label>
          <select id="biz_type" name="biz_type">
            <option value="" {% if not filters.biz_type %}selected{% endif %}>全部</option>
            {% if filters.biz_type and filters.biz_type not in biz_type_values %}
              <option value="{{ filters.biz_type }}" selected>{{ filters.biz_type }}</option>
            {% endif %}
            {% for value, label in biz_type_options %}
              <option value="{{ value }}" {% if filters.biz_type == value %}selected{% endif %}>{{ label }}</option>
            {% endfor %}
          </select>
        </div>
        <div class="field"><label for="biz_id">业务ID</label><input id="biz_id" name="biz_id" value="{{ filters.biz_id or '' }}" placeholder="关联业务单号" /></div>
        <div class="field">
          <label for="direction">方向</label>
          <select id="direction" name="direction">
            <option value="" {% if not filters.direction %}selected{% endif %}>全部</option>
            <option value="1" {% if filters.direction == '1' %}selected{% endif %}>收入</option>
            <option value="-1" {% if filters.direction == '-1' %}selected{% endif %}>支出</option>
          </select>
        </div>
        <div class="field"><label for="request_id">请求ID</label><input id="request_id" name="request_id" value="{{ filters.request_id or '' }}" placeholder="输入请求ID" /></div>
        <div class="field"><label for="tx_hash">TxID</label><input id="tx_hash" name="tx_hash" value="{{ filters.tx_hash or '' }}" placeholder="链上TxID或哈" /></div>
        <div class="field"><label for="date_from">开始日期</label><input id="date_from" type="date" name="date_from" value="{{ filters.date_from or filters.created_from or '' }}" /></div>
        <div class="field"><label for="date_to">结束日期</label><input id="date_to" type="date" name="date_to" value="{{ filters.date_to or filters.created_to or '' }}" /></div>
        <div class="filter-actions">
          <button type="submit" class="btn admin-btn admin-btn-primary">查询</button>
          <a href="/admin/balance-logs" class="btn secondary admin-btn admin-btn-secondary">重置</a>
        </div>
      </form>
    </div>
  </section>

  <section class="page-section">
    <div class="table-card">
      <div class="section-title">资金流水列表</div>
      {% if items %}
        <div class="table-wrap admin-table-wrap">
          <table class="admin-table">
            <thead>
              <tr>
                <th>时间</th>
                <th>用户ID</th>
                <th>币种</th>
                <th>账户</th>
                <th>来源</th>
                <th class="text-right admin-number">变动金额</th>
                <th class="text-right admin-number">变动后余额</th>
                <th>业务类型</th>
                <th>关联单号</th>
                <th>备注</th>
              </tr>
            </thead>
            <tbody>
              {% for item in items %}
                <tr>
                  <td class="nowrap admin-time">{{ item.created_at }}</td>
                  <td class="admin-id">{{ item.user_id }}</td>
                  <td class="mono nowrap">{{ item.coin_symbol }}</td>
                  <td class="nowrap" title="{{ item.chain_key }}">{{ item.account_type_label }}</td>
                  <td class="nowrap" title="{{ item.source }}">{{ item.source_label }}</td>
                  <td class="admin-amount balance-log-amount {{ item.change_amount_class }}">{{ item.change_amount }}</td>
                  <td class="admin-amount" title="变动前：{{ item.before_available }}；冻结后：{{ item.after_frozen }}">{{ item.after_available }}</td>
                  <td>
                    <div class="nowrap" title="{{ item.biz_type }}">{{ item.biz_type_label }}</div>
                    <div class="admin-muted nowrap" title="{{ item.change_type }}">{{ item.change_type_label }} / {{ item.direction_label }}</div>
                  </td>
                  <td class="admin-hash balance-log-related" title="{{ item.related_id_full }}">{{ item.related_id_display }}</td>
                  <td class="admin-muted balance-log-note" title="{{ item.remark }}">{{ item.remark_short }}</td>
                </tr>
              {% endfor %}
            </tbody>
          </table>
        </div>
      {% else %}
        <div class="empty-state admin-empty">
          <div class="admin-empty-title">暂无数据</div>
          <p class="admin-empty-desc">当前筛选条件下暂无记录，可调整筛选条件后重试</p>
        </div>
      {% endif %}
      <div class="pagination admin-pagination">
        <div class="admin-muted">共 {{ pagination.total }} 条，当前第 {{ pagination.page }} / {{ pagination.pages }} 页</div>
        <div class="pagination-actions">
          {% if pagination.page > 1 %}
            <a href="{{ request.url.include_query_params(page=pagination.page - 1, page_size=pagination.page_size) }}" class="btn secondary admin-btn admin-btn-secondary admin-btn-sm">上一页</a>
          {% endif %}
          {% if pagination.page < pagination.pages %}
            <a href="{{ request.url.include_query_params(page=pagination.page + 1, page_size=pagination.page_size) }}" class="btn secondary admin-btn admin-btn-secondary admin-btn-sm">下一页</a>
          {% endif %}
        </div>
      </div>
    </div>
  </section>
{% endblock %}
"""


@router.get("/balance-logs", response_class=HTMLResponse)
def balance_logs_page(
    request: Request,
    user_id: str = "",
    coin_symbol: str = "",
    chain_key: str = "",
    account_type: str = "",
    change_type: str = "",
    biz_type: str = "",
    biz_id: str = "",
    request_id: str = "",
    tx_hash: str = "",
    direction: str = "",
    date_from: str = "",
    date_to: str = "",
    created_from: str = "",
    created_to: str = "",
    range_days: str = "",
    page: int = 1,
    page_size: int = 20,
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return redir

    try:
        range_days_value = int(str(range_days or "").strip() or "0")
    except ValueError:
        range_days_value = 0
    if range_days_value not in {7, 15, 30}:
        range_days_value = 0
    if range_days_value and not any(
        str(value or "").strip() for value in (date_from, date_to, created_from, created_to)
    ):
        today_for_range = get_admin_today_date()
        date_from = (today_for_range - timedelta(days=range_days_value - 1)).isoformat()
        date_to = today_for_range.isoformat()

    range_from, range_to, query_notices, used_default_range = _balance_log_date_range(
        date_from_text=date_from,
        date_to_text=date_to,
        created_from_text=created_from,
        created_to_text=created_to,
    )
    range_days = (range_to - range_from).days + 1
    has_precise_condition = _balance_log_has_precise_condition(user_id, biz_id, request_id, tx_hash)
    range_blocked = range_days > 30 and not has_precise_condition
    if range_blocked:
        query_notices.append(BALANCE_LOG_RANGE_BLOCK_NOTICE)
        range_from, range_to = _narrow_admin_range_to_30_days(range_to)
        range_days = 30
    active_range_days = range_days if range_days in {7, 15, 30} else (7 if used_default_range else 0)
    today = get_admin_today_date()
    quick_ranges = [
        {
            "days": days,
            "date_from": (today - timedelta(days=days - 1)).isoformat(),
            "date_to": today.isoformat(),
            "range_days": str(days),
        }
        for days in (7, 15, 30)
    ]
    query_filters = {
        "user_id": user_id,
        "coin_symbol": coin_symbol,
        "chain_key": chain_key or account_type,
        "account_type": account_type or chain_key,
        "change_type": change_type,
        "biz_type": biz_type,
        "biz_id": biz_id,
        "request_id": request_id,
        "tx_hash": tx_hash,
        "direction": direction,
        "created_from": range_from.isoformat(),
        "created_to": range_to.isoformat(),
        "date_from": range_from.isoformat(),
        "date_to": range_to.isoformat(),
        "page": page,
        "page_size": page_size,
    }
    result = admin_query_unified_balance_logs(db=db, filters=query_filters)
    result_filters = _result_filters(result)
    return render_inline(
        request,
        BALANCE_LOGS_INLINE_TEMPLATE,
        ctx={
            "items": _result_items(result),
            "active_group": "funds",
            "active": "balance_logs",
            "filters": {
                **result_filters,
                "created_from": range_from.isoformat(),
                "created_to": range_to.isoformat(),
                "date_from": range_from.isoformat(),
            "date_to": range_to.isoformat(),
            "range_days": str(range_days_value or active_range_days or ""),
            "tx_hash": tx_hash,
        },
            "large_table_notice": BALANCE_LOG_LARGE_TABLE_NOTICE,
            "query_notice": " ".join(query_notices),
            "quick_ranges": quick_ranges,
            "active_range_days": active_range_days,
            "change_type_options": BALANCE_LOG_CHANGE_TYPE_OPTIONS,
            "change_type_values": [value for value, _ in BALANCE_LOG_CHANGE_TYPE_OPTIONS],
            "biz_type_options": BALANCE_LOG_BIZ_TYPE_OPTIONS,
            "biz_type_values": [value for value, _ in BALANCE_LOG_BIZ_TYPE_OPTIONS],
            "pagination": {
                "page": _result_page(result),
                "page_size": _result_page_size(result),
                "total": _result_total(result),
                "pages": _result_pages(result),
            },
        },
    )


@router.get("/withdraw-reviews", response_class=HTMLResponse)
def withdraw_reviews_page(
    request: Request,
    user_id: str = "",
    coin_symbol: str = "",
    chain_key: str = "",
    status: Optional[str] = None,
    notice: str = "",
    error: str = "",
    page: int = 1,
    page_size: int = 20,
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return redir

    filters = {
        "user_id": user_id,
        "coin_symbol": coin_symbol,
        "chain_key": chain_key,
        "status": "PENDING_REVIEW" if status is None else status,
        "page": page,
        "page_size": page_size,
    }
    result = admin_query_withdraw_reviews(db, filters)
    return render(
        request,
        "admin/withdraw_reviews.html",
        ctx={
            "items": _result_items(result),
            "active_group": "funds",
            "active": "withdraw_reviews",
            "filters": _result_filters(result),
            "notice": notice,
            "error": error,
            "pagination": {
                "page": _result_page(result),
                "page_size": _result_page_size(result),
                "total": _result_total(result),
                "pages": _result_pages(result),
            },
        },
    )


@router.get("/collections/records")
def collection_records_page(request: Request):
    query = request.url.query
    suffix = f"?{query}" if query else ""
    return RedirectResponse(url=f"/admin/collections/batches{suffix}", status_code=302)


@router.get("/collections/records/{batch_id}", response_class=HTMLResponse)
def collection_record_detail_page(
    request: Request,
    batch_id: int,
    page: int = 1,
    page_size: int = 100,
    db: Session = Depends(get_db),
):
    redir = require_admin_permission(request, db, "collection_tasks.manage")
    if redir:
        return redir
    result = admin_query_collection_batch_detail(db, batch_id, {"page": page, "page_size": page_size})
    return render(
        request,
        "admin/collection_record_detail.html",
        ctx={
            "batch": result.get("batch"),
            "summary": result.get("summary") or {},
            "items": result.get("items") or [],
            "active_group": "system",
            "active": "collection_records",
            "real_send_enabled": is_collection_real_send_enabled(),
            "pagination": {
                "page": _result_page(result),
                "page_size": _result_page_size(result),
                "total": _result_total(result),
                "pages": _result_pages(result),
            },
        },
    )


@router.get("/collections/batches", response_class=HTMLResponse)
def collection_batches_page(
    request: Request,
    batch_no: str = "",
    status: str = "",
    chain_key: str = "",
    coin_symbol: str = "",
    trigger_type: str = "",
    user_id: str = "",
    address: str = "",
    tx_hash: str = "",
    created_from: str = "",
    created_to: str = "",
    page: int = 1,
    page_size: int = 20,
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return redir

    created_from_text = str(created_from or "").strip()
    created_to_text = str(created_to or "").strip()
    created_from_value, created_to_value, created_from_text, created_to_text = _collection_task_date_range(
        created_from_text, created_to_text
    )
    range_notice = _collection_task_range_notice(
        created_from_value, created_to_value, batch_no, user_id, address, tx_hash
    )

    result = list_collection_batches(
        db,
        {
            "batch_no": batch_no,
            "status": status,
            "chain_key": chain_key,
            "coin_symbol": coin_symbol,
            "trigger_type": trigger_type,
            "user_id": user_id,
            "address": address,
            "tx_hash": tx_hash,
            "created_from": created_from_value,
            "created_to": created_to_value,
            "page": page,
            "page_size": page_size,
        },
    )
    return render(
        request,
        "admin/collection_batches.html",
        ctx={
            "items": _result_items(result),
            "active_group": "system",
            "active": "collection_records",
            "summary": result.get("summary") or {},
            "network_stats": result.get("network_stats") or [],
            "symbol_stats": result.get("symbol_stats") or [],
            "filter_options": result.get("filter_options") or {},
            "range_notice": range_notice,
            "filters": {
                **_result_filters(result),
                "created_from": created_from_text,
                "created_to": created_to_text,
            },
            "pagination": {
                "page": _result_page(result),
                "page_size": _result_page_size(result),
                "total": _result_total(result),
                "pages": _result_pages(result),
            },
        },
    )


@router.get("/collections/batches/{batch_id}", response_class=HTMLResponse)
def collection_batch_detail_page(
    request: Request,
    batch_id: int,
    page: int = 1,
    page_size: int = 100,
    db: Session = Depends(get_db),
):
    query = urlencode({"page": page, "page_size": page_size})
    return RedirectResponse(url=f"/admin/collections/records/{batch_id}?{query}", status_code=302)


@router.get("/collections/tasks", response_class=HTMLResponse)
def collection_tasks_page(
    request: Request,
    task_no: str = "",
    task_id: str = "",
    batch_id: str = "",
    user_id: str = "",
    chain_key: str = "",
    network: str = "",
    coin_symbol: str = "",
    status: str = "",
    address: str = "",
    tx_hash: str = "",
    notice: str = "",
    error: str = "",
    created_from: str = "",
    created_to: str = "",
    page: int = 1,
    page_size: int = 20,
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return redir

    created_from_text = str(created_from or "").strip()
    created_to_text = str(created_to or "").strip()
    created_from_value, created_to_value, created_from_text, created_to_text = _collection_task_date_range(
        created_from_text, created_to_text
    )
    range_notice = _collection_task_range_notice(
        created_from_value, created_to_value, task_no, batch_id, user_id, address, tx_hash
    )

    result = list_collection_tasks(
        db,
        {
            "task_no": task_no,
            "task_id": task_id,
            "batch_id": batch_id,
            "user_id": user_id,
            "chain_key": chain_key or network,
            "coin_symbol": coin_symbol,
            "status": status,
            "address": address,
            "tx_hash": tx_hash,
            "created_from": created_from_value,
            "created_to": created_to_value,
            "page": page,
            "page_size": page_size,
        },
    )
    return render(
        request,
        "admin/collection_tasks.html",
        ctx={
            "items": _result_items(result),
            "batch_items": result.get("batch_items") or [],
            "active_group": "system",
            "active": "collection_records",
            "notice": notice,
            "error": error,
            "real_send_enabled": is_collection_real_send_enabled(),
            "batch_pagination": result.get("batch_pagination") or {},
            "selected_batch_id": result.get("selected_batch_id") or "",
            "summary": result.get("summary") or {},
            "filter_options": result.get("filter_options") or {},
            "range_notice": range_notice,
            "filters": {
                **_result_filters(result),
                "created_from": created_from_text,
                "created_to": created_to_text,
            },
            "pagination": {
                "page": _result_page(result),
                "page_size": _result_page_size(result),
                "total": _result_total(result),
                "pages": _result_pages(result),
            },
        },
    )


COLLECTION_TASK_EVENT_TERMINAL_STATUSES = {
    "CONFIRMED",
    "SUCCESS",
    "COMPLETED",
    "FAILED",
    "SKIPPED",
    "CANCELED",
    "CANCELLED",
}


def _collection_tasks_event_snapshot(batch_id: int, page: int, page_size: int) -> Dict[str, Any]:
    db = SessionLocal()
    try:
        result = list_collection_tasks(
            db,
            {
                "batch_id": str(batch_id),
                "page": max(1, int(page or 1)),
                "page_size": min(max(1, int(page_size or 20)), 100),
            },
        )
        items = _result_items(result)
        batch_item = (result.get("batch_items") or [{}])[0]
        terminal_sql = """
            SELECT
              COUNT(*) AS total_count,
              SUM(CASE WHEN UPPER(collection_tasks.status) NOT IN ('CONFIRMED', 'SUCCESS', 'COMPLETED', 'FAILED', 'SKIPPED', 'CANCELED', 'CANCELLED') THEN 1 ELSE 0 END) AS active_task_count,
              SUM(CASE WHEN gt.id IS NOT NULL AND UPPER(gt.status) NOT IN ('CONFIRMED', 'SUCCESS', 'COMPLETED', 'FAILED', 'SKIPPED', 'CANCELED', 'CANCELLED') THEN 1 ELSE 0 END) AS active_gas_count,
              MAX(COALESCE(gt.updated_at, collection_tasks.updated_at, collection_tasks.created_at)) AS latest_updated_at
            FROM collection_tasks
            LEFT JOIN gas_tasks gt ON gt.id = collection_tasks.gas_task_id
            WHERE collection_tasks.batch_id = :batch_id
        """
        terminal_row = dict(db.execute(text(terminal_sql), {"batch_id": int(batch_id)}).mappings().first() or {})
        total_count = int(terminal_row.get("total_count") or 0)
        active_task_count = int(terminal_row.get("active_task_count") or 0)
        active_gas_count = int(terminal_row.get("active_gas_count") or 0)
        all_terminal = bool(total_count > 0 and active_task_count <= 0 and active_gas_count <= 0)
        return {
            "ok": True,
            "batch_id": int(batch_id),
            "batch": {
                "id": batch_item.get("batch_id") or batch_id,
                "batch_no": batch_item.get("batch_no") or "",
                "status": batch_item.get("status") or "",
                "status_label": batch_item.get("status_label") or "",
                "gas_summary": batch_item.get("gas_summary") or "",
                "gas_badge": batch_item.get("gas_badge") or "",
                "updated_at": batch_item.get("finished_at") or batch_item.get("created_at") or "",
            },
            "tasks": [
                {
                    "id": item.get("id"),
                    "task_no": item.get("task_no") or "",
                    "status": item.get("status") or "",
                    "status_label": item.get("status_label") or "",
                    "gas_task_id": item.get("gas_task_id") or "",
                    "gas_topup_label": item.get("gas_topup_label") or "-",
                    "gas_status": item.get("gas_task_status") or "",
                    "gas_status_label": item.get("gas_status_label") or "",
                    "tx_hash": item.get("tx_hash") or "",
                    "gas_tx_hash": item.get("gas_tx_hash") or "",
                    "gas_tx_hash_short": item.get("gas_tx_hash_short") or "",
                    "failure_reason": item.get("last_error_full") or "",
                    "updated_at": item.get("updated_at") or "",
                }
                for item in items
            ],
            "total": total_count,
            "active_task_count": active_task_count,
            "active_gas_count": active_gas_count,
            "all_terminal": all_terminal,
            "latest_updated_at": _admin_event_datetime(terminal_row.get("latest_updated_at")),
            "generated_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
        }
    finally:
        db.close()


def _admin_event_datetime(value: Any) -> str:
    if isinstance(value, datetime):
        return value.isoformat(timespec="seconds")
    return str(value or "")


@router.get("/collections/tasks/events")
async def collection_tasks_events(
    request: Request,
    batch_id: int,
    page: int = 1,
    page_size: int = 20,
    db: Session = Depends(get_db),
):
    redir = require_admin_permission(request, db, "collection_tasks.manage")
    if redir:
        return redir

    async def event_stream():
        redis = get_redis_connection()
        try:
            stream_info = await asyncio.to_thread(redis.xinfo_stream, COLLECTION_CENTER_EVENT_STREAM)
            last_id_value = stream_info.get("last-generated-id") or stream_info.get(b"last-generated-id") or "$"
            if isinstance(last_id_value, bytes):
                last_id_value = last_id_value.decode("utf-8", errors="ignore")
            last_id = str(last_id_value or "$")
        except Exception:
            last_id = "0-0"
        heartbeat_after = 25.0
        last_sent = asyncio.get_event_loop().time()
        try:
            snapshot = await asyncio.to_thread(_collection_tasks_event_snapshot, int(batch_id), int(page), int(page_size))
            yield f"event: collection_batch_snapshot\ndata: {json.dumps(snapshot, ensure_ascii=False, default=str)}\n\n"
            last_sent = asyncio.get_event_loop().time()
            if snapshot.get("all_terminal"):
                yield f"event: collection_batch_terminal\ndata: {json.dumps(snapshot, ensure_ascii=False, default=str)}\n\n"
                return
        except Exception as exc:
            payload = json.dumps({"ok": False, "error": str(exc)[:180]}, ensure_ascii=False)
            yield f"event: error\ndata: {payload}\n\n"
            return
        while True:
            if await request.is_disconnected():
                break
            try:
                streams = await asyncio.to_thread(
                    redis.xread,
                    {COLLECTION_CENTER_EVENT_STREAM: last_id},
                    count=20,
                    block=25000,
                )
                now = asyncio.get_event_loop().time()
                matched = False
                for _, entries in streams or []:
                    events = decode_collection_center_stream_entries(entries)
                    for event in events:
                        stream_id = str(event.get("_stream_id") or "")
                        if stream_id:
                            last_id = stream_id
                        if str(event.get("event_type") or "") not in {"collection_task_changed", "gas_task_changed"}:
                            continue
                        if str(event.get("batch_id") or "") != str(batch_id):
                            continue
                        matched = True
                if matched:
                    snapshot = await asyncio.to_thread(_collection_tasks_event_snapshot, int(batch_id), int(page), int(page_size))
                    payload = json.dumps(snapshot, ensure_ascii=False, default=str)
                    yield f"event: collection_batch_snapshot\ndata: {payload}\n\n"
                    last_sent = asyncio.get_event_loop().time()
                    if snapshot.get("all_terminal"):
                        yield f"event: collection_batch_terminal\ndata: {payload}\n\n"
                        break
                elif now - last_sent >= heartbeat_after:
                    yield 'event: heartbeat\ndata: {"ok": true}\n\n'
                    last_sent = now
            except Exception as exc:
                payload = json.dumps({"ok": False, "error": str(exc)[:180]}, ensure_ascii=False)
                yield f"event: error\ndata: {payload}\n\n"
                break

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


def _admin_real_tx_hash(value: object) -> bool:
    tx_hash = str(value or "").strip()
    return bool(tx_hash.lower().startswith("0x") and not _admin_is_dry_run_tx_hash(tx_hash))


def _admin_guard_error_label(error: str) -> str:
    upper = str(error or "").upper()
    if "REAL_SEND_MASTER_SWITCH_DISABLED" in upper or "MASTER_SWITCH_OFF" in upper:
        return "Gas发送总开关未开启"
    if "CHAIN_NOT_ALLOWED" in upper:
        return "当前网络未开放补Gas"
    return error or "补Gas已被安全策略拦截"


def _admin_mark_gas_task_guard_blocked(db: Session, gas_task: GasTask, error: str) -> None:
    gas_task.status = GasTaskStatus.FAILED.value
    gas_task.last_error = (error or "GUARD_REJECTED")[:1000]
    gas_task.next_retry_at = None
    gas_task.locked_at = None
    gas_task.updated_at = datetime.utcnow()
    db.flush()


def _admin_collection_gas_guard_error(db: Session, gas_task: GasTask) -> str:
    result = validate_collection_send_allowed(
        db=db,
        chain_key=str(gas_task.chain_key or ""),
        to_address=str(gas_task.to_address or ""),
        amount=Decimal(str(gas_task.topup_amount or 0)),
        coin_symbol="NATIVE",
        is_gas=True,
    )
    return "" if result.allowed else f"GUARD_REJECTED:{result.reason}"


def _admin_parse_wait_gas_reason(reason: object) -> tuple[str, Decimal]:
    parts = str(reason or "").strip().split(":")
    if len(parts) >= 3 and parts[0].upper() in {"WAIT_GAS", "WAITING_GAS", "GAS_REQUIRED"}:
        try:
            return parts[1].strip().upper(), Decimal(str(parts[2] or "0"))
        except Exception:
            return parts[1].strip().upper(), Decimal("0")
    return "", Decimal("0")


def _admin_chain_hot_wallet_address(db: Session, chain_key: object) -> str:
    row = db.execute(
        text("SELECT hot_wallet_address FROM chains WHERE LOWER(chain_key)=:chain_key LIMIT 1"),
        {"chain_key": str(chain_key or "").strip().lower()},
    ).mappings().first()
    return str((row or {}).get("hot_wallet_address") or "").strip()


def _admin_ensure_collection_gas_task(db: Session, task: CollectionTask) -> tuple[Optional[GasTask], str]:
    linked_gas_task: Optional[GasTask] = None
    invalid_link_reason = ""
    if task.gas_task_id:
        linked_gas_task = db.query(GasTask).filter(GasTask.id == int(task.gas_task_id)).first()
        if not linked_gas_task:
            invalid_link_reason = f"Gas任务 {task.gas_task_id} 不存在"
        elif int(linked_gas_task.collection_task_id or 0) != int(task.id):
            invalid_link_reason = (
                f"Gas任务关联异常，可重新生成Gas任务"
                f"(gas_task_id={linked_gas_task.id}, belongs_to={linked_gas_task.collection_task_id or '-'})"
            )
        else:
            return linked_gas_task, ""

    source_gas_task = linked_gas_task
    gas_symbol, topup_amount = _admin_parse_wait_gas_reason(getattr(task, "reason", ""))
    if source_gas_task:
        gas_symbol = str(source_gas_task.gas_coin_symbol or gas_symbol or get_native_gas_coin_symbol(str(task.chain_key or ""))).strip().upper()
        topup_amount = Decimal(str(source_gas_task.topup_amount or topup_amount or 0))
    if not gas_symbol:
        gas_symbol = get_native_gas_coin_symbol(str(task.chain_key or ""))
    if topup_amount <= 0:
        return None, invalid_link_reason or "缺少可创建 Gas 任务的补 Gas 数量"

    hot_wallet_address = _admin_chain_hot_wallet_address(db, task.chain_key)
    if not hot_wallet_address:
        return None, invalid_link_reason or "链未配置热钱包地址，无法创建 Gas 任务"

    gas_task = create_gas_task(
        db,
        collection_task_id=int(task.id),
        user_id=int(task.user_id),
        chain_key=str(task.chain_key or ""),
        gas_coin_symbol=gas_symbol,
        from_address=hot_wallet_address,
        to_address=str(task.from_address or ""),
        topup_amount=topup_amount,
        target_balance=Decimal(str(getattr(source_gas_task, "target_balance", None) or topup_amount)),
        gas_topup_mode=str(getattr(source_gas_task, "gas_topup_mode", "") or ""),
        estimate_source=str(getattr(source_gas_task, "estimate_source", "") or ""),
    )
    mark_collection_task_wait_gas(
        db,
        int(task.id),
        gas_task_id=int(gas_task.id),
        reason=f"WAIT_GAS:{gas_symbol}:{format(topup_amount, 'f')}",
    )
    db.flush()
    return gas_task, invalid_link_reason


@router.post("/collections/tasks/{batch_id}/requeue")
def collection_tasks_requeue_batch(
    request: Request,
    batch_id: int,
    next_path: str = Form("/admin/collections/tasks"),
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "collection_tasks.manage")
    if redir:
        return redir

    collection_enqueued = 0
    gas_enqueued = 0
    skipped_active = 0
    skipped_reasons: list[str] = []
    errors: list[str] = []
    eligible_statuses = {"PENDING", "WAITING"}
    waiting_gas_statuses = {"GAS_REQUIRED", "WAITING_GAS", "WAIT_GAS", "GAS_QUEUED"}
    gas_requeue_statuses = {
        "PENDING",
        "WAITING",
        "FAILED",
        "TIMEOUT",
        "CANCELED",
        "CANCELLED",
        "QUEUED",
    }

    try:
        tasks = (
            db.query(CollectionTask)
            .filter(CollectionTask.batch_id == int(batch_id))
            .order_by(CollectionTask.id.asc())
            .all()
        )
        for task in tasks:
            task_status = str(task.status or "").upper()
            task_label = f"task {int(task.id)}"
            if task.tx_hash and _admin_real_tx_hash(task.tx_hash):
                skipped_reasons.append(f"{task_label}: 已有真实tx")
                continue

            if task_status in waiting_gas_statuses:
                gas_task, ensure_reason = _admin_ensure_collection_gas_task(db, task)
                if ensure_reason:
                    skipped_reasons.append(f"{task_label}: {ensure_reason}")
                if not gas_task:
                    skipped_reasons.append(f"{task_label}: gas_task无效且无法重新生成")
                    continue
                gas_status = str(gas_task.status or "").upper()
                gas_tx_hash = str(gas_task.tx_hash or "").strip()
                if gas_tx_hash and _admin_real_tx_hash(gas_tx_hash):
                    skipped_reasons.append(f"{task_label}: Gas任务已有真实tx")
                    continue
                if gas_tx_hash and _admin_is_dry_run_tx_hash(gas_tx_hash):
                    gas_task.tx_hash = None
                    gas_task.sent_at = None
                    gas_task.confirmed_at = None
                    gas_task.block_number = None
                    gas_task.status = GasTaskStatus.PENDING.value
                    gas_task.updated_at = datetime.utcnow()
                    db.flush()
                    gas_status = GasTaskStatus.PENDING.value
                if gas_status not in gas_requeue_statuses:
                    skipped_reasons.append(f"{task_label}: Gas任务状态 {gas_status or '-'} 不允许重入队")
                    continue
                guard_error = _admin_collection_gas_guard_error(db, gas_task)
                if guard_error:
                    _admin_mark_gas_task_guard_blocked(db, gas_task, guard_error)
                    skipped_reasons.append(f"{task_label}: {_admin_guard_error_label(guard_error)}")
                    continue
                if gas_status != GasTaskStatus.PENDING.value:
                    gas_task.status = GasTaskStatus.PENDING.value
                    gas_task.updated_at = datetime.utcnow()
                    db.flush()
                if is_gas_task_job_active(int(gas_task.id)):
                    skipped_active += 1
                    continue
                enqueue_gas_task(int(gas_task.id), allow_real_send=True)
                gas_enqueued += 1
                continue

            if task_status not in eligible_statuses:
                skipped_reasons.append(f"{task_label}: 状态 {task_status or '-'} 不允许重入队")
                continue

            if task.gas_task_id:
                gas_task = db.query(GasTask).filter(GasTask.id == int(task.gas_task_id)).first()
                if gas_task and int(gas_task.collection_task_id or 0) != int(task.id):
                    skipped_reasons.append(f"{task_label}: gas_task归属异常")
                    gas_task = None
                if gas_task:
                    gas_status = str(gas_task.status or "").upper()
                    gas_tx_hash = str(gas_task.tx_hash or "").strip()
                    if gas_tx_hash and _admin_real_tx_hash(gas_tx_hash):
                        skipped_reasons.append(f"{task_label}: Gas任务已有真实tx")
                    elif gas_status in gas_requeue_statuses:
                        guard_error = _admin_collection_gas_guard_error(db, gas_task)
                        if guard_error:
                            _admin_mark_gas_task_guard_blocked(db, gas_task, guard_error)
                            skipped_reasons.append(f"{task_label}: {_admin_guard_error_label(guard_error)}")
                        elif is_gas_task_job_active(int(gas_task.id)):
                            skipped_active += 1
                        else:
                            if gas_status != GasTaskStatus.PENDING.value:
                                gas_task.status = GasTaskStatus.PENDING.value
                                gas_task.updated_at = datetime.utcnow()
                                db.flush()
                            enqueue_gas_task(int(gas_task.id), allow_real_send=True)
                            gas_enqueued += 1

            if is_collection_task_job_active(int(task.id)):
                skipped_active += 1
                continue
            enqueue_collection_task(int(task.id), allow_real_send=True)
            collection_enqueued += 1
        db.commit()
    except Exception as exc:
        db.rollback()
        errors.append(str(exc)[:180])
        logger.warning("collection batch requeue failed batch_id=%s", batch_id, exc_info=True)

    if collection_enqueued or gas_enqueued:
        notice = f"已重新入队 {collection_enqueued} 个归集任务，{gas_enqueued} 个补 Gas 任务"
        if skipped_active:
            notice = f"{notice}；跳过 {skipped_active} 个已在队列中的任务"
        if skipped_reasons:
            notice = f"{notice}；跳过原因：{'; '.join(skipped_reasons[:6])}"
        if errors:
            notice = f"{notice}；部分失败：{'; '.join(errors)}"
        return RedirectResponse(
            url=_build_collection_tasks_redirect_url(next_path=next_path, notice=notice),
            status_code=302,
        )

    if skipped_reasons or skipped_active or errors:
        detail_parts: list[str] = []
        if skipped_reasons:
            detail_parts.append(f"跳过原因：{'; '.join(skipped_reasons[:8])}")
        if skipped_active:
            detail_parts.append(f"{skipped_active} 个任务已在队列中")
        if errors:
            detail_parts.append(f"失败：{'; '.join(errors)}")
        message = f"未入队；{'；'.join(detail_parts)}"
        return RedirectResponse(
            url=_build_collection_tasks_redirect_url(next_path=next_path, error=message),
            status_code=302,
        )

    message = "没有可处理的重入队任务"
    if skipped_active:
        message = f"{message}；{skipped_active} 个任务已在队列中"
    if skipped_reasons:
        message = f"{message}；跳过原因：{'; '.join(skipped_reasons[:8])}"
    if errors:
        message = f"{message}；{'; '.join(errors)}"
    return RedirectResponse(
        url=_build_collection_tasks_redirect_url(next_path=next_path, error=message),
        status_code=302,
    )

    if collection_enqueued or gas_enqueued:
        notice = f"已重新入队 {collection_enqueued} 个归集任务，{gas_enqueued} 个补 Gas 任务"
        if skipped_active:
            notice = f"{notice}；跳过 {skipped_active} 个已在队列中的任务"
        if errors:
            notice = f"{notice}；部分失败：{';'.join(errors)}"
        return RedirectResponse(
            url=_build_collection_tasks_redirect_url(next_path=next_path, notice=notice),
            status_code=302,
        )
    message = "没有可重新入队的任务"
    if skipped_active:
        message = f"{message}；{skipped_active} 个任务已在队列中"
    if errors:
        message = f"{message}；{';'.join(errors)}"
    return RedirectResponse(
        url=_build_collection_tasks_redirect_url(next_path=next_path, error=message),
        status_code=302,
    )


def _collection_real_send_error_message(task_id: int, task: CollectionTask, result: object, action_label: str) -> str:
    if isinstance(result, dict) and result.get("gas_required"):
        gas_symbol = get_native_gas_coin_symbol(str(getattr(task, "chain_key", "") or ""))
        gas_task_id = result.get("gas_task_id") or getattr(task, "gas_task_id", None) or "-"
        return f"归集任务 {task_id} 已进入等待Gas：地址缺少 {gas_symbol}，已关联 Gas 任务 {gas_task_id}"
    if isinstance(result, dict):
        detail = result.get("error") or result.get("reason") or result
    else:
        detail = result
    return f"归集任务 {task_id} {action_label}未完成：{detail}"


def _admin_is_dry_run_tx_hash(value: object) -> bool:
    tx_hash = str(value or "").strip().upper()
    return bool(tx_hash.startswith("DRYGAS_") or tx_hash.startswith("DRYRUN_"))


def _is_legacy_collection_gas_required_failure(task: CollectionTask) -> bool:
    status_value = str(getattr(task, "status", "") or "").upper()
    if status_value != CollectionTaskStatus.FAILED.value:
        return False
    text_value = f"{getattr(task, 'last_error', '') or ''} {getattr(task, 'reason', '') or ''}".upper()
    return any(
        marker in text_value
        for marker in (
            "DRY_RUN_GAS_REQUIRED",
            "GAS_REQUIRED",
            "CREATE A POSITIVE TOPUP GAS TASK",
        )
    )


def _collection_task_has_real_tx_hash(task: CollectionTask) -> bool:
    tx_hash = str(getattr(task, "tx_hash", "") or "").strip()
    return bool(tx_hash.lower().startswith("0x") and not _admin_is_dry_run_tx_hash(tx_hash))


def _collection_task_send_allowed(task: CollectionTask) -> bool:
    status_value = str(getattr(task, "status", "") or "").upper()
    tx_hash = str(getattr(task, "tx_hash", "") or "").strip()
    if _collection_task_has_real_tx_hash(task):
        return False
    return bool(
        _admin_is_dry_run_tx_hash(tx_hash)
        or status_value
        in {
            CollectionTaskStatus.PENDING.value,
            CollectionTaskStatus.QUEUED.value,
            CollectionTaskStatus.READY.value,
            CollectionTaskStatus.FAILED.value,
            CollectionTaskStatus.GAS_REQUIRED.value,
            CollectionTaskStatus.GAS_QUEUED.value,
            CollectionTaskStatus.SKIPPED.value,
            "TIMEOUT",
        }
    )


def _collection_task_batch_send_allowed(task: CollectionTask) -> bool:
    status_value = str(getattr(task, "status", "") or "").upper()
    tx_hash = str(getattr(task, "tx_hash", "") or "").strip()
    if _collection_task_has_real_tx_hash(task):
        return False
    return bool(
        _admin_is_dry_run_tx_hash(tx_hash)
        or status_value
        in {
            CollectionTaskStatus.PENDING.value,
            CollectionTaskStatus.QUEUED.value,
            CollectionTaskStatus.READY.value,
        }
    )


def _publish_admin_collection_task_changed(task: CollectionTask) -> None:
    try:
        publish_collection_center_event(
            "collection_task_changed",
            {
                "batch_id": int(task.batch_id) if task.batch_id is not None else None,
                "collection_task_id": int(task.id),
                "task_id": int(task.id),
                "task_no": task.task_no,
                "status": task.status,
                "chain_key": task.chain_key,
                "coin_symbol": task.coin_symbol,
                "gas_task_id": int(task.gas_task_id) if task.gas_task_id is not None else None,
                "tx_hash": task.tx_hash or "",
                "failure_reason": task.last_error or task.reason or "",
                "updated_at": task.updated_at,
            },
        )
    except Exception:
        logger.debug("admin collection task changed publish failed task_id=%s", getattr(task, "id", None), exc_info=True)


def _enqueue_collection_task_send_redirect(
    *,
    db: Session,
    task: CollectionTask,
    task_id: int,
    next_path: str,
    action_label: str = "发",
) -> RedirectResponse:
    if not _collection_task_send_allowed(task):
        return RedirectResponse(
            url=_build_collection_tasks_redirect_url(
                next_path=next_path,
                error=f"归集任务 {task_id} 当前状态不允许{action_label}",
            ),
            status_code=302,
        )
    if is_collection_task_job_active(int(task.id)):
        return RedirectResponse(
            url=_build_collection_tasks_redirect_url(
                next_path=next_path,
                error=f"归集任务 {task_id} 已在发送队列中",
            ),
            status_code=302,
        )

    if not is_collection_real_send_enabled():
        task.status = CollectionTaskStatus.PENDING.value
        task.last_error = "GUARD_REJECTED:MASTER_SWITCH_OFF"
        task.next_retry_at = None
        task.locked_at = None
        task.updated_at = datetime.utcnow()
        db.commit()
        _publish_admin_collection_task_changed(task)
        return RedirectResponse(
            url=_build_collection_tasks_redirect_url(
                next_path=next_path,
                error="真实发送总闸未开启，任务已保持待真实发送",
            ),
            status_code=302,
        )

    try:
        task.status = CollectionTaskStatus.PENDING.value
        if _admin_is_dry_run_tx_hash(task.tx_hash):
            task.tx_hash = None
        task.reason = None
        task.last_error = None
        task.next_retry_at = None
        task.locked_at = None
        task.sent_at = None
        task.confirmed_at = None
        task.block_number = None
        task.updated_at = datetime.utcnow()
        db.commit()
        job_id = enqueue_collection_task(int(task.id), allow_real_send=True)
        notice = f"归集任务 {task_id} 已加入真实发送队列"
        if job_id:
            notice = f"{notice} job_id={job_id}"
        return RedirectResponse(
            url=_build_collection_tasks_redirect_url(next_path=next_path, notice=notice),
            status_code=302,
        )
    except Exception as exc:
        db.rollback()
        try:
            task = db.query(CollectionTask).filter(CollectionTask.id == int(task_id)).first()
            if task:
                task.status = CollectionTaskStatus.PENDING.value
                task.last_error = f"REAL_SEND_ENQUEUE_FAILED:{type(exc).__name__}:{str(exc)[:180]}"
                task.next_retry_at = None
                task.locked_at = None
                task.updated_at = datetime.utcnow()
                db.commit()
                _publish_admin_collection_task_changed(task)
        except Exception:
            db.rollback()
            logger.warning("collection task send enqueue failure note failed task_id=%s", task_id, exc_info=True)
        return RedirectResponse(
            url=_build_collection_tasks_redirect_url(
                next_path=next_path,
                error=f"归集任务 {task_id} 加入真实发送队列失败：{str(exc)[:180]}",
            ),
            status_code=302,
        )


def _enqueue_collection_task_send_redirect_by_id(
    *,
    db: Session,
    task_id: int,
    next_path: str,
    action_label: str = "发",
) -> RedirectResponse:
    task = db.query(CollectionTask).filter(CollectionTask.id == int(task_id)).first()
    if not task:
        return RedirectResponse(
            url=_build_collection_tasks_redirect_url(next_path=next_path, error=f"归集任务 {task_id} 不存"),
            status_code=302,
        )
    return _enqueue_collection_task_send_redirect(
        db=db,
        task=task,
        task_id=task_id,
        next_path=next_path,
        action_label=action_label,
    )


@router.post("/collections/tasks/{task_id}/send")
def collection_task_send(
    request: Request,
    task_id: int,
    next_path: str = Form("/admin/collections/tasks"),
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "collection_tasks.manage")
    if redir:
        return redir
    return _enqueue_collection_task_send_redirect_by_id(
        db=db,
        task_id=int(task_id),
        next_path=next_path,
        action_label="发",
    )


@router.post("/collections/tasks/{task_id}/safe-cancel")
def collection_task_safe_cancel(
    request: Request,
    task_id: int,
    next_path: str = Form("/admin/collections/tasks"),
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "collection_tasks.manage")
    if redir:
        return redir
    try:
        result = safe_cancel_collection_task(
            db,
            int(task_id),
            reason="ADMIN_CANCEL_STALE_AMOUNT_RESCAN_REQUIRED",
        )
        db.commit()
    except Exception as exc:
        db.rollback()
        return RedirectResponse(
            url=_build_collection_tasks_redirect_url(
                next_path=next_path,
                error=f"safe cancel collection task {task_id} failed: {str(exc)[:180]}",
            ),
            status_code=302,
        )

    gas_note = ""
    if result.gas_task_canceled and result.gas_task is not None:
        gas_note = f", linked gas_task {result.gas_task.id} canceled"
    elif result.gas_task_preserved and result.gas_task is not None:
        gas_note = f", linked gas_task {result.gas_task.id} preserved"
    return RedirectResponse(
        url=_build_collection_tasks_redirect_url(
            next_path=next_path,
            notice=f"collection task {task_id} canceled for rescan{gas_note}",
        ),
        status_code=302,
    )


@router.post("/collections/batches/{batch_id}/send")
def collection_batch_send(
    request: Request,
    batch_id: int,
    next_path: str = Form("/admin/collections/tasks"),
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "collection_tasks.manage")
    if redir:
        return redir

    tasks = (
        db.query(CollectionTask)
        .filter(CollectionTask.batch_id == int(batch_id))
        .order_by(CollectionTask.id.asc())
        .all()
    )
    eligible_tasks = [task for task in tasks if _collection_task_batch_send_allowed(task)]
    if not eligible_tasks:
        return RedirectResponse(
            url=_build_collection_tasks_redirect_url(next_path=next_path, error="没有可发送任"),
            status_code=302,
        )

    if not is_collection_real_send_enabled():
        now = datetime.utcnow()
        for task in eligible_tasks:
            task.status = CollectionTaskStatus.PENDING.value
            task.last_error = "GUARD_REJECTED:MASTER_SWITCH_OFF"
            task.next_retry_at = None
            task.locked_at = None
            task.updated_at = now
        db.commit()
        for task in eligible_tasks:
            _publish_admin_collection_task_changed(task)
        return RedirectResponse(
            url=_build_collection_tasks_redirect_url(
                next_path=next_path,
                error=f"真实发送总闸未开启，{len(eligible_tasks)} 个任务保持待真实发送",
            ),
            status_code=302,
        )

    enqueued_count = 0
    skipped_active = 0
    errors: list[str] = []
    prepared_tasks: list[CollectionTask] = []
    now = datetime.utcnow()
    try:
        for task in eligible_tasks:
            if is_collection_task_job_active(int(task.id)):
                skipped_active += 1
                continue
            task.status = CollectionTaskStatus.PENDING.value
            if _admin_is_dry_run_tx_hash(task.tx_hash):
                task.tx_hash = None
            task.reason = None
            task.last_error = None
            task.next_retry_at = None
            task.locked_at = None
            task.sent_at = None
            task.confirmed_at = None
            task.block_number = None
            task.updated_at = now
            prepared_tasks.append(task)
        db.commit()
        for task in prepared_tasks:
            _publish_admin_collection_task_changed(task)
        for task in prepared_tasks:
            try:
                enqueue_collection_task(int(task.id), allow_real_send=True)
                enqueued_count += 1
            except Exception as exc:
                errors.append(f"{task.id}:{str(exc)[:120]}")
                logger.warning("collection batch send enqueue failed task_id=%s", task.id, exc_info=True)
        if errors:
            for error_item in errors:
                task_id_text = error_item.split(":", 1)[0]
                try:
                    failed_task = db.query(CollectionTask).filter(CollectionTask.id == int(task_id_text)).first()
                    if failed_task:
                        failed_task.last_error = f"REAL_SEND_ENQUEUE_FAILED:{error_item.split(':', 1)[1]}"
                        failed_task.updated_at = datetime.utcnow()
                except Exception:
                    logger.debug("collection batch enqueue error note skipped item=%s", error_item, exc_info=True)
            db.commit()
    except Exception as exc:
        db.rollback()
        return RedirectResponse(
            url=_build_collection_tasks_redirect_url(
                next_path=next_path,
                error=f"批次 {batch_id} 发送入队失败：{str(exc)[:180]}",
            ),
            status_code=302,
        )

    if enqueued_count <= 0:
        message = "没有可发送任"
        if skipped_active:
            message = f"{message}，{skipped_active} 个任务已在队列中"
        if errors:
            message = f"{message}，入队失败 {len(errors)} 个"
        return RedirectResponse(
            url=_build_collection_tasks_redirect_url(next_path=next_path, error=message),
            status_code=302,
        )
    notice = f"已入队 {enqueued_count} 个任务"
    if skipped_active:
        notice = f"{notice}，跳过 {skipped_active} 个已在队列中的任务"
    if errors:
        notice = f"{notice}，入队失败 {len(errors)} 个"
    return RedirectResponse(
        url=_build_collection_tasks_redirect_url(next_path=next_path, notice=notice),
        status_code=302,
    )


@router.post("/collections/tasks/{task_id}/retry")
def collection_task_retry(
    request: Request,
    task_id: int,
    next_path: str = Form("/admin/collections/tasks"),
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "collection_tasks.manage")
    if redir:
        return redir

    task = db.query(CollectionTask).filter(CollectionTask.id == int(task_id)).first()
    if not task:
        return RedirectResponse(
            url=_build_collection_tasks_redirect_url(next_path=next_path, error=f"归集任务 {task_id} 不存"),
            status_code=302,
        )

    status_value = str(task.status or "").upper()
    tx_hash_value = str(task.tx_hash or "").strip()
    retry_count = int(task.retry_count or 0)
    max_retry = int(task.max_retry or 0)
    is_legacy_gas_required_failure = _is_legacy_collection_gas_required_failure(task)
    if tx_hash_value or (
        not is_legacy_gas_required_failure
        and not is_collection_task_retryable(status_value, tx_hash_value, retry_count, max_retry)
    ):
        return RedirectResponse(
            url=_build_collection_tasks_redirect_url(
                next_path=next_path,
                error=f"归集任务 {task_id} 当前状态不允许重试",
            ),
            status_code=302,
        )

    if is_collection_task_job_active(int(task.id)):
        return RedirectResponse(
            url=_build_collection_tasks_redirect_url(
                next_path=next_path,
                error=f"归集任务 {task_id} 已在队列中，暂不能执行真实归",
            ),
            status_code=302,
        )

    return _enqueue_collection_task_send_redirect(
        db=db,
        task=task,
        task_id=task_id,
        next_path=next_path,
        action_label="重试归集",
    )


@router.post("/collections/tasks/{task_id}/confirm-requeue")
def collection_task_confirm_requeue(
    request: Request,
    task_id: int,
    next_path: str = Form("/admin/collections/tasks"),
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "collection_tasks.manage")
    if redir:
        return redir

    task = db.query(CollectionTask).filter(CollectionTask.id == int(task_id)).first()
    if not task:
        return RedirectResponse(
            url=_build_collection_tasks_redirect_url(next_path=next_path, error=f"归集任务 {task_id} 不存"),
            status_code=302,
        )

    status_value = str(task.status or "").upper()
    tx_hash_value = str(task.tx_hash or "").strip()
    if status_value not in {CollectionTaskStatus.SENT.value, "CONFIRMING"}:
        return RedirectResponse(
            url=_build_collection_tasks_redirect_url(next_path=next_path, error=f"归集任务 {task_id} 当前状态不允许重投确认：{task.status}"),
            status_code=302,
        )
    if not tx_hash_value or _admin_is_dry_run_tx_hash(tx_hash_value):
        return RedirectResponse(
            url=_build_collection_tasks_redirect_url(next_path=next_path, error=f"归集任务 {task_id} 没有真实链上交易哈希，不能重投确"),
            status_code=302,
        )
    if task.confirmed_at:
        return RedirectResponse(
            url=_build_collection_tasks_redirect_url(next_path=next_path, error=f"归集任务 {task_id} 已确认，无需重投确认"),
            status_code=302,
        )

    try:
        job_id = enqueue_tx_confirm_collection_task(int(task_id))
        notice = f"归集任务 {task_id} 已重投链上确认，确认任务：{job_id}"
        error = ""
    except Exception as exc:
        notice = ""
        error = f"归集任务 {task_id} 重投确认失败：{str(exc)[:180]}"

    return RedirectResponse(
        url=_build_collection_tasks_redirect_url(next_path=next_path, notice=notice, error=error),
        status_code=302,
    )


@router.get("/collections/auto-settings", response_class=HTMLResponse)
def collection_auto_settings_page(
    request: Request,
    notice: str = "",
    error: str = "",
    db: Session = Depends(get_db),
):
    redir = require_admin_permission(request, db, "collection_tasks.manage")
    if redir:
        return redir
    filter_options = admin_query_collection_center_filters(db)
    auto_settings = admin_query_collection_auto_settings(db)
    return render(
        request,
        "admin/collection_auto_settings.html",
        ctx={
            "active_group": "system",
            "active": "collection_auto_settings",
            "notice": notice,
            "error": error,
            "networks": filter_options.get("networks") or [],
            "assets": filter_options.get("assets") or [],
            "overview": auto_settings.get("overview") or {},
            "services": auto_settings.get("services") or [],
            "service_alerts": auto_settings.get("service_alerts") or [],
            "rules": auto_settings.get("rules") or [],
        },
    )


@router.post("/collections/auto-settings/{chain_key}/update")
def collection_auto_settings_update(
    chain_key: str,
    request: Request,
    auto_collect_enabled: str = Form("0"),
    auto_gas_enabled: str = Form("0"),
    min_collect_amount: str = Form(""),
    scan_interval_seconds: str = Form("300"),
    max_addresses: str = Form("200"),
    reserve_gas_balance: str = Form(""),
    db: Session = Depends(get_db),
):
    redir = require_admin_permission(request, db, "collection_tasks.manage")
    if redir:
        return redir
    try:
        save_collection_auto_rule_config(
            db,
            chain_key,
            {
                "auto_collect_enabled": auto_collect_enabled,
                "auto_gas_enabled": auto_gas_enabled,
                "min_collect_amount": min_collect_amount,
                "scan_interval_seconds": scan_interval_seconds,
                "max_addresses": max_addresses,
                "reserve_gas_balance": reserve_gas_balance,
            },
        )
        db.commit()
        params = {"notice": f"{chain_key} 自动归集规则已保存"}
    except Exception as exc:
        db.rollback()
        params = {"error": f"{chain_key} 自动归集规则保存失败：{str(exc)[:180]}"}
    return RedirectResponse(
        url=f"/admin/collections/auto-settings?{urlencode(params)}",
        status_code=302,
    )


def _collection_center_context(
    request: Request,
    db: Session,
    *,
    view: str = "networks",
    chain_key: str = "",
    coin_symbol: str = "",
    status: str = "",
    source: str = "",
    min_amount: str = "",
    user_id: str = "",
    address: str = "",
    page: Any = 1,
    per_page: Any = 20,
    candidates: Optional[Dict[str, Any]] = None,
    notice: str = "",
    notice_detail: str = "",
    error: str = "",
) -> Dict[str, Any]:
    selected_view = str(view or "").strip().lower()
    if selected_view not in {"networks", "addresses", "assets"}:
        selected_view = "networks"
    filters = {
        "view": selected_view,
        "chain_key": str(chain_key or "").strip().lower(),
        "coin_symbol": str(coin_symbol or "").strip().upper(),
        "status": "",
        "source": str(source or "").strip().upper(),
        "min_amount": str(min_amount or "").strip(),
        "user_id": str(user_id or "").strip(),
        "address": str(address or "").strip(),
        "page": page,
        "per_page": per_page,
    }
    read_error = ""
    try:
        filter_options = admin_query_collection_center_filters(db)
    except Exception:
        filter_options = {"networks": [], "assets": []}
        read_error = "归集数据读取失败，请稍后重试"
    if not filters["chain_key"]:
        first_network = next(
            (item for item in (filter_options.get("networks") or []) if str(item.get("chain_key") or "").strip()),
            None,
        )
        if first_network:
            filters["chain_key"] = str(first_network.get("chain_key") or "").strip().lower()
    candidate_result = candidates if candidates is not None else admin_query_collection_candidate_workbench(db, filters)
    candidate_stats = dict(candidate_result.get("stats") or {})
    return {
        "active_group": "system",
        "active": "collection_center",
        "notice": notice,
        "notice_detail": _parse_collection_notice_detail(notice_detail),
        "error": error or read_error or candidate_result.get("error") or "",
        "view": "candidates",
        "filters": candidate_result.get("filters") or filters,
        "networks": filter_options.get("networks") or [],
        "assets": candidate_result.get("asset_options") or [],
        "stats": candidate_stats,
        "dashboard_stats": candidate_stats,
        "candidate_summary": {"can_create_tasks": True, "create_disabled_reason": ""},
        "candidate_items": candidate_result.get("items") or [],
        "items": candidate_result.get("items") or [],
        "has_verify_running": bool(candidate_result.get("has_verify_running")),
        "pagination": candidate_result.get("pagination") or {"total": 0, "page": 1, "per_page": 20, "page_size": 20, "pages": 1, "total_pages": 1, "allowed_per_page": [10, 20, 50, 100], "page_numbers": [1]},
        "asset_items": [],
        "address_items": [],
        "network_items": [],
        "network_cards": candidate_result.get("network_cards") or [],
    }
    try:
        stats = admin_query_collection_center_stats(db, filters)
    except Exception:
        stats = {
            "collectible_count": 0,
            "gas_required_count": 0,
            "collect_amounts": [],
            "recent_scan_at": "未扫",
            "balance_source": "未扫",
            "today_batches": 0,
            "active_collection_tasks": 0,
            "failed_tasks": 0,
            "today_collected_tasks": 0,
            "today_collected_amounts": [],
            "today_collected_label": "-",
            "candidate_error": "归集数据读取失败，请稍后重试",
        }
        read_error = read_error or "归集数据读取失败，请稍后重试"
    if candidates is not None:
        candidate_result = candidates
    else:
        candidate_result = admin_query_collection_center_snapshot(db, filters)
        if candidate_result.get("error"):
            read_error = read_error or str(candidate_result.get("error") or "")
    selected_network = None
    if filters["chain_key"]:
        selected_network = next(
            (item for item in (filter_options.get("networks") or []) if item.get("chain_key") == filters["chain_key"]),
            None,
        )
    create_disabled_reason = ""
    if selected_network and not selected_network.get("can_collect"):
        create_disabled_reason = "当前网络仅支持预览，暂不能创建真实归集任务"
    if selected_network:
        current_network = {
            "chain_key": filters["chain_key"],
            "display_name": selected_network.get("display_name") or selected_network.get("chain_name") or filters["chain_key"],
        }
    else:
        current_network = {
            "chain_key": filters["chain_key"],
            "display_name": "全部网络" if not filters["chain_key"] else filters["chain_key"],
        }
    current_network["label"] = (
        f"{current_network['display_name']} / {current_network['chain_key']}"
        if current_network.get("chain_key")
        else current_network["display_name"]
    )
    candidate_summary = dict(candidate_result.get("summary") or {})
    candidate_summary["can_create_tasks"] = not bool(create_disabled_reason)
    candidate_summary["create_disabled_reason"] = create_disabled_reason
    dashboard_stats = dict(candidate_summary.get("dashboard") or {})
    if not dashboard_stats:
        dashboard_stats = {
            "collectible_addresses": int(candidate_summary.get("collectible_count") or 0),
            "gas_required_addresses": int(candidate_summary.get("gas_required_count") or 0),
            "active_collection_tasks": int(stats.get("active_collection_tasks") or 0),
            "failed_tasks": int(stats.get("failed_tasks") or 0),
        }
    dashboard_stats.setdefault("active_collection_tasks", int(stats.get("active_collection_tasks") or 0))
    dashboard_stats.setdefault("today_collected_tasks", int(stats.get("today_collected_tasks") or 0))
    dashboard_stats.setdefault("today_collected_amounts", stats.get("today_collected_amounts") or [])
    dashboard_stats.setdefault("today_collected_label", stats.get("today_collected_label") or "-")
    return {
        "active_group": "system",
        "active": "collection_center",
        "notice": notice,
        "error": error or read_error or candidate_result.get("error") or stats.get("candidate_error") or "",
        "view": selected_view,
        "filters": filters,
        "networks": filter_options.get("networks") or [],
        "assets": filter_options.get("assets") or [],
        "stats": stats,
        "current_network": current_network,
        "dashboard_stats": dashboard_stats,
        "candidate_summary": candidate_summary,
        "items": candidate_result.get("items") or [],
        "asset_items": candidate_result.get("asset_items") or candidate_result.get("items") or [],
        "address_items": candidate_result.get("address_items") or [],
        "network_items": candidate_result.get("network_items") or candidate_summary.get("network_cards") or [],
        "network_cards": candidate_summary.get("network_cards") or candidate_result.get("network_items") or [],
    }


@router.get("/collections/center", response_class=HTMLResponse)
def collection_center_page(
    request: Request,
    view: str = "networks",
    chain_key: str = "",
    coin_symbol: str = "",
    status: str = "",
    source: str = "",
    min_amount: str = "",
    user_id: str = "",
    address: str = "",
    page: int = 1,
    per_page: int = 20,
    notice: str = "",
    notice_detail: str = "",
    error: str = "",
    db: Session = Depends(get_db),
):
    redir = require_admin_permission(request, db, "collection_tasks.manage")
    if redir:
        return redir
    return render(
        request,
        "admin/collection_center.html",
        ctx=_collection_center_context(
            request,
            db,
            view=view,
            chain_key=chain_key,
            coin_symbol=coin_symbol,
            status=status,
            source=source,
            min_amount=min_amount,
            user_id=user_id,
            address=address,
            page=page,
            per_page=per_page,
            notice=_clean_query_text(notice),
            notice_detail=notice_detail,
            error=_clean_query_text(error),
        ),
    )


@router.get("/collections/center/events")
async def collection_center_events(
    request: Request,
    chain_key: str = "",
    asset_symbol: str = "",
    coin_symbol: str = "",
    status: str = "",
    source: str = "",
    user_id: str = "",
    address_keyword: str = "",
    address: str = "",
    page: str = "",
    per_page: str = "",
    db: Session = Depends(get_db),
):
    redir = require_admin_permission(request, db, "collection_tasks.manage")
    if redir:
        return redir
    filters = {
        "chain_key": chain_key,
        "asset_symbol": asset_symbol or coin_symbol,
        "status": status,
        "source": source,
        "user_id": user_id,
        "address_keyword": address_keyword or address,
        "page": page,
        "per_page": per_page,
    }

    async def event_stream():
        redis = get_redis_connection()
        last_id = "$"
        heartbeat_after = 25.0
        last_sent = asyncio.get_event_loop().time()
        while True:
            if await request.is_disconnected():
                break
            try:
                streams = await asyncio.to_thread(
                    redis.xread,
                    {COLLECTION_CENTER_EVENT_STREAM: last_id},
                    count=20,
                    block=1000,
                )
            except Exception as exc:
                payload = json.dumps({"error": str(exc)[:180]}, ensure_ascii=False)
                yield f"event: error\ndata: {payload}\n\n"
                break
            sent_event = False
            for _, entries in streams or []:
                events = decode_collection_center_stream_entries(entries)
                for event in events:
                    stream_id = str(event.get("_stream_id") or "")
                    if stream_id:
                        last_id = stream_id
                    if not collection_center_event_matches_filters(event, filters):
                        continue
                    event_type = str(event.get("event_type") or "collection_center_event").strip()
                    payload = json.dumps(event, ensure_ascii=False, default=str)
                    yield f"event: {event_type}\ndata: {payload}\n\n"
                    sent_event = True
            now = asyncio.get_event_loop().time()
            if sent_event:
                last_sent = now
            elif now - last_sent >= heartbeat_after:
                yield 'event: heartbeat\ndata: {"ok": true}\n\n'
                last_sent = now

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.post("/collections/center/verify", response_class=HTMLResponse)
def collection_center_verify_candidate(
    request: Request,
    chain_key: str = Form(""),
    coin_symbol: str = Form(""),
    candidate_id: str = Form(""),
    user_id: str = Form(""),
    address: str = Form(""),
    status: str = Form(""),
    source: str = Form(""),
    page: str = Form(""),
    per_page: str = Form(""),
    return_chain_key: str = Form(""),
    return_asset_symbol: str = Form(""),
    return_status: str = Form(""),
    return_source: str = Form(""),
    return_user_id: str = Form(""),
    return_address_keyword: str = Form(""),
    return_page: str = Form(""),
    return_per_page: str = Form(""),
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "collection_tasks.manage")
    if redir:
        return redir
    selected_chain = str(chain_key or "").strip().lower()
    selected_symbol = str(coin_symbol or "").strip().upper()
    selected_address = str(address or "").strip().lower()
    selected_candidate_id = str(candidate_id or "").strip()
    redirect_chain = str(return_chain_key or "").strip().lower() or selected_chain
    redirect_symbol = str(return_asset_symbol or "").strip().upper()
    redirect_status = str(return_status if return_status is not None else status).strip().upper()
    redirect_source = str(return_source if return_source is not None else source).strip().upper()
    redirect_user_id = str(return_user_id if return_user_id is not None else "").strip()
    redirect_address = str(return_address_keyword if return_address_keyword is not None else "").strip().lower()
    redirect_page = str(return_page or page or "").strip()
    redirect_per_page = str(return_per_page or per_page or "").strip()
    notice_text = ""
    error_text = ""
    try:
        if not selected_chain or not selected_symbol or not selected_address:
            raise ValueError("请先选择完整的网络、币种和地址")
        scan_batch_started_at = datetime.utcnow().isoformat(timespec="seconds") + "Z"
        scan_batch_id = f"collection_candidate_verify_{datetime.utcnow().strftime('%Y%m%d%H%M%S%f')}"
        scan_filters = {
            "view": "addresses",
            "chain_key": selected_chain,
            "coin_symbol": selected_symbol,
            "user_id": str(user_id or "").strip(),
            "address": selected_address,
            "candidate_id": selected_candidate_id,
            "candidate_source": "events",
            "scan_batch_id": scan_batch_id,
            "scan_batch_started_at": scan_batch_started_at,
        }
        result = enqueue_collection_center_scan(selected_chain, scan_filters, scan_batch_id=scan_batch_id)
        if result.get("enqueued"):
            write_candidate_verify_status(
                selected_candidate_id,
                status="running",
                chain_key=selected_chain,
                coin_symbol=selected_symbol,
                address=selected_address,
                scan_batch_id=scan_batch_id,
            )
            publish_collection_center_event(
                "candidate_verify_started",
                {
                    "candidate_id": selected_candidate_id,
                    "chain_key": selected_chain,
                    "asset_symbol": selected_symbol,
                    "coin_symbol": selected_symbol,
                    "address": selected_address,
                    "user_id": str(user_id or "").strip(),
                    "status": "running",
                    "message": "复核",
                },
            )
            notice_text = "链上核实已提交，完成后余额会更新"
        elif result.get("already_running"):
            write_candidate_verify_status(
                selected_candidate_id,
                status="running",
                chain_key=selected_chain,
                coin_symbol=selected_symbol,
                address=selected_address,
                scan_batch_id=scan_batch_id,
            )
            publish_collection_center_event(
                "candidate_verify_started",
                {
                    "candidate_id": selected_candidate_id,
                    "chain_key": selected_chain,
                    "asset_symbol": selected_symbol,
                    "coin_symbol": selected_symbol,
                    "address": selected_address,
                    "user_id": str(user_id or "").strip(),
                    "status": "running",
                    "message": "复核",
                },
            )
            notice_text = "链上核实正在处理中，请稍后刷新"
        else:
            notice_text = "链上核实已提交，完成后余额会更新"
    except ValueError as exc:
        error_text = str(exc)
    except Exception:
        logger.exception("collection candidate verify enqueue failed")
        error_text = "链上核实提交失败，请稍后重试"
    return RedirectResponse(
        url=_build_collection_center_redirect_url(
            chain_key=redirect_chain,
            coin_symbol=redirect_symbol,
            status=redirect_status,
            source=redirect_source,
            user_id=redirect_user_id,
            address=redirect_address,
            page=redirect_page,
            per_page=redirect_per_page,
            notice=notice_text,
            error=error_text,
            anchor="candidate-list",
        ),
        status_code=303,
    )


@router.post("/collections/center/scan", response_class=HTMLResponse)
def collection_center_scan(
    request: Request,
    view: str = Form("networks"),
    chain_key: str = Form(""),
    scan_chain_key: str = Form(""),
    target_chain_key: str = Form(""),
    coin_symbol: str = Form(""),
    min_amount: str = Form(""),
    user_id: str = Form(""),
    address: str = Form(""),
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "collection_tasks.manage")
    if redir:
        return redir
    filters = {
        "view": view,
        "chain_key": chain_key,
        "coin_symbol": coin_symbol,
        "status": status,
        "source": source,
        "min_amount": min_amount,
        "user_id": user_id,
        "address": address,
    }
    selected_chain = str(scan_chain_key or target_chain_key or "").strip().lower()
    if selected_chain in {"all", "*", "__all__"}:
        selected_chain = ""
    selected_symbol = str(coin_symbol or "").strip().upper()
    effective_coin_symbol = selected_symbol or "USDT"
    try:
        if effective_coin_symbol in {"*", "ALL", "__ALL__"}:
            raise ValueError("全币种补漏扫描暂未开放，请选择具体币种")
        options = admin_query_collection_center_filters(db)
        available_networks = [
            str(item.get("chain_key") or "").strip().lower()
            for item in (options.get("networks") or [])
            if str(item.get("chain_key") or "").strip() and item.get("can_collect")
        ]
        asset_networks = {
            str(symbol or "").strip().upper(): {
                str(chain or "").strip().lower()
                for chain in (chains or [])
                if str(chain or "").strip()
            }
            for symbol, chains in (options.get("asset_networks") or {}).items()
        }
        configured_networks = asset_networks.get(effective_coin_symbol, set())
        if selected_chain:
            if selected_chain not in available_networks:
                raise ValueError("所选网络暂不支持补漏扫")
            candidate_chain_keys = [selected_chain]
        else:
            candidate_chain_keys = list(available_networks)
        scan_chain_keys = [item for item in candidate_chain_keys if item in configured_networks]
        if not scan_chain_keys:
            if selected_chain:
                raise ValueError("所选币种未配置该网络，未提交扫描任务")
            raise ValueError("所选币种未配置可扫描网络，未提交扫描任务")
        scan_batch_started_at = datetime.utcnow().isoformat(timespec="seconds") + "Z"
        scan_batch_id = f"collection_center_scan_{datetime.utcnow().strftime('%Y%m%d%H%M%S%f')}"
        scan_filters = {
            **filters,
            "coin_symbol": effective_coin_symbol,
            "candidate_source": "address_book",
            "scan_batch_id": scan_batch_id,
            "scan_batch_started_at": scan_batch_started_at,
        }
        enqueue_results = [
            enqueue_collection_center_scan(item, scan_filters, scan_batch_id=scan_batch_id)
            for item in scan_chain_keys
        ]
        enqueued_count = sum(1 for item in enqueue_results if item.get("enqueued"))
        running_count = sum(1 for item in enqueue_results if item.get("already_running"))
        if enqueued_count:
            notice_text = f"补漏扫描已提交（{enqueued_count} 个网络，币种 {effective_coin_symbol}），稍后刷新查看结果"
            if running_count:
                notice_text += f" {running_count} 个网络已有扫描任务运行中"
        else:
            notice_text = "补漏扫描任务已在运行中，稍后刷新查看结果"
        error_text = ""
    except ValueError as exc:
        notice_text = ""
        error_text = str(exc) or "扫描任务提交失败，请稍后重试"
    except Exception:
        logger.exception("collection center scan enqueue failed")
        notice_text = ""
        error_text = "扫描任务提交失败，请稍后重试"
    return RedirectResponse(
        url=_build_collection_center_redirect_url(
            view=view,
            chain_key=selected_chain,
            coin_symbol=effective_coin_symbol,
            min_amount=min_amount,
            user_id=user_id,
            address=address,
            notice=notice_text,
            error=error_text,
        ),
        status_code=303,
    )


def _build_collection_tools_redirect_url(
    *,
    chain_key: str = "",
    coin_symbol: str = "",
    user_id: str = "",
    address: str = "",
    scan_batch_id: str = "",
    page: str = "",
    per_page: str = "",
    notice: str = "",
    error: str = "",
    added: bool = False,
) -> str:
    params = []
    if chain_key:
        params.append(f"chain_key={quote(str(chain_key))}")
    if coin_symbol:
        params.append(f"coin_symbol={quote(str(coin_symbol))}")
    if user_id:
        params.append(f"user_id={quote(str(user_id))}")
    if address:
        params.append(f"address={quote(str(address))}")
    if scan_batch_id:
        params.append(f"scan_batch_id={quote(str(scan_batch_id))}")
    if page:
        params.append(f"page={quote(str(page))}")
    if per_page:
        params.append(f"per_page={quote(str(per_page))}")
    if notice:
        params.append(f"notice={quote(notice)}")
    if error:
        params.append(f"error={quote(error)}")
    if added:
        params.append("added=1")
    return "/admin/collections/tools" + (f"?{'&'.join(params)}" if params else "")


@router.get("/collections/tools", response_class=HTMLResponse)
def collection_tools_page(
    request: Request,
    chain_key: str = "",
    coin_symbol: str = "USDT",
    user_id: str = "",
    address: str = "",
    scan_batch_id: str = "",
    page: int = 1,
    per_page: int = 20,
    notice: str = "",
    error: str = "",
    added: str = "",
    db: Session = Depends(get_db),
):
    redir = require_admin_permission(request, db, "collection_tasks.manage")
    if redir:
        return redir
    try:
        filter_options = admin_query_collection_center_filters(db)
    except Exception:
        filter_options = {"networks": [], "assets": []}
        error = error or "归集工具配置读取失败，请稍后重试"
    filters = {
        "chain_key": str(chain_key or "").strip().lower(),
        "coin_symbol": str(coin_symbol or "").strip().upper(),
        "user_id": str(user_id or "").strip(),
        "address": str(address or "").strip().lower(),
        "scan_batch_id": str(scan_batch_id or "").strip(),
        "page": page,
        "per_page": per_page,
    }
    try:
        tool_results = admin_query_collection_tool_results(db, filters)
    except Exception:
        logger.exception("collection tools result query failed")
        tool_results = {"items": [], "error": "扫描结果读取失败，请稍后重试"}
        error = error or tool_results["error"]
    return render(
        request,
        "admin/collection_tools.html",
        ctx={
            "active_group": "system",
            "active": "collection_tools",
            "notice": _clean_query_text(notice),
            "error": _clean_query_text(error),
            "networks": filter_options.get("networks") or [],
            "assets": filter_options.get("assets") or [],
            "filters": filters,
            "scan_results": tool_results.get("items") or [],
            "scan_progress": tool_results.get("progress") or {},
            "scan_pagination": tool_results.get("pagination") or {"total": 0, "page": 1, "per_page": 20, "page_size": 20, "pages": 1, "total_pages": 1, "allowed_per_page": [10, 20, 50, 100], "page_numbers": [1]},
            "scan_addable_count": int(tool_results.get("addable_count") or 0),
            "candidate_added": str(added or "").strip() == "1",
            "workbench_url": f"/admin/collections/center?chain_key={filters['chain_key']}" if filters.get("chain_key") else "/admin/collections/center",
        },
    )


@router.get("/collections/tools/scan-events")
async def collection_tools_scan_events(
    request: Request,
    scan_batch_id: str = "",
    db: Session = Depends(get_db),
):
    redir = require_admin_permission(request, db, "collection_tasks.manage")
    if redir:
        return redir
    batch_id = str(scan_batch_id or "").strip()
    if not batch_id:
        async def missing_batch_stream():
            yield 'event: error\n'
            yield 'data: {"message":"SCAN_BATCH_ID_REQUIRED"}\n\n'
        return StreamingResponse(missing_batch_stream(), media_type="text/event-stream")

    async def event_stream():
        key = f"collection:tool_scan:{batch_id}"
        last_payload = ""
        redis = None
        deadline = datetime.utcnow() + timedelta(minutes=10)
        try:
            redis = get_redis_connection()
            while datetime.utcnow() < deadline:
                if await request.is_disconnected():
                    break
                try:
                    raw = redis.get(key)
                except Exception as exc:
                    data = json.dumps({"message": f"REDIS_READ_FAILED:{str(exc)[:120]}"}, ensure_ascii=False)
                    yield f"event: error\ndata: {data}\n\n"
                    break
                if raw is None:
                    data = json.dumps({"message": "SCAN_SNAPSHOT_NOT_FOUND"}, ensure_ascii=False)
                    yield f"event: error\ndata: {data}\n\n"
                    break
                if isinstance(raw, bytes):
                    raw = raw.decode("utf-8")
                payload = str(raw or "{}")
                try:
                    payload_data = json.loads(payload) or {}
                except Exception:
                    payload_data = {}
                if (
                    isinstance(payload_data, dict)
                    and str(payload_data.get("status") or "").strip().lower() == "completed"
                ):
                    try:
                        finalized_payload = finalize_tool_scan_snapshot(payload_data, scan_batch_id=batch_id)
                        payload = json.dumps(finalized_payload, ensure_ascii=False, default=str, sort_keys=True)
                        try:
                            redis.set(key, payload, ex=24 * 60 * 60)
                        except Exception:
                            pass
                    except Exception as exc:
                        logger.exception(
                            "collection tool scan event finalize failed scan_batch_id=%s error=%s",
                            batch_id,
                            exc,
                        )
                        data = json.dumps(
                            {"message": f"SCAN_PROGRESS_FINALIZE_FAILED:{str(exc)[:120]}"},
                            ensure_ascii=False,
                        )
                        yield f"event: error\ndata: {data}\n\n"
                        break
                if payload != last_payload:
                    last_payload = payload
                    yield f"event: progress\ndata: {payload}\n\n"
                    status = str((payload_data or {}).get("status") or "").strip().lower()
                    if isinstance(payload_data, dict):
                        status = str((json.loads(payload) or {}).get("status") or status).strip().lower()
                    if status in {"completed", "failed"}:
                        yield "event: done\ndata: {}\n\n"
                        break
                await asyncio.sleep(1)
            else:
                data = json.dumps({"message": "SCAN_EVENT_STREAM_TIMEOUT"}, ensure_ascii=False)
                yield f"event: error\ndata: {data}\n\n"
        finally:
            try:
                if redis is not None:
                    redis.close()
            except Exception:
                pass

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@router.post("/collections/tools/scan-missing", response_class=HTMLResponse)
def collection_tools_scan_missing(
    request: Request,
    chain_key: str = Form(""),
    coin_symbol: str = Form(""),
    user_id: str = Form(""),
    address: str = Form(""),
    per_page: str = Form("20"),
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "collection_tasks.manage")
    if redir:
        return redir
    selected_chain = str(chain_key or "").strip().lower()
    selected_symbol = str(coin_symbol or "").strip().upper()
    selected_user_id = str(user_id or "").strip()
    selected_address = str(address or "").strip().lower()
    scan_batch_id = ""
    notice_text = ""
    error_text = ""
    try:
        if not selected_chain:
            raise ValueError("请选择网络")
        if not selected_symbol:
            raise ValueError("请选择币种")
        if selected_symbol in {"*", "ALL", "__ALL__"}:
            raise ValueError("请选择具体币种")
        parsed_user_id = ""
        if selected_user_id:
            parsed_user_id = str(int(selected_user_id))
        options = admin_query_collection_center_filters(db)
        available_networks = {
            str(item.get("chain_key") or "").strip().lower()
            for item in (options.get("networks") or [])
            if str(item.get("chain_key") or "").strip() and item.get("can_collect")
        }
        if selected_chain not in available_networks:
            raise ValueError("所选网络暂不支持归集候选扫描")
        symbols = {
            str(item or "").strip().upper()
            for item in (options.get("network_assets") or {}).get(selected_chain, [])
            if str(item or "").strip()
        }
        if selected_symbol not in symbols:
            raise ValueError("所选币种未配置该网络")
        scan_batch_started_at = datetime.utcnow().isoformat(timespec="seconds") + "Z"
        scan_timestamp = datetime.utcnow().strftime('%Y%m%d%H%M%S%f')
        scan_batch_id = f"collection_tool_scan_{selected_chain}_{selected_symbol.lower()}_{scan_timestamp}"
        scan_filters = {
            "view": "addresses",
            "chain_key": selected_chain,
            "coin_symbol": selected_symbol,
            "user_id": parsed_user_id,
            "address": selected_address,
            "candidate_source": "address_book_missing_candidates",
            "scan_batch_id": scan_batch_id,
            "scan_batch_started_at": scan_batch_started_at,
        }
        initial_progress = prepare_collection_tool_scan_progress(
            db,
            scan_batch_id=scan_batch_id,
            chain_key=selected_chain,
            coin_symbol=selected_symbol,
            user_id=int(parsed_user_id) if parsed_user_id else None,
            address=selected_address,
        )
        if int(initial_progress.get("total") or 0) <= 0:
            notice_text = "当前筛选范围内暂无未入候选地址"
        else:
            result = enqueue_collection_center_scan(
                selected_chain,
                scan_filters,
                scan_batch_id=scan_batch_id,
                job_id_prefix="collection_tool_scan",
                job_id_coin_symbol=selected_symbol,
            )
            if result.get("enqueued"):
                notice_text = f"未入候选地址扫描已提交（{selected_chain} / {selected_symbol}），稍后刷新查看结果"
            elif result.get("already_running"):
                if str(result.get("job_id") or "").startswith("collection_tool_scan"):
                    scan_batch_id = str(result.get("scan_batch_id") or "").strip()
                else:
                    scan_batch_id = ""
                notice_text = "该网络已有扫描任务在运行中，请稍后刷新"
            else:
                scan_batch_id = ""
                notice_text = "未入候选地址扫描已提交，请稍后刷新"
    except ValueError as exc:
        error_text = str(exc)
    except Exception:
        logger.exception("collection tools missing scan enqueue failed")
        error_text = "未入候选地址扫描提交失败，请稍后重试"
    return RedirectResponse(
        url=_build_collection_tools_redirect_url(
            chain_key=selected_chain,
            coin_symbol=selected_symbol,
            user_id=selected_user_id,
            address=selected_address,
            scan_batch_id=scan_batch_id,
            page="1",
            per_page=per_page,
            notice=notice_text,
            error=error_text,
        ),
        status_code=303,
    )


@router.post("/collections/tools/scan", response_class=HTMLResponse)
def collection_tools_scan(
    request: Request,
    chain_key: str = Form(""),
    coin_symbol: str = Form(""),
    address: str = Form(""),
    per_page: str = Form("20"),
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "collection_tasks.manage")
    if redir:
        return redir
    selected_chain = str(chain_key or "").strip().lower()
    selected_symbol = str(coin_symbol or "USDT").strip().upper()
    selected_address = str(address or "").strip().lower()
    scan_batch_id = ""
    notice_text = ""
    error_text = ""
    try:
        if not selected_chain or not selected_symbol or not selected_address:
            raise ValueError("请填写网络、币种和地址")
        if selected_symbol in {"*", "ALL", "__ALL__"}:
            raise ValueError("高级工具暂不支持全币种扫描，请选择具体币种")
        scan_batch_started_at = datetime.utcnow().isoformat(timespec="seconds") + "Z"
        scan_timestamp = datetime.utcnow().strftime('%Y%m%d%H%M%S%f')
        scan_batch_id = f"collection_tool_scan_{selected_chain}_{selected_symbol.lower()}_{scan_timestamp}"
        scan_filters = {
            "view": "addresses",
            "chain_key": selected_chain,
            "coin_symbol": selected_symbol,
            "address": selected_address,
            "candidate_source": "address_book",
            "scan_batch_id": scan_batch_id,
            "scan_batch_started_at": scan_batch_started_at,
        }
        result = enqueue_collection_center_scan(
            selected_chain,
            scan_filters,
            scan_batch_id=scan_batch_id,
            job_id_prefix="collection_tool_scan",
            job_id_coin_symbol=selected_symbol,
        )
        if result.get("enqueued"):
            notice_text = f"手工扫描已提交（{selected_chain} / {selected_symbol} / {selected_address}）"
        elif result.get("already_running"):
            if str(result.get("job_id") or "").startswith("collection_tool_scan"):
                scan_batch_id = str(result.get("scan_batch_id") or "").strip()
            else:
                scan_batch_id = ""
            notice_text = "该网络已有扫描任务在运行中，请稍后刷新"
        else:
            scan_batch_id = ""
            notice_text = "手工扫描已提交，请稍后刷新"
    except ValueError as exc:
        error_text = str(exc)
    except Exception:
        logger.exception("collection tools scan enqueue failed")
        error_text = "手工扫描提交失败，请稍后重试"
    return RedirectResponse(
        url=_build_collection_tools_redirect_url(
            chain_key=selected_chain,
            coin_symbol=selected_symbol,
            address=selected_address,
            scan_batch_id=scan_batch_id,
            page="1",
            per_page=per_page,
            notice=notice_text,
            error=error_text,
        ),
        status_code=303,
    )


@router.post("/collections/tools/add-candidate", response_class=HTMLResponse)
def collection_tools_add_candidate(
    request: Request,
    chain_key: str = Form(""),
    asset_symbol: str = Form(""),
    address: str = Form(""),
    return_address: str = Form(""),
    user_id: str = Form(""),
    balance_amount: str = Form(""),
    scan_batch_id: str = Form(""),
    page: str = Form(""),
    per_page: str = Form(""),
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "collection_tasks.manage")
    if redir:
        return redir
    selected_chain = str(chain_key or "").strip().lower()
    selected_symbol = str(asset_symbol or "").strip().upper()
    selected_address = str(address or "").strip().lower()
    selected_return_address = str(return_address or "").strip().lower()
    selected_scan_batch_id = str(scan_batch_id or "").strip()
    notice_text = ""
    error_text = ""
    added = False
    try:
        result = admin_add_manual_collection_candidate(
            db,
            chain_key=selected_chain,
            asset_symbol=selected_symbol,
            address=selected_address,
            user_id=user_id,
            balance_amount=balance_amount,
        )
        if result.get("ok"):
            notice_text = str(result.get("message") or "已加入归集候选")
            added = not bool(result.get("already_exists"))
            admin_update_collection_tool_candidate_row(
                selected_scan_batch_id,
                chain_key=selected_chain,
                asset_symbol=selected_symbol,
                address=selected_address,
                user_id=user_id,
                added=added,
                already_exists=bool(result.get("already_exists")),
                message=notice_text,
            )
        else:
            error_text = str(result.get("message") or "加入归集候选失败，请稍后重试")
            admin_update_collection_tool_candidate_row(
                selected_scan_batch_id,
                chain_key=selected_chain,
                asset_symbol=selected_symbol,
                address=selected_address,
                user_id=user_id,
                failed=True,
                message=error_text,
            )
    except Exception:
        db.rollback()
        logger.exception("collection tools add candidate failed")
        error_text = "加入归集候选失败，请稍后重试"
        admin_update_collection_tool_candidate_row(
            selected_scan_batch_id,
            chain_key=selected_chain,
            asset_symbol=selected_symbol,
            address=selected_address,
            user_id=user_id,
            failed=True,
            message=error_text,
        )
    return RedirectResponse(
        url=_build_collection_tools_redirect_url(
            chain_key=selected_chain,
            coin_symbol=selected_symbol,
            address=selected_return_address,
            scan_batch_id=selected_scan_batch_id,
            page=page,
            per_page=per_page,
            notice=notice_text,
            error=error_text,
            added=added,
        ),
        status_code=303,
    )


@router.post("/collections/tools/add-candidates", response_class=HTMLResponse)
def collection_tools_add_candidates(
    request: Request,
    chain_key: str = Form(""),
    coin_symbol: str = Form(""),
    user_id: str = Form(""),
    address: str = Form(""),
    scan_batch_id: str = Form(""),
    page: str = Form(""),
    per_page: str = Form(""),
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "collection_tasks.manage")
    if redir:
        return redir
    selected_chain = str(chain_key or "").strip().lower()
    selected_symbol = str(coin_symbol or "").strip().upper()
    selected_user_id = str(user_id or "").strip()
    selected_address = str(address or "").strip().lower()
    selected_scan_batch_id = str(scan_batch_id or "").strip()
    notice_text = ""
    error_text = ""
    added = False
    try:
        result = admin_query_collection_tool_results(
            db,
            {
                "chain_key": selected_chain,
                "coin_symbol": selected_symbol,
                "user_id": selected_user_id,
                "address": selected_address,
                "scan_batch_id": selected_scan_batch_id,
                "page": page,
                "per_page": per_page,
                "paginate": False,
            },
        )
        rows = [item for item in (result.get("items") or []) if item.get("can_add_candidate")]
        added_count = 0
        skipped_count = 0
        for item in rows:
            item_chain = item.get("chain_key") or selected_chain
            item_symbol = item.get("coin_symbol") or ""
            item_address = item.get("address") or ""
            item_user_id = item.get("user_id") or ""
            add_result = admin_add_manual_collection_candidate(
                db,
                chain_key=item_chain,
                asset_symbol=item_symbol,
                address=item_address,
                user_id=item_user_id,
                balance_amount=item.get("balance_amount") or "0",
            )
            if add_result.get("ok") and not add_result.get("already_exists"):
                added_count += 1
                admin_update_collection_tool_candidate_row(
                    selected_scan_batch_id,
                    chain_key=item_chain,
                    asset_symbol=item_symbol,
                    address=item_address,
                    user_id=item_user_id,
                    added=True,
                    message=str(add_result.get("message") or "已加入归集候选"),
                )
            elif add_result.get("ok") and add_result.get("already_exists"):
                skipped_count += 1
                admin_update_collection_tool_candidate_row(
                    selected_scan_batch_id,
                    chain_key=item_chain,
                    asset_symbol=item_symbol,
                    address=item_address,
                    user_id=item_user_id,
                    already_exists=True,
                    message=str(add_result.get("message") or "候选已存在"),
                )
            else:
                skipped_count += 1
                admin_update_collection_tool_candidate_row(
                    selected_scan_batch_id,
                    chain_key=item_chain,
                    asset_symbol=item_symbol,
                    address=item_address,
                    user_id=item_user_id,
                    failed=True,
                    message=str(add_result.get("message") or "加入失败"),
                )
        if added_count:
            notice_text = f"已加入 {added_count} 个归集候选"
            if skipped_count:
                notice_text += f" 跳过 {skipped_count} 个"
            added = True
        else:
            notice_text = "没有可加入的候选"
    except Exception:
        db.rollback()
        logger.exception("collection tools bulk add candidates failed")
        error_text = "批量加入归集候选失败，请稍后重试"
    return RedirectResponse(
        url=_build_collection_tools_redirect_url(
            chain_key=selected_chain,
            coin_symbol=selected_symbol,
            user_id=selected_user_id,
            address=selected_address,
            scan_batch_id=selected_scan_batch_id,
            page=page,
            per_page=per_page,
            notice=notice_text,
            error=error_text,
            added=added,
        ),
        status_code=303,
    )


@router.post("/collections/center/create-batch")
def collection_center_create_batch(
    request: Request,
    view: str = Form("networks"),
    chain_key: str = Form(""),
    coin_symbol: str = Form(""),
    status: str = Form(""),
    source: str = Form(""),
    min_amount: str = Form(""),
    user_id: str = Form(""),
    address: str = Form(""),
    page: str = Form(""),
    per_page: str = Form(""),
    confirm_text: str = Form(""),
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "collection_tasks.manage")
    if redir:
        return redir
    if str(confirm_text or "").strip().upper() != "COLLECT":
        return RedirectResponse(
            url=_build_collection_center_redirect_url(
                view=view,
                chain_key=chain_key,
                coin_symbol=coin_symbol,
                status=status,
                source=source,
                min_amount=min_amount,
                user_id=user_id,
                address=address,
                page=page,
                per_page=per_page,
                error="请输入 COLLECT 确认创建归集批次/任务",
            ),
            status_code=302,
        )
    try:
        result = admin_create_collection_batch_from_verified_candidates(
            db,
            admin_user_id=(get_admin_from_request(request) or {}).get("id"),
            filters={
                "view": view,
                "chain_key": chain_key,
                "coin_symbol": coin_symbol,
                "status": status,
                "source": source,
                "min_amount": min_amount,
                "user_id": user_id,
                "address": address,
            },
        )
        db.commit()
        enqueue_result = _enqueue_created_collection_jobs(db, result)
        notice, notice_detail = _build_collection_create_notice(result, enqueue_result)
        batch_id = result.get("batch_id")
        if batch_id:
            return RedirectResponse(
                url=_build_collection_tasks_redirect_url(
                    next_path=f"/admin/collections/tasks?batch_id={batch_id}",
                    notice=notice,
                    notice_detail=notice_detail,
                ),
                status_code=302,
            )
        return RedirectResponse(
            url=_build_collection_center_redirect_url(
                view=view,
                chain_key=chain_key,
                coin_symbol=coin_symbol,
                status=status,
                source=source,
                min_amount=min_amount,
                user_id=user_id,
                address=address,
                page=page,
                per_page=per_page,
                notice=notice,
                notice_detail=notice_detail,
            ),
            status_code=302,
        )
    except Exception:
        db.rollback()
        return RedirectResponse(
            url=_build_collection_center_redirect_url(
                view=view,
                chain_key=chain_key,
                coin_symbol=coin_symbol,
                status=status,
                source=source,
                min_amount=min_amount,
                user_id=user_id,
                address=address,
                page=page,
                per_page=per_page,
                error="创建归集批次失败，请稍后重试",
            ),
            status_code=302,
        )


@router.post("/collections/center/create-one")
def collection_center_create_one(
    request: Request,
    view: str = Form("networks"),
    chain_key: str = Form(""),
    coin_symbol: str = Form(""),
    min_amount: str = Form(""),
    user_id: str = Form(""),
    address: str = Form(""),
    candidate_id: str = Form(""),
    status: str = Form(""),
    source: str = Form(""),
    action_mode: str = Form("collection"),
    page: str = Form(""),
    per_page: str = Form(""),
    return_chain_key: str = Form(""),
    return_asset_symbol: str = Form(""),
    return_status: str = Form(""),
    return_source: str = Form(""),
    return_user_id: str = Form(""),
    return_address_keyword: str = Form(""),
    return_page: str = Form(""),
    return_per_page: str = Form(""),
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "collection_tasks.manage")
    if redir:
        return redir
    filters = {
        "view": view,
        "chain_key": chain_key,
        "coin_symbol": coin_symbol,
        "min_amount": min_amount,
        "user_id": user_id,
        "address": address,
    }
    redirect_chain = str(return_chain_key or "").strip().lower() or str(chain_key or "").strip().lower()
    redirect_symbol = str(return_asset_symbol or "").strip().upper()
    redirect_status = str(return_status or status or "").strip().upper()
    redirect_source = str(return_source or source or "").strip().upper()
    redirect_user_id = str(return_user_id or "").strip()
    redirect_address = str(return_address_keyword or "").strip().lower()
    redirect_page = str(return_page or page or "").strip()
    redirect_per_page = str(return_per_page or per_page or "").strip()
    selected_candidate_id = str(candidate_id or "").strip()
    wants_json = "application/json" in str(request.headers.get("accept") or "").lower()

    def _json_or_redirect(payload: Dict[str, Any], *, notice: str = "", error: str = ""):
        if wants_json:
            return JSONResponse(payload, status_code=200 if payload.get("ok") else 400)
        return RedirectResponse(
            url=_build_collection_center_redirect_url(
                view=view,
                chain_key=redirect_chain,
                coin_symbol=redirect_symbol,
                min_amount=min_amount,
                user_id=redirect_user_id,
                address=redirect_address,
                status=redirect_status,
                source=redirect_source,
                page=redirect_page,
                per_page=redirect_per_page,
                notice=notice,
                error=error,
                anchor="candidate-list",
            ),
            status_code=302,
        )

    def _not_created_reason(result: Dict[str, Any], *, mode: str) -> tuple[str, str]:
        scan = result.get("scan")
        candidates = list(getattr(scan, "candidates", []) or [])
        reason_values: list[str] = []
        for candidate in candidates:
            reason_values.append(str(getattr(candidate, "reason", "") or "").upper())
            evaluation = getattr(candidate, "evaluation", None)
            reason_values.append(str(getattr(evaluation, "reason", "") or "").upper())
        reasons = " ".join(reason_values)
        if mode == "collection":
            skipped_stats = result.get("skipped_reason_stats") or {}
            if int(skipped_stats.get("CHAIN_COLLECTION_DISABLED") or 0) > 0:
                return "CHAIN_COLLECTION_DISABLED", "当前网络未开启归集，请先在网络配置中启用归集"
            if "AVAILABLE_AMOUNT_BELOW_MIN_COLLECT" in reasons or int(skipped_stats.get("BELOW_MIN_COLLECT_AMOUNT") or 0) > 0:
                return "BELOW_MIN_COLLECT_AMOUNT", "未达最小归集金"
            if int(skipped_stats.get("UNVERIFIED") or 0) > 0:
                return "UNVERIFIED", "请先核实链上余额后再创建归集任务"
            if int(skipped_stats.get("ZERO_VERIFIED_BALANCE") or 0) > 0:
                return "ZERO_VERIFIED_BALANCE", "链上核实余额为 0，无法创建归集任务"
            if (
                "ACTIVE_COLLECTION_TASK_EXISTS" in reasons
                or int(result.get("skipped_duplicate_count") or 0) > 0
                or int(result.get("reused_existing_count") or 0) > 0
                or int(result.get("duplicate_active_count") or 0) > 0
                or int(skipped_stats.get("ACTIVE_COLLECTION_TASK_EXISTS") or 0) > 0
            ):
                return "ACTIVE_COLLECTION_TASK_EXISTS", "已有归集任务"
            if (
                int(result.get("created_gas_task_count") or 0) > 0
                or int(result.get("skipped_gas_required_count") or 0) > 0
                or int(skipped_stats.get("GAS_REQUIRED") or 0) > 0
            ):
                return "GAS_REQUIRED", "需先补 Gas"
            return "NO_ELIGIBLE_CANDIDATE", "未创建归集任"
        if int(result.get("gas_task_skipped_duplicate_count") or 0) > 0:
            return "ACTIVE_GAS_TASK_EXISTS", "已有补 Gas 任务"
        if int(result.get("gas_task_skipped_config_missing_count") or 0) > 0:
            return "GAS_CONFIG_INCOMPLETE", "补 Gas 配置不完整"
        return "NO_GAS_TASK_CREATED", "未创建补 Gas 任务"

    try:
        mode = "gas" if str(action_mode or "").lower() == "gas" else "collection"
        if mode == "collection":
            result = admin_create_collection_batch_from_verified_candidates(
                db,
                admin_user_id=(get_admin_from_request(request) or {}).get("id"),
                filters={**filters, "candidate_id": selected_candidate_id},
            )
        else:
            result = admin_create_collection_batch_from_candidates(
                db,
                admin_user_id=(get_admin_from_request(request) or {}).get("id"),
                filters=filters,
            )
        db.commit()
        enqueue_result = _enqueue_created_collection_jobs(db, result)
        created_count = int(result.get("created_gas_task_count") or 0) if mode == "gas" else int(result.get("created_task_count") or 0)
        create_detail = _build_collection_create_detail(result, enqueue_result)
        if created_count <= 0:
            reason, message = _not_created_reason(result, mode=mode)
            publish_collection_center_event(
                "gas_task_not_created" if mode == "gas" else "collection_task_not_created",
                {
                    "candidate_id": selected_candidate_id,
                    "chain_key": str(chain_key or "").strip().lower(),
                    "asset_symbol": str(coin_symbol or "").strip().upper(),
                    "coin_symbol": str(coin_symbol or "").strip().upper(),
                    "address": str(address or "").strip().lower(),
                    "user_id": str(user_id or "").strip(),
                    "status": "not_created",
                    "reason": reason,
                    "message": message,
                    "created_task_count": int(result.get("created_task_count") or 0),
                    "created_gas_task_count": int(result.get("created_gas_task_count") or 0),
                },
            )
            return _json_or_redirect(
                {
                    "ok": False,
                    "created_task_count": int(result.get("created_task_count") or 0),
                    "created_gas_task_count": int(result.get("created_gas_task_count") or 0),
                    "candidate_count": int(create_detail.get("candidate_count") or 0),
                    "reused_count": int(create_detail.get("reused_count") or 0),
                    "reused_existing_count": int(create_detail.get("reused_existing_count") or 0),
                    "duplicate_active_count": int(create_detail.get("duplicate_active_count") or 0),
                    "reason": reason,
                    "message": message,
                    "skipped_count": int(create_detail.get("skipped_count") or 0),
                    "enqueue_error_count": int(create_detail.get("enqueue_error_count") or 0),
                    "skipped_reasons": create_detail.get("skipped_reasons") or [],
                    "skipped_items": create_detail.get("skipped_items") or [],
                    "diagnostics": {
                        **dict(create_detail.get("diagnostics") or {}),
                    },
                    "technical_detail": create_detail.get("technical_detail") or {},
                },
                error=message,
            )
        notice = "补 Gas 已提交" if mode == "gas" else "归集已提交"
        if mode == "gas":
            publish_collection_center_event(
                "gas_task_submitted",
                {
                    "candidate_id": selected_candidate_id,
                    "chain_key": str(chain_key or "").strip().lower(),
                    "asset_symbol": str(coin_symbol or "").strip().upper(),
                    "coin_symbol": str(coin_symbol or "").strip().upper(),
                    "address": str(address or "").strip().lower(),
                    "user_id": str(user_id or "").strip(),
                    "status": "submitted",
                    "message": "补 Gas 已提交",
                    "created_gas_task_count": created_count,
                    "gas_job_ids": enqueue_result.get("gas_job_ids") or [],
                },
            )
            return _json_or_redirect(
                {
                    "ok": True,
                    "created_gas_task_count": created_count,
                    "candidate_count": int(create_detail.get("candidate_count") or 0),
                    "reused_count": int(create_detail.get("reused_count") or 0),
                    "reused_existing_count": int(create_detail.get("reused_existing_count") or 0),
                    "duplicate_active_count": int(create_detail.get("duplicate_active_count") or 0),
                    "gas_job_ids": enqueue_result.get("gas_job_ids") or [],
                    "skipped_count": int(create_detail.get("skipped_count") or 0),
                    "enqueue_error_count": int(create_detail.get("enqueue_error_count") or 0),
                    "skipped_reasons": create_detail.get("skipped_reasons") or [],
                    "skipped_items": create_detail.get("skipped_items") or [],
                    "diagnostics": {
                        **dict(create_detail.get("diagnostics") or {}),
                    },
                    "technical_detail": create_detail.get("technical_detail") or {},
                    "message": "补 Gas 已提交",
                },
                notice=notice,
            )
        else:
            publish_collection_center_event(
                "collection_task_submitted",
                {
                    "candidate_id": selected_candidate_id,
                    "chain_key": str(chain_key or "").strip().lower(),
                    "asset_symbol": str(coin_symbol or "").strip().upper(),
                    "coin_symbol": str(coin_symbol or "").strip().upper(),
                    "address": str(address or "").strip().lower(),
                    "user_id": str(user_id or "").strip(),
                    "status": "submitted",
                    "message": "归集已提",
                    "created_task_count": created_count,
                    "collection_job_ids": enqueue_result.get("collection_job_ids") or [],
                    "gas_job_ids": enqueue_result.get("gas_job_ids") or [],
                },
            )
            return _json_or_redirect(
                {
                    "ok": True,
                    "created_task_count": created_count,
                    "candidate_count": int(create_detail.get("candidate_count") or 0),
                    "reused_count": int(create_detail.get("reused_count") or 0),
                    "reused_existing_count": int(create_detail.get("reused_existing_count") or 0),
                    "duplicate_active_count": int(create_detail.get("duplicate_active_count") or 0),
                    "collection_job_ids": enqueue_result.get("collection_job_ids") or [],
                    "gas_job_ids": enqueue_result.get("gas_job_ids") or [],
                    "skipped_count": int(create_detail.get("skipped_count") or 0),
                    "enqueue_error_count": int(create_detail.get("enqueue_error_count") or 0),
                    "skipped_reasons": create_detail.get("skipped_reasons") or [],
                    "skipped_items": create_detail.get("skipped_items") or [],
                    "diagnostics": {
                        **dict(create_detail.get("diagnostics") or {}),
                    },
                    "message": "归集已提",
                    "technical_detail": create_detail.get("technical_detail") or {},
                },
                notice=notice,
            )
    except Exception:
        db.rollback()
        return _json_or_redirect(
            {
                "ok": False,
                "created_task_count": 0,
                "created_gas_task_count": 0,
                "reason": "CREATE_FAILED",
                "message": "归集任务创建失败，请稍后重试",
            },
            error="创建单地址任务失败，请稍后重试",
        )


def _render_collection_manual_page(
    request: Request,
    db: Session,
    *,
    chain_key: str = "",
    asset_symbol: str = "USDT",
    min_amount: str = "",
    preview: Optional[ScanResult] = None,
    notice: str = "",
    error: str = "",
):
    chains = _load_manual_collection_chains(db)
    selected_chain_key = str(chain_key or "").strip().lower()
    if selected_chain_key not in {item["chain_key"] for item in chains}:
        selected_chain_key = chains[0]["chain_key"] if chains else ""
    selected_chain = next((item for item in chains if item["chain_key"] == selected_chain_key), None)

    assets = _load_manual_collection_assets(db, selected_chain_key)
    asset_symbols = {item["symbol"] for item in assets}
    selected_asset_symbol = str(asset_symbol or "USDT").strip().upper()
    if selected_asset_symbol not in asset_symbols:
        selected_asset_symbol = "USDT" if "USDT" in asset_symbols else (assets[0]["symbol"] if assets else "")
    selected_asset = next((item for item in assets if item["symbol"] == selected_asset_symbol), None)

    default_min_amount = ""
    if selected_chain_key and selected_asset_symbol:
        try:
            default_min_amount = format(
                compute_min_collect_amount(chain_key=selected_chain_key, coin_symbol=selected_asset_symbol),
                "f",
            )
        except Exception:
            default_min_amount = ""
    form_min_amount = _decimal_form_value(min_amount) or default_min_amount

    tasks_result = list_collection_tasks(
        db,
        {
            "chain_key": selected_chain_key,
            "coin_symbol": selected_asset_symbol,
            "page": 1,
            "page_size": 20,
        },
    )
    preview_candidates = list(preview.candidates[:50]) if preview else []
    return render(
        request,
        "admin/collection_manual.html",
        ctx={
            "active_group": "funds",
            "active": "collection_manual",
            "notice": notice,
            "error": error,
            "chains": chains,
            "assets": assets,
            "selected_chain": selected_chain,
            "selected_asset": selected_asset,
            "filters": {
                "chain_key": selected_chain_key,
                "asset_symbol": selected_asset_symbol,
                "min_amount": form_min_amount,
                "default_min_amount": default_min_amount,
            },
            "preview": preview,
            "preview_summary": _manual_collection_summary(preview) if preview else None,
            "preview_candidates": preview_candidates,
            "items": _result_items(tasks_result),
            "collection_address_missing": not bool((selected_chain or {}).get("collection_address")),
            "pagination": {
                "page": _result_page(tasks_result),
                "page_size": _result_page_size(tasks_result),
                "total": _result_total(tasks_result),
                "pages": _result_pages(tasks_result),
            },
        },
    )


@router.get("/collection/manual", response_class=HTMLResponse)
def collection_manual_page(
    request: Request,
    chain_key: str = "",
    asset_symbol: str = "USDT",
    min_amount: str = "",
    notice: str = "",
    error: str = "",
    db: Session = Depends(get_db),
):
    redir = require_admin_permission(request, db, "collection_tasks.manage")
    if redir:
        return redir
    return _render_collection_manual_page(
        request,
        db,
        chain_key=chain_key,
        asset_symbol=asset_symbol,
        min_amount=min_amount,
        notice=_clean_query_text(notice),
        error=_clean_query_text(error),
    )


@router.post("/collection/manual/dry-run", response_class=HTMLResponse)
def collection_manual_dry_run(
    request: Request,
    chain_key: str = Form(""),
    asset_symbol: str = Form("USDT"),
    min_amount: str = Form(""),
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "collection_tasks.manage")
    if redir:
        return redir
    try:
        amount = _manual_collection_min_amount(chain_key, asset_symbol, min_amount)
        preview = admin_preview_collection_candidates(
            db,
            chain_key=str(chain_key or "").strip().lower(),
            asset_symbol=str(asset_symbol or "USDT").strip().upper(),
            min_amount=amount,
        )
        db.rollback()
        notice = f"Dry Run 完成：候选 {preview.collectible_count} 个，需要补 Gas {preview.gas_required_count} 个"
        error = ""
    except Exception as exc:
        db.rollback()
        preview = None
        notice = ""
        error = f"Dry Run 失败：{exc}"
    return _render_collection_manual_page(
        request,
        db,
        chain_key=chain_key,
        asset_symbol=asset_symbol,
        min_amount=min_amount,
        preview=preview,
        notice=notice,
        error=error,
    )


@router.post("/collection/manual/create", response_class=HTMLResponse)
def collection_manual_create(
    request: Request,
    chain_key: str = Form(""),
    asset_symbol: str = Form("USDT"),
    min_amount: str = Form(""),
    confirm_text: str = Form(""),
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "collection_tasks.manage")
    if redir:
        return redir
    ck = str(chain_key or "").strip().lower()
    symbol = str(asset_symbol or "USDT").strip().upper()
    try:
        if str(confirm_text or "").strip().upper() != "COLLECT":
            raise ValueError("请输入 COLLECT 确认创建归集任务")
        selected_chain = next((item for item in _load_manual_collection_chains(db) if item["chain_key"] == ck), None)
        if not selected_chain:
            raise ValueError("当前网络不可用于手动归集")
        if not selected_chain.get("collection_address"):
            raise ValueError("当前网络未配置归集地址，禁止创建归集任")
        amount = _manual_collection_min_amount(ck, symbol, min_amount)
        result = admin_create_collection_tasks(
            db,
            chain_key=ck,
            asset_symbol=symbol,
            min_amount=amount,
            operator_id=(get_admin_from_request(request) or {}).get("id"),
        )
        db.commit()
        notice = (
            f"已创建归集任务 {result.created_task_count} 个；"
            f"其中 {result.gas_required_count} 个候选提示需要补 Gas"
            "创建任务不代表已链上发送，实际发送由 collection RQ worker 执行"
        )
        error = ""
    except Exception as exc:
        db.rollback()
        result = None
        notice = ""
        error = f"创建归集任务失败：{exc}"
    return _render_collection_manual_page(
        request,
        db,
        chain_key=ck,
        asset_symbol=symbol,
        min_amount=min_amount,
        preview=result,
        notice=notice,
        error=error,
    )


@router.post("/collections/tasks/{task_id}/dry-run")
def collection_task_dry_run(
    request: Request,
    task_id: int,
    next_path: str = Form("/admin/collections/tasks"),
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "collection_tasks.manage")
    if redir:
        return redir

    try:
        result = process_collection_task(int(task_id), allow_real_send=False)
        if result.get("ok"):
            status_label = {
                "PENDING": "待处",
                "QUEUED": "排队",
                "PROCESSING": "处理",
                "SENT": "已发",
                "CONFIRMED": "已确",
                "SUCCESS": "成功",
                "FAILED": "失败",
                "CANCELED": "已取",
                "CANCELLED": "已取",
            }.get(str(result.get("status") or "").upper(), result.get("status") or "-")
            notice = f"归集任务 {task_id} 模拟执行完成，状态：{status_label}，链上交易哈希：{result.get('tx_hash') or '-'}"
            error = ""
        else:
            notice = ""
            error = f"归集任务 {task_id} 模拟执行失败：{result.get('error') or result.get('reason') or result}"
    except Exception as exc:
        notice = ""
        error = f"归集任务 {task_id} 模拟执行异常：{exc}"

    return RedirectResponse(
        url=_build_collection_tasks_redirect_url(next_path=next_path, notice=notice, error=error),
        status_code=302,
    )


@router.post("/collections/tasks/{task_id}/real-send")
def collection_task_real_send(
    request: Request,
    task_id: int,
    next_path: str = Form("/admin/collections/tasks"),
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "collection_tasks.manage")
    if redir:
        return redir

    return _enqueue_collection_task_send_redirect_by_id(
        db=db,
        task_id=int(task_id),
        next_path=next_path,
        action_label="发",
    )

@router.get("/collections/gas-tasks", response_class=HTMLResponse)
def gas_tasks_page(
    request: Request,
    task_no: str = "",
    collection_task_id: str = "",
    user_id: str = "",
    chain_key: str = "",
    coin_symbol: str = "",
    status: str = "",
    address: str = "",
    tx_hash: str = "",
    notice: str = "",
    error: str = "",
    created_from: str = "",
    created_to: str = "",
    page: int = 1,
    page_size: int = 20,
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return redir

    created_from_text = str(created_from or "").strip()
    created_to_text = str(created_to or "").strip()
    created_from_value, created_to_value, created_from_text, created_to_text = _collection_task_date_range(
        created_from_text, created_to_text
    )
    range_notice = _collection_task_range_notice(
        created_from_value, created_to_value, task_no, collection_task_id, user_id, address, tx_hash
    )

    result = list_gas_tasks(
        db,
        {
            "task_no": task_no,
            "collection_task_id": collection_task_id,
            "user_id": user_id,
            "chain_key": chain_key,
            "coin_symbol": coin_symbol,
            "status": status,
            "address": address,
            "tx_hash": tx_hash,
            "created_from": created_from_value,
            "created_to": created_to_value,
            "page": page,
            "page_size": page_size,
        },
    )
    return render(
        request,
        "admin/gas_tasks.html",
        ctx={
            "items": _result_items(result),
            "active_group": "system",
            "active": "gas_tasks",
            "notice": notice,
            "error": error,
            "real_send_enabled": is_collection_real_send_enabled(),
            "summary": result.get("summary") or {},
            "range_notice": range_notice,
            "filters": {
                **_result_filters(result),
                "created_from": created_from_text,
                "created_to": created_to_text,
            },
            "pagination": {
                "page": _result_page(result),
                "page_size": _result_page_size(result),
                "total": _result_total(result),
                "pages": _result_pages(result),
            },
        },
    )


@router.get("/collections/gas-costs", response_class=HTMLResponse)
def collection_gas_costs_page(
    request: Request,
    notice: str = "",
    error: str = "",
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return redir

    result = admin_query_collection_gas_cost_stats(db)
    return render(
        request,
        "admin/collection_gas_costs.html",
        ctx={
            "items": result.get("items") or [],
            "default_params": result.get("default_params") or [],
            "gas_config_params": result.get("gas_config_params") or [],
            "summary": result.get("summary") or {},
            "failed_counts": result.get("failed_counts") or {},
            "table_missing": bool(result.get("table_missing")),
            "active_group": "funds",
            "active": "collection_gas_costs",
            "notice": notice,
            "error": error,
        },
    )


@router.post("/collections/gas-config/update")
def collection_gas_config_update(
    request: Request,
    chain_key: str = Form(...),
    gas_topup_mode: str = Form("DEFAULT"),
    safe_multiplier: str = Form("3"),
    buffer: str = Form("0"),
    cap: str = Form("0"),
    min_topup: str = Form("0"),
    max_topup: str = Form("0"),
    reset_default: str = Form("0"),
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "gas_tasks.manage")
    if redir:
        return redir

    try:
        if str(reset_default or "") == "1":
            reset_gas_topup_config(db, chain_key=chain_key)
            notice = f"{chain_key} 已恢复默认补 Gas 参数"
        else:
            save_gas_topup_config(
                db,
                chain_key=chain_key,
                gas_topup_mode=gas_topup_mode,
                safe_multiplier=safe_multiplier,
                buffer=buffer,
                cap=cap,
                min_topup=min_topup,
                max_topup=max_topup,
            )
            notice = f"{chain_key} 补 Gas 参数已保存"
        db.commit()
        return RedirectResponse(url=f"/admin/collections/gas-costs?notice={quote(notice)}", status_code=303)
    except CollectionGasConfigError as exc:
        db.rollback()
        return RedirectResponse(url=f"/admin/collections/gas-costs?error={quote(str(exc))}", status_code=303)
    except Exception as exc:
        db.rollback()
        logger.exception("collection gas config update failed chain_key=%s", chain_key)
        return RedirectResponse(url=f"/admin/collections/gas-costs?error={quote(str(exc)[:160])}", status_code=303)


@router.post("/collections/gas-tasks/{task_id}/dry-run")
def gas_task_dry_run(
    request: Request,
    task_id: int,
    next_path: str = Form("/admin/collections/gas-tasks"),
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "gas_tasks.manage")
    if redir:
        return redir

    try:
        result = process_gas_task(int(task_id), allow_real_send=False)
        if result.get("ok"):
            status_label = {
                "PENDING": "待处",
                "PROCESSING": "处理",
                "SENT": "已发",
                "SUCCESS": "成功",
                "FAILED": "失败",
                "CANCELED": "已取",
                "CANCELLED": "已取",
            }.get(str(result.get("status") or "").upper(), result.get("status") or "-")
            notice = f"补 Gas 任务 {task_id} 模拟执行完成，状态：{status_label}，链上交易哈希：{result.get('tx_hash') or '-'}"
            error = ""
        else:
            notice = ""
            error = f"补 Gas 任务 {task_id} 模拟执行失败：{result.get('error') or result.get('reason') or result}"
    except Exception as exc:
        notice = ""
        error = f"补 Gas 任务 {task_id} 模拟执行异常：{exc}"

    return RedirectResponse(
        url=_build_gas_tasks_redirect_url(next_path=next_path, notice=notice, error=error),
        status_code=302,
    )


@router.post("/collections/gas-tasks/{task_id}/real-send")
def gas_task_real_send(
    request: Request,
    task_id: int,
    next_path: str = Form("/admin/collections/gas-tasks"),
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "gas_tasks.manage")
    if redir:
        return redir

    if not is_collection_real_send_enabled():
        return RedirectResponse(
            url=_build_gas_tasks_redirect_url(
                next_path=next_path,
                error="真实发送基础设施总闸未开",
            ),
            status_code=302,
        )

    task = db.query(GasTask).filter(GasTask.id == int(task_id)).first()
    if not task:
        return RedirectResponse(
            url=_build_gas_tasks_redirect_url(next_path=next_path, error=f"补 Gas 任务 {task_id} 不存在"),
            status_code=302,
        )
    gas_status = str(task.status or "").upper()
    gas_tx_hash = str(task.tx_hash or "").strip()
    can_real_send_from_status = gas_status in {
        GasTaskStatus.PENDING.value,
        GasTaskStatus.QUEUED.value,
        GasTaskStatus.FAILED.value,
    }
    can_real_send_from_dry_run_history = bool(
        gas_status in {GasTaskStatus.CONFIRMED.value, "SUCCESS", "COMPLETED"}
        and gas_tx_hash
        and _admin_is_dry_run_tx_hash(gas_tx_hash)
    )
    if not (can_real_send_from_status or can_real_send_from_dry_run_history):
        return RedirectResponse(
            url=_build_gas_tasks_redirect_url(
                next_path=next_path,
                error=f"补 Gas 任务 {task_id} 当前状态不允许真实发送：{task.status}",
            ),
            status_code=302,
        )

    try:
        if can_real_send_from_dry_run_history:
            task.status = GasTaskStatus.PENDING.value
            task.tx_hash = None
            task.block_number = None
            task.sent_at = None
            task.confirmed_at = None
            task.locked_at = None
            task.next_retry_at = None
            task.last_error = None
            task.updated_at = datetime.utcnow()
            db.commit()
        result = process_gas_task(int(task_id), allow_real_send=True)
        if result.get("ok") and result.get("status") == GasTaskStatus.SENT.value:
            notice = f"补 Gas 任务 {task_id} 已发送，状态：已发送，链上交易哈希：{result.get('tx_hash') or '-'}"
            error = ""
        else:
            notice = ""
            error = f"补 Gas 任务 {task_id} 真实发送未完成：{result.get('error') or result.get('reason') or result}"
    except Exception as exc:
        notice = ""
        error = f"补 Gas 任务 {task_id} 真实发送异常：{exc}"

    return RedirectResponse(
        url=_build_gas_tasks_redirect_url(next_path=next_path, notice=notice, error=error),
        status_code=302,
    )


@router.post("/collections/gas-tasks/{task_id}/confirm-requeue")
def gas_task_confirm_requeue(
    request: Request,
    task_id: int,
    next_path: str = Form("/admin/collections/gas-tasks"),
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "gas_tasks.manage")
    if redir:
        return redir

    task = db.query(GasTask).filter(GasTask.id == int(task_id)).first()
    if not task:
        return RedirectResponse(
            url=_build_gas_tasks_redirect_url(next_path=next_path, error=f"补 Gas 任务 {task_id} 不存在"),
            status_code=302,
        )

    gas_status = str(task.status or "").upper()
    gas_tx_hash = str(task.tx_hash or "").strip()
    if gas_status not in {GasTaskStatus.SENT.value, GasTaskStatus.CONFIRMING.value, "GAS_SENT"}:
        return RedirectResponse(
            url=_build_gas_tasks_redirect_url(next_path=next_path, error=f"补 Gas 任务 {task_id} 当前状态不允许重投确认：{task.status}"),
            status_code=302,
        )
    if not gas_tx_hash or _admin_is_dry_run_tx_hash(gas_tx_hash):
        return RedirectResponse(
            url=_build_gas_tasks_redirect_url(next_path=next_path, error=f"补 Gas 任务 {task_id} 没有真实链上交易哈希，不能重投确认"),
            status_code=302,
        )
    if task.confirmed_at:
        return RedirectResponse(
            url=_build_gas_tasks_redirect_url(next_path=next_path, error=f"补 Gas 任务 {task_id} 已确认，无需重投确认"),
            status_code=302,
        )

    try:
        job_id = enqueue_tx_confirm_gas_task(int(task_id))
        notice = f"补 Gas 任务 {task_id} 已重投链上确认，确认任务：{job_id}"
        error = ""
    except Exception as exc:
        notice = ""
        error = f"补 Gas 任务 {task_id} 重投确认失败：{str(exc)[:180]}"

    return RedirectResponse(
        url=_build_gas_tasks_redirect_url(next_path=next_path, notice=notice, error=error),
        status_code=302,
    )


@router.post("/withdraw-reviews/{withdraw_id}/approve")
def withdraw_review_approve(
    request: Request,
    withdraw_id: int,
    next_path: str = Form("/admin/withdraw-reviews"),
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "withdraw_reviews.manage")
    if redir:
        return redir

    try:
        admin_review_withdraw(db, withdraw_id, "APPROVE")
        db.commit()
        notice = "approved"
        error = ""
    except WithdrawReviewError as exc:
        db.rollback()
        notice = ""
        error = str(exc)
    except Exception as exc:
        db.rollback()
        notice = ""
        error = f"Withdraw approve failed: {exc}"

    return RedirectResponse(
        url=_build_withdraw_review_redirect_url(
            next_path="/admin/withdraw-reviews?status=REVIEWING" if notice else next_path,
            notice=notice,
            error=error,
        ),
        status_code=302,
    )


@router.post("/withdraw-reviews/{withdraw_id}/reject")
def withdraw_review_reject(
    request: Request,
    withdraw_id: int,
    next_path: str = Form("/admin/withdraw-reviews"),
    risk_reason: str = Form(""),
    reason: str = Form(""),
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "withdraw_reviews.manage")
    if redir:
        return redir

    try:
        final_reason = (risk_reason or reason or "").strip()
        admin_review_withdraw(db, withdraw_id, "REJECT", risk_reason=final_reason)
        db.commit()
        notice = "rejected"
        error = ""
    except WithdrawReviewError as exc:
        db.rollback()
        notice = ""
        error = str(exc)
    except Exception as exc:
        db.rollback()
        notice = ""
        error = f"Withdraw reject failed: {exc}"

    return RedirectResponse(
        url=_build_withdraw_review_redirect_url(
            next_path="/admin/withdraw-reviews?status=REVIEWING" if notice else next_path,
            notice=notice,
            error=error,
        ),
        status_code=302,
    )


@router.get("/asset-configs", response_class=HTMLResponse)
def asset_configs_page(
    request: Request,
    notice: str = "",
    success: str = "",
    warning: str = "",
    info: str = "",
    error: str = "",
    sort_by: str = "id",
    sort_dir: str = "asc",
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return redir

    configs = admin_query_asset_configs(db, asset_sort_by=sort_by, asset_sort_dir=sort_dir)
    asset_sort = configs.get("asset_sort") or {"sort_by": "id", "sort_dir": "asc"}
    asset_keyword = (
        request.query_params.get("keyword")
        or request.query_params.get("search")
        or request.query_params.get("q")
        or ""
    )

    def asset_sort_link(column: str) -> str:
        current_sort_by = str(asset_sort.get("sort_by") or "id")
        current_sort_dir = str(asset_sort.get("sort_dir") or "asc")
        next_sort_dir = "desc" if current_sort_by == column and current_sort_dir == "asc" else "asc"
        params = [
            (key, value)
            for key, value in request.query_params.multi_items()
            if key not in {"notice", "success", "warning", "info", "error", "tab", "sort_by", "sort_dir", "page"}
        ]
        params.append(("tab", "assets"))
        params.append(("page", "1"))
        params.append(("sort_by", column))
        params.append(("sort_dir", next_sort_dir))
        return urlunsplit(("", "", request.url.path, urlencode(params, doseq=True), ""))

    asset_sort_links = {
        "id": asset_sort_link("id"),
        "sort_order": asset_sort_link("sort_order"),
        "deposit_sort_order": asset_sort_link("deposit_sort_order"),
        "withdraw_sort_order": asset_sort_link("withdraw_sort_order"),
    }
    return render(
        request,
        "admin/asset_configs.html",
        ctx={
            "assets": configs["assets"],
            "chains": configs["chains"],
            "asset_chains": configs["asset_chains"],
            "notice": success or notice,
            "warning": warning,
            "info": info,
            "error": error,
            "active_group": "funds",
            "active": "asset_configs",
            "asset_sort": asset_sort,
            "asset_sort_links": asset_sort_links,
            "asset_keyword": asset_keyword,
            "filters": {},
            "pagination": _default_pagination(),
        },
    )


@router.get("/chain-health", response_class=HTMLResponse)
def chain_health_page(
    request: Request,
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "contract_symbols.manage")
    if redir:
        return redir

    result = get_admin_chain_health(db) or {}
    items = result.get("items") or []
    summary = result.get("summary") or {}
    return render(
        request,
        "admin/chain_health.html",
        ctx={
            "items": items,
            "summary": summary,
            "active_group": "funds",
            "active": "chain_health",
            "filters": {},
            "pagination": _default_pagination(),
        },
    )


def _build_hot_wallet_monitor_redirect_url(
    *,
    chain_key: str = "",
    symbol: str = "",
    status: str = "",
    notice: str = "",
    error: str = "",
) -> str:
    params = []
    if chain_key:
        params.append(("chain_key", chain_key))
    if symbol:
        params.append(("symbol", symbol))
    if status:
        params.append(("status", status))
    if notice:
        params.append(("notice", notice))
    if error:
        params.append(("error", error))
    query = urlencode(params)
    return f"/admin/hot-wallets?{query}" if query else "/admin/hot-wallets"


@router.get("/hot-wallets", response_class=HTMLResponse)
def hot_wallets_page(
    request: Request,
    chain_key: str = "",
    symbol: str = "",
    status: str = "",
    notice: str = "",
    error: str = "",
    db: Session = Depends(get_db),
):
    redir = require_admin_permission(request, db, "collection_tasks.manage")
    if redir:
        return redir

    result = query_hot_wallet_monitor(
        db,
        {
            "chain_key": chain_key,
            "symbol": symbol,
            "status": status,
        },
    )
    return render(
        request,
        "admin/hot_wallets.html",
        ctx={
            "items": result.get("items") or [],
            "summary": result.get("summary") or {},
            "filters": result.get("filters") or {},
            "chain_options": result.get("chain_options") or [],
            "symbol_options": result.get("symbol_options") or [],
            "cache_seconds": result.get("cache_seconds") or 60,
            "notice": notice,
            "error": error,
            "active_group": "funds",
            "active": "hot_wallets",
            "pagination": _default_pagination(),
        },
    )


@router.post("/hot-wallets/refresh")
def hot_wallets_refresh(
    request: Request,
    asset_chain_id: str = Form(""),
    asset_id: str = Form(""),
    chain_key: str = Form(""),
    symbol: str = Form(""),
    status: str = Form(""),
    filter_chain_key: str = Form(""),
    filter_symbol: str = Form(""),
    filter_status: str = Form(""),
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "collection_tasks.manage")
    if redir:
        return redir

    result = refresh_hot_wallet_monitor_item(
        db,
        chain_key=chain_key or filter_chain_key,
        asset_chain_id=asset_chain_id,
        asset_id=asset_id,
    )
    item = result.get("item") or {}
    wants_json = (
        request.headers.get("x-requested-with", "").lower() == "xmlhttprequest"
        or "application/json" in request.headers.get("accept", "").lower()
    )
    if wants_json:
        payload = {
            "ok": bool(result.get("ok")),
            "error": str(result.get("error") or ""),
            "item": hot_wallet_monitor_item_payload(item) if item else None,
        }
        return JSONResponse(payload)

    if result.get("ok"):
        notice = f"{item.get('chain_key', chain_key)} / {item.get('symbol', symbol)} 热钱包余额已刷新"
        error_text = ""
    else:
        notice = ""
        error_text = str(result.get("error") or "热钱包余额刷新失")
    return RedirectResponse(
        url=_build_hot_wallet_monitor_redirect_url(
            chain_key=filter_chain_key,
            symbol=filter_symbol,
            status=filter_status,
            notice=notice,
            error=error_text,
        ),
        status_code=303,
    )


@router.post("/asset-configs/assets/create")
def asset_config_asset_create(
    request: Request,
    symbol: str = Form(""),
    name: str = Form(""),
    display_precision: str = Form(""),
    icon_url: str = Form(""),
    sort_order: str = Form(""),
    deposit_sort_order: str = Form("100"),
    deposit_quick_enabled: str = Form("true"),
    deposit_default_enabled: str = Form("false"),
    withdraw_sort_order: str = Form("100"),
    withdraw_quick_enabled: str = Form("true"),
    withdraw_default_enabled: str = Form("false"),
    enabled: str = Form("0"),
    next_path: str = Form("/admin/asset-configs?tab=asset_chains"),
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "asset_configs.manage")
    if redir:
        return redir

    result = admin_create_asset_config(
        db,
        {
            "symbol": symbol,
            "name": name,
            "display_precision": display_precision,
            "icon_url": icon_url,
            "sort_order": sort_order,
            "deposit_sort_order": deposit_sort_order,
            "deposit_quick_enabled": deposit_quick_enabled,
            "deposit_default_enabled": deposit_default_enabled,
            "withdraw_sort_order": withdraw_sort_order,
            "withdraw_quick_enabled": withdraw_quick_enabled,
            "withdraw_default_enabled": withdraw_default_enabled,
            "enabled": enabled,
        },
    )
    return RedirectResponse(
        url=_build_asset_configs_redirect_url(
            notice=f"币种 {symbol.strip().upper()} 创建成功" if result["ok"] else "",
            error="; ".join(result.get("errors", [])) if not result["ok"] else "",
            next_path=next_path,
        ),
        status_code=302,
    )


@router.post("/asset-configs/assets/{asset_id}/update")
def asset_config_asset_update(
    request: Request,
    asset_id: int,
    name: str = Form(""),
    display_precision: str = Form(""),
    icon_url: str = Form(""),
    sort_order: str = Form(""),
    deposit_sort_order: str = Form("100"),
    deposit_quick_enabled: str = Form("true"),
    deposit_default_enabled: str = Form("false"),
    withdraw_sort_order: str = Form("100"),
    withdraw_quick_enabled: str = Form("true"),
    withdraw_default_enabled: str = Form("false"),
    enabled: str = Form("0"),
    next_path: str = Form("/admin/asset-configs?tab=assets"),
    return_url: str = Form(""),
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "asset_configs.manage")
    if redir:
        return redir

    redirect_path = return_url or next_path or "/admin/asset-configs?tab=assets"
    if not str(redirect_path).startswith("/admin/asset-configs"):
        redirect_path = "/admin/asset-configs?tab=assets"
    try:
        result = admin_update_asset_config(
            db,
            asset_id,
            {
                "name": name,
                "display_precision": display_precision,
                "icon_url": icon_url,
                "sort_order": sort_order,
                "deposit_sort_order": deposit_sort_order,
                "deposit_quick_enabled": deposit_quick_enabled,
                "deposit_default_enabled": deposit_default_enabled,
                "withdraw_sort_order": withdraw_sort_order,
                "withdraw_quick_enabled": withdraw_quick_enabled,
                "withdraw_default_enabled": withdraw_default_enabled,
                "enabled": enabled,
            },
        )
    except Exception as exc:
        db.rollback()
        result = {"ok": False, "errors": [f"币种保存失败，请检查资产配置字段或数据库状态（{type(exc).__name__}"]}
    return RedirectResponse(
        url=_build_asset_configs_redirect_url(
            notice=f"币种配置 {asset_id} 保存成功" if result["ok"] else "",
            error="; ".join(result.get("errors", [])) if not result["ok"] else "",
            next_path=redirect_path,
        ),
        status_code=302,
    )


@router.post("/asset-configs/assets/{asset_id}/delete")
def asset_config_asset_delete(
    request: Request,
    asset_id: int,
    next_path: str = Form("/admin/asset-configs?tab=asset_chains"),
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "asset_configs.manage")
    if redir:
        return redir

    result = admin_delete_asset_config(db, asset_id)
    return RedirectResponse(
        url=_build_asset_configs_redirect_url(
            notice=f"币种配置 {asset_id} 已删" if result["ok"] else "",
            error="; ".join(result.get("errors", [])) if not result["ok"] else "",
            next_path=next_path,
        ),
        status_code=302,
    )


@router.post("/asset-configs/chains/create")
def asset_config_chain_create(
    request: Request,
    chain_key: str = Form(""),
    name: str = Form(""),
    icon_url: str = Form(""),
    chain_id: str = Form(""),
    native_symbol: str = Form(""),
    confirmations: str = Form(""),
    explorer_tx_url: str = Form(""),
    rpc_url: str = Form(""),
    moralis_stream_id: str = Form(""),
    moralis_stream_enabled: str = Form("0"),
    moralis_chain_id: str = Form(""),
    webhook_chain_key: str = Form(""),
    watch_enabled: str = Form("0"),
    collection_address: str = Form(""),
    hot_wallet_address: str = Form(""),
    hot_wallet_private_key: str = Form(""),
    confirm_collection_address: str = Form(""),
    collection_enabled: str = Form("1"),
    collection_real_send_enabled: str = Form("0"),
    collection_max_single_gas_native: str = Form(""),
    collection_daily_gas_native_limit: str = Form(""),
    withdraw_fee: str = Form(""),
    withdraw_fee_auto_enabled: str = Form("0"),
    withdraw_fee_min: str = Form(""),
    withdraw_fee_max: str = Form(""),
    withdraw_fee_multiplier: str = Form(""),
    withdraw_fee_update_threshold: str = Form(""),
    withdraw_fee_maintenance_interval_sec: str = Form(""),
    enabled: str = Form("0"),
    next_path: str = Form("/admin/asset-configs"),
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "asset_configs.manage")
    if redir:
        return redir

    result = admin_create_chain_config(
        db,
        {
            "chain_key": chain_key,
            "name": name,
            "icon_url": icon_url,
            "chain_id": chain_id,
            "native_symbol": native_symbol,
            "confirmations": confirmations,
            "explorer_tx_url": explorer_tx_url,
            "rpc_url": rpc_url,
            "moralis_stream_id": moralis_stream_id,
            "moralis_stream_enabled": moralis_stream_enabled,
            "moralis_chain_id": moralis_chain_id,
            "webhook_chain_key": webhook_chain_key,
            "watch_enabled": watch_enabled,
            "collection_address": collection_address,
            "hot_wallet_address": hot_wallet_address,
            "hot_wallet_private_key": hot_wallet_private_key,
            "confirm_collection_address": confirm_collection_address,
            "collection_enabled": collection_enabled,
            "collection_real_send_enabled": collection_real_send_enabled,
            "collection_max_single_gas_native": collection_max_single_gas_native,
            "collection_daily_gas_native_limit": collection_daily_gas_native_limit,
            "withdraw_fee": withdraw_fee,
            "withdraw_fee_auto_enabled": withdraw_fee_auto_enabled,
            "withdraw_fee_min": withdraw_fee_min,
            "withdraw_fee_max": withdraw_fee_max,
            "withdraw_fee_multiplier": withdraw_fee_multiplier,
            "withdraw_fee_update_threshold": withdraw_fee_update_threshold,
            "withdraw_fee_maintenance_interval_sec": withdraw_fee_maintenance_interval_sec,
            "enabled": enabled,
        },
    )
    notice = "保存成功" if result["ok"] else ""
    warning = _chain_same_wallet_warning(collection_address, hot_wallet_address) if result["ok"] else ""
    info = ""
    if result["ok"]:
        info = _refresh_chain_withdraw_fee_notice(db, chain_key, withdraw_fee_auto_enabled)
    return RedirectResponse(
        url=_build_asset_configs_redirect_url(
            notice=notice,
            warning=warning,
            info=info,
            error="; ".join(result.get("errors", [])) if not result["ok"] else "",
            next_path=next_path,
        ),
        status_code=302,
    )


@router.get("/asset-configs/chains/{chain_key}/preflight")
def asset_config_chain_preflight(
    request: Request,
    chain_key: str,
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return JSONResponse(
            {
                "ok": False,
                "chain_key": str(chain_key or "").strip().lower(),
                "summary_status": "FAIL",
                "checks": [
                    {
                        "key": "auth",
                        "label": "管理员登",
                        "status": "FAIL",
                        "message": "admin login required",
                    }
                ],
            },
            status_code=401,
        )
    try:
        result = run_chain_preflight(db, chain_key)
        result["ok"] = True
        return JSONResponse(result)
    except Exception as exc:
        return JSONResponse(
            {
                "ok": False,
                "chain_key": str(chain_key or "").strip().lower(),
                "summary_status": "FAIL",
                "checks": [
                    {
                        "key": "preflight",
                        "label": "预检执行",
                        "status": "FAIL",
                        "message": str(exc),
                    }
                ],
            }
        )


@router.post("/asset-configs/chains/{chain_key}/watch-test")
def asset_config_chain_watch_test(
    request: Request,
    chain_key: str,
    test_address: str = Form(""),
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "asset_configs.manage")
    if redir:
        return JSONResponse(
            {
                "ok": False,
                "chain_key": str(chain_key or "").strip().lower(),
                "message": "admin permission required",
            },
            status_code=403,
        )

    ck = str(chain_key or "").strip().lower()
    addr = str(test_address or "").strip()
    if not addr:
        return JSONResponse({"ok": False, "chain_key": ck, "message": "请输入用户充值地址"}, status_code=400)

    row = db.execute(
        text("SELECT id FROM chains WHERE LOWER(chain_key)=:chain_key LIMIT 1"),
        {"chain_key": ck},
    ).mappings().first()
    chain_db_id = int(row["id"]) if row else None
    ok = add_address_to_streams(
        network_code=ck.upper(),
        address=addr,
        db=db,
        chain_key=ck,
        chain_id=chain_db_id,
    )
    return JSONResponse(
        {
            "ok": bool(ok),
            "chain_key": ck,
            "message": "监听正常，用户充值地址已加入监听或已存在" if ok else "地址未加入监听，请检查 Stream ID、Moralis API Key 或网络标识配置",
        }
    )


@router.post("/asset-configs/chains/{chain_id}/update")
def asset_config_chain_update(
    request: Request,
    chain_id: int,
    name: str = Form(""),
    icon_url: str = Form(""),
    chain_id_value: str = Form("", alias="chain_id"),
    native_symbol: str = Form(""),
    confirmations: str = Form(""),
    explorer_tx_url: str = Form(""),
    rpc_url: str = Form(""),
    moralis_stream_id: str = Form(""),
    moralis_stream_enabled: str = Form("0"),
    moralis_chain_id: str = Form(""),
    webhook_chain_key: str = Form(""),
    watch_enabled: str = Form("0"),
    collection_address: str = Form(""),
    hot_wallet_address: str = Form(""),
    hot_wallet_private_key: str = Form(""),
    confirm_collection_address: str = Form(""),
    collection_enabled: str = Form("1"),
    collection_real_send_enabled: str = Form("0"),
    collection_max_single_gas_native: str = Form(""),
    collection_daily_gas_native_limit: str = Form(""),
    withdraw_fee: str = Form(""),
    withdraw_fee_auto_enabled: str = Form("0"),
    withdraw_fee_min: str = Form(""),
    withdraw_fee_max: str = Form(""),
    withdraw_fee_multiplier: str = Form(""),
    withdraw_fee_update_threshold: str = Form(""),
    withdraw_fee_maintenance_interval_sec: str = Form(""),
    enabled: str = Form("0"),
    next_path: str = Form("/admin/asset-configs"),
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "asset_configs.manage")
    if redir:
        return redir

    result = admin_update_chain_config(
        db,
        chain_id,
        {
            "name": name,
            "icon_url": icon_url,
            "chain_id": chain_id_value,
            "native_symbol": native_symbol,
            "confirmations": confirmations,
            "explorer_tx_url": explorer_tx_url,
            "rpc_url": rpc_url,
            "moralis_stream_id": moralis_stream_id,
            "moralis_stream_enabled": moralis_stream_enabled,
            "moralis_chain_id": moralis_chain_id,
            "webhook_chain_key": webhook_chain_key,
            "watch_enabled": watch_enabled,
            "collection_address": collection_address,
            "hot_wallet_address": hot_wallet_address,
            "hot_wallet_private_key": hot_wallet_private_key,
            "confirm_collection_address": confirm_collection_address,
            "collection_enabled": collection_enabled,
            "collection_real_send_enabled": collection_real_send_enabled,
            "collection_max_single_gas_native": collection_max_single_gas_native,
            "collection_daily_gas_native_limit": collection_daily_gas_native_limit,
            "withdraw_fee": withdraw_fee,
            "withdraw_fee_auto_enabled": withdraw_fee_auto_enabled,
            "withdraw_fee_min": withdraw_fee_min,
            "withdraw_fee_max": withdraw_fee_max,
            "withdraw_fee_multiplier": withdraw_fee_multiplier,
            "withdraw_fee_update_threshold": withdraw_fee_update_threshold,
            "withdraw_fee_maintenance_interval_sec": withdraw_fee_maintenance_interval_sec,
            "enabled": enabled,
        },
    )
    chain_key_for_notice = ""
    try:
        row = db.execute(
            text("SELECT chain_key FROM chains WHERE id = :chain_id LIMIT 1"),
            {"chain_id": chain_id},
        ).mappings().first()
        chain_key_for_notice = str((row or {}).get("chain_key") or "")
    except Exception:
        chain_key_for_notice = ""
    notice = "保存成功" if result["ok"] else ""
    warning = _chain_same_wallet_warning(collection_address, hot_wallet_address) if result["ok"] else ""
    info = ""
    if result["ok"]:
        info = _refresh_chain_withdraw_fee_notice(db, chain_key_for_notice, withdraw_fee_auto_enabled)
    return RedirectResponse(
        url=_build_asset_configs_redirect_url(
            notice=notice,
            warning=warning,
            info=info,
            error="; ".join(result.get("errors", [])) if not result["ok"] else "",
            next_path=next_path,
        ),
        status_code=302,
    )


@router.post("/asset-configs/chains/{chain_id}/withdraw-fee/sync")
def asset_config_chain_withdraw_fee_sync(
    request: Request,
    chain_id: int,
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "asset_configs.manage")
    if redir:
        return JSONResponse({"ok": False, "error": "无权限操"}, status_code=403)

    result = admin_sync_chain_withdraw_fee(db, chain_id)
    return JSONResponse(result, status_code=200 if result.get("ok") else 400)


@router.post("/asset-configs/chains/{chain_id}/delete")
def asset_config_chain_delete(
    request: Request,
    chain_id: int,
    next_path: str = Form("/admin/asset-configs"),
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "asset_configs.manage")
    if redir:
        return redir

    result = admin_delete_chain_config(db, chain_id)
    return RedirectResponse(
        url=_build_asset_configs_redirect_url(
            notice=f"网络配置 {chain_id} 已删" if result["ok"] else "",
            error="; ".join(result.get("errors", [])) if not result["ok"] else "",
            next_path=next_path,
        ),
        status_code=302,
    )


@router.post("/asset-configs/asset-chains/create")
def asset_config_asset_chain_create(
    request: Request,
    asset_id: str = Form(""),
    chain_id: str = Form(""),
    contract_address: str = Form(""),
    decimals: str = Form(""),
    min_deposit: str = Form(""),
    min_withdraw: str = Form(""),
    collection_min_amount: Optional[str] = Form(None),
    collection_real_send_enabled: str = Form("0"),
    collection_max_single_amount: str = Form(""),
    collection_daily_amount_limit: str = Form(""),
    review_threshold_amount: str = Form(""),
    force_manual_review: str = Form("0"),
    daily_withdraw_count_limit: str = Form(""),
    confirmations: str = Form(""),
    collection_address: str = Form(""),
    hot_wallet_address: str = Form(""),
    deposit_enabled: str = Form("0"),
    withdraw_enabled: str = Form("0"),
    enabled: str = Form("0"),
    sort: str = Form(""),
    next_path: str = Form("/admin/asset-configs?tab=asset_chains"),
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "asset_configs.manage")
    if redir:
        return redir

    result = admin_create_asset_chain_config(
        db,
        {
            "asset_id": asset_id,
            "chain_id": chain_id,
            "contract_address": contract_address,
            "decimals": decimals,
            "min_deposit": min_deposit,
            "min_withdraw": min_withdraw,
            "collection_min_amount": collection_min_amount,
            "collection_real_send_enabled": collection_real_send_enabled,
            "collection_max_single_amount": collection_max_single_amount,
            "collection_daily_amount_limit": collection_daily_amount_limit,
            "review_threshold_amount": review_threshold_amount,
            "force_manual_review": force_manual_review,
            "daily_withdraw_count_limit": daily_withdraw_count_limit,
            "confirmations": confirmations,
            "collection_address": collection_address,
            "hot_wallet_address": hot_wallet_address,
            "deposit_enabled": deposit_enabled,
            "withdraw_enabled": withdraw_enabled,
            "enabled": enabled,
            "sort": sort,
        },
    )
    asset_chain_next_path = next_path if "tab=asset_chains" in next_path else "/admin/asset-configs?tab=asset_chains"
    return RedirectResponse(
        url=_build_asset_configs_redirect_url(
            notice="币种-网络配置创建成功" if result["ok"] else "",
            error="; ".join(result.get("errors", [])) if not result["ok"] else "",
            next_path=asset_chain_next_path,
        ),
        status_code=302,
    )


@router.post("/asset-configs/asset-chains/{asset_chain_id}/update")
def asset_config_asset_chain_update(
    request: Request,
    asset_chain_id: int,
    contract_address: str = Form(""),
    decimals: str = Form(""),
    min_deposit: str = Form(""),
    min_deposit_amount: str = Form("", alias="min_deposit_amount"),
    min_withdraw: str = Form(""),
    min_withdraw_amount: str = Form("", alias="min_withdraw_amount"),
    collection_min_amount: Optional[str] = Form(None),
    collection_real_send_enabled: str = Form("0"),
    collection_max_single_amount: str = Form(""),
    collection_daily_amount_limit: str = Form(""),
    review_threshold_amount: str = Form(""),
    force_manual_review: str = Form("0"),
    daily_withdraw_count_limit: str = Form(""),
    daily_withdraw_limit: str = Form("", alias="daily_withdraw_limit"),
    confirmations: str = Form(""),
    collection_address: str = Form(""),
    hot_wallet_address: str = Form(""),
    deposit_enabled: str = Form("0"),
    withdraw_enabled: str = Form("0"),
    enabled: str = Form("0"),
    sort: str = Form(""),
    next_path: str = Form("/admin/asset-configs?tab=asset_chains"),
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "asset_configs.manage")
    if redir:
        return redir

    asset_chain_next_path = next_path if "tab=asset_chains" in next_path else "/admin/asset-configs?tab=asset_chains"
    try:
        result = admin_update_asset_chain_config(
            db,
            asset_chain_id,
            {
                "contract_address": contract_address,
                "decimals": decimals,
                "min_deposit": min_deposit_amount or min_deposit,
                "min_withdraw": min_withdraw_amount or min_withdraw,
                "collection_min_amount": collection_min_amount,
                "collection_real_send_enabled": collection_real_send_enabled,
                "collection_max_single_amount": collection_max_single_amount,
                "collection_daily_amount_limit": collection_daily_amount_limit,
                "review_threshold_amount": review_threshold_amount,
                "force_manual_review": force_manual_review,
                "daily_withdraw_count_limit": daily_withdraw_count_limit or daily_withdraw_limit,
                "confirmations": confirmations,
                "collection_address": collection_address,
                "hot_wallet_address": hot_wallet_address,
                "deposit_enabled": deposit_enabled,
                "withdraw_enabled": withdraw_enabled,
                "enabled": enabled,
                "sort": sort,
            },
        )
    except Exception:
        result = {"ok": False, "errors": ["保存失败，请检查配置后重试"]}
    return RedirectResponse(
        url=_build_asset_configs_redirect_url(
            success=f"币种-网络配置 {asset_chain_id} 保存成功" if result["ok"] else "",
            error="; ".join(result.get("errors", [])) if not result["ok"] else "",
            next_path=asset_chain_next_path,
        ),
        status_code=302,
    )


@router.post("/asset-configs/asset-chains/{asset_chain_id}/delete")
def asset_config_asset_chain_delete(
    request: Request,
    asset_chain_id: int,
    next_path: str = Form("/admin/asset-configs?tab=asset_chains"),
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "asset_configs.manage")
    if redir:
        return redir

    result = admin_delete_asset_chain_config(db, asset_chain_id)
    asset_chain_next_path = next_path if "tab=asset_chains" in next_path else "/admin/asset-configs?tab=asset_chains"
    return RedirectResponse(
        url=_build_asset_configs_redirect_url(
            notice="币种-网络配置已删除" if result["ok"] else "",
            error="; ".join(result.get("errors", [])) if not result["ok"] else "",
            next_path=asset_chain_next_path,
        ),
        status_code=302,
    )


@router.get("/orders", response_class=HTMLResponse)
def orders_page(
    request: Request,
    query_scope: str = "recent",
    order_id: str = "",
    order_no: str = "",
    user_id: str = "",
    symbol: str = "",
    side: str = "",
    order_type: str = "",
    execution_mode: str = "",
    status: str = "",
    date_from: str = "",
    date_to: str = "",
    start_time: str = "",
    end_time: str = "",
    cursor_created_at: str = "",
    cursor_id: str = "",
    direction: str = "next",
    page: int = 1,
    page_size: int = 20,
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return redir

    query_scope_value = _clean_query_text(query_scope).lower() or "recent"
    order_id_value = _clean_query_text(order_id)
    order_no_value = _clean_query_text(order_no)
    user_id_value = _clean_query_text(user_id)
    symbol_value = _clean_query_text(symbol).upper()
    side_value = _clean_query_text(side).upper()
    order_type_value = _clean_query_text(order_type).upper()
    execution_mode_value = _clean_query_text(execution_mode).upper()
    status_value = _clean_query_text(status).upper()
    range_from, range_to, query_notices, used_default_range = _balance_log_date_range(
        date_from_text=date_from,
        date_to_text=date_to,
        created_from_text=start_time,
        created_to_text=end_time,
    )
    start_time_value, end_time_value = get_admin_date_time_window(range_from, range_to)
    range_days = (range_to - range_from).days + 1
    has_precise_condition = _balance_log_has_precise_condition(
        order_id_value,
        order_no_value,
        user_id_value,
        symbol_value,
        status_value,
    )
    range_blocked = range_days > 30 and not has_precise_condition
    if range_blocked:
        query_notices.append(ORDERS_RANGE_BLOCK_NOTICE)
        range_from, range_to = _narrow_admin_range_to_30_days(range_to)
        start_time_value, end_time_value = get_admin_date_time_window(range_from, range_to)
        range_days = 30
    active_range_days = range_days if range_days in {7, 15, 30} else (7 if used_default_range else 0)
    today = get_admin_today_date()
    quick_ranges = [
        {
            "days": days,
            "date_from": (today - timedelta(days=days - 1)).isoformat(),
            "date_to": today.isoformat(),
        }
        for days in (7, 15, 30)
    ]
    cursor_created_at_value = _clean_query_text(cursor_created_at)
    cursor_id_value = _clean_query_text(cursor_id)
    direction_value = _clean_query_text(direction).lower() or "next"

    query_filters = {
        "query_scope": query_scope_value,
        "order_id": order_id_value,
        "order_no": order_no_value,
        "user_id": user_id_value,
        "symbol": symbol_value,
        "side": side_value,
        "order_type": order_type_value,
        "execution_mode": execution_mode_value,
        "status": status_value,
        "start_time": start_time_value,
        "end_time": end_time_value,
        "cursor_created_at": cursor_created_at_value,
        "cursor_id": cursor_id_value,
        "direction": direction_value,
        "page": page,
        "page_size": page_size,
    }
    result = admin_query_orders(db=db, filters=query_filters)
    performance_notice = result.get("performance_notice", "")
    if query_notices:
        performance_notice = f"{' '.join(query_notices)} {performance_notice}".strip()
    pagination = {
        "page": _result_page(result),
        "page_size": _result_page_size(result),
        "total": _result_total(result),
        "pages": result.get("total_pages") or result.get("pages") or 1,
        "total_pages": result.get("total_pages") or result.get("pages") or 1,
        "has_next": result.get("has_next", _result_page(result) < (result.get("pages") or 1)),
        "has_prev": result.get("has_prev", _result_page(result) > 1),
        "is_page_limited": result.get("is_page_limited", False),
        "pagination_mode": result.get("pagination_mode", "page"),
        "next_cursor_created_at": result.get("next_cursor_created_at", ""),
        "next_cursor_id": result.get("next_cursor_id", ""),
        "prev_cursor_created_at": result.get("prev_cursor_created_at", ""),
        "prev_cursor_id": result.get("prev_cursor_id", ""),
    }
    effective_start_time = result.get("effective_start_time")
    effective_end_time = result.get("effective_end_time")
    filters = {
        "query_scope": result.get("query_scope", query_scope_value),
        "order_id": order_id_value,
        "order_no": order_no_value,
        "user_id": user_id_value,
        "symbol": symbol_value,
        "side": side_value,
        "order_type": order_type_value,
        "execution_mode": execution_mode_value,
        "status": status_value,
        "start_time": _format_date_input(range_from),
        "end_time": _format_date_input(range_to),
        "date_from": _format_date_input(range_from),
        "date_to": _format_date_input(range_to),
    }
    return render(
        request,
        "admin/orders_list.html",
        ctx={
            "items": _result_items(result),
            "active_group": "trade",
            "active": "order_manage",
            "filters": filters,
            "pagination": pagination,
            "performance_notice": performance_notice,
            "large_table_notice": ORDERS_LARGE_TABLE_NOTICE,
            "quick_ranges": quick_ranges,
            "active_range_days": active_range_days,
            "is_limited_range": result.get("is_limited_range", False),
            "query_scope": result.get("query_scope", query_scope_value),
        },
    )


@router.get("/trades", response_class=HTMLResponse)
def trades_page(
    request: Request,
    query_scope: str = "recent",
    trade_id: str = "",
    user_id: str = "",
    order_id: str = "",
    order_no: str = "",
    symbol: str = "",
    buyer_user_id: str = "",
    seller_user_id: str = "",
    buy_order_id: str = "",
    sell_order_id: str = "",
    counterparty_type: str = "",
    date_from: str = "",
    date_to: str = "",
    start_time: str = "",
    end_time: str = "",
    cursor_created_at: str = "",
    cursor_id: str = "",
    direction: str = "next",
    page: int = 1,
    page_size: int = 20,
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return redir

    query_scope_value = _clean_query_text(query_scope).lower() or "recent"
    trade_id_value = _clean_query_text(trade_id)
    user_id_value = _clean_query_text(user_id)
    order_id_value = _clean_query_text(order_id)
    order_no_value = _clean_query_text(order_no)
    if order_id_value and not order_id_value.isdigit() and not order_no_value:
        order_no_value = order_id_value
        order_id_value = ""
    symbol_value = _clean_query_text(symbol).upper()
    buyer_user_id_value = _clean_query_text(buyer_user_id)
    seller_user_id_value = _clean_query_text(seller_user_id)
    buy_order_id_value = _clean_query_text(buy_order_id or order_id_value)
    sell_order_id_value = _clean_query_text(sell_order_id)
    counterparty_type_value = _clean_query_text(counterparty_type).upper()
    range_from, range_to, query_notices, used_default_range = _balance_log_date_range(
        date_from_text=date_from,
        date_to_text=date_to,
        created_from_text=start_time,
        created_to_text=end_time,
    )
    start_time_value = datetime.combine(range_from, datetime.min.time())
    end_time_value = datetime.combine(range_to, datetime.max.time())
    range_days = (range_to - range_from).days + 1
    has_precise_condition = _balance_log_has_precise_condition(
        user_id_value,
        buyer_user_id_value,
        seller_user_id_value,
        trade_id_value,
        order_id_value,
        order_no_value,
        buy_order_id_value,
        sell_order_id_value,
        symbol_value,
    )
    range_blocked = range_days > 30 and not has_precise_condition
    if range_blocked:
        query_notices.append(TRADES_RANGE_BLOCK_NOTICE)
        range_from, range_to = _narrow_admin_range_to_30_days(range_to)
        start_time_value = datetime.combine(range_from, datetime.min.time())
        end_time_value = datetime.combine(range_to, datetime.max.time())
        range_days = 30
    active_range_days = range_days if range_days in {7, 15, 30} else (7 if used_default_range else 0)
    today = get_admin_today_date()
    quick_ranges = [
        {
            "days": days,
            "date_from": (today - timedelta(days=days - 1)).isoformat(),
            "date_to": today.isoformat(),
        }
        for days in (7, 15, 30)
    ]
    cursor_created_at_value = _clean_query_text(cursor_created_at)
    cursor_id_value = _clean_query_text(cursor_id)
    direction_value = _clean_query_text(direction).lower() or "next"

    query_filters = {
        "query_scope": query_scope_value,
        "trade_id": trade_id_value,
        "symbol": symbol_value,
        "user_id": user_id_value,
        "order_no": order_no_value,
        "buyer_user_id": buyer_user_id_value,
        "seller_user_id": seller_user_id_value,
        "buy_order_id": buy_order_id_value,
        "sell_order_id": sell_order_id_value,
        "counterparty_type": counterparty_type_value,
        "start_time": start_time_value,
        "end_time": end_time_value,
        "cursor_created_at": cursor_created_at_value,
        "cursor_id": cursor_id_value,
        "direction": direction_value,
        "page": page,
        "page_size": page_size,
    }
    result = admin_query_trades(db=db, filters=query_filters)
    performance_notice = result.get("performance_notice", "")
    if query_notices:
        performance_notice = f"{' '.join(query_notices)} {performance_notice}".strip()
    pagination = {
        "page": _result_page(result),
        "page_size": _result_page_size(result),
        "total": _result_total(result),
        "pages": result.get("total_pages") or result.get("pages") or 1,
        "total_pages": result.get("total_pages") or result.get("pages") or 1,
        "has_next": result.get("has_next", _result_page(result) < (result.get("pages") or 1)),
        "has_prev": result.get("has_prev", _result_page(result) > 1),
        "is_page_limited": result.get("is_page_limited", False),
        "pagination_mode": result.get("pagination_mode", "page"),
        "next_cursor_created_at": result.get("next_cursor_created_at", ""),
        "next_cursor_id": result.get("next_cursor_id", ""),
        "prev_cursor_created_at": result.get("prev_cursor_created_at", ""),
        "prev_cursor_id": result.get("prev_cursor_id", ""),
    }
    effective_start_time = result.get("effective_start_time")
    effective_end_time = result.get("effective_end_time")
    filters = {
        "query_scope": result.get("query_scope", query_scope_value),
        "trade_id": trade_id_value,
        "symbol": symbol_value,
        "user_id": user_id_value,
        "order_id": order_id_value,
        "order_no": order_no_value,
        "buyer_user_id": buyer_user_id_value,
        "seller_user_id": seller_user_id_value,
        "buy_order_id": buy_order_id_value,
        "sell_order_id": sell_order_id_value,
        "counterparty_type": counterparty_type_value,
        "start_time": _format_date_input(range_from),
        "end_time": _format_date_input(range_to),
        "date_from": _format_date_input(range_from),
        "date_to": _format_date_input(range_to),
    }
    return render(
        request,
        "admin/trades_list.html",
        ctx={
            "items": _result_items(result),
            "active_group": "trade",
            "active": "trade_manage",
            "filters": filters,
            "pagination": pagination,
            "performance_notice": performance_notice,
            "large_table_notice": TRADES_LARGE_TABLE_NOTICE,
            "quick_ranges": quick_ranges,
            "active_range_days": active_range_days,
            "is_limited_range": result.get("is_limited_range", False),
            "query_scope": result.get("query_scope", query_scope_value),
        },
    )


@router.get("/spot-fee-settings", response_class=HTMLResponse)
def spot_fee_settings_page(
    request: Request,
    notice: str = "",
    error: str = "",
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return redir

    settings = load_spot_fee_settings(db)
    return render(
        request,
        "admin/spot_fee_settings.html",
        ctx={
            "active_group": "trade",
            "active": "spot_fee_settings",
            "notice": notice,
            "error": error,
            "settings": settings,
            "discount_percent_input": _format_fee_discount_percent_input(settings.rcb_fee_discount_rate),
        },
    )


@router.post("/spot-fee-settings")
def save_spot_fee_settings(
    request: Request,
    spot_rcb_fee_enabled: str = Form("0"),
    rcb_fee_discount_percent: str = Form(""),
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "fee_settings.manage")
    if redir:
        return redir

    admin = get_admin_from_request(request) or {}
    admin_id = None
    try:
        admin_id = int(admin.get("id")) if admin.get("id") is not None else None
    except (TypeError, ValueError):
        admin_id = None

    try:
        rate = _parse_fee_discount_percent_value(rcb_fee_discount_percent)
        update_spot_fee_settings(
            db,
            spot_rcb_fee_enabled=str(spot_rcb_fee_enabled or "").strip() == "1",
            rcb_fee_discount_rate=rate,
            updated_by_admin_id=admin_id,
        )
        db.commit()
        notice = "现货手续费配置已保存"
        error = ""
    except (ArithmeticError, ValueError, SpotFeeSettingsError) as exc:
        db.rollback()
        notice = ""
        error = str(exc)
    except Exception as exc:
        db.rollback()
        notice = ""
        error = f"保存现货手续费配置失败：{exc}"

    return RedirectResponse(
        url=_build_spot_fee_settings_redirect_url(notice=notice, error=error),
        status_code=302,
    )


@router.get("/market-cache-monitor", response_class=HTMLResponse)
def market_cache_monitor_page(request: Request):
    redir = require_admin(request)
    if redir:
        return redir

    return render(
        request,
        "admin/market_cache_monitor.html",
        ctx={
            "active_group": "system",
            "active": "market_cache_monitor",
            "metrics": get_market_cache_metrics_snapshot(),
        },
    )


@router.get("/system/operations", response_class=HTMLResponse)
def operations_center_page(request: Request):
    redir = require_admin(request)
    if redir:
        return redir

    return render(
        request,
        "admin/operations_center.html",
        ctx={
            "active_group": "system",
            "active": "operations_center",
            "operations_center": admin_query_operations_center(),
        },
    )


@router.get("/system/rq", response_class=HTMLResponse)
def rq_status_page(request: Request):
    redir = require_admin(request)
    if redir:
        return redir

    return render(
        request,
        "admin/rq_status.html",
        ctx={
            "active_group": "system",
            "active": "rq_status",
            "rq_status": admin_query_rq_status(),
        },
    )


@router.get("/system/services", response_class=HTMLResponse)
def service_overview_page(request: Request):
    redir = require_admin(request)
    if redir:
        return redir

    return render(
        request,
        "admin/service_overview.html",
        ctx={
            "active_group": "system",
            "active": "service_overview",
            "service_overview": admin_query_service_overview(),
        },
    )


@router.get("/system/db-lifecycle", response_class=HTMLResponse)
def db_lifecycle_page(request: Request, db: Session = Depends(get_db)):
    redir = require_admin(request)
    if redir:
        return redir

    recent_logs = (
        db.query(DbLifecycleCleanupLog)
        .order_by(DbLifecycleCleanupLog.started_at.desc(), DbLifecycleCleanupLog.id.desc())
        .limit(100)
        .all()
    )
    latest_log = recent_logs[0] if recent_logs else None
    latest_real_delete = (
        db.query(DbLifecycleCleanupLog)
        .filter(
            (DbLifecycleCleanupLog.operation_mode == OPERATION_MODE_EXECUTE)
            | (DbLifecycleCleanupLog.risk_level == RISK_LEVEL_REAL_DELETE)
        )
        .order_by(DbLifecycleCleanupLog.started_at.desc(), DbLifecycleCleanupLog.id.desc())
        .first()
    )

    return render(
        request,
        "admin/db_lifecycle.html",
        ctx={
            "active_group": "system",
            "active": "db_lifecycle",
            "db_lifecycle": {
                "cleanup_enabled": settings.DB_LIFECYCLE_CLEANUP_ENABLED,
                "dry_run": settings.DB_LIFECYCLE_CLEANUP_DRY_RUN,
                "allow_execute": settings.DB_LIFECYCLE_CLEANUP_ALLOW_EXECUTE,
                "execute_confirm_configured": bool(str(settings.DB_LIFECYCLE_CLEANUP_EXECUTE_CONFIRM or "").strip()),
                "can_execute_now": can_execute_cleanup(settings.DB_LIFECYCLE_CLEANUP_EXECUTE_CONFIRM),
                "retention_days": settings.DB_LIFECYCLE_CLEANUP_RETENTION_DAYS,
                "latest_log": latest_log,
                "latest_real_delete": latest_real_delete,
                "recent_logs": recent_logs,
                "protected_tables": sorted(PROTECTED_TABLES),
                "core_financial_tables": core_financial_table_rows(),
            },
        },
    )


@router.get("/system/core-archives", response_class=HTMLResponse)
def core_archives_page(request: Request, db: Session = Depends(get_db)):
    redir = require_admin(request)
    if redir:
        return redir

    batches = (
        db.query(CoreArchiveBatch)
        .order_by(CoreArchiveBatch.id.desc())
        .limit(100)
        .all()
    )
    latest_batch = batches[0] if batches else None
    verified_count = sum(1 for item in batches if item.status == "VERIFIED")
    failed_count = sum(1 for item in batches if item.status == "FAILED")

    return render(
        request,
        "admin/core_archives.html",
        ctx={
            "active_group": "system",
            "active": "core_archives",
            "core_archives": {
                "batches": batches,
                "latest_batch": latest_batch,
                "verified_count": verified_count,
                "failed_count": failed_count,
                "supported_tables": ["orders", "trades"],
                "safety_notes": [
                    "V2 pilot is copy-only.",
                    "Hot table migrate-out is not implemented.",
                    "deleted_count must remain 0.",
                    "Statuses MIGRATING_OUT and COMPLETED are intentionally unsupported.",
                ],
            },
        },
    )


def _build_geo_access_redirect_url(notice: str = "", error: str = "") -> str:
    params: list[tuple[str, str]] = []
    if notice:
        params.append(("notice", notice))
    if error:
        params.append(("error", error))
    if not params:
        return "/admin/geo-access"
    return f"/admin/geo-access?{urlencode(params)}"


GEO_ACCESS_COUNTRY_OPTIONS: tuple[tuple[str, str], ...] = (
    ("CN", "中国大陆"),
    ("HK", "中国香港"),
    ("MO", "中国澳门"),
    ("TW", "中国台湾"),
    ("US", "美国"),
    ("CA", "加拿大"),
    ("GB", "英国"),
    ("AU", "澳大利亚"),
    ("JP", "日本"),
    ("KR", "韩国"),
    ("SG", "新加坡"),
    ("TH", "泰国"),
    ("VN", "越南"),
    ("ID", "印度尼西亚"),
    ("MY", "马来西亚"),
    ("PH", "菲律宾"),
    ("IN", "印度"),
    ("AE", "阿联酋"),
    ("TR", "土耳其"),
    ("RU", "俄罗斯"),
    ("IR", "伊朗"),
    ("KP", "朝鲜"),
    ("CU", "古巴"),
    ("SY", "叙利亚"),
)


def _geo_access_country_label_map() -> Dict[str, str]:
    return {code: name for code, name in GEO_ACCESS_COUNTRY_OPTIONS}


def _format_geo_access_country_label(code: str) -> str:
    normalized = str(code or "").strip().upper()
    if not normalized:
        return ""
    label = _geo_access_country_label_map().get(normalized)
    return f"{label} {normalized}" if label else normalized


def _format_geo_access_country_list(codes: list[str] | tuple[str, ...]) -> str:
    return "、".join(_format_geo_access_country_label(code) for code in codes if str(code or "").strip())


def _parse_geo_access_country_form_codes(value: object) -> tuple[str, ...]:
    if value is None:
        return tuple()
    if isinstance(value, str):
        text_value = value.strip()
        if not text_value:
            return tuple()
        try:
            parsed = json.loads(text_value)
        except json.JSONDecodeError:
            parsed = None
        if isinstance(parsed, list):
            items = parsed
        else:
            items = text_value.replace("\n", ",").replace(" ", ",").split(",")
    elif isinstance(value, list):
        items = value
    else:
        items = [value]

    codes: list[str] = []
    seen: set[str] = set()
    for item in items:
        code = str(item or "").strip().upper()
        if not code or code in seen:
            continue
        seen.add(code)
        codes.append(code)
    return tuple(codes)


def _parse_geo_access_datetime(value: str) -> Optional[datetime]:
    text_value = str(value or "").strip()
    if not text_value:
        return None
    try:
        return datetime.fromisoformat(text_value.replace("Z", "+00:00")).replace(tzinfo=None)
    except ValueError:
        return None


def _format_geo_access_datetime_value(value: datetime | None) -> str:
    if not value:
        return ""
    return value.strftime("%Y-%m-%dT%H:%M")


def _is_geo_access_debug_path(path: str) -> bool:
    normalized = str(path or "")
    if normalized == "/admin/geo-access" or normalized.startswith("/admin/geo-access/"):
        return True
    return normalized.startswith(("/static/", "/admin/static/"))


def _apply_geo_access_debug_log_filters(query):
    query = query.filter(
        GeoAccessLog.ip_address.notin_(("127.0.0.1", "localhost", "::1")),
        ~GeoAccessLog.ip_address.like("10.%"),
        ~GeoAccessLog.ip_address.like("192.168.%"),
        ~GeoAccessLog.ip_address.like("fc%"),
        ~GeoAccessLog.ip_address.like("fd%"),
        ~GeoAccessLog.ip_address.like("fe80:%"),
        ~GeoAccessLog.path.like("/admin/geo-access%"),
        ~GeoAccessLog.path.like("/static/%"),
        ~GeoAccessLog.path.like("/admin/static/%"),
        ~GeoAccessLog.last_path.like("/admin/geo-access%"),
        ~GeoAccessLog.last_path.like("/static/%"),
        ~GeoAccessLog.last_path.like("/admin/static/%"),
    )
    for second_octet in range(16, 32):
        query = query.filter(~GeoAccessLog.ip_address.like(f"172.{second_octet}.%"))
    return query


def _geo_access_filtered_log_query(
    db: Session,
    *,
    ip: str = "",
    country_code: str = "",
    decision: str = "",
    from_time: datetime | None = None,
    to_time: datetime | None = None,
    include_debug: bool = False,
):
    query = db.query(GeoAccessLog)
    if from_time:
        query = query.filter(GeoAccessLog.last_seen_at >= from_time)
    if to_time:
        query = query.filter(GeoAccessLog.last_seen_at <= to_time)
    if ip:
        query = query.filter(GeoAccessLog.ip_address.like(f"%{ip.strip()[:45]}%"))
    if country_code:
        query = query.filter(GeoAccessLog.country_code == country_code.strip().upper()[:8])
    if decision:
        query = query.filter(GeoAccessLog.decision == decision.strip().upper()[:16])
    if not include_debug:
        query = _apply_geo_access_debug_log_filters(query)
    return query


@router.get("/geo-access", response_class=HTMLResponse)
def geo_access_page(
    request: Request,
    notice: str = "",
    error: str = "",
    ip: str = "",
    country_code: str = "",
    decision: str = "",
    from_time: str = "",
    to_time: str = "",
    limit: int = 100,
    show_debug: str = "",
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return redir

    settings_row = get_or_create_geo_access_settings(db)
    db.commit()
    rules = db.query(GeoIpRule).order_by(GeoIpRule.id.desc()).limit(200).all()
    restricted_country_codes = list(parse_country_list(settings_row.restricted_countries_json))
    restricted_countries = ",".join(restricted_country_codes)
    restricted_country_display = _format_geo_access_country_list(restricted_country_codes)
    safe_limit = min(max(int(limit or 100), 1), 200)
    default_from_time = datetime.utcnow() - timedelta(hours=24)
    parsed_from_time = _parse_geo_access_datetime(from_time) or default_from_time
    parsed_to_time = _parse_geo_access_datetime(to_time)
    normalized_country_filter = str(country_code or "").strip().upper()
    normalized_decision_filter = str(decision or "").strip().upper()
    normalized_ip_filter = str(ip or "").strip()
    include_debug_logs = str(show_debug or "").lower() in {"1", "true", "on", "yes"}
    log_filter_error = ""

    if parsed_to_time and parsed_to_time < parsed_from_time:
        parsed_to_time = None
        log_filter_error = "结束时间早于开始时间，已忽略结束时间。"

    range_end = parsed_to_time or datetime.utcnow()
    has_required_long_range_filter = any(
        (normalized_ip_filter, normalized_country_filter, normalized_decision_filter)
    )
    if range_end - parsed_from_time > timedelta(days=30) and not has_required_long_range_filter:
        parsed_from_time = range_end - timedelta(days=30)
        log_filter_error = "超过 30 天的日志查询必须输入 IP、国家/地区或处理结果之一，已自动收窄为最近 30 天。"

    filtered_logs = _geo_access_filtered_log_query(
        db,
        ip=normalized_ip_filter,
        country_code=normalized_country_filter,
        decision=normalized_decision_filter,
        from_time=parsed_from_time,
        to_time=parsed_to_time,
        include_debug=include_debug_logs,
    )
    summary_rows = (
        filtered_logs.with_entities(
            GeoAccessLog.ip_address.label("ip_address"),
            GeoAccessLog.country_code.label("country_code"),
            GeoAccessLog.source.label("source"),
            GeoAccessLog.decision.label("decision"),
            GeoAccessLog.reason.label("reason"),
            func.sum(GeoAccessLog.hit_count).label("hit_count"),
            func.min(GeoAccessLog.first_seen_at).label("first_seen_at"),
            func.max(GeoAccessLog.last_seen_at).label("last_seen_at"),
            func.max(GeoAccessLog.last_path).label("last_path"),
        )
        .group_by(
            GeoAccessLog.ip_address,
            GeoAccessLog.country_code,
            GeoAccessLog.source,
            GeoAccessLog.decision,
            GeoAccessLog.reason,
        )
        .order_by(func.max(GeoAccessLog.last_seen_at).desc())
        .limit(safe_limit)
        .all()
    )
    log_summaries = []
    for row in summary_rows:
        latest_row = (
            filtered_logs.filter(
                GeoAccessLog.ip_address == row.ip_address,
                GeoAccessLog.country_code == row.country_code,
                GeoAccessLog.source == row.source,
                GeoAccessLog.decision == row.decision,
                GeoAccessLog.reason == row.reason,
            )
            .order_by(GeoAccessLog.last_seen_at.desc(), GeoAccessLog.id.desc())
            .first()
        )
        log_summaries.append(
            SimpleNamespace(
                ip_address=row.ip_address,
                country_code=row.country_code,
                source=row.source,
                decision=row.decision,
                reason=row.reason,
                hit_count=row.hit_count,
                first_seen_at=row.first_seen_at,
                last_seen_at=row.last_seen_at,
                last_path=(latest_row.last_path or latest_row.path) if latest_row else row.last_path,
            )
        )
    logs = (
        filtered_logs.order_by(GeoAccessLog.last_seen_at.desc(), GeoAccessLog.id.desc())
        .limit(min(safe_limit, 100))
        .all()
    )
    recent_hit_query = db.query(GeoAccessLog)
    if not include_debug_logs:
        recent_hit_query = _apply_geo_access_debug_log_filters(recent_hit_query)
    recent_hit = recent_hit_query.order_by(GeoAccessLog.last_seen_at.desc(), GeoAccessLog.id.desc()).first()
    recent_hit_at = recent_hit.last_seen_at if recent_hit else None

    return render(
        request,
        "admin/geo_access.html",
        ctx={
            "active_group": "system",
            "active": "geo_access",
            "notice": notice,
            "error": error,
            "settings_row": settings_row,
            "geo_country_options": GEO_ACCESS_COUNTRY_OPTIONS,
            "geo_country_label_map": _geo_access_country_label_map(),
            "restricted_country_codes": restricted_country_codes,
            "restricted_countries": restricted_countries,
            "restricted_country_display": restricted_country_display,
            "restricted_country_count": len(restricted_country_codes),
            "rules": rules,
            "log_summaries": log_summaries,
            "logs": logs,
            "recent_hit_at": recent_hit_at,
            "geo_log_retention_days": GEO_ACCESS_LOG_RETENTION_DAYS,
            "geo_log_filter_error": log_filter_error,
            "geo_log_filters": {
                "ip": normalized_ip_filter,
                "country_code": normalized_country_filter,
                "decision": normalized_decision_filter,
                "from_time": _format_geo_access_datetime_value(parsed_from_time),
                "to_time": _format_geo_access_datetime_value(parsed_to_time),
                "limit": safe_limit,
                "show_debug": include_debug_logs,
            },
        },
    )


@router.post("/geo-access/settings")
def geo_access_settings_submit(
    request: Request,
    enabled: Optional[str] = Form(None),
    monitor_mode: Optional[str] = Form(None),
    block_unknown: Optional[str] = Form(None),
    admin_exempt: Optional[str] = Form(None),
    restricted_countries: str = Form(""),
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, ADMIN_PERMISSION_SUPER_ADMIN_ONLY)
    if redir:
        return redir

    try:
        country_codes = list(_parse_geo_access_country_form_codes(restricted_countries))
        valid_codes = set(_geo_access_country_label_map())
        invalid_codes = [code for code in country_codes if code not in valid_codes]
        if invalid_codes:
            return RedirectResponse(
                url=_build_geo_access_redirect_url(
                    error=f"存在无效国家/地区代码：{', '.join(invalid_codes)}"
                ),
                status_code=302,
            )
        update_geo_access_settings(
            db,
            enabled=enabled == "1",
            monitor_mode=monitor_mode == "1",
            block_unknown=block_unknown == "1",
            admin_exempt=admin_exempt == "1",
            restricted_countries=country_codes,
        )
        db.commit()
        return RedirectResponse(
            url=_build_geo_access_redirect_url(notice="地区访问控制设置已保存。"),
            status_code=302,
        )
    except Exception as exc:
        db.rollback()
        logger.warning("Failed to save geo access settings", exc_info=True)
        return RedirectResponse(
            url=_build_geo_access_redirect_url(error=str(exc)[:180]),
            status_code=302,
        )


@router.post("/geo-access/rules")
def geo_access_rule_create_submit(
    request: Request,
    rule_type: str = Form(RULE_ALLOW),
    ip_cidr: str = Form(...),
    note: str = Form(""),
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, ADMIN_PERMISSION_SUPER_ADMIN_ONLY)
    if redir:
        return redir

    try:
        create_geo_ip_rule(db, rule_type=rule_type, ip_cidr=ip_cidr, note=note)
        db.commit()
        return RedirectResponse(
            url=_build_geo_access_redirect_url(notice="IP 规则已添加。"),
            status_code=302,
        )
    except Exception as exc:
        db.rollback()
        return RedirectResponse(
            url=_build_geo_access_redirect_url(error=str(exc)[:180]),
            status_code=302,
        )


@router.post("/geo-access/rules/{rule_id}/toggle")
def geo_access_rule_toggle_submit(
    request: Request,
    rule_id: int,
    enabled: Optional[str] = Form(None),
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, ADMIN_PERMISSION_SUPER_ADMIN_ONLY)
    if redir:
        return redir

    row = set_geo_ip_rule_enabled(db, rule_id, enabled == "1")
    db.commit()
    if not row:
        return RedirectResponse(
            url=_build_geo_access_redirect_url(error="IP 规则不存在。"),
            status_code=302,
        )
    return RedirectResponse(
        url=_build_geo_access_redirect_url(notice="IP 规则已更新。"),
        status_code=302,
    )


@router.post("/geo-access/rules/{rule_id}/delete")
def geo_access_rule_delete_submit(
    request: Request,
    rule_id: int,
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, ADMIN_PERMISSION_SUPER_ADMIN_ONLY)
    if redir:
        return redir

    deleted = delete_geo_ip_rule(db, rule_id)
    db.commit()
    if not deleted:
        return RedirectResponse(
            url=_build_geo_access_redirect_url(error="IP 规则不存在。"),
            status_code=302,
        )
    return RedirectResponse(
        url=_build_geo_access_redirect_url(notice="IP 规则已删除。"),
        status_code=302,
    )


@router.get("/trading-pairs", response_class=HTMLResponse)
@router.get("/pairs", response_class=HTMLResponse)
def pairs_page(
    request: Request,
    symbol: str = "",
    market_mode: str = "",
    data_source: str = "",
    status: str = "",
    notice: str = "",
    error: str = "",
    page: int = 1,
    page_size: int = 20,
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return redir

    query_filters = {
        "symbol": symbol,
        "market_mode": market_mode,
        "data_source": data_source,
        "status": status,
        "page": page,
        "page_size": page_size,
    }
    result = admin_query_pairs(db=db, filters=query_filters)
    pagination = {
        "page": _result_page(result),
        "page_size": _result_page_size(result),
        "total": _result_total(result),
        "pages": _result_pages(result),
    }
    filters = {
        "symbol": symbol,
        "market_mode": market_mode,
        "data_source": data_source,
        "status": status,
    }
    return render(
        request,
        "admin/pairs_list.html",
        ctx={
            "items": _result_items(result),
            "notice": notice,
            "error": error,
            "active_group": "trade",
            "active": "pair_config",
            "filters": filters,
            "pagination": pagination,
        },
    )


@router.get("/reference-overlays", response_class=HTMLResponse)
def reference_overlays_page(
    request: Request,
    symbol: str = "",
    kind: str = "",
    enabled: str = "",
    notice: str = "",
    error: str = "",
    page: int = 1,
    page_size: int = 20,
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return redir

    query_filters = {
        "symbol": symbol,
        "kind": kind,
        "enabled": enabled,
        "page": page,
        "page_size": page_size,
    }
    result = admin_query_reference_overlays(db=db, filters=query_filters)
    return render(
        request,
        "admin/reference_overlays.html",
        ctx={
            "items": _result_items(result),
            "notice": notice,
            "error": error,
            "active_group": "operations",
            "active": "reference_overlays",
            "filters": {"symbol": symbol, "kind": kind, "enabled": enabled},
            "pagination": {
                "page": _result_page(result),
                "page_size": _result_page_size(result),
                "total": _result_total(result),
                "pages": _result_pages(result),
            },
        },
    )


@router.get("/reference-overlays/create", response_class=HTMLResponse)
def reference_overlay_create_page(request: Request):
    redir = require_admin(request)
    if redir:
        return redir

    return render(
        request,
        "admin/reference_overlay_form.html",
        ctx={
            "active_group": "operations",
            "active": "reference_overlays",
            "is_edit": False,
            "errors": [],
            "form_action": "/admin/reference-overlays/create",
            "form": {
                "symbol": "",
                "enabled": "1",
                "reference_type": "STOCK",
                "price_source": "MANUAL",
                "auto_source": "",
                "refresh_interval_sec": "300",
                "last_sync_at": "",
                "sync_status": "PENDING",
                "sync_error": "",
                "kind": "STOCK",
                "title": "",
                "title_i18n_zh": "",
                "title_i18n_en": "",
                "title_i18n_zh_TW": "",
                "title_i18n_ja": "",
                "source_label": "",
                "source_label_i18n_zh": "",
                "source_label_i18n_en": "",
                "source_label_i18n_zh_TW": "",
                "source_label_i18n_ja": "",
                "description": "",
                "description_i18n_zh": "",
                "description_i18n_en": "",
                "description_i18n_zh_TW": "",
                "description_i18n_ja": "",
                "line_title": "",
                "line_title_i18n_zh": "",
                "line_title_i18n_en": "",
                "line_title_i18n_zh_TW": "",
                "line_title_i18n_ja": "",
                "line_color": "#f0b90b",
                "badge_color": "#f0b90b",
                "display_value_label": "",
                "display_value_label_i18n_zh": "",
                "display_value_label_i18n_en": "",
                "display_value_label_i18n_zh_TW": "",
                "display_value_label_i18n_ja": "",
                "display_price": "",
                "display_unit": "USDT",
                "data_source": "MANUAL",
                "source_symbol": "",
                "source_region": "",
                "conversion_type": "",
                "conversion_factor": "",
                "sort_order": "0",
            },
        },
    )


@router.post("/reference-overlays/create")
def reference_overlay_create_submit(
    request: Request,
    symbol: str = Form(""),
    enabled: str = Form("1"),
    reference_type: str = Form("STOCK"),
    price_source: str = Form("MANUAL"),
    auto_source: str = Form(""),
    refresh_interval_sec: str = Form("300"),
    kind: str = Form("IRON"),
    title: str = Form(""),
    title_i18n_zh: str = Form(""),
    title_i18n_en: str = Form(""),
    title_i18n_zh_TW: str = Form(""),
    title_i18n_ja: str = Form(""),
    subtitle: str = Form(""),
    source_label_i18n_zh: str = Form(""),
    source_label_i18n_en: str = Form(""),
    source_label_i18n_zh_TW: str = Form(""),
    source_label_i18n_ja: str = Form(""),
    description: str = Form(""),
    description_i18n_zh: str = Form(""),
    description_i18n_en: str = Form(""),
    description_i18n_zh_TW: str = Form(""),
    description_i18n_ja: str = Form(""),
    line_title: str = Form(""),
    line_title_i18n_zh: str = Form(""),
    line_title_i18n_en: str = Form(""),
    line_title_i18n_zh_TW: str = Form(""),
    line_title_i18n_ja: str = Form(""),
    line_color: str = Form("#f0b90b"),
    badge_color: str = Form("#f0b90b"),
    display_value_label: str = Form(""),
    display_value_label_i18n_zh: str = Form(""),
    display_value_label_i18n_en: str = Form(""),
    display_value_label_i18n_zh_TW: str = Form(""),
    display_value_label_i18n_ja: str = Form(""),
    display_price: str = Form(""),
    display_unit: str = Form("USDT"),
    data_source: str = Form("MANUAL"),
    source_symbol: str = Form(""),
    source_region: str = Form(""),
    conversion_type: str = Form(""),
    conversion_factor: str = Form(""),
    sort_order: str = Form("0"),
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "trading_pairs.manage")
    if redir:
        return redir

    payload = {
        "symbol": symbol,
        "enabled": enabled,
        "reference_type": reference_type,
        "price_source": price_source,
        "auto_source": auto_source,
        "refresh_interval_sec": refresh_interval_sec,
        "sync_status": "PENDING",
        "sync_error": "",
        "kind": kind,
        "title": title,
        "title_i18n_zh": title_i18n_zh,
        "title_i18n_en": title_i18n_en,
        "title_i18n_zh_TW": title_i18n_zh_TW,
        "title_i18n_ja": title_i18n_ja,
        "subtitle": subtitle,
        "source_label_i18n_zh": source_label_i18n_zh,
        "source_label_i18n_en": source_label_i18n_en,
        "source_label_i18n_zh_TW": source_label_i18n_zh_TW,
        "source_label_i18n_ja": source_label_i18n_ja,
        "description": description,
        "description_i18n_zh": description_i18n_zh,
        "description_i18n_en": description_i18n_en,
        "description_i18n_zh_TW": description_i18n_zh_TW,
        "description_i18n_ja": description_i18n_ja,
        "line_title": line_title,
        "line_title_i18n_zh": line_title_i18n_zh,
        "line_title_i18n_en": line_title_i18n_en,
        "line_title_i18n_zh_TW": line_title_i18n_zh_TW,
        "line_title_i18n_ja": line_title_i18n_ja,
        "line_color": line_color,
        "badge_color": badge_color,
        "display_value_label": display_value_label,
        "display_value_label_i18n_zh": display_value_label_i18n_zh,
        "display_value_label_i18n_en": display_value_label_i18n_en,
        "display_value_label_i18n_zh_TW": display_value_label_i18n_zh_TW,
        "display_value_label_i18n_ja": display_value_label_i18n_ja,
        "display_price": display_price,
        "display_unit": display_unit,
        "data_source": data_source,
        "source_symbol": source_symbol,
        "source_region": source_region,
        "conversion_type": conversion_type,
        "conversion_factor": conversion_factor,
        "sort_order": sort_order,
    }
    result = admin_create_reference_overlay(db, payload)
    if not result["ok"]:
        return render(
            request,
            "admin/reference_overlay_form.html",
            ctx={
                "active_group": "operations",
                "active": "reference_overlays",
                "is_edit": False,
                "errors": result["errors"],
                "form_action": "/admin/reference-overlays/create",
                "form": result["form"],
            },
            status_code=400,
        )

    return RedirectResponse(
        url=_build_reference_overlays_redirect_url(notice="RWA参考价创建成功"),
        status_code=302,
    )


@router.get("/reference-overlays/{overlay_id}/edit", response_class=HTMLResponse)
def reference_overlay_edit_page(
    request: Request,
    overlay_id: int,
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return redir

    overlay = admin_get_reference_overlay(db, overlay_id)
    if not overlay:
        return RedirectResponse(
            url=_build_reference_overlays_redirect_url(error="RWA参考价不存"),
            status_code=302,
        )

    return render(
        request,
        "admin/reference_overlay_form.html",
        ctx={
            "active_group": "operations",
            "active": "reference_overlays",
            "is_edit": True,
            "errors": [],
            "form_action": f"/admin/reference-overlays/{overlay_id}/edit",
            "form": overlay,
        },
    )


@router.post("/reference-overlays/{overlay_id}/edit")
def reference_overlay_edit_submit(
    request: Request,
    overlay_id: int,
    enabled: str = Form("1"),
    reference_type: str = Form("STOCK"),
    price_source: str = Form("MANUAL"),
    auto_source: str = Form(""),
    refresh_interval_sec: str = Form("300"),
    kind: str = Form("IRON"),
    title: str = Form(""),
    title_i18n_zh: str = Form(""),
    title_i18n_en: str = Form(""),
    title_i18n_zh_TW: str = Form(""),
    title_i18n_ja: str = Form(""),
    subtitle: str = Form(""),
    source_label_i18n_zh: str = Form(""),
    source_label_i18n_en: str = Form(""),
    source_label_i18n_zh_TW: str = Form(""),
    source_label_i18n_ja: str = Form(""),
    description: str = Form(""),
    description_i18n_zh: str = Form(""),
    description_i18n_en: str = Form(""),
    description_i18n_zh_TW: str = Form(""),
    description_i18n_ja: str = Form(""),
    line_title: str = Form(""),
    line_title_i18n_zh: str = Form(""),
    line_title_i18n_en: str = Form(""),
    line_title_i18n_zh_TW: str = Form(""),
    line_title_i18n_ja: str = Form(""),
    line_color: str = Form("#f0b90b"),
    badge_color: str = Form("#f0b90b"),
    display_value_label: str = Form(""),
    display_value_label_i18n_zh: str = Form(""),
    display_value_label_i18n_en: str = Form(""),
    display_value_label_i18n_zh_TW: str = Form(""),
    display_value_label_i18n_ja: str = Form(""),
    display_price: str = Form(""),
    display_unit: str = Form("USDT"),
    data_source: str = Form("MANUAL"),
    source_symbol: str = Form(""),
    source_region: str = Form(""),
    conversion_type: str = Form(""),
    conversion_factor: str = Form(""),
    sort_order: str = Form("0"),
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "trading_pairs.manage")
    if redir:
        return redir

    overlay = admin_get_reference_overlay(db, overlay_id)
    if not overlay:
        return RedirectResponse(
            url=_build_reference_overlays_redirect_url(error="RWA参考价不存"),
            status_code=302,
        )

    payload = {
        "enabled": enabled,
        "reference_type": reference_type,
        "price_source": price_source,
        "auto_source": auto_source,
        "refresh_interval_sec": refresh_interval_sec,
        "kind": kind,
        "title": title,
        "title_i18n_zh": title_i18n_zh,
        "title_i18n_en": title_i18n_en,
        "title_i18n_zh_TW": title_i18n_zh_TW,
        "title_i18n_ja": title_i18n_ja,
        "subtitle": subtitle,
        "source_label_i18n_zh": source_label_i18n_zh,
        "source_label_i18n_en": source_label_i18n_en,
        "source_label_i18n_zh_TW": source_label_i18n_zh_TW,
        "source_label_i18n_ja": source_label_i18n_ja,
        "description": description,
        "description_i18n_zh": description_i18n_zh,
        "description_i18n_en": description_i18n_en,
        "description_i18n_zh_TW": description_i18n_zh_TW,
        "description_i18n_ja": description_i18n_ja,
        "line_title": line_title,
        "line_title_i18n_zh": line_title_i18n_zh,
        "line_title_i18n_en": line_title_i18n_en,
        "line_title_i18n_zh_TW": line_title_i18n_zh_TW,
        "line_title_i18n_ja": line_title_i18n_ja,
        "line_color": line_color,
        "badge_color": badge_color,
        "display_value_label": display_value_label,
        "display_value_label_i18n_zh": display_value_label_i18n_zh,
        "display_value_label_i18n_en": display_value_label_i18n_en,
        "display_value_label_i18n_zh_TW": display_value_label_i18n_zh_TW,
        "display_value_label_i18n_ja": display_value_label_i18n_ja,
        "display_price": display_price,
        "display_unit": display_unit,
        "data_source": data_source,
        "source_symbol": source_symbol,
        "source_region": source_region,
        "conversion_type": conversion_type,
        "conversion_factor": conversion_factor,
        "sort_order": sort_order,
    }
    result = admin_update_reference_overlay(db, overlay_id, payload)
    if not result["ok"]:
        if result.get("not_found"):
            return RedirectResponse(
                url=_build_reference_overlays_redirect_url(error="RWA参考价不存"),
                status_code=302,
            )
        overlay.update(result["form"])
        return render(
            request,
            "admin/reference_overlay_form.html",
            ctx={
                "active_group": "operations",
                "active": "reference_overlays",
                "is_edit": True,
                "errors": result["errors"],
                "form_action": f"/admin/reference-overlays/{overlay_id}/edit",
                "form": overlay,
            },
            status_code=400,
        )

    return RedirectResponse(
        url=_build_reference_overlays_redirect_url(notice="RWA参考价已保"),
        status_code=302,
    )


@router.post("/reference-overlays/{overlay_id}/toggle-enabled")
def reference_overlay_toggle_enabled(
    request: Request,
    overlay_id: int,
    next_path: str = Form("/admin/reference-overlays"),
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "trading_pairs.manage")
    if redir:
        return redir

    result = admin_toggle_reference_overlay_enabled(db, overlay_id)
    return RedirectResponse(
        url=_build_reference_overlays_redirect_url(
            notice=result.get("message", "") if result.get("ok") else "",
            error="" if result.get("ok") else result.get("message", "RWA参考价状态更新失"),
            next_path=next_path,
        ),
        status_code=302,
    )


@router.post("/reference-overlays/{overlay_id}/sync")
def reference_overlay_sync_once(
    request: Request,
    overlay_id: int,
    next_path: str = Form("/admin/reference-overlays"),
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "trading_pairs.manage")
    if redir:
        return redir

    overlay = admin_get_reference_overlay(db, overlay_id)
    if not overlay:
        return RedirectResponse(
            url=_build_reference_overlays_redirect_url(error="RWA参考价不存", next_path=next_path),
            status_code=302,
        )

    result = sync_reference_overlay_once(db, str(overlay.get("symbol") or ""))
    status = result.get("status")
    if status == "success":
        notice = "同步成功"
        error = ""
    elif status == "skipped":
        notice = "当前配置不需要同"
        error = ""
    else:
        notice = ""
        error = f"同步失败：{result.get('error') or '未知错误'}"

    return RedirectResponse(
        url=_build_reference_overlays_redirect_url(
            notice=notice,
            error=error,
            next_path=next_path,
        ),
        status_code=302,
    )


@router.get("/pairs/create", response_class=HTMLResponse)
def pair_create_page(
    request: Request,
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return redir

    return render(
        request,
        "admin/pair_form.html",
        ctx={
            "active_group": "trade",
            "active": "pair_config",
            "is_edit": False,
            "errors": [],
            "asset_options": admin_get_pair_asset_options(db),
            "form_action": "/admin/pairs/create",
            "form": {
                "symbol": "",
                "base_asset_id": "",
                "quote_asset_id": "",
                "market_mode": "INTERNAL",
                "asset_type": "CRYPTO",
                "display_category": "",
                "data_source": "INTERNAL",
                "external_symbol": "",
                "external_region": "",
                "show_spot_logo": "0",
                "spot_logo_url": "",
                "status": "1",
                "price_precision": "8",
                "amount_precision": "8",
                "min_amount": "0",
                "min_notional": "0",
            },
        },
    )


@router.post("/pairs/create")
def pair_create_submit(
    request: Request,
    symbol: str = Form(""),
    base_asset_id: str = Form(""),
    quote_asset_id: str = Form(""),
    market_mode: str = Form("INTERNAL"),
    asset_type: str = Form("CRYPTO"),
    display_category: str = Form(""),
    data_source: str = Form("INTERNAL"),
    external_symbol: str = Form(""),
    external_region: str = Form(""),
    show_spot_logo: str = Form("0"),
    spot_logo_url: str = Form(""),
    status: str = Form("1"),
    price_precision: str = Form("8"),
    amount_precision: str = Form("8"),
    min_amount: str = Form("0"),
    min_notional: str = Form("0"),
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "trading_pairs.manage")
    if redir:
        return redir

    result = admin_create_pair(
        db,
        {
            "symbol": symbol,
            "base_asset_id": base_asset_id,
            "quote_asset_id": quote_asset_id,
            "market_mode": market_mode,
            "asset_type": asset_type,
            "display_category": display_category,
            "data_source": data_source,
            "external_symbol": external_symbol,
            "external_region": external_region,
            "show_spot_logo": show_spot_logo,
            "spot_logo_url": spot_logo_url,
            "status": status,
            "price_precision": price_precision,
            "amount_precision": amount_precision,
            "min_amount": min_amount,
            "min_notional": min_notional,
        },
    )
    if not result["ok"]:
        return render(
            request,
            "admin/pair_form.html",
            ctx={
                "active_group": "trade",
                "active": "pair_config",
                "is_edit": False,
                "errors": result["errors"],
                "asset_options": admin_get_pair_asset_options(db),
                "form_action": "/admin/pairs/create",
                "form": result["form"],
            },
            status_code=400,
        )

    return RedirectResponse(
        url=_build_pairs_redirect_url(notice="现货交易对创建成"),
        status_code=302,
    )


@router.get("/pairs/{pair_id}/edit", response_class=HTMLResponse)
def pair_edit_page(
    request: Request,
    pair_id: int,
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return redir

    pair = admin_get_pair_detail(db, pair_id)
    if not pair:
        return RedirectResponse(
            url=_build_pairs_redirect_url(error="现货交易对不存在"),
            status_code=302,
        )

    return render(
        request,
        "admin/pair_form.html",
        ctx={
            "active_group": "trade",
            "active": "pair_config",
            "is_edit": True,
            "errors": [],
            "asset_options": [],
            "form_action": f"/admin/pairs/{pair_id}/edit",
            "form": pair,
        },
    )


@router.post("/pairs/{pair_id}/edit")
def pair_edit_submit(
    request: Request,
    pair_id: int,
    market_mode: str = Form("INTERNAL"),
    asset_type: str = Form("CRYPTO"),
    display_category: str = Form(""),
    data_source: str = Form("INTERNAL"),
    external_symbol: str = Form(""),
    external_region: str = Form(""),
    show_spot_logo: str = Form("0"),
    spot_logo_url: str = Form(""),
    status: str = Form("1"),
    price_precision: str = Form("8"),
    amount_precision: str = Form("8"),
    min_amount: str = Form("0"),
    min_notional: str = Form("0"),
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "trading_pairs.manage")
    if redir:
        return redir

    pair = admin_get_pair_detail(db, pair_id)
    if not pair:
        return RedirectResponse(
            url=_build_pairs_redirect_url(error="现货交易对不存在"),
            status_code=302,
        )

    result = admin_update_pair(
        db,
        pair_id,
        {
            "market_mode": market_mode,
            "asset_type": asset_type,
            "display_category": display_category,
            "data_source": data_source,
            "external_symbol": external_symbol,
            "external_region": external_region,
            "show_spot_logo": show_spot_logo,
            "spot_logo_url": spot_logo_url,
            "status": status,
            "price_precision": price_precision,
            "amount_precision": amount_precision,
            "min_amount": min_amount,
            "min_notional": min_notional,
        },
    )
    if not result["ok"]:
        if result.get("not_found"):
            return RedirectResponse(
                url=_build_pairs_redirect_url(error="现货交易对不存在"),
                status_code=302,
            )
        pair.update(result["form"])
        return render(
            request,
            "admin/pair_form.html",
            ctx={
                "active_group": "trade",
                "active": "pair_config",
                "is_edit": True,
                "errors": result["errors"],
                "asset_options": [],
                "form_action": f"/admin/pairs/{pair_id}/edit",
                "form": pair,
            },
            status_code=400,
        )

    return RedirectResponse(
        url=_build_pairs_redirect_url(notice="现货交易对更新成"),
        status_code=302,
    )


@router.post("/pairs/{pair_id}/toggle-status")
def pair_toggle_status(
    request: Request,
    pair_id: int,
    next_path: str = Form("/admin/pairs"),
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "trading_pairs.manage")
    if redir:
        return redir

    result = admin_toggle_pair_status(db, pair_id)
    return RedirectResponse(
        url=_build_pairs_redirect_url(
            notice=result["message"] if result["ok"] else "",
            error="" if result["ok"] else result["message"],
            next_path=next_path,
        ),
        status_code=302,
    )


@router.post("/pairs/{pair_id}/delete")
def pair_delete_submit(
    request: Request,
    pair_id: int,
    next_path: str = Form("/admin/pairs"),
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "trading_pairs.manage")
    if redir:
        return redir

    result = admin_delete_pair(db, pair_id)
    return RedirectResponse(
        url=_build_pairs_redirect_url(
            notice=result["message"] if result["ok"] else "",
            error="" if result["ok"] else result["message"],
            next_path=next_path,
        ),
        status_code=302,
    )


@router.get("/contract-symbols", response_class=HTMLResponse)
def contract_symbols_page(
    request: Request,
    symbol: str = "",
    category: str = "",
    provider: str = "",
    status: str = "",
    notice: str = "",
    error: str = "",
    page: int = 1,
    page_size: int = 20,
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return redir

    query_filters = {
        "symbol": symbol,
        "category": category,
        "provider": provider,
        "status": status,
        "page": page,
        "page_size": page_size,
    }
    result = admin_query_contract_symbols(db=db, filters=query_filters)
    return render(
        request,
        "admin/contract_symbols.html",
        ctx={
            "items": _result_items(result),
            "notice": notice,
            "error": error,
            "active_group": "trade",
            "active": "contract_symbols",
            "filters": {
                "symbol": symbol,
                "category": str(category or "").strip().upper(),
                "provider": str(provider or "").strip().upper(),
                "status": status,
            },
            "pagination": {
                "page": _result_page(result),
                "page_size": _result_page_size(result),
                "total": _result_total(result),
                "pages": _result_pages(result),
            },
        },
    )


_MARKET_PROVIDER_TEST_REASON_MESSAGES: Dict[str, str] = {
    "REGION_RESTRICTED": "当前访问地区受行情源限制，建议保持该行情源停用或切换备用源。",
    "COOLDOWN": "行情源暂时冷却中，系统稍后会自动重试。",
    "TIMEOUT": "连接超时，请稍后重试。",
    "RATE_LIMITED": "请求过于频繁，请稍后再测。",
    "AUTH_FAILED": "认证失败，请检查 API Key。",
    "SYMBOL_NOT_FOUND": "交易对或标的不存在，请检查 symbol 映射。",
    "DNS_FAILED": "域名解析失败，请检查行情源地址或网络。",
    "CONNECTION_FAILED": "连接失败，请检查网络或行情源地址。",
    "UNKNOWN": "测试失败，请联系技术查看日志。",
}


def _market_provider_display_label(items: list[Dict[str, Any]], provider_code: str = "") -> str:
    normalized = str(provider_code or "").strip().upper()
    if not normalized:
        return ""
    for item in items:
        if str(item.get("provider_code") or "").strip().upper() == normalized:
            return str(item.get("display_name") or item.get("provider_name") or normalized)
    return normalized


def _market_provider_test_feedback(test_result: str = "", reason: str = "", provider_label: str = "") -> tuple[str, str]:
    result = str(test_result or "").strip().lower()
    if not result:
        return "", ""
    prefix = f"{provider_label}：" if provider_label else ""
    if result == "success":
        return f"{prefix}测试成功，行情源连接正常。", ""
    normalized_reason = str(reason or "UNKNOWN").strip().upper()
    message = _MARKET_PROVIDER_TEST_REASON_MESSAGES.get(
        normalized_reason,
        _MARKET_PROVIDER_TEST_REASON_MESSAGES["UNKNOWN"],
    )
    return "", f"{prefix}{message}"


def _build_market_providers_redirect_url(
    notice: str = "",
    error: str = "",
    test_result: str = "",
    reason: str = "",
    provider: str = "",
) -> str:
    params: Dict[str, str] = {}
    if notice:
        params["notice"] = notice
    if error:
        params["error"] = error
    if test_result:
        params["test_result"] = test_result
    if reason:
        params["reason"] = reason
    if provider:
        params["provider"] = provider
    query = urlencode(params)
    return f"/admin/market-providers?{query}" if query else "/admin/market-providers"


@router.get("/market-providers", response_class=HTMLResponse)
def market_providers_page(
    request: Request,
    notice: str = "",
    error: str = "",
    test_result: str = "",
    reason: str = "",
    provider: str = "",
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return redir

    items = admin_list_contract_market_providers(db)
    provider_label = _market_provider_display_label(items, provider)
    test_notice, test_error = _market_provider_test_feedback(test_result, reason, provider_label)
    return render(
        request,
        "admin/market_providers.html",
        ctx={
            "items": items,
            "notice": notice or test_notice,
            "error": error or test_error,
            "active_group": "market_analysis",
            "active": "market_providers",
        },
    )


@router.post("/market-providers/{provider_code}/update")
def market_provider_update_submit(
    request: Request,
    provider_code: str,
    enabled: str = Form(""),
    priority: str = Form(""),
    base_url: str = Form(""),
    timeout_ms: str = Form(""),
    cooldown_seconds: str = Form(""),
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "contract_symbols.manage")
    if redir:
        return redir
    result = admin_update_contract_market_provider(
        db,
        provider_code,
        {
            "enabled": enabled,
            "priority": priority,
            "base_url": base_url,
            "timeout_ms": timeout_ms,
            "cooldown_seconds": cooldown_seconds,
        },
    )
    return RedirectResponse(
        url=_build_market_providers_redirect_url(
            notice="行情源配置已更新" if result.get("ok") else "",
            error="" if result.get("ok") else str(result.get("message") or "行情源配置更新失败"),
        ),
        status_code=302,
    )


@router.post("/market-providers/{provider_code}/test")
def market_provider_test_submit(
    request: Request,
    provider_code: str,
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "contract_symbols.manage")
    if redir:
        return redir
    result = test_contract_market_provider_connection(db, provider_code)
    ok = bool(result.get("ok"))
    reason = "" if ok else classify_market_provider_error(str(result.get("message") or ""))
    return RedirectResponse(
        url=_build_market_providers_redirect_url(
            test_result="success" if ok else "failed",
            reason=reason if not ok else "",
            provider=str(provider_code or "").strip().upper(),
        ),
        status_code=302,
    )


@router.get("/contract-accounts", response_class=HTMLResponse)
def contract_accounts_page(
    request: Request,
    user_id: str = "",
    margin_asset: str = "",
    has_position_margin: str = "",
    has_available_margin: str = "",
    page: int = 1,
    page_size: int = 20,
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return redir

    filters = {
        "user_id": user_id,
        "margin_asset": str(margin_asset or "").strip().upper(),
        "has_position_margin": has_position_margin,
        "has_available_margin": has_available_margin,
        "page": page,
        "page_size": page_size,
    }
    result = list_admin_contract_accounts(db=db, filters=filters)
    return render(
        request,
        "admin/contract_accounts.html",
        ctx={
            "items": _result_items(result),
            "active_group": "trade",
            "active": "contract_accounts",
            "filters": filters,
            "pagination": {
                "page": _result_page(result),
                "page_size": _result_page_size(result),
                "total": _result_total(result),
                "pages": _result_pages(result),
            },
        },
    )


@router.get("/contract-positions", response_class=HTMLResponse)
def contract_positions_page(
    request: Request,
    user_id: str = "",
    symbol: str = "",
    side: str = "",
    status: str = "",
    is_liquidatable: str = "",
    page: int = 1,
    page_size: int = 20,
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return redir

    filters = {
        "user_id": user_id,
        "symbol": str(symbol or "").strip().upper(),
        "side": str(side or "").strip().upper(),
        "status": str(status or "").strip().upper(),
        "is_liquidatable": is_liquidatable,
        "page": page,
        "page_size": page_size,
    }
    result = list_admin_contract_positions(db=db, filters=filters)
    return render(
        request,
        "admin/contract_positions.html",
        ctx={
            "items": _result_items(result),
            "active_group": "trade",
            "active": "contract_positions",
            "filters": filters,
            "pagination": {
                "page": _result_page(result),
                "page_size": _result_page_size(result),
                "total": _result_total(result),
                "pages": _result_pages(result),
            },
        },
    )


@router.get("/contract-orders", response_class=HTMLResponse)
def contract_orders_page(
    request: Request,
    query_scope: str = "recent",
    order_id: str = "",
    order_no: str = "",
    user_id: str = "",
    symbol: str = "",
    position_id: str = "",
    side: str = "",
    action: str = "",
    position_side: str = "",
    order_type: str = "",
    status: str = "",
    date_from: str = "",
    date_to: str = "",
    start_time: str = "",
    end_time: str = "",
    cursor_created_at: str = "",
    cursor_id: str = "",
    direction: str = "next",
    page: int = 1,
    page_size: int = 20,
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return redir

    query_scope_value = _clean_query_text(query_scope).lower() or "recent"
    order_id_value = _clean_query_text(order_id)
    order_no_value = _clean_query_text(order_no)
    user_id_value = _clean_query_text(user_id)
    symbol_value = _clean_query_text(symbol).upper()
    position_id_value = _clean_query_text(position_id)
    side_value = _clean_query_text(side).upper()
    action_value = _clean_query_text(action).upper()
    position_side_value = _clean_query_text(position_side).upper()
    order_type_value = _clean_query_text(order_type).upper()
    status_value = _clean_query_text(status).upper()
    range_from, range_to, query_notices, used_default_range = _balance_log_date_range(
        date_from_text=date_from,
        date_to_text=date_to,
        created_from_text=start_time,
        created_to_text=end_time,
    )
    start_time_value, end_time_value = get_admin_date_time_window(range_from, range_to)
    range_days = (range_to - range_from).days + 1
    has_precise_condition = _balance_log_has_precise_condition(
        user_id_value,
        order_id_value,
        order_no_value,
        position_id_value,
        symbol_value,
        status_value,
    )
    range_blocked = range_days > 30 and not has_precise_condition
    if range_blocked:
        query_notices.append(CONTRACT_ORDERS_RANGE_BLOCK_NOTICE)
        range_from, range_to = _narrow_admin_range_to_30_days(range_to)
        start_time_value, end_time_value = get_admin_date_time_window(range_from, range_to)
        range_days = 30
    active_range_days = range_days if range_days in {7, 15, 30} else (7 if used_default_range else 0)
    today = get_admin_today_date()
    quick_ranges = [
        {
            "days": days,
            "date_from": (today - timedelta(days=days - 1)).isoformat(),
            "date_to": today.isoformat(),
        }
        for days in (7, 15, 30)
    ]

    query_filters = {
        "query_scope": query_scope_value,
        "order_id": order_id_value,
        "order_no": order_no_value,
        "user_id": user_id_value,
        "symbol": symbol_value,
        "position_id": position_id_value,
        "side": side_value,
        "action": action_value,
        "position_side": position_side_value,
        "order_type": order_type_value,
        "status": status_value,
        "start_time": start_time_value,
        "end_time": end_time_value,
        "cursor_created_at": _clean_query_text(cursor_created_at),
        "cursor_id": _clean_query_text(cursor_id),
        "direction": _clean_query_text(direction).lower() or "next",
        "page": page,
        "page_size": page_size,
    }
    result = list_admin_contract_orders(db=db, filters=query_filters)
    performance_notice = result.get("performance_notice", "")
    if query_notices:
        performance_notice = f"{' '.join(query_notices)} {performance_notice}".strip()
    effective_start_time = result.get("effective_start_time")
    effective_end_time = result.get("effective_end_time")
    filters = {
        "query_scope": result.get("query_scope", query_scope_value),
        "order_id": order_id_value,
        "order_no": order_no_value,
        "user_id": user_id_value,
        "symbol": symbol_value,
        "position_id": position_id_value,
        "side": side_value,
        "action": action_value,
        "position_side": position_side_value,
        "order_type": order_type_value,
        "status": status_value,
        "start_time": _format_date_input(range_from),
        "end_time": _format_date_input(range_to),
        "date_from": _format_date_input(range_from),
        "date_to": _format_date_input(range_to),
    }
    pagination = {
        "page": _result_page(result),
        "page_size": _result_page_size(result),
        "total": _result_total(result),
        "pages": result.get("total_pages") or result.get("pages") or 1,
        "total_pages": result.get("total_pages") or result.get("pages") or 1,
        "has_next": result.get("has_next", False),
        "has_prev": result.get("has_prev", False),
        "pagination_mode": result.get("pagination_mode", "page"),
        "is_page_limited": result.get("is_page_limited", False),
        "next_cursor_created_at": result.get("next_cursor_created_at", ""),
        "next_cursor_id": result.get("next_cursor_id", ""),
        "prev_cursor_created_at": result.get("prev_cursor_created_at", ""),
        "prev_cursor_id": result.get("prev_cursor_id", ""),
    }
    return render(
        request,
        "admin/contract_orders.html",
        ctx={
            "items": _result_items(result),
            "active_group": "trade",
            "active": "contract_orders",
            "filters": filters,
            "pagination": pagination,
            "performance_notice": performance_notice,
            "large_table_notice": CONTRACT_ORDERS_LARGE_TABLE_NOTICE,
            "quick_ranges": quick_ranges,
            "active_range_days": active_range_days,
            "is_limited_range": result.get("is_limited_range", False),
            "query_scope": result.get("query_scope", query_scope_value),
        },
    )


@router.get("/contract-trades", response_class=HTMLResponse)
def contract_trades_page(
    request: Request,
    query_scope: str = "recent",
    trade_id: str = "",
    trade_no: str = "",
    user_id: str = "",
    symbol: str = "",
    order_id: str = "",
    position_id: str = "",
    side: str = "",
    action: str = "",
    position_side: str = "",
    order_type: str = "",
    date_from: str = "",
    date_to: str = "",
    start_time: str = "",
    end_time: str = "",
    cursor_created_at: str = "",
    cursor_id: str = "",
    direction: str = "next",
    page: int = 1,
    page_size: int = 20,
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return redir

    query_scope_value = _clean_query_text(query_scope).lower() or "recent"
    trade_id_value = _clean_query_text(trade_id)
    trade_no_value = _clean_query_text(trade_no)
    user_id_value = _clean_query_text(user_id)
    symbol_value = _clean_query_text(symbol).upper()
    order_id_value = _clean_query_text(order_id)
    position_id_value = _clean_query_text(position_id)
    side_value = _clean_query_text(side).upper()
    action_value = _clean_query_text(action).upper()
    position_side_value = _clean_query_text(position_side).upper()
    order_type_value = _clean_query_text(order_type).upper()
    range_from, range_to, query_notices, used_default_range = _balance_log_date_range(
        date_from_text=date_from,
        date_to_text=date_to,
        created_from_text=start_time,
        created_to_text=end_time,
    )
    start_time_value, end_time_value = get_admin_date_time_window(range_from, range_to)
    range_days = (range_to - range_from).days + 1
    has_precise_condition = _balance_log_has_precise_condition(
        user_id_value,
        trade_id_value,
        trade_no_value,
        order_id_value,
        position_id_value,
        symbol_value,
    )
    range_blocked = range_days > 30 and not has_precise_condition
    if range_blocked:
        query_notices.append(CONTRACT_TRADES_RANGE_BLOCK_NOTICE)
        range_from, range_to = _narrow_admin_range_to_30_days(range_to)
        start_time_value, end_time_value = get_admin_date_time_window(range_from, range_to)
        range_days = 30
    active_range_days = range_days if range_days in {7, 15, 30} else (7 if used_default_range else 0)
    today = get_admin_today_date()
    quick_ranges = [
        {
            "days": days,
            "date_from": (today - timedelta(days=days - 1)).isoformat(),
            "date_to": today.isoformat(),
        }
        for days in (7, 15, 30)
    ]

    query_filters = {
        "query_scope": query_scope_value,
        "trade_id": trade_id_value,
        "trade_no": trade_no_value,
        "user_id": user_id_value,
        "symbol": symbol_value,
        "order_id": order_id_value,
        "position_id": position_id_value,
        "side": side_value,
        "action": action_value,
        "position_side": position_side_value,
        "order_type": order_type_value,
        "start_time": start_time_value,
        "end_time": end_time_value,
        "cursor_created_at": _clean_query_text(cursor_created_at),
        "cursor_id": _clean_query_text(cursor_id),
        "direction": _clean_query_text(direction).lower() or "next",
        "page": page,
        "page_size": page_size,
    }
    result = list_admin_contract_trades(db=db, filters=query_filters)
    performance_notice = result.get("performance_notice", "")
    if query_notices:
        performance_notice = f"{' '.join(query_notices)} {performance_notice}".strip()
    effective_start_time = result.get("effective_start_time")
    effective_end_time = result.get("effective_end_time")
    filters = {
        "query_scope": result.get("query_scope", query_scope_value),
        "trade_id": trade_id_value,
        "trade_no": trade_no_value,
        "user_id": user_id_value,
        "symbol": symbol_value,
        "order_id": order_id_value,
        "position_id": position_id_value,
        "side": side_value,
        "action": action_value,
        "position_side": position_side_value,
        "order_type": order_type_value,
        "start_time": _format_date_input(range_from),
        "end_time": _format_date_input(range_to),
        "date_from": _format_date_input(range_from),
        "date_to": _format_date_input(range_to),
    }
    pagination = {
        "page": _result_page(result),
        "page_size": _result_page_size(result),
        "total": _result_total(result),
        "pages": result.get("total_pages") or result.get("pages") or 1,
        "total_pages": result.get("total_pages") or result.get("pages") or 1,
        "has_next": result.get("has_next", False),
        "has_prev": result.get("has_prev", False),
        "pagination_mode": result.get("pagination_mode", "page"),
        "is_page_limited": result.get("is_page_limited", False),
        "next_cursor_created_at": result.get("next_cursor_created_at", ""),
        "next_cursor_id": result.get("next_cursor_id", ""),
        "prev_cursor_created_at": result.get("prev_cursor_created_at", ""),
        "prev_cursor_id": result.get("prev_cursor_id", ""),
    }
    return render(
        request,
        "admin/contract_trades.html",
        ctx={
            "items": _result_items(result),
            "active_group": "trade",
            "active": "contract_trades",
            "filters": filters,
            "pagination": pagination,
            "performance_notice": performance_notice,
            "large_table_notice": CONTRACT_TRADES_LARGE_TABLE_NOTICE,
            "quick_ranges": quick_ranges,
            "active_range_days": active_range_days,
            "is_limited_range": result.get("is_limited_range", False),
            "query_scope": result.get("query_scope", query_scope_value),
        },
    )


@router.get("/market-analysis", response_class=HTMLResponse)
def market_analysis_page(request: Request):
    redir = require_admin(request)
    if redir:
        return redir

    target = "/admin/market-analysis/pairs"
    if request.url.query:
        target = f"{target}?{request.url.query}"
    return RedirectResponse(target, status_code=303)


@router.get("/market-analysis/pairs", response_class=HTMLResponse)
def market_analysis_pairs_page(
    request: Request,
    range_key: str = "today",
    market_type: str = "all",
    keyword: str = "",
    sort_by: str = "turnover",
    page: int = 1,
    page_size: int = 50,
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return redir

    range_key_value = _clean_query_text(range_key).lower() or "today"
    market_type_value = _clean_query_text(market_type).lower() or "all"
    keyword_value = _clean_query_text(keyword).upper()
    sort_by_value = _clean_query_text(sort_by).lower() or "turnover"
    result = admin_query_market_analysis_pairs(
        db=db,
        range_key=range_key_value,
        market_type=market_type_value,
        keyword=keyword_value,
        sort_by=sort_by_value,
        page=page,
        page_size=page_size,
    )
    filters = _result_filters(result)
    pagination = _result_pagination(result)
    pagination["has_prev"] = pagination.get("page", 1) > 1
    pagination["has_next"] = pagination.get("page", 1) < pagination.get("pages", 1)
    return render(
        request,
        "admin/market_analysis_pairs.html",
        ctx={
            "items": _result_items(result),
            "summary": _result_summary(result),
            "filters": filters,
            "pagination": pagination,
            "active_group": "market_analysis",
            "active": "market_analysis_pairs",
            "performance_notice": result.get("performance_notice", ""),
            "range_options": [
                {"value": "today", "label": "今日"},
                {"value": "yesterday", "label": "昨日"},
                {"value": "7d", "label": "7日"},
                {"value": "30d", "label": "30日"},
            ],
            "market_type_options": [
                {"value": "all", "label": "全部"},
                {"value": "spot", "label": "现货"},
                {"value": "rwa", "label": "RWA"},
                {"value": "contract", "label": "合约"},
                {"value": "stock_cfd", "label": "股票合约"},
                {"value": "cfd", "label": "CFD"},
            ],
            "sort_options": [
                {"value": "turnover", "label": "成交"},
                {"value": "trade_count", "label": "交易笔数"},
                {"value": "fee", "label": "手续"},
                {"value": "pnl", "label": "平台盈亏"},
                {"value": "users", "label": "交易人数"},
            ],
        },
    )


@router.get("/contract-liquidations", response_class=HTMLResponse)
def contract_liquidations_page(
    request: Request,
    user_id: str = "",
    symbol: str = "",
    position_id: str = "",
    side: str = "",
    status: str = "",
    start_time: str = "",
    end_time: str = "",
    date_from: str = "",
    date_to: str = "",
    page: int = 1,
    page_size: int = 20,
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "trading_pairs.manage")
    if redir:
        return redir

    user_id_value = _clean_query_text(user_id)
    symbol_value = _clean_query_text(symbol).upper()
    position_id_value = _clean_query_text(position_id)
    side_value = _clean_query_text(side).upper()
    status_value = _clean_query_text(status).upper()
    start_time_value, start_time_text, _ = _parse_trade_date_query(start_time or date_from)
    end_time_value, end_time_text, _ = _parse_trade_date_query(end_time or date_to, is_end=True)
    query_filters = {
        "user_id": user_id_value or None,
        "symbol": symbol_value or None,
        "position_id": position_id_value or None,
        "side": side_value or None,
        "status": status_value or None,
        "start_time": start_time_value,
        "end_time": end_time_value,
        "date_from": start_time_value,
        "date_to": end_time_value,
        "page": page,
        "page_size": page_size,
    }
    result = list_admin_contract_liquidations(db=db, filters=query_filters)
    effective_start_time = result.get("effective_start_time") or start_time_value
    effective_end_time = result.get("effective_end_time") or end_time_value
    filters = {
        "user_id": user_id_value,
        "symbol": symbol_value,
        "position_id": position_id_value,
        "side": side_value,
        "status": status_value,
        "start_time": _format_datetime_local(effective_start_time) or start_time_text,
        "end_time": _format_datetime_local(effective_end_time) or end_time_text,
        "date_from": _format_date_input(effective_start_time),
        "date_to": _format_date_input(effective_end_time),
    }
    return render(
        request,
        "admin/contract_liquidations.html",
        ctx={
            "items": _result_items(result),
            "active_group": "trade",
            "active": "contract_liquidations",
            "filters": filters,
            "pagination": {
                "page": _result_page(result),
                "page_size": _result_page_size(result),
                "total": _result_total(result),
                "pages": _result_pages(result),
            },
            "summary": result.get("summary", {}),
            "performance_notice": result.get("performance_notice", ""),
        },
    )


def _default_contract_symbol_form() -> Dict[str, str]:
    return {
        "symbol": "",
        "display_name": "",
        "category": "CRYPTO",
        "provider": "BINANCE",
        "provider_symbol": "",
        "quote_asset": "USDT",
        "tp_sl_trigger_price_type": "MARK_PRICE",
        "price_precision": "8",
        "quantity_precision": "8",
        "min_quantity": "",
        "max_quantity": "",
        "min_margin": "",
        "max_leverage": "100",
        "spread_x": "0.0",
        "liquidation_threshold": "",
        "warning_threshold": "",
        "status": "1",
    }


def _contract_symbol_form_options() -> Dict[str, list[str]]:
    return {
        "category_options": ["CRYPTO", "STOCK", "INDEX", "FOREX", "METAL", "GOLD", "COMMODITY", "FUTURES"],
        "provider_options": ["BINANCE", "ITICK", "INTERNAL"],
        "tp_sl_trigger_price_type_options": ["MARK_PRICE", "LAST_PRICE"],
    }


@router.get("/contract-symbols/new", response_class=HTMLResponse)
def contract_symbol_create_page(request: Request):
    redir = require_admin(request)
    if redir:
        return redir

    return render(
        request,
        "admin/contract_symbol_form.html",
        ctx={
            "active_group": "trade",
            "active": "contract_symbols",
            "is_edit": False,
            "errors": [],
            "form_action": "/admin/contract-symbols/new",
            "form": _default_contract_symbol_form(),
            **_contract_symbol_form_options(),
        },
    )


@router.post("/contract-symbols/new")
def contract_symbol_create_submit(
    request: Request,
    symbol: str = Form(""),
    display_name: str = Form(""),
    category: str = Form("CRYPTO"),
    provider: str = Form("BINANCE"),
    provider_symbol: str = Form(""),
    quote_asset: str = Form("USDT"),
    tp_sl_trigger_price_type: str = Form("MARK_PRICE"),
    price_precision: str = Form("8"),
    quantity_precision: str = Form("8"),
    min_quantity: str = Form(""),
    max_quantity: str = Form(""),
    min_margin: str = Form(""),
    max_leverage: str = Form("100"),
    spread_x: str = Form("0.0"),
    liquidation_threshold: str = Form(""),
    warning_threshold: str = Form(""),
    status: str = Form("1"),
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "contract_symbols.manage")
    if redir:
        return redir

    result = admin_create_contract_symbol(
        db,
        {
            "symbol": symbol,
            "display_name": display_name,
            "category": category,
            "provider": provider,
            "provider_symbol": provider_symbol,
            "quote_asset": quote_asset,
            "tp_sl_trigger_price_type": tp_sl_trigger_price_type,
            "price_precision": price_precision,
            "quantity_precision": quantity_precision,
            "min_quantity": min_quantity,
            "max_quantity": max_quantity,
            "min_margin": min_margin,
            "max_leverage": max_leverage,
            "spread_x": spread_x,
            "liquidation_threshold": liquidation_threshold,
            "warning_threshold": warning_threshold,
            "status": status,
        },
    )
    if not result["ok"]:
        return render(
            request,
            "admin/contract_symbol_form.html",
            ctx={
                "active_group": "trade",
                "active": "contract_symbols",
                "is_edit": False,
                "errors": result["errors"],
                "form_action": "/admin/contract-symbols/new",
                "form": result["form"],
                **_contract_symbol_form_options(),
            },
            status_code=400,
        )

    return RedirectResponse(
        url=_build_contract_symbols_redirect_url(notice="合约品种创建成功"),
        status_code=302,
    )


@router.get("/contract-symbols/{symbol_id}/edit", response_class=HTMLResponse)
def contract_symbol_edit_page(
    request: Request,
    symbol_id: int,
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return redir

    item = admin_get_contract_symbol(db, symbol_id)
    if not item:
        return RedirectResponse(
            url=_build_contract_symbols_redirect_url(error="合约品种不存"),
            status_code=302,
        )

    return render(
        request,
        "admin/contract_symbol_form.html",
        ctx={
            "active_group": "trade",
            "active": "contract_symbols",
            "is_edit": True,
            "errors": [],
            "form_action": f"/admin/contract-symbols/{symbol_id}/edit",
            "form": item,
            **_contract_symbol_form_options(),
        },
    )


@router.post("/contract-symbols/{symbol_id}/edit")
def contract_symbol_edit_submit(
    request: Request,
    symbol_id: int,
    display_name: str = Form(""),
    category: str = Form("CRYPTO"),
    provider: str = Form("BINANCE"),
    provider_symbol: str = Form(""),
    quote_asset: str = Form("USDT"),
    tp_sl_trigger_price_type: str = Form("MARK_PRICE"),
    price_precision: str = Form("8"),
    quantity_precision: str = Form("8"),
    min_quantity: str = Form(""),
    max_quantity: str = Form(""),
    min_margin: str = Form(""),
    max_leverage: str = Form("100"),
    spread_x: str = Form("0.0"),
    liquidation_threshold: str = Form(""),
    warning_threshold: str = Form(""),
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "contract_symbols.manage")
    if redir:
        return redir

    result = admin_update_contract_symbol(
        db,
        symbol_id,
        {
            "display_name": display_name,
            "category": category,
            "provider": provider,
            "provider_symbol": provider_symbol,
            "quote_asset": quote_asset,
            "tp_sl_trigger_price_type": tp_sl_trigger_price_type,
            "price_precision": price_precision,
            "quantity_precision": quantity_precision,
            "min_quantity": min_quantity,
            "max_quantity": max_quantity,
            "min_margin": min_margin,
            "max_leverage": max_leverage,
            "spread_x": spread_x,
            "liquidation_threshold": liquidation_threshold,
            "warning_threshold": warning_threshold,
        },
    )
    if not result["ok"]:
        if result.get("not_found"):
            return RedirectResponse(
                url=_build_contract_symbols_redirect_url(error="合约品种不存"),
                status_code=302,
            )
        return render(
            request,
            "admin/contract_symbol_form.html",
            ctx={
                "active_group": "trade",
                "active": "contract_symbols",
                "is_edit": True,
                "errors": result["errors"],
                "form_action": f"/admin/contract-symbols/{symbol_id}/edit",
                "form": result["form"],
                **_contract_symbol_form_options(),
            },
            status_code=400,
        )

    return RedirectResponse(
        url=_build_contract_symbols_redirect_url(notice="合约品种更新成功"),
        status_code=302,
    )


@router.post("/contract-symbols/{symbol_id}/toggle")
def contract_symbol_toggle_status(
    request: Request,
    symbol_id: int,
    next_path: str = Form("/admin/contract-symbols"),
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "contract_symbols.manage")
    if redir:
        return redir

    result = admin_toggle_contract_symbol_status(db, symbol_id)
    return RedirectResponse(
        url=_build_contract_symbols_redirect_url(
            notice=result["message"] if result["ok"] else "",
            error="" if result["ok"] else result["message"],
            next_path=next_path,
        ),
        status_code=302,
    )


@router.get("/stock-token-lock-configs", response_class=HTMLResponse)
def stock_token_lock_configs_page(
    request: Request,
    lock_symbol: str = "",
    trade_symbol: str = "",
    is_active: str = "",
    notice: str = "",
    error: str = "",
    page: int = 1,
    page_size: int = 20,
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return redir

    query_filters = {
        "lock_symbol": lock_symbol,
        "trade_symbol": trade_symbol,
        "is_active": is_active,
        "page": page,
        "page_size": page_size,
    }
    result = admin_query_stock_token_lock_configs(db=db, filters=query_filters)
    return render(
        request,
        "admin/stock_token_lock_configs.html",
        ctx={
            "items": _result_items(result),
            "notice": notice,
            "error": error,
            "active_group": "funds",
            "active": "stock_token_lock_configs",
            "filters": {
                "lock_symbol": lock_symbol,
                "trade_symbol": trade_symbol,
                "is_active": is_active,
            },
            "pagination": {
                "page": _result_page(result),
                "page_size": _result_page_size(result),
                "total": _result_total(result),
                "pages": _result_pages(result),
            },
        },
    )


@router.get("/stock-token-lock-configs/new", response_class=HTMLResponse)
def stock_token_lock_config_create_page(
    request: Request,
):
    redir = require_admin(request)
    if redir:
        return redir

    return render(
        request,
        "admin/stock_token_lock_config_form.html",
        ctx={
            "active_group": "funds",
            "active": "stock_token_lock_configs",
            "is_edit": False,
            "errors": [],
            "form_action": "/admin/stock-token-lock-configs/new",
            "form": {
                "lock_symbol": "",
                "trade_symbol": "",
                "display_name": "",
                "lock_days": "90",
                "daily_release_rate": "0.05000000",
                "conversion_rate": "1.000000000000000000",
                "is_active": "1",
                "remark": "",
                "lock_symbols_locked": False,
            },
        },
    )


@router.post("/stock-token-lock-configs/new")
def stock_token_lock_config_create_submit(
    request: Request,
    lock_symbol: str = Form(""),
    trade_symbol: str = Form(""),
    display_name: str = Form(""),
    lock_days: str = Form("90"),
    daily_release_rate: str = Form("0.05000000"),
    conversion_rate: str = Form("1.000000000000000000"),
    is_active: str = Form("1"),
    remark: str = Form(""),
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "stock_locks.manage")
    if redir:
        return redir

    result = admin_create_stock_token_lock_config(
        db,
        {
            "lock_symbol": lock_symbol,
            "trade_symbol": trade_symbol,
            "display_name": display_name,
            "lock_days": lock_days,
            "daily_release_rate": daily_release_rate,
            "conversion_rate": conversion_rate,
            "is_active": is_active,
            "remark": remark,
        },
    )
    if not result["ok"]:
        return render(
            request,
            "admin/stock_token_lock_config_form.html",
            ctx={
                "active_group": "funds",
                "active": "stock_token_lock_configs",
                "is_edit": False,
                "errors": result["errors"],
                "form_action": "/admin/stock-token-lock-configs/new",
                "form": result["form"],
            },
            status_code=400,
        )

    return RedirectResponse(
        url=_build_stock_token_lock_config_redirect_url(notice="股票锁仓配置已创"),
        status_code=302,
    )


@router.get("/stock-token-lock-configs/{config_id}/edit", response_class=HTMLResponse)
def stock_token_lock_config_edit_page(
    request: Request,
    config_id: int,
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return redir

    config = admin_get_stock_token_lock_config(db, config_id)
    if not config:
        return RedirectResponse(
            url=_build_stock_token_lock_config_redirect_url(error="股票锁仓配置不存"),
            status_code=302,
        )

    return render(
        request,
        "admin/stock_token_lock_config_form.html",
        ctx={
            "active_group": "funds",
            "active": "stock_token_lock_configs",
            "is_edit": True,
            "errors": [],
            "form_action": f"/admin/stock-token-lock-configs/{config_id}/edit",
            "form": config,
        },
    )


@router.post("/stock-token-lock-configs/{config_id}/edit")
def stock_token_lock_config_edit_submit(
    request: Request,
    config_id: int,
    lock_symbol: str = Form(""),
    trade_symbol: str = Form(""),
    display_name: str = Form(""),
    lock_days: str = Form("90"),
    daily_release_rate: str = Form("0.05000000"),
    conversion_rate: str = Form("1.000000000000000000"),
    is_active: str = Form("1"),
    remark: str = Form(""),
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "stock_locks.manage")
    if redir:
        return redir

    result = admin_update_stock_token_lock_config(
        db,
        config_id,
        {
            "lock_symbol": lock_symbol,
            "trade_symbol": trade_symbol,
            "display_name": display_name,
            "lock_days": lock_days,
            "daily_release_rate": daily_release_rate,
            "conversion_rate": conversion_rate,
            "is_active": is_active,
            "remark": remark,
        },
    )
    if not result["ok"]:
        if result.get("not_found"):
            return RedirectResponse(
                url=_build_stock_token_lock_config_redirect_url(error="股票锁仓配置不存"),
                status_code=302,
            )
        return render(
            request,
            "admin/stock_token_lock_config_form.html",
            ctx={
                "active_group": "funds",
                "active": "stock_token_lock_configs",
                "is_edit": True,
                "errors": result["errors"],
                "form_action": f"/admin/stock-token-lock-configs/{config_id}/edit",
                "form": result["form"],
            },
            status_code=400,
        )

    return RedirectResponse(
        url=_build_stock_token_lock_config_redirect_url(notice="股票锁仓配置已更"),
        status_code=302,
    )


@router.post("/stock-token-lock-configs/{config_id}/toggle-active")
def stock_token_lock_config_toggle_active(
    request: Request,
    config_id: int,
    next_path: str = Form("/admin/stock-token-lock-configs"),
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "stock_locks.manage")
    if redir:
        return redir

    result = admin_toggle_stock_token_lock_config_active(db, config_id)
    return RedirectResponse(
        url=_build_stock_token_lock_config_redirect_url(
            notice=result["message"] if result["ok"] else "",
            error="" if result["ok"] else result["message"],
            next_path=next_path,
        ),
        status_code=302,
    )


@router.get("/stock-token-locks", response_class=HTMLResponse)
def stock_token_locks_page(
    request: Request,
    user_id: str = "",
    lock_symbol: str = "",
    status: str = "",
    notice: str = "",
    error: str = "",
    page: int = 1,
    page_size: int = 20,
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return redir

    query_filters = {
        "user_id": user_id,
        "lock_symbol": lock_symbol,
        "status": status,
        "page": page,
        "page_size": page_size,
    }
    result = admin_query_stock_token_locks(db=db, filters=query_filters)
    return render(
        request,
        "admin/stock_token_locks.html",
        ctx={
            "items": _result_items(result),
            "notice": notice,
            "error": error,
            "active_group": "funds",
            "active": "stock_token_locks",
            "filters": {
                "user_id": user_id,
                "lock_symbol": lock_symbol,
                "status": status,
            },
            "pagination": {
                "page": _result_page(result),
                "page_size": _result_page_size(result),
                "total": _result_total(result),
                "pages": _result_pages(result),
            },
        },
    )


@router.post("/stock-token-locks/release")
def stock_token_locks_release_submit(
    request: Request,
    next_path: str = Form("/admin/stock-token-locks"),
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "stock_locks.manage")
    if redir:
        return redir

    try:
        result = release_stock_token_locks(db, limit=500)
        record_stock_token_release_log(
            db,
            trigger_type="MANUAL",
            status="SUCCESS",
            result=result,
            message="后台手动股票锁仓释放任务完成",
        )
        db.commit()
        notice = (
            f"释放任务完成：扫描批次={result['scanned_count']}，"
            f"释放批次={result['released_count']}，释放总量={result['total_release_amount']}"
        )
        error = ""
    except Exception as exc:
        db.rollback()
        try:
            record_stock_token_release_log(
                db,
                trigger_type="MANUAL",
                status="FAILED",
                result={
                    "scanned_count": 0,
                    "released_count": 0,
                    "total_release_amount": 0,
                    "item_ids": [],
                },
                message="后台手动股票锁仓释放任务失败",
                error_message=str(exc),
            )
            db.commit()
        except Exception:
            db.rollback()
        notice = ""
        error = f"释放任务失败：{exc}"

    return RedirectResponse(
        url=_build_stock_token_locks_redirect_url(
            notice=notice,
            error=error,
            next_path=next_path,
        ),
        status_code=302,
    )


@router.get("/stock-token-locks/{lock_item_id}", response_class=HTMLResponse)
def stock_token_lock_detail_page(
    request: Request,
    lock_item_id: int,
    notice: str = "",
    error: str = "",
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return redir

    detail = admin_get_stock_token_lock_detail(db, lock_item_id)
    if detail is None:
        return RedirectResponse(
            url=_build_stock_token_locks_redirect_url(error="股票锁仓批次不存"),
            status_code=302,
        )

    return render(
        request,
        "admin/stock_token_lock_detail.html",
        ctx={
            "item": detail,
            "notice": notice,
            "error": error,
            "active_group": "funds",
            "active": "stock_token_locks",
            "filters": {},
            "pagination": _default_pagination(),
        },
    )


@router.post("/stock-token-locks/{lock_item_id}/force-release")
def stock_token_lock_force_release_submit(
    request: Request,
    lock_item_id: int,
    next_path: str = Form(""),
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "stock_locks.manage")
    if redir:
        return redir

    detail_path = next_path or f"/admin/stock-token-locks/{lock_item_id}"
    try:
        result = force_release_stock_token_lock(db, lock_item_id)
        record_stock_token_release_log(
            db,
            trigger_type="FORCE",
            status="SUCCESS",
            result=result,
            message=f"admin forced stock token lock release: {lock_item_id}",
        )
        db.commit()
        notice = (
            f"强制释放完成：释放批次={result['released_count']}，"
            f"释放总量={result['total_release_amount']}"
        )
        error = ""
    except StockTokenLockError as exc:
        db.rollback()
        notice = ""
        error = str(exc)
    except Exception as exc:
        db.rollback()
        notice = ""
        error = f"强制释放失败：{exc}"

    return RedirectResponse(
        url=_build_stock_token_locks_redirect_url(
            notice=notice,
            error=error,
            next_path=detail_path,
        ),
        status_code=302,
    )


@router.get("/stock-token-release-logs", response_class=HTMLResponse)
def stock_token_release_logs_page(
    request: Request,
    trigger_type: str = "",
    status: str = "",
    start_date: str = "",
    end_date: str = "",
    page: int = 1,
    page_size: int = 20,
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return redir

    trigger_type_value = str(trigger_type or "").strip().upper()
    status_value = str(status or "").strip().upper()
    range_from, range_to, query_notices, used_default_range = _balance_log_date_range(
        date_from_text=start_date,
        date_to_text=end_date,
        created_from_text="",
        created_to_text="",
    )
    range_days = (range_to - range_from).days + 1
    if range_days > 30 and not _balance_log_has_precise_condition(status_value):
        query_notices.append(STOCK_TOKEN_RELEASE_LOGS_RANGE_BLOCK_NOTICE)
        range_from, range_to = _narrow_admin_range_to_30_days(range_to)
        range_days = 30
    active_range_days = range_days if range_days in {7, 15, 30} else (7 if used_default_range else 0)
    today = get_admin_today_date()
    quick_ranges = [
        {
            "days": days,
            "date_from": (today - timedelta(days=days - 1)).isoformat(),
            "date_to": today.isoformat(),
        }
        for days in (7, 15, 30)
    ]

    query_filters = {
        "trigger_type": trigger_type_value,
        "status": status_value,
        "start_date": range_from.isoformat(),
        "end_date": range_to.isoformat(),
        "page": page,
        "page_size": page_size,
    }
    result = admin_query_stock_token_release_logs(db=db, filters=query_filters)
    return render(
        request,
        "admin/stock_token_release_logs.html",
        ctx={
            "items": _result_items(result),
            "active_group": "system",
            "active": "stock_token_release_logs",
            "filters": {
                "trigger_type": trigger_type_value,
                "status": status_value,
                "start_date_text": range_from.isoformat(),
                "end_date_text": range_to.isoformat(),
            },
            "large_table_notice": STOCK_TOKEN_RELEASE_LOGS_LARGE_TABLE_NOTICE,
            "query_notice": " ".join(query_notices),
            "quick_ranges": quick_ranges,
            "active_range_days": active_range_days,
            "pagination": {
                "page": _result_page(result),
                "page_size": _result_page_size(result),
                "total": _result_total(result),
                "pages": _result_pages(result),
            },
        },
    )


@router.get("/platform-accounts", response_class=HTMLResponse)
@router.get("/platform-account", response_class=HTMLResponse)
def platform_account_page(
    request: Request,
    coin_symbol: str = "",
    chain_key: str = "",
    has_balance: str = "1",
    has_frozen: str = "",
    page: int = 1,
    page_size: int = 20,
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return redir

    query_filters = {
        "platform_user_id": PLATFORM_ACCOUNT_USER_ID,
        "coin_symbol": coin_symbol,
        "chain_key": chain_key,
        "has_balance": has_balance,
        "has_frozen": has_frozen,
        "page": page,
        "page_size": page_size,
    }
    result = admin_query_platform_balances(db=db, filters=query_filters)
    pagination = {
        "page": _result_page(result),
        "page_size": _result_page_size(result),
        "total": _result_total(result),
        "pages": _result_pages(result),
    }
    filters = {
        "coin_symbol": coin_symbol,
        "chain_key": chain_key,
        "has_balance": has_balance,
        "has_frozen": has_frozen,
    }
    return render(
        request,
        "admin/platform_account.html",
        ctx={
            "items": _result_items(result),
            "platform_user_id": result["platform_user_id"],
            "active_group": "trade",
            "active": "platform_dealer",
            "filters": filters,
            "pagination": pagination,
        },
    )


@router.get("/platform-adjust", response_class=HTMLResponse)
@router.get("/platform/adjust", response_class=HTMLResponse)
def platform_adjust_page(
    request: Request,
    coin_symbol: str = "",
    chain_key: str = "spot",
    notice: str = "",
    error: str = "",
    page: int = 1,
    page_size: int = 20,
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return redir

    coin_symbol = _normalize_coin_symbol_value(coin_symbol)
    chain_key = _normalize_chain_key_value(chain_key, "spot")

    return render(
        request,
        "admin/platform_adjust.html",
        ctx=_build_platform_adjust_page_context(
            db=db,
            coin_symbol=coin_symbol,
            chain_key=chain_key,
            page=page,
            page_size=page_size,
            notice=notice,
            error=error,
        ),
    )


@router.post("/platform/adjust")
def platform_adjust_submit(
    request: Request,
    coin_symbol: str = Form(""),
    chain_key: str = Form("spot"),
    direction: str = Form("INCREASE"),
    amount: str = Form(""),
    reason: str = Form(""),
    remark: str = Form(""),
    confirm_text: str = Form(""),
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "platform_adjust.manage")
    if redir:
        return redir

    admin = get_admin_from_request(request)
    form = {
        "coin_symbol": _normalize_coin_symbol_value(coin_symbol),
        "chain_key": _normalize_chain_key_value(chain_key, "spot"),
        "direction": str(direction or "").strip().upper() or "INCREASE",
        "amount": str(amount or "").strip(),
        "reason": str(reason or "").strip(),
        "remark": str(remark or "").strip(),
        "confirm_text": str(confirm_text or "").strip(),
    }

    if not admin or not str(admin.get("username") or "").strip():
        return render(
            request,
            "admin/platform_adjust.html",
            ctx=_build_platform_adjust_page_context(
                db=db,
                coin_symbol=form["coin_symbol"],
                chain_key=form["chain_key"],
                form=form,
                errors=["Unable to identify admin identity, please login again before submitting adjustment"],
            ),
            status_code=403,
        )

    validation_errors = []
    if len(form["reason"]) < 4:
        validation_errors.append("Adjustment reason cannot be empty and must be at most 64 characters")
    if form["confirm_text"] != "CONFIRM":
        validation_errors.append("请在安全确认中输入 CONFIRM 后再提交")
    if validation_errors:
        form["confirm_text"] = ""
        return render(
            request,
            "admin/platform_adjust.html",
            ctx=_build_platform_adjust_page_context(
                db=db,
                coin_symbol=form["coin_symbol"],
                chain_key=form["chain_key"],
                form=form,
                errors=validation_errors,
            ),
            status_code=400,
        )

    try:
        request_id = uuid.uuid4().hex
        result = adjust_platform_available_balance(
            db,
            admin_user=str(admin.get("username") or "").strip(),
            target_user_id=PLATFORM_ACCOUNT_USER_ID,
            coin_symbol=form["coin_symbol"],
            chain_key=form["chain_key"],
            direction=form["direction"],
            amount=form["amount"],
            reason=form["reason"],
            remark=form["remark"],
            admin_ip=get_client_ip(request),
            user_agent=get_user_agent(request),
            request_id=request_id,
        )
    except AdminBalanceAdjustError as exc:
        return render(
            request,
            "admin/platform_adjust.html",
            ctx=_build_platform_adjust_page_context(
                db=db,
                coin_symbol=form["coin_symbol"],
                chain_key=form["chain_key"],
                form=form,
                errors=[str(exc)],
            ),
            status_code=400,
        )

    return RedirectResponse(
        url=_build_platform_redirect_url(
            next_path=f"/admin/platform/adjust?coin_symbol={quote(result['coin_symbol'])}&chain_key={quote(result['chain_key'])}",
            notice="平台调账提交成功",
        ),
        status_code=302,
    )


@router.get("/platform/adjust-logs", response_class=HTMLResponse)
@router.get("/platform/adjust/logs", response_class=HTMLResponse)
@router.get("/platform-adjust-logs", response_class=HTMLResponse)
def platform_adjust_logs_page(
    request: Request,
    coin_symbol: str = "",
    chain_key: str = "",
    admin_user: str = "",
    date_from: str = "",
    date_to: str = "",
    page: int = 1,
    page_size: int = 20,
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return redir

    coin_symbol = _normalize_coin_symbol_value(coin_symbol)
    chain_key = _normalize_chain_key_value(chain_key)
    admin_user = str(admin_user or "").strip()
    date_from_text = str(date_from or "").strip()
    date_to_text = str(date_to or "").strip()
    date_from_value = _parse_admin_query_date(date_from_text)
    date_to_value = _parse_admin_query_date(date_to_text)

    query_filters = {
        "coin_symbol": coin_symbol,
        "chain_key": chain_key,
        "admin_user": admin_user,
        "date_from": date_from_value,
        "date_to": date_to_value,
        "page": page,
        "page_size": page_size,
    }
    result = admin_query_platform_adjust_logs(db=db, filters=query_filters)
    pagination = {
        "page": _result_page(result),
        "page_size": _result_page_size(result),
        "total": _result_total(result),
        "pages": _result_pages(result),
    }
    filters = {
        "coin_symbol": coin_symbol,
        "chain_key": chain_key,
        "admin_user": admin_user,
        "date_from": date_from_text if date_from_value else "",
        "date_to": date_to_text if date_to_value else "",
    }
    return render(
        request,
        "admin/platform_adjust_logs.html",
        ctx={
            "items": _result_items(result),
            "active_group": "funds",
            "active": "platform_adjust_logs",
            "filters": filters,
            "pagination": pagination,
        },
    )


@router.get("/vip/users", response_class=HTMLResponse)
def vip_users_page(
    request: Request,
    user_id: str = "",
    vip_level_code: str = "",
    svip_level_code: str = "",
    effective_level_code: str = "",
    page: int = 1,
    page_size: int = 20,
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "trading_pairs.manage")
    if redir:
        return redir
    result = admin_query_vip_users(
        db,
        {
            "user_id": user_id,
            "vip_level_code": vip_level_code,
            "svip_level_code": svip_level_code,
            "effective_level_code": effective_level_code,
            "page": page,
            "page_size": page_size,
        },
    )
    return render(
        request,
        "admin/vip_users.html",
        ctx={
            "items": _result_items(result),
            "filters": _result_filters(result),
            "pagination": {
                "page": _result_page(result),
                "page_size": _result_page_size(result),
                "total": _result_total(result),
                "pages": _result_pages(result),
            },
            "stats": result.get("stats") or {},
            "active_group": "users",
            "active": "vip_users",
        },
    )


@router.get("/vip/levels", response_class=HTMLResponse)
def vip_levels_page(
    request: Request,
    vip_type: str = "",
    level_code: str = "",
    is_enabled: str = "",
    page: int = 1,
    page_size: int = 20,
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "trading_pairs.manage")
    if redir:
        return redir
    result = admin_query_vip_levels(
        db,
        {"vip_type": vip_type, "level_code": level_code, "is_enabled": is_enabled, "page": page, "page_size": page_size},
    )
    return render(
        request,
        "admin/vip_levels.html",
        ctx={
            "items": _result_items(result),
            "filters": _result_filters(result),
            "pagination": {
                "page": _result_page(result),
                "page_size": _result_page_size(result),
                "total": _result_total(result),
                "pages": _result_pages(result),
            },
            "stats": result.get("stats") or {},
            "active_group": "users",
            "active": "vip_levels",
        },
    )


@router.get("/vip/fee-preferences", response_class=HTMLResponse)
def vip_fee_preferences_page(
    request: Request,
    user_id: str = "",
    use_rcb_fee: str = "",
    page: int = 1,
    page_size: int = 20,
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "trading_pairs.manage")
    if redir:
        return redir
    result = admin_query_vip_fee_preferences(db, {"user_id": user_id, "use_rcb_fee": use_rcb_fee, "page": page, "page_size": page_size})
    return render(
        request,
        "admin/vip_fee_preferences.html",
        ctx={
            "items": _result_items(result),
            "filters": _result_filters(result),
            "pagination": {
                "page": _result_page(result),
                "page_size": _result_page_size(result),
                "total": _result_total(result),
                "pages": _result_pages(result),
            },
            "stats": result.get("stats") or {},
            "active_group": "users",
            "active": "vip_fee_preferences",
        },
    )


@router.get("/bd/applications", response_class=HTMLResponse)
def bd_applications_page(
    request: Request,
    user_id: str = "",
    status: str = "",
    apply_level: str = "",
    created_from: str = "",
    created_to: str = "",
    notice: str = "",
    error: str = "",
    page: int = 1,
    page_size: int = 20,
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return redir

    filters = {
        "user_id": str(user_id or "").strip(),
        "status": str(status or "").strip().upper(),
        "apply_level": str(apply_level or "").strip().upper(),
        "created_from": _parse_dividend_date_value(created_from),
        "created_to": _parse_dividend_date_value(created_to),
        "created_from_text": str(created_from or "").strip(),
        "created_to_text": str(created_to or "").strip(),
        "page": page,
        "page_size": page_size,
    }
    result = admin_query_bd_applications(db, filters)
    result_filters = _result_filters(result)
    result_filters["created_from_text"] = filters["created_from_text"]
    result_filters["created_to_text"] = filters["created_to_text"]

    return render(
        request,
        "admin/bd_applications.html",
        ctx={
            "items": _result_items(result),
            "active_group": "users",
            "active": "bd_applications",
            "filters": result_filters,
            "stats": result.get("stats") or {},
            "notice": notice,
            "error": error,
            "pagination": {
                "page": _result_page(result),
                "page_size": _result_page_size(result),
                "total": _result_total(result),
                "pages": _result_pages(result),
            },
        },
    )


@router.post("/bd/applications/{application_id}/approve")
def bd_application_approve(
    request: Request,
    application_id: int,
    admin_remark: str = Form(""),
    commission_rate: str = Form(""),
    next_path: str = Form("/admin/bd/applications"),
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "bd_accounts.manage")
    if redir:
        return redir

    try:
        approve_bd_application(
            db,
            application_id=application_id,
            reviewed_by=0,
            admin_remark=admin_remark,
            commission_rate_override=commission_rate,
        )
        db.commit()
        notice = f"BD application {application_id} approved"
        error = ""
    except BdApplicationReviewError as exc:
        db.rollback()
        notice = ""
        error = str(exc)
    except Exception as exc:
        db.rollback()
        notice = ""
        error = f"Approve BD application failed: {exc}"

    return RedirectResponse(
        url=_build_bd_application_redirect_url(next_path=next_path, notice=notice, error=error),
        status_code=302,
    )


@router.post("/bd/applications/{application_id}/reject")
def bd_application_reject(
    request: Request,
    application_id: int,
    admin_remark: str = Form(""),
    next_path: str = Form("/admin/bd/applications"),
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "bd_accounts.manage")
    if redir:
        return redir

    if not str(admin_remark or "").strip():
        return RedirectResponse(
            url=_build_bd_application_redirect_url(next_path=next_path, error="拒绝原因不能为空"),
            status_code=302,
        )

    try:
        reject_bd_application(
            db,
            application_id=application_id,
            reviewed_by=0,
            admin_remark=admin_remark,
        )
        db.commit()
        notice = f"BD application {application_id} rejected"
        error = ""
    except BdApplicationReviewError as exc:
        db.rollback()
        notice = ""
        error = str(exc)
    except Exception as exc:
        db.rollback()
        notice = ""
        error = f"Reject BD application failed: {exc}"

    return RedirectResponse(
        url=_build_bd_application_redirect_url(next_path=next_path, notice=notice, error=error),
        status_code=302,
    )


@router.post("/bd/applications/{application_id}/revoke")
def bd_application_revoke(
    request: Request,
    application_id: int,
    next_path: str = Form("/admin/bd/applications"),
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "bd_accounts.manage")
    if redir:
        return redir

    try:
        result = admin_revoke_bd_application_account(db, application_id)
        if result.get("ok"):
            db.commit()
            notice = str(result.get("message") or "已取消该用户BD资格")
            error = ""
        else:
            db.rollback()
            notice = ""
            error = str(result.get("message") or "取消BD资格失败")
    except Exception as exc:
        db.rollback()
        notice = ""
        error = f"取消BD资格失败：{exc}"

    return RedirectResponse(
        url=_build_bd_application_redirect_url(next_path=next_path, notice=notice, error=error),
        status_code=302,
    )


@router.post("/bd/applications/{application_id}/restore")
def bd_application_restore(
    request: Request,
    application_id: int,
    next_path: str = Form("/admin/bd/applications"),
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "bd_accounts.manage")
    if redir:
        return redir

    try:
        result = admin_restore_bd_application_account(db, application_id)
        if result.get("ok"):
            db.commit()
            notice = str(result.get("message") or "已恢复该用户BD资格")
            error = ""
        else:
            db.rollback()
            notice = ""
            error = str(result.get("message") or "恢复BD资格失败")
    except Exception as exc:
        db.rollback()
        notice = ""
        error = f"恢复BD资格失败：{exc}"

    return RedirectResponse(
        url=_build_bd_application_redirect_url(next_path=next_path, notice=notice, error=error),
        status_code=302,
    )


@router.get("/bd/commissions", response_class=HTMLResponse)
def bd_commissions_page(
    request: Request,
    status: str = "",
    bd_user_id: str = "",
    user_id: str = "",
    fee_coin_symbol: str = "",
    notice: str = "",
    error: str = "",
    page: int = 1,
    page_size: int = 20,
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "bd_accounts.manage")
    if redir:
        return redir

    filters = {
        "status": str(status or "").strip().upper(),
        "bd_user_id": str(bd_user_id or "").strip(),
        "user_id": str(user_id or "").strip(),
        "fee_coin_symbol": _normalize_coin_symbol_value(fee_coin_symbol),
    }
    result = get_bd_commission_records(
        db,
        page=page,
        page_size=page_size,
        status=filters["status"],
        bd_user_id=filters["bd_user_id"],
        user_id=filters["user_id"],
        fee_coin_symbol=filters["fee_coin_symbol"],
    )
    return render(
        request,
        "admin/bd_commissions.html",
        ctx={
            "items": _result_items(result),
            "records": _result_records(result),
            "summary": result.get("summary", {}),
            "notice": notice,
            "error": error,
            "active_group": "users",
            "active": "bd_commissions",
            "filters": filters,
            "stats": result.get("stats") or {},
            "pagination": {
                "page": _result_page(result),
                "page_size": _result_page_size(result),
                "total": _result_total(result),
                "pages": _result_pages(result),
            },
        },
    )


@router.get("/invite/commissions", response_class=HTMLResponse)
def user_invite_commissions_page(
    request: Request,
    inviter_user_id: str = "",
    invitee_user_id: str = "",
    status: str = "",
    fee_coin_symbol: str = "",
    date_from: str = "",
    date_to: str = "",
    notice: str = "",
    error: str = "",
    page: int = 1,
    page_size: int = 20,
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return redir

    normalized_status = str(status or "").strip().upper()
    if normalized_status == "ALL":
        normalized_status = ""
    normalized_fee_coin_symbol = _normalize_coin_symbol_value(fee_coin_symbol)
    if normalized_fee_coin_symbol == "ALL":
        normalized_fee_coin_symbol = ""
    date_from_text = str(date_from or "").strip()
    date_to_text = str(date_to or "").strip()
    parsed_date_from = _parse_dividend_date_value(date_from_text)
    parsed_date_to = _parse_dividend_date_value(date_to_text)
    page_error = str(error or "").strip()
    if date_from_text and parsed_date_from is None:
        page_error = page_error or "开始日期格式无效，请使用 YYYY-MM-DD"
    if date_to_text and parsed_date_to is None:
        page_error = page_error or "结束日期格式无效，请使用 YYYY-MM-DD"

    filters = {
        "inviter_user_id": str(inviter_user_id or "").strip(),
        "invitee_user_id": str(invitee_user_id or "").strip(),
        "status": normalized_status,
        "fee_coin_symbol": normalized_fee_coin_symbol,
        "date_from": date_from_text,
        "date_to": date_to_text,
    }
    result = get_user_invite_commission_records(
        db,
        inviter_user_id=filters["inviter_user_id"],
        invitee_user_id=filters["invitee_user_id"],
        status=filters["status"],
        fee_coin_symbol=filters["fee_coin_symbol"],
        date_from=parsed_date_from,
        date_to=parsed_date_to,
        page=page,
        page_size=page_size,
    )
    summary = get_user_invite_commission_summary(db)
    invite_commission_config = get_user_invite_commission_config(db)
    return render(
        request,
        "admin/user_invite_commissions.html",
        ctx={
            "items": _result_items(result),
            "records": _result_records(result),
            "summary": summary,
            "invite_commission_config": invite_commission_config,
            "invite_commission_percent_input": _invite_commission_percent_input(invite_commission_config),
            "notice": notice,
            "error": page_error,
            "active_group": "users",
            "active": "user_invite_commissions",
            "filters": filters,
            "pagination": {
                "page": _result_page(result),
                "page_size": _result_page_size(result),
                "total": _result_total(result),
                "pages": _result_pages(result),
            },
        },
    )


INVITE_RELATIONS_INLINE_TEMPLATE = """
{% extends "admin/layout.html" %}
{% block title %}邀请关系{% endblock %}
{% block page_title %}邀请关系{% endblock %}
{% block page_subtitle %}
  <div class="page-subtitle">基于 user_invite_relations 表查询普通邀请绑定关系，仅用于后台只读核查。</div>
{% endblock %}
{% block content %}
  <section class="page-section">
    <div class="filter-card">
      <div class="section-title">筛选条件</div>
      <form method="get" action="/admin/invite/relations" class="filter-form">
        <div class="field"><label for="inviter_user_id">邀请人</label><input id="inviter_user_id" name="inviter_user_id" value="{{ filters.inviter_user_id or '' }}" /></div>
        <div class="field"><label for="invitee_user_id">被邀请人</label><input id="invitee_user_id" name="invitee_user_id" value="{{ filters.invitee_user_id or '' }}" /></div>
        <div class="field"><label for="invite_code">邀请码</label><input id="invite_code" name="invite_code" value="{{ filters.invite_code or '' }}" /></div>
        <div class="field">
          <label for="status">状态</label>
          <select id="status" name="status">
            <option value="" {% if not filters.status %}selected{% endif %}>全部</option>
            <option value="ACTIVE" {% if filters.status == 'ACTIVE' %}selected{% endif %}>ACTIVE</option>
            <option value="DISABLED" {% if filters.status == 'DISABLED' %}selected{% endif %}>DISABLED</option>
          </select>
        </div>
        <div class="filter-actions">
          <button type="submit" class="btn">查询</button>
          <a href="/admin/invite/relations" class="btn secondary">重置</a>
        </div>
      </form>
    </div>
  </section>
  <section class="page-section">
    <div class="table-card">
      <div class="section-title">邀请关系列表</div>
      {% if items %}
        <div class="table-wrap admin-table-wrap">
          <table class="data-table admin-table">
            <thead>
              <tr>
                <th>ID</th><th>邀请人</th><th>被邀请人</th><th>邀请码</th><th class="text-right">分成比例</th><th>状态</th><th>创建时间</th><th>更新时间</th>
              </tr>
            </thead>
            <tbody>
              {% for item in items %}
                <tr>
                  <td>{{ item.id }}</td>
                  <td>{{ item.inviter_user_id }}</td>
                  <td>{{ item.invitee_user_id }}</td>
                  <td class="mono">{{ item.invite_code }}</td>
                  <td class="text-right">{{ item.commission_rate_percent }}</td>
                  <td><span class="admin-badge admin-badge-{{ item.status_badge }}">{{ item.status }}</span></td>
                  <td class="nowrap">{{ item.created_at }}</td>
                  <td class="nowrap">{{ item.updated_at }}</td>
                </tr>
              {% endfor %}
            </tbody>
          </table>
        </div>
      {% else %}
        <div class="empty-state admin-empty">暂无符合条件的邀请关系</div>
      {% endif %}
      <div class="pagination">
        <div>共 {{ pagination.total }} 条，当前第 {{ pagination.page }} / {{ pagination.pages }} 页</div>
        <div class="pagination-actions">
          {% if pagination.page > 1 %}
            <a href="{{ request.url.include_query_params(page=pagination.page - 1, page_size=pagination.page_size) }}" class="btn secondary">上一页</a>
          {% endif %}
          {% if pagination.page < pagination.pages %}
            <a href="{{ request.url.include_query_params(page=pagination.page + 1, page_size=pagination.page_size) }}" class="btn secondary">下一页</a>
          {% endif %}
        </div>
      </div>
    </div>
  </section>
{% endblock %}
"""


@router.get("/invite/relations", response_class=HTMLResponse)
def user_invite_relations_page(
    request: Request,
    inviter_user_id: str = "",
    invitee_user_id: str = "",
    invite_code: str = "",
    status: str = "",
    page: int = 1,
    page_size: int = 20,
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "contract_symbols.manage")
    if redir:
        return redir

    filters = {
        "inviter_user_id": str(inviter_user_id or "").strip(),
        "invitee_user_id": str(invitee_user_id or "").strip(),
        "invite_code": str(invite_code or "").strip(),
        "status": str(status or "").strip().upper(),
        "page": page,
        "page_size": page_size,
    }
    result = admin_query_user_invite_relations(db, filters)
    return render(
        request,
        "admin/user_invite_relations.html",
        ctx={
            "items": _result_items(result),
            "active_group": "users",
            "active": "user_invite_relations",
            "filters": _result_filters(result),
            "pagination": {
                "page": _result_page(result),
                "page_size": _result_page_size(result),
                "total": _result_total(result),
                "pages": _result_pages(result),
            },
        },
    )


@router.get("/bd/teams", response_class=HTMLResponse)
@router.get("/bd/team", response_class=HTMLResponse)
def bd_team_page(
    request: Request,
    status: str = "",
    bd_user_id: str = "",
    page: int = 1,
    page_size: int = 20,
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return redir

    filters = {
        "status": str(status or "").strip().upper(),
        "bd_user_id": str(bd_user_id or "").strip(),
    }
    result = get_admin_bd_team_stats(
        db,
        page=page,
        page_size=page_size,
        status=filters["status"],
        bd_user_id=filters["bd_user_id"],
    )

    return render(
        request,
        "admin/bd_team_stats.html",
        ctx={
            "items": _result_items(result),
            "active_group": "users",
            "active": "bd_team_stats",
            "filters": filters,
            "stats": result.get("stats") or {},
            "pagination": {
                "page": _result_page(result),
                "page_size": _result_page_size(result),
                "total": _result_total(result),
                "pages": _result_pages(result),
            },
        },
    )


@router.get("/bd/teams/{bd_user_id}", response_class=HTMLResponse)
def bd_team_detail_page(
    request: Request,
    bd_user_id: int,
    date: str = "",
    range: str = "",
    start_date: str = "",
    end_date: str = "",
    page: int = 1,
    page_size: int = 20,
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return redir

    result = admin_query_bd_team_detail(
        db,
        bd_user_id,
        {
            "date": str(date or "").strip(),
            "range": str(range or "").strip(),
            "start_date": str(start_date or "").strip(),
            "end_date": str(end_date or "").strip(),
            "page": page,
            "page_size": page_size,
        },
    )
    if not result.get("account_exists"):
        raise HTTPException(status_code=404, detail="BD account not found")

    return render(
        request,
        "admin/bd_team_detail.html",
        ctx={
            "items": _result_items(result),
            "active_group": "users",
            "active": "bd_team_stats",
            "filters": _result_filters(result),
            "summary": _result_summary(result),
            "account": result.get("account") or {},
            "pagination": {
                "page": _result_page(result),
                "page_size": _result_page_size(result),
                "total": _result_total(result),
                "pages": _result_pages(result),
            },
        },
    )


def _build_bd_team_redirect_url(next_path: str, notice: str = "", error: str = "") -> str:
    base = next_path if str(next_path or "").startswith("/admin/bd/team") else "/admin/bd/team"
    parts = urlsplit(base)
    query = dict(parse_qsl(parts.query, keep_blank_values=True))
    if notice:
        query["notice"] = notice
    if error:
        query["error"] = error
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query), parts.fragment))


@router.post("/bd/accounts/{bd_user_id}/disable")
def bd_account_disable(
    request: Request,
    bd_user_id: int,
    next_path: str = Form("/admin/bd/team"),
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "bd_accounts.manage")
    if redir:
        return redir

    try:
        update_bd_account_status(db, bd_user_id, active=False)
        db.commit()
        notice = "bd_disabled"
        error = ""
    except BdAccountStatusUpdateError as exc:
        db.rollback()
        notice = ""
        error = str(exc)
    except Exception as exc:
        db.rollback()
        notice = ""
        error = f"BD disable failed: {exc}"

    return RedirectResponse(
        url=_build_bd_team_redirect_url(next_path, notice=notice, error=error),
        status_code=302,
    )


@router.post("/bd/accounts/{bd_user_id}/enable")
def bd_account_enable(
    request: Request,
    bd_user_id: int,
    next_path: str = Form("/admin/bd/team"),
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "bd_accounts.manage")
    if redir:
        return redir

    try:
        update_bd_account_status(db, bd_user_id, active=True)
        db.commit()
        notice = "bd_enabled"
        error = ""
    except BdAccountStatusUpdateError as exc:
        db.rollback()
        notice = ""
        error = str(exc)
    except Exception as exc:
        db.rollback()
        notice = ""
        error = f"BD enable failed: {exc}"

    return RedirectResponse(
        url=_build_bd_team_redirect_url(next_path, notice=notice, error=error),
        status_code=302,
    )


@router.post("/invite/commissions/config")
def user_invite_commission_config_save(
    request: Request,
    commission_percent: str = Form(""),
    next_path: str = Form("/admin/invite/commissions"),
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "invite_commissions.manage")
    if redir:
        return redir

    admin = get_admin_from_request(request) or {}
    admin_id = None
    try:
        admin_id = int(admin.get("id")) if admin.get("id") is not None else None
    except (TypeError, ValueError):
        admin_id = None

    try:
        rate = update_user_invite_commission_rate(
            db,
            commission_percent,
            updated_by_admin_id=admin_id,
        )
        db.commit()
        percent = (rate * Decimal("100")).quantize(Decimal("0.01"))
        notice = f"普通用户邀请分成比例已更新为 {format(percent.normalize(), 'f')}%"
        error = ""
    except Exception as exc:
        db.rollback()
        notice = ""
        error = f"保存普通用户邀请分成比例失败：{exc}"

    return RedirectResponse(
        url=_build_user_invite_commission_redirect_url(
            next_path=next_path,
            notice=notice,
            error=error,
        ),
        status_code=302,
    )


@router.post("/invite/commissions/{record_id}/pay")
def user_invite_commission_pay(
    request: Request,
    record_id: int,
    next_path: str = Form("/admin/invite/commissions"),
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "invite_commissions.manage")
    if redir:
        return redir

    try:
        record = pay_user_invite_commission_record(db, record_id=record_id)
        db.commit()
        status_value = str(record.status or "").upper()
        if status_value == "PAID":
            notice = f"User invite commission record {record_id} paid"
            error = ""
        elif status_value == "FAILED":
            notice = ""
            error = f"User invite commission record {record_id} payout failed: {record.fail_reason or 'FAILED'}"
        else:
            notice = ""
            error = f"User invite commission record {record_id} is not pending"
    except Exception as exc:
        db.rollback()
        notice = ""
        error = f"普通邀请分成发放失败：{exc}"

    return RedirectResponse(
        url=_build_user_invite_commission_redirect_url(
            next_path=next_path,
            notice=notice,
            error=error,
        ),
        status_code=302,
    )


@router.post("/invite/commissions/pay-pending")
def user_invite_commissions_pay_pending(
    request: Request,
    limit: int = Form(100),
    next_path: str = Form("/admin/invite/commissions"),
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "invite_commissions.manage")
    if redir:
        return redir

    batch_limit = min(max(int(limit or 100), 1), 500)
    try:
        record_ids = [
            int(record_id)
            for (record_id,) in (
                db.query(UserInviteCommissionRecord.id)
                .filter(UserInviteCommissionRecord.status == "PENDING")
                .order_by(UserInviteCommissionRecord.id.asc())
                .limit(batch_limit)
                .all()
            )
        ]
        job_ids = []
        enqueue_errors = []
        for pending_record_id in record_ids:
            try:
                job_ids.append(
                    enqueue_pay_user_invite_commission(
                        pending_record_id,
                        trigger_type="ADMIN_BATCH",
                    )
                )
            except Exception as enqueue_exc:
                enqueue_errors.append({"record_id": pending_record_id, "error": str(enqueue_exc)})

        notice = f"Submitted invite commission payout jobs: {len(job_ids)} records. Refresh later for results."
        error = ""
        if enqueue_errors:
            error = "Failed to submit records: " + "; ".join(
                f"{item.get('record_id')}: {item.get('error')}" for item in enqueue_errors[:10]
            )
    except Exception as exc:
        db.rollback()
        notice = ""
        error = f"批量提交普通邀请分成发放任务失败：{exc}"

    return RedirectResponse(
        url=_build_user_invite_commission_redirect_url(
            next_path=next_path,
            notice=notice,
            error=error,
        ),
        status_code=302,
    )


@router.post("/bd/commissions/{record_id}/pay")
def bd_commission_pay(
    request: Request,
    record_id: int,
    next_path: str = Form("/admin/bd/commissions"),
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "bd_commissions.manage")
    if redir:
        return redir

    try:
        original_status = (
            db.query(BdCommissionRecord.status)
            .filter(BdCommissionRecord.id == int(record_id))
            .scalar()
        )
        if str(original_status or "").upper() != "PENDING":
            raise ValueError(f"BD commission record {record_id} is not pending")

        record = pay_bd_commission_record(db, record_id)
        db.commit()
        status_value = str(record.status or "").upper()
        if status_value == "PAID":
            commission_asset_symbol = str(record.commission_asset_symbol or "RCB").upper().strip() or "RCB"
            notice = f"BD commission record {record_id} paid: {record.commission_amount} {commission_asset_symbol}"
            error = ""
        else:
            notice = ""
            error = f"BD commission record {record_id} is not pending"
    except Exception as exc:
        db.rollback()
        notice = ""
        error = f"BD commission payout failed: {exc}"

    return RedirectResponse(
        url=_build_bd_commission_redirect_url(
            next_path=next_path,
            notice=notice,
            error=error,
        ),
        status_code=302,
    )


@router.post("/bd/commissions/pay-pending")
def bd_commissions_pay_pending(
    request: Request,
    limit: int = Form(100),
    next_path: str = Form("/admin/bd/commissions"),
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "bd_commissions.manage")
    if redir:
        return redir

    batch_limit = min(max(int(limit or 100), 1), 500)
    try:
        pending_records = (
            db.query(
                BdCommissionRecord.id,
                BdCommissionRecord.commission_amount,
                BdCommissionRecord.commission_asset_symbol,
            )
            .filter(BdCommissionRecord.status == "PENDING")
            .order_by(BdCommissionRecord.id.asc())
            .limit(batch_limit)
            .all()
        )
        record_ids = [int(record_id) for (record_id, _amount, _symbol) in pending_records]
        submitted_totals: dict[str, Decimal] = {}
        for _record_id, amount, symbol in pending_records:
            normalized_symbol = str(symbol or "RCB").upper().strip() or "RCB"
            submitted_totals[normalized_symbol] = (
                submitted_totals.get(normalized_symbol, Decimal("0")) + Decimal(str(amount or 0))
            )
        job_ids = []
        enqueue_errors = []
        for pending_record_id in record_ids:
            try:
                job_ids.append(
                    enqueue_pay_bd_commission(
                        pending_record_id,
                        trigger_type="ADMIN_BATCH",
                    )
                )
            except Exception as enqueue_exc:
                enqueue_errors.append({"record_id": pending_record_id, "error": str(enqueue_exc)})

        totals_text = " / ".join(
            f"{format(total, 'f')} {symbol}" for symbol, total in sorted(submitted_totals.items())
        ) or "0"
        notice = (
            f"Submitted BD commission payout jobs: {len(job_ids)} records, "
            f"pending totals: {totals_text}. Refresh later for results."
        )
        error = ""
        if enqueue_errors:
            error = "Failed to submit records: " + "; ".join(
                f"{item.get('record_id')}: {item.get('error')}" for item in enqueue_errors[:10]
            )
    except Exception as exc:
        db.rollback()
        notice = ""
        error = f"Submit BD commission payout jobs failed: {exc}"

    return RedirectResponse(
        url=_build_bd_commission_redirect_url(
            next_path=next_path,
            notice=notice,
            error=error,
        ),
        status_code=302,
    )


@router.get("/bd/commission-job-logs", response_class=HTMLResponse)
def bd_commission_job_logs_page(
    request: Request,
    status: str = "",
    start_date: str = "",
    end_date: str = "",
    page: int = 1,
    page_size: int = 20,
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return redir

    status_value = str(status or "").strip().upper()
    range_from, range_to, query_notices, used_default_range = _balance_log_date_range(
        date_from_text=start_date,
        date_to_text=end_date,
        created_from_text="",
        created_to_text="",
    )
    range_days = (range_to - range_from).days + 1
    if range_days > 30 and not _balance_log_has_precise_condition(status_value):
        query_notices.append(BD_JOB_LOGS_RANGE_BLOCK_NOTICE)
        range_from, range_to = _narrow_admin_range_to_30_days(range_to)
        range_days = 30
    active_range_days = range_days if range_days in {7, 15, 30} else (7 if used_default_range else 0)
    today = get_admin_today_date()
    quick_ranges = [
        {
            "days": days,
            "date_from": (today - timedelta(days=days - 1)).isoformat(),
            "date_to": today.isoformat(),
        }
        for days in (7, 15, 30)
    ]

    filters = {
        "status": status_value,
        "start_date": range_from,
        "end_date": range_to,
        "start_date_text": range_from.isoformat(),
        "end_date_text": range_to.isoformat(),
        "page": page,
        "page_size": page_size,
    }
    result = admin_query_bd_commission_job_logs(db, filters)
    filters["start_date_text"] = filters["start_date_text"] or str(_result_filters(result).get("start_date", ""))
    filters["end_date_text"] = filters["end_date_text"] or str(_result_filters(result).get("end_date", ""))
    filters["status"] = _result_filters(result).get("status", "")

    return render(
        request,
        "admin/bd_commission_job_logs.html",
        ctx={
            "items": _result_items(result),
            "active_group": "system",
            "active": "bd_commission_job_logs",
            "filters": filters,
            "large_table_notice": BD_JOB_LOGS_LARGE_TABLE_NOTICE,
            "query_notice": " ".join(query_notices),
            "quick_ranges": quick_ranges,
            "active_range_days": active_range_days,
            "pagination": {
                "page": _result_page(result),
                "page_size": _result_page_size(result),
                "total": _result_total(result),
                "pages": _result_pages(result),
            },
        },
    )


def _dividend_config_context(
    db: Session,
    *,
    notice: str = "",
    error: str = "",
    config: Optional[dict] = None,
) -> dict:
    rules = admin_query_dividend_config_rules(db)
    return {
        "config": config or get_dividend_config(db),
        "svip_rules": rules["svip_rules"],
        "vip_rules": rules["vip_rules"],
        "notice": notice,
        "error": error,
        "active_group": "operations",
        "active": "dividend_config",
        "filters": {},
        "pagination": _default_pagination(),
    }


@router.get("/dividend-config", response_class=HTMLResponse)
@router.get("/dividends/config", response_class=HTMLResponse)
def dividend_config_page(
    request: Request,
    notice: str = "",
    error: str = "",
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return redir

    return render(
        request,
        "admin/dividend_config.html",
        ctx=_dividend_config_context(db, notice=notice, error=error),
    )


@router.post("/dividend-config")
@router.post("/dividends/config")
def dividend_config_submit(
    request: Request,
    run_time_utc: str = Form("00:10"),
    rcb_price_snapshot_time: str = Form("00:00"),
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "dividends.distribute")
    if redir:
        return redir

    try:
        set_dividend_run_time(db, run_time_utc)
        set_dividend_rcb_price_snapshot_time(db, rcb_price_snapshot_time)
        db.commit()
    except ValueError as exc:
        db.rollback()
        return render(
            request,
            "admin/dividend_config.html",
            ctx=_dividend_config_context(
                db,
                error=str(exc),
                config={
                    "run_time_utc": run_time_utc,
                    "rcb_price_snapshot_time": rcb_price_snapshot_time,
                    "description": "Daily dividend run time in UTC/GMT",
                    "rcb_price_snapshot_description": "Daily RCBUSDT price snapshot time in UTC/GMT",
                },
            ),
            status_code=400,
        )

    return RedirectResponse(url="/admin/dividend-config?notice=Config updated", status_code=302)


@router.post("/dividend-config/rules/{level_id}")
@router.post("/dividends/config/rules/{level_id}")
def dividend_config_rule_update(
    request: Request,
    level_id: int,
    spot_maker_fee: str = Form(""),
    spot_taker_fee: str = Form(""),
    dividend_rate: str = Form(""),
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "dividends.distribute")
    if redir:
        return redir

    result = admin_update_vip_fee_level_rule(
        db,
        level_id,
        {
            "spot_maker_fee": spot_maker_fee,
            "spot_taker_fee": spot_taker_fee,
            "dividend_rate": dividend_rate,
        },
    )
    if not result["ok"]:
        db.rollback()
        return RedirectResponse(
            url=f"/admin/dividend-config?error={quote('; '.join(result.get('errors') or ['保存失败']))}",
            status_code=302,
        )

    db.commit()
    return RedirectResponse(url=f"/admin/dividend-config?notice={quote(result['message'])}", status_code=302)


@router.post("/dividend-config/rules/{level_id}/toggle")
@router.post("/dividends/config/rules/{level_id}/toggle")
def dividend_config_rule_toggle(
    request: Request,
    level_id: int,
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "dividends.distribute")
    if redir:
        return redir

    result = admin_toggle_vip_fee_level_enabled(db, level_id)
    if not result["ok"]:
        db.rollback()
        return RedirectResponse(url=f"/admin/dividend-config?error={quote(result['message'])}", status_code=302)

    db.commit()
    return RedirectResponse(url=f"/admin/dividend-config?notice={quote(result['message'])}", status_code=302)


def _parse_dividend_date_value(value: str) -> Optional[date]:
    if isinstance(value, date) and not isinstance(value, datetime):
        return value
    if isinstance(value, datetime):
        return value.date()
    text = str(value or "").strip()
    if not text:
        return None
    try:
        return date.fromisoformat(text[:10])
    except ValueError:
        return None


def _dividend_error_redirect(path: str, message: str) -> RedirectResponse:
    return RedirectResponse(url=f"{path}?error={quote(message)}", status_code=302)


DIVIDEND_DATE_NOT_ENDED_MESSAGE = "分红日期必须早于当前 UTC 日期，不能创建今天或未来日期的分红批次"
DIVIDEND_PREMATURE_POOL_MESSAGE = "该批次日期尚未结束，属于异常提前创建批次"


def _admin_dividend_utc_today() -> date:
    return datetime.utcnow().date()


def _admin_dividend_utc_yesterday() -> date:
    return _admin_dividend_utc_today() - timedelta(days=1)


def _admin_guard_dividend_pool_finished_date(db: Session, pool_id: int) -> Optional[str]:
    row = db.execute(
        text("SELECT dividend_date FROM dividend_pools WHERE id = :pool_id LIMIT 1"),
        {"pool_id": int(pool_id)},
    ).mappings().first()
    if not row:
        return "分红池不存在"
    pool_date = _parse_dividend_date_value(row.get("dividend_date"))
    if pool_date is not None and pool_date >= _admin_dividend_utc_today():
        return DIVIDEND_PREMATURE_POOL_MESSAGE
    return None


@router.get("/dividend-pools", response_class=HTMLResponse)
@router.get("/dividends", response_class=HTMLResponse)
def dividend_pools_page(
    request: Request,
    dividend_date: str = "",
    status: str = "",
    notice: str = "",
    error: str = "",
    page: int = 1,
    page_size: int = 20,
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return redir

    parsed_date = _parse_dividend_date_value(dividend_date)
    filters = {
        "dividend_date": parsed_date,
        "dividend_date_text": str(dividend_date or "").strip(),
        "status": str(status or "").strip().upper(),
        "page": page,
        "page_size": page_size,
    }
    result = admin_query_dividend_pools(db, filters)
    return render(
        request,
        "admin/dividend_pools.html",
        ctx={
            "items": _result_items(result),
            "notice": notice,
            "error": error,
            "active_group": "operations",
            "active": "dividend_pools",
            "filters": filters,
            "utc_today": _admin_dividend_utc_today().isoformat(),
            "utc_yesterday": _admin_dividend_utc_yesterday().isoformat(),
            "pagination": {
                "page": _result_page(result),
                "page_size": _result_page_size(result),
                "total": _result_total(result),
                "pages": _result_pages(result),
            },
        },
    )


@router.get("/dividends/pools")
def dividend_pools_legacy_redirect():
    return RedirectResponse(url="/admin/dividend-pools", status_code=302)


@router.get("/dividend-stats", response_class=HTMLResponse)
@router.get("/dividends/stats", response_class=HTMLResponse)
def dividend_stats_page(
    request: Request,
    start_date: str = "",
    end_date: str = "",
    status: str = "",
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return redir

    filters = {
        "start_date": _parse_dividend_date_value(start_date),
        "end_date": _parse_dividend_date_value(end_date),
        "start_date_text": str(start_date or "").strip(),
        "end_date_text": str(end_date or "").strip(),
        "status": str(status or "").strip().upper(),
    }
    stats = admin_query_dividend_stats(db, filters)
    filters["start_date_text"] = filters["start_date_text"] or str(stats["filters"]["start_date"])
    filters["end_date_text"] = filters["end_date_text"] or str(stats["filters"]["end_date"])
    filters["status"] = stats["filters"]["status"]

    return render(
        request,
        "admin/dividend_stats.html",
        ctx={
            "stats": stats,
            "summary": stats["summary"],
            "status_counts": stats["status_counts"],
            "trends": stats["trends"],
            "levels": stats["levels"],
            "source_breakdown": stats["source_breakdown"],
            "active_group": "operations",
            "active": "dividend_stats",
            "filters": filters,
            "pagination": _default_pagination(),
        },
    )


@router.get("/dividends/job-logs", response_class=HTMLResponse)
def dividend_job_logs_page(
    request: Request,
    pool_id: str = "",
    dividend_date: str = "",
    status: str = "",
    trigger_type: str = "",
    start_date: str = "",
    end_date: str = "",
    page: int = 1,
    page_size: int = 20,
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return redir

    pool_id_value = str(pool_id or "").strip()
    dividend_date_value = _parse_dividend_date_value(dividend_date)
    status_value = str(status or "").strip().upper()
    trigger_type_value = str(trigger_type or "").strip().upper()
    range_from, range_to, query_notices, used_default_range = _balance_log_date_range(
        date_from_text=start_date,
        date_to_text=end_date,
        created_from_text="",
        created_to_text="",
    )
    range_days = (range_to - range_from).days + 1
    if range_days > 30 and not _balance_log_has_precise_condition(pool_id_value, str(dividend_date_value or ""), status_value):
        query_notices.append(DIVIDEND_JOB_LOGS_RANGE_BLOCK_NOTICE)
        range_from, range_to = _narrow_admin_range_to_30_days(range_to)
        range_days = 30
    active_range_days = range_days if range_days in {7, 15, 30} else (7 if used_default_range else 0)
    today = get_admin_today_date()
    quick_ranges = [
        {
            "days": days,
            "date_from": (today - timedelta(days=days - 1)).isoformat(),
            "date_to": today.isoformat(),
        }
        for days in (7, 15, 30)
    ]

    filters = {
        "pool_id": pool_id_value,
        "dividend_date": dividend_date_value,
        "dividend_date_text": str(dividend_date or "").strip(),
        "status": status_value,
        "trigger_type": trigger_type_value,
        "start_date": range_from,
        "end_date": range_to,
        "start_date_text": range_from.isoformat(),
        "end_date_text": range_to.isoformat(),
        "page": page,
        "page_size": page_size,
    }
    result = admin_query_dividend_job_logs(db, filters)
    filters["start_date_text"] = filters["start_date_text"] or str(_result_filters(result).get("start_date", ""))
    filters["end_date_text"] = filters["end_date_text"] or str(_result_filters(result).get("end_date", ""))
    filters["status"] = _result_filters(result).get("status", "")
    filters["trigger_type"] = _result_filters(result).get("trigger_type", "")
    filters["pool_id"] = _result_filters(result).get("pool_id") or ""

    return render(
        request,
        "admin/dividend_job_logs.html",
        ctx={
            "items": _result_items(result),
            "active_group": "system",
            "active": "dividend_job_logs",
            "filters": filters,
            "large_table_notice": DIVIDEND_JOB_LOGS_LARGE_TABLE_NOTICE,
            "query_notice": " ".join(query_notices),
            "quick_ranges": quick_ranges,
            "active_range_days": active_range_days,
            "pagination": {
                "page": _result_page(result),
                "page_size": _result_page_size(result),
                "total": _result_total(result),
                "pages": _result_pages(result),
            },
        },
    )


@router.post("/dividend-pools/create")
@router.post("/dividends/create")
def dividend_pool_create(
    request: Request,
    dividend_date: str = Form(...),
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "dividends.distribute")
    if redir:
        return redir

    parsed_date = _parse_dividend_date_value(dividend_date)
    if parsed_date is None:
        return _dividend_error_redirect("/admin/dividend-pools", "Invalid dividend date format")
    if parsed_date >= _admin_dividend_utc_today():
        return _dividend_error_redirect("/admin/dividend-pools", DIVIDEND_DATE_NOT_ENDED_MESSAGE)

    try:
        pool = create_dividend_pool_skeleton(db, parsed_date, source="MANUAL")
        db.commit()
        db.refresh(pool)
        return RedirectResponse(url=f"/admin/dividend-pools/{pool.id}?notice={quote('分红池已创建')}", status_code=302)
    except Exception as exc:
        db.rollback()
        return _dividend_error_redirect("/admin/dividend-pools", f"创建分红池失败：{exc}")


@router.post("/dividend-pools/rerun-auto")
@router.post("/dividends/rerun-auto")
def dividend_pool_rerun_auto(
    request: Request,
    dividend_date: str = Form(...),
    confirm_text: str = Form(...),
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "dividends.distribute")
    if redir:
        return redir

    if str(confirm_text or "").strip() != "EXECUTE":
        return _dividend_error_redirect("/admin/dividend-pools", "请输入 EXECUTE 确认补跑")

    parsed_date = _parse_dividend_date_value(dividend_date)
    if parsed_date is None:
        return _dividend_error_redirect("/admin/dividend-pools", "Invalid dividend date format")
    if parsed_date >= _admin_dividend_utc_today():
        return _dividend_error_redirect("/admin/dividend-pools", "只能补跑已结束的 UTC 日期，不能选择今天或未来日期")

    result = process_dividend_job_for_date(parsed_date, trigger_type="MANUAL_TRIGGER")
    status = str(result.get("status") or "")
    step = str(result.get("step") or "")
    pool_id = result.get("pool_id")
    if not result.get("ok"):
        error = result.get("error") or result.get("message") or status or "FAILED"
        return _dividend_error_redirect("/admin/dividend-pools", f"补跑失败：{error}")

    pool_text = f"，pool_id={pool_id}" if pool_id else ""
    notice = f"补跑完成：date={parsed_date.isoformat()}，status={status}，step={step}{pool_text}"
    return RedirectResponse(url=f"/admin/dividend-pools?notice={quote(notice)}", status_code=302)


@router.get("/dividend-pools/{pool_id}", response_class=HTMLResponse)
@router.get("/dividends/{pool_id}", response_class=HTMLResponse)
def dividend_pool_detail_page(
    request: Request,
    pool_id: int,
    notice: str = "",
    error: str = "",
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return redir

    detail = admin_get_dividend_pool_detail(db, pool_id)
    if detail is None:
        return _dividend_error_redirect("/admin/dividend-pools", "分红池不存在")

    return render(
        request,
        "admin/dividend_pool_detail.html",
        ctx={
            "detail": detail,
            "pool": detail["pool"],
            "items": detail["items"],
            "records": detail["records"],
            "logs": detail["logs"],
            "notice": notice,
            "error": error,
            "active_group": "operations",
            "active": "dividend_pools",
            "filters": {},
            "pagination": _default_pagination(),
        },
    )


@router.post("/dividend-pools/{pool_id}/calculate")
@router.post("/dividends/{pool_id}/calculate")
def dividend_pool_calculate(
    request: Request,
    pool_id: int,
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "dividends.distribute")
    if redir:
        return redir

    guard_message = _admin_guard_dividend_pool_finished_date(db, pool_id)
    if guard_message:
        return _dividend_error_redirect(f"/admin/dividend-pools/{pool_id}", guard_message)

    try:
        calculate_dividend_pool(db, pool_id)
        db.commit()
        return RedirectResponse(url=f"/admin/dividend-pools/{pool_id}?notice={quote('Dividend calculation completed')}", status_code=302)
    except Exception as exc:
        db.rollback()
        return _dividend_error_redirect(f"/admin/dividend-pools/{pool_id}", f"Dividend calculation failed: {exc}")


@router.post("/dividend-pools/{pool_id}/distribute")
@router.post("/dividends/{pool_id}/distribute")
def dividend_pool_distribute(
    request: Request,
    pool_id: int,
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "dividends.distribute")
    if redir:
        return redir

    guard_message = _admin_guard_dividend_pool_finished_date(db, pool_id)
    if guard_message:
        return _dividend_error_redirect(f"/admin/dividend-pools/{pool_id}", guard_message)

    try:
        distribute_dividend_pool(db, pool_id)
        db.commit()
        return RedirectResponse(url=f"/admin/dividend-pools/{pool_id}?notice={quote('Dividend distribution completed')}", status_code=302)
    except Exception as exc:
        db.rollback()
        return _dividend_error_redirect(f"/admin/dividend-pools/{pool_id}", f"Dividend distribution failed: {exc}")


@router.get("/dealer-risk", response_class=HTMLResponse)
@router.get("/platform/dealer-risk", response_class=HTMLResponse)
def dealer_risk_page(
    request: Request,
    symbol: str = "",
    status: str = "",
    enabled: str = "",
    edit_id: Optional[int] = None,
    notice: str = "",
    error: str = "",
    page: int = 1,
    page_size: int = 20,
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return redir

    return render(
        request,
        "admin/dealer_risk.html",
        ctx=_build_dealer_risk_page_context(
            db=db,
            symbol=symbol,
            status=status,
            enabled=enabled,
            edit_id=edit_id,
            page=page,
            page_size=page_size,
            notice=notice,
            error=error,
        ),
    )


@router.post("/platform/dealer-risk/save")
def dealer_risk_save(
    request: Request,
    id: str = Form(""),
    symbol: str = Form(""),
    enabled: str = Form("1"),
    status: str = Form("ACTIVE"),
    max_single_notional: str = Form(""),
    max_net_base_position: str = Form(""),
    max_net_quote_exposure: str = Form(""),
    remark: str = Form(""),
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "dealer_risk.manage")
    if redir:
        return redir

    payload = {
        "id": id,
        "symbol": symbol,
        "enabled": enabled,
        "status": status,
        "max_single_notional": max_single_notional,
        "max_net_base_position": max_net_base_position,
        "max_net_quote_exposure": max_net_quote_exposure,
        "remark": remark,
    }
    result = admin_save_dealer_risk_limit(db, payload)
    if not result["ok"]:
        edit_id = int(id) if str(id).isdigit() else None
        return render(
            request,
            "admin/dealer_risk.html",
            ctx=_build_dealer_risk_page_context(
                db=db,
                symbol=symbol,
                edit_id=edit_id,
                form=result["form"],
                errors=result["errors"],
            ),
            status_code=400,
        )

    notice_message = "平台对手方限额已更新" if str(id).isdigit() else "平台对手方限额已创建"
    db.commit()
    notice_message = result.get("message") or notice_message
    return RedirectResponse(
        url=_build_platform_redirect_url(
            next_path="/admin/platform/dealer-risk",
            notice=notice_message,
        ),
        status_code=302,
    )


@router.post("/platform/dealer-risk/{risk_id}/toggle-enabled")
def dealer_risk_toggle_enabled(
    request: Request,
    risk_id: int,
    next_path: str = Form("/admin/platform/dealer-risk"),
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "dealer_risk.manage")
    if redir:
        return redir

    result = admin_toggle_dealer_risk_enabled(db, risk_id)
    if result["ok"]:
        db.commit()
    return RedirectResponse(
        url=_build_platform_redirect_url(
            next_path=next_path,
            notice=result["message"] if result["ok"] else "",
            error="" if result["ok"] else result["message"],
        ),
        status_code=302,
    )


@router.post("/platform/dealer-risk/{risk_id}/toggle-status")
def dealer_risk_toggle_status(
    request: Request,
    risk_id: int,
    next_path: str = Form("/admin/platform/dealer-risk"),
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "dealer_risk.manage")
    if redir:
        return redir

    result = admin_toggle_dealer_risk_status(db, risk_id)
    if result["ok"]:
        db.commit()
    return RedirectResponse(
        url=_build_platform_redirect_url(
            next_path=next_path,
            notice=result["message"] if result["ok"] else "",
            error="" if result["ok"] else result["message"],
        ),
        status_code=302,
    )


@router.get("/dealer-risk-logs", response_class=HTMLResponse)
@router.get("/platform/dealer-risk-logs", response_class=HTMLResponse)
def dealer_risk_logs_page(
    request: Request,
    symbol: str = "",
    risk_type: str = "",
    date_from: str = "",
    date_to: str = "",
    page: int = 1,
    page_size: int = 20,
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return redir

    symbol = _normalize_coin_symbol_value(symbol)
    risk_type = str(risk_type or "").strip().upper()
    date_from_text = str(date_from or "").strip()
    date_to_text = str(date_to or "").strip()
    parsed_date_from = _parse_dividend_date_value(date_from_text)
    parsed_date_to = _parse_dividend_date_value(date_to_text)
    query_filters = {
        "symbol": symbol,
        "risk_type": risk_type,
        "date_from": parsed_date_from,
        "date_to": parsed_date_to,
        "page": page,
        "page_size": page_size,
    }
    result = admin_query_dealer_risk_hit_logs(db=db, filters=query_filters)
    pagination = {
        "page": _result_page(result),
        "page_size": _result_page_size(result),
        "total": _result_total(result),
        "pages": _result_pages(result),
    }
    filters = {
        "symbol": symbol,
        "risk_type": risk_type,
        "date_from": date_from_text,
        "date_to": date_to_text,
    }
    return render(
        request,
        "admin/dealer_risk_logs.html",
        ctx={
            "items": _result_items(result),
            "active_group": "trade",
            "active": "dealer_risk_logs",
            "filters": filters,
            "pagination": pagination,
        },
    )


@router.get("/audit", response_class=HTMLResponse)
def audit_page(
    request: Request,
    audit_id: str = "",
    admin_user_id: str = "",
    operator_id: str = "",
    target_user_id: str = "",
    action: str = "",
    module: str = "",
    request_id: str = "",
    ip: str = "",
    date_from: str = "",
    date_to: str = "",
    start_time: str = "",
    end_time: str = "",
    created_from: str = "",
    created_to: str = "",
    page: int = 1,
    page_size: int = 20,
    db: Session = Depends(get_db),
):
    redir = require_admin_post_permission(request, db, "contract_symbols.manage")
    if redir:
        return redir

    audit_id_value = _clean_query_text(audit_id)
    admin_user_id_value = _clean_query_text(admin_user_id)
    operator_id_value = _clean_query_text(operator_id)
    target_user_id_value = _clean_query_text(target_user_id)
    action_value = _clean_query_text(action)
    module_value = _clean_query_text(module)
    request_id_value = _clean_query_text(request_id)
    ip_value = _clean_query_text(ip)
    range_from, range_to, query_notices, used_default_range = _balance_log_date_range(
        date_from_text=date_from or start_time,
        date_to_text=date_to or end_time,
        created_from_text=created_from,
        created_to_text=created_to,
    )
    range_days = (range_to - range_from).days + 1
    has_precise_condition = _balance_log_has_precise_condition(
        audit_id_value,
        admin_user_id_value,
        operator_id_value,
        target_user_id_value,
        request_id_value,
        ip_value,
    )
    should_query = True
    if range_days > 30 and not has_precise_condition:
        query_notices.append(AUDIT_LOGS_RANGE_BLOCK_NOTICE)
        range_from, range_to = _narrow_admin_range_to_30_days(range_to)
        range_days = 30
    active_range_days = range_days if range_days in {7, 15, 30} else (7 if used_default_range else 0)

    today = get_admin_today_date()
    quick_ranges = [
        {
            "days": days,
            "date_from": (today - timedelta(days=days - 1)).isoformat(),
            "date_to": today.isoformat(),
        }
        for days in (7, 15, 30)
    ]

    filters = {
        "audit_id": audit_id_value,
        "admin_user_id": admin_user_id_value,
        "operator_id": operator_id_value,
        "target_user_id": target_user_id_value,
        "action": action_value,
        "module": module_value,
        "request_id": request_id_value,
        "ip": ip_value,
        "created_from": range_from.isoformat(),
        "created_to": range_to.isoformat(),
        "date_from": range_from.isoformat(),
        "date_to": range_to.isoformat(),
        "page": page,
        "page_size": page_size,
    }
    if should_query:
        result = admin_query_audit_logs(
            db,
            {
                **filters,
                "page": page,
                "page_size": page_size,
            },
        )
        result_filters = _result_filters(result)
        filters.update(
            {
                "audit_id": result_filters.get("audit_id", audit_id_value),
                "admin_user_id": result_filters.get("admin_user_id", admin_user_id_value),
                "operator_id": result_filters.get("operator_id", operator_id_value),
                "target_user_id": result_filters.get("target_user_id", target_user_id_value),
                "action": result_filters.get("action", action_value),
                "module": result_filters.get("module", module_value),
                "request_id": result_filters.get("request_id", request_id_value),
                "ip": result_filters.get("ip", ip_value),
                "created_from": result_filters.get("created_from", range_from.isoformat()),
                "created_to": result_filters.get("created_to", range_to.isoformat()),
                "date_from": result_filters.get("date_from", range_from.isoformat()),
                "date_to": result_filters.get("date_to", range_to.isoformat()),
            }
        )
        items = _result_items(result)
        pagination = _result_pagination(result)
    else:
        items = []
        pagination = {"page": 1, "page_size": page_size, "total": 0, "pages": 1}

    return render(
        request,
        "admin/audit_list.html",
        ctx={
            "items": items,
            "active_group": "system",
            "active": "audit_list",
            "filters": filters,
            "pagination": pagination,
            "large_table_notice": AUDIT_LOGS_LARGE_TABLE_NOTICE,
            "query_notice": ", ".join(dict.fromkeys(query_notices)),
            "quick_ranges": quick_ranges,
            "active_range_days": active_range_days,
        },
    )


def _build_site_content_redirect_url(
    base: str,
    notice: str = "",
    error: str = "",
    next_path: str = "",
) -> str:
    target = next_path if next_path.startswith(base) else base
    parts: list[str] = []
    if notice:
        parts.append(f"notice={quote(notice)}")
    if error:
        parts.append(f"error={quote(error)}")
    if not parts:
        return target
    separator = "&" if "?" in target else "?"
    return f"{target}{separator}{'&'.join(parts)}"


@router.get("/site-settings", response_class=HTMLResponse)
def site_settings_page(
    request: Request,
    notice: str = "",
    error: str = "",
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return redir

    settings_row = get_or_create_site_settings(db)
    return render(
        request,
        "admin/site_settings.html",
        ctx={
            "active_group": "operations",
            "active": "site_settings",
            "notice": notice,
            "error": error,
            "form": admin_site_settings_form(settings_row),
        },
    )


@router.post("/site-settings")
def site_settings_submit(
    request: Request,
    site_name: str = Form(""),
    site_slogan: str = Form(""),
    logo_url: str = Form(""),
    support_email: str = Form(""),
    risk_disclaimer: str = Form(""),
    footer_disclaimer: str = Form(""),
    stock_token_locks_notice_title: str = Form(""),
    stock_token_locks_notice_content: str = Form(""),
    home_hero_title: str = Form(""),
    home_hero_subtitle: str = Form(""),
    home_hero_cta_text: str = Form(""),
    site_name_i18n_zh: str = Form(""),
    site_name_i18n_en: str = Form(""),
    site_name_i18n_zh_TW: str = Form(""),
    site_name_i18n_ja: str = Form(""),
    site_slogan_i18n_zh: str = Form(""),
    site_slogan_i18n_en: str = Form(""),
    site_slogan_i18n_zh_TW: str = Form(""),
    site_slogan_i18n_ja: str = Form(""),
    risk_disclaimer_i18n_zh: str = Form(""),
    risk_disclaimer_i18n_en: str = Form(""),
    risk_disclaimer_i18n_zh_TW: str = Form(""),
    risk_disclaimer_i18n_ja: str = Form(""),
    footer_disclaimer_i18n_zh: str = Form(""),
    footer_disclaimer_i18n_en: str = Form(""),
    footer_disclaimer_i18n_zh_TW: str = Form(""),
    footer_disclaimer_i18n_ja: str = Form(""),
    stock_token_locks_notice_title_i18n_zh: str = Form(""),
    stock_token_locks_notice_title_i18n_en: str = Form(""),
    stock_token_locks_notice_title_i18n_zh_TW: str = Form(""),
    stock_token_locks_notice_title_i18n_ja: str = Form(""),
    stock_token_locks_notice_content_i18n_zh: str = Form(""),
    stock_token_locks_notice_content_i18n_en: str = Form(""),
    stock_token_locks_notice_content_i18n_zh_TW: str = Form(""),
    stock_token_locks_notice_content_i18n_ja: str = Form(""),
    home_hero_title_i18n_zh: str = Form(""),
    home_hero_title_i18n_en: str = Form(""),
    home_hero_title_i18n_zh_TW: str = Form(""),
    home_hero_title_i18n_ja: str = Form(""),
    home_hero_subtitle_i18n_zh: str = Form(""),
    home_hero_subtitle_i18n_en: str = Form(""),
    home_hero_subtitle_i18n_zh_TW: str = Form(""),
    home_hero_subtitle_i18n_ja: str = Form(""),
    home_hero_cta_text_i18n_zh: str = Form(""),
    home_hero_cta_text_i18n_en: str = Form(""),
    home_hero_cta_text_i18n_zh_TW: str = Form(""),
    home_hero_cta_text_i18n_ja: str = Form(""),
    home_hero_cta_link: str = Form(""),
    home_hero_image: str = Form(""),
    app_android_qr_url: str = Form(""),
    app_ios_qr_url: str = Form(""),
    app_download_title: str = Form(""),
    app_download_subtitle: str = Form(""),
    app_download_title_i18n_zh: str = Form(""),
    app_download_title_i18n_en: str = Form(""),
    app_download_title_i18n_zh_TW: str = Form(""),
    app_download_title_i18n_ja: str = Form(""),
    app_download_subtitle_i18n_zh: str = Form(""),
    app_download_subtitle_i18n_en: str = Form(""),
    app_download_subtitle_i18n_zh_TW: str = Form(""),
    app_download_subtitle_i18n_ja: str = Form(""),
    show_risk_link: bool = Form(False),
    risk_link_url: Optional[str] = Form(None),
    show_terms_link: bool = Form(False),
    terms_link_url: Optional[str] = Form(None),
    show_privacy_link: bool = Form(False),
    privacy_link_url: Optional[str] = Form(None),
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return redir
    redir = require_admin_post_permission(request, db, "site_content.manage")
    if redir:
        return redir

    update_site_settings(
        db,
        {
            "site_name": site_name,
            "site_slogan": site_slogan,
            "logo_url": logo_url,
            "support_email": support_email,
            "risk_disclaimer": risk_disclaimer,
            "footer_disclaimer": footer_disclaimer,
            "stock_token_locks_notice_title": stock_token_locks_notice_title,
            "stock_token_locks_notice_content": stock_token_locks_notice_content,
            "home_hero_title": home_hero_title,
            "home_hero_subtitle": home_hero_subtitle,
            "home_hero_cta_text": home_hero_cta_text,
            "site_name_i18n_zh": site_name_i18n_zh,
            "site_name_i18n_en": site_name_i18n_en,
            "site_name_i18n_zh_TW": site_name_i18n_zh_TW,
            "site_name_i18n_ja": site_name_i18n_ja,
            "site_slogan_i18n_zh": site_slogan_i18n_zh,
            "site_slogan_i18n_en": site_slogan_i18n_en,
            "site_slogan_i18n_zh_TW": site_slogan_i18n_zh_TW,
            "site_slogan_i18n_ja": site_slogan_i18n_ja,
            "risk_disclaimer_i18n_zh": risk_disclaimer_i18n_zh,
            "risk_disclaimer_i18n_en": risk_disclaimer_i18n_en,
            "risk_disclaimer_i18n_zh_TW": risk_disclaimer_i18n_zh_TW,
            "risk_disclaimer_i18n_ja": risk_disclaimer_i18n_ja,
            "footer_disclaimer_i18n_zh": footer_disclaimer_i18n_zh,
            "footer_disclaimer_i18n_en": footer_disclaimer_i18n_en,
            "footer_disclaimer_i18n_zh_TW": footer_disclaimer_i18n_zh_TW,
            "footer_disclaimer_i18n_ja": footer_disclaimer_i18n_ja,
            "stock_token_locks_notice_title_i18n_zh": stock_token_locks_notice_title_i18n_zh,
            "stock_token_locks_notice_title_i18n_en": stock_token_locks_notice_title_i18n_en,
            "stock_token_locks_notice_title_i18n_zh_TW": stock_token_locks_notice_title_i18n_zh_TW,
            "stock_token_locks_notice_title_i18n_ja": stock_token_locks_notice_title_i18n_ja,
            "stock_token_locks_notice_content_i18n_zh": stock_token_locks_notice_content_i18n_zh,
            "stock_token_locks_notice_content_i18n_en": stock_token_locks_notice_content_i18n_en,
            "stock_token_locks_notice_content_i18n_zh_TW": stock_token_locks_notice_content_i18n_zh_TW,
            "stock_token_locks_notice_content_i18n_ja": stock_token_locks_notice_content_i18n_ja,
            "home_hero_title_i18n_zh": home_hero_title_i18n_zh,
            "home_hero_title_i18n_en": home_hero_title_i18n_en,
            "home_hero_title_i18n_zh_TW": home_hero_title_i18n_zh_TW,
            "home_hero_title_i18n_ja": home_hero_title_i18n_ja,
            "home_hero_subtitle_i18n_zh": home_hero_subtitle_i18n_zh,
            "home_hero_subtitle_i18n_en": home_hero_subtitle_i18n_en,
            "home_hero_subtitle_i18n_zh_TW": home_hero_subtitle_i18n_zh_TW,
            "home_hero_subtitle_i18n_ja": home_hero_subtitle_i18n_ja,
            "home_hero_cta_text_i18n_zh": home_hero_cta_text_i18n_zh,
            "home_hero_cta_text_i18n_en": home_hero_cta_text_i18n_en,
            "home_hero_cta_text_i18n_zh_TW": home_hero_cta_text_i18n_zh_TW,
            "home_hero_cta_text_i18n_ja": home_hero_cta_text_i18n_ja,
            "home_hero_cta_link": home_hero_cta_link,
            "home_hero_image": home_hero_image,
            "app_android_qr_url": app_android_qr_url,
            "app_ios_qr_url": app_ios_qr_url,
            "app_download_title": app_download_title,
            "app_download_subtitle": app_download_subtitle,
            "app_download_title_i18n_zh": app_download_title_i18n_zh,
            "app_download_title_i18n_en": app_download_title_i18n_en,
            "app_download_title_i18n_zh_TW": app_download_title_i18n_zh_TW,
            "app_download_title_i18n_ja": app_download_title_i18n_ja,
            "app_download_subtitle_i18n_zh": app_download_subtitle_i18n_zh,
            "app_download_subtitle_i18n_en": app_download_subtitle_i18n_en,
            "app_download_subtitle_i18n_zh_TW": app_download_subtitle_i18n_zh_TW,
            "app_download_subtitle_i18n_ja": app_download_subtitle_i18n_ja,
            "show_risk_link": show_risk_link,
            "risk_link_url": risk_link_url,
            "show_terms_link": show_terms_link,
            "terms_link_url": terms_link_url,
            "show_privacy_link": show_privacy_link,
            "privacy_link_url": privacy_link_url,
        },
    )
    return RedirectResponse(
        url=_build_site_content_redirect_url("/admin/site-settings", notice="Site settings saved"),
        status_code=302,
    )


@router.get("/site-about-page", response_class=HTMLResponse)
def site_about_page(
    request: Request,
    notice: str = "",
    error: str = "",
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return redir

    settings_row = get_or_create_site_settings(db)
    return render(
        request,
        "admin/site_about_page.html",
        ctx={
            "active_group": "operations",
            "active": "site_about_page",
            "notice": notice,
            "error": error,
            "about_page": admin_about_page_form(settings_row),
        },
    )


@router.post("/site-about-page")
async def site_about_page_submit(
    request: Request,
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return redir
    redir = require_admin_post_permission(request, db, "site_content.manage")
    if redir:
        return redir

    form_data = await request.form()
    payload = {key: str(value) for key, value in form_data.items()}
    update_about_page_sections(db, payload)
    return RedirectResponse(
        url=_build_site_content_redirect_url("/admin/site-about-page", notice="关于我们页面内容已保存"),
        status_code=302,
    )


@router.get("/site-legal-pages", response_class=HTMLResponse)
def site_legal_pages(
    request: Request,
    notice: str = "",
    error: str = "",
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return redir

    settings_row = get_or_create_site_settings(db)
    return render(
        request,
        "admin/site_legal_pages.html",
        ctx={
            "active_group": "operations",
            "active": "site_legal_pages",
            "notice": notice,
            "error": error,
            "legal_pages": admin_legal_pages_form(settings_row),
        },
    )


@router.post("/site-legal-pages")
async def site_legal_pages_submit(
    request: Request,
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return redir
    redir = require_admin_post_permission(request, db, "site_content.manage")
    if redir:
        return redir

    form_data = await request.form()
    payload = {key: str(value) for key, value in form_data.items()}
    update_legal_pages(db, payload)
    return RedirectResponse(
        url=_build_site_content_redirect_url("/admin/site-legal-pages", notice="风险与协议页面内容已保存"),
        status_code=302,
    )


@router.get("/home-banners", response_class=HTMLResponse)
def home_banners_page(
    request: Request,
    keyword: str = "",
    status: str = "",
    notice: str = "",
    error: str = "",
    page: int = 1,
    page_size: int = 20,
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return redir

    result = admin_query_home_banners(
        db,
        {
            "keyword": keyword,
            "status": status,
            "page": page,
            "page_size": page_size,
        },
    )
    return render(
        request,
        "admin/home_banners.html",
        ctx={
            "active_group": "operations",
            "active": "home_banners",
            "items": _result_items(result),
            "filters": {"keyword": keyword, "status": status},
            "pagination": {
                "page": _result_page(result),
                "page_size": _result_page_size(result),
                "total": _result_total(result),
                "pages": _result_pages(result),
            },
            "notice": notice,
            "error": error,
        },
    )


@router.get("/home-banners/new", response_class=HTMLResponse)
def home_banner_create_page(request: Request):
    redir = require_admin(request)
    if redir:
        return redir

    return render(
        request,
        "admin/home_banner_form.html",
        ctx={
            "active_group": "operations",
            "active": "home_banners",
            "is_edit": False,
            "errors": [],
            "form_action": "/admin/home-banners/new",
            "form": {
                "title": "",
                "subtitle": "",
                "image_url": "",
                "link_url": "",
                "sort_order": 0,
                "status": "ACTIVE",
                "start_at_input": "",
                "end_at_input": "",
            },
        },
    )


@router.post("/home-banners/new")
def home_banner_create_submit(
    request: Request,
    title: str = Form(""),
    subtitle: str = Form(""),
    title_i18n_zh: str = Form(""),
    title_i18n_en: str = Form(""),
    title_i18n_zh_TW: str = Form(""),
    title_i18n_ja: str = Form(""),
    subtitle_i18n_zh: str = Form(""),
    subtitle_i18n_en: str = Form(""),
    subtitle_i18n_zh_TW: str = Form(""),
    subtitle_i18n_ja: str = Form(""),
    image_url: str = Form(""),
    link_url: str = Form(""),
    sort_order: str = Form("0"),
    status: str = Form("ACTIVE"),
    start_at: str = Form(""),
    end_at: str = Form(""),
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return redir
    redir = require_admin_post_permission(request, db, "site_content.manage")
    if redir:
        return redir

    payload = {
        "title": title,
        "subtitle": subtitle,
        "title_i18n_zh": title_i18n_zh,
        "title_i18n_en": title_i18n_en,
        "title_i18n_zh_TW": title_i18n_zh_TW,
        "title_i18n_ja": title_i18n_ja,
        "subtitle_i18n_zh": subtitle_i18n_zh,
        "subtitle_i18n_en": subtitle_i18n_en,
        "subtitle_i18n_zh_TW": subtitle_i18n_zh_TW,
        "subtitle_i18n_ja": subtitle_i18n_ja,
        "image_url": image_url,
        "link_url": link_url,
        "sort_order": sort_order,
        "status": status,
        "start_at": start_at,
        "end_at": end_at,
    }
    result = admin_create_home_banner(db, payload)
    if not result["ok"]:
        return render(
            request,
            "admin/home_banner_form.html",
            ctx={
                "active_group": "operations",
                "active": "home_banners",
                "is_edit": False,
                "errors": result["errors"],
                "form_action": "/admin/home-banners/new",
                "form": admin_banner_form_from_payload(payload),
            },
            status_code=400,
        )
    return RedirectResponse(
        url=_build_site_content_redirect_url("/admin/home-banners", notice="首页 Banner 创建成功"),
        status_code=302,
    )


@router.get("/home-banners/{banner_id}/edit", response_class=HTMLResponse)
def home_banner_edit_page(
    request: Request,
    banner_id: int,
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return redir

    item = admin_get_home_banner(db, banner_id)
    if item is None:
        return RedirectResponse(
            url=_build_site_content_redirect_url("/admin/home-banners", error="首页 Banner 不存"),
            status_code=302,
        )
    return render(
        request,
        "admin/home_banner_form.html",
        ctx={
            "active_group": "operations",
            "active": "home_banners",
            "is_edit": True,
            "errors": [],
            "form_action": f"/admin/home-banners/{banner_id}/edit",
            "form": item,
        },
    )


@router.post("/home-banners/{banner_id}/edit")
def home_banner_edit_submit(
    request: Request,
    banner_id: int,
    title: str = Form(""),
    subtitle: str = Form(""),
    title_i18n_zh: str = Form(""),
    title_i18n_en: str = Form(""),
    title_i18n_zh_TW: str = Form(""),
    title_i18n_ja: str = Form(""),
    subtitle_i18n_zh: str = Form(""),
    subtitle_i18n_en: str = Form(""),
    subtitle_i18n_zh_TW: str = Form(""),
    subtitle_i18n_ja: str = Form(""),
    image_url: str = Form(""),
    link_url: str = Form(""),
    sort_order: str = Form("0"),
    status: str = Form("ACTIVE"),
    start_at: str = Form(""),
    end_at: str = Form(""),
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return redir
    redir = require_admin_post_permission(request, db, "site_content.manage")
    if redir:
        return redir

    payload = {
        "title": title,
        "subtitle": subtitle,
        "title_i18n_zh": title_i18n_zh,
        "title_i18n_en": title_i18n_en,
        "title_i18n_zh_TW": title_i18n_zh_TW,
        "title_i18n_ja": title_i18n_ja,
        "subtitle_i18n_zh": subtitle_i18n_zh,
        "subtitle_i18n_en": subtitle_i18n_en,
        "subtitle_i18n_zh_TW": subtitle_i18n_zh_TW,
        "subtitle_i18n_ja": subtitle_i18n_ja,
        "image_url": image_url,
        "link_url": link_url,
        "sort_order": sort_order,
        "status": status,
        "start_at": start_at,
        "end_at": end_at,
    }
    result = admin_update_home_banner(db, banner_id, payload)
    if not result["ok"]:
        if result.get("not_found"):
            return RedirectResponse(
                url=_build_site_content_redirect_url("/admin/home-banners", error="首页 Banner 不存"),
                status_code=302,
            )
        return render(
            request,
            "admin/home_banner_form.html",
            ctx={
                "active_group": "operations",
                "active": "home_banners",
                "is_edit": True,
                "errors": result["errors"],
                "form_action": f"/admin/home-banners/{banner_id}/edit",
                "form": admin_banner_form_from_payload(payload),
            },
            status_code=400,
        )
    return RedirectResponse(
        url=_build_site_content_redirect_url("/admin/home-banners", notice="首页 Banner 保存成功"),
        status_code=302,
    )


@router.post("/home-banners/{banner_id}/toggle-status")
def home_banner_toggle_status(
    request: Request,
    banner_id: int,
    next_path: str = Form("/admin/home-banners"),
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return redir
    redir = require_admin_post_permission(request, db, "site_content.manage")
    if redir:
        return redir

    result = admin_toggle_home_banner_status(db, banner_id)
    return RedirectResponse(
        url=_build_site_content_redirect_url(
            "/admin/home-banners",
            notice=result["message"] if result["ok"] else "",
            error="" if result["ok"] else result["message"],
            next_path=next_path,
        ),
        status_code=302,
    )


@router.post("/home-banners/{banner_id}/delete")
def home_banner_delete_submit(
    request: Request,
    banner_id: int,
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return redir
    redir = require_admin_post_permission(request, db, "site_content.manage")
    if redir:
        return redir

    result = admin_delete_home_banner(db, banner_id)
    return RedirectResponse(
        url=_build_site_content_redirect_url(
            "/admin/home-banners",
            notice=result["message"] if result["ok"] else "",
            error="" if result["ok"] else result["message"],
        ),
        status_code=302,
    )


@router.get("/announcements", response_class=HTMLResponse)
def announcements_page(
    request: Request,
    keyword: str = "",
    status: str = "",
    category: str = "",
    notice: str = "",
    error: str = "",
    page: int = 1,
    page_size: int = 20,
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return redir

    result = admin_query_announcements(
        db,
        {
            "keyword": keyword,
            "status": status,
            "category": category,
            "page": page,
            "page_size": page_size,
        },
    )
    return render(
        request,
        "admin/announcements.html",
        ctx={
            "active_group": "operations",
            "active": "announcements",
            "items": _result_items(result),
            "filters": {"keyword": keyword, "status": status, "category": category},
            "category_options": ANNOUNCEMENT_CATEGORY_OPTIONS,
            "pagination": {
                "page": _result_page(result),
                "page_size": _result_page_size(result),
                "total": _result_total(result),
                "pages": _result_pages(result),
            },
            "notice": notice,
            "error": error,
        },
    )


@router.get("/announcements/new", response_class=HTMLResponse)
def announcement_create_page(request: Request):
    redir = require_admin(request)
    if redir:
        return redir

    return render(
        request,
        "admin/announcement_form.html",
        ctx={
            "active_group": "operations",
            "active": "announcements",
            "is_edit": False,
            "errors": [],
            "form_action": "/admin/announcements/new",
            "form": {
                "title": "",
                "slug": "",
                "category": "platform",
                "summary": "",
                "content": "",
                "is_pinned": False,
                "status": "PUBLISHED",
                "publish_at_input": "",
            },
            "category_options": ANNOUNCEMENT_CATEGORY_OPTIONS,
        },
    )


@router.post("/announcements/new")
def announcement_create_submit(
    request: Request,
    title: str = Form(""),
    slug: str = Form(""),
    category: str = Form("platform"),
    summary: str = Form(""),
    content: str = Form(""),
    title_i18n_zh: str = Form(""),
    title_i18n_en: str = Form(""),
    title_i18n_zh_TW: str = Form(""),
    title_i18n_ja: str = Form(""),
    summary_i18n_zh: str = Form(""),
    summary_i18n_en: str = Form(""),
    summary_i18n_zh_TW: str = Form(""),
    summary_i18n_ja: str = Form(""),
    content_i18n_zh: str = Form(""),
    content_i18n_en: str = Form(""),
    content_i18n_zh_TW: str = Form(""),
    content_i18n_ja: str = Form(""),
    is_pinned: str = Form(""),
    status: str = Form("PUBLISHED"),
    publish_at: str = Form(""),
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return redir
    redir = require_admin_post_permission(request, db, "site_content.manage")
    if redir:
        return redir

    payload = {
        "title": title,
        "slug": slug,
        "category": category,
        "summary": summary,
        "content": content,
        "title_i18n_zh": title_i18n_zh,
        "title_i18n_en": title_i18n_en,
        "title_i18n_zh_TW": title_i18n_zh_TW,
        "title_i18n_ja": title_i18n_ja,
        "summary_i18n_zh": summary_i18n_zh,
        "summary_i18n_en": summary_i18n_en,
        "summary_i18n_zh_TW": summary_i18n_zh_TW,
        "summary_i18n_ja": summary_i18n_ja,
        "content_i18n_zh": content_i18n_zh,
        "content_i18n_en": content_i18n_en,
        "content_i18n_zh_TW": content_i18n_zh_TW,
        "content_i18n_ja": content_i18n_ja,
        "is_pinned": is_pinned,
        "status": status,
        "publish_at": publish_at,
    }
    result = admin_create_announcement(db, payload)
    if not result["ok"]:
        return render(
            request,
            "admin/announcement_form.html",
            ctx={
                "active_group": "operations",
                "active": "announcements",
                "is_edit": False,
                "errors": result["errors"],
                "form_action": "/admin/announcements/new",
                "form": admin_announcement_form_from_payload(payload),
                "category_options": ANNOUNCEMENT_CATEGORY_OPTIONS,
            },
            status_code=400,
        )
    return RedirectResponse(
        url=_build_site_content_redirect_url("/admin/announcements", notice="公告创建成功"),
        status_code=302,
    )


@router.get("/announcements/{announcement_id}/edit", response_class=HTMLResponse)
def announcement_edit_page(
    request: Request,
    announcement_id: int,
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return redir

    item = admin_get_announcement(db, announcement_id)
    if item is None:
        return RedirectResponse(
            url=_build_site_content_redirect_url("/admin/announcements", error="公告不存"),
            status_code=302,
        )
    return render(
        request,
        "admin/announcement_form.html",
        ctx={
            "active_group": "operations",
            "active": "announcements",
            "is_edit": True,
            "errors": [],
            "form_action": f"/admin/announcements/{announcement_id}/edit",
            "form": item,
            "category_options": ANNOUNCEMENT_CATEGORY_OPTIONS,
        },
    )


@router.post("/announcements/{announcement_id}/edit")
def announcement_edit_submit(
    request: Request,
    announcement_id: int,
    title: str = Form(""),
    slug: str = Form(""),
    category: str = Form("platform"),
    summary: str = Form(""),
    content: str = Form(""),
    title_i18n_zh: str = Form(""),
    title_i18n_en: str = Form(""),
    title_i18n_zh_TW: str = Form(""),
    title_i18n_ja: str = Form(""),
    summary_i18n_zh: str = Form(""),
    summary_i18n_en: str = Form(""),
    summary_i18n_zh_TW: str = Form(""),
    summary_i18n_ja: str = Form(""),
    content_i18n_zh: str = Form(""),
    content_i18n_en: str = Form(""),
    content_i18n_zh_TW: str = Form(""),
    content_i18n_ja: str = Form(""),
    is_pinned: str = Form(""),
    status: str = Form("PUBLISHED"),
    publish_at: str = Form(""),
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return redir
    redir = require_admin_post_permission(request, db, "site_content.manage")
    if redir:
        return redir

    payload = {
        "title": title,
        "slug": slug,
        "category": category,
        "summary": summary,
        "content": content,
        "title_i18n_zh": title_i18n_zh,
        "title_i18n_en": title_i18n_en,
        "title_i18n_zh_TW": title_i18n_zh_TW,
        "title_i18n_ja": title_i18n_ja,
        "summary_i18n_zh": summary_i18n_zh,
        "summary_i18n_en": summary_i18n_en,
        "summary_i18n_zh_TW": summary_i18n_zh_TW,
        "summary_i18n_ja": summary_i18n_ja,
        "content_i18n_zh": content_i18n_zh,
        "content_i18n_en": content_i18n_en,
        "content_i18n_zh_TW": content_i18n_zh_TW,
        "content_i18n_ja": content_i18n_ja,
        "is_pinned": is_pinned,
        "status": status,
        "publish_at": publish_at,
    }
    result = admin_update_announcement(db, announcement_id, payload)
    if not result["ok"]:
        if result.get("not_found"):
            return RedirectResponse(
                url=_build_site_content_redirect_url("/admin/announcements", error="公告不存"),
                status_code=302,
            )
        return render(
            request,
            "admin/announcement_form.html",
            ctx={
                "active_group": "operations",
                "active": "announcements",
                "is_edit": True,
                "errors": result["errors"],
                "form_action": f"/admin/announcements/{announcement_id}/edit",
                "form": admin_announcement_form_from_payload(payload),
                "category_options": ANNOUNCEMENT_CATEGORY_OPTIONS,
            },
            status_code=400,
        )
    return RedirectResponse(
        url=_build_site_content_redirect_url("/admin/announcements", notice="公告保存成功"),
        status_code=302,
    )


@router.post("/announcements/{announcement_id}/toggle-status")
def announcement_toggle_status(
    request: Request,
    announcement_id: int,
    next_path: str = Form("/admin/announcements"),
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return redir
    redir = require_admin_post_permission(request, db, "site_content.manage")
    if redir:
        return redir

    result = admin_toggle_announcement_status(db, announcement_id)
    return RedirectResponse(
        url=_build_site_content_redirect_url(
            "/admin/announcements",
            notice=result["message"] if result["ok"] else "",
            error="" if result["ok"] else result["message"],
            next_path=next_path,
        ),
        status_code=302,
    )


@router.get("/help/categories", response_class=HTMLResponse)
def help_categories_page(
    request: Request,
    keyword: str = "",
    enabled: str = "",
    notice: str = "",
    error: str = "",
    page: int = 1,
    page_size: int = 20,
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return redir

    result = admin_query_help_categories(
        db,
        {
            "keyword": keyword,
            "enabled": enabled,
            "page": page,
            "page_size": page_size,
        },
    )
    return render(
        request,
        "admin/help_categories.html",
        ctx={
            "active_group": "operations",
            "active": "help_categories",
            "items": _result_items(result),
            "filters": {"keyword": keyword, "enabled": enabled},
            "pagination": {
                "page": _result_page(result),
                "page_size": _result_page_size(result),
                "total": _result_total(result),
                "pages": _result_pages(result),
            },
            "notice": notice,
            "error": error,
        },
    )


@router.get("/help/categories/new", response_class=HTMLResponse)
def help_category_create_page(request: Request):
    redir = require_admin(request)
    if redir:
        return redir

    return render(
        request,
        "admin/help_category_form.html",
        ctx={
            "active_group": "operations",
            "active": "help_categories",
            "is_edit": False,
            "errors": [],
            "form_action": "/admin/help/categories/new",
            "form": {
                "category_key": "",
                "title": "",
                "description": "",
                "sort_order": 0,
                "enabled": True,
            },
        },
    )


@router.post("/help/categories/new")
def help_category_create_submit(
    request: Request,
    category_key: str = Form(""),
    title: str = Form(""),
    description: str = Form(""),
    title_i18n_zh: str = Form(""),
    title_i18n_en: str = Form(""),
    title_i18n_zh_TW: str = Form(""),
    title_i18n_ja: str = Form(""),
    description_i18n_zh: str = Form(""),
    description_i18n_en: str = Form(""),
    description_i18n_zh_TW: str = Form(""),
    description_i18n_ja: str = Form(""),
    sort_order: str = Form("0"),
    enabled: str = Form(""),
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return redir
    redir = require_admin_post_permission(request, db, "site_content.manage")
    if redir:
        return redir

    payload = {
        "category_key": category_key,
        "title": title,
        "description": description,
        "title_i18n_zh": title_i18n_zh,
        "title_i18n_en": title_i18n_en,
        "title_i18n_zh_TW": title_i18n_zh_TW,
        "title_i18n_ja": title_i18n_ja,
        "description_i18n_zh": description_i18n_zh,
        "description_i18n_en": description_i18n_en,
        "description_i18n_zh_TW": description_i18n_zh_TW,
        "description_i18n_ja": description_i18n_ja,
        "sort_order": sort_order,
        "enabled": enabled,
    }
    result = admin_create_help_category(db, payload)
    if not result["ok"]:
        return render(
            request,
            "admin/help_category_form.html",
            ctx={
                "active_group": "operations",
                "active": "help_categories",
                "is_edit": False,
                "errors": result["errors"],
                "form_action": "/admin/help/categories/new",
                "form": admin_help_category_form_from_payload(payload),
            },
            status_code=400,
        )
    return RedirectResponse(
        url=_build_site_content_redirect_url("/admin/help/categories", notice="帮助分类创建成功"),
        status_code=302,
    )


@router.get("/help/categories/{category_id}/edit", response_class=HTMLResponse)
def help_category_edit_page(
    request: Request,
    category_id: int,
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return redir

    item = admin_get_help_category(db, category_id)
    if item is None:
        return RedirectResponse(
            url=_build_site_content_redirect_url("/admin/help/categories", error="帮助分类不存在"),
            status_code=302,
        )
    return render(
        request,
        "admin/help_category_form.html",
        ctx={
            "active_group": "operations",
            "active": "help_categories",
            "is_edit": True,
            "errors": [],
            "form_action": f"/admin/help/categories/{category_id}/edit",
            "form": item,
        },
    )


@router.post("/help/categories/{category_id}/edit")
def help_category_edit_submit(
    request: Request,
    category_id: int,
    category_key: str = Form(""),
    title: str = Form(""),
    description: str = Form(""),
    title_i18n_zh: str = Form(""),
    title_i18n_en: str = Form(""),
    title_i18n_zh_TW: str = Form(""),
    title_i18n_ja: str = Form(""),
    description_i18n_zh: str = Form(""),
    description_i18n_en: str = Form(""),
    description_i18n_zh_TW: str = Form(""),
    description_i18n_ja: str = Form(""),
    sort_order: str = Form("0"),
    enabled: str = Form(""),
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return redir
    redir = require_admin_post_permission(request, db, "site_content.manage")
    if redir:
        return redir

    payload = {
        "category_key": category_key,
        "title": title,
        "description": description,
        "title_i18n_zh": title_i18n_zh,
        "title_i18n_en": title_i18n_en,
        "title_i18n_zh_TW": title_i18n_zh_TW,
        "title_i18n_ja": title_i18n_ja,
        "description_i18n_zh": description_i18n_zh,
        "description_i18n_en": description_i18n_en,
        "description_i18n_zh_TW": description_i18n_zh_TW,
        "description_i18n_ja": description_i18n_ja,
        "sort_order": sort_order,
        "enabled": enabled,
    }
    result = admin_update_help_category(db, category_id, payload)
    if not result["ok"]:
        if result.get("not_found"):
            return RedirectResponse(
                url=_build_site_content_redirect_url("/admin/help/categories", error="帮助分类不存在"),
                status_code=302,
            )
        return render(
            request,
            "admin/help_category_form.html",
            ctx={
                "active_group": "operations",
                "active": "help_categories",
                "is_edit": True,
                "errors": result["errors"],
                "form_action": f"/admin/help/categories/{category_id}/edit",
                "form": admin_help_category_form_from_payload(payload),
            },
            status_code=400,
        )
    return RedirectResponse(
        url=_build_site_content_redirect_url("/admin/help/categories", notice="帮助分类保存成功"),
        status_code=302,
    )


@router.post("/help/categories/{category_id}/toggle-enabled")
def help_category_toggle_enabled(
    request: Request,
    category_id: int,
    next_path: str = Form("/admin/help/categories"),
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return redir
    redir = require_admin_post_permission(request, db, "site_content.manage")
    if redir:
        return redir

    result = admin_toggle_help_category_enabled(db, category_id)
    return RedirectResponse(
        url=_build_site_content_redirect_url(
            "/admin/help/categories",
            notice=result["message"] if result["ok"] else "",
            error="" if result["ok"] else result["message"],
            next_path=next_path,
        ),
        status_code=302,
    )


@router.get("/help/articles", response_class=HTMLResponse)
def help_articles_page(
    request: Request,
    keyword: str = "",
    category_id: int = 0,
    enabled: str = "",
    hot: str = "",
    notice: str = "",
    error: str = "",
    page: int = 1,
    page_size: int = 20,
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return redir

    result = admin_query_help_articles(
        db,
        {
            "keyword": keyword,
            "category_id": category_id,
            "enabled": enabled,
            "hot": hot,
            "page": page,
            "page_size": page_size,
        },
    )
    return render(
        request,
        "admin/help_articles.html",
        ctx={
            "active_group": "operations",
            "active": "help_articles",
            "items": _result_items(result),
            "filters": {"keyword": keyword, "category_id": category_id, "enabled": enabled, "hot": hot},
            "category_options": admin_list_help_category_options(db),
            "pagination": {
                "page": _result_page(result),
                "page_size": _result_page_size(result),
                "total": _result_total(result),
                "pages": _result_pages(result),
            },
            "notice": notice,
            "error": error,
        },
    )


@router.get("/help/articles/new", response_class=HTMLResponse)
def help_article_create_page(
    request: Request,
    category_id: int = 0,
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return redir

    return render(
        request,
        "admin/help_article_form.html",
        ctx={
            "active_group": "operations",
            "active": "help_articles",
            "is_edit": False,
            "errors": [],
            "form_action": "/admin/help/articles/new",
            "category_options": admin_list_help_category_options(db),
            "form": {
                "category_id": category_id,
                "slug": "",
                "title": "",
                "summary": "",
                "content": "",
                "tags": "",
                "is_hot": False,
                "sort_order": 0,
                "enabled": True,
                "source_type": "cms",
            },
        },
    )


@router.post("/help/articles/new")
def help_article_create_submit(
    request: Request,
    category_id: str = Form("0"),
    slug: str = Form(""),
    title: str = Form(""),
    summary: str = Form(""),
    content: str = Form(""),
    title_i18n_zh: str = Form(""),
    title_i18n_en: str = Form(""),
    title_i18n_zh_TW: str = Form(""),
    title_i18n_ja: str = Form(""),
    summary_i18n_zh: str = Form(""),
    summary_i18n_en: str = Form(""),
    summary_i18n_zh_TW: str = Form(""),
    summary_i18n_ja: str = Form(""),
    content_i18n_zh: str = Form(""),
    content_i18n_en: str = Form(""),
    content_i18n_zh_TW: str = Form(""),
    content_i18n_ja: str = Form(""),
    tags: str = Form(""),
    is_hot: str = Form(""),
    sort_order: str = Form("0"),
    enabled: str = Form(""),
    source_type: str = Form("cms"),
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return redir
    redir = require_admin_post_permission(request, db, "site_content.manage")
    if redir:
        return redir

    payload = {
        "category_id": category_id,
        "slug": slug,
        "title": title,
        "summary": summary,
        "content": content,
        "title_i18n_zh": title_i18n_zh,
        "title_i18n_en": title_i18n_en,
        "title_i18n_zh_TW": title_i18n_zh_TW,
        "title_i18n_ja": title_i18n_ja,
        "summary_i18n_zh": summary_i18n_zh,
        "summary_i18n_en": summary_i18n_en,
        "summary_i18n_zh_TW": summary_i18n_zh_TW,
        "summary_i18n_ja": summary_i18n_ja,
        "content_i18n_zh": content_i18n_zh,
        "content_i18n_en": content_i18n_en,
        "content_i18n_zh_TW": content_i18n_zh_TW,
        "content_i18n_ja": content_i18n_ja,
        "tags": tags,
        "is_hot": is_hot,
        "sort_order": sort_order,
        "enabled": enabled,
        "source_type": source_type,
    }
    result = admin_create_help_article(db, payload)
    if not result["ok"]:
        return render(
            request,
            "admin/help_article_form.html",
            ctx={
                "active_group": "operations",
                "active": "help_articles",
                "is_edit": False,
                "errors": result["errors"],
                "form_action": "/admin/help/articles/new",
                "category_options": admin_list_help_category_options(db),
                "form": admin_help_article_form_from_payload(payload),
            },
            status_code=400,
        )
    return RedirectResponse(
        url=_build_site_content_redirect_url("/admin/help/articles", notice="帮助文章创建成功"),
        status_code=302,
    )


@router.get("/help/articles/{article_id}/edit", response_class=HTMLResponse)
def help_article_edit_page(
    request: Request,
    article_id: int,
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return redir

    item = admin_get_help_article(db, article_id)
    if item is None:
        return RedirectResponse(
            url=_build_site_content_redirect_url("/admin/help/articles", error="帮助文章不存在"),
            status_code=302,
        )
    return render(
        request,
        "admin/help_article_form.html",
        ctx={
            "active_group": "operations",
            "active": "help_articles",
            "is_edit": True,
            "errors": [],
            "form_action": f"/admin/help/articles/{article_id}/edit",
            "category_options": admin_list_help_category_options(db),
            "form": item,
        },
    )


@router.post("/help/articles/{article_id}/edit")
def help_article_edit_submit(
    request: Request,
    article_id: int,
    category_id: str = Form("0"),
    slug: str = Form(""),
    title: str = Form(""),
    summary: str = Form(""),
    content: str = Form(""),
    title_i18n_zh: str = Form(""),
    title_i18n_en: str = Form(""),
    title_i18n_zh_TW: str = Form(""),
    title_i18n_ja: str = Form(""),
    summary_i18n_zh: str = Form(""),
    summary_i18n_en: str = Form(""),
    summary_i18n_zh_TW: str = Form(""),
    summary_i18n_ja: str = Form(""),
    content_i18n_zh: str = Form(""),
    content_i18n_en: str = Form(""),
    content_i18n_zh_TW: str = Form(""),
    content_i18n_ja: str = Form(""),
    tags: str = Form(""),
    is_hot: str = Form(""),
    sort_order: str = Form("0"),
    enabled: str = Form(""),
    source_type: str = Form("cms"),
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return redir
    redir = require_admin_post_permission(request, db, "site_content.manage")
    if redir:
        return redir

    payload = {
        "category_id": category_id,
        "slug": slug,
        "title": title,
        "summary": summary,
        "content": content,
        "title_i18n_zh": title_i18n_zh,
        "title_i18n_en": title_i18n_en,
        "title_i18n_zh_TW": title_i18n_zh_TW,
        "title_i18n_ja": title_i18n_ja,
        "summary_i18n_zh": summary_i18n_zh,
        "summary_i18n_en": summary_i18n_en,
        "summary_i18n_zh_TW": summary_i18n_zh_TW,
        "summary_i18n_ja": summary_i18n_ja,
        "content_i18n_zh": content_i18n_zh,
        "content_i18n_en": content_i18n_en,
        "content_i18n_zh_TW": content_i18n_zh_TW,
        "content_i18n_ja": content_i18n_ja,
        "tags": tags,
        "is_hot": is_hot,
        "sort_order": sort_order,
        "enabled": enabled,
        "source_type": source_type,
    }
    result = admin_update_help_article(db, article_id, payload)
    if not result["ok"]:
        if result.get("not_found"):
            return RedirectResponse(
                url=_build_site_content_redirect_url("/admin/help/articles", error="帮助文章不存在"),
                status_code=302,
            )
        return render(
            request,
            "admin/help_article_form.html",
            ctx={
                "active_group": "operations",
                "active": "help_articles",
                "is_edit": True,
                "errors": result["errors"],
                "form_action": f"/admin/help/articles/{article_id}/edit",
                "category_options": admin_list_help_category_options(db),
                "form": admin_help_article_form_from_payload(payload),
            },
            status_code=400,
        )
    return RedirectResponse(
        url=_build_site_content_redirect_url("/admin/help/articles", notice="帮助文章保存成功"),
        status_code=302,
    )


@router.post("/help/articles/{article_id}/toggle-enabled")
def help_article_toggle_enabled(
    request: Request,
    article_id: int,
    next_path: str = Form("/admin/help/articles"),
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return redir
    redir = require_admin_post_permission(request, db, "site_content.manage")
    if redir:
        return redir

    result = admin_toggle_help_article_enabled(db, article_id)
    return RedirectResponse(
        url=_build_site_content_redirect_url(
            "/admin/help/articles",
            notice=result["message"] if result["ok"] else "",
            error="" if result["ok"] else result["message"],
            next_path=next_path,
        ),
        status_code=302,
    )


@router.post("/help/articles/{article_id}/toggle-hot")
def help_article_toggle_hot(
    request: Request,
    article_id: int,
    next_path: str = Form("/admin/help/articles"),
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return redir
    redir = require_admin_post_permission(request, db, "site_content.manage")
    if redir:
        return redir

    result = admin_toggle_help_article_hot(db, article_id)
    return RedirectResponse(
        url=_build_site_content_redirect_url(
            "/admin/help/articles",
            notice=result["message"] if result["ok"] else "",
            error="" if result["ok"] else result["message"],
            next_path=next_path,
        ),
        status_code=302,
    )


@router.get("/support-tickets", response_class=HTMLResponse)
def support_tickets_page(
    request: Request,
    keyword: str = "",
    user_id: str = "",
    status: str = "",
    category: str = "",
    notice: str = "",
    error: str = "",
    page: int = 1,
    page_size: int = 20,
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return redir

    result = admin_query_support_tickets(
        db,
        {
            "keyword": keyword,
            "user_id": user_id,
            "status": status,
            "category": category,
            "page": page,
            "page_size": page_size,
        },
    )
    return render(
        request,
        "admin/support_tickets.html",
        ctx={
            "active_group": "users",
            "active": "support_tickets",
            "items": _result_items(result),
            "filters": {"keyword": keyword, "user_id": user_id, "status": status, "category": category},
            "status_options": SUPPORT_TICKET_STATUS_OPTIONS,
            "category_options": SUPPORT_TICKET_CATEGORIES,
            "pagination": {
                "page": _result_page(result),
                "page_size": _result_page_size(result),
                "total": _result_total(result),
                "pages": _result_pages(result),
            },
            "notice": notice,
            "error": error,
        },
    )


@router.get("/support-tickets/{ticket_id}", response_class=HTMLResponse)
def support_ticket_detail_page(
    request: Request,
    ticket_id: int,
    notice: str = "",
    error: str = "",
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return redir

    ticket = admin_get_support_ticket(db, ticket_id)
    if ticket is None:
        return RedirectResponse(
            url=_build_site_content_redirect_url("/admin/support-tickets", error="工单不存在"),
            status_code=302,
        )
    return render(
        request,
        "admin/support_ticket_detail.html",
        ctx={
            "active_group": "users",
            "active": "support_tickets",
            "ticket": ticket,
            "status_options": SUPPORT_TICKET_STATUS_OPTIONS,
            "notice": notice,
            "error": error,
        },
    )


@router.post("/support-tickets/{ticket_id}/reply")
def support_ticket_reply_submit(
    request: Request,
    ticket_id: int,
    message: str = Form(""),
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return redir
    redir = require_admin_post_permission(request, db, "support_tickets.manage")
    if redir:
        return redir

    admin = get_admin_from_request(request) or {}
    try:
        result = admin_reply_support_ticket(
            db,
            ticket_id=ticket_id,
            admin_user_id=int(admin.get("id") or 0),
            message=message,
        )
        if result["ok"]:
            db.commit()
        else:
            db.rollback()
    except HTTPException as exc:
        db.rollback()
        detail = exc.detail if isinstance(exc.detail, dict) else {}
        result = {"ok": False, "message": str(detail.get("message") or exc.detail or "回复失败")}
    except Exception:
        db.rollback()
        result = {"ok": False, "message": "回复失败，请稍后重试"}

    return RedirectResponse(
        url=_build_site_content_redirect_url(
            f"/admin/support-tickets/{ticket_id}",
            notice=result["message"] if result["ok"] else "",
            error="" if result["ok"] else result["message"],
        ),
        status_code=302,
    )


@router.post("/support-tickets/{ticket_id}/status")
def support_ticket_status_submit(
    request: Request,
    ticket_id: int,
    status: str = Form(""),
    db: Session = Depends(get_db),
):
    redir = require_admin(request)
    if redir:
        return redir
    redir = require_admin_post_permission(request, db, "support_tickets.manage")
    if redir:
        return redir

    try:
        result = admin_update_support_ticket_status(db, ticket_id=ticket_id, status=status)
        if result["ok"]:
            db.commit()
        else:
            db.rollback()
    except Exception:
        db.rollback()
        result = {"ok": False, "message": "状态更新失败，请稍后重试"}

    return RedirectResponse(
        url=_build_site_content_redirect_url(
            f"/admin/support-tickets/{ticket_id}",
            notice=result["message"] if result["ok"] else "",
            error="" if result["ok"] else result["message"],
        ),
        status_code=302,
    )


@router.get("/logout")
def logout():
    resp = RedirectResponse(url="/admin/login", status_code=302)
    _delete_admin_login_cookies(resp)
    return resp
