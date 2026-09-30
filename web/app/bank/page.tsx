'use client';

import Link from 'next/link';
import { useLocaleContext } from '@/contexts/LocaleContext';

export default function BankPage() {
  const { t } = useLocaleContext();

  return (
    <main className="flex min-h-[70vh] items-center justify-center bg-black px-6 py-20">
      <section className="w-full max-w-lg rounded-2xl border border-amber-400/20 bg-[#111216] px-6 py-14 text-center">
        <svg aria-hidden="true" viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="2" className="mx-auto mb-6 h-16 w-16 text-amber-400">
          <path d="M6 18 24 7l18 11H6Zm4 5v14m9-14v14m10-14v14m9-14v14M6 41h36" />
        </svg>
        <p className="mb-3 text-sm font-medium text-amber-400">{t('navBankPortal', 'common')}</p>
        <h1 className="text-2xl font-semibold text-white">{t('bankComingSoon', 'common')}</h1>
        <p className="mt-4 text-sm text-white/60">{t('bankStayTuned', 'common')}</p>
        <Link href="/" className="mt-8 inline-flex min-h-11 items-center rounded-lg border border-white/20 px-6 text-sm text-white hover:bg-white/10">
          {t('bankBackHome', 'common')}
        </Link>
      </section>
    </main>
  );
}
