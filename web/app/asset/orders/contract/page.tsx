'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import AssetSidebar from '@/components/asset/AssetSidebar';
import { useLocaleContext } from '@/contexts/LocaleContext';
import {
  getContractOrders,
  getContractTrades,
  type ContractOrderListItem,
  type ContractTradeListItem,
} from '@/lib/api/modules/contract';

const PAGE_SIZE = 10;

type AssetTranslator = (key: string, namespace?: 'asset' | 'contracts') => string;

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

function buildTradeAveragePriceByOrderId(items: ContractTradeListItem[]) {
  const totals = new Map<number, { notional: number; quantity: number }>();
  items.forEach((item) => {
    const price = positiveNumber(item.price);
    const quantity = positiveNumber(item.quantity);
    if (!price || !quantity) return;
    const current = totals.get(item.order_id) || { notional: 0, quantity: 0 };
    current.notional += price * quantity;
    current.quantity += quantity;
    totals.set(item.order_id, current);
  });

  const averages = new Map<number, number>();
  totals.forEach((value, orderId) => {
    if (value.quantity > 0) {
      averages.set(orderId, value.notional / value.quantity);
    }
  });
  return averages;
}

function formatContractOrderPrice(order: ContractOrderListItem, t: AssetTranslator, tradeAvgPrice?: number) {
  const orderType = String(order.order_type || '').toUpperCase();
  if (orderType === 'MARKET') {
    const record = order as ContractOrderListItem & {
      avg_fill_price?: string | number | null;
      filled_avg_price?: string | number | null;
      execution_price?: string | number | null;
      deal_price?: string | number | null;
    };
    const avgPrice =
      positiveNumber(record.avg_fill_price) ||
      positiveNumber(record.filled_avg_price) ||
      positiveNumber(record.execution_price) ||
      positiveNumber(record.deal_price) ||
      positiveNumber(order.avg_price) ||
      tradeAvgPrice ||
      null;
    return avgPrice ? formatNum(avgPrice) : t('market', 'asset');
  }

  const price = positiveNumber(order.price);
  return price ? formatNum(price) : '--';
}

function normalizeText(value: string | number | null | undefined) {
  return String(value || '').trim().toUpperCase();
}

function sideText(value: string, t: AssetTranslator) {
  const normalized = normalizeText(value);
  if (normalized === 'LONG' || normalized === 'BUY') return t('long', 'contracts');
  if (normalized === 'SHORT' || normalized === 'SELL') return t('short', 'contracts');
  return value || '--';
}

function sideClass(value: string) {
  const normalized = normalizeText(value);
  return normalized === 'SHORT' || normalized === 'SELL' ? 'text-[#f6465d]' : 'text-[#00c087]';
}

function actionText(value: string, t: AssetTranslator) {
  const normalized = normalizeText(value);
  if (normalized === 'OPEN') return t('openPosition', 'asset');
  if (normalized === 'CLOSE') return t('closePosition', 'asset');
  return value || '--';
}

function orderTypeText(value: string, t: AssetTranslator) {
  const normalized = normalizeText(value);
  if (normalized === 'LIMIT') return t('limit', 'asset');
  if (normalized === 'MARKET') return t('market', 'asset');
  return value || '--';
}

function statusText(value: string, t: AssetTranslator) {
  const normalized = normalizeText(value);
  const labels: Record<string, string> = {
    OPEN: t('orderOpen', 'asset'),
    PARTIALLY_FILLED: t('partiallyFilled', 'asset'),
    FILLED: t('filled', 'asset'),
    CANCELED: t('canceled', 'asset'),
    CANCELLED: t('canceled', 'asset'),
    REJECTED: t('rejected', 'asset'),
    LIQUIDATED: t('liquidated', 'asset'),
    EXPIRED: t('expired', 'asset'),
  };
  return labels[normalized] || value || '--';
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

function paginateItems<T>(items: T[], page: number) {
  const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const safePage = Math.min(Math.max(page, 1), totalPages);
  const start = (safePage - 1) * PAGE_SIZE;
  return {
    items: items.slice(start, start + PAGE_SIZE),
    page: safePage,
    totalPages,
    total: items.length,
  };
}

export default function AssetContractOrdersPage() {
  const { t } = useLocaleContext();
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [tab, setTab] = useState<'orders' | 'trades'>('orders');
  const [symbolFilter, setSymbolFilter] = useState('ALL');
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [typeFilter, setTypeFilter] = useState('ALL');
  const [sideFilter, setSideFilter] = useState('ALL');
  const [ordersPage, setOrdersPage] = useState(1);
  const [tradesPage, setTradesPage] = useState(1);

  const ordersQuery = useQuery({
    queryKey: ['assetContractOrders'],
    queryFn: () => getContractOrders({ page: 1, page_size: 100 }),
    staleTime: 1000 * 15,
    retry: 0,
  });

  const tradesQuery = useQuery({
    queryKey: ['assetContractTrades'],
    queryFn: () => getContractTrades({ page: 1, page_size: 100 }),
    staleTime: 1000 * 15,
    retry: 0,
  });

  const orders = useMemo(() => ordersQuery.data?.items || [], [ordersQuery.data]);
  const trades = useMemo(() => tradesQuery.data?.items || [], [tradesQuery.data]);
  const tradeAvgPriceByOrderId = useMemo(() => buildTradeAveragePriceByOrderId(trades), [trades]);
  const symbolOptions = useMemo(() => {
    const symbols = new Set<string>();
    orders.forEach((item) => {
      if (item.symbol) symbols.add(item.symbol);
    });
    trades.forEach((item) => {
      if (item.symbol) symbols.add(item.symbol);
    });
    return Array.from(symbols).sort();
  }, [orders, trades]);
  const filteredOrders = useMemo(() => orders.filter((item) => {
    if (symbolFilter !== 'ALL' && item.symbol !== symbolFilter) return false;
    const orderStatus = normalizeText(item.status);
    if (statusFilter !== 'ALL' && orderStatus !== statusFilter) {
      if (!(statusFilter === 'CANCELED' && orderStatus === 'CANCELLED')) return false;
    }
    if (typeFilter !== 'ALL' && normalizeText(item.order_type) !== typeFilter) return false;
    if (sideFilter !== 'ALL' && normalizeText(item.position_side || item.side) !== sideFilter) return false;
    return true;
  }), [orders, sideFilter, statusFilter, symbolFilter, typeFilter]);
  const filteredTrades = useMemo(() => trades.filter((item) => {
    if (symbolFilter !== 'ALL' && item.symbol !== symbolFilter) return false;
    if (sideFilter !== 'ALL' && normalizeText(item.position_side) !== sideFilter) return false;
    return true;
  }), [sideFilter, symbolFilter, trades]);
  const orderPageData = useMemo(() => paginateItems(filteredOrders, ordersPage), [filteredOrders, ordersPage]);
  const tradePageData = useMemo(() => paginateItems(filteredTrades, tradesPage), [filteredTrades, tradesPage]);

  function resetPages() {
    setOrdersPage(1);
    setTradesPage(1);
  }

  function switchTab(nextTab: 'orders' | 'trades') {
    setTab(nextTab);
    resetPages();
  }

  return (
    <main className="min-h-screen py-8 flex tabular-nums bg-[#090d12]">
      <AssetSidebar
        isCollapsed={isSidebarCollapsed}
        onToggle={() => setIsSidebarCollapsed((value) => !value)}
      />

      <div className="lg:w-4/5 w-full px-4">
        <div className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h1 className="text-2xl font-bold text-white">{t('contractOrders', 'asset')}</h1>
            <p className="mt-2 text-sm text-white/55">{t('contractOrdersDesc', 'asset')}</p>
          </div>
          <Link
            href="/contract"
            className="flex h-9 items-center rounded-lg border border-white/10 px-3 text-sm text-white/80 hover:bg-white/[0.06]"
          >
            {t('goContractTrade', 'asset')}
          </Link>
        </div>

        <section className="rounded-xl border border-white/10 bg-[#0e1117] p-5 shadow-xl">
          <div className="mb-4 flex gap-2">
            {[
              ['orders', t('contractOrders', 'asset')],
              ['trades', t('contractTrades', 'asset')],
            ].map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => switchTab(key as typeof tab)}
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
              label={t('contract', 'asset')}
              value={symbolFilter}
              onChange={(value) => {
                setSymbolFilter(value);
                resetPages();
              }}
              options={[
                { value: 'ALL', label: t('allContracts', 'asset') },
                ...symbolOptions.map((symbol) => ({ value: symbol, label: symbol })),
              ]}
            />
            <FilterSelect
              label={t('side', 'asset')}
              value={sideFilter}
              onChange={(value) => {
                setSideFilter(value);
                resetPages();
              }}
              options={[
                { value: 'ALL', label: t('allSides', 'asset') },
                { value: 'LONG', label: t('long', 'contracts') },
                { value: 'SHORT', label: t('short', 'contracts') },
              ]}
            />
            {tab === 'orders' ? (
              <>
                <FilterSelect
                  label={t('status', 'asset')}
                  value={statusFilter}
                  onChange={(value) => {
                    setStatusFilter(value);
                    resetPages();
                  }}
                  options={[
                    { value: 'ALL', label: t('allStatuses', 'asset') },
                    { value: 'OPEN', label: t('orderOpen', 'asset') },
                    { value: 'PARTIALLY_FILLED', label: t('partiallyFilled', 'asset') },
                    { value: 'FILLED', label: t('filled', 'asset') },
                    { value: 'CANCELED', label: t('canceled', 'asset') },
                    { value: 'REJECTED', label: t('rejected', 'asset') },
                  ]}
                />
                <FilterSelect
                  label={t('type', 'asset')}
                  value={typeFilter}
                  onChange={(value) => {
                    setTypeFilter(value);
                    resetPages();
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

          {tab === 'orders' ? (
            <ContractOrdersTable
              items={orderPageData.items}
              tradeAvgPriceByOrderId={tradeAvgPriceByOrderId}
              page={orderPageData.page}
              totalPages={orderPageData.totalPages}
              total={orderPageData.total}
              onPageChange={setOrdersPage}
              loading={ordersQuery.isLoading}
              error={ordersQuery.isError}
            />
          ) : (
            <ContractTradesTable
              items={tradePageData.items}
              page={tradePageData.page}
              totalPages={tradePageData.totalPages}
              total={tradePageData.total}
              onPageChange={setTradesPage}
              loading={tradesQuery.isLoading}
              error={tradesQuery.isError}
            />
          )}
        </section>
      </div>
    </main>
  );
}

function ContractOrdersTable({
  items,
  tradeAvgPriceByOrderId,
  page,
  totalPages,
  total,
  onPageChange,
  loading,
  error,
}: {
  items: ContractOrderListItem[];
  tradeAvgPriceByOrderId: Map<number, number>;
  page: number;
  totalPages: number;
  total: number;
  onPageChange: (page: number) => void;
  loading?: boolean;
  error?: boolean;
}) {
  const { t } = useLocaleContext();

  if (loading) return <div className="py-12 text-center text-white/55">{t('loadingContractOrders', 'asset')}</div>;
  if (error) return <div className="py-12 text-center text-[#f6465d]">{t('contractOrdersLoadFailed', 'asset')}</div>;
  if (items.length === 0) {
    return (
      <>
        <div className="py-12 text-center text-white/45">{t('noRecords', 'asset')}</div>
        <PaginationBar page={page} pageSize={PAGE_SIZE} total={total} onPageChange={onPageChange} />
      </>
    );
  }

  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[940px]">
          <thead>
            <tr className="border-b border-white/10 text-sm text-white/45">
              <th className="py-3 text-left font-medium">{t('contract', 'asset')}</th>
              <th className="py-3 text-left font-medium">{t('side', 'asset')}</th>
              <th className="py-3 text-left font-medium">{t('type', 'asset')}</th>
              <th className="py-3 text-right font-medium">{t('price', 'asset')}</th>
              <th className="py-3 text-right font-medium">{t('quantity', 'asset')}</th>
              <th className="py-3 text-right font-medium">{t('leverage', 'asset')}</th>
              <th className="py-3 text-right font-medium">{t('status', 'asset')}</th>
              <th className="py-3 text-right font-medium">{t('time', 'asset')}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id} className="border-b border-white/5 text-sm last:border-0">
                <td className="py-3 text-white">{item.symbol}</td>
                <td className={`py-3 font-medium ${sideClass(item.position_side)}`}>{sideText(item.position_side, t)}</td>
                <td className="py-3 text-white/70">{actionText(item.action, t)} / {orderTypeText(item.order_type, t)}</td>
                <td className="py-3 text-right font-mono text-white">{formatContractOrderPrice(item, t, tradeAvgPriceByOrderId.get(item.id))}</td>
                <td className="py-3 text-right font-mono text-white">{formatNum(item.quantity)}</td>
                <td className="py-3 text-right font-mono text-white/70">{item.leverage}x</td>
                <td className="py-3 text-right text-white/70">{statusText(item.status, t)}</td>
                <td className="py-3 text-right text-white/55">{formatDateTime(item.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <PaginationBar page={page} pageSize={PAGE_SIZE} total={total} onPageChange={onPageChange} totalPagesOverride={totalPages} />
    </>
  );
}

function ContractTradesTable({
  items,
  page,
  totalPages,
  total,
  onPageChange,
  loading,
  error,
}: {
  items: ContractTradeListItem[];
  page: number;
  totalPages: number;
  total: number;
  onPageChange: (page: number) => void;
  loading?: boolean;
  error?: boolean;
}) {
  const { t } = useLocaleContext();

  if (loading) return <div className="py-12 text-center text-white/55">{t('loadingContractTrades', 'asset')}</div>;
  if (error) return <div className="py-12 text-center text-[#f6465d]">{t('contractTradesLoadFailed', 'asset')}</div>;
  if (items.length === 0) {
    return (
      <>
        <div className="py-12 text-center text-white/45">{t('noRecords', 'asset')}</div>
        <PaginationBar page={page} pageSize={PAGE_SIZE} total={total} onPageChange={onPageChange} />
      </>
    );
  }

  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[1040px]">
          <thead>
            <tr className="border-b border-white/10 text-sm text-white/45">
              <th className="py-3 text-left font-medium">{t('contract', 'asset')}</th>
              <th className="py-3 text-left font-medium">{t('side', 'asset')}</th>
              <th className="py-3 text-left font-medium">{t('openClose', 'asset')}</th>
              <th className="py-3 text-right font-medium">{t('price', 'asset')}</th>
              <th className="py-3 text-right font-medium">{t('quantity', 'asset')}</th>
              <th className="py-3 text-right font-medium" title={t('spreadCostHelp', 'contracts')}>{t('spreadCost', 'asset')}</th>
              <th className="py-3 text-right font-medium">{t('realizedPnl', 'asset')}</th>
              <th className="py-3 text-right font-medium">{t('time', 'asset')}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => {
              const pnl = Number(item.realized_pnl);
              return (
                <tr key={item.id} className="border-b border-white/5 text-sm last:border-0">
                  <td className="py-3 text-white">{item.symbol}</td>
                  <td className={`py-3 font-medium ${sideClass(item.position_side)}`}>{sideText(item.position_side, t)}</td>
                  <td className="py-3 text-white/70">{actionText(item.action, t)}</td>
                  <td className="py-3 text-right font-mono text-white">{formatNum(item.price)}</td>
                  <td className="py-3 text-right font-mono text-white">{formatNum(item.quantity)}</td>
                  <td className="py-3 text-right font-mono text-white/70" title={t('spreadCostHelp', 'contracts')}>{formatNum(item.spread_fee ?? item.fee_amount, 6)}</td>
                  <td className={`py-3 text-right font-mono ${pnl > 0 ? 'text-[#00c087]' : pnl < 0 ? 'text-[#f6465d]' : 'text-white/70'}`}>
                    {formatNum(item.realized_pnl)}
                  </td>
                  <td className="py-3 text-right text-white/55">{formatDateTime(item.created_at)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <PaginationBar page={page} pageSize={PAGE_SIZE} total={total} onPageChange={onPageChange} totalPagesOverride={totalPages} />
    </>
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
