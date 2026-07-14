from app.services.itick_market_service import ItickMarketService


def _kline_payload(open_time: int = 1_700_000_000_000):
    return {
        "data": [
            [str(open_time), "100", "110", "90", "105", "5"]
        ]
    }


def test_stock_kline_uses_et_cursor_and_caches_non_empty_success(monkeypatch):
    service = ItickMarketService()
    calls = []

    def request(path, params, **kwargs):
        calls.append((path, dict(params), dict(kwargs)))
        return _kline_payload()

    monkeypatch.setattr(service, "_request_json", request)

    first = service.get_stock_kline("US", "AAPL", 8, 300, end_time_ms=1_700_100_000_000)
    second = service.get_stock_kline("US", "AAPL", 8, 300, end_time_ms=1_700_100_000_000)

    assert first == second
    assert len(calls) == 1
    assert calls[0][0] == "/kline"
    assert calls[0][1] == {
        "region": "US",
        "code": "AAPL",
        "kType": 8,
        "limit": 300,
        "et": 1_700_099_999_999,
    }
    assert "endTime" not in calls[0][1]


def test_stock_kline_empty_response_is_not_cached(monkeypatch):
    service = ItickMarketService()
    calls = []

    def request(*_args, **_kwargs):
        calls.append(1)
        return {"data": []}

    monkeypatch.setattr(service, "_request_json", request)

    assert service.get_stock_kline("US", "AAPL", 8, 100) == {"data": []}
    assert service.get_stock_kline("US", "AAPL", 8, 100) == {"data": []}
    assert len(calls) == 2
    assert service._stock_kline_cache == {}


def test_stock_kline_timeout_is_not_cached(monkeypatch):
    service = ItickMarketService()
    calls = []
    cache_key = "stock:kline:US:AAPL:8:100:latest"
    service._stock_kline_cache[cache_key] = {
        "ts": 0,
        "payload": _kline_payload(),
    }

    def request(*_args, **_kwargs):
        calls.append(1)
        raise TimeoutError("provider timeout")

    monkeypatch.setattr(service, "_request_json", request)

    for _ in range(2):
        try:
            service.get_stock_kline("US", "AAPL", 8, 100)
        except TimeoutError:
            pass
        else:
            raise AssertionError("provider timeout must propagate")

    assert len(calls) == 2
    assert service._stock_kline_cache == {}


def test_forex_kline_uses_market_endpoint_and_et_cursor(monkeypatch):
    service = ItickMarketService()
    captured = {}

    monkeypatch.setattr(
        service,
        "_get_market_base_url",
        lambda market: f"https://api0.itick.org/{market}",
    )

    def request(path, params, **kwargs):
        captured.update(path=path, params=dict(params), kwargs=dict(kwargs))
        return _kline_payload()

    monkeypatch.setattr(service, "_request_json", request)

    service.get_market_kline(
        "forex",
        "GB",
        "EURUSD",
        9,
        300,
        end_time_ms=1_700_100_000_000,
        timeout=4,
    )

    assert captured["path"] == "/kline"
    assert captured["params"] == {
        "region": "GB",
        "code": "EURUSD",
        "kType": 9,
        "limit": 300,
        "et": 1_700_099_999_999,
    }
    assert captured["kwargs"] == {
        "base_url": "https://api0.itick.org/forex",
        "timeout": 4,
    }
