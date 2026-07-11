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
