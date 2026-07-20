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
  recordSpotTradingViewHistorySettlement,
  recordSpotTradingViewSubscriberSettlement,
} = loadedModule.exports as typeof import('./spotTradingViewRealtimeSyncState')

function begin(interval = '1h', widgetGeneration = 7) {
  return beginSpotTradingViewRealtimeSync({
    symbol: 'ETHUSDT',
    interval,
    widgetGeneration,
  })
}

function history(overrides: Record<string, unknown> = {}) {
  return {
    symbol: 'ETHUSDT',
    interval: '1h',
    widgetGeneration: 7,
    phase: 'current' as const,
    isHistoryRequest: false,
    barCount: 120,
    ...overrides,
  }
}

function subscriber(overrides: Record<string, unknown> = {}) {
  return {
    symbol: 'ETHUSDT',
    interval: '1h',
    widgetGeneration: 7,
    subscriberUid: 'subscriber-1',
    subscriptionGeneration: 3,
    ownerId: 'spot-tv:subscriber-1',
    ...overrides,
  }
}

test('cold bootstrap remains pending until current history and subscriber readiness both settle', () => {
  const initial = begin()
  const historyReady = recordSpotTradingViewHistorySettlement(initial, history())
  assert.equal(historyReady.historyReady, true)
  assert.equal(historyReady.subscriberReady, false)
  assert.equal(historyReady.pending, true)

  const settled = recordSpotTradingViewSubscriberSettlement(historyReady, subscriber())
  assert.equal(settled.pending, false)
  assert.equal(isSpotTradingViewRealtimeSyncPending(settled, {
    symbol: 'ETH/USDT',
    interval: '1h',
    widgetGeneration: 7,
  }), false)
})

test('silent market settles when subscriber readiness arrives before current history', () => {
  const subscriberReady = recordSpotTradingViewSubscriberSettlement(begin(), subscriber())
  assert.equal(subscriberReady.pending, true)
  assert.equal(recordSpotTradingViewHistorySettlement(subscriberReady, history()).pending, false)
})

test('empty continuation and stale scope evidence cannot settle a bootstrap', () => {
  const initial = begin()
  for (const event of [
    history({ barCount: 0 }),
    history({ phase: 'history', isHistoryRequest: true }),
    history({ symbol: 'BTCUSDT' }),
    history({ interval: '4h' }),
    history({ widgetGeneration: 6 }),
  ]) {
    assert.equal(recordSpotTradingViewHistorySettlement(initial, event), initial)
  }
  for (const event of [
    subscriber({ subscriberUid: '' }),
    subscriber({ subscriptionGeneration: 0 }),
    subscriber({ ownerId: '' }),
    subscriber({ symbol: 'BTCUSDT' }),
  ]) {
    assert.equal(recordSpotTradingViewSubscriberSettlement(initial, event), initial)
  }
})

test('chart keeps settlement observable without rendering a realtime syncing prompt', () => {
  const chartSource = readFileSync(chartModulePath, 'utf8')
  assert.match(chartSource, /data-spot-chart-realtime-sync=\{realtimeBootstrapPending \? 'pending' : 'ready'\}/)
  assert.doesNotMatch(chartSource, /spotChartRealtimeSyncing/)
  assert.doesNotMatch(chartSource, /\{showRealtimeSync \? \(/)
})
