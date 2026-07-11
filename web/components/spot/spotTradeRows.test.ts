import { describe, expect, it, jest } from '@jest/globals'
import type { SpotMarketTradeItem } from '@/lib/api/modules/spot'
import {
  sequenceSpotMarketDomainEvent,
  type SpotMarketDomainSequenceDecision,
  type SpotMarketDomainSequenceState,
} from './spotMarketDomainSequencer'
import {
  applySpotTradeReceivedAtMs,
  buildSpotTradeRenderRows,
  getLatestSpotTradeRow,
  getSpotTradeCollectionAction,
  getSpotTradeStrongIdentity,
  getSpotTradeTimeValue,
  getSpotTradeWeakFingerprint,
  limitSpotTradeRows,
  mergeSpotTradeIncrementalRow,
  mergeSpotTradeSnapshotRows,
  resolveSpotTradeBatchReceivedAtMs,
  resolveSpotTradeIncrementalReceivedAtMs,
  shouldApplySpotTradeAuthoritySideEffects,
  type SpotWeakDeliveryCounts,
} from './spotTradeRows'

const BASE = 1_720_000_000_000
const CONTEXT = { symbol: 'BTCUSDT', provider: 'OKX_SPOT', providerSymbol: 'BTC-USDT' }

function trade(options: {
  id?: string | number | null
  tradeId?: string | number | null
  providerTradeId?: string | number | null
  provider?: string
  providerSymbol?: string
  eventTimeMs?: number | null | 'absent'
  receivedAtMs?: number | null
  price?: string
  amount?: string
  side?: string
  ts?: number
} = {}): SpotMarketTradeItem {
  const row: SpotMarketTradeItem = {
    id: options.id,
    trade_id: options.tradeId,
    provider_trade_id: options.providerTradeId,
    provider: options.provider || 'OKX_SPOT',
    provider_symbol: options.providerSymbol || 'BTC-USDT',
    received_at_ms: options.receivedAtMs,
    price: options.price || '100',
    amount: options.amount || '1',
    side: options.side || 'BUY',
    ts: options.ts,
  }
  if (options.eventTimeMs !== 'absent') {
    row.event_time_ms = options.eventTimeMs === undefined ? BASE : options.eventTimeMs
  }
  return row
}

function strong(id: string | number, eventTimeMs = BASE): SpotMarketTradeItem {
  return trade({ providerTradeId: id, eventTimeMs, receivedAtMs: eventTimeMs + 100 })
}

function sequence(
  state: SpotMarketDomainSequenceState<SpotMarketTradeItem[]> | null,
  options: {
    provider: string
    eventTimeMs: number | null
    transport: 'rest' | 'ws_snapshot' | 'ws_incremental'
    source: string
    freshness: string
    rows: SpotMarketTradeItem[]
  },
): SpotMarketDomainSequenceDecision<SpotMarketTradeItem[]> {
  return sequenceSpotMarketDomainEvent(state, {
    symbol: 'BTCUSDT',
    domain: 'trades',
    provider: options.provider,
    eventTimeMs: options.eventTimeMs,
    receivedAtMs: BASE + 50_000,
    transport: options.transport,
    source: options.source,
    freshness: options.freshness,
    data: options.rows,
  })
}

describe('spot trade rows', () => {
  it('uses provider_trade_id, then trade_id, then id while preserving zero and provider scope', () => {
    expect(getSpotTradeStrongIdentity(trade({
      id: 'item',
      tradeId: 'trade',
      providerTradeId: 'provider',
    }), CONTEXT)).toContain('trade:provider')
    expect(getSpotTradeStrongIdentity(trade({ id: 'item', tradeId: 'trade' }), CONTEXT)).toContain('trade:trade')
    expect(getSpotTradeStrongIdentity(trade({ id: 0 }), CONTEXT)).toContain('trade:0')
    expect(getSpotTradeStrongIdentity(trade({ id: 'same', provider: 'OKX_SPOT' }), CONTEXT))
      .not.toBe(getSpotTradeStrongIdentity(
        trade({ id: 'same', provider: 'BITGET_SPOT' }),
        { ...CONTEXT, provider: 'BITGET_SPOT' },
      ))
  })

  it('keeps one strong row across snapshot and incremental while allowing field completion', () => {
    const snapshot = strong('same')
    const current = mergeSpotTradeSnapshotRows([], [snapshot], {
      symbol: 'BTCUSDT',
      incomingProvider: 'OKX_SPOT',
    })
    const incoming = { ...snapshot, source: 'LIVE_WS', freshness: 'LIVE', created_at: '2024-07-03T09:46:40' }
    const merged = mergeSpotTradeIncrementalRow(current, incoming, {}, {
      symbol: 'BTCUSDT',
      currentProvider: 'OKX_SPOT',
      incomingProvider: 'OKX_SPOT',
    })
    expect(merged.rows).toHaveLength(1)
    expect(merged.rows[0].source).toBe('LIVE_WS')
    expect(merged.addedOccurrence).toBe(false)
    expect(merged.strongDuplicate).toBe(true)
    expect(shouldApplySpotTradeAuthoritySideEffects({
      accepted: true,
      addedOccurrence: merged.addedOccurrence,
    })).toBe(false)
  })

  it('preserves weak snapshot multiplicity and prevents replay growth', () => {
    const weak = trade({ id: null, tradeId: null, providerTradeId: null })
    const two = mergeSpotTradeSnapshotRows([], [weak, { ...weak }], {
      symbol: 'BTCUSDT',
      incomingProvider: 'OKX_SPOT',
    })
    expect(two).toHaveLength(2)
    expect(mergeSpotTradeSnapshotRows(two, [weak, { ...weak }], {
      symbol: 'BTCUSDT', currentProvider: 'OKX_SPOT', incomingProvider: 'OKX_SPOT',
    })).toHaveLength(2)
    const three = mergeSpotTradeSnapshotRows(two, [weak, { ...weak }, { ...weak }], {
      symbol: 'BTCUSDT', currentProvider: 'OKX_SPOT', incomingProvider: 'OKX_SPOT',
    })
    expect(three).toHaveLength(3)
    expect(mergeSpotTradeSnapshotRows(three, [weak], {
      symbol: 'BTCUSDT', currentProvider: 'OKX_SPOT', incomingProvider: 'OKX_SPOT',
    })).toHaveLength(3)
  })

  it('excludes received, updated and compatibility ts from weak fingerprint', () => {
    const left = trade({
      eventTimeMs: null,
      receivedAtMs: BASE + 1,
      ts: BASE + 99_000,
    })
    const right = {
      ...left,
      received_at_ms: BASE + 2,
      updated_at_ms: BASE + 3,
      ts: BASE + 100_000,
    }
    expect(getSpotTradeWeakFingerprint(left, CONTEXT)).toBe(getSpotTradeWeakFingerprint(right, CONTEXT))
  })

  it('reconciles weak incremental occurrences with an existing snapshot', () => {
    const weak = trade({
      id: null,
      tradeId: null,
      providerTradeId: null,
      eventTimeMs: BASE,
      receivedAtMs: BASE + 500,
    })
    let rows: SpotMarketTradeItem[] = []
    let deliveryCounts: SpotWeakDeliveryCounts = {}
    let result = mergeSpotTradeIncrementalRow(rows, weak, deliveryCounts, {
      symbol: 'BTCUSDT', incomingProvider: 'OKX_SPOT',
    })
    rows = result.rows
    deliveryCounts = result.deliveryCounts
    result = mergeSpotTradeIncrementalRow(rows, { ...weak }, deliveryCounts, {
      symbol: 'BTCUSDT', currentProvider: 'OKX_SPOT', incomingProvider: 'OKX_SPOT',
    })
    expect(result.rows).toHaveLength(2)

    rows = mergeSpotTradeSnapshotRows([], [weak, { ...weak }], {
      symbol: 'BTCUSDT', incomingProvider: 'OKX_SPOT',
    })
    deliveryCounts = {}
    for (let index = 0; index < 2; index += 1) {
      result = mergeSpotTradeIncrementalRow(rows, { ...weak }, deliveryCounts, {
        symbol: 'BTCUSDT', currentProvider: 'OKX_SPOT', incomingProvider: 'OKX_SPOT',
      })
      rows = result.rows
      deliveryCounts = result.deliveryCounts
    }
    expect(rows).toHaveLength(2)
    result = mergeSpotTradeIncrementalRow(rows, { ...weak }, deliveryCounts, {
      symbol: 'BTCUSDT', currentProvider: 'OKX_SPOT', incomingProvider: 'OKX_SPOT',
    })
    expect(result.rows).toHaveLength(3)
    expect(result.addedOccurrence).toBe(true)
  })

  it('sorts timed globally before untimed and applies limit after sorting', () => {
    const rows = [
      strong('1000', BASE + 1_000),
      trade({ providerTradeId: 'untimed', eventTimeMs: null, receivedAtMs: BASE + 99_999, ts: BASE + 999_999 }),
      strong('3000', BASE + 3_000),
      strong('2000', BASE + 2_000),
    ]
    expect(limitSpotTradeRows(rows, CONTEXT).map((row) => row.provider_trade_id)).toEqual([
      '3000', '2000', '1000', 'untimed',
    ])
    expect(limitSpotTradeRows(rows, CONTEXT, 2).map((row) => row.provider_trade_id)).toEqual(['3000', '2000'])
    expect(getLatestSpotTradeRow(rows, CONTEXT)?.provider_trade_id).toBe('3000')
  })

  it('sorts all untimed rows only by received_at_ms', () => {
    const rows = [
      trade({ providerTradeId: '100', eventTimeMs: null, receivedAtMs: BASE + 100 }),
      trade({ providerTradeId: '300', eventTimeMs: null, receivedAtMs: BASE + 300 }),
      trade({ providerTradeId: '200', eventTimeMs: null, receivedAtMs: BASE + 200 }),
    ]
    expect(limitSpotTradeRows(rows, CONTEXT).map((row) => row.provider_trade_id)).toEqual(['300', '200', '100'])
  })

  it('separates safe rejected history collection merging from domain authority', () => {
    const ws = strong('ws', BASE + 2_000)
    const bootstrap = sequence(null, {
      provider: 'OKX_SPOT', eventTimeMs: BASE + 2_000, transport: 'ws_incremental',
      source: 'LIVE_WS', freshness: 'LIVE', rows: [ws],
    })
    const history = strong('history', BASE + 1_000)
    const rejected = sequence(bootstrap.state, {
      provider: 'OKX_SPOT', eventTimeMs: BASE + 1_000, transport: 'rest',
      source: 'REST', freshness: 'RECENT', rows: [history],
    })
    expect(rejected.accepted).toBe(false)
    expect(rejected.reason).toBe('older_event_time')
    expect(getSpotTradeCollectionAction({
      accepted: rejected.accepted,
      reason: rejected.reason,
      currentProvider: bootstrap.state.current?.provider,
      incomingProvider: 'OKX_SPOT',
    })).toBe('merge')
    const rows = mergeSpotTradeSnapshotRows([ws], [history], {
      symbol: 'BTCUSDT', currentProvider: 'OKX_SPOT', incomingProvider: 'OKX_SPOT',
    })
    expect(rows.map((row) => row.provider_trade_id)).toEqual(['ws', 'history'])
    expect(rejected.state.current?.eventTimeMs).toBe(BASE + 2_000)
    expect(getLatestSpotTradeRow(rows, CONTEXT)?.provider_trade_id).toBe('ws')
    expect(shouldApplySpotTradeAuthoritySideEffects({
      accepted: rejected.accepted,
      addedOccurrence: true,
    })).toBe(false)
  })

  it('keeps explicit untimed compatibility ts behind timed authority', () => {
    const timed = strong('timed', BASE + 2_000)
    const untimed = trade({
      providerTradeId: 'untimed', eventTimeMs: null, receivedAtMs: BASE + 99_999, ts: BASE + 999_999,
    })
    const current = sequence(null, {
      provider: 'OKX_SPOT', eventTimeMs: BASE + 2_000, transport: 'ws_incremental',
      source: 'LIVE_WS', freshness: 'LIVE', rows: [timed],
    })
    const rejected = sequence(current.state, {
      provider: 'OKX_SPOT', eventTimeMs: null, transport: 'rest',
      source: 'REST', freshness: 'RECENT', rows: [untimed],
    })
    expect(rejected.reason).toBe('missing_event_time')
    const rows = mergeSpotTradeSnapshotRows([timed], [untimed], {
      symbol: 'BTCUSDT', currentProvider: 'OKX_SPOT', incomingProvider: 'OKX_SPOT',
    })
    expect(rows.map((row) => row.provider_trade_id)).toEqual(['timed', 'untimed'])
  })

  it('preserves rows for empty snapshots and enforces provider switch boundaries', () => {
    const current = [strong('old')]
    expect(mergeSpotTradeSnapshotRows(current, [], {
      symbol: 'BTCUSDT', currentProvider: 'OKX_SPOT', incomingProvider: 'OKX_SPOT',
    })).toHaveLength(1)
    expect(getSpotTradeCollectionAction({
      accepted: true, reason: 'provider_switch', currentProvider: 'OKX_SPOT', incomingProvider: 'BITGET_SPOT',
    })).toBe('replace')
    expect(getSpotTradeCollectionAction({
      accepted: false, reason: 'retired_provider', currentProvider: 'BITGET_SPOT', incomingProvider: 'OKX_SPOT',
    })).toBe('ignore')
    expect(getSpotTradeCollectionAction({
      accepted: false, reason: 'provider_switch_rejected', currentProvider: 'OKX_SPOT', incomingProvider: 'BITGET_SPOT',
    })).toBe('ignore')
    const known = trade({ id: 'same', provider: 'OKX_SPOT' })
    const unknown = trade({ id: 'same', provider: 'UNKNOWN' })
    expect(mergeSpotTradeSnapshotRows([known], [unknown], {
      symbol: 'BTCUSDT', currentProvider: 'OKX_SPOT', incomingProvider: 'UNKNOWN',
    })).toHaveLength(1)
  })

  it('builds stable strong keys and unique weak occurrence keys', () => {
    const first = strong('first', BASE + 1_000)
    const second = strong('second', BASE + 2_000)
    const firstKeys = buildSpotTradeRenderRows([first, second], CONTEXT)
    const reorderedKeys = buildSpotTradeRenderRows([second, first], CONTEXT)
    expect(firstKeys.find((row) => row.trade === first)?.key)
      .toBe(reorderedKeys.find((row) => row.trade === first)?.key)

    const weak = trade({ id: null, tradeId: null, providerTradeId: null, receivedAtMs: BASE + 500 })
    const weakRows = buildSpotTradeRenderRows([weak, { ...weak }], CONTEXT)
    expect(new Set(weakRows.map((row) => row.key)).size).toBe(2)
    const replay = mergeSpotTradeSnapshotRows([weak, { ...weak }], [weak, { ...weak }], {
      symbol: 'BTCUSDT', currentProvider: 'OKX_SPOT', incomingProvider: 'OKX_SPOT',
    })
    expect(buildSpotTradeRenderRows(replay, CONTEXT).map((row) => row.key))
      .toEqual(weakRows.map((row) => row.key))
  })

  it('uses backend received_at_ms and only falls back locally for legacy incremental payloads', () => {
    const localClock = jest.fn(() => BASE + 3)
    expect(resolveSpotTradeIncrementalReceivedAtMs(
      trade({ receivedAtMs: BASE + 1 }),
      { received_at_ms: BASE + 2 },
      localClock,
    )).toBe(BASE + 1)
    expect(localClock).not.toHaveBeenCalled()
    expect(resolveSpotTradeIncrementalReceivedAtMs(
      trade({ receivedAtMs: null }),
      { received_at_ms: BASE + 2 },
      BASE + 3,
    )).toBe(BASE + 2)
    const legacy = trade({ receivedAtMs: undefined })
    delete legacy.received_at_ms
    expect(resolveSpotTradeIncrementalReceivedAtMs(legacy, {}, localClock)).toBe(BASE + 3)
    expect(localClock).toHaveBeenCalledTimes(1)
    expect(resolveSpotTradeIncrementalReceivedAtMs(
      trade({ receivedAtMs: null }),
      { received_at_ms: null },
      BASE + 3,
    )).toBeNull()
  })

  it('uses batch received time, then item maximum, then local fallback', () => {
    const rows = [trade({ receivedAtMs: BASE + 1 }), trade({ receivedAtMs: BASE + 2 })]
    expect(resolveSpotTradeBatchReceivedAtMs({ received_at_ms: BASE + 3 }, rows, BASE + 4)).toBe(BASE + 3)
    expect(resolveSpotTradeBatchReceivedAtMs({}, rows, BASE + 4)).toBe(BASE + 2)
    expect(resolveSpotTradeBatchReceivedAtMs({}, [], BASE + 4)).toBe(BASE + 4)
    expect(applySpotTradeReceivedAtMs([trade({ receivedAtMs: null })], BASE + 5)[0].received_at_ms).toBe(BASE + 5)
  })

  it('does not display compatibility ts for explicit untimed rows', () => {
    expect(getSpotTradeTimeValue(trade({ eventTimeMs: null, ts: BASE + 99_000 }))).toBeNull()
    const explicitCreated = trade({ eventTimeMs: null, ts: BASE + 99_000 })
    explicitCreated.created_at = '2024-07-03T09:46:40'
    expect(getSpotTradeTimeValue(explicitCreated)).toBe('2024-07-03T09:46:40')
    expect(getSpotTradeTimeValue(trade({ eventTimeMs: 'absent', ts: BASE + 99_000 }))).toBe(BASE + 99_000)
  })
})
