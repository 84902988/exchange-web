"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";

import EmptyState from "@/components/ui/EmptyState";
import LoadingSkeleton from "@/components/ui/LoadingSkeleton";
import { useLocaleContext } from "@/contexts/LocaleContext";
import { useAuth } from "@/lib/authContext";
import {
  getAnnouncements,
  markAllAnnouncementsRead,
  type Announcement,
} from "@/lib/api/modules/announcements";

const PAGE_SIZE = 10;

const NOTICE_TABS = [
  { key: "latest", href: "/notice?type=latest", labelKey: "noticeTabLatest" },
  { key: "platform", href: "/notice?type=platform", labelKey: "noticeCategoryPlatform" },
  { key: "activity", href: "/notice?type=activity", labelKey: "noticeCategoryActivity" },
  { key: "system", href: "/notice?type=system", labelKey: "noticeCategorySystem" },
];

const CATEGORY_STYLES: Record<string, string> = {
  platform: "bg-green-500/20 text-green-300",
  activity: "bg-amber-500/20 text-amber-300",
  system: "bg-blue-500/20 text-blue-300",
};

function formatTime(value: string | null | undefined, locale: string) {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(locale, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function summaryOf(item: Announcement) {
  return String(item.summary || "").trim();
}

function noticeCategoryLabel(category: string | null | undefined, t: ReturnType<typeof useLocaleContext>["t"]) {
  const normalized = String(category || "").trim().toLowerCase();
  const labelKeys: Record<string, string> = {
    latest: "noticeTabLatest",
    platform: "noticeCategoryPlatform",
    activity: "noticeCategoryActivity",
    system: "noticeCategorySystem",
  };
  const labelKey = labelKeys[normalized];
  return labelKey ? t(labelKey) : "--";
}

function notifyAnnouncementReadsChanged() {
  window.dispatchEvent(new CustomEvent("announcement-reads:changed"));
}

function NoticePageContent() {
  const searchParams = useSearchParams();
  const { isLoggedIn } = useAuth();
  const { locale, t } = useLocaleContext();
  const selectedType = searchParams.get("type") || "latest";
  const [items, setItems] = useState<Announcement[]>([]);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [markingAll, setMarkingAll] = useState(false);

  const totalText = useMemo(() => {
    return `${t("noticeTotalPrefix")} ${total} ${t("noticeTotalSuffix")}`;
  }, [total, t]);

  useEffect(() => {
    setPage(1);
  }, [selectedType, locale]);

  const loadAnnouncements = useCallback(async (aliveRef: { alive: boolean }) => {
    setLoading(true);
    setError("");
    try {
      const data = await getAnnouncements(page, PAGE_SIZE, selectedType, locale);
      if (!aliveRef.alive) return;
      setItems(data.items);
      setPages(data.pages);
      setTotal(data.total);
    } catch {
      if (!aliveRef.alive) return;
      setError(t("noticeLoadFailed"));
    } finally {
      if (aliveRef.alive) {
        setLoading(false);
      }
    }
  }, [page, selectedType, locale, t]);

  useEffect(() => {
    const aliveRef = { alive: true };
    loadAnnouncements(aliveRef);
    return () => {
      aliveRef.alive = false;
    };
  }, [loadAnnouncements]);

  const markAllRead = async () => {
    if (!isLoggedIn || markingAll) return;
    setMarkingAll(true);
    try {
      await markAllAnnouncementsRead();
      notifyAnnouncementReadsChanged();
    } finally {
      setMarkingAll(false);
    }
  };

  const goToPage = (nextPage: number) => {
    if (nextPage < 1 || nextPage > pages || nextPage === page) return;
    setPage(nextPage);
  };

  return (
    <main className="min-h-screen bg-[#0b0b0f] px-4 py-10 text-white sm:px-6">
      <div className="mx-auto max-w-4xl">
        <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-3xl font-bold text-white/90">{t("noticeCenterTitle")}</h1>
            <p className="mt-2 text-sm text-white/60">{t("noticeCenterDesc")}</p>
          </div>
          {isLoggedIn ? (
            <button
              type="button"
              onClick={markAllRead}
              disabled={markingAll}
              className="inline-flex h-10 items-center justify-center rounded-lg border border-white/10 bg-white/[0.06] px-4 text-sm font-semibold text-white transition-colors hover:bg-white/[0.1] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {markingAll ? t("updating") : t("markAllRead")}
            </button>
          ) : null}
        </div>

        <div className="mb-5 flex flex-wrap gap-3 border-b border-white/10 pb-4">
          {NOTICE_TABS.map((item) => {
            const isActive = item.key === selectedType;

            return (
              <Link
                key={item.href}
                href={item.href}
                className={`rounded-full px-4 py-2 text-sm transition-colors duration-200 ${
                  isActive
                    ? "bg-gradient-to-r from-amber-500 to-amber-600 text-white shadow-lg"
                    : "bg-white/5 text-white/70 hover:bg-white/10"
                }`}
              >
                {t(item.labelKey)}
              </Link>
            );
          })}
        </div>

        <div className="mb-5 flex items-center justify-between border-b border-white/10 pb-4 text-sm text-white/45">
          <span>{totalText}</span>
          <span>{t("publicAnnouncements")}</span>
        </div>

        {loading ? (
          <div className="space-y-4">
            <LoadingSkeleton className="h-28 w-full rounded-xl" />
            <LoadingSkeleton className="h-28 w-full rounded-xl" />
            <LoadingSkeleton className="h-28 w-full rounded-xl" />
          </div>
        ) : error ? (
          <div className="rounded-xl border border-red-400/20 bg-red-400/10 p-8 text-center">
            <div className="font-semibold text-red-200">{error}</div>
            <button
              type="button"
              onClick={() => {
                const aliveRef = { alive: true };
                loadAnnouncements(aliveRef);
              }}
              className="mt-4 rounded-lg bg-white/10 px-4 py-2 text-sm text-white hover:bg-white/15"
            >
              {t("reload")}
            </button>
          </div>
        ) : items.length > 0 ? (
          <div className="space-y-4">
            {items.map((notice) => {
              const category = String(notice.category || "").toLowerCase();
              return (
                <Link
                  key={notice.id}
                  href={`/notice/${notice.slug || notice.id}`}
                  className="block rounded-xl border border-white/15 bg-white/5 p-6 transition-colors duration-200 hover:border-white/30 hover:bg-white/10"
                >
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex min-w-0 items-center gap-3">
                      {notice.is_pinned ? (
                        <span className="rounded-full bg-amber-500/20 px-2 py-1 text-xs font-medium text-amber-300">
                          {t("pinned")}
                        </span>
                      ) : null}
                      <span
                        className={`rounded-full px-2 py-1 text-xs font-medium ${
                          CATEGORY_STYLES[category] || "bg-white/10 text-white/60"
                        }`}
                      >
                        {noticeCategoryLabel(notice.category, t)}
                      </span>
                      <h2 className="min-w-0 truncate text-lg font-semibold text-white/90">{notice.title}</h2>
                    </div>
                    <span className="shrink-0 text-xs text-white/50">{formatTime(notice.publish_at, locale)}</span>
                  </div>
                  <p className="mt-3 line-clamp-2 text-sm leading-relaxed text-white/70">{summaryOf(notice)}</p>
                </Link>
              );
            })}
          </div>
        ) : (
          <EmptyState title={t("noAnnouncementsTitle")} description={t("noAnnouncementsDesc")} />
        )}

        {!loading && !error && pages > 1 ? (
          <div className="mt-6 flex items-center justify-between text-sm text-white/55">
            <button
              type="button"
              onClick={() => goToPage(page - 1)}
              disabled={page <= 1}
              className="rounded-lg border border-white/10 px-4 py-2 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {t("previousPage")}
            </button>
            <span>
              {page} / {pages}
            </span>
            <button
              type="button"
              onClick={() => goToPage(page + 1)}
              disabled={page >= pages}
              className="rounded-lg border border-white/10 px-4 py-2 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {t("nextPage")}
            </button>
          </div>
        ) : null}
      </div>
    </main>
  );
}

export default function NoticePage() {
  return (
    <Suspense fallback={<main className="min-h-screen bg-[#0b0b0f] px-4 py-10 text-white sm:px-6" />}>
      <NoticePageContent />
    </Suspense>
  );
}
