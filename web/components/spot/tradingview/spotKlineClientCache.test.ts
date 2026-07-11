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
