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

const cacheModule = {
  buildKlineCachePerfPayload: () => ({}),
  cloneBars: (bars: any[]) => bars.map((bar) => ({ ...bar })),
  fetchAndCacheCurrentKlineBars: async () => null,
  getBackendKlineIntervalForSpotInterval: (interval: string) => (
    interval.endsWith('utc') ? interval.slice(0, -3) : interval
  ),
  getBarsContinuityStats: () => ({ ...continuity }),
  getL1CurrentKlineCacheMinBars: () => 1,
  getSpotIntervalMs: () => 60_000,
  getSpotKlineLoadPolicy: () => ({ current: 1, preload: 1, history: 1 }),
  isSparseRealKlineSeries: () => false,
  inspectCurrentKlineCache: (_symbol: string, _interval: string, requestedLimit: number) => ({
    hit: null,
    reason: 'miss',
    minBars: 1,
    requestedLimit,
  }),
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
  writeCurrentKlineCache: () => null,
}

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
        subscribe: (_domain: string, handler: (message: Record<string, unknown>) => void) => {
          klineSubscriber = handler
          return () => {
            if (klineSubscriber === handler) klineSubscriber = null
          }
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
  assert.equal(policy({ history_terminal: true }, false).noData, false, 'current requests never end history')
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
  assert.deepEqual(errors, [])
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
