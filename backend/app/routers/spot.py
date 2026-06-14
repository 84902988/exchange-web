from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.deps.auth import get_current_user_id
from app.schemas.spot import (
    SpotBalancesResponse,
    SpotOrdersResponse,
    SpotTradesResponse,
)
from app.services.spot_query import (
    get_current_orders,
    get_history_orders,
    get_my_trades,
    get_spot_balances,
)
from app.services.spot_fee_settings_service import load_spot_fee_settings

router = APIRouter(
    prefix="/spot",
    tags=["spot"]
)


# =========================
# 1. 公开手续费配置
# =========================
@router.get(
    "/fee-settings",
    summary="获取现货手续费配置",
    description="获取前台用于展示和预计手续费计算的现货 RCB 抵扣全局配置。",
)
def spot_fee_settings(db: Session = Depends(get_db)):
    settings = load_spot_fee_settings(db)
    return {
        "spot_rcb_fee_enabled": bool(settings.spot_rcb_fee_enabled),
        "rcb_fee_discount_rate": str(settings.rcb_fee_discount_rate),
        "min_rcb_fee_amount": str(settings.min_rcb_fee_amount),
    }


# =========================
# 2. 资产
# =========================
@router.get(
    "/balances",
    response_model=SpotBalancesResponse,
    summary="获取现货账户资产",
    description="""
获取当前用户的现货账户资产信息。

### 📌 功能说明
- 返回用户在该交易对下涉及的资产
- 包含：可用余额 + 冻结余额

### 📌 参数说明
- symbol：交易对（如 BTCUSDT）

### 📌 使用场景
- 交易页面资产展示
- 下单前余额校验

### 📌 权限
- 需要登录（JWT）
""",
)
def spot_balances(
    symbol: str = Query(..., description="交易对，例如：BTCUSDT"),
    db: Session = Depends(get_db),
    user_id: int = Depends(get_current_user_id),
):
    try:
        return get_spot_balances(db, user_id, symbol)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


# =========================
# 3. 当前委托
# =========================
@router.get(
    "/orders/current",
    response_model=SpotOrdersResponse,
    summary="获取当前委托订单",
    description="""
获取用户当前未成交/部分成交的订单。

### 📌 功能说明
- 返回当前挂单（未成交）
- 包含：买单 + 卖单

### 📌 参数说明
- symbol：交易对
- limit：返回条数（默认50）

### 📌 使用场景
- 当前委托列表
- 撤单操作

### 📌 权限
- 需要登录
""",
)
def spot_current_orders(
    symbol: str = Query(..., description="交易对，例如：BTCUSDT"),
    limit: int = Query(50, description="返回数量，默认50"),
    db: Session = Depends(get_db),
    user_id: int = Depends(get_current_user_id),
):
    try:
        return get_current_orders(db, user_id, symbol, limit)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


# =========================
# 4. 历史委托
# =========================
@router.get(
    "/orders/history",
    response_model=SpotOrdersResponse,
    summary="获取历史委托订单",
    description="""
获取用户历史订单（已成交 / 已取消）。

### 📌 功能说明
- 返回历史订单记录
- 包含：成交 + 撤单

### 📌 参数说明
- symbol：交易对
- limit：返回条数（默认100）

### 📌 使用场景
- 历史订单查询

### 📌 权限
- 需要登录
""",
)
def spot_history_orders(
    symbol: str = Query(..., description="交易对，例如：BTCUSDT"),
    limit: int = Query(100, description="返回数量，默认100"),
    db: Session = Depends(get_db),
    user_id: int = Depends(get_current_user_id),
):
    try:
        return get_history_orders(db, user_id, symbol, limit)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


# =========================
# 5. 成交记录
# =========================
@router.get(
    "/trades",
    response_model=SpotTradesResponse,
    summary="获取我的成交记录",
    description="""
获取用户成交明细。

### 📌 功能说明
- 返回用户实际成交记录
- 包含：成交价格、数量、方向

### 📌 参数说明
- symbol：交易对
- limit：返回条数（默认100）

### 📌 使用场景
- 成交明细展示

### 📌 权限
- 需要登录
""",
)
def spot_my_trades(
    symbol: str = Query(..., description="交易对，例如：BTCUSDT"),
    limit: int = Query(100, description="返回数量，默认100"),
    db: Session = Depends(get_db),
    user_id: int = Depends(get_current_user_id),
):
    try:
        return get_my_trades(db, user_id, symbol, limit)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
