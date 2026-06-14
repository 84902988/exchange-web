'use client';

import Link from 'next/link';

import { useLocaleContext } from '@/contexts/LocaleContext';

export default function RegionRestrictedPage() {
  const { t } = useLocaleContext();

  return (
    <main className="min-h-[calc(100vh-7rem)] bg-[#0b0b0f] px-4 py-16 text-white sm:px-6">
      <section className="mx-auto flex max-w-3xl flex-col items-center text-center">
        <div className="mb-6 flex h-14 w-14 items-center justify-center rounded-lg border border-amber-400/25 bg-amber-400/10 text-2xl font-semibold text-amber-300">
          !
        </div>

        <div className="text-sm font-medium uppercase tracking-[0.18em] text-amber-300">
          {t('regionRestrictedEnglishTitle', 'common')}
        </div>
        <h1 className="mt-5 text-3xl font-bold text-white sm:text-4xl">
          {t('regionRestrictedTitle', 'common')}
        </h1>
        <p className="mt-4 max-w-2xl text-base leading-7 text-white/65">
          {t('regionRestrictedSubtitle', 'common')}
        </p>

        <div className="mt-8 h-px w-full max-w-md bg-white/10" />

        <p className="mt-8 max-w-2xl text-sm leading-7 text-white/55">
          {t('regionRestrictedEnglishDesc', 'common')}
        </p>

        <Link
          href="/"
          className="mt-10 inline-flex h-11 items-center justify-center rounded-md bg-amber-400 px-6 text-sm font-semibold text-black transition-colors hover:bg-amber-300"
        >
          {t('returnHome', 'common')}
        </Link>
      </section>
    </main>
  );
}
