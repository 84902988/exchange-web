import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const modulePath = fileURLToPath(
  new URL('./spotTradingViewRealtimeSyncState.ts', import.meta.url),
)
const chartModulePath = fileURLToPath(
  new URL('../SpotTradingViewChart.tsx', import.meta.url),
)
const output = ts.transpileModule(readFileSync(modulePath, 'utf8'), {
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
const {
  beginSpotTradingViewRealtimeSync,
  isSpotTradingViewRealtimeSyncPending,
  settleSpotTradingViewRealtimeSync,
} = loadedModule.exports as typeof import('./spotTradingViewRealtimeSyncState')

const NOW = 1_800_000_000_000

function begin(interval = '1h', widgetGeneration = 7) {
  return beginSpotTradingViewRealtimeSync({
    symbol: 'ETHUSDT',
    interval,
    widgetGeneration,
  })
}

function realtimeEvent(overrides: Record<string, unknown> = {}) {
  return {
    symbol: 'ETHUSDT',
    interval: '1h',
    widgetGeneration: 7,
    source: 'LIVE_WS',
    freshness: 'LIVE',
    receivedAtMs: NOW - 100,
    ...overrides,
  }
}

test('a valid cold interval scope starts pending', () => {
  const state = begin()
  assert.equal(state.pending, true)
  assert.equal(isSpotTradingViewRealtimeSyncPending(state, {
    symbol: 'ETH/USDT',
    interval: '1h',
    widgetGeneration: 7,
  }), true)
})

test('fresh matching realtime candle settles the UX-only pending state', () => {
  const state = begin()
  const settled = settleSpotTradingViewRealtimeSync(
    state,
    realtimeEvent(),
    NOW,
  )
  assert.equal(settled.pending, false)
})

test('history and cached snapshots cannot settle realtime sync', () => {
  const state = begin()
  assert.equal(settleSpotTradingViewRealtimeSync(state, realtimeEvent({
    source: 'REST_HISTORY',
    freshness: 'CACHED',
  }), NOW), state)
  assert.equal(settleSpotTradingViewRealtimeSync(state, realtimeEvent({
    source: 'LIVE_WS',
    freshness: 'STALE',
  }), NOW), state)
})

test('stale symbol interval and widget callbacks cannot settle a newer scope', () => {
  const state = begin()
  for (const overrides of [
    { symbol: 'BTCUSDT' },
    { interval: '4h' },
    { widgetGeneration: 6 },
  ]) {
    assert.equal(
      settleSpotTradingViewRealtimeSync(state, realtimeEvent(overrides), NOW),
      state,
    )
  }
})

test('an old store replay remains pending until a fresh realtime candle arrives', () => {
  const state = begin()
  const oldReplay = settleSpotTradingViewRealtimeSync(state, realtimeEvent({
    receivedAtMs: NOW - 10_001,
  }), NOW)
  assert.equal(oldReplay, state)
  assert.equal(settleSpotTradingViewRealtimeSync(
    oldReplay,
    realtimeEvent({ receivedAtMs: NOW }),
    NOW,
  ).pending, false)
})

test('realtime sync UX remains a non-blocking status badge', () => {
  const chartSource = readFileSync(chartModulePath, 'utf8')
  const promptStart = chartSource.indexOf('{showRealtimeSync ? (')
  const promptEnd = chartSource.indexOf(') : null}', promptStart)

  assert.ok(promptStart >= 0)
  assert.ok(promptEnd > promptStart)

  const promptSource = chartSource.slice(promptStart, promptEnd)
  assert.match(promptSource, /pointer-events-none absolute right-3 top-12/)
  assert.doesNotMatch(promptSource, /\binset-0\b/)
  assert.doesNotMatch(promptSource, /backgroundImage/)
})
