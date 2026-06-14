'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useParams, useRouter } from 'next/navigation'
import type { IChartApi, MouseEventParams, UTCTimestamp } from 'lightweight-charts'

import { request } from '@/lib/api/core/request'
import {
  getStockQuote,
  getStockInfo,
  type StockInfoPayload,
  type StockKlinePayload,
  type StockQuotePayload,
} from '@/lib/api/modules/market'
import { getContractSymbols, type ContractSymbolItem } from '@/lib/api/modules/contract'
import { adaptKlines, toChartCandles, toChartVolumes, toLineData } from '@/components/spot/chart/chart.adapter'
import {
  createSpotChartInstance,
  resizeSpotChart,
  type CreateSpotChartResult,
} from '@/components/spot/chart/chart.setup'
import type { CandleItem, RawKlineItem } from '@/components/spot/chart/chart.types'
import { useLocaleContext } from '@/contexts/LocaleContext'

type StockStats = {
  name: string
  lastPrice: number | null
  changePercent: number | null
  high: number | null
  low: number | null
  marketCap: number | null
  pe: number | null
}

const INTERVALS = ['1m', '5m', '15m', '30m', '1h', '1d', '1w', '1M']
const PRELOAD_INTERVALS = ['1h', '30m', '5m', '1w', '1M']
const STOCK_DETAIL_KLINE_TYPES: Record<string, number> = {
  '1m': 1,
  '5m': 2,
  '15m': 3,
  '30m': 4,
  '1h': 5,
  '1d': 8,
  '1w': 9,
  '1M': 10,
}

const STOCK_NAME_FALLBACK_KEYS: Record<string, string> = {
  AAPL: 'stockNameAapl',
  AMZN: 'stockNameAmzn',
  GOOG: 'stockNameGoog',
  GOOGL: 'stockNameGoog',
  META: 'stockNameMeta',
  MSFT: 'stockNameMsft',
  NFLX: 'stockNameNflx',
  NVDA: 'stockNameNvda',
  TSLA: 'stockNameTsla',
}

function toNumber(value: unknown): number | null {
  const nextValue = Number(value)
  return Number.isFinite(nextValue) ? nextValue : null
}

function pickNumber(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = toNumber(record[key])
    if (value !== null) return value
  }
  return null
}

function getQuoteRecord(payload: StockQuotePayload | null): Record<string, unknown> {
  const data = payload?.data
  if (Array.isArray(data)) return data[0] || {}
  if (data && typeof data === 'object') return data as Record<string, unknown>
  return {}
}

function formatPrice(value: number | null): string {
  if (value === null) return '--'
  return value.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: value >= 1 ? 2 : 6,
  })
}

function formatPercent(value: number | null): string {
  if (value === null) return '--'
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`
}

function formatVolume(value: number | null): string {
  if (value === null) return '--'
  return formatLargeNumber(value)
}

function formatKlineTime(time: number | null): string {
  if (time === null) return '--'
  return new Date(time * 1000).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatLargeNumber(value: number | null): string {
  if (value === null) return '--'
  const absValue = Math.abs(value)
  if (absValue >= 1_000_000_000_000) return `${(value / 1_000_000_000_000).toFixed(2)}T`
  if (absValue >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`
  if (absValue >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`
  return value.toLocaleString('en-US', { maximumFractionDigits: 2 })
}

function normalizeStockSymbol(value: unknown): string {
  return String(value || '').trim().toUpperCase().replace(/[^A-Z.]/g, '')
}

function getStockDisplayName(
  symbol: string,
  infoData: Record<string, unknown>,
  t: (key: string, namespace?: 'markets') => string,
): string {
  const localNameKey = STOCK_NAME_FALLBACK_KEYS[symbol]
  if (localNameKey) return t(localNameKey, 'markets')

  const rawName = String(infoData.short_name || infoData.shortName || infoData.name || infoData.n || '').trim()
  if (!rawName) return symbol

  return rawName
    .replace(/\b(Corporation|Corp\.?|Incorporated|Inc\.?|Company|Co\.?|Ltd\.?|Limited|PLC|S\.A\.)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 24) || symbol
}

function parseQuote(
  symbol: string,
  quotePayload: StockQuotePayload | null,
  t: (key: string, namespace?: 'markets') => string,
  infoPayload?: StockInfoPayload | null,
): StockStats {
  const quoteData = getQuoteRecord(quotePayload)
  const infoData = getQuoteRecord(infoPayload || null)

  return {
    name: getStockDisplayName(symbol, infoData, t),
    lastPrice: pickNumber(quoteData, ['ld', 'last', 'c', 'price', 'p']),
    changePercent: pickNumber(quoteData, ['chp', 'changePercent', 'change_percent', 'price_change_percent_24h']),
    high: pickNumber(quoteData, ['h', 'high', 'high_price', 'highPrice', 'high_24h']),
    low: pickNumber(quoteData, ['l', 'low', 'low_price', 'lowPrice', 'low_24h']),
    marketCap: pickNumber(infoData, [
      'market_cap',
      'mkt_cap',
      'marketCap',
      'total_market_value',
      'totalMarketValue',
      'total_mv',
      'market_value',
      'marketValue',
      'capitalization',
      'mcb',
      'totalCapital',
      'mc',
    ]),
    pe: pickNumber(infoData, [
      'pe',
      'pe_ratio',
      'peRatio',
      'pe_ttm',
      'peTTM',
      'ttm_pe',
      'ttmPe',
      'dynamic_pe',
      'static_pe',
      'pet',
      'peTtm',
    ]),
  }
}

function parseKlines(payload: StockKlinePayload | null): RawKlineItem[] {
  const rows = Array.isArray(payload?.data) ? payload.data : []
  return rows.map((row) => ({
    open_time: row.t ?? row.time,
    open: row.o ?? 0,
    high: row.h ?? 0,
    low: row.l ?? 0,
    close: row.c ?? 0,
    volume: row.v ?? 0,
  }))
}

function buildRelativeUrl(path: string, params: URLSearchParams): string {
  const query = params.toString()
  return query ? `${path}?${query}` : path
}

function getStockDetailKlineLimit(): number {
  return 30
}

function getStockDetailKline(symbol: string, interval: string): Promise<StockKlinePayload> {
  const query = new URLSearchParams({
    region: 'US',
    code: symbol,
    kType: String(STOCK_DETAIL_KLINE_TYPES[interval] || STOCK_DETAIL_KLINE_TYPES['1d']),
    limit: String(getStockDetailKlineLimit()),
  })

  return request<StockKlinePayload>(buildRelativeUrl('/market/itick/stock/kline', query))
}

async function fetchStockDetailKlines(symbol: string, interval: string): Promise<RawKlineItem[]> {
  return parseKlines(await getStockDetailKline(symbol, interval))
}

function calculateMovingAverage(candles: CandleItem[], period: number): Array<{ time: number; value: number }> {
  const result: Array<{ time: number; value: number }> = []
  let sum = 0

  candles.forEach((candle, index) => {
    sum += candle.close
    if (index >= period) {
      sum -= candles[index - period].close
    }
    if (index >= period - 1) {
      result.push({
        time: candle.time,
        value: sum / period,
      })
    }
  })

  return result
}

function clampIndex(index: number, length: number): number {
  if (length <= 0) return -1
  return Math.max(0, Math.min(length - 1, index))
}

function findLineValueAtTime(items: Array<{ time: number; value: number }>, time: number): number | null {
  return items.find((item) => item.time === time)?.value ?? null
}

function contractDisplaySymbol(symbol: string): string {
  return symbol.replace(/_?PERP$/, '')
}

function findStockContract(symbol: string, items: ContractSymbolItem[]): ContractSymbolItem | null {
  const desired = `${symbol}USDT`
  return (
    items.find((item) => String(item.symbol || '').toUpperCase() === desired) ||
    items.find((item) => String(item.provider_symbol || '').toUpperCase() === desired) ||
    items.find((item) => contractDisplaySymbol(String(item.symbol || '').toUpperCase()) === desired) ||
    null
  )
}

export default function StockMarketDetailPage() {
  const { t } = useLocaleContext()
  const params = useParams<{ symbol: string }>()
  const router = useRouter()
  const symbol = useMemo(() => normalizeStockSymbol(params.symbol), [params.symbol])
  const [interval, setInterval] = useState('1d')
  const [stats, setStats] = useState<StockStats>(() => parseQuote(symbol, null, t))
  const [contract, setContract] = useState<ContractSymbolItem | null>(null)
  const [klines, setKlines] = useState<RawKlineItem[]>([])
  const [loading, setLoading] = useState(true)
  const [klineLoading, setKlineLoading] = useState(true)
  const [quoteError, setQuoteError] = useState('')
  const [klineMessage, setKlineMessage] = useState('')
  const [selectedCandleIndex, setSelectedCandleIndex] = useState(-1)
  const chartContainerRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<CreateSpotChartResult | null>(null)
  const klinesRef = useRef<RawKlineItem[]>([])
  const candlesRef = useRef<CandleItem[]>([])
  const lastPriceRef = useRef<number | null>(null)
  const klineCacheRef = useRef<Record<string, RawKlineItem[]>>({})
  const preloadedSymbolRef = useRef('')
  const klineRequestIdRef = useRef(0)

  const loadOverview = useCallback(async () => {
    try {
      setLoading(true)
      const quotePayload = await getStockQuote(symbol)
      const [infoPayload, contractPayload] = await Promise.all([
        getStockInfo(symbol).catch(() => null),
        getContractSymbols({ category: 'stock', keyword: `${symbol}USDT`, page_size: 20 }).catch(() => null),
      ])

      const nextStats = parseQuote(symbol, quotePayload, t, infoPayload)
      setStats(nextStats)
      setQuoteError('')
      setContract(contractPayload ? findStockContract(symbol, contractPayload.items) : null)
    } catch {
      setQuoteError((currentError) => {
        if (lastPriceRef.current !== null) return ''
        return currentError || t('stockQuoteUnavailable', 'markets')
      })
    } finally {
      setLoading(false)
    }
  }, [symbol, t])

  const applyKlines = useCallback((nextKlines: RawKlineItem[], nextInterval: string) => {
    klineCacheRef.current[`${symbol}:${nextInterval}`] = nextKlines
    setKlines(nextKlines)
    setKlineMessage(nextKlines.length === 0 ? t('noKlineForInterval', 'markets') : '')
  }, [symbol, t])

  const loadKline = useCallback(async (nextInterval: string) => {
    const requestId = klineRequestIdRef.current + 1
    klineRequestIdRef.current = requestId
    const cacheKey = `${symbol}:${nextInterval}`
    const cachedKlines = klineCacheRef.current[cacheKey]

    if (cachedKlines) {
      applyKlines(cachedKlines, nextInterval)
    }

    try {
      if (!cachedKlines) {
        setKlineMessage('')
      }
      setKlineLoading(!cachedKlines)
      const nextKlines = await fetchStockDetailKlines(symbol, nextInterval)

      if (klineRequestIdRef.current !== requestId) return

      applyKlines(nextKlines, nextInterval)
    } catch {
      if (klineRequestIdRef.current !== requestId) return
      setKlineMessage(
        klinesRef.current.length > 0
          ? t('klineUpdateFailedKeptChart', 'markets')
          : t('noKlineForInterval', 'markets'),
      )
    } finally {
      if (klineRequestIdRef.current === requestId) {
        setKlineLoading(false)
      }
    }
  }, [applyKlines, symbol, t])

  useEffect(() => {
    void loadOverview()
  }, [loadOverview])

  useEffect(() => {
    void loadKline(interval)
  }, [interval, loadKline])

  useEffect(() => {
    if (interval !== '1d') return
    if (klines.length === 0) return
    if (preloadedSymbolRef.current === symbol) return

    preloadedSymbolRef.current = symbol
    PRELOAD_INTERVALS.forEach((item) => {
      const cacheKey = `${symbol}:${item}`
      if (klineCacheRef.current[cacheKey]) return

      void fetchStockDetailKlines(symbol, item)
        .then((nextKlines) => {
          klineCacheRef.current[cacheKey] = nextKlines
        })
        .catch(() => {
          // Silent warmup: the active chart keeps its current data.
        })
    })
  }, [interval, klines.length, symbol])

  useEffect(() => {
    klinesRef.current = klines
  }, [klines])

  useEffect(() => {
    lastPriceRef.current = stats.lastPrice
  }, [stats.lastPrice])

  const chartData = useMemo(() => adaptKlines(klines), [klines])
  const ma5Data = useMemo(() => calculateMovingAverage(chartData.candles, 5), [chartData.candles])
  const ma10Data = useMemo(() => calculateMovingAverage(chartData.candles, 10), [chartData.candles])
  const ma30Data = useMemo(() => calculateMovingAverage(chartData.candles, 30), [chartData.candles])
  const selectedCandle = selectedCandleIndex >= 0 ? chartData.candles[selectedCandleIndex] : null
  const latestKlineInfo = useMemo(() => {
    const candle = selectedCandle
    if (!candle || candle.isPlaceholder) return null

    const priceChangePercent = candle.open > 0 ? ((candle.close - candle.open) / candle.open) * 100 : null
    return {
      time: formatKlineTime(candle.time),
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      changePercent: priceChangePercent,
      ma5: findLineValueAtTime(ma5Data, candle.time),
      ma10: findLineValueAtTime(ma10Data, candle.time),
      ma30: findLineValueAtTime(ma30Data, candle.time),
      volume: candle.volume,
    }
  }, [selectedCandle, ma5Data, ma10Data, ma30Data])

  useEffect(() => {
    candlesRef.current = chartData.candles
    setSelectedCandleIndex(chartData.candles.length > 0 ? chartData.candles.length - 1 : -1)
  }, [chartData.candles])

  useEffect(() => {
    const chart = chartRef.current
    const series = seriesRef.current
    const candle = selectedCandle
    if (!chart || !series || !candle || candle.isPlaceholder) return

    chart.setCrosshairPosition(
      candle.close,
      candle.time as UTCTimestamp,
      series.candleSeries,
    )
  }, [selectedCandle])

  useEffect(() => {
    const container = chartContainerRef.current
    if (!container) return

    const chartBundle = createSpotChartInstance(container, 420, 2)
    chartRef.current = chartBundle.chart
    seriesRef.current = chartBundle

    const handleResize = () => resizeSpotChart(chartRef.current, container)
    const handleCrosshairMove = (param: MouseEventParams) => {
      if (typeof param.logical !== 'number') return
      const nextIndex = clampIndex(Math.round(param.logical), candlesRef.current.length)
      if (nextIndex >= 0) {
        setSelectedCandleIndex(nextIndex)
      }
    }

    window.addEventListener('resize', handleResize)
    chartBundle.chart.subscribeCrosshairMove(handleCrosshairMove)

    return () => {
      window.removeEventListener('resize', handleResize)
      chartBundle.chart.unsubscribeCrosshairMove(handleCrosshairMove)
      chartBundle.chart.remove()
      chartRef.current = null
      seriesRef.current = null
    }
  }, [])

  useEffect(() => {
    const series = seriesRef.current
    if (!series) return

    series.candleSeries.setData(toChartCandles(chartData.candles))
    series.volumeSeries.setData(toChartVolumes(chartData.volumes))
    series.ma5Series.setData(toLineData(ma5Data))
    series.ma10Series.setData(toLineData(ma10Data))
    series.ma30Series.setData(toLineData(ma30Data))
    series.chart.timeScale().fitContent()
  }, [chartData, ma5Data, ma10Data, ma30Data])

  const changeClass =
    stats.changePercent === null
      ? 'text-white/55'
      : stats.changePercent >= 0
        ? 'text-[#16c784]'
        : 'text-[#ea3943]'
  const contractLabel = contract
    ? `${contractDisplaySymbol(contract.symbol)} ${t('perpetual', 'markets')}`
    : `${symbol}USDT ${t('perpetual', 'markets')}`
  const showKlineEmpty = !loading && !klineLoading && klines.length === 0
  const focusChartContainer = useCallback(() => {
    chartContainerRef.current?.focus({ preventScroll: true })
  }, [])
  const handleChartKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    if (candlesRef.current.length === 0) return

    event.preventDefault()
    event.stopPropagation()
    const direction = event.key === 'ArrowLeft' ? -1 : 1
    setSelectedCandleIndex((currentIndex) => {
      const safeIndex = currentIndex >= 0 ? currentIndex : candlesRef.current.length - 1
      return clampIndex(safeIndex + direction, candlesRef.current.length)
    })
  }, [])

  return (
    <main className="min-h-screen bg-[#0b0e11] px-4 py-6 text-white sm:px-6 lg:px-8">
      <div className="mx-auto grid max-w-7xl gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
        <section className="min-w-0 rounded-lg border border-white/10 bg-[#111418]">
          <div className="border-b border-white/10 px-5 py-4">
            <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
              <div>
                <div className="text-sm text-white/45">{t('stockMarket', 'markets')}</div>
                <h1 className="mt-1 text-2xl font-semibold text-white">
                  {symbol} {stats.name} {t('stock', 'markets')}
                </h1>
              </div>
              <div className="text-left md:text-right">
                <div className="text-3xl font-semibold tabular-nums text-white">
                  {formatPrice(stats.lastPrice)}
                </div>
                <div className={`mt-1 text-sm font-semibold tabular-nums ${changeClass}`}>
                  {formatPercent(stats.changePercent)}
                </div>
              </div>
            </div>
            {quoteError ? <div className="mt-3 text-sm text-[#ea3943]">{quoteError}</div> : null}
          </div>

          <div className="border-b border-white/10 px-5 py-3">
            <div className="flex flex-wrap items-center gap-2">
              {INTERVALS.map((item) => (
                <button
                  key={item}
                  type="button"
                  disabled={klineLoading && interval === item}
                  onClick={() => {
                    if (item !== interval) setInterval(item)
                  }}
                  className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-wait ${
                    interval === item
                      ? 'bg-[#f0b90b] text-black'
                      : 'bg-white/[0.04] text-white/55 hover:bg-white/[0.08] hover:text-white'
                  }`}
                >
                  {item}
                </button>
              ))}
              {klineLoading ? <span className="ml-1 text-xs text-[#f0b90b]">{t('loading', 'common')}</span> : null}
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
              <span className="rounded bg-white/[0.12] px-2 py-1 text-white">MA</span>
              <span className="rounded bg-white/[0.12] px-2 py-1 text-white">VOL</span>
            </div>
          </div>

          <div className="grid gap-2 border-b border-white/10 px-5 py-2 text-xs text-white/55 sm:grid-cols-2 xl:grid-cols-4">
            <span>{t('time', 'asset')} {latestKlineInfo?.time ?? '--'}</span>
            <span>
              O {formatPrice(latestKlineInfo?.open ?? null)} / H {formatPrice(latestKlineInfo?.high ?? null)}
            </span>
            <span>
              L {formatPrice(latestKlineInfo?.low ?? null)} / C {formatPrice(latestKlineInfo?.close ?? null)}
            </span>
            <span>
              {t('change', 'markets')} {formatPercent(latestKlineInfo?.changePercent ?? null)} / VOL{' '}
              {formatVolume(latestKlineInfo?.volume ?? null)}
            </span>
            <span className="text-[#f0b90b]">MA5 {formatPrice(latestKlineInfo?.ma5 ?? null)}</span>
            <span className="text-[#9b87f5]">MA10 {formatPrice(latestKlineInfo?.ma10 ?? null)}</span>
            <span className="text-[#60a5fa]">MA30 {formatPrice(latestKlineInfo?.ma30 ?? null)}</span>
            {klineMessage ? <span className="text-white/45">{klineMessage}</span> : null}
          </div>

          <div className="relative h-[420px]">
            {showKlineEmpty ? (
              <div className="absolute inset-0 z-10 flex items-center justify-center text-sm text-white/45">
                {t('noKlineForInterval', 'markets')}
              </div>
            ) : null}
            <div
              ref={chartContainerRef}
              tabIndex={0}
              title={t('stockChartKeyboardHint', 'markets')}
              onMouseDownCapture={focusChartContainer}
              onClick={focusChartContainer}
              onKeyDown={handleChartKeyDown}
              className="h-full w-full outline-none focus:outline-none focus:ring-0"
            />
          </div>
        </section>

        <aside className="space-y-4">
          <section className="rounded-lg border border-white/10 bg-[#111418] p-5">
            <div className="mb-4 text-sm font-semibold text-white">{t('marketInfo', 'markets')}</div>
            <div className="space-y-3 text-sm">
              <div className="flex items-center justify-between gap-3">
                <span className="text-white/45">{t('todayHigh', 'markets')}</span>
                <span className="tabular-nums text-white">{formatPrice(stats.high)}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-white/45">{t('todayLow', 'markets')}</span>
                <span className="tabular-nums text-white">{formatPrice(stats.low)}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-white/45">{t('marketCap', 'markets')}</span>
                <span className="tabular-nums text-white">{formatLargeNumber(stats.marketCap)}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-white/45">{t('peRatio', 'markets')}</span>
                <span className="tabular-nums text-white">{stats.pe === null ? '--' : stats.pe.toFixed(2)}</span>
              </div>
            </div>
          </section>

          <section className="rounded-lg border border-white/10 bg-[#111418] p-5">
            <div className="text-sm font-semibold text-white">{t('tradeEntry', 'markets')}</div>
            <div className="mt-4 rounded-md border border-white/10 bg-white/[0.03] p-4">
              <div className="text-sm font-semibold text-white">{contractLabel}</div>
              <div className="mt-1 text-xs text-white/45">{t('stockContractTradfiCfd', 'markets')}</div>
              {contract ? (
                <button
                  type="button"
                  onClick={() => router.push(`/contract?symbol=${encodeURIComponent(contract.symbol)}`)}
                  className="mt-4 h-10 w-full rounded-md bg-[#f0b90b] text-sm font-semibold text-black transition-colors hover:bg-[#f8c83d]"
                >
                  {t('trade', 'common')}
                </button>
              ) : (
                <div className="mt-4 rounded-md border border-white/10 bg-white/[0.03] px-3 py-2 text-center text-sm text-white/55">
                  {t('stockContractNotOpen', 'markets')}
                </div>
              )}
            </div>
          </section>
        </aside>
      </div>
    </main>
  )
}


