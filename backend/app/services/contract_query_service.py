from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Iterator, Optional

from sqlalchemy import inspect
from sqlalchemy.orm import Session, load_only

from app.db.models.contract_order import ContractOrder
from app.db.models.contract_position import ContractPosition
from app.db.models.contract_symbol import ContractSymbol
from app.db.models.contract_trade import ContractTrade
from app.schemas.contract_order import (
    ContractOrderListItem,
    ContractOrderListResponse,
    ContractTradeListItem,
    ContractTradeListResponse,
)
from app.schemas.contract_position import (
    ContractPositionItem,
    ContractPositionListResponse,
    ContractPositionPageResponse,
    ContractPositionSummaryItem,
    ContractPositionSummaryListResponse,
)
from app.services.contract_market_service import get_contract_quote


DEFAULT_PAGE = 1
DEFAULT_PAGE_SIZE = 20
MAX_PAGE_SIZE = 100
ACTIVE_ORDER_STATUSES = ("OPEN", "NEW", "PENDING", "PARTIALLY_FILLED")
POSITION_PNL_USABLE_FRESHNESS = {"LIVE", "RECENT"}
POSITION_PNL_STATE_PRIORITY = {"LIVE": 0, "RECENT": 1, "STALE": 2, "UNAVAILABLE": 3}


@dataclass(frozen=True)
class ContractPositionMarkEvidence:
    mark_price: Optional[Decimal]
    source: Optional[str]
    freshness: str
    usable: bool


@dataclass(frozen=True)
class ContractPositionPnlSnapshot:
    mark_price: Optional[Decimal]
    unrealized_pnl: Optional[Decimal]
    source: Optional[str]
    freshness: str
    usable: bool


_POSITION_MARK_EVIDENCE_CACHE: ContextVar[Optional[dict[str, ContractPositionMarkEvidence]]] = ContextVar(
    "contract_position_mark_evidence_cache",
    default=None,
)


@contextmanager
def contract_position_mark_evidence_scope() -> Iterator[dict[str, ContractPositionMarkEvidence]]:
    existing = _POSITION_MARK_EVIDENCE_CACHE.get()
    if existing is not None:
        yield existing
        return
    cache: dict[str, ContractPositionMarkEvidence] = {}
    token = _POSITION_MARK_EVIDENCE_CACHE.set(cache)
    try:
        yield cache
    finally:
        _POSITION_MARK_EVIDENCE_CACHE.reset(token)


def _normalize_symbol(symbol: Optional[str]) -> str:
    return str(symbol or "").strip().upper()


def _contract_symbol_aliases(symbol: Optional[str]) -> tuple[str, ...]:
    normalized = _normalize_symbol(symbol)
    if not normalized:
        return ()
    if normalized.endswith("_PERP"):
        legacy_symbol = normalized[:-5]
        return (normalized, legacy_symbol) if legacy_symbol else (normalized,)
    return (normalized, f"{normalized}_PERP")


def _normalize_status(status: Optional[str]) -> str:
    return str(status or "").strip().upper()


def _parse_datetime_filter(value: Optional[str]) -> Optional[datetime]:
    text = str(value or "").strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = f"{text[:-1]}+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is not None:
        parsed = parsed.astimezone(timezone.utc).replace(tzinfo=None)
    return parsed


def _normalize_page(value: Any) -> int:
    try:
        page = int(value)
    except (TypeError, ValueError):
        return DEFAULT_PAGE
    return page if page > 0 else DEFAULT_PAGE


def _normalize_page_size(value: Any) -> int:
    try:
        page_size = int(value)
    except (TypeError, ValueError):
        return DEFAULT_PAGE_SIZE
    if page_size <= 0:
        return DEFAULT_PAGE_SIZE
    return min(page_size, MAX_PAGE_SIZE)


def _d(value: Any) -> Decimal:
    if isinstance(value, Decimal):
        return value
    return Decimal(str(value or "0"))


def _fmt_decimal(value: Any) -> str:
    return format(_d(value), "f")


def _fmt_optional_decimal(value: Optional[Decimal]) -> Optional[str]:
    if value is None:
        return None
    return _fmt_decimal(value)


def _fmt_compact_decimal(value: Any) -> str:
    text = format(_d(value), "f")
    if "." not in text:
        return text
    return text.rstrip("0").rstrip(".") or "0"


def _table_has_column(db: Session, table_name: str, column_name: str) -> bool:
    try:
        return any(column.get("name") == column_name for column in inspect(db.get_bind()).get_columns(table_name))
    except Exception:
        return False


def _fmt_datetime(value: Any) -> Optional[str]:
    if value is None:
        return None
    return value.isoformat()


def _position_pnl_from_mark(
    position: ContractPosition,
    mark_price: Decimal,
) -> Optional[Decimal]:
    if mark_price <= 0:
        return None
    entry_price = _d(position.entry_price)
    quantity = _d(position.quantity)
    if entry_price <= 0 or quantity <= 0:
        return None
    side = _normalize_status(position.side)
    if side == "LONG":
        return (mark_price - entry_price) * quantity
    if side == "SHORT":
        return (entry_price - mark_price) * quantity
    return None


def _resolve_contract_position_mark(
    db: Session,
    position: ContractPosition,
) -> ContractPositionMarkEvidence:
    table_mark_price = _d(position.mark_price)
    if _normalize_status(position.status) != "OPEN":
        return ContractPositionMarkEvidence(
            mark_price=table_mark_price if table_mark_price > 0 else None,
            source="POSITION_STORED",
            freshness="STALE",
            usable=False,
        )

    normalized_symbol = _normalize_symbol(position.symbol)
    evidence_cache = _POSITION_MARK_EVIDENCE_CACHE.get()
    if evidence_cache is not None and normalized_symbol in evidence_cache:
        return evidence_cache[normalized_symbol]

    try:
        quote = get_contract_quote(db, position.symbol)
        mark_price = _d(quote.get("mark_price"))
        source = str(
            quote.get("quote_source")
            or quote.get("source")
            or quote.get("price_source")
            or "CONTRACT_QUOTE"
        ).strip().upper()
        freshness = str(
            quote.get("quote_freshness")
            or quote.get("freshness")
            or ("LIVE" if quote.get("is_realtime") is True else "")
        ).strip().upper()
        if mark_price > 0:
            normalized_freshness = freshness if freshness in POSITION_PNL_USABLE_FRESHNESS else "STALE"
            evidence = ContractPositionMarkEvidence(
                mark_price=mark_price,
                source=source or "CONTRACT_QUOTE",
                freshness=normalized_freshness,
                usable=normalized_freshness in POSITION_PNL_USABLE_FRESHNESS,
            )
            if evidence_cache is not None and normalized_symbol:
                evidence_cache[normalized_symbol] = evidence
            return evidence
    except Exception:
        pass

    if table_mark_price > 0:
        evidence = ContractPositionMarkEvidence(
            mark_price=table_mark_price,
            source="POSITION_STORED_MARK",
            freshness="STALE",
            usable=False,
        )
        if evidence_cache is not None and normalized_symbol:
            evidence_cache[normalized_symbol] = evidence
        return evidence
    evidence = ContractPositionMarkEvidence(
        mark_price=None,
        source=None,
        freshness="UNAVAILABLE",
        usable=False,
    )
    if evidence_cache is not None and normalized_symbol:
        evidence_cache[normalized_symbol] = evidence
    return evidence


def resolve_contract_position_pnl(
    db: Session,
    position: ContractPosition,
) -> ContractPositionPnlSnapshot:
    if _normalize_status(position.status) != "OPEN":
        mark_evidence = _resolve_contract_position_mark(db, position)
        return ContractPositionPnlSnapshot(
            mark_price=mark_evidence.mark_price,
            unrealized_pnl=_d(position.unrealized_pnl),
            source=mark_evidence.source,
            freshness=mark_evidence.freshness,
            usable=False,
        )

    mark_evidence = _resolve_contract_position_mark(db, position)
    unrealized_pnl = (
        _position_pnl_from_mark(position, mark_evidence.mark_price)
        if mark_evidence.mark_price is not None
        else None
    )
    return ContractPositionPnlSnapshot(
        mark_price=mark_evidence.mark_price,
        unrealized_pnl=unrealized_pnl,
        source=mark_evidence.source,
        freshness=mark_evidence.freshness if unrealized_pnl is not None else "UNAVAILABLE",
        usable=mark_evidence.usable and unrealized_pnl is not None,
    )


def _position_mark_and_pnl(db: Session, position: ContractPosition) -> tuple[Decimal, Decimal]:
    snapshot = resolve_contract_position_pnl(db, position)
    mark_price = snapshot.mark_price
    unrealized_pnl = snapshot.unrealized_pnl
    return (
        mark_price if mark_price is not None else _d(position.mark_price),
        unrealized_pnl if unrealized_pnl is not None else _d(position.unrealized_pnl),
    )


def _aggregate_position_truth_state(snapshots: list[ContractPositionPnlSnapshot]) -> str:
    if not snapshots:
        return "UNAVAILABLE"
    return max(
        (snapshot.freshness for snapshot in snapshots),
        key=lambda state: POSITION_PNL_STATE_PRIORITY.get(state, POSITION_PNL_STATE_PRIORITY["UNAVAILABLE"]),
    )


def _resolve_position_pnl_snapshots(
    db: Session,
    positions: list[ContractPosition],
) -> dict[int, ContractPositionPnlSnapshot]:
    with contract_position_mark_evidence_scope():
        return {id(position): resolve_contract_position_pnl(db, position) for position in positions}


def _tp_sl_key(position: ContractPosition) -> tuple[str, str]:
    return (
        _fmt_decimal(position.take_profit_price) if position.take_profit_price is not None else "",
        _fmt_decimal(position.stop_loss_price) if position.stop_loss_price is not None else "",
    )


def _summary_tp_sl(rows: list[ContractPosition]) -> tuple[str, Optional[str], Optional[str]]:
    keys = {_tp_sl_key(position) for position in rows}
    if not keys or keys == {("", "")}:
        return "NONE", None, None
    if len(keys) == 1:
        take_profit_price, stop_loss_price = next(iter(keys))
        return "SINGLE", take_profit_price or None, stop_loss_price or None
    return "MIXED", None, None


def _display_liquidation_price_from_margin(
    *,
    side: str,
    entry_price: Decimal,
    margin_amount: Decimal,
    quantity: Decimal,
    liquidation_threshold: Decimal,
) -> Decimal:
    abs_quantity = abs(quantity)
    if entry_price <= 0 or margin_amount <= 0 or abs_quantity <= 0:
        return Decimal("0")
    distance = margin_amount * (Decimal("1") - liquidation_threshold) / abs_quantity
    if distance <= 0:
        return Decimal("0")
    normalized_side = _normalize_status(side)
    if normalized_side == "LONG":
        liquidation_price = entry_price - distance
    elif normalized_side == "SHORT":
        liquidation_price = entry_price + distance
    else:
        liquidation_price = Decimal("0")
    return liquidation_price if liquidation_price > 0 else Decimal("0")


def _symbol_liquidation_thresholds(db: Session, positions: list[ContractPosition]) -> dict[str, Decimal]:
    symbols = sorted({_normalize_symbol(position.symbol) for position in positions if _normalize_symbol(position.symbol)})
    if not symbols:
        return {}
    rows = (
        db.query(ContractSymbol.symbol, ContractSymbol.liquidation_threshold)
        .filter(ContractSymbol.symbol.in_(symbols))
        .all()
    )
    return {_normalize_symbol(symbol): _d(liquidation_threshold) for symbol, liquidation_threshold in rows}


def _liquidation_threshold_for_position(
    liquidation_thresholds: dict[str, Decimal],
    position: ContractPosition,
) -> Decimal:
    return liquidation_thresholds.get(_normalize_symbol(position.symbol), Decimal("0"))


def _position_display_liquidation_price(
    position: ContractPosition,
    liquidation_threshold: Decimal = Decimal("0"),
) -> Optional[Decimal]:
    stored_liquidation_price = _d(position.liquidation_price)
    if stored_liquidation_price > 0:
        return stored_liquidation_price
    derived_liquidation_price = _display_liquidation_price_from_margin(
        side=position.side,
        entry_price=_d(position.entry_price),
        margin_amount=_d(position.margin_amount),
        quantity=_d(position.quantity),
        liquidation_threshold=liquidation_threshold,
    )
    return derived_liquidation_price if derived_liquidation_price > 0 else None


def _summary_display_liquidation_price(
    positions: list[ContractPosition],
    liquidation_thresholds: dict[str, Decimal],
) -> Optional[Decimal]:
    if not positions:
        return None
    values = {
        _d(position.liquidation_price)
        for position in positions
        if _d(position.liquidation_price) > 0
    }
    if len(values) == 1:
        return next(iter(values))
    if len(positions) == 1:
        position = positions[0]
        return _position_display_liquidation_price(
            position,
            _liquidation_threshold_for_position(liquidation_thresholds, position),
        )

    side_values = {_normalize_status(position.side) for position in positions}
    symbol_values = {_normalize_symbol(position.symbol) for position in positions}
    if len(side_values) != 1 or len(symbol_values) != 1:
        return None

    total_quantity = sum((_d(position.quantity) for position in positions), Decimal("0"))
    if total_quantity <= 0:
        return None
    weighted_entry_notional = sum(
        (_d(position.entry_price) * _d(position.quantity) for position in positions),
        Decimal("0"),
    )
    avg_entry_price = weighted_entry_notional / total_quantity
    margin_amount = sum((_d(position.margin_amount) for position in positions), Decimal("0"))
    position = positions[0]
    derived_liquidation_price = _display_liquidation_price_from_margin(
        side=position.side,
        entry_price=avg_entry_price,
        margin_amount=margin_amount,
        quantity=total_quantity,
        liquidation_threshold=_liquidation_threshold_for_position(liquidation_thresholds, position),
    )
    return derived_liquidation_price if derived_liquidation_price > 0 else None


def _position_risk_metrics(
    *,
    side: str,
    quantity: Decimal,
    mark_price: Optional[Decimal],
    margin_amount: Decimal,
    unrealized_pnl: Optional[Decimal],
    liquidation_price: Optional[Decimal],
) -> dict[str, Optional[Decimal]]:
    abs_quantity = abs(quantity)
    roe = (
        unrealized_pnl / margin_amount * Decimal("100")
        if unrealized_pnl is not None and margin_amount > 0
        else None
    )
    notional = mark_price * abs_quantity if mark_price is not None else Decimal("0")
    margin_ratio = margin_amount / notional * Decimal("100") if notional > 0 else None

    liquidation_distance: Optional[Decimal] = None
    liquidation_distance_rate: Optional[Decimal] = None
    normalized_side = _normalize_status(side)
    if liquidation_price is not None and mark_price is not None and mark_price > 0 and liquidation_price > 0:
        if normalized_side == "LONG":
            liquidation_distance = mark_price - liquidation_price
        elif normalized_side == "SHORT":
            liquidation_distance = liquidation_price - mark_price
        if liquidation_distance is not None:
            liquidation_distance_rate = liquidation_distance / mark_price * Decimal("100")

    return {
        "roe": roe,
        "margin_ratio": margin_ratio,
        "liquidation_distance": liquidation_distance,
        "liquidation_distance_rate": liquidation_distance_rate,
    }


def _position_trade_summaries(
    db: Session,
    user_id: int,
    position_ids: list[int],
) -> dict[int, dict[str, Any]]:
    if not position_ids:
        return {}

    summaries: dict[int, dict[str, Any]] = {}
    rows = (
        db.query(ContractTrade)
        .filter(ContractTrade.user_id == int(user_id))
        .filter(ContractTrade.position_id.in_(position_ids))
        .all()
    )
    for trade in rows:
        if trade.position_id is None:
            continue
        position_id = int(trade.position_id)
        summary = summaries.setdefault(
            position_id,
            {
                "opened_quantity": Decimal("0"),
                "closed_quantity": Decimal("0"),
                "opened_margin_amount": Decimal("0"),
                "released_margin_amount": Decimal("0"),
                "close_notional": Decimal("0"),
                "realized_pnl": Decimal("0"),
                "closed_at": None,
            },
        )
        action = _normalize_status(trade.action)
        quantity = _d(trade.quantity)
        margin_amount = _d(trade.margin_amount)
        if action == "OPEN":
            summary["opened_quantity"] += quantity
            summary["opened_margin_amount"] += margin_amount
            continue
        if action == "CLOSE":
            summary["closed_quantity"] += quantity
            summary["released_margin_amount"] += margin_amount
            summary["close_notional"] += _d(trade.price) * quantity
            summary["realized_pnl"] += _d(trade.realized_pnl)
            if summary["closed_at"] is None or trade.created_at > summary["closed_at"]:
                summary["closed_at"] = trade.created_at

    return summaries


def get_user_contract_positions(
    db: Session,
    user_id: int,
    symbol: Optional[str] = None,
    status: str = "OPEN",
) -> ContractPositionListResponse:
    query = db.query(ContractPosition).filter(ContractPosition.user_id == int(user_id))

    normalized_symbol = _normalize_symbol(symbol)
    if normalized_symbol:
        query = query.filter(ContractPosition.symbol.in_(_contract_symbol_aliases(normalized_symbol)))

    normalized_status = _normalize_status(status)
    if normalized_status and normalized_status != "ALL":
        query = query.filter(ContractPosition.status == normalized_status)

    rows = query.order_by(ContractPosition.opened_at.desc(), ContractPosition.id.desc()).all()
    liquidation_thresholds = _symbol_liquidation_thresholds(db, rows)
    trade_summaries = _position_trade_summaries(db, int(user_id), [int(position.id) for position in rows])
    pnl_snapshots = _resolve_position_pnl_snapshots(db, rows)
    items: list[ContractPositionItem] = []
    for position in rows:
        pnl_snapshot = pnl_snapshots[id(position)]
        mark_price = pnl_snapshot.mark_price
        unrealized_pnl = pnl_snapshot.unrealized_pnl
        liquidation_price = _position_display_liquidation_price(
            position,
            _liquidation_threshold_for_position(liquidation_thresholds, position),
        )
        risk_metrics = _position_risk_metrics(
            side=position.side,
            quantity=_d(position.quantity),
            mark_price=mark_price,
            margin_amount=_d(position.margin_amount),
            unrealized_pnl=unrealized_pnl,
            liquidation_price=liquidation_price,
        )
        trade_summary = trade_summaries.get(int(position.id), {})
        closed_quantity = _d(trade_summary.get("closed_quantity"))
        close_avg_price = (
            _d(trade_summary.get("close_notional")) / closed_quantity
            if closed_quantity > 0
            else Decimal("0")
        )
        aggregated_closed_at = trade_summary.get("closed_at")
        items.append(
            ContractPositionItem(
                id=int(position.id),
                symbol=position.symbol,
                side=position.side,
                leverage=int(position.leverage),
                quantity=_fmt_decimal(position.quantity),
                entry_price=_fmt_decimal(position.entry_price),
                mark_price=_fmt_optional_decimal(mark_price),
                mark_source=pnl_snapshot.source,
                mark_freshness=pnl_snapshot.freshness,
                mark_usable=pnl_snapshot.usable,
                margin_amount=_fmt_decimal(position.margin_amount),
                open_fee=_fmt_decimal(position.open_fee),
                unrealized_pnl=_fmt_optional_decimal(unrealized_pnl),
                unrealized_pnl_state=pnl_snapshot.freshness,
                realized_pnl=_fmt_decimal(position.realized_pnl),
                liquidation_price=_fmt_optional_decimal(liquidation_price),
                roe=_fmt_optional_decimal(risk_metrics["roe"]),
                margin_ratio=_fmt_optional_decimal(risk_metrics["margin_ratio"]),
                liquidation_distance=_fmt_optional_decimal(risk_metrics["liquidation_distance"]),
                liquidation_distance_rate=_fmt_optional_decimal(risk_metrics["liquidation_distance_rate"]),
                warning_price=_fmt_decimal(position.warning_price),
                take_profit_price=_fmt_decimal(position.take_profit_price) if position.take_profit_price is not None else None,
                stop_loss_price=_fmt_decimal(position.stop_loss_price) if position.stop_loss_price is not None else None,
                close_reason=position.close_reason,
                opened_quantity=_fmt_decimal(trade_summary.get("opened_quantity", Decimal("0"))),
                closed_quantity=_fmt_decimal(closed_quantity),
                opened_margin_amount=_fmt_decimal(trade_summary.get("opened_margin_amount", Decimal("0"))),
                released_margin_amount=_fmt_decimal(trade_summary.get("released_margin_amount", Decimal("0"))),
                close_avg_price=_fmt_decimal(close_avg_price) if close_avg_price > 0 else None,
                status=position.status,
                opened_at=_fmt_datetime(position.opened_at),
                closed_at=_fmt_datetime(position.closed_at or aggregated_closed_at),
            )
        )

    return ContractPositionListResponse(items=items)


def get_user_contract_positions_page(
    db: Session,
    user_id: int,
    symbol: Optional[str] = None,
    status: Optional[str] = "OPEN",
    side: Optional[str] = None,
    position_side: Optional[str] = None,
    created_from: Optional[str] = None,
    created_to: Optional[str] = None,
    page: int = 1,
    page_size: int = 20,
) -> ContractPositionPageResponse:
    normalized_page = _normalize_page(page)
    normalized_page_size = _normalize_page_size(page_size)
    query = db.query(ContractPosition).filter(ContractPosition.user_id == int(user_id))

    normalized_symbol = _normalize_symbol(symbol)
    if normalized_symbol:
        query = query.filter(ContractPosition.symbol.in_(_contract_symbol_aliases(normalized_symbol)))

    normalized_status = _normalize_status(status)
    if normalized_status and normalized_status != "ALL":
        query = query.filter(ContractPosition.status == normalized_status)

    normalized_side = _normalize_status(position_side) or _normalize_status(side)
    if normalized_side:
        if normalized_side not in {"LONG", "SHORT"}:
            return ContractPositionPageResponse(items=[], total=0, page=normalized_page, page_size=normalized_page_size)
        query = query.filter(ContractPosition.side == normalized_side)

    created_from_dt = _parse_datetime_filter(created_from)
    if created_from_dt:
        query = query.filter(ContractPosition.created_at >= created_from_dt)

    created_to_dt = _parse_datetime_filter(created_to)
    if created_to_dt:
        query = query.filter(ContractPosition.created_at <= created_to_dt)

    total = int(query.count())
    rows = (
        query.order_by(ContractPosition.updated_at.desc(), ContractPosition.id.desc())
        .offset((normalized_page - 1) * normalized_page_size)
        .limit(normalized_page_size)
        .all()
    )

    trade_summaries = _position_trade_summaries(db, int(user_id), [int(position.id) for position in rows])
    liquidation_thresholds = _symbol_liquidation_thresholds(db, rows)
    pnl_snapshots = _resolve_position_pnl_snapshots(db, rows)
    items: list[ContractPositionItem] = []
    for position in rows:
        pnl_snapshot = pnl_snapshots[id(position)]
        mark_price = pnl_snapshot.mark_price
        unrealized_pnl = pnl_snapshot.unrealized_pnl
        liquidation_price = _position_display_liquidation_price(
            position,
            _liquidation_threshold_for_position(liquidation_thresholds, position),
        )
        risk_metrics = _position_risk_metrics(
            side=position.side,
            quantity=_d(position.quantity),
            mark_price=mark_price,
            margin_amount=_d(position.margin_amount),
            unrealized_pnl=unrealized_pnl,
            liquidation_price=liquidation_price,
        )
        trade_summary = trade_summaries.get(int(position.id), {})
        closed_quantity = _d(trade_summary.get("closed_quantity"))
        close_avg_price = (
            _d(trade_summary.get("close_notional")) / closed_quantity
            if closed_quantity > 0
            else Decimal("0")
        )
        aggregated_closed_at = trade_summary.get("closed_at")
        items.append(
            ContractPositionItem(
                id=int(position.id),
                symbol=position.symbol,
                side=position.side,
                leverage=int(position.leverage),
                quantity=_fmt_decimal(position.quantity),
                entry_price=_fmt_decimal(position.entry_price),
                mark_price=_fmt_optional_decimal(mark_price),
                mark_source=pnl_snapshot.source,
                mark_freshness=pnl_snapshot.freshness,
                mark_usable=pnl_snapshot.usable,
                margin_amount=_fmt_decimal(position.margin_amount),
                open_fee=_fmt_decimal(position.open_fee),
                unrealized_pnl=_fmt_optional_decimal(unrealized_pnl),
                unrealized_pnl_state=pnl_snapshot.freshness,
                realized_pnl=_fmt_decimal(position.realized_pnl),
                liquidation_price=_fmt_optional_decimal(liquidation_price),
                roe=_fmt_optional_decimal(risk_metrics["roe"]),
                margin_ratio=_fmt_optional_decimal(risk_metrics["margin_ratio"]),
                liquidation_distance=_fmt_optional_decimal(risk_metrics["liquidation_distance"]),
                liquidation_distance_rate=_fmt_optional_decimal(risk_metrics["liquidation_distance_rate"]),
                warning_price=_fmt_decimal(position.warning_price),
                take_profit_price=_fmt_decimal(position.take_profit_price) if position.take_profit_price is not None else None,
                stop_loss_price=_fmt_decimal(position.stop_loss_price) if position.stop_loss_price is not None else None,
                close_reason=position.close_reason,
                opened_quantity=_fmt_decimal(trade_summary.get("opened_quantity", Decimal("0"))),
                closed_quantity=_fmt_decimal(closed_quantity),
                opened_margin_amount=_fmt_decimal(trade_summary.get("opened_margin_amount", Decimal("0"))),
                released_margin_amount=_fmt_decimal(trade_summary.get("released_margin_amount", Decimal("0"))),
                close_avg_price=_fmt_decimal(close_avg_price) if close_avg_price > 0 else None,
                status=position.status,
                opened_at=_fmt_datetime(position.opened_at),
                closed_at=_fmt_datetime(position.closed_at or aggregated_closed_at),
            )
        )

    return ContractPositionPageResponse(
        items=items,
        total=total,
        page=normalized_page,
        page_size=normalized_page_size,
    )


def get_user_contract_position_summaries(
    db: Session,
    user_id: int,
    symbol: Optional[str] = None,
    side: Optional[str] = None,
) -> ContractPositionSummaryListResponse:
    query = (
        db.query(ContractPosition)
        .filter(ContractPosition.user_id == int(user_id))
        .filter(ContractPosition.status == "OPEN")
        .filter(ContractPosition.quantity > 0)
    )

    normalized_symbol = _normalize_symbol(symbol)
    if normalized_symbol:
        query = query.filter(ContractPosition.symbol.in_(_contract_symbol_aliases(normalized_symbol)))

    normalized_side = _normalize_status(side)
    if normalized_side:
        if normalized_side not in {"LONG", "SHORT"}:
            return ContractPositionSummaryListResponse(items=[])
        query = query.filter(ContractPosition.side == normalized_side)

    rows = query.order_by(ContractPosition.symbol.asc(), ContractPosition.side.asc(), ContractPosition.id.asc()).all()
    liquidation_thresholds = _symbol_liquidation_thresholds(db, rows)
    pnl_snapshots_by_position = _resolve_position_pnl_snapshots(db, rows)
    grouped: dict[tuple[str, str], list[ContractPosition]] = {}
    for position in rows:
        quantity = _d(position.quantity)
        position_side = _normalize_status(position.side)
        if quantity <= 0 or position_side not in {"LONG", "SHORT"}:
            continue
        key = (_normalize_symbol(position.symbol), position_side)
        grouped.setdefault(key, []).append(position)

    items: list[ContractPositionSummaryItem] = []
    for (group_symbol, group_side), group_rows in grouped.items():
        total_quantity = sum((_d(position.quantity) for position in group_rows), Decimal("0"))
        if total_quantity <= 0:
            continue

        weighted_entry_notional = sum(
            (_d(position.entry_price) * _d(position.quantity) for position in group_rows),
            Decimal("0"),
        )
        avg_entry_price = weighted_entry_notional / total_quantity
        margin_amount = sum((_d(position.margin_amount) for position in group_rows), Decimal("0"))
        pnl_snapshots = [pnl_snapshots_by_position[id(position)] for position in group_rows]
        truth_state = _aggregate_position_truth_state(pnl_snapshots)
        complete = all(
            snapshot.mark_price is not None and snapshot.unrealized_pnl is not None
            for snapshot in pnl_snapshots
        )
        unrealized_pnl = (
            sum((snapshot.unrealized_pnl for snapshot in pnl_snapshots if snapshot.unrealized_pnl is not None), Decimal("0"))
            if complete
            else None
        )
        weighted_mark_notional = (
            sum(
                (
                    snapshot.mark_price * _d(position.quantity)
                    for position, snapshot in zip(group_rows, pnl_snapshots)
                    if snapshot.mark_price is not None
                ),
                Decimal("0"),
            )
            if complete
            else None
        )
        mark_price = (
            weighted_mark_notional / total_quantity
            if weighted_mark_notional is not None and total_quantity > 0
            else None
        )
        mark_sources = {snapshot.source for snapshot in pnl_snapshots if snapshot.source}
        mark_source = next(iter(mark_sources)) if len(mark_sources) == 1 else "MIXED" if mark_sources else None
        mark_usable = complete and truth_state in POSITION_PNL_USABLE_FRESHNESS and all(
            snapshot.usable for snapshot in pnl_snapshots
        )
        leverage_values = {int(position.leverage) for position in group_rows}
        display_leverage = next(iter(leverage_values)) if len(leverage_values) == 1 else None

        tp_sl_mode, take_profit_price, stop_loss_price = _summary_tp_sl(group_rows)
        liquidation_price = _summary_display_liquidation_price(group_rows, liquidation_thresholds)
        risk_metrics = _position_risk_metrics(
            side=group_side,
            quantity=total_quantity,
            mark_price=mark_price,
            margin_amount=margin_amount,
            unrealized_pnl=unrealized_pnl,
            liquidation_price=liquidation_price,
        )

        items.append(
            ContractPositionSummaryItem(
                symbol=group_symbol,
                side=group_side,
                leverage=display_leverage,
                quantity=_fmt_compact_decimal(total_quantity),
                avg_entry_price=_fmt_compact_decimal(avg_entry_price),
                mark_price=_fmt_compact_decimal(mark_price) if mark_price is not None else None,
                mark_source=mark_source,
                mark_freshness=truth_state,
                mark_usable=mark_usable,
                margin_amount=_fmt_compact_decimal(margin_amount),
                unrealized_pnl=_fmt_compact_decimal(unrealized_pnl) if unrealized_pnl is not None else None,
                unrealized_pnl_state=truth_state,
                liquidation_price=_fmt_optional_decimal(liquidation_price),
                roe=_fmt_optional_decimal(risk_metrics["roe"]),
                margin_ratio=_fmt_optional_decimal(risk_metrics["margin_ratio"]),
                liquidation_distance=_fmt_optional_decimal(risk_metrics["liquidation_distance"]),
                liquidation_distance_rate=_fmt_optional_decimal(risk_metrics["liquidation_distance_rate"]),
                position_ids=[int(position.id) for position in group_rows],
                count=len(group_rows),
                take_profit_price=take_profit_price,
                stop_loss_price=stop_loss_price,
                tp_sl_mode=tp_sl_mode,
            )
        )

    return ContractPositionSummaryListResponse(items=items)


def get_user_contract_orders(
    db: Session,
    user_id: int,
    symbol: Optional[str] = None,
    status: Optional[str] = None,
    status_group: Optional[str] = None,
    side: Optional[str] = None,
    position_side: Optional[str] = None,
    order_type: Optional[str] = None,
    action: Optional[str] = None,
    created_from: Optional[str] = None,
    created_to: Optional[str] = None,
    page: int = 1,
    page_size: int = 20,
) -> ContractOrderListResponse:
    normalized_page = _normalize_page(page)
    normalized_page_size = _normalize_page_size(page_size)
    query = db.query(ContractOrder).filter(ContractOrder.user_id == int(user_id))

    normalized_symbol = _normalize_symbol(symbol)
    if normalized_symbol:
        query = query.filter(ContractOrder.symbol.in_(_contract_symbol_aliases(normalized_symbol)))

    normalized_status = _normalize_status(status)
    if normalized_status:
        if normalized_status == "ACTIVE":
            query = query.filter(ContractOrder.status.in_(ACTIVE_ORDER_STATUSES))
        elif normalized_status != "ALL":
            query = query.filter(ContractOrder.status == normalized_status)
    else:
        normalized_status_group = _normalize_status(status_group)
        if normalized_status_group == "ACTIVE":
            query = query.filter(ContractOrder.status.in_(ACTIVE_ORDER_STATUSES))
        elif normalized_status_group == "HISTORY":
            query = query.filter(~ContractOrder.status.in_(ACTIVE_ORDER_STATUSES))

    normalized_side = _normalize_status(side)
    if normalized_side:
        query = query.filter(ContractOrder.side == normalized_side)

    normalized_position_side = _normalize_status(position_side)
    if normalized_position_side:
        query = query.filter(ContractOrder.position_side == normalized_position_side)

    normalized_order_type = _normalize_status(order_type)
    if normalized_order_type:
        query = query.filter(ContractOrder.order_type == normalized_order_type)

    normalized_action = _normalize_status(action)
    if normalized_action:
        query = query.filter(ContractOrder.action == normalized_action)

    created_from_dt = _parse_datetime_filter(created_from)
    if created_from_dt:
        query = query.filter(ContractOrder.created_at >= created_from_dt)

    created_to_dt = _parse_datetime_filter(created_to)
    if created_to_dt:
        query = query.filter(ContractOrder.created_at <= created_to_dt)

    has_fee_amount = _table_has_column(db, "contract_orders", "fee_amount")
    total = int(query.count())
    if not has_fee_amount:
        query = query.options(
            load_only(
                ContractOrder.id,
                ContractOrder.order_no,
                ContractOrder.symbol,
                ContractOrder.position_id,
                ContractOrder.side,
                ContractOrder.position_side,
                ContractOrder.action,
                ContractOrder.order_type,
                ContractOrder.price,
                ContractOrder.quantity,
                ContractOrder.leverage,
                ContractOrder.margin_amount,
                ContractOrder.spread_fee,
                ContractOrder.filled_quantity,
                ContractOrder.avg_price,
                ContractOrder.status,
                ContractOrder.fail_reason,
                ContractOrder.take_profit_price,
                ContractOrder.stop_loss_price,
                ContractOrder.created_at,
            )
        )
    rows = (
        query.order_by(ContractOrder.created_at.desc(), ContractOrder.id.desc())
        .offset((normalized_page - 1) * normalized_page_size)
        .limit(normalized_page_size)
        .all()
    )

    return ContractOrderListResponse(
        items=[
            ContractOrderListItem(
                id=int(order.id),
                order_no=order.order_no,
                symbol=order.symbol,
                position_id=int(order.position_id) if order.position_id is not None else None,
                side=order.side,
                position_side=order.position_side,
                action=order.action,
                order_type=order.order_type,
                price=_fmt_decimal(order.price) if order.price is not None else None,
                quantity=_fmt_decimal(order.quantity),
                leverage=int(order.leverage),
                margin_amount=_fmt_decimal(order.margin_amount),
                fee_amount=_fmt_decimal(order.fee_amount if has_fee_amount else Decimal("0")),
                spread_fee=_fmt_decimal(order.spread_fee),
                filled_quantity=_fmt_decimal(order.filled_quantity),
                avg_price=_fmt_decimal(order.avg_price),
                status=order.status,
                fail_reason=order.fail_reason,
                take_profit_price=_fmt_decimal(order.take_profit_price) if order.take_profit_price is not None else None,
                stop_loss_price=_fmt_decimal(order.stop_loss_price) if order.stop_loss_price is not None else None,
                created_at=_fmt_datetime(order.created_at),
            )
            for order in rows
        ],
        total=total,
        page=normalized_page,
        page_size=normalized_page_size,
    )


def get_user_contract_trades(
    db: Session,
    user_id: int,
    symbol: Optional[str] = None,
    side: Optional[str] = None,
    position_side: Optional[str] = None,
    action: Optional[str] = None,
    created_from: Optional[str] = None,
    created_to: Optional[str] = None,
    page: int = 1,
    page_size: int = 20,
) -> ContractTradeListResponse:
    normalized_page = _normalize_page(page)
    normalized_page_size = _normalize_page_size(page_size)
    query = db.query(ContractTrade).filter(ContractTrade.user_id == int(user_id))

    normalized_symbol = _normalize_symbol(symbol)
    if normalized_symbol:
        query = query.filter(ContractTrade.symbol.in_(_contract_symbol_aliases(normalized_symbol)))

    normalized_side = _normalize_status(side)
    if normalized_side:
        query = query.filter(ContractTrade.side == normalized_side)

    normalized_position_side = _normalize_status(position_side)
    if normalized_position_side:
        query = query.filter(ContractTrade.position_side == normalized_position_side)

    normalized_action = _normalize_status(action)
    if normalized_action:
        query = query.filter(ContractTrade.action == normalized_action)

    created_from_dt = _parse_datetime_filter(created_from)
    if created_from_dt:
        query = query.filter(ContractTrade.created_at >= created_from_dt)

    created_to_dt = _parse_datetime_filter(created_to)
    if created_to_dt:
        query = query.filter(ContractTrade.created_at <= created_to_dt)

    has_fee_amount = _table_has_column(db, "contract_trades", "fee_amount")
    total = int(query.count())
    if not has_fee_amount:
        query = query.options(
            load_only(
                ContractTrade.id,
                ContractTrade.trade_no,
                ContractTrade.order_id,
                ContractTrade.position_id,
                ContractTrade.user_id,
                ContractTrade.symbol,
                ContractTrade.position_side,
                ContractTrade.action,
                ContractTrade.price,
                ContractTrade.quantity,
                ContractTrade.notional,
                ContractTrade.leverage,
                ContractTrade.margin_amount,
                ContractTrade.spread_fee,
                ContractTrade.realized_pnl,
                ContractTrade.created_at,
            )
        )
    rows = (
        query.order_by(ContractTrade.created_at.desc(), ContractTrade.id.desc())
        .offset((normalized_page - 1) * normalized_page_size)
        .limit(normalized_page_size)
        .all()
    )

    return ContractTradeListResponse(
        items=[
            ContractTradeListItem(
                id=int(trade.id),
                trade_no=trade.trade_no,
                order_id=int(trade.order_id),
                position_id=int(trade.position_id) if trade.position_id is not None else None,
                symbol=trade.symbol,
                position_side=trade.position_side,
                action=trade.action,
                price=_fmt_decimal(trade.price),
                quantity=_fmt_decimal(trade.quantity),
                notional=_fmt_decimal(trade.notional),
                leverage=int(trade.leverage),
                margin_amount=_fmt_decimal(trade.margin_amount),
                fee_amount=_fmt_decimal(trade.fee_amount if has_fee_amount else Decimal("0")),
                spread_fee=_fmt_decimal(trade.spread_fee),
                realized_pnl=_fmt_decimal(trade.realized_pnl),
                created_at=_fmt_datetime(trade.created_at),
            )
            for trade in rows
        ],
        total=total,
        page=normalized_page,
        page_size=normalized_page_size,
    )
