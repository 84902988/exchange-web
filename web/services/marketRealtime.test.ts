/* eslint-disable @typescript-eslint/no-explicit-any -- Dynamic harness exercises private dispatch without exporting it. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

function loadMarketRealtimeModule(): Record<string, any> {
  const filePath = fileURLToPath(new URL('./marketRealtime.ts', import.meta.url))
  const output = ts.transpileModule(readFileSync(filePath, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: filePath,
  }).outputText
  const loadedModule: { exports: Record<string, any> } = { exports: {} }
  const mocks: Record<string, unknown> = {
    '@/lib/api/core/baseUrl': { getRuntimeApiBaseUrl: () => 'http://127.0.0.1:8000' },
    '@/components/spot/tradingview/spotKlinePerf': { markSpotKlinePerf: () => undefined },
    '@/lib/realtime/spotMarketStore.transport': {
      attachSpotMarketStoreTransportMirror: () => undefined,
    },
  }
  const execute = new Function('require', 'module', 'exports', output)
  execute(
    (specifier: string) => mocks[specifier],
    loadedModule,
    loadedModule.exports,
  )
  return loadedModule.exports
}

test('preview messages ride only the matching active kline interval', () => {
  const { spotMarketRealtime } = loadMarketRealtimeModule()
  const messages: Array<Record<string, unknown>> = []
  const unsubscribe = spotMarketRealtime.subscribe(
    'preview',
    (message: Record<string, unknown>) => messages.push(message),
  )
  const connection = {
    symbol: 'BTCUSDT',
    domains: new Map(),
    klineIntervals: new Map([['1m', new Set(['tv-owner'])]]),
  }
  const preview = {
    type: 'spot_candle_preview_update',
    symbol: 'BTCUSDT',
    interval: '1m',
    preview: { interval: '1m' },
  }

  spotMarketRealtime.dispatch(preview, connection)
  spotMarketRealtime.dispatch({ ...preview, interval: '5m' }, connection)
  spotMarketRealtime.dispatch({ ...preview, symbol: 'ETHUSDT' }, connection)

  assert.deepEqual(messages, [preview])
  unsubscribe()
})

test('trade settlement emits embedded preview before trade in one websocket task', () => {
  const { spotMarketRealtime } = loadMarketRealtimeModule()
  const events: string[] = []
  const previews: unknown[] = []
  const trades: unknown[] = []
  const releasePreview = spotMarketRealtime.subscribe('preview', (message: unknown) => {
    events.push('preview')
    previews.push(message)
  })
  const releaseTrade = spotMarketRealtime.subscribe('trade', (message: unknown) => {
    events.push('trade')
    trades.push(message)
  })
  const connection = {
    symbol: 'BTCUSDT',
    domains: new Map([['trades', new Set(['market-owner'])]]),
    klineIntervals: new Map([['1m', new Set(['tv-owner'])]]),
  }
  const preview = {
    type: 'spot_candle_preview_update',
    symbol: 'BTCUSDT',
    interval: '1m',
    settlement_revision: 'spot:BTCUSDT:1m:3:1:3:8:1',
    preview: { close: '101', volume: '11' },
  }
  const trade = {
    type: 'spot_trade',
    symbol: 'BTCUSDT',
    settlement_revision: preview.settlement_revision,
    trade: { id: 'trade-1', price: '101', amount: '1' },
    candle_preview: preview,
  }

  spotMarketRealtime.dispatch(trade, connection)

  assert.deepEqual(events, ['preview', 'trade'])
  assert.deepEqual(previews, [preview])
  assert.deepEqual(trades, [trade])
  releaseTrade()
  releasePreview()
})
