import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ApiError } from '@/lib/api/core/error'
import {
  getSpotCurrentOrders,
  getSpotMyTrades,
  type SpotOrderItem,
  type SpotTradeItem,
} from '@/lib/api/modules/spot'
import SpotOrderTabs from './SpotOrderTabs'

let mockAuthState = {
  user: { id: 7 },
  isLoggedIn: true,
}

jest.mock('@/lib/authContext', () => ({
  useAuth: () => mockAuthState,
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
  static instances: MockWebSocket[] = []

  readonly url: string
  readonly protocols?: string | string[]

  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null

  constructor(url = '', protocols?: string | string[]) {
    this.url = url
    this.protocols = protocols
    MockWebSocket.instances.push(this)
  }

  send() {}

  close() {}
}

const currentOrdersMock = jest.mocked(getSpotCurrentOrders)
const myTradesMock = jest.mocked(getSpotMyTrades)

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

function buildTradeResponse(symbol: string, items: SpotTradeItem[] = []) {
  return {
    symbol,
    total: items.length,
    items,
  }
}

function buildTrade(
  symbol: string,
  feeAmount: string,
  side: 'BUY' | 'SELL',
  userId: number,
): SpotTradeItem {
  return {
    trade_id: 141197,
    symbol,
    side,
    price: '0.109',
    amount: '30',
    quote_amount: '3.27',
    buyer_user_id: side === 'BUY' ? userId : 99,
    seller_user_id: side === 'SELL' ? userId : 99,
    buy_order_id: 141247,
    sell_order_id: 141246,
    maker_order_id: 141246,
    taker_order_id: 141247,
    role: side === 'SELL' ? 'MAKER' : 'TAKER',
    fee_amount: feeAmount,
    fee_asset_symbol: 'USDT',
    created_at: '2026-07-20T20:42:10Z',
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
    mockAuthState = {
      user: { id: 7 },
      isLoggedIn: true,
    }
    MockWebSocket.instances = []
    Object.defineProperty(window, 'WebSocket', {
      configurable: true,
      writable: true,
      value: MockWebSocket,
    })
  })

  afterEach(() => {
    cleanup()
    window.localStorage.clear()
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

  it('isolates trade fee rows and late responses when the authenticated account changes', async () => {
    let resolveOldAccountTrades: ((value: ReturnType<typeof buildTradeResponse>) => void) | null = null
    currentOrdersMock.mockResolvedValue(buildResponse('MFCUSDT'))
    myTradesMock
      .mockImplementationOnce(
        () => new Promise((resolve) => {
          resolveOldAccountTrades = resolve
        }),
      )
      .mockResolvedValueOnce(
        buildTradeResponse('MFCUSDT', [buildTrade('MFCUSDT', '0.001308', 'SELL', 8)]),
      )

    const view = render(<SpotOrderTabs symbol="MFCUSDT" pricePrecision={3} />)
    await flushAsyncWork()

    fireEvent.click(screen.getByText('myTrades'))
    await act(async () => {
      jest.advanceTimersByTime(0)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(myTradesMock).toHaveBeenCalledTimes(1)

    mockAuthState = {
      user: { id: 8 },
      isLoggedIn: true,
    }
    view.rerender(<SpotOrderTabs symbol="MFCUSDT" pricePrecision={3} />)
    await act(async () => {
      jest.advanceTimersByTime(0)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(myTradesMock).toHaveBeenCalledTimes(2)
    expect(screen.getByText('0.001308 USDT')).toBeTruthy()
    expect(screen.queryByText('0.01308 USDT')).toBeNull()

    await act(async () => {
      resolveOldAccountTrades?.(
        buildTradeResponse('MFCUSDT', [buildTrade('MFCUSDT', '0.01308', 'BUY', 7)]),
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(screen.getByText('0.001308 USDT')).toBeTruthy()
    expect(screen.queryByText('0.01308 USDT')).toBeNull()
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

  it('does not resurrect a filled order when an older REST request finishes after the private update', async () => {
    let resolveCurrentOrders: ((value: ReturnType<typeof buildResponse>) => void) | null = null
    currentOrdersMock.mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveCurrentOrders = resolve
      }),
    )

    render(<SpotOrderTabs symbol="MFCUSDT" pricePrecision={3} />)
    await flushAsyncWork()
    expect(currentOrdersMock).toHaveBeenCalledTimes(1)
    expect(resolveCurrentOrders).not.toBeNull()

    await act(async () => {
      jest.advanceTimersByTime(100)
      await Promise.resolve()
    })

    const ws = MockWebSocket.instances.at(-1)
    expect(ws).toBeDefined()

    const filledOrder = {
      ...buildOrder('MFCUSDT', 9),
      price: '0.112',
      filled_amount: '2',
      remaining_amount: '0',
      status: 'FILLED',
      updated_at: '2026-07-13T00:00:01Z',
    }

    act(() => {
      ws?.onmessage?.({
        data: JSON.stringify({
          type: 'spot_user_order_update',
          symbol: 'MFCUSDT',
          order: filledOrder,
        }),
      } as MessageEvent)
    })

    await act(async () => {
      resolveCurrentOrders?.(
        buildResponse('MFCUSDT', [{
          ...buildOrder('MFCUSDT', 9),
          price: '0.112',
        }]),
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(screen.queryByText('0.112')).not.toBeInTheDocument()
  })

  it('debounces balance bursts and coalesces revalidation behind an in-flight request', async () => {
    let resolveInitialRequest: ((value: ReturnType<typeof buildResponse>) => void) | null = null
    currentOrdersMock
      .mockImplementationOnce(
        () => new Promise((resolve) => {
          resolveInitialRequest = resolve
        }),
      )
      .mockResolvedValueOnce(buildResponse('MFCUSDT'))

    render(<SpotOrderTabs symbol="MFCUSDT" pricePrecision={3} />)
    await flushAsyncWork()

    await act(async () => {
      jest.advanceTimersByTime(100)
      await Promise.resolve()
    })
    const ws = MockWebSocket.instances.at(-1)
    expect(ws).toBeDefined()

    act(() => {
      const balanceUpdate = {
        data: JSON.stringify({
          type: 'spot_user_balance_update',
          account_type: 'spot',
          items: [{ symbol: 'MFC', available: '10', frozen: '0' }],
        }),
      } as MessageEvent
      ws?.onmessage?.(balanceUpdate)
      ws?.onmessage?.(balanceUpdate)
    })
    expect(currentOrdersMock).toHaveBeenCalledTimes(1)

    await act(async () => {
      jest.advanceTimersByTime(149)
      await Promise.resolve()
    })
    expect(currentOrdersMock).toHaveBeenCalledTimes(1)

    await act(async () => {
      jest.advanceTimersByTime(1)
      await Promise.resolve()
    })
    expect(currentOrdersMock).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveInitialRequest?.(
        buildResponse('MFCUSDT', [{
          ...buildOrder('MFCUSDT', 10),
          price: '0.112',
        }]),
      )
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(currentOrdersMock).toHaveBeenCalledTimes(2)
    expect(screen.queryByText('0.112')).not.toBeInTheDocument()
  })

  it('reconnects after an auth close and reads the refreshed token', async () => {
    window.localStorage.setItem('access_token', 'expired-token')
    currentOrdersMock.mockResolvedValue(buildResponse('MFCUSDT'))

    render(<SpotOrderTabs symbol="MFCUSDT" />)
    await flushAsyncWork()
    await act(async () => {
      jest.advanceTimersByTime(100)
      await Promise.resolve()
    })

    const firstSocket = MockWebSocket.instances.at(-1)
    expect(firstSocket?.url).toBe('ws://127.0.0.1:8000/spot/ws/private?symbol=MFCUSDT')
    expect(firstSocket?.protocols).toEqual(['spot-auth', 'expired-token'])

    window.localStorage.setItem('access_token', 'refreshed-token')
    act(() => {
      firstSocket?.onclose?.({ code: 1008 } as CloseEvent)
    })

    await act(async () => {
      jest.advanceTimersByTime(1500)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(MockWebSocket.instances).toHaveLength(2)
    expect(MockWebSocket.instances[1]?.protocols).toEqual([
      'spot-auth',
      'refreshed-token',
    ])
  })

  it('recovers auth once when a rejected handshake is reported as a pre-open abnormal close', async () => {
    window.localStorage.setItem('access_token', 'expired-token')
    currentOrdersMock
      .mockResolvedValueOnce(buildResponse('MFCUSDT'))
      .mockImplementationOnce(async () => {
        window.localStorage.setItem('access_token', 'refreshed-token')
        return buildResponse('MFCUSDT')
      })

    render(<SpotOrderTabs symbol="MFCUSDT" />)
    await flushAsyncWork()
    await act(async () => {
      jest.advanceTimersByTime(100)
      await Promise.resolve()
    })

    const firstSocket = MockWebSocket.instances.at(-1)
    act(() => {
      firstSocket?.onclose?.({ code: 1006 } as CloseEvent)
    })
    await flushAsyncWork()
    expect(currentOrdersMock).toHaveBeenCalledTimes(2)

    await act(async () => {
      jest.advanceTimersByTime(1500)
      await Promise.resolve()
    })

    const secondSocket = MockWebSocket.instances.at(-1)
    expect(secondSocket?.protocols).toEqual(['spot-auth', 'refreshed-token'])

    act(() => {
      secondSocket?.onclose?.({ code: 1006 } as CloseEvent)
    })
    await flushAsyncWork()
    expect(currentOrdersMock).toHaveBeenCalledTimes(2)
  })
})
