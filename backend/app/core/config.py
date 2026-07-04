# app/core/config.py
from pathlib import Path
from typing import Optional
from urllib.parse import quote_plus

from pydantic_settings import BaseSettings, SettingsConfigDict

BASE_DIR = Path(__file__).resolve().parents[2]  # backend/
ENV_FILE = BASE_DIR / ".env"


class Settings(BaseSettings):
    # =====================
    # App
    # =====================
    APP_NAME: str = "exchange-api"

    # =====================
    # Database
    # =====================
    DB_HOST: str
    DB_PORT: int = 3306
    DB_USER: str
    DB_PASSWORD: str
    DB_NAME: str
    DB_POOL_SIZE: int = 10
    DB_MAX_OVERFLOW: int = 20
    DB_POOL_TIMEOUT: int = 30
    DB_POOL_RECYCLE: int = 3600
    DB_POOL_PRE_PING: bool = True

    # =====================
    # Security / JWT
    # =====================
    # 你原来的字段保留：JWT_SECRET
    JWT_SECRET: str

    # ✅ 新增：JWT 标准字段（正式上线会用到）
    JWT_ALGORITHM: str = "HS256"
    JWT_ACCESS_TOKEN_EXPIRE_MINUTES: int = 15
    JWT_REFRESH_TOKEN_EXPIRE_DAYS: int = 30
    JWT_SESSION_REFRESH_TOKEN_EXPIRE_SECONDS: int = 12 * 60 * 60

    # Pepper（你原有）
    SECURITY_PEPPER: Optional[str] = None

    # =====================
    # Cookie / Auth (Step 1 ✅ 新增)
    # =====================
    # 说明：
    # - Web 端根治登录态：后端 Set-Cookie(HttpOnly) 存 refresh_token（可选也存 access_token）
    # - 本地开发一般 http：COOKIE_SECURE=False, COOKIE_SAMESITE="lax"
    # - 若前后端跨域且需要第三方 cookie：COOKIE_SAMESITE="none" 且 COOKIE_SECURE=True（必须 https）
    COOKIE_DOMAIN: Optional[str] = None   # 线上可设 ".royalex.world"；本地保持 None
    COOKIE_SECURE: bool = False           # 线上 https 必须 True
    COOKIE_SAMESITE: str = "lax"          # "lax" | "none"
    COOKIE_PATH: str = "/"
    CORS_ORIGINS: Optional[str] = None
    CORS_ALLOW_ORIGINS: str = "http://localhost:3000,http://127.0.0.1:3000,http://192.168.31.57:3000,https://moralis-hook.zaf.cpolar.io"
    GEO_ACCESS_ENABLED: bool = False
    GEO_ACCESS_MONITOR_MODE: bool = True
    GEO_ACCESS_BLOCK_UNKNOWN: bool = False
    GEO_ACCESS_ADMIN_EXEMPT: bool = False
    GEO_ACCESS_RESTRICTED_COUNTRIES: str = ""
    GEO_ACCESS_TRUST_CF_HEADER: bool = True
    GEOIP_DB_PATH: str = ""
    GEO_RESTRICTION_ENABLED: bool = False
    GEO_RESTRICTED_COUNTRIES: str = ""
    GEO_RESTRICTION_HEADER: str = "CF-IPCountry"
    DB_LIFECYCLE_CLEANUP_ENABLED: bool = False
    DB_LIFECYCLE_CLEANUP_DRY_RUN: bool = True
    DB_LIFECYCLE_CLEANUP_ALLOW_EXECUTE: bool = False
    DB_LIFECYCLE_CLEANUP_EXECUTE_CONFIRM: str = ""
    DB_LIFECYCLE_CLEANUP_RETENTION_DAYS: int = 90
    DB_LIFECYCLE_CLEANUP_ENQUEUE_INTERVAL_SECONDS: int = 24 * 60 * 60

    # Cookie Max-Age（秒）
    ACCESS_TOKEN_MAX_AGE: int = 60 * 15          # 15 minutes
    REFRESH_TOKEN_MAX_AGE: int = 60 * 60 * 24 * 30  # 30 days（与 JWT_REFRESH_TOKEN_EXPIRE_DAYS 对齐）

    # Cookie 名称（统一管理，后面 middleware/layout 都用它）
    ACCESS_TOKEN_COOKIE_NAME: str = "access_token"
    REFRESH_TOKEN_COOKIE_NAME: str = "refresh_token"

    # =====================
    # Login Security
    # =====================
    LOGIN_FAIL_TTL_SECONDS: int = 15 * 60
    LOGIN_LOCK_SECONDS: int = 15 * 60
    LOGIN_CAPTCHA_TTL_SECONDS: int = 5 * 60
    LOGIN_CAPTCHA_THRESHOLD: int = 3
    LOGIN_LOCK_THRESHOLD: int = 5

    # =====================
    # Redis
    # =====================
    REDIS_HOST: str = "127.0.0.1"
    REDIS_PORT: int = 6379
    REDIS_DB: int = 0
    REDIS_PASSWORD: Optional[str] = None

    # ✅ 新增：Redis Key 前缀（避免多项目冲突）
    REDIS_KEY_PREFIX: str = "exchange"

    # =====================
    # Contract CFD V1
    # =====================
    CONTRACT_CFD_ENABLED: bool = False
    CONTRACT_CFD_DEFAULT_MARGIN_ASSET: str = "USDT"
    CONTRACT_CFD_MAX_LEVERAGE: int = 200
    CONTRACT_CFD_USE_LAST_VALID_PRICE: bool = True
    CONTRACT_CFD_DEFAULT_MAKER_FEE_RATE: str = "0.0002"
    CONTRACT_CFD_DEFAULT_TAKER_FEE_RATE: str = "0.0004"
    BINANCE_USDM_BASE_URL: str = "https://fapi.binance.com"
    BINANCE_USDM_FALLBACK_BASE_URLS: str = ""
    BINANCE_USDM_USE_ENV_PROXY: bool = False
    CONTRACT_PROVIDER_WS_ENABLED: bool = False
    CONTRACT_PROVIDER_WS_DEPTH_ENABLED: bool = False
    CONTRACT_PROVIDER_WS_DEPTH_MAX_AGE_MS: int = 1500
    CONTRACT_PROVIDER_WS_DEPTH_BROADCAST_INTERVAL_MS: int = 200
    CONTRACT_PROVIDER_WS_DEPTH_LIMIT: int = 20
    CONTRACT_PROVIDER_WS_TRADES_ENABLED: bool = False
    CONTRACT_PROVIDER_WS_TRADES_MAX_AGE_MS: int = 1500
    CONTRACT_PROVIDER_WS_TRADES_LIMIT: int = 30
    CONTRACT_PROVIDER_WS_TICKER_ENABLED: bool = False
    CONTRACT_PROVIDER_WS_TICKER_MAX_AGE_MS: int = 1500
    CONTRACT_PROVIDER_WS_KLINE_ENABLED: bool = False
    CONTRACT_PROVIDER_WS_KLINE_MAX_AGE_MS: int = 1500
    CONTRACT_PROVIDER_WS_ITICK_KLINE_ENABLED: bool = False
    CONTRACT_PROVIDER_WS_ITICK_KLINE_MAX_AGE_MS: int = 90000
    CONTRACT_PROVIDER_WS_ITICK_KLINE_BROADCAST_INTERVAL_MS: int = 1000
    CONTRACT_PROVIDER_WS_OKX_PUBLIC_URL: str = "wss://ws.okx.com:8443/ws/v5/public"
    CONTRACT_PROVIDER_WS_OKX_BUSINESS_URL: str = "wss://ws.okx.com:8443/ws/v5/business"
    CONTRACT_PROVIDER_WS_ITICK_ENABLED: bool = False
    CONTRACT_PROVIDER_WS_ITICK_TRADES_ENABLED: bool = False
    CONTRACT_PROVIDER_WS_ITICK_URL: str = "wss://api.itick.org"
    SPOT_PROVIDER_WS_TICKER_MAX_AGE_MS: int = 1500
    SPOT_PROVIDER_WS_TICKER_BROADCAST_INTERVAL_MS: int = 500
    SPOT_PROVIDER_WS_TRADES_MAX_AGE_MS: int = 1500
    SPOT_PROVIDER_WS_TRADES_LIMIT: int = 30
    SPOT_PROVIDER_WS_TRADES_BROADCAST_INTERVAL_MS: int = 200
    SPOT_PROVIDER_WS_KLINE_MAX_AGE_MS: int = 1500
    SPOT_PROVIDER_WS_KLINE_LIMIT: int = 300
    SPOT_PROVIDER_WS_KLINE_BROADCAST_INTERVAL_MS: int = 1000
    SPOT_PROVIDER_WS_DEPTH_MAX_AGE_MS: int = 1500
    SPOT_PROVIDER_WS_DEPTH_BROADCAST_INTERVAL_MS: int = 200
    SPOT_PROVIDER_WS_DEPTH_LIMIT: int = 20
    SPOT_PROVIDER_WS_IDLE_STOP_SECONDS: int = 10
    SPOT_PROVIDER_WS_BITGET_PUBLIC_URL: str = "wss://ws.bitget.com/v2/ws/public"
    SPOT_PROVIDER_WS_OKX_PUBLIC_URL: str = "wss://ws.okx.com:8443/ws/v5/public"
    SPOT_PROVIDER_WS_OKX_BUSINESS_URL: str = "wss://ws.okx.com:8443/ws/v5/business"
    ITICK_API_TOKEN: Optional[str] = None
    ITICK_API_KEY: Optional[str] = None  # legacy alias; prefer ITICK_API_TOKEN
    ITICK_BASE_URL: str = "https://api.itick.org"
    COMMODITIES_API_BASE_URL: str = "https://commodities-api.com/api"
    COMMODITIES_API_KEY: Optional[str] = None
    RWA_IRON62_MANUAL_USD_PER_TON: Optional[str] = None

    # =====================
    # Email (Alibaba Cloud DirectMail)
    # =====================
    ALIYUN_ACCESS_KEY_ID: str
    ALIYUN_ACCESS_KEY_SECRET: str

    ALIYUN_DM_REGION: str = "ap-southeast-1"
    # 阿里云控制台创建的发信地址
    ALIYUN_DM_ACCOUNT_NAME: str = "no-reply@royalex.world"
    # 发信人昵称
    ALIYUN_DM_FROM_ALIAS: str = "Royal Exchange"

    # =====================
    # Computed URLs
    # =====================
    @property
    def database_url(self) -> str:
        password = quote_plus(self.DB_PASSWORD)
        return (
            f"mysql+pymysql://{self.DB_USER}:{password}"
            f"@{self.DB_HOST}:{self.DB_PORT}"
            f"/{self.DB_NAME}"
            f"?charset=utf8mb4"
        )

    @property
    def redis_url(self) -> str:
        """
        Redis URL for redis/redis.asyncio client
        Supports password and db index.
        """
        auth = ""
        if self.REDIS_PASSWORD:
            auth = f":{quote_plus(self.REDIS_PASSWORD)}@"
        return f"redis://{auth}{self.REDIS_HOST}:{self.REDIS_PORT}/{self.REDIS_DB}"

    model_config = SettingsConfigDict(
        env_file=str(ENV_FILE),
        env_file_encoding="utf-8",
        extra="ignore",
    )


settings = Settings()
