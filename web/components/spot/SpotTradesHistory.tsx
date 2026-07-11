'use client'

import { useMemo } from 'react'
import { useLocaleContext } from '@/contexts/LocaleContext'
import {
  type SpotMarketTradeItem,
} from '@/lib/api/modules/spot'
import { formatSpotDisplaySymbol } from './spotFormat'
import { formatSpotPrice } from './spotPricePrecision'
import {
  resolveSpotMarketStatus,
  spotMarketStatusDotClass,
} from './spotMarketStatus'
import {
  buildSpotTradeRenderRows,
  getSpotTradeTimeValue,
} from './spotTradeRows'

type Props = {
  symbol: string
  displaySymbol?: string | null
  limit?: number
  pricePrecision: number
  trades?: SpotMarketTradeItem[]
  tradesSource?: string | null
  tradesFreshness?: string | null
  dataSource?: string | null
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
  return formatSpotPrice(n, precision)
}

function formatAmount(value: string | number | undefined | null) {
  const n = Number(value)
  if (!Number.isFinite(n)) return '--'
  return n.toFixed(6)
}

function formatTime(value?: string | number | null) {
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
  tradesSource,
  tradesFreshness,
  dataSource,
  isLoading = false,
  onPriceClick,
}: Props) {
  const { t } = useLocaleContext()
  const rows = useMemo(() => trades.slice(0, limit), [limit, trades])
  const renderRows = useMemo(() => buildSpotTradeRenderRows(rows, { symbol }), [rows, symbol])

  const data = useMemo(() => {
    return renderRows.map(({ trade, key }, index) => {
      const currentPrice = toNumber(trade.price)
      const nextTrade = renderRows[index + 1]?.trade
      const prevPrice = nextTrade ? toNumber(nextTrade.price) : currentPrice

      let direction: 'up' | 'down' | 'flat' = 'flat'
      if (currentPrice > prevPrice) direction = 'up'
      else if (currentPrice < prevPrice) direction = 'down'

      return {
        trade,
        key,
        direction,
      }
    })
  }, [renderRows])

  const { base, quote } = splitSymbol(symbol)
  const hasTrades = data.length > 0
  const tradesStatus = resolveSpotMarketStatus(
    {
      source: tradesSource,
      freshness: tradesFreshness,
      dataSource,
      isLoading,
    },
    t,
  )

  return (
    <div className="tabular-nums flex h-full min-h-0 min-w-0 flex-col bg-[#11161d]">
      <div className="flex items-center justify-between gap-2 border-b border-white/[0.06] bg-[#10151b]/70 px-2.5 py-2">
        <div className="min-w-0 text-[13px] font-medium text-white/88">{t('spotMarketTrades', 'asset')}</div>
        <div className="flex min-w-0 items-center gap-1.5">
          <span
            className="inline-flex h-5 max-w-[4.25rem] shrink-0 items-center gap-1 rounded-md border border-white/[0.06] bg-white/[0.025] px-1.5 text-[10px] font-semibold text-white/56"
            title={tradesStatus.fullLabel}
            aria-label={tradesStatus.fullLabel}
          >
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${spotMarketStatusDotClass(tradesStatus.kind)}`} />
            <span className="min-w-0 truncate">{tradesStatus.compactLabel}</span>
          </span>
          <span className="rounded-full bg-white/[0.03] px-2 py-0.5 text-[13px] font-medium text-white/40">
            {displaySymbol || formatSpotDisplaySymbol(symbol)}
          </span>
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
              const priceText = formatPrice(item.trade.price, pricePrecision)
              const amountText = formatAmount(item.trade.amount)
              const timeText = formatTime(getSpotTradeTimeValue(item.trade))

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
                  key={item.key}
                  data-testid={index === 0 ? 'spot-recent-trade-first' : undefined}
                  data-trade-price={index === 0 ? String(item.trade.price) : undefined}
                  className="grid grid-cols-[minmax(0,1.18fr)_minmax(0,0.92fr)_60px] items-center gap-x-2 px-2.5 py-1 text-[12px] transition-colors hover:bg-white/[0.03]"
                >
                  <button
                    type="button"
                    onClick={() => onPriceClick?.(String(item.trade.price))}
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
