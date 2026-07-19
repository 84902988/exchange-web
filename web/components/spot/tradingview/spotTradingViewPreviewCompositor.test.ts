import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

import type {
  SpotPreviewCompositorNativeInput,
  SpotPreviewCompositorPreviewInput,
} from './spotTradingViewPreviewCompositor'

const compositorPath = fileURLToPath(
  new URL('./spotTradingViewPreviewCompositor.ts', import.meta.url),
)
const compositorSource = readFileSync(compositorPath, 'utf8')
const compositorOutput = ts.transpileModule(compositorSource, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: compositorPath,
}).outputText
const loadedModule: { exports: Record<string, unknown> } = { exports: {} }
const execute = new Function('require', 'module', 'exports', compositorOutput)
execute(() => undefined, loadedModule, loadedModule.exports)
const SpotTradingViewPreviewCompositor = loadedModule.exports
  .SpotTradingViewPreviewCompositor as typeof import('./spotTradingViewPreviewCompositor')
    .SpotTradingViewPreviewCompositor

const OPEN_TIME = 1_710_000_060_000

function native(
  overrides: Partial<SpotPreviewCompositorNativeInput> = {},
): SpotPreviewCompositorNativeInput {
  return {
    symbol: 'BTCUSDT',
    interval: '1m',
    openTime: OPEN_TIME,
    generation: 1,
    receivedAtMs: 1_000,
    revision: { epoch: 1, sequence: 1 },
    isClosed: false,
    bar: {
      time: OPEN_TIME,
      open: 100,
      high: 105,
      low: 99,
      close: 101,
      volume: 10,
    },
    ...overrides,
  }
}

function preview(
  overrides: Partial<SpotPreviewCompositorPreviewInput> = {},
): SpotPreviewCompositorPreviewInput {
  return {
    symbol: 'BTCUSDT',
    interval: '1m',
    openTime: OPEN_TIME,
    generation: 1,
    receivedAtMs: 2_000,
    previewSeq: 1,
    baseNativeRevision: { epoch: 1, sequence: 1 },
    bar: {
      time: OPEN_TIME,
      open: 100,
      high: 106,
      low: 98,
      close: 104,
      volume: 12,
    },
    ...overrides,
  }
}

test('native only returns the Native OPEN bar', () => {
  const compositor = new SpotTradingViewPreviewCompositor({ symbol: 'BTCUSDT', interval: '1m' })

  const result = compositor.acceptNative(native())

  assert.equal(result.source, 'native')
  assert.deepEqual(result.bar, native().bar)
})

test('valid preview replaces only the active Native OPEN bar', () => {
  const compositor = new SpotTradingViewPreviewCompositor({ symbol: 'BTCUSDT', interval: '1m' })
  compositor.acceptNative(native())

  const result = compositor.acceptPreview(preview())

  assert.equal(result.source, 'preview')
  assert.deepEqual(result.bar, preview().bar)
  assert.equal(result.bar?.time, native().bar.time)
  assert.equal(result.bar?.open, native().bar.open)
})

test('preview newer than Native OPEN trade state prevents a visual rollback', () => {
  const compositor = new SpotTradingViewPreviewCompositor({ symbol: 'BTCUSDT', interval: '1m' })
  compositor.acceptNative(native())
  compositor.acceptPreview(preview())

  const rebased = compositor.acceptNative(native({
    receivedAtMs: 3_000,
    revision: { epoch: 1, sequence: 2 },
    bar: { ...native().bar, close: 103, volume: 11 },
  }))
  const stale = compositor.acceptPreview(preview({ previewSeq: 2 }))

  assert.equal(rebased.reason, 'NATIVE_OPEN_DEFERRED_TO_PREVIEW')
  assert.equal(rebased.source, 'preview')
  assert.deepEqual(rebased.bar, preview().bar)
  assert.equal(stale.reason, 'BASE_REVISION_STALE')
  assert.equal(compositor.getOutput().source, 'preview')
})

test('native newer than Preview is accepted after it catches the trade state', () => {
  const compositor = new SpotTradingViewPreviewCompositor({ symbol: 'BTCUSDT', interval: '1m' })
  compositor.acceptNative(native())
  compositor.acceptPreview(preview())

  const rebased = compositor.acceptNative(native({
    receivedAtMs: 3_000,
    revision: { epoch: 1, sequence: 2 },
    bar: { ...native().bar, close: 104, high: 104, volume: 12 },
  }))

  assert.equal(rebased.reason, 'NATIVE_ACCEPTED')
  assert.equal(rebased.source, 'native')
  assert.equal(rebased.bar?.close, 104)
  assert.equal(compositor.getOutput().source, 'native')
})

test('volume-ahead Native OPEN waits until its close matches the settled trade', () => {
  const compositor = new SpotTradingViewPreviewCompositor({ symbol: 'BTCUSDT', interval: '1m' })
  compositor.acceptNative(native())
  compositor.acceptPreview(preview())

  const ahead = compositor.acceptNative(native({
    receivedAtMs: 3_000,
    revision: { epoch: 1, sequence: 2 },
    bar: { ...native().bar, close: 103, volume: 13 },
  }))

  assert.equal(ahead.reason, 'NATIVE_OPEN_DEFERRED_TO_PREVIEW')
  assert.equal(ahead.source, 'preview')
  assert.equal(ahead.bar?.close, 104)
})

test('Preview cannot regress the caught-up Native volume on a new baseline', () => {
  const compositor = new SpotTradingViewPreviewCompositor({ symbol: 'BTCUSDT', interval: '1m' })
  compositor.acceptNative(native())
  compositor.acceptPreview(preview())
  compositor.acceptNative(native({
    receivedAtMs: 3_000,
    revision: { epoch: 1, sequence: 2 },
    bar: { ...native().bar, close: 104, high: 104, volume: 12 },
  }))

  const rollback = compositor.acceptPreview(preview({
    receivedAtMs: 4_000,
    previewSeq: 1,
    baseNativeRevision: { epoch: 1, sequence: 2 },
    bar: { ...preview().bar, volume: 11 },
  }))

  assert.equal(rollback.reason, 'PREVIEW_TRADE_STATE_STALE')
  assert.equal(compositor.getOutput().source, 'native')
  assert.equal(compositor.getOutput().bar?.volume, 12)
})

test('Native CLOSED wins permanently over Preview for the bucket', () => {
  const compositor = new SpotTradingViewPreviewCompositor({ symbol: 'BTCUSDT', interval: '1m' })
  compositor.acceptNative(native())
  compositor.acceptPreview(preview())

  const closed = compositor.acceptNative(native({
    isClosed: true,
    revision: { epoch: 1, sequence: 2 },
    bar: { ...native().bar, close: 102 },
  }))
  const late = compositor.acceptPreview(preview({
    previewSeq: 2,
    baseNativeRevision: { epoch: 1, sequence: 2 },
  }))

  assert.equal(closed.source, 'native')
  assert.equal(late.reason, 'NATIVE_CLOSED')
  assert.equal(compositor.getOutput().bar?.close, 102)
})

test('stale and future preview base revisions are rejected', () => {
  const compositor = new SpotTradingViewPreviewCompositor({ symbol: 'BTCUSDT', interval: '1m' })
  compositor.acceptNative(native({ revision: { epoch: 2, sequence: 5 } }))

  assert.equal(compositor.acceptPreview(preview({
    baseNativeRevision: { epoch: 2, sequence: 4 },
  })).reason, 'BASE_REVISION_STALE')
  assert.equal(compositor.acceptPreview(preview({
    baseNativeRevision: { epoch: 2, sequence: 6 },
  })).reason, 'BASE_REVISION_FUTURE')
})

test('generation change rebases and rejects the previous generation', () => {
  const compositor = new SpotTradingViewPreviewCompositor({ symbol: 'BTCUSDT', interval: '1m' })
  compositor.acceptNative(native())
  compositor.acceptPreview(preview())
  compositor.acceptNative(native({ generation: 2 }))

  const oldGeneration = compositor.acceptPreview(preview({ previewSeq: 2 }))
  const newGeneration = compositor.acceptPreview(preview({ generation: 2, previewSeq: 1 }))

  assert.equal(oldGeneration.reason, 'GENERATION_MISMATCH')
  assert.equal(newGeneration.source, 'preview')
})

test('symbol and interval scopes are isolated', () => {
  const btc = new SpotTradingViewPreviewCompositor({ symbol: 'BTCUSDT', interval: '1m' })
  const eth = new SpotTradingViewPreviewCompositor({ symbol: 'ETHUSDT', interval: '1m' })
  const sol = new SpotTradingViewPreviewCompositor({ symbol: 'SOLUSDT', interval: '1m' })
  const fiveMinute = new SpotTradingViewPreviewCompositor({ symbol: 'BTCUSDT', interval: '5m' })
  btc.acceptNative(native())
  eth.acceptNative(native({ symbol: 'ETHUSDT' }))

  assert.equal(btc.acceptPreview(preview({ symbol: 'ETHUSDT' })).reason, 'SYMBOL_MISMATCH')
  assert.equal(eth.acceptPreview(preview({ symbol: 'ETHUSDT' })).source, 'preview')
  assert.equal(sol.acceptNative(native({ symbol: 'SOLUSDT' })).source, 'native')
  assert.equal(sol.acceptPreview(preview({ symbol: 'SOLUSDT' })).source, 'preview')
  assert.equal(btc.acceptPreview(preview({ interval: '5m' })).reason, 'INTERVAL_MISMATCH')
  assert.equal(fiveMinute.acceptNative(native({ interval: '5m' })).reason, 'UNSUPPORTED_SCOPE')
})

test('preview sequence is monotonic and never creates a different bar time', () => {
  const compositor = new SpotTradingViewPreviewCompositor({ symbol: 'BTCUSDT', interval: '1m' })
  compositor.acceptNative(native())
  assert.equal(compositor.acceptPreview(preview({ previewSeq: 2 })).source, 'preview')

  assert.equal(compositor.acceptPreview(preview({ previewSeq: 1 })).reason, 'PREVIEW_SEQUENCE_STALE')
  assert.equal(compositor.acceptPreview(preview({
    openTime: OPEN_TIME - 60_000,
    previewSeq: 3,
    bar: { ...preview().bar, time: OPEN_TIME - 60_000 },
  })).reason, 'OPEN_TIME_MISMATCH')
  assert.equal(compositor.getOutput().bar?.time, OPEN_TIME)
})

test('freshness state records the active bar revision and receive clocks', () => {
  const compositor = new SpotTradingViewPreviewCompositor({ symbol: 'BTCUSDT', interval: '1m' })
  compositor.acceptNative(native({ receivedAtMs: 10_000 }))
  compositor.acceptPreview(preview({ previewSeq: 4, receivedAtMs: 10_020 }))

  assert.deepEqual(compositor.getFreshnessState(), {
    symbol: 'BTCUSDT',
    interval: '1m',
    openTime: OPEN_TIME,
    previewSeq: 4,
    nativeRevisionSeq: 1,
    previewReceivedAt: 10_020,
    nativeReceivedAt: 10_000,
  })
})

test('rebased Preview preserves same-candle volume high-water', () => {
  const compositor = new SpotTradingViewPreviewCompositor({ symbol: 'BTCUSDT', interval: '1m' })
  compositor.acceptNative(native())
  compositor.acceptPreview(preview({ previewSeq: 4, bar: { ...preview().bar, volume: 14 } }))
  compositor.acceptNative(native({
    receivedAtMs: 3_000,
    revision: { epoch: 1, sequence: 2 },
    bar: { ...native().bar, volume: 11 },
  }))

  const rollback = compositor.acceptPreview(preview({
    receivedAtMs: 4_000,
    previewSeq: 1,
    baseNativeRevision: { epoch: 1, sequence: 2 },
    bar: { ...preview().bar, volume: 13 },
  }))
  const advanced = compositor.acceptPreview(preview({
    receivedAtMs: 4_010,
    previewSeq: 1,
    baseNativeRevision: { epoch: 1, sequence: 2 },
    bar: { ...preview().bar, close: 105, high: 105, volume: 15 },
  }))

  assert.equal(rollback.reason, 'PREVIEW_TRADE_STATE_STALE')
  assert.equal(advanced.source, 'preview')
  assert.equal(advanced.bar?.close, 105)
  assert.equal(advanced.bar?.volume, 15)
})

test('minute boundary resets Preview freshness and accepts the new Native baseline', () => {
  const compositor = new SpotTradingViewPreviewCompositor({ symbol: 'BTCUSDT', interval: '1m' })
  compositor.acceptNative(native())
  compositor.acceptPreview(preview())

  const nextOpenTime = OPEN_TIME + 60_000
  const next = compositor.acceptNative(native({
    openTime: nextOpenTime,
    receivedAtMs: 3_000,
    revision: { epoch: 1, sequence: 2 },
    bar: {
      time: nextOpenTime,
      open: 104,
      high: 104,
      low: 104,
      close: 104,
      volume: 0,
    },
  }))

  assert.equal(next.source, 'native')
  assert.equal(next.bar?.time, nextOpenTime)
  assert.equal(compositor.getFreshnessState().previewSeq, null)
})
