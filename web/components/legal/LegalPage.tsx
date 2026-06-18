'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { getLegalPage, type LegalPageContent, type LegalPageKey } from '@/lib/api/modules/site';
import { useLocaleContext } from '@/contexts/LocaleContext';

type LegalPageProps = {
  pageKey: LegalPageKey;
  titleKey: string;
};

export default function LegalPage({ pageKey, titleKey }: LegalPageProps) {
  const { locale, t } = useLocaleContext();
  const [content, setContent] = useState<LegalPageContent | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const requestSeqRef = useRef(0);

  const fallbackTitle = t(titleKey, 'common');

  const loadContent = useCallback(async () => {
    const requestSeq = requestSeqRef.current + 1;
    requestSeqRef.current = requestSeq;
    setLoading(true);
    setError('');
    setContent(null);
    try {
      const data = await getLegalPage(pageKey, locale);
      if (requestSeq !== requestSeqRef.current) return;
      setContent(data);
    } catch (err) {
      if (requestSeq !== requestSeqRef.current) return;
      setError(err instanceof Error ? err.message : t('legalPageError', 'common'));
      setContent(null);
    } finally {
      if (requestSeq === requestSeqRef.current) {
        setLoading(false);
      }
    }
  }, [locale, pageKey, t]);

  useEffect(() => {
    loadContent();
  }, [loadContent]);

  const contentText = content?.content?.trim() || '';

  return (
    <main className="min-h-screen bg-[#05070a] text-white">
      <section className="border-b border-white/10 bg-[#080b10] px-4 py-14 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-4xl">
          <p className="mb-4 text-sm font-medium uppercase tracking-[0.22em] text-[#f0b90b]">
            Royal Exchange
          </p>
          <h1 className="text-4xl font-semibold leading-tight text-white sm:text-5xl">
            {content?.title || fallbackTitle}
          </h1>
        </div>
      </section>

      <section className="px-4 py-10 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-4xl">
          {loading ? (
            <div className="rounded-lg border border-white/10 bg-white/[0.03] px-5 py-8 text-sm text-white/55">
              {t('legalPageLoading', 'common')}
            </div>
          ) : null}

          {!loading && error ? (
            <div className="rounded-lg border border-red-400/25 bg-red-500/10 px-5 py-5">
              <p className="text-sm text-red-100">{t('legalPageError', 'common')}</p>
              <button
                type="button"
                onClick={loadContent}
                className="mt-4 rounded-md bg-white px-4 py-2 text-sm font-semibold text-black transition-colors hover:bg-white/90"
              >
                {t('legalPageRetry', 'common')}
              </button>
            </div>
          ) : null}

          {!loading && !error && !contentText ? (
            <div className="rounded-lg border border-white/10 bg-white/[0.03] px-5 py-8 text-sm text-white/55">
              {t('legalPageEmpty', 'common')}
            </div>
          ) : null}

          {!loading && !error && contentText ? (
            <article className="rounded-lg border border-white/10 bg-white/[0.035] px-5 py-7 sm:px-8 sm:py-9">
              <div className="whitespace-pre-line text-base leading-8 text-white/70">{contentText}</div>
            </article>
          ) : null}
        </div>
      </section>
    </main>
  );
}
