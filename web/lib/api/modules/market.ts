import { publicRequest } from '../core/request'
import { withContentLanguage } from '../core/locale'

export type SpotMarketDataSource = 'internal' | 'external'

export type SpotMarketDepthLevel = {
  price: string
  amount: string
  total?: string
}

export type SpotMarketDepthResponse = {
  symbol: string
  bids: SpotMarketDepthLevel[]
  asks: SpotMarketDepthLevel[]
  ts?: number
}

export type SpotMarketTradeItem = {
  price: string
  amount: string
  side: 'BUY' | 'SELL' | string
  ts?: string | number
  time?: string | number
}

export type SpotMarketTradesResponse = {
  symbol: string
  items?: SpotMarketTradeItem[]
  trades?: SpotMarketTradeItem[]
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
  stale?: boolean | null
  source?: string | null
  freshness?: string | null
  cache_status?: string | null
  history_incomplete?: boolean | null
  provider_error_code?: string | null
  provider_error_provider?: string | null
}

export type StockQuotePayload = {
  code?: number
  msg?: string | null
  data?: {
    s?: string
    symbol?: string
    code?: string
    n?: string
    name?: string
    ld?: number
    last?: number
    c?: number
    h?: number
    l?: number
    o?: number
    ch?: number
    chp?: number
    pe?: number
    pe_ratio?: number
    peRatio?: number
    pe_ttm?: number
    peTTM?: number
    ttm_pe?: number
    ttmPe?: number
    dynamic_pe?: number
    static_pe?: number
    market_cap?: number
    marketCap?: number
    mkt_cap?: number
    total_market_value?: number
    totalMarketValue?: number
    total_mv?: number
    market_value?: number
    marketValue?: number
    capitalization?: number
    mc?: number
    [key: string]: unknown
  } | Array<Record<string, unknown>> | null
}

export type StockInfoPayload = StockQuotePayload

export type MarketTickerItem = {
  symbol: string
  display_symbol?: string | null
  base_asset?: string | null
  quote_asset?: string | null
  base_asset_logo_url?: string | null
  last_price?: string | number
  open_24h?: string | number
  change_24h?: string | number
  price_change_24h?: string | number
  price_change_percent_24h?: string | number
  high_24h?: string | number
  low_24h?: string | number
  base_volume_24h?: string | number
  quote_volume_24h?: string | number
  volume_24h?: string | number
  turnover?: string | number
  amount?: string | number
  value?: string | number
  price_precision?: number | string | null
  amount_precision?: number | string | null
  asset_type?: string | null
  data_source?: string | null
  market_mode?: string | null
  external_symbol?: string | null
  external_region?: string | null
  market_category?: string | null
  market_sub_category?: string | null
  display_category?: string | null
  display_group?: string | null
  show_spot_logo?: boolean | number | string | null
  spot_logo_url?: string | null
  spot_logo_alt?: string | null
  market_status?: 'OPEN' | 'CLOSED' | 'UNKNOWN' | string | null
  market_status_text?: string | null
  market_session_code?: string | null
  market_timezone?: string | null
  market_trading_hours?: string | null
  market_session_type?: string | null
  quote_freshness?: 'LIVE' | 'STALE' | 'LAST_VALID' | 'FALLBACK' | string | null
  source?: string | null
  ts?: string | null
  sort_order?: number | string | null
  is_hot?: boolean | number | string | null
  [key: string]: unknown
}

export type MfcRwaReferencePrice = {
  success: boolean
  reference_symbol: string
  raw_rate: string
  iron62_usd_per_ton?: string
  display_price?: string
  display_unit?: string
  usd_per_ton: string
  mfc_usdt_price: string
  unit: string
  source: string
  source_status?: string
  updated_at: string
  debug_note: string
}

export type MfcRwaReferenceKlineItem = {
  time: number
  price: string
}

export type MfcRwaReferenceKline = {
  symbol: string
  mapped_symbol: string
  unit: string
  source: string
  source_status: 'live' | 'fallback_from_latest' | string
  items: MfcRwaReferenceKlineItem[]
}

export type ReferenceOverlayPayload = {
  symbol: string
  enabled: boolean
  reference_type?: 'IRON' | 'GOLD' | 'STOCK' | string
  price_source?: 'MANUAL' | 'AUTO' | string
  auto_source?: string | null
  refresh_interval_sec?: number | string | null
  last_ref_price?: string | number | null
  last_ref_label?: string | null
  last_sync_at?: string | null
  sync_status?: 'PENDING' | 'SUCCESS' | 'FAILED' | string
  sync_error?: string | null
  stale?: boolean | number | string | null
  market_status?: 'OPEN' | 'CLOSED' | 'HOLIDAY' | 'UNKNOWN' | string
  market_status_text?: string | null
  price_time?: string | null
  is_realtime?: boolean | number | string | null
  kind?: 'IRON' | 'GOLD' | 'STOCK' | string
  title?: string | null
  subtitle?: string | null
  source_label?: string | null
  description?: string | null
  line_title?: string | null
  line_color?: string | null
  badge_color?: string | null
  display_value_label?: string | null
  display_price?: string | number | null
  display_price_label?: string | null
  source_price_label?: string | null
  display_unit?: string | null
  data_source?: string | null
  source_symbol?: string | null
  source_region?: string | null
  conversion_type?: string | null
  conversion_factor?: string | number | null
}

export function normalizeSpotSymbol(symbol: string): string {
  return String(symbol || '').trim().toUpperCase()
}

export function isExternalMarketSymbol(symbol: string): boolean {
  void symbol
  return false
}

export function getSpotMarketDataSource(symbol: string): SpotMarketDataSource {
  void symbol
  return 'internal'
}

function buildRelativeUrl(path: string, params: URLSearchParams): string {
  const query = params.toString()
  return query ? `${path}?${query}` : path
}

export async function getSpotMarketDepth(
  symbol: string,
  limit = 20,
): Promise<SpotMarketDepthResponse> {
  const normalizedSymbol = normalizeSpotSymbol(symbol)
  const params = new URLSearchParams({
    symbol: normalizedSymbol,
    limit: String(limit),
  })

  return publicRequest<SpotMarketDepthResponse>(buildRelativeUrl('/market/depth', params))
}

export async function getSpotMarketTrades(
  symbol: string,
  limit = 50,
): Promise<SpotMarketTradesResponse> {
  const normalizedSymbol = normalizeSpotSymbol(symbol)
  const params = new URLSearchParams({
    symbol: normalizedSymbol,
    limit: String(limit),
  })

  return publicRequest<SpotMarketTradesResponse>(
    buildRelativeUrl('/market/trades', params),
  )
}

export async function getSpotMarketKlines(params: {
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

  return publicRequest<SpotMarketKlinesResponse>(buildRelativeUrl('/market/kline', query))
}

export async function getReferenceOverlay(symbol: string): Promise<ReferenceOverlayPayload> {
  const normalizedSymbol = normalizeSpotSymbol(symbol)
  const query = new URLSearchParams({ symbol: normalizedSymbol })
  return publicRequest<ReferenceOverlayPayload>(withContentLanguage(buildRelativeUrl('/market/reference-overlays', query)))
}

export async function getStockQuote(symbol: string): Promise<StockQuotePayload> {
  const normalizedSymbol = normalizeSpotSymbol(symbol)
  const params = new URLSearchParams({
    region: 'US',
    code: normalizedSymbol,
  })

  return publicRequest<StockQuotePayload>(
    buildRelativeUrl('/market/itick/stock/quote', params),
  )
}

const STOCK_KLINE_TYPES: Record<string, number> = {
  '1m': 1,
  '5m': 2,
  '15m': 3,
  '1h': 5,
  '1d': 8,
}

export type StockKlinePayload = {
  code?: number
  msg?: string | null
  data?: Array<{
    t?: number | string
    time?: number | string
    o?: number | string
    h?: number | string
    l?: number | string
    c?: number | string
    v?: number | string
    tu?: number | string
    qv?: number | string
    [key: string]: unknown
  }>
}

export function getStockKlineLimit(interval: string): number {
  return interval === '1d' ? 90 : 100
}

export async function getStockInfo(symbol: string): Promise<StockInfoPayload> {
  const normalizedSymbol = normalizeSpotSymbol(symbol)
  const params = new URLSearchParams({
    region: 'US',
    code: normalizedSymbol,
  })

  return publicRequest<StockInfoPayload>(
    buildRelativeUrl('/market/itick/stock/info', params),
  )
}

export async function getStockKline(params: {
  symbol: string
  interval: string
  limit?: number
}): Promise<StockKlinePayload> {
  const normalizedSymbol = normalizeSpotSymbol(params.symbol)
  const query = new URLSearchParams({
    region: 'US',
    code: normalizedSymbol,
    kType: String(STOCK_KLINE_TYPES[params.interval] || STOCK_KLINE_TYPES['1d']),
    limit: String(params.limit || getStockKlineLimit(params.interval)),
  })

  return publicRequest<StockKlinePayload>(
    buildRelativeUrl('/market/itick/stock/kline', query),
  )
}

export async function getMarketTickers(): Promise<MarketTickerItem[]> {
  const payload = await publicRequest<MarketTickerItem[] | { items?: MarketTickerItem[] }>(
    '/market/tickers',
  )

  if (Array.isArray(payload)) {
    return payload
  }

  if (Array.isArray(payload?.items)) {
    return payload.items
  }

  return []
}

export async function getMfcRwaReferencePrice(): Promise<MfcRwaReferencePrice> {
  return publicRequest<MfcRwaReferencePrice>('/market/rwa/iron62/reference')
}

export async function getMfcRwaReferenceKline(params?: {
  interval?: string
  limit?: number
}): Promise<MfcRwaReferenceKline> {
  const query = new URLSearchParams({
    interval: params?.interval || '1d',
    limit: String(params?.limit || 120),
  })
  return publicRequest<MfcRwaReferenceKline>(buildRelativeUrl('/market/rwa/iron62/kline', query))
}

export function normalizeSpotMarketTrades(
  payload: SpotMarketTradesResponse | null | undefined,
): SpotMarketTradeItem[] {
  if (Array.isArray(payload?.trades)) {
    return payload.trades
  }

  if (Array.isArray(payload?.items)) {
    return payload.items
  }

  return []
}
