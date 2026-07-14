from __future__ import annotations

import ast
from pathlib import Path

from fastapi.encoders import jsonable_encoder

from app.schemas.response import ok
from app.schemas.contract_market import ContractKlineHistoryMetadataResponse
from app.services.contract_kline_response import (
    ContractKlineResult,
    build_contract_kline_metadata,
    contract_kline_error_result,
    contract_kline_process_cache_result,
    contract_kline_provider_result,
    serialize_contract_kline_response,
)


ROOT = Path(__file__).resolve().parents[2]


def _row(open_time: int = 1_700_000_000_000) -> dict[str, object]:
    return {
        "open_time": open_time,
        "open": "100",
        "high": "110",
        "low": "90",
        "close": "105",
        "volume": "5",
    }


def test_default_contract_kline_response_remains_legacy_array() -> None:
    result = ContractKlineResult(
        [_row()],
        origin="DB_CACHE",
        cache_status="HIT",
    )

    payload = serialize_contract_kline_response(
        result,
        include_metadata=False,
        end_time_ms=None,
    )

    assert type(payload) is list
    assert payload == [_row()]


def test_metadata_response_for_normal_provider_data() -> None:
    result = contract_kline_provider_result([_row()])

    payload = build_contract_kline_metadata(result, end_time_ms=None)

    assert payload == {
        "items": [_row()],
        "cache_status": "MISS",
        "freshness": "RECENT",
        "stale": False,
        "history_incomplete": False,
        "history_complete": None,
        "has_more_before": None,
        "history_terminal": None,
        "terminal_reason": None,
        "earliest_available_time": None,
        "coverage_complete": None,
        "provider_error_code": None,
        "retryable": False,
    }


def test_metadata_response_preserves_db_cache_hit() -> None:
    result = ContractKlineResult(
        [_row()],
        origin="DB_CACHE",
        cache_status="HIT",
    )

    payload = build_contract_kline_metadata(result, end_time_ms=1_700_000_060_000)

    assert payload["items"] == [_row()]
    assert payload["cache_status"] == "HIT"
    assert payload["freshness"] == "CACHED"
    assert payload["stale"] is False
    assert payload["history_complete"] is False
    assert payload["has_more_before"] is None
    assert payload["history_terminal"] is False
    assert payload["coverage_complete"] is None


def test_metadata_response_preserves_stale_fallback() -> None:
    result = ContractKlineResult(
        [_row()],
        origin="STALE_CACHE",
        cache_status="SHORT",
        history_incomplete=True,
        provider_error_code="TIMEOUT",
    )

    payload = build_contract_kline_metadata(result, end_time_ms=1_700_000_060_000)

    assert payload["freshness"] == "STALE"
    assert payload["stale"] is True
    assert payload["history_incomplete"] is True
    assert payload["provider_error_code"] == "TIMEOUT"
    assert payload["retryable"] is True
    assert payload["history_complete"] is False
    assert payload["has_more_before"] is None


def test_metadata_response_marks_transient_provider_error_retryable() -> None:
    for error_code in ("TIMEOUT", "COOLDOWN", "HTTP_ERROR", "UNKNOWN"):
        result = ContractKlineResult(
            [],
            origin="EMPTY",
            cache_status="MISS",
            history_incomplete=True,
            provider_error_code=error_code,
        )

        payload = build_contract_kline_metadata(result, end_time_ms=1_700_000_060_000)

        assert payload["items"] == []
        assert payload["freshness"] == "MISSING"
        assert payload["history_incomplete"] is True
        assert payload["provider_error_code"] == error_code
        assert payload["retryable"] is True
        assert payload["history_complete"] is False
        assert payload["has_more_before"] is None
        assert payload["history_terminal"] is False
        assert payload["terminal_reason"] is None
        assert payload["earliest_available_time"] is None
        assert payload["coverage_complete"] is False


def test_transient_error_factory_classifies_all_retryable_error_families() -> None:
    cases = (
        (TimeoutError("provider timed out"), "TIMEOUT"),
        (RuntimeError("provider cooldown active"), "COOLDOWN"),
        (RuntimeError("http status_code=503"), "HTTP_ERROR"),
        (RuntimeError("unclassified provider failure"), "UNKNOWN"),
    )
    for error, expected_code in cases:
        result = contract_kline_error_result(
            error,
            end_time_ms=1_700_000_060_000,
        )
        payload = build_contract_kline_metadata(
            result,
            end_time_ms=1_700_000_060_000,
        )

        assert payload["provider_error_code"] == expected_code
        assert payload["retryable"] is True
        assert payload["history_incomplete"] is True
        assert payload["history_complete"] is False
        assert payload["has_more_before"] is None


def test_metadata_response_does_not_treat_unavailable_empty_code_as_terminal() -> None:
    result = ContractKlineResult(
        [],
        origin="EMPTY",
        cache_status="MISS",
        history_incomplete=True,
        provider_error_code="EMPTY",
    )

    payload = build_contract_kline_metadata(result, end_time_ms=1_700_000_060_000)

    assert payload["retryable"] is True
    assert payload["history_incomplete"] is True
    assert payload["history_complete"] is False
    assert payload["has_more_before"] is None
    assert payload["history_terminal"] is False
    assert payload["coverage_complete"] is False

    legacy_unknown = build_contract_kline_metadata(
        [],
        end_time_ms=1_700_000_060_000,
    )
    assert legacy_unknown["retryable"] is True
    assert legacy_unknown["history_incomplete"] is True
    assert legacy_unknown["history_complete"] is False
    assert legacy_unknown["has_more_before"] is None


def test_provider_empty_history_remains_unknown_and_retryable() -> None:
    result = contract_kline_provider_result(
        [],
        end_time_ms=1_700_000_060_000,
    )

    payload = build_contract_kline_metadata(result, end_time_ms=1_700_000_060_000)

    assert payload["items"] == []
    assert payload["cache_status"] == "PROVIDER_EMPTY"
    assert payload["provider_error_code"] == "EMPTY"
    assert payload["retryable"] is True
    assert payload["history_incomplete"] is True
    assert payload["history_complete"] is False
    assert payload["has_more_before"] is None
    assert payload["history_terminal"] is False
    assert payload["terminal_reason"] is None
    assert payload["earliest_available_time"] is None
    assert payload["coverage_complete"] is False

    current_payload = build_contract_kline_metadata(
        contract_kline_provider_result([], end_time_ms=None),
        end_time_ms=None,
    )
    assert current_payload["retryable"] is True
    assert current_payload["history_incomplete"] is False
    assert current_payload["history_complete"] is None
    assert current_payload["has_more_before"] is None


def test_metadata_response_keeps_partial_history_open() -> None:
    result = ContractKlineResult(
        [_row()],
        origin="REST_FETCH",
        cache_status="SHORT",
        history_incomplete=True,
    )

    payload = serialize_contract_kline_response(
        result,
        include_metadata=True,
        end_time_ms=1_700_000_060_000,
    )

    assert isinstance(payload, dict)
    assert payload["history_incomplete"] is True
    assert payload["history_complete"] is False
    assert payload["has_more_before"] is None


def test_terminal_history_preserves_spot_aligned_evidence() -> None:
    result = ContractKlineResult(
        [],
        origin="EMPTY",
        cache_status="HISTORY_BOUNDARY",
        history_terminal=True,
        terminal_reason="PROVIDER_HISTORY_BOUNDARY",
        earliest_available_time=1_514_764_800_000,
        retryable=False,
    )

    payload = build_contract_kline_metadata(
        result,
        end_time_ms=1_514_764_800_000,
    )

    assert payload["items"] == []
    assert payload["history_terminal"] is True
    assert payload["terminal_reason"] == "PROVIDER_HISTORY_BOUNDARY"
    assert payload["earliest_available_time"] == 1_514_764_800_000
    assert payload["coverage_complete"] is True
    assert payload["history_complete"] is True
    assert payload["has_more_before"] is False
    assert payload["history_incomplete"] is False
    assert payload["provider_error_code"] is None
    assert payload["retryable"] is False
    assert ContractKlineHistoryMetadataResponse.model_validate(payload).model_dump() == payload


def test_terminal_history_does_not_require_an_unknown_earliest_time() -> None:
    result = ContractKlineResult(
        [],
        origin="EMPTY",
        cache_status="HISTORY_BOUNDARY",
        history_terminal=True,
        terminal_reason="PROVIDER_HISTORY_BOUNDARY",
        earliest_available_time=None,
        retryable=False,
    )

    payload = build_contract_kline_metadata(
        result,
        end_time_ms=1_561_910_400_000,
    )

    assert payload["history_terminal"] is True
    assert payload["terminal_reason"] == "PROVIDER_HISTORY_BOUNDARY"
    assert payload["earliest_available_time"] is None
    assert payload["coverage_complete"] is True
    assert payload["history_complete"] is True
    assert payload["has_more_before"] is False
    assert payload["history_incomplete"] is False
    assert payload["provider_error_code"] is None
    assert payload["retryable"] is False


def test_transient_timeout_cannot_publish_terminal_evidence() -> None:
    result = ContractKlineResult(
        [],
        origin="EMPTY",
        cache_status="TIMEOUT",
        history_incomplete=True,
        history_terminal=True,
        terminal_reason="PROVIDER_HISTORY_BOUNDARY",
        earliest_available_time=1_514_764_800_000,
        coverage_complete=True,
        provider_error_code="TIMEOUT",
        retryable=True,
    )

    payload = build_contract_kline_metadata(
        result,
        end_time_ms=1_700_000_060_000,
    )

    assert payload["history_terminal"] is False
    assert payload["terminal_reason"] is None
    assert payload["earliest_available_time"] is None
    assert payload["coverage_complete"] is False
    assert payload["provider_error_code"] == "TIMEOUT"
    assert payload["retryable"] is True


def test_process_cache_metadata_is_preserved_without_history_inference() -> None:
    result = contract_kline_process_cache_result([_row()])

    current_payload = build_contract_kline_metadata(result, end_time_ms=None)
    history_payload = build_contract_kline_metadata(result, end_time_ms=1_700_000_060_000)

    assert current_payload["freshness"] == "CACHED"
    assert current_payload["cache_status"] == "HIT"
    assert current_payload["history_complete"] is None
    assert current_payload["has_more_before"] is None
    assert history_payload["history_complete"] is False
    assert history_payload["has_more_before"] is None


def test_explicit_terminal_evidence_contract_enforces_field_consistency() -> None:
    result = ContractKlineResult(
        [],
        origin="EMPTY",
        cache_status="HISTORY_BOUNDARY",
        history_incomplete=False,
        history_complete=True,
        has_more_before=False,
        retryable=False,
    )

    payload = build_contract_kline_metadata(result, end_time_ms=1_700_000_060_000)

    assert payload["history_complete"] is True
    assert payload["has_more_before"] is False
    assert payload["history_incomplete"] is False
    assert payload["retryable"] is False
    assert payload["history_terminal"] is False
    assert payload["coverage_complete"] is True

    known_more = ContractKlineResult(
        [_row()],
        origin="DB_CACHE",
        cache_status="HISTORY_COVERED",
        history_complete=False,
        has_more_before=True,
    )
    known_more_payload = build_contract_kline_metadata(
        known_more,
        end_time_ms=1_700_000_060_000,
    )
    assert known_more_payload["history_complete"] is False
    assert known_more_payload["has_more_before"] is True

    invalid_cases = (
        {"history_complete": True, "has_more_before": None},
        {"history_complete": True, "has_more_before": False, "history_incomplete": True},
        {"history_complete": True, "has_more_before": False, "retryable": True},
        {"history_complete": False, "has_more_before": False},
    )
    for overrides in invalid_cases:
        params = {
            "origin": "EMPTY",
            "cache_status": "HISTORY_BOUNDARY",
            "history_incomplete": False,
            "history_complete": None,
            "has_more_before": None,
            "retryable": False,
            **overrides,
        }
        try:
            ContractKlineResult([], **params)
        except ValueError:
            continue
        raise AssertionError(f"inconsistent terminal metadata accepted: {overrides}")


def test_router_response_serialization_accepts_legacy_array_and_metadata_object() -> None:
    result = contract_kline_provider_result([_row()])
    legacy_data = serialize_contract_kline_response(
        result,
        include_metadata=False,
        end_time_ms=None,
    )
    metadata_data = serialize_contract_kline_response(
        result,
        include_metadata=True,
        end_time_ms=None,
    )

    legacy_envelope = jsonable_encoder(ok(data=legacy_data, trace_id="legacy-trace"))
    metadata_envelope = jsonable_encoder(ok(data=metadata_data, trace_id="metadata-trace"))

    assert type(legacy_envelope["data"]) is list
    assert legacy_envelope["data"] == [_row()]
    assert isinstance(metadata_envelope["data"], dict)
    assert metadata_envelope["data"] == metadata_data


def test_router_has_no_fixed_array_response_model_or_inferred_return_type() -> None:
    router_path = ROOT / "backend" / "app" / "routers" / "contract_market.py"
    tree = ast.parse(router_path.read_text(encoding="utf-8"))
    endpoint = next(
        node
        for node in tree.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        and node.name == "contract_market_kline"
    )

    assert endpoint.returns is None
    for decorator in endpoint.decorator_list:
        if not isinstance(decorator, ast.Call):
            continue
        assert all(keyword.arg != "response_model" for keyword in decorator.keywords)


if __name__ == "__main__":
    tests = [
        test_default_contract_kline_response_remains_legacy_array,
        test_metadata_response_for_normal_provider_data,
        test_metadata_response_preserves_db_cache_hit,
        test_metadata_response_preserves_stale_fallback,
        test_metadata_response_marks_transient_provider_error_retryable,
        test_transient_error_factory_classifies_all_retryable_error_families,
        test_metadata_response_does_not_treat_unavailable_empty_code_as_terminal,
        test_provider_empty_history_remains_unknown_and_retryable,
        test_metadata_response_keeps_partial_history_open,
        test_terminal_history_preserves_spot_aligned_evidence,
        test_terminal_history_does_not_require_an_unknown_earliest_time,
        test_transient_timeout_cannot_publish_terminal_evidence,
        test_process_cache_metadata_is_preserved_without_history_inference,
        test_explicit_terminal_evidence_contract_enforces_field_consistency,
        test_router_response_serialization_accepts_legacy_array_and_metadata_object,
        test_router_has_no_fixed_array_response_model_or_inferred_return_type,
    ]
    for test in tests:
        test()
    print(f"{len(tests)} tests passed")
