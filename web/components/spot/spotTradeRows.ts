import type { SpotMarketTradeItem } from '@/lib/api/modules/spot'
import {
  extractSpotTradeEventTimeMs,
  type SpotMarketDomainSequenceDecision,
} from './spotMarketDomainSequencer'

export const SPOT_TRADE_ROWS_LIMIT = 30

export type SpotTradeRowsContext = {
  symbol: string
  provider?: unknown
  providerSymbol?: unknown
}

export type SpotTradeCollectionAction = 'merge' | 'replace' | 'ignore'

export type SpotWeakDeliveryCounts = Readonly<Record<string, number>>

export type SpotTradeIncrementalMergeResult = {
  rows: SpotMarketTradeItem[]
  deliveryCounts: SpotWeakDeliveryCounts
  addedOccurrence: boolean
  strongDuplicate: boolean
}

export type SpotTradeRenderRow = {
  trade: SpotMarketTradeItem
  key: string
}

const SAFE_HISTORY_REASONS = new Set<SpotMarketDomainSequenceDecision['reason']>([
  'older_event_time',
  'missing_event_time',
  'lower_transport_priority',
  'freshness_downgrade',
])

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function text(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const normalized = String(value).trim()
  return normalized ? normalized : null
}

function normalizedSymbol(value: unknown): string {
  return String(value ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
}

function normalizedProvider(value: unknown): string {
  return text(value)?.toUpperCase() || 'UNKNOWN'
}

function normalizedProviderSymbol(value: unknown): string {
  return text(value)?.toUpperCase() || 'UNKNOWN'
}

function providerFor(trade: SpotMarketTradeItem, fallback: unknown): string {
  const itemProvider = normalizedProvider(trade.provider)
  return itemProvider === 'UNKNOWN' ? normalizedProvider(fallback) : itemProvider
}

function providerSymbolFor(trade: SpotMarketTradeItem, fallback: unknown): string {
  const itemProviderSymbol = normalizedProviderSymbol(trade.provider_symbol)
  return itemProviderSymbol === 'UNKNOWN'
    ? normalizedProviderSymbol(fallback)
    : itemProviderSymbol
}

function normalizeReceivedAtMs(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const normalized = Number(value)
  return Number.isFinite(normalized) && normalized >= 0 ? normalized : null
}

function sameReceivedAtMs(left: number | null, right: number | null): boolean {
  return left === right
}

function completeness(trade: SpotMarketTradeItem): number {
  const record = trade as Record<string, unknown>
  return [
    'provider_trade_id',
    'trade_id',
    'id',
    'event_time_ms',
    'received_at_ms',
    'time_origin',
    'created_at',
    'provider',
    'provider_symbol',
    'source',
    'freshness',
    'price',
    'amount',
    'side',
  ].reduce((count, key) => count + (text(record[key]) !== null ? 1 : 0), 0)
}

function preference(trade: SpotMarketTradeItem): readonly [number, number, number] {
  return [
    completeness(trade),
    getSpotTradeReceivedAtMs(trade) ?? -1,
    extractSpotTradeEventTimeMs(trade) ?? -1,
  ]
}

function comparePreference(left: SpotMarketTradeItem, right: SpotMarketTradeItem): number {
  const leftPreference = preference(left)
  const rightPreference = preference(right)
  for (let index = 0; index < leftPreference.length; index += 1) {
    if (leftPreference[index] !== rightPreference[index]) {
      return leftPreference[index] - rightPreference[index]
    }
  }
  return 0
}

function mergeStrongTrade(
  current: SpotMarketTradeItem,
  incoming: SpotMarketTradeItem,
): SpotMarketTradeItem {
  const preferred = comparePreference(incoming, current) > 0 ? incoming : current
  const secondary = preferred === incoming ? current : incoming
  const merged: Record<string, unknown> = { ...secondary }
  for (const [key, value] of Object.entries(preferred)) {
    if (value !== null && value !== undefined && value !== '') merged[key] = value
  }
  return merged as SpotMarketTradeItem
}

function groupWeakRows(
  rows: readonly SpotMarketTradeItem[],
  context: SpotTradeRowsContext,
): Map<string, SpotMarketTradeItem[]> {
  const grouped = new Map<string, SpotMarketTradeItem[]>()
  for (const trade of rows) {
    if (getSpotTradeStrongIdentity(trade, context)) continue
    const fingerprint = getSpotTradeWeakFingerprint(trade, context)
    const bucket = grouped.get(fingerprint) || []
    bucket.push(trade)
    grouped.set(fingerprint, bucket)
  }
  return grouped
}

function alignedFallbacks(
  currentValue: unknown,
  incomingValue: unknown,
  normalize: (value: unknown) => string,
): readonly [string, string] {
  const current = normalize(currentValue)
  const incoming = normalize(incomingValue)
  return [
    current === 'UNKNOWN' ? incoming : current,
    incoming === 'UNKNOWN' ? current : incoming,
  ]
}

export function getSpotTradeStrongIdentity(
  trade: SpotMarketTradeItem,
  context: SpotTradeRowsContext,
): string | null {
  const provider = providerFor(trade, context.provider)
  const record = trade as Record<string, unknown>
  for (const field of ['provider_trade_id', 'trade_id', 'id'] as const) {
    const identity = text(record[field])
    if (identity !== null) {
      return `${normalizedSymbol(context.symbol)}|provider:${provider}|trade:${identity}`
    }
  }
  return null
}

export function getSpotTradeWeakFingerprint(
  trade: SpotMarketTradeItem,
  context: SpotTradeRowsContext,
): string {
  const eventTimeMs = extractSpotTradeEventTimeMs(trade)
  return `weak:${JSON.stringify([
    normalizedSymbol(context.symbol),
    providerFor(trade, context.provider),
    providerSymbolFor(trade, context.providerSymbol),
    eventTimeMs ?? 'UNTIMED',
    text(trade.price) || '',
    text(trade.amount) || '',
    (text(trade.side) || '').toUpperCase(),
  ])}`
}

export function getSpotTradeIdentity(
  trade: SpotMarketTradeItem,
  context: SpotTradeRowsContext,
): string {
  return getSpotTradeStrongIdentity(trade, context) || getSpotTradeWeakFingerprint(trade, context)
}

export function getSpotTradeReceivedAtMs(trade: SpotMarketTradeItem): number | null {
  return normalizeReceivedAtMs(trade.received_at_ms)
}

export function resolveSpotTradeIncrementalReceivedAtMs(
  trade: SpotMarketTradeItem,
  message: unknown,
  fallbackReceivedAtMs: number | (() => number),
): number | null {
  const tradeRecord = asRecord(trade)
  const messageRecord = asRecord(message)
  const tradeReceivedAtMs = getSpotTradeReceivedAtMs(trade)
  if (tradeReceivedAtMs !== null) return tradeReceivedAtMs
  const messageReceivedAtMs = normalizeReceivedAtMs(messageRecord?.received_at_ms)
  if (messageReceivedAtMs !== null) return messageReceivedAtMs
  const hasExplicitReceivedAt = Boolean(
    tradeRecord && Object.prototype.hasOwnProperty.call(tradeRecord, 'received_at_ms'),
  ) || Boolean(
    messageRecord && Object.prototype.hasOwnProperty.call(messageRecord, 'received_at_ms'),
  )
  if (hasExplicitReceivedAt) return null
  return typeof fallbackReceivedAtMs === 'function'
    ? fallbackReceivedAtMs()
    : fallbackReceivedAtMs
}

export function resolveSpotTradeBatchReceivedAtMs(
  batch: unknown,
  rows: readonly SpotMarketTradeItem[],
  fallbackReceivedAtMs: number,
): number {
  const batchReceivedAtMs = normalizeReceivedAtMs(asRecord(batch)?.received_at_ms)
  if (batchReceivedAtMs !== null) return batchReceivedAtMs
  const itemReceivedAtMs = rows.reduce<number | null>((latest, trade) => {
    const receivedAtMs = getSpotTradeReceivedAtMs(trade)
    if (receivedAtMs === null) return latest
    return latest === null || receivedAtMs > latest ? receivedAtMs : latest
  }, null)
  return itemReceivedAtMs ?? fallbackReceivedAtMs
}

export function applySpotTradeReceivedAtMs(
  rows: readonly SpotMarketTradeItem[],
  receivedAtMs: number | null,
): SpotMarketTradeItem[] {
  if (receivedAtMs === null) return [...rows]
  return rows.map((trade) => (
    getSpotTradeReceivedAtMs(trade) !== null
      ? trade
      : { ...trade, received_at_ms: receivedAtMs }
  ))
}

export function sortSpotTradeRows(
  rows: readonly SpotMarketTradeItem[],
  context: SpotTradeRowsContext,
): SpotMarketTradeItem[] {
  return rows
    .map((trade, index) => ({ trade, index }))
    .sort((left, right) => {
      const leftEventTimeMs = extractSpotTradeEventTimeMs(left.trade)
      const rightEventTimeMs = extractSpotTradeEventTimeMs(right.trade)
      if (leftEventTimeMs !== null && rightEventTimeMs === null) return -1
      if (leftEventTimeMs === null && rightEventTimeMs !== null) return 1
      if (leftEventTimeMs !== null && rightEventTimeMs !== null && leftEventTimeMs !== rightEventTimeMs) {
        return rightEventTimeMs - leftEventTimeMs
      }
      if (leftEventTimeMs === null && rightEventTimeMs === null) {
        const receivedDifference = (
          (getSpotTradeReceivedAtMs(right.trade) ?? -1)
          - (getSpotTradeReceivedAtMs(left.trade) ?? -1)
        )
        if (receivedDifference !== 0) return receivedDifference
      }
      const identityDifference = getSpotTradeIdentity(left.trade, context)
        .localeCompare(getSpotTradeIdentity(right.trade, context))
      return identityDifference || left.index - right.index
    })
    .map(({ trade }) => trade)
}

export function limitSpotTradeRows(
  rows: readonly SpotMarketTradeItem[],
  context: SpotTradeRowsContext,
  limit = SPOT_TRADE_ROWS_LIMIT,
): SpotMarketTradeItem[] {
  return sortSpotTradeRows(rows, context).slice(0, Math.max(0, limit))
}

export function mergeSpotTradeSnapshotRows(
  currentRows: readonly SpotMarketTradeItem[],
  incomingRows: readonly SpotMarketTradeItem[],
  options: {
    symbol: string
    currentProvider?: unknown
    incomingProvider?: unknown
    currentProviderSymbol?: unknown
    incomingProviderSymbol?: unknown
    limit?: number
  },
): SpotMarketTradeItem[] {
  const [currentProvider, incomingProvider] = alignedFallbacks(
    options.currentProvider,
    options.incomingProvider,
    normalizedProvider,
  )
  const [currentProviderSymbol, incomingProviderSymbol] = alignedFallbacks(
    options.currentProviderSymbol,
    options.incomingProviderSymbol,
    normalizedProviderSymbol,
  )
  const currentContext: SpotTradeRowsContext = {
    symbol: options.symbol,
    provider: currentProvider,
    providerSymbol: currentProviderSymbol,
  }
  const incomingContext: SpotTradeRowsContext = {
    symbol: options.symbol,
    provider: incomingProvider,
    providerSymbol: incomingProviderSymbol,
  }
  const strongRows = new Map<string, SpotMarketTradeItem>()
  for (const trade of currentRows) {
    const identity = getSpotTradeStrongIdentity(trade, currentContext)
    if (identity) strongRows.set(identity, trade)
  }
  for (const trade of incomingRows) {
    const identity = getSpotTradeStrongIdentity(trade, incomingContext)
    if (!identity) continue
    const current = strongRows.get(identity)
    strongRows.set(identity, current ? mergeStrongTrade(current, trade) : trade)
  }

  const currentWeakRows = groupWeakRows(currentRows, currentContext)
  const incomingWeakRows = groupWeakRows(incomingRows, incomingContext)
  const mergedWeakRows: SpotMarketTradeItem[] = []
  for (const fingerprint of Array.from(new Set([
    ...currentWeakRows.keys(),
    ...incomingWeakRows.keys(),
  ])).sort()) {
    const current = currentWeakRows.get(fingerprint) || []
    const incoming = incomingWeakRows.get(fingerprint) || []
    // Providers without IDs do not expose absolute trade identity.  Preserve
    // the largest observed multiplicity as a conservative replay-safe policy.
    mergedWeakRows.push(...current)
    if (incoming.length > current.length) {
      mergedWeakRows.push(...incoming.slice(current.length))
    }
  }

  return limitSpotTradeRows(
    [...strongRows.values(), ...mergedWeakRows],
    incomingContext,
    options.limit,
  )
}

export function mergeSpotTradeIncrementalRow(
  currentRows: readonly SpotMarketTradeItem[],
  incomingTrade: SpotMarketTradeItem,
  deliveryCounts: SpotWeakDeliveryCounts,
  options: {
    symbol: string
    currentProvider?: unknown
    incomingProvider?: unknown
    currentProviderSymbol?: unknown
    incomingProviderSymbol?: unknown
    limit?: number
  },
): SpotTradeIncrementalMergeResult {
  const [currentProvider, incomingProvider] = alignedFallbacks(
    options.currentProvider,
    options.incomingProvider,
    normalizedProvider,
  )
  const [currentProviderSymbol, incomingProviderSymbol] = alignedFallbacks(
    options.currentProviderSymbol,
    options.incomingProviderSymbol,
    normalizedProviderSymbol,
  )
  const currentContext: SpotTradeRowsContext = {
    symbol: options.symbol,
    provider: currentProvider,
    providerSymbol: currentProviderSymbol,
  }
  const incomingContext: SpotTradeRowsContext = {
    symbol: options.symbol,
    provider: incomingProvider,
    providerSymbol: incomingProviderSymbol,
  }
  const strongIdentity = getSpotTradeStrongIdentity(incomingTrade, incomingContext)
  if (strongIdentity) {
    const currentIndex = currentRows.findIndex((trade) => (
      getSpotTradeStrongIdentity(trade, currentContext) === strongIdentity
    ))
    if (currentIndex >= 0) {
      const rows = [...currentRows]
      rows[currentIndex] = mergeStrongTrade(rows[currentIndex], incomingTrade)
      return {
        rows: limitSpotTradeRows(rows, incomingContext, options.limit),
        deliveryCounts,
        addedOccurrence: false,
        strongDuplicate: true,
      }
    }
    return {
      rows: limitSpotTradeRows([...currentRows, incomingTrade], incomingContext, options.limit),
      deliveryCounts,
      addedOccurrence: true,
      strongDuplicate: false,
    }
  }

  const fingerprint = getSpotTradeWeakFingerprint(incomingTrade, incomingContext)
  const receivedAtMs = getSpotTradeReceivedAtMs(incomingTrade)
  const deliveryKey = `${fingerprint}|received:${receivedAtMs ?? 'UNKNOWN'}`
  // received_at_ms identifies a delivery batch only; it is deliberately not
  // part of the weak trade fingerprint.
  const nextOccurrence = (deliveryCounts[deliveryKey] || 0) + 1
  const nextDeliveryCounts = { ...deliveryCounts, [deliveryKey]: nextOccurrence }
  const currentDeliveryCount = currentRows.filter((trade) => (
    !getSpotTradeStrongIdentity(trade, currentContext)
    && getSpotTradeWeakFingerprint(trade, currentContext) === fingerprint
    && sameReceivedAtMs(getSpotTradeReceivedAtMs(trade), receivedAtMs)
  )).length

  if (nextOccurrence <= currentDeliveryCount) {
    return {
      rows: limitSpotTradeRows(currentRows, incomingContext, options.limit),
      deliveryCounts: nextDeliveryCounts,
      addedOccurrence: false,
      strongDuplicate: false,
    }
  }
  return {
    rows: limitSpotTradeRows([...currentRows, incomingTrade], incomingContext, options.limit),
    deliveryCounts: nextDeliveryCounts,
    addedOccurrence: true,
    strongDuplicate: false,
  }
}

function compatibleProviders(currentProvider: unknown, incomingProvider: unknown): boolean {
  const current = normalizedProvider(currentProvider)
  const incoming = normalizedProvider(incomingProvider)
  return current === incoming || current === 'UNKNOWN' || incoming === 'UNKNOWN'
}

export function getSpotTradeCollectionAction(options: {
  accepted: boolean
  reason: SpotMarketDomainSequenceDecision['reason']
  currentProvider?: unknown
  incomingProvider?: unknown
}): SpotTradeCollectionAction {
  if (options.accepted) {
    if (options.reason === 'provider_switch') return 'replace'
    return compatibleProviders(options.currentProvider, options.incomingProvider) ? 'merge' : 'replace'
  }
  if (options.reason === 'retired_provider' || options.reason === 'provider_switch_rejected') {
    return 'ignore'
  }
  if (
    SAFE_HISTORY_REASONS.has(options.reason)
    && compatibleProviders(options.currentProvider, options.incomingProvider)
  ) {
    return 'merge'
  }
  return 'ignore'
}

export function shouldApplySpotTradeAuthoritySideEffects(options: {
  accepted: boolean
  addedOccurrence: boolean
}): boolean {
  return options.accepted && options.addedOccurrence
}

export function buildSpotTradeRenderRows(
  rows: readonly SpotMarketTradeItem[],
  context: SpotTradeRowsContext,
): SpotTradeRenderRow[] {
  const weakOccurrences = new Map<string, number>()
  return rows.map((trade) => {
    const strongIdentity = getSpotTradeStrongIdentity(trade, context)
    if (strongIdentity) return { trade, key: `strong:${strongIdentity}` }
    const fingerprint = getSpotTradeWeakFingerprint(trade, context)
    const receivedAtMs = getSpotTradeReceivedAtMs(trade)
    const baseKey = `${fingerprint}|received:${receivedAtMs ?? 'UNKNOWN'}`
    const occurrence = (weakOccurrences.get(baseKey) || 0) + 1
    weakOccurrences.set(baseKey, occurrence)
    return { trade, key: `${baseKey}|occurrence:${occurrence}` }
  })
}

export function getSpotTradeTimeValue(
  trade: SpotMarketTradeItem,
): string | number | null {
  const record = trade as Record<string, unknown>
  if (Object.prototype.hasOwnProperty.call(record, 'event_time_ms')) {
    const eventTimeMs = extractSpotTradeEventTimeMs(trade)
    if (eventTimeMs !== null) return eventTimeMs
    return text(trade.created_at)
  }
  return (
    (record.ts as string | number | null | undefined)
    ?? (record.time as string | number | null | undefined)
    ?? trade.created_at
    ?? null
  )
}

export function getLatestSpotTradeRow(
  rows: readonly SpotMarketTradeItem[],
  context: SpotTradeRowsContext,
): SpotMarketTradeItem | null {
  return limitSpotTradeRows(rows, context, 1)[0] || null
}
