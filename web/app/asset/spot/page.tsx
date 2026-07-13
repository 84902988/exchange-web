'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import AssetSidebar from '@/components/asset/AssetSidebar';
import AssetTransferModal from '@/components/asset/AssetTransferModal';
import { useLocaleContext } from '@/contexts/LocaleContext';
import { useAuth } from '@/lib/authContext';
import { privateQueryKey } from '@/lib/authPrivateQueries';
import AssetsAPI, { type AccountBalanceItem } from '@/lib/api/modules/assets';

type SpotRow = {
  symbol: string;
  available: number;
  frozen: number;
  total: number;
};

function safeNum(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const normalized = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(normalized) ? normalized : 0;
}

function precisionForSymbol(symbol: string) {
  const normalized = symbol.toUpperCase();
  if (normalized === 'USDT') return 2;
  if (normalized === 'BTC' || normalized === 'ETH') return 6;
  return 4;
}

function formatAssetAmount(value: string | number | null | undefined, symbol: string): string {
  const num = safeNum(value);
  if (num === 0) return '0';

  return num
    .toLocaleString('en-US', {
      minimumFractionDigits: 0,
      maximumFractionDigits: precisionForSymbol(symbol),
    })
    .replace(/(\.\d*?)0+$/, '$1')
    .replace(/\.$/, '');
}

function buildSpotRows(rows: AccountBalanceItem[]): SpotRow[] {
  const grouped = new Map<string, SpotRow>();

  for (const row of rows) {
    if (String(row.account_key || '').toLowerCase() !== 'spot') continue;
    const symbol = String(row.symbol || '').toUpperCase();
    if (!symbol) continue;

    const current = grouped.get(symbol) || {
      symbol,
      available: 0,
      frozen: 0,
      total: 0,
    };
    current.available += safeNum(row.available);
    current.frozen += safeNum(row.frozen);
    current.total = current.available + current.frozen;
    grouped.set(symbol, current);
  }

  return Array.from(grouped.values())
    .filter((row) => row.total > 0)
    .sort((a, b) => {
      if (a.symbol === 'USDT') return -1;
      if (b.symbol === 'USDT') return 1;
      return a.symbol.localeCompare(b.symbol);
    });
}

function tradeHref(symbol: string) {
  const normalized = symbol.toUpperCase();
  if (normalized === 'USDT') return '/trade/spot?symbol=BTCUSDT';
  return `/trade/spot?symbol=${encodeURIComponent(`${normalized}USDT`)}`;
}

export default function AssetSpotPage() {
  const { t } = useLocaleContext();
  const { userIdentityKey } = useAuth();
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [transferCoin, setTransferCoin] = useState('USDT');
  const [transferOpen, setTransferOpen] = useState(false);

  const balancesQuery = useQuery({
    queryKey: privateQueryKey(userIdentityKey, 'assetSpotBalances'),
    queryFn: () => AssetsAPI.getAccountBalances(),
    enabled: userIdentityKey !== null,
    staleTime: 1000 * 30,
    retry: 0,
  });

  const rows = useMemo(() => buildSpotRows(balancesQuery.data || []), [balancesQuery.data]);

  const openTransfer = (symbol: string) => {
    setTransferCoin(symbol);
    setTransferOpen(true);
  };

  return (
    <main className="min-h-screen overflow-y-auto bg-[#090d12] py-8 flex">
      <AssetSidebar
        isCollapsed={isSidebarCollapsed}
        onToggle={() => setIsSidebarCollapsed((value) => !value)}
      />

      <div className="lg:w-4/5 w-full px-4">
        <div className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h1 className="text-2xl font-bold text-white">{t('spotAccount', 'asset')}</h1>
            <p className="mt-2 text-sm text-white/55">
              {t('spotAccountDesc', 'asset')}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => openTransfer('USDT')}
              className="h-10 rounded-lg bg-[#f0b90b] px-5 text-sm font-semibold text-black hover:bg-[#f8d12f]"
            >
              {t('transfer', 'asset')}
            </button>
            <Link
              href="/trade/spot"
              className="flex h-10 items-center rounded-lg border border-white/10 px-5 text-sm font-semibold text-white/80 hover:bg-white/[0.06]"
            >
              {t('goSpotTrade', 'asset')}
            </Link>
          </div>
        </div>

        {balancesQuery.isError ? (
          <div className="mb-6 rounded-lg border border-[#f6465d]/25 bg-[#f6465d]/10 px-4 py-3 text-sm text-[#f6465d]">
            {t('assetDataLoadFailed', 'asset')}
          </div>
        ) : null}

        <section className="rounded-xl border border-white/10 bg-[#0e1117] p-5 shadow-xl">
          <div className="mb-4">
            <h2 className="text-lg font-semibold text-white">{t('spotAssets', 'asset')}</h2>
            <p className="mt-1 text-sm text-white/45">
              {t('spotAssetsDesc', 'asset')}
            </p>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px]">
              <thead>
                <tr className="border-b border-white/10 text-sm text-white/45">
                  <th className="py-3 text-left font-medium">{t('coin', 'asset')}</th>
                  <th className="py-3 text-right font-medium">{t('available', 'asset')}</th>
                  <th className="py-3 text-right font-medium">{t('frozen', 'asset')}</th>
                  <th className="py-3 text-right font-medium">{t('total', 'asset')}</th>
                  <th className="py-3 text-right font-medium">{t('action', 'asset')}</th>
                </tr>
              </thead>
              <tbody>
                {balancesQuery.isLoading ? (
                  Array.from({ length: 4 }).map((_, index) => (
                    <tr key={index} className="border-b border-white/5">
                      <td className="py-4"><div className="h-4 w-16 animate-pulse rounded bg-white/10" /></td>
                      <td className="py-4"><div className="ml-auto h-4 w-24 animate-pulse rounded bg-white/10" /></td>
                      <td className="py-4"><div className="ml-auto h-4 w-24 animate-pulse rounded bg-white/10" /></td>
                      <td className="py-4"><div className="ml-auto h-4 w-24 animate-pulse rounded bg-white/10" /></td>
                      <td className="py-4"><div className="ml-auto h-7 w-48 animate-pulse rounded bg-white/10" /></td>
                    </tr>
                  ))
                ) : rows.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-10 text-center text-sm text-white/45">
                      {t('noSpotAssets', 'asset')}
                    </td>
                  </tr>
                ) : (
                  rows.map((row) => (
                    <tr key={row.symbol} className="border-b border-white/5 text-sm last:border-0">
                      <td className="py-3 font-medium text-white">{row.symbol}</td>
                      <td className="py-3 text-right tabular-nums text-white">
                        {formatAssetAmount(row.available, row.symbol)}
                      </td>
                      <td className="py-3 text-right tabular-nums text-white/70">
                        {formatAssetAmount(row.frozen, row.symbol)}
                      </td>
                      <td className="py-3 text-right tabular-nums text-white">
                        {formatAssetAmount(row.total, row.symbol)}
                      </td>
                      <td className="py-3">
                        <div className="flex flex-wrap justify-end gap-1.5">
                          <ActionLink href={`/asset/deposit?coin=${encodeURIComponent(row.symbol)}`}>
                            {t('recharge', 'asset')}
                          </ActionLink>
                          <ActionLink href={`/asset/withdraw?coin=${encodeURIComponent(row.symbol)}`}>
                            {t('withdraw', 'asset')}
                          </ActionLink>
                          <ActionButton onClick={() => openTransfer(row.symbol)}>{t('transfer', 'asset')}</ActionButton>
                          <ActionLink href={tradeHref(row.symbol)}>{t('goTrade', 'asset')}</ActionLink>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <AssetTransferModal
        open={transferOpen}
        onClose={() => setTransferOpen(false)}
        defaultFrom="funding"
        defaultTo="spot"
        defaultCoin={transferCoin}
        onSuccess={async () => {
          await balancesQuery.refetch();
        }}
      />
    </main>
  );
}

function ActionLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex h-7 items-center rounded-md border border-white/10 px-2.5 text-xs font-medium text-white/70 hover:bg-white/[0.06] hover:text-white"
    >
      {children}
    </Link>
  );
}

function ActionButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-7 items-center rounded-md border border-white/10 px-2.5 text-xs font-medium text-white/70 hover:bg-white/[0.06] hover:text-white"
    >
      {children}
    </button>
  );
}
