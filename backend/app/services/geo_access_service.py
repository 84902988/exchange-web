from __future__ import annotations

import ipaddress
import json
import logging
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Iterable, Optional, Sequence

from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.db.models.geo_access import GeoAccessLog, GeoAccessSettings, GeoIpRule


logger = logging.getLogger(__name__)

DECISION_ALLOW = "ALLOW"
DECISION_BLOCK = "BLOCK"
DECISION_MONITOR = "MONITOR"

REASON_ALLOWLIST = "ALLOWLIST"
REASON_BLOCKLIST = "BLOCKLIST"
REASON_COUNTRY_RESTRICTED = "COUNTRY_RESTRICTED"
REASON_UNKNOWN = "UNKNOWN"
REASON_DISABLED = "DISABLED"
REASON_DEFAULT_ALLOW = "DEFAULT_ALLOW"
REASON_LOCAL_PRIVATE = "LOCAL_PRIVATE"
REASON_ADMIN_EXEMPT = "ADMIN_EXEMPT"

SOURCE_CF_HEADER = "CF_HEADER"
SOURCE_LOCAL_DB = "LOCAL_DB"
SOURCE_UNKNOWN = "UNKNOWN"

RULE_ALLOW = "ALLOW"
RULE_BLOCK = "BLOCK"

GEO_ACCESS_LOG_BUCKET_SECONDS = 300
GEO_ACCESS_LOG_RETENTION_DAYS = 90


@dataclass(frozen=True)
class GeoAccessConfig:
    enabled: bool
    monitor_mode: bool
    block_unknown: bool
    restricted_countries: tuple[str, ...]
    admin_exempt: bool


@dataclass(frozen=True)
class GeoAccessRule:
    rule_type: str
    ip_cidr: str
    enabled: bool = True


@dataclass(frozen=True)
class GeoCountryResult:
    country_code: str
    source: str


@dataclass(frozen=True)
class GeoAccessDecision:
    decision: str
    reason: str
    should_block: bool


_LOCAL_OR_PRIVATE_NETWORKS = tuple(
    ipaddress.ip_network(item)
    for item in (
        "127.0.0.0/8",
        "10.0.0.0/8",
        "172.16.0.0/12",
        "192.168.0.0/16",
        "::1/128",
        "fc00::/7",
        "fe80::/10",
    )
)

_geoip_reader = None
_geoip_reader_path = ""
_geoip_reader_mtime: Optional[float] = None
_geoip_reader_unavailable_paths: set[str] = set()


def _truthy(value: object, default: bool = False) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    text = str(value).strip().lower()
    if not text:
        return default
    return text in {"1", "true", "yes", "on"}


def normalize_country_code(value: object) -> str:
    code = str(value or "").strip().upper()
    if not code or code == "XX":
        return "UNKNOWN"
    return code[:8]


def parse_country_list(value: object) -> tuple[str, ...]:
    if value is None:
        return tuple()
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return tuple()
        try:
            parsed = json.loads(text)
            if isinstance(parsed, list):
                items = parsed
            else:
                items = text.replace("\n", ",").replace(" ", ",").split(",")
        except json.JSONDecodeError:
            items = text.replace("\n", ",").replace(" ", ",").split(",")
    elif isinstance(value, Iterable):
        items = list(value)
    else:
        items = [value]

    normalized: list[str] = []
    seen: set[str] = set()
    for item in items:
        code = normalize_country_code(item)
        if code == "UNKNOWN" or code in seen:
            continue
        seen.add(code)
        normalized.append(code)
    return tuple(normalized)


def country_list_json(countries: Sequence[str]) -> str:
    return json.dumps(list(parse_country_list(countries)), ensure_ascii=False)


def env_default_config() -> GeoAccessConfig:
    return GeoAccessConfig(
        enabled=_truthy(getattr(settings, "GEO_ACCESS_ENABLED", False), default=False),
        monitor_mode=_truthy(getattr(settings, "GEO_ACCESS_MONITOR_MODE", True), default=True),
        block_unknown=_truthy(getattr(settings, "GEO_ACCESS_BLOCK_UNKNOWN", False), default=False),
        restricted_countries=parse_country_list(getattr(settings, "GEO_ACCESS_RESTRICTED_COUNTRIES", "")),
        admin_exempt=_truthy(getattr(settings, "GEO_ACCESS_ADMIN_EXEMPT", False), default=False),
    )


def get_or_create_geo_access_settings(db: Session) -> GeoAccessSettings:
    row = db.query(GeoAccessSettings).order_by(GeoAccessSettings.id.asc()).first()
    if row:
        return row

    defaults = env_default_config()
    row = GeoAccessSettings(
        id=1,
        enabled=defaults.enabled,
        monitor_mode=defaults.monitor_mode,
        block_unknown=defaults.block_unknown,
        restricted_countries_json=country_list_json(defaults.restricted_countries),
        admin_exempt=defaults.admin_exempt,
        updated_at=datetime.utcnow(),
    )
    db.add(row)
    db.flush()
    return row


def load_geo_access_config(db: Session) -> GeoAccessConfig:
    row = get_or_create_geo_access_settings(db)
    return GeoAccessConfig(
        enabled=bool(row.enabled),
        monitor_mode=bool(row.monitor_mode),
        block_unknown=bool(row.block_unknown),
        restricted_countries=parse_country_list(row.restricted_countries_json),
        admin_exempt=bool(row.admin_exempt),
    )


def update_geo_access_settings(
    db: Session,
    *,
    enabled: bool,
    monitor_mode: bool,
    block_unknown: bool,
    admin_exempt: bool,
    restricted_countries: object,
) -> GeoAccessSettings:
    row = get_or_create_geo_access_settings(db)
    row.enabled = bool(enabled)
    row.monitor_mode = bool(monitor_mode)
    row.block_unknown = bool(block_unknown)
    row.admin_exempt = bool(admin_exempt)
    row.restricted_countries_json = country_list_json(parse_country_list(restricted_countries))
    row.updated_at = datetime.utcnow()
    db.add(row)
    db.flush()
    return row


def list_enabled_geo_ip_rules(db: Session) -> list[GeoAccessRule]:
    rows = db.query(GeoIpRule).filter(GeoIpRule.enabled.is_(True)).order_by(GeoIpRule.id.asc()).all()
    return [
        GeoAccessRule(
            rule_type=str(row.rule_type or "").strip().upper(),
            ip_cidr=str(row.ip_cidr or "").strip(),
            enabled=bool(row.enabled),
        )
        for row in rows
    ]


def normalize_ip_cidr(value: str) -> str:
    text = str(value or "").strip()
    if not text:
        raise ValueError("IP / CIDR is required")
    network = ipaddress.ip_network(text, strict=False)
    return str(network)


def create_geo_ip_rule(db: Session, *, rule_type: str, ip_cidr: str, note: str = "") -> GeoIpRule:
    normalized_type = str(rule_type or "").strip().upper()
    if normalized_type not in {RULE_ALLOW, RULE_BLOCK}:
        raise ValueError("rule_type must be ALLOW or BLOCK")
    row = GeoIpRule(
        rule_type=normalized_type,
        ip_cidr=normalize_ip_cidr(ip_cidr),
        note=(note or "").strip()[:255] or None,
        enabled=True,
        created_at=datetime.utcnow(),
        updated_at=datetime.utcnow(),
    )
    db.add(row)
    db.flush()
    return row


def set_geo_ip_rule_enabled(db: Session, rule_id: int, enabled: bool) -> Optional[GeoIpRule]:
    row = db.query(GeoIpRule).filter(GeoIpRule.id == int(rule_id)).first()
    if not row:
        return None
    row.enabled = bool(enabled)
    row.updated_at = datetime.utcnow()
    db.add(row)
    db.flush()
    return row


def delete_geo_ip_rule(db: Session, rule_id: int) -> bool:
    row = db.query(GeoIpRule).filter(GeoIpRule.id == int(rule_id)).first()
    if not row:
        return False
    db.delete(row)
    db.flush()
    return True


def is_local_or_private_ip(ip_address: str) -> bool:
    try:
        ip = ipaddress.ip_address(str(ip_address or "").strip())
    except ValueError:
        return False
    return any(ip in network for network in _LOCAL_OR_PRIVATE_NETWORKS)


def ip_matches_cidr(ip_address: str, cidr: str) -> bool:
    try:
        ip = ipaddress.ip_address(str(ip_address or "").strip())
        network = ipaddress.ip_network(str(cidr or "").strip(), strict=False)
    except ValueError:
        return False
    return ip in network


def _matches_rule(ip_address: str, rules: Sequence[GeoAccessRule], rule_type: str) -> bool:
    target_type = rule_type.upper()
    for rule in rules:
        if not rule.enabled or str(rule.rule_type or "").upper() != target_type:
            continue
        if ip_matches_cidr(ip_address, rule.ip_cidr):
            return True
    return False


def evaluate_geo_access(
    *,
    config: GeoAccessConfig,
    rules: Sequence[GeoAccessRule],
    ip_address: str,
    country_code: str,
    path: str,
) -> GeoAccessDecision:
    normalized_country = normalize_country_code(country_code)
    request_path = str(path or "")

    if not config.enabled:
        return GeoAccessDecision(DECISION_ALLOW, REASON_DISABLED, False)
    if is_local_or_private_ip(ip_address):
        return GeoAccessDecision(DECISION_ALLOW, REASON_LOCAL_PRIVATE, False)
    if config.admin_exempt and request_path.startswith("/admin"):
        return GeoAccessDecision(DECISION_ALLOW, REASON_ADMIN_EXEMPT, False)
    if _matches_rule(ip_address, rules, RULE_ALLOW):
        return GeoAccessDecision(DECISION_ALLOW, REASON_ALLOWLIST, False)
    if _matches_rule(ip_address, rules, RULE_BLOCK):
        decision = GeoAccessDecision(DECISION_BLOCK, REASON_BLOCKLIST, True)
    elif normalized_country != "UNKNOWN" and normalized_country in set(config.restricted_countries):
        decision = GeoAccessDecision(DECISION_BLOCK, REASON_COUNTRY_RESTRICTED, True)
    elif normalized_country == "UNKNOWN":
        decision = GeoAccessDecision(
            DECISION_BLOCK if config.block_unknown else DECISION_ALLOW,
            REASON_UNKNOWN,
            bool(config.block_unknown),
        )
    else:
        decision = GeoAccessDecision(DECISION_ALLOW, REASON_DEFAULT_ALLOW, False)

    if decision.should_block and config.monitor_mode:
        return GeoAccessDecision(DECISION_MONITOR, decision.reason, False)
    return decision


def _extract_mmdb_country(record: object) -> str:
    if not isinstance(record, dict):
        return "UNKNOWN"
    candidates = (
        record.get("country"),
        record.get("registered_country"),
        record.get("represented_country"),
    )
    for item in candidates:
        if isinstance(item, dict):
            code = normalize_country_code(item.get("iso_code"))
            if code != "UNKNOWN":
                return code
    return "UNKNOWN"


def lookup_local_geoip_country(ip_address: str, db_path: str = "") -> str:
    global _geoip_reader, _geoip_reader_path, _geoip_reader_mtime

    path_text = str(db_path or getattr(settings, "GEOIP_DB_PATH", "") or "").strip()
    if not path_text:
        return "UNKNOWN"
    path = Path(path_text)
    if not path.exists() or not path.is_file():
        return "UNKNOWN"

    try:
        mtime = path.stat().st_mtime
    except OSError:
        return "UNKNOWN"

    try:
        if _geoip_reader is None or _geoip_reader_path != str(path) or _geoip_reader_mtime != mtime:
            if str(path) in _geoip_reader_unavailable_paths:
                return "UNKNOWN"
            try:
                import maxminddb  # type: ignore
            except ImportError:
                _geoip_reader_unavailable_paths.add(str(path))
                logger.warning("maxminddb package is not installed; GEOIP_DB_PATH will return UNKNOWN")
                return "UNKNOWN"
            if _geoip_reader is not None:
                try:
                    _geoip_reader.close()
                except Exception:
                    pass
            _geoip_reader = maxminddb.open_database(str(path))
            _geoip_reader_path = str(path)
            _geoip_reader_mtime = mtime

        record = _geoip_reader.get(str(ip_address or "").strip())
        return _extract_mmdb_country(record)
    except Exception:
        logger.warning("Failed to lookup local GeoIP country", exc_info=True)
        return "UNKNOWN"


def resolve_country_code(
    *,
    headers: object,
    ip_address: str,
    geoip_db_path: str = "",
    trust_cf_header: bool = True,
) -> GeoCountryResult:
    get_header = getattr(headers, "get", None)
    cf_country = get_header("CF-IPCountry") if callable(get_header) and trust_cf_header else None
    if cf_country:
        return GeoCountryResult(normalize_country_code(cf_country), SOURCE_CF_HEADER)

    local_country = lookup_local_geoip_country(ip_address, geoip_db_path)
    if local_country != "UNKNOWN":
        return GeoCountryResult(local_country, SOURCE_LOCAL_DB)
    return GeoCountryResult("UNKNOWN", SOURCE_UNKNOWN)


def add_geo_access_log(
    db: Session,
    *,
    ip_address: str,
    country_code: str,
    source: str,
    path: str,
    method: str,
    user_agent: str,
    decision: str,
    reason: str,
) -> None:
    normalized_path = str(path or "")[:512]
    normalized_decision = str(decision or DECISION_ALLOW).upper()[:16]
    normalized_reason = str(reason or REASON_DEFAULT_ALLOW).upper()[:32]

    if not should_record_geo_access_log(
        path=normalized_path,
        decision=normalized_decision,
        reason=normalized_reason,
    ):
        return

    now = datetime.utcnow()
    bucket_start = now.replace(second=0, microsecond=0)
    bucket_start = bucket_start - timedelta(
        minutes=bucket_start.minute % (GEO_ACCESS_LOG_BUCKET_SECONDS // 60)
    )
    bucket_end = bucket_start + timedelta(seconds=GEO_ACCESS_LOG_BUCKET_SECONDS)
    normalized_ip = str(ip_address or "")[:45]
    normalized_country = normalize_country_code(country_code)[:8]
    normalized_source = str(source or SOURCE_UNKNOWN)[:16]
    normalized_method = str(method or "GET").upper()[:10]
    normalized_user_agent = str(user_agent or "")[:512]

    existing = (
        db.query(GeoAccessLog)
        .filter(
            GeoAccessLog.ip_address == normalized_ip,
            GeoAccessLog.country_code == normalized_country,
            GeoAccessLog.source == normalized_source,
            GeoAccessLog.decision == normalized_decision,
            GeoAccessLog.reason == normalized_reason,
            GeoAccessLog.created_at >= bucket_start,
            GeoAccessLog.created_at < bucket_end,
        )
        .order_by(GeoAccessLog.last_seen_at.desc(), GeoAccessLog.id.desc())
        .first()
    )
    if existing:
        existing.hit_count = int(existing.hit_count or 1) + 1
        existing.last_seen_at = now
        existing.last_path = normalized_path
        existing.method = normalized_method
        existing.user_agent = normalized_user_agent
        db.add(existing)
        return

    db.add(
        GeoAccessLog(
            ip_address=normalized_ip,
            country_code=normalized_country,
            source=normalized_source,
            path=normalized_path,
            method=normalized_method,
            user_agent=normalized_user_agent,
            decision=normalized_decision,
            reason=normalized_reason,
            created_at=now,
            hit_count=1,
            first_seen_at=now,
            last_seen_at=now,
            last_path=normalized_path,
        )
    )


def should_record_geo_access_log(*, path: str, decision: str, reason: str) -> bool:
    normalized_path = str(path or "")
    normalized_decision = str(decision or "").upper()
    normalized_reason = str(reason or "").upper()

    if normalized_path == "/admin/geo-access" or normalized_path.startswith("/admin/geo-access/"):
        return False
    if normalized_decision == DECISION_BLOCK:
        return True
    if normalized_decision == DECISION_MONITOR and normalized_reason in {
        REASON_BLOCKLIST,
        REASON_COUNTRY_RESTRICTED,
        REASON_UNKNOWN,
    }:
        return True
    if normalized_reason in {REASON_ALLOWLIST, REASON_BLOCKLIST}:
        return True
    if normalized_reason == REASON_UNKNOWN and normalized_decision == DECISION_BLOCK:
        return True
    return False


def cleanup_geo_access_logs(db: Session, *, retention_days: int = GEO_ACCESS_LOG_RETENTION_DAYS) -> int:
    safe_days = max(int(retention_days or GEO_ACCESS_LOG_RETENTION_DAYS), 1)
    cutoff = datetime.utcnow() - timedelta(days=safe_days)
    deleted = (
        db.query(GeoAccessLog)
        .filter(GeoAccessLog.last_seen_at < cutoff)
        .delete(synchronize_session=False)
    )
    db.flush()
    return int(deleted or 0)


def safe_commit_geo_access_log(db: Session, **kwargs: object) -> None:
    try:
        add_geo_access_log(db, **kwargs)
        db.commit()
    except SQLAlchemyError:
        db.rollback()
        logger.warning("Failed to write geo access log", exc_info=True)
