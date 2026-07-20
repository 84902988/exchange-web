import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

import type {
  ContractPreviewInput,
  ContractPreviewNativeInput,
} from './contractTradingViewPreviewCompositor'

const modulePath = fileURLToPath(
  new URL('./contractTradingViewPreviewCompositor.ts', import.meta.url),
)
const source = readFileSync(modulePath, 'utf8')
const output = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: modulePath,
}).outputText
const loadedModule: { exports: Record<string, unknown> } = { exports: {} }
new Function('require', 'module', 'exports', output)(
  () => undefined,
  loadedModule,
  loadedModule.exports,
)
const ContractTradingViewPreviewCompositor = loadedModule.exports
  .ContractTradingViewPreviewCompositor as typeof import('./contractTradingViewPreviewCompositor')
    .ContractTradingViewPreviewCompositor

const OPEN_TIME = 1_720_000_020_000

function native(
  overrides: Partial<ContractPreviewNativeInput> = {},
): ContractPreviewNativeInput {
  return {
    symbol: 'BTCUSDT_PERP',
    interval: '1m',
    openTime: OPEN_TIME,
    generation: 3,
    receivedAtMs: 1_000,
    revision: { epoch: 3, sequence: 8 },
    isClosed: false,
    bar: {
      time: OPEN_TIME,
      open: 100,
      high: 102,
      low: 99,
      close: 101,
      volume: 50,
    },
    ...overrides,
  }
}

function preview(
  overrides: Partial<ContractPreviewInput> = {},
): ContractPreviewInput {
  return {
    symbol: 'BTCUSDT_PERP',
    interval: '1m',
    openTime: OPEN_TIME,
    generation: 3,
    receivedAtMs: 2_000,
    previewSequence: 1,
    baseNativeRevision: { epoch: 3, sequence: 8 },
    bar: {
      time: OPEN_TIME,
      open: 100,
      high: 103,
      low: 99,
      close: 103,
      volume: 52,
    },
    ...overrides,
  }
}

test('complete preview replaces only its matching Native OPEN baseline', () => {
  const compositor = new ContractTradingViewPreviewCompositor({
    symbol: 'BTCUSDT_PERP',
    interval: '1m',
  })
  assert.equal(compositor.acceptNative(native()).source, 'native')

  const result = compositor.acceptPreview(preview())

  assert.equal(result.accepted, true)
  assert.equal(result.source, 'preview')
  assert.deepEqual(result.bar, preview().bar)
})

test('older Native OPEN cannot visually roll back newer trade OHLCV', () => {
  const compositor = new ContractTradingViewPreviewCompositor({
    symbol: 'BTCUSDT_PERP',
    interval: '1m',
  })
  compositor.acceptNative(native())
  compositor.acceptPreview(preview())

  const result = compositor.acceptNative(native({
    receivedAtMs: 2_100,
    revision: { epoch: 3, sequence: 9 },
    bar: { ...native().bar, close: 102, volume: 51 },
  }))

  assert.equal(result.reason, 'NATIVE_OPEN_DEFERRED_TO_PREVIEW')
  assert.equal(result.source, 'preview')
  assert.equal(result.bar?.close, 103)
  assert.equal(result.bar?.volume, 52)
})

test('volume-ahead Native OPEN waits until its close matches the settled trade', () => {
  const compositor = new ContractTradingViewPreviewCompositor({
    symbol: 'BTCUSDT_PERP',
    interval: '1m',
  })
  compositor.acceptNative(native())
  compositor.acceptPreview(preview())

  const ahead = compositor.acceptNative(native({
    receivedAtMs: 2_100,
    revision: { epoch: 3, sequence: 9 },
    bar: { ...native().bar, close: 102, volume: 53 },
  }))

  assert.equal(ahead.reason, 'NATIVE_OPEN_DEFERRED_TO_PREVIEW')
  assert.equal(ahead.source, 'preview')
  assert.equal(ahead.bar?.close, 103)
})

test('new Native baseline cannot release same-candle preview volume high-water', () => {
  const compositor = new ContractTradingViewPreviewCompositor({
    symbol: 'BTCUSDT_PERP',
    interval: '1m',
  })
  compositor.acceptNative(native())
  compositor.acceptPreview(preview({
    previewSequence: 4,
    bar: { ...preview().bar, close: 104, high: 104, volume: 80 },
  }))
  compositor.acceptNative(native({
    receivedAtMs: 3_000,
    revision: { epoch: 3, sequence: 9 },
    bar: { ...native().bar, close: 102, volume: 60 },
  }))

  const rollback = compositor.acceptPreview(preview({
    receivedAtMs: 4_000,
    previewSequence: 1,
    baseNativeRevision: { epoch: 3, sequence: 9 },
    bar: { ...preview().bar, close: 103, volume: 65 },
  }))
  const rebased = compositor.acceptPreview(preview({
    receivedAtMs: 4_010,
    previewSequence: 1,
    baseNativeRevision: { epoch: 3, sequence: 9 },
    bar: { ...preview().bar, close: 105, high: 105, volume: 81 },
  }))

  assert.equal(rollback.reason, 'PREVIEW_VOLUME_STALE')
  assert.equal(rebased.source, 'preview')
  assert.equal(rebased.bar?.close, 105)
  assert.equal(rebased.bar?.volume, 81)
})

test('closed Native candle wins and prevents preview reopening', () => {
  const compositor = new ContractTradingViewPreviewCompositor({
    symbol: 'BTCUSDT_PERP',
    interval: '1m',
  })
  compositor.acceptNative(native())
  compositor.acceptPreview(preview())
  const closed = compositor.acceptNative(native({
    isClosed: true,
    revision: { epoch: 3, sequence: 10 },
    receivedAtMs: 3_000,
    bar: { ...preview().bar, close: 102, volume: 53 },
  }))
  const late = compositor.acceptPreview(preview({
    previewSequence: 2,
    baseNativeRevision: { epoch: 3, sequence: 10 },
    receivedAtMs: 3_100,
    bar: { ...preview().bar, volume: 54 },
  }))

  assert.equal(closed.source, 'native')
  assert.equal(closed.bar?.volume, 53)
  assert.equal(late.reason, 'NATIVE_CLOSED')
})

test('generation, revision, volume and scope mismatches fail closed', () => {
  const compositor = new ContractTradingViewPreviewCompositor({
    symbol: 'BTCUSDT_PERP',
    interval: '1m',
  })
  compositor.acceptNative(native())

  assert.equal(
    compositor.acceptPreview(preview({ generation: 2 })).reason,
    'GENERATION_MISMATCH',
  )
  assert.equal(
    compositor.acceptPreview(preview({ baseNativeRevision: { epoch: 3, sequence: 7 } })).reason,
    'BASE_REVISION_STALE',
  )
  assert.equal(
    compositor.acceptPreview(preview({ bar: { ...preview().bar, volume: 49 } })).reason,
    'PREVIEW_VOLUME_STALE',
  )
  assert.equal(
    compositor.acceptPreview(preview({ symbol: 'ETHUSDT_PERP' })).reason,
    'SYMBOL_MISMATCH',
  )
  const sol = new ContractTradingViewPreviewCompositor({
    symbol: 'SOLUSDT_PERP',
    interval: '1m',
  })
  assert.equal(
    sol.acceptNative(native({ symbol: 'SOLUSDT_PERP' })).source,
    'native',
  )
  assert.equal(
    sol.acceptPreview(preview({ symbol: 'SOLUSDT_PERP' })).source,
    'preview',
  )
  assert.equal(
    new ContractTradingViewPreviewCompositor({
      symbol: 'SOLUSDT_PERP',
      interval: '5m',
    }).acceptNative(native({ symbol: 'SOLUSDT_PERP', interval: '5m' })).source,
    'native',
  )
  const fiveMinute = new ContractTradingViewPreviewCompositor({
    symbol: 'SOLUSDT_PERP',
    interval: '5m',
  })
  fiveMinute.acceptNative(native({ symbol: 'SOLUSDT_PERP', interval: '5m' }))
  assert.equal(
    fiveMinute.acceptPreview(preview({
      symbol: 'SOLUSDT_PERP',
      interval: '5m',
    })).source,
    'preview',
  )
  assert.equal(
    new ContractTradingViewPreviewCompositor({
      symbol: 'SOLUSDT_PERP',
      interval: '15m',
    }).acceptNative(native({ symbol: 'SOLUSDT_PERP', interval: '15m' })).reason,
    'UNSUPPORTED_SCOPE',
  )
})
