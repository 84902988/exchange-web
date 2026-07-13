import { request } from '../core/request'

export type ContractPositionSide = 'LONG' | 'SHORT'
export type ContractOrderType = 'MARKET' | 'LIMIT'
export type ContractOrderAction = 'OPEN' | 'CLOSE'
export type ContractTpSlTriggerPriceType = 'MARK_PRICE' | 'LAST_PRICE'

export type ContractAccountSummary = {
  user_id: number
  margin_asset: string
  available_margin: string
  used_margin: string
  frozen_margin: string
  position_margin: string
  realized_pnl: string
  unrealized_pnl: string
  equity: string
}

export type ContractTransferResponse = {
  transfer_no: string
  direction: 'IN' | 'OUT'
  margin_asset: string
  amount: string
  account: ContractAccountSummary
}

export type ContractQuoteAvailability = {
  market_status?: 'OPEN' | 'CLOSED' | 'UNKNOWN' | string
  quote_freshness?: 'LIVE' | 'STALE' | 'LAST_VALID' | 'FALLBACK' | string
  quote_source?: 'LIVE' | 'LAST_GOOD_BBO' | 'LAST_VALID' | 'FALLBACK' | 'STALE' | 'INVALID' | string
  closed_market_execution_mode?: 'DISABLED' | 'LAST_GOOD_BBO' | string
  source?: string | null
  executable?: boolean
  bid?: string | number | null
  ask?: string | number | null
  bid_price?: string | number | null
  ask_price?: string | number | null
  best_bid?: string | number | null
  best_ask?: string | number | null
}

export type ContractQuoteDisplayStatus =
  | 'LOADING'
  | 'LIVE'
  | 'LAST_QUOTE'
  | 'EXPIRED_LAST_QUOTE'
  | 'UNAVAILABLE'

export type ContractDepthMode =
  | 'FULL_DEPTH'
  | 'SYNTHETIC_FROM_BBO'
  | 'BBO_ONLY'
  | string

export type ContractMarketViewDisplayState =
  | 'LOADING'
  | 'LIVE_TRADABLE'
  | 'CLOSED_LAST_GOOD_TRADABLE'
  | 'CLOSED_LAST_GOOD_DISPLAY_ONLY'
  | 'EXPIRED'
  | 'UNAVAILABLE'
  | string

export type ContractKlineMode = 'TRADE_DRIVEN' | 'QUOTE_DRIVEN' | 'PROVIDER_KLINE' | string

export type ContractKlineCurrentCandle = {
  time?: number | string
  open_time?: number | string
  timestamp?: number | string
  open: number | string
  high: number | string
  low: number | string
  close: number | string
  volume: number | string
  interval?: string | null
  kline_mode?: ContractKlineMode | null
  price_source?: 'LIVE_MID' | 'TRADE_TICK' | 'KLINE_CLOSE' | string | null
  volume_source?: 'PROVIDER_KLINE' | string | null
  updated_at_ms?: number | string | null
}

export type ContractMarketViewDetail = {
  symbol: string
  display_symbol: string
  market_type: string
  category: string
  market_status: string
  display_state: ContractMarketViewDisplayState
  display_price?: string | number | null
  display_price_source: string
  current_price_source?: string | null
  ticker_source?: string | null
  ticker_freshness?: string | null
  depth_source?: string | null
  depth_freshness?: string | null
  trades_source?: string | null
  trades_freshness?: string | null
  kline_source?: string | null
  kline_freshness?: string | null
  last_trade_price?: string | number | null
  last_trade_time?: string | null
  best_bid?: string | number | null
  best_ask?: string | number | null
  spread?: string | number | null
  executable: boolean
  execution_bid?: string | number | null
  execution_ask?: string | number | null
  execution_mode: string
  last_good_bbo_valid: boolean
  price_age_ms?: number | null
  quote_time?: string | null
  last_good_at?: string | null
  reason_code: string
  warnings: string[]
  kline_current_candle?: ContractKlineCurrentCandle | null
  raw_source_summary: Record<string, unknown>
}

const LIVE_QUOTE_SOURCES = new Set(['LIVE_WS', 'LIVE'])
const PROVIDER_NATIVE_LIVE_QUOTE_SOURCES = new Set(['ITICK_DEPTH', 'ITICK_QUOTE'])
const UNSAFE_QUOTE_FRESHNESSES = new Set(['STALE', 'FALLBACK', 'LAST_VALID', 'INVALID', 'CACHE_STALE'])
const UNSAFE_QUOTE_SOURCE_TOKENS = ['FALLBACK', 'STALE', 'LAST_VALID', 'INVALID', 'CACHE_STALE']

function toPositiveQuoteNumber(value?: string | number | null): number {
  if (value === undefined || value === null || value === '') return 0
  const parsed = Number(typeof value === 'string' ? value.replace(/,/g, '').trim() : value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

export function isExpiredLastGoodBboQuote(quote?: ContractQuoteAvailability | null): boolean {
  if (!quote || quote.executable !== false) return false
  const marketStatus = String(quote.market_status || '').trim().toUpperCase()
  const mode = String(quote.closed_market_execution_mode || '').trim().toUpperCase()
  if (mode === 'DISABLED') return false
  if (marketStatus !== 'CLOSED' && marketStatus !== 'HOLIDAY') return false

  const quoteSource = String(quote.quote_source || '').trim().toUpperCase()
  const source = String(quote.source || '').trim().toUpperCase()
  const freshness = String(quote.quote_freshness || '').trim().toUpperCase()
  const bid = toPositiveQuoteNumber(quote.bid_price ?? quote.best_bid ?? quote.bid)
  const ask = toPositiveQuoteNumber(quote.ask_price ?? quote.best_ask ?? quote.ask)
  const hasValidBbo = bid > 0 && ask > 0 && ask >= bid

  return (
    mode === 'LAST_GOOD_BBO' ||
    quoteSource === 'LAST_GOOD_BBO' ||
    source === 'LAST_GOOD_BBO' ||
    (freshness === 'LAST_VALID' && hasValidBbo)
  )
}

export function getContractQuoteDisplayStatus(
  quote?: ContractQuoteAvailability | null,
  options: { loading?: boolean } = {},
): ContractQuoteDisplayStatus {
  if (options.loading) return 'LOADING'
  if (!quote) return 'UNAVAILABLE'
  if (isExpiredLastGoodBboQuote(quote)) return 'EXPIRED_LAST_QUOTE'

  const quoteSource = String(quote.quote_source || '').trim().toUpperCase()
  const source = String(quote.source || '').trim().toUpperCase()
  const freshness = String(quote.quote_freshness || '').trim().toUpperCase()
  const sources = new Set([quoteSource, source].filter(Boolean))
  const executable = quote.executable === true

  if (sources.has('LAST_GOOD_BBO') && executable) return 'LAST_QUOTE'
  if (quote.executable === false) return 'UNAVAILABLE'

  const hasUnsafeSource = Array.from(sources).some((item) => (
    UNSAFE_QUOTE_SOURCE_TOKENS.some((token) => item.includes(token))
  ))
  if (UNSAFE_QUOTE_FRESHNESSES.has(freshness) || hasUnsafeSource) return 'UNAVAILABLE'

  const hasProviderNativeLiveSource = Array.from(sources).some((item) => (
    PROVIDER_NATIVE_LIVE_QUOTE_SOURCES.has(item)
  ))
  if (executable && freshness === 'LIVE' && hasProviderNativeLiveSource) return 'LIVE'
  if (executable && freshness === 'LIVE') return 'LIVE'
  if (executable && Array.from(sources).some((item) => LIVE_QUOTE_SOURCES.has(item))) return 'LIVE'

  return 'UNAVAILABLE'
}

export type ContractQuote = ContractQuoteAvailability & {
  symbol: string
  provider: string
  provider_symbol: string
  price_precision?: number
  market_status?: 'OPEN' | 'CLOSED' | 'UNKNOWN' | string
  market_status_text?: string | null
  market_session_code?: string | null
  market_timezone?: string | null
  market_trading_hours?: string | null
  market_session_type?: string | null
  quote_freshness?: 'LIVE' | 'STALE' | 'LAST_VALID' | 'FALLBACK' | string
  quote_source?: 'LIVE' | 'LAST_GOOD_BBO' | 'LAST_VALID' | 'FALLBACK' | 'STALE' | 'INVALID' | string
  closed_market_execution_mode?: 'DISABLED' | 'LAST_GOOD_BBO' | string
  executable?: boolean
  is_realtime?: boolean
  last_good_at?: string | null
  stale?: boolean
  spread_x?: string | number | null
  manual_spread_x?: string | number | null
  effective_total_spread?: string | number | null
  single_side_spread_fee_price?: string | number | null
  bid?: string | number | null
  ask?: string | number | null
  bid_price: string
  ask_price: string
  best_bid?: string | number | null
  best_ask?: string | number | null
  raw_bid_price?: string | number | null
  raw_ask_price?: string | number | null
  last_price: string
  mark_price: string
  index_price?: string | number | null
  funding_rate?: string | number | null
  next_funding_time?: number | string | null
  source: string
  ts: string
}

export type ContractDepthLevel = {
  price: string
  amount: string
}

export type ContractDepth = {
  symbol: string
  provider: string
  provider_symbol: string
  price_precision?: number
  market_status?: 'OPEN' | 'CLOSED' | 'UNKNOWN' | string
  market_status_text?: string | null
  market_session_code?: string | null
  market_timezone?: string | null
  market_trading_hours?: string | null
  market_session_type?: string | null
  quote_freshness?: 'LIVE' | 'STALE' | 'LAST_VALID' | 'FALLBACK' | string
  quote_source?: 'LIVE' | 'LAST_GOOD_BBO' | 'LAST_VALID' | 'FALLBACK' | 'STALE' | 'INVALID' | string
  depth_mode?: ContractDepthMode
  closed_market_execution_mode?: 'DISABLED' | 'LAST_GOOD_BBO' | string
  executable?: boolean
  is_realtime?: boolean
  last_good_at?: string | null
  spread_x?: string | number | null
  manual_spread_x?: string | number | null
  effective_total_spread?: string | number | null
  single_side_spread_fee_price?: string | number | null
  bids: ContractDepthLevel[]
  asks: ContractDepthLevel[]
  raw_bids?: ContractDepthLevel[] | null
  raw_asks?: ContractDepthLevel[] | null
  bid?: string | number | null
  ask?: string | number | null
  best_bid?: string | null
  best_ask?: string | null
  raw_best_bid?: string | number | null
  raw_best_ask?: string | number | null
  source: string
  ts: string
}

export type ContractSymbolItem = {
  symbol: string
  display_name: string
  category: string
  asset_type?: string | null
  underlying_type?: string | null
  contract_type?: string | null
  rowType?: string | null
  provider: string
  provider_symbol: string
  quote_asset: string
  tp_sl_trigger_price_type?: ContractTpSlTriggerPriceType | string | null
  price_precision: number
  quantity_precision: number
  max_leverage: number
  status: number
  market_status?: 'OPEN' | 'CLOSED' | 'UNKNOWN' | string
  market_status_text?: string | null
  market_session_code?: string | null
  market_timezone?: string | null
  market_trading_hours?: string | null
  market_session_type?: string | null
}

export type ContractSymbolListResponse = {
  items: ContractSymbolItem[]
  total: number
  page: number
  page_size: number
}

export type ContractTickerItem = {
  symbol: string
  market_status?: 'OPEN' | 'CLOSED' | 'UNKNOWN' | string
  market_status_text?: string | null
  market_session_code?: string | null
  market_timezone?: string | null
  market_trading_hours?: string | null
  market_session_type?: string | null
  quote_freshness?: 'LIVE' | 'STALE' | 'LAST_VALID' | 'FALLBACK' | string
  last_price?: string | number | null
  price?: string | number | null
  price_change_24h?: string | number | null
  price_change_percent_24h?: string | number | null
  change_24h?: string | number | null
  priceChangePercent?: string | number | null
  high_24h?: string | number | null
  low_24h?: string | number | null
  base_volume_24h?: string | number | null
  quote_volume_24h?: string | number | null
  source?: string | null
  ts?: string | null
}

export type ContractTickerListResponse = {
  items: ContractTickerItem[]
}

export type ContractMarketKlineItem = {
  open_time?: number | string
  time?: number | string
  timestamp?: number | string
  open: number | string
  high: number | string
  low: number | string
  close: number | string
  volume: number | string
}

export type ContractMarketKlineMetadataResponse = {
  items: ContractMarketKlineItem[]
  cache_status: string
  freshness: 'RECENT' | 'CACHED' | 'STALE' | 'MISSING' | string
  stale: boolean
  history_incomplete: boolean
  history_complete: boolean | null
  has_more_before: boolean | null
  provider_error_code: string | null
  retryable: boolean
}

export type ContractMarketTrade = {
  id: number | string
  price: string
  last_price?: string
  qty: string
  amount?: string
  volume?: string
  quoteQty?: string
  time: number
  ts?: number
  side?: string | null
  source?: string | null
  quote_source?: string | null
  quote_freshness?: string | null
  price_source?: 'TRADE_TICK' | 'KLINE_CLOSE' | 'SYNTHETIC_FROM_QUOTE' | string | null
  synthetic?: boolean
  isBuyerMaker?: boolean
}

export type ContractOpenOrderPayload = {
  symbol: string
  position_side: ContractPositionSide
  order_type: ContractOrderType
  price?: string | null
  quantity: string
  leverage: number
  take_profit_price?: string | null
  stop_loss_price?: string | null
}

export type ContractCloseOrderPayload = {
  position_id: number
  order_type: ContractOrderType
  price?: string | null
  quantity?: string | null
}

export type ContractCloseSummaryOrderPayload = {
  symbol: string
  side: ContractPositionSide
  order_type: ContractOrderType
  price?: string | null
  quantity?: string | null
}

export type ContractPositionTpSlPayload = {
  take_profit_price?: string | null
  stop_loss_price?: string | null
}

export type ContractPositionTpSlResponse = {
  position_id: number
  symbol: string
  side: string
  mark_price: string
  take_profit_price?: string | null
  stop_loss_price?: string | null
}

export type ContractOrderResponse = {
  order_id: number
  order_no: string
  symbol: string
  position_side: string
  order_type: string
  price?: string | null
  quantity: string
  leverage: number
  margin_amount: string
  fee_amount?: string
  spread_fee: string
  status: string
  avg_price: string
  position_id?: number | null
  realized_pnl?: string | null
  released_margin?: string | null
  remaining_position_quantity?: string | null
}

export type ContractCloseSummaryOrderResponse = {
  symbol: string
  side: string
  order_type: string
  requested_quantity: string
  closed_quantity: string
  submitted_quantity: string
  generated_order_ids: number[]
  generated_trade_ids: number[]
  affected_position_ids: number[]
  status: string
}

export type ContractPositionItem = {
  id: number
  symbol: string
  side: string
  leverage: number
  quantity: string
  entry_price: string
  mark_price: string
  margin_amount: string
  open_fee: string
  unrealized_pnl: string
  realized_pnl: string
  liquidation_price?: string | null
  roe?: string | null
  margin_ratio?: string | null
  liquidation_distance?: string | null
  liquidation_distance_rate?: string | null
  warning_price: string
  take_profit_price?: string | null
  stop_loss_price?: string | null
  close_reason?: string | null
  opened_quantity?: string | null
  closed_quantity?: string | null
  opened_margin_amount?: string | null
  released_margin_amount?: string | null
  close_avg_price?: string | null
  status: string
  is_liquidatable?: boolean
  opened_at?: string | null
  closed_at?: string | null
}

export type ContractPositionListResponse = {
  items: ContractPositionItem[]
}

export type ContractPositionPageResponse = {
  items: ContractPositionItem[]
  total: number
  page: number
  page_size: number
}

export type ContractPositionTpSlMode = 'NONE' | 'SINGLE' | 'MIXED'

export type ContractPositionSummaryItem = {
  symbol: string
  side: string
  leverage?: number | null
  quantity: string
  avg_entry_price: string
  mark_price?: string | null
  margin_amount: string
  unrealized_pnl: string
  liquidation_price?: string | null
  roe?: string | null
  margin_ratio?: string | null
  liquidation_distance?: string | null
  liquidation_distance_rate?: string | null
  position_ids: number[]
  count: number
  take_profit_price?: string | null
  stop_loss_price?: string | null
  tp_sl_mode: ContractPositionTpSlMode
}

export type ContractPositionSummaryListResponse = {
  items: ContractPositionSummaryItem[]
}

export type ContractOrderListItem = {
  id: number
  order_no: string
  symbol: string
  position_id?: number | null
  side?: string
  position_side: string
  action: string
  order_type: string
  price?: string | null
  quantity: string
  leverage: number
  margin_amount: string
  fee_amount?: string
  spread_fee: string
  filled_quantity: string
  avg_price: string
  status: string
  fail_reason?: string | null
  take_profit_price?: string | null
  stop_loss_price?: string | null
  created_at?: string | null
}

export type ContractOrderListResponse = {
  items: ContractOrderListItem[]
  total: number
  page: number
  page_size: number
}

export type ContractTradeListItem = {
  id: number
  trade_no: string
  order_id: number
  position_id?: number | null
  symbol: string
  position_side: string
  action: string
  price: string
  quantity: string
  notional: string
  leverage: number
  margin_amount: string
  fee_amount?: string
  spread_fee: string
  realized_pnl: string
  created_at?: string | null
}

export type ContractTradeListResponse = {
  items: ContractTradeListItem[]
  total: number
  page: number
  page_size: number
}

export type ContractPrivateWsBridgeHealth = {
  status: 'ok' | 'degraded' | string
  channel: string
  subscriber?: {
    alive?: boolean
    age_seconds?: number | null
    last_seen_at?: string | null
    loop_status?: string | null
    pid?: number | string | null
    hostname?: string | null
  }
  publisher?: {
    status?: string | null
    failure_count?: number
    last_success_at?: string | null
    last_failure_at?: string | null
    last_error?: string | null
  }
  rest_fallback_recommended?: boolean
}

function withQuery(path: string, params: Record<string, string | number | undefined | null>) {
  const query = new URLSearchParams()
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && String(value) !== '') {
      query.set(key, String(value))
    }
  })
  const text = query.toString()
  return text ? `${path}?${text}` : path
}

export function getContractAccountSummary(): Promise<ContractAccountSummary> {
  return request<ContractAccountSummary>('/contract/account/summary')
}

export function transferInContract(amount: string): Promise<ContractTransferResponse> {
  return request<ContractTransferResponse>('/contract/account/transfer-in', {
    method: 'POST',
    body: JSON.stringify({ amount, margin_asset: 'USDT', account: 'funding' }),
  })
}

export function transferOutContract(amount: string): Promise<ContractTransferResponse> {
  return request<ContractTransferResponse>('/contract/account/transfer-out', {
    method: 'POST',
    body: JSON.stringify({ amount, margin_asset: 'USDT', account: 'funding' }),
  })
}

export function getContractQuote(symbol: string): Promise<ContractQuote> {
  return request<ContractQuote>(withQuery('/contract/market/quote', { symbol }))
}

export function getContractMarketView(
  symbol: string,
  options: Pick<RequestInit, 'signal'> = {},
): Promise<ContractMarketViewDetail> {
  return request<ContractMarketViewDetail>(withQuery('/contract/market/view', { symbol }), options)
}

export function getContractSymbols(params: {
  category?: string
  quote?: string
  keyword?: string
  page?: number
  page_size?: number
} = {}): Promise<ContractSymbolListResponse> {
  return request<ContractSymbolListResponse>(withQuery('/contract/market/symbols', params))
}

export function getContractTickers(params: {
  symbols?: string | string[]
  limit?: number
} = {}): Promise<ContractTickerListResponse> {
  const selectedSymbols = Array.isArray(params.symbols)
    ? params.symbols.map((item) => String(item || '').trim().toUpperCase()).filter(Boolean).join(',')
    : params.symbols

  return request<ContractTickerListResponse>(withQuery('/contract/market/tickers', {
    symbols: selectedSymbols,
    limit: params.limit,
  }))
}

export async function getContractDepth(symbol: string, limit = 20): Promise<ContractDepth> {
  const depth = await request<Omit<ContractDepth, 'bids' | 'asks' | 'raw_bids' | 'raw_asks'> & {
    bids: string[][]
    asks: string[][]
    raw_bids?: string[][] | null
    raw_asks?: string[][] | null
  }>(withQuery('/contract/market/depth', { symbol, limit }))

  return {
    ...depth,
    bids: depth.bids.map(([price, amount]) => ({ price, amount })),
    asks: depth.asks.map(([price, amount]) => ({ price, amount })),
    raw_bids: depth.raw_bids?.map(([price, amount]) => ({ price, amount })) ?? null,
    raw_asks: depth.raw_asks?.map(([price, amount]) => ({ price, amount })) ?? null,
  }
}

export function getContractMarketKlines(params: {
  symbol: string
  interval: string
  limit?: number
  endTimeMs?: number
}): Promise<ContractMarketKlineItem[]> {
  return request<ContractMarketKlineItem[]>(withQuery('/contract/market/kline', {
    symbol: params.symbol,
    interval: params.interval,
    limit: params.limit,
    end_time_ms: params.endTimeMs,
  }))
}

export function getContractMarketKlinesMetadata(params: {
  symbol: string
  interval: string
  limit?: number
  endTimeMs?: number
}): Promise<ContractMarketKlineMetadataResponse> {
  return request<ContractMarketKlineMetadataResponse>(withQuery('/contract/market/kline', {
    symbol: params.symbol,
    interval: params.interval,
    limit: params.limit,
    end_time_ms: params.endTimeMs,
    include_metadata: 1,
  }))
}

export function getContractMarketTrades(symbol: string, limit = 30): Promise<ContractMarketTrade[]> {
  return request<ContractMarketTrade[]>(withQuery('/contract/market/trades', { symbol, limit }))
}

export function openContractOrder(payload: ContractOpenOrderPayload): Promise<ContractOrderResponse> {
  return request<ContractOrderResponse>('/contract/orders/open', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function closeContractOrder(payload: ContractCloseOrderPayload): Promise<ContractOrderResponse> {
  return request<ContractOrderResponse>('/contract/orders/close', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function closeContractSummaryOrder(payload: ContractCloseSummaryOrderPayload): Promise<ContractCloseSummaryOrderResponse> {
  return request<ContractCloseSummaryOrderResponse>('/contract/orders/close-summary', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function cancelContractOrder(orderId: number): Promise<ContractOrderResponse> {
  return request<ContractOrderResponse>(`/contract/orders/${orderId}/cancel`, {
    method: 'POST',
  })
}

export function updateContractPositionTpSl(
  positionId: number,
  payload: ContractPositionTpSlPayload,
): Promise<ContractPositionTpSlResponse> {
  return request<ContractPositionTpSlResponse>(`/contract/positions/${positionId}/tp-sl`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  })
}

export function getContractPositions(params: {
  symbol?: string
  status?: string
} = {}): Promise<ContractPositionListResponse> {
  return request<ContractPositionListResponse>(withQuery('/contract/positions', params))
}

export function getContractPositionsPaged(params: {
  symbol?: string
  status?: string
  side?: string
  position_side?: string
  created_from?: string
  created_to?: string
  page?: number
  page_size?: number
} = {}): Promise<ContractPositionPageResponse> {
  return request<ContractPositionPageResponse>(withQuery('/contract/positions/page', params))
}

export function getContractPositionSummaries(params: {
  symbol?: string
  side?: string
} = {}): Promise<ContractPositionSummaryListResponse> {
  return request<ContractPositionSummaryListResponse>(withQuery('/contract/positions/summary', params))
}

export function getContractOrders(params: {
  symbol?: string
  status?: string
  status_group?: 'ACTIVE' | 'HISTORY' | string
  side?: string
  position_side?: string
  order_type?: string
  action?: string
  created_from?: string
  created_to?: string
  page?: number
  page_size?: number
} = {}): Promise<ContractOrderListResponse> {
  return request<ContractOrderListResponse>(withQuery('/contract/orders', params))
}

export function getContractTrades(params: {
  symbol?: string
  side?: string
  position_side?: string
  action?: string
  created_from?: string
  created_to?: string
  page?: number
  page_size?: number
} = {}): Promise<ContractTradeListResponse> {
  return request<ContractTradeListResponse>(withQuery('/contract/trades', params))
}

export function getContractPrivateWsBridgeHealth(): Promise<ContractPrivateWsBridgeHealth> {
  return request<ContractPrivateWsBridgeHealth>('/contract/ws/private/health')
}
