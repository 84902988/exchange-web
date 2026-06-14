from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import requests
from dotenv import load_dotenv


BACKEND_DIR = Path(__file__).resolve().parents[1]
ENV_PATH = BACKEND_DIR / ".env"
BASE_URL = "https://api0.itick.org"
QUOTE_PATH = "/stock/quote"
SYMBOL_LIST_PATH = "/symbol/list"
TIMEOUT_SECONDS = 8


def _mask_token(value: str) -> str:
    if not value:
        return ""
    if len(value) <= 10:
        return f"{value[:2]}***{value[-2:]}"
    return f"{value[:6]}***{value[-4:]}"


def _json_preview(payload: Any) -> str:
    try:
        text = json.dumps(payload, ensure_ascii=False)
    except TypeError:
        text = str(payload)
    return text[:1000]


def _first_data(payload: Any) -> Any:
    if not isinstance(payload, dict):
        return None
    data = payload.get("data")
    if isinstance(data, list):
        return data[0] if data else None
    return data


def _price_fields(data: Any) -> dict[str, Any]:
    if not isinstance(data, dict):
        return {}
    keys = ("ld", "last", "price", "close", "p", "c")
    return {key: data.get(key) for key in keys if data.get(key) not in (None, "")}


def _row_has_imaa(row: dict[str, Any]) -> bool:
    text = json.dumps(row, ensure_ascii=False).upper()
    return "IMAA" in text or "IMA TECH" in text


def _exchange_from_row(row: dict[str, Any]) -> Any:
    for key in ("e", "exchange", "ex", "m", "market"):
        value = row.get(key)
        if value not in (None, ""):
            return value
    return None


def main() -> None:
    load_dotenv(ENV_PATH, override=False)

    token = (os.getenv("ITICK_API_TOKEN") or os.getenv("ITICK_API_KEY") or "").strip()
    configured_base = (os.getenv("ITICK_API_BASE_URL") or "").strip()
    url = f"{BASE_URL}{QUOTE_PATH}"

    print(f"backend_env={ENV_PATH}")
    print(f"ITICK_API_TOKEN={_mask_token(token)} present={bool(token)}")
    print(f"ITICK_API_BASE_URL={configured_base or '-'}")
    print(f"base_url_used={BASE_URL}")
    print()

    session = requests.Session()
    session.trust_env = False
    headers = {
        "token": token,
        "accept": "application/json",
    }

    test_cases = [("US", "IMAA"), ("US", "TSLA"), ("US", "AAPL")]
    imaa_codes = ("IMAA", "IMAA.US", "OTC:IMAA", "IMAA.OTC", "IMAA.PK", "IMAA:US")
    imaa_regions = ("US", "OTC", "OTCM", "PINK")
    test_cases.extend((region, code) for region in imaa_regions for code in imaa_codes)

    seen: set[tuple[str, str]] = set()
    for region, code in test_cases:
        if (region, code) in seen:
            continue
        seen.add((region, code))

        params = {
            "region": region,
            "code": code,
        }
        safe_headers = {
            "token": _mask_token(token),
            "accept": "application/json",
        }

        print("=" * 80)
        print(f"symbol={code} region={region}")
        print(f"request url={url}")
        print(f"params={params}")
        print(f"headers={safe_headers}")

        try:
            response = session.get(url, params=params, headers=headers, timeout=TIMEOUT_SECONDS)
            print(f"final url={response.url}")
            print(f"http status={response.status_code}")
            try:
                payload = response.json()
            except ValueError:
                print(f"response preview={response.text[:1000]}")
                print("has_data=False")
                print("price_fields={}")
                continue

            data = _first_data(payload)
            prices = _price_fields(data)
            print(f"response preview={_json_preview(payload)}")
            print(f"has_data={data is not None}")
            print(f"price_fields={prices}")
            print(f"has_usable_price={bool(prices)}")
        except Exception as exc:
            print(f"request_error={type(exc).__name__}: {exc}")

    print("=" * 80)
    print("symbol list exchange checks")
    found_exchange_values: list[Any] = []
    symbol_list_cases = [
        {"type": "stock", "region": "US", "code": "IMAA"},
        {"type": "stock", "region": "US", "keyword": "IMAA"},
        {"type": "stock", "region": "US"},
    ]
    for params in symbol_list_cases:
        url = f"{BASE_URL}{SYMBOL_LIST_PATH}"
        safe_headers = {
            "token": _mask_token(token),
            "accept": "application/json",
        }
        print("=" * 80)
        print(f"symbol_list params={params}")
        print(f"request url={url}")
        print(f"params={params}")
        print(f"headers={safe_headers}")
        try:
            response = session.get(url, params=params, headers=headers, timeout=TIMEOUT_SECONDS)
            print(f"final url={response.url}")
            print(f"http status={response.status_code}")
            try:
                payload = response.json()
            except ValueError:
                print(f"response preview={response.text[:1000]}")
                print("data_length=0")
                print("has_c_IMAA=False")
                continue

            data = payload.get("data") if isinstance(payload, dict) else None
            rows = data if isinstance(data, list) else []
            matching_rows = [
                row for row in rows
                if isinstance(row, dict) and (
                    str(row.get("c") or "").strip().upper() == "IMAA" or _row_has_imaa(row)
                )
            ]
            print(f"response preview={_json_preview(payload)}")
            print(f"data_length={len(rows)}")
            if "code" not in params and "keyword" not in params:
                print(f"first_20={_json_preview(rows[:20])}")
            print(f"has_IMAA={bool(matching_rows)}")
            for row in matching_rows:
                exchange_value = _exchange_from_row(row)
                if exchange_value not in (None, ""):
                    found_exchange_values.append(exchange_value)
                print({
                    "c": row.get("c"),
                    "n": row.get("n"),
                    "e": row.get("e"),
                    "exchange": row.get("exchange"),
                    "ex": row.get("ex"),
                    "m": row.get("m"),
                    "market": row.get("market"),
                    "t": row.get("t"),
                })
        except Exception as exc:
            print(f"request_error={type(exc).__name__}: {exc}")

    unique_exchanges = []
    for value in found_exchange_values:
        if value not in unique_exchanges:
            unique_exchanges.append(value)

    print("=" * 80)
    print(f"found_exchange_values={unique_exchanges}")
    if not unique_exchanges:
        print("symbol/list did not expose an exchange code for IMAA")
    for exchange in unique_exchanges:
        params = {
            "region": "US",
            "code": "IMAA",
            "exchange": str(exchange),
        }
        url = f"{BASE_URL}{QUOTE_PATH}"
        print("=" * 80)
        print(f"quote_with_exchange exchange={exchange}")
        print(f"request url={url}")
        print(f"params={params}")
        try:
            response = session.get(url, params=params, headers=headers, timeout=TIMEOUT_SECONDS)
            print(f"final url={response.url}")
            print(f"http status={response.status_code}")
            try:
                payload = response.json()
            except ValueError:
                print(f"response preview={response.text[:1000]}")
                continue
            data = _first_data(payload)
            prices = _price_fields(data)
            print(f"response preview={_json_preview(payload)}")
            print(f"has_data={data is not None}")
            print(f"price_fields={prices}")
            print(f"has_usable_price={bool(prices)}")
        except Exception as exc:
            print(f"request_error={type(exc).__name__}: {exc}")


if __name__ == "__main__":
    main()
