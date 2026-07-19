"use client";

import { useEffect, useMemo, useState } from "react";

import { useLocaleContext } from "@/contexts/LocaleContext";
import { getHelpContent, type HelpContentCategoryDTO, type HelpContentSectionDTO } from "@/lib/api/modules/help";
import {
  flattenHelpArticles,
  helpCategories,
  helpText,
  type HelpArticle,
  type HelpCategory,
} from "@/lib/help/helpContent";
import { resolveHelpSourceCategories } from "@/lib/help/helpSourcePolicy";

type ArticleWithCategory = ReturnType<typeof flattenHelpArticles>[number];

function localized(value: string | undefined, locale: Parameters<typeof helpText>[1]) {
  const text = value || "";
  return {
    zh: text,
    [locale]: text,
  };
}

function mapHelpSection(section: HelpContentSectionDTO, locale: Parameters<typeof helpText>[1]) {
  return {
    heading: localized(section.heading || "", locale),
    body: section.body?.map((item) => localized(item, locale)),
    steps: section.steps?.map((item) => localized(item, locale)),
    bullets: section.bullets?.map((item) => localized(item, locale)),
  };
}

function mapCmsHelpCategories(categories: HelpContentCategoryDTO[] | undefined, locale: Parameters<typeof helpText>[1]): HelpCategory[] {
  return (categories || [])
    .map((category): HelpCategory => ({
      id: category.category_key || category.id,
      title: localized(category.title, locale),
      description: localized(category.description, locale),
      articles: (category.articles || []).map((article): HelpArticle => ({
        id: article.id,
        slug: article.slug,
        title: localized(article.title, locale),
        summary: localized(article.summary, locale),
        tags: article.tags || [],
        hot: article.hot ?? article.is_hot ?? false,
        sections: article.sections?.length
          ? article.sections.map((section) => mapHelpSection(section, locale))
          : [
              {
                heading: localized(locale === "en" ? "Content" : "正文内容", locale),
                body: article.content
                  ?.split(/\r?\n/)
                  .map((line) => line.trim())
                  .filter(Boolean)
                  .map((line) => localized(line, locale)),
              },
            ],
      })),
    }))
    .filter((category) => category.articles.length > 0);
}

function articleDirectoryText(article: ArticleWithCategory, locale: Parameters<typeof helpText>[1]): string {
  return [
    helpText(article.title, locale),
    helpText(article.summary, locale),
    helpText(article.categoryTitle, locale),
    article.tags.join(" "),
  ].join(" ").toLowerCase();
}

function HelpSectionList({ article }: { article: HelpArticle }) {
  const { locale } = useLocaleContext();

  return (
    <div className="space-y-7">
      {article.sections.map((section) => (
        <section key={helpText(section.heading, locale)} className="border-t border-white/10 pt-6 first:border-t-0 first:pt-0">
          <h3 className="mb-3 text-lg font-semibold text-white">{helpText(section.heading, locale)}</h3>

          {section.body?.map((item) => (
            <p key={helpText(item, locale)} className="mb-3 text-sm leading-7 text-white/72">
              {helpText(item, locale)}
            </p>
          ))}

          {section.steps && (
            <ol className="space-y-3 pl-5 text-sm leading-7 text-white/72">
              {section.steps.map((step) => (
                <li key={helpText(step, locale)} className="list-decimal pl-1">
                  {helpText(step, locale)}
                </li>
              ))}
            </ol>
          )}

          {section.bullets && (
            <ul className="space-y-3 pl-5 text-sm leading-7 text-white/72">
              {section.bullets.map((bullet) => (
                <li key={helpText(bullet, locale)} className="list-disc pl-1">
                  {helpText(bullet, locale)}
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
}

export default function HelpPage() {
  const { locale, t } = useLocaleContext();
  const [cmsCategories, setCmsCategories] = useState<HelpCategory[] | null>(null);
  const sourceCategories = resolveHelpSourceCategories(cmsCategories);
  const allArticles = useMemo(() => flattenHelpArticles(sourceCategories), [sourceCategories]);
  const [selectedArticleId, setSelectedArticleId] = useState<string>(helpCategories[0].articles[0].id);
  const [query, setQuery] = useState("");

  useEffect(() => {
    let cancelled = false;

    getHelpContent(locale)
      .then((data) => {
        if (cancelled) return;
        const categories = mapCmsHelpCategories(data.categories, locale);
        setCmsCategories(categories);
      })
      .catch(() => {
        if (!cancelled) {
          setCmsCategories(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [locale]);

  const normalizedQuery = query.trim().toLowerCase();
  const visibleArticleIds = useMemo(() => {
    if (!normalizedQuery) {
      return new Set(allArticles.map((article) => article.id));
    }
    return new Set(
      allArticles
        .filter((article) => articleDirectoryText(article, locale).includes(normalizedQuery))
        .map((article) => article.id),
    );
  }, [allArticles, locale, normalizedQuery]);

  const visibleCategories = useMemo(() => {
    return sourceCategories
      .map((category): HelpCategory => ({
        ...category,
        articles: category.articles.filter((article) => visibleArticleIds.has(article.id)),
      }))
      .filter((category) => category.articles.length > 0);
  }, [sourceCategories, visibleArticleIds]);

  const selectedArticle = useMemo(() => {
    return allArticles.find((article) => article.id === selectedArticleId) || allArticles[0];
  }, [allArticles, selectedArticleId]);

  const hotArticles = useMemo(() => allArticles.filter((article) => article.hot).slice(0, 4), [allArticles]);

  const selectArticle = (articleId: string) => {
    setSelectedArticleId(articleId);
  };

  return (
    <main className="min-h-screen bg-[#0b0b0f] text-white">
      <div className="border-b border-white/10 bg-[#101015]">
        <div className="mx-auto flex max-w-7xl flex-col gap-5 px-4 py-8 sm:px-6 lg:px-8">
          <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
            <div>
              <h1 className="text-2xl font-semibold tracking-normal text-white md:text-3xl">
                {t("helpCenterTitle", "common")}
              </h1>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-white/62">
                {t("helpCenterSubtitle", "common")}
              </p>
            </div>
            <a
              href="/user/support-tickets"
              className="inline-flex h-10 items-center justify-center rounded-md border border-amber-400/40 px-4 text-sm font-medium text-amber-300 transition-colors hover:border-amber-300 hover:bg-amber-400/10"
            >
              {t("helpContactSupport", "common")}
            </a>
          </div>

          <label className="relative block max-w-4xl">
            <span className="sr-only">{t("helpSearchPlaceholder", "common")}</span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("helpSearchPlaceholder", "common")}
              className="h-12 w-full rounded-md border border-white/12 bg-black/30 px-4 text-sm text-white outline-none transition-colors placeholder:text-white/35 focus:border-amber-300/70"
            />
          </label>

          <section className="rounded-md border border-white/10 bg-black/20 p-4">
            <h2 className="mb-3 text-sm font-semibold text-white/82">{t("helpPopularArticles", "common")}</h2>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {hotArticles.map((article) => (
                <button
                  key={article.id}
                  type="button"
                  onClick={() => selectArticle(article.id)}
                  className="rounded-md border border-white/10 bg-white/[0.03] px-3 py-3 text-left text-sm font-medium leading-6 text-white/72 transition-colors hover:border-amber-400/40 hover:text-amber-300"
                >
                  {helpText(article.title, locale)}
                </button>
              ))}
            </div>
          </section>
        </div>
      </div>

      <div className="mx-auto grid max-w-7xl grid-cols-1 gap-6 px-4 py-6 sm:px-6 lg:grid-cols-[290px_minmax(0,1fr)] lg:px-8">
        <aside className="rounded-md border border-white/10 bg-[#101015] lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:self-start lg:overflow-y-auto">
          <div className="border-b border-white/10 px-4 py-3 text-sm font-semibold text-white/82">
            {t("helpAllArticles", "common")}
          </div>

          <nav className="space-y-5 p-4">
            {visibleCategories.length === 0 && (
              <div className="py-6 text-sm leading-6 text-white/50">{t("helpNoResults", "common")}</div>
            )}

            {visibleCategories.map((category) => (
              <section key={category.id}>
                <h2 className="mb-2 text-sm font-semibold text-white">{helpText(category.title, locale)}</h2>
                <div className="space-y-1">
                  {category.articles.map((article) => (
                    <button
                      key={article.id}
                      type="button"
                      onClick={() => selectArticle(article.id)}
                      className={`w-full rounded-md px-3 py-2 text-left text-sm leading-5 transition-colors ${
                        selectedArticle.id === article.id
                          ? "bg-amber-400/10 text-amber-300"
                          : "text-white/58 hover:bg-white/[0.04] hover:text-white"
                      }`}
                    >
                      {helpText(article.title, locale)}
                    </button>
                  ))}
                </div>
              </section>
            ))}
          </nav>
        </aside>

        <article className="min-w-0 rounded-md border border-white/10 bg-[#101015] px-5 py-6 md:px-8 lg:px-10">
          <div className="mb-7 border-b border-white/10 pb-6">
            <div className="mb-3 text-xs font-medium text-amber-300">
              {helpText(selectedArticle.categoryTitle, locale)}
            </div>
            <h2 className="text-2xl font-semibold leading-snug text-white md:text-3xl">
              {helpText(selectedArticle.title, locale)}
            </h2>
            <p className="mt-3 max-w-4xl text-sm leading-7 text-white/62">
              {helpText(selectedArticle.summary, locale)}
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              {selectedArticle.tags.map((tag) => (
                <span key={tag} className="rounded border border-white/10 bg-white/[0.04] px-2 py-1 text-xs text-white/52">
                  {tag}
                </span>
              ))}
            </div>
          </div>

          <div className="max-w-4xl">
            <HelpSectionList article={selectedArticle} />
          </div>
        </article>
      </div>
    </main>
  );
}
