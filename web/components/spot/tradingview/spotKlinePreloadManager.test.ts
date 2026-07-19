/* eslint-disable @typescript-eslint/no-explicit-any -- Dynamic test harness loads compiled module exports. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve
  })
  return { promise, resolve }
}

function wait(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds))
}

function loadTypeScriptModule(
  filePath: string,
  mocks: Record<string, unknown>,
): Record<string, any> {
  const source = readFileSync(filePath, 'utf8')
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: filePath,
  }).outputText
  const loadedModule: { exports: Record<string, any> } = { exports: {} }
  const localRequire = (specifier: string) => {
    if (Object.prototype.hasOwnProperty.call(mocks, specifier)) return mocks[specifier]
    throw new Error(`Unexpected test import: ${specifier}`)
  }
  const execute = new Function('require', 'module', 'exports', output)
  execute(localRequire, loadedModule, loadedModule.exports)
  return loadedModule.exports
}

function normalizeInterval(value: unknown) {
  const text = String(value || '').trim()
  if (text === '1M' || text === '1Mutc' || text === '1Dutc' || text === '1Wutc') return text
  return text.toLowerCase()
}

function getBackendInterval(interval: string) {
  const normalized = normalizeInterval(interval)
  if (normalized === '1d') return '1Dutc'
  if (normalized === '1w') return '1Wutc'
  if (normalized === '1M') return '1Mutc'
  return normalized
}

function makeResult(count: number, interval = '1m') {
  const bars = Array.from({ length: count }, (_, index) => ({
    time: 1_717_000_000_000 + index * 60_000,
    open: 100,
    high: 101,
    low: 99,
    close: 100 + index,
    volume: 1,
  }))
  return {
    bars,
    revisionCandidates: bars.map((bar, index) => ({
      symbol: 'BTCUSDT',
      interval,
      openTime: bar.time,
      bar,
      provider: 'OKX_SPOT',
      source: 'REST_SNAPSHOT',
      revision: {
        revisionEpoch: 1,
        revisionSeq: index + 1,
        isClosed: true,
        closeStateSource: 'PROVIDER_CONFIRMED',
      },
    })),
    provider: 'OKX_SPOT',
    source: 'REST_SNAPSHOT',
  }
}

const perfEvents: Array<{ event: string; payload: Record<string, unknown> }> = []
const cacheByKey = new Map<string, Record<string, any>>()
let fetchCalls: Array<{ symbol: string; interval: string; limit: number }> = []
let cacheWriteCount = 0
type FetchCurrentParams = {
  symbol: string
  interval: string
  limit: number
  shouldStore?: () => boolean
}
let fetchCurrent = async (params: FetchCurrentParams) => {
  const result = makeResult(params.limit, params.interval)
  return {
    ...result,
    key: `${params.symbol}:${params.interval}:${params.limit}`,
    symbol: params.symbol,
    interval: params.interval,
    limit: params.limit,
    terminalComplete: false,
  }
}

const cacheModule = {
  buildKlineCachePerfPayload: () => ({}),
  fetchAndCacheCurrentKlineBars: async (params: FetchCurrentParams) => {
    fetchCalls.push(params)
    const entry = await fetchCurrent(params)
    if (!entry || (params.shouldStore && !params.shouldStore())) return null
    cacheByKey.set(`${params.symbol}:${params.interval}`, entry)
    return entry
  },
  getBackendKlineIntervalForSpotInterval: getBackendInterval,
  inspectCurrentKlineCache: (symbol: string, interval: string, limit: number, options?: { minBars?: number }) => {
    const entry = cacheByKey.get(`${symbol}:${normalizeInterval(interval)}`) || null
    const coversRequest = Boolean(
      entry
      && (
        entry.bars.length >= Number(options?.minBars || 1)
        || (entry.terminalComplete && Number(entry.requestedLimit || 0) >= limit)
      )
    )
    const hit = coversRequest ? entry : null
    return { hit, candidate: entry, reason: hit ? 'hit' : entry ? 'insufficient' : 'miss' }
  },
  normalizeSpotInterval: normalizeInterval,
  writeCurrentKlineCache: (params: Record<string, any>) => {
    cacheWriteCount += 1
    const entry = {
      ...params,
      key: `${params.symbol}:${params.interval}:${params.limit}`,
      terminalComplete: false,
    }
    cacheByKey.set(`${params.symbol}:${normalizeInterval(params.interval)}`, entry)
    return entry
  },
}

const preloadModule = loadTypeScriptModule(
  fileURLToPath(new URL('./spotKlinePreloadManager.ts', import.meta.url)),
  {
    '@/lib/api/modules/spot': {
      normalizeSpotSymbol: (symbol: string) => String(symbol || '').replace(/[^a-z0-9]/gi, '').toUpperCase(),
    },
    './spotKlineClientCache': cacheModule,
    './spotKlinePerf': {
      markSpotKlinePerf: (event: string, payload: Record<string, unknown>) => {
        perfEvents.push({ event, payload })
      },
    },
  },
)

;(globalThis as any).window = {
  setTimeout: (callback: () => void) => {
    queueMicrotask(callback)
    return 1
  },
  clearTimeout: () => undefined,
}

function resetHarness() {
  preloadModule.resetSpotKlineInFlightRegistryForTests()
  perfEvents.length = 0
  cacheByKey.clear()
  fetchCalls = []
  cacheWriteCount = 0
  fetchCurrent = async (params: FetchCurrentParams) => {
    const result = makeResult(params.limit, params.interval)
    return {
      ...result,
      key: `${params.symbol}:${params.interval}:${params.limit}`,
      symbol: params.symbol,
      interval: params.interval,
      limit: params.limit,
      terminalComplete: false,
    }
  }
}

test('same symbol and interval requests share one in-flight promise', async () => {
  resetHarness()
  const pending = deferred<ReturnType<typeof makeResult>>()
  let firstCount = 0
  let duplicateCount = 0
  const first = preloadModule.requestSpotKlineInFlight({
    symbol: 'BTCUSDT',
    interval: '1m',
    requestedBars: 2,
    role: 'active',
    request: async () => {
      firstCount += 1
      return pending.promise
    },
  })
  const duplicate = preloadModule.requestSpotKlineInFlight({
    symbol: 'BTCUSDT',
    interval: '1m',
    requestedBars: 2,
    role: 'preload',
    request: async () => {
      duplicateCount += 1
      return makeResult(2)
    },
  })

  assert.equal(firstCount, 1)
  assert.equal(duplicateCount, 0)
  pending.resolve(makeResult(2))
  const [firstOutcome, duplicateOutcome] = await Promise.all([first, duplicate])

  assert.equal(firstOutcome.joined, false)
  assert.equal(duplicateOutcome.joined, true)
  assert.equal(duplicateOutcome.startedRequest, false)
  assert.equal(duplicateCount, 0)
  const metrics = preloadModule.getSpotKlineInFlightMetricsSnapshot()
  assert.equal(metrics.inflightJoinCount, 1)
  assert.equal(metrics.duplicateRequestAvoidedCount, 1)
  assert.equal(metrics.preloadJoinedCount, 1)
  assert.equal(metrics.activeCount, 0)
})

test('producer rejection clears the entry and permits a retry', async () => {
  resetHarness()
  await assert.rejects(
    preloadModule.requestSpotKlineInFlight({
      symbol: 'BTCUSDT',
      interval: '1m',
      requestedBars: 2,
      role: 'active',
      deadlineMs: 50,
      request: async () => {
        throw new Error('provider rejected')
      },
    }),
    /provider rejected/,
  )
  assert.equal(preloadModule.getSpotKlineInFlightMetricsSnapshot().activeCount, 0)

  const retry = await preloadModule.requestSpotKlineInFlight({
    symbol: 'BTCUSDT',
    interval: '1m',
    requestedBars: 2,
    role: 'active',
    deadlineMs: 50,
    request: async () => makeResult(2),
  })
  assert.equal(retry.startedRequest, true)
  assert.equal(retry.result.bars.length, 2)
})

test('never-resolving producer times out and evicts its lease', async () => {
  resetHarness()
  const pending = deferred<ReturnType<typeof makeResult>>()
  await assert.rejects(
    preloadModule.requestSpotKlineInFlight({
      symbol: 'BTCUSDT',
      interval: '1m',
      requestedBars: 2,
      role: 'active',
      deadlineMs: 10,
      request: async () => pending.promise,
    }),
    /timed out/,
  )

  const metrics = preloadModule.getSpotKlineInFlightMetricsSnapshot()
  assert.equal(metrics.activeCount, 0)
  assert.equal(metrics.inflightTimeoutCount, 1)
  assert.equal(metrics.inflightEvictionCount, 1)
})

test('all joiners receive the same timeout and foreground tightens a preload deadline', async () => {
  resetHarness()
  const pending = deferred<ReturnType<typeof makeResult>>()
  let activeFallbackCount = 0
  const preload = preloadModule.requestSpotKlineInFlight({
    symbol: 'BTCUSDT',
    interval: '1m',
    requestedBars: 2,
    role: 'preload',
    deadlineMs: 1_000,
    request: async () => pending.promise,
  })
  const active = preloadModule.requestSpotKlineInFlight({
    symbol: 'BTCUSDT',
    interval: '1m',
    requestedBars: 2,
    role: 'active',
    deadlineMs: 10,
    request: async () => {
      activeFallbackCount += 1
      return makeResult(2)
    },
  })

  const outcomes = await Promise.allSettled([preload, active])
  assert.deepEqual(outcomes.map((outcome) => outcome.status), ['rejected', 'rejected'])
  assert.equal(activeFallbackCount, 0)
  const metrics = preloadModule.getSpotKlineInFlightMetricsSnapshot()
  assert.equal(metrics.inflightJoinCount, 1)
  assert.equal(metrics.inflightTimeoutCount, 1)
  assert.equal(metrics.activeCount, 0)
})

test('timeout allows a new producer and drops the retired lease late result', async () => {
  resetHarness()
  const retired = deferred<ReturnType<typeof makeResult>>()
  const current = deferred<ReturnType<typeof makeResult>>()
  let retiredStoreCount = 0
  const first = preloadModule.requestSpotKlineInFlight({
    symbol: 'BTCUSDT',
    interval: '1m',
    requestedBars: 2,
    role: 'active',
    deadlineMs: 10,
    request: async (lease: { isCurrent: () => boolean }) => {
      const result = await retired.promise
      if (lease.isCurrent()) retiredStoreCount += 1
      return result
    },
  })
  await assert.rejects(first, /timed out/)

  const second = preloadModule.requestSpotKlineInFlight({
    symbol: 'BTCUSDT',
    interval: '1m',
    requestedBars: 2,
    role: 'active',
    deadlineMs: 100,
    request: async () => current.promise,
  })
  const secondLease = preloadModule.getSpotKlineInFlightMetricsSnapshot().active[0].leaseId
  retired.resolve(makeResult(2))
  await wait(0)

  const duringSecond = preloadModule.getSpotKlineInFlightMetricsSnapshot()
  assert.equal(duringSecond.activeCount, 1)
  assert.equal(duringSecond.active[0].leaseId, secondLease)
  assert.equal(duringSecond.inflightLateResultDropCount, 1)
  assert.equal(retiredStoreCount, 0)

  current.resolve(makeResult(2))
  const secondOutcome = await second
  assert.equal(secondOutcome.result.bars.length, 2)
  assert.equal(preloadModule.getSpotKlineInFlightMetricsSnapshot().activeCount, 0)
})

test('active getBars and revalidate roles share one request', async () => {
  resetHarness()
  const pending = deferred<ReturnType<typeof makeResult>>()
  let activeCount = 0
  let revalidateCount = 0
  const active = preloadModule.requestSpotKlineInFlight({
    symbol: 'BTCUSDT',
    interval: '1m',
    requestedBars: 2,
    role: 'active',
    request: async () => {
      activeCount += 1
      return pending.promise
    },
  })
  const revalidate = preloadModule.requestSpotKlineInFlight({
    symbol: 'BTCUSDT',
    interval: '1m',
    requestedBars: 2,
    role: 'revalidate',
    request: async () => {
      revalidateCount += 1
      return makeResult(2)
    },
  })

  assert.equal(activeCount, 1)
  assert.equal(revalidateCount, 0)
  pending.resolve(makeResult(2))
  const [, joined] = await Promise.all([active, revalidate])
  assert.equal(joined.joined, true)
  assert.equal(revalidateCount, 0)
})

test('larger preload waits for smaller active request and skips follow-up when cache covers it', async () => {
  resetHarness()
  const pending = deferred<ReturnType<typeof makeResult>>()
  let largerRequestCount = 0
  let coveredResult: ReturnType<typeof makeResult> | null = null
  const active = preloadModule.requestSpotKlineInFlight({
    symbol: 'BTCUSDT',
    interval: '1m',
    requestedBars: 300,
    role: 'active',
    request: async () => pending.promise,
  })
  const preload = preloadModule.requestSpotKlineInFlight({
    symbol: 'BTCUSDT',
    interval: '1m',
    requestedBars: 360,
    role: 'preload',
    getCoveredResult: () => coveredResult,
    request: async () => {
      largerRequestCount += 1
      return makeResult(360)
    },
  })

  coveredResult = makeResult(360)
  pending.resolve(makeResult(300))
  const [, preloadOutcome] = await Promise.all([active, preload])

  assert.equal(largerRequestCount, 0)
  assert.equal(preloadOutcome.result.bars.length, 360)
  assert.equal(preloadOutcome.startedRequest, false)
})

test('monthly foreground countBack 329 terminal coverage lets preload 360 join one producer', async () => {
  resetHarness()
  const pending = deferred<ReturnType<typeof makeResult> & { coverageComplete: boolean }>()
  let foregroundProducerCount = 0
  let preloadProducerCount = 0
  const foreground = preloadModule.requestSpotKlineInFlight({
    symbol: 'BTCUSDT',
    interval: '1Mutc',
    requestedBars: 360,
    role: 'active',
    request: async () => {
      foregroundProducerCount += 1
      return pending.promise
    },
  })
  const preload = preloadModule.requestSpotKlineInFlight({
    symbol: 'BTCUSDT',
    interval: '1Mutc',
    requestedBars: 360,
    role: 'preload',
    request: async () => {
      preloadProducerCount += 1
      return makeResult(360, '1Mutc')
    },
  })

  pending.resolve({
    ...makeResult(102, '1Mutc'),
    coverageComplete: true,
  })
  const [foregroundOutcome, preloadOutcome] = await Promise.all([foreground, preload])

  assert.equal(foregroundProducerCount, 1)
  assert.equal(preloadProducerCount, 0)
  assert.equal(foregroundOutcome.result.bars.length, 102)
  assert.equal(preloadOutcome.result.bars.length, 102)
  assert.equal(preloadOutcome.joined, true)
  assert.equal(preloadOutcome.startedRequest, false)
})

test('larger request supplements only after smaller in-flight coverage remains insufficient', async () => {
  resetHarness()
  const pending = deferred<ReturnType<typeof makeResult>>()
  let largerRequestCount = 0
  const active = preloadModule.requestSpotKlineInFlight({
    symbol: 'BTCUSDT',
    interval: '1m',
    requestedBars: 300,
    role: 'active',
    request: async () => pending.promise,
  })
  const preload = preloadModule.requestSpotKlineInFlight({
    symbol: 'BTCUSDT',
    interval: '1m',
    requestedBars: 360,
    role: 'preload',
    getCoveredResult: () => null,
    request: async () => {
      largerRequestCount += 1
      return makeResult(360)
    },
  })

  assert.equal(largerRequestCount, 0)
  pending.resolve(makeResult(300))
  const [, preloadOutcome] = await Promise.all([active, preload])

  assert.equal(largerRequestCount, 1)
  assert.equal(preloadOutcome.startedRequest, true)
  assert.equal(preloadOutcome.result.bars.length, 360)
})

test('different symbols and intervals never share in-flight work', async () => {
  resetHarness()
  const btc1m = deferred<ReturnType<typeof makeResult>>()
  const eth1m = deferred<ReturnType<typeof makeResult>>()
  const btc5m = deferred<ReturnType<typeof makeResult>>()
  let started = 0
  const request = (symbol: string, interval: string, pending: Deferred<ReturnType<typeof makeResult>>) => (
    preloadModule.requestSpotKlineInFlight({
      symbol,
      interval,
      requestedBars: 2,
      role: 'active',
      request: async () => {
        started += 1
        return pending.promise
      },
    })
  )
  const requests = [
    request('BTCUSDT', '1m', btc1m),
    request('ETHUSDT', '1m', eth1m),
    request('BTCUSDT', '5m', btc5m),
  ]
  assert.equal(started, 3)
  btc1m.resolve(makeResult(2, '1m'))
  eth1m.resolve(makeResult(2, '1m'))
  btc5m.resolve(makeResult(2, '5m'))
  await Promise.all(requests)
  assert.equal(preloadModule.getSpotKlineInFlightMetricsSnapshot().inflightJoinCount, 0)
})

test('preload limits are interval-aware for intraday daily weekly and monthly history', () => {
  resetHarness()

  for (const interval of ['1m', '5m', '15m', '1h', '4h']) {
    assert.equal(preloadModule.getSpotKlinePreloadLimit(interval), 360)
  }
  assert.equal(preloadModule.getSpotKlinePreloadLimit('1d'), 120)
  assert.equal(preloadModule.getSpotKlinePreloadLimit('1Dutc'), 120)
  assert.equal(preloadModule.getSpotKlinePreloadLimit('1w'), 80)
  assert.equal(preloadModule.getSpotKlinePreloadLimit('1Wutc'), 80)
  assert.equal(preloadModule.getSpotKlinePreloadLimit('1M'), 360)
  assert.equal(preloadModule.getSpotKlinePreloadLimit('1Mutc'), 360)
})

test('active monthly preload requests 1Mutc with full terminal coverage', async () => {
  resetHarness()

  await preloadModule.preloadSpotTradingViewKlineCache({
    symbol: 'BTCUSDT',
    intervals: ['1m', '1M'],
    activeInterval: '1M',
    concurrency: 1,
  })

  assert.deepEqual(fetchCalls.map(({ interval, limit }) => ({ interval, limit })), [
    { interval: '1Mutc', limit: 360 },
    { interval: '1m', limit: 360 },
  ])
})

test('foreground widget prewarm uses active ownership and records dedicated evidence', async () => {
  resetHarness()

  await preloadModule.preloadSpotTradingViewKlineCache({
    symbol: 'BTCUSDT',
    intervals: ['1m'],
    activeInterval: '1m',
    concurrency: 1,
    role: 'active',
  })

  assert.deepEqual(fetchCalls.map(({ interval, limit }) => ({ interval, limit })), [
    { interval: '1m', limit: 360 },
  ])
  assert.equal(
    perfEvents.some(({ event }) => event === 'kline_foreground_prewarm_start'),
    true,
  )
  assert.equal(
    perfEvents.some(({ event }) => event === 'kline_foreground_prewarm_success'),
    true,
  )
})

test('monthly preload skips a terminal-complete cache that covers the 360-bar policy', async () => {
  resetHarness()
  const result = makeResult(100, '1Mutc')
  cacheByKey.set('BTCUSDT:1Mutc', {
    ...result,
    key: 'BTCUSDT:1Mutc:360',
    symbol: 'BTCUSDT',
    interval: '1Mutc',
    limit: 360,
    requestedLimit: 360,
    terminalComplete: true,
  })

  await preloadModule.preloadSpotTradingViewKlineCache({
    symbol: 'BTCUSDT',
    intervals: ['1M'],
    activeInterval: '1M',
  })

  assert.equal(fetchCalls.length, 0)
  assert.equal(preloadModule.getSpotKlineInFlightMetricsSnapshot().preloadSkippedCount, 1)
})

test('monthly preload joins matching in-flight coverage without a duplicate fetch', async () => {
  resetHarness()
  const earliestBoundary = Date.UTC(2018, 0, 1)
  const pending = deferred<ReturnType<typeof makeResult> & {
    history_terminal: boolean
    terminal_reason: string
    earliest_available_time: number
  }>()
  const active = preloadModule.requestSpotKlineInFlight({
    symbol: 'BTCUSDT',
    interval: '1Mutc',
    requestedBars: 360,
    role: 'active',
    request: async () => pending.promise,
  })
  const preload = preloadModule.preloadSpotTradingViewKlineCache({
    symbol: 'BTCUSDT',
    intervals: ['1M'],
    activeInterval: '1M',
  })

  pending.resolve({
    ...makeResult(102, '1Mutc'),
    history_terminal: true,
    terminal_reason: 'CACHE_HISTORY_BOUNDARY',
    earliest_available_time: earliestBoundary,
  })
  await Promise.all([active, preload])

  assert.equal(fetchCalls.length, 0)
  assert.equal(preloadModule.getSpotKlineInFlightMetricsSnapshot().preloadJoinedCount, 1)
  const stored = cacheByKey.get('BTCUSDT:1Mutc')
  assert.equal(stored?.historyTerminal, true)
  assert.equal(stored?.terminalReason, 'CACHE_HISTORY_BOUNDARY')
  assert.equal(stored?.earliestBoundary, earliestBoundary)
})

test('retired monthly preload cannot store a late result after scope switch', async () => {
  resetHarness()
  const pending = deferred<Awaited<ReturnType<typeof fetchCurrent>>>()
  let currentScope = true
  fetchCurrent = async () => pending.promise
  const preload = preloadModule.preloadSpotTradingViewKlineCache({
    symbol: 'BTCUSDT',
    intervals: ['1M'],
    activeInterval: '1M',
    shouldContinue: () => currentScope,
  })

  assert.deepEqual(fetchCalls.map(({ interval, limit }) => ({ interval, limit })), [
    { interval: '1Mutc', limit: 360 },
  ])
  currentScope = false
  const result = makeResult(100, '1Mutc')
  pending.resolve({
    ...result,
    key: 'BTCUSDT:1Mutc:360',
    symbol: 'BTCUSDT',
    interval: '1Mutc',
    limit: 360,
    terminalComplete: true,
  })
  await preload

  assert.equal(cacheByKey.has('BTCUSDT:1Mutc'), false)
  assert.equal(cacheWriteCount, 0)
})

test('preload processes the active interval before other intervals', async () => {
  resetHarness()
  await preloadModule.preloadSpotTradingViewKlineCache({
    symbol: 'BTCUSDT',
    intervals: ['1m', '5m'],
    activeInterval: '5m',
    concurrency: 1,
  })

  assert.deepEqual(fetchCalls.map((call) => call.interval), ['5m', '1m'])
})

test('background preload excludes the foreground interval', () => {
  resetHarness()

  assert.deepEqual(
    preloadModule.getSpotBackgroundPreloadIntervals('1m'),
    ['4h', '1h', '15m', '5m', '1d', '1w', '1M'],
  )
  assert.deepEqual(
    preloadModule.getSpotBackgroundPreloadIntervals('1M'),
    ['4h', '1h', '15m', '5m', '1m', '1d', '1w'],
  )
})

test('multiple preloads for one symbol interval share the same fetch', async () => {
  resetHarness()
  const pending = deferred<Awaited<ReturnType<typeof fetchCurrent>>>()
  fetchCurrent = async () => pending.promise
  const first = preloadModule.preloadSpotTradingViewKlineCache({
    symbol: 'BTCUSDT',
    intervals: ['1m'],
    activeInterval: '1m',
  })
  const second = preloadModule.preloadSpotTradingViewKlineCache({
    symbol: 'BTCUSDT',
    intervals: ['1m'],
    activeInterval: '1m',
  })

  assert.equal(fetchCalls.length, 1)
  pending.resolve({
    ...makeResult(2),
    key: 'BTCUSDT:1m:2',
    symbol: 'BTCUSDT',
    interval: '1m',
    limit: 2,
    terminalComplete: false,
  })
  await Promise.all([first, second])

  assert.equal(fetchCalls.length, 1)
  assert.equal(preloadModule.getSpotKlineInFlightMetricsSnapshot().preloadJoinedCount, 1)
})

test('joined preload stores revision-aware result without starting a duplicate request', async () => {
  resetHarness()
  const pending = deferred<ReturnType<typeof makeResult>>()
  const active = preloadModule.requestSpotKlineInFlight({
    symbol: 'BTCUSDT',
    interval: '1m',
    requestedBars: 360,
    role: 'active',
    request: async () => pending.promise,
  })
  const preload = preloadModule.preloadSpotTradingViewKlineCache({
    symbol: 'BTCUSDT',
    intervals: ['1m'],
    activeInterval: '1m',
  })

  pending.resolve(makeResult(2))
  await Promise.all([active, preload])

  assert.equal(fetchCalls.length, 0)
  assert.equal(cacheWriteCount, 1)
  assert.equal(cacheByKey.get('BTCUSDT:1m')?.revisionCandidates.length, 2)
})

test('preload failure leaves existing stale candidate untouched', async () => {
  resetHarness()
  const staleEntry = {
    ...makeResult(1),
    key: 'BTCUSDT:1m:stale',
    symbol: 'BTCUSDT',
    interval: '1m',
    limit: 1,
    terminalComplete: false,
  }
  cacheByKey.set('BTCUSDT:1m', staleEntry)
  fetchCurrent = async () => {
    throw new Error('provider unavailable')
  }

  await preloadModule.preloadSpotTradingViewKlineCache({
    symbol: 'BTCUSDT',
    intervals: ['1m'],
    activeInterval: '1m',
  })

  assert.equal(cacheByKey.get('BTCUSDT:1m'), staleEntry)
  assert.equal(cacheWriteCount, 0)
  assert.ok(perfEvents.some((entry) => entry.event === 'kline_preload_error'))
})

test('foreground loading cancels pending preload dispatch and resumes alternatives after commit', async () => {
  resetHarness()
  const state = {
    symbol: 'BTCUSDT',
    interval: '1m',
    resolution: '1',
  }
  const manager = preloadModule.createSpotKlinePreloadManager({
    getState: () => state,
  })
  manager.schedule({
    phase: 'current',
    isHistoryRequest: false,
    symbol: 'BTCUSDT',
    resolution: '1',
    interval: '1m',
    backendInterval: '1m',
    requiredBars: 329,
    barCount: 329,
  }, 'initial current history')

  manager.setForegroundState({
    loading: true,
    symbol: 'BTCUSDT',
    interval: '1Mutc',
    generation: 1,
  })
  await wait(0)
  assert.equal(fetchCalls.length, 0)

  state.interval = '1M'
  state.resolution = '1M'
  manager.schedule({
    phase: 'current',
    isHistoryRequest: false,
    symbol: 'BTCUSDT',
    resolution: '1M',
    interval: '1M',
    backendInterval: '1Mutc',
    requiredBars: 329,
    barCount: 100,
  }, 'monthly foreground history')
  manager.setForegroundState({
    loading: false,
    symbol: 'BTCUSDT',
    interval: '1Mutc',
    generation: 1,
  })
  await wait(0)
  await wait(0)

  assert.equal(fetchCalls[0]?.interval, '4h')
  assert.equal(fetchCalls.some((call) => call.interval === '1Mutc'), false)
  assert.ok(perfEvents.some((entry) => (
    entry.event === 'kline_preload_foreground_resume'
    && entry.payload.delay_ms === 1_800
  )))
})

test('running preload may finish during foreground loading but cannot dispatch its next interval', async () => {
  resetHarness()
  const firstRequest = deferred<Awaited<ReturnType<typeof fetchCurrent>>>()
  fetchCurrent = async () => firstRequest.promise
  const state = {
    symbol: 'BTCUSDT',
    interval: '1m',
    resolution: '1',
  }
  const manager = preloadModule.createSpotKlinePreloadManager({
    getState: () => state,
  })
  manager.schedule({
    phase: 'current',
    isHistoryRequest: false,
    symbol: 'BTCUSDT',
    resolution: '1',
    interval: '1m',
    backendInterval: '1m',
    requiredBars: 329,
    barCount: 329,
  }, 'start preload queue')
  await wait(0)
  await wait(0)
  assert.equal(fetchCalls.length, 1)

  manager.setForegroundState({
    loading: true,
    symbol: 'BTCUSDT',
    interval: '1Dutc',
    generation: 7,
  })
  firstRequest.resolve({
    ...makeResult(360, '1m'),
    key: 'BTCUSDT:1m:360',
    symbol: 'BTCUSDT',
    interval: '1m',
    limit: 360,
    terminalComplete: false,
  })
  await wait(0)
  await wait(0)

  assert.equal(fetchCalls.length, 1)
  assert.equal(cacheByKey.has('BTCUSDT:1m'), false)
})
