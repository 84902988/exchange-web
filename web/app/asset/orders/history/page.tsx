'use client';

import Link from 'next/link';
import { useState } from 'react';

import AssetSidebar from '@/components/asset/AssetSidebar';
import { useLocaleContext } from '@/contexts/LocaleContext';

export default function AssetOrderHistoryPage() {
  const { t } = useLocaleContext();
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);

  return (
    <main className="min-h-screen py-8 flex bg-[#090d12]">
      <AssetSidebar
        isCollapsed={isSidebarCollapsed}
        onToggle={() => setIsSidebarCollapsed((value) => !value)}
      />

      <div className="lg:w-4/5 w-full px-4">
        <h1 className="text-2xl font-bold text-white">{t('historyOrders', 'asset')}</h1>
        <p className="mt-2 text-sm text-white/55">{t('orderHistorySelectTypeDesc', 'asset')}</p>

        <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2">
          <EntryCard
            title={t('spotOrders', 'asset')}
            description={t('spotOrdersDesc', 'asset')}
            href="/asset/orders/spot"
            actionLabel={t('viewDetails', 'user')}
          />
          <EntryCard
            title={t('contractOrders', 'asset')}
            description={t('contractOrdersDesc', 'asset')}
            href="/asset/orders/contract"
            actionLabel={t('viewDetails', 'user')}
          />
        </div>
      </div>
    </main>
  );
}

function EntryCard({
  title,
  description,
  href,
  actionLabel,
}: {
  title: string;
  description: string;
  href: string;
  actionLabel: string;
}) {
  return (
    <Link
      href={href}
      className="rounded-xl border border-white/10 bg-[#0e1117] p-5 shadow-xl transition-colors hover:border-white/20"
    >
      <div className="text-lg font-semibold text-white">{title}</div>
      <p className="mt-2 text-sm text-white/50">{description}</p>
      <div className="mt-5 text-sm font-semibold text-[#f0b90b]">{actionLabel}</div>
    </Link>
  );
}
