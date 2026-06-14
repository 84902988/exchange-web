"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useLocaleContext } from "@/contexts/LocaleContext";
import { getActivity, resolveActivityMediaUrl, type Activity } from "@/lib/api/modules/activity";

function formatDateTime(value: string | null | undefined, locale: string, fallback: string) {
  if (!value) return fallback;
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

function splitRules(content?: string | null) {
  return String(content || "")
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function statusLabel(status: string | null | undefined, t: ReturnType<typeof useLocaleContext>["t"]) {
  const normalized = String(status || "").trim().toUpperCase();
  const labelKeys: Record<string, string> = {
    ACTIVE: "activityStatusActive",
    INACTIVE: "activityStatusInactive",
    ENDED: "activityStatusEnded",
    PENDING: "activityStatusPending",
  };
  const labelKey = labelKeys[normalized];
  return labelKey ? t(labelKey, "activity") : "--";
}

function DetailMedia({ activity }: { activity: Activity }) {
  const mediaUrl = resolveActivityMediaUrl(activity.banner_url || activity.video_url || activity.cover_url);
  const shouldShowVideo = activity.banner_type === "video" || Boolean(activity.video_url && !activity.banner_url);

  if (mediaUrl && shouldShowVideo) {
    return <video className="h-full w-full object-cover" src={mediaUrl} controls playsInline poster={resolveActivityMediaUrl(activity.cover_url)} />;
  }

  if (mediaUrl) {
    return <img src={mediaUrl} alt={activity.title} className="h-full w-full object-cover" />;
  }

  return (
    <div className="flex h-full w-full items-center justify-center bg-[radial-gradient(circle_at_30%_20%,rgba(245,158,11,0.32),transparent_36%),linear-gradient(135deg,#181510,#0d0d12)]">
      <span className="text-6xl font-black text-amber-300/70">{activity.title.slice(0, 1)}</span>
    </div>
  );
}

export default function ActivityDetailPage() {
  const params = useParams<{ id: string }>();
  const { locale, t } = useLocaleContext();
  const [activity, setActivity] = useState<Activity | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const loadActivity = useCallback(async (aliveRef: { alive: boolean }) => {
    setLoading(true);
    setError("");
    try {
      const data = await getActivity(params.id, locale);
      if (!aliveRef.alive) return;
      setActivity(data.item);
    } catch {
      if (!aliveRef.alive) return;
      setActivity(null);
      setError(t("activityDetailLoadFailed", "activity"));
    } finally {
      if (aliveRef.alive) setLoading(false);
    }
  }, [locale, params.id, t]);

  useEffect(() => {
    const aliveRef = { alive: true };
    loadActivity(aliveRef);
    return () => {
      aliveRef.alive = false;
    };
  }, [loadActivity]);

  const rules = useMemo(() => splitRules(activity?.detail_content), [activity?.detail_content]);

  if (loading) {
    return (
      <main className="min-h-screen bg-[#0b0b0f] px-4 py-10 text-white sm:px-6">
        <div className="mx-auto max-w-6xl animate-pulse">
          <div className="h-[360px] rounded-lg bg-white/[0.05]" />
          <div className="mt-8 h-10 w-2/3 rounded bg-white/[0.07]" />
          <div className="mt-4 h-5 w-1/2 rounded bg-white/[0.05]" />
        </div>
      </main>
    );
  }

  if (error || !activity) {
    return (
      <main className="min-h-screen bg-[#0b0b0f] px-4 py-16 text-white sm:px-6">
        <div className="mx-auto max-w-3xl rounded-lg border border-red-400/25 bg-red-500/10 p-8 text-center">
          <div className="text-lg font-semibold text-red-200">{error || t("activityNotFound", "activity")}</div>
          <Link href="/activity" className="mt-6 inline-flex h-11 items-center rounded-md bg-amber-400 px-5 text-sm font-bold text-black">
            {t("backToActivityCenter", "activity")}
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-[#0b0b0f] text-white">
      <section className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        <Link href="/activity" className="mb-6 inline-flex text-sm font-semibold text-amber-300 hover:text-amber-200">
          {t("backToActivityCenter", "activity")}
        </Link>

        <div className="overflow-hidden rounded-lg border border-white/10 bg-[#121217]">
          <div className="h-[280px] bg-[#17171d] sm:h-[420px]">
            <DetailMedia activity={activity} />
          </div>
          <div className="p-6 sm:p-8 lg:p-10">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div className="max-w-3xl">
                <span className="inline-flex rounded-full border border-emerald-400/30 bg-emerald-400/10 px-3 py-1 text-xs font-semibold text-emerald-300">
                  {statusLabel(activity.status, t)}
                </span>
                <h1 className="mt-4 text-3xl font-bold leading-tight text-white sm:text-5xl">{activity.title}</h1>
                {activity.description ? <p className="mt-4 text-base leading-7 text-white/65">{activity.description}</p> : null}
              </div>
              <div className="rounded-lg border border-amber-400/25 bg-amber-400/10 p-5 lg:min-w-[280px]">
                <div className="text-sm text-amber-100/70">{t("rewardDescription", "activity")}</div>
                <div className="mt-2 text-2xl font-bold text-amber-300">{activity.reward_text || t("seeActivityRules", "activity")}</div>
              </div>
            </div>

            <div className="mt-8 grid gap-4 border-y border-white/10 py-6 md:grid-cols-2">
              <div>
                <div className="text-sm text-white/45">{t("startTime", "activity")}</div>
                <div className="mt-2 font-semibold text-white/85">{formatDateTime(activity.start_at, locale, t("longTermValid", "activity"))}</div>
              </div>
              <div>
                <div className="text-sm text-white/45">{t("endTime", "activity")}</div>
                <div className="mt-2 font-semibold text-white/85">{formatDateTime(activity.end_at, locale, t("longTermValid", "activity"))}</div>
              </div>
            </div>

            <div className="mt-8 grid gap-8 lg:grid-cols-[1fr_320px]">
              <section>
                <h2 className="text-2xl font-bold text-white">{t("activityRules", "activity")}</h2>
                {rules.length > 0 ? (
                  <div className="mt-4 space-y-3 text-sm leading-7 text-white/68">
                    {rules.map((rule, index) => (
                      <p key={`${rule}-${index}`}>{rule}</p>
                    ))}
                  </div>
                ) : (
                  <p className="mt-4 text-sm text-white/55">{t("activityRulesPending", "activity")}</p>
                )}
              </section>

              <aside className="rounded-lg border border-white/10 bg-black/20 p-5">
                <h2 className="text-lg font-bold text-white">{t("participationRequirements", "activity")}</h2>
                <p className="mt-3 text-sm leading-6 text-white/60">
                  {t("participationRequirementsDesc", "activity")}
                </p>
                {activity.cta_url ? (
                  <Link
                    href={activity.cta_url}
                    className="mt-6 inline-flex h-11 w-full items-center justify-center rounded-md bg-gradient-to-r from-amber-400 to-yellow-500 px-4 text-sm font-bold text-black"
                  >
                    {activity.cta_text || t("joinNow", "activity")}
                  </Link>
                ) : (
                  <button
                    type="button"
                    disabled
                    className="mt-6 inline-flex h-11 w-full cursor-not-allowed items-center justify-center rounded-md bg-white/10 px-4 text-sm font-semibold text-white/45"
                  >
                    {activity.cta_text || t("joinNow", "activity")}
                  </button>
                )}
              </aside>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
