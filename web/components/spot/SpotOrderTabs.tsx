'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from '@/lib/authContext'
import { useLocaleContext } from '@/contexts/LocaleContext'
import {
  cancelSpotOrder,
  getSpotCurrentOrders,
  getSpotHistoryOrders,
  getSpotMyTrades,
  type SpotAccountBalanceItem,
  SpotOrderItem,
  SpotTradeItem,
} from '@/lib/api/modules/spot'
import { getRuntimeApiBaseUrl } from '@/lib/api/core/baseUrl'
import { ApiError } from '@/lib/api/core/error'
import { getAccessToken } from '@/lib/api/core/token'
import { formatDisplayDateTime } from '@/lib/displayTimeZone'
import { useDisplayTimeZone } from '@/hooks/useDisplayTimeZone'
import { formatSpotDisplaySymbol } from './spotFormat'
import { parseSpotPrivateWsMessage } from './spotPrivateWs'

type Props = {
  symbol: string
  pricePrecision?: number
  refreshKey?: number
  onOrdersChanged?: () => void
  onLoadingChange?: (loading: boolean) => void
  onBalanceUpdate?: (items: SpotAccountBalanceItem[]) => void
}

type TabKey = 'current' | 'history' | 'trades'

type PrivateOrdersSnapshotMessage = {
  type: 'spot_user_orders_snapshot'
  symbol?: string
  items?: SpotOrderItem[]
}

type PrivateOrderUpdateMessage = {
  type: 'spot_user_order_update'
  symbol?: string
  order?: SpotOrderItem
}

type PrivateBalanceUpdateItem = {
  account_type?: string
  account_key?: string
  coin_symbol?: string
  symbol?: string
  available?: string | number
  frozen?: string | number
  total?: string | number
  updated_at?: string | null
}

type PrivateBalanceUpdateMessage = {
  type: 'spot_user_balance_update'
  account_type?: string
  account_key?: string
  items?: PrivateBalanceUpdateItem[]
}

type TabPageState = Record<TabKey, number>
type TradeDirection = 'BUY' | 'SELL' | ''
type AssetTranslator = (key: string, namespace?: 'asset') => string

type TradeRowItem = SpotTradeItem & {
  buyer_user_id?: number | string | null
  seller_user_id?: number | string | null
  buyerUserId?: number | string | null
  sellerUserId?: number | string | null

  buy_order_id?: number | string | null
  sell_order_id?: number | string | null
  buyOrderId?: number | string | null
  sellOrderId?: number | string | null

  maker_order_id?: number | string | null
  taker_order_id?: number | string | null
  makerOrderId?: number | string | null
  takerOrderId?: number | string | null

  order_id?: number | string | null
  orderId?: number | string | null

  fee_asset_id?: number | string | null
  optimistic?: boolean
  expiresAt?: number
}

const EMPTY_SPOT_ORDERS: SpotOrderItem[] = []
const EMPTY_SPOT_TRADES: TradeRowItem[] = []

const PAGE_SIZE = 10
const OPTIMISTIC_TRADE_TTL_MS = 3000
const REST_REVALIDATE_DEBOUNCE_MS = 500
const CURRENT_ORDERS_NETWORK_RETRY_DELAY_MS = 1500
const CURRENT_ORDERS_EVENT_REVALIDATE_DEBOUNCE_MS = 150
const PRIVATE_WS_RECONNECT_BASE_DELAY_MS = 1500
const PRIVATE_WS_RECONNECT_MAX_DELAY_MS = 15000
const PRIVATE_WS_AUTH_PROTOCOL = 'spot-auth'
const CANCELLABLE_STATUSES = ['OPEN', 'PARTIALLY_FILLED']
const TERMINAL_STATUSES = ['FILLED', 'CANCELED', 'REJECTED']
const OPEN_ORDER_STATUSES = ['OPEN', 'PARTIALLY_FILLED', 'NEW']

function normalizePricePrecision(value: number | undefined) {
  if (!Number.isFinite(value)) return 2
  return Math.max(0, Math.min(12, Math.floor(Number(value))))
}

function fmtPrice(v?: string | number, fixed = 2) {
  const precision = normalizePricePrecision(fixed)
  const n = Number(v ?? 0)
  if (!Number.isFinite(n)) return (0).toFixed(precision)
  return n.toFixed(precision)
}

function fmtOrderPrice(v?: string | number, fixed = 2) {
  const precision = normalizePricePrecision(fixed)
  const n = Number(v ?? 0)
  if (!Number.isFinite(n) || n <= 0) return '--'
  return n.toFixed(precision)
}

function fmtAmount(v?: string | number, fixed = 4) {
  const n = Number(v ?? 0)
  if (!Number.isFinite(n)) return '0.0000'
  return n.toFixed(fixed)
}

function normalizeBalanceUpdateItems(
  message: PrivateBalanceUpdateMessage,
): SpotAccountBalanceItem[] {
  const defaultAccountKey = String(
    message.account_key || message.account_type || 'spot',
  ).toLowerCase()

  return (message.items || [])
    .map((item) => {
      const symbol = String(item.symbol || item.coin_symbol || '').trim().toUpperCase()
      if (!symbol) return null

      return {
        symbol,
        account_key: String(
          item.account_key || item.account_type || defaultAccountKey,
        ).toLowerCase(),
        available: String(item.available ?? '0'),
        frozen: String(item.frozen ?? '0'),
      } satisfies SpotAccountBalanceItem
    })
    .filter((item): item is SpotAccountBalanceItem => item !== null)
}

function formatTrimmedDecimal(value: number, maxFractionDigits = 6) {
  const fixed = value.toFixed(maxFractionDigits)
  return fixed.replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1')
}

function formatFeeValue(record: {
  fee_amount?: string | number | null
  feeAmount?: string | number | null
  fee?: string | number | null
  fee_asset_symbol?: string | null
  feeAssetSymbol?: string | null
  fee_asset?: string | null
  feeAsset?: string | null
  fee_asset_name?: string | null
  fee_asset_id?: number | string | null
}) {
  const feeAmount = toFiniteNumber(record.fee_amount ?? record.feeAmount ?? record.fee)
  if (feeAmount <= 0) return '--'

  const feeAsset = String(
    record.fee_asset_symbol ?? record.feeAssetSymbol ?? record.fee_asset ?? record.feeAsset ?? record.fee_asset_name ?? '',
  ).trim().toUpperCase()
  const fallbackAsset = record.fee_asset_id ? `#${record.fee_asset_id}` : ''
  const asset = feeAsset || fallbackAsset
  return `${formatTrimmedDecimal(feeAmount, 6)}${asset ? ` ${asset}` : ''}`
}

function formatFeeAmount(order: SpotOrderItem) {
  return formatFeeValue(order)
}

function formatMessage(template: string, values: Record<string, string | number>) {
  return Object.entries(values).reduce(
    (text, [key, value]) => text.replaceAll(`{${key}}`, String(value)),
    template,
  )
}

function getOrderFeeDisplay(order: SpotOrderItem, tab: TabKey, t: AssetTranslator) {
  const status = String(order.status || '').toUpperCase()
  const feeAmount = toFiniteNumber(order.fee_amount)

  if (feeAmount > 0 || status === 'FILLED') {
    return {
      main: formatFeeAmount(order),
      sub: feeAmount > 0 ? t('spotOrderActualFee', 'asset') : '',
      title: feeAmount > 0 ? formatMessage(t('spotOrderActualFeeTitle', 'asset'), { fee: formatFeeAmount(order) }) : '',
    }
  }

  if (status === 'PARTIALLY_FILLED') {
    return {
      main: '--',
      sub: t('spotOrderPartialFeePending', 'asset'),
      title: t('spotOrderPartialFeeTitle', 'asset'),
    }
  }

  if (tab === 'current') {
    return {
      main: '--',
      sub: t('spotOrderFeeAfterTrade', 'asset'),
      title: t('spotOrderFeeAfterTradeTitle', 'asset'),
    }
  }

  return {
    main: '--',
    sub: '',
    title: '',
  }
}

function toFiniteNumber(value?: string | number | null) {
  const n = Number(value ?? 0)
  return Number.isFinite(n) ? n : 0
}

function formatTime(v: string | null | undefined, timeZone: string, locale?: string) {
  return formatDisplayDateTime(v, timeZone, locale)
}

function sideClass(side: string) {
  return side === 'BUY' ? 'text-green-400' : 'text-red-400'
}

function tradeSideClass(side: TradeDirection) {
  if (side === 'BUY') return 'text-green-400'
  if (side === 'SELL') return 'text-red-400'
  return 'text-white/70'
}

function sideText(side: string | TradeDirection, t: AssetTranslator) {
  if (side === 'BUY') return t('buy', 'asset')
  if (side === 'SELL') return t('sell', 'asset')
  return side || '--'
}

function orderTypeText(orderType: string | null | undefined, t: AssetTranslator) {
  const normalized = normalizeOrderType(orderType)
  if (normalized === 'LIMIT') return t('limit', 'asset')
  if (normalized === 'MARKET') return t('market', 'asset')
  return normalized || '--'
}

function formatOrderDisplayPrice(order: SpotOrderItem, t: AssetTranslator, pricePrecision: number) {
  if (normalizeOrderType(order.order_type) === 'MARKET') {
    const avgPrice = toFiniteNumber(order.avg_price)
    return avgPrice > 0 ? fmtPrice(avgPrice, pricePrecision) : t('market', 'asset')
  }
  return fmtOrderPrice(order.price, pricePrecision)
}

function formatTradeFeeDisplay(trade: TradeRowItem) {
  return formatFeeValue(trade)
}

function getOrderFeeFields(order: SpotOrderItem) {
  const record = order as SpotOrderItem & {
    feeAmount?: string | number | null
    fee?: string | number | null
    fee_asset?: string | null
    feeAssetSymbol?: string | null
    feeAsset?: string | null
    fee_asset_name?: string | null
  }

  return {
    feeAmount: record.fee_amount ?? record.feeAmount ?? record.fee ?? null,
    feeAssetId: record.fee_asset_id ?? null,
    feeAssetSymbol: record.fee_asset_symbol ?? record.feeAssetSymbol ?? record.fee_asset ?? record.feeAsset ?? record.fee_asset_name ?? null,
  }
}

function formatRecordTime(value: string | null | undefined, timeZone: string, locale?: string) {
  const text = formatTime(value, timeZone, locale)
  return text === '--' ? text : text.replace(/-/g, '/')
}

function statusText(status: string, t: AssetTranslator) {
  switch (status) {
    case 'OPEN':
      return t('spotOrderOpen', 'asset')
    case 'PARTIALLY_FILLED':
      return t('partiallyFilled', 'asset')
    case 'FILLED':
      return t('filled', 'asset')
    case 'CANCELED':
      return t('canceled', 'asset')
    default:
      return status
  }
}

function statusClass(status: string) {
  const normalized = String(status || '').toUpperCase()

  if (normalized === 'FILLED') return 'text-green-400'
  if (normalized === 'CANCELED') return 'text-gray-500'
  if (normalized === 'OPEN' || normalized === 'PARTIALLY_FILLED') {
    return 'text-yellow-400'
  }

  return 'text-white/70'
}

function normalizeSymbol(value?: string | null) {
  return String(value || '')
    .replace('/', '')
    .trim()
    .toUpperCase()
}

function normalizeUserId(value?: number | string | null) {
  return String(value ?? '').trim()
}

function normalizeOrderId(value?: number | string | null) {
  const raw = String(value ?? '').trim()
  return raw || ''
}

function normalizeTradeDirection(value?: string | null): TradeDirection {
  const normalized = String(value || '').trim().toUpperCase()
  if (normalized === 'BUY' || normalized === 'SELL') {
    return normalized
  }
  return ''
}

function normalizeOrderType(value?: string | null) {
  return String(value || '').trim().toUpperCase()
}

function getOrderAmounts(order: SpotOrderItem) {
  const amount = toFiniteNumber(order.amount)
  const filledAmount = toFiniteNumber(order.filled_amount)
  const rawRemaining = Number(order.remaining_amount)
  const remainingAmount = Number.isFinite(rawRemaining)
    ? rawRemaining
    : Math.max(amount - filledAmount, 0)

  return {
    amount,
    filledAmount,
    remainingAmount: Math.max(remainingAmount, 0),
  }
}

function isTerminalOrder(order: SpotOrderItem) {
  const status = String(order?.status || '').toUpperCase()
  const orderType = normalizeOrderType(order?.order_type)
  const { amount, filledAmount, remainingAmount } = getOrderAmounts(order)

  if (TERMINAL_STATUSES.includes(status)) {
    return true
  }

  if (amount > 0 && filledAmount >= amount) {
    return true
  }

  if (remainingAmount <= 0) {
    return true
  }

  if (orderType === 'MARKET' && filledAmount > 0) {
    return true
  }

  return false
}

function isCurrentOrder(order: SpotOrderItem) {
  const status = String(order?.status || '').toUpperCase()

  if (isTerminalOrder(order)) {
    return false
  }

  return OPEN_ORDER_STATUSES.includes(status)
}

function isHistoryOrder(order: SpotOrderItem) {
  if (isTerminalOrder(order)) {
    return true
  }

  const status = String(order?.status || '').toUpperCase()
  return !OPEN_ORDER_STATUSES.includes(status)
}

function mergeOrdersById(...groups: SpotOrderItem[][]) {
  const orderMap = new Map<number, SpotOrderItem>()

  for (const group of groups) {
    for (const item of group) {
      orderMap.set(item.id, item)
    }
  }

  return Array.from(orderMap.values()).sort((a, b) => b.id - a.id)
}

function getTradeBuyerUserId(trade: TradeRowItem) {
  return normalizeUserId(trade.buyer_user_id ?? trade.buyerUserId ?? null)
}

function getTradeSellerUserId(trade: TradeRowItem) {
  return normalizeUserId(trade.seller_user_id ?? trade.sellerUserId ?? null)
}

function getTradeOrderIds(trade: TradeRowItem) {
  return [
    normalizeOrderId(trade.buy_order_id ?? trade.buyOrderId ?? null),
    normalizeOrderId(trade.sell_order_id ?? trade.sellOrderId ?? null),
    normalizeOrderId(trade.maker_order_id ?? trade.makerOrderId ?? null),
    normalizeOrderId(trade.taker_order_id ?? trade.takerOrderId ?? null),
    normalizeOrderId(trade.order_id ?? trade.orderId ?? null),
  ].filter(Boolean)
}

function getTradeSideForUser(
  trade: TradeRowItem,
  currentUserId?: number | string | null,
  userOrderSideMap?: Map<string, TradeDirection>,
): TradeDirection {
  const orderIds = getTradeOrderIds(trade)

  if (userOrderSideMap && userOrderSideMap.size > 0) {
    for (const orderId of orderIds) {
      const matchedSide = userOrderSideMap.get(orderId)
      if (matchedSide === 'BUY' || matchedSide === 'SELL') {
        return matchedSide
      }
    }
  }

  const userId = normalizeUserId(currentUserId)

  if (userId) {
    const buyerUserId = getTradeBuyerUserId(trade)
    if (buyerUserId && buyerUserId === userId) {
      return 'BUY'
    }

    const sellerUserId = getTradeSellerUserId(trade)
    if (sellerUserId && sellerUserId === userId) {
      return 'SELL'
    }
  }

  return normalizeTradeDirection((trade as { side?: string | null }).side)
}

function getItemSymbol(item: Record<string, unknown> | null | undefined): string {
  const rawSymbol =
    item?.symbol ??
    item?.trading_pair_symbol ??
    item?.pair_symbol ??
    item?.pair ??
    item?.market ??
    item?.trade_symbol

  return normalizeSymbol(
    typeof rawSymbol === 'string' || typeof rawSymbol === 'number'
      ? String(rawSymbol)
      : ''
  )
}

function filterBySymbol<T>(items: T[], symbol: string): T[] {
  const target = normalizeSymbol(symbol)
  if (!target) return items

  return items.filter((item) => {
    const itemSymbol = getItemSymbol(item as Record<string, unknown>)
    if (!itemSymbol) return true
    return itemSymbol === target
  })
}

function buildPrivateWsUrl(symbol: string) {
  const apiBase = getRuntimeApiBaseUrl()
  const url = new URL(apiBase)
  const protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  const params = new URLSearchParams({ symbol })
  return `${protocol}//${url.host}/spot/ws/private?${params.toString()}`
}

function createPrivateWebSocket(symbol: string) {
  const url = buildPrivateWsUrl(symbol)
  const accessToken = getAccessToken()
  return accessToken
    ? new WebSocket(url, [PRIVATE_WS_AUTH_PROTOCOL, accessToken])
    : new WebSocket(url)
}

function patchCurrentOrdersList(
  prev: SpotOrderItem[],
  order: SpotOrderItem,
): SpotOrderItem[] {
  const status = String(order?.status || '').toUpperCase()
  const openStatuses = OPEN_ORDER_STATUSES
  const removeStatuses = TERMINAL_STATUSES

  if (removeStatuses.includes(status)) {
    return prev.filter((item) => item.id !== order.id)
  }

  if (!openStatuses.includes(status)) {
    return prev
  }

  const next = prev.filter((item) => item.id !== order.id)
  return [order, ...next]
}

function patchHistoryOrdersList(
  prev: SpotOrderItem[],
  order: SpotOrderItem,
): SpotOrderItem[] {
  const status = String(order?.status || '').toUpperCase()
  const historyStatuses = TERMINAL_STATUSES

  if (!historyStatuses.includes(status)) {
    return prev
  }

  const next = prev.filter((item) => item.id !== order.id)
  return [order, ...next]
}

function buildOptimisticTradeFromOrder(
  order: SpotOrderItem,
  currentUserId?: number | string | null,
): TradeRowItem | null {
  const status = String(order?.status || '').toUpperCase()
  const orderType = String(order?.order_type || '').toUpperCase()
  const avgPrice = Number(order?.avg_price || 0)
  const filledAmount = Number(order?.filled_amount || 0)
  const quoteAmount = Number(order?.executed_quote_amount || 0)

  if (status !== 'FILLED') return null
  if (orderType !== 'MARKET') return null
  if (!Number.isFinite(avgPrice) || avgPrice <= 0) return null
  if (!Number.isFinite(filledAmount) || filledAmount <= 0) return null
  if (!Number.isFinite(quoteAmount) || quoteAmount <= 0) return null

  const numericUserId = Number(currentUserId)
  const tradeUserId = Number.isFinite(numericUserId) ? numericUserId : null
  const feeFields = getOrderFeeFields(order)

  return {
    trade_id: -Math.abs(order.id),
    optimistic: true,
    expiresAt: Date.now() + OPTIMISTIC_TRADE_TTL_MS,
    symbol: order.symbol,
    side: order.side,
    buyer_user_id: order.side === 'BUY' ? tradeUserId : null,
    seller_user_id: order.side === 'SELL' ? tradeUserId : null,
    buy_order_id: order.id,
    sell_order_id: order.id,
    role: 'TAKER',
    price: String(order.avg_price),
    amount: String(order.filled_amount),
    quote_amount: String(order.executed_quote_amount),
    fee_amount: feeFields.feeAmount === null ? undefined : String(feeFields.feeAmount),
    fee_asset_id: feeFields.feeAssetId,
    fee_asset_symbol: feeFields.feeAssetSymbol,
    fee_asset: feeFields.feeAssetSymbol,
    created_at: order.updated_at || order.created_at || null,
  }
}

function isOptimisticTrade(trade: TradeRowItem) {
  return trade.optimistic === true || Number(trade.trade_id) < 0
}

function tradeMatchesOrder(trade: TradeRowItem, order: SpotOrderItem) {
  const orderId = normalizeOrderId(order.id)
  if (orderId && getTradeOrderIds(trade).includes(orderId)) {
    return true
  }

  const price = String(order.avg_price ?? '')
  const amount = String(order.filled_amount ?? '')
  const quoteAmount = String(order.executed_quote_amount ?? '')
  return (
    normalizeSymbol(trade.symbol) === normalizeSymbol(order.symbol) &&
    normalizeTradeDirection(trade.side) === normalizeTradeDirection(order.side) &&
    String(trade.price) === price &&
    String(trade.amount) === amount &&
    String(trade.quote_amount) === quoteAmount
  )
}

function patchTradesList(
  prev: TradeRowItem[],
  order: SpotOrderItem,
  currentUserId?: number | string | null,
  restTrades: TradeRowItem[] = [],
): TradeRowItem[] {
  const optimisticTrade = buildOptimisticTradeFromOrder(order, currentUserId)
  if (!optimisticTrade) {
    return prev
  }

  if (restTrades.some((item) => tradeMatchesOrder(item, order))) {
    return prev
  }

  const now = Date.now()
  const next = prev.filter(
    (item) =>
      Number(item.expiresAt || 0) > now &&
      item.trade_id !== optimisticTrade.trade_id &&
      !(isOptimisticTrade(item) && tradeMatchesOrder(item, order))
  )

  return [optimisticTrade, ...next]
}

function reconcileOptimisticTrades(
  optimisticTrades: TradeRowItem[],
  restTrades: TradeRowItem[],
  symbol: string,
) {
  const now = Date.now()
  const normalizedSymbol = normalizeSymbol(symbol)
  return optimisticTrades.filter((item) => {
    if (!isOptimisticTrade(item)) return false
    if (normalizeSymbol(item.symbol) !== normalizedSymbol) return false
    if (Number(item.expiresAt || 0) <= now) return false
    return !restTrades.some((trade) => tradesMatch(trade, item))
  })
}

function tradesMatch(left: TradeRowItem, right: TradeRowItem) {
  const leftOrders = getTradeOrderIds(left)
  const rightOrders = getTradeOrderIds(right)
  if (leftOrders.some((orderId) => rightOrders.includes(orderId))) {
    return true
  }

  const leftTime = Date.parse(String(left.created_at || ''))
  const rightTime = Date.parse(String(right.created_at || ''))
  const timeCloseEnough = Number.isFinite(leftTime) && Number.isFinite(rightTime)
    ? Math.abs(leftTime - rightTime) <= 5000
    : true

  return (
    normalizeSymbol(left.symbol) === normalizeSymbol(right.symbol) &&
    normalizeTradeDirection(left.side) === normalizeTradeDirection(right.side) &&
    String(left.price) === String(right.price) &&
    String(left.amount) === String(right.amount) &&
    String(left.quote_amount) === String(right.quote_amount) &&
    timeCloseEnough
  )
}

function mergeRestAndOptimisticTrades(restTrades: TradeRowItem[], optimisticTrades: TradeRowItem[], symbol: string) {
  const liveOptimistic = reconcileOptimisticTrades(optimisticTrades, restTrades, symbol)
  return [...liveOptimistic, ...restTrades]
}

function getTotalPages(totalItems: number) {
  return Math.max(1, Math.ceil(totalItems / PAGE_SIZE))
}

function canCancelOrder(order: SpotOrderItem) {
  const status = String(order?.status || '').toUpperCase()
  const { amount, filledAmount, remainingAmount } = getOrderAmounts(order)

  if (!CANCELLABLE_STATUSES.includes(status)) {
    return false
  }

  if (TERMINAL_STATUSES.includes(status)) {
    return false
  }

  if (amount > 0 && filledAmount >= amount) {
    return false
  }

  if (remainingAmount <= 0) {
    return false
  }

  if (normalizeOrderType(order.order_type) === 'MARKET') {
    return false
  }

  return true
}

function normalizeActionError(err: unknown, t: AssetTranslator) {
  const raw =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
      ? err
      : err && typeof err === 'object' && 'message' in err
      ? String((err as { message?: unknown }).message || '')
      : ''

  const normalized = raw.trim().toLowerCase()

  if (
    normalized.includes('unauthorized') ||
    normalized.includes('token expired') ||
    normalized.includes('invalid token') ||
    normalized.includes('access token expired') ||
    normalized.includes('missing access token')
  ) {
    return t('spotOrderUnauthorized', 'asset')
  }

  if (
    normalized.includes('order not found') ||
    normalized.includes('already canceled') ||
    normalized.includes('already filled') ||
    normalized.includes('no remaining amount to cancel')
  ) {
    return t('spotOrderStateChanged', 'asset')
  }

  if (
    normalized.includes('network') ||
    normalized.includes('timeout') ||
    normalized.includes('fetch failed') ||
    normalized.includes('failed to fetch')
  ) {
    return t('spotOrderNetworkError', 'asset')
  }

  return t('spotOrderCancelFailed', 'asset')
}

function isRecoverableNetworkError(err: unknown) {
  return err instanceof ApiError && err.code === 'NETWORK_ERROR'
}

export default function SpotOrderTabs({
  symbol,
  pricePrecision: requestedPricePrecision = 2,
  refreshKey = 0,
  onOrdersChanged,
  onLoadingChange,
  onBalanceUpdate,
}: Props) {
  const { t, locale } = useLocaleContext()
  const displayTimeZone = useDisplayTimeZone()
  const { user, isLoggedIn } = useAuth()
  const accountScope = normalizeUserId(user?.id)
  const activePrivateDataScope = accountScope
    ? `${accountScope}:${normalizeSymbol(symbol)}`
    : ''
  const displaySymbol = useMemo(() => formatSpotDisplaySymbol(symbol), [symbol])
  const pricePrecision = normalizePricePrecision(requestedPricePrecision)
  const [tab, setTab] = useState<TabKey>('current')
  const [currentOrders, setCurrentOrders] = useState<SpotOrderItem[]>([])
  const [historyOrders, setHistoryOrders] = useState<SpotOrderItem[]>([])
  const [myTrades, setMyTrades] = useState<TradeRowItem[]>([])
  const [optimisticTrades, setOptimisticTrades] = useState<TradeRowItem[]>([])
  const [loadedPrivateDataScope, setLoadedPrivateDataScope] = useState(activePrivateDataScope)
  const [loading, setLoading] = useState(false)
  const [cancelingOrderId, setCancelingOrderId] = useState<number | null>(null)
  const [actionError, setActionError] = useState('')
  const [actionSuccess, setActionSuccess] = useState('')
  const [pages, setPages] = useState<TabPageState>({
    current: 1,
    history: 1,
    trades: 1,
  })

  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimerRef = useRef<number | null>(null)
  const revalidateTimerRef = useRef<number | null>(null)
  const currentOrdersRetryTimerRef = useRef<number | null>(null)
  const optimisticCleanupTimerRef = useRef<number | null>(null)
  const currentSymbolRef = useRef('')
  const activeTabRef = useRef<TabKey>('current')
  const restTradesRef = useRef<TradeRowItem[]>([])
  const loadingCounterRef = useRef(0)
  const currentOrdersInFlightKeyRef = useRef<string | null>(null)
  const currentOrdersRevalidatePendingRef = useRef(false)
  const historyOrdersInFlightKeyRef = useRef<string | null>(null)
  const tradesInFlightKeyRef = useRef<string | null>(null)
  const currentOrdersRequestSeqRef = useRef(0)
  const historyOrdersRequestSeqRef = useRef(0)
  const tradesRequestSeqRef = useRef(0)
  const currentOrdersLoadedRef = useRef(false)
  const historyOrdersLoadedRef = useRef(false)
  const tradesLoadedRef = useRef(false)
  const currentUserIdRef = useRef<string>('')
  const onBalanceUpdateRef = useRef(onBalanceUpdate)
  const loadCurrentOrdersRef = useRef<(
    reason?: string,
    networkRetryAttempt?: number,
  ) => Promise<void>>(async () => undefined)

  const clearCurrentOrdersRetryTimer = useCallback(() => {
    if (currentOrdersRetryTimerRef.current !== null) {
      window.clearTimeout(currentOrdersRetryTimerRef.current)
      currentOrdersRetryTimerRef.current = null
    }
  }, [])

  useEffect(() => {
    currentUserIdRef.current = accountScope
  }, [accountScope])

  useEffect(() => {
    onBalanceUpdateRef.current = onBalanceUpdate
  }, [onBalanceUpdate])

  useEffect(() => {
    if (!isLoggedIn) {
      clearCurrentOrdersRetryTimer()
      currentOrdersLoadedRef.current = false
      historyOrdersLoadedRef.current = false
      tradesLoadedRef.current = false
      currentOrdersInFlightKeyRef.current = null
      currentOrdersRevalidatePendingRef.current = false
      historyOrdersInFlightKeyRef.current = null
      tradesInFlightKeyRef.current = null
      currentOrdersRequestSeqRef.current += 1
      historyOrdersRequestSeqRef.current += 1
      tradesRequestSeqRef.current += 1
      setCurrentOrders([])
      setHistoryOrders([])
      setMyTrades([])
      setOptimisticTrades([])
      restTradesRef.current = []
    }
  }, [clearCurrentOrdersRetryTimer, isLoggedIn])

  const beginLoading = useCallback(() => {
    loadingCounterRef.current += 1
    setLoading(true)
  }, [])

  const endLoading = useCallback(() => {
    loadingCounterRef.current = Math.max(loadingCounterRef.current - 1, 0)
    setLoading(loadingCounterRef.current > 0)
  }, [])

  useEffect(() => {
    onLoadingChange?.(loading)
  }, [loading, onLoadingChange])

  useEffect(() => {
    clearCurrentOrdersRetryTimer()
    currentSymbolRef.current = normalizeSymbol(symbol)
    if (revalidateTimerRef.current !== null) {
      window.clearTimeout(revalidateTimerRef.current)
      revalidateTimerRef.current = null
    }
    currentOrdersLoadedRef.current = false
    historyOrdersLoadedRef.current = false
    tradesLoadedRef.current = false
    currentOrdersInFlightKeyRef.current = null
    currentOrdersRevalidatePendingRef.current = false
    historyOrdersInFlightKeyRef.current = null
    tradesInFlightKeyRef.current = null
    currentOrdersRequestSeqRef.current += 1
    historyOrdersRequestSeqRef.current += 1
    tradesRequestSeqRef.current += 1
    setCurrentOrders([])
    setHistoryOrders([])
    setMyTrades([])
    setPages({
      current: 1,
      history: 1,
      trades: 1,
    })
    setOptimisticTrades([])
    restTradesRef.current = []
    setLoadedPrivateDataScope(activePrivateDataScope)
    setActionError('')
    setActionSuccess('')
  }, [activePrivateDataScope, clearCurrentOrdersRetryTimer, symbol])

  useEffect(() => {
    activeTabRef.current = tab
  }, [tab])

  useEffect(() => {
    if (!actionSuccess) {
      return undefined
    }

    const timer = window.setTimeout(() => {
      setActionSuccess('')
    }, 2200)

    return () => {
      window.clearTimeout(timer)
    }
  }, [actionSuccess])

  useEffect(() => () => {
    clearCurrentOrdersRetryTimer()
    if (revalidateTimerRef.current !== null) {
      window.clearTimeout(revalidateTimerRef.current)
    }
    if (optimisticCleanupTimerRef.current !== null) {
      window.clearTimeout(optimisticCleanupTimerRef.current)
    }
  }, [clearCurrentOrdersRetryTimer])

  useEffect(() => {
    if (optimisticCleanupTimerRef.current !== null) {
      window.clearTimeout(optimisticCleanupTimerRef.current)
      optimisticCleanupTimerRef.current = null
    }

    if (optimisticTrades.length === 0) return undefined

    const now = Date.now()
    const nextExpiry = optimisticTrades.reduce((min, item) => {
      const expiresAt = Number(item.expiresAt || 0)
      if (expiresAt <= now) return min
      return Math.min(min, expiresAt)
    }, Number.POSITIVE_INFINITY)

    if (!Number.isFinite(nextExpiry)) {
      setOptimisticTrades((prev) => reconcileOptimisticTrades(prev, restTradesRef.current, currentSymbolRef.current))
      return undefined
    }

    optimisticCleanupTimerRef.current = window.setTimeout(() => {
      setOptimisticTrades((prev) => reconcileOptimisticTrades(prev, restTradesRef.current, currentSymbolRef.current))
      if (activeTabRef.current === 'trades') {
        scheduleHistoryAndTradesReload('optimistic-expired', 0, 'trades')
      }
    }, Math.max(nextExpiry - now, 0))

    return () => {
      if (optimisticCleanupTimerRef.current !== null) {
        window.clearTimeout(optimisticCleanupTimerRef.current)
        optimisticCleanupTimerRef.current = null
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [optimisticTrades])

  useEffect(() => {
    let dead = false
    let connectTimer: number | null = null
    let currentOrdersEventRevalidateTimer: number | null = null
    let reconnectAttempt = 0
    let preOpenAuthRecoveryAttempted = false

    const normalizedSymbol = normalizeSymbol(symbol)
    const connectionAccountScope = accountScope
    currentSymbolRef.current = normalizedSymbol

    const clearConnectTimer = () => {
      if (connectTimer !== null) {
        window.clearTimeout(connectTimer)
        connectTimer = null
      }
    }

    const clearReconnectTimer = () => {
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current)
        reconnectTimerRef.current = null
      }
    }

    const scheduleCurrentOrdersEventRevalidation = () => {
      if (currentOrdersEventRevalidateTimer !== null) {
        window.clearTimeout(currentOrdersEventRevalidateTimer)
      }
      currentOrdersEventRevalidateTimer = window.setTimeout(() => {
        currentOrdersEventRevalidateTimer = null
        void loadCurrentOrdersRef.current('ws-balance-update')
      }, CURRENT_ORDERS_EVENT_REVALIDATE_DEBOUNCE_MS)
    }

    const closeWs = () => {
      clearConnectTimer()
      clearReconnectTimer()

      if (wsRef.current) {
        const ws = wsRef.current
        wsRef.current = null
        ws.onopen = null
        ws.onmessage = null
        ws.onerror = null
        ws.onclose = null
        ws.close(1000, 'client disconnect')
      }
    }

    const scheduleReconnect = () => {
      if (dead || !normalizedSymbol || !isLoggedIn || !connectionAccountScope) return
      clearReconnectTimer()
      const delay = Math.min(
        PRIVATE_WS_RECONNECT_BASE_DELAY_MS * (2 ** reconnectAttempt),
        PRIVATE_WS_RECONNECT_MAX_DELAY_MS,
      )
      reconnectAttempt = Math.min(reconnectAttempt + 1, 4)
      reconnectTimerRef.current = window.setTimeout(() => {
        reconnectTimerRef.current = null
        connect()
      }, delay)
    }

    if (!normalizedSymbol || !isLoggedIn || !connectionAccountScope) {
      setCurrentOrders([])
      closeWs()
      return () => {
        dead = true
        closeWs()
      }
    }

    const connect = () => {
      if (dead || !normalizedSymbol) return

      const ws = createPrivateWebSocket(normalizedSymbol)
      let opened = false
      wsRef.current = ws

      ws.onopen = () => {
        opened = true
        reconnectAttempt = 0
        preOpenAuthRecoveryAttempted = false
      }

      ws.onmessage = (event) => {
        if (dead || currentUserIdRef.current !== connectionAccountScope) return

        try {
          const data = parseSpotPrivateWsMessage(event.data, {
            sendPong: () => {
              try {
                ws.send('pong')
              } catch {
                // Heartbeat replies are best-effort.
              }
            },
          }) as
            | PrivateOrdersSnapshotMessage
            | PrivateOrderUpdateMessage
            | PrivateBalanceUpdateMessage
            | null

          if (!data) {
            return
          }

          if (data.type === 'spot_user_balance_update') {
            const items = normalizeBalanceUpdateItems(data)
            if (items.length > 0) {
              onBalanceUpdateRef.current?.(items)
            }
            scheduleCurrentOrdersEventRevalidation()
            return
          }

          const msgSymbol = normalizeSymbol(data?.symbol)

          if (msgSymbol && msgSymbol !== currentSymbolRef.current) {
            return
          }

          if (data.type === 'spot_user_orders_snapshot') {
            setCurrentOrders(filterBySymbol(data.items || [], normalizedSymbol))
            return
          }

          if (data.type === 'spot_user_order_update' && data.order) {
            const orderSymbol = getItemSymbol(data.order)
            if (orderSymbol && orderSymbol !== currentSymbolRef.current) {
              return
            }

            setCurrentOrders((prev) =>
              patchCurrentOrdersList(prev, data.order as SpotOrderItem)
            )

            const status = String(data.order.status || '').toUpperCase()
            if (['FILLED', 'CANCELED', 'REJECTED'].includes(status)) {
              setHistoryOrders((prev) =>
                patchHistoryOrdersList(prev, data.order as SpotOrderItem)
              )
            }

            if (status === 'FILLED') {
              setOptimisticTrades((prev) =>
                patchTradesList(
                  prev,
                  data.order as SpotOrderItem,
                  currentUserIdRef.current,
                  restTradesRef.current,
                )
              )
            }

            if (['FILLED', 'PARTIALLY_FILLED', 'CANCELED', 'REJECTED'].includes(status)) {
              const activeTab = activeTabRef.current
              if (activeTab === 'history' || activeTab === 'trades') {
                scheduleHistoryAndTradesReload(`ws-${status.toLowerCase()}`, REST_REVALIDATE_DEBOUNCE_MS, activeTab)
              }
            }
          }
        } catch (err) {
          console.warn('SpotOrderTabs private ws parse error:', err)
        }
      }

      ws.onerror = () => {
        // ignore transient websocket errors in dev
      }

      ws.onclose = (event) => {
        wsRef.current = null

        if (dead) return

        clearReconnectTimer()

        if (
          event.code === 1008 ||
          (!opened && !preOpenAuthRecoveryAttempted)
        ) {
          preOpenAuthRecoveryAttempted = true
          void loadCurrentOrdersRef.current('ws-auth-recovery')
        }
        scheduleReconnect()
      }
    }

    connectTimer = window.setTimeout(() => {
      connectTimer = null
      connect()
    }, 100)

    return () => {
      dead = true
      if (currentOrdersEventRevalidateTimer !== null) {
        window.clearTimeout(currentOrdersEventRevalidateTimer)
        currentOrdersEventRevalidateTimer = null
      }
      closeWs()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountScope, symbol, isLoggedIn])

  const loadCurrentOrders = useCallback(async (
    reason = 'manual',
    networkRetryAttempt = 0,
  ) => {
    const requestAccountScope = accountScope
    if (!isLoggedIn || !requestAccountScope) {
      currentOrdersLoadedRef.current = false
      setCurrentOrders([])
      return
    }

    if (reason !== 'network-retry') {
      clearCurrentOrdersRetryTimer()
    }

    const requestSymbol = currentSymbolRef.current || normalizeSymbol(symbol)
    if (!requestSymbol) return

    const requestKey = `${requestAccountScope}:${requestSymbol}:current`
    if (currentOrdersInFlightKeyRef.current === requestKey) {
      currentOrdersRevalidatePendingRef.current = true
      return
    }

    const requestSeq = ++currentOrdersRequestSeqRef.current
    currentOrdersInFlightKeyRef.current = requestKey
    const shouldShowLoading = activeTabRef.current === 'current' && !currentOrdersLoadedRef.current

    try {
      if (shouldShowLoading) beginLoading()
      const currentRes = await getSpotCurrentOrders(requestSymbol, 50)
      if (
        currentOrdersRequestSeqRef.current !== requestSeq ||
        requestSymbol !== currentSymbolRef.current ||
        requestAccountScope !== currentUserIdRef.current
      ) {
        return
      }
      setCurrentOrders(filterBySymbol(currentRes.items || [], requestSymbol))
      currentOrdersLoadedRef.current = true
    } catch (err) {
      const isCurrentRequest =
        currentOrdersRequestSeqRef.current === requestSeq &&
        requestSymbol === currentSymbolRef.current &&
        requestAccountScope === currentUserIdRef.current

      if (
        isCurrentRequest &&
        isRecoverableNetworkError(err) &&
        networkRetryAttempt === 0
      ) {
        clearCurrentOrdersRetryTimer()
        currentOrdersRetryTimerRef.current = window.setTimeout(() => {
          currentOrdersRetryTimerRef.current = null
          if (
            currentOrdersRequestSeqRef.current !== requestSeq ||
            requestSymbol !== currentSymbolRef.current ||
            requestAccountScope !== currentUserIdRef.current
          ) {
            return
          }
          void loadCurrentOrdersRef.current('network-retry', 1)
        }, CURRENT_ORDERS_NETWORK_RETRY_DELAY_MS)
      } else if (isCurrentRequest && !isRecoverableNetworkError(err)) {
        console.error('SpotOrderTabs current orders load error:', err)
      }
    } finally {
      if (currentOrdersRequestSeqRef.current === requestSeq) {
        currentOrdersInFlightKeyRef.current = null
        if (shouldShowLoading) endLoading()
        const shouldRunCoalescedRevalidation =
          currentOrdersRevalidatePendingRef.current &&
          requestSymbol === currentSymbolRef.current &&
          requestAccountScope === currentUserIdRef.current
        currentOrdersRevalidatePendingRef.current = false
        if (shouldRunCoalescedRevalidation) {
          void loadCurrentOrdersRef.current('coalesced')
        }
      }
    }
  }, [
    beginLoading,
    accountScope,
    clearCurrentOrdersRetryTimer,
    endLoading,
    isLoggedIn,
    symbol,
  ])

  useEffect(() => {
    loadCurrentOrdersRef.current = loadCurrentOrders
  }, [loadCurrentOrders])

  useEffect(() => {
    if (tab !== 'current') return
    void loadCurrentOrders('active-tab')
  }, [loadCurrentOrders, refreshKey, tab])

  const loadHistoryOrders = useCallback(async (reason = 'manual') => {
    void reason
    const requestAccountScope = accountScope
    if (!isLoggedIn || !requestAccountScope) return
    const requestSymbol = currentSymbolRef.current || normalizeSymbol(symbol)
    if (!requestSymbol) return

    const requestKey = `${requestAccountScope}:${requestSymbol}:history`
    if (historyOrdersInFlightKeyRef.current === requestKey) {
      return
    }

    const requestSeq = ++historyOrdersRequestSeqRef.current
    historyOrdersInFlightKeyRef.current = requestKey
    const shouldShowLoading = activeTabRef.current === 'history' && !historyOrdersLoadedRef.current

    try {
      if (shouldShowLoading) beginLoading()
      const historyRes = await getSpotHistoryOrders(requestSymbol, 100)
      if (
        historyOrdersRequestSeqRef.current !== requestSeq ||
        requestSymbol !== currentSymbolRef.current ||
        requestAccountScope !== currentUserIdRef.current
      ) {
        return
      }
      setHistoryOrders(filterBySymbol(historyRes.items || [], requestSymbol))
      historyOrdersLoadedRef.current = true
    } catch (err) {
      if (historyOrdersRequestSeqRef.current === requestSeq) {
        console.error('SpotOrderTabs history orders load error:', err)
      }
    } finally {
      if (historyOrdersRequestSeqRef.current === requestSeq) {
        historyOrdersInFlightKeyRef.current = null
        if (shouldShowLoading) endLoading()
      }
    }
  }, [accountScope, beginLoading, endLoading, isLoggedIn, symbol])

  const loadMyTrades = useCallback(async (reason = 'manual') => {
    void reason
    const requestAccountScope = accountScope
    if (!isLoggedIn || !requestAccountScope) return
    const requestSymbol = currentSymbolRef.current || normalizeSymbol(symbol)
    if (!requestSymbol) return

    const requestKey = `${requestAccountScope}:${requestSymbol}:trades`
    if (tradesInFlightKeyRef.current === requestKey) {
      return
    }

    const requestSeq = ++tradesRequestSeqRef.current
    tradesInFlightKeyRef.current = requestKey
    const shouldShowLoading = activeTabRef.current === 'trades' && !tradesLoadedRef.current

    try {
      if (shouldShowLoading) beginLoading()
      const tradesRes = await getSpotMyTrades(requestSymbol, 100)
      if (
        tradesRequestSeqRef.current !== requestSeq ||
        requestSymbol !== currentSymbolRef.current ||
        requestAccountScope !== currentUserIdRef.current
      ) {
        return
      }
      const restTrades = filterBySymbol(tradesRes.items || [], requestSymbol) as TradeRowItem[]
      restTradesRef.current = restTrades
      setMyTrades(restTrades)
      setOptimisticTrades((prev) => reconcileOptimisticTrades(prev, restTrades, requestSymbol))
      tradesLoadedRef.current = true
    } catch (err) {
      if (tradesRequestSeqRef.current === requestSeq) {
        console.error('SpotOrderTabs trades load error:', err)
      }
    } finally {
      if (tradesRequestSeqRef.current === requestSeq) {
        tradesInFlightKeyRef.current = null
        if (shouldShowLoading) endLoading()
      }
    }
  }, [accountScope, beginLoading, endLoading, isLoggedIn, symbol])

  const scheduleHistoryAndTradesReload = useCallback(
    (reason = 'manual', delayMs = REST_REVALIDATE_DEBOUNCE_MS, targetTab: TabKey = activeTabRef.current) => {
      if (!isLoggedIn) return
      const normalizedSymbol = currentSymbolRef.current || normalizeSymbol(symbol)
      if (!normalizedSymbol) return
      if (targetTab !== 'history' && targetTab !== 'trades') return

      if (revalidateTimerRef.current !== null) {
        window.clearTimeout(revalidateTimerRef.current)
        revalidateTimerRef.current = null
      }

      revalidateTimerRef.current = window.setTimeout(() => {
        revalidateTimerRef.current = null
        if (targetTab === 'history') {
          void loadHistoryOrders(reason)
          return
        }
        void loadMyTrades(reason)
      }, Math.max(delayMs, 0))
    },
    [isLoggedIn, loadHistoryOrders, loadMyTrades, symbol],
  )

  useEffect(() => {
    if (tab !== 'history' && tab !== 'trades') return
    scheduleHistoryAndTradesReload('active-tab', 0, tab)
  }, [refreshKey, scheduleHistoryAndTradesReload, symbol, tab])

  const hasActivePrivateDataScope = Boolean(activePrivateDataScope) &&
    loadedPrivateDataScope === activePrivateDataScope
  const scopedCurrentOrders = hasActivePrivateDataScope ? currentOrders : EMPTY_SPOT_ORDERS
  const scopedHistoryOrders = hasActivePrivateDataScope ? historyOrders : EMPTY_SPOT_ORDERS
  const scopedMyTrades = hasActivePrivateDataScope ? myTrades : EMPTY_SPOT_TRADES
  const scopedOptimisticTrades = hasActivePrivateDataScope ? optimisticTrades : EMPTY_SPOT_TRADES

  const userOrderSideMap = useMemo(() => {
    const map = new Map<string, TradeDirection>()
    const allOrders = mergeOrdersById(scopedCurrentOrders, scopedHistoryOrders)

    for (const order of allOrders) {
      const orderId = normalizeOrderId(order?.id)
      const orderSide = normalizeTradeDirection(order?.side)
      if (!orderId || !orderSide) continue
      map.set(orderId, orderSide)
    }

    return map
  }, [scopedCurrentOrders, scopedHistoryOrders])

  const visibleCurrentOrders = useMemo(
    () => mergeOrdersById(scopedCurrentOrders, scopedHistoryOrders).filter(isCurrentOrder),
    [scopedCurrentOrders, scopedHistoryOrders],
  )

  const visibleHistoryOrders = useMemo(
    () => mergeOrdersById(scopedCurrentOrders, scopedHistoryOrders).filter(isHistoryOrder),
    [scopedCurrentOrders, scopedHistoryOrders],
  )

  const orderFeeDisplayMap = useMemo(() => {
    const map = new Map<string, string>()
    mergeOrdersById(scopedCurrentOrders, scopedHistoryOrders).forEach((order) => {
      const orderId = normalizeOrderId(order.id)
      const feeDisplay = formatFeeAmount(order)
      if (orderId && feeDisplay !== '--') {
        map.set(orderId, feeDisplay)
      }
    })
    return map
  }, [scopedCurrentOrders, scopedHistoryOrders])

  const visibleTrades = useMemo(
    () => mergeRestAndOptimisticTrades(scopedMyTrades, scopedOptimisticTrades, currentSymbolRef.current || normalizeSymbol(symbol)),
    [scopedMyTrades, scopedOptimisticTrades, symbol],
  )

  const rows = useMemo(() => {
    if (tab === 'current') return visibleCurrentOrders
    if (tab === 'history') return visibleHistoryOrders
    return visibleTrades
  }, [tab, visibleCurrentOrders, visibleHistoryOrders, visibleTrades])

  const currentPage = pages[tab]
  const totalPages = getTotalPages(rows.length)
  const pagedRows = useMemo(() => {
    const start = (currentPage - 1) * PAGE_SIZE
    return rows.slice(start, start + PAGE_SIZE)
  }, [rows, currentPage])
  const hasRows = pagedRows.length > 0

  useEffect(() => {
    setPages((prev) => ({
      current: Math.min(prev.current, getTotalPages(visibleCurrentOrders.length)),
      history: Math.min(prev.history, getTotalPages(visibleHistoryOrders.length)),
      trades: Math.min(prev.trades, getTotalPages(visibleTrades.length)),
    }))
  }, [visibleCurrentOrders.length, visibleHistoryOrders.length, visibleTrades.length])

  const handlePageChange = (nextPage: number) => {
    setPages((prev) => ({
      ...prev,
      [tab]: Math.min(Math.max(nextPage, 1), totalPages),
    }))
  }

  const handleTabChange = (nextTab: TabKey) => {
    setTab(nextTab)
    setActionError('')
    setActionSuccess('')
  }

  const handleCancelOrder = async (order: SpotOrderItem) => {
    if (!canCancelOrder(order) || cancelingOrderId !== null) {
      return
    }

    try {
      setActionError('')
      setActionSuccess('')
      setCancelingOrderId(order.id)
      await cancelSpotOrder(order.id)
      setCurrentOrders((prev) => prev.filter((item) => item.id !== order.id))
      setActionSuccess(t('spotOrderCancelSuccess', 'asset'))
      onOrdersChanged?.()
      if (activeTabRef.current === 'history' || activeTabRef.current === 'trades') {
        scheduleHistoryAndTradesReload('cancel', 0, activeTabRef.current)
      }
    } catch (err) {
      console.error('SpotOrderTabs cancel order error:', err)
      setActionError(normalizeActionError(err, t))
    } finally {
      setCancelingOrderId(null)
    }
  }

  return (
    <div className="tabular-nums flex h-full min-w-0 flex-col bg-[#12171f] px-2 py-1.5">
      <div className="mb-1 flex items-center justify-between gap-2">
        <div className="flex gap-2">
          <button
            className={`rounded-md px-2 py-0.5 text-[12px] font-medium ${
              tab === 'current'
                ? 'bg-white text-black'
                : 'bg-white/5 text-white/70'
            }`}
            onClick={() => handleTabChange('current')}
          >
            {t('currentOrders', 'asset')}
          </button>

          <button
            className={`rounded-md px-2 py-0.5 text-[12px] font-medium ${
              tab === 'history'
                ? 'bg-white text-black'
                : 'bg-white/5 text-white/70'
            }`}
            onClick={() => handleTabChange('history')}
          >
            {t('historyOrders', 'asset')}
          </button>

          <button
            className={`rounded-md px-2 py-0.5 text-[12px] font-medium ${
              tab === 'trades'
                ? 'bg-white text-black'
                : 'bg-white/5 text-white/70'
            }`}
            onClick={() => handleTabChange('trades')}
          >
            {t('myTrades', 'asset')}
          </button>
        </div>

          <div className="text-xs text-white/40">{`${t('tradePair', 'asset')}: ${displaySymbol}`}</div>
        </div>

      {actionError ? (
        <div className="mb-1 rounded-md border border-red-500/20 bg-red-500/10 px-2 py-1 text-[12px] text-red-300">
          {actionError}
        </div>
      ) : null}

      {actionSuccess ? (
        <div className="mb-1 rounded-md border border-green-500/20 bg-green-500/10 px-2 py-1 text-[12px] text-green-300">
          {actionSuccess}
        </div>
      ) : null}

      {tab === 'current' ? (
        <>
          <div className="min-w-0">
            <table className="w-full min-w-0 table-fixed text-left text-[12px]">
              <thead className="text-[11px] text-gray-400">
                <tr className="border-b border-white/10">
                  <th className="w-[21%] py-1.5 pr-2 font-medium">{t('time', 'asset')}</th>
                  <th className="w-[10%] py-1.5 pr-2 font-medium">{t('spotOrderSide', 'asset')}</th>
                  <th className="w-[13%] py-1.5 pr-2 font-medium">{t('price', 'asset')}</th>
                  <th className="w-[15%] py-1.5 pr-2 font-medium">{t('spotOrderAmount', 'asset')}</th>
                  <th className="w-[15%] py-1.5 pr-2 font-medium">{t('spotOrderFilledFee', 'asset')}</th>
                  <th className="w-[14%] py-1.5 pr-2 font-medium">{t('status', 'asset')}</th>
                  <th className="w-[12%] py-1.5 text-right font-medium">{t('spotOrderAction', 'asset')}</th>
                </tr>
              </thead>

              {hasRows ? (
                <tbody>
                  {(pagedRows as SpotOrderItem[]).map((item) => {
                    const feeDisplay = getOrderFeeDisplay(item, 'current', t)

                    return (
                    <tr
                      key={item.id}
                      className="h-8 border-b border-white/10 text-[12px] text-white/90 transition-colors hover:bg-white/5"
                    >
                      <td className="py-1.5 pr-2 text-white/65">
                        <div className="truncate whitespace-nowrap">{formatTime(item.created_at, displayTimeZone, locale)}</div>
                      </td>
                      <td className={`py-1.5 pr-2 font-medium ${sideClass(item.side)}`}>
                        {sideText(item.side, t)}
                      </td>
                      <td className="py-1.5 pr-2">
                        <div className="truncate whitespace-nowrap">{formatOrderDisplayPrice(item, t, pricePrecision)}</div>
                      </td>
                      <td className="py-1.5 pr-2">
                        <div className="truncate whitespace-nowrap">{fmtAmount(item.amount)}</div>
                      </td>
                      <td className="py-1.5 pr-2" title={feeDisplay.title || undefined}>
                        <div className="truncate whitespace-nowrap">{fmtAmount(item.filled_amount)}</div>
                        <div className="mt-0.5 min-w-0">
                          <div className="truncate whitespace-nowrap text-[12px] font-medium tabular-nums text-white/80">
                            {feeDisplay.main}
                          </div>
                          {feeDisplay.sub ? (
                            <div className="truncate whitespace-nowrap text-[10px] text-gray-400">
                              {feeDisplay.sub}
                            </div>
                          ) : null}
                        </div>
                      </td>
                      <td className={`py-1.5 pr-2 ${statusClass(item.status)}`}>
                        <div className="truncate whitespace-nowrap">{statusText(item.status, t)}</div>
                      </td>
                      <td className="py-1.5 text-right">
                        {canCancelOrder(item) ? (
                          <button
                            type="button"
                            onClick={() => handleCancelOrder(item)}
                            disabled={cancelingOrderId === item.id}
                            className={`rounded bg-red-500/10 px-2 py-1 text-[12px] text-red-400 transition-colors hover:bg-red-500/20 ${
                              cancelingOrderId === item.id
                                ? 'cursor-not-allowed opacity-60'
                                : ''
                            }`}
                          >
                            {cancelingOrderId === item.id ? t('canceling', 'asset') : t('cancel', 'asset')}
                          </button>
                        ) : (
                          <span className="text-xs text-white/25">-</span>
                        )}
                      </td>
                    </tr>
                    )
                  })}
                </tbody>
              ) : null}
            </table>
          </div>

          <RecordsFooter
            hasRows={hasRows}
            currentPage={currentPage}
            totalPages={totalPages}
            onPageChange={handlePageChange}
          />
        </>
      ) : tab === 'history' ? (
        <>
          <HistoryOrderRecords
            rows={pagedRows as SpotOrderItem[]}
            pricePrecision={pricePrecision}
            timeZone={displayTimeZone}
            locale={locale}
          />
          <RecordsFooter
            hasRows={hasRows}
            currentPage={currentPage}
            totalPages={totalPages}
            onPageChange={handlePageChange}
          />
        </>
      ) : (
        <>
          <TradeRecords
            rows={pagedRows as TradeRowItem[]}
            pricePrecision={pricePrecision}
            currentUserId={user?.id}
            userOrderSideMap={userOrderSideMap}
            orderFeeDisplayMap={orderFeeDisplayMap}
            timeZone={displayTimeZone}
            locale={locale}
          />
          <RecordsFooter
            hasRows={hasRows}
            currentPage={currentPage}
            totalPages={totalPages}
            onPageChange={handlePageChange}
          />
        </>
      )}
    </div>
  )
}

function HistoryOrderRecords({
  rows,
  pricePrecision,
  timeZone,
  locale,
}: {
  rows: SpotOrderItem[]
  pricePrecision: number
  timeZone: string
  locale?: string
}) {
  const { t } = useLocaleContext()
  if (rows.length === 0) return null

  return (
    <div className="space-y-2 p-2">
      {rows.map((item) => {
        const feeDisplay = getOrderFeeDisplay(item, 'history', t)

        return (
          <div
            key={item.id}
            className="rounded-lg border border-white/[0.07] bg-[#0d1218] px-3 py-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.02)]"
          >
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[13px] font-semibold text-white">
                    {formatSpotDisplaySymbol(item.symbol)}
                  </span>
                  <span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${sideClass(item.side)}`}>
                    {sideText(item.side, t)}
                  </span>
                  <span className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[11px] text-white/65">
                    {orderTypeText(item.order_type, t)}
                  </span>
                </div>
                <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-white/45">
                  <RecordMeta label={t('spotOrderOrderPrice', 'asset')} value={formatOrderDisplayPrice(item, t, pricePrecision)} />
                  <RecordMeta label={t('spotOrderAmount', 'asset')} value={fmtAmount(item.amount)} />
                  <RecordMeta label={t('spotOrderFilledAmount', 'asset')} value={fmtAmount(item.filled_amount)} />
                </div>
              </div>

              <div className="flex shrink-0 flex-col items-start gap-1 sm:items-end">
                <span className={`rounded border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[11px] font-medium ${statusClass(item.status)}`}>
                  {statusText(item.status, t)}
                </span>
                <div className="flex flex-wrap items-center gap-2 text-[11px] text-white/45 sm:justify-end">
                  <span className="font-medium tabular-nums text-white/60" title={feeDisplay.title || undefined}>
                    {feeDisplay.main}
                  </span>
                  <span>{formatRecordTime(item.updated_at || item.created_at, timeZone, locale)}</span>
                </div>
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function TradeRecords({
  rows,
  pricePrecision,
  currentUserId,
  userOrderSideMap,
  orderFeeDisplayMap,
  timeZone,
  locale,
}: {
  rows: TradeRowItem[]
  pricePrecision: number
  currentUserId?: number | string | null
  userOrderSideMap: Map<string, TradeDirection>
  orderFeeDisplayMap: Map<string, string>
  timeZone: string
  locale?: string
}) {
  const { t } = useLocaleContext()
  if (rows.length === 0) return null

  if (process.env.NODE_ENV !== 'production') {
    console.log('[spot trades rows]', rows.slice(0, 5))
  }

  return (
    <div className="space-y-2 p-2">
      {rows.map((item) => {
        const tradeSide = getTradeSideForUser(item, currentUserId, userOrderSideMap)
        const directFeeDisplay = formatTradeFeeDisplay(item)
        const fallbackFeeDisplay = getTradeOrderFeeDisplay(item, orderFeeDisplayMap)
        const feeDisplay = directFeeDisplay !== '--' ? directFeeDisplay : fallbackFeeDisplay

        if (process.env.NODE_ENV !== 'production') {
          console.log('[trade fee display]', {
            id: item.trade_id,
            fee_amount: item.fee_amount ?? item.feeAmount ?? item.fee,
            feeAsset: item.fee_asset_symbol || item.feeAssetSymbol || item.fee_asset || item.feeAsset || item.fee_asset_id,
            fallbackFee: fallbackFeeDisplay,
            display: feeDisplay,
          })
        }

        return (
          <div
            key={item.trade_id}
            className="rounded-lg border border-white/[0.07] bg-[#0d1218] px-3 py-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.02)]"
          >
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[13px] font-semibold text-white">
                    {formatSpotDisplaySymbol(item.symbol)}
                  </span>
                  <span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${tradeSideClass(tradeSide)}`}>
                    {sideText(tradeSide, t)}
                  </span>
                </div>
                <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-white/45">
                  <RecordMeta label={t('spotOrderTradePrice', 'asset')} value={fmtPrice(item.price, pricePrecision)} />
                  <RecordMeta label={t('spotOrderAmount', 'asset')} value={fmtAmount(item.amount)} />
                  <RecordMeta label={t('spotOrderQuoteAmount', 'asset')} value={fmtAmount(item.quote_amount)} />
                </div>
              </div>

              <div className="flex shrink-0 flex-col items-start gap-1 text-[11px] text-white/45 sm:items-end">
                <div className="flex items-center justify-end gap-2 whitespace-nowrap">
                  <span className="text-[12px] text-[#f0b90b]">{t('fee', 'asset')}</span>
                  <span className="tabular-nums font-medium text-white/60">{feeDisplay}</span>
                </div>
                <span>{formatRecordTime(item.created_at, timeZone, locale)}</span>
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function RecordMeta({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span>{label}</span>
      <span className="font-medium tabular-nums text-white/70">{value}</span>
    </span>
  )
}

function getTradeOrderFeeDisplay(trade: TradeRowItem, orderFeeDisplayMap: Map<string, string>) {
  for (const orderId of getTradeOrderIds(trade)) {
    const feeDisplay = orderFeeDisplayMap.get(orderId)
    if (feeDisplay && feeDisplay !== '--') return feeDisplay
  }
  return '--'
}

function RecordsFooter({
  hasRows,
  currentPage,
  totalPages,
  onPageChange,
}: {
  hasRows: boolean
  currentPage: number
  totalPages: number
  onPageChange: (page: number) => void
}) {
  const { t } = useLocaleContext()

  if (!hasRows) {
    return (
      <div className="border-b border-white/10 px-2 py-8 text-center text-[13px] text-white/35">
        {t('noRecords', 'asset')}
      </div>
    )
  }

  return (
    <div className="mt-1 flex items-center justify-end gap-2 text-[12px] text-white/60">
      <button
        type="button"
        onClick={() => onPageChange(currentPage - 1)}
        disabled={currentPage <= 1}
        className={`rounded-md border border-white/10 px-2 py-1 ${
          currentPage <= 1
            ? 'cursor-not-allowed opacity-40'
            : 'hover:bg-white/5'
        }`}
      >
        {t('prevPage', 'asset')}
      </button>
      <div>{formatMessage(t('spotOrderPageIndicator', 'asset'), { current: currentPage, total: totalPages })}</div>
      <button
        type="button"
        onClick={() => onPageChange(currentPage + 1)}
        disabled={currentPage >= totalPages}
        className={`rounded-md border border-white/10 px-2 py-1 ${
          currentPage >= totalPages
            ? 'cursor-not-allowed opacity-40'
            : 'hover:bg-white/5'
        }`}
      >
        {t('nextPage', 'asset')}
      </button>
    </div>
  )
}
