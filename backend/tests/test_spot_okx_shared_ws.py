from app.services import spot_market_provider_ws as provider_ws


def test_spot_okx_domains_use_two_shared_endpoints(monkeypatch):
    service = provider_ws.SpotMarketProviderWsService()
    acquired = []
    monkeypatch.setattr(
        service._okx_transport,
        "acquire",
        lambda subscription, consumer_id, handler: acquired.append((subscription, consumer_id, handler)),
    )

    service.ensure_symbol("BTCUSDT", provider=provider_ws.PROVIDER_OKX_SPOT)
    service.ensure_symbol("ETHUSDT", provider=provider_ws.PROVIDER_OKX_SPOT)
    service.ensure_kline("BTCUSDT", "1m", provider=provider_ws.PROVIDER_OKX_SPOT)
    service.ensure_kline("ETHUSDT", "5m", provider=provider_ws.PROVIDER_OKX_SPOT)

    assert len(acquired) == 8
    assert [item[0].endpoint for item in acquired].count("public") == 6
    assert [item[0].endpoint for item in acquired].count("business") == 2
    assert service._depth_tasks == {}
    assert service._ticker_tasks == {}
    assert service._trades_tasks == {}
    assert service._kline_tasks == {}


def test_spot_okx_release_removes_all_symbol_routes(monkeypatch):
    service = provider_ws.SpotMarketProviderWsService()
    monkeypatch.setattr(service._okx_transport, "acquire", lambda *_args: None)
    released = []
    monkeypatch.setattr(
        service._okx_transport,
        "release",
        lambda subscription, consumer_id: released.append((subscription, consumer_id)),
    )

    service.ensure_symbol("BTCUSDT", provider=provider_ws.PROVIDER_OKX_SPOT)
    service.ensure_kline("BTCUSDT", "1m", provider=provider_ws.PROVIDER_OKX_SPOT)
    service.release_symbol("BTCUSDT", provider=provider_ws.PROVIDER_OKX_SPOT)

    assert len(released) == 4
    assert service._okx_registrations == {}
