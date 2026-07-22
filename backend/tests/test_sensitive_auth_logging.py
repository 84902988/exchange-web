from pathlib import Path


BACKEND_ROOT = Path(__file__).resolve().parents[1]


def _read(relative_path: str) -> str:
    return (BACKEND_ROOT / relative_path).read_text(encoding="utf-8")


def test_auth_and_withdraw_logs_do_not_include_email_or_verification_code_values():
    auth_source = _read("app/routers/auth.py")
    withdraw_source = _read("app/routers/asset_withdraw.py")

    assert "LOGIN ENTER email=" not in auth_source
    assert 'logger.info("auth_register_attempt trace_id=%s", trace_id)' in auth_source
    assert "email={to_email}" not in withdraw_source
    assert "code={code}" not in withdraw_source
    assert "withdraw_send_code_email_enqueued" in withdraw_source


def test_email_workers_do_not_log_recipient_or_secret_values():
    email_tasks_source = _read("app/tasks/email_tasks.py")
    otp_provider_source = _read("app/services/otp_providers.py")

    assert "to_email=%s" not in email_tasks_source
    assert "to={to_email}" not in otp_provider_source
    assert "to={to_phone}" not in otp_provider_source
    assert "code={code}" not in otp_provider_source
    assert "email_otp_provider_invoked purpose=%s" in otp_provider_source
    assert "sms_otp_provider_invoked purpose=%s" in otp_provider_source
