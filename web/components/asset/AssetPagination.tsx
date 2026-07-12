'use client';

import { useState } from 'react';

import { useLocaleContext } from '@/contexts/LocaleContext';

type AssetPaginationProps = {
  page: number;
  pageSize: number;
  total: number;
  pageSizeOptions?: number[];
  onPageChange: (page: number) => void;
  onPageSizeChange?: (pageSize: number) => void;
};

function clampPage(value: number, totalPages: number) {
  if (!Number.isFinite(value)) return 1;
  return Math.min(Math.max(Math.trunc(value), 1), totalPages);
}

export default function AssetPagination({
  page,
  pageSize,
  total,
  pageSizeOptions = [10, 20, 50],
  onPageChange,
  onPageSizeChange,
}: AssetPaginationProps) {
  const { t } = useLocaleContext();
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = clampPage(page, totalPages);
  const [draftPage, setDraftPage] = useState('');

  function jumpToDraftPage() {
    const nextPage = clampPage(Number(draftPage), totalPages);
    onPageChange(nextPage);
    setDraftPage('');
  }

  function handlePageSizeChange(value: string) {
    const nextPageSize = Number(value);
    if (!Number.isFinite(nextPageSize) || nextPageSize <= 0) return;
    onPageSizeChange?.(nextPageSize);
  }

  return (
    <div className="mt-4 flex flex-col gap-3 border-t border-white/10 pt-4 text-[12px] tabular-nums text-white/55 xl:flex-row xl:items-center xl:justify-between">
      <div className="font-medium text-white/55">
        {t('totalRecordsPrefix', 'asset')} {total} {t('totalRecordsSuffix', 'asset')}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={safePage <= 1}
          onClick={() => onPageChange(1)}
          className="h-8 rounded-lg border border-white/10 px-3 text-white/75 transition hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-35"
        >
          {t('firstPage', 'asset')}
        </button>
        <button
          type="button"
          disabled={safePage <= 1}
          onClick={() => onPageChange(Math.max(1, safePage - 1))}
          className="h-8 rounded-lg border border-white/10 px-3 text-white/75 transition hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-35"
        >
          {t('prevPage', 'asset')}
        </button>
        <span className="min-w-24 text-center font-medium text-white/65">
          {t('pagePrefix', 'asset')} {safePage} / {totalPages} {t('pageSuffix', 'asset')}
        </span>
        <button
          type="button"
          disabled={safePage >= totalPages}
          onClick={() => onPageChange(Math.min(totalPages, safePage + 1))}
          className="h-8 rounded-lg border border-white/10 px-3 text-white/75 transition hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-35"
        >
          {t('nextPage', 'asset')}
        </button>
        <button
          type="button"
          disabled={safePage >= totalPages}
          onClick={() => onPageChange(totalPages)}
          className="h-8 rounded-lg border border-white/10 px-3 text-white/75 transition hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-35"
        >
          {t('lastPage', 'asset')}
        </button>
        <label className="flex h-8 items-center gap-2 rounded-lg border border-white/10 bg-[#1a1f2e] px-2">
          <span className="shrink-0 text-white/45">{t('jumpTo', 'asset')}</span>
          <input
            value={draftPage}
            onChange={(event) => setDraftPage(event.target.value.replace(/[^\d]/g, ''))}
            onKeyDown={(event) => {
              if (event.key === 'Enter') jumpToDraftPage();
            }}
            inputMode="numeric"
            className="h-full w-12 bg-transparent text-center font-medium tabular-nums text-white outline-none"
          />
          <span className="shrink-0 text-white/45">{t('pageUnit', 'asset')}</span>
        </label>
        <button
          type="button"
          onClick={jumpToDraftPage}
          className="h-8 rounded-lg border border-white/10 px-3 text-white/75 transition hover:bg-white/[0.06]"
        >
          {t('confirm', 'asset')}
        </button>
        <label className="flex h-8 items-center gap-2 rounded-lg border border-white/10 bg-[#1a1f2e] px-2">
          <span className="text-white/45">{t('perPage', 'asset')}</span>
          <select
            value={pageSize}
            onChange={(event) => handlePageSizeChange(event.target.value)}
            className="h-full bg-transparent font-medium tabular-nums text-white outline-none"
          >
            {pageSizeOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
          <span className="text-white/45">{t('recordUnit', 'asset')}</span>
        </label>
      </div>
    </div>
  );
}
