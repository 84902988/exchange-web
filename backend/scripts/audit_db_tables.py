from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from sqlalchemy import text

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.db.session import SessionLocal


IDENTIFIER_RE = re.compile(r"^[A-Za-z0-9_]+$")
CORE_PATTERNS = (
    "balance",
    "deposit",
    "withdraw",
    "order",
    "trade",
    "position",
    "margin",
    "adjust",
    "dividend",
    "commission",
    "invite",
)
AUDIT_PATTERNS = ("audit", "login", "risk", "review")
TECH_LOG_PATTERNS = ("job", "task", "gas", "confirm", "release", "collection")
TEMP_PATTERNS = ("otp", "token", "session", "temp", "verification", "captcha")
CACHE_PATTERNS = ("cache", "ticker", "quote", "market_snapshot")

ADMIN_PAGE_QUERIES = {
    "资金流水": ("admin_query_balance_logs",),
    "现货订单": ("admin_query_orders",),
    "现货成交": ("admin_query_trades",),
    "合约订单": ("list_admin_contract_orders",),
    "合约成交": ("list_admin_contract_trades",),
    "充值记录": ("admin_query_deposit_records",),
    "提现记录": ("admin_query_withdraw_records",),
    "Geo Access Logs": ("geo_access_page",),
    "Job Logs": ("admin_query_bd_commission_job_logs", "admin_query_dividend_job_logs"),
    "Audit Logs": ("admin_query_audit_logs",),
}


@dataclass(frozen=True)
class TableInfo:
    table_name: str
    approx_rows: int
    data_mb: float
    index_mb: float
    total_mb: float
    has_created_at: bool
    has_updated_at: bool
    primary_key: str
    index_count: int
    exact_rows: int | None = None


def q(name: str) -> str:
    if not IDENTIFIER_RE.match(name):
        raise ValueError(f"Unsafe identifier: {name}")
    return f"`{name}`"


def fetch_all_dicts(db, sql: str, params: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    return [
        {str(key).lower(): value for key, value in row._mapping.items()}
        for row in db.execute(text(sql), params or {}).all()
    ]


def fetch_scalar(db, sql: str, params: dict[str, Any] | None = None) -> Any:
    return db.execute(text(sql), params or {}).scalar()


def classify_table(table_name: str) -> tuple[str, str]:
    name = table_name.lower()
    if name == "geo_access_logs":
        return ("D", "访问控制 / 安全事件摘要，建议保留 90 天")
    if any(item in name for item in AUDIT_PATTERNS):
        return ("B", "运营审计表，长期保留但可归档")
    if any(item in name for item in TECH_LOG_PATTERNS):
        return ("C", "技术任务日志，可按 30/90/180 天保留")
    if any(item in name for item in TEMP_PATTERNS):
        return ("E", "临时数据 / 验证码 / session，可短期清理")
    if any(item in name for item in CACHE_PATTERNS):
        return ("F", "可重建缓存 / 行情缓存，可短期清理或按策略覆盖")
    if any(item in name for item in CORE_PATTERNS):
        return ("A", "核心账务或发放相关表，原则上不删除，只归档")
    return ("B", "业务配置或运营记录，建议保守保留并按查询压力归档")


def collect_tables(db) -> tuple[str, list[TableInfo], dict[str, list[str]], dict[str, int]]:
    schema_name = fetch_scalar(db, "SELECT DATABASE()")
    size_rows = fetch_all_dicts(
        db,
        """
        SELECT
          table_name,
          COALESCE(table_rows, 0) AS table_rows,
          ROUND(data_length / 1024 / 1024, 2) AS data_mb,
          ROUND(index_length / 1024 / 1024, 2) AS index_mb,
          ROUND((data_length + index_length) / 1024 / 1024, 2) AS total_mb
        FROM information_schema.tables
        WHERE table_schema = DATABASE()
          AND table_type = 'BASE TABLE'
        ORDER BY (data_length + index_length) DESC
        """,
    )
    columns_by_table: dict[str, list[str]] = {}
    column_rows = fetch_all_dicts(
        db,
        """
        SELECT table_name, column_name
        FROM information_schema.columns
        WHERE table_schema = DATABASE()
        ORDER BY table_name, ordinal_position
        """,
    )
    for row in column_rows:
        columns_by_table.setdefault(str(row["table_name"]), []).append(str(row["column_name"]))

    pk_by_table: dict[str, list[str]] = {}
    index_names_by_table: dict[str, set[str]] = {}
    index_rows = fetch_all_dicts(
        db,
        """
        SELECT table_name, index_name, column_name, seq_in_index
        FROM information_schema.statistics
        WHERE table_schema = DATABASE()
        ORDER BY table_name, index_name, seq_in_index
        """,
    )
    for row in index_rows:
        table_name = str(row["table_name"])
        index_name = str(row["index_name"])
        index_names_by_table.setdefault(table_name, set()).add(index_name)
        if index_name == "PRIMARY":
            pk_by_table.setdefault(table_name, []).append(str(row["column_name"]))

    tables = [
        TableInfo(
            table_name=str(row["table_name"]),
            approx_rows=int(row["table_rows"] or 0),
            data_mb=float(row["data_mb"] or 0),
            index_mb=float(row["index_mb"] or 0),
            total_mb=float(row["total_mb"] or 0),
            has_created_at="created_at" in columns_by_table.get(str(row["table_name"]), []),
            has_updated_at="updated_at" in columns_by_table.get(str(row["table_name"]), []),
            primary_key=", ".join(pk_by_table.get(str(row["table_name"]), [])) or "-",
            index_count=len(index_names_by_table.get(str(row["table_name"]), set())),
        )
        for row in size_rows
    ]
    index_counts = {name: len(index_names) for name, index_names in index_names_by_table.items()}
    return str(schema_name), tables, columns_by_table, index_counts


def with_exact_counts(db, tables: list[TableInfo], top_n: int = 30) -> list[TableInfo]:
    selected = {
        item.table_name
        for item in sorted(tables, key=lambda row: (row.approx_rows, row.total_mb), reverse=True)[:top_n]
    }
    selected.update(
        item.table_name
        for item in sorted(tables, key=lambda row: (row.total_mb, row.approx_rows), reverse=True)[:top_n]
    )
    exact_by_table: dict[str, int] = {}
    for table_name in sorted(selected):
        exact_by_table[table_name] = int(fetch_scalar(db, f"SELECT COUNT(*) FROM {q(table_name)}") or 0)
    return [
        TableInfo(
            table_name=item.table_name,
            approx_rows=item.approx_rows,
            data_mb=item.data_mb,
            index_mb=item.index_mb,
            total_mb=item.total_mb,
            has_created_at=item.has_created_at,
            has_updated_at=item.has_updated_at,
            primary_key=item.primary_key,
            index_count=item.index_count,
            exact_rows=exact_by_table.get(item.table_name),
        )
        for item in tables
    ]


def collect_created_at_stats(db, tables: list[TableInfo], top_n: int = 40) -> tuple[list[dict[str, Any]], dict[str, list[dict[str, Any]]]]:
    candidates = [
        item
        for item in sorted(tables, key=lambda row: (row.exact_rows if row.exact_rows is not None else row.approx_rows, row.total_mb), reverse=True)
        if item.has_created_at
    ][:top_n]
    stats: list[dict[str, Any]] = []
    daily: dict[str, list[dict[str, Any]]] = {}
    for item in candidates:
        table_name = item.table_name
        row = dict(
            db.execute(
                text(
                    f"""
                    SELECT
                      MIN(created_at) AS first_created_at,
                      MAX(created_at) AS last_created_at,
                      SUM(CASE WHEN created_at >= NOW() - INTERVAL 1 DAY THEN 1 ELSE 0 END) AS rows_1d,
                      SUM(CASE WHEN created_at >= NOW() - INTERVAL 7 DAY THEN 1 ELSE 0 END) AS rows_7d,
                      SUM(CASE WHEN created_at >= NOW() - INTERVAL 30 DAY THEN 1 ELSE 0 END) AS rows_30d
                    FROM {q(table_name)}
                    """
                )
            ).first()._mapping
        )
        row["table_name"] = table_name
        stats.append(row)
        daily[table_name] = fetch_all_dicts(
            db,
            f"""
            SELECT DATE(created_at) AS d, COUNT(*) AS cnt
            FROM {q(table_name)}
            WHERE created_at >= NOW() - INTERVAL 30 DAY
            GROUP BY DATE(created_at)
            ORDER BY d DESC
            """,
        )
    return stats, daily


def collect_index_columns(db) -> dict[str, list[dict[str, Any]]]:
    rows = fetch_all_dicts(
        db,
        """
        SELECT table_name, index_name, column_name, seq_in_index, non_unique
        FROM information_schema.statistics
        WHERE table_schema = DATABASE()
        ORDER BY table_name, index_name, seq_in_index
        """,
    )
    grouped: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        grouped.setdefault(str(row["table_name"]), []).append(row)
    return grouped


def has_index_prefix(index_rows: list[dict[str, Any]], columns: tuple[str, ...]) -> bool:
    grouped: dict[str, list[str]] = {}
    for row in index_rows:
        grouped.setdefault(str(row["index_name"]), []).append(str(row["column_name"]))
    return any(tuple(cols[: len(columns)]) == columns for cols in grouped.values())


def build_index_suggestions(
    tables: list[TableInfo],
    columns_by_table: dict[str, list[str]],
    indexes_by_table: dict[str, list[dict[str, Any]]],
) -> list[dict[str, str]]:
    suggestions: list[dict[str, str]] = []
    large_tables = [
        item
        for item in tables
        if (item.exact_rows if item.exact_rows is not None else item.approx_rows) >= 1000 or item.total_mb >= 1
    ]
    for item in large_tables:
        table = item.table_name
        columns = set(columns_by_table.get(table, []))
        indexes = indexes_by_table.get(table, [])
        checks = [
            (("created_at",), "created_at", "P1", "后台默认时间范围和生命周期清理"),
            (("user_id", "created_at"), "user_id + created_at", "P1", "用户维度流水/订单查询"),
            (("status", "created_at"), "status + created_at", "P1", "状态筛选和任务列表"),
            (("symbol", "created_at"), "symbol + created_at", "P2", "交易对/合约标的维度查询"),
            (("tx_hash",), "tx_hash", "P0", "链上交易哈希精确查询"),
            (("order_no",), "order_no", "P0", "订单号精确查询"),
            (("request_id",), "request_id", "P1", "幂等请求查询"),
            (("biz_id",), "biz_id", "P1", "业务流水关联查询"),
        ]
        for index_columns, label, risk, reason in checks:
            if all(column in columns for column in index_columns) and not has_index_prefix(indexes, index_columns):
                suggestions.append(
                    {
                        "risk": risk,
                        "table_name": table,
                        "suggested_index": label,
                        "reason": reason,
                    }
                )
    risk_order = {"P0": 0, "P1": 1, "P2": 2}
    suggestions.sort(key=lambda row: (risk_order.get(row["risk"], 9), row["table_name"], row["suggested_index"]))
    return suggestions


def _extract_function_body(source: str, function_name: str) -> tuple[int, str]:
    marker = f"def {function_name}("
    start = source.find(marker)
    if start < 0:
        return (0, "")
    line_no = source[:start].count("\n") + 1
    next_def = source.find("\ndef ", start + len(marker))
    if next_def < 0:
        next_def = len(source)
    return (line_no, source[start:next_def])


def scan_admin_pages() -> list[dict[str, str]]:
    backend_dir = Path(__file__).resolve().parents[1]
    admin_queries = (backend_dir / "app" / "services" / "admin_queries.py").read_text(encoding="utf-8", errors="replace")
    admin_pages = (backend_dir / "app" / "routers" / "admin_pages.py").read_text(encoding="utf-8", errors="replace")
    result: list[dict[str, str]] = []
    for label, functions in ADMIN_PAGE_QUERIES.items():
        bodies: list[str] = []
        snippets: list[str] = []
        for function_name in functions:
            source_name = "admin_pages.py" if function_name == "geo_access_page" else "admin_queries.py"
            source = admin_pages if function_name == "geo_access_page" else admin_queries
            line_no, body = _extract_function_body(source, function_name)
            bodies.append(body)
            if body:
                signals = []
                if "OFFSET" in body or "offset" in body:
                    signals.append("OFFSET")
                if "COUNT(*)" in body:
                    signals.append("COUNT(*)")
                if "timedelta(days=30)" in body or "timedelta(days=7)" in body or "timedelta(hours=24)" in body:
                    signals.append("default-window")
                if any(item in body for item in ("created_from", "start_time", "from_time", "start_date", "date_from")):
                    signals.append("time-filter")
                snippets.append(f"{source_name}:{line_no} {function_name} [{', '.join(signals) or 'no-signal'}]")
            else:
                snippets.append(f"{source_name}:? {function_name} [not-found]")
        combined = "\n".join(bodies)
        has_default_window = any(
            item in combined
            for item in (
                "timedelta(days=30)",
                "timedelta(days=7)",
                "timedelta(days=6)",
                "timedelta(hours=24)",
                "datetime.utcnow() - timedelta",
            )
        )
        has_time_filter = any(
            item in combined
            for item in (
                "created_from",
                "created_to",
                "start_time",
                "end_time",
                "from_time",
                "to_time",
                "start_date",
                "end_date",
                "date_from",
                "date_to",
            )
        )
        has_offset = "OFFSET" in combined or "offset" in combined
        has_count = "COUNT(*)" in combined
        if has_default_window:
            range_signal = "有默认时间范围信号"
        elif has_time_filter:
            range_signal = "支持时间筛选，但未发现默认时间范围"
        else:
            range_signal = "未发现时间范围过滤"
        result.append(
            {
                "page": label,
                "evidence": "<br>".join(snippets) if snippets else "-",
                "default_range_signal": range_signal,
                "pagination_risk": (
                    "COUNT(*) + OFFSET 深分页风险"
                    if has_count and has_offset
                    else "未发现 COUNT + OFFSET 组合"
                ),
            }
        )
    return result


def md_table(headers: list[str], rows: list[list[Any]]) -> str:
    def cell(value: Any) -> str:
        if value is None:
            return "-"
        return str(value).replace("\n", "<br>").replace("|", "\\|")

    lines = [
        "| " + " | ".join(headers) + " |",
        "| " + " | ".join("---" for _ in headers) + " |",
    ]
    for row in rows:
        lines.append("| " + " | ".join(cell(value) for value in row) + " |")
    return "\n".join(lines)


def render_report(
    *,
    schema_name: str,
    tables: list[TableInfo],
    created_stats: list[dict[str, Any]],
    daily_growth: dict[str, list[dict[str, Any]]],
    index_suggestions: list[dict[str, str]],
    admin_scan: list[dict[str, str]],
) -> str:
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    exact_row = lambda item: item.exact_rows if item.exact_rows is not None else f"~{item.approx_rows}"
    top_rows = sorted(tables, key=lambda row: (row.exact_rows if row.exact_rows is not None else row.approx_rows, row.total_mb), reverse=True)[:30]
    top_size = sorted(tables, key=lambda row: row.total_mb, reverse=True)[:30]
    top_index = sorted(tables, key=lambda row: row.index_mb, reverse=True)[:30]
    growth_top = sorted(created_stats, key=lambda row: int(row.get("rows_30d") or 0), reverse=True)[:30]

    lines = [
        "# 全库大表与数据生命周期审计",
        "",
        f"- 生成时间：{now}",
        f"- 数据库：`{schema_name}`",
        "- 执行方式：只读 SQL。未执行 `DELETE` / `TRUNCATE` / `UPDATE`。",
        "- 说明：InnoDB `information_schema.tables.table_rows` 可能为估算值；Top 大表已补充精确 `COUNT(*)`。",
        "",
        "## 总览",
        "",
        f"- 表数量：{len(tables)}",
        f"- 总体积估算：{sum(item.total_mb for item in tables):.2f} MB",
        f"- 总索引体积估算：{sum(item.index_mb for item in tables):.2f} MB",
        "",
        "## 全库表清单",
        "",
        md_table(
            ["table_name", "row_count", "data_size_mb", "index_size_mb", "total_size_mb", "created_at", "updated_at", "primary_key", "index_count", "分类"],
            [
                [
                    item.table_name,
                    exact_row(item),
                    item.data_mb,
                    item.index_mb,
                    item.total_mb,
                    "Y" if item.has_created_at else "N",
                    "Y" if item.has_updated_at else "N",
                    item.primary_key,
                    item.index_count,
                    classify_table(item.table_name)[0],
                ]
                for item in tables
            ],
        ),
        "",
        "## Top 大表",
        "",
        "### 行数 Top 30",
        "",
        md_table(
            ["table_name", "row_count", "total_mb", "data_mb", "index_mb", "created_at"],
            [[item.table_name, exact_row(item), item.total_mb, item.data_mb, item.index_mb, "Y" if item.has_created_at else "N"] for item in top_rows],
        ),
        "",
        "### 体积 Top 30",
        "",
        md_table(
            ["table_name", "total_mb", "row_count", "data_mb", "index_mb"],
            [[item.table_name, item.total_mb, exact_row(item), item.data_mb, item.index_mb] for item in top_size],
        ),
        "",
        "### 索引体积 Top 30",
        "",
        md_table(
            ["table_name", "index_mb", "total_mb", "row_count", "index_count"],
            [[item.table_name, item.index_mb, item.total_mb, exact_row(item), item.index_count] for item in top_index],
        ),
        "",
        "### 最近 30 天增长 Top 30",
        "",
        md_table(
            ["table_name", "rows_30d", "rows_7d", "rows_1d", "first_created_at", "last_created_at"],
            [
                [
                    row["table_name"],
                    int(row.get("rows_30d") or 0),
                    int(row.get("rows_7d") or 0),
                    int(row.get("rows_1d") or 0),
                    row.get("first_created_at"),
                    row.get("last_created_at"),
                ]
                for row in growth_top
            ],
        ),
        "",
        "## 有 created_at 的大表时间分布",
        "",
        md_table(
            ["table_name", "first_created_at", "last_created_at", "rows_1d", "rows_7d", "rows_30d"],
            [
                [
                    row["table_name"],
                    row.get("first_created_at"),
                    row.get("last_created_at"),
                    int(row.get("rows_1d") or 0),
                    int(row.get("rows_7d") or 0),
                    int(row.get("rows_30d") or 0),
                ]
                for row in created_stats
            ],
        ),
        "",
        "### 最近 30 天按天增长样例（Top 增长表）",
        "",
    ]
    for row in growth_top[:10]:
        table_name = row["table_name"]
        lines.extend(
            [
                f"#### {table_name}",
                "",
                md_table(
                    ["date", "count"],
                    [[item.get("d"), item.get("cnt")] for item in daily_growth.get(table_name, [])[:30]],
                ),
                "",
            ]
        )

    lines.extend(
        [
            "## 业务类型分类与建议保留策略",
            "",
            md_table(
                ["table_name", "分类", "说明", "建议保留策略"],
                [
                    [
                        item.table_name,
                        classify_table(item.table_name)[0],
                        classify_table(item.table_name)[1],
                        retention_policy_for(classify_table(item.table_name)[0], item.table_name),
                    ]
                    for item in tables
                ],
            ),
            "",
            "## 后台大表页面默认范围与分页风险",
            "",
            md_table(
                ["页面", "默认时间范围信号", "分页风险", "证据片段"],
                [[item["page"], item["default_range_signal"], item["pagination_risk"], item["evidence"]] for item in admin_scan],
            ),
            "",
            "## 索引建议（只建议，不执行）",
            "",
            md_table(
                ["风险", "table_name", "建议索引", "对应页面/查询"],
                [[item["risk"], item["table_name"], item["suggested_index"], item["reason"]] for item in index_suggestions[:80]],
            ),
            "",
            "## 最终治理建议",
            "",
            "### P0：必须立即处理",
            "",
            "- 对 Top 增长表和体积 Top 表补齐后台默认时间范围，避免无条件全表查询。",
            "- 对缺少 `tx_hash`、`order_no` 等精确查询索引的大表优先评估索引。",
            "- 对 Geo Access、任务日志、成功类技术日志建立定时清理或归档入口。",
            "",
            "### P1：上线前建议处理",
            "",
            "- 建立 maintenance cleanup job，按表类型执行 30/90/180 天清理或归档策略。",
            "- 大表后台查询统一加默认 7/24/30 天窗口，超过 30 天必须带精准条件。",
            "- 日志保留天数改为配置化，并在后台显示当前策略。",
            "",
            "### P2：上线后增强",
            "",
            "- 对核心账务表建设月度归档表或冷数据导出。",
            "- 将深 offset 分页逐步迁移为 keyset pagination。",
            "- 增加 worker dashboard，展示清理、归档、队列和失败重试状态。",
            "",
            "## 重要边界",
            "",
            "- 本报告未执行清理、删除或业务数据修复。",
            "- 核心账务表原则上不直接删除，只允许归档或冷数据迁移后按审计流程处理。",
        ]
    )
    return "\n".join(lines) + "\n"


def retention_policy_for(category: str, table_name: str) -> str:
    if table_name.lower() == "market_klines":
        return "正式 K 线数据不建议直接删除；可按周期归档或压缩，查询必须按 symbol/interval/time 范围。"
    if category == "A":
        if "balance_log" in table_name.lower():
            return "在线保留 12～24 个月，之后归档；禁止无条件全表分页。"
        if "order" in table_name.lower() or "trade" in table_name.lower():
            return "在线保留 12～24 个月，归档后仍需支持订单号/用户精准查询。"
        return "不直接删除；按月归档；后台查询默认最近 7/30 天，长范围必须带精准条件。"
    if category == "B":
        return "长期保留但可归档；后台默认最近 30 天，按操作人/IP/对象过滤。"
    if category == "C":
        return "成功日志保留 90 天，失败日志可保留 180 天；任务状态表按业务完成态归档。"
    if category == "D":
        return "保留 90 天访问控制事件摘要；普通 ALLOW 不落库或聚合落库。"
    if category == "E":
        return "保留 7～30 天；过期验证码、token、session 可定时清理。"
    if category == "F":
        return "短周期缓存可清理或覆盖；正式 K 线/账务相关行情数据不能随意删除。"
    return "按业务责任人确认保留周期。"


def main() -> int:
    parser = argparse.ArgumentParser(description="Read-only database table lifecycle audit.")
    parser.add_argument("--output", default="", help="Optional markdown report output path.")
    args = parser.parse_args()

    db = SessionLocal()
    try:
        schema_name, tables, columns_by_table, _ = collect_tables(db)
        tables = with_exact_counts(db, tables)
        created_stats, daily_growth = collect_created_at_stats(db, tables)
        index_suggestions = build_index_suggestions(tables, columns_by_table, collect_index_columns(db))
        admin_scan = scan_admin_pages()
        report = render_report(
            schema_name=schema_name,
            tables=tables,
            created_stats=created_stats,
            daily_growth=daily_growth,
            index_suggestions=index_suggestions,
            admin_scan=admin_scan,
        )
    finally:
        db.close()

    if args.output:
        output_path = Path(args.output)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(report, encoding="utf-8")
    else:
        print(report)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
