import { request } from '../core/request'

export type SpotOrderSide = 'BUY' | 'SELL'
export type SpotOrderType = 'LIMIT' | 'MARKET'
export type SpotMarketDataSource = 'internal' | 'binance' | 'itick' | 'external' | 'local'

export type CreateSpotOrderPayload = {
  symbol: string
  side: SpotOrderSide
  order_type: SpotOrderType
  amount?: string
  price?: string
  quote_amount?: string
}

export type CreateSpotOrderResponse = {
  id?: number
  order_id?: number
  status?: string
  message?: string
  [key: string]: unknown
}

export type SpotFeeSettings = {
  spot_rcb_fee_enabled: boolean
  rcb_fee_discount_rate: string
  min_rcb_fee_amount: string
}

export async function createSpotOrder(
  payload: CreateSpotOrderPayload,
): Promise<CreateSpotOrderResponse> {
  return request<CreateSpotOrderResponse>('/order/create', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export async function getSpotFeeSettings(): Promise<SpotFeeSettings> {
  return request<SpotFeeSettings>('/spot/fee-settings')
}

export type CancelSpotOrderResponse = {
  id?: number
  order_no?: string
  status?: string
  [key: string]: unknown
}

export async function cancelSpotOrder(
  orderId: number,
): Promise<CancelSpotOrderResponse> {
  return request<CancelSpotOrderResponse>(`/order/${orderId}/cancel`, {
    method: 'POST',
  })
}

export type SpotDepthLevel = {
  price: string
  amount: string
  total?: string
}

export type SpotDepthResponse = {
  symbol: string
  price_precision?: number
  price_tick_size?: string | number | null
  tick_size?: string | number | null
  display_price_precision?: number | string | null
  price_precision_source?: string | null
  price_precision_provider?: string | null
  amount_precision?: number
  bids: SpotDepthLevel[]
  asks: SpotDepthLevel[]
  ts?: number
  provider?: string | null
  stale?: boolean
  updated_at?: string | null
  last_price?: string | number
  mid_price?: string | number
  source?: string
  freshness?: string | null
  fetched_at?: number
}

export type SpotMarketTradeItem = {
  id?: string | number | null
  trade_id?: string | number | null
  provider_trade_id?: string | number | null
  price: string
  amount: string
  side: 'BUY' | 'SELL' | string
  ts?: string | number
  time?: string | number
  provider?: string | null
  provider_symbol?: string | null
  source?: string | null
  freshness?: string | null
  updated_at_ms?: string | number | null
  created_at?: string | null
}

export type SpotMarketTradesResponse = {
  symbol: string
  items?: SpotMarketTradeItem[]
  trades?: SpotMarketTradeItem[]
  provider?: string | null
  stale?: boolean
  updated_at?: string | null
  source?: string | null
  freshness?: string | null
}

export type SpotMarketView = {
  symbol: string
  display_price?: string | number | null
  display_price_source?: string | null
  last_price?: string | number | null
  last_trade_price?: string | number | null
  orderbook_mid_price?: string | number | null
  ticker_last_price?: string | number | null
  ticker_24h_change?: string | number | null
  ticker_24h_change_percent?: string | number | null
  ticker_24h_high?: string | number | null
  ticker_24h_low?: string | number | null
  ticker_volume?: string | number | null
  ticker_quote_volume?: string | number | null
  price_precision?: number | string | null
  price_tick_size?: string | number | null
  tick_size?: string | number | null
  display_price_precision?: number | string | null
  price_precision_source?: string | null
  price_precision_provider?: string | null
  amount_precision?: number | string | null
  best_bid?: string | number | null
  best_ask?: string | number | null
  spread?: string | number | null
  price_direction?: 'up' | 'down' | 'flat' | string | null
  market_status?: string | null
  data_source?: SpotMarketDataSource | string | null
  depth_status?: string | null
  trades_status?: string | null
  kline_status?: string | null
  depth_source?: string | null
  trades_source?: string | null
  ticker_source?: string | null
  kline_source?: string | null
  depth_freshness?: string | null
  trades_freshness?: string | null
  ticker_freshness?: string | null
  kline_freshness?: string | null
  quote_freshness?: string | null
  executable?: boolean
  updated_at?: string | null
  warnings?: string[]
  raw_source_summary?: Record<string, unknown>
  ticker?: SpotMarketTickerItem | null
  depth?: SpotDepthResponse | null
  trades?: SpotMarketTradesResponse | null
}

export type SpotMarketKlineItem = {
  open_time?: number | string
  close_time?: number | string
  time?: number | string
  timestamp?: number | string
  open: number | string
  high: number | string
  low: number | string
  close: number | string
  volume: number | string
  quote_volume?: number | string
}

export type SpotMarketKlinesResponse = {
  symbol: string
  interval: string
  items: SpotMarketKlineItem[]
  provider?: string | null
  source?: string | null
  freshness?: string | null
}

export type SpotMarketTickerItem = {
  symbol: string
  display_symbol?: string | null
  base_asset?: string | null
  quote_asset?: string | null
  last_price?: string | number
  price?: string | number
  last?: string | number
  close?: string | number
  change_24h?: string | number
  change_percent_24h?: string | number
  changePercent24h?: string | number
  changePercent?: string | number
  change_percent?: string | number
  percent_change_24h?: string | number
  priceChangePercent?: string | number
  price_change_24h?: string | number
  price_change_percent_24h?: string | number
  price_change_percent?: string | number
  open_24h?: string | number
  open24h?: string | number
  high_24h?: string | number
  low_24h?: string | number
  volume_24h?: string | number
  base_volume_24h?: string | number
  quote_volume_24h?: string | number
  price_precision?: number | string | null
  price_tick_size?: string | number | null
  tick_size?: string | number | null
  display_price_precision?: number | string | null
  price_precision_source?: string | null
  price_precision_provider?: string | null
  amount_precision?: number | string | null
  asset_type?: string | null
  market_category?: string | null
  market_sub_category?: string | null
  display_category?: string | null
  display_group?: string | null
  show_spot_logo?: boolean | number | string | null
  spot_logo_url?: string | null
  spot_logo_alt?: string | null
  data_source?: SpotMarketDataSource | string | null
  market_mode?: string | null
  market_status?: 'OPEN' | 'CLOSED' | 'UNKNOWN' | string | null
  market_status_text?: string | null
  market_session_code?: string | null
  market_timezone?: string | null
  market_trading_hours?: string | null
  market_session_type?: string | null
  quote_freshness?: 'LIVE' | 'STALE' | 'LAST_VALID' | 'FALLBACK' | string | null
  ts?: string | null
  [key: string]: unknown
}

export type SpotMarketPairItem = {
  symbol: string
  display_symbol?: string | null
  base_asset?: string | null
  quote_asset?: string | null
  asset_type?: string | null
  market_category?: string | null
  market_sub_category?: string | null
  display_category?: string | null
  display_group?: string | null
  show_spot_logo?: boolean | number | string | null
  spot_logo_url?: string | null
  spot_logo_alt?: string | null
  data_source?: SpotMarketDataSource | string | null
  market_mode?: string | null
  market_status?: 'OPEN' | 'CLOSED' | 'UNKNOWN' | string | null
  market_status_text?: string | null
  market_session_code?: string | null
  market_timezone?: string | null
  market_trading_hours?: string | null
  market_session_type?: string | null
  quote_freshness?: 'LIVE' | 'STALE' | 'LAST_VALID' | 'FALLBACK' | string | null
  price_precision?: number | string | null
  price_tick_size?: string | number | null
  tick_size?: string | number | null
  display_price_precision?: number | string | null
  price_precision_source?: string | null
  price_precision_provider?: string | null
  amount_precision?: number | string | null
  status?: number | string | null
  [key: string]: unknown
}

export type SpotMarketPairsResponse = {
  items: SpotMarketPairItem[]
  total: number
  page: number
  page_size: number
}

export type GetSpotMarketPairsParams = {
  marketType?: 'spot' | 'contract' | 'all' | string
  category?: string
  quote?: string
  keyword?: string
  page?: number
  pageSize?: number
}

function buildRelativeUrl(path: string, params: URLSearchParams): string {
  const query = params.toString()
  return query ? `${path}?${query}` : path
}

export function normalizeSpotSymbol(symbol: string): string {
  return String(symbol || '').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '')
}

export function isExternalSymbol(symbol: string): boolean {
  void symbol
  return false
}

export function normalizeSpotDataSource(
  dataSource?: string | null,
): SpotMarketDataSource {
  const normalized = String(dataSource || '').trim().toLowerCase()

  if (normalized === 'binance') return 'binance'
  if (normalized === 'itick') return 'itick'
  if (normalized === 'external') return 'external'
  if (normalized === 'local') return 'local'

  return 'internal'
}

export function isPollingSpotDataSource(dataSource?: string | null): boolean {
  const normalized = normalizeSpotDataSource(dataSource)
  return normalized !== 'internal' && normalized !== 'local'
}

export function getSpotDataSource(symbol: string): SpotMarketDataSource {
  void symbol
  return 'internal'
}

export async function getSpotMarketTickers(
  symbol?: string | string[],
): Promise<SpotMarketTickerItem[]> {
  const params = new URLSearchParams()
  if (Array.isArray(symbol)) {
    const normalizedSymbols = symbol.map(normalizeSpotSymbol).filter(Boolean)
    if (normalizedSymbols.length) {
      params.set('symbols', normalizedSymbols.join(','))
    }
  } else {
    const normalizedSymbol = symbol ? normalizeSpotSymbol(symbol) : ''
    if (normalizedSymbol) {
      params.set('symbol', normalizedSymbol)
    }
  }

  const payload = await request<SpotMarketTickerItem[] | { items?: SpotMarketTickerItem[] }>(
    buildRelativeUrl('/market/tickers', params),
  )

  if (Array.isArray(payload)) {
    return payload
  }

  if (Array.isArray(payload?.items)) {
    return payload.items
  }

  return []
}

export async function getSpotMarketPairs(
  params: GetSpotMarketPairsParams = {},
): Promise<SpotMarketPairsResponse> {
  const query = new URLSearchParams({
    market_type: params.marketType || 'spot',
    category: params.category || 'all',
    quote: params.quote || 'all',
    page: String(params.page || 1),
    page_size: String(params.pageSize || 50),
  })

  const keyword = String(params.keyword || '').trim()
  if (keyword) {
    query.set('keyword', keyword)
  }

  const payload = await request<SpotMarketPairsResponse>(
    buildRelativeUrl('/market/pairs', query),
  )

  return {
    items: Array.isArray(payload?.items) ? payload.items : [],
    total: Number(payload?.total || 0),
    page: Number(payload?.page || params.page || 1),
    page_size: Number(payload?.page_size || params.pageSize || 50),
  }
}

export async function getSpotMarketView(symbol: string): Promise<SpotMarketView> {
  const normalizedSymbol = normalizeSpotSymbol(symbol)
  const params = new URLSearchParams({
    symbol: normalizedSymbol,
  })

  return request<SpotMarketView>(buildRelativeUrl('/market/spot/view', params))
}

export async function getSpotDepth(
  symbol: string,
  limit = 20,
): Promise<SpotDepthResponse> {
  const normalizedSymbol = normalizeSpotSymbol(symbol)
  const params = new URLSearchParams({
    symbol: normalizedSymbol,
    limit: String(limit),
  })

  return request<SpotDepthResponse>(buildRelativeUrl('/market/depth', params))
}

export function normalizeSpotTrades(
  payload: SpotMarketTradesResponse | null | undefined,
): SpotMarketTradeItem[] {
  if (Array.isArray(payload?.items)) {
    return payload.items
  }

  if (Array.isArray(payload?.trades)) {
    return payload.trades
  }

  return []
}

export async function getSpotTrades(
  symbol: string,
  limit = 50,
): Promise<SpotMarketTradesResponse> {
  const normalizedSymbol = normalizeSpotSymbol(symbol)
  const params = new URLSearchParams({
    symbol: normalizedSymbol,
    limit: String(limit),
  })

  return request<SpotMarketTradesResponse>(buildRelativeUrl('/market/trades', params))
}

export async function getSpotKlines(params: {
  symbol: string
  interval: string
  limit?: number
  endTime?: number
}): Promise<SpotMarketKlinesResponse> {
  const { symbol, interval, limit = 200, endTime } = params
  const normalizedSymbol = normalizeSpotSymbol(symbol)
  const query = new URLSearchParams({
    symbol: normalizedSymbol,
    interval,
    limit: String(limit),
  })

  if (typeof endTime === 'number' && Number.isFinite(endTime) && endTime > 0) {
    query.set('end_time', String(endTime))
  }

  return request<SpotMarketKlinesResponse>(buildRelativeUrl('/market/kline', query))
}

export type SpotBalanceItem = {
  coin_symbol: string
  available_amount: string
  frozen_amount: string
}

export type SpotBalancesResponse = {
  symbol: string
  base_asset: string
  quote_asset: string
  items: SpotBalanceItem[]
}

export async function getSpotBalances(
  symbol: string,
): Promise<SpotBalancesResponse> {
  return request<SpotBalancesResponse>(
    `/spot/balances?symbol=${encodeURIComponent(symbol)}`,
  )
}

export type SpotAccountBalanceItem = {
  symbol: string
  account_key: 'funding' | 'spot' | string
  available: string
  frozen: string
}

export async function getSpotAccountBalances(): Promise<SpotAccountBalanceItem[]> {
  return request<SpotAccountBalanceItem[]>('/asset/account-balances')
}

export type SpotOrderItem = {
  id: number
  symbol: string
  side: 'BUY' | 'SELL'
  order_type: string
  price: string
  amount: string
  filled_amount: string
  remaining_amount: string
  executed_quote_amount: string
  avg_price: string
  fee_amount?: string | null
  fee_asset_id?: number | null
  fee_asset_symbol?: string | null
  status: string
  created_at?: string | null
  updated_at?: string | null
}

export type SpotOrder = SpotOrderItem

export type SpotOrdersResponse = {
  symbol: string
  total: number
  items: SpotOrderItem[]
}

export async function getSpotCurrentOrders(
  symbol: string,
  limit = 50,
): Promise<SpotOrdersResponse> {
  return request<SpotOrdersResponse>(
    `/spot/orders/current?symbol=${encodeURIComponent(symbol)}&limit=${limit}`,
  )
}

export async function getSpotHistoryOrders(
  symbol: string,
  limit = 100,
): Promise<SpotOrdersResponse> {
  return request<SpotOrdersResponse>(
    `/spot/orders/history?symbol=${encodeURIComponent(symbol)}&limit=${limit}`,
  )
}

export type SpotTradeItem = {
  trade_id: number
  symbol: string
  side: 'BUY' | 'SELL'
  price: string
  amount: string
  quote_amount: string
  buyer_user_id?: number | null
  seller_user_id?: number | null
  buy_order_id?: number | null
  sell_order_id?: number | null
  maker_order_id?: number | null
  taker_order_id?: number | null
  role: string
  fee_amount?: string | null
  feeAmount?: string | null
  fee?: string | null
  fee_asset?: string | null
  fee_asset_symbol?: string | null
  feeAssetSymbol?: string | null
  feeAsset?: string | null
  fee_asset_name?: string | null
  created_at?: string | null
}

export type SpotMyTradesResponse = {
  symbol: string
  total: number
  items: SpotTradeItem[]
}

export async function getSpotMyTrades(
  symbol: string,
  limit = 100,
): Promise<SpotMyTradesResponse> {
  return request<SpotMyTradesResponse>(
    `/spot/trades?symbol=${encodeURIComponent(symbol)}&limit=${limit}`,
  )
}
