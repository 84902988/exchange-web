'use client';

import Image from 'next/image';
import { useMemo, useState } from 'react';
import AssetPagination from './AssetPagination';
import AssetTable, { AssetItem } from './AssetTable';
import { useLocaleContext } from '@/contexts/LocaleContext';
import { Language } from '@/types';

interface AssetListProps {
  assets: AssetItem[];
  isLoading?: boolean;
  onRecharge?: (symbol: string) => void;
  onWithdraw?: (symbol: string) => void;
  onTrade?: (symbol: string) => void;
  onSearch?: (keyword: string) => void;
  searchKeyword?: string;
  currentLanguage: Language;
}

export default function AssetList({
  assets,
  isLoading = false,
  onRecharge,
  onWithdraw,
  onTrade,
  onSearch,
  searchKeyword = '',
  currentLanguage,
}: AssetListProps) {
  const { t } = useLocaleContext();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const totalPages = Math.max(1, Math.ceil(assets.length / pageSize));
  const safePage = Math.min(Math.max(page, 1), totalPages);
  const pagedAssets = useMemo(
    () => assets.slice((safePage - 1) * pageSize, safePage * pageSize),
    [assets, pageSize, safePage],
  );

  function handleSearchChange(value: string) {
    setPage(1);
    onSearch?.(value);
  }

  function handlePageSizeChange(value: number) {
    setPageSize(value);
    setPage(1);
  }

  return (
    <div className="rounded-xl border border-white/10 bg-[#0e1117] p-5 shadow-xl">
      <div className="mb-5 flex flex-col items-start justify-between gap-4 md:flex-row md:items-center">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold text-white">
            {t('assetList', 'asset')}
          </h2>
          <div className="relative w-full md:w-64">
            <input
              type="text"
              placeholder={t('search', 'asset')}
              className="w-full rounded-lg border border-white/10 bg-[#1a1f2e] px-4 py-2 pr-10 text-white placeholder-white/50 transition-all duration-300 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-amber-500"
              value={searchKeyword}
              onChange={(event) => handleSearchChange(event.target.value)}
              disabled={isLoading}
            />
            <div className="absolute right-3 top-1/2 -translate-y-1/2 text-white/50">
              <Image
                src="/icons/header-search-1.svg"
                alt={t('search', 'asset')}
                width={13}
                height={13}
                className="object-contain"
              />
            </div>
          </div>
        </div>
      </div>

      <AssetTable
        data={pagedAssets}
        isLoading={isLoading}
        onRecharge={onRecharge}
        onWithdraw={onWithdraw}
        onTrade={onTrade}
        currentLanguage={currentLanguage}
      />

      {!isLoading ? (
        <AssetPagination
          page={safePage}
          pageSize={pageSize}
          total={assets.length}
          onPageChange={setPage}
          onPageSizeChange={handlePageSizeChange}
        />
      ) : null}
    </div>
  );
}
