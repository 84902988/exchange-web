'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import AssetSidebar from '@/components/asset/AssetSidebar';
import AssetTransferModal from '@/components/asset/AssetTransferModal';
import { useLocaleContext } from '@/contexts/LocaleContext';
import { useAuth } from '@/lib/authContext';
import { privateQueryKey } from '@/lib/authPrivateQueries';
import {
  getContractAccountSummary,
  getContractPositions,
  type ContractAccountSummary,
  type ContractPositionItem,
} from '@/lib/api/modules/contract';

const zeroAccount: ContractAccountSummary = {
  user_id: 0,
  margin_asset: 'USDT',
  available_margin: '0',
  used_margin: '0',
  frozen_margin: '0',
  position_margin: '0',
  realized_pnl: '0',
  unrealized_pnl: '0',
  equity: '0',
};

function safeNum(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const normalized = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(normalized) ? normalized : 0;
}

function formatAmount(value: string | number | null | undefined): string {
  return safeNum(value).toLocaleString('en-US', {
    maximumFractionDigits: 8,
  });
}

function formatPrice(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '--';
  return safeNum(value).toLocaleString('en-US', {
    maximumFractionDigits: 8,
  });
}

function displayContractSymbol(symbol: string, t: (key: string, namespace?: 'contracts') => string) {
  const marketSymbol = String(symbol || '').replace(/_PERP$/i, '');
  return marketSymbol ? `${marketSymbol} ${t('perpetual', 'contracts')}` : '--';
}

function sideLabel(side: string, t: (key: string, namespace?: 'contracts') => string) {
  const normalized = String(side || '').toUpperCase();
  if (normalized === 'LONG') return t('long', 'contracts');
  if (normalized === 'SHORT') return t('short', 'contracts');
  return side || '--';
}

function sideClass(side: string) {
  return String(side || '').toUpperCase() === 'SHORT'
    ? 'bg-[#f6465d]/10 text-[#f6465d]'
    : 'bg-[#00c087]/10 text-[#00c087]';
}

export default function AssetContractPage() {
  const { t } = useLocaleContext();
  const { userIdentityKey } = useAuth();
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);

  const contractAccountQuery = useQuery({
    queryKey: privateQueryKey(userIdentityKey, 'assetContractDetail'),
    queryFn: () => getContractAccountSummary(),
    enabled: userIdentityKey !== null,
    staleTime: 1000 * 15,
    retry: 0,
  });

  const positionsQuery = useQuery({
    queryKey: privateQueryKey(userIdentityKey, 'assetContractPositions'),
    queryFn: () => getContractPositions({ status: 'OPEN' }),
    enabled: userIdentityKey !== null,
    staleTime: 1000 * 10,
    retry: 0,
  });

  const account = contractAccountQuery.data || zeroAccount;
  const realizedPnl = safeNum(account.realized_pnl);
  const positions = useMemo(() => positionsQuery.data?.items || [], [positionsQuery.data]);

  return (
    <main className="min-h-screen overflow-y-auto bg-[#090d12] py-8 flex">
      <AssetSidebar
        isCollapsed={isSidebarCollapsed}
        onToggle={() => setIsSidebarCollapsed((value) => !value)}
      />

      <div className="lg:w-4/5 w-full px-4">
        <div className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h1 className="text-2xl font-bold text-white">{t('contractAccount', 'asset')}</h1>
            <p className="mt-2 text-sm text-white/55">
              {t('contractAccountDesc', 'asset')}
            </p>
            {contractAccountQuery.isError ? (
              <p className="mt-2 text-xs text-white/40">{t('noContractAssets', 'asset')}</p>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setTransferOpen(true)}
              className="h-10 rounded-lg bg-[#f0b90b] px-5 text-sm font-semibold text-black hover:bg-[#f8d12f]"
            >
              {t('transfer', 'asset')}
            </button>
            <Link
              href="/contract"
              className="flex h-10 items-center rounded-lg border border-white/10 px-5 text-sm font-semibold text-white/80 hover:bg-white/[0.06]"
            >
              {t('goContractTrade', 'asset')}
            </Link>
          </div>
        </div>

        {contractAccountQuery.isError ? (
          <div className="mb-6 rounded-lg border border-white/10 bg-[#0e1117] px-4 py-3 text-sm text-white/55">
            {t('contractAccountUnavailable', 'asset')}
          </div>
        ) : null}

        <section className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          <MetricCard
            label={t('availableMargin', 'asset')}
            value={`${formatAmount(account.available_margin)} USDT`}
            loading={contractAccountQuery.isLoading}
          />
          <MetricCard
            label={t('positionMargin', 'asset')}
            value={`${formatAmount(account.position_margin || account.used_margin)} USDT`}
            loading={contractAccountQuery.isLoading}
          />
          <MetricCard
            label={t('frozenMargin', 'asset')}
            value={`${formatAmount(account.frozen_margin)} USDT`}
            loading={contractAccountQuery.isLoading}
          />
          <MetricCard
            label={t('accountEquity', 'asset')}
            value={`${formatAmount(account.equity)} USDT`}
            loading={contractAccountQuery.isLoading}
          />
          <MetricCard
            label={t('realizedPnl', 'asset')}
            value={`${formatAmount(account.realized_pnl)} USDT`}
            tone={realizedPnl > 0 ? 'positive' : realizedPnl < 0 ? 'negative' : 'muted'}
            loading={contractAccountQuery.isLoading}
          />
        </section>

        <PositionsSection
          positions={positions}
          loading={positionsQuery.isLoading}
          error={positionsQuery.isError}
          onRefresh={() => void positionsQuery.refetch()}
        />
      </div>

      <AssetTransferModal
        open={transferOpen}
        onClose={() => setTransferOpen(false)}
        defaultFrom="funding"
        defaultTo="contract"
        defaultCoin="USDT"
        onSuccess={async () => {
          await Promise.all([contractAccountQuery.refetch(), positionsQuery.refetch()]);
        }}
      />
    </main>
  );
}

function MetricCard({
  label,
  value,
  tone = 'muted',
  loading,
}: {
  label: string;
  value: string;
  tone?: 'positive' | 'negative' | 'muted';
  loading?: boolean;
}) {
  const valueClass =
    tone === 'positive' ? 'text-[#00c087]' : tone === 'negative' ? 'text-[#f6465d]' : 'text-white';

  return (
    <div className="rounded-xl border border-white/10 bg-[#0e1117] p-5 shadow-xl">
      <div className="text-sm text-white/45">{label}</div>
      <div className={`mt-3 text-2xl font-semibold tabular-nums ${valueClass}`}>
        {loading ? '...' : value}
      </div>
    </div>
  );
}

function PositionsSection({
  positions,
  loading,
  error,
  onRefresh,
}: {
  positions: ContractPositionItem[];
  loading?: boolean;
  error?: boolean;
  onRefresh: () => void;
}) {
  const { t } = useLocaleContext();

  return (
    <section className="rounded-xl border border-white/10 bg-[#0e1117] p-5 shadow-xl">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-white">{t('currentPositions', 'asset')}</h2>
          <p className="mt-1 text-sm text-white/45">{t('currentPositionsDesc', 'asset')}</p>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-white/70 hover:bg-white/[0.06]"
        >
          {t('reload', 'asset')}
        </button>
      </div>

      {error ? (
        <div className="mb-4 rounded-lg border border-[#f6465d]/25 bg-[#f6465d]/10 px-3 py-2 text-sm text-[#f6465d]">
          {t('positionsLoadFailed', 'asset')}
        </div>
      ) : null}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[980px]">
          <thead>
            <tr className="border-b border-white/10 text-sm text-white/45">
              <th className="py-3 text-left font-medium">{t('contract', 'contracts')}</th>
              <th className="py-3 text-left font-medium">{t('direction', 'asset')}</th>
              <th className="py-3 text-right font-medium">{t('quantity', 'asset')}</th>
              <th className="py-3 text-right font-medium">{t('entryPrice', 'asset')}</th>
              <th className="py-3 text-right font-medium">{t('markPrice', 'asset')}</th>
              <th className="py-3 text-right font-medium">{t('unrealizedPnl', 'asset')}</th>
              <th className="py-3 text-right font-medium">{t('liquidationPrice', 'asset')}</th>
              <th className="py-3 text-right font-medium">{t('leverage', 'contracts')}</th>
              <th className="py-3 text-right font-medium">{t('action', 'asset')}</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              Array.from({ length: 3 }).map((_, index) => (
                <tr key={index} className="border-b border-white/5">
                  {Array.from({ length: 9 }).map((__, cellIndex) => (
                    <td key={cellIndex} className="py-4">
                      <div className="ml-auto h-4 w-20 animate-pulse rounded bg-white/10 first:ml-0" />
                    </td>
                  ))}
                </tr>
              ))
            ) : positions.length === 0 ? (
              <tr>
                <td colSpan={9} className="py-10 text-center text-sm text-white/45">
                  {t('noOpenPositions', 'asset')}
                </td>
              </tr>
            ) : (
              positions.map((position) => {
                const pnl = safeNum(position.unrealized_pnl);
                return (
                  <tr key={position.id} className="border-b border-white/5 text-sm last:border-0">
                    <td className="py-3 font-medium text-white">
                      {displayContractSymbol(position.symbol, t)}
                    </td>
                    <td className="py-3">
                      <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${sideClass(position.side)}`}>
                        {sideLabel(position.side, t)}
                      </span>
                    </td>
                    <td className="py-3 text-right tabular-nums text-white">
                      {formatAmount(position.quantity)}
                    </td>
                    <td className="py-3 text-right tabular-nums text-white/70">
                      {formatPrice(position.entry_price)}
                    </td>
                    <td className="py-3 text-right tabular-nums text-white/70">
                      {formatPrice(position.mark_price)}
                    </td>
                    <td
                      className={`py-3 text-right tabular-nums ${
                        pnl > 0 ? 'text-[#00c087]' : pnl < 0 ? 'text-[#f6465d]' : 'text-white/70'
                      }`}
                    >
                      {formatAmount(position.unrealized_pnl)}
                    </td>
                    <td className="py-3 text-right tabular-nums text-white/70">
                      {formatPrice(position.liquidation_price)}
                    </td>
                    <td className="py-3 text-right tabular-nums text-white">
                      {position.leverage}x
                    </td>
                    <td className="py-3 text-right">
                      <Link
                        href="/contract"
                        className="inline-flex rounded-lg border border-white/10 px-3 py-1.5 text-xs font-semibold text-white/80 hover:bg-white/[0.06]"
                      >
                        {t('closePosition', 'contracts')}
                      </Link>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
