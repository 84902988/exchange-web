import pytest
from app.services.asset_valuation_rate import normalize_usdt_usd_quote


def test_uses_latest_price_not_previous_close():
    result = normalize_usdt_usd_quote({'code': 0, 'data': {'s': 'USDTUSD', 'ld': 0.99982, 'p': 1.001, 't': 1_800_000_000_000}}, now=1_800_000_004)
    assert result['rate'] == 0.99982
    assert result['stale'] is False
    assert result['quote'] == 'USD'


@pytest.mark.parametrize('patch', [{'s': 'USDCUSDT'}, {'ld': 0}, {'ld': -1}, {'ld': 'nan'}, {'ld': True}, {'t': 1}, {'t': 1_800_000_200_000}])
def test_invalid_or_stale_rate_is_unavailable(patch):
    row = {'s': 'USDTUSD', 'ld': 0.99982, 't': 1_800_000_000_000, **patch}
    result = normalize_usdt_usd_quote({'data': row}, now=1_800_000_004)
    assert result['rate'] is None
    assert result['stale'] is True


def test_rate_cache_and_upstream_failure(monkeypatch):
    import app.services.asset_valuation_rate as service
    from unittest.mock import Mock
    monkeypatch.setattr(service, '_cached', None)
    monkeypatch.setattr(service.time, 'time', lambda: 1_800_000_004)
    quote = Mock(return_value={'data': {'s': 'USDTUSD', 'ld': .99982, 't': 1_800_000_000_000}})
    monkeypatch.setattr(service.itick_market_service, 'get_market_quote', quote)
    assert service.get_usdt_usd_valuation_rate()['rate'] == .99982
    assert service.get_usdt_usd_valuation_rate()['rate'] == .99982
    assert quote.call_count == 1
    monkeypatch.setattr(service.time, 'time', lambda: 1_800_000_200)
    quote.side_effect = RuntimeError('unavailable')
    assert service.get_usdt_usd_valuation_rate()['rate'] is None
