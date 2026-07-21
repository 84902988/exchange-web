'use client'

import { useRouter } from 'next/navigation'

import { useLocaleContext } from '@/contexts/LocaleContext'
import { MarketTickerItem } from '@/lib/api/modules/market'
import { getSymbolPricePrecision } from '@/lib/marketPrecision'

export type MarketsSortKey =
  | 'last_price'
  | 'price_change_percent_24h'
  | 'high_24h'
  | 'low_24h'
  | 'quote_volume_24h'

export type MarketsSortState = {
  key: MarketsSortKey
  direction: 'asc' | 'desc'
}

type MarketsTableProps = {
  rows: MarketTickerItem[]
  loading: boolean
  error?: string
  emptyText?: string
  activePrimary?: 'ALL' | 'CRYPTO' | 'STOCK' | 'CFD'
  activeSecondary?: string
  sortState?: MarketsSortState | null
  onSortChange?: (key: MarketsSortKey) => void
}

const CATEGORY_LABEL_KEYS: Record<string, string> = {
  CRYPTO: 'crypto',
  STOCK: 'stocks',
  RWA: 'rwa',
  ETF: 'etf',
  INDEX: 'index',
  FOREX: 'forex',
  METAL: 'preciousMetals',
  COMMODITY: 'commodities',
  CONTRACT: 'contract',
}

const TRADE_BUTTON_CLASS =
  'inline-flex min-w-[72px] items-center justify-center whitespace-nowrap rounded-full bg-[#f0b90b] px-3 py-1.5 text-xs font-semibold text-black transition-colors hover:bg-[#f8c83d]'

export function toNumber(value: unknown): number | null {
  const nextValue = Number(value)
  return Number.isFinite(nextValue) ? nextValue : null
}

export function getTickerPrice(row: MarketTickerItem): unknown {
  return row.last_price ?? row.price ?? row.last ?? row.close
}

export function getTickerChange(row: MarketTickerItem): unknown {
  return row.price_change_percent_24h ?? row.change_24h ?? null
}

function getTickerHigh(row: MarketTickerItem): unknown {
  return row.high_24h ?? row.high ?? row.high_price ?? row.highPrice
}

function getTickerLow(row: MarketTickerItem): unknown {
  return row.low_24h ?? row.low ?? row.low_price ?? row.lowPrice
}

export function isHotTicker(row: MarketTickerItem): boolean {
  if (typeof row.is_hot === 'boolean') return row.is_hot
  if (typeof row.is_hot === 'number') return row.is_hot === 1
  const normalized = String(row.is_hot || '').trim().toLowerCase()
  return normalized === '1' || normalized === 'true' || normalized === 'yes'
}

function getPrecision(value: unknown, fallback: number): number {
  const nextValue = Number(value)
  if (Number.isInteger(nextValue) && nextValue >= 0 && nextValue <= 12) {
    return nextValue
  }
  return fallback
}

export function getTickerPricePrecision(row: MarketTickerItem): number {
  const apiPrecision = getPrecision(row.price_precision, 2)
  const symbolPrecision = getSymbolPricePrecision(row.symbol) ?? 2
  if (apiPrecision === 8 && symbolPrecision !== 4) {
    return symbolPrecision
  }
  return apiPrecision
}

export function formatPrice(value: unknown, pricePrecision = 2): string {
  const numberValue = toNumber(value)
  if (numberValue === null) return '--'
  const precision = getPrecision(pricePrecision, 2)

  return numberValue.toLocaleString('en-US', {
    minimumFractionDigits: precision,
    maximumFractionDigits: precision,
  })
}

export function formatChange(value: unknown): string {
  const numberValue = toNumber(value)
  if (numberValue === null) return '--'
  const prefix = numberValue > 0 ? '+' : ''
  return `${prefix}${numberValue.toFixed(2)}%`
}

function formatVolume(value: unknown): string {
  const numberValue = toNumber(value)
  if (numberValue === null || numberValue <= 0) return '--'

  const absValue = Math.abs(numberValue)
  if (absValue >= 1_000_000_000) return `${(numberValue / 1_000_000_000).toFixed(2)}B`
  if (absValue >= 1_000_000) return `${(numberValue / 1_000_000).toFixed(2)}M`
  if (absValue >= 1_000) return `${(numberValue / 1_000).toFixed(2)}K`

  return numberValue.toLocaleString('en-US', {
    maximumFractionDigits: 2,
  })
}

function getTickerQuoteVolume(row: MarketTickerItem): unknown {
  const directValue = row.quote_volume_24h ?? row.turnover ?? row.amount ?? row.value
  const directNumber = toNumber(directValue)
  if (directNumber !== null && directNumber > 0) return directValue

  const baseVolume = toNumber(row.base_volume_24h ?? row.volume_24h)
  const lastPrice = toNumber(getTickerPrice(row))
  if (baseVolume !== null && baseVolume > 0 && lastPrice !== null && lastPrice > 0) {
    return baseVolume * lastPrice
  }

  return row.volume_24h
}

export function getChangeClass(value: unknown): string {
  const numberValue = toNumber(value)
  if (numberValue === null) return 'text-white/55'
  if (numberValue > 0) return 'text-[#16c784]'
  if (numberValue < 0) return 'text-[#ea3943]'
  return 'text-white/70'
}

export function getDisplaySymbol(row: MarketTickerItem): string {
  if (row.display_symbol) return String(row.display_symbol)
  if (row.base_asset && row.quote_asset) return `${row.base_asset}/${row.quote_asset}`
  return row.symbol
}

export function getCategoryLabel(row: MarketTickerItem): string {
  const category = String(row.market_category || row.asset_type || 'CRYPTO').trim().toUpperCase()
  return CATEGORY_LABEL_KEYS[category] || '--'
}

function getTranslatedCategoryLabel(row: MarketTickerItem, t: (key: string, namespace?: 'markets') => string): string {
  const category = String(row.market_category || row.asset_type || 'CRYPTO').trim().toUpperCase()
  const labelKey = CATEGORY_LABEL_KEYS[category]
  if (labelKey) return t(labelKey, 'markets')
  return '--'
}

function getSubLabelText(row: MarketTickerItem, t: (key: string, namespace?: 'markets') => string): string {
  const externalSymbol = String(row.external_symbol || '').trim()
  const category = getTranslatedCategoryLabel(row, t)
  return externalSymbol ? `${externalSymbol} / ${category}` : category
}

function getCryptoSubLabel(
  row: MarketTickerItem,
  isContractTable: boolean,
  t: (key: string, namespace?: 'markets') => string,
): string {
  return `${row.symbol} / ${isContractTable ? t('contract', 'markets') : t('crypto', 'markets')}`
}

function getStockSymbolLabel(row: MarketTickerItem): string {
  const base = String(row.base_asset || '').trim()
  if (base) return base
  const displaySymbol = getDisplaySymbol(row)
  return displaySymbol.includes('/') ? displaySymbol.split('/')[0] : displaySymbol
}

function getStockSubtitle(row: MarketTickerItem, t: (key: string, namespace?: 'markets') => string): string {
  const externalSymbol = String(row.external_symbol || '').trim()
  return externalSymbol || getTranslatedCategoryLabel(row, t)
}

function getAvatarText(row: MarketTickerItem): string {
  const source = String(row.base_asset || row.external_symbol || row.symbol || '').trim()
  return source.slice(0, 3).toUpperCase()
}

function isContractMarketRow(row: MarketTickerItem): boolean {
  const symbol = String(row.symbol || '').toUpperCase()
  const category = String(row.market_category || '').toUpperCase()
  const subCategory = String(row.market_sub_category || '').toUpperCase()
  return (
    category === 'CONTRACT' ||
    subCategory === 'CONTRACT' ||
    subCategory === 'STOCK_CONTRACT' ||
    symbol.includes('PERP') ||
    symbol.includes('SWAP')
  )
}

function isStockQuoteRow(row: MarketTickerItem): boolean {
  const category = String(row.market_category || '').toUpperCase()
  const subCategory = String(row.market_sub_category || '').toUpperCase()
  return category === 'STOCK' && subCategory !== 'STOCK_CONTRACT' && !isContractMarketRow(row)
}

export default function MarketsTable({
  rows,
  loading,
  error,
  emptyText,
  activePrimary = 'ALL',
  activeSecondary = '',
  sortState = null,
  onSortChange,
}: MarketsTableProps) {
  const router = useRouter()
  const { t } = useLocaleContext()
  const isCryptoTable = activePrimary === 'CRYPTO'
  const isStockTable = activePrimary === 'STOCK'
  const isContractTable = activePrimary === 'CRYPTO' && activeSecondary === 'CONTRACT'
  const columnCount = 7

  const goTrade = (row: MarketTickerItem) => {
    if (isStockQuoteRow(row)) {
      router.push(`/markets/stocks/${encodeURIComponent(row.symbol)}`)
      return
    }

    const path = isContractTable || isContractMarketRow(row) ? '/contract' : '/trade/spot'
    router.push(`${path}?symbol=${encodeURIComponent(row.symbol)}`)
  }

  const renderStateRow = (content: string, className = 'text-white/50') => (
    <tr>
      <td colSpan={columnCount} className={`px-5 py-12 text-center text-[13px] ${className}`}>
        {content}
      </td>
    </tr>
  )

  const renderCellSkeleton = (className = 'ml-auto w-20') => (
    <span className={`inline-block h-4 animate-pulse rounded bg-white/10 ${className}`} />
  )

  const renderMarketValue = (
    rawValue: unknown,
    formattedValue: string,
    className = 'ml-auto w-20',
  ) => {
    if (loading && toNumber(rawValue) === null) {
      return renderCellSkeleton(className)
    }
    return formattedValue
  }

  const renderSkeletonRows = () =>
    Array.from({ length: 8 }).map((_, index) => (
      <tr key={`market-skeleton-${index}`} className="border-b border-white/[0.06] last:border-b-0">
        <td className="px-5 py-5">
          <div className="flex items-center gap-3">
            <span className="h-10 w-10 shrink-0 animate-pulse rounded-full bg-white/10" />
            <span className="h-4 w-32 animate-pulse rounded bg-white/10" />
          </div>
        </td>
        {Array.from({ length: columnCount - 1 }).map((__, cellIndex) => (
          <td key={cellIndex} className="px-5 py-5 text-right">
            {renderCellSkeleton(cellIndex === columnCount - 2 ? 'ml-auto w-12' : 'ml-auto w-20')}
          </td>
        ))}
      </tr>
    ))

  const renderSortableHeader = (
    key: MarketsSortKey,
    label: string,
    className: string,
  ) => {
    const active = sortState?.key === key
    const arrow = active ? (sortState.direction === 'desc' ? '\u2193' : '\u2191') : '\u2195'
    return (
      <th className={`${className} align-middle`}>
        <button
          type="button"
          onClick={() => onSortChange?.(key)}
          className={`inline-flex w-full items-center justify-end gap-1 whitespace-nowrap transition-colors ${
            active ? 'text-white' : 'text-white/42 hover:text-white/70'
          }`}
        >
          <span>{label}</span>
          <span className={`ml-1 inline-block w-3 text-center text-[11px] ${active ? 'text-white/80' : 'text-white/25'}`}>
            {arrow}
          </span>
        </button>
      </th>
    )
  }

  const renderStockHeaders = () => (
    <tr className="border-b border-white/10">
      <th className="w-[24%] px-5 py-4 text-left align-middle text-[11px] font-medium text-white/42">
        {activeSecondary === 'STOCK_CONTRACT' ? t('stockContracts', 'markets') : t('stocks', 'markets')}
      </th>
      {renderSortableHeader('last_price', t('lastPrice', 'markets'), 'w-[14%] px-5 py-4 text-right text-[11px] font-medium')}
      {renderSortableHeader('price_change_percent_24h', t('change24h', 'markets'), 'w-[13%] px-5 py-4 text-right text-[11px] font-medium')}
      {renderSortableHeader('high_24h', t('high24h', 'markets'), 'w-[13%] px-5 py-4 text-right text-[11px] font-medium')}
      {renderSortableHeader('low_24h', t('low24h', 'markets'), 'w-[13%] px-5 py-4 text-right text-[11px] font-medium')}
      {renderSortableHeader('quote_volume_24h', t('turnover', 'markets'), 'w-[15%] px-5 py-4 text-right text-[11px] font-medium')}
      <th className="w-[96px] px-5 py-4 text-right align-middle text-[11px] font-medium text-white/42">{t('action', 'markets')}</th>
    </tr>
  )

  const renderDefaultHeaders = () => (
    <tr className="border-b border-white/10">
      <th className="w-[24%] px-5 py-4 text-left align-middle text-[11px] font-medium text-white/42">
        {isCryptoTable ? t('tradingPair', 'markets') : t('name', 'markets')}
      </th>
      {renderSortableHeader('last_price', t('lastPrice', 'markets'), 'w-[14%] px-5 py-4 text-right text-[11px] font-medium')}
      {renderSortableHeader('price_change_percent_24h', isCryptoTable ? t('changePercent', 'markets') : t('change24h', 'markets'), 'w-[13%] px-5 py-4 text-right text-[11px] font-medium')}
      {renderSortableHeader('high_24h', isCryptoTable ? t('highPrice', 'markets') : t('high24h', 'markets'), 'w-[13%] px-5 py-4 text-right text-[11px] font-medium')}
      {renderSortableHeader('low_24h', isCryptoTable ? t('lowPrice', 'markets') : t('low24h', 'markets'), 'w-[13%] px-5 py-4 text-right text-[11px] font-medium')}
      {renderSortableHeader('quote_volume_24h', isCryptoTable ? t('turnover', 'markets') : t('turnover24h', 'markets'), 'w-[15%] px-5 py-4 text-right text-[11px] font-medium')}
      <th className="w-[96px] px-5 py-4 text-right align-middle text-[11px] font-medium text-white/42">{t('action', 'markets')}</th>
    </tr>
  )

  const renderStockRow = (row: MarketTickerItem) => (
    <tr
      key={row.symbol}
      onClick={() => goTrade(row)}
      className="cursor-pointer border-b border-white/[0.06] transition-colors last:border-b-0 hover:bg-white/[0.08]"
    >
      <td className="px-5 py-5">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/[0.07] text-[11px] font-semibold text-white/85 ring-1 ring-white/10">
            {getAvatarText(row)}
          </div>
          <div className="min-w-0">
            <div className="truncate text-[14px] font-semibold text-white">{getStockSymbolLabel(row)}</div>
            <div className="mt-1 flex items-center gap-2 text-xs text-white/40">
              <span>{getStockSubtitle(row, t)}</span>
              <span className="rounded-sm bg-white/[0.06] px-1.5 py-0.5 text-[11px] text-white/55">
                {isStockQuoteRow(row) ? t('stocks', 'markets') : t('stockContracts', 'markets')}
              </span>
              {isHotTicker(row) ? (
                <span className="rounded-sm bg-[#f0b90b]/12 px-1.5 py-0.5 text-[11px] text-[#f0b90b]">
                  {t('hot', 'markets')}
                </span>
              ) : null}
            </div>
          </div>
        </div>
      </td>
      <td className="px-5 py-5 text-right text-[13px] font-medium tabular-nums text-white">
        {renderMarketValue(
          getTickerPrice(row),
          formatPrice(getTickerPrice(row), getTickerPricePrecision(row)),
        )}
      </td>
      <td className={`px-5 py-5 text-right text-[13px] font-semibold tabular-nums ${getChangeClass(getTickerChange(row))}`}>
        {renderMarketValue(getTickerChange(row), formatChange(getTickerChange(row)), 'ml-auto w-14')}
      </td>
      <td className="px-5 py-5 text-right text-[13px] font-medium tabular-nums text-white/75">
        {renderMarketValue(getTickerHigh(row), formatPrice(getTickerHigh(row), getTickerPricePrecision(row)))}
      </td>
      <td className="px-5 py-5 text-right text-[13px] font-medium tabular-nums text-white/75">
        {renderMarketValue(getTickerLow(row), formatPrice(getTickerLow(row), getTickerPricePrecision(row)))}
      </td>
      <td className="px-5 py-5 text-right text-[13px] font-medium tabular-nums text-white/75">
        {renderMarketValue(getTickerQuoteVolume(row), formatVolume(getTickerQuoteVolume(row)))}
      </td>
      <td className="w-[96px] px-5 py-5 text-right">
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation()
            goTrade(row)
          }}
          className={TRADE_BUTTON_CLASS}
        >
          {t('tradeNow', 'markets')}
        </button>
      </td>
    </tr>
  )

  const renderDefaultRow = (row: MarketTickerItem) => (
    <tr
      key={row.symbol}
      onClick={() => goTrade(row)}
      className="cursor-pointer border-b border-white/[0.06] transition-colors last:border-b-0 hover:bg-white/[0.08]"
    >
      <td className="px-5 py-5">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/[0.07] text-[11px] font-semibold text-white/85 ring-1 ring-white/10">
            {getAvatarText(row)}
          </div>
          <div className="min-w-0">
            <div className="truncate text-[14px] font-semibold text-white">{getDisplaySymbol(row)}</div>
            <div className="mt-1 flex items-center gap-2 text-xs text-white/40">
              <span>{isCryptoTable ? getCryptoSubLabel(row, isContractTable, t) : getSubLabelText(row, t)}</span>
              {isHotTicker(row) ? (
                <span className="rounded-sm bg-[#f0b90b]/12 px-1.5 py-0.5 text-[11px] text-[#f0b90b]">
                  {t('hot', 'markets')}
                </span>
              ) : null}
            </div>
          </div>
        </div>
      </td>
      <td className="px-5 py-5 text-right text-[13px] font-medium tabular-nums text-white">
        {renderMarketValue(
          getTickerPrice(row),
          formatPrice(getTickerPrice(row), getTickerPricePrecision(row)),
        )}
      </td>
      <td className={`px-5 py-5 text-right text-[13px] font-semibold tabular-nums ${getChangeClass(getTickerChange(row))}`}>
        {renderMarketValue(getTickerChange(row), formatChange(getTickerChange(row)), 'ml-auto w-14')}
      </td>
      <td className="px-5 py-5 text-right text-[13px] font-medium tabular-nums text-white/75">
        {renderMarketValue(getTickerHigh(row), formatPrice(getTickerHigh(row), getTickerPricePrecision(row)))}
      </td>
      <td className="px-5 py-5 text-right text-[13px] font-medium tabular-nums text-white/75">
        {renderMarketValue(getTickerLow(row), formatPrice(getTickerLow(row), getTickerPricePrecision(row)))}
      </td>
      <td className="px-5 py-5 text-right text-[13px] font-medium tabular-nums text-white/75">
        {renderMarketValue(getTickerQuoteVolume(row), formatVolume(getTickerQuoteVolume(row)))}
      </td>
      <td className="w-[96px] px-5 py-5 text-right">
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation()
            goTrade(row)
          }}
          className={TRADE_BUTTON_CLASS}
        >
          {t('tradeNow', 'markets')}
        </button>
      </td>
    </tr>
  )

  return (
    <div className="overflow-hidden rounded-xl border border-white/10 bg-[#111418]">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[1040px] table-fixed border-collapse">
          <thead className="bg-[#14181e]">
            {isStockTable ? renderStockHeaders() : renderDefaultHeaders()}
          </thead>

          <tbody>
            {loading && rows.length === 0
              ? renderSkeletonRows()
              : error && rows.length === 0
                ? renderStateRow(error, 'text-[#ea3943]')
                : rows.length === 0
                  ? renderStateRow(emptyText || t('noMatchingMarkets', 'markets'))
                  : rows.map((row) => (isStockTable ? renderStockRow(row) : renderDefaultRow(row)))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

