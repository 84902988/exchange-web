import type { SpotDepthLevel } from '@/lib/api/modules/spot'
import { formatPrice as formatMarketPrice } from '@/lib/marketPrecision'
import type { DepthItem, OrderBookRow } from './orderbook.types'

function toFiniteNumber(value: string | number | undefined | null): number {
  const num = Number(value)
  return Number.isFinite(num) ? num : 0
}

function normalizeLevel(level: SpotDepthLevel | DepthItem | null | undefined): DepthItem | null {
  if (!level) return null

  const price = toFiniteNumber(level.price)
  const amount = toFiniteNumber(level.amount)

  if (price <= 0 || amount <= 0) return null

  return {
    price: String(price),
    amount: String(amount),
  }
}

export function sortAsks(list: DepthItem[]): DepthItem[] {
  return [...list].sort((a, b) => toFiniteNumber(a.price) - toFiniteNumber(b.price))
}

export function sortBids(list: DepthItem[]): DepthItem[] {
  return [...list].sort((a, b) => toFiniteNumber(b.price) - toFiniteNumber(a.price))
}

export function normalizeSide(
  levels: Array<SpotDepthLevel | DepthItem> | undefined,
  side: 'asks' | 'bids',
  limit = 12
): DepthItem[] {
  if (!Array.isArray(levels) || levels.length === 0) return []

  const map = new Map<string, DepthItem>()

  for (const level of levels) {
    const normalized = normalizeLevel(level)
    if (!normalized) continue
    map.set(normalized.price, normalized)
  }

  const next = Array.from(map.values())
  const sorted = side === 'asks' ? sortAsks(next) : sortBids(next)

  return sorted.slice(0, limit)
}

export function patchSide(
  current: Array<SpotDepthLevel | DepthItem> | undefined,
  updates: Array<SpotDepthLevel | DepthItem> | undefined,
  side: 'asks' | 'bids',
  limit = 12
): DepthItem[] {
  const map = new Map<string, DepthItem>()

  for (const level of Array.isArray(current) ? current : []) {
    const normalized = normalizeLevel(level)
    if (!normalized) continue
    map.set(normalized.price, normalized)
  }

  for (const level of Array.isArray(updates) ? updates : []) {
    const price = toFiniteNumber(level?.price)
    if (price <= 0) continue

    const amount = toFiniteNumber(level?.amount)
    const key = String(price)

    if (amount <= 0) {
      map.delete(key)
      continue
    }

    map.set(key, {
      price: key,
      amount: String(amount),
    })
  }

  const next = Array.from(map.values()).filter((item) => toFiniteNumber(item.amount) > 0)
  const sorted = side === 'asks' ? sortAsks(next) : sortBids(next)

  return sorted.slice(0, limit)
}

export function buildRows(list: DepthItem[]): OrderBookRow[] {
  let total = 0

  return list.map((item) => {
    const price = toFiniteNumber(item.price)
    const amount = toFiniteNumber(item.amount)
    total += amount

    return {
      price,
      amount,
      total,
    }
  })
}

export function getMaxTotal(asks: OrderBookRow[], bids: OrderBookRow[]): number {
  return Math.max(
    ...asks.map((item) => item.amount),
    ...bids.map((item) => item.amount),
    1
  )
}

export function getMiddlePrice(asks: OrderBookRow[], bids: OrderBookRow[], pricePrecision = 2): string {
  const bestAsk = asks[0]?.price
  const bestBid = bids[0]?.price

  if (bestAsk == null && bestBid == null) return '--'
  if (bestAsk == null) return formatMarketPrice(bestBid, pricePrecision)
  if (bestBid == null) return formatMarketPrice(bestAsk, pricePrecision)

  return formatMarketPrice((bestAsk + bestBid) / 2, pricePrecision)
}

export function formatPrice(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return '--'
  return value.toFixed(digits)
}

export function formatAmount(value: number, digits = 3): string {
  if (!Number.isFinite(value)) return '--'
  return value.toFixed(digits)
}
