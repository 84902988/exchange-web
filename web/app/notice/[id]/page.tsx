"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { useLocaleContext } from "@/contexts/LocaleContext";
import { useAuth } from "@/lib/authContext";
import {
  getAnnouncement,
  markAnnouncementRead,
  type Announcement,
} from "@/lib/api/modules/announcements";

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

function notifyAnnouncementReadsChanged() {
  window.dispatchEvent(new CustomEvent("announcement-reads:changed"));
}

const CATEGORY_STYLES: Record<string, string> = {
  platform: "bg-green-500/20 text-green-300",
  activity: "bg-amber-500/20 text-amber-300",
  system: "bg-blue-500/20 text-blue-300",
};

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

export default function NoticeDetailPage() {
  const params = useParams<{ id: string }>();
  const { isLoggedIn } = useAuth();
  const { locale, t } = useLocaleContext();
  const identifier = useMemo(() => String(params.id || ""), [params.id]);
  const [notice, setNotice] = useState<Announcement | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;

    async function loadNotice() {
      setLoading(true);
      setError("");
      try {
        const data = await getAnnouncement(identifier, locale);
        if (!alive) return;
        setNotice(data.item);
      } catch {
        if (!alive) return;
        setNotice(null);
        setError(t("noticeDetailLoadFailed"));
      } finally {
        if (alive) {
          setLoading(false);
        }
      }
    }

    if (identifier) {
      loadNotice();
    }
    return () => {
      alive = false;
    };
  }, [identifier, locale, t]);

  useEffect(() => {
    if (!isLoggedIn || !notice?.id) return;

    let alive = true;
    markAnnouncementRead(notice.id)
      .then(() => {
        if (alive) notifyAnnouncementReadsChanged();
      })
      .catch(() => undefined);

    return () => {
      alive = false;
    };
  }, [isLoggedIn, notice?.id]);

  if (loading) {
    return (
      <main className="min-h-screen bg-[#0b0b0f] px-4 py-10 text-white sm:px-6">
        <div className="mx-auto max-w-4xl rounded-xl border border-white/10 bg-white/[0.03] p-8 text-white/60">
          {t("noticeLoading")}
        </div>
      </main>
    );
  }

  if (error || !notice) {
    return (
      <main className="min-h-screen bg-[#0b0b0f] px-4 py-10 text-white sm:px-6">
        <div className="mx-auto max-w-4xl rounded-xl border border-white/10 bg-white/[0.03] p-8">
          <h1 className="text-2xl font-bold text-white">{t("noticeNotFoundTitle")}</h1>
          <p className="mt-3 text-white/60">{error || t("noticeNotFoundDesc")}</p>
          <Link href="/notice" className="mt-6 inline-flex rounded-lg border border-white/10 px-4 py-2 text-sm text-white/70 hover:bg-white/10">
            {t("backToNoticeCenter")}
          </Link>
        </div>
      </main>
    );
  }

  const category = String(notice.category || "").toLowerCase();

  return (
    <main className="min-h-screen bg-[#0b0b0f] px-4 py-10 text-white sm:px-6">
      <article className="mx-auto max-w-4xl rounded-xl border border-white/10 bg-white/[0.03] p-6 sm:p-8">
        <div className="border-b border-white/10 pb-5">
          <div className="mb-3 flex flex-wrap items-center gap-2">
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
            <span className="text-xs text-white/45">{formatTime(notice.publish_at, locale)}</span>
          </div>
          <h1 className="text-2xl font-bold leading-tight text-white sm:text-3xl">{notice.title}</h1>
          {notice.summary ? <p className="mt-3 text-sm leading-relaxed text-white/55">{notice.summary}</p> : null}
        </div>

        <div
          className="notice-rich-content mt-6 max-w-none overflow-x-auto text-white/75 [&_a]:text-amber-300 [&_a]:underline [&_a]:underline-offset-4 [&_blockquote]:my-4 [&_blockquote]:border-l-4 [&_blockquote]:border-amber-400/70 [&_blockquote]:bg-white/[0.04] [&_blockquote]:px-4 [&_blockquote]:py-2 [&_blockquote]:text-white/70 [&_code]:rounded [&_code]:bg-white/10 [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:text-amber-100 [&_h1]:mb-4 [&_h1]:mt-8 [&_h1]:text-3xl [&_h1]:font-bold [&_h2]:mb-3 [&_h2]:mt-7 [&_h2]:text-2xl [&_h2]:font-bold [&_h3]:mb-3 [&_h3]:mt-6 [&_h3]:text-xl [&_h3]:font-semibold [&_h4]:mb-2 [&_h4]:mt-5 [&_h4]:text-lg [&_h4]:font-semibold [&_h5]:mb-2 [&_h5]:mt-4 [&_h5]:font-semibold [&_h6]:mb-2 [&_h6]:mt-4 [&_h6]:text-sm [&_h6]:font-semibold [&_hr]:my-8 [&_hr]:border-white/10 [&_img]:h-auto [&_img]:max-w-full [&_img]:rounded-xl [&_li]:my-1 [&_ol]:list-decimal [&_ol]:pl-6 [&_p]:my-4 [&_p]:leading-7 [&_pre]:my-4 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-black/40 [&_pre]:p-4 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_table]:min-w-[640px] [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:border-white/10 [&_td]:px-3 [&_td]:py-2 [&_th]:border [&_th]:border-white/10 [&_th]:bg-white/[0.06] [&_th]:px-3 [&_th]:py-2 [&_ul]:list-disc [&_ul]:pl-6"
          dangerouslySetInnerHTML={{ __html: notice.content || notice.summary || "" }}
        />

        <div className="mt-8">
          <Link href="/notice" className="inline-flex rounded-lg border border-white/10 px-4 py-2 text-sm text-white/70 hover:bg-white/10">
            {t("backToNoticeCenter")}
          </Link>
        </div>
      </article>
    </main>
  );
}
