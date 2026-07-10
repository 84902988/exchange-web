export type SpotMarketDomain = 'ticker' | 'depth' | 'trades'

export type SpotMarketDomainTransport = 'ws_incremental' | 'ws_snapshot' | 'rest'

export type SpotMarketDomainEvent<T = unknown> = {
  symbol: string
  domain: SpotMarketDomain
  provider?: string | null
  eventTimeMs?: number | null
  receivedAtMs: number
  transport: SpotMarketDomainTransport
  source?: string | null
  freshness?: string | null
  data: T
}

export type NormalizedSpotMarketDomainEvent<T = unknown> = Omit<
  SpotMarketDomainEvent<T>,
  'symbol' | 'provider' | 'eventTimeMs' | 'source' | 'freshness'
> & {
  symbol: string
  provider: string
  eventTimeMs: number | null
  source: string
  freshness: string
}

export type SpotMarketDomainSequenceState<T = unknown> = {
  current: NormalizedSpotMarketDomainEvent<T> | null
  retiredProviders: readonly string[]
}

export type SpotMarketDomainSequenceDecision<T = unknown> = {
  accepted: boolean
  reason:
    | 'bootstrap'
    | 'newer_event_time'
    | 'higher_transport_priority'
    | 'same_rank_update'
    | 'provider_switch'
    | 'older_event_time'
    | 'missing_event_time'
    | 'lower_transport_priority'
    | 'freshness_downgrade'
    | 'retired_provider'
    | 'provider_switch_rejected'
  state: SpotMarketDomainSequenceState<T>
}

const TRANSPORT_PRIORITY: Record<SpotMarketDomainTransport, number> = {
  rest: 1,
  ws_snapshot: 2,
  ws_incremental: 3,
}

const DOMAIN_NAMES: readonly SpotMarketDomain[] = ['ticker', 'depth', 'trades']

function normalizeText(value: unknown, fallback: string): string {
  const normalized = String(value ?? '').trim().toUpperCase()
  return normalized || fallback
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function freshnessRank(value: string): number {
  switch (value) {
    case 'LIVE':
      return 4
    case 'RECENT':
    case 'CACHED':
      return 3
    case 'STALE':
    case 'LAST_GOOD':
    case 'LAST_VALID':
      return 2
    case 'MISSING':
    case 'UNKNOWN':
    case 'EMPTY':
    default:
      return 1
  }
}

function isWeakDomainState(event: NormalizedSpotMarketDomainEvent): boolean {
  return (
    freshnessRank(event.freshness) <= 2 ||
    ['MISSING', 'UNKNOWN', 'STALE', 'LAST_GOOD', 'LAST_VALID', 'EMPTY'].includes(event.source)
  )
}

function isFreshLiveIncremental(event: NormalizedSpotMarketDomainEvent): boolean {
  return (
    event.transport === 'ws_incremental' &&
    event.source === 'LIVE_WS' &&
    event.freshness === 'LIVE'
  )
}

function normalizeIncomingEvent<T>(
  incoming: SpotMarketDomainEvent<T>,
): NormalizedSpotMarketDomainEvent<T> {
  const eventTimeMs = Number(incoming.eventTimeMs)
  return {
    ...incoming,
    symbol: String(incoming.symbol || '').trim().toUpperCase(),
    provider: normalizeText(incoming.provider, 'UNKNOWN'),
    eventTimeMs: Number.isFinite(eventTimeMs) && eventTimeMs > 0 ? eventTimeMs : null,
    source: normalizeText(incoming.source, 'UNKNOWN'),
    freshness: normalizeText(incoming.freshness, 'UNKNOWN'),
  }
}

function acceptedState<T>(
  state: SpotMarketDomainSequenceState<T>,
  incoming: NormalizedSpotMarketDomainEvent<T>,
  reason: SpotMarketDomainSequenceDecision<T>['reason'],
  retiredProviders: readonly string[] = state.retiredProviders,
): SpotMarketDomainSequenceDecision<T> {
  return {
    accepted: true,
    reason,
    state: {
      current: incoming,
      retiredProviders,
    },
  }
}

function rejectedState<T>(
  state: SpotMarketDomainSequenceState<T>,
  reason: SpotMarketDomainSequenceDecision<T>['reason'],
): SpotMarketDomainSequenceDecision<T> {
  return {
    accepted: false,
    reason,
    state,
  }
}

export function getSpotMarketDomainHighWaterKey(
  symbol: string,
  domain: SpotMarketDomain,
): string {
  return `${String(symbol || '').trim().toUpperCase()}|${domain}`
}

export function getPresentSpotMarketDomains(payload: unknown): SpotMarketDomain[] {
  const record = asRecord(payload)
  if (!record) return []

  return DOMAIN_NAMES.filter((domain) => Object.prototype.hasOwnProperty.call(record, domain))
}

export function normalizeSpotMarketEventTimeMs(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null

  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null
    return value < 1e12 ? value * 1000 : value
  }

  const text = String(value).trim()
  if (!text) return null

  const numericValue = Number(text)
  if (Number.isFinite(numericValue) && numericValue > 0) {
    return numericValue < 1e12 ? numericValue * 1000 : numericValue
  }

  const isoText = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text) ? text : `${text}Z`
  const parsed = Date.parse(isoText)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function extractEventTimeFromRecord(
  payload: unknown,
  fields: readonly string[],
): number | null {
  const record = asRecord(payload)
  if (!record) return null

  for (const field of fields) {
    const eventTimeMs = normalizeSpotMarketEventTimeMs(record[field])
    if (eventTimeMs !== null) return eventTimeMs
  }
  return null
}

export function extractSpotDepthEventTimeMs(payload: unknown): number | null {
  return extractEventTimeFromRecord(payload, [
    'ts',
    'event_time_ms',
    'event_time',
    'updated_at_ms',
  ])
}

export function extractSpotTickerEventTimeMs(payload: unknown): number | null {
  return extractEventTimeFromRecord(payload, [
    'ts',
    'event_time_ms',
    'event_time',
    'updated_at_ms',
  ])
}

export function extractSpotTradeEventTimeMs(payload: unknown): number | null {
  return extractEventTimeFromRecord(payload, [
    'ts',
    'event_time_ms',
    'event_time',
    'trade_time',
    'time',
    'updated_at_ms',
    'created_at',
  ])
}

export function extractSpotTradesEventTimeMs(payload: unknown): number | null {
  if (!Array.isArray(payload) || payload.length === 0) return null

  let latestEventTimeMs: number | null = null
  for (const trade of payload) {
    const eventTimeMs = extractSpotTradeEventTimeMs(trade)
    if (eventTimeMs !== null && (latestEventTimeMs === null || eventTimeMs > latestEventTimeMs)) {
      latestEventTimeMs = eventTimeMs
    }
  }
  return latestEventTimeMs
}

export function sequenceSpotMarketDomainEvent<T>(
  currentState: SpotMarketDomainSequenceState<T> | null | undefined,
  incomingEvent: SpotMarketDomainEvent<T>,
): SpotMarketDomainSequenceDecision<T> {
  const incoming = normalizeIncomingEvent(incomingEvent)
  const state: SpotMarketDomainSequenceState<T> = currentState || {
    current: null,
    retiredProviders: [],
  }
  const current = state.current

  if (!current) {
    return acceptedState(state, incoming, 'bootstrap')
  }

  if (current.provider !== incoming.provider) {
    if (state.retiredProviders.includes(incoming.provider)) {
      return rejectedState(state, 'retired_provider')
    }

    const currentFreshnessRank = freshnessRank(current.freshness)
    const incomingFreshnessRank = freshnessRank(incoming.freshness)
    const maySwitch = (
      isFreshLiveIncremental(incoming) ||
      (isWeakDomainState(current) && incomingFreshnessRank > currentFreshnessRank)
    )
    if (!maySwitch) {
      return rejectedState(state, 'provider_switch_rejected')
    }

    const retiredProviders = current.provider === 'UNKNOWN'
      ? state.retiredProviders
      : Array.from(new Set([...state.retiredProviders, current.provider]))
    return acceptedState(state, incoming, 'provider_switch', retiredProviders)
  }

  const currentTime = current.eventTimeMs
  const incomingTime = incoming.eventTimeMs
  if (currentTime !== null && incomingTime === null) {
    return rejectedState(state, 'missing_event_time')
  }
  if (currentTime === null && incomingTime !== null) {
    return acceptedState(state, incoming, 'newer_event_time')
  }
  if (currentTime !== null && incomingTime !== null) {
    if (incomingTime > currentTime) {
      return acceptedState(state, incoming, 'newer_event_time')
    }
    if (incomingTime < currentTime) {
      return rejectedState(state, 'older_event_time')
    }
  }

  const currentTransportRank = TRANSPORT_PRIORITY[current.transport]
  const incomingTransportRank = TRANSPORT_PRIORITY[incoming.transport]
  if (incomingTransportRank < currentTransportRank) {
    return rejectedState(state, 'lower_transport_priority')
  }

  if (freshnessRank(incoming.freshness) < freshnessRank(current.freshness)) {
    return rejectedState(state, 'freshness_downgrade')
  }

  if (incomingTransportRank > currentTransportRank) {
    return acceptedState(state, incoming, 'higher_transport_priority')
  }
  return acceptedState(state, incoming, 'same_rank_update')
}
