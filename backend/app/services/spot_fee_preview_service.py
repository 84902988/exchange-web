from decimal import Decimal

from sqlalchemy.orm import Session

from app.db.models.asset import UserBalance
from app.db.models.user_fee_preference import UserFeePreference
from app.services.fee_service import SPOT_BALANCE_CHAIN_KEY, load_rcb_last_trade_price
from app.services.spot_fee_settings_service import load_spot_fee_settings


def get_spot_fee_payment_context(db: Session, user_id: int) -> dict:
    """Read preview inputs without creating preferences, balances, or locks."""
    settings = load_spot_fee_settings(db)
    preference = db.query(UserFeePreference).filter(
        UserFeePreference.user_id == user_id
    ).first()
    balance = db.query(UserBalance).filter(
        UserBalance.user_id == user_id,
        UserBalance.coin_symbol == "RCB",
        UserBalance.chain_key == SPOT_BALANCE_CHAIN_KEY,
    ).first()
    price = load_rcb_last_trade_price(db)
    return {
        "use_rcb_fee": bool(preference.use_rcb_fee) if preference else False,
        "spot_rcb_fee_enabled": settings.spot_rcb_fee_enabled,
        "rcb_fee_discount_rate": str(settings.rcb_fee_discount_rate),
        "min_rcb_fee_amount": str(settings.min_rcb_fee_amount),
        "rcb_spot_available": str(balance.available_amount if balance else Decimal("0")),
        "rcb_usdt_price": str(price) if price is not None else None,
    }
