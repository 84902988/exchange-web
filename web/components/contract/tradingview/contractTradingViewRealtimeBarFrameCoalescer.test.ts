import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

import type {
  ContractTradingViewRealtimeBarFrameCandidate,
} from './contractTradingViewRealtimeBarFrameCoalescer'

const coalescerPath = fileURLToPath(
  new URL('./contractTradingViewRealtimeBarFrameCoalescer.ts', import.meta.url),
)
const coalescerSource = readFileSync(coalescerPath, 'utf8')
const coalescerOutput = ts.transpileModule(coalescerSource, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: coalescerPath,
}).outputText
const loadedModule: { exports: Record<string, unknown> } = { exports: {} }
const execute = new Function('require', 'module', 'exports', coalescerOutput)
execute(() => undefined, loadedModule, loadedModule.exports)
const ContractTradingViewRealtimeBarFrameCoalescer = loadedModule.exports
  .ContractTradingViewRealtimeBarFrameCoalescer as typeof import(
    './contractTradingViewRealtimeBarFrameCoalescer'
  ).ContractTradingViewRealtimeBarFrameCoalescer

const OPEN_TIME = 1_710_000_060_000

function candidate(
  source: ContractTradingViewRealtimeBarFrameCandidate['source'],
  overrides: Partial<ContractTradingViewRealtimeBarFrameCandidate> = {},
): ContractTradingViewRealtimeBarFrameCandidate {
  return {
    symbol: 'SOLUSDT_PERP',
    interval: '1m',
    source,
    authority: source === 'preview' ? 'PREVIEW' : 'STORE',
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

function createHarness() {
  let nextTimer = 1
  const scheduled = new Map<number, () => void>()
  const outputs: ContractTradingViewRealtimeBarFrameCandidate[] = []
  const coalescer = new ContractTradingViewRealtimeBarFrameCoalescer({
    windowMs: 12,
    onFlush: (value) => outputs.push(value),
    schedule: (callback) => {
      const handle = nextTimer++
      scheduled.set(handle, callback)
      return handle
    },
    cancelSchedule: (handle) => scheduled.delete(Number(handle)),
  })
  const flushTimers = () => {
    while (scheduled.size) {
      const callbacks = Array.from(scheduled.entries()).sort(([left], [right]) => left - right)
      scheduled.clear()
      callbacks.forEach(([, callback]) => callback())
    }
  }
  return { coalescer, flushTimers, outputs, scheduled }
}

test('generic symbol Native to Preview emits only the complete Preview winner', () => {
  const harness = createHarness()
  const preview = candidate('preview', {
    bar: { time: OPEN_TIME, open: 100, high: 106, low: 98, close: 104, volume: 12 },
  })

  assert.equal(harness.coalescer.enqueue(candidate('native-open')), true)
  assert.equal(harness.coalescer.enqueue(preview), true)
  harness.flushTimers()

  assert.deepEqual(harness.outputs, [preview])
})

test('latest Preview replaces an earlier Preview in the same frame', () => {
  const harness = createHarness()
  const latest = candidate('preview', {
    bar: { time: OPEN_TIME, open: 100, high: 108, low: 98, close: 107, volume: 18 },
  })

  harness.coalescer.enqueue(candidate('preview'))
  harness.coalescer.enqueue(latest)
  harness.flushTimers()

  assert.deepEqual(harness.outputs, [latest])
})

test('Native CLOSED replaces pending Preview and flushes immediately', () => {
  const harness = createHarness()
  const closed = candidate('native-closed', {
    bar: { time: OPEN_TIME, open: 100, high: 105, low: 99, close: 102, volume: 14 },
  })

  harness.coalescer.enqueue(candidate('preview'))
  assert.equal(harness.coalescer.enqueue(closed), true)

  assert.deepEqual(harness.outputs, [closed])
  assert.equal(harness.scheduled.size, 0)
})

test('minute boundary flushes the previous key before the next current candle', () => {
  const harness = createHarness()
  const nextOpen = candidate('native-open', {
    bar: {
      time: OPEN_TIME + 60_000,
      open: 104,
      high: 104,
      low: 104,
      close: 104,
      volume: 0,
    },
  })

  harness.coalescer.enqueue(candidate('preview'))
  harness.coalescer.enqueue(nextOpen)
  harness.flushTimers()

  assert.deepEqual(harness.outputs, [candidate('preview'), nextOpen])
})

test('cancel prevents an old symbol frame from leaking after subscription teardown', () => {
  const harness = createHarness()

  harness.coalescer.enqueue(candidate('preview', { symbol: 'ETHUSDT_PERP' }))
  harness.coalescer.cancel()
  harness.flushTimers()

  assert.deepEqual(harness.outputs, [])
})
