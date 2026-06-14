'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  getContractMarketTrades,
  type ContractMarketTrade,
} from '@/lib/api/modules/contract';
import { formatPrice as formatMarketPrice } from '@/lib/marketPrecision';
import {
  readContractTradesCache,
  writeContractTradesCache,
} from '@/lib/contractMarketCache';
import {
  contractMarketRealtime,
  type ContractMarketRealtimeMessage,
} from '@/lib/realtime/contractMarketRealtime';
import { useLocaleContext } from '@/contexts/LocaleContext';

type PriceDirection = 'up' | 'down' | 'flat';

type ContractFuturesTradesProps = {
  symbol: string;
  limit?: number;
  pricePrecision: number;
  latestPriceDirection?: PriceDirection;
  marketStatus?: string | null;
  onPriceSelect?: (price: string) => void;
  onLastPriceChange?: (price: string) => void;
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

function formatTime(value: number) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--:--:--';
  return date.toLocaleTimeString('zh-CN', { hour12: false });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeTradeTime(value: unknown) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return Date.now();
  return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
}

function getTradePayloads(message: ContractMarketRealtimeMessage) {
  if (Array.isArray(message.trades)) return message.trades;
  if (isRecord(message.trade)) return [message.trade];
  if (Array.isArray(message.data)) return message.data;
  if (isRecord(message.data)) return [message.data];
  return [message];
}

function extractRealtimeTrades(
  message: ContractMarketRealtimeMessage,
  currentSymbol: string,
): ContractMarketTrade[] {
  return getTradePayloads(message)
    .flatMap((payload) => {
      if (!isRecord(payload)) return [];
      const msgSymbol = String(message.symbol || payload.symbol || '').trim().toUpperCase();
      if (msgSymbol && msgSymbol !== currentSymbol.toUpperCase()) return [];

      const price = payload.price ?? payload.last_price;
      const qty = payload.qty ?? payload.amount ?? payload.quantity ?? payload.volume;
      if (toNumber(price as string | number | null) <= 0 || toNumber(qty as string | number | null) <= 0) {
        return [];
      }

      const time = normalizeTradeTime(payload.time ?? payload.ts ?? payload.timestamp);
      const trade: ContractMarketTrade = {
        id: payload.id ? String(payload.id) : `${time}-${price}-${qty}`,
        price: String(price),
        qty: String(qty),
        time,
      };
      if (payload.quoteQty) trade.quoteQty = String(payload.quoteQty);
      if (typeof payload.isBuyerMaker === 'boolean') {
        trade.isBuyerMaker = payload.isBuyerMaker;
      } else if (typeof payload.is_buyer_maker === 'boolean') {
        trade.isBuyerMaker = payload.is_buyer_maker;
      }
      return [trade];
    });
}

export default function ContractFuturesTrades({
  symbol,
  limit = 30,
  pricePrecision,
  latestPriceDirection,
  marketStatus,
  onPriceSelect,
  onLastPriceChange,
}: ContractFuturesTradesProps) {
  const { t } = useLocaleContext();
  const [rows, setRows] = useState<ContractMarketTrade[]>([]);
  const [loading, setLoading] = useState(true);
  const onLastPriceChangeRef = useRef(onLastPriceChange);

  useEffect(() => {
    onLastPriceChangeRef.current = onLastPriceChange;
  }, [onLastPriceChange]);

  useEffect(() => {
    let alive = true;
    let polling = false;

    async function loadTrades() {
      if (polling) return;
      if (marketStatus === 'CLOSED') {
        setLoading(false);
        return;
      }
      polling = true;
      try {
        const trades = await getContractMarketTrades(symbol, limit);
        if (!alive) return;
        const nextRows = [...trades].reverse();
        setRows(nextRows);
        writeContractTradesCache(symbol, {
          trades: nextRows,
          lastPrice: nextRows[0]?.price ?? null,
        });
      } catch {
        if (!alive) return;
      } finally {
        if (alive) setLoading(false);
        polling = false;
      }
    }

    const cached = readContractTradesCache(symbol);
    if (cached?.trades?.length) {
      setRows(cached.trades.slice(0, limit));
      if (cached.lastPrice) onLastPriceChangeRef.current?.(String(cached.lastPrice));
      setLoading(false);
    } else {
      setRows([]);
      setLoading(true);
    }
    void loadTrades();
    if (marketStatus === 'CLOSED') {
      return () => {
        alive = false;
      };
    }
    const timer = window.setInterval(() => {
      void loadTrades();
    }, 1500);

    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [symbol, limit, marketStatus]);

  const data = useMemo(() => {
    return rows.map((item, index) => {
      const next = rows[index + 1];
      const currentPrice = toNumber(item.price);
      const prevPrice = next ? toNumber(next.price) : currentPrice;
      return {
        ...item,
        direction: index === 0 && latestPriceDirection
          ? latestPriceDirection
          : currentPrice > prevPrice
            ? 'up'
            : currentPrice < prevPrice
              ? 'down'
              : 'flat',
      };
    });
  }, [latestPriceDirection, rows]);

  useEffect(() => {
    const latest = rows[0]?.price;
    if (latest) onLastPriceChange?.(latest);
  }, [onLastPriceChange, rows]);

  useEffect(() => {
    const handleTradeMessage = (message: ContractMarketRealtimeMessage) => {
      if (marketStatus === 'CLOSED') return;

      const trades = extractRealtimeTrades(message, symbol);
      if (trades.length === 0) return;

      setRows((previous) => {
        const seen = new Set<string>();
        const nextRows = [...trades, ...previous]
          .filter((item) => {
            const key = String(item.id);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          })
          .slice(0, limit);

        writeContractTradesCache(symbol, {
          trades: nextRows,
          lastPrice: nextRows[0]?.price ?? null,
        });
        return nextRows;
      });
      setLoading(false);
      onLastPriceChangeRef.current?.(trades[0].price);
    };

    return contractMarketRealtime.subscribe('trade', handleTradeMessage);
  }, [limit, marketStatus, symbol]);

  return (
    <div className="tabular-nums flex h-full min-h-0 min-w-0 flex-col bg-[#11161d] px-2.5 py-2">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="text-[13px] font-medium text-white/88">{t('marketTrades', 'contracts')}</div>
          {marketStatus === 'CLOSED' ? (
            <div className="rounded-full border border-[#f0b90b]/20 bg-[#f0b90b]/10 px-2 py-0.5 text-[11px] font-semibold text-[#f0b90b]">
              {t('closedNoRealtimeTrades', 'contracts')}
            </div>
          ) : null}
        </div>
        <div className="rounded-full bg-white/[0.03] px-2 py-0.5 text-[13px] font-medium text-white/42">
          {symbol}
        </div>
      </div>

      {loading && data.length === 0 ? (
        <div className="flex min-h-0 flex-1 items-center justify-center px-2.5 py-6 text-sm text-zinc-400">
          {t('loading', 'common')}
        </div>
      ) : data.length === 0 ? (
        <div className="flex min-h-0 flex-1 items-center justify-center px-2.5 py-6 text-sm text-zinc-400">
          {t('noTradeData', 'contracts')}
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
                  onClick={() => onPriceSelect?.(item.price)}
                  className="grid w-full grid-cols-[minmax(0,1.18fr)_minmax(0,0.92fr)_60px] items-center gap-x-2 rounded-[6px] px-1.5 py-1 text-[12px] transition-colors hover:bg-white/[0.035]"
                >
                  <div className={`overflow-hidden text-ellipsis whitespace-nowrap text-left font-medium ${priceClass}`}>
                    {formatPrice(item.price, pricePrecision)}
                  </div>
                  <div className="overflow-hidden text-ellipsis whitespace-nowrap text-right text-zinc-200/90">
                    {formatAmount(item.qty)}
                  </div>
                  <div className="text-right text-zinc-400">{formatTime(item.time)}</div>
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
