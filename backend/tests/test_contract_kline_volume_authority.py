from app.services import contract_market_service
from app.services import contract_market_gateway
from app.services.contract_market_provider_ws import (
    PROVIDER_ITICK,
    PROVIDER_OKX_SWAP,
    ContractMarketProviderWsService,
    ProviderKlineSubscription,
)


def _subscription(provider: str) -> ProviderKlineSubscription:
    return ProviderKlineSubscription(
        local_symbol="BTCUSDT_PERP",
        provider=provider,
        provider_symbol="BTC-USDT-SWAP" if provider == PROVIDER_OKX_SWAP else "BTCUSDT",
        interval="1m",
        channel="candle1m",
    )


def test_history_adapter_requires_real_volume_but_preserves_explicit_zero():
    payload = {
        "data": [
            [1_717_000_000_000, "100", "110", "90", "105"],
            [1_717_000_060_000, "105", "112", "104", "111", None],
            [1_717_000_120_000, "111", "113", "108", "109", "-1"],
            [1_717_000_180_000, "109", "114", "107", "113", "0"],
            [1_717_000_240_000, "113", "115", "110", "112", "8.5"],
        ]
    }

    rows = contract_market_service._extract_itick_kline_rows(payload)

    assert [row["volume"] for row in rows] == ["0", "8.5"]


def test_configured_history_adapter_requires_real_volume():
    rows = contract_market_service._normalize_provider_kline_rows("BINANCE_USDM", [
        [1_717_000_000_000, "100", "110", "90", "105"],
        [1_717_000_060_000, "105", "112", "104", "111", None],
        [1_717_000_120_000, "111", "113", "108", "109", "0"],
    ])

    assert [row["volume"] for row in rows] == ["0"]


def test_history_authority_filter_rejects_incomplete_ohlcv_rows():
    base = {
        "open_time": 1_717_000_000_000,
        "open": "100",
        "high": "110",
        "low": "90",
        "close": "105",
        "volume": "5",
        "source": "PROVIDER_KLINE",
    }
    rows = contract_market_service._provider_contract_kline_rows([
        base,
        {**base, "open_time": 1_717_000_060_000, "volume": None},
        {**base, "open_time": 1_717_000_120_000, "close": "bad"},
    ])

    assert list(rows) == [base]


def test_realtime_provider_adapters_require_volume_without_fabricating_zero():
    service = object.__new__(ContractMarketProviderWsService)
    okx = _subscription(PROVIDER_OKX_SWAP)
    itick = _subscription(PROVIDER_ITICK)

    assert service._normalize_okx_kline(
        okx,
        ["1717000000000", "100", "110", "90", "105", None],
    ) is None
    assert service._normalize_okx_kline(
        okx,
        ["1717000000000", "100", "110", "90", "105", "0"],
    )["volume"] == "0"

    assert service._normalize_itick_kline(itick, {
        "type": "kline@1",
        "t": 1_717_000_000_000,
        "o": "100",
        "h": "110",
        "l": "90",
        "c": "105",
    }) is None
    assert service._normalize_itick_kline(itick, {
        "type": "kline@1",
        "t": 1_717_000_000_000,
        "o": "100",
        "h": "110",
        "l": "90",
        "c": "105",
        "v": "0",
    })["volume"] == "0"


def test_gateway_keeps_missing_volume_unavailable_and_preserves_explicit_zero():
    base = {
        "open_time": 1_717_000_000_000,
        "open": "100",
        "high": "110",
        "low": "90",
        "close": "105",
    }

    assert contract_market_gateway._normalize_kline(base)["volume"] is None
    assert contract_market_gateway._normalize_kline({**base, "volume": "0"})["volume"] == "0"
    assert contract_market_gateway._normalize_kline(
        {**base, "volume": "5"},
        source="LIVE_WS",
    )["source"] == "LIVE_WS"
