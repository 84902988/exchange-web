"use client";

import Link from "next/link";

import { useLocaleContext } from "@/contexts/LocaleContext";
import { resolveActivityMediaUrl, type Activity } from "@/lib/api/modules/activity";

function formatDate(value: string | null | undefined, locale: string, fallback: string) {
  if (!value) return fallback;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(locale, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

function statusClass(status?: string) {
  const normalized = String(status || "").trim().toUpperCase();
  if (normalized === "ACTIVE") return "border-emerald-400/30 bg-emerald-400/10 text-emerald-300";
  if (normalized === "ENDED") return "border-amber-400/30 bg-amber-400/10 text-amber-200";
  return "border-white/15 bg-white/10 text-white/60";
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

export default function ActivityCard({ activity }: { activity: Activity }) {
  const { locale, t } = useLocaleContext();
  const coverUrl = resolveActivityMediaUrl(activity.cover_url);

  return (
    <Link
      href={`/activity/${activity.id}`}
      className="group flex min-h-[430px] flex-col overflow-hidden rounded-lg border border-white/10 bg-[#121217] transition-colors hover:border-amber-400/70"
    >
      <div className="relative h-44 overflow-hidden bg-[#17171d]">
        {coverUrl ? (
          <img
            src={coverUrl}
            alt={activity.title}
            className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-[radial-gradient(circle_at_30%_20%,rgba(245,158,11,0.28),transparent_36%),linear-gradient(135deg,#181510,#0d0d12)]">
            <span className="text-4xl font-black text-amber-300/70">{activity.title.slice(0, 1)}</span>
          </div>
        )}
        <div className="absolute left-4 top-4 rounded-full border border-amber-400/25 bg-black/50 px-3 py-1 text-xs font-semibold text-amber-200 backdrop-blur">
          {activity.reward_text || t("activityReward", "activity")}
        </div>
      </div>

      <div className="flex flex-1 flex-col p-5">
        <div className="flex items-start justify-between gap-3">
          <h3 className="text-xl font-bold leading-7 text-white">{activity.title}</h3>
          <span className={`shrink-0 rounded-full border px-2.5 py-1 text-xs font-semibold ${statusClass(activity.status)}`}>
            {statusLabel(activity.status, t)}
          </span>
        </div>
        <p className="mt-3 line-clamp-3 min-h-[72px] text-sm leading-6 text-white/62">{activity.description || t("activityDescriptionPending", "activity")}</p>

        <div className="mt-5 grid gap-3 border-t border-white/10 pt-4 text-sm">
          <div className="flex items-center justify-between gap-4">
            <span className="text-white/45">{t("activityReward", "activity")}</span>
            <span className="text-right font-semibold text-amber-300">{activity.reward_text || t("seeActivityRules", "activity")}</span>
          </div>
          <div className="flex items-center justify-between gap-4">
            <span className="text-white/45">{t("endTime", "activity")}</span>
            <span className="text-right text-white/78">{formatDate(activity.end_at, locale, t("longTermValid", "activity"))}</span>
          </div>
        </div>

        <div className="mt-auto pt-5">
          <span className="inline-flex h-11 w-full items-center justify-center rounded-md bg-gradient-to-r from-amber-400 to-yellow-500 px-4 text-sm font-bold text-black transition-opacity group-hover:opacity-90">
            {activity.cta_text || t("joinNow", "activity")}
          </span>
        </div>
      </div>
    </Link>
  );
}
