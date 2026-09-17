from app.services import email_service


def test_email_brand_uses_config_and_escapes_html(monkeypatch):
    monkeypatch.setattr(email_service.settings, 'ALIYUN_DM_FROM_ALIAS', 'Example <Trade>\r\n')
    assert email_service._subject('login', '123456') == 'Example <Trade> login code: 123456'
    text, html = email_service._bodies('login', '123456', 10)
    assert 'Example <Trade>' in text
    assert 'Example &lt;Trade&gt;' in html
    assert '<Trade>' not in html


def test_email_brand_has_neutral_fallback(monkeypatch):
    monkeypatch.setattr(email_service.settings, 'ALIYUN_DM_FROM_ALIAS', '')
    assert email_service._subject('register', '123456') == 'Exchange verification code: 123456'
