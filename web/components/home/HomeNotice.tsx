"use client";

import Link from "next/link";

import { useLocaleContext } from "@/contexts/LocaleContext";

export type NoticeItem = {
  id: string;
  title: string;
  url?: string;
  publishedAt: string;
  type?: string;
};

export default function HomeNotice({
  items,
  loading = false,
}: {
  items?: NoticeItem[];
  loading?: boolean;
}) {
  const { locale, t } = useLocaleContext();
  const fallbackNotices: NoticeItem[] = [
    {
      id: "fallback-1",
      title: t("fallbackNoticeTitle", "home"),
      publishedAt: new Date().toISOString(),
      type: "system",
    },
  ];
  const notices = items && items.length > 0 ? items : fallbackNotices;

  const dateLocale = locale === "ja" ? "ja-JP" : locale === "en" ? "en-US" : locale === "zh-TW" ? "zh-TW" : "zh-CN";

  return (
    <section className="px-4 pb-16 sm:px-6 sm:pb-24">
      <div className="mx-auto max-w-[1440px]">
        <div className="mt-10 rounded-2xl border border-white/15 bg-white/5 p-4 sm:mt-14 sm:p-6">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-white/90 sm:text-xl">
              {t("noticeTitle", "home")}
            </h2>
            <Link href="/notice" className="text-xs font-semibold text-gray-400 hover:text-gray-300 sm:text-sm">
              {t("noticeAll", "home")}
            </Link>
          </div>

          {loading ? (
            <div className="mt-4 space-y-2 sm:mt-5 sm:space-y-3">
              <div className="h-3 w-2/3 rounded bg-white/10 sm:h-4" />
              <div className="h-3 w-1/2 rounded bg-white/10 sm:h-4" />
              <div className="h-3 w-3/5 rounded bg-white/10 sm:h-4" />
            </div>
          ) : notices.length > 0 ? (
            <ul className="mt-4 space-y-2 sm:mt-5 sm:space-y-3">
              {notices.slice(0, 3).map((notice) => (
                <li key={notice.id} className="flex flex-col items-start justify-between gap-2 sm:flex-row sm:items-center sm:gap-6">
                  <Link
                    href={notice.url ?? `/notice/${notice.id}`}
                    className="truncate text-sm font-semibold text-gray-400 hover:text-gray-300 sm:text-base"
                  >
                    {notice.title}
                  </Link>
                  <span className="w-full shrink-0 text-right text-xs text-gray-500 sm:w-auto">
                    {new Date(notice.publishedAt).toLocaleString(dateLocale)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="mt-4 text-xs text-white/60 sm:mt-5 sm:text-sm">
              {t("noticeNoData", "home")}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
