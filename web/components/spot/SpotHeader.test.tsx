import { describe, expect, it, jest } from '@jest/globals';
import { render, screen } from '@testing-library/react';
import SpotHeader from './SpotHeader';

const translations: Record<string, string> = {
  spotHeaderTradeStatus: '交易状态',
  spotHeaderHigh24h: '24h最高',
  spotHeaderLow24h: '24h最低',
  spotHeaderVolume24h: '24h成交量',
  spotHeaderTurnover24h: '24h成交额',
  spotMarketStatusLive: '实时行情',
  spotMarketStatusLiveCompact: '实时',
  spotMarketStatusDelayed: '延迟行情',
  spotMarketStatusDelayedCompact: '延迟',
  spotMarketStatusUnavailable: '暂不可用',
  spotMarketStatusUnavailableCompact: '不可用',
  'market.session.open': '交易中',
};

jest.mock('@/contexts/LocaleContext', () => ({
  useLocaleContext: () => ({
    t: (key: string) => translations[key] || key,
  }),
}), { virtual: true });

const baseProps = {
  symbol: 'BTCUSDT',
  price: '64,000.0',
  change: '+1.00%',
  changeAmount: '+640.0',
  highLow: '65,000 / 63,000',
  volume: '100 BTC',
  turnover: '6.4M USDT',
  marketStatus: 'OPEN',
};

describe('SpotHeader market and trading status', () => {
  it.each([
    ['LIVE_WS', 'LIVE', '实时', 'bg-[#00c087]'],
    ['STALE', 'STALE', '延迟', 'bg-[#f0b90b]'],
    ['MISSING', 'MISSING', '不可用', 'bg-[#f6465d]'],
  ])('colors only the %s market dot', (tickerSource, tickerFreshness, marketLabel, dotClass) => {
    render(
      <SpotHeader
        {...baseProps}
        tickerSource={tickerSource}
        tickerFreshness={tickerFreshness}
      />,
    );

    const status = screen.getByTestId('spot-header-market-trading-status');
    const dot = screen.getByTestId('spot-header-market-status-dot');

    expect(status).toHaveTextContent(`${marketLabel}·交易中`);
    expect(status).toHaveClass('text-[13px]', 'font-medium', 'text-white/78');
    expect(dot).toHaveClass(dotClass);
    expect(screen.getByText('·')).toHaveClass('text-white/36');
    expect(screen.getByText(marketLabel)).not.toHaveClass(
      'text-[#00c087]',
      'text-[#f0b90b]',
      'text-[#f6465d]',
    );
    expect(screen.getByText('交易中')).not.toHaveClass(
      'text-[#00c087]',
      'text-[#f0b90b]',
      'text-[#f6465d]',
    );
  });
});
