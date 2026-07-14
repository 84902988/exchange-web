/* eslint-disable @typescript-eslint/no-explicit-any -- Dynamic test harness loads compiled module exports. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
}

type KlineResponse = {
  items: any[]
  provider?: string | null
  source?: string | null
  freshness?: string | null
  stale?: boolean | null
  cache_status?: string | null
  history_incomplete?: boolean | null
  history_terminal?: boolean | null
  terminal_reason?: string | null
  earliest_available_time?: number | null
  provider_error_code?: string | null
  provider_error_provider?: string | null
}

type HistoryCall = {
  bars: any[]
  meta: { noData?: boolean }
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })
  return { promise, resolve, reject }
}

async function waitFor(condition: () => boolean, message: string) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (condition()) return
    await Promise.resolve()
  }
  assert.ok(condition(), message)
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
  const execute = new Function(
    'require',
    'module',
    'exports',
    '__filename',
    '__dirname',
    output,
  )
  execute(
    localRequire,
    loadedModule,
    loadedModule.exports,
    filePath,
    filePath.slice(0, Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))),
  )
  return loadedModule.exports
}

function normalizeInterval(value: unknown) {
  const text = String(value || '').trim()
  if (text === '1M' || text === '1Mutc') return text
  if (text === '1Dutc' || text === '1Wutc') return text
  return text.toLowerCase()
}

const continuity = {
  duplicateCount: 0,
  gapCount: 0,
  maxGap: 0,
  outOfOrderCount: 0,
  invalidOhlcCount: 0,
}

const revisionCacheModule = loadTypeScriptModule(
  fileURLToPath(new URL('./spotKlineClientCache.ts', import.meta.url)),
  {
    '@/lib/api/modules/spot': {
      getSpotKlines: async () => ({ items: [] }),
      normalizeSpotSymbol: (symbol: string) => String(symbol || '').replace(/[^a-z0-9]/gi, '').toUpperCase(),
    },
    '../chart/chart.utils': {
      normalizeTimeToSeconds: (value: unknown) => {
        const number = Number(value)
        if (!Number.isFinite(number)) return 0
        return number > 9_999_999_999 ? Math.floor(number / 1000) : Math.floor(number)
      },
    },
    './spotKlinePerf': { markSpotKlinePerf: () => null },
  },
)

let currentCacheLookup: Record<string, any> | null = null
const cacheWriteCalls: Array<Record<string, any>> = []

const cacheModule = {
  buildKlineCachePerfPayload: () => ({}),
  cloneBars: (bars: any[]) => bars.map((bar) => ({ ...bar })),
  createSpotKlineRevisionCache: revisionCacheModule.createSpotKlineRevisionCache,
  extractSpotKlineRevisionMetadata: revisionCacheModule.extractSpotKlineRevisionMetadata,
  fetchAndCacheCurrentKlineBars: async () => null,
  getBackendKlineIntervalForSpotInterval: (interval: string) => {
    const normalized = normalizeInterval(interval)
    if (normalized === '1d') return '1Dutc'
    if (normalized === '1w') return '1Wutc'
    if (normalized === '1M') return '1Mutc'
    return normalized
  },
  getBarsContinuityStats: () => ({ ...continuity }),
  getL1CurrentKlineCacheMinBars: () => 1,
  getPreloadKlineLimit: () => 1,
  getSpotIntervalMs: () => 60_000,
  getSpotKlineLoadPolicy: () => ({ current: 1, preload: 1, history: 1 }),
  isSparseRealKlineSeries: () => false,
  inspectCurrentKlineCache: (_symbol: string, _interval: string, requestedLimit: number) => (
    currentCacheLookup || {
      hit: null,
      reason: 'miss',
      minBars: 1,
      requestedLimit,
    }
  ),
  inspectStaleHistoryEligibility: revisionCacheModule.inspectStaleHistoryEligibility,
  isProviderCandleOnlyInterval: (interval: string) => ['1d', '1Dutc', '1w', '1Wutc', '1M', '1Mutc'].includes(interval),
  isUtcProviderCandleInterval: (interval: string) => interval.endsWith('utc'),
  mergeTradingViewBars: (bars: any[]) => {
    const byTime = new Map<number, any>()
    bars.forEach((bar) => byTime.set(bar.time, bar))
    return Array.from(byTime.values()).sort((left, right) => left.time - right.time)
  },
  normalizeSpotInterval: normalizeInterval,
  readCurrentKlineCache: () => null,
  shouldRejectKlineContinuity: () => false,
  writeCurrentKlineCache: (params: Record<string, any>) => {
    cacheWriteCalls.push(params)
    return params
  },
}

const preloadModule = loadTypeScriptModule(
  fileURLToPath(new URL('./spotKlinePreloadManager.ts', import.meta.url)),
  {
    '@/lib/api/modules/spot': {
      normalizeSpotSymbol: (symbol: string) => String(symbol || '').replace(/[^a-z0-9]/gi, '').toUpperCase(),
    },
    './spotKlineClientCache': cacheModule,
    './spotKlinePerf': { markSpotKlinePerf: () => null },
  },
)

let requestKlines: (params: Record<string, unknown>) => Promise<KlineResponse> = async () => ({ items: [] })
let klineSubscriber: ((message: Record<string, unknown>) => void) | null = null
const datafeedModule = loadTypeScriptModule(
  fileURLToPath(new URL('./spotTradingViewDatafeed.ts', import.meta.url)),
  {
    '@/lib/api/modules/spot': {
      getSpotKlines: (params: Record<string, unknown>) => requestKlines(params),
      normalizeSpotSymbol: (symbol: string) => String(symbol || '').replace(/[^a-z0-9]/gi, '').toUpperCase(),
    },
    '@/services/marketRealtime': {
      spotMarketRealtime: {
        acquireKlineInterval: () => () => undefined,
        acquireSubscription: () => 'test-kline-subscription',
        releaseSubscription: () => undefined,
        subscribe: () => {
          throw new Error('datafeed must not subscribe directly to marketRealtime kline')
        },
        releaseKlineIntervalOwner: () => undefined,
        syncKlineInterval: () => undefined,
      },
    },
    '../chart/chart.utils': {
      normalizeTimeToSeconds: (value: unknown) => {
        const number = Number(value)
        if (!Number.isFinite(number)) return 0
        return number > 9_999_999_999 ? Math.floor(number / 1000) : Math.floor(number)
      },
    },
    './spotKlinePerf': {
      createSpotKlinePerfId: () => 'test-request',
      markSpotKlinePerf: () => null,
    },
    './spotKlineClientCache': cacheModule,
    './spotKlinePreloadManager': preloadModule,
    './spotKlineStoreAdapter': {
      subscribeSpotKlineCurrent: ({
        onSnapshot,
      }: {
        onSnapshot: (event: Record<string, unknown>) => void
      }) => {
        const handler = (message: Record<string, unknown>) => {
          const kline = message.kline as Record<string, unknown>
          onSnapshot({
            snapshotId: `test-${String(kline?.revision_seq ?? 'none')}`,
            symbol: message.symbol,
            interval: message.interval,
            kline,
            provider: kline?.provider ?? message.provider ?? null,
            source: kline?.source ?? message.source ?? 'LIVE_WS',
            freshness: kline?.freshness ?? message.freshness ?? 'LIVE',
            receivedAtMs: Number(message.received_at_ms) || Date.now(),
            revision: {
              epoch: kline?.revision_epoch ?? null,
              sequence: kline?.revision_seq ?? null,
              is_closed: kline?.is_closed ?? null,
              close_state_source: kline?.close_state_source ?? null,
            },
            sequence: kline?.revision_seq ?? null,
            closed: kline?.is_closed ?? null,
          })
        }
        klineSubscriber = handler
        return () => {
          if (klineSubscriber === handler) klineSubscriber = null
        }
      },
    },
  },
)

const symbolInfo = (ticker = 'BTCUSDT') => ({ ticker, name: ticker })
const currentPeriod = {
  from: 0,
  to: 2_000_000_000,
  firstDataRequest: true,
  countBack: 1,
}
const historyPeriod = {
  ...currentPeriod,
  firstDataRequest: false,
}
const row = (openTime = 1_717_000_000_000, close = '101') => ({
  open_time: openTime,
  open: close,
  high: close,
  low: close,
  close,
  volume: '1',
})

function metadata(items: any[], overrides: Partial<KlineResponse> = {}): KlineResponse {
  return {
    items,
    source: items.length ? 'REST_HISTORY' : 'EMPTY',
    freshness: items.length ? 'RECENT' : 'MISSING',
    stale: false,
    cache_status: items.length ? 'MISS' : 'PROVIDER_EMPTY',
    history_incomplete: false,
    history_terminal: false,
    terminal_reason: null,
    earliest_available_time: null,
    provider_error_code: null,
    ...overrides,
  }
}

test('history noData requires explicit consistent terminal metadata', () => {
  const resolvePolicy = datafeedModule.resolveHistoryNoDataPolicy
  const policy = (result: Record<string, unknown>, isHistoryRequest = true) => resolvePolicy({
    isHistoryRequest,
    result: { bars: [], ...result },
  })

  assert.equal(policy({ history_incomplete: true }).noData, false)
  assert.equal(policy({ cache_status: 'PROVIDER_EMPTY', provider_error_code: 'EMPTY' }).noData, false)
  for (const providerErrorCode of ['TIMEOUT', 'HTTP_ERROR', 'COOLDOWN', 'UNKNOWN']) {
    assert.equal(policy({ provider_error_code: providerErrorCode }).noData, false, providerErrorCode)
  }
  assert.equal(policy({}).noData, false, 'legacy metadata absence is non-terminal')
  assert.equal(policy({ history_terminal: true, history_incomplete: false }).noData, true)
  assert.equal(policy({ history_terminal: true, history_incomplete: true }).noData, false)
  assert.equal(policy({ history_terminal: true, cache_status: 'SHORT' }).noData, false)
  assert.equal(policy({ history_terminal: true, stale: true }).noData, false)
  assert.equal(policy({ history_terminal: true }, false).noData, true, 'terminal current result is final no-data')
  assert.equal(policy({ provider_error_code: 'SYMBOL_NOT_FOUND' }, false).noData, true)
  assert.equal(resolvePolicy({
    isHistoryRequest: true,
    result: { bars: [{ time: 1 }], history_terminal: true },
  }).noData, false, 'short non-empty pages never report noData')
})

test('normal getBars success settles history exactly once', async () => {
  requestKlines = async () => metadata([row()])
  const historyCalls: HistoryCall[] = []
  const errors: string[] = []
  const datafeed = datafeedModule.createSpotTradingViewDatafeed({ symbol: 'BTCUSDT' })

  datafeed.getBars(
    symbolInfo(),
    '1',
    currentPeriod,
    (bars: any[], meta: { noData?: boolean }) => historyCalls.push({ bars, meta }),
    (reason: string) => errors.push(reason),
  )
  await waitFor(() => historyCalls.length === 1, 'normal getBars did not settle')
  await Promise.resolve()

  assert.equal(historyCalls.length, 1)
  assert.equal(historyCalls[0].bars.length, 1)
  assert.equal(historyCalls[0].meta.noData, false)
  assert.equal(errors.length, 0)
  datafeed.destroy()
})

test('provider empty and incomplete history settles with noData false', async () => {
  requestKlines = async () => metadata([], {
    cache_status: 'PROVIDER_EMPTY',
    history_incomplete: true,
    history_terminal: false,
    provider_error_code: 'EMPTY',
  })
  const historyCalls: HistoryCall[] = []
  const datafeed = datafeedModule.createSpotTradingViewDatafeed({ symbol: 'BTCUSDT' })

  datafeed.getBars(symbolInfo(), '1', historyPeriod, (bars: any[], meta: { noData?: boolean }) => {
    historyCalls.push({ bars, meta })
  }, assert.fail)
  await waitFor(() => historyCalls.length === 1, 'provider empty history did not settle')

  assert.deepEqual(historyCalls[0].bars, [])
  assert.equal(historyCalls[0].meta.noData, false)
  datafeed.destroy()
})

test('explicit terminal history is the only empty response that reports noData', async () => {
  requestKlines = async () => metadata([], {
    cache_status: 'HISTORY_BOUNDARY',
    history_terminal: true,
    terminal_reason: 'PROVIDER_HISTORY_START',
    earliest_available_time: 1_600_000_000_000,
  })
  const historyCalls: HistoryCall[] = []
  const datafeed = datafeedModule.createSpotTradingViewDatafeed({ symbol: 'BTCUSDT' })

  datafeed.getBars(symbolInfo(), '1', historyPeriod, (bars: any[], meta: { noData?: boolean }) => {
    historyCalls.push({ bars, meta })
  }, assert.fail)
  await waitFor(() => historyCalls.length === 1, 'terminal history did not settle')

  assert.equal(historyCalls[0].meta.noData, true)
  datafeed.destroy()
})

test('permanently missing symbol settles once with noData true', async () => {
  requestKlines = async () => {
    throw Object.assign(new Error('symbol not found'), { code: 'SYMBOL_NOT_FOUND' })
  }
  const historyCalls: HistoryCall[] = []
  const errors: string[] = []
  const datafeed = datafeedModule.createSpotTradingViewDatafeed({ symbol: 'NOTREALUSDT' })

  datafeed.getBars(
    symbolInfo('NOTREALUSDT'),
    '1M',
    { ...currentPeriod, countBack: 329 },
    (bars: any[], meta: { noData?: boolean }) => historyCalls.push({ bars, meta }),
    (reason: string) => errors.push(reason),
  )
  await waitFor(() => historyCalls.length === 1, 'missing symbol did not settle')

  assert.deepEqual(historyCalls, [{ bars: [], meta: { noData: true } }])
  assert.deepEqual(errors, [])
  datafeed.destroy()
})

test('monthly terminal page stops pagination and short-circuits older history', async () => {
  const earliestAvailableTime = Date.UTC(2018, 0, 1)
  const requestParams: Array<Record<string, unknown>> = []
  requestKlines = async (params) => {
    requestParams.push(params)
    if (requestParams.length === 1) {
      return metadata([row(Date.UTC(2021, 0, 1), '102')])
    }
    return metadata([], {
      cache_status: 'HISTORY_BOUNDARY',
      history_terminal: true,
      terminal_reason: 'PROVIDER_HISTORY_BOUNDARY',
      earliest_available_time: earliestAvailableTime,
    })
  }
  const currentCalls: HistoryCall[] = []
  const boundaryCalls: HistoryCall[] = []
  const datafeed = datafeedModule.createSpotTradingViewDatafeed({ symbol: 'BTCUSDT' })

  datafeed.getBars(
    symbolInfo(),
    '1M',
    { ...currentPeriod, countBack: 3 },
    (bars: any[], meta: { noData?: boolean }) => currentCalls.push({ bars, meta }),
    assert.fail,
  )
  await waitFor(() => currentCalls.length === 1, 'monthly current pagination did not settle')

  assert.equal(requestParams.length, 2, 'terminal page must stop the internal pagination loop')
  assert.equal(currentCalls[0].bars.length, 1)
  assert.equal(currentCalls[0].meta.noData, false, 'the current page still returns its available bars')

  datafeed.getBars(
    symbolInfo(),
    '1M',
    {
      from: 0,
      to: earliestAvailableTime / 1000,
      firstDataRequest: false,
      countBack: 1,
    },
    (bars: any[], meta: { noData?: boolean }) => boundaryCalls.push({ bars, meta }),
    assert.fail,
  )
  await waitFor(() => boundaryCalls.length === 1, 'recorded monthly boundary did not settle')

  assert.equal(requestParams.length, 2, 'recorded boundary must avoid another backend request')
  assert.deepEqual(boundaryCalls[0].bars, [])
  assert.equal(boundaryCalls[0].meta.noData, true)
  datafeed.destroy()
})

test('BTCUSDT 1M countBack 300 loads about 100 bars and requests provider boundary once', async () => {
  resetSWRHarness()
  const earliestAvailableTime = Date.UTC(2018, 0, 1)
  const availableRows = Array.from({ length: 100 }, (_, index) => (
    row(Date.UTC(2018, index, 1), String(100 + index))
  ))
  const requestParams: Array<Record<string, unknown>> = []
  requestKlines = async (params) => {
    requestParams.push(params)
    if (requestParams.length === 1) {
      return metadata(availableRows, {
        source: 'REST_SNAPSHOT',
        freshness: 'RECENT',
      })
    }
    return metadata([], {
      cache_status: 'HISTORY_BOUNDARY',
      history_terminal: true,
      terminal_reason: 'PROVIDER_HISTORY_BOUNDARY',
      earliest_available_time: earliestAvailableTime,
    })
  }
  const currentCalls: HistoryCall[] = []
  const boundaryCalls: HistoryCall[] = []
  const datafeed = datafeedModule.createSpotTradingViewDatafeed({ symbol: 'BTCUSDT' })

  datafeed.getBars(
    symbolInfo(),
    '1M',
    { ...currentPeriod, countBack: 300 },
    (bars: any[], meta: { noData?: boolean }) => currentCalls.push({ bars, meta }),
    assert.fail,
  )
  await waitFor(() => currentCalls.length === 1, 'monthly countBack 300 did not settle')

  assert.equal(requestParams.length, 2, 'current history should reach provider boundary once')
  assert.equal(requestParams[0].limit, 300, 'active 1M load should bypass the smaller coarse policy')
  assert.equal(requestParams[1].limit, 200)
  assert.equal(requestParams[1].endTime, earliestAvailableTime)
  assert.equal(currentCalls[0].bars.length, 100)
  assert.equal(currentCalls[0].meta.noData, false)

  datafeed.getBars(
    symbolInfo(),
    '1M',
    {
      from: 0,
      to: earliestAvailableTime / 1000,
      firstDataRequest: false,
      countBack: 1,
    },
    (bars: any[], meta: { noData?: boolean }) => boundaryCalls.push({ bars, meta }),
    assert.fail,
  )
  await waitFor(() => boundaryCalls.length === 1, 'recorded provider boundary did not settle')

  assert.equal(requestParams.length, 2, 'recorded boundary must prevent a duplicate provider request')
  assert.deepEqual(boundaryCalls[0].bars, [])
  assert.equal(boundaryCalls[0].meta.noData, true)
  datafeed.destroy()
  resetSWRHarness()
})

test('BTCUSDT 1M recoverable empty first page waits for the final 102 bars', async () => {
  resetSWRHarness()
  const earliestAvailableTime = Date.UTC(2018, 0, 1)
  const availableRows = Array.from({ length: 102 }, (_, index) => (
    row(Date.UTC(2018, index, 1), String(100 + index))
  ))
  const requestParams: Array<Record<string, unknown>> = []
  requestKlines = async (params) => {
    requestParams.push(params)
    if (requestParams.length === 1) {
      return metadata([], {
        cache_status: 'PROVIDER_EMPTY',
        history_incomplete: true,
        provider_error_code: 'EMPTY',
      })
    }
    if (requestParams.length === 2) {
      return metadata(availableRows, {
        source: 'REST_SNAPSHOT',
        freshness: 'RECENT',
      })
    }
    return metadata([], {
      cache_status: 'HISTORY_BOUNDARY',
      history_terminal: true,
      terminal_reason: 'PROVIDER_HISTORY_BOUNDARY',
      earliest_available_time: earliestAvailableTime,
    })
  }
  const currentCalls: HistoryCall[] = []
  let emptyCallbackCount = 0
  const datafeed = datafeedModule.createSpotTradingViewDatafeed({ symbol: 'BTCUSDT' })

  datafeed.getBars(
    symbolInfo(),
    '1M',
    { ...currentPeriod, countBack: 329 },
    (bars: any[], meta: { noData?: boolean }) => {
      if (bars.length === 0) emptyCallbackCount += 1
      currentCalls.push({ bars, meta })
    },
    assert.fail,
  )
  await waitFor(() => currentCalls.length === 1, 'recoverable monthly current chain did not settle')

  assert.equal(requestParams.length, 3)
  assert.equal(requestParams[0].limit, 329)
  assert.equal(requestParams[1].limit, 329)
  assert.equal(requestParams[1].endTime, undefined)
  assert.equal(requestParams[2].limit, 227)
  assert.equal(requestParams[2].endTime, earliestAvailableTime)
  assert.equal(emptyCallbackCount, 0)
  assert.equal(currentCalls[0].bars.length, 102)
  assert.equal(currentCalls[0].meta.noData, false)
  datafeed.destroy()
  resetSWRHarness()
})

test('BTCUSDT 1M countBack 329 and simultaneous preload share the full page chain', async () => {
  resetSWRHarness()
  const firstPage = deferred<KlineResponse>()
  const boundaryPage = deferred<KlineResponse>()
  const earliestAvailableTime = Date.UTC(2018, 0, 1)
  const availableRows = Array.from({ length: 102 }, (_, index) => (
    row(Date.UTC(2018, index, 1), String(100 + index))
  ))
  const requestParams: Array<Record<string, unknown>> = []
  requestKlines = async (params) => {
    requestParams.push(params)
    return requestParams.length === 1 ? firstPage.promise : boundaryPage.promise
  }
  const currentCalls: HistoryCall[] = []
  const datafeed = datafeedModule.createSpotTradingViewDatafeed({ symbol: 'BTCUSDT' })

  datafeed.getBars(
    symbolInfo(),
    '1M',
    { ...currentPeriod, countBack: 329 },
    (bars: any[], meta: { noData?: boolean }) => currentCalls.push({ bars, meta }),
    assert.fail,
  )
  await waitFor(() => requestParams.length === 1, 'monthly foreground page 1 did not start')

  let preloadProducerCount = 0
  const preload = preloadModule.requestSpotKlineInFlight({
    symbol: 'BTCUSDT',
    interval: '1Mutc',
    requestedBars: 360,
    role: 'preload',
    request: async () => {
      preloadProducerCount += 1
      return { bars: [], revisionCandidates: [] }
    },
  })
  assert.equal(preloadProducerCount, 0)

  firstPage.resolve(metadata(availableRows, { source: 'REST_SNAPSHOT' }))
  await waitFor(() => requestParams.length === 2, 'monthly foreground boundary page did not start')
  assert.equal(preloadProducerCount, 0, 'preload must remain joined through the boundary page')

  boundaryPage.resolve(metadata([], {
    cache_status: 'HISTORY_BOUNDARY',
    history_terminal: true,
    terminal_reason: 'PROVIDER_HISTORY_BOUNDARY',
    earliest_available_time: earliestAvailableTime,
  }))
  const preloadOutcome = await preload
  await waitFor(() => currentCalls.length === 1, 'monthly foreground chain did not settle')

  assert.equal(requestParams.length, 2)
  assert.equal(requestParams[0].limit, 329)
  assert.equal(requestParams[1].limit, 227)
  assert.equal(preloadProducerCount, 0)
  assert.equal(preloadOutcome.joined, true)
  assert.equal(preloadOutcome.startedRequest, false)
  assert.equal(currentCalls[0].bars.length, 102)
  datafeed.destroy()
  resetSWRHarness()
})

test('monthly history follower waits for the current full chain and reuses its terminal boundary', async () => {
  resetSWRHarness()
  const firstPage = deferred<KlineResponse>()
  const boundaryPage = deferred<KlineResponse>()
  const earliestAvailableTime = Date.UTC(2018, 0, 1)
  const availableRows = Array.from({ length: 102 }, (_, index) => (
    row(Date.UTC(2018, index, 1), String(100 + index))
  ))
  const requestParams: Array<Record<string, unknown>> = []
  requestKlines = async (params) => {
    requestParams.push(params)
    return requestParams.length === 1 ? firstPage.promise : boundaryPage.promise
  }
  const currentCalls: HistoryCall[] = []
  const historyCalls: HistoryCall[] = []
  const datafeed = datafeedModule.createSpotTradingViewDatafeed({ symbol: 'BTCUSDT' })

  datafeed.getBars(
    symbolInfo(),
    '1M',
    { ...currentPeriod, countBack: 329 },
    (bars: any[], meta: { noData?: boolean }) => currentCalls.push({ bars, meta }),
    assert.fail,
  )
  await waitFor(() => requestParams.length === 1, 'monthly foreground page 1 did not start')
  datafeed.getBars(
    symbolInfo(),
    '1M',
    {
      from: 0,
      to: earliestAvailableTime / 1000,
      firstDataRequest: false,
      countBack: 227,
    },
    (bars: any[], meta: { noData?: boolean }) => historyCalls.push({ bars, meta }),
    assert.fail,
  )
  await Promise.resolve()
  assert.equal(requestParams.length, 1, 'history follower must wait for the current chain')

  firstPage.resolve(metadata(availableRows, { source: 'REST_SNAPSHOT' }))
  await waitFor(() => requestParams.length === 2, 'monthly boundary page did not start')
  boundaryPage.resolve(metadata([], {
    cache_status: 'HISTORY_BOUNDARY',
    history_terminal: true,
    terminal_reason: 'PROVIDER_HISTORY_BOUNDARY',
    earliest_available_time: earliestAvailableTime,
  }))
  await waitFor(() => currentCalls.length === 1 && historyCalls.length === 1, 'joined monthly calls did not settle')

  assert.equal(requestParams.length, 2, 'history follower must not duplicate the provider boundary')
  assert.equal(currentCalls[0].bars.length, 102)
  assert.deepEqual(historyCalls[0].bars, [])
  assert.equal(historyCalls[0].meta.noData, true)
  datafeed.destroy()
  resetSWRHarness()
})

test('BTCUSDT 1M cache restores terminal boundary and stops older history without REST backfill', async () => {
  resetSWRHarness()
  const bars = Array.from({ length: 100 }, (_, index) => swrBar(Date.UTC(2018, index, 1), 100 + index))
  const revisionCandidates = bars.map((bar, index) => ({
    symbol: 'BTCUSDT',
    interval: '1M',
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
  }))
  const terminalCompleteEntry = {
    key: 'spot:kline:BTCUSDT:1M:360:current',
    symbol: 'BTCUSDT',
    interval: '1M',
    limit: 360,
    requestedLimit: 360,
    returnedCount: bars.length,
    terminalComplete: true,
    historyTerminal: true,
    terminalReason: 'CACHE_HISTORY_BOUNDARY',
    earliestBoundary: bars[0].time,
    bars,
    revisionCandidates,
    provider: 'OKX_SPOT',
    source: 'REST_SNAPSHOT',
    cachedAt: Date.now(),
    updatedAt: Date.now(),
    firstTime: bars[0].time,
    lastTime: bars.at(-1)?.time || null,
  }
  currentCacheLookup = {
    hit: terminalCompleteEntry,
    candidate: terminalCompleteEntry,
    reason: 'hit',
    cacheAgeMs: 0,
    continuityStats: { ...continuity },
    minBars: 60,
    requestedLimit: 300,
  }
  let requestCount = 0
  requestKlines = async () => {
    requestCount += 1
    return metadata([])
  }
  const historyCalls: HistoryCall[] = []
  const datafeed = datafeedModule.createSpotTradingViewDatafeed({ symbol: 'BTCUSDT' })

  datafeed.getBars(
    symbolInfo(),
    '1M',
    { ...currentPeriod, countBack: 300 },
    (loadedBars: any[], meta: { noData?: boolean }) => historyCalls.push({ bars: loadedBars, meta }),
    assert.fail,
  )
  await waitFor(() => historyCalls.length === 1, 'terminal-complete monthly preload did not settle')

  assert.equal(requestCount, 0, 'terminal-complete preload must not start REST backfill')
  assert.equal(historyCalls[0].bars.length, 100)
  assert.equal(historyCalls[0].meta.noData, false)

  datafeed.getBars(
    symbolInfo(),
    '1M',
    { ...historyPeriod, to: Math.floor(bars[0].time / 1000) },
    (loadedBars: any[], meta: { noData?: boolean }) => historyCalls.push({ bars: loadedBars, meta }),
    assert.fail,
  )
  await waitFor(() => historyCalls.length === 2, 'cached monthly boundary did not settle older history')

  assert.equal(requestCount, 0, 'cached monthly boundary must short-circuit before REST')
  assert.deepEqual(historyCalls[1].bars, [])
  assert.equal(historyCalls[1].meta.noData, true)
  datafeed.destroy()
  resetSWRHarness()
})

test('transient empty and timeout responses never create terminal boundary state', async () => {
  let requestCount = 0
  requestKlines = async () => {
    requestCount += 1
    if (requestCount === 1) {
      return metadata([], {
        cache_status: 'PROVIDER_EMPTY',
        history_incomplete: true,
        history_terminal: false,
        provider_error_code: 'EMPTY',
      })
    }
    return metadata([], {
      cache_status: 'TIMEOUT',
      history_incomplete: true,
      history_terminal: false,
      provider_error_code: 'TIMEOUT',
    })
  }
  const historyCalls: HistoryCall[] = []
  const datafeed = datafeedModule.createSpotTradingViewDatafeed({ symbol: 'BTCUSDT' })

  for (const to of [1_600_000_000, 1_500_000_000]) {
    datafeed.getBars(
      symbolInfo(),
      '1M',
      { ...historyPeriod, to },
      (bars: any[], meta: { noData?: boolean }) => historyCalls.push({ bars, meta }),
      assert.fail,
    )
    await waitFor(() => historyCalls.length === requestCount, 'transient history request did not settle')
  }

  assert.equal(requestCount, 2)
  assert.deepEqual(historyCalls.map((call) => call.meta.noData), [false, false])
  datafeed.destroy()
})

test('terminal boundary state is isolated by symbol', async () => {
  const earliestAvailableTime = Date.UTC(2018, 0, 1)
  let requestCount = 0
  requestKlines = async () => {
    requestCount += 1
    return requestCount === 1
      ? metadata([], {
        cache_status: 'HISTORY_BOUNDARY',
        history_terminal: true,
        terminal_reason: 'PROVIDER_HISTORY_BOUNDARY',
        earliest_available_time: earliestAvailableTime,
      })
      : metadata([], {
        cache_status: 'PROVIDER_EMPTY',
        history_incomplete: true,
        provider_error_code: 'EMPTY',
      })
  }
  const btcCalls: HistoryCall[] = []
  const ethCalls: HistoryCall[] = []
  const period = { ...historyPeriod, to: earliestAvailableTime / 1000 }
  const btc = datafeedModule.createSpotTradingViewDatafeed({ symbol: 'BTCUSDT' })
  const eth = datafeedModule.createSpotTradingViewDatafeed({ symbol: 'ETHUSDT' })

  btc.getBars(symbolInfo('BTCUSDT'), '1M', period, (bars: any[], meta: { noData?: boolean }) => {
    btcCalls.push({ bars, meta })
  }, assert.fail)
  await waitFor(() => btcCalls.length === 1, 'BTC terminal response did not settle')

  eth.getBars(symbolInfo('ETHUSDT'), '1M', period, (bars: any[], meta: { noData?: boolean }) => {
    ethCalls.push({ bars, meta })
  }, assert.fail)
  await waitFor(() => ethCalls.length === 1, 'ETH history response did not settle')

  assert.equal(requestCount, 2, 'BTC terminal state must not short-circuit ETH')
  assert.equal(btcCalls[0].meta.noData, true)
  assert.equal(ethCalls[0].meta.noData, false)
  btc.destroy()
  eth.destroy()
})

test('terminal boundary state is isolated by backend interval', async () => {
  const earliestAvailableTime = Date.UTC(2018, 0, 1)
  let requestCount = 0
  requestKlines = async () => {
    requestCount += 1
    return requestCount === 1
      ? metadata([], {
        cache_status: 'HISTORY_BOUNDARY',
        history_terminal: true,
        terminal_reason: 'PROVIDER_HISTORY_BOUNDARY',
        earliest_available_time: earliestAvailableTime,
      })
      : metadata([], {
        cache_status: 'PROVIDER_EMPTY',
        history_incomplete: true,
        provider_error_code: 'EMPTY',
      })
  }
  const historyCalls: HistoryCall[] = []
  const period = { ...historyPeriod, to: earliestAvailableTime / 1000 }
  const datafeed = datafeedModule.createSpotTradingViewDatafeed({ symbol: 'BTCUSDT' })

  datafeed.getBars(symbolInfo(), '1M', period, (bars: any[], meta: { noData?: boolean }) => {
    historyCalls.push({ bars, meta })
  }, assert.fail)
  await waitFor(() => historyCalls.length === 1, 'monthly terminal response did not settle')

  datafeed.getBars(symbolInfo(), '5', period, (bars: any[], meta: { noData?: boolean }) => {
    historyCalls.push({ bars, meta })
  }, assert.fail)
  await waitFor(() => historyCalls.length === 2, '5m history response did not settle')

  assert.equal(requestCount, 2, '1Mutc terminal state must not short-circuit 5m')
  assert.equal(historyCalls[1].meta.noData, false)
  datafeed.destroy()
})

test('destroyed datafeed terminal state cannot affect a replacement instance', async () => {
  const earliestAvailableTime = Date.UTC(2018, 0, 1)
  let requestCount = 0
  requestKlines = async () => {
    requestCount += 1
    return requestCount === 1
      ? metadata([], {
        cache_status: 'HISTORY_BOUNDARY',
        history_terminal: true,
        terminal_reason: 'PROVIDER_HISTORY_BOUNDARY',
        earliest_available_time: earliestAvailableTime,
      })
      : metadata([], {
        cache_status: 'PROVIDER_EMPTY',
        history_incomplete: true,
        provider_error_code: 'EMPTY',
      })
  }
  const period = { ...historyPeriod, to: earliestAvailableTime / 1000 }
  const firstCalls: HistoryCall[] = []
  const replacementCalls: HistoryCall[] = []
  const first = datafeedModule.createSpotTradingViewDatafeed({ symbol: 'BTCUSDT' })

  first.getBars(symbolInfo(), '1M', period, (bars: any[], meta: { noData?: boolean }) => {
    firstCalls.push({ bars, meta })
  }, assert.fail)
  await waitFor(() => firstCalls.length === 1, 'first terminal response did not settle')
  first.destroy()

  const replacement = datafeedModule.createSpotTradingViewDatafeed({ symbol: 'BTCUSDT' })
  replacement.getBars(symbolInfo(), '1M', period, (bars: any[], meta: { noData?: boolean }) => {
    replacementCalls.push({ bars, meta })
  }, assert.fail)
  await waitFor(() => replacementCalls.length === 1, 'replacement history response did not settle')

  assert.equal(requestCount, 2, 'replacement datafeed must not inherit retired terminal state')
  assert.equal(replacementCalls[0].meta.noData, false)
  replacement.destroy()
})

test('intraday current history remains unaffected by terminal boundary support', async () => {
  let requestCount = 0
  requestKlines = async () => {
    requestCount += 1
    return metadata([row(1_717_000_000_000 + requestCount * 60_000, String(100 + requestCount))])
  }
  const historyCalls: HistoryCall[] = []
  const datafeed = datafeedModule.createSpotTradingViewDatafeed({ symbol: 'BTCUSDT' })

  for (const resolution of ['1', '5', '60']) {
    datafeed.getBars(
      symbolInfo(),
      resolution,
      currentPeriod,
      (bars: any[], meta: { noData?: boolean }) => historyCalls.push({ bars, meta }),
      assert.fail,
    )
    await waitFor(() => historyCalls.length === requestCount, `${resolution} current request did not settle`)
  }

  assert.equal(requestCount, 3)
  assert.deepEqual(historyCalls.map((call) => call.meta.noData), [false, false, false])
  assert.deepEqual(historyCalls.map((call) => call.bars.length), [1, 1, 1])
  datafeed.destroy()
})

test('1D and 1W current history still settle with bars', async () => {
  const requestIntervals: string[] = []
  requestKlines = async (params) => {
    requestIntervals.push(String(params.interval))
    return metadata([
      row(
        params.interval === '1Dutc' ? Date.UTC(2026, 6, 10) : Date.UTC(2026, 6, 6),
        params.interval === '1Dutc' ? '201' : '202',
      ),
    ])
  }
  const historyCalls: HistoryCall[] = []
  const datafeed = datafeedModule.createSpotTradingViewDatafeed({ symbol: 'BTCUSDT' })

  for (const resolution of ['1D', '1W']) {
    datafeed.getBars(
      symbolInfo(),
      resolution,
      currentPeriod,
      (bars: any[], meta: { noData?: boolean }) => historyCalls.push({ bars, meta }),
      assert.fail,
    )
    await waitFor(() => historyCalls.length === requestIntervals.length, `${resolution} did not settle`)
  }

  assert.deepEqual(requestIntervals, ['1Dutc', '1Wutc'])
  assert.deepEqual(historyCalls.map((call) => call.bars.length), [1, 1])
  assert.deepEqual(historyCalls.map((call) => call.meta.noData), [false, false])
  datafeed.destroy()
})

test('1M current bars do not report noData or block later history', async () => {
  requestKlines = async () => metadata([row(Date.UTC(2026, 0, 1), '102')])
  const historyCalls: HistoryCall[] = []
  const datafeed = datafeedModule.createSpotTradingViewDatafeed({ symbol: 'BTCUSDT' })

  datafeed.getBars(symbolInfo(), '1M', currentPeriod, (bars: any[], meta: { noData?: boolean }) => {
    historyCalls.push({ bars, meta })
  }, assert.fail)
  await waitFor(() => historyCalls.length === 1, '1M current request did not settle')

  assert.equal(historyCalls[0].bars.length, 1)
  assert.equal(historyCalls[0].meta.noData, false)
  datafeed.destroy()
})

test('same-generation concurrent current requests with different countBack both complete', async () => {
  const first = deferred<KlineResponse>()
  const second = deferred<KlineResponse>()
  let requestCount = 0
  requestKlines = async () => (++requestCount === 1 ? first.promise : second.promise)
  const firstHistory: HistoryCall[] = []
  const secondHistory: HistoryCall[] = []
  const firstErrors: string[] = []
  const datafeed = datafeedModule.createSpotTradingViewDatafeed({ symbol: 'BTCUSDT' })
  const largerCurrentPeriod = { ...currentPeriod, countBack: 2 }

  datafeed.getBars(symbolInfo(), '1', currentPeriod, (bars: any[], meta: { noData?: boolean }) => {
    firstHistory.push({ bars, meta })
  }, (reason: string) => firstErrors.push(reason))
  datafeed.getBars(symbolInfo(), '1', largerCurrentPeriod, (bars: any[], meta: { noData?: boolean }) => {
    secondHistory.push({ bars, meta })
  }, assert.fail)

  first.resolve(metadata([row(1_717_000_000_000, '101')]))
  second.resolve(metadata([
    row(1_717_000_000_000, '101'),
    row(1_717_000_060_000, '103'),
  ]))
  await waitFor(() => firstHistory.length === 1, 'first current request did not settle')
  await waitFor(() => secondHistory.length === 1, 'new request did not settle')
  await Promise.resolve()

  assert.equal(firstHistory.length, 1)
  assert.equal(secondHistory.length, 1)
  assert.equal(firstHistory[0].bars[0].close, 101)
  assert.equal(secondHistory[0].bars.at(-1).close, 103)
  assert.deepEqual(firstErrors, [])
  datafeed.destroy()
})

test('current and history requests in the same generation complete independently', async () => {
  const current = deferred<KlineResponse>()
  const history = deferred<KlineResponse>()
  let requestCount = 0
  requestKlines = async () => (++requestCount === 1 ? current.promise : history.promise)
  const currentCalls: HistoryCall[] = []
  const historyCalls: HistoryCall[] = []
  const datafeed = datafeedModule.createSpotTradingViewDatafeed({ symbol: 'BTCUSDT' })

  datafeed.getBars(symbolInfo(), '1', currentPeriod, (bars: any[], meta: { noData?: boolean }) => {
    currentCalls.push({ bars, meta })
  }, assert.fail)
  datafeed.getBars(symbolInfo(), '1', historyPeriod, (bars: any[], meta: { noData?: boolean }) => {
    historyCalls.push({ bars, meta })
  }, assert.fail)

  history.resolve(metadata([row(1_716_999_940_000, '99')]))
  current.resolve(metadata([row(1_717_000_000_000, '101')]))
  await waitFor(() => currentCalls.length === 1 && historyCalls.length === 1, 'current/history requests did not settle')

  assert.equal(currentCalls[0].bars.length, 1)
  assert.equal(historyCalls[0].bars.length, 1)
  assert.equal(currentCalls[0].meta.noData, false)
  assert.equal(historyCalls[0].meta.noData, false)
  datafeed.destroy()
})

test('1M current keeps accumulated bars when a later backfill page is empty', async () => {
  let requestCount = 0
  requestKlines = async () => {
    requestCount += 1
    if (requestCount === 1) {
      return metadata([
        row(Date.UTC(2026, 4, 1), '100'),
        row(Date.UTC(2026, 5, 1), '101'),
      ])
    }
    if (requestCount === 2) {
      return metadata([row(Date.UTC(2026, 3, 1), '99')])
    }
    return metadata([], {
      cache_status: 'PROVIDER_EMPTY',
      history_incomplete: true,
      provider_error_code: 'EMPTY',
    })
  }
  const historyCalls: HistoryCall[] = []
  const datafeed = datafeedModule.createSpotTradingViewDatafeed({ symbol: 'BTCUSDT' })

  datafeed.getBars(
    symbolInfo(),
    '1M',
    { ...currentPeriod, countBack: 4 },
    (bars: any[], meta: { noData?: boolean }) => historyCalls.push({ bars, meta }),
    assert.fail,
  )
  await waitFor(() => historyCalls.length === 1, '1M current request did not settle')

  assert.equal(requestCount, 3)
  assert.equal(historyCalls[0].bars.length, 3)
  assert.equal(historyCalls[0].meta.noData, false)
  datafeed.destroy()
})

test('identical transient empty history range is suppressed without reporting noData', async () => {
  let requestCount = 0
  requestKlines = async () => {
    requestCount += 1
    return metadata([], {
      cache_status: 'PROVIDER_EMPTY',
      history_incomplete: true,
      provider_error_code: 'EMPTY',
    })
  }
  const firstCalls: HistoryCall[] = []
  const secondCalls: HistoryCall[] = []
  const datafeed = datafeedModule.createSpotTradingViewDatafeed({ symbol: 'BTCUSDT' })

  datafeed.getBars(symbolInfo(), '1', historyPeriod, (bars: any[], meta: { noData?: boolean }) => {
    firstCalls.push({ bars, meta })
  }, assert.fail)
  await waitFor(() => firstCalls.length === 1, 'first empty range did not settle')
  datafeed.getBars(symbolInfo(), '1', historyPeriod, (bars: any[], meta: { noData?: boolean }) => {
    secondCalls.push({ bars, meta })
  }, assert.fail)
  await wait(160)

  assert.equal(requestCount, 1)
  assert.deepEqual(secondCalls, [{ bars: [], meta: { noData: false } }])
  datafeed.destroy()
})

test('changed history cursor clears repeated-range suppression and allows a new request', async () => {
  let requestCount = 0
  requestKlines = async () => {
    requestCount += 1
    return metadata([], {
      cache_status: 'PROVIDER_EMPTY',
      history_incomplete: true,
      provider_error_code: 'EMPTY',
    })
  }
  const firstCalls: HistoryCall[] = []
  const secondCalls: HistoryCall[] = []
  const datafeed = datafeedModule.createSpotTradingViewDatafeed({ symbol: 'BTCUSDT' })

  datafeed.getBars(symbolInfo(), '1', historyPeriod, (bars: any[], meta: { noData?: boolean }) => {
    firstCalls.push({ bars, meta })
  }, assert.fail)
  await waitFor(() => firstCalls.length === 1, 'first cursor did not settle')
  datafeed.getBars(
    symbolInfo(),
    '1',
    { ...historyPeriod, to: historyPeriod.to - 60 },
    (bars: any[], meta: { noData?: boolean }) => secondCalls.push({ bars, meta }),
    assert.fail,
  )
  await waitFor(() => secondCalls.length === 1, 'changed cursor did not settle')

  assert.equal(requestCount, 2)
  assert.equal(secondCalls[0].meta.noData, false)
  datafeed.destroy()
})

test('valid bars clear an empty-range guard entry', () => {
  const guard = new datafeedModule.SpotEmptyRangeGuard()
  const descriptor = {
    generation: 'df:BTCUSDT:1:1m',
    symbol: 'BTCUSDT',
    interval: '1m',
    requestKind: 'history',
    endTime: 2_000_000_000_000,
    countBack: 300,
  }
  const first = guard.inspect(descriptor, 1_000)
  guard.rememberEmpty(first.key, 1_000)
  assert.equal(guard.inspect(descriptor, 1_010).suppressed, true)
  guard.clearAfterBars(first.key, first.dataset)
  assert.equal(guard.inspect(descriptor, 1_020).suppressed, false)
})

test('cross-resolution superseded request settles []/false once', async () => {
  const first = deferred<KlineResponse>()
  const second = deferred<KlineResponse>()
  let requestCount = 0
  requestKlines = async () => (++requestCount === 1 ? first.promise : second.promise)
  const minuteHistory: HistoryCall[] = []
  const dailyHistory: HistoryCall[] = []
  const datafeed = datafeedModule.createSpotTradingViewDatafeed({ symbol: 'BTCUSDT' })

  datafeed.getBars(symbolInfo(), '1', currentPeriod, (bars: any[], meta: { noData?: boolean }) => {
    minuteHistory.push({ bars, meta })
  }, assert.fail)
  datafeed.getBars(symbolInfo(), '1D', currentPeriod, (bars: any[], meta: { noData?: boolean }) => {
    dailyHistory.push({ bars, meta })
  }, assert.fail)

  await waitFor(() => minuteHistory.length === 1, 'cross-resolution superseded request did not settle')
  assert.deepEqual(minuteHistory[0], { bars: [], meta: { noData: false } })
  second.resolve(metadata([row(Date.UTC(2026, 6, 10), '104')]))
  await waitFor(() => dailyHistory.length === 1, 'new resolution request did not settle')
  first.resolve(metadata([row(1_717_000_000_000, '99')]))
  await Promise.resolve()

  assert.equal(minuteHistory.length, 1)
  assert.equal(dailyHistory.length, 1)
  datafeed.destroy()
})

test('destroy silently cancels a late request callback', async () => {
  const pending = deferred<KlineResponse>()
  requestKlines = async () => pending.promise
  const historyCalls: HistoryCall[] = []
  const errors: string[] = []
  const datafeed = datafeedModule.createSpotTradingViewDatafeed({ symbol: 'BTCUSDT' })

  datafeed.getBars(symbolInfo(), '1', currentPeriod, (bars: any[], meta: { noData?: boolean }) => {
    historyCalls.push({ bars, meta })
  }, (reason: string) => errors.push(reason))
  datafeed.destroy()
  pending.resolve(metadata([row()]))
  await Promise.resolve()
  await Promise.resolve()

  assert.deepEqual(historyCalls, [])
  assert.deepEqual(errors, [])
})

test('fatal request error calls only onError exactly once', async () => {
  requestKlines = async () => {
    throw new SyntaxError('Unexpected token in JSON')
  }
  const historyCalls: HistoryCall[] = []
  const errors: string[] = []
  const datafeed = datafeedModule.createSpotTradingViewDatafeed({ symbol: 'BTCUSDT' })

  datafeed.getBars(symbolInfo(), '1', currentPeriod, (bars: any[], meta: { noData?: boolean }) => {
    historyCalls.push({ bars, meta })
  }, (reason: string) => errors.push(reason))
  await waitFor(() => errors.length === 1, 'fatal error did not settle')
  await Promise.resolve()

  assert.deepEqual(historyCalls, [])
  assert.equal(errors.length, 1)
  datafeed.destroy()
})

test('realtime kline metadata is exposed without rewriting provider OHLCV', async () => {
  requestKlines = async () => metadata([row()])
  const datafeedEvents: Array<Record<string, unknown>> = []
  const emittedBars: Array<Record<string, unknown>> = []
  const historyCalls: HistoryCall[] = []
  const datafeed = datafeedModule.createSpotTradingViewDatafeed({
    symbol: 'BTCUSDT',
    onKlineRealtime: (event: Record<string, unknown>) => datafeedEvents.push(event),
  })

  datafeed.getBars(
    symbolInfo(),
    '1',
    currentPeriod,
    (bars: any[], meta: { noData?: boolean }) => historyCalls.push({ bars, meta }),
    assert.fail,
  )
  await waitFor(() => historyCalls.length === 1, 'history setup did not settle')
  datafeed.subscribeBars(symbolInfo(), '1', (bar: Record<string, unknown>) => emittedBars.push(bar), 'display-price-test')
  assert.ok(klineSubscriber, 'kline subscriber was not registered')

  const providerKline = {
    open_time: 1_717_000_120_000,
    open: '101',
    high: '106',
    low: '99',
    close: '105',
    volume: '7',
    quote_volume: '721',
    provider: 'OKX_SPOT',
    source: 'LIVE_WS',
    freshness: 'LIVE',
  }
  const originalKline = { ...providerKline }
  klineSubscriber?.({
    type: 'spot_kline_update',
    symbol: 'BTCUSDT',
    interval: '1m',
    source: 'LIVE_WS',
    freshness: 'LIVE',
    kline: providerKline,
  })

  assert.deepEqual(providerKline, originalKline)
  assert.deepEqual(emittedBars.at(-1), {
    time: 1_717_000_120_000,
    open: 101,
    high: 106,
    low: 99,
    close: 105,
    volume: 7,
  })
  assert.deepEqual(datafeedEvents.at(-1), {
    symbol: 'BTCUSDT',
    interval: '1m',
    reason: 'kline',
    barTime: 1_717_000_120_000,
    close: 105,
    provider: 'OKX_SPOT',
    source: 'LIVE_WS',
    freshness: 'LIVE',
    receivedAtMs: datafeedEvents.at(-1)?.receivedAtMs,
  })
  datafeed.destroy()
  assert.equal(klineSubscriber, null)
})

test('realtime revision guard accepts upgrades and suppresses stale duplicate downgrade and time violation', async () => {
  requestKlines = async () => metadata([row()])
  const emittedBars: Array<Record<string, unknown>> = []
  const historyCalls: HistoryCall[] = []
  const datafeed = datafeedModule.createSpotTradingViewDatafeed({ symbol: 'BTCUSDT' })

  datafeed.getBars(
    symbolInfo(),
    '1',
    currentPeriod,
    (bars: any[], meta: { noData?: boolean }) => historyCalls.push({ bars, meta }),
    assert.fail,
  )
  await waitFor(() => historyCalls.length === 1, 'history setup did not settle')
  datafeed.subscribeBars(symbolInfo(), '1', (bar: Record<string, unknown>) => emittedBars.push(bar), 'revision-test')
  assert.ok(klineSubscriber, 'kline subscriber was not registered')

  const emit = (overrides: Record<string, unknown>) => klineSubscriber?.({
    type: 'spot_kline_update',
    symbol: 'BTCUSDT',
    interval: '1m',
    source: 'LIVE_WS',
    kline: {
      open_time: 1_717_000_120_000,
      open: '101',
      high: '106',
      low: '99',
      close: '101',
      volume: '7',
      provider: 'OKX_SPOT',
      source: 'LIVE_WS',
      revision_epoch: 1,
      revision_seq: 5,
      is_closed: false,
      close_state_source: 'PROVIDER_CONFIRMED',
      ...overrides,
    },
  })

  emit({})
  emit({ revision_seq: 4, close: '99' })
  emit({})
  emit({ revision_seq: 6, close: '102' })
  emit({ revision_seq: 6, close: '102', is_closed: true })
  emit({ revision_seq: 7, close: '102', is_closed: false })
  emit({ open_time: 1_717_000_060_000, revision_seq: 99, close: '88' })

  assert.deepEqual(emittedBars.map((bar) => bar.close), [101, 102, 102])
  datafeed.destroy()
})

test('late REST getBars cannot overwrite newer realtime same-bucket revision', async () => {
  requestKlines = async () => metadata([row()])
  const initialHistory: HistoryCall[] = []
  const datafeed = datafeedModule.createSpotTradingViewDatafeed({ symbol: 'BTCUSDT' })
  datafeed.getBars(
    symbolInfo(),
    '1',
    currentPeriod,
    (bars: any[], meta: { noData?: boolean }) => initialHistory.push({ bars, meta }),
    assert.fail,
  )
  await waitFor(() => initialHistory.length === 1, 'initial history did not settle')
  datafeed.subscribeBars(symbolInfo(), '1', () => undefined, 'rest-race-test')

  const openTime = 1_717_000_120_000
  klineSubscriber?.({
    type: 'spot_kline_update',
    symbol: 'BTCUSDT',
    interval: '1m',
    source: 'LIVE_WS',
    kline: {
      ...row(openTime, '101'),
      provider: 'OKX_SPOT',
      source: 'LIVE_WS',
      revision_epoch: 1,
      revision_seq: 5,
      is_closed: false,
      close_state_source: 'PROVIDER_CONFIRMED',
    },
  })

  requestKlines = async () => metadata([{
    ...row(openTime, '100'),
    revision_epoch: 1,
    revision_seq: 3,
    is_closed: false,
    close_state_source: 'PROVIDER_CONFIRMED',
  }], { provider: 'OKX_SPOT', source: 'REST_SNAPSHOT' })
  const lateRestHistory: HistoryCall[] = []
  datafeed.getBars(
    symbolInfo(),
    '1',
    currentPeriod,
    (bars: any[], meta: { noData?: boolean }) => lateRestHistory.push({ bars, meta }),
    assert.fail,
  )
  await waitFor(() => lateRestHistory.length === 1, 'late REST history did not settle')

  assert.equal(lateRestHistory[0].bars.at(-1)?.close, 101)
  datafeed.destroy()
})

test('subscribeBars exposes readiness evidence when the callback chain is installed', () => {
  const readinessEvents: Array<Record<string, unknown>> = []
  const datafeed = datafeedModule.createSpotTradingViewDatafeed({
    symbol: 'BTCUSDT',
    onRealtimeSubscriptionReady: (evidence: Record<string, unknown>) => readinessEvents.push(evidence),
  })
  const datafeedInstanceId = datafeed.getDatafeedInstanceId()

  datafeed.subscribeBars(symbolInfo(), '1', () => undefined, 'readiness-test')

  assert.equal(readinessEvents.length, 1)
  assert.deepEqual(readinessEvents[0], {
    datafeedInstanceId,
    subscriberUid: 'readiness-test',
    subscriptionGeneration: 1,
    ownerId: `tradingview:BTCUSDT:${datafeedInstanceId}:readiness-test`,
    symbol: 'BTCUSDT',
    interval: '1m',
  })
  assert.deepEqual(
    datafeed.getRealtimeSubscriptionReadiness('BTCUSDT', '1m'),
    readinessEvents[0],
  )

  datafeed.unsubscribeBars('readiness-test')
  assert.equal(datafeed.getRealtimeSubscriptionReadiness('BTCUSDT', '1m'), null)
  datafeed.destroy()
  assert.equal(datafeed.getRealtimeSubscriptionReadiness('BTCUSDT', '1m'), null)
})

test('readiness lookup is dataset-scoped when TradingView reuses an older interval subscription', () => {
  const datafeed = datafeedModule.createSpotTradingViewDatafeed({ symbol: 'BTCUSDT' })

  datafeed.subscribeBars(symbolInfo(), '5', () => undefined, 'five-minute-reuse')
  const fiveMinuteReadiness = datafeed.getRealtimeSubscriptionReadiness('BTCUSDT', '5m')
  assert.equal(fiveMinuteReadiness?.subscriberUid, 'five-minute-reuse')
  assert.equal(fiveMinuteReadiness?.subscriptionGeneration, 1)

  datafeed.subscribeBars(symbolInfo(), '1M', () => undefined, 'monthly-current')
  assert.equal(
    datafeed.getRealtimeSubscriptionReadiness('BTCUSDT', '5m')?.subscriberUid,
    'five-minute-reuse',
  )
  assert.equal(
    datafeed.getRealtimeSubscriptionReadiness('BTCUSDT', '1Mutc')?.subscriberUid,
    'monthly-current',
  )
  assert.equal(
    datafeed.getRealtimeSubscriptionReadiness('BTCUSDT', '1Mutc')?.subscriptionGeneration,
    2,
  )
  assert.deepEqual(datafeed.getActiveRealtimeIntervals().sort(), ['1Mutc', '5m'])

  // TradingView may switch back to an active dataset without calling subscribeBars again.
  assert.deepEqual(
    datafeed.getRealtimeSubscriptionReadiness('BTCUSDT', '5m'),
    fiveMinuteReadiness,
  )

  datafeed.unsubscribeBars('monthly-current')
  assert.equal(datafeed.getRealtimeSubscriptionReadiness('BTCUSDT', '1Mutc'), null)
  assert.equal(
    datafeed.getRealtimeSubscriptionReadiness('BTCUSDT', '5m')?.subscriberUid,
    'five-minute-reuse',
  )
  datafeed.destroy()
  assert.equal(datafeed.getRealtimeSubscriptionReadiness('BTCUSDT', '5m'), null)
})

test('destroy clears instance-scoped realtime high-water before replacement datafeed starts', async () => {
  const highTime = 1_717_000_180_000
  requestKlines = async () => metadata([row(highTime, '110')])
  const firstDatafeed = datafeedModule.createSpotTradingViewDatafeed({ symbol: 'BTCUSDT' })
  const firstHistory: HistoryCall[] = []
  firstDatafeed.getBars(
    symbolInfo(),
    '1',
    currentPeriod,
    (bars: any[], meta: { noData?: boolean }) => firstHistory.push({ bars, meta }),
    assert.fail,
  )
  await waitFor(() => firstHistory.length === 1, 'first instance history did not settle')
  firstDatafeed.destroy()

  const lowerTime = highTime - 60_000
  requestKlines = async () => metadata([row(lowerTime, '100')])
  const emittedBars: Array<Record<string, unknown>> = []
  const replacement = datafeedModule.createSpotTradingViewDatafeed({ symbol: 'BTCUSDT' })
  const replacementHistory: HistoryCall[] = []
  replacement.getBars(
    symbolInfo(),
    '1',
    currentPeriod,
    (bars: any[], meta: { noData?: boolean }) => replacementHistory.push({ bars, meta }),
    assert.fail,
  )
  await waitFor(() => replacementHistory.length === 1, 'replacement history did not settle')
  replacement.subscribeBars(
    symbolInfo(),
    '1',
    (bar: Record<string, unknown>) => emittedBars.push(bar),
    'replacement-high-water',
  )
  klineSubscriber?.({
    type: 'spot_kline_update',
    symbol: 'BTCUSDT',
    interval: '1m',
    source: 'LIVE_WS',
    kline: {
      ...row(lowerTime, '101'),
      provider: 'OKX_SPOT',
      source: 'LIVE_WS',
      revision_epoch: 1,
      revision_seq: 2,
      is_closed: false,
      close_state_source: 'PROVIDER_CONFIRMED',
    },
  })
  assert.deepEqual(emittedBars.map((bar) => bar.close), [101])
  replacement.destroy()
})

test('subscription generation rejects a retired same-uid callback after 1m to 5m to 1m', async () => {
  requestKlines = async () => metadata([row()])
  const emittedBars: Array<Record<string, unknown>> = []
  const readinessEvents: Array<Record<string, unknown>> = []
  const datafeed = datafeedModule.createSpotTradingViewDatafeed({
    symbol: 'BTCUSDT',
    onRealtimeSubscriptionReady: (evidence: Record<string, unknown>) => readinessEvents.push(evidence),
  })

  datafeed.subscribeBars(symbolInfo(), '1', (bar: Record<string, unknown>) => emittedBars.push(bar), 'aba-test')
  const retiredFirstOneMinuteHandler = klineSubscriber
  datafeed.subscribeBars(symbolInfo(), '5', (bar: Record<string, unknown>) => emittedBars.push(bar), 'aba-test')
  datafeed.subscribeBars(symbolInfo(), '1', (bar: Record<string, unknown>) => emittedBars.push(bar), 'aba-test')
  const currentOneMinuteHandler = klineSubscriber

  const historyCalls: HistoryCall[] = []
  datafeed.getBars(
    symbolInfo(),
    '1',
    currentPeriod,
    (bars: any[], meta: { noData?: boolean }) => historyCalls.push({ bars, meta }),
    assert.fail,
  )
  await waitFor(() => historyCalls.length === 1, 'replacement 1m history did not settle')

  const message = {
    type: 'spot_kline_update',
    symbol: 'BTCUSDT',
    interval: '1m',
    kline: {
      ...row(1_717_000_120_000, '105'),
      provider: 'OKX_SPOT',
      revision_epoch: 1,
      revision_seq: 1,
      is_closed: false,
      close_state_source: 'PROVIDER_CONFIRMED',
    },
  }
  retiredFirstOneMinuteHandler?.(message)
  assert.equal(emittedBars.length, 0)
  currentOneMinuteHandler?.(message)
  assert.deepEqual(emittedBars.map((bar) => bar.close), [105])
  assert.deepEqual(readinessEvents.map((event) => event.subscriptionGeneration), [1, 2, 3])
  assert.equal(
    datafeed.getRealtimeSubscriptionReadiness('BTCUSDT', '1m')?.subscriptionGeneration,
    3,
  )
  datafeed.destroy()
})

test('interval switch and destroy make retired realtime callbacks harmless', async () => {
  requestKlines = async () => metadata([row()])
  const historyCalls: HistoryCall[] = []
  const emittedBars: Array<Record<string, unknown>> = []
  const datafeed = datafeedModule.createSpotTradingViewDatafeed({ symbol: 'BTCUSDT' })
  datafeed.getBars(
    symbolInfo(),
    '1',
    currentPeriod,
    (bars: any[], meta: { noData?: boolean }) => historyCalls.push({ bars, meta }),
    assert.fail,
  )
  await waitFor(() => historyCalls.length === 1, 'history setup did not settle')
  datafeed.subscribeBars(symbolInfo(), '1', (bar: Record<string, unknown>) => emittedBars.push(bar), 'switch-test')
  const retiredOneMinuteHandler = klineSubscriber

  datafeed.subscribeBars(symbolInfo(), '5', (bar: Record<string, unknown>) => emittedBars.push(bar), 'switch-test')
  retiredOneMinuteHandler?.({
    type: 'spot_kline_update',
    symbol: 'BTCUSDT',
    interval: '1m',
    kline: { ...row(1_717_000_120_000, '99'), revision_epoch: 1, revision_seq: 99 },
  })
  assert.deepEqual(emittedBars, [])

  const retiredFiveMinuteHandler = klineSubscriber
  datafeed.destroy()
  retiredFiveMinuteHandler?.({
    type: 'spot_kline_update',
    symbol: 'BTCUSDT',
    interval: '5m',
    kline: { ...row(1_717_000_400_000, '105'), revision_epoch: 1, revision_seq: 1 },
  })
  assert.deepEqual(emittedBars, [])
  assert.equal(klineSubscriber, null)
})

test('symbol switch destroys old revision state and accepts the new symbol independently', async () => {
  requestKlines = async () => metadata([row()])
  const btcHistory: HistoryCall[] = []
  const btc = datafeedModule.createSpotTradingViewDatafeed({ symbol: 'BTCUSDT' })
  btc.getBars(
    symbolInfo('BTCUSDT'),
    '1',
    currentPeriod,
    (bars: any[], meta: { noData?: boolean }) => btcHistory.push({ bars, meta }),
    assert.fail,
  )
  await waitFor(() => btcHistory.length === 1, 'BTC history did not settle')
  btc.subscribeBars(symbolInfo('BTCUSDT'), '1', () => undefined, 'symbol-test')
  const retiredBtcHandler = klineSubscriber
  btc.destroy()

  const ethHistory: HistoryCall[] = []
  const ethBars: Array<Record<string, unknown>> = []
  const eth = datafeedModule.createSpotTradingViewDatafeed({ symbol: 'ETHUSDT' })
  eth.getBars(
    symbolInfo('ETHUSDT'),
    '1',
    currentPeriod,
    (bars: any[], meta: { noData?: boolean }) => ethHistory.push({ bars, meta }),
    assert.fail,
  )
  await waitFor(() => ethHistory.length === 1, 'ETH history did not settle')
  eth.subscribeBars(symbolInfo('ETHUSDT'), '1', (bar: Record<string, unknown>) => ethBars.push(bar), 'symbol-test')

  retiredBtcHandler?.({
    type: 'spot_kline_update',
    symbol: 'BTCUSDT',
    interval: '1m',
    kline: { ...row(1_717_000_120_000, '999'), revision_epoch: 99, revision_seq: 99 },
  })
  klineSubscriber?.({
    type: 'spot_kline_update',
    symbol: 'ETHUSDT',
    interval: '1m',
    kline: {
      ...row(1_717_000_120_000, '105'),
      provider: 'OKX_SPOT',
      revision_epoch: 1,
      revision_seq: 1,
      is_closed: false,
      close_state_source: 'PROVIDER_CONFIRMED',
    },
  })

  assert.deepEqual(ethBars.map((bar) => bar.close), [105])
  eth.destroy()
})

function swrBar(time: number, close = 101) {
  return {
    time,
    open: 100,
    high: Math.max(102, close),
    low: 99,
    close,
    volume: 10,
  }
}

function swrCandidate(
  time: number,
  overrides: Record<string, unknown> = {},
) {
  const bar = (overrides.bar as Record<string, unknown> | undefined) || swrBar(time)
  return {
    symbol: 'BTCUSDT',
    interval: '1m',
    openTime: time,
    bar,
    provider: 'OKX_SPOT',
    source: 'REST_SNAPSHOT',
    revision: {
      revisionEpoch: 1,
      revisionSeq: 1,
      isClosed: true,
      closeStateSource: 'PROVIDER_CONFIRMED',
    },
    ...overrides,
  }
}

function swrCacheEntry(overrides: Record<string, unknown> = {}) {
  const currentBucket = Math.floor(Date.now() / 60_000) * 60_000
  const bars = (overrides.bars as Array<Record<string, unknown>> | undefined) || [
    swrBar(currentBucket - 60_000),
  ]
  const revisionCandidates = (
    overrides.revisionCandidates as Array<Record<string, unknown>> | undefined
  ) || bars.map((bar) => swrCandidate(Number(bar.time), { bar }))
  return {
    key: 'spot:kline:BTCUSDT:1m:1:current',
    symbol: 'BTCUSDT',
    interval: '1m',
    limit: bars.length,
    requestedLimit: bars.length,
    returnedCount: bars.length,
    terminalComplete: false,
    bars,
    revisionCandidates,
    provider: 'OKX_SPOT',
    source: 'REST_SNAPSHOT',
    cachedAt: Date.now() - 31_000,
    updatedAt: Date.now() - 31_000,
    firstTime: Number(bars[0]?.time || 0),
    lastTime: Number(bars.at(-1)?.time || 0),
    ...overrides,
  }
}

function useExpiredCache(entry = swrCacheEntry()) {
  currentCacheLookup = {
    hit: null,
    candidate: entry,
    reason: 'expired',
    cacheAgeMs: 31_000,
    continuityStats: { ...continuity },
    minBars: 1,
    requestedLimit: 1,
  }
  return entry
}

function resetSWRHarness() {
  preloadModule.resetSpotKlineInFlightRegistryForTests()
  currentCacheLookup = null
  cacheWriteCalls.length = 0
  requestKlines = async () => ({ items: [] })
  klineSubscriber = null
}

function versionedRow(openTime: number, close: string, overrides: Record<string, unknown> = {}) {
  return {
    ...row(openTime, close),
    revision_epoch: 1,
    revision_seq: 2,
    is_closed: true,
    close_state_source: 'PROVIDER_CONFIRMED',
    ...overrides,
  }
}

test('expired eligible cache returns immediately once while slow REST revalidates in background', async () => {
  resetSWRHarness()
  const staleEntry = useExpiredCache()
  const pending = deferred<KlineResponse>()
  let requestCount = 0
  requestKlines = async () => {
    requestCount += 1
    return pending.promise
  }
  const historyCalls: HistoryCall[] = []
  const datafeed = datafeedModule.createSpotTradingViewDatafeed({ symbol: 'BTCUSDT' })

  datafeed.getBars(symbolInfo(), '1', currentPeriod, (bars: any[], meta: { noData?: boolean }) => {
    historyCalls.push({ bars, meta })
  }, assert.fail)

  assert.equal(historyCalls.length, 1, 'stale callback should not wait for REST')
  assert.equal(historyCalls[0].bars[0].close, staleEntry.bars[0].close)
  assert.equal(requestCount, 1)
  assert.equal(cacheWriteCalls.length, 0)

  pending.resolve(metadata([
    versionedRow(Number(staleEntry.bars[0].time), '102'),
  ], { provider: 'OKX_SPOT', source: 'REST_SNAPSHOT' }))
  await waitFor(() => cacheWriteCalls.length === 1, 'background revalidate did not update cache')

  assert.equal(historyCalls.length, 1, 'fresh revalidate must not callback old getBars again')
  assert.equal(cacheWriteCalls[0].bars[0].close, 102)
  datafeed.destroy()
  resetSWRHarness()
})

test('failed SWR revalidate preserves stale response and has no chart side effect', async () => {
  resetSWRHarness()
  const staleEntry = useExpiredCache()
  requestKlines = async () => {
    throw new Error('provider timeout')
  }
  const historyCalls: HistoryCall[] = []
  const errors: string[] = []
  const datafeed = datafeedModule.createSpotTradingViewDatafeed({ symbol: 'BTCUSDT' })

  datafeed.getBars(symbolInfo(), '1', currentPeriod, (bars: any[], meta: { noData?: boolean }) => {
    historyCalls.push({ bars, meta })
  }, (reason: string) => errors.push(reason))
  await wait(0)

  assert.equal(historyCalls.length, 1)
  assert.deepEqual(errors, [])
  assert.equal(cacheWriteCalls.length, 0)
  assert.equal(staleEntry.updatedAt, staleEntry.cachedAt)
  datafeed.destroy()
  resetSWRHarness()
})

test('SWR revalidate keeps newer closed WS revision over later reopening REST', async () => {
  resetSWRHarness()
  const currentBucket = Math.floor(Date.now() / 60_000) * 60_000
  requestKlines = async () => metadata([
    versionedRow(currentBucket, '100', { revision_seq: 1, is_closed: false }),
  ], { provider: 'OKX_SPOT', source: 'REST_SNAPSHOT' })
  const initialHistory: HistoryCall[] = []
  const datafeed = datafeedModule.createSpotTradingViewDatafeed({ symbol: 'BTCUSDT' })
  datafeed.getBars(symbolInfo(), '1', currentPeriod, (bars: any[], meta: { noData?: boolean }) => {
    initialHistory.push({ bars, meta })
  }, assert.fail)
  await waitFor(() => initialHistory.length === 1, 'initial history did not settle')
  datafeed.subscribeBars(symbolInfo(), '1', () => undefined, 'swr-revision-test')
  klineSubscriber?.({
    type: 'spot_kline_update',
    symbol: 'BTCUSDT',
    interval: '1m',
    source: 'LIVE_WS',
    kline: {
      ...versionedRow(currentBucket, '105', { revision_seq: 5, is_closed: true }),
      provider: 'OKX_SPOT',
      source: 'LIVE_WS',
    },
  })

  cacheWriteCalls.length = 0
  useExpiredCache(swrCacheEntry({
    bars: [swrBar(currentBucket - 60_000, 99)],
    revisionCandidates: [swrCandidate(currentBucket - 60_000, {
      bar: swrBar(currentBucket - 60_000, 99),
    })],
  }))
  const pending = deferred<KlineResponse>()
  requestKlines = async () => pending.promise
  const staleHistory: HistoryCall[] = []
  datafeed.getBars(symbolInfo(), '1', currentPeriod, (bars: any[], meta: { noData?: boolean }) => {
    staleHistory.push({ bars, meta })
  }, assert.fail)
  assert.equal(staleHistory.length, 1)

  pending.resolve(metadata([
    versionedRow(currentBucket, '98', { revision_seq: 6, is_closed: false }),
  ], { provider: 'OKX_SPOT', source: 'REST_SNAPSHOT' }))
  await waitFor(() => cacheWriteCalls.length === 1, 'revision-aware refresh was not stored')

  assert.equal(cacheWriteCalls[0].bars[0].close, 105)
  assert.equal(cacheWriteCalls[0].revisionCandidates[0].revision.revisionSeq, 5)
  assert.equal(cacheWriteCalls[0].revisionCandidates[0].revision.isClosed, true)
  datafeed.destroy()
  resetSWRHarness()
})

test('SWR history excludes forming candle and realtime subscription maintains it', async () => {
  resetSWRHarness()
  const currentBucket = Math.floor(Date.now() / 60_000) * 60_000
  const closed = swrBar(currentBucket - 60_000, 100)
  const forming = swrBar(currentBucket, 101)
  useExpiredCache(swrCacheEntry({
    bars: [closed, forming],
    revisionCandidates: [
      swrCandidate(closed.time, { bar: closed }),
      swrCandidate(forming.time, {
        bar: forming,
        revision: {
          revisionEpoch: 1,
          revisionSeq: 2,
          isClosed: false,
          closeStateSource: 'PROVIDER_CONFIRMED',
        },
      }),
    ],
  }))
  const pending = deferred<KlineResponse>()
  requestKlines = async () => pending.promise
  const historyCalls: HistoryCall[] = []
  const realtimeBars: Array<Record<string, unknown>> = []
  const datafeed = datafeedModule.createSpotTradingViewDatafeed({ symbol: 'BTCUSDT' })

  datafeed.getBars(symbolInfo(), '1', currentPeriod, (bars: any[], meta: { noData?: boolean }) => {
    historyCalls.push({ bars, meta })
  }, assert.fail)
  assert.deepEqual(historyCalls[0].bars.map((bar) => bar.time), [closed.time])

  datafeed.subscribeBars(symbolInfo(), '1', (bar: Record<string, unknown>) => realtimeBars.push(bar), 'swr-forming-test')
  klineSubscriber?.({
    type: 'spot_kline_update',
    symbol: 'BTCUSDT',
    interval: '1m',
    source: 'LIVE_WS',
    kline: {
      ...versionedRow(forming.time, '103', { revision_seq: 3, is_closed: false }),
      provider: 'OKX_SPOT',
      source: 'LIVE_WS',
    },
  })
  assert.deepEqual(realtimeBars.map((bar) => bar.close), [103])

  datafeed.destroy()
  pending.resolve(metadata([versionedRow(forming.time, '103')]))
  await Promise.resolve()
  resetSWRHarness()
})

test('resolution switch retires old SWR refresh before it can write or callback', async () => {
  resetSWRHarness()
  useExpiredCache()
  const oneMinutePending = deferred<KlineResponse>()
  let requestCount = 0
  requestKlines = async () => {
    requestCount += 1
    if (requestCount === 1) return oneMinutePending.promise
    return metadata([versionedRow(Math.floor(Date.now() / 300_000) * 300_000, '200')])
  }
  const minuteHistory: HistoryCall[] = []
  const fiveMinuteHistory: HistoryCall[] = []
  const datafeed = datafeedModule.createSpotTradingViewDatafeed({ symbol: 'BTCUSDT' })
  datafeed.getBars(symbolInfo(), '1', currentPeriod, (bars: any[], meta: { noData?: boolean }) => {
    minuteHistory.push({ bars, meta })
  }, assert.fail)
  assert.equal(minuteHistory.length, 1)

  currentCacheLookup = null
  datafeed.getBars(symbolInfo(), '5', currentPeriod, (bars: any[], meta: { noData?: boolean }) => {
    fiveMinuteHistory.push({ bars, meta })
  }, assert.fail)
  await waitFor(() => fiveMinuteHistory.length === 1, '5m request did not settle')
  cacheWriteCalls.length = 0

  oneMinutePending.resolve(metadata([versionedRow(Math.floor(Date.now() / 60_000) * 60_000, '999')]))
  await wait(0)

  assert.equal(minuteHistory.length, 1)
  assert.equal(cacheWriteCalls.length, 0)
  datafeed.destroy()
  resetSWRHarness()
})

test('destroy retires pending SWR refresh without a second callback or cache write', async () => {
  resetSWRHarness()
  useExpiredCache()
  const pending = deferred<KlineResponse>()
  requestKlines = async () => pending.promise
  const historyCalls: HistoryCall[] = []
  const datafeed = datafeedModule.createSpotTradingViewDatafeed({ symbol: 'BTCUSDT' })
  datafeed.getBars(symbolInfo(), '1', currentPeriod, (bars: any[], meta: { noData?: boolean }) => {
    historyCalls.push({ bars, meta })
  }, assert.fail)
  assert.equal(historyCalls.length, 1)

  datafeed.destroy()
  pending.resolve(metadata([versionedRow(Math.floor(Date.now() / 60_000) * 60_000, '999')]))
  await wait(0)

  assert.equal(historyCalls.length, 1)
  assert.equal(cacheWriteCalls.length, 0)
  resetSWRHarness()
})

test('history pagination never uses SWR fast path', async () => {
  resetSWRHarness()
  useExpiredCache()
  const pending = deferred<KlineResponse>()
  requestKlines = async () => pending.promise
  const historyCalls: HistoryCall[] = []
  const datafeed = datafeedModule.createSpotTradingViewDatafeed({ symbol: 'BTCUSDT' })

  datafeed.getBars(symbolInfo(), '1', historyPeriod, (bars: any[], meta: { noData?: boolean }) => {
    historyCalls.push({ bars, meta })
  }, assert.fail)
  assert.equal(historyCalls.length, 0)

  pending.resolve(metadata([versionedRow(1_717_000_000_000, '101')]))
  await waitFor(() => historyCalls.length === 1, 'history pagination did not settle through REST')
  datafeed.destroy()
  resetSWRHarness()
})

test('fresh cache keeps the existing immediate hit behavior without SWR REST', () => {
  resetSWRHarness()
  const freshEntry = swrCacheEntry({
    cachedAt: Date.now(),
    updatedAt: Date.now(),
    terminalComplete: true,
  })
  currentCacheLookup = {
    hit: freshEntry,
    candidate: freshEntry,
    reason: 'hit',
    cacheAgeMs: 0,
    continuityStats: { ...continuity },
    minBars: 1,
    requestedLimit: 1,
  }
  let requestCount = 0
  requestKlines = async () => {
    requestCount += 1
    return metadata([])
  }
  const historyCalls: HistoryCall[] = []
  const datafeed = datafeedModule.createSpotTradingViewDatafeed({ symbol: 'BTCUSDT' })

  datafeed.getBars(symbolInfo(), '1', currentPeriod, (bars: any[], meta: { noData?: boolean }) => {
    historyCalls.push({ bars, meta })
  }, assert.fail)

  assert.equal(historyCalls.length, 1)
  assert.equal(requestCount, 0)
  datafeed.destroy()
  resetSWRHarness()
})

test('two current getBars requests for the same symbol and interval share one in-flight REST request', async () => {
  resetSWRHarness()
  const pending = deferred<KlineResponse>()
  let requestCount = 0
  requestKlines = async () => {
    requestCount += 1
    return pending.promise
  }
  const firstHistory: HistoryCall[] = []
  const secondHistory: HistoryCall[] = []
  const datafeed = datafeedModule.createSpotTradingViewDatafeed({ symbol: 'BTCUSDT' })

  datafeed.getBars(symbolInfo(), '1', currentPeriod, (bars: any[], meta: { noData?: boolean }) => {
    firstHistory.push({ bars, meta })
  }, assert.fail)
  datafeed.getBars(symbolInfo(), '1', currentPeriod, (bars: any[], meta: { noData?: boolean }) => {
    secondHistory.push({ bars, meta })
  }, assert.fail)

  assert.equal(requestCount, 1)
  pending.resolve(metadata([versionedRow(1_717_000_000_000, '104')]))
  await waitFor(
    () => firstHistory.length === 1 && secondHistory.length === 1,
    'joined current requests did not both settle',
  )

  assert.equal(requestCount, 1)
  assert.equal(firstHistory[0].bars[0].close, 104)
  assert.equal(secondHistory[0].bars[0].close, 104)
  datafeed.destroy()
  resetSWRHarness()
})

test('SWR revalidate and preload role join the same symbol interval request', async () => {
  resetSWRHarness()
  useExpiredCache()
  const pending = deferred<KlineResponse>()
  let requestCount = 0
  requestKlines = async () => {
    requestCount += 1
    return pending.promise
  }
  const historyCalls: HistoryCall[] = []
  const datafeed = datafeedModule.createSpotTradingViewDatafeed({ symbol: 'BTCUSDT' })
  datafeed.getBars(symbolInfo(), '1', currentPeriod, (bars: any[], meta: { noData?: boolean }) => {
    historyCalls.push({ bars, meta })
  }, assert.fail)
  assert.equal(historyCalls.length, 1)

  let preloadFallbackCount = 0
  const preloadJoin = preloadModule.requestSpotKlineInFlight({
    symbol: 'BTCUSDT',
    interval: '1m',
    requestedBars: 1,
    role: 'preload',
    request: async () => {
      preloadFallbackCount += 1
      return { bars: [], revisionCandidates: [] }
    },
  })
  assert.equal(requestCount, 1)
  assert.equal(preloadFallbackCount, 0)

  pending.resolve(metadata([versionedRow(1_717_000_000_000, '105')]))
  const joined = await preloadJoin
  await waitFor(() => cacheWriteCalls.length === 1, 'SWR refresh did not complete')

  assert.equal(joined.joined, true)
  assert.equal(joined.startedRequest, false)
  assert.equal(preloadFallbackCount, 0)
  assert.equal(requestCount, 1)
  datafeed.destroy()
  resetSWRHarness()
})

test('hung 1m request times out once and does not prevent a later 5m load', async () => {
  resetSWRHarness()
  const retiredMinute = deferred<KlineResponse>()
  let requestCount = 0
  requestKlines = async (params) => {
    requestCount += 1
    if (params.interval === '1m') return retiredMinute.promise
    return metadata([versionedRow(1_717_000_000_000, '205')])
  }
  const minuteHistory: HistoryCall[] = []
  const fiveMinuteHistory: HistoryCall[] = []
  const errors: string[] = []
  const datafeed = datafeedModule.createSpotTradingViewDatafeed({
    symbol: 'BTCUSDT',
    inFlightDeadlineMs: { active: 10 },
  })

  datafeed.getBars(symbolInfo(), '1', currentPeriod, (bars: any[], meta: { noData?: boolean }) => {
    minuteHistory.push({ bars, meta })
  }, (reason: string) => errors.push(reason))
  await wait(20)

  assert.equal(minuteHistory.length, 0)
  assert.equal(errors.length, 1)

  datafeed.getBars(symbolInfo(), '5', currentPeriod, (bars: any[], meta: { noData?: boolean }) => {
    fiveMinuteHistory.push({ bars, meta })
  }, (reason: string) => errors.push(reason))
  await waitFor(() => fiveMinuteHistory.length === 1, '5m request did not load after 1m timeout')

  assert.equal(requestCount, 2)
  assert.equal(fiveMinuteHistory[0].bars[0].close, 205)
  const writesBeforeLateResult = cacheWriteCalls.length
  datafeed.destroy()
  retiredMinute.resolve(metadata([versionedRow(1_717_000_000_000, '999')]))
  await wait(0)

  assert.equal(minuteHistory.length, 0)
  assert.equal(fiveMinuteHistory.length, 1)
  assert.equal(cacheWriteCalls.length, writesBeforeLateResult)
  resetSWRHarness()
})

test('normal getBars completion clears its settle watchdog', async () => {
  resetSWRHarness()
  requestKlines = async () => metadata([versionedRow(1_717_000_000_000, '106')])
  const historyCalls: HistoryCall[] = []
  const datafeed = datafeedModule.createSpotTradingViewDatafeed({
    symbol: 'BTCUSDT',
    getBarsWatchdogMs: 10,
  })

  datafeed.getBars(symbolInfo(), '1', currentPeriod, (bars: any[], meta: { noData?: boolean }) => {
    historyCalls.push({ bars, meta })
  }, assert.fail)
  await waitFor(() => historyCalls.length === 1, 'normal getBars did not settle')
  await wait(20)

  assert.equal(historyCalls.length, 1)
  assert.equal(historyCalls[0].bars[0].close, 106)
  datafeed.destroy()
  resetSWRHarness()
})

test('getBars soft watchdog records slowness without injecting empty history', async () => {
  resetSWRHarness()
  const retiredMinute = deferred<KlineResponse>()
  requestKlines = async (params) => (
    params.interval === '1m'
      ? retiredMinute.promise
      : metadata([versionedRow(1_717_000_000_000, '207')])
  )
  const minuteHistory: HistoryCall[] = []
  const fiveMinuteHistory: HistoryCall[] = []
  const errors: string[] = []
  const datafeed = datafeedModule.createSpotTradingViewDatafeed({
    symbol: 'BTCUSDT',
    getBarsWatchdogMs: 10,
    getBarsHardTimeoutMs: 100,
    inFlightDeadlineMs: { active: 100 },
  })

  datafeed.getBars(symbolInfo(), '1', currentPeriod, (bars: any[], meta: { noData?: boolean }) => {
    minuteHistory.push({ bars, meta })
  }, (reason: string) => errors.push(reason))
  await wait(20)
  assert.deepEqual(minuteHistory, [])
  assert.equal(errors.length, 0)

  datafeed.getBars(symbolInfo(), '5', currentPeriod, (bars: any[], meta: { noData?: boolean }) => {
    fiveMinuteHistory.push({ bars, meta })
  }, (reason: string) => errors.push(reason))
  await waitFor(() => fiveMinuteHistory.length === 1, '5m did not settle after 1m watchdog')
  assert.equal(fiveMinuteHistory[0].bars[0].close, 207)

  retiredMinute.resolve(metadata([versionedRow(1_717_000_000_000, '999')]))
  await wait(0)
  assert.equal(minuteHistory.length, 1)
  datafeed.destroy()
  resetSWRHarness()
})

test('default 4.25s watchdog leaves history callback untouched after the soft deadline', async () => {
  resetSWRHarness()
  const pending = deferred<KlineResponse>()
  requestKlines = async () => pending.promise
  const historyCalls: HistoryCall[] = []
  const errors: string[] = []
  const datafeed = datafeedModule.createSpotTradingViewDatafeed({
    symbol: 'BTCUSDT',
    getBarsHardTimeoutMs: 6_000,
    inFlightDeadlineMs: { active: 7_000 },
  })

  datafeed.getBars(symbolInfo(), '1M', { ...currentPeriod, countBack: 329 }, (
    bars: any[],
    meta: { noData?: boolean },
  ) => {
    historyCalls.push({ bars, meta })
  }, (reason: string) => errors.push(reason))
  await wait(4_350)

  assert.equal(historyCalls.length, 0)
  assert.equal(errors.length, 0)

  pending.resolve(metadata([versionedRow(Date.UTC(2026, 6, 1), '208')]))
  await waitFor(() => historyCalls.length === 1, 'request did not settle after the soft deadline')
  assert.equal(errors.length, 0)
  datafeed.destroy()
  resetSWRHarness()
})

test('getBars hard timeout calls onError without an empty history callback', async () => {
  resetSWRHarness()
  const pending = deferred<KlineResponse>()
  requestKlines = async () => pending.promise
  const historyCalls: HistoryCall[] = []
  const errors: string[] = []
  const datafeed = datafeedModule.createSpotTradingViewDatafeed({
    symbol: 'BTCUSDT',
    getBarsWatchdogMs: 10,
    getBarsHardTimeoutMs: 30,
    inFlightDeadlineMs: { active: 100 },
  })

  datafeed.getBars(symbolInfo(), '1', currentPeriod, (bars: any[], meta: { noData?: boolean }) => {
    historyCalls.push({ bars, meta })
  }, (reason: string) => errors.push(reason))
  await wait(20)

  assert.equal(historyCalls.length, 0, 'soft timeout must not call historyCallback')
  assert.equal(errors.length, 0)
  await wait(20)
  assert.equal(historyCalls.length, 0)
  assert.deepEqual(errors, ['Kline history request timed out'])

  pending.resolve(metadata([versionedRow(1_717_000_000_000, '999')]))
  await wait(0)
  assert.equal(historyCalls.length, 0)
  assert.equal(errors.length, 1)
  datafeed.destroy()
  resetSWRHarness()
})

test('in-flight timeout settles through onError and clears the longer getBars watchdog', async () => {
  resetSWRHarness()
  const pending = deferred<KlineResponse>()
  requestKlines = async () => pending.promise
  const historyCalls: HistoryCall[] = []
  const errors: string[] = []
  const datafeed = datafeedModule.createSpotTradingViewDatafeed({
    symbol: 'BTCUSDT',
    getBarsWatchdogMs: 40,
    inFlightDeadlineMs: { active: 10 },
  })

  datafeed.getBars(symbolInfo(), '1', currentPeriod, (bars: any[], meta: { noData?: boolean }) => {
    historyCalls.push({ bars, meta })
  }, (reason: string) => errors.push(reason))
  await wait(55)

  assert.deepEqual(historyCalls, [])
  assert.equal(errors.length, 1)
  datafeed.destroy()
  pending.resolve(metadata([versionedRow(1_717_000_000_000, '999')]))
  await wait(0)
  resetSWRHarness()
})

test('callback exception marks the token settled before the watchdog can fire', async () => {
  resetSWRHarness()
  requestKlines = async () => metadata([versionedRow(1_717_000_000_000, '108')])
  let callbackCount = 0
  const datafeed = datafeedModule.createSpotTradingViewDatafeed({
    symbol: 'BTCUSDT',
    getBarsWatchdogMs: 10,
  })

  datafeed.getBars(symbolInfo(), '1', currentPeriod, () => {
    callbackCount += 1
    throw new Error('consumer callback failure')
  }, assert.fail)
  await wait(25)

  assert.equal(callbackCount, 1)
  datafeed.destroy()
  resetSWRHarness()
})

test('concurrent getBars tokens stay pending after independent soft watchdogs', async () => {
  resetSWRHarness()
  const pending = deferred<KlineResponse>()
  requestKlines = async () => pending.promise
  const firstHistory: HistoryCall[] = []
  const secondHistory: HistoryCall[] = []
  const datafeed = datafeedModule.createSpotTradingViewDatafeed({
    symbol: 'BTCUSDT',
    getBarsWatchdogMs: 10,
    getBarsHardTimeoutMs: 100,
    inFlightDeadlineMs: { active: 100 },
  })

  datafeed.getBars(symbolInfo(), '1', currentPeriod, (bars: any[], meta: { noData?: boolean }) => {
    firstHistory.push({ bars, meta })
  }, assert.fail)
  datafeed.getBars(symbolInfo(), '1', currentPeriod, (bars: any[], meta: { noData?: boolean }) => {
    secondHistory.push({ bars, meta })
  }, assert.fail)
  await wait(20)

  assert.deepEqual(firstHistory, [])
  assert.deepEqual(secondHistory, [])
  pending.resolve(metadata([versionedRow(1_717_000_000_000, '999')]))
  await waitFor(() => firstHistory.length === 1 && secondHistory.length === 1, 'joined requests did not settle')
  datafeed.destroy()
  resetSWRHarness()
})

test('destroy clears getBars watchdog and SWR foreground settlement does not re-fire', async () => {
  resetSWRHarness()
  const pending = deferred<KlineResponse>()
  requestKlines = async () => pending.promise
  const noCallbackHistory: HistoryCall[] = []
  const destroyedDatafeed = datafeedModule.createSpotTradingViewDatafeed({
    symbol: 'BTCUSDT',
    getBarsWatchdogMs: 10,
    inFlightDeadlineMs: { active: 100 },
  })
  destroyedDatafeed.getBars(symbolInfo(), '1', currentPeriod, (bars: any[], meta: { noData?: boolean }) => {
    noCallbackHistory.push({ bars, meta })
  }, assert.fail)
  destroyedDatafeed.destroy()
  await wait(20)
  assert.equal(noCallbackHistory.length, 0)
  pending.resolve(metadata([versionedRow(1_717_000_000_000, '999')]))
  await wait(0)
  resetSWRHarness()

  const revalidatePending = deferred<KlineResponse>()
  useExpiredCache()
  requestKlines = async () => revalidatePending.promise
  const staleHistory: HistoryCall[] = []
  const swrDatafeed = datafeedModule.createSpotTradingViewDatafeed({
    symbol: 'BTCUSDT',
    getBarsWatchdogMs: 10,
    inFlightDeadlineMs: { revalidate: 100 },
  })
  swrDatafeed.getBars(symbolInfo(), '1', currentPeriod, (bars: any[], meta: { noData?: boolean }) => {
    staleHistory.push({ bars, meta })
  }, assert.fail)
  assert.equal(staleHistory.length, 1)
  await wait(20)
  assert.equal(staleHistory.length, 1)

  swrDatafeed.destroy()
  revalidatePending.resolve(metadata([versionedRow(1_717_000_000_000, '109')]))
  await wait(0)
  resetSWRHarness()
})
