from __future__ import annotations

import logging
from typing import Optional

from app.core.rq import QUEUE_EMAIL, get_queue
from app.services.email_service import EmailSendError, send_email_message, send_verify_code_email


logger = logging.getLogger(__name__)

EMAIL_JOB_MAX_RETRIES = 3


def _validate_email_job_args(*, to_email: str, code: str, scene: str, expire_minutes: int) -> Optional[str]:
    if not str(to_email or "").strip():
        return "to_email is required"
    if not str(code or "").strip():
        return "code is required"
    if int(expire_minutes or 0) <= 0:
        return "expire_minutes must be positive"
    if len(str(scene or "").strip()) > 50:
        return "scene is too long"
    return None


def send_email_job(*, to_email: str, subject: str, text_body: str, html_body: str, from_alias: str | None = None) -> dict:
    if not str(to_email or "").strip() or not str(subject or "").strip():
        logger.error("email job parameter error: to_email/subject required")
        return {"ok": False, "retryable": False, "error": "INVALID_EMAIL_JOB_ARGS"}
    if not str(text_body or "").strip() and not str(html_body or "").strip():
        logger.error("email job parameter error: body required")
        return {"ok": False, "retryable": False, "error": "INVALID_EMAIL_JOB_ARGS"}

    try:
        send_email_message(
            to_email=str(to_email).strip(),
            subject=str(subject).strip(),
            text_body=str(text_body or ""),
            html_body=str(html_body or ""),
            from_alias=from_alias,
        )
    except EmailSendError:
        logger.exception("email job send failed: to_email=%s subject=%s", to_email, subject)
        raise
    except Exception:
        logger.exception("email job unexpected failure: to_email=%s subject=%s", to_email, subject)
        raise

    logger.info("email job sent: to_email=%s subject=%s", to_email, subject)
    return {"ok": True, "to_email": str(to_email).strip()}


def send_verify_code_email_job(
    *,
    to_email: str,
    code: str,
    scene: str = "register",
    expire_minutes: int = 10,
    subject: str | None = None,
    from_alias: str | None = None,
) -> dict:
    error = _validate_email_job_args(
        to_email=to_email,
        code=code,
        scene=scene,
        expire_minutes=expire_minutes,
    )
    if error:
        logger.error("verify email job parameter error: %s", error)
        return {"ok": False, "retryable": False, "error": error}

    try:
        send_verify_code_email(
            to_email=str(to_email).strip(),
            code=str(code).strip(),
            scene=str(scene or "register").strip(),
            expire_minutes=int(expire_minutes),
            subject=subject,
            from_alias=from_alias,
        )
    except EmailSendError:
        logger.exception("verify email job send failed: to_email=%s scene=%s", to_email, scene)
        raise
    except Exception:
        logger.exception("verify email job unexpected failure: to_email=%s scene=%s", to_email, scene)
        raise

    logger.info("verify email job sent: to_email=%s scene=%s", to_email, scene)
    return {"ok": True, "to_email": str(to_email).strip(), "scene": str(scene or "register").strip()}


def enqueue_send_verify_code_email(
    *,
    to_email: str,
    code: str,
    scene: str = "register",
    expire_minutes: int = 10,
    subject: str | None = None,
    from_alias: str | None = None,
) -> str:
    try:
        from rq import Retry
    except ModuleNotFoundError:
        Retry = None

    kwargs = {
        "to_email": str(to_email).strip(),
        "code": str(code).strip(),
        "scene": str(scene or "register").strip(),
        "expire_minutes": int(expire_minutes),
        "subject": subject,
        "from_alias": from_alias,
    }
    queue = get_queue(QUEUE_EMAIL)
    enqueue_kwargs = {
        "func": send_verify_code_email_job,
        "kwargs": kwargs,
        "description": f"send verify email scene={kwargs['scene']} to={kwargs['to_email']}",
    }
    if Retry is not None:
        enqueue_kwargs["retry"] = Retry(max=EMAIL_JOB_MAX_RETRIES, interval=[30, 120, 300])
    job = queue.enqueue_call(**enqueue_kwargs)
    return str(job.id)
