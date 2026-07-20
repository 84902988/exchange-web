from app.services import spot_market_provider_ws as provider_ws


def test_spot_bitget_all_domains_share_one_transport(monkeypatch):
    service = provider_ws.SpotMarketProviderWsService()
    acquired = []
    monkeypatch.setattr(
        service._bitget_transport,
        "acquire",
        lambda subscription, consumer_id, handler: acquired.append((subscription, consumer_id, handler)),
    )

    for symbol in ("BTCUSDT", "ETHUSDT", "SOLUSDT"):
        service.ensure_symbol(symbol, provider=provider_ws.PROVIDER_BITGET_SPOT)
        service.ensure_kline(symbol, "1m", provider=provider_ws.PROVIDER_BITGET_SPOT)

    assert len(acquired) == 12
    assert len(service._bitget_registrations) == 12
    assert service._depth_tasks == {}
    assert service._ticker_tasks == {}
    assert service._trades_tasks == {}
    assert service._kline_tasks == {}


def test_spot_bitget_release_removes_every_symbol_route(monkeypatch):
    service = provider_ws.SpotMarketProviderWsService()
    monkeypatch.setattr(service._bitget_transport, "acquire", lambda *_args: None)
    released = []
    monkeypatch.setattr(
        service._bitget_transport,
        "release",
        lambda subscription, consumer_id: released.append((subscription, consumer_id)),
    )

    service.ensure_symbol("BTCUSDT", provider=provider_ws.PROVIDER_BITGET_SPOT)
    service.ensure_kline("BTCUSDT", "1m", provider=provider_ws.PROVIDER_BITGET_SPOT)
    service.release_symbol("BTCUSDT", provider=provider_ws.PROVIDER_BITGET_SPOT)

    assert len(released) == 4
    assert service._bitget_registrations == {}


def test_spot_stop_all_releases_both_shared_providers(monkeypatch):
    service = provider_ws.SpotMarketProviderWsService()
    monkeypatch.setattr(service._okx_transport, "acquire", lambda *_args: None)
    monkeypatch.setattr(service._bitget_transport, "acquire", lambda *_args: None)
    okx_released = []
    bitget_released = []
    monkeypatch.setattr(service._okx_transport, "release", lambda *args: okx_released.append(args))
    monkeypatch.setattr(service._bitget_transport, "release", lambda *args: bitget_released.append(args))
    monkeypatch.setattr(service._okx_transport, "stop_all", lambda: None)
    monkeypatch.setattr(service._bitget_transport, "stop_all", lambda: None)

    service.ensure_symbol("BTCUSDT", provider=provider_ws.PROVIDER_OKX_SPOT)
    service.ensure_symbol("ETHUSDT", provider=provider_ws.PROVIDER_BITGET_SPOT)
    service.stop_all()

    assert len(okx_released) == 3
    assert len(bitget_released) == 3
    assert service._okx_registrations == {}
    assert service._bitget_registrations == {}
