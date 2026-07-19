import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals'
import { act, cleanup, render, screen } from '@testing-library/react'
import { ApiError } from '@/lib/api/core/error'
import {
  getSpotCurrentOrders,
  type SpotOrderItem,
} from '@/lib/api/modules/spot'
import SpotOrderTabs from './SpotOrderTabs'

jest.mock('@/lib/authContext', () => ({
  useAuth: () => ({
    user: { id: 7 },
    isLoggedIn: true,
  }),
}), { virtual: true })

jest.mock('@/contexts/LocaleContext', () => ({
  useLocaleContext: () => ({
    t: (key: string) => key,
  }),
}), { virtual: true })

jest.mock('@/lib/api/core/baseUrl', () => ({
  getRuntimeApiBaseUrl: () => 'http://127.0.0.1:8000',
}), { virtual: true })

jest.mock('@/lib/api/core/error', () => ({
  ApiError: class ApiError extends Error {
    code: string
    trace_id: string

    constructor(message: string, code: string, traceId: string) {
      super(message)
      this.name = 'ApiError'
      this.code = code
      this.trace_id = traceId
    }
  },
}), { virtual: true })

jest.mock('@/lib/api/modules/spot', () => ({
  cancelSpotOrder: jest.fn(),
  getSpotCurrentOrders: jest.fn(),
  getSpotHistoryOrders: jest.fn(),
  getSpotMyTrades: jest.fn(),
}), { virtual: true })

class MockWebSocket {
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null

  send() {}

  close() {}
}

const currentOrdersMock = jest.mocked(getSpotCurrentOrders)

function buildOrder(symbol: string, id = 1): SpotOrderItem {
  return {
    id,
    symbol,
    side: 'BUY',
    order_type: 'LIMIT',
    price: '100',
    amount: '2',
    filled_amount: '0',
    remaining_amount: '2',
    executed_quote_amount: '0',
    avg_price: '0',
    status: 'OPEN',
    created_at: '2026-07-13T00:00:00Z',
    updated_at: '2026-07-13T00:00:00Z',
  }
}

function buildResponse(symbol: string, items: SpotOrderItem[] = []) {
  return {
    symbol,
    total: items.length,
    items,
  }
}

async function flushAsyncWork() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function advanceRetryTimer() {
  await act(async () => {
    jest.advanceTimersByTime(1600)
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('SpotOrderTabs current orders recovery', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    jest.clearAllMocks()
    Object.defineProperty(window, 'WebSocket', {
      configurable: true,
      writable: true,
      value: MockWebSocket,
    })
  })

  afterEach(() => {
    cleanup()
    jest.clearAllTimers()
    jest.useRealTimers()
    jest.restoreAllMocks()
  })

  it('loads current orders successfully and releases loading state', async () => {
    const onLoadingChange = jest.fn()
    currentOrdersMock.mockResolvedValue(
      buildResponse('BTCUSDT', [buildOrder('BTCUSDT')]),
    )

    render(
      <SpotOrderTabs
        symbol="BTCUSDT"
        onLoadingChange={onLoadingChange}
      />,
    )
    await flushAsyncWork()

    expect(currentOrdersMock).toHaveBeenCalledTimes(1)
    expect(screen.getByText('100.00')).toBeInTheDocument()
    expect(onLoadingChange.mock.calls.some(([loading]) => loading === true)).toBe(true)
    expect(onLoadingChange).toHaveBeenLastCalledWith(false)
  })

  it('renders order prices with the active market precision', async () => {
    currentOrdersMock.mockResolvedValue(
      buildResponse('MFCUSDT', [{
        ...buildOrder('MFCUSDT'),
        price: '0.012',
      }]),
    )

    render(<SpotOrderTabs symbol="MFCUSDT" pricePrecision={3} />)
    await flushAsyncWork()

    expect(screen.getByText('0.012')).toBeInTheDocument()
    expect(screen.queryByText('0.01')).not.toBeInTheDocument()
  })

  it('retries a NETWORK_ERROR once without console.error and succeeds', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    currentOrdersMock
      .mockRejectedValueOnce(new ApiError('Failed to fetch', 'NETWORK_ERROR', 'network-1'))
      .mockResolvedValueOnce(
        buildResponse('BTCUSDT', [buildOrder('BTCUSDT', 2)]),
      )

    render(<SpotOrderTabs symbol="BTCUSDT" />)
    await flushAsyncWork()

    expect(currentOrdersMock).toHaveBeenCalledTimes(1)
    expect(consoleError).not.toHaveBeenCalled()

    await advanceRetryTimer()

    expect(currentOrdersMock).toHaveBeenCalledTimes(2)
    expect(screen.getByText('100.00')).toBeInTheDocument()
    expect(consoleError).not.toHaveBeenCalled()
  })

  it('does not retry a NETWORK_ERROR more than once and still releases loading', async () => {
    const onLoadingChange = jest.fn()
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    currentOrdersMock.mockRejectedValue(
      new ApiError('Failed to fetch', 'NETWORK_ERROR', 'network-2'),
    )

    render(
      <SpotOrderTabs
        symbol="BTCUSDT"
        onLoadingChange={onLoadingChange}
      />,
    )
    await flushAsyncWork()
    await advanceRetryTimer()
    await advanceRetryTimer()

    expect(currentOrdersMock).toHaveBeenCalledTimes(2)
    expect(consoleError).not.toHaveBeenCalled()
    expect(onLoadingChange).toHaveBeenLastCalledWith(false)
  })

  it('cancels a pending retry when the symbol changes', async () => {
    currentOrdersMock.mockImplementation(async (symbol) => {
      if (symbol === 'BTCUSDT') {
        throw new ApiError('Failed to fetch', 'NETWORK_ERROR', 'network-3')
      }
      return buildResponse('ETHUSDT', [buildOrder('ETHUSDT', 3)])
    })

    const view = render(<SpotOrderTabs symbol="BTCUSDT" />)
    await flushAsyncWork()
    expect(currentOrdersMock).toHaveBeenCalledTimes(1)

    view.rerender(<SpotOrderTabs symbol="ETHUSDT" />)
    await flushAsyncWork()
    await advanceRetryTimer()

    expect(currentOrdersMock).toHaveBeenCalledTimes(2)
    expect(currentOrdersMock.mock.calls.map(([symbol]) => symbol)).toEqual([
      'BTCUSDT',
      'ETHUSDT',
    ])
  })

  it('cancels a pending retry when the component unmounts', async () => {
    currentOrdersMock.mockRejectedValue(
      new ApiError('Failed to fetch', 'NETWORK_ERROR', 'network-unmount'),
    )

    const view = render(<SpotOrderTabs symbol="BTCUSDT" />)
    await flushAsyncWork()
    expect(currentOrdersMock).toHaveBeenCalledTimes(1)

    view.unmount()
    await advanceRetryTimer()

    expect(currentOrdersMock).toHaveBeenCalledTimes(1)
  })

  it('keeps existing orders while a recoverable refresh is waiting to retry', async () => {
    currentOrdersMock.mockResolvedValueOnce(
      buildResponse('BTCUSDT', [buildOrder('BTCUSDT', 4)]),
    )

    const view = render(<SpotOrderTabs symbol="BTCUSDT" refreshKey={0} />)
    await flushAsyncWork()
    expect(screen.getByText('100.00')).toBeInTheDocument()

    currentOrdersMock.mockRejectedValue(
      new ApiError('Failed to fetch', 'NETWORK_ERROR', 'network-4'),
    )
    view.rerender(<SpotOrderTabs symbol="BTCUSDT" refreshKey={1} />)
    await flushAsyncWork()

    expect(screen.getByText('100.00')).toBeInTheDocument()
  })

  it('keeps non-network failures on the existing error path', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    const error = new ApiError('Forbidden', 'HTTP_ERROR', 'http-1')
    currentOrdersMock.mockRejectedValue(error)

    render(<SpotOrderTabs symbol="BTCUSDT" />)
    await flushAsyncWork()

    expect(currentOrdersMock).toHaveBeenCalledTimes(1)
    expect(consoleError).toHaveBeenCalledWith(
      'SpotOrderTabs current orders load error:',
      error,
    )
  })
})
