'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocaleContext } from '@/contexts/LocaleContext'
import {
  getSpotTrades,
  isPollingSpotDataSource,
  normalizeSpotTrades,
  type SpotMarketDataSource,
} from '@/lib/api/modules/spot'
import { formatPrice as formatMarketPrice } from '@/lib/marketPrecision'
import { readMarketCache, writeMarketCache } from '@/lib/marketCache'
import {
  spotMarketRealtime,
  type SpotMarketRealtimeMessage,
} from '@/services/marketRealtime'
import { formatSpotDisplaySymbol } from './spotFormat'

type TradeItem = {
  price: string | number
  amount: string | number
  ts?: string | number
  time?: string | number
}

type WsTradeMessage = {
  type: 'spot_trade'
  symbol: string
  trade: {
    id?: number | string
    price: string | number
    amount: string | number
    side?: string
    ts?: string | number
  }
}

type WsSnapshotMessage = {
  type: 'spot_market_snapshot'
  symbol: string
  trades?: {
    symbol?: string
    items?: TradeItem[]
  }
}

type Props = {
  symbol: string
  displaySymbol?: string | null
  limit?: number
  refreshNonce?: number
  pricePrecision: number
  dataSource?: SpotMarketDataSource | string | null
  onPriceClick?: (price: string) => void
  onLastPriceChange?: (price: string | number) => void
  onTradesStateChange?: (hasTrades: boolean) => void
}

type SpotTradesCache = {
  symbol?: string;
  trades?: TradeItem[];
  lastPrice?: string | number | null;
  updatedAt?: number;
}

function toNumber(value: string | number | undefined | null): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function formatPrice(value: string | number | undefined | null, precision: number) {
  const n = Number(value)
  if (!Number.isFinite(n)) return '--'
  return formatMarketPrice(n, precision)
}

function formatAmount(value: string | number | undefined | null) {
  const n = Number(value)
  if (!Number.isFinite(n)) return '--'
  return n.toFixed(6)
}

function formatTime(value?: string | number) {
  if (!value) return '--:--:--'

  const date =
    typeof value === 'number'
      ? new Date(value < 1e12 ? value * 1000 : value)
      : new Date(String(value))

  if (Number.isNaN(date.getTime())) return '--:--:--'

  return date.toLocaleTimeString('zh-CN', {
    hour12: false,
  })
}

function getTradeTime(item: TradeItem) {
  return item.ts ?? item.time
}

function splitSymbol(symbol: string) {
  const s = String(symbol || '').toUpperCase()

  const quotes = ['USDT', 'USDC', 'BTC', 'ETH', 'BNB']
  for (const quote of quotes) {
    if (s.endsWith(quote) && s.length > quote.length) {
      return {
        base: s.slice(0, s.length - quote.length),
        quote,
      }
    }
  }

  return {
    base: s,
    quote: '',
  }
}

const EXTERNAL_TRADES_POLL_MS = 1500

function readCurrentTradesCache(symbol: string): SpotTradesCache | null {
  const normalizedSymbol = String(symbol || '').trim().toUpperCase()
  const cached = readMarketCache<SpotTradesCache>('spot', normalizedSymbol)
  if (!cached) return null
  if (String(cached.symbol || '').trim().toUpperCase() !== normalizedSymbol) return null
  return cached
}

export default function SpotTradesHistory({
  symbol,
  displaySymbol,
  limit = 20,
  refreshNonce = 0,
  pricePrecision,
  dataSource,
  onPriceClick,
  onLastPriceChange,
  onTradesStateChange,
}: Props) {
  const { t } = useLocaleContext()
  const [rows, setRows] = useState<TradeItem[]>([])
  const [loading, setLoading] = useState(true)

  const currentSymbolRef = useRef('')
  const pollTimerRef = useRef<number | null>(null)
  const onLastPriceChangeRef = useRef(onLastPriceChange)
  const onTradesStateChangeRef = useRef(onTradesStateChange)
  useEffect(() => {
    onLastPriceChangeRef.current = onLastPriceChange
  }, [onLastPriceChange])

  useEffect(() => {
    onTradesStateChangeRef.current = onTradesStateChange
  }, [onTradesStateChange])

  useEffect(() => {
    currentSymbolRef.current = String(symbol || '').toUpperCase()
  }, [symbol])

  useEffect(() => {
    if (loading) return
    onTradesStateChangeRef.current?.(rows.length > 0)
  }, [rows, loading])

  useEffect(() => {
    if (loading) return

    if (rows[0]?.price !== undefined && rows[0]?.price !== null) {
      onLastPriceChangeRef.current?.(rows[0].price)
    } else {
      onLastPriceChangeRef.current?.('--')
    }
  }, [rows, loading])

  useEffect(() => {
    const normalizedSymbol = String(symbol || '').toUpperCase()

    const cached = readCurrentTradesCache(normalizedSymbol)
    if (cached?.trades?.length) {
      setRows(cached.trades.slice(0, limit))
    }
    setLoading(!!normalizedSymbol)
    onTradesStateChangeRef.current?.(!!cached?.trades?.length)
    if (cached?.lastPrice) {
      onLastPriceChangeRef.current?.(cached.lastPrice)
    }

    if (!normalizedSymbol) {
      return
    }

    let alive = true

    const clearPollTimer = () => {
      if (pollTimerRef.current) {
        window.clearInterval(pollTimerRef.current)
        pollTimerRef.current = null
      }
    }

    const applyTrades = (items: TradeItem[]) => {
      const nextRows = items.slice(0, limit)
      setRows(nextRows)
      writeMarketCache<SpotTradesCache>('spot', normalizedSymbol, {
        trades: nextRows,
        lastPrice: nextRows[0]?.price ?? null,
      })
      setLoading(false)
    }

    let unsubscribeTrade: (() => void) | null = null
    let unsubscribeSnapshot: (() => void) | null = null

    const handleRealtimeMessage = (message: SpotMarketRealtimeMessage) => {
      if (!alive) return

      const data = message as WsTradeMessage | WsSnapshotMessage
      const msgSymbol = String(data?.symbol || '').toUpperCase()
      const currentSymbol = currentSymbolRef.current

      if (!msgSymbol || msgSymbol !== currentSymbol) return

      if (data.type === 'spot_trade') {
        const trade: TradeItem = {
          price: data.trade.price,
          amount: data.trade.amount,
          ts: data.trade.ts,
        }

        setRows((prev) => {
          const nextRows = [trade, ...prev].slice(0, limit)
          writeMarketCache<SpotTradesCache>('spot', normalizedSymbol, {
            trades: nextRows,
            lastPrice: trade.price,
          })
          return nextRows
        })
        setLoading(false)
        return
      }

      if (data.type === 'spot_market_snapshot') {
        const list = Array.isArray(data.trades?.items) ? data.trades.items : []
        applyTrades(list)
      }
    }

    const subscribeInternalRealtime = () => {
      if (!alive) return

      spotMarketRealtime.setSymbol(normalizedSymbol)
      spotMarketRealtime.subscribe('trade', handleRealtimeMessage)
      spotMarketRealtime.subscribe('snapshot', handleRealtimeMessage)
      unsubscribeTrade = () => spotMarketRealtime.unsubscribe('trade', handleRealtimeMessage)
      unsubscribeSnapshot = () => spotMarketRealtime.unsubscribe('snapshot', handleRealtimeMessage)
    }

    let polling = false

    const loadTradesSnapshot = async () => {
      if (!alive || polling) return

      polling = true

      try {
        const payload = await getSpotTrades(normalizedSymbol, limit)

        if (!alive) return

        const list = normalizeSpotTrades(payload).map((item) => ({
          price: item.price,
          amount: item.amount,
          ts: item.ts,
          time: item.time,
        }))

        applyTrades(list)
      } catch (err) {
        if (!alive) return

        setRows([])
        writeMarketCache<SpotTradesCache>('spot', normalizedSymbol, {
          trades: [],
          lastPrice: null,
        })
        onTradesStateChangeRef.current?.(false)
        console.warn('[SpotTradesHistory] trades load failed:', err)
        setLoading(false)
      } finally {
        polling = false
      }
    }

    if (isPollingSpotDataSource(dataSource)) {
      void loadTradesSnapshot()
      pollTimerRef.current = window.setInterval(() => {
        void loadTradesSnapshot()
      }, EXTERNAL_TRADES_POLL_MS)
    } else {
      clearPollTimer()
      void loadTradesSnapshot()
      subscribeInternalRealtime()
    }

    return () => {
      alive = false
      clearPollTimer()
      unsubscribeTrade?.()
      unsubscribeSnapshot?.()
    }
  }, [dataSource, symbol, limit, refreshNonce])

  const data = useMemo(() => {
    return rows.map((item, index) => {
      const currentPrice = toNumber(item.price)
      const nextItem = rows[index + 1]
      const prevPrice = nextItem ? toNumber(nextItem.price) : currentPrice

      let direction: 'up' | 'down' | 'flat' = 'flat'
      if (currentPrice > prevPrice) direction = 'up'
      else if (currentPrice < prevPrice) direction = 'down'

      return {
        ...item,
        direction,
      }
    })
  }, [rows])

  const { base, quote } = splitSymbol(symbol)
  const hasTrades = data.length > 0

  return (
    <div className="tabular-nums flex h-full min-h-0 min-w-0 flex-col bg-[#11161d]">
      <div className="flex items-center justify-between border-b border-white/[0.06] bg-[#10151b]/70 px-2.5 py-2">
        <div className="text-[13px] font-medium text-white/88">{t('spotMarketTrades', 'asset')}</div>
        <div className="rounded-full bg-white/[0.03] px-2 py-0.5 text-[13px] font-medium text-white/40">
          {displaySymbol || formatSpotDisplaySymbol(symbol)}
        </div>
      </div>

      {!hasTrades ? (
        <div className="relative flex min-h-0 flex-1 items-center justify-center px-2.5 py-6 text-sm text-transparent">
          <span className="absolute inset-0 flex items-center justify-center px-3 text-center text-zinc-400">
            {loading ? t('spotTradesLoading', 'asset') : t('spotNoTradeData', 'asset')}
          </span>
          {loading ? t('spotTradesLoading', 'asset') : t('spotNoTradeData', 'asset')}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-[minmax(0,1.18fr)_minmax(0,0.92fr)_60px] items-center gap-x-2 px-2.5 py-1.5 text-[11px] font-medium text-gray-400">
            <div>{quote ? `${t('spotPrice', 'asset')} (${quote})` : t('spotPrice', 'asset')}</div>
            <div className="text-right">{base ? `${t('spotQuantity', 'asset')} (${base})` : t('spotQuantity', 'asset')}</div>
            <div className="text-right">{t('spotTime', 'asset')}</div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-color:#3f3f46_transparent] [scrollbar-width:thin] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-zinc-700/60 hover:[&::-webkit-scrollbar-thumb]:bg-zinc-500/80">
            {data.map((item, index) => {
              const priceText = formatPrice(item.price, pricePrecision)
              const amountText = formatAmount(item.amount)
              const timeText = formatTime(getTradeTime(item))

              let priceClassName = 'text-zinc-200'
              let arrow = ''

              if (item.direction === 'up') {
                priceClassName = 'text-[#00c087]'
                arrow = '^'
              } else if (item.direction === 'down') {
                priceClassName = 'text-[#f6465d]'
                arrow = 'v'
              }

              return (
                <div
                  key={`${getTradeTime(item) ?? ''}-${item.price}-${item.amount}-${index}`}
                  className="grid grid-cols-[minmax(0,1.18fr)_minmax(0,0.92fr)_60px] items-center gap-x-2 px-2.5 py-1 text-[12px] transition-colors hover:bg-white/[0.03]"
                >
                  <button
                    type="button"
                    onClick={() => onPriceClick?.(String(item.price))}
                    className={`overflow-hidden text-ellipsis whitespace-nowrap text-left font-medium tabular-nums ${priceClassName}`}
                  >
                    {priceText}
                    {arrow ? <span className="ml-0.5 text-[10px]">{arrow}</span> : null}
                  </button>

                  <div className="overflow-hidden text-ellipsis whitespace-nowrap text-right text-zinc-200/90 tabular-nums">
                    {amountText}
                  </div>

                  <div className="whitespace-nowrap text-right text-[11px] text-gray-400 tabular-nums">
                    {timeText}
                  </div>
                </div>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
