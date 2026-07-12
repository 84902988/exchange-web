/* eslint-disable @typescript-eslint/no-explicit-any -- Dynamic test harness loads compiled module exports. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

function loadClientCacheModule(): Record<string, any> {
  const filePath = fileURLToPath(new URL('./spotKlineClientCache.ts', import.meta.url))
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
  const mocks: Record<string, unknown> = {
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
  }
  const localRequire = (specifier: string) => {
    if (Object.prototype.hasOwnProperty.call(mocks, specifier)) return mocks[specifier]
    throw new Error(`Unexpected test import: ${specifier}`)
  }
  const execute = new Function('require', 'module', 'exports', '__filename', '__dirname', output)
  execute(
    localRequire,
    loadedModule,
    loadedModule.exports,
    filePath,
    filePath.slice(0, Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))),
  )
  return loadedModule.exports
}

const cacheModule = loadClientCacheModule()

function candidate(overrides: Record<string, unknown> = {}) {
  const close = Number(overrides.close ?? 101)
  return {
    symbol: 'BTCUSDT',
    interval: '1m',
    openTime: 2_000,
    bar: {
      time: 2_000,
      open: 100,
      high: Math.max(102, close),
      low: 99,
      close,
      volume: 10,
    },
    provider: 'OKX_SPOT',
    source: 'LIVE_WS',
    revision: {
      revisionEpoch: 1,
      revisionSeq: 5,
      isClosed: false,
      closeStateSource: 'PROVIDER_CONFIRMED',
    },
    ...overrides,
  }
}

const MINUTE_MS = 60_000
const SWR_NOW_MS = 1_800_000_000_000

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
    symbol: 'SWRELIGIBLEUSDT',
    interval: '1m',
    openTime: time,
    bar,
    provider: 'OKX_SPOT',
    source: 'REST_SNAPSHOT',
    revision: {
      revisionEpoch: 1,
      revisionSeq: Math.floor(time / MINUTE_MS),
      isClosed: true,
      closeStateSource: 'PROVIDER_CONFIRMED',
    },
    ...overrides,
  }
}

function staleEntry(overrides: Record<string, unknown> = {}) {
  const bars = (overrides.bars as Array<Record<string, unknown>> | undefined) || [
    swrBar(SWR_NOW_MS - 2 * MINUTE_MS, 100),
    swrBar(SWR_NOW_MS - MINUTE_MS, 101),
  ]
  const revisionCandidates = (
    overrides.revisionCandidates as Array<Record<string, unknown>> | undefined
  ) || bars.map((bar) => swrCandidate(Number(bar.time), { bar }))
  return {
    key: 'spot:kline:SWRELIGIBLEUSDT:1m:2:current',
    symbol: 'SWRELIGIBLEUSDT',
    interval: '1m',
    limit: bars.length,
    requestedLimit: bars.length,
    returnedCount: bars.length,
    terminalComplete: false,
    historyTerminal: false,
    terminalReason: null,
    earliestBoundary: null,
    bars,
    revisionCandidates,
    provider: 'OKX_SPOT',
    source: 'REST_SNAPSHOT',
    cachedAt: SWR_NOW_MS - 31_000,
    updatedAt: SWR_NOW_MS - 31_000,
    firstTime: Number(bars[0]?.time || 0),
    lastTime: Number(bars.at(-1)?.time || 0),
    ...overrides,
  }
}

function monthlyStaleEntry(options: {
  count?: number
  forming?: boolean
  terminalComplete?: boolean
} = {}) {
  const count = options.count ?? 60
  const forming = options.forming ?? true
  const symbol = 'SWRMONTHLYUSDT'
  const bars = Array.from({ length: count }, (_, index) => (
    swrBar(Date.UTC(2022, index, 1), 100 + index)
  ))
  const revisionCandidates = bars.map((bar, index) => swrCandidate(bar.time, {
    symbol,
    interval: '1Mutc',
    bar,
    revision: {
      revisionEpoch: 7,
      revisionSeq: index + 1,
      isClosed: forming && index === bars.length - 1 ? false : true,
      closeStateSource: 'PROVIDER_CONFIRMED',
    },
  }))
  return staleEntry({
    key: `spot:kline:${symbol}:1Mutc:60:current`,
    symbol,
    interval: '1Mutc',
    limit: 60,
    requestedLimit: 60,
    returnedCount: bars.length,
    terminalComplete: options.terminalComplete ?? false,
    bars,
    revisionCandidates,
    cachedAt: SWR_NOW_MS - 121_000,
    updatedAt: SWR_NOW_MS - 121_000,
    firstTime: Number(bars[0]?.time || 0),
    lastTime: Number(bars.at(-1)?.time || 0),
  })
}

test('late REST lower revision cannot overwrite WS winner', () => {
  const cache = cacheModule.createSpotKlineRevisionCache()
  cache.merge(candidate({ close: 101 }))
  const result = cache.merge(candidate({
    close: 100,
    source: 'REST_SNAPSHOT',
    revision: {
      revisionEpoch: 1,
      revisionSeq: 3,
      isClosed: false,
      closeStateSource: 'PROVIDER_CONFIRMED',
    },
  }))

  assert.equal(result.decision, 'REJECT')
  assert.equal(result.reason, 'STALE_REVISION')
  assert.equal(result.winner.bar.close, 101)
})

test('newer WS revision upgrades REST winner', () => {
  const cache = cacheModule.createSpotKlineRevisionCache()
  cache.merge(candidate({
    close: 100,
    source: 'REST_SNAPSHOT',
    revision: {
      revisionEpoch: 1,
      revisionSeq: 1,
      isClosed: false,
      closeStateSource: 'PROVIDER_CONFIRMED',
    },
  }))
  const result = cache.merge(candidate({
    close: 102,
    revision: {
      revisionEpoch: 1,
      revisionSeq: 2,
      isClosed: false,
      closeStateSource: 'PROVIDER_CONFIRMED',
    },
  }))

  assert.equal(result.decision, 'ACCEPT')
  assert.equal(result.reason, 'NEWER_REVISION')
  assert.equal(result.winner.bar.close, 102)
})

test('same revision and OHLCV is duplicate', () => {
  const cache = cacheModule.createSpotKlineRevisionCache()
  const first = candidate()
  cache.merge(first)
  const result = cache.merge(first)

  assert.equal(result.decision, 'NO_CHANGE')
  assert.equal(result.reason, 'DUPLICATE')
})

test('close upgrade emits semantic revision while closed downgrade is rejected', () => {
  const cache = cacheModule.createSpotKlineRevisionCache()
  const open = candidate()
  cache.merge(open)
  const closed = candidate({
    revision: {
      revisionEpoch: 1,
      revisionSeq: 5,
      isClosed: true,
      closeStateSource: 'PROVIDER_CONFIRMED',
    },
  })
  const upgrade = cache.merge(closed)
  const downgrade = cache.merge(candidate({
    revision: {
      revisionEpoch: 1,
      revisionSeq: 6,
      isClosed: false,
      closeStateSource: 'PROVIDER_CONFIRMED',
    },
  }))

  assert.equal(upgrade.decision, 'ACCEPT')
  assert.equal(upgrade.reason, 'CLOSE_UPGRADE')
  assert.equal(downgrade.decision, 'REJECT')
  assert.equal(downgrade.reason, 'CLOSED_DOWNGRADE')
})

test('old epoch is rejected and higher provider epoch clears old scope', () => {
  const cache = cacheModule.createSpotKlineRevisionCache()
  cache.merge(candidate({ openTime: 1_000, bar: { ...candidate().bar, time: 1_000 } }))
  const switched = cache.merge(candidate({
    provider: 'BITGET_SPOT',
    revision: {
      revisionEpoch: 2,
      revisionSeq: 1,
      isClosed: false,
      closeStateSource: 'PROVIDER_CONFIRMED',
    },
  }))
  const retired = cache.merge(candidate({
    revision: {
      revisionEpoch: 1,
      revisionSeq: 99,
      isClosed: false,
      closeStateSource: 'PROVIDER_CONFIRMED',
    },
  }))

  assert.equal(switched.decision, 'ACCEPT')
  assert.equal(cache.get('BTCUSDT', '1m', 1_000), null)
  assert.equal(retired.decision, 'REJECT')
  assert.equal(retired.reason, 'STALE_EPOCH')
})

test('symbol and interval scopes are isolated and explicitly clearable', () => {
  const cache = cacheModule.createSpotKlineRevisionCache()
  cache.merge(candidate())
  cache.merge(candidate({ symbol: 'ETHUSDT' }))
  cache.merge(candidate({ interval: '5m' }))

  cache.clearScope('BTCUSDT', '1m')
  assert.equal(cache.get('BTCUSDT', '1m', 2_000), null)
  assert.equal(cache.get('BTCUSDT', '5m', 2_000)?.bar.close, 101)
  assert.equal(cache.get('ETHUSDT', '1m', 2_000)?.bar.close, 101)

  cache.clearSymbol('BTCUSDT')
  assert.equal(cache.get('BTCUSDT', '5m', 2_000), null)
  assert.equal(cache.size(), 1)
})

test('legacy candles use time bucket semantics without fabricated revision', () => {
  const cache = cacheModule.createSpotKlineRevisionCache()
  const legacyRevision = cacheModule.extractSpotKlineRevisionMetadata(null)
  const first = candidate({ revision: legacyRevision, close: 100 })
  const second = candidate({ revision: legacyRevision, close: 101 })

  cache.merge(first)
  const result = cache.merge(second)

  assert.equal(result.decision, 'ACCEPT')
  assert.equal(result.reason, 'LEGACY_UPDATE')
  assert.deepEqual(result.winner.revision, {
    revisionEpoch: null,
    revisionSeq: null,
    isClosed: null,
    closeStateSource: null,
  })
})

test('L1 client cache stores revision metadata and rejects a late lower revision write', () => {
  const symbol = 'REVISIONCACHEUSDT'
  const winner = candidate({
    symbol,
    source: 'REST_SNAPSHOT',
    close: 101,
    revision: {
      revisionEpoch: 1,
      revisionSeq: 5,
      isClosed: false,
      closeStateSource: 'PROVIDER_CONFIRMED',
    },
  })
  const stale = candidate({
    symbol,
    source: 'REST_SNAPSHOT',
    close: 100,
    revision: {
      revisionEpoch: 1,
      revisionSeq: 3,
      isClosed: false,
      closeStateSource: 'PROVIDER_CONFIRMED',
    },
  })

  cacheModule.writeCurrentKlineCache({
    symbol,
    interval: '1m',
    limit: 1,
    bars: [winner.bar],
    revisionCandidates: [winner],
    provider: 'OKX_SPOT',
    source: 'REST_SNAPSHOT',
  })
  const stored = cacheModule.writeCurrentKlineCache({
    symbol,
    interval: '1m',
    limit: 1,
    bars: [stale.bar],
    revisionCandidates: [stale],
    provider: 'OKX_SPOT',
    source: 'REST_SNAPSHOT',
  })

  assert.equal(stored.bars[0].close, 101)
  assert.equal(stored.revisionCandidates[0].revision.revisionSeq, 5)
})

test('L1 client cache stores authoritative monthly terminal metadata', () => {
  const symbol = 'TERMINALCACHEUSDT'
  const bars = [
    swrBar(Date.UTC(2018, 0, 1), 100),
    swrBar(Date.UTC(2018, 1, 1), 101),
  ]
  const earliestBoundary = bars[0].time

  const stored = cacheModule.writeCurrentKlineCache({
    symbol,
    interval: '1Mutc',
    limit: 360,
    bars,
    provider: 'OKX_SPOT',
    source: 'REST_SNAPSHOT',
    historyTerminal: true,
    terminalReason: 'CACHE_HISTORY_BOUNDARY',
    earliestBoundary,
  })

  assert.equal(stored.historyTerminal, true)
  assert.equal(stored.terminalReason, 'CACHE_HISTORY_BOUNDARY')
  assert.equal(stored.earliestBoundary, earliestBoundary)
  assert.equal(stored.terminalComplete, true)
})

test('ordinary monthly preload cannot overwrite an existing terminal boundary', () => {
  const symbol = 'TERMINALPRESERVEUSDT'
  const bars = [
    swrBar(Date.UTC(2018, 0, 1), 100),
    swrBar(Date.UTC(2018, 1, 1), 101),
  ]
  const earliestBoundary = bars[0].time

  cacheModule.writeCurrentKlineCache({
    symbol,
    interval: '1Mutc',
    limit: 360,
    bars,
    provider: 'OKX_SPOT',
    source: 'REST_SNAPSHOT',
    historyTerminal: true,
    terminalReason: 'PROVIDER_HISTORY_BOUNDARY',
    earliestBoundary,
  })
  const ordinaryPreload = cacheModule.writeCurrentKlineCache({
    symbol,
    interval: '1Mutc',
    limit: 329,
    bars,
    provider: 'OKX_SPOT',
    source: 'REST_SNAPSHOT',
    historyTerminal: false,
    terminalReason: null,
    earliestBoundary: null,
  })

  assert.equal(ordinaryPreload.historyTerminal, true)
  assert.equal(ordinaryPreload.terminalReason, 'PROVIDER_HISTORY_BOUNDARY')
  assert.equal(ordinaryPreload.earliestBoundary, earliestBoundary)
})

test('expired complete snapshot is eligible for stale closed history', () => {
  const result = cacheModule.inspectStaleHistoryEligibility(staleEntry(), {
    requiredBars: 2,
    now: SWR_NOW_MS,
  })

  assert.equal(result.eligible, true)
  assert.equal(result.reason, 'ELIGIBLE')
  assert.equal(result.bars.length, 2)
  assert.equal(result.revisionCandidates.length, 2)
  assert.equal(result.provider, 'OKX_SPOT')
  assert.equal(result.revisionEpoch, 1)
})

test('forming candle is excluded and rejects stale history when closed coverage is short', () => {
  const closed = swrBar(SWR_NOW_MS - MINUTE_MS, 100)
  const forming = swrBar(SWR_NOW_MS, 101)
  const entry = staleEntry({
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
  })
  const result = cacheModule.inspectStaleHistoryEligibility(entry, {
    requiredBars: 2,
    now: SWR_NOW_MS,
  })

  assert.equal(result.eligible, false)
  assert.equal(result.reason, 'FORMING_CANDLE')
  assert.deepEqual(result.bars, [])
})

test('forming candle is removed when enough closed history remains', () => {
  const first = swrBar(SWR_NOW_MS - 2 * MINUTE_MS, 100)
  const second = swrBar(SWR_NOW_MS - MINUTE_MS, 101)
  const forming = swrBar(SWR_NOW_MS, 102)
  const result = cacheModule.inspectStaleHistoryEligibility(staleEntry({
    bars: [first, second, forming],
    revisionCandidates: [
      swrCandidate(first.time, { bar: first }),
      swrCandidate(second.time, { bar: second }),
      swrCandidate(forming.time, {
        bar: forming,
        revision: {
          revisionEpoch: 1,
          revisionSeq: 3,
          isClosed: false,
          closeStateSource: 'PROVIDER_CONFIRMED',
        },
      }),
    ],
  }), {
    requiredBars: 2,
    now: SWR_NOW_MS,
  })

  assert.equal(result.eligible, true)
  assert.deepEqual(result.bars.map((bar: Record<string, unknown>) => bar.time), [first.time, second.time])
  assert.deepEqual(
    result.revisionCandidates.map((item: Record<string, unknown>) => item.openTime),
    [first.time, second.time],
  )
})

test('monthly stale history accepts 59 closed bars from a 60-bar cache with one forming candle', () => {
  const result = cacheModule.inspectStaleHistoryEligibility(monthlyStaleEntry(), {
    requiredBars: 60,
    now: SWR_NOW_MS,
  })

  assert.equal(result.eligible, true)
  assert.equal(result.reason, 'ELIGIBLE')
  assert.equal(result.requiredBars, 60)
  assert.equal(result.bars.length, 59)
  assert.equal(result.revisionCandidates.length, 59)
  assert.equal(result.revisionEpoch, 7)
  assert.ok(result.revisionCandidates.every(
    (item: Record<string, any>) => item.revision.isClosed === true,
  ))
  assert.deepEqual(
    result.revisionCandidates.map((item: Record<string, unknown>) => item.openTime),
    result.bars.map((bar: Record<string, unknown>) => bar.time),
  )
})

test('monthly terminal-complete cache may use the centralized 59-bar minimum', () => {
  const result = cacheModule.inspectStaleHistoryEligibility(monthlyStaleEntry({
    count: 59,
    forming: false,
    terminalComplete: true,
  }), {
    requiredBars: 60,
    now: SWR_NOW_MS,
  })

  assert.equal(result.eligible, true)
  assert.equal(result.bars.length, 59)
  assert.ok(result.revisionCandidates.every(
    (item: Record<string, any>) => item.revision.isClosed === true,
  ))
})

test('monthly stale history rejects coverage below the 59-bar minimum', () => {
  const result = cacheModule.inspectStaleHistoryEligibility(monthlyStaleEntry({ count: 58 }), {
    requiredBars: 60,
    now: SWR_NOW_MS,
  })

  assert.equal(result.eligible, false)
  assert.equal(result.reason, 'INSUFFICIENT_BARS')
  assert.deepEqual(result.bars, [])
})

test('daily and weekly stale history keep the exact required-bars rule', () => {
  for (const [interval, intervalMs] of [['1Dutc', 24 * 60 * MINUTE_MS], ['1Wutc', 7 * 24 * 60 * MINUTE_MS]] as const) {
    const symbol = `SWR${interval.toUpperCase()}USDT`
    const first = swrBar(SWR_NOW_MS - intervalMs, 100)
    const forming = swrBar(SWR_NOW_MS, 101)
    const result = cacheModule.inspectStaleHistoryEligibility(staleEntry({
      symbol,
      interval,
      bars: [first, forming],
      cachedAt: SWR_NOW_MS - 121_000,
      updatedAt: SWR_NOW_MS - 121_000,
      revisionCandidates: [
        swrCandidate(first.time, { symbol, interval, bar: first }),
        swrCandidate(forming.time, {
          symbol,
          interval,
          bar: forming,
          revision: {
            revisionEpoch: 1,
            revisionSeq: 2,
            isClosed: false,
            closeStateSource: 'PROVIDER_CONFIRMED',
          },
        }),
      ],
    }), {
      requiredBars: 2,
      now: SWR_NOW_MS,
    })

    assert.equal(result.eligible, false, interval)
    assert.equal(result.reason, 'FORMING_CANDLE', interval)
  }
})

test('monthly relax does not bypass source continuity or provider epoch guards', () => {
  const liveWsEntry = monthlyStaleEntry({ terminalComplete: true })
  liveWsEntry.source = 'LIVE_WS'
  const liveWs = cacheModule.inspectStaleHistoryEligibility(liveWsEntry, {
    requiredBars: 60,
    now: SWR_NOW_MS,
  })
  const gapEntry = monthlyStaleEntry({ forming: false })
  gapEntry.bars.splice(30, 1)
  gapEntry.revisionCandidates.splice(30, 1)
  const gap = cacheModule.inspectStaleHistoryEligibility(gapEntry, {
    requiredBars: 60,
    now: SWR_NOW_MS,
  })
  const mismatchEntry = monthlyStaleEntry()
  mismatchEntry.revisionCandidates[20] = {
    ...mismatchEntry.revisionCandidates[20],
    provider: 'BITGET_SPOT',
  }
  const mismatch = cacheModule.inspectStaleHistoryEligibility(mismatchEntry, {
    requiredBars: 60,
    now: SWR_NOW_MS,
  })

  assert.equal(liveWs.reason, 'SOURCE_NOT_ALLOWED')
  assert.equal(gap.reason, 'CONTINUITY_INVALID')
  assert.equal(mismatch.reason, 'PROVIDER_EPOCH_MISMATCH')
})

test('insufficient stale bars are rejected', () => {
  const bar = swrBar(SWR_NOW_MS - MINUTE_MS)
  const result = cacheModule.inspectStaleHistoryEligibility(staleEntry({
    bars: [bar],
    revisionCandidates: [swrCandidate(bar.time, { bar })],
  }), {
    requiredBars: 2,
    now: SWR_NOW_MS,
  })

  assert.equal(result.eligible, false)
  assert.equal(result.reason, 'INSUFFICIENT_BARS')
})

test('stale history with a continuity gap is rejected', () => {
  const first = swrBar(SWR_NOW_MS - 3 * MINUTE_MS, 100)
  const second = swrBar(SWR_NOW_MS - MINUTE_MS, 101)
  const result = cacheModule.inspectStaleHistoryEligibility(staleEntry({
    bars: [first, second],
    revisionCandidates: [
      swrCandidate(first.time, { bar: first }),
      swrCandidate(second.time, { bar: second }),
    ],
  }), {
    requiredBars: 2,
    now: SWR_NOW_MS,
  })

  assert.equal(result.eligible, false)
  assert.equal(result.reason, 'CONTINUITY_INVALID')
})

test('LIVE_WS batch history is never stale eligible', () => {
  const result = cacheModule.inspectStaleHistoryEligibility(staleEntry({ source: 'LIVE_WS' }), {
    requiredBars: 2,
    now: SWR_NOW_MS,
  })

  assert.equal(result.eligible, false)
  assert.equal(result.reason, 'SOURCE_NOT_ALLOWED')
})

test('closed historical bars without close metadata use interval time inference', () => {
  const bars = [
    swrBar(SWR_NOW_MS - 2 * MINUTE_MS, 100),
    swrBar(SWR_NOW_MS - MINUTE_MS, 101),
  ]
  const result = cacheModule.inspectStaleHistoryEligibility(staleEntry({
    source: 'DB_CACHE',
    bars,
    revisionCandidates: [],
  }), {
    requiredBars: 2,
    now: SWR_NOW_MS,
  })

  assert.equal(result.eligible, true)
  assert.deepEqual(result.bars.map((bar: Record<string, unknown>) => bar.time), bars.map((bar) => bar.time))
  assert.deepEqual(result.revisionCandidates, [])
})

test('closed upgrade revision metadata is preserved in stale projection', () => {
  const bar = swrBar(SWR_NOW_MS, 103)
  const closed = swrCandidate(bar.time, {
    bar,
    revision: {
      revisionEpoch: 4,
      revisionSeq: 9,
      isClosed: true,
      closeStateSource: 'PROVIDER_CONFIRMED',
    },
  })
  const result = cacheModule.inspectStaleHistoryEligibility(staleEntry({
    bars: [bar],
    revisionCandidates: [closed],
  }), {
    requiredBars: 1,
    now: SWR_NOW_MS,
  })

  assert.equal(result.eligible, true)
  assert.deepEqual(result.revisionCandidates[0].revision, closed.revision)
  assert.equal(result.revisionEpoch, 4)
})

test('conflicting revision metadata for the same bucket is rejected', () => {
  const bar = swrBar(SWR_NOW_MS - MINUTE_MS)
  const first = swrCandidate(bar.time, { bar })
  const conflict = swrCandidate(bar.time, {
    bar,
    revision: {
      revisionEpoch: 1,
      revisionSeq: 999,
      isClosed: true,
      closeStateSource: 'PROVIDER_CONFIRMED',
    },
  })
  const result = cacheModule.inspectStaleHistoryEligibility(staleEntry({
    bars: [bar],
    revisionCandidates: [first, conflict],
  }), {
    requiredBars: 1,
    now: SWR_NOW_MS,
  })

  assert.equal(result.eligible, false)
  assert.equal(result.reason, 'REVISION_CONFLICT')
})

test('provider or epoch mismatch rejects stale history', () => {
  const first = swrBar(SWR_NOW_MS - 2 * MINUTE_MS, 100)
  const second = swrBar(SWR_NOW_MS - MINUTE_MS, 101)
  const result = cacheModule.inspectStaleHistoryEligibility(staleEntry({
    bars: [first, second],
    revisionCandidates: [
      swrCandidate(first.time, { bar: first }),
      swrCandidate(second.time, {
        bar: second,
        provider: 'BITGET_SPOT',
        revision: {
          revisionEpoch: 2,
          revisionSeq: 1,
          isClosed: true,
          closeStateSource: 'PROVIDER_CONFIRMED',
        },
      }),
    ],
  }), {
    requiredBars: 2,
    now: SWR_NOW_MS,
  })

  assert.equal(result.eligible, false)
  assert.equal(result.reason, 'PROVIDER_EPOCH_MISMATCH')

  const epochMismatch = cacheModule.inspectStaleHistoryEligibility(staleEntry({
    bars: [first, second],
    revisionCandidates: [
      swrCandidate(first.time, { bar: first }),
      swrCandidate(second.time, {
        bar: second,
        revision: {
          revisionEpoch: 2,
          revisionSeq: 1,
          isClosed: true,
          closeStateSource: 'PROVIDER_CONFIRMED',
        },
      }),
    ],
  }), {
    requiredBars: 2,
    now: SWR_NOW_MS,
  })

  assert.equal(epochMismatch.eligible, false)
  assert.equal(epochMismatch.reason, 'PROVIDER_EPOCH_MISMATCH')
})

test('existing fresh cache hit behavior is unchanged by stale eligibility inspection', () => {
  const symbol = 'SWRFRESHCACHEUSDT'
  const bar = swrBar(SWR_NOW_MS - MINUTE_MS)
  const stored = cacheModule.writeCurrentKlineCache({
    symbol,
    interval: '1m',
    limit: 1,
    bars: [bar],
    revisionCandidates: [swrCandidate(bar.time, { symbol, bar })],
    provider: 'OKX_SPOT',
    source: 'REST_SNAPSHOT',
  })
  const lookup = cacheModule.inspectCurrentKlineCache(symbol, '1m', 1)
  const eligibility = cacheModule.inspectStaleHistoryEligibility(stored, {
    requiredBars: 1,
    now: stored.updatedAt,
  })

  assert.equal(lookup.reason, 'hit')
  assert.equal(lookup.hit?.bars.length, 1)
  assert.equal(eligibility.eligible, false)
  assert.equal(eligibility.reason, 'FRESH')
})
