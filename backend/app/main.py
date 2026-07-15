# app/main.py
from __future__ import annotations

import os
import logging
import threading
import uuid
from pathlib import Path
from typing import Any, Dict, Optional

from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

# =========================
# Load .env (Dev fallback)
# =========================
BACKEND_DIR = Path(__file__).resolve().parents[1]  # .../backend
ENV_PATH = BACKEND_DIR / ".env"
load_dotenv(dotenv_path=ENV_PATH, override=False)

# =========================
# Config / Settings (reads from env)
# =========================
from app.core.config import settings  # noqa: E402
from app.middleware.geo_restriction import GeoRestrictionMiddleware  # noqa: E402
from app.services.public_static_files import KycIsolatedStaticFiles  # noqa: E402

# Routers
from app.routers.health import router as health_router  # noqa: E402
from app.routers.admin_pages import router as admin_pages_router  # noqa: E402
from app.routers.me import profile_router as user_profile_router  # noqa: E402
from app.routers.me import router as me_router  # noqa: E402
from app.routers.auth_jwt import router as auth_jwt_router  # noqa: E402
from app.routers.auth import otp_router as auth_otp_router  # noqa: E402
from app.routers.auth import auth_router as auth_router  # noqa: E402
from app.routers.asset import router as asset_router  # noqa: E402
from app.routers.webhook_moralis import router as moralis_webhook_router  # noqa: E402
from app.routers.asset_withdraw import router as asset_withdraw_router  # noqa: E402
from app.routers import withdraw_send  # noqa: E402
from app.routers.order import router as order_router
from app.routers.match import router as match_router
from app.routers.market import router as market_router
from app.routers.market_external import router as market_external_router
from app.routers.market_rwa import router as market_rwa_router
from app.routers.itick_market import router as itick_market_router
from app.routers.spot import router as spot_router
from app.routers.spot_ws_private import router as spot_ws_private_router
from app.routers.account_transfer import router as account_transfer_router
from app.routers.user_transfer import router as user_transfer_router
from app.routers.contract_account import router as contract_account_router
from app.routers.contract_market import router as contract_market_router
from app.routers.contract_order import router as contract_order_router
from app.routers.contract_query import router as contract_query_router
from app.routers.contract_liquidation import router as contract_liquidation_router
from app.routers.contract_tp_sl import router as contract_tp_sl_router
from app.routers.contract_ws_private import router as contract_ws_private_router
from app.routers.vip import router as vip_router
from app.routers.dividend import router as dividend_router
from app.routers.bd_team import router as bd_team_router
from app.routers.user_invite import router as user_invite_router
from app.routers.user_invited_friends import router as user_invited_friends_router
from app.routers.stock_token import router as stock_token_router
from app.routers.announcement_reads import router as announcement_reads_router
from app.routers.site_content import router as site_content_router
from app.routers.support_tickets import router as support_tickets_router
from app.routers.activity import router as activity_router
from app.routers.geo_access import router as geo_access_router
from app.admin.activity_admin import router as activity_admin_router
from app.routers.kyc import router as kyc_router
from app.services.matching import start_auto_match_worker, stop_auto_match_worker
from app.services.order_service import process_open_dealer_orders
from app.jobs.bd_commission_job import start_bd_commission_job, stop_bd_commission_job
from app.jobs.stock_token_release_job import (
    start_stock_token_release_job,
    stop_stock_token_release_job,
)
from app.jobs.rwa_reference_job import start_rwa_reference_job, stop_rwa_reference_job
from app.jobs.stock_dealer_trade_job import (
    start_stock_dealer_trade_job,
    stop_stock_dealer_trade_job,
)
from app.jobs.contract_tp_sl_job import ContractTpSlJob
from app.jobs.contract_limit_order_job import ContractLimitOrderJob
from app.services.contract_private_ws import (
    start_contract_user_event_subscriber,
    stop_contract_user_event_subscriber,
)
from app.services.spot_private_event_relay import (
    start_spot_private_event_relay,
    stop_spot_private_event_relay,
)
from app.services.spot_private_event_subscriber import (
    start_spot_private_event_subscriber,
    stop_spot_private_event_subscriber,
)


logger = logging.getLogger(__name__)


def _split_csv(value: str) -> list[str]:
    return [item.strip() for item in (value or "").split(",") if item.strip()]

# =========================
# Startup checks (Fail Fast)
# =========================
def _require_env(keys: list[str]) -> None:
    missing = [k for k in keys if not os.getenv(k)]
    if missing:
        raise RuntimeError(f"Missing env vars: {', '.join(missing)}")


# 交易所级：关键项缺失时直接启动失败，可按阶段增减。
_require_env(
    [
        "JWT_SECRET",
        "SECURITY_PEPPER",
        "DB_HOST",
        "DB_USER",
        "DB_PASSWORD",
        "DB_NAME",
        # Moralis Streams
        "MORALIS_WEBHOOK_SECRET",
    ]
)

# 启动日志：不要打印敏感值，只打印长度或是否存在。
app = FastAPI(
    title=settings.APP_NAME,
    docs_url="/docs",
    redoc_url="/redoc",
    openapi_url="/openapi.json",
    swagger_ui_parameters={
        "deepLinking": True,
        "docExpansion": "none",
        "showExtensions": False,
        "showCommonExtensions": False,
    },
)
app.mount(
    "/static",
    KycIsolatedStaticFiles(directory=str(BACKEND_DIR / "static"), check_dir=False),
    name="static",
)
app.add_middleware(GeoRestrictionMiddleware)

# =========================
# Trace ID Middleware
# =========================
@app.middleware("http")
async def add_trace_id(request: Request, call_next):
    trace_id = request.headers.get("X-Trace-Id") or uuid.uuid4().hex
    request.state.trace_id = trace_id

    response = await call_next(request)
    response.headers["X-Trace-Id"] = trace_id
    return response


def _fail_payload(
    code: str,
    message: str,
    trace_id: Optional[str],
    extra: Optional[Dict[str, Any]] = None,
):
    error = {"code": code, "message": message}
    if extra:
        error.update(extra)

    return {
        "ok": False,
        "data": None,
        "message": message,
        "error": error,
        "trace_id": trace_id,
    }


# =========================
# Exception Handlers
# 统一 ApiResponse
# =========================
@app.exception_handler(StarletteHTTPException)
async def http_exception_handler(request: Request, exc: StarletteHTTPException):
    trace_id = getattr(request.state, "trace_id", None)

    if isinstance(exc.detail, dict):
        nested_error = exc.detail.get("error")
        nested_error_code = nested_error.get("code") if isinstance(nested_error, dict) else None
        nested_error_message = nested_error.get("message") if isinstance(nested_error, dict) else nested_error
        code = exc.detail.get("code") or nested_error_code or "HTTP_ERROR"
        message = exc.detail.get("message") or nested_error_message or "HTTP Error"
        extra = {k: v for k, v in exc.detail.items() if k not in {"code", "message", "error"}}
    else:
        code = "HTTP_ERROR"
        message = exc.detail if isinstance(exc.detail, str) else "HTTP Error"
        extra = None

    return JSONResponse(
        status_code=exc.status_code,
        content=_fail_payload(code=code, message=message, trace_id=trace_id, extra=extra),
    )


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    trace_id = getattr(request.state, "trace_id", None)
    return JSONResponse(
        status_code=422,
        content=_fail_payload(
            code="VALIDATION_ERROR",
            message="Invalid request payload",
            trace_id=trace_id,
        ),
    )


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    trace_id = getattr(request.state, "trace_id", None)
    return JSONResponse(
        status_code=500,
        content=_fail_payload(
            code="INTERNAL_ERROR",
            message="Internal server error",
            trace_id=trace_id,
        ),
    )


# =========================
# CORS
# =========================
app.add_middleware(
    CORSMiddleware,
    allow_origins=_split_csv(settings.CORS_ORIGINS or settings.CORS_ALLOW_ORIGINS),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# =========================
# Routers
# =========================
app.include_router(admin_pages_router)
app.include_router(activity_admin_router)

# health routes
app.include_router(health_router)

# JWT 登录态（/auth/login /auth/refresh 等）
app.include_router(auth_jwt_router)

# OTP（auth/otp/send /auth/otp/verify）
app.include_router(auth_otp_router)

# Auth（auth/register /auth/reset-password 等）
app.include_router(auth_router)

app.include_router(order_router)

app.include_router(match_router)

app.include_router(market_router)

app.include_router(market_external_router)

app.include_router(market_rwa_router)

app.include_router(itick_market_router)

app.include_router(spot_router)

app.include_router(spot_ws_private_router)


app.include_router(asset_router)
app.include_router(account_transfer_router)
app.include_router(user_transfer_router)
app.include_router(contract_account_router)
app.include_router(contract_market_router)
app.include_router(contract_order_router)
app.include_router(contract_query_router)
app.include_router(contract_liquidation_router)
app.include_router(contract_tp_sl_router)
app.include_router(contract_ws_private_router)
app.include_router(vip_router)
app.include_router(dividend_router)
app.include_router(bd_team_router)
app.include_router(user_invite_router)
app.include_router(user_invited_friends_router)
app.include_router(stock_token_router)
app.include_router(announcement_reads_router)
app.include_router(site_content_router)
app.include_router(support_tickets_router)
app.include_router(activity_router)
app.include_router(kyc_router)
app.include_router(geo_access_router)

# Moralis Webhook（webhooks/moralis）
app.include_router(moralis_webhook_router)
app.include_router(moralis_webhook_router, prefix="/api")

app.include_router(asset_withdraw_router)

app.include_router(withdraw_send.router)

app.include_router(me_router)
app.include_router(user_profile_router)

# =========================
# Withdraw Tx Watcher (SENT -> SUCCESS/FAILED)
# 说明：
# - 需要已新增 app/jobs/withdraw_tx_watcher.py
# - 通过环境变量控制开关，避免 reload / 多进程重复运行。
#   ENABLE_WITHDRAW_WATCHER=1  (默认开)
#   WITHDRAW_WATCH_INTERVAL=20 (默认 20s)
# =========================
_withdraw_watcher = None
_contract_tp_sl_job: Optional[ContractTpSlJob] = None
_contract_limit_order_job: Optional[ContractLimitOrderJob] = None
_dealer_order_loop_thread: Optional[threading.Thread] = None
_dealer_order_loop_stop_event: Optional[threading.Event] = None
DEALER_ORDER_LOOP_INTERVAL_SECONDS = 2


def _env_enabled(name: str, default: bool = True) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return str(raw).strip().lower() in {"1", "true", "yes", "on"}


def _embed_background_loops_in_api() -> bool:
    return _env_enabled("EMBED_BACKGROUND_LOOPS_IN_API", default=False)


def _get_session_local():
    """
    兼容项目里 SessionLocal 的不同位置，避免复制后因 import 路径不同导致启动失败。
    """
    # 常见：app.db.session
    try:
        from app.db.session import SessionLocal  # type: ignore
        return SessionLocal
    except Exception:
        pass

    # 备选：app.db.database
    try:
        from app.db.database import SessionLocal  # type: ignore
        return SessionLocal
    except Exception:
        pass

    # 备选：app.database
    try:
        from app.database import SessionLocal  # type: ignore
        return SessionLocal
    except Exception:
        pass

    raise RuntimeError(
        "Cannot import SessionLocal. Please ensure you have SessionLocal in "
        "app.db.session or app.db.database (or adjust _get_session_local())."
    )


def start_dealer_order_loop() -> None:
    global _dealer_order_loop_thread, _dealer_order_loop_stop_event

    if _dealer_order_loop_thread and _dealer_order_loop_thread.is_alive():
        return

    SessionLocal = _get_session_local()
    stop_event = threading.Event()

    def _worker() -> None:
        while not stop_event.is_set():
            db = None
            try:
                db = SessionLocal()
                filled_count = process_open_dealer_orders(db)
                db.commit()
                if filled_count:
                    logger.info("[dealer_order_loop] filled=%s", filled_count)
            except Exception as e:
                if db is not None:
                    try:
                        db.rollback()
                    except Exception:
                        pass
                logger.exception("[dealer_order_loop] round failed")
            finally:
                if db is not None:
                    db.close()

            stop_event.wait(DEALER_ORDER_LOOP_INTERVAL_SECONDS)

    _dealer_order_loop_stop_event = stop_event
    _dealer_order_loop_thread = threading.Thread(
        target=_worker,
        name="dealer-order-loop",
        daemon=True,
    )
    _dealer_order_loop_thread.start()
    logger.info("[dealer_order_loop] started interval=%ss", DEALER_ORDER_LOOP_INTERVAL_SECONDS)


def stop_dealer_order_loop() -> None:
    global _dealer_order_loop_thread, _dealer_order_loop_stop_event

    if _dealer_order_loop_stop_event is not None:
        _dealer_order_loop_stop_event.set()

    if _dealer_order_loop_thread and _dealer_order_loop_thread.is_alive():
        _dealer_order_loop_thread.join(timeout=1)

    _dealer_order_loop_thread = None
    _dealer_order_loop_stop_event = None
    logger.debug("[dealer_order_loop] stopped")


@app.on_event("startup")
def _startup():
    global _withdraw_watcher, _contract_tp_sl_job, _contract_limit_order_job
    _withdraw_watcher = None
    _contract_tp_sl_job = None
    _contract_limit_order_job = None

    if not _env_enabled("ENABLE_WITHDRAW_WATCHER", default=True):
        logger.info("[withdraw_watcher] disabled")
    else:
        try:
            from app.jobs.withdraw_tx_watcher import WithdrawTxWatcher  # noqa: E402
        except Exception as e:
            logger.exception("[withdraw_watcher] import failed")
        else:
            try:
                SessionLocal = _get_session_local()
                interval = int(os.getenv("WITHDRAW_WATCH_INTERVAL", "20"))
                _withdraw_watcher = WithdrawTxWatcher(SessionLocal, interval_seconds=interval)
                _withdraw_watcher.start()
                logger.info("[withdraw_watcher] started interval=%ss", interval)
            except Exception as e:
                logger.exception("[withdraw_watcher] start failed")
                _withdraw_watcher = None

    if _env_enabled("ENABLE_SPOT_AUTO_MATCH_IN_API", default=False):
        start_auto_match_worker()
    else:
        logger.info("[auto_match] disabled in API startup; use backend/scripts/start_spot_match_worker.py")

    if not _embed_background_loops_in_api():
        logger.info(
            "embedded background loops disabled; use dedicated scripts/systemd services in production"
        )
        logger.info("[dealer_order_loop] disabled in API startup")
        logger.info("[contract_tp_sl_job] disabled in API startup")
        logger.info("[contract_liquidation_scanner] not embedded in API startup")
    else:
        logger.info("embedded background loops enabled by EMBED_BACKGROUND_LOOPS_IN_API")
        try:
            start_dealer_order_loop()
        except Exception as e:
            logger.exception("[dealer_order_loop] start failed")

        if _env_enabled("ENABLE_CONTRACT_TP_SL_JOB", default=True):
            try:
                interval = int(os.getenv("CONTRACT_TP_SL_INTERVAL", "2"))
                _contract_tp_sl_job = ContractTpSlJob(_get_session_local(), interval_seconds=interval)
                _contract_tp_sl_job.start()
                logger.info("[contract_tp_sl_job] started interval=%ss", interval)
            except Exception as e:
                logger.exception("[contract_tp_sl_job] start failed")
                _contract_tp_sl_job = None
        else:
            logger.info("[contract_tp_sl_job] disabled by ENABLE_CONTRACT_TP_SL_JOB")

    if _env_enabled("ENABLE_CONTRACT_LIMIT_ORDER_JOB", default=False):
        try:
            interval = int(os.getenv("CONTRACT_LIMIT_ORDER_INTERVAL", "2"))
            _contract_limit_order_job = ContractLimitOrderJob(_get_session_local(), interval_seconds=interval)
            _contract_limit_order_job.start()
            logger.info("[contract_limit_order_job] started interval=%ss", interval)
        except Exception as e:
            logger.exception("[contract_limit_order_job] start failed")
            _contract_limit_order_job = None
    else:
        logger.info("[contract_limit_order_job] disabled; use backend/scripts/start_contract_limit_order_scanner.py")

    if _env_enabled("ENABLE_DIVIDEND_JOB", default=False):
        try:
            from app.jobs.dividend_job import start_dividend_job  # noqa: E402

            # WARNING: dividend job should run in single instance only.
            start_dividend_job()
        except Exception as e:
            logger.exception("[dividend_job] start failed")
    else:
        logger.info("[dividend_job] disabled")

    if _env_enabled("ENABLE_BD_COMMISSION_JOB", default=False):
        try:
            start_bd_commission_job()
        except Exception as e:
            logger.exception("[bd_commission_job] start failed")
    else:
        logger.info("[bd_commission_job] disabled")

    if _env_enabled("ENABLE_STOCK_TOKEN_RELEASE_JOB", default=False):
        try:
            start_stock_token_release_job()
        except Exception as e:
            logger.exception("[stock_token_release_job] start failed")
    else:
        logger.info("[stock_token_release_job] disabled")

    if _env_enabled("ENABLE_RWA_REFERENCE_JOB", default=False):
        try:
            start_rwa_reference_job()
        except Exception as e:
            logger.exception("[rwa_reference_job] start failed")
    else:
        logger.info("[rwa_reference_job] disabled")

    if _env_enabled("ENABLE_STOCK_DEALER_TRADE_JOB", default=False):
        try:
            start_stock_dealer_trade_job()
        except Exception as e:
            logger.exception("[stock_dealer_trade_job] start failed")
    else:
        logger.info("[stock_dealer_trade_job] disabled")


@app.on_event("startup")
async def _startup_contract_private_ws_subscriber():
    start_contract_user_event_subscriber()


@app.on_event("startup")
async def _startup_spot_private_event_bridge():
    start_spot_private_event_subscriber()
    start_spot_private_event_relay()


@app.on_event("shutdown")
def _shutdown():
    global _withdraw_watcher, _contract_tp_sl_job, _contract_limit_order_job
    try:
        stop_auto_match_worker()
        stop_dealer_order_loop()
        if _contract_tp_sl_job is not None:
            _contract_tp_sl_job.stop()
            logger.debug("[contract_tp_sl_job] stopped")
        if _contract_limit_order_job is not None:
            _contract_limit_order_job.stop()
            logger.debug("[contract_limit_order_job] stopped")
        try:
            from app.jobs.dividend_job import stop_dividend_job  # noqa: E402

            stop_dividend_job()
        except Exception as e:
            logger.exception("[dividend_job] stop failed")
        try:
            stop_bd_commission_job()
        except Exception as e:
            logger.exception("[bd_commission_job] stop failed")
        try:
            stop_stock_token_release_job()
        except Exception as e:
            logger.exception("[stock_token_release_job] stop failed")
        try:
            stop_rwa_reference_job()
        except Exception as e:
            logger.exception("[rwa_reference_job] stop failed")
        try:
            stop_stock_dealer_trade_job()
        except Exception as e:
            logger.exception("[stock_dealer_trade_job] stop failed")
        if _withdraw_watcher:
            _withdraw_watcher.stop()
            logger.debug("[withdraw_watcher] stopped")
    finally:
        _withdraw_watcher = None
        _contract_tp_sl_job = None
        _contract_limit_order_job = None


@app.on_event("shutdown")
async def _shutdown_contract_private_ws_subscriber():
    await stop_contract_user_event_subscriber()


@app.on_event("shutdown")
async def _shutdown_spot_private_event_bridge():
    await stop_spot_private_event_relay()
    await stop_spot_private_event_subscriber()


# =========================
# Basic endpoints
# =========================
@app.get("/health")
def health():
    return {"ok": True}


@app.get("/")
def root():
    return {"service": settings.APP_NAME, "status": "running"}
