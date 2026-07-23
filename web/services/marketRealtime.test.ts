/* eslint-disable @typescript-eslint/no-explicit-any -- Dynamic harness exercises private dispatch without exporting it. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

function loadMarketRealtimeModule(): Record<string, any> {
  const filePath = fileURLToPath(new URL('./marketRealtime.ts', import.meta.url))
  const output = ts.transpileModule(readFileSync(filePath, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: filePath,
  }).outputText
  const loadedModule: { exports: Record<string, any> } = { exports: {} }
  const mocks: Record<string, unknown> = {
    '@/lib/api/core/baseUrl': { getRuntimeApiBaseUrl: () => 'http://127.0.0.1:8000' },
    '@/components/spot/tradingview/spotKlinePerf': { markSpotKlinePerf: () => undefined },
    '@/lib/realtime/spotMarketStore.transport': {
      attachSpotMarketStoreTransportMirror: () => undefined,
    },
  }
  const execute = new Function('require', 'module', 'exports', output)
  execute(
    (specifier: string) => mocks[specifier],
    loadedModule,
    loadedModule.exports,
  )
  return loadedModule.exports
}

function installMarketRealtimeHarness() {
  const sockets: MockWebSocket[] = []
  const timeouts = new Map<number, { callback: () => void; delay: number }>()
  const intervals = new Map<number, () => void>()
  const windowListeners = new Map<string, Set<() => void>>()
  const documentListeners = new Map<string, Set<() => void>>()
  const timeoutDelays: number[] = []
  let timerSequence = 0

  class MockWebSocket {
    static readonly CONNECTING = 0
    static readonly OPEN = 1
    static readonly CLOSING = 2
    static readonly CLOSED = 3

    readyState = MockWebSocket.CONNECTING
    sent: string[] = []
    closeCalls: Array<{ code?: number; reason?: string }> = []
    onopen: (() => void) | null = null
    onmessage: ((event: { data: string }) => void) | null = null
    onerror: (() => void) | null = null
    onclose: (() => void) | null = null
    readonly url: string

    constructor(url: string) {
      this.url = url
      sockets.push(this)
    }

    send(value: string) {
      this.sent.push(value)
    }

    close(code?: number, reason?: string) {
      this.readyState = MockWebSocket.CLOSED
      this.closeCalls.push({ code, reason })
    }
  }

  const originalWindow = globalThis.window
  const originalDocument = globalThis.document
  const originalWebSocket = globalThis.WebSocket
  const originalRandom = Math.random
  Math.random = () => 0.5
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      setTimeout(callback: () => void, delay = 0) {
        const id = ++timerSequence
        timeoutDelays.push(delay)
        timeouts.set(id, { callback, delay })
        return id
      },
      clearTimeout(id: number) {
        timeouts.delete(id)
      },
      setInterval(callback: () => void) {
        const id = ++timerSequence
        intervals.set(id, callback)
        return id
      },
      clearInterval(id: number) {
        intervals.delete(id)
      },
      addEventListener(type: string, callback: () => void) {
        const bucket = windowListeners.get(type) ?? new Set()
        bucket.add(callback)
        windowListeners.set(type, bucket)
      },
      removeEventListener(type: string, callback: () => void) {
        windowListeners.get(type)?.delete(callback)
      },
    },
  })
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      visibilityState: 'visible',
      addEventListener(type: string, callback: () => void) {
        const bucket = documentListeners.get(type) ?? new Set()
        bucket.add(callback)
        documentListeners.set(type, bucket)
      },
      removeEventListener(type: string, callback: () => void) {
        documentListeners.get(type)?.delete(callback)
      },
    },
  })
  Object.defineProperty(globalThis, 'WebSocket', {
    configurable: true,
    value: MockWebSocket,
  })

  const realtimeModule = loadMarketRealtimeModule()
  return {
    MockWebSocket,
    client: realtimeModule.spotMarketRealtime,
    sockets,
    timeoutDelays,
    runTimeouts() {
      const pending = Array.from(timeouts.entries())
      timeouts.clear()
      for (const [, timer] of pending) timer.callback()
    },
    runHeartbeat() {
      for (const callback of Array.from(intervals.values())) callback()
    },
    intervalCount() {
      return intervals.size
    },
    listenerCount() {
      return Array.from(windowListeners.values()).reduce((total, bucket) => total + bucket.size, 0)
        + Array.from(documentListeners.values()).reduce((total, bucket) => total + bucket.size, 0)
    },
    emitWindow(type: string) {
      for (const callback of windowListeners.get(type) ?? []) callback()
    },
    emitDocument(type: string) {
      for (const callback of documentListeners.get(type) ?? []) callback()
    },
    restore() {
      Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow })
      Object.defineProperty(globalThis, 'document', { configurable: true, value: originalDocument })
      Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: originalWebSocket })
      Math.random = originalRandom
    },
  }
}

test('preview messages ride only the matching active kline interval', () => {
  const { spotMarketRealtime } = loadMarketRealtimeModule()
  const messages: Array<Record<string, unknown>> = []
  const unsubscribe = spotMarketRealtime.subscribe(
    'preview',
    (message: Record<string, unknown>) => messages.push(message),
  )
  const connection = {
    symbol: 'BTCUSDT',
    domains: new Map(),
    klineIntervals: new Map([['1m', new Set(['tv-owner'])]]),
  }
  const preview = {
    type: 'spot_candle_preview_update',
    symbol: 'BTCUSDT',
    interval: '1m',
    preview: { interval: '1m' },
  }

  spotMarketRealtime.dispatch(preview, connection)
  spotMarketRealtime.dispatch({ ...preview, interval: '5m' }, connection)
  spotMarketRealtime.dispatch({ ...preview, symbol: 'ETHUSDT' }, connection)

  assert.deepEqual(messages, [preview])
  unsubscribe()
})

test('trade settlement emits embedded preview before trade in one websocket task', () => {
  const { spotMarketRealtime } = loadMarketRealtimeModule()
  const events: string[] = []
  const previews: unknown[] = []
  const trades: unknown[] = []
  const releasePreview = spotMarketRealtime.subscribe('preview', (message: unknown) => {
    events.push('preview')
    previews.push(message)
  })
  const releaseTrade = spotMarketRealtime.subscribe('trade', (message: unknown) => {
    events.push('trade')
    trades.push(message)
  })
  const connection = {
    symbol: 'BTCUSDT',
    domains: new Map([['trades', new Set(['market-owner'])]]),
    klineIntervals: new Map([['1m', new Set(['tv-owner'])]]),
  }
  const preview = {
    type: 'spot_candle_preview_update',
    symbol: 'BTCUSDT',
    interval: '1m',
    settlement_revision: 'spot:BTCUSDT:1m:3:1:3:8:1',
    preview: { close: '101', volume: '11' },
  }
  const trade = {
    type: 'spot_trade',
    symbol: 'BTCUSDT',
    settlement_revision: preview.settlement_revision,
    trade: { id: 'trade-1', price: '101', amount: '1' },
    candle_preview: preview,
  }

  spotMarketRealtime.dispatch(trade, connection)

  assert.deepEqual(events, ['preview', 'trade'])
  assert.deepEqual(previews, [preview])
  assert.deepEqual(trades, [trade])
  releaseTrade()
  releasePreview()
})

test('one heartbeat timer probes every active symbol without opening extra sockets', () => {
  const harness = installMarketRealtimeHarness()

  try {
    const btc = harness.client.acquireSubscription({
      symbol: 'BTCUSDT',
      domains: ['depth', 'ticker'],
      owner: 'btc-market',
    })
    const eth = harness.client.acquireSubscription({
      symbol: 'ETHUSDT',
      domains: ['depth'],
      owner: 'eth-market',
    })
    harness.runTimeouts()
    assert.equal(harness.sockets.length, 2)

    for (const socket of harness.sockets) {
      socket.readyState = harness.MockWebSocket.OPEN
      socket.onopen?.()
    }
    assert.equal(harness.intervalCount(), 1)

    harness.runHeartbeat()
    assert.deepEqual(harness.sockets.map((socket) => socket.sent), [['ping'], ['ping']])
    assert.equal(harness.sockets.length, 2)

    harness.client.releaseSubscription(btc)
    harness.client.releaseSubscription(eth)
    assert.equal(harness.intervalCount(), 0)
    assert.equal(harness.listenerCount(), 0)
  } finally {
    harness.client.disconnect()
    harness.restore()
  }
})

test('unchanged low-frequency prices stay healthy when any websocket message arrives', () => {
  const harness = installMarketRealtimeHarness()
  const originalNow = Date.now
  let now = 1_000_000
  Date.now = () => now

  try {
    const subscription = harness.client.acquireSubscription({
      symbol: 'EURUSDT',
      domains: ['depth'],
      owner: 'low-frequency-market',
    })
    harness.runTimeouts()
    const socket = harness.sockets[0]
    socket.readyState = harness.MockWebSocket.OPEN
    socket.onopen?.()

    now += 18_000
    harness.runHeartbeat()
    assert.equal(socket.sent.at(-1), 'ping')

    socket.onmessage?.({
      data: JSON.stringify({
        type: 'spot_depth_update',
        symbol: 'EURUSDT',
        depth: { best_bid: '1.10', best_ask: '1.11' },
      }),
    })
    now += 35_000
    harness.runHeartbeat()
    assert.equal(socket.readyState, harness.MockWebSocket.OPEN)

    now += 1_001
    harness.runHeartbeat()
    assert.equal(socket.readyState, harness.MockWebSocket.CLOSED)
    assert.deepEqual(socket.closeCalls.at(-1), {
      code: 4000,
      reason: 'spot market heartbeat timeout',
    })

    harness.client.releaseSubscription(subscription)
  } finally {
    Date.now = originalNow
    harness.client.disconnect()
    harness.restore()
  }
})

test('reconnect uses exponential backoff and resets only after inbound activity', () => {
  const harness = installMarketRealtimeHarness()

  try {
    const subscription = harness.client.acquireSubscription({
      symbol: 'BTCUSDT',
      domains: ['depth'],
      owner: 'market-owner',
    })
    harness.runTimeouts()
    const first = harness.sockets[0]
    first.readyState = harness.MockWebSocket.OPEN
    first.onopen?.()
    first.readyState = harness.MockWebSocket.CLOSED
    first.onclose?.()
    assert.equal(harness.timeoutDelays.at(-1), 1_500)

    harness.runTimeouts()
    const second = harness.sockets[1]
    second.readyState = harness.MockWebSocket.OPEN
    second.onopen?.()
    second.readyState = harness.MockWebSocket.CLOSED
    second.onclose?.()
    assert.equal(harness.timeoutDelays.at(-1), 3_000)

    harness.runTimeouts()
    const third = harness.sockets[2]
    third.readyState = harness.MockWebSocket.OPEN
    third.onopen?.()
    third.onmessage?.({ data: 'pong' })
    third.readyState = harness.MockWebSocket.CLOSED
    third.onclose?.()
    assert.equal(harness.timeoutDelays.at(-1), 1_500)

    harness.client.releaseSubscription(subscription)
  } finally {
    harness.client.disconnect()
    harness.restore()
  }
})

test('reconnect replays only active kline intervals on the existing symbol connection', () => {
  const harness = installMarketRealtimeHarness()

  try {
    const market = harness.client.acquireSubscription({
      symbol: 'BTCUSDT',
      domains: ['depth', 'trades', 'ticker'],
      owner: 'market-owner',
    })
    const minute = harness.client.acquireSubscription({
      symbol: 'BTCUSDT',
      interval: '1m',
      domains: ['kline'],
      owner: 'minute-owner',
    })
    const hourly = harness.client.acquireSubscription({
      symbol: 'BTCUSDT',
      interval: '1h',
      domains: ['kline'],
      owner: 'hourly-owner',
    })
    harness.runTimeouts()
    const first = harness.sockets[0]
    first.readyState = harness.MockWebSocket.OPEN
    first.onopen?.()
    assert.deepEqual(
      first.sent.map((item) => JSON.parse(item).interval),
      ['1m', '1h'],
    )

    harness.client.releaseSubscription(hourly)
    first.readyState = harness.MockWebSocket.CLOSED
    first.onclose?.()
    harness.runTimeouts()
    const second = harness.sockets[1]
    second.readyState = harness.MockWebSocket.OPEN
    second.onopen?.()

    assert.equal(harness.sockets.length, 2)
    assert.deepEqual(
      second.sent.map((item) => JSON.parse(item).interval),
      ['1m'],
    )

    harness.client.releaseSubscription(minute)
    harness.client.releaseSubscription(market)
  } finally {
    harness.client.disconnect()
    harness.restore()
  }
})

test('online and visible recovery probes open sockets and immediately restores closed ones', () => {
  const harness = installMarketRealtimeHarness()

  try {
    const subscription = harness.client.acquireSubscription({
      symbol: 'BTCUSDT',
      domains: ['depth'],
      owner: 'market-owner',
    })
    harness.runTimeouts()
    const first = harness.sockets[0]
    first.readyState = harness.MockWebSocket.OPEN
    first.onopen?.()

    harness.emitDocument('visibilitychange')
    assert.equal(first.sent.at(-1), 'ping')
    assert.equal(harness.sockets.length, 1)

    first.readyState = harness.MockWebSocket.CLOSED
    first.onclose?.()
    harness.emitWindow('online')
    assert.equal(harness.sockets.length, 2)

    harness.client.releaseSubscription(subscription)
  } finally {
    harness.client.disconnect()
    harness.restore()
  }
})

test('retired spot socket callbacks cannot disturb the replacement connection', () => {
  const harness = installMarketRealtimeHarness()

  try {
    const subscription = harness.client.acquireSubscription({
      symbol: 'BTCUSDT',
      domains: ['depth'],
      owner: 'market-owner',
    })
    harness.runTimeouts()
    const first = harness.sockets[0]
    first.readyState = harness.MockWebSocket.OPEN
    first.onopen?.()
    const retiredClose = first.onclose
    first.readyState = harness.MockWebSocket.CLOSED
    retiredClose?.()
    harness.runTimeouts()

    const replacement = harness.sockets[1]
    replacement.readyState = harness.MockWebSocket.OPEN
    replacement.onopen?.()
    retiredClose?.()
    harness.runHeartbeat()

    assert.equal(replacement.sent.at(-1), 'ping')
    assert.equal(harness.intervalCount(), 1)
    assert.equal(harness.sockets.length, 2)
    harness.client.releaseSubscription(subscription)
  } finally {
    harness.client.disconnect()
    harness.restore()
  }
})
