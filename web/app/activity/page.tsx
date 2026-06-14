"use client";

import { useCallback, useEffect, useState } from "react";

import ActivityBanner from "@/components/activity/ActivityBanner";
import ActivityList from "@/components/activity/ActivityList";
import { useLocaleContext } from "@/contexts/LocaleContext";
import {
  getActivities,
  getActivityBanners,
  type Activity,
  type ActivityBanner as ActivityBannerItem,
} from "@/lib/api/modules/activity";

function LoadingGrid() {
  return (
    <div className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-3">
      {Array.from({ length: 6 }).map((_, index) => (
        <div key={index} className="min-h-[430px] animate-pulse rounded-lg border border-white/10 bg-white/[0.04]">
          <div className="h-44 rounded-t-lg bg-white/[0.06]" />
          <div className="space-y-4 p-5">
            <div className="h-6 w-2/3 rounded bg-white/[0.08]" />
            <div className="h-4 w-full rounded bg-white/[0.06]" />
            <div className="h-4 w-5/6 rounded bg-white/[0.06]" />
            <div className="h-11 rounded bg-white/[0.08]" />
          </div>
        </div>
      ))}
    </div>
  );
}

export default function ActivityPage() {
  const { locale, t } = useLocaleContext();
  const [activities, setActivities] = useState<Activity[]>([]);
  const [banners, setBanners] = useState<ActivityBannerItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const loadData = useCallback(async (aliveRef: { alive: boolean }) => {
    setLoading(true);
    setError("");
    try {
      const [activityData, bannerData] = await Promise.all([
        getActivities(6, locale),
        getActivityBanners(6, locale),
      ]);
      if (!aliveRef.alive) return;
      setActivities(activityData.items || []);
      setBanners(bannerData.items || []);
    } catch {
      if (!aliveRef.alive) return;
      setError(t("activityLoadFailed", "activity"));
      setActivities([]);
      setBanners([]);
    } finally {
      if (aliveRef.alive) setLoading(false);
    }
  }, [locale, t]);

  useEffect(() => {
    const aliveRef = { alive: true };
    loadData(aliveRef);
    return () => {
      aliveRef.alive = false;
    };
  }, [loadData]);

  return (
    <main className="min-h-screen bg-[#0b0b0f] text-white">
      <ActivityBanner banners={banners} />

      <section className="mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8 lg:py-16">
        <div className="mb-8 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-sm font-semibold text-amber-300">{t("featuredBenefits", "activity")}</p>
            <h2 className="mt-2 text-3xl font-bold text-white">{t("hotActivities", "activity")}</h2>
          </div>
          <p className="max-w-2xl text-sm leading-6 text-white/55">
            {t("activityPageDescription", "activity")}
          </p>
        </div>

        {loading ? <LoadingGrid /> : null}

        {!loading && error ? (
          <div className="rounded-lg border border-red-400/25 bg-red-500/10 px-6 py-12 text-center">
            <div className="font-semibold text-red-200">{error}</div>
            <button
              type="button"
              onClick={() => {
                const aliveRef = { alive: true };
                loadData(aliveRef);
              }}
              className="mt-5 h-10 rounded-md bg-white/10 px-4 text-sm font-semibold text-white hover:bg-white/15"
            >
              {t("retryLoad", "activity")}
            </button>
          </div>
        ) : null}

        {!loading && !error ? <ActivityList activities={activities} /> : null}
      </section>

      <section className="border-t border-white/10 bg-[#09090c] px-4 py-8 text-center text-sm text-white/45 sm:px-6">
        {t("activityRiskNotice", "activity")}
      </section>
    </main>
  );
}
