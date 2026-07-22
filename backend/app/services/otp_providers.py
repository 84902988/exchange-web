import logging
logger = logging.getLogger("otp")

def send_email_code(to_email: str, code: str, purpose: str) -> None:
    logger.warning("email_otp_provider_invoked purpose=%s", purpose)

def send_sms_code(to_phone: str, code: str, purpose: str) -> None:
    logger.warning("sms_otp_provider_invoked purpose=%s", purpose)
