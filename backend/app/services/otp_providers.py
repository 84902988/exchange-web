import logging
logger = logging.getLogger("otp")

def send_email_code(to_email: str, code: str, purpose: str) -> None:
    logger.warning(f"[EMAIL OTP] to={to_email} purpose={purpose} code={code}")

def send_sms_code(to_phone: str, code: str, purpose: str) -> None:
    logger.warning(f"[SMS OTP] to={to_phone} purpose={purpose} code={code}")
