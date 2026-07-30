from app.services.geo_access_service import (
    DECISION_ALLOW,
    DECISION_BLOCK,
    REASON_ADMIN_EXEMPT,
    REASON_COUNTRY_RESTRICTED,
    RULE_ALLOW,
    RULE_BLOCK,
    GeoAccessConfig,
    GeoAccessRule,
    evaluate_geo_access,
    load_geo_access_config,
    merge_system_restricted_countries,
    update_geo_access_settings,
)
from app.db.models.geo_access import GeoAccessSettings


class _SettingsQuery:
    def __init__(self, row: GeoAccessSettings):
        self.row = row

    def order_by(self, *_args):
        return self

    def first(self):
        return self.row


class _SettingsDb:
    def __init__(self, row: GeoAccessSettings):
        self.row = row

    def query(self, _model):
        return _SettingsQuery(self.row)

    def add(self, row):
        self.row = row

    def flush(self):
        return None


def _config(**overrides) -> GeoAccessConfig:
    values = {
        "enabled": False,
        "monitor_mode": True,
        "block_unknown": False,
        "restricted_countries": tuple(),
        "admin_exempt": False,
    }
    values.update(overrides)
    return GeoAccessConfig(**values)


def test_cn_public_traffic_is_blocked_even_when_disabled_monitored_and_allowlisted():
    decision = evaluate_geo_access(
        config=_config(),
        rules=[GeoAccessRule(RULE_ALLOW, "203.0.113.0/24")],
        ip_address="203.0.113.8",
        country_code="CN",
        path="/contract",
    )

    assert decision.decision == DECISION_BLOCK
    assert decision.reason == REASON_COUNTRY_RESTRICTED
    assert decision.should_block is True


def test_cn_admin_route_is_always_exempt_even_when_ip_is_blocklisted():
    decision = evaluate_geo_access(
        config=_config(enabled=True),
        rules=[GeoAccessRule(RULE_BLOCK, "203.0.113.0/24")],
        ip_address="203.0.113.8",
        country_code="CN",
        path="/admin/dashboard",
    )

    assert decision.decision == DECISION_ALLOW
    assert decision.reason == REASON_ADMIN_EXEMPT
    assert decision.should_block is False


def test_system_country_is_merged_with_operator_countries_without_duplicates():
    assert merge_system_restricted_countries(["US", "cn", "US"]) == ("CN", "US")


def test_non_cn_traffic_still_respects_operator_enabled_state():
    decision = evaluate_geo_access(
        config=_config(),
        rules=[],
        ip_address="203.0.113.8",
        country_code="US",
        path="/contract",
    )

    assert decision.decision == DECISION_ALLOW
    assert decision.should_block is False


def test_database_values_cannot_disable_system_policy():
    row = GeoAccessSettings(
        id=1,
        enabled=False,
        monitor_mode=True,
        block_unknown=False,
        restricted_countries_json='["US"]',
        admin_exempt=False,
    )

    config = load_geo_access_config(_SettingsDb(row))

    assert config.enabled is True
    assert config.monitor_mode is False
    assert config.admin_exempt is True
    assert config.restricted_countries == ("CN", "US")


def test_crafted_admin_update_cannot_remove_system_policy():
    row = GeoAccessSettings(
        id=1,
        enabled=True,
        monitor_mode=False,
        block_unknown=False,
        restricted_countries_json='["CN"]',
        admin_exempt=True,
    )
    db = _SettingsDb(row)

    updated = update_geo_access_settings(
        db,
        enabled=False,
        monitor_mode=True,
        block_unknown=True,
        admin_exempt=False,
        restricted_countries=["US"],
    )

    assert updated.enabled is True
    assert updated.monitor_mode is False
    assert updated.admin_exempt is True
    assert updated.block_unknown is True
    assert updated.restricted_countries_json == '["CN", "US"]'
