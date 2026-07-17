'use client';

import { useMemo, useState } from 'react';
import {
  type ContractDepthLevel,
  type ContractDepthMode,
  type ContractMarketViewDetail,
  type ContractQuoteDisplayStatus,
} from '@/lib/api/modules/contract';
import { formatPrice } from '@/lib/marketPrecision';
import { useLocaleContext } from '@/contexts/LocaleContext';
import {
  buildContractOrderBookRows,
  calculateContractOrderBookDepthRatio,
  formatContractOrderBookAmount,
  getContractDepthModeLabel,
  getContractOrderBookDataLimit,
  getContractOrderBookLevelLimit,
  normalizeContractDepthMode,
  padContractOrderBookRows,
  type ContractOrderBookDisplayMode,
  type ContractOrderBookRow,
  type ContractOrderBookRowSlot,
} from './contractOrderBook.utils';
import {
  useContractOrderBookStoreSnapshot,
  type ContractOrderBookStoreSnapshot,
} from './hooks/contractMarketStoreAdapter';
import type { ContractReferencePrice } from './contractPriceAuthority';

type ContractFuturesOrderBookProps = {
  priceDirection?: 'up' | 'down' | 'flat';
  pricePrecision: number;
  bids?: ContractDepthLevel[];
  asks?: ContractDepthLevel[];
  status?: ContractQuoteDisplayStatus | null;
  statusLabel?: string | null;
  referencePrice: ContractReferencePrice;
  bestBid?: string | number | null;
  bestAsk?: string | number | null;
  spread?: string | number | null;
  marketView?: ContractMarketViewDetail | null;
  depthMode?: ContractDepthMode | null;
  depthSource?: string | null;
  depthFreshness?: string | null;
  depthUpdatedAt?: number | null;
  loading?: boolean;
  error?: string | null;
  onPriceClick?: (price: string) => void;
  onPriceSelect?: (price: string) => void;
  onBestBidAskChange?: (best: {
    bestBid: string | null;
    bestAsk: string | null;
    source?: string | null;
    depthMode?: ContractDepthMode | null;
    ts?: string | number | null;
    bidsCount?: number;
    asksCount?: number;
  }) => void;
};

type ContractOrderBookLegacyRead = {
  bids: ContractDepthLevel[];
  asks: ContractDepthLevel[];
  status: ContractQuoteDisplayStatus | null;
  statusLabel: string | null;
  bestBid: string | number | null;
  bestAsk: string | number | null;
  spread: string | number | null;
  depthMode: ContractDepthMode | null;
  depthSource: string | null;
  depthFreshness: string | null;
  depthUpdatedAt: number | null;
  loading: boolean;
  error: string | null;
};

export type ContractOrderBookMarketRead = ContractOrderBookLegacyRead & {
  authority: 'STORE' | 'LEGACY_FALLBACK';
  symbol: string | null;
};

export type ContractOrderBookReadDifference = {
  field: string;
  storeValue: unknown;
  legacyValue: unknown;
};

const EMPTY_DEPTH_LEVELS: ContractDepthLevel[] = [];

const ORDERBOOK_MODE_LABELS: Record<string, Record<ContractOrderBookDisplayMode, string>> = {
  en: { FULL: 'All', BUY: 'Bids', SELL: 'Asks' },
  zh: { FULL: '\u5168\u90e8', BUY: '\u4e70\u76d8', SELL: '\u5356\u76d8' },
  'zh-TW': { FULL: '\u5168\u90e8', BUY: '\u8cb7\u76e4', SELL: '\u8ce3\u76e4' },
  ja: { FULL: '\u3059\u3079\u3066', BUY: '\u8cb7\u3044\u677f', SELL: '\u58f2\u308a\u677f' },
};

function toPositivePrice(value?: string | number | null) {
  if (value === undefined || value === null || value === '') return null;
  const normalized = typeof value === 'string' ? value.replace(/,/g, '').trim() : value;
  const price = Number(normalized);
  return Number.isFinite(price) && price > 0 ? price : null;
}

function normalizeToken(value?: string | null) {
  return String(value || '').trim().toUpperCase();
}

function isUsableStoreDepth(store: ContractOrderBookStoreSnapshot) {
  const freshness = normalizeToken(store.freshness);
  const marketStatus = normalizeToken(store.marketStatus);
  return (
    !store.stale
    && store.executable !== false
    && !['STALE', 'LAST_GOOD', 'MISSING'].includes(freshness)
    && !['CLOSED', 'HOLIDAY'].includes(marketStatus)
  );
}

function resolveStoreDepthStatus(
  store: ContractOrderBookStoreSnapshot,
  fallback: ContractQuoteDisplayStatus | null,
): ContractQuoteDisplayStatus | null {
  const marketStatus = normalizeToken(store.marketStatus);
  const freshness = normalizeToken(store.freshness);
  if (store.stale || ['STALE', 'LAST_GOOD', 'MISSING'].includes(freshness)) return 'UNAVAILABLE';
  if (store.executable === false || ['CLOSED', 'HOLIDAY'].includes(marketStatus)) return 'UNAVAILABLE';
  if (['LIVE', 'RECENT'].includes(freshness)) return 'LIVE';
  return fallback;
}

export function resolveContractOrderBookMarketRead(
  store: ContractOrderBookStoreSnapshot | null,
  legacy: ContractOrderBookLegacyRead,
): ContractOrderBookMarketRead {
  // During a symbol transition the legacy adapter marks its symbol-scoped
  // projection as loading before the Store activation effect advances. Keep
  // that guard so the previous active symbol cannot flash for one render.
  if (!store || legacy.loading) {
    return { ...legacy, authority: 'LEGACY_FALLBACK', symbol: null };
  }
  const usable = isUsableStoreDepth(store);
  const status = resolveStoreDepthStatus(store, legacy.status);
  return {
    authority: 'STORE',
    symbol: store.symbol,
    bids: usable ? store.bids : EMPTY_DEPTH_LEVELS,
    asks: usable ? store.asks : EMPTY_DEPTH_LEVELS,
    status,
    statusLabel: status === legacy.status ? legacy.statusLabel : null,
    bestBid: usable ? store.bestBid : null,
    bestAsk: usable ? store.bestAsk : null,
    spread: usable ? store.spread : null,
    depthMode: store.depthMode || legacy.depthMode,
    depthSource: store.source || legacy.depthSource,
    depthFreshness: store.freshness || legacy.depthFreshness,
    depthUpdatedAt: store.observedAtMs || legacy.depthUpdatedAt,
    loading: false,
    error: null,
  };
}

function canonicalLevels(levels: ContractDepthLevel[]) {
  return levels
    .map((level) => [Number(level.price), Number(level.amount)] as const)
    .filter(([price, amount]) => Number.isFinite(price) && Number.isFinite(amount))
    .sort((left, right) => left[0] - right[0] || left[1] - right[1]);
}

function comparableNumber(value: unknown): number | null {
  const normalized = String(value ?? '').replace(/,/g, '').trim();
  if (!normalized) return null;
  const numberValue = Number(normalized);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function depthValuesDiffer(storeValue: unknown, legacyValue: unknown) {
  const storeNumber = comparableNumber(storeValue);
  const legacyNumber = comparableNumber(legacyValue);
  if (storeNumber !== null && legacyNumber !== null) {
    return Math.abs(storeNumber - legacyNumber) > 1e-9;
  }
  return normalizeToken(String(storeValue ?? '')) !== normalizeToken(String(legacyValue ?? ''));
}

export function getContractOrderBookReadDifferences(
  store: ContractOrderBookStoreSnapshot | null,
  legacy: ContractOrderBookLegacyRead,
): ContractOrderBookReadDifference[] {
  if (!store) return [];
  const differences: ContractOrderBookReadDifference[] = [];
  const storeBids = canonicalLevels(store.bids);
  const storeAsks = canonicalLevels(store.asks);
  const legacyBids = canonicalLevels(legacy.bids);
  const legacyAsks = canonicalLevels(legacy.asks);
  if (JSON.stringify(storeBids) !== JSON.stringify(legacyBids)) {
    differences.push({ field: 'bids', storeValue: storeBids, legacyValue: legacyBids });
  }
  if (JSON.stringify(storeAsks) !== JSON.stringify(legacyAsks)) {
    differences.push({ field: 'asks', storeValue: storeAsks, legacyValue: legacyAsks });
  }
  const candidates: Array<[string, unknown, unknown]> = [
    ['bestBid', store.bestBid, legacy.bestBid],
    ['bestAsk', store.bestAsk, legacy.bestAsk],
    ['spread', store.spread, legacy.spread],
    ['depthMode', store.depthMode, legacy.depthMode],
    ['depthSource', store.source, legacy.depthSource],
    ['depthFreshness', store.freshness, legacy.depthFreshness],
  ];
  for (const [field, storeValue, legacyValue] of candidates) {
    if (storeValue === null || storeValue === undefined) continue;
    if (depthValuesDiffer(storeValue, legacyValue)) {
      differences.push({ field, storeValue, legacyValue });
    }
  }
  return differences;
}

function OrderBookModeIcon({
  mode,
  active,
}: {
  mode: ContractOrderBookDisplayMode;
  active: boolean;
}) {
  const askBars = mode === 'FULL' || mode === 'SELL';
  const bidBars = mode === 'FULL' || mode === 'BUY';

  return (
    <svg
      aria-hidden="true"
      className={`h-4 w-4 transition-[opacity,filter] ${
        active
          ? 'opacity-100 brightness-125 drop-shadow-[0_0_3px_rgba(255,255,255,0.18)]'
          : 'opacity-35 saturate-50'
      }`}
      data-testid={`contract-orderbook-mode-icon-${mode}`}
      focusable="false"
      viewBox="0 0 14 14"
    >
      {askBars ? (
        <>
          <rect fill="#f6465d" height="1.5" opacity="0.9" rx="0.5" width="12" x="1" y="1.5" />
          <rect fill="#f6465d" height="1.5" opacity="0.7" rx="0.5" width="9" x="4" y="4.25" />
        </>
      ) : null}
      {bidBars ? (
        <>
          <rect fill="#00c087" height="1.5" opacity="0.7" rx="0.5" width="9" x="1" y="8.25" />
          <rect fill="#00c087" height="1.5" opacity="0.9" rx="0.5" width="12" x="1" y="11" />
        </>
      ) : null}
    </svg>
  );
}

export default function ContractFuturesOrderBook({
  priceDirection = 'flat',
  pricePrecision,
  bids: legacyBids = EMPTY_DEPTH_LEVELS,
  asks: legacyAsks = EMPTY_DEPTH_LEVELS,
  status: legacyStatus,
  statusLabel: legacyStatusLabel,
  referencePrice,
  bestBid: legacyBestBid,
  bestAsk: legacyBestAsk,
  spread: legacySpread,
  depthMode: legacyDepthMode,
  depthSource: legacyDepthSource,
  depthFreshness: legacyDepthFreshness,
  depthUpdatedAt: legacyDepthUpdatedAt,
  loading: legacyLoading = false,
  error: legacyError,
  onPriceClick,
  onPriceSelect,
}: ContractFuturesOrderBookProps) {
  const { locale, t } = useLocaleContext();
  const [displayMode, setDisplayMode] = useState<ContractOrderBookDisplayMode>('FULL');
  const storeSnapshot = useContractOrderBookStoreSnapshot();
  const legacyRead = useMemo<ContractOrderBookLegacyRead>(() => ({
    bids: legacyBids,
    asks: legacyAsks,
    status: legacyStatus ?? null,
    statusLabel: legacyStatusLabel ?? null,
    bestBid: legacyBestBid ?? null,
    bestAsk: legacyBestAsk ?? null,
    spread: legacySpread ?? null,
    depthMode: legacyDepthMode ?? null,
    depthSource: legacyDepthSource ?? null,
    depthFreshness: legacyDepthFreshness ?? null,
    depthUpdatedAt: legacyDepthUpdatedAt ?? null,
    loading: legacyLoading,
    error: legacyError ?? null,
  }), [
    legacyAsks,
    legacyBestAsk,
    legacyBestBid,
    legacyBids,
    legacyDepthFreshness,
    legacyDepthMode,
    legacyDepthSource,
    legacyDepthUpdatedAt,
    legacyError,
    legacyLoading,
    legacySpread,
    legacyStatus,
    legacyStatusLabel,
  ]);
  const marketRead = resolveContractOrderBookMarketRead(storeSnapshot, legacyRead);
  const {
    bids,
    asks,
    status,
    depthMode,
    loading,
    error,
  } = marketRead;

  const handlePriceSelect = onPriceClick || onPriceSelect;
  const modeLabels = ORDERBOOK_MODE_LABELS[locale] || ORDERBOOK_MODE_LABELS.en;
  const normalizedDepthMode = normalizeContractDepthMode(depthMode);
  const displayStatus = status ?? null;
  const depthModeLabel = getContractDepthModeLabel(depthMode);

  const depthUnavailable = loading
    || !!error;
  const visibleAsks = depthUnavailable ? EMPTY_DEPTH_LEVELS : asks;
  const visibleBids = depthUnavailable ? EMPTY_DEPTH_LEVELS : bids;
  const slotLimit = getContractOrderBookLevelLimit(displayMode);
  const dataLimit = getContractOrderBookDataLimit(displayMode, depthMode);

  const askRows = useMemo(
    () => buildContractOrderBookRows(visibleAsks, 'ask', dataLimit),
    [dataLimit, visibleAsks],
  );
  const bidRows = useMemo(
    () => buildContractOrderBookRows(visibleBids, 'bid', dataLimit),
    [dataLimit, visibleBids],
  );
  const askSlots = useMemo(
    () => padContractOrderBookRows(askRows, 'bottom', slotLimit),
    [askRows, slotLimit],
  );
  const bidSlots = useMemo(
    () => padContractOrderBookRows(bidRows, 'top', slotLimit),
    [bidRows, slotLimit],
  );
  const depthRatio = useMemo(
    () => calculateContractOrderBookDepthRatio({
      bids: visibleBids,
      asks: visibleAsks,
      depthMode,
    }),
    [
      depthMode,
      visibleAsks,
      visibleBids,
    ],
  );

  const showAsks = displayMode !== 'BUY';
  const showBids = displayMode !== 'SELL';
  const hasSelectedDepth = (showAsks && askRows.length > 0) || (showBids && bidRows.length > 0);
  const emptyStateLabel = loading
    ? t('loading', 'contracts')
    : error ? t('marketDataUnavailable', 'contracts')
      : depthUnavailable
        ? t('marketDataUnavailable', 'contracts')
        : displayStatus === 'EXPIRED_LAST_QUOTE' || displayStatus === 'UNAVAILABLE'
          ? t('marketDataUnavailable', 'contracts')
        : t('noOrderBookData', 'contracts');

  const centerPriceNumber = referencePrice.usable
    ? toPositivePrice(referencePrice.value)
    : null;
  const hasCenterPrice = referencePrice.usable
    && referencePrice.role !== 'UNAVAILABLE'
    && centerPriceNumber !== null;
  const priceClass = priceDirection === 'up'
    ? 'text-[#00c087]'
    : priceDirection === 'down'
      ? 'text-[#f6465d]'
      : 'text-white';
  const centerDisplayPrice = !hasCenterPrice || centerPriceNumber === null
    ? '--'
    : formatPrice(centerPriceNumber, pricePrecision);
  const centerSelectPrice = !hasCenterPrice || centerPriceNumber === null
    ? null
    : String(centerPriceNumber);
  const directionArrow = hasCenterPrice && priceDirection === 'up'
    ? { symbol: '\u2191', colorClass: 'text-[#00c087]' }
    : hasCenterPrice && priceDirection === 'down'
      ? { symbol: '\u2193', colorClass: 'text-[#f6465d]' }
      : null;
  const centerLabel = referencePrice.role === 'KLINE_CLOSE'
    ? t('klineLatestPrice', 'contracts')
    : referencePrice.role === 'LAST_TRADE' || referencePrice.role === 'LAST_PRICE'
      ? t('latestPrice', 'contracts')
      : t('marketDataUnavailable', 'contracts');
  const contentGridClass = displayMode === 'FULL'
    ? 'grid-rows-[minmax(0,1fr)_auto_minmax(0,1fr)]'
    : displayMode === 'BUY'
      ? 'grid-rows-[auto_minmax(0,1fr)]'
      : 'grid-rows-[minmax(0,1fr)_auto]';

  return (
    <div
      className="tabular-nums flex h-full min-h-0 min-w-0 flex-col bg-[#11161d] px-2.5 pb-1 pt-2.5"
      data-depth-display-mode={displayMode}
      data-depth-mode={normalizedDepthMode}
      data-market-authority={marketRead.authority}
      data-market-symbol={marketRead.symbol || ''}
      data-provider-generation={marketRead.authority === 'STORE' ? storeSnapshot?.providerGeneration ?? '' : ''}
    >
      <div
        className="mb-1.5 flex min-h-6 min-w-0 items-center justify-between gap-2"
        data-testid="contract-orderbook-mode-toolbar"
      >
        <div
          aria-label={t('orderBook', 'contracts')}
          className="inline-flex h-6 shrink-0 items-center gap-1.5"
          role="group"
        >
          {(Object.keys(modeLabels) as ContractOrderBookDisplayMode[]).map((mode) => (
            <button
              key={mode}
              type="button"
              aria-label={modeLabels[mode]}
              aria-pressed={displayMode === mode}
              className="inline-flex h-6 w-6 items-center justify-center rounded-sm border-0 bg-transparent transition-colors hover:bg-white/[0.035]"
              onClick={() => setDisplayMode(mode)}
              title={modeLabels[mode]}
            >
              <OrderBookModeIcon mode={mode} active={displayMode === mode} />
            </button>
          ))}
        </div>

        <div className="flex min-w-0 items-center justify-end gap-1.5 overflow-hidden">
          {depthModeLabel ? (
            <div
              className="shrink-0 whitespace-nowrap rounded-full border border-[#f0b90b]/25 bg-[#f0b90b]/10 px-2 py-0.5 text-[10px] font-semibold text-[#f0b90b]"
              data-testid="contract-orderbook-depth-mode-label"
            >
              {depthModeLabel}
            </div>
          ) : null}
        </div>
      </div>

      <div className="mb-1 grid grid-cols-3 px-1.5 text-[11px] font-medium leading-4 text-gray-400">
        <div>{t('price', 'contracts')}</div>
        <div className="text-center">{t('amount', 'contracts')}</div>
        <div className="text-right">{t('total', 'contracts')}</div>
      </div>

      <div
        className={`relative grid min-h-0 flex-1 gap-1 ${contentGridClass}`}
        data-testid="contract-orderbook-depth-area"
      >
        {showAsks ? (
          <OrderBookSide
            slots={askSlots}
            side="ask"
            pricePrecision={pricePrecision}
            onPriceSelect={handlePriceSelect}
            emptyStateLabel={!hasSelectedDepth ? emptyStateLabel : null}
          />
        ) : null}

        <button
          type="button"
          aria-label={centerLabel}
          title={centerLabel}
          disabled={!handlePriceSelect || centerDisplayPrice === '--' || !centerSelectPrice}
          onClick={() => {
            if (centerSelectPrice) handlePriceSelect?.(centerSelectPrice);
          }}
          data-price-freshness={referencePrice.freshness || ''}
          data-price-role={referencePrice.role}
          data-price-source={referencePrice.source || ''}
          data-price-usable={referencePrice.usable ? 'true' : 'false'}
          data-testid="contract-orderbook-display-price"
          className={`relative z-20 flex h-11 min-h-11 items-center justify-center rounded-md border border-white/[0.05] bg-white/[0.02] px-2 py-1.5 text-center font-semibold leading-none transition-colors hover:bg-white/[0.05] disabled:cursor-default disabled:hover:bg-white/[0.02] ${priceClass}`}
        >
          <span className="text-[20px] leading-none" data-testid="contract-orderbook-price-value">
            {centerDisplayPrice}
          </span>
          {directionArrow ? (
            <span
              aria-hidden="true"
              className={`ml-1.5 text-[16px] font-black leading-none ${directionArrow.colorClass}`}
              data-testid="contract-orderbook-price-direction"
            >
              {directionArrow.symbol}
            </span>
          ) : null}
        </button>

        {showBids ? (
          <OrderBookSide
            slots={bidSlots}
            side="bid"
            pricePrecision={pricePrecision}
            onPriceSelect={handlePriceSelect}
            emptyStateLabel={!hasSelectedDepth && !showAsks ? emptyStateLabel : null}
          />
        ) : null}
      </div>

      <DepthRatioFooter ratio={depthRatio} />
    </div>
  );
}

function OrderBookSide({
  slots,
  side,
  pricePrecision,
  onPriceSelect,
  emptyStateLabel,
}: {
  slots: ContractOrderBookRowSlot[];
  side: 'ask' | 'bid';
  pricePrecision: number;
  onPriceSelect?: (price: string) => void;
  emptyStateLabel?: string | null;
}) {
  return (
    <div
      className="relative grid min-h-0 gap-px overflow-hidden"
      data-testid={`contract-orderbook-${side}-rows`}
      style={{ gridTemplateRows: `repeat(${slots.length}, minmax(0, 1fr))` }}
    >
      {slots.map((row, index) => (
        row ? (
          <BookRow
            key={`${side}-slot-${index}`}
            row={row}
            side={side}
            pricePrecision={pricePrecision}
            onPriceSelect={onPriceSelect}
          />
        ) : (
          <EmptyBookRow key={`${side}-slot-${index}`} side={side} />
        )
      ))}
      {emptyStateLabel ? (
        <div
          className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center px-3 text-center text-sm text-white/40"
          data-empty-scope="depth-side"
          data-testid="contract-orderbook-empty-state"
        >
          {emptyStateLabel}
        </div>
      ) : null}
    </div>
  );
}

function EmptyBookRow({ side }: { side: 'ask' | 'bid' }) {
  return (
    <div
      className="grid h-full min-h-0 grid-cols-3 items-center rounded-[6px] px-1.5 text-[12px] leading-4"
      data-side={side}
      data-testid="contract-orderbook-placeholder"
    >
      <span className="px-0.5 text-left text-white/12">--</span>
      <span className="px-0.5 text-center text-white/12">--</span>
      <span className="text-right text-white/12">--</span>
    </div>
  );
}

function BookRow({
  row,
  side,
  pricePrecision,
  onPriceSelect,
}: {
  row: ContractOrderBookRow;
  side: 'ask' | 'bid';
  pricePrecision: number;
  onPriceSelect?: (price: string) => void;
}) {
  const colorClass = side === 'ask' ? 'text-[#f6465d]' : 'text-[#00c087]';
  const bgClass = side === 'ask' ? 'bg-[#f6465d]/10' : 'bg-[#00c087]/10';

  return (
    <button
      type="button"
      onClick={() => onPriceSelect?.(row.rawPrice)}
      className="relative grid h-full min-h-0 cursor-pointer grid-cols-3 items-center overflow-hidden rounded-[6px] px-1.5 text-left text-[12px] font-medium leading-4 tabular-nums transition-colors hover:bg-white/[0.035]"
    >
      <div
        className={`pointer-events-none absolute right-0 top-0 h-full ${bgClass}`}
        style={{ width: `${row.widthPercent}%` }}
      />
      <div className={`relative truncate px-0.5 text-left font-medium ${colorClass}`}>
        {formatPrice(row.price, pricePrecision)}
      </div>
      <div className="relative truncate px-0.5 text-center text-white/86">
        {formatContractOrderBookAmount(row.amount)}
      </div>
      <div className="relative text-right text-white/50">
        {formatContractOrderBookAmount(row.total)}
      </div>
    </button>
  );
}

function DepthRatioFooter({
  ratio,
}: {
  ratio: ReturnType<typeof calculateContractOrderBookDepthRatio>;
}) {
  return (
    <div
      className="mt-0.5 shrink-0 border-t border-white/[0.05] pt-1"
      data-testid="contract-orderbook-depth-ratio"
    >
      <div
        className="relative h-6 overflow-hidden rounded-sm border border-white/[0.06] bg-[#090d12]"
        data-testid="contract-orderbook-depth-ratio-bar"
      >
        {ratio ? (
          <>
            <span
              className="absolute inset-y-0 left-0"
              data-testid="contract-orderbook-buy-ratio-bar"
              style={{
                width: `${ratio.buy}%`,
                backgroundColor: 'rgba(0, 192, 135, 0.10)',
              }}
            />
            <span
              className="absolute inset-y-0 right-0"
              data-testid="contract-orderbook-sell-ratio-bar"
              style={{
                width: `${ratio.sell}%`,
                backgroundColor: 'rgba(246, 70, 93, 0.11)',
              }}
            />
            <span
              aria-hidden="true"
              className="absolute inset-y-0 z-[1] w-2 -translate-x-1/2 bg-[#11161d]/85"
              style={{ left: `${ratio.buy}%`, transform: 'translateX(-50%) skewX(-18deg)' }}
            />
          </>
        ) : null}
        <div className="relative z-[2] flex h-full items-center justify-between px-1 text-[11px] font-medium leading-none">
          <span className={`inline-flex items-center gap-1 ${ratio ? 'text-[#00c087]' : 'text-white/30'}`}>
            <span
              className={`inline-flex h-4 min-w-4 items-center justify-center rounded-[2px] border px-0.5 ${
                ratio ? 'border-[#00c087]/70' : 'border-white/15'
              }`}
              data-testid="contract-orderbook-buy-ratio-label"
            >
              B
            </span>
            <span data-testid="contract-orderbook-buy-ratio">
              {ratio ? `${ratio.buy.toFixed(2)}%` : '--'}
            </span>
          </span>
          <span className={`inline-flex items-center gap-1 ${ratio ? 'text-[#f6465d]' : 'text-white/30'}`}>
            <span data-testid="contract-orderbook-sell-ratio">
              {ratio ? `${ratio.sell.toFixed(2)}%` : '--'}
            </span>
            <span
              className={`inline-flex h-4 min-w-4 items-center justify-center rounded-[2px] border px-0.5 ${
                ratio ? 'border-[#f6465d]/70' : 'border-white/15'
              }`}
              data-testid="contract-orderbook-sell-ratio-label"
            >
              S
            </span>
          </span>
        </div>
      </div>
    </div>
  );
}
