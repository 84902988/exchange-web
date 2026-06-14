'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import AssetSidebar from '@/components/asset/AssetSidebar';
import { useLocaleContext } from '@/contexts/LocaleContext';
import { useAuth } from '@/lib/authContext';
import {
  cancelSpotOrder,
  getSpotCurrentOrders,
  getSpotHistoryOrders,
  getSpotMyTrades,
  type SpotOrderItem,
  type SpotTradeItem,
} from '@/lib/api/modules/spot';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'MFCUSDT', 'RCBUSDT'];
const ALL_SYMBOLS = 'ALL';
const PAGE_SIZE = 10;

type TabKey = 'current' | 'history' | 'trades';
type AssetTranslator = (key: string, namespace?: 'asset' | 'common') => string;

function formatMessage(template: string, values: Record<string, string | number>) {
  return Object.entries(values).reduce(
    (text, [key, value]) => text.replaceAll(`{${key}}`, String(value)),
    template,
  );
}

function formatNum(value: string | number | null | undefined, digits = 8) {
  const n = Number(value);
  if (!Number.isFinite(n)) return value || '--';
  return n.toLocaleString('en-US', { maximumFractionDigits: digits });
}

function positiveNumber(value: string | number | null | undefined) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function normalizeText(value: string | number | null | undefined) {
  return String(value || '').trim().toUpperCase();
}

function sideLabel(side: string, t: AssetTranslator) {
  const normalized = normalizeText(side);
  if (normalized === 'BUY') return t('buy', 'asset');
  if (normalized === 'SELL') return t('sell', 'asset');
  return side || '--';
}

function sideClass(side: string) {
  return normalizeText(side) === 'BUY' ? 'text-[#00c087]' : 'text-[#f6465d]';
}

function orderTypeLabel(value: string, t: AssetTranslator) {
  const normalized = normalizeText(value);
  if (normalized === 'LIMIT') return t('limit', 'asset');
  if (normalized === 'MARKET') return t('market', 'asset');
  return value || '--';
}

function formatSpotOrderPrice(order: SpotOrderItem, t: AssetTranslator) {
  const orderType = normalizeText(order.order_type);
  if (orderType === 'MARKET') {
    const avgPrice = positiveNumber(order.avg_price);
    return avgPrice ? formatNum(avgPrice) : t('market', 'asset');
  }
  const price = positiveNumber(order.price);
  return price ? formatNum(price) : '--';
}

function tradeSideByUser(item: SpotTradeItem, currentUserId: number | string | null | undefined, t: AssetTranslator) {
  if (currentUserId === undefined || currentUserId === null) return '--';
  const userId = String(currentUserId);
  if (item.buyer_user_id !== undefined && item.buyer_user_id !== null && String(item.buyer_user_id) === userId) {
    return t('buy', 'asset');
  }
  if (item.seller_user_id !== undefined && item.seller_user_id !== null && String(item.seller_user_id) === userId) {
    return t('sell', 'asset');
  }
  return '--';
}

function tradeSideClass(label: string, t: AssetTranslator) {
  if (label === t('buy', 'asset')) return 'text-[#00c087]';
  if (label === t('sell', 'asset')) return 'text-[#f6465d]';
  return 'text-white/55';
}

function statusLabel(status: string, t: AssetTranslator) {
  const normalized = normalizeText(status);
  const labels: Record<string, string> = {
    OPEN: t('orderOpen', 'asset'),
    PARTIALLY_FILLED: t('partiallyFilled', 'asset'),
    FILLED: t('filled', 'asset'),
    CANCELED: t('canceled', 'asset'),
    CANCELLED: t('canceled', 'asset'),
    REJECTED: t('rejected', 'asset'),
    EXPIRED: t('expired', 'asset'),
  };
  return labels[normalized] || status || '--';
}

function statusClass(status: string) {
  const normalized = normalizeText(status);
  if (normalized === 'OPEN') return 'bg-sky-500/10 text-sky-300';
  if (normalized === 'PARTIALLY_FILLED') return 'bg-amber-500/10 text-amber-300';
  if (normalized === 'FILLED') return 'bg-[#00c087]/10 text-[#00c087]';
  if (normalized === 'CANCELED' || normalized === 'CANCELLED') return 'bg-white/10 text-white/45';
  return 'bg-white/10 text-white/65';
}

function isCurrentOrder(item: SpotOrderItem) {
  const status = normalizeText(item.status);
  return status === 'OPEN' || status === 'PARTIALLY_FILLED';
}

function formatDateTime(value?: string | null) {
  if (!value) return '--';
  const text = String(value).trim();
  if (!text) return '--';
  return text
    .replace('T', ' ')
    .replace(/\.\d+Z?$/, '')
    .replace(/Z$/, '')
    .slice(0, 19);
}

function formatSpotTradeFee(item: SpotTradeItem) {
  const record = item as SpotTradeItem & {
    fee_amount?: string | number | null;
    feeAmount?: string | number | null;
    fee?: string | number | null;
    fee_asset?: string | null;
    fee_asset_symbol?: string | null;
    feeAsset?: string | null;
    fee_asset_name?: string | null;
  };
  const feeAmount = record.fee_amount ?? record.feeAmount ?? record.fee;
  const feeAsset = record.fee_asset_symbol ?? record.fee_asset ?? record.feeAsset ?? record.fee_asset_name;
  const amount = formatNum(feeAmount, 8);
  if (amount === '--') return '--';
  return `${amount} ${feeAsset || ''}`.trim();
}

function getSymbols(symbolFilter: string) {
  return symbolFilter === ALL_SYMBOLS ? SYMBOLS : [symbolFilter];
}

async function loadCurrentOrders(symbolFilter: string) {
  const results = await Promise.all(
    getSymbols(symbolFilter).map((item) => getSpotCurrentOrders(item, 100)),
  );
  return results.flatMap((result) => result.items || []).filter(isCurrentOrder);
}

async function loadHistoryOrders(symbolFilter: string) {
  const results = await Promise.all(
    getSymbols(symbolFilter).map((item) => getSpotHistoryOrders(item, 100)),
  );
  return results.flatMap((result) => result.items || []);
}

async function loadTrades(symbolFilter: string) {
  const results = await Promise.all(
    getSymbols(symbolFilter).map((item) => getSpotMyTrades(item, 100)),
  );
  return results.flatMap((result) => result.items || []);
}

function filterSpotOrders(items: SpotOrderItem[], sideFilter: string, statusFilter: string, typeFilter: string) {
  return items.filter((item) => {
    if (sideFilter !== 'ALL' && normalizeText(item.side) !== sideFilter) return false;
    const status = normalizeText(item.status);
    if (statusFilter !== 'ALL' && status !== statusFilter) {
      if (!(statusFilter === 'CANCELED' && status === 'CANCELLED')) return false;
    }
    if (typeFilter !== 'ALL' && normalizeText(item.order_type) !== typeFilter) return false;
    return true;
  });
}

function getTradeSideValue(item: SpotTradeItem, currentUserId?: number | string | null) {
  if (currentUserId !== undefined && currentUserId !== null) {
    const userId = String(currentUserId);
    if (item.buyer_user_id !== undefined && item.buyer_user_id !== null && String(item.buyer_user_id) === userId) {
      return 'BUY';
    }
    if (item.seller_user_id !== undefined && item.seller_user_id !== null && String(item.seller_user_id) === userId) {
      return 'SELL';
    }
  }
  return normalizeText(item.side);
}

function filterSpotTrades(items: SpotTradeItem[], sideFilter: string, currentUserId?: number | string | null) {
  return items.filter((item) => sideFilter === 'ALL' || getTradeSideValue(item, currentUserId) === sideFilter);
}

function paginate<T>(items: T[], page: number): T[] {
  const totalPages = Math.max(Math.ceil(items.length / PAGE_SIZE), 1);
  const safePage = Math.min(Math.max(page, 1), totalPages);
  const start = (safePage - 1) * PAGE_SIZE;
  return items.slice(start, start + PAGE_SIZE);
}

export default function AssetSpotOrdersPage() {
  const { t } = useLocaleContext();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [symbol, setSymbol] = useState('BTCUSDT');
  const [tab, setTab] = useState<TabKey>('current');
  const [page, setPage] = useState(1);
  const [sideFilter, setSideFilter] = useState('ALL');
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [typeFilter, setTypeFilter] = useState('ALL');

  const currentOrdersQuery = useQuery({
    queryKey: ['assetSpotCurrentOrders', symbol],
    queryFn: () => loadCurrentOrders(symbol),
    staleTime: 1000 * 10,
    retry: 0,
  });

  const historyOrdersQuery = useQuery({
    queryKey: ['assetSpotHistoryOrders', symbol],
    queryFn: () => loadHistoryOrders(symbol),
    staleTime: 1000 * 15,
    retry: 0,
  });

  const tradesQuery = useQuery({
    queryKey: ['assetSpotTrades', symbol],
    queryFn: () => loadTrades(symbol),
    staleTime: 1000 * 15,
    retry: 0,
  });

  const cancelMutation = useMutation({
    mutationFn: (orderId: number) => cancelSpotOrder(orderId),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['assetSpotCurrentOrders'] }),
        queryClient.invalidateQueries({ queryKey: ['assetSpotHistoryOrders'] }),
      ]);
    },
  });

  const currentOrders = useMemo(() => currentOrdersQuery.data || [], [currentOrdersQuery.data]);
  const historyOrders = useMemo(() => historyOrdersQuery.data || [], [historyOrdersQuery.data]);
  const trades = useMemo(() => tradesQuery.data || [], [tradesQuery.data]);

  const filteredCurrentOrders = useMemo(() => filterSpotOrders(currentOrders, sideFilter, statusFilter, typeFilter), [currentOrders, sideFilter, statusFilter, typeFilter]);
  const filteredHistoryOrders = useMemo(() => filterSpotOrders(historyOrders, sideFilter, statusFilter, typeFilter), [historyOrders, sideFilter, statusFilter, typeFilter]);
  const filteredTrades = useMemo(() => filterSpotTrades(trades, sideFilter, user?.id), [sideFilter, trades, user?.id]);
  const activeItems: Array<SpotOrderItem | SpotTradeItem> = tab === 'current' ? filteredCurrentOrders : tab === 'history' ? filteredHistoryOrders : filteredTrades;
  const totalPages = Math.max(Math.ceil(activeItems.length / PAGE_SIZE), 1);
  const safePage = Math.min(Math.max(page, 1), totalPages);
  const paged = {
    page: safePage,
    totalPages,
    total: activeItems.length,
    items: paginate(activeItems, page),
  };

  function resetPage() {
    setPage(1);
  }

  return (
    <main className="min-h-screen flex flex-col tabular-nums bg-[#090d12]">
      <div className="flex flex-1 py-8">
        <AssetSidebar
          isCollapsed={isSidebarCollapsed}
          onToggle={() => setIsSidebarCollapsed((value) => !value)}
        />

        <div className="lg:w-4/5 w-full px-4">
          <div className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <h1 className="text-2xl font-bold text-white">{t('spotOrders', 'asset')}</h1>
              <p className="mt-2 text-sm text-white/55">{t('spotOrdersDesc', 'asset')}</p>
            </div>
            <div className="flex items-center gap-2">
              <select
                value={symbol}
                onChange={(event) => {
                  setSymbol(event.target.value);
                  resetPage();
                }}
                className="h-9 rounded-lg border border-white/10 bg-[#0f1319] px-3 text-sm text-white"
              >
                <option value={ALL_SYMBOLS}>{t('allSymbols', 'asset')}</option>
                {SYMBOLS.map((item) => (
                  <option key={item} value={item}>{item}</option>
                ))}
              </select>
              <Link
                href={symbol === ALL_SYMBOLS ? '/trade/spot' : `/trade/spot?symbol=${encodeURIComponent(symbol)}`}
                className="flex h-9 items-center rounded-lg border border-white/10 px-3 text-sm text-white/80 hover:bg-white/[0.06]"
              >
                {t('goTrade', 'asset')}
              </Link>
            </div>
          </div>

          <section className="rounded-xl border border-white/10 bg-[#0e1117] p-5 shadow-xl">
            <div className="mb-4 flex gap-2">
              {[
                ['current', t('currentOrders', 'asset')],
                ['history', t('historyOrders', 'asset')],
                ['trades', t('myTrades', 'asset')],
              ].map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => {
                    setTab(key as TabKey);
                    resetPage();
                  }}
                  className={[
                    'h-9 rounded-lg px-4 text-sm font-medium',
                    tab === key ? 'bg-white text-black' : 'bg-white/[0.06] text-white/65 hover:text-white',
                  ].join(' ')}
                >
                  {label}
                </button>
              ))}
            </div>

            <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
              <FilterSelect
                label={t('tradePair', 'asset')}
                value={symbol}
                onChange={(value) => {
                  setSymbol(value);
                  resetPage();
                }}
                options={[
                  { value: ALL_SYMBOLS, label: t('allSymbols', 'asset') },
                  ...SYMBOLS.map((item) => ({ value: item, label: item })),
                ]}
              />
              <FilterSelect
                label={t('side', 'asset')}
                value={sideFilter}
                onChange={(value) => {
                  setSideFilter(value);
                  resetPage();
                }}
                options={[
                  { value: 'ALL', label: t('allSides', 'asset') },
                  { value: 'BUY', label: t('buy', 'asset') },
                  { value: 'SELL', label: t('sell', 'asset') },
                ]}
              />
              {tab !== 'trades' ? (
                <>
                  <FilterSelect
                    label={t('status', 'asset')}
                    value={statusFilter}
                    onChange={(value) => {
                      setStatusFilter(value);
                      resetPage();
                    }}
                    options={[
                      { value: 'ALL', label: t('allStatuses', 'asset') },
                      { value: 'OPEN', label: t('orderOpen', 'asset') },
                      { value: 'PARTIALLY_FILLED', label: t('partiallyFilled', 'asset') },
                      { value: 'FILLED', label: t('filled', 'asset') },
                      { value: 'CANCELED', label: t('canceled', 'asset') },
                      { value: 'REJECTED', label: t('rejected', 'asset') },
                      { value: 'EXPIRED', label: t('expired', 'asset') },
                    ]}
                  />
                  <FilterSelect
                    label={t('type', 'asset')}
                    value={typeFilter}
                    onChange={(value) => {
                      setTypeFilter(value);
                      resetPage();
                    }}
                    options={[
                      { value: 'ALL', label: t('allTypes', 'asset') },
                      { value: 'LIMIT', label: t('limit', 'asset') },
                      { value: 'MARKET', label: t('market', 'asset') },
                    ]}
                  />
                </>
              ) : null}
            </div>

            {tab === 'trades' ? (
              <SpotTradesTable
                items={paged.items as SpotTradeItem[]}
                currentUserId={user?.id}
                loading={tradesQuery.isLoading}
                error={tradesQuery.isError}
              />
            ) : (
              <SpotOrdersTable
                items={paged.items as SpotOrderItem[]}
                tab={tab}
                loading={tab === 'current' ? currentOrdersQuery.isLoading : historyOrdersQuery.isLoading}
                error={tab === 'current' ? currentOrdersQuery.isError : historyOrdersQuery.isError}
                cancelingId={cancelMutation.variables}
                onCancel={(orderId) => cancelMutation.mutate(orderId)}
              />
            )}

            {!(
              (tab === 'current' && currentOrdersQuery.isLoading) ||
              (tab === 'history' && historyOrdersQuery.isLoading) ||
              (tab === 'trades' && tradesQuery.isLoading)
            ) ? (
              <PaginationBar
                page={paged.page}
                pageSize={PAGE_SIZE}
                total={paged.total}
                onPageChange={setPage}
                totalPagesOverride={paged.totalPages}
              />
            ) : null}
          </section>
        </div>
      </div>
    </main>
  );
}

function SpotOrdersTable({
  items,
  tab,
  loading,
  error,
  cancelingId,
  onCancel,
}: {
  items: SpotOrderItem[];
  tab: 'current' | 'history';
  loading?: boolean;
  error?: boolean;
  cancelingId?: number;
  onCancel: (orderId: number) => void;
}) {
  const { t } = useLocaleContext();

  if (loading) return <div className="py-12 text-center text-white/55">{t('loadingSpotOrders', 'asset')}</div>;
  if (error) return <div className="py-12 text-center text-[#f6465d]">{t('spotOrdersLoadFailed', 'asset')}</div>;
  if (items.length === 0) {
    return (
      <div className="py-12 text-center">
        <div className="text-white/55">{t('noRecords', 'asset')}</div>
        {tab === 'current' ? (
          <Link
            href="/trade/spot"
            className="mt-4 inline-flex h-9 items-center rounded-lg bg-white px-4 text-sm font-semibold text-black hover:bg-white/85"
          >
            {t('goTrade', 'asset')}
          </Link>
        ) : null}
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[960px]">
        <thead>
          <tr className="border-b border-white/10 text-sm text-white/45">
            <th className="py-3 text-left font-medium">{t('tradePair', 'asset')}</th>
            <th className="py-3 text-left font-medium">{t('side', 'asset')}</th>
            <th className="py-3 text-left font-medium">{t('type', 'asset')}</th>
            <th className="py-3 text-right font-medium">{t('price', 'asset')}</th>
            <th className="py-3 text-right font-medium">{t('amount', 'asset')}</th>
            <th className="py-3 text-right font-medium">{t('filledAmount', 'asset')}</th>
            <th className="py-3 text-right font-medium">{t('status', 'asset')}</th>
            <th className="py-3 text-right font-medium">{t('time', 'asset')}</th>
            {tab === 'current' ? <th className="py-3 text-right font-medium">{t('action', 'asset')}</th> : null}
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id} className="border-b border-white/5 text-sm last:border-0">
              <td className="py-3 text-white">{item.symbol}</td>
              <td className={`py-3 font-medium ${sideClass(item.side)}`}>{sideLabel(item.side, t)}</td>
              <td className="py-3 text-white/70">{orderTypeLabel(item.order_type, t)}</td>
              <td className="py-3 text-right font-mono text-white">{formatSpotOrderPrice(item, t)}</td>
              <td className="py-3 text-right font-mono text-white">{formatNum(item.amount)}</td>
              <td className="py-3 text-right font-mono text-white/70">{formatNum(item.filled_amount)}</td>
              <td className="py-3 text-right">
                <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${statusClass(item.status)}`}>
                  {statusLabel(item.status, t)}
                </span>
              </td>
              <td className="py-3 text-right text-white/55">{formatDateTime(item.created_at)}</td>
              {tab === 'current' ? (
                <td className="py-3 text-right">
                  <button
                    type="button"
                    disabled={cancelingId === item.id}
                    onClick={() => onCancel(item.id)}
                    className="inline-flex h-7 items-center rounded-md border border-white/10 px-2.5 text-xs font-medium text-white/70 hover:bg-white/[0.06] hover:text-white disabled:cursor-not-allowed disabled:opacity-45"
                  >
                    {cancelingId === item.id ? t('canceling', 'asset') : t('cancel', 'asset')}
                  </button>
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SpotTradesTable({
  items,
  currentUserId,
  loading,
  error,
}: {
  items: SpotTradeItem[];
  currentUserId?: number | string | null;
  loading?: boolean;
  error?: boolean;
}) {
  const { t } = useLocaleContext();

  if (loading) return <div className="py-12 text-center text-white/55">{t('loadingSpotTrades', 'asset')}</div>;
  if (error) return <div className="py-12 text-center text-[#f6465d]">{t('spotTradesLoadFailed', 'asset')}</div>;
  if (items.length === 0) return <div className="py-12 text-center text-white/45">{t('noRecords', 'asset')}</div>;

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[860px]">
        <thead>
          <tr className="border-b border-white/10 text-sm text-white/45">
            <th className="py-3 text-left font-medium">{t('tradePair', 'asset')}</th>
            <th className="py-3 text-left font-medium">{t('side', 'asset')}</th>
            <th className="py-3 text-right font-medium">{t('price', 'asset')}</th>
            <th className="py-3 text-right font-medium">{t('amount', 'asset')}</th>
            <th className="py-3 text-right font-medium">{t('quoteAmount', 'asset')}</th>
            <th className="py-3 text-right font-medium">{t('fee', 'asset')}</th>
            <th className="py-3 text-right font-medium">{t('time', 'asset')}</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const userSide = tradeSideByUser(item, currentUserId, t);
            return (
              <tr key={item.trade_id} className="border-b border-white/5 text-sm last:border-0">
                <td className="py-3 text-white">{item.symbol}</td>
                <td className={`py-3 font-medium ${tradeSideClass(userSide, t)}`}>{userSide}</td>
                <td className="py-3 text-right font-mono text-white">{formatNum(item.price)}</td>
                <td className="py-3 text-right font-mono text-white">{formatNum(item.amount)}</td>
                <td className="py-3 text-right font-mono text-white/70">{formatNum(item.quote_amount)}</td>
                <td className="py-3 text-right font-mono text-white/70">{formatSpotTradeFee(item)}</td>
                <td className="py-3 text-right text-white/55">{formatDateTime(item.created_at)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs text-white/45">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-9 w-full rounded-lg border border-white/10 bg-[#090d12] px-3 text-sm text-white outline-none transition-colors hover:border-white/20 focus:border-white/30"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value} className="bg-[#090d12] text-white">
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function PaginationBar({
  page,
  pageSize,
  total,
  totalPagesOverride,
  onPageChange,
}: {
  page: number;
  pageSize: number;
  total: number;
  totalPagesOverride?: number;
  onPageChange: (page: number) => void;
}) {
  const { t } = useLocaleContext();
  const totalPages = totalPagesOverride || Math.max(1, Math.ceil(total / pageSize));
  const disabled = total <= 0;

  function normalizePage(value: string) {
    const text = value.trim();
    if (!text) return null;
    const next = Number(text);
    if (!Number.isFinite(next)) return null;
    return Math.min(Math.max(Math.trunc(next), 1), totalPages);
  }

  function jumpTo(value: string) {
    const next = normalizePage(value);
    if (next !== null) onPageChange(next);
  }

  return (
    <div className="mt-4 flex flex-wrap items-center justify-end gap-2 text-sm text-white/60">
      <button
        type="button"
        disabled={disabled || page <= 1}
        onClick={() => onPageChange(1)}
        className="h-8 rounded-lg border border-white/10 px-3 text-white/75 transition-colors hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-35"
      >
        {t('firstPage', 'asset')}
      </button>
      <button
        type="button"
        disabled={disabled || page <= 1}
        onClick={() => onPageChange(page - 1)}
        className="h-8 rounded-lg border border-white/10 px-3 text-white/75 transition-colors hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-35"
      >
        {t('prevPage', 'asset')}
      </button>
      <span className="px-1 font-mono text-white/70">
        {page} / {totalPages}
      </span>
      <span className="text-white/45">
        {formatMessage(t('totalRecordsWithPageSize', 'asset'), { total, pageSize })}
      </span>
      <input
        key={page}
        type="number"
        min={1}
        max={totalPages}
        defaultValue={page}
        disabled={disabled}
        onKeyDown={(event) => {
          if (event.key === 'Enter') jumpTo(event.currentTarget.value);
        }}
        onBlur={(event) => jumpTo(event.currentTarget.value)}
        className="h-8 w-16 rounded-lg border border-white/10 bg-[#090d12] px-2 text-center font-mono text-white outline-none transition-colors hover:border-white/20 focus:border-white/30 disabled:cursor-not-allowed disabled:opacity-35"
      />
      <button
        type="button"
        disabled={disabled || page >= totalPages}
        onClick={() => onPageChange(page + 1)}
        className="h-8 rounded-lg border border-white/10 px-3 text-white/75 transition-colors hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-35"
      >
        {t('nextPage', 'asset')}
      </button>
      <button
        type="button"
        disabled={disabled || page >= totalPages}
        onClick={() => onPageChange(totalPages)}
        className="h-8 rounded-lg border border-white/10 px-3 text-white/75 transition-colors hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-35"
      >
        {t('lastPage', 'asset')}
      </button>
    </div>
  );
}
