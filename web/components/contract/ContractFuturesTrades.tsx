'use client';

import { useMemo } from 'react';
import {
  type ContractMarketTrade,
} from '@/lib/api/modules/contract';
import { formatPrice as formatMarketPrice } from '@/lib/marketPrecision';
import { useLocaleContext } from '@/contexts/LocaleContext';
import { useDisplayTimeZone } from '@/hooks/useDisplayTimeZone';
import { formatDisplayTime } from '@/lib/displayTimeZone';
import {
  type ContractTradesStoreSnapshot,
  useContractTradesStoreSnapshot,
} from './hooks/contractMarketStoreAdapter';

type PriceDirection = 'up' | 'down' | 'flat';

type ContractFuturesTradesProps = {
  trades?: ContractMarketTrade[];
  loading?: boolean;
  error?: string | null;
  status?: string | null;
  source?: string | null;
  freshness?: string | null;
  pricePrecision: number;
  latestPriceDirection?: PriceDirection;
  onPriceClick?: (price: string) => void;
  onPriceSelect?: (price: string) => void;
};

type ContractTradesLegacyRead = {
  trades: ContractMarketTrade[];
  loading: boolean;
  error: string | null;
  status: string | null;
  source: string | null;
  freshness: string | null;
};

export type ContractTradesMarketRead = ContractTradesLegacyRead & {
  authority: 'STORE' | 'LEGACY_FALLBACK';
  symbol: string | null;
};

export type ContractTradesReadDifference = {
  field: 'trade_count' | 'trade_ids' | 'latest_trade' | 'source' | 'freshness';
  store: unknown;
  legacy: unknown;
};

function toNumber(value?: string | number | null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function formatPrice(value: string | number, precision: number) {
  const n = toNumber(value);
  return n ? formatMarketPrice(n, precision) : '--';
}

function formatAmount(value: string | number) {
  const n = toNumber(value);
  return n ? n.toFixed(6) : '--';
}

function isRenderableRealTrade(trade: ContractMarketTrade): boolean {
  const synthetic = trade.synthetic === true || [
    trade.price_source,
    trade.source,
    trade.quote_source,
  ].some((value) => String(value ?? '').trim().toUpperCase().includes('SYNTHETIC'));
  return !synthetic
    && String(trade.id ?? '').trim().length > 0
    && Number.isFinite(Number(trade.price))
    && Number(trade.price) > 0
    && Number.isFinite(Number(trade.qty))
    && Number(trade.qty) > 0
    && Number.isFinite(Number(trade.time))
    && Number(trade.time) > 0;
}

function comparableTrade(trade: ContractMarketTrade | undefined) {
  if (!trade) return null;
  return {
    id: String(trade.id),
    price: String(trade.price),
    qty: String(trade.qty),
    time: Number(trade.time),
  };
}

export function resolveContractTradesMarketRead(
  store: ContractTradesStoreSnapshot | null,
  legacy: ContractTradesLegacyRead,
): ContractTradesMarketRead {
  if (!store || legacy.loading) {
    return {
      ...legacy,
      authority: 'LEGACY_FALLBACK',
      symbol: null,
    };
  }
  return {
    trades: store.trades,
    loading: false,
    error: null,
    status: legacy.status,
    source: store.source,
    freshness: store.freshness,
    authority: 'STORE',
    symbol: store.symbol,
  };
}

export function getContractTradesReadDifferences(
  store: ContractTradesStoreSnapshot | null,
  legacy: ContractTradesLegacyRead,
): ContractTradesReadDifference[] {
  if (!store) return [];
  const differences: ContractTradesReadDifference[] = [];
  if (store.trades.length !== legacy.trades.length) {
    differences.push({
      field: 'trade_count',
      store: store.trades.length,
      legacy: legacy.trades.length,
    });
  }
  const storeIds = store.trades.map((trade) => String(trade.id));
  const legacyIds = legacy.trades.map((trade) => String(trade.id));
  if (storeIds.join('|') !== legacyIds.join('|')) {
    differences.push({ field: 'trade_ids', store: storeIds, legacy: legacyIds });
  }
  const storeLatest = comparableTrade(store.trades[0]);
  const legacyLatest = comparableTrade(legacy.trades[0]);
  if (JSON.stringify(storeLatest) !== JSON.stringify(legacyLatest)) {
    differences.push({ field: 'latest_trade', store: storeLatest, legacy: legacyLatest });
  }
  if ((store.source ?? null) !== (legacy.source ?? null)) {
    differences.push({ field: 'source', store: store.source, legacy: legacy.source });
  }
  if ((store.freshness ?? null) !== (legacy.freshness ?? null)) {
    differences.push({ field: 'freshness', store: store.freshness, legacy: legacy.freshness });
  }
  return differences;
}

export default function ContractFuturesTrades({
  trades: legacyTrades = [],
  loading: legacyLoading = false,
  error: legacyError,
  status: legacyStatus,
  source: legacySource,
  freshness: legacyFreshness,
  pricePrecision,
  latestPriceDirection,
  onPriceClick,
  onPriceSelect,
}: ContractFuturesTradesProps) {
  const { t, locale } = useLocaleContext();
  const displayTimeZone = useDisplayTimeZone();
  const handlePriceSelect = onPriceClick || onPriceSelect;
  const storeSnapshot = useContractTradesStoreSnapshot();
  const legacyRead = useMemo<ContractTradesLegacyRead>(() => ({
    trades: legacyTrades.filter(isRenderableRealTrade),
    loading: legacyLoading,
    error: legacyError ?? null,
    status: legacyStatus ?? null,
    source: legacySource ?? null,
    freshness: legacyFreshness ?? null,
  }), [
    legacyError,
    legacyFreshness,
    legacyLoading,
    legacySource,
    legacyStatus,
    legacyTrades,
  ]);
  const marketRead = useMemo(
    () => resolveContractTradesMarketRead(storeSnapshot, legacyRead),
    [legacyRead, storeSnapshot],
  );
  const {
    trades,
    loading,
    error,
    status,
  } = marketRead;
  const normalizedStatus = String(status || '').trim().toUpperCase();

  const data = useMemo(() => {
    return trades.map((item, index) => {
      const next = trades[index + 1];
      const currentPrice = toNumber(item.price);
      const prevPrice = next ? toNumber(next.price) : currentPrice;
      return {
        ...item,
        direction: marketRead.authority === 'LEGACY_FALLBACK' && index === 0 && latestPriceDirection
          ? latestPriceDirection
          : currentPrice > prevPrice
            ? 'up'
            : currentPrice < prevPrice
              ? 'down'
              : 'flat',
      };
    });
  }, [latestPriceDirection, marketRead.authority, trades]);

  return (
    <div
      className="tabular-nums flex h-full min-h-0 min-w-0 flex-col bg-[#11161d] px-2.5 py-2"
      data-market-authority={marketRead.authority}
      data-market-symbol={marketRead.symbol || undefined}
      data-provider-generation={marketRead.authority === 'STORE'
        ? storeSnapshot?.providerGeneration ?? undefined
        : undefined}
    >
      {normalizedStatus === 'CLOSED' ? (
        <div className="mb-1.5 flex min-h-5 items-center gap-2 px-1">
          <div className="rounded-full border border-[#f0b90b]/20 bg-[#f0b90b]/10 px-2 py-0.5 text-[11px] font-semibold text-[#f0b90b]">
            {t('closedNoRealtimeTrades', 'contracts')}
          </div>
        </div>
      ) : null}

      {loading && data.length === 0 ? (
        <div className="flex min-h-0 flex-1 items-center justify-center px-2.5 py-6 text-sm text-zinc-400">
          {t('loading', 'contracts')}
        </div>
      ) : data.length === 0 ? (
        <div className="flex min-h-0 flex-1 items-center justify-center px-2.5 py-6 text-sm text-zinc-400">
          {error ? t('marketDataUnavailable', 'contracts') : t('noTradeData', 'contracts')}
        </div>
      ) : (
        <>
          <div className="mb-1.5 grid grid-cols-[minmax(0,1.18fr)_minmax(0,0.92fr)_60px] items-center gap-x-2 px-1 text-[11px] font-medium text-gray-400">
            <div>{t('price', 'contracts')}</div>
            <div className="text-right">{t('amount', 'contracts')}</div>
            <div className="text-right">{t('time', 'contracts')}</div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-color:#3f3f46_transparent] [scrollbar-width:thin] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-zinc-700/60 hover:[&::-webkit-scrollbar-thumb]:bg-zinc-500/80">
            {data.map((item) => {
              const priceClass =
                item.direction === 'up'
                  ? 'text-[#00c087]'
                  : item.direction === 'down'
                    ? 'text-[#f6465d]'
                    : 'text-zinc-200';

              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => handlePriceSelect?.(item.price)}
                  className="grid w-full grid-cols-[minmax(0,1.18fr)_minmax(0,0.92fr)_60px] items-center gap-x-2 rounded-[6px] px-1.5 py-1 text-[12px] transition-colors hover:bg-white/[0.035]"
                >
                  <div className={`overflow-hidden text-ellipsis whitespace-nowrap text-left font-medium ${priceClass}`}>
                    {formatPrice(item.price, pricePrecision)}
                  </div>
                  <div className="overflow-hidden text-ellipsis whitespace-nowrap text-right text-zinc-200/90">
                    {formatAmount(item.qty)}
                  </div>
                  <div className="text-right text-zinc-400">
                    {formatDisplayTime(item.time, displayTimeZone, locale)}
                  </div>
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
