from __future__ import annotations

from datetime import datetime
from decimal import Decimal, InvalidOperation, ROUND_DOWN
from typing import Any, Dict, Optional

from sqlalchemy import select
from sqlalchemy.orm import Session, joinedload

from app.db.models.asset import UserBalance
from app.db.models.dealer_risk_hit_log import DealerRiskHitLog
from app.db.models.dealer_risk_limit import DealerRiskLimit
from app.db.models.trading_pair import TradingPair

PLATFORM_USER_ID = 99999999
SPOT_CHAIN_KEY = "spot"
AMOUNT_SCALE = Decimal("1").scaleb(-18)
ACTIVE_STATUS = "ACTIVE"
PAUSED_STATUS = "PAUSED"
RISK_SINGLE_NOTIONAL = "MAX_SINGLE_NOTIONAL"
RISK_BASE_POSITION = "MAX_NET_BASE_POSITION"
RISK_QUOTE_EXPOSURE = "MAX_NET_QUOTE_EXPOSURE"
RISK_DISABLED = "DEALER_DISABLED"
RISK_PAUSED = "DEALER_PAUSED"


class DealerRiskRejected(ValueError):
    pass


def _normalize_symbol(value: Any) -> str:
    return str(value or "").strip().upper()


def _normalize_code(value: Any) -> str:
    return str(value or "").strip().upper()


def _to_decimal(value: Any, *, default: Optional[Decimal] = None) -> Optional[Decimal]:
    if value is None:
        return default
    if isinstance(value, Decimal):
        return value.quantize(AMOUNT_SCALE, rounding=ROUND_DOWN)
    try:
        return Decimal(str(value)).quantize(AMOUNT_SCALE, rounding=ROUND_DOWN)
    except (InvalidOperation, ValueError, TypeError):
        return default


def _get_pair_by_symbol(db: Session, symbol: str) -> Optional[TradingPair]:
    stmt = (
        select(TradingPair)
        .options(
            joinedload(TradingPair.base_asset),
            joinedload(TradingPair.quote_asset),
        )
        .where(TradingPair.symbol == symbol)
    )
    return db.execute(stmt).scalar_one_or_none()


def _get_locked_balance_total(
    db: Session,
    *,
    user_id: int,
    coin_symbol: str,
    chain_key: str = SPOT_CHAIN_KEY,
) -> Decimal:
    stmt = (
        select(UserBalance)
        .where(
            UserBalance.user_id == user_id,
            UserBalance.coin_symbol == coin_symbol,
            UserBalance.chain_key == chain_key,
        )
        .with_for_update()
    )
    balance = db.execute(stmt).scalar_one_or_none()
    if not balance:
        return Decimal("0")

    available = Decimal(str(balance.available_amount or 0))
    frozen = Decimal(str(balance.frozen_amount or 0))
    return (available + frozen).quantize(AMOUNT_SCALE, rounding=ROUND_DOWN)


def _record_risk_hit(
    db: Session,
    *,
    symbol: str,
    order_id: Optional[int],
    user_id: Optional[int],
    risk_type: str,
    risk_value: Decimal,
    limit_value: Decimal,
    message: str,
) -> None:
    db.add(
        DealerRiskHitLog(
            symbol=symbol,
            order_id=order_id,
            user_id=user_id,
            risk_type=risk_type,
            risk_value=risk_value.quantize(AMOUNT_SCALE, rounding=ROUND_DOWN),
            limit_value=limit_value.quantize(AMOUNT_SCALE, rounding=ROUND_DOWN),
            message=message[:255],
            created_at=datetime.utcnow(),
        )
    )
    db.flush()


def _reject(
    db: Session,
    *,
    symbol: str,
    order_id: Optional[int],
    user_id: Optional[int],
    risk_type: str,
    risk_value: Decimal,
    limit_value: Decimal,
    message: str,
) -> None:
    _record_risk_hit(
        db,
        symbol=symbol,
        order_id=order_id,
        user_id=user_id,
        risk_type=risk_type,
        risk_value=risk_value,
        limit_value=limit_value,
        message=message,
    )
    raise DealerRiskRejected(message)


def check_dealer_order_risk(
    db: Session,
    symbol: str,
    side: str,
    order_type: str,
    amount: Any,
    quote_amount: Any,
    ref_price: Any,
    order_id: Optional[int] = None,
    user_id: Optional[int] = None,
) -> Dict[str, Any]:
    normalized_symbol = _normalize_symbol(symbol)
    if not normalized_symbol:
        raise DealerRiskRejected("Dealer 风控缺少有效交易对")

    limit = (
        db.query(DealerRiskLimit)
        .filter(DealerRiskLimit.symbol == normalized_symbol)
        .first()
    )
    if not limit:
        return {"allowed": True, "symbol": normalized_symbol, "configured": False}

    if int(limit.enabled or 0) != 1:
        _reject(
            db,
            symbol=normalized_symbol,
            order_id=order_id,
            user_id=user_id,
            risk_type=RISK_DISABLED,
            risk_value=Decimal("0"),
            limit_value=Decimal("0"),
            message=f"{normalized_symbol} 的 Dealer 已关闭，当前不允许成交",
        )

    if _normalize_code(limit.status) == PAUSED_STATUS:
        _reject(
            db,
            symbol=normalized_symbol,
            order_id=order_id,
            user_id=user_id,
            risk_type=RISK_PAUSED,
            risk_value=Decimal("0"),
            limit_value=Decimal("0"),
            message=f"{normalized_symbol} 的 Dealer 已暂停，当前不允许成交",
        )

    pair = _get_pair_by_symbol(db, normalized_symbol)
    if not pair or not pair.base_asset or not pair.quote_asset:
        raise DealerRiskRejected(f"{normalized_symbol} 交易对配置无效，无法执行 Dealer 风控")

    normalized_side = _normalize_code(side)
    normalized_order_type = _normalize_code(order_type)
    amount_decimal = _to_decimal(amount, default=Decimal("0")) or Decimal("0")
    quote_amount_decimal = _to_decimal(quote_amount)
    ref_price_decimal = _to_decimal(ref_price)

    if amount_decimal <= 0:
        raise DealerRiskRejected("Dealer 风控缺少有效成交数量")

    if normalized_side == "BUY":
        notional = quote_amount_decimal
        if notional is None:
            if ref_price_decimal is None or ref_price_decimal <= 0:
                raise DealerRiskRejected("Dealer 风控缺少有效参考价格")
            notional = (ref_price_decimal * amount_decimal).quantize(AMOUNT_SCALE, rounding=ROUND_DOWN)
    elif normalized_side == "SELL":
        if ref_price_decimal is None or ref_price_decimal <= 0:
            raise DealerRiskRejected("Dealer 风控缺少有效参考价格")
        notional = (ref_price_decimal * amount_decimal).quantize(AMOUNT_SCALE, rounding=ROUND_DOWN)
    else:
        raise DealerRiskRejected(f"不支持的 Dealer 方向：{normalized_side or '-'}")

    if notional <= 0:
        raise DealerRiskRejected("Dealer 风控计算出的成交额无效")

    max_single_notional = _to_decimal(limit.max_single_notional)
    if max_single_notional is not None and max_single_notional > 0 and notional > max_single_notional:
        _reject(
            db,
            symbol=normalized_symbol,
            order_id=order_id,
            user_id=user_id,
            risk_type=RISK_SINGLE_NOTIONAL,
            risk_value=notional,
            limit_value=max_single_notional,
            message=(
                f"{normalized_symbol} 单笔成交额超限："
                f"当前 {notional}，限制 {max_single_notional}"
            ),
        )

    current_base_total = _get_locked_balance_total(
        db,
        user_id=PLATFORM_USER_ID,
        coin_symbol=pair.base_asset.symbol,
        chain_key=SPOT_CHAIN_KEY,
    )
    current_quote_total = _get_locked_balance_total(
        db,
        user_id=PLATFORM_USER_ID,
        coin_symbol=pair.quote_asset.symbol,
        chain_key=SPOT_CHAIN_KEY,
    )

    if normalized_side == "BUY":
        projected_base_total = current_base_total - amount_decimal
        projected_quote_total = current_quote_total + notional
    else:
        projected_base_total = current_base_total + amount_decimal
        projected_quote_total = current_quote_total - notional

    base_exposure = abs(projected_base_total).quantize(AMOUNT_SCALE, rounding=ROUND_DOWN)
    quote_exposure = abs(projected_quote_total).quantize(AMOUNT_SCALE, rounding=ROUND_DOWN)

    max_net_base_position = _to_decimal(limit.max_net_base_position)
    if max_net_base_position is not None and max_net_base_position > 0 and base_exposure > max_net_base_position:
        _reject(
            db,
            symbol=normalized_symbol,
            order_id=order_id,
            user_id=user_id,
            risk_type=RISK_BASE_POSITION,
            risk_value=base_exposure,
            limit_value=max_net_base_position,
            message=(
                f"{normalized_symbol} 平台 Base 净敞口超限："
                f"预计 {base_exposure}，限制 {max_net_base_position}"
            ),
        )

    max_net_quote_exposure = _to_decimal(limit.max_net_quote_exposure)
    if max_net_quote_exposure is not None and max_net_quote_exposure > 0 and quote_exposure > max_net_quote_exposure:
        _reject(
            db,
            symbol=normalized_symbol,
            order_id=order_id,
            user_id=user_id,
            risk_type=RISK_QUOTE_EXPOSURE,
            risk_value=quote_exposure,
            limit_value=max_net_quote_exposure,
            message=(
                f"{normalized_symbol} 平台 Quote 敞口超限："
                f"预计 {quote_exposure}，限制 {max_net_quote_exposure}"
            ),
        )

    return {
        "allowed": True,
        "configured": True,
        "symbol": normalized_symbol,
        "order_type": normalized_order_type,
        "side": normalized_side,
        "notional": notional,
        "projected_base_total": projected_base_total,
        "projected_quote_total": projected_quote_total,
        "base_exposure": base_exposure,
        "quote_exposure": quote_exposure,
    }
