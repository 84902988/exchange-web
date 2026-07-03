'use client'

import { useMemo } from 'react'
import { useLocaleContext } from '@/contexts/LocaleContext'
import {
  type SpotMarketTradeItem,
} from '@/lib/api/modules/spot'
import { formatPrice as formatMarketPrice } from '@/lib/marketPrecision'
import { formatSpotDisplaySymbol } from './spotFormat'

type Props = {
  symbol: string
  displaySymbol?: string | null
  limit?: number
  pricePrecision: number
  trades?: SpotMarketTradeItem[]
  isLoading?: boolean
  onPriceClick?: (price: string) => void
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

function getTradeTime(item: SpotMarketTradeItem) {
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

export default function SpotTradesHistory({
  symbol,
  displaySymbol,
  limit = 20,
  pricePrecision,
  trades = [],
  isLoading = false,
  onPriceClick,
}: Props) {
  const { t } = useLocaleContext()
  const rows = useMemo(() => trades.slice(0, limit), [limit, trades])

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
            {isLoading ? t('spotTradesLoading', 'asset') : t('spotNoTradeData', 'asset')}
          </span>
          {isLoading ? t('spotTradesLoading', 'asset') : t('spotNoTradeData', 'asset')}
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
