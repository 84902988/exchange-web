'use client'

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'

import MarketsTable, {
  formatChange,
  formatPrice,
  getChangeClass,
  getDisplaySymbol,
  getTickerChange,
  getTickerPrice,
  getTickerPricePrecision,
  isHotTicker,
  MarketsSortKey,
  MarketsSortState,
} from '@/components/markets/MarketsTable'
import { MarketTickerItem } from '@/lib/api/modules/market'
import {
  getSpotMarketPairs,
  getSpotMarketTickers,
  SpotMarketPairItem,
  SpotMarketTickerItem,
} from '@/lib/api/modules/spot'
import {
  ContractSymbolItem,
  ContractTickerItem,
  getContractSymbols,
  getContractTickers,
} from '@/lib/api/modules/contract'
import {
  readSharedMarketsRowsCache,
  writeSharedMarketsRowsCache,
} from '@/lib/marketCache'
import { toStockContractSymbol } from '@/lib/stockContracts'
import { useLocaleContext } from '@/contexts/LocaleContext'

type PrimaryTab = 'ALL' | 'CRYPTO' | 'STOCK' | 'CFD'
type SecondaryTab =
  | 'SPOT'
  | 'CONTRACT'
  | 'HOT'
  | 'LATEST'
  | 'ALL'
  | 'INDEX'
  | 'FOREX'
  | 'METAL'
  | 'COMMODITY'
  | 'STOCK_QUOTE'
  | 'STOCK_CONTRACT'

type UrlMarketView = 'DEFAULT' | 'RWA'
type MarketsTranslator = (key: string, namespace?: 'markets') => string

const TICKER_REFRESH_INTERVAL_MS = 5000
const METADATA_REFRESH_INTERVAL_MS = 5 * 60 * 1000
const PAIRS_PAGE_SIZE = 100
const TICKER_BATCH_SIZE = 50
const TICKER_CHUNK_CONCURRENCY = 3
const CONTRACT_TICKER_BATCH_SIZE = 25

let marketsRowsCache: MarketTickerItem[] = []
let marketsLastUpdatedCache: Date | null = null
let marketsRowsCacheLoaded = false
const spotTickerCache = new Map<string, MarketTickerItem>()
const contractTickerCache = new Map<string, ContractTickerItem>()

const PRIMARY_TABS: { key: PrimaryTab; label: string }[] = [
  { key: 'ALL', label: 'All' },
  { key: 'CRYPTO', label: 'Crypto' },
  { key: 'STOCK', label: 'Stocks' },
  { key: 'CFD', label: 'CFD' },
]

const SUMMARY_SYMBOLS = [
  'BTCUSDT',
  'RCBUSDT',
  'MFCUSDT',
  'IXICUSDT',
  'NAS100USDT',
  'XAUUSDUSDT',
  'XAGUSDUSDT',
  'EURUSDUSDT',
]

function getInitialViewFromParams(category: string, sub: string): {
  primaryTab: PrimaryTab
  secondaryTab: SecondaryTab
  urlMarketView: UrlMarketView
} {
  const normalizedCategory = category.trim().toLowerCase()
  const normalizedSub = sub.trim().toLowerCase()

  if (
    normalizedCategory === 'stock_contract' ||
    (normalizedCategory === 'stock' && normalizedSub === 'stock_contract')
  ) {
    return {
      primaryTab: 'STOCK',
      secondaryTab: 'STOCK_CONTRACT',
      urlMarketView: 'DEFAULT',
    }
  }

  if (normalizedCategory === 'stock' || normalizedSub === 'us_stock') {
    return {
      primaryTab: 'STOCK',
      secondaryTab: 'STOCK_CONTRACT',
      urlMarketView: 'DEFAULT',
    }
  }

  if (normalizedCategory === 'rwa') {
    return {
      primaryTab: 'ALL',
      secondaryTab: 'ALL',
      urlMarketView: 'RWA',
    }
  }

  return {
    primaryTab: 'ALL',
    secondaryTab: 'ALL',
    urlMarketView: 'DEFAULT',
  }
}

function normalizeCategory(value: unknown): string {
  return String(value || 'CRYPTO').trim().toUpperCase()
}

function normalizeSubCategory(row: MarketTickerItem): string {
  const value = String(row.market_sub_category || '').trim().toUpperCase()

  if (normalizeCategory(row.market_category) === 'STOCK') {
    if (isContractRow(row) || value === 'STOCK_CONTRACT') return 'STOCK_CONTRACT'
    return 'STOCK_QUOTE'
  }

  if (value) return value

  return ''
}

function isContractRow(row: MarketTickerItem): boolean {
  const symbol = String(row.symbol || '').toUpperCase()
  const category = normalizeCategory(row.market_category)
  const subCategory = String(row.market_sub_category || '').trim().toUpperCase()
  const rowType = String(row.rowType || row.row_type || '').trim().toUpperCase()
  const marketMode = String(row.market_mode || '').trim().toUpperCase()
  return (
    rowType === 'CONTRACT' ||
    marketMode === 'MOCK_STOCK_CONTRACT' ||
    category === 'CONTRACT' ||
    subCategory === 'CONTRACT' ||
    subCategory === 'STOCK_CONTRACT' ||
    symbol.includes('PERP') ||
    symbol.includes('SWAP')
  )
}

function normalizeContractAssetType(row: MarketTickerItem): string {
  const raw =
    row.asset_type ||
    row.market_category ||
    row.category ||
    row.underlying_type ||
    row.contract_type ||
    ''
  const upper = String(raw).trim().toUpperCase()

  if (['GOLD', 'SILVER', 'METAL'].includes(upper)) return 'METAL'
  if (['FUTURES', 'COMMODITY'].includes(upper)) return 'COMMODITY'
  if (upper === 'INDEX') return 'INDEX'
  if (upper === 'FOREX' || upper === 'FX') return 'FOREX'
  if (upper === 'STOCK' || upper === 'STOCK_CONTRACT') return 'STOCK'
  if (upper === 'CRYPTO' || upper === 'CONTRACT') return 'CRYPTO'

  return upper
}

function getContractAssetCategory(row: MarketTickerItem): string {
  const subCategory = String(row.market_sub_category || '').trim().toUpperCase()
  if (subCategory === 'STOCK_CONTRACT') return 'STOCK_CONTRACT'
  if (['INDEX', 'FOREX', 'METAL', 'GOLD', 'SILVER', 'COMMODITY', 'FUTURES'].includes(subCategory)) {
    return normalizeContractAssetType({ ...row, asset_type: subCategory })
  }
  const normalized = normalizeContractAssetType(row)
  if (normalized === 'STOCK') return 'STOCK_CONTRACT'
  if (normalized === 'CRYPTO') return 'CONTRACT'
  return normalized || 'CONTRACT'
}

function isStockContractRow(row: MarketTickerItem): boolean {
  return getContractAssetCategory(row) === 'STOCK_CONTRACT'
}

function isCryptoContractRow(row: MarketTickerItem): boolean {
  return isContractRow(row) && getContractAssetCategory(row) === 'CONTRACT'
}

function isTradfiCfdRow(row: MarketTickerItem): boolean {
  return ['INDEX', 'FOREX', 'METAL', 'COMMODITY'].includes(getContractAssetCategory(row))
}

function getSecondaryTabs(primaryTab: PrimaryTab): { key: SecondaryTab; label: string }[] {
  if (primaryTab === 'CFD') {
    return [
      { key: 'ALL', label: 'All' },
      { key: 'INDEX', label: 'Index' },
      { key: 'FOREX', label: 'Forex' },
      { key: 'METAL', label: 'Precious Metals' },
      { key: 'COMMODITY', label: 'Commodities' },
    ]
  }

  if (primaryTab === 'STOCK') {
    return [
      { key: 'STOCK_CONTRACT', label: 'Stock Futures' },
    ]
  }

  if (primaryTab === 'CRYPTO') {
    return [
      { key: 'SPOT', label: 'Spot' },
      { key: 'CONTRACT', label: 'Futures' },
    ]
  }

  if (primaryTab === 'ALL') {
    return [
      { key: 'ALL', label: 'All' },
      { key: 'HOT', label: 'Hot' },
    ]
  }

  return [
    { key: 'ALL', label: 'All' },
    { key: 'HOT', label: 'Hot' },
  ]
}

function getSearchText(row: MarketTickerItem): string {
  return [
    row.symbol,
    row.display_symbol,
    row.external_symbol,
    row.base_asset,
    row.display_group,
    row.market_category,
    row.market_sub_category,
  ]
    .filter(Boolean)
    .join(' ')
    .toUpperCase()
}

function isRwaRow(row: MarketTickerItem): boolean {
  return String(row.display_category || '').trim().toUpperCase() === 'RWA'
}

function isLegacyStockSpotRow(row: MarketTickerItem): boolean {
  return normalizeCategory(row.market_category) === 'STOCK' && !isContractRow(row)
}

function isMockStockContractRow(row: MarketTickerItem): boolean {
  return row.market_mode === 'MOCK_STOCK_CONTRACT'
}

function getSymbolKey(symbol: unknown): string {
  return String(symbol || '').trim().toUpperCase()
}

function readMarketsRowsCache(): { rows: MarketTickerItem[]; lastUpdated: Date | null; stale: boolean } | null {
  return readSharedMarketsRowsCache()
}

function writeMarketsRowsCache(rows: MarketTickerItem[], lastUpdated: Date | null) {
  writeSharedMarketsRowsCache(rows, lastUpdated)
}

function ensureMarketsRowsCacheLoaded() {
  if (marketsRowsCacheLoaded) return
  marketsRowsCacheLoaded = true

  const cached = readMarketsRowsCache()
  if (!cached) return

  marketsRowsCache = applyTickerCaches(cached.rows)
  marketsLastUpdatedCache = cached.lastUpdated
}

function getTickerLookupSymbol(row: MarketTickerItem): string {
  return getSymbolKey(row.ticker_symbol || row.source_symbol || row.symbol)
}

function getFiniteNumber(value: unknown): number | null {
  const numberValue = Number(value)
  return Number.isFinite(numberValue) ? numberValue : null
}

function getMarketQuoteVolumeValue(row: MarketTickerItem): number | null {
  const directValue = getFiniteNumber(row.quote_volume_24h ?? row.turnover ?? row.amount ?? row.value)
  if (directValue !== null && directValue > 0) return directValue

  const baseVolume = getFiniteNumber(row.base_volume_24h ?? row.volume_24h)
  const lastPrice = getFiniteNumber(row.last_price ?? row.price ?? row.last ?? row.close)
  if (baseVolume !== null && baseVolume > 0 && lastPrice !== null && lastPrice > 0) {
    return baseVolume * lastPrice
  }

  return getFiniteNumber(row.volume_24h)
}

function getMarketHighValue(row: MarketTickerItem): number | null {
  return getFiniteNumber(row.high_24h ?? row.high ?? row.high_price ?? row.highPrice)
}

function getMarketLowValue(row: MarketTickerItem): number | null {
  return getFiniteNumber(row.low_24h ?? row.low ?? row.low_price ?? row.lowPrice)
}

function optionalMarketValue(value: string | number | null | undefined): string | number | undefined {
  return value ?? undefined
}

function readTickerField(
  item: (MarketTickerItem | ContractTickerItem) | undefined,
  keys: string[],
): string | number | undefined {
  if (!item) return undefined
  const record = item as Record<string, unknown>
  for (const key of keys) {
    const value = record[key]
    if (value !== undefined && value !== null && value !== '') {
      return value as string | number
    }
  }
  return undefined
}

function getContractTickerHigh(ticker?: ContractTickerItem): string | number | undefined {
  return optionalMarketValue(
    readTickerField(ticker, ['high_24h', 'high', 'high_price', 'highPrice', 'day_high', 'dayHigh']),
  )
}

function getContractTickerLow(ticker?: ContractTickerItem): string | number | undefined {
  return optionalMarketValue(
    readTickerField(ticker, ['low_24h', 'low', 'low_price', 'lowPrice', 'day_low', 'dayLow']),
  )
}

function getContractTickerBaseVolume(ticker?: ContractTickerItem): string | number | undefined {
  return optionalMarketValue(
    readTickerField(ticker, ['base_volume_24h', 'base_volume', 'baseVolume', 'volume', 'vol', 'volume_24h']),
  )
}

function getContractTickerQuoteVolume(ticker?: ContractTickerItem): string | number | undefined {
  const direct = readTickerField(ticker, [
    'quote_volume_24h',
    'turnover',
    'amount',
    'value',
    'quote_volume',
    'quoteVolume',
  ])
  const directNumber = getFiniteNumber(direct)
  if (directNumber !== null && directNumber > 0) return direct

  const baseVolume = getFiniteNumber(getContractTickerBaseVolume(ticker))
  const lastPrice = getFiniteNumber(readTickerField(ticker, ['last_price', 'price', 'last', 'close']))
  if (baseVolume !== null && baseVolume > 0 && lastPrice !== null && lastPrice > 0) {
    return baseVolume * lastPrice
  }
  return undefined
}

function hasUsableStockTicker(row: MarketTickerItem): boolean {
  if (normalizeCategory(row.market_category) !== 'STOCK') return true
  const price = getFiniteNumber(row.last_price ?? row.price ?? row.last ?? row.close)
  const quoteVolume = getMarketQuoteVolumeValue(row)
  const change = getFiniteNumber(row.price_change_percent_24h ?? row.change_24h)
  if (price === null || price <= 0) return false
  if (quoteVolume !== null && quoteVolume > 0) return true
  return change !== null && change !== 0
}

function contractSymbolToMarketSymbol(symbol: string): string {
  return getSymbolKey(symbol).replace(/_?PERP$/, '')
}

function getContractDisplayLabel(symbol: string, t?: MarketsTranslator): string {
  const marketSymbol = contractSymbolToMarketSymbol(symbol)
  return marketSymbol ? `${marketSymbol} ${t ? t('perpetual', 'markets') : 'Perpetual'}` : symbol
}

function getContractBaseAsset(item: ContractSymbolItem): string {
  const providerSymbol = getSymbolKey(item.provider_symbol)
  const quoteAsset = getSymbolKey(item.quote_asset || 'USDT')
  if (providerSymbol.endsWith(quoteAsset)) {
    return providerSymbol.slice(0, -quoteAsset.length)
  }
  return contractSymbolToMarketSymbol(item.symbol).replace(quoteAsset, '')
}

function buildSpotPairRow(item: SpotMarketPairItem): MarketTickerItem {
  return {
    symbol: item.symbol,
    display_symbol: item.display_symbol,
    base_asset: item.base_asset,
    quote_asset: item.quote_asset,
    price_precision: item.price_precision,
    amount_precision: item.amount_precision,
    asset_type: item.asset_type,
    data_source: item.data_source,
    market_mode: item.market_mode,
    market_category: item.market_category,
    market_sub_category: item.market_sub_category,
    display_category: item.display_category,
    display_group: item.display_group,
    status: item.status,
  }
}

function buildStockQuoteRow(item: SpotMarketPairItem, t: MarketsTranslator): MarketTickerItem | null {
  const stockSymbol = getSymbolKey(item.external_symbol || item.base_asset)
    .replace(/ON$/, '')
    .replace(/USDT$/, '')
  if (!stockSymbol) return null

  return {
    symbol: stockSymbol,
    display_symbol: stockSymbol,
    base_asset: stockSymbol,
    quote_asset: 'USD',
    price_precision: item.price_precision,
    amount_precision: item.amount_precision,
    asset_type: 'STOCK',
    data_source: item.data_source,
    market_mode: 'QUOTE',
    market_category: 'STOCK',
    market_sub_category: 'STOCK_QUOTE',
    display_group: t('stocks', 'markets'),
    external_symbol: stockSymbol,
    ticker_symbol: item.symbol,
    status: item.status,
  }
}

function buildMockStockContractRow(item: SpotMarketPairItem, t: MarketsTranslator): MarketTickerItem | null {
  const stockSymbol = getSymbolKey(item.external_symbol || item.base_asset)
    .replace(/ON$/, '')
    .replace(/USDT$/, '')
  const contractSymbol = toStockContractSymbol(stockSymbol)
  if (!stockSymbol || !contractSymbol) return null

  return {
    symbol: contractSymbol,
    rowType: 'contract',
    category: 'STOCK',
    display_symbol: `${stockSymbol}USDT ${t('perpetual', 'markets')}`,
    base_asset: stockSymbol,
    quote_asset: 'USDT',
    price_precision: item.price_precision,
    amount_precision: item.amount_precision,
    asset_type: 'STOCK',
    data_source: item.data_source,
    market_mode: 'MOCK_STOCK_CONTRACT',
    market_category: 'STOCK',
    market_sub_category: 'STOCK_CONTRACT',
    display_group: t('stockContracts', 'markets'),
    external_symbol: stockSymbol,
    ticker_symbol: item.symbol,
    status: item.status,
  }
}

function buildContractRow(
  item: ContractSymbolItem,
  ticker?: ContractTickerItem,
  t?: MarketsTranslator,
): MarketTickerItem {
  const category = getSymbolKey(item.category || 'CRYPTO')
  const isStockContract = category === 'STOCK'
  const normalizedContractCategory = category === 'GOLD' ? 'METAL' : category === 'FUTURES' ? 'COMMODITY' : category
  const contractCategory = isStockContract ? 'STOCK' : normalizedContractCategory === 'CRYPTO' ? 'CONTRACT' : normalizedContractCategory
  const contractSubCategory = isStockContract ? 'STOCK_CONTRACT' : normalizedContractCategory === 'CRYPTO' ? 'CONTRACT' : normalizedContractCategory
  const contractAssetType = isStockContract ? 'STOCK' : normalizedContractCategory

  return {
    symbol: item.symbol,
    rowType: 'contract',
    category: item.category,
    display_symbol: getContractDisplayLabel(item.symbol, t),
    base_asset: getContractBaseAsset(item),
    quote_asset: item.quote_asset,
    last_price: optionalMarketValue(ticker?.last_price ?? ticker?.price),
    price_change_24h: optionalMarketValue(ticker?.price_change_24h),
    price_change_percent_24h:
      optionalMarketValue(ticker?.price_change_percent_24h ?? ticker?.change_24h ?? ticker?.priceChangePercent),
    high_24h: getContractTickerHigh(ticker),
    low_24h: getContractTickerLow(ticker),
    base_volume_24h: getContractTickerBaseVolume(ticker),
    quote_volume_24h: getContractTickerQuoteVolume(ticker),
    price_precision: item.price_precision,
    amount_precision: item.quantity_precision,
    asset_type: contractAssetType,
    data_source: item.provider,
    market_category: contractCategory,
    market_sub_category: contractSubCategory,
    display_group: isStockContract ? (t ? t('stockContracts', 'markets') : 'Stock Futures') : (t ? t('contract', 'markets') : 'Futures'),
    external_symbol: item.provider_symbol,
    status: item.status,
  }
}

function mergeTickerIntoRows(
  baseRows: MarketTickerItem[],
  tickerRows: MarketTickerItem[],
): MarketTickerItem[] {
  const tickerBySymbol = new Map(tickerRows.map((row) => [getSymbolKey(row.symbol), row]))
  return baseRows.map((row) => {
    const ticker = tickerBySymbol.get(getTickerLookupSymbol(row))
    if (!ticker) return row
    return {
      ...row,
      ...ticker,
      symbol: row.symbol,
      display_symbol: row.display_symbol ?? ticker.display_symbol,
      base_asset: row.base_asset ?? ticker.base_asset,
      quote_asset: row.quote_asset ?? ticker.quote_asset,
      market_category: row.market_category ?? ticker.market_category,
      market_sub_category: row.market_sub_category ?? ticker.market_sub_category,
      display_category: row.display_category ?? ticker.display_category,
    }
  })
}

function applyTickerCaches(baseRows: MarketTickerItem[]): MarketTickerItem[] {
  return baseRows.map((row) => {
    const key = getTickerLookupSymbol(row)
    if (isMockStockContractRow(row)) {
      const spotTicker = spotTickerCache.get(key)
      return spotTicker ? mergeTickerIntoRows([row], [spotTicker])[0] : row
    }
    if (isContractRow(row)) {
      const contractTicker = contractTickerCache.get(key)
      return contractTicker
        ? {
            ...row,
            last_price: optionalMarketValue(contractTicker.last_price ?? contractTicker.price),
            price_change_24h: optionalMarketValue(contractTicker.price_change_24h),
            price_change_percent_24h:
              optionalMarketValue(
                contractTicker.price_change_percent_24h ??
                  contractTicker.change_24h ??
                  contractTicker.priceChangePercent,
              ),
            high_24h: getContractTickerHigh(contractTicker),
            low_24h: getContractTickerLow(contractTicker),
            base_volume_24h: getContractTickerBaseVolume(contractTicker),
            quote_volume_24h: getContractTickerQuoteVolume(contractTicker),
          }
        : row
    }

    const spotTicker = spotTickerCache.get(key)
    if (isLegacyStockSpotRow(row) && spotTicker && !hasUsableStockTicker(spotTicker)) {
      return row
    }
    return spotTicker ? mergeTickerIntoRows([row], [spotTicker])[0] : row
  })
}

async function fetchAllSpotPairs(): Promise<SpotMarketPairItem[]> {
  const allPairs: SpotMarketPairItem[] = []
  let page = 1
  let total = 0

  do {
    const payload = await getSpotMarketPairs({
      marketType: 'spot',
      category: 'all',
      quote: 'all',
      page,
      pageSize: PAIRS_PAGE_SIZE,
    })
    allPairs.push(...payload.items)
    total = payload.total
    page += 1
  } while (allPairs.length < total && page < 20)

  return allPairs
}

function mergeRowsBySymbol(rows: MarketTickerItem[]): MarketTickerItem[] {
  const nextRows: MarketTickerItem[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    const key = getSymbolKey(row.symbol)
    if (!key || seen.has(key)) continue
    seen.add(key)
    nextRows.push(row)
  }
  return nextRows
}

async function hydrateSpotTickerChunk(symbols: string[]): Promise<MarketTickerItem[]> {
  const tickers = await getSpotMarketTickers(symbols)
  const rows = tickers.map((item: SpotMarketTickerItem) => item as MarketTickerItem)
  rows.forEach((row) => {
    if (!isLegacyStockSpotRow(row) || hasUsableStockTicker(row)) {
      spotTickerCache.set(getSymbolKey(row.symbol), row)
    }
  })
  return rows
}

function uniqueSymbols(symbols: string[]): string[] {
  return Array.from(new Set(symbols.map(getSymbolKey).filter(Boolean)))
}

function chunkItems<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = []
  const safeSize = Math.max(1, size)
  for (let index = 0; index < items.length; index += safeSize) {
    chunks.push(items.slice(index, index + safeSize))
  }
  return chunks
}

function buildRowsFromSpotPairs(spotPairs: SpotMarketPairItem[], t: MarketsTranslator): MarketTickerItem[] {
  const stockSourcePairs = spotPairs.filter((item) => isLegacyStockSpotRow(buildSpotPairRow(item)))
  const stockQuoteRows = stockSourcePairs
    .map((item) => buildStockQuoteRow(item, t))
    .filter((row): row is MarketTickerItem => Boolean(row))
  const stockContractRows = stockSourcePairs
    .map((item) => buildMockStockContractRow(item, t))
    .filter((row): row is MarketTickerItem => Boolean(row))

  return mergeRowsBySymbol([
    ...spotPairs.map(buildSpotPairRow).filter((row) => !isLegacyStockSpotRow(row)),
    ...stockQuoteRows,
    ...stockContractRows,
  ])
}

function getSpotMetadataRows(rows: MarketTickerItem[]): MarketTickerItem[] {
  return rows.filter((row) => !isContractRow(row) || isMockStockContractRow(row))
}

function getContractMetadataRows(rows: MarketTickerItem[]): MarketTickerItem[] {
  return rows.filter((row) => isContractRow(row) && !isMockStockContractRow(row))
}

function getCryptoSpotTickerSymbols(rows: MarketTickerItem[]): string[] {
  return uniqueSymbols(
    rows
      .filter((row) => !isContractRow(row) && !isLegacyStockSpotRow(row))
      .map((row) => getTickerLookupSymbol(row)),
  )
}

function getSlowSpotTickerSymbols(rows: MarketTickerItem[]): string[] {
  return uniqueSymbols(
    rows
      .filter((row) => isLegacyStockSpotRow(row) || isMockStockContractRow(row))
      .map((row) => getTickerLookupSymbol(row)),
  )
}

function getCryptoContractSymbols(rows: MarketTickerItem[]): string[] {
  return uniqueSymbols(
    rows
      .filter((row) => isContractRow(row) && !isMockStockContractRow(row) && isCryptoContractRow(row))
      .map((row) => getSymbolKey(row.symbol)),
  )
}

function getSlowContractSymbols(rows: MarketTickerItem[]): string[] {
  return uniqueSymbols(
    rows
      .filter((row) => isContractRow(row) && !isMockStockContractRow(row) && !isCryptoContractRow(row))
      .map((row) => getSymbolKey(row.symbol)),
  )
}

function filterByPrimary(rows: MarketTickerItem[], primaryTab: PrimaryTab): MarketTickerItem[] {
  if (primaryTab === 'ALL') return rows

  return rows.filter((row) => {
    const category = normalizeCategory(row.market_category)
    if (primaryTab === 'CRYPTO') return category === 'CRYPTO' || isCryptoContractRow(row)
    if (primaryTab === 'STOCK') return category === 'STOCK' || isStockContractRow(row)
    return isContractRow(row) && isTradfiCfdRow(row)
  })
}

function filterBySecondary(rows: MarketTickerItem[], secondaryTab: SecondaryTab): MarketTickerItem[] {
  if (secondaryTab === 'ALL') return rows
  if (secondaryTab === 'SPOT') return rows.filter((row) => !isContractRow(row))
  if (secondaryTab === 'CONTRACT') return rows.filter((row) => isContractRow(row))
  if (secondaryTab === 'HOT') return rows.filter((row) => isHotTicker(row) && !isContractRow(row))
  if (secondaryTab === 'LATEST') return rows
  if (secondaryTab === 'STOCK_QUOTE' || secondaryTab === 'STOCK_CONTRACT') {
    return rows.filter((row) => normalizeSubCategory(row) === secondaryTab)
  }
  return rows.filter((row) => {
    if (isContractRow(row)) return getContractAssetCategory(row) === secondaryTab
    return normalizeCategory(row.market_category) === secondaryTab
  })
}

function sortRows(rows: MarketTickerItem[], secondaryTab: SecondaryTab): MarketTickerItem[] {
  const nextRows = [...rows]
  if (secondaryTab === 'LATEST') {
    return nextRows.sort((a, b) => String(b.symbol).localeCompare(String(a.symbol)))
  }

  return nextRows.sort((a, b) => {
    const hotDiff = Number(isHotTicker(b)) - Number(isHotTicker(a))
    if (hotDiff !== 0) return hotDiff

    const sortA = Number(a.sort_order ?? 0)
    const sortB = Number(b.sort_order ?? 0)
    if (sortA !== sortB) return sortA - sortB

    return String(a.symbol).localeCompare(String(b.symbol))
  })
}

function getMarketSortValue(row: MarketTickerItem, key: MarketsSortKey): number | null {
  if (key === 'last_price') return getFiniteNumber(row.last_price ?? row.price ?? row.last ?? row.close)
  if (key === 'price_change_percent_24h') return getFiniteNumber(row.price_change_percent_24h ?? row.change_24h)
  if (key === 'high_24h') return getMarketHighValue(row)
  if (key === 'low_24h') return getMarketLowValue(row)
  return getMarketQuoteVolumeValue(row)
}

function sortRowsByState(rows: MarketTickerItem[], sortState: MarketsSortState | null): MarketTickerItem[] {
  if (!sortState) return rows

  return [...rows].sort((a, b) => {
    const valueA = getMarketSortValue(a, sortState.key)
    const valueB = getMarketSortValue(b, sortState.key)
    const hasA = valueA !== null
    const hasB = valueB !== null

    if (!hasA && !hasB) return 0
    if (!hasA) return 1
    if (!hasB) return -1

    const diff = valueA - valueB
    if (diff === 0) return 0
    return sortState.direction === 'asc' ? diff : -diff
  })
}

function buildSummaryRows(rows: MarketTickerItem[]): MarketTickerItem[] {
  const rowsWithPrice = rows.filter((row) => getFiniteNumber(getTickerPrice(row)) !== null)
  if (rowsWithPrice.length === 0) return []

  const bySymbol = new Map(rowsWithPrice.map((row) => [String(row.symbol).toUpperCase(), row]))
  const selected: MarketTickerItem[] = []
  const used = new Set<string>()

  for (const symbol of SUMMARY_SYMBOLS) {
    const row = bySymbol.get(symbol)
    if (!row || used.has(row.symbol)) continue
    selected.push(row)
    used.add(row.symbol)
    if (selected.length >= 6) break
  }

  if (selected.length >= 6) return selected

  for (const row of rowsWithPrice) {
    if (used.has(row.symbol)) continue
    selected.push(row)
    used.add(row.symbol)
    if (selected.length >= 6) break
  }

  return selected
}

function getStockDetailSymbol(row: MarketTickerItem): string {
  const symbol = getSymbolKey(row.external_symbol || row.base_asset || row.symbol)
  return symbol.replace(/USDT$/, '').replace(/ON$/, '')
}

function isStockSummaryRow(row: MarketTickerItem): boolean {
  if (isContractRow(row)) return false
  const categoryValues = [
    row.asset_type,
    row.category,
    row.market_category,
    row.market_sub_category,
  ].map(normalizeCategory)
  if (categoryValues.includes('STOCK') || categoryValues.includes('STOCK_QUOTE')) return true

  const symbol = getSymbolKey(row.symbol)
  return /^[A-Z.]{1,8}$/.test(symbol) && !symbol.endsWith('USDT')
}

function getSummaryCardHref(row: MarketTickerItem): string {
  if (isStockSummaryRow(row)) {
    return `/markets/stocks/${encodeURIComponent(getStockDetailSymbol(row))}`
  }
  if (isContractRow(row) && !isMockStockContractRow(row)) {
    return `/contract?symbol=${encodeURIComponent(row.symbol)}`
  }
  return `/trade/spot?symbol=${encodeURIComponent(row.symbol)}`
}

function getEmptyText(
  primaryTab: PrimaryTab,
  secondaryTab: SecondaryTab,
  urlMarketView: UrlMarketView,
  t: (key: string, namespace?: 'markets') => string,
): string {
  if (urlMarketView === 'RWA') return t('noRwaMarketData', 'markets')
  if (primaryTab === 'CRYPTO' && secondaryTab === 'CONTRACT') return t('noContractMarkets', 'markets')
  if (primaryTab === 'STOCK' && secondaryTab === 'STOCK_QUOTE') return t('noStocks', 'markets')
  if (primaryTab === 'STOCK' && secondaryTab === 'STOCK_CONTRACT') return t('noStockContracts', 'markets')
  return t('noMatchingMarkets', 'markets')
}

function MarketsPageContent() {
  const { locale, t } = useLocaleContext()
  const searchParams = useSearchParams()
  const categoryParam = searchParams.get('category') || ''
  const subParam = searchParams.get('sub') || ''
  const initialView = getInitialViewFromParams(categoryParam, subParam)

  const [primaryTab, setPrimaryTab] = useState<PrimaryTab>(initialView.primaryTab)
  const [secondaryTab, setSecondaryTab] = useState<SecondaryTab>(initialView.secondaryTab)
  const [urlMarketView, setUrlMarketView] = useState<UrlMarketView>(initialView.urlMarketView)
  const [search, setSearch] = useState('')
  const [sortState, setSortState] = useState<MarketsSortState | null>(null)
  const requestIdRef = useRef(0)
  const [rows, setRows] = useState<MarketTickerItem[]>(() => marketsRowsCache)
  const rowsRef = useRef<MarketTickerItem[]>(rows)
  const [loading, setLoading] = useState(() => marketsRowsCache.length === 0)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [lastUpdated, setLastUpdated] = useState<Date | null>(() => marketsLastUpdatedCache)
  const [hasMounted, setHasMounted] = useState(false)
  const metadataInFlightRef = useRef(false)
  const tickerInFlightRef = useRef(false)
  const pendingTickerRefreshRef = useRef(false)
  const tickerRequestIdRef = useRef(0)

  const commitRows = useCallback((nextRows: MarketTickerItem[], lastUpdatedAt: Date | null = new Date()) => {
    const dedupedRows = mergeRowsBySymbol(nextRows)
    marketsRowsCache = dedupedRows
    marketsLastUpdatedCache = lastUpdatedAt
    rowsRef.current = dedupedRows
    setRows(dedupedRows)
    setLastUpdated(lastUpdatedAt)
    writeMarketsRowsCache(dedupedRows, lastUpdatedAt)
  }, [])

  const refreshTickers = useCallback(async (sourceRows?: MarketTickerItem[]) => {
    if (tickerInFlightRef.current) {
      pendingTickerRefreshRef.current = true
      return
    }

    const baseRows = sourceRows?.length ? sourceRows : rowsRef.current
    if (baseRows.length === 0) return

    tickerInFlightRef.current = true
    pendingTickerRefreshRef.current = false
    setRefreshing(true)
    const tickerRequestId = tickerRequestIdRef.current + 1
    tickerRequestIdRef.current = tickerRequestId

    const commitIfCurrent = (nextRows: MarketTickerItem[]) => {
      if (tickerRequestIdRef.current !== tickerRequestId) return
      commitRows(nextRows, new Date())
    }

    const runSpotTickerChunks = async (symbols: string[]) => {
      const chunks = chunkItems(uniqueSymbols(symbols), TICKER_BATCH_SIZE)
      for (let index = 0; index < chunks.length; index += TICKER_CHUNK_CONCURRENCY) {
        const group = chunks.slice(index, index + TICKER_CHUNK_CONCURRENCY)
        await Promise.allSettled(
          group.map(async (chunk) => {
            const tickerRows = await hydrateSpotTickerChunk(chunk)
            commitIfCurrent(mergeTickerIntoRows(rowsRef.current, tickerRows))
          }),
        )
      }
    }

    const runContractTickerChunks = async (symbols: string[], batchSize = CONTRACT_TICKER_BATCH_SIZE) => {
      const chunks = chunkItems(uniqueSymbols(symbols), batchSize)
      for (let index = 0; index < chunks.length; index += TICKER_CHUNK_CONCURRENCY) {
        const group = chunks.slice(index, index + TICKER_CHUNK_CONCURRENCY)
        await Promise.allSettled(
          group.map(async (chunk) => {
            const payload = await getContractTickers({ symbols: chunk, limit: chunk.length })
            payload.items.forEach((item) => contractTickerCache.set(getSymbolKey(item.symbol), item))
            commitIfCurrent(applyTickerCaches(rowsRef.current))
          }),
        )
      }
    }

    try {
      await runSpotTickerChunks(getCryptoSpotTickerSymbols(baseRows))
      await runContractTickerChunks(getCryptoContractSymbols(rowsRef.current))
      await runSpotTickerChunks(getSlowSpotTickerSymbols(rowsRef.current))
      await runContractTickerChunks(getSlowContractSymbols(rowsRef.current), 12)
      commitIfCurrent(applyTickerCaches(rowsRef.current))
    } finally {
      if (tickerRequestIdRef.current === tickerRequestId) {
        tickerInFlightRef.current = false
        setRefreshing(false)
        if (pendingTickerRefreshRef.current) {
          pendingTickerRefreshRef.current = false
          void refreshTickers(rowsRef.current)
        }
      }
    }
  }, [commitRows])

  const loadMarketsMetadata = useCallback(async () => {
    if (metadataInFlightRef.current) return

    const requestId = requestIdRef.current + 1
    requestIdRef.current = requestId
    metadataInFlightRef.current = true
    const hasCachedRows = rowsRef.current.length > 0

    if (hasCachedRows) {
      setRefreshing(true)
    } else {
      setLoading(true)
    }

    try {
      setError('')

      const loadSpotRows = async () => {
        try {
          const spotPairs = await fetchAllSpotPairs()
          if (requestIdRef.current !== requestId) return true

          const nextRows = applyTickerCaches(
            mergeRowsBySymbol([
              ...buildRowsFromSpotPairs(spotPairs, t),
              ...getContractMetadataRows(rowsRef.current),
            ]),
          )
          commitRows(nextRows, new Date())
          setLoading(false)
          void refreshTickers(nextRows)
          return true
        } catch {
          return false
        }
      }

      const loadContractRows = async () => {
        try {
          const contractSymbols = await getContractSymbols({ page_size: PAIRS_PAGE_SIZE })
          if (requestIdRef.current !== requestId) return true

          const contractRows = contractSymbols.items.map((item) =>
            buildContractRow(item, contractTickerCache.get(getSymbolKey(item.symbol)), t),
          )
          const nextRows = applyTickerCaches(
            mergeRowsBySymbol([
              ...getSpotMetadataRows(rowsRef.current),
              ...contractRows,
            ]),
          )
          commitRows(nextRows, new Date())
          setLoading(false)
          void refreshTickers(nextRows)
          return true
        } catch {
          return false
        }
      }

      const [spotResult, contractResult] = await Promise.allSettled([
        loadSpotRows(),
        loadContractRows(),
      ])
      const spotOk = spotResult.status === 'fulfilled' && spotResult.value
      const contractOk = contractResult.status === 'fulfilled' && contractResult.value
      if (!spotOk && !contractOk && rowsRef.current.length === 0) {
        setError(t('marketLoadFailed', 'markets'))
      }
    } finally {
      metadataInFlightRef.current = false
      setLoading(false)
      if (!tickerInFlightRef.current) {
        setRefreshing(false)
      }
    }
  }, [commitRows, refreshTickers, t])

  useEffect(() => {
    setHasMounted(true)
    ensureMarketsRowsCacheLoaded()
    if (marketsRowsCache.length === 0) return

    rowsRef.current = marketsRowsCache
    setRows(marketsRowsCache)
    setLastUpdated(marketsLastUpdatedCache)
    setLoading(false)
  }, [])

  useEffect(() => {
    let mounted = true

    const refreshMetadata = async () => {
      if (!mounted) return
      await loadMarketsMetadata()
    }

    const refreshMarketTickers = () => {
      if (!mounted) return
      void refreshTickers(rowsRef.current)
    }

    void refreshMetadata()
    const metadataTimer = window.setInterval(() => {
      void refreshMetadata()
    }, METADATA_REFRESH_INTERVAL_MS)
    const tickerTimer = window.setInterval(refreshMarketTickers, TICKER_REFRESH_INTERVAL_MS)

    return () => {
      mounted = false
      window.clearInterval(metadataTimer)
      window.clearInterval(tickerTimer)
    }
  }, [loadMarketsMetadata, refreshTickers])
  useEffect(() => {
    const nextView = getInitialViewFromParams(categoryParam, subParam)
    setPrimaryTab(nextView.primaryTab)
    setSecondaryTab(nextView.secondaryTab)
    setUrlMarketView(nextView.urlMarketView)
  }, [categoryParam, subParam])

  const handlePrimaryTabChange = (nextPrimaryTab: PrimaryTab) => {
    setUrlMarketView('DEFAULT')
    setPrimaryTab(nextPrimaryTab)
    setSecondaryTab(getSecondaryTabs(nextPrimaryTab)[0].key)
  }

  const handleSecondaryTabChange = (nextSecondaryTab: SecondaryTab) => {
    setUrlMarketView('DEFAULT')
    setSecondaryTab(nextSecondaryTab)
  }

  const handleSortChange = (key: MarketsSortKey) => {
    setSortState((current) => {
      if (!current || current.key !== key) return { key, direction: 'desc' }
      if (current.direction === 'desc') return { key, direction: 'asc' }
      return null
    })
  }

  const summaryRows = useMemo(() => buildSummaryRows(rows), [rows])
  const hotRows = useMemo(
    () => sortRows(filterBySecondary(filterByPrimary(rows, 'ALL'), 'HOT'), 'HOT'),
    [rows],
  )
  const visibleSummaryRows = useMemo(() => {
    const selected = hotRows.slice(0, 6)
    if (selected.length >= 6) return selected

    const used = new Set(selected.map((row) => getSymbolKey(row.symbol)))
    for (const row of summaryRows) {
      const symbol = getSymbolKey(row.symbol)
      if (used.has(symbol)) continue
      selected.push(row)
      used.add(symbol)
      if (selected.length >= 6) break
    }

    return selected
  }, [hotRows, summaryRows])

  const filteredRows = useMemo(() => {
    const scopedRows =
      urlMarketView === 'RWA'
        ? rows.filter((row) => isRwaRow(row))
        : filterBySecondary(filterByPrimary(rows, primaryTab), secondaryTab)
    const query = search.trim().toUpperCase()
    const searchedRows = query
      ? scopedRows.filter((row) => getSearchText(row).includes(query))
      : scopedRows

    return sortRows(searchedRows, secondaryTab)
  }, [primaryTab, rows, search, secondaryTab, urlMarketView])

  const sortedRows = useMemo(() => sortRowsByState(filteredRows, sortState), [filteredRows, sortState])

  const secondaryTabs = getSecondaryTabs(primaryTab)
  const emptyText = getEmptyText(primaryTab, secondaryTab, urlMarketView, t)
  const updatedTimeLabel =
    hasMounted && lastUpdated
      ? lastUpdated.toLocaleTimeString(locale === 'zh-TW' ? 'zh-TW' : locale === 'ja' ? 'ja-JP' : locale === 'en' ? 'en-US' : 'zh-CN')
      : '--'
  const primaryTabLabel = (key: PrimaryTab, fallback: string) => {
    const map: Record<PrimaryTab, string> = {
      ALL: 'all',
      CRYPTO: 'crypto',
      STOCK: 'stocks',
      CFD: 'cfd',
    }
    return t(map[key] || fallback, 'markets')
  }
  const secondaryTabLabel = (key: SecondaryTab, fallback: string) => {
    const map: Record<SecondaryTab, string> = {
      ALL: 'all',
      SPOT: 'spot',
      CONTRACT: 'contract',
      HOT: 'hot',
      LATEST: 'latest',
      INDEX: 'index',
      FOREX: 'forex',
      METAL: 'preciousMetals',
      COMMODITY: 'commodities',
      STOCK_QUOTE: 'stocks',
      STOCK_CONTRACT: 'stockContracts',
    }
    return t(map[key] || fallback, 'markets')
  }
  const marketCategoryLabel = (row: MarketTickerItem) => {
    const rowCodes = row as MarketTickerItem & { type?: string | null; category?: string | null }
    const category = String(row.market_category || row.asset_type || rowCodes.type || rowCodes.category || 'CRYPTO')
      .trim()
      .toUpperCase()
    const map: Record<string, string> = {
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
    return map[category] ? t(map[category], 'markets') : '--'
  }

  return (
    <main className="min-h-screen bg-[#0b0e11] px-4 py-6 text-white sm:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl">
        <section className="mb-6 flex flex-col gap-4 border-b border-white/10 pb-5 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h1 className="text-3xl font-semibold text-white">{t('liveMarkets', 'markets')}</h1>
            <p className="mt-2 text-sm text-white/50">
              {t('liveMarketsDesc', 'markets')}
            </p>
          </div>

          <div className="text-[12px] tabular-nums text-white/45">
            {t('updatedAt', 'markets')}：{updatedTimeLabel}
            {refreshing && rows.length > 0 ? <span className="ml-2 text-[#f0b90b]">{t('updating', 'common')}</span> : null}
          </div>
        </section>

        {visibleSummaryRows.length > 0 ? (
          <section className="mb-6">
            <div className="mb-3 text-sm font-medium text-white/70">{t('hotMarkets', 'markets')}</div>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
              {visibleSummaryRows.map((row) => (
                <a
                  key={row.symbol}
                  href={getSummaryCardHref(row)}
                  className="rounded-xl border border-white/10 bg-[#11161d] p-3 transition-colors hover:border-white/20 hover:bg-[#151b23] sm:p-4"
                >
                  <div className="mb-2 flex items-start justify-between gap-2 sm:mb-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-white">{getDisplaySymbol(row)}</div>
                      <div className="mt-1 text-xs text-white/40">{row.external_symbol || row.symbol}</div>
                    </div>
                    <span className="shrink-0 rounded-full border border-white/10 px-2 py-0.5 text-[11px] text-white/55">
                      {marketCategoryLabel(row)}
                    </span>
                  </div>
                  <div className="text-[18px] font-semibold tabular-nums text-white">
                    {formatPrice(getTickerPrice(row), getTickerPricePrecision(row))}
                  </div>
                  <div className={`mt-1 text-[13px] font-semibold tabular-nums ${getChangeClass(getTickerChange(row))}`}>
                    {formatChange(getTickerChange(row))}
                  </div>
                </a>
              ))}
            </div>
          </section>
        ) : null}

        <section className="mb-4 flex flex-col gap-3 rounded-xl border border-white/10 bg-[#111418] p-3">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex flex-wrap gap-2">
              {PRIMARY_TABS.map((tab) => {
                const selected = primaryTab === tab.key
                return (
                  <button
                    key={tab.key}
                    type="button"
                    onClick={() => handlePrimaryTabChange(tab.key)}
                    className={`rounded-full px-4 py-2 text-sm font-medium transition-colors ${
                      selected
                        ? 'bg-white text-black'
                        : 'bg-white/[0.04] text-white/60 hover:bg-white/[0.08] hover:text-white'
                    }`}
                  >
                    {primaryTabLabel(tab.key, tab.label)}
                  </button>
                )
              })}
            </div>

            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t('searchSymbolName', 'markets')}
              className="w-full rounded-full border border-white/10 bg-[#0b0e11] px-4 py-2 text-sm text-white outline-none transition-colors placeholder:text-white/30 focus:border-[#f0b90b]/70 lg:w-72"
            />
          </div>

          <div className="flex flex-wrap gap-2 border-t border-white/10 pt-3">
            {secondaryTabs.map((tab) => {
              const selected = secondaryTab === tab.key
              return (
                <button
                  key={tab.key}
                  type="button"
                  onClick={() => handleSecondaryTabChange(tab.key)}
                  className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                    selected
                      ? 'bg-[#f0b90b] text-black'
                      : 'bg-white/[0.04] text-white/55 hover:bg-white/[0.08] hover:text-white'
                  }`}
                >
                  {secondaryTabLabel(tab.key, tab.label)}
                </button>
              )
            })}
          </div>
        </section>

        <MarketsTable
          rows={sortedRows}
          loading={loading || refreshing}
          error={error}
          emptyText={emptyText}
          activePrimary={primaryTab}
          activeSecondary={secondaryTab}
          sortState={sortState}
          onSortChange={handleSortChange}
        />
      </div>
    </main>
  )
}

export default function MarketsPage() {
  return (
    <Suspense fallback={null}>
      <MarketsPageContent />
    </Suspense>
  )
}
