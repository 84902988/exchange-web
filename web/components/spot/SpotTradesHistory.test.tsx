import { describe, expect, it, jest } from '@jest/globals'
import { render, screen } from '@testing-library/react'
import type { SpotMarketTradeItem } from '@/lib/api/modules/spot'
import SpotTradesHistory from './SpotTradesHistory'

jest.mock('@/contexts/LocaleContext', () => ({
  useLocaleContext: () => ({
    t: (key: string) => key,
  }),
}))

describe('SpotTradesHistory', () => {
  it('omits the redundant internal title row and shows up to 24 recent trades by default', () => {
    const trades = Array.from({ length: 26 }, (_, index): SpotMarketTradeItem => ({
      price: String(100 + index),
      amount: '1',
      side: 'BUY',
      provider_trade_id: `trade-${index}`,
      event_time_ms: 1_720_000_000_000 - index * 1_000,
    }))

    render(
      <SpotTradesHistory
        symbol="BTCUSDT"
        displaySymbol="BTC/USDT"
        pricePrecision={2}
        trades={trades}
      />,
    )

    expect(screen.queryByText('spotMarketTrades')).not.toBeInTheDocument()
    expect(screen.queryByText('BTC/USDT')).not.toBeInTheDocument()
    expect(screen.getAllByTestId(/spot-recent-trade-/)).toHaveLength(24)
    expect(screen.getByTestId('spot-recent-trade-first').parentElement).toHaveClass(
      'grid',
      'auto-rows-[minmax(24px,1fr)]',
    )
  })

  it('renders colliding weak rows with unique keys and never displays compatibility ts as event time', () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    const weak: SpotMarketTradeItem = {
      price: '100',
      amount: '1',
      side: 'BUY',
      provider: 'OKX_SPOT',
      provider_symbol: 'BTC-USDT',
      event_time_ms: null,
      received_at_ms: 1_720_000_000_500,
      ts: 1_720_000_999_999,
    }

    render(
      <SpotTradesHistory
        symbol="BTCUSDT"
        pricePrecision={2}
        trades={[weak, { ...weak }]}
        tradesSource="LIVE_WS"
        tradesFreshness="LIVE"
      />,
    )

    expect(screen.getAllByText('--:--:--')).toHaveLength(2)
    expect(consoleError.mock.calls.some((call) => String(call[0]).includes('same key'))).toBe(false)
    consoleError.mockRestore()
  })
})
