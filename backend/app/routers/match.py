from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.schemas.match import MatchRunResponse
from app.services.matching import run_match_once, run_match_loop

router = APIRouter(prefix="/match", tags=["match"])


@router.post(
    "/run_once",
    summary="撮合引擎执行一次",
    description="单次撮合（测试用）",
)
def run_match_once_api(
    trading_pair_id: int = Query(..., description="交易对ID"),
    db: Session = Depends(get_db),
):
    return run_match_once(db, trading_pair_id)


@router.post(
    "/run",
    summary="撮合引擎连续撮合",
    description="""
连续撮合版本：

- 自动循环撮合
- 直到没有可成交订单
- 支持一买吃多卖
- 支持部分成交
""",
)
def run_match_loop_api(
    trading_pair_id: int = Query(..., description="交易对ID"),
    max_rounds: int = Query(100, description="最大撮合轮数"),
    db: Session = Depends(get_db),
):
    return run_match_loop(db, trading_pair_id, max_rounds)