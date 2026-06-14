from __future__ import annotations

from typing import Optional

from app.core.config import settings

from alibabacloud_tea_openapi import models as open_api_models
from alibabacloud_dm20151123.client import Client as DmClient
from alibabacloud_dm20151123 import models as dm_models


class EmailSendError(RuntimeError):
    pass


# 轻量缓存：避免每次请求都新建 client（可选，但建议）
_DM_CLIENT: Optional[DmClient] = None


def _build_client() -> DmClient:
    config = open_api_models.Config(
        access_key_id=settings.ALIYUN_ACCESS_KEY_ID,
        access_key_secret=settings.ALIYUN_ACCESS_KEY_SECRET,
        region_id=settings.ALIYUN_DM_REGION,
    )
    # 你现在这样拼 endpoint 是没问题的
    config.endpoint = f"dm.{settings.ALIYUN_DM_REGION}.aliyuncs.com"
    return DmClient(config)


def _get_client() -> DmClient:
    global _DM_CLIENT
    if _DM_CLIENT is None:
        _DM_CLIENT = _build_client()
    return _DM_CLIENT


def _subject(scene: str, code: str) -> str:
    # 固定风格：更像事务型验证码
    if scene == "login":
        return f"Royalex login code: {code}"
    if scene == "reset":
        return f"Royalex password reset code: {code}"
    return f"Royalex verification code: {code}"


def _bodies(scene: str, code: str, expire_minutes: int) -> tuple[str, str]:
    # TextBody：强烈建议带，全球投递更稳
    text_body = (
        f"Your Royalex verification code is: {code}\n\n"
        f"This code expires in {expire_minutes} minutes.\n\n"
        "If you didn’t request this, you can ignore this email.\n"
    )

    # HtmlBody：极简，不放链接/按钮/图片
    title = "Verification code"
    if scene == "login":
        title = "Login code"
    elif scene == "reset":
        title = "Password reset code"
    elif scene == "register":
        title = "Sign-up code"

    html_body = f"""
    <div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#111">
      <p><b>{title}</b></p>
      <p>Your Royalex verification code is:</p>
      <p style="font-size:22px;font-weight:bold;letter-spacing:2px;margin:8px 0">{code}</p>
      <p>This code expires in <b>{expire_minutes} minutes</b>.</p>
      <p style="color:#666">If you didn’t request this, you can ignore this email.</p>
    </div>
    """.strip()

    return text_body, html_body


def send_email_message(
    *,
    to_email: str,
    subject: str,
    text_body: str,
    html_body: str,
    from_alias: Optional[str] = None,
) -> None:
    client = _get_client()

    req = dm_models.SingleSendMailRequest(
        account_name=settings.ALIYUN_DM_ACCOUNT_NAME,
        from_alias=from_alias or settings.ALIYUN_DM_FROM_ALIAS,
        address_type=1,
        reply_to_address=False,
        to_address=to_email,
        subject=subject,
        text_body=text_body,
        html_body=html_body,
    )

    try:
        client.single_send_mail(req)
    except Exception as e:
        raise EmailSendError(str(e)) from e


def send_verify_code_email(
    to_email: str,
    code: str,
    *,
    scene: str = "register",              # register | login | reset
    expire_minutes: int = 10,
    subject: Optional[str] = None,
    from_alias: Optional[str] = None,
) -> None:
    real_subject = subject or _subject(scene, code)
    text_body, html_body = _bodies(scene, code, expire_minutes)
    send_email_message(
        to_email=to_email,
        subject=real_subject,
        text_body=text_body,
        html_body=html_body,
        from_alias=from_alias,
    )
