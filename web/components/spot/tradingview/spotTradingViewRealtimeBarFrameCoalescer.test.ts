import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

import type {
  SpotTradingViewRealtimeBarFrameCandidate,
} from './spotTradingViewRealtimeBarFrameCoalescer'

const coalescerPath = fileURLToPath(
  new URL('./spotTradingViewRealtimeBarFrameCoalescer.ts', import.meta.url),
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
const SpotTradingViewRealtimeBarFrameCoalescer = loadedModule.exports
  .SpotTradingViewRealtimeBarFrameCoalescer as typeof import(
    './spotTradingViewRealtimeBarFrameCoalescer'
  ).SpotTradingViewRealtimeBarFrameCoalescer

const OPEN_TIME = 1_710_000_060_000

function candidate(
  source: SpotTradingViewRealtimeBarFrameCandidate['source'],
  overrides: Partial<SpotTradingViewRealtimeBarFrameCandidate> = {},
): SpotTradingViewRealtimeBarFrameCandidate {
  return {
    symbol: 'BTCUSDT',
    interval: '1m',
    source,
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
  const outputs: SpotTradingViewRealtimeBarFrameCandidate[] = []
  const coalescer = new SpotTradingViewRealtimeBarFrameCoalescer({
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

test('Native only emits one complete OHLCV bar after the frame window', () => {
  const harness = createHarness()

  assert.equal(harness.coalescer.enqueue(candidate('native-open')), true)
  assert.equal(harness.outputs.length, 0)
  harness.flushTimers()

  assert.deepEqual(harness.outputs, [candidate('native-open')])
})

test('Preview only emits one complete OHLCV bar after the frame window', () => {
  const harness = createHarness()
  const preview = candidate('preview', {
    bar: { time: OPEN_TIME, open: 100, high: 106, low: 98, close: 104, volume: 12 },
  })

  assert.equal(harness.coalescer.enqueue(preview), true)
  harness.flushTimers()

  assert.deepEqual(harness.outputs, [preview])
})

test('Native to Preview in the same frame keeps the later arbitrated Preview', () => {
  const harness = createHarness()
  const native = candidate('native-open')
  const preview = candidate('preview', {
    bar: { time: OPEN_TIME, open: 100, high: 106, low: 98, close: 104, volume: 12 },
  })

  assert.equal(harness.coalescer.enqueue(native), true)
  assert.equal(harness.coalescer.enqueue(preview), true)
  harness.flushTimers()

  assert.deepEqual(harness.outputs, [preview])
})

test('Preview to Native rebase in the same frame emits Native OPEN once', () => {
  const harness = createHarness()
  const preview = candidate('preview', {
    bar: { time: OPEN_TIME, open: 100, high: 106, low: 98, close: 104, volume: 12 },
  })
  const native = candidate('native-open', {
    bar: { time: OPEN_TIME, open: 100, high: 105, low: 99, close: 103, volume: 11 },
  })

  assert.equal(harness.coalescer.enqueue(preview), true)
  assert.equal(harness.coalescer.enqueue(native), true)
  harness.flushTimers()

  assert.deepEqual(harness.outputs, [native])
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

test('winner is emitted as one internally consistent OHLCV object', () => {
  const harness = createHarness()
  const preview = candidate('preview', {
    bar: { time: OPEN_TIME, open: 100, high: 109, low: 97, close: 108, volume: 27.5 },
  })

  harness.coalescer.enqueue(preview)
  harness.flushTimers()

  assert.deepEqual(harness.outputs[0]?.bar, {
    time: OPEN_TIME,
    open: 100,
    high: 109,
    low: 97,
    close: 108,
    volume: 27.5,
  })
})

test('minute boundary closes the old key before emitting the new open key', () => {
  const harness = createHarness()
  const closed = candidate('native-closed', {
    bar: { time: OPEN_TIME, open: 100, high: 106, low: 98, close: 104, volume: 30 },
  })
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
  harness.coalescer.enqueue(closed)
  harness.coalescer.enqueue(nextOpen)
  harness.flushTimers()

  assert.deepEqual(harness.outputs, [closed, nextOpen])
})
