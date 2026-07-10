import type {
  SpotMarketTradeItem,
  SpotMarketView,
} from '@/lib/api/modules/spot'
import { applySpotMarketDomainEventToView } from './useSpotMarket'
import {
  extractSpotDepthEventTimeMs,
  extractSpotTickerEventTimeMs,
  extractSpotTradeEventTimeMs,
  extractSpotTradesEventTimeMs,
  getPresentSpotMarketDomains,
  getSpotMarketDomainHighWaterKey,
  sequenceSpotMarketDomainEvent,
  type SpotMarketDomain,
  type SpotMarketDomainEvent,
  type SpotMarketDomainSequenceState,
  type SpotMarketDomainTransport,
} from './spotMarketDomainSequencer'

type TestData = { value: string }

function makeEvent({
  symbol = 'BTCUSDT',
  domain = 'depth',
  provider = 'OKX_SPOT',
  eventTimeMs = 2_000,
  receivedAtMs = 10_000,
  transport = 'ws_incremental',
  source = 'LIVE_WS',
  freshness = 'LIVE',
  value = 'incoming',
}: {
  symbol?: string
  domain?: SpotMarketDomain
  provider?: string
  eventTimeMs?: number | null
  receivedAtMs?: number
  transport?: SpotMarketDomainTransport
  source?: string
  freshness?: string
  value?: string
} = {}): SpotMarketDomainEvent<TestData> {
  return {
    symbol,
    domain,
    provider,
    eventTimeMs,
    receivedAtMs,
    transport,
    source,
    freshness,
    data: { value },
  }
}

function bootstrap(overrides: Parameters<typeof makeEvent>[0] = {}) {
  return sequenceSpotMarketDomainEvent<TestData>(null, makeEvent(overrides)).state
}

describe('spot market domain sequencer', () => {
  it('rejects older REST depth after a newer WS incremental', () => {
    const state = bootstrap({ domain: 'depth', eventTimeMs: 2_000, value: 'ws-depth' })
    const decision = sequenceSpotMarketDomainEvent(state, makeEvent({
      domain: 'depth',
      eventTimeMs: 1_000,
      receivedAtMs: 20_000,
      transport: 'rest',
      source: 'REST',
      freshness: 'RECENT',
      value: 'rest-depth',
    }))

    expect(decision.accepted).toBe(false)
    expect(decision.reason).toBe('older_event_time')
    expect(decision.state).toBe(state)
    expect(decision.state.current?.data.value).toBe('ws-depth')
    expect(decision.state.current?.source).toBe('LIVE_WS')
    expect(decision.state.current?.freshness).toBe('LIVE')
  })

  it('rejects older REST trades after a newer WS trade', () => {
    const state = bootstrap({ domain: 'trades', eventTimeMs: 4_000, value: 'ws-trade' })
    const decision = sequenceSpotMarketDomainEvent(state, makeEvent({
      domain: 'trades',
      eventTimeMs: 3_000,
      transport: 'rest',
      source: 'REST',
      freshness: 'CACHED',
      value: 'rest-trades',
    }))

    expect(decision.accepted).toBe(false)
    expect(decision.state.current?.data.value).toBe('ws-trade')
  })

  it('rejects an older WS snapshot ticker after a newer incremental ticker', () => {
    const state = bootstrap({ domain: 'ticker', eventTimeMs: 8_000, value: 'ws-ticker' })
    const decision = sequenceSpotMarketDomainEvent(state, makeEvent({
      domain: 'ticker',
      eventTimeMs: 7_000,
      transport: 'ws_snapshot',
      value: 'snapshot-ticker',
    }))

    expect(decision.accepted).toBe(false)
    expect(decision.reason).toBe('older_event_time')
    expect(decision.state.current?.data.value).toBe('ws-ticker')
  })

  it('keeps incremental data over snapshot and REST at the same event time', () => {
    const state = bootstrap({ eventTimeMs: 5_000, transport: 'ws_incremental' })
    const snapshot = sequenceSpotMarketDomainEvent(state, makeEvent({
      eventTimeMs: 5_000,
      transport: 'ws_snapshot',
    }))
    const rest = sequenceSpotMarketDomainEvent(state, makeEvent({
      eventTimeMs: 5_000,
      transport: 'rest',
    }))

    expect(snapshot.accepted).toBe(false)
    expect(snapshot.reason).toBe('lower_transport_priority')
    expect(rest.accepted).toBe(false)
    expect(rest.reason).toBe('lower_transport_priority')
  })

  it('accepts incremental over REST at the same event time without freshness loss', () => {
    const state = bootstrap({
      eventTimeMs: 5_000,
      transport: 'rest',
      source: 'REST',
      freshness: 'RECENT',
    })
    const decision = sequenceSpotMarketDomainEvent(state, makeEvent({
      eventTimeMs: 5_000,
      transport: 'ws_incremental',
      source: 'LIVE_WS',
      freshness: 'LIVE',
    }))

    expect(decision.accepted).toBe(true)
    expect(decision.reason).toBe('higher_transport_priority')
  })

  it('does not downgrade freshness at equal event time and transport', () => {
    const state = bootstrap({
      eventTimeMs: 5_000,
      transport: 'ws_snapshot',
      freshness: 'LIVE',
    })
    const recent = sequenceSpotMarketDomainEvent(state, makeEvent({
      eventTimeMs: 5_000,
      transport: 'ws_snapshot',
      freshness: 'RECENT',
    }))
    const stale = sequenceSpotMarketDomainEvent(state, makeEvent({
      eventTimeMs: 5_000,
      transport: 'ws_snapshot',
      freshness: 'STALE',
    }))

    expect(recent.accepted).toBe(false)
    expect(recent.reason).toBe('freshness_downgrade')
    expect(stale.accepted).toBe(false)
    expect(stale.reason).toBe('freshness_downgrade')
  })

  it('accepts a newer REST event time from the same provider', () => {
    const state = bootstrap({ eventTimeMs: 5_000 })
    const decision = sequenceSpotMarketDomainEvent(state, makeEvent({
      eventTimeMs: 6_000,
      transport: 'rest',
      source: 'REST',
      freshness: 'RECENT',
      value: 'newer-rest',
    }))

    expect(decision.accepted).toBe(true)
    expect(decision.reason).toBe('newer_event_time')
    expect(decision.state.current?.data.value).toBe('newer-rest')
  })

  it('allows an untimed cold-start bootstrap', () => {
    const decision = sequenceSpotMarketDomainEvent(null, makeEvent({
      eventTimeMs: null,
      transport: 'rest',
      freshness: 'CACHED',
    }))

    expect(decision.accepted).toBe(true)
    expect(decision.reason).toBe('bootstrap')
    expect(decision.state.current?.eventTimeMs).toBeNull()
  })

  it('does not let untimed data overwrite timed live state', () => {
    const state = bootstrap({ eventTimeMs: 5_000 })
    const decision = sequenceSpotMarketDomainEvent(state, makeEvent({
      eventTimeMs: null,
      receivedAtMs: 50_000,
      transport: 'ws_snapshot',
    }))

    expect(decision.accepted).toBe(false)
    expect(decision.reason).toBe('missing_event_time')
    expect(decision.state.current?.eventTimeMs).toBe(5_000)
  })

  it('isolates high-water state across BTC, ETH, and domains', () => {
    const states = new Map<string, SpotMarketDomainSequenceState<TestData>>()
    const apply = (event: SpotMarketDomainEvent<TestData>) => {
      const key = getSpotMarketDomainHighWaterKey(event.symbol, event.domain)
      const decision = sequenceSpotMarketDomainEvent(states.get(key), event)
      if (decision.accepted) states.set(key, decision.state)
      return decision
    }

    expect(apply(makeEvent({ symbol: 'BTCUSDT', domain: 'depth', eventTimeMs: 9_000 })).accepted).toBe(true)
    expect(apply(makeEvent({ symbol: 'ETHUSDT', domain: 'depth', eventTimeMs: 1_000 })).accepted).toBe(true)
    expect(apply(makeEvent({ symbol: 'BTCUSDT', domain: 'ticker', eventTimeMs: 1_000 })).accepted).toBe(true)
    expect(apply(makeEvent({ symbol: 'BTCUSDT', domain: 'depth', eventTimeMs: 8_000 })).accepted).toBe(false)
    expect(states.get('BTCUSDT|depth')?.current?.eventTimeMs).toBe(9_000)
    expect(states.get('ETHUSDT|depth')?.current?.eventTimeMs).toBe(1_000)
    expect(states.get('BTCUSDT|ticker')?.current?.eventTimeMs).toBe(1_000)
  })

  it('identifies only domains actually present in a partial snapshot', () => {
    const existingTrades = bootstrap({ domain: 'trades', value: 'keep-trades' })
    const presentDomains = getPresentSpotMarketDomains({
      type: 'spot_market_snapshot',
      depth: { bids: [], asks: [] },
    })

    expect(presentDomains).toEqual(['depth'])
    expect(existingTrades.current?.data.value).toBe('keep-trades')
  })

  it('keeps a newer active last trade price when an old ticker is rejected', () => {
    const trade: SpotMarketTradeItem = {
      price: '101',
      amount: '1',
      side: 'BUY',
      ts: 10,
    }
    const tradeDecision = sequenceSpotMarketDomainEvent<SpotMarketTradeItem[]>(null, {
      symbol: 'BTCUSDT',
      domain: 'trades',
      provider: 'OKX_SPOT',
      eventTimeMs: 10_000,
      receivedAtMs: 10_100,
      transport: 'ws_incremental',
      source: 'LIVE_WS',
      freshness: 'LIVE',
      data: [trade],
    })
    const view: SpotMarketView = applySpotMarketDomainEventToView(
      { symbol: 'BTCUSDT' },
      tradeDecision.state.current!,
    )
    const tickerState = bootstrap({ domain: 'ticker', eventTimeMs: 12_000, value: 'new-ticker' })
    const oldTicker = sequenceSpotMarketDomainEvent(tickerState, makeEvent({
      domain: 'ticker',
      eventTimeMs: 9_000,
      transport: 'ws_snapshot',
      value: 'old-ticker',
    }))

    expect(oldTicker.accepted).toBe(false)
    expect(view.display_price).toBe('101')
    expect(view.display_price_source).toBe('last_trade')
  })

  it('does not let fresh OKX WS state be overwritten by Bitget REST', () => {
    const state = bootstrap({ provider: 'OKX_SPOT', eventTimeMs: 5_000 })
    const decision = sequenceSpotMarketDomainEvent(state, makeEvent({
      provider: 'BITGET_SPOT',
      eventTimeMs: 99_000,
      transport: 'rest',
      source: 'REST',
      freshness: 'RECENT',
    }))

    expect(decision.accepted).toBe(false)
    expect(decision.reason).toBe('provider_switch_rejected')
    expect(decision.state.current?.provider).toBe('OKX_SPOT')
  })

  it('allows fresh Bitget WS to take over stale OKX state', () => {
    const state = bootstrap({
      provider: 'OKX_SPOT',
      source: 'LIVE_WS',
      freshness: 'STALE',
    })
    const decision = sequenceSpotMarketDomainEvent(state, makeEvent({
      provider: 'BITGET_SPOT',
      eventTimeMs: 1_000,
      source: 'LIVE_WS',
      freshness: 'LIVE',
      transport: 'ws_incremental',
    }))

    expect(decision.accepted).toBe(true)
    expect(decision.reason).toBe('provider_switch')
    expect(decision.state.current?.provider).toBe('BITGET_SPOT')
    expect(decision.state.retiredProviders).toContain('OKX_SPOT')
  })

  it('does not switch back to a retired provider on a late event', () => {
    const staleOkx = bootstrap({
      provider: 'OKX_SPOT',
      freshness: 'STALE',
    })
    const bitget = sequenceSpotMarketDomainEvent(staleOkx, makeEvent({
      provider: 'BITGET_SPOT',
      source: 'LIVE_WS',
      freshness: 'LIVE',
    })).state
    const lateOkx = sequenceSpotMarketDomainEvent(bitget, makeEvent({
      provider: 'OKX_SPOT',
      eventTimeMs: 99_000,
      source: 'LIVE_WS',
      freshness: 'LIVE',
    }))

    expect(lateOkx.accepted).toBe(false)
    expect(lateOkx.reason).toBe('retired_provider')
    expect(lateOkx.state.current?.provider).toBe('BITGET_SPOT')
  })

  it('extracts provider event times without using receive or market-view assembly time', () => {
    expect(extractSpotDepthEventTimeMs({ ts: 11, updated_at_ms: 99 })).toBe(11_000)
    expect(extractSpotTickerEventTimeMs({ event_time_ms: 1_720_000_012_000 })).toBe(1_720_000_012_000)
    expect(extractSpotTradeEventTimeMs({ time: '2026-07-11T01:00:00' })).toBe(
      Date.parse('2026-07-11T01:00:00Z'),
    )
    expect(extractSpotTradesEventTimeMs([
      { ts: 10 },
      { ts: 12 },
      { ts: 11 },
    ])).toBe(12_000)
    expect(extractSpotTradesEventTimeMs([])).toBeNull()
    expect(extractSpotDepthEventTimeMs({ updated_at: '2026-07-11T01:00:00' })).toBeNull()
  })
})
