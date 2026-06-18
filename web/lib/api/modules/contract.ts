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

export type ContractQuote = {
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

export type ContractMarketTrade = {
  id: number | string
  price: string
  qty: string
  quoteQty?: string
  time: number
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
  liquidation_price: string
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

export type ContractPositionTpSlMode = 'NONE' | 'SINGLE' | 'MIXED'

export type ContractPositionSummaryItem = {
  symbol: string
  side: string
  quantity: string
  avg_entry_price: string
  margin_amount: string
  unrealized_pnl: string
  liquidation_price: string
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

export function getContractPositionSummaries(params: {
  symbol?: string
  side?: string
} = {}): Promise<ContractPositionSummaryListResponse> {
  return request<ContractPositionSummaryListResponse>(withQuery('/contract/positions/summary', params))
}

export function getContractOrders(params: {
  symbol?: string
  status?: string
  page?: number
  page_size?: number
} = {}): Promise<ContractOrderListResponse> {
  return request<ContractOrderListResponse>(withQuery('/contract/orders', params))
}

export function getContractTrades(params: {
  symbol?: string
  page?: number
  page_size?: number
} = {}): Promise<ContractTradeListResponse> {
  return request<ContractTradeListResponse>(withQuery('/contract/trades', params))
}

export function getContractPrivateWsBridgeHealth(): Promise<ContractPrivateWsBridgeHealth> {
  return request<ContractPrivateWsBridgeHealth>('/contract/ws/private/health')
}
