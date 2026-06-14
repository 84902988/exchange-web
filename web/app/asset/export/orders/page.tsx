'use client';

import { useState } from 'react';

import AssetSidebar from '@/components/asset/AssetSidebar';
import { useLocaleContext } from '@/contexts/LocaleContext';

export default function AssetOrderExportPage() {
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const { t } = useLocaleContext();

  return (
    <main className="min-h-screen py-8 flex bg-[#090d12]">
      <AssetSidebar
        isCollapsed={isSidebarCollapsed}
        onToggle={() => setIsSidebarCollapsed((value) => !value)}
      />
      <div className="lg:w-4/5 w-full px-4">
        <h1 className="text-2xl font-bold text-white">{t('assetExportOrdersTitle', 'asset')}</h1>
        <div className="mt-6 rounded-xl border border-white/10 bg-[#0e1117] p-10 text-center">
          <div className="text-lg font-semibold text-white">{t('assetExportNoData', 'asset')}</div>
          <p className="mt-2 text-sm text-white/50">{t('assetExportArchivePending', 'asset')}</p>
        </div>
      </div>
    </main>
  );
}
