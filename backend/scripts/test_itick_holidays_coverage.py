from __future__ import annotations

import json
import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import ProxyHandler, Request, build_opener

from sqlalchemy import inspect, or_, text
from sqlalchemy.exc import SQLAlchemyError


BACKEND_DIR = Path(__file__).resolve().parents[1]
ENV_PATH = BACKEND_DIR / ".env"
TIMEOUT_SECONDS = 8

DEFAULT_HOSTS: Tuple[str, ...] = (
    "https://api0.itick.org/symbol/v2/holidays",
    "https://api.itick.org/symbol/v2/holidays",
)

BASE_CODES: Tuple[str, ...] = (
    "US",
    "HK",
    "GB",
    "AU",
    "DE",
    "JP",
    "SG",
    "CN",
    "CA",
)

TRADFI_ASSET_TYPES = {"STOCK", "INDEX", "FOREX", "METAL", "COMMODITY"}
CONTRACT_CATEGORY_TO_REGION = {
    "STOCK": "US",
    "INDEX": "US",
    "GOLD": "GB",
    "FOREX": "GB",
    "FUTURES": "GB",
}


def load_env(path: Path) -> None:
    if not path.exists():
        return

    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue

        key, value = stripped.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


load_env(ENV_PATH)

if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.db.models.contract_symbol import ContractSymbol  # noqa: E402
from app.db.models.trading_pair import TradingPair  # noqa: E402
from app.db.session import SessionLocal  # noqa: E402


@dataclass(frozen=True)
class HolidayResult:
    host: str
    code: str
    http_status: int | str
    api_code: Any
    api_msg: str
    data_count: int
    sample: Optional[Dict[str, Any]]
    body_preview: str

    @property
    def passed(self) -> bool:
        return self.http_status == 200 and self.api_code == 0 and self.data_count > 0

    @property
    def auth_problem(self) -> bool:
        return self.http_status in (401, 403)


@dataclass(frozen=True)
class ProjectRegion:
    code: str
    source_table: str
    asset_type: str
    symbol: str
    region_source: str


def normalize_code(value: Any) -> str:
    return str(value or "").strip().upper()


def normalize_host(value: str) -> str:
    raw = str(value or "").strip().rstrip("/")
    if not raw:
        return ""
    if raw.endswith("/symbol/v2/holidays"):
        return raw
    return f"{raw}/symbol/v2/holidays"


def unique_hosts() -> List[str]:
    env_host = normalize_host(os.getenv("ITICK_API_BASE_URL") or os.getenv("ITICK_BASE_URL") or "")
    hosts: List[str] = []
    for host in [env_host, *DEFAULT_HOSTS]:
        if host and host not in hosts:
            hosts.append(host)
    return hosts


def token_fingerprint(token: str) -> Dict[str, object]:
    return {
        "token_exists": bool(token),
        "token_length": len(token),
        "prefix": token[:4] if len(token) >= 4 else token,
        "suffix": token[-4:] if len(token) >= 4 else token,
    }


def request_holidays(host: str, code: str, token: str) -> HolidayResult:
    url = f"{host}?{urlencode({'code': code})}"
    headers = {
        "accept": "application/json",
        "token": token,
    }
    opener = build_opener(ProxyHandler({}))
    request = Request(url, headers=headers, method="GET")

    try:
        with opener.open(request, timeout=TIMEOUT_SECONDS) as response:
            body = response.read().decode("utf-8", errors="replace")
            return parse_response(host, code, response.status, body)
    except HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        return parse_response(host, code, exc.code, body)
    except URLError as exc:
        return HolidayResult(
            host=host,
            code=code,
            http_status="REQUEST_ERROR",
            api_code=None,
            api_msg=repr(exc),
            data_count=0,
            sample=None,
            body_preview=repr(exc)[:300],
        )


def parse_response(host: str, code: str, http_status: int, body: str) -> HolidayResult:
    api_code: Any = None
    api_msg = ""
    data_count = 0
    sample = None

    try:
        payload = json.loads(body)
    except json.JSONDecodeError:
        return HolidayResult(host, code, http_status, api_code, "NON_JSON_RESPONSE", 0, None, body[:300])

    if isinstance(payload, dict):
        api_code = payload.get("code")
        api_msg = str(payload.get("msg") or payload.get("message") or "")
        data = payload.get("data")
    else:
        data = payload

    rows = normalize_data_rows(data)
    data_count = len(rows)
    if rows:
        first = rows[0] if isinstance(rows[0], dict) else {}
        sample = {key: first.get(key) for key in ("c", "r", "d", "t", "z", "v")}

    return HolidayResult(host, code, http_status, api_code, api_msg, data_count, sample, body[:300])


def normalize_data_rows(data: Any) -> List[Any]:
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        for key in ("list", "items", "rows", "data"):
            value = data.get(key)
            if isinstance(value, list):
                return value
        return [data] if data else []
    return []


def print_result(result: HolidayResult) -> None:
    status_text = classify_result(result)
    print(f"host={result.host}")
    print(f"code={result.code}")
    print(f"http_status={result.http_status}")
    print(f"api_code={result.api_code}")
    print(f"api_msg={result.api_msg}")
    print(f"data_count={result.data_count}")
    print(f"sample={json.dumps(result.sample or {}, ensure_ascii=False)}")
    print(f"result={status_text}")
    if status_text == "ERROR":
        print(f"body_preview={result.body_preview[:300]}")
    print("")


def classify_result(result: HolidayResult) -> str:
    if result.passed:
        return "PASS"
    if result.auth_problem:
        return "TOKEN_OR_HOST_PROBLEM"
    if result.http_status == 200 and result.api_code == 0 and result.data_count == 0:
        return "EMPTY_DATA"
    return "ERROR"


def best_result(results: Sequence[HolidayResult]) -> Optional[HolidayResult]:
    if not results:
        return None
    for result in results:
        if result.passed:
            return result
    for result in results:
        if result.http_status == 200 and result.api_code == 0:
            return result
    return results[0]


def has_column(inspector: Any, table_name: str, column_name: str) -> bool:
    try:
        columns = inspector.get_columns(table_name)
    except SQLAlchemyError:
        return False
    return any(column.get("name") == column_name for column in columns)


def collect_project_regions() -> List[ProjectRegion]:
    regions: List[ProjectRegion] = []
    db = SessionLocal()
    try:
        inspector = inspect(db.bind)
        contract_has_external_region = has_column(inspector, "contract_symbols", "external_region")

        trading_pairs = (
            db.query(TradingPair)
            .filter(
                or_(
                    TradingPair.data_source == "ITICK",
                    TradingPair.asset_type.in_(sorted(TRADFI_ASSET_TYPES)),
                )
            )
            .all()
        )
        for item in trading_pairs:
            code = normalize_code(item.external_region)
            if not code:
                continue
            regions.append(
                ProjectRegion(
                    code=code,
                    source_table="trading_pairs",
                    asset_type=normalize_code(item.asset_type),
                    symbol=str(item.symbol or ""),
                    region_source="external_region",
                )
            )

        contract_symbols = db.query(ContractSymbol).filter(ContractSymbol.provider == "ITICK").all()
        contract_external_regions = load_contract_external_region_map(db) if contract_has_external_region else {}
        for item in contract_symbols:
            category = normalize_code(item.category)
            explicit_region = normalize_code(contract_external_regions.get(int(item.id)))
            inferred_region = CONTRACT_CATEGORY_TO_REGION.get(category, "")
            code = explicit_region or inferred_region
            if not code:
                continue
            regions.append(
                ProjectRegion(
                    code=code,
                    source_table="contract_symbols",
                    asset_type=category,
                    symbol=str(item.symbol or ""),
                    region_source="external_region" if explicit_region else "inferred_from_category",
                )
            )
    except SQLAlchemyError as exc:
        print(f"project_region_db_error={exc!r}")
    finally:
        db.close()

    return regions


def load_contract_external_region_map(db: Any) -> Dict[int, str]:
    rows = db.execute(text("SELECT id, external_region FROM contract_symbols WHERE provider = 'ITICK'")).mappings().all()
    return {int(row["id"]): normalize_code(row["external_region"]) for row in rows}


def dedupe_regions(regions: Iterable[ProjectRegion]) -> List[ProjectRegion]:
    seen: set[Tuple[str, str, str, str]] = set()
    unique: List[ProjectRegion] = []
    for region in regions:
        key = (region.code, region.source_table, region.asset_type, region.symbol)
        if key in seen:
            continue
        seen.add(key)
        unique.append(region)
    return unique


def region_codes(regions: Iterable[ProjectRegion]) -> List[str]:
    return sorted({region.code for region in regions if region.code})


def project_coverage(regions: Sequence[ProjectRegion], pass_codes: set[str]) -> Tuple[int, int, float]:
    total = len(regions)
    covered = sum(1 for region in regions if region.code in pass_codes)
    rate = (covered / total * 100) if total else 0.0
    return covered, total, rate


def recommend_asset_types(regions: Sequence[ProjectRegion], pass_codes: set[str]) -> List[str]:
    by_type: Dict[str, List[ProjectRegion]] = {}
    for region in regions:
        by_type.setdefault(region.asset_type or "UNKNOWN", []).append(region)

    recommended = []
    for asset_type, items in sorted(by_type.items()):
        if items and all(item.code in pass_codes for item in items):
            recommended.append(asset_type)
    return recommended


def print_project_region_details(regions: Sequence[ProjectRegion]) -> None:
    print("PROJECT_ITICK_EXTERNAL_REGIONS")
    if not regions:
        print("none")
        print("")
        return

    grouped: Dict[str, Dict[str, Any]] = {}
    for region in regions:
        bucket = grouped.setdefault(
            region.code,
            {"count": 0, "asset_types": set(), "examples": [], "region_sources": set()},
        )
        bucket["count"] += 1
        bucket["asset_types"].add(region.asset_type)
        bucket["region_sources"].add(region.region_source)
        if len(bucket["examples"]) < 5:
            bucket["examples"].append(f"{region.source_table}:{region.symbol}")

    for code in sorted(grouped):
        bucket = grouped[code]
        asset_types = ",".join(sorted(bucket["asset_types"]))
        region_sources = ",".join(sorted(bucket["region_sources"]))
        examples = ", ".join(bucket["examples"])
        print(
            f"code={code} count={bucket['count']} asset_types={asset_types} "
            f"region_sources={region_sources} examples={examples}"
        )
    print("")


def run_matrix(hosts: Sequence[str], codes: Sequence[str], token: str) -> Dict[str, List[HolidayResult]]:
    matrix: Dict[str, List[HolidayResult]] = {}
    for code in codes:
        matrix[code] = []
        for host in hosts:
            result = request_holidays(host, code, token)
            matrix[code].append(result)
            print_result(result)
    return matrix


def main() -> None:
    token = (os.getenv("ITICK_API_TOKEN") or "").strip()
    hosts = unique_hosts()

    print("ITICK_HOLIDAYS_COVERAGE_TEST")
    for key, value in token_fingerprint(token).items():
        print(f"{key}={value}")
    print(f"hosts={','.join(hosts)}")
    print("")

    project_regions = dedupe_regions(collect_project_regions())
    print_project_region_details(project_regions)

    codes = sorted(set(BASE_CODES) | set(region_codes(project_regions)))
    print(f"TEST_CODES={','.join(codes)}")
    print("")

    matrix = run_matrix(hosts, codes, token)
    best_by_code = {code: best_result(results) for code, results in matrix.items()}
    pass_codes = {code for code, result in best_by_code.items() if result and result.passed}
    unavailable_codes = {code for code, result in best_by_code.items() if not result or not result.passed}
    covered, total, coverage_rate = project_coverage(project_regions, pass_codes)
    recommended = recommend_asset_types(project_regions, pass_codes)

    print("SUMMARY")
    print(f"available_codes={','.join(sorted(pass_codes)) or '-'}")
    print(f"unavailable_codes={','.join(sorted(unavailable_codes)) or '-'}")
    print(f"project_itick_symbol_coverage={covered}/{total} ({coverage_rate:.2f}%)")
    print(f"recommended_asset_types={','.join(recommended) or '-'}")

    empty_codes = [
        code
        for code, result in best_by_code.items()
        if result and result.http_status == 200 and result.api_code == 0 and result.data_count == 0
    ]
    auth_problem_codes = [code for code, result in best_by_code.items() if result and result.auth_problem]
    print(f"empty_data_codes={','.join(sorted(empty_codes)) or '-'}")
    print(f"token_or_host_problem_codes={','.join(sorted(auth_problem_codes)) or '-'}")


if __name__ == "__main__":
    main()
