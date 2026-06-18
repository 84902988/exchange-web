from __future__ import annotations

import logging

from fastapi import APIRouter, Request

from app.core.config import settings
from app.db.session import SessionLocal
from app.middleware.geo_restriction import get_request_ip
from app.services.geo_access_service import (
    DECISION_BLOCK,
    DECISION_MONITOR,
    evaluate_geo_access,
    list_enabled_geo_ip_rules,
    load_geo_access_config,
    resolve_country_code,
    safe_commit_geo_access_log,
)


logger = logging.getLogger(__name__)

router = APIRouter(tags=["geo-access"])

GEO_ACCESS_RESTRICTED_MESSAGE = "当前地区暂不提供服务"


@router.get("/geo-access/check")
def geo_access_check(request: Request):
    ip_address = get_request_ip(request)
    path = (request.headers.get("x-geo-access-path") or request.headers.get("x-original-path") or "").strip()
    if not path:
        path = "/"

    db = SessionLocal()
    try:
        config = load_geo_access_config(db)
        rules = list_enabled_geo_ip_rules(db)
        db.commit()

        country = resolve_country_code(
            headers=request.headers if config.enabled else {},
            ip_address=ip_address,
            geoip_db_path=str(getattr(settings, "GEOIP_DB_PATH", "") or "") if config.enabled else "",
            trust_cf_header=bool(getattr(settings, "GEO_ACCESS_TRUST_CF_HEADER", True)),
        )
        decision = evaluate_geo_access(
            config=config,
            rules=rules,
            ip_address=ip_address,
            country_code=country.country_code,
            path=path,
        )

        if decision.decision in {DECISION_BLOCK, DECISION_MONITOR}:
            safe_commit_geo_access_log(
                db,
                ip_address=ip_address,
                country_code=country.country_code,
                source=country.source,
                path=path,
                method="GET",
                user_agent=(request.headers.get("user-agent") or "").strip(),
                decision=decision.decision,
                reason=decision.reason,
            )

        return {
            "allowed": not decision.should_block,
            "decision": decision.decision,
            "reason": decision.reason,
            "country_code": country.country_code,
            "source": country.source,
            "message": GEO_ACCESS_RESTRICTED_MESSAGE,
        }
    finally:
        db.close()
