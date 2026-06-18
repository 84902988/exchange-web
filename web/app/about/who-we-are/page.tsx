'use client';

import { useCallback, useEffect, useState } from 'react';

import { getAboutPage, type AboutPageContent } from '@/lib/api/modules/site';
import { useLocaleContext } from '@/contexts/LocaleContext';

const REQUIRED_SECTION_IDS = ['who', 'story', 'vision', 'mission', 'values'];

export default function WhoWeArePage() {
  const { locale, t } = useLocaleContext();
  const [content, setContent] = useState<AboutPageContent | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const loadContent = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await getAboutPage(locale);
      setContent(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('aboutPageError', 'common'));
      setContent(null);
    } finally {
      setLoading(false);
    }
  }, [locale, t]);

  useEffect(() => {
    loadContent();
  }, [loadContent]);

  useEffect(() => {
    if (loading || !content?.sections?.length || typeof window === 'undefined') return;
    const hash = window.location.hash.replace('#', '');
    if (!hash) return;

    window.requestAnimationFrame(() => {
      document.getElementById(hash)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
  }, [content, loading]);

  const sections = content?.sections || [];
  const visibleSectionIds = new Set(sections.map((section) => section.id));

  return (
    <main className="min-h-screen bg-[#05070a] text-white">
      <section className="border-b border-white/10 bg-[#080b10] px-4 py-16 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-5xl">
          <div className="max-w-3xl">
            <p className="mb-4 text-sm font-medium uppercase tracking-[0.22em] text-[#f0b90b]">
              Royal Exchange
            </p>
            <h1 className="text-4xl font-semibold leading-tight text-white sm:text-5xl">
              {content?.title || t('aboutPageTitle', 'common')}
            </h1>
            {content?.subtitle ? (
              <p className="mt-5 text-lg leading-8 text-white/62">{content.subtitle}</p>
            ) : null}
          </div>
        </div>
      </section>

      <section className="px-4 py-12 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-5xl">
          {loading ? (
            <div className="rounded-lg border border-white/10 bg-white/[0.03] px-5 py-8 text-sm text-white/55">
              {t('aboutPageLoading', 'common')}
            </div>
          ) : null}

          {!loading && error ? (
            <div className="rounded-lg border border-red-400/25 bg-red-500/10 px-5 py-5">
              <p className="text-sm text-red-100">{t('aboutPageError', 'common')}</p>
              <button
                type="button"
                onClick={loadContent}
                className="mt-4 rounded-md bg-white px-4 py-2 text-sm font-semibold text-black transition-colors hover:bg-white/90"
              >
                {t('aboutPageRetry', 'common')}
              </button>
            </div>
          ) : null}

          {!loading && !error && sections.length === 0 ? (
            <div className="rounded-lg border border-white/10 bg-white/[0.03] px-5 py-8 text-sm text-white/55">
              {t('aboutPageEmpty', 'common')}
            </div>
          ) : null}

          {!loading && !error && sections.length > 0 ? (
            <div className="space-y-10">
              {sections.map((section) => (
                <section
                  key={section.id}
                  id={section.id}
                  className="scroll-mt-20 rounded-lg border border-white/10 bg-white/[0.035] px-5 py-6 sm:px-7 sm:py-8"
                >
                  {section.eyebrow ? (
                    <p className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-[#f0b90b]/85">
                      {section.eyebrow}
                    </p>
                  ) : null}
                  <h2 className="text-2xl font-semibold leading-8 text-white">{section.title}</h2>
                  {section.body?.length ? (
                    <div className="mt-5 space-y-4 text-base leading-8 text-white/68">
                      {section.body.map((paragraph, index) => (
                        <p key={`${section.id}-body-${index}`}>{paragraph}</p>
                      ))}
                    </div>
                  ) : null}
                  {section.items?.length ? (
                    <div className="mt-6 grid gap-3 sm:grid-cols-2">
                      {section.items.map((item) => (
                        <article key={item.title} className="rounded-md border border-white/10 bg-black/20 p-4">
                          <h3 className="text-base font-semibold leading-6 text-white">{item.title}</h3>
                          <div className="mt-2 space-y-2 text-sm leading-7 text-white/62">
                            {item.body.map((paragraph, index) => (
                              <p key={`${item.title}-${index}`}>{paragraph}</p>
                            ))}
                          </div>
                        </article>
                      ))}
                    </div>
                  ) : null}
                </section>
              ))}

              {REQUIRED_SECTION_IDS.filter((id) => !visibleSectionIds.has(id)).length ? (
                <p className="text-xs text-white/35">{t('aboutPagePartialContent', 'common')}</p>
              ) : null}
            </div>
          ) : null}
        </div>
      </section>
    </main>
  );
}
